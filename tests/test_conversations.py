"""历史对话（conversation）模型、会话隔离与并行处理的后端测试。

运行方式（仓库根目录，PYTHONUTF8=1）：
    .\\.venv\\Scripts\\python.exe -m unittest tests.test_conversations -v
"""

from io import BytesIO
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from PIL import Image

_ROOT = Path(__file__).resolve().parents[1]
for _entry in (str(_ROOT), str(_ROOT / "tests")):
    if _entry not in sys.path:
        sys.path.insert(0, _entry)

from ocr import ImageReader
from web import create_app


SUMMARY_KEYS = {"id", "title", "created_at", "updated_at", "busy", "message_count"}
DETAIL_KEYS = SUMMARY_KEYS | {"messages", "intake"}


def image_bytes():
    buffer = BytesIO()
    Image.new("RGB", (140, 60), "white").save(buffer, format="PNG")
    return buffer.getvalue()


class SimpleModel:
    """仅返回一段固定回答，并记录每次请求的消息（用于核对上下文隔离）。"""

    def __init__(self, content="完成"):
        self.content = content
        self.requests = []
        self.lock = threading.Lock()

    def complete(self, messages, tools=None):
        with self.lock:
            self.requests.append(json.loads(json.dumps(messages, ensure_ascii=False)))
        return {"role": "assistant", "content": self.content}


class SlowModel(SimpleModel):
    """可控制时长的慢模型：用 started 事件告知测试“请求已进入模型等待”。"""

    def __init__(self, seconds=1.5, content="慢回答"):
        super().__init__(content)
        self.seconds = seconds
        self.started = threading.Event()

    def complete(self, messages, tools=None):
        self.started.set()
        time.sleep(self.seconds)
        return super().complete(messages, tools)


