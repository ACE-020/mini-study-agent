"""业务服务层：把各后端模块组合成一套稳定的 Python 接口。

设计要点：

- 一个 `StudyService` 对应网页里的“一个会话”：对话上下文、当前题、待确认方案都在实例内；
- 所有写操作与网页一致：笔记/错题直接保存，删除/合并只生成待确认方案；
- 方法失败时抛出 `study_api.errors` 里的异常，而不是返回错误字典，便于调用方用 try/except；
- 不依赖 Flask、不监听端口，可以在脚本、定时任务、自己的 Web 框架里直接使用。
"""

from datetime import datetime, timezone
import json
import secrets
import threading
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from agent import StudyAgent
from cancellation import CancellationToken
from classification import clean_tags
from document_input import DocumentReader
from library import LibraryStore
from library_export import export_collection
from llm import ModelClient, ModelError
from local_ocr import LocalImageReader, LocalOcrRuntime
from material_jobs import MaterialJobs
from material_sources import capture_materials
from materials import MaterialParser, QuestionBank, material_rules, validate_exercises
from note_exports import NoteExporter
from note_skill import note_rules
from ocr import MAX_IMAGE_BYTES, ImageReader, prepare_image
from prompts import GENERATED_PRACTICE_POLICY, REVIEW_ANSWER_POLICY, STUDY_PROMPT
from review_catalog import ReviewCatalog
from settings import SettingsStore
from tools import LocalTools, SCHEMAS

from .backends import LocalBackend, ModelBackend, ScriptedBackend
from .config import AppConfig
from .errors import (ApiError, CancelledError, ConfigurationError, DataFileError, ModelFailure,
                     NotFoundError)
from .models import (ChatResult, CurrentQuestion, Exercise, MaterialJobResult, Mistake, Note,
                     ReviewSelection, StudyEvent, ToolResult)


class _DirectCompleteClient:
    """把“单次完成”可调用对象包成 MaterialParser 认得的客户端：

    MaterialParser 只在不属于 ModelClient 时调用 `complete(messages, tools=None)`，
    因此只要提供一个同名方法即可（不需要 cancel_token 参数）。
    """

    def __init__(self, complete):
        self._complete = complete

    def complete(self, messages, tools=None, cancel_token=None):
        return self._complete(messages, tools)


class _BackendRestore:
    """配合 `with service.use_backend(x):` 使用；退出时把服务恢复到之前的后端。"""

    def __init__(self, service, previous):
        self.service = service
        self.previous = previous if previous is not None else service._previous_backend

    def __enter__(self):
        return self.service._backend

    def __exit__(self, exc_type, exc, tb):
        if self.previous is not None:
            self.service._backend = self.previous
        return False


class _Selection(dict):
    """与 review_catalog.validate_filter 返回值同构的字典，同时支持属性访问。"""

    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError as exc:  # pragma: no cover - 仅在拼写错误时触发
            raise AttributeError(name) from exc


