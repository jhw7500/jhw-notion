import array
import os
import socket
import unittest

from runtime_managed_protocol import decode_message, receive_message, send_message


class ManagedProtocolTests(unittest.TestCase):
    def test_private_packet_transfers_one_close_on_exec_descriptor(self):
        sender, receiver = socket.socketpair(type=socket.SOCK_SEQPACKET)
        with sender, receiver, open('/dev/null', 'rb') as handle:
            send_message(sender, {"op": "issue"}, (handle.fileno(),))
            value, (descriptor,) = receive_message(receiver, expected_fds=1)
            try:
                self.assertEqual(value, {"op": "issue"})
                self.assertFalse(os.get_inheritable(descriptor))
            finally:
                os.close(descriptor)

    def test_malformed_json_is_rejected(self):
        for packet in (b'{"op":"a","op":"b"}', b'{"value":NaN}', b'[]', b'\xff'):
            with self.subTest(packet=packet), self.assertRaises(ValueError):
                decode_message(packet)

    def test_unexpected_rights_are_closed(self):
        sender, receiver = socket.socketpair(type=socket.SOCK_SEQPACKET)
        with sender, receiver:
            with open('/dev/null', 'rb') as handle:
                before = len(os.listdir('/proc/self/fd'))
                sender.sendmsg([b'{"op":"ready"}'], [
                    (socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', [handle.fileno()])),
                ])
                with self.assertRaises(ValueError):
                    receive_message(receiver)
                self.assertEqual(len(os.listdir('/proc/self/fd')), before)
