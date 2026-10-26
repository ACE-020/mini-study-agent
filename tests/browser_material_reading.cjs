const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.STUDY_QA_URL||'http://127.0.0.1:8766';
(async()=>{const browser=await chromium.launch({headless:true,channel:'chrome'});try{
 const page=await browser.newPage({viewport:{width:1366,height:960}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/#materials');await page.waitForFunction(()=>state.configured&&materialState.loaded);
 assert.equal((await page.locator('#clear-intake').textContent()).trim(),'清空本次上传');
 const help=page.locator('#material-read-help-button'),tip=page.locator('#material-read-help-text');
 await help.hover();await tip.waitFor({state:'visible'});assert.match(await tip.textContent(),/转文字和直接整理每批均最多20页/);
 await help.click();await page.mouse.move(1,1);assert.equal(await tip.isVisible(),true);
 await page.locator('#material-source').click();assert.equal(await tip.isVisible(),false);
 await help.focus();assert.equal(await tip.isVisible(),true);await page.keyboard.press('Escape');assert.equal(await tip.isVisible(),false);
 await page.locator('#material-file').setInputFiles('tmp/text-pages.pdf');
 let finish,mode='slow',requests=0;
 await page.route('**/api/materials/read',async route=>{
  requests++;
  if(mode==='slow'){await new Promise(resolve=>finish=resolve);await route.fulfill({json:{ok:true,text:'已提取的原稿文字：求 x² 的导数。',pages:[{},{}]}});}
  else if(mode==='error')await route.fulfill({status:400,json:{ok:false,error:'每批可读 20 页，请缩小页码范围。'}});
  else if(mode==='empty')await route.fulfill({json:{ok:true,text:'  ',pages:[]}});
  else if(mode==='cancel'){await new Promise(resolve=>finish=resolve);await route.fulfill({json:{ok:true,text:'停止后迟到的结果，不应覆盖原文。',pages:[{}]}});}
 });
 await page.locator('#read-material').click();
 await page.waitForFunction(()=>state.busy);
 await page.locator('#material-read-clock').getByText(/已等待 [1-9]/).waitFor();
 assert.equal(await page.locator('#material-read-spinner').isVisible(),true);
 assert.equal(await page.locator('#material-read-track').isVisible(),true);
 assert.equal(await page.locator('#stop-material-read').isVisible(),true);
 assert.equal(await page.locator('#material-text-loading').isVisible(),true);
 assert.equal(await page.locator('#material-text').getAttribute('aria-busy'),'true');
 assert.equal(await page.locator('#read-material').isDisabled(),true);
 assert.equal(await page.locator('#material-text').inputValue(),'');
 await page.screenshot({path:'tmp/material-reading-desktop.png',fullPage:false});
 finish();await page.waitForFunction(()=>!state.busy);
 assert.match(await page.locator('#material-text').inputValue(),/已提取/);
 assert.match(await page.locator('#material-read-title').textContent(),/2 页.*已填入文字框/);
 assert.equal(await page.locator('#material-read-spinner').isVisible(),false);
 assert.equal(await page.locator('#material-text-loading').isVisible(),false);
 assert.equal(await page.locator('#material-text').getAttribute('aria-busy'),'false');
 const original=await page.locator('#material-text').inputValue();
 mode='error';page.once('dialog',d=>d.accept());await page.locator('#read-material').click();await page.waitForFunction(()=>!state.busy);
 assert.match(await page.locator('#material-read-title').textContent(),/20 页/);
 assert.equal(await page.locator('#material-read-status').evaluate(e=>e.classList.contains('is-error')),true);
 assert.equal(await page.locator('#material-feedback').isVisible(),false);
 assert.equal(await page.locator('#material-text').inputValue(),original);
 mode='empty';page.once('dialog',d=>d.accept());await page.locator('#read-material').click();await page.waitForFunction(()=>!state.busy);
 assert.match(await page.locator('#material-read-title').textContent(),/没有提取到可用文字/);
 assert.equal(await page.locator('#material-text').inputValue(),original);
 mode='cancel';page.once('dialog',d=>d.accept());await page.locator('#read-material').click();await page.waitForFunction(()=>state.busy);
 await page.locator('#stop-material-read').click();await page.waitForFunction(()=>state.operation.stopping);
 finish();await page.waitForFunction(()=>!state.busy);
 assert.match(await page.locator('#material-read-title').textContent(),/已停止/);
 assert.equal(await page.locator('#material-text').inputValue(),original);
 assert.equal(requests,4);
 for(const width of [390,320]){await page.setViewportSize({width,height:844});await help.click();await tip.waitFor({state:'visible'});const box=await tip.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.keyboard.press('Escape');}
 assert.deepEqual(errors,[]);
 console.log('PASS: persistent timed spinner/indeterminate bar and in-editor loading, text completion, visible error and empty-result preservation, stop discards late text, help hover/click/keyboard/mobile fit, scoped clear label.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
