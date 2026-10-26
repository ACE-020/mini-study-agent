"""离线脚本替身，仅演示执行链路；不代表大模型自主选择了工具。"""

import json


QUESTION = "求 f(x)=x^2 的导数。"
MISTAKE = {"question": QUESTION, "user_answer": "x", "correct_answer": "2x",
           "reason": "幂函数求导时遗漏了幂指数这一系数。", "topic": "导数"}
HOMEWORK = f"整理错题，我答错的东西下次重点考。题目：{QUESTION} 我的答案：x，参考答案：2x。"


class DemoClient:
    def __init__(self, mode):
        self.mode = mode
        self.step = 0

    def complete(self, messages, tools):
        previous = json.loads(messages[-1]["content"]) if messages[-1]["role"] == "tool" else None
        if previous and not previous["ok"]:
            return {"role": "assistant", "content": "工具执行失败：" + previous["error"]}
        if self.mode == "save":
            actions = [("search_notes", {"query": "导数"}), ("save_mistake", MISTAKE)]
        else:
            actions = [("get_mistakes", {"limit": 3})]
        if self.step < len(actions):
            name, arguments = actions[self.step]
            self.step += 1
            return {"role": "assistant", "content": None, "tool_calls": [{
                "id": f"demo_{self.step}", "type": "function", "function": {
                    "name": name, "arguments": json.dumps(arguments, ensure_ascii=False)}}]}
        if self.mode == "save":
            answer = "错题已记录：幂函数求导遗漏系数。下次复习可读取这条导数错题。"
            if previous["data"]["duplicate"]:
                answer = "这道错题已存在，本次没有重复写入。"
        elif not previous["data"]["mistakes"]:
            answer = "还没有错题记录，请先运行离线保存演示。"
        else:
            topics = "、".join(previous["data"]["topic_counts"])
            answer = f"已从本地文件读取错题，涉及：{topics}。"
            answer += "\n练习请从已确认的资料中选择原题；当前题的巩固不需要读取其他错题。"
        return {"role": "assistant", "content": answer}
