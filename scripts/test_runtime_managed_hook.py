import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest

from runtime_managed_hook import supervise_hook


def python_command(source):
    return [sys.executable, "-E", "-s", "-B", "-c", source]


class ManagedHookWatchdogTest(unittest.TestCase):
    def test_normalizes_each_canonical_hook_output(self):
        cases = {
            "PreToolUse": {"hookSpecificOutput": {"hookEventName": "PreToolUse"}},
            "UserPromptSubmit": {
                "hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "context"},
                "systemMessage": "message",
            },
            "PostToolUse": {"systemMessage": "message"},
            "SessionEnd": {},
        }
        for event, value in cases.items():
            with self.subTest(event=event):
                source = f"import sys; sys.stdout.write('  ' + {json.dumps(json.dumps(value))} + '  ');"
                self.assertEqual(supervise_hook(python_command(source), event),
                                 (json.dumps(value, separators=(",", ":")) + "\n", None))

        denied = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": "reason",
            },
            "systemMessage": "message",
        }
        source = f"print({json.dumps(json.dumps(denied))})"
        self.assertEqual(supervise_hook(python_command(source), "PreToolUse"),
                         (json.dumps(denied, separators=(",", ":")) + "\n", None))

    def test_inherits_stdin_and_discards_stderr(self):
        read_fd, write_fd = os.pipe()
        original = os.dup(0)
        try:
            os.write(write_fd, b'{"tool":"Read"}')
            os.close(write_fd)
            os.dup2(read_fd, 0)
            source = """
import json, sys
value=json.load(sys.stdin)
sys.stderr.write('private diagnostic\\n')
print(json.dumps({'systemMessage':value['tool']}))
"""
            self.assertEqual(supervise_hook(python_command(source), "PostToolUse"),
                             ('{"systemMessage":"Read"}\n', None))
        finally:
            os.dup2(original, 0)
            os.close(original)
            os.close(read_fd)

    def test_rejects_malformed_schema_nonzero_exit_and_oversized_stdout(self):
        commands = [
            python_command("print('{not-json')"),
            python_command("print('{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\"}}')"),
            python_command("print('{}'); raise SystemExit(2)"),
            python_command("import sys; sys.stdout.write('x' * 12289)"),
        ]
        for command in commands:
            with self.subTest(command=command[-1]):
                self.assertEqual(supervise_hook(command, "PreToolUse"), (None, "GUARD_UNAVAILABLE"))

    def test_session_end_timeout_terminates_the_exact_ignoring_process(self):
        with tempfile.TemporaryDirectory() as directory:
            pid_file = Path(directory) / "pid"
            source = f"""
import os, signal, time
open({str(pid_file)!r}, 'w').write(str(os.getpid()))
signal.signal(signal.SIGTERM, lambda *_: None)
while True: time.sleep(1)
"""
            started = time.monotonic()
            self.assertEqual(supervise_hook(python_command(source), "SessionEnd"),
                             (None, "GUARD_HOOK_TIMEOUT"))
            elapsed = time.monotonic() - started
            self.assertGreaterEqual(elapsed, 2)
            self.assertLess(elapsed, 3)
            pid = int(pid_file.read_text())
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)


if __name__ == "__main__":
    unittest.main()
