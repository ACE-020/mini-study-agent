const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.STUDY_QA_URL||'http://127.0.0.1:8766';
(async()=>{const browser=await chromium.launch({headless:true,channel:'chrome'});try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],requests=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().endsWith('/api/materials/revise'))requests.push(r);});
 await page.goto(base+'/#materials');await page.waitForFunction(()=>state.configured&&materialState.loaded);
 await page.locator('#material-file').setInputFiles('tmp/text-pages.pdf');await page.locator('#material-page-range').fill('1-2');await page.locator('#parse-material').click();await page.locator('#material-preview-panel').waitFor({state:'visible'});
 const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=1000;c.height=1400;const g=c.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,1000,1400);g.fillStyle='#334';g.font='28px sans-serif';for(let i=0;i<16;i++)g.fillText('Original question / reference answer '+(i+1),90,100+i*75);return c.toDataURL('image/png').split(',')[1];});
 await page.route('**/api/materials/jobs/*/pages/*',route=>route.fulfill({contentType:'image/png',body:Buffer.from(image,'base64')}));
 await page.evaluate(()=>{
  const nums=[...Array.from({length:6},(_,i)=>'一、'+(i+1)),...Array.from({length:6},(_,i)=>'二、'+(i+1)),'三','四','五','六'];
  const docs=Array.from({length:5},(_,i)=>({source:'同名试卷合集.pdf',page:i+16,page_index:i+1,layout:{anchors:[]}}));
  const items=[];
  for(let exam=0;exam<2;exam++)nums.forEach((number,n)=>{
   const page=exam===0?(n<11?1:2):(n<7?3:4),ordinal=exam===0?(page===1?n:n-11):(page===3?n:n-7);
   const paper=(exam+1)+' [数学] 2025-2026同名数学考试试题',top=.07+ordinal*.065;
   const answerPage=exam===0?2:(n<6?4:5),answerTop=exam===0?.48+n*.025:(n<6?.65+n*.035:.07+(n-6)*.065);
   const origin_regions=[{page_index:page,role:'question',bbox:[.08,top,.93,top+.055]},{page_index:answerPage,role:'answer',bbox:[.08,answerTop,.93,answerTop+.025]}];
   items.push({number,paper,topic:'极限',tags:['同类题'],question:'计算 $\\lim_{x\\to0}\\frac{\\sin x}{x}$，保留原题条件。',answer:'$1$',page_index:page,answer_page_indices:[answerPage],origin_regions});
   for(const r of origin_regions)docs[r.page_index-1].layout.anchors.push({id:'a'+items.length+'-'+r.role,paper,number,role:r.role,bbox:r.bbox});
  });
  const issues=[{message:'第19页试卷2二、2的根号范围无法辨认，请核对。',kind:'recognition',page_index:4,exercise_indices:[23],paper:items[23].paper,number:'二、2'}];
  materialState.currentJob.documents=docs;materialState.currentJob.result={exercises:items,warnings:issues.map(i=>i.message),issues};
  renderExercisePreview(items);renderMaterialWarnings(issues.map(i=>i.message),issues);
 });
 await page.locator('#fix-material-warnings').click();await page.waitForFunction(()=>!reviewReader.loading);
 const pager=await page.locator('#review-pagination-port').boundingBox(),list=await page.locator('#exercise-preview').boundingBox();
 assert.ok(pager.y+pager.height<=list.y+1);
 assert.match(await page.locator('#review-pagination-port').textContent(),/前20题.*后20题/);
 assert.ok((await page.locator('#review-pagination-port button').last().boundingBox()).height>=35);
 assert.match(await page.locator('.exercise-editor').first().locator('.original-question-number').textContent(),/一、1/);
 assert.match(await page.locator('.exercise-editor').first().locator('.paper-label').textContent(),/^1 /);
 await page.locator('#review-scope-warnings .issue-location-link').click();await page.waitForFunction(()=>!reviewReader.loading&&reviewReader.focusIndex===23);
 assert.equal(await page.locator('#preview-pagination select').inputValue(),'1');
 assert.equal(await page.locator('#origin-page-select').inputValue(),'4');
 assert.match(await page.locator('#review-browse-location').textContent(),/试卷 2.*二、2.*19 页/);
 assert.match(await page.locator('[data-preview-index="23"] .original-question-number').textContent(),/二、2/);
 assert.equal(await page.locator('.origin-question-hit.is-active[data-origin-hit="23"]').count(),1);
 const target=await page.locator('[data-preview-index="23"]').boundingBox(),viewport=await page.locator('#exercise-preview').boundingBox();
 assert.ok(target.y>=viewport.y-5&&target.y<viewport.y+viewport.height);
 assert.equal(requests.length,0);
 await page.screenshot({path:'tmp/locations-issue-desktop.png',fullPage:false});
 await page.locator('#origin-page-select').selectOption('3');await page.waitForFunction(()=>!reviewReader.loading);
 await page.locator('.origin-question-hit[data-origin-hit="19"]').click();await page.waitForFunction(()=>!reviewReader.loading&&reviewReader.focusIndex===19);
 assert.equal(await page.locator('#preview-pagination select').inputValue(),'0');
 assert.equal(await page.locator('#origin-page-select').inputValue(),'3');
 assert.deepEqual(await page.evaluate(()=>materialState.aiIndices),[19]);
 await page.locator('#origin-answer-page').click();await page.waitForFunction(()=>!reviewReader.loading);
 assert.equal(await page.locator('#origin-page-select').inputValue(),'4');
 assert.equal(await page.locator('.origin-question-hit.is-active[data-origin-hit="19"]').count(),1);
 await page.locator('#exercise-preview').evaluate(e=>e.scrollTop=0);await page.waitForTimeout(500);await page.waitForFunction(()=>!reviewReader.loading);
 assert.equal(await page.locator('#origin-page-select').inputValue(),'1');
 await page.locator('#origin-follow').uncheck();await page.locator('#exercise-preview').evaluate(e=>e.scrollTop=e.scrollHeight);await page.waitForTimeout(300);
 assert.equal(await page.locator('#origin-page-select').inputValue(),'1');
 await page.locator('#origin-follow').check();await page.waitForFunction(()=>!reviewReader.loading);assert.equal(await page.locator('#origin-page-select').inputValue(),'3');
 await page.locator('#preview-pagination select').selectOption('1');await page.waitForTimeout(150);assert.equal(await page.locator('.exercise-editor').count(),12);
 // Answer summaries and answer text both navigate to the answer, not back to the stem.
 await page.locator('[data-question-ai="23"]').click();await page.waitForFunction(()=>!reviewReader.loading);
 const answer=page.locator('[data-preview-index="23"] .preview-answer');
 await answer.locator('summary').click();await page.waitForTimeout(450);await page.waitForFunction(()=>!reviewReader.loading);
 assert.equal(await answer.getAttribute('open'),'');assert.equal(await page.locator('#origin-page-select').inputValue(),'5');
 assert.equal(await page.evaluate(()=>reviewReader.focusRole),'answer');
 assert.equal(await page.locator('[data-origin-hit="23"][data-origin-role="answer"].is-active').count(),1);
 await answer.locator('.record-body').click();await page.waitForTimeout(450);
 assert.equal(await page.locator('#origin-page-select').inputValue(),'5');
 // A manually chosen source page survives passive scrolling of the list.
 await page.locator('#origin-page-select').selectOption('2');await page.waitForFunction(()=>!reviewReader.loading);
 await page.locator('#exercise-preview').evaluate(e=>e.scrollTop+=35);await page.waitForTimeout(450);
 assert.equal(await page.locator('#origin-page-select').inputValue(),'2');
 await answer.locator('.record-body').click();await page.waitForFunction(()=>!reviewReader.loading);
 assert.equal(await page.locator('#origin-page-select').inputValue(),'5');
 // Source answers expand and reveal the corresponding answer on the left.
 await page.locator('[data-origin-hit="24"][data-origin-role="answer"]').click();await page.waitForTimeout(450);
 assert.equal(await page.evaluate(()=>reviewReader.focusIndex),24);
 assert.equal(await page.locator('[data-preview-index="24"] .preview-answer').getAttribute('open'),'');
 assert.equal(await page.locator('#origin-page-select').inputValue(),'5');
 assert.equal(await page.evaluate(()=>reviewReader.focusRole),'answer');
 assert.deepEqual(await page.evaluate(()=>materialState.aiIndices),[24]);
 const answerBox=await page.locator('[data-preview-index="24"] .preview-answer summary').boundingBox(),answerViewport=await page.locator('#exercise-preview').boundingBox();
 assert.ok(answerBox.y>=answerViewport.y-3&&answerBox.y<answerViewport.y+answerViewport.height);
 await page.evaluate(()=>{
  const body=document.querySelector('[data-preview-index="24"] .preview-answer .record-body');
  exerciseRich(body,Array.from({length:16},(_,i)=>'参考答案第 '+(i+1)+' 步：公式 $x^2+1$。').join('\n\n'));
 });
 await page.locator('#exercise-preview').evaluate(e=>e.scrollTop+=100);await page.waitForTimeout(450);
 assert.equal(await page.evaluate(()=>reviewReader.focusIndex),24);
 assert.equal(await page.locator('#origin-page-select').inputValue(),'5');
 await page.screenshot({path:'tmp/locations-answer-bidirectional.png'});
 await page.locator('#origin-question-page').click();await page.waitForFunction(()=>!reviewReader.loading);
 await page.locator('[data-origin-hit="24"][data-origin-role="question"]').click();await page.waitForTimeout(450);
 assert.equal(await page.evaluate(()=>reviewReader.focusRole),'question');
 assert.equal(await page.locator('#origin-page-select').inputValue(),'4');
 // Both source controls occupy the same row and retain the same size/style.
 const hide=page.locator('#close-material-origin'),show=page.locator('#show-batch-origin'),hideBox=await hide.boundingBox();
 await hide.click();assert.equal(await page.locator('#material-origin-dialog').isVisible(),false);
 const showBox=await show.boundingBox();assert.ok(Math.abs(hideBox.x-showBox.x)<2&&Math.abs(hideBox.y-showBox.y)<2);
 assert.equal(await show.getAttribute('class'),await hide.getAttribute('class'));
 const toolbar=await page.locator('.review-source-toolbar').boundingBox(),header=await page.locator('#batch-ai-dialog .batch-correction-header').boundingBox();
 assert.ok(toolbar.y>=header.y+header.height-1);
 await page.screenshot({path:'tmp/locations-origin-hidden.png'});
 await show.click();assert.equal(await page.locator('#material-origin-dialog').isVisible(),true);
 // The main preview offers the same answer navigation, without any model request.
 await page.locator('#close-batch-ai').click();
 await page.locator('[data-preview-index="24"] .preview-answer summary').click();await page.waitForTimeout(450);
 assert.equal(await page.locator('#batch-ai-dialog').isVisible(),true);
 assert.equal(await page.locator('#origin-page-select').inputValue(),'5');
 assert.equal(await page.locator('[data-preview-index="24"] .preview-answer').getAttribute('open'),'');
 // Known answer page without a reliable box still opens the page; it does not highlight a stem.
 await page.evaluate(()=>{
  const item=materialState.preview[24];item.origin_regions=item.origin_regions.filter(r=>r.role!=="answer");
  materialState.currentJob.documents=materialState.currentJob.documents.map(d=>({...d,layout:{anchors:d.layout.anchors.filter(a=>a.role!=="answer"||a.number!==item.number||a.paper!==item.paper)}}));
 });
 await page.locator('[data-preview-index="24"] .preview-answer .record-body').click();await page.waitForTimeout(450);
 assert.equal(await page.locator('#origin-page-select').inputValue(),'5');
 assert.equal(await page.locator('[data-origin-hit="24"].is-active').count(),0);
 assert.equal(requests.length,0);
 for(const width of [390,320]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.equal(await page.locator('#review-pagination-port select').isVisible(),true);}
 await show.click();assert.equal(await page.locator('#material-origin-scroll').isVisible(),true);
 const mobileHideBox=await hide.boundingBox();await hide.click();const mobileShowBox=await show.boundingBox();
 assert.ok(Math.abs(mobileHideBox.x-mobileShowBox.x)<2&&Math.abs(mobileHideBox.y-mobileShowBox.y)<2);
 assert.equal(await page.locator('#review-list-port').isVisible(),true);
 assert.deepEqual(errors,[]);
 console.log('PASS: paging and issue links, bidirectional question/answer navigation, answer expansion and stable browsing, manual source page retention, consistent source toggle placement on desktop/mobile, no auto model calls.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
