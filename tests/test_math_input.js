// 数学输入往返的回归测试：node tests/test_math_input.js
// math-input-mode.js 是浏览器脚本；这里用最小 DOM 桩加载它，只测纯转换函数。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'math-input-mode.js'), 'utf8');
const keyboardSource = fs.readFileSync(path.join(__dirname, '..', 'static', 'math-keyboard.js'), 'utf8');
const matrixSource = fs.readFileSync(path.join(__dirname, '..', 'static', 'formula-matrix.js'), 'utf8');
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
vm.runInContext(matrixSource, context, {filename: 'formula-matrix.js'});
const matrix = window.formulaMatrix;
assert.ok(matrix && typeof matrix.buildLatex === 'function', 'formulaMatrix.buildLatex should be exposed');

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

// 8) 原稿可视编辑使用 MathLive text 模式：普通文字不进 $...$，公式显式包起来
check('text mode plain english stays plain', api.mixedToLatex('abc', true), 'abc');
check('text mode plain chinese stays plain', api.mixedToLatex('笔记：第一行', true), '笔记：第一行');
check('text mode inline formula is delimited', api.mixedToLatex('前文 $x^2$ 后文', true), '前文 $x^2$ 后文');
check('text mode block formula is delimited', api.mixedToLatex('$$\\frac{1}{x}$$', true), '$$\\frac{1}{x}$$');
check('text mode newlines become spaces in the field',
  api.mixedToLatex('第一行\n第二行', true), '第一行 第二行');
check('text mode serialized plain text parses back', api.latexToMixed('abc', true), 'abc');
check('text mode serialized formula parses back', api.latexToMixed('普通文字 $ x^2 $ 后文', true), '普通文字 $x^2$ 后文');
check('text mode serialized block parses back', api.latexToMixed('$$ \\frac{1}{x} $$', true), '$$\\frac{1}{x}$$');
check('text typed in math mode parses back as plain text', api.latexToMixed('$ \\text{原稿 Hello 123} $', true), '原稿 Hello 123');
check('ghost empty math parses as empty', api.latexToMixed('$  $', true), '');
check('ghost empty math does not swallow following text', api.latexToMixed('$  $原稿 Hello', true), '原稿 Hello');
check('ghost empty math does not rewrite empty draft', api.reconcileDraft('', '$  $', true), '');
for (const text of [
  'abc',
  '笔记：第一行\n第二行',
  '第一行\n第二行 $x^2$ 结束',
  '中文 $$\\frac{1}{x}$$ 中文',
  '价格 $5 到 $10 元',
]) {
  check('text mode round trip: ' + JSON.stringify(text),
    api.reconcileDraft(text, api.mixedToLatex(text, true), true), text);
}
check('append after typed newline preserves newline',
  api.reconcileDraft('hello中文\n', 'hello中文 s', true), 'hello中文\ns');
check('append after pasted newline preserves both newlines',
  api.reconcileDraft('第一行\n第二行\n', '第一行 第二行 结束', true), '第一行\n第二行\n结束');

// 9) 矩阵 / 行列式面板的模板与预览
check('matrix 2x3 text template',
  matrix.buildLatex(2, 3, 'matrix', '$0', ''),
  '\\begin{pmatrix}$0&&\\\\&&\\end{pmatrix}');
check('matrix 2x3 editable template',
  matrix.buildLatex(2, 3, 'matrix', '#@', '#?'),
  '\\begin{pmatrix}#@&#?&#?\\\\#?&#?&#?\\end{pmatrix}');
check('determinant 3x3 template',
  matrix.buildLatex(3, 3, 'determinant', '#@', '#?'),
  '\\begin{vmatrix}#@&#?&#?\\\\#?&#?&#?\\\\#?&#?&#?\\end{vmatrix}');
