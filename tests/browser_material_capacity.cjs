const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.STUDY_QA_URL||'http://127.0.0.1:8766';
(async()=>{const browser=await chromium.launch({headless:true,channel:'chrome'});try{
 const page=await browser.newPage({viewport:{width:1366,height:960}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/#materials');await page.waitForFunction(()=>state.configured&&materialState.loaded);
 const next=await page.evaluate(()=>[
   nextFileRange({metadata:{files:[{total_pages:598,pages:[16,17,18,19,20]}]}}),
   nextFileRange({metadata:{files:[{total_pages:598,pages:[580,581,582,583]}]}}),
   nextFileRange({metadata:{files:[{total_pages:598,pages:[598]}]}})
 ]);
 assert.deepEqual(next,['21-40','584-598','']);
 assert.equal(await page.locator('#parse-material').getAttribute('data-max-pages'),'20');
 await page.locator('#material-file').setInputFiles('tmp/text-pages.pdf');
 await page.locator('#material-source').fill('容量验收');await page.locator('#material-text').fill('保留这段补充');
 let requests=0,finish;
 await page.route('**/api/materials/jobs',async route=>{
  if(route.request().method()!=='POST')return route.continue();
  requests++;await new Promise(resolve=>finish=resolve);
  await route.fulfill({status:400,json:{ok:false,error:'本次准备失败，请重试。'}});
 });
 await page.locator('#material-page-range').fill('21-120');await page.locator('#parse-material').click();
 assert.equal(requests,0);assert.match(await page.locator('#material-submit-title').textContent(),/20 页/);
 assert.equal(await page.locator('#material-feedback').isVisible(),false);
 await page.locator('#material-page-range').fill('21-40');
 assert.equal(await page.locator('#material-submit-status').isVisible(),false);
 await page.locator('#parse-material').click();await page.waitForFunction(()=>materialState.submitting);
 await page.locator('#material-submit-clock').getByText(/已等待 [1-9]/).waitFor();
 assert.equal(await page.locator('#material-submit-spinner').isVisible(),true);
 assert.equal(await page.locator('#material-submit-track').isVisible(),true);
 for(const id of ['parse-material','read-material','material-file'])assert.equal(await page.locator('#'+id).isDisabled(),true);
 assert.equal(await page.locator('#material-page-range').getAttribute('readonly'),'');
 await page.screenshot({path:'tmp/material-submit-working.png'});
 finish();await page.waitForFunction(()=>!materialState.submitting);
 assert.equal(requests,1);assert.match(await page.locator('#material-submit-title').textContent(),/准备失败.*已保留/);
 assert.equal(await page.locator('#material-feedback').isVisible(),false);
 assert.equal(await page.locator('#material-text').inputValue(),'保留这段补充');
 assert.equal(await page.locator('#material-page-range').inputValue(),'21-40');
 assert.equal(await page.locator('#material-file').evaluate(e=>e.files[0].name),'text-pages.pdf');
 const status=await page.locator('#material-submit-status').boundingBox(),button=await page.locator('#parse-material').boundingBox();
 assert.ok(button.y-status.y-status.height<75,'error should be immediately above submit area');
 await page.screenshot({path:'tmp/material-submit-error.png'});
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.locator('#parse-material').scrollIntoViewIfNeeded();await page.screenshot({path:'tmp/material-submit-error-mobile.png'});
 await page.unroute('**/api/materials/jobs');await page.setViewportSize({width:1366,height:960});
 await page.locator('#material-page-range').fill('1-2');await page.locator('#material-text').fill('');
 await page.locator('#parse-material').click();await page.locator('#material-preview-panel').waitFor({state:'visible'});
 assert.equal(await page.locator('#material-submit-status').isVisible(),false);
 // The real continuation action also keeps the original browser File and fills only twenty pages.
 await page.evaluate(()=>{materialState.currentJob.metadata.files[0].pages=[16,17,18,19,20];materialState.currentJob.metadata.files[0].total_pages=598;});
 await page.locator('[data-preview-index="1"] [data-field="included"]').uncheck();
 await page.locator('#confirm-exercises').click();await page.locator('#material-import-summary').waitFor({state:'visible'});
 page.once('dialog',d=>d.accept());await page.locator('#import-more-materials').click();
 assert.equal(await page.locator('#material-page-range').inputValue(),'21-40');
 assert.equal(await page.locator('#material-file').evaluate(e=>e.files[0].name),'text-pages.pdf');
 assert.match(await page.locator('#material-submit-title').textContent(),/21-40/);
 assert.deepEqual(errors,[]);
 console.log('PASS: twenty-page continuation, over-limit rejected before upload, sustained preparation feedback, local retry error and draft retention, mobile layout, successful retry.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
