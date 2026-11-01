"""停止本轮等待与后续工具执行；已完成的工具写入不会回滚。"""

from queue import Empty, Queue
import threading

#为这里的报错定义一个名字
class OperationCancelled(RuntimeError):
    pass

#取消令牌：终端大模型执行
class CancellationToken:
    def __init__(self):
        self.event = threading.Event() #创建一个使线程等待的事件
        self.progress = {}
        self.on_progress = None
        self.preserve_context = False
        self.context_retained = False

    def report(self, message, **fields):
        self.progress = {**self.progress, **fields, "message": message}
        #**self.progress这里**是解包，将字典展开放入新的字典中
        if self.on_progress: #当on_progress是一个函数，不为空
            self.on_progress(self.progress) #将progress传入on_progress

    def cancel(self):
        self.event.set() #设置事件，使对应线程开始等待

    @property
    def cancelled(self):
        return self.event.is_set() #检测是否设置线程等待事件

    def check(self):
        if self.event.is_set(): #如果设置了等待事件，报错
            raise OperationCancelled("已停止本次处理，可以修改原内容后重新提交。已保存的错题和笔记保留。")

    def wait(self, seconds): #实现从等待seconds秒并报错
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
