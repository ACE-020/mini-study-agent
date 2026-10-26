from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

from agent import StudyAgent
from demo import MISTAKE
from materials import QuestionBank
from review_catalog import ReviewCatalog
from test_core import ScriptedClient
from tools import LocalTools
from web import create_app

EXERCISES=[
 {'topic':'极限','tags':['等价无穷小','待定参数'],'number':'1','paper':'1 练习卷','question':'问题-L1，求 $\\lim_{x\\to0}\\sin x/x$。','answer':'隐藏资料参考答案-1'},
 {'topic':'数列极限','tags':['夹逼准则'],'number':'2','question':'问题-L2，求数列极限。','answer':'隐藏资料参考答案-2'},
 {'topic':'隐函数求导','tags':['隐函数求导'],'number':'3','question':'问题-D1，求隐函数导数。','answer':'隐藏资料参考答案-3'},
 {'topic':'极限','tags':['泰勒展开'],'number':'4','question':'问题-L3，求另一个极限。','answer':'隐藏资料参考答案-4'},
]


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory();self.addCleanup(self.directory.cleanup)
        self.root=Path(self.directory.name);self.tools=LocalTools(self.root)
        self.tools.bank.add('已确认资料',EXERCISES)
        self.tools.save_mistake(**{**MISTAKE,'topic':'行列式','question':'问题-M1，计算行列式。','correct_answer':'隐藏错题参考答案','reason':'隐藏错误原因'})

    def test_tree_includes_material_only_topics_and_distinct_mistake_topic(self):
        tree=self.tools.review_catalog().tree()
        self.assertEqual(tree['total'],5)
        categories={node['category']:node for node in tree['categories']}
        self.assertEqual(categories['极限']['count'],3)
        self.assertEqual(categories['导数与微分']['count'],1)
        self.assertEqual(categories['行列式与矩阵']['count'],1)
        self.assertEqual({x['tag'] for x in categories['极限']['children']},{'等价无穷小','待定参数','数列极限','夹逼准则','泰勒展开'})
        self.assertNotIn('隐藏',json.dumps(tree,ensure_ascii=False))

    def test_leaf_filter_is_exact_and_cannot_match_another_kind_of_limit(self):
        result=self.tools.review_catalog().pick('极限','等价无穷小')
        self.assertEqual(result['matched'],1);self.assertIn('L1',result['exercise']['question'])
        self.assertIsNone(self.tools.review_catalog().pick('极限','不存在的细分标签')['exercise'])

    def test_sources_and_reference_answers_are_isolated(self):
        self.assertEqual(self.tools.review_catalog().tree('exercise')['total'],4)
        self.assertEqual(self.tools.review_catalog().tree('mistake')['total'],1)
        picked=self.tools.review_catalog().pick('行列式与矩阵',source='mistake')['exercise']
        self.assertIn('M1',picked['question']);self.assertTrue(picked['id'].startswith('mistake:'))
        self.assertNotIn('隐藏',json.dumps(picked,ensure_ascii=False));self.assertNotIn('user_answer',picked)
        self.assertIsNone(self.tools.review_catalog().pick('行列式与矩阵',source='exercise')['exercise'])

    def test_pick_and_tree_do_not_modify_json(self):
        before={p.name:p.read_bytes() for p in self.root.glob('*.json')}
        self.tools.review_catalog().tree();self.tools.review_catalog().pick('极限')
        self.assertEqual(before,{p.name:p.read_bytes() for p in self.root.glob('*.json')})

    def test_namespaced_ids_do_not_confuse_equal_ids_in_two_sources(self):
        exercise={'id':'same','topic':'极限','question':'练习题','source':'资料'}
        mistake={'id':'same','topic':'极限','question':'错题'}
        catalog=ReviewCatalog([exercise],[mistake])
        self.assertEqual(catalog.pick('极限',exercise_id='mistake:same')['exercise']['question'],'错题')
        self.assertEqual(catalog.pick('极限',exclude_id='exercise:same')['exercise']['question'],'错题')

    def test_explicit_generate_after_empty_bank_remembers_topic_and_keeps_reply(self):
        model=ScriptedClient([{'role':'assistant','content':r'计算不定积分 $\int x^2\,dx$。你会先套用哪个公式？'}])
        captured=[];original=model.complete
        def capture(messages,tools):
            captured.append(tools);return original(messages,tools)
        model.complete=capture
        agent=StudyAgent(model,self.tools);agent.current_topic='积分'
        missing=agent.run('出一道题',scope='current')
        self.assertIn('暂时没有',missing);self.assertEqual(agent.current_topic,'积分')
        answer=agent.run('你自己出一道吧',scope='current')
        self.assertIn('AI 生成',answer);self.assertIn('不定积分',answer)
        self.assertNotIn('请先明确当前题',answer)
        self.assertIn('积分',model.requests[0][1]['content'])
        self.assertIn('本轮明确要求',model.requests[0][1]['content'])
        self.assertFalse(any(s['function']['name']=='pick_exercise' for s in captured[0]))

    def test_reference_to_generated_question_is_not_another_generation_request(self):
        for wording in ("你自己出的这道题怎么做？", "刚才那道原创题怎么做？"):
            model=ScriptedClient([{"role":"assistant","content":"先检查这个等价替换。"}])
            agent=StudyAgent(model,self.tools);agent.current_topic="极限"
            agent.messages.append({"role":"assistant","content":"AI生成练习：求一个极限。"})
            self.assertEqual(agent.run(wording,scope="current"),"先检查这个等价替换。")
            self.assertNotIn("本轮明确要求你自行出题",model.requests[0][1]["content"])

    def test_explicit_generation_wording_preserves_current_topic(self):
        for wording in ("你自己出一道吧", "帮我编一道题", "生成一题", "给我原创一道练习", "不要用题库，你自己出一道吧"):
            model=ScriptedClient([{"role":"assistant","content":"求一个极限，先尝试写出等价替换。"}])
            agent=StudyAgent(model,self.tools);agent.current_topic="极限"
            answer=agent.run(wording,scope="current")
            self.assertIn("AI 生成练习",answer)
            self.assertIn("极限",model.requests[0][1]["content"])

    def test_tree_pick_requires_no_model_and_followup_keeps_current_question(self):
        model=ScriptedClient([{'role':'assistant','content':'先检查这个等价替换可以吗？'}]);agent=StudyAgent(model,self.tools)
        answer=agent.start_review({'category':'极限','tag':'等价无穷小','source':'any'})
        self.assertIn('L1',answer);self.assertEqual(model.requests,[])
        agent.run('下一步怎么做？',scope='current')
        history=json.dumps(model.requests[0],ensure_ascii=False)
        self.assertIn('L1',history);self.assertNotIn('L2',history);self.assertNotIn('隐藏',history)

    def test_ordinary_consolidation_still_cannot_generate_by_accident(self):
        model=ScriptedClient([{'role':'assistant','content':'我随便编的题目'}])
        answer=StudyAgent(model,self.tools).run('出一道题',scope='current')
        self.assertNotIn('随便编',answer)


class ReviewWebTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory();self.addCleanup(self.directory.cleanup)
        self.root=Path(self.directory.name);self.model=ScriptedClient([{'role':'assistant','content':'保持在等价无穷小题型，先写一个等价替换。'}]*4)
        self.app=create_app(self.root,client_factory=lambda:self.model,settings_path=self.root/'settings.json')
        self.addCleanup(self.app.extensions['stop_background']);self.browser=self.app.test_client()
        self.tools=LocalTools(self.root);self.tools.bank.add('已确认资料',EXERCISES)
        self.tools.save_mistake(**{**MISTAKE,'topic':'行列式','question':'问题-M1，计算行列式。'})

    def test_catalog_and_selection_do_not_read_history_as_directions(self):
        response=self.browser.get('/api/review/catalog');self.assertEqual(response.json['total'],5)
        result=self.browser.post('/api/review/select',json={'category':'极限','tag':'等价无穷小','source':'any'})
        self.assertEqual(result.status_code,200,result.json);self.assertIn('L1',result.json['answer'])
        self.assertEqual(self.model.requests,[])
        self.assertEqual([e['value']['name'] for e in result.json['events'] if e['event']=='工具请求'],['pick_exercise'])
        follow=self.browser.post('/api/chat',json={'view':'review','message':'我不会，下一步呢？'})
        self.assertEqual(follow.status_code,200,follow.json)
        self.assertIn('L1',json.dumps(self.model.requests[-1],ensure_ascii=False))

    def test_can_select_mistake_without_a_matching_material_question(self):
        result=self.browser.post('/api/review/select',json={'category':'行列式与矩阵','source':'mistake'})
        self.assertEqual(result.status_code,200,result.json);self.assertIn('M1',result.json['answer'])
        self.assertIn('错题本',result.json['answer']);self.assertNotIn('correct_answer',json.dumps(result.json))

    def test_new_selection_clears_previous_question_context(self):
        self.browser.post('/api/review/select',json={'category':'行列式与矩阵'})
        self.browser.post('/api/review/select',json={'category':'极限','tag':'等价无穷小'})
        self.browser.post('/api/chat',json={'view':'review','message':'接下来？'})
        self.assertNotIn('M1',json.dumps(self.model.requests[-1],ensure_ascii=False))

    def test_exact_material_entry_is_not_overridden_by_old_tree_filter(self):
        self.browser.post('/api/review/select',json={'category':'行列式与矩阵'})
        exact=self.tools.bank.read()[2]
        result=self.browser.post('/api/chat',json={'view':'review','message':'练习此题','exercise_id':exact['id']})
        self.assertEqual(result.status_code,200,result.json);self.assertIn('D1',result.json['answer'])

    def test_selecting_existing_question_does_not_construct_api_client(self):
        from unittest.mock import patch
        app=create_app(self.root,settings_path=self.root/'unused-settings.json',local_ocr_runtime=False)
        self.addCleanup(app.extensions['stop_background'])
        with patch('web.ModelClient',side_effect=AssertionError('selection must remain local')):
            result=app.test_client().post('/api/review/select',json={'category':'极限','tag':'等价无穷小'})
        self.assertEqual(result.status_code,200,result.json)

    def test_invalid_filter_is_rejected_and_cannot_create_other_sources(self):
        for payload in ({'source':'all-users'},{'category':[]},{'tag':'等价无穷小'},{'category':'极限','path':'secrets'}):
            self.assertEqual(self.browser.post('/api/review/select',json=payload).status_code,400)


if __name__=='__main__':unittest.main()
