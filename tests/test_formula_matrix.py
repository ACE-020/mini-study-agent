"""formula_matrix：描述 → 矩阵 LaTeX 的提示词拼装与结果校验。

这里全部用替身模型，不产生真实 API 调用。
"""

import json
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from formula_matrix import (
    ALLOWED_ENVIRONMENTS,
    MAX_DESCRIPTION_LENGTH,
    MAX_LATEX_LENGTH,
    build_messages,
    extract_latex,
    generate,
    validate_description,
    validate_latex,
)
from web import create_app
from llm import ModelClient

PMATRIX = r"\begin{pmatrix}1&0\\0&1\end{pmatrix}"
VMATRIX = r"\begin{vmatrix}a&b\\c&d\end{vmatrix}"


class FakeModel:
    """和 ModelClient.complete 一样返回 message 字典。"""

    def __init__(self, reply):
        self.reply = reply
        self.requests = []

    def complete(self, messages, tools=None):
        self.requests.append(messages)
        return self.reply


class ObjectModel:
    """少数调用方用对象形式返回，确认也能接住。"""

    class Reply:
        def __init__(self, content):
            self.content = content

    def complete(self, messages, tools=None):
        return self.Reply(PMATRIX)


class ExtractTests(unittest.TestCase):
    def test_strips_code_fence(self):
        self.assertEqual(extract_latex("```latex\n" + PMATRIX + "\n```"), PMATRIX)

    def test_strips_plain_fence(self):
        self.assertEqual(extract_latex("```\n" + PMATRIX + "\n```"), PMATRIX)

    def test_strips_dollar_signs(self):
        self.assertEqual(extract_latex("$" + PMATRIX + "$"), PMATRIX)
        self.assertEqual(extract_latex("$$" + PMATRIX + "$$"), PMATRIX)

    def test_keeps_plain_latex(self):
        self.assertEqual(extract_latex("  " + VMATRIX + "  "), VMATRIX)


class ValidateLatexTests(unittest.TestCase):
    def test_accepts_pmatrix_and_vmatrix(self):
        self.assertEqual(validate_latex(PMATRIX), PMATRIX)
        self.assertEqual(validate_latex(VMATRIX), VMATRIX)

    def test_accepts_all_allowed_environments(self):
        for environment in ALLOWED_ENVIRONMENTS:
            latex = "\\begin{" + environment + "}1&2\\\\3&4\\end{" + environment + "}"
            self.assertEqual(validate_latex(latex), latex)

    def test_rejects_empty(self):
        with self.assertRaises(ValueError):
            validate_latex("")

    def test_rejects_model_error_marker(self):
        with self.assertRaises(ValueError) as ctx:
            validate_latex("ERROR")
        self.assertIn("没法转成矩阵", str(ctx.exception))

    def test_rejects_unsupported_environment(self):
        with self.assertRaises(ValueError):
            validate_latex("\\begin{tabular}1&2\\\\3&4\\end{tabular}")

    def test_rejects_plain_text(self):
        with self.assertRaises(ValueError):
            validate_latex("这是一个矩阵")

    def test_rejects_forbidden_commands(self):
        # 白名单模式下这些一律是「未列出的命令」，都会被拒
        for bad in ("\\input{/etc/passwd}", "\\write18{rm -rf /}", "\\usepackage{evil}"):
            latex = "\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}" + bad
            with self.assertRaises(ValueError, msg=bad):
                validate_latex(latex)

    def test_rejects_macro_definitions(self):
        # review 意见 1：原来的黑名单漏了 \def / \newcommand 这类宏定义
        for bad in ("\\def\\x{1}", "\\newcommand{\\y}{2}", "\\renewcommand{\\z}{3}",
                    "\\let\\a\\b", "\\catcode`\\@=11"):
            latex = "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}" + bad
            with self.assertRaises(ValueError, msg=bad):
                validate_latex(latex)

    def test_unknown_command_is_named_in_error(self):
        with self.assertRaises(ValueError) as ctx:
            validate_latex("\\begin{pmatrix}\\foo&1\\\\2&3\\end{pmatrix}")
        self.assertIn("\\foo", str(ctx.exception))

    def test_accepts_one_by_one(self):
        # review 意见 2：一阶行列式是单个元素，不该被「缺少 & 或换行」误杀
        latex = r"\begin{vmatrix}a\end{vmatrix}"
        self.assertEqual(validate_latex(latex), latex)
        one = r"\begin{vmatrix}2\end{vmatrix}"
        self.assertEqual(validate_latex(one), one)

    def test_rejects_ragged_rows(self):
        with self.assertRaises(ValueError):
            validate_latex(r"\begin{pmatrix}1&2\\3\end{pmatrix}")

    def test_accepts_common_math_commands(self):
        latex = r"\begin{pmatrix}\frac{1}{2}&\sqrt{3}\\\alpha&x^{2}\le\infty\end{pmatrix}"
        self.assertEqual(validate_latex(latex), latex)

    def test_accepts_realistic_model_output(self):
        latex = (
            r"\begin{vmatrix}1&0&\cdots&0\\0&1&\cdots&0\\"
            r"\vdots&\vdots&\ddots&\vdots\\0&0&\cdots&1\end{vmatrix}"
        )
        self.assertEqual(validate_latex(latex), latex)

    def test_accepts_spacing_and_row_separator(self):
        latex = r"\begin{pmatrix}1&2\\[2pt]3&4\end{pmatrix}"
        self.assertEqual(validate_latex(latex), latex)

    def test_rejects_two_environments(self):
        latex = PMATRIX + PMATRIX
        with self.assertRaises(ValueError):
            validate_latex(latex)

    def test_rejects_too_long(self):
        latex = "\\begin{pmatrix}" + ("1&" * MAX_LATEX_LENGTH) + "\\end{pmatrix}"
        with self.assertRaises(ValueError):
            validate_latex(latex)

    def test_rejects_body_without_separators(self):
        # 单格现在合法（1×1），但「一格都没有」仍然要拒
        with self.assertRaises(ValueError):
            validate_latex(r"\begin{pmatrix}\end{pmatrix}")