check('matrix preview uses square placeholders',
  matrix.buildPreview(2, 3, 'matrix'),
  '\\begin{pmatrix}\\square&\\square&\\square\\\\\\square&\\square&\\square\\end{pmatrix}');
check('determinant preview uses vertical bars',
  matrix.buildPreview(3, 3, 'determinant'),
  '\\begin{vmatrix}\\square&\\square&\\square\\\\\\square&\\square&\\square\\\\\\square&\\square&\\square\\end{vmatrix}');

// 10) 手动尺寸：1–20 才可插入；逐行核对形状，不能只看 & 总数
function latexShape(latex) {
  const body = String(latex)
    .replace(/^\\begin\{[^}]+\}/, '')
    .replace(/\\end\{[^}]+\}$/, '');
  return body.split(/\\\\/).map(row => row.split('&').length);
}

check('panel maxSize exposed to MathLive', matrix.maxSize, 20);
check('panel minSize', matrix.minSize, 1);
check('size tip wording', matrix.sizeTip, '只能是1~20内的整数！');
check('editor reads the same max size', api.matrixMaxSize(), 20);
check('parse 7 columns', matrix.parseSize('7'), 7);
check('parse 20 columns', matrix.parseSize('20'), 20);
check('parse 1 row', matrix.parseSize('1'), 1);
check('reject 0', matrix.parseSize('0'), null);
check('reject 21', matrix.parseSize('21'), null);
check('reject empty', matrix.parseSize(''), null);
check('reject decimal', matrix.parseSize('7.5'), null);
check('reject text', matrix.parseSize('abc'), null);
check('clamp 21 down to 20', matrix.clampSizeValue('21'), 20);
check('clamp 0 up to 1', matrix.clampSizeValue('0'), 1);
check('clamp negative up to 1', matrix.clampSizeValue('-3'), 1);
check('keep 20 in range', matrix.clampSizeValue('20'), null);
check('keep two-digit 10', matrix.clampSizeValue('10'), null);
check('keep in-range decimal for integer validation', matrix.clampSizeValue('7.5'), null);
check('empty is not clamped', matrix.clampSizeValue(''), null);
check('text is not clamped', matrix.clampSizeValue('abc'), null);
check('21 fallback message names the range',
  matrix.sizeError({value: '21'}, '行数'),
  message => message.includes('1–20') && !message.includes('不能插入'));
check('7.5 gets an integer message',
  matrix.sizeError({value: '7.5'}, '列数'),
  message => message.includes('整数'));

check('6x7 preview keeps every row', latexShape(matrix.buildPreview(6, 7, 'matrix')),
  [7, 7, 7, 7, 7, 7]);
check('7x6 source template keeps every row', latexShape(matrix.buildLatex(7, 6, 'matrix', '$0', '')),
  [6, 6, 6, 6, 6, 6, 6]);
check('7x7 determinant keeps every row', latexShape(matrix.buildLatex(7, 7, 'determinant', '$0', '')),
  [7, 7, 7, 7, 7, 7, 7]);
check('8x8 determinant keeps every row', latexShape(matrix.buildPreview(8, 8, 'determinant')),
  [8, 8, 8, 8, 8, 8, 8, 8]);
check('20x20 preview has 20 rows',
  latexShape(matrix.buildPreview(20, 20, 'matrix')).length, 20);
check('20x20 preview has 20 cells in every row',
  latexShape(matrix.buildPreview(20, 20, 'matrix')).every(cells => cells === 20), true);
check('20x20 editable template has 20 rows',
  latexShape(matrix.buildLatex(20, 20, 'matrix', '#@', '#?')).length, 20);
check('6x7 editable template starts with the caret cell',
  matrix.buildLatex(6, 7, 'matrix', '#@', '#?').startsWith('\\begin{pmatrix}#@&#?&#?&#?&#?&#?&#?\\\\'), true);

if (process.exitCode) {
  console.error('math input tests failed');
} else {
  console.log('math input tests: ' + passed + ' passed');
}
