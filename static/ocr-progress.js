"use strict";
let localOcrProgressTimer=null;
function watchLocalOcrProgress(busy){
 clearTimeout(localOcrProgressTimer);localOcrProgressTimer=null;
 document.querySelectorAll(".local-ocr-progress").forEach(node=>node.remove());
 if(!busy||!state.localOcr||!state.operation)return;
 const operation=state.operation;
 const tick=async()=>{
  if(state.operation!==operation||!state.busy)return;
  try{
   const result=await api("/api/operation?request_id="+encodeURIComponent(operation.id));
   if(state.operation!==operation||operation.stopping)return;
   const progress=result.progress||{};
   if(progress.message){
    const count=progress.total?`（${Math.min((progress.completed||0)+1,progress.total)}/${progress.total} 页）`:"";
    const message=progress.message+count;
    operation.backendMessage=message;
    if(operation.type==="materials-read")materialReadFeedback("working",message);
    let selector=operation.type==="intake-read"?"#ocr-operation":operation.type==="chat"?`#${operation.view}-operation`:null;
    const bar=selector?$(selector):null;
    if(bar){let label=bar.querySelector(".local-ocr-progress");if(!label){label=make("small","local-ocr-progress");label.setAttribute("role","status");bar.append(label);}label.textContent=message;}
    if(operation.type==="materials-revise"){
     const form=$("#batch-ai-input")?.closest("form");
     if(form){let label=form.querySelector(".local-ocr-progress");if(!label){label=make("p","helper local-ocr-progress");label.setAttribute("role","status");form.prepend(label);}label.textContent=message;}
    }
   }
  }catch(error){/* Existing operation remains authoritative if polling is interrupted. */}
  if(state.operation===operation&&state.busy)localOcrProgressTimer=setTimeout(tick,1400);
 };
 tick();
}
