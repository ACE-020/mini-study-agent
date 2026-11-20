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
      // Escape 关闭面板时会把焦点还给 math-field。再次点击已聚焦的编辑器
      // 不会触发 focusin。先移开焦点，让测试从一次新的聚焦开始。
      const fieldFocused = await field.evaluate(node => {
        const active = document.activeElement;
        return active === node || Boolean(node.shadowRoot && node.shadowRoot.activeElement);
      });
      if (fieldFocused) await page.locator('#page-title').click();
      await field.click();
      await visibleKeyboard().waitFor();
      await chooseCategory('geometry');
      await visibleKeyboard().locator(`[data-mk-dialog="${kind}"]`).click();
      await page.locator('.fmx-backdrop').waitFor({state: 'visible'});
    };
    const waitPanelClosed = () => page.waitForFunction(() => document.querySelector('.fmx-backdrop').hidden);
    // 面板关闭与 MathLive → #draft 的写回不在同一帧：关闭后立刻读 #draft 可能还是空串。
    // 只等面板 hidden 不够，回归测试要等目标内容真正落进 textarea 再断言。
    const waitDraftContains = text => page.waitForFunction(needle => {
      const node = document.querySelector('#draft');
      return Boolean(node && node.value.includes(needle));
    }, text);
    const shapeOfLatex = latex => {
      const body = String(latex || '')
        .replace(/^\\begin\{[^}]+\}/, '')
        .replace(/\\end\{[^}]+\}$/, '');
      return body.split(/\\\\/).map(row => row.split('&').length);
    };
    const shapeOfDraft = text => page.evaluate(source => {
      const parts = window.mathInputMode.parseDraft(source).filter(part => part.type === 'math');
      if (!parts.length) return [];
      const body = parts[0].value
        .replace(/^\\begin\{[^}]+\}/, '')
        .replace(/\\end\{[^}]+\}$/, '');
      return body.split(/\\\\/).map(row => row.split('&').length);
    }, text);

    /* 1. 首屏：默认上传页仍然显示渲染编辑，标题行唯一按钮是「查看原文」 */
    assert.equal(await field.evaluate(node => node.defaultMode), 'text');
    assert.equal(await fieldMode(), 'text');
    assert.equal(await page.locator('[data-source="image"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#image-pane').isVisible(), true);
    assert.equal(await page.locator('#formula-pane').isVisible(), true);
    assert.equal(await draft.isVisible(), false);
    assert.equal(await toggle.innerText(), '查看原文');
    assert.deepEqual(await page.locator('.editor-heading-actions .text-button').allTextContents(), ['撤回', '重做', '查看原文']);
    assert.equal(await page.locator('#draft-undo').isDisabled(), true);
    assert.equal(await page.locator('#draft-redo').isDisabled(), true);
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

    /* 7b. 空分式回归：渲染时给空分子/分母补可填占位（横线有宽度），
       从已填分式删空最后一格时不能连分式一起删；原文不写占位符。 */
    await page.evaluate(() => window.mathInputMode.setView('source'));
    await setDraft('$$\\frac{}{}$$');
    await page.evaluate(() => window.mathInputMode.setView('rendered'));
    await page.waitForFunction(() => {
      const node = document.querySelector('#formula-editor-host math-field');
      return Boolean(node && node.shadowRoot && node.shadowRoot.querySelector('.ML__mfrac'));
    });
    const fracLineWidth = () => field.evaluate(node => {
      const line = node.shadowRoot && node.shadowRoot.querySelector('.ML__frac-line');
      return line ? line.getBoundingClientRect().width : 0;
    });
    assert.ok((await fracLineWidth()) > 4, '空分式的横线必须由可填占位撑开');
    assert.equal(await value(), '$$\\frac{}{}$$');
    assert.ok(!(await value()).includes('\\placeholder'));

    await page.evaluate(() => window.mathInputMode.setView('source'));
    await setDraft('$$\\frac{1}{2}$$');
    await page.evaluate(() => window.mathInputMode.setView('rendered'));
    await page.waitForFunction(() => {
      const node = document.querySelector('#formula-editor-host math-field');
      return Boolean(node && node.getValue('latex').includes('\\frac{1}{2}'));
    });
    const fractionBranch = name => field.evaluate((node, branch) => {
      const model = node._mathfield.model;
      for (let i = 0; i <= model.lastOffset; i += 1) {
        const atom = model.at(i);
        if (atom && atom.type === 'genfrac') {
          return model.getBranchRange(model.offsetOf(atom), branch);
        }
      }
      return null;
    }, name);
    const putFieldCaret = offset => field.evaluate((node, value) => {
      node.focus();
      node.position = value;
    }, offset);

    const numerator = await fractionBranch('above');
    assert.ok(numerator, '分式分子应该可定位');
    await putFieldCaret(numerator[1]);
    await page.keyboard.press('Backspace');
    await page.waitForFunction(() => document.querySelector('#draft').value === '$$\\frac{}{2}$$');
    const denominator = await fractionBranch('below');
    assert.ok(denominator, '分式分母应该可定位');
    await putFieldCaret(denominator[1]);
    await page.keyboard.press('Backspace');
    await page.waitForFunction(() => document.querySelector('#draft').value === '$$\\frac{}{}$$');
    assert.ok(await field.evaluate(node => node.getValue('latex').includes('\\frac')));
    assert.ok((await fracLineWidth()) > 4, '删空分母后分式和横线都必须保留');

    // 清空后还能继续填入；撤回 / 重做仍按原文恢复，不把占位符写进 #draft。
    await page.keyboard.type('3');
    await page.waitForFunction(() => document.querySelector('#draft').value === '$$\\frac{}{3}$$');
    await page.waitForTimeout(80);
    await page.locator('#draft-undo').click();
    await page.waitForFunction(() => document.querySelector('#draft').value === '$$\\frac{}{}$$');
    await page.locator('#draft-redo').click();
    await page.waitForFunction(() => document.querySelector('#draft').value === '$$\\frac{}{3}$$');
    // 整段选中删除分式仍然有效（守卫只拦「删空单个分支」）。
    await field.evaluate(node => node.executeCommand('selectAll'));
    await page.keyboard.press('Backspace');
    await waitFieldEmpty();
    await page.waitForFunction(() => document.querySelector('#draft').value === '');
    await page.evaluate(() => window.mathInputMode.setView('source'));

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
    // 手动插入与 AI 插入同一时序：面板 hidden 后 MathLive 还要一帧才写回 #draft。
    await waitDraftContains('\\begin{pmatrix}');
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
    await waitDraftContains('\\begin{vmatrix}');
    const determinantDraft = await value();
    assert.ok(determinantDraft.includes('\\begin{vmatrix}'), determinantDraft);
    const determinantBody = await page.evaluate(text => {
      const parts = window.mathInputMode.parseDraft(text).filter(part => part.type === 'math');
      return parts.length ? parts[0].value : '';
    }, determinantDraft);
    assert.equal((determinantBody.match(/&/g) || []).length, 6);
    assert.equal((determinantBody.match(/\\\\/g) || []).length, 2);

    /* 8b. 越界即时夹到 1–20；越界/小数等非法输入右侧红提示 3 秒后消失；关面板 / 重开不带出旧提示 */
    await clearDraft();
    await openMatrixPanel('matrix');
    const rowsTip = page.locator('#fmx-rows-tip');
    const rowsValue = () => page.locator('#fmx-rows').inputValue();
    const sizeTipText = '只能是1~20内的整数！';
    await page.locator('#fmx-cols').fill('2');
    await page.locator('#fmx-rows').fill('25');
    assert.equal(await rowsValue(), '20');
    assert.equal(await rowsTip.innerText(), sizeTipText);
    assert.equal(await rowsTip.isVisible(), true);
    assert.equal(await page.locator('.fmx-manual-preview').getAttribute('aria-label'), '20 行 2 列矩阵预览');
    await page.locator('#fmx-rows').fill('0');
    assert.equal(await rowsValue(), '1');
    assert.equal(await rowsTip.innerText(), sizeTipText);
    // 范围内小数不夹取，仍要求整数，插入保持禁用；提示同样出现
    await page.locator('#fmx-rows').evaluate((node, value) => {
      node.value = value;
      node.dispatchEvent(new Event('input', {bubbles: true}));
    }, '7.5');
    assert.equal(await rowsValue(), '7.5');
    assert.equal(await rowsTip.innerText(), sizeTipText);
    assert.match(await page.locator('.fmx-manual-status').innerText(), /整数/);
    assert.equal(await page.locator('[data-fmx-content="manual"] .fmx-primary').isDisabled(), true);
    // 留空允许继续输入，不夹成 1，也不显示非法提示
    await page.locator('#fmx-rows').fill('');
    assert.equal(await rowsValue(), '');
    assert.equal(await rowsTip.isVisible(), false);
    // 两位有效数原样保留
    await page.locator('#fmx-rows').fill('10');
    assert.equal(await rowsValue(), '10');
    assert.equal(await rowsTip.isVisible(), false);
    // 再次非法从新一次开始计时，3 秒后自动隐藏
    await page.locator('#fmx-rows').fill('25');
    assert.equal(await rowsTip.innerText(), sizeTipText);
    await page.waitForFunction(() => document.querySelector('#fmx-rows-tip').hidden, null, {timeout: 4000});
    // 关闭 / 重开不残留旧提示
    await page.locator('#fmx-rows').fill('25');
    assert.equal(await rowsTip.isVisible(), true);
    await page.keyboard.press('Escape');
    await waitPanelClosed();
    await openMatrixPanel('matrix');
    assert.equal(await page.locator('#fmx-rows-tip').isVisible(), false);
    assert.equal(await page.locator('#fmx-rows-tip').innerText(), '');
    await page.keyboard.press('Escape');
    await waitPanelClosed();

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
    const aiResponse = page.waitForResponse(response =>
      response.url().endsWith('/api/formula/matrix') && response.request().method() === 'POST'
    );
    await page.locator('[data-fmx-content="ai"] .fmx-row .fmx-primary').click();
    const aiLatex = (await (await aiResponse).json()).latex;
    await page.waitForFunction(() => document.querySelector('.fmx-status').textContent.includes('已生成'));
    await page.locator('[data-fmx-content="ai"] .fmx-preview').waitFor({state: 'visible'});
    assert.ok(await page.locator('[data-fmx-content="ai"] .fmx-preview .katex').count() > 0);
    await page.locator('[data-fmx-content="ai"] .fmx-actions .fmx-primary').click();
    await waitPanelClosed();
    // 关闭面板时 MathLive 的内容还要一帧才写回 #draft；这里等 vmatrix 真正出现再读。
    await waitDraftContains('\\begin{vmatrix}');
    const aiDraft = await value();
    assert.ok(aiDraft.includes('\\begin{vmatrix}'), aiDraft);
    assert.equal(await mathCount(aiDraft), 1);
    // 不只看 & 总数：逐行核对 AI 返回的实际形状（当前 fixture 为 3×3）。
    assert.deepEqual(await shapeOfDraft(aiDraft), shapeOfLatex(aiLatex));

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
    // 夹取提示在窄屏也不能把面板 / 页面撑宽
    await page.locator('#fmx-rows').fill('25');
    assert.equal(await page.locator('#fmx-rows').inputValue(), '20');
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
    // 兼容 /api/status 在切 AI 前已到（手动区隐藏时告警）与切 AI 后才到两种顺序
    await noConfig.waitForFunction(() => {
      const node = document.querySelector('.fmx-status');
      return Boolean(node && node.textContent.includes('未配置'));
    });
    assert.equal(await noConfig.locator('.fmx-textarea').isDisabled(), true);
    assert.equal(await noConfig.locator('[data-fmx-content="ai"] .fmx-row .fmx-primary').isDisabled(), true);
    assert.match(await noConfig.locator('.fmx-status').innerText(), /未配置|需要模型/);
    await noConfig.locator('[data-fmx-mode="manual"]').click();
    assert.equal(await noConfig.locator('[data-fmx-content="manual"]').isVisible(), true);
    assert.equal(await noConfig.locator('[data-fmx-content="manual"] .fmx-primary').isDisabled(), false);
    await noConfig.close();

    /* 15. 方向键对齐：屏幕四按钮与实体键走同一 MathLive 移动语义（逐字符、
       已填格、上下界切换），只移动光标，不改 #draft，也不丢焦点。
       整式保留截图前缀 \overline{\Delta}x，不涉及任何符号插入。 */
    await page.setViewportSize({width: 1360, height: 1000});
    const cursorDraft = '$\\overline{\\Delta}x\\cong\\int_{12}^{34}$';
    await page.evaluate(() => window.mathInputMode.setView('source'));
    await setDraft(cursorDraft);
    await page.evaluate(() => window.mathInputMode.setView('rendered'));
    await page.waitForFunction(() => {
      const node = document.querySelector('#formula-editor-host math-field');
      return Boolean(node && node.getValue('latex').includes('\\int_{12}^{34}'));
    });
    await field.click();
    await visibleKeyboard().waitFor();
    await page.waitForFunction(expected => document.querySelector('#draft').value === expected, cursorDraft);

    // position 指向光标前的 atom，最后一个 atom 的位置就是界尾 / 格尾。
    const offsetsOf = branch => field.evaluate((node, key) => {
      const model = node._mathfield.model;
      const wanted = JSON.stringify(key);
      const offsets = [];
      for (let i = 0; i <= model.lastOffset; i += 1) {
        const atom = model.at(i);
        if (atom && JSON.stringify(atom.parentBranch) === wanted) offsets.push(i);
      }
      return offsets.length ? {start: offsets[0], end: offsets[offsets.length - 1]} : null;
    }, branch);
    const caret = () => field.evaluate(node => {
      const atom = node._mathfield.model.at(node.position);
      return {position: node.position, branch: atom ? atom.parentBranch : null};
    });
    const putCaret = offset => field.evaluate((node, value) => {
      node.focus();
      node.position = value;
    }, offset);
    const pressKey = async (offset, key) => {
      await putCaret(offset);
      await page.keyboard.press(key);
      return caret();
    };
    const pressButton = async (offset, direction) => {
      await putCaret(offset);
      await visibleKeyboard().locator(`[data-mk-move="${direction}"]`).click();
      return caret();
    };

    const upper = await offsetsOf('superscript');
    const lower = await offsetsOf('subscript');
    assert.ok(upper && lower, '积分上下界应该可定位');
    // 上界末尾 Down → 下界末尾；下界起点 Up → 上界起点。
    assert.deepEqual(await pressKey(upper.end, 'ArrowDown'), {position: lower.end, branch: 'subscript'});
    assert.deepEqual(await pressButton(upper.end, 'down'), {position: lower.end, branch: 'subscript'});
    assert.deepEqual(await pressKey(lower.start, 'ArrowUp'), {position: upper.start, branch: 'superscript'});
    assert.deepEqual(await pressButton(lower.start, 'up'), {position: upper.start, branch: 'superscript'});
    assert.equal(await value(), cursorDraft);

    // 上界留空（截图里的 \int_{12}^{}）也能在上下界之间切换。
    const emptyBoundDraft = '$\\int_{12}^{}$';
    await page.evaluate(() => window.mathInputMode.setView('source'));
    await setDraft(emptyBoundDraft);
    await page.evaluate(() => window.mathInputMode.setView('rendered'));
    await page.waitForFunction(() => {
      const node = document.querySelector('#formula-editor-host math-field');
      return Boolean(node && node.getValue('latex').includes('\\int'));
    });
    await field.click();
    await visibleKeyboard().waitFor();
    await page.waitForFunction(expected => document.querySelector('#draft').value === expected, emptyBoundDraft);
    const emptyLower = await offsetsOf('subscript');
    const emptyUpper = await offsetsOf('superscript');
    assert.ok(emptyLower && emptyUpper);
    assert.deepEqual(await pressKey(emptyLower.end, 'ArrowUp'), {position: emptyUpper.start, branch: 'superscript'});
    assert.deepEqual(await pressButton(emptyUpper.start, 'down'), {position: emptyLower.start, branch: 'subscript'});
    assert.equal(await value(), emptyBoundDraft);

    // 已填格：格内逐字符左移，格尾 Right 进入同一行下一格起点。
    // MathLive 初次装载会把矩阵标准化成带空格的源：12 & 34\\ 56 & 78。
    const cursorMatrixDraft = '$\\begin{vmatrix}12&34\\\\56&78\\end{vmatrix}$';
    const normalizedMatrixDraft = '$\\begin{vmatrix}12 & 34\\\\ 56 & 78\\end{vmatrix}$';
    await page.evaluate(() => window.mathInputMode.setView('source'));
    await setDraft(cursorMatrixDraft);
    await page.evaluate(() => window.mathInputMode.setView('rendered'));
    await page.waitForFunction(() => {
      const node = document.querySelector('#formula-editor-host math-field');
      return Boolean(node && node.getValue('latex').includes('\\begin{vmatrix}'));
    });
    await field.click();
    await visibleKeyboard().waitFor();
    await page.waitForFunction(expected => document.querySelector('#draft').value === expected, normalizedMatrixDraft);
    const cell00 = await offsetsOf([0, 0]);
    const cell01 = await offsetsOf([0, 1]);
    assert.ok(cell00 && cell01, '矩阵格子应该可定位');
    assert.deepEqual(await pressKey(cell00.end, 'ArrowLeft'), {position: cell00.end - 1, branch: [0, 0]});
    assert.deepEqual(await pressButton(cell00.end, 'left'), {position: cell00.end - 1, branch: [0, 0]});
    assert.deepEqual(await pressKey(cell00.end, 'ArrowRight'), {position: cell01.start, branch: [0, 1]});
    assert.deepEqual(await pressButton(cell00.end, 'right'), {position: cell01.start, branch: [0, 1]});
    assert.equal(await value(), normalizedMatrixDraft);

    // 空格之间仍能继续跨越，不能被逐字符移动卡住。
    // 空格 fixture 的标准化细节更多，装载稳定后取移动前的 #draft，按字节比较。
    const emptyMatrixDraft = '$\\begin{vmatrix}1&\\\\&\\end{vmatrix}$';
    await page.evaluate(() => window.mathInputMode.setView('source'));
    await setDraft(emptyMatrixDraft);
    await page.evaluate(() => window.mathInputMode.setView('rendered'));
    await page.waitForFunction(() => {
      const node = document.querySelector('#formula-editor-host math-field');
      return Boolean(node && node.getValue('latex').includes('\\begin{vmatrix}'));
    });
    await field.click();
    await visibleKeyboard().waitFor();
    await page.waitForFunction(() => {
      const text = document.querySelector('#draft').value;
      return text.includes('\\begin{vmatrix}') && text.includes('\\end{vmatrix}');
    });
    const loadedEmptyMatrixDraft = await value();
    assert.match(loadedEmptyMatrixDraft, /^\$\\begin\{vmatrix\}.*\\end\{vmatrix\}\$$/);
    assert.equal((loadedEmptyMatrixDraft.match(/&/g) || []).length, 2);
    assert.equal((loadedEmptyMatrixDraft.match(/\\\\/g) || []).length, 1);
    const empty00 = await offsetsOf([0, 0]);
    const empty01 = await offsetsOf([0, 1]);
    const empty10 = await offsetsOf([1, 0]);
    assert.ok(empty00 && empty01 && empty10);
    assert.deepEqual(await pressButton(empty00.end, 'right'), {position: empty01.start, branch: [0, 1]});
    assert.deepEqual(await pressButton(empty01.start, 'right'), {position: empty10.start, branch: [1, 0]});
    assert.deepEqual(await pressKey(empty01.start, 'ArrowRight'), {position: empty10.start, branch: [1, 0]});

    assert.equal(await value(), loadedEmptyMatrixDraft);
    assert.equal(await focusInMainField(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

    /* 16. 微积分模板：真实点击后打字、实体/屏幕方向键、空界删除保护和原文往返。
       模板的首填槽由 MathLive 的第一个占位符决定；正文用 #0，选中真实公式时仍包住选区。 */
    const canonicalDraft = () => page.evaluate(() => {
      const text = document.querySelector('#draft').value
        .replace(/\s+/g, '')
        .replace(/_\{([^{}]*)\}/g, (match, inner) => '_' + inner)
        .replace(/\^\{([^{}]*)\}/g, (match, inner) => '^' + inner);
      return text;
    });
    const waitCanonicalDraft = needle => page.waitForFunction(value => {
      const text = document.querySelector('#draft').value
        .replace(/\s+/g, '')
        .replace(/_\{([^{}]*)\}/g, (match, inner) => '_' + inner)
        .replace(/\^\{([^{}]*)\}/g, (match, inner) => '^' + inner);
      return text.includes(value);
    }, needle);
    const waitCanonical = expected => page.waitForFunction(value => {
      const text = document.querySelector('#draft').value
        .replace(/\s+/g, '')
        .replace(/_\{([^{}]*)\}/g, (match, inner) => '_' + inner)
        .replace(/\^\{([^{}]*)\}/g, (match, inner) => '^' + inner);
      return text === value;
    }, expected);
    const waitCaretBranch = branch => page.waitForFunction(wanted => {
      const node = document.querySelector('#formula-editor-host math-field');
      const model = node && node._mathfield && node._mathfield.model;
      const atom = model && model.at(node.position);
      return Boolean(atom && atom.parentBranch === wanted);
    }, branch);
    // 选中光标所在下标分支的全部内容（与直接拖选整个下标等价）。
    const selectSubscript = () => field.evaluate(node => {
      const model = node._mathfield.model;
      const atom = model.at(node.position);
      const parent = atom && atom.parent;
      if (!parent) return false;
      model.selection = {ranges: [model.getBranchRange(model.offsetOf(parent), 'subscript')]};
      return true;
    });
    const openCalculusKey = async aria => {
      await clearDraft();
      await field.click();
      await visibleKeyboard().waitFor();
      await chooseCategory('calculus');
      await clickKey(aria);
    };
    const pressScreen = direction => visibleKeyboard().locator(`[data-mk-move="${direction}"]`).click();

    // 不定积分：首填被积函数，没有上下界，积分体后保留 dx。
    await openCalculusKey('积分');
    await page.waitForFunction(() => {
      const node = document.querySelector('#formula-editor-host math-field');
      return Boolean(node && node.getValue('latex').includes('\\int'));
    });
    await page.keyboard.type('x');
    await waitCanonicalDraft('\\intx\\,dx');
    assert.equal((await canonicalDraft()).includes('\\int_'), false);
    assert.equal((await canonicalDraft()).includes('\\int^'), false);

    // 定积分：默认双空界时从下界第一次 ↑ 就进上界，再 ↓ 回下界；
    // 然后下界 → 上界 → 积分体，末尾 dx；实体方向键。
    await openCalculusKey('定积分');
    await waitCaretBranch('subscript');
    await page.keyboard.press('ArrowUp');
    await waitCaretBranch('superscript');
    await page.keyboard.press('ArrowDown');
    await waitCaretBranch('subscript');
    await page.keyboard.type('1');
    await page.keyboard.press('ArrowUp');
    await waitCaretBranch('superscript');
    await page.keyboard.type('3');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('x');
    await waitCanonicalDraft('\\int_1^3x\\,dx');

    // 求和：下标预填 i=，首填在等号后；屏幕方向上/右方向键。
    await openCalculusKey('求和');
    await waitCaretBranch('subscript');
    await waitCanonicalDraft('\\sum_i=');
    await page.keyboard.type('1');
    await waitCanonicalDraft('\\sum_i=1');
    await pressScreen('up');
    await waitCaretBranch('superscript');
    await page.keyboard.type('n');
    await pressScreen('right');
    await page.keyboard.type('x');
    await waitCanonicalDraft('\\sum_i=1^nx');

    // 连乘：与求和同构，不能再是裸 \prod。
    await openCalculusKey('连乘');
    await waitCaretBranch('subscript');
    await waitCanonicalDraft('\\prod_i=');
    await page.keyboard.type('1');
    await page.keyboard.press('ArrowUp');
    await waitCaretBranch('superscript');
    await page.keyboard.type('n');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('x');
    await waitCanonicalDraft('\\prod_i=1^nx');

    // i= 是普通字符：三次以内 Backspace 删掉后可直接写 cyc，符号/上界/正文不丢。
    await openCalculusKey('求和');
    await waitCanonicalDraft('\\sum_i=');
    for (let i = 0; i < 3; i += 1) {
      await page.keyboard.press('Backspace');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    }
    await page.keyboard.type('cyc');
    await waitCanonicalDraft('\\sum_cyc');
    // 上界槽仍在：从下标按实体上键还能进入 superscript。
    await page.keyboard.press('ArrowUp');
    await waitCaretBranch('superscript');

    // 空下界再退格：MathLive 原生会 removeBranch('subscript')，守卫必须保住槽位。
    await openCalculusKey('定积分');
    await waitCaretBranch('subscript');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('1');
    await waitCanonicalDraft('\\int_1');

    // 上界数字删空后再退格，仍能继续输入上界。
    await openCalculusKey('定积分');
    await waitCaretBranch('subscript');
    await page.keyboard.type('1');
    await page.keyboard.press('ArrowUp');
    await waitCaretBranch('superscript');
    await page.keyboard.type('3');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('2');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('x');
    await waitCanonicalDraft('\\int_1^2x\\,dx');

    // 选中整条公式删除仍照常工作：守卫只拦空界，不拦整个选区。
    await openCalculusKey('求和');
    await page.keyboard.type('1');
    await field.evaluate(node => node.executeCommand('selectAll'));
    await page.keyboard.press('Backspace');
    await waitFieldEmpty();
    await waitCanonical('');

    // 对数：首填真实底数，再进入真数。
    await openCalculusKey('对数');
    await waitCaretBranch('subscript');
    await page.keyboard.type('2');
    await waitCanonicalDraft('\\log_2');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('x');
    await page.waitForFunction(() => {
      const text = document.querySelector('#draft').value
        .replace(/\s+/g, '')
        .replace(/_\{([^{}]*)\}/g, (match, inner) => '_' + inner)
        .replace(/\^\{([^{}]*)\}/g, (match, inner) => '^' + inner);
      const index = text.indexOf('\\log_2');
      return index >= 0 && text.slice(index + 6).includes('x');
    });

    // 极限：真实点击后把预填 x→ 和占位符一起删空，再按 Backspace / Delete
    // 不能丢掉下标分支；新的趋近条件要能继续填回去。
    await openCalculusKey('极限');
    await waitCaretBranch('subscript');
    for (let i = 0; i < 3; i += 1) await page.keyboard.press('Backspace');
    await waitCanonical('$\\lim_$');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Delete');
    await waitCanonical('$\\lim_$');
    await waitCaretBranch('subscript');
    await page.keyboard.type('t');
    await chooseCategory('relation');
    await clickKey('趋于');
    await page.keyboard.type('0');
    await waitCanonical('$\\lim_t\\to0$');

    // 对数底数：删掉最后一位数字不能连 \log 一起删；空下标可继续退格和重填，
    // 撤销要能恢复原来的底数。
    await openCalculusKey('对数');
    await waitCaretBranch('subscript');
    await page.keyboard.type('2');
    await waitCanonicalDraft('\\log_2');
    await page.keyboard.press('Backspace');
    await waitCanonical('$\\log_$');
    await waitCaretBranch('subscript');
    await page.keyboard.press('Backspace');
    await waitCanonical('$\\log_$');
    await page.keyboard.press('Control+z');
    await waitCanonical('$\\log_2$');
    // 原生与原稿工具栏的撤回都可能恢复不同的光标位置。退格前确保光标在数字后。
    const atBaseStart = await field.evaluate(node => node._mathfield.model.at(node.position).type === 'first');
    if (atBaseStart) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Backspace');
    await waitCanonical('$\\log_$');
    await page.keyboard.type('7');
    await waitCanonical('$\\log_7$');

    // 整个下标选区删除：lim / log 只清空下标内容，运算符和可填槽位保留。
    await openCalculusKey('极限');
    await page.keyboard.type('1');
    await waitCanonical('$\\lim_x\\to1$');
    assert.equal(await selectSubscript(), true);
    await page.keyboard.press('Backspace');
    await waitCanonical('$\\lim_$');
    await waitCaretBranch('subscript');
    await page.keyboard.type('u');
    await waitCanonical('$\\lim_u$');

    await openCalculusKey('对数');
    await page.keyboard.type('2');
    await waitCanonicalDraft('\\log_2');
    assert.equal(await selectSubscript(), true);
    await page.keyboard.press('Delete');
    await waitCanonical('$\\log_$');
    await waitCaretBranch('subscript');
    await page.keyboard.type('e');
    await waitCanonical('$\\log_e$');

    // 接在已有公式后：折叠光标不会把 z^2+ 捕获进积分体；原文往返不丢内容。
    await page.evaluate(() => window.mathInputMode.setView('source'));
    await setDraft('$z^2+$');
    await page.evaluate(() => window.mathInputMode.setView('rendered'));
    await page.waitForFunction(() => {
      const node = document.querySelector('#formula-editor-host math-field');
      return Boolean(node && node.getValue('latex').includes('z'));
    });
    await field.click();
    await visibleKeyboard().waitFor();
    await field.evaluate(node => node.executeCommand('moveToMathfieldEnd'));
    await chooseCategory('calculus');
    await clickKey('积分');
    await page.keyboard.type('x');
    await waitCanonicalDraft('z^2+\\intx\\,dx');
    const calculusRaw = await value();
    await toggle.click();
    assert.equal(await value(), calculusRaw);
    await toggle.click();
    await page.waitForFunction(() => {
      const node = document.querySelector('#formula-editor-host math-field');
      return Boolean(node && node.getValue('latex').includes('\\int'));
    });

    /* 17. 原文视图：raw 模板里的 $0 首填光标不能被隐藏 MathLive 的归一化回写覆盖。 */
    await toggle.click();
    const rawCases = [
      ['积分', '$\\int \\,dx$', 6],
      ['定积分', '$\\int_{}^{} \\,dx$', 7],
      ['求和', '$\\sum_{i=}^{} $', 9],
      ['连乘', '$\\prod_{i=}^{} $', 10],
      ['对数', '$\\log_{}$', 7],
      ['极限', '$\\lim_{x\\to }$', 12]
    ];
    for (const [aria, expected, caret] of rawCases) {
      await setDraft('');
      await draft.click();
      await visibleKeyboard().waitFor();
      await chooseCategory('calculus');
      await clickKey(aria);
      // 隐藏 MathLive 的归一再快也要经过至少一帧；两帧后原文和光标必须仍是插入结果。
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await value(), expected);
      assert.deepEqual(await selection(), [caret, caret]);
    }
    await toggle.click();
    await page.waitForFunction(() => {
      const node = document.querySelector('#formula-editor-host math-field');
      return Boolean(node && node.getValue('latex').includes('\\lim'));
    });

    /* 18. 撤回 / 重做：按钮与快捷键共用一条历史；原文 / 渲染切换不清空；redo 恢复模板占位符。 */
    const undo = page.locator('#draft-undo');
    const redo = page.locator('#draft-redo');
    const waitDraftExactly = text => page.waitForFunction(wanted => {
      const node = document.querySelector('#draft');
      return Boolean(node && node.value === wanted);
    }, text);
    await page.evaluate(() => window.mathInputMode.setView('source'));
    await setDraft('');
    await page.evaluate(() => window.mathInputMode.setView('rendered'));
    await waitFieldEmpty();
    await field.click();
    await page.keyboard.insertText('撤回测试');
    await waitDraftExactly('撤回测试');
    assert.equal(await undo.isDisabled(), false);
    assert.equal(await redo.isDisabled(), true);
    await undo.click();
    assert.equal(await value(), '');
    assert.equal(await redo.isDisabled(), false);
    await redo.click();
    await waitDraftExactly('撤回测试');

    // 撤回后新编辑必须截断 redo。
    await undo.click();
    await page.keyboard.insertText('x');
    await waitDraftExactly('x');
    assert.equal(await redo.isDisabled(), true);

    // 原文改一个字后切回渲染，历史仍在；撤回 / 重做跨视图有效。
    await page.keyboard.insertText('再');
    await waitDraftExactly('x再');
    await toggle.click();
    await draft.click();
    await page.keyboard.press('End');
    await page.keyboard.insertText('源');
    await waitDraftExactly('x再源');
    await toggle.click();
    await undo.click();
    await waitDraftExactly('x再');
    await redo.click();
    await waitDraftExactly('x再源');

    // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y 走同一条历史。
    await field.click();
    await page.keyboard.press('Control+z');
    await waitDraftExactly('x再');
    await page.keyboard.press('Control+Shift+z');
    await waitDraftExactly('x再源');
    await page.keyboard.press('Control+z');
    await waitDraftExactly('x再');
    await page.keyboard.press('Control+y');
    await waitDraftExactly('x再源');

    // 刷新会恢复当前对话的草稿，先新建空白对话再验证模板的可填选区。
    await page.evaluate(() => newConversation());
    await waitFieldEmpty();
    const freshConversationId = await page.evaluate(() => conversationStore.activeId);
    await page.reload();
    await page.waitForFunction(id => {
      return conversationStore.activeId === id && conversationStore.cache.has(id);
    }, freshConversationId);
    await page.waitForFunction(() => window.mathInputMode?.field && window.mathInputMode.isRendered());
    await field.click();
    await visibleKeyboard().waitFor();
    await chooseCategory('fraction');
    await clickKey('分式');
    await page.waitForFunction(() => {
      const node = document.querySelector('#formula-editor-host math-field');
      return Boolean(node && node.getValue('latex').includes('\\frac'));
    });
    await undo.click();
    await waitFieldEmpty();
    await redo.click();
    await page.waitForFunction(() => {
      const node = document.querySelector('#formula-editor-host math-field');
      const ranges = node && node.selection && node.selection.ranges;
      return Boolean(node && node.getValue('latex').includes('\\placeholder') &&
        ranges && ranges.length === 1 && ranges[0][0] !== ranges[0][1]);
    });
    await page.keyboard.type('1');
    await waitCanonicalDraft('\\frac{1}');

    // 忙碌时 app.js 把 #draft 设为只读：按钮与快捷键都不能再改动原稿。
    await page.evaluate(() => window.mathInputMode.setView('source'));
    const beforeReadonly = await value();
    await page.evaluate(() => { state.busy = true; updateButtons(); });
    await page.waitForFunction(() => document.querySelector('#draft-undo').disabled && document.querySelector('#draft-redo').disabled);
    await draft.click();
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(80);
    assert.equal(await value(), beforeReadonly);
    await page.evaluate(() => { state.busy = false; updateButtons(); });
    await page.waitForFunction(() => !document.querySelector('#draft-undo').disabled);

    /* 19. 原文视图的字面符号：%、{、} 插成有效 LaTeX，且只包一层 $（并入 #8 的原有回归） */
    await page.evaluate(() => window.mathInputMode.setView('source'));
    await setDraft('abc');
    await draft.click();
    await setSelection(1, 1);
    await visibleKeyboard().waitFor();
    await chooseCategory('basic');
    await clickKey('百分号');
    assert.equal(await value(), 'a$\\%$bc');
    assert.equal((await value()).split('$').length - 1, 2);
    await setDraft('abc');
    await setSelection(1, 1);
    await clickKey('左花括号');
    assert.equal(await value(), 'a$\\{$bc');
    await setDraft('abc');
    await setSelection(1, 1);
    await clickKey('右花括号');
    assert.equal(await value(), 'a$\\}$bc');
    // 原 #8 的固定 2×2 矩阵 / 行列式按键已被 #6 的矩阵面板取代，对应覆盖在 8/8b/9 节。

    /* 20. 原文视图（渲染编辑器隐藏）：flush 没有所有权，不能把旧公式写回 #draft（并入 #8 的 8b） */
    await page.evaluate(() => window.mathInputMode.setView('source'));
    await setDraft('原文草稿：隐藏编辑器不得覆盖');
    await field.evaluate(node => node.setValue('\\text{隐藏的旧公式}', {
      mode: 'text',
      format: 'latex',
      insertionMode: 'replaceAll'
    }));
    await page.waitForTimeout(120);
    assert.equal(await page.evaluate(() => window.mathInputMode.flush()), false);
    assert.equal(await value(), '原文草稿：隐藏编辑器不得覆盖');

    /* 21. 外部写入（OCR / 清空 / 程序化回填）保持原稿并同步渲染编辑器；切原文逐字保留 */
    await page.evaluate(() => window.mathInputMode.setView('rendered'));
    await draft.evaluate(node => {
      node.value = '笔记：外部写入 $\\frac{1}{x}$';
      node.dispatchEvent(new Event('input', {bubbles: true}));
    });
    await page.waitForFunction(() => {
      const node = document.querySelector('#formula-editor-host math-field');
      return Boolean(node && node.getValue('latex').includes('\\frac{1}{x}'));
    });
    await toggle.click();
    assert.equal(await value(), '笔记：外部写入 $\\frac{1}{x}$');
    await toggle.click();

    /* 22. 历史对话切换：渲染编辑器跟随新对话的原稿；撤回历史按对话重置，
       所以 A 对话的原稿不会在 B 对话里被撤回，同一对话内的撤回仍继续有效。 */
    const conversationsBefore = await page.evaluate(() => conversationStore.list.length);
    await page.locator('#new-conversation').click();
    await page.waitForFunction(count => conversationStore.list.length === count + 1 && Boolean(conversationStore.activeId), conversationsBefore);
    const conversationA = await page.evaluate(() => conversationStore.activeId);
    await setDraft('A 对话原稿 $x^2$');
    await page.waitForFunction(() => {
      const node = document.querySelector('#formula-editor-host math-field');
      return Boolean(node && node.getValue('latex').includes('x^2'));
    });
    await page.locator('#new-conversation').click();
    await page.waitForFunction(count => conversationStore.list.length === count + 2, conversationsBefore);
    const conversationB = await page.evaluate(() => conversationStore.activeId);
    assert.notEqual(conversationA, conversationB);
    assert.equal(await value(), '');
    await page.waitForFunction(() => document.querySelector('#formula-editor-host math-field').getValue('latex').trim() === '');
    await setDraft('B 对话原稿 $y^2$');
    await page.waitForFunction(() => {
      const node = document.querySelector('#formula-editor-host math-field');
      return Boolean(node && node.getValue('latex').includes('y^2'));
    });
    // 在 B 撤回：只能回到 B 自己的空基线，绝不能把 A 的原稿撤回来。
    await page.waitForFunction(() => !document.querySelector('#draft-undo').disabled);
    await page.locator('#draft-undo').click();
    assert.equal(await value(), '');
    assert.ok(!(await value()).includes('A 对话原稿'));
    // 切回 A：草稿与渲染编辑器都换回 A 的原稿，撤回历史重置成 A 的基线。
    await page.evaluate(id => openConversation(id), conversationA);
    await page.waitForFunction(() => document.querySelector('#draft').value === 'A 对话原稿 $x^2$');
    await page.waitForFunction(() => {
      const node = document.querySelector('#formula-editor-host math-field');
      return Boolean(node && node.getValue('latex').includes('x^2'));
    });
    assert.equal(await page.locator('#draft-undo').isDisabled(), true);
    // 同一对话内继续编辑仍可撤回，撤回只影响本对话的这份原稿。
    await setDraft('A 对话原稿 $x^2$ 补充');
    await page.waitForFunction(() => !document.querySelector('#draft-undo').disabled);
    await page.locator('#draft-undo').click();
    assert.equal(await value(), 'A 对话原稿 $x^2$');
    // 切回 B 后，先前已经撤空的草稿仍为空。
    await page.evaluate(id => openConversation(id), conversationB);
    assert.equal(await value(), '');
    await waitFieldEmpty();

    assert.deepEqual(errors, []);
    console.log('PASS: 普通文字键入/粘贴/OCR 往返、原文切换、符号公式、矩阵与行列式入口、AI 成功/快速切换/取消、无配置与 390px、方向键实体/屏幕对齐、微积分模板与空界删除保护、字面符号、隐藏编辑器不越权、历史对话切换后的撤回隔离。');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
