"use strict";
function originalNumber(value){return String(value||"").replace(/\s/g,"").replace(/[．.]/g,"、").replace(/[、]+$/,"");}
function briefPaper(value){const match=String(value||"").match(/^(?:第\s*)?(\d+)\s*(?:套|组|[\[【])/);return match?"试卷 "+match[1]:value||"未标明试卷";}
function exerciseLocationLabel(item,index){
 const doc=originDocuments().find(d=>d.page_index===item?.page_index);
 return [briefPaper(item?.paper),item?.number?"原题 "+item.number:"原题号待核对",doc?.page?"文件第 "+doc.page+" 页":"",index!==undefined?"本批 "+(index+1):""].filter(Boolean).join(" · ");
}
const reviewRegionIndex={documents:null,values:new Map()};
function exerciseRegions(item){
 if(!item)return[];
 const docs=originDocuments();
 if(reviewRegionIndex.documents!==docs){
  reviewRegionIndex.documents=docs;reviewRegionIndex.values=new Map();
  for(const doc of docs)for(const a of doc.layout?.anchors||[]){
   const key=doc.source+"\0"+a.paper+"\0"+originalNumber(a.number),regions=reviewRegionIndex.values.get(key)||[];
   regions.push({page_index:doc.page_index,bbox:a.bbox,role:a.role});reviewRegionIndex.values.set(key,regions);
  }
 }
 const regions=[...(item.origin_regions||[])];
 const source=docs.find(d=>d.page_index===item.page_index)?.source||"";
 for(const r of reviewRegionIndex.values.get(source+"\0"+item.paper+"\0"+originalNumber(item.number))||[]){
   if(!regions.some(v=>v.page_index===r.page_index&&v.role===r.role&&JSON.stringify(v.bbox)===JSON.stringify(r.bbox)))regions.push(r);
 }
 return regions.filter(r=>Array.isArray(r.bbox)&&r.bbox.length===4&&r.bbox.every(v=>Number.isFinite(v)&&v>=0&&v<=1)&&r.bbox[2]>r.bbox[0]&&r.bbox[3]>r.bbox[1]);
}
function cleanIssueMessage(value){return String(value).replace(/^.*?[（(]第\s*\d+\s*\/\s*\d+\s*段[）)][:：]\s*/,"").replace(/page_index\s*[:=]?\s*\d+/gi,"").replace(/[（(]?第\s*\d+\s*\/\s*\d+\s*段[）)]?[:：]?/g,"").replace(/题组\s*(\d+)/g,(all,code)=>materialState.preview.some(item=>briefPaper(item.paper)==="试卷 "+code)?"试卷 "+code:all);}
function legacyReviewIssue(message){
 const page=message.match(/第\s*(\d+)\s*页/),number=message.match(/([一二三四五六七八九十]+)\s*[、.．]\s*(\d+)/),code=message.match(/(?:题组|试卷)\s*(\d+)|第\s*(\d+)\s*套/);
 const docs=page?originDocuments().filter(d=>d.page===Number(page[1])):[],doc=docs.length===1?docs[0]:null;
 let candidates=materialState.preview.map((item,i)=>({item,i}));
 if(doc)candidates=candidates.filter(v=>v.item.page_index===doc.page_index||v.item.answer_page_indices?.includes(doc.page_index));
 if(number)candidates=candidates.filter(v=>originalNumber(v.item.number)===number[1]+"、"+number[2]);
 if(code)candidates=candidates.filter(v=>briefPaper(v.item.paper)==="试卷 "+(code[1]||code[2]));
 if(!doc&&!number&&!code)candidates=[];
 return {message,exercise_indices:candidates.map(v=>v.i),page_index:doc?.page_index};
}
// Display preferences only: hiding never removes an issue from the AI context or job result.
const reviewIssueHistory=new Map();
const reviewIssueStorage="study-review-hidden-issues-v1";
function reviewIssueKeys(){
 const seen=new Map();
 return (materialState.issues||[]).map(issue=>{
  const identity=JSON.stringify([issue.kind||"",issue.message,issue.page_index??null,issue.paper||"",issue.number||""]);
  const occurrence=seen.get(identity)||0;seen.set(identity,occurrence+1);
  return identity+":"+occurrence;
 });
}
function reviewHiddenIssues(){
 const job=materialState.activeJob||"draft";
 if(!reviewIssueHistory.has(job)){
  let saved=[];
  try{const value=JSON.parse(sessionStorage.getItem(reviewIssueStorage)||"[]").find(item=>item.job===job);if(Array.isArray(value?.hidden))saved=value.hidden.filter(key=>typeof key==="string");}catch{}
  reviewIssueHistory.set(job,saved);
 }
 return reviewIssueHistory.get(job);
}
function saveReviewHiddenIssues(){
 try{
  const job=materialState.activeJob;if(!job)return;
  const saved=JSON.parse(sessionStorage.getItem(reviewIssueStorage)||"[]").filter(item=>item.job!==job);
  saved.push({job,hidden:reviewHiddenIssues()});
  sessionStorage.setItem(reviewIssueStorage,JSON.stringify(saved.slice(-20)));
 }catch{} // Storage-disabled browsers still retain preferences while this page stays open.
}
function refreshReviewIssueLists(){
 document.querySelectorAll(".review-warning-list, #review-scope-warnings").forEach(renderReviewIssueList);
 const count=(materialState.issues||[]).length,keys=new Set(reviewIssueKeys()),hidden=reviewHiddenIssues().filter(key=>keys.has(key)).length;
 $("#material-warnings").querySelector("summary").textContent="查看 "+(count-hidden)+" 条识别疑点"+(hidden?" · 已隐藏 "+hidden+" 条":"");
}
function changeReviewIssueVisibility(key){
 const hidden=reviewHiddenIssues(),keys=new Set(reviewIssueKeys());
 if(key){if(!hidden.includes(key))hidden.push(key);}
 else{while(hidden.length){const last=hidden.pop();if(keys.has(last))break;}}
 saveReviewHiddenIssues();refreshReviewIssueLists();
}
function renderReviewIssueList(container){
 container.replaceChildren();
 const issues=materialState.issues||[],keys=reviewIssueKeys(),hidden=new Set(reviewHiddenIssues()),hiddenCount=keys.filter(key=>hidden.has(key)).length;
 if(!issues.length)return;
 const toolbar=make("div","review-issues-toolbar"),count=make("span","",hiddenCount===issues.length?"本批提示已全部隐藏":"待核对 "+(issues.length-hiddenCount)+" 条");
 toolbar.append(count);
 if(hiddenCount){const restore=make("button","issue-restore-button","显示上一条（"+hiddenCount+"）");restore.type="button";restore.dataset.issueRestore="";restore.title="每次恢复最近隐藏的一条提示，回到原来的位置";restore.addEventListener("click",()=>{const key=[...reviewHiddenIssues()].reverse().find(value=>keys.includes(value));changeReviewIssueVisibility();const target=[...container.querySelectorAll("[data-issue-key]")].find(row=>row.dataset.issueKey===key);target?.querySelector("[data-issue-hide]")?.focus({preventScroll:true});target?.scrollIntoView({block:"nearest"});});toolbar.append(restore);}
 container.append(toolbar);
 issues.forEach((issue,position)=>{
  if(hidden.has(keys[position]))return;
  const row=make("div","review-issue"),indices=(issue.exercise_indices||[]).filter(i=>Number.isInteger(i)&&materialState.preview[i]);
  row.dataset.issueKey=keys[position];
  const heading=make("div","review-issue-heading"),locations=make("div","review-issue-locations");
  const doc=originDocuments().find(d=>d.page_index===issue.page_index);
  if(indices.length||doc){
   for(const index of indices.length?indices:[null]){
   const item=index===null?null:materialState.preview[index],page=issue.kind==="answer_missing"?item?.answer_page_indices?.[0]||item?.page_index:issue.page_index;
   const button=make("button","issue-location-link",item?exerciseLocationLabel(item):"文件第 "+(doc.page||"?")+" 页 · 具体题号待确认");
   button.type="button";button.dataset.issueNavigate="";button.disabled=state.busy;
   button.addEventListener("click",()=>item?navigateReviewExercise(index,{pageIndex:page}):selectOriginPage(doc.page_index));
   locations.append(button);
   }
  }else locations.append(make("span","issue-unlocated","具体位置待确认"));
  const hide=make("button","issue-hide-button","隐藏");hide.type="button";hide.dataset.issueHide="";hide.title="隐藏此提示，可通过“显示上一条”恢复";
  hide.addEventListener("click",()=>{const nextKey=keys.slice(position+1).find(key=>!hidden.has(key));changeReviewIssueVisibility(keys[position]);const next=[...container.querySelectorAll("[data-issue-key]")].find(item=>item.dataset.issueKey===nextKey);(next?.querySelector("[data-issue-hide]")||container.querySelector("[data-issue-restore]"))?.focus({preventScroll:true});});
  heading.append(locations,hide);row.append(heading);
  const body=make("div","record-body");exerciseRich(body,cleanIssueMessage(issue.message));row.append(body);container.append(row);
 });
}
function renderReviewWarnings(warnings=[],issues=null){
 materialState.warnings=warnings;
 materialState.issues=Array.isArray(issues)&&issues.length?issues:warnings.map(legacyReviewIssue);
 const box=$("#material-warnings"),list=box.querySelector("ul");list.replaceChildren();
 // Same actionable issues in the main preview and in the correction workspace.
 const content=make("li","review-warning-list");list.append(content);
 box.hidden=!materialState.issues.length;box.open=false;refreshReviewIssueLists();
}
function originTargetForRole(item,role){
 if(!item)return null;
 const regions=exerciseRegions(item).filter(r=>r.role===role),region=regions.find(r=>r.page_index===reviewReader.page)||regions[0];
 if(region)return region;
 const pages=role==="answer"?item.answer_page_indices||[]:[item.page_index];
 const page=pages.includes(reviewReader.page)?reviewReader.page:pages[0];
 return page?{page_index:page,role}:null;
}
function setReviewBrowse(index,{follow=true,role=null,passive=false}={}){
 const item=materialState.preview[index];if(!item)return;
 const nextRole=role||(reviewReader.focusIndex===index?reviewReader.focusRole:"question")||"question";
 if(reviewReader.focusIndex!==index||reviewReader.focusRole!==nextRole){reviewReader.activeRegion=null;reviewReader.pendingRegion=null;}
 if(!passive)reviewReader.manualOrigin=false;
 reviewReader.focusRole=nextRole;
 reviewReader.focusIndex=index;
 $("#review-browse-location").textContent=exerciseLocationLabel(item,index)+(nextRole==="answer"?" · 参考答案":"");
 $("#review-browse-location").title=item.paper||"";
 document.querySelectorAll("[data-preview-index]").forEach(card=>card.classList.toggle("is-browsing",Number(card.dataset.previewIndex)===index));
 if(follow&&$("#origin-follow").checked&&!reviewReader.holdSource&&!(passive&&reviewReader.manualOrigin))syncOriginForQuestion();
 else renderOriginHitAreas();
}
function navigateReviewExercise(index,{pageIndex=null,region=null,keepSource=false,role:requestedRole=null}={}){
 if(state.busy||!materialState.preview[index])return;
 reviewReader.ignoreBrowseUntil=Date.now()+300;
 const page=Math.floor(index/materialState.pageSize);
 if(materialState.previewPage!==page){materialState.previewPage=page;renderExercisePreview(materialState.preview,true);}
 const role=requestedRole||region?.role||(pageIndex&&materialState.preview[index].answer_page_indices?.includes(pageIndex)&&pageIndex!==materialState.preview[index].page_index?"answer":"question");
 reviewReader.holdSource=keepSource||Boolean(pageIndex);
 openBatchCorrection([index],{role,intent:"read"});
 reviewReader.holdSource=false;
 setReviewBrowse(index,{follow:!keepSource&&!pageIndex,role});
 if(pageIndex){
  const selected=region||exerciseRegions(materialState.preview[index]).find(r=>r.page_index===pageIndex&&r.role===role);
  if(selected)reviewReader.pendingRegion=selected;
  $("#material-origin-dialog").hidden=false;$("#batch-ai-dialog").classList.add("has-origin");
  updateOriginToggle();
  selectOriginPage(pageIndex);
 }
 if(keepSource&&region){reviewReader.activeRegion=region;renderOriginHitAreas();}
 if(role==="answer"){const answer=$('[data-preview-index="'+index+'"] .preview-answer');if(answer)answer.open=true;}
 revealReviewQuestion(index,role);
}
function visibleReviewTarget(){
 const grid=$("#exercise-preview"),r=grid.getBoundingClientRect(),cards=[...grid.querySelectorAll("[data-preview-index]")];
 const visible=cards.filter(c=>{const b=c.getBoundingClientRect();return b.bottom>r.top+25&&b.top<r.bottom-12;});
 const line=r.top+Math.min(60,r.height*.25);
 const contains=visible.filter(c=>{const b=c.getBoundingClientRect();return b.top<=line&&b.bottom>line;});
 const current=contains.find(c=>Number(c.dataset.previewIndex)===reviewReader.focusIndex);
 visible.sort((a,b)=>Math.abs(a.getBoundingClientRect().top-r.top)-Math.abs(b.getBoundingClientRect().top-r.top));
 const card=current||contains[0]||visible[0];if(!card)return null;
 const answer=card.querySelector(".preview-answer[open]"),bounds=answer?.getBoundingClientRect();
 return {index:Number(card.dataset.previewIndex),role:bounds&&bounds.top<=line&&bounds.bottom>line?"answer":"question"};
}
function reviewListRendered(){
 if(!$("#batch-ai-dialog").open)return;
 document.querySelectorAll("[data-preview-index]").forEach(card=>card.classList.toggle("is-correcting",materialState.aiIndices?.includes(Number(card.dataset.previewIndex))||false));
 if(Date.now()<(reviewReader.ignoreBrowseUntil||0))return;
 const start=materialState.previewPage*materialState.pageSize,index=reviewReader.focusIndex>=start&&reviewReader.focusIndex<start+materialState.pageSize?reviewReader.focusIndex:start;setReviewBrowse(index,{passive:true});
}
function renderOriginHitAreas(){
 const layer=$("#origin-hit-layer");if(!layer)return;
 layer.replaceChildren();
 const page=Number($("#origin-page-select").value);
 let count=0;
 materialState.preview.forEach((item,index)=>{for(const region of exerciseRegions(item).filter(r=>r.page_index===page)){
  const button=make("button","origin-question-hit");button.type="button";button.dataset.originHit=String(index);button.dataset.originRole=region.role;button.disabled=state.busy;
  button.setAttribute("aria-label",exerciseLocationLabel(item,index)+(region.role==="answer"?" · 参考答案":" · 题干"));
  button.title=button.getAttribute("aria-label");
  const [x0,y0,x1,y1]=region.bbox;
  Object.assign(button.style,{left:x0*100+"%",top:y0*100+"%",width:(x1-x0)*100+"%",height:(y1-y0)*100+"%"});
  const active=index===reviewReader.focusIndex&&region.role===(reviewReader.focusRole||"question")&&(!reviewReader.activeRegion||reviewReader.activeRegion.page_index===page&&reviewReader.activeRegion.role===region.role);
  button.classList.toggle("is-active",active);button.append(make("span","origin-hit-label",(region.role==="answer"?"答案 · ":"")+(item.number||"本题")));
  button.addEventListener("click",()=>navigateReviewExercise(index,{pageIndex:page,region,keepSource:true}));
  layer.append(button);count++;
 }});
 $("#origin-hit-status").textContent=count?"点击原页中的题目或答案，可定位左侧对应题目":"这页暂无可靠题目坐标，可按题号核对";
}
function applyPendingOriginRegion(){
 const region=reviewReader.pendingRegion;if(!region||region.page_index!==reviewReader.page)return;
 reviewReader.pendingRegion=null;reviewReader.activeRegion=region;
 const img=$("#material-origin-image"),box=$("#material-origin-scroll");
 const width=img.clientWidth,height=img.clientHeight;
 box.scrollTop=Math.max(0,region.bbox[1]*height-28);
 box.scrollLeft=Math.max(0,region.bbox[0]*width-20);
 rememberOriginPosition();renderOriginHitAreas();
}
function jumpOriginForRole(role){
 const item=currentReviewItem(),target=originTargetForRole(item,role);
 reviewReader.focusRole=role;reviewReader.manualOrigin=false;reviewReader.activeRegion=null;reviewReader.pendingRegion=target?.bbox?target:null;
 if(target){
  $("#material-origin-dialog").hidden=false;$("#batch-ai-dialog").classList.add("has-origin");
  if(matchMedia("(max-width:760px)").matches)$("#batch-ai-dialog").classList.add("mobile-origin");
  updateOriginToggle();selectOriginPage(target.page_index);
 }
}
window.addEventListener("DOMContentLoaded",()=>{
 let timer=null;
 const refreshBrowse=()=>{
  if(!$("#batch-ai-dialog").open)return;
  const delay=(reviewReader.ignoreBrowseUntil||0)-Date.now();
  if(delay>0){timer=setTimeout(refreshBrowse,delay+5);return;}
  const target=visibleReviewTarget();if(target&&(target.index!==reviewReader.focusIndex||target.role==="answer"&&reviewReader.focusRole!=="answer"))setReviewBrowse(target.index,{role:target.role,passive:true});
 };
 $("#exercise-preview").addEventListener("scroll",()=>{
  clearTimeout(timer);timer=setTimeout(refreshBrowse,90);
 },{passive:true});
 $("#exercise-preview").addEventListener("click",event=>{
  const answer=event.target.closest(".preview-answer"),card=event.target.closest("[data-preview-index]");
  if(answer&&card&&!event.target.closest("button,input,textarea,select,a")){
   const index=Number(card.dataset.previewIndex);
   if($("#batch-ai-dialog").open){
    const opening=event.target.closest("summary")&&!answer.open;
    setReviewBrowse(index,{follow:false,role:"answer"});jumpOriginForRole("answer");
    if(opening){reviewReader.ignoreBrowseUntil=Date.now()+300;revealReviewQuestion(index,"answer");}
   }else{
    event.preventDefault();
    const target=originTargetForRole(materialState.preview[index],"answer");
    navigateReviewExercise(index,{role:"answer",pageIndex:target?.page_index,region:target?.bbox?target:null});
   }
   return;
  }
  if(event.target.closest("button,input,textarea,select,summary,label"))return;
  if(card)setReviewBrowse(Number(card.dataset.previewIndex),{role:"question"});
 });
});
