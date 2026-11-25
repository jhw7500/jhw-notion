#!/usr/bin/python3
"""Issue verified runtime artifacts from one v2 session-bound service worker."""

import fcntl
import hashlib
import json
import os
import re
import select
import socket
import stat
import subprocess
import sys
import threading
import time

from runtime_managed_lifetime import ManagedInvocation


MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
_MAX_FRAME_BYTES = MAX_ARTIFACT_BYTES + 4096
_PROBE_TIMEOUT_SECONDS = 8
_RELEASE = re.compile(r"r-(?:[a-f0-9]{40}|[a-f0-9]{64})-[a-f0-9]{64}")
_BOOTSTRAP = re.compile(r"b-[a-f0-9]{64}")
_SESSION = re.compile(r"s-[a-f0-9]{32}")
_DIGEST = re.compile(r"[a-f0-9]{64}")
_SELECTORS = frozenset(("mcp", "control", "hook"))
_REQUIRED_SEALS = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL


class WorkerRejected(RuntimeError):
    """A service boundary or internal response failed closed."""


def _exact(value, keys):
    return type(value) is dict and set(value) == set(keys)


def _identity(info):
    return info.st_dev, info.st_ino, info.st_uid, info.st_mode, info.st_nlink


class PidfdPeer:
    """Narrow ManagedInvocation peer adapter for one broker-supplied pidfd."""

    def __init__(self, pidfd, pid):
        if type(pidfd) is not int or pidfd < 0 or type(pid) is not int or pid <= 0:
            raise WorkerRejected("invalid pidfd request")
        try:
            if os.get_inheritable(pidfd) or os.readlink(f"/proc/self/fd/{pidfd}") != "anon_inode:[pidfd]":
                raise WorkerRejected("invalid pidfd")
            fields = {}
            with open(f"/proc/self/fdinfo/{pidfd}", "r", encoding="ascii") as stream:
                for line in stream:
                    name, separator, value = line.partition(":")
                    if separator and name in ("Pid", "NSpid"):
                        if name in fields:
                            raise WorkerRejected("ambiguous pidfd")
                        fields[name] = value.strip()
            if fields.get("Pid") != str(pid):
                raise WorkerRejected("pidfd does not identify requested pid")
            poller = select.poll()
            poller.register(pidfd, select.POLLIN)
            if poller.poll(0):
                raise WorkerRejected("requested process already exited")
        except (OSError, UnicodeError, ValueError) as error:
            raise WorkerRejected("pidfd evidence unavailable") from error
        self.pid = pid
        self._pidfd = pidfd

    def duplicate_pidfd(self):
        duplicate = os.dup(self._pidfd)
        os.set_inheritable(duplicate, False)
        return duplicate


def create_sealed_artifact(bytes_value):
    if type(bytes_value) is not bytes or len(bytes_value) > MAX_ARTIFACT_BYTES:
        raise WorkerRejected("artifact size is invalid")
    fd = os.memfd_create("jhw-runtime-artifact", os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
    try:
        offset = 0
        while offset < len(bytes_value):
            offset += os.write(fd, bytes_value[offset:])
        os.lseek(fd, 0, os.SEEK_SET)
        fcntl.fcntl(fd, fcntl.F_ADD_SEALS, _REQUIRED_SEALS)
        if fcntl.fcntl(fd, fcntl.F_GET_SEALS) & _REQUIRED_SEALS != _REQUIRED_SEALS:
            raise WorkerRejected("artifact sealing failed")
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size != len(bytes_value):
            raise WorkerRejected("artifact identity changed")
        return fd
    except BaseException:
        os.close(fd)
        raise


def validate_lease_fd(fd, path_value):
    path_value = os.fspath(path_value)
    try:
        inherited = os.fstat(fd)
        named = os.stat(path_value, follow_symlinks=False)
        if (not stat.S_ISREG(inherited.st_mode) or not stat.S_ISREG(named.st_mode)
                or _identity(inherited) != _identity(named) or inherited.st_uid != os.getuid()
                or inherited.st_nlink != 1 or stat.S_IMODE(inherited.st_mode) != 0o600):
            raise WorkerRejected("runtime lease identity is invalid")
        probe = os.open(path_value, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        try:
            try:
                fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                pass
            else:
                fcntl.flock(probe, fcntl.LOCK_UN)
                raise WorkerRejected("runtime lease is not held")
        finally:
            os.close(probe)
    except OSError as error:
        raise WorkerRejected("runtime lease is unavailable") from error


def _close_unretained_fds(retained):
    retained = set(retained)
    for encoded in os.listdir("/proc/self/fd"):
        try:
            fd = int(encoded)
        except ValueError:
            continue
        if fd not in retained:
            try:
                os.close(fd)
            except OSError:
                pass


def start_lifetime_holder(invocation, retained_fds=(3, 6, 7)):
    if threading.active_count() != 1:
        raise WorkerRejected("worker must be single-threaded before fork")
    pid = os.fork()
    if pid != 0:
        return pid
    try:
        private = (invocation._directory, invocation._pidfd)  # pylint: disable=protected-access
        _close_unretained_fds((*retained_fds, *private))
        while not invocation.settle(60_000):
            pass
    except BaseException:
        os._exit(1)
    os._exit(0)


def _safe_checkout(value):
    if type(value) is not str or not os.path.isabs(value) or "\x00" in value:
        raise WorkerRejected("service checkout is invalid")
    canonical = os.path.realpath(value)
    info = os.stat(canonical, follow_symlinks=False)
    if (canonical != value or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) & 0o022):
        raise WorkerRejected("service checkout is untrusted")
    return canonical


def _safe_node(value):
    if type(value) is not str or not os.path.isabs(value) or "\x00" in value:
        raise WorkerRejected("node executable is invalid")
    info = os.stat(value)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid not in (0, os.getuid())
            or stat.S_IMODE(info.st_mode) & 0o022 or not os.access(value, os.X_OK)):
        raise WorkerRejected("node executable is untrusted")
    return value


