"""Prepare local, reproducible PDF/Markdown samples without changing user sources."""
import argparse,hashlib,json
from pathlib import Path
import pymupdf

parser=argparse.ArgumentParser()
parser.add_argument('--project',type=Path,required=True)
parser.add_argument('--source',type=Path,default=Path('D:/yjm/UMath/Higher_Mathematics/大邮数学集-1.4.3.pdf'))
args=parser.parse_args()
root=args.project/'experiments/document-pipeline/work'
for name in ('samples','results','exports','previews','logs'):(root/name).mkdir(parents=True,exist_ok=True)
with pymupdf.open(args.source) as original:
 selected=pymupdf.open()
 selected.insert_pdf(original,from_page=15,to_page=19)
 selected.save(root/'samples/digital-16-20.pdf');selected.close()
 one=pymupdf.open();one.insert_pdf(original,from_page=15,to_page=15);one.save(root/'samples/digital-16.pdf');one.close()
 image=original[15].get_pixmap(matrix=pymupdf.Matrix(2,2),alpha=False)
 image.save(root/'samples/original-page16.png')
 original[17].get_pixmap(matrix=pymupdf.Matrix(2,2),alpha=False).save(root/'samples/original-page18.png')
 scan=pymupdf.open();page=scan.new_page(width=original[15].rect.width,height=original[15].rect.height)
 page.insert_image(page.rect,stream=image.tobytes('jpeg',jpg_quality=92));scan.save(root/'samples/scanned-16.pdf');scan.close()
 baseline='\n\n'.join('## 文件第 '+str(n+1)+' 页\n\n'+original[n].get_text('text',sort=True) for n in range(15,20))
 (root/'results/baseline-text.md').write_text(baseline,encoding='utf8')
 manifest={'source':str(args.source),'source_sha256':hashlib.sha256(args.source.read_bytes()).hexdigest(),'source_pages':len(original),'sample_original_pages':[16,17,18,19,20],'expected_papers':2,'expected_questions':32,'scanned_original_page':16}
(root/'samples/manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf8')
fixture=r'''# 数学笔记导出验收

这是一份中文数学笔记。检查中文、行内公式、独立公式、表格、插图和跨页分页，不调用任何大模型。

## 分段函数与嵌套根号

行内公式：$f'(x)=2x$，定义域为 $x\in\mathbb{R}$。

$$
f(x)=\begin{cases}
x^{a/(x-1)}, & x>1,\\
\dfrac{\sqrt{x\sqrt{x}}-1}{x-1}, & 0<x<1.
\end{cases}
$$

> **注解：核对原式**
>
> 保留根号的嵌套范围，保留分母与参数条件。
>
> $$\lim_{n\to\infty}\left(\sqrt{n+\sqrt n}-\sqrt{n-\sqrt n}\right)=1.$$

## 矩阵与多行推导

$$
A=\begin{pmatrix}
1&2&3\\
0&1&4\\
5&6&0
\end{pmatrix},\qquad \det A=1.
$$

$$
\begin{aligned}
\int x^2\,\mathrm{d}x &= \frac{x^3}{3}+C,\\
\frac{\mathrm{d}}{\mathrm{d}x}\sin x &= \cos x.
\end{aligned}
$$

| 项目 | 检查内容 |
| --- | --- |
| 中文 | 标题与正文可搜索 |
| 数学 | 上下标与矩阵完整 |
| 版面 | 内容未被截断 |

## 本地插图

![直角三角形示意图](../samples/triangle.svg)

'''
for n in range(1,8):fixture+='\n## 连续笔记 '+str(n)+'\n\n'+('保持正文、注解与公式的层级关系，跨页后标题不应单独落在页末。数学公式与中文正文均需清晰。'*4)+'\n\n$$S_n=\\sum_{k=1}^{n}k=\\frac{n(n+1)}{2}.$$\n'
(root/'samples/export-math.md').write_text(fixture,encoding='utf8')
(root/'samples/triangle.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="150" viewBox="0 0 400 150"><rect width="400" height="150" fill="white"/><path d="M70 120 L300 120 L70 25 Z" fill="#eee8fc" stroke="#6755cf" stroke-width="3"/><path d="M70 105 H85 V120" fill="none" stroke="#6755cf"/><text x="45" y="138" font-size="16">A</text><text x="305" y="138" font-size="16">B</text><text x="45" y="25" font-size="16">C</text></svg>',encoding='utf8')
print(json.dumps(manifest,ensure_ascii=False,indent=2))
print('Prepared samples at',root)
