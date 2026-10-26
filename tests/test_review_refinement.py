from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from classification import clean_tags
from agent import StudyAgent
from document_input import parse_page_range
from library import fingerprint
from materials import MaterialParser, QuestionBank, validate_exercises
from settings import SettingsStore
from test_core import ScriptedClient
from test_library_input import pdf_bytes
from test_tutoring_materials import ITEMS
from web import create_app
from tools import LocalTools

class ReviewRefinementTests(unittest.TestCase):
    def setUp(self):
        self.folder=tempfile.TemporaryDirectory();self.addCleanup(self.folder.cleanup);self.root=Path(self.folder.name)

    def test_fine_tags_and_paper_survive_update_without_changing_original_source(self):
        bank=QuestionBank(self.root);bank.add('合集.pdf',[{**ITEMS[0],'paper':'2024第一套','number':'一、3','tags':['洛必达法则','洛必达法'],'page_index':16,'answer_page_indices':[19]}])
        original=bank.read()[0];self.assertEqual(original['tags'],['洛必达法'])
        bank.update(original['id'],original['source'],{**ITEMS[0],'paper':'自选题组','tags':['泰勒展开']},fingerprint(original))
        updated=bank.read()[0];self.assertEqual(updated['paper'],'自选题组');self.assertEqual(updated['source'],'合集.pdf');self.assertEqual(updated['page_index'],16)

    def test_same_chapter_selection_does_not_substitute_another_fine_type(self):
        bank=QuestionBank(self.root);bank.add('资料',[{**ITEMS[0],'topic':'极限','tags':['单侧极限']},{**ITEMS[1],'topic':'极限','tags':['泰勒展开']}])
        self.assertEqual(bank.pick('极限',tags=['泰勒公式'])['exercise']['number'],ITEMS[1]['number'])
        self.assertIsNone(bank.pick('极限',tags=['定积分定义'])['exercise'])

    def test_same_number_and_question_in_different_papers_are_not_collapsed(self):
        bank=QuestionBank(self.root)
        result=bank.add('合集.pdf',[{**ITEMS[0],'paper':'第一套'},{**ITEMS[0],'paper':'第二套'}])
        self.assertEqual(result['added'],2)
        self.assertEqual(bank.add('合集.pdf',[{**ITEMS[0],'paper':'第一套'}])['duplicates'],1)

    def test_continuing_practice_passes_fine_tags_through_the_real_tool_dispatcher(self):
        tools=LocalTools(self.root);tools.bank.add('资料',[{**ITEMS[0],'topic':'极限','tags':['单侧极限']},{**ITEMS[1],'topic':'极限','tags':['泰勒展开']}])
        model=ScriptedClient([]);agent=StudyAgent(model,tools);agent.current_topic='极限';agent.current_tags=['泰勒展开']
        answer=agent.run('出');self.assertIn(ITEMS[1]['question'],answer);self.assertIn('泰勒展开',answer);self.assertEqual(model.requests,[])

    def test_bulk_grouping_checks_all_revisions_before_any_write(self):
        bank=QuestionBank(self.root);bank.add('资料',ITEMS);records=bank.read();before=bank.path.read_bytes()
        with self.assertRaises(ValueError):bank.organize([{'id':r['id'],'revision':fingerprint(r) if i==0 else 'stale'} for i,r in enumerate(records)],paper='新题组')
        self.assertEqual(bank.path.read_bytes(),before)
        bank.organize([{'id':r['id'],'revision':fingerprint(r)} for r in records],paper='自选题组',tags=['单侧极限'])
        self.assertTrue(all(r['paper']=='自选题组' for r in bank.read()))

    def test_correction_followup_has_history_and_visible_question_number(self):
        model=ScriptedClient([{'content':json.dumps({'message':'请说明分母范围','changes':[]})}]);history=[{'role':'user','text':'请核对根号'},{'role':'assistant','text':'请说明范围'}]
        MaterialParser(model).revise(ITEMS,'是整个分子',history=history,selected_indices=[1])
        content=json.loads(model.requests[0][-1]['content']);self.assertEqual(content['conversation'],history);self.assertEqual(content['display_numbers'],[2]);self.assertEqual(content['exercises'],[ITEMS[1]])

    def test_bad_history_and_bad_metadata_do_not_call_model(self):
        model=ScriptedClient([])
        with self.assertRaises(ValueError):MaterialParser(model).revise(ITEMS,'修改',history=[{'role':'system','text':'任意指令'}])
        for fields in ({'tags':['']},{'paper':False},{'answer_page_indices':[True]}):
            with self.assertRaises(ValueError):validate_exercises([{**ITEMS[0],**fields}])
        self.assertEqual(model.requests,[])

    def test_direct_import_and_optional_text_read_share_twenty_page_capacity(self):
        from material_sources import MAX_MATERIAL_PAGES
        self.assertEqual(len(parse_page_range('21-40',598,max_pages=MAX_MATERIAL_PAGES)),20)
        with self.assertRaises(ValueError):parse_page_range('21-120',598,max_pages=MAX_MATERIAL_PAGES)
        with self.assertRaises(ValueError):parse_page_range('1-21',583)

    def test_shared_original_prepare_calls_no_model_and_text_followup_uses_no_images(self):
        visual=ScriptedClient([{'role':'assistant','content':'### 原稿识别\n求函数 f(x)=x^2 的导数，定义域为实数。\n### 下一步\n请补充你的答案。'}]);main=ScriptedClient([{'role':'assistant','content':'接下来只检查第一步。'}])
        settings=self.root/'settings.json';SettingsStore(settings).save({'base_url':'https://main.invalid','api_key':'fake-main','model':'main-model','ocr_base_url':'https://vision.invalid','ocr_api_key':'fake-vision','ocr_model':'vision-model'})
        with patch('web.ModelClient',side_effect=lambda base,key,model,**kw:visual if model=='vision-model' else main):
            app=create_app(self.root/'data',settings_path=settings,local_ocr_runtime=False);self.addCleanup(app.extensions['pdf_previews'].close);client=app.test_client()
            prepared=client.post('/api/intake/prepare',data={'files':(BytesIO(pdf_bytes()),'混合.pdf'),'page_range':'1'})
            self.assertEqual(prepared.status_code,200,prepared.json);self.assertEqual(main.requests,[]);self.assertEqual(visual.requests,[])
            response=client.post('/api/chat',json={'view':'organize','message':'按原图整理','new_problem':True,'image_ids':prepared.json['image_ids']})
            self.assertEqual(response.status_code,200,response.json);self.assertTrue(any(p.get('type')=='image_url' for p in visual.requests[0][-1]['content']));self.assertEqual(main.requests,[])
            response=client.post('/api/chat',json={'view':'organize','message':'我的第一步是这样'})
            self.assertEqual(response.status_code,200,response.json);self.assertTrue(all(isinstance(m.get('content'),str) or m.get('content') is None for m in main.requests[0]))
            self.assertIn('f(x)=x^2',json.dumps(main.requests[0],ensure_ascii=False))

    def test_untranscribed_image_is_retained_for_followup_instead_of_losing_the_question(self):
        visual=ScriptedClient([{'role':'assistant','content':'这部分看不清，请补充。'},{'role':'assistant','content':'现在再核对原图。'}]);main=ScriptedClient([])
        settings=self.root/'settings.json';SettingsStore(settings).save({'base_url':'https://main.invalid','api_key':'fake-main','model':'main-model','ocr_base_url':'https://vision.invalid','ocr_api_key':'fake-vision','ocr_model':'vision-model'})
        with patch('web.ModelClient',side_effect=lambda base,key,model,**kw:visual if model=='vision-model' else main):
            app=create_app(self.root/'data',settings_path=settings,local_ocr_runtime=False);self.addCleanup(app.extensions['pdf_previews'].close);client=app.test_client()
            prepared=client.post('/api/intake/prepare',data={'files':(BytesIO(pdf_bytes()),'原题.pdf'),'page_range':'1'})
            self.assertEqual(client.post('/api/chat',json={'view':'organize','message':'请检查原题','image_ids':prepared.json['image_ids']}).status_code,200)
            self.assertEqual(client.post('/api/chat',json={'view':'organize','message':'这里是嵌套根号'}).status_code,200)
            self.assertEqual(len(visual.requests),2);self.assertEqual(main.requests,[])
            self.assertTrue(any(isinstance(m.get('content'),list) for m in visual.requests[1]))

if __name__=='__main__':unittest.main()
