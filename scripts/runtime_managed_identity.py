"""Fail-closed ancestry verification for managed runtime peers."""

from contextlib import ExitStack
from dataclasses import dataclass
import os
import re
import select
import stat
from typing import NoReturn


_MAX_ANCESTORS = 256
_MAX_RECORD_BYTES = 64 * 1024
_PID_MAX = 0x7FFFFFFF
_UID_MAX = 0xFFFFFFFE
_UID_LINE = re.compile(rb"^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$", re.MULTILINE)
_PIDFD_PID_LINE = re.compile(rb"^Pid:\s+(-?\d+)\s*$", re.MULTILINE)


class IdentityRejected(RuntimeError):
    """The supplied kernel process references do not prove one user tree."""


@dataclass(frozen=True)
class _ProcessIdentity:
    pid: int
    parent_pid: int
    start_time: bytes
    directory_identity: tuple[int, int, int, int]


@dataclass(frozen=True)
class _AnchoredProcess:
    directory_fd: int
    observed: _ProcessIdentity


def _reject() -> NoReturn:
    raise IdentityRejected("managed process identity could not be verified")


def _integer(value, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        _reject()
    return value


def _read_bounded(fd):
    chunks = []
    remaining = _MAX_RECORD_BYTES + 1
    while remaining:
        chunk = os.read(fd, min(8192, remaining))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    value = b"".join(chunks)
    if len(value) > _MAX_RECORD_BYTES:
        _reject()
    return value


def _read_record(directory_fd, name, expected_uid):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    fd = os.open(name, flags, dir_fd=directory_fd)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != expected_uid:
            _reject()
        value = _read_bounded(fd)
        after = os.fstat(fd)
        before_identity = (before.st_dev, before.st_ino, before.st_uid, before.st_mode)
        after_identity = (after.st_dev, after.st_ino, after.st_uid, after.st_mode)
        if before_identity != after_identity:
            _reject()
        return value
    finally:
        os.close(fd)


def _directory_identity(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_mode)


def _observe_process(directory_fd, pid, uid):
    directory = os.fstat(directory_fd)
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != uid:
        _reject()

    raw_stat = _read_record(directory_fd, "stat", uid)
    prefix = str(pid).encode("ascii") + b" ("
    command_end = raw_stat.rfind(b")")
    if not raw_stat.startswith(prefix) or command_end < len(prefix):
        _reject()
    fields = raw_stat[command_end + 1 :].strip().split()
    if len(fields) < 20 or fields[0] in (b"Z", b"X", b"x"):
        _reject()
    try:
        parent_pid = int(fields[1])
        start_time = fields[19]
    except (ValueError, IndexError):
        _reject()
    if not 0 <= parent_pid <= _PID_MAX or not start_time.isdigit():
        _reject()

    raw_status = _read_record(directory_fd, "status", uid)
    uid_lines = _UID_LINE.findall(raw_status)
    if len(uid_lines) != 1:
        _reject()
    try:
        observed_uids = tuple(int(value) for value in uid_lines[0])
    except ValueError:
        _reject()
    if observed_uids != (uid, uid, uid, uid):
        _reject()
    return _ProcessIdentity(pid, parent_pid, start_time, _directory_identity(directory))


def _pidfd_pid(pidfd):
    _integer(pidfd, 0, 0x7FFFFFFF)
    poller = select.poll()
    poller.register(pidfd, select.POLLIN)
    if poller.poll(0):
        _reject()
    if os.readlink(f"/proc/self/fd/{pidfd}") != "anon_inode:[pidfd]":
        _reject()
    fdinfo_directory = os.open(
        "/proc/self/fdinfo", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    )
    try:
        value = _read_record(fdinfo_directory, str(pidfd), os.getuid())
    finally:
        os.close(fdinfo_directory)
    matches = _PIDFD_PID_LINE.findall(value)
    if len(matches) != 1:
        _reject()
    try:
        pid = int(matches[0])
    except ValueError:
        _reject()
    if not 1 <= pid <= _PID_MAX:
        _reject()
    return pid


def _require_pidfd(pidfd, expected_pid):
    if _pidfd_pid(pidfd) != expected_pid:
        _reject()


def _verify_anchor(proc_fd, anchored, uid):
    named = os.stat(str(anchored.observed.pid), dir_fd=proc_fd, follow_symlinks=False)
    if _directory_identity(named) != anchored.observed.directory_identity:
        _reject()
    if (
        _observe_process(anchored.directory_fd, anchored.observed.pid, uid)
        != anchored.observed
    ):
        _reject()


def require_descendant(
    *, root_pid: int, root_pidfd: int, worker_pid: int, worker_pidfd: int, uid: int
) -> None:
    """Require a live worker to be a strict descendant of one live root."""
    root_pid = _integer(root_pid, 1, _PID_MAX)
    worker_pid = _integer(worker_pid, 1, _PID_MAX)
    uid = _integer(uid, 0, _UID_MAX)
    if root_pid == worker_pid:
        _reject()

    try:
        _require_pidfd(root_pidfd, root_pid)
        _require_pidfd(worker_pidfd, worker_pid)
        proc_fd = os.open("/proc", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        with ExitStack() as stack:
            stack.callback(os.close, proc_fd)
            anchored = []
            seen = set()
            current_pid = worker_pid
            for _ in range(_MAX_ANCESTORS):
                if current_pid in seen:
                    _reject()
                seen.add(current_pid)
                directory_fd = os.open(
                    str(current_pid),
                    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                    dir_fd=proc_fd,
                )
                stack.callback(os.close, directory_fd)
                observed = _observe_process(directory_fd, current_pid, uid)
                anchored.append(_AnchoredProcess(directory_fd, observed))
                if current_pid == root_pid:
                    break
                if observed.parent_pid == 0 or observed.parent_pid == current_pid:
                    _reject()
                current_pid = observed.parent_pid
            else:
                _reject()
            if current_pid != root_pid:
                _reject()
            for process in anchored:
                _verify_anchor(proc_fd, process, uid)
            _require_pidfd(root_pidfd, root_pid)
            _require_pidfd(worker_pidfd, worker_pid)
    except IdentityRejected:
        raise
    except (OSError, OverflowError, ValueError):
        raise IdentityRejected(
            "managed process identity could not be verified"
        ) from None
