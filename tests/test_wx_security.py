"""内容安全的边界：v1 的 87014、v2 的 result.suggest、接口故障放行。"""

import json
import unittest
from unittest.mock import patch

import wx_security


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return json.dumps(self.payload, ensure_ascii=False).encode("utf-8")


class ContentSecurityTests(unittest.TestCase):
    def security(self):
        instance = wx_security.ContentSecurity("wx-app", "secret", True)
        instance._access_token = lambda: "token"
        return instance

    def check(self, payload):
        with patch.object(wx_security, "urlopen", return_value=FakeResponse(payload)):
            return self.security().check_text("o-user", "测试内容")

    def test_v2_risky_is_blocked(self):
        allowed, message = self.check({"errcode": 0, "result": {"suggest": "risky", "label": 20001}})
        self.assertFalse(allowed)
        self.assertIn("敏感", message)

    def test_v2_pass_is_allowed(self):
        self.assertEqual(self.check({"errcode": 0, "result": {"suggest": "pass", "label": 100}}),
                         (True, ""))

    def test_v2_review_is_allowed_but_logged(self):
        self.assertEqual(self.check({"errcode": 0, "result": {"suggest": "review"}}), (True, ""))

    def test_v1_errcode_is_blocked(self):
        allowed, _ = self.check({"errcode": 87014})
        self.assertFalse(allowed)

    def test_other_errcode_is_allowed(self):
        self.assertEqual(self.check({"errcode": 40001}), (True, ""))

    def test_network_failure_fails_open(self):
        with patch.object(wx_security, "urlopen", side_effect=OSError("boom")):
            self.assertEqual(self.security().check_text("o-user", "内容"), (True, ""))

    def test_disabled_without_credentials(self):
        instance = wx_security.ContentSecurity("", "", True)
        self.assertFalse(instance.enabled)
        self.assertEqual(instance.check_text("o-user", "内容"), (True, ""))


if __name__ == "__main__":
    unittest.main()
