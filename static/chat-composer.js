"use strict";
const answerAttachments=[];
function composerFeedback(view,text,error=false){const node=document.querySelector(`[data-composer-status="${view}"]`);if(!node)return;node.textContent=text;node.hidden=!text;node.classList.toggle("error",error);}
function syncChatModels(model){
 state.chatModel=model;
 for(const select of document.querySelectorAll("[data-chat-model]")){
  select.replaceChildren();
  for(const option of $("#settings-model").options){if(option.value!=="custom")select.append(new Option(option.textContent,option.value));}
  if(model&&![...select.options].some(option=>option.value===model))select.add(new Option(model,model));
  select.add(new Option("更多模型 / API 设置…","__settings__"));select.value=model||select.options[0]?.value;
 }
 updateChatComposerButtons();
}
function updateChatComposerButtons(){
 for(const node of document.querySelectorAll("[data-chat-model]"))node.disabled=state.busy;
 const canDraft=!state.busy||state.operation?.type==="chat";
 for(const node of document.querySelectorAll("#review-attach,#review-image-input,.answer-attachment-remove"))node.disabled=!canDraft;
 for(const view of ["organize","review","analysis"]){const form=$(`#${view}-follow-form`);if(!form)continue;form.querySelector("[type=submit]").disabled=!canDraft||!state.configured;$(`#${view}-follow`).readOnly=!canDraft;}
 if(typeof updateChatQueueControls==="function")updateChatQueueControls();
}
async function changeChatModel(select){
 const model=select.value,view=select.dataset.chatModel;
 if(model==="__settings__"){select.value=state.chatModel;openModelSettings();return;}
 if(state.busy){syncChatModels(state.chatModel);return;}
 setBusy(true);composerFeedback(view,"正在切换模型…");
 try{const result=await api("/api/settings/model",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model})});syncChatModels(result.settings.model);await refreshStatus();composerFeedback(view,"已切换，继续当前对话。");}
 catch(error){syncChatModels(state.chatModel);composerFeedback(view,error.message,true);}
 finally{setBusy(false);}
}
function releaseAttachment(item){if(!state.chats.review.some(message=>message.images?.some(image=>image.url===item.url)))URL.revokeObjectURL(item.url);}
function addAnswerImages(files){
 if(state.busy&&state.operation?.type!=="chat")return;
 let error="";
 for(const file of files){
  if(!/\.(png|jpe?g|webp)$/i.test(file.name)){error="支持 JPG、PNG 和 WebP 作答图片。";continue;}
  if(file.size>8*1024*1024){error="单张图片最多 8 MB，请裁剪到作答区域。";continue;}
  if(answerAttachments.length>=4){error="每次最多附上 4 张作答图片。";break;}
  if(answerAttachments.some(item=>item.file.name===file.name&&item.file.size===file.size&&item.file.lastModified===file.lastModified))continue;
  answerAttachments.push({file,url:URL.createObjectURL(file),id:null});
 }
 renderAnswerImages();composerFeedback("review",error||"图片已附上，发送后检查作答；不回填识别文字。",Boolean(error));
}
function renderAnswerImages(){
 const list=$("#review-attachments");if(!list)return;list.replaceChildren();list.hidden=!answerAttachments.length;
 for(const item of answerAttachments){
  const tile=make("div","answer-attachment"),preview=make("button","answer-attachment-preview"),image=make("img");preview.type="button";preview.title="预览 "+item.file.name;image.src=item.url;image.alt=item.file.name;preview.append(image);preview.addEventListener("click",()=>openFilePreview(item.file,"#review-follow"));
  const remove=make("button","answer-attachment-remove","×");remove.type="button";remove.setAttribute("aria-label","移除 "+item.file.name);remove.addEventListener("click",()=>{answerAttachments.splice(answerAttachments.indexOf(item),1);releaseAttachment(item);renderAnswerImages();});
  tile.append(preview,make("span","",item.file.name),remove);list.append(tile);
 }
 updateChatComposerButtons();
}
function renderChatImages(body,images){
 const list=make("div","chat-image-list");
 for(const item of images){const button=make("button","chat-image-preview"),image=make("img");button.type="button";button.title="查看作答原图";image.src=item.url;image.alt=item.name;button.append(image);button.addEventListener("click",()=>openFilePreview(item.file,"#review-follow"));list.append(button);}
 body.append(list);
}
async function prepareChatAttachments(items,operation){
 const missing=items.filter(item=>!item.id);
 if(missing.length){
  composerFeedback(operation.view,"正在上传作答图片…");
  for(let offset=0;offset<missing.length;offset+=4){
   if(operation.stopping){const error=new Error("已停止，可编辑后继续。");error.cancelled=true;throw error;}
   const batch=missing.slice(offset,offset+4),form=new FormData();form.append("view",operation.view);form.append("request_id",operation.id);for(const item of batch)form.append("files",item.file);
   const result=await api("/api/chat/attachments",{method:"POST",body:form});batch.forEach((item,index)=>item.id=result.image_ids[index]);
  }
 }
 composerFeedback(operation.view,"正在识别图片并检查这一步…");return items.map(item=>item.id);
}
function completeChatAttachments(items){for(const item of items){const index=answerAttachments.indexOf(item);if(index>=0)answerAttachments.splice(index,1);}renderAnswerImages();composerFeedback("review","");}
function resetReviewAttachments(){
 for(const item of answerAttachments)URL.revokeObjectURL(item.url);answerAttachments.length=0;
 for(const message of state.chats.review)for(const item of message.images||[])URL.revokeObjectURL(item.url);
 renderAnswerImages();composerFeedback("review","");
}
function submitChatFollowup(view){submitQueuedDraft(view);}
window.addEventListener("DOMContentLoaded",()=>{
 for(const view of ["organize","review","analysis"]){
  const form=$(`#${view}-follow-form`),toolbar=make("div","composer-toolbar"),status=make("p","composer-status");form.classList.add("chat-composer");
  if(view==="review"){
   const attachments=make("div","answer-attachments");attachments.id="review-attachments";attachments.hidden=true;form.prepend(attachments);
   const upload=make("button","composer-attach","＋ 图片作答");upload.id="review-attach";upload.type="button";upload.title="上传手写步骤或公式，也可粘贴图片";
   const input=make("input","visually-hidden");input.type="file";input.accept="image/jpeg,image/png,image/webp";input.multiple=true;input.id="review-image-input";input.setAttribute("aria-label","选择作答图片");
   upload.addEventListener("click",()=>input.click());input.addEventListener("change",()=>{addAnswerImages(input.files);input.value="";});toolbar.append(upload,input);
   $("#review-follow").addEventListener("paste",event=>{const images=[...event.clipboardData.files].filter(file=>file.type.startsWith("image/"));if(images.length){event.preventDefault();addAnswerImages(images);}});
   $("#review-follow").placeholder="输入步骤，或附上作答图片…（Ctrl+Enter 发送）";
  }
  const label=make("label","composer-model-label","对话模型"),select=make("select","composer-model");select.dataset.chatModel=view;select.setAttribute("aria-label",view==="review"?"复习对话模型":view==="organize"?"整理对话模型":"分析对话模型");select.addEventListener("change",()=>changeChatModel(select));label.append(select);toolbar.append(label);form.append(toolbar);
  status.dataset.composerStatus=view;status.hidden=true;status.setAttribute("role","status");form.append(status);
 }
 syncChatModels(state.chatModel);renderAnswerImages();
});
