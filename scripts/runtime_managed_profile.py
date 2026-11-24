"""Read the administrator-provisioned profile for a managed runtime."""

from dataclasses import dataclass
import os
from pathlib import Path
import stat

from runtime_managed_protocol import decode_message
from runtime_managed_transport import MAX_PACKET

_DIRECTORY = os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


def _absolute_path(value):
    if (type(value) is not str or not value.startswith("/") or "//" in value
            or any(part in ("", ".", "..") for part in value[1:].split("/"))
            or any(ord(character) < 32 for character in value)):
        raise ValueError("invalid absolute profile path")
    return Path(value)


def trusted_directory(directory, uid=0, *, private=False):
    """Open a path whose components can be changed only by root or this UID."""
    parent = os.open("/", _DIRECTORY)
    try:
        current = Path("/")
        for name in directory.parts[1:]:
            current /= name
            child = os.open(name, _DIRECTORY, dir_fd=parent)
            os.close(parent)
            parent = child
            info = os.fstat(parent)
            sticky_tmp = current == Path("/tmp") and info.st_uid == 0 and info.st_mode & stat.S_ISVTX
            if info.st_uid not in (0, uid) or (info.st_mode & 0o022 and not sticky_tmp):
                raise ValueError("untrusted profile directory")
        info = os.fstat(parent)
        if info.st_uid != uid or (private and stat.S_IMODE(info.st_mode) != 0o700):
            raise ValueError("unexpected profile directory owner or mode")
        return os.dup(parent)
    finally:
        os.close(parent)


def _root_file(file, *, executable=False):
    parent = trusted_directory(file.parent)
    try:
        flags = os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC
        fd = os.open(file.name, flags, dir_fd=parent)
    finally:
        os.close(parent)
    info = os.fstat(fd)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o7022
            or (executable and not info.st_mode & stat.S_IXOTH)
            or (not executable and info.st_nlink != 1)):
        os.close(fd)
        raise ValueError("untrusted profile file")
    return fd


def require_protected_programs(directory):
    os.close(trusted_directory(directory))
    for name in (
        "runtime_managed.py", "runtime_managed_profile.py", "runtime_managed_protocol.py",
        "runtime_managed_broker.py", "runtime_managed_identity.py", "runtime_managed_hook.py",
        "runtime_managed_lifetime.py", "runtime_managed_service_worker.py", "runtime_managed_transport.py",
        "runtime-managed-invocation.cjs", "runtime-managed-worker-probe.mjs",
        "runtime-managed-artifact.mjs", "runtime-managed-scope.mjs", "runtime-managed-writer.mjs",
        "runtime-deploy.mjs", "runtime-entry.mjs", "runtime-guard.mjs", "runtime-prune.mjs",
        "runtime-safety.mjs", "runtime-store.mjs",
    ):
        os.close(_root_file(directory / name))


@dataclass(frozen=True)
class ManagedProfile:
    path: Path
    service_uid: int
    client_uid: int
    repository: Path
    home: Path
    socket: Path
    node: Path

    @property
    def runtime(self):
        return self.repository / ".jhw-runtime"

    @property
    def invocations(self):
        return self.runtime / "v2" / "managed-invocations"

    def require_service(self):
        if os.getresuid() != (self.service_uid,) * 3:
            raise ValueError("expected dedicated service UID")
        for directory in (self.repository, self.home, self.socket.parent):
            os.close(trusted_directory(directory, self.service_uid))
        for directory in (self.runtime, self.runtime / "v2", self.invocations):
            os.close(trusted_directory(directory, self.service_uid, private=True))

    def require_client(self):
        if os.getresuid() != (self.client_uid,) * 3:
            raise ValueError("unexpected managed client UID")
        os.close(trusted_directory(self.socket.parent, self.service_uid))

    def open_descriptor(self):
        return _root_file(self.path)


def load_profile(path):
    config = _absolute_path(path)
    fd = _root_file(config)
    with os.fdopen(fd, "rb") as source:
        before = os.fstat(source.fileno())
        value = decode_message(source.read(MAX_PACKET + 1))
        after = os.fstat(source.fileno())
    if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
            after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        raise ValueError("profile changed during read")
    if (set(value) != {"version", "serviceUid", "clientUid", "repositoryRoot", "serviceHome", "socket", "node"}
            or type(value["version"]) is not int or value["version"] != 1):
        raise ValueError("invalid managed profile schema")
    service_uid, client_uid = value["serviceUid"], value["clientUid"]
    if (any(type(uid) is not int or not 0 < uid < 2**32 - 1 for uid in (service_uid, client_uid))
            or service_uid == client_uid):
        raise ValueError("managed profile requires distinct nonroot UIDs")
    repository, home, socket, node = map(_absolute_path, (
        value["repositoryRoot"], value["serviceHome"], value["socket"], value["node"],
    ))
    if len(os.fsencode(socket)) >= 108 or socket.is_relative_to(repository / ".jhw-runtime"):
        raise ValueError("invalid managed socket path")
    os.close(_root_file(node, executable=True))
    return ManagedProfile(config, service_uid, client_uid, repository, home, socket, node)