def _probe_environment():
    environment = {"LANG": os.environ.get("LANG", "C.UTF-8")}
    home = os.environ.get("HOME")
    token = os.environ.get("JHW_RUNTIME_SESSION_BINDING")
    if home is None or not os.path.isabs(home) or token is None:
        raise WorkerRejected("session environment is unavailable")
    environment["HOME"] = home
    environment["JHW_RUNTIME_SESSION_BINDING"] = token
    return environment


def _collect_probe(process):
    assert process.stdout is not None
    fd = process.stdout.fileno()
    os.set_blocking(fd, False)
    poller = select.poll()
    poller.register(fd, select.POLLIN | select.POLLHUP | select.POLLERR)
    deadline = time.monotonic() + _PROBE_TIMEOUT_SECONDS
    chunks = []
    length = 0
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise WorkerRejected("runtime probe timed out")
            events = poller.poll(max(1, int(remaining * 1000)))
            if not events:
                continue
            try:
                chunk = os.read(fd, min(64 * 1024, _MAX_FRAME_BYTES + 1 - length))
            except BlockingIOError:
                continue
            if not chunk:
                break
            chunks.append(chunk)
            length += len(chunk)
            if length > _MAX_FRAME_BYTES:
                raise WorkerRejected("runtime probe exceeded artifact limit")
        remaining = deadline - time.monotonic()
        if remaining <= 0 or process.wait(timeout=remaining) != 0:
            raise WorkerRejected("runtime probe failed")
        return b"".join(chunks)
    except BaseException:
        process.kill()
        process.wait()
        raise


