"use strict";
const noteState={records:[],images:[],cursor:{start:0,end:0},submitted:null,saved:false};
function noteCursor(){const editor=$("#note-text");noteState.cursor={start:editor.selectionStart,end:editor.selectionEnd};}
function updateNoteButtons(){
 const text=$("#note-text").value.trim();
 $("#note-submit").disabled=state.busy||!state.configured||!text||text===noteState.submitted;
 $("#note-submit").textContent=text&&text===noteState.submitted?(noteState.saved?"已保存笔记":"已提交，请在对话中补充"):"整理并保存笔记";
 $("#note-read").disabled=state.busy||!$("#note-file").files.length||(!state.configured&&!/\.(txt|md)$/i.test($("#note-file").files[0]?.name||""));
 for(const id of ["note-text","notes-follow"]){$("#"+id).readOnly=state.busy;}
 for(const id of ["note-new","note-show-source","note-file"]){$("#"+id).disabled=state.busy;}
 document.querySelectorAll("[data-note-export],.note-image-item button").forEach(button=>button.disabled=state.busy);
 $("#note-read-operation").hidden=!(state.busy&&state.operation?.type?.startsWith("notes-"));
}
function noteCollapsed(collapsed){$("#note-input-panel").hidden=collapsed;$("#notes-workspace").classList.toggle("source-collapsed",collapsed);$("#note-show-source").textContent=collapsed?"查看原稿":"收起原稿";}
function applyNoteResults(events){
 let name=null;
 for(const event of events||[]){
  if(event.event==="工具请求")name=event.value.name;
  if(event.event==="工具结果"&&name==="save_note"&&event.value.ok){noteState.saved=true;$("#note-saved-summary").hidden=false;noteCollapsed(true);}
 }
 updateNoteButtons();
}
function clearNoteWorkspace(){
 for(const item of noteState.images)URL.revokeObjectURL(item.url);
 noteState.images=[];noteState.cursor={start:0,end:0};noteState.submitted=null;noteState.saved=false;
 for(const id of ["note-text","note-file","notes-follow"])$("#"+id).value="";
 state.chats.notes=[];state.traces.notes=[];$("#note-saved-summary").hidden=true;noteCollapsed(false);
 $("#notes-messages").replaceChildren(make("p","new-chat-prompt","添加笔记原稿，开始本次整理。"));$("#notes-follow-form").hidden=true;renderTrace("notes");renderNoteImages();updateNoteButtons();
}
function renderNoteImages(){
 const list=$("#note-images");list.replaceChildren();
 noteState.images.forEach((item,index)=>{
  const figure=make("figure","note-image-item");const image=make("img");image.src=item.url;image.alt=`第 ${index+1} 张笔记原图`;const caption=make("figcaption","",`第 ${index+1} 张`);const remove=make("button","","移除原图");remove.type="button";
  remove.addEventListener("click",()=>{URL.revokeObjectURL(item.url);noteState.images=noteState.images.filter(other=>other!==item);renderNoteImages();notify("已移除这张原图，编辑框中的文字保留。");});
  figure.append(image,caption,remove);list.append(figure);
 });updateNoteButtons();
}
function renderNotes(){
 const query=$("#note-search").value.trim().toLowerCase();const records=noteState.records.filter(item=>!query||`${item.topic} ${item.content}`.toLowerCase().includes(query));
 $("#notes-count").textContent=noteState.records.length;$("#note-library-count").textContent=`${noteState.records.length} 份笔记 · 新笔记也可供错题整理时检索`;
 const list=$("#note-library");list.replaceChildren();
 if(!records.length){const empty=make("div","list-empty");empty.append(make("strong","",query?"没有匹配的笔记":"还没有笔记"),make("p","","添加课堂原稿后，整理结果会保存在这里。"));list.append(empty);}
 for(const item of records){
  const card=make("article","note-card");card.dataset.noteId=item.id;card.append(make("span","topic-tag",item.topic));
  const details=make("details");details.append(make("summary","","展开笔记正文"));const content=make("div","note-content");rich(content,item.content);details.append(content);card.append(details);
  const actions=make("div","note-card-actions");for(const kind of ["md","pdf"]){if(item.downloads[kind]){const link=make("a","",kind==="md"?"下载 Markdown":"下载 PDF");link.href=item.downloads[kind];link.download="";actions.append(link);}}
  if(!item.downloads.md||!item.downloads.pdf){const button=make("button","button secondary small","导出 / 重试");button.type="button";button.dataset.noteExport=item.id;button.addEventListener("click",()=>noteOperation("export",async operation=>{const result=await api(`/api/notes/${item.id}/export`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({request_id:operation.id})});if(!result.exports.pdf?.ok)notify(`笔记已保留，PDF 导出未完成：${result.exports.pdf?.error||"请检查排版依赖"}`,true);else notify("Markdown 与 PDF 已导出，可在笔记卡片下载。");await loadNotes();}));actions.append(button);}
  card.append(actions);list.append(card);
 }updateNoteButtons();
}
async function loadNotes(){try{const result=await api("/api/notes");noteState.records=result.notes;renderNotes();}catch(error){$("#note-library-count").textContent=error.message;}}
async function noteOperation(type,action){
 if(state.busy)return;const operation={id:crypto.randomUUID(),type:`notes-${type}`,view:"notes",stopping:false};state.operation=operation;setBusy(true);notify("");
 try{await action(operation);}catch(error){notify(error.cancelled?"已停止处理，原稿与已保存笔记保留。":error.message,!error.cancelled);}finally{state.operation=null;setBusy(false);}
}
$("#note-read").addEventListener("click",()=>noteOperation("read",async operation=>{
 const file=$("#note-file").files[0];if(!file)return;if(file.size>8*1024*1024)throw new Error("单个文件不能超过 8 MB。");
 if(!/\.(txt|md)$/i.test(file.name)&&noteState.images.length>=6)throw new Error("本份笔记最多添加六张原图，请分批整理。");
 const selection={...noteState.cursor};const form=new FormData();form.append("file",file);form.append("request_id",operation.id);form.append("keep_image_ids",JSON.stringify(noteState.images.map(item=>item.id)));
 const result=await api("/api/notes/read",{method:"POST",body:form});const editor=$("#note-text");const start=Math.min(selection.start,editor.value.length),end=Math.min(selection.end,editor.value.length);
 const insert=(start&&editor.value[start-1]!=="\n"?"\n\n":"")+result.text+(end<editor.value.length?"\n\n":"");
 if(editor.value.length-(end-start)+insert.length>24000)throw new Error("插入后会超过 24000 字；原稿已保留，请分批整理。");
 editor.setRangeText(insert,start,end,"end");noteCursor();
 if(result.image_id)noteState.images.push({id:result.image_id,url:URL.createObjectURL(file)});
 $("#note-file").value="";renderNoteImages();editor.focus();notify(result.image_id?"原稿已插入，请核对公式。整理时会同时发送本次原图；主模型需支持图片输入。":"原稿已插入，核对后即可整理。");
}));
$("#note-submit").addEventListener("click",()=>{
 if($("#note-submit").disabled)return;
 const source=$("#note-text").value.trim();noteState.submitted=source;noteState.saved=false;
 sendMessage("请按默认笔记规则整理以下课堂原稿，原图按附件顺序阅读。保留标题、编号、符号与推导，补充解释单独写为注解；关键符号不清楚先询问，确认后调用 save_note。\n\n"+source,"notes","note-text",source,{new_problem:true,image_ids:noteState.images.map(item=>item.id)});
});
$("#note-show-source").addEventListener("click",()=>noteCollapsed(!$("#note-input-panel").hidden));
$("#note-new").addEventListener("click",()=>{if(!state.busy)clearNoteWorkspace();});
$("#note-file").addEventListener("change",updateNoteButtons);$("#note-search").addEventListener("input",renderNotes);
for(const event of ["input","select","keyup","click","blur"])$("#note-text").addEventListener(event,()=>{noteCursor();updateNoteButtons();});
document.querySelectorAll(".note-source-tab").forEach(button=>button.addEventListener("click",()=>{document.querySelectorAll(".note-source-tab").forEach(other=>{other.classList.toggle("active",other===button);other.setAttribute("aria-pressed",String(other===button));});$("#note-upload-pane").hidden=button.dataset.noteSource==="text";if($("#note-upload-pane").hidden)$("#note-text").focus();}));
clearNoteWorkspace();loadNotes();
