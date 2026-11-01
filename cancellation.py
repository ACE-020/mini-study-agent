"""停止本轮等待与后续工具执行；已完成的工具写入不会回滚。"""

from queue import Empty, Queue
import threading


class OperationCancelled(RuntimeError):
    pass


class CancellationToken:
    def __init__(self):
        self.event = threading.Event()
        self.progress = {}
        self.on_progress = None
        self.preserve_context = False
        self.context_retained = False

    def report(self, message, **fields):
        self.progress = {**self.progress, **fields, "message": message}
        if self.on_progress:
            self.on_progress(self.progress)

    def cancel(self):
        self.event.set()

    @property
    def cancelled(self):
        return self.event.is_set()

    def check(self):
        if self.event.is_set():
            raise OperationCancelled("已停止本次处理，可以修改原内容后重新提交。已保存的错题和笔记保留。")

    def wait(self, seconds):
        self.event.wait(seconds)
        self.check()


def interruptible(call, token=None):
    if token is None:
        return call()
    token.check()
    results = Queue(maxsize=1)

    def worker():
        try:
            results.put((True, call()))
        except Exception as error:
            results.put((False, error))

    # 后台线程只允许做模型网络请求，不执行工具或写文件。
    threading.Thread(target=worker, daemon=True).start()
    while True:
        token.check()
        try:
            success, value = results.get(timeout=0.05)
        except Empty:
            continue
        token.check()
        if success:
            return value
        raise value
