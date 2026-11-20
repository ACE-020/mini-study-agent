"""网页端历史对话、集合与会话附件的磁盘存储。

与 ``conversation_store.py`` 的分工：后者是小程序按视图（organize / notes /
review）保存的纯文本上下文，网页端从未使用，也不应被本模块改写。网页端的
organize 对话现在有自己的按浏览器会话隔离的存档：

* ``meta.json``：当前对话、创建顺序与集合；
* ``conversations/<id>.json``：消息、草稿、集合归属、附件元数据与页面 id；
* ``pages/<对话>/<页 id>.jpg``：聊天与“原稿”区实际使用的页面图（内部数据）；
* ``attachments/<对话>/<附件 id>.bin``：用户上传的原文件（图片 / PDF / TXT / MD），
  供“本对话文件”面板列目录、真实缩略图与预览。

所有 JSON 都先写临时文件再 ``os.replace``，失败不会留下半个文件；附件原文件
同样原子写入。接口层只拿 id，不接触任何本地路径，因此响应不会泄露磁盘位置。
旧版数据没有原文件的，元数据会如实标记为占位（``placeholder``），不伪造内容。
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import tempfile
import threading
from collections import OrderedDict
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageOps
import pymupdf

STORE_FOLDER = "web-history"
USER_COOKIE_MAX_AGE = 2 * 365 * 24 * 3600
THUMBNAIL_EDGE = 320

_ID = re.compile(r"^[A-Za-z0-9_-]{1,100}$")
_COOKIE = re.compile(r"^[A-Za-z0-9_-]{16,100}$")
MESSAGE_ROLES = ("user", "assistant", "error", "notice")
ATTACHMENT_KINDS = ("image", "pdf", "text")
_DEFAULT_MIME = {"image": "image/jpeg", "pdf": "application/pdf", "text": "text/plain"}
_ALLOWED_MIME = {
    "image": {"image/jpeg", "image/png", "image/webp", "application/octet-stream"},
    "pdf": {"application/pdf", "application/octet-stream"},
    "text": {"text/plain", "text/markdown", "application/octet-stream"},
}


def valid_user_token(value) -> bool:
    return isinstance(value, str) and bool(_COOKIE.fullmatch(value))


def cookie_names(directory) -> dict:
    """同一数据目录对应稳定的 Cookie 名，不同目录/实例彼此隔离。

    浏览器 Cookie 不按端口隔离，桌面版又用系统分配的动态端口，所以不能把端口
    写进名字；这里用数据目录路径的摘要（不含任何 sid 或密钥）生成稳定名字。
    网页源码版继续沿用 Flask 默认的 ``session``，桌面版用 ``session`` 这一项作为
    自己的 Flask 会话 Cookie 名。
    """
    digest = hashlib.sha256(os.path.normcase(str(Path(directory).resolve())).encode("utf-8")).hexdigest()[:16]
    return {"user": f"zhicuo_history_{digest}", "session": f"zhicuo_web_session_{digest}"}


def decode_data_url(value) -> bytes:
    """只接受图片 data URL；用于把内存里的原稿页落成文件。"""
    if not isinstance(value, str) or "," not in value:
        raise ValueError("原稿图片格式无效。")
    header, payload = value.split(",", 1)
    if not header.lower().startswith("data:image/"):
        raise ValueError("原稿图片格式无效。")
    try:
        raw = base64.b64decode(payload, validate=False)
    except (ValueError, TypeError):
        raise ValueError("原稿图片格式无效。") from None
    if not raw:
        raise ValueError("原稿图片为空。")
    return raw


def image_data_url(raw) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(raw).decode("ascii")


def safe_name(value, fallback="附件") -> str:
    """只保留展示用文件名：去掉目录、控制字符与 Windows 非法字符。"""
    name = str(value or "").replace("\\", "/").rsplit("/", 1)[-1]
    name = "".join(ch for ch in name if ch >= " " and ch not in '\x7f"<>:|?*').strip()
    return name[:180] or fallback


def _component(value) -> str:
    value = str(value or "")
    if _ID.fullmatch(value):
        return value
    return "x" + hashlib.sha256(value.encode("utf-8")).hexdigest()[:40]


def _atomic_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=".history-", dir=str(path.parent))
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def _atomic_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=".history-", dir=str(path.parent))
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _positive(value):
    return value if type(value) is int and value > 0 else None


def _timestamp(value):
    return value if isinstance(value, str) and value else ""


def _coerce_messages(value) -> list[dict]:
    messages = []
    for item in value if isinstance(value, list) else []:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        text = item.get("text")
        if text is None:
            # 旧版 conv_store / 早期实验数据用 content 保存纯文本。
            text = item.get("content")
        if role not in MESSAGE_ROLES or not isinstance(text, str) or not text:
            continue
        messages.append({"role": role, "text": text, "at": _timestamp(item.get("at"))})
    return messages


def _coerce_attachments(value):
    items = []
    if isinstance(value, dict):
        items = [{**entry, "id": key} for key, entry in value.items() if isinstance(entry, dict)]
    elif isinstance(value, list):
        items = [entry for entry in value if isinstance(entry, dict)]
    cleaned = []
    seen = set()
    for item in items:
        identity = item.get("id")
        if not isinstance(identity, str) or not identity or len(identity) > 100 or identity in seen:
            continue
        kind = item.get("kind") if item.get("kind") in ATTACHMENT_KINDS else "image"
        mime = item.get("mime")
        if not isinstance(mime, str) or mime not in _ALLOWED_MIME[kind]:
            mime = _DEFAULT_MIME[kind]
        cleaned.append({
            "id": identity,
            "kind": kind,
            "name": safe_name(item.get("name"), "旧记录附件"),
            "mime": mime,
            "size": item.get("size") if type(item.get("size")) is int and item["size"] >= 0 else 0,
            "page_count": _positive(item.get("page_count")),
            "width": _positive(item.get("width")),
            "height": _positive(item.get("height")),
            "created_at": _timestamp(item.get("created_at")),
            "available": bool(item.get("available", True)),
            "placeholder": bool(item.get("placeholder", False)),
            "legacy": bool(item.get("legacy", False)),
            "reason": str(item.get("reason"))[:200] if isinstance(item.get("reason"), str) else "",
        })
        seen.add(identity)
    return cleaned


def _coerce_meta(value) -> dict:
    if not isinstance(value, dict):
        return {"active": None, "order": [], "collections": []}
    collections = []
    seen = set()
    for item in value.get("collections") if isinstance(value.get("collections"), list) else []:
        if not isinstance(item, dict):
            continue
        identity = item.get("id")
        name = item.get("name")
        if not isinstance(identity, str) or not identity or identity in seen:
            continue
        if not isinstance(name, str) or not name.strip():
            continue
        seen.add(identity)
        collections.append({"id": identity, "name": safe_name(name.strip(), "集合"),
                            "created_at": _timestamp(item.get("created_at")),
                            "updated_at": _timestamp(item.get("updated_at"))})
    order = [item for item in value.get("order") if isinstance(item, str)] if isinstance(value.get("order"), list) else []
    active = value.get("active") if isinstance(value.get("active"), str) else None
    return {"active": active, "order": order, "collections": collections}


def describe_upload(path: Path, filename) -> dict:
    """根据原文件本身（而不是扩展名猜测）生成附件元数据。"""
    path = Path(path)
    name = safe_name(filename)
    suffix = Path(name).suffix.lower()
    size = path.stat().st_size
    base = {"kind": "image", "mime": "image/jpeg", "size": size, "name": name,
            "page_count": None, "width": None, "height": None}
    if suffix == ".pdf":
        base.update(kind="pdf", mime="application/pdf")
        try:
            with pymupdf.open(str(path)) as document:
                base["page_count"] = len(document)
        except Exception:
            base["mime"] = "application/octet-stream"
        return base
    if suffix in (".txt", ".md"):
        base.update(kind="text", mime="text/markdown" if suffix == ".md" else "text/plain")
        return base
    try:
        with Image.open(path) as source:
            source.load()
            image = ImageOps.exif_transpose(source)
            base["width"], base["height"] = image.size
            base["mime"] = Image.MIME.get(source.format or "", "image/jpeg")
    except Exception:
        base["mime"] = "application/octet-stream"
    return base


class UploadRecorder:
    """边读取上传流边留一份原件；只有整批成功后才由调用方提交。

    读取失败或用户停止时临时目录整体删除，不会在历史目录里留下半个附件，
    也不会改动此前已经接受的附件。
    """

    def __init__(self, files):
        self.folder = tempfile.TemporaryDirectory(prefix="study-attachment-")
        self.entries = []
        self.files = []
        self._closed = False
        try:
            for index, upload in enumerate(files):
                path = Path(self.folder.name) / f"upload-{index}.bin"
                handle = path.open("wb")
                wrapper = _TeeUpload(upload, handle)
                self.entries.append({"path": path, "handle": handle, "upload": wrapper})
                self.files.append(wrapper)
        except BaseException:
            self.close()
            raise

    def finish(self):
        for entry in self.entries:
            handle = entry["handle"]
            if handle.closed:
                continue
            handle.flush()
            try:
                os.fsync(handle.fileno())
            except OSError:
                pass
            handle.close()

    def close(self):
        if self._closed:
            return
        self._closed = True
        for entry in self.entries:
            try:
                entry["handle"].close()
            except OSError:
                pass
        try:
            self.folder.cleanup()
        except OSError:
            pass


class _TeeUpload:
    def __init__(self, upload, sink):
        self._upload = upload
        self._sink = sink
        self.filename = getattr(upload, "filename", None)
        self.name = getattr(upload, "name", None)

    def read(self, *args, **kwargs):
        chunk = self._upload.read(*args, **kwargs)
        if chunk:
            self._sink.write(chunk)
        return chunk

    def __getattr__(self, name):
        return getattr(self._upload, name)


class HistoryStore:
    def __init__(self, directory):
        self.root = Path(directory) / STORE_FOLDER
        self.lock = threading.RLock()
        self._thumbnails = OrderedDict()
        self._thumbnail_limit = 64

    # ---------------------------------------------------------------- 路径
    def user_directory(self, token) -> Path:
        return self.root / "users" / _component(token)

    def _conversation_file(self, token, identity) -> Path:
        return self.user_directory(token) / "conversations" / (_component(identity) + ".json")

    def _page_file(self, token, identity, page_id) -> Path:
        return self.user_directory(token) / "pages" / _component(identity) / (_component(page_id) + ".jpg")

    def _attachment_file(self, token, identity, attachment_id) -> Path:
        return (self.user_directory(token) / "attachments" / _component(identity)
                / (_component(attachment_id) + ".bin"))

    # ---------------------------------------------------------------- 读取
    def load_user(self, token) -> dict:
        with self.lock:
            base = self.user_directory(token)
            meta = _coerce_meta(_read_json(base / "meta.json"))
            order = list(dict.fromkeys(meta["order"]))
            # 每个文件只读一次：先按 meta 顺序，再补上崩溃时“对话已写、meta 未写”
            # 的孤儿文件，避免为了兼容而重复解析全部历史。
            found = {}
            try:
                paths = sorted((base / "conversations").glob("*.json"))
            except OSError:
                paths = []
            for path in paths:
                payload = _read_json(path)
                if payload is None:
                    continue
                identity = payload.get("id") if isinstance(payload.get("id"), str) else path.stem
                if not identity:
                    identity = path.stem
                normalized = self._coerce_conversation(token, payload, identity)
                if normalized is not None and normalized["id"] not in found:
                    found[normalized["id"]] = normalized
            conversations = []
            seen = set()
            for identity in order:
                payload = found.pop(identity, None)
                if payload is None or payload["id"] in seen:
                    continue
                conversations.append(payload)
                seen.add(payload["id"])
            for payload in sorted(found.values(), key=lambda item: item.get("created_at") or ""):
                if payload["id"] in seen:
                    continue
                conversations.append(payload)
                seen.add(payload["id"])
            active = meta["active"] if meta["active"] in seen else None
            return {"active": active, "collections": meta["collections"],
                    "conversations": conversations}

    def _coerce_conversation(self, token, payload, identity):
        if not isinstance(payload, dict):
            return None
        conversation_id = payload.get("id") if isinstance(payload.get("id"), str) else identity
        if not conversation_id:
            return None
        title = payload.get("title") if isinstance(payload.get("title"), str) else "新对话"
        title = " ".join(title.split())[:60] or "新对话"
        collection_id = payload.get("collection_id")
        if not isinstance(collection_id, str) or not collection_id:
            collection_id = None
        page_ids = []
        raw_pages = payload.get("page_ids")
        if isinstance(raw_pages, list):
            page_ids = [item for item in raw_pages if isinstance(item, str) and item and len(item) <= 100]
        attachments = _coerce_attachments(payload.get("attachments"))

        # 兼容早期实验数据：页面图直接以 data URL 存在 JSON 里。
        inline = payload.get("note_images")
        if not isinstance(inline, dict):
            inline = {}
        for page_id, value in inline.items():
            if not isinstance(page_id, str) or not page_id or len(page_id) > 100:
                continue
            try:
                raw = decode_data_url(value)
            except ValueError:
                continue
            try:
                self._write_page_file(token, conversation_id, page_id, raw)
            except OSError:
                continue
            if page_id not in page_ids:
                page_ids.append(page_id)
            if not any(item["id"] == page_id for item in attachments):
                attachments.append(self._legacy_attachment(page_id, len(attachments) + 1, raw))
                try:
                    self.write_attachment(token, conversation_id, page_id, raw)
                except OSError:
                    pass
        if not attachments and page_ids:
            for index, page_id in enumerate(page_ids):
                raw = self.read_page(token, conversation_id, page_id)
                if raw is None:
                    continue
                attachments.append(self._legacy_attachment(page_id, index + 1, raw))
                try:
                    self.write_attachment(token, conversation_id, page_id, raw)
                except OSError:
                    pass

        for item in attachments:
            exists = self._attachment_exists(token, conversation_id, item["id"], item["kind"])
            if exists:
                item["available"] = True
                item["placeholder"] = False
            else:
                item["available"] = False
                item["placeholder"] = True
                item["reason"] = item["reason"] or "旧记录没有保留原文件，只能显示占位信息。"

        return {
            "id": conversation_id,
            "title": title,
            "created_at": _timestamp(payload.get("created_at")),
            "updated_at": _timestamp(payload.get("updated_at")),
            "collection_id": collection_id,
            "draft": bool(payload.get("draft", False)),
            "intake_text": payload.get("intake_text") if isinstance(payload.get("intake_text"), str) else "",
            "messages": _coerce_messages(payload.get("messages")),
            "page_ids": page_ids,
            "attachments": attachments,
        }

    def _legacy_attachment(self, identity, index, raw):
        return {"id": identity, "kind": "image", "name": f"历史原稿 {index}", "mime": "image/jpeg",
                "size": len(raw), "page_count": None, "width": None, "height": None,
                "created_at": "", "available": True, "placeholder": False,
                "legacy": True, "reason": ""}

    def _attachment_exists(self, token, identity, attachment_id, kind="image"):
        try:
            if self._attachment_file(token, identity, attachment_id).is_file():
                return True
        except OSError:
            return False
        # 旧记录/迁移数据只有页面图：仍可缩略图与预览，但标记为 legacy。
        try:
            return kind in ("image", "pdf") and self._page_file(token, identity, attachment_id).is_file()
        except OSError:
            return False

    def load_pages(self, token, identity, page_ids):
        images = {}
        for page_id in page_ids:
            raw = self.read_page(token, identity, page_id)
            if raw is not None:
                images[page_id] = image_data_url(raw)
        return images

    def read_page(self, token, identity, page_id):
        try:
            return self._page_file(token, identity, page_id).read_bytes()
        except OSError:
            return None

    def has_page(self, token, identity, page_id):
        try:
            return self._page_file(token, identity, page_id).is_file()
        except OSError:
            return False

    def read_attachment(self, token, identity, attachment_id):
        try:
            raw = self._attachment_file(token, identity, attachment_id).read_bytes()
            if raw:
                return raw
        except OSError:
            pass
        return self.read_page(token, identity, attachment_id)

    # ---------------------------------------------------------------- 写入
    def save_meta(self, token, payload) -> None:
        with self.lock:
            _atomic_json(self.user_directory(token) / "meta.json", payload)

    def save_conversation(self, token, payload) -> None:
        with self.lock:
            _atomic_json(self._conversation_file(token, payload["id"]), payload)

    def write_page(self, token, identity, page_id, raw) -> None:
        with self.lock:
            self._write_page_file(token, identity, page_id, raw)

    def _write_page_file(self, token, identity, page_id, raw):
        _atomic_bytes(self._page_file(token, identity, page_id), raw)

    def delete_page(self, token, identity, page_id) -> None:
        with self.lock:
            try:
                self._page_file(token, identity, page_id).unlink()
            except OSError:
                pass

    def write_attachment(self, token, identity, attachment_id, raw) -> None:
        with self.lock:
            _atomic_bytes(self._attachment_file(token, identity, attachment_id), raw)

    def copy_attachment(self, token, identity, attachment_id, source) -> None:
        with self.lock:
            path = self._attachment_file(token, identity, attachment_id)
            path.parent.mkdir(parents=True, exist_ok=True)
            handle, temporary = tempfile.mkstemp(prefix=".history-", dir=str(path.parent))
            try:
                with open(source, "rb") as stream, os.fdopen(handle, "wb") as output:
                    while chunk := stream.read(1024 * 1024):
                        output.write(chunk)
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary, path)
            except BaseException:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass
                raise

    def delete_attachment(self, token, identity, attachment_id) -> None:
        with self.lock:
            try:
                self._attachment_file(token, identity, attachment_id).unlink()
            except OSError:
                pass

    def delete_conversation(self, token, identity) -> None:
        with self.lock:
            base = self.user_directory(token)
            try:
                self._conversation_file(token, identity).unlink()
            except OSError:
                pass
            for folder in (base / "pages" / _component(identity),
                           base / "attachments" / _component(identity)):
                self._remove_tree(folder)
            owner = (_component(token), _component(identity))
            for key in [key for key in self._thumbnails if key[:2] == owner]:
                self._thumbnails.pop(key, None)

    @staticmethod
    def _remove_tree(folder):
        try:
            if folder.is_dir():
                import shutil
                shutil.rmtree(folder, ignore_errors=True)
        except OSError:
            pass

    # ---------------------------------------------------------------- 预览
    def thumbnail(self, token, identity, attachment_id, kind) -> bytes:
        key = (_component(token), _component(identity), _component(attachment_id))
        with self.lock:
            cached = self._thumbnails.get(key)
            if cached is not None:
                self._thumbnails.move_to_end(key)
                return cached
        raw = self.read_attachment(token, identity, attachment_id)
        if raw is None:
            raise ValueError("附件的原文件未保留，无法生成缩略图。")
        if kind == "pdf":
            content = self._pdf_thumbnail(raw)
        elif kind == "text":
            raise ValueError("文字文件没有图片缩略图。")
        else:
            content = self._image_thumbnail(raw)
        with self.lock:
            self._thumbnails[key] = content
            while len(self._thumbnails) > self._thumbnail_limit:
                self._thumbnails.popitem(last=False)
        return content

    def pdf_page(self, token, identity, attachment_id, number) -> bytes:
        raw = self.read_attachment(token, identity, attachment_id)
        if raw is None:
            raise ValueError("附件的原文件未保留，无法预览。")
        try:
            with pymupdf.open(stream=raw, filetype="pdf") as document:
                if not 1 <= number <= len(document):
                    raise ValueError("页码超出范围。")
                page = document[number - 1]
                if page.rect.width <= 0 or page.rect.height <= 0:
                    raise ValueError("这一页的尺寸无效。")
                scale = min(2, 1700 / max(page.rect.width, page.rect.height))
                return page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False).tobytes("jpeg")
        except ValueError:
            raise
        except Exception:
            raise ValueError("无法读取这个 PDF 附件。") from None

    @staticmethod
    def _image_thumbnail(raw) -> bytes:
        try:
            with Image.open(BytesIO(raw)) as source:
                source.load()
                image = ImageOps.exif_transpose(source)
                if image.mode in ("RGBA", "LA", "P"):
                    rgba = image.convert("RGBA")
                    image = Image.new("RGB", rgba.size, "white")
                    image.paste(rgba, mask=rgba.getchannel("A"))
                else:
                    image = image.convert("RGB")
                image.thumbnail((THUMBNAIL_EDGE, THUMBNAIL_EDGE))
                output = BytesIO()
                image.save(output, format="JPEG", quality=82)
                return output.getvalue()
        except Exception:
            raise ValueError("无法生成这张图片的缩略图。") from None

    @staticmethod
    def _pdf_thumbnail(raw) -> bytes:
        try:
            with pymupdf.open(stream=raw, filetype="pdf") as document:
                if not len(document):
                    raise ValueError("PDF 没有可预览的页面。")
                page = document[0]
                if page.rect.width <= 0 or page.rect.height <= 0:
                    raise ValueError("这一页的尺寸无效。")
                scale = min(1, THUMBNAIL_EDGE / max(page.rect.width, page.rect.height))
                return page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False).tobytes("jpeg")
        except ValueError:
            raise
        except Exception:
            raise ValueError("无法生成这个 PDF 的缩略图。") from None


def new_attachment_id() -> str:
    return secrets.token_hex(12)
