// Browser-side and mini-program LaTeX rendering regression tests.
// Run: node tests/test_latex_rendering.cjs
//
// The web part loads the real static/app.js with the real marked build, a
// small DOM shim and a KaTeX render stub; formula *typesetting* is checked
// separately with the real KaTeX build. The mini-program part loads the real
// mp-html parser/plugins with a wx stub and the real katex-mini build.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); }
  catch (error) { results.push(['FAIL', name, error.message]); console.error('FAIL', name, error.stack || error); }
}

// ---------------------------------------------------------------- web DOM shim
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: '\u00a0' };
function decode(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : whole;
    }
    return ENTITIES[name] !== undefined ? ENTITIES[name] : whole;
  });
}
function encode(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
class TextNode {
  constructor(value) { this.nodeType = 3; this.nodeName = '#text'; this.nodeValue = String(value); this.parentNode = null; }
}
class Fragment {
  constructor() { this.nodeType = 11; this.nodeName = '#fragment'; this.childNodes = []; this.parentNode = null; }
  appendChild(child) { child.parentNode = this; this.childNodes.push(child); return child; }
}
class Element {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toLowerCase();
    this.nodeName = this.tagName.toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = [];
    this._class = '';
  }
  get className() { return this._class; }
  set className(value) { this._class = String(value); this.setAttribute('class', this._class); }
  setAttribute(name, value) {
    name = String(name).toLowerCase();
    const item = this.attributes.find((attr) => attr.name === name);
    if (item) item.value = String(value); else this.attributes.push({ name, value: String(value) });
  }
  getAttribute(name) {
    const item = this.attributes.find((attr) => attr.name === String(name).toLowerCase());
    return item ? item.value : null;
  }
  appendChild(child) { child.parentNode = this; this.childNodes.push(child); return child; }
  replaceChild(newNode, oldNode) {
    const index = this.childNodes.indexOf(oldNode);
    if (index < 0) throw new Error('node not found');
    if (newNode && newNode.nodeType === 11) {
      for (const child of newNode.childNodes) child.parentNode = this;
      this.childNodes.splice(index, 1, ...newNode.childNodes);
      newNode.childNodes = [];
      return oldNode;
    }
    newNode.parentNode = this;
    this.childNodes[index] = newNode;
    oldNode.parentNode = null;
    return oldNode;
  }
  set textContent(value) { this.childNodes = []; if (value !== '') this.appendChild(new TextNode(value)); }
  get textContent() { return this.childNodes.map((child) => child.nodeType === 3 ? child.nodeValue : child.textContent).join(''); }
  set innerHTML(html) {
    this.childNodes = [];
    const stack = [this];
    const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w:-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>\/]+))?)*)\s*\/?>|([^<]+)/g;
    let match;
    while ((match = re.exec(String(html)))) {
      if (match[3] !== undefined) {
        if (match[3]) stack[stack.length - 1].appendChild(new TextNode(decode(match[3])));
        continue;
      }
      if (match[1] === undefined) continue;
      const tag = match[1].toLowerCase();
      if (match[0].startsWith('</')) {
        for (let i = stack.length - 1; i > 0; i -= 1) {
          if (stack[i].tagName === tag) { stack.length = i; break; }
        }
        continue;
      }
      const node = new Element(tag);
      const attrRe = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>\/]+)))?/g;
      let attr;
      while ((attr = attrRe.exec(match[2] || ''))) {
        const value = attr[2] !== undefined ? attr[2] : attr[3] !== undefined ? attr[3] : attr[4] !== undefined ? attr[4] : '';
        node.setAttribute(attr[1], decode(value));
      }
      stack[stack.length - 1].appendChild(node);
      if (!VOID.has(tag) && !/\/>$/.test(match[0])) stack.push(node);
    }
  }
  get innerHTML() {
    return this.childNodes.map((child) => {
      if (child.nodeType === 3) return encode(child.nodeValue);
      const attrs = child.attributes.map((attr) => ' ' + attr.name + '="' + String(attr.value).replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"').join('');
      return '<' + child.tagName + attrs + '>' + child.innerHTML + '</' + child.tagName + '>';
    }).join('');
  }
  querySelectorAll(selector) {
    const out = [];
    const wanted = selector === '*' ? null : selector.replace(/^\./, '');
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        if (wanted === null || child.tagName === wanted || child.className.split(/\s+/).includes(wanted)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
}
function collectText(root) {
  const out = [];
  const walk = (node) => {
    for (const child of node.childNodes || []) {
      if (child.nodeType === 3) out.push(child);
      else if (child.nodeType === 1) walk(child);
    }
  };
  walk(root);
  return out;
}
const document = {
  createElement: (tag) => new Element(tag),
  createTextNode: (text) => new TextNode(text),
  createDocumentFragment: () => new Fragment(),
  createTreeWalker: (root) => {
    const nodes = collectText(root);
    let index = -1;
    return { nextNode() { index += 1; return nodes[index] || null; }, get currentNode() { return nodes[index] || null; } };
  },
  querySelector: () => new Element('div'),
  querySelectorAll: () => []
};
const sandbox = {
  console, setTimeout, clearTimeout, Promise, Math, Date, JSON, RegExp, String, Object, Array, Set, Map,
  document, window: null,
  localStorage: { removeItem() {} }, location: { hash: '' }, history: { replaceState() {} },
  fetch: () => Promise.reject(new Error('no network')), crypto: { randomUUID: () => 'uuid' }
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.addEventListener = () => {};
sandbox.marked = require(path.join(ROOT, 'static/vendor/marked.umd.js'));
sandbox.DOMPurify = { sanitize: (html) => html };
sandbox.katex = {
  render(tex, element, options) {
    element.__tex = tex;
    element.__display = options.displayMode;
    element.__options = options;
    element.innerHTML = '<span class="katex">' + encode(tex) + '</span>';
  }
};
const web = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'static/app.js'), 'utf8'), web, { filename: 'static/app.js' });
function render(value) {
  const element = new Element('div');
  web.__el = element;
  web.__value = value;
  vm.runInContext('rich(__el, __value)', web);
  return element;
}
function mathOf(element) {
  const out = [];
  const walk = (node) => {
    for (const child of node.childNodes || []) {
      if (child.nodeType !== 1) continue;
      if (/\bmath-(?:inline|display)\b/.test(child.className)) out.push(child);
      walk(child);
    }
  };
  walk(element);
  return out;
}

