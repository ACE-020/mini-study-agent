"use strict";
// 主页布局契约的静态回归：node tests/test_home_layout.js
//
// 这里不测像素，只锁住这次验收明确要求的几条可执行契约：
//   1) 首屏三行说明同一字号（第四行只作提示）；
//   2) 「图片 · PDF · TXT · Markdown」独立提示行已删除，空间给了文字区；
//   3) 输入区不再被固定 max-height 裁掉，MathLive 的公式面板不再限高 190px；
//   4) 主稿 window 折行（原生 textarea 与注入 MathLive 的规则）不被删回单行；
//   5) 左栏可呈现下限与 .home-history-inner 的真实内部宽度一致。
// 真实 Chrome 里的观感（字号、折行、悬浮层落位）仍由浏览器侧复测。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(root, "static", "home-layout.css"), "utf8");
const keyboardCss = fs.readFileSync(path.join(root, "static", "math-keyboard.css"), "utf8");
const html = fs.readFileSync(path.join(root, "templates", "index.html"), "utf8");
const inputMode = fs.readFileSync(path.join(root, "static", "math-input-mode.js"), "utf8");
const keyboardJs = fs.readFileSync(path.join(root, "static", "math-keyboard.js"), "utf8");
const panelsJs = fs.readFileSync(path.join(root, "static", "home-panels.js"), "utf8");

function rule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 只匹配独立成行的选择器，避免 `.home-panels[...] #draft` 抢先命中。
  const match = new RegExp("(?:^|\\n)" + escaped + "\\s*\\{([^}]*)\\}").exec(source);
  return match ? match[1] : null;
}

function declaration(body, name) {
  if (!body) return null;
  const match = new RegExp("(?:^|;|\\s)" + name + "\\s*:\\s*([^;]+)").exec(body);
  return match ? match[1].trim() : null;
}

function px(value) {
  const match = /(-?\d+(?:\.\d+)?)px/.exec(String(value || ""));
  return match ? Number(match[1]) : null;
}

test("样式文件括号成对（避免整段规则被吞）", () => {
  for (const [name, source] of [
    ["home-layout.css", css],
    ["math-keyboard.css", keyboardCss]
  ]) {
    const open = (source.match(/\{/g) || []).length;
    const close = (source.match(/\}/g) || []).length;
    assert.equal(open, close, `${name} 花括号数量应一致`);
  }
});

test("首屏三行说明共用同一字号，第四行只作提示", () => {
  // h1 与两行 .home-empty-line 必须出现在同一条规则里，字号才可能完全一致。
  const group = /\.home-empty-copy h1,\s*\.home-empty-line\s*\{([^}]*)\}/.exec(css);
  assert.ok(group, "三行说明应共用一条字号规则");
  const shared = declaration(group[1], "font-size");
  assert.ok(shared, "共用规则必须有 font-size");

  // 旧的标题（clamp 28-40px）与副文案（clamp 15-18px）之间。
  const numbers = (shared.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  assert.ok(numbers.length >= 3, `字号应是 fluid 值：${shared}`);
  const [min, , max] = numbers;
  assert.ok(min > 18 && min < 28, `最小字号应在旧副文案与旧标题之间：${shared}`);
  assert.ok(max > 18 && max < 28, `最大字号应在旧副文案与旧标题之间：${shared}`);

  const hint = rule(css, ".home-empty-hint");
  const hintSize = px(declaration(hint, "font-size"));
  assert.ok(hintSize && hintSize < min, "第四行提示必须比说明小一档");

  // 窄屏也不许把三行拆回两个字号：同一选择器组 + 一个明确字号。
  const narrow = /@media \(max-width: 480px\) \{[\s\S]*?\n\}/.exec(css);
  assert.ok(narrow, "应有 480px 断点");
  const narrowGroup = /\.home-empty-copy h1,\s*\.home-empty-line\s*\{([^}]*)\}/.exec(narrow[0]);
  assert.ok(narrowGroup, "窄屏也应保持同一字号规则");
  const narrowSize = px(declaration(narrowGroup[1], "font-size"));
  assert.ok(narrowSize && narrowSize < min, `窄屏字号也要在旧副文案之上、旧标题之下：${narrowSize}`);
});

