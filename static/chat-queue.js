"use strict";
const chatQueue={items:[],dispatching:false,paused:false,steering:null};
function hasQueuedChat(view){return chatQueue.items.some(item=>item.view===view)||chatQueue.steering?.entry.view===view;}
function canDraftChat(){return !state.busy||state.operation?.type==="chat";}
function draftChatEntry(view){
 const editor=$(`#${view}-follow`),text=editor.value.trim(),attachments=view==="review"?[...answerAttachments]:[];
 if(!text&&!attachments.length)return null;
 if(!state.configured){composerFeedback(view,"请先保存模型设置。",true);return null;}
 if(chatQueue.items.length>=10){composerFeedback(view,"待发送消息已满，请先处理队列。",true);return null;}
 if([...chatQueue.items.flatMap(item=>item.attachments),...attachments].reduce((sum,item)=>sum+item.file.size,0)>64*1024*1024){composerFeedback(view,"待发送图片超过 64 MB，请先发送或移除部分图片。",true);return null;}
 const entry={id:crypto.randomUUID(),view,text:text||"请检查图片中我对当前题的作答，并继续一步步引导。",editorText:text,
   displayText:text||"图片作答",attachments,options:view==="analysis"?{selection:selectionRefs()}: {},blocked:false,editing:false};
 editor.value="";
 if(view==="review"){answerAttachments.length=0;renderAnswerImages();}
 return entry;
}
function submitQueuedDraft(view){
 if(!canDraftChat())return;
 const entry=draftChatEntry(view);if(!entry)return;
 if(chatQueue.paused&&!state.busy){chatQueue.items.unshift(entry);chatQueue.paused=false;}else chatQueue.items.push(entry);
 composerFeedback(view,state.busy?"已加入队列；本轮结束后自动发送。":"");renderChatQueues();void pumpChatQueue();
}
async function pumpChatQueue(){
 if(state.busy||chatQueue.dispatching||chatQueue.paused||chatQueue.steering)return;
 const entry=chatQueue.items[0];if(!entry||entry.blocked||entry.editing)return;
 if(entry.view==="analysis"&&JSON.stringify(entry.options.selection)!==JSON.stringify(selectionRefs())){entry.blocked=true;composerFeedback("analysis","所选内容已变化，待发送问题已保留；请确认选择后重试，或移除这条消息。",true);renderChatQueues();return;}
 chatQueue.dispatching=true;chatQueue.items.shift();renderChatQueues();
 try{await sendMessage(entry.text,entry.view,`${entry.view}-follow`,entry.editorText,{...entry.options,attachments:entry.attachments,displayText:entry.displayText});}
 finally{chatQueue.dispatching=false;renderChatQueues();void pumpChatQueue();}
}
function queueEntrySummary(entry){return (entry.editorText||"图片作答")+(entry.attachments.length?` · ${entry.attachments.length} 张图片`:"");}
function updateChatQueueControls(){
 const busy=state.busy&&state.operation?.type==="chat";
 for(const view of ["organize","review","analysis"]){
  const form=$(`#${view}-follow-form`);if(!form)continue;
  const steer=form.querySelector("[data-steer-draft]");if(steer){steer.hidden=!(busy&&state.operation.view===view);steer.disabled=Boolean(chatQueue.steering)||(!$(`#${view}-follow`).value.trim()&&!(view==="review"&&answerAttachments.length));}
  const send=form.querySelector("[type=submit]");send.title=busy?"加入待发送队列（Ctrl+Enter）":"发送（Ctrl+Enter）";send.setAttribute("aria-label",busy?"加入待发送队列":"发送消息");
 }
}
function safeReleaseQueuedImage(image){
 const retained=answerAttachments.includes(image)||chatQueue.items.some(item=>item.attachments.includes(image))||state.operation?.attachments?.includes(image)||Object.values(state.chats).some(log=>log.some(item=>item.images?.some(part=>part.url===image.url)));
 if(!retained)URL.revokeObjectURL(image.url);
}
function renderChatQueues(){
 for(const view of ["organize","review","analysis"]){
  const panel=document.querySelector(`[data-chat-queue="${view}"]`);if(!panel)continue;
  const entries=chatQueue.items.filter(item=>item.view===view);panel.hidden=!entries.length;panel.replaceChildren();if(!entries.length)continue;
  const header=make("div","chat-queue-header"),title=make("strong","",`待发送 ${entries.length}`);header.append(title);
  if(chatQueue.paused){const resume=make("button","text-button","继续发送");resume.type="button";resume.addEventListener("click",()=>{chatQueue.paused=false;renderChatQueues();void pumpChatQueue();});header.append(make("span","queue-paused","已暂停"),resume);}
  panel.append(header);const list=make("div","chat-queue-list");panel.append(list);
  for(const entry of entries){
   const row=make("div","chat-queue-item");row.dataset.queuedMessage=entry.id;
   if(entry.editing){
    const edit=make("textarea","queue-editor");edit.rows=2;edit.value=entry.editDraft??entry.editorText;edit.setAttribute("aria-label","编辑待发送消息");edit.addEventListener("input",()=>entry.editDraft=edit.value);
    const actions=make("div","queue-actions"),save=make("button","text-button","保存"),cancel=make("button","text-button","取消编辑");save.type=cancel.type="button";
    save.addEventListener("click",()=>{const value=edit.value.trim();if(!value&&!entry.attachments.length)return;entry.editorText=value;entry.text=value||"请检查图片中我对当前题的作答，并继续一步步引导。";entry.displayText=value||"图片作答";entry.editing=false;entry.blocked=false;renderChatQueues();void pumpChatQueue();});
    cancel.addEventListener("click",()=>{entry.editing=false;delete entry.editDraft;renderChatQueues();void pumpChatQueue();});actions.append(save,cancel);row.append(edit,actions);
   }else{
    const summary=make("span","queue-summary",queueEntrySummary(entry));summary.title=entry.text;row.append(summary);
    if(entry.attachments.length){const thumb=make("img","queue-thumbnail");thumb.src=entry.attachments[0].url;thumb.alt="待发送作答图片";row.append(thumb);}
    const actions=make("div","queue-actions");
    if(entry.blocked){const retry=make("button","text-button","重试");retry.type="button";retry.addEventListener("click",()=>{entry.blocked=false;chatQueue.paused=false;renderChatQueues();void pumpChatQueue();});actions.append(retry);}
    const immediate=make("button","queue-send-now","立即发送");immediate.type="button";immediate.disabled=Boolean(chatQueue.steering)||(state.busy&&state.operation?.view!==view);immediate.addEventListener("click",()=>steerQueuedEntry(entry));
    const edit=make("button","text-button","编辑");edit.type="button";edit.addEventListener("click",()=>{entry.editing=true;entry.editDraft=entry.editorText;renderChatQueues();document.querySelector(`[data-queued-message="${entry.id}"] textarea`)?.focus();});
    const remove=make("button","text-button","移除");remove.type="button";remove.addEventListener("click",()=>{chatQueue.items=chatQueue.items.filter(item=>item!==entry);entry.attachments.forEach(safeReleaseQueuedImage);renderChatQueues();void pumpChatQueue();});
    actions.append(immediate,edit,remove);row.append(actions);
   }
   list.append(row);
  }
 }
 updateChatQueueControls();if(typeof updateReviewButtons==="function")updateReviewButtons();
}
function clearQueuedChat(view){const removed=chatQueue.items.filter(item=>item.view===view);chatQueue.items=chatQueue.items.filter(item=>item.view!==view);for(const entry of removed)entry.attachments.forEach(safeReleaseQueuedImage);renderChatQueues();}
function pauseChatQueue(){chatQueue.paused=true;renderChatQueues();}
async function steerDraft(view){if(!canDraftChat())return;const entry=draftChatEntry(view);if(entry)await steerQueuedEntry(entry);}
async function steerQueuedEntry(entry){
 if(chatQueue.steering)return;
 const operation=state.operation;
 if(state.busy&&(operation?.type!=="chat"||operation.view!==entry.view)){if(!chatQueue.items.includes(entry))chatQueue.items.push(entry);renderChatQueues();return;}
 if(state.busy&&(operation.attachments?.length||0)+entry.attachments.length>20){if(!chatQueue.items.includes(entry))chatQueue.items.push(entry);composerFeedback(entry.view,"本轮附图较多，请等待完成后发送这条补充。",true);renderChatQueues();return;}
 chatQueue.items=chatQueue.items.filter(item=>item!==entry);entry.blocked=false;entry.editing=false;chatQueue.paused=false;
 if(!state.busy){chatQueue.items.unshift(entry);renderChatQueues();void pumpChatQueue();return;}
 chatQueue.steering={operationId:operation.id,entry};operation.steering=true;operation.stopping=true;updateButtons();renderChatQueues();
 composerFeedback(entry.view,"正在接入补充，保留当前题与已完成步骤…");
 try{await api("/api/cancel",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({request_id:operation.id,steer:true})});}
 catch(error){composerFeedback(entry.view,"未确认中断状态；补充已保留，将在当前请求结束后发送。",true);}
}
function retainFailedChat(operation){
 chatQueue.paused=true;
 if(operation.editTarget!==`${operation.view}-follow`)return false;
 const editor=$(`#${operation.view}-follow`),hasDraft=editor.value.trim()||(operation.view==="review"&&answerAttachments.length);
 if(!hasDraft){editor.value=operation.editorText;if(operation.view==="review"){answerAttachments.push(...operation.attachments);renderAnswerImages();}renderChatQueues();return true;}
 chatQueue.items.unshift({id:crypto.randomUUID(),view:operation.view,text:operation.message,editorText:operation.editorText,displayText:operation.editorText||"图片作答",options:operation.chatOptions,attachments:operation.attachments,blocked:true,editing:false});
 renderChatQueues();return true;
}
function chatRequestFinished(operation){
 if(chatQueue.steering?.operationId===operation.id){
  const entry=chatQueue.steering.entry;chatQueue.steering=null;
  if(operation.outcome!=="success"&&!operation.historyRetained){
   entry.text="上一条尚未完成的请求：\n"+operation.message+"\n\n用户刚补充的新要求（优先回应）：\n"+entry.text;
   entry.options={...operation.chatOptions,...entry.options};entry.attachments=[...operation.attachments,...entry.attachments];
  }
  chatQueue.items.unshift(entry);chatQueue.paused=false;
 }
 renderChatQueues();queueMicrotask(()=>void pumpChatQueue());
}
window.addEventListener("DOMContentLoaded",()=>{
 for(const view of ["organize","review","analysis"]){
  const form=$(`#${view}-follow-form`),panel=make("section","chat-queue");panel.dataset.chatQueue=view;panel.hidden=true;panel.setAttribute("aria-label","待发送消息");form.prepend(panel);
  const immediate=make("button","composer-steer","立即发送");immediate.type="button";immediate.dataset.steerDraft=view;immediate.title="立即补充当前任务（Alt+Enter）";immediate.hidden=true;immediate.addEventListener("click",()=>steerDraft(view));form.querySelector(".composer-toolbar").append(immediate);
  form.querySelector("textarea").addEventListener("input",updateChatQueueControls);
 }
 renderChatQueues();updateChatComposerButtons();
});
