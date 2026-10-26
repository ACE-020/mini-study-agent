"""Temporary data, fake recognition/models; only serve provided local PDF pages."""
from pathlib import Path
import json
import sys
import tempfile
ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT),str(ROOT/'tests')]
from test_local_ocr import FakeRuntime
from settings import SettingsStore
from materials import material_rules
from web import create_app

PAPER='7 [分析上期中] [无准确标题] 2023–2024 高数 A 上期中'
NUMBERS=[f'{s}、{n}' for s in ('一','二') for n in range(1,7)]+[f'三、{n}' for n in range(1,4)]
ITEMS=[{'number':number,'paper':PAPER,'topic':'极限','question':r'计算 $\lim_{x\to0}\frac{\sin x}{x}$。','answer':'$1$'} for number in NUMBERS]
ITEMS[8]['question']=r'已知当 $x\to0$ 时，$\ln\cos x\sim\sqrt[3]{1+ax^2}-1$，则常数 $a=$。'

class Model:
    def complete(self,messages,tools=None):
        if messages[0]['content'].startswith(material_rules()):
            # Deliberately omit page_index/source_anchor to verify deterministic
            # binding from paper identity and number for both provider paths.
            return {'role':'assistant','content':json.dumps({'exercises':ITEMS,'warnings':[]})}
        return {'role':'assistant','content':'测试回答'}

with tempfile.TemporaryDirectory(prefix='study-ocr-choice-') as folder:
    root=Path(folder);settings=root/'settings.json'
    SettingsStore(settings).save({'base_url':'https://example.invalid/v1','api_key':'qa-only','model':'qa-text','ocr_model':'qa-vision','ocr_base_url':'','ocr_api_key':''})
    app=create_app(root/'data',client_factory=Model,settings_path=settings,local_ocr_runtime=FakeRuntime())
    try:app.run(host='127.0.0.1',port=8790,debug=False,use_reloader=False,threaded=True)
    finally:app.extensions['stop_background']()
