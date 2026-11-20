/* Deterministic front-end ownership regressions for PR 8.
 *
 * Runs static/app.js + chat-queue.js + material-review.js in a small DOM shim
 * against a fake fetch server with controllable request gates. No browser or
 * network is needed, so slow requests can be released at exact interleavings.
 *
 *   node tests/test_conversation_interleavings.cjs
 */
"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const STATIC_DIR = process.env.STUDY_STATIC_DIR || path.join(ROOT, "static");
const SOURCES = ["app.js", "chat-queue.js", "material-review.js"]
  .map((name) => fs.readFileSync(path.join(STATIC_DIR, name), "utf8"));

class ClassList {
  constructor() { this.items = new Set(); }
  add(...names) { names.forEach((name) => name && this.items.add(name)); }
  remove(...names) { names.forEach((name) => this.items.delete(name)); }
  contains(name) { return this.items.has(name); }
  toggle(name, force) {
    const next = force === undefined ? !this.items.has(name) : Boolean(force);
    if (next) this.items.add(name); else this.items.delete(name);
    return next;
  }
}

class FakeElement {
  constructor(tag = "div", doc = null) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.eventListeners = new Map();
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.classList = new ClassList();
    this._value = "";
    this._text = "";
    this._parent = null;
    this._query = new Map();
    this.hidden = false;
    this.disabled = false;
    this.readOnly = false;
    this.open = false;
    this.type = "";
    this.title = "";
    this.id = "";
    this.maxLength = 80000;
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.scrollTop = 0;
    this.scrollHeight = 0;
  }
  get parentElement() {
    if (!this._parent) this._parent = new FakeElement("parent", this.ownerDocument);
    return this._parent;
  }
  set parentElement(node) { this._parent = node; }
  get textContent() { return this._text + this.children.map((child) => child.textContent || "").join(""); }
  set textContent(value) { this._text = String(value == null ? "" : value); this.children = []; }
  get value() { return this._value; }
  set value(value) { this._value = String(value == null ? "" : value); }
  append(...nodes) { this._append(nodes); }
  prepend(...nodes) { this._append(nodes, true); }
  _append(nodes, first = false) {
    const built = nodes.map((node) => {
      if (node && typeof node === "object") { node.parentElement = this; return node; }
      const text = new FakeElement("#text", this.ownerDocument);
      text._text = String(node == null ? "" : node);
      return text;
    });
    if (first) this.children.unshift(...built); else this.children.push(...built);
  }
  replaceChildren(...nodes) { this.children = []; this._text = ""; this._append(nodes); }
  remove() { if (this._parent) this._parent.children = this._parent.children.filter((child) => child !== this); }
  querySelector(selector) {
    if (!this._query.has(selector)) {
      const node = new FakeElement(selector, this.ownerDocument);
      node.parentElement = this;
      this._query.set(selector, node);
    }
    return this._query.get(selector);
  }
  querySelectorAll() { return []; }
  addEventListener(type, handler) {
    if (!this.eventListeners.has(type)) this.eventListeners.set(type, []);
    this.eventListeners.get(type).push(handler);
  }
  dispatchEvent(event) {
    for (const handler of this.eventListeners.get(event.type) || []) handler.call(this, event);
    return true;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  contains() { return false; }
  closest() { return null; }
  scrollIntoView() {}
  setRangeText(text, start, end) {
    this.value = this.value.slice(0, start) + text + this.value.slice(end);
    this.selectionStart = this.selectionEnd = start + String(text).length;
  }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
}

class FakeDocument {
  constructor() {
    this.nodes = new Map();
    this.activeElement = null;
    this.readyState = "loading";
    this.body = this.querySelector("body");
  }
  querySelector(selector) {
    if (!this.nodes.has(selector)) this.nodes.set(selector, new FakeElement(selector, this));
    return this.nodes.get(selector);
  }
  querySelectorAll() { return []; }
  createElement(tag) { return new FakeElement(tag, this); }
  getElementById(id) { return this.querySelector("#" + id); }
  addEventListener() {}
}

class FakeStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(String(key), String(value)); }
  removeItem(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
}

class FakeFormData {
  constructor() { this.map = new Map(); }
  append(key, value) {
    if (!this.map.has(key)) this.map.set(key, []);
    this.map.get(key).push(value);
  }
  get(key) { const list = this.map.get(key); return list ? list[0] : null; }
  getAll(key) { return [...(this.map.get(key) || [])]; }
}

