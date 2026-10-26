"""读取原始页面供视觉模型直接拆题；不调用 OCR、不经纯文字重排。"""

import base64
from io import BytesIO
from pathlib import Path
import tempfile

from PIL import Image

from document_input import MAX_BATCH_BYTES, MAX_FILE_BYTES, MAX_PAGES, MAX_TEXT, open_pdf, parse_page_range
from ocr import MAX_IMAGE_BYTES, prepare_image
from material_locations import pdf_layouts


MAX_MATERIAL_PAGES = MAX_PAGES
MAX_MATERIAL_IMAGE_BYTES = 40 * 1024 * 1024
MAX_PAGE_IMAGE_BYTES = MAX_MATERIAL_IMAGE_BYTES // MAX_MATERIAL_PAGES


def encode_material_image(image):
    """限制每页编码体积，让允许的页数确实能放入批次缓存。"""
    prefix = "data:image/jpeg;base64,"
    image = image.convert("RGB")
    while True:
        for quality in (95, 90, 85, 80):
            output = BytesIO()
            image.save(output, format="JPEG", quality=quality, exif=b"")
            encoded = prefix + base64.b64encode(output.getvalue()).decode("ascii")
            if len(encoded) <= MAX_PAGE_IMAGE_BYTES:
                return encoded
        image = image.resize((max(1, int(image.width*.85)), max(1, int(image.height*.85))), Image.Resampling.LANCZOS)


def bounded_upload_image(raw):
    image = prepare_image(raw)
    if len(image) <= MAX_PAGE_IMAGE_BYTES:
        return image
    with Image.open(BytesIO(base64.b64decode(image.split(",", 1)[1]))) as source:
        return encode_material_image(source)


def batch_metadata(value):
    if value is None:
        return {}
    if not isinstance(value, dict) or set(value)-{"files", "page_range", "mode", "ocr_backend"}:
        raise ValueError("批次来源说明格式有误。")
    page_range = value.get("page_range", "")
    files = value.get("files", [])
    if not isinstance(page_range, str) or len(page_range) > 500 or not isinstance(files, list) or len(files) > 20:
        raise ValueError("批次来源说明过长或格式有误。")
    clean = []
    for file in files:
        if not isinstance(file, dict) or set(file)-{"name", "page_range", "pages", "total_pages"}:
            raise ValueError("资料文件说明格式有误。")
        name, pages, raw_range = file.get("name"), file.get("pages", []), file.get("page_range", "")
        if (not isinstance(name, str) or not name or len(name) > 180 or not isinstance(raw_range, str) or len(raw_range) > 500 or
                not isinstance(pages, list) or len(pages) > 100 or any(type(p) is not int or not 1 <= p <= 100000 for p in pages)):
            raise ValueError("资料文件说明格式有误。")
        total = file.get("total_pages")
        if total is not None and (type(total) is not int or not 1 <= total <= 100000):
            raise ValueError("文件总页数无效。")
        clean.append({"name": name, "page_range": raw_range, "pages": pages, **({"total_pages":total} if total else {})})
    backend = value.get("ocr_backend")
    if backend is not None and backend not in ("local", "remote"):
        raise ValueError("批次识别方式无效。")
    return {**({"ocr_backend":backend} if backend else {}), "files": clean, "page_range": page_range, "mode": "vision" if value.get("mode") == "vision" else "text"}


def image_parts(data_url, details=False):
    parts = [{"type": "image_url", "image_url": {"url": data_url, "detail": "high"}}]
    if details:
        with Image.open(BytesIO(base64.b64decode(data_url.split(",", 1)[1]))) as image:
            # 页面文字较小时，局部图比单纯提高整页像素更有用；保留交叠与整页上下文。
            if image.height > 900:
                for top, bottom in ((0, .57), (.43, 1)):
                    crop = image.crop((0, int(image.height*top), image.width, int(image.height*bottom)))
                    output = BytesIO()
                    crop.save(output, format="JPEG", quality=95)
                    url = "data:image/jpeg;base64," + base64.b64encode(output.getvalue()).decode("ascii")
                    parts.append({"type": "image_url", "image_url": {"url": url, "detail": "high"}})
    return parts


