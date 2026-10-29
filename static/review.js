"use strict";
const reviewState={catalog:null,selection:{category:"",tag:"",source:"any"},expanded:new Set(),loading:null,error:"",question:null,catalogOpen:true};
function updateReviewLayout(){
 const active=state.view==="review"&&Boolean(reviewState.question);
 document.body.classList.toggle("review-focused",active);
 $("#view-review").classList.toggle("catalog-collapsed",!reviewState.catalogOpen);
 $("#review-catalog-panel").hidden=!reviewState.catalogOpen;
 const toggle=$("#toggle-review-catalog");toggle.textContent=reviewState.catalogOpen?"收起选题":"展开选题";toggle.setAttribute("aria-expanded",String(reviewState.catalogOpen));
 $("#review-focus-label").textContent=reviewState.question?[reviewState.question.topic,...(reviewState.question.tags||[]).slice(0,2)].filter(Boolean).join(" / "):"选择范围后开始练习";
}
function setReviewQuestion(question){
 if(JSON.stringify(reviewState.question)===JSON.stringify(question||null))return;
 reviewState.question=question||null;if(question)reviewState.catalogOpen=false;updateReviewLayout();const card=$("#review-question");card.hidden=!question;
 if(!question)return;
 $("#review-question-source").textContent=[question.kind==="mistake"?"错题本":question.source,question.paper,question.number?"原题号 "+question.number:""].filter(Boolean).join(" · ");
 rich($("#review-question-body"),question.question);
 $("#review-question-content").hidden=false;$("#toggle-review-question").textContent="收起题干";$("#toggle-review-question").setAttribute("aria-expanded","true");
}
function reviewSelectionCount(){
 const data=reviewState.catalog;if(!data)return 0;
 const category=reviewState.selection.category;if(!category)return data.total;
 const node=data.categories.find(node=>node.category===category);
 return reviewState.selection.tag?(node?.children.find(child=>child.tag===reviewState.selection.tag)?.count||0):(node?.count||0);
}
function updateReviewButtons(){
 const pending=state.busy||Boolean(reviewState.loading)||(typeof hasQueuedChat==="function"&&hasQueuedChat("review"));
 $("#start-review").disabled=pending||!reviewSelectionCount();
 $("#review-source").disabled=pending;
 document.querySelectorAll("#review-tree button").forEach(button=>button.disabled=pending);
 const selected=reviewState.selection;
 $("#review-selection").textContent=[selected.category||"全部知识点",selected.tag].filter(Boolean).join(" / ")+" · "+reviewSelectionCount()+" 道";
 $("#review-load-status").textContent=reviewState.error||(reviewState.loading?"正在读取分类…":reviewState.catalog?.total?"分类来自已收录的资料题目和错题；细分标签可交叉归类。":"暂无可练习的题目，可先添加学习内容或导入练习资料。");
 $("#review-load-status").hidden=Boolean(!reviewState.error&&!reviewState.loading&&reviewState.catalog?.total);
}
function chooseReviewNode(category,tag=""){
 reviewState.selection={...reviewState.selection,category,tag};renderReviewTree();[...$("#review-tree").querySelectorAll("[data-review-category]")].find(node=>node.dataset.reviewCategory===category&&(node.dataset.reviewTag||"")===tag)?.focus({preventScroll:true});
}
function renderReviewTree(){
 const tree=$("#review-tree");if(!tree)return;tree.replaceChildren();
 const all=make("button","review-folder-label review-all","全部知识点"),count=make("span","review-tree-count",String(reviewState.catalog?.total||0));
 all.type="button";all.dataset.reviewCategory="";all.setAttribute("aria-pressed",String(!reviewState.selection.category));all.append(count);
 all.addEventListener("click",()=>chooseReviewNode(""));tree.append(all);
 for(const [index,node] of (reviewState.catalog?.categories||[]).entries()){
  const group=make("div","review-folder"),row=make("div","review-folder-row"),expanded=reviewState.expanded.has(node.category);
  const toggle=make("button","review-folder-toggle",node.children.length?(expanded?"▾":"▸"):"·");toggle.type="button";
  toggle.setAttribute("aria-label",(expanded?"收起":"展开")+node.label+"细分标签");toggle.setAttribute("aria-expanded",String(expanded));toggle.setAttribute("aria-controls","review-children-"+index);
  toggle.dataset.reviewToggle=node.category;
  const label=make("button","review-folder-label",node.label);label.type="button";label.dataset.reviewCategory=node.category;
  label.setAttribute("aria-pressed",String(reviewState.selection.category===node.category&&!reviewState.selection.tag));label.append(make("span","review-tree-count",String(node.count)));
  label.addEventListener("click",()=>chooseReviewNode(node.category));
  const children=make("div","review-folder-children");children.id="review-children-"+index;children.hidden=!expanded;children.setAttribute("role","group");children.setAttribute("aria-label",node.label+"细分标签");
  for(const child of node.children){
   const button=make("button","review-tag-node",child.label);button.type="button";button.dataset.reviewCategory=node.category;button.dataset.reviewTag=child.tag;
   button.setAttribute("aria-pressed",String(reviewState.selection.category===node.category&&reviewState.selection.tag===child.tag));button.append(make("span","review-tree-count",String(child.count)));
   button.addEventListener("click",()=>chooseReviewNode(node.category,child.tag));children.append(button);
  }
  toggle.addEventListener("click",()=>{if(!node.children.length)return;if(reviewState.expanded.has(node.category))reviewState.expanded.delete(node.category);else reviewState.expanded.add(node.category);renderReviewTree();$("#review-tree").querySelectorAll("[data-review-toggle]")[index]?.focus({preventScroll:true});});
  row.append(toggle,label);group.append(row,children);tree.append(group);
 }
 updateReviewButtons();
}
async function loadReviewCatalog(){
 if(reviewState.loading){await reviewState.loading.catch(()=>{});if(reviewState.catalog?.source===reviewState.selection.source)return;}
 const source=reviewState.selection.source;reviewState.error="";
 reviewState.loading=api("/api/review/catalog?source="+encodeURIComponent(source));updateReviewButtons();
 try{reviewState.catalog=await reviewState.loading;}catch(error){reviewState.error=error.message;}
 finally{reviewState.loading=null;renderReviewTree();}
}
async function practiceMistakeTopic(topic){
 if(state.busy||hasQueuedChat("review"))return;
 reviewState.selection={category:"",tag:"",source:"any"};$("#review-source").value="any";showView("review");
 await loadReviewCatalog();
 const filter=reviewState.catalog?.topic_filters?.[topic];
 if(!filter||reviewState.error){notify(reviewState.error||"这个知识点已不在题库中，请刷新错题本后重试。",true,"review");return;}
 reviewState.expanded.add(filter.category);chooseReviewNode(filter.category,filter.tag);
 await startReviewSelection();
}
async function startReviewSelection(){
 if(state.busy||!reviewSelectionCount()||(typeof hasQueuedChat==="function"&&hasQueuedChat("review")))return;
 const selection={...reviewState.selection},title=[selection.category||"全部知识点",selection.tag].filter(Boolean).join(" / ");
 const operation={id:crypto.randomUUID(),type:"chat",view:"review",stopping:false};state.operation=operation;setBusy(true);notify("",false,"review");
 try{
  const result=await api("/api/review/select",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...selection,request_id:operation.id})});
  resetReviewAttachments();
  setReviewQuestion(result.current_question);
  state.chats.review=[{role:"user",text:"从「"+title+"」选一道题，先不给答案。",selectionRequest:true},{role:"assistant",text:result.answer,selectedQuestionId:result.current_question?.id}];
  state.traces.review=result.events||[];$("#review-follow").value="";renderChat("review");renderTrace("review");
 }catch(error){notify(error.message,!error.cancelled,"review");}
 finally{state.operation=null;setBusy(false);updateReviewButtons();}
}
window.addEventListener("DOMContentLoaded",()=>{
 $("#toggle-review-catalog").addEventListener("click",()=>{reviewState.catalogOpen=!reviewState.catalogOpen;updateReviewLayout();});
 updateReviewLayout();
 $("#toggle-review-question").addEventListener("click",()=>{const body=$("#review-question-content");body.hidden=!body.hidden;$("#toggle-review-question").textContent=body.hidden?"展开题干":"收起题干";$("#toggle-review-question").setAttribute("aria-expanded",String(!body.hidden));});
 $("#start-review").addEventListener("click",startReviewSelection);
 $("#review-source").addEventListener("change",event=>{reviewState.selection.source=event.target.value;loadReviewCatalog();});
 $("#review-tree").addEventListener("keydown",event=>{
  if(!["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
  const buttons=[...$("#review-tree").querySelectorAll("button:not(.review-folder-toggle)")].filter(node=>node.getClientRects().length),current=event.target.closest("button"),index=buttons.indexOf(current);
  if(index<0)return;event.preventDefault();
  if(event.key==="Home")buttons[0]?.focus();else if(event.key==="End")buttons.at(-1)?.focus();
  else if(event.key==="ArrowDown")buttons[Math.min(index+1,buttons.length-1)]?.focus();
  else if(event.key==="ArrowUp")buttons[Math.max(index-1,0)]?.focus();
  else{const folder=current.closest(".review-folder"),toggle=folder?.querySelector(".review-folder-toggle");if(event.key==="ArrowRight"&&toggle?.getAttribute("aria-expanded")==="false") {toggle.click();[...$("#review-tree").querySelectorAll(".review-folder-label")].find(node=>node.dataset.reviewCategory===current.dataset.reviewCategory)?.focus({preventScroll:true});}else if(event.key==="ArrowLeft"){if(current.dataset.reviewTag!==undefined)folder.querySelector(".review-folder-label")?.focus();else if(toggle?.getAttribute("aria-expanded")==="true")toggle.click();}}
 });
 loadReviewCatalog();
});
