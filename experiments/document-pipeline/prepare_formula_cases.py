"""Manually specified hard formula crops from the user's unchanged original PDF."""
import json
from pathlib import Path

import pymupdf
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path('D:/yjm/UMath/Higher_Mathematics/大邮数学集-1.4.3.pdf')
CASES = [
    ('p16-simple-cases',16,[.178,.116,.322,.162],r'f(x)=\begin{cases}1,&|x|\le1\\0,&|x|>1\end{cases}'),
    ('p16-nested-root',16,[.152,.167,.435,.210],r'\lim_{n\to\infty}(\sqrt{n+\sqrt{n}}-\sqrt{n-\sqrt{n}})'),
    ('p18-exp-cases',18,[.171,.506,.479,.566],r'f(x)=\begin{cases}\frac{2+e^{1/x}}{1+e^{2/x}}+\frac2\pi\arctan\frac1x,&x\ne0\\0,&x=0\end{cases}'),
    ('p18-e-subscript',18,[.176,.627,.367,.671],r'\lim_{x\to0}\left(1+\frac{f(2x)}x\right)^{1/x}=e'),
    ('p37-interval-cases',37,[.223,.123,.426,.165],r'f(x)=\begin{cases}-x^2,&x\in[-2,0]\\x^3,&x\in(0,2]\end{cases}'),
    ('p37-power-limit',37,[.162,.221,.372,.261],r'\lim_{x\to0}\frac{(\cos x)^{\sin^2x}-1}{(\cos x-1)\ln(1+2x^2)}'),
    ('p37-critical-q6',37,[.188,.356,.438,.433],r'f(x)=\begin{cases}x^{a/(x-1)},&x>1\\\frac{\sqrt{x\sqrt{x}}-1}{x-1},&0<x<1\end{cases}'),
    ('p37-abs-fraction',37,[.207,.443,.353,.482],r'f(x)=\frac{\sin\pi x}{|x|(x^2-1)}'),
    ('p37-triple-root',37,[.282,.620,.450,.663],r'\sqrt{x+\sqrt[3]{x+\sqrt{\sin x}}}'),
    ('p37-root-fraction',37,[.220,.877,.362,.922],r'\sqrt[3]{\frac{x\sin x\sqrt{1+e^x}}{1+x^2}}'),
]


def main():
    samples = ROOT/'experiments/document-pipeline/work/samples'
    folder = samples/'formula-crops'
    folder.mkdir(exist_ok=True)
    records = []
    collage = Image.new('RGB',(1000,1000),'#edf0f5')
    draw = ImageDraw.Draw(collage)
    with pymupdf.open(SOURCE) as pdf:
        for i,(name,number,box,reference) in enumerate(CASES):
            page = pdf[number-1]
            rect = pymupdf.Rect(box[0]*page.rect.width,box[1]*page.rect.height,
                                box[2]*page.rect.width,box[3]*page.rect.height)
            path = folder/(name+'.png')
            page.get_pixmap(matrix=pymupdf.Matrix(3,3),clip=rect,alpha=False).save(path)
            records.append({'id':name,'physical_page':number,'bbox':box,
                            'image':path.relative_to(samples).as_posix(),'reference':reference})
            image = Image.open(path).convert('RGB')
            image.thumbnail((470,155))
            x=(i%2)*500+15;y=(i//2)*200+30
            draw.text((x,y-20),name,fill='#172239')
            collage.paste(image,(x,y))
    (samples/'formula-cases.json').write_text(json.dumps(records,ensure_ascii=False,indent=2),encoding='utf8')
    collage.save(samples/'formula-crops.png')
    print('Prepared',len(records),'local formula-only crops; references require visual check')


if __name__=='__main__':
    main()
