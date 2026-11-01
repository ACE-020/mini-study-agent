"""知错 · 学习整理助手的 Python 应用接口（SaaS-style Python API）。

本包把两个层面的能力暴露给 Python 调用者：

1. **后端服务**：不经过 HTTP，直接组合各业务模块完成“读取原稿 → 整理 → 保存”等流程；
   也就是把前端页面里发生的事，用 Python 函数重新组织一遍。
2. **前端调用**：提供 `HttpApiClient`，用纯标准库发起与网页完全相同的 HTTP 请求，
   适合把本机服务当成一个“后端 SaaS”来集成（其他语言也可以照此实现）。

典型用法::

    from study_api import StudyService, AppConfig

    service = StudyService(AppConfig(data_dir="D:/研究/data"))
    service.configure_model(base_url="https://api.deepseek.com",
                            api_key="<你的 Key>", model="deepseek-v4-pro")
    result = service.chat("请整理这道错题并保存", scope="current")
    print(result.answer)
    for event in result.events:
        print(event["event"], event["value"])

    # 前端/远端方式（服务已用 python web.py 启动）
    client = HttpApiClient("http://127.0.0.1:8765")
    print(client.status()["configured"])

设计约束（与网页一致，必须遵守）：

- 模型只能“提议”，真正写库的是这里的方法；删除/合并只生成待确认方案；
- 所有写入都先落临时文件再原子替换，损坏的文件不会被覆盖；
- 网络类操作都可以传入 `CancellationToken` 提前停止，已完成的写入不回滚。
"""

from .errors import ApiError, CancelledError, ConfigurationError, DataFileError, ModelFailure, NotFoundError
from .config import AppConfig
from .models import (ChatResult, CurrentQuestion, Exercise, MaterialJobResult, Mistake, Note,
                     ReviewSelection, StudyEvent, ToolResult)
from .backends import BackendSession, LocalBackend, ModelBackend, ScriptedBackend
from .service import StudyService
from .client import HttpApiClient

__all__ = [
    # 异常
    "ApiError", "ConfigurationError", "DataFileError", "ModelFailure", "NotFoundError", "CancelledError",
    # 配置与结果模型
    "AppConfig", "Note", "Mistake", "Exercise", "CurrentQuestion", "StudyEvent", "ChatResult",
    "ToolResult", "ReviewSelection", "MaterialJobResult",
    # 模型后端（可替换、可离线测试）
    "ModelBackend", "LocalBackend", "ScriptedBackend", "BackendSession",
    # 服务
    "StudyService",
    # 前端/远端 HTTP 客户端
    "HttpApiClient",
]

__version__ = "workspace-v20-python-api-1"
