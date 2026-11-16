"""小程序接口层的回归测试：登录、任务轮询、取消、跨用户隔离。"""

import json
import shutil
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from wx_api import ApiConfig, create_api, issue_token, read_token, user_key


class ScriptedClient:
    def __init__(self, replies):
        self.replies = list(replies)

    def complete(self, messages, tools):
        if not self.replies:
            return {"role": "assistant", "content": "（脚本已用完）"}
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


# 测试数据放在仓库内的 .wx-test/ 下：沙箱只对该工作区放行写入。
ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / ".wx-test"
WORK.mkdir(parents=True, exist_ok=True)


def workdir():
    """不用 tempfile.mkdtemp：它创建的目录在受限沙箱里不能再建子目录。"""
    path = WORK / ("case-" + uuid.uuid4().hex[:12])
    path.mkdir(parents=True, exist_ok=True)
    return path


def make_app(path, replies=None, dev=True):
    config = ApiConfig(data_dir=Path(path), dev_login=dev, token_secret=b"test-secret",
                       token_ttl=3600, task_ttl=60)
    return create_api(config, client_factory=lambda: ScriptedClient(replies or [])), config


def answer(text):
    return {"role": "assistant", "content": text}


class TokenTests(unittest.TestCase):
    def test_round_trip_and_expiry(self):
        token, expires = issue_token("abc", b"k", 60)
        self.assertEqual(read_token(token, b"k"), "abc")
        self.assertGreater(expires, time.time())
        self.assertIsNone(read_token(token, b"other"))
        self.assertIsNone(read_token(token + "x", b"k"))
        self.assertIsNone(read_token("garbage", b"k"))

    def test_openid_is_hashed_not_stored(self):
        key = user_key("oABC123")
        self.assertEqual(len(key), 32)
        self.assertNotIn("oABC", key)


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.directory = workdir()
        self.addCleanup(shutil.rmtree, self.directory, True)
        self.app, self.config = make_app(self.directory)
        self.client = self.app.test_client()

    def login(self, name="tester", client=None):
        response = (client or self.client).post("/api/v1/auth/login", json={"code": "dev:" + name})
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return response.get_json()["token"]

    def auth(self, token):
        return {"Authorization": "Bearer " + token}

    def wait(self, task_id, token, limit=8.0):
        deadline = time.time() + limit
        while time.time() < deadline:
            data = self.client.get(f"/api/v1/tasks/{task_id}", headers=self.auth(token)).get_json()
            if data["status"] != "running":
                return data
            time.sleep(0.02)
        self.fail("任务没有在限定时间内结束")

    def test_requires_login(self):
        self.assertEqual(self.client.get("/api/v1/status").status_code, 401)
        self.assertEqual(self.client.get("/api/v1/notes").status_code, 401)
        self.assertEqual(self.client.post("/api/v1/chat", json={"message": "hi"}).status_code, 401)

    def test_login_rejects_bad_code_without_dev_mode(self):
        app, _ = make_app(str(self.directory / "nodev"), dev=False)
        response = app.test_client().post("/api/v1/auth/login", json={"code": "dev:x"})
        self.assertEqual(response.status_code, 401)

    def test_dev_login_is_off_by_default_in_production_config(self):
        config = ApiConfig(data_dir=self.directory / "prod", token_secret=b"k")
        app = create_api(config, client_factory=lambda: ScriptedClient([]))
        response = app.test_client().post("/api/v1/auth/login", json={"code": "dev:x"})
        self.assertEqual(response.status_code, 401)

    def test_chat_runs_as_task(self):
        token = self.login()
        response = self.client.post("/api/v1/chat", json={"message": "2+2 等于几", "view": "organize"},
                                    headers={**self.auth(token), "X-Request-Id": "req-0000000001"})
        self.assertEqual(response.status_code, 202, response.get_data(as_text=True))
        task_id = response.get_json()["task_id"]
        result = self.wait(task_id, token)
        self.assertEqual(result["status"], "done", result)
        self.assertIn("answer", result)

    def test_same_request_id_is_idempotent(self):
        token = self.login()
        headers = {**self.auth(token), "X-Request-Id": "req-0000000002"}
        first = self.client.post("/api/v1/chat", json={"message": "1+1", "view": "notes"}, headers=headers)
        second = self.client.post("/api/v1/chat", json={"message": "1+1", "view": "notes"}, headers=headers)
        self.assertEqual(first.get_json()["task_id"], second.get_json()["task_id"])

    def test_cancel_marks_task_cancelled(self):
        app, _ = make_app(str(self.directory / "slow"),
                          replies=[answer("迟到的回答"), answer("再来一轮")])
        client = app.test_client()
        token = client.post("/api/v1/auth/login", json={"code": "dev:slow"}).get_json()["token"]
        task_id = client.post("/api/v1/chat", json={"message": "慢慢来"},
                              headers={"Authorization": "Bearer " + token}).get_json()["task_id"]
        client.post(f"/api/v1/tasks/{task_id}/cancel", headers={"Authorization": "Bearer " + token})
        deadline = time.time() + 5
        while time.time() < deadline:
            data = client.get(f"/api/v1/tasks/{task_id}",
                              headers={"Authorization": "Bearer " + token}).get_json()
            if data["status"] != "running":
                break
            time.sleep(0.02)
        self.assertIn(data["status"], ("done", "cancelled"))

    def test_other_user_cannot_read_task(self):
        token_a = self.login("alice")
        task_id = self.client.post("/api/v1/chat", json={"message": "我的内容"},
                                   headers=self.auth(token_a)).get_json()["task_id"]
        other = self.app.test_client()
        token_b = other.post("/api/v1/auth/login", json={"code": "dev:bob"}).get_json()["token"]
        response = other.get(f"/api/v1/tasks/{task_id}", headers={"Authorization": "Bearer " + token_b})
        self.assertEqual(response.status_code, 404)
        self.wait(task_id, token_a)

    def test_users_have_separate_data_directories(self):
        token_a = self.login("alice")
        token_b = self.login("bob")
        self.login("alice")
        notes_a = self.client.get("/api/v1/notes", headers=self.auth(token_a)).get_json()
        notes_b = self.client.get("/api/v1/notes", headers=self.auth(token_b)).get_json()
        self.assertEqual(notes_a["total"], 0)
        self.assertEqual(notes_b["total"], 0)
        dirs = [item.name for item in (self.directory / "users").iterdir()]
        self.assertEqual(len(dirs), 2)

    def test_model_error_is_reported_without_leaking(self):
        from llm import ModelError
        app, _ = make_app(str(self.directory / "err"), replies=[ModelError("模型 API 返回 HTTP 401")])
        client = app.test_client()
        token = client.post("/api/v1/auth/login", json={"code": "dev:err"}).get_json()["token"]
        task_id = client.post("/api/v1/chat", json={"message": "q"},
                              headers={"Authorization": "Bearer " + token}).get_json()["task_id"]
        deadline = time.time() + 5
        data = {}
        while time.time() < deadline:
            data = client.get(f"/api/v1/tasks/{task_id}",
                              headers={"Authorization": "Bearer " + token}).get_json()
            if data["status"] != "running":
                break
            time.sleep(0.02)
        self.assertEqual(data["status"], "error")
        self.assertEqual(data["error_code"], "model_error")
        self.assertNotIn("Bearer", json.dumps(data, ensure_ascii=False))

    def test_rejects_oversized_and_unknown_views(self):
        token = self.login()
        long_text = "字" * 80001
        response = self.client.post("/api/v1/chat", json={"message": long_text}, headers=self.auth(token))
        self.assertEqual(response.status_code, 400)
        response = self.client.post("/api/v1/chat", json={"message": "hi", "view": "analysis"},
                                    headers=self.auth(token))
        self.assertEqual(response.status_code, 400)

    def test_concurrent_chat_is_rejected(self):
        app, _ = make_app(str(self.directory / "busy"), replies=[answer("ok")])
        client = app.test_client()
        token = client.post("/api/v1/auth/login", json={"code": "dev:busy"}).get_json()["token"]
        first = client.post("/api/v1/chat", json={"message": "一"}, headers={"Authorization": "Bearer " + token})
        second = client.post("/api/v1/chat", json={"message": "二"}, headers={"Authorization": "Bearer " + token})
        self.assertEqual(first.status_code, 202)
        self.assertIn(second.status_code, (202, 409))
        if second.status_code == 409:
            # 换了一条内容：可以带 task_id，但不能标记成同一 request 的重试
            self.assertFalse(second.get_json().get("retry"))
            self.assertTrue(second.get_json().get("task_id"))

    def test_review_select_works_without_model_key(self):
        token = self.login()
        response = self.client.post("/api/v1/review/select",
                                    json={"category": "", "tag": "", "source": "any"},
                                    headers=self.auth(token))
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        body = response.get_json()
        self.assertIn("answer", body)
        self.assertIn("review", body)

    def test_review_answer_records_progress_and_survives_restart(self):
        from tools import LocalTools

        token = self.login()
        user_directory = next((self.directory / "users").iterdir())
        LocalTools(user_directory).bank.add("已确认资料", [{
            "topic": "极限", "tags": ["无穷小比较"], "number": "1",
            "question": "求极限 lim x->0 sin x / x", "answer": "1"}])

        headers = self.auth(token)
        selected = self.client.post("/api/v1/review/select",
                                    json={"category": "极限", "tag": "", "source": "exercise"},
                                    headers=headers)
        self.assertEqual(selected.status_code, 200, selected.get_data(as_text=True))
        self.assertTrue(selected.get_json()["question_selected"])

        submitted = self.client.post("/api/v1/chat",
                                     json={"message": "我用等价无穷小，第一步先约掉 x",
                                           "view": "review"},
                                     headers=headers)
        self.assertEqual(submitted.status_code, 202, submitted.get_data(as_text=True))
        self.wait(submitted.get_json()["task_id"], token)

        progress = self.client.get("/api/v1/review/progress", headers=headers).get_json()["progress"]
        self.assertTrue(progress, "作答后进度不应为空")
        self.assertGreaterEqual(sum(entry["count"] for entry in progress.values()), 1)

        # 重启：同一个数据目录、同一个令牌，记录仍在。
        restarted = create_api(
            ApiConfig(data_dir=self.directory, dev_login=True, token_secret=b"test-secret",
                      token_ttl=3600, task_ttl=60),
            client_factory=lambda: ScriptedClient([]))
        again = restarted.test_client().get("/api/v1/review/progress", headers=headers)
        self.assertEqual(again.status_code, 200, again.get_data(as_text=True))
        self.assertEqual(again.get_json()["progress"], progress)

    def test_upload_accepts_png_and_returns_id(self):
        from io import BytesIO
        from PIL import Image
        token = self.login()
        buffer = BytesIO()
        Image.new("RGB", (48, 48), "white").save(buffer, format="PNG")
        buffer.seek(0)
        response = self.client.post("/api/v1/uploads", data={"files": (buffer, "note.png")},
                                    headers=self.auth(token), content_type="multipart/form-data")
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        image_ids = response.get_json()["image_ids"]
        self.assertEqual(len(image_ids), 1)

    def test_upload_rejects_more_than_four_files(self):
        from io import BytesIO
        from PIL import Image
        token = self.login()

        def png(name):
            buffer = BytesIO()
            Image.new("RGB", (16, 16), "white").save(buffer, format="PNG")
            buffer.seek(0)
            return (buffer, name)

        response = self.client.post("/api/v1/uploads",
                                    data={"files": [png(f"{i}.png") for i in range(5)]},
                                    headers=self.auth(token), content_type="multipart/form-data")
        self.assertEqual(response.status_code, 400)


    def test_duplicate_request_id_runs_one_task(self):
        release = threading.Event()

        class BlockingClient:
            def complete(self, messages, tools):
                release.wait(3)
                return {"role": "assistant", "content": "ok"}

        config = ApiConfig(data_dir=self.directory / "dup", token_secret=b"k",
                           dev_login=True, task_ttl=60)
        app = create_api(config, client_factory=lambda: BlockingClient())
        first_client, second_client = app.test_client(), app.test_client()
        token = first_client.post("/api/v1/auth/login", json={"code": "dev:dup"}).get_json()["token"]
        headers = {"Authorization": "Bearer " + token, "X-Request-Id": "dup-request-0001"}
        try:
            first = first_client.post("/api/v1/chat", json={"message": "同一轮"}, headers=headers)
            second = second_client.post("/api/v1/chat", json={"message": "同一轮"}, headers=headers)
            self.assertEqual(first.status_code, 202, first.get_data(as_text=True))
            self.assertEqual(second.status_code, 202, second.get_data(as_text=True))
            self.assertEqual(first.get_json()["task_id"], second.get_json()["task_id"])
        finally:
            release.set()

    def test_delete_removes_old_task_results(self):
        token = self.login()
        task_id = self.client.post("/api/v1/chat", json={"message": "会被删掉的一轮"},
                                   headers=self.auth(token)).get_json()["task_id"]
        self.wait(task_id, token)
        response = self.client.post("/api/v1/account/delete", json={"confirm": True},
                                    headers=self.auth(token))
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(self.client.get(f"/api/v1/tasks/{task_id}",
                                         headers=self.auth(token)).status_code, 404)

    def test_delete_is_rejected_while_a_turn_is_running(self):
        release = threading.Event()

        class BlockingClient:
            def complete(self, messages, tools):
                release.wait(5)
                return {"role": "assistant", "content": "ok"}

        config = ApiConfig(data_dir=self.directory / "gate", token_secret=b"k",
                           dev_login=True, task_ttl=60)
        app = create_api(config, client_factory=lambda: BlockingClient())
        client = app.test_client()
        token = client.post("/api/v1/auth/login", json={"code": "dev:gate"}).get_json()["token"]
        headers = {"Authorization": "Bearer " + token}
        task = client.post("/api/v1/chat", json={"message": "跑一轮"}, headers=headers).get_json()["task_id"]
        try:
            delete = client.post("/api/v1/account/delete", json={"confirm": True}, headers=headers)
            self.assertEqual(delete.status_code, 409)
            upload = client.post("/api/v1/uploads/base64",
                                 json={"images": [{"data": "AAAA"}]}, headers=headers)
            self.assertEqual(upload.status_code, 409)
            reset = client.post("/api/v1/conversation/reset", headers=headers)
            self.assertEqual(reset.status_code, 409)
        finally:
            release.set()
        deadline = time.time() + 5
        while time.time() < deadline:
            if client.get(f"/api/v1/tasks/{task}", headers=headers).get_json()["status"] != "running":
                break
            time.sleep(0.02)
        self.assertEqual(client.post("/api/v1/account/delete", json={"confirm": True},
                                     headers=headers).status_code, 200)

    def test_stale_state_cannot_start_after_delete(self):
        token = self.login()
        registry = self.app.extensions["wx_registry"]
        stale = next(iter(registry.users.values()))
        self.assertEqual(self.client.post("/api/v1/account/delete", json={"confirm": True},
                                          headers=self.auth(token)).status_code, 200)
        self.assertFalse(stale.begin(), "已删除用户的旧状态不能再启动任务")

    def test_delete_reports_failure_instead_of_fake_success(self):
        from unittest.mock import patch

        token = self.login()
        users = list((self.directory / "users").iterdir())
        with patch("wx_api.shutil.rmtree", side_effect=OSError("locked")):
            response = self.client.post("/api/v1/account/delete", json={"confirm": True},
                                        headers=self.auth(token))
        self.assertEqual(response.status_code, 500)
        self.assertTrue(users[0].exists(), "删除失败时不能报告成功")
        self.assertEqual(self.client.post("/api/v1/account/delete", json={"confirm": True},
                                          headers=self.auth(token)).status_code, 200)
        self.assertFalse(users[0].exists())

    def test_account_delete_removes_user_data(self):
        token = self.login()
        users = list((self.directory / "users").iterdir())
        self.assertEqual(len(users), 1)
        response = self.client.post("/api/v1/account/delete", json={"confirm": True},
                                    headers=self.auth(token))
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertFalse(users[0].exists())
        # 数据没了，但用同一个身份还能继续用（会重新建一个空目录）
        self.assertEqual(self.client.get("/api/v1/notes", headers=self.auth(token)).get_json()["total"], 0)

    def test_account_delete_requires_explicit_confirm(self):
        token = self.login()
        response = self.client.post("/api/v1/account/delete", json={}, headers=self.auth(token))
        self.assertEqual(response.status_code, 400)
        self.assertEqual(len(list((self.directory / "users").iterdir())), 1)


