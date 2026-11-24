"""Bounded same-UID watchdog for one managed hook process."""

import json
import os
import select
import signal
import subprocess
import time


_MAX_OUTPUT = 12 * 1024
_TERM_GRACE_SECONDS = 0.2
_EVENT_DEADLINES = {
    "PreToolUse": 8,
    "PostToolUse": 8,
    "UserPromptSubmit": 8,
    "SessionEnd": 2,
}


def _unique_fields(pairs):
    value = dict(pairs)
    if len(value) != len(pairs):
        raise ValueError("duplicate hook output field")
    return value


def _invalid_constant(_value):
    raise ValueError("non-finite hook output")


def _exact(value, keys):
    return type(value) is dict and set(value) == set(keys)


def _nonempty(value):
    return type(value) is str and len(value) > 0


def _normalize_output(bytes_value, event):
    if not 0 < len(bytes_value) <= _MAX_OUTPUT:
        return None
    try:
        value = json.loads(bytes_value.decode("utf8"), object_pairs_hook=_unique_fields,
                           parse_constant=_invalid_constant)
    except (UnicodeError, ValueError, RecursionError):
        return None
    hook = value.get("hookSpecificOutput") if type(value) is dict else None
    valid = False
    if event == "PreToolUse" and type(hook) is dict:
        valid = (_exact(value, ("hookSpecificOutput",))
                 and _exact(hook, ("hookEventName",))
                 and hook["hookEventName"] == event)
        if hook.get("permissionDecision") == "deny":
            valid = (_exact(value, ("hookSpecificOutput", "systemMessage"))
                     and _exact(hook, ("hookEventName", "permissionDecision", "permissionDecisionReason"))
                     and hook["hookEventName"] == event
                     and _nonempty(hook["permissionDecisionReason"])
                     and _nonempty(value["systemMessage"]))
    elif event == "UserPromptSubmit" and type(hook) is dict:
        valid = (_exact(value, ("hookSpecificOutput", "systemMessage"))
                 and _exact(hook, ("hookEventName", "additionalContext"))
                 and hook["hookEventName"] == event
                 and _nonempty(hook["additionalContext"])
                 and _nonempty(value["systemMessage"]))
    elif event == "PostToolUse":
        valid = _exact(value, ("systemMessage",)) and _nonempty(value["systemMessage"])
    elif event == "SessionEnd":
        valid = _exact(value, ())
    if not valid:
        return None
    try:
        normalized = (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf8")
    except UnicodeError:
        return None
    return normalized.decode("utf8") if len(normalized) <= _MAX_OUTPUT else None


def _pidfd_for(process):
    pidfd = os.pidfd_open(process.pid, 0)
    try:
        os.set_inheritable(pidfd, False)
        observed = []
        with open(f"/proc/self/fdinfo/{pidfd}", "r", encoding="ascii") as stream:
            for line in stream:
                if line.startswith("Pid:"):
                    observed.append(line.partition(":")[2].strip())
        uids = []
        with open(f"/proc/{process.pid}/status", "r", encoding="ascii") as stream:
            for line in stream:
                if line.startswith("Uid:"):
                    uids = [int(value) for value in line.partition(":")[2].split()]
        if observed != [str(process.pid)] or uids != [os.getuid()] * 4:
            raise RuntimeError("pidfd did not identify direct hook child")
        return pidfd
    except BaseException:
        os.close(pidfd)
        raise


def _exited(pidfd):
    poller = select.poll()
    poller.register(pidfd, select.POLLIN)
    return bool(poller.poll(0))


def _signal_live(pidfd, number):
    if _exited(pidfd):
        return False
    try:
        signal.pidfd_send_signal(pidfd, number, None, 0)
        return True
    except ProcessLookupError:
        return False


def _wait_pidfd(pidfd, seconds):
    poller = select.poll()
    poller.register(pidfd, select.POLLIN)
    return bool(poller.poll(max(0, int(seconds * 1000))))


def _stop(process, pidfd):
    if _signal_live(pidfd, signal.SIGTERM) and not _wait_pidfd(pidfd, _TERM_GRACE_SECONDS):
        _signal_live(pidfd, signal.SIGKILL)
        # A kernel-blocked process may exit later. The service-side invocation
        # holder retains its pidfd and generation lease across this response.
        _wait_pidfd(pidfd, _TERM_GRACE_SECONDS)
    try:
        process.wait(timeout=0)
    except subprocess.TimeoutExpired:
        pass


def _read_available(fd, chunks, length):
    while True:
        try:
            chunk = os.read(fd, min(64 * 1024, _MAX_OUTPUT + 1 - length))
        except BlockingIOError:
            return length, False, False
        if not chunk:
            return length, False, True
        chunks.append(chunk)
        length += len(chunk)
        if length > _MAX_OUTPUT:
            return length, True, False


def supervise_hook(command: list[str], event: str, *, environment=None) -> tuple[str | None, str | None]:
    """Return one normalized hook line, or one selector-safe failure code."""
    if (type(command) is not list or not command
            or any(type(part) is not str or not part or "\x00" in part for part in command)):
        raise ValueError("invalid managed hook command")
    if event not in _EVENT_DEADLINES:
        raise ValueError("invalid hook event")
    try:
        process = subprocess.Popen(command, stdin=None, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   close_fds=True, env=environment)
    except OSError:
        return None, "GUARD_UNAVAILABLE"
    pidfd = None
    try:
        try:
            pidfd = _pidfd_for(process)
        except (OSError, RuntimeError):
            # Popen owns this unreaped direct child even if pidfd access failed.
            process.kill()
            try:
                process.wait(timeout=_TERM_GRACE_SECONDS)
            except subprocess.TimeoutExpired:
                pass
            return None, "GUARD_UNAVAILABLE"
        assert process.stdout is not None
        output_fd = process.stdout.fileno()
        os.set_blocking(output_fd, False)
        poller = select.poll()
        poller.register(output_fd, select.POLLIN | select.POLLHUP | select.POLLERR)
        poller.register(pidfd, select.POLLIN)
        deadline = time.monotonic() + _EVENT_DEADLINES[event]
        chunks = []
        length = 0
        overflow = False
        exited = False
        while not exited and not overflow:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                if _exited(pidfd):
                    exited = True
                    break
                _stop(process, pidfd)
                return None, "GUARD_HOOK_TIMEOUT"
            events = poller.poll(max(1, int(remaining * 1000)))
            for descriptor, _flags in events:
                if descriptor == output_fd:
                    length, overflow, closed = _read_available(output_fd, chunks, length)
                    if closed:
                        poller.unregister(output_fd)
                elif descriptor == pidfd:
                    exited = True
            if not events and _exited(pidfd):
                exited = True
        if overflow:
            _stop(process, pidfd)
            return None, "GUARD_UNAVAILABLE"
        length, overflow, _closed = _read_available(output_fd, chunks, length)
        if overflow:
            return None, "GUARD_UNAVAILABLE"
        try:
            status = process.wait(timeout=0.1)
        except subprocess.TimeoutExpired:
            _stop(process, pidfd)
            return None, "GUARD_UNAVAILABLE"
        output = _normalize_output(b"".join(chunks), event) if status == 0 else None
        return (output, None) if output is not None else (None, "GUARD_UNAVAILABLE")
    finally:
        if pidfd is not None:
            os.close(pidfd)
        if process.stdout is not None:
            process.stdout.close()
