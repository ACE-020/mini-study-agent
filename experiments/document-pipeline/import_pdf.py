"""Local PDF -> Markdown + provenance pilot. Never writes the study library.

Run with the app's Python; model inference uses a separate guarded environment.
Each physical page has a content-addressed checkpoint and its own short-lived worker.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time


VERSION = 'mineru-4.0.12-basic-batch1-v1'


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def save_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf8')
    temporary.replace(path)


def checkpoint_ok(folder, identity):
    try:
        stored = json.loads((folder / 'checkpoint.json').read_text(encoding='utf8'))
        if stored['identity'] != identity:
            return False
        for name, checksum in stored['outputs'].items():
            if digest(folder / name) != checksum:
                return False
        return {'markdown.md', 'structured_content.json', 'run-info.json'} <= stored['outputs'].keys()
    except (OSError, ValueError, KeyError, TypeError):
        return False


def normalized_blocks(content):
    pages = content.get('pages', [])
    if len(pages) != 1:
        raise ValueError('Expected one physical page in the local converter result')
    blocks = pages[0].get('blocks', [])
    if not blocks:
        raise ValueError('Local converter returned no text blocks')
    return blocks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pdf', type=Path)
    parser.add_argument('--pages', required=True, help='Physical file pages, e.g. 16-20')
    parser.add_argument('--project', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--cache-only', action='store_true', help='Fail rather than start a model worker')
    args = parser.parse_args()
    project = args.project.resolve()
    sys.path.insert(0, str(project))
    import pymupdf
    from document_input import parse_page_range
    from material_locations import pdf_layouts
    pipeline = project / 'experiments/document-pipeline'
    tools = project / '.tools/document-pipeline'
    python = tools / 'mineru-env/Scripts/python.exe'
    monitor = tools / 'export-env/Scripts/python.exe'
    for required in (python, monitor, pipeline / 'run.py', pipeline / 'parse_mineru.py'):
        if not required.is_file():
            raise RuntimeError(f'Local converter is not installed: {required}')
    source_hash = digest(args.pdf)
    args.output.mkdir(parents=True, exist_ok=True)
    cache = pipeline / 'work/cache' / source_hash / VERSION
    started = time.monotonic()
    records, markdown, reused = [], [], 0
    with pymupdf.open(args.pdf) as document:
        if document.needs_pass:
            raise ValueError('Unlock the PDF before importing')
        selected = parse_page_range(args.pages, len(document))
        layouts = pdf_layouts(document, selected)
        for ordinal, index in enumerate(selected, 1):
            physical = index + 1
            folder = cache / f'page-{physical:04d}'
            identity = {'source_sha256': source_hash, 'physical_page': physical, 'converter': VERSION}
            cached = checkpoint_ok(folder, identity)
            print(json.dumps({'stage': 'cached' if cached else 'converting', 'page': physical,
                              'completed': ordinal-1, 'total': len(selected)}, ensure_ascii=False), flush=True)
            if not cached:
                if args.cache_only:
                    raise RuntimeError(f'No verified checkpoint for physical page {physical}')
                folder.mkdir(parents=True, exist_ok=True)
                sample = folder / 'page.pdf'
                with pymupdf.open() as one_page:
                    one_page.insert_pdf(document, from_page=index, to_page=index)
                    one_page.save(sample, garbage=3, deflate=True)
                command = [str(monitor), str(pipeline/'run.py'), '--project', str(project),
                           '--name', f'import-local-page-{physical:04d}', '--timeout', '180',
                           '--rss-limit-mb', '1800', '--', str(python), str(pipeline/'parse_mineru.py'),
                           str(sample), str(folder)]
                subprocess.run(command, check=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                structured = json.loads((folder/'structured_content.json').read_text(encoding='utf8'))
                normalized_blocks(structured)
                if not (folder/'markdown.md').read_text(encoding='utf8').strip():
                    raise ValueError(f'Empty Markdown from physical page {physical}')
                outputs = {str(p.relative_to(folder)): digest(p) for p in folder.rglob('*')
                           if p.is_file() and p.name not in ('checkpoint.json', 'page.pdf') and p.suffix != '.tmp'}
                save_json(folder/'checkpoint.json', {'identity': identity, 'outputs': outputs})
            else:
                reused += 1
            structured = json.loads((folder/'structured_content.json').read_text(encoding='utf8'))
            blocks = normalized_blocks(structured)
            layout = layouts.get(index, {'paper': '', 'anchors': []})
            headers = [block['content'] for block in blocks
                       if block.get('type') == 'header' and isinstance(block.get('content'), str)]
            # Prefer explicit native labels. OCR headers remain evidence, never a guessed identity.
            paper = layout.get('paper', '')
            if not paper:
                paper = next((header for header in headers if re.search(r'考试|试卷|试题', header)), '')
            text = (folder/'markdown.md').read_text(encoding='utf8').strip()
            # Keep local figure paths unique between pages and usable after moving the output folder.
            for asset in folder.rglob('*'):
                if asset.is_file() and asset.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp', '.svg'):
                    relative = asset.relative_to(folder).as_posix()
                    target = args.output/'assets'/f'page-{physical:04d}'/asset.relative_to(folder)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(asset, target)
                    text = text.replace(f']({relative})', f']({target.relative_to(args.output).as_posix()})')
            prefix = f'## 文件第 {physical} 页\n\n来源：{args.pdf.name}'
            if paper:
                prefix += f'\n\n所属试卷：{paper}'
            markdown.append(prefix + '\n\n' + text)
            records.append({'physical_page': physical, 'source': args.pdf.name, 'paper': paper,
                            'headers': headers, 'anchors': layout.get('anchors', []),
                            'blocks': blocks, 'parser_metadata': structured.get('metadata', {}),
                            'checkpoint_reused': cached})
            print(json.dumps({'stage': 'complete', 'page': physical, 'completed': ordinal,
                              'total': len(selected)}, ensure_ascii=False), flush=True)
    summary = {'schema_version': 1, 'source': str(args.pdf.resolve()), 'source_sha256': source_hash,
               'converter': VERSION, 'requested_pages': args.pages, 'physical_pages': [n+1 for n in selected],
               'seconds': round(time.monotonic()-started, 2), 'cache_hits': reused,
               'local_only': True, 'question_bank_writes': 0, 'pages': records}
    content = '# PDF 本地公式识别稿\n\n自动转换结果需要核对原页；原页码均为文件物理页码。\n\n'+'\n\n---\n\n'.join(markdown)+'\n'
    temporary = args.output/'document.md.tmp'
    temporary.write_text(content, encoding='utf8')
    temporary.replace(args.output/'document.md')
    save_json(args.output/'document.json', summary)
    print(json.dumps({key: summary[key] for key in ('seconds', 'physical_pages', 'cache_hits', 'local_only')}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
