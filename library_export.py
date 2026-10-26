"""将所选笔记与错题导出成合集，不调用模型，不改动原记录。"""

from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile

from math_text import normalize_math_markdown
from note_exports import NoteExporter


def markdown_collection(selected):
    parts = ["# 学习内容合集\n"]
    for index, item in enumerate(selected, 1):
        record = item["record"]
        kind = {"note": "笔记", "mistake": "错题", "exercise": "练习题"}[item["kind"]]
        parts.append(f"## {index}. {record['topic']} · {kind}\n")
        if item["kind"] == "note":
            parts.append(record["content"])
        elif item["kind"] == "exercise":
            parts.append(f"来源：{record['source']} · 原题号：{record['number'] or '未标注'}")
            parts.append("试卷 / 题组："+(record.get("paper") or "未分组"))
            if record.get("tags"):
                parts.append("细题型："+"、".join(record["tags"]))
            parts.append("### 题目\n\n" + record["question"])
            if record["answer"]:
                parts.append("### 资料参考答案\n\n" + record["answer"])
        else:
            for label, field in (("题目", "question"), ("当时的答案", "user_answer"), ("正确答案", "correct_answer"), ("错因", "reason")):
                parts.append(f"### {label}\n\n{record[field]}")
        parts.append("\n---\n")
    return normalize_math_markdown("\n\n".join(parts)).rstrip() + "\n"


def export_collection(selected, kind, token=None):
    if kind == "json":
        payload = {"exported_at": datetime.now(timezone.utc).isoformat(), "items": [
            {"kind": item["kind"], "record": item["record"]} for item in selected]}
        return json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8"), "application/json"
    source = markdown_collection(selected)
    if kind == "md":
        return source.encode("utf-8"), "text/markdown; charset=utf-8"
    with tempfile.TemporaryDirectory(prefix="study-collection-") as folder:
        result = NoteExporter(folder).export({"id": "selected-collection", "topic": "学习内容合集", "content": source}, token)
        if token:
            token.check()
        if not result.get("pdf", {}).get("ok"):
            raise ValueError("PDF 合集未生成：" + result.get("pdf", {}).get("error", "请稍后重试。"))
        return Path(result["pdf"]["path"]).read_bytes(), "application/pdf"