function ok(payload) {
  return { ok: true, status: 200, json: async () => ({ ok: true, ...payload }) };
}
function fail(message, status = 400) {
  return { ok: false, status, json: async () => ({ ok: false, error: message }) };
}

class FakeServer {
  constructor() {
    this.conversations = new Map();
    this.active = null;
    this.collections = [];
    this.calls = [];
    this.chats = [];
    this.patchLog = [];
    this.gates = new Map();
    this.counter = 0;
    this.imageCounter = 0;
  }
  create(id, title = "新对话", draft = false) {
    const conversation = { id, title, messages: [], intake_text: "", images: [], draft,
      collection_id: null };
    this.conversations.set(id, conversation);
    this.active = id;
    return conversation;
  }
  summary(conversation) {
    return { id: conversation.id, title: conversation.title,
      created_at: "2026-11-19T00:00:00+08:00", updated_at: "2026-11-19T00:00:00+08:00",
      busy: false, message_count: conversation.messages.length,
      collection_id: conversation.collection_id || null,
      draft: Boolean(conversation.draft),
      empty: !conversation.messages.length && !conversation.intake_text && !conversation.images.length };
  }
  detail(conversation) {
    return { ...this.summary(conversation),
      messages: conversation.messages.map((message) => ({ role: message.role, text: message.text, at: "t" })),
      intake: { text: conversation.intake_text, image_ids: [...conversation.images], image_count: conversation.images.length } };
  }
  list() {
    return { active: this.active, conversations: [...this.conversations.values()].map((item) => this.summary(item)),
      collections: this.collections };
  }
  // 新首页接口：草稿单独返回，历史里不再出现草稿；ensure=0 时只读，不补草稿。
  index(ensure = true) {
    let draft = [...this.conversations.values()].find((item) => item.draft && !item.messages.length);
    if (!draft && ensure) {
      const previous = this.active;
      draft = this.create(`c${++this.counter}`, "新对话", true);
      this.active = previous;
    }
    return { active: this.active,
      conversations: [...this.conversations.values()].filter((item) => !item.draft).map((item) => this.summary(item)),
      collections: this.collections, draft: draft ? this.summary(draft) : null };
  }
  gate(method, pathname) {
    let enteredResolve;
    const entered = new Promise((resolve) => { enteredResolve = resolve; });
    let releaseResolve;
    const release = new Promise((resolve) => { releaseResolve = resolve; });
    this.gates.set(`${method} ${pathname}`, { entered, release, enteredResolve });
    return { entered, release: () => releaseResolve() };
  }
  async fetch(input, options = {}) {
    const url = new URL(input, "http://local");
    const pathname = url.pathname;
    const method = (options.method || "GET").toUpperCase();
    const key = `${method} ${pathname}`;
    const body = options.body;
    this.calls.push({ method, pathname });
    const gate = this.gates.get(key);
    if (gate) {
      this.gates.delete(key);
      gate.enteredResolve();
      await gate.release;
    }
    if (pathname === "/api/conversations" && method === "GET") {
      return ok(url.searchParams.get("draft") === "1"
        ? this.index(url.searchParams.get("ensure") !== "0")
        : this.list());
    }
    if (pathname === "/api/conversations" && method === "POST") {
      const id = `c${++this.counter}`;
      const conversation = this.create(id);
      return ok({ active: id, conversation: this.summary(conversation) });
    }
    const match = /^\/api\/conversations\/([^/]+)(\/activate|\/move)?$/.exec(pathname);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const conversation = this.conversations.get(id);
      if (!conversation) return fail("对话不存在或已删除，请刷新网页后重试。", 404);
      if (method === "GET") return ok({ conversation: this.detail(conversation) });
      if (method === "POST" && match[2] === "/move") {
        const payload = JSON.parse(body || "{}");
        conversation.collection_id = payload.collection_id || null;
        return ok({ conversation: this.summary(conversation) });
      }
      if (method === "POST" && match[2]) { this.active = id; return ok({ active: id, conversation: this.summary(conversation) }); }
      if (method === "PATCH") {
        const payload = JSON.parse(body || "{}");
        if (typeof payload.intake_text === "string") {
          conversation.intake_text = payload.intake_text;
          this.patchLog.push({ id, text: payload.intake_text });
        }
        return ok({ conversation: this.summary(conversation) });
      }
      if (method === "DELETE") {
        this.conversations.delete(id);
        if (this.active === id) this.active = [...this.conversations.keys()].at(-1) || null;
        if (!this.conversations.size) { const next = this.create(`c${++this.counter}`); this.active = next.id; }
        return ok({ active: this.active });
      }
    }
    if (pathname === "/api/intake/read" || pathname === "/api/intake/prepare") {
      const form = body;
      const id = form.get("conversation_id") || this.active;
      const conversation = this.conversations.get(id);
      if (!conversation) return fail("对话不存在或已删除，请刷新网页后重试。", 404);
      const files = form.getAll("files");
      const text = files.map((file) => file.content != null ? file.content : file.name.replace(/\.[^.]+$/, "")).join("");
      const imageIds = files.map(() => `img-${++this.imageCounter}`);
      conversation.images.push(...imageIds);
      if (pathname === "/api/intake/read") {
        return ok({ text, image_ids: [...conversation.images], pages: files.map(() => ({})) });
      }
      return ok({ text, image_ids: [...conversation.images], pages: files.map(() => ({})), metadata: {} });
    }
    if (pathname === "/api/intake/clear" && method === "POST") {
      const payload = JSON.parse(body || "{}");
      const id = payload.conversation_id || this.active;
      const conversation = this.conversations.get(id);
      if (!conversation) return fail("对话不存在或已删除，请刷新网页后重试。", 404);
      conversation.intake_text = "";
      conversation.images = [];
      return ok({});
    }
    if (pathname === "/api/chat" && method === "POST") {
      const payload = JSON.parse(body || "{}");
      this.chats.push(payload);
      const answer = payload.message.includes("模拟信息不足") ? "请补充你当时的答案或关键步骤。" : "完成";
      if (payload.view !== "organize") {
        return ok({ answer, events: [], proposals: [], current_question: null });
      }
      const id = payload.conversation_id || this.active;
      const conversation = this.conversations.get(id);
      if (!conversation) return fail("对话不存在或已删除，请刷新网页后重试。", 404);
      if (conversation.title === "新对话") {
        const visible = String(payload.display_text || payload.message).replace(/\s+/g, " ").trim().slice(0, 18);
        if (visible) conversation.title = visible;
      }
      conversation.draft = false;
      conversation.messages.push({ role: "user", text: payload.display_text || payload.message }, { role: "assistant", text: answer });
      return ok({ answer, events: [], proposals: [], current_question: null, conversation_id: id });
    }
    if (pathname === "/api/mistakes") {
      return ok({ data: { total: 0, topic_counts: {}, mistakes: [] } });
    }
    if (pathname === "/api/notes") return ok({ notes: [], total: 0 });
    return fail(`unhandled fake route ${method} ${pathname}`, 404);
  }
}

