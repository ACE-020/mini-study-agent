from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import pymupdf
from werkzeug.datastructures import FileStorage

from agent import StudyAgent
from cancellation import CancellationToken, OperationCancelled
from demo import MISTAKE
from document_input import DocumentReader, parse_page_range
from library import validate_refs
from test_core import ScriptedClient, call
from test_notes import FakeExporter, CONTENT
from tools import LocalTools
from web import create_app


def pdf_bytes(scanned=False, pages=2):
    with pymupdf.open() as document:
        for index in range(pages):
            page = document.new_page(width=400, height=500)
            if not scanned:
                page.insert_text((30, 50), f"Exercise {index+1}: Find derivative of f(x) = x^2, for real x.")
            else:
                page.draw_rect(pymupdf.Rect(30,30,180,200), color=(0,0,0))
        return document.tobytes()


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.tools = LocalTools(self.root, note_exporter=FakeExporter(self.root))
        self.note = self.tools.save_note("数列", CONTENT)["note"]
        self.mistake = self.tools.save_mistake(**MISTAKE)["mistake"]
        self.refs = [{"kind":"note", "id":self.note["id"]}, {"kind":"mistake", "id":self.mistake["id"]}]

    def test_selection_is_typed_and_resolves_server_records(self):
        selected = self.tools.library.select(self.refs+self.refs)
        self.assertEqual(len(selected), 2)
        self.assertEqual(selected[0]["record"]["content"], CONTENT.strip())
        for bad in ([],[{"kind":[],"id":"x"}],[{"kind":"mistake","id":"unknown"}],[{"kind":"note","id":"x","path":"secret"}]):
            with self.assertRaises(ValueError):
                self.tools.library.select(bad)

    def test_delete_tool_is_only_a_preview(self):
        result = self.tools.execute("delete_records", json.dumps({"items":self.refs}))
        self.assertTrue(result["ok"])
        self.assertTrue(result["data"]["requires_confirmation"])
        self.assertEqual(len(self.tools._read("notes.json")), 1)
        self.assertEqual(self.tools.get_mistakes()["total"], 1)

    def test_confirm_delete_removes_only_selected_and_preserves_backup(self):
        extra = self.tools.save_note("另一份", "保留的内容")["note"]
        result = self.tools.library.confirm_delete(self.tools.library.propose_delete(self.refs))
        self.assertEqual(result["deleted"], 2)
        self.assertEqual([item["id"] for item in self.tools._read("notes.json")], [extra["id"]])
        self.assertEqual(self.tools.get_mistakes()["total"], 0)
        trash = json.loads((self.root/"trash.json").read_text(encoding="utf-8"))
        self.assertEqual({item["kind"] for item in trash}, {"note","mistake"})
        self.assertFalse((self.root/"library.transaction.json").exists())

    def test_changed_record_invalidates_preview(self):
        proposal = self.tools.library.propose_delete(self.refs)
        data = self.tools._read("notes.json")
        data[0]["content"] = "被修改后的内容"
        self.tools._write_records("notes.json", data)
        with self.assertRaisesRegex(ValueError, "改变"):
            self.tools.library.confirm_delete(proposal)
        self.assertEqual(self.tools.get_mistakes()["total"], 1)

    def test_partial_delete_failure_rolls_back_both_libraries(self):
        proposal = self.tools.library.propose_delete(self.refs)
        original = self.tools._write_records
        failed = False
        def write(name, records):
            nonlocal failed
            if name=="mistakes.json" and not failed:
                failed=True
                raise OSError("模拟磁盘写入失败")
            return original(name, records)
        with patch.object(self.tools,"_write_records",side_effect=write):
            with self.assertRaises(OSError):
                self.tools.library.confirm_delete(proposal)
        self.assertEqual(len(self.tools._read("notes.json")), 1)
        self.assertEqual(self.tools.get_mistakes()["total"], 1)
        self.assertFalse((self.root/"library.transaction.json").exists())

    def test_restart_recovers_interrupted_batch(self):
        before={name:json.loads((self.root/name).read_text(encoding="utf-8")) if (self.root/name).exists() else None
                for name in ("notes.json","mistakes.json","trash.json")}
        self.tools._write_records("library.transaction.json",{"before":before})
        self.tools._write_records("notes.json",[])
        reloaded=LocalTools(self.root)
        self.assertEqual(len(reloaded._read("notes.json")),1)
        self.assertEqual(reloaded.get_mistakes()["total"],1)

    def test_merge_preview_does_not_write(self):
        result=self.tools.execute("merge_records",json.dumps({"items":self.refs,"topic":"共同知识点","content":"## 合并\n\n原文和错因。"}))
        self.assertTrue(result["ok"])
        self.assertEqual(len(self.tools._read("notes.json")),1)

    def test_merge_can_remove_old_notes_and_keeps_mistake_evidence(self):
        proposal=self.tools.library.propose_merge(self.refs,"合并结果","## 合并\n\n保留公式与错因。")
        result=self.tools.library.confirm_merge(proposal,remove_source_notes=True)
        records=self.tools._read("notes.json")
        self.assertEqual(len(records),1)
        self.assertEqual(records[0]["id"],result["note"]["id"])
        self.assertEqual(self.tools.get_mistakes()["total"],1)
        self.assertTrue(list((self.root/"merge_backups").glob("*.json")))

    def test_library_agent_cannot_delete_unselected_or_write_directly(self):
        selected=self.tools.library.select([self.refs[0]])
        model=ScriptedClient([call("delete_records",{"items":[self.refs[1]]}),call("save_note",{"topic":"非法改写","content":"不能保存"}),{"role":"assistant","content":"请核对所选内容。"}])
        StudyAgent(model,self.tools).run("删除",task="library",selection=selected)
        self.assertFalse(json.loads(model.requests[1][-1]["content"])["ok"])
        self.assertFalse(json.loads(model.requests[2][-1]["content"])["ok"])
        self.assertEqual(len(self.tools._read("notes.json")),1)
        self.assertEqual(self.tools.get_mistakes()["total"],1)

    def test_mixed_input_can_save_both_kinds_in_same_round(self):
        first=call("save_note",{"topic":"导数笔记","content":"## 导数\n\n$(x^2)'=2x$。"})
        first["tool_calls"].extend(call("save_mistake",{**MISTAKE,"question":"混合原稿里的题"},"save-mixed")["tool_calls"])
        model=ScriptedClient([first,{"role":"assistant","content":"笔记与错题都已收录。下一步先检查系数。"}])
        agent=StudyAgent(model,self.tools)
        agent.run("一张图片含笔记与我的错题。",task="mixed")
        self.assertEqual(len(self.tools._read("notes.json")),2)
        self.assertEqual(self.tools.get_mistakes()["total"],2)
        returned=[item for item in model.requests[1] if item["role"]=="tool"]
        self.assertTrue(all(json.loads(item["content"])["ok"] for item in returned))

    def test_legacy_note_input_accepts_mistake_without_reupload(self):
        model=ScriptedClient([call("save_mistake",{**MISTAKE,"question":"放在笔记入口的错题"}),{"role":"assistant","content":"已按错题收录。"}])
        StudyAgent(model,self.tools).run("这是错题。",task="notes")
        self.assertEqual(self.tools.get_mistakes()["total"],2)

    def test_selection_analysis_cannot_search_unselected_notes(self):
        selected=self.tools.library.select([self.refs[0]])
        model=ScriptedClient([call("search_notes",{"query":"其他笔记"}),{"role":"assistant","content":"只分析当前所选。"}])
        StudyAgent(model,self.tools).run("分析共同点。",task="library",selection=selected)
        self.assertFalse(json.loads(model.requests[1][-1]["content"])["ok"])