def capture_materials(files, page_range="", max_pages=MAX_MATERIAL_PAGES, token=None):
    max_pages = min(max_pages, MAX_MATERIAL_PAGES)
    if not files or len(files) > 20:
        raise ValueError("请选择 1 到 20 个资料文件。")
    if not isinstance(page_range, str) or len(page_range) > 500:
        raise ValueError("页码范围格式有误。")
    documents, texts, total = [], [], 0
    file_info = []
    for upload in files:
        if token:
            token.check()
        name = (upload.filename or "资料").replace("\\", "/").rsplit("/", 1)[-1][:180]
        info = {"name": name, "page_range": page_range if name.lower().endswith(".pdf") else "", "pages": []}
        if name.lower().endswith(".pdf"):
            with tempfile.TemporaryDirectory(prefix="study-original-") as folder:
                path = Path(folder)/"source.pdf"
                size = 0
                with path.open("wb") as output:
                    while chunk := upload.read(1024*1024):
                        size += len(chunk); total += len(chunk)
                        if size > MAX_FILE_BYTES or total > MAX_BATCH_BYTES:
                            raise ValueError("单个 PDF 最多 256 MB，每批最多 512 MB。")
                        output.write(chunk)
                with open_pdf(path, name) as pdf:
                    if pdf.needs_pass:
                        raise ValueError("请先解锁加密 PDF。")
                    info["total_pages"] = len(pdf)
                    selected = parse_page_range(page_range, len(pdf), max_pages)
                    if len(documents) + len(selected) > max_pages:
                        raise ValueError(f"所有文件合计每批最多整理 {max_pages} 张图片 / PDF 页，请缩小范围。")
                    layouts = pdf_layouts(pdf, selected, token)
                    for number in selected:
                        if token:
                            token.check()
                        if len(documents) >= max_pages:
                            raise ValueError(f"每批最多整理 {max_pages} 张图片 / PDF 页，请缩小范围。")
                        page = pdf[number]
                        if page.rect.width <= 0 or page.rect.height <= 0:
                            raise ValueError("PDF 页面尺寸无效。")
                        scale = min(4, 2800/max(page.rect.width, page.rect.height))
                        pix = page.get_pixmap(matrix=__import__("pymupdf").Matrix(scale, scale), alpha=False)
                        image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                        encoded = encode_material_image(image)
                        page_index = len(documents)+1
                        layout = layouts.get(number, {})
                        for j, anchor in enumerate(layout.get("anchors", [])):
                            anchor["id"] = f"p{page_index}a{j}"
                        documents.append({"source": name, "page": number+1, "image": encoded,
                                          "page_index": page_index, **({"layout": layout} if layout else {})})
                        info["pages"].append(number+1)
        else:
            raw = upload.read(MAX_IMAGE_BYTES+1); total += len(raw)
            if not raw or len(raw) > MAX_IMAGE_BYTES or total > MAX_BATCH_BYTES:
                raise ValueError("单个图片 / 文本最多 8 MB，每批最多 512 MB。")
            if name.lower().endswith((".txt", ".md")):
                try:
                    texts.append(f"【{name}】\n" + raw.decode("utf-8-sig"))
                except UnicodeDecodeError:
                    raise ValueError("请使用 UTF-8 文字文件。") from None
            else:
                if len(documents) >= max_pages:
                    raise ValueError(f"每批最多整理 {max_pages} 张图片 / PDF 页。")
                documents.append({"source": name, "page": None, "image": bounded_upload_image(raw),
                                  "page_index": len(documents)+1})
        file_info.append(info)
    text = "\n\n".join(texts)
    if len(text) > MAX_TEXT:
        raise ValueError("本批文字超过 80000 字，请分批上传。")
    return {"text": text, "documents": documents, "metadata": {"files": file_info, "page_range": page_range,
            "mode": "vision" if documents else "text"}}