function createRuntime(server, shared = {}) {
  const document = new FakeDocument();
  const sessionStorage = shared.sessionStorage || new FakeStorage();
  const localStorage = shared.localStorage || new FakeStorage();
  const window = {
    addEventListener() {}, dispatchEvent() {}, getSelection() { return null; },
    setTimeout, clearTimeout, requestAnimationFrame: (fn) => setTimeout(fn, 0),
  };
  const sandbox = {
    console, window, document, localStorage, sessionStorage,
    fetch: (input, options) => server.fetch(input, options),
    FormData: FakeFormData, crypto: crypto.webcrypto, URL, queueMicrotask,
    Event: class { constructor(type) { this.type = type; } },
    setTimeout, clearTimeout, Date, JSON, Math, Map, Set, Promise,
    filePreview: { cache: new Map(), file: null, document: null },
    closeFilePreview: () => {},
    confirm: () => true,
  };
  const context = vm.createContext(sandbox);
  for (const source of SOURCES) vm.runInContext(source, context, { filename: "static-bundle.js" });
  vm.runInContext("loadMistakes=async()=>{};loadNotes=async()=>{};answerAttachments=[];selectionRefs=()=>[];", context);
  return { context, document, sessionStorage, run: (code) => vm.runInContext(code, context) };
}

