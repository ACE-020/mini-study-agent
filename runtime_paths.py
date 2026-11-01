"""静态资源随程序分发；exe 的可写数据放在当前 Windows 用户目录。"""

import os
from pathlib import Path
import sys


#获得当前脚本的绝对目录
RESOURCE_ROOT = Path(__file__).resolve().parent


def frozen():
    return bool(getattr(sys, "frozen", False))
    #getattr作用：获取sys的frozen属性,如果没有，就返回False
    #判断有没有fozen属性，就是在判断程序有没有打包

def user_directory():
    if frozen():
        #如果被打包，就放在用户路径下
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData/Local")
        return base / "ZhicuoStudy"
    return RESOURCE_ROOT #没有就放在项目路径下


#获取data的路径
def default_data_directory():
    return user_directory() / "data"


#获取local-settings.json的路径
def default_settings_path():
    return user_directory() / ".local-settings.json"
