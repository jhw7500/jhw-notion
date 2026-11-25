"""Bounded messages for the public and private managed runtime sockets."""

import array
import json
import os
import socket

from runtime_managed_transport import MAX_DESCRIPTORS, MAX_PACKET

_FD_SIZE = array.array("i").itemsize


def _unique_fields(pairs):
    fields = dict(pairs)
    if len(fields) != len(pairs):
        raise ValueError("duplicate message field")
    return fields


def _invalid_constant(_):
    raise ValueError("non-finite message value")


def encode_message(value):
    if type(value) is not dict:
        raise ValueError("expected message object")
    packet = json.dumps(value, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(packet) > MAX_PACKET:
        raise ValueError("message too large")
    return packet


def decode_message(packet):
    if not 0 < len(packet) <= MAX_PACKET:
        raise ValueError("invalid message length")
    try:
        value = json.loads(packet.decode("utf-8"), object_pairs_hook=_unique_fields,
                           parse_constant=_invalid_constant)
    except RecursionError as error:
        raise ValueError("message nesting is too deep") from error
    if type(value) is not dict:
        raise ValueError("expected message object")
    return value


def send_message(connection, value, fds=()):
    if len(fds) > MAX_DESCRIPTORS:
        raise ValueError("too many message descriptors")
    packet = encode_message(value)
    rights = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", fds))] if fds else []
    if connection.sendmsg([packet], rights) != len(packet):
        raise OSError("incomplete message")


def receive_message(connection, expected_fds: int | tuple[int, ...] = 0):
    """Receive one private packet. The caller owns its returned descriptors."""
    counts = (expected_fds,) if isinstance(expected_fds, int) else expected_fds
    if not counts or any(type(count) is not int or not 0 <= count <= MAX_DESCRIPTORS for count in counts):
        raise ValueError("invalid message descriptor count")
    received = array.array("i")
    packet, ancillary, flags, _ = connection.recvmsg(
        MAX_PACKET + 1, socket.CMSG_SPACE(MAX_DESCRIPTORS * _FD_SIZE),
        socket.MSG_CMSG_CLOEXEC,
    )
    valid = True
    for level, kind, data in ancillary:
        if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
            whole = len(data) // _FD_SIZE * _FD_SIZE
            received.frombytes(data[:whole])
            valid = valid and whole == len(data)
        else:
            valid = False
    try:
        if not packet and not ancillary and not flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC):
            raise EOFError("private connection closed")
        if not valid or flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC) or len(received) not in counts:
            raise ValueError("invalid private message shape")
        return decode_message(packet), tuple(received)
    except (EOFError, ValueError):
        for fd in received:
            os.close(fd)
        raise