function boot(runtime, server, active = "A") {
  const listing = server.list();
  runtime.run(`
    conversationStore.available=true;
    conversationStore.list=${JSON.stringify(listing.conversations)};
    conversationStore.activeId=${JSON.stringify(active)};
    state.configured=true;
    for(const item of conversationStore.list){const entry=conversationCache(item.id);entry.loaded=true;entry.messages=[];entry.traces=[];entry.artifacts=new Map();entry.saved=new Set();}
    applyConversationWorkspace(conversationCache(${JSON.stringify(active)}));
  `);
}

function setDraft(runtime, value) {
  runtime.run(`document.querySelector("#draft").value=${JSON.stringify(value)};updateDraft();`);
  runtime.run("cancelDraftSave()");
}

function snapshot(runtime) {
  return JSON.parse(runtime.run(`JSON.stringify({
    active:conversationStore.activeId,
    draftId:conversationStore.draftId,
    listIds:conversationStore.list.map(item=>item.id),
    draft:document.querySelector("#draft").value,
    queue:intake.queue.map(item=>item.file.name),
    queueRead:intake.queue.map(item=>Boolean(item.read)),
    imageIds:[...intake.imageIds],
    messagesA:conversationCache("A").messages.map(item=>item.text),
    messagesB:conversationCache("B").messages.map(item=>item.text),
    draftA:conversationCache("A").draft,
    draftB:conversationCache("B").draft,
    titles:conversationStore.list.map(item=>({id:item.id,title:item.title})),
    busy:state.busy,
    operation:state.operation?state.operation.type:null,
    text:document.querySelector("#organize-messages").textContent
  })`));
}

function file(name, content) {
  return { name, size: content.length + 1, lastModified: 1, content };
}

async function waitFor(check, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitFor timed out");
}

const scenarios = [];
function scenario(name, run) { scenarios.push({ name, run }); }

scenario("chat A→B→A keeps the pending user turn and the answer lands in A", async () => {
  const server = new FakeServer();
  server.create("A"); server.create("B", "对话 B"); server.active = "A";
  const runtime = createRuntime(server);
  boot(runtime, server, "A");
  const gate = server.gate("POST", "/api/chat");
  const chat = runtime.context.sendMessage("A-unique 模拟信息不足", "organize", "draft",
    "A-unique 模拟信息不足", { new_problem: true, image_ids: [] });
  await gate.entered;
  await runtime.context.openConversation("B");
  await runtime.context.openConversation("A");
  assert.match(snapshot(runtime).text, /A-unique/, "pending user message must survive A→B→A");
  gate.release();
  await chat;
  await waitFor(() => snapshot(runtime).messagesA.length === 2);
  assert.deepEqual(snapshot(runtime).messagesA, ["A-unique 模拟信息不足", "请补充你当时的答案或关键步骤。"]);
  await runtime.context.openConversation("B");
  assert.doesNotMatch(snapshot(runtime).text, /A-unique/);
  assert.equal(server.chats[0].conversation_id, "A");
});

scenario("a foreign view operation is not overwritten by organize busy state", async () => {
  const server = new FakeServer();
  server.create("A"); server.create("B", "对话 B"); server.active = "A";
  const runtime = createRuntime(server);
  boot(runtime, server, "A");
  const organizeGate = server.gate("POST", "/api/chat");
  const organize = runtime.context.sendMessage("A-unique 模拟信息不足", "organize", "draft",
    "A-unique 模拟信息不足", { new_problem: true, image_ids: [] });
  await organizeGate.entered;
  await runtime.context.openConversation("B");
  const reviewGate = server.gate("POST", "/api/chat");
  const review = runtime.context.sendMessage("请检查这一步", "review", "review-follow", "请检查这一步", {});
  await reviewGate.entered;
  await runtime.context.openConversation("A");
  let state = JSON.parse(runtime.run("JSON.stringify({busy:state.busy,type:state.operation&&state.operation.type,view:state.operation&&state.operation.view})"));
  assert.equal(state.view, "review", "switching conversations must not overwrite a foreign operation");
  reviewGate.release();
  await review;
  state = JSON.parse(runtime.run("JSON.stringify({busy:state.busy,type:state.operation&&state.operation.type,view:state.operation&&state.operation.view})"));
  assert.equal(state.busy, true, "the organize operation must own the status bar again");
  assert.equal(state.view, "organize");
  organizeGate.release();
  await organize;
  state = JSON.parse(runtime.run("JSON.stringify({busy:state.busy,type:state.operation&&state.operation.type})"));
  assert.equal(state.busy, false);
  assert.equal(state.type, null);
});

