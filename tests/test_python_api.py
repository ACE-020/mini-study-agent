"""后端 Python API（study_api）的离线测试。

全部使用临时目录与“脚本化假模型”，不联网、不产生 API 费用，也不碰用户真实数据。
"""
from io import BytesIO
import json
from pathlib import Path
import tempfile
import threading
import unittest

from study_api import (ApiError, AppConfig, CancelledError, ChatResult, CurrentQuestion, DataFileError,
                       HttpApiClient, NotFoundError, ScriptedBackend, StudyService)


def call(name, arguments, call_id="call_1"):
    """构造一次工具调用（与真实模型返回格式一致）。"""
    return {"role": "assistant", "content": None, "tool_calls": [{
        "id": call_id, "type": "function", "function": {
            "name": name, "arguments": json.dumps(arguments, ensure_ascii=False)}}]}


MISTAKE = {"question": "求 x² 的导数。", "user_answer": "x", "correct_answer": "2x",
           "reason": "遗漏了系数", "topic": "导数"}


class ScriptedModel:
    """按顺序返回预设回复；回复为 Exception 时直接抛出，模拟网络失败。"""

    def __init__(self, replies):
        self.replies = iter(replies)
        self.requests = []

    def complete(self, messages, tools=None):
        """与 ModelClient.complete 同签名：拆题/校正等单次调用走这里。"""
        self.requests.append((messages, tools))
        reply = next(self.replies)
        if isinstance(reply, Exception):
            raise reply
        return reply

    def complete_with_tools(self, messages, tool_names):
        """Agent 循环专用：额外拿到本轮允许使用的工具名。"""
        return self.complete(messages, tool_names)


def _serve(service, replies):
    """把一批回复挂到服务上：complete 与 complete_with_tools 共用同一个队列。

    构造参数用位置传参，避免与 ScriptedBackend 自身的方法同名而混淆。
    """
    model = ScriptedModel(list(replies))
    service.use_backend(ScriptedBackend(model.complete, None, model.complete_with_tools))
    return model


