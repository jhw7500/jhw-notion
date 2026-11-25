import array
import os
from pathlib import Path
import select
import socket
import subprocess
import sys
import tempfile
import textwrap
import unittest

from runtime_managed_transport import MAX_PACKET, ManagedPeer, PeerRejected, local_socket


class ManagedTransportTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = str(Path(self.directory.name) / "managed.sock")
        self.listener = local_socket()
        self.addCleanup(self.listener.close)
        self.listener.bind(self.path)
        self.listener.listen(4)
        self.listener.settimeout(3)

    def connect(self):
        client = local_socket()
        self.addCleanup(client.close)
        client.settimeout(3)
        client.connect(self.path)
        server, _ = self.listener.accept()
        self.addCleanup(server.close)
        server.settimeout(3)
        return client, server

    def test_current_peer_can_send_and_receive_separate_packets(self):
        client, server = self.connect()
        with ManagedPeer(server, os.getuid()) as receiver, ManagedPeer(client, os.getuid()) as sender:
            self.assertEqual(receiver.pid, os.getpid())
            self.assertEqual(sender.pid, os.getpid())
            sender.send(b"status")
            sender.send(b"invoke")
            self.assertEqual(receiver.receive(), (b"status", ()))
            self.assertEqual(receiver.receive(), (b"invoke", ()))

    def test_listener_rejects_a_different_uid(self):
        _, server = self.connect()
        with self.assertRaises(PeerRejected):
            ManagedPeer(server, os.getuid() + 1)

    def test_unsupported_automatic_pidfd_delivery_is_rejected_at_admission(self):
        _, server = self.connect()
        server.setsockopt(socket.SOL_SOCKET, getattr(socket, "SO_PASSPIDFD", 76), 1)
        with self.assertRaises(PeerRejected):
            ManagedPeer(server, os.getuid())
        self.assertEqual(server.fileno(), -1)

    def test_inheriting_the_connected_socket_does_not_inherit_the_peer_identity(self):
        client, server = self.connect()
        with ManagedPeer(server, os.getuid()) as receiver:
            child = os.fork()
            if child == 0:
                try:
                    client.send(b"inherited")
                except OSError:
                    os._exit(1)
                os._exit(0)
            self.assertEqual(os.waitpid(child, 0)[1], 0)
            with self.assertRaises(PeerRejected):
                receiver.receive()

    def test_peer_must_be_alive_even_when_a_complete_packet_is_queued(self):
        child = os.fork()
        if child == 0:
            try:
                with local_socket() as client:
                    client.connect(self.path)
                    client.send(b"queued")
            except OSError:
                os._exit(1)
            os._exit(0)
        self.assertEqual(os.waitpid(child, 0)[1], 0)
        server, _ = self.listener.accept()
        with server, self.assertRaises(PeerRejected):
            with ManagedPeer(server, os.getuid()) as receiver:
                receiver.receive()

    def test_wrong_descriptor_count_does_not_leave_a_received_fd_open(self):
        client, server = self.connect()
        with ManagedPeer(server, os.getuid()) as receiver, open(__file__, "rb") as source:
            descriptors = array.array("i", [source.fileno()])
            before = len(os.listdir("/proc/self/fd"))
            client.sendmsg([b"status"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, descriptors)])
            with self.assertRaises(PeerRejected):
                receiver.receive()
            self.assertEqual(len(os.listdir("/proc/self/fd")), before - 2)
            self.assertEqual(server.fileno(), -1)

    def test_expected_descriptor_is_received_with_close_on_exec(self):
        client, server = self.connect()
        with ManagedPeer(server, os.getuid()) as receiver, ManagedPeer(client, os.getuid()) as sender:
            with tempfile.TemporaryFile() as source:
                source.write(b"fixture")
                source.seek(0)
                sender.send(b"read", (source.fileno(),))
                packet, (fd,) = receiver.receive(1)
                with os.fdopen(fd, "rb") as received:
                    self.assertEqual(packet, b"read")
                    self.assertFalse(os.get_inheritable(received.fileno()))
                    self.assertEqual(received.read(), b"fixture")

    def test_oversized_packet_is_rejected_as_one_message(self):
        client, server = self.connect()
        with ManagedPeer(server, os.getuid()) as receiver:
            client.send(b"x" * (MAX_PACKET + 1))
            with self.assertRaises(PeerRejected):
                receiver.receive()


