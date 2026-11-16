"""The test support cleans up: a consumer's temp folder goes also when SIGTERM or SIGHUP ends the tests."""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import unittest
from pathlib import Path

PYTHON_DIR = Path(__file__).resolve().parents[1]


class SignalCleanupTest(unittest.TestCase):
    def test_a_signal_that_ends_the_tests_removes_the_consumer_folder(self) -> None:
        code = "import time, tests.support as s; print(s.Consumer().dir, flush=True); time.sleep(60)"
        for sig in (signal.SIGTERM, signal.SIGHUP):
            with self.subTest(signal=sig.name):
                child = subprocess.Popen([sys.executable, "-c", code], cwd=PYTHON_DIR, stdout=subprocess.PIPE, text=True)
                folder = ""
                try:
                    assert child.stdout is not None
                    folder = child.stdout.readline().strip()
                    self.assertIn("ab-py-", folder)
                    child.send_signal(sig)
                    self.assertEqual(child.wait(timeout=30), 128 + sig, "the signal's usual exit code")
                    self.assertFalse(os.path.exists(folder), folder)
                finally:
                    # A red run: the child and the folder that it left (this test's own).
                    if child.poll() is None:
                        child.kill()
                        child.wait()
                    if child.stdout:
                        child.stdout.close()
                    if folder:
                        shutil.rmtree(folder, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
