"""本机持久配置。Windows 使用当前用户的 DPAPI 加密 API Key。"""

import base64
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import tempfile
import threading
import time
from urllib.parse import urlsplit
from runtime_paths import default_settings_path


ROOT = Path(__file__).resolve().parent
DEFAULT_BASE = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-v4-pro"
DEFAULT_OCR_MODEL = "deepseek-flash"


def load_user_environment():
    if os.name != "nt":
        return
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
            for name in ("LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY", "OCR_BASE_URL", "OCR_MODEL", "OCR_API_KEY"):
                if not os.getenv(name):
                    try:
                        value, _ = winreg.QueryValueEx(key, name)
                        if isinstance(value, str):
                            os.environ[name] = value
                    except FileNotFoundError:
                        pass
    except OSError:
        pass


def _dpapi(raw, decrypt=False):
    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]

    buffer = ctypes.create_string_buffer(raw)
    source = Blob(len(raw), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    result = Blob()
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    function = crypt32.CryptUnprotectData if decrypt else crypt32.CryptProtectData
    function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                         ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    function.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    if not function(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result)):
        raise ValueError("无法使用当前 Windows 用户加密或读取密钥，请重新输入 API Key。")
    try:
        return ctypes.string_at(result.data, result.size)
    finally:
        kernel32.LocalFree(ctypes.cast(result.data, ctypes.c_void_p))


def protect(secret):
    if not secret:
        return None
    if os.name == "nt":
        return {"method": "windows-dpapi", "value": base64.b64encode(_dpapi(secret.encode())).decode("ascii")}
    return {"method": "local-file", "value": secret}


def unprotect(value):
    if not value:
        return ""
    if not isinstance(value, dict) or not isinstance(value.get("value"), str):
        raise ValueError("本机配置的密钥格式有误，请检查 .local-settings.json。")
    if value.get("method") == "windows-dpapi":
        if os.name != "nt":
            raise ValueError("此密钥绑定原 Windows 用户，请重新输入。")
        return _dpapi(base64.b64decode(value["value"]), decrypt=True).decode()
    if value.get("method") == "local-file":
        return value["value"]
    raise ValueError("本机配置的密钥格式有误，请检查 .local-settings.json。")


