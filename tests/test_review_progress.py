from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import tempfile
import unittest

from agent import StudyAgent
from cancellation import CancellationToken, OperationCancelled
from review_progress import ReviewProgress, question_key
from test_core import ScriptedClient, call
from tools import LocalTools
from web import create_app


ITEMS=[dict(topic="极限",tags=["无穷小比较"],number=str(i),question=f"比较题 {i}，求极限。",answer="参考答案") for i in range(1,4)]
SELECTION=dict(category="极限",tag="无穷小比较",source="exercise")


class ReviewProgressTests(unittest.TestCase):
    def setUp(self):
        self.folder=tempfile.TemporaryDirectory();self.addCleanup(self.folder.cleanup)
        self.root=Path(self.folder.name);self.tools=LocalTools(self.root);self.tools.bank.add("已确认资料",ITEMS)

    def agent(self, replies=()):return StudyAgent(ScriptedClient(list(replies)),self.tools)

    def test_whole_round_not_just_previous_id_is_excluded(self):
        agent=self.agent();questions=[]
        for index in range(3):
            answer=agent.start_review(SELECTION) if not index else agent.run("再来一道",task="review")
            questions.append(agent.current_question["id"]);self.assertIn(f"比较题 {index+1}",answer)
        self.assertEqual(len(set(questions)),3)
        for wording in ("再来一道","这不是你刚刚出的吗？没别的题了？"):
            self.assertIn("本轮已经全部出过",agent.run(wording,task="review"))
        self.assertEqual(len(agent.seen_question_ids),3);self.assertEqual(agent.client.requests,[])

    def test_marks_are_shared_across_ranges_without_marking_skipped_questions(self):
        agent=self.agent();agent.start_review(SELECTION)
        agent.start_review(dict(category="极限",source="exercise"))
        self.assertIn("比较题 2",agent.current_question["question"])
        self.assertEqual(len(agent.seen_question_ids),2)

    def test_same_question_copied_between_bank_and_mistakes_is_not_repeated(self):
        from demo import MISTAKE
        self.tools.save_mistake(**{**MISTAKE,"topic":"极限","question":ITEMS[0]["question"]})
        agent=self.agent();agent.start_review(dict(category="极限",source="exercise"))
        answer=agent.start_review(dict(category="极限",source="mistake"))
        self.assertIn("本轮已经全部出过",answer);self.assertEqual(len(agent.seen_question_ids),1)

    def test_next_question_wording_does_not_grade_a_navigation_message(self):
        agent=self.agent();agent.start_review(SELECTION)
        self.assertIn("比较题 2",agent.run("下一题",task="review"))
        self.assertEqual(self.tools.progress.summary(),{})

    def test_cancelled_pick_does_not_mark_a_question_as_delivered(self):
        agent=self.agent();token=CancellationToken();original=self.tools.execute
        def execute(*args,**kwargs):
            result=original(*args,**kwargs);token.cancel();return result
        self.tools.execute=execute
        with self.assertRaises(OperationCancelled):agent.start_review(SELECTION,token)
        self.assertEqual(agent.seen_question_ids,set());self.assertEqual(self.tools.progress.history()["total"],0)

    def test_single_question_never_falls_back_to_same_question(self):
        agent=self.agent();scope=dict(category="极限",tag="不存在",source="exercise")
        self.assertIn("暂时没有",agent.start_review(scope));self.assertEqual(agent.seen_question_ids,set())
        self.tools.bank.add("单题",[dict(topic="导数",tags=["导数定义"],question="求导数定义题",answer="略")])
        agent.start_review(dict(category="导数与微分",tag="导数定义",source="exercise"))
        self.assertIn("本轮已经全部出过",agent.run("再来一道",task="review"))

    def test_explicit_one_to_infinity_changes_filter_before_selection(self):
        self.tools.bank.add("新题型",[dict(topic="极限",tags=["1的无穷次方"],question="幂指型新题",answer="略")])
        for wording in ("出一个1的无穷次方的","给我出一道 1^∞ 型极限",r"出一道 1^{\infty} 型的题"):
            agent=self.agent();agent.start_review(SELECTION)
            self.assertIn("幂指型新题",agent.run(wording,task="review"))
            self.assertEqual(agent.review_filter["tag"],"1^∞型极限")
            self.assertEqual(agent.client.requests,[])

    def test_legacy_stored_form_alias_matches_without_rewriting_user_data(self):
        records=self.tools.bank.read();records[0]["tags"]=["1的无穷次方"]
        self.tools.bank._write(records);before=self.tools.bank.path.read_bytes()
        self.assertIsNotNone(self.tools.bank.pick("极限",tags=["1^∞型极限"])["exercise"])
        self.assertEqual(self.tools.bank.path.read_bytes(),before)

    def test_missing_new_form_does_not_substitute_previous_form(self):
        agent=self.agent();agent.start_review(SELECTION);previous=agent.current_question["id"]
        reply=agent.run("出一个1的无穷次方的",task="review")
        self.assertIn("暂时没有",reply);self.assertNotIn("已从",reply)
        self.assertEqual(agent.current_question["id"],previous);self.assertEqual(len(agent.seen_question_ids),1)
        self.assertEqual(agent.review_filter["tag"],"1^∞型极限")

    def test_explicit_generation_after_missing_new_scope_uses_requested_form(self):
        agent=self.agent([dict(role="assistant",content="这是1的无穷次方型生成题。")]);agent.start_review(SELECTION)
        agent.run("出一个1的无穷次方的",task="review")
        answer=agent.run("你自己出一道吧",task="review")
        self.assertIn("AI 生成",answer);self.assertEqual(agent.current_question["tags"],["1^∞型极限"])
        policy=agent.client.requests[0][1]["content"]
        self.assertIn("1^∞型极限",policy);self.assertNotIn("细题型限定：无穷小比较",policy)

    def test_named_existing_tag_can_replace_previous_scope(self):
        self.tools.bank.add("新范围",[dict(topic="极限",tags=["泰勒展开"],question="泰勒原题",answer="略")])
        agent=self.agent();agent.start_review(SELECTION)
        self.assertIn("泰勒原题",agent.run("换一道泰勒展开的题",task="review"))
        self.assertEqual(agent.review_filter["tag"],"泰勒展开")

    def test_merely_asking_why_a_method_works_does_not_switch_scope(self):
        agent=self.agent([dict(role="assistant",content="这里要检查适用条件。")]);agent.start_review(SELECTION)
        agent.run("为什么不能用泰勒展开？",task="review")
        self.assertEqual(agent.review_filter,SELECTION)

    def test_selected_but_unanswered_is_not_counted_as_done(self):
        agent=self.agent();agent.start_review(SELECTION)
        self.assertEqual(self.tools.progress.summary(),{});self.assertEqual(self.tools.progress.history()["total"],0)
        self.assertEqual(agent.review_snapshot()["current_attempt"]["outcome"],"not_answered")

    def test_ungraded_answer_survives_new_store_and_end(self):
        agent=self.agent([dict(role="assistant",content="还需要核对这个条件。")]);agent.start_review(SELECTION)
        agent.run("我的答案是2，但不确定",task="review");identity=agent.current_attempt_id;agent.end_review()
        restored=ReviewProgress(self.root);attempt=restored.get(identity)
        self.assertEqual(attempt["outcome"],"unassessed");self.assertTrue(attempt["closed_at"])
        self.assertTrue(attempt["turns"][0]["at"]);self.assertEqual(attempt["turns"][0]["text"],"我的答案是2，但不确定")
        self.assertEqual(restored.summary()[question_key(agent.current_question)]["count"],1)
        self.assertNotIn("next_review",json.dumps(attempt));self.assertNotIn("due_at",json.dumps(attempt))

    def test_practice_started_from_organize_also_records_actual_answers(self):
        agent=self.agent([dict(role="assistant",content="继续检查这个步骤。")]);agent.current_topic="极限"
        agent.run("从资料中选一道同类题",task="mixed",intent="practice")
        agent.run("我的答案是2",task="mixed")
        self.assertEqual(self.tools.progress.history()["total"],1)

    def test_independent_correct_is_explicitly_assessed(self):
        fields=dict(outcome="correct",assisted=False,error_tags=[],evidence="答案与完整推导一致。")
        agent=self.agent([call("record_review_result",fields),dict(role="assistant",content="这次整题做对了。")]);agent.start_review(SELECTION)
        agent.run("完整推导如下，得到2。",task="review")
        attempt=agent.review_snapshot()["current_attempt"]
        self.assertTrue(attempt["independent_correct"]);self.assertFalse(attempt["assisted"])

    def test_wrong_then_assisted_correct_keeps_all_times_and_error_tags(self):
        wrong=dict(outcome="incorrect",assisted=False,error_tags=["formula"],evidence="把乘积求导漏了一项。")
        correct=dict(outcome="correct",assisted=True,error_tags=[],evidence="在提示后补齐了乘积求导。")
        agent=self.agent([call("record_review_result",wrong),dict(role="assistant",content="请检查乘积求导。"),call("record_review_result",correct),dict(role="assistant",content="现在完整正确。")]);agent.start_review(SELECTION)
        agent.run("我的答案是x",task="review");agent.run("按提示补上，答案2x",task="review")
        attempt=self.tools.progress.get(agent.current_attempt_id)
        self.assertEqual(len(attempt["turns"]),2);self.assertEqual(len(attempt["assessments"]),2)
        self.assertEqual(attempt["error_tags"],["formula"]);self.assertTrue(attempt["was_wrong"]);self.assertTrue(attempt["assisted"])
        self.assertFalse(agent.review_snapshot()["current_attempt"]["independent_correct"])

    def test_partial_step_is_not_whole_question_correct(self):
        agent=self.agent([call("record_review_result",dict(outcome="partial",assisted=True,error_tags=[],evidence="只核对了第一步。")),dict(role="assistant",content="继续第二步。")]);agent.start_review(SELECTION)
        agent.run("第一步是换元",task="review")
        self.assertEqual(agent.review_snapshot()["current_attempt"]["outcome"],"partial")
        self.assertFalse(agent.review_snapshot()["current_attempt"]["independent_correct"])

    def test_every_new_round_retains_separate_attempt(self):
        first=self.agent([dict(role="assistant",content="继续检查。")]);first.start_review(SELECTION);first.run("答案A",task="review");first.end_review()
        second=self.agent([dict(role="assistant",content="继续检查。")]);second.start_review(SELECTION);second.run("答案B",task="review")
        history=self.tools.progress.history(question_key(second.current_question))
        self.assertEqual(history["total"],2)
        self.assertEqual(len({a["round_id"] for a in history["attempts"]}),2)

    def test_generated_questions_get_distinct_stable_ids(self):
        agent=self.agent([dict(role="assistant",content="生成的题目甲"),dict(role="assistant",content="这一步还要核对。"),dict(role="assistant",content="生成的题目乙")]);agent.current_topic="极限"
        agent.run("你自己出一道吧",task="review");first=agent.current_question["id"]
        agent.run("我得到0",task="review");agent.run("你自己再出一道吧",task="review")
        self.assertNotEqual(first,agent.current_question["id"]);self.assertTrue(first.startswith("generated:"))
        self.assertEqual(self.tools.progress.history(first)["total"],1)

    def test_invalid_judgment_and_missing_evidence_do_not_change_history(self):
        agent=self.agent();agent.start_review(SELECTION);store=self.tools.progress;identity=agent.current_attempt_id
        with self.assertRaises(ValueError):store.assess(identity,outcome="correct",assisted=False,error_tags=[],evidence="未作答却猜对")
        store.submit(identity,"答案1","one");before=store.path.read_bytes()
        for fields in (dict(outcome="correct",assisted=False,error_tags=["formula"],evidence="矛盾"),dict(outcome="incorrect",assisted=False,error_tags=["invented"],evidence="错误"),dict(outcome="correct",assisted=False,error_tags=[],evidence="")):
            with self.assertRaises(ValueError):store.assess(identity,**fields)
            self.assertEqual(store.path.read_bytes(),before)
        result=store.assess(identity,outcome="incorrect",assisted=False,error_tags=[],evidence="确实做错，具体错因尚不清楚。")
        self.assertEqual(result["error_tags"],["unconfirmed"])

    def test_corrupt_file_is_not_silently_replaced(self):
        path=self.tools.progress.path;path.write_text('{"version":1,"attempts":[{}]}',encoding="utf-8");before=path.read_bytes()
        with self.assertRaises(ValueError):self.agent().start_review(SELECTION)
        self.assertEqual(path.read_bytes(),before)

    def test_concurrent_attempts_and_duplicate_request_ids(self):
        question=dict(id="exercise:one",kind="exercise",topic="极限",question="合成题")
        stores=[ReviewProgress(self.root),ReviewProgress(self.root)]
        with ThreadPoolExecutor(max_workers=4) as pool:
            attempts=list(pool.map(lambda i:stores[i%2].begin(question,str(i)),range(12)))
        self.assertEqual(len(stores[0]._read()),12)
        for _ in range(2):stores[0].submit(attempts[0]["id"],"同一请求","same")
        self.assertEqual(len(stores[0].get(attempts[0]["id"])["turns"]),1)


