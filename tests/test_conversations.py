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

from ocr import ImageReader, prepare_image
from web import create_app


SUMMARY_KEYS = {"id", "title", "created_at", "updated_at", "busy", "message_count", "collection_id"}
DETAIL_KEYS = SUMMARY_KEYS | {"messages", "intake", "attachments"}


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
        self.copy_cookies(other)
        return other

    def copy_cookies(self, client):
        # 历史身份在独立的数据目录级 Cookie 里，仅复制 Flask session 会变成另一个用户。
        for name in ("session", self.app.config["HISTORY_COOKIE_NAME"]):
            cookie = self.client.get_cookie(name)
            if cookie is not None:
                client.set_cookie(name, cookie.value)
        return client

    def restart(self, chat_model=None, reader_model=None):
        """模拟进程重启：同一数据目录、同一浏览器 Cookie、新的 app 与签名密钥。"""
        cookie_name = self.app.config["HISTORY_COOKIE_NAME"]
        history_cookie = self.client.get_cookie(cookie_name)
        session_cookie = self.client.get_cookie("session")
        app = create_app(self.path,
                         client_factory=lambda: chat_model or self.model,
                         reader_factory=lambda: ImageReader(reader_model or self.ocr_model),
                         settings_path=self.path / "settings.json")
        app.config["TESTING"] = True
        client = app.test_client()
        if session_cookie is not None:
            client.set_cookie("session", session_cookie.value)
        if history_cookie is not None:
            client.set_cookie(cookie_name, history_cookie.value)
        return app, client

    def upload(self, conversation_id, files, client=None, request_id=None):
        data = {"files": files, "conversation_id": conversation_id}
        if request_id is not None:
            data["request_id"] = request_id
        return (client or self.client).post("/api/intake/read", data=data)

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
        self.assertTrue(summary["collection_id"] is None or isinstance(summary["collection_id"], str))


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

    def test_conversation_count_has_no_upper_limit(self):
        # 用户要求保存全部历史：新建不再要求先删旧对话，刷新/重启后也都还在。
        while len(self.conversations()["conversations"]) < 25:
            self.create()
        response = self.client.post("/api/conversations", json={})
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(len(self.conversations()["conversations"]), 26)


