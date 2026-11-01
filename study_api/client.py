"""前端调用层：用标准库访问本机 HTTP 服务（与网页完全相同的接口）。

用途：
- 把已启动的 `python web.py` 当成“后端 SaaS”，从 Python（或其他语言的等价实现）调用；
- 与网页共享同一个 Cookie 会话模型，便于集成到现有 UI。

示例::

    with HttpApiClient("http://127.0.0.1:8765") as api:
        api.status()
        api.chat("你好")
"""

import json
import mimetypes
import os
import uuid
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from pathlib import Path
from typing import Any, Dict, Iterable, Optional, Tuple

from .errors import ApiError, CancelledError, ConfigurationError, DataFileError, ModelFailure, NotFoundError

_ERRORS = {400: ApiError, 404: NotFoundError, 409: ApiError, 413: ApiError, 499: CancelledError,
           500: DataFileError, 502: ModelFailure, 503: ApiError}


class _Response:
    """把 HTTP 状态、正文与是否需要 cookie 回放统一起来。"""

    def __init__(self, status: int, headers, body: bytes):
        self.status = status
        self.headers = headers
        self.body = body

    def json(self):
        return json.loads(self.body.decode("utf-8")) if self.body else {}


class HttpApiClient:
    """本机服务的 HTTP 客户端（自动保存并回放会话 Cookie）。"""

    def __init__(self, base_url: str = "http://127.0.0.1:8765", timeout: float = 120.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))

    # ------------------------------------------------------------------ 底层请求
    def request(self, method: str, path: str, *, json_body: Any = None,
                form: Optional[Dict[str, Any]] = None, raw: bool = False) -> Tuple[int, Any]:
        """发送请求；返回 (状态码, 解析后的 JSON 或原始字节)。"""
        url = self.base_url + path
        data = None
        headers = {}
        if json_body is not None:
            data = json.dumps(json_body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        elif form is not None:
            data, content_type = _encode_form(form)
            headers["Content-Type"] = content_type
        request = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                body = response.read()
                status = response.status
        except urllib.error.HTTPError as error:
            body = error.read()
            status = error.code
            return self._finish(status, body, raw)
        return self._finish(status, body, raw)

    def _finish(self, status: int, body: bytes, raw: bool):
        if raw and 200 <= status < 300:
            return status, body
        try:
            payload = json.loads(body.decode("utf-8")) if body else {}
        except ValueError:
            raise ApiError(f"服务返回了无法解析的内容（HTTP {status}）。", status=status) from None
        if status >= 400 or payload.get("ok") is False:
            self._raise(status, payload)
        return status, payload

    @staticmethod
    def _raise(status: int, payload: Dict[str, Any]):
        message = payload.get("error") or f"请求失败（HTTP {status}）。"
        events = payload.get("events") or []
        error_type = _ERRORS.get(status, ApiError)
        if error_type is CancelledError:
            raise CancelledError(message, context_retained=bool(payload.get("context_retained")),
                                 events=events)
        raise error_type(message, status=status, events=events)

    # ------------------------------------------------------------------ 系统
    def status(self) -> Dict[str, Any]:
        return self.request("GET", "/api/status")[1]

    def settings(self) -> Dict[str, Any]:
        return self.request("GET", "/api/settings")[1]["settings"]

    def save_settings(self, **values) -> Dict[str, Any]:
        return self.request("POST", "/api/settings", json_body=values)[1]["settings"]

    def switch_model(self, model: str) -> Dict[str, Any]:
        return self.request("POST", "/api/settings/model", json_body={"model": model})[1]["settings"]

    def test_connection(self, **values) -> str:
        return self.request("POST", "/api/settings/test", json_body=values)[1].get("message", "")

    def prompts(self) -> Dict[str, str]:
        return self.request("GET", "/api/prompts")[1]["prompts"]

    def operation(self, request_id: str) -> Dict[str, Any]:
        return self.request("GET", "/api/operation?request_id=" + urllib.request.quote(request_id, safe=""))[1]

    def cancel(self, request_id: Optional[str] = None, steer: bool = False) -> Dict[str, Any]:
        body = {"steer": steer}
        if request_id is not None:
            body["request_id"] = request_id
        return self.request("POST", "/api/cancel", json_body=body)[1]

    def reset(self) -> Dict[str, Any]:
        return self.request("POST", "/api/reset")[1]

    # ------------------------------------------------------------------ 对话
    def chat(self, message: str, **options) -> Dict[str, Any]:
        """与 /api/chat 等价；options 直接透传（view、scope、intent、topic、image_ids…）。"""
        payload = {"message": message, "request_id": options.pop("request_id", None) or str(uuid.uuid4())}
        payload.update(options)
        return self.request("POST", "/api/chat", json_body=payload)[1]

    def upload_review_images(self, paths: Iterable[str], request_id: Optional[str] = None) -> Dict[str, Any]:
        files = [Path(item) for item in paths]
        form = {"view": "review", "files": files}
        if request_id:
            form["request_id"] = request_id
        return self.request("POST", "/api/chat/attachments", form=form)[1]

    # ------------------------------------------------------------------ 读取原稿
    def read_intake(self, paths: Iterable[str], page_range: str = "",
                    keep_image_ids: Optional[list] = None, request_id: Optional[str] = None) -> Dict[str, Any]:
        form = {"files": [Path(item) for item in paths], "page_range": page_range}
        if keep_image_ids:
            form["keep_image_ids"] = json.dumps(keep_image_ids, ensure_ascii=False)
        if request_id:
            form["request_id"] = request_id
        return self.request("POST", "/api/intake/read", form=form)[1]

    def read_note_source(self, path: str, request_id: Optional[str] = None) -> Dict[str, Any]:
        form = {"file": Path(path)}
        if request_id:
            form["request_id"] = request_id
        return self.request("POST", "/api/notes/read", form=form)[1]

    def recognize_image(self, path: str, request_id: Optional[str] = None) -> str:
        form = {"image": Path(path)}
        if request_id:
            form["request_id"] = request_id
        return self.request("POST", "/api/ocr", form=form)[1]["text"]

    def set_ocr_backend(self, backend: str) -> Dict[str, Any]:
        return self.request("POST", "/api/ocr/backend", json_body={"backend": backend})[1]

    # ------------------------------------------------------------------ 笔记 / 错题 / 题库
    def notes(self) -> Dict[str, Any]:
        return self.request("GET", "/api/notes")[1]

    def download_note(self, note_id: str, kind: str = "md") -> bytes:
        return self.request("GET", f"/api/notes/{note_id}/download/{kind}", raw=True)[1]

    def export_note(self, note_id: str, request_id: Optional[str] = None) -> Dict[str, Any]:
        return self.request("POST", f"/api/notes/{note_id}/export",
                            json_body={"request_id": request_id} if request_id else {})[1]

    def mistakes(self) -> Dict[str, Any]:
        return self.request("GET", "/api/mistakes")[1]["data"]

    def exercises(self) -> Dict[str, Any]:
        return self.request("GET", "/api/exercises")[1]

    def import_exercises(self, source: str, exercises: list, *, confirmed: bool = True,
                         job_id: Optional[str] = None) -> Dict[str, Any]:
        body = {"source": source, "exercises": exercises, "confirmed": confirmed}
        if job_id:
            body["job_id"] = job_id
        return self.request("POST", "/api/exercises", json_body=body)[1]["data"]

    def organize_exercises(self, items: list, *, paper: Optional[str] = None,
                           tags: Optional[list] = None, confirmed: bool = True) -> Dict[str, Any]:
        return self.request("POST", "/api/exercises/organize",
                            json_body={"items": items, "paper": paper, "tags": tags, "confirmed": confirmed})[1]["data"]

    def update_exercise(self, identity: str, exercise: Dict[str, Any], revision: str,
                        *, source: str = "", confirmed: bool = True) -> Dict[str, Any]:
        return self.request("POST", f"/api/exercises/{identity}",
                            json_body={"exercise": exercise, "revision": revision, "source": source,
                                       "confirmed": confirmed})[1]

    # ------------------------------------------------------------------ 复习
    def review_catalog(self, source: str = "any") -> Dict[str, Any]:
        return self.request("GET", "/api/review/catalog?source=" + urllib.request.quote(source, safe=""))[1]

    def select_review(self, category: str = "", tag: str = "", source: str = "any",
                      request_id: Optional[str] = None) -> Dict[str, Any]:
        body = {"category": category, "tag": tag, "source": source}
        if request_id:
            body["request_id"] = request_id
        return self.request("POST", "/api/review/select", json_body=body)[1]

    # ------------------------------------------------------------------ 资料整理
    def submit_material_job(self, source: str, *, text: str = "", page_range: str = "",
                            files: Optional[Iterable[str]] = None) -> Dict[str, Any]:
        if files:
            form = {"source": source, "page_range": page_range, "files": [Path(item) for item in files]}
            return self.request("POST", "/api/materials/jobs", form=form)[1]["job"]
        return self.request("POST", "/api/materials/jobs",
                            json_body={"source": source, "text": text, "page_range": page_range})[1]["job"]

    def material_jobs(self) -> list:
        return self.request("GET", "/api/materials/jobs")[1]["jobs"]

    def material_job(self, job_id: str) -> Dict[str, Any]:
        return self.request("GET", f"/api/materials/jobs/{job_id}")[1]["job"]

    def material_job_action(self, job_id: str, action: str) -> Dict[str, Any]:
        return self.request("POST", f"/api/materials/jobs/{job_id}/{action}")[1]

    def material_page(self, job_id: str, index: int) -> bytes:
        return self.request("GET", f"/api/materials/jobs/{job_id}/pages/{index}", raw=True)[1]

    def material_text(self, paths: Iterable[str], page_range: str = "") -> Dict[str, Any]:
        return self.request("POST", "/api/materials/read",
                            form={"files": [Path(item) for item in paths], "page_range": page_range})[1]

    def parse_material(self, text: str, request_id: Optional[str] = None) -> Dict[str, Any]:
        body = {"text": text}
        if request_id:
            body["request_id"] = request_id
        return self.request("POST", "/api/materials/parse", json_body=body)[1]

    def revise_material(self, exercises: list, instruction: str, **options) -> Dict[str, Any]:
        body = {"exercises": exercises, "instruction": instruction, **options}
        return self.request("POST", "/api/materials/revise", json_body=body)[1]

    # ------------------------------------------------------------------ 跨库操作
    def preview_delete(self, items: Iterable[Dict[str, str]]) -> Dict[str, Any]:
        return self.request("POST", "/api/library/delete-preview", json_body={"items": list(items)})[1]["proposal"]

    def confirm(self, proposal_id: str, *, remove_source_notes: bool = False,
                note: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        body = {"proposal_id": proposal_id, "confirmed": True, "remove_source_notes": remove_source_notes}
        if note:
            body["note"] = note
        return self.request("POST", "/api/library/confirm", json_body=body)[1]["data"]

    def export_collection(self, items: Iterable[Dict[str, str]], fmt: str = "md") -> bytes:
        return self.request("POST", "/api/library/export",
                            json_body={"items": list(items), "format": fmt}, raw=True)[1]

    # ------------------------------------------------------------------ 文件预览
    def upload_preview(self, path: str) -> Dict[str, Any]:
        return self.request("POST", "/api/files/preview", form={"file": Path(path)})[1]["document"]

    def preview_page(self, document_id: str, page: int) -> bytes:
        return self.request("GET", f"/api/files/preview/{document_id}/{page}", raw=True)[1]

    # ------------------------------------------------------------------ 生命周期
    def close(self):
        self._opener.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()
        return False


def _encode_form(fields: Dict[str, Any]) -> Tuple[bytes, str]:
    """把 {name: value|Path|list} 编码成 multipart/form-data（仅用标准库）。"""
    boundary = "----study-api-" + uuid.uuid4().hex
    chunks = []

    def add_field(name: str, value: Any):
        chunks.append(("--" + boundary + "\r\n").encode())
        chunks.append((f'Content-Disposition: form-data; name="{name}"\r\n\r\n').encode())
        chunks.append(str(value).encode("utf-8"))
        chunks.append(b"\r\n")

    def add_file(name: str, path: Path):
        filename = path.name
        mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        chunks.append(("--" + boundary + "\r\n").encode())
        chunks.append((f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n').encode())
        chunks.append((f"Content-Type: {mime}\r\n\r\n").encode())
        chunks.append(Path(path).read_bytes())
        chunks.append(b"\r\n")

    for name, value in fields.items():
        if value is None:
            continue
        if isinstance(value, (list, tuple)):
            for item in value:
                if isinstance(item, (str, os.PathLike)):
                    add_file(name, Path(item))
                else:
                    add_field(name, item)
        elif isinstance(value, (str, os.PathLike)):
            add_file(name, Path(value))
        else:
            add_field(name, value)
    chunks.append(("--" + boundary + "--\r\n").encode())
    return b"".join(chunks), "multipart/form-data; boundary=" + boundary