test("首屏整组上移，说明与输入区之间留固定间距", () => {
  const body = /\.home-panels\[data-home-empty="true"\] \.home-chat-body\s*\{([^}]*)\}/.exec(css);
  assert.ok(body, "首屏对话区应有独立规则");
  assert.equal(declaration(body[1], "justify-content"), "flex-start", "整组应贴顶（往上）");
  assert.ok(declaration(body[1], "gap"), "说明与输入区之间应有间距");
});

test("独立附件提示行已删除，空间转到实际文字区", () => {
  assert.ok(!/图片\s*·\s*PDF/.test(html), "模板里不应再有「图片 · PDF · TXT · Markdown」");
  assert.ok(!/home-attach-hint/.test(html), "模板里不应再有 .home-attach-hint 节点");
  assert.ok(!/\.home-attach-hint/.test(css), "样式里不应再有 .home-attach-hint");

  // 首屏输入区初始更高：MathLive 外框与 textarea 都加高。
  const host = /\.home-panels\[data-home-empty="true"\] \.home-composer-panel \.formula-editor-host\s*\{([^}]*)\}/.exec(css);
  assert.ok(host, "首屏公式外框应有加高规则");
  assert.ok(px(declaration(host[1], "min-height")) >= 150, "首屏公式外框初始高度应明显高于旧值");
  const source = /\.home-panels\[data-home-empty="true"\] #draft\s*\{([^}]*)\}/.exec(css);
  assert.ok(source, "首屏 textarea 应有加高规则");
  assert.ok(px(declaration(source[1], "min-height")) >= 128, "首屏 textarea 初始高度应明显高于旧值");

  // 输入区宽度不变：内层仍是 840px 上限。
  const panel = rule(css, "#source-panel.home-composer-panel");
  assert.equal(px(declaration(panel, "max-width")), 840);
});

test("输入区不再被固定 max-height 裁掉，纵向滚动交给输入区自己", () => {
  const draft = rule(css, "#draft");
  assert.equal(declaration(draft, "max-height"), "none", "textarea 不应再有固定 max-height");
  assert.equal(declaration(draft, "overflow-y"), "auto", "内容够多后由 textarea 自己纵向滚动");
  assert.equal(declaration(draft, "white-space"), "pre-wrap", "长中文 / 粘贴多行必须原生折行");
  assert.equal(declaration(draft, "overflow-wrap"), "anywhere", "连续英文也必须折行");
  assert.equal(declaration(draft, "overflow-x"), "hidden", "不应出现横向滚动条");

  const paneBody = rule(css, ".home-composer-panel .formula-pane");
  assert.ok(paneBody, "公式面板应有独立规则");
  assert.equal(declaration(paneBody, "max-height"), "none", "旧的 190px 限高必须去掉");
  assert.notEqual(declaration(paneBody, "overflow-y"), "auto", "面板本身不再做纵向裁切");

  const fieldBody = rule(css, ".home-composer-panel .formula-editor-host math-field");
  assert.ok(fieldBody, "主稿 math-field 应有滚动态规则");
  assert.equal(declaration(fieldBody, "overflow-y"), "auto", "到上限后由 math-field 纵向滚动");
});