class ConversationTestCase(unittest.TestCase):
    model_class = SimpleModel

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name)
        self.environment = patch.dict(os.environ, {}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.model = self.model_class()
        self.ocr_model = SimpleModel("识别文字")
        self.app = create_app(self.path, client_factory=lambda: self.model,
                              reader_factory=lambda: ImageReader(self.ocr_model),
                              settings_path=self.path / "settings.json")
        self.app.config["TESTING"] = True
        self.client = self.app.test_client()
        self.client.get("/api/status")

    def second_client(self):
        other = self.app.test_client()
        other.set_cookie("session", self.client.get_cookie("session").value)
        return other

    def conversations(self):
        response = self.client.get("/api/conversations")
        self.assertEqual(response.status_code, 200, response.get_json())
        return response.get_json()

    def create(self, title=None):
        payload = {} if title is None else {"title": title}
        response = self.client.post("/api/conversations", json=payload)
        self.assertEqual(response.status_code, 200, response.get_json())
        return response.get_json()["conversation"]

    def chat(self, message, conversation_id=None, client=None, request_id=None):
        payload = {"message": message, "view": "organize"}
        if conversation_id is not None:
            payload["conversation_id"] = conversation_id
        if request_id is not None:
            payload["request_id"] = request_id
        return (client or self.client).post("/api/chat", json=payload)

    def detail(self, identity):
        response = self.client.get(f"/api/conversations/{identity}")
        self.assertEqual(response.status_code, 200, response.get_json())
        return response.get_json()["conversation"]

    def assert_summary(self, summary):
        self.assertEqual(set(summary), SUMMARY_KEYS)
        self.assertIsInstance(summary["id"], str)
        self.assertTrue(summary["id"])
        self.assertIsInstance(summary["title"], str)
        self.assertIsInstance(summary["created_at"], str)
        self.assertIsInstance(summary["updated_at"], str)
        self.assertIsInstance(summary["busy"], bool)
        self.assertIsInstance(summary["message_count"], int)


class ConversationApiTests(ConversationTestCase):
    def test_list_new_activate_detail_patch_and_delete(self):
        listing = self.conversations()
        self.assertTrue(listing["ok"])
        self.assertEqual(len(listing["conversations"]), 1)
        default_id = listing["conversations"][0]["id"]
        self.assertEqual(listing["active"], default_id)
        self.assert_summary(listing["conversations"][0])
        self.assertEqual(listing["conversations"][0]["title"], "新对话")

        created = self.create()
        self.assert_summary(created)
        listing = self.conversations()
        self.assertEqual(listing["active"], created["id"])
        self.assertEqual(len(listing["conversations"]), 2)
        # 最新的在前
        self.assertEqual(listing["conversations"][0]["id"], created["id"])
        self.assertEqual(listing["conversations"][1]["id"], default_id)

        activated = self.client.post(f"/api/conversations/{default_id}/activate")
        self.assertEqual(activated.status_code, 200)
        self.assertEqual(activated.get_json()["active"], default_id)
        self.assert_summary(activated.get_json()["conversation"])

        detail = self.detail(created["id"])
        self.assertEqual(set(detail), DETAIL_KEYS)
        self.assertEqual(detail["messages"], [])
        self.assertEqual(detail["intake"], {"text": "", "image_ids": [], "image_count": 0})

        patched = self.client.patch(f"/api/conversations/{created['id']}",
                                    json={"title": "导数复习", "intake_text": "已粘贴的草稿"})
        self.assertEqual(patched.status_code, 200, patched.get_json())
        self.assertEqual(patched.get_json()["conversation"]["title"], "导数复习")
        detail = self.detail(created["id"])
        self.assertEqual(detail["title"], "导数复习")
        self.assertEqual(detail["intake"]["text"], "已粘贴的草稿")

        self.assertEqual(self.client.patch(f"/api/conversations/{created['id']}",
                                           json={"unknown": 1}).status_code, 400)
        self.assertEqual(self.client.patch(f"/api/conversations/{created['id']}",
                                           json={"title": "长" * 61}).status_code, 400)
        self.assertEqual(self.client.patch(f"/api/conversations/{created['id']}",
                                           json={"intake_text": "字" * 80001}).status_code, 400)

        deleted = self.client.delete(f"/api/conversations/{created['id']}")
        self.assertEqual(deleted.status_code, 200, deleted.get_json())
        self.assertEqual(deleted.get_json()["active"], default_id)
        self.assertEqual(len(self.conversations()["conversations"]), 1)

    def test_missing_conversation_returns_404(self):
        missing = "not-a-real-id"
        self.assertEqual(self.client.get(f"/api/conversations/{missing}").status_code, 404)
        self.assertEqual(self.client.post(f"/api/conversations/{missing}/activate").status_code, 404)
        self.assertEqual(self.client.patch(f"/api/conversations/{missing}", json={"title": "x"}).status_code, 404)
        self.assertEqual(self.client.delete(f"/api/conversations/{missing}").status_code, 404)
        self.assertEqual(self.chat("你好", conversation_id=missing).status_code, 404)

    def test_delete_last_conversation_creates_a_fresh_one(self):
        default_id = self.conversations()["conversations"][0]["id"]
        deleted = self.client.delete(f"/api/conversations/{default_id}")
        self.assertEqual(deleted.status_code, 200, deleted.get_json())
        listing = self.conversations()
        self.assertEqual(len(listing["conversations"]), 1)
        self.assertNotEqual(listing["conversations"][0]["id"], default_id)
        self.assertEqual(listing["active"], listing["conversations"][0]["id"])
        self.assertEqual(listing["conversations"][0]["title"], "新对话")

    def test_conversation_limit(self):
        while len(self.conversations()["conversations"]) < 20:
            self.create()
        response = self.client.post("/api/conversations", json={})
        self.assertEqual(response.status_code, 400)
        self.assertIn("20", response.get_json()["error"])
        self.assertEqual(len(self.conversations()["conversations"]), 20)


class ConversationChatTests(ConversationTestCase):
    def test_messages_and_agents_are_isolated_between_conversations(self):
        first = self.create()
        second = self.create()
        self.assertEqual(self.chat("第一句", conversation_id=first["id"]).status_code, 200)

        listing = {item["id"]: item for item in self.conversations()["conversations"]}
        self.assertEqual(listing[first["id"]]["message_count"], 2)
        self.assertEqual(listing[first["id"]]["title"], "第一句")
        self.assertEqual(listing[second["id"]]["message_count"], 0)
        self.assertEqual(self.detail(second["id"])["messages"], [])

        # B 会话的消息与上下文互不影响（A 的标题/消息不会串到 B）。
        self.assertEqual(self.chat("第二句", conversation_id=second["id"]).status_code, 200)
        self.assertEqual(self.chat("第三句", conversation_id=first["id"]).status_code, 200)

        first_messages = self.detail(first["id"])["messages"]
        self.assertEqual([item["role"] for item in first_messages], ["user", "assistant", "user", "assistant"])
        self.assertEqual(first_messages[0]["text"], "第一句")
        self.assertEqual(first_messages[2]["text"], "第三句")
        second_messages = self.detail(second["id"])["messages"]
        self.assertEqual([item["text"] for item in second_messages], ["第二句", "完成"])

        # 第三次请求的上下文里应包含第一句和第三句，但不包含另一对话的第二句。
        third_request = json.dumps(self.model.requests[-1], ensure_ascii=False)
        self.assertIn("第一句", third_request)
        self.assertIn("第三句", third_request)
        self.assertNotIn("第二句", third_request)

    def test_chat_response_carries_conversation_id_and_defaults_to_active(self):
        first = self.create()
        response = self.chat("默认对话里的问题")
        self.assertEqual(response.status_code, 200, response.get_json())
        body = response.get_json()
        self.assertEqual(body["conversation_id"], first["id"])
        self.assertTrue(body["ok"])
        self.assertIn("answer", body)
        self.assertEqual(self.detail(first["id"])["messages"][0]["text"], "默认对话里的问题")

    def test_old_requests_without_conversation_id_still_work(self):
        # 不带 conversation_id 的旧前端：/api/chat 与 /api/intake/read 都落到默认对话。
        listing = self.conversations()
        self.assertEqual(len(listing["conversations"]), 1)
        default_id = listing["active"]
        response = self.chat("旧接口请求")
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(response.get_json()["conversation_id"], default_id)
        read = self.client.post("/api/intake/read", data={"files": (BytesIO(image_bytes()), "source.png")})
        self.assertEqual(read.status_code, 200, read.get_json())
        self.assertEqual(len(read.get_json()["image_ids"]), 1)
        detail = self.detail(default_id)
        self.assertEqual(detail["message_count"], 2)
        self.assertEqual(detail["intake"]["image_count"], 1)
        self.assertEqual(len(self.conversations()["conversations"]), 1)

    def test_error_reply_is_recorded_as_error_message(self):
        class FailingModel:
            def complete(self, messages, tools=None):
                from llm import ModelError
                raise ModelError("模拟服务不可用")

        app = create_app(self.path, client_factory=lambda: FailingModel(),
                         settings_path=self.path / "settings.json")
        client = app.test_client()
        client.get("/api/status")
        conversation_id = client.get("/api/conversations").get_json()["active"]
        response = client.post("/api/chat", json={"message": "会失败的问题", "view": "organize"})
        self.assertEqual(response.status_code, 502)
        detail = client.get(f"/api/conversations/{conversation_id}").get_json()["conversation"]
        self.assertEqual([item["role"] for item in detail["messages"]], ["user", "error"])
        self.assertIn("未完成", detail["messages"][1]["text"])


    def test_display_text_is_stored_and_named_instead_of_the_model_instruction(self):
        conversation = self.create()
        instruction = ("请自动辨认原图与以下补充中的笔记、错题并分别整理。原图是主要依据，文字仅辅助。\n\n"
                       "prepared-A 模拟信息不足")
        response = self.chat(instruction, conversation_id=conversation["id"])
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(response.get_json()["conversation_id"], conversation["id"])
        body = response.get_json()
        self.assertTrue(body["ok"])

        # 不带 display_text 的旧客户端仍按 message 存档与命名。
        legacy = self.create()
        self.assertEqual(self.chat("旧客户端消息", conversation_id=legacy["id"]).status_code, 200)
        legacy_detail = self.detail(legacy["id"])
        self.assertEqual(legacy_detail["messages"][0]["text"], "旧客户端消息")
        self.assertEqual(legacy_detail["title"], "旧客户端消息")

        separated = self.create()
        response = self.client.post("/api/chat", json={
            "message": instruction, "display_text": "已上传原稿：prepared-A.txt",
            "view": "organize", "conversation_id": separated["id"]})
        self.assertEqual(response.status_code, 200, response.get_json())
        detail = self.detail(separated["id"])
        self.assertEqual(detail["messages"][0]["text"], "已上传原稿：prepared-A.txt")
        self.assertTrue(detail["title"].startswith("已上传原稿：prepared-A"))
        self.assertIn("请自动辨认原图", json.dumps(self.model.requests[-1], ensure_ascii=False))
        self.assertEqual(detail["messages"][1]["role"], "assistant")

        for bad in (123, "", "字" * 80001):
            rejected = self.client.post("/api/chat", json={
                "message": instruction, "display_text": bad, "view": "organize",
                "conversation_id": separated["id"]})
            self.assertEqual(rejected.status_code, 400, rejected.get_json())


class ConversationParallelTests(ConversationTestCase):
    model_class = SlowModel

    def setUp(self):
        super().setUp()
        self.model.started.clear()

    def test_second_request_in_same_conversation_is_rejected(self):
        conversation = self.create()
        results = []
        worker = threading.Thread(target=lambda: results.append(
            self.chat("慢请求", conversation_id=conversation["id"], client=self.second_client(), request_id="slow-1")))
        worker.start()
        self.assertTrue(self.model.started.wait(2), "慢请求没有进入模型等待")
        response = self.chat("并发第二请求", conversation_id=conversation["id"], client=self.second_client())
        self.assertEqual(response.status_code, 409)
        self.assertIn("上一条请求还在处理中", response.get_json()["error"])
        # busy 的对话仍允许保存草稿文字
        patched = self.client.patch(f"/api/conversations/{conversation['id']}", json={"intake_text": "处理中也先存草稿"})
        self.assertEqual(patched.status_code, 200, patched.get_json())
        worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(results[0].status_code, 200, results[0].get_json())
        self.assertEqual(self.detail(conversation["id"])["intake"]["text"], "处理中也先存草稿")
        self.assertEqual(self.detail(conversation["id"])["message_count"], 2)

    def test_different_conversations_run_in_parallel(self):
        first = self.create()
        second = self.create()
        self.model.seconds = 1.5
        results = []
        worker = threading.Thread(target=lambda: results.append(
            self.chat("慢请求", conversation_id=first["id"], client=self.second_client(), request_id="parallel-a")))
        begin = time.monotonic()
        worker.start()
        self.assertTrue(self.model.started.wait(2), "慢请求没有进入模型等待")
        other = self.chat("另一对话同时发送", conversation_id=second["id"], client=self.second_client(),
                          request_id="parallel-b")
        elapsed = time.monotonic() - begin
        worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(results[0].status_code, 200, results[0].get_json())
        self.assertEqual(other.status_code, 200, other.get_json())
        # 串行需要 3 秒以上；并行应当在 2.5 秒内完成（含等待第一请求进入模型的时间）。
        self.assertLess(elapsed, 2.5, f"两个对话疑似串行：耗时 {elapsed:.2f}s")
        self.assertEqual(results[0].get_json()["conversation_id"], first["id"])
        self.assertEqual(other.get_json()["conversation_id"], second["id"])

    def test_delete_busy_conversation_is_rejected(self):
        conversation = self.create()
        results = []
        worker = threading.Thread(target=lambda: results.append(
            self.chat("慢请求", conversation_id=conversation["id"], client=self.second_client(), request_id="busy-1")))
        worker.start()
        self.assertTrue(self.model.started.wait(2), "慢请求没有进入模型等待")
        busy_delete = self.client.delete(f"/api/conversations/{conversation['id']}")
        self.assertEqual(busy_delete.status_code, 409, busy_delete.get_json())
        self.assertIn("正在处理中", busy_delete.get_json()["error"])
        worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(results[0].status_code, 200)
        deleted = self.client.delete(f"/api/conversations/{conversation['id']}")
        self.assertEqual(deleted.status_code, 200, deleted.get_json())
        self.assertEqual(deleted.get_json()["active"], self.conversations()["active"])

    def test_cancel_finds_token_in_its_conversation(self):
        conversation = self.create()
        other = self.create()
        self.model.seconds = 3
        results = []
        worker = threading.Thread(target=lambda: results.append(
            self.chat("等待停止的慢请求", conversation_id=conversation["id"],
                      client=self.second_client(), request_id="cancel-me")))
        worker.start()
        self.assertTrue(self.model.started.wait(2), "慢请求没有进入模型等待")
        cancel = self.second_client().post("/api/cancel", json={"request_id": "cancel-me"})
        self.assertEqual(cancel.status_code, 200, cancel.get_json())
        started = time.monotonic()
        worker.join(2)
        self.assertFalse(worker.is_alive(), "取消后请求没有及时结束")
        self.assertLess(time.monotonic() - started, 1.5)
        self.assertEqual(results[0].status_code, 499, results[0].get_json())
        self.assertTrue(results[0].get_json()["cancelled"])
        messages = self.detail(conversation["id"])["messages"]
        self.assertEqual([item["role"] for item in messages], ["user", "notice"])
        self.assertIn("已停止本轮", messages[1]["text"])
        # 另一个对话没有被误取消/误记录
        self.assertEqual(self.detail(other["id"])["messages"], [])


class ConversationIntakeTests(ConversationTestCase):
    def read_into(self, conversation_id=None):
        data = {"files": (BytesIO(image_bytes()), "source.png")}
        if conversation_id is not None:
            data["conversation_id"] = conversation_id
        response = self.client.post("/api/intake/read", data=data)
        self.assertEqual(response.status_code, 200, response.get_json())
        return response.get_json()["image_ids"]

    def test_intake_images_and_clear_are_isolated_per_conversation(self):
        first = self.create()
        second = self.create()
        first_images = self.read_into(first["id"])
        second_images = self.read_into(second["id"])
        self.assertEqual(self.detail(first["id"])["intake"]["image_count"], 1)
        self.assertEqual(self.detail(second["id"])["intake"]["image_count"], 1)

        cleared = self.client.post("/api/intake/clear", json={"conversation_id": first["id"]})
        self.assertEqual(cleared.status_code, 200, cleared.get_json())
        self.assertEqual(self.detail(first["id"])["intake"]["image_count"], 0)
        self.assertEqual(self.detail(second["id"])["intake"]["image_count"], 1)
        self.assertEqual(self.detail(second["id"])["intake"]["image_ids"], second_images)

        # 清空后该对话的旧原图不能再使用；另一对话的原图仍然有效。
        stale_request = {"message": "旧原图", "view": "organize", "conversation_id": first["id"],
                         "image_ids": first_images}
        self.assertEqual(self.client.post("/api/chat", json=stale_request).status_code, 409)
        fresh_request = {"message": "新原图", "view": "organize", "conversation_id": second["id"],
                         "image_ids": second_images}
        self.assertEqual(self.client.post("/api/chat", json=fresh_request).status_code, 200)

    def test_patch_intake_text_persists_draft(self):
        conversation = self.create()
        patched = self.client.patch(f"/api/conversations/{conversation['id']}",
                                    json={"intake_text": "这是一段还没提交的草稿"})
        self.assertEqual(patched.status_code, 200, patched.get_json())
        self.assertEqual(self.detail(conversation["id"])["intake"]["text"], "这是一段还没提交的草稿")
        self.assertEqual(self.conversations()["active"], conversation["id"])


    def test_clear_clears_draft_atomically_and_only_for_target(self):
        first = self.create()
        second = self.create()
        self.client.patch(f"/api/conversations/{first['id']}", json={"intake_text": "A 草稿"})
        self.client.patch(f"/api/conversations/{second['id']}", json={"intake_text": "B 草稿"})
        self.read_into(first["id"])
        self.read_into(second["id"])

        cleared = self.client.post("/api/intake/clear",
                                   json={"preview_ids": [], "conversation_id": first["id"]})
        self.assertEqual(cleared.status_code, 200, cleared.get_json())
        self.assertEqual(self.detail(first["id"])["intake"],
                         {"text": "", "image_ids": [], "image_count": 0})
        self.assertEqual(self.detail(second["id"])["intake"]["text"], "B 草稿")
        self.assertEqual(self.detail(second["id"])["intake"]["image_count"], 1)

        # 旧前端不带 conversation_id：落到当前 active 对话。
        self.client.post(f"/api/conversations/{first['id']}/activate")
        legacy = self.client.post("/api/intake/clear", json={"preview_ids": []})
        self.assertEqual(legacy.status_code, 200, legacy.get_json())
        self.assertEqual(self.detail(first["id"])["intake"]["text"], "")
        self.assertEqual(self.detail(second["id"])["intake"]["text"], "B 草稿")

        # 清空后重新写草稿仍然可用；清空语义不删除消息。
        self.client.patch(f"/api/conversations/{first['id']}", json={"intake_text": "重新写"})
        self.assertEqual(self.detail(first["id"])["intake"]["text"], "重新写")


class ConversationParallelIntakeTests(ConversationTestCase):
    model_class = SlowModel

    def test_intake_clear_rejects_busy_conversation(self):
        conversation = self.create()
        results = []
        worker = threading.Thread(target=lambda: results.append(
            self.chat("慢请求", conversation_id=conversation["id"], client=self.second_client(), request_id="clear-busy")))
        worker.start()
        self.assertTrue(self.model.started.wait(2), "慢请求没有进入模型等待")
        blocked = self.client.post("/api/intake/clear", json={"conversation_id": conversation["id"]})
        self.assertEqual(blocked.status_code, 409, blocked.get_json())
        worker.join(5)
        self.assertEqual(results[0].status_code, 200)


class ConversationLifecycleRaceTests(ConversationTestCase):
    def test_concurrent_create_never_exceeds_limit(self):
        cookie = self.client.get_cookie("session").value
        workers = 40
        barrier = threading.Barrier(workers)
        results = []
        guard = threading.Lock()

        def create_one():
            client = self.app.test_client()
            client.set_cookie("session", cookie)
            barrier.wait(10)
            response = client.post("/api/conversations", json={})
            with guard:
                results.append(response)

        threads = [threading.Thread(target=create_one) for _ in range(workers)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(10)
            self.assertFalse(thread.is_alive())
        listing = self.conversations()["conversations"]
        self.assertEqual(len(listing), 20)
        accepted = [item for item in results if item.status_code == 200]
        rejected = [item for item in results if item.status_code != 200]
        self.assertEqual(len(accepted), 19)
        self.assertEqual(len(rejected), workers - 19)
        for item in rejected:
            self.assertEqual(item.status_code, 400, item.get_json())
            self.assertIn("20", item.get_json()["error"])

    def test_delete_and_chat_start_race_keeps_membership(self):
        for index in range(10):
            conversation = self.create()
            barrier = threading.Barrier(2)
            chat_result, delete_result = [], []

            def start_chat():
                client = self.second_client()
                barrier.wait(10)
                chat_result.append(self.chat("删除竞态", conversation_id=conversation["id"],
                                             client=client, request_id=f"race-chat-{index}"))

            def delete_it():
                client = self.second_client()
                barrier.wait(10)
                delete_result.append(client.delete(f"/api/conversations/{conversation['id']}"))

            first = threading.Thread(target=start_chat)
            second = threading.Thread(target=delete_it)
            first.start(); second.start(); first.join(10); second.join(10)
            self.assertFalse(first.is_alive()); self.assertFalse(second.is_alive())
            self.assertEqual(len(chat_result), 1)
            self.assertEqual(len(delete_result), 1)
            self.assertIn(chat_result[0].status_code, (200, 404, 409), chat_result[0].get_json())
            self.assertIn(delete_result[0].status_code, (200, 409), delete_result[0].get_json())
            if delete_result[0].status_code == 200:
                self.assertNotIn(conversation["id"], [item["id"] for item in self.conversations()["conversations"]])
        listing = self.conversations()["conversations"]
        self.assertLessEqual(len(listing), 20)
        self.assertEqual([item["id"] for item in listing if item["busy"]], [])

class ConversationLifecycleRaceSlowTests(ConversationTestCase):
    model_class = SlowModel

    def test_reset_is_rejected_while_request_runs(self):
        conversation = self.create()
        results = []
        worker = threading.Thread(target=lambda: results.append(
            self.chat("等待停止的慢请求", conversation_id=conversation["id"],
                      client=self.second_client(), request_id="reset-race")))
        worker.start()
        self.assertTrue(self.model.started.wait(2), "慢请求没有进入模型等待")
        blocked = self.client.post("/api/reset")
        self.assertEqual(blocked.status_code, 409, blocked.get_json())
        worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(results[0].status_code, 200, results[0].get_json())
        cleared = self.client.post("/api/reset")
        self.assertEqual(cleared.status_code, 200, cleared.get_json())
        listing = self.conversations()
        self.assertEqual(len(listing["conversations"]), 1)
        self.assertNotEqual(listing["conversations"][0]["id"], conversation["id"])
        self.assertEqual(listing["active"], listing["conversations"][0]["id"])
    def setUp(self):
        super().setUp()
        self.model.started.clear()

    def test_cancel_and_operation_survive_concurrent_lifecycle_changes(self):
        conversation = self.create()
        results = []
        worker = threading.Thread(target=lambda: results.append(
            self.chat("等待停止的慢请求", conversation_id=conversation["id"],
                      client=self.second_client(), request_id="lifecycle-cancel")))
        worker.start()
        self.assertTrue(self.model.started.wait(2), "慢请求没有进入模型等待")
        barrier = threading.Barrier(8)
        statuses = []
        guard = threading.Lock()

        def send(request):
            client = self.second_client()
            barrier.wait(10)
            response = request(client)
            with guard:
                statuses.append(response)

        def cancel(client):
            return client.post("/api/cancel", json={"request_id": "lifecycle-cancel"})

        def progress(client):
            return client.get("/api/operation?request_id=lifecycle-cancel")

        def create(client):
            return client.post("/api/conversations", json={})

        def listing(client):
            return client.get("/api/conversations")

        requests = [cancel, cancel, progress, progress, create, create, listing, listing]
        threads = [threading.Thread(target=send, args=(request,)) for request in requests]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(10)
            self.assertFalse(thread.is_alive())
        self.assertEqual(len(statuses), len(requests))
        for response in statuses:
            self.assertEqual(response.status_code, 200, response.get_json())
        worker.join(6)
        self.assertFalse(worker.is_alive())
        self.assertEqual(results[0].status_code, 499, results[0].get_json())
        for item in self.conversations()["conversations"]:
            self.assertFalse(item["busy"], item)


if __name__ == "__main__":
    unittest.main()
