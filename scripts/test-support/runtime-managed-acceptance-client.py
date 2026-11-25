"""Exercise an active real-dependency managed session until its fixture barrier opens."""

import json
import os
from pathlib import Path
import subprocess
import sys
import time


work, label, barrier, *cli = sys.argv[1:]
barrier = Path(barrier)
events = ("UserPromptSubmit", "PreToolUse", "PostToolUse", "SessionEnd")
EXPECTED_SEARCH = {
    "query": "managed-relay-fixture",
    "db": None,
    "scannedItems": 1,
    "count": 1,
    "truncated": False,
    "searchIncomplete": False,
    "results": [{
        "id": "00000000-0000-4000-8000-000000000001",
        "db": "page",
        "title": "Managed relay fixture",
        "url": "https://www.notion.so/managed-relay-fixture",
        "lastEdited": "2026-11-24T00:00:00.000Z",
    }],
}


def request(selector, arguments, value=None):
    started = time.monotonic_ns()
    result = subprocess.run(
        [*cli, "invoke", selector, *arguments],
        text=True,
        input=None if value is None else json.dumps(value),
        capture_output=True,
        cwd=work,
        timeout=13,
        check=False,
    )
    elapsed = (time.monotonic_ns() - started) / 1e6
    if result.returncode != 0:
        raise RuntimeError((selector, arguments, result.returncode, result.stderr, result.stdout))
    return json.loads(result.stdout), elapsed


def control_preflight(expected_code):
    result = subprocess.run(
        [*cli, "invoke", "control", "preflight"],
        text=True,
        capture_output=True,
        cwd=work,
        timeout=30,
        check=False,
    )
    if expected_code is None:
        assert result.returncode == 0 and result.stderr == "", (
            result.returncode, result.stdout, result.stderr
        )
        payload = json.loads(result.stdout)
        assert payload["command"] == "preflight", payload
        assert payload["result"]["status"] == "ready", payload
        assert all(value == "ok" for value in payload["result"]["checks"].values()), payload
        return
    assert result.returncode == 78, (result.returncode, result.stdout, result.stderr)
    assert result.stdout == ""
    assert result.stderr == json.dumps(
        {"error": {"code": expected_code}},
        separators=(",", ":"),
    ) + "\n"


with subprocess.Popen(
    [*cli, "invoke", "mcp"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    cwd=work,
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

        def search(request_id):
            mcp.stdin.write(json.dumps({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "tools/call",
                "params": {
                    "name": "jhw_search",
                    "arguments": {"query": "managed-relay-fixture", "limit": 1},
                },
            }) + "\n")
            mcp.stdin.flush()
            reply = json.loads(mcp.stdout.readline())
            assert reply.get("id") == request_id and "result" in reply, reply
            content = reply["result"].get("content")
            assert isinstance(content, list) and len(content) == 1, reply
            result = json.loads(content[0]["text"])
            assert result == EXPECTED_SEARCH, result

        def unavailable_search(request_id):
            mcp.stdin.write(json.dumps({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "tools/call",
                "params": {
                    "name": "jhw_search",
                    "arguments": {"query": "managed-relay-fixture", "limit": 1},
                },
            }) + "\n")
            mcp.stdin.flush()
            reply = json.loads(mcp.stdout.readline())
            assert reply.get("id") == request_id and "result" in reply, reply
            result = reply["result"]
            assert result.get("isError") is True, reply
            error_text = "\n".join(
                item.get("text", "") for item in result.get("content", [])
                if isinstance(item, dict) and item.get("type") == "text"
            )
            assert "NOTION_MANAGED_UNAVAILABLE" in error_text, reply

        search(3)
        if label == "b":
            control_preflight(None)

        assert "NOTION_API_KEY" not in os.environ, "managed session inherited the stale credential"
        mcp_environment = Path(f"/proc/{mcp.pid}/environ").read_bytes().split(b"\0")
        assert not any(value.startswith(b"NOTION_API_KEY=") for value in mcp_environment), (
            "MCP inherited a raw Notion credential"
        )
        assert Path(f"/proc/{mcp.pid}").stat().st_uid == os.getuid(), "MCP changed the client UID"

        (barrier / f"{label}.pid").write_text(str(mcp.pid))
        iterations = 0
        relay_rechecked = False
        relay_failure_checked = False
        maximums = {}
        while not (barrier / "finish").exists():
            if label == "b" and (barrier / "relay-stopped").exists() and not relay_failure_checked:
                unavailable_search(999)
                control_preflight("NOTION_GUARD_INDETERMINATE")
                relay_failure_checked = True
                (barrier / f"{label}.relay-unavailable").touch()
            if label == "b" and (barrier / "relay-restarted").exists() and not relay_rechecked:
                search(1000)
                relay_rechecked = True
                (barrier / f"{label}.relay-ready").touch()

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
