#!/usr/bin/env python3
"""Render math Markdown with boxed annotations, verify fonts, and batch-preview pages."""
import argparse
from contextlib import nullcontext
from collections import Counter
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

SKILL = Path(__file__).resolve().parent.parent


def run(args, **kwargs):
    p = subprocess.run(args, text=True, stdout=subprocess.PIPE,
                       stderr=subprocess.STDOUT, **kwargs)
    if p.returncode:
        raise RuntimeError(f'{args[0]} failed:\n{p.stdout[-6000:]}')
    return p.stdout


def check_dependencies(env, preview=False):
    names = ['pandoc', 'xelatex', 'kpsewhich', 'pdftotext', 'pdffonts']
    if preview:
        names += ['pdftoppm']
        try:
            import PIL  # noqa: F401
        except ImportError:
            raise RuntimeError('Previews require Pillow; see references/rendering.md')
    missing = [name for name in names if not shutil.which(name)]
    if not missing:
        for package in ['xeCJK', 'needspace', 'titlesec', 'tcolorbox']:
            p = subprocess.run(['kpsewhich', package + '.sty'], env=env,
                               text=True, capture_output=True)
            if p.returncode or not p.stdout.strip():
                missing.append(package + '.sty')
    if missing:
        raise RuntimeError('Missing dependencies: ' + ', '.join(missing)
                           + '. See references/rendering.md')


def check_annotation_boundaries(content):
    """Prevent a missing blank line from swallowing board text into an annotation."""
    active, just_ended = False, False
    for number, line in enumerate(content.splitlines(), 1):
        if re.match(r'^\s*>\s*\*\*注解', line):
            active, just_ended = True, False
        elif active and not line.strip():
            active, just_ended = False, True
        elif active and not re.match(r'^\s*>', line):
            raise RuntimeError(f'Line {number}: add an unquoted blank line after '
                               'the annotation before resuming board text')
        elif just_ended and line.strip():
            if re.match(r'^\s*>', line):
                print(f'Warning: line {number} starts an unlabeled quote after an '
                      'annotation; verify internal blank lines carry > to keep '
                      'one annotation together.')
            just_ended = False


def choose_font(args, work):
    if args.font_file:
        shutil.copy2(args.font_file.resolve(), work / 'CJK-Regular.otf')
        options = 'Path=./,'
        if args.bold_font_file:
            shutil.copy2(args.bold_font_file.resolve(), work / 'CJK-Bold.otf')
            options += 'BoldFont=CJK-Bold.otf,'
        else:
            options += 'AutoFakeBold=2,'
        return rf'\setCJKmainfont[{options}AutoFakeSlant=0.15]{{CJK-Regular.otf}}'
    family = args.font_family
    if family is None:
        if not shutil.which('fc-list'):
            raise RuntimeError('Provide --font-file or --font-family')
        installed = run(['fc-list', ':lang=zh', 'family'])
        family = next((f for f in ['Noto Sans CJK SC', 'Noto Serif CJK SC',
            'Source Han Sans SC', 'PingFang SC', 'Hiragino Sans GB'] if f in installed), None)
    if not family or re.search(r'[{}\\\n]', family):
        raise RuntimeError('No supported CJK font found; provide --font-file')
    return rf'\setCJKmainfont{{{family}}}'


def normalize_math_spacing(tex):
    # Remove Pandoc's empty display paragraphs, excluding literal code environments.
    parts = re.split(r'(\\begin\{(?:verbatim|Verbatim|Highlighting)\}.*?'
                     r'\\end\{(?:verbatim|Verbatim|Highlighting)\})', tex, flags=re.S)
    for i in range(0, len(parts), 2):
        parts[i] = parts[i].replace('\n\n\\[', '\n\\[').replace('\\]\n\n', '\\]\n')
    return ''.join(parts)


def verify_pdf(pdf, log, content):
    if 'Missing character:' in log:
        missing = [x for x in log.splitlines() if 'Missing character:' in x]
        raise RuntimeError('Missing glyphs:\n' + '\n'.join(missing[:20]))
    overflow = re.findall(r'Overfull \\[hv]box \(([\d.]+)pt too (?:wide|high)\)', log)
    if any(float(x) > 2 for x in overflow):
        raise RuntimeError('Layout overflow; split wide formulas or oversized units: '
                           + ', '.join(overflow))
    extracted = run(['pdftotext', '-layout', str(pdf), '-'])
    expected = Counter(re.findall(r'[\u3400-\u4dbf\u4e00-\u9fff]', content))
    actual = Counter(re.findall(r'[\u3400-\u4dbf\u4e00-\u9fff]', extracted))
    missing = expected - actual
    if missing:
        raise RuntimeError('Chinese text missing or truncated in PDF: '
                           + ', '.join(f'{char} x{n}' for char, n in sorted(missing.items())))
    fonts = run(['pdffonts', str(pdf)])
    rows = fonts.splitlines()[2:]
    if not rows or any(re.search(r'\sno\s+(?:yes|no)\s+(?:yes|no)\s+\d+\s+\d+\s*$', x)
                       for x in rows):
        raise RuntimeError('PDF contains unembedded fonts or has no fonts:\n' + fonts)
    return len(expected)