class PdfInputTests(unittest.TestCase):
    def test_text_pdf_is_local_and_reads_all_pages(self):
        def forbidden():
            raise AssertionError("文字型 PDF 不应调用 OCR")
        result=DocumentReader(forbidden).read([FileStorage(BytesIO(pdf_bytes()),filename="习题.pdf")])
        self.assertEqual(len(result["pages"]),2)
        self.assertIn("Exercise 1",result["text"])
        self.assertIn("Exercise 2",result["text"])
        self.assertTrue(all(item["method"]=="text" for item in result["pages"]))

    def test_scanned_pdf_uses_ocr_for_each_page_and_preserves_order(self):
        class Reader:
            count=0
            def read(self,raw,cancel_token=None):
                self.count+=1
                return f"扫描原稿第 {self.count} 页"
        reader=Reader()
        result=DocumentReader(lambda:reader).read([FileStorage(BytesIO(pdf_bytes(True)),filename="扫描.pdf")],include_images=True)
        self.assertEqual(reader.count,2)
        self.assertEqual(len(result["images"]),2)
        self.assertLess(result["text"].index("扫描原稿第 1"),result["text"].index("扫描原稿第 2"))

    def test_page_ranges_are_bounded_and_do_not_silently_truncate(self):
        self.assertEqual(parse_page_range("1,3-4",5),[0,2,3])
        for value,total in (("",21),("2-1",5),("0",5),("6",5),("invalid",5)):
            with self.assertRaises(ValueError):
                parse_page_range(value,total)
        result=DocumentReader(lambda:None).read([FileStorage(BytesIO(pdf_bytes(pages=25)),filename="书.pdf")],page_range="3-5")
        self.assertEqual([item["page"] for item in result["pages"]],[3,4,5])

    def test_batch_text_and_pdf_and_invalid_pdf(self):
        result=DocumentReader(lambda:None).read([FileStorage(BytesIO("笔记原文".encode()),filename="原稿.txt"),FileStorage(BytesIO(pdf_bytes()),filename="原稿.pdf")])
        self.assertIn("笔记原文",result["text"])
        self.assertEqual(len(result["pages"]),3)
        with self.assertRaisesRegex(ValueError,"无法读取"):
            DocumentReader(lambda:None).read([FileStorage(BytesIO(b"broken"),filename="bad.pdf")])

    def test_cancel_between_scanned_pages_stops_late_ocr(self):
        token=CancellationToken()
        class Reader:
            count=0
            def read(self,raw,cancel_token=None):
                self.count+=1
                token.cancel()
                return "第一页"
        reader=Reader()
        with self.assertRaises(OperationCancelled):
            DocumentReader(lambda:reader).read([FileStorage(BytesIO(pdf_bytes(True)),filename="扫描.pdf")],token=token)
        self.assertEqual(reader.count,1)


class LibraryWebTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root=Path(self.directory.name)
        self.model=ScriptedClient([])
        self.exporter_patch=patch("tools.NoteExporter",FakeExporter)
        self.exporter_patch.start();self.addCleanup(self.exporter_patch.stop)
        self.app=create_app(self.root,client_factory=lambda:self.model,settings_path=self.root/"settings.json")
        self.client=self.app.test_client()
        self.tools=LocalTools(self.root,note_exporter=FakeExporter(self.root))
        self.note=self.tools.save_note("原笔记",CONTENT)["note"]
        self.mistake=self.tools.save_mistake(**MISTAKE)["mistake"]
        self.refs=[{"kind":"note","id":self.note["id"]},{"kind":"mistake","id":self.mistake["id"]}]

    def test_confirmation_is_required_and_bound_to_session(self):
        proposal=self.client.post("/api/library/delete-preview",json={"items":self.refs}).get_json()["proposal"]
        self.assertEqual(self.tools.get_mistakes()["total"],1)
        self.assertEqual(self.client.post("/api/library/confirm",json={"proposal_id":proposal["id"]}).status_code,400)
        other=self.app.test_client()
        self.assertEqual(other.post("/api/library/confirm",json={"proposal_id":proposal["id"],"confirmed":True}).status_code,409)
        result=self.client.post("/api/library/confirm",json={"proposal_id":proposal["id"],"confirmed":True})
        self.assertEqual(result.status_code,200,result.get_json())
        self.assertEqual(result.get_json()["data"]["deleted"],2)
        self.assertEqual(self.client.get("/api/mistakes").get_json()["data"]["total"],0)
        self.assertEqual(self.client.post("/api/library/confirm",json={"proposal_id":proposal["id"],"confirmed":True}).status_code,409)

    def test_ai_delete_returns_preview_then_needs_confirmation(self):
        self.model.replies=iter([call("delete_records",{"items":self.refs})])
        response=self.client.post("/api/chat",json={"view":"analysis","message":"删除我选中的两条。","selection":self.refs})
        self.assertEqual(response.status_code,200,response.get_json())
        self.assertEqual(len(response.get_json()["proposals"]),1)
        self.assertEqual(len(self.tools._read("notes.json")),1)

    def test_merge_preview_is_editable_and_originals_can_be_kept(self):
        self.model.replies=iter([call("merge_records",{"items":self.refs,"topic":"合并","content":"## 原稿\n\n合并内容。"})])
        response=self.client.post("/api/chat",json={"view":"analysis","message":"合并","selection":self.refs})
        proposal=response.get_json()["proposals"][0]
        response=self.client.post("/api/library/confirm",json={"proposal_id":proposal["id"],"confirmed":True,"note":{"topic":"编辑后的知识点","content":"## 编辑\n\n我核对过的正文。"}})
        self.assertEqual(response.status_code,200,response.get_json())
        self.assertEqual(len(self.tools._read("notes.json")),2)
        self.assertEqual(self.tools.get_mistakes()["total"],1)
        self.assertIn("我核对过",response.get_json()["data"]["note"]["content"])

    def test_pdf_material_upload_and_unified_original_images(self):
        response=self.client.post("/api/materials/read",data={"files":(BytesIO(pdf_bytes()),"练习.pdf")})
        self.assertEqual(response.status_code,200,response.get_json())
        self.assertEqual(len(response.get_json()["pages"]),2)
        response=self.client.post("/api/intake/read",data={"files":(BytesIO(pdf_bytes()),"混合.pdf")})
        self.assertEqual(response.status_code,200,response.get_json())
        ids=response.get_json()["image_ids"]
        self.assertEqual(len(ids),2)
        self.model.replies=iter([{"role":"assistant","content":"请补充你的答案。"}])
        response=self.client.post("/api/chat",json={"view":"organize","message":"请整理这份资料。","image_ids":ids})
        self.assertEqual(response.status_code,200,response.get_json())
        self.assertGreaterEqual(len(self.model.requests[0][-1]["content"]),3)
        self.assertEqual(self.model.requests[0][-1]["content"][1]["type"],"image_url")

    def test_ui_has_no_global_stats_and_one_input_section(self):
        html=self.client.get("/").get_data(as_text=True)
        self.assertNotIn('class="stats"',html)
        self.assertNotIn('id="note-input-panel"',html)
        self.assertIn('id="add-note"',html)
        self.assertIn('id="add-mistake"',html)
        self.assertIn('id="selection-tray"',html)

    def test_changing_selection_starts_fresh_analysis_context(self):
        self.model.replies=iter([{"role":"assistant","content":"第一批的旧分析标记。"},
                                 {"role":"assistant","content":"第二批的新分析标记。"},
                                 {"role":"assistant","content":"继续第二批。"}])
        for refs in ([self.refs[0]],[self.refs[1]],[self.refs[1]]):
            response=self.client.post("/api/chat",json={"view":"analysis","message":"分析这批。","selection":refs})
            self.assertEqual(response.status_code,200,response.get_json())
        second=self.model.requests[1]
        third=self.model.requests[2]
        self.assertFalse(any(item.get("content")=="第一批的旧分析标记。" for item in second))
        self.assertTrue(any(item.get("content")=="第二批的新分析标记。" for item in third))


if __name__=="__main__":
    unittest.main()
