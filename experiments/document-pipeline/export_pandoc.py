"""Offline Pandoc + local KaTeX + installed Chrome/Edge PDF export trial."""
import argparse,json,subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright

parser=argparse.ArgumentParser()
parser.add_argument('--project',type=Path,required=True)
parser.add_argument('--input',type=Path,required=True)
parser.add_argument('--output',type=Path,required=True)
args=parser.parse_args();args.output.parent.mkdir(parents=True,exist_ok=True)
manifest=json.loads((args.project/'.tools/document-pipeline/downloads.json').read_text(encoding='utf8'))
pandoc=next((args.project/'.tools/document-pipeline/export-env/Lib/site-packages/pypandoc').rglob('pandoc.exe'))
html=args.output.with_suffix('.html');header=args.output.with_suffix('.header.html')
vendor=args.project/'static/vendor/katex'
css='''@page{size:A4;margin:18mm 20mm}body{max-width:none;margin:0;color:#1d2633;font:11pt/1.7 "Microsoft YaHei","Noto Sans CJK SC",sans-serif}h1{font-size:21pt}h2{font-size:16pt}h1,h2,h3{break-after:avoid}p,li{orphans:3;widows:3}blockquote{border-left:3px solid #b9a4de;padding:5pt 12pt;background:#f8f5fc;margin:10pt 0}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ccd1dd;padding:6pt}tr{break-inside:avoid}pre{white-space:pre-wrap;overflow-wrap:anywhere}.katex-display{break-inside:avoid;margin:12pt 0}.katex{font-size:1.05em}img{max-width:100%;max-height:90mm}figure{margin:14pt 0;break-inside:avoid}figcaption{font-size:10pt;color:#6a6275}'''
header.write_text('<link rel="stylesheet" href="'+(vendor/'katex.min.css').as_uri()+'"><style>'+css+'</style>',encoding='utf8')
subprocess.run([str(pandoc),str(args.input.resolve()),'-f','markdown+tex_math_dollars+tex_math_single_backslash','-t','html5','--standalone','--embed-resources','--resource-path',str(args.input.parent.resolve()),'--katex='+vendor.as_uri()+'/', '--include-in-header',str(header),'-M','lang=zh-CN','-M','pagetitle=数学笔记导出验收','-o',str(html)],check=True)
with sync_playwright() as p:
 browser=None
 for channel in ('chrome','msedge'):
  try:browser=p.chromium.launch(channel=channel,headless=True);break
  except Exception:continue
 if browser is None:raise RuntimeError('No installed Chrome/Edge')
 page=browser.new_page(viewport={'width':1000,'height':1200})
 blocked=[]
 def network(route):
  if route.request.url.startswith(('http:','https:')):blocked.append(route.request.url);route.abort()
  else:route.continue_()
 page.route('**/*',network)
 page.goto(html.resolve().as_uri(),wait_until='load');page.evaluate('document.fonts.ready')
 details=page.evaluate('''()=>({errors:[...document.querySelectorAll('.katex-error')].map(n=>n.textContent),formulas:document.querySelectorAll('.katex').length,images:[...document.images].map(n=>({loaded:n.complete&&n.naturalWidth>0,width:n.naturalWidth})),overflow:[...document.querySelectorAll('p,table,pre,.katex-display')].filter(n=>n.scrollWidth>n.clientWidth+3).map(n=>n.textContent.slice(0,80))})''')
 if details['errors'] or details['overflow'] or any(not image['loaded'] for image in details['images']):raise RuntimeError(json.dumps(details,ensure_ascii=False))
 page.pdf(path=str(args.output.resolve()),format='A4',print_background=True,prefer_css_page_size=True)
 browser.close()
details['blocked_network']=blocked
args.output.with_suffix('.checks.json').write_text(json.dumps(details,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps(details,ensure_ascii=False,indent=2))
