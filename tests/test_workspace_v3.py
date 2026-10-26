from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import pymupdf

from document_input import DocumentReader
from math_text import normalize_math_markdown
from test_core import ScriptedClient
from test_library_input import pdf_bytes
from test_notes import FakeExporter
from demo import MISTAKE
from tools import LocalTools
from web import create_app


LEGACY = [
    "非负整数 n 的幂函数不定积分：∫x^n dx = x^(n+1)/(n+1)+C。注意指数增加 1、除以新指数，并写上积分常数 C。",
    "重要极限：当 x 趋于 0 时，sin(x)/x 趋于 1，x 的单位为弧度。例 sin(2x)/x 的极限为 2。",
    "正整数幂函数求导：(x^n)' = n*x^(n-1)，n 为正整数。例：(x^2)'=2x，(x^3)'=3x^2。注意不能遗漏系数 n。",
]


class LegacyMathTests(unittest.TestCase):
    def test_three_original_plain_notes_receive_math_markup(self):
        for source in LEGACY:
            displayed = normalize_math_markdown(source)
            self.assertIn(r"\(", displayed)
            self.assertEqual(normalize_math_markdown(displayed), displayed)
        self.assertIn(r"\int", normalize_math_markdown(LEGACY[0]))
        self.assertIn("^{n+1}", normalize_math_markdown(LEGACY[0]))
        self.assertIn(r"\sin", normalize_math_markdown(LEGACY[1]))
        self.assertIn(r"\to", normalize_math_markdown(LEGACY[1]))
        self.assertIn(r"\cdot", normalize_math_markdown(LEGACY[2]))

    def test_existing_math_code_links_and_english_are_preserved(self):
        source = r"""已有 $x^2$、\(x^3\) 和 $$\frac{1}{2}$$。

```python
x^2 = 4
```
`x^2`；[x^2](https://example.org/a=b)；https://example.org/x^2
An existing equation x^2 must be reviewed.
"""
        self.assertEqual(normalize_math_markdown(source), source)


