"""调用结果的轻量数据模型（dataclass）。

这些类只是把各业务模块返回的 dict 包装成“属性可读、可再转回 dict”的对象，
不会改变底层结构：`to_dict()` 得到的就是接口原始数据，便于写入日志或再序列化。
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


def _as_dict(value):
    if hasattr(value, "to_dict"):
        return value.to_dict()
    return value


@dataclass
class Note:
    """一条笔记；content 是保存的原始 Markdown。"""

    id: str
    topic: str
    content: str
    created_at: str = ""
    extra: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data):
        data = dict(data or {})
        known = {key: data.pop(key, "") for key in ("id", "topic", "content", "created_at")}
        return cls(extra=data, **known)

    def to_dict(self):
        return {"id": self.id, "topic": self.topic, "content": self.content,
                "created_at": self.created_at, **self.extra}


@dataclass
class Mistake:
    """一条错题（同一题目 + 同一错误答案只存一份）。"""

    id: str
    question: str
    user_answer: str
    correct_answer: str
    reason: str
    topic: str
    created_at: str = ""

    @classmethod
    def from_dict(cls, data):
        data = dict(data or {})
        return cls(**{key: data.get(key, "") for key in
                      ("id", "question", "user_answer", "correct_answer", "reason", "topic", "created_at")})

    def to_dict(self):
        return {"id": self.id, "question": self.question, "user_answer": self.user_answer,
                "correct_answer": self.correct_answer, "reason": self.reason,
                "topic": self.topic, "created_at": self.created_at}


@dataclass
class Exercise:
    """题库中的一道题；answer 可能为空串（资料里没有参考答案）。"""

    data: Dict[str, Any]

    @property
    def id(self):
        return self.data.get("id", "")

    @property
    def topic(self):
        return self.data.get("topic", "")

    @property
    def question(self):
        return self.data.get("question", "")

    @property
    def answer(self):
        return self.data.get("answer", "")

    @property
    def tags(self):
        return list(self.data.get("tags", []))

    @classmethod
    def from_dict(cls, data):
        return cls(dict(data or {}))

    def to_dict(self):
        return dict(self.data)


@dataclass
class CurrentQuestion:
    """“当前题”白名单视图：不含答案、错因与历史作答。"""

    id: str
    kind: str
    topic: str
    question: str
    tags: List[str] = field(default_factory=list)
    source: str = ""
    number: str = ""
    paper: str = ""

    @classmethod
    def from_dict(cls, data):
        data = dict(data or {})
        return cls(id=data.get("id", ""), kind=data.get("kind", ""), topic=data.get("topic", ""),
                   question=data.get("question", ""), tags=list(data.get("tags") or []),
                   source=data.get("source", ""), number=data.get("number", ""),
                   paper=data.get("paper", ""))

    def to_dict(self):
        return {"id": self.id, "kind": self.kind, "topic": self.topic, "question": self.question,
                "tags": list(self.tags), "source": self.source, "number": self.number, "paper": self.paper}


@dataclass
class StudyEvent:
    """Agent 的一步事件：请求模型 / 工具请求 / 工具结果。"""

    event: str
    value: Dict[str, Any]

    @property
    def tool_name(self):
        """若是工具事件，返回工具名；否则返回空串。"""
        if isinstance(self.value, dict):
            function = self.value.get("function")
            if isinstance(function, dict):
                return function.get("name", "")
            return self.value.get("name", "")
        return ""

    @property
    def ok(self):
        return bool(self.value.get("ok")) if isinstance(self.value, dict) else False

    @classmethod
    def from_dict(cls, data):
        return cls(event=data.get("event", ""), value=dict(data.get("value") or {}))

    def to_dict(self):
        return {"event": self.event, "value": self.value}


@dataclass
class ToolResult:
    """从事件流里抽出的“工具结果”，便于直接判断保存是否成功。"""

    name: str
    ok: bool
    data: Dict[str, Any]

    @property
    def record(self):
        """保存类工具的记录本体（note / mistake / exercise）。"""
        return self.data.get("note") or self.data.get("mistake") or self.data.get("exercise")

    def to_dict(self):
        return {"name": self.name, "ok": self.ok, "data": self.data}


@dataclass
class ChatResult:
    """一次对话的完整结果。"""

    answer: str
    events: List[StudyEvent] = field(default_factory=list)
    proposals: List[Dict[str, Any]] = field(default_factory=list)
    current_question: Optional[CurrentQuestion] = None

    def tools(self):
        """按顺序返回本轮的“工具结果”（已过滤掉工具请求）。"""
        results = []
        pending = None
        for event in self.events:
            if event.event == "工具请求":
                data = event.value.get("function") if isinstance(event.value, dict) else None
                pending = (data or {}).get("name", "") if isinstance(data, dict) else event.value.get("name", "")
            elif event.event == "工具结果":
                value = event.value if isinstance(event.value, dict) else {}
                results.append(ToolResult(name=pending or "", ok=bool(value.get("ok")), data=value.get("data") or {}))
                pending = None
        return results

    def saved_records(self):
        """本轮真正写入的记录（note / mistake），便于调用方自己继续处理。"""
        saved = []
        for tool in self.tools():
            if not tool.ok:
                continue
            if tool.name == "save_note" and tool.data.get("note"):
                saved.append(("note", tool.data["note"]))
            elif tool.name == "save_mistake" and tool.data.get("mistake"):
                saved.append(("mistake", tool.data["mistake"]))
        return saved

    def to_dict(self):
        return {"answer": self.answer, "events": [event.to_dict() for event in self.events],
                "proposals": self.proposals,
                "current_question": self.current_question.to_dict() if self.current_question else None}


@dataclass
class ReviewSelection:
    """复习选题结果。"""

    answer: str
    selection: Dict[str, Any]
    current_question: Optional[CurrentQuestion] = None
    matched: int = 0

    def to_dict(self):
        return {"answer": self.answer, "selection": self.selection,
                "current_question": self.current_question.to_dict() if self.current_question else None,
                "matched": self.matched}


@dataclass
class MaterialJobResult:
    """后台整理任务的状态快照。"""

    id: str
    status: str
    source: str
    progress: Dict[str, Any] = field(default_factory=dict)
    error: str = ""
    exercises: List[Dict[str, Any]] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    issues: List[Dict[str, Any]] = field(default_factory=list)
    failures: List[Dict[str, Any]] = field(default_factory=list)
    raw: Dict[str, Any] = field(default_factory=dict)

    @property
    def finished(self):
        return self.status in ("ready", "failed", "cancelled")

    @classmethod
    def from_job(cls, job):
        job = dict(job or {})
        result = job.get("result") or {}
        return cls(id=job.get("id", ""), status=job.get("status", ""), source=job.get("source", ""),
                   progress=dict(job.get("progress") or {}), error=job.get("error", ""),
                   exercises=list(result.get("exercises") or []),
                   warnings=list(result.get("warnings") or []),
                   issues=list(result.get("issues") or []),
                   failures=list(result.get("failures") or []),
                   raw=job)

    def to_dict(self):
        return self.raw or {"id": self.id, "status": self.status, "source": self.source,
                            "progress": self.progress, "error": self.error,
                            "result": {"exercises": self.exercises, "warnings": self.warnings,
                                       "issues": self.issues, "failures": self.failures}}
