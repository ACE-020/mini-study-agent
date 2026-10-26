"""Run one local parser/export worker with a time and memory budget."""
import argparse,json,os,subprocess,sys,time
from pathlib import Path
import psutil

parser=argparse.ArgumentParser()
parser.add_argument('--project',type=Path,required=True)
parser.add_argument('--name',required=True)
parser.add_argument('--timeout',type=int,default=900)
parser.add_argument('--rss-limit-mb',type=int,default=2000)
parser.add_argument('command',nargs=argparse.REMAINDER)
args=parser.parse_args()
root=args.project/'experiments/document-pipeline/work';tools=args.project/'.tools/document-pipeline'
root.joinpath('logs').mkdir(parents=True,exist_ok=True);root.joinpath('results').mkdir(exist_ok=True)
env=os.environ.copy()
env.update({'PYTHONIOENCODING':'utf-8','PYTHONUNBUFFERED':'1','HF_HOME':str(tools/'cache/huggingface'),'MODELSCOPE_CACHE':str(tools/'cache/modelscope'),'XDG_CACHE_HOME':str(tools/'cache'),'TORCH_HOME':str(tools/'cache/torch'),'MODEL_CACHE_DIR':str(tools/'cache/surya'),'OMP_NUM_THREADS':'2','MKL_NUM_THREADS':'2','OPENBLAS_NUM_THREADS':'2','NUMEXPR_NUM_THREADS':'2','TOKENIZERS_PARALLELISM':'false','HF_HUB_DISABLE_TELEMETRY':'1','DO_NOT_TRACK':'1','MINERU_TELEMETRY':'0','MINERU_HOME':str(tools/'cache/mineru'),'MINERU_INTRA_OP_NUM_THREADS':'2','MINERU_INTER_OP_NUM_THREADS':'1','MINERU_TABLE_DEVICE':'cpu','SURYA_INFERENCE_PARALLEL':'1','SURYA_INFERENCE_CTX_SIZE':'16384','LLAMA_CPP_NGL':'0','LLAMA_CPP_EXTRA_ARGS':'--threads 2 --threads-batch 2','MINERU_DEVICE_MODE':'cpu','TORCH_DEVICE':'cpu'})
command=args.command[1:] if args.command and args.command[0]=='--' else args.command
if not command:parser.error('missing worker command')
start=time.monotonic();peak=0;reason='';low_since=None;owned_children={}
record={'name':args.name,'command':command,'available_ram_before_mb':round(psutil.virtual_memory().available/2**20),'timeout_s':args.timeout,'rss_limit_mb':args.rss_limit_mb,'log':str(root/'logs'/(args.name+'.log'))}
with open(record['log'],'w',encoding='utf8') as log:
 process=subprocess.Popen(command,stdout=log,stderr=subprocess.STDOUT,env=env,cwd=args.project,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
 tracked=psutil.Process(process.pid)
 def stop():
  try:children=tracked.children(recursive=True)
  except psutil.Error:children=[]
  for child in reversed(children):
   try:child.kill()
   except psutil.Error:pass
  if process.poll() is None:process.kill()
 while process.poll() is None:
  try:
   children=[tracked,*tracked.children(recursive=True)]
   for child in children[1:]:owned_children[child.pid]=child.create_time()
   memory=sum(child.memory_info().rss for child in children if child.is_running())
   peak=max(peak,memory)
  except psutil.Error:memory=0
  now=time.monotonic();available=psutil.virtual_memory().available
  low_since=(low_since or now) if available<384*2**20 else None
  if memory>args.rss_limit_mb*2**20:reason='memory_budget';stop()
  elif low_since and now-low_since>8:reason='system_memory_pressure';stop()
  elif now-start>args.timeout:reason='timeout';stop()
  time.sleep(.3)
 process.wait(timeout=20)
 # A worker may start a detached local inference server; release only verified descendants.
 cleaned=[]
 for pid,created in owned_children.items():
  try:
   child=psutil.Process(pid)
   if child.is_running() and abs(child.create_time()-created)<.01:child.kill();cleaned.append(pid)
  except psutil.Error:pass
 record['worker_children_cleaned']=cleaned
record.update({'seconds':round(time.monotonic()-start,2),'peak_rss_mb':round(peak/2**20,1),'returncode':process.returncode,'stopped_reason':reason,'available_ram_after_mb':round(psutil.virtual_memory().available/2**20)})
(root/'results'/(args.name+'-metrics.json')).write_text(json.dumps(record,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps(record,ensure_ascii=False,indent=2),flush=True)
raise SystemExit(0 if process.returncode==0 and not reason else 1)
