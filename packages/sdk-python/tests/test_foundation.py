import sys
import unittest


class FoundationTest(unittest.TestCase):
    def test_supported_python_baseline(self) -> None:
        self.assertGreaterEqual(sys.version_info, (3, 11))
