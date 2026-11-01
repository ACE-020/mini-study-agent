from io import BytesIO
import json
from pathlib import Path
import tempfile
import time
import threading
import unittest

from materials import MaterialParser
from llm import ModelError
from test_core import ScriptedClient
from test_material_capacity import pdf_bytes
from web import create_app
from material_jobs import MaterialJobs


def reply(number,page):
    return {"content":json.dumps({"exercises":[{"number":str(number),"topic":"导数",
        "question":"求 $x^"+str(number)+"$ 的导数。","answer":"","page_index":page}],"warnings":[]})}


class MaterialRecoveryTests(unittest.TestCase):
    def app(self,model):
        directory=tempfile.TemporaryDirectory();self.addCleanup(directory.cleanup)
        class Reader:
            def read(self,raw,cancel_token=None):return "本地测试用扫描页文字。"
        app=create_app(Path(directory.name)/"data",client_factory=lambda:model,reader_factory=Reader,settings_path=Path(directory.name)/"settings.json")
        self.addCleanup(app.extensions["pdf_previews"].close)
        return app

    def wait(self,client,id):
        for _ in range(300):
            job=client.get("/api/materials/jobs/"+id).json["job"]
            if job["status"] not in ("queued","running"):return job
            time.sleep(.01)
        self.fail("任务未结束")

    def test_format_errors_are_distinct_from_an_incomplete_source(self):
        for content,word in (('{"exercises":[',"JSON"),
                             (json.dumps({"exercises":[{"question":"完整题干","topic":3}]}),"字段校验")):
            with self.assertRaisesRegex(ModelError,word) as caught:
                MaterialParser(ScriptedClient([{"content":content}])).parse("完整的两套试卷")
            self.assertNotIn("请检查原文后重试",str(caught.exception))
            self.assertIn("不表示原文件",str(caught.exception))

    def test_optional_null_metadata_does_not_discard_a_readable_question(self):
        content={"exercises":[{"topic":"导数","question":"求导数。","answer":None,"paper":None,"tags":None,
                              "origin_regions":None,"source_anchor":None,"answer_page_indices":None}],
                 "warnings":None,"issues":None,"answer_fragments":None}
        result=MaterialParser(ScriptedClient([{"content":json.dumps(content)}])).parse("完整题目")
        self.assertEqual(result["exercises"][0]["question"],"求导数。")
        self.assertEqual(result["exercises"][0]["answer"],"")

    def test_cancelled_attempt_cannot_overwrite_a_new_retry(self):
        started=threading.Event();release=threading.Event();second=threading.Event()
        class Parser:
            calls=0
            def parse(self,text,cancel_token=None):
                Parser.calls+=1
                if Parser.calls==1:
                    started.set();release.wait(3);raise ModelError("旧请求迟到的失败")
                second.set()
                return {"exercises":[{"topic":"导数","question":"完整题目"}],"warnings":[]}
        jobs=MaterialJobs(Parser,workers=2);job=jobs.submit("owner","原文","来源")
        self.assertTrue(started.wait(2));jobs.cancel("owner",job["id"]);jobs.retry("owner",job["id"])
        self.assertTrue(second.wait(2))
        for _ in range(100):
            if jobs.get("owner",job["id"])["status"]=="ready":break
            time.sleep(.01)
        release.set();time.sleep(.05)
        self.assertEqual(jobs.get("owner",job["id"])["status"],"ready")

    def test_partial_results_survive_and_retry_calls_only_the_failed_pages(self):
        model=ScriptedClient([reply(1,1),{"content":'{"exercises":['},reply(3,5),reply(2,3)])
        app=self.app(model);client=app.test_client()
        submitted=client.post("/api/materials/jobs",data={"source":"两套试卷","page_range":"1-5","files":(BytesIO(pdf_bytes(7)),"合集.pdf")})
        self.assertEqual(submitted.status_code,202,submitted.json)
        id=submitted.json["job"]["id"];failed=self.wait(client,id)
        self.assertEqual(failed["status"],"failed")
        self.assertEqual(len(failed["result"]["exercises"]),2)
        self.assertEqual(len(failed["result"]["failures"]),1)
        self.assertEqual([p["page"] for p in failed["result"]["failures"][0]["pages"]],[3,4])
        self.assertIn("JSON",failed["result"]["failures"][0]["message"])
        self.assertEqual(len(model.requests),3)
        self.assertEqual(client.post("/api/materials/jobs/"+id+"/retry").status_code,202)
        completed=self.wait(client,id)
        self.assertEqual(completed["status"],"ready",completed)
        self.assertEqual(len(completed["result"]["exercises"]),3)
        self.assertEqual(len(model.requests),4)
        self.assertEqual(client.post("/api/materials/jobs/"+id+"/retry").status_code,409)
        self.assertFalse((Path(app.extensions["material_files"].folder.name)/"exercises.json").exists())

    def test_original_file_is_available_for_full_preview_reading_and_next_range(self):
        model=ScriptedClient([reply(1,1),reply(2,1)])
        app=self.app(model);client=app.test_client()
        submitted=client.post("/api/materials/jobs",data={"source":"合集","page_range":"1","files":(BytesIO(pdf_bytes(7)),"合集.pdf")})
        job=self.wait(client,submitted.json["job"]["id"])
        files=job["source_files"];self.assertEqual(files[0]["pages"],7)
        self.assertNotIn("path",files[0])
        key=files[0]["id"]
        self.assertEqual(client.get("/api/materials/files/"+key+"/pages/7").status_code,200)
        text=client.post("/api/materials/read",data={"source_file_ids":json.dumps([key]),"page_range":"6-7"})
        self.assertEqual(text.status_code,200,text.json)
        next_job=client.post("/api/materials/jobs",json={"source":"合集","source_file_ids":[key],"page_range":"6-7","text":""})
        self.assertEqual(next_job.status_code,202,next_job.json)
        self.assertEqual(next_job.json["job"]["metadata"]["files"][0]["pages"],[6,7])
        self.assertEqual(next_job.json["job"]["source_files"][0]["id"],key)
        self.wait(client,next_job.json["job"]["id"])

    def test_cached_original_and_retry_are_owner_bound_and_expiry_is_explicit(self):
        app=self.app(ScriptedClient([{"content":"not json"},reply(1,1)]))
        a,b=app.test_client(),app.test_client()
        submitted=a.post("/api/materials/jobs",data={"source":"合集","page_range":"1","files":(BytesIO(pdf_bytes(2)),"合集.pdf")})
        job=self.wait(a,submitted.json["job"]["id"]);key=job["source_files"][0]["id"]
        self.assertEqual(b.get("/api/materials/files/"+key+"/pages/1").status_code,404)
        self.assertEqual(b.post("/api/materials/jobs/"+job["id"]+"/retry").status_code,404)
        denied=b.post("/api/materials/jobs",json={"source":"其他人","source_file_ids":[key],"page_range":"1"})
        self.assertEqual(denied.status_code,400)
        app.extensions["material_files"].entries[key]["seen"]-=7201
        expired=a.post("/api/materials/jobs",json={"source":"合集","source_file_ids":[key],"page_range":"2"})
        self.assertEqual(expired.status_code,400);self.assertIn("过期",expired.json["error"])
        # A job's selected original images outlive the full-file cache and still support retry.
        self.assertEqual(a.post("/api/materials/jobs/"+job["id"]+"/retry").status_code,202)
        self.assertEqual(self.wait(a,job["id"])["status"],"ready")

    def test_clear_preserves_sources_needed_by_tasks_and_removes_unreferenced_files(self):
        app=self.app(ScriptedClient([reply(1,1)]));client=app.test_client()
        submitted=client.post("/api/materials/jobs",data={"source":"合集","page_range":"1","files":(BytesIO(pdf_bytes(2)),"合集.pdf")})
        job=self.wait(client,submitted.json["job"]["id"]);key=job["source_files"][0]["id"]
        payload={"preview_ids":[],"source_file_ids":[key]}
        self.assertEqual(client.post("/api/materials/clear",json=payload).status_code,200)
        self.assertEqual(client.get("/api/materials/files/"+key+"/pages/1").status_code,200)
        client.post("/api/materials/jobs/"+job["id"]+"/remove")
        self.assertEqual(client.post("/api/materials/clear",json=payload).status_code,200)
        self.assertEqual(client.get("/api/materials/files/"+key+"/pages/1").status_code,404)


if __name__=="__main__":unittest.main()
