/* 矩阵 / 行列式插入面板
   入口由数学符号键盘的「矩阵」「行列式」两个相邻键分别打开，标题随类型变化。
   面板内分「手动输入」和「交给 AI 生成」两种模式，默认手动，同一时刻只显示一个内容区：
   1) 手动矩阵：行数 × 列数，并用随尺寸更新的圆括号矩阵预览；
   2) 手动行列式：只给一个「阶数」，生成该阶方阵的竖线预览；
   3) AI 模式：一句话描述交给后端模型转 LaTeX（未配置模型时只禁用 AI 区，手动仍可用）。
   插入仍走 math-keyboard.js 的两条既有路径：
   文字视图插带 $0 占位符的文本，渲染视图插 MathLive 模板（#@ 是首个占位符）。
   约束：CSP script-src 'self'，本文件不 eval、不加载外部资源。 */
(function () {
  "use strict";

  const ENV_BY_KIND = { matrix: "pmatrix", determinant: "vmatrix" };
  const KIND_LABEL = { matrix: "矩阵", determinant: "行列式" };
  const MAX_SIZE = 6;
  const MIN_SIZE = 1;
  const DEFAULT_SIZE = 2;
  // 模型调用可能卡住（网络、服务端排队）。超时就主动中断，
  // 否则按钮会永远停在「正在生成…」，用户只能刷新页面。
  const AI_TIMEOUT_MS = 25000;
  const NO_CONFIG_STATUS = "自然语言生成需要模型，未配置时不可用";

  let panel = null;
  let nodes = null;

  const state = {
    kind: "matrix",
    mode: "manual",
    configured: null,
    busy: false,
    pendingLatex: "",
    onInsert: null,
    onClose: null,
    openToken: 0,
    requestToken: 0,
    controller: null
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /* ---------- LaTeX 生成 ---------- */

  // caret：文字视图传 "$0"，渲染视图传 "#@"，落在第一个格子。
  // fill：其余格子的占位符。渲染视图必须传 "#?"——MathLive 里空单元格宽度为 0，
  // 不填占位符时整张表只会显示一个格子，用户没法点进其他位置。
  function buildLatex(rows, cols, kind, caret, fill) {
    const environment = ENV_BY_KIND[kind] || ENV_BY_KIND.matrix;
    const blank = fill == null ? "" : fill;
    const lines = [];
    for (let r = 0; r < rows; r += 1) {
      const cells = [];
      for (let c = 0; c < cols; c += 1) {
        cells.push(r === 0 && c === 0 ? caret : blank);
      }
      lines.push(cells.join("&"));
    }
    return "\\begin{" + environment + "}" + lines.join("\\\\") + "\\end{" + environment + "}";
  }

  // 手动预览用 \square 占位，尺寸一变就重新生成整张矩阵。
  function buildPreview(rows, cols, kind) {
    return buildLatex(rows, cols, kind, "\\square", "\\square");
  }

  function clampSize(value, fallback) {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number)) return fallback == null ? DEFAULT_SIZE : fallback;
    return Math.min(MAX_SIZE, Math.max(MIN_SIZE, number));
  }

  function readSize(input, fallback) {
    return clampSize(input ? input.value : "", fallback);
  }

  function normalizeSizeInput(input, fallback) {
    if (!input) return;
    input.value = String(readSize(input, fallback));
  }

  /* ---------- 面板构建 ---------- */

  function build() {
    const backdrop = el("div", "fmx-backdrop");
    backdrop.hidden = true;

    const dialog = el("div", "fmx-panel");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "fmx-title");

    const head = el("div", "fmx-head");
    const title = el("strong", "fmx-title", "插入矩阵");
    title.id = "fmx-title";
    const close = el("button", "fmx-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "关闭");
    head.append(title, close);

    const body = el("div", "fmx-body");

    /* 标题下：手动 / AI 二选一 */
    const modeRow = el("div", "fmx-seg fmx-mode");
    modeRow.setAttribute("role", "tablist");
    modeRow.setAttribute("aria-label", "输入方式");
    const manualButton = el("button", "fmx-seg-button active", "手动输入");
    manualButton.type = "button";
    manualButton.dataset.fmxMode = "manual";
    manualButton.setAttribute("role", "tab");
    manualButton.setAttribute("aria-selected", "true");
    const aiButtonTab = el("button", "fmx-seg-button", "交给 AI 生成");
    aiButtonTab.type = "button";
    aiButtonTab.dataset.fmxMode = "ai";
    aiButtonTab.setAttribute("role", "tab");
    aiButtonTab.setAttribute("aria-selected", "false");
    modeRow.append(manualButton, aiButtonTab);

    /* 手动区 */
    const manualContent = el("div", "fmx-content");
    manualContent.dataset.fmxContent = "manual";
    manualContent.setAttribute("role", "tabpanel");

    const sizeSection = el("div", "fmx-section");
    const sizeLabel = el("div", "fmx-label", "行数 × 列数");
    sizeSection.append(sizeLabel);

    const matrixSize = el("div", "fmx-size");
    const rowsLabel = el("label", "fmx-number");
    rowsLabel.append(document.createTextNode("行数"));
    const rowsInput = document.createElement("input");
    rowsInput.type = "number";
    rowsInput.id = "fmx-rows";
    rowsInput.min = String(MIN_SIZE);
    rowsInput.max = String(MAX_SIZE);
    rowsInput.value = String(DEFAULT_SIZE);
    rowsInput.inputMode = "numeric";
    rowsInput.setAttribute("aria-label", "行数");
    rowsLabel.append(rowsInput);
    const times = el("span", "fmx-times", "×");
    const colsLabel = el("label", "fmx-number");
    colsLabel.append(document.createTextNode("列数"));
    const colsInput = document.createElement("input");
    colsInput.type = "number";
    colsInput.id = "fmx-cols";
    colsInput.min = String(MIN_SIZE);
    colsInput.max = String(MAX_SIZE);
    colsInput.value = String(DEFAULT_SIZE);
    colsInput.inputMode = "numeric";
    colsInput.setAttribute("aria-label", "列数");
    colsLabel.append(colsInput);
    matrixSize.append(rowsLabel, times, colsLabel);

    const determinantSize = el("div", "fmx-size");
    determinantSize.hidden = true;
    const orderLabel = el("label", "fmx-number");
    orderLabel.append(document.createTextNode("阶数"));
    const orderInput = document.createElement("input");
    orderInput.type = "number";
    orderInput.id = "fmx-order";
    orderInput.min = String(MIN_SIZE);
    orderInput.max = String(MAX_SIZE);
    orderInput.value = String(DEFAULT_SIZE);
    orderInput.inputMode = "numeric";
    orderInput.setAttribute("aria-label", "阶数");
    orderLabel.append(orderInput);
    determinantSize.append(orderLabel);

    sizeSection.append(matrixSize, determinantSize);

    const previewLabel = el("div", "fmx-label", "预览");
    const manualPreview = el("div", "fmx-preview fmx-manual-preview");
    manualPreview.setAttribute("role", "img");
    manualPreview.setAttribute("aria-label", "矩阵预览");

    const manualActions = el("div", "fmx-actions");
    const buildButton = el("button", "fmx-primary", "生成并插入");
    buildButton.type = "button";
    manualActions.append(buildButton);

    manualContent.append(sizeSection, previewLabel, manualPreview, manualActions);

    /* AI 区 */
    const aiContent = el("div", "fmx-content");
    aiContent.dataset.fmxContent = "ai";
    aiContent.setAttribute("role", "tabpanel");
    aiContent.hidden = true;

    const aiLabel = el("div", "fmx-label", "用一句话描述矩阵");
    aiLabel.id = "fmx-ai-label";
    const textarea = document.createElement("textarea");
    textarea.className = "fmx-textarea";
    textarea.rows = 2;
    textarea.maxLength = 300;
    textarea.placeholder = "例如：一个 2 行 3 列的矩阵，第一行是 1、2、3，第二行是 4、5、6";
    textarea.disabled = true;
    textarea.setAttribute("aria-labelledby", "fmx-ai-label");

    const aiRow = el("div", "fmx-row");
    const aiButton = el("button", "fmx-primary", "生成");
    aiButton.type = "button";
    aiButton.disabled = true;
    const aiHint = el("span", "fmx-status", "");
    aiHint.setAttribute("role", "status");
    aiRow.append(aiButton, aiHint);

    const preview = el("div", "fmx-preview");
    preview.hidden = true;

    const actions = el("div", "fmx-actions");
    actions.hidden = true;
    const insertButton = el("button", "fmx-primary", "插入");
    insertButton.type = "button";
    const retryButton = el("button", "fmx-ghost", "再生成一次");
    retryButton.type = "button";
    retryButton.disabled = true;
    actions.append(insertButton, retryButton);

    aiContent.append(aiLabel, textarea, aiRow, preview, actions);

    body.append(modeRow, manualContent, aiContent);
    dialog.append(head, body);
    backdrop.append(dialog);
    document.body.append(backdrop);

    nodes = {
      backdrop, dialog, title, close, manualButton, aiButtonTab,
      manualContent, aiContent, sizeLabel, matrixSize, determinantSize,
      rowsInput, colsInput, orderInput, manualPreview, buildButton,
      aiLabel, textarea, aiButton, aiHint, preview, actions, insertButton, retryButton
    };

    /* 事件 */
    close.addEventListener("click", closePanel);
    backdrop.addEventListener("mousedown", function (event) {
      if (event.target === backdrop) closePanel();
    });
    dialog.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        event.stopPropagation();
        closePanel();
      }
    });
    manualButton.addEventListener("click", function () {
      setMode("manual");
    });
    aiButtonTab.addEventListener("click", function () {
      setMode("ai");
    });
    buildButton.addEventListener("click", insertManual);
    [rowsInput, colsInput, orderInput].forEach(function (input) {
      input.addEventListener("input", updateManualPreview);
      input.addEventListener("change", function () {
        normalizeSizeInput(input, DEFAULT_SIZE);
        updateManualPreview();
      });
    });
    aiButton.addEventListener("click", requestModel);
    retryButton.addEventListener("click", requestModel);
    insertButton.addEventListener("click", insertPending);

    updateManualPreview();
    return backdrop;
  }

  /* ---------- 手动输入 ---------- */

  function updateManualPreview() {
    if (!nodes) return;
    const rows = state.kind === "determinant" ? readSize(nodes.orderInput, DEFAULT_SIZE) : readSize(nodes.rowsInput, DEFAULT_SIZE);
    const cols = state.kind === "determinant" ? rows : readSize(nodes.colsInput, DEFAULT_SIZE);
    renderPreview(nodes.manualPreview, buildPreview(rows, cols, state.kind));
    nodes.manualPreview.setAttribute(
      "aria-label",
      state.kind === "determinant" ? rows + " 阶行列式预览" : rows + " 行 " + cols + " 列矩阵预览"
    );
  }

  function insertManual() {
    if (!nodes || state.busy) return;
    normalizeSizeInput(nodes.rowsInput, DEFAULT_SIZE);
    normalizeSizeInput(nodes.colsInput, DEFAULT_SIZE);
    normalizeSizeInput(nodes.orderInput, DEFAULT_SIZE);
    const rows = state.kind === "determinant" ? readSize(nodes.orderInput, DEFAULT_SIZE) : readSize(nodes.rowsInput, DEFAULT_SIZE);
    const cols = state.kind === "determinant" ? rows : readSize(nodes.colsInput, DEFAULT_SIZE);
    apply({
      text: buildLatex(rows, cols, state.kind, "$0", ""),
      template: buildLatex(rows, cols, state.kind, "#@", "#?")
    });
  }

  /* ---------- 模式 / 类型 ---------- */

  function updateModeUi() {
    if (!nodes) return;
    const manual = state.mode !== "ai";
    nodes.manualButton.classList.toggle("active", manual);
    nodes.aiButtonTab.classList.toggle("active", !manual);
    nodes.manualButton.setAttribute("aria-selected", manual ? "true" : "false");
    nodes.aiButtonTab.setAttribute("aria-selected", manual ? "false" : "true");
    nodes.manualContent.hidden = !manual;
    nodes.aiContent.hidden = manual;
  }

  function setMode(mode) {
    const next = mode === "ai" ? "ai" : "manual";
    if (next === state.mode) {
      updateModeUi();
      return;
    }
    if (state.mode === "ai") cancelRequest();
    state.mode = next;
    resetPreview();
    setStatus("");
    // /api/status 可能已经先返回 false，此时告警是在手动区隐藏状态下设置的；
    // 切到 AI 不能把它擦掉，否则只剩禁用输入框。数据晚到时仍由 loadConfigState 补。
    if (next === "ai" && state.configured === false) setStatus(NO_CONFIG_STATUS, true);
    updateModeUi();
    if (next === "manual") updateManualPreview();
  }

  function setKind(kind) {
    state.kind = ENV_BY_KIND[kind] ? kind : "matrix";
    if (!nodes) return;
    const label = KIND_LABEL[state.kind];
    nodes.title.textContent = "插入" + label;
    nodes.dialog.setAttribute("aria-label", "插入" + label);
    nodes.sizeLabel.textContent = "行数 × 列数";
    nodes.sizeLabel.hidden = state.kind !== "matrix";
    nodes.matrixSize.hidden = state.kind !== "matrix";
    nodes.determinantSize.hidden = state.kind !== "determinant";
    nodes.aiLabel.textContent = "用一句话描述" + label;
    nodes.textarea.placeholder =
      state.kind === "matrix"
        ? "例如：一个 2 行 3 列的矩阵，第一行是 1、2、3，第二行是 4、5、6"
        : "例如：一个 3 阶行列式，主对角线全为 1，其余位置全为 0";
    updateManualPreview();
  }

  /* ---------- 预览 / 状态 ---------- */

  function renderPreview(node, latex) {
    if (!node) return;
    node.replaceChildren();
    if (window.katex && typeof window.katex.render === "function") {
      try {
        window.katex.render(latex, node, { throwOnError: false, displayMode: true });
        return;
      } catch (error) {
        /* 渲染失败时退回源码 */
      }
    }
    node.textContent = latex;
  }

  function setStatus(message, isError) {
    if (!nodes) return;
    nodes.aiHint.textContent = message || "";
    nodes.aiHint.classList.toggle("is-error", Boolean(isError));
  }

  function aiEnabled() {
    return state.configured === true && !state.busy;
  }

  function setBusy(value) {
    state.busy = value;
    if (!nodes) return;
    nodes.aiButton.disabled = !aiEnabled();
    nodes.retryButton.disabled = !aiEnabled();
    nodes.insertButton.disabled = value;
    if (value) setStatus("正在生成…");
  }

  function resetPreview() {
    state.pendingLatex = "";
    if (!nodes) return;
    nodes.preview.hidden = true;
    nodes.preview.replaceChildren();
    nodes.actions.hidden = true;
    nodes.insertButton.disabled = true;
  }

  function showPreview(latex) {
    if (!nodes) return;
    renderPreview(nodes.preview, latex);
    nodes.preview.hidden = false;
    nodes.actions.hidden = false;
    nodes.insertButton.disabled = false;
  }

  /* ---------- 模型生成 ---------- */

  function cancelRequest() {
    state.requestToken += 1;
    if (state.controller) {
      try {
        state.controller.abort();
      } catch (error) {
        /* 忽略 */
      }
      state.controller = null;
    }
    state.busy = false;
    if (nodes) {
      nodes.aiButton.disabled = !aiEnabled();
      nodes.retryButton.disabled = true;
      nodes.insertButton.disabled = true;
    }
  }

  async function requestModel() {
    if (!nodes || state.busy || state.mode !== "ai" || !aiEnabled()) return;
    const description = nodes.textarea.value.trim();
    if (!description) {
      setStatus("请先写一句描述", true);
      return;
    }
    resetPreview();
    const kind = state.kind;
    const openToken = state.openToken;
    const token = state.requestToken + 1;
    state.requestToken = token;
    const controller = new AbortController();
    state.controller = controller;
    let timedOut = false;
    const timer = window.setTimeout(function () {
      timedOut = true;
      try {
        controller.abort();
      } catch (error) {
        /* 忽略 */
      }
    }, AI_TIMEOUT_MS);
    setBusy(true);
    try {
      const response = await fetch("/api/formula/matrix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: description, kind: kind }),
        signal: controller.signal
      });
      const data = await response.json().catch(function () {
        return {};
      });
      if (token !== state.requestToken || openToken !== state.openToken || panel.hidden || state.mode !== "ai" || state.kind !== kind) return;
      if (!response.ok || !data.ok) {
        throw new Error(data.error || "生成失败，请稍后重试。");
      }
      state.pendingLatex = data.latex;
      showPreview(data.latex);
      setStatus("已生成，确认后点插入");
    } catch (error) {
      if (token !== state.requestToken || openToken !== state.openToken || panel.hidden || state.mode !== "ai" || state.kind !== kind) return;
      if (error && error.name === "AbortError") {
        if (timedOut) setStatus("生成超时（25 秒），请重试。", true);
        return;
      }
      setStatus(error.message || "生成失败，请稍后重试。", true);
    } finally {
      window.clearTimeout(timer);
      if (token === state.requestToken) {
        state.controller = null;
        setBusy(false);
      }
    }
  }

  /* ---------- 配置状态 ---------- */

  // 每次打开都重新问一次 /api/status：用户可能刚在「模型设置」里存好 Key，
  // 面板不能因为第一次读到「未配置」就永久锁死（之前的缓存版就是这么坏的）。
  async function loadConfigState() {
    const token = state.openToken;
    let configured = false;
    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      const data = await response.json();
      configured = Boolean(data && data.configured);
    } catch (error) {
      configured = false;
    }
    // 面板已关闭或已重新打开时，丢弃上一轮的配置结果。
    if (token !== state.openToken || !panel || panel.hidden) return;
    state.configured = configured;
    if (nodes) {
      nodes.textarea.disabled = !configured;
      nodes.aiButton.disabled = !configured || state.busy;
      nodes.retryButton.disabled = !configured || state.busy;
      if (configured) {
        if (nodes.aiHint.classList.contains("is-error")) setStatus("");
      } else {
        nodes.textarea.placeholder = "未配置模型：请先在右上角「模型设置」保存 API Key";
        setStatus(NO_CONFIG_STATUS, true);
      }
    }
  }

  /* ---------- 打开 / 关闭 ---------- */

  function apply(payload) {
    if (typeof state.onInsert !== "function" || !payload) return;
    state.onInsert({
      kind: state.kind,
      text: payload.text,
      template: payload.template
    });
    closePanel();
  }

  function insertPending() {
    if (!state.pendingLatex || state.busy) return;
    apply({ text: state.pendingLatex, template: state.pendingLatex });
  }

  function onKeydown(event) {
    if (event.key === "Escape") closePanel();
  }

  function open(options) {
    if (!panel) panel = build();
    state.openToken += 1;
    const token = state.openToken;
    state.onInsert = options && options.onInsert;
    state.onClose = (options && options.onClose) || null;
    state.configured = null;
    cancelRequest();
    setKind((options && options.kind) || "matrix");
    setMode("manual");
    resetPreview();
    setStatus("");
    panel.hidden = false;
    document.addEventListener("keydown", onKeydown);
    loadConfigState();
    window.setTimeout(function () {
      // 30ms 内就取消时，这个定时器不能再把焦点抢回已隐藏的面板。
      if (panel.hidden || token !== state.openToken) return;
      const target = state.kind === "determinant" ? nodes.orderInput : nodes.rowsInput;
      target.focus({ preventScroll: true });
      target.select();
    }, 30);
  }

  function closePanel() {
    if (!panel) return;
    state.openToken += 1;
    cancelRequest();
    panel.hidden = true;
    document.removeEventListener("keydown", onKeydown);
    const onClose = state.onClose;
    state.onInsert = null;
    state.onClose = null;
    if (typeof onClose === "function") onClose();
  }

  window.formulaMatrix = {
    open: open,
    close: closePanel,
    buildLatex: buildLatex,
    buildPreview: buildPreview
  };
})();
