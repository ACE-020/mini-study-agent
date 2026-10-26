"""One explicitly authorized real comparison; exactly one request, no retries."""
import argparse,json,sys,time
from pathlib import Path
from urllib.request import Request,urlopen
from urllib.error import HTTPError
parser=argparse.ArgumentParser();parser.add_argument('--project',type=Path,required=True);args=parser.parse_args()
sys.path.insert(0,str(args.project))
from settings import SettingsStore,load_user_environment
from llm import ModelClient,ModelError
from materials import MaterialParser
from material_sources import capture_materials
from werkzeug.datastructures import FileStorage
audit_path=args.project/'experiments/document-pipeline/work/results/current-vision-audit.json'
if audit_path.exists() and json.loads(audit_path.read_text(encoding='utf8')).get('requests',0)>=1:
 raise SystemExit('The authorized one-request comparison has already run; refusing to repeat it.')
load_user_environment();config=SettingsStore(args.project/'.local-settings.json').resolve()
root=args.project/'experiments/document-pipeline/work';audit={'requests':0,'source_pages':[16,17],'automatic_retries':0}
class OneRequestClient(ModelClient):
 def complete(self,messages,tools=None,cancel_token=None):
  if audit['requests']>=1:raise ModelError('Experiment request limit reached')
  audit['requests']+=1
  payload=json.dumps({'model':self.model,'messages':messages,'stream':False}).encode('utf8')
  audit['request_bytes']=len(payload);audit['model']=self.model
  request=Request(self.url,data=payload,headers={'Content-Type':'application/json','Authorization':'Bearer '+self.api_key})
  try:
   with urlopen(request,timeout=240) as response:body=json.load(response)
  except HTTPError as error:
   code=error.code;error.close();raise ModelError('Model HTTP '+str(code)) from None
  audit['usage']=body.get('usage');audit['finish_reason']=body['choices'][0].get('finish_reason')
  message=body['choices'][0]['message']
  (root/'results/current-vision-raw.json').write_text(json.dumps(message,ensure_ascii=False,indent=2),encoding='utf8')
  return message
start=time.monotonic()
try:
 with Path('D:/yjm/UMath/Higher_Mathematics/大邮数学集-1.4.3.pdf').open('rb') as f:
  captured=capture_materials([FileStorage(stream=f,filename='大邮数学集-1.4.3.pdf')],'16-17')
 images=captured['documents'];audit['prepared_pages']=len(images)
 client=OneRequestClient(config['ocr_base_url'],config['ocr_api_key'],config['ocr_model'],timeout=240,retries=0)
 result=MaterialParser(client).parse('',images=images)
 (root/'results/current-vision.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
 blocks=[]
 for item in result['exercises']:blocks+=['## '+item.get('paper','')+' · '+item.get('number',''),item['question'],'参考答案：'+item.get('answer','')]
 (root/'results/current-vision.md').write_text('\n\n'.join(blocks),encoding='utf8')
 audit.update(ok=True,questions=len(result['exercises']),warnings=result.get('warnings',[]))
except Exception as error:audit.update(ok=False,error=type(error).__name__+': '+str(error))
finally:
 audit['seconds']=round(time.monotonic()-start,2)
 (root/'results/current-vision-audit.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2),encoding='utf8')
 print(json.dumps(audit,ensure_ascii=False,indent=2))
