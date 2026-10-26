/* Optional browser checks. First run serve_browser_fixture.py; no real API is used. */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.STUDY_QA_URL || 'http://127.0.0.1:8766';

function contrast(a, b) {
  function luminance(color) {
    const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => {
      v /= 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

(async () => {
  const browser = await chromium.launch({headless: true, channel: 'chrome'});
  const errors = [];
  async function fresh(width=1440, height=1000) {
    const context = await browser.newContext({viewport: {width, height}});
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector('#model-status').textContent.includes('已配置'));
    return page;
  }
  async function submit(page, text) {
    await page.locator('[data-source="text"]').click();
    await page.locator('#draft').fill(text);
    await page.locator('#organize-submit').click();
  }
  async function idle(page) {
    await page.locator('#stop-request').waitFor({state:'hidden'});
  }
  try {
    const page = await fresh();
    await submit(page, '信息不足：请整理错题'); await idle(page);
    assert.equal(await page.locator('#source-panel').isVisible(), true);
    assert.equal(await page.locator('#source-summary').isVisible(), false);
    assert.equal(await page.locator('#organize-submit').isDisabled(), true);
    assert.match(await page.locator('#organize-submit').innerText(), /对话中补充/);
    const colors = await page.locator('.message.user .message-body').first().evaluate(node => ({color:getComputedStyle(node).color, bg:getComputedStyle(node).backgroundColor}));
    assert.ok(contrast(colors.color, colors.bg) >= 7, JSON.stringify(colors));
    await page.locator('#organize-follow').fill('补充：我的答案是 x，正确答案 2x。');
    await page.locator('#organize-follow').press('Control+Enter'); await idle(page);
    await page.locator('#source-summary').waitFor({state:'visible'});
    assert.equal(await page.locator('#source-panel').isVisible(), false);
    const layout = await page.locator('#organize-workspace').evaluate(node => getComputedStyle(node).gridTemplateColumns);
    assert.equal(layout.split(' ').length, 1);
    assert.equal(await page.locator('#total-count').innerText(), '1');
    await page.locator('#toggle-source').click();
    assert.equal(await page.locator('#organize-submit').isDisabled(), true);
    assert.match(await page.locator('#organize-submit').innerText(), /已收录/);
    await page.locator('#draft').fill('改后的题目，信息不足');
    assert.equal(await page.locator('#organize-submit').isEnabled(), true);
    await page.locator('#organize-submit').click(); await idle(page);
    assert.match(await page.locator('#organize-submit').innerText(), /对话中补充/);
    await page.locator('#draft').fill('信息不足：请整理错题');
    await page.locator('#toggle-source').click();
    // A genuine duplicate result still counts as collected, without increasing JSON records.
    const duplicate = await fresh();
    await submit(duplicate, '求 x² 的导数，我答 x，正确答案 2x'); await idle(duplicate);
    assert.equal(await duplicate.locator('#source-panel').isVisible(), false);
    assert.equal(await duplicate.locator('#total-count').innerText(), '1');
    assert.match(await duplicate.locator('#organize-trace').innerText(), /处理过程/);
    if(process.env.STUDY_QA_SCREENSHOT)await duplicate.screenshot({path:process.env.STUDY_QA_SCREENSHOT, fullPage:true});
    await duplicate.locator('#new-mistake').click();
    await duplicate.locator('#source-panel').waitFor({state:'visible'});
    assert.equal(await duplicate.locator('#source-panel').isVisible(), true);
    assert.equal(await duplicate.locator('#draft').inputValue(), '');
    assert.equal(await duplicate.locator('#total-count').innerText(), '1');
    assert.equal(await duplicate.locator('.message').count(), 0);

    const claim = await fresh();
    await submit(claim, '只说已保存'); await idle(claim);
    assert.equal(await claim.locator('#source-summary').isVisible(), false);
    assert.equal(await claim.locator('#source-panel').isVisible(), true);

    for(const trigger of ['button', 'Escape', 'Control+c']) {
      const stopped = await fresh(1280, 720);
      await submit(stopped, `等待停止：保留并修改原文 ${trigger}`);
      const button = stopped.locator('#organize-operation [data-stop-request]');
      await button.waitFor({state:'visible'});
      const box = await button.boundingBox();
      assert.ok(box.y >= 0 && box.y + box.height <= 720, JSON.stringify(box));
      if(trigger === 'button')await button.click(); else await stopped.keyboard.press(trigger);
      await idle(stopped);
      assert.match(await stopped.locator('#draft').inputValue(), /保留并修改原文/);
      assert.equal(await stopped.locator('#draft').evaluate(node => node.readOnly), false);
      assert.equal(await stopped.locator('#organize-submit').isEnabled(), true);
      assert.equal(await stopped.locator('#source-summary').isVisible(), false);
      await stopped.locator('#draft').fill('修改后的文字');
      await stopped.locator('#organize-submit').click(); await idle(stopped);
      assert.match(await stopped.locator('.message.user').last().innerText(), /修改后的文字/);
      assert.match(await stopped.locator('.message.assistant').last().innerText(), /别漏掉幂指数/);
      assert.doesNotMatch(await stopped.locator('#organize-messages').innerText(), /这条迟到/);
    }
    const copying = await fresh(1280, 720);
    await submit(copying, '等待停止：选中文字仍允许复制');
    await copying.locator('#draft').focus();
    await copying.locator('#draft').press('Control+a');
    await copying.locator('#draft').press('Control+c');
    assert.equal(await copying.locator('#organize-operation').isVisible(), true);
    await copying.keyboard.press('Escape'); await idle(copying);

    const followStop = await fresh(1280, 720);
    await submit(followStop, '信息不足'); await idle(followStop);
    await followStop.locator('#organize-follow').fill('等待停止：保留这段补充\n第二行');
    await followStop.locator('#organize-follow').press('Control+Enter');
    await followStop.locator('#organize-operation [data-stop-request]').click();
    await idle(followStop);
    assert.equal(await followStop.locator('#organize-follow').inputValue(), '等待停止：保留这段补充\n第二行');
    assert.equal(await followStop.locator('#organize-submit').isDisabled(), true);

    const failed = await fresh();
    await submit(failed, '保存前失败'); await idle(failed);
    assert.equal(await failed.locator('#organize-submit').isEnabled(), true);
    assert.equal(await failed.locator('#source-summary').isVisible(), false);
    const partiallySaved = await fresh();
    await submit(partiallySaved, '保存后失败'); await idle(partiallySaved);
    assert.equal(await partiallySaved.locator('#source-panel').isVisible(), false);
    assert.match(await partiallySaved.locator('.message.error').innerText(), /回答失败/);

    const mobile = await fresh(390, 844);
    await mobile.locator('#image-input').setInputFiles({name:'test.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')});
    await mobile.locator('#recognize-button').click();
    await mobile.locator('#ocr-operation [data-stop-request]').waitFor({state:'visible'});
    await mobile.locator('#ocr-operation [data-stop-request]').click();
    await idle(mobile);
    assert.equal(await mobile.locator('#image-preview').isVisible(), true);
    assert.equal(await mobile.locator('#draft').inputValue(), '');
    await mobile.locator('#recognize-button').click();
    await idle(mobile);
    assert.equal(await mobile.locator('#image-pane').isVisible(), true);
    assert.match(await mobile.locator('#draft').inputValue(), /参考答案/);
    await mobile.locator('[data-source="text"]').click();
    assert.equal(await mobile.locator('#image-pane').isVisible(), false);
    await mobile.locator('[data-source="image"]').click();
    assert.equal(await mobile.locator('#image-preview').isVisible(), true);
    await mobile.locator('#organize-submit').click(); await idle(mobile);
    assert.equal(await mobile.locator('#source-panel').isVisible(), false);
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    console.log('PASS: contrast, clarify, save, deduplicate, no false collection, three stop controls, copy selection, edit/resend, follow-up draft, failure states, OCR insertion, source switching and mobile layout.');
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode=1;});