@unittest.skipUnless(os.getuid() == 0, "cross-UID boundary requires a private root container")
class CrossUidManagedTransportTest(unittest.TestCase):
    SERVICE_UID = 61001
    CLIENT_UID = 61002

    def test_two_uids_authenticate_both_directions_and_transfer_a_sealed_memfd(self):
        server_source = textwrap.dedent(
            """
            import fcntl
            import os
            from pathlib import Path
            import select
            import socket
            import sys

            from runtime_managed_transport import ManagedPeer, PeerRejected, local_socket

            endpoint = sys.argv[1]
            private = Path(sys.argv[2])
            service_uid = int(sys.argv[3])
            client_uid = int(sys.argv[4])
            listener = local_socket()
            artifact = private / "service-only.txt"
            try:
                private.mkdir(mode=0o700)
                artifact.write_bytes(b"service-owned fixture")
                artifact.chmod(0o600)
                assert artifact.stat().st_uid == service_uid
                listener.bind(endpoint)
                os.chmod(endpoint, 0o777)
                listener.listen(2)
                listener.settimeout(5)
                print("ready", flush=True)

                rejected, _ = listener.accept()
                rejected.settimeout(5)
                try:
                    ManagedPeer(rejected, client_uid)
                except PeerRejected:
                    print("unauthorized-rejected", flush=True)
                else:
                    raise AssertionError("unauthorized UID was accepted")

                connection, _ = listener.accept()
                connection.settimeout(5)
                with ManagedPeer(connection, client_uid) as peer:
                    assert peer.receive() == (b"artifact", ())
                    memfd = os.memfd_create("service-artifact", os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
                    try:
                        with artifact.open("rb") as source:
                            os.write(memfd, source.read())
                        os.lseek(memfd, 0, os.SEEK_SET)
                        seals = (fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW
                                 | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL)
                        fcntl.fcntl(memfd, fcntl.F_ADD_SEALS, seals)
                        peer.send(b"sealed", (memfd,))
                    finally:
                        os.close(memfd)
                    assert peer.receive() == (b"done", ())
                    observer = peer.duplicate_pidfd()
                    try:
                        poller = select.poll()
                        poller.register(observer, select.POLLIN)
                        assert not poller.poll(0)
                        peer.send(b"ack")
                        peer.close()
                        assert poller.poll(5000)
                    finally:
                        os.close(observer)
            finally:
                listener.close()
                if artifact.exists():
                    artifact.unlink()
                if private.exists():
                    private.rmdir()
                try:
                    os.unlink(endpoint)
                except FileNotFoundError:
                    pass
            """
        )
        client_source = textwrap.dedent(
            """
            import fcntl
            import os
            import sys

            from runtime_managed_transport import ManagedPeer, local_socket

            endpoint = sys.argv[1]
            private_artifact = sys.argv[2]
            service_uid = int(sys.argv[3])
            try:
                os.open(private_artifact, os.O_RDONLY)
            except PermissionError:
                pass
            else:
                raise AssertionError("client read the service-private source")

            with local_socket() as connection:
                connection.connect(endpoint)
                with ManagedPeer(connection, service_uid) as peer:
                    peer.send(b"artifact")
                    packet, (memfd,) = peer.receive(1)
                    try:
                        assert packet == b"sealed"
                        assert os.fstat(memfd).st_uid == service_uid
                        assert not os.get_inheritable(memfd)
                        required = (fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW
                                    | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL)
                        assert fcntl.fcntl(memfd, fcntl.F_GET_SEALS) & required == required
                        assert os.read(memfd, 4096) == b"service-owned fixture"
                        try:
                            os.write(memfd, b"changed")
                        except PermissionError:
                            pass
                        else:
                            raise AssertionError("sealed memfd remained writable")
                    finally:
                        os.close(memfd)
                    peer.send(b"done")
                    assert peer.receive() == (b"ack", ())
            """
        )

        with tempfile.TemporaryDirectory() as directory:
            os.chmod(directory, 0o777)
            endpoint = str(Path(directory) / "managed.sock")
            private = Path(directory) / "private"
            environment = {"PYTHONPATH": str(Path(__file__).parent)}
            server = subprocess.Popen(
                [
                    sys.executable,
                    "-c",
                    server_source,
                    endpoint,
                    str(private),
                    str(self.SERVICE_UID),
                    str(self.CLIENT_UID),
                ],
                env=environment,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                user=self.SERVICE_UID,
                group=self.SERVICE_UID,
                extra_groups=[],
            )
            try:
                server_output = server.stdout
                if server_output is None:
                    self.fail("service stdout was not captured")
                ready, _, _ = select.select([server_output], [], [], 5)
                self.assertTrue(ready, "service did not become ready")
                self.assertEqual(server_output.readline(), "ready\n")

                with local_socket() as unauthorized:
                    unauthorized.connect(endpoint)

                client = subprocess.run(
                    [
                        sys.executable,
                        "-c",
                        client_source,
                        endpoint,
                        str(private / "service-only.txt"),
                        str(self.SERVICE_UID),
                    ],
                    env=environment,
                    text=True,
                    capture_output=True,
                    timeout=10,
                    user=self.CLIENT_UID,
                    group=self.CLIENT_UID,
                    extra_groups=[],
                    check=False,
                )
                self.assertEqual(client.returncode, 0, client.stderr)
                stdout, stderr = server.communicate(timeout=10)
                self.assertEqual(server.returncode, 0, stderr)
                self.assertEqual(stdout, "unauthorized-rejected\n")
            finally:
                if server.poll() is None:
                    server.kill()
                    server.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