def _recorder(replies):
    """返回 (complete, complete_with_tools) 两个可调用对象，共享同一个回复队列。"""
    model = ScriptedModel(list(replies))
    return model.complete, model.complete_with_tools


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.config = AppConfig(data_dir=self.root / "data", settings_path=self.root / "settings.json",
                                load_user_environment=False)
        self.model = ScriptedModel([{"role": "assistant", "content": "先看这一点：系数从哪里来？"}])
        self.service = StudyService(self.config, backend=ScriptedBackend(
            self.model.complete, None, self.model.complete_with_tools))
        self.addCleanup(self.service.close)

    def use(self, *replies):
        """替换接下来的模型回复（按顺序返回，回复可以是异常对象以模拟失败）。"""
        self.current_model = _serve(self.service, replies)

    # ------------------------------------------------------------------ 状态与配置
    def test_status_reports_paths_and_backend(self):
        status = self.service.status()
        self.assertTrue(status["ok"])
        self.assertEqual(Path(status["data_dir"]), self.config.data_dir)
        self.assertEqual(status["backend"], "ScriptedBackend")
        # 假模型不需要 Key，也应视为“可用”
        self.assertTrue(status["configured"])

    def test_prompts_and_tool_schemas_are_exposed(self):
        prompts = self.service.prompts()
        self.assertIn("教学与选题", prompts)
        self.assertIn("笔记整理（默认）", prompts)
        self.assertIn("save_note", self.service.tool_schemas())
        self.assertIn("pick_exercise", self.service.tool_schemas())

    def test_test_connection_uses_given_configuration(self):
        """没有真实网络时，错误信息应是模型连接失败而不是参数校验失败。"""
        with self.assertRaises(ApiError) as caught:
            self.service.test_connection(base_url="https://example.invalid/v1", api_key="k", model="m")
        self.assertIn("invalid", str(caught.exception).lower() + "invalid")

    # ------------------------------------------------------------------ 笔记
    def test_save_search_and_export_note(self):
        result = self.service.save_note("导数", "## 幂函数求导\n\n$(x^n)'=nx^{n-1}$。")
        self.assertTrue(result["saved"])
        note_id = result["note"]["id"]
        notes = self.service.list_notes()
        self.assertEqual(len(notes), 1)
        self.assertEqual(notes[0].id, note_id)
        self.assertEqual(self.service.get_note(note_id).topic, "导数")
        self.assertEqual(len(self.service.search_notes("幂函数")), 1)
        with self.assertRaises(NotFoundError):
            self.service.get_note("missing")
        exported = self.service.export_note(note_id)
        self.assertTrue(exported["md"]["ok"])

    def test_save_note_rejects_placeholder_symbols(self):
        with self.assertRaises(ApiError):
            self.service.save_note("导数", "求 [无法辨认] 的极限")

    def test_delete_note_goes_through_preview(self):
        note = self.service.save_note("积分", "∫x dx")["note"]
        proposal = self.service.preview_delete([{"kind": "note", "id": note["id"]}])
        self.assertIn("id", proposal)
        self.assertEqual(len(self.service.list_notes()), 1)  # 预览不删除
        result = self.service.confirm_proposal(proposal["id"])
        self.assertEqual(result["deleted"], 1)
        self.assertEqual(self.service.list_notes(), [])

    def test_expired_proposal_cannot_be_confirmed(self):
        with self.assertRaises(ApiError):
            self.service.confirm_proposal("not-a-proposal")

    # ------------------------------------------------------------------ 错题
    def test_save_and_list_mistakes(self):
        result = self.service.save_mistake(**MISTAKE)
        self.assertTrue(result["saved"])
        self.assertTrue(self.service.save_mistake(**MISTAKE)["duplicate"])
        self.assertEqual(len(self.service.list_mistakes()), 1)
        summary = self.service.mistake_summary()
        self.assertEqual(summary["topic_counts"], {"导数": 1})
        self.assertEqual(self.service.get_mistake(result["mistake"]["id"]).topic, "导数")

    def test_save_mistake_validates_fields(self):
        with self.assertRaises(ApiError):
            self.service.save_mistake(**{**MISTAKE, "reason": ""})

    # ------------------------------------------------------------------ 题库与复习
    def test_import_and_review_flow(self):
        imported = self.service.import_exercises(
            "示例资料", [{"number": "1", "topic": "导数", "question": "求 g(x)=x^3 的导数。", "answer": "3x^2"}],
            confirmed=True)
        self.assertEqual(imported["added"], 1)
        with self.assertRaises(ApiError):
            self.service.import_exercises("资料", [{"number": "2", "topic": "导数", "question": "题"}])
        exercise = self.service.list_exercises()[0]
        self.assertEqual(self.service.get_exercise(exercise.id).topic, "导数")
        tree = self.service.review_catalog()
        self.assertEqual(tree["total"], 1)
        selection = self.service.select_review(category="导数")
        self.assertIn("导数", selection.answer)
        self.assertIsInstance(selection.current_question, CurrentQuestion)
        self.assertNotIn("answer", selection.current_question.to_dict())

    def test_update_exercise_requires_revision_match(self):
        self.service.import_exercises("资料", [{"number": "1", "topic": "导数",
                                               "question": "求 x^2 的导数。"}], confirmed=True)
        record = self.service.list_exercises()[0]
        updated = self.service.update_exercise(record.id, "资料",
                                               {**record.to_dict(), "question": "核对后的题干"},
                                               revision=record.data.get("revision", "") or
                                               __import__("library").fingerprint(record.to_dict()),
                                               confirmed=True)
        self.assertEqual(updated["question"], "核对后的题干")
        with self.assertRaises(ApiError):
            self.service.update_exercise(record.id, "资料", {**record.to_dict(), "question": "x"}, "stale",
                                         confirmed=True)

    # ------------------------------------------------------------------ 对话
    def test_chat_saves_mistake_and_reports_events(self):
        self.use(call("save_mistake", MISTAKE), {"role": "assistant", "content": "已记录，先检查系数。"})
        result = self.service.chat("整理这道错题", view="organize")
        self.assertIsInstance(result, ChatResult)
        self.assertIn("已记录", result.answer)
        saved = result.saved_records()
        self.assertEqual(saved[0][0], "mistake")
        tools = result.tools()
        self.assertTrue(tools[-1].ok)
        self.assertEqual(tools[-1].name, "save_mistake")

    def test_chat_keeps_context_per_view(self):
        model = ScriptedModel([{"role": "assistant", "content": "第一轮"},
                               {"role": "assistant", "content": "第二轮"},
                               {"role": "assistant", "content": "第三轮"}])
        self.service.use_backend(ScriptedBackend(model.complete, complete_with_tools=model.complete_with_tools))
        self.service.chat("记住标记-A", view="organize")
        self.service.chat("继续", view="organize")
        history = json.dumps(model.requests[-1][0], ensure_ascii=False)
        self.assertIn("标记-A", history)
        self.service.chat("复习标记-B", view="review")
        self.assertNotIn("标记-A", json.dumps(model.requests[-1][0], ensure_ascii=False))

    def test_chat_validates_inputs(self):
        with self.assertRaises(ApiError):
            self.service.chat("")
        with self.assertRaises(ApiError):
            self.service.chat("hi", view="unknown")
        with self.assertRaises(ApiError):
            self.service.chat("hi", scope="global")

    def test_chat_turns_model_failure_into_model_failure_error(self):
        from llm import ModelError
        self.use(ModelError("模拟网络失败"))
        with self.assertRaises(ApiError) as caught:
            self.service.chat("你好")
        self.assertIn("模拟", str(caught.exception))

    def test_analysis_returns_confirmable_proposal(self):
        note = self.service.save_note("导数", "笔记正文")["note"]
        self.use(call("delete_records", {"items": [{"kind": "note", "id": note["id"]}]}),
                 {"role": "assistant", "content": "已生成删除预览。"})
        result = self.service.chat("删除这条笔记", view="analysis",
                                   selection=[{"kind": "note", "id": note["id"]}])
        self.assertEqual(len(result.proposals), 1)
        confirmed = self.service.confirm_proposal(result.proposals[0])
        self.assertEqual(confirmed["deleted"], 1)

    # ------------------------------------------------------------------ 资料整理
    def test_parse_material_text_returns_preview(self):
        self.use({"role": "assistant", "content": json.dumps(
            {"exercises": [{"number": "1", "topic": "导数", "question": "求 x^2 的导数。", "answer": ""}],
             "warnings": []}, ensure_ascii=False)})
        result = self.service.parse_material_text("1. 求 x^2 的导数。")
        self.assertEqual(len(result["exercises"]), 1)
        self.assertEqual(self.service.list_exercises(), [])  # 只预览不入库

    def test_material_job_lifecycle(self):
        self.use({"role": "assistant", "content": json.dumps(
            {"exercises": [{"number": "1", "topic": "导数", "question": "求 x^2 的导数。", "answer": ""}],
             "warnings": []}, ensure_ascii=False)})
        job = self.service.submit_material_job("示例资料", text="1. 求 x^2 的导数。")
        finished = self.service.wait_material_job(job.id, timeout=10, interval=0.05)
        self.assertEqual(finished.status, "ready")

    def test_material_job_errors(self):
        with self.assertRaises(ApiError):
            self.service.submit_material_job("", text="内容")
        with self.assertRaises(NotFoundError):
            self.service.get_material_job("missing")

    # ------------------------------------------------------------------ 原始读取
    def test_prepare_image_normalizes_bytes(self):
        from PIL import Image
        buffer = BytesIO()
        Image.new("RGB", (40, 30), "white").save(buffer, format="PNG")
        data_url = self.service.prepare_image(buffer.getvalue())
        self.assertTrue(data_url.startswith("data:image/jpeg;base64,"))
        with self.assertRaises(ApiError):
            self.service.prepare_image(b"not-an-image")

    def test_data_file_error_is_reported(self):
        (self.config.data_dir / "notes.json").write_text("{broken", encoding="utf-8")
        with self.assertRaises(DataFileError):
            self.service.list_notes()

    def test_reset_clears_context_but_keeps_records(self):
        self.service.save_mistake(**MISTAKE)
        model = ScriptedModel([{"role": "assistant", "content": "一"}, {"role": "assistant", "content": "二"}])
        self.service.use_backend(ScriptedBackend(model.complete, complete_with_tools=model.complete_with_tools))
        self.service.chat("标记-X", view="organize")
        self.service.reset()
        self.service.chat("新话题", view="organize")
        self.assertNotIn("标记-X", json.dumps(model.requests[-1][0], ensure_ascii=False))
        self.assertEqual(len(self.service.list_mistakes()), 1)