class WorkspaceV3Tests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.tools = LocalTools(self.root, note_exporter=FakeExporter(self.root))
        self.note = self.tools.save_note("积分", LEGACY[0])["note"]
        self.mistake = self.tools.save_mistake(**MISTAKE)["mistake"]
        self.refs = [{"kind": "note", "id": self.note["id"]}, {"kind": "mistake", "id": self.mistake["id"]}]
        self.model = ScriptedClient([])
        self.app = create_app(self.root, client_factory=lambda: self.model, settings_path=self.root / "config.json")
        self.app.config["TESTING"] = True
        self.addCleanup(self.app.extensions["pdf_previews"].close)
        self.client = self.app.test_client()

    def upload_pdf(self, raw=None, client=None):
        return (client or self.client).post("/api/files/preview", data={"file": (BytesIO(raw or pdf_bytes()), "book.pdf")})

    def test_note_api_adds_display_math_without_changing_saved_text(self):
        before = (self.root / "notes.json").read_bytes()
        note = self.client.get("/api/notes").get_json()["notes"][0]
        self.assertIn(r"\int", note["display_content"])
        self.assertEqual(note["content"], LEGACY[0])
        self.assertEqual((self.root / "notes.json").read_bytes(), before)
        self.assertEqual(self.model.requests, [])

    def test_old_plain_export_cache_is_not_offered_as_up_to_date(self):
        paths = self.tools.note_exporter.paths(self.note)
        self.assertTrue(paths["md"].exists())
        self.assertEqual(self.client.get("/api/notes").get_json()["notes"][0]["downloads"], {})
        self.assertEqual(self.client.get(f"/api/notes/{self.note['id']}/download/pdf").status_code, 409)
        paths["md"].write_text(normalize_math_markdown(self.note["content"]) + "\n", encoding="utf-8")
        self.assertIn("pdf", self.client.get("/api/notes").get_json()["notes"][0]["downloads"])

    def test_mixed_markdown_and_json_export_use_only_selected_server_records(self):
        extra = self.tools.save_note("不应导出", "不应导出的内容")["note"]
        before = [(self.root / name).read_bytes() for name in ("notes.json", "mistakes.json")]
        response = self.client.post("/api/library/export", json={"items": self.refs, "format": "md"})
        self.assertEqual(response.status_code, 200)
        self.assertIn("attachment", response.headers["Content-Disposition"])
        text = response.get_data(as_text=True)
        self.assertIn(r"\int", text)
        self.assertIn(MISTAKE["user_answer"], text)
        self.assertIn(MISTAKE["reason"], text)
        self.assertNotIn(extra["content"], text)
        response = self.client.post("/api/library/export", json={"items": self.refs, "format": "json"})
        exported = response.get_json()
        self.assertEqual(exported["items"][0]["record"]["content"], LEGACY[0])
        self.assertEqual([item["kind"] for item in exported["items"]], ["note", "mistake"])
        self.assertEqual(before, [(self.root / name).read_bytes() for name in ("notes.json", "mistakes.json")])
        self.assertEqual(self.model.requests, [])

    def test_export_does_not_inherit_model_context_length_limit(self):
        records = [{"id": str(index), "topic": "长笔记", "content": "内容" * 11000} for index in range(4)]
        self.tools._write_records("notes.json", records)
        refs = [{"kind": "note", "id": item["id"]} for item in records]
        with self.assertRaises(ValueError):
            self.tools.library.select(refs)
        response = self.client.post("/api/library/export", json={"items": refs, "format": "md"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_data(as_text=True).count("内容"), 44001)

    def test_export_rejects_unknown_records_and_invalid_format(self):
        for data in ({"items": self.refs, "format": "exe"}, {"items": [{"kind": "note", "id": "missing"}], "format": "md"}, {"items": [], "format": "pdf"}):
            self.assertEqual(self.client.post("/api/library/export", json=data).status_code, 400)
        self.assertEqual(self.model.requests, [])

    def test_pdf_export_returns_binary_and_cancellation_returns_no_partial_download(self):
        with patch("library_export.NoteExporter", FakeExporter):
            response = self.client.post("/api/library/export", json={"items": self.refs, "format": "pdf"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "application/pdf")
        def cancel(selected, kind, token):
            token.cancel()
            token.check()
        with patch("web.export_collection", side_effect=cancel):
            response = self.client.post("/api/library/export", json={"items": self.refs, "format": "pdf"})
        self.assertEqual(response.status_code, 499)
        self.assertTrue(response.get_json()["cancelled"])
        self.assertEqual(len(self.tools._read("notes.json")), 1)

    def test_pdf_preview_allows_whole_books_and_is_session_bound(self):
        response = self.upload_pdf(pdf_bytes(pages=25))
        self.assertEqual(response.status_code, 200)
        doc = response.get_json()["document"]
        self.assertEqual(doc["pages"], 25)
        path = f"/api/files/preview/{doc['id']}/25"
        page = self.client.get(path)
        self.assertEqual(page.status_code, 200)
        self.assertEqual(page.mimetype, "image/jpeg")
        self.assertTrue(page.data.startswith(b"\xff\xd8"))
        self.assertEqual(self.app.test_client().get(path).status_code, 404)
        self.assertEqual(self.client.get(f"/api/files/preview/{doc['id']}/26").status_code, 404)
        self.assertEqual(self.model.requests, [])

    def test_pdf_preview_rejects_broken_encrypted_and_oversized_uploads(self):
        response = self.upload_pdf(b"not a pdf")
        self.assertEqual(response.status_code, 400)
        with pymupdf.open() as doc:
            doc.new_page()
            raw = doc.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="secret", owner_pw="owner")
        self.assertEqual(self.upload_pdf(raw).status_code, 400)
        with patch("file_preview.MAX_FILE_BYTES", 100):
            self.assertEqual(self.upload_pdf().status_code, 400)
        store = self.app.extensions["pdf_previews"]
        self.assertEqual(store.entries, {})
        self.assertEqual(list(Path(store.folder.name).iterdir()), [])

    def test_preview_eviction_and_expiration_remove_temporary_files(self):
        docs = [self.upload_pdf().get_json()["document"] for _ in range(4)]
        store = self.app.extensions["pdf_previews"]
        self.assertEqual(len(store.entries), 3)
        self.assertEqual(self.client.get(f"/api/files/preview/{docs[0]['id']}/1").status_code, 404)
        for entry in store.entries.values():
            entry["seen"] -= 1801
        self.assertEqual(self.client.get(f"/api/files/preview/{docs[-1]['id']}/1").status_code, 404)
        self.assertEqual(list(Path(store.folder.name).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
