from copy import deepcopy
from io import BytesIO
import json
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from cancellation import CancellationToken
from local_materials import LocalMaterialParser
from material_jobs import MaterialJobs
from material_locations import pdf_layouts, bind_location, reconcile_batch
from materials import MaterialParser
from settings import SettingsStore
from test_local_ocr import FakeRuntime, RecordingModel, image_bytes
from test_material_locations import doc, item, PAPER1, PAPER2
from web import create_app


class BothModesModel(RecordingModel):
    def complete(self,messages,tools=None):
        if isinstance(messages[-1].get('content'),list) and '以下 JSON 中的 text' in messages[-1]['content'][0].get('text',''):
            self.requests.append(messages)
            return {'role':'assistant','content':json.dumps({'exercises':[{'number':'一、1','paper':'1 测试卷','topic':'极限','question':'计算 $x+1$','answer':'2','page_index':1}],'warnings':[]})}
        return super().complete(messages,tools)


class ChoiceTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory();self.addCleanup(self.directory.cleanup)
        self.root=Path(self.directory.name);self.settings=self.root/'settings.json'
        self.runtime=FakeRuntime();self.client=BothModesModel()
        self.app=create_app(self.root/'data',client_factory=lambda:self.client,settings_path=self.settings,local_ocr_runtime=self.runtime)
        self.addCleanup(self.app.extensions['stop_background']);self.browser=self.app.test_client()

    def test_choice_persists_without_key_and_both_backends_are_available(self):
        self.assertTrue(self.browser.get('/api/status').json['local_ocr'])
        response=self.browser.post('/api/ocr/backend',json={'backend':'remote'})
        self.assertEqual(response.status_code,200,response.json)
        self.assertFalse(self.browser.get('/api/status').json['local_ocr'])
        self.assertEqual(SettingsStore(self.settings).resolve()['ocr_backend'],'remote')
        self.assertEqual(self.browser.post('/api/ocr/backend',json={'backend':'guess'}).status_code,400)
        self.assertEqual(self.browser.post('/api/ocr/backend',json={'backend':'local'}).status_code,200)
        self.assertTrue(self.browser.get('/api/status').json['local_ocr'])

    def test_changing_mode_preserves_encrypted_key_and_main_model(self):
        store=SettingsStore(self.settings)
        store.save({'api_key':'secret-not-for-output','model':'main-unchanged'})
        before=json.loads(self.settings.read_text(encoding='utf8'))
        store.set_ocr_backend('remote')
        after=json.loads(self.settings.read_text(encoding='utf8'))
        self.assertEqual(before['api_key'],after['api_key']);self.assertEqual(store.resolve()['model'],'main-unchanged')

    def test_queued_tasks_keep_their_original_provider(self):
        for backend in ('remote','local'):
            self.browser.post('/api/ocr/backend',json={'backend':backend})
            response=self.browser.post('/api/materials/jobs',data={'source':'同一入口','files':(BytesIO(image_bytes()),'image.png')})
            self.assertEqual(response.status_code,202,response.json)
            identity=response.json['job']['id']
            self.assertEqual(response.json['job']['metadata']['ocr_backend'],backend)
            for _ in range(100):
                job=self.browser.get('/api/materials/jobs/'+identity).json['job']
                if job['status'] not in ('queued','running'):break
                time.sleep(.01)
            self.assertEqual(job['status'],'ready',job)
            self.assertEqual(job['result']['input_mode'],'local-glm' if backend=='local' else 'vision')

    def test_local_after_cloud_does_not_forward_retained_image_history(self):
        self.browser.post('/api/ocr/backend',json={'backend':'remote'})
        prepared=self.browser.post('/api/intake/prepare',data={'files':(BytesIO(image_bytes()),'image.png')}).json
        # The fake cloud answer is intentionally not a complete transcription,
        # so StudyAgent retains the image for its next conversation round.
        first=self.browser.post('/api/chat',json={'view':'organize','message':'这张看不清吗？','image_ids':prepared['image_ids']})
        self.assertEqual(first.status_code,200,first.json)
        self.browser.post('/api/ocr/backend',json={'backend':'local'})
        start=len(self.client.requests)
        second=self.browser.post('/api/chat',json={'view':'organize','message':'再检查一下'})
        self.assertEqual(second.status_code,200,second.json)
        self.assertNotIn('image_url',json.dumps(self.client.requests[start:]))
        self.assertIn('GLM-OCR',json.dumps(self.client.requests[start:]))


class BindingRegressionTests(unittest.TestCase):
    def test_paper_without_exam_keyword_resets_answer_page_state(self):
        class Page:
            rotation=0;rect=SimpleNamespace(width=600,height=900)
            def __init__(self,values):self.values=values
            def get_text(self,*args,**kwargs):
                return {'blocks':[{'lines':[{'bbox':[70,y,560,y+15],'spans':[{'text':text,'size':size}]} for y,text,size in self.values]}]}
        pdf=[Page([(40,PAPER1,15),(80,'答案',13),(100,'一、1. 1',11)]),
             Page([(40,'7 [分析上期中] [无准确标题] 2023–2024 高数 A 上期中',15),(80,'二、 填空题',11),(120,'3. 已知 ln cos x',11)]),
             Page([(50,'答案',13),(100,'二、3. 参考答案',11)])]
        layouts=pdf_layouts(pdf,[1,2]);anchors=layouts[1]['anchors']
        self.assertEqual(anchors[0]['role'],'question');self.assertEqual(anchors[0]['number'],'二、3')
        self.assertTrue(anchors[0]['paper'].startswith('7 '));self.assertEqual(layouts[2]['anchors'][0]['role'],'answer')

    def test_missing_page_is_recovered_from_unique_paper_number_for_both_roles(self):
        documents=[doc(1,PAPER1),doc(2,PAPER2),doc(3,PAPER2,'answer')]
        for role in ('question','answer'):
            raw=item(None,PAPER2)
            bound=bind_location(raw,documents,role)
            self.assertEqual(bound['page_index'],2 if role=='question' else 3)
            self.assertEqual(bound['origin_regions'][0]['role'],role)
        result=reconcile_batch([item(None,PAPER2)],[],[],documents)['exercises'][0]
        self.assertEqual(result['page_index'],2)
        self.assertEqual({r['role'] for r in result['origin_regions']},{'question','answer'})

    def test_ambiguous_question_or_paper_is_not_guessed(self):
        documents=[doc(1,PAPER1),doc(2,PAPER2)]
        self.assertNotIn('origin_regions',bind_location(item(None,''),documents))
        documents=[doc(1,PAPER1),doc(2,PAPER1)]
        self.assertNotIn('origin_regions',bind_location(item(None,PAPER1),documents))


if __name__=='__main__':unittest.main()
