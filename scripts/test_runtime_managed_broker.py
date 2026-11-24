import os
import socket
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from runtime_managed_broker import _Broker, _Session
from runtime_managed_protocol import send_message
from runtime_managed_service_worker import create_sealed_artifact
from runtime_managed_transport import PeerRejected


class ManagedCancellationTests(unittest.TestCase):
    def test_cancelled_caller_does_not_close_the_session_provider(self):
        broker = _Broker(SimpleNamespace(client_uid=os.getuid(), service_uid=os.getuid()))
        channel, worker = socket.socketpair(type=socket.SOCK_SEQPACKET)
        with channel, worker:
            release = "r-" + "a" * 40 + "-" + "b" * 64
            bootstrap = "b-" + "c" * 64
            broker.sessions["binding"] = _Session(1, 2, Mock(), channel, (release, bootstrap))
            descriptor = create_sealed_artifact(b"x")
            reply = {"op": "artifact", "releaseId": release, "bootstrapId": bootstrap,
                     "sha256": "d" * 64, "bytes": 1}
            peer = Mock(pid=5)
            peer.duplicate_pidfd.side_effect = lambda: os.open("/dev/null", os.O_RDONLY)
            peer.send.side_effect = [PeerRejected("caller exited"), None]
            try:
                with patch("runtime_managed_broker.require_descendant"):
                    send_message(worker, reply, (descriptor,))
                    with self.assertRaises(PeerRejected):
                        broker.invoke(peer, "binding", "hook")
                    send_message(worker, {"op": "cancelled"})
                    broker.invoke(peer, "binding", "control")
                    send_message(worker, reply, (descriptor,))
                    broker.invoke(peer, "binding", "control")
                self.assertEqual(peer.send.call_count, 2)
            finally:
                os.close(descriptor)
