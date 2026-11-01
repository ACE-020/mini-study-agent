"""通过兼容 Chat Completions 的接口请求模型；不依赖第三方库。"""

#主要是和大模型相关

import json
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


#为这里的报错定义一个名字
class ModelError(RuntimeError):
    pass


class ModelClient:
    def __init__(self, base_url, api_key, model, timeout=30, retries=2):
        if not all((base_url, api_key, model)): #如果参数不齐
            raise ModelError("请先在网页的‘模型设置’中保存 API Key，或设置 LLM_* 环境变量。")
        #将参数保存为属性
        self.url = base_url.rstrip("/") + "/chat/completions"
        #拼接最终端点。rstrip("/") 去掉 base_url 末尾可能多余的 /，避免出现 //chat/completions。
        #所以最终调用的是 OpenAI 风格的 POST {base_url}/chat/completions。
        self.api_key = api_key
        self.model = model
        self.timeout = timeout
        self.retries = retries

    @classmethod
    def from_env(cls):
        from settings import SettingsStore, load_user_environment
        load_user_environment() #检测用户是否在环境变量、注册表中更改
        config = SettingsStore().resolve() #获取配置文件
        return cls(config["base_url"], config["api_key"], config["model"], timeout=120)

    def complete(self, messages, tools=None, cancel_token=None):
        body = {"model": self.model, "messages": messages, "stream": False}
        if tools:
            body.update(tools=tools, tool_choice="auto")
            #body.update()等价于
                #body["tools"] = tools
                #body["tool_choice"] = "auto"
        payload = json.dumps(body).encode("utf-8") #读json
        for attempt in range(self.retries + 1): #重试循环
            if cancel_token: 
                cancel_token.check()#如果cancel_token，报错
            request = Request(self.url, data=payload, headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + self.api_key,
            }) #请求
            try:
                with urlopen(request, timeout=self.timeout) as response:
                    body = json.load(response)
                #发起请求，等待相应
                if cancel_token:
                    cancel_token.check()#如果cancel_token，报错
                message = body["choices"][0]["message"] #获取消息
                #报错
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