check('web: four delimiters', () => {
  const boxes = mathOf(render('$x$ $$y$$ \\(z\\) \\[w\\]'));
  assert.equal(boxes.length, 4);
  assert.deepEqual(boxes.map((box) => box.__tex), ['x', 'y', 'z', 'w']);
  assert.deepEqual(boxes.map((box) => box.__display), [false, true, false, true]);
  assert.ok(boxes.every((box) => box.__options.trust === false && box.__options.throwOnError === false));
});
check('web: escaped dollar is literal', () => {
  const el = render('价格 \\$5 和 \\$6');
  assert.equal(mathOf(el).length, 0);
  assert.ok(el.textContent.includes('$5') && el.textContent.includes('$6'));
  assert.ok(!el.textContent.includes('\\$'));
});
check('web: currency pair is not math, later formula still works', () => {
  const el = render('价格 $5 和 $6，还有 $x$');
  const boxes = mathOf(el);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].__tex, 'x');
});
check('web: multi-char/number/spaced inline math', () => {
  const boxes = mathOf(render('变量 $xy$ 和 $12$，速度 $v t$。'));
  assert.deepEqual(boxes.map((box) => box.__tex), ['xy', '12', 'v t']);
});
check('web: currency range is not math', () => {
  const el = render('价格 $5 到 $10');
  assert.equal(mathOf(el).length, 0);
  assert.ok(el.textContent.includes('$5 到 $10'));
});
check('web: escaped dollar inside formula is not a closer', () => {
  const boxes = mathOf(render('$\\$5$'));
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].__tex, '\\$5');
});
check('web: literal token stays literal', () => {
  const el = render('STUDYMATH0TOKEN $x$');
  assert.ok(el.textContent.includes('STUDYMATH0TOKEN'));
  assert.equal(mathOf(el).length, 1);
});
check('web: markdown emphasis does not split formula', () => {
  const el = render('**加粗** $a*b*c$ 以及 *斜体*');
  assert.ok(el.innerHTML.includes('<strong>') && el.innerHTML.includes('<em>'));
  assert.equal(mathOf(el)[0].__tex, 'a*b*c');
});
check('web: code/pre keep dollars and backslashes', () => {
  const el = render('`$x^2$` 与 `\\$5`\n\n```\n$$y$$\n```');
  assert.equal(mathOf(el).length, 0);
  const code = el.querySelectorAll('code').map((node) => node.textContent).join('|');
  assert.ok(code.includes('$x^2$') && code.includes('\\$5') && code.includes('$$y$$'));
});
check('web: tilde fence keeps escaped dollar', () => {
  const el = render('~~~js\nconst a = "\\$5";\n~~~');
  assert.equal(mathOf(el).length, 0);
  assert.ok(el.querySelectorAll('code')[0].textContent.includes('\\$5'));
});
check('web: matrix keeps backslashes', () => {
  const box = mathOf(render('$$\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}$$'))[0];
  assert.ok(box.__tex.includes('\\\\') && box.__tex.includes('&'));
});
check('web: blockquote formula normalizes quote markers', () => {
  const box = mathOf(render('> 注解\n>\n> $$\n> \\begin{aligned}a&=b\\\\b&=c\\end{aligned}\n> $$'))[0];
  assert.ok(box.__tex.includes('aligned'));
  assert.ok(!box.__tex.includes('>'));
});
check('web: link title keeps text, no markup', () => {
  const link = render('[看这里](https://example.test "$y$")').querySelectorAll('a')[0];
  assert.equal(link.getAttribute('title'), '$y$');
  assert.ok(!link.innerHTML.includes('katex'));
});
check('web: normal link href is not rewritten', () => {
  const link = render('[看这里](https://example.test/path?q=1 "$y$")').querySelectorAll('a')[0];
  assert.equal(link.getAttribute('href'), 'https://example.test/path?q=1');
});
check('web: unpaired dollar in link href keeps no placeholder', () => {
  const link = render('[说明](https://example.invalid/?price=$5)').querySelectorAll('a')[0];
  assert.equal(link.getAttribute('href'), 'https://example.invalid/?price=$5');
  assert.ok(!link.getAttribute('href').includes('STUDYMATH'));
});
check('web: formula in link href is restored before final sanitize', () => {
  const link = render('[说明](https://example.invalid/?q=$x$)').querySelectorAll('a')[0];
  assert.equal(link.getAttribute('href'), 'https://example.invalid/?q=$x$');
  assert.ok(!link.getAttribute('href').includes('STUDYMATH'));
});
check('web: no placeholder leaks', () => {
  const el = render('$x^2$');
  assert.ok(!/STUDYMATH/.test(el.innerHTML));
});

