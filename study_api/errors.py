"""Python 接口抛出的异常层次。

调用方可只捕获 `ApiError` 做统一处理，也可以按子类区分：

- `ConfigurationError`：模型/配置文件缺失或非法（对应 HTTP 400/500 中的配置类错误）
- `DataFileError`：本地 JSON（笔记、错题、题库）结构损坏，原文件不会被覆盖
- `ModelFailure`：模型或识图服务不可用 / 返回格式不符（对应 HTTP 502）
- `NotFoundError`：记录、批次、题目不存在或已过期（对应 HTTP 404）
- `CancelledError`：调用方主动停止（对应 HTTP 499），已完成写入不回滚
"""


class ApiError(Exception):
    """所有接口异常的基类。message 可以直接展示给用户。"""

    def __init__(self, message, *, status=None, events=None):
        super().__init__(message)
        self.message = message
        self.status = status          # 对应 HTTP 状态码（本地调用时为 None）
        self.events = events or []    # 失败前已经发生的工具事件


class ConfigurationError(ApiError):
    """模型配置缺失或格式不正确。"""


class DataFileError(ApiError):
    """本地数据文件结构损坏。"""


class ModelFailure(ApiError):
    """模型/识图服务异常（网络、超时、返回格式错误）。"""


class NotFoundError(ApiError):
    """对象不存在或已过期。"""


class CancelledError(ApiError):
    """调用方主动停止本次处理（等价于 HTTP 499）。"""

    def __init__(self, message="已停止本次处理，可以修改原内容后重新提交。", *, context_retained=False, events=None):
        super().__init__(message, status=499, events=events)
        self.context_retained = context_retained
