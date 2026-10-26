/* UI-only checks: all chat responses are mocked; no paid model request or record write. */
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.STUDY_QA_URL || 'http://127.0.0.1:8766';
const imageFile={name:'fresh-page.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')};
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 let releaseAnswer;
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  async function ready(target=page){await target.waitForFunction(()=>document.querySelector('#model-status').textContent.includes('已配置'));}
  await page.goto(base);await ready();
  // Older releases left text-only drafts in localStorage. Remove only those legacy keys.
  await page.evaluate(()=>{
   localStorage.setItem('study-agent-draft','上次的题目');
   localStorage.setItem('study-material-draft','上次的资料');
   localStorage.setItem('study-material-source','上次的文件名');
   localStorage.setItem('unrelated-app-data','keep');
  });
  await page.reload();await ready();
  for(const id of ['draft','material-text','material-source'])assert.equal(await page.locator('#'+id).inputValue(),'');
  assert.deepEqual(await page.evaluate(()=>['study-agent-draft','study-material-draft','study-material-source'].map(key=>localStorage.getItem(key))),[null,null,null]);
  assert.equal(await page.evaluate(()=>localStorage.getItem('unrelated-app-data')),'keep');
  await page.locator('#draft').fill('当前页仍可继续编辑');
  await page.locator('#image-input').setInputFiles(imageFile);
  await page.locator('[data-view="materials"]').click();
  await page.locator('#material-text').fill('当前页资料');await page.locator('#material-source').fill('当前页来源');
  await page.locator('[data-view="organize"]').click();
  assert.equal(await page.locator('#draft').inputValue(),'当前页仍可继续编辑');
  assert.equal(await page.locator('#image-preview').isVisible(),true);
  await page.reload();await ready();
  assert.equal(await page.locator('#draft').inputValue(),'');
  assert.equal(await page.locator('#image-input').evaluate(node=>node.files.length),0);
  assert.equal(await page.locator('#material-text').inputValue(),'');
  const reopened=await context.newPage();await reopened.goto(base);await ready(reopened);
  assert.equal(await reopened.locator('#draft').inputValue(),'');await reopened.close();

  // Suggested follow-ups appear after the assistant, on its left edge; never while processing.
  const chatBodies=[];let signalChatStarted;
  const chatStarted=new Promise(resolve=>{signalChatStarted=resolve;});
  await page.route('**/api/chat',async route=>{
   chatBodies.push(route.request().postDataJSON());
   if(chatBodies.length===1)await new Promise(resolve=>{releaseAnswer=resolve;signalChatStarted();});
   await route.fulfill({json:{ok:true,answer:'先看这一列：你会从哪一项开始计算？',events:[]}});
  });
  await page.locator('[data-source="text"]').click();await page.locator('#draft').fill('这一步不会，请给一个提示。');
  await page.locator('#organize-submit').click();await page.locator('#organize-operation').waitFor({state:'visible'});
  assert.equal(await page.locator('#organize-suggestions').isVisible(),false);
  await chatStarted;
  assert.equal(typeof releaseAnswer,'function');releaseAnswer();
  await page.locator('#organize-suggestions').waitFor({state:'visible'});
  assert.match(await page.locator('#organize-suggestions').innerText(),/建议追问/);
  const button=await page.locator('#practice-current').boundingBox();const messages=await page.locator('#organize-messages').boundingBox();
  assert.ok(Math.abs(button.x-messages.x)<2,JSON.stringify({button,messages}));
  assert.equal(await page.locator('.message.user').count(),1);
  if(process.env.STUDY_POLISH_SCREENSHOT){await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:process.env.STUDY_POLISH_SCREENSHOT,fullPage:true});}
  await page.locator('#practice-current').click();
  await page.waitForFunction(()=>!state.busy);
  assert.equal(chatBodies.length,2);assert.equal(chatBodies[1].intent,'practice');assert.equal(chatBodies[1].scope,'current');

  async function openAndScroll(){
   await page.locator('#show-prompt').click();await page.locator('#rules-content .prompt-text').first().waitFor();
   await page.locator('#rules-content details').evaluateAll(nodes=>nodes.forEach(node=>{node.open=true;}));
   const before=await page.locator('#close-rules').boundingBox();
   const scrolled=await page.locator('#rules-scroll').evaluate(node=>{node.scrollTop=node.scrollHeight;return node.scrollTop;});
   assert.ok(scrolled>0);
   const after=await page.locator('#close-rules').boundingBox();
   assert.ok(Math.abs(before.y-after.y)<1,JSON.stringify({before,after}));
   const viewport=page.viewportSize();assert.ok(after.y>=0&&after.y+after.height<=viewport.height);
  }
  await openAndScroll();
  if(process.env.STUDY_RULES_SCREENSHOT)await page.screenshot({path:process.env.STUDY_RULES_SCREENSHOT});
  await page.locator('#close-rules').click();assert.equal(await page.locator('#assistant-rules').evaluate(node=>node.open),false);
  await openAndScroll();
  await page.locator('#rules-scroll').click({position:{x:10,y:10}});assert.equal(await page.locator('#assistant-rules').evaluate(node=>node.open),true);
  const rect=await page.locator('#assistant-rules').boundingBox();await page.mouse.click(rect.x/2,rect.y+rect.height/2);
  assert.equal(await page.locator('#assistant-rules').evaluate(node=>node.open),false);
  await openAndScroll();
  const rightRect=await page.locator('#assistant-rules').boundingBox();await page.mouse.click((rightRect.x+rightRect.width+page.viewportSize().width)/2,rightRect.y+rightRect.height/2);
  assert.equal(await page.locator('#assistant-rules').evaluate(node=>node.open),false);
  await openAndScroll();await page.keyboard.press('Escape');assert.equal(await page.locator('#assistant-rules').evaluate(node=>node.open),false);
  await page.setViewportSize({width:390,height:844});await openAndScroll();
  const mobileRect=await page.locator('#assistant-rules').boundingBox();await page.mouse.click(mobileRect.x/2,mobileRect.y+mobileRect.height/2);
  assert.equal(await page.locator('#assistant-rules').evaluate(node=>node.open),false);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(errors,[]);
  console.log('PASS: legacy draft cleanup, reload/reopen starts empty, current-page inputs retained, left-side suggestions after assistant, fixed rules close button, backdrop/Escape dismissal and mobile layout.');
 }finally{releaseAnswer?.();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
