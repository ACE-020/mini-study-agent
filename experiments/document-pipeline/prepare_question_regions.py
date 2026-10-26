"""Locate labels from native PDF; render original question images without flattening math."""
import json
import argparse
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT))
import pymupdf
from material_locations import pdf_layouts


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--padding',type=int,default=0)
    args=parser.parse_args()
    if not 0<=args.padding<=12:
        raise ValueError('Test padding must stay within 0..12 PDF points')
    name_suffix=f'-pad{args.padding}' if args.padding else ''
    region_folder='question-regions16'+name_suffix
    folder=ROOT/'experiments/document-pipeline/work/samples'
    (folder/region_folder).mkdir(exist_ok=True)
    records=[]
    with pymupdf.open('D:/yjm/UMath/Higher_Mathematics/大邮数学集-1.4.3.pdf') as pdf:
        layout=pdf_layouts(pdf,[15])[15]
        page=pdf[15]
        for index,anchor in enumerate(layout['anchors'],1):
            if anchor['role']!='question':
                continue
            x0,y0,x1,y1=anchor['bbox']
            rect=pymupdf.Rect(x0*page.rect.width,y0*page.rect.height,x1*page.rect.width,y1*page.rect.height)
            if args.padding:
                rect=pymupdf.Rect(rect.x0-args.padding,rect.y0-args.padding,rect.x1+args.padding,rect.y1+args.padding)&page.rect
            rendered_bbox=[rect.x0/page.rect.width,rect.y0/page.rect.height,rect.x1/page.rect.width,rect.y1/page.rect.height]
            name=f'{region_folder}/q{index:02d}.png'
            page.get_pixmap(matrix=pymupdf.Matrix(2,2),clip=rect,alpha=False).save(folder/name)
            records.append({'id':f'p16-question-{index:02d}','image':name,'physical_page':16,'reference':None,
                            'paper':anchor['paper'],'number':anchor['number'],'bbox':rendered_bbox,
                            'anchor_bbox':anchor['bbox'],'padding_pt':args.padding,'task':'text'})
    (folder/(region_folder+'.json')).write_text(json.dumps(records,ensure_ascii=False,indent=2),encoding='utf8')
    print('Prepared native-PDF question regions:',len(records))


if __name__=='__main__':
    main()