class ConversationDraftTests(ConversationTestCase):
    def draft_index(self, client=None):
        response = (client or self.client).get("/api/conversations?draft=1")
        self.assertEqual(response.status_code, 200, response.get_json())
        return response.get_json()

    def test_draft_endpoint_reuses_one_editor_without_history_rows(self):
        listing = self.draft_index()
        self.assertEqual(listing["conversations"], [])
        draft = listing["draft"]
        self.assertTrue(draft["draft"])
        self.assertTrue(draft["empty"])
        self.assertEqual(draft["title"], "新对话")
        for _ in range(3):
            again = self.draft_index()
            self.assertEqual(again["draft"]["id"], draft["id"])
            self.assertEqual(again["conversations"], [])
        # 旧客户端接口保持原样：仍能看到这个默认对话，而不是 404 或空列表。
        legacy = self.conversations()
        self.assertEqual([item["id"] for item in legacy["conversations"]], [draft["id"]])
        self.assertEqual(legacy["active"], draft["id"])
        # 旧客户端新建仍是正式历史行，不受草稿影响。
        created = self.create()
        listing = self.draft_index()
        self.assertEqual([item["id"] for item in listing["conversations"]], [created["id"]])
        self.assertNotEqual(listing["draft"]["id"], created["id"])

    def test_draft_text_images_and_collection_stay_out_of_history_until_first_send(self):
        draft_id = self.draft_index()["draft"]["id"]
        self.assertEqual(self.client.patch(f"/api/conversations/{draft_id}",
                                           json={"intake_text": "还没发送的草稿"}).status_code, 200)
        collection = self.client.post("/api/collections", json={"name": "函数"}).get_json()["collection"]
        self.assertEqual(self.client.post(f"/api/conversations/{draft_id}/move",
                                          json={"collection_id": collection["id"]}).status_code, 200)
        uploaded = self.upload(draft_id, (BytesIO(image_bytes()), "draft-source.png"))
        self.assertEqual(uploaded.status_code, 200, uploaded.get_json())

        listing = self.draft_index()
        self.assertEqual(listing["conversations"], [], "草稿的文字/原稿/集合不能变成空历史行")
        self.assertEqual(listing["draft"]["id"], draft_id)
        self.assertEqual(listing["draft"]["collection_id"], collection["id"])
        self.assertEqual(listing["draft"]["message_count"], 0)
        self.assertEqual(listing["collections"][0]["conversation_count"], 0)
        detail = self.detail(draft_id)
        self.assertEqual(detail["intake"]["text"], "还没发送的草稿")
        self.assertEqual(detail["intake"]["image_count"], 1)
        self.assertEqual(len(self.conversations()["conversations"]), 1,
                         "旧接口仍只有一个默认对话，没有多出空行")

        # 草稿内容随进程重启保留，但重启后仍不是历史。
        self.app, client = self.restart()
        listing = self.draft_index(client)
        self.assertEqual(listing["conversations"], [])
        self.assertEqual(listing["draft"]["id"], draft_id)
        detail = client.get(f"/api/conversations/{draft_id}").get_json()["conversation"]
        self.assertEqual(detail["intake"]["text"], "还没发送的草稿")
        self.assertEqual(detail["intake"]["image_count"], 1)

        # 首次实际发送才提升成正式历史；新草稿保持空白。
        sent = client.post("/api/chat", json={"message": "第一问", "view": "organize",
                                              "conversation_id": draft_id})
        self.assertEqual(sent.status_code, 200, sent.get_json())
        idle = client.get("/api/conversations?draft=1&ensure=0").get_json()
        self.assertIsNone(idle["draft"], "刷新列表不应在后台凭空创建空白草稿")
        self.assertIn(draft_id, [item["id"] for item in idle["conversations"]])
        listing = self.draft_index(client)
        self.assertIn(draft_id, [item["id"] for item in listing["conversations"]])
        self.assertNotEqual(listing["draft"]["id"], draft_id)
        self.assertEqual(listing["draft"]["message_count"], 0)
        self.assertEqual(listing["draft"]["title"], "新对话")
        promoted = next(item for item in listing["conversations"] if item["id"] == draft_id)
        self.assertFalse(promoted["draft"])
        self.assertEqual(promoted["collection_id"], collection["id"])
        self.assertEqual(promoted["message_count"], 2)
        self.assertEqual(listing["collections"][0]["conversation_count"], 1)

    def test_failed_first_send_before_recording_keeps_the_same_draft(self):
        draft_id = self.draft_index()["draft"]["id"]
        self.assertEqual(self.client.patch(f"/api/conversations/{draft_id}",
                                           json={"intake_text": "原稿仍在"}).status_code, 200)
        stale = self.client.post("/api/chat", json={
            "message": "用过期原图发送", "view": "organize", "conversation_id": draft_id,
            "image_ids": ["missing-image"]})
        self.assertEqual(stale.status_code, 409, stale.get_json())
        listing = self.draft_index()
        self.assertEqual(listing["conversations"], [], "未记录用户消息的失败不能生成历史行")
        self.assertEqual(listing["draft"]["id"], draft_id)
        self.assertEqual(self.detail(draft_id)["intake"]["text"], "原稿仍在")
        retry = self.client.post("/api/chat", json={"message": "重试发送", "view": "organize",
                                                    "conversation_id": draft_id})
        self.assertEqual(retry.status_code, 200, retry.get_json())
        listing = self.draft_index()
        self.assertIn(draft_id, [item["id"] for item in listing["conversations"]])

    def test_legacy_empty_rows_are_marked_but_not_used_as_the_new_chat(self):
        empty = self.create()
        listing = self.draft_index()
        legacy = next(item for item in listing["conversations"] if item["id"] == empty["id"])
        self.assertTrue(legacy["empty"])
        self.assertFalse(legacy["draft"])
        self.assertNotEqual(listing["draft"]["id"], empty["id"])
        self.assertEqual(self.detail(empty["id"])["messages"], [])
        # 旧空行仍在磁盘上，只是新首页把它当空行隐藏；再次取草稿不会复用它。
        self.assertEqual(self.draft_index()["draft"]["id"], listing["draft"]["id"])
        self.assertIn(empty["id"], [item["id"] for item in self.conversations()["conversations"]])


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
    def test_concurrent_create_keeps_every_conversation(self):
        workers = 40
        barrier = threading.Barrier(workers)
        results = []
        guard = threading.Lock()

        def create_one():
            client = self.app.test_client()
            self.copy_cookies(client)
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
        # 默认对话 + 40 个并发新建全部保留，没有静默丢弃或数量上限。
        self.assertEqual(len(listing), workers + 1)
        self.assertEqual(len(results), workers)
        self.assertTrue(all(item.status_code == 200 for item in results))

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
        self.assertEqual([item["id"] for item in listing["conversations"]], [conversation["id"]])
        self.assertEqual(listing["active"], conversation["id"])
        self.assertEqual(listing["conversations"][0]["message_count"], 2)
        # 临时会话重置不删除历史：换进程后同一身份仍能读回消息。
        _, client = self.restart()
        self.assertEqual(client.get(f"/api/conversations/{conversation['id']}").status_code, 200)

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


