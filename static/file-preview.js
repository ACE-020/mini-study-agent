"use strict";
const filePreview={cache:new WeakMap(),generation:0,controller:null,url:null,document:null,page:1,target:null};
function previewFeedback(text,error=false){const node=$("#file-preview-status");node.textContent=text;node.classList.toggle("error",error);}
function closeFilePreview(){filePreview.generation++;filePreview.controller?.abort();if(filePreview.url){URL.revokeObjectURL(filePreview.url);filePreview.url=null;}const image=$("#file-preview-image");image.onload=null;image.onerror=null;image.removeAttribute("src");}
function selectedPreviewPages(value,total){
 const pages=new Set();
 if(!value.trim()){if(total>20)throw new Error("请先填写要预览的页码范围，最多20页；文件旁的预览可浏览全文。");return Array.from({length:total},(_,i)=>i+1);}
 for(const part of value.replace(/，/g,",").split(",")){
  const match=part.match(/^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/);
  if(!match)throw new Error("页码请填写如21-25或21,23,25。");
  const a=Number(match[1]),b=Number(match[2]||match[1]);
  if(a<1||b<a||b>total||b-a>=20)throw new Error("请填写文件中有效的范围，每次最多20页。");
  for(let p=a;p<=b;p++)pages.add(p);if(pages.size>20)throw new Error("每次最多预览所选20页，全文预览保留在文件旁。");
 }
 return [...pages].sort((a,b)=>a-b);
}
function prepareFilePreviewDialog(name,target,pdf=true){
 closeFilePreview();filePreview.document=null;filePreview.selectedPages=null;filePreview.file=null;filePreview.target=target;
 $("#file-preview-title").textContent=name;$("#file-preview-image").hidden=true;$("#file-preview-text").hidden=true;
 $("#preview-range").value=$(target).value;$("#pdf-preview-controls").hidden=!pdf;$("#preview-range-controls").hidden=!pdf;
 $("#use-preview-pages").hidden=!pdf;$("#use-preview-pages").disabled=true;
 previewFeedback("正在准备本地预览，不调用AI…");if(!$("#file-preview-dialog").open)$("#file-preview-dialog").showModal();
}
function stepPreviewPage(step){const pages=filePreview.selectedPages;previewPage(pages?pages[pages.indexOf(filePreview.page)+step]:filePreview.page+step);}
function previewPage(number){
 const doc=filePreview.document;if(!doc||number===undefined)return;
 const selected=filePreview.selectedPages;
 number=Number(number)||1;
 if(selected&&!selected.includes(number)){previewFeedback("本次仅预览所选页："+selected.join("、")+"。",true);return;}
 filePreview.page=Math.max(1,Math.min(doc.pages,number));
 $("#preview-page-number").value=filePreview.page;$("#preview-page-number").min=selected?.[0]||1;
 $("#preview-page-total").textContent="/ "+doc.pages+" 页"+(selected?" · 本次 "+(selected.indexOf(filePreview.page)+1)+"/"+selected.length+" 页":"");
 $("#preview-previous").disabled=selected?selected.indexOf(filePreview.page)===0:filePreview.page===1;
 $("#preview-next").disabled=selected?selected.indexOf(filePreview.page)===selected.length-1:filePreview.page===doc.pages;
 previewFeedback("正在显示页面…");const image=$("#file-preview-image");image.hidden=true;
 image.onload=()=>{image.hidden=false;previewFeedback("PDF实际第 "+filePreview.page+" 页"+(selected?"，仅浏览本次所选范围。":"；页码按文件顺序计数，可能与书内印刷页码不同。"));};
 image.onerror=()=>{previewFeedback("原页未能显示，临时文件可能已过期或服务已重启。已保留的任务原页仍可用于重试。",true);};
 image.src=(doc.page_url||"/api/files/preview/"+encodeURIComponent(doc.id)+"/")+filePreview.page;
}
async function openFilePreview(file,target,selectedOnly=false){
 const pdf=/\.pdf$/i.test(file.name);prepareFilePreviewDialog(file.name,target,pdf);
 const generation=filePreview.generation;filePreview.file=file;
 try{
  if(pdf){let cached=filePreview.cache.get(file);if(!cached||Date.now()-cached.created>29*60*1000){const form=new FormData();form.append("file",file);filePreview.controller=new AbortController();const response=await fetch("/api/files/preview",{method:"POST",body:form,signal:filePreview.controller.signal});const result=await response.json();if(!response.ok||!result.ok)throw new Error(result.error||"预览未完成。");cached={...result.document,created:Date.now()};filePreview.cache.set(file,cached);}if(generation!==filePreview.generation)return;filePreview.document=cached;filePreview.selectedPages=selectedOnly?selectedPreviewPages($(target).value,cached.pages):null;$("#preview-page-number").max=cached.pages;$("#use-preview-pages").disabled=false;previewPage(filePreview.selectedPages?.[0]||1);
  }else if(/\.(txt|md)$/i.test(file.name)){const text=await file.text();if(generation!==filePreview.generation)return;$("#file-preview-text").textContent=text.slice(0,80000);$("#file-preview-text").hidden=false;previewFeedback(text.length>80000?"预览显示前 80000 字。":"本地原文预览，不调用 AI。");
  }else{filePreview.url=URL.createObjectURL(file);const image=$("#file-preview-image");image.onload=()=>{image.hidden=false;previewFeedback("原图预览，不调用 AI。");};image.onerror=()=>previewFeedback("无法显示这张图片。",true);image.src=filePreview.url;}
 }catch(error){if(error.name!=="AbortError"&&generation===filePreview.generation)previewFeedback(error.message||"无法打开预览。",true);}
}
function renderMaterialFiles(){const list=$("#material-files-preview");list.replaceChildren();$("#material-file").hidden=false;if(!$("#material-file").files.length)renderRecoveredMaterialFiles(list);refreshMaterialRangePreview();for(const file of $("#material-file").files){const row=make("div","queued-file");row.append(make("span","",file.name),make("small","",`${(file.size/1024/1024).toFixed(1)} MB`));const button=make("button","text-button","预览");button.type="button";button.disabled=state.busy;button.dataset.filePreview="";button.addEventListener("click",()=>openFilePreview(file,"#material-page-range"));row.append(button);list.append(row);}}
window.addEventListener("DOMContentLoaded",()=>{
 const dialog=$("#file-preview-dialog");$("#close-file-preview").addEventListener("click",()=>dialog.close());dialog.addEventListener("close",closeFilePreview);let outside=false;const isOutside=event=>{const r=dialog.getBoundingClientRect();return event.target===dialog&&(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom);};dialog.addEventListener("pointerdown",event=>outside=isOutside(event));dialog.addEventListener("click",event=>{if(outside&&isOutside(event))dialog.close();outside=false;});
 $("#preview-previous").addEventListener("click",()=>stepPreviewPage(-1));$("#preview-next").addEventListener("click",()=>stepPreviewPage(1));$("#preview-page-number").addEventListener("change",event=>previewPage(event.target.value));$("#preview-page-number").addEventListener("keydown",event=>{if(event.key==="Enter"){event.preventDefault();previewPage(event.target.value);}});$("#preview-from-here").addEventListener("click",()=>{$("#preview-range").value=String(filePreview.page);$("#preview-range").focus();});
 $("#use-preview-pages").addEventListener("click",()=>{const value=$("#preview-range").value.trim();const total=filePreview.document?.pages;let pages=[];for(const part of value.replace(/，/g,",").split(",")){const match=part.match(/^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/);if(!match){previewFeedback("填写要读取的文件页码，例如 5-12 或 5,8-10。",true);return;}const start=Number(match[1]),end=Number(match[2]||match[1]);if(start<1||end<start||end>total){previewFeedback(`文件共 ${total} 页，请检查范围。`,true);return;}if(end-start+1>20){previewFeedback("每批最多读取 20 页，预览可以浏览整本资料。",true);return;}for(let page=start;page<=end;page++)pages.push(page);}if(new Set(pages).size>20){previewFeedback("每批最多读取 20 页。",true);return;}$(filePreview.target).value=value;$(filePreview.target).dispatchEvent(new Event("input",{bubbles:true}));dialog.close();$(filePreview.target).focus();});
 $("#material-file").addEventListener("change",renderMaterialFiles);$("#import-more-materials").addEventListener("click",renderMaterialFiles);
});
