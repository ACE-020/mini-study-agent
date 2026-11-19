/* 数学符号键盘 / 原稿渲染编辑 / 矩阵与行列式入口回归。
   先运行 tests/serve_browser_fixture.py（默认 8766），再：
     node tests/browser_math_input.cjs
   模型与数据都是模拟的，不调用真实 API。 */
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.STUDY_QA_URL || 'http://127.0.0.1:8766';

(async () => {
  const browser = await chromium.launch({headless: true, channel: 'chrome'});
  try {
    const page = await browser.newPage({viewport: {width: 1360, height: 1000}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector('#model-status').textContent.includes('已配置'));
    await page.waitForFunction(() => window.mathInputMode && window.mathInputMode.field && window.mathInputMode.isRendered());

    const draft = page.locator('#draft');
    const field = page.locator('#formula-editor-host math-field');
    const toggle = page.locator('#draft-view-toggle');
    const value = () => draft.inputValue();
    const fieldLatex = () => field.evaluate(node => node.getValue('latex'));
    const fieldMode = () => field.evaluate(node => node.mode);
    const selection = () => draft.evaluate(node => [node.selectionStart, node.selectionEnd]);
    const setDraft = async text => {
      await draft.evaluate((node, next) => {
        node.value = next;
        node.dispatchEvent(new Event('input', {bubbles: true}));
      }, text);
    };
    const setSelection = async (start, end) => {
      await draft.evaluate((node, range) => {
        node.focus();
        node.setSelectionRange(range[0], range[1]);
        node.dispatchEvent(new Event('select'));
      }, [start, end]);
    };
    const mathCount = text => page.evaluate(
      source => window.mathInputMode.parseDraft(source).filter(part => part.type === 'math').length,
      text
    );
    const waitFieldEmpty = () => page.waitForFunction(() => {
      const node = document.querySelector('#formula-editor-host math-field');
      return Boolean(node && node.getValue('latex').trim() === '');
    });
    const clearDraft = async () => {
      await setDraft('');
      await waitFieldEmpty();
    };
    const visibleKeyboard = () => page.locator('.mk-panel:visible').first();
    const clickKey = aria => visibleKeyboard().locator(`[data-mk-aria="${aria}"]`).first().click();
    const chooseCategory = id => visibleKeyboard().locator(`[data-mk-cat="${id}"]`).click();
    const focusInMainField = () => page.evaluate(() => {
      const active = document.activeElement;
      return Boolean(active && active.closest && active.closest('.formula-editor-host'));
    });
    const openMatrixPanel = async kind => {
      await field.click();
      await visibleKeyboard().waitFor();
      await chooseCategory('geometry');
      await visibleKeyboard().locator(`[data-mk-dialog="${kind}"]`).click();
      await page.locator('.fmx-backdrop').waitFor({state: 'visible'});
    };
    const waitPanelClosed = () => page.waitForFunction(() => document.querySelector('.fmx-backdrop').hidden);

    /* 1. 首屏：默认上传页仍然显示渲染编辑，标题行唯一按钮是「查看原文」 */
    assert.equal(await field.evaluate(node => node.defaultMode), 'text');
    assert.equal(await fieldMode(), 'text');
    assert.equal(await page.locator('[data-source="image"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#image-pane').isVisible(), true);
    assert.equal(await page.locator('#formula-pane').isVisible(), true);
    assert.equal(await draft.isVisible(), false);
    assert.equal(await toggle.innerText(), '查看原文');
    assert.equal(await page.locator('#draft-count').innerText(), '0 / 80000');
    assert.equal(await page.locator('#source-panel').evaluate(node => node.classList.contains('draft-view-rendered')), true);
    assert.equal(await page.locator('.input-mode-switch').count(), 0);
    assert.equal(await page.locator('#fill-example').count(), 0);
    // 空字段不得出现幽灵 `$  $`，也不能提前写坏 #draft
    assert.equal(await fieldLatex(), '');
    assert.equal(await value(), '');

    /* 2. 真实键入的普通中英文不会变成 $...$；切原文逐字保留（本次回归重点） */
    await field.click();
    assert.equal(
      await field.evaluate(node => node === document.activeElement || Boolean(node.shadowRoot && node.shadowRoot.activeElement)),
      true
    );
    await page.keyboard.insertText('原稿 Hello 123');
    await page.waitForTimeout(120);
    assert.equal(await fieldMode(), 'text');
    const typedLatex = await fieldLatex();
    assert.ok(typedLatex.includes('原稿 Hello 123'), typedLatex);
    assert.equal(await value(), '原稿 Hello 123');
    assert.equal(await mathCount(await value()), 0);
    assert.equal(await page.locator('#draft-count').innerText(), `${'原稿 Hello 123'.length} / 80000`);

    await toggle.click();
    assert.equal(await toggle.innerText(), '查看渲染后文字');
    assert.equal(await draft.isVisible(), true);
    assert.equal(await page.locator('#formula-pane').isVisible(), false);
    assert.equal(await value(), '原稿 Hello 123');
    assert.equal(await page.locator('[data-source="image"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#image-pane').isVisible(), true);

    /* 切来源标签不应改变查看模式 / 草稿 / 上传区 */
    await page.locator('[data-source="text"]').click();
    assert.equal(await draft.isVisible(), true);
    assert.equal(await page.locator('#formula-pane').isVisible(), false);
    assert.equal(await page.locator('[data-source="text"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#image-pane').isVisible(), false);
    assert.equal(await value(), '原稿 Hello 123');
    await page.locator('[data-source="image"]').click();
    assert.equal(await draft.isVisible(), true);
    assert.equal(await page.locator('#image-pane').isVisible(), true);
    assert.equal(await value(), '原稿 Hello 123');

    /* 原文 → 渲染 → 原文，内容不被隐藏编辑器回写覆盖 */
    await toggle.click();
    await page.waitForTimeout(120);
    await toggle.click();
    assert.equal(await value(), '原稿 Hello 123');

    /* 3. 清空后普通中英文继续走普通输入；符号键盘仍插入真正的公式 */
    await setDraft('');
    await toggle.click();
    await field.click();
    await page.keyboard.type('hello');
    await page.keyboard.insertText('中文');
    await page.waitForTimeout(120);
    assert.equal(await value(), 'hello中文');
    assert.equal(await mathCount(await value()), 0);
    assert.equal(await fieldMode(), 'text');

    // 可视区是单行，但回车后的换行要留在草稿里，继续打字也不能被归一化吞掉
    await field.evaluate(node => {
      node.focus();
      node.executeCommand('moveToMathfieldEnd');
    });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(120);
    await page.keyboard.type('second');
    await page.waitForTimeout(120);
    assert.equal(await value(), 'hello中文\nsecond');

    await chooseCategory('fraction');
    await clickKey('分式');
    await page.waitForTimeout(120);
    const afterFormula = await value();
    assert.ok(afterFormula.startsWith('hello中文'), afterFormula);
    assert.equal(await mathCount(afterFormula), 1);
    assert.ok(afterFormula.includes('\\frac'));
    assert.equal((afterFormula.match(/\$/g) || []).length, 2);
    const inlineFormula = await page.evaluate(text => {
      const parts = window.mathInputMode.parseDraft(text).filter(part => part.type === 'math');
      return parts.length ? parts[0].value : '';
    }, afterFormula);
    // #@ 的隐式前置参数捕获会把整段普通文字吞进分子；修复后 plain 必须留在公式外
    assert.ok(!inlineFormula.includes('hello'), inlineFormula);
    assert.ok(!inlineFormula.includes('中文'), inlineFormula);
    assert.ok(!inlineFormula.includes('second'), inlineFormula);
    assert.ok(afterFormula.startsWith('hello中文\nsecond'), afterFormula);
    assert.ok(await field.evaluate(node => Boolean(node.shadowRoot && node.shadowRoot.querySelector('.ML__mfrac'))));

    /* 4. 粘贴带换行的文字：原文保留换行，不变成 $...$ */
    await toggle.click();
    await setDraft('');
    await toggle.click();
    await field.click();
    await field.evaluate(node => {
      const data = new DataTransfer();
      data.setData('text/plain', '粘贴第一行\n粘贴第二行');
      node.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clipboardData: data
      }));
    });
    await page.waitForTimeout(150);
    assert.equal(await value(), '粘贴第一行\n粘贴第二行');
    assert.equal(await mathCount(await value()), 0);

    /* 粘贴混合公式同样保留原始文本与换行 */
    await setDraft('');
    await field.click();
    await field.evaluate(node => {
      const data = new DataTransfer();
      data.setData('text/plain', '粘贴公式 $x^2$ 换行\n第二行');
      node.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clipboardData: data
      }));
    });
    await page.waitForTimeout(150);
    assert.equal(await value(), '粘贴公式 $x^2$ 换行\n第二行');
    assert.equal(await mathCount(await value()), 1);

    /* 5. OCR / 程序化写回与清空：草稿保持原样，字数同步 */
    const programmatic = 'OCR 第一行\nOCR 第二行 $a+b$';
    await page.evaluate(text => {
      const node = document.querySelector('#draft');
      node.value = text;
      node.dispatchEvent(new Event('input', {bubbles: true}));
    }, programmatic);
    await page.waitForTimeout(150);
    assert.equal(await value(), programmatic);
    assert.ok((await fieldLatex()).includes('a+b'));
    assert.equal(await mathCount(programmatic), 1);
    assert.equal(await page.locator('#draft-count').innerText(), `${programmatic.length} / 80000`);
    await page.evaluate(() => {
      const node = document.querySelector('#draft');
      node.value = '';
      node.dispatchEvent(new Event('input', {bubbles: true}));
    });
    await page.waitForTimeout(120);
    assert.equal(await value(), '');
    assert.equal(await page.locator('#draft-count').innerText(), '0 / 80000');
    assert.equal((await fieldLatex()).trim(), '');

    /* 6. 原文视图的文本符号键盘：光标 / 一层 $ / 价格字面 $ 仍正常 */
    await toggle.click();
    await setDraft('前文后文');
    await setSelection(2, 2);
    await visibleKeyboard().waitFor();
    await chooseCategory('fraction');
    await clickKey('分式');
    assert.equal(await value(), '前文$\\frac{}{}$后文');
    assert.deepEqual(await selection(), [9, 9]);
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'draft');

    await setDraft('价格 $5 到 $10');
    await setSelection(8, 8);
    const currency = await value();
    assert.equal(await page.evaluate(text => window.mathInputMode.parseDraft(text).filter(part => part.type === 'math').length, currency), 0);
    await chooseCategory('basic');
    await clickKey('加号');
    const currencyAfter = await value();
    assert.ok(currencyAfter.includes('\\('));
    assert.ok(currencyAfter.includes('\\)'));
    assert.ok(!currencyAfter.includes('$$'));

    /* 7. 原文往返：$$ 与换行逐字保留；在字段里只改公式不吞原文 */
    const mixedText = '第一行\n第二行\n\n$$\\frac{1}{x}$$\n\n结束';
    await setDraft(mixedText);
    await toggle.click();
    await field.waitFor();
    const loadedLatex = await fieldLatex();
    assert.ok(loadedLatex.includes('\\frac{1}{x}'));
    assert.equal(await value(), mixedText);
    assert.ok(await field.evaluate(node => Boolean(node.shadowRoot && node.shadowRoot.querySelector('.ML__mfrac'))));
    await field.evaluate(node => node.setValue('第一行 第二行 $$\\frac{1}{x}+1$$ 结束', {
      mode: 'text',
      format: 'latex',
      insertionMode: 'replaceAll'
    }));
    await page.waitForTimeout(150);
    await toggle.click();
    const edited = await value();
    assert.ok(edited.startsWith('第一行\n第二行'));
    assert.ok(edited.includes('$$\\frac{1}{x}+1$$'));
    assert.equal((edited.match(/\$\$/g) || []).length, 2);

    /* 8. 矩阵 / 行列式两个相邻入口、各自标题、手动预览与插入 */
    await setDraft('');
    await toggle.click();
    await waitFieldEmpty();
    await field.click();
    await visibleKeyboard().waitFor();
    await chooseCategory('geometry');
    const matrixKey = visibleKeyboard().locator('[data-mk-dialog="matrix"]');
    const determinantKey = visibleKeyboard().locator('[data-mk-dialog="determinant"]');
    assert.equal(await matrixKey.isVisible(), true);
    assert.equal(await determinantKey.isVisible(), true);
    assert.match(await matrixKey.innerText(), /矩阵/);
    assert.match(await determinantKey.innerText(), /行列式/);
    const keyBoxes = await Promise.all([matrixKey.boundingBox(), determinantKey.boundingBox()]);
    assert.ok(Math.abs(keyBoxes[0].y - keyBoxes[1].y) < 2, '矩阵 / 行列式键应在同一行相邻显示');

    await matrixKey.click();
    await page.locator('.fmx-backdrop').waitFor({state: 'visible'});
    assert.equal(await page.locator('#fmx-title').innerText(), '插入矩阵');
    assert.equal(await page.locator('[data-fmx-mode="manual"]').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('[data-fmx-content="manual"]').isVisible(), true);
    assert.equal(await page.locator('[data-fmx-content="ai"]').isVisible(), false);
    assert.equal(await page.locator('.fmx-manual-preview').getAttribute('aria-label'), '2 行 2 列矩阵预览');
    await page.locator('#fmx-rows').fill('2');
    await page.locator('#fmx-cols').fill('3');
    assert.equal(await page.locator('.fmx-manual-preview').getAttribute('aria-label'), '2 行 3 列矩阵预览');
    assert.ok(await page.locator('.fmx-manual-preview .katex').count() > 0);
    await page.locator('[data-fmx-content="manual"] .fmx-primary').click();
    await waitPanelClosed();
    const matrixDraft = await value();
    assert.ok(matrixDraft.includes('\\begin{pmatrix}'), matrixDraft);
    const matrixBody = await page.evaluate(text => {
      const parts = window.mathInputMode.parseDraft(text).filter(part => part.type === 'math');
      return parts.length ? parts[0].value : '';
    }, matrixDraft);
    assert.equal((matrixBody.match(/&/g) || []).length, 4);
    assert.equal((matrixBody.match(/\\\\/g) || []).length, 1);

    // 行列式用例必须从空草稿开始，不能把前面 2×3 矩阵的 & 一起算进来
    await clearDraft();
    await field.click();
    await visibleKeyboard().waitFor();
    await determinantKey.click();
    await page.locator('.fmx-backdrop').waitFor({state: 'visible'});
    assert.equal(await page.locator('#fmx-title').innerText(), '插入行列式');
    assert.equal(await page.locator('#fmx-order').isVisible(), true);
    assert.equal(await page.locator('#fmx-rows').isVisible(), false);
    assert.equal(await page.locator('#fmx-cols').isVisible(), false);
    assert.equal(await page.locator('.fmx-manual-preview').getAttribute('aria-label'), '2 阶行列式预览');
    await page.locator('#fmx-order').fill('3');
    assert.equal(await page.locator('.fmx-manual-preview').getAttribute('aria-label'), '3 阶行列式预览');
    await page.locator('[data-fmx-content="manual"] .fmx-primary').click();
    await waitPanelClosed();
    const determinantDraft = await value();
    assert.ok(determinantDraft.includes('\\begin{vmatrix}'), determinantDraft);
    const determinantBody = await page.evaluate(text => {
      const parts = window.mathInputMode.parseDraft(text).filter(part => part.type === 'math');
      return parts.length ? parts[0].value : '';
    }, determinantDraft);
    assert.equal((determinantBody.match(/&/g) || []).length, 6);
    assert.equal((determinantBody.match(/\\\\/g) || []).length, 2);

    /* 9. 取消面板不改原稿、不丢光标 */
    await clearDraft();
    await setDraft('abc');
    await field.evaluate(node => node.executeCommand('moveToMathfieldEnd'));
    await openMatrixPanel('matrix');
    await page.locator('#fmx-rows').fill('4');
    await page.locator('#fmx-cols').fill('4');
    await page.keyboard.press('Escape');
    await waitPanelClosed();
    assert.equal(await value(), 'abc');
    assert.equal(await focusInMainField(), true);

    /* 10. AI 成功：手动 / AI 内容区互斥，结果按当前类型插入 */
    await clearDraft();
    await openMatrixPanel('determinant');
    await page.locator('[data-fmx-mode="ai"]').click();
    assert.equal(await page.locator('[data-fmx-content="manual"]').isVisible(), false);
    assert.equal(await page.locator('[data-fmx-content="ai"]').isVisible(), true);
    assert.equal(await page.locator('#fmx-ai-label').innerText(), '用一句话描述行列式');
    await page.locator('.fmx-textarea').fill('3 阶单位行列式');
    await page.locator('[data-fmx-content="ai"] .fmx-row .fmx-primary').click();
    await page.waitForFunction(() => document.querySelector('.fmx-status').textContent.includes('已生成'));
    await page.locator('[data-fmx-content="ai"] .fmx-preview').waitFor({state: 'visible'});
    assert.ok(await page.locator('[data-fmx-content="ai"] .fmx-preview .katex').count() > 0);
    await page.locator('[data-fmx-content="ai"] .fmx-actions .fmx-primary').click();
    await waitPanelClosed();
    const aiDraft = await value();
    assert.ok(aiDraft.includes('\\begin{vmatrix}'), aiDraft);
    assert.equal(await mathCount(aiDraft), 1);

    /* 11. 快速切换 / 关闭后异步返回不串模式、不落旧结果 */
    await clearDraft();
    await setDraft('保持');
    await openMatrixPanel('matrix');
    await page.locator('[data-fmx-mode="ai"]').click();
    await page.locator('.fmx-textarea').fill('等待生成的矩阵');
    await page.locator('[data-fmx-content="ai"] .fmx-row .fmx-primary').click();
    await page.locator('[data-fmx-mode="manual"]').click();
    assert.equal(await page.locator('[data-fmx-content="manual"]').isVisible(), true);
    assert.equal(await page.locator('[data-fmx-content="ai"]').isVisible(), false);
    await page.waitForTimeout(1400);
    assert.equal(await page.locator('[data-fmx-content="manual"]').isVisible(), true);
    assert.equal(await page.locator('[data-fmx-content="ai"]').isVisible(), false);
    assert.equal(await value(), '保持');

    await page.locator('[data-fmx-mode="ai"]').click();
    await page.locator('.fmx-textarea').fill('等待生成的矩阵');
    await page.locator('[data-fmx-content="ai"] .fmx-row .fmx-primary').click();
    await page.keyboard.press('Escape');
    await waitPanelClosed();
    await page.waitForTimeout(1400);
    assert.equal(await value(), '保持');
    await openMatrixPanel('matrix');
    assert.equal(await page.locator('[data-fmx-mode="manual"]').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('[data-fmx-content="manual"]').isVisible(), true);
    assert.equal(await page.locator('[data-fmx-content="ai"]').isVisible(), false);
    await page.keyboard.press('Escape');
    await waitPanelClosed();

    /* 12. 键盘展开时点提交不丢点击；提交携带标准 LaTeX */
    await toggle.click();
    await setDraft('');
    await setDraft('提交测试 $x^2$');
    await toggle.click();
    await field.click();
    await visibleKeyboard().waitFor();
    const chatRequest = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/chat'));
    await page.locator('#organize-submit').click();
    const request = await chatRequest;
    assert.ok(request.postDataJSON().message.includes('提交测试 $x^2$'));
    await page.waitForFunction(() => !state.busy);
    assert.match(await page.locator('#organize-submit span').innerText(), /已提交/);

    /* 13. 390px：渲染编辑、键盘、两个矩阵面板都不撑破页面 */
    await page.setViewportSize({width: 390, height: 844});
    await page.evaluate(() => window.mathInputMode.setView('rendered'));
    await field.click();
    await visibleKeyboard().waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await openMatrixPanel('matrix');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('[data-fmx-mode="ai"]').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.keyboard.press('Escape');
    await waitPanelClosed();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

    /* 14. 未配置模型：AI 区禁用并说明，手动矩阵仍可用 */
    const noConfig = await browser.newPage({viewport: {width: 900, height: 900}});
    await noConfig.route('**/api/status', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({configured: false, version: 'workspace-v20'})
    }));
    await noConfig.goto(base);
    await noConfig.waitForFunction(() => window.mathInputMode && window.mathInputMode.field && window.mathInputMode.isRendered());
    const noConfigField = noConfig.locator('#formula-editor-host math-field');
    await noConfigField.click();
    await noConfig.locator('.mk-panel:visible').first().waitFor();
    await noConfig.locator('.mk-panel:visible').first().locator('[data-mk-cat="geometry"]').click();
    await noConfig.locator('.mk-panel:visible').first().locator('[data-mk-dialog="matrix"]').click();
    await noConfig.locator('.fmx-backdrop').waitFor({state: 'visible'});
    await noConfig.locator('[data-fmx-mode="ai"]').click();
    assert.equal(await noConfig.locator('.fmx-textarea').isDisabled(), true);
    assert.equal(await noConfig.locator('[data-fmx-content="ai"] .fmx-row .fmx-primary').isDisabled(), true);
    assert.match(await noConfig.locator('.fmx-status').innerText(), /未配置|需要模型/);
    await noConfig.locator('[data-fmx-mode="manual"]').click();
    assert.equal(await noConfig.locator('[data-fmx-content="manual"]').isVisible(), true);
    assert.equal(await noConfig.locator('[data-fmx-content="manual"] .fmx-primary').isDisabled(), false);
    await noConfig.close();

    assert.deepEqual(errors, []);
    console.log('PASS: 普通文字键入/粘贴/OCR 往返、原文切换、符号公式、矩阵与行列式入口、AI 成功/快速切换/取消、无配置与 390px。');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
