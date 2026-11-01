"""支持预填草稿的终端输入；非交互环境保留普通 input 兼容性。"""

import sys


def read_prompt(default=""):
    if sys.stdin.isatty(): #检测标准输入是否连接到终端
        try:
            from prompt_toolkit import prompt
            #prompt_toolkit 提供更强大的终端输入能力，例如可编辑的预填文本、光标移动、历史等
            return prompt("你：", default=default)
        #提示符是 "你："。
        #default=default 表示把传入的 default 作为预填草稿显示在输入框中，用户可以编辑。
        except ImportError:
            pass
    if default:#若default不为空
        print("待编辑内容：\n" + default)
        replacement = input("输入修改后的内容（直接回车保留）：")
        return replacement or default
        #利用 Python 的短路逻辑：
            #如果 replacement 是非空字符串，返回 replacement。
            #如果 replacement 是空字符串，返回 default，即“直接回车保留默认内容”。
    return input("你：")
