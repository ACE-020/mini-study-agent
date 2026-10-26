"""Offline viewer for measured free OCR outputs; never runs inference or writes the library."""
import base64
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[2]


def read(path):
    return path.read_text(encoding='utf8') if path.is_file() else None


def main():
    work=ROOT/'experiments/document-pipeline/work'
    results=work/'results'
    crop=work/'samples/formula-crops/p37-critical-q6.png'
    critical=[]
    for backend,label in [('mineru-formula','MinerU 基础公式模型'),('pix2text','Pix2Text 公式模型')]:
        path=results/f'formula-{backend}.json'
        if path.exists():
            data=json.loads(path.read_text(encoding='utf8'))
            row=next(row for row in data['results'] if row['id']=='p37-critical-q6')
            critical.append({'label':label,'text':'\\['+row['latex']+'\\]','seconds':row['seconds']})
    for backend,label in [('glm','GLM-OCR 本地 GGUF'),('paddle','PaddleOCR-VL 本地 GGUF')]:
        path=results/f'vlm-{backend}-p37-critical-q6.json'
        if path.exists():
            data=json.loads(path.read_text(encoding='utf8'))
            for row in data.get('results',[]):
                critical.append({'label':label,'text':row['text'],'seconds':row['seconds']})
    for tier,label in [('standard','MinerU 标准模式'),('advanced','MinerU 高精度模式')]:
        path=results/f'mineru-{tier}-crop/test-info.json'
        if path.exists():
            data=json.loads(path.read_text(encoding='utf8'))
            critical.append({'label':label,'text':data['markdown'],'seconds':data['seconds']})
    pages=[]
    choices=[('GLM-OCR · 整页长边1024',results/'vlm-glm-page16-full-edge1024.json'),
             ('PaddleOCR-VL · 整页长边1024',results/'vlm-paddle-edge1024.json')]
    for label,path in choices:
        if path.exists():
            data=json.loads(path.read_text(encoding='utf8'))
            for row in data.get('results',[]):
                if row['id']=='page16-full':
                    pages.append({'label':label,'text':row['text'],'seconds':row['seconds']})
    for tier in ('standard','advanced'):
        path=results/f'mineru-{tier}-page16/test-info.json'
        if path.exists():
            data=json.loads(path.read_text(encoding='utf8'))
            pages.append({'label':'MinerU '+tier+' · PDF直接解析（输入方式不同）','text':data['markdown'],'seconds':data['seconds']})
    for suffix,label in [('-pad8','GLM-OCR · 原题分区+8pt留白（含脚注混入）'),('','GLM-OCR · 原分区裁图（有截断，仅诊断）')]:
        path=results/f'vlm-glm-regions16{suffix}.json'
        if path.exists():
            data=json.loads(path.read_text(encoding='utf8'))
            if data.get('status')=='complete':
                content='\n\n'.join('【'+row.get('number',row['id'])+'】\n'+row['text'] for row in data['results'])
                pages.append({'label':label,'text':content,'seconds':sum(row['seconds'] for row in data['results'])})
    data={'critical':critical,'page':pages,
          'crop':'data:image/png;base64,'+base64.b64encode(crop.read_bytes()).decode('ascii'),
          'pageImage':'data:image/png;base64,'+base64.b64encode((work/'samples/original-page16.png').read_bytes()).decode('ascii')}
    encoded=json.dumps(data,ensure_ascii=False).replace('<','\\u003c')
    katex=ROOT/'static/vendor/katex'
    template='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>免费OCR本机实测</title><link rel="stylesheet" href="KCSS"><script defer src="KJS"></script><script defer src="KAUTO"></script>
