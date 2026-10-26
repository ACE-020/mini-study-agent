"use strict";
// Move the existing list, rather than cloning editors or changing their field bindings.
const reviewReader={mount:null,job:null,page:null,key:null,positions:new Map(),loading:false};
function mountReviewList(){
 if(reviewReader.mount)return;
 const grid=$("#exercise-preview"),pager=$("#preview-pagination"),gridAnchor=document.createComment("review-list"),pagerAnchor=document.createComment("review-pagination");
 grid.before(gridAnchor);pager.before(pagerAnchor);
 reviewReader.mount={gridAnchor,pagerAnchor,scroll:grid.scrollTop,x:window.scrollX,y:window.scrollY};
 $("#review-list-port").append(grid);$("#review-pagination-port").append(pager);
 document.body.classList.add("review-is-open");
}
function unmountReviewList(){
 if(!reviewReader.mount)return;
 rememberOriginPosition();
 const saved=reviewReader.mount;reviewReader.mount=null;
 saved.gridAnchor.replaceWith($("#exercise-preview"));saved.pagerAnchor.replaceWith($("#preview-pagination"));
 $("#exercise-preview").scrollTop=saved.scroll;
 document.body.classList.remove("review-is-open");
 window.scrollTo(saved.x,saved.y);
}
function revealReviewQuestion(index,role="question"){
 requestAnimationFrame(()=>{if(!$("#batch-ai-dialog").open)return;const grid=$("#exercise-preview"),card=grid.querySelector('[data-preview-index="'+index+'"]'),target=role==="answer"?card?.querySelector(".preview-answer")||card:card;if(!target)return;const a=target.getBoundingClientRect(),b=grid.getBoundingClientRect();grid.scrollTop+=a.top-b.top-12;});
}
function syncReviewFocus(){
 $("#review-current-target").textContent=$("#batch-ai-scope").textContent;
 renderReviewIssueList($("#review-scope-warnings"));
 const details=$("#batch-ai-dialog .review-ai-reference");if(!materialState.aiIndices?.length)details.open=Boolean(materialState.warnings?.length);
}
function originDocuments(){return materialState.currentJob?.documents||[];}
function currentReviewItem(){return materialState.preview[reviewReader.focusIndex??materialState.aiIndices?.[0]]||null;}
function updateOriginToggle(){
 const shown=!$("#material-origin-dialog").hidden&&(!matchMedia("(max-width:760px)").matches||$("#batch-ai-dialog").classList.contains("mobile-origin"));
 $("#show-batch-origin").hidden=shown;$("#close-material-origin").hidden=!shown;
 $("#show-batch-origin").setAttribute("aria-expanded",String(shown));
 $("#close-material-origin").setAttribute("aria-expanded",String(shown));
}
function populateOriginPages(){
 const selector=$("#origin-page-select"),job=materialState.activeJob;
 if(reviewReader.job===job&&selector.options.length)return;
 rememberOriginPosition();reviewReader.job=job;reviewReader.page=null;reviewReader.key=null;
 selector.replaceChildren();
 for(const doc of originDocuments()){const option=make("option","",doc.source+(doc.page?" · 文件第 "+doc.page+" 页":""));option.value=doc.page_index;selector.append(option);}
}
function syncOriginForQuestion(initial=false){
 const docs=originDocuments(),item=currentReviewItem(),hasSource=Boolean(docs.length&&materialState.activeJob);
 $("#show-batch-origin").disabled=!hasSource;
 if(!hasSource){hideOriginPane();return;}
 populateOriginPages();
 const target=originTargetForRole(item,reviewReader.focusRole||"question");
 if(!reviewReader.holdSource&&(reviewReader.page===null||$("#origin-follow").checked)){const wanted=Number(target?.page_index||reviewReader.page||docs[0].page_index);if(docs.some(d=>d.page_index===wanted))$("#origin-page-select").value=wanted;}
 $("#origin-question-page").disabled=!docs.some(d=>d.page_index===Number(item?.page_index));
 $("#origin-answer-page").disabled=!docs.some(d=>d.page_index===originTargetForRole(item,"answer")?.page_index);
 $("#origin-answer-page").title=$("#origin-answer-page").disabled?"这道题尚未关联答案页，可用页码选择查看其他原页。":"查看已记录的答案原页";
 if(initial){$("#material-origin-dialog").hidden=false;$("#batch-ai-dialog").classList.add("has-origin");$("#batch-ai-dialog").classList.remove("mobile-origin");}
 updateOriginToggle();
 if(reviewReader.holdSource)return;
 if($("#origin-follow").checked&&target?.bbox)reviewReader.pendingRegion=target;
 renderOriginPage();
}
function openOriginNavigator(){
 if(!originDocuments().length||!materialState.activeJob)return;
 populateOriginPages();$("#material-origin-dialog").hidden=false;$("#batch-ai-dialog").classList.add("has-origin");$("#batch-ai-dialog").classList.toggle("mobile-origin",matchMedia("(max-width:760px)").matches);updateOriginToggle();
 reviewReader.ignoreBrowseUntil=Date.now()+300;revealReviewQuestion(reviewReader.focusIndex,reviewReader.focusRole);
 renderOriginPage();
}
function hideOriginPane(){
 rememberOriginPosition();$("#material-origin-dialog").hidden=true;$("#batch-ai-dialog").classList.remove("has-origin","mobile-origin");updateOriginToggle();
 reviewReader.ignoreBrowseUntil=Date.now()+300;revealReviewQuestion(reviewReader.focusIndex,reviewReader.focusRole);
}
function rememberOriginPosition(){
 if(reviewReader.key&&!reviewReader.loading){const box=$("#material-origin-scroll");reviewReader.positions.set(reviewReader.key,{top:box.scrollTop,left:box.scrollLeft});if(reviewReader.positions.size>300)reviewReader.positions.delete(reviewReader.positions.keys().next().value);}
}
function renderOriginPage(){
 const docs=originDocuments(),index=Number($("#origin-page-select").value),position=docs.findIndex(d=>d.page_index===index),doc=docs[position];if(!doc)return;
 rememberOriginPosition();
 const key=materialState.activeJob+":"+index,saved={...(reviewReader.positions.get(key)||{top:0,left:0})};
 reviewReader.page=index;reviewReader.key=key;reviewReader.loading=true;
 $("#material-origin-caption").textContent=doc.source+(doc.page?" · 文件第 "+doc.page+" 页":"");
 $("#origin-previous").disabled=position===0;$("#origin-next").disabled=position===docs.length-1;
 const img=$("#material-origin-image"),url="/api/materials/jobs/"+encodeURIComponent(materialState.activeJob)+"/pages/"+index,error=$("#origin-image-error");
 img.hidden=false;error.hidden=true;$("#origin-page-canvas").style.width=$("#origin-zoom").value+"%";
 const restore=()=>{if(reviewReader.key!==key)return;requestAnimationFrame(()=>{if(reviewReader.key!==key)return;const box=$("#material-origin-scroll");box.scrollTop=saved.top;box.scrollLeft=saved.left;reviewReader.loading=false;renderOriginHitAreas();applyPendingOriginRegion();});};
 img.onload=restore;img.onerror=()=>{if(reviewReader.key!==key)return;reviewReader.loading=false;img.hidden=true;error.hidden=false;error.textContent="原页未能加载，任务可能已移除或服务已重启。请返回任务确认，必要时重新选择原文件。";};
 if(img.getAttribute("src")!==url)img.src=url;else if(img.complete&&img.naturalWidth)restore();else if(img.complete)img.src=url;
}
function selectOriginPage(value){
 const select=$("#origin-page-select");if(![...select.options].some(o=>Number(o.value)===Number(value)))return;
 select.value=value;renderOriginPage();
}
window.addEventListener("DOMContentLoaded",()=>{
 const browsePage=()=>{reviewReader.manualOrigin=true;reviewReader.pendingRegion=null;const regions=exerciseRegions(currentReviewItem()).filter(r=>r.page_index===Number($("#origin-page-select").value));if(regions.length&&regions.every(r=>r.role==="answer"))reviewReader.focusRole="answer";renderOriginPage();};
 $("#origin-page-select").onchange=browsePage;
 for(const [id,step] of [["origin-previous",-1],["origin-next",1]])$("#"+id).onclick=()=>{const select=$("#origin-page-select"),next=select.selectedIndex+step;if(next>=0&&next<select.options.length){select.selectedIndex=next;browsePage();}};
 $("#origin-question-page").onclick=()=>jumpOriginForRole("question");
 $("#origin-answer-page").onclick=()=>jumpOriginForRole("answer");
 $("#origin-follow").onchange=()=>{if($("#origin-follow").checked){reviewReader.manualOrigin=false;syncOriginForQuestion();}};
 window.addEventListener("resize",updateOriginToggle);
 $("#material-origin-scroll").addEventListener("scroll",rememberOriginPosition,{passive:true});
 let zoom=100;
 $("#origin-zoom").onchange=()=>{const box=$("#material-origin-scroll"),scale=Number($("#origin-zoom").value),ratio=scale/zoom,top=(box.scrollTop+box.clientHeight/2)*ratio-box.clientHeight/2,left=(box.scrollLeft+box.clientWidth/2)*ratio-box.clientWidth/2;$("#origin-page-canvas").style.width=scale+"%";box.scrollTop=Math.max(0,top);box.scrollLeft=Math.max(0,left);zoom=scale;rememberOriginPosition();};
 initReviewSplitters();
});

