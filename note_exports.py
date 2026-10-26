"""笔记导出：Markdown 是唯一来源；PDF 失败不会丢失已保存的笔记。"""

import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

from math_text import normalize_math_markdown
from runtime_paths import frozen


ROOT = Path(__file__).resolve().parent


class NoteExporter:
    def __init__(self, data_dir):
        self.root = (Path(data_dir) / "note_exports").resolve()

    def paths(self, record):
        title = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", record["topic"]).strip(" .")[:36] or "学习笔记"
        key = hashlib.sha256(record["id"].encode()).hexdigest()[:16]
        base = self.root / f"{title}-{key}"
        return {kind: base.with_name(base.name + "." + kind) for kind in ("md", "pdf")}

    @staticmethod
    def _write(path, content):
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, suffix=".tmp", delete=False) as stream:
                temporary = stream.name
                stream.write(content)
            os.replace(temporary, path)
        finally:
            if temporary and Path(temporary).exists():
                Path(temporary).unlink()

    def export(self, record, cancel_token=None):
        paths = self.paths(record)
        result = {}
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            source = normalize_math_markdown(record["content"].strip()) + "\n"
            changed = not paths["md"].exists() or paths["md"].read_text(encoding="utf-8") != source
            self._write(paths["md"], source)
            result["md"] = {"ok": True, "path": str(paths["md"].resolve())}
            if changed:
                paths["pdf"].unlink(missing_ok=True)
            if paths["pdf"].exists():
                result["pdf"] = {"ok": True, "path": str(paths["pdf"].resolve())}
                return result
            if cancel_token and cancel_token.cancelled:
                result["pdf"] = {"ok": False, "error": "已停止排版；笔记和 Markdown 已保存，可稍后重试。"}
                return result
            with tempfile.TemporaryDirectory(prefix="build-", dir=self.root) as scratch:
                build = Path(scratch)
                output = build / "note.pdf"
                cancel_file = build / "cancel"
                tex_ready = not frozen() and all(shutil.which(name) for name in ("pandoc", "xelatex", "kpsewhich", "pdftotext", "pdffonts"))
                if frozen():
                    command = [sys.executable, "--render-pdf", str(paths["md"]), str(output), "--cancel-file", str(cancel_file)]
                elif tex_ready:
                    command = [sys.executable, "-X", "utf8", str(ROOT / "skills/organize-math-board/scripts/render_pdf.py"),
                               str(paths["md"]), "--output", str(output), "--build-dir", str(build / "tex")]
                    font = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts/msyh.ttc"
                    if font.exists():
                        command += ["--font-file", str(font)]
                else:
                    command = [sys.executable, "-X", "utf8", str(ROOT / "note_pdf.py"),
                               str(paths["md"]), str(output), "--cancel-file", str(cancel_file)]
                with (build / "render.log").open("w+", encoding="utf-8") as log:
                    creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
                    process = subprocess.Popen(command, stdout=log, stderr=log, creationflags=creationflags)
                    started = time.monotonic()
                    stopped_at = None
                    try:
                        while process.poll() is None:
                            if cancel_token and cancel_token.cancelled:
                                cancel_file.touch(exist_ok=True)
                                stopped_at = stopped_at or time.monotonic()
                            if time.monotonic() - started > 45 or (stopped_at and time.monotonic() - stopped_at > 3):
                                process.terminate()
                                process.wait(timeout=5)
                                break
                            try:
                                process.wait(timeout=0.1)
                            except subprocess.TimeoutExpired:
                                pass
                    finally:
                        if process.poll() is None:
                            process.terminate()
                            process.wait(timeout=5)
                    log.seek(0)
                    diagnostic = log.read()
                if stopped_at:
                    raise ValueError("已停止排版；笔记和 Markdown 已保存，可稍后重试。")
                if process.returncode != 0 or not output.exists():
                    renderer_error = build / "renderer-error.txt"
                    if renderer_error.exists():
                        diagnostic = renderer_error.read_text(encoding="utf-8")
                    detail = diagnostic.strip().splitlines()[-1] if diagnostic.strip() else "排版超时或未产生 PDF"
                    raise ValueError(detail[:400])
                os.replace(output, paths["pdf"])
                result["pdf"] = {"ok": True, "path": str(paths["pdf"].resolve()),
                                 "checks": "公式解析、页面宽度、中文文本与字体嵌入已检查；请下载核对原稿。"}
        except (ValueError, OSError, subprocess.SubprocessError) as exc:
            result["pdf"] = {"ok": False, "error": str(exc)}
            result.setdefault("md", {"ok": False, "error": str(exc)})
        return result


def note_reply(data, web=False):
    record = data["note"]
    exports = data.get("exports", {})
    links = []
    for kind in ("md", "pdf"):
        item = exports.get(kind, {})
        if item.get("ok"):
            path = f"/api/notes/{record['id']}/download/{kind}" if web else item["path"].replace("\\", "/")
            links.append(f"[{'Markdown' if kind == 'md' else 'PDF'}](<{path}>)")
    answer = "这份笔记已存在，未重复入库。" if data.get("duplicate") else "笔记已保存。"
    if links:
        answer += "\n\n" + " · ".join(links)
    if not exports.get("pdf", {}).get("ok"):
        answer += "\n\nPDF 导出未完成：" + exports.get("pdf", {}).get("error", "未产生 PDF") + "。可在笔记库重试导出。"
    return answer
