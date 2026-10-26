const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.STUDY_QA_URL || 'http://127.0.0.1:8766';
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1050},acceptDownloads:true});
  const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base);await page.waitForFunction(()=>document.querySelector('#model-status').textContent.includes('已配置'));
  await page.locator('#show-prompt').click();
  await page.locator('#rules-content .prompt-text').first().waitFor();
  const runtimePrompts=await page.request.get(base+'/api/prompts').then(response=>response.json());
  assert.equal(await page.locator('#rules-content .prompt-text').first().textContent(),runtimePrompts.prompts['教学与选题']);
  await page.locator('#close-rules').click();
  await page.locator('[data-view="materials"]').click();
  const text='1.计算二阶行列式 |1 2; 3 4| 的值。\n参考答案：-2。\n2.求 g(x)=x^3 的导数，x 为实数。\n参考答案：3x^2。';
  await page.locator('#material-file').setInputFiles({name:'用户练习册.txt',mimeType:'text/plain',buffer:Buffer.from(text,'utf8')});
  await page.locator('#read-material').click();
  await page.waitForFunction(()=>document.querySelector('#material-text').value.includes('行列式'));
  assert.equal((await page.request.get(base+'/api/exercises').then(r=>r.json())).total,0);
  await page.locator('#parse-material').click();
  await page.locator('.exercise-editor').first().waitFor();
  assert.equal(await page.locator('.exercise-editor').count(),2);
  assert.equal((await page.request.get(base+'/api/exercises').then(r=>r.json())).total,0);
  await page.locator('#exercise-preview-0-number').fill('6');
  await page.locator('#confirm-exercises').click();
  await page.waitForFunction(()=>document.querySelector('#exercise-count').textContent.includes('2 道题'));
  assert.equal(await page.locator('#exercise-library .mistake-card').count(),2);
  assert.equal(await page.locator('#materials-import-area').isVisible(),false);
  if(process.env.STUDY_MATERIAL_SCREENSHOT){await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:process.env.STUDY_MATERIAL_SCREENSHOT,fullPage:true});}
  const downloadPromise=page.waitForEvent('download');await page.locator('#export-exercises').click();const download=await downloadPromise;
  assert.equal(download.suggestedFilename(),'练习题库.json');
  // Confirm another supplied determinant exercise; all records belong to this temporary fixture.
  const extra=await page.request.post(base+'/api/exercises',{data:{confirmed:true,source:'补充讲义',exercises:[{number:'9',topic:'行列式',question:'计算二阶行列式 |2 0; 0 3| 的值。',answer:'参考答案：6'}]}});
  assert.equal(extra.ok(),true);await page.evaluate(()=>loadMaterials());
  await page.locator('#exercise-library [data-exercise-id]').first().click();
  await page.locator('#review-messages .message.assistant').last().waitFor();
  let answer=await page.locator('#review-messages .message.assistant').last().innerText();
  assert.match(answer,/用户练习册.txt · 原题号 6/);assert.match(answer,/1 2; 3 4/);assert.doesNotMatch(answer,/资料答案/);
  assert.doesNotMatch(await page.locator('#review-trace .trace-content').textContent(),/get_mistakes/);
  await page.locator('#review-follow').fill('出');await page.locator('#review-follow').press('Control+Enter');
  await page.waitForFunction(()=>document.querySelector('#review-messages').textContent.includes('补充讲义'));
  answer=await page.locator('#review-messages .message.assistant').last().innerText();
  assert.match(answer,/2 0; 0 3/);assert.doesNotMatch(answer,/g\(x\)/);
  assert.doesNotMatch(await page.locator('#review-trace .trace-content').textContent(),/get_mistakes/);
  // The review tree selects its range without using mistake statistics.
  await page.waitForFunction(()=>!reviewState.loading&&reviewState.catalog);
  if(!await page.locator('#review-catalog-panel').isVisible())await page.locator('#toggle-review-catalog').click();
  await page.locator('.review-folder-label[data-review-category="导数与微分"]').click();
  await page.locator('#start-review').click();
  await page.waitForFunction(()=>!state.busy&&document.querySelector('#review-trace .trace-content').textContent.includes('pick_exercise'));
  answer=await page.locator('#review-messages .message.assistant').last().innerText();
  assert.match(answer,/g\(x\)=x\^3/);assert.doesNotMatch(answer,/资料答案/);
  await page.locator('[data-view="materials"]').click();
  await page.locator('#import-more-materials').click();
  await page.locator('#material-text').fill('等待停止：保留这份原文');await page.locator('#parse-material').click();
  await page.locator('#materials-operation [data-stop-request]').click();
  await page.waitForFunction(()=>!document.querySelector('#material-feedback').hidden&&document.querySelector('#material-feedback').textContent.includes('已停止'));
  assert.equal(await page.locator('#material-text').inputValue(),'等待停止：保留这份原文');
  assert.equal((await page.request.get(base+'/api/exercises').then(r=>r.json())).total,3);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.locator('#show-prompt').click();await page.locator('#rules-content .prompt-text').first().waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(errors,[]);
  console.log('PASS: visible prompts, TXT upload, editable preview, confirmed import, export, exact source selection, context practice without history, explicit history review, stop parsing, mobile layout.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
