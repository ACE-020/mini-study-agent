"""formula_matrix：描述 → 矩阵 LaTeX 的提示词拼装与结果校验。

这里全部用替身模型，不产生真实 API 调用。
"""

import tempfile
import unittest
from pathlib import Path

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
        for bad in ("\\input{/etc/passwd}", "\\write18{rm -rf /}", "\\usepackage{evil}"):
            latex = "\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}" + bad
            with self.assertRaises(ValueError, msg=bad):
                validate_latex(latex)

    def test_rejects_two_environments(self):
        latex = PMATRIX + PMATRIX
        with self.assertRaises(ValueError):
            validate_latex(latex)

    def test_rejects_too_long(self):
        latex = "\\begin{pmatrix}" + ("1&" * MAX_LATEX_LENGTH) + "\\end{pmatrix}"
        with self.assertRaises(ValueError):
            validate_latex(latex)

    def test_rejects_body_without_separators(self):
        with self.assertRaises(ValueError):
            validate_latex("\\begin{pmatrix}1\\end{pmatrix}")


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


if __name__ == "__main__":
    unittest.main()
