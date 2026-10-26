"""通过兼容 Chat Completions 的接口请求模型；不依赖第三方库。"""

import json
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class ModelError(RuntimeError):
    pass


class ModelClient:
    def __init__(self, base_url, api_key, model, timeout=30, retries=2):
        if not all((base_url, api_key, model)):
            raise ModelError("请先在网页的‘模型设置’中保存 API Key，或设置 LLM_* 环境变量。")
        self.url = base_url.rstrip("/") + "/chat/completions"
        self.api_key = api_key
        self.model = model
        self.timeout = timeout
        self.retries = retries

    @classmethod
    def from_env(cls):
        from settings import SettingsStore, load_user_environment
        load_user_environment()
        config = SettingsStore().resolve()
        return cls(config["base_url"], config["api_key"], config["model"], timeout=120)

    def complete(self, messages, tools=None, cancel_token=None):
        body = {"model": self.model, "messages": messages, "stream": False}
        if tools:
            body.update(tools=tools, tool_choice="auto")
        payload = json.dumps(body).encode("utf-8")
        for attempt in range(self.retries + 1):
            if cancel_token:
                cancel_token.check()
            request = Request(self.url, data=payload, headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + self.api_key,
            })
            try:
                with urlopen(request, timeout=self.timeout) as response:
                    body = json.load(response)
                if cancel_token:
                    cancel_token.check()
                message = body["choices"][0]["message"]
                if not isinstance(message, dict) or message.get("role") != "assistant":
                    raise ValueError("无效的 assistant 消息")
                return message
            except HTTPError as exc:
                # 不输出请求头或服务端原始正文，避免把密钥写进错误信息。
                code = exc.code
                exc.close()
                if code not in (408, 429) and not 500 <= code < 600:
                    raise ModelError(f"模型 API 返回 HTTP {code}；请检查配置或账户权限。") from None
                failure = f"模型 API 暂不可用（HTTP {code}）"
            except (URLError, TimeoutError, OSError):
                failure = "模型请求超时或网络连接失败"
            except (ValueError, KeyError, IndexError, TypeError):
                raise ModelError("模型 API 返回的内容不符合预期格式。") from None
            if attempt == self.retries:
                raise ModelError(f"{failure}，已用完 {self.retries} 次重试。")
            delay = 0.5 * (2 ** attempt)
            if cancel_token:
                cancel_token.wait(delay)
            else:
                time.sleep(delay)
