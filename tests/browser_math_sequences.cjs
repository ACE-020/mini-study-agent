const assert = require('node:assert/strict');
const fc = require('fast-check');
const { chromium } = require('playwright');

const origin = process.env.STUDY_QA_URL || 'http://127.0.0.1:8766';
const shortDepth = 3;
const longRuns = 48;
const initial = { view: 'rendered', draft: '' };

// Keep the expected draft independent of the MathLive and application parsers.
const textAllowed = model => model.view === 'source' || !model.draft.startsWith('$');
const actions = {
  chinese: {
    allowed: textAllowed,
    expected: model => ({ ...model, draft: model.draft + '中' }),
    apply: editor => editor.append(() => editor.page.keyboard.insertText('中')),
  },
  letter: {
    allowed: textAllowed,
    expected: model => ({ ...model, draft: model.draft + 'a' }),
    apply: editor => editor.append(() => editor.page.keyboard.type('a')),
  },
  enter: {
    allowed: model => textAllowed(model) && model.draft !== '',
    expected: model => ({ ...model, draft: model.draft + '\n' }),
    apply: editor => editor.append(() => editor.page.keyboard.press('Enter')),
  },
  'switch view': {
    allowed: () => true,
    expected: model => ({ ...model, view: model.view === 'rendered' ? 'source' : 'rendered' }),
    apply: (editor, model) => editor.setView(model.view),
  },
  'copy source': {
    allowed: model => model.view === 'source' && model.draft !== '',
    expected: model => model,
    apply: async (editor, model) => {
      const { draft, page } = editor;
      await page.evaluate(() => navigator.clipboard.writeText('before-copy'));
      await draft.focus();
      await page.keyboard.press('Control+a');
      await page.keyboard.press('Control+c');
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      assert.equal(copied.replace(/\r\n/g, '\n'), model.draft);
      await page.keyboard.press('Control+End');
    },
  },
  'type x^2': {
    allowed: model => model.view === 'rendered' && model.draft === '',
    expected: model => ({ ...model, draft: '$x^2$' }),
    apply: editor => editor.append(() => editor.page.keyboard.type('x^2')),
  },
  'Ctrl+Enter on empty draft': {
    allowed: model => model.draft === '',
    expected: model => model,
    apply: editor => editor.append(() => editor.page.keyboard.press('Control+Enter')),
  },
};

function allowedActions(model) {
  return Object.keys(actions).filter(name => actions[name].allowed(model));
}

function* allShortSequences(model = initial, sequence = []) {
  if (sequence.length === shortDepth) return;
  for (const name of allowedActions(model)) {
    const next = [...sequence, name];
    yield next;
    yield* allShortSequences(actions[name].expected(model), next);
  }
}

function generatedSequence(choices) {
  let model = initial;
  return choices.map(choice => {
    const names = allowedActions(model);
    const name = names[choice % names.length];
    model = actions[name].expected(model);
    return name;
  });
}

function mathEditor(page, requests, pageErrors) {
  const draft = page.locator('#draft');
  const field = page.locator('#formula-editor-host math-field');
  let view = 'rendered';
  return {
    page,
    draft,
    async setView(next) {
      await page.evaluate(value => window.mathInputMode.setView(value), next);
      await (next === 'rendered' ? field : draft).waitFor({ state: 'visible' });
      view = next;
    },
    async reset() {
      await this.setView('source');
      await draft.fill('');
      await this.setView('rendered');
      await page.waitForFunction(() => window.mathInputMode.field.getValue('latex') === '');
    },
    async append(input) {
      if (view === 'rendered') {
        await field.click();
        await field.evaluate(node => {
          node.executeCommand('moveToMathfieldEnd');
        });
      } else {
        await draft.focus();
        await page.keyboard.press('Control+End');
      }
      await input();
    },
    async expect(model) {
      try {
        await page.waitForFunction(
          expected => document.querySelector('#draft').value === expected,
          model.draft,
          { timeout: 1500 },
        );
      } catch (error) {
        const actual = await draft.inputValue();
        assert.equal(actual, model.draft, 'The editor wrote the wrong draft');
        throw error;
      }
      assert.equal(await draft.isVisible(), model.view === 'source');
      assert.equal(await field.isVisible(), model.view === 'rendered');
      assert.deepEqual(requests, [], 'Editing an unsent draft must not send a chat request');
      assert.deepEqual(pageErrors, [], 'The page raised an uncaught JavaScript error');
    },
  };
}

async function checkSequence(editor, sequence) {
  await editor.reset();
  let model = initial;
  for (const [index, name] of sequence.entries()) {
    const action = actions[name];
    model = action.expected(model);
    try {
      await action.apply(editor, model);
      await editor.expect(model);
    } catch (error) {
      throw new Error(
        'Failed after: ' + sequence.slice(0, index + 1).join(' → ') + '\n' + error.message,
        { cause: error },
      );
    }
  }
}

function isChatRequest(request) {
  return request.method() === 'POST' && new URL(request.url()).pathname === '/api/chat';
}

async function main() {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL });
  try {
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(origin).origin });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const requests = [];
    const pageErrors = [];
    page.on('request', request => { if (isChatRequest(request)) requests.push(request.url()); });
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(origin);
    await page.waitForFunction(() => document.querySelector('#model-status').textContent.includes('已配置'));
    await page.waitForFunction(() => window.mathInputMode?.field && window.mathInputMode.isRendered());

    const editor = mathEditor(page, requests, pageErrors);
    const short = [...allShortSequences()];
    for (const sequence of short) await checkSequence(editor, sequence);
    console.log('Exhaustive: ' + short.length + ' distinct sequences of up to ' + shortDepth + ' actions passed.');

    // Re-run a failed property with the seed and path printed by fast-check.
    const seed = Number(process.env.FC_SEED ?? 20261127);
    const path = process.env.FC_PATH;
    // 60 is divisible by all possible numbers of enabled actions.
    const choices = fc.array(fc.integer({ min: 0, max: 59 }), { minLength: shortDepth + 1, maxLength: 14 });
    console.log('Exploration: seed=' + seed + ', sequences=' + longRuns + ', length=4–14.');
    await fc.assert(fc.asyncProperty(choices, async input => {
      await checkSequence(editor, generatedSequence(input));
    }), { seed, path, numRuns: longRuns });
    console.log('PASS: generated sequences.');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
