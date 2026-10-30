"use strict";
const reviewProgressState={round:null,records:{},errorTypes:{},serial:0,history:null};
const reviewOutcomeNames={not_answered:"尚未作答",unassessed:"尚未判定",partial:"做到一部分",incorrect:"做错",correct:"整题做对"};
function reviewQuestionKey(record,kind="exercise"){return /^(exercise|mistake|generated):/.test(record.id)?record.id:(kind||"exercise")+":"+record.id;}
function reviewTime(value){return value?new Date(value).toLocaleString("zh-CN",{hour12:false}):"";}
function reviewResultLabel(record){return record.independent_correct?"独立做对":record.outcome==="correct"?(record.was_wrong?"改正后做对":"提示后做对"):reviewOutcomeNames[record.outcome]||"尚未判定";}
function syncReviewProgress(snapshot){if(!snapshot)return;reviewProgressState.round=snapshot;
 if(snapshot.selection){reviewState.selection={...snapshot.selection};reviewState.expanded.add(snapshot.selection.category);renderReviewTree();}++reviewProgressState.serial;renderReviewProgress();void loadReviewProgress();}
async function loadReviewProgress(){
 const serial=++reviewProgressState.serial;
 try{const result=await api("/api/review/progress");if(serial!==reviewProgressState.serial)return;
  reviewProgressState.round=result.review;reviewProgressState.records=result.progress;reviewProgressState.errorTypes=result.error_types;
  if(!state.busy&&!reviewState.question&&result.review.current_question&&!state.chats.review.length){
   setReviewQuestion(result.review.current_question);state.chats.review.push({role:"notice",text:"已恢复本轮当前题，做题记录仍保留。可以继续作答，或结束本轮。"});renderChat("review");
  }
  renderReviewProgress();
 }catch(error){const info=$("#review-record-status");if(info){info.hidden=false;info.textContent="做题记录读取失败："+error.message;}}
}
function updateReviewProgressControls(){
 const pending=state.busy||(typeof hasQueuedChat==="function"&&hasQueuedChat("review"));
 const end=$("#end-review-round");if(end)end.disabled=pending||!reviewProgressState.round?.seen_ids.length;
 const save=$("#save-review-result");if(save)save.disabled=pending;
}
function decorateRecordProgress(card,kind,record){
 if(!["exercise","mistake"].includes(kind))return;
 card.dataset.reviewQuestion=reviewQuestionKey(record,kind);renderRecordProgress(card);
}
function renderRecordProgress(card){
 const item=reviewProgressState.records[card.dataset.reviewQuestion];let bar=card.querySelector(".record-progress");
 if(!item){bar?.remove();return;}if(!bar){bar=make("div","record-progress");card.append(bar);}
 bar.replaceChildren();const last=item.last;
 const button=make("button","text-button",`已做 ${item.count} 次 · ${reviewResultLabel(last)} · ${reviewTime(last.first_answer_at||last.started_at)}`);
 button.type="button";button.addEventListener("click",()=>openReviewHistory(card.dataset.reviewQuestion));bar.append(button);
 if(item.error_tags.length)bar.append(make("span","review-error-tags","曾错："+item.error_tags.map(tag=>reviewProgressState.errorTypes[tag]||tag).join(" · ")));
}
function renderReviewProgress(){
 const round=reviewProgressState.round,question=reviewState.question,status=$("#review-record-status");
 if(!status)return;
 const attempt=round?.current_attempt;
 status.hidden=!question;status.replaceChildren();
 if(question){
  const key=reviewQuestionKey(question,question.kind),saved=reviewProgressState.records[key];
  status.append(make("span","",round?.seen_ids.includes(key)?"本轮已出":"当前题目"));
  if(attempt?.turn_count)status.append(make("span","",reviewResultLabel(attempt)+(attempt.assisted?" · 用过提示":"")));
  else status.append(make("span","","尚未作答"));
  if(saved)status.append(make("span","",`累计做过 ${saved.count} 次`));
  if(attempt?.error_tags.length)status.append(make("span","review-error-tags",attempt.error_tags.map(tag=>reviewProgressState.errorTypes[tag]||tag).join(" · ")));
 }
 $("#review-round-count").textContent=round?.seen_ids.length?`本轮已出 ${round.seen_ids.length} 道`:"";
 document.querySelectorAll(".record-card[data-review-question]").forEach(renderRecordProgress);updateReviewProgressControls();
}
async function finishReviewRound(){
 if(state.busy||(typeof hasQueuedChat==="function"&&hasQueuedChat("review")))return;
 if(!confirm("结束本轮并清除临时对话、未发送文字吗？每次做题时间、作答情况和错因记录都会保留。"))return;
 state.operation={id:crypto.randomUUID(),type:"review-end",view:"review"};setBusy(true);
 try{const result=await api("/api/review/end",{method:"POST"});
  resetReviewAttachments();if(typeof clearQueuedChat==="function")clearQueuedChat("review");
  state.chats.review=[];state.traces.review=[];$("#review-follow").value="";$("#review-follow-form").hidden=true;
  $("#review-messages").replaceChildren();$("#review-trace").hidden=true;reviewState.catalogOpen=true;setReviewQuestion(null);updateReviewLayout();
  reviewProgressState.records=result.progress;syncReviewProgress(result.review);notify("本轮已结束，做题记录已保留。",false,"review");
 }catch(error){notify(error.message,true,"review");}finally{state.operation=null;setBusy(false);}
}
async function renderHistoryPage(append=false){
 const context=reviewProgressState.history;if(!context)return;
 const offset=append?context.offset:0;
 try{const query=new URLSearchParams({offset:String(offset),limit:"20"});if(context.questionId)query.set("question_id",context.questionId);
  const data=await api("/api/review/history?"+query);if(reviewProgressState.history!==context)return;
  const list=$("#review-history-list");if(!append)list.replaceChildren();context.offset=offset+data.attempts.length;
  $("#review-history-count").textContent=`共 ${data.total} 次实际做题记录（仅选中但未作答的不计入）。`;
  if(!data.total)list.append(make("p","","还没有实际作答记录。选题本身不会被标成做过。"));
  for(const record of data.attempts){const card=make("article","review-attempt");
   card.append(make("strong","",`${reviewTime(record.first_answer_at||record.started_at)} · ${record.question_title}`),make("p","",`${reviewResultLabel(record)}${record.assisted?" · 用过实质提示":""}${record.closed_at?" · 本次已结束":" · 本次记录仍保留"}`));
   if(record.error_tags.length)card.append(make("p","review-error-tags","曾出现的错因："+record.error_tags.map(tag=>reviewProgressState.errorTypes[tag]||tag).join("、")));
   const details=make("details",""),summary=make("summary","","作答时间与判定依据");details.append(summary);
   const events=[...record.turns.map(turn=>({at:turn.at,text:"你："+turn.text})),...record.assessments.map(a=>({at:a.at,text:(a.source==="user"?"你确认：":"AI 判定：")+reviewOutcomeNames[a.outcome]+"。"+a.evidence}))].sort((a,b)=>a.at.localeCompare(b.at));
   for(const event of events)details.append(make("p","attempt-event",`${reviewTime(event.at)}\n${event.text}`));card.append(details);list.append(card);
  }
  $("#more-review-history").hidden=context.offset>=data.total;
 }catch(error){$("#review-history-feedback").textContent=error.message;}
}
function manualReviewForm(questionId){
 const target=$("#review-manual-result");target.replaceChildren();
 const attempt=reviewProgressState.round?.current_attempt;
 target.hidden=!attempt?.turn_count||Boolean(questionId&&attempt.question_id!==questionId);if(target.hidden)return;
 target.dataset.attemptId=attempt.id;target.append(make("summary","","核对或补充本次做题情况"));
 const form=make("form","review-result-form");
 const label=make("label","","本次情况"),select=make("select");select.id="review-result-outcome";
 for(const value of ["unassessed","partial","incorrect","correct"]){const option=make("option","",reviewOutcomeNames[value]);option.value=value;select.append(option);}select.value=attempt.outcome;label.append(select);form.append(label);
 const hint=make("label","review-result-check"),check=make("input");check.type="checkbox";check.id="review-result-assisted";check.checked=attempt.assisted;hint.append(check,document.createTextNode("用过实质提示或看过解法"));form.append(hint);
 const tags=make("fieldset","review-result-tags");tags.append(make("legend","","本次错因（有依据时选择）"));
 for(const [value,name] of Object.entries(reviewProgressState.errorTypes)){const label=make("label",""),input=make("input");input.type="checkbox";input.value=value;input.dataset.reviewError="";label.append(input,document.createTextNode(name));tags.append(label);}form.append(tags);
 const evidenceLabel=make("label","","判定依据"),evidence=make("textarea");evidence.id="review-result-evidence";evidence.rows=2;evidence.maxLength=1500;evidence.required=true;evidence.placeholder="例如：这次漏掉了分母不能为零的条件。";evidenceLabel.append(evidence);form.append(evidenceLabel);
 const save=make("button","button secondary small","保存本次情况");save.type="submit";save.id="save-review-result";form.append(save);
 form.addEventListener("submit",async event=>{event.preventDefault();if(state.busy)return;
  const payload={attempt_id:target.dataset.attemptId,outcome:select.value,assisted:check.checked,error_tags:[...tags.querySelectorAll("input:checked")].map(node=>node.value),evidence:evidence.value};save.disabled=true;
  try{const result=await api("/api/review/result",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});reviewProgressState.records=result.progress;syncReviewProgress(result.review);$("#review-history-feedback").textContent="本次情况已保存。";await renderHistoryPage();}
  catch(error){$("#review-history-feedback").textContent=error.message;}finally{updateReviewProgressControls();}
 });target.append(form);updateReviewProgressControls();
}
async function openReviewHistory(questionId=null){
 reviewProgressState.history={questionId,offset:0};$("#review-history-count").textContent="正在读取记录…";$("#review-history-feedback").textContent="";$("#review-history-list").replaceChildren();
 manualReviewForm(questionId);$("#review-history-dialog").showModal();await renderHistoryPage();
}
window.addEventListener("DOMContentLoaded",()=>{
 const bar=$("#view-review .review-layout-bar"),count=make("span","review-round-count");count.id="review-round-count";
 bar.append(count,taskButton("做题记录",()=>openReviewHistory(),"open-review-history"),taskButton("结束本轮",finishReviewRound,"end-review-round"));
 const status=make("div","review-record-status");status.id="review-record-status";$("#review-question").append(status);
 const questionHistory=taskButton("本题记录",()=>openReviewHistory(reviewQuestionKey(reviewState.question,reviewState.question.kind)),"question-review-history");$(".review-question-heading").append(questionHistory);
 const dialog=make("dialog","review-history-dialog");dialog.id="review-history-dialog";dialog.setAttribute("aria-labelledby","review-history-title");
 const heading=make("header","review-history-heading"),title=make("h2","","做题记录");title.id="review-history-title";heading.append(title,taskButton("关闭",()=>dialog.close(),"close-review-history"));
 const body=make("div","review-history-body"),counter=make("p"),feedback=make("p"),list=make("div"),manual=make("details","review-manual-result");counter.id="review-history-count";feedback.id="review-history-feedback";feedback.setAttribute("role","status");list.id="review-history-list";manual.id="review-manual-result";
 body.append(counter,manual,feedback,list,taskButton("更早记录",()=>renderHistoryPage(true),"more-review-history"));dialog.append(heading,body);document.body.append(dialog);void loadReviewProgress();
});
