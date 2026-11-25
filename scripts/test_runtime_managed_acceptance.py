"""Repeat the real-dependency managed-runtime acceptance scenario in an isolated fixture."""

import argparse
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import time

from test_runtime_managed_integration import (
    CLIENT,
    ENVIRONMENT,
    NODE,
    PYTHON,
    SCRIPTS,
    SERVICE,
    as_user,
    install_test_programs,
    wait_for,
)


PREPARE = SCRIPTS / "test-support/runtime-managed-acceptance-prepare.mjs"
CLIENT_PROGRAM = SCRIPTS / "test-support/runtime-managed-acceptance-client.py"
NOTION_FIXTURE = SCRIPTS / "test-support/runtime-managed-notion-fixture.py"
HOST_FIXTURE = SCRIPTS / "test-support/runtime-managed-host-fixture.py"
CREDENTIAL = 61002
ATOMIC_PROBE_DIRECTORY = ".jhw-atomic-probe.v1"
NOTION_ROUTES = (
    ("4430fcd4-bfba-4a46-9a1b-4520db86e883", "d45ed33c-26ee-45be-ad9c-513db7c422e0"),
    ("4e5ba7f0-b9cc-4171-84a7-f4e430abaf57", "634f7b00-b7a2-447b-9514-a109b57557a8"),
    ("6c9fbc24-c5fb-4ca9-aa61-781cacc7ecfd", "c1d8d3c3-538e-40a9-a306-2b694a4d8ff9"),
    ("ec68d6c6-6e8e-47e6-9e8c-85d13b9f1461", "6a4615db-ba17-44a8-b3c7-6688dce9c2fa"),
    ("979a9412-73d9-4fa4-be0e-cbcafc0a2505", "2917f7ce-c7a7-4301-a2fc-48137876c9a7"),
)
RECREATE_OBSOLETE = """
import fs from 'node:fs';
import path from 'node:path';
import {acquireLease} from './scripts/runtime-safety.mjs';
import {ensureBootstrapGeneration} from './scripts/runtime-store.mjs';
const [repositoryRoot, releaseId] = process.argv.slice(1);
const runtime = path.join(repositoryRoot, '.jhw-runtime');
const lease = acquireLease(path.join(runtime, 'deploy.lock'));
try {
  const {bootstrapId} = ensureBootstrapGeneration({repositoryRoot, releaseId, deployLease: lease});
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  fs.utimesSync(path.join(runtime, 'v2', 'bootstraps', bootstrapId), old, old);
} finally {
  lease.close();
}
"""
PAIR_FOR_MCP = """
import json
import sys
from pathlib import Path
for file in Path(sys.argv[1]).glob('*.json'):
    try:
        row = json.loads(file.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        continue
    if row['peerPid'] == int(sys.argv[2]):
        print(row['releaseId'])
        break
"""


def positive_integer(value):
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def parse_arguments():
    parser = argparse.ArgumentParser(
        description=(
            "Run the #261 real-dependency managed acceptance scenario in the existing "
            "disposable three-UID fixture environment."
        ),
    )
    parser.add_argument("--trials", type=positive_integer, default=1)
    return parser.parse_args()


def require_isolated_root():
    if sys.version_info < (3, 10):
        raise SystemExit("Python 3.10 or newer is required")
    if os.environ.get("JHW_MANAGED_TEST_ISOLATED") != "1":
        raise SystemExit("requires JHW_MANAGED_TEST_ISOLATED=1")
    if os.name != "posix" or os.getuid() != 0:
        raise SystemExit("requires root in a disposable Linux environment")


def checked(command, uid, environment, timeout=30, *, phase=None, **options):
    started = time.monotonic()
    if phase is not None:
        print(f"{phase} started", file=sys.stderr, flush=True)
    result = subprocess.run(
        command,
        **as_user(uid),
        env=environment,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
        **options,
    )
    if result.returncode != 0:
        raise RuntimeError((result.returncode, result.stdout[-1500:], result.stderr[-3000:]))
    if phase is not None:
        print(f"{phase} finished in {time.monotonic() - started:.2f}s", file=sys.stderr, flush=True)
    return result.stdout