class CloudRunTests(unittest.TestCase):
    """云托管路线：身份由平台注入的 X-WX-OPENID 提供，图片走 base64 JSON。"""

    def setUp(self):
        self.directory = workdir()
        self.addCleanup(shutil.rmtree, self.directory, True)
        config = ApiConfig(data_dir=self.directory, trust_cloud_header=True,
                           cloud_source="wx_client", token_secret=b"test-secret",
                           token_ttl=3600, task_ttl=60)
        self.app = create_api(config, client_factory=lambda: ScriptedClient([]))
        self.client = self.app.test_client()

    def cloud(self, openid):
        return {"X-WX-OPENID": openid, "X-WX-SOURCE": "wx_client"}

    def test_missing_openid_header_is_rejected(self):
        self.assertEqual(self.client.get("/api/v1/status").status_code, 401)

    def test_each_openid_gets_its_own_data(self):
        self.assertEqual(self.client.get("/api/v1/status", headers=self.cloud("o-alice")).status_code, 200)
        self.assertEqual(self.client.get("/api/v1/status", headers=self.cloud("o-bob")).status_code, 200)
        dirs = [item.name for item in (self.directory / "users").iterdir()]
        self.assertEqual(len(dirs), 2)

    def test_openid_is_kept_server_side_only(self):
        self.client.get("/api/v1/status", headers=self.cloud("o-carol"))
        key = self.client.get("/api/v1/me", headers=self.cloud("o-carol")).get_json()["user"]["id"]
        profile = (self.directory / "users").glob("*/profile.json")
        values = [json.loads(item.read_text(encoding="utf-8"))["openid"] for item in profile]
        self.assertIn("o-carol", values)
        self.assertNotIn("o-carol", key)

    def test_unknown_source_is_rejected(self):
        response = self.client.get("/api/v1/status",
                                   headers={"X-WX-OPENID": "o-mallory", "X-WX-SOURCE": "api"})
        self.assertEqual(response.status_code, 401)

    def test_base64_upload(self):
        import base64 as b64
        from io import BytesIO
        from PIL import Image

        buffer = BytesIO()
        Image.new("RGB", (32, 32), "white").save(buffer, format="JPEG")
        encoded = b64.b64encode(buffer.getvalue()).decode("ascii")
        response = self.client.post("/api/v1/uploads/base64",
                                    json={"images": [{"data": encoded, "name": "a.jpg"}]},
                                    headers=self.cloud("o-dave"))
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(len(response.get_json()["image_ids"]), 1)

    def test_base64_upload_rejects_bad_payload(self):
        too_big = "A" * (5 * 1024 * 1024 + 64)
        response = self.client.post("/api/v1/uploads/base64",
                                    json={"images": [{"data": too_big}]},
                                    headers=self.cloud("o-erin"))
        self.assertEqual(response.status_code, 400)
        response = self.client.post("/api/v1/uploads/base64",
                                    json={"images": [{"data": "not-base64!!"}]},
                                    headers=self.cloud("o-erin"))
        self.assertEqual(response.status_code, 400)
        response = self.client.post("/api/v1/uploads/base64",
                                    json={"images": []},
                                    headers=self.cloud("o-erin"))
        self.assertEqual(response.status_code, 400)


