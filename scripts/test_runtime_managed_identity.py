import os
from pathlib import Path
import select
import subprocess
import sys
import textwrap
import unittest

from runtime_managed_identity import IdentityRejected, require_descendant


class ProcessTree:
    def __init__(self):
        self._gate_read, self._gate_write = os.pipe()
        report_read, report_write = os.pipe()
        self.root_pid = os.fork()
        if self.root_pid == 0:
            os.close(self._gate_write)
            os.close(report_read)
            middle_pid = os.fork()
            if middle_pid == 0:
                worker_pid = os.fork()
                if worker_pid == 0:
                    os.close(report_write)
                    os.read(self._gate_read, 1)
                    os._exit(0)
                os.write(report_write, f"{worker_pid}\n".encode("ascii"))
                os.close(report_write)
                os.read(self._gate_read, 1)
                os.waitpid(worker_pid, 0)
                os._exit(0)
            os.close(report_write)
            os.read(self._gate_read, 1)
            os.waitpid(middle_pid, 0)
            os._exit(0)
        os.close(self._gate_read)
        os.close(report_write)
        with os.fdopen(report_read, "rb") as report:
            self.worker_pid = int(report.readline())
        self.root_pidfd = os.pidfd_open(self.root_pid)
        self.worker_pidfd = os.pidfd_open(self.worker_pid)
        self._closed = False

    def close(self):
        if self._closed:
            return
        self._closed = True
        os.close(self._gate_write)
        os.waitpid(self.root_pid, 0)

    def close_pidfds(self):
        os.close(self.root_pidfd)
        os.close(self.worker_pidfd)


@unittest.skipUnless(hasattr(os, "pidfd_open"), "Linux pidfds are required")
class ManagedIdentityTest(unittest.TestCase):
    def start_tree(self):
        tree = ProcessTree()
        self.addCleanup(tree.close_pidfds)
        self.addCleanup(tree.close)
        return tree

    def require(self, tree, **changes):
        values = {
            "root_pid": tree.root_pid,
            "root_pidfd": tree.root_pidfd,
            "worker_pid": tree.worker_pid,
            "worker_pidfd": tree.worker_pidfd,
            "uid": os.getuid(),
        }
        values.update(changes)
        return require_descendant(**values)

    def test_live_worker_below_exact_root_is_accepted(self):
        tree = self.start_tree()
        self.assertIsNone(self.require(tree))

    def test_root_itself_is_not_a_descendant(self):
        tree = self.start_tree()
        with self.assertRaises(IdentityRejected):
            self.require(
                tree,
                worker_pid=tree.root_pid,
                worker_pidfd=tree.root_pidfd,
            )

    def test_worker_below_a_different_root_is_rejected(self):
        expected = self.start_tree()
        other = self.start_tree()
        with self.assertRaises(IdentityRejected):
            self.require(
                expected,
                worker_pid=other.worker_pid,
                worker_pidfd=other.worker_pidfd,
            )

    def test_pidfd_must_be_the_kernel_reference_for_the_declared_pid(self):
        tree = self.start_tree()
        with self.assertRaises(IdentityRejected):
            self.require(tree, worker_pidfd=tree.root_pidfd)
        with self.assertRaises(IdentityRejected):
            self.require(tree, root_pidfd=tree.worker_pidfd)
        with (
            Path(__file__).open("rb") as ordinary_file,
            self.assertRaises(IdentityRejected),
        ):
            self.require(tree, worker_pidfd=ordinary_file.fileno())

    def test_every_process_in_the_chain_must_have_the_declared_uid(self):
        tree = self.start_tree()
        with self.assertRaises(IdentityRejected):
            self.require(tree, uid=os.getuid() + 1)

    def test_released_worker_is_rejected_even_with_its_pidfd_retained(self):
        tree = self.start_tree()
        tree.close()
        poller = select.poll()
        poller.register(tree.worker_pidfd, select.POLLIN)
        self.assertTrue(poller.poll(1000))
        with self.assertRaises(IdentityRejected):
            self.require(tree)


@unittest.skipUnless(
    os.geteuid() == 0, "cross-UID boundary requires a private root container"
)
class CrossUidManagedIdentityTest(unittest.TestCase):
    ORIGINAL_UID = 61001
    SERVICE_UID = 61002

    def test_dedicated_service_uid_can_verify_only_the_original_users_tree(self):
        original_source = textwrap.dedent(
            """
            import os

            worker = os.fork()
            if worker == 0:
                os.read(0, 1)
                os._exit(0)
            print(worker, flush=True)
            os.read(0, 1)
            os.waitpid(worker, 0)
            """
        )
        verifier_source = textwrap.dedent(
            """
            import os
            import sys

            from runtime_managed_identity import IdentityRejected, require_descendant

            root_pid, worker_pid, uid = map(int, sys.argv[1:])
            root_pidfd = os.pidfd_open(root_pid)
            worker_pidfd = os.pidfd_open(worker_pid)
            try:
                require_descendant(
                    root_pid=root_pid,
                    root_pidfd=root_pidfd,
                    worker_pid=worker_pid,
                    worker_pidfd=worker_pidfd,
                    uid=uid,
                )
                try:
                    require_descendant(
                        root_pid=worker_pid,
                        root_pidfd=worker_pidfd,
                        worker_pid=worker_pid,
                        worker_pidfd=worker_pidfd,
                        uid=uid,
                    )
                except IdentityRejected:
                    pass
                else:
                    raise AssertionError("root was accepted as its own descendant")
            finally:
                os.close(root_pidfd)
                os.close(worker_pidfd)
            """
        )
        environment = {"PYTHONPATH": str(Path(__file__).parent)}
        original = subprocess.Popen(
            [sys.executable, "-B", "-c", original_source],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=environment,
            user=self.ORIGINAL_UID,
            group=self.ORIGINAL_UID,
            extra_groups=[],
        )
        try:
            assert original.stdout is not None
            worker_pid = int(original.stdout.readline())
            verifier = subprocess.Popen(
                [
                    sys.executable,
                    "-B",
                    "-c",
                    verifier_source,
                    str(original.pid),
                    str(worker_pid),
                    str(self.ORIGINAL_UID),
                ],
                env=environment,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                user=self.SERVICE_UID,
                group=self.SERVICE_UID,
                extra_groups=[],
            )
            _, verifier_stderr = verifier.communicate(timeout=10)
            self.assertEqual(verifier.returncode, 0, verifier_stderr)
        finally:
            assert original.stdin is not None
            original.stdin.close()
            original.stdin = None
            stdout, stderr = original.communicate(timeout=10)
            self.assertEqual(original.returncode, 0, stdout + stderr)


if __name__ == "__main__":
    unittest.main()
