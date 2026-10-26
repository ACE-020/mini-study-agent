"""Run higher-quality MinerU locally with verified GGUF paths and bounded concurrency."""
import argparse
import json
from pathlib import Path
import time


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--tier',choices=['standard','advanced'],required=True)
    parser.add_argument('--case',choices=['crop','page16'],default='crop')
    args=parser.parse_args()
    root=Path(__file__).resolve().parents[2]
    work=root/'experiments/document-pipeline/work'
    folder=root/'.tools/document-pipeline/models/mineru'
    manifest=json.loads((folder/'download.json').read_text(encoding='utf8'))
    for name in ('MinerU2.5-Pro-2605-1.2B-Q8_0.gguf','mmproj-MinerU2.5-Pro-2605-1.2B-Q8_0.gguf'):
        if not (folder/name).is_file():
            raise RuntimeError('Missing local model '+name)
    from mineru.model.mfr import pp_formulanet_plus_m_onnx as formula
    formula.CPU_BATCH_SIZE=1
    from mineru.model.vlm.runtime import ModelSingleton
    original=ModelSingleton.get_model
    def bounded_model(self,backend,model_path,server_url,**kwargs):
        if backend=='llama-cpp-engine':
            model_path=str(folder)
            kwargs.update(n_ctx_seq=8192,n_gpu_layers=0,n_parallel=1,n_threads=2,max_concurrency=1)
        return original(self,backend,model_path,server_url,**kwargs)
    ModelSingleton.get_model=bounded_model
    from mineru.config import VlmConfig
    from mineru.parser import parse
    from mineru.parser.writer import FileBasedDataWriter
    image=work/'samples/formula-crops/p37-critical-q6.png' if args.case=='crop' else work/'samples/digital-16.pdf'
    output=work/'results'/f'mineru-{args.tier}-{args.case}'
    output.mkdir(exist_ok=True)
    start=time.monotonic()
    result=parse(image,tier=args.tier,vlm_config=VlmConfig(engine='llama-cpp',max_concurrency=1))
    result.save(FileBasedDataWriter(str(output)))
    info={'tier':args.tier,'case':args.case,'seconds':round(time.monotonic()-start,3),
          'threads':2,'parallel':1,'context_per_slot':8192,'remote_requests':0,'weights':manifest,
          'markdown':result.markdown()}
    (output/'test-info.json').write_text(json.dumps(info,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps({k:info[k] for k in ('tier','case','seconds','markdown')},ensure_ascii=False),flush=True)


if __name__=='__main__':
    main()
