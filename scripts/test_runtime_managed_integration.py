"""Run the managed client, service, v2 entry and lifetime holder across two UIDs."""

import json
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unittest

SERVICE = 1003
CLIENT = 61001
SCRIPTS = Path(__file__).resolve().parent
NODE = "/usr/local/bin/node"
ENVIRONMENT = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"}
PYTHON = [sys.executable, "-E", "-s", "-B"]

PREPARE = """
import fs from 'node:fs';
import path from 'node:path';
import {installRouterV2} from './scripts/runtime-entry.mjs';
import {acquireLease} from './scripts/runtime-safety.mjs';
import {ensureBootstrapGeneration, preparePairActivation, prepareRuntimeEvidence,
  publishPreparedActivation} from './scripts/runtime-store.mjs';
import {createRuntimeFixture} from './scripts/test-support/runtime-v2.mjs';

const fixture = await createRuntimeFixture({after() {}}, {productionEntry: true});
fixture.write('scripts/install-config.mjs', '');
fixture.write('scripts/install-wiring.sh', [
  'initialize_wiring_directories() { :; }',
  'select_managed_wiring() { :; }',
  'verify_wiring() { :; }',
].join('\\n'));
const bundles = {mcp: `
  const readline = require('node:readline');
  readline.createInterface({input:process.stdin}).on('line', line => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    const result = request.method === 'tools/list' ? {tools:[]} :
      {protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'fixture',version:'1'}};
    console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
  });
`, control: `
  const fs = require('node:fs');
  const [command, ready, finish] = process.argv.slice(2);
  if (command === 'hold') {
    fs.writeFileSync(ready, String(process.pid), {mode:0o644});
    const timer = setInterval(() => {
      if (fs.existsSync(finish)) clearInterval(timer);
    }, 10);
  } else {
    console.log(JSON.stringify({uid: process.getuid(), release: globalThis.__JHW_MANAGED_RELEASE_ROOT__, command}));
  }
`};
const release = await fixture.prepare(bundles);
const entry = fs.readFileSync(path.join(fixture.root, 'scripts/runtime-entry.mjs'), 'utf8');
fixture.write('scripts/runtime-entry.mjs', entry + '\\n// fixture candidate B\\n');
const candidate = await fixture.prepare(bundles);
fixture.write('scripts/runtime-entry.mjs', entry + '\\n// fixture candidate C\\n');
const obsolete = await fixture.prepare(bundles);
const runtime = path.join(fixture.root, '.jhw-runtime');
const writer = acquireLease(path.join(runtime, 'deploy.lock'));
const admission = acquireLease(path.join(runtime, 'admission.lock'), {create:true});
let pair;
let unused;
try {
  pair = ensureBootstrapGeneration({repositoryRoot:fixture.root, releaseId:release.releaseId, deployLease:writer});
  unused = ensureBootstrapGeneration({repositoryRoot:fixture.root, releaseId:obsolete.releaseId, deployLease:writer});
  await installRouterV2({repositoryRoot:fixture.root, releaseId:release.releaseId, deployLease:writer, admissionLease:admission});
  const evidence = prepareRuntimeEvidence({repositoryRoot:fixture.root, pairs:[pair]});
  const destination = preparePairActivation({repositoryRoot:fixture.root, pair, expectedCurrent:null, deployLease:writer});
  const publication = acquireLease(path.join(runtime, 'publication.lock'), {create:true});
  try {
    publishPreparedActivation({repositoryRoot:fixture.root, destination, expectedCurrent:null,
      evidence, publicationLease:publication});
  } finally {
    publication.close();
    evidence.close();
  }
} finally {
  admission.close();
  writer.close();
}
for (const file of ['runtime-managed-artifact.mjs', 'runtime-managed-worker-probe.mjs']) {
  fs.copyFileSync(path.join('scripts', file), path.join(fixture.root, 'scripts', file));
}
fs.mkdirSync(path.join(runtime,'v2/managed-invocations'), {mode:0o700});
const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
fs.utimesSync(path.join(runtime, 'v2', 'bootstraps', unused.bootstrapId), old, old);
console.log(JSON.stringify({root:fixture.root, home:fixture.home, ...pair,
  candidate:candidate.releaseId, obsolete:unused.bootstrapId}));
"""

CLIENT_PROGRAM = """
import os
from pathlib import Path
import subprocess
import sys

base, *cli = sys.argv[1:]
base = Path(base)
(base / 'binding').write_text(os.environ['JHW_RUNTIME_SESSION_BINDING'])
subprocess.run([*cli, 'invoke', 'control', 'probe'], check=True)
subprocess.run([*cli, 'invoke', 'control', 'hold', str(base / 'working'), str(base / 'finish')], check=True)
"""


