"""知错 Windows 启动器；冻结后内置 Python，PDF 子进程也使用同一 exe。"""

import argparse
import ctypes
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import sys
import threading
import time
from urllib.request import urlopen
import uuid
import webbrowser

from runtime_paths import RESOURCE_ROOT, user_directory


APP_ID = "zhicuo-study-desktop"


def read_instance(path):
    try:
        item = json.loads(path.read_text(encoding="utf-8"))
        port = item["port"]
        if type(port) is not int or not 1 <= port <= 65535:
            return None
        base = f"http://127.0.0.1:{port}"
        with urlopen(base + "/api/desktop/status", timeout=1) as response:
            found = json.load(response)
        if found.get("app") == APP_ID and found.get("instance") == item.get("instance"):
            return base
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return None


class InstanceLock:
    def __init__(self, folder):
        self.path = folder / "desktop-instance.json"
        self.stream = (folder / "desktop.lock").open("a+b")
        if self.stream.tell() == 0:
            self.stream.write(b"0")
            self.stream.flush()
        self.stream.seek(0)

    def acquire(self):
        import msvcrt
        self.stream.seek(0)
        try:
            msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
            return True
        except OSError:
            return False

    def close(self):
        self.stream.close()


def render_pdf(arguments):
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("markdown", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--cancel-file", type=Path)
    args = parser.parse_args(arguments)
    error_path = args.output.parent / "renderer-error.txt"
    try:
        from note_pdf import render
        render(args.markdown, args.output, cancel_file=args.cancel_file)
        return 0
    except Exception as exc:
        error_path.write_text(str(exc)[:1200], encoding="utf-8")
        return 1


def setup_logging(folder):
    handler = RotatingFileHandler(folder / "desktop.log", maxBytes=1024*1024,
                                  backupCount=2, encoding="utf-8")
    logging.basicConfig(level=logging.INFO, handlers=[handler],
                        format="%(asctime)s %(levelname)s %(message)s", force=True)
    logging.getLogger("werkzeug").setLevel(logging.WARNING)
    if sys.stdout is None:
        sys.stdout = (folder / "console.log").open("a", encoding="utf-8")
    if sys.stderr is None:
        sys.stderr = sys.stdout


def run_window(base, folder, stop, test_mode=False):
    import tkinter as tk
    from tkinter import ttk
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("Zhicuo.StudyAgent.Desktop")
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except (OSError, AttributeError):
        pass
    root = tk.Tk()
    root.title("知错 · 学习整理助手")
    root.geometry("470x300")
    root.resizable(False, False)
    root.configure(bg="#f7f8fc")
    icon = RESOURCE_ROOT / "build_assets/app.ico"
    if icon.exists():
        root.iconbitmap(str(icon))
    style = ttk.Style(root)
    style.theme_use("clam")
    style.configure("TButton", font=("Microsoft YaHei UI", 10), padding=(12, 9))
    style.configure("Main.TButton", background="#6755cf", foreground="white")
    style.map("Main.TButton", background=[("active", "#5745bd")])
    tk.Label(root, text="知错", font=("Microsoft YaHei UI", 23, "bold"), fg="#253047", bg="#f7f8fc").pack(anchor="w", padx=28, pady=(24, 2))
    status = tk.Label(root, text="学习助手已启动，网页将在浏览器中打开。", font=("Microsoft YaHei UI", 10), fg="#526078", bg="#f7f8fc")
    status.pack(anchor="w", padx=30, pady=(4, 10))
    tk.Label(root, text=base, font=("Segoe UI", 10), fg="#6755cf", bg="#f7f8fc").pack(anchor="w", padx=30)
    actions = tk.Frame(root, bg="#f7f8fc")
    actions.pack(fill="x", padx=28, pady=20)
    open_button = ttk.Button(actions, text="打开学习页面", style="Main.TButton", command=lambda: webbrowser.open(base))
    open_button.pack(side="left", padx=(0, 10))
    data_button = ttk.Button(actions, text="打开数据文件夹", command=lambda: os.startfile(str(folder)))
    data_button.pack(side="left")
    tk.Label(root, text="关闭此窗口会退出程序，已收录内容会保留。", font=("Microsoft YaHei UI", 9), fg="#707b8f", bg="#f7f8fc").pack(anchor="w", padx=30, pady=(0, 10))
    done = threading.Event()
    closing = False

    def close():
        nonlocal closing
        if closing:
            return
        closing = True
        status.configure(text="正在保存并退出…")
        open_button.configure(state="disabled")
        data_button.configure(state="disabled")
        def worker():
            try:
                stop()
            finally:
                done.set()
        threading.Thread(target=worker, daemon=True).start()
        poll()

    def poll():
        if done.is_set():
            root.destroy()
        else:
            root.after(80, poll)

    root.protocol("WM_DELETE_WINDOW", close)
    if test_mode:
        # 构建验收在程序内部创建同一窗口和退出回调，不操纵其他 Windows 应用。
        root.withdraw()
        root.after(200, close)
    root.mainloop()
    if not closing:
        stop()


def main(arguments=None):
    arguments = list(sys.argv[1:] if arguments is None else arguments)
    if arguments and arguments[0] == "--render-pdf":
        return render_pdf(arguments[1:])
    parser = argparse.ArgumentParser(description="知错 Windows 桌面版")
    parser.add_argument("--user-dir", type=Path, help="指定独立数据目录，用于测试或便携运行")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--headless", action="store_true", help="仅启动本机服务，供自动验收使用")
    parser.add_argument("--self-test-window", action="store_true", help="内部检查启动窗口依赖和退出流程")
    args = parser.parse_args(arguments)
    folder = (args.user_dir or user_directory()).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    setup_logging(folder)
    lock = InstanceLock(folder)
    if not lock.acquire():
        try:
            for _ in range(12):
                base = read_instance(lock.path)
                if base:
                    if not args.no_browser:
                        webbrowser.open(base)
                    return 0
                time.sleep(.2)
            if not args.headless:
                ctypes.windll.user32.MessageBoxW(None, "知错正在启动，请稍后再试。", "知错", 0x40)
            return 1
        finally:
            lock.close()

    server = app = None
    stopped = False
    try:
        from web import create_app
        from werkzeug.serving import make_server
        from flask import jsonify
        app = create_app(data_dir=folder/"data", settings_path=folder/".local-settings.json")
        identity = uuid.uuid4().hex
        @app.get("/api/desktop/status")
        def desktop_status():
            return jsonify(ok=True, app=APP_ID, instance=identity)
        # 由系统选空闲端口，不会误连接到旧版源码服务或其他软件。
        server = make_server("127.0.0.1", 0, app, threaded=True)
        app.config["SESSION_COOKIE_NAME"] = f"zhicuo_desktop_{server.server_port}"
        base = f"http://127.0.0.1:{server.server_port}"
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        lock.path.write_text(json.dumps({"port": server.server_port, "pid": os.getpid(), "instance": identity}), encoding="utf-8")

        def stop():
            nonlocal stopped
            if stopped:
                return
            stopped = True
            app.extensions["stop_background"]()
            server.shutdown()
            server.server_close()
            lock.path.unlink(missing_ok=True)

        if not args.no_browser:
            webbrowser.open(base)
        if args.headless and not args.self_test_window:
            try:
                while thread.is_alive():
                    thread.join(.5)
            except KeyboardInterrupt:
                pass
            finally:
                stop()
        else:
            run_window(base, folder, stop, test_mode=args.self_test_window)
            if args.self_test_window:
                (folder / "window-check.json").write_text(json.dumps({"ok": True, "stopped": stopped}), encoding="utf-8")
        return 0
    except Exception:
        logging.exception("Desktop launch failed")
        if not args.headless:
            ctypes.windll.user32.MessageBoxW(None, "启动未完成。请查看数据目录中的 desktop.log。\n" + str(folder), "知错", 0x10)
        return 1
    finally:
        if server:
            if not stopped:
                if app:
                    app.extensions["stop_background"]()
                server.shutdown()
            server.server_close()
        lock.path.unlink(missing_ok=True)
        lock.close()


if __name__ == "__main__":
    raise SystemExit(main())