def configure_guard(directory):
    home = directory / "guard-user"
    checked(
        [*PYTHON, "-c", "from pathlib import Path; Path(__import__('sys').argv[1]).mkdir(mode=0o700)", str(home)],
        CLIENT,
        ENVIRONMENT,
        timeout=5,
    )
    registry = home / "registry"
    remote = home / "remote.git"
    environment = {
        **ENVIRONMENT,
        "HOME": str(home),
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_NOSYSTEM": "1",
    }

    def git(*arguments):
        checked(["/usr/bin/git", *arguments], CLIENT, environment, timeout=5)

    git("init", "-q", "--initial-branch=main", str(registry))
    git("init", "-q", "--bare", "--initial-branch=main", str(remote))
    checked(
        [
            *PYTHON, "-c",
            "from pathlib import Path; import sys; "
            "root=Path(sys.argv[1]); (root/'governance').mkdir(); "
            "(root/'governance/authority.yaml').write_text(sys.argv[2])",
            str(registry),
            json.dumps({
                "authority_epoch": 1,
                "mode": "legacy",
                "cutover_at": None,
                "minimum_tool_version": "1.0.0",
            }),
        ],
        CLIENT,
        environment,
        timeout=5,
    )
    git("-C", str(registry), "add", "governance/authority.yaml")
    git(
        "-C", str(registry), "-c", "user.name=Fixture",
        "-c", "user.email=fixture@example.invalid", "commit", "-q",
        "--allow-empty", "-m", "fixture",
    )
    git("-C", str(registry), "remote", "add", "origin", str(remote))
    git("-C", str(registry), "push", "-qu", "origin", "main")
    git("init", "-q", "--initial-branch=main", str(home / "code"))

    coordinates = {
        "JHW_REGISTRY_DIR": str(registry),
        "JHW_REGISTRY_REMOTE": "origin",
        "JHW_REGISTRY_BRANCH": "main",
        "JHW_WORKTREE_ROOT": str(home / "worktrees"),
        "JHW_CONTROL_STATE_DIR": str(home / "guard-state"),
        "JHW_BUILD_HOST": "runtime-integration",
        "JHW_GITHUB_OWNER": "fixture-owner",
        "JHW_PROJECT_NUMBER": "1",
        "JHW_REGISTRY_REPOSITORY": "fixture-owner/registry",
        "JHW_PREFLIGHT_PROJECT_ITEM_ID": "PVTI_fixture",
        "JHW_PREFLIGHT_REGISTRY_ISSUE_NUMBER": "1",
    }
    setup = """
import json
from pathlib import Path
import sys
home = Path(sys.argv[1])
coordinates = json.loads(sys.argv[2])
(home / 'code' / 'README.md').write_text('fixture\\n')
(home / 'bin').mkdir(mode=0o755)
(home / '.preflight-fixture.json').write_text('{"lastReviewed":null}\\n')
config = home / '.config/jhw-control'
config.mkdir(mode=0o700, parents=True)
config_file = config / 'control.env'
config_file.write_text(''.join(f'{key}={value}\\n' for key, value in coordinates.items()))
config_file.chmod(0o600)
"""
    checked(
        [*PYTHON, "-c", setup, str(home), json.dumps(coordinates)],
        CLIENT,
        environment,
        timeout=5,
    )
    fixture_bin = home / "bin"
    for name in ("gh", "git"):
        target = fixture_bin / name
        shutil.copyfile(HOST_FIXTURE, target)
        target.chmod(0o755)
    return {
        **environment,
        **coordinates,
        "PATH": f"{fixture_bin}:{environment['PATH']}",
        "GH_PROJECT_TOKEN": "synthetic-project-token",
        "GH_REPO_TOKEN": "synthetic-repository-token",
        "JHW_GUARD_MODE": "enforce",
    }


