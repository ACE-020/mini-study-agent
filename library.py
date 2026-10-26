"""跨库选择、待确认操作和可恢复的批量删除。模型不能直接提交删除。"""

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path


FILES = {"note": "notes.json", "mistake": "mistakes.json", "exercise": "exercises.json"}


def fingerprint(record):
    return hashlib.sha256(json.dumps(record, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def validate_refs(items):
    if not isinstance(items, list) or not 1 <= len(items) <= 30:
        raise ValueError("请勾选 1 到 30 条笔记、错题或练习题。")
    refs = []
    seen = set()
    for item in items:
        if (not isinstance(item, dict) or set(item) != {"kind", "id"} or not isinstance(item["kind"], str) or item["kind"] not in FILES or
                not isinstance(item["id"], str) or not item["id"] or len(item["id"]) > 120):
            raise ValueError("所选记录格式有误，请刷新列表后重试。")
        key = (item["kind"], item["id"])
        if key not in seen:
            seen.add(key)
            refs.append(dict(item))
    return refs


class LibraryStore:
    def __init__(self, tools):
        self.tools = tools
        self.root = tools.data_dir
        self.journal = self.root / "library.transaction.json"

    def recover(self):
        if not self.journal.exists():
            return
        journal = json.loads(self.journal.read_text(encoding="utf-8"))
        if not isinstance(journal, dict) or set(journal.get("before", {})) not in ({"notes.json", "mistakes.json", "trash.json"}, {*FILES.values(), "trash.json"}):
            raise ValueError("批量操作恢复文件有误，请先检查 library.transaction.json；记录未被覆盖。")
        for name, records in journal["before"].items():
            path = self.root / name
            current = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
            if current == records:
                continue
            if records is None:
                path.unlink(missing_ok=True)
            else:
                self.tools._write_records(name, records)
        self.journal.unlink()

    def select(self, items, max_chars=80000):
        self.recover()
        refs = validate_refs(items)
        kinds = {ref["kind"] for ref in refs}
        records = {kind: {item["id"]: item for item in
                   (self.tools.bank.read() if kind == "exercise" else self.tools._read(FILES[kind]))}
                   for kind in kinds}
        selected = []
        for ref in refs:
            record = records[ref["kind"]].get(ref["id"])
            if record is None:
                raise ValueError("所选内容已被删除或移动，请刷新列表后重新选择。")
            selected.append({**ref, "record": record, "fingerprint": fingerprint(record)})
        if max_chars and sum(len(json.dumps(item["record"], ensure_ascii=False)) for item in selected) > max_chars:
            raise ValueError("所选内容过长，请分批分析。每批最多 80000 字。")
        return selected

    def propose_delete(self, items):
        return {"type": "delete", "items": self.select(items), "requires_confirmation": True}

    def propose_merge(self, items, topic, content):
        selected = self.select(items)
        if len(selected) < 2:
            raise ValueError("合并至少需要选择两条内容。")
        if not isinstance(topic, str) or not topic.strip() or len(topic) > 120:
            raise ValueError("合并笔记需要 1 到 120 字的知识点。")
        if not isinstance(content, str) or not content.strip() or len(content) > 24000:
            raise ValueError("合并笔记需要 1 到 24000 字的完整正文。")
        return {"type": "merge", "items": selected, "note": {"topic": topic.strip(), "content": content.strip()},
                "requires_confirmation": True}

    def _check_snapshot(self, proposal):
        selected = self.select([{key: item[key] for key in ("kind", "id")} for item in proposal["items"]])
        if [item["fingerprint"] for item in selected] != [item["fingerprint"] for item in proposal["items"]]:
            raise ValueError("确认前原记录已经改变，本次操作未执行；请重新预览。")
        return selected

    def confirm_delete(self, proposal):
        selected = self._check_snapshot(proposal)
        before = {}
        for name in (*FILES.values(), "trash.json"):
            path = self.root / name
            before[name] = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
            if before[name] is not None and not isinstance(before[name], list):
                raise ValueError("记录文件结构有误，本次删除未执行。")
        journal = {"before": before}
        # 保存恢复快照后再修改相关库；中途失败或进程退出，下次读库先恢复原记录。
        self.tools._write_records("library.transaction.json", journal)
        try:
            for kind, name in FILES.items():
                ids = {item["id"] for item in selected if item["kind"] == kind}
                if ids:
                    self.tools._write_records(name, [item for item in before[name] or [] if item["id"] not in ids])
            trash = [*(before["trash.json"] or []), *[
                {"kind": item["kind"], "record": item["record"], "deleted_at": datetime.now(timezone.utc).isoformat()}
                for item in selected]]
            self.tools._write_records("trash.json", trash)
            self.journal.unlink()
        except Exception:
            self.recover()
            raise
        return {"deleted": len(selected), "items": [{"kind": item["kind"], "id": item["id"]} for item in selected]}

    def confirm_merge(self, proposal, remove_source_notes=False, cancel_token=None):
        selected = self._check_snapshot(proposal)
        fields = proposal["note"]
        record = self.tools.note_record(**fields)
        records = self.tools._read("notes.json")
        existing = next((item for item in records if item["id"] == record["id"]), None)
        record = existing or {**record, "source_refs": [{"kind": item["kind"], "id": item["id"]} for item in selected]}
        if remove_source_notes:
            remove_ids = {item["id"] for item in selected if item["kind"] == "note" and item["id"] != record["id"]}
            # 留下快照以备手动恢复；本操作只改笔记库，保留作为学习证据的错题和来源练习题。
            archive = self.root / "merge_backups"
            archive.mkdir(parents=True, exist_ok=True)
            self.tools._write_records(f"merge_backups/{record['id']}.json", [item for item in records if item["id"] in remove_ids])
            records = [item for item in records if item["id"] not in remove_ids]
        if cancel_token:
            cancel_token.check()
        if not existing:
            records.append(record)
        self.tools._write_records("notes.json", records)
        return {"saved": not bool(existing), "duplicate": bool(existing), "note": record,
                "exports": self.tools.note_exporter.export(record, cancel_token=cancel_token)}
