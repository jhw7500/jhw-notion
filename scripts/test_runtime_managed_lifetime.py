import json
import os
from pathlib import Path
import tempfile
import unittest

from runtime_managed_lifetime import InvocationInFlight, ManagedInvocation, require_no_pending_invocations
from runtime_managed_transport import ManagedPeer, local_socket


RELEASE = "r-" + "a" * 40 + "-" + "b" * 64
BOOTSTRAP = "b-" + "c" * 64


class ManagedInvocationTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.records = root / "records"
        self.records.mkdir(mode=0o700)
        self.records_fd = os.open(self.records, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.addCleanup(os.close, self.records_fd)
        self.listener = local_socket()
        self.addCleanup(self.listener.close)
        self.endpoint = str(root / "listener")
        self.listener.bind(self.endpoint)
        self.listener.listen(1)
        self.listener.settimeout(3)

    def start_worker(self):
        finish_read, finish_write = os.pipe()
        pid = os.fork()
        if pid == 0:
            os.close(finish_write)
            try:
                with local_socket() as client:
                    client.connect(self.endpoint)
                    client.send(b"request")
                    os.read(finish_read, 1)
            except OSError:
                os._exit(1)
            os._exit(0)
        os.close(finish_read)

        def stop():
            os.close(finish_write)
            return os.waitpid(pid, 0)[1]

        return pid, stop

    def test_disconnect_preserves_record_until_exact_worker_exit(self):
        pid, stop = self.start_worker()
        invocation = None
        try:
            connection, _ = self.listener.accept()
            connection.settimeout(3)
            with ManagedPeer(connection, os.getuid()) as peer:
                self.assertEqual(peer.receive(), (b"request", ()))
                invocation = ManagedInvocation(self.records_fd, peer, RELEASE, BOOTSTRAP)
                note = self.records / invocation.name
                self.assertEqual(json.loads(note.read_bytes())["peerPid"], pid)
                self.assertEqual(note.stat().st_mode & 0o777, 0o600)
            self.assertFalse(invocation.settle(0))
            self.assertTrue(note.exists())
            for _ in range(2):
                with self.assertRaises(InvocationInFlight):
                    require_no_pending_invocations(self.records_fd)
        finally:
            status = stop()
        self.assertEqual(status, 0)
        assert invocation is not None
        with invocation:
            self.assertTrue(invocation.settle(1000))
            self.assertFalse(note.exists())
        require_no_pending_invocations(self.records_fd)

    def test_abandoned_record_blocks_restarted_writer_even_after_process_exits(self):
        _, stop = self.start_worker()
        try:
            connection, _ = self.listener.accept()
            with ManagedPeer(connection, os.getuid()) as peer:
                self.assertEqual(peer.receive(), (b"request", ()))
                with ManagedInvocation(self.records_fd, peer, RELEASE, BOOTSTRAP) as invocation:
                    name = invocation.name
        finally:
            stop()
        self.assertTrue((self.records / name).is_file())
        with self.assertRaises(InvocationInFlight):
            require_no_pending_invocations(self.records_fd)


if __name__ == "__main__":
    unittest.main()
