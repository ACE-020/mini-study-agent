const {navigate,utility,materialText}=require('./task_ui_helpers.cjs');
const assert=require('node:assert/strict');
const path=require('node:path');
const {chromium}=require('playwright');
const BASE=process.env.STUDY_QA_URL||'http://127.0.0.1:8791';
const OUT=process.env.REVIEW_QA_OUTPUT||require('node:os').tmpdir();
const photo={name:'queued-answer.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=','base64')};
async function idle(page){await page.waitForFunction(()=>!state.busy&&!chatQueue.dispatching&&!chatQueue.items.length&&!chatQueue.steering);}
async function typeSend(page,text){await page.locator('#review-follow').fill(text);await page.locator('#review-follow').press('Control+Enter');}
(async()=>{const browser=await chromium.launch({headless:true,channel:'chrome'});try{
 const page=await browser.newPage({viewport:{width:1500,height:1000}}),errors=[],messages=[];
 page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/chat')messages.push(request.postDataJSON().message);});
 await page.goto(BASE+'/#review');await page.waitForFunction(()=>reviewState.catalog?.total===5&&!reviewState.loading);
 await page.locator('[data-review-toggle="极限"]').click();await page.locator('[data-review-tag="等价无穷小"]').click();await page.locator('#start-review').click();await idle(page);
 assert.equal(await page.locator('#review-catalog-panel').isVisible(),false);assert.equal(await page.locator('.page-heading').isVisible(),false);assert.equal(await page.locator('#toggle-review-catalog').textContent(),'展开选题');
 const geometry=await page.evaluate(()=>{const tutor=document.querySelector('.review-tutor').getBoundingClientRect(),log=document.querySelector('#review-messages').getBoundingClientRect(),main=document.querySelector('.main').getBoundingClientRect();return {tutorTop:tutor.top,tutorWidth:tutor.width,mainWidth:main.width,logHeight:log.height};});
 assert.ok(geometry.tutorTop<130,JSON.stringify(geometry));assert.ok(geometry.tutorWidth/geometry.mainWidth>.9);assert.ok(geometry.logHeight>400,JSON.stringify(geometry));
 await page.locator('#toggle-review-catalog').click();assert.equal(await page.locator('#review-catalog-panel').isVisible(),true);assert.equal(await page.locator('#toggle-review-catalog').textContent(),'收起选题');
 await page.locator('#toggle-review-catalog').click();assert.equal(await page.locator('#review-catalog-panel').isVisible(),false);
 await navigate(page,'notes');assert.equal(await page.locator('.page-heading').isVisible(),false);await navigate(page,'review');assert.equal(await page.locator('.page-heading').isVisible(),false);
 // Type, attach and queue two follow-ups during an actual pending model request.
 await typeSend(page,'慢速测试-A：先对两边微分');await page.waitForFunction(()=>state.busy&&state.operation?.chatStarted);
 assert.equal(await page.locator('#review-follow').evaluate(node=>node.readOnly),false);assert.equal(await page.locator('#review-attach').isEnabled(),true);
 await typeSend(page,'队列-B：检查链式法则');await page.waitForFunction(()=>chatQueue.items.length===1);
 await page.locator('#review-image-input').setInputFiles(photo);await page.locator('#review-follow').fill('队列-C：这是手写步骤');await page.locator('#review-follow').press('Control+Enter');
 assert.equal(await page.locator('[data-chat-queue="review"] .chat-queue-item').count(),2);assert.equal(await page.locator('[data-chat-queue="review"] .queue-thumbnail').count(),1);
 await page.locator('#review-follow').fill('尚未发送的新草稿');
 await page.screenshot({path:path.join(OUT,'review-focus-queued.png')});await idle(page);
 assert.deepEqual(messages.slice(0,3),['慢速测试-A：先对两边微分','队列-B：检查链式法则','队列-C：这是手写步骤']);assert.equal(await page.locator('#review-follow').inputValue(),'尚未发送的新草稿');
 assert.equal(await page.locator('#review-messages .chat-image-preview').count(),1);
 // Edit/remove queued messages without replacing the next draft.
 await typeSend(page,'慢速测试-E：继续核对');await page.waitForFunction(()=>state.busy&&state.operation?.chatStarted);await typeSend(page,'等待编辑的消息');
 const row=page.locator('[data-chat-queue="review"] .chat-queue-item').first();await row.getByRole('button',{name:'编辑',exact:true}).click();await row.locator('textarea').fill('编辑后的队列消息');await row.getByRole('button',{name:'保存',exact:true}).click();
 await typeSend(page,'待移除的消息');await page.locator('[data-chat-queue="review"] .chat-queue-item').last().getByRole('button',{name:'移除',exact:true}).click();await idle(page);
 assert.ok(messages.includes('编辑后的队列消息'));assert.ok(!messages.includes('待移除的消息'));
 // A queued message can steer the active request. Original input remains in model history.
 await typeSend(page,'慢速测试-原任务F：检查我求导这一步');await page.waitForFunction(()=>state.busy&&state.operation?.chatStarted);
 await typeSend(page,'立即补充-G：先不要化简，检查指数');await page.locator('[data-chat-queue="review"] .chat-queue-item').getByRole('button',{name:'立即发送',exact:true}).click();await idle(page);
 let calls=await (await page.request.get(BASE+'/qa/model-calls')).json();let history=JSON.stringify(calls.last_context);
 assert.match(history,/原任务F/);assert.match(history,/立即补充-G/);assert.match(history,/L1/);
 // Immediate draft entry also works, leaving ordinary queued work behind it.
 await typeSend(page,'慢速测试-H：请看这一步');await page.waitForFunction(()=>state.busy&&state.operation?.chatStarted);await typeSend(page,'后续-J：等本轮结束再看');
 await page.locator('#review-follow').fill('立即补充-I：先检查符号');await page.locator('[data-steer-draft="review"]').click();await idle(page);
 assert.ok(messages.indexOf('立即补充-I：先检查符号')<messages.indexOf('后续-J：等本轮结束再看'));
 // The no-checkpoint path (interrupted while reading an image) resends the original photo and text.
 await page.locator('#review-image-input').setInputFiles({...photo,name:'interrupted-read.png'});await typeSend(page,'图片请求-K：检查照片中的步骤');await page.waitForFunction(()=>state.busy&&state.operation?.chatStarted);
 await page.locator('#review-follow').fill('立即补充-L：只检查第一行');await page.locator('[data-steer-draft="review"]').click();await idle(page);
 calls=await (await page.request.get(BASE+'/qa/model-calls')).json();history=JSON.stringify(calls.last_context);assert.match(history,/图片请求-K/);assert.match(history,/立即补充-L/);assert.match(history,/手写测试标记/);
 assert.equal(await page.locator('#review-question').isVisible(),true);assert.doesNotMatch(await page.locator('#view-review').textContent(),/手写测试标记/);
 // A manual stop pauses the waiting queue instead of immediately starting another request.
 await typeSend(page,'慢速测试-M：稍后再核对');await page.waitForFunction(()=>state.busy&&state.operation?.chatStarted);await typeSend(page,'排队-N：等待手动恢复');
 await page.locator('#review-operation [data-stop-request]').click();await page.waitForFunction(()=>!state.busy&&!chatQueue.dispatching);
 assert.equal(await page.evaluate(()=>chatQueue.paused),true);assert.equal(await page.locator('[data-chat-queue="review"] .chat-queue-item').count(),1);
 assert.equal(await page.locator('#review-follow').inputValue(),'慢速测试-M：稍后再核对');await page.locator('[data-chat-queue="review"]').getByRole('button',{name:'继续发送',exact:true}).click();await idle(page);
 assert.ok(messages.includes('排队-N：等待手动恢复'));assert.equal(await page.locator('#review-follow').inputValue(),'慢速测试-M：稍后再核对');await page.locator('#review-follow').fill('');
 await page.screenshot({path:path.join(OUT,'review-focus-desktop.png')});
 await page.setViewportSize({width:390,height:844});await page.locator('#review-follow').scrollIntoViewIfNeeded();
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.equal(await page.locator('#review-catalog-panel').isVisible(),false);
 await page.screenshot({path:path.join(OUT,'review-focus-mobile.png')});assert.deepEqual(errors,[]);
 console.log('PASS auto/manual catalog collapse, compact heading, full-width review, editable FIFO/image queue, concurrent drafts, steer queued/draft, preserved tool context and interrupted image input, mobile layout.',geometry);
}finally{await browser.close();}})().catch(error=>{console.error(error);process.exit(1);});
