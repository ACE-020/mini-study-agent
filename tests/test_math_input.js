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

// 8b) 空分子/分母只给 MathLive 渲染串补可填占位；原文读取仍剔除占位符
check('empty fraction gets fillable slots',
  api.prepareFractionSlots('$$\\frac{}{}$$', true),
  '$$\\frac{\\placeholder{}}{\\placeholder{}}$$');
check('filled fraction is unchanged',
  api.prepareFractionSlots('$$\\frac{1}{2}$$', true), '$$\\frac{1}{2}$$');
check('only the empty side gets a slot',
  api.prepareFractionSlots('$$\\frac{1}{}$$', true),
  '$$\\frac{1}{\\placeholder{}}$$');
check('nested empty fractions get slots',
  api.prepareFractionSlots('$$\\frac{\\frac{}{}}{}$$', true),
  '$$\\frac{\\frac{\\placeholder{}}{\\placeholder{}}}{\\placeholder{}}$$');
check('nested fraction content is preserved',
  api.prepareFractionSlots('$$\\frac{\\frac{1}{2}}{3}$$', true), '$$\\frac{\\frac{1}{2}}{3}$$');
check('dfrac / tfrac / cfrac are covered',
  api.prepareFractionSlots('$\\dfrac{}{}+\\tfrac{}{}+\\cfrac[l]{}{}$', true),
  '$\\dfrac{\\placeholder{}}{\\placeholder{}}+\\tfrac{\\placeholder{}}{\\placeholder{}}+\\cfrac[l]{\\placeholder{}}{\\placeholder{}}$');
check('slot preparation is idempotent',
  api.prepareFractionSlots(api.prepareFractionSlots('$$\\frac{}{}$$', true), true),
  '$$\\frac{\\placeholder{}}{\\placeholder{}}$$');
check('plain text outside math is not rewritten',
  api.prepareFractionSlots('前文 \\frac{}{} 后文 $$\\frac{}{}$$', true),
  '前文 \\frac{}{} 后文 $$\\frac{\\placeholder{}}{\\placeholder{}}$$');
check('math-mode field gets slots without delimiters',
  api.prepareFractionSlots('\\frac{}{}', false),
  '\\frac{\\placeholder{}}{\\placeholder{}}');
check('unbalanced fraction is left alone',
  api.prepareFractionSlots('$$\\frac{}{$$', true), '$$\\frac{}{$$');
check('fraction-like command is not rewritten',
  api.prepareFractionSlots('$$\\fracfoo{}{}$$', true), '$$\\fracfoo{}{}$$');
check('slots never leak into the draft',
  api.reconcileDraft('$$\\frac{}{}$$', '$$\\frac{\\placeholder{}}{\\placeholder{}}$$', true),
  '$$\\frac{}{}$$');
check('typing into both slots round trips',
  api.reconcileDraft('$$\\frac{}{}$$', '$$\\frac{1}{2}$$', true),
  '$$\\frac{1}{2}$$');
// 深层嵌套必须在固定层数后早退，不能栈溢出或长时间卡住装载。
let deepFraction = '1';
for (let i = 0; i < 40; i += 1) deepFraction = '\\frac{' + deepFraction + '}{}';
const deepPrepared = api.prepareFractionSlots('$' + deepFraction + '$', true);
check('deep fraction scan is bounded', typeof deepPrepared === 'string' && deepPrepared.endsWith('$'), true);
check('new inline math keeps the preceding typed space',
  api.reconcileDraft('中文 ', '中文 $ x^2 $', true),
  '中文 $x^2$');
check('deep fraction still fills the reachable empty slots', deepPrepared.includes('\\placeholder{}'), true);

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

// 11) 历史对话切换：只在对话真正改变时重置本对话的原稿撤回基线（合版新增的隔离契约）
assert.equal(typeof api.syncConversation, 'function', 'mathInputMode.syncConversation should be exposed');
check('no conversation is tracked before app.js switches', api.conversationId(), null);
check('first conversation switch resets the draft history baseline', api.syncConversation('A'), true);
check('same conversation keeps the in-conversation undo history', api.syncConversation('A'), false);
check('switching to another conversation resets it again', api.syncConversation('B'), true);
check('conversation id follows the active conversation', api.conversationId(), 'B');
check('switching back to the same conversation id is still idempotent', api.syncConversation('B'), false);
// 隐藏的编辑器没有所有权：没有可见渲染编辑器时 flush 不写回、也不报成功。
check('flush without a visible rendered editor is a no-op', api.flush(), false);

// 12) 主页主稿的软换行：MathLive 单行排不下长中文 / 连续英文，注入 shadowRoot 的
//     折行规则必须还在（这是「长文本自动折行、不靠裁剪」的唯一来源）。
assert.equal(typeof api.wrapStyle, 'string', 'mathInputMode.wrapStyle 应暴露注入的折行规则');
for (const rule of [
  '.ML__content{align-items:start}',
  '.ML__latex{width:100%;min-width:0;max-width:100%;white-space:normal;overflow-wrap:anywhere}',
  '>.ML__base{display:inline;white-space:normal;overflow-wrap:anywhere}',
  '>.ML__text{white-space:pre-wrap;overflow-wrap:anywhere}'
]) {
  check('wrap style keeps ' + JSON.stringify(rule), api.wrapStyle.includes(rule), true);
}