def wait_ready(marker, process):
    deadline = time.monotonic() + 30
    while not marker.exists():
        if process.poll() is not None:
            stdout, stderr = process.communicate()
            raise RuntimeError((marker.name, process.returncode, stdout, stderr))
        if time.monotonic() >= deadline:
            raise TimeoutError(marker.name)
        time.sleep(0.025)


def stop_process(process, timeout=15):
    if process.poll() is None:
        process.terminate()
    try:
        return process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        return process.communicate(timeout=5)


def assert_runtime_records_exclude_credentials(runtime):
    protected = b"fixture-protected-notion-key"
    stale = b"fixture-stale-client-credential"
    for record in (runtime / "v2/managed-invocations").glob("*.json"):
        payload = record.read_bytes()
        assert protected not in payload and stale not in payload, record


def assert_single_atomic_probe_workspace(runtime):
    probes = sorted(
        entry.name for entry in runtime.iterdir()
        if entry.name.startswith(".jhw-atomic-")
    )
    assert probes == [ATOMIC_PROBE_DIRECTORY], probes


def remove_owned_tree(path, uid, environment, *, controller_parent=False):
    if not path.exists():
        return
    program = """
from pathlib import Path
import shutil
import sys

root = Path(sys.argv[1])
if sys.argv[2] == 'controller-parent':
    for entry in root.iterdir():
        if entry.is_dir() and not entry.is_symlink():
            shutil.rmtree(entry)
        else:
            entry.unlink()
else:
    shutil.rmtree(root)
"""
    parent = "controller-parent" if controller_parent else "fixture-parent"
    checked([*PYTHON, "-c", program, str(path), parent], uid, environment, timeout=15)
    if controller_parent:
        path.rmdir()


