"""会话内临时保留导入原文件，供任务重试、续页和预览；不写入学习库。"""
from contextlib import contextmanager
from pathlib import Path
import secrets
import tempfile
import threading
import time

import pymupdf
from werkzeug.datastructures import FileStorage

from document_input import MAX_BATCH_BYTES, MAX_FILE_BYTES, open_pdf
from ocr import MAX_IMAGE_BYTES


class MaterialFiles:
    def __init__(self):
        self.folder = None
        self.entries = {}
        self.lock = threading.RLock()
        self.closing = False

    def _remove(self,key):
        entry=self.entries[key]
        if entry.get("leases",0):
            entry["discard"]=True
        else:
            entry["path"].unlink(missing_ok=True)
            del self.entries[key]

    def _expire(self):
        for key, entry in list(self.entries.items()):
            if not entry.get("leases",0) and time.monotonic()-entry["seen"] > 7200:
                self._remove(key)

    @staticmethod
    def _public(key, entry):
        return {"id":key, "name":entry["name"], "size":entry["size"], "pages":entry.get("pages")}

    def add(self, files, owner):
        if not files or len(files)>20:
            raise ValueError("每批请选择1到20个文件。")
        added=[]
        with self.lock:
            if self.closing:raise ValueError("本机服务正在关闭，请重新打开后再导入。")
            self._expire()
            if self.folder is None:
                self.folder=tempfile.TemporaryDirectory(prefix="study-material-files-")
            try:
                for upload in files:
                    name=(upload.filename or "资料").replace("\\","/").rsplit("/",1)[-1][:180]
                    suffix=Path(name).suffix.lower()
                    if suffix not in (".pdf",".txt",".md",".jpg",".jpeg",".png",".webp"):
                        raise ValueError("请选择PDF、TXT、Markdown或图片。")
                    key=secrets.token_urlsafe(24);path=Path(self.folder.name)/(key+suffix)
                    entry={"name":name,"path":path,"size":0,"owner":owner,"seen":time.monotonic()}
                    self.entries[key]=entry;added.append(key)
                    limit=MAX_FILE_BYTES if suffix==".pdf" else MAX_IMAGE_BYTES
                    with path.open("wb") as output:
                        while chunk:=upload.read(1024*1024):
                            entry["size"]+=len(chunk)
                            if entry["size"]>limit:
                                raise ValueError("单个PDF最多256MB，图片或文字文件最多8MB。")
                            if sum(e["size"] for e in self.entries.values())>MAX_BATCH_BYTES:
                                raise ValueError("临时原文件缓存已满，请清空不再使用的上传区，或等待缓存过期后再试。")
                            output.write(chunk)
                    if suffix==".pdf":
                        with open_pdf(path,name) as pdf:
                            if pdf.needs_pass:
                                raise ValueError("请先解锁加密PDF。")
                            entry["pages"]=len(pdf)
                return [self._public(k,self.entries[k]) for k in added]
            except Exception:
                self.discard(added,owner)
                raise

    def _owned(self, key, owner):
        entry=self.entries.get(key)
        if not entry or entry["owner"]!=owner:
            raise ValueError("临时原文件已过期或服务已重启，请重新选择原文件；页码与已整理题目仍保留。")
        entry["seen"]=time.monotonic()
        return entry

    @contextmanager
    def open(self, keys, owner):
        if not isinstance(keys,list) or not 1<=len(keys)<=20 or any(not isinstance(k,str) for k in keys) or len(set(keys))!=len(keys):
            raise ValueError("原文件引用无效。")
        with self.lock:
            if self.closing:raise ValueError("本机服务正在关闭，临时原文件将清理。")
            self._expire()
            entries=[self._owned(k,owner) for k in keys]
            streams=[]
            try:
                for entry in entries:
                    streams.append(FileStorage(entry["path"].open("rb"),filename=entry["name"]))
            except Exception:
                for stream in streams:stream.close()
                raise
            for entry in entries:entry["leases"]=entry.get("leases",0)+1
        try:
            yield streams,[self._public(k,e) for k,e in zip(keys,entries)]
        finally:
            for stream in streams:stream.close()
            with self.lock:
                for key,entry in zip(keys,entries):
                    entry["leases"]-=1;entry["seen"]=time.monotonic()
                    if entry.get("discard") and not entry["leases"]:self._remove(key)
                if self.closing and not self.entries and self.folder:
                    self.folder.cleanup();self.folder=None

    def page(self, key, page, owner):
        with self.open([key],owner) as (files,info):
            entry=self.entries[key]
            if not entry.get("pages") or not 1<=page<=entry["pages"]:
                raise ValueError("请选择PDF中的有效文件页码。")
            with pymupdf.open(entry["path"]) as pdf:
                source=pdf[page-1];scale=min(2,1700/max(source.rect.width,source.rect.height))
                return source.get_pixmap(matrix=pymupdf.Matrix(scale,scale),alpha=False).tobytes("jpeg")

    def discard(self, keys, owner):
        with self.lock:
            for key in keys:
                entry=self.entries.get(key)
                if entry and entry["owner"]==owner:
                    self._remove(key)

    def close(self):
        with self.lock:
            self.closing=True
            for key in list(self.entries):self._remove(key)
            if not self.entries and self.folder:self.folder.cleanup();self.folder=None
