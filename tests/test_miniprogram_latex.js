// 小程序公式渲染的回归测试：node tests/test_miniprogram_latex.js
// （仓库的自动化测试跑 Python unittest；这里是纯前端模块，用 node 单独跑。）
const assert = require('assert');
const path = require('path');

const utils = path.join(__dirname, '..', 'miniprogram', 'utils');
const latex = require(path.join(utils, 'latex.js'));
const markdown = require(path.join(utils, 'markdown.js'));

let passed = 0;
function check(name, actual, expected) {
  if (typeof expected === 'function' ? expected(actual) : actual === expected) {
    passed += 1;
    return;
  }
  console.error('FAIL: ' + name + '\n  actual  : ' + JSON.stringify(actual) +
                '\n  expected: ' + String(expected));
  process.exitCode = 1;
}

function contains(name, actual, needle) {
  check(name, actual, (value) => value.includes(needle));
}

function missing(name, actual, needle) {
  check(name, actual, (value) => !value.includes(needle));
}

// 1) 行内公式：上标、关系运算符
check('inline e^x', latex.renderMath('e^x \\ge e x', false),
      '<span style="font-family:Georgia,serif;font-size:30rpx;color:#1f3d33;white-space:nowrap;">eˣ ≥ e x</span>');

// 2) 分式：一行写完，但对“原子”操作数不加多余括号
const frac = latex.renderMath('\\frac{a+b}{2}', false);
contains('frac complex wrapped', frac, '(a+b)/2');
const atomic = latex.renderMath('\\frac{1}{|A|}A^{*}', false);
contains('frac atomic bare', atomic, '1/|A|');
missing('frac no stray parens', atomic, '(1)');

// 3) 根号 + 上标
check('sqrt', latex.renderMath('\\sqrt{x^2+1}', false).includes('√(x²+1)'), true);

// 4) 希腊字母与求和
contains('greek', latex.renderMath('\\alpha+\\beta', false), 'α+β');
contains('sum limits', latex.renderMath('\\sum_{i=1}^{n} i', false), '∑<sub>i=1</sub>ⁿ');

// 5) 文本命令与集合符号
contains('text', latex.renderMath('\\text{当且仅当}', false), '当且仅当');
contains('mathbb', latex.renderMath('\\mathbb{R}', false), 'ℝ');

// 6) 代码块里的 $ 不能被当成公式
const fenced = markdown.toHtml('```\n$x^2$\n```');
contains('code fence untouched', fenced, '$x^2$');
missing('code fence no sup', fenced, '<sup>');

// 7) markdown 整体：公式在段落里被替换，其余 markdown 仍然生效
const html = markdown.toHtml('**结论**：$e^x \\ge e x$ 恒成立\n\n$$\\frac{d}{dx}e^x=e^x$$');
contains('bold kept', html, 'font-weight:600');
contains('inline math rendered', html, 'eˣ ≥ e x');
contains('display math rendered', html, 'eˣ=eˣ');
missing('no raw dollar', html, '$');
missing('no raw backslash-frac', html, '\\frac');

// 8) 未闭合的 $ 保持原样，不能吞掉后面的正文
contains('unbalanced dollar', markdown.toHtml('价格 $5 和 $6'), '$5');

// 9) 普通文本里没有公式时行为不变
contains('plain text', markdown.toHtml('就是一句话'), '就是一句话');

// 10) 带撇号与括号的导函数也要识别（$f'(x)$）
const derivative = markdown.toHtml("求 $f'(x)$");
missing('derivative dollar gone', derivative, '$');
contains('derivative kept', derivative, "f&#39;(x)");

// 11) \left( \right) 只保留括号
contains('left right', markdown.toHtml('$\\left(x+1\\right)$'), '(x+1)');

console.log('miniprogram latex tests: ' + passed + ' passed');
