"""小程序账号/设置接口的回归测试：默认账号、资料、个人模型 Key、删除与并发。"""

import json
import os
import shutil
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from wx_api import ApiConfig, create_api, user_key
from wx_account import USER_MODEL_BASE


ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / ".wx-test"
WORK.mkdir(parents=True, exist_ok=True)


def workdir():
    path = WORK / ("acct-" + uuid.uuid4().hex[:12])
    path.mkdir(parents=True, exist_ok=True)
    return path


class RecordingClient:
    def __init__(self):
        self.messages = []

    def complete(self, messages, tools=None):
        self.messages.append(messages)
        return {"role": "assistant", "content": "好的"}


def make_app(path, targets=None, factory="default", **overrides):
    values = dict(data_dir=Path(path), dev_login=True, token_secret=b"test-secret",
                  token_ttl=3600, task_ttl=60)
    values.update(overrides)
    log = [] if targets is None else targets

    def build(target):
        log.append(target)
        return RecordingClient()

    if factory == "default":
        factory = build
    return create_api(ApiConfig(**values), client_factory=factory), log


def png_bytes(size=64):
    from io import BytesIO
    from PIL import Image

    buffer = BytesIO()
    Image.new("RGB", (size, size), (80, 140, 110)).save(buffer, format="PNG")
    return buffer.getvalue()


def shared_settings(**overrides):
    """受控的管理员共享配置，避免测试去读真实环境变量或本机密钥。"""
    values = {
        "base_url": "https://api.deepseek.com",
        "ocr_backend": "auto",
        "model": "deepseek-v4-pro",
        "api_key": "",
        "ocr_base_url": "https://api.deepseek.com",
        "ocr_model": "deepseek-flash",
        "ocr_api_key": "",
    }
    values.update(overrides)
    return values


