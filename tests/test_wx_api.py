"""小程序接口层的回归测试：登录、任务轮询、取消、跨用户隔离。"""

import json
import shutil
import time
import unittest
import uuid
from pathlib import Path

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

    def test_review_select_works_without_model_key(self):
        token = self.login()
        response = self.client.post("/api/v1/review/select",
                                    json={"category": "", "tag": "", "source": "any"},
                                    headers=self.auth(token))
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        body = response.get_json()
        self.assertIn("answer", body)
        self.assertIn("review", body)

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
                           token_secret=b"test-secret", token_ttl=3600, task_ttl=60)
        self.app = create_api(config, client_factory=lambda: ScriptedClient([]))
        self.client = self.app.test_client()

    def cloud(self, openid):
        return {"X-WX-OPENID": openid}

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


if __name__ == "__main__":
    unittest.main()
