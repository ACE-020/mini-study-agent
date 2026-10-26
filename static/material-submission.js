"use strict";
let materialSubmitTimer=null;
function materialBatchPageLimit(){return Number($("#parse-material").dataset.maxPages);}
function materialSubmitFeedback(kind,message,elapsed=null){
 const box=$("#material-submit-status"),working=kind==="working";
 box.hidden=!message;box.classList.toggle("is-error",kind==="error");
 $("#material-submit-title").textContent=message;
 $("#material-submit-clock").textContent=elapsed===null?"":(working?"已等待 ":"用时 ")+elapsed+" 秒";
 $("#material-submit-spinner").hidden=!working;
 $("#material-submit-track").hidden=!working;
 $("#parse-material").setAttribute("aria-busy",String(working));
}
function resetMaterialSubmitFeedback(){if(!materialState.submitting)materialSubmitFeedback("info","");}
function validateMaterialSelection(files){
 const limit=materialBatchPageLimit();
 if(files.length>20)throw new Error("每批最多选择 20 个文件。");
 for(const file of files){const sizeLimit=/\.pdf$/i.test(file.name)?256:8;if(file.size>sizeLimit*1024*1024)throw new Error(file.name+" 不能超过 "+sizeLimit+" MB。");}
 if(files.reduce((n,f)=>n+f.size,0)>512*1024*1024)throw new Error("每批文件合计不能超过 512 MB。");
 const pdfs=files.filter(file=>/\.pdf$/i.test(file.name)),range=$("#material-page-range").value.trim();
 if(!pdfs.length)return;
 let pages=new Set();
 if(range){
  for(const part of range.replace(/，/g,",").split(",")){
   const match=part.match(/^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/);
   if(!match)throw new Error("页码请填写如 1-20 或 1,3,5-8。");
   const start=Number(match[1]),end=Number(match[2]||match[1]);
   if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<1||end<start)throw new Error("请检查页码范围。");
   if(end-start+1>limit)throw new Error("每批最多整理 "+limit+" 页，请缩小页码范围后重新提交。");
   for(let n=start;n<=end;n++)pages.add(n);
   if(pages.size>limit)throw new Error("每批最多整理 "+limit+" 页，请缩小页码范围后重新提交。");
  }
  const photos=files.filter(f=>!/\.(pdf|txt|md)$/i.test(f.name)).length;
  if(pages.size*pdfs.length+photos>limit)throw new Error("所有文件合计每批最多整理 "+limit+" 张图片 / PDF 页，请缩小范围。");
 }
}
async function submitMaterialJob(){
 if(state.busy||materialState.submitting||materialState.saving)return;
 materialFeedback("");
 const files=[...$("#material-file").files];
 try{validateMaterialSelection(materialFileChoices());}catch(error){materialSubmitFeedback("error",error.message);return;}
 materialState.submitting=true;updateMaterialButtons();
 const started=Date.now(),elapsed=()=>Math.floor((Date.now()-started)/1000);
 const progress=()=>materialSubmitFeedback("working",materialHasFiles()?"正在上传并准备原页，随后转入后台整理…":"正在提交文字资料，随后转入后台整理…",elapsed());
 progress();materialSubmitTimer=setInterval(progress,1000);
 try{
  materialState.lastUpload={files,source:$("#material-source").value};
  let options;
  if(files.length){
   const form=new FormData();files.forEach(file=>form.append("files",file));
   for(const [name,id] of [["page_range","material-page-range"],["source","material-source"],["text","material-text"]])form.append(name,$("#"+id).value);
   options={method:"POST",body:form};
  }else options={method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text:$("#material-text").value,source:$("#material-source").value,source_file_ids:retainedMaterialFiles().map(f=>f.id),page_range:$("#material-page-range").value,metadata:{mode:"text",page_range:$("#material-page-range").value,files:[]}})};
  const result=await api("/api/materials/jobs",options);
  rememberMaterialUpload(result.job,files);renderMaterialFailures(null);flyToMaterialTasks();materialState.activeJob=result.job.id;materialState.edited=false;
  closeBatchCorrection();renderExercisePreview([]);resetBatchAI();setMaterialStage("processing");
  materialSubmitFeedback("info","");await pollMaterialJobs();
 }catch(error){
  materialSubmitFeedback("error",error.message+" 当前页码和补充文字已保留，可按提示重试。",elapsed());
 }finally{clearInterval(materialSubmitTimer);materialSubmitTimer=null;materialState.submitting=false;updateMaterialButtons();}
}
window.addEventListener("DOMContentLoaded",()=>{
 for(const id of ["material-file","material-page-range","material-text","material-source"])$("#"+id).addEventListener("input",resetMaterialSubmitFeedback);
});