// 13) 输入区高度上限：内容够多才长高；首屏以集合行末边为准（留 10px 页面边距），
//     有消息时给顶部对话区保留空间；任何情况下都有可用下限，且没有固定天花板。
assert.equal(typeof api.editorCap, 'function', 'mathInputMode.editorCap 应暴露高度计算');
check('cap: 首屏以集合行末边为准（留 10px 页面边距）',
  api.editorCap({rect: {top: 300, bottom: 480, height: 180}, metaBottom: 900, viewportHeight: 1000, empty: true}),
  270);
check('cap: 大视口里继续增长到集合行接近视口底部（没有 720px 天花板）',
  api.editorCap({rect: {top: 100, bottom: 600, height: 500}, metaBottom: 640, viewportHeight: 2000, empty: true}),
  1850);
check('cap: 没有集合行时退回外框底边推算',
  api.editorCap({rect: {top: 300, bottom: 480, height: 180}, wrapBottom: 560, viewportHeight: 1000, empty: true}),
  610);
check('cap: 有消息时给顶部对话区留出空间',
  api.editorCap({rect: {top: 500, bottom: 895, height: 395}, wrapBottom: 1000, viewportHeight: 1000, bodyTop: 120, empty: false}),
  679);
check('cap: 贴底时不低于可用下限（避免只剩分类条）',
  api.editorCap({rect: {top: 900, bottom: 990, height: 90}, metaBottom: 995, viewportHeight: 1000, bodyTop: 120, empty: true}),
  api.heightLimits.minRendered);
check('cap: 原文视图用自己的下限',
  api.editorCap({rect: {top: 940, bottom: 985, height: 45}, metaBottom: 996, viewportHeight: 1000, bodyTop: 120, empty: true, minHeight: api.heightLimits.minSource}),
  api.heightLimits.minSource);
check('cap: 不再有固定高度天花板', api.heightLimits.preferredMax, undefined);

// 14) 主页悬浮符号表：宽度只取加号 / 发送两按钮之间，两个按钮永远露出来；
//     高度按输入框下方到视口底部的可用空间限量，近底部保留一行符号键。
const floating = keyboard.floatingBox;
assert.equal(typeof floating, 'function', 'mathKeyboard.floatingBox 应暴露悬浮层几何');
const desktopBox = floating({
  anchor: {left: 100, right: 900, top: 300, bottom: 420},
  attach: {left: 60, right: 92, top: 448, bottom: 480},
  submit: {left: 780, right: 900, top: 448, bottom: 480},
  viewport: {width: 1000, height: 900}
});
check('floating width is capped at 480', desktopBox.width, 480);
check('floating keeps the attach button clear', desktopBox.left >= 92, true);
check('floating keeps the submit button clear', desktopBox.left + desktopBox.width <= 780, true);
check('floating starts below the input', desktopBox.top, 426);
check('floating uses the full preferred height when there is room', desktopBox.maxHeight, 240);
check('floating is not compact when there is room', desktopBox.compact, false);

const narrowBox = floating({
  anchor: {left: 20, right: 370, top: 400, bottom: 480},
  attach: {left: 10, right: 38, top: 500, bottom: 530},
  submit: {left: 250, right: 370, top: 500, bottom: 530},
  viewport: {width: 390, height: 844}
});
check('floating narrows to the space between the two buttons', narrowBox.width, 200);
check('floating narrow starts at the attach edge', narrowBox.left, 44);
check('floating narrow ends before the submit button', narrowBox.left + narrowBox.width <= 250, true);
check('floating never exceeds the viewport width', narrowBox.left + narrowBox.width <= 390 - 8, true);

const lowBox = floating({
  anchor: {left: 100, right: 900, top: 800, bottom: 895},
  attach: {left: 60, right: 92, top: 903, bottom: 935},
  submit: {left: 780, right: 900, top: 903, bottom: 935},
  viewport: {width: 1000, height: 1000}
});
check('floating near the bottom switches to compact', lowBox.compact, true);
check('floating near the bottom keeps one key row visible', lowBox.maxHeight, keyboard.floatingDefaults.minHeight);
check('floating near the bottom never covers the input edge', lowBox.top >= 895, true);

const wrappedBox = floating({
  anchor: {left: 100, right: 900, top: 300, bottom: 420},
  attach: {left: 60, right: 92, top: 448, bottom: 480},
  submit: {left: 780, right: 900, top: 700, bottom: 740},
  viewport: {width: 1000, height: 900}
});
check('floating falls back to the input width when buttons are on different rows',
  wrappedBox.width, 480);
check('floating fallback still stays inside the viewport', wrappedBox.left + wrappedBox.width <= 992, true);

// 15) 主页「不允许横向滚动条」：软换行覆盖不到的单个超宽数学盒要被识别，
//     交给原文层回退（LaTeX 原文可折行、可编辑），而不是硬剪掉或横滚。
assert.equal(typeof api.contentOverflows, 'function', 'mathInputMode.contentOverflows 应暴露横滚检测');
const fakeField = (scrollWidth, clientWidth) => ({
  shadowRoot: { querySelector: () => ({ scrollWidth, clientWidth }) }
});
check('overflow: 超宽不可断公式被识别', api.contentOverflows(fakeField(14596, 772)), true);
check('overflow: 折行后的普通长文不算横滚', api.contentOverflows(fakeField(772, 772)), false);
check('overflow: 2px 以内不算横滚', api.contentOverflows(fakeField(774, 772)), false);
check('overflow: 没有 shadowRoot 时安全返回 false', api.contentOverflows({}), false);
check('overflow: 隐藏字段（0 宽）不误判', api.contentOverflows(fakeField(0, 0)), false);
check('overflow: 尚未进入回退态', api.overflowFallback(), false);

if (process.exitCode) {
  console.error('math input tests failed');
} else {
  console.log('math input tests: ' + passed + ' passed');
}
