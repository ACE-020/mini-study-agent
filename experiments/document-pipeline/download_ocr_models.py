"""Resumable, checksum-verified public OCR weight download; no inference/uploads."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
import time
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
MODELS = {
    'glm': ('ggml-org/GLM-OCR-GGUF', ['GLM-OCR-Q8_0.gguf', 'mmproj-GLM-OCR-Q8_0.gguf']),
    'paddle': ('PaddlePaddle/PaddleOCR-VL-1.6-GGUF', ['PaddleOCR-VL-1.6-GGUF.gguf', 'PaddleOCR-VL-1.6-GGUF-mmproj.gguf', 'chat_template.jinja', 'README.md']),
    'mineru': ('jinzhenj/MinerU2.5-Pro-2605-1.2B-GGUF', ['MinerU2.5-Pro-2605-1.2B-Q8_0.gguf', 'mmproj-MinerU2.5-Pro-2605-1.2B-Q8_0.gguf']),
}


def sha(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def fetch(request, timeout=90):
    for attempt in range(3):
        try:
            return urlopen(request, timeout=timeout)
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt+1)


def download_file(url, target, metadata, connections):
    size = metadata['size']
    expected = metadata.get('lfs', {}).get('sha256')
    if target.exists() and target.stat().st_size == size and (not expected or sha(target) == expected):
        return
    if size < 1024*1024:
        with fetch(url) as source:
            data = source.read(size+1)
        if len(data) != size:
            raise RuntimeError('Incomplete metadata file')
        target.write_bytes(data)
        return
    if not expected:
        raise RuntimeError('Large weight has no published SHA256')
    chunks = target.parent/'.parts'/expected[:20]
    chunks.mkdir(parents=True, exist_ok=True)
    step = 32*1024*1024
    parts = [(i,start,min(size,start+step)-1) for i,start in enumerate(range(0,size,step))]
    def transfer(part):
        i,start,end = part
        path = chunks/f'{i:04d}.part'
        for attempt in range(3):
            offset = path.stat().st_size if path.exists() else 0
            if offset == end-start+1:
                return path
            if offset > end-start+1:
                raise RuntimeError('Invalid saved range size')
            request = Request(url+f'?download=true&part={start+offset}',
                              headers={'Range':f'bytes={start+offset}-{end}'})
            try:
                with fetch(request) as source:
                    content_range = f'bytes {start+offset}-{end}/{size}'
                    if source.status != 206 or source.headers.get('Content-Range') != content_range:
                        raise RuntimeError('Server did not honor verified byte range')
                    with path.open('ab') as output:
                        remaining = end-start+1-offset
                        while remaining:
                            block = source.read(min(1024*1024,remaining))
                            if not block:
                                raise RuntimeError('Truncated public model range')
                            output.write(block)
                            remaining -= len(block)
                return path
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(attempt+1)
    print('Downloading',target.name,round(size/2**20,1),'MiB',flush=True)
    with ThreadPoolExecutor(max_workers=connections) as pool:
        futures = [pool.submit(transfer,part) for part in parts]
        for completed,future in enumerate(as_completed(futures),1):
            future.result()
            print(target.name,'ranges',completed,'/',len(parts),flush=True)
    assembling = target.with_suffix(target.suffix+'.assembling')
    with assembling.open('wb') as output:
        for i,start,end in parts:
            path=chunks/f'{i:04d}.part'
            with path.open('rb') as source:
                while block:=source.read(1024*1024):
                    output.write(block)
    if assembling.stat().st_size != size or sha(assembling) != expected:
        raise RuntimeError('Model checksum mismatch')
    assembling.replace(target)
    # Remove only our individually named, verified download chunks after final verification.
    for i,start,end in parts:
        (chunks/f'{i:04d}.part').unlink()


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--model',choices=MODELS,required=True)
    parser.add_argument('--connections',type=int,default=4)
    args=parser.parse_args()
    repo,names=MODELS[args.model]
    folder=ROOT/'.tools/document-pipeline/models'/args.model
    folder.mkdir(parents=True,exist_ok=True)
    with fetch(f'https://huggingface.co/api/models/{repo}?blobs=true') as response:
        info=json.load(response)
    files={row['rfilename']:row for row in info['siblings']}
    manifest={'repo':repo,'revision':info['sha'],'files':[]}
    for name in names:
        target=folder/name
        download_file(f'https://huggingface.co/{repo}/resolve/{info["sha"]}/{name}',target,files[name],max(1,min(4,args.connections)))
        manifest['files'].append({'name':name,'bytes':target.stat().st_size,'sha256':sha(target)})
    (folder/'download.json').write_text(json.dumps(manifest,indent=2),encoding='utf8')
    print('Verified public model download complete:',args.model,flush=True)


if __name__=='__main__':
    main()
