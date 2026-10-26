"""会话隔离的资料整理队列：仅生成预览，绝不在后台写入题库。"""

from collections import deque
from copy import deepcopy
import inspect
import secrets
import threading
import time

from cancellation import CancellationToken, OperationCancelled
from llm import ModelError
from material_sources import batch_metadata
from materials import MaterialBatchError


class MaterialJobs:
    def __init__(self, make_parser, workers=2, make_visual_parser=None):
        self.make_parser = make_parser
        self.make_visual_parser = make_visual_parser or make_parser
        self.sequences = {}
        self.worker_count = workers
        self.jobs = {}
        self.queue = deque()
        self.condition = threading.Condition(threading.RLock())
        self.started = False

    def submit(self, owner, text, source, documents=None, metadata=None, source_files=None):
        if not isinstance(text, str) or (not text.strip() and not documents) or len(text) > 80000:
            raise ValueError("请提供 1 到 80000 字的资料。")
        if not isinstance(source, str) or not source.strip() or len(source) > 180:
            raise ValueError("请填写 1 到 180 字的资料名称。")
        metadata = batch_metadata(metadata)
        with self.condition:
            now = time.time()
            self.jobs = {key: job for key, job in self.jobs.items()
                         if job["status"] in ("queued", "running") or now-job["updated_at"] < 7200}
            owned = [job for job in self.jobs.values() if job["owner"] == owner]
            if sum(job["status"] in ("queued", "running") for job in owned) >= 4:
                raise ValueError("已有 4 批资料等待整理，请等待完成或停止一批后再提交。")
            if len(self.jobs) >= 100 or len(owned) >= 20:
                raise ValueError("任务列表已满，请先移除已完成的任务。")
            size = sum(len(doc.get("image", "")) for doc in documents or [])
            if size + sum(job.get("image_bytes", 0) for job in self.jobs.values()) > 160*1024*1024:
                raise ValueError("原图任务缓存已满，请移除已完成任务后再导入。")
            self.sequences[owner] = self.sequences.get(owner, 0)+1
            metadata = {**(metadata or {}), "batch_number": self.sequences[owner]}
            job = {"id": secrets.token_urlsafe(18), "owner": owner, "source": source.strip(),
                   "text": text, "status": "queued", "created_at": now, "updated_at": now,
                   "token": CancellationToken(), "progress": {}, "result": None, "error": "",
                   "documents": documents or [], "metadata": metadata, "image_bytes": size,
                   "source_files":source_files or [],"segments":{}}
            self.jobs[job["id"]] = job
            self.queue.append(job["id"])
            if not self.started:
                self.started = True
                for _ in range(self.worker_count):
                    threading.Thread(target=self._worker, daemon=True).start()
            self.condition.notify_all()
            return self._public(job)

    @staticmethod
    def _public(job, detail=False):
        result = {key: deepcopy(job[key]) for key in
                  ("id", "source", "status", "created_at", "updated_at", "progress", "error", "metadata")}
        result["count"] = len((job["result"] or {}).get("exercises", []))
        result["source_files"]=deepcopy(job.get("source_files",[]))
        result["failed_parts"]=len((job["result"] or {}).get("failures",[]))
        if detail:
            result.update(text=job["text"], result=deepcopy(job["result"]), documents=[{key: value for key, value in doc.items() if key != "image"} for doc in job["documents"]])
        return result

    def _owned(self, owner, identity):
        job = self.jobs.get(identity)
        if job is None or job["owner"] != owner:
            raise KeyError("这项任务不存在或已过期。")
        return job

    def list(self, owner):
        with self.condition:
            return [self._public(job) for job in reversed(list(self.jobs.values())) if job["owner"] == owner]

    def get(self, owner, identity):
        with self.condition:
            return self._public(self._owned(owner, identity), detail=True)

    def documents(self, owner, identity):
        with self.condition:
            return deepcopy(self._owned(owner, identity)["documents"])

    def cancel(self, owner, identity):
        with self.condition:
            job = self._owned(owner, identity)
            if job["status"] in ("queued", "running"):
                job["token"].cancel()
                job.update(status="cancelled", updated_at=time.time())
            return self._public(job)

    def remove(self, owner, identity):
        with self.condition:
            job = self._owned(owner, identity)
            if job["status"] in ("queued", "running"):
                raise ValueError("请先停止任务，再从列表移除。")
            del self.jobs[identity]

    def retry(self, owner, identity):
        with self.condition:
            job=self._owned(owner,identity)
            if job["status"] not in ("failed","cancelled"):
                raise ValueError("这项任务不需要重试，正在处理的任务不能重复提交。")
            if sum(j["owner"]==owner and j["status"] in ("queued","running") for j in self.jobs.values())>=4:
                raise ValueError("已有4批资料处理中，请稍后重试。")
            job.update(status="queued",token=CancellationToken(),error="",progress={},updated_at=time.time())
            self.queue.append(identity);self.condition.notify_all()
            return self._public(job)

    def _worker(self):
        while True:
            with self.condition:
                self.condition.wait_for(lambda: bool(self.queue))
                job = self.jobs.get(self.queue.popleft())
                if job is None or job["status"] != "queued":
                    continue
                job.update(status="running", updated_at=time.time())
                token=job["token"]
            def progress(done, total):
                with self.condition:
                    if job["token"] is token:
                        job.update(progress={"completed": done, "total": total, "phase":"structuring", "message":"正在整理题目并关联答案…"}, updated_at=time.time())
            def recognition_progress(value):
                with self.condition:
                    if job["token"] is token:
                        job.update(progress=dict(value), updated_at=time.time())
            token.on_progress = recognition_progress
            try:
                if job["documents"]:
                    factory_kwargs = {"backend":job["metadata"].get("ocr_backend")} if "backend" in inspect.signature(self.make_visual_parser).parameters else {}
                    parser = self.make_visual_parser(**factory_kwargs)
                else:
                    parser = self.make_parser()
                parse = parser.parse_images if job["documents"] else getattr(parser, "parse_many", parser.parse)
                kwargs = {"cancel_token": token}
                if "progress" in inspect.signature(parse).parameters:
                    kwargs["progress"] = progress
                if "cached_segments" in inspect.signature(parse).parameters:
                    kwargs["cached_segments"]=deepcopy(job["segments"])
                    def checkpoint(key,result):
                        with self.condition:
                            if job["token"] is token:
                                job["segments"][key]=deepcopy(result)
                    kwargs["checkpoint"]=checkpoint
                if job["documents"]:
                    result = parse(job["documents"], text=job["text"], **kwargs)
                else:
                    result = parse(job["text"], **kwargs)
                token.check()
                with self.condition:
                    if job["token"] is token and job["status"] != "cancelled":
                        job.update(status="ready", result=result, updated_at=time.time())
            except OperationCancelled:
                with self.condition:
                    if job["token"] is token:
                        job.update(status="cancelled", updated_at=time.time())
            except MaterialBatchError as exc:
                with self.condition:
                    if job["token"] is token and job["status"]!="cancelled":
                        job.update(status="failed",result=exc.result,error=str(exc),updated_at=time.time())
            except (ModelError, ValueError, OSError) as exc:
                with self.condition:
                    if job["token"] is token and job["status"] != "cancelled":
                        job.update(status="failed", error=str(exc), updated_at=time.time())
            except Exception:
                with self.condition:
                    if job["token"] is token and job["status"] != "cancelled":
                        job.update(status="failed", error="整理未完成，请重试。本批资料尚未入库。", updated_at=time.time())
