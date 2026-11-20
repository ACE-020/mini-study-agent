"use strict";
/*
 * 统一对话首页的页面接线：布局面板 + 真实数据（集合 / 本对话文件 / 资料批次）。
 *
 * 只做 DOM 适配与取数，不改输入、数学编辑器或后端协议。数据来源：
 *   GET  /api/conversations                          会话 + 集合（conversationStore 同步）
 *   POST /api/collections                            新建集合
 *   POST /api/conversations/<id>/move                设置 / 移出集合
 *   GET  /api/conversations/<id>/attachments         本对话附件（缩略图 / 预览地址）
 *   POST /api/materials/jobs                         用本对话附件或文字创建资料预览批次
 *   GET  /api/materials/jobs?conversation_id=<id>    按对话读回批次状态
 *   GET  /api/materials/jobs/<id>                    轮询批次状态
 *   POST /api/materials/jobs/<id>/(cancel|retry)     停止 / 重试
 *
 * 确认入库仍由资料页原有的核对面板完成（openMaterialJob），聊天里只放批次入口与状态。
 */
(function () {
  const $ = (selector) => document.querySelector(selector);

  const nodes = {
    root: $("#organize-workspace"),
    nav: $("#home-nav"),
    leftPanel: $("#home-history-panel"),
    rightPanel: $("#home-files-panel"),
    leftHandle: $("#home-left-handle"),
    rightHandle: $("#home-right-handle"),
    leftButton: $("#home-left-toggle"),
    rightButton: $("#home-right-toggle"),
    messages: $("#organize-messages"),
    draft: $("#draft"),
    submit: $("#organize-submit"),
    follow: $("#organize-follow"),
    followForm: $("#organize-follow-form"),
    attach: $("#home-attach-button"),
    fileInput: $("#image-input"),
    filesList: $("#home-files-list"),
    filesEmpty: $("#home-files-empty"),
    filesSummary: $("#home-files-summary"),
    collectionsList: $("#home-collections-list"),
    collectionsCount: $("#home-collections-count"),
    newCollection: $("#home-new-collection"),
    collectionSelect: $("#home-collection-select"),
    chatTitle: $("#home-chat-title"),
    chatMeta: $("#home-chat-meta"),
    batches: $("#home-chat-batches"),
  };

  let panels = null;
  let fileEntries = [];
  let filesFor = null;
  let filesSeq = 0;
  let lastConversationId = null;
  let scheduled = false;
  let emptyObserver = null;
  let listObserver = null;
  let hintObserver = null;
  let collectionsSignature = "";

  const batches = new Map(); // conversationId -> {status, jobId, job, error, attachmentIds, conversationId}
  const batchTimers = new Map();
  let pendingCollection = "";

  // ------------------------------------------------------------------ 基础工具
  function currentConversationId() {
    return typeof conversationStore !== "undefined" && conversationStore
      ? conversationStore.activeId
      : null;
  }

  function activeEntry() {
    return typeof activeConversation === "function" ? activeConversation() : null;
  }

  function activeSummary() {
    if (typeof conversationStore === "undefined" || !conversationStore) return null;
    return (conversationStore.list || []).find((item) => item.id === currentConversationId()) || null;
  }

  function collections() {
    return (typeof conversationStore !== "undefined" && conversationStore && conversationStore.collections) || [];
  }

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function safeUrl(value) {
    const url = String(value || "");
    // 同源相对路径（/api/conversations/...）也要能加载；拒绝 //host 这类协议相对地址。
    return /^(https?:|blob:|data:image\/|\/(?!\/))/i.test(url) ? url : "";
  }

  // ------------------------------------------------------------------ 本对话文件
  function fileKindLabel(item) {
    const name = String(item.name || "");
    if (item.kind === "image") return "图片";
    if (item.kind === "pdf" || /\.pdf$/i.test(name)) return "PDF";
    if (/\.md$/i.test(name)) return "MD";
    if (item.kind === "text" || /\.txt$/i.test(name)) return "TXT";
    return "文档";
  }

  function fileMeta(item) {
    if (item.kind === "pdf") return item.page_count ? `${item.page_count} 页` : "PDF 文档";
    if (item.kind === "text") return "文字文件";
    if (item.width && item.height) return `${item.width}×${item.height}`;
    return "";
  }

  function fileEntry(item) {
    const available = Boolean(item.available) && !item.placeholder;
    const pages = typeof item.pages_url === "string" ? item.pages_url.replace("{page}", "1") : "";
    return {
      id: item.id,
      name: item.name,
      kind: item.kind === "image" ? "image" : "document",
      typeLabel: fileKindLabel(item),
      meta: fileMeta(item),
      available,
      placeholder: Boolean(item.placeholder),
      reason: item.reason || "",
      thumbnailUrl: available
        ? item.thumbnail_url || (item.kind === "image" ? item.preview_url : "")
        : "",
      url: available ? pages || item.preview_url || "" : "",
    };
  }

  function renderFileCards(entries) {
    if (!nodes.filesList) return;
    nodes.filesList.replaceChildren();
    for (const item of entries) {
      if (!item) continue;
      const card = document.createElement("article");
      card.className = "home-file-card";
      if (item.id) card.dataset.fileId = String(item.id);
      if (item.kind) card.dataset.fileKind = item.kind;
      const head = make("div", "home-file-head");
      head.append(make("span", "home-file-kind", item.typeLabel || "文档"),
        make("strong", "home-file-name", String(item.name || "未命名附件")));
      card.append(head);
      const meta = [item.meta, item.placeholder ? "仅保留占位信息" : ""].filter(Boolean).join(" · ");
      if (meta) card.append(make("small", "home-file-meta", meta));
      const thumbnail = safeUrl(item.thumbnailUrl);
      if (thumbnail) {
        const image = document.createElement("img");
        image.src = thumbnail;
        image.alt = "";
        image.loading = "lazy";
        image.addEventListener("error", () => image.remove(), { once: true });
        card.append(image);
      }
      const link = safeUrl(item.url);
      if (link) {
        const anchor = make("a", "text-button home-file-open",
          item.kind === "image" ? "查看大图" : "打开预览");
        anchor.href = link;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        card.append(anchor);
      }
      if (item.placeholder && item.reason) {
        card.append(make("p", "home-file-reason", item.reason));
      }
      nodes.filesList.append(card);
    }
    if (nodes.filesEmpty) nodes.filesEmpty.hidden = entries.length > 0;
  }

  function renderFiles() {
    if (nodes.rightPanel) {
      nodes.rightPanel.dataset.conversationId = currentConversationId() || "";
    }
    renderFileCards(Array.isArray(fileEntries) ? fileEntries : []);
    if (nodes.filesSummary) {
      const entry = activeEntry();
      const restored = Number((entry || {}).restoredImages || 0);
      const available = (fileEntries || []).filter((item) => item.available).length;
      nodes.filesSummary.textContent = available
        ? `本对话 ${available} 个文件${restored > available ? ` · 另有 ${restored - available} 张原稿图` : ""}`
        : restored
          ? `本对话已有 ${restored} 张原稿图（来自上次上传）。`
          : "";
    }
  }

  async function loadFiles(conversationId) {
    const id = conversationId || currentConversationId();
    const seq = ++filesSeq;
    if (!id) {
      fileEntries = [];
      filesFor = null;
      renderFiles();
      return;
    }
    try {
      const result = await api(`/api/conversations/${encodeURIComponent(id)}/attachments`);
      // 防异步旧数据覆盖：序号变化或对话已切换时丢弃这次结果。
      if (seq !== filesSeq || id !== currentConversationId()) return;
      fileEntries = (result.attachments || []).map(fileEntry);
      filesFor = id;
    } catch (error) {
      if (seq !== filesSeq || id !== currentConversationId()) return;
      fileEntries = [];
      filesFor = id;
    }
    renderFiles();
    renderBatches();
  }

  // ------------------------------------------------------------------ 集合
  function renderCollections() {
    if (!nodes.collectionsList) return;
    const entries = collections();
    const signature = JSON.stringify([entries.map((item) => [item.id, item.name, item.conversation_count]),
      currentConversationId()]);
    if (signature === collectionsSignature) {
      syncCollectionSelect();
      return;
    }
    collectionsSignature = signature;
    // 集合按手绘图只保留一份：可折叠文件夹与子聊天都在 #conversation-list 里，
    // 这里不再重复列出同一个集合，只保留数量、空状态与“新建集合”控件。
    nodes.collectionsList.replaceChildren();
    if (nodes.collectionsCount) {
      nodes.collectionsCount.textContent = String(entries.length);
      nodes.collectionsCount.hidden = entries.length === 0;
    }
    if (!entries.length) {
      nodes.collectionsList.append(make("p", "home-panel-empty", "还没有集合"));
    }
    nodes.collectionsList.hidden = entries.length > 0;
    syncCollectionSelect();
  }

  function syncCollectionSelect() {
    const select = nodes.collectionSelect;
    if (!select) return;
    const entries = collections();
    const summary = activeSummary();
    const previous = select.value;
    select.replaceChildren();
    const none = make("option", "", "未归入集合");
    none.value = "";
    select.append(none);
    for (const item of entries) {
      const option = make("option", "", String(item.name || "未命名集合"));
      option.value = item.id;
      select.append(option);
    }
    select.disabled = false;
    const wanted = summary ? summary.collection_id || "" : pendingCollection || previous;
    select.value = [...select.options].some((option) => option.value === wanted) ? wanted : "";
  }

  async function createCollection() {
    const name = window.prompt("新建集合的名称（最多 40 字）", "");
    if (name === null) return;
    const trimmed = String(name).trim();
    if (!trimmed) {
      notify("集合名称不能为空。", true, "organize");
      return;
    }
    try {
      await api("/api/collections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (typeof refreshConversations === "function") await refreshConversations();
      notify(`已创建集合「${trimmed}」。`, false, "organize");
    } catch (error) {
      notify(error.message, true, "organize");
    }
  }

  function syncCollectionAssignment() {
    const id = currentConversationId();
    if (!id || !pendingCollection) return;
    const summary = activeSummary();
    if (!summary || summary.collection_id) {
      pendingCollection = "";
      return;
    }
    const wanted = pendingCollection;
    pendingCollection = "";
    if (typeof moveConversationToCollection === "function") {
      void moveConversationToCollection(id, wanted);
    }
  }

  // ------------------------------------------------------------------ 资料批次
  // 这一轮提交的文字里哪些是“资料内容”、哪些只是“把这页入库”这类指令。
  // 只有指令的请求保持等待补资料；随本轮一起提交的题目直接进预览，不让用户重复粘贴。
  const INTAKE_VERBS = "入库|导入|录入|添加|上传|收录|保存|存进题库|存到题库|放进题库|放到题库|预览|整理成题目|整理一下";
  const INTAKE_NOUNS = "学习资料|资料|练习册|试卷|习题册|题目|这些题|这页题|这页|附件|文件";
  const INTAKE_NOUN_PHRASE = `(?:这|那)?\\s*(?:一|1)?\\s*(?:份|页|些|批|本)?\\s*(?:${INTAKE_NOUNS})`;
  const INTAKE_VERB_FIRST = `(?:${INTAKE_VERBS})\\s*(?:${INTAKE_NOUN_PHRASE})?`;
  const INTAKE_NOUN_FIRST =
    `(?:把|将)?\\s*(?:这|那)?\\s*(?:一|1)?\\s*(?:份|页|些|批|本)?\\s*(?:${INTAKE_NOUNS})?\\s*(?:都|全部)?\\s*(?:${INTAKE_VERBS})`;
  const INTAKE_ONLY_LINE = new RegExp(
    `^(?:请|帮我|麻烦|我想|我要)?\\s*(?:${INTAKE_NOUN_FIRST}|${INTAKE_VERB_FIRST})\\s*(?:吧|呢|一下|好吗)?\\s*[。.!！?？]?$`
  );
  const TRAILING_INTAKE = new RegExp(
    `(?:^|(?<=[\\s，,。；;]))(?:请|帮我|麻烦|我){0,3}\\s*(?:${INTAKE_NOUN_FIRST}|${INTAKE_VERB_FIRST})\\s*[。.!！]?$`
  );

  function materialTextFromTurn(text) {
    const raw = String(text || "").trim();
    if (!raw) return "";
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const kept = lines.filter((line) => !INTAKE_ONLY_LINE.test(line));
    let joined = kept.join("\n").trim();
    if (!joined) return "";
    joined = joined.replace(TRAILING_INTAKE, "").trim();
    if (!joined) return "";
    const substance = joined.replace(/\s+/g, "");
    // 太短又没有任何题目特征（数字/公式符号）的句子当作闲聊，不作资料。
    if (substance.length < 6 && !/[=+\-*/^√∑∫×÷$\\]|\d/.test(substance)) return "";
    return joined;
  }

  const BATCH_LABELS = {
    pending: "等待创建预览",
    submitting: "正在提交…",
    queued: "排队中",
    running: "正在整理…",
    ready: "预览可核对",
    imported: "已入库",
    failed: "整理失败",
    cancelled: "已停止",
  };

  // 入库回执：确认成功（题库已写入）后，首页的批次卡要显示可信的新增 / 去重数。
  // 批次在确认后会被资料页移除，所以回执另存一份，刷新或重启后仍能读回。
  function receiptKey(conversationId) {
    return `home-material-import:${conversationId}`;
  }

  function readReceipt(conversationId) {
    if (!conversationId) return null;
    try {
      const raw = window.localStorage && window.localStorage.getItem(receiptKey(conversationId));
      if (!raw) return null;
      const value = JSON.parse(raw);
      return value && typeof value === "object" ? value : null;
    } catch (error) {
      return null;
    }
  }

  function writeReceipt(conversationId, receipt) {
    if (!conversationId) return;
    try {
      if (window.localStorage) window.localStorage.setItem(receiptKey(conversationId), JSON.stringify(receipt));
    } catch (error) {
      /* 本地存储不可用时只保留当前会话内的回执 */
    }
  }

  function clearReceipt(conversationId) {
    if (!conversationId) return;
    try {
      if (window.localStorage) window.localStorage.removeItem(receiptKey(conversationId));
    } catch (error) {
      /* 忽略 */
    }
  }

  function batchOf(conversationId) {
    return conversationId ? batches.get(conversationId) || null : null;
  }

  function setBatch(conversationId, patch) {
    if (!conversationId) return;
    const current = batches.get(conversationId) || { conversationId, attachmentIds: [] };
    const next = { ...current, ...patch, conversationId };
    batches.set(conversationId, next);
    if (conversationId === currentConversationId()) renderBatches();
    return next;
  }

  function renderBatches() {
    const box = nodes.batches;
    if (!box) return;
    const id = currentConversationId();
    const batch = batchOf(id);
    box.replaceChildren();
    if (!batch || !id) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const job = batch.job || null;
    const card = make("section", "home-batch-card");
    card.dataset.batchStatus = batch.status || "pending";
    const head = make("header", "home-batch-head");
    head.append(make("strong", "home-batch-title", "资料批次"),
      make("span", "home-batch-state", BATCH_LABELS[batch.status] || "处理中"));
    card.append(head);
    if (job && job.source) card.append(make("p", "home-batch-note", `来源：${job.source}`));
    if (job && job.status === "ready") {
      card.append(make("p", "home-batch-note",
        `已整理 ${Number(job.count || 0)} 道题，尚未入库；核对来源、题目和答案后再确认。`));
    } else if (batch.status === "imported") {
      const receipt = batch.receipt || {};
      const added = Number(receipt.added || 0);
      const duplicates = Number(receipt.duplicates || 0);
      card.append(make("p", "home-batch-note",
        `已确认入库：新增 ${added} 道题${duplicates ? `，${duplicates} 道相同原题未重复写入` : ""}。可在练习资料里查看。`));
    } else if (batch.status === "pending") {
      card.append(make("p", "home-batch-note",
        batch.materialText
          ? "用这条对话里的附件或本轮提交的文字创建预览；确认前不会写入题库。"
          : "用这条对话里的附件创建预览；如果这轮只说了“入库”，把题目贴进输入框也能直接创建。确认前不会写入题库。"));
    }
    if (batch.error) card.append(make("p", "home-batch-error", batch.error));
    const actions = make("div", "home-batch-actions");
    const addButton = (label, variant, handler, disabled) => {
      const button = make("button", `${variant || "text-button"} home-batch-button`, label);
      button.type = "button";
      button.disabled = Boolean(disabled);
      button.addEventListener("click", () => { void handler(button); });
      actions.append(button);
      return button;
    };
    if (batch.status === "pending") {
      const available = (fileEntries || []).filter((item) => item.available && item.id);
      addButton("从本对话文件创建预览", "button secondary small", async (button) => {
        if (!available.length) {
          notify("这条对话还没有可复用的附件。", true, "organize");
          return;
        }
        button.disabled = true;
        await createBatch(id, { attachmentIds: available.map((item) => item.id) });
      }, !available.length);
      addButton("只用输入框文字创建预览", "button quiet small", async (button) => {
        // 优先用本轮已提交的文字（发送后草稿可能已清空），没有再用输入框里的内容。
        const current = batchOf(id) || {};
        const text = current.materialText || (nodes.draft ? nodes.draft.value.trim() : "");
        if (!text) {
          notify("输入框里还没有文字；请先粘贴或输入题目。", true, "organize");
          return;
        }
        button.disabled = true;
        await createBatch(id, { text });
      }, !((batchOf(id) || {}).materialText || (nodes.draft && nodes.draft.value.trim())));
    }
    if (["submitting", "queued", "running"].includes(batch.status)) {
      addButton("停止", "button quiet small", async () => {
        if (job && job.id) await actOnBatch(id, "cancel");
      }, !job || !job.id);
    }
    if (batch.status === "ready") {
      addButton("打开核对", "button primary small", async () => { openBatch(job && job.id); }, !job || !job.id);
    }
    if (batch.status === "imported") {
      addButton("打开题库", "button secondary small", async () => {
        if (typeof showView === "function") showView("materials");
      });
    }
    if (["failed", "cancelled"].includes(batch.status)) {
      addButton("重试这批", "button secondary small", async () => { await actOnBatch(id, "retry"); }, !job || !job.id);
      addButton("重新创建预览", "text-button", async () => { setBatch(id, { status: "pending", job: null, error: "" }); });
    }
    card.append(actions);
    box.append(card);
  }

  async function createBatch(conversationId, options) {
    const id = conversationId || currentConversationId();
    if (!id) return;
    const attachmentIds = (options && options.attachmentIds) || [];
    const text = (options && options.text) || "";
    clearReceipt(id); // 新批次开始后，上一条“已入库”回执不再代表当前状态。
    setBatch(id, { status: "submitting", attachmentIds, job: null, error: "", conversationId: id });
    try {
      const body = {
        conversation_id: id,
        ...(attachmentIds.length ? { attachment_ids: attachmentIds } : {}),
        ...(text ? { text } : {}),
        ...(options && options.source ? { source: options.source } : {}),
      };
      const result = await api("/api/materials/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setBatch(id, { status: (result.job && result.job.status) || "queued", job: result.job, error: "" });
      schedulePoll(id);
    } catch (error) {
      setBatch(id, { status: "failed", error: error.message });
    }
  }

  function schedulePoll(conversationId) {
    const existing = batchTimers.get(conversationId);
    if (existing) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      batchTimers.delete(conversationId);
      void pollBatch(conversationId);
    }, 1200);
    batchTimers.set(conversationId, timer);
  }

  async function pollBatch(conversationId) {
    const batch = batchOf(conversationId);
    if (!batch || !batch.job || !batch.job.id) return;
    try {
      const result = await api(`/api/materials/jobs/${encodeURIComponent(batch.job.id)}`);
      const job = result.job || {};
      setBatch(conversationId, { status: job.status || batch.status, job, error: job.error || "" });
      if (job.status === "queued" || job.status === "running") schedulePoll(conversationId);
    } catch (error) {
      if (error.status === 404) {
        setBatch(conversationId, { status: "failed", error: "批次已过期，请重新创建预览。" });
      } else {
        schedulePoll(conversationId);
      }
    }
  }

  async function actOnBatch(conversationId, action) {
    const batch = batchOf(conversationId);
    if (!batch || !batch.job || !batch.job.id) return;
    try {
      const result = await api(`/api/materials/jobs/${encodeURIComponent(batch.job.id)}/${action}`, { method: "POST" });
      const job = result.job || batch.job;
      setBatch(conversationId, { status: job.status || batch.status, job, error: job.error || "" });
      if (job.status === "queued" || job.status === "running") schedulePoll(conversationId);
    } catch (error) {
      setBatch(conversationId, { error: error.message });
    }
  }

  async function loadBatches(conversationId) {
    const id = conversationId || currentConversationId();
    if (!id) return;
    try {
      const result = await api(`/api/materials/jobs?conversation_id=${encodeURIComponent(id)}`);
      const job = (result.jobs || [])[0];
      if (!job) {
        // 确认入库后资料页会移除该批次；这时按本地保存的回执显示「已入库」，
        // 不再保留旧的 ready 卡片（否则会误显示“尚未入库”）。
        const receipt = readReceipt(id);
        if (receipt && !(batchOf(id) && batchOf(id).job)) {
          setBatch(id, { status: "imported", receipt, job: null, error: "", attachmentIds: [] });
        }
        return;
      }
      if (batches.has(id) && job.id !== (batchOf(id).job || {}).id) return;
      setBatch(id, {
        status: job.status || "queued",
        job,
        error: job.error || "",
        attachmentIds: job.attachment_ids || [],
      });
      if (job.status === "queued" || job.status === "running") schedulePoll(id);
    } catch (error) {
      /* 批次列表暂不可用时不虚构状态；卡片保持空白。 */
    }
  }

  // 资料页确认入库成功后，把当前对话的卡片换成可信回执（新增 / 去重数）。
  function onMaterialImported(detail) {
    const info = detail || {};
    const jobId = info.jobId || "";
    let conversationId = null;
    for (const [id, batch] of batches.entries()) {
      if (jobId && batch.job && batch.job.id === jobId) {
        conversationId = id;
        break;
      }
    }
    if (!conversationId) conversationId = currentConversationId();
    if (!conversationId) return;
    const receipt = {
      jobId,
      source: info.source || "",
      added: Number(info.added || 0),
      duplicates: Number(info.duplicates || 0),
      at: new Date().toISOString(),
    };
    setBatch(conversationId, { status: "imported", receipt, job: null, error: "" });
    writeReceipt(conversationId, receipt);
  }

  function openBatch(jobId) {
    if (!jobId) return;
    if (typeof showView === "function") showView("materials");
    if (typeof openMaterialJob === "function") void openMaterialJob(jobId, true);
  }

  // 统一入口返回的资料入库约定：先放卡片，本对话已有附件时直接发起批次（不再让用户重传）。
  function handleUnifiedIntake(intake, conversationId, text) {
    if (!intake) return;
    const id = conversationId || currentConversationId();
    if (!id) return;
    const prepare = intake.prepare || {};
    const payload = prepare.json || {};
    const attachmentIds = Array.isArray(payload.attachment_ids) ? payload.attachment_ids.slice() : [];
    if (typeof panels === "object" && panels && panels.getState().right.open) void loadFiles(id);
    // 本轮随消息一起提交的题目文字直接建预览；纯“把这页入库”这类指令不当作题目。
    const materialText = attachmentIds.length ? "" : materialTextFromTurn(text);
    setBatch(id, {
      status: "pending",
      attachmentIds,
      job: null,
      error: "",
      conversationId: id,
      materialText,
    });
    if (attachmentIds.length) {
      void createBatch(id, { attachmentIds });
    } else if (materialText) {
      void createBatch(id, { text: materialText });
    } else if (filesFor !== id) {
      void loadFiles(id);
    }
  }

  // ------------------------------------------------------------------ 会话切换 / 标题
  function updateChatHeader() {
    let title = "新对话";
    const active = activeSummary();
    if (active && active.title) title = active.title;
    if (nodes.chatTitle) nodes.chatTitle.textContent = title;
    if (nodes.chatMeta) {
      const count = typeof state !== "undefined" && state.chats && state.chats.organize
        ? state.chats.organize.length
        : 0;
      const entry = activeEntry();
      const batch = batchOf(currentConversationId());
      const parts = [];
      if (entry && entry.busy) parts.push("正在处理");
      else if (count) parts.push(`${count} 条消息`);
      if (batch && ["submitting", "queued", "running"].includes(batch.status)) parts.push("资料整理中");
      else if (batch && batch.status === "ready") parts.push("资料待核对");
      nodes.chatMeta.textContent = parts.join(" · ");
    }
  }

  function syncEmptyState() {
    if (!nodes.root || !nodes.messages) return;
    nodes.root.dataset.homeEmpty = nodes.messages.querySelector(".message") ? "false" : "true";
    updateChatHeader();
  }

  function syncConversation() {
    const id = currentConversationId();
    if (id !== lastConversationId) {
      lastConversationId = id;
      // 附件与批次必须跟随对话：切换后先清空，再按新对话重新取数。
      fileEntries = [];
      filesFor = null;
      filesSeq += 1;
      if (panels) panels.collapseFiles();
      renderFiles();
      if (id) {
        void loadFiles(id);
        void loadBatches(id);
      }
    }
    syncCollectionAssignment();
    renderCollections();
    renderBatches();
    updateChatHeader();
    syncEmptyState();
  }

  function scheduleConversationSync() {
    if (scheduled) return;
    scheduled = true;
    Promise.resolve().then(() => {
      scheduled = false;
      syncConversation();
    });
  }

  function closeLeftDrawer() {
    if (!panels || !nodes.leftButton) return;
    const state = panels.getState();
    if (state.layout === "narrow" && state.left.open) nodes.leftButton.click();
  }

  // ------------------------------------------------------------------ 发送
  function hasPendingFiles() {
    return typeof intake !== "undefined" && intake
      ? intake.queue.some((item) => !item.read)
      : false;
  }

  function useFollowupRoute() {
    const messages = typeof state !== "undefined" && state.chats && state.chats.organize;
    return Boolean(messages && messages.length) && !hasPendingFiles();
  }

  function clearDraftAfterSend() {
    if (!nodes.draft) return;
    nodes.draft.value = "";
    try {
      nodes.draft.setSelectionRange(0, 0);
    } catch (error) {
      /* 部分输入类型不支持 setSelectionRange */
    }
    if (typeof updateDraft === "function") updateDraft();
  }

  function sendDraftAsFollowup() {
    if (!nodes.draft || !nodes.follow) return;
    const text = nodes.draft.value;
    if (!text.trim()) return;
    if (typeof submitQueuedDraft !== "function") return;
    // 后续对话仍复用既有排队、取消、重试与按对话路由；这里只借用隐藏的 follow 输入框。
    nodes.follow.value = text;
    submitQueuedDraft("organize");
    const accepted = nodes.follow.value === "";
    if (!accepted) nodes.follow.value = "";
    if (accepted) {
      clearDraftAfterSend();
      if (typeof focusDraftEditor === "function") focusDraftEditor();
    }
  }

  function openMaterialLibrary() {
    if (typeof setMaterialStage === "function") {
      try {
        setMaterialStage("library");
      } catch (error) {
        /* 资料脚本未就绪时保持默认 */
      }
    }
    const area = $("#materials-import-area");
    if (area) area.hidden = true;
  }

  // ------------------------------------------------------------------ 初始化
  function init() {
    if (!nodes.root || !nodes.nav || !nodes.leftPanel || !nodes.rightPanel ||
        !nodes.leftHandle || !nodes.rightHandle || !nodes.leftButton ||
        !nodes.rightButton || !window.homePanels) {
      return;
    }
    try {
      panels = window.homePanels.create({
        root: nodes.root,
        nav: nodes.nav,
        leftPanel: nodes.leftPanel,
        rightPanel: nodes.rightPanel,
        leftHandle: nodes.leftHandle,
        rightHandle: nodes.rightHandle,
        leftButton: nodes.leftButton,
        rightButton: nodes.rightButton,
        leftOpen: true,
        rightOpen: false,
      });
    } catch (error) {
      if (window.console) window.console.error("首页面板初始化失败：", error);
      return;
    }

    // 品牌入口与顶部工具条保持原页面语义；进入主页时文件面板回到收起状态。
    document.querySelectorAll(".home-history-brand").forEach((brand) => {
      brand.addEventListener("click", () => {
        if (panels) panels.collapseFiles();
        closeLeftDrawer();
      });
    });

    if (nodes.attach && nodes.fileInput) {
      nodes.attach.addEventListener("click", () => nodes.fileInput.click());
    }

    if (nodes.draft) {
      nodes.draft.addEventListener("keydown", (event) => {
        if (event.isComposing) return;
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
          event.preventDefault();
          if (nodes.submit && !nodes.submit.disabled) nodes.submit.click();
        }
      });
    }

    if (nodes.submit) {
      // 有历史消息且没有新附件时，把同一 #draft 的后续问题交给现有对话队列；
      // 首轮 / 带新文件时仍走原来的整理与附件准备流程。
      nodes.submit.addEventListener("click", (event) => {
        if (!useFollowupRoute()) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        sendDraftAsFollowup();
      }, true);
    }

    const closeFiles = $("#home-files-close");
    if (closeFiles && panels) {
      closeFiles.addEventListener("click", () => panels.collapseFiles());
    }
    const closeHistory = $("#home-history-close");
    if (closeHistory && nodes.leftButton) {
      closeHistory.addEventListener("click", () => nodes.leftButton.click());
    }

    // 窄屏抽屉一次只铺开一侧，避免左右抽屉相互遮盖；宽屏仍保持两侧独立。
    nodes.leftButton.addEventListener("click", () => {
      if (!panels || panels.getState().layout !== "narrow") return;
      if (panels.getState().right.open) panels.collapseFiles();
    }, true);
    nodes.rightButton.addEventListener("click", () => {
      if (!panels) return;
      if (panels.getState().layout === "narrow" && panels.getState().left.open) nodes.leftButton.click();
      // 打开文件面板时按当前对话重取一次，保证切换 / 重启后归属正确。
      void loadFiles(currentConversationId());
    }, true);

    const conversationList = $("#conversation-list");
    if (conversationList) {
      conversationList.addEventListener("click", (event) => {
        const open = event.target.closest && event.target.closest(".conversation-open");
        if (open) {
          if (panels) panels.collapseFiles();
          closeLeftDrawer();
        }
      }, true);
      if (window.MutationObserver) {
        listObserver = new MutationObserver(scheduleConversationSync);
        listObserver.observe(conversationList, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["class", "data-conversation-id"],
        });
      }
    }

    const newChat = $("#new-conversation");
    if (newChat) {
      newChat.addEventListener("click", () => {
        if (panels) panels.collapseFiles();
        closeLeftDrawer();
      }, true);
    }

    if (nodes.messages && window.MutationObserver) {
      emptyObserver = new MutationObserver(() => {
        syncEmptyState();
        // 一轮结束后资料附件可能变化：右侧面板打开时顺手刷新。
        if (panels && panels.getState().right.open) void loadFiles(currentConversationId());
      });
      emptyObserver.observe(nodes.messages, { childList: true, subtree: true });
    }
    const restoredHint = $("#intake-restored-hint");
    if (restoredHint && window.MutationObserver) {
      hintObserver = new MutationObserver(() => {
        renderFiles();
        if (panels && panels.getState().right.open) void loadFiles(currentConversationId());
      });
      hintObserver.observe(restoredHint, {
        childList: true,
        attributes: true,
        attributeFilter: ["hidden"],
      });
    }

    document.querySelectorAll(".nav-item").forEach((button) => {
      button.addEventListener("click", () => {
        if (panels) panels.collapseFiles();
        if (button.dataset.view !== "organize") closeLeftDrawer();
        if (button.dataset.view === "materials") {
          window.setTimeout(openMaterialLibrary, 0);
        }
      });
    });

    window.addEventListener("hashchange", () => {
      if (location.hash === "#materials") window.setTimeout(openMaterialLibrary, 0);
      if (location.hash === "#organize" && panels) panels.collapseFiles();
    });

    if (nodes.newCollection) nodes.newCollection.addEventListener("click", () => void createCollection());
    window.addEventListener("home-material-imported", (event) => onMaterialImported(event.detail));
    if (nodes.collectionSelect) {
      nodes.collectionSelect.addEventListener("change", () => {
        const id = currentConversationId();
        const value = nodes.collectionSelect.value;
        if (!id) {
          pendingCollection = value;
          return;
        }
        if (typeof moveConversationToCollection === "function") void moveConversationToCollection(id, value);
      });
    }

    // 只绑定 #source-panel 里真正可见的对话模型下拉；隐藏的 #organize-follow-form 里
    // chat-composer.js 也会追加同标识的 select，用 document.querySelector 会绑错。
    const modelSelect = document.querySelector('#source-panel [data-chat-model="organize"]');
    if (modelSelect && typeof changeChatModel === "function") {
      modelSelect.addEventListener("change", () => changeChatModel(modelSelect));
    }
    if (typeof syncChatModels === "function" && typeof state !== "undefined") {
      syncChatModels(state.chatModel);
    }

    syncEmptyState();
    renderCollections();
    renderFiles();
    renderBatches();
    syncConversation();
    if (location.hash === "#materials") window.setTimeout(openMaterialLibrary, 0);

    window.addEventListener("pagehide", (event) => {
      // 进入往返缓存（bfcache）时页面还会回来，不能销毁；真正离开时再清理。
      if (event.persisted) return;
      if (panels) panels.destroy();
    });

    window.homeUnifiedIntake = handleUnifiedIntake;
    window.homeUi = {
      panels,
      renderFiles: function (entries) {
        fileEntries = Array.isArray(entries) ? entries.slice() : [];
        filesFor = currentConversationId();
        renderFiles();
      },
      renderCollections: function () {
        collectionsSignature = "";
        renderCollections();
      },
      refreshData: function () {
        collectionsSignature = "";
        renderCollections();
        renderBatches();
      },
      refreshFiles: function () {
        return loadFiles(currentConversationId());
      },
      refreshBatches: function () {
        return loadBatches(currentConversationId());
      },
      refreshConversation: syncConversation,
      destroy: function () {
        if (emptyObserver) emptyObserver.disconnect();
        if (listObserver) listObserver.disconnect();
        if (hintObserver) hintObserver.disconnect();
        emptyObserver = listObserver = hintObserver = null;
        for (const timer of batchTimers.values()) window.clearTimeout(timer);
        batchTimers.clear();
        if (panels) panels.destroy();
      },
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
