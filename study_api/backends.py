"""模型后端：决定“对话/识图”由谁完成。

`LocalBackend` 用真实的 `ModelClient`（读本机配置）；
`ScriptedBackend` 接收一个 `complete(messages, tools)` 可调用对象，便于离线测试、接入自研模型
或把请求转发给别的服务。两者都实现 `ModelBackend.new_client()` 与 `new_reader()`。
"""

from typing import Callable, Optional

from llm import ModelClient
from ocr import ImageReader
from settings import SettingsStore


class ModelBackend:
    """模型后端的抽象接口。"""

    def new_client(self) -> ModelClient:
        """返回用于“整理/对话”的模型客户端。"""
        raise NotImplementedError

    def new_reader(self):
        """返回用于“图片转写”的识别器（需实现 read(raw, cancel_token=...)）。"""
        raise NotImplementedError


class LocalBackend(ModelBackend):
    """使用本机配置（.local-settings.json / 环境变量）的真实模型。"""

    def __init__(self, settings: SettingsStore):
        self.settings = settings

    def resolve(self):
        return self.settings.resolve()

    def new_client(self) -> ModelClient:
        config = self.resolve()
        return ModelClient(config["base_url"], config["api_key"], config["model"], timeout=120)

    def new_reader(self):
        config = self.resolve()
        client = ModelClient(config["ocr_base_url"], config["ocr_api_key"], config["ocr_model"], timeout=60)
        return ImageReader(client)


class ScriptedBackend(ModelBackend):
    """可注入的假模型 / 自研模型。

    complete 的签名与 `ModelClient.complete` 一致：`complete(messages, tools=None)`，
    返回 OpenAI 风格的 assistant 消息字典（含 `content` 或 `tool_calls`）。
    若同时提供 `complete_with_tools(messages, tool_names)`，StudyAgent 会优先调用它，
    并把“当前本轮允许使用的工具名”传进来（例如 view=analysis 时只有 delete/merge）。
    """

    def __init__(self, complete: Callable, reader: Optional[Callable] = None,
                 complete_with_tools: Optional[Callable] = None):
        self._complete = complete
        self.reader = reader
        self.complete_with_tools = complete_with_tools

    def complete(self, messages, tools=None):
        """与 ModelClient.complete 同签名，供拆题/校正等单次调用。"""
        return self._complete(messages, tools)

    def new_client(self):
        return _CallableClient(self.complete, self.complete_with_tools)

    def new_reader(self):
        if self.reader is None:
            raise RuntimeError("ScriptedBackend 没有配置 reader，无法进行图片转写")
        return _CallableReader(self.reader)


class _CallableClient:
    """把普通可调用对象包装成 ModelClient 形状（既有 complete，也不是具体 ModelClient 类型）。"""

    def __init__(self, complete, complete_with_tools=None):
        self.complete = complete
        if callable(complete_with_tools):
            self.complete_with_tools = complete_with_tools


class _CallableReader:
    def __init__(self, read):
        self._read = read

    def read(self, raw, cancel_token=None):
        return self._read(raw, cancel_token=cancel_token)


class BackendSession(ModelBackend):
    """给一次调用临时“覆盖”后端：with 结束后自动还原。"""

    def __init__(self, owner, backend: ModelBackend):
        self.owner = owner
        self.backend = backend
        self.previous = None

    def __enter__(self):
        self.previous = self.owner._backend
        self.owner._backend = self.backend
        return self.backend

    def __exit__(self, exc_type, exc, tb):
        self.owner._backend = self.previous
        return False

    def new_client(self):  # pragma: no cover - 仅用于类型完整
        return self.backend.new_client()

    def new_reader(self):  # pragma: no cover
        return self.backend.new_reader()
