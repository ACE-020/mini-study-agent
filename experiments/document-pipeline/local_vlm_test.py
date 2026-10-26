"""Test public OCR weights on loopback only, with official task prompts.

Run inside the experiment guard; no configured remote API or secret is read.
"""
import argparse
import base64
import json
from io import BytesIO
from pathlib import Path
import socket
import subprocess
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT=Path(__file__).resolve().parents[2]
MODELS={
    'glm':('GLM-OCR-Q8_0.gguf','mmproj-GLM-OCR-Q8_0.gguf','Text Recognition:'),
    'paddle':('PaddleOCR-VL-1.6-GGUF.gguf','PaddleOCR-VL-1.6-GGUF-mmproj.gguf','OCR:'),
}


def save(path,value):
    temporary=path.with_suffix(path.suffix+'.tmp')
    temporary.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf8')
    temporary.replace(path)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--model',choices=MODELS,required=True)
    parser.add_argument('--context',type=int,default=8192)
    parser.add_argument('--only',default='',help='Optional single case id')
    parser.add_argument('--max-edge',type=int,default=0,help='Request-only resize; original stays unchanged')
    parser.add_argument('--regions16',action='store_true',help='Read native PDF question regions, not whole-page OCR')
    parser.add_argument('--regions-padding',type=int,default=0)
    args=parser.parse_args()
    work=ROOT/'experiments/document-pipeline/work'
    folder=ROOT/'.tools/document-pipeline/models'/args.model
    manifest=json.loads((folder/'download.json').read_text(encoding='utf8'))
    main_model,projector,text_prompt=MODELS[args.model]
    for name in (main_model,projector):
        if not (folder/name).is_file():
            raise RuntimeError('Missing verified local weight '+name)
    cases=json.loads((work/'samples/formula-cases.json').read_text(encoding='utf8'))
    selected=[case for case in cases if case['id'] in ('p37-critical-q6','p16-nested-root','p18-e-subscript')]
    selected.append({'id':'page16-full','image':'original-page16.png','physical_page':16,'reference':None})
    if args.regions16:
        region_suffix=f'-pad{args.regions_padding}' if args.regions_padding else ''
        selected=json.loads((work/'samples'/f'question-regions16{region_suffix}.json').read_text(encoding='utf8'))
    if args.only:
        selected=[case for case in selected if case['id']==args.only]
        if not selected:
            raise ValueError('Unknown case')
    with socket.socket() as listener:
        listener.bind(('127.0.0.1',0))
        port=listener.getsockname()[1]
    base=f'http://127.0.0.1:{port}'
    binary=ROOT/'.tools/document-pipeline/llama-cpu/llama-server.exe'
    command=[str(binary),'-m',str(folder/main_model),'--mmproj',str(folder/projector),
             '--host','127.0.0.1','--port',str(port),'-c',str(args.context),'-np','1',
             '-t','2','-tb','2','-b','128','-ub','64','-ngl','0','--no-mmproj-offload',
             '--no-warmup','--jinja','--no-webui','--alias','local-ocr-test']
    suffix=('-'+args.only if args.only else '')+('-regions16' if args.regions16 else '')+(f'-pad{args.regions_padding}' if args.regions_padding else '')+(f'-edge{args.max_edge}' if args.max_edge else '')
    output=work/'results'/f'vlm-{args.model}{suffix}.json'
    record={'model':args.model,'manifest':manifest,'runtime':'llama.cpp b11852 CPU',
            'context_tokens':args.context,'threads':2,'remote_api_requests':0,
            'request_image_max_edge':args.max_edge,'input_mode':'native_pdf_question_regions' if args.regions16 else 'direct_image',
            'region_padding_pt':args.regions_padding,
            'server_bound_to_loopback':True,'status':'starting','results':[]}
    save(output,record)
    started=time.monotonic()
    process=None
    with (work/'logs'/f'{args.model}{suffix}-llama-server.log').open('w',encoding='utf8') as log:
        try:
            process=subprocess.Popen(command,stdout=log,stderr=subprocess.STDOUT,
                                     creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            ready=False
            for _ in range(400):
                if process.poll() is not None:
                    raise RuntimeError('Local OCR runtime exited; inspect its experiment log')
                try:
                    with urlopen(base+'/health',timeout=.8) as response:
                        ready=response.status==200
                except (OSError,URLError):
                    pass
                if ready:
                    break
                time.sleep(.2)
            if not ready:
                raise TimeoutError('Local model startup exceeded limit')
            record.update(status='running',startup_seconds=round(time.monotonic()-started,3))
            save(output,record)
            print('Local model ready',args.model,'seconds',record['startup_seconds'],flush=True)
            for case in selected:
                image=work/'samples'/case['image']
                from PIL import Image
                with Image.open(image) as source:
                    picture=source.convert('RGB')
                    original_size=picture.size
                    if args.max_edge:
                        picture.thumbnail((args.max_edge,args.max_edge),Image.Resampling.LANCZOS)
                    request_size=picture.size
                    encoded=BytesIO()
                    picture.save(encoded,format='PNG')
                text_case=case['id']=='page16-full' or case.get('task')=='text'
                prompt=text_prompt if text_case else 'Formula Recognition:'
                payload={'model':'local-ocr-test','messages':[{'role':'user','content':[
                    {'type':'image_url','image_url':{'url':'data:image/png;base64,'+base64.b64encode(encoded.getvalue()).decode('ascii')}},
                    {'type':'text','text':prompt}]}],
                    'temperature':0,'top_p':1,'max_tokens':3072 if case['id']=='page16-full' else 1024 if text_case else 384,
                    'stream':False}
                record['current_case']=case['id']
                save(output,record)
                begin=time.monotonic()
                request=Request(base+'/v1/chat/completions',data=json.dumps(payload).encode('utf8'),headers={'Content-Type':'application/json'})
                try:
                    with urlopen(request,timeout=300) as response:
                        raw=json.load(response)
                except HTTPError as error:
                    details=error.read(1000).decode('utf8',errors='replace')
                    raise RuntimeError(f'Local inference HTTP {error.code}: {details}') from None
                choice=raw['choices'][0]
                row={key:case[key] for key in ('id','physical_page','reference')}
                row.update(original_image_size=original_size,request_image_size=request_size,
                           **{key:case[key] for key in ('paper','number','bbox','anchor_bbox','padding_pt') if key in case})
                row.update(prompt=prompt,seconds=round(time.monotonic()-begin,3),
                           text=choice['message'].get('content',''),finish_reason=choice.get('finish_reason'),
                           usage=raw.get('usage'),timings=raw.get('timings'))
                record['results'].append(row)
                save(output,record)
                (work/'results'/f'{args.model}-{case["id"]}{suffix}.md').write_text(row['text'],encoding='utf8')
                print(json.dumps({'case':case['id'],'seconds':row['seconds'],'finish_reason':row['finish_reason'],
                                  'chars':len(row['text'])},ensure_ascii=False),flush=True)
            record.update(status='complete',seconds=round(time.monotonic()-started,3))
            record.pop('current_case',None)
        except Exception as error:
            record.update(status='failed',error=type(error).__name__+': '+str(error),seconds=round(time.monotonic()-started,3))
            raise
        finally:
            save(output,record)
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=8)


if __name__=='__main__':
    main()
