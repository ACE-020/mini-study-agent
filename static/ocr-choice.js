"use strict";
function syncOcrChoice(status){
 state.ocrBackend=status.ocr_backend;state.localOcrAvailable=Boolean(status.local_ocr_available);
 document.querySelectorAll("[data-ocr-backend]").forEach(select=>{
  select.value=status.ocr_backend;
  select.querySelector('[value="local"]').disabled=!status.local_ocr_available;
  select.disabled=state.busy||Boolean(state.ocrChoicePending);
 });
}
window.addEventListener("DOMContentLoaded",()=>{
 document.querySelectorAll("[data-ocr-backend]").forEach(select=>select.addEventListener("change",async()=>{
  const feedback=select.closest(".ocr-choice").querySelector(".ocr-choice-feedback");
  const choice=select.value;state.ocrChoicePending=true;
  document.querySelectorAll("[data-ocr-backend]").forEach(node=>node.disabled=true);
  feedback.textContent="正在切换…";
  try{
   await api("/api/ocr/backend",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({backend:choice})});
   await refreshStatus();feedback.textContent=choice==="local"?"已切换到本机 GLM":"已切换到云端识图";
  }catch(error){select.value=state.ocrBackend;feedback.textContent=error.message;}
  finally{state.ocrChoicePending=false;document.querySelectorAll("[data-ocr-backend]").forEach(node=>node.disabled=state.busy);}
 }));
});
