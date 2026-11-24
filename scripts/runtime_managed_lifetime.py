"""Durable intent for an artifact issued to a managed runtime worker."""

import json
import os
import re
import secrets
import select
import stat

_RELEASE = re.compile(r"r-(?:[a-f0-9]{40}|[a-f0-9]{64})-[a-f0-9]{64}")
_BOOTSTRAP = re.compile(r"b-[a-f0-9]{64}")


class InvocationInFlight(RuntimeError):
    """The private managed invocation inventory has outstanding evidence."""


def _check_directory(fd):
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise InvocationInFlight("managed invocation directory is invalid")


def _identity(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_mode, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def require_no_pending_invocations(directory_fd):
    """Fail closed on any record in this service-owned directory."""
    _check_directory(directory_fd)
    # A new open file description gives every scan its own directory offset.
    scan = os.open(".", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd)
    try:
        with os.scandir(scan) as entries:
            if next(entries, None) is not None:
                raise InvocationInFlight("managed invocation records are pending")
    finally:
        os.close(scan)


class ManagedInvocation:
    def __init__(self, directory_fd, peer, release_id, bootstrap_id):
        _check_directory(directory_fd)
        if (type(release_id) is not str or _RELEASE.fullmatch(release_id) is None
                or type(bootstrap_id) is not str or _BOOTSTRAP.fullmatch(bootstrap_id) is None):
            raise InvocationInFlight("invalid managed pair")
        self.name = bootstrap_id + ".i-" + secrets.token_hex(16) + ".json"
        directory = os.dup(directory_fd)
        self._directory = directory
        self._pidfd = None
        try:
            self._pidfd = peer.duplicate_pidfd()
            self._poll = select.poll()
            self._poll.register(self._pidfd, select.POLLIN)
            self._record = self._create(directory, {
                "version": 1, "peerPid": peer.pid,
                "releaseId": release_id, "bootstrapId": bootstrap_id,
            })
        except BaseException:
            self.close()
            raise

    def _create(self, directory, value):
        fd = os.open(self.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=directory)
        with os.fdopen(fd, "wb") as file:
            os.fchmod(file.fileno(), 0o600)
            file.write((json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode("utf8"))
            file.flush()
            os.fsync(file.fileno())
            identity = _identity(os.fstat(file.fileno()))
        os.fsync(directory)
        return identity

    def settle(self, timeout_ms):
        """Remove this exact intent after the original process exits."""
        if type(timeout_ms) is not int or not 0 <= timeout_ms <= 60_000:
            raise ValueError("invalid process deadline")
        if self._pidfd is None or self._directory is None:
            raise InvocationInFlight("live process evidence was closed")
        events = self._poll.poll(timeout_ms)
        if not events:
            return False
        if (len(events) != 1 or events[0][0] != self._pidfd or not events[0][1] & select.POLLIN
                or events[0][1] & (select.POLLERR | select.POLLNVAL)):
            raise InvocationInFlight("process exit was not confirmed")
        _check_directory(self._directory)
        current = os.stat(self.name, dir_fd=self._directory, follow_symlinks=False)
        if _identity(current) != self._record:
            raise InvocationInFlight("managed invocation record changed")
        os.unlink(self.name, dir_fd=self._directory)
        os.fsync(self._directory)
        self.close()
        return True

    def close(self):
        if self._pidfd is not None:
            os.close(self._pidfd)
            self._pidfd = None
        if self._directory is not None:
            os.close(self._directory)
            self._directory = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