function initReviewSplitters(){
 const dialog=$("#batch-ai-dialog"),left=$(".review-left"),widthHandle=$("#review-divider"),heightHandle=$("#review-height-divider");
 const storage="study-review-split-v1",defaults={width:46,height:58};
 let preferences={...defaults},dragging=null;
 try{const saved=JSON.parse(localStorage.getItem(storage)||"{}");for(const key of Object.keys(defaults))if(Number.isFinite(saved[key]))preferences[key]=saved[key];}catch{}
 const persist=()=>{try{localStorage.setItem(storage,JSON.stringify(preferences));}catch{}};
 function bounds(axis){
  if(axis==="width")return [35,62];
  const height=left.getBoundingClientRect().height;
  if(!height)return [20,80];
  const usable=height-heightHandle.getBoundingClientRect().height;
  return [Math.min(220,usable*.42)/height*100,(usable-Math.min(230,usable*.42))/height*100];
 }
 function apply(axis,value,save=false){
  const [min,max]=bounds(axis),actual=Math.max(min,Math.min(max,value)),handle=axis==="width"?widthHandle:heightHandle;
  dialog.style.setProperty(axis==="width"?"--review-left":"--review-top",actual+"%");
  handle.setAttribute("aria-valuemin",Math.round(min));handle.setAttribute("aria-valuemax",Math.round(max));handle.setAttribute("aria-valuenow",Math.round(actual));
  handle.setAttribute("aria-valuetext",axis==="width"?"题目侧宽度 "+Math.round(actual)+"%":"题目区高度 "+Math.round(actual)+"%");
  if(save){preferences[axis]=actual;persist();}
 }
 for(const [handle,axis] of [[widthHandle,"width"],[heightHandle,"height"]]){
  handle.addEventListener("pointerdown",event=>{
   if(event.button!==0)return;
   dragging={handle,axis};handle.setPointerCapture(event.pointerId);handle.classList.add("is-dragging");dialog.classList.add("is-resizing");reviewReader.ignoreBrowseUntil=Infinity;event.preventDefault();
  });
  handle.addEventListener("pointermove",event=>{
   if(dragging?.handle!==handle)return;
   const rect=(axis==="width"?$(".review-workspace-content"):left).getBoundingClientRect();
   apply(axis,axis==="width"?(event.clientX-rect.left)/rect.width*100:(event.clientY-rect.top-9)/rect.height*100,true);
  });
  const finish=()=>{if(dragging?.handle!==handle)return;dragging=null;handle.classList.remove("is-dragging");dialog.classList.remove("is-resizing");reviewReader.ignoreBrowseUntil=Date.now()+300;};
  for(const event of ["pointerup","pointercancel","lostpointercapture"])handle.addEventListener(event,finish);
  handle.addEventListener("keydown",event=>{
   const minus=axis==="width"?"ArrowLeft":"ArrowUp",plus=axis==="width"?"ArrowRight":"ArrowDown";
   if(![minus,plus,"Home","End","Enter"].includes(event.key))return;
   event.preventDefault();reviewReader.ignoreBrowseUntil=Date.now()+300;
   const [min,max]=bounds(axis),current=parseFloat(dialog.style.getPropertyValue(axis==="width"?"--review-left":"--review-top"))||defaults[axis];
   apply(axis,event.key==="Home"?min:event.key==="End"?max:event.key==="Enter"?defaults[axis]:current+(event.key===minus?-2:2),true);
  });
  handle.addEventListener("dblclick",()=>{reviewReader.ignoreBrowseUntil=Date.now()+300;apply(axis,defaults[axis],true);});
 }
 apply("width",preferences.width);
 new ResizeObserver(()=>{if(!dragging&&left.getBoundingClientRect().height)apply("height",preferences.height);}).observe(left);
}
