"""小程序用户的账号资料、头像与个人模型 API Key（用户级设置）。

三块内容：

* **默认账号**：身份来自微信（云托管注入或 ``wx.login``），这里只负责在用户目录里
  落一份 ``profile.json``。已有 profile 的字段一律保留（例如旧版本写入的 ``openid``），
  只用合并的方式追加昵称、头像元数据；
* **头像**：内置一个按 UID 生成的圆形默认头像；上传的头像必须是真的图片，重新编码后
  落盘，接口只回传 data URL，不回传 openid 或磁盘路径；
* **个人模型 Key**：只允许 DeepSeek 官方地址（管理员配置的自定义域名仍然只用于共享
  配置），用 AES-256-GCM 加密后与用户目录一起保存。密钥由服务端持久 secret 经 HKDF
  派生，记录里带 UID 作为附加认证数据，别人的密文搬到本账号下也解不开。

设计取舍：

* 密钥只写不读——任何接口都不回传明文或密文；
* 没有 ``cryptography`` 或无法解密时给出明确设置错误，绝不自制加密、不静默降级；
* 所有写操作都是“同目录临时文件 + os.replace”，并且由调用方用 ``UserState`` 的写入
  计数与删除互斥（见 ``wx_api``），避免删除进行到一半又被写回文件。
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import secrets
import threading
import time
from io import BytesIO
from pathlib import Path

from settings import DEFAULT_BASE, DEFAULT_MODEL

try:  # 缺失时不让整个服务起不来：只有“保存个人 Key”相关接口返回明确错误。
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    AEAD_ERROR = ""
except Exception as exc:  # pragma: no cover - 依赖缺失只在极少数部署里出现
    InvalidTag = ()
    hashes = AESGCM = HKDF = None
    AEAD_ERROR = str(exc)

try:
    from PIL import Image
except Exception:  # pragma: no cover - 与 requirements 对齐，缺 Pillow 只是头像功能降级
    Image = None


# 个人 Key 只发这个受信供应商：小程序永远不能提交 base_url。
USER_MODEL_BASE = DEFAULT_BASE
USER_MODEL_PROVIDER = "deepseek"
USER_MODEL_PROVIDER_LABEL = "DeepSeek 官方"
USER_MODEL_SUGGESTIONS = ("deepseek-v4-pro", "deepseek-flash")

PROFILE_FILE = "profile.json"
MODEL_FILE = "model.json"
AVATAR_FILE = "avatar.img"

DEFAULT_NICKNAME_PREFIX = "学习者"
NICKNAME_MAX = 24
MODEL_NAME_MAX = 120
API_KEY_MAX = 8000
# 单张头像 2 MB（base64 之后约 2.7 MB），编码为 256×256 JPEG 后通常小于 40 KB。
MAX_AVATAR_BYTES = 2 * 1024 * 1024
MAX_AVATAR_CHARS = MAX_AVATAR_BYTES * 4 // 3 + 16
AVATAR_SIDE = 256
AVATAR_MIN_SIDE = 16

SETTINGS_UNAVAILABLE = ("服务端还没有安装加密组件（cryptography），暂时不能保存个人 API Key；"
                        "请联系管理员或先用管理员配置的共享模型。")
KEY_UNREADABLE = ("个人 API Key 无法读取（服务端加密密钥可能已变更）。请在本页重新保存一次；"
                  "也可以清除个人 Key，改用管理员配置的共享模型。")
NO_KEY_MESSAGE = ("还没有可用的模型 API Key。请打开小程序「设置 → API Key / 模型配置」填写，"
                  "或让管理员配置共享模型。")

_AVATAR_CACHE: dict[str, bytes] = {}
_AVATAR_LOCK = threading.Lock()


class SecretUnavailable(RuntimeError):
    """服务端缺少加密能力：调用方应返回明确的设置错误。"""


class SecretCorrupt(RuntimeError):
    """密文无法解密（服务端 secret 变更或记录损坏）：提示用户重新保存。"""


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.b64decode(text, validate=True)


class SecretBox:
    """AES-256-GCM 封装：HKDF 派生密钥，附加认证数据绑定 UID。"""

    SALT = b"study-agent/wx-user-model/v1"
    INFO = b"wx-user-model-key"

    def __init__(self, server_secret: bytes):
        if AESGCM is None or HKDF is None or hashes is None:
            raise SecretUnavailable(SETTINGS_UNAVAILABLE)
        # 只要“稳定且非空”即可派生：HKDF 接受任意长度的输入，短 secret 的安全性靠部署方
        # 换成随机长串（见 WECHAT_MINIPROGRAM.md），不会因为历史短 secret 直接不可用。
        if not isinstance(server_secret, (bytes, bytearray)) or not bytes(server_secret):
            raise SecretUnavailable("服务端没有稳定的加密密钥，暂时不能保存个人 API Key。")
        self._aead = AESGCM(HKDF(algorithm=hashes.SHA256(), length=32, salt=self.SALT,
                                 info=self.INFO).derive(bytes(server_secret)))

    def seal(self, plaintext: str, uid: str) -> dict:
        nonce = secrets.token_bytes(12)
        ciphertext = self._aead.encrypt(nonce, plaintext.encode("utf-8"), self._aad(uid))
        return {"v": 1, "alg": "aes-256-gcm", "nonce": _b64(nonce), "ct": _b64(ciphertext)}

    def unseal(self, record: dict, uid: str) -> str:
        if not isinstance(record, dict):
            raise SecretCorrupt(KEY_UNREADABLE)
        if record.get("v") != 1 or record.get("alg") != "aes-256-gcm":
            raise SecretCorrupt(KEY_UNREADABLE)
        nonce, ciphertext = record.get("nonce"), record.get("ct")
        if not isinstance(nonce, str) or not isinstance(ciphertext, str):
            raise SecretCorrupt(KEY_UNREADABLE)
        try:
            raw = self._aead.decrypt(_unb64(nonce), _unb64(ciphertext), self._aad(uid))
        except (InvalidTag, ValueError, TypeError, binascii.Error):
            raise SecretCorrupt(KEY_UNREADABLE) from None
        value = raw.decode("utf-8", "strict")
        if not value:
            raise SecretCorrupt(KEY_UNREADABLE)
        return value

    @staticmethod
    def _aad(uid: str) -> bytes:
        return ("uid:" + uid).encode("utf-8")


# ---------------------------------------------------------------- 校验


def default_nickname(uid: str) -> str:
    """稳定：同一个账号任何时候算出来的默认昵称都一样。"""
    return DEFAULT_NICKNAME_PREFIX + (uid or "0000")[:4].lower()


def clean_nickname(value) -> str:
    if not isinstance(value, str):
        raise ValueError("昵称格式有误。")
    text = value.strip()
    # 控制字符、换行和零宽字符都不该进昵称；emoji 与普通文字保留。
    text = "".join(char for char in text if char.isprintable() and char not in "\u200b\u200c\u200d\ufeff")
    if not text:
        raise ValueError("昵称不能为空，可以直接用默认昵称。")
    if len(text) > NICKNAME_MAX:
        raise ValueError(f"昵称最多 {NICKNAME_MAX} 个字。")
    return text


def clean_model(value) -> str:
    if value is None or value == "":
        return DEFAULT_MODEL
    if not isinstance(value, str):
        raise ValueError("模型名称格式有误。")
    text = value.strip()
    if not text or len(text) > MODEL_NAME_MAX or any(ord(char) < 32 for char in text):
        raise ValueError("模型名称格式有误，例如 deepseek-v4-pro。")
    return text


def clean_api_key(value) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError("API Key 格式有误。")
    text = value.strip()
    if len(text) > API_KEY_MAX:
        raise ValueError("API Key 过长，请检查是否粘贴了多余内容。")
    if any(ord(char) < 32 for char in text):
        raise ValueError("API Key 里包含换行或控制字符，请重新粘贴。")
    return text


def normalize_avatar(raw: bytes) -> tuple[bytes, str]:
    """校验“真的是图片”，并裁成正方形重新编码；不保留 EXIF 和原始字节。"""
    if not raw:
        raise ValueError("头像内容为空，请重新选择。")
    if len(raw) > MAX_AVATAR_BYTES:
        raise ValueError("头像图片超过 2 MB，请换一张或先压缩。")
    if Image is None:  # pragma: no cover - 依赖完整时不会走到
        raise ValueError("服务端暂时不能处理头像图片，请稍后再试。")
    try:
        with Image.open(BytesIO(raw)) as probe:
            probe.verify()
    except Exception:
        raise ValueError("这不是一张可用的图片，请重新选择。") from None
    try:
        with Image.open(BytesIO(raw)) as image:
            if getattr(image, "n_frames", 1) > 1:
                image.seek(0)
            width, height = image.size
            if min(width, height) < AVATAR_MIN_SIDE:
                raise ValueError("头像图片太小，请换一张清晰的。")
            if max(width, height) > 6000:
                raise ValueError("头像图片尺寸过大，请先压缩。")
            side = min(width, height)
            left, top = (width - side) // 2, (height - side) // 2
            square = image.convert("RGB").crop((left, top, left + side, top + side))
            square = square.resize((AVATAR_SIDE, AVATAR_SIDE), Image.LANCZOS)
            buffer = BytesIO()
            square.save(buffer, format="JPEG", quality=82, optimize=True)
    except ValueError:
        raise
    except Exception:
        raise ValueError("这张图片无法处理，请换一张再试。") from None
    return buffer.getvalue(), "image/jpeg"


def default_avatar(uid: str) -> bytes:
    """按 UID 生成的圆形默认头像（同一账号每次都一样）。"""
    key = (uid or "0")[:16]
    with _AVATAR_LOCK:
        cached = _AVATAR_CACHE.get(key)
    if cached:
        return cached
    if Image is None:  # pragma: no cover
        return b""
    palette = ((47, 111, 94), (74, 111, 165), (166, 106, 61), (110, 84, 148), (60, 106, 130))
    digest = hashlib.sha256((uid or "0").encode("utf-8")).digest()
    base = palette[digest[0] % len(palette)]
    scale = 4  # 四倍绘制后缩小，边缘更干净
    size = AVATAR_SIDE * scale
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    from PIL import ImageDraw

    draw = ImageDraw.Draw(image)
    draw.ellipse((0, 0, size - 1, size - 1), fill=base + (255,))
    # 内侧浅色圆环 + 右下角圆点：不依赖字体，任何设备上都不会出现方框。
    light = tuple(min(255, int(channel + (255 - channel) * 0.55)) for channel in base)
    inset = int(size * 0.13)
    draw.ellipse((inset, inset, size - inset - 1, size - inset - 1), outline=light + (255,),
                 width=int(size * 0.055))
    dot = int(size * 0.13)
    center = int(size * 0.62)
    draw.ellipse((center - dot, center - dot, center + dot, center + dot), fill=light + (255,))
    image = image.resize((AVATAR_SIDE, AVATAR_SIDE), Image.LANCZOS)
    buffer = BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    data = buffer.getvalue()
    with _AVATAR_LOCK:
        _AVATAR_CACHE[key] = data
    return data


# ---------------------------------------------------------------- 账号


def _read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        raise ValueError("账号资料文件无法读取，请稍后重试。") from None
    if not isinstance(data, dict):
        raise ValueError("账号资料文件格式有误，请稍后重试。")
    return data


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}-{secrets.token_hex(8)}.tmp")
    temporary.write_bytes(data)
    try:
        os.chmod(temporary, 0o600)
    except OSError:
        pass
    os.replace(temporary, path)


class UserAccount:
    """一个用户的资料 / 头像 / 个人模型配置；所有写操作合并已有字段。"""

    def __init__(self, directory: Path, uid: str, secret_box=None, lock=None):
        self.directory = Path(directory)
        self.uid = uid
        self.secret_box = secret_box  # 可能是抛 SecretUnavailable 的提供者
        self.lock = lock or threading.RLock()
        self.profile_path = self.directory / PROFILE_FILE
        self.model_path = self.directory / MODEL_FILE
        self.avatar_path = self.directory / AVATAR_FILE

    # ---- 资料

    def read_profile(self) -> dict:
        return _read_json(self.profile_path)

    def ensure_profile(self) -> dict:
        """首次打开：补默认昵称；已存在的字段（如 openid）原样保留。"""
        with self.lock:
            record = self.read_profile()
            changed = False
            if not isinstance(record.get("nickname"), str) or not record.get("nickname", "").strip():
                record["nickname"] = default_nickname(self.uid)
                changed = True
            if not isinstance(record.get("created_at"), (int, float)):
                record["created_at"] = int(time.time())
                changed = True
            if changed:
                self._save_profile(record)
            return record

    def update_nickname(self, nickname: str) -> dict:
        with self.lock:
            record = self.read_profile()
            record["nickname"] = nickname
            record["nickname_edited_at"] = int(time.time())
            self._save_profile(record)
            return record

    def save_avatar(self, raw: bytes) -> dict:
        image, mime = normalize_avatar(raw)
        with self.lock:
            _atomic_write(self.avatar_path, image)
            record = self.read_profile()
            record["avatar_mime"] = mime
            record["avatar_version"] = int(time.time())
            self._save_profile(record)
            return record

    def avatar_bytes(self) -> tuple[bytes, str]:
        """返回 (图片字节, mime)；没有自定义头像时给默认圆形头像。"""
        record = self.read_profile()
        if isinstance(record.get("avatar_version"), (int, float)) and self.avatar_path.exists():
            try:
                mime = record.get("avatar_mime")
                return self.avatar_path.read_bytes(), mime if isinstance(mime, str) else "image/jpeg"
            except OSError:
                pass
        return default_avatar(self.uid), "image/png"

    def profile_view(self) -> dict:
        """给客户端的资料视图：不含 openid、不含磁盘路径。"""
        record = self.ensure_profile()
        nickname = record.get("nickname") if isinstance(record.get("nickname"), str) else default_nickname(self.uid)
        image, mime = self.avatar_bytes()
        custom_avatar = bool(record.get("avatar_version")) and self.avatar_path.exists()
        return {
            "nickname": nickname,
            "default_nickname": nickname == default_nickname(self.uid),
            "avatar": {
                "kind": "custom" if custom_avatar else "default",
                "mime": mime,
                "version": record.get("avatar_version") if custom_avatar else 0,
                "data_url": (f"data:{mime};base64,{_b64(image)}") if image else "",
            },
            "updated_at": record.get("nickname_edited_at") or record.get("created_at") or 0,
        }

    def _save_profile(self, record: dict) -> None:
        _atomic_write(self.profile_path,
                      json.dumps(record, ensure_ascii=False, sort_keys=True, indent=2).encode("utf-8"))

    # ---- 个人模型配置

    def model_record(self) -> dict:
        return _read_json(self.model_path)

    def model_status(self, shared_configured: bool = False, shared_model: str = "") -> dict:
        """只回传状态：有没有 Key、模型名、更新时间；不含明文或密文。

        结论必须和“这一轮请求实际会怎么走”一致：
        个人 Key 读不出来时不会偷偷改用共享 Key，所以这里也报告未配置。
        """
        record = self.model_record()
        sealed = record.get("key")
        key_saved = isinstance(sealed, dict) and bool(sealed.get("ct"))
        key_error = ""
        if key_saved:
            try:
                self._box().unseal(sealed, self.uid)
            except SecretUnavailable as exc:
                key_error = str(exc)
            except SecretCorrupt as exc:
                key_error = str(exc)
        personal_model = record.get("model") if isinstance(record.get("model"), str) and record.get("model") else ""
        if key_saved and not key_error:
            configured, source = True, "user"
            model = personal_model or DEFAULT_MODEL
        elif key_saved:
            # 有个人记录但用不了：请求会明确失败，不能报告成“已配置”。
            configured, source = False, ""
            model = personal_model or DEFAULT_MODEL
        elif shared_configured:
            configured, source = True, "server"
            model = shared_model or DEFAULT_MODEL
        else:
            configured, source = False, ""
            model = personal_model or shared_model or DEFAULT_MODEL
        return {
            "configured": configured,
            "key_saved": key_saved,
            "source": source,
            "model": model,
            "provider": USER_MODEL_PROVIDER,
            "provider_label": USER_MODEL_PROVIDER_LABEL,
            "updated_at": record.get("updated_at") or 0,
            "key_error": key_error,
            "shared_configured": shared_configured,
            "models": list(USER_MODEL_SUGGESTIONS),
            "can_edit_base_url": False,
        }

    def save_model(self, api_key: str, model: str) -> dict:
        """保存/替换个人配置；model 为空表示“不改动已保存的模型”。"""
        with self.lock:
            record = self.model_record()
            if api_key:
                record["key"] = self._box().seal(api_key, self.uid)
            elif not (isinstance(record.get("key"), dict) and record["key"].get("ct")):
                raise ValueError("请输入 API Key。")
            if model:
                record["model"] = model
            elif not (isinstance(record.get("model"), str) and record["model"]):
                record["model"] = DEFAULT_MODEL
            record["updated_at"] = int(time.time())
            record["version"] = 1
            _atomic_write(self.model_path,
                          json.dumps(record, ensure_ascii=False, sort_keys=True, indent=2).encode("utf-8"))
            return record

    def model_name(self) -> str:
        """已保存的模型名（不需要解密 Key），用于“只换 Key 不改模型”的场景。"""
        record = self.model_record()
        value = record.get("model")
        return value if isinstance(value, str) and value else DEFAULT_MODEL

    def clear_model(self) -> None:
        with self.lock:
            try:
                self.model_path.unlink()
            except FileNotFoundError:
                pass
            except OSError:
                raise ValueError("清除没有完成，请稍后重试。") from None

    def model_target(self) -> dict | None:
        """给 worker 用：返回可用的个人模型目标；没配就返回 None。"""
        record = self.model_record()
        sealed = record.get("key")
        if not isinstance(sealed, dict) or not sealed.get("ct"):
            return None
        api_key = self._box().unseal(sealed, self.uid)
        model = record.get("model") if isinstance(record.get("model"), str) and record.get("model") else DEFAULT_MODEL
        return {"base_url": USER_MODEL_BASE, "api_key": api_key, "model": model, "source": "user"}

    def _box(self) -> SecretBox:
        provider = self.secret_box
        if provider is None:
            raise SecretUnavailable(SETTINGS_UNAVAILABLE)
        if isinstance(provider, SecretBox):
            return provider
        return provider()  # 传进来的提供者在没装依赖时抛 SecretUnavailable
