"""Bind service-owned v2 sessions to the processes of the managed client."""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
import errno
import fcntl
import os
from pathlib import Path
import re
import secrets
import select
import signal
import socket
import stat
import subprocess
import sys
import threading

from runtime_managed_identity import IdentityRejected, require_descendant
from runtime_managed_lifetime import require_no_pending_invocations
from runtime_managed_profile import trusted_directory
from runtime_managed_protocol import decode_message, encode_message, receive_message, send_message
from runtime_managed_transport import ManagedPeer, PeerRejected, local_socket

BINDING = re.compile(r"s-[0-9a-f]{32}:[0-9a-f]{64}")
SELECTORS = ("control", "hook", "mcp")
_RELEASE = re.compile(r"r-(?:[a-f0-9]{40}|[a-f0-9]{64})-[a-f0-9]{64}")
_BOOTSTRAP = re.compile(r"b-[a-f0-9]{64}")
_DIGEST = re.compile(r"[a-f0-9]{64}")
_SEALS = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
_MAX_ARTIFACT = 16 * 1024 * 1024
_MAX_SESSIONS = 32
_REQUEST_SECONDS = 8


def _matches(regex, value):
    return type(value) is str and regex.fullmatch(value) is not None


def require_pair(message):
    if (not _matches(_RELEASE, message.get("releaseId"))
            or not _matches(_BOOTSTRAP, message.get("bootstrapId"))):
        raise ValueError("invalid service pair")
    return message["releaseId"], message["bootstrapId"]


def require_artifact(message, descriptor, service_uid):
    if set(message) != {"op", "releaseId", "bootstrapId", "sha256", "bytes"} or message["op"] != "artifact":
        raise ValueError("invalid artifact reply")
    pair = require_pair(message)
    size = message["bytes"]
    if not _matches(_DIGEST, message["sha256"]) or type(size) is not int or not 0 < size <= _MAX_ARTIFACT:
        raise ValueError("invalid artifact metadata")
    info = os.fstat(descriptor)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != service_uid or info.st_size != size
            or fcntl.fcntl(descriptor, fcntl.F_GET_SEALS) & _SEALS != _SEALS):
        raise ValueError("artifact is not a sealed service file")
    return pair


def process_exited(pidfd):
    poller = select.poll()
    poller.register(pidfd, select.POLLIN)
    return bool(poller.poll(0))


def _reap_provider(process):
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        # This is the direct worker started for this session. Its independent
        # invocation holders keep their own leases and are never signalled here.
        process.terminate()
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


@dataclass
class _Session:
    pid: int
    pidfd: int
    process: subprocess.Popen
    channel: socket.socket
    pair: tuple[str, str]
    lock: threading.Lock = field(default_factory=threading.Lock)
    closed: bool = False

    def close(self):
        with self.lock:
            if self.closed:
                return
            self.closed = True
            self.channel.close()
            os.close(self.pidfd)
        _reap_provider(self.process)


