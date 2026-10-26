/* Run against serve_browser_fixture.py. These checks never call a real model. */
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.STUDY_QA_URL || 'http://127.0.0.1:8766';
const imageFile = {name:'cursor.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')};

(async()=>{
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 const errors=[];
 try{
  const context=await browser.newContext({viewport:{width:1360,height:1000}});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  page.on('dialog',dialog=>{errors.push('Unexpected replacement dialog: '+dialog.message());dialog.dismiss();});
  await page.goto(base);await page.waitForFunction(()=>document.querySelector('#model-status').textContent.includes('已配置'));
  const editor=page.locator('#draft');
  // The textarea is one shared editor; only the image controls toggle.
  await page.locator('[data-source="text"]').click();
  assert.equal(await page.locator('#image-pane').isVisible(),false);
  assert.equal(await editor.isVisible(),true);
  await editor.fill('前文🙂后文');
  await editor.evaluate(node=>{node.focus();node.setSelectionRange(4,4);node.dispatchEvent(new Event('select'));});
  await page.locator('[data-source="image"]').click();
  assert.equal(await page.locator('#image-pane').isVisible(),true);
  assert.equal(await editor.inputValue(),'前文🙂后文');
  await page.locator('[data-source="text"]').click();
  assert.equal(await page.locator('#image-pane').isVisible(),false);
  assert.deepEqual(await editor.evaluate(node=>[node.selectionStart,node.selectionEnd]),[4,4]);
  await page.locator('[data-source="image"]').click();
  await page.locator('#image-input').setInputFiles(imageFile);
  let result='识别题目\n第二行';
  await page.route('**/api/ocr',async route=>{await new Promise(resolve=>setTimeout(resolve,100));await route.fulfill({json:{ok:true,text:result}});});
  async function recognize(){
   const done=page.waitForResponse(response=>response.url().endsWith('/api/ocr'));
   await page.locator('#recognize-button').click();await done;
   await page.waitForFunction(()=>!state.busy);
  }
  await recognize();
  assert.equal(await editor.inputValue(),'前文🙂识别题目\n第二行后文');
  assert.deepEqual(await editor.evaluate(node=>[node.selectionStart,node.selectionEnd]),[4+result.length,4+result.length]);
  assert.equal(await page.locator('#image-pane').isVisible(),true);
  assert.equal(await page.locator('[data-source="image"]').getAttribute('aria-pressed'),'true');
  assert.match(await page.locator('#draft-count').innerText(),new RegExp('^'+(await editor.inputValue()).length+' /'));

  // A second image inserts at the new caret instead of replacing the previous text.
  result='追加';await recognize();
  assert.equal(await editor.inputValue(),'前文🙂识别题目\n第二行追加后文');
  // Native paste behavior applies only to the explicitly selected segment.
  await editor.evaluate(node=>{node.focus();node.setSelectionRange(0,2);node.dispatchEvent(new Event('select'));});
  result='替换前文';await recognize();
  assert.equal(await editor.inputValue(),'替换前文🙂识别题目\n第二行追加后文');
  // Reject oversized insertion without silently truncating or erasing the draft.
  await editor.fill('甲'.repeat(23999));
  result='超过长度';await recognize();
  assert.equal((await editor.inputValue()).length,23999);
  assert.match(await page.locator('#notice').innerText(),/超过.*长度/);
  // Reload starts fresh, matching the image field; a new insertion starts at the beginning.
  await editor.fill('恢复后的草稿');await page.reload();
  await page.waitForFunction(()=>document.querySelector('#model-status').textContent.includes('已配置'));
  await page.locator('#image-input').setInputFiles(imageFile);
  assert.equal(await editor.inputValue(),'');
  result='新识别';await recognize();assert.equal(await editor.inputValue(),'新识别');
  // Mobile uses the same editor and does not overflow when toggling modes.
  await page.setViewportSize({width:390,height:844});
  await page.locator('[data-source="text"]').click();assert.equal(await page.locator('#image-pane').isVisible(),false);
  assert.equal(await editor.inputValue(),'新识别');
  await page.locator('[data-source="image"]').click();assert.equal(await page.locator('#image-pane').isVisible(),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(errors,[]);
  console.log('PASS: configured startup, source modes, retained text/caret, inline OCR insertion, repeat insertion, selected replacement, length protection, fresh-page drafts and mobile layout.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
