from copy import deepcopy
import base64
from io import BytesIO
import json
from types import SimpleNamespace
from pathlib import Path
import tempfile
import time
import unittest
from PIL import Image

from material_locations import pdf_layouts, bind_location, reconcile_batch
from materials import MaterialParser, validate_exercises
from test_core import ScriptedClient
from test_tutoring_materials import ITEMS
from web import create_app
from materials import QuestionBank


PAPER1="1 [分析上期中] 2025-2026学年第一学期数学分析考试试题"
PAPER2="2 [分析上期中] 2025-2026学年第一学期数学分析考试试题"
_image=BytesIO()
Image.new("RGB",(40,60),"white").save(_image,"PNG")
IMAGE="data:image/png;base64,"+base64.b64encode(_image.getvalue()).decode()


def doc(index,paper,role="question",number="二、2"):
    return {"source":"合集.pdf","page":index+15,"page_index":index,"image":IMAGE,
            "layout":{"paper":paper,"anchors":[{"id":f"p{index}a0","paper":paper,"number":number,
                      "role":role,"bbox":[.1,.2,.95,.35],"text_hint":"题目或答案标签"}]}}


def item(page,paper=PAPER2,**extra):
    return {**ITEMS[0],"number":"二、2","paper":paper,"answer":"","page_index":page,**extra}


