"use strict";
function jobSourceLabel(job){const files=job.metadata?.files||[];return files.length?files.map(file=>`${file.name}${/\.pdf$/i.test(file.name)?` · 页码：${file.page_range||"全部"}`:""}`).join("；"):(job.metadata?.page_range?`原填写页码：${job.metadata.page_range}`:"纯文字资料");}
function renderBatchProvenance(job){const box=$("#preview-batch-provenance");box.replaceChildren();box.append(make("span","",`第 ${job.metadata?.batch_number||"?"} 批 · ${new Date(job.created_at*1000).toLocaleString("zh-CN",{hour12:false})}`));for(const file of job.metadata?.files||[])box.append(make("span","",`${file.name}${/\.pdf$/i.test(file.name)?` · 页码（原填写）：${file.page_range||"全部"}`:""}`));if(!(job.metadata?.files||[]).length)box.append(make("span","",jobSourceLabel(job)));}
function closeBatchCorrection(){const dialog=$("#batch-ai-dialog");unmountReviewList();if(dialog.open)dialog.close();$("#material-review-layout").classList.remove("ai-open");}
function openBatchCorrection(indices=null,{role="question",intent="chat"}={}){
 if(state.busy||!materialState.preview.length)return;
 const signature=JSON.stringify([materialState.activeJob,indices]);
 if(materialState.aiScopeSignature!==signature){resetBatchAI();materialState.aiScopeSignature=signature;}
 materialState.aiIndices=indices;
 const item=indices?.length===1?materialState.preview[indices[0]]:null;
 $("#batch-ai-scope").textContent=item?`第 ${indices[0]+1} 题${item.number?` · 原题号 ${item.number}`:""}`:`本批 ${materialState.preview.length} 道题`;
 const selector=$("#batch-ai-page");selector.replaceChildren(make("option","","本批全部原页"));selector.firstChild.value="";
 for(const page of materialState.currentJob?.documents||[]){const option=make("option","",`${page.source}${page.page?` · 第 ${page.page} 页`:""}`);option.value=page.page_index;selector.append(option);}
 selector.firstChild.textContent=item?"本题原页及已知答案页":"本批全部原页";selector.value="";selector.disabled=!materialState.currentJob?.documents?.length;selector.title=selector.disabled?"本批没有保留原页，可在下方补充题目局部图。":"选择要参考的实际文件页";$("#show-batch-origin").disabled=selector.disabled;
 $("#review-save-feedback").hidden=true;const dialog=$("#batch-ai-dialog"),wasOpen=dialog.open;$("#material-review-layout").classList.add("ai-open");if(!wasOpen){mountReviewList();dialog.showModal();}
 $("#batch-ai-input").placeholder=item?"指出本题需要核对的位置，例如：请按原图恢复分段函数和根号范围…":"请指出需要核对的题号，或让 AI 根据原图检查本批识别疑点…";
 reviewReader.ignoreBrowseUntil=Date.now()+300;reviewReader.focusIndex=indices?.length===1?indices[0]:materialState.previewPage*materialState.pageSize;reviewReader.activeRegion=null;reviewReader.pendingRegion=null;reviewReader.focusRole=role;reviewReader.manualOrigin=false;restoreCorrectionChat();syncReviewFocus();setReviewBrowse(reviewReader.focusIndex,{follow:false});syncOriginForQuestion(!wasOpen);if(indices?.length===1)revealReviewQuestion(indices[0],role);if(typeof setCorrectionFocus==="function"){if(intent==="chat"||!wasOpen)setCorrectionFocus(intent==="chat");}else if(intent==="chat")$("#batch-ai-input").focus({preventScroll:true});
}
function showBatchOrigin(){if(matchMedia("(max-width:760px)").matches&&$("#batch-ai-dialog").classList.contains("mobile-origin"))hideOriginPane();else openOriginNavigator();}
window.addEventListener("DOMContentLoaded",()=>{
 $("#open-batch-ai").addEventListener("click",()=>openBatchCorrection());$("#fix-material-warnings").addEventListener("click",()=>openBatchCorrection());$("#close-batch-ai").addEventListener("click",closeBatchCorrection);$("#show-batch-origin").addEventListener("click",showBatchOrigin);$("#close-material-origin").addEventListener("click",hideOriginPane);
 const dialog=$("#batch-ai-dialog");dialog.addEventListener("close",()=>{if(!dialog.open){unmountReviewList();$("#material-review-layout").classList.remove("ai-open");}});
 dialog.addEventListener("cancel",event=>{event.preventDefault();if(state.busy)stopRequest();else if(dialog.classList.contains("mobile-origin"))hideOriginPane();else closeBatchCorrection();});
 let outside=false;const isOutside=event=>{const r=dialog.getBoundingClientRect();return event.target===dialog&&(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom);};dialog.addEventListener("pointerdown",e=>outside=isOutside(e));dialog.addEventListener("click",e=>{if(outside&&isOutside(e))closeBatchCorrection();outside=false;});
});

