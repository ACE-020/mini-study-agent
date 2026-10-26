const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.STUDY_QA_URL||'http://127.0.0.1:8766';
(async()=>{const browser=await chromium.launch({headless:true,channel:'chrome'});try{
 const page=await browser.newPage({viewport:{width:1440,height:1000},hasTouch:true}),errors=[],calls=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('request',r=>{if(r.url().endsWith('/api/materials/revise'))calls.push(r);});
 await page.goto(base+'/#materials');await page.waitForFunction(()=>state.configured&&materialState.loaded);
 await page.locator('#material-file').setInputFiles('tmp/text-pages.pdf');await page.locator('#material-page-range').fill('1-2');await page.locator('#parse-material').click();await page.locator('#material-preview-panel').waitFor({state:'visible'});
 const job=await page.evaluate(()=>materialState.activeJob);
 async function fixture(identity=job,addNew=false){await page.evaluate(({identity,addNew})=>{
  materialState.activeJob=identity;
  const items=Array.from({length:32},(_,i)=>({number:'一、'+(i+1),paper:'3 [数学] 核对测试试卷',topic:'极限',question:'计算 $\\lim_{x\\to0}\\frac{\\sin x}{x}$，并说明依据。',answer:'$1$',page_index:i%2+1,answer_page_indices:[2]}));
  const issues=['根号范围需要核对','参考答案需要核对','指数位置需要核对'].map((message,i)=>({kind:'recognition',message,page_index:i%2+1,exercise_indices:[i],paper:items[i].paper,number:items[i].number}));
  if(addNew)issues.unshift({kind:'recognition',message:'重试后新发现的疑点',page_index:1,exercise_indices:[0]});
  renderExercisePreview(items);renderMaterialWarnings(issues.map(i=>i.message),issues);
 },{identity,addNew});}
 await fixture();await page.locator('#fix-material-warnings').click();await page.waitForFunction(()=>!reviewReader.loading);
 const scope=page.locator('#review-scope-warnings'),main=page.locator('#material-warnings');
 await page.locator('#batch-ai-dialog .review-ai-reference').evaluate(e=>e.open=true);
 await page.locator('#batch-ai-input').fill('保留未发送的核对建议');
 assert.equal(await scope.locator('.review-issue').count(),3);
 await scope.locator('[data-issue-hide]').first().click();
 assert.equal(await scope.locator('.review-issue').count(),2);assert.equal(await main.locator('.review-issue').count(),2);
 await scope.locator('[data-issue-hide]').first().click();
 assert.equal(await scope.locator('[data-issue-restore]').count(),1);assert.match(await scope.locator('[data-issue-restore]').textContent(),/2/);
 assert.match(await scope.textContent(),/指数位置/);assert.doesNotMatch(await scope.textContent(),/根号范围|参考答案需要/);
 await scope.locator('[data-issue-restore]').click();
 assert.match(await scope.locator('.review-issue').first().textContent(),/参考答案需要/);
 assert.equal(await main.locator('.review-issue').count(),2);
 await scope.locator('[data-issue-hide]').first().click();await scope.locator('[data-issue-hide]').first().click();
 assert.equal(await scope.locator('.review-issue').count(),0);assert.equal(await scope.locator('[data-issue-restore]').count(),1);
 assert.match(await scope.textContent(),/全部隐藏/);
 assert.match(await main.locator('summary').textContent(),/0.*已隐藏 3/);
 await scope.locator('[data-issue-restore]').click();assert.match(await scope.locator('.review-issue').textContent(),/指数位置/);
 assert.equal(await page.locator('#batch-ai-input').inputValue(),'保留未发送的核对建议');
 assert.equal(calls.length,0);
 // Hiding is per batch. Inserting a new warning cannot accidentally hide it.
 await fixture(job+'-other');assert.equal(await scope.locator('.review-issue').count(),3);
 await fixture(job,true);assert.equal(await scope.locator('.review-issue').count(),2);assert.match(await scope.locator('.review-issue').first().textContent(),/新发现/);
 // Verify original result/context were never removed by the display control.
 assert.equal(await page.evaluate(()=>materialState.warnings.length),4);
 await page.reload();await page.waitForFunction(()=>state.configured&&materialState.loaded);await page.evaluate(id=>openMaterialJob(id,false),job);await fixture();
 assert.equal(await main.locator('.review-issue').count(),1);
 await main.evaluate(e=>e.open=true);await main.locator('[data-issue-restore]').click();assert.match(await main.locator('.review-issue').first().textContent(),/参考答案需要/);
 await page.locator('#fix-material-warnings').click();await page.waitForFunction(()=>!reviewReader.loading);
 await page.locator('#batch-ai-dialog .review-ai-reference').evaluate(e=>e.open=true);
 assert.equal(await scope.locator('.review-issue').count(),2);
 await scope.locator('[data-issue-restore]').click();assert.equal(await scope.locator('.review-issue').count(),3);assert.equal(await scope.locator('[data-issue-restore]').count(),0);
 const divider=page.locator('#review-height-divider'),questions=page.locator('.review-list-panel'),chat=page.locator('.review-conversation');
 const start=await questions.boundingBox();assert.ok(start.height>(await page.locator('.review-left').boundingBox()).height*.5);
 await page.locator('[data-question-ai="2"]').click();await page.waitForFunction(()=>!reviewReader.loading);
 const focus=await page.evaluate(()=>reviewReader.focusIndex),source=await page.locator('#origin-page-select').inputValue();
 await page.locator('#batch-ai-input').fill('调整布局时保留草稿');
 const handle=await divider.boundingBox();await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await page.mouse.down();await page.mouse.move(handle.x+handle.width/2,handle.y-90,{steps:8});await page.mouse.up();
 assert.ok((await questions.boundingBox()).height<start.height-60);assert.ok((await chat.boundingBox()).height>220);
 await divider.focus();const before=await questions.boundingBox();await page.keyboard.press('ArrowDown');assert.ok((await questions.boundingBox()).height>before.height+5);
 await page.keyboard.press('End');assert.ok((await chat.boundingBox()).height>=229);await page.keyboard.press('Home');assert.ok((await questions.boundingBox()).height>=219);
 await page.keyboard.press('Enter');assert.equal(await divider.getAttribute('aria-valuenow'),'58');
 assert.equal(await page.evaluate(()=>reviewReader.focusIndex),focus);assert.equal(await page.locator('#origin-page-select').inputValue(),source);assert.equal(await page.locator('#batch-ai-input').inputValue(),'调整布局时保留草稿');
 // Width and height preferences remain independent and restore after reopening/reloading.
 await page.locator('#review-divider').focus();await page.keyboard.press('ArrowRight');assert.equal(await page.locator('#review-divider').getAttribute('aria-valuenow'),'48');
 await divider.focus();await page.keyboard.press('ArrowUp');const split=await divider.getAttribute('aria-valuenow');
 await page.locator('#close-batch-ai').click();await page.locator('#fix-material-warnings').click();assert.equal(await divider.getAttribute('aria-valuenow'),split);
 await page.screenshot({path:'tmp/review-controls-desktop.png',fullPage:false});
 await page.reload();await page.waitForFunction(()=>state.configured&&materialState.loaded);await page.evaluate(id=>openMaterialJob(id,false),job);await fixture();await page.locator('#fix-material-warnings').click();await page.waitForFunction(()=>!reviewReader.loading);
 assert.equal(await divider.getAttribute('aria-valuenow'),split);assert.equal(await page.locator('#review-divider').getAttribute('aria-valuenow'),'48');
 // A real touch drag, narrow width and a short viewport keep both areas reachable.
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(100);
 const touch=await divider.boundingBox(),cdp=await page.context().newCDPSession(page),x=touch.x+touch.width/2,y=touch.y+touch.height/2;
 const topBefore=(await questions.boundingBox()).height;
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-60}]});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 assert.ok((await questions.boundingBox()).height<topBefore-35);assert.ok((await chat.boundingBox()).height>180);
 await page.screenshot({path:'tmp/review-controls-mobile.png',fullPage:false});
 for(const [width,height] of [[320,640],[1024,600]]){await page.setViewportSize({width,height});await page.waitForTimeout(80);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.ok((await questions.boundingBox()).height>=125);assert.ok((await chat.boundingBox()).height>=125);}
 // Save directly in the correction workspace, including cross-page selection and local failure recovery.
 await page.setViewportSize({width:1440,height:1000});
 const marker='纠错直接入库-'+Date.now(),save=page.locator('#review-confirm-exercises');
 await page.evaluate(marker=>{
  materialState.included=materialState.preview.map(()=>false);
  materialState.preview[0].question=marker+' 第一题（已校正）';materialState.preview[23].question=marker+' 第二十四题（已校正）';
  renderExercisePreview(materialState.preview,true);
 },marker);
 assert.equal(await save.isDisabled(),true);assert.match(await save.textContent(),/0/);
 await page.locator('[data-preview-index="0"] [data-field="included"]').check();
 await page.locator('#preview-pagination select').selectOption('1');await page.locator('[data-preview-index="23"] [data-field="included"]').check();
 assert.match(await save.textContent(),/2/);
 let saves=0;
 await page.route('**/api/exercises',async route=>{
  if(route.request().method()!=='POST')return route.fallback();saves++;
  if(saves===1){await new Promise(r=>setTimeout(r,250));return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'模拟入库失败，请重试'})});}
  return route.fallback();
 });
 await save.evaluate(e=>{e.click();e.click();});await page.waitForFunction(()=>materialState.saving);
 assert.equal(await save.isDisabled(),true);assert.match(await save.textContent(),/正在入库/);
 await page.waitForFunction(()=>!materialState.saving);assert.equal(saves,1);
 assert.equal(await page.locator('#batch-ai-dialog').evaluate(e=>e.open),true);
 assert.match(await page.locator('#review-save-feedback').textContent(),/模拟入库失败/);
 assert.equal(await page.evaluate(()=>materialState.preview.length),32);assert.match(await save.textContent(),/2/);
 await page.screenshot({path:'tmp/review-save-failure.png',fullPage:false});
 await save.click();await page.waitForFunction(()=>!materialState.saving);
 assert.equal(await page.locator('#batch-ai-dialog').evaluate(e=>e.open),false);assert.equal(saves,2);
 const imported=await page.evaluate(async marker=>(await api('/api/exercises')).exercises.filter(item=>item.question.includes(marker)),marker);
 assert.equal(imported.length,2);assert.deepEqual(imported.map(item=>item.number).sort(),['一、1','一、24']);
 assert.ok(imported.every(item=>item.question.includes('已校正')));assert.match(await page.locator('#material-import-summary').textContent(),/已加入 2/);
 assert.equal(calls.length,0);assert.deepEqual(errors,[]);
 console.log('PASS: direct correction-workspace import uses cross-page selections and corrected content, disables empty/busy save, prevents duplicate submission, keeps preview and local error on failure, retries into the real temporary library.');
 console.log('PASS: per-batch reversible warning hide, one LIFO restore, synchronized surfaces, reload persistence, new warning visibility, mouse/touch/keyboard height resizing, independent saved width and height, bounded responsive panes and preserved draft/source/focus; no AI calls.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
