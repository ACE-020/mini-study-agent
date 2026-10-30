"use strict";
// Visibility follows deliberate task transitions; drafts and original DOM nodes stay intact.
const taskFocus={ready:false,organize:"source",material:"source",lastMaterialStage:null,lastChatCount:0,analysisSources:false,reading:null};
function taskButton(label,action,id){const button=make("button","button quiet small",label);button.type="button";if(id)button.id=id;button.addEventListener("click",action);return button;}
function setTaskNavigation(open){document.body.classList.toggle("task-navigation-open",open);$("#task-navigation-toggle").setAttribute("aria-expanded",String(open));$("#task-navigation-backdrop").hidden=!open;$(".main").inert=open;$(open?"#close-task-navigation":"#task-navigation-toggle").focus({preventScroll:true});}
function setOrganizeFocus(mode){taskFocus.organize=mode;intake.collapsed=mode!=="source";updateIntake();syncTaskFocus();}
function setMaterialFocus(mode){taskFocus.material=mode;if(mode==="source")setMaterialStage("source");syncTaskFocus();}
function taskMaterialStageChanged(stage){taskFocus.lastMaterialStage=stage;taskFocus.material=stage;syncTaskFocus();}
function shouldAutoOpenMaterialPreview(){return taskFocus.material!=="library";}
function taskBeforeViewChange(view){if(taskFocus.reading&&view!==state.view)closeRecordReading();}
function setCorrectionFocus(open){const dialog=$("#batch-ai-dialog");dialog.classList.toggle("correction-reading",!open);const button=$("#toggle-correction-chat");if(button){button.textContent=open?"收起 AI 修正":"请 AI 修正";button.setAttribute("aria-expanded",String(open));}if(open&&dialog.open)$("#batch-ai-input").focus({preventScroll:true});}
function decorateRecordFocus(card,kind,record){
 if(typeof decorateRecordProgress==="function")decorateRecordProgress(card,kind,record);
 const button=taskButton("专心阅读",()=>openRecordReading(card,record));button.classList.add("record-focus-button");button.dataset.recordFocus=record.id;
 card.querySelector(".record-card-top")?.append(button);
}
function openRecordReading(card,record){
 if(taskFocus.reading)closeRecordReading();
 const anchor=document.createComment("reading-position");card.before(anchor);
 taskFocus.reading={card,anchor,scroll:window.scrollY,trigger:card.querySelector("[data-record-focus]")};
 $("#reading-title").textContent=record.topic;$("#reading-body").append(card);$("#reading-workspace").classList.remove("reading-tools-open");
 $("#reading-more").setAttribute("aria-expanded","false");$("#reading-workspace").showModal();$("#reading-body").scrollTop=0;
}
function closeRecordReading(){
 const saved=taskFocus.reading;if(!saved)return;taskFocus.reading=null;
 if(saved.anchor.isConnected)saved.anchor.replaceWith(saved.card);else saved.card.remove();
 if($("#reading-workspace").open)$("#reading-workspace").close();
 window.scrollTo({top:saved.scroll,behavior:"instant"});if(saved.trigger.isConnected)saved.trigger.focus({preventScroll:true});
}
function syncTaskFocus(){
 if(!taskFocus.ready)return;
 const count=state.chats.organize.length;
 if(count&&!taskFocus.lastChatCount)taskFocus.organize="discuss";
 if(!count){taskFocus.organize="source";taskFocus.lastChatCount=0;}else taskFocus.lastChatCount=count;
 if(materialState.stage!==taskFocus.lastMaterialStage){taskFocus.lastMaterialStage=materialState.stage;taskFocus.material=materialState.stage;}
 document.body.dataset.taskView=state.view;
 document.body.dataset.intakeFocus=taskFocus.organize;
 document.body.dataset.materialFocus=taskFocus.material;
 document.body.classList.toggle("analysis-sources-open",taskFocus.analysisSources);
 if(state.view==="organize")$("#source-panel").hidden=taskFocus.organize!=="source";
 const practice=$("#practice-current"),next=$("#new-mistake");practice.hidden=state.view!=="organize"||!state.chats.organize.some(item=>item.role==="assistant");practice.disabled=state.busy||!state.configured;next.hidden=state.view!=="organize"||!intake.saved.size;
 const bar=$("#task-focus-bar"),key=JSON.stringify([state.view,taskFocus.organize,taskFocus.material,count>0,intake.saved.size,taskFocus.analysisSources,materialState.preview.length,materialState.currentJob?.source]);if(bar.dataset.renderKey===key)return;bar.dataset.renderKey=key;bar.replaceChildren();
 if(state.view==="organize"){
  bar.append(make("strong","task-context",taskFocus.organize==="source"?"添加学习内容":taskFocus.organize==="saved"?"本次已保存内容":"整理与讨论"));
  if(count){if(taskFocus.organize!=="source")bar.append(taskButton("查看原稿",()=>setOrganizeFocus("source"),"focus-show-source"));if(taskFocus.organize!=="discuss")bar.append(taskButton("返回讨论",()=>setOrganizeFocus("discuss"),"focus-show-discussion"));}
  if(intake.saved.size&&taskFocus.organize!=="saved")bar.append(taskButton("已保存 "+intake.saved.size+" 条",()=>setOrganizeFocus("saved"),"focus-show-saved"));
 }else if(state.view==="materials"){
  const mode=taskFocus.material;bar.append(make("strong","task-context",mode==="library"?"资料题库":mode==="preview"?"核对 · "+(materialState.currentJob?.source||"本批资料"):mode==="processing"?"本批正在整理":"导入练习资料"));
  if(mode!=="library")bar.append(taskButton("资料题库",()=>setMaterialFocus("library"),"focus-show-library"));
  if(mode==="library"&&materialState.stage==="preview"&&!materialState.preview.length)bar.append(taskButton("继续导入",newMaterialBatch,"focus-next-material"));
  if(mode!=="source")bar.append(taskButton("导入资料",()=>setMaterialFocus("source"),"focus-show-import"));
  if(materialState.preview.length&&mode!=="preview")bar.append(taskButton("返回核对",()=>{taskFocus.material="preview";setMaterialStage("preview");},"focus-resume-preview"));
  if(mode==="preview")bar.append(taskButton("来源与批次",()=>{const panel=$("#material-preview-panel");panel.classList.toggle("source-details-open");},"focus-preview-source"));
 }else if(state.view==="analysis"){
  bar.append(make("strong","task-context","围绕所选内容提问"),taskButton(taskFocus.analysisSources?"收起参考内容":"参考内容与建议",()=>{taskFocus.analysisSources=!taskFocus.analysisSources;syncTaskFocus();},"focus-analysis-sources"));
 }else if(state.view==="review"){
  bar.hidden=true;
 }else bar.append(make("strong","task-context",state.view==="notes"?"我的笔记":"我的错题本"));
 if(state.view!=="review")bar.hidden=false;
}
function disclosureFor(nodes,label,className){
 const actual=nodes.filter(Boolean);if(!actual.length)return null;
 const details=make("details",className),summary=make("summary","",label);details.append(summary);actual[0].before(details);actual.forEach(node=>details.append(node));return details;
}
function showConversationUpdate(view){
 const log=$(`#${view}-messages`);let button=$(`#${view}-new-reply`);if(!button){button=taskButton("查看新回复",()=>{log.scrollTop=log.scrollHeight;button.hidden=true;},`${view}-new-reply`);button.classList.add("conversation-new");log.after(button);log.addEventListener("scroll",()=>{if(log.scrollHeight-log.clientHeight-log.scrollTop<64)button.hidden=true;});}button.hidden=false;
}
function initTaskFocus(){
 document.body.classList.add("task-shell");
 $(".breadcrumb").childNodes.forEach(node=>{if(node.nodeType===Node.TEXT_NODE)node.textContent="";});
 const navigation=taskButton("切换任务",()=>setTaskNavigation(!document.body.classList.contains("task-navigation-open")),"task-navigation-toggle");navigation.setAttribute("aria-expanded","false");navigation.setAttribute("aria-controls","task-navigation");
 $(".sidebar").id="task-navigation";$(".breadcrumb").prepend(navigation);
 $(".sidebar").prepend(taskButton("收起导航",()=>setTaskNavigation(false),"close-task-navigation"));
 const backdrop=taskButton("关闭任务导航",()=>setTaskNavigation(false),"task-navigation-backdrop");backdrop.hidden=true;backdrop.tabIndex=-1;document.body.append(backdrop);
 document.querySelectorAll(".nav-item,.brand").forEach(node=>node.addEventListener("click",()=>setTaskNavigation(false)));
 const utilities=disclosureFor([$("#show-prompt"),$("#open-settings")],"更多","task-utilities");
 const menu=make("div","task-utility-menu");for(const button of [...utilities.querySelectorAll("button"),$("#practice-current"),$("#new-mistake")]){button.className="button quiet small";menu.append(button);}utilities.append(menu);
 utilities.addEventListener("click",event=>{if(event.target.closest("button"))utilities.open=false;});
 const bar=make("div","task-focus-bar");bar.id="task-focus-bar";$(".page-content").prepend(bar);
 const materialLibrary=make("section","material-library-panel");materialLibrary.id="material-library-panel";
 const heading=$("#view-materials .material-library-heading");heading.before(materialLibrary);
 let item=heading;while(item){const next=item.nextElementSibling;materialLibrary.append(item);item=next;}
 const source=$("#material-source-panel"),sourceFields=source.querySelector(".material-source-fields");
 disclosureFor([source.querySelector(".ocr-choice"),...source.querySelectorAll("[data-local-ocr-info]")],"识别方式与费用","task-advanced");
 const intakeImage=$("#image-pane");disclosureFor([intakeImage.querySelector(".ocr-choice"),...intakeImage.querySelectorAll("[data-local-ocr-info]")],"识别方式与费用","task-advanced");
 const supplement=sourceFields.children[1];disclosureFor([supplement],"补充说明 / 直接输入文字","material-supplement");
 sourceFields.querySelector(".material-supplement").addEventListener("toggle",()=>{$("#material-text").readOnly=state.busy;});
 sourceFields.querySelector(".material-supplement").open=Boolean($("#material-text").value);
 for(const view of ["organize","review","analysis"]){
  const form=$(`#${view}-follow-form`),label=form.querySelector(".composer-model-label");
  const details=disclosureFor([label],"模型","composer-model-menu");if(details)details.setAttribute("aria-label","选择对话模型");
 }
 const correction=taskButton("收起 AI 修正",()=>setCorrectionFocus($("#batch-ai-dialog").classList.contains("correction-reading")),"toggle-correction-chat");correction.setAttribute("aria-expanded","true");$(".review-source-toolbar").prepend(correction);
 const reading=make("dialog","reading-workspace");reading.id="reading-workspace";reading.setAttribute("aria-labelledby","reading-title");
 const head=make("header","reading-heading"),title=make("h2");title.id="reading-title";
 const more=taskButton("更多操作",()=>{const open=reading.classList.toggle("reading-tools-open");more.setAttribute("aria-expanded",String(open));},"reading-more");more.setAttribute("aria-expanded","false");
 const body=make("div","reading-body");body.id="reading-body";head.append(taskButton("返回列表",closeRecordReading,"reading-back"),title,more);reading.append(head,body);document.body.append(reading);
 reading.addEventListener("close",closeRecordReading);reading.addEventListener("cancel",event=>{event.preventDefault();closeRecordReading();});
 document.addEventListener("keydown",event=>{if(event.key==="Escape"&&document.body.classList.contains("task-navigation-open")){event.preventDefault();setTaskNavigation(false);}});
 document.addEventListener("click",event=>{if(!event.target.closest(".task-utilities"))utilities.open=false;});
 taskFocus.ready=true;syncTaskFocus();
}
window.addEventListener("DOMContentLoaded",initTaskFocus);
