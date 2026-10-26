"""Windows exe 验收：隔离目录、HTTP 模型替身、不依赖宿主 Python/PATH。"""

import argparse
from http.cookiejar import CookieJar
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from urllib.request import Request, build_opener, HTTPCookieProcessor
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from demo import MISTAKE
from serve_workspace_fixture import NOTE, WorkspaceModel
from tools import LocalTools


class ModelHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        payload=json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        reply=WorkspaceModel().complete(payload["messages"],payload.get("tools"))
        raw=json.dumps({"choices":[{"message":reply}],"usage":{"prompt_tokens":10,"completion_tokens":10}},ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type","application/json")
        self.send_header("Content-Length",str(len(raw)))
        try:
            self.end_headers()
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass  # 停止任务/退出程序会主动关闭等待中的模型连接。

    def log_message(self,*args):
        pass


def stop(process):
    if process and process.poll() is None:
        subprocess.run(["taskkill","/PID",str(process.pid),"/T","/F"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        process.wait(timeout=15)


def wait_for_instance(folder,previous=None):
    deadline=time.monotonic()+70
    while time.monotonic()<deadline:
        try:
            item=json.loads((folder/"desktop-instance.json").read_text(encoding="utf-8"))
            if item["instance"]!=previous:
                base=f"http://127.0.0.1:{item['port']}"
                with build_opener().open(base+"/api/desktop/status",timeout=1) as response:
                    if json.load(response).get("instance")==item["instance"]:
                        return base,item
        except (OSError,ValueError,KeyError):
            pass
        time.sleep(.15)
    logs="\n".join(path.read_text(encoding="utf-8",errors="replace")[-2500:] for path in folder.glob("*.log"))
    raise RuntimeError("exe did not become ready: "+logs)


def main():
    parser=argparse.ArgumentParser()
    browser_tests=("browser_workspace_v3.cjs","browser_workspace.cjs","browser_material_workflow.cjs","browser_material_vision.cjs","browser_review_refinement.cjs","browser_material_reader.cjs","browser_material_reading.cjs","browser_material_locations.cjs","browser_material_capacity.cjs","browser_material_recovery.cjs","browser_review_controls.cjs")
    parser.add_argument("--exe",type=Path,required=True)
    parser.add_argument("--browser-test",choices=browser_tests,action="append",help="只运行指定浏览器流程；可重复，默认运行全部。")
    args=parser.parse_args()
    qa=ROOT/"tmp/desktop-qa"
    qa.mkdir(parents=True,exist_ok=True)
    user=qa/("user-"+str(int(time.time())))
    user.mkdir()
    local=LocalTools(user/"data")
    local._write_records("notes.json",[
        {"id":"seed-note-1","topic":"导数","content":NOTE,"created_at":"2026-10-22T00:00:00+00:00"},
        {"id":"seed-note-2","topic":"积分","content":"非负整数 n 的幂函数不定积分：∫x^n dx = x^(n+1)/(n+1)+C。注意积分常数。","created_at":"2026-10-22T00:00:00+00:00"}])
    local.save_mistake(**MISTAKE)
    local.save_mistake(**{**MISTAKE,"question":"求 x³ 的导数。","user_answer":"x²","correct_answer":"3x²"})
    local.bank.add("示例资料",[{"number":"1","topic":"导数","question":"求 g(x)=x^5 的导数。","answer":"5x^4"}])
    # 输入用文字/扫描 PDF，只在临时目录准备。
    import pymupdf
    for scanned,name in ((False,"text-pages.pdf"),(True,"scan-pages.pdf")):
        with pymupdf.open() as document:
            for index in range(2):
                page=document.new_page(width=400,height=500)
                if scanned:
                    page.draw_rect(pymupdf.Rect(30,30,180,200),color=(0,0,0))
                else:
                    page.insert_text((30,50),f"Exercise {index+1}: Find derivative of f(x) = x^2, for real x.")
            document.save(ROOT/"tmp"/name)
    model=ThreadingHTTPServer(("127.0.0.1",0),ModelHandler)
    threading.Thread(target=model.serve_forever,daemon=True).start()
    environment=os.environ.copy()
    for name in list(environment):
        if name.startswith(("LLM_","OCR_","PLAYWRIGHT_","_PYI_")):
            environment.pop(name,None)
    # exe 自带 Python、Playwright driver、PDF 库；PATH 中只留 Windows。
    environment["PATH"]=os.environ.get("WINDIR","C:\\Windows")+"\\System32"
    environment["PYTHONHOME"]=str(qa/"no-system-python")
    environment["PYTHONPATH"]=str(qa/"no-system-packages")
    command=[str(args.exe.resolve()),"--user-dir",str(user),"--headless","--no-browser"]
    process=None
    try:
        process=subprocess.Popen(command,env=environment,creationflags=subprocess.CREATE_NO_WINDOW)
        base,identity=wait_for_instance(user)
        opener=build_opener(HTTPCookieProcessor(CookieJar()))
        def call(path,payload=None):
            request=Request(base+path,data=json.dumps(payload).encode() if payload is not None else None,
                            headers={"Content-Type":"application/json"} if payload is not None else {})
            with opener.open(request,timeout=90) as response:
                return json.load(response)
        assert not call("/api/status")["configured"]
        key="packaged-test-key-only"
        call("/api/settings",{"base_url":f"http://127.0.0.1:{model.server_port}/v1","api_key":key,"model":"workspace-fixture","ocr_model":"workspace-fixture","ocr_base_url":"","ocr_api_key":""})
        assert call("/api/status")["configured"]
        assert key not in (user/".local-settings.json").read_text(encoding="utf-8")
        second=subprocess.run(command,env=environment,creationflags=subprocess.CREATE_NO_WINDOW,timeout=40)
        assert second.returncode==0
        assert json.loads((user/"desktop-instance.json").read_text(encoding="utf-8"))["instance"]==identity["instance"]
        print("PASS: exe starts with Python removed from PATH, encrypted settings work, repeated launch reuses the instance.",flush=True)
        env=os.environ.copy()
        env["STUDY_QA_URL"]=base
        env["PLAYWRIGHT_MODULE"]=os.environ.get("PLAYWRIGHT_MODULE","playwright")
        for script in args.browser_test or browser_tests:
            subprocess.run(["node",str(ROOT/"tests"/script)],cwd=ROOT,env=env,check=True)
        collection=ROOT/"tmp/qa-collection.pdf"
        with pymupdf.open(collection) as document:
            assert len(document)>0
            document[0].get_pixmap(matrix=pymupdf.Matrix(1.3,1.3)).save(qa/"packaged-pdf.png")
        snapshot={name:call(path) for name,path in (("notes","/api/notes"),("mistakes","/api/mistakes"),("exercises","/api/exercises"))}
        stop(process)
        process=subprocess.Popen(command,env=environment,creationflags=subprocess.CREATE_NO_WINDOW)
        base,_=wait_for_instance(user,identity["instance"])
        assert call("/api/status")["configured"]
        for name,path in (("notes","/api/notes"),("mistakes","/api/mistakes"),("exercises","/api/exercises")):
            assert call(path)==snapshot[name]
        print("PASS: notes, mistakes, exercises and encrypted configuration persist across exe restart.",flush=True)
        stop(process)
        process=None
        result=subprocess.run([str(args.exe.resolve()),"--user-dir",str(user),"--no-browser","--self-test-window"],env=environment,
                              creationflags=subprocess.CREATE_NO_WINDOW,timeout=50)
        assert result.returncode==0
        assert json.loads((user/"window-check.json").read_text(encoding="utf-8"))=={"ok":True,"stopped":True}
        assert not (user/"desktop-instance.json").exists()
        print("PASS: bundled Tk launcher creates its controls and shuts the local service down through its normal close callback.",flush=True)
        (qa/"result.json").write_text(json.dumps({"ok":True,"user_dir":str(user),"exe":str(args.exe.resolve()),"external_python_required":False}),encoding="utf-8")
    finally:
        stop(process)
        model.shutdown()
        model.server_close()


if __name__=="__main__":
    main()