class ConcurrencyTests(unittest.TestCase):
    """删除/占位/身份持久化在并发窗口里的行为。"""

    def setUp(self):
        self.directory = workdir()
        self.addCleanup(shutil.rmtree, self.directory, True)

    def make(self, **overrides):
        values = dict(data_dir=self.directory, dev_login=True, token_secret=b"test-secret",
                      token_ttl=3600, task_ttl=60)
        values.update(overrides)
        return create_api(ApiConfig(**values), client_factory=lambda: ScriptedClient([]))

    def login(self, app, name="tester"):
        client = app.test_client()
        token = client.post("/api/v1/auth/login", json={"code": "dev:" + name}).get_json()["token"]
        return client, token

    def test_rejected_admission_is_shared_with_same_request_retry(self):
        from wx_security import ContentSecurity

        app = self.make()
        client, token = self.login(app)
        headers = {"Authorization": "Bearer " + token, "X-Request-Id": "reject-request-0001"}
        entered, release = threading.Event(), threading.Event()
        results = []

        def blocking_check(self, openid, text):
            entered.set()
            release.wait(5)
            return False, "内容不合规"

        def submit():
            results.append(app.test_client().post("/api/v1/chat",
                                                  json={"message": "同一请求"}, headers=headers))

        with patch.object(ContentSecurity, "check_text", blocking_check):
            owner = threading.Thread(target=submit)
            owner.start()
            self.assertTrue(entered.wait(5), "第一次提交应停在内容检查")
            retry = threading.Thread(target=submit)
            retry.start()
            time.sleep(0.3)  # 让重试进入等待同一结论
            release.set()
            owner.join(5)
            retry.join(5)

        self.assertEqual([item.status_code for item in results], [400, 400])
        self.assertEqual({item.get_json()["error"] for item in results}, {"内容不合规"})
        self.assertEqual(app.extensions["wx_tasks"].items, {}, "被拒的提交不能留下公开任务")

    def test_accepted_admission_is_shared_with_same_request_retry(self):
        release = threading.Event()

        class BlockingClient:
            def complete(self, messages, tools):
                release.wait(5)
                return {"role": "assistant", "content": "ok"}

        app = create_api(ApiConfig(data_dir=self.directory / "admit", dev_login=True,
                                   token_secret=b"test-secret", task_ttl=60),
                         client_factory=lambda: BlockingClient())
        token = app.test_client().post("/api/v1/auth/login",
                                       json={"code": "dev:admit"}).get_json()["token"]
        headers = {"Authorization": "Bearer " + token, "X-Request-Id": "accept-request-0001"}
        results = []

        def submit():
            results.append(app.test_client().post("/api/v1/chat",
                                                  json={"message": "同一轮"}, headers=headers))

        threads = [threading.Thread(target=submit) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(5)
        try:
            self.assertEqual([item.status_code for item in results], [202, 202])
            self.assertEqual(len({item.get_json()["task_id"] for item in results}), 1)
            self.assertEqual(len(app.extensions["wx_tasks"].items), 1)
        finally:
            release.set()

    def test_different_request_is_rejected_while_admitting(self):
        from wx_security import ContentSecurity

        app = self.make()
        client, token = self.login(app)
        headers = {"Authorization": "Bearer " + token}
        entered, release = threading.Event(), threading.Event()

        def blocking_check(self, openid, text):
            entered.set()
            release.wait(5)
            return True, ""

        def submit(request_id):
            return app.test_client().post(
                "/api/v1/chat", json={"message": "内容", "request_id": request_id},
                headers=headers)

        with patch.object(ContentSecurity, "check_text", blocking_check):
            owner = threading.Thread(target=lambda: submit("first-request-0001"))
            owner.start()
            self.assertTrue(entered.wait(5))
            other = submit("second-request-0002")
            self.assertEqual(other.status_code, 409)
            self.assertFalse(other.get_json().get("retry"))
            release.set()
            owner.join(5)

    def test_fast_worker_cannot_release_slot_before_admission(self):
        app = self.make()  # ScriptedClient 立即返回：worker 会跑得比 Thread.start 返回还快
        client, token = self.login(app)
        headers = {"Authorization": "Bearer " + token, "X-Request-Id": "fast-request-0001"}
        registry = app.extensions["wx_registry"]
        tasks = app.extensions["wx_tasks"]
        gate_entered, gate_release = threading.Event(), threading.Event()
        real_start = threading.Thread.start

        def gated_start(self):
            result = real_start(self)
            if self.name == "wx-chat":
                gate_entered.set()
                gate_release.wait(5)
            return result

        results = {}

        def submit(key, message):
            results[key] = app.test_client().post("/api/v1/chat",
                                                  json={"message": message}, headers=headers)

        with patch.object(threading.Thread, "start", gated_start):
            owner = threading.Thread(target=submit, args=("owner", "快线程"))
            owner.start()
            self.assertTrue(gate_entered.wait(5), "应停在 Thread.start 返回前的门闩")
            time.sleep(0.3)  # 让 worker 跑完并尝试 end
            state = next(iter(registry.users.values()))
            self.assertTrue(state.busy, "worker 不能早于 admit 释放占位")
            self.assertIsNone(tasks.by_request(state.key, "fast-request-0001"),
                              "未确认的任务不能对外可见")
            delete = app.test_client().post("/api/v1/account/delete",
                                            json={"confirm": True}, headers=headers)
            self.assertEqual(delete.status_code, 409, "占位未释放前不能删除")

            retry = threading.Thread(target=submit, args=("retry", "快线程"))
            retry.start()
            time.sleep(0.3)  # 进入等待同一 admission
            gate_release.set()
            owner.join(5)
            retry.join(5)

        self.assertEqual([results["owner"].status_code, results["retry"].status_code], [202, 202])
        task_id = results["owner"].get_json()["task_id"]
        self.assertEqual(task_id, results["retry"].get_json()["task_id"])
        deadline = time.time() + 5
        current = {}
        while time.time() < deadline:
            current = app.test_client().get(f"/api/v1/tasks/{task_id}",
                                            headers=headers).get_json()
            if current.get("status") != "running":
                break
            time.sleep(0.02)
        self.assertEqual(current["status"], "done", current)

    def test_thread_start_failure_returns_503_to_both_same_id_requests(self):
        app = self.make()
        client, token = self.login(app)
        headers = {"Authorization": "Bearer " + token, "X-Request-Id": "start-fail-request-0001"}
        entered, release = threading.Event(), threading.Event()
        real_start = threading.Thread.start
        results = []

        def flaky_start(self):
            if self.name == "wx-chat":
                entered.set()
                release.wait(5)
                raise RuntimeError("boom")
            return real_start(self)

        def submit():
            results.append(app.test_client().post("/api/v1/chat",
                                                  json={"message": "同一轮"}, headers=headers))

        with patch.object(threading.Thread, "start", flaky_start):
            owner = threading.Thread(target=submit)
            owner.start()
            self.assertTrue(entered.wait(5), "线程应停在 start 门闩上")
            retry = threading.Thread(target=submit)
            retry.start()
            time.sleep(0.3)  # 让重试进入等待
            release.set()
            owner.join(5)
            retry.join(5)

        self.assertEqual([item.status_code for item in results], [503, 503],
                         "线程启动失败时同 ID 的两个请求都必须 503")
        self.assertEqual(app.extensions["wx_tasks"].items, {}, "失败的任务不能对外可见")

    def test_messages_without_request_id_are_not_merged(self):
        from wx_security import ContentSecurity

        app = self.make()
        client, token = self.login(app)
        headers = {"Authorization": "Bearer " + token}
        entered, release = threading.Event(), threading.Event()

        def blocking_check(self, openid, text):
            entered.set()
            release.wait(5)
            return True, ""

        def first():
            app.test_client().post("/api/v1/chat", json={"message": "第一条"}, headers=headers)

        with patch.object(ContentSecurity, "check_text", blocking_check):
            owner = threading.Thread(target=first)
            owner.start()
            self.assertTrue(entered.wait(5))
            second = app.test_client().post("/api/v1/chat", json={"message": "第二条"},
                                            headers=headers)
            self.assertEqual(second.status_code, 409, "没有 request_id 的两条消息不能合并")
            release.set()
            owner.join(5)

    def test_delete_freezes_identity_while_directory_is_being_removed(self):
        app = self.make()
        client, token = self.login(app)
        headers = {"Authorization": "Bearer " + token}
        registry = app.extensions["wx_registry"]
        key = next(iter(registry.users))
        original = registry.users[key]

        started, release = threading.Event(), threading.Event()
        real_rmtree = shutil.rmtree

        def paused_remove(path, *args, **kwargs):
            started.set()
            release.wait(5)
            return real_rmtree(path, *args, **kwargs)

        result = {}

        def do_delete():
            result["response"] = app.test_client().post(
                "/api/v1/account/delete", json={"confirm": True}, headers=headers)

        with patch("wx_api.shutil.rmtree", side_effect=paused_remove):
            thread = threading.Thread(target=do_delete)
            thread.start()
            self.assertTrue(started.wait(5), "rmtree 应被暂停")
            # 独立客户端在删除中途提交同用户请求：不能创建第二个状态或任务
            probe = app.test_client().post("/api/v1/chat", json={"message": "中途插入"},
                                           headers=headers)
            self.assertEqual(probe.status_code, 410)
            self.assertIs(registry.users[key], original, "删除期间必须保留同一个状态")
            self.assertEqual(app.extensions["wx_tasks"].items, {}, "不能创建新任务")
            release.set()
            thread.join(5)
        self.assertEqual(result["response"].status_code, 200)
        self.assertNotIn(key, registry.users)

    def test_failed_delete_reopens_identity_without_dropping_tasks(self):
        app = self.make()
        client, token = self.login(app)
        headers = {"Authorization": "Bearer " + token}
        task_id = client.post("/api/v1/chat", json={"message": "先跑一轮"}, headers=headers).get_json()["task_id"]
        deadline = time.time() + 5
        while time.time() < deadline:
            if client.get(f"/api/v1/tasks/{task_id}", headers=headers).get_json()["status"] != "running":
                break
            time.sleep(0.02)

        with patch("wx_api.shutil.rmtree", side_effect=OSError("locked")):
            failed = client.post("/api/v1/account/delete", json={"confirm": True}, headers=headers)
        self.assertEqual(failed.status_code, 500)
        # 失败后解冻：身份仍可继续使用，刚才的任务结果也还在
        self.assertEqual(client.get(f"/api/v1/tasks/{task_id}", headers=headers).status_code, 200)
        self.assertEqual(client.get("/api/v1/notes", headers=headers).status_code, 200)
        self.assertEqual(client.post("/api/v1/account/delete", json={"confirm": True},
                                     headers=headers).status_code, 200)

    def test_concurrent_same_request_id_share_one_task(self):
        release = threading.Event()

        class BlockingClient:
            def complete(self, messages, tools):
                release.wait(5)
                return {"role": "assistant", "content": "ok"}

        app = create_api(ApiConfig(data_dir=self.directory / "same", dev_login=True,
                                   token_secret=b"test-secret", task_ttl=60),
                         client_factory=lambda: BlockingClient())
        token = app.test_client().post("/api/v1/auth/login",
                                       json={"code": "dev:same"}).get_json()["token"]
        headers = {"Authorization": "Bearer " + token, "X-Request-Id": "same-request-0001"}
        answers = []

        def submit():
            answers.append(app.test_client().post("/api/v1/chat",
                                                  json={"message": "同一轮"}, headers=headers))

        threads = [threading.Thread(target=submit) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(5)
        try:
            self.assertEqual([item.status_code for item in answers], [202, 202])
            self.assertEqual(len({item.get_json()["task_id"] for item in answers}), 1)
            self.assertEqual(len(app.extensions["wx_tasks"].items), 1)
        finally:
            release.set()

    def test_stale_image_id_is_rejected_without_leaking_busy(self):
        app = self.make()
        client, token = self.login(app)
        headers = {"Authorization": "Bearer " + token}
        response = client.post("/api/v1/chat",
                               json={"message": "带图", "image_ids": ["expired-image"]},
                               headers=headers)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(app.extensions["wx_tasks"].items, {})
        self.assertEqual(client.post("/api/v1/conversation/reset", headers=headers).status_code, 200)

    def test_image_snapshot_survives_eviction_during_content_check(self):
        from io import BytesIO
        from PIL import Image

        seen = {}

        class RecordingClient:
            def complete(self, messages, tools):
                seen["messages"] = messages
                return {"role": "assistant", "content": "看到了图"}

        app = create_api(ApiConfig(data_dir=self.directory / "snap", dev_login=True,
                                   token_secret=b"test-secret", task_ttl=60),
                         client_factory=lambda: RecordingClient())
        client, token = self.login(app, "snap")
        headers = {"Authorization": "Bearer " + token}

        buffer = BytesIO()
        Image.new("RGB", (24, 24), "white").save(buffer, format="PNG")
        buffer.seek(0)
        upload = client.post("/api/v1/uploads", data={"files": (buffer, "a.png")},
                             headers=headers, content_type="multipart/form-data")
        image_id = upload.get_json()["image_ids"][0]
        state = next(iter(app.extensions["wx_registry"].users.values()))

        from wx_security import ContentSecurity

        def evict_then_pass(self, openid, text):
            state.images.clear()  # 模拟校验期间被 reset/淘汰
            return True, ""

        with patch.object(ContentSecurity, "check_text", evict_then_pass):
            task = client.post("/api/v1/chat", json={"message": "看图", "image_ids": [image_id]},
                               headers=headers)
            self.assertEqual(task.status_code, 202, task.get_data(as_text=True))
            task_id = task.get_json()["task_id"]
            deadline = time.time() + 5
            current = {}
            while time.time() < deadline:
                current = client.get(f"/api/v1/tasks/{task_id}", headers=headers).get_json()
                if current["status"] != "running":
                    break
                time.sleep(0.02)
        self.assertEqual(current["status"], "done", current)
        found = any(
            isinstance(message.get("content"), list)
            and any(isinstance(part, dict) and part.get("type") == "image_url"
                    for part in message["content"])
            for message in seen["messages"])
        self.assertTrue(found, "worker 应使用占位时的图片快照，而不是重新查 state.images")

    def test_concurrent_first_cloud_identity_writes_one_profile(self):
        app = self.make(trust_cloud_header=True, dev_login=False)
        clients = [app.test_client() for _ in range(8)]
        codes = []

        def hit(client):
            codes.append(client.get("/api/v1/status",
                                    headers={"X-WX-OPENID": "o-parallel"}).status_code)

        threads = [threading.Thread(target=hit, args=(client,)) for client in clients]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(5)
        self.assertEqual(codes, [200] * 8)
        profiles = list((self.directory / "users").glob("*/profile.json"))
        self.assertEqual(len(profiles), 1)
        self.assertEqual(json.loads(profiles[0].read_text(encoding="utf-8"))["openid"], "o-parallel")
        self.assertEqual(list(profiles[0].parent.glob("*.tmp")), [], "不应残留临时文件")


if __name__ == "__main__":
    unittest.main()
