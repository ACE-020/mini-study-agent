import base64
from io import BytesIO
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import pymupdf
from PIL import Image
from werkzeug.datastructures import FileStorage

from material_sources import (capture_materials, encode_material_image, image_parts,
                              MAX_MATERIAL_PAGES, MAX_MATERIAL_IMAGE_BYTES, MAX_PAGE_IMAGE_BYTES)
from test_core import ScriptedClient
from web import create_app


def pdf_bytes(count):
    with pymupdf.open() as doc:
        for _ in range(count):
            page=doc.new_page()
            page.insert_text((40,60),"Example question.")
        return doc.tobytes()


class MaterialCapacityTests(unittest.TestCase):
    def test_twenty_page_range_is_accepted_whole_and_fits_batch_budget(self):
        result=capture_materials([FileStorage(BytesIO(pdf_bytes(45)),filename="test.pdf")],"21-40")
        self.assertEqual(result["metadata"]["files"][0]["pages"],list(range(21,41)))
        self.assertEqual(result["metadata"]["files"][0]["total_pages"],45)
        self.assertEqual(len(result["documents"]),MAX_MATERIAL_PAGES)
        self.assertLessEqual(sum(len(d["image"]) for d in result["documents"]),MAX_MATERIAL_IMAGE_BYTES)

    def test_oversized_range_rejected_before_layout_or_render_and_no_model_call(self):
        with tempfile.TemporaryDirectory() as folder:
            model=ScriptedClient([])
            app=create_app(Path(folder),client_factory=lambda:model)
            self.addCleanup(app.extensions["pdf_previews"].close)
            with patch("material_sources.pdf_layouts") as layouts:
                response=app.test_client().post("/api/materials/jobs",data={
                    "source":"large","page_range":"21-120",
                    "files":(BytesIO(pdf_bytes(120)),"large.pdf")})
            self.assertEqual(response.status_code,400,response.json)
            self.assertIn("20 页",response.json["error"])
            layouts.assert_not_called()
            self.assertEqual(model.requests,[])
            self.assertEqual(app.extensions["material_jobs"].jobs,{})

    def test_high_entropy_page_is_bounded_and_keeps_usable_detail_parts(self):
        image=Image.effect_noise((2800,2800),100).convert("RGB")
        encoded=encode_material_image(image)
        self.assertLessEqual(len(encoded),MAX_PAGE_IMAGE_BYTES)
        self.assertLessEqual(len(encoded)*MAX_MATERIAL_PAGES,MAX_MATERIAL_IMAGE_BYTES)
        with Image.open(BytesIO(base64.b64decode(encoded.split(",",1)[1]))) as decoded:
            self.assertGreaterEqual(decoded.width,1500)
        self.assertEqual(len(image_parts(encoded,details=True)),3)

    def test_multifile_total_is_checked_before_rendering_that_pdf(self):
        raw=pdf_bytes(11)
        with patch("material_sources.pdf_layouts",return_value={}) as layouts:
            with self.assertRaisesRegex(ValueError,"所有文件合计"):
                capture_materials([FileStorage(BytesIO(raw),filename="a.pdf"),
                                   FileStorage(BytesIO(raw),filename="b.pdf")],"1-11")
        self.assertEqual(layouts.call_count,1)

    def test_page_capacity_in_page_and_continuation_share_server_constant(self):
        with tempfile.TemporaryDirectory() as folder:
            app=create_app(Path(folder),client_factory=lambda:ScriptedClient([]))
            self.addCleanup(app.extensions["pdf_previews"].close)
            html=app.test_client().get("/").get_data(as_text=True)
            self.assertIn('data-max-pages="'+str(MAX_MATERIAL_PAGES)+'"',html)
            self.assertNotIn("最多100页",html)


if __name__=="__main__":
    unittest.main()
