const assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{const browser=await chromium.launch({headless:true,channel:'chrome'});try{
 const page=await browser.newPage({viewport:{width:1600,height:1000}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.goto('http://127.0.0.1:8790/#materials');await page.waitForFunction(()=>state.configured&&materialState.loaded);
 const selector=page.locator('#materials-view [data-ocr-backend]');
 const allSelectors=page.locator('[data-ocr-backend]');
 assert.equal(await allSelectors.count(),2);
 const actualSelector=await selector.count()?selector:page.locator('[data-ocr-backend]').last();
 for(const backend of ['local','remote']){
  await actualSelector.selectOption(backend);
  await page.waitForFunction(b=>state.ocrBackend===b&&!state.ocrChoicePending,backend);
  assert.deepEqual(await allSelectors.evaluateAll(nodes=>nodes.map(n=>n.value)),[backend,backend]);
  await page.locator('#material-file').setInputFiles(process.env.STUDY_QA_PDF);
  await page.locator('#material-page-range').fill('32-33');
  await page.locator('#parse-material').click();
  await page.locator('#material-preview-panel').waitFor({state:'visible'});
  await page.waitForFunction(()=>materialState.preview.length===15);
  const summary=await page.evaluate(()=>({backend:materialState.currentJob.metadata.ocr_backend,
   located:materialState.preview.filter(i=>i.origin_regions?.some(r=>r.role==='question')).length,
   answers:materialState.preview.filter(i=>i.origin_regions?.some(r=>r.role==='answer')).length}));
  assert.deepEqual(summary,{backend,located:15,answers:15});
  await page.evaluate(()=>openBatchCorrection([8]));await page.waitForFunction(()=>!reviewReader.loading&&reviewReader.focusIndex===8);
  await page.locator('[data-origin-hit="8"][data-origin-role="question"].is-active').waitFor();
  assert.equal(await page.locator('#origin-page-select').inputValue(),'1');
  assert.equal(await page.locator('[data-origin-role="question"]').count(),10);
  await page.locator('[data-origin-hit="9"][data-origin-role="question"]').click();
  await page.waitForFunction(()=>reviewReader.focusIndex===9&&!reviewReader.loading);
  await page.evaluate(()=>navigateReviewExercise(8,{role:'answer'}));
  await page.waitForFunction(()=>reviewReader.focusRole==='answer'&&!reviewReader.loading);
  assert.equal(await page.locator('#origin-page-select').inputValue(),'2');
  await page.locator('[data-origin-hit="8"][data-origin-role="answer"].is-active').waitFor();
  await page.locator('[data-origin-hit="7"][data-origin-role="answer"]').click();
  await page.waitForFunction(()=>reviewReader.focusIndex===7&&!reviewReader.loading);
  assert.equal(await page.evaluate(()=>reviewReader.focusRole),'answer');
  if(backend==='local')await page.screenshot({path:require('node:path').join(require('node:os').tmpdir(),'study-ocr-choice-highlights.png')});
  await page.locator('#close-batch-ai').click();
  await page.locator('#material-back').click();
 }
 await page.reload();await page.waitForFunction(()=>state.ocrBackend==='remote');
 assert.deepEqual(errors,[]);console.log('Both choices: persisted selection; 15/15 question and answer regions; PDF question/answer bidirectional navigation passed.');
}finally{await browser.close();}})().catch(error=>{console.error(error);process.exit(1);});
