"""复习能力的最小回归：作答落盘、进度非 0、重启可读、本轮不重复出题。

用工作区内的目录而不是 tempfile：受限环境下系统临时目录里的子目录写入会挂起。
"""

import shutil
import unittest
import uuid
from pathlib import Path

from agent import StudyAgent
from tools import LocalTools

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / ".wx-test"
WORK.mkdir(parents=True, exist_ok=True)

ITEMS = [
    {"topic": "极限", "tags": ["无穷小比较"], "number": str(index),
     "question": f"比较题 {index}，求极限。", "answer": "参考答案"}
    for index in range(1, 4)
]
SELECTION = {"category": "极限", "tag": "无穷小比较", "source": "exercise"}


class NullClient:
    """不调用模型的替身：本模块只验证本地记录，不需要真实模型。"""

    def complete(self, messages, tools):
        return {"role": "assistant", "content": "先写出第一步。"}


class ReviewCoreTests(unittest.TestCase):
    def setUp(self):
        self.directory = WORK / ("review-" + uuid.uuid4().hex[:12])
        self.directory.mkdir(parents=True, exist_ok=True)
        self.addCleanup(shutil.rmtree, self.directory, True)
        self.tools = LocalTools(self.directory)
        self.tools.bank.add("已确认资料", ITEMS)

    def agent(self):
        return StudyAgent(NullClient(), self.tools)

    def test_answer_is_persisted_and_progress_is_not_zero(self):
        agent = self.agent()
        agent.start_review(SELECTION)
        self.assertIsNotNone(agent.current_question)
        agent.run("我用等价无穷小，第一步先约掉 x", task="review")

        summary = self.tools.progress.summary()
        self.assertTrue(summary, "作答后进度不应为空")
        total = sum(entry["count"] for entry in summary.values())
        self.assertGreaterEqual(total, 1)
        self.assertIsNotNone(agent.review_snapshot()["current_attempt"])

    def test_progress_survives_restart(self):
        agent = self.agent()
        agent.start_review(SELECTION)
        agent.run("先约掉 x，得到 1", task="review")
        before = self.tools.progress.summary()

        reopened = LocalTools(self.directory)
        self.assertEqual(reopened.progress.summary(), before)
        self.assertGreaterEqual(reopened.progress.history()["total"], 1)

    def test_same_round_does_not_repeat_questions(self):
        agent = self.agent()
        seen = []
        for index in range(3):
            if index == 0:
                agent.start_review(SELECTION)
            else:
                agent.run("换一道", task="review")
            seen.append(agent.current_question["id"])
        self.assertEqual(len(set(seen)), 3)
        self.assertIn("全部出过", agent.run("还有别的题吗", task="review"))

    def test_replayed_request_id_does_not_write_twice(self):
        from cancellation import CancellationToken

        agent = self.agent()
        agent.start_review(SELECTION)
        token = CancellationToken()
        token.request_id = "same-request-id"
        agent.run("第一步", task="review", cancel_token=token)
        agent.messages = agent.messages[:-2]  # 模拟重放：去掉上一轮对话
        agent.run("第一步", task="review", cancel_token=token)
        history = self.tools.progress.history()
        self.assertEqual(len(history["attempts"][0]["turns"]), 1, "同一 request_id 只能记一条作答")


if __name__ == "__main__":
    unittest.main()