class _Broker:
    def __init__(self, profile):
        self.profile = profile
        self.sessions = {}
        self.lock = threading.Lock()
        self.starting = 0

    def register(self, peer):
        with self.lock:
            if len(self.sessions) + self.starting >= _MAX_SESSIONS:
                raise ValueError("managed session limit")
            self.starting += 1
        channel = None
        process = None
        pidfd = None
        try:
            pidfd = peer.duplicate_pidfd()
            channel, endpoint = socket.socketpair(type=socket.SOCK_SEQPACKET)
            channel.settimeout(_REQUEST_SECONDS)
            root = self.profile.repository
            entry = self.profile.runtime / "bootstrap" / "jhw-runtime-entry"
            worker = Path(__file__).with_name("runtime_managed_service_worker.py")
            with endpoint:
                process = subprocess.Popen([
                    str(self.profile.node), str(entry), "session", "--",
                    sys.executable, "-E", "-s", "-B", str(worker), str(root), str(self.profile.node),
                ], stdin=endpoint.fileno(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    cwd=root, env={
                        "HOME": str(self.profile.home), "PATH": f"{self.profile.node.parent}:/usr/bin:/bin",
                        "LANG": "C.UTF-8",
                    })
            message, _ = receive_message(channel)
            if set(message) != {"op", "releaseId", "bootstrapId"} or message["op"] != "ready":
                raise ValueError("invalid service worker reply")
            pair = require_pair(message)
            if process_exited(pidfd):
                raise ValueError("session client exited during registration")
            binding = "s-" + secrets.token_hex(16) + ":" + secrets.token_hex(32)
            with self.lock:
                if binding in self.sessions:
                    raise ValueError("managed session ID collision")
                self.sessions[binding] = _Session(peer.pid, pidfd, process, channel, pair)
            channel = process = pidfd = None
            return {"op": "bound", "binding": binding, "releaseId": pair[0], "bootstrapId": pair[1]}
        finally:
            with self.lock:
                self.starting -= 1
            if channel is not None:
                channel.close()
            if process is not None:
                _reap_provider(process)
            if pidfd is not None:
                os.close(pidfd)

    def invoke(self, peer, binding, selector):
        with self.lock:
            session = self.sessions.get(binding)
        if session is None:
            raise ValueError("unknown managed session")
        pidfd = peer.duplicate_pidfd()
        try:
            with session.lock:
                if session.closed:
                    raise ValueError("managed session closed")
                require_descendant(root_pid=session.pid, root_pidfd=session.pidfd, worker_pid=peer.pid,
                                   worker_pidfd=pidfd, uid=self.profile.client_uid)
                descriptors = ()
                try:
                    send_message(session.channel, {"op": "issue", "selector": selector, "pid": peer.pid}, (pidfd,))
                    artifact, descriptors = receive_message(session.channel, expected_fds=(0, 1))
                    if artifact == {"op": "cancelled"} and not descriptors:
                        return
                    if (len(descriptors) != 1
                            or require_artifact(artifact, descriptors[0], self.profile.service_uid) != session.pair):
                        raise ValueError("inconsistent artifact pair")
                except (OSError, ValueError, EOFError):
                    for descriptor in descriptors:
                        os.close(descriptor)
                    # An interrupted private exchange cannot satisfy a later request.
                    session.channel.close()
                    raise
                try:
                    peer.send(encode_message(artifact), descriptors)
                finally:
                    # A caller timing out does not invalidate the synchronized worker.
                    os.close(descriptors[0])
        finally:
            os.close(pidfd)

    def handle(self, peer):
        try:
            request = decode_message(peer.receive()[0])
            if request == {"op": "session"}:
                peer.send(encode_message(self.register(peer)))
            elif (set(request) == {"op", "binding", "selector"} and request["op"] == "invoke"
                  and _matches(BINDING, request["binding"]) and request["selector"] in SELECTORS):
                self.invoke(peer, request["binding"], request["selector"])
        except (OSError, ValueError, EOFError, IdentityRejected, PeerRejected):
            # Closing the authenticated connection gives the caller a bounded
            # selector-specific failure without sending internal paths or input.
            pass

    def reap(self, *, all_sessions=False):
        with self.lock:
            closed = [binding for binding, session in self.sessions.items()
                      if all_sessions or process_exited(session.pidfd) or session.process.poll() is not None]
            sessions = [self.sessions.pop(binding) for binding in closed]
        for session in sessions:
            session.close()


def serve(profile):
    profile.require_service()
    os.umask(0o077)
    broker = _Broker(profile)
    stopping = threading.Event()
    limits = threading.BoundedSemaphore(16)

    def expire(_signal_number, _frame):
        stopping.set()

    def handle(peer):
        try:
            with peer:
                broker.handle(peer)
        finally:
            limits.release()

    for number in (signal.SIGINT, signal.SIGTERM):
        signal.signal(number, expire)

    parent = trusted_directory(profile.socket.parent, profile.service_uid)
    records = trusted_directory(profile.invocations, profile.service_uid, private=True)
    lock = None
    identity = None
    try:
        lock = os.open("managed-service.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                       0o600, dir_fd=parent)
        info = os.fstat(lock)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != profile.service_uid
                or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600):
            raise ValueError("invalid managed service lock")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        require_no_pending_invocations(records)
        _remove_closed_socket(profile, parent)
        with local_socket() as listener:
            listener.bind(str(profile.socket))
            info = os.stat(profile.socket.name, dir_fd=parent, follow_symlinks=False)
            identity = (info.st_dev, info.st_ino)
            os.chmod(profile.socket.name, 0o666, dir_fd=parent, follow_symlinks=False)
            listener.listen(16)
            listener.settimeout(0.25)
            with ThreadPoolExecutor(max_workers=8) as executor:
                while not stopping.is_set():
                    broker.reap()
                    try:
                        connection, _ = listener.accept()
                    except TimeoutError:
                        continue
                    try:
                        connection.settimeout(_REQUEST_SECONDS)
                        peer = ManagedPeer(connection, profile.client_uid)
                    except (OSError, PeerRejected):
                        connection.close()
                        continue
                    if not limits.acquire(blocking=False):
                        peer.close()
                        continue
                    executor.submit(handle, peer)
    finally:
        try:
            broker.reap(all_sessions=True)
            if identity is not None:
                _unlink_socket(profile, parent, identity)
        finally:
            if lock is not None:
                os.close(lock)
            os.close(records)
            os.close(parent)


def _unlink_socket(profile, parent, identity):
    try:
        info = os.stat(profile.socket.name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return
    if (info.st_dev, info.st_ino) != identity or not stat.S_ISSOCK(info.st_mode):
        raise ValueError("managed socket identity changed")
    os.unlink(profile.socket.name, dir_fd=parent)


def _remove_closed_socket(profile, parent):
    try:
        info = os.stat(profile.socket.name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != profile.service_uid or info.st_nlink != 1:
        raise ValueError("invalid existing managed socket")
    with local_socket() as probe:
        probe.settimeout(0.25)
        try:
            probe.connect(str(profile.socket))
        except OSError as error:
            if error.errno != errno.ECONNREFUSED:
                raise
        else:
            raise ValueError("managed socket already accepts connections")
    _unlink_socket(profile, parent, (info.st_dev, info.st_ino))
