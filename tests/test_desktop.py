from io import BytesIO
from http.cookiejar import CookieJar
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.request import Request, build_opener, HTTPCookieProcessor
from unittest.mock import patch

import desktop
import runtime_paths
from web import create_app
from web_history import cookie_names


class DesktopTests(unittest.TestCase):
    def test_source_keeps_existing_data_location(self):
        with patch.object(runtime_paths.sys, "frozen", False, create=True):
            self.assertEqual(runtime_paths.default_data_directory(), runtime_paths.RESOURCE_ROOT/"data")
            self.assertEqual(runtime_paths.default_settings_path(), runtime_paths.RESOURCE_ROOT/".local-settings.json")

    def test_frozen_data_lives_outside_temporary_bundle(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(runtime_paths.sys, "frozen", True, create=True), patch.object(runtime_paths, "RESOURCE_ROOT", Path(folder)/"bundle"), patch.dict(os.environ, {"LOCALAPPDATA": str(Path(folder)/"user-local")}):
                self.assertEqual(runtime_paths.default_data_directory(), Path(folder)/"user-local/ZhicuoStudy/data")
                self.assertFalse(runtime_paths.default_settings_path().is_relative_to(runtime_paths.RESOURCE_ROOT))

    @unittest.skipUnless(os.name == "nt", "Windows file lock")
    def test_second_instance_cannot_start_another_server(self):
        with tempfile.TemporaryDirectory() as folder:
            first = desktop.InstanceLock(Path(folder))
            second = desktop.InstanceLock(Path(folder))
            try:
                self.assertTrue(first.acquire())
                self.assertFalse(second.acquire())
                first.close()
                self.assertTrue(second.acquire())
            finally:
                first.close()
                second.close()

    def test_existing_instance_must_answer_expected_identity(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/"instance.json"
            path.write_text(json.dumps({"port":12345,"instance":"abc"}),encoding="utf-8")
            response=BytesIO(json.dumps({"app":desktop.APP_ID,"instance":"abc"}).encode())
            with patch("desktop.urlopen",return_value=response):
                self.assertEqual(desktop.read_instance(path),"http://127.0.0.1:12345")
            response=BytesIO(json.dumps({"app":"different-app","instance":"abc"}).encode())
            with patch("desktop.urlopen",return_value=response):
                self.assertIsNone(desktop.read_instance(path))

    def test_pdf_worker_writes_readable_failure_without_opening_gui(self):
        with tempfile.TemporaryDirectory() as folder:
            output=Path(folder)/"note.pdf"
            with patch("note_pdf.render",side_effect=ValueError("公式无法排版")), patch("desktop.run_window") as window:
                self.assertEqual(desktop.main(["--render-pdf",str(Path(folder)/"note.md"),str(output)]),1)
            window.assert_not_called()
            self.assertIn("公式无法排版",(Path(folder)/"renderer-error.txt").read_text(encoding="utf-8"))


def _serve(app):
    from werkzeug.serving import make_server
    server = make_server("127.0.0.1", 0, app, threaded=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def _request(opener, url, payload=None, method=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = Request(url, data=data, method=method or ("POST" if data is not None else "GET"),
                      headers={"Content-Type": "application/json"})
    with opener.open(request, timeout=10) as response:
        return response.status, json.loads(response.read().decode("utf-8"))


class DesktopDynamicPortHistoryTests(unittest.TestCase):
    def test_history_cookie_name_is_stable_when_dynamic_port_changes(self):
        self.assertEqual(cookie_names("data-a"), cookie_names("data-a"))
        self.assertNotEqual(cookie_names("data-a")["session"], cookie_names("data-b")["session"])
        self.assertNotEqual(cookie_names("data-a")["user"], cookie_names("data-b")["user"])

    def test_same_data_directory_survives_a_new_dynamic_port(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            data = folder / "data"
            jar = CookieJar()
            opener = build_opener(HTTPCookieProcessor(jar))
            first_app = create_app(data, client_factory=lambda: None, reader_factory=lambda: None,
                                   settings_path=folder / "settings.json")
            desktop.configure_session_cookie(first_app, data)
            self.assertEqual(first_app.config["SESSION_COOKIE_NAME"],
                             cookie_names(data)["session"])
            first_server, _ = _serve(first_app)
            first_port = first_server.server_port
            second_server = None
            try:
                base = f"http://127.0.0.1:{first_port}"
                status, _ = _request(opener, base + "/api/status")
                self.assertEqual(status, 200)
                status, created = _request(opener, base + "/api/conversations", {})
                self.assertEqual(status, 200, created)
                conversation_id = created["conversation"]["id"]
                status, _ = _request(opener, base + f"/api/conversations/{conversation_id}",
                                     {"intake_text": "动态端口重启后仍保留"}, "PATCH")
                self.assertEqual(status, 200)

                # 停掉第一个服务的接收循环但保留监听端口，确保第二个服务拿到
                # 必然不同的动态端口；这样测试真正覆盖“端口变化、Cookie 不变”。
                first_server.shutdown()
                second_app = create_app(data, client_factory=lambda: None, reader_factory=lambda: None,
                                        settings_path=folder / "settings.json")
                desktop.configure_session_cookie(second_app, data)
                self.assertEqual(second_app.config["SESSION_COOKIE_NAME"],
                                 first_app.config["SESSION_COOKIE_NAME"])
                second_server, _ = _serve(second_app)
                second_port = second_server.server_port
                self.assertNotEqual(second_port, first_port)

                base = f"http://127.0.0.1:{second_port}"
                status, listing = _request(opener, base + "/api/conversations")
                self.assertEqual(status, 200, listing)
                self.assertEqual(listing["active"], conversation_id)
                self.assertEqual([item["id"] for item in listing["conversations"]], [conversation_id])
                status, detail = _request(opener, base + f"/api/conversations/{conversation_id}")
                self.assertEqual(status, 200)
                self.assertEqual(detail["conversation"]["intake"]["text"], "动态端口重启后仍保留")
                self.assertIn(first_app.config["HISTORY_COOKIE_NAME"],
                              [cookie.name for cookie in jar])
            finally:
                for server in (second_server, first_server):
                    if server is None:
                        continue
                    try:
                        server.shutdown()
                    except OSError:
                        pass
                    try:
                        server.server_close()
                    except OSError:
                        pass
