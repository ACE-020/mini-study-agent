"use strict";
// 直接测试 static/home-panels.js 的交互切片：node tests/test_home_panels.js
//
// 这个测试不依赖浏览器或第三方库：用最小 DOM / 事件 / 定时器桩加载切片源码，
// 覆盖导航 500ms 浮层、左右面板按钮与拖拽、最小对话宽度、窄屏抽屉、窗口回缩、
// 焦点与草稿保留、销毁还原。真实布局与过渡仍由后续 CSS 负责，不在本测试范围。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "static", "home-panels.js"),
  "utf8"
);

// ---------------- 最小 DOM 桩 ----------------

function createClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(handler, delay) {
      const id = nextId++;
      timers.set(id, {
        id,
        at: now + Math.max(0, Number(delay) || 0),
        handler,
      });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      const target = now + Math.max(0, Number(ms) || 0);
      for (;;) {
        let next = null;
        for (const timer of timers.values()) {
          if (timer.at > target) continue;
          if (
            !next ||
            timer.at < next.at ||
            (timer.at === next.at && timer.id < next.id)
          ) {
            next = timer;
          }
        }
        if (!next) break;
        timers.delete(next.id);
        now = next.at;
        next.handler();
      }
      now = target;
    },
    pending() {
      return timers.size;
    },
  };
}

function fire(target, type, props = {}) {
  const event = Object.assign(
    {
      type,
      target,
      currentTarget: null,
      defaultPrevented: false,
      stopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.stopped = true;
      },
    },
    props
  );
  let node = target;
  while (node) {
    event.currentTarget = node;
    const handlers = node._listeners && node._listeners.get(type);
    if (handlers) {
      for (const handler of handlers.slice()) handler.call(node, event);
    }
    if (event.stopped) break;
    node = node.parentNode;
  }
  return event;
}

class FakeEventTarget {
  constructor() {
    this._listeners = new Map();
    this.parentNode = null;
  }

  addEventListener(type, handler) {
    if (typeof handler !== "function") return;
    let handlers = this._listeners.get(type);
    if (!handlers) {
      handlers = [];
      this._listeners.set(type, handlers);
    }
    if (!handlers.includes(handler)) handlers.push(handler);
  }

  removeEventListener(type, handler) {
    const handlers = this._listeners.get(type);
    if (!handlers) return;
    const index = handlers.indexOf(handler);
    if (index >= 0) handlers.splice(index, 1);
  }
}

class FakeElement extends FakeEventTarget {
  constructor(ownerDocument, tagName) {
    super();
    this.ownerDocument = ownerDocument;
    this.tagName = String(tagName).toUpperCase();
    this.id = "";
    this.value = "";
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.disabled = false;
    this.childNodes = [];
    this._attrs = new Map();
    this._clientWidth = 0;
    this._clientHeight = 0;
    this._pointerCapture = new Set();
    const styleValues = new Map();
    this.style = {
      setProperty(name, value) {
        styleValues.set(name, String(value));
      },
      getPropertyValue(name) {
        return styleValues.has(name) ? styleValues.get(name) : "";
      },
      removeProperty(name) {
        styleValues.delete(name);
      },
    };
  }

  setAttribute(name, value) {
    this._attrs.set(name, String(value));
    if (name === "id") this.id = String(value);
  }

  getAttribute(name) {
    return this._attrs.has(name) ? this._attrs.get(name) : null;
  }

  hasAttribute(name) {
    return this._attrs.has(name);
  }

  removeAttribute(name) {
    this._attrs.delete(name);
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node.parentNode) {
        const siblings = node.parentNode.childNodes;
        const index = siblings.indexOf(node);
        if (index >= 0) siblings.splice(index, 1);
      }
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }

  contains(node) {
    if (!node) return false;
    if (node === this) return true;
    let current = node.parentNode;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  get clientWidth() {
    return this._clientWidth;
  }

  get clientHeight() {
    return this._clientHeight;
  }

  getBoundingClientRect() {
    const left = Number(this._rectLeft) || 0;
    const top = Number(this._rectTop) || 0;
    return {
      left,
      top,
      right: left + this._clientWidth,
      bottom: top + this._clientHeight,
      width: this._clientWidth,
      height: this._clientHeight,
    };
  }

  focus() {
    if (this.hasAttribute("inert")) return;
    const document = this.ownerDocument;
    if (!document || document.activeElement === this) return;
    const previous = document.activeElement;
    if (previous && previous !== this) {
      fire(previous, "focusout", { relatedTarget: this });
    }
    document.activeElement = this;
    fire(this, "focus", {});
    fire(this, "focusin", { relatedTarget: previous || null });
  }

  setPointerCapture(pointerId) {
    this._pointerCapture.add(pointerId);
  }

  releasePointerCapture(pointerId) {
    this._pointerCapture.delete(pointerId);
  }
}

class FakeDocument extends FakeEventTarget {
  constructor() {
    super();
    this.defaultView = null;
    this.documentElement = new FakeElement(this, "html");
    this.documentElement.parentNode = this;
    this.body = new FakeElement(this, "body");
    this.body.parentNode = this.documentElement;
    this.activeElement = this.body;
  }

  createElement(tagName) {
    return new FakeElement(this, tagName);
  }
}

// ---------------- 测试环境 ----------------