test("MathLive 主稿注入软换行规则，旧滚轮转横逻辑已移除", () => {
  assert.ok(/WRAP_STYLE/.test(inputMode), "math-input-mode 应有折行样式常量");
  assert.ok(/ML__latex\{width:100%/.test(inputMode), "折行规则应让 .ML__latex 占满可用宽度");
  assert.ok(/ML__text\{white-space:pre-wrap/.test(inputMode), "文字盒应允许折行");
  assert.ok(/injectShadowStyle\(mf, wrap\)/.test(inputMode), "只有主稿注入折行规则");
  assert.ok(
    !/content\.scrollLeft \+= delta/.test(inputMode),
    "旧的「纵向滚轮转横向」逻辑必须移除，否则会吃掉纵向滚动"
  );
  assert.ok(/editorCap: editorHeightCap/.test(inputMode), "应暴露高度上限计算供自测");
});

test("主页符号表是悬浮层：不占布局、宽度夹在两按钮之间、可用高度受限", () => {
  const floating = /\.mk-panel\.mk-panel-floating\s*\{([^}]*)\}/.exec(keyboardCss);
  assert.ok(floating, "悬浮层应有独立样式");
  assert.equal(declaration(floating[1], "position"), "fixed", "悬浮层不能占布局高度");
  assert.equal(declaration(floating[1], "overflow-y"), "auto", "更多符号键要能纵向滚动");

  assert.ok(/attachSelector: "#home-attach-button"/.test(keyboardJs), "宽度参考加号按钮");
  assert.ok(/submitSelector: "#organize-submit"/.test(keyboardJs), "宽度参考发送按钮");
  assert.ok(/maxWidth: 480/.test(keyboardJs), "桌面宽度上限约 480px");
  assert.ok(/floatingBox: computeFloatingBox/.test(keyboardJs), "应暴露悬浮层几何供自测");
});

test("主页主稿关闭内部横向滚动，超宽公式改用原文回退（其他页面保持旧行为）", () => {
  const homePart = /\.home-composer-panel \.formula-editor-host math-field::part\(content\)\s*\{([^}]*)\}/.exec(css);
  assert.ok(homePart, "主页主稿应有独立的 ::part(content) 规则");
  assert.equal(
    declaration(homePart[1], "overflow-x"),
    "hidden",
    "主页不允许出现横向滚动条"
  );

  // 其他页面的公式编辑器沿用旧行为：单个巨公式仍可横向滚动，不硬剪掉。
  const sharedPart = /^\.formula-editor-host math-field::part\(content\)\s*\{([^}]*)\}/m.exec(keyboardCss);
  assert.ok(sharedPart, "通用公式编辑器仍应有横滚规则");
  assert.equal(declaration(sharedPart[1], "overflow-x"), "auto");

  // 回退逻辑：比较 scrollWidth / clientWidth，命中时切到已有的原文视图；
  // 只有编辑器当前持有焦点时才搬移焦点（被动检测不抢别的控件）。
  assert.ok(/content\.scrollWidth/.test(inputMode), "应比较 scrollWidth 与 clientWidth");
  assert.ok(/function checkOverflowFallback/.test(inputMode), "应有横滚回退检测");
  assert.ok(/setView\(VIEW_SOURCE, \{ focus: heldFocus \}\)/.test(inputMode), "回退时切到可折行的原文层");
  assert.ok(/const heldFocus = isMainDraftFocus\(\)/.test(inputMode), "只在编辑器持有焦点时搬焦点");
  assert.ok(/contentOverflows: contentOverflows/.test(inputMode), "应暴露检测函数供自测");
});

test("左栏可呈现下限与 .home-history-inner 的真实内部宽度一致", () => {
  const inner = rule(css, ".home-history-inner");
  const innerMin = px(declaration(inner, "min-width"));
  assert.ok(innerMin, "内部布局必须有明确的 min-width");
  const floor = Number(/minLeftWidth: (\d+)/.exec(panelsJs)[1]);
  assert.ok(floor >= 184 && floor <= 200, `左栏默认下限应在 184–200px：${floor}`);
  assert.ok(floor >= innerMin + 1, `左栏 ${floor}px 必须容得下内部 ${innerMin}px + 1px 边框`);
});
