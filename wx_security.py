"""微信内容安全：用户输入先过官方检测，再进模型。

小程序面向公众时必须做这一步（《微信小程序平台运营规范》与生成式 AI 相关要求）。
默认关闭，设置 WX_CONTENT_CHECK=1 后启用；未配置 AppID/Secret 时自动跳过。

设计取舍：
* 网络或微信接口故障时**放行**并记日志，避免整站不可用；
* 明确命中风险内容（errcode 87014）时**拒绝**，并把原话提示给用户。
"""

from __future__ import annotations

import json
import logging
import threading
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

LOG = logging.getLogger("wx_security")


class ContentSecurity:
    def __init__(self, appid: str = "", secret: str = "", enabled: bool = False):
        self.appid = appid
        self.secret = secret
        self.enabled = bool(enabled and appid and secret)
        self._lock = threading.Lock()
        self._token = ""
        self._expires = 0.0

    def status(self) -> dict:
        return {"enabled": self.enabled}

    def _access_token(self) -> str:
        with self._lock:
            if self._token and time.time() < self._expires - 60:
                return self._token
            query = urlencode({"grant_type": "client_credential", "appid": self.appid,
                               "secret": self.secret})
            request = Request("https://api.weixin.qq.com/cgi-bin/token?" + query)
            with urlopen(request, timeout=6) as response:
                data = json.load(response)
            token = data.get("access_token") if isinstance(data, dict) else None
            if not token:
                raise ValueError(f"获取 access_token 失败 errcode={data.get('errcode')}")
            self._token = token
            self._expires = time.time() + int(data.get("expires_in", 7200))
            return token

    def check_text(self, openid: str, text: str) -> tuple[bool, str]:
        """返回 (是否通过, 提示)。接口故障时按通过处理。"""
        if not self.enabled or not openid:
            return True, ""
        try:
            token = self._access_token()
            body = json.dumps({"content": text, "version": 2, "scene": 2, "openid": openid},
                              ensure_ascii=False).encode("utf-8")
            request = Request("https://api.weixin.qq.com/wxa/msg_sec_check?access_token=" + token,
                              data=body, headers={"Content-Type": "application/json"})
            with urlopen(request, timeout=8) as response:
                data = json.load(response)
        except Exception as exc:  # 网络异常、解析异常都不该让用户用不了
            LOG.warning("内容安全接口不可用：%s", type(exc).__name__)
            return True, ""
        if not isinstance(data, dict):
            return True, ""
        if data.get("errcode") == 87014:
            return False, "这段内容可能涉及敏感信息，换一种说法再试。"
        if data.get("errcode"):
            LOG.warning("msg_sec_check 返回 errcode=%s", data.get("errcode"))
        return True, ""