class DescriptionTests(unittest.TestCase):
    def test_requires_text(self):
        for bad in ("", "   ", None):
            with self.assertRaises(ValueError):
                validate_description(bad, "matrix")

    def test_rejects_too_long(self):
        with self.assertRaises(ValueError):
            validate_description("描" * (MAX_DESCRIPTION_LENGTH + 1), "matrix")

    def test_rejects_unknown_kind(self):
        with self.assertRaises(ValueError):
            validate_description("单位矩阵", "tensor")

    def test_trims(self):
        self.assertEqual(validate_description("  单位矩阵 ", "matrix"), ("单位矩阵", "matrix"))


class PromptTests(unittest.TestCase):
    def test_prompt_carries_kind_and_description(self):
        messages = build_messages("主对角线为 1", "determinant")
        self.assertEqual(messages[0]["role"], "system")
        self.assertIn("\\cdots", messages[0]["content"])
        self.assertEqual(messages[1]["role"], "user")
        self.assertIn("行列式", messages[1]["content"])
        self.assertIn("主对角线为 1", messages[1]["content"])

    def test_prompt_forbids_explanation(self):
        system = build_messages("单位矩阵", "matrix")[0]["content"]
        self.assertIn("只输出一个 LaTeX 矩阵环境", system)


class GenerateTests(unittest.TestCase):
    def test_returns_validated_latex(self):
        model = FakeModel({"role": "assistant", "content": "```latex\n" + PMATRIX + "\n```"})
        self.assertEqual(generate(model, "2 阶单位矩阵", "matrix"), PMATRIX)

    def test_accepts_object_reply(self):
        self.assertEqual(generate(ObjectModel(), "2 阶单位矩阵", "matrix"), PMATRIX)

    def test_raises_on_error_marker(self):
        model = FakeModel({"role": "assistant", "content": "ERROR"})
        with self.assertRaises(ValueError):
            generate(model, "随便写点什么", "matrix")

    def test_raises_on_empty_reply(self):
        model = FakeModel({"role": "assistant", "content": ""})
        with self.assertRaises(ValueError):
            generate(model, "2 阶单位矩阵", "matrix")

    def test_handles_multipart_content(self):
        model = FakeModel({"role": "assistant", "content": [{"type": "text", "text": PMATRIX}]})
        self.assertEqual(generate(model, "2 阶单位矩阵", "matrix"), PMATRIX)


class RouteTests(unittest.TestCase):
    def make_client(self, reply):
        with tempfile.TemporaryDirectory() as tmp:
            app = create_app(
                Path(tmp) / "data",
                client_factory=lambda: FakeModel(reply),
                settings_path=Path(tmp) / "settings.json",
                local_ocr_runtime=False,
            )
            return app.test_client()

    def test_returns_latex(self):
        client = self.make_client({"role": "assistant", "content": PMATRIX})
        response = client.post("/api/formula/matrix", json={"description": "2 阶单位矩阵", "kind": "matrix"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["latex"], PMATRIX)

    def test_rejects_empty_description(self):
        client = self.make_client({"role": "assistant", "content": PMATRIX})
        response = client.post("/api/formula/matrix", json={"description": "  ", "kind": "matrix"})
        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.get_json()["ok"])

    def test_rejects_bad_payload(self):
        client = self.make_client({"role": "assistant", "content": PMATRIX})
        response = client.post("/api/formula/matrix", json=["not", "a", "dict"])
        self.assertEqual(response.status_code, 400)

    def test_model_error_is_reported(self):
        client = self.make_client({"role": "assistant", "content": "ERROR"})
        response = client.post("/api/formula/matrix", json={"description": "说不清的东西", "kind": "matrix"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("没法转成矩阵", response.get_json()["error"])

    def test_matrix_uses_short_request_budget_and_official_deepseek_non_thinking(self):
        payload = {"description": "2 阶单位矩阵", "kind": "matrix"}
        for base_url, model, expected_thinking in (
            ("https://api.deepseek.com/v1", "deepseek-v4-pro", {"type": "disabled"}),
            ("https://api.deepseek.com", "deepseek-flash", {"type": "disabled"}),
            ("https://example.invalid/v1", "deepseek-v4-pro", None),
        ):
            with self.subTest(base_url=base_url, model=model), tempfile.TemporaryDirectory() as tmp:
                config = {"base_url": base_url, "model": model, "api_key": "fixture-key"}
                response_body = {"choices": [{"message": {"role": "assistant", "content": PMATRIX}}]}
                with patch("web.SettingsStore.resolve", return_value=config), patch.object(
                    ModelClient, "_open", autospec=True,
                    return_value=BytesIO(json.dumps(response_body).encode("utf-8")),
                ) as send:
                    app = create_app(Path(tmp), local_ocr_runtime=False)
                    try:
                        response = app.test_client().post("/api/formula/matrix", json=payload)
                        self.assertEqual(response.status_code, 200)
                        send.assert_called_once()
                        client, request = send.call_args.args
                        self.assertEqual((client.timeout, client.retries), (20, 0))
                        body = json.loads(request.data)
                        self.assertEqual(body["model"], model)
                        self.assertEqual(body.get("thinking"), expected_thinking)
                    finally:
                        app.extensions["stop_background"]()


if __name__ == "__main__":
    unittest.main()
