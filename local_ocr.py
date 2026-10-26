"""Optional GLM-OCR CPU runtime. Images go only to an owned loopback server.

The chat API is deliberately not used: GLM-OCR needs its fixed recognition task.
No downloads, configured API keys, remote fallback, or library writes occur here.
"""
import atexit
import base64
from collections import OrderedDict
import ctypes
from io import BytesIO
import json
import os
from pathlib import Path
from queue import Queue, Empty
import socket
import subprocess
import threading
import time
from urllib.request import Request, urlopen

from PIL import Image
from cancellation import CancellationToken
from llm import ModelError
from ocr import prepare_image
from runtime_paths import user_directory


def report(token, message, **fields):
    callback = getattr(token, "report", None)
    if callback:
        callback(message, **fields)


class LocalOcrRuntime:
    """One model at a time, lazy startup, idle unloading, bounded CPU/RAM."""
    def __init__(self, root=None, idle_seconds=60, timeout=300):
        self.root = Path(root) if root else user_directory()/".tools/document-pipeline"
        self.binary = self.root/"llama-cpu/llama-server.exe"
        self.model = self.root/"models/glm/GLM-OCR-Q8_0.gguf"
        self.projector = self.root/"models/glm/mmproj-GLM-OCR-Q8_0.gguf"
        self.lock = threading.Lock()
        self.shutdown = threading.Event()
        self.process = None
        self.timer = None
        self.log = None
        self.cache = OrderedDict()
        self.idle_seconds, self.timeout = idle_seconds, timeout
        atexit.register(self.close)

    @property
    def available(self):
        return (self.binary.is_file() and self.model.is_file() and self.projector.is_file()
                and self.model.stat().st_size == 950433408
                and self.projector.stat().st_size == 484403648)

    def public(self):
        return {"available": self.available, "model": "GLM-OCR · 本机 CPU",
                "running": self.process is not None and self.process.poll() is None}

    @staticmethod
    def memory(process=None):
        """Windows memory checks without torch/psutil; None on other platforms."""
        if os.name != "nt":
            return None, None
        from ctypes import wintypes
        class Status(ctypes.Structure):
            _fields_ = [("length", wintypes.DWORD), ("load", wintypes.DWORD)] + [
                (field, ctypes.c_ulonglong) for field in
                ("total", "available", "page_total", "page_available", "virtual_total", "virtual_available", "extended")]
        status = Status(); status.length = ctypes.sizeof(status)
        available = status.available if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)) else None
        rss = None
        if process is not None and process.poll() is None:
            class Counters(ctypes.Structure):
                _fields_ = [("cb", wintypes.DWORD), ("faults", wintypes.DWORD)] + [
                    (field, ctypes.c_size_t) for field in
                    ("peak", "working", "pool_peak", "pool", "nonpaged_peak", "nonpaged", "page", "page_peak")]
            counters = Counters(); counters.cb = ctypes.sizeof(counters)
            if ctypes.windll.psapi.GetProcessMemoryInfo(wintypes.HANDLE(int(process._handle)), ctypes.byref(counters), counters.cb):
                rss = counters.working
        return available, rss

    def _stop(self):
        if self.process is not None:
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=4)
                except subprocess.TimeoutExpired:
                    self.process.kill(); self.process.wait(timeout=4)
            self.process = None
        if self.log:
            self.log.close(); self.log = None

    def close(self):
        # Called after active operations are cancelled by web shutdown.
        self.shutdown.set()
        with self.lock:
            if self.timer:
                self.timer.cancel()
            self._stop()
            self.cache.clear()

    def _idle_stop(self):
        if self.lock.acquire(blocking=False):
            try:
                self._stop()
            finally:
                self.lock.release()

    def _guard(self, token):
        token.check()
        if self.shutdown.is_set():
            raise ModelError("本机识别服务已关闭，请重新启动应用。")
        available, rss = self.memory(self.process)
        if available is not None and available < 384*2**20:
            raise ModelError("本机可用内存不足，已停止 GLM 识别。请释放内存后重试；不会自动改用付费接口。")
        if rss is not None and rss > 2200*2**20:
            raise ModelError("GLM 达到本机内存保护上限，已停止。请裁剪题目或减少页面后重试。")

    def _start(self, token):
        if self.process is not None and self.process.poll() is None:
            return
        self._stop()
        if not self.available:
            raise ModelError("GLM 本机模型文件不完整，请按 LOCAL_OCR.md 安装；未调用远程识别。")
        available, _ = self.memory()
        if available is not None and available < 2300*2**20:
            raise ModelError("启动 GLM 前需要约 2.3 GB 可用内存。请关闭部分程序后重试；未调用远程识别。")
        report(token, "正在加载本机 GLM-OCR…", phase="ocr-starting")
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0)); port = listener.getsockname()[1]
        self.base = f"http://127.0.0.1:{port}"
        logdir = self.root/"logs"; logdir.mkdir(parents=True, exist_ok=True)
        self.log = (logdir/f"glm-web-{os.getpid()}.log").open("w", encoding="utf8")
        command = [str(self.binary), "-m", str(self.model), "--mmproj", str(self.projector),
                   "--host", "127.0.0.1", "--port", str(port), "-c", "4096", "-np", "1",
                   "-t", "2", "-tb", "2", "-b", "128", "-ub", "64", "-ngl", "0",
                   "--no-mmproj-offload", "--no-warmup", "--jinja", "--no-webui", "--alias", "local-glm-ocr"]
        self.process = subprocess.Popen(command, stdout=self.log, stderr=subprocess.STDOUT,
                                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        deadline = time.monotonic()+60
        while time.monotonic() < deadline:
            self._guard(token)
            if self.process.poll() is not None:
                raise ModelError("GLM 本机服务启动失败，请检查 .tools/document-pipeline/logs 中的日志。")
            try:
                with urlopen(self.base+"/health", timeout=.4) as response:
                    if response.status == 200:
                        return
            except OSError:
                pass
            token.wait(.15)
        raise ModelError("GLM 本机服务启动超时，请释放内存后重试。")

    @staticmethod
    def image(raw):
        # Reuse the same safety checks, orientation/alpha handling as cloud OCR.
        safe = prepare_image(raw)
        with Image.open(BytesIO(base64.b64decode(safe.split(",", 1)[1]))) as source:
            picture = source.convert("RGB")
            picture.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
            output = BytesIO(); picture.save(output, format="PNG")
        return output.getvalue()

    def read(self, raw, cancel_token=None):
        import hashlib
        token = cancel_token or CancellationToken()
        token.check()
        if self.shutdown.is_set():
            raise ModelError("本机识别服务已关闭，请重新启动应用。")
        encoded = self.image(raw)
        key = hashlib.sha256(encoded).hexdigest()
        report(token, "等待本机 GLM-OCR；为控制内存，每次只识别一页。", phase="ocr-waiting")
        while not self.lock.acquire(timeout=.1):
            token.check()
        try:
            token.check()
            if self.timer:
                self.timer.cancel()
            if key in self.cache:
                self.cache.move_to_end(key)
                return self.cache[key]
            self._start(token)
            report(token, "GLM 正在本机识别，CPU 处理可能需要一两分钟…", phase="ocr-reading")
            payload = {"model": "local-glm-ocr", "messages": [{"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,"+base64.b64encode(encoded).decode("ascii")}},
                {"type": "text", "text": "Text Recognition:"}]}],
                "temperature": 0, "top_p": 1, "max_tokens": 3072, "stream": False}
            results = Queue(maxsize=1)
            def request():
                try:
                    req = Request(self.base+"/v1/chat/completions", data=json.dumps(payload).encode("utf8"),
                                  headers={"Content-Type": "application/json"})
                    with urlopen(req, timeout=self.timeout) as response:
                        result = json.load(response)
                    results.put((True, result))
                except Exception as exc:
                    results.put((False, exc))
            worker = threading.Thread(target=request, daemon=True); worker.start()
            deadline = time.monotonic()+self.timeout
            while True:
                self._guard(token)
                if self.process.poll() is not None:
                    raise ModelError("GLM 识别服务意外退出，本页未完成；原文件保留。")
                if time.monotonic() > deadline:
                    raise ModelError("GLM 本页识别超时，请缩小到题目局部后重试。")
                try:
                    success, result = results.get(timeout=.15)
                    break
                except Empty:
                    pass
            token.check()
            if not success:
                raise ModelError("GLM 本机识别请求未完成，请重试；未调用远程接口。") from result
            try:
                choice = result["choices"][0]
                text = choice["message"]["content"]
                if choice.get("finish_reason") != "stop" or not isinstance(text, str) or not text.strip():
                    raise ValueError()
            except (KeyError, IndexError, TypeError, ValueError):
                raise ModelError("GLM 本页文字未完整读出，请裁剪或减少内容后重试；不会将截断结果入库。") from None
            self.cache[key] = text.strip()
            while len(self.cache) > 40:
                self.cache.popitem(last=False)
            return text.strip()
        except BaseException:
            # Killing only this owned server also interrupts the network thread.
            self._stop()
            raise
        finally:
            self.timer = threading.Timer(self.idle_seconds, self._idle_stop)
            self.timer.daemon = True; self.timer.start()
            self.lock.release()


class LocalImageReader:
    prefer_visual = True  # Native PDF text loses roots/fractions too.
    def __init__(self, runtime):
        self.runtime = runtime

    def read(self, raw, cancel_token=None):
        return self.runtime.read(raw, cancel_token)