class LocationTests(unittest.TestCase):
    def test_math_above_the_number_is_included_but_next_numerator_is_excluded(self):
        class Page:
            rotation=0
            rect=SimpleNamespace(width=600,height=900)
            def get_text(self,*args,**kwargs):
                values=[(50,PAPER1,14),(88,"指数",11),(100,"2. 求极限",11),(145,"分子",11),(160,"3. 下一题",11)]
                return {"blocks":[{"lines":[{"bbox":[55,y,560,y+15],"spans":[{"text":s,"size":size}]} for y,s,size in values]}]}
        anchors=pdf_layouts([Page()],[0])[0]["anchors"]
        self.assertLess(anchors[0]["bbox"][1],88/900)
        self.assertLess(anchors[0]["bbox"][3],145/900)
        self.assertLess(anchors[1]["bbox"][1],145/900)

    def test_native_layout_keeps_paper_prefix_section_and_answer_continuation(self):
        class Page:
            rotation=0
            rect=SimpleNamespace(width=600,height=900)
            def __init__(self,lines):self.lines=lines
            def get_text(self,*args,**kwargs):
                return {"blocks":[{"lines":[{"bbox":[55,y,560,y+15],"spans":[{"text":s,"size":size}]} for y,s,size in self.lines]}]}
        pdf=[Page([(50,PAPER1,14),(90,"二、填空题",11),(120,"2. 求极限",11),(300,"答案",13),(340,"二、2. 1",11)]),
             Page([(50,PAPER2,14),(90,"二、填空题",11),(120,"2. 求极限",11),(300,"答案",13)]),
             Page([(60,"二、2. 2",11)])]
        layouts=pdf_layouts(pdf,[0,1,2])
        self.assertEqual(layouts[0]["anchors"][0]["paper"],PAPER1)
        self.assertEqual(layouts[1]["anchors"][0]["paper"],PAPER2)
        self.assertEqual(layouts[2]["anchors"][0]["role"],"answer")
        self.assertEqual(layouts[2]["anchors"][0]["number"],"二、2")
        self.assertEqual(layouts[2]["anchors"][0]["paper"],PAPER2)

    def test_exact_anchor_restores_complete_paper_and_section_without_guessing_math(self):
        value=bind_location(item(4,paper="相同的省略标题",number="2",source_anchor="p4a0"),[doc(4,PAPER2)])
        self.assertEqual(value["paper"],PAPER2);self.assertEqual(value["number"],"二、2")
        self.assertEqual(value["origin_regions"][0]["bbox"],[.1,.2,.95,.35])
        self.assertEqual(value["question"],ITEMS[0]["question"])

    def test_ambiguous_small_number_is_not_assigned_an_arbitrary_region(self):
        source=doc(1,PAPER1,number="一、2")
        source["layout"]["anchors"].append({**source["layout"]["anchors"][0],"id":"p1a1","number":"二、2"})
        value=bind_location(item(1,number="2"),[source])
        self.assertNotIn("origin_regions",value)

    def test_conflicting_exact_number_does_not_trust_an_unrelated_anchor_id(self):
        value=bind_location(item(1,number="一、1",source_anchor="p1a0"),[doc(1,PAPER1)])
        self.assertEqual(value["number"],"一、1")
        self.assertNotIn("origin_regions",value)

    def test_later_answer_page_reconciles_across_segments_without_an_extra_call(self):
        docs=[doc(1,PAPER1),doc(2,PAPER2),doc(3,PAPER2,"answer")]
        responses=[
            {"exercises":[item(1,PAPER1),item(2)],"warnings":["试卷2仅见三个答案，其余参考答案未见"]},
            {"exercises":[],"warnings":["本段主页面仅包含参考答案，未导出新题"],
             "answer_fragments":[{"paper":PAPER2,"number":"二、2","page_index":3,"source_anchor":"p3a0","answer":"$2$"}]},
        ]
        model=ScriptedClient([{"content":json.dumps(r,ensure_ascii=False)} for r in responses])
        result=MaterialParser(model).parse_images(docs)
        self.assertEqual(len(model.requests),2)
        self.assertEqual(result["exercises"][0]["answer"],"")
        self.assertEqual(result["exercises"][1]["answer"],"$2$")
        self.assertEqual(result["exercises"][1]["answer_page_indices"],[3])
        self.assertEqual(result["warnings"],[])
        self.assertTrue(result["diagnostics"])

    def test_real_conflicting_answers_are_retained_as_actionable_issues(self):
        docs=[doc(1,PAPER2),doc(2,PAPER2,"answer")]
        result=reconcile_batch([item(1,answer="$1$")],[{"paper":PAPER2,"number":"二、2","page_index":2,"answer":"$2$"}],[],docs)
        self.assertEqual(result["exercises"][0]["answer"],"$1$")
        self.assertEqual(result["issues"][0]["kind"],"answer_conflict")
        self.assertEqual(result["issues"][0]["exercise_indices"],[0])

    def test_only_three_answers_seen_does_not_hide_still_missing_answers(self):
        docs=[doc(1,PAPER2)]
        values=[item(1,number="一、"+str(i+1),answer="$1$" if i<3 else "") for i in range(5)]
        result=reconcile_batch(values,[],[{"message":"试卷2仅见答案一、1-3，其余参考答案未见"}],docs)
        self.assertEqual(result["issues"][0]["exercise_indices"],[3,4])
        self.assertIn("尚未完整关联",result["issues"][0]["message"])

    def test_numeric_substring_is_not_treated_as_a_more_complete_answer(self):
        docs=[doc(1,PAPER2),doc(2,PAPER2,"answer")]
        result=reconcile_batch([item(1,answer="$1$")],[{"paper":PAPER2,"number":"二、2","page_index":2,"answer":"$21$"}],[],docs)
        self.assertEqual(result["exercises"][0]["answer"],"$1$")
        self.assertEqual(result["issues"][0]["kind"],"answer_conflict")

    def test_issue_explicit_source_page_and_paper_number_map_to_exact_question(self):
        docs=[doc(1,PAPER1),doc(4,PAPER2)]
        result=reconcile_batch([item(1,PAPER1),item(4)],[],[{"message":"第19页题组2二、2的根号范围无法辨认"}],docs)
        issue=result["issues"][0]
        self.assertEqual(issue["page_index"],4);self.assertEqual(issue["exercise_indices"],[1])
        self.assertEqual(issue["paper"],PAPER2)

    def test_two_files_do_not_share_answers_based_only_on_paper_and_number(self):
        a=doc(1,PAPER1);b=doc(2,PAPER1,"answer");b["source"]="另外的合集.pdf"
        result=reconcile_batch([item(1,PAPER1)],[{"paper":PAPER1,"number":"二、2","page_index":2,"answer":"$2$"}],[],[a,b])
        self.assertEqual(result["exercises"][0]["answer"],"")

    def test_forged_or_nonfinite_regions_are_rejected(self):
        for bbox in ([0,0,1,2],[0,0,float("nan"),1],[0,0,0,1],[False,0,1,1]):
            with self.assertRaises(ValueError):validate_exercises([item(1,origin_regions=[{"page_index":1,"role":"question","bbox":bbox}])])

    def test_diagnostic_label_does_not_hide_a_real_recognition_failure(self):
        result=reconcile_batch([item(1,PAPER2)],[],[{"kind":"diagnostic","message":"二、2的指数无法辨认","paper":PAPER2,"number":"二、2"}],[doc(1,PAPER2)])
        self.assertEqual(len(result["issues"]),1)

    def test_save_keeps_item_regions_without_copying_all_page_anchors_into_every_record(self):
        class Parser:
            def parse_images(self,*args,**kwargs):return {"exercises":[item(1,PAPER1)],"warnings":[]}
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            app=create_app(root/"data",material_parser_factory=Parser)
            self.addCleanup(app.extensions["pdf_previews"].close)
            client=app.test_client();client.get("/api/status")
            with client.session_transaction() as session:owner=session["sid"]
            jobs=app.extensions["material_jobs"]
            jobs.make_visual_parser=Parser
            task=jobs.submit(owner,"原文","合集",documents=[doc(1,PAPER1)])
            for _ in range(100):
                result=jobs.get(owner,task["id"])
                if result["status"]=="ready":break
                time.sleep(.01)
            self.assertEqual(result["status"],"ready")
            value=item(1,PAPER1,origin_regions=[{"page_index":1,"role":"question","bbox":[.1,.2,.9,.3]}])
            response=client.post("/api/exercises",json={"source":"合集","confirmed":True,"job_id":task["id"],"exercises":[value]})
            self.assertEqual(response.status_code,200,response.json)
            saved=QuestionBank(root/"data").read()[0]
            self.assertEqual(saved["origin_regions"],value["origin_regions"])
            self.assertNotIn("layout",saved["provenance"]["documents"][0])
