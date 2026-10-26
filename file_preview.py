"""临时 PDF 逐页预览：不调用模型，不进入资料库，按会话隔离并自动过期。"""

from pathlib import Path
import secrets
import tempfile
import threading
import time

import pymupdf

from document_input import MAX_FILE_BYTES, open_pdf
from material_files import MaterialFiles


class PdfPreviews:
    def __init__(self):
        self.materials = MaterialFiles()
        self.folder = None
        self.entries = {}
        self.lock = threading.RLock()

    def _remove(self, key):
        entry = self.entries.pop(key)
        entry["path"].unlink(missing_ok=True)

    def _expire(self):
        now = time.monotonic()
        for key, entry in list(self.entries.items()):
            if now - entry["seen"] > 1800:
                self._remove(key)

    def add(self, upload, owner):
        if not (upload.filename or "").lower().endswith(".pdf"):
            raise ValueError("请选择 PDF 预览。")
        key = secrets.token_urlsafe(24)
        with self.lock:
            if self.folder is None:
                self.folder = tempfile.TemporaryDirectory(prefix="study-pdf-preview-")
        path = Path(self.folder.name) / (key + ".pdf")
        try:
            size = 0
            with path.open("wb") as output:
                while chunk := upload.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_FILE_BYTES:
                        raise ValueError("单个 PDF 最多 256 MB。")
                    output.write(chunk)
            try:
                with open_pdf(path) as document:
                    if document.needs_pass:
                        raise ValueError("PDF 已加密，请解锁后预览。")
                    total = len(document)
                    if not total:
                        raise ValueError("PDF 没有可预览的页面。")
            except ValueError:
                raise
            except Exception:
                raise ValueError("无法打开 PDF，请检查文件是否完整。") from None
            with self.lock:
                self._expire()
                # 全站最多缓存 512 MB、单会话最多 3 份；淘汰最早使用的预览。
                while self.entries and (sum(e["size"] for e in self.entries.values()) + size > 512 * 1024 * 1024 or
                        sum(e["owner"] == owner for e in self.entries.values()) >= 3):
                    owned = [k for k, e in self.entries.items() if e["owner"] == owner]
                    candidates = owned if len(owned) >= 3 else list(self.entries)
                    self._remove(min(candidates, key=lambda k: self.entries[k]["seen"]))
                self.entries[key] = {"path": path, "size": size, "owner": owner, "pages": total, "seen": time.monotonic()}
            return {"id": key, "pages": total, "name": Path(upload.filename).name}
        except Exception:
            path.unlink(missing_ok=True)
            raise

    def page(self, key, number, owner):
        with self.lock:
            self._expire()
            entry = self.entries.get(key)
            if not entry or entry["owner"] != owner:
                raise ValueError("预览已过期，请重新点击文件旁的预览。")
            if not 1 <= number <= entry["pages"]:
                raise ValueError("页码超出范围。")
            entry["seen"] = time.monotonic()
            with pymupdf.open(entry["path"]) as document:
                page = document[number-1]
                if page.rect.width <= 0 or page.rect.height <= 0:
                    raise ValueError("这一页的尺寸无效。")
                scale = min(2, 1700/max(page.rect.width, page.rect.height))
                return page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False).tobytes("jpeg")

    def close(self):
        self.materials.close()
        with self.lock:
            self.entries.clear()
            if self.folder:
                self.folder.cleanup()

    def discard(self, keys, owner):
        with self.lock:
            for key in keys:
                entry = self.entries.get(key)
                if entry and entry["owner"] == owner:
                    self._remove(key)
