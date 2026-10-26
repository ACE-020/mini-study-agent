from contextlib import redirect_stdout
from io import StringIO
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch
from urllib.error import URLError

from agent import StudyAgent
from cancellation import CancellationToken, OperationCancelled
from demo import MISTAKE
from llm import ModelClient, ModelError
from main import interactive_loop, run_turn
from settings import SettingsStore
from test_core import ScriptedClient, call
from tools import LocalTools
from web import create_app


CONFIG = {"base_url": "https://api.deepseek.com", "model": "deepseek-v4-pro",
          "ocr_model": "deepseek-flash", "ocr_base_url": "", "api_key": "test-secret-only", "ocr_api_key": ""}


class LocalSettingsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "settings.json"
        self.environment = patch.dict(os.environ, {}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.store = SettingsStore(self.path)

    def test_defaults_use_pro_for_study_and_flash_for_images(self):
        self.assertEqual(self.store.public()["model"], "deepseek-v4-pro")
        self.assertEqual(self.store.public()["ocr_model"], "deepseek-flash")
        self.assertFalse(self.store.public()["configured"])

    def test_config_survives_new_store_and_does_not_return_key(self):
        public = self.store.save(CONFIG)
        self.assertTrue(public["configured"])
        self.assertNotIn(CONFIG["api_key"], json.dumps(public))
        restored = SettingsStore(self.path).resolve()
        self.assertEqual(restored["api_key"], CONFIG["api_key"])
        self.assertEqual(restored["model"], "deepseek-v4-pro")
        if os.name == "nt":
            self.assertNotIn(CONFIG["api_key"], self.path.read_text(encoding="utf-8"))
            self.assertIn("windows-dpapi", self.path.read_text(encoding="utf-8"))

    def test_blank_key_keeps_secret_when_switching_models(self):
        self.store.save(CONFIG)
        self.store.save({**CONFIG, "api_key": "", "model": "deepseek-flash"})
        self.assertEqual(self.store.resolve()["api_key"], CONFIG["api_key"])
        self.assertEqual(self.store.resolve()["model"], "deepseek-flash")

    def test_switching_service_requires_explicit_key(self):
        self.store.save(CONFIG)
        before = self.path.read_bytes()
        with self.assertRaisesRegex(ValueError, "重新输入"):
            self.store.save({**CONFIG, "base_url": "https://example.invalid/v1", "api_key": ""})
        self.assertEqual(self.path.read_bytes(), before)

    def test_bad_config_and_failed_write_preserve_original(self):
        self.store.save(CONFIG)
        before = self.path.read_bytes()
        with patch("settings.os.replace", side_effect=PermissionError("simulated")):
            with self.assertRaises(OSError):
                self.store.save({**CONFIG, "model": "deepseek-flash"})
        self.assertEqual(self.path.read_bytes(), before)
        self.path.write_text("{broken", encoding="utf-8")
        with self.assertRaises(ValueError):
            self.store.save(CONFIG)
        self.assertEqual(self.path.read_text(encoding="utf-8"), "{broken")

    def test_separate_ocr_key_is_preserved(self):
        self.store.save({**CONFIG, "ocr_api_key": "separate-ocr-secret"})
        self.store.save({**CONFIG, "api_key": "", "ocr_api_key": ""})
        self.assertEqual(self.store.resolve()["ocr_api_key"], "separate-ocr-secret")

    def test_cli_reads_web_saved_configuration(self):
        self.store.save(CONFIG)
        with patch("settings.default_settings_path", return_value=self.path.parent / ".local-settings.json"), patch("settings.load_user_environment"):
            target = self.path.parent / ".local-settings.json"
            target.write_bytes(self.path.read_bytes())
            client = ModelClient.from_env()
        self.assertEqual(client.api_key, CONFIG["api_key"])
        self.assertEqual(client.model, CONFIG["model"])


class CancellationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.tools = LocalTools(self.directory.name)

    def test_cancelled_network_wait_never_executes_late_tools(self):
        started, release, finished = threading.Event(), threading.Event(), threading.Event()
        self.addCleanup(release.set)

        class SlowClient:
            def complete(self, messages, tools):
                started.set()
                release.wait(3)
                finished.set()
                return call("save_mistake", MISTAKE)

        token = CancellationToken()
        def cancel():
            started.wait(1)
            token.cancel()
        thread = threading.Thread(target=cancel)
        thread.start()
        agent = StudyAgent(SlowClient(), self.tools)
        before = time.monotonic()
        with self.assertRaises(OperationCancelled):
            agent.run("整理原句", cancel_token=token)
        self.assertLess(time.monotonic() - before, 1)
        release.set()
        self.assertTrue(finished.wait(1))
        thread.join(1)
        self.assertEqual(self.tools.get_mistakes()["total"], 0)
        self.assertEqual(len(agent.messages), 1)

    def test_cancel_between_tools_keeps_first_record_and_stops_second(self):
        token = CancellationToken()
        message = call("save_mistake", MISTAKE)
        message["tool_calls"] += call("save_mistake", {**MISTAKE, "question": "第二道题"}, "call_2")["tool_calls"]
        client = ScriptedClient([message])
        def trace(event, value):
            if event == "工具结果":
                token.cancel()
        agent = StudyAgent(client, self.tools, trace=trace)
        with self.assertRaises(OperationCancelled):
            agent.run("整理两道题", cancel_token=token)
        self.assertEqual(self.tools.get_mistakes()["total"], 1)
        self.assertEqual(len(agent.messages), 1)

    def test_cancellation_prevents_network_retry(self):
        token = CancellationToken()
        def failed(*args, **kwargs):
            token.cancel()
            raise URLError("simulated")
        with patch("llm.urlopen", side_effect=failed) as request:
            with self.assertRaises(OperationCancelled):
                ModelClient("https://example.invalid", "dummy", "dummy").complete([], cancel_token=token)
        self.assertEqual(request.call_count, 1)

    def test_cli_interrupt_keeps_draft_for_editing(self):
        agent = Mock()
        agent.client = object()
        agent.run.side_effect = KeyboardInterrupt
        with redirect_stdout(StringIO()):
            self.assertFalse(run_turn(agent, "原句"))
        self.assertTrue(agent.run.call_args.kwargs["cancel_token"].event.is_set())
        with patch("main.read_prompt", side_effect=["原句", "修改后的句子", "/exit"]) as editor, \
                patch("main.run_turn", side_effect=[False, True]) as run, redirect_stdout(StringIO()):
            interactive_loop(agent)
        self.assertEqual(editor.call_args_list[1].args, ("原句",))
        self.assertEqual(run.call_args_list[1].args[1], "修改后的句子")


class SettingsAndCancelWebTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name)
        self.environment = patch.dict(os.environ, {}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.model = ScriptedClient([{"role": "assistant", "content": "完成"}])
        self.app = create_app(self.path, client_factory=lambda: self.model,
                              settings_path=self.path / "settings.json")
        self.app.config["TESTING"] = True
        self.client = self.app.test_client()
        self.client.get("/api/status")

    def test_save_and_read_settings_without_key_echo(self):
        response = self.client.post("/api/settings", json=CONFIG)
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertNotIn(CONFIG["api_key"], response.get_data(as_text=True))
        self.assertNotIn(CONFIG["api_key"], self.client.get("/api/settings").get_data(as_text=True))
        restored = create_app(self.path, settings_path=self.path / "settings.json").test_client()
        self.assertTrue(restored.get("/api/status").get_json()["configured"])
        self.assertEqual(restored.get("/api/status").get_json()["model"], "deepseek-v4-pro")

    def test_connection_test_does_not_save_unsaved_key(self):
        with patch("web.ModelClient") as client:
            client.return_value.complete.return_value = {"role": "assistant", "content": "连接成功"}
            response = self.client.post("/api/settings/test", json=CONFIG)
        self.assertEqual(response.status_code, 200)
        self.assertFalse((self.path / "settings.json").exists())

    def test_cancel_arriving_before_task_is_respected(self):
        self.client.post("/api/cancel", json={"request_id": "early"})
        response = self.client.post("/api/chat", json={"message": "test", "request_id": "early"})
        self.assertEqual(response.status_code, 499)
        self.assertTrue(response.get_json()["cancelled"])
        self.assertEqual(self.model.requests, [])

    def test_old_cancel_does_not_cancel_new_request(self):
        self.client.post("/api/cancel", json={"request_id": "old"})
        response = self.client.post("/api/chat", json={"message": "edited", "request_id": "new"})
        self.assertEqual(response.status_code, 200)

    def test_inflight_cancel_finishes_quickly_and_allows_edited_resubmit(self):
        started, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        captures = []
        class SlowOnce:
            def complete(self, messages, tools):
                captures.append(messages)
                if len(captures) == 1:
                    started.set()
                    release.wait(3)
                return {"role": "assistant", "content": "完成"}
        model = SlowOnce()
        app = create_app(self.path, client_factory=lambda: model, settings_path=self.path / "settings.json")
        first = app.test_client()
        first.get("/api/status")
        second = app.test_client()
        second.set_cookie("session", first.get_cookie("session").value)
        results = []
        worker = threading.Thread(target=lambda: results.append(first.post("/api/chat", json={"message": "原句", "request_id": "running"})))
        worker.start()
        self.assertTrue(started.wait(1))
        self.assertEqual(second.post("/api/cancel", json={"request_id": "running"}).status_code, 200)
        worker.join(1)
        self.assertFalse(worker.is_alive())
        self.assertEqual(results[0].status_code, 499)
        response = second.post("/api/chat", json={"message": "改好的句子", "request_id": "edited"})
        self.assertEqual(response.status_code, 200)
        self.assertFalse(any(item.get("content") == "原句" for item in captures[1]))
        release.set()


if __name__ == "__main__":
    unittest.main()