// Real KaTeX checks for the typesetting options used by rich().
const katex = require(path.join(ROOT, 'static/vendor/katex/katex.min.js'));
function katexOptions(displayMode) { return { displayMode, throwOnError: false, trust: false, strict: 'ignore' }; }
check('web: real KaTeX invalid formula is visible', () => {
  assert.ok(katex.renderToString('\\frac{1}{', katexOptions(false)).includes('katex-error'));
});
check('web: real KaTeX trust:false blocks links', () => {
  const out = katex.renderToString('\\href{javascript:alert(1)}{x}', katexOptions(false));
  assert.ok(!/href=/.test(out) && !/<a\s/.test(out));
});
check('web: real KaTeX matrix/aligned/limit render', () => {
  for (const tex of ['\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}', '\\begin{aligned}a&=b\\\\c&=d\\end{aligned}', '\\lim_{x\\to0}\\frac{\\sin x}{x}=1']) {
    assert.ok(!katex.renderToString(tex, katexOptions(true)).includes('katex-error'), tex);
  }
});

// ------------------------------------------------------- mini-program parser
global.wx = {
  canIUse: () => true,
  getWindowInfo: () => ({ windowWidth: 375, windowHeight: 700 }),
  getDeviceInfo: () => ({ system: 'iOS 15.0', platform: 'ios' }),
  getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 700, system: 'iOS 15.0', platform: 'ios' })
};
const MP = path.join(ROOT, 'miniprogram/components/mp-html');
const Parser = require(path.join(MP, 'parser.js'));
const Latex = require(path.join(MP, 'plugins/latex.js'));
const Markdown = require(path.join(MP, 'plugins/markdown.js'));
function mpParse(content) {
  const owner = {
    data: { markdown: true, editable: false },
    properties: { markdown: true },
    imgList: []
  };
  // Same order as Component.created: the build lists [latex, markdown] and
  // pushes them in reverse, then Parser runs onUpdate/onParse in reverse.
  const plugins = [new Markdown(owner), new Latex(owner)];
  owner.plugins = plugins;
  owner._ids = {};
  const parser = new Parser(owner);
  return parser.parse(content);
}
function mpWalk(nodes, fn) {
  for (const node of nodes || []) {
    fn(node);
    if (node.children) mpWalk(node.children, fn);
  }
}
function mpText(nodes) {
  let out = '';
  mpWalk(nodes, (node) => { if (node.type === 'text') out += node.text; });
  return out;
}
function mpBoxes(nodes) {
  const out = [];
  mpWalk(nodes, (node) => {
    const style = (node.attrs && node.attrs.style) || '';
    if (style.includes('max-width:100%') && style.includes('overflow-x:auto')) out.push(node);
  });
  return out;
}
function mpErrors(nodes) {
  const out = [];
  mpWalk(nodes, (node) => { if (((node.attrs && node.attrs.class) || '').includes('katex-error')) out.push(node); });
  return out;
}