class SettingsStore:
    def __init__(self, path=None):
        self.path = Path(path) if path else default_settings_path()
        self.lock = threading.RLock()

    def resolve(self):
        with self.lock:
            saved = {}
            if self.path.exists():
                try:
                    saved = json.loads(self.path.read_text(encoding="utf-8"))
                    if not isinstance(saved, dict):
                        raise ValueError()
                except (ValueError, OSError):
                    raise ValueError("本机模型配置文件无法读取；原文件未修改。") from None
            base = saved.get("base_url") or os.getenv("LLM_BASE_URL") or DEFAULT_BASE
            key = unprotect(saved.get("api_key")) or os.getenv("LLM_API_KEY", "")
            return {
                "base_url": base,
                "ocr_backend": saved.get("ocr_backend", "auto"),
                "model": saved.get("model") or os.getenv("LLM_MODEL") or DEFAULT_MODEL,
                "api_key": key,
                "ocr_base_url": saved.get("ocr_base_url") or os.getenv("OCR_BASE_URL") or base,
                "ocr_model": saved.get("ocr_model") or os.getenv("OCR_MODEL") or DEFAULT_OCR_MODEL,
                "ocr_api_key": unprotect(saved.get("ocr_api_key")) or os.getenv("OCR_API_KEY") or key,
            }

    def public(self):
        config = self.resolve()
        return {key: value for key, value in config.items() if key not in ("api_key", "ocr_api_key")} | {
            "configured": bool(config["api_key"]), "key_saved": bool(config["api_key"]),
            "ocr_key_saved": bool(config["ocr_api_key"]),
            "storage": "Windows 当前用户加密保存" if os.name == "nt" else "本机权限受限文件",
        }

    def validate(self, payload):
        if not isinstance(payload, dict):
            raise ValueError("请填写模型配置。")
        current = self.resolve()
        backend = payload.get("ocr_backend", current["ocr_backend"])
        if backend not in ("auto", "local", "remote"):
            raise ValueError("请选择 GLM 本机识别或云端识图。")
        values = {"ocr_backend": backend}
        for name in ("base_url", "model", "ocr_base_url", "ocr_model"):
            value = payload.get(name, current[name])
            if not isinstance(value, str) or len(value) > 2000:
                raise ValueError("接口地址或模型名称格式有误。")
            values[name] = value.strip()
        values["base_url"] = values["base_url"].rstrip("/")
        values["ocr_base_url"] = (values["ocr_base_url"] or values["base_url"]).rstrip("/")
        if not values["model"] or not values["ocr_model"]:
            raise ValueError("请填写整理模型和图片识别模型名称。")
        for name in ("base_url", "ocr_base_url"):
            url = urlsplit(values[name])
            local_http = url.scheme == "http" and url.hostname in ("127.0.0.1", "localhost", "::1")
            if (not url.hostname or (url.scheme != "https" and not local_http)
                    or url.username or url.password or url.query or url.fragment):
                raise ValueError("接口地址应为 HTTPS 地址，或本机 HTTP 地址，且不含密钥、查询参数。")
        for name in ("api_key", "ocr_api_key"):
            value = payload.get(name, "")
            if not isinstance(value, str) or len(value) > 8000:
                raise ValueError("API Key 格式有误。")
            values[name] = value.strip()
        if values["base_url"] != current["base_url"] and not values["api_key"]:
            raise ValueError("更换 API 服务地址时，请重新输入该服务对应的 API Key。")
        values["api_key"] = values["api_key"] or current["api_key"]
        if values["ocr_base_url"] == values["base_url"]:
            separate_key = (current["ocr_api_key"] if current["ocr_base_url"] == values["ocr_base_url"]
                            and current["ocr_api_key"] != current["api_key"] else "")
            values["ocr_api_key"] = values["ocr_api_key"] or separate_key or values["api_key"]
        else:
            if values["ocr_base_url"] != current["ocr_base_url"] and not values["ocr_api_key"]:
                raise ValueError("更换图片识别服务地址时，请输入对应的图片服务 API Key。")
            values["ocr_api_key"] = values["ocr_api_key"] or current["ocr_api_key"]
        if not values["api_key"] or not values["ocr_api_key"]:
            raise ValueError("请先输入 API Key，再保存或测试连接。")
        return values

    def save(self, payload):
        with self.lock:
            values = self.validate(payload)
            record = {**values, "api_key": protect(values["api_key"]),
                      "ocr_api_key": protect(values["ocr_api_key"]), "updated_at": time.time()}
            return self._persist(record)

    def set_model(self, model):
        if (not isinstance(model, str) or not model.strip() or len(model) > 2000
                or any(ord(char) < 32 for char in model)):
            raise ValueError("请选择有效的模型名称。")
        with self.lock:
            record = json.loads(self.path.read_text(encoding="utf8")) if self.path.exists() else {}
            if not isinstance(record, dict):
                raise ValueError("本机模型配置无法读取，原文件未修改。")
            # A quick switch changes only the text model; encrypted keys/providers stay byte-for-byte intact.
            return self._persist({**record, "model": model.strip(), "updated_at": time.time()})

    def set_ocr_backend(self, backend):
        if backend not in ("local", "remote"):
            raise ValueError("请选择 GLM 本机识别或云端识图。")
        with self.lock:
            record = json.loads(self.path.read_text(encoding="utf8")) if self.path.exists() else {}
            if not isinstance(record, dict):
                raise ValueError("本机模型配置无法读取，原文件未修改。")
            return self._persist({**record, "ocr_backend": backend, "updated_at": time.time()})

    def _persist(self, record):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", suffix=".tmp",
                                             prefix=".local-settings-", dir=self.path.parent, delete=False) as file:
                temporary = file.name
                json.dump(record, file, ensure_ascii=False, indent=2)
                file.flush()
                os.fsync(file.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, self.path)
        finally:
            if temporary and Path(temporary).exists():
                Path(temporary).unlink()
        return self.public()
