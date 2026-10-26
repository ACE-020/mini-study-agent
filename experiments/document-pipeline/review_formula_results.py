"""Create a local, side-by-side visual check of the same-crop formula experiment."""
import base64
import html
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]


def main():
    work = ROOT/'experiments/document-pipeline/work'
    cases = json.loads((work/'samples/formula-cases.json').read_text(encoding='utf8'))
    backends = ['mineru-formula', 'pix2text']
    outputs = {backend: json.loads((work/'results'/f'formula-{backend}.json').read_text(encoding='utf8'))
               for backend in backends}
    predictions = {backend:{row['id']:row for row in value['results']} for backend,value in outputs.items()}
    order = sorted(cases, key=lambda case: case['id'] != 'p37-critical-q6')
    cards = []
    for case in order:
        image = base64.b64encode((work/'samples'/case['image']).read_bytes()).decode('ascii')
        values = {'人工对照式':case['reference'], 'MinerU 基础公式模型':predictions['mineru-formula'][case['id']]['latex'],
                  'Pix2Text 公式模型':predictions['pix2text'][case['id']]['latex']}
        cells = []
        for label,latex in values.items():
            cells.append('<div class="cell"><h3>'+html.escape(label)+'</h3><div class="math" data-tex="'+
                         html.escape(latex,quote=True)+'"></div><details><summary>查看原始 LaTeX</summary><pre>'+
                         html.escape(latex)+'</pre></details></div>')
        note = ''
        if case['id']=='p37-critical-q6':
            note = '<p class="notice">核对减 1 的位置：原图在外层根号外。MinerU 把它放入根号，Pix2Text 保留在根号外。</p>'
        elif case['id']=='p16-nested-root':
            note = '<p class="notice">这里原图末尾是填空横线，Pix2Text 误识别成了箭头。</p>'
        elif case['id']=='p18-exp-cases':
            note = '<p class="notice">这张裁图左缘残留一个文字笔画，两种模型都产生杂符；不据此给模型排名。</p>'
        cards.append('<article><h2>'+html.escape(case['id'])+' · 文件第 '+str(case['physical_page'])+' 页</h2>'+
                     note+'<div class="original"><img alt="原公式局部图" src="data:image/png;base64,'+image+'"></div>'+
                     '<div class="columns">'+''.join(cells)+'</div></article>')
    katex = ROOT/'static/vendor/katex'
    content = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>公式识别同图对照</title><link rel="stylesheet" href="KATEX_CSS"><script defer src="KATEX_JS"></script>
<style>body{background:#f5f6fb;color:#202a3b;font:16px/1.65 "Microsoft YaHei",sans-serif;margin:0;padding:28px}
main{max-width:1500px;margin:auto}h1{margin:0}header{margin-bottom:25px}article{background:white;border:1px solid #dddfea;border-radius:16px;margin:22px 0;padding:24px}
h2{font-size:19px}h3{font-size:16px;margin-top:0;color:#5b46a3}.original{background:#fafaff;padding:16px;border-radius:10px}.original img{max-width:100%;max-height:230px}
.columns{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-top:22px}.cell{min-width:0;padding:16px;border:1px solid #e2dff0;border-radius:10px}
.math{overflow:auto;min-height:110px;padding:12px 0}.katex{font-size:1.15em}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}
.notice{background:#fff5df;color:#71551d;padding:12px;border-radius:10px}summary{cursor:pointer;color:#6554a1}@media(max-width:1000px){.columns{grid-template-columns:1fr}body{padding:12px}}
</style><main><header><h1>同一张图，两个公式模型</h1><p>10 个印刷公式局部样本。只比较公式识别，不代表整页解析或全部数学题的准确率。原始模型输出保留；未调用付费接口。</p></header>CARDS</main>
<script>window.addEventListener('load',()=>{document.querySelectorAll('.math').forEach(el=>katex.render(el.dataset.tex,el,{displayMode:true,throwOnError:false,trust:false}));window.ready=true;});</script></html>'''
    content = content.replace('KATEX_CSS',(katex/'katex.min.css').as_uri()).replace('KATEX_JS',(katex/'katex.min.js').as_uri()).replace('CARDS',''.join(cards))
    path = work/'results/formula-comparison.html'
    path.write_text(content,encoding='utf8')
    with sync_playwright() as p:
        browser = None
        for channel in ('chrome','msedge'):
            try:
                browser=p.chromium.launch(channel=channel,headless=True)
                break
            except Exception:
                pass
        if browser is None:
            raise RuntimeError('No installed browser')
        page=browser.new_page(viewport={'width':1540,'height':1050})
        page.route('http://**/*',lambda route:route.abort())
        page.route('https://**/*',lambda route:route.abort())
        page.goto(path.as_uri(),wait_until='load')
        page.wait_for_function('window.ready===true')
        page.evaluate('document.fonts.ready')
        report=page.evaluate('''()=>({formula_nodes:document.querySelectorAll('.math').length,
          errors:[...document.querySelectorAll('.katex-error')].map(n=>({text:n.textContent,error:n.title}))})''')
        page.screenshot(path=str(work/'results/formula-comparison.png'))
        browser.close()
    (work/'results/formula-comparison-render.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps(report,ensure_ascii=False))


if __name__=='__main__':
    main()
