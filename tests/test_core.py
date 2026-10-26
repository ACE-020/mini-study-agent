import copy
from io import BytesIO
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

from agent import StudyAgent
from demo import MISTAKE
from llm import ModelClient, ModelError
from tools import LocalTools


ROOT = Path(__file__).resolve().parents[1]


def call(name, arguments, call_id="call_1"):
    return {"role": "assistant", "content": None, "tool_calls": [{
        "id": call_id, "type": "function", "function": {
            "name": name, "arguments": json.dumps(arguments, ensure_ascii=False)}}]}


class ScriptedClient:
    def __init__(self, replies):
        self.replies = iter(replies)
        self.requests = []

    def complete(self, messages, tools):
        self.requests.append(copy.deepcopy(messages))
        reply = next(self.replies)
        if isinstance(reply, Exception):
            raise reply
        return reply


class StorageAndAgentTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name)
        self.tools = LocalTools(self.path)

    def save(self, **overrides):
        return self.tools.execute("save_mistake", json.dumps({**MISTAKE, **overrides}))

    def test_persistence_and_duplicate_calls(self):
        self.assertTrue(self.save()["data"]["saved"])
        self.assertTrue(self.save()["data"]["duplicate"])
        reloaded = LocalTools(self.path).get_mistakes()
        self.assertEqual(reloaded["total"], 1)
        self.assertEqual(reloaded["mistakes"][0]["correct_answer"], "2x")

    def test_corrupt_file_is_preserved(self):
        path = self.path / "mistakes.json"
        path.write_text("{broken", encoding="utf-8")
        self.assertFalse(self.save()["ok"])
        self.assertEqual(path.read_text(encoding="utf-8"), "{broken")

    def test_failed_atomic_replace_keeps_original(self):
        self.save()
        original = (self.path / "mistakes.json").read_bytes()
        with patch("tools.os.replace", side_effect=PermissionError("文件不可写")):
            self.assertFalse(self.save(question="另一道题")["ok"])
        self.assertEqual((self.path / "mistakes.json").read_bytes(), original)
        self.assertEqual(list(self.path.glob("*.tmp")), [])

    def test_priority_uses_topic_counts(self):
        self.save(question="导数题一")
        self.save(question="积分题", topic="积分")
        self.save(question="导数题二")
        result = self.tools.get_mistakes(limit=2)
        self.assertEqual(result["topic_counts"], {"导数": 2, "积分": 1})
        self.assertEqual([item["topic"] for item in result["mistakes"]], ["导数", "导数"])

    def test_tool_validation_and_allowlist(self):
        for arguments in ('{"limit":true}', '{"limit":0}', '{"path":"secret"}', '[]', '{broken'):
            self.assertFalse(self.tools.execute("get_mistakes", arguments)["ok"])
        self.assertFalse(self.tools.execute("delete_file", "{}")["ok"])
        self.assertFalse(self.tools.execute("save_mistake", "{}")["ok"])

    def test_note_search(self):
        (self.path / "notes.json").write_text(json.dumps([{ "id": "derivative-power", "topic": "导数", "content": "幂函数求导要保留系数。" }], ensure_ascii=False), encoding="utf-8")
        self.assertEqual(self.tools.search_notes("导数")[0]["id"], "derivative-power")
        self.assertEqual(self.tools.search_notes("没有的关键词"), [])

    def test_tool_result_is_returned_with_matching_call_id(self):
        client = ScriptedClient([call("save_mistake", MISTAKE),
                                 {"role": "assistant", "content": "已记录"}])
        agent = StudyAgent(client, self.tools)
        self.assertEqual(agent.run("整理这道错题"), "已记录")
        returned = client.requests[1][-1]
        self.assertEqual(returned["tool_call_id"], "call_1")
        self.assertTrue(json.loads(returned["content"])["data"]["saved"])

    def test_invalid_arguments_are_returned_to_model_for_recovery(self):
        client = ScriptedClient([call("get_mistakes", {"limit": 0}),
                                 call("get_mistakes", {"limit": 3}, "call_2"),
                                 {"role": "assistant", "content": "暂无错题"}])
        StudyAgent(client, self.tools).run("开始复习")
        self.assertFalse(json.loads(client.requests[1][-1]["content"])["ok"])
        self.assertTrue(json.loads(client.requests[2][-1]["content"])["ok"])

    def test_failed_final_answer_keeps_saved_data_and_complete_history(self):
        client = ScriptedClient([call("save_mistake", MISTAKE), ModelError("网络失败")])
        agent = StudyAgent(client, self.tools)
        with self.assertRaises(ModelError):
            agent.run("整理错题")
        self.assertEqual(self.tools.get_mistakes()["total"], 1)
        self.assertEqual(len(agent.messages), 1)

    def test_loop_is_bounded(self):
        client = ScriptedClient([call("get_mistakes", {})] * 2)
        with self.assertRaisesRegex(ModelError, "上限"):
            StudyAgent(client, self.tools, max_rounds=2).run("复习")
        self.assertEqual(len(client.requests), 2)

    def test_demo_reads_saved_data_in_a_new_process(self):
        options = ["--data-dir", str(self.path)]
        first = subprocess.run([sys.executable, str(ROOT / "main.py"), "--demo", "save", *options],
                               capture_output=True, text=True, encoding="utf-8")
        second = subprocess.run([sys.executable, str(ROOT / "main.py"), "--demo", "review", *options],
                                capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn("g(x)=x^3", second.stdout)
        self.assertEqual(self.tools.get_mistakes()["total"], 1)


class ModelRequestTests(unittest.TestCase):
    def test_transient_failure_retries_and_preserves_protocol_fields(self):
        message = {"role": "assistant", "content": None, "reasoning_content": "provider field",
                   "tool_calls": call("get_mistakes", {})["tool_calls"]}
        response = BytesIO(json.dumps({"choices": [{"message": message}]}).encode())
        with patch("llm.urlopen", side_effect=[URLError("offline"), response]) as request, \
                patch("llm.time.sleep"):
            result = ModelClient("https://example.invalid/v1", "test-key", "test").complete([], [])
        self.assertEqual(request.call_count, 2)
        self.assertEqual(result, message)
        self.assertEqual(request.call_args.args[0].full_url, "https://example.invalid/v1/chat/completions")

    def test_auth_failure_is_not_retried(self):
        error = HTTPError("https://example.invalid", 401, "unauthorized", {}, BytesIO())
        with patch("llm.urlopen", side_effect=error) as request:
            with self.assertRaisesRegex(ModelError, "401"):
                ModelClient("https://example.invalid", "test-key", "test").complete([], [])
        self.assertEqual(request.call_count, 1)

    def test_timeout_has_finite_retries(self):
        with patch("llm.urlopen", side_effect=TimeoutError) as request, patch("llm.time.sleep"):
            with self.assertRaisesRegex(ModelError, "2 次重试"):
                ModelClient("https://example.invalid", "test-key", "test").complete([], [])
        self.assertEqual(request.call_count, 3)

    def test_malformed_api_response_is_reported(self):
        with patch("llm.urlopen", return_value=BytesIO(b'{"choices": []}')):
            with self.assertRaisesRegex(ModelError, "预期格式"):
                ModelClient("https://example.invalid", "test-key", "test").complete([], [])


if __name__ == "__main__":
    unittest.main()
