"""统一批量读取图片、文本和 PDF；扫描页走 OCR，文字型 PDF 本地提取。"""

from pathlib import Path
import gc
import re
import tempfile

from ocr import MAX_IMAGE_BYTES, prepare_image


MAX_FILE_BYTES = 256 * 1024 * 1024
MAX_BATCH_BYTES = 512 * 1024 * 1024
MAX_TEXT = 80000
MAX_PAGES = 20


def open_pdf(path, name="PDF"):
    import pymupdf
    try:
        return pymupdf.open(path)
    except Exception:
        pass
    # 部分 MuPDF 打开失败的构造器形成引用环；先释放文件句柄再删除临时文件。
    # 在 except 块外抛出，避免异常上下文继续持有构造器的堆栈。
    gc.collect()
    raise ValueError(f"无法读取 {name}，请检查 PDF 是否完整。")


def parse_page_range(value, total, max_pages=MAX_PAGES):
    if not value or not value.strip():
        pages = list(range(total))
    else:
        pages = []
        for part in value.replace("，", ",").split(","):
            match = re.fullmatch(r"\s*(\d+)\s*(?:-\s*(\d+)\s*)?", part)
            if not match:
                raise ValueError("页码请填写如 1-8 或 1,3,5-8。")
            start = int(match[1])
            end = int(match[2] or start)
            if not 1 <= start <= end <= total:
                raise ValueError(f"PDF 共 {total} 页，请检查页码范围。")
            pages.extend(range(start-1, end))
        pages = sorted(set(pages))
    if not pages or len(pages) > max_pages:
        raise ValueError(f"PDF 共 {total} 页，每批可读 {max_pages} 页；请填写页码范围，例如 1-20。")
    return pages


class DocumentReader:
    def __init__(self, reader_factory, prefer_visual=None):
        self.reader_factory = reader_factory
        self.prefer_visual = bool(getattr(reader_factory, "prefer_visual", False)) if prefer_visual is None else prefer_visual
        self.reader = None

    def recognize(self, raw, token):
        if self.reader is None:
            self.reader = self.reader_factory()
        return self.reader.read(raw, cancel_token=token)

    def read(self, files, page_range="", token=None, include_images=False):
        if not files or len(files) > 20:
            raise ValueError("请选择 1 到 20 个图片、PDF、TXT 或 Markdown 文件。")
        chunks, images, pages, image_texts = [], [], [], []
        byte_count = 0
        for upload in files:
            if token:
                token.check()
            name = (upload.filename or "资料").replace("\\", "/").rsplit("/", 1)[-1][:180]
            if name.lower().endswith(".pdf"):
                # 大 PDF 按块写临时文件，仅读取指定页，不把整本文件放进 Python 内存。
                with tempfile.TemporaryDirectory(prefix="study-pdf-read-") as folder:
                    path = Path(folder) / "source.pdf"
                    size = 0
                    with path.open("wb") as output:
                        while chunk := upload.read(1024*1024):
                            if token:
                                token.check()
                            size += len(chunk)
                            byte_count += len(chunk)
                            if size > MAX_FILE_BYTES or byte_count > MAX_BATCH_BYTES:
                                raise ValueError("单个 PDF 最多 256 MB，每批合计最多 512 MB；原有输入已保留。")
                            output.write(chunk)
                    for text, image, metadata in self.pdf_pages(path, name, page_range, token, include_images):
                        if len(pages) >= MAX_PAGES:
                            raise ValueError("每批最多读取 20 张图片 / PDF 页，请缩小页码范围或分批上传。")
                        chunks.append(text)
                        pages.append(metadata)
                        if image:
                            images.append(image)
                            image_texts.append(text)
                        if sum(len(part) for part in chunks) > MAX_TEXT:
                            raise ValueError("本批文字超过 80000 字，请缩小页码范围；原有输入已保留。")
                continue
            raw = upload.read(MAX_IMAGE_BYTES+1)
            byte_count += len(raw)
            if not raw or len(raw) > MAX_IMAGE_BYTES or byte_count > MAX_BATCH_BYTES:
                raise ValueError("单张图片或文本最多 8 MB，每批合计最多 512 MB；原有输入已保留。")
            if name.lower().endswith((".txt", ".md")):
                try:
                    text = raw.decode("utf-8-sig")
                except UnicodeDecodeError:
                    raise ValueError(f"{name} 请另存为 UTF-8，或直接粘贴文字。") from None
                chunks.append(text)
                pages.append({"source": name, "page": None, "method": "text"})
            else:
                if len(raw) > MAX_IMAGE_BYTES:
                    raise ValueError("单张图片最多 8 MB，请压缩后上传。")
                if len(pages) >= MAX_PAGES:
                    raise ValueError("每批最多读取 20 张图片 / PDF 页。")
                data_url = prepare_image(raw)
                text = self.recognize(raw, token)
                if include_images:
                    images.append(data_url)
                    image_texts.append(text)
                chunks.append(text)
                pages.append({"source": name, "page": None, "method": "local-glm" if self.prefer_visual else "ocr"})
            if sum(len(part) for part in chunks) > MAX_TEXT:
                raise ValueError("本批文字超过 80000 字，请缩小页码范围；原有输入已保留。")
        if token:
            token.check()
        text = "\n\n".join(chunks).strip()
        if not text:
            raise ValueError("没有读到有效文字，请检查资料内容。")
        if len(text) > MAX_TEXT:
            raise ValueError("本批文字超过 80000 字，请缩小页码范围。")
        return {"text": text, "images": images, "pages": pages, "image_texts": image_texts}

    def pdf_pages(self, path, name, page_range, token, include_images):
        import pymupdf
        document = open_pdf(path, name)
        with document:
            if document.needs_pass:
                raise ValueError(f"{name} 已加密，请解锁后上传。")
            selected = parse_page_range(page_range, len(document))
            local = self.prefer_visual
            for position, index in enumerate(selected):
                if getattr(token, "report", None):
                    token.report(f"正在读取 {name} · 第 {index+1} 页（{position+1}/{len(selected)}）", completed=position, total=len(selected))
                if token:
                    token.check()
                page = document[index]
                text = page.get_text("text", sort=True).strip()
                readable = len(re.findall(r"[\w\u4e00-\u9fff]", text)) >= 20 and "\ufffd" not in text
                image = None
                if local or not readable or include_images:
                    if page.rect.width <= 0 or page.rect.height <= 0:
                        raise ValueError(f"{name} 第 {index+1} 页尺寸无效。")
                    scale = min(2, 1800/max(page.rect.width, page.rect.height))
                    image = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False).tobytes("png")
                if local or not readable:
                    text = self.recognize(image, token)
                yield (f"【{name} · 第 {index+1} 页】\n{text}", prepare_image(image) if include_images else None,
                       {"source": name, "page": index+1, "method": "local-glm" if local else "text" if readable else "ocr"})
