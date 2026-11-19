// 数学输入往返的回归测试：node tests/test_math_input.js
// math-input-mode.js 是浏览器脚本；这里用最小 DOM 桩加载它，只测纯转换函数。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'math-input-mode.js'), 'utf8');
const keyboardSource = fs.readFileSync(path.join(__dirname, '..', 'static', 'math-keyboard.js'), 'utf8');
const window = {
  addEventListener() {},
  dispatchEvent() {},
  setTimeout,
  clearTimeout,
  requestAnimationFrame() {},
};
const document = {
  querySelector() { return null; },
  querySelectorAll() { return []; },
  addEventListener() {},
  readyState: 'loading',
};
const context = {
  window,
  document,
  console,
  setTimeout,
  clearTimeout,
  WeakMap,
  CustomEvent: function CustomEvent() {},
  Event: function Event() {},
};
vm.createContext(context);
vm.runInContext(source, context, {filename: 'math-input-mode.js'});
const api = window.mathInputMode;
assert.ok(api, 'mathInputMode API should be exposed');
vm.runInContext(keyboardSource, context, {filename: 'math-keyboard.js'});
const keyboard = window.mathKeyboard;
assert.ok(keyboard && typeof keyboard.planInsert === 'function', 'mathKeyboard.planInsert should be exposed');

let passed = 0;
function check(name, actual, expected) {
  let ok;
  if (typeof expected === 'function') ok = expected(actual);
  else if (Array.isArray(expected)) ok = JSON.stringify(actual) === JSON.stringify(expected);
  else ok = actual === expected;
  if (!ok) {
    console.error('FAIL: ' + name + '\n  actual  : ' + JSON.stringify(actual) +
                  '\n  expected: ' + String(expected));
    process.exitCode = 1;
    return;
  }
  passed += 1;
}

function roundTrips(name, text) {
  check(name + ' / mixedToLatex', api.reconcileDraft(text, api.mixedToLatex(text)), text);
}

// 1) 定界符分段：行内、块级、\(...\)、\[...\]、裸矩阵环境
const block = api.parseDraft('$$\\frac{1}{x}$$');
check('block is math', block.length === 1 && block[0].type === 'math', true);
check('block content range', [block[0].contentStart, block[0].contentEnd], [2, 13]);
check('block value', block[0].value, '\\frac{1}{x}');
check('block latex is display math', api.mixedToLatex('$$\\frac{1}{x}$$'), '\\displaystyle \\frac{1}{x}');
check('block latexToMixed', api.latexToMixed('\\displaystyle \\frac{1}{x}'), '$$\\frac{1}{x}$$');

const mixed = api.parseDraft('前文 \\(x^2\\) 中 \\[y\\] 后');
check('bracket delimiters count', mixed.filter(part => part.type === 'math').length, 2);
check('bracket delimiter kind', mixed.filter(part => part.type === 'math').map(part => part.open), ['\\(', '\\[']);

// 2) 未编辑往返：原稿（含换行、块级公式、转义美元）逐字保留
[
  '$$\\frac{1}{x}$$',
  '前文 $x^2$ 后文',
  '第一行\n第二行',
  '第一行 中文 $x^2$\n第二行\n\n$$\\frac{1}{x}$$\n\n结束',
  '价格 \\$5 到 \\$10 元，公式 $x+1$。',
  '前文 \\[x^2\\] 后文',
  '前文 \\(x^2\\) 后文',
  '价格 $5 未闭合',
  '\\begin{vmatrix}1&2\\\\3&4\\end{vmatrix}',
].forEach(text => roundTrips('preserve', text));

// 3) 普通价格不当公式；真正的 $x$ 仍然识别
check('plain price has no math', api.parseDraft('价格 $5 到 $10 元').filter(part => part.type === 'math').length, 0);
const priceAndFormula = api.parseDraft('价格 $5 到 $10 元，公式 $x$');
check('price leaves only real formula', priceAndFormula.filter(part => part.type === 'math').map(part => part.value), ['x']);
check('price latex escapes dollars', api.mixedToLatex('价格 $5 到 $10 元'), '\\text{价格 \\$5 到 \\$10 元}');
check('price round trip', api.reconcileDraft('价格 $5 到 $10 元，公式 $x$', api.mixedToLatex('价格 $5 到 $10 元，公式 $x$')), '价格 $5 到 $10 元，公式 $x$');

// 4) 在公式编辑器里改公式：块级定界符与未改动的两处换行都保留
check('edit block formula keeps newlines',
  api.reconcileDraft('第一行\n第二行 $$\\frac{1}{x}$$', '\\text{第一行 第二行}\\displaystyle \\frac{1}{x}+1'),
  '第一行\n第二行 $$\\frac{1}{x}+1$$');
check('append formula keeps newlines',
  api.reconcileDraft('第一行\n第二行', '\\text{第一行 第二行}\\frac{1}{x}'),
  '第一行\n第二行$\\frac{1}{x}$');
check('insert formula in middle keeps newlines',
  api.reconcileDraft('第一行\n第二行', '\\text{第一行 }\\frac{1}{x}\\text{ 第二行}'),
  '第一行$\\frac{1}{x}$\n第二行');

// 5) 公式里混入中文时按普通文字输出，且不产生相邻的 $$...$$
check('cjk math splits to text', api.latexToMixed('x中文y'), '$x$中文$y$');

// 6) 每个 math 段都带可复用的 contentStart/contentEnd 和 raw/value
for (const text of ['a $x$ b $$y$$ c \\(z\\) d', '普通 $5 到 $10 文字']) {
  for (const part of api.parseDraft(text)) {
    if (part.type !== 'math') continue;
    check('content range matches value', part.value, text.slice(part.contentStart, part.contentEnd));
    check('raw covers delimiters', part.raw, text.slice(part.start, part.end));
  }
}

// 7) 键盘插入落点：文字中包一层、公式内续写、选区不套第二层、价格不当公式
check('insert plain text wraps', keyboard.planInsert('前文后文', 2, 2).wrap, true);
check('insert inside formula continues', [keyboard.planInsert('$x$', 3, 3).start, keyboard.planInsert('$x$', 3, 3).wrap], [2, false]);
check('insert before formula continues', [keyboard.planInsert('$x$', 0, 0).start, keyboard.planInsert('$x$', 0, 0).wrap], [1, false]);
check('insert replaces whole formula', [keyboard.planInsert('$x$', 0, 3).wrap, keyboard.planInsert('$x$', 0, 3).selected], [true, 'x']);
check('insert inside block formula', [keyboard.planInsert('$$x$$', 4, 4).start, keyboard.planInsert('$$x$$', 4, 4).wrap], [3, false]);
check('plain price does not count as formula', keyboard.planInsert('价格 $5 到 $10', 8, 8).wrap, true);

if (process.exitCode) {
  console.error('math input tests failed');
} else {
  console.log('math input tests: ' + passed + ' passed');
}
