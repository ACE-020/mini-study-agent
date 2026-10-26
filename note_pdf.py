"""无 TeX 环境时的固定备用渲染器：本地 KaTeX、Chrome、嵌入字体及文本检查。"""

import argparse
from collections import Counter
import json
import os
from pathlib import Path
import re
import tempfile


ROOT = Path(__file__).resolve().parent


def annotation_boundaries(source):
    active = False
    for index, line in enumerate(source.splitlines(), 1):
        if re.match(r"^>\s*\*\*注解", line):
            active = True
        elif active and not line.strip():
            active = False
        elif active and not line.startswith(">"):
            raise ValueError(f"第 {index} 行注解与正文之间缺少空行，请修正 Markdown 后重试。")


def pdf_html(source):
    vendor = ROOT / "static/vendor"
    scripts = "".join(f'<script src="{(vendor / name).as_uri()}"></script>' for name in
                      ("marked.umd.js", "purify.min.js", "katex/katex.min.js", "katex/auto-render.min.js"))
    payload = json.dumps(source, ensure_ascii=False).replace("<", "\\u003c")
    return f"""<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<link rel="stylesheet" href="{(vendor / 'katex/katex.min.css').as_uri()}">
<style>
@page {{ size:A4; margin:18mm 20mm; }}
* {{ box-sizing:border-box; }}
body {{ margin:0; width:170mm; color:#1d2633; font:11pt/1.65 'Microsoft YaHei','Noto Sans CJK SC',sans-serif; text-align:left; }}
h2 {{font-size:16pt;margin:1.25em 0 .5em;}} h3 {{font-size:13pt;margin:1.1em 0 .5em;}}
h2,h3,h4 {{ break-after:avoid; }} p,li {{ orphans:3;widows:3; }}
p {{margin:.55em 0;}} ul,ol {{padding-left:1.65em;}}
blockquote {{background:#f6f8fa;border-left:3px solid #b6c6d2;margin:12pt 0;padding:9pt 12pt;box-decoration-break:clone;-webkit-box-decoration-break:clone;font-size:10.8pt;}}
.short-unit {{break-inside:avoid;}} .katex-display {{margin:12pt 0; overflow:visible;break-inside:avoid;}}
.katex {{font-size:1.05em;}} .katex .text {{font-family:'Microsoft YaHei','Noto Sans CJK SC',sans-serif;}}
table {{border-collapse:collapse;width:100%;margin:12pt 0;}}td,th {{border:1px solid #cbd3dc;padding:6pt;text-align:left;}}
tr {{break-inside:avoid;}} pre {{white-space:pre-wrap;overflow-wrap:anywhere;}} code {{font-size:.9em;}}
img {{display:none;}} a {{color:inherit;text-decoration:none;}} hr {{border:0;border-top:1px solid #ccd3dc;}}
</style>{scripts}<main id="notes"></main><script>
const source={payload};
const formulas=[];
const protectedText=source.replace(/\\$\\$[\\s\\S]*?\\$\\$|\\\\\\[[\\s\\S]*?\\\\\\]|\\\\\\([\\s\\S]*?\\\\\\)|(?<!\\$)\\$(?!\\$)[^\\n$]+?\\$(?!\\$)/g,(f,offset)=>{{if(/(?:^|\\n)[ \\t]*>[ \\t]*$/.test(source.slice(0,offset)))f=f.replace(/\\n[ \\t]*>[ \\t]?/g,'\\n');formulas.push(f);return `NOTEFORMULA${{formulas.length-1}}TOKEN`;}});
let markup=DOMPurify.sanitize(marked.parse(protectedText),{{FORBID_TAGS:['img','svg','style','iframe','object','script'],FORBID_ATTR:['style']}});
markup=markup.replace(/NOTEFORMULA(\\d+)TOKEN/g,(_,i)=>{{const el=document.createElement('span');el.textContent=formulas[i];return el.innerHTML;}});
const notes=document.getElementById('notes');notes.innerHTML=markup;
const mathErrors=[];
renderMathInElement(notes,{{delimiters:[{{left:'$$',right:'$$',display:true}},{{left:'\\\\[',right:'\\\\]',display:true}},{{left:'\\\\(',right:'\\\\)',display:false}},{{left:'$',right:'$',display:false}}],throwOnError:false,trust:false,strict:'ignore',errorCallback:m=>mathErrors.push(m)}});
// 按原有语义边界分段；较短正文与紧邻的注解成组，较长段落自然跨页。
for(const box of [...notes.querySelectorAll('blockquote')]){{
 const heads=[...box.children].filter(p=>p.tagName==='P'&&p.firstElementChild?.tagName==='STRONG'&&/^(补充证明|补充说明|补充例子)/.test(p.textContent));
 if(box.getBoundingClientRect().height>760&&heads.length>1){{
  for(const head of heads.slice(1)){{if(!head.isConnected||head.parentNode!==box)continue;const next=document.createElement('blockquote');const title=document.createElement('p');title.innerHTML='<strong>注解（续）</strong>';next.append(title);let p=head;while(p){{const after=p.nextSibling;next.append(p);p=after;}}box.after(next);}}
 }}
}}
for(const box of notes.querySelectorAll('blockquote')){{if(box.getBoundingClientRect().height<600)box.classList.add('short-unit');}}
for(const heading of [...notes.querySelectorAll('h2,h3')]){{const unit=document.createElement('section');heading.before(unit);unit.append(heading);while(unit.nextSibling&&!/^(H2|H3)$/.test(unit.nextSibling.nodeName))unit.append(unit.nextSibling);if(unit.getBoundingClientRect().height<740)unit.classList.add('short-unit');}}
window.noteReady=document.fonts.ready.then(()=>{{const visible=notes.cloneNode(true);visible.querySelectorAll('.katex-mathml').forEach(el=>el.remove());return {{mathErrors,plain:visible.textContent,overflow:[...notes.querySelectorAll('p,table,.katex-display,pre')].filter(el=>el.getBoundingClientRect().right>notes.getBoundingClientRect().right+2||el.scrollWidth>el.clientWidth+3).map(el=>el.innerText.slice(0,60))}};}});
</script></html>"""


