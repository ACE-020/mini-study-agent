import json
from pathlib import Path
import subprocess
import sys
import unittest

# 项目根目录（tests 的上一级）：用于定位 openapi.json
ROOT = Path(__file__).resolve().parents[1]


class OpenApiCoverageTests(unittest.TestCase):
    """openapi.json 必须覆盖 web.py 里的全部 /api 路由，并带有基础说明。"""

    @classmethod
    def setUpClass(cls):
        cls.spec = json.loads((ROOT / "openapi.json").read_text(encoding="utf-8"))

    def test_generated_spec_is_up_to_date(self):
        # 生成脚本可直接执行：它只读取源码里的路由，不启动服务、不调用模型
        result = subprocess.run([sys.executable, str(ROOT / "tools" / "generate_openapi.py"), "--check"],
                                capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=str(ROOT))
        self.assertEqual(result.returncode, 0, (result.stdout or "") + (result.stderr or ""))

    def test_spec_is_openapi_31_and_has_metadata(self):
        self.assertEqual(self.spec["openapi"], "3.1.0")
        self.assertEqual(self.spec["info"]["title"], "知错 · 学习整理助手 API")
        self.assertIn("servers", self.spec)
        self.assertTrue(self.spec["servers"][0]["url"].startswith("http://127.0.0.1"))
        # 全部接口都需要本机会话 Cookie
        self.assertIn("sessionCookie", self.spec["components"]["securitySchemes"])

    def test_every_api_route_is_documented(self):
        # 收集 web.py 源码里的所有 /api 路由（含同一函数的多个装饰器）
        source = (ROOT / "web.py").read_text(encoding="utf-8")
        import re
        routes = set()
        current = None
        for line in source.splitlines():
            match = re.match(r'\s*@app\.(?:get|post|route)\("(/api/[^"]*)"', line)
            if match:
                current = match.group(1)
                routes.add(current)
                continue
            match = re.match(r'\s*@app\.route\("([^"]*)", methods=\[([^\]]*)\]', line)
            if match and match.group(1).startswith("/api/"):
                routes.add(match.group(1))
        paths = set(self.spec["paths"])
        missing = sorted(routes - paths)
        extra = sorted(paths - routes)
        self.assertEqual(missing, [], "openapi.json 缺少这些路由：" + ", ".join(missing))
        self.assertEqual(extra, [], "openapi.json 含有源码中不存在的路由：" + ", ".join(extra))

    def test_operations_have_summary_tags_and_error_schema(self):
        for path, item in self.spec["paths"].items():
            for method, operation in item.items():
                if method not in ("get", "post", "put", "delete", "patch"):
                    continue
                with self.subTest(path=path, method=method):
                    self.assertTrue(operation.get("summary"), f"{method.upper()} {path} 缺少 summary")
                    self.assertTrue(operation.get("tags"), f"{method.upper()} {path} 缺少 tags")
                    # 每个接口都要有成功响应，非 2xx 一律是统一的错误信封
                    responses = operation.get("responses", {})
                    success = [code for code in responses if str(code).startswith("2")]
                    self.assertTrue(success, f"{method.upper()} {path} 缺少成功响应")
                    for code, response in responses.items():
                        if str(code).startswith("2"):
                            continue
                        self.assertIn("content", response, f"{path} {code} 必须是 JSON 错误响应")
                        ref = response["content"]["application/json"]["schema"].get("$ref", "")
                        self.assertTrue(ref.endswith("ErrorResponse"), f"{path} {code} 未引用 ErrorResponse")

    def test_shared_schemas_exist(self):
        schemas = self.spec["components"]["schemas"]
        for name in ("ErrorResponse", "RecordRef", "Note", "Mistake", "Exercise", "StudyEvent",
                     "Proposal", "CurrentQuestion", "MaterialJob", "Settings", "PublicSettings",
                     "SettingsResponse"):
            self.assertIn(name, schemas, f"缺少共享模型 {name}")

    def test_settings_endpoints_share_response_schema(self):
        # GET/POST /api/settings 与 /api/settings/model 的 200 都返回 {ok, settings:{...}}
        for path, method in (("/api/settings", "get"), ("/api/settings", "post"), ("/api/settings/model", "post")):
            schema = self.spec["paths"][path][method]["responses"]["200"]["content"]["application/json"]["schema"]
            self.assertEqual(schema["$ref"], "#/components/schemas/SettingsResponse", f"{method.upper()} {path}")
        # 对外配置永远不含密钥字段
        public = self.spec["components"]["schemas"]["PublicSettings"]["properties"]
        self.assertNotIn("api_key", public)
        self.assertNotIn("ocr_api_key", public)


if __name__ == "__main__":
    unittest.main()