def main():
    arguments = parse_arguments()
    require_isolated_root()
    base = Path(tempfile.mkdtemp(prefix="jhw-managed-acceptance-"))
    base.chmod(0o755)
    broker = None
    notion_relay = None
    clients = []
    fixture_root = None
    service_environment = ENVIRONMENT
    client_environment = ENVIRONMENT
    try:
        for name, uid in (("socket", SERVICE), ("user", CLIENT), ("credential", CREDENTIAL)):
            child = base / name
            child.mkdir(mode=0o755)
            os.chown(child, uid, uid)
        credential_private = base / "credential/private"
        credential_private.mkdir(mode=0o700)
        os.chown(credential_private, CREDENTIAL, CREDENTIAL)
        credential_key = credential_private / "notion.key"
        credential_key.write_text("fixture-protected-notion-key")
        credential_key.chmod(0o600)
        os.chown(credential_key, CREDENTIAL, CREDENTIAL)
        notion_socket = base / "credential/notion.sock"
        socket = base / "socket/runtime.sock"
        prepared = json.loads(checked(
            [NODE, str(PREPARE)],
            SERVICE,
            {**ENVIRONMENT, "HOME": str(socket.parent)},
            timeout=240,
            phase="prepare",
            cwd=SCRIPTS.parent,
        ))
        fixture_root = Path(prepared["root"])
        runtime = fixture_root / ".jhw-runtime"
        obsolete_bootstrap = runtime / "v2/bootstraps" / prepared["bootstrapC"]

        profile = base / "profile.json"
        profile.write_text(json.dumps({
            "version": 1,
            "serviceUid": SERVICE,
            "clientUid": CLIENT,
            "repositoryRoot": prepared["root"],
            "serviceHome": prepared["home"],
            "socket": str(socket),
            "node": NODE,
        }))
        profile.chmod(0o644)
        runtime_program = install_test_programs(base / "programs")
        notion_fixture = runtime_program.parent / NOTION_FIXTURE.name
        shutil.copyfile(NOTION_FIXTURE, notion_fixture)
        notion_fixture.chmod(0o644)
        notion_profile = profile.with_name(profile.name + ".notion.json")
        notion_profile.write_text(json.dumps({
            "version": 1,
            "credentialUid": CREDENTIAL,
            "socket": str(notion_socket),
            "keyFile": str(credential_key),
            "routes": [
                {"databaseId": database_id, "dataSourceId": data_source_id}
                for database_id, data_source_id in NOTION_ROUTES
            ],
        }))
        notion_profile.chmod(0o644)
        cli = [*PYTHON, str(runtime_program), "--profile", str(profile)]
        service_environment = {**ENVIRONMENT, "HOME": prepared["home"]}
        credential_environment = {**ENVIRONMENT, "HOME": str(credential_private)}
        client_environment = {
            **configure_guard(base / "user"),
            # A stale ambient value proves that session and invocation launchers
            # remove it instead of handing it to the user process or MCP.
            "NOTION_API_KEY": "fixture-stale-client-credential",
        }
        work = Path(client_environment["HOME"]) / "code"

        def deploy(*deployment_arguments):
            return json.loads(checked(
                [*cli, "deploy", "--", *deployment_arguments],
                SERVICE,
                service_environment,
                timeout=60,
                phase=" ".join(argument for argument in deployment_arguments if argument.startswith("--")),
            ))

        def recreate_obsolete():
            checked(
                [
                    NODE, "--input-type=module", "--eval", RECREATE_OBSOLETE,
                    prepared["root"], prepared["releaseC"],
                ],
                SERVICE,
                service_environment,
                timeout=30,
                cwd=SCRIPTS.parent,
            )

        def pair_for_mcp(pid):
            return checked(
                [
                    *PYTHON, "-c", PAIR_FOR_MCP,
                    str(runtime / "v2/managed-invocations"), str(pid),
                ],
                SERVICE,
                service_environment,
                timeout=5,
            ).strip()

        def start_notion_relay():
            process = subprocess.Popen(
                [*PYTHON, str(notion_fixture), str(profile)],
                **as_user(CREDENTIAL),
                env=credential_environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                wait_for(
                    lambda: notion_socket.exists()
                    and stat.S_IMODE(notion_socket.stat().st_mode) == 0o666,
                    process,
                )
            except BaseException:
                stop_process(process)
                raise
            return process

        notion_relay = start_notion_relay()
        checked([
            *PYTHON, "-c",
            "import pathlib, sys; "
            "entries = pathlib.Path('/proc', sys.argv[1], 'environ').read_bytes().split(b'\\0'); "
            "assert all(not entry.startswith(b'NOTION_API_KEY=') for entry in entries)",
            str(notion_relay.pid),
        ], CREDENTIAL, credential_environment, timeout=4)
        assert Path(f"/proc/{notion_relay.pid}").stat().st_uid == CREDENTIAL
        assert credential_key.stat().st_uid == CREDENTIAL
        assert stat.S_IMODE(credential_key.stat().st_mode) == 0o600
        unreadable = subprocess.run(
            ["/usr/bin/test", "!", "-r", str(credential_key)],
            **as_user(CLIENT),
            env=client_environment,
            check=False,
            timeout=4,
        )
        assert unreadable.returncode == 0, "managed client can read the protected Notion key"

        broker = subprocess.Popen(
            [*cli, "serve"],
            **as_user(SERVICE),
            env=service_environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        wait_for(lambda: socket.exists() and stat.S_IMODE(socket.stat().st_mode) == 0o666, broker)

        rows = []
        for trial in range(arguments.trials):
            if trial:
                recreate_obsolete()
            barriers = base / "user" / f"trial-{trial}"
            checked(["/usr/bin/mkdir", "-m", "0755", str(barriers)], CLIENT, client_environment, 4)
            started = time.monotonic()
            trial_clients = []

            def start(label):
                process = subprocess.Popen(
                    [
                        *cli, "session", "--", *PYTHON, str(CLIENT_PROGRAM),
                        str(work), label, str(barriers), *cli,
                    ],
                    **as_user(CLIENT),
                    env=client_environment,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                trial_clients.append(process)
                clients.append(process)
                return process

            completed = []
            try:
                for number in range(3):
                    start(f"a{number}")
                for number, process in enumerate(trial_clients[:3]):
                    wait_ready(barriers / f"a{number}.ready", process)
                    mcp_pid = (barriers / f"a{number}.pid").read_text()
                    assert pair_for_mcp(mcp_pid) == prepared["origin"]["releaseId"]

                activated = deploy("--activate-compatible", prepared["releaseB"])
                assert activated["releaseId"] == prepared["releaseB"], activated
                assert activated["inventory"]["after"]["processes"]["sessionRoots"] == 3, activated

                b_client = start("b")
                wait_ready(barriers / "b.ready", b_client)
                assert pair_for_mcp((barriers / "b.pid").read_text()) == prepared["releaseB"]
                stop_process(notion_relay)
                (barriers / "relay-stopped").touch()
                wait_ready(barriers / "b.relay-unavailable", b_client)
                notion_relay = start_notion_relay()
                (barriers / "relay-restarted").touch()
                wait_ready(barriers / "b.relay-ready", b_client)
                assert_runtime_records_exclude_credentials(runtime)

                rolled_back = deploy("--rollback")
                assert rolled_back["releaseId"] == prepared["origin"]["releaseId"], rolled_back
                assert rolled_back["inventory"]["after"]["processes"]["sessionRoots"] == 4

                plan = deploy("--prune")
                assert plan["candidates"]["bootstrapGenerations"] == [prepared["bootstrapC"]], plan
                removed = deploy("--prune", "--apply")
                assert removed["removed"]["bootstrapGenerations"] == 1, removed
                assert removed["inventory"]["after"]["processes"]["sessionRoots"] == 4, removed

                for number in range(3):
                    mcp_pid = (barriers / f"a{number}.pid").read_text()
                    assert pair_for_mcp(mcp_pid) == prepared["origin"]["releaseId"]
                assert pair_for_mcp((barriers / "b.pid").read_text()) == prepared["releaseB"]
                checked(["/usr/bin/test", "!", "-e", str(obsolete_bootstrap)], SERVICE, service_environment, 4)
                assert all(process.poll() is None for process in trial_clients)
            finally:
                checked(["/usr/bin/touch", str(barriers / "finish")], CLIENT, client_environment, 4)
                errors = []
                for process in trial_clients:
                    try:
                        stdout, stderr = process.communicate(timeout=20)
                    except subprocess.TimeoutExpired:
                        stdout, stderr = stop_process(process, timeout=5)
                    clients.remove(process)
                    if process.returncode != 0:
                        errors.append((process.returncode, stderr[-2500:], stdout))
                    else:
                        completed.append(json.loads(stdout))
                if errors:
                    raise RuntimeError(errors)

            deadline = time.monotonic() + 10
            while deploy("--status")["inventory"]["sessionRoots"] != 0:
                if time.monotonic() >= deadline:
                    raise TimeoutError("managed session roots did not drain")
                time.sleep(0.05)

            maximums = {}
            for result in completed:
                for event, duration in result["maxMs"].items():
                    maximums[event] = max(duration, maximums.get(event, 0))
            row = {
                "round": trial + 1,
                "sessions": len(completed),
                "iterations": sum(result["iterations"] for result in completed),
                "seconds": round(time.monotonic() - started, 2),
                "maxMs": maximums,
            }
            assert_single_atomic_probe_workspace(runtime)
            rows.append(row)
            print(json.dumps(row), flush=True)

    finally:
        for process in clients:
            stop_process(process, timeout=5)
        if broker is not None:
            stop_process(broker)
        if notion_relay is not None:
            stop_process(notion_relay)
        if fixture_root is not None:
            remove_owned_tree(fixture_root, SERVICE, service_environment)
        remove_owned_tree(base / "user", CLIENT, client_environment, controller_parent=True)
        remove_owned_tree(base / "socket", SERVICE, service_environment, controller_parent=True)
        remove_owned_tree(
            base / "credential",
            CREDENTIAL,
            {**ENVIRONMENT, "HOME": str(base / "credential/private")},
            controller_parent=True,
        )
        shutil.rmtree(base)

    print(json.dumps({"passed": len(rows), "requested": arguments.trials}), flush=True)


if __name__ == "__main__":
    main()
