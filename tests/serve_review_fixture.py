"""Review UI fixture: isolated records and fake teaching/generation model."""
from pathlib import Path
import sys
import tempfile
import time
from copy import deepcopy
ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT),str(ROOT/'tests')]
from test_review_catalog import EXERCISES
from demo import MISTAKE
from settings import SettingsStore
from tools import LocalTools
from web import create_app
class Reader:
    def __init__(self):self.calls=0
    def read(self, raw, cancel_token=None):
        self.calls+=1
        if cancel_token:cancel_token.wait(.3);cancel_token.check()
        return '手写测试标记：先使用共轭式。'


class Model:
    def __init__(self):self.requests=[]
    def complete(self,messages,tools=None):
        self.requests.append(deepcopy(messages))
        if str(messages[-1]["content"]).startswith("慢速测试"):
            time.sleep(1.8)
        if '本轮明确要求你自行出题' in messages[1]['content']:
            return {'role':'assistant','content':r'求极限 $\lim_{x\to0}\frac{\sin 2x}{x}$。先说说你会用哪个等价替换？'}
        return {'role':'assistant','content':'继续这道等价无穷小题。先写出一个可以使用的等价替换。'}

with tempfile.TemporaryDirectory(prefix='study-review-tree-') as folder:
    root=Path(folder);settings=root/'settings.json';local=LocalTools(root/'data')
    local.bank.add('示例练习册',EXERCISES)
    local.save_mistake(**{**MISTAKE,'topic':'行列式','question':'问题-M1，计算 $2$ 阶行列式。'})
    SettingsStore(settings).save({'base_url':'https://example.invalid/v1','api_key':'qa-only','model':'qa-model','ocr_model':'qa-vision','ocr_base_url':'','ocr_api_key':''})
    model=Model();reader=Reader();app=create_app(root/'data',client_factory=lambda:model,reader_factory=lambda:reader,settings_path=settings,local_ocr_runtime=False)
    @app.get('/qa/model-calls')
    def calls():return {'count':len(model.requests),'ocr_calls':reader.calls,'last_context':model.requests[-1] if model.requests else []}
    try:app.run(host='127.0.0.1',port=8791,debug=False,use_reloader=False,threaded=True)
    finally:app.extensions['stop_background']()
