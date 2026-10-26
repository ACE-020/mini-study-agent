"""Local UI QA fixture: temporary data and fake OCR, no user settings or API."""
from pathlib import Path
import sys
import tempfile
import time
ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT),str(ROOT/'tests')]
from test_local_ocr import FakeRuntime, RecordingModel
from settings import SettingsStore
from web import create_app

class SlowRuntime(FakeRuntime):
    def read(self,raw,cancel_token=None):
        for _ in range(40):
            if cancel_token:
                cancel_token.report('GLM 正在本机识别，CPU 处理可能需要一两分钟…',phase='ocr-reading')
                cancel_token.wait(.1)
            else:time.sleep(.1)
        return super().read(raw,cancel_token)

with tempfile.TemporaryDirectory(prefix='study-glm-qa-') as folder:
    root=Path(folder)
    settings=root/'settings.json'
    SettingsStore(settings).save({'base_url':'https://example.invalid/v1','api_key':'qa-only','model':'qa-model','ocr_model':'qa-vision','ocr_base_url':'','ocr_api_key':''})
    app=create_app(root/'data',client_factory=RecordingModel,settings_path=settings,local_ocr_runtime=SlowRuntime())
    try:app.run(host='127.0.0.1',port=8789,debug=False,use_reloader=False,threaded=True)
    finally:app.extensions['stop_background']()
