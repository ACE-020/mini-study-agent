/* 公式输入模式 · MathLive 集成（真实 TeX 排版）
   把 <math-field>（static/vendor/mathlive/mathlive.min.js）挂到 #formula-editor-host，
   负责「文字 / 公式（可视化）」切换、#draft 双向同步、只读镜像，
   以及三个对话补充框上的「∑ 公式」按钮（Phase 2）。
   #draft.value 契约不变：普通文字 + $...$ 公式段（发送/提交链路只认 #draft）。
   约束：CSP script-src 'self'，本文件不使用 eval / inline script / CDN。 */
(function () {
  "use strict";

  const VERSION = "20261118-mathlive";
  const MODE_ATTR = "data-input-mode";
  const FOLLOW_VIEWS = ["organize", "review", "analysis"];
  const DRAFT_PLACEHOLDER = "点下方符号键开始输入公式，也可以直接打字";
  const FOLLOW_PLACEHOLDER = "点下方符号键输入公式，也可以直接打字";
  const MATHLIVE_SCRIPT = "/static/vendor/mathlive/mathlive.min.js";
  const MATHLIVE_FONTS = "/static/vendor/mathlive/fonts";
  const TOGGLES_STYLE = ".ML__menu-toggle,.ML__virtual-keyboard-toggle,.ML__toggles{display:none!important}";

  const draft = document.querySelector("#draft");
  const sourcePanel = document.querySelector("#source-panel");
  const formulaPane = document.querySelector("#formula-pane");
  const formulaHost = document.querySelector("#formula-editor-host");
  const imagePane = document.querySelector("#image-pane");

  const state = {
    mode: "text",
    field: null,     // #draft 对应的 MathLive <math-field>
    syncing: 0,      // >0 表示正在双向同步，禁止 input / onExternalChange 互相触发
    entries: [],     // 对话补充框的公式编辑器
    initialized: false,
    fontsConfigured: false,
    scriptRequested: false
  };

  /* ---------- 通用工具 ---------- */

  function withSync(fn) {
    state.syncing += 1;
    try {
      fn();
    } finally {
      state.syncing -= 1;
    }
  }

  function dispatchModeChange(mode) {
    try {
      window.dispatchEvent(new CustomEvent("math-input-mode-change", { detail: { mode: mode } }));
    } catch (error) {
      /* 老浏览器没有 CustomEvent 构造器时忽略 */
    }
  }

  /* ---------- LaTeX ↔ 混合文本（#draft.value） ---------- */

  // 文字段在 \text{} 里的转义表（单遍替换，避免链式 replace 互相污染）
  const TEXT_ESCAPE_MAP = {
    "\\": "\\textbackslash{}",
    "{": "\\{",
    "}": "\\}",
    "$": "\\$",
    "%": "\\%",
    "_": "\\_",
    "^": "\\textasciicircum{}",
    "&": "\\&",
    "#": "\\#",
    "~": "\\textasciitilde{}"
  };

  // 反转义表：长的放前面，避免 \textbackslash{} 被拆成 \textbackslash + {}
  const TEXT_UNESCAPES = [
    ["\\textbackslash{}", "\\"],
    ["\\textasciicircum{}", "^"],
    ["\\textasciitilde{}", "~"],
    ["\\textbackslash", "\\"],
    ["\\textasciicircum", "^"],
    ["\\textasciitilde", "~"],
    ["\\{", "{"],
    ["\\}", "}"],
    ["\\$", "$"],
    ["\\%", "%"],
    ["\\_", "_"],
    ["\\&", "&"],
    ["\\#", "#"],
    ["\\~", "~"],
    ["\\^", "^"],
    ["\\ ", " "]
  ];

  const CJK_PATTERN = /[\u3400-\u9fff\u3000-\u303f\uff01-\uff60]+/;

  function escapeText(value) {
    const source = String(value == null ? "" : value);
    let out = "";
    for (const ch of source) {
      if (ch === "\n" || ch === "\r" || ch === "\t") {
        out += " ";
        continue;
      }
      const escaped = TEXT_ESCAPE_MAP[ch];
      out += escaped != null ? escaped : ch;
    }
    return out;
  }

  function unescapeText(value) {
    let out = String(value == null ? "" : value);
    for (const pair of TEXT_UNESCAPES) out = out.split(pair[0]).join(pair[1]);
    return out;
  }

  // 把 "普通文字 + $...$" 拆成 text / math 段；未闭合的 $ 当普通文字（绝不吃内容）
  function splitMixed(text) {
    const source = String(text == null ? "" : text);
    const parts = [];
    let i = 0;
    while (i < source.length) {
      const start = source.indexOf("$", i);
      if (start < 0) {
        parts.push({ type: "text", value: source.slice(i) });
        break;
      }
      const end = source.indexOf("$", start + 1);
      if (end < 0) {
        parts.push({ type: "text", value: source.slice(i) });
        break;
      }
      if (start > i) parts.push({ type: "text", value: source.slice(i, start) });
      const formula = source.slice(start + 1, end);
      parts.push(formula ? { type: "math", value: formula } : { type: "text", value: "$$" });
      i = end + 1;
    }
    return parts;
  }

  // 混合文本 → 单个 MathLive LaTeX 串（普通文字包 \text{}，$...$ 原样）
  function mixedToLatex(text) {
    const parts = splitMixed(text);
    let out = "";
    for (const part of parts) {
      if (part.type === "math") out += part.value;
      else if (part.value) out += "\\text{" + escapeText(part.value) + "}";
    }
    return out;
  }

  // 从 openIndex（指向 "{"）开始找到匹配的 "}"，跳过转义字符
  function matchBrace(source, openIndex) {
    let depth = 0;
    for (let i = openIndex; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  // 扫描顶层 \text{...}，其余片段算公式
  function splitTextBlocks(latex) {
    const parts = [];
    let i = 0;
    let mathStart = 0;
    while (i < latex.length) {
      const idx = latex.indexOf("\\text", i);
      if (idx < 0) break;
      if (latex[idx + 5] !== "{") {
        i = idx + 5;
        continue;
      }
      const end = matchBrace(latex, idx + 5);
      if (end < 0) break;
      const math = latex.slice(mathStart, idx);
      if (math.trim()) parts.push({ type: "math", value: math });
      parts.push({ type: "text", value: latex.slice(idx + 6, end) });
      i = end + 1;
      mathStart = i;
    }
    const tail = latex.slice(mathStart);
    if (tail.trim()) parts.push({ type: "math", value: tail });
    return parts;
  }

  // MathLive LaTeX → 混合文本：\text{} 还原为普通文字，其余包成 $...$
  function latexToMixed(latex) {
    const source = String(latex == null ? "" : latex)
      .replace(/\\placeholder\{\}/g, "")
      .replace(/\\placeholder(?![A-Za-z])/g, "");
    if (!source.trim()) return "";
    let out = "";
    for (const part of splitTextBlocks(source)) {
      if (part.type === "text") {
        out += unescapeText(part.value);
        continue;
      }
      // 公式段里如果混入中文（用户在公式编辑器里直接打中文），按普通文字输出，
      // 避免 #draft.value 里出现 KaTeX 不认识的中文数学段。
      const chunks = part.value.split(new RegExp("(" + CJK_PATTERN.source + ")"));
      for (const chunk of chunks) {
        if (!chunk) continue;
        if (CJK_PATTERN.test(chunk)) {
          out += chunk;
        } else {
          const expr = chunk.trim();
          if (expr) out += "$" + expr + "$";
        }
      }
    }
    return out;
  }

  /* ---------- MathLive 初始化 ---------- */

  function mathfieldClass() {
    if (window.MathfieldElement) return window.MathfieldElement;
    if (window.customElements && window.customElements.get("math-field")) return true;
    return null;
  }

  function ensureMathliveScript() {
    // mathlive.min.js 已由 index.html defer 引入；极端情况下（被 CSP/缓存拦住）动态补一次。
    if (mathfieldClass() || state.scriptRequested) return;
    state.scriptRequested = true;
    const script = document.createElement("script");
    script.src = MATHLIVE_SCRIPT;
    script.defer = true;
    document.head.append(script);
  }

  function configureFonts() {
    if (state.fontsConfigured || !window.MathfieldElement) return;
    try {
      window.MathfieldElement.fontsDirectory = MATHLIVE_FONTS;
      window.MathfieldElement.soundsDirectory = null;
    } catch (error) {
      /* 只影响声音/字体路径，忽略 */
    }
    state.fontsConfigured = true;
  }

  function hideToggles(mf) {
    const apply = function () {
      try {
        if (!mf.shadowRoot || mf.dataset.mathliveToggles === "hidden") return;
        const style = document.createElement("style");
        style.textContent = TOGGLES_STYLE;
        mf.shadowRoot.append(style);
        mf.dataset.mathliveToggles = "hidden";
      } catch (error) {
        /* 没有 shadowRoot 时忽略 */
      }
    };
    apply();
    if (!mf.shadowRoot) window.requestAnimationFrame(apply);
  }

  function getLatex(mf) {
    if (!mf) return null;
    try {
      const value = mf.getValue("latex");
      return typeof value === "string" ? value : "";
    } catch (error) {
      return null;
    }
  }

  function setLatex(mf, latex) {
    if (!mf) return;
    withSync(function () {
      try {
        mf.setValue(latex || "");
      } catch (error) {
        try {
          mf.setValue("");
        } catch (ignored) {
          /* 忽略 */
        }
      }
    });
  }

  function setReadOnly(mf, flag) {
    if (!mf) return;
    try {
      mf.readOnly = Boolean(flag);
    } catch (error) {
      /* 忽略 */
    }
  }

  function currentMixed(mf) {
    const latex = getLatex(mf);
    return latex === null ? null : latexToMixed(latex);
  }

  function createEditor(host, textarea, placeholder) {
    if (!host || !mathfieldClass()) return null;
    configureFonts();
    let mf = null;
    try {
      mf = document.createElement("math-field");
      host.append(mf);
    } catch (error) {
      return null;
    }
    try {
      mf.setAttribute("aria-label", "公式输入");
      mf.placeholder = placeholder;
      mf.mathVirtualKeyboardPolicy = "manual"; // 不弹它自带的虚拟键盘，用我们的符号键盘
      mf.smartMode = false;
      mf.smartFence = false;
    } catch (error) {
      /* 属性名随版本变化时忽略 */
    }
    hideToggles(mf);
    mf.addEventListener("input", function () {
      handleFieldChange(mf, textarea);
    });
    // 长公式横向滚动：浏览器不会把纵向滚轮自动转成横向（只会滚整页），
    // 而 MathLive 的内容区又缺少可见的滚动条，用户只能挪光标看前面。
    // 这里在有横向溢出时把滚轮转成内容的横向滚动；Ctrl+滚轮留给缩放，不拦。
    mf.addEventListener(
      "wheel",
      function (event) {
        if (event.ctrlKey) return;
        const content = mf.shadowRoot && mf.shadowRoot.querySelector(".ML__content");
        if (!content || content.scrollWidth <= content.clientWidth + 2) return;
        const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
        if (!delta) return;
        content.scrollLeft += delta;
        event.preventDefault();
      },
      { passive: false }
    );
    setLatex(mf, mixedToLatex(textarea ? textarea.value : ""));
    setReadOnly(mf, textarea ? textarea.readOnly || textarea.disabled : false);
    return mf;
  }

  // 公式编辑器 → textarea：#draft.value 始终是「普通文字 + $...$」
  function handleFieldChange(mf, textarea) {
    if (state.syncing || !mf || !textarea) return;
    const mixed = currentMixed(mf);
    if (mixed === null || textarea.value === mixed) return;
    withSync(function () {
      textarea.value = mixed;
      // 必须派发 input：app.js 的 #draft-count / 发送按钮 / 待发送队列都靠它更新
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  // 把公式编辑器的内容写回 textarea；若只是「原稿 → 公式 → 原稿」的往返（含换行归一化），保留原稿不动。
  function commitEditorValue(mf, textarea) {
    if (!mf || !textarea || state.syncing) return;
    const mixed = currentMixed(mf);
    if (mixed === null || mixed === textarea.value) return;
    const roundTrip = latexToMixed(mixedToLatex(textarea.value));
    if (mixed === roundTrip) return;
    withSync(function () {
      textarea.value = mixed;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  /* ---------- 主输入区 ---------- */

  function initMainField() {
    if (!draft || !formulaPane || !formulaHost || !sourcePanel) return false;
    ensureMathliveScript();
    state.field = createEditor(formulaHost, draft, DRAFT_PLACEHOLDER);
    const formulaButton = document.querySelector(".input-mode-button[" + MODE_ATTR + '="formula"]');
    if (!state.field) {
      // MathLive 没加载成功：保留文字模式，禁用切换按钮并说明原因，避免点了没反应。
      if (formulaButton) {
        formulaButton.disabled = true;
        formulaButton.title = "公式编辑器未就绪，请刷新页面后重试";
      }
      return false;
    }
    window.mathInputMode.field = state.field;
    if (formulaButton) formulaButton.disabled = false;
    if (window.MutationObserver) {
      // app.js 在 updateButtons() 里设置 #draft.readOnly，这里把只读状态镜像到 MathLive
      const observer = new MutationObserver(function () {
        setReadOnly(state.field, draft.readOnly);
      });
      observer.observe(draft, { attributes: true, attributeFilter: ["readonly"] });
    }
    return true;
  }

  function updateModeButtons() {
    document.querySelectorAll(".input-mode-button[" + MODE_ATTR + "]").forEach(function (button) {
      const selected = button.getAttribute(MODE_ATTR) === state.mode;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", selected ? "true" : "false");
    });
  }

  // 与 app.js 的 selectSource() 渲染结果保持一致：同步 [data-source] 的 active / aria-pressed 与 #image-pane.hidden。
  // 这里不调用 app.js 的 selectSource：它会 focus 隐藏的 #draft 并 setSelectionRange，在公式模式下没有意义。
  function setSourceTabActive(source) {
    const activeSource = source === "image" ? "image" : "text";
    document.querySelectorAll("[data-source]").forEach(function (button) {
      const selected = button.getAttribute("data-source") === activeSource;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", selected ? "true" : "false");
    });
    if (imagePane) imagePane.hidden = activeSource === "text";
  }

  function setMode(mode) {
    const next = mode === "formula" ? "formula" : "text";
    if (next === "formula" && !state.field) return;
    state.mode = next;
    updateModeButtons();
    if (next === "formula") {
      sourcePanel.classList.add("formula-mode");
      formulaPane.hidden = false;
      // 公式编辑与「上传文件」互斥：进入公式模式时收起上传区，并把「直接输入文字」设为 active
      setSourceTabActive("text");
      setLatex(state.field, mixedToLatex(draft.value));
      setReadOnly(state.field, draft.readOnly);
      state.field.focus();
    } else {
      // 退出时把编辑器里的公式写回 #draft（走同一套转换；未编辑的纯往返不覆盖原稿）
      commitEditorValue(state.field, draft);
      sourcePanel.classList.remove("formula-mode");
      formulaPane.hidden = true;
      try {
        draft.focus();
      } catch (error) {
        /* 忽略：输入框不可聚焦时不影响模式切换 */
      }
    }
    dispatchModeChange(next);
  }

  function bindModeButtons() {
    document.querySelectorAll(".input-mode-button[" + MODE_ATTR + "]").forEach(function (button) {
      button.addEventListener("click", function (event) {
        event.preventDefault();
        setMode(button.getAttribute(MODE_ATTR));
      });
    });
  }

  function bindSourceTabs() {
    // 点「上传文件 / 直接输入文字」都先退出公式模式。用 capture 监听，保证早于 app.js 绑定在按钮上的
    // 冒泡监听执行：这样 app.js 随后 selectSource() 聚焦 #draft 时，它已经因去掉 formula-mode 而可见。
    document.addEventListener("click", function (event) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const tab = target.closest ? target.closest("[data-source]") : null;
      if (!tab) return;
      if (state.mode !== "formula") return;
      setMode("text");
    }, true);
  }

  function watchImagePane() {
    // app.js 也会直接改 #image-pane.hidden（例如「清空本次上传」后 selectSource("image")）；
    // 公式模式下上传区被重新显示时自动退出公式模式，避免两种输入方式同时出现。
    if (!imagePane || !window.MutationObserver) return;
    const observer = new MutationObserver(function () {
      if (state.mode !== "formula" || imagePane.hidden) return;
      setMode("text");
    });
    observer.observe(imagePane, { attributes: true, attributeFilter: ["hidden"] });
  }

  // app.js 在 updateDraft() 末尾调用：把「填入示例 / OCR 写入 / 清空 / 提交后修改」同步进编辑器
  function onExternalChange() {
    if (!state.field || state.syncing) return;
    const current = currentMixed(state.field);
    if (current === null || current === draft.value) return;
    setLatex(state.field, mixedToLatex(draft.value));
  }

  /* ---------- 光标 / 插入（供符号键盘调用） ---------- */

  const MOVE_COMMANDS = {
    left: "moveToPreviousPlaceholder",
    right: "moveToNextPlaceholder",
    up: "moveUp",
    down: "moveDown"
  };

  function resolveEditor() {
    const active = document.activeElement;
    if (active && active.closest) {
      const host = active.closest(".formula-editor-host");
      if (host) {
        if (state.field && formulaHost === host) return state.field;
        for (const entry of state.entries) {
          if (entry.host === host) return entry.field;
        }
      }
    }
    if (state.mode === "formula" && state.field) return state.field;
    return null;
  }

  function focusEditor(mf) {
    const target = mf || resolveEditor();
    if (!target || typeof target.focus !== "function") return false;
    try {
      target.focus();
      return true;
    } catch (error) {
      return false;
    }
  }

  function executeCommand(mf, command) {
    if (!mf || typeof mf.executeCommand !== "function") return false;
    focusEditor(mf);
    try {
      mf.executeCommand(command);
      return true;
    } catch (error) {
      return false;
    }
  }

  // 兼容：{template} / 旧版 {type,...} 规格 → MathLive insert 模板
  const LEGACY_TEMPLATES = {
    frac: "\\frac{#@}{#?}",
    sqrt: "\\sqrt{#@}",
    paren: "\\left(#@\\right)",
    abs: "\\left|#@\\right|",
    sup: "#@^{#?}",
    sub: "#@_{#?}",
    int: "\\int_{#?}^{#?}{#@}",
    sum: "\\sum_{#?}^{#?}{#@}",
    prod: "\\prod_{#?}^{#?}{#@}",
    lim: "\\lim_{#?}{#@}",
    matrix: "\\begin{pmatrix}#@&\\\\&\\\\\\end{pmatrix}",
    vec: "\\vec{#@}",
    overline: "\\overline{#@}"
  };

  function templateFromSpec(spec) {
    if (!spec) return null;
    if (typeof spec === "string") return spec;
    if (spec.template) return spec.template;
    const base = LEGACY_TEMPLATES[spec.type];
    if (!base) return null;
    if (spec.type === "sqrt" && spec.index != null) return "\\sqrt[" + spec.index + "]{#@}";
    return base;
  }

  function moveCursor(dir) {
    const mf = resolveEditor();
    if (!mf || !MOVE_COMMANDS[dir]) return false;
    focusEditor(mf);
    let moved = false;
    try {
      moved = mf.executeCommand(MOVE_COMMANDS[dir]) !== false;
    } catch (error) {
      moved = false;
    }
    // MathLive 在「不能再移动」时会按浏览器的焦点顺序把焦点移出编辑器（会跳到上一个按钮），
    // 这里把焦点拉回公式编辑器，避免点方向键后突然跳到别处。
    if (!mf.contains(document.activeElement)) focusEditor(mf);
    return moved;
  }

  function insertChip(spec) {
    const mf = resolveEditor();
    const template = templateFromSpec(spec);
    if (!mf || !template) return false;
    return executeCommand(mf, ["insert", template]);
  }

  function insertGlyph(text) {
    const mf = resolveEditor();
    if (!mf) return false;
    return executeCommand(mf, ["insert", String(text == null ? "" : text)]);
  }

  /* ---------- Phase 2：三个对话补充框的「∑ 公式」 ---------- */

  function syncFromTextarea(entry) {
    if (state.syncing || !entry.field) return;
    const current = currentMixed(entry.field);
    if (current === null || current === entry.textarea.value) return;
    setLatex(entry.field, mixedToLatex(entry.textarea.value));
  }

  function toggleFollow(entry) {
    const willOpen = entry.pane.hidden;
    if (willOpen) {
      entry.pane.hidden = false;
      setLatex(entry.field, mixedToLatex(entry.textarea.value));
      setReadOnly(entry.field, entry.textarea.readOnly || entry.textarea.disabled);
      entry.button.setAttribute("aria-expanded", "true");
      entry.button.title = "收起公式输入";
      entry.field.focus();
    } else {
      commitEditorValue(entry.field, entry.textarea);
      entry.pane.hidden = true;
      entry.button.setAttribute("aria-expanded", "false");
      entry.button.title = "用可视化编辑器输入公式";
      // 收起后把焦点交还给原 textarea，Ctrl+Enter 发送等原有行为不受影响
      try {
        entry.textarea.focus();
      } catch (error) {
        /* 忽略 */
      }
    }
  }

  function initFollowEditors() {
    for (const view of FOLLOW_VIEWS) {
      const textarea = document.getElementById(view + "-follow");
      const form = document.getElementById(view + "-follow-form");
      if (!textarea || !form) continue;
      const toolbar = form.querySelector(".composer-toolbar");
      if (!toolbar || toolbar.querySelector(".composer-formula-toggle")) continue;

      const button = document.createElement("button");
      button.type = "button";
      button.className = "composer-formula-toggle";
      button.textContent = "∑ 公式";
      button.title = "用可视化编辑器输入公式";
      button.setAttribute("aria-expanded", "false");
      button.setAttribute("aria-label", "展开公式输入");

      const pane = document.createElement("div");
      pane.className = "formula-follow-pane";
      pane.hidden = true;
      const host = document.createElement("div");
      host.className = "formula-editor-host";
      host.id = "formula-follow-host-" + view;
      pane.append(host);

      // 表单上方展开：编辑器在 composer 上方、在消息区下方
      if (form.parentNode) form.parentNode.insertBefore(pane, form);
      toolbar.prepend(button);

      const field = createEditor(host, textarea, FOLLOW_PLACEHOLDER);
      if (!field) {
        pane.remove();
        button.disabled = true;
        button.title = "公式编辑器尚未就绪";
        continue;
      }

      const entry = { view: view, textarea: textarea, form: form, pane: pane, host: host, field: field, button: button };
      state.entries.push(entry);

      // 用 pointerdown 处理鼠标点击：键盘面板就在表单上方，如果在 click 阶段才收起，
      // 面板消失造成布局位移会让 mouseup 落在别处、click 丢失（第一次点收起会“点不动”）。
      let lastPointerToggle = 0;
      button.addEventListener("pointerdown", function (event) {
        if (event.button !== 0) return;
        event.preventDefault();
        lastPointerToggle = Date.now();
        toggleFollow(entry);
      });
      button.addEventListener("click", function (event) {
        event.preventDefault();
        // 鼠标点击已由 pointerdown 处理；这里只负责键盘 Enter / 空格触发的 click
        if (Date.now() - lastPointerToggle < 800) return;
        toggleFollow(entry);
      });
      // 在公式编辑器里按 Ctrl+Enter 也要能发送（与 textarea 的原有行为一致）
      function forwardCtrlEnter(event) {
        if (!(event.ctrlKey || event.metaKey) || event.key !== "Enter") return;
        event.preventDefault();
        if (typeof form.requestSubmit === "function") form.requestSubmit();
      }
      host.addEventListener("keydown", forwardCtrlEnter);
      field.addEventListener("keydown", forwardCtrlEnter);
      // textarea 被其他脚本写入（排队发送、清空、建议填入等）时反向同步进编辑器
      textarea.addEventListener("input", function () {
        syncFromTextarea(entry);
      });
      if (window.MutationObserver) {
        const observer = new MutationObserver(function () {
          setReadOnly(entry.field, entry.textarea.readOnly || entry.textarea.disabled);
        });
        observer.observe(textarea, { attributes: true, attributeFilter: ["readonly", "disabled"] });
        // 会话结束时 app.js 会把补充框表单藏起来（form.hidden=true）；这时内嵌公式编辑器必须一起收起，
        // 否则它会留在对话面板里变成一个悬空的输入框。
        const formObserver = new MutationObserver(function () {
          if (form.hidden && !entry.pane.hidden) {
            entry.pane.hidden = true;
            entry.button.setAttribute("aria-expanded", "false");
            entry.button.title = "用可视化编辑器输入公式";
          }
        });
        formObserver.observe(form, { attributes: true, attributeFilter: ["hidden"] });
      }
    }
  }

  /* ---------- 对外接口 ---------- */

  window.mathInputMode = {
    version: VERSION,
    field: null,
    active: function () {
      return state.mode === "formula" && Boolean(state.field);
    },
    setMode: setMode,
    focus: function () {
      return focusEditor(resolveEditor());
    },
    onExternalChange: onExternalChange,
    move: moveCursor,
    insertChip: insertChip,
    insertGlyph: insertGlyph,
    // 暴露转换函数，便于自检与后续调试
    mixedToLatex: mixedToLatex,
    latexToMixed: latexToMixed
  };

  function init() {
    if (state.initialized) return;
    if (!draft || !formulaPane || !formulaHost || !sourcePanel) return;
    state.initialized = true;
    ensureMathliveScript();
    initMainField();
    bindModeButtons();
    bindSourceTabs();
    watchImagePane();
    updateModeButtons();
    initFollowEditors();
    // 对话补充框的 .composer-toolbar 由 chat-composer.js 在 window 的 DOMContentLoaded 里创建；
    // 若它们的初始化顺序意外靠后，下一帧再补一次（幂等，已有按钮的会跳过）。
    window.setTimeout(function () {
      initFollowEditors();
    }, 0);
    dispatchModeChange(state.mode);
  }

  // 用 window 的 DOMContentLoaded：chat-composer.js 也挂在 window 上，脚本顺序保证它先跑。
  window.addEventListener("DOMContentLoaded", init);
  // 极端情况（defer 脚本被延迟到 load 之后执行）兜底
  if (document.readyState === "complete") init();
})();
