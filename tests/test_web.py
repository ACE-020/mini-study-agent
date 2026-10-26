import base64
from io import BytesIO
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

from demo import MISTAKE
from llm import ModelClient, ModelError
from ocr import ImageReader, prepare_image
from test_core import ScriptedClient, call
from tools import LocalTools
from web import create_app


def image_bytes():
    buffer = BytesIO()
    Image.new("RGB", (140, 60), "white").save(buffer, format="PNG")
    return buffer.getvalue()


class WebTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name)
        self.model = ScriptedClient([{"role": "assistant", "content": "识别得到的题目"}])
        self.app = create_app(self.path, client_factory=lambda: self.model,
                              reader_factory=lambda: ImageReader(self.model),
                              settings_path=self.path / "settings.json")
        self.app.config["TESTING"] = True
        self.client = self.app.test_client()

    def test_page_and_assets_are_available(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("上传作业图片", response.get_data(as_text=True))
        for path in ("/static/app.js", "/static/app.css", "/static/vendor/katex/katex.min.js"):
            with self.client.get(path) as asset:
                self.assertEqual(asset.status_code, 200)

    def test_status_does_not_expose_api_key(self):
        with patch.dict(os.environ, {"LLM_API_KEY": "must-never-appear"}):
            text = self.client.get("/api/status").get_data(as_text=True)
        self.assertNotIn("must-never-appear", text)
        self.assertIn('"configured":true', text)

    def test_ocr_uses_image_blocks_without_saving_mistakes(self):
        response = self.client.post("/api/ocr", data={"image": (BytesIO(image_bytes()), "homework.png")})
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(response.get_json()["text"], "识别得到的题目")
        block = self.model.requests[0][-1]["content"][1]
        self.assertEqual(block["type"], "image_url")
        self.assertTrue(block["image_url"]["url"].startswith("data:image/jpeg;base64,"))
        self.assertEqual(list(self.path.iterdir()), [])

    def test_fake_image_is_rejected_before_model_request(self):
        response = self.client.post("/api/ocr", data={"image": (BytesIO(b"<html>not an image"), "fake.png")})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.model.requests, [])

    def test_oversized_request_has_readable_error(self):
        self.app.config["MAX_CONTENT_LENGTH"] = 128
        response = self.client.post("/api/ocr", data={"image": (BytesIO(image_bytes()), "big.png")})
        self.assertEqual(response.status_code, 413)
        self.assertFalse(response.get_json()["ok"])

    def test_missing_image_and_empty_chat_are_rejected(self):
        self.assertEqual(self.client.post("/api/ocr", data={}).status_code, 400)
        self.assertEqual(self.client.post("/api/chat", json={"message": " "}).status_code, 400)
        self.assertEqual(self.client.post("/api/chat", json=[]).status_code, 400)

    def test_cross_origin_request_is_rejected(self):
        response = self.client.post("/api/chat", json={"message": "test"}, headers={"Origin": "https://example.invalid"})
        self.assertEqual(response.status_code, 403)

    def test_chat_saves_and_keeps_followup_context(self):
        self.model.replies = iter([call("save_mistake", MISTAKE),
                                   {"role": "assistant", "content": "保存成功"},
                                   {"role": "assistant", "content": "收到补充"}])
        first = self.client.post("/api/chat", json={"message": "整理错题"})
        self.assertEqual(first.status_code, 200)
        self.assertEqual(len(first.get_json()["events"]), 4)
        second = self.client.post("/api/chat", json={"message": "我再补充一步"})
        self.assertEqual(second.status_code, 200)
        self.assertTrue(any(item.get("content") == "整理错题" for item in self.model.requests[-1]))
        self.assertEqual(LocalTools(self.path).get_mistakes()["total"], 1)

    def test_failed_final_reply_preserves_saved_record_and_returns_trace(self):
        self.model.replies = iter([call("save_mistake", MISTAKE), ModelError("模拟超时")])
        response = self.client.post("/api/chat", json={"message": "整理错题"})
        self.assertEqual(response.status_code, 502)
        self.assertIn("已保存的内容仍然保留", response.get_json()["error"])
        self.assertTrue(response.get_json()["events"])
        self.assertEqual(LocalTools(self.path).get_mistakes()["total"], 1)

    def test_reset_does_not_delete_mistakes(self):
        LocalTools(self.path).save_mistake(**MISTAKE)
        self.assertEqual(self.client.post("/api/reset").status_code, 200)
        self.assertEqual(self.client.get("/api/mistakes").get_json()["data"]["total"], 1)

    def test_clear_intake_forgets_only_organize_context_and_preserves_records(self):
        local = LocalTools(self.path)
        local.save_mistake(**MISTAKE)
        local._write_records("notes.json", [{"id":"kept-note", "topic":"导数", "content":"保留笔记"}])
        local.bank.add("保留资料", [{"number":"1", "topic":"导数", "question":"求 x² 的导数。", "answer":"2x"}])
        before = {name:(self.path/name).read_bytes() for name in ("notes.json","mistakes.json","exercises.json")}
        self.model.replies = iter([{"role":"assistant","content":"收到"} for _ in range(4)])
        self.assertEqual(self.client.post("/api/chat", json={"message":"待清理的原稿", "view":"organize"}).status_code,200)
        self.assertEqual(self.client.post("/api/chat", json={"message":"应保留的复习步骤", "view":"review"}).status_code,200)
        self.assertEqual(self.client.post("/api/intake/clear", json={}).status_code,200)
        self.assertEqual(self.client.post("/api/chat", json={"message":"新原稿", "view":"organize"}).status_code,200)
        self.assertFalse(any(item.get("content")=="待清理的原稿" for item in self.model.requests[-1]))
        self.assertEqual(self.client.post("/api/chat", json={"message":"继续复习", "view":"review"}).status_code,200)
        self.assertTrue(any(item.get("content")=="应保留的复习步骤" for item in self.model.requests[-1]))
        self.assertEqual(before,{name:(self.path/name).read_bytes() for name in before})

    def test_clear_intake_releases_uploaded_images(self):
        result=self.client.post("/api/intake/read",data={"files":(BytesIO(image_bytes()),"source.png")})
        self.assertEqual(result.status_code,200)
        images=result.get_json()["image_ids"]
        self.assertEqual(self.client.post("/api/intake/clear",json={}).status_code,200)
        response=self.client.post("/api/chat",json={"message":"旧原图", "image_ids":images})
        self.assertEqual(response.status_code,409)

    def test_clear_intake_only_removes_requested_preview_for_current_session(self):
        from test_library_input import pdf_bytes
        def upload(client):
            return client.post("/api/files/preview", data={"file":(BytesIO(pdf_bytes()),"source.pdf")}).get_json()["document"]["id"]
        self.addCleanup(self.app.extensions["pdf_previews"].close)
        intake_id, materials_id = upload(self.client), upload(self.client)
        other=self.app.test_client()
        other_id=upload(other)
        response=self.client.post("/api/intake/clear",json={"preview_ids":[intake_id,other_id]})
        self.assertEqual(response.status_code,200)
        self.assertEqual(self.client.get(f"/api/files/preview/{intake_id}/1").status_code,404)
        self.assertEqual(self.client.get(f"/api/files/preview/{materials_id}/1").status_code,200)
        self.assertEqual(other.get(f"/api/files/preview/{other_id}/1").status_code,200)

    def test_corrupt_storage_has_readable_error_and_is_unchanged(self):
        path = self.path / "mistakes.json"
        path.write_text("{broken", encoding="utf-8")
        response = self.client.get("/api/mistakes")
        self.assertEqual(response.status_code, 500)
        self.assertIn("原文件未被修改", response.get_json()["error"])
        self.assertEqual(path.read_text(encoding="utf-8"), "{broken")

    def test_ocr_failure_returns_message_without_creating_data(self):
        self.model.replies = iter([ModelError("模拟服务不可用")])
        response = self.client.post("/api/ocr", data={"image": (BytesIO(image_bytes()), "homework.png")})
        self.assertEqual(response.status_code, 502)
        self.assertIn("图片识别未完成", response.get_json()["error"])
        self.assertEqual(list(self.path.iterdir()), [])


class ImageAndClientTests(unittest.TestCase):
    def test_image_pixel_limit_is_checked(self):
        with patch("ocr.MAX_IMAGE_PIXELS", 10):
            with self.assertRaisesRegex(ValueError, "分辨率"):
                prepare_image(image_bytes())

    def test_image_is_normalized_and_empty_image_is_rejected(self):
        result = prepare_image(image_bytes())
        decoded = base64.b64decode(result.split(",", 1)[1])
        with Image.open(BytesIO(decoded)) as image:
            self.assertEqual(image.format, "JPEG")
        with self.assertRaises(ValueError):
            prepare_image(b"")

    def test_ocr_request_omits_tool_definitions(self):
        response = BytesIO(json.dumps({"choices": [{"message": {"role": "assistant", "content": "text"}}]}).encode())
        with patch("llm.urlopen", return_value=response) as request:
            ModelClient("https://example.invalid", "dummy", "dummy").complete([])
        payload = json.loads(request.call_args.args[0].data)
        self.assertNotIn("tools", payload)
        self.assertNotIn("tool_choice", payload)


if __name__ == "__main__":
    unittest.main()
