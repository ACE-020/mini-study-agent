"""图片只用于文字转写，不解题、不保存错题；复用兼容图片输入的模型接口。"""

import base64
from io import BytesIO

from PIL import Image, ImageOps, UnidentifiedImageError

from llm import ModelClient, ModelError
from cancellation import interruptible
from prompts import OCR_PROMPT


MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000


def prepare_image(raw):
    if not raw:
        raise ValueError("请选择一张作业图片。")
    if len(raw) > MAX_IMAGE_BYTES:
        raise ValueError("图片超过 8 MB，请压缩后重试。")
    try:
        with Image.open(BytesIO(raw)) as source:
            if source.format not in ("JPEG", "PNG", "WEBP"):
                raise ValueError("请选择 JPG、PNG 或 WebP 图片。")
            if source.width * source.height > MAX_IMAGE_PIXELS:
                raise ValueError("图片分辨率过高，请裁剪到需要识别的题目区域。")
            if getattr(source, "is_animated", False):
                raise ValueError("请上传单张静态图片。")
            source.load()
            image = ImageOps.exif_transpose(source)
            if image.mode in ("RGBA", "LA", "P"):
                rgba = image.convert("RGBA")
                image = Image.new("RGB", rgba.size, "white")
                image.paste(rgba, mask=rgba.getchannel("A"))
            else:
                image = image.convert("RGB")
            image.thumbnail((3000, 3000))
            buffer = BytesIO()
            image.save(buffer, format="JPEG", quality=95, exif=b"")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        raise ValueError("无法读取这张图片，请重新导出为 JPG 或 PNG 后上传。") from None
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


class ImageReader:
    def __init__(self, client):
        self.client = client

    @classmethod
    def from_env(cls):
        from settings import SettingsStore, load_user_environment
        load_user_environment()
        config = SettingsStore().resolve()
        return cls(ModelClient(
            config["ocr_base_url"], config["ocr_api_key"], config["ocr_model"],
            timeout=60,
        ))

    def read(self, raw, cancel_token=None):
        if cancel_token:
            cancel_token.check()
        data_url = prepare_image(raw)
        messages = [
            {"role": "system", "content": OCR_PROMPT},
            {"role": "user", "content": [
                {"type": "text", "text": "请转写这张作业图片，保留原有内容。"},
                {"type": "image_url", "image_url": {"url": data_url, "detail": "high"}},
            ]},
        ]
        def request_message():
            if isinstance(self.client, ModelClient):
                return self.client.complete(messages, tools=None, cancel_token=cancel_token)
            return self.client.complete(messages, tools=None)
        message = interruptible(request_message, cancel_token)
        text = message.get("content")
        if not isinstance(text, str) or not text.strip():
            raise ModelError("未识别到文字，请换一张更清晰的图片，或直接输入文字。")
        return text.strip()