class AccountTests(unittest.TestCase):
    def setUp(self):
        self.directory = workdir()
        self.addCleanup(shutil.rmtree, self.directory, True)
        self.app, self.targets = make_app(self.directory)
        self.client = self.app.test_client()
        self.token = self.login(self.client, "alice")

    def login(self, client, name):
        response = client.post("/api/v1/auth/login", json={"code": "dev:" + name})
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return response.get_json()["token"]

    def auth(self, token=None):
        return {"Authorization": "Bearer " + (token or self.token)}

    def profile(self, client=None, token=None):
        response = (client or self.client).get("/api/v1/me/profile", headers=self.auth(token))
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return response.get_json()["profile"]

    def model(self):
        response = self.client.get("/api/v1/me/model", headers=self.auth())
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return response.get_json()["model"]

    def wait(self, task_id, limit=6.0):
        deadline = time.time() + limit
        while time.time() < deadline:
            data = self.client.get(f"/api/v1/tasks/{task_id}", headers=self.auth()).get_json()
            if data["status"] != "running":
                return data
            time.sleep(0.02)
        self.fail("任务没有在限定时间内结束")

    def chat(self, message="2+2", **extra):
        payload = {"message": message, "view": "organize", **extra}
        response = self.client.post("/api/v1/chat", json=payload, headers=self.auth())
        self.assertEqual(response.status_code, 202, response.get_data(as_text=True))
        return self.wait(response.get_json()["task_id"])

    # ---- 默认账号

    def test_first_open_creates_stable_default_account(self):
        first = self.profile()
        second = self.profile()
        self.assertEqual(first["nickname"], second["nickname"], "默认昵称必须稳定")
        self.assertTrue(first["nickname"].startswith("学习者"))
        self.assertTrue(first["default_nickname"])
        self.assertEqual(first["avatar"]["kind"], "default")
        self.assertTrue(first["avatar"]["data_url"].startswith("data:image/png;base64,"))
        self.assertNotIn("openid", json.dumps(first, ensure_ascii=False))

        # 重启（同目录、同令牌）后仍是同一个账号与同一个默认昵称
        restarted, _ = make_app(self.directory)
        again = restarted.test_client().get("/api/v1/me/profile", headers=self.auth()).get_json()
        self.assertEqual(again["profile"]["nickname"], first["nickname"])

    def test_existing_profile_fields_are_preserved(self):
        user_dir = self.directory / "users" / user_key("dev-alice")
        user_dir.mkdir(parents=True, exist_ok=True)
        (user_dir / "profile.json").write_text(json.dumps(
            {"openid": "dev-alice", "memo": "keep-me", "nickname": "老昵称"}, ensure_ascii=False),
            encoding="utf-8")
        self.assertEqual(self.profile()["nickname"], "老昵称")
        response = self.client.put("/api/v1/me/profile", json={"nickname": "新昵称"},
                                   headers=self.auth())
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        record = json.loads((user_dir / "profile.json").read_text(encoding="utf-8"))
        self.assertEqual(record["memo"], "keep-me", "旧 profile 的自定义字段不能丢")
        self.assertEqual(record["openid"], "dev-alice")
        self.assertEqual(record["nickname"], "新昵称")

    def test_cloud_identity_keeps_existing_profile(self):
        app, _ = make_app(self.directory / "cloud", trust_cloud_header=True, dev_login=False)
        client = app.test_client()
        key = user_key("o-cloud-1")
        user_dir = self.directory / "cloud" / "users" / key
        user_dir.mkdir(parents=True, exist_ok=True)
        (user_dir / "profile.json").write_text(
            json.dumps({"memo": "keep", "nickname": "云端昵称"}, ensure_ascii=False), encoding="utf-8")
        response = client.get("/api/v1/status", headers={"X-WX-OPENID": "o-cloud-1"})
        self.assertEqual(response.status_code, 200)
        record = json.loads((user_dir / "profile.json").read_text(encoding="utf-8"))
        self.assertEqual(record["openid"], "o-cloud-1")
        self.assertEqual(record["memo"], "keep")
        self.assertEqual(record["nickname"], "云端昵称")

    # ---- 资料

    def test_nickname_validation_and_avatar_roundtrip(self):
        response = self.client.put("/api/v1/me/profile", json={"nickname": "   "}, headers=self.auth())
        self.assertEqual(response.status_code, 400)
        response = self.client.put("/api/v1/me/profile", json={"nickname": "字" * 40}, headers=self.auth())
        self.assertEqual(response.status_code, 400)
        response = self.client.put("/api/v1/me/profile", json={"nickname": "小明", "x": 1},
                                   headers=self.auth())
        self.assertEqual(response.status_code, 400)

        import base64
        encoded = base64.b64encode(png_bytes()).decode("ascii")
        response = self.client.post("/api/v1/me/avatar", json={"data": encoded}, headers=self.auth())
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        avatar = response.get_json()["profile"]["avatar"]
        self.assertEqual(avatar["kind"], "custom")
        self.assertTrue(avatar["data_url"].startswith("data:image/jpeg;base64,"))

        bad = self.client.post("/api/v1/me/avatar",
                               json={"data": base64.b64encode(b"not an image").decode()},
                               headers=self.auth())
        self.assertEqual(bad.status_code, 400)

        avatar_file = self.directory / "users" / user_key("dev-alice") / "avatar.img"
        self.assertTrue(avatar_file.exists(), "头像应落盘到用户目录")

    # ---- 个人模型 Key

    def test_key_is_encrypted_and_never_echoed(self):
        response = self.client.post("/api/v1/me/model",
                                    json={"api_key": "sk-secret-AAA", "model": "deepseek-flash"},
                                    headers=self.auth())
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        body = response.get_data(as_text=True)
        self.assertNotIn("sk-secret-AAA", body)
        status = self.client.get("/api/v1/status", headers=self.auth()).get_json()
        self.assertEqual(status["key_source"], "user")
        self.assertNotIn("sk-secret-AAA", json.dumps(status, ensure_ascii=False))
        stored = (self.directory / "users" / user_key("dev-alice") / "model.json").read_text(encoding="utf-8")
        self.assertNotIn("sk-secret-AAA", stored, "磁盘上不能出现明文 Key")
        self.assertIn("aes-256-gcm", stored)

    def test_chat_uses_own_model_and_provider(self):
        self.client.post("/api/v1/me/model",
                         json={"api_key": "sk-user-key", "model": "deepseek-v4-pro-custom"},
                         headers=self.auth())
        result = self.chat("这道题怎么想")
        self.assertEqual(result["status"], "done", result)
        target = self.targets[-1]
        self.assertEqual(target["source"], "user")
        self.assertEqual(target["api_key"], "sk-user-key")
        self.assertEqual(target["model"], "deepseek-v4-pro-custom")
        self.assertEqual(target["base_url"], USER_MODEL_BASE)
        self.assertNotIn("sk-user-key", json.dumps(result, ensure_ascii=False))

    def test_shared_key_is_default_and_restored_after_clear(self):
        with patch("wx_api.SettingsStore.resolve",
                   return_value=shared_settings(api_key="sk-shared", model="shared-model")):
            app, targets = make_app(self.directory / "shared")
            client = app.test_client()
            token = self.login(client, "bob")
            headers = {"Authorization": "Bearer " + token}
            status = client.get("/api/v1/status", headers=headers).get_json()
            self.assertEqual(status["key_source"], "server")
            self.assertEqual(status["model"], "shared-model", "共享模式要报告管理员实际模型")

            client.post("/api/v1/me/model", json={"api_key": "sk-mine", "model": "my-model"},
                        headers=headers)
            status = client.get("/api/v1/status", headers=headers).get_json()
            self.assertEqual(status["key_source"], "user")
            self.assertEqual(status["model"], "my-model")

            client.post("/api/v1/me/model/clear", json={}, headers=headers)
            status = client.get("/api/v1/status", headers=headers).get_json()
            self.assertEqual(status["key_source"], "server")
            self.assertEqual(status["model"], "shared-model")
            self.assertEqual(targets, [], "只有读取状态，不应创建模型客户端")

    def test_saving_key_without_model_keeps_saved_model(self):
        self.client.post("/api/v1/me/model", json={"api_key": "sk-1", "model": "deepseek-flash"},
                         headers=self.auth())
        response = self.client.post("/api/v1/me/model", json={"api_key": "sk-2"}, headers=self.auth())
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()["model"]["model"], "deepseek-flash",
                         "只换 Key 不能把已保存模型改回默认值")

        seen = {}

        class FakeClient:
            def __init__(self, base_url, api_key, model, timeout=30, retries=2, follow_redirects=True):
                seen.update({"base_url": base_url, "model": model, "key": api_key,
                             "follow_redirects": follow_redirects})

            def complete(self, messages, tools=None):
                return {"role": "assistant", "content": "ok"}

        with patch("wx_api.ModelClient", FakeClient):
            response = self.client.post("/api/v1/me/model/test", json={"api_key": "sk-3"},
                                        headers=self.auth())
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertTrue(response.get_json()["test"]["ok"])
        self.assertEqual(seen["model"], "deepseek-flash", "测试也只换 Key 时沿用已保存模型")
        self.assertEqual(seen["base_url"], USER_MODEL_BASE)
        self.assertFalse(seen["follow_redirects"], "个人 Key 必须禁用重定向")

    def test_client_cannot_choose_base_url(self):
        response = self.client.post("/api/v1/me/model",
                                    json={"api_key": "sk-x", "base_url": "https://evil.example.com"},
                                    headers=self.auth())
        self.assertEqual(response.status_code, 400)
        self.assertNotIn("evil.example.com", response.get_data(as_text=True))
        response = self.client.post("/api/v1/me/model", json={"api_key": "sk-x", "nope": 1},
                                    headers=self.auth())
        self.assertEqual(response.status_code, 400)

    def test_test_endpoint_never_returns_provider_detail(self):
        from llm import ModelError

        class FailingClient:
            def __init__(self, *args, **kwargs):
                pass

            def complete(self, messages, tools=None):
                raise ModelError("模型 API 返回 HTTP 401；请检查配置或账户权限。")

        with patch("wx_api.ModelClient", FailingClient):
            response = self.client.post("/api/v1/me/model/test",
                                        json={"api_key": "sk-bad-key", "model": "deepseek-v4-pro"},
                                        headers=self.auth())
        self.assertEqual(response.status_code, 200)
        body = response.get_json()["test"]
        self.assertFalse(body["ok"])
        self.assertIn("API Key", body["error"])
        self.assertNotIn("sk-bad-key", json.dumps(body, ensure_ascii=False))
        self.assertNotIn("Bearer", json.dumps(body, ensure_ascii=False))

    def test_broken_ciphertext_reports_settings_error(self):
        user_dir = self.directory / "users" / user_key("dev-alice")
        user_dir.mkdir(parents=True, exist_ok=True)
        (user_dir / "model.json").write_text(json.dumps({
            "version": 1, "model": "deepseek-flash", "updated_at": 1,
            "key": {"v": 1, "alg": "aes-256-gcm", "nonce": "AAAA", "ct": "AAAA"}
        }), encoding="utf-8")
        with patch("wx_api.SettingsStore.resolve", return_value=shared_settings(api_key="sk-shared")):
            model = self.model()
            self.assertTrue(model["key_error"])
            self.assertFalse(model["configured"], "个人 Key 坏了就不能报告成已配置")
            self.assertEqual(model["source"], "", "坏掉的个人 Key 不会偷偷改用共享 Key")
            status = self.client.get("/api/v1/status", headers=self.auth()).get_json()
            self.assertEqual(status["key_source"], "")
            self.assertFalse(status["configured"])

            result = self.chat("坏 Key 也要有清楚提示")
        self.assertEqual(result["status"], "error", result)
        self.assertEqual(result["error_code"], "settings_error")
        self.assertTrue(result.get("need_model_settings"))
        self.assertNotIn("AAAA", json.dumps(result, ensure_ascii=False))

    def test_missing_aead_library_gives_clear_error(self):
        with patch("wx_account.AESGCM", None):
            response = self.client.post("/api/v1/me/model", json={"api_key": "sk-x"},
                                        headers=self.auth())
        self.assertEqual(response.status_code, 503)
        self.assertIn("加密", response.get_json()["error"])
        # 资料功能不依赖加密库，仍然可用
        self.assertTrue(self.profile()["nickname"])

    def test_two_users_have_separate_accounts_and_keys(self):
        other = self.app.test_client()
        token_b = self.login(other, "bob")
        self.client.post("/api/v1/me/model", json={"api_key": "sk-alice", "model": "m-alice"},
                         headers=self.auth())
        self.client.put("/api/v1/me/profile", json={"nickname": "Alice 昵称"}, headers=self.auth())
        model_b = other.get("/api/v1/me/model", headers={"Authorization": "Bearer " + token_b}).get_json()
        self.assertFalse(model_b["model"]["key_saved"], "另一个用户不能看到别人的 Key")
        profile_b = other.get("/api/v1/me/profile", headers={"Authorization": "Bearer " + token_b}).get_json()
        self.assertNotEqual(profile_b["profile"]["nickname"], "Alice 昵称")

        result = other.post("/api/v1/chat", json={"message": "B 的提问"},
                            headers={"Authorization": "Bearer " + token_b})
        self.assertEqual(result.status_code, 202)
        task_id = result.get_json()["task_id"]
        deadline = time.time() + 6
        current = {}
        while time.time() < deadline:
            current = other.get(f"/api/v1/tasks/{task_id}",
                                headers={"Authorization": "Bearer " + token_b}).get_json()
            if current.get("status") != "running":
                break
            time.sleep(0.02)
        self.assertEqual(current.get("status"), "done", current)
        target = self.targets[-1]
        self.assertTrue(target is None or target.get("api_key") != "sk-alice",
                        "B 的请求不能拿到 A 的个人 Key")

    # ---- 删除

    def test_delete_removes_avatar_and_key(self):
        import base64
        self.client.post("/api/v1/me/avatar",
                         json={"data": base64.b64encode(png_bytes()).decode()}, headers=self.auth())
        self.client.post("/api/v1/me/model", json={"api_key": "sk-delete-me"}, headers=self.auth())
        user_dir = self.directory / "users" / user_key("dev-alice")
        self.assertTrue(user_dir.exists())
        response = self.client.post("/api/v1/account/delete", json={"confirm": True},
                                    headers=self.auth())
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertFalse(user_dir.exists(), "删号要连头像和 Key 一起清掉")

    def test_delete_waits_for_settings_write(self):
        registry = self.app.extensions["wx_registry"]
        state = registry.get(user_key("dev-alice"))
        self.assertTrue(state.begin_write())
        response = self.client.post("/api/v1/account/delete", json={"confirm": True},
                                    headers=self.auth())
        self.assertEqual(response.status_code, 409, "保存设置期间不能删目录")
        state.end_write()
        response = self.client.post("/api/v1/account/delete", json={"confirm": True},
                                    headers=self.auth())
        self.assertEqual(response.status_code, 200)

    # ---- 一把 Key 管全部

    def test_personal_key_also_covers_ocr(self):
        """个人 Key 生效时，图片识别也用同一把 Key，不再要求管理员单独配 OCR Key。"""
        import base64

        response = self.client.post("/api/v1/me/model",
                                    json={"api_key": "sk-owner", "model": "deepseek-v4-pro"},
                                    headers=self.auth())
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        status = response.get_json()["model"]
        self.assertTrue(status["ocr_configured"], status)
        self.assertEqual(status["ocr_source"], "user", status)
        self.assertEqual(status["ocr_model"], "deepseek-flash", status)

        upload = self.client.post("/api/v1/uploads/base64",
                                  json={"images": [{"data": base64.b64encode(png_bytes(32)).decode()}]},
                                  headers=self.auth())
        self.assertEqual(upload.status_code, 200, upload.get_data(as_text=True))
        image_id = upload.get_json()["image_ids"][0]
        chat = self.client.post("/api/v1/chat", json={"message": "看图", "image_ids": [image_id]},
                                headers=self.auth())
        self.assertEqual(chat.status_code, 202, chat.get_data(as_text=True))
        deadline = time.time() + 6
        current = {}
        while time.time() < deadline:
            current = self.client.get("/api/v1/tasks/" + chat.get_json()["task_id"],
                                      headers=self.auth()).get_json()
            if current["status"] != "running":
                break
            time.sleep(0.02)
        self.assertEqual(current["status"], "done", current)
        self.assertTrue(any(t["source"] == "user" and t["api_key"] == "sk-owner"
                            and t["model"] == "deepseek-flash" for t in self.targets),
                        self.targets)

    # ---- 老部署兼容

    def test_ocr_only_deployment_still_accepts_images(self):
        import base64

        class FakeModel:
            def __init__(self, *args, **kwargs):
                pass

            def complete(self, messages, tools=None):
                return {"role": "assistant", "content": "看了图"}

        with patch("wx_api.SettingsStore.resolve",
                   return_value=shared_settings(ocr_api_key="sk-ocr")):
            app, _ = make_app(self.directory / "ocr", factory=None)
            client = app.test_client()
            token = self.login(client, "carol")
            headers = {"Authorization": "Bearer " + token}
            with patch("wx_api.ModelClient", FakeModel):
                text = client.post("/api/v1/chat", json={"message": "只有文字"}, headers=headers)
                self.assertEqual(text.status_code, 409, "没有文本 Key 时应引导去设置")
                self.assertTrue(text.get_json().get("need_model_settings"))

                upload = client.post("/api/v1/uploads/base64",
                                     json={"images": [{"data": base64.b64encode(png_bytes(32)).decode()}]},
                                     headers=headers)
                self.assertEqual(upload.status_code, 200, upload.get_data(as_text=True))
                image_id = upload.get_json()["image_ids"][0]
                image_chat = client.post("/api/v1/chat",
                                         json={"message": "看图", "image_ids": [image_id]},
                                         headers=headers)
                self.assertEqual(image_chat.status_code, 202, image_chat.get_data(as_text=True))
                task_id = image_chat.get_json()["task_id"]
                deadline = time.time() + 6
                current = {}
                while time.time() < deadline:
                    current = client.get(f"/api/v1/tasks/{task_id}", headers=headers).get_json()
                    if current["status"] != "running":
                        break
                    time.sleep(0.02)
                self.assertEqual(current["status"], "done", current)