def preview_pages(pdf, directory, dpi):
    from PIL import Image, ImageDraw
    directory.mkdir(parents=True, exist_ok=True)
    # Remove only our previous preview names; never include stale pages after reflow.
    for pattern in ['page-*.png', 'contact-*.png']:
        for path in directory.glob(pattern):
            path.unlink()
    run(['pdftoppm', '-r', str(dpi), '-png', str(pdf), str(directory / 'page')])
    pages = sorted(directory.glob('page-*.png'),
                   key=lambda p: int(p.stem.rsplit('-', 1)[1]))
    for start in range(0, len(pages), 4):
        canvas = Image.new('RGB', (1000, 1460), '#d4d7db')
        draw = ImageDraw.Draw(canvas)
        for j, path in enumerate(pages[start:start + 4]):
            with Image.open(path) as original:
                thumb = original.convert('RGB')
                thumb.thumbnail((480, 685))
            x, y = 10 + j % 2 * 500, 30 + j // 2 * 730
            canvas.paste(thumb, (x, y))
            draw.text((x, y - 20), path.stem, fill='black')
        canvas.save(directory / f'contact-{start // 4 + 1:02d}.png')
    return len(pages)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('markdown', nargs='?', type=Path)
    ap.add_argument('--output', type=Path)
    ap.add_argument('--font-family', help='Installed CJK family; otherwise auto-detect')
    ap.add_argument('--font-file', type=Path, help='Explicit embeddable CJK OTF/TTF')
    ap.add_argument('--bold-font-file', type=Path)
    ap.add_argument('--tex-inputs', type=Path, help='Local TeX tree, searched recursively')
    ap.add_argument('--build-dir', type=Path, help='Keep TeX/log/aux files for diagnosis and reuse')
    ap.add_argument('--preview-dir', type=Path, help='Render all pages plus contact sheets')
    ap.add_argument('--preview-dpi', type=int, default=110)
    ap.add_argument('--check-deps', action='store_true', help='Check dependencies and exit')
    args = ap.parse_args()
    started = time.monotonic()
    env = os.environ.copy()
    if args.tex_inputs:
        env['TEXINPUTS'] = str(args.tex_inputs.resolve()) + '//:' + env.get('TEXINPUTS', '')
    check_dependencies(env, preview=bool(args.preview_dir))
    if args.check_deps:
        print('Rendering dependencies ready.')
        return
    if args.markdown is None or args.output is None:
        ap.error('markdown and --output are required unless --check-deps is used')
    src, dest = args.markdown.resolve(), args.output.resolve()
    if not src.is_file() or dest.suffix.lower() != '.pdf' or src == dest:
        raise RuntimeError('Provide an existing Markdown source and a separate .pdf output path')
    if args.preview_dpi < 72 or args.preview_dpi > 300:
        raise RuntimeError('--preview-dpi must be between 72 and 300')
    content = src.read_text(encoding='utf-8')
    check_annotation_boundaries(content)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if args.build_dir:
        build = args.build_dir.resolve()
        build.mkdir(parents=True, exist_ok=True)
        context = nullcontext(str(build))
    else:
        context = tempfile.TemporaryDirectory(prefix='math-notes-')
    with context as td:
        work = Path(td)
        header = work / 'header.tex'
        header.write_text('\\usepackage{xeCJK}\n' + choose_font(args, work) + '\n'
                          + (SKILL / 'assets/note-layout.tex').read_text(), encoding='utf-8')
        tex = work / 'notes.tex'
        run(['pandoc', str(src), '--from=markdown+tex_math_dollars', '--to=latex',
             '--standalone', '--lua-filter=' + str(SKILL / 'scripts/notes_filter.lua'),
             '--top-level-division=section', '--variable=fontsize:11pt',
             '--variable=papersize:a4', '--variable=linestretch:1.15',
             '--variable=geometry:left=20mm,right=20mm,top=18mm,bottom=18mm',
             '--metadata=title:', '--include-in-header=' + str(header),
             '--output=' + str(tex)], env=env)
        tex.write_text(normalize_math_spacing(tex.read_text()), encoding='utf-8')
        passes = 0
        for _ in range(2):
            run(['xelatex', '-no-shell-escape', '-interaction=nonstopmode',
                 '-halt-on-error', 'notes.tex'], cwd=work, env=env)
            passes += 1
            log = (work / 'notes.log').read_text(errors='replace')
            if not re.search(r'Rerun to get|Label\(s\) may have changed|rerunfilecheck Warning', log):
                break
        count = verify_pdf(work / 'notes.pdf', log, content)
        shutil.copyfile(work / 'notes.pdf', dest)
        print(f'Created {dest}; {count} distinct CJK characters verified; fonts embedded; '
              f'{passes} TeX pass(es).')
    if args.preview_dir:
        count = preview_pages(dest, args.preview_dir.resolve(), args.preview_dpi)
        print(f'Previewed all {count} pages in {args.preview_dir.resolve()}; '
              'inspect every page before delivery.')
    else:
        print('Render every page with --preview-dir and visually inspect before delivery.')
    print(f'Elapsed: {time.monotonic() - started:.1f}s')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError) as exc:
        raise SystemExit(str(exc))