scenario("queued local files stay with their conversation", async () => {
  const server = new FakeServer();
  server.create("A"); server.create("B", "对话 B"); server.active = "A";
  const runtime = createRuntime(server);
  boot(runtime, server, "A");
  runtime.run(`addFiles([${JSON.stringify(file("queued-A.txt", "queued-A"))}])`);
  assert.deepEqual(snapshot(runtime).queue, ["queued-A.txt"]);
  await runtime.context.openConversation("B");
  assert.deepEqual(snapshot(runtime).queue, []);
  await runtime.context.openConversation("A");
  assert.deepEqual(snapshot(runtime).queue, ["queued-A.txt"]);
});

scenario("background OCR inserts into A's draft, not B's", async () => {
  const server = new FakeServer();
  server.create("A"); server.create("B", "对话 B"); server.active = "A";
  const runtime = createRuntime(server);
  boot(runtime, server, "A");
  runtime.run(`addFiles([${JSON.stringify(file("read-A.txt", "read-A"))}])`);
  const gate = server.gate("POST", "/api/intake/read");
  const read = runtime.context.recognize();
  await gate.entered;
  await runtime.context.openConversation("B");
  setDraft(runtime, "B-draft");
  gate.release();
  await read;
  await waitFor(() => snapshot(runtime).draftA === "read-A");
  assert.equal(snapshot(runtime).draftB, "B-draft");
  assert.equal(snapshot(runtime).draft, "B-draft");
  await runtime.context.openConversation("A");
  assert.equal(snapshot(runtime).draft, "read-A");
  assert.deepEqual(snapshot(runtime).queueRead, [true]);
  runtime.run("cancelDraftSave()");
});

scenario("background prepare→chat uses A's snapshot, never B's draft", async () => {
  const server = new FakeServer();
  server.create("A"); server.create("B", "对话 B"); server.active = "A";
  const runtime = createRuntime(server);
  boot(runtime, server, "A");
  runtime.run(`addFiles([${JSON.stringify(file("prepared-A.txt", "prepared-A 模拟信息不足"))}])`);
  const gate = server.gate("POST", "/api/intake/prepare");
  const submit = runtime.context.submitOriginalIntake();
  await gate.entered;
  await runtime.context.openConversation("B");
  setDraft(runtime, "B-private-draft");
  gate.release();
  await submit;
  await waitFor(() => server.chats.length === 1);
  await waitFor(() => snapshot(runtime).messagesA.length === 2);
  assert.equal(server.chats[0].conversation_id, "A");
  assert.match(server.chats[0].message, /prepared-A/);
  assert.match(server.chats[0].display_text || "", /prepared-A/);
  const titleA = snapshot(runtime).titles.find((item) => item.id === "A").title;
  assert.match(titleA, /prepared-A/);
  assert.doesNotMatch(titleA, /请自动辨认/);
  assert.doesNotMatch(server.chats[0].message, /B-private-draft/);
  await runtime.context.openConversation("A");
  assert.match(snapshot(runtime).text, /请补充你当时的答案/);
  assert.doesNotMatch(snapshot(runtime).text, /请自动辨认原图与以下补充/);
  await runtime.context.openConversation("B");
  assert.equal(snapshot(runtime).draft, "B-private-draft");
});

scenario("background clear only clears its own conversation", async () => {
  const server = new FakeServer();
  server.create("A"); server.create("B", "对话 B"); server.active = "A";
  server.conversations.get("A").intake_text = "A-to-clear";
  const runtime = createRuntime(server);
  boot(runtime, server, "A");
  setDraft(runtime, "A-to-clear");
  const gate = server.gate("POST", "/api/intake/clear");
  const clearing = runtime.context.clearIntake(false);
  await gate.entered;
  await runtime.context.openConversation("B");
  setDraft(runtime, "B-keep");
  gate.release();
  await clearing;
  await waitFor(() => server.conversations.get("A").intake_text === "");
  assert.equal(snapshot(runtime).draftB, "B-keep");
  assert.equal(snapshot(runtime).draft, "B-keep");
  assert.equal(server.conversations.get("B").intake_text, "");
  await runtime.context.openConversation("A");
  assert.equal(snapshot(runtime).draft, "");
  await runtime.context.openConversation("B");
  assert.equal(snapshot(runtime).draft, "B-keep");
  assert.equal(runtime.sessionStorage.getItem("study-history-draft:A"), null);
});

