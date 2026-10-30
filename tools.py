"""本地工具：笔记检索与保存、错题记录和资料选题。"""

from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
from review_catalog import ReviewCatalog
from review_progress import ReviewProgress
from materials import QuestionBank
from classification import clean_tags
from note_exports import NoteExporter
from library import LibraryStore, validate_refs


def tool_schema(name, description, properties, required):
    return {"type": "function", "function": {
        "name": name, "description": description,
        "parameters": {"type": "object", "properties": properties,
                       "required": required, "additionalProperties": False},
    }}


TEXT = {"type": "string", "minLength": 1, "maxLength": 8000}
MISTAKE_FIELDS = ("question", "user_answer", "correct_answer", "reason", "topic")
REFS = {"type": "array", "minItems": 1, "maxItems": 30, "items": {
    "type": "object", "properties": {"kind": {"type": "string", "enum": ["note", "mistake", "exercise"]},
                                       "id": {"type": "string", "minLength": 1, "maxLength": 120}},
    "required": ["kind", "id"], "additionalProperties": False}}
SCHEMAS = [
    tool_schema("search_notes", "按简短关键词检索本地高数笔记，返回相关内容；可用空格分隔多个关键词。",
                {"query": TEXT}, ["query"]),
    tool_schema("save_mistake", "保存有依据的错题；已有相同题目和错误答案时不重复保存。"
                "question 是原题，user_answer 是用户原答案，correct_answer 是参考答案，"
                "reason 是错误原因，topic 是简短知识点（例如：导数）。",
                {name: TEXT for name in MISTAKE_FIELDS}, list(MISTAKE_FIELDS)),
    tool_schema("get_mistakes", "仅在用户明确要求历史错题复习时读取错题，确定复习方向。当前题的追问和巩固不调用。",
                {"topic": TEXT, "limit": {"type": "integer", "minimum": 1, "maximum": 20}}, []),
    tool_schema("pick_exercise", "从已确认的现有题目中选原题，不返回答案。不编题。默认只选资料；复习分类可用 category、source_kind（any/exercise/mistake）和一个细分 tags，涵盖资料与错题。",
                {"topic": TEXT, "exclude_id": TEXT, "exclude_ids": {"type":"array","maxItems":10000,"items":{"type":"string","minLength":1,"maxLength":120}}, "exercise_id": TEXT, "category": {**TEXT, "maxLength":120}, "source_kind": {**TEXT, "enum":["any","exercise","mistake"]}, "tags":{"type":"array","maxItems":8,"items":{"type":"string","minLength":1,"maxLength":40}}}, ["topic"]),
    tool_schema("save_note", "保存按默认笔记规则整理的完整 Markdown 笔记，并导出 Markdown/PDF。相同内容不重复入库，不覆盖旧笔记。",
                {"topic": {**TEXT, "maxLength": 120}, "content": {**TEXT, "maxLength": 24000}}, ["topic", "content"]),
    tool_schema("delete_records", "为用户选中的笔记/错题/练习题生成待确认删除清单，不立即删除。网页再次确认后程序才执行。items 只能包含本轮所选记录。",
                {"items": REFS}, ["items"]),
    tool_schema("merge_records", "将本轮所选内容去重整理成一份笔记预览，保留独有条件、推导和错因。只生成待确认方案，不立即写入或删除原记录。",
                {"items": REFS, "topic": {**TEXT, "maxLength": 120}, "content": {**TEXT, "maxLength": 24000}},
                ["items", "topic", "content"]),
]


