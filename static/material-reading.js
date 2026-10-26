"use strict";
let materialReadTimer=null;
function materialReadFeedback(kind,message,elapsed=null){
 const box=$("#material-read-status"),working=kind==="working";
 box.hidden=false;box.classList.toggle("is-reading",working);box.classList.toggle("is-error",kind==="error");
 if($("#material-read-title").textContent!==message)$("#material-read-title").textContent=message;
 $("#material-read-clock").textContent=elapsed===null?"":(working?"已等待 ":"用时 ")+elapsed+" 秒";
 $("#material-read-spinner").hidden=!working;
 $("#material-read-track").hidden=!working;
 $("#stop-material-read").hidden=!working;
 const editor=$("#material-text");
 editor.setAttribute("aria-busy",String(working));
 $("#material-text-container").classList.toggle("is-reading",working);
 $("#material-text-loading").hidden=!working||Boolean(editor.value.trim());
}
function resetMaterialReadFeedback(){
 if(state.operation?.type==="materials-read")return;
 $("#material-read-status").hidden=true;
 $("#material-text-loading").hidden=true;
 $("#material-text").setAttribute("aria-busy","false");
 $("#material-text-container").classList.remove("is-reading");
}
async function readMaterialText(){
 if(state.busy)return;
 const files=[...$("#material-file").files];
 try{
  if(!files.length&&!retainedMaterialFiles().length)throw new Error("请先选择要转成文字的文件。");
  if(files.length>20)throw new Error("每批最多选择 20 个文件。");
  for(const file of files){const limit=/\.pdf$/i.test(file.name)?256:8;if(file.size>limit*1024*1024)throw new Error(file.name+" 不能超过 "+limit+" MB。");}
  if(files.reduce((sum,file)=>sum+file.size,0)>512*1024*1024)throw new Error("每批文件合计不能超过 512 MB。");
 }catch(error){materialReadFeedback("error",error.message);return;}
 if($("#material-text").value.trim()&&!confirm("文字框已有内容，要用本次读取的文字替换吗？"))return;
 const operation={id:crypto.randomUUID(),type:"materials-read",view:"materials",stopping:false},started=Date.now();
 const elapsed=()=>Math.floor((Date.now()-started)/1000);
 const renderProgress=()=>materialReadFeedback("working",operation.stopping?"正在停止转文字，请稍候…":(operation.backendMessage||"正在转成文字，完成后会填入文字框"),elapsed());
 state.operation=operation;setBusy(true);materialFeedback("");renderProgress();
 materialReadTimer=setInterval(renderProgress,1000);
 try{
  const form=new FormData();files.forEach(file=>form.append("files",file));if(!files.length)form.append("source_file_ids",JSON.stringify(retainedMaterialFiles().map(f=>f.id)));
  form.append("page_range",$("#material-page-range").value);form.append("request_id",operation.id);
  const result=await api("/api/materials/read",{method:"POST",body:form});
  if(operation.stopping){const error=new Error("已停止转文字，原有文字保留。");error.cancelled=true;throw error;}
  if(typeof result.text!=="string"||!result.text.trim())throw new Error("没有提取到可用文字，原有内容已保留。可检查原页，或直接从原文件整理题目。");
  if(result.text.length>80000)throw new Error("提取结果超过 80000 字，原有内容已保留，请缩小页码范围。");
  $("#material-text").value=result.text;$("#material-text").scrollTop=0;
  materialState.activeJob=null;renderExercisePreview([]);
  const message="已读取 "+(result.pages?.length||1)+" 页 / 份，"+result.text.length+" 字，已填入文字框。";
  materialReadFeedback("success",message+" 核对后再整理，尚未入库。",elapsed());updateMaterialDraft();
 }catch(error){
  const message=error.cancelled?"已停止转文字，原有文字保留，可修改后重试。":error.message;
  materialReadFeedback(error.cancelled?"info":"error",message,elapsed());
 }finally{
  clearInterval(materialReadTimer);materialReadTimer=null;
  state.operation=null;setBusy(false);
 }
}
window.addEventListener("DOMContentLoaded",()=>{
 const wrapper=$("#material-read-help"),button=$("#material-read-help-button"),tip=$("#material-read-help-text");
 let pinned=false;
 const show=value=>{tip.hidden=!value;button.setAttribute("aria-expanded",String(value));};
 wrapper.addEventListener("pointerenter",()=>show(true));
 wrapper.addEventListener("pointerleave",()=>{if(!pinned)show(false);});
 wrapper.addEventListener("focusin",()=>show(true));
 wrapper.addEventListener("focusout",event=>{if(!pinned&&!wrapper.contains(event.relatedTarget))show(false);});
 button.addEventListener("click",()=>{pinned=!pinned;show(pinned);});
 document.addEventListener("pointerdown",event=>{if(!wrapper.contains(event.target)){pinned=false;show(false);}});
 button.addEventListener("keydown",event=>{if(event.key==="Escape"){pinned=false;show(false);event.preventDefault();event.stopPropagation();}});
 for(const id of ["material-file","material-page-range"])$("#"+id).addEventListener("input",resetMaterialReadFeedback);
});
