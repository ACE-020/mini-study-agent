"use strict";
// 直接测试 static/home-ui.js 的数据接线：node tests/test_home_ui.js
//
// 用最小 DOM / 事件 / 定时器桩加载切片源码，覆盖本轮真实接线的关键点：
//   1) 对话模型只绑定 #source-panel 里可见的 select（隐藏的 follow 表单里有同标识 select）；
//   2) 集合与“所在集合”下拉来自 /api/conversations 的集合数据，移动调用既有接口；
//   3) 本对话文件按对话加载，图片用缩略图、文档有类型标签与真实预览地址；
//   4) 切换对话时异步旧响应不会覆盖新对话的附件；
//   5) 统一入口的资料入库返回约定会创建 / 读回批次，并在可核对时打开原有核对面板。
// 真实浏览器布局、缩略图加载与资料核对流程仍由 Codex 用 Chrome 复测。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "static", "home-ui.js"),
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
      timers.set(id, { id, at: now + Math.max(0, Number(delay) || 0), handler });
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
          if (!next || timer.at < next.at || (timer.at === next.at && timer.id < next.id)) {
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
      stopImmediatePropagation() {
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

class FakeCustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
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
    handlers.push(handler);
  }

  removeEventListener(type, handler) {
    const handlers = this._listeners.get(type);
    if (!handlers) return;
    const index = handlers.indexOf(handler);
    if (index >= 0) handlers.splice(index, 1);
  }

  dispatchEvent(event) {
    fire(this, event.type, { detail: event.detail });
    return true;
  }
}

class FakeElement extends FakeEventTarget {
  constructor(ownerDocument, tagName) {
    super();
    this.ownerDocument = ownerDocument;
    this.tagName = String(tagName).toUpperCase();
    this.id = "";
    this.className = "";
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.type = "";
    this.title = "";
    this.href = "";
    this.src = "";
    this.alt = "";
    this.target = "";
    this.rel = "";
    this.loading = "";
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.childNodes = [];
    this.dataset = {};
    this._text = "";
    this._attrs = new Map();
  }

  get textContent() {
    if (this._text) return this._text;
    return this.childNodes.map((node) => node.textContent || "").join("");
  }

  set textContent(value) {
    this._text = String(value);
    this.childNodes = [];
  }

  setAttribute(name, value) {
    this._attrs.set(name, String(value));
    if (name === "id") this.id = String(value);
    if (name === "hidden") this.hidden = true;
  }

  getAttribute(name) {
    if (name === "hidden") return this.hidden ? "" : null;
    return this._attrs.has(name) ? this._attrs.get(name) : null;
  }

  hasAttribute(name) {
    if (name === "hidden") return this.hidden;
    return this._attrs.has(name);
  }

  removeAttribute(name) {
    this._attrs.delete(name);
    if (name === "hidden") this.hidden = false;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (typeof node === "string") {
        const text = new FakeElement(this.ownerDocument, "#text");
        text._text = node;
        this.childNodes.push(text);
        continue;
      }
      if (node.parentNode) {
        const siblings = node.parentNode.childNodes;
        const index = siblings.indexOf(node);
        if (index >= 0) siblings.splice(index, 1);
      }
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }

