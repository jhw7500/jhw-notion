import fcntl
import os
from pathlib import Path
import select
import subprocess
import tempfile
import time
import unittest

from runtime_managed_lifetime import ManagedInvocation
from runtime_managed_service_worker import (
    MAX_ARTIFACT_BYTES,
    PidfdPeer,
    create_sealed_artifact,
    start_lifetime_holder,
    validate_lease_fd,
)


RELEASE = "r-" + "a" * 40 + "-" + "b" * 64
BOOTSTRAP = "b-" + "c" * 64


class ManagedServiceWorkerTest(unittest.TestCase):
    def test_pidfd_peer_requires_the_kernel_pid_to_match_the_request(self):
        child = subprocess.Popen(["/usr/bin/sleep", "30"])
        self.addCleanup(child.wait)
        self.addCleanup(child.terminate)
        pidfd = os.pidfd_open(child.pid)
        self.addCleanup(os.close, pidfd)
        peer = PidfdPeer(pidfd, child.pid)
        duplicate = peer.duplicate_pidfd()
        try:
            self.assertEqual(peer.pid, child.pid)
            poller = select.poll()
            poller.register(duplicate, select.POLLIN)
            self.assertEqual(poller.poll(0), [])
        finally:
            os.close(duplicate)
        with self.assertRaises(RuntimeError):
            PidfdPeer(pidfd, child.pid + 1)

    def test_sealed_artifact_is_immutable_and_bounded(self):
        fd = create_sealed_artifact(b"verified runtime")
        try:
            required = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
            self.assertEqual(fcntl.fcntl(fd, fcntl.F_GET_SEALS) & required, required)
            self.assertEqual(os.read(fd, 4096), b"verified runtime")
            with self.assertRaises(PermissionError):
                os.write(fd, b"changed")
        finally:
            os.close(fd)
        with self.assertRaises(RuntimeError):
            create_sealed_artifact(b"x" * (MAX_ARTIFACT_BYTES + 1))

    def test_lease_validation_requires_the_named_file_and_a_shared_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "lease"
            path.write_bytes(b"")
            path.chmod(0o600)
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            wrong = os.open(Path(directory) / "other", os.O_RDONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            try:
                fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
                validate_lease_fd(fd, path)
                with self.assertRaises(RuntimeError):
                    validate_lease_fd(wrong, path)
            finally:
                os.close(wrong)
                os.close(fd)

    def test_holder_keeps_intent_until_the_exact_leaf_exits(self):
        with tempfile.TemporaryDirectory() as directory:
            records = Path(directory) / "records"
            records.mkdir(mode=0o700)
            records_fd = os.open(records, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            leaf = subprocess.Popen(["/usr/bin/sleep", "30"])
            pidfd = os.pidfd_open(leaf.pid)
            peer = PidfdPeer(pidfd, leaf.pid)
            invocation = ManagedInvocation(records_fd, peer, RELEASE, BOOTSTRAP)
            note = records / invocation.name
            holder = start_lifetime_holder(invocation, retained_fds=(records_fd,))
            invocation.close()
            os.close(pidfd)
            self.assertTrue(note.exists())
            leaf.terminate()
            self.assertEqual(leaf.wait(timeout=3), -15)
            deadline = time.monotonic() + 3
            while note.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertFalse(note.exists())
            self.assertEqual(os.waitpid(holder, 0)[1], 0)
            os.close(records_fd)


if __name__ == "__main__":
    unittest.main()