class LocalTools:
    supports_cancellation = True

    def __init__(self, data_dir, note_exporter=None):
        self.data_dir = Path(data_dir)
        self.bank = QuestionBank(self.data_dir)
        self.progress = ReviewProgress(self.data_dir)
        self.note_exporter = note_exporter or NoteExporter(self.data_dir)
        self.library = LibraryStore(self)
        self.library.recover()

    def _read(self, name):
        self.library.recover()
        path = self.data_dir / name
        if not path.exists():
            return []
        with path.open(encoding="utf-8") as file:
            records = json.load(file)
        fields = MISTAKE_FIELDS + ("id", "created_at") if name == "mistakes.json" else ("id", "topic", "content")
        if not isinstance(records, list) or any(
            not isinstance(record, dict) or any(
                not isinstance(record.get(key), str) or not record[key].strip()
                for key in fields
            ) for record in records
        ):
            raise ValueError(f"{name} 的数据结构有误；请先检查文件，原文件未被覆盖。")
        return records

    def _write_mistakes(self, records):
        self._write_records("mistakes.json", records)

    def _write_records(self, name, records):
        self.data_dir.mkdir(parents=True, exist_ok=True)
        # 先完整写入同目录临时文件，再替换，避免写到一半损坏原 JSON。
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", suffix=".tmp",
                                             dir=self.data_dir, delete=False) as file:
                temporary = file.name
                json.dump(records, file, ensure_ascii=False, indent=2)
                file.write("\n")
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, self.data_dir / name)
        finally:
            if temporary and Path(temporary).exists():
                Path(temporary).unlink()

    def search_notes(self, query):
        keywords = re.split(r"[\s,，;；]+", query.casefold())
        matches = []
        for note in self._read("notes.json"):
            text = (note["topic"] + " " + note["content"]).casefold()
            score = sum(bool(word) and word in text for word in keywords)
            if score:
                matches.append((score, note))
        return [note for _, note in sorted(matches, key=lambda item: -item[0])[:5]]

    def save_mistake(self, **fields):
        records = self._read("mistakes.json")
        normalized = [" ".join(fields[key].split()) for key in ("question", "user_answer")]
        mistake_id = hashlib.sha256(json.dumps(normalized, ensure_ascii=False).encode()).hexdigest()[:16]
        existing = next((item for item in records if item["id"] == mistake_id), None)
        if existing:
            return {"saved": False, "duplicate": True, "mistake": existing}
        record = {"id": mistake_id, **fields,
                  "created_at": datetime.now(timezone.utc).isoformat()}
        self._write_mistakes([*records, record])
        return {"saved": True, "duplicate": False, "mistake": record}

    def get_mistakes(self, topic=None, limit=5):
        records = self._read("mistakes.json")
        if topic is not None:
            records = [item for item in records if topic.casefold() in item["topic"].casefold()]
        counts = Counter(item["topic"] for item in records)
        records.sort(key=lambda item: (-counts[item["topic"]], item["created_at"], item["id"]))
        return {"total": len(records), "topic_counts": dict(counts.most_common()),
                "mistakes": records[:limit]}

    def note_record(self, topic, content):
        if re.search(r"\[(?:无法辨认|待确认|无法识别)[^\]]*\]", content):
            raise ValueError("笔记仍有待确认的符号，请先询问并核对后再保存。")
        normalized = [topic.strip(), content.replace("\r\n", "\n").strip()]
        note_id = hashlib.sha256(json.dumps(normalized, ensure_ascii=False).encode()).hexdigest()[:16]
        return {"id": note_id, "topic": topic.strip(), "content": content.strip(),
                "created_at": datetime.now(timezone.utc).isoformat()}

    def save_note(self, topic, content, cancel_token=None):
        record = self.note_record(topic, content)
        records = self._read("notes.json")
        note_id = record["id"]
        existing = next((item for item in records if item["id"] == note_id), None)
        record = existing or record
        if cancel_token:
            cancel_token.check()
        if not existing:
            self._write_records("notes.json", [*records, record])
        # JSON 保存成功后，导出失败也如实返回保存状态，允许稍后重试。
        exports = self.note_exporter.export(record, cancel_token=cancel_token)
        return {"saved": not bool(existing), "duplicate": bool(existing), "note": record, "exports": exports}

    def review_catalog(self):
        return ReviewCatalog(self.bank.read(), self._read("mistakes.json"))

    def pick_exercise(self, topic, exclude_id=None, exercise_id=None, tags=None, category=None, source_kind="exercise", exclude_ids=None):
        if category is not None or source_kind != "exercise":
            if tags and len(tags)>1:
                raise ValueError("复习分类一次请选择一个细分标签。")
            return self.review_catalog().pick("" if category == "全部知识点" else category or topic, tags[0] if tags else "", source_kind, exclude_id, exercise_id, exclude_ids)
        return self.bank.pick(topic, exclude_id, exercise_id, tags, exclude_ids)

    def execute(self, name, arguments, cancel_token=None):
        """只执行白名单内的函数；工具错误也作为结果返回模型。"""
        specs = {item["function"]["name"]: item["function"] for item in SCHEMAS}
        try:
            if name not in specs:
                raise ValueError("未知工具；只允许 " + "、".join(specs) + "。")
            params = json.loads(arguments)
            schema = specs[name]["parameters"]
            if not isinstance(params, dict):
                raise ValueError("工具参数必须是 JSON 对象。")
            if set(params) - set(schema["properties"]) or set(schema["required"]) - set(params):
                raise ValueError("工具参数含未知字段或缺少必填字段。")
            for key, value in params.items():
                if key == "items":
                    params[key] = validate_refs(value)
                elif key == "exclude_ids":
                    if not isinstance(value,list) or len(value)>10000 or any(not isinstance(v,str) or not v or len(v)>120 for v in value):
                        raise ValueError("本轮已出题目列表无效。")
                elif key == "tags":
                    params[key] = clean_tags(value)
                elif key == "limit":
                    if type(value) is not int or not 1 <= value <= 20:
                        raise ValueError("limit 必须是 1 到 20 之间的整数。")
                elif not isinstance(value, str) or not value.strip() or len(value) > schema["properties"][key]["maxLength"]:
                    raise ValueError(f"{key} 必须是 1 到 {schema['properties'][key]['maxLength']} 字的非空字符串。")
                else:
                    params[key] = value.strip()
            handlers = {"search_notes": self.search_notes, "save_mistake": self.save_mistake,
                        "get_mistakes": self.get_mistakes, "pick_exercise": self.pick_exercise,
                        "save_note": lambda **params: self.save_note(**params, cancel_token=cancel_token),
                        "delete_records": self.library.propose_delete, "merge_records": self.library.propose_merge}
            return {"ok": True, "data": handlers[name](**params)}
        except (ValueError, TypeError, OSError) as exc:
            return {"ok": False, "error": str(exc)}