function createHarness({ width = 1440, options = {} } = {}) {
  const clock = createClock();
  const document = new FakeDocument();
  const window = new FakeEventTarget();
  window.document = document;
  window.innerWidth = width;
  window.innerHeight = 900;
  window.setTimeout = clock.setTimeout;
  window.clearTimeout = clock.clearTimeout;
  document.defaultView = window;
  document.documentElement._clientWidth = width;
  document.documentElement._clientHeight = 900;

  const el = (tag) => document.createElement(tag);
  const root = el("div");
  root.id = "home";
  root._clientWidth = width;
  root._clientHeight = 900;
  // 宽屏下主页容器从固定导航栏占位（72px）之后开始：拖拽收起的分界线在这里。
  root._rectLeft = 72;
  const nav = el("nav");
  nav.id = "home-nav";
  const leftPanel = el("section");
  leftPanel.id = "home-left-panel";
  leftPanel._rectLeft = 72;
  const rightPanel = el("section");
  rightPanel.id = "home-right-panel";
  const leftHandle = el("div");
  leftHandle.id = "home-left-handle";
  const rightHandle = el("div");
  rightHandle.id = "home-right-handle";
  const leftButton = el("button");
  leftButton.id = "home-left-toggle";
  const rightButton = el("button");
  rightButton.id = "home-right-toggle";
  const composer = el("textarea");
  composer.value = "公式草稿 ∫x";
  const draft = el("textarea");
  draft.value = "面板内的草稿";
  draft.selectionStart = 2;
  draft.selectionEnd = 4;

  document.body.append(nav, root);
  leftPanel.append(draft);
  root.append(
    composer,
    leftPanel,
    leftHandle,
    rightHandle,
    rightPanel,
    leftButton,
    rightButton
  );

  const context = vm.createContext({
    window,
    document,
    console,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  vm.runInContext(SOURCE, context, { filename: "home-panels.js" });
  assert.equal(
    typeof window.homePanels.create,
    "function",
    "homePanels.create 应挂到 window"
  );

  const controller = window.homePanels.create(
    Object.assign(
      {
        root,
        nav,
        leftPanel,
        rightPanel,
        leftHandle,
        rightHandle,
        leftButton,
        rightButton,
      },
      options
    )
  );

  function resize(nextWidth) {
    window.innerWidth = nextWidth;
    root._clientWidth = nextWidth;
    document.documentElement._clientWidth = nextWidth;
    fire(window, "resize", {});
  }

  return {
    clock,
    document,
    window,
    controller,
    resize,
    fire,
    el: {
      root,
      nav,
      leftPanel,
      rightPanel,
      leftHandle,
      rightHandle,
      leftButton,
      rightButton,
      composer,
      draft,
    },
  };
}

function cssVar(harness, name) {
  return harness.el.root.style.getPropertyValue(name);
}

// ---------------- 测试 ----------------

test("create 暴露默认值并校验必填节点", () => {
  const harness = createHarness();
  const { DEFAULTS } = harness.window.homePanels;
  assert.equal(DEFAULTS.minConversationWidth, 440);
  assert.equal(DEFAULTS.narrowBreakpoint, 820);
  assert.equal(DEFAULTS.navHoverDelay, 500);

  assert.throws(
    () => harness.window.homePanels.create({ root: harness.el.root }),
    /nav|leftPanel/
  );
  assert.throws(() => harness.window.homePanels.create(), /配置对象/);
});

test("初始化：宽屏左侧历史默认展开、右侧文件默认收起，变量 / data / ARIA 完整", () => {
  const harness = createHarness({ width: 1440 });
  const { root, leftPanel, rightPanel, leftHandle, rightHandle, leftButton, rightButton, nav } =
    harness.el;

  const state = harness.controller.getState();
  assert.equal(state.active, true);
  assert.equal(state.layout, "wide");
  assert.equal(state.left.open, true);
  assert.equal(state.left.width, 264);
  assert.equal(state.right.open, false);
  assert.equal(state.conversationWidth, 1176);
  assert.equal(state.minConversationWidth, 440);

  assert.equal(cssVar(harness, "--home-left-width"), "264px");
  assert.equal(cssVar(harness, "--home-right-width"), "0px");
  assert.equal(cssVar(harness, "--home-conversation-width"), "1176px");
  assert.equal(cssVar(harness, "--home-conversation-min-width"), "440px");

  assert.equal(root.getAttribute("data-home-layout"), "wide");
  assert.equal(root.getAttribute("data-home-left"), "open");
  assert.equal(root.getAttribute("data-home-right"), "closed");
  assert.equal(root.getAttribute("data-home-nav"), "closed");
  assert.equal(root.getAttribute("data-home-dragging"), null);
  assert.equal(nav.getAttribute("data-home-nav"), "closed");

  assert.equal(leftPanel.getAttribute("data-home-state"), "open");
  assert.equal(leftPanel.getAttribute("aria-hidden"), null);
  assert.equal(leftPanel.hasAttribute("inert"), false);
  assert.equal(rightPanel.getAttribute("data-home-state"), "closed");
  assert.equal(rightPanel.getAttribute("aria-hidden"), "true");
  assert.equal(rightPanel.hasAttribute("inert"), true);

  assert.equal(leftHandle.getAttribute("role"), "separator");
  assert.equal(leftHandle.getAttribute("aria-orientation"), "vertical");
  assert.equal(leftHandle.getAttribute("tabindex"), "0");
  assert.equal(leftHandle.getAttribute("aria-hidden"), null);
  assert.equal(leftHandle.hasAttribute("inert"), false);
  assert.equal(leftHandle.getAttribute("aria-valuenow"), "264");
  assert.equal(leftHandle.getAttribute("aria-valuemin"), "196");
  assert.match(leftHandle.getAttribute("aria-valuetext"), /宽度 264 像素/);
  assert.equal(leftHandle.getAttribute("aria-valuemax"), "420");

  assert.equal(rightHandle.getAttribute("role"), "separator");
  assert.equal(rightHandle.getAttribute("aria-orientation"), "vertical");
  assert.equal(rightHandle.getAttribute("tabindex"), "-1");
  assert.equal(rightHandle.getAttribute("aria-hidden"), "true");
  assert.equal(rightHandle.hasAttribute("inert"), true);
  assert.equal(rightHandle.getAttribute("aria-valuenow"), "0");
  assert.match(rightHandle.getAttribute("aria-valuetext"), /已收起/);
  assert.equal(rightHandle.getAttribute("aria-valuemax"), "480");

  assert.equal(leftButton.getAttribute("aria-expanded"), "true");
  assert.equal(rightButton.getAttribute("aria-expanded"), "false");
  assert.equal(leftButton.getAttribute("data-home-toggle"), "left");
  assert.equal(rightButton.getAttribute("data-home-toggle"), "right");
  assert.equal(leftButton.getAttribute("aria-controls"), "home-left-panel");
  assert.equal(rightButton.getAttribute("aria-controls"), "home-right-panel");
});

test("初始化选项：leftOpen / rightOpen、窄屏不自动开抽屉、navWidth 占宽", () => {
  const closed = createHarness({ options: { leftOpen: false } });
  assert.equal(closed.controller.getState().left.open, false);
  assert.equal(cssVar(closed, "--home-left-width"), "0px");
  assert.equal(cssVar(closed, "--home-conversation-width"), "1440px");

  const both = createHarness({ options: { rightOpen: true } });
  assert.equal(both.controller.getState().left.open, true);
  assert.equal(both.controller.getState().left.width, 264);
  assert.equal(both.controller.getState().right.open, true);
  assert.equal(both.controller.getState().right.width, 320);
  assert.equal(cssVar(both, "--home-conversation-width"), "856px");

  const narrow = createHarness({
    width: 800,
    options: { leftOpen: true, rightOpen: true },
  });
  assert.equal(narrow.controller.getState().layout, "narrow");
  assert.equal(narrow.controller.getState().left.open, false);
  assert.equal(narrow.controller.getState().right.open, false);

  const navOffset = createHarness({
    width: 1440,
    options: { navWidth: 80, leftOpen: false },
  });
  assert.equal(navOffset.controller.getState().availableWidth, 1360);
  assert.equal(navOffset.controller.getState().conversationWidth, 1360);
  fire(navOffset.el.leftButton, "click", {});
  assert.equal(cssVar(navOffset, "--home-conversation-width"), "1096px");

  // 可替换断点与最小对话宽度。
  const customNarrow = createHarness({
    width: 880,
    options: { narrowBreakpoint: 900, leftOpen: false },
  });
  assert.equal(customNarrow.controller.getState().layout, "narrow");

  const customWide = createHarness({
    width: 1000,
    options: { minConversationWidth: 500, leftOpen: false },
  });
  fire(customWide.el.leftButton, "click", {});
  fire(customWide.el.rightButton, "click", {});
  assert.equal(customWide.controller.getState().left.width, 264);
  assert.equal(customWide.controller.getState().right.width, 236);
  assert.equal(customWide.controller.getState().conversationWidth, 500);
});

test("导航：停留 500ms 展开，离开收回，键盘 / 触屏不误开，宽度不变", () => {
  const harness = createHarness();
  const { nav, root } = harness.el;
  const beforeLeft = cssVar(harness, "--home-left-width");
  const beforeRight = cssVar(harness, "--home-right-width");
  const beforeConversation = cssVar(harness, "--home-conversation-width");

  fire(nav, "pointerenter", { pointerType: "mouse" });
  harness.clock.advance(499);
  assert.equal(root.getAttribute("data-home-nav"), "closed");
  harness.clock.advance(1);
  assert.equal(root.getAttribute("data-home-nav"), "open");
  assert.equal(nav.getAttribute("data-home-nav"), "open");
  // 浮层不得挤动对话：面板与对话宽度保持原样。
  assert.equal(cssVar(harness, "--home-left-width"), beforeLeft);
  assert.equal(cssVar(harness, "--home-right-width"), beforeRight);
  assert.equal(cssVar(harness, "--home-conversation-width"), beforeConversation);

  fire(nav, "pointerleave", { pointerType: "mouse" });
  assert.equal(root.getAttribute("data-home-nav"), "closed");

  // 不足 500ms 离开：保持收起，且不留定时器。
  fire(nav, "pointerenter", { pointerType: "mouse" });
  harness.clock.advance(200);
  fire(nav, "pointerleave", { pointerType: "mouse" });
  harness.clock.advance(500);
  assert.equal(root.getAttribute("data-home-nav"), "closed");
  assert.equal(harness.clock.pending(), 0);

  // 触屏指针不触发 hover 计时。
  fire(nav, "pointerenter", { pointerType: "touch" });
  harness.clock.advance(600);
  assert.equal(root.getAttribute("data-home-nav"), "closed");
  assert.equal(harness.clock.pending(), 0);
  fire(nav, "click", { pointerType: "touch" });
  assert.equal(root.getAttribute("data-home-nav"), "closed");

  // 键盘焦点立即展开，移出后收回。
  fire(nav, "focusin", { relatedTarget: null });
  assert.equal(root.getAttribute("data-home-nav"), "open");
  assert.equal(harness.clock.pending(), 0);
  fire(nav, "focusout", { relatedTarget: null });
  assert.equal(root.getAttribute("data-home-nav"), "closed");

  // 焦点在导航内部移动不收起。
  fire(nav, "focusin", { relatedTarget: null });
  fire(nav, "focusout", { relatedTarget: nav });
  assert.equal(root.getAttribute("data-home-nav"), "open");
});

test("按钮：独立收展、ARIA、焦点与草稿保留", () => {
  const harness = createHarness();
  const { root, leftButton, rightButton, leftHandle, leftPanel, rightPanel, composer, draft } =
    harness.el;

  composer.focus();
  composer.selectionStart = 2;
  composer.selectionEnd = 5;

  // 左侧历史默认展开；按钮先收起。
  assert.equal(leftButton.getAttribute("aria-expanded"), "true");
  fire(leftButton, "click", {});
  assert.equal(leftButton.getAttribute("aria-expanded"), "false");
  assert.equal(root.getAttribute("data-home-left"), "closed");
  assert.equal(leftPanel.getAttribute("data-home-state"), "closed");
  assert.equal(leftPanel.hasAttribute("inert"), true);
  assert.equal(leftPanel.getAttribute("aria-hidden"), "true");
  assert.equal(leftHandle.getAttribute("tabindex"), "-1");
  assert.equal(leftHandle.hasAttribute("inert"), true);
  assert.equal(cssVar(harness, "--home-left-width"), "0px");
  assert.equal(cssVar(harness, "--home-conversation-width"), "1440px");
  assert.equal(harness.document.activeElement, composer);
  assert.equal(composer.value, "公式草稿 ∫x");
  assert.equal(composer.selectionStart, 2);
  assert.equal(composer.selectionEnd, 5);

  // 同一按钮恢复展开：节点未重建，输入区焦点不受影响。
  fire(leftButton, "click", {});
  assert.equal(leftButton.getAttribute("aria-expanded"), "true");
  assert.equal(root.getAttribute("data-home-left"), "open");
  assert.equal(leftPanel.getAttribute("data-home-state"), "open");
  assert.equal(leftPanel.hasAttribute("inert"), false);
  assert.equal(leftPanel.getAttribute("aria-hidden"), null);
  assert.equal(leftHandle.getAttribute("tabindex"), "0");
  assert.equal(leftHandle.hasAttribute("inert"), false);
  assert.equal(leftHandle.getAttribute("aria-valuenow"), "264");
  assert.equal(cssVar(harness, "--home-left-width"), "264px");
  assert.equal(cssVar(harness, "--home-conversation-width"), "1176px");
  assert.equal(harness.document.activeElement, composer);
  assert.equal(composer.value, "公式草稿 ∫x");
  assert.equal(composer.selectionStart, 2);
  assert.equal(composer.selectionEnd, 5);

  fire(rightButton, "click", {});
  assert.equal(rightButton.getAttribute("aria-expanded"), "true");
  assert.equal(rightPanel.getAttribute("data-home-state"), "open");
  assert.equal(cssVar(harness, "--home-conversation-width"), "856px");
  assert.equal(harness.controller.getState().conversationWidth, 856);
  assert.equal(harness.document.activeElement, composer);

  // 收起左侧时焦点在左面板内：转交给左侧按钮，输入节点与草稿不变。
  draft.focus();
  draft.selectionStart = 3;
  draft.selectionEnd = 6;
  fire(leftButton, "click", {});
  assert.equal(leftButton.getAttribute("aria-expanded"), "false");
  assert.equal(leftHandle.getAttribute("tabindex"), "-1");
  assert.equal(leftHandle.hasAttribute("inert"), true);
  assert.equal(harness.document.activeElement, leftButton);
  assert.equal(draft.value, "面板内的草稿");
  assert.equal(draft.selectionStart, 3);
  assert.equal(draft.selectionEnd, 6);

  // 再次展开不重建节点，草稿与选区仍在。
  fire(leftButton, "click", {});
  assert.equal(harness.el.draft, draft);
  assert.equal(draft.parentNode, leftPanel);
  assert.equal(draft.value, "面板内的草稿");
  assert.equal(draft.selectionStart, 3);
  assert.equal(draft.selectionEnd, 6);

  // 切换聊天语义：只收起文件面板。
  assert.equal(harness.controller.collapseFiles(), true);
  assert.equal(root.getAttribute("data-home-right"), "closed");
  assert.equal(leftButton.getAttribute("aria-expanded"), "true");
  assert.equal(harness.controller.collapseFiles(), false);
});

test("左手柄：向右拉宽受最小对话宽度限制，向左锁在下限，越过交界线才收起", () => {
  const harness = createHarness();
  const { root, leftHandle, leftButton } = harness.el;
  assert.equal(harness.controller.getState().left.width, 264);
  assert.equal(harness.controller.getState().left.minWidth, 196);

  leftHandle.focus();
  assert.equal(harness.document.activeElement, leftHandle);

  // 手柄在 72 + 264 = 336；真实抓取点常落在手柄线左侧几像素（命中区左右各外扩 5px）。
  fire(leftHandle, "pointerdown", { clientX: 331, button: 0, pointerId: 1 });
  assert.equal(root.getAttribute("data-home-dragging"), "left");
  assert.equal(harness.controller.getState().dragging, "left");

  fire(leftHandle, "pointermove", { clientX: 431, pointerId: 1 });
  assert.equal(cssVar(harness, "--home-left-width"), "364px");
  assert.equal(leftHandle.getAttribute("aria-valuenow"), "364");

  fire(leftHandle, "pointermove", { clientX: 600, pointerId: 1 });
  assert.equal(cssVar(harness, "--home-left-width"), "420px");
  assert.equal(harness.controller.getState().conversationWidth, 1020);

  // 向左拖：宽度先降到可呈现下限 196px 并锁在那里，不会中途吸附收起。
  fire(leftHandle, "pointermove", { clientX: 200, pointerId: 1 });
  assert.equal(cssVar(harness, "--home-left-width"), "196px");
  assert.equal(root.getAttribute("data-home-left"), "open");
  assert.equal(leftButton.getAttribute("aria-expanded"), "true");

  // 指针继续向左、但还没到 72px 分界线：宽度仍是 196，界面稳定。
  fire(leftHandle, "pointermove", { clientX: 74, pointerId: 1 });
  assert.equal(cssVar(harness, "--home-left-width"), "196px");
  assert.equal(root.getAttribute("data-home-left"), "open");

  // 在下限与分界线之间松手：保持稳态，不归零。
  fire(leftHandle, "pointerup", { pointerId: 1 });
  assert.equal(cssVar(harness, "--home-left-width"), "196px");
  assert.equal(root.getAttribute("data-home-left"), "open");
  assert.equal(harness.controller.getState().left.preferredWidth, 196);
  assert.equal(harness.controller.getState().left.width, 196);

  // 第二次拖动：抓取点落在手柄线右侧 5px（273 = 72 + 196 + 5），仍先锁在下限。
  fire(leftHandle, "pointerdown", { clientX: 273, button: 0, pointerId: 2 });
  fire(leftHandle, "pointermove", { clientX: 110, pointerId: 2 });
  assert.equal(cssVar(harness, "--home-left-width"), "196px");
  fire(leftHandle, "pointerup", { pointerId: 2 });
  assert.equal(cssVar(harness, "--home-left-width"), "196px");
  assert.equal(root.getAttribute("data-home-left"), "open");

  // 真正触达 72px（导航栏 / 历史栏分界线）：瞬间整栏收起并退出焦点。
  fire(leftHandle, "pointerdown", { clientX: 268, button: 0, pointerId: 3 });
  fire(leftHandle, "pointermove", { clientX: 73, pointerId: 3 });
  assert.equal(root.getAttribute("data-home-left"), "open");
  assert.equal(cssVar(harness, "--home-left-width"), "196px");
  fire(leftHandle, "pointermove", { clientX: 72, pointerId: 3 });
  assert.equal(root.getAttribute("data-home-left"), "closed");
  assert.equal(cssVar(harness, "--home-left-width"), "0px");
  assert.equal(root.getAttribute("data-home-dragging"), null);
  assert.equal(harness.controller.getState().dragging, null);
  assert.equal(leftHandle.getAttribute("tabindex"), "-1");
  assert.equal(leftHandle.hasAttribute("inert"), true);
  assert.equal(leftButton.getAttribute("aria-expanded"), "false");
  assert.equal(harness.document.activeElement, leftButton);

  // 吸附后同一指针继续移动不应再改动。
  fire(leftHandle, "pointermove", { clientX: 300, pointerId: 3 });
  fire(leftHandle, "pointerup", { pointerId: 3 });
  assert.equal(cssVar(harness, "--home-left-width"), "0px");

  // 再次点开回到首选宽度（上一次停在 196）。
  fire(leftButton, "click", {});
  assert.equal(cssVar(harness, "--home-left-width"), "196px");
});

test("左栏键盘调整：方向键最多减到可呈现下限，Home 才完全收起", () => {
  const harness = createHarness();
  const { root, leftHandle, leftButton } = harness.el;
  leftHandle.focus();
  for (let i = 0; i < 20; i += 1) {
    fire(leftHandle, "keydown", { key: "ArrowLeft" });
  }
  assert.equal(cssVar(harness, "--home-left-width"), "196px");
  assert.equal(root.getAttribute("data-home-left"), "open");
  assert.equal(leftButton.getAttribute("aria-expanded"), "true");

  fire(leftHandle, "keydown", { key: "Home" });
  assert.equal(root.getAttribute("data-home-left"), "closed");
  assert.equal(cssVar(harness, "--home-left-width"), "0px");
  assert.equal(harness.document.activeElement, leftButton);
});

test("左栏下限与 .home-history-inner 的真实内部尺寸对齐，不靠外层裁切", () => {
  const css = fs.readFileSync(
    path.join(__dirname, "..", "static", "home-layout.css"),
    "utf8"
  );
  const rule = /\.home-history-inner\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, "应能找到 .home-history-inner 规则");
  const minWidth = /min-width:\s*(\d+)px/.exec(rule[1]);
  assert.ok(minWidth, "内部布局必须有明确的最小宽度");
  const inner = Number(minWidth[1]);

  const harness = createHarness();
  const { minLeftWidth } = harness.window.homePanels.DEFAULTS;
  assert.ok(minLeftWidth >= 184 && minLeftWidth <= 200, `下限应在 184–200px：${minLeftWidth}`);
  // 面板宽度要容得下 1px 边框 + 内部最小宽度，否则下限处会被裁掉。
  assert.ok(
    minLeftWidth >= inner + 1,
    `左栏下限 ${minLeftWidth}px 必须能容下内部 ${inner}px + 边框`
  );
});


test("右手柄：向左拉宽，向右拖到外缘完全收起", () => {
  const harness = createHarness();
  const { root, rightHandle, rightButton } = harness.el;
  fire(rightButton, "click", {});
  assert.equal(cssVar(harness, "--home-right-width"), "320px");

  rightHandle.focus();
  fire(rightHandle, "pointerdown", { clientX: 700, button: 0, pointerId: 2 });
  fire(rightHandle, "pointermove", { clientX: 600, pointerId: 2 });
  assert.equal(cssVar(harness, "--home-right-width"), "420px");
  fire(rightHandle, "pointermove", { clientX: 0, pointerId: 2 });
  assert.equal(cssVar(harness, "--home-right-width"), "480px");
  assert.equal(harness.controller.getState().conversationWidth, 696);

  fire(rightHandle, "pointermove", { clientX: 1000, pointerId: 2 });
  assert.equal(root.getAttribute("data-home-right"), "closed");
  assert.equal(root.getAttribute("data-home-dragging"), null);
  assert.equal(rightHandle.getAttribute("tabindex"), "-1");
  assert.equal(rightButton.getAttribute("aria-expanded"), "false");
  assert.equal(harness.document.activeElement, rightButton);
});

test("最小对话宽度：打开与拖动都在 440px 处停住", () => {
  const harness = createHarness({ width: 900 });
  const { rightButton, rightHandle } = harness.el;

  fire(rightButton, "click", {});
  const state = harness.controller.getState();
  assert.equal(state.left.width, 264);
  assert.equal(state.right.width, 196);
  assert.equal(state.conversationWidth, 440);
  assert.equal(rightHandle.getAttribute("aria-valuemax"), "196");

  // 继续把右手柄往左拉（拉宽）也只能到 196。
  fire(rightHandle, "pointerdown", { clientX: 400, button: 0, pointerId: 3 });
  fire(rightHandle, "pointermove", { clientX: -600, pointerId: 3 });
  assert.equal(cssVar(harness, "--home-right-width"), "196px");
  assert.equal(harness.controller.getState().conversationWidth, 440);
  fire(rightHandle, "pointerup", { pointerId: 3 });

  // 只开左侧时最多 420；此时右侧已无处可开。
  harness.controller.collapseFiles();
  const leftHandle = harness.el.leftHandle;
  fire(leftHandle, "focus", {});
  fire(leftHandle, "keydown", { key: "End" });
  assert.equal(cssVar(harness, "--home-left-width"), "420px");
  assert.equal(harness.controller.getState().conversationWidth, 480);
  fire(rightButton, "click", {});
  assert.equal(harness.controller.getState().right.open, false);
  assert.equal(harness.el.root.getAttribute("data-home-right"), "closed");
  assert.equal(rightButton.getAttribute("aria-expanded"), "false");
});

test("键盘：方向键按分隔线方向调整，Home 收起，End 展到上限", () => {
  const harness = createHarness();
  const { leftButton, rightButton, leftHandle, rightHandle } = harness.el;

  leftHandle.focus();
  fire(leftHandle, "keydown", { key: "ArrowRight" });
  assert.equal(cssVar(harness, "--home-left-width"), "280px");
  fire(leftHandle, "keydown", { key: "ArrowRight", shiftKey: true });
  assert.equal(cssVar(harness, "--home-left-width"), "344px");
  fire(leftHandle, "keydown", { key: "ArrowLeft" });
  assert.equal(cssVar(harness, "--home-left-width"), "328px");
  fire(leftHandle, "keydown", { key: "End" });
  assert.equal(cssVar(harness, "--home-left-width"), "420px");
  fire(leftHandle, "keydown", { key: "Home" });
  assert.equal(harness.el.root.getAttribute("data-home-left"), "closed");
  assert.equal(harness.document.activeElement, leftButton);

  fire(rightButton, "click", {});
  rightHandle.focus();
  fire(rightHandle, "keydown", { key: "ArrowLeft" });
  assert.equal(cssVar(harness, "--home-right-width"), "336px");
  fire(rightHandle, "keydown", { key: "ArrowRight" });
  assert.equal(cssVar(harness, "--home-right-width"), "320px");
  fire(rightHandle, "keydown", { key: "End" });
  assert.equal(cssVar(harness, "--home-right-width"), "480px");
  fire(rightHandle, "keydown", { key: "Home" });
  assert.equal(harness.el.root.getAttribute("data-home-right"), "closed");
  assert.equal(harness.document.activeElement, rightButton);

  // 收起状态下的按键无效。
  fire(leftHandle, "keydown", { key: "ArrowRight" });
  assert.equal(cssVar(harness, "--home-left-width"), "0px");
});

test("取消 / Escape / 多次拖动 / 错误指针 ID 后状态干净", () => {
  const harness = createHarness();
  const { root, leftHandle, leftButton, rightHandle } = harness.el;

  fire(leftHandle, "pointerdown", { clientX: 264, button: 0, pointerId: 4 });
  fire(leftHandle, "pointermove", { clientX: 300, pointerId: 4 });
  assert.equal(cssVar(harness, "--home-left-width"), "300px");
  fire(leftHandle, "pointercancel", { pointerId: 4 });
  assert.equal(cssVar(harness, "--home-left-width"), "264px");
  assert.equal(root.getAttribute("data-home-dragging"), null);

  fire(leftHandle, "pointerdown", { clientX: 264, button: 0, pointerId: 5 });
  fire(leftHandle, "pointermove", { clientX: 350, pointerId: 5 });
  assert.equal(cssVar(harness, "--home-left-width"), "350px");
  fire(harness.document, "keydown", { key: "Escape" });
  assert.equal(cssVar(harness, "--home-left-width"), "264px");
  assert.equal(root.getAttribute("data-home-dragging"), null);

  // 两次连续拖动都提交，最后一次宽度成为下次展开的首选。
  fire(leftHandle, "pointerdown", { clientX: 264, button: 0, pointerId: 6 });
  fire(leftHandle, "pointermove", { clientX: 380, pointerId: 6 });
  fire(leftHandle, "pointerup", { pointerId: 6 });
  assert.equal(cssVar(harness, "--home-left-width"), "380px");
  fire(leftHandle, "pointerdown", { clientX: 380, button: 0, pointerId: 7 });
  fire(leftHandle, "pointermove", { clientX: 330, pointerId: 7 });
  fire(leftHandle, "pointerup", { pointerId: 7 });
  assert.equal(cssVar(harness, "--home-left-width"), "330px");
  assert.equal(harness.controller.getState().left.preferredWidth, 330);

  // 拖动中按另一条分隔线不抢占；不匹配的 pointerup 不结束拖动。
  fire(leftHandle, "pointerdown", { clientX: 330, button: 0, pointerId: 8 });
  fire(rightHandle, "pointerdown", { clientX: 900, button: 0, pointerId: 9 });
  assert.equal(root.getAttribute("data-home-dragging"), "left");
  fire(harness.document, "pointerup", { pointerId: 9 });
  assert.equal(root.getAttribute("data-home-dragging"), "left");
  fire(harness.document, "pointerup", { pointerId: 8 });
  assert.equal(root.getAttribute("data-home-dragging"), null);
  assert.equal(cssVar(harness, "--home-left-width"), "330px");

  fire(leftButton, "click", {});
  fire(leftButton, "click", {});
  assert.equal(cssVar(harness, "--home-left-width"), "330px");
});

test("容器不可见（零宽）时不收起用户打开的面板，恢复可见后重新计算", () => {
  const harness = createHarness({ width: 1440 });
  const { root } = harness.el;
  assert.equal(harness.controller.getState().left.open, true);
  assert.equal(harness.controller.getState().left.width, 264);

  // 切到资料页后主页 view 被 hidden：ResizeObserver 量到 0 宽，但不能因此收起面板。
  root._clientWidth = 0;
  fire(harness.window, "resize", {});
  let state = harness.controller.getState();
  assert.equal(state.left.open, true, "零宽测量不应改变用户手动打开的左侧面板");
  assert.equal(state.left.width, 264);
  assert.equal(cssVar(harness, "--home-left-width"), "264px");

  // 回到主页：宽度恢复后按预算重算，仍然保持原来的打开状态。
  root._clientWidth = 1440;
  harness.controller.refresh();
  state = harness.controller.getState();
  assert.equal(state.left.open, true);
  assert.equal(state.left.width, 264);
  assert.equal(cssVar(harness, "--home-left-width"), "264px");

  // 用户主动收起的状态也不能被零宽测量“修正”成打开。
  fire(harness.el.leftButton, "click", {});
  assert.equal(harness.controller.getState().left.open, false);
  root._clientWidth = 0;
  fire(harness.window, "resize", {});
  root._clientWidth = 1440;
  harness.controller.refresh();
  assert.equal(harness.controller.getState().left.open, false, "主动收起的状态要保留");
});

test("窗口回缩、窄屏抽屉、切换后状态干净", () => {
  const harness = createHarness({ width: 1440 });
  const { root, leftButton, rightButton, leftHandle, leftPanel, rightPanel } = harness.el;

  fire(rightButton, "click", {});
  harness.resize(900);
  let state = harness.controller.getState();
  assert.equal(state.layout, "wide");
  assert.equal(state.left.width, 207);
  assert.equal(state.right.width, 252);
  assert.ok(state.conversationWidth >= 440);
  assert.equal(cssVar(harness, "--home-conversation-width"), "441px");

  // 进入窄屏：两侧面板收起，分隔线不可操作。
  harness.resize(800);
  state = harness.controller.getState();
  assert.equal(state.layout, "narrow");
  assert.equal(state.left.open, false);
  assert.equal(state.right.open, false);
  assert.equal(cssVar(harness, "--home-left-width"), "0px");
  assert.equal(cssVar(harness, "--home-right-width"), "0px");
  assert.equal(leftHandle.getAttribute("tabindex"), "-1");
  assert.equal(leftHandle.hasAttribute("inert"), true);

  // 窄屏只用按钮开关覆盖抽屉，两侧可同时打开。
  fire(leftButton, "click", {});
  fire(rightButton, "click", {});
  assert.equal(leftPanel.getAttribute("data-home-state"), "open");
  assert.equal(rightPanel.getAttribute("data-home-state"), "open");
  assert.equal(leftPanel.hasAttribute("inert"), false);
  assert.equal(rightPanel.hasAttribute("inert"), false);
  assert.equal(leftButton.getAttribute("aria-expanded"), "true");
  assert.equal(rightButton.getAttribute("aria-expanded"), "true");
  assert.equal(leftHandle.hasAttribute("inert"), true);

  // 切换聊天只关右侧抽屉。
  assert.equal(harness.controller.collapseFiles(), true);
  assert.equal(rightPanel.getAttribute("data-home-state"), "closed");
  assert.equal(leftPanel.getAttribute("data-home-state"), "open");

  // 回到宽屏：抽屉不残留成桌面面板。
  harness.resize(1200);
  state = harness.controller.getState();
  assert.equal(state.layout, "wide");
  assert.equal(state.left.open, false);
  assert.equal(state.right.open, false);
  assert.equal(cssVar(harness, "--home-left-width"), "0px");

  // 拖动中进入窄屏：拖动取消，状态干净。
  fire(leftButton, "click", {});
  fire(leftHandle, "pointerdown", { clientX: 264, button: 0, pointerId: 10 });
  fire(leftHandle, "pointermove", { clientX: 350, pointerId: 10 });
  assert.equal(cssVar(harness, "--home-left-width"), "350px");
  harness.resize(800);
  assert.equal(root.getAttribute("data-home-dragging"), null);
  assert.equal(root.getAttribute("data-home-left"), "closed");
  assert.equal(harness.controller.getState().dragging, null);
  assert.equal(cssVar(harness, "--home-left-width"), "0px");
});

test("destroy：移除监听与定时器并还原属性，可重新初始化", () => {
  const harness = createHarness();
  const { root, nav, leftPanel, rightPanel, leftHandle, rightHandle, leftButton, rightButton } =
    harness.el;

  const rootChildren = root.childNodes.slice();
  const leftChildren = leftPanel.childNodes.slice();

  fire(rightButton, "click", {});
  fire(nav, "pointerenter", { pointerType: "mouse" });
  harness.clock.advance(100);
  assert.equal(harness.clock.pending(), 1);

  harness.controller.destroy();
  assert.equal(harness.clock.pending(), 0);
  assert.equal(root.getAttribute("data-home-layout"), null);
  assert.equal(root.getAttribute("data-home-left"), null);
  assert.equal(root.getAttribute("data-home-right"), null);
  assert.equal(root.getAttribute("data-home-nav"), null);
  assert.equal(root.getAttribute("data-home-dragging"), null);
  assert.equal(cssVar(harness, "--home-left-width"), "");
  assert.equal(cssVar(harness, "--home-conversation-width"), "");
  assert.equal(nav.getAttribute("data-home-nav"), null);

  for (const panel of [leftPanel, rightPanel]) {
    assert.equal(panel.getAttribute("data-home-state"), null);
    assert.equal(panel.getAttribute("aria-hidden"), null);
    assert.equal(panel.hasAttribute("inert"), false);
  }
  for (const handle of [leftHandle, rightHandle]) {
    assert.equal(handle.getAttribute("role"), null);
    assert.equal(handle.getAttribute("tabindex"), null);
    assert.equal(handle.getAttribute("aria-hidden"), null);
    assert.equal(handle.getAttribute("aria-valuenow"), null);
    assert.equal(handle.hasAttribute("inert"), false);
  }
  assert.equal(leftButton.getAttribute("aria-expanded"), null);
  assert.equal(leftButton.getAttribute("aria-controls"), null);
  assert.equal(rightButton.getAttribute("data-home-toggle"), null);

  // 销毁后方法变安全空操作；resize 不再改属性。
  assert.equal(harness.controller.collapseFiles(), false);
  assert.equal(harness.controller.getState().active, false);
  harness.resize(1000);
  assert.equal(root.getAttribute("data-home-layout"), null);
  assert.equal(cssVar(harness, "--home-left-width"), "");

  // DOM 结构从未被移动或克隆。
  assert.deepEqual(root.childNodes, rootChildren);
  assert.deepEqual(leftPanel.childNodes, leftChildren);

  // 同一 DOM 可以干净地重新初始化。
  const again = harness.window.homePanels.create({
    root,
    nav,
    leftPanel,
    rightPanel,
    leftHandle,
    rightHandle,
    leftButton,
    rightButton,
  });
  assert.equal(again.getState().layout, "wide");
  assert.equal(again.getState().left.open, true);
  assert.equal(root.getAttribute("data-home-layout"), "wide");
  assert.equal(cssVar(harness, "--home-left-width"), "264px");
  again.destroy();
  assert.equal(root.getAttribute("data-home-layout"), null);
});
