"""Linux process-bound transport for the opt-in runtime service."""

import array
import os
import select
import socket
import struct

MAX_PACKET = 4096
MAX_DESCRIPTORS = 4
_CREDENTIALS = struct.Struct("=iII")
# Linux UAPI for Python builds that predate the named socket option.
_SO_PASSPIDFD = getattr(socket, "SO_PASSPIDFD", 76)
_SO_PEERPIDFD = getattr(socket, "SO_PEERPIDFD", 77)
_FD_SIZE = array.array("i").itemsize
_ANCILLARY_SIZE = socket.CMSG_SPACE(_CREDENTIALS.size) + socket.CMSG_SPACE(MAX_DESCRIPTORS * _FD_SIZE)


class PeerRejected(RuntimeError):
    """The connection or a packet lacked its expected process identity."""


def local_socket():
    """Enable per-packet credentials before connect or listen."""
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    try:
        connection.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
        return connection
    except OSError:
        connection.close()
        raise


class ManagedPeer:
    def __init__(self, connection, expected_uid):
        self._connection = connection
        self._pidfd = None
        try:
            if (connection.family != socket.AF_UNIX
                    or connection.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) != socket.SOCK_SEQPACKET
                    or connection.getsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED) != 1
                    or connection.getsockopt(socket.SOL_SOCKET, _SO_PASSPIDFD) != 0):
                raise PeerRejected("managed socket required")
            raw = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, _CREDENTIALS.size)
            self._identity = _CREDENTIALS.unpack(raw)
            pid, uid, _ = self._identity
            if pid <= 0 or type(expected_uid) is not int or uid != expected_uid:
                raise PeerRejected("unexpected peer")
            self._pidfd = connection.getsockopt(socket.SOL_SOCKET, _SO_PEERPIDFD)
            self._poll = select.poll()
            self._poll.register(self._pidfd, select.POLLIN)
            self._live_pidfd()
        except OSError as error:
            self.close()
            raise PeerRejected("kernel peer identity unavailable") from error
        except PeerRejected:
            self.close()
            raise

    @property
    def pid(self):
        return self._identity[0]

    def _live_pidfd(self):
        pidfd = self._pidfd
        if pidfd is None or self._poll.poll(0):
            raise PeerRejected("peer has exited")
        return pidfd

    def duplicate_pidfd(self):
        """Keep the process identity observable after the connection closes."""
        return os.dup(self._live_pidfd())

    def receive(self, expected_descriptors=0):
        """Receive one packet and transfer ownership of its returned FDs."""
        if type(expected_descriptors) is not int or not 0 <= expected_descriptors <= MAX_DESCRIPTORS:
            raise ValueError("invalid descriptor count")
        received = array.array("i")
        credentials = []
        valid = True
        try:
            self._live_pidfd()
            packet, ancillary, flags, _ = self._connection.recvmsg(
                MAX_PACKET + 1, _ANCILLARY_SIZE, socket.MSG_CMSG_CLOEXEC)
            for level, kind, data in ancillary:
                if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                    whole = len(data) // _FD_SIZE * _FD_SIZE
                    received.frombytes(data[:whole])
                    valid = valid and whole == len(data)
                elif level == socket.SOL_SOCKET and kind == socket.SCM_CREDENTIALS:
                    credentials.append(data)
                else:
                    valid = False
            self._live_pidfd()
            if (not valid or flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC)
                    or not 0 < len(packet) <= MAX_PACKET
                    or credentials != [_CREDENTIALS.pack(*self._identity)]
                    or len(received) != expected_descriptors):
                raise PeerRejected("packet identity or shape is invalid")
            return packet, tuple(received)
        except (OSError, PeerRejected):
            for fd in received:
                os.close(fd)
            self.close()
            raise

    def send(self, packet, descriptors=()):
        if type(packet) is not bytes or not 0 < len(packet) <= MAX_PACKET:
            raise ValueError("invalid packet length")
        if len(descriptors) > MAX_DESCRIPTORS:
            raise ValueError("too many descriptors")
        rights = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", descriptors))] if descriptors else []
        try:
            self._live_pidfd()
            if self._connection.sendmsg([packet], rights) != len(packet):
                raise PeerRejected("incomplete packet")
        except (OSError, PeerRejected):
            self.close()
            raise

    def close(self):
        self._connection.close()
        if self._pidfd is not None:
            os.close(self._pidfd)
            self._pidfd = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