scenario("clear cancels the debounce and waits for an in-flight PATCH", async () => {
  const server = new FakeServer();
  server.create("A"); server.create("B", "对话 B"); server.active = "A";
  server.conversations.get("A").intake_text = "server-old";
  const runtime = createRuntime(server);
  boot(runtime, server, "A");
  runtime.run(`document.querySelector("#draft").value="debounced";updateDraft();`);
  const version = JSON.parse(runtime.run("JSON.stringify(conversationCache('A').draftVersion)"));
  const patchGate = server.gate("PATCH", "/api/conversations/A");
  const patching = runtime.context.patchConversationIntake("A", "old-draft", version);
  await patchGate.entered;
  const clearGate = server.gate("POST", "/api/intake/clear");
  const clearing = runtime.context.clearIntake(false);
  const reached = await Promise.race([
    clearGate.entered.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 150)),
  ]);
  assert.equal(reached, false, "clear must wait for the in-flight PATCH");
  patchGate.release();
  await patching;
  await clearGate.entered;
  clearGate.release();
  await clearing;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const texts = server.patchLog.filter((item) => item.id === "A").map((item) => item.text);
  assert.ok(!texts.includes("debounced"), `debounced draft must not resurrect: ${JSON.stringify(texts)}`);
  assert.equal(server.conversations.get("A").intake_text, "");
});

scenario("image-only organize uses file names as the visible text and title", async () => {
  const server = new FakeServer();
  server.create("A"); server.create("B", "对话 B"); server.active = "A";
  const runtime = createRuntime(server);
  boot(runtime, server, "A");
  runtime.run(`addFiles([${JSON.stringify(file("只上传图片.png", ""))}])`);
  const submit = runtime.context.submitOriginalIntake();
  await submit;
  await waitFor(() => server.chats.length === 1);
  assert.match(server.chats[0].message, /请自动辨认原图/);
  assert.match(server.chats[0].display_text || "", /只上传图片\.png/);
  const titleA = snapshot(runtime).titles.find((item) => item.id === "A").title;
  assert.match(titleA, /只上传图片\.png/);
  assert.doesNotMatch(titleA, /请自动辨认/);
  await runtime.context.openConversation("A");
  assert.match(snapshot(runtime).text, /只上传图片\.png/);
  assert.doesNotMatch(snapshot(runtime).text, /请自动辨认原图与以下补充/);
  assert.match(snapshot(runtime).messagesA[0], /只上传图片\.png/);
});

scenario("deleting a conversation drops its queued messages", async () => {
  const server = new FakeServer();
  server.create("A", "对话 A"); server.create("B", "对话 B"); server.active = "B";
  const runtime = createRuntime(server);
  boot(runtime, server, "B");
  runtime.run(`chatQueue.items.push({id:"queued-b",view:"organize",text:"B queued",editorText:"B queued",displayText:"B queued",conversationId:"B",options:{},attachments:[],blocked:false,editing:false});renderChatQueues();`);
  assert.equal(JSON.parse(runtime.run("JSON.stringify(chatQueue.items.length)")), 1);
  await runtime.context.deleteConversation("B");
  assert.equal(JSON.parse(runtime.run("JSON.stringify(chatQueue.items.length)")), 0);
  assert.equal(snapshot(runtime).active, "A");
  assert.equal(server.conversations.has("B"), false);
});

scenario("refresh recovers an unsaved long draft from the same tab", async () => {
  const server = new FakeServer();
  server.create("A"); server.create("B", "对话 B"); server.active = "A";
  const first = createRuntime(server);
  boot(first, server, "A");
  const longDraft = "汉".repeat(25000);
  setDraft(first, longDraft);
  assert.ok(first.sessionStorage.getItem("study-history-draft:A"), "tab cache must be written synchronously");
  const version = JSON.parse(first.run("JSON.stringify(conversationCache('A').draftVersion)"));
  const second = createRuntime(server, { sessionStorage: first.sessionStorage });
  second.run(`
    conversationStore.available=true;
    conversationStore.list=${JSON.stringify(server.list().conversations)};
    conversationStore.activeId="A";
    state.configured=true;
  `);
  await second.context.openConversation("A");
  assert.equal(snapshot(second).draft, longDraft);
  await second.context.patchConversationIntake("A", longDraft, version);
  assert.equal(second.sessionStorage.getItem("study-history-draft:A"), null, "a successful same-version PATCH clears the tab cache");
  assert.equal(server.conversations.get("A").intake_text, longDraft);
});

