const assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage({viewport:{width:1366,height:960}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:8789/#materials');
  await page.waitForFunction(()=>state.configured&&state.localOcr&&materialState.loaded);
  assert.match(await page.locator('#material-source-model').innerText(),/GLM-OCR/);
  const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAIwAAAA8CAIAAAA7aMUcAAAAqElEQVR4nO3RwQ3AIBDAMOj+Ox8j8CyR7AkiZc/M4m3f3wHcmRRgUoBJASYFmBRgUoBJASYFmBRgUoBJASYFmBRgUoBJASYFmBRgUoBJASYFmBRgUoBJASYFmBRgUoBJASYFmBRgUoBJASYFmBRgUoBJASYFmBRgUoBJASYFmBRgUoBJASYFmBRgUoBJASYFmBRgUoBJASYFmBRgUoBJASYFmBRg0nrfAWugA3WvNa7EAAAAAElFTkSuQmCC','base64');
  const file={name:'test.png',mimeType:'image/png',buffer:image};
  await page.locator('#material-file').setInputFiles(file);
  await page.locator('#read-material').click();
  await page.locator('#material-read-title').getByText(/GLM 正在本机识别/).waitFor();
  assert.equal(await page.locator('#material-read-spinner').isVisible(),true);
  assert.equal(await page.locator('#stop-material-read').isVisible(),true);
  await page.waitForFunction(()=>!state.busy);
  assert.match(await page.locator('#material-text').inputValue(),/sqrt/);
  await page.locator('#material-text').fill('');
  await page.locator('#read-material').click();
  await page.locator('#material-read-title').getByText(/GLM 正在本机识别/).waitFor();
  await page.locator('#stop-material-read').click();
  await page.waitForFunction(()=>!state.busy);
  assert.equal(await page.locator('#material-text').inputValue(),'');
  assert.match(await page.locator('#material-read-title').innerText(),/停止/);
  await page.locator('#material-source').fill('本机识别验收');
  await page.locator('#parse-material').click();
  await page.waitForFunction(()=>materialState.jobs.some(j=>j.status==='running'));
  const task=page.locator('#material-tasks-button');await task.click();
  await page.locator('.task-status').getByText(/GLM 正在本机识别/).waitFor();
  await page.waitForFunction(()=>materialState.jobs.some(j=>j.status==='ready'));
  assert.deepEqual(errors,[]);
  await page.screenshot({path:require('node:path').join(require('node:os').tmpdir(),'study-local-ocr-qa.png')});
  console.log('Local OCR UI: model label, live progress, stop, text insertion, background task passed.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
