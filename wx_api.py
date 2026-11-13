"""微信小程序接入层：在现有核心之上提供鉴权、按用户隔离与异步任务的 JSON API。

与 web.py 的区别，也正是接小程序必须补的四件事：

* 没有浏览器 Cookie —— 改为 ``wx.login`` 的 code 换 openid，再签发 Bearer token；
* 一台手机一个用户 —— 每个 openid 一个数据目录，notes.json / mistakes.json 与网页版完全兼容；
* 小程序请求会超时 —— 对话改为 202 + 任务轮询，长任务不再依赖单次请求存活；
* 模型 API Key 只在服务端 —— 小程序永远不接触密钥，也不直连第三方模型。

运行： ``python wx_api.py --port 8766``（开发用），生产见 WECHAT_MINIPROGRAM.md。
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import hmac
import json
import logging
import os
import secrets
import shutil
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from flask import Flask, g, jsonify, request

from agent import StudyAgent
from cancellation import CancellationToken, OperationCancelled
from document_input import MAX_BATCH_BYTES, MAX_TEXT
from llm import ModelClient, ModelError
from material_sources import bounded_upload_image, capture_materials
from review_progress import ERROR_TYPES
from settings import SettingsStore, load_user_environment
from tools import LocalTools
from wx_security import ContentSecurity

LOG = logging.getLogger("wx_api")

ROOT = Path(__file__).resolve().parent
MAX_IMAGES = 4
# 云托管走 JSON 传图：小程序端先压缩，这里再兜一次上限，避免超大 body 打满实例内存。
MAX_BASE64_IMAGE_BYTES = 4 * 1024 * 1024
MAX_BASE64_CHARS = MAX_BASE64_IMAGE_BYTES * 4 // 3 + 16
MAX_BASE64_BODY = 20 * 1024 * 1024
VIEWS = ("organize", "notes", "review")
SCOPES = ("current", "history")


# ---------------------------------------------------------------- 配置


def _read_secret(path: Path) -> bytes:
    """本地没有密钥文件时生成一个，保证重启后已登录的 token 仍然有效。"""
    if path.exists():
        value = path.read_bytes().strip()
        if value:
            return value
    path.parent.mkdir(parents=True, exist_ok=True)
    value = secrets.token_urlsafe(48).encode()
    temporary = path.with_suffix(".tmp")
    temporary.write_bytes(value)
    try:
        os.chmod(temporary, 0o600)
    except OSError:
        pass
    os.replace(temporary, path)
    return value


@dataclass
class ApiConfig:
    data_dir: Path
    appid: str = ""
    secret: str = ""
    dev_login: bool = False
    trust_cloud_header: bool = False
    content_check: bool = False
    token_secret: bytes = b""
    token_ttl: int = 7 * 24 * 3600
    max_users: int = 500
    task_ttl: int = 1800
    user_idle: int = 2 * 3600

    @classmethod
    def from_env(cls, data_dir=None) -> "ApiConfig":
        directory = Path(data_dir or os.getenv("WX_API_DATA_DIR") or ROOT / "wx-data").resolve()
        directory.mkdir(parents=True, exist_ok=True)
        secret = os.getenv("WX_TOKEN_SECRET", "").strip()
        return cls(
            data_dir=directory,
            appid=os.getenv("WX_APPID", "").strip(),
            secret=os.getenv("WX_SECRET", "").strip(),
            dev_login=os.getenv("WX_DEV_LOGIN", "") in ("1", "true", "yes"),
            trust_cloud_header=os.getenv("WX_TRUST_CLOUD_HEADER", "") in ("1", "true", "yes"),
            content_check=os.getenv("WX_CONTENT_CHECK", "") in ("1", "true", "yes"),
            token_secret=secret.encode() if secret else _read_secret(directory / ".token-secret"),
            token_ttl=int(os.getenv("WX_TOKEN_TTL_DAYS", "7") or 7) * 24 * 3600,
            max_users=int(os.getenv("WX_MAX_USERS", "500") or 500),
        )


# ---------------------------------------------------------------- 登录态


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def user_key(openid: str) -> str:
    """目录名用 openid 的摘要，避免把微信标识直接写进文件路径。"""
    return hashlib.sha256(openid.encode("utf-8")).hexdigest()[:32]


def issue_token(key: str, secret: bytes, ttl: int) -> tuple[str, int]:
    expires = int(time.time()) + ttl
    body = _b64(json.dumps({"uid": key, "exp": expires}, separators=(",", ":")).encode())
    signature = _b64(hmac.new(secret, body.encode("ascii"), hashlib.sha256).digest())
    return f"{body}.{signature}", expires


def read_token(token: str, secret: bytes) -> str | None:
    if not isinstance(token, str) or token.count(".") != 1:
        return None
    body, signature = token.split(".", 1)
    try:
        expected = _b64(hmac.new(secret, body.encode("ascii"), hashlib.sha256).digest())
        if not hmac.compare_digest(signature, expected):
            return None
        payload = json.loads(_unb64(body))
    except (ValueError, TypeError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict) or not isinstance(payload.get("uid"), str):
        return None
    if not isinstance(payload.get("exp"), int) or payload["exp"] < time.time():
        return None
    return payload["uid"]


def code2session(config: ApiConfig, code: str) -> str:
    """用 wx.login 的 code 换 openid；session_key 目前用不到，不落盘。"""
    if not config.appid or not config.secret:
        raise ValueError("服务端尚未配置 WX_APPID / WX_SECRET，暂时不能使用微信登录。")
    query = urlencode({"appid": config.appid, "secret": config.secret,
                       "js_code": code, "grant_type": "authorization_code"})
    request_ = Request("https://api.weixin.qq.com/sns/jscode2session?" + query)
    try:
        with urlopen(request_, timeout=8) as response:
            data = json.load(response)
    except (URLError, TimeoutError, OSError):
        raise ValueError("暂时无法连接微信登录服务，请稍后重试。") from None
    except ValueError:
        raise ValueError("微信登录服务返回了无法解析的内容。") from None
    if not isinstance(data, dict):
        raise ValueError("微信登录服务返回了无法解析的内容。")
    if data.get("errcode"):
        code_number = data.get("errcode")
        if code_number == 40029:
            raise ValueError("登录凭证已失效，请重新进入小程序。")
        if code_number in (45011, 40226):
            raise ValueError("登录过于频繁，请稍后再试。")
        LOG.warning("jscode2session 失败 errcode=%s", code_number)
        raise ValueError("微信登录失败，请稍后重试。")
    openid = data.get("openid")
    if not isinstance(openid, str) or not openid:
        raise ValueError("微信登录没有返回用户标识。")
    return openid


# ---------------------------------------------------------------- 用户状态


class UserTools:
    """给 agent 的工具门面，补齐 web.py 里 LockedTools 提供的只读方法。

    小程序里每个用户有自己的数据目录，不需要网页版那把全局写锁。
    """

    supports_cancellation = True

    def __init__(self, local: LocalTools):
        self.local = local
        self.progress = local.progress

    def execute(self, name, arguments, cancel_token=None):
        return self.local.execute(name, arguments, cancel_token=cancel_token)

    def list_notes(self):
        return self.local._read("notes.json")

    def list_exercises(self):
        return self.local.bank.read()

    def list_mistakes(self):
        return self.local.get_mistakes(limit=None)

    def review_catalog(self):
        return self.local.review_catalog()


class UserState:
    """一个微信用户的内存状态；数据文件放在独立目录，进程重启后仍在。"""

    def __init__(self, key: str, directory: Path):
        self.key = key
        self.directory = directory
        directory.mkdir(parents=True, exist_ok=True)
        self.tools = UserTools(LocalTools(directory))
        self.profile = directory / "profile.json"
        self.lock = threading.Lock()
        self.busy = False
        self.agents: dict[str, StudyAgent] = {}
        self.images: dict[str, str] = {}
        self.image_order: list[str] = []
        self.last_seen = time.monotonic()

    def begin(self) -> bool:
        with self.lock:
            if self.busy:
                return False
            self.busy = True
            self.last_seen = time.monotonic()
            return True

    @property
    def openid(self) -> str:
        """内容安全接口需要真实 openid；它只存在服务端，不进 token。"""
        try:
            data = json.loads(self.profile.read_text(encoding="utf-8"))
            value = data.get("openid") if isinstance(data, dict) else None
            return value if isinstance(value, str) else ""
        except (OSError, ValueError):
            return ""

    def remember_openid(self, openid: str) -> None:
        if not openid or self.openid:
            return
        temporary = self.profile.with_suffix(".tmp")
        temporary.write_text(json.dumps({"openid": openid}, ensure_ascii=False), encoding="utf-8")
        try:
            os.chmod(temporary, 0o600)
        except OSError:
            pass
        os.replace(temporary, self.profile)

    def end(self) -> None:
        with self.lock:
            self.busy = False
            self.last_seen = time.monotonic()

    def add_images(self, images: dict[str, str]) -> list[str]:
        with self.lock:
            for identity in images:
                self.image_order.append(identity)
            self.images.update(images)
            while len(self.image_order) > 20:
                dropped = self.image_order.pop(0)
                self.images.pop(dropped, None)
            return list(images)

    def reset(self) -> None:
        with self.lock:
            self.agents.clear()
            self.images.clear()
            self.image_order.clear()


class Registry:
    def __init__(self, config: ApiConfig):
        self.config = config
        self.lock = threading.Lock()
        self.users: dict[str, UserState] = {}

    def get(self, key: str, openid: str = "") -> UserState:
        with self.lock:
            self._evict()
            state = self.users.get(key)
            if state is None:
                if len(self.users) >= self.config.max_users:
                    raise ModelError("当前使用人数较多，请稍后再试。")
                state = UserState(key, self.config.data_dir / "users" / key)
                self.users[key] = state
            state.last_seen = time.monotonic()
        if openid:
            state.remember_openid(openid)
        return state

    def drop(self, key: str) -> UserState | None:
        """把用户从内存里摘掉，返回原状态，供删除目录时使用。"""
        with self.lock:
            return self.users.pop(key, None)

    def _evict(self) -> None:
        now = time.monotonic()
        for key, state in list(self.users.items()):
            if not state.busy and now - state.last_seen > self.config.user_idle:
                del self.users[key]


class TaskStore:
    """进程内任务表。

    只适用于单进程多线程部署（gunicorn -w 1 --threads N）。要多进程或多机，
    把这里换成 Redis / 数据库，接口保持不变即可。
    """

    def __init__(self, ttl: int):
        self.ttl = ttl
        self.lock = threading.Lock()
        self.items: dict[str, dict] = {}

    def start(self, key: str, request_id: str | None, kind: str) -> dict:
        with self.lock:
            self._prune()
            task = {"id": secrets.token_urlsafe(18), "uid": key, "request_id": request_id,
                    "kind": kind, "status": "running", "progress": {}, "answer": None,
                    "steps": [], "error": None, "error_code": None, "payload": {},
                    "created": time.time(), "finished": None, "token": CancellationToken()}
            self.items[task["id"]] = task
            return task

    def get(self, task_id: str, key: str) -> dict | None:
        with self.lock:
            task = self.items.get(task_id)
            if task is None or task["uid"] != key:
                return None
            return task

    def by_request(self, key: str, request_id: str | None) -> dict | None:
        if not request_id:
            return None
        with self.lock:
            for task in self.items.values():
                if task["uid"] == key and task["request_id"] == request_id:
                    return task
        return None

    def running(self, key: str) -> dict | None:
        with self.lock:
            for task in self.items.values():
                if task["uid"] == key and task["status"] == "running":
                    return task
        return None

    def finish(self, task: dict, status: str, **fields) -> None:
        with self.lock:
            task.update(fields)
            task["status"] = status
            task["finished"] = time.time()

    def _prune(self) -> None:
        now = time.time()
        for task_id, task in list(self.items.items()):
            if task["finished"] and now - task["finished"] > self.ttl:
                del self.items[task_id]


def public_task(task: dict) -> dict:
    return {"ok": True, "task_id": task["id"], "status": task["status"],
            "progress": dict(task["progress"]), "steps": list(task["steps"]),
            "answer": task["answer"], "error": task["error"], "error_code": task["error_code"],
            "cancelled": task["status"] == "cancelled",
            "created_at": int(task["created"]), **task["payload"]}


# ---------------------------------------------------------------- 应用


def create_api(config: ApiConfig | None = None, client_factory=None,
               settings_path=None, upload_handler=None) -> Flask:
    """建小程序 API。client_factory 只用于测试；生产从服务端环境变量读模型配置。"""
    config = config or ApiConfig.from_env()
    load_user_environment()
    settings = SettingsStore(settings_path or config.data_dir / ".model-settings.json")
    registry = Registry(config)
    tasks = TaskStore(config.task_ttl)
    security = ContentSecurity(config.appid, config.secret, config.content_check)

    app = Flask(__name__)
    app.config.update(JSON_AS_ASCII=False, MAX_CONTENT_LENGTH=MAX_BATCH_BYTES + 1024 * 1024)
    app.extensions["wx_config"] = config
    app.extensions["wx_registry"] = registry
    app.extensions["wx_tasks"] = tasks

    def error(message: str, status: int = 400, **extra):
        return jsonify({"ok": False, "error": message, **extra}), status

    def public_settings() -> dict:
        try:
            return settings.public()
        except ValueError as exc:
            LOG.warning("模型配置无法读取：%s", type(exc).__name__)
            return {"configured": False}

    def make_client(ocr: bool = False):
        if client_factory:
            return client_factory()
        values = settings.resolve()
        prefix = "ocr_" if ocr else ""
        return ModelClient(values[prefix + "base_url"], values[prefix + "api_key"],
                           values[prefix + "model"], timeout=120)

    # ---- 鉴权 ----

    def authenticate() -> tuple[str, str] | None:
        header = request.headers.get("Authorization", "")
        token = header[7:].strip() if header.lower().startswith("bearer ") else ""
        if token:
            key = read_token(token, config.token_secret)
            return (key, "") if key else None
        if config.trust_cloud_header:
            # 微信云托管的请求由平台注入，小程序伪造不了这个头。
            openid = request.headers.get("X-WX-OPENID", "").strip()
            if openid:
                return user_key(openid), openid
        return None

    def require_user(view):
        def wrapper(*args, **kwargs):
            found = authenticate()
            if not found:
                return error("登录已过期，请重新进入小程序。", 401)
            g.uid, g.openid = found
            return view(*args, **kwargs)
        wrapper.__name__ = view.__name__
        return wrapper

    @app.after_request
    def headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Cache-Control"] = "no-store"
        return response

    # ---- 基础接口 ----

    @app.get("/healthz")
    def health():
        return jsonify({"ok": True, "service": "study-agent-wx", "time": int(time.time())})

    @app.post("/api/v1/auth/login")
    def login():
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return error("请提交 wx.login 得到的 code。")
        code = payload.get("code")
        if not isinstance(code, str) or not 1 <= len(code) <= 256:
            return error("登录凭证格式有误。")
        openid = None
        if config.dev_login and code.startswith("dev:"):
            # 只在本地调试打开：WX_DEV_LOGIN=1，小程序里不用真实 appid 也能跑通。
            candidate = code[4:].strip()
            if candidate and all(char.isalnum() or char in "-_" for char in candidate):
                openid = "dev-" + candidate
        if openid is None:
            try:
                openid = code2session(config, code)
            except ValueError as exc:
                return error(str(exc), 401)
        key = user_key(openid)
        registry.get(key, openid)
        token, expires = issue_token(key, config.token_secret, config.token_ttl)
        return jsonify({"ok": True, "token": token, "expires_at": expires,
                        "user": {"id": key[:12]}})

    @app.get("/api/v1/status")
    @require_user
    def status():
        state = registry.get(g.uid, g.get("openid", ""))
        config_ = public_settings()
        try:
            mistakes = len(state.tools.list_mistakes().get("mistakes", []))
        except (ValueError, OSError):
            mistakes = 0
        return jsonify({"ok": True, "configured": bool(client_factory) or config_.get("configured", False),
                        "model": config_.get("model", ""), "mistakes": mistakes,
                        "views": list(VIEWS), "max_images": MAX_IMAGES,
                        "content_check": security.enabled,
                        "max_chars": MAX_TEXT})

    @app.get("/api/v1/me")
    @require_user
    def me():
        return jsonify({"ok": True, "user": {"id": g.uid[:12]}})

    # ---- 资料上传 ----

    @app.post("/api/v1/uploads")
    @require_user
    def uploads():
        files = request.files.getlist("files")
        if not 1 <= len(files) <= MAX_IMAGES:
            return error(f"请选择 1 到 {MAX_IMAGES} 张图片或 PDF 页。")
        state = registry.get(g.uid, g.get("openid", ""))
        if state.busy:
            return error("正在处理上一轮，请稍后再上传。", 409)
        token = CancellationToken()
        try:
            captured = (upload_handler or capture_materials)(files, max_pages=MAX_IMAGES, token=token)
        except OperationCancelled:
            return error("已取消上传。", 499)
        except (ValueError, OSError) as exc:
            return error(str(exc))
        images = {secrets.token_hex(12): document["image"] for document in captured["documents"]}
        if not images:
            return error("没有读到可用的图片，请换一张再试。")
        state.add_images(images)
        return jsonify({"ok": True, "image_ids": list(images),
                        "pages": [document.get("page") for document in captured["documents"]]})

    @app.post("/api/v1/uploads/base64")
    @require_user
    def uploads_base64():
        """云托管没有 multipart 通道：小程序把压缩后的图片按 base64 放进 JSON 提交。"""
        if request.content_length and request.content_length > MAX_BASE64_BODY:
            return error("这一批图片太大，请压缩或减少张数后重试。", 413)
        payload = request.get_json(silent=True)
        images = payload.get("images") if isinstance(payload, dict) else None
        if not isinstance(images, list) or not 1 <= len(images) <= MAX_IMAGES:
            return error(f"请提交 1 到 {MAX_IMAGES} 张图片。")
        state = registry.get(g.uid, g.get("openid", ""))
        if state.busy:
            return error("正在处理上一轮，请稍后再上传。", 409)
        stored = {}
        for item in images:
            if not isinstance(item, dict) or set(item) - {"data", "name"}:
                return error("图片格式有误，请重新选择。")
            encoded = item.get("data")
            if not isinstance(encoded, str) or not encoded or len(encoded) > MAX_BASE64_CHARS:
                return error("单张图片超过 4 MB，请压缩后重试。")
            if encoded.startswith("data:"):
                encoded = encoded.split(",", 1)[-1]
            try:
                raw = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error):
                return error("图片数据不完整，请重新选择。")
            if not raw:
                return error("图片内容为空，请重新选择。")
            try:
                stored[secrets.token_hex(12)] = bounded_upload_image(raw)
            except ValueError as exc:
                return error(str(exc))
        state.add_images(stored)
        return jsonify({"ok": True, "image_ids": list(stored)})

    # ---- 对话：提交 + 轮询 ----

    def chat_payload() -> tuple[dict | None, tuple | None]:
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return None, error("请提交有效的文字内容。")
        message = payload.get("message")
        if not isinstance(message, str) or not message.strip():
            return None, error("请输入要整理或提问的内容。")
        if len(message) > MAX_TEXT:
            return None, error(f"内容最多 {MAX_TEXT} 字，请分批提交。")
        view = payload.get("view", "organize")
        scope = payload.get("scope", "current")
        intent = payload.get("intent")
        if view not in VIEWS or scope not in SCOPES or intent not in (None, "practice"):
            return None, error("对话模式无效，请重新进入小程序。")
        topic = payload.get("topic")
        if topic is not None and (not isinstance(topic, str) or not topic.strip() or len(topic) > 120):
            return None, error("知识点格式有误。")
        exercise_id = payload.get("exercise_id")
        if exercise_id is not None and (not isinstance(exercise_id, str) or not exercise_id or len(exercise_id) > 64):
            return None, error("资料题号格式有误。")
        if not isinstance(payload.get("new_problem", False), bool):
            return None, error("题目状态无效。")
        image_ids = payload.get("image_ids", [])
        if (not isinstance(image_ids, list) or len(image_ids) > 20
                or any(not isinstance(item, str) or len(item) > 64 for item in image_ids)):
            return None, error("原稿图片信息无效。")
        if image_ids and view == "review":
            return None, error("小程序暂时只支持文字作答；作答照片请在网页版提交。")
        request_id = payload.get("request_id")
        if request_id is not None and (not isinstance(request_id, str) or not 8 <= len(request_id) <= 100):
            return None, error("请求编号格式有误。")
        return {"message": message.strip(), "view": view, "scope": scope, "intent": intent,
                "topic": topic, "exercise_id": exercise_id, "request_id": request_id,
                "new_problem": payload.get("new_problem", False), "image_ids": image_ids}, None

    def worker(task: dict, state: UserState, data: dict) -> None:
        token = task["token"]
        images = [state.images[item] for item in data["image_ids"] if item in state.images]
        try:
            token.report("正在准备这一轮…", phase="prepare")
            if data["new_problem"]:
                # 新题等于开新对话：丢掉这个视图的上下文，避免旧题条件串进来。
                state.agents.pop(data["view"], None)
            agent = state.agents.get(data["view"])
            if agent is None:
                agent = StudyAgent(None, state.tools)
                state.agents[data["view"]] = agent
            steps = task["steps"]
            agent.trace = lambda event, value: steps.append({
                "event": event,
                "name": value.get("name") if isinstance(value, dict) else None,
                "ok": value.get("ok") if isinstance(value, dict) else None})
            agent.client = make_client(ocr=bool(images))
            agent.web_links = True
            if data["exercise_id"]:
                selected = next((item for item in state.tools.list_exercises()
                                 if item["id"] == data["exercise_id"]), None)
                if selected is None:
                    raise ValueError("这道资料题不存在，请刷新题单后重新选择。")
                agent.current_topic = selected["topic"]
                agent.current_tags = selected.get("tags", [])
                data = {**data, "intent": "practice", "scope": "current"}
            answer = agent.run(data["message"], cancel_token=token, scope=data["scope"],
                               intent=data["intent"], topic=data["topic"],
                               exercise_id=data["exercise_id"], new_problem=data["new_problem"],
                               task="notes" if data["view"] == "notes" else "review" if data["view"] == "review" else "mixed",
                               images=images)
            tasks.finish(task, "done", answer=answer,
                         payload={"current_question": agent.current_question,
                                  **({"review": agent.review_snapshot()} if data["view"] == "review" else {})})
        except OperationCancelled as exc:
            tasks.finish(task, "cancelled", error=str(exc), error_code="cancelled")
        except ModelError as exc:
            tasks.finish(task, "error", error_code="model_error",
                         error=f"{exc} 已保存的错题和笔记不受影响。")
        except (ValueError, OSError, TypeError, KeyError):
            LOG.exception("任务处理失败 task=%s", task["id"])
            tasks.finish(task, "error", error_code="internal",
                         error="本轮没有完成，已保存的内容仍然保留，请稍后重试。")
        except Exception:  # 兜底：绝不把堆栈或密钥回给客户端
            LOG.exception("未预期的任务错误 task=%s", task["id"])
            tasks.finish(task, "error", error_code="internal", error="服务暂时不可用，请稍后重试。")
        finally:
            task["token"].on_progress = None
            state.end()

    @app.post("/api/v1/chat")
    @require_user
    def chat():
        data, failure = chat_payload()
        if failure:
            return failure
        state = registry.get(g.uid, g.get("openid", ""))
        request_id = (data["request_id"] or request.headers.get("X-Request-Id")
                      or request.args.get("request_id"))
        if request_id is not None and (not isinstance(request_id, str) or not 8 <= len(request_id) <= 100):
            return error("请求编号格式有误。")
        existing = tasks.by_request(g.uid, request_id)
        if existing:
            # 网络重试或小程序重进页面时，不要重复跑同一轮模型调用。
            return jsonify(public_task(existing)), 202 if existing["status"] == "running" else 200
        missing = [item for item in data["image_ids"] if item not in state.images]
        if missing:
            return error("图片已过期，请重新上传；输入的文字仍然保留。", 409)
        allowed, notice = security.check_text(g.openid or state.openid, data["message"])
        if not allowed:
            return error(notice, 400)
        if not state.begin():
            running = tasks.running(g.uid)
            return error("上一条还在处理中，请稍等或先停止。", 409,
                         task_id=running["id"] if running else None)
        try:
            task = tasks.start(g.uid, request_id, data["view"])
        except Exception:
            state.end()
            raise
        task["token"].on_progress = lambda progress: task.__setitem__("progress", dict(progress))
        try:
            threading.Thread(target=worker, args=(task, state, data), daemon=True,
                             name="wx-chat").start()
        except Exception:
            tasks.finish(task, "error", error_code="internal", error="服务暂时不可用，请稍后重试。")
            state.end()
            LOG.exception("任务线程启动失败")
        return jsonify(public_task(task)), 202

    @app.get("/api/v1/tasks/<task_id>")
    @require_user
    def task_status(task_id):
        task = tasks.get(task_id, g.uid)
        if task is None:
            return error("这个任务不存在或已过期，请重新提交。", 404)
        return jsonify(public_task(task))

    @app.post("/api/v1/tasks/<task_id>/cancel")
    @require_user
    def cancel(task_id):
        task = tasks.get(task_id, g.uid)
        if task is None:
            return error("这个任务不存在或已过期。", 404)
        task["token"].cancel()
        return jsonify({"ok": True, "task_id": task_id})

    @app.post("/api/v1/conversation/reset")
    @require_user
    def reset_conversation():
        state = registry.get(g.uid, g.get("openid", ""))
        if state.busy:
            return error("正在处理上一轮，请先停止。", 409)
        state.reset()
        return jsonify({"ok": True})

    @app.post("/api/v1/account/delete")
    @require_user
    def delete_account():
        """删除这个微信用户的全部学习记录（《个人信息保护法》要求的删除途径）。"""
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict) or payload.get("confirm") is not True:
            return error("请先确认删除，本次没有改动任何数据。")
        state = registry.get(g.uid, g.get("openid", ""))
        if state.busy:
            return error("正在处理上一轮，请先去停止再删除。", 409)
        registry.drop(g.uid)
        shutil.rmtree(state.directory, ignore_errors=True)
        LOG.info("用户主动删除数据 uid=%s", g.uid[:12])
        return jsonify({"ok": True, "deleted": True})

    # ---- 复习 ----

    @app.get("/api/v1/review/catalog")
    @require_user
    def review_catalog():
        state = registry.get(g.uid, g.get("openid", ""))
        try:
            return jsonify({"ok": True, **state.tools.review_catalog().tree(
                request.args.get("source", "any"))})
        except (ValueError, OSError) as exc:
            return error(str(exc))

    @app.get("/api/v1/review/progress")
    @require_user
    def review_progress():
        state = registry.get(g.uid, g.get("openid", ""))
        agent = state.agents.get("review")
        snapshot = agent.review_snapshot() if agent else {
            "round_id": None, "seen_ids": [], "current_attempt": None, "selection": None}
        try:
            return jsonify({"ok": True, "review": snapshot, "progress": state.tools.progress.summary(),
                            "error_types": ERROR_TYPES})
        except (ValueError, OSError) as exc:
            return error(str(exc))

    @app.post("/api/v1/review/select")
    @require_user
    def select_question():
        """挑一道原题；只读本地题库，不调用模型，所以同步返回。"""
        from review_catalog import validate_filter
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict) or set(payload) - {"category", "tag", "source"}:
            return error("请选择知识点或细分标签。")
        try:
            selection = validate_filter(**{key: payload.get(key, default) for key, default in
                                           (("category", ""), ("tag", ""), ("source", "any"))})
        except ValueError as exc:
            return error(str(exc))
        state = registry.get(g.uid, g.get("openid", ""))
        if not state.begin():
            return error("正在处理上一轮，请稍等。", 409)
        token = CancellationToken()
        try:
            agent = StudyAgent(None, state.tools)
            previous = state.agents.get("review")
            if previous:
                agent.inherit_review_round(previous)
            answer = agent.start_review(selection, token)
            state.agents["review"] = agent
            return jsonify({"ok": True, "answer": answer, "selection": selection,
                            "current_question": agent.current_question,
                            "review": agent.review_snapshot(),
                            "question_selected": agent._last_pick_succeeded})
        except OperationCancelled as exc:
            return error(str(exc), 499)
        except (ValueError, OSError) as exc:
            return error(str(exc))
        finally:
            state.end()

    # ---- 记录 ----

    @app.get("/api/v1/notes")
    @require_user
    def notes():
        state = registry.get(g.uid, g.get("openid", ""))
        try:
            records = state.tools.list_notes()
        except (ValueError, OSError):
            return error("笔记暂时无法读取，已保存的文件没有被修改。", 500)
        items = [{"id": item["id"], "topic": item["topic"], "created_at": item.get("created_at", ""),
                  "chars": len(item["content"]),
                  "excerpt": item["content"].replace("\n", " ")[:120]} for item in reversed(records)]
        return jsonify({"ok": True, "notes": items, "total": len(items)})

    @app.get("/api/v1/notes/<note_id>")
    @require_user
    def note_detail(note_id):
        state = registry.get(g.uid, g.get("openid", ""))
        try:
            record = next((item for item in state.tools.list_notes() if item["id"] == note_id), None)
        except (ValueError, OSError):
            return error("笔记暂时无法读取。", 500)
        if record is None:
            return error("这份笔记不存在。", 404)
        return jsonify({"ok": True, "note": record})

    @app.get("/api/v1/mistakes")
    @require_user
    def mistakes():
        state = registry.get(g.uid, g.get("openid", ""))
        try:
            result = state.tools.list_mistakes()
        except (ValueError, OSError):
            return error("错题暂时无法读取，已保存的文件没有被修改。", 500)
        return jsonify({"ok": True, **result})

    @app.errorhandler(413)
    def too_large(_):
        return error("文件太大：单张图片 8 MB、整批 512 MB。", 413)

    @app.errorhandler(404)
    def not_found(_):
        return error("接口不存在，请确认小程序版本。", 404)

    @app.errorhandler(405)
    def bad_method(_):
        return error("请求方式不正确。", 405)

    @app.errorhandler(500)
    def server_error(_):
        LOG.exception("接口内部错误 path=%s", request.path)
        return error("服务暂时不可用，请稍后重试。", 500)

    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="知错 · 学习整理助手小程序 API")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--data-dir", default=None)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if not os.getenv("LLM_API_KEY"):
        LOG.warning("未设置 LLM_API_KEY，对话会以“未配置模型”失败；小程序首屏仍可登录。")
    app = create_api(ApiConfig.from_env(args.data_dir))
    LOG.info("小程序 API：http://%s:%s（生产必须走 HTTPS 域名）", args.host, args.port)
    app.run(host=args.host, port=args.port, debug=False, use_reloader=False, threaded=True)


if __name__ == "__main__":
    main()