def _run_probe(node, checkout, mode, selector=None):
    probe = os.path.join(os.path.dirname(__file__), "runtime-managed-worker-probe.mjs")
    arguments = [node, probe, mode, checkout]
    if selector is not None:
        arguments.append(selector)
    process = subprocess.Popen(arguments, cwd=checkout, env=_probe_environment(), stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, close_fds=True,
                               pass_fds=(3, 6, 7))
    frame = _collect_probe(process)
    header_bytes, separator, artifact = frame.partition(b"\n")
    if not separator or len(header_bytes) > 4096:
        raise WorkerRejected("runtime probe frame is invalid")
    try:
        header = json.loads(header_bytes.decode("utf8"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise WorkerRejected("runtime probe metadata is invalid") from error
    base = (type(header.get("version")) is int and header.get("version") == 1
            and type(header.get("releaseId")) is str and _RELEASE.fullmatch(header["releaseId"])
            and type(header.get("bootstrapId")) is str and _BOOTSTRAP.fullmatch(header["bootstrapId"])
            and type(header.get("sessionId")) is str and _SESSION.fullmatch(header["sessionId"]))
    if not base:
        raise WorkerRejected("runtime probe pair is invalid")
    if mode == "info":
        if not _exact(header, ("version", "releaseId", "bootstrapId", "sessionId")) or artifact:
            raise WorkerRejected("runtime probe info is invalid")
    else:
        if (not _exact(header, ("version", "releaseId", "bootstrapId", "sessionId", "sha256", "bytes"))
                or type(header["bytes"]) is not int or not 0 <= header["bytes"] <= MAX_ARTIFACT_BYTES
                or header["bytes"] != len(artifact) or type(header["sha256"]) is not str
                or _DIGEST.fullmatch(header["sha256"]) is None
                or hashlib.sha256(artifact).hexdigest() != header["sha256"]):
            raise WorkerRejected("runtime probe artifact is invalid")
    return header, artifact


def _open_invocation_directory(checkout):
    directory = os.path.join(checkout, ".jhw-runtime", "v2", "managed-invocations")
    fd = None
    try:
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise WorkerRejected("managed invocation directory is invalid")
        return fd
    except BaseException:
        if fd is not None:
            os.close(fd)
        raise


def _validate_runtime_leases(checkout, pair):
    validate_lease_fd(3, os.path.join(checkout, ".jhw-runtime", "admission.lock"))
    validate_lease_fd(6, os.path.join(checkout, ".jhw-runtime", "v2", "sessions", pair["sessionId"], "lease"))
    validate_lease_fd(7, os.path.join(checkout, ".jhw-runtime", "v2", "bootstraps", pair["bootstrapId"], "lease"))


def _channel_from_stdin():
    duplicate = os.dup(0)
    os.close(0)
    channel = socket.socket(fileno=duplicate)
    if (channel.family != socket.AF_UNIX
            or channel.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) != socket.SOCK_SEQPACKET):
        channel.close()
        raise WorkerRejected("private seqpacket channel required")
    channel.getpeername()
    return channel


def serve(checkout, node):
    from runtime_managed_protocol import receive_message, send_message

    checkout = _safe_checkout(checkout)
    node = _safe_node(node)
    records_fd = _open_invocation_directory(checkout)
    channel = _channel_from_stdin()
    artifacts = {}
    try:
        pair, artifact = _run_probe(node, checkout, "info")
        if artifact:
            raise WorkerRejected("unexpected info artifact")
        _validate_runtime_leases(checkout, pair)
        send_message(channel, {"op": "ready", "releaseId": pair["releaseId"], "bootstrapId": pair["bootstrapId"]})
        holders = set()
        while True:
            for holder in tuple(holders):
                if os.waitpid(holder, os.WNOHANG)[0] == holder:
                    holders.remove(holder)
            request, descriptors = receive_message(channel, expected_fds=1)
            pidfd = descriptors[0]
            invocation = None
            try:
                if (not _exact(request, ("op", "selector", "pid")) or request.get("op") != "issue"
                        or request.get("selector") not in _SELECTORS or type(request.get("pid")) is not int
                        or request["pid"] <= 0):
                    raise WorkerRejected("artifact request is invalid")
                try:
                    peer = PidfdPeer(pidfd, request["pid"])
                except WorkerRejected:
                    send_message(channel, {"op": "cancelled"})
                    continue
                selector = request["selector"]
                if selector not in artifacts:
                    current, bytes_value = _run_probe(node, checkout, "artifact", selector)
                    if any(current[name] != pair[name] for name in ("releaseId", "bootstrapId", "sessionId")):
                        raise WorkerRejected("runtime pair changed")
                    artifacts[selector] = (current, create_sealed_artifact(bytes_value))
                current, memfd = artifacts[selector]
                _validate_runtime_leases(checkout, pair)
                try:
                    # The first verification may include a cold bundle load.
                    peer = PidfdPeer(pidfd, request["pid"])
                except WorkerRejected:
                    send_message(channel, {"op": "cancelled"})
                    continue
                invocation = ManagedInvocation(records_fd, peer, pair["releaseId"], pair["bootstrapId"])
                holders.add(start_lifetime_holder(invocation))
                invocation.close()
                invocation = None
                send_message(channel, {"op": "artifact", "releaseId": pair["releaseId"],
                                       "bootstrapId": pair["bootstrapId"], "sha256": current["sha256"],
                                       "bytes": current["bytes"]}, fds=(memfd,))
            finally:
                if invocation is not None:
                    invocation.close()
                os.close(pidfd)
    finally:
        for _, descriptor in artifacts.values():
            os.close(descriptor)
        channel.close()
        os.close(records_fd)


def main():
    if len(sys.argv) != 3:
        return 1
    try:
        serve(sys.argv[1], sys.argv[2])
    except BaseException:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
