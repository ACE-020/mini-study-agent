"""离线失败演示：不调用真实 API，不修改错题或笔记文件。"""

import hashlib
import json
from pathlib import Path
from unittest.mock import patch

from llm import ModelClient, ModelError
from tools import LocalTools


ROOT = Path(__file__).resolve().parent


def fingerprints(paths):
    return {str(path): hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
            for path in paths}


def main():
    paths = [ROOT / "data/mistakes.json", ROOT / "data/notes.json"]
    before = fingerprints(paths)
    tools = LocalTools(ROOT / "data")
    print("[离线失败演示：主动制造错误，不访问真实 API，不写入数据。]")

    print("\n案例 1：请求没有注册的工具 save_note")
    unknown = tools.execute("save_note", "{}")
    print(json.dumps(unknown, ensure_ascii=False, indent=2))
    if unknown["ok"]:
        raise RuntimeError("检查失败：未知工具没有被拒绝。")

    print("\n案例 2：把 get_mistakes 的 limit 错填为 0")
    invalid = tools.execute("get_mistakes", json.dumps({"limit": 0}))
    print(json.dumps(invalid, ensure_ascii=False, indent=2))
    if invalid["ok"]:
        raise RuntimeError("检查失败：无效参数没有被拒绝。")

    print("\n案例 3：模拟模型服务持续超时")
    with patch("llm.urlopen", side_effect=TimeoutError) as request, patch("llm.time.sleep"):
        try:
            ModelClient("https://example.invalid", "dummy-key", "dummy-model").complete([], [])
        except ModelError as error:
            print(error)
            print(f"请求尝试次数：{request.call_count}（首次请求 + 两次重试）")
            if request.call_count != 3:
                raise RuntimeError("检查失败：重试次数不符合预期。")
        else:
            raise RuntimeError("检查失败：持续超时没有被报告。")

    if fingerprints(paths) != before:
        raise RuntimeError("检查失败：真实错题或笔记文件发生变化。")
    print("\n检查通过：三个错误都被正确报告，真实错题与笔记文件保持不变。")


if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    main()