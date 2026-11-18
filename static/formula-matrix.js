/* 矩阵 / 行列式插入面板
   两条路径：
   1) 有限矩阵：给行数和列数，直接生成对应大小的模板，光标落在第一个元素；
   2) 规律矩阵：一句话描述交给后端模型转 LaTeX（未配置模型时整块禁用）。
   插入仍走 math-keyboard.js 的两条既有路径：
   文字模式插带 $0 占位符的文本，公式模式插 MathLive 模板（#@ 是首个占位符）。
   约束：CSP script-src 'self'，本文件不 eval、不加载外部资源。 */
(function () {
  "use strict";

  const ENV_BY_KIND = { matrix: "pmatrix", determinant: "vmatrix" };
  const KIND_LABEL = { matrix: "矩阵", determinant: "行列式" };
  const MAX_SIZE = 6;
  const MIN_SIZE = 1;
  // 模型调用可能卡住（网络、服务端排队）。超时就主动中断，
  // 否则按钮会永远停在「正在生成…」，用户只能刷新页面。
  const AI_TIMEOUT_MS = 25000;

  let panel = null;
  let nodes = null;

  const state = {
    kind: "matrix",
    rows: 2,
    cols: 2,
    configured: null,
    busy: false,
    pendingLatex: "",
    onInsert: null,
    onClose: null
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /* ---------- LaTeX 生成 ---------- */

  // caret：文字模式传 "$0"，公式模式传 "#@"，落在第一个格子。
  // fill：其余格子的占位符。公式模式必须传 "#?"——MathLive 里空单元格宽度为 0，
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

  function clampSize(value) {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number)) return 2;
    return Math.min(MAX_SIZE, Math.max(MIN_SIZE, number));
  }

  /* ---------- 面板构建 ---------- */

  function build() {
    const backdrop = el("div", "fmx-backdrop");
    backdrop.hidden = true;

    const dialog = el("div", "fmx-panel");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "插入矩阵或行列式");

    const head = el("div", "fmx-head");
    head.append(el("strong", "fmx-title", "插入矩阵 / 行列式"));
    const close = el("button", "fmx-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "关闭");
    head.append(close);

    const body = el("div", "fmx-body");

    /* 类型 */
    const kindRow = el("div", "fmx-section");
    kindRow.append(el("div", "fmx-label", "类型"));
    const seg = el("div", "fmx-seg");
    const matrixButton = el("button", "fmx-seg-button active", "矩阵");
    matrixButton.type = "button";
    matrixButton.dataset.kind = "matrix";
    const determinantButton = el("button", "fmx-seg-button", "行列式");
    determinantButton.type = "button";
    determinantButton.dataset.kind = "determinant";
    seg.append(matrixButton, determinantButton);
    kindRow.append(seg);

    /* 行列数 */
    const sizeRow = el("div", "fmx-section");
    sizeRow.append(el("div", "fmx-label", "行列数"));
    const sizeBox = el("div", "fmx-size");
    const rowsInput = document.createElement("input");
    rowsInput.type = "number";
    rowsInput.min = String(MIN_SIZE);
    rowsInput.max = String(MAX_SIZE);
    rowsInput.value = "2";
    rowsInput.inputMode = "numeric";
    rowsInput.setAttribute("aria-label", "行数");
    const times = el("span", "fmx-times", "×");
    const colsInput = document.createElement("input");
    colsInput.type = "number";
    colsInput.min = String(MIN_SIZE);
    colsInput.max = String(MAX_SIZE);
    colsInput.value = "2";
    colsInput.inputMode = "numeric";
    colsInput.setAttribute("aria-label", "列数");
    const buildButton = el("button", "fmx-primary", "生成并插入");
    buildButton.type = "button";
    sizeBox.append(rowsInput, times, colsInput, buildButton);
    sizeRow.append(sizeBox);

    /* 自然语言 */
    const aiSection = el("div", "fmx-section fmx-ai");
    aiSection.append(el("div", "fmx-label", "用一句话描述规律"));
    const textarea = document.createElement("textarea");
    textarea.className = "fmx-textarea";
    textarea.rows = 2;
    textarea.maxLength = 300;
    textarea.placeholder = "例如：一个 n 阶行列式，主对角线全为 1，其余位置全为 0";
    const aiRow = el("div", "fmx-row");
    const aiButton = el("button", "fmx-primary", "生成");
    aiButton.type = "button";
    const aiHint = el("span", "fmx-status", "");
    aiRow.append(aiButton, aiHint);

    const preview = el("div", "fmx-preview");
    preview.hidden = true;

    const actions = el("div", "fmx-actions");
    actions.hidden = true;
    const insertButton = el("button", "fmx-primary", "插入");
    insertButton.type = "button";
    const retryButton = el("button", "fmx-ghost", "再生成一次");
    retryButton.type = "button";
    actions.append(insertButton, retryButton);

    aiSection.append(textarea, aiRow, preview, actions);

    body.append(kindRow, sizeRow, el("div", "fmx-divider", "或者让模型按规律生成"), aiSection);
    dialog.append(head, body);
    backdrop.append(dialog);
    document.body.append(backdrop);

    nodes = {
      backdrop, dialog, close, matrixButton, determinantButton,
      rowsInput, colsInput, buildButton, textarea, aiButton, aiHint,
      preview, actions, insertButton, retryButton
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
    [matrixButton, determinantButton].forEach(function (button) {
      button.addEventListener("click", function () {
        setKind(button.dataset.kind);
      });
    });
    buildButton.addEventListener("click", function () {
      const rows = clampSize(rowsInput.value);
      const cols = clampSize(colsInput.value);
      apply({
        text: buildLatex(rows, cols, state.kind, "$0", ""),
        template: buildLatex(rows, cols, state.kind, "#@", "#?")
      });
    });
    aiButton.addEventListener("click", requestModel);
    insertButton.addEventListener("click", function () {
      if (!state.pendingLatex) return;
      apply({ text: state.pendingLatex, template: state.pendingLatex });
    });
    retryButton.addEventListener("click", requestModel);
    rowsInput.addEventListener("change", function () {
      rowsInput.value = String(clampSize(rowsInput.value));
    });
    colsInput.addEventListener("change", function () {
      colsInput.value = String(clampSize(colsInput.value));
    });

    return backdrop;
  }

  function setKind(kind) {
    state.kind = ENV_BY_KIND[kind] ? kind : "matrix";
    nodes.matrixButton.classList.toggle("active", state.kind === "matrix");
    nodes.determinantButton.classList.toggle("active", state.kind === "determinant");
  }

  function setStatus(message, isError) {
    nodes.aiHint.textContent = message || "";
    nodes.aiHint.classList.toggle("is-error", Boolean(isError));
  }

  function setBusy(value) {
    state.busy = value;
    nodes.aiButton.disabled = value || state.configured === false;
    nodes.retryButton.disabled = value;
    nodes.insertButton.disabled = value;
    if (value) setStatus("正在生成…");
  }

  function resetPreview() {
    state.pendingLatex = "";
    nodes.preview.hidden = true;
    nodes.preview.replaceChildren();
    nodes.actions.hidden = true;
  }

  function showPreview(latex) {
    nodes.preview.hidden = false;
    nodes.preview.replaceChildren();
    if (window.katex && typeof window.katex.render === "function") {
      try {
        window.katex.render(latex, nodes.preview, { throwOnError: false, displayMode: true });
      } catch (error) {
        nodes.preview.textContent = latex;
      }
    } else {
      nodes.preview.textContent = latex;
    }
    nodes.actions.hidden = false;
  }

  /* ---------- 模型生成 ---------- */

  async function requestModel() {
    if (state.busy) return;
    const description = nodes.textarea.value.trim();
    if (!description) {
      setStatus("请先写一句描述", true);
      return;
    }
    resetPreview();
    setBusy(true);
    const controller = new AbortController();
    const timer = window.setTimeout(function () {
      controller.abort();
    }, AI_TIMEOUT_MS);
    try {
      const response = await fetch("/api/formula/matrix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: description, kind: state.kind }),
        signal: controller.signal
      });
      const data = await response.json().catch(function () {
        return {};
      });
      if (!response.ok || !data.ok) {
        throw new Error(data.error || "生成失败，请稍后重试。");
      }
      state.pendingLatex = data.latex;
      showPreview(data.latex);
      setStatus("已生成，确认后点插入");
    } catch (error) {
      if (error && error.name === "AbortError") {
        setStatus("生成超时（25 秒），请重试。", true);
      } else {
        setStatus(error.message || "生成失败，请稍后重试。", true);
      }
    } finally {
      window.clearTimeout(timer);
      setBusy(false);
    }
  }

  /* ---------- 配置状态 ---------- */

  // 每次打开都重新问一次 /api/status：用户可能刚在「模型设置」里存好 Key，
  // 面板不能因为第一次读到「未配置」就永久锁死（之前的缓存版就是这么坏的）。
  async function loadConfigState() {
    let configured = false;
    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      const data = await response.json();
      configured = Boolean(data && data.configured);
    } catch (error) {
      configured = false;
    }
    state.configured = configured;
    nodes.textarea.disabled = !configured;
    nodes.aiButton.disabled = !configured || state.busy;
    if (configured) {
      nodes.textarea.placeholder = "例如：一个 n 阶行列式，主对角线全为 1，其余位置全为 0";
      if (nodes.aiHint.classList.contains("is-error")) setStatus("");
    } else {
      nodes.textarea.placeholder = "未配置模型：请先在右上角「模型设置」保存 API Key";
      setStatus("自然语言生成需要模型，未配置时不可用", true);
    }
  }

  /* ---------- 打开 / 关闭 ---------- */

  function apply(payload) {
    if (typeof state.onInsert !== "function") return;
    state.onInsert(payload);
    closePanel();
  }

  function onKeydown(event) {
    if (event.key === "Escape") closePanel();
  }

  function open(options) {
    if (!panel) panel = build();
    state.onInsert = options && options.onInsert;
    state.onClose = (options && options.onClose) || null;
    state.busy = false;
    setKind((options && options.kind) || "matrix");
    resetPreview();
    setStatus("");
    panel.hidden = false;
    document.addEventListener("keydown", onKeydown);
    loadConfigState();
    window.setTimeout(function () {
      nodes.rowsInput.focus({ preventScroll: true });
      nodes.rowsInput.select();
    }, 30);
  }

  function closePanel() {
    if (!panel) return;
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
    buildLatex: buildLatex
  };
})();
