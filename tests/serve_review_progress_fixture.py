"""Isolated review records and a deterministic assessment model; no external calls."""
import argparse
import json
from pathlib import Path
import sys
import tempfile
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from settings import SettingsStore
from tools import LocalTools
from web import create_app
from werkzeug.serving import make_server, WSGIRequestHandler


class AttemptModel:
    def complete(self,messages,tools=None):
        if messages[-1]["role"]=="tool":
            value=json.loads(messages[-1]["content"])
            if value.get("ok") and value.get("data",{}).get("outcome")=="correct":
                return dict(role="assistant",content="本次完整作答已核对正确；这条做题记录已保留。")
            return dict(role="assistant",content="这一步的等价式写错了。提示：先用 sin(kx) 与 kx 等价，检查分子分母是否同阶。")
        user=messages[-1]["content"]
        if "独立答案" in user:
            result=dict(outcome="correct",assisted=False,error_tags=[],evidence="本次完整推导与答案一致，未提供实质提示。")
        elif "补齐" in user:
            result=dict(outcome="correct",assisted=True,error_tags=[],evidence="在上次提示后恢复了等价式并得到正确的极限值。")
        else:
            result=dict(outcome="incorrect",assisted=True,error_tags=["formula"],evidence="把等价式的阶数写错了，结果仍含变量；本轮已提示检查分子分母的阶。")
        return dict(role="assistant",content=None,tool_calls=[dict(id="fixture-review-result",type="function",function=dict(name="record_review_result",arguments=json.dumps(result,ensure_ascii=False)))])


def make_fixture(root):
    root=Path(root);local=LocalTools(root/"data")
    local.bank.add("交互验收合成资料",[
        dict(topic="极限",tags=["无穷小比较"],number=str(i),question=f"合成比较题 {i}：求 $\\lim_{{x\\to0}}\\frac{{\\sin {i}x}}{{x}}$。",answer=str(i)) for i in range(1,4)])
    local.bank.add("幂指型合成资料",[dict(topic="极限",tags=["1的无穷次方"],number="4",question=r"合成幂指题：求 $\lim_{x\to0}(1+x)^{1/x}$。",answer="e")])
    settings=root/"settings.json"
    SettingsStore(settings).save(dict(base_url="https://example.invalid/v1",api_key="offline-test-only",model="离线记录验收",ocr_model="离线记录验收",ocr_base_url="",ocr_api_key=""))
    return create_app(root/"data",client_factory=AttemptModel,settings_path=settings,local_ocr_runtime=False)


class Quiet(WSGIRequestHandler):
    def log(self,*args,**kwargs):pass


if __name__=="__main__":
    parser=argparse.ArgumentParser();parser.add_argument("--port",type=int,default=8802);parser.add_argument("--info");args=parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="zhicuo-review-records-") as folder:
        app=make_fixture(folder);server=make_server("127.0.0.1",args.port,app,threaded=True,request_handler=Quiet)
        info=dict(url=f"http://127.0.0.1:{server.server_port}")
        if args.info:Path(args.info).write_text(json.dumps(info),encoding="utf-8")
        print(json.dumps(info),flush=True)
        try:server.serve_forever()
        finally:app.extensions["stop_background"]();server.server_close()