check('mini: four delimiters', () => {
  const nodes = mpParse('$x$ $$y$$ \\(z\\) \\[w\\]');
  assert.equal(mpBoxes(nodes).length, 4);
  assert.equal(mpErrors(nodes).length, 0);
});
check('mini: multi-char/number/spaced inline math', () => {
  assert.equal(mpBoxes(mpParse('变量 $xy$ 和 $12$，速度 $v t$。')).length, 3);
});
check('mini: currency range is not math', () => {
  const nodes = mpParse('价格 $5 到 $10');
  assert.equal(mpBoxes(nodes).length, 0);
  assert.ok(mpText(nodes).includes('$5 到 $10'));
});
check('mini: escaped dollars are literal', () => {
  const nodes = mpParse('价格 \\$5 和 \\$6');
  assert.equal(mpBoxes(nodes).length, 0);
  assert.ok(mpText(nodes).includes('$5') && mpText(nodes).includes('$6'));
});
check('mini: escaped dollar inside formula is not a closer', () => {
  assert.equal(mpBoxes(mpParse('$\\$5$')).length, 1);
});
check('mini: markdown emphasis does not split formula', () => {
  const nodes = mpParse('**加粗** $a*b*c$ 与 *斜体*');
  const tags = [];
  mpWalk(nodes, (node) => { if (node.name) tags.push(node.name); });
  assert.equal(mpBoxes(nodes).length, 1);
  assert.ok(tags.includes('strong') && tags.includes('em'));
});
check('mini: inline code and fences keep backslashes/dollars', () => {
  const nodes = mpParse('`$x^2$` 与 `\\$5`\n\n```\n$$y$$\n```');
  assert.equal(mpBoxes(nodes).length, 0);
  const plain = mpText(nodes);
  assert.ok(plain.includes('$x^2$') && plain.includes('\\$5') && plain.includes('$$y$$'));
});
check('mini: tilde fence keeps escaped dollar', () => {
  const nodes = mpParse('~~~js\nconst a = "\\$5";\n~~~');
  assert.equal(mpBoxes(nodes).length, 0);
  assert.ok(mpText(nodes).includes('\\$5'));
});
check('mini: matrix/aligned render without errors', () => {
  for (const tex of ['$$\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}$$', '$$\\begin{aligned}a&=b\\\\c&=d\\end{aligned}$$']) {
    const nodes = mpParse(tex);
    assert.equal(mpBoxes(nodes).length, 1, tex);
    assert.equal(mpErrors(nodes).length, 0, tex);
  }
});
check('mini: invalid formula stays visible, following text intact', () => {
  const nodes = mpParse('$\\frac{1}{$ 之后还有字');
  assert.ok(mpErrors(nodes).length >= 1);
  assert.ok(mpText(nodes).includes('之后还有字'));
});
check('mini: link title keeps source text', () => {
  const nodes = mpParse('[看这里](https://example.test "$y$")');
  let title = '';
  mpWalk(nodes, (node) => { if (node.name === 'a') title = node.attrs.title; });
  assert.equal(title, '$y$');
  assert.ok(!JSON.stringify(nodes).includes('\u0001'));
});
check('mini: scroll style on inline and display wrappers', () => {
  const boxes = mpBoxes(mpParse('$x$ $$y$$'));
  assert.equal(boxes.length, 2);
  for (const box of boxes) {
    assert.ok(box.attrs.style.includes('max-width:100%'));
    assert.equal(box.f, box.attrs.style);
  }
  assert.ok(boxes[0].attrs.style.includes('-webkit-overflow-scrolling:touch'));
  assert.ok(fs.readFileSync(path.join(MP, 'index.js'), 'utf8').includes('properties:{markdown:Boolean'));
});

for (const item of results) console.log(item.join(' '));
const failures = results.filter((item) => item[0] === 'FAIL');
console.log(failures.length ? 'FAILED ' + failures.length : 'ALL LATEX RENDERING CHECKS PASS');
process.exitCode = failures.length ? 1 : 0;
