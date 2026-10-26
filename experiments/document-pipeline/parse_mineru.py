"""Low-memory local MinerU trial; upstream files and weights stay unchanged."""
import argparse,json,time
from pathlib import Path

def main():
 parser=argparse.ArgumentParser();parser.add_argument('input',type=Path);parser.add_argument('output',type=Path);parser.add_argument('--formula-batch',type=int,default=1);args=parser.parse_args()
 from mineru.model.mfr import pp_formulanet_plus_m_onnx as formula
 formula.CPU_BATCH_SIZE=max(1,args.formula_batch)
 from mineru.parser import parse
 from mineru.parser.writer import FileBasedDataWriter
 start=time.monotonic();result=parse(str(args.input),tier='basic')
 args.output.mkdir(parents=True,exist_ok=True)
 result.save(FileBasedDataWriter(str(args.output)))
 info={'seconds':round(time.monotonic()-start,2),'tier':'basic','formula_batch':formula.CPU_BATCH_SIZE,'markdown_chars':len(result.markdown()),'files':[p.name for p in args.output.iterdir()]}
 (args.output/'run-info.json').write_text(json.dumps(info,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(info,ensure_ascii=False))

if __name__=='__main__':main()