class ReviewProgressWebTests(unittest.TestCase):
    def setUp(self):
        self.folder=tempfile.TemporaryDirectory();self.addCleanup(self.folder.cleanup);self.root=Path(self.folder.name)
        self.model=ScriptedClient([dict(role="assistant",content="尚待核对。")]*20)
        self.app=create_app(self.root,client_factory=lambda:self.model,settings_path=self.root/"settings.json",local_ocr_runtime=False)
        self.addCleanup(self.app.extensions["stop_background"]);self.browser=self.app.test_client()
        self.tools=LocalTools(self.root);self.tools.bank.add("已确认资料",ITEMS)

    def select(self):return self.browser.post("/api/review/select",json=SELECTION)

    def test_select_endpoint_carries_marks_across_new_agent_instances(self):
        ids=[self.select().json["current_question"]["id"] for _ in range(3)]
        last=self.select();self.assertIn("本轮已经全部出过",last.json["answer"])
        self.assertEqual(len(set(ids)),3);self.assertEqual(len(last.json["review"]["seen_ids"]),3)
        self.browser.post("/api/review/end")
        self.assertEqual(self.select().json["current_question"]["id"],ids[0])

    def test_finish_and_new_browser_preserve_attempts_but_reset_round(self):
        selected=self.select();identity=selected.json["current_question"]["id"]
        self.browser.post("/api/chat",json=dict(view="review",message="我得到答案1"))
        ended=self.browser.post("/api/review/end");self.assertEqual(ended.status_code,200)
        fresh=self.app.test_client();progress=fresh.get("/api/review/progress").json
        self.assertEqual(progress["review"]["seen_ids"],[]);self.assertEqual(progress["progress"][identity]["count"],1)
        history=fresh.get("/api/review/history",query_string=dict(question_id=identity)).json
        self.assertEqual(history["total"],1);self.assertEqual(history["attempts"][0]["outcome"],"unassessed")

    def test_full_app_recreation_reads_same_persistent_history(self):
        self.select();self.browser.post("/api/chat",json=dict(view="review",message="重启前的作答"))
        restarted=create_app(self.root,client_factory=lambda:self.model,settings_path=self.root/"settings.json",local_ocr_runtime=False)
        self.addCleanup(restarted.extensions["stop_background"])
        history=restarted.test_client().get("/api/review/history").json
        self.assertEqual(history["total"],1);self.assertEqual(history["attempts"][0]["turns"][0]["text"],"重启前的作答")

    def test_direct_material_card_uses_same_namespaced_history(self):
        identity=self.tools.bank.read()[0]["id"]
        response=self.browser.post("/api/chat",json=dict(view="review",message="练习此题",exercise_id=identity))
        self.assertEqual(response.status_code,200,response.json)
        self.assertEqual(response.json["current_question"]["kind"],"exercise")
        self.browser.post("/api/chat",json=dict(view="review",message="原题作答"))
        self.assertEqual(self.browser.get("/api/review/history",query_string=dict(question_id="exercise:"+identity)).json["total"],1)

    def test_manual_assessment_is_bound_to_current_attempt(self):
        self.select();response=self.browser.post("/api/chat",json=dict(view="review",message="答案A"));identity=response.json["review"]["current_attempt"]["id"]
        payload=dict(attempt_id=identity,outcome="incorrect",assisted=True,error_tags=["conditions"],evidence="漏掉了定义域。")
        saved=self.browser.post("/api/review/result",json=payload);self.assertEqual(saved.status_code,200,saved.json)
        self.assertEqual(saved.json["review"]["current_attempt"]["error_tags"],["conditions"])
        self.select();stale=self.browser.post("/api/review/result",json=payload)
        self.assertEqual(stale.status_code,409)

    def test_ending_while_request_is_active_does_not_erase_state(self):
        self.select()
        import threading
        entered=threading.Event();release=threading.Event()
        def complete(*args,**kwargs):entered.set();release.wait(3);return dict(role="assistant",content="未判定")
        self.model.complete=complete
        thread=threading.Thread(target=lambda:self.browser.post("/api/chat",json=dict(view="review",message="答案A")))
        thread.start();self.assertTrue(entered.wait(2))
        try:self.assertEqual(self.browser.post("/api/review/end").status_code,409)
        finally:release.set();thread.join(4)

    def test_history_validation_and_pagination(self):
        self.assertEqual(self.browser.get("/api/review/history?limit=0").status_code,400)
        self.assertEqual(self.browser.get("/api/review/history?offset=-1").status_code,400)
        for _ in range(3):
            self.select();self.browser.post("/api/chat",json=dict(view="review",message="答案A"));self.browser.post("/api/review/end")
        first=self.browser.get("/api/review/history?limit=2").json;last=self.browser.get("/api/review/history?limit=2&offset=2").json
        self.assertEqual(first["total"],3);self.assertEqual(len(first["attempts"]),2);self.assertEqual(len(last["attempts"]),1)


if __name__=="__main__":unittest.main()