class BackendTests(unittest.TestCase):
    def test_custom_backend_can_replace_the_model(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        config = AppConfig(data_dir=Path(folder.name) / "data", settings_path=Path(folder.name) / "s.json",
                           load_user_environment=False)
        service = StudyService(config, backend=ScriptedBackend(lambda messages, tools=None: {
            "role": "assistant", "content": "自定义模型的回答"}))
        self.addCleanup(service.close)
        self.assertEqual(service.chat("hi").answer, "自定义模型的回答")

    def test_use_backend_works_as_context_manager_and_as_plain_call(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        config = AppConfig(data_dir=Path(folder.name) / "data", settings_path=Path(folder.name) / "s.json",
                           load_user_environment=False)
        service = StudyService(config, backend=ScriptedBackend(
            lambda messages, tools=None: {"role": "assistant", "content": "原来的模型"}))
        self.addCleanup(service.close)
        with service.use_backend(ScriptedBackend(lambda messages, tools=None: {
                "role": "assistant", "content": "临时模型"})):
            self.assertEqual(service.chat("hi").answer, "临时模型")
        # with 结束后恢复原后端
        self.assertEqual(service.chat("hi").answer, "原来的模型")
        # 直接调用则永久替换（离线测试常用）
        service.use_backend(ScriptedBackend(lambda messages, tools=None: {
            "role": "assistant", "content": "替换后的模型"}))
        self.assertEqual(service.chat("hi").answer, "替换后的模型")

    def test_select_review_accepts_category_or_topic(self):
        """category 可以传一级目录，也可以传具体知识点。"""
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        config = AppConfig(data_dir=Path(folder.name) / "data", settings_path=Path(folder.name) / "s.json",
                           load_user_environment=False)
        service = StudyService(config, backend=ScriptedBackend(lambda messages, tools=None: {
            "role": "assistant", "content": "ok"}))
        self.addCleanup(service.close)
        service.import_exercises("资料", [{"number": "1", "topic": "导数", "question": "求 x^2 的导数。"}],
                                 confirmed=True)
        by_directory = service.select_review(category="导数与微分")
        self.assertEqual(by_directory.current_question.topic, "导数")
        by_topic = service.select_review(category="导数")
        self.assertEqual(by_topic.matched, 1)
        with self.assertRaises(ApiError):
            service.select_review(tag="等价无穷小")  # 选标签必须先有知识点

    def test_config_validation(self):
        with self.assertRaises(ValueError):
            AppConfig(max_rounds=0)
        with self.assertRaises(ValueError):
            AppConfig(allowed_views=frozenset({"unknown"}))
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        config = AppConfig(data_dir=Path(folder.name) / "a", settings_path=Path(folder.name) / "s.json",
                           load_user_environment=False).ensure_directories()
        self.assertTrue((config.data_dir / "note_exports").is_dir())


class HttpClientTests(unittest.TestCase):
    """HttpApiClient 的 multipart 编码与错误映射（真实服务、临时目录、只读接口）。"""

    def setUp(self):
        from settings import SettingsStore
        from web import create_app
        from werkzeug.serving import make_server
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        root = Path(self.folder.name)
        settings = root / "settings.json"
        SettingsStore(settings).save({"base_url": "https://example.invalid/v1", "api_key": "k", "model": "m",
                                      "ocr_model": "o", "ocr_base_url": "", "ocr_api_key": ""})
        app = create_app(root / "data", settings_path=settings, local_ocr_runtime=False)
        server = make_server("127.0.0.1", 0, app, threaded=True)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(self._stop, app, server)
        self.upload_dir = root
        self.api = HttpApiClient("http://127.0.0.1:%d" % server.server_port, timeout=20)

    @staticmethod
    def _stop(app, server):
        app.extensions["stop_background"]()
        server.shutdown()
        server.server_close()

    def test_status_and_local_reads(self):
        self.assertTrue(self.api.status()["ok"])
        self.assertIn("model", self.api.settings())
        self.assertEqual(self.api.notes()["total"], 0)
        self.assertEqual(self.api.mistakes()["total"], 0)
        self.assertEqual(self.api.exercises()["total"], 0)
        self.assertEqual(self.api.review_catalog()["total"], 0)
        self.assertIn("教学与选题", self.api.prompts())

    def test_missing_job_maps_to_not_found(self):
        with self.assertRaises(NotFoundError):
            self.api.material_job("missing")

    def test_form_upload_returns_document(self):
        import pymupdf
        pdf = self.upload_dir / "练习.pdf"
        with pymupdf.open() as document:
            document.new_page()
            pdf.write_bytes(document.tobytes())
        uploaded = self.api.upload_preview(str(pdf))
        self.assertEqual(uploaded["name"], "练习.pdf")
        self.assertEqual(uploaded["pages"], 1)
        page = self.api.preview_page(uploaded["id"], 1)
        self.assertTrue(page.startswith(b"\xff\xd8"))  # JPEG 魔数

    def test_early_cancel_maps_to_cancelled_error(self):
        self.api.cancel("early")
        with self.assertRaises(CancelledError) as caught:
            self.api.chat("你好", view="organize", request_id="early")
        self.assertEqual(caught.exception.status, 499)


if __name__ == "__main__":
    unittest.main()
