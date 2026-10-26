const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.STUDY_QA_URL||'http://127.0.0.1:8766';
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1050},acceptDownloads:true});const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/#notes');await page.waitForFunction(()=>document.querySelector('#model-status').textContent.includes('已配置'));
  assert.equal(await page.locator('#note-text').inputValue(),'');
  await page.locator('[data-note-source="text"]').click();assert.equal(await page.locator('#note-upload-pane').isVisible(),false);
  await page.locator('#note-text').fill('前文\n后文');await page.locator('#note-text').evaluate(el=>{el.setSelectionRange(3,3);el.dispatchEvent(new Event('select'));});
  await page.locator('[data-note-source="image"]').click();assert.equal(await page.locator('#note-text').inputValue(),'前文\n后文');
  await page.locator('#note-file').setInputFiles({name:'board.txt',mimeType:'text/plain',buffer:Buffer.from('## 数列极限\n$x_n \\to x$。','utf8')});await page.locator('#note-read').click();
  await page.waitForFunction(()=>document.querySelector('#note-text').value.includes('数列极限'));assert.match(await page.locator('#note-text').inputValue(),/^前文\n## 数列极限/);assert.match(await page.locator('#note-text').inputValue(),/后文$/);
  const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=20;c.height=20;c.getContext('2d').fillRect(0,0,20,20);return c.toDataURL('image/png').split(',')[1];});
  await page.locator('#note-file').setInputFiles({name:'board.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});await page.locator('#note-read').click();await page.locator('.note-image-item').waitFor();
  assert.match(await page.locator('#note-text').inputValue(),/参考答案/);
  await page.locator('#note-text').fill('请整理信息不足的课堂原稿。');await page.locator('#note-submit').click();await page.waitForFunction(()=>!state.busy);assert.match(await page.locator('#notes-messages').textContent(),/不等号/);assert.equal(await page.locator('#note-saved-summary').isVisible(),false);
  assert.equal(await page.locator('#notes-messages .message.user').first().locator('.message-body').textContent(),'请整理信息不足的课堂原稿。');
  await page.locator('#notes-follow').fill('符号是小于号，继续整理笔记。');await page.locator('#notes-follow-form button').click();await page.waitForFunction(()=>!state.busy,{},{timeout:45000});
  await page.locator('.note-card a:has-text("下载 PDF")').first().waitFor();assert.equal(await page.locator('#note-input-panel').isVisible(),false);
  const data=await page.request.get(base+'/api/notes').then(r=>r.json());assert.equal(data.total,1);const note=data.notes[0];assert.match(note.content,/Note2/);assert.match(note.content,/9\^/);
  const pdf=await page.request.get(base+note.downloads.pdf);assert.equal(pdf.status(),200);assert.equal((await pdf.body()).subarray(0,4).toString(),'%PDF');
  const md=await page.request.get(base+note.downloads.md);assert.equal(md.status(),200);assert.match(await md.text(),/补充证明/);
  await page.locator('.note-card summary').click();await page.locator('.note-card .katex').first().waitFor();assert.equal(await page.locator('.note-card .katex-error').count(),0);
  await page.screenshot({path:'tmp/notes-desktop.png',fullPage:true});
  await page.locator('#note-new').click();await page.locator('#note-text').fill('等待停止，请整理笔记。');await page.locator('#note-submit').click();await page.locator('#notes-operation').waitFor();await page.locator('#notes-operation [data-stop-request]').click();await page.waitForFunction(()=>!state.busy);assert.match(await page.locator('#note-text').inputValue(),/等待停止/);assert.equal(await page.locator('#note-submit').isDisabled(),false);
  await page.reload();await page.waitForFunction(()=>document.querySelector('#model-status').textContent.includes('已配置'));assert.equal(await page.locator('#note-text').inputValue(),'');assert.equal(await page.locator('.note-image-item').count(),0);assert.equal((await page.request.get(base+'/api/notes').then(r=>r.json())).total,1);
  await page.locator('#show-prompt').click();await page.locator('#rules-content').getByText('笔记整理（默认）',{exact:true}).waitFor();await page.locator('#close-rules').click();
  await page.setViewportSize({width:390,height:844});await page.locator('[data-view="notes"]').click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:'tmp/notes-mobile.png',fullPage:true});
  assert.deepEqual(errors,[]);console.log('PASS: default note skill, source switching, caret insertion, original image upload, clarification, note persistence, Markdown/PDF downloads, cancellation/editing, reload and mobile.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
