"""启动方式见 README.md；命令行核心使用标准库，笔记 PDF 依赖见 requirements.txt。"""

import argparse
import json
from pathlib import Path
import sys

from agent import StudyAgent
from demo import DemoClient, HOMEWORK
from llm import ModelClient, ModelError
from tools import LocalTools
from cancellation import CancellationToken, OperationCancelled
from cli_input import read_prompt


ROOT = Path(__file__).resolve().parent


def run_turn(agent, prompt):
    token = CancellationToken()
    try:
        if isinstance(agent.client, ModelClient):
            agent.client = ModelClient.from_env()
        print("Agent：" + agent.run(prompt, cancel_token=token))
        return True
    except (KeyboardInterrupt, OperationCancelled):
        token.cancel()
        print("\n已停止本轮。原内容会返回输入框，可以修改后按 Enter 重发；已保存的错题保留。")
        return False


def interactive_loop(agent, draft=""):
    print("输入 /exit 退出；模型处理中按 Ctrl+C 停止并返回编辑。")
    while True:
        try:
            prompt = read_prompt(draft).strip()
        except EOFError:
            break
        except KeyboardInterrupt:
            print("\n已取消当前输入。输入 /exit 可以退出。")
            continue
        if prompt == "/exit":
            break
        if not prompt:
            continue
        try:
            draft = "" if run_turn(agent, prompt) else prompt
        except ModelError as exc:
            draft = prompt
            print(f"本轮未完成：{exc} 可修改内容后重试；已保存的错题保留。", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description="知错 · 学习整理助手")
    inputs = parser.add_mutually_exclusive_group()
    inputs.add_argument("--prompt", help="单次文字请求")
    inputs.add_argument("--input-file", type=Path, help="从 UTF-8 文本读取作业")
    inputs.add_argument("--demo", choices=("save", "review"), help="离线固定脚本，不调用模型 API")
    parser.add_argument("--data-dir", type=Path, help="自定义 JSON 数据目录")
    parser.add_argument("--trace", action="store_true", help="显示工具请求与结果")
    args = parser.parse_args()

    data_dir = args.data_dir or ROOT / ("demo-data" if args.demo else "data")
    if args.demo:
        print("[离线演示：工具选择与回答来自固定脚本；文件读写和 Agent 循环是真实的。]")
        data_dir.mkdir(parents=True, exist_ok=True)
        if not (data_dir / "notes.json").exists():
            seed = ROOT / "data/notes.json"
            (data_dir / "notes.json").write_text(seed.read_text(encoding="utf-8") if seed.is_file() else "[]", encoding="utf-8")
        # 离线演示从明确标注的示例资料选题，不再让脚本冒充模型编题。
        from materials import QuestionBank
        bank = QuestionBank(data_dir)
        if not bank.path.exists():
            bank.add("离线演示示例资料", [{"number": "1", "topic": "导数",
                     "question": "求 g(x)=x^3 的导数，x 为实数。", "answer": "3x^2"}])
    trace = (lambda event, value: print(f"[{event}] {json.dumps(value, ensure_ascii=False)}")) if args.trace else None
    client = DemoClient(args.demo) if args.demo else ModelClient.from_env()
    agent = StudyAgent(client, LocalTools(data_dir), trace=trace)
    if args.demo or args.prompt is not None or args.input_file:
        if args.demo:
            prompt = HOMEWORK if args.demo == "save" else "根据我以前的错题，出一道复习题。"
        else:
            prompt = args.input_file.read_text(encoding="utf-8-sig") if args.input_file else args.prompt
        if not prompt.strip():
            raise ValueError("请求内容不能为空。")
        completed = run_turn(agent, prompt)
        if not completed and sys.stdin.isatty():
            interactive_loop(agent, draft=prompt)
        return

    interactive_loop(agent)


if __name__ == "__main__":
    # Windows 在重定向输出时可能默认使用本地编码，统一 UTF-8 便于日志和子进程读取。
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        main()
    except (ModelError, OSError, ValueError) as exc:
        print(f"未完成：{exc} 已写入的错题仍然保留。", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\n已退出。")
