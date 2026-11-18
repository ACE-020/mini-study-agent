/* 数学符号键盘 / 公式模式回归。
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
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector('#model-status').textContent.includes('已配置'));
    await page.waitForFunction(() => window.mathInputMode && window.mathInputMode.field);
    await page.locator('[data-source="text"]').click();

    const draft = page.locator('#draft');
    const selection = () => draft.evaluate(node => [node.selectionStart, node.selectionEnd]);
    const value = () => draft.inputValue();
    const setSelection = async (start, end) => {
      await draft.evaluate((node, range) => {
        node.focus();
        node.setSelectionRange(range[0], range[1]);
        node.dispatchEvent(new Event('select'));
      }, [start, end]);
    };
    // 文字键盘和公式编辑器键盘会同时存在于 DOM 里；所有点击都限定在当前可见的面板内。
    const visibleKeyboard = () => page.locator('.mk-panel:visible').first();
    const clickKey = (aria) => visibleKeyboard().locator(`[data-mk-aria="${aria}"]`).first().click();
    const chooseCategory = (id) => visibleKeyboard().locator(`[data-mk-cat="${id}"]`).click();
    const openMatrixPanel = () => visibleKeyboard().locator('[data-mk-aria^="矩阵或行列式"]').click();
    const focusId = () => page.evaluate(() => document.activeElement && document.activeElement.id);

    /* 1. 展开 / 分类 / 插入时焦点和光标保持；文本中间插入只包一层 $ */
    await draft.fill('前文后文');
    await setSelection(2, 2);
    await chooseCategory('fraction');
    await clickKey('分式');
    assert.equal(await value(), '前文$\\frac{}{}$后文');
    assert.deepEqual(await selection(), [9, 9]);
    assert.equal(await focusId(), 'draft');
    assert.equal((await value()).split('$').length - 1, 2);

    await chooseCategory('basic');
    await clickKey('加号');
    assert.equal(await value(), '前文$\\frac{+}{}$后文');
    assert.equal((await value()).split('$').length - 1, 2);
    assert.deepEqual(await selection(), [10, 10]);

    /* 2. 字面 %、{、} 插入有效 LaTeX；{ } 仍是结构分组键 */
    await draft.fill('abc');
    await setSelection(1, 1);
    await clickKey('百分号');
    assert.equal(await value(), 'a$\\%$bc');
    await draft.fill('abc');
    await setSelection(1, 1);
    await clickKey('左花括号');
    assert.equal(await value(), 'a$\\{$bc');
    await draft.fill('abc');
    await setSelection(1, 1);
    await clickKey('右花括号');
    assert.equal(await value(), 'a$\\}$bc');
    await draft.fill('x');
    await setSelection(0, 1);
    await chooseCategory('fraction');
    await clickKey('花括号分组');
    assert.equal(await value(), '${x}$');

    /* 3. 已有 $...$ / $$...$$ / 选区：不叠第二层定界符 */
    await draft.fill('$x$');
    await setSelection(3, 3);
    await chooseCategory('basic');
    await clickKey('加号');
    assert.equal(await value(), '$x+$');
    await draft.fill('$x$');
    await setSelection(0, 3);
    await chooseCategory('fraction');
    await clickKey('分式');
    assert.equal(await value(), '$\\frac{x}{}$');
    await draft.fill('$$\\frac{1}{x}$$');
    await setSelection(4, 4);
    await chooseCategory('basic');
    await clickKey('加号');
    const blockText = await value();
    assert.equal((blockText.split('$').length - 1), 4);
    assert.ok(blockText.includes('+'));
    assert.ok(!blockText.includes('$$$'));

    /* 4. 普通价格里的 $ 不被当成现有公式；靠近字面 $ 时用 \(...\) 避免拼出 $$ */
    await draft.fill('价格 $5 到 $10');
    await setSelection(8, 8);
    const currency = await value();
    assert.equal(await page.evaluate(text => window.mathInputMode.parseDraft(text).filter(part => part.type === 'math').length, currency), 0);
    await clickKey('加号');
    const currencyAfter = await value();
    assert.ok(currencyAfter.includes('\\('));
    assert.ok(currencyAfter.includes('\\)'));
    assert.ok(!currencyAfter.includes('$$'));

    /* 5. 文字 / 公式往返：$$ 在编辑器里是公式而不是纯文字，原稿逐字保留 */
    const mixedText = '第一行\n第二行\n\n$$\\frac{1}{x}$$\n\n结束';
    await draft.fill(mixedText);
    await page.locator('[data-input-mode="formula"]').click();
    const field = page.locator('#formula-editor-host math-field');
    await field.waitFor();
    await page.waitForFunction(() => document.querySelector('#formula-editor-host math-field').shadowRoot);
    const fieldValue = await field.evaluate(node => node.value || node.getValue('latex'));
    assert.ok(fieldValue.includes('\\frac{1}{x}'));
    assert.ok(!fieldValue.includes('$$'));
    assert.ok(await field.evaluate(node => Boolean(node.shadowRoot && node.shadowRoot.querySelector('.ML__mfrac'))));
    await page.locator('[data-input-mode="text"]').click();
    assert.equal(await value(), mixedText);

    /* 6. 编辑块级公式：保留两处换行和原 $$ 定界符 */
    await page.locator('[data-input-mode="formula"]').click();
    await field.waitFor();
    await field.evaluate(node => node.setValue('\\text{第一行 第二行 }\\displaystyle \\frac{1}{x}+1\\text{ 结束}'));
    await page.waitForTimeout(100);
    await page.locator('[data-input-mode="text"]').click();
    const edited = await value();
    assert.ok(edited.startsWith('第一行\n第二行'));
    assert.ok(edited.includes('$$\\frac{1}{x}+1$$'));
    assert.equal((edited.match(/\$\$/g) || []).length, 2);

    /* 7. 公式模式下填入示例：编辑器同步，切回文字仍与示例一致 */
    await draft.fill(mixedText);
    await page.locator('[data-input-mode="formula"]').click();
    await field.waitFor();
    await page.locator('#fill-example').click();
    await page.waitForTimeout(100);
    const example = await value();
    assert.ok(example.includes('笔记：'));
    const exampleLatex = await field.evaluate(node => node.value || node.getValue('latex'));
    assert.ok(exampleLatex.includes('\\text{笔记'));
    await page.locator('[data-input-mode="text"]').click();
    assert.equal(await value(), example);

    /* 8. 矩阵面板：取消不改原文，插入得到一层块级公式 */
    await draft.fill('abc');
    await setSelection(1, 1);
    await chooseCategory('geometry');
    await openMatrixPanel();
    await page.locator('.fmx-backdrop').waitFor({state: 'visible'});
    await page.locator('.fmx-seg-button[data-kind="determinant"]').click();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('.fmx-backdrop').hidden);
    assert.equal(await value(), 'abc');
    assert.equal(await focusId(), 'draft');
    // 取消矩阵面板只还焦点，不应改光标；第二次插入应落在原来的第 1 个字符后。
    assert.deepEqual(await selection(), [1, 1]);

    await openMatrixPanel();
    await page.locator('.fmx-backdrop').waitFor({state: 'visible'});
    await page.locator('.fmx-seg-button[data-kind="determinant"]').click();
    await page.locator('.fmx-size input[aria-label="行数"]').fill('2');
    await page.locator('.fmx-size input[aria-label="列数"]').fill('2');
    await page.locator('.fmx-size .fmx-primary').click();
    await page.waitForFunction(() => document.querySelector('.fmx-backdrop').hidden);
    const matrix = await value();
    assert.ok(matrix.startsWith('a$$\\begin{vmatrix}'));
    assert.ok(matrix.includes('\\end{vmatrix}$$bc'));
    assert.ok(!matrix.includes('$$$'));

    /* 9. 键盘展开时点击“交给 AI 整理”：点击不能因为面板收起而丢失 */
    await draft.fill('提交测试 $x^2$');
    await setSelection(0, 0);
    const chatRequest = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/chat'));
    await page.locator('#organize-submit').click();
    const request = await chatRequest;
    assert.ok(request.postDataJSON().message.includes('提交测试 $x^2$'));
    await page.waitForFunction(() => !state.busy);
    assert.match(await page.locator('#organize-submit span').innerText(), /已提交/);

    /* 10. 公式模式下提交：先 flush 编辑器，最后一段输入也在请求里 */
    await draft.fill('公式提交 $x$');
    await page.locator('[data-input-mode="formula"]').click();
    await field.waitFor();
    await field.evaluate(node => {
      node.focus();
      node.executeCommand('moveToMathfieldEnd');
      node.executeCommand(['insert', '+1']);
    });
    await page.waitForTimeout(100);
    const formulaRequest = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/chat'));
    await page.locator('#organize-submit').click();
    const formulaMessage = (await formulaRequest).postDataJSON().message;
    assert.ok(formulaMessage.includes('公式提交'));
    assert.ok(formulaMessage.includes('+1'));
    await page.waitForFunction(() => !state.busy);

    /* 11. 390px：键盘、公式编辑器和矩阵面板不撑破页面 */
    await page.setViewportSize({width: 390, height: 844});
    await page.locator('[data-input-mode="text"]').click();
    await draft.fill('窄屏');
    await setSelection(0, 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await openMatrixPanel();
    await page.locator('.fmx-backdrop').waitFor({state: 'visible'});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.keyboard.press('Escape');

    assert.deepEqual(errors, []);
    console.log('PASS: 符号键盘插入、字面符号、公式边界、价格启发式、模式往返、矩阵取消、两个提交入口与 390px 布局。');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
