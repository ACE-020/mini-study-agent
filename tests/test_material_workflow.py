import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from cancellation import CancellationToken
from demo import MISTAKE
from library import fingerprint
from library_export import markdown_collection
from llm import ModelError
from material_jobs import MaterialJobs
from materials import MaterialParser, material_rules
from test_core import ScriptedClient
from test_notes import FakeExporter
from tools import LocalTools
from web import create_app


def exercise(number=1):
    return {"number":str(number),"topic":"导数","question":f"求 $x^{{{number+1}}}$ 的导数。","answer":""}


def wait_job(jobs, owner, identity):
    deadline = time.monotonic()+3
    while time.monotonic() < deadline:
        result = jobs.get(owner, identity)
        if result["status"] not in ("queued", "running"):
            return result
        time.sleep(.01)
    raise AssertionError("任务没有结束")


class MaterialWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.folder=tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root=Path(self.folder.name)
        self.local=LocalTools(self.root,note_exporter=FakeExporter(self.root))

    def test_parser_accepts_all_43_and_effective_rules_remove_old_cap(self):
        items=[exercise(i) for i in range(43)]
        client=ScriptedClient([{"content":json.dumps({"exercises":items,"warnings":[]})}])
        result=MaterialParser(client).parse_many("43 道原题")
        self.assertEqual(len(result["exercises"]),43)
        self.assertNotIn("最多返回 20 题",material_rules())
        self.assertEqual(result["segments"],1)
        self.assertFalse((self.root/"exercises.json").exists())

    def test_chunk_warnings_are_scoped_and_total_is_aggregate(self):
        responses=[{"content":json.dumps({"exercises":[exercise(i) for i in range(20)],"warnings":["本段整理 20 题，请核对题号。"]})},
                   {"content":json.dumps({"exercises":[exercise(i) for i in range(20,43)],"warnings":[]})}]
        parser=MaterialParser(ScriptedClient(responses));progress=[]
        result=parser.parse_many("a"*13000+"\n\n"+"b"*13000,progress=lambda d,t:progress.append((d,t)))
        self.assertEqual(len(result["exercises"]),43)
        self.assertEqual(result["warnings"],[])
        self.assertIn("本段整理 20 题",result["diagnostics"][0])
        self.assertEqual(progress[-1],(2,2))

    def test_correction_keeps_identity_and_rejects_stale_write(self):
        self.local.bank.add("资料",[exercise()]);before=self.local.bank.read()[0]
        after=self.local.bank.update(before["id"],"资料",{**exercise(),"question":"核对后的题干"},fingerprint(before))
        self.assertEqual(after["id"],before["id"])
        self.assertEqual(after["created_at"],before["created_at"])
        raw=(self.root/"exercises.json").read_bytes()
        with self.assertRaisesRegex(ValueError,"其他页面"):
            self.local.bank.update(before["id"],"资料",exercise(),fingerprint(before))
        self.assertEqual((self.root/"exercises.json").read_bytes(),raw)
        self.assertEqual(self.local.bank.add("资料",[{**exercise(),"question":"核对后的题干"}])["duplicates"],1)

    def test_mixed_selection_export_and_delete_rollback_include_exercises(self):
        note=self.local.save_note("公式","$x^2$")["note"]
        mistake=self.local.save_mistake(**MISTAKE)["mistake"]
        self.local.bank.add("习题集",[exercise()]);item=self.local.bank.read()[0]
        refs=[{"kind":kind,"id":record["id"]} for kind,record in (("note",note),("mistake",mistake),("exercise",item))]
        selected=self.local.library.select(refs)
        self.assertIn("习题集",markdown_collection(selected))
        proposal=self.local.library.propose_delete(refs)
        original=self.local._write_records;failed=False
        def write(name,records):
            nonlocal failed
            if name=="exercises.json" and not failed:
                failed=True
                raise OSError("模拟第三个库写入失败")
            original(name,records)
        with patch.object(self.local,"_write_records",side_effect=write):
            with self.assertRaises(OSError):self.local.library.confirm_delete(proposal)
        self.assertEqual(len(self.local.library.select(refs)),3)
        self.assertFalse(self.local.library.journal.exists())
        self.assertEqual(self.local.library.confirm_delete(proposal)["deleted"],3)
        self.assertEqual(self.local.bank.read(),[])

    def test_merge_from_exercise_preserves_source_exercise(self):
        a=self.local.save_note("导数","笔记")["note"]
        self.local.bank.add("资料",[exercise()]);b=self.local.bank.read()[0]
        refs=[{"kind":"note","id":a["id"]},{"kind":"exercise","id":b["id"]}]
        proposal=self.local.library.propose_merge(refs,"整理","合并内容")
        self.local.library.confirm_merge(proposal,remove_source_notes=True)
        self.assertEqual(self.local.bank.read()[0]["id"],b["id"])

    def test_revision_returns_only_validated_proposals_and_never_writes(self):
        reply={"message":"第 1 题已按你的补充提出修改，待确认。","changes":[{"index":0,"fields":{"question":"核对后的完整题干"},"reason":"用户补充"}]}
        result=MaterialParser(ScriptedClient([{"content":json.dumps(reply)}])).revise([exercise()],"改题干")
        self.assertEqual(result["changes"][0]["before"]["question"],exercise()["question"])
        self.assertFalse((self.root/"exercises.json").exists())
        for invalid in [{"index":2,"fields":{"question":"别的题"}},{"index":0,"fields":{"delete":True}},{"index":0,"fields":{"question":""}}]:
            with self.assertRaises(ModelError):
                MaterialParser(ScriptedClient([{"content":json.dumps({"message":"","changes":[invalid]})}])).revise([exercise()],"改")

    def test_background_task_is_isolated_cancellable_and_does_not_block_chat(self):
        started=threading.Event();release=threading.Event()
        class Parser:
            def parse(self,text,cancel_token=None):
                started.set()
                while not release.wait(.01):cancel_token.check()
                return {"exercises":[exercise()],"warnings":[]}
        jobs=MaterialJobs(Parser,workers=1)
        one=jobs.submit("owner","原文","第一批")
        self.assertTrue(started.wait(1))
        second=jobs.submit("owner","原文2","第二批")
        self.assertEqual(jobs.list("other"),[])
        with self.assertRaises(KeyError):jobs.get("other",one["id"])
        jobs.cancel("owner",one["id"])
        release.set()
        self.assertEqual(wait_job(jobs,"owner",one["id"])["status"],"cancelled")
        self.assertEqual(wait_job(jobs,"owner",second["id"])["count"],1)

    def test_job_http_ownership_and_foreground_independence(self):
        started=threading.Event();release=threading.Event()
        class Parser:
            def parse(self,text,cancel_token=None):
                started.set();release.wait(2);cancel_token.check()
                return {"exercises":[exercise()],"warnings":[]}
        model=ScriptedClient([{"content":"你好"}])
        app=create_app(self.root,client_factory=lambda:model,material_parser_factory=Parser,settings_path=self.root/"settings.json")
        self.addCleanup(app.extensions["pdf_previews"].close)
        a,b=app.test_client(),app.test_client()
        response=a.post("/api/materials/jobs",json={"text":"原文","source":"来源"})
        self.assertEqual(response.status_code,202)
        identity=response.json["job"]["id"];self.assertTrue(started.wait(1))
        self.assertEqual(b.get(f"/api/materials/jobs/{identity}").status_code,404)
        self.assertEqual(b.post(f"/api/materials/jobs/{identity}/cancel").status_code,404)
        self.assertEqual(a.post("/api/chat",json={"message":"你好","view":"organize"}).status_code,200)
        self.assertEqual(a.post("/api/materials/clear",json={"preview_ids":[]}).status_code,200)
        self.assertEqual(len(a.get("/api/materials/jobs").json["jobs"]),1)
        a.post(f"/api/materials/jobs/{identity}/cancel");release.set()

    def test_exercise_edit_http_requires_confirmation_and_current_revision(self):
        self.local.bank.add("资料",[exercise()])
        app=create_app(self.root,client_factory=lambda:ScriptedClient([]),settings_path=self.root/"settings.json")
        self.addCleanup(app.extensions["pdf_previews"].close);client=app.test_client()
        listing=client.get("/api/exercises").json;record=listing["exercises"][0]
        payload={"source":"资料","exercise":{**exercise(),"question":"修正题干"},"revision":listing["revisions"][record["id"]]}
        url=f"/api/exercises/{record['id']}"
        self.assertEqual(client.post(url,json=payload).status_code,400)
        self.assertEqual(client.post(url,json={**payload,"confirmed":True}).status_code,200)
        self.assertEqual(client.post(url,json={**payload,"confirmed":True}).status_code,409)
        self.assertEqual(client.get("/api/exercises").json["total"],1)


if __name__=="__main__":unittest.main()
