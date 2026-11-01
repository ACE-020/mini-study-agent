from io import BytesIO
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import desktop
import runtime_paths


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