def as_user(uid):
    return {"user": uid, "group": uid, "extra_groups": []}


def install_test_programs(directory):
    directory.mkdir(mode=0o755)
    for pattern in ("runtime_managed*.py", "runtime-*.mjs", "runtime-managed-invocation.cjs"):
        for source in SCRIPTS.glob(pattern):
            target = directory / source.name
            shutil.copyfile(source, target)
            target.chmod(0o644)
    return directory / "runtime_managed.py"


def wait_for(predicate, process=None):
    deadline = time.monotonic() + 8
    while not predicate():
        if process is not None and process.poll() is not None:
            stdout, stderr = process.communicate()
            raise AssertionError(f"fixture exited {process.returncode} {stdout!r} {stderr!r}")
        if time.monotonic() >= deadline:
            raise TimeoutError("fixture operation timed out")
        time.sleep(0.02)


@unittest.skipUnless(
    os.getuid() == 0 and os.environ.get("JHW_MANAGED_TEST_ISOLATED") == "1",
    "requires disposable Linux environment with fixture UIDs",
)
class ManagedIntegrationTests(unittest.TestCase):
    def test_bound_client_and_disconnected_holder(self):
        with tempfile.TemporaryDirectory(prefix="jhw-managed-") as directory:
            base = Path(directory)
            base.chmod(0o755)
            sockets = base / "sock"
            client = base / "client"
            for child, uid in ((sockets, SERVICE), (client, CLIENT)):
                child.mkdir(mode=0o755)
                child.chmod(0o755)
                os.chown(child, uid, uid)
            completed = subprocess.run(
                [NODE, "--input-type=module", "--eval", PREPARE], cwd=SCRIPTS.parent,
                env={**ENVIRONMENT, "HOME": str(sockets)}, **as_user(SERVICE),
                capture_output=True, check=True, text=True, timeout=30,
            )
            runtime = json.loads(completed.stdout)
            store = Path(runtime["root"]) / ".jhw-runtime"
            profile = base / "profile.json"
            socket_path = sockets / "runtime.sock"
            profile.write_text(json.dumps({
                "version": 1, "serviceUid": SERVICE, "clientUid": CLIENT,
                "repositoryRoot": runtime["root"], "serviceHome": runtime["home"],
                "socket": str(socket_path), "node": NODE,
            }))
            profile.chmod(0o644)
            cli = [*PYTHON, str(install_test_programs(base / "programs")), "--profile", str(profile)]
            service_env = {**ENVIRONMENT, "HOME": runtime["home"]}
            client_env = {**ENVIRONMENT, "HOME": str(client)}
            commands = {
                "service": {"env": service_env, **as_user(SERVICE), "stdout": subprocess.PIPE,
                            "stderr": subprocess.PIPE, "text": True},
                "client": {"env": client_env, **as_user(CLIENT), "stdout": subprocess.PIPE,
                           "stderr": subprocess.PIPE, "text": True},
            }
            broker = subprocess.Popen([*cli, "serve"], **commands["service"])
            root = None
            restarted = None

            def signal_completion():
                subprocess.run(["/usr/bin/touch", str(client / "finish")], **as_user(CLIENT),
                               check=True, timeout=4)

            def deploy(*argv):
                result = subprocess.run([*cli, "deploy", "--", *argv], **commands["service"], timeout=15)
                value = json.loads(result.stdout)
                self.assertEqual(result.returncode, 0, (value, result.stderr))
                return value

            try:
                wait_for(lambda: socket_path.exists() and stat.S_IMODE(socket_path.stat().st_mode) == 0o666,
                         broker)
                root = subprocess.Popen([*cli, "session", "--", *PYTHON, "-c", CLIENT_PROGRAM,
                                         str(client), *cli], **commands["client"])
                wait_for((client / "working").exists, root)
                binding = (client / "binding").read_text()
                unrelated = subprocess.run(
                    [*cli, "invoke", "control", "probe"],
                    **{**commands["client"], "env": {**client_env, "JHW_RUNTIME_SESSION_BINDING": binding}},
                    timeout=5,
                )
                self.assertEqual((unrelated.returncode, unrelated.stdout, json.loads(unrelated.stderr)),
                                 (75, "", {"error": {"code": "DEPLOY_MANAGED_UNAVAILABLE"}}))
                denied = subprocess.run([*cli, "deploy", "--", "--rollback"], **commands["client"], timeout=5)
                self.assertEqual(denied.returncode, 75)
                ordinary = subprocess.run([NODE, "--input-type=module", "--eval", """
import {runDeployment} from './scripts/runtime-deploy.mjs';
const [repositoryRoot, home] = process.argv.slice(1);
try {
  await runDeployment({repositoryRoot, home, argv:['--prune','--apply']});
} catch (error) {
  console.log(error.code);
  process.exitCode = 1;
}
""", runtime["root"], runtime["home"]], cwd=SCRIPTS.parent, **commands["service"], timeout=5)
                self.assertEqual((ordinary.returncode, ordinary.stdout), (1, "DEPLOY_MANAGED_MODE_REQUIRED\n"))
                status = deploy("--status")
                self.assertEqual(status["inventory"], {
                    "boundary": "dedicated-service", "sessionRoots": 1, "invocationRecords": True,
                })
                self.assertNotIn("--uninstall", deploy("--help")["commands"])
                self.assertEqual(deploy("--activate-compatible", runtime["candidate"])["releaseId"],
                                 runtime["candidate"])
                successor = subprocess.run([*cli, "session", "--", *cli, "invoke", "control", "probe"],
                                           **commands["client"], timeout=10)
                self.assertEqual(successor.returncode, 0, successor.stderr)
                self.assertEqual(Path(json.loads(successor.stdout)["release"]).name, runtime["candidate"])
                # The short successor may still be retiring its service-side root.
                wait_for(lambda: deploy("--status")["inventory"]["sessionRoots"] == 1, broker)
                self.assertEqual(deploy("--rollback")["releaseId"], runtime["releaseId"])
                planned = deploy("--prune")
                self.assertEqual(planned["candidates"]["bootstrapGenerations"], [runtime["obsolete"]])
                intent = store / "v2" / "managed-invocations" / (runtime["obsolete"] + ".i-" + "a" * 32 + ".json")
                subprocess.run([*PYTHON, "-c", "import os, sys; os.close(os.open(sys.argv[1], "
                                "os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))", str(intent)],
                               **as_user(SERVICE), check=True, timeout=4)
                try:
                    self.assertEqual(deploy("--prune", "--apply")["removed"]["bootstrapGenerations"], 0)
                finally:
                    subprocess.run(["/usr/bin/unlink", str(intent)], **as_user(SERVICE), check=True, timeout=4)
                self.assertEqual(deploy("--prune", "--apply")["removed"]["bootstrapGenerations"], 1)
                self.assertIsNone(root.poll())
                broker.send_signal(signal.SIGKILL)
                self.assertEqual(broker.wait(timeout=5), -signal.SIGKILL)
                blocked = subprocess.run([*cli, "serve"], **commands["service"], timeout=5)
                self.assertEqual((blocked.returncode, blocked.stderr), (75, "DEPLOY_MANAGED_RECOVERY_REQUIRED\n"))
                lease = store / "v2" / "bootstraps" / runtime["bootstrapId"] / "lease"
                self.assertEqual(self._lease(lease, service_env), 75)
                signal_completion()
                output, error = root.communicate(timeout=5)
                self.assertEqual(root.returncode, 0, error)
                self.assertEqual(json.loads(output), {"uid": CLIENT, "command": "probe",
                                                      "release": str(store / "releases" / runtime["releaseId"])})
                wait_for(lambda: self._lease(lease, service_env) == 0)
                old_socket = socket_path.stat().st_ctime_ns
                restarted = subprocess.Popen([*cli, "serve"], **commands["service"])
                wait_for(lambda: (socket_path.exists() and socket_path.stat().st_ctime_ns != old_socket
                                  and stat.S_IMODE(socket_path.stat().st_mode) == 0o666),
                         restarted)
                replacement = subprocess.run([*cli, "session", "--", *cli, "invoke", "control", "probe"],
                                             **commands["client"], timeout=10)
                self.assertEqual(replacement.returncode, 0, replacement.stderr)
                self.assertEqual(json.loads(replacement.stdout)["uid"], CLIENT)
            finally:
                signal_completion()
                for process in (root, restarted, broker):
                    if process is None:
                        continue
                    if process.poll() is None:
                        process.terminate()
                    try:
                        process.communicate(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.communicate(timeout=5)
                for child, uid in ((client, CLIENT), (sockets, SERVICE)):
                    subprocess.run([*PYTHON, "-c", """
import pathlib, shutil, sys
for child in pathlib.Path(sys.argv[1]).iterdir():
    if child.is_dir() and not child.is_symlink():
        shutil.rmtree(child)
    else:
        child.unlink()
""", str(child)], **as_user(uid), check=True, timeout=5)
                subprocess.run([*PYTHON, "-c", "import shutil, sys; shutil.rmtree(sys.argv[1])",
                                runtime["root"]], **as_user(SERVICE), check=True, timeout=5)

    @staticmethod
    def _lease(lease, environment):
        return subprocess.run(["/usr/bin/flock", "-x", "-n", "-E", "75", str(lease), "/bin/true"],
                              env=environment, **as_user(SERVICE), check=False, timeout=4).returncode