scenario("new chat reuses one draft and never POSTs an empty history row", async () => {
  const server = new FakeServer();
  const history = server.create("H", "历史对话");
  history.messages.push({ role: "user", text: "旧问题" }, { role: "assistant", text: "旧回答" });
  const runtime = createRuntime(server);
  runtime.run("state.configured=true;");
  await runtime.context.loadConversations();
  const draftId = snapshot(runtime).active;
  assert.ok(draftId && draftId !== "H", "首页应进入草稿");
  await runtime.context.openConversation(draftId, { silent: true });
  assert.equal(snapshot(runtime).draftId, draftId);
  assert.equal(server.calls.filter((item) => item.method === "POST" && item.pathname === "/api/conversations").length, 0);
  setDraft(runtime, "保留的草稿文字");
  runtime.run(`addFiles([${JSON.stringify(file("queued-draft.txt", "queued-draft"))}])`);

  await Promise.all([runtime.context.newConversation(), runtime.context.newConversation(),
    runtime.context.newConversation()]);
  const current = snapshot(runtime);
  assert.equal(current.active, draftId, "连续点击仍回到同一草稿");
  assert.equal(current.draftId, draftId);
  assert.equal(current.draft, "保留的草稿文字");
  assert.deepEqual(current.queue, ["queued-draft.txt"]);
  assert.equal(server.conversations.get(draftId).messages.length, 0);
  assert.equal(server.conversations.get(draftId).draft, true);
  assert.equal(server.calls.filter((item) => item.method === "POST" && item.pathname === "/api/conversations").length, 0,
    "点击新聊天不能创建历史行");
});

scenario("history → new chat returns to the same draft with text, files, images and collection", async () => {
  const server = new FakeServer();
  server.collections = [{ id: "col-1", name: "函数" }];
  const history = server.create("H", "历史对话");
  history.messages.push({ role: "user", text: "旧问题" }, { role: "assistant", text: "旧回答" });
  const runtime = createRuntime(server);
  runtime.run("state.configured=true;");
  await runtime.context.loadConversations();
  const draftId = snapshot(runtime).active;
  await runtime.context.openConversation(draftId, { silent: true });
  setDraft(runtime, "草稿原稿 $x^2$");
  runtime.run(`addFiles([${JSON.stringify(file("draft-file.txt", "draft"))}]);intake.imageIds=["keep-img"];`);
  await runtime.context.moveConversationToCollection(draftId, "col-1");
  assert.equal(server.conversations.get(draftId).collection_id, "col-1", "草稿集合写入草稿而不是历史");

  await runtime.context.openConversation("H");
  assert.equal(snapshot(runtime).active, "H");
  await runtime.context.newConversation();
  const current = snapshot(runtime);
  assert.equal(current.active, draftId);
  assert.equal(current.draft, "草稿原稿 $x^2$");
  assert.deepEqual(current.queue, ["draft-file.txt"]);
  assert.deepEqual(current.imageIds, ["keep-img"]);
  const draftSummary = JSON.parse(runtime.run("JSON.stringify(conversationStore.list.find(item=>item.draft))"));
  assert.equal(draftSummary.collection_id, "col-1");
  assert.equal(server.calls.filter((item) => item.method === "POST" && item.pathname === "/api/conversations").length, 0);
});

