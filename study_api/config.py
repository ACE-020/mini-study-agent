"""应用配置：数据目录、配置文件路径与运行参数。

与网页版共用同一套约定：

- `data_dir` 下保存 notes.json / mistakes.json / exercises.json / note_exports/
- `settings_path` 指向 `.local-settings.json`（Windows 上用 DPAPI 加密密钥）
- 未传路径时回落到 `runtime_paths` 的默认值（源码模式=项目目录，桌面版=%LOCALAPPDATA%\\ZhicuoStudy）
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import FrozenSet, Optional

from runtime_paths import default_data_directory, default_settings_path


@dataclass(frozen=True)
class AppConfig:
    """一次服务实例的全部运行参数（不可变，可安全共享）。"""

    data_dir: Path = field(default_factory=default_data_directory)
    settings_path: Path = field(default_factory=default_settings_path)
    # 单轮请求里模型最多往返几次（与网页版 StudyAgent 默认值一致）
    max_rounds: int = 6
    # 是否在导入时读取当前用户注册表里的 LLM_* / OCR_* 环境变量
    load_user_environment: bool = True
    # 本机 GLM-OCR：False 表示强制不用，True 表示允许，None 表示跟随设置文件
    local_ocr: Optional[bool] = None
    # 允许的对话视图，供集成方限制能力（默认全部）
    allowed_views: FrozenSet[str] = frozenset({"organize", "review", "notes", "analysis"})

    def __post_init__(self):
        # dataclass 是不可变的：用 object.__setattr__ 在初始化时统一转成 Path
        object.__setattr__(self, "data_dir", Path(self.data_dir))
        object.__setattr__(self, "settings_path", Path(self.settings_path))
        if self.max_rounds < 1:
            raise ValueError("max_rounds 必须 ≥ 1")
        if self.allowed_views - {"organize", "review", "notes", "analysis"}:
            raise ValueError("allowed_views 只能包含 organize/review/notes/analysis")

    def ensure_directories(self):
        """创建数据目录与导出目录（已存在则忽略）。"""
        self.data_dir.mkdir(parents=True, exist_ok=True)
        (self.data_dir / "note_exports").mkdir(parents=True, exist_ok=True)
        return self
