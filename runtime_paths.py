"""静态资源随程序分发；exe 的可写数据放在当前 Windows 用户目录。"""

import os
from pathlib import Path
import sys


RESOURCE_ROOT = Path(__file__).resolve().parent


def frozen():
    return bool(getattr(sys, "frozen", False))


def user_directory():
    if frozen():
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData/Local")
        return base / "ZhicuoStudy"
    return RESOURCE_ROOT


def default_data_directory():
    return user_directory() / "data"


def default_settings_path():
    return user_directory() / ".local-settings.json"