class StudyService:
    """学习整理助手的 Python 服务对象。"""

    def __init__(self, config: Optional[AppConfig] = None, settings: Optional[SettingsStore] = None,
                 backend: Optional[ModelBackend] = None):
        self.config = (config or AppConfig()).ensure_directories()
        if self.config.load_user_environment:
            from settings import load_user_environment
            load_user_environment()
        self.settings = settings or SettingsStore(self.config.settings_path)
        self.tools = LocalTools(self.config.data_dir)
        self.library: LibraryStore = self.tools.library
        self.bank: QuestionBank = self.tools.bank
        self._backend: ModelBackend = backend or LocalBackend(self.settings)
        # 与网页版一致：对话视图 → StudyAgent 实例（上下文保存在这里）
        self._agents: Dict[str, StudyAgent] = {}
        # 待确认方案：id → {created, proposal}（15 分钟过期，最多 20 条）
        self._proposals: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.RLock()
        self._local_runtime = None
        self._jobs = None
        self._closed = False

    # ------------------------------------------------------------------ 配置与状态
    def configure_model(self, base_url: str, api_key: str, model: str, ocr_model: str = "",
                        ocr_base_url: str = "", ocr_api_key: str = "", ocr_backend: str = "auto") -> Dict[str, Any]:
        """保存模型配置（密钥在 Windows 上用 DPAPI 加密），返回可安全展示的配置。"""
        if not ocr_model:
            current = self.settings.public()
            ocr_model = current.get("ocr_model") or model
        try:
            return self.settings.save({"base_url": base_url, "api_key": api_key, "model": model,
                                       "ocr_model": ocr_model, "ocr_base_url": ocr_base_url,
                                       "ocr_api_key": ocr_api_key, "ocr_backend": ocr_backend})
        except ValueError as exc:
            raise ConfigurationError(str(exc)) from exc

    def settings_public(self) -> Dict[str, Any]:
        """读取可安全展示的配置（不含密钥）。"""
        try:
            return self.settings.public()
        except ValueError as exc:
            raise ConfigurationError(str(exc)) from exc

    def status(self) -> Dict[str, Any]:
        """服务状态：是否已配置、模型名、识图方式、数据目录等。"""
        try:
            config = self.settings.public()
        except ValueError:
            config = {"configured": False, "model": "", "ocr_model": "", "ocr_backend": "auto"}
        return {
            "ok": True,
            "configured": bool(config.get("configured")) or isinstance(self._backend, ScriptedBackend),
            "model": config.get("model", ""),
            "ocr_model": config.get("ocr_model", ""),
            "ocr_backend": config.get("ocr_backend", "auto"),
            "data_dir": str(self.config.data_dir),
            "settings_path": str(self.config.settings_path),
            "version": "workspace-v20-python-api-1",
            "backend": type(self._backend).__name__,
        }

    def test_connection(self, base_url: str = "", api_key: str = "", model: str = "") -> str:
        """用给定配置（或已保存配置）发一次极小请求验证连通性。"""
        values = {"base_url": base_url, "api_key": api_key, "model": model}
        if not all(values.values()):
            try:
                current = self.settings.resolve()
            except ValueError as exc:
                raise ConfigurationError(str(exc)) from exc
            for key in values:
                values[key] = values[key] or current[key]
        client = ModelClient(values["base_url"], values["api_key"], values["model"], timeout=20, retries=0)
        try:
            client.complete([{"role": "user", "content": "请只回复：连接成功。"}])
        except ModelError as exc:
            raise ModelFailure(str(exc)) from exc
        return f"{values['model']} 的文字请求连接成功。"

    def prompts(self) -> Dict[str, str]:
        """实际下发的提示词，便于核对。"""
        return {"教学与选题": STUDY_PROMPT, "用户明确要求自行出题（动态规则）": GENERATED_PRACTICE_POLICY,
                "图片作答与逐步引导": REVIEW_ANSWER_POLICY, "资料拆题": material_rules(),
                "笔记整理（默认）": note_rules()}

    def tool_schemas(self):
        """模型可见的工具白名单（与网页版一致）。"""
        return [item["function"]["name"] for item in SCHEMAS]

    # ------------------------------------------------------------------ 模型后端
    def use_backend(self, backend: ModelBackend):
        """替换模型后端。

        - 直接调用：`service.use_backend(x)` —— 永久替换（离线测试/自研模型常用）；
        - 上下文管理器：`with service.use_backend(x):` —— 语句块结束时自动恢复原后端。
        """
        previous = self._backend
        self._backend = backend
        self._previous_backend = previous
        return _BackendRestore(self, previous)

    def use_scripted_model(self, complete, reader=None, complete_with_tools=None):
        """便捷入口：用可调用对象临时替代模型（离线测试/自研模型）。

        complete_with_tools(messages, tool_names) 可选：StudyAgent 会优先调用它并传入本轮可用工具名。
        """
        return self.use_backend(ScriptedBackend(complete, reader, complete_with_tools))

    def _material_client(self) -> Any:
        """给拆题/校正等“单次请求”场景使用的客户端（允许注入自定义工具钩子）。"""
        client = self._client()
        if isinstance(client, ModelClient):
            return client
        try:
            return _DirectCompleteClient(client.complete)
        except AttributeError:
            return client

    def _client(self) -> Any:
        try:
            return self._backend.new_client()
        except ConfigurationError:
            raise
        except (RuntimeError, ValueError, ModelError) as exc:
            raise ConfigurationError(str(exc)) from exc

    def _reader(self):
        if isinstance(self._backend, LocalBackend):
            if self._use_local_ocr():
                return LocalImageReader(self._local_runtime())
        try:
            return self._backend.new_reader()
        except RuntimeError as exc:
            raise ConfigurationError(str(exc)) from exc

    def _use_local_ocr(self) -> bool:
        if self.config.local_ocr is False:
            return False
        if self.config.local_ocr is True:
            return True
        try:
            return self.settings.resolve().get("ocr_backend") == "local"
        except ValueError:
            return False

    def _local_runtime(self) -> LocalOcrRuntime:
        if self._local_runtime is None:
            self._local_runtime = LocalOcrRuntime()
        return self._local_runtime

    # ------------------------------------------------------------------ 数据读取
    def _read_records(self, name: str) -> List[Dict[str, Any]]:
        try:
            return self.tools._read(name)
        except ValueError as exc:
            raise DataFileError(str(exc)) from exc
        except OSError as exc:
            raise DataFileError(f"{name} 读取失败：{exc}") from exc

    def list_notes(self) -> List[Note]:
        """全部笔记（新在前）。"""
        return [Note.from_dict(item) for item in reversed(self._read_records("notes.json"))]

    def get_note(self, note_id: str) -> Note:
        """按 id 取一条笔记。"""
        for record in self._read_records("notes.json"):
            if record["id"] == note_id:
                return Note.from_dict(record)
        raise NotFoundError("这份笔记不存在。")

    def search_notes(self, query: str, limit: int = 5) -> List[Note]:
        """按关键词检索笔记（空格/逗号分隔多个关键词）。"""
        if not isinstance(query, str) or not query.strip():
            raise ApiError("请提供检索关键词。")
        return [Note.from_dict(item) for item in self.tools.search_notes(query)[:max(1, int(limit))]]

    def list_mistakes(self, limit: Optional[int] = None) -> List[Mistake]:
        """错题列表（按知识点频次排序）。"""
        return [Mistake.from_dict(item) for item in self.tools.get_mistakes(limit=limit or 200)["mistakes"]]

    def mistake_summary(self, topic: Optional[str] = None, limit: int = 5) -> Dict[str, Any]:
        """错题统计：总数、知识点分布与前 N 条。"""
        try:
            return self.tools.get_mistakes(topic=topic, limit=limit)
        except ValueError as exc:
            raise DataFileError(str(exc)) from exc

    def get_mistake(self, mistake_id: str) -> Mistake:
        for record in self._read_records("mistakes.json"):
            if record["id"] == mistake_id:
                return Mistake.from_dict(record)
        raise NotFoundError("这条错题不存在。")

    def list_exercises(self) -> List[Exercise]:
        """题库全部题目。"""
        try:
            return [Exercise.from_dict(item) for item in self.bank.read()]
        except ValueError as exc:
            raise DataFileError(str(exc)) from exc

    def get_exercise(self, exercise_id: str) -> Exercise:
        for item in self.list_exercises():
            if item.id == exercise_id:
                return item
        raise NotFoundError("这道题不存在。")

    # ------------------------------------------------------------------ 数据写入
    def save_note(self, topic: str, content: str, cancel_token: Optional[CancellationToken] = None) -> Dict[str, Any]:
        """保存笔记并导出 Markdown/PDF（同内容不重复入库）。"""
        try:
            return self.tools.save_note(topic, content, cancel_token=cancel_token)
        except ValueError as exc:
            raise ApiError(str(exc)) from exc
        except OSError as exc:
            raise DataFileError(f"笔记写入失败：{exc}") from exc

    def save_mistake(self, question: str, user_answer: str, correct_answer: str, reason: str,
                     topic: str) -> Dict[str, Any]:
        """保存错题（题目+用户答案相同则视为重复）。"""
        fields = {"question": question, "user_answer": user_answer,
                  "correct_answer": correct_answer, "reason": reason, "topic": topic}
        for key, value in fields.items():
            if not isinstance(value, str) or not value.strip() or len(value) > 8000:
                raise ApiError(f"{key} 必须是 1 到 8000 字的非空字符串。")
            fields[key] = value.strip()
        try:
            return self.tools.save_mistake(**fields)
        except ValueError as exc:
            raise ApiError(str(exc)) from exc
        except OSError as exc:
            raise DataFileError(f"错题写入失败：{exc}") from exc

    def delete_note(self, note_id: str, *, remove_source_notes: bool = False) -> Dict[str, Any]:
        """删除一条笔记（走“预览 + 确认”流程，记录会进入 trash.json）。"""
        return self.confirm_proposal(self.preview_delete([{"kind": "note", "id": note_id}]),
                                     remove_source_notes=remove_source_notes)

    def export_note(self, note_id: str, cancel_token: Optional[CancellationToken] = None) -> Dict[str, Any]:
        """重新导出某条笔记的 Markdown/PDF。"""
        record = self.get_note(note_id).to_dict()
        return self.tools.note_exporter.export(record, cancel_token=cancel_token)

    def export_collection(self, items: Iterable[Dict[str, str]], fmt: str,
                          cancel_token: Optional[CancellationToken] = None,
                          max_chars: Optional[int] = None) -> bytes:
        """导出所选记录为 md/pdf/json 字节流（不改动原记录）。

        max_chars 默认不限制（导出不受“供模型分析”的字数上限影响）。
        """
        if fmt not in ("md", "pdf", "json"):
            raise ApiError("格式只能是 md、pdf 或 json。")
        try:
            selected = self.library.select(list(items), max_chars=max_chars)
            content, _ = export_collection(selected, fmt, cancel_token)
            return content
        except ValueError as exc:
            raise ApiError(str(exc)) from exc
        except OSError as exc:
            raise DataFileError(str(exc)) from exc

    # ------------------------------------------------------------------ 待确认方案（删除/合并）
    def _remember(self, proposal: Dict[str, Any]) -> Dict[str, Any]:
        now = time.monotonic()
        with self._lock:
            self._proposals = {key: value for key, value in self._proposals.items() if now - value["created"] < 900}
            while len(self._proposals) >= 20:
                self._proposals.pop(next(iter(self._proposals)))
            identity = secrets.token_hex(16)
            self._proposals[identity] = {"created": now, "proposal": proposal}
        return {"id": identity, **proposal}

    def preview_delete(self, items: Iterable[Dict[str, str]]) -> Dict[str, Any]:
        """生成删除预览（不会删除任何东西），返回带 id 的方案。"""
        try:
            return self._remember(self.library.propose_delete(list(items)))
        except ValueError as exc:
            raise ApiError(str(exc)) from exc

    def preview_merge(self, items: Iterable[Dict[str, str]], topic: str, content: str) -> Dict[str, Any]:
        """生成合并预览（不会写入），返回带 id 的方案。"""
        try:
            return self._remember(self.library.propose_merge(list(items), topic, content))
        except ValueError as exc:
            raise ApiError(str(exc)) from exc

    def confirm_proposal(self, proposal: Any, *, remove_source_notes: bool = False,
                         note: Optional[Dict[str, str]] = None,
                         cancel_token: Optional[CancellationToken] = None) -> Dict[str, Any]:
        """执行已生成的删除/合并方案。

        proposal 可以是 `preview_*` 返回的对象，也可以只传方案 id 字符串。
        """
        if isinstance(proposal, str):
            pending = self._proposals.get(proposal)
            if pending is None or time.monotonic() - pending["created"] > 900:
                raise ApiError("预览已过期或不存在，请重新预览。", status=409)
            proposal = {"id": proposal, **pending["proposal"]}
        if not isinstance(proposal, dict) or "items" not in proposal:
            raise ApiError("方案格式有误，请先调用 preview_delete / preview_merge。")
        if proposal.get("type") == "merge" and note:
            try:
                validated = self.library.propose_merge(
                    [{key: item[key] for key in ("kind", "id")} for item in proposal["items"]], **note)
            except ValueError as exc:
                raise ApiError(str(exc)) from exc
            proposal = {**proposal, "note": validated["note"]}
        try:
            result = self.library.confirm_delete(proposal) if proposal.get("type") == "delete" \
                else self.library.confirm_merge(proposal, remove_source_notes, cancel_token)
        except ValueError as exc:
            raise ApiError(str(exc), status=409) from exc
        except OSError as exc:
            raise DataFileError(str(exc)) from exc
        self._proposals.pop(proposal.get("id", ""), None)
        return result

    # ------------------------------------------------------------------ 复习
    def review_catalog(self, source: str = "any") -> Dict[str, Any]:
        """复习目录树（知识点 → 细分标签 → 数量）。"""
        if source not in ("any", "exercise", "mistake"):
            raise ApiError("source 只能是 any、exercise 或 mistake。")
        try:
            return self.tools.review_catalog().tree(source)
        except ValueError as exc:
            raise ApiError(str(exc)) from exc

    def select_review(self, category: str = "", tag: str = "", source: str = "any",
                      cancel_token: Optional[CancellationToken] = None) -> ReviewSelection:
        """按知识点/细分标签选一道题，作为“当前题”。纯本地读取，不调用模型。

        `category` 可以是一级目录（如“导数与微分”），也可以是具体知识点（如“导数”）；
        两者都匹配不到时才使用原值，返回 `current_question=None` 表示该范围暂无题目。
        """
        from review_catalog import category_for, validate_filter
        requested = (category or "").strip()
        candidates: List[str] = []
        for value in (requested, category_for(requested) if requested else ""):
            if value not in candidates:
                candidates.append(value)
        if tag.strip():
            # 细分标签本身往往就是知识点（例如 tags=["导数"]），做一次兜底换算
            mapped = category_for(tag.strip())
            if mapped not in candidates:
                candidates.append(mapped)
        catalog = self.tools.review_catalog()
        selection = None
        matched = 0
        for value in candidates:
            try:
                candidate = validate_filter(category=value, tag=tag, source=source)
            except ValueError as exc:
                raise ApiError(str(exc)) from exc
            matches = len(catalog.matches(candidate["category"], candidate["tag"], source))
            # 越靠前的候选越接近调用方本意；后补的“目录换算”只在前面找不到题时采用
            if matches or selection is None:
                selection, matched = candidate, matches
            if matches:
                break
        if selection is None:
            raise ApiError("请提供知识点或细分标签。")
        synthetic = _Selection(category=selection["category"], tag=selection["tag"], source=selection["source"])
        token = cancel_token or CancellationToken()
        original_execute = self.tools.execute

        def executing(name, arguments, cancel_token=None):
            """程序自动选题时用“统一目录”作为 topic，避免二级知识点（如“导数”）查不到题。"""
            result = original_execute(name, arguments, cancel_token=cancel_token)
            if name != "pick_exercise" or (isinstance(result, dict) and result.get("ok")):
                return result
            try:
                params = json.loads(arguments)
            except (TypeError, ValueError):
                return result
            params["topic"] = selection["category"]
            params.pop("tags", None)
            retried = original_execute(name, json.dumps(params, ensure_ascii=False), cancel_token=cancel_token)
            return retried if isinstance(retried, dict) and retried.get("ok") else result
        self.tools.execute = executing
        try:
            agent = StudyAgent(self._client(), self.tools)
            answer = agent.start_review(synthetic, token)
        finally:
            self.tools.execute = original_execute
        self._agents["review"] = agent
        current = agent.current_question or {}
        return ReviewSelection(answer=answer, selection=selection,
                               current_question=CurrentQuestion.from_dict(current) if current else None,
                               matched=matched)

    # ------------------------------------------------------------------ 对话
    def chat(self, message: str, *, view: str = "organize", scope: str = "current",
             intent: Optional[str] = None, topic: Optional[str] = None,
             exercise_id: Optional[str] = None, new_problem: bool = False,
             selection: Optional[Iterable[Dict[str, str]]] = None,
             cancel_token: Optional[CancellationToken] = None,
             max_rounds: Optional[int] = None) -> ChatResult:
        """与学习助手对话（与网页 /api/chat 等价）。

        view：organize（整理混合原稿并保存）/ notes（整理笔记）/ review（复习答疑）/ analysis（分析勾选记录）
        scope：current（围绕当前题）/ history（明确的历史复习）
        intent："practice" 表示明确要出一道练习题
        """
        if not isinstance(message, str) or not message.strip() or len(message) > 80000:
            raise ApiError("请输入 1 到 80000 字的内容。")
        if view not in self.config.allowed_views:
            raise ApiError(f"当前服务未开放 view={view}。")
        if scope not in ("current", "history"):
            raise ApiError("scope 只能是 current 或 history。")
        if intent not in (None, "practice"):
            raise ApiError("intent 只能是 practice 或 None。")
        refs = list(selection or [])
        if refs and view != "analysis":
            raise ApiError("所选记录只在 analysis 视图中处理。")
        if exercise_id:
            exercise = self.get_exercise(exercise_id)
            view, intent, scope = "review", "practice", "current"
        else:
            exercise = None
        # 视图 → 任务类型（与网页 /api/chat 一致）
        task = {"analysis": "library", "organize": "mixed", "notes": "notes", "review": "review"}.get(view)
        selected = []
        if refs:
            try:
                selected = self.library.select(refs)
            except ValueError as exc:
                raise ApiError(str(exc), status=409) from exc
        if view == "analysis":
            signature = sorted((item["kind"], item["id"], item["fingerprint"]) for item in selected)
            if self._agents.get("_analysis_signature") != signature:
                self._agents.pop("analysis", None)
                self._agents["_analysis_signature"] = signature
        if view in ("notes", "organize") and new_problem:
            self._agents.pop(view, None)
        if view not in self._agents or not isinstance(self._agents.get(view), StudyAgent):
            agent = StudyAgent(self._client(), self.tools, max_rounds=max_rounds or self.config.max_rounds)
            self._agents[view] = agent
        else:
            agent = self._agents[view]
            agent.client = self._client()
            agent.max_rounds = max_rounds or self.config.max_rounds
        agent.web_links = True
        if exercise is not None:
            agent.current_topic = exercise.topic
            agent.current_tags = exercise.tags
            agent.review_filter = None
            agent.last_exercise_id = None
        events: List[Dict[str, Any]] = []
        agent.trace = lambda event, value: events.append({"event": event, "value": value})
        token = cancel_token or CancellationToken()
        try:
            answer = agent.run(message.strip(), cancel_token=token, scope=scope, intent=intent, topic=topic,
                               exercise_id=exercise_id, new_problem=new_problem, task=task,
                               selection=selected)
        except Exception as exc:  # 统一转换成 study_api 的异常类型
            raise self._translate(exc, events) from exc
        proposals = []
        for event in events:
            value = event.get("value") or {}
            if event["event"] == "工具结果" and value.get("ok") and isinstance(value.get("data"), dict) \
                    and value["data"].get("requires_confirmation"):
                proposals.append(self._remember(value["data"]))
        current = agent.current_question or {}
        return ChatResult(answer=answer, events=[StudyEvent.from_dict(item) for item in events],
                          proposals=proposals,
                          current_question=CurrentQuestion.from_dict(current) if current else None)

    @staticmethod
    def _translate(exc: Exception, events) -> ApiError:
        from cancellation import OperationCancelled
        if isinstance(exc, OperationCancelled):
            return CancelledError(getattr(exc, "args", [""])[0] or "已停止本次处理。", events=events)
        if isinstance(exc, ModelError):
            return ModelFailure(str(exc), events=events)
        if isinstance(exc, OSError):
            return DataFileError(f"本次处理未完成：{exc}", events=events)
        if isinstance(exc, (KeyError,)):
            return NotFoundError(str(exc))
        return ApiError(str(exc), events=events)

    # ------------------------------------------------------------------ 图片识别与原始读取
    def recognize_image(self, raw: bytes, cancel_token: Optional[CancellationToken] = None) -> str:
        """把一张图片转成文字（不解题、不入库）。"""
        if not isinstance(raw, (bytes, bytearray)) or not raw:
            raise ApiError("请提供图片字节。")
        if len(raw) > MAX_IMAGE_BYTES:
            raise ApiError("图片超过 8 MB，请压缩后重试。")
        try:
            return self._reader().read(bytes(raw), cancel_token=cancel_token)
        except ValueError as exc:
            raise ApiError(str(exc)) from exc
        except ModelError as exc:
            raise ModelFailure(str(exc)) from exc
        except OSError as exc:
            raise ModelFailure(f"图片识别未完成：{exc}") from exc

    def prepare_image(self, raw: bytes) -> str:
        """校验并规范化图片，返回 data URL（可直接用于前端预览或再次上传）。"""
        try:
            return prepare_image(bytes(raw))
        except ValueError as exc:
            raise ApiError(str(exc)) from exc

    def read_documents(self, files, page_range: str = "", include_images: bool = True,
                       cancel_token: Optional[CancellationToken] = None) -> Dict[str, Any]:
        """读取一批文件（werkzeug FileStorage 或能提供 filename/read 的对象）。"""
        token = cancel_token or CancellationToken()
        try:
            return DocumentReader(self._reader, prefer_visual=False).read(
                list(files), page_range, token, include_images=include_images)
        except ValueError as exc:
            raise ApiError(str(exc)) from exc
        except ModelError as exc:
            raise ModelFailure(str(exc)) from exc
        except OSError as exc:
            raise ModelFailure(f"资料读取失败：{exc}") from exc

    def capture_materials(self, files, page_range: str = "", max_pages: int = 20,
                          cancel_token: Optional[CancellationToken] = None) -> Dict[str, Any]:
        """把文件转成“原页图像 + 版面标签”（供视觉模型拆题），不写库。"""
        token = cancel_token or CancellationToken()
        try:
            return capture_materials(list(files), page_range, max_pages=max_pages, token=token)
        except ValueError as exc:
            raise ApiError(str(exc)) from exc
        except OSError as exc:
            raise ApiError(f"原页采集失败：{exc}") from exc

    # ------------------------------------------------------------------ 资料整理（同步）
    def parse_material_text(self, text: str, cancel_token: Optional[CancellationToken] = None) -> Dict[str, Any]:
        """把一段资料文字同步拆成题目预览（不入库）。"""
        if not isinstance(text, str) or not text.strip() or len(text) > 80000:
            raise ApiError("请提供 1 到 80000 字的资料。")
        parser = self._make_parser()
        token = cancel_token or CancellationToken()
        try:
            parsed = parser.parse(text, cancel_token)
        except ValueError as exc:
            raise ApiError(str(exc)) from exc
        except ModelError as exc:
            raise ModelFailure(str(exc)) from exc
        return parsed

    def import_exercises(self, source: str, exercises, *, job_id: Optional[str] = None,
                         confirmed: bool = False) -> Dict[str, Any]:
        """确认入库题目（必须显式 confirmed=True，与网页一致）。"""
        if confirmed is not True:
            raise ApiError("题目需要由你核对并确认后才能入库（confirmed=True）。", status=409)
        provenance = None
        if job_id and self._jobs is not None:
            try:
                detail = self._jobs.get("local", job_id)
            except KeyError as exc:
                raise NotFoundError("原批次已过期或不存在。") from exc
            if detail.get("status") != "ready":
                raise ApiError("请等待该批次整理完成后再入库。")
            provenance = {**detail.get("metadata", {}), "source": detail.get("source", ""),
                          "submitted_at": detail.get("created_at")}
        try:
            return self.bank.add(source, exercises, provenance)
        except ValueError as exc:
            raise ApiError(str(exc)) from exc
        except OSError as exc:
            raise DataFileError(str(exc)) from exc

    def organize_exercises(self, items, paper: Optional[str] = None, tags: Optional[list] = None,
                           confirmed: bool = False) -> Dict[str, Any]:
        """批量设置试卷归属与细题型（带 revision 乐观锁）。"""
        if confirmed is not True:
            raise ApiError("请核对归属和标签后确认（confirmed=True）。", status=409)
        try:
            return self.bank.organize(items, paper, clean_tags(tags) if tags is not None else None)
        except ValueError as exc:
            raise ApiError(str(exc), status=409) from exc

    def update_exercise(self, identity: str, source: str, item: Dict[str, Any], revision: str,
                        confirmed: bool = False) -> Dict[str, Any]:
        """修改一道题：必须带 confirmed=True 与当前 revision。"""
        if confirmed is not True:
            raise ApiError("请核对并确认题目后再保存（confirmed=True）。", status=409)
        # 保存期间的字段（id/created_at/provenance 等）不是题目本身，先剔除再校验
        payload = {key: value for key, value in dict(item).items()
                   if key in {"number", "topic", "question", "answer", "page_index", "paper", "tags",
                              "answer_page_indices", "source_anchor", "origin_regions"}}
        try:
            return self.bank.update(identity, source, payload, revision)
        except ValueError as exc:
            raise ApiError(str(exc), status=409) from exc

    def _make_parser(self) -> MaterialParser:
        vocabulary = [tag for item in self.bank.read() for tag in item.get("tags", [])]
        return MaterialParser(self._material_client(), vocabulary)

    # ------------------------------------------------------------------ 资料整理（后台任务）
    def submit_material_job(self, source: str, text: str = "", documents=None,
                            metadata: Optional[Dict[str, Any]] = None,
                            source_files=None) -> MaterialJobResult:
        """提交后台整理任务（立即返回，用 wait_material_job 轮询）。"""
        jobs = self._job_queue()
        try:
            job = jobs.submit("local", text, source, documents, metadata, source_files)
        except ValueError as exc:
            raise ApiError(str(exc)) from exc
        return MaterialJobResult.from_job(jobs.get("local", job["id"]))

    def get_material_job(self, job_id: str) -> MaterialJobResult:
        jobs = self._job_queue()
        try:
            return MaterialJobResult.from_job(jobs.get("local", job_id))
        except KeyError as exc:
            raise NotFoundError("这项任务不存在或已过期。") from exc

    def list_material_jobs(self) -> List[MaterialJobResult]:
        return [MaterialJobResult.from_job(item) for item in self._job_queue().list("local")]

    def cancel_material_job(self, job_id: str) -> MaterialJobResult:
        try:
            return MaterialJobResult.from_job(self._job_queue().cancel("local", job_id))
        except KeyError as exc:
            raise NotFoundError("这项任务不存在或已过期。") from exc

    def retry_material_job(self, job_id: str) -> MaterialJobResult:
        try:
            return MaterialJobResult.from_job(self._job_queue().retry("local", job_id))
        except KeyError as exc:
            raise NotFoundError("这项任务不存在或已过期。") from exc
        except ValueError as exc:
            raise ApiError(str(exc), status=409) from exc

    def remove_material_job(self, job_id: str) -> None:
        try:
            self._job_queue().remove("local", job_id)
        except KeyError as exc:
            raise NotFoundError("这项任务不存在或已过期。") from exc
        except ValueError as exc:
            raise ApiError(str(exc), status=409) from exc

    def wait_material_job(self, job_id: str, timeout: float = 600.0, interval: float = 1.0) -> MaterialJobResult:
        """阻塞轮询直到任务结束（或超时抛 ApiError）。"""
        deadline = time.monotonic() + float(timeout)
        while True:
            job = self.get_material_job(job_id)
            if job.finished:
                return job
            if time.monotonic() > deadline:
                raise ApiError(f"等待整理任务超时（{timeout} 秒），任务仍在后台运行。")
            time.sleep(interval)

    def _job_queue(self) -> MaterialJobs:
        if self._jobs is None:
            self._jobs = MaterialJobs(self._make_parser, workers=2, make_visual_parser=self._make_parser)
        return self._jobs

    # ------------------------------------------------------------------ 生命周期
    def reset(self) -> None:
        """清空对话上下文与待确认方案（不删除任何已保存记录）。"""
        with self._lock:
            self._agents.clear()
            self._proposals.clear()

    def close(self) -> None:
        """释放本机 OCR 运行时与后台线程（可重复调用）。"""
        if self._closed:
            return
        self._closed = True
        if self._jobs is not None:
            with self._jobs.condition:
                for job in self._jobs.jobs.values():
                    job["token"].cancel()
        if self._local_runtime is not None:
            self._local_runtime.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()
        return False
