"""Explicit client and service entry points for the managed runtime."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

from runtime_managed_broker import BINDING, SELECTORS, require_artifact, require_pair, serve
from runtime_managed_hook import supervise_hook
from runtime_managed_lifetime import InvocationInFlight
from runtime_managed_profile import load_profile, require_protected_programs
from runtime_managed_protocol import decode_message, encode_message
from runtime_managed_transport import ManagedPeer, PeerRejected, local_socket

_BINDING_VARIABLE = "JHW_RUNTIME_SESSION_BINDING"
_EVENTS = ("PreToolUse", "PostToolUse", "UserPromptSubmit", "SessionEnd")


def _connect(profile, timeout):
    connection = local_socket()
    try:
        connection.settimeout(timeout)
        connection.connect(str(profile.socket))
        return ManagedPeer(connection, profile.service_uid)
    except (OSError, PeerRejected):
        connection.close()
        raise


def _session(profile, argv):
    if len(argv) < 2 or argv[0] != "--" or _BINDING_VARIABLE in os.environ:
        raise ValueError("invalid managed session arguments")
    with _connect(profile, 10) as peer:
        peer.send(encode_message({"op": "session"}))
        reply = decode_message(peer.receive()[0])
        if (set(reply) != {"op", "binding", "releaseId", "bootstrapId"} or reply["op"] != "bound"
                or type(reply["binding"]) is not str or BINDING.fullmatch(reply["binding"]) is None):
            raise ValueError("invalid managed session reply")
        require_pair(reply)
    # The caller's process remains the root while the requested user command runs.
    status = subprocess.call(argv[1:], env={**os.environ, _BINDING_VARIABLE: reply["binding"]})
    return 128 - status if status < 0 else status


def _hook_event(argv):
    if len(argv) < 4 or argv[2] != "--event" or argv[3] not in _EVENTS:
        return "PreToolUse"
    return argv[3]


def _failure(selector, argv, code):
    if selector == "control":
        print(json.dumps({"error": {"code": code}}, separators=(",", ":")), file=sys.stderr)
    elif selector == "hook":
        event = _hook_event(argv)
        result = {"systemMessage": code}
        if event == "SessionEnd":
            result = {}
        elif event == "UserPromptSubmit":
            result["hookSpecificOutput"] = {"hookEventName": event, "additionalContext": code}
        elif event == "PreToolUse":
            result["hookSpecificOutput"] = {
                "hookEventName": event, "permissionDecision": "deny", "permissionDecisionReason": code,
            }
        print(json.dumps(result, separators=(",", ":")))
        return 0
    else:
        print(code, file=sys.stderr)
    return 75


def _invoke(profile, selector, argv):
    if selector == "hook" and (len(argv) != 4 or argv[0] != "--adapter"
                               or argv[1] not in ("claude", "codex") or argv[2] != "--event"
                               or argv[3] not in _EVENTS):
        return _failure(selector, argv, "GUARD_PROTOCOL_MISMATCH")
    binding = os.environ.get(_BINDING_VARIABLE, "")
    if BINDING.fullmatch(binding) is None:
        raise ValueError("managed session binding required")
    descriptor = None
    try:
        timeout = 1.7 if selector == "hook" and _hook_event(argv) == "SessionEnd" else 6
        with _connect(profile, timeout) as peer:
            peer.send(encode_message({"op": "invoke", "binding": binding, "selector": selector}))
            packet, (descriptor,) = peer.receive(expected_descriptors=1)
            artifact = decode_message(packet)
            release_id, _ = require_artifact(artifact, descriptor, profile.service_uid)
        release_root = profile.runtime / "releases" / release_id
        runner = Path(__file__).with_name("runtime-managed-invocation.cjs")
        os.set_inheritable(descriptor, True)
        os.execve(profile.node, [
            str(profile.node), str(runner), str(descriptor), artifact["sha256"], str(artifact["bytes"]),
            str(release_root), selector, *argv,
        ], _runtime_environment())
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _runtime_environment():
    return {name: value for name, value in os.environ.items()
            if name.upper() not in ("BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS")
            and not name.upper().startswith(("NODE_", "LD_", "DYLD_"))}


def _supervised_hook(profile, argv):
    event = _hook_event(argv)
    command = [sys.executable, "-E", "-s", "-B", __file__, "--profile", str(profile.path),
               "_hook-worker", "--", *argv]
    output, error = supervise_hook(command, event, environment=_runtime_environment())
    if output is None:
        return _failure("hook", argv, error or "GUARD_UNAVAILABLE")
    sys.stdout.write(output)
    return 0


def _deploy(profile, argv):
    if len(argv) < 2 or argv[0] != "--":
        raise ValueError("managed deployment arguments must follow --")
    profile.require_service()
    descriptor = profile.open_descriptor()
    try:
        os.set_inheritable(descriptor, True)
        writer = Path(__file__).with_name("runtime-managed-writer.mjs")
        os.execve(profile.node, [str(profile.node), str(writer), str(descriptor), *argv[1:]], {
            "HOME": str(profile.home), "PATH": f"{profile.node.parent}:/usr/bin:/bin", "LANG": "C.UTF-8",
        })
    finally:
        os.close(descriptor)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True)
    modes = parser.add_subparsers(dest="mode", required=True)
    modes.add_parser("serve")
    session = modes.add_parser("session")
    session.add_argument("arguments", nargs=argparse.REMAINDER)
    invocation = modes.add_parser("invoke")
    invocation.add_argument("selector", choices=SELECTORS)
    invocation.add_argument("arguments", nargs=argparse.REMAINDER)
    for mode in ("deploy", "_hook-worker"):
        modes.add_parser(mode).add_argument("arguments", nargs=argparse.REMAINDER)
    command = parser.parse_args()
    try:
        require_protected_programs(Path(__file__).parent)
        profile = load_profile(command.profile)
        if command.mode == "serve":
            serve(profile)
            return 0
        if command.mode == "deploy":
            return _deploy(profile, command.arguments)
        profile.require_client()
        if command.mode == "session":
            return _session(profile, command.arguments)
        if command.mode == "_hook-worker":
            if command.arguments[:1] != ["--"]:
                raise ValueError("invalid hook worker arguments")
            return _invoke(profile, "hook", command.arguments[1:])
        if command.selector == "hook":
            return _supervised_hook(profile, command.arguments)
        return _invoke(profile, command.selector, command.arguments)
    except (OSError, RuntimeError, ValueError, EOFError) as error:
        if command.mode == "invoke":
            code = "GUARD_UNAVAILABLE" if command.selector == "hook" else "DEPLOY_MANAGED_UNAVAILABLE"
            return _failure(command.selector, command.arguments, code)
        if command.mode == "_hook-worker":
            return _failure("hook", command.arguments[1:], "GUARD_UNAVAILABLE")
        if isinstance(error, InvocationInFlight):
            print("DEPLOY_MANAGED_RECOVERY_REQUIRED", file=sys.stderr)
        else:
            print("DEPLOY_MANAGED_UNAVAILABLE", file=sys.stderr)
        return 75
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
