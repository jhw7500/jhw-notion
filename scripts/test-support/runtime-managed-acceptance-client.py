"""Exercise an active real-dependency managed session until its fixture barrier opens."""

import json
import os
from pathlib import Path
import subprocess
import sys
import time


work, label, barrier, *cli = sys.argv[1:]
barrier = Path(barrier)
environment = {**os.environ, "NOTION_API_KEY": "fixture-only"}
events = ("UserPromptSubmit", "PreToolUse", "PostToolUse", "SessionEnd")


def request(selector, arguments, value=None):
    started = time.monotonic_ns()
    result = subprocess.run(
        [*cli, "invoke", selector, *arguments],
        text=True,
        input=None if value is None else json.dumps(value),
        capture_output=True,
        cwd=work,
        env=environment,
        timeout=13,
        check=False,
    )
    elapsed = (time.monotonic_ns() - started) / 1e6
    if result.returncode != 0:
        raise RuntimeError((selector, arguments, result.returncode, result.stderr, result.stdout))
    return json.loads(result.stdout), elapsed


with subprocess.Popen(
    [*cli, "invoke", "mcp"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    cwd=work,
    env=environment,
) as mcp:
    try:
        assert mcp.stdin is not None and mcp.stdout is not None
        for request_id, method in enumerate(("initialize", "tools/list"), start=1):
            params = (
                {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "managed-acceptance", "version": "1"},
                }
                if request_id == 1
                else {}
            )
            mcp.stdin.write(json.dumps({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": params,
            }) + "\n")
            mcp.stdin.flush()
            reply = json.loads(mcp.stdout.readline())
            assert reply.get("id") == request_id and "result" in reply, reply
            if method == "tools/list":
                assert reply["result"]["tools"], reply

        (barrier / f"{label}.pid").write_text(str(mcp.pid))
        iterations = 0
        maximums = {}
        while not (barrier / "finish").exists():
            result, elapsed = request("control", ["guard", "status"])
            status = result["result"]
            assert status["runtime_mode"] == "enforce", result
            assert status["registry_claims"]["availability"] == "available", result
            maximums["control"] = max(elapsed, maximums.get("control", 0))

            for event in events:
                payload = {
                    "session_id": label,
                    "cwd": work,
                    "hook_event_name": event,
                    "transcript_path": None,
                }
                if event != "SessionEnd":
                    payload.update(
                        model="fixture-model",
                        permission_mode="default",
                        turn_id="fixture-turn",
                    )
                if event == "UserPromptSubmit":
                    payload["prompt"] = "continue"
                elif event in ("PreToolUse", "PostToolUse"):
                    payload.update(
                        tool_name="Read",
                        tool_input={"file_path": "README.md"},
                        tool_use_id=f"fixture-{iterations}",
                    )
                    if event == "PostToolUse":
                        payload["tool_response"] = {"success": True}
                else:
                    payload["reason"] = "other"

                output, elapsed = request(
                    "hook",
                    ["--adapter", "codex", "--event", event],
                    payload,
                )
                if event == "UserPromptSubmit":
                    assert output["systemMessage"].startswith("NO_STATE_CHANGE"), output
                elif event == "PreToolUse":
                    assert output == {"hookSpecificOutput": {"hookEventName": event}}, output
                elif event == "PostToolUse":
                    assert output == {"systemMessage": "GUARD_REQUEST_NOT_FOUND"}, output
                else:
                    assert output == {}, output
                deadline_ms = 3000 if event == "SessionEnd" else 12000
                assert elapsed < deadline_ms, (event, elapsed, deadline_ms)
                maximums[event] = max(elapsed, maximums.get(event, 0))

            iterations += 1
            (barrier / f"{label}.ready").touch()

        print(json.dumps({"label": label, "iterations": iterations, "maxMs": maximums}))
    finally:
        if mcp.stdin is not None:
            mcp.stdin.close()
        mcp.wait(timeout=5)
