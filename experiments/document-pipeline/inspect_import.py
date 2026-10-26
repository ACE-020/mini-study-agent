"""Check page/identity coverage and locally render the converted Markdown for review.

Coverage checks refer to original PDF labels, not a claim of semantic OCR accuracy.
"""
import argparse
from collections import Counter
import html
import json
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--project', type=Path, required=True)
    parser.add_argument('--result', type=Path, required=True)
    args = parser.parse_args()
    sys.path.insert(0, str(args.project))
    from material_locations import validate_region
    from playwright.sync_api import sync_playwright
    document = json.loads((args.result/'document.json').read_text(encoding='utf8'))
    questions, answers = {}, {}
    for page in document['pages']:
        for anchor in page['anchors']:
            validate_region(anchor['bbox'])
            key = (anchor['paper'], anchor['number'])
            target = questions if anchor['role'] == 'question' else answers
            target.setdefault(key, []).append({'physical_page': page['physical_page'], 'bbox': anchor['bbox']})
    assert len(questions) == 32, f'Expected 32 original question anchors, found {len(questions)}'
    assert all(key in answers for key in questions), 'An original question has no answer location'
    assert len({paper for paper, number in questions}) == 2
    identities = [{'paper': paper, 'number': number, 'question_locations': locations,
                   'answer_locations': answers[(paper, number)]} for (paper, number), locations in questions.items()]
    (args.result/'identities.json').write_text(json.dumps(identities, ensure_ascii=False, indent=2), encoding='utf8')
    katex = args.project/'static/vendor/katex'
    pandoc = next((args.project/'.tools/document-pipeline/export-env/Lib/site-packages/pypandoc').rglob('pandoc.exe'))
    header = args.result/'preview-header.html'
    header.write_text('<link rel="stylesheet" href="'+(katex/'katex.min.css').as_uri()+'">'
                     '<style>body{max-width:980px;margin:36px auto;padding:0 24px;color:#192638;'
                     'font:17px/1.8 "Microsoft YaHei",sans-serif;background:#fafbff}'
                     '.katex{font-size:1.05em}.katex-display{overflow:auto}h2{margin-top:36px;color:#5741a2}'
                     'hr{margin:42px 0;border:0;border-top:1px solid #ddd}img{max-width:100%}'
                     'details{padding:16px;border:1px solid #ccc;border-radius:12px;margin:20px 0}'
                     '</style>', encoding='utf8')
    preview = args.result/'preview.html'
    subprocess.run([str(pandoc), str((args.result/'document.md').resolve()), '-f',
                    'markdown+tex_math_dollars+tex_math_single_backslash', '-t', 'html5',
                    '--standalone', '--embed-resources', '--resource-path', str(args.result.resolve()),
                    '--katex='+katex.as_uri()+'/', '--include-in-header', str(header),
                    '-M', 'lang=zh-CN', '-M', 'pagetitle=PDF本地导入校对稿', '-o', str(preview)], check=True)
    with sync_playwright() as p:
        browser = None
        for channel in ('chrome', 'msedge'):
            try:
                browser = p.chromium.launch(channel=channel, headless=True)
                break
            except Exception:
                pass
        if browser is None:
            raise RuntimeError('No installed browser for formula rendering check')
        page = browser.new_page(viewport={'width':1200, 'height':1050})
        blocked = []
        def local_only(route):
            if route.request.url.startswith(('http:', 'https:')):
                blocked.append(route.request.url)
                route.abort()
            else:
                route.continue_()
        page.route('**/*', local_only)
        page.goto(preview.resolve().as_uri(), wait_until='load')
        page.evaluate('document.fonts.ready')
        rendered = page.evaluate('''()=>({formulas:document.querySelectorAll('.katex').length,
            errors:[...document.querySelectorAll('.katex-error')].map(n=>({text:n.textContent,error:n.title}))})''')
        page.screenshot(path=str(args.result/'preview-first.png'))
        browser.close()
    by_paper = Counter(paper for paper, number in questions)
    metrics = [json.loads(path.read_text(encoding='utf8')) for path in
               (args.project/'experiments/document-pipeline/work/results').glob('import-local-page-*-metrics.json')]
    result = {'original_question_anchors':len(questions), 'papers':dict(by_paper),
              'question_ids_with_answer_locations':sum(key in answers for key in questions),
              'physical_pages':document['physical_pages'], 'coverage_is_not_ocr_accuracy':True,
              'local_inference_seconds':round(sum(row['seconds'] for row in metrics), 2),
              'local_peak_rss_mb':max(row['peak_rss_mb'] for row in metrics),
              'worker_failures':[row['name'] for row in metrics if row['returncode'] or row['stopped_reason']],
              'rendering':rendered, 'blocked_network_requests':blocked}
    (args.result/'checks.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf8')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
