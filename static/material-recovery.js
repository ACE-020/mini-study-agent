"use strict";
const materialUploadsByJob=new Map();
function retainedMaterialFiles(){return materialState.retainedFiles||[];}
function materialHasFiles(){return Boolean($("#material-file").files.length||retainedMaterialFiles().length);}
function materialFileChoices(){return $("#material-file").files.length?[...$("#material-file").files]:retainedMaterialFiles();}
function rememberMaterialUpload(job,files=[]){
 materialUploadsByJob.set(job.id,{files,source:job.source,sourceFiles:job.source_files||[]});
 materialState.lastUpload=materialUploadsByJob.get(job.id);
 materialState.currentJob=job;materialState.retainedFiles=job.source_files||[];
}
function uploadForMaterialJob(job){
 return materialUploadsByJob.get(job?.id)||(job?.source_files?.length?{files:[],source:job.source,sourceFiles:job.source_files}:null);
}
function restoreMaterialUpload(saved){
 const transfer=new DataTransfer();(saved?.files||[]).forEach(file=>transfer.items.add(file));
 $("#material-file").files=transfer.files;materialState.retainedFiles=saved?.sourceFiles||[];
 materialState.lastUpload=saved||null;renderMaterialFiles();updateMaterialButtons();
}
function restoreMaterialJobFiles(job){restoreMaterialUpload(uploadForMaterialJob(job));}
function renderMaterialFailures(job){
 const failures=job?.result?.failures||[];
 for(const [id,preview] of [["material-source-retry",false],["material-preview-retry",true]]){
  const box=$("#"+id);box.replaceChildren();box.hidden=preview?!failures.length:!["failed","cancelled"].includes(job?.status);
  if(box.hidden)continue;
  if(preview)box.append(make("p","",job.error||"部分页面未完成，已完成题目和原页保留。"));
  if(failures.length){
   const detail=make("details"),summary=make("summary","","查看未完成页与原因");detail.append(summary);
   for(const failure of failures){const row=make("p","");row.append(make("strong","",failure.location+"："),document.createTextNode(failure.message));detail.append(row);}
   box.append(detail);
  }
  const button=make("button","button secondary small","重试未完成部分");button.type="button";button.dataset.materialRetry=job.id;
  button.disabled=state.busy||materialState.submitting;
  button.addEventListener("click",()=>retryMaterialJob(job.id));box.append(button,make("p","helper","使用任务保留的原页；已成功部分会复用，不重复识别。不需要重新选文件。"));
 }
}
async function retryMaterialJob(id){
 if(state.busy||materialState.submitting)return;
 if(materialState.edited&&!confirm("重试将重新汇总预览。请先将需要保留的手动修改入库，是否继续？"))return;
 materialState.submitting=true;updateMaterialButtons();
 try{
  const result=await api("/api/materials/jobs/"+encodeURIComponent(id)+"/retry",{method:"POST"});
  materialState.activeJob=id;materialState.currentJob=result.job;materialState.edited=false;
  setMaterialStage("processing");showMaterialTasks(false);await pollMaterialJobs();
 }catch(error){materialSubmitFeedback("error",error.message);}
 finally{materialState.submitting=false;updateMaterialButtons();}
}
function renderRecoveredMaterialFiles(list){
 const files=retainedMaterialFiles();$("#material-file").hidden=Boolean(files.length);
 if(files.length){
  list.append(make("p","helper","原文件已随本任务保留，无需重新选择；本机服务内闲置2小时后过期。"));
  for(const file of files){
   const row=make("div","queued-file");row.append(make("span","",file.name),make("small","",(file.size/1024/1024).toFixed(1)+" MB · 已保留"));
   if(file.pages){const preview=make("button","text-button","预览全文");preview.type="button";preview.onclick=()=>openRetainedFilePreview(file,false);row.append(preview);}
   list.append(row);
  }
  const replace=make("button","text-button","更换文件");replace.type="button";replace.onclick=()=>$("#material-file").click();list.append(replace);
 }
}
function refreshMaterialRangePreview(){
 const choices=materialFileChoices().filter(f=>/\.pdf$/i.test(f.name)),select=$("#material-range-file");
 const previous=select.value;select.replaceChildren();
 choices.forEach((file,i)=>{const option=make("option","",file.name);option.value=i;select.append(option);});
 if([...select.options].some(o=>o.value===previous))select.value=previous;
 select.hidden=choices.length<=1;$("#preview-material-range").disabled=!choices.length||state.busy||materialState.submitting;
}
async function openRetainedFilePreview(file,selectedOnly=false){
 const doc={...file,page_url:"/api/materials/files/"+encodeURIComponent(file.id)+"/pages/"};
 prepareFilePreviewDialog(file.name,"#material-page-range");
 filePreview.document=doc;filePreview.selectedPages=selectedOnly?selectedPreviewPages($("#material-page-range").value,doc.pages):null;
 $("#preview-page-number").max=doc.pages;$("#use-preview-pages").disabled=false;
 previewPage(filePreview.selectedPages?.[0]||1);
}
window.addEventListener("DOMContentLoaded",()=>{
 $("#material-file").addEventListener("change",()=>{materialState.retainedFiles=[];renderMaterialFiles();updateMaterialButtons();});
 $("#preview-material-range").addEventListener("click",async()=>{
  const choices=materialFileChoices().filter(f=>/\.pdf$/i.test(f.name)),file=choices[Number($("#material-range-file").value)||0];if(!file)return;
  try{if(file instanceof File)await openFilePreview(file,"#material-page-range",true);else await openRetainedFilePreview(file,true);}
  catch(error){previewFeedback(error.message,true);}
 });
});
