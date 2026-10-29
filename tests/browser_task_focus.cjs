// Run against serve_workspace_fixture.py (isolated records and an offline model).
const assert=require('node:assert/strict'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {navigate,materialText}=require('./task_ui_helpers.cjs');
const base=process.env.STUDY_QA_URL||'http://127.0.0.1:8766';
const out=process.env.TASK_UI_OUTPUT||require('node:os').tmpdir();
async function idle(page){await page.waitForFunction(()=>!state.busy&&!materialState.submitting);}
(async()=>{const browser=await chromium.launch({headless:true,channel:'chrome'});try{
 const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.waitForFunction(()=>state.configured&&libraryState.notes.length&&materialState.loaded);
 assert.equal(await page.locator('.sidebar').isVisible(),false);assert.equal(await page.locator('.page-heading').isVisible(),false);
 assert.equal(await page.locator('#organize-workspace>.assistant-panel').isVisible(),false);
 const source=await page.locator('#source-panel').boundingBox();assert.ok(source.width>=1000&&source.y<130,JSON.stringify(source));
 await page.locator('[data-source="text"]').click();await page.locator('#draft').fill('笔记：求导公式。错题：求 x² 的导数，我的答案 x，参考答案 2x。');
 const draft=await page.locator('#draft').inputValue();await page.locator('#organize-submit').click();await idle(page);
 assert.equal(await page.locator('#source-panel').isVisible(),false);assert.equal(await page.locator('#organize-messages').isVisible(),true);
 assert.equal(await page.locator('#organize-results').isVisible(),false);assert.equal(await page.locator('#organize-suggestions').isVisible(),false);
 await page.locator('#organize-follow').fill('尚未发送的补充');await page.locator('#focus-show-source').click();
 assert.equal(await page.locator('#draft').inputValue(),draft);await page.locator('#focus-show-discussion').click();
 assert.equal(await page.locator('#organize-follow').inputValue(),'尚未发送的补充');
 // A background reply must not pull a reader away from an earlier step.
 await page.evaluate(()=>{state.chats.organize.push(...Array.from({length:12},(_,i)=>({role:'assistant',text:'较早步骤 '+i+'\n'.repeat(2)+'请逐项检查。'.repeat(40)})));renderChat('organize',true);document.querySelector('#organize-messages').scrollTop=70;});
 await page.evaluate(()=>{state.chats.organize.push({role:'assistant',text:'最新回复'});renderChat('organize');});
 assert.ok(await page.locator('#organize-messages').evaluate(el=>Math.abs(el.scrollTop-70)<3));
 await page.locator('#organize-new-reply').click();assert.ok(await page.locator('#organize-messages').evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight<3));
 await page.screenshot({path:path.join(out,'discussion-desktop.png')});
 await navigate(page,'notes');const note=page.locator('#note-library .record-card').first(),id=await note.getAttribute('data-record-id');
 await note.locator('[data-record-focus]').click();assert.equal(await page.locator('#reading-workspace').isVisible(),true);
 assert.equal(await page.locator('#reading-body .record-actions').first().isVisible(),false);
 const readingText=await page.locator('#reading-body .record-body').first().textContent();assert.ok(readingText.length>10);
 await page.locator('#reading-more').click();assert.equal(await page.locator('#reading-body .record-actions').first().isVisible(),true);
 await page.locator('#reading-back').click();assert.equal(await page.locator(`#note-library [data-record-id="${id}"]`).count(),1);
 await page.locator(`#note-library [data-record-id="${id}"] [data-record-select]`).check();await page.locator('#analyze-selection').click();
 assert.equal(await page.locator('#view-analysis aside').isVisible(),false);assert.equal(await page.locator('#selection-tray').isVisible(),false);
 await page.locator('#analysis-follow').fill('请保留我的分析问题');await page.locator('#focus-analysis-sources').click();
 assert.equal(await page.locator('#analysis-sources').isVisible(),true);await page.locator('#focus-analysis-sources').click();
 assert.equal(await page.locator('#analysis-follow').inputValue(),'请保留我的分析问题');
 await navigate(page,'materials');assert.equal(await page.locator('#material-library-panel').isVisible(),false);
 await materialText(page,'1.求 x² 的导数。参考答案 2x。');await page.locator('#material-source').fill('专注交互验收');
 await page.locator('#focus-show-library').click();assert.equal(await page.locator('#materials-import-area').isVisible(),false);
 await page.locator('#focus-show-import').click();assert.match(await page.locator('#material-text').inputValue(),/x²/);
 await page.locator('#parse-material').click();await page.waitForFunction(()=>materialState.stage==='preview');await idle(page);
 assert.equal(await page.locator('#material-library-panel').isVisible(),false);assert.equal(await page.locator('#preview-batch-provenance').isVisible(),false);
 await page.locator('#focus-preview-source').click();assert.equal(await page.locator('#preview-batch-provenance').isVisible(),true);
 await page.locator('#focus-preview-source').click();await page.locator('[data-question-ai="0"]').click();
 await page.locator('#batch-ai-input').fill('保留我的修正要求');await page.locator('#toggle-correction-chat').click();
 assert.equal(await page.locator('#review-conversation').isVisible(),false);await page.locator('#toggle-correction-chat').click();
 assert.equal(await page.locator('#batch-ai-input').inputValue(),'保留我的修正要求');await page.locator('#close-batch-ai').click();
 // Opening a reference answer follows reading intent and does not summon an AI panel.
 await page.locator('.preview-answer>summary').first().click();await page.locator('#batch-ai-dialog').waitFor({state:'visible'});
 assert.equal(await page.locator('#review-conversation').isVisible(),false);await page.locator('#close-batch-ai').click();
 await page.locator('#focus-show-library').click();await page.locator('#focus-resume-preview').click();assert.equal(await page.locator('#material-preview-panel').isVisible(),true);
 await page.screenshot({path:path.join(out,'preview-desktop.png')});
 // Completing a background task while browsing the library must leave the library visible.
 await page.locator('#focus-show-library').click();await page.evaluate(()=>{materialState.stage='processing';renderMaterialTasks();});
 await page.waitForTimeout(250);assert.equal(await page.locator('#material-library-panel').isVisible(),true);
 await page.evaluate(()=>materialState.stage='preview');
 for(const width of [390,320]){await page.setViewportSize({width,height:844});for(const view of ['organize','notes','notebook','materials','review']){
  await navigate(page,view);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${width}px ${view}`);
 }}
 await page.screenshot({path:path.join(out,'review-mobile.png')});
 // All disclosure and navigation controls remain usable from the keyboard.
 await page.locator('#task-navigation-toggle').press('Enter');assert.equal(await page.locator('.sidebar').isVisible(),true);
 await page.keyboard.press('Escape');assert.equal(await page.locator('.sidebar').isVisible(),false);
 assert.equal(await page.locator('#task-navigation-toggle').evaluate(el=>el===document.activeElement),true);
 assert.deepEqual(errors,[]);console.log('PASS: task space, draft preservation, reader position, reading tools, source/AI intent, background jobs, keyboard navigation, 390/320px and reduced motion.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
