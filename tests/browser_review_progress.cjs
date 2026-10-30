// Start serve_review_progress_fixture.py first. All records and judgments are synthetic.
const assert=require('node:assert/strict'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {navigate}=require('./task_ui_helpers.cjs');
const base=process.env.STUDY_QA_URL||'http://127.0.0.1:8802';
const out=process.env.REVIEW_QA_OUTPUT||require('node:os').tmpdir();
async function idle(page){await page.waitForFunction(()=>!state.busy&&!chatQueue.dispatching&&!chatQueue.items.length);}
async function historyCount(page,count){await page.waitForFunction(n=>document.querySelector("#review-history-count").textContent.startsWith("共 "+n+" 次"),count);}
async function answer(page,text){await page.locator('#review-follow').fill(text);await page.locator('#review-follow').press('Control+Enter');await idle(page);}
(async()=>{const browser=await chromium.launch({headless:true,channel:'chrome'});try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/#review');await page.waitForFunction(()=>state.configured&&reviewState.catalog?.total===4&&reviewProgressState.round!==null);
 await page.locator('[data-review-toggle="极限"]').click();await page.locator('[data-review-tag="无穷小比较"]').click();await page.locator('#start-review').click();await idle(page);
 const first=await page.evaluate(()=>reviewState.question.id);assert.match(await page.locator('#review-record-status').textContent(),/本轮已出.*尚未作答/);
 await page.locator('#question-review-history').click();await historyCount(page,0);assert.match(await page.locator('#review-history-count').textContent(),/共 0 次/);await page.locator('#close-review-history').click();
 await answer(page,'我的答案是x，请检查。');assert.match(await page.locator('#review-record-status').textContent(),/做错/);assert.match(await page.locator('#review-record-status').textContent(),/公式使用/);
 await answer(page,'我已补齐等价替换，极限得到1。');assert.match(await page.locator('#review-record-status').textContent(),/改正后做对/);
 await page.locator('#question-review-history').click();await historyCount(page,1);assert.match(await page.locator('#review-history-list').textContent(),/公式使用/);
 await page.locator('.review-attempt summary').click();assert.match(await page.locator('.review-attempt').textContent(),/我的答案是x/);assert.match(await page.locator('.review-attempt').textContent(),/我已补齐/);
 assert.equal(await page.locator('.attempt-event').count(),4);await page.locator('#close-review-history').click();
 await answer(page,'再来一道');const second=await page.evaluate(()=>reviewState.question.id);assert.notEqual(second,first);
 await answer(page,'再来一道');const third=await page.evaluate(()=>reviewState.question.id);assert.equal(new Set([first,second,third]).size,3);
 await answer(page,'再来一道');assert.match(await page.locator('#review-messages').textContent(),/本轮已经全部出过/);assert.equal(await page.evaluate(()=>reviewState.question.id),third);
 // Exhaustion through the selection button must keep drafts and display the actual no-new-question reply.
 await page.locator('#review-follow').fill('保留未发送文字');await page.locator('#toggle-review-catalog').click();await page.locator('#start-review').click();await idle(page);
 assert.equal(await page.locator('#review-follow').inputValue(),'保留未发送文字');assert.match(await page.locator('#review-messages').textContent(),/本轮已经全部出过/);
 await answer(page,'出一个1的无穷次方的');assert.match(await page.locator('#review-question-body').textContent(),/合成幂指题/);assert.equal(await page.evaluate(()=>reviewProgressState.round.selection.tag),'1^∞型极限');
 await answer(page,'独立答案：完整推导已写出，得到e。');assert.match(await page.locator('#review-record-status').textContent(),/独立做对/);
 await page.locator('#question-review-history').click();await page.locator('#review-manual-result>summary').click();
 await page.locator('#review-result-outcome').selectOption('partial');await page.locator('#review-result-evidence').fill('我只完成了中间一步，尚未写出完整结论。');await page.locator('#save-review-result').click();
 await page.waitForFunction(()=>document.querySelector('#review-history-feedback').textContent.includes('已保存'));assert.match(await page.locator('#review-history-list').textContent(),/做到一部分/);
 await page.screenshot({path:path.join(out,'review-attempt-history.png')});await page.locator('#close-review-history').click();
 page.once('dialog',dialog=>dialog.accept());await page.locator('#end-review-round').click();await page.waitForFunction(()=>reviewState.question===null);
 await page.locator('#open-review-history').click();await historyCount(page,2);assert.match(await page.locator('#review-history-count').textContent(),/共 2 次/);await page.locator('#close-review-history').click();
 // Ending clears only round state. A real page reload preserves every recorded attempt.
 await page.reload();await page.waitForFunction(()=>state.configured&&reviewState.catalog&&reviewProgressState.round!==null);
 await page.locator('#open-review-history').click();await historyCount(page,2);assert.match(await page.locator('#review-history-count').textContent(),/共 2 次/);await page.locator('#close-review-history').click();
 if(!await page.locator('[data-review-tag="无穷小比较"]').isVisible())await page.locator('[data-review-toggle="极限"]').click();await page.locator('[data-review-tag="无穷小比较"]').click();await page.locator('#start-review').click();await idle(page);
 assert.equal(await page.evaluate(()=>reviewState.question.id),first);await answer(page,'独立答案：本次完整推导一致。');
 const history=await page.request.get(base+'/api/review/history?question_id='+encodeURIComponent(first)).then(r=>r.json());assert.equal(history.total,2);
 await navigate(page,'materials');await page.locator('#focus-show-library').click();const card=page.locator(`[data-review-question="${first}"]`);await card.locator('.record-progress').waitFor();assert.match(await card.locator('.record-progress').textContent(),/已做 2 次/);assert.match(await card.locator('.record-progress').textContent(),/曾错：公式使用/);
 for(const width of [390,320]){await page.setViewportSize({width,height:844});await navigate(page,'review');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`review overflow ${width}`);
  await page.locator('#question-review-history').click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`history overflow ${width}`);await page.locator('#close-review-history').click();
 }
 await page.screenshot({path:path.join(out,'review-attempt-mobile.png')});assert.deepEqual(errors,[]);
 console.log('PASS: no repeated questions within a round, true exhaustion reply, named scope change, AI/manual judgments, per-turn timestamps, persistent attempts, cumulative error badges, end/reload, 390/320px.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
