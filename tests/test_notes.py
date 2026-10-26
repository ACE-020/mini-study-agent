from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from agent import StudyAgent
from cancellation import CancellationToken, OperationCancelled
from note_exports import NoteExporter
from note_pdf import annotation_boundaries, pdf_html
from note_skill import note_rules, SKILL_DIR
from ocr import ImageReader
from prompts import STUDY_PROMPT
from test_core import ScriptedClient, call
from test_web import image_bytes
from tools import LocalTools, SCHEMAS
from web import create_app


CONTENT = "## Note2\n\n$x_n\\to x$。\n\n> **注解：量词**\n>\n> 保留原有符号。\n"


class FakeExporter(NoteExporter):
    """单元测试只验证协议和持久化；真实 PDF 另有浏览器集成检查。"""
    def export(self, record, cancel_token=None):
        self.root.mkdir(parents=True, exist_ok=True)
        paths = self.paths(record)
        paths["md"].write_text(record["content"].strip()+"\n", encoding="utf-8")
        paths["pdf"].write_bytes(b"%PDF-fixture-not-a-real-document")
        return {kind: {"ok": True, "path": str(path)} for kind, path in paths.items()}


class NoteTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.exporter = FakeExporter(self.root)
        self.tools = LocalTools(self.root, note_exporter=self.exporter)

    def save(self, **changes):
        return self.tools.execute("save_note", json.dumps({"topic": "数列极限", "content": CONTENT, **changes}, ensure_ascii=False))

    def test_seven_model_tools_exclude_internal_helpers(self):
        self.assertEqual({item["function"]["name"] for item in SCHEMAS},
                         {"search_notes", "save_mistake", "get_mistakes", "pick_exercise", "save_note", "delete_records", "merge_records"})
        for name in ("read", "_read", "_write_mistakes", "execute", "write_note"):
            self.assertFalse(self.tools.execute(name, "{}")["ok"])

    def test_note_persists_and_is_searchable_after_restart(self):
        data = self.save()["data"]
        self.assertTrue(data["saved"])
        self.assertTrue(data["exports"]["pdf"]["ok"])
        self.assertEqual(LocalTools(self.root).search_notes("数列极限")[0]["content"], CONTENT.strip())
        self.assertFalse((self.root / "mistakes.json").exists())
        self.assertEqual(self.exporter.paths(data["note"])["md"].read_text(encoding="utf-8"), CONTENT)

    def test_duplicate_and_changed_versions_preserve_notes(self):
        self.save()
        self.assertTrue(self.save()["data"]["duplicate"])
        self.save(content=CONTENT+"\n补充原稿。")
        self.assertEqual(len(self.tools._read("notes.json")), 2)

    def test_existing_seed_notes_are_not_overwritten(self):
        seed = [{"id": "old-note", "topic": "原有笔记", "content": "原有正文"}]
        (self.root/"notes.json").write_text(json.dumps(seed, ensure_ascii=False), encoding="utf-8")
        self.save()
        self.assertEqual(self.tools._read("notes.json")[0], seed[0])

    def test_corrupt_file_and_atomic_failure_preserve_original(self):
        path = self.root / "notes.json"
        path.write_text("{broken", encoding="utf-8")
        self.assertFalse(self.save()["ok"])
        self.assertEqual(path.read_text(encoding="utf-8"), "{broken")
        path.write_text("[]", encoding="utf-8")
        with patch("tools.os.replace", side_effect=PermissionError("不能写入")):
            self.assertFalse(self.save()["ok"])
        self.assertEqual(path.read_text(encoding="utf-8"), "[]")
        self.assertEqual(list(self.root.glob("*.tmp")), [])

    def test_validation_and_unclear_symbols_do_not_save(self):
        for changes in ({"topic": "x"*121}, {"content": "x"*24001}, {"content": "[无法辨认]"}, {"path": "../other"}):
            self.assertFalse(self.save(**changes)["ok"])
        self.assertFalse((self.root/"notes.json").exists())

    def test_cancel_before_save_cannot_write(self):
        token = CancellationToken()
        token.cancel()
        with self.assertRaises(OperationCancelled):
            self.tools.execute("save_note", json.dumps({"topic": "数列", "content": CONTENT}), cancel_token=token)
        self.assertFalse((self.root/"notes.json").exists())

    def test_pdf_failure_keeps_json_and_markdown(self):
        exporter = NoteExporter(self.root)
        with patch("note_exports.subprocess.Popen", side_effect=OSError("浏览器不可用")):
            self.tools.note_exporter = exporter
            result = self.save()
        self.assertTrue(result["ok"])
        self.assertTrue(result["data"]["saved"])
        self.assertTrue(result["data"]["exports"]["md"]["ok"])
        self.assertFalse(result["data"]["exports"]["pdf"]["ok"])
        self.assertEqual(len(self.tools._read("notes.json")), 1)

    def test_note_rules_are_default_and_user_prompt_is_unchanged(self):
        model = ScriptedClient([call("save_note", {"topic": "数列", "content": CONTENT})])
        agent = StudyAgent(model, self.tools)
        answer = agent.run("整理这些笔记："+CONTENT)
        self.assertIn("Markdown", answer)
        self.assertIn("PDF", answer)
        self.assertEqual(len(model.requests), 1)
        self.assertEqual(agent.messages[0]["content"], STUDY_PROMPT)
        self.assertIn(note_rules(), model.requests[0][1]["content"])
        self.assertEqual(len([message for message in agent.messages if message["role"]=="system"]), 1)
        for name in ("assets/note-layout.tex", "scripts/render_pdf.py", "scripts/notes_filter.lua", "agents/openai.yaml", "references/style.md"):
            self.assertTrue((SKILL_DIR/name).is_file())

    def test_note_mode_rejects_mistake_tool_and_can_ask_clarification(self):
        model = ScriptedClient([call("get_mistakes", {}), {"role":"assistant", "content":"第二行是正号还是负号？"}])
        answer = StudyAgent(model, self.tools).run("请整理", task="notes")
        self.assertIn("正号", answer)
        self.assertFalse(json.loads(model.requests[1][-1]["content"])["ok"])
        self.assertFalse((self.root/"notes.json").exists())

    def test_pdf_source_blocks_script_injection_and_requires_quote_boundary(self):
        markup = pdf_html('</script><script>window.PWNED=true</script>')
        self.assertNotIn('source="</script>', markup)
        self.assertIn('\\u003c/script>', markup)
        with self.assertRaisesRegex(ValueError, "空行"):
            annotation_boundaries("> **注解：条件**\n> 内容\n## Note3")


class NotesWebTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.model = ScriptedClient([call("save_note", {"topic":"数列", "content":CONTENT})])
        self.patcher = patch("tools.NoteExporter", FakeExporter)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.app = create_app(self.root, client_factory=lambda:self.model, settings_path=self.root/"settings.json")
        self.client = self.app.test_client()

    def test_note_save_library_download_and_reset(self):
        response = self.client.post("/api/chat", json={"view":"notes", "message":"整理课堂原稿", "new_problem":True})
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertIn('笔记已保存', response.get_json()["answer"])
        records = self.client.get("/api/notes").get_json()["notes"]
        self.assertEqual(len(records), 1)
        for kind in ("md", "pdf"):
            with self.client.get(records[0]["downloads"][kind]) as downloaded:
                self.assertEqual(downloaded.status_code, 200)
                self.assertIn("attachment", downloaded.headers["Content-Disposition"])
        self.client.post("/api/reset")
        self.assertEqual(self.client.get("/api/notes").get_json()["total"], 1)
        self.assertEqual(self.client.get("/api/mistakes").get_json()["data"]["total"], 0)

    def test_utf8_upload_does_not_call_model_or_write_notes(self):
        response = self.client.post("/api/notes/read", data={"file":(BytesIO(CONTENT.encode()),"notes.md")})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["text"], CONTENT)
        self.assertEqual(self.model.requests, [])
        self.assertEqual(self.client.get("/api/notes").get_json()["total"], 0)

    def test_original_images_go_to_note_model_in_selection_order(self):
        reader_model = ScriptedClient([{"role":"assistant", "content":"第一张原文"}, {"role":"assistant", "content":"第二张原文"}])
        reader_model.complete = lambda messages, tools=None: {"role":"assistant", "content":"原图文字"}
        app = create_app(self.root, client_factory=lambda:self.model,
                         reader_factory=lambda:ImageReader(reader_model),settings_path=self.root/"settings2.json")
        client = app.test_client()
        ids = []
        for index in range(2):
            response = client.post("/api/notes/read", data={"file":(BytesIO(image_bytes()),f"board-{index}.png")})
            self.assertEqual(response.status_code, 200)
            ids.append(response.get_json()["image_id"])
        response = client.post("/api/chat",json={"view":"notes","message":"按原图整理", "image_ids":ids})
        self.assertEqual(response.status_code, 200, response.get_json())
        blocks = self.model.requests[0][-1]["content"]
        self.assertEqual([block["type"] for block in blocks], ["text","image_url","image_url"])
        self.assertFalse(any(path.suffix==".png" for path in self.root.rglob("*")))

    def test_missing_image_and_invalid_download_are_rejected(self):
        response = self.client.post("/api/chat",json={"view":"notes","message":"原文", "image_ids":["expired"]})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.model.requests, [])
        self.assertEqual(self.client.get("/api/notes/missing/download/pdf").status_code, 404)
        self.assertEqual(self.client.get("/api/notes/missing/download/exe").status_code, 404)

    def test_default_rules_are_visible_without_enable_switch(self):
        prompts = self.client.get("/api/prompts").get_json()["prompts"]
        self.assertEqual(prompts["笔记整理（默认）"], note_rules())
        html = self.client.get("/").get_data(as_text=True)
        self.assertIn("添加学习内容", html)
        self.assertIn("我的笔记", html)
        self.assertNotIn('id="enable-skill"', html)


if __name__ == "__main__":
    unittest.main()
