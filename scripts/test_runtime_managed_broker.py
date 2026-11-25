import os
import socket
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from runtime_managed_broker import _Broker, _Session
from runtime_managed_identity import IdentityRejected
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


class ManagedNotionBindingTests(unittest.TestCase):
    def setUp(self):
        self.profile = SimpleNamespace(client_uid=os.getuid(), service_uid=os.getuid())
        self.notion = object()
        self.broker = _Broker(self.profile, self.notion)
        channel, endpoint = socket.socketpair()
        self.addCleanup(endpoint.close)
        self.addCleanup(channel.close)
        self.root_fd = os.open("/dev/null", os.O_RDONLY)
        self.caller_fd = os.open("/dev/null", os.O_RDONLY)
        self.addCleanup(os.close, self.root_fd)
        self.addCleanup(os.close, self.caller_fd)
        process = Mock()
        process.poll.return_value = None
        self.session = _Session(17, self.root_fd, process, channel, ("release", "bootstrap"))
        self.session.notion_callers[22] = ("control", self.caller_fd)
        self.broker.sessions["session"] = self.session
        self.reader = Mock(pid=29)
        self.reader.duplicate_pidfd.side_effect = lambda: os.open("/dev/null", os.O_RDONLY)

    def test_control_only_relays_preflight_from_the_exact_invocation_child(self):
        request = {"operation": "preflight", "routes": []}
        with (patch("runtime_managed_broker.require_descendant") as ancestry,
              patch("runtime_managed_broker.process_exited", return_value=False),
              patch("runtime_managed_broker.request_notion_relay", return_value=b"result") as relay,
              patch("runtime_managed_broker.send_notion_result") as send):
            self.broker.read_notion(self.reader, "session", 22, request)
            relay.assert_called_once_with(self.profile, self.notion, "control", request)
            send.assert_called_once_with(self.reader, b"result")
            self.assertEqual(ancestry.call_args_list[0].kwargs["root_pid"], self.session.pid)
            self.assertEqual(ancestry.call_args_list[0].kwargs["worker_pid"], 22)
            self.assertEqual(ancestry.call_args_list[1].kwargs["root_pid"], 22)
            self.assertEqual(ancestry.call_args_list[1].kwargs["worker_pid"], self.reader.pid)
            self.assertTrue(ancestry.call_args_list[1].kwargs["direct"])

    def test_unbound_wrong_scope_and_disconnected_callers_get_no_notion_result(self):
        with (patch("runtime_managed_broker.require_descendant") as ancestry,
              patch("runtime_managed_broker.process_exited", return_value=True),
              patch("runtime_managed_broker.request_notion_relay", return_value=b"result") as relay,
              patch("runtime_managed_broker.send_notion_result") as send):
            with self.assertRaises(ValueError):
                self.broker.read_notion(self.reader, "other session", 22, {"operation": "preflight"})
            with self.assertRaises(ValueError):
                self.broker.read_notion(self.reader, "session", 99, {"operation": "preflight"})
            with self.assertRaises(ValueError):
                self.broker.read_notion(self.reader, "session", 22, {"operation": "search"})
            ancestry.side_effect = IdentityRejected("no verified parent")
            with self.assertRaises(IdentityRejected):
                self.broker.read_notion(self.reader, "session", 22, {"operation": "preflight"})
            relay.assert_not_called()
            ancestry.side_effect = None
            with self.assertRaises(ValueError):
                self.broker.read_notion(self.reader, "session", 22, {"operation": "preflight"})
            relay.assert_called_once()
            send.assert_not_called()
