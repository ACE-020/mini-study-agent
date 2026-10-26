from io import BytesIO
import json
from pathlib import Path
import tempfile
import time
import unittest

from werkzeug.datastructures import FileStorage

from material_sources import capture_materials, image_parts
from materials import MaterialParser, material_rules
from test_core import ScriptedClient
from test_library_input import pdf_bytes
from test_tutoring_materials import ITEMS
from web import create_app


class MaterialVisionTests(unittest.TestCase):
    def setUp(self):
        self.folder=tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root=Path(self.folder.name)

    def capture(self, page_range="1"):
        return capture_materials([FileStorage(BytesIO(pdf_bytes()),filename="原始试卷.pdf")],page_range)

    def app(self,model):
        app=create_app(self.root,client_factory=lambda:model,settings_path=self.root/"settings.json")
        self.addCleanup(app.extensions["pdf_previews"].close)
        return app

    def wait(self,client,identity):
        for _ in range(150):
            job=client.get(f"/api/materials/jobs/{identity}").json["job"]
            if job["status"] not in ("queued","running"):return job
            time.sleep(.01)
        self.fail("任务未完成")

    def test_text_pdf_is_captured_as_images_without_ocr_or_flattening(self):
        result=self.capture(" 1，2 ")
        self.assertEqual(result["text"],"")
        self.assertEqual(len(result["documents"]),2)
        self.assertEqual(result["metadata"]["page_range"]," 1，2 ")
        self.assertEqual(result["metadata"]["files"][0]["pages"],[1,2])
        self.assertTrue(result["documents"][0]["image"].startswith("data:image/jpeg;base64,"))

    def test_visual_parser_sends_original_and_detail_images_in_one_structuring_call(self):
        docs=self.capture()["documents"]
        question=r"求 $\frac{\sqrt{x\sqrt{x}}-1}{x-1}$ 的极限。"
        client=ScriptedClient([{"content":json.dumps({"exercises":[{**ITEMS[0],"question":question,"page_index":1}],"warnings":[]})}])
        result=MaterialParser(client).parse_images(docs)
        self.assertEqual(len(client.requests),1)
        content=client.requests[0][1]["content"]
        self.assertGreaterEqual(sum(part["type"]=="image_url" for part in content),3)
        self.assertEqual(result["exercises"][0]["question"],question)
        self.assertIn("LaTeX",material_rules())

    def test_source_preview_and_original_page_are_session_bound(self):
        model=ScriptedClient([{"content":json.dumps({"exercises":[{**ITEMS[0],"page_index":1}],"warnings":[]})}])
        app=self.app(model);a,b=app.test_client(),app.test_client()
        submitted=a.post('/api/materials/jobs',data={"source":"习题集","page_range":"1", "files":(BytesIO(pdf_bytes()),'原试卷.pdf')})
        self.assertEqual(submitted.status_code,202)
        identity=submitted.json["job"]["id"];job=self.wait(a,identity)
        self.assertEqual(job["status"],"ready")
        self.assertEqual(job["metadata"]["batch_number"],1)
        self.assertEqual(job["metadata"]["files"][0]["page_range"],"1")
        self.assertNotIn("base64",json.dumps(job))
        self.assertEqual(a.get(f'/api/materials/jobs/{identity}/pages/1').mimetype,'image/jpeg')
        self.assertEqual(b.get(f'/api/materials/jobs/{identity}/pages/1').status_code,404)
        self.assertFalse((self.root/'exercises.json').exists())

    def test_question_revision_maps_subset_indices_and_keeps_original_math(self):
        question=r"$f(x)=\begin{cases}x^{a/(x-1)}&x>1\\\frac{\sqrt{x\sqrt{x}}-1}{x-1}&0<x<1\end{cases}$"
        model=ScriptedClient([{"content":json.dumps({"message":"待确认","changes":[{"index":0,"fields":{"question":question}}]})}])
        result=MaterialParser(model).revise(ITEMS,'核对第二题',images=self.capture()["documents"],selected_indices=[1])
        self.assertEqual(result["changes"][0]["index"],1)
        content=model.requests[0][1]["content"]
        text=json.loads(content[0]["text"])
        self.assertEqual(len(text["exercises"]),1)
        self.assertEqual(text["exercises"][0],ITEMS[1])
        self.assertTrue(any(part["type"]=="image_url" for part in content))

    def test_batch_sequence_is_stable_after_task_removal(self):
        model=ScriptedClient([{"content":json.dumps({"exercises":[],"warnings":[]})} for _ in range(3)])
        client=self.app(model).test_client()
        first=client.post('/api/materials/jobs',json={"source":"第一批","text":"原文"}).json['job']
        self.wait(client,first['id']);client.post(f'/api/materials/jobs/{first["id"]}/remove')
        second=client.post('/api/materials/jobs',json={"source":"第二批","text":"原文"}).json['job']
        self.assertEqual(second['metadata']['batch_number'],2)

    def test_import_keeps_confirmed_batch_provenance_without_private_images(self):
        model=ScriptedClient([{"content":json.dumps({"exercises":[{**ITEMS[0],"page_index":1}],"warnings":[]})}])
        client=self.app(model).test_client()
        submitted=client.post('/api/materials/jobs',data={"source":"习题集","page_range":"1", "files":(BytesIO(pdf_bytes()),'原试卷.pdf')}).json['job']
        job=self.wait(client,submitted['id'])
        result=client.post('/api/exercises',json={"confirmed":True,"source":"习题集","exercises":job['result']['exercises'],"job_id":job['id']})
        self.assertEqual(result.status_code,200)
        record=client.get('/api/exercises').json['exercises'][0]
        self.assertEqual(record['provenance']['batch_number'],1)
        self.assertEqual(record['provenance']['files'][0]['page_range'],'1')
        self.assertNotIn('base64',json.dumps(record))

    def test_invalid_revision_indices_do_not_call_model(self):
        model=ScriptedClient([])
        for indices in ([],[True],[[]],[2],[0,0]):
            with self.assertRaises(ValueError):MaterialParser(model).revise(ITEMS,'核对',selected_indices=indices)
        self.assertEqual(model.requests,[])


if __name__=='__main__':unittest.main()