def verify_pdf(path, plain):
    import pymupdf as fitz
    with fitz.open(path) as document:
        if not len(document):
            raise ValueError("PDF 没有页面。")
        extracted = "".join(page.get_text() for page in document)
        expected = Counter(re.findall(r"[\u4e00-\u9fff]", plain))
        actual = Counter(re.findall(r"[\u4e00-\u9fff]", extracted))
        missing = expected - actual
        if missing:
            raise ValueError("PDF 中文提取核验失败，缺少：" + "".join(missing)[:40])
        for page in document:
            for font in page.get_fonts(full=True):
                if not document.extract_font(font[0])[3]:
                    raise ValueError("PDF 字体未嵌入：" + str(font[3]))
            if "\ufffd" in page.get_text():
                raise ValueError("PDF 中发现无法识别的字符。")
        return len(document)


def render(markdown, output, cancel_file=None, preview_dir=None):
    from playwright.sync_api import sync_playwright
    source = Path(markdown).read_text(encoding="utf-8")
    annotation_boundaries(source)

    def check():
        if cancel_file and Path(cancel_file).exists():
            raise ValueError("已停止 PDF 排版。")

    check()
    with tempfile.TemporaryDirectory(prefix="note-html-", dir=Path(output).parent) as folder:
        page_path = Path(folder) / "notes.html"
        page_path.write_text(pdf_html(source), encoding="utf-8")
        with sync_playwright() as playwright:
            browser = None
            for channel in ("chrome", "msedge", None):
                try:
                    browser = playwright.chromium.launch(headless=True, **({"channel": channel} if channel else {}))
                    break
                except Exception:
                    continue
            if browser is None:
                raise ValueError("未找到可用浏览器；安装 Chrome / Edge，或运行 python -m playwright install chromium。")
            try:
                page = browser.new_page()
                allowed_roots = (page_path.parent.resolve(), (ROOT / "static/vendor").resolve())
                def route_request(route):
                    from urllib.parse import unquote, urlparse
                    url = urlparse(route.request.url)
                    if url.scheme != "file":
                        return route.abort()
                    path = unquote(url.path)
                    if os.name == "nt":
                        path = path.lstrip("/")
                    resolved = Path(path).resolve()
                    if any(resolved.is_relative_to(root) for root in allowed_roots):
                        route.continue_()
                    else:
                        route.abort()
                page.route("**/*", route_request)
                page.goto(page_path.as_uri(), wait_until="load", timeout=15000)
                check()
                status = page.evaluate("window.noteReady")
                if status["mathErrors"]:
                    raise ValueError("公式无法排版：" + status["mathErrors"][0][:180])
                if status["overflow"]:
                    raise ValueError("公式或表格超出页宽，请拆行后重试：" + status["overflow"][0])
                check()
                page.pdf(path=str(output), format="A4", print_background=True, prefer_css_page_size=True,
                         display_header_footer=False, tagged=True)
                check()
            finally:
                browser.close()
    pages = verify_pdf(output, status["plain"])
    if preview_dir:
        import pymupdf as fitz
        from PIL import Image, ImageOps, ImageDraw
        dest = Path(preview_dir)
        dest.mkdir(parents=True, exist_ok=True)
        thumbs = []
        with fitz.open(output) as document:
            for index, page in enumerate(document):
                target = dest / f"page-{index+1}.png"
                page.get_pixmap(matrix=fitz.Matrix(1.2, 1.2)).save(target)
                image = Image.open(target).convert("RGB")
                image.thumbnail((400, 570))
                tile = Image.new("RGB", (420, 610), "#e9ecf1")
                tile.paste(image, ((420-image.width)//2, 10))
                ImageDraw.Draw(tile).text((12, 587), str(index+1), fill="black")
                thumbs.append(tile)
        for start in range(0, len(thumbs), 4):
            chunk = thumbs[start:start+4]
            sheet = Image.new("RGB", (840, 610*((len(chunk)+1)//2)), "white")
            for index, tile in enumerate(chunk):
                sheet.paste(tile, ((index%2)*420, (index//2)*610))
            sheet.save(dest / f"contact-{start//4+1}.png")
    return pages


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("markdown", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--cancel-file", type=Path)
    parser.add_argument("--preview-dir", type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps({"ok": True, "pages": render(args.markdown, args.output, args.cancel_file, args.preview_dir)}))
    except Exception as exc:
        print(str(exc))
        raise SystemExit(1)
