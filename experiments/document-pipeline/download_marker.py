"""Download official CPU runtime and public Marker model weights, without loading them."""
import hashlib,json,time,urllib.request,zipfile
from pathlib import Path
ROOT=Path('D:/yjm/project/mini-study-agent/.tools/document-pipeline')
def sha256_file(path):
 with path.open('rb') as source:return hashlib.file_digest(source,'sha256').hexdigest()

def download_weight(name,metadata):
 # Plain streamed HTTP avoids the Xet client's ~1GB transient allocation here.
 path=ROOT/'models/surya-ocr2'/name;path.parent.mkdir(parents=True,exist_ok=True)
 expected=metadata['lfs']['sha256'];size=metadata['size']
 if path.exists() and path.stat().st_size==size and sha256_file(path)==expected:return path
 partial=path.with_suffix(path.suffix+'.part');offset=partial.stat().st_size if partial.exists() else 0
 request=urllib.request.Request('https://huggingface.co/datalab-to/surya-ocr-2-gguf/resolve/main/'+name,
                               headers={'Range':f'bytes={offset}-'} if offset else {})
 with urllib.request.urlopen(request,timeout=90) as source:
  append=source.status==206 and source.headers.get('Content-Range','').startswith(f'bytes {offset}-')
  if source.status==206 and not append:raise RuntimeError('Unexpected partial response')
  with partial.open('ab' if append else 'wb') as output:
   last=time.monotonic()
   while block:=source.read(1024*1024):
    output.write(block)
    if time.monotonic()-last>=20:
     print(name,round(output.tell()/2**20,1),'/',round(size/2**20,1),'MiB',flush=True);last=time.monotonic()
 if partial.stat().st_size!=size or sha256_file(partial)!=expected:raise RuntimeError('Model checksum mismatch')
 partial.replace(path);return path

def main():
 release=json.loads((ROOT/'llama-release.json').read_text(encoding='utf8'));asset=release['asset']
 archive=ROOT/'bootstrap'/asset['name'];expected=(asset.get('digest') or '').removeprefix('sha256:')
 if not archive.exists():
  print('Downloading official runtime',asset['name'],flush=True)
  with urllib.request.urlopen(asset['browser_download_url'],timeout=120) as source,archive.open('wb') as output:
   while block:=source.read(1024*1024):output.write(block)
 digest=sha256_file(archive)
 if expected and digest!=expected:raise RuntimeError('Runtime checksum mismatch')
 dest=ROOT/'llama-cpu'
 with zipfile.ZipFile(archive) as z:
  for member in z.infolist():
   if not (dest/member.filename).resolve().is_relative_to(dest.resolve()):raise RuntimeError('Unsafe archive member')
  z.extractall(dest)
 binary=next(dest.rglob('llama-server.exe'))
 result={'runtime':{'release':release['release'],'binary':str(binary),'sha256':digest},'weights':[]}
 with urllib.request.urlopen('https://huggingface.co/api/models/datalab-to/surya-ocr-2-gguf?blobs=true',timeout=60) as response:
  repo=json.load(response)
 files={item['rfilename']:item for item in repo['siblings']}
 for name in ['surya-2.gguf','surya-2-mmproj.gguf']:
  print('Downloading public model',name,flush=True)
  path=download_weight(name,files[name])
  row={'name':name,'path':str(path),'bytes':path.stat().st_size,'sha256':sha256_file(path)};result['weights'].append(row)
  print('Downloaded',name,round(row['bytes']/2**20,1),'MiB',flush=True)
 (ROOT/'marker-runtime.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
 print('Download complete; models have not been loaded',flush=True)

if __name__=='__main__':main()
