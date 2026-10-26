from copy import deepcopy
import json
from pathlib import Path
import tempfile
import threading
import unittest

from agent import StudyAgent
from cancellation import CancellationToken, OperationCancelled
from demo import MISTAKE
from test_core import ScriptedClient, call
from test_review_catalog import EXERCISES
from tools import LocalTools
from web import create_app


class SteeringTests(unittest.TestCase):
    def setUp(self):
        self.folder=tempfile.TemporaryDirectory();self.addCleanup(self.folder.cleanup)
        self.root=Path(self.folder.name);self.tools=LocalTools(self.root)

    def test_steering_retains_original_user_and_discards_outdated_model_reply(self):
        started=threading.Event();release=threading.Event();requests=[]
        class Model:
            def complete(self,messages,tools=None):
                requests.append(deepcopy(messages))
                if len(requests)==1:started.set();release.wait(2);return {'role':'assistant','content':'过时回答不得提交'}
                return {'role':'assistant','content':'按补充继续。'}
        token=CancellationToken();agent=StudyAgent(Model(),self.tools);failures=[]
        def work():
            try:agent.run('原始要求标记-A',cancel_token=token)
            except OperationCancelled as exc:failures.append(exc)
        worker=threading.Thread(target=work);worker.start();self.assertTrue(started.wait(1))
        token.preserve_context=True;token.cancel();worker.join(1);release.set()
        self.assertFalse(worker.is_alive());self.assertEqual(len(failures),1);self.assertTrue(token.context_retained)
        self.assertIn('原始要求标记-A',json.dumps(agent.messages,ensure_ascii=False));self.assertNotIn('过时回答',json.dumps(agent.messages,ensure_ascii=False))
        agent.run('补充要求标记-B')
        history=json.dumps(requests[-1],ensure_ascii=False);self.assertIn('原始要求标记-A',history);self.assertIn('补充要求标记-B',history)

    def test_cancellation_between_tool_calls_keeps_success_and_closes_unexecuted_call(self):
        token=CancellationToken();token.preserve_context=True;original=self.tools.execute
        def execute(name,arguments,cancel_token=None):
            result=original(name,arguments,cancel_token=cancel_token)
            if name=='save_mistake':token.cancel()
            return result
        self.tools.execute=execute
        first=call('save_mistake',MISTAKE,'saved-call');first['tool_calls']+=call('search_notes',{'query':'导数'},'not-run')['tool_calls']
        model=ScriptedClient([first,{'role':'assistant','content':'保留已保存内容，继续讲解。'}]);agent=StudyAgent(model,self.tools)
        with self.assertRaises(OperationCancelled):agent.run('保存这一题并查看笔记',cancel_token=token)
        self.assertTrue(token.context_retained);self.assertEqual(self.tools.get_mistakes()['total'],1)
        results={item['tool_call_id']:json.loads(item['content']) for item in agent.messages if item['role']=='tool'}
        self.assertTrue(results['saved-call']['ok']);self.assertTrue(results['not-run']['cancelled']);self.assertFalse(results['not-run']['ok'])
        agent.run('不要再保存，继续指导')
        self.assertEqual(self.tools.get_mistakes()['total'],1)
        history=model.requests[-1]
        for index,item in enumerate(history):
            if item.get('tool_calls'):
                expected={call['id'] for call in item['tool_calls']}
                actual={part.get('tool_call_id') for part in history[index+1:] if part['role']=='tool'}
                self.assertTrue(expected<=actual)

    def test_started_tool_without_a_complete_result_is_marked_unconfirmed(self):
        token=CancellationToken();token.preserve_context=True;original=self.tools.execute
        def interrupted(name,arguments,cancel_token=None):
            original(name,arguments,cancel_token=cancel_token)
            token.cancel();raise OperationCancelled('工具结果尚未返回')
        self.tools.execute=interrupted
        agent=StudyAgent(ScriptedClient([call('save_mistake',MISTAKE,'in-flight-save')]),self.tools)
        with self.assertRaises(OperationCancelled):agent.run('保存错题',cancel_token=token)
        result=next(json.loads(item['content']) for item in agent.messages if item['role']=='tool')
        self.assertEqual(result['execution_status'],'unconfirmed');self.assertEqual(self.tools.get_mistakes()['total'],1)
        self.assertNotIn('尚未执行',result['error'])

    def test_ordinary_stop_still_does_not_commit_incomplete_turn(self):
        token=CancellationToken()
        class Model:
            def complete(self,messages,tools=None):token.cancel();return {'role':'assistant','content':'不应提交'}
        agent=StudyAgent(Model(),self.tools)
        with self.assertRaises(OperationCancelled):agent.run('尚未完成的输入',cancel_token=token)
        self.assertEqual(len(agent.messages),1);self.assertFalse(token.context_retained)

    def test_steer_endpoint_targets_current_request_and_preserves_question(self):
        started=threading.Event();release=threading.Event();requests=[]
        class Model:
            def complete(self,messages,tools=None):
                requests.append(deepcopy(messages))
                if len(requests)==1:started.set();release.wait(2)
                return {'role':'assistant','content':'继续这道题。'}
        self.tools.bank.add('练习',EXERCISES)
        app=create_app(self.root,client_factory=lambda:Model(),settings_path=self.root/'settings.json',local_ocr_runtime=False)
        self.addCleanup(app.extensions['stop_background']);browser=app.test_client()
        browser.post('/api/review/select',json={'category':'极限','tag':'等价无穷小'})
        responses=[]
        worker=threading.Thread(target=lambda:responses.append(browser.post('/api/chat',json={'view':'review','message':'原请求-A','request_id':'running-turn'})))
        worker.start();self.assertTrue(started.wait(1))
        switched=browser.post('/api/settings/model',json={'model':'other'});self.assertEqual(switched.status_code,409)
        bad=browser.post('/api/cancel',json={'request_id':'running-turn','steer':'yes'});self.assertEqual(bad.status_code,400)
        self.assertEqual(browser.post('/api/cancel',json={'request_id':'running-turn','steer':True}).status_code,200)
        worker.join(1);release.set();self.assertFalse(worker.is_alive())
        self.assertEqual(responses[0].status_code,499);self.assertTrue(responses[0].json['context_retained'])
        next_reply=browser.post('/api/chat',json={'view':'review','message':'补充-B'})
        self.assertEqual(next_reply.status_code,200,next_reply.json);self.assertIn('L1',next_reply.json['current_question']['question'])
        history=json.dumps(requests[-1],ensure_ascii=False);self.assertIn('原请求-A',history);self.assertIn('补充-B',history);self.assertIn('L1',history)


if __name__=='__main__':unittest.main()
