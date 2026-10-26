"""支持预填草稿的终端输入；非交互环境保留普通 input 兼容性。"""

import sys


def read_prompt(default=""):
    if sys.stdin.isatty():
        try:
            from prompt_toolkit import prompt
            return prompt("你：", default=default)
        except ImportError:
            pass
    if default:
        print("待编辑内容：\n" + default)
        replacement = input("输入修改后的内容（直接回车保留）：")
        return replacement or default
    return input("你：")