class ConversationPersistenceTests(ConversationTestCase):
    def test_history_draft_attachments_and_collections_survive_restart(self):
        conversation = self.create("导数复习")
        cid = conversation["id"]
        self.assertEqual(self.chat("第一问", conversation_id=cid).status_code, 200)
        self.assertEqual(self.client.patch(f"/api/conversations/{cid}",
                                           json={"intake_text": "重启后还在的草稿"}).status_code, 200)
        uploaded = self.upload(cid, (BytesIO(image_bytes()), "source.png"))
        self.assertEqual(uploaded.status_code, 200, uploaded.get_json())
        collection = self.client.post("/api/collections", json={"name": "函数"}).get_json()["collection"]
        self.assertEqual(self.client.patch(f"/api/conversations/{cid}",
                                           json={"collection_id": collection["id"]}).status_code, 200)

        payload = self.client.get("/api/conversations").get_json()
        payload = {**payload, "detail": self.detail(cid)}
        self.assertNotIn(str(self.path), json.dumps(payload, ensure_ascii=False))
        self.assertNotIn("web-history", json.dumps(payload, ensure_ascii=False))

        self.app, client = self.restart()
        listing = client.get("/api/conversations").get_json()
        self.assertEqual(listing["active"], cid)
        summary = next(item for item in listing["conversations"] if item["id"] == cid)
        self.assertEqual(summary["title"], "导数复习")
        self.assertEqual(summary["collection_id"], collection["id"])
        self.assertEqual(summary["message_count"], 2)
        self.assertEqual([item["name"] for item in listing["collections"]], ["函数"])
        self.assertEqual(listing["collections"][0]["conversation_count"], 1)

        detail = client.get(f"/api/conversations/{cid}").get_json()["conversation"]
        self.assertEqual([item["text"] for item in detail["messages"]], ["第一问", "完成"])
        self.assertEqual(detail["intake"]["text"], "重启后还在的草稿")
        self.assertEqual(detail["intake"]["image_count"], 1)
        attachment = detail["attachments"][0]
        self.assertEqual(attachment["name"], "source.png")
        self.assertEqual(attachment["kind"], "image")
        self.assertTrue(attachment["available"])
        self.assertFalse(attachment["placeholder"])
        self.assertTrue(attachment["thumbnail_url"].startswith(f"/api/conversations/{cid}/attachments/"))

        thumbnail = client.get(attachment["thumbnail_url"])
        self.assertEqual(thumbnail.status_code, 200, thumbnail.get_json())
        self.assertEqual(thumbnail.mimetype, "image/jpeg")
        with Image.open(BytesIO(thumbnail.data)) as image:
            self.assertLessEqual(max(image.size), 320)
            self.assertGreater(min(image.size), 0)
        preview = client.get(attachment["preview_url"])
        self.assertEqual(preview.status_code, 200)
        with Image.open(BytesIO(preview.data)) as image:
            self.assertEqual(image.size, (140, 60))

        follow = client.post("/api/chat", json={"message": "第二问", "view": "organize",
                                                "conversation_id": cid})
        self.assertEqual(follow.status_code, 200, follow.get_json())
        sent = json.dumps(self.model.requests[-1], ensure_ascii=False)
        self.assertIn("第一问", sent)
        detail = client.get(f"/api/conversations/{cid}").get_json()["conversation"]
        self.assertEqual([item["text"] for item in detail["messages"]],
                         ["第一问", "完成", "第二问", "完成"])

    def test_restored_original_images_can_be_used_again(self):
        cid = self.create()["id"]
        self.assertEqual(self.upload(cid, (BytesIO(image_bytes()), "source.png")).status_code, 200)
        _, client = self.restart()
        detail = client.get(f"/api/conversations/{cid}").get_json()["conversation"]
        self.assertEqual(detail["intake"]["image_count"], 1)
        response = client.post("/api/chat", json={
            "message": "看这张原稿继续", "view": "organize", "conversation_id": cid,
            "image_ids": detail["intake"]["image_ids"]})
        self.assertEqual(response.status_code, 200, response.get_json())
        sent = json.dumps(self.model.requests[-1], ensure_ascii=False)
        self.assertIn("image_url", sent)
        self.assertIn("data:image/jpeg;base64,", sent)

    def test_pdf_and_text_attachments_have_metadata_and_previews(self):
        from test_library_input import pdf_bytes
        cid = self.create()["id"]
        uploaded = self.upload(cid, [(BytesIO(pdf_bytes()), "习题.pdf"),
                                     (BytesIO("笔记原文".encode("utf-8")), "笔记.txt")])
        self.assertEqual(uploaded.status_code, 200, uploaded.get_json())
        self.assertEqual(len(uploaded.get_json()["image_ids"]), 2)

        _, client = self.restart()
        attachments = client.get(f"/api/conversations/{cid}/attachments").get_json()["attachments"]
        self.assertEqual([item["kind"] for item in attachments], ["pdf", "text"])
        pdf, text = attachments
        self.assertEqual(pdf["name"], "习题.pdf")
        self.assertEqual(pdf["page_count"], 2)
        self.assertTrue(pdf["available"])
        self.assertEqual(text["name"], "笔记.txt")
        self.assertEqual(text["mime"], "text/plain")

        self.assertEqual(client.get(pdf["thumbnail_url"]).status_code, 200)
        self.assertEqual(client.get(pdf["pages_url"].replace("{page}", "1")).status_code, 200)
        self.assertEqual(client.get(pdf["pages_url"].replace("{page}", "99")).status_code, 404)
        preview = client.get(pdf["preview_url"])
        self.assertEqual(preview.status_code, 200)
        self.assertTrue(preview.data.startswith(b"%PDF"))
        text_preview = client.get(text["preview_url"])
        self.assertEqual(text_preview.status_code, 200)
        self.assertEqual(text_preview.get_data(as_text=True), "笔记原文")

    def test_more_than_forty_attachments_and_all_visible_messages_survive_restart(self):
        """用户明确要求保存全部历史：附件与可见消息都不能在重启时被静默截断。"""
        cid = self.create()["id"]
        names = []
        for start, count in ((0, 20), (20, 20), (40, 5)):
            files = []
            for index in range(start, start + count):
                name = f"资料-{index:03d}.txt"
                names.append(name)
                files.append((BytesIO(f"内容 {index}".encode("utf-8")), name))
            response = self.upload(cid, files)
            self.assertEqual(response.status_code, 200, response.get_json())

        for index in range(205):
            response = self.chat(f"第 {index + 1} 轮", conversation_id=cid)
            self.assertEqual(response.status_code, 200, response.get_json())

        _, client = self.restart()
        detail = client.get(f"/api/conversations/{cid}").get_json()["conversation"]
        self.assertEqual(len(detail["messages"]), 410)
        self.assertEqual(detail["messages"][0]["text"], "第 1 轮")
        self.assertEqual(detail["messages"][-2]["text"], "第 205 轮")
        self.assertEqual(len(detail["attachments"]), 45)
        self.assertEqual([item["name"] for item in detail["attachments"]], names)
        self.assertTrue(all(item["available"] for item in detail["attachments"]))
        self.assertEqual(client.get(detail["attachments"][-1]["preview_url"]).status_code, 200)

        follow = client.post("/api/chat", json={"message": "重启后的追问", "view": "organize",
                                                "conversation_id": cid})
        self.assertEqual(follow.status_code, 200, follow.get_json())
        sent = json.dumps(self.model.requests[-1], ensure_ascii=False)
        self.assertIn("第 205 轮", sent)
        self.assertIn("重启后的追问", sent)
        # 模型上下文有独立的裁剪上限，但历史消息本身仍在。
        self.assertLess(len(self.model.requests[-1]), 80)

    def test_attachments_are_isolated_between_conversations_and_users(self):
        first = self.create()["id"]
        second = self.create()["id"]
        self.assertEqual(self.upload(first, (BytesIO(image_bytes()), "first.png")).status_code, 200)
        self.assertEqual(self.upload(second, (BytesIO(image_bytes()), "second.png")).status_code, 200)
        first_attachment = self.detail(first)["attachments"][0]
        second_attachment = self.detail(second)["attachments"][0]

        cross = self.client.get(f"/api/conversations/{first}/attachments/{second_attachment['id']}/thumbnail")
        self.assertEqual(cross.status_code, 404)
        cross_preview = self.client.get(f"/api/conversations/{second}/attachments/{first_attachment['id']}/preview")
        self.assertEqual(cross_preview.status_code, 404)

        # 同一浏览器身份的另一客户端可见。
        same_user = self.second_client()
        self.assertEqual(same_user.get(f"/api/conversations/{first}/attachments").status_code, 200)

        # 另一个浏览器身份（没有历史 Cookie）既看不到对话，也取不到附件。
        stranger = self.app.test_client()
        self.assertEqual(stranger.get(f"/api/conversations/{first}").status_code, 404)
        self.assertEqual(stranger.get(f"/api/conversations/{first}/attachments/"
                                      f"{first_attachment['id']}/thumbnail").status_code, 404)
        self.assertEqual(len(stranger.get("/api/conversations").get_json()["conversations"]), 1)

    def test_clear_only_resets_the_editing_draft_and_delete_removes_the_conversation(self):
        cid = self.create()["id"]
        self.assertEqual(self.chat("清除前的问题", conversation_id=cid).status_code, 200)
        self.assertEqual(self.upload(cid, (BytesIO(image_bytes()), "source.png")).status_code, 200)
        self.assertEqual(self.client.patch(f"/api/conversations/{cid}",
                                           json={"intake_text": "将被清除"}).status_code, 200)
        cleared = self.client.post("/api/intake/clear", json={"conversation_id": cid})
        self.assertEqual(cleared.status_code, 200, cleared.get_json())

        detail = self.detail(cid)
        self.assertEqual(detail["intake"], {"text": "", "image_ids": [], "image_count": 0})
        # 清空的是正在编辑的原稿和草稿；历史消息与已接受的附件目录保留。
        self.assertEqual([item["text"] for item in detail["messages"]], ["清除前的问题", "完成"])
        self.assertEqual([item["name"] for item in detail["attachments"]], ["source.png"])
        self.assertEqual(self.client.get(detail["attachments"][0]["preview_url"]).status_code, 200)

        _, client = self.restart()
        detail = client.get(f"/api/conversations/{cid}").get_json()["conversation"]
        self.assertEqual(detail["intake"], {"text": "", "image_ids": [], "image_count": 0})
        self.assertEqual(len(detail["messages"]), 2)
        self.assertEqual(len(detail["attachments"]), 1)
        self.assertEqual(client.get(detail["attachments"][0]["thumbnail_url"]).status_code, 200)

        # 单条对话的显式删除仍然删除它自己的消息、草稿与附件文件。
        self.assertEqual(client.delete(f"/api/conversations/{cid}").status_code, 200)
        self.assertEqual(client.get(f"/api/conversations/{cid}").status_code, 404)
        self.assertEqual(client.get(detail["attachments"][0]["preview_url"]).status_code, 404)
        _, client = self.restart()
        self.assertEqual(client.get(f"/api/conversations/{cid}").status_code, 404)
        self.assertNotIn(cid, [item["id"] for item in client.get("/api/conversations").get_json()["conversations"]])

    def test_clear_failure_restores_draft_and_original_images_atomically(self):
        cid = self.create()["id"]
        self.assertEqual(self.upload(cid, (BytesIO(image_bytes()), "kept.png")).status_code, 200)
        self.assertEqual(self.client.patch(f"/api/conversations/{cid}",
                                           json={"intake_text": "不能丢失的草稿"}).status_code, 200)
        history = self.app.extensions["web_history"]
        with patch.object(history, "save_conversation", side_effect=OSError("disk full")):
            failed = self.client.post("/api/intake/clear", json={"conversation_id": cid})
        self.assertEqual(failed.status_code, 500, failed.get_json())
        detail = self.detail(cid)
        self.assertEqual(detail["intake"]["text"], "不能丢失的草稿")
        self.assertEqual(detail["intake"]["image_count"], 1)
        self.assertEqual(len(detail["attachments"]), 1)
        _, client = self.restart()
        restored = client.get(f"/api/conversations/{cid}").get_json()["conversation"]
        self.assertEqual(restored["intake"]["text"], "不能丢失的草稿")
        self.assertEqual(restored["intake"]["image_count"], 1)
        self.assertEqual(len(restored["attachments"]), 1)

    def test_reset_keeps_history_collections_and_attachments(self):
        cid = self.create("要保留的历史")["id"]
        self.assertEqual(self.chat("重置前的问题", conversation_id=cid).status_code, 200)
        self.assertEqual(self.upload(cid, (BytesIO(image_bytes()), "kept.png")).status_code, 200)
        collection = self.client.post("/api/collections", json={"name": "保留集合"}).get_json()["collection"]
        self.assertEqual(self.client.patch(f"/api/conversations/{cid}",
                                           json={"intake_text": "保留草稿",
                                                 "collection_id": collection["id"]}).status_code, 200)
        self.assertEqual(self.client.post("/api/reset").status_code, 200)

        _, client = self.restart()
        listing = client.get("/api/conversations").get_json()
        self.assertEqual([item["id"] for item in listing["conversations"]], [cid])
        self.assertEqual(listing["active"], cid)
        self.assertEqual([item["name"] for item in listing["collections"]], ["保留集合"])
        detail = client.get(f"/api/conversations/{cid}").get_json()["conversation"]
        self.assertEqual([item["text"] for item in detail["messages"]], ["重置前的问题", "完成"])
        self.assertEqual(detail["intake"]["text"], "保留草稿")
        self.assertEqual(detail["collection_id"], collection["id"])
        self.assertEqual([item["name"] for item in detail["attachments"]], ["kept.png"])
        self.assertEqual(client.get(detail["attachments"][0]["preview_url"]).status_code, 200)

    def test_collections_create_move_unfile_and_restart(self):
        cid = self.create()["id"]
        first = self.client.post("/api/collections", json={"name": "错题"}).get_json()["collection"]
        second = self.client.post("/api/collections", json={"name": "笔记"}).get_json()["collection"]
        self.assertEqual(self.client.post("/api/collections", json={"name": "错题"}).status_code, 400)
        self.assertEqual(self.client.post("/api/collections", json={"name": " "}).status_code, 400)
        self.assertEqual(self.client.post("/api/collections", json={"name": "长" * 41}).status_code, 400)

        self.assertEqual(self.client.post(f"/api/conversations/{cid}/move",
                                          json={"collection_id": first["id"]}).status_code, 200)
        listing = self.conversations()
        self.assertEqual(next(item for item in listing["conversations"] if item["id"] == cid)["collection_id"],
                         first["id"])
        self.assertEqual({item["name"]: item["conversation_count"] for item in listing["collections"]},
                         {"错题": 1, "笔记": 0})

        self.assertEqual(self.client.post(f"/api/conversations/{cid}/move",
                                          json={"collection_id": second["id"]}).status_code, 200)
        self.assertEqual(self.client.post(f"/api/conversations/{cid}/move",
                                          json={"collection_id": None}).status_code, 200)
        self.assertIsNone(self.detail(cid)["collection_id"])
        self.assertEqual(self.client.post(f"/api/conversations/{cid}/move",
                                          json={"collection_id": "missing"}).status_code, 404)
        self.assertEqual(self.client.patch(f"/api/conversations/{cid}",
                                           json={"unknown": 1}).status_code, 400)

        self.assertEqual(self.client.patch(f"/api/conversations/{cid}",
                                           json={"collection_id": second["id"]}).status_code, 200)
        _, client = self.restart()
        detail = client.get(f"/api/conversations/{cid}").get_json()["conversation"]
        self.assertEqual(detail["collection_id"], second["id"])
        self.assertEqual([item["name"] for item in client.get("/api/collections").get_json()["collections"]],
                         ["错题", "笔记"])

    def test_failed_persistence_does_not_corrupt_history(self):
        collection = self.client.post("/api/collections", json={"name": "保留"}).get_json()["collection"]
        cid = self.create("保留对话")["id"]
        history = self.app.extensions["web_history"]
        with patch.object(history, "save_conversation", side_effect=OSError("disk full")):
            failed_create = self.client.post("/api/conversations", json={})
            self.assertEqual(failed_create.status_code, 500, failed_create.get_json())
            failed_move = self.client.patch(f"/api/conversations/{cid}",
                                            json={"collection_id": collection["id"]})
            self.assertEqual(failed_move.status_code, 500, failed_move.get_json())
        listing = self.conversations()
        self.assertEqual(len(listing["conversations"]), 2)
        self.assertIsNone(self.detail(cid)["collection_id"])
        _, client = self.restart()
        self.assertIsNone(client.get(f"/api/conversations/{cid}").get_json()["conversation"]["collection_id"])

    def test_failed_upload_preserves_previous_materials_and_draft(self):
        from llm import ModelError
        cid = self.create()["id"]
        self.assertEqual(self.upload(cid, (BytesIO(image_bytes()), "kept.png")).status_code, 200)
        self.assertEqual(self.client.patch(f"/api/conversations/{cid}",
                                           json={"intake_text": "已经接受的草稿"}).status_code, 200)
        before = self.detail(cid)
        with patch.object(ImageReader, "read", side_effect=ModelError("模拟识别失败")):
            failed = self.upload(cid, (BytesIO(image_bytes()), "failed.png"))
        self.assertEqual(failed.status_code, 502, failed.get_json())
        after = self.detail(cid)
        self.assertEqual(after["intake"]["text"], before["intake"]["text"])
        self.assertEqual(after["intake"]["image_ids"], before["intake"]["image_ids"])
        self.assertEqual(len(after["attachments"]), 1)
        _, client = self.restart()
        restored = client.get(f"/api/conversations/{cid}").get_json()["conversation"]
        self.assertEqual(restored["intake"]["text"], "已经接受的草稿")
        self.assertEqual(restored["intake"]["image_count"], 1)
        self.assertEqual([item["name"] for item in restored["attachments"]], ["kept.png"])

    def write_legacy(self, payload, conversation_id, meta_extra=None):
        history = self.app.extensions["web_history"]
        token = self.client.get_cookie(self.app.config["HISTORY_COOKIE_NAME"]).value
        base = history.user_directory(token)
        (base / "conversations").mkdir(parents=True, exist_ok=True)
        (base / "conversations" / f"{conversation_id}.json").write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        meta = {"active": conversation_id, "order": [conversation_id], "collections": []}
        meta.update(meta_extra or {})
        (base / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")

    def test_legacy_inline_images_are_migrated_and_placeholders_are_honest(self):
        legacy_id = "legacy-inline"
        self.write_legacy({
            "id": legacy_id, "title": "旧对话", "created_at": "2026-11-01T10:00:00+08:00",
            "updated_at": "2026-11-01T10:00:00+08:00",
            "messages": [{"role": "user", "content": "旧问题"},
                         {"role": "assistant", "content": "旧回答"},
                         {"role": "user", "content": "[图片]"}],
            "note_images": {"legacy-page": prepare_image(image_bytes())},
        }, legacy_id)
        _, client = self.restart()
        detail = client.get(f"/api/conversations/{legacy_id}").get_json()["conversation"]
        self.assertEqual([item["text"] for item in detail["messages"]],
                         ["旧问题", "旧回答", "[图片]"])
        self.assertEqual(detail["intake"]["image_count"], 1)
        attachment = detail["attachments"][0]
        self.assertTrue(attachment["legacy"])
        self.assertTrue(attachment["available"])
        self.assertEqual(client.get(attachment["thumbnail_url"]).status_code, 200)

    def test_legacy_placeholder_records_are_reported_without_faking_content(self):
        legacy_id = "legacy-placeholder"
        self.write_legacy({
            "id": legacy_id, "title": "只有占位", "created_at": "2026-11-01T10:00:00+08:00",
            "updated_at": "2026-11-01T10:00:00+08:00",
            "messages": [{"role": "user", "content": "当时上传了图片 [图片]"}],
            "page_ids": [],
            "attachments": [{"id": "gone", "kind": "image", "name": "旧图片",
                             "placeholder": True, "available": False}],
        }, legacy_id)
        _, client = self.restart()
        detail = client.get(f"/api/conversations/{legacy_id}").get_json()["conversation"]
        self.assertEqual(detail["intake"]["image_ids"], [])
        self.assertEqual(len(detail["attachments"]), 1)
        item = detail["attachments"][0]
        self.assertFalse(item["available"])
        self.assertTrue(item["placeholder"])
        self.assertIn("占位", client.get(item["thumbnail_url"]).get_json()["error"])
        self.assertEqual(client.get(item["preview_url"]).status_code, 404)

    def test_corrupt_legacy_file_does_not_break_history(self):
        legacy_id = "legacy-inline"
        self.write_legacy({"id": legacy_id, "title": "可读旧记录",
                           "messages": [{"role": "user", "content": "还在"}],
                           "page_ids": [], "attachments": []}, legacy_id)
        history = self.app.extensions["web_history"]
        token = self.client.get_cookie(self.app.config["HISTORY_COOKIE_NAME"]).value
        broken = history.user_directory(token) / "conversations" / "broken.json"
        broken.parent.mkdir(parents=True, exist_ok=True)
        broken.write_text("{broken", encoding="utf-8")
        _, client = self.restart()
        listing = client.get("/api/conversations").get_json()
        self.assertIn(legacy_id, [item["id"] for item in listing["conversations"]])
        self.assertEqual(client.get(f"/api/conversations/{legacy_id}").status_code, 200)


    def test_cancel_during_upload_keeps_previously_accepted_materials(self):
        cid = self.create()["id"]
        self.assertEqual(self.upload(cid, (BytesIO(image_bytes()), "kept.png")).status_code, 200)
        self.assertEqual(self.client.patch(f"/api/conversations/{cid}",
                                           json={"intake_text": "上传中断后保留"}).status_code, 200)
        before = self.detail(cid)
        started = threading.Event()

        def slow_read(reader, raw, cancel_token=None):
            started.set()
            deadline = time.monotonic() + 5
            while not cancel_token.cancelled and time.monotonic() < deadline:
                time.sleep(.01)
            cancel_token.check()
            return "不应写入"

        results = []
        with patch.object(ImageReader, "read", slow_read):
            worker = threading.Thread(target=lambda: results.append(
                self.upload(cid, (BytesIO(image_bytes()), "partial.png"),
                            client=self.second_client(), request_id="upload-cancel")))
            worker.start()
            self.assertTrue(started.wait(2), "上传没有进入识别等待")
            cancelled = self.second_client().post("/api/cancel", json={"request_id": "upload-cancel"})
            self.assertEqual(cancelled.status_code, 200, cancelled.get_json())
            worker.join(5)
            self.assertFalse(worker.is_alive())
        self.assertEqual(results[0].status_code, 499, results[0].get_json())
        after = self.detail(cid)
        self.assertEqual(after["intake"]["image_ids"], before["intake"]["image_ids"])
        self.assertEqual(after["intake"]["text"], "上传中断后保留")
        self.assertEqual([item["name"] for item in after["attachments"]], ["kept.png"])
        _, client = self.restart()
        restored = client.get(f"/api/conversations/{cid}").get_json()["conversation"]
        self.assertEqual(restored["intake"]["image_count"], 1)
        self.assertEqual(restored["intake"]["text"], "上传中断后保留")


class ConversationPersistenceCancelTests(ConversationTestCase):
    model_class = SlowModel

    def setUp(self):
        super().setUp()
        self.model.started.clear()

    def test_cancel_keeps_accepted_attachment_draft_and_history_after_restart(self):
        cid = self.create()["id"]
        self.assertEqual(self.upload(cid, (BytesIO(image_bytes()), "kept.png")).status_code, 200)
        self.assertEqual(self.client.patch(f"/api/conversations/{cid}",
                                           json={"intake_text": "停止后仍保留"}).status_code, 200)
        result = []
        worker = threading.Thread(target=lambda: result.append(self.chat(
            "等待停止", conversation_id=cid, client=self.second_client(), request_id="persist-cancel")))
        worker.start()
        self.assertTrue(self.model.started.wait(2), "慢请求没有进入模型等待")
        self.assertEqual(self.second_client().post("/api/cancel",
                                                   json={"request_id": "persist-cancel"}).status_code, 200)
        worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(result[0].status_code, 499, result[0].get_json())

        _, client = self.restart()
        detail = client.get(f"/api/conversations/{cid}").get_json()["conversation"]
        self.assertEqual([item["role"] for item in detail["messages"]], ["user", "notice"])
        self.assertIn("已停止本轮", detail["messages"][1]["text"])
        self.assertEqual(detail["intake"]["text"], "停止后仍保留")
        self.assertEqual(len(detail["attachments"]), 1)
        self.assertEqual(client.get(detail["attachments"][0]["thumbnail_url"]).status_code, 200)




if __name__ == "__main__":
    unittest.main()