  replaceChildren(...nodes) {
    this.childNodes = [];
    this._text = "";
    this.append(...nodes);
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches && node.matches(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  matches(selector) {
    if (selector.startsWith(".")) return this.className.split(/\s+/).includes(selector.slice(1));
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    const attribute = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attribute) {
      const value = this.dataset[attribute[1].replace(/^data-/, "").replace(/-([a-z])/g, (m, c) => c.toUpperCase())];
      if (value === undefined) return false;
      return attribute[2] === undefined || String(value) === attribute[2];
    }
    return false;
  }

  get options() {
    return this.childNodes.filter((node) => node.tagName === "OPTION");
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  querySelectorAll(selector) {
    return this.ownerDocument._walk(this).filter((node) => node !== this && node.matches(selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

class FakeDocument extends FakeEventTarget {
  constructor() {
    super();
    this.readyState = "complete";
    this.defaultView = null;
    this.documentElement = new FakeElement(this, "html");
    this.body = new FakeElement(this, "body");
    this.documentElement.append(this.body);
    this.activeElement = this.body;
  }

  createElement(tagName) {
    return new FakeElement(this, tagName);
  }

  querySelectorAll(selector) {
    const selectors = selector.split(",").map((item) => item.trim());
    return this._walk().filter((node) => selectors.some((item) => node.matches(item)));
  }

  querySelector(selector) {
    const parts = selector.split(/\s+/).map((item) => item.trim()).filter(Boolean);
    if (parts.length === 2) {
      const scope = this.querySelector(parts[0]);
      if (!scope) return null;
      return this._walk(scope).find((node) => node !== scope && node.matches(parts[1])) || null;
    }
    const matches = this._walk().filter((node) => node.matches(parts[0]));
    return matches[0] || null;
  }

  _walk(root = this.documentElement) {
    const nodes = [];
    const visit = (node) => {
      for (const child of node.childNodes || []) {
        nodes.push(child);
        visit(child);
      }
    };
    visit(root);
    return nodes;
  }
}

// ---------------- 测试环境 ----------------

function createHarness({ collections = [], activeId = "conv-a", conversations = [], apiHandler, receipts = {} } = {}) {
  const clock = createClock();
  const document = new FakeDocument();
  const window = new FakeEventTarget();
  window.document = document;
  window.setTimeout = clock.setTimeout;
  window.clearTimeout = clock.clearTimeout;
  window.prompt = () => "导数组";
  const storage = new Map(Object.entries(receipts));
  window.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  document.defaultView = window;

  const el = (tag, id) => {
    const node = document.createElement(tag);
    if (id) node.id = id;
    return node;
  };

  const root = el("div", "organize-workspace");
  const nav = el("nav", "home-nav");
  const leftPanel = el("aside", "home-history-panel");
  const rightPanel = el("aside", "home-files-panel");
  const leftHandle = el("div", "home-left-handle");
  const rightHandle = el("div", "home-right-handle");
  const leftButton = el("button", "home-left-toggle");
  const rightButton = el("button", "home-right-toggle");
  const messages = el("div", "organize-messages");
  const draft = el("textarea", "draft");
  const submit = el("button", "organize-submit");
  const follow = el("textarea", "organize-follow");
  const followForm = el("form", "organize-follow-form");
  const attach = el("button", "home-attach-button");
  const fileInput = el("input", "image-input");
  const filesList = el("div", "home-files-list");
  const filesEmpty = el("p", "home-files-empty");
  const filesSummary = el("p", "home-files-summary");
  const collectionsList = el("div", "home-collections-list");
  const collectionsCount = el("span", "home-collections-count");
  const newCollection = el("button", "home-new-collection");
  const collectionSelect = el("select", "home-collection-select");
  const chatTitle = el("strong", "home-chat-title");
  const chatMeta = el("small", "home-chat-meta");
  const batches = el("div", "home-chat-batches");
  const filesClose = el("button", "home-files-close");
  const historyClose = el("button", "home-history-close");
  const conversationList = el("ul", "conversation-list");
  const newChat = el("button", "new-conversation");
  const restoredHint = el("p", "intake-restored-hint");
  const materialsArea = el("div", "materials-import-area");

  // 隐藏的 follow 表单里先出现同标识的对话模型 select，再是 #source-panel 里真正可见的那个。
  const hiddenSelect = el("select");
  hiddenSelect.dataset.chatModel = "organize";
  const sourcePanel = el("section", "source-panel");
  const visibleSelect = el("select");
  visibleSelect.dataset.chatModel = "organize";
  sourcePanel.append(visibleSelect);
  followForm.append(follow, hiddenSelect);
  const brand = el("a");
  brand.className = "brand home-history-brand";
  const navItem = el("button");
  navItem.className = "nav-item";
  navItem.dataset.view = "organize";

  document.body.append(nav, root, materialsArea, brand, navItem);
  root.append(
    messages,
    batches,
    leftPanel,
    rightPanel,
    leftHandle,
    rightHandle,
    leftButton,
    rightButton,
    sourcePanel
  );
  leftPanel.append(
    chatTitle,
    chatMeta,
    newChat,
    collectionsList,
    collectionsCount,
    newCollection,
    conversationList,
    historyClose,
    draft
  );
  rightPanel.append(filesList, filesEmpty, filesSummary, filesClose);
  follow.append ? null : null;
  document.body.append(followForm, submit, attach, fileInput, collectionSelect, restoredHint);

  const calls = { api: [], move: [], openMaterial: [], views: [], chatModels: [], syncedModels: [] };
  const conversationStore = {
    list: conversations,
    collections,
    collapsedCollections: new Set(),
    activeId,
    available: true,
  };
  const state = { chats: { organize: [{ role: "assistant", text: "已有回答" }] }, chatModel: "model-a" };
  const controllers = {
    api: async (url, options = {}) => {
      calls.api.push({ url, options });
      if (apiHandler) {
        const handled = await apiHandler(url, options, calls);
        if (handled !== undefined) return handled;
      }
      if (url === "/api/conversations") {
        return { ok: true, conversations: conversationStore.list, collections: conversationStore.collections };
      }
      if (url.startsWith("/api/collections")) return { ok: true, collection: { id: "new", name: "导数组" } };
      if (url.includes("/attachments")) return { ok: true, attachments: [] };
      if (url.startsWith("/api/materials/jobs?")) return { ok: true, jobs: [] };
      return { ok: true };
    },
    move: async (id, collectionId) => {
      calls.move.push([id, collectionId]);
      const summary = conversationStore.list.find((item) => item.id === id);
      if (summary) summary.collection_id = collectionId || null;
    },
    openMaterial: (id) => calls.openMaterial.push(id),
    view: (name) => calls.views.push(name),
    chatModel: (select) => calls.chatModels.push(select),
    syncModels: (model) => calls.syncedModels.push(model),
  };

  const controller = {
    getState: () => ({ layout: "wide", left: { open: true }, right: { open: false } }),
    collapseFiles: () => {},
    destroy: () => {},
  };
  window.homePanels = { create: () => controller };

  const context = vm.createContext({
    window,
    document,
    console,
    location: { hash: "" },
    CustomEvent: FakeCustomEvent,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    conversationStore,
    state,
    intake: { queue: [], imageIds: [] },
    activeConversation: () => null,
    api: controllers.api,
    moveConversationToCollection: controllers.move,
    renderConversationList: () => {},
    showView: controllers.view,
    openMaterialJob: controllers.openMaterial,
    notify: () => {},
    refreshConversations: async () => {},
    changeChatModel: controllers.chatModel,
    syncChatModels: controllers.syncModels,
    focusDraftEditor: () => {},
    setMaterialStage: () => {},
  });
  vm.runInContext(SOURCE, context, { filename: "home-ui.js" });
  if (!window.homeUi) {
    const missing = ["#organize-workspace", "#home-nav", "#home-history-panel", "#home-files-panel",
      "#home-left-handle", "#home-right-handle", "#home-left-toggle", "#home-right-toggle",
      "#organize-messages", "#draft", "#organize-submit", "#home-collection-select", "#home-chat-batches"]
      .filter((selector) => !document.querySelector(selector));
    throw new Error(`home-ui 未初始化；缺失节点 ${JSON.stringify(missing)}；homePanels=${typeof window.homePanels}`);
  }

  async function flush(times = 4) {
    for (let index = 0; index < times; index += 1) await new Promise((resolve) => setImmediate(resolve));
  }

  return {
    clock,
    document,
    window,
    context,
    storage,
    conversationStore,
    state,
    calls,
    flush,
    el: {
      root, nav, leftPanel, rightPanel, leftButton, rightButton, messages, draft, submit,
      followForm, hiddenSelect, visibleSelect, sourcePanel, filesList, filesEmpty, filesSummary,
      collectionsList, collectionsCount, newCollection, collectionSelect, chatTitle, chatMeta,
      batches, conversationList, newChat, restoredHint,
    },
  };
}

function cards(harness) {
  return harness.el.filesList.childNodes;
}

// ---------------- 测试 ----------------

test("对话模型只绑定 #source-panel 中可见的 select", () => {
  const harness = createHarness();
  fire(harness.el.hiddenSelect, "change", {});
  assert.equal(harness.calls.chatModels.length, 0, "隐藏的 follow 表单 select 不应被首页绑定");
  fire(harness.el.visibleSelect, "change", {});
  assert.equal(harness.calls.chatModels.length, 1, "可见的对话模型 select 必须响应切换");
  assert.equal(harness.calls.chatModels[0], harness.el.visibleSelect);
});

test("集合只保留一份：列表区不再重复渲染集合，下拉与移动仍走既有接口", async () => {
  const conversations = [
    { id: "conv-a", title: "导数", collection_id: "col-1", message_count: 2, busy: false },
    { id: "conv-b", title: "极限", collection_id: null, message_count: 0, busy: false },
  ];
  const collections = [{ id: "col-1", name: "函数", conversation_count: 1 }];
  const harness = createHarness({ collections, conversations, activeId: "conv-a" });
  await harness.flush(2);

  // 集合分组与子对话由 #conversation-list 渲染；集合区只保留数量与新建控件，避免重复显示。
  assert.equal(harness.el.collectionsList.childNodes.length, 0);
  assert.equal(harness.el.collectionsList.hidden, true);
  assert.equal(harness.el.collectionsCount.textContent, "1");
  assert.equal(harness.el.collectionSelect.value, "col-1");
  assert.equal([...harness.el.collectionSelect.options][0].value, "");
  assert.equal([...harness.el.collectionSelect.options][1].value, "col-1");

  harness.el.collectionSelect.value = "";
  fire(harness.el.collectionSelect, "change", {});
  assert.deepEqual(harness.calls.move, [["conv-a", ""]]);

  fire(harness.el.newCollection, "click", {});
  await harness.flush();
  const created = harness.calls.api.find((item) => item.url === "/api/collections");
  assert.ok(created, "新建集合应调用 /api/collections");
  assert.match(created.options.body, /导数组/);
});

test("本对话文件：图片用缩略图，文档有类型标签与真实预览地址", async () => {
  const apiHandler = (url) => {
    if (url === "/api/conversations/conv-a/attachments") {
      return {
        ok: true,
        attachments: [
          {
            id: "att-img", kind: "image", name: "原稿.png", available: true, placeholder: false,
            width: 140, height: 60,
            thumbnail_url: "/api/conversations/conv-a/attachments/att-img/thumbnail",
            preview_url: "/api/conversations/conv-a/attachments/att-img/preview",
          },
          {
            id: "att-pdf", kind: "pdf", name: "试卷.pdf", available: true, placeholder: false,
            page_count: 3,
            thumbnail_url: "/api/conversations/conv-a/attachments/att-pdf/thumbnail",
            preview_url: "/api/conversations/conv-a/attachments/att-pdf/preview",
            pages_url: "/api/conversations/conv-a/attachments/att-pdf/pages/{page}",
          },
          {
            id: "att-old", kind: "image", name: "旧图.png", available: false, placeholder: true,
            reason: "旧记录没有保留原文件，只能显示占位信息。",
          },
        ],
      };
    }
    return undefined;
  };
  const conversations = [{ id: "conv-a", title: "导数", collection_id: null, message_count: 1, busy: false }];
  const harness = createHarness({ conversations, apiHandler });
  await harness.window.homeUi.refreshFiles();
  await harness.flush();

  const items = cards(harness);
  assert.equal(items.length, 3);
  assert.equal(items[0].dataset.fileKind, "image");
  const image = items[0].childNodes.find((node) => node.tagName === "IMG");
  assert.ok(image, "图片附件应有真实缩略图");
  assert.match(image.src, /att-img\/thumbnail$/);
  const imageLink = items[0].childNodes.find((node) => node.tagName === "A");
  assert.match(imageLink.href, /att-img\/preview$/);

  assert.equal(items[1].dataset.fileKind, "document");
  const pdfHead = items[1].childNodes.find((node) => node.className === "home-file-head");
  assert.equal(pdfHead.childNodes.find((node) => node.className === "home-file-kind").textContent, "PDF");
  const pdfLink = items[1].childNodes.find((node) => node.tagName === "A");
  assert.match(pdfLink.href, /att-pdf\/pages\/1$/, "PDF 打开真实分页预览地址");

  assert.equal(items[2].hidden, false);
  assert.match(items[2].textContent, /占位/);
  assert.equal(items[2].childNodes.some((node) => node.tagName === "IMG"), false, "占位附件不伪造缩略图");
});

test("切换对话时旧的附件响应不会覆盖新对话", async () => {
  let releaseFirst;
  const apiHandler = (url) => {
    if (url === "/api/conversations/conv-a/attachments") {
      return new Promise((resolve) => {
        releaseFirst = () =>
          resolve({ ok: true, attachments: [{ id: "a1", kind: "image", name: "旧对话.png", available: true, placeholder: false }] });
      });
    }
    if (url === "/api/conversations/conv-b/attachments") {
      return { ok: true, attachments: [{ id: "b1", kind: "text", name: "新对话.txt", available: true, placeholder: false }] };
    }
    return undefined;
  };
  const conversations = [
    { id: "conv-a", title: "甲", collection_id: null, message_count: 0, busy: false },
    { id: "conv-b", title: "乙", collection_id: null, message_count: 0, busy: false },
  ];
  const harness = createHarness({ conversations, apiHandler, activeId: "conv-a" });
  const pending = harness.window.homeUi.refreshFiles();
  await harness.flush(1);
  harness.conversationStore.activeId = "conv-b";
  await harness.window.homeUi.refreshFiles();
  await harness.flush();
  releaseFirst();
  await pending;
  await harness.flush();

  const items = cards(harness);
  assert.equal(items.length, 1);
  assert.equal(items[0].dataset.fileId, "b1", "只保留新对话的附件，旧响应被丢弃");
});

test("资料入库约定：复用本对话附件创建批次，可核对时打开原有核对面板", async () => {
  const apiHandler = (url, options) => {
    if (url === "/api/materials/jobs" && options.method === "POST") {
      const body = JSON.parse(options.body);
      return {
        ok: true,
        job: { id: "job-1", status: "ready", count: 2, source: body.source || "原稿.png", conversation_id: "conv-a", attachment_ids: body.attachment_ids },
      };
    }
    if (url === "/api/materials/jobs/job-1") {
      return { ok: true, job: { id: "job-1", status: "ready", count: 2, source: "原稿.png" } };
    }
    return undefined;
  };
  const conversations = [{ id: "conv-a", title: "导数", collection_id: null, message_count: 2, busy: false }];
  const harness = createHarness({ conversations, apiHandler });
  harness.window.homeUnifiedIntake(
    { route: "materials", prepare: { json: { conversation_id: "conv-a", attachment_ids: ["att-1"] } } },
    "conv-a",
    "把这页练习册入库"
  );
  await harness.flush();

  const submitted = harness.calls.api.find((item) => item.url === "/api/materials/jobs" && item.options.method === "POST");
  assert.ok(submitted, "应自动提交资料批次");
  const body = JSON.parse(submitted.options.body);
  assert.equal(body.conversation_id, "conv-a");
  assert.deepEqual(body.attachment_ids, ["att-1"]);

  const card = harness.el.batches.childNodes[0];
  assert.equal(card.dataset.batchStatus, "ready");
  assert.match(card.textContent, /2 道题/);
  const open = card.childNodes
    .find((node) => node.className === "home-batch-actions")
    .childNodes.find((node) => node.textContent === "打开核对");
  assert.ok(open, "可核对时应给出打开核对按钮");
  fire(open, "click", {});
  await harness.flush(1);
  assert.deepEqual(harness.calls.openMaterial, ["job-1"]);
  assert.deepEqual(harness.calls.views, ["materials"]);
});

test("确认入库后同一对话的卡片换成可信回执，刷新后仍按回执显示", async () => {
  const apiHandler = (url, options) => {
    if (url === "/api/materials/jobs" && options.method === "POST") {
      return { ok: true, job: { id: "job-9", status: "ready", count: 3, source: "原稿.png", conversation_id: "conv-a" } };
    }
    if (url === "/api/materials/jobs/job-9") {
      return { ok: true, job: { id: "job-9", status: "ready", count: 3, source: "原稿.png" } };
    }
    if (url.startsWith("/api/materials/jobs?")) return { ok: true, jobs: [] };
    return undefined;
  };
  const conversations = [{ id: "conv-a", title: "导数", collection_id: null, message_count: 2, busy: false }];
  const harness = createHarness({ conversations, apiHandler });
  harness.window.homeUnifiedIntake(
    { route: "materials", prepare: { json: { conversation_id: "conv-a", attachment_ids: ["att-1"] } } },
    "conv-a",
    ""
  );
  await harness.flush();
  let card = harness.el.batches.childNodes[0];
  assert.equal(card.dataset.batchStatus, "ready");
  assert.match(card.textContent, /尚未入库/);

  // 资料页确认入库成功：派发回执事件（实际新增 3、去重 1）
  harness.window.dispatchEvent(new FakeCustomEvent("home-material-imported", {
    detail: { jobId: "job-9", source: "原稿.png", added: 3, duplicates: 1 },
  }));
  await harness.flush();
  card = harness.el.batches.childNodes[0];
  assert.equal(card.dataset.batchStatus, "imported");
  assert.match(card.textContent, /已确认入库/);
  assert.match(card.textContent, /新增 3 道题/);
  assert.match(card.textContent, /1 道相同原题未重复写入/);
  assert.doesNotMatch(card.textContent, /尚未入库/);
  // 回执写入本地存储，刷新后可按同一对话读回
  assert.ok(harness.storage.has("home-material-import:conv-a"));
  const bank = card.childNodes
    .find((node) => node.className === "home-batch-actions")
    .childNodes.find((node) => node.textContent === "打开题库");
  assert.ok(bank, "已入库后应能打开题库");
  fire(bank, "click", {});
  assert.deepEqual(harness.calls.views, ["materials"]);

  // 模拟刷新：批次已被资料页移除，仍按回执显示“已入库”，不保留旧的“尚未入库”卡
  const refreshed = createHarness({
    conversations: [...conversations],
    apiHandler: (url) => (url.startsWith("/api/materials/jobs?") ? { ok: true, jobs: [] } : undefined),
    receipts: Object.fromEntries(harness.storage),
  });
  await refreshed.window.homeUi.refreshBatches();
  await refreshed.flush();
  const restored = refreshed.el.batches.childNodes[0];
  assert.equal(restored.dataset.batchStatus, "imported");
  assert.match(restored.textContent, /新增 3 道题/);
});

test("只有文字时给出创建预览按钮，并用输入框文字提交", async () => {
  const apiHandler = (url, options) => {
    if (url === "/api/materials/jobs" && options.method === "POST") {
      const body = JSON.parse(options.body);
      return { ok: true, job: { id: "job-2", status: "queued", source: "对话资料", text: body.text } };
    }
    return undefined;
  };
  const conversations = [{ id: "conv-a", title: "导数", collection_id: null, message_count: 2, busy: false }];
  const harness = createHarness({ conversations, apiHandler });
  harness.el.draft.value = "一、求极限 lim x→0 sin x / x。";
  harness.window.homeUnifiedIntake(
    { route: "materials_intake", prepare: { json: { conversation_id: "conv-a", attachment_ids: [] } } },
    "conv-a",
    "把这页练习册入库"
  );
  await harness.flush();

  const card = harness.el.batches.childNodes[0];
  assert.equal(card.dataset.batchStatus, "pending");
  const textButton = card.childNodes
    .find((node) => node.className === "home-batch-actions")
    .childNodes.find((node) => node.textContent === "只用输入框文字创建预览");
  assert.ok(textButton, "没有附件时应提供纯文字预览入口");
  fire(textButton, "click", {});
  await harness.flush();
  const submitted = harness.calls.api.find((item) => item.url === "/api/materials/jobs");
  assert.ok(submitted);
  assert.equal(JSON.parse(submitted.options.body).text, "一、求极限 lim x→0 sin x / x。");
});

test("随本轮提交的题目文字直接创建预览，不依赖发送后已清空的草稿", async () => {
  const apiHandler = (url, options) => {
    if (url === "/api/materials/jobs" && options.method === "POST") {
      const body = JSON.parse(options.body);
      return { ok: true, job: { id: "job-3", status: "queued", source: "对话资料", text: body.text } };
    }
    return undefined;
  };
  const conversations = [{ id: "conv-a", title: "导数", collection_id: null, message_count: 2, busy: false }];
  const harness = createHarness({ conversations, apiHandler });
  harness.el.draft.value = "";
  harness.window.homeUnifiedIntake(
    { route: "materials_intake", prepare: { json: { conversation_id: "conv-a", attachment_ids: [] } } },
    "conv-a",
    "一、求极限 lim x→0 sin x / x。\n把这页练习册入库"
  );
  await harness.flush();

  const submitted = harness.calls.api.find((item) => item.url === "/api/materials/jobs" && item.options.method === "POST");
  assert.ok(submitted, "本轮已提交的题目文字应直接发起预览");
  const body = JSON.parse(submitted.options.body);
  assert.equal(body.conversation_id, "conv-a");
  assert.match(body.text, /sin x/);
  assert.doesNotMatch(body.text, /入库/, "只入库的指令不应混进题目正文");
});

test("题目后面紧跟一句“请帮我入库”时只去掉指令，题目正文照旧进预览", async () => {
  const apiHandler = (url, options) => {
    if (url === "/api/materials/jobs" && options.method === "POST") {
      const body = JSON.parse(options.body);
      return { ok: true, job: { id: "job-4", status: "queued", source: "对话资料", text: body.text } };
    }
    return undefined;
  };
  const conversations = [{ id: "conv-a", title: "导数", collection_id: null, message_count: 2, busy: false }];
  const harness = createHarness({ conversations, apiHandler });
  harness.el.draft.value = "";
  harness.window.homeUnifiedIntake(
    { route: "materials_intake", prepare: { json: { conversation_id: "conv-a", attachment_ids: [] } } },
    "conv-a",
    "求 f(x)=x^2 的导数。请帮我入库"
  );
  await harness.flush();
  const submitted = harness.calls.api.find((item) => item.url === "/api/materials/jobs" && item.options.method === "POST");
  assert.ok(submitted);
  const body = JSON.parse(submitted.options.body);
  assert.equal(body.text, "求 f(x)=x^2 的导数。");
});

test("只提到“添加学习资料 / 入库”而不带内容时保持等待，不把空指令当题目", async () => {
  const conversations = [{ id: "conv-a", title: "导数", collection_id: null, message_count: 2, busy: false }];
  for (const phrase of ["添加学习资料", "把这页练习册入库", "帮我导入这份资料吧"]) {
    const harness = createHarness({ conversations: [...conversations] });
    harness.el.draft.value = "";
    harness.window.homeUnifiedIntake(
      { route: "materials_intake", prepare: { json: { conversation_id: "conv-a", attachment_ids: [] } } },
      "conv-a",
      phrase
    );
    await harness.flush();
    assert.equal(
      harness.calls.api.filter((item) => item.url === "/api/materials/jobs").length,
      0,
      `「${phrase}」不应直接发起预览`
    );
    const card = harness.el.batches.childNodes[0];
    assert.equal(card.dataset.batchStatus, "pending");
    const textButton = card.childNodes
      .find((node) => node.className === "home-batch-actions")
      .childNodes.find((node) => node.textContent === "只用输入框文字创建预览");
    assert.equal(textButton.disabled, true, "没有可复用的文字时按钮保持禁用并等待资料");
  }
});