<style>*{box-sizing:border-box}body{margin:0;background:#f5f6fb;color:#1d293b;font:16px/1.7 "Microsoft YaHei",sans-serif}header{padding:25px 32px;background:white;border-bottom:1px solid #e1dfec}
h1{font-size:25px;margin:0}header p{margin:8px 0 0;color:#58647a}nav{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:20px 28px;position:sticky;top:0;background:#f5f6fb;z-index:2}
button,select{font:inherit;padding:9px 15px;border:1px solid #d9d3ed;background:white;color:#463685;border-radius:9px;cursor:pointer}button.active{background:#6954ca;color:white}select{max-width:100%}.workspace{padding:0 28px 28px;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px;align-items:start}
.panel{min-width:0;background:white;border:1px solid #e1dfed;border-radius:14px;padding:22px;height:calc(100vh - 240px);min-height:350px;display:flex;flex-direction:column}h2{font-size:18px;margin:0 0 14px}.scroll{overflow:auto;min-height:0;flex:1}img{display:block;width:100%;height:auto}.output{white-space:pre-wrap;overflow-wrap:anywhere}.output .katex{white-space:normal}.katex-display{overflow:auto;padding:10px}.note{font-size:14px;color:#6c617c;margin:12px 0 0}@media(max-width:900px){.workspace{grid-template-columns:1fr}.panel{height:65vh}.panel:first-child{height:45vh}header{padding:20px}}</style>
<header><h1>免费识别方案 · 本机实测</h1><p>2026-10-25 · 展示已完成的真实输出，不调用模型、不修改题库。局部公式与整页分开比较。</p></header>
<nav><button id="critical" class="active">第6题公式</button><button id="page">完整第16页</button><select id="models" aria-label="选择已经测试的模型"></select><span id="timing"></span></nav>
<div class="workspace"><section class="panel"><h2>原始内容</h2><div class="scroll"><img id="source" alt="原稿"></div><p class="note">第6题要特别核对：减1在外层根号外。整页参考图保留原尺寸，模型输入尺寸见选项。</p></section>
<section class="panel"><h2 id="heading">模型输出</h2><div class="scroll output" id="output"></div><p class="note">原始模型文本保留；公式能渲染，不代表数学内容正确。PDF解析和直接读整页图的输入方式不同。</p></section></div>
<script>const results=DATA;let view='critical';
function render(){let selected=results[view][Number(document.getElementById('models').value)];document.getElementById('source').src=view==='critical'?results.crop:results.pageImage;let node=document.getElementById('output');node.textContent=selected?.text||'本项尚无完成结果。';document.getElementById('heading').textContent=selected?.label||'暂无结果';document.getElementById('timing').textContent=selected?'识别/解析 '+selected.seconds.toFixed(2)+' 秒（不含独立启动）':'';renderMathInElement(node,{delimiters:[{left:'$$',right:'$$',display:true},{left:'\\\\[',right:'\\\\]',display:true},{left:'\\\\(',right:'\\\\)',display:false},{left:'$',right:'$',display:false}],throwOnError:false,trust:false});}
function switchView(next){view=next;let select=document.getElementById('models');select.replaceChildren();results[view].forEach((item,index)=>{let option=document.createElement('option');option.value=index;option.textContent=item.label;select.append(option);});document.querySelectorAll('nav button').forEach(button=>button.classList.toggle('active',button.id===view));render();}
window.addEventListener('load',()=>{document.getElementById('critical').onclick=()=>switchView('critical');document.getElementById('page').onclick=()=>switchView('page');document.getElementById('models').onchange=render;switchView('critical');window.ready=true;});</script></html>'''
    template=template.replace('KCSS',(katex/'katex.min.css').as_uri()).replace('KJS',(katex/'katex.min.js').as_uri()).replace('KAUTO',(katex/'auto-render.min.js').as_uri()).replace('DATA',encoded)
    path=results/'free-ocr-review.html'
    path.write_text(template,encoding='utf8')
    with sync_playwright() as p:
        browser=None
        for channel in ('chrome','msedge'):
            try:browser=p.chromium.launch(channel=channel,headless=True);break
            except Exception:pass
        if not browser:raise RuntimeError('No local browser')
        page=browser.new_page(viewport={'width':1450,'height':1000})
        page.route('http://**/*',lambda route:route.abort())
        page.route('https://**/*',lambda route:route.abort())
        page.goto(path.as_uri(),wait_until='load');page.wait_for_function('window.ready===true');page.evaluate('document.fonts.ready')
        errors=[]
        for mode in ('critical','page'):
            page.locator('#'+mode).click()
            for index in range(len(data[mode])):
                page.locator('#models').select_option(str(index))
                errors.extend(page.locator('.katex-error').all_text_contents())
        page.locator('#critical').click()
        if len(data['critical'])>2:page.locator('#models').select_option('2')
        page.screenshot(path=str(results/'free-ocr-review.png'))
        browser.close()
    (results/'free-ocr-review-checks.json').write_text(json.dumps({'critical_models':len(critical),'page_models':len(pages),'math_render_errors':errors},ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps({'critical_models':len(critical),'page_models':len(pages),'math_render_errors':len(errors)}))


if __name__=='__main__':
    main()