scenario("first real send promotes the draft, then a fresh blank draft is available", async () => {
  const server = new FakeServer();
  server.collections = [{ id: "col-1", name: "函数" }];
  const draft = server.create("D", "新对话", true);
  server.active = "D";
  const runtime = createRuntime(server);
  runtime.run("state.configured=true;");
  await runtime.context.loadConversations();
  assert.equal(snapshot(runtime).active, "D");
  await runtime.context.openConversation("D", { silent: true });
  setDraft(runtime, "第一轮原稿");
  runtime.run(`addFiles([${JSON.stringify(file("first.txt", "第一轮补充"))}])`);
  await runtime.context.moveConversationToCollection("D", "col-1");

  const first = runtime.context.submitOriginalIntake();
  const duplicate = runtime.context.submitOriginalIntake();
  await first;
  await duplicate;
  await waitFor(() => server.chats.length === 1);
  await runtime.context.refreshConversations();
  assert.equal(snapshot(runtime).draftId, null, "刷新列表不应凭空创建新草稿");
  assert.equal(server.chats.length, 1, "快速重复发送不能创建第二个请求");
  assert.equal(server.chats[0].conversation_id, "D");
  assert.ok(server.chats[0].image_ids.length >= 1, "草稿已接受的原稿随首次发送进入聊天");
  assert.equal(draft.messages.length, 2);
  assert.equal(draft.draft, false, "首次发送后草稿提升为正式历史");
  assert.equal(draft.collection_id, "col-1");
  const promoted = snapshot(runtime);
  assert.equal(promoted.active, "D", "发送后仍停留在刚提升的对话");

  await runtime.context.newConversation();
  const fresh = snapshot(runtime);
  assert.notEqual(fresh.active, "D");
  assert.equal(fresh.active, fresh.draftId);
  assert.equal(fresh.draft, "");
  assert.deepEqual(fresh.queue, []);
  assert.equal(server.conversations.get(fresh.active).messages.length, 0);
  assert.equal(server.calls.filter((item) => item.method === "POST" && item.pathname === "/api/conversations").length, 0);
});

scenario("legacy empty rows stay hidden and never become the new chat", async () => {
  const server = new FakeServer();
  const empty = server.create("E", "新对话");
  const history = server.create("H", "历史对话");
  history.messages.push({ role: "user", text: "旧问题" }, { role: "assistant", text: "旧回答" });
  const runtime = createRuntime(server);
  runtime.run("state.configured=true;");
  await runtime.context.loadConversations();
  const draftId = snapshot(runtime).active;
  assert.notEqual(draftId, "E");
  const list = runtime.document.querySelector("#conversation-list");
  const ids = list.children.map((node) => node.dataset.conversationId).filter(Boolean);
  assert.ok(ids.includes("H"), "历史消息仍显示");
  assert.ok(!ids.includes("E"), "旧版空行不占新历史");
  await runtime.context.newConversation();
  assert.equal(snapshot(runtime).active, draftId);
  assert.equal(server.conversations.has("E"), true, "旧空行不删除，只是不显示");
  assert.equal(empty.messages.length, 0);
});

scenario("a new blank draft can open while the first draft send is still waiting", async () => {
  const server = new FakeServer();
  const draft = server.create("D", "新对话", true);
  server.active = "D";
  const runtime = createRuntime(server);
  runtime.run("state.configured=true;");
  await runtime.context.loadConversations();
  await runtime.context.openConversation("D", { silent: true });
  setDraft(runtime, "第一轮原稿");
  const gate = server.gate("POST", "/api/chat");
  runtime.context.submitOriginalIntake();
  await gate.entered;
  // 服务端在模型等待前已经把用户消息记入草稿，草稿此时已提升为正式对话。
  draft.draft = false;
  await runtime.context.refreshConversations();
  assert.notEqual(snapshot(runtime).draftId, "D");
  await runtime.context.newConversation();
  const fresh = snapshot(runtime);
  assert.notEqual(fresh.active, "D");
  assert.equal(fresh.active, fresh.draftId);
  assert.equal(fresh.draft, "");
  gate.release();
  await waitFor(() => draft.messages.length === 2);
  assert.equal(draft.messages[0].role, "user");
  assert.equal(snapshot(runtime).active, fresh.active, "旧对话的答案不能把新草稿切走");
  assert.equal(server.calls.filter((item) => item.method === "POST" && item.pathname === "/api/conversations").length, 0);
});

(async () => {
  const failures = [];
  for (const item of scenarios) {
    try {
      await item.run();
      console.log(`PASS ${item.name}`);
    } catch (error) {
      failures.push(item.name);
      console.error(`FAIL ${item.name}: ${error && error.stack || error}`);
    }
  }
  if (failures.length) {
    console.error(`${failures.length} scenario(s) failed: ${failures.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("PASS: all conversation interleaving scenarios");
  }
})();