class RedirectPolicyTests(unittest.TestCase):
    def test_personal_client_does_not_follow_redirect(self):
        from http.server import BaseHTTPRequestHandler, HTTPServer
        from llm import ModelClient, ModelError

        hits = {"source": 0, "target": 0}
        holder = {}

        class Target(BaseHTTPRequestHandler):
            def do_POST(self):
                hits["target"] += 1
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"choices":[{"message":{"role":"assistant","content":"x"}}]}')

            def log_message(self, *args):
                pass

        target = HTTPServer(("127.0.0.1", 0), Target)

        class Source(BaseHTTPRequestHandler):
            def do_POST(self):
                hits["source"] += 1
                self.send_response(302)
                self.send_header("Location", "http://127.0.0.1:%d/x" % target.server_port)
                self.end_headers()

            def log_message(self, *args):
                pass

        source = HTTPServer(("127.0.0.1", 0), Source)
        for server in (source, target):
            threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(source.shutdown)
        self.addCleanup(target.shutdown)
        holder["url"] = "http://127.0.0.1:%d" % source.server_port

        client = ModelClient(holder["url"], "sk-redirect-key", "m", timeout=5, retries=0,
                             follow_redirects=False)
        with self.assertRaises(ModelError):
            client.complete([{"role": "user", "content": "hi"}])
        self.assertEqual(hits["source"], 1)
        self.assertEqual(hits["target"], 0, "3xx 之后不能再发第二个请求（否则密钥会被转发）")


if __name__ == "__main__":
    unittest.main()
