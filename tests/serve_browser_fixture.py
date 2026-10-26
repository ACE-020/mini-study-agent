"""浏览器交互测试专用：模拟模型，错题和设置全部放在临时目录。"""

import argparse
import json
from pathlib import Path
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from materials import material_rules, REVISION_PROMPT
from llm import ModelError
from ocr import ImageReader
from settings import SettingsStore
from web import create_app
from prompts import IMPORT_PROMPT


class BrowserModel:
    def complete(self, messages, tools=None):
        last = messages[-1]
        if any(item["role"] == "system" and "当前任务是整理学习笔记" in item["content"] for item in messages):
            text = next(item["content"] for item in reversed(messages) if item["role"] == "user")
            if isinstance(text, list):
                text = text[0]["text"]
            if "等待停止" in text:
                time.sleep(3)
            if "信息不足" in text:
                return {"role":"assistant", "content":"第二行的不等号方向是什么？请补充这个符号。"}
            content = (Path(__file__).resolve().parents[1]/"examples/课堂笔记示例.md").read_text(encoding="utf-8")
            return {"role":"assistant", "content":None, "tool_calls":[{"id":"note-save", "type":"function",
                    "function":{"name":"save_note", "arguments":json.dumps({"topic":"数列极限与行列式", "content":content},ensure_ascii=False)}}]}
        if messages[0]["content"].startswith(material_rules()):
            if "等待停止" in last["content"]:
                time.sleep(3)
            return {"role": "assistant", "content": json.dumps({"exercises": [
                {"number": "1", "topic": "行列式", "question": "计算二阶行列式 |1 2; 3 4| 的值。", "answer": "资料答案：-2"},
                {"number": "2", "topic": "导数", "question": "求 g(x)=x^3 的导数，x 为实数。", "answer": "资料答案：3x^2"}
            ], "warnings": []}, ensure_ascii=False)}
        if isinstance(last.get("content"), list):
            time.sleep(1)
            return {"role": "assistant", "content": "题目：求 x² 的导数。\n我的答案：x。\n参考答案：2x。"}
        text = next(item["content"] for item in reversed(messages) if item["role"] == "user")
        if last["role"] == "tool":
            if "保存后失败" in text:
                raise ModelError("模拟保存后的回答失败")
            if "保存后停止" in text:
                time.sleep(3)
            return {"role": "assistant", "content": "已保存。先检查幂指数，别漏掉幂指数：你觉得它应该放在什么位置？"}
        if "等待停止" in text:
            time.sleep(3)
            return {"role": "assistant", "content": "这条迟到的回复不应进入对话。"}
        if "保存前失败" in text:
            raise ModelError("模拟保存前的回答失败")
        if "信息不足" in text:
            return {"role": "assistant", "content": "请补充你的答案。"}
        if "只说已保存" in text:
            return {"role": "assistant", "content": "已保存到错题本。"}
        if "补充" in text or "求" in text or "保存" in text:
            return {"role": "assistant", "content": None, "tool_calls": [
                {"id": "browser-save", "type": "function", "function": {
                    "name": "save_mistake", "arguments": json.dumps({
                        "question": "求 x² 的导数。", "user_answer": "x",
                        "correct_answer": "2x", "reason": "遗漏了幂指数作为系数。", "topic": "导数"
                    }, ensure_ascii=False)
                }}
            ]}
        return {"role": "assistant", "content": "收到你的修改。"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="study-browser-") as folder:
        root = Path(folder)
        settings_path = root / "settings.json"
        SettingsStore(settings_path).save({"base_url": "https://example.invalid/v1",
                                           "api_key": "fake-browser-key", "model": "browser-fixture",
                                           "ocr_model": "browser-fixture", "ocr_base_url": "",
                                           "ocr_api_key": ""})
        create_app(root / "data", client_factory=BrowserModel,
                   reader_factory=lambda: ImageReader(BrowserModel()),
                   settings_path=settings_path).run(host="127.0.0.1", port=args.port,
                                                   debug=False, use_reloader=False, threaded=True)
