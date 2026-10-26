"""Download the independent public Pix2Text ONNX formula model, never upload images."""
import hashlib
import json
from pathlib import Path
import time
from urllib.request import Request, urlopen
from urllib.error import URLError

ROOT = Path(__file__).resolve().parents[2]
REPO = 'breezedeus/pix2text-mfr-1.5'
NAMES = ['config.json', 'generation_config.json', 'preprocessor_config.json',
         'special_tokens_map.json', 'tokenizer.json', 'tokenizer_config.json',
         'encoder_model.onnx', 'decoder_model.onnx']


def fetch(request, timeout=90):
    for attempt in range(3):
        try:
            return urlopen(request, timeout=timeout)
        except (URLError, TimeoutError, ConnectionError):
            if attempt == 2:
                raise
            print('Retrying public download connection', attempt+1, flush=True)
            time.sleep(attempt+1)


def sha(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def main():
    folder = ROOT/'.tools/document-pipeline/models/pix2text-mfr-1.5'
    folder.mkdir(parents=True, exist_ok=True)
    with fetch(f'https://huggingface.co/api/models/{REPO}?blobs=true', timeout=45) as response:
        repo = json.load(response)
    files = {item['rfilename']: item for item in repo['siblings']}
    results = []
    for name in NAMES:
        info = files[name]
        expected = info.get('lfs', {}).get('sha256')
        target = folder/name
        if not (target.exists() and target.stat().st_size == info['size'] and (not expected or sha(target) == expected)):
            partial = target.with_suffix(target.suffix+'.part')
            offset = partial.stat().st_size if partial.exists() else 0
            request = Request(f'https://huggingface.co/{REPO}/resolve/{repo["sha"]}/{name}',
                              headers={'Range': f'bytes={offset}-'} if offset else {})
            print('Downloading', name, info['size'], flush=True)
            with fetch(request, timeout=90) as source:
                append = source.status == 206 and source.headers.get('Content-Range', '').startswith(f'bytes {offset}-')
                if source.status == 206 and not append:
                    raise RuntimeError('Unexpected byte range')
                with partial.open('ab' if append else 'wb') as output:
                    last = time.monotonic()
                    while block := source.read(1024*1024):
                        output.write(block)
                        if time.monotonic()-last > 15:
                            print(name, output.tell(), '/', info['size'], flush=True)
                            last = time.monotonic()
            if partial.stat().st_size != info['size'] or (expected and sha(partial) != expected):
                raise RuntimeError('Incomplete model or checksum mismatch')
            partial.replace(target)
        results.append({'name': name, 'bytes': target.stat().st_size, 'sha256': sha(target)})
    (folder/'download.json').write_text(json.dumps({'repo': REPO, 'revision': repo['sha'], 'files': results}, indent=2), encoding='utf8')
    print('Completed verified public model download; no inference or uploads', flush=True)


if __name__ == '__main__':
    main()
