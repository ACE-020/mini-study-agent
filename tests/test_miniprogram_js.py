"""小程序端脚本的真实加载测试：用模拟 wx 跑两条传输路径与两个页面入口。"""

import os
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HARNESS = ROOT / "tests" / "miniprogram_harness.cjs"


def node_binary():
    for candidate in (os.environ.get("NODE_BINARY"), shutil.which("node"), shutil.which("node.exe")):
        if candidate:
            return candidate
    return None


class MiniProgramHarnessTests(unittest.TestCase):
    def test_harness_loads_both_transports_and_pages(self):
        node = node_binary()
        if not node:
            self.skipTest("未找到 node；设置 NODE_BINARY 指向 node.exe 后可执行")
        result = subprocess.run([node, str(HARNESS)], cwd=str(ROOT),
                                capture_output=True, encoding="utf-8", errors="replace", timeout=180)
        self.assertEqual(result.returncode, 0, (result.stdout or "") + (result.stderr or ""))
        self.assertIn("ALL PASS", result.stdout or "")


if __name__ == "__main__":
    unittest.main()
