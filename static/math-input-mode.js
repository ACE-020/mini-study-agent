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
    docs: new WeakMap(), // <math-field> → 最近一次同步的草稿分段（保留原分隔符与换行）
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
  const KNOWN_MATH_ENVIRONMENTS = ["aligned", "align", "align*", "equation", "equation*", "cases", "pmatrix", "bmatrix", "vmatrix"];
  const DISPLAY_STYLE = "\\displaystyle ";

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

  // 草稿里的 \$ 是字面美元；进 \text{} 前还原成普通字符，写回草稿时再转义。
  function unescapeDraftText(value) {
    return String(value == null ? "" : value).replace(/\\\$/g, "$");
  }

  function escapeDraftText(value) {
    return String(value == null ? "" : value).replace(/\$/g, "\\$");
  }

  function isEscaped(source, index) {
    let count = 0;
    for (let i = index - 1; i >= 0 && source[i] === "\\"; i -= 1) count += 1;
    return count % 2 === 1;
  }

  function findToken(source, from, token, stopAtNewline) {
    for (let i = from; i <= source.length - token.length; i += 1) {
      if (stopAtNewline && (source[i] === "\n" || source[i] === "\r")) return -1;
      if (source.startsWith(token, i) && !isEscaped(source, i)) return i;
    }
    return -1;
  }

  function findInlineMathEnd(source, from) {
    for (let i = from; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "\n" || ch === "\r") return -1;
      if (ch !== "$" || isEscaped(source, i)) continue;
      if (i === from) return -1;            // $ $ 不当作公式
      if (source[i + 1] === "$") return -1; // 这是块级公式的开头，不是行内结尾
      // 普通价格 "$5 到 $10"：闭合 $ 后面紧跟数字，不当公式（Pandoc 同款启发式）。
      if (/\d/.test(source[i + 1] || "")) return -1;
      const content = source.slice(from, i);
      if (!content.trim()) return -1;
      // 中文正文里的 "$5 到 $" 之类：没有 LaTeX 命令就按普通文字处理。
      if (CJK_PATTERN.test(content) && content.indexOf("\\") < 0) return -1;
      return i;
    }
    return -1;
  }

  // 把草稿拆成 text / math 段。支持 $...$、$$...$$、\(...\)、\[...\]、裸 \begin{...}；
  // 未闭合或转义的定界符都留在文字段里，绝不吞内容。
  function parseMixed(text) {
    const source = String(text == null ? "" : text);
    const parts = [];
    let i = 0;
    let textStart = 0;

    function pushText(end) {
      if (end <= textStart) return;
      const raw = source.slice(textStart, end);
      parts.push({ type: "text", start: textStart, end, raw, value: unescapeDraftText(raw) });
    }

    function pushMath(start, end, open, close, contentStart, contentEnd, block) {
      pushText(start);
      parts.push({
        type: "math",
        start,
        end,
        contentStart,
        contentEnd,
        open,
        close,
        block,
        raw: source.slice(start, end),
        value: source.slice(contentStart, contentEnd)
      });
    }

    while (i < source.length) {
      const ch = source[i];
      if (ch === "\\") {
        if (source.startsWith("\\(", i) || source.startsWith("\\[", i)) {
          const open = source.slice(i, i + 2);
          const close = open === "\\(" ? "\\)" : "\\]";
          const end = findToken(source, i + 2, close, false);
          if (end > i + 2) {
            pushMath(i, end + 2, open, close, i + 2, end, open === "\\[");
            i = end + 2;
            textStart = i;
            continue;
          }
        } else if (source.startsWith("\\begin{", i)) {
          const match = /^\\begin\{([A-Za-z*]+)\}/.exec(source.slice(i));
          if (match && KNOWN_MATH_ENVIRONMENTS.indexOf(match[1]) >= 0) {
            const close = "\\end{" + match[1] + "}";
            const end = source.indexOf(close, i + match[0].length);
            if (end > i) {
              const rangeEnd = end + close.length;
              pushMath(i, rangeEnd, "", "", i, rangeEnd, true);
              i = rangeEnd;
              textStart = i;
              continue;
            }
          }
        }
        i += 2;
        continue;
      }
      if (ch === "$" && !isEscaped(source, i)) {
        if (source.startsWith("$$", i)) {
          const end = findToken(source, i + 2, "$$", false);
          if (end > i + 2) {
            pushMath(i, end + 2, "$$", "$$", i + 2, end, true);
            i = end + 2;
            textStart = i;
            continue;
          }
          i += 2;
          continue;
        }
        const end = findInlineMathEnd(source, i + 1);
        if (end >= 0) {
          pushMath(i, end + 1, "$", "$", i + 1, end, false);
          i = end + 1;
          textStart = i;
          continue;
        }
        i += 1;
        continue;
      }
      i += 1;
    }
    pushText(source.length);
    return parts;
  }

  // 混合文本 → 单个 MathLive LaTeX 串（普通文字包 \text{}，公式去定界符后原样）
  function mixedToLatex(text) {
    let out = "";
    for (const part of parseMixed(text)) {
      if (part.type === "math") {
        const environment = /^\s*\\begin\{/.test(part.value);
        out += (part.block && !environment && !isDisplayMath(part.value) ? DISPLAY_STYLE : "") + part.value;
      } else if (part.value) {
        out += "\\text{" + escapeText(part.value) + "}";
      }
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

  function mathBody(value) {
    return String(value == null ? "" : value).replace(/^\s*\\displaystyle\b\s*/, "");
  }

  function isDisplayMath(value) {
    return /^\s*\\displaystyle\b/.test(String(value == null ? "" : value));
  }

  function sameMath(original, current) {
    return mathBody(original).replace(/\s+/g, " ").trim() === mathBody(current).replace(/\s+/g, " ").trim();
  }

  function sameText(original, current) {
    if (original === current) return true;
    return String(original).replace(/\s+/g, " ").trim() === String(current).replace(/\s+/g, " ").trim();
  }

  function normalizeWhitespace(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  // 扫描顶层 \text{...}，其余片段算公式（\text 内的花括号允许嵌套）
  function parseLatexParts(latex) {
    const source = String(latex == null ? "" : latex)
      .replace(/\\placeholder\{\}/g, "")
      .replace(/\\placeholder(?![A-Za-z])/g, "");
    const parts = [];
    let i = 0;
    let mathStart = 0;
    while (i < source.length) {
      const idx = source.indexOf("\\text", i);
      if (idx < 0) break;
      if (source[idx + 5] !== "{") {
        i = idx + 5;
        continue;
      }
      const end = matchBrace(source, idx + 5);
      if (end < 0) break;
      const math = source.slice(mathStart, idx);
      if (math.trim()) parts.push({ type: "math", value: math, display: isDisplayMath(math) });
      if (end > idx + 6) parts.push({ type: "text", value: source.slice(idx + 6, end) });
      i = end + 1;
      mathStart = i;
    }
    const tail = source.slice(mathStart);
    if (tail.trim()) parts.push({ type: "math", value: tail, display: isDisplayMath(tail) });
    return parts;
  }

  // 公式段里如果混入中文（用户在公式编辑器里直接打中文），按普通文字输出，
  // 避免 #draft.value 里出现 KaTeX 不认识的中文数学段。
  function mathToMixed(value, display) {
    const body = mathBody(value).trim();
    if (!body) return "";
    const chunks = body.split(new RegExp("(" + CJK_PATTERN.source + ")"));
    let out = "";
    for (const chunk of chunks) {
      if (!chunk) continue;
      if (CJK_PATTERN.test(chunk)) {
        out += chunk;
        continue;
      }
      const expression = chunk.trim();
      if (!expression) continue;
      out += display ? "$$" + expression + "$$" : "$" + expression + "$";
    }
    return out;
  }

  function serializeMathPart(part) {
    const display = part.display != null ? part.display : isDisplayMath(part.value);
    return mathToMixed(part.value, display);
  }

  function partsToMixed(parts) {
    let out = "";
    for (const part of parts) {
      if (part.type === "text") out += escapeDraftText(unescapeText(part.value));
      else out += serializeMathPart(part);
    }
    return out;
  }

  function latexToMixed(latex) {
    return partsToMixed(parseLatexParts(latex));
  }

  function parseDoc(text) {
    const source = String(text == null ? "" : text);
    return { source, parts: parseMixed(source) };
  }

  /* ---------- 编辑往返：尽量保留原稿的分隔符、换行和文字 ---------- */

  // 文字段的 value → raw 偏移表。只有 \$ 会改变长度，其余字符一一对应。
  function buildTextMapping(parts) {
    let text = "";
    const segments = [];
    for (const part of parts) {
      if (part.type !== "text") continue;
      const value = String(part.value == null ? "" : part.value);
      const raw = String(part.raw == null ? value : part.raw);
      const map = [];
      let vi = 0;
      let ri = 0;
      while (vi < value.length) {
        map[vi] = Math.min(ri, raw.length);
        if (raw.startsWith("\\$", ri) && value[vi] === "$") {
          ri += 2;
          vi += 1;
        } else {
          ri += 1;
          vi += 1;
        }
      }
      map[value.length] = Math.min(ri, raw.length);
      segments.push({ start: text.length, end: text.length + value.length, raw, map });
      text += value;
    }
    return { text, segments };
  }

  function rawTextRange(mapping, from, to) {
    let out = "";
    for (const segment of mapping.segments) {
      if (to <= segment.start) break;
      if (from >= segment.end) continue;
      const start = Math.max(from, segment.start) - segment.start;
      const end = Math.min(to, segment.end) - segment.start;
      out += segment.raw.slice(segment.map[start], segment.map[end]);
    }
    return out;
  }

  // 只对齐非空白字符：MathLive 会把换行归一化成空格，原稿 raw 仍按原样输出。
  function matchTextStream(original, from, fragment) {
    let i = from;
    for (let j = 0; j < fragment.length; j += 1) {
      const ch = fragment[j];
      if (/\s/.test(ch)) continue;
      while (i < original.length && /\s/.test(original[i])) i += 1;
      if (i >= original.length || original[i] !== ch) return -1;
      i += 1;
    }
    return i;
  }

  // 段数和类型都没变：逐段对照，未变的段直接复用 raw（保留换行、$ 与 \$）。
  function reconcileSameShape(doc, parts) {
    let out = "";
    for (let i = 0; i < parts.length; i += 1) {
      const original = doc.parts[i];
      const part = parts[i];
      if (original.type === "text") {
        const currentText = unescapeText(part.value);
        out += sameText(original.value, currentText) ? original.raw : escapeDraftText(currentText);
      } else if (sameMath(original.value, part.value)) {
        out += original.raw;
      } else {
        out += original.open + mathBody(part.value) + original.close;
      }
    }
    return out;
  }

  // 段数变了（在文字中插入/删除公式）：用非空白字符对齐原文，把新公式插到
  // 对应的位置，原有文字按 raw 原样保留。对不齐时返回 null，由调用方退回普通转换。
  function reconcileAnchored(doc, parts) {
    const mapping = buildTextMapping(doc.parts);
    const currentText = parts.filter(function (part) {
      return part.type === "text";
    }).map(function (part) {
      return unescapeText(part.value);
    }).join("");
    if (normalizeWhitespace(mapping.text) !== normalizeWhitespace(currentText)) return null;

    const originalMath = doc.parts.filter(function (part) {
      return part.type === "math";
    });
    const currentMath = parts.filter(function (part) {
      return part.type === "math";
    });
    const pairs = [];
    if (originalMath.length === currentMath.length) {
      pairs.push.apply(pairs, originalMath);
    } else {
      let cursor = 0;
      for (const math of currentMath) {
        let matched = null;
        for (let i = cursor; i < originalMath.length; i += 1) {
          if (sameMath(originalMath[i].value, math.value)) {
            matched = originalMath[i];
            cursor = i + 1;
            break;
          }
        }
        pairs.push(matched);
      }
      if (cursor < originalMath.length) return null;
    }

    let out = "";
    let textPos = 0;
    let mathIndex = 0;
    for (const part of parts) {
      if (part.type === "text") {
        const next = matchTextStream(mapping.text, textPos, unescapeText(part.value));
        if (next < 0) return null;
        out += rawTextRange(mapping, textPos, next);
        textPos = next;
      } else {
        const original = pairs[mathIndex];
        mathIndex += 1;
        if (original) {
          out += sameMath(original.value, part.value)
            ? original.raw
            : original.open + mathBody(part.value) + original.close;
        } else {
          out += serializeMathPart(part);
        }
      }
    }
    if (textPos < mapping.text.length) out += rawTextRange(mapping, textPos, mapping.text.length);
    return out;
  }

  function reconcileDoc(doc, parts) {
    if (!doc) return partsToMixed(parts);
    if (doc.parts.length === parts.length) {
      let sameShape = true;
      for (let i = 0; i < parts.length; i += 1) {
        if (doc.parts[i].type !== parts[i].type) {
          sameShape = false;
          break;
        }
      }
      if (sameShape) return reconcileSameShape(doc, parts);
    }
    const anchored = reconcileAnchored(doc, parts);
    return anchored == null ? partsToMixed(parts) : anchored;
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
    state.docs.set(mf, parseDoc(textarea ? textarea.value : ""));
    setReadOnly(mf, textarea ? textarea.readOnly || textarea.disabled : false);
    return mf;
  }

  function mixedFromEditor(mf, textarea) {
    const latex = getLatex(mf);
    if (latex === null) return null;
    const doc = state.docs.get(mf) || parseDoc(textarea ? textarea.value : "");
    return reconcileDoc(doc, parseLatexParts(latex));
  }

  // 公式编辑器 → textarea：#draft.value 始终是「普通文字 + $...$」
  function handleFieldChange(mf, textarea) {
    if (state.syncing || !mf || !textarea) return;
    const mixed = mixedFromEditor(mf, textarea);
    if (mixed === null || textarea.value === mixed) return;
    state.docs.set(mf, parseDoc(mixed));
    withSync(function () {
      textarea.value = mixed;
      // 必须派发 input：app.js 的 #draft-count / 发送按钮 / 待发送队列都靠它更新
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  // 把公式编辑器的内容写回 textarea。未编辑的段按原稿 raw 保留，所以换行、
  // $$...$$ / \[...\] / \(...\) 和 \$ 不会因为一次往返被改写。
  function commitEditorValue(mf, textarea) {
    if (!mf || !textarea || state.syncing) return;
    const mixed = mixedFromEditor(mf, textarea);
    if (mixed === null || mixed === textarea.value) return;
    state.docs.set(mf, parseDoc(mixed));
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
      state.docs.set(state.field, parseDoc(draft.value));
      setLatex(state.field, mixedToLatex(draft.value));
      setReadOnly(state.field, draft.readOnly);
      state.field.focus();
    } else {
      // 退出时把编辑器里的公式写回 #draft（未编辑的段保留原分隔符与换行）
      commitEditorValue(state.field, draft);
      state.docs.set(state.field, parseDoc(draft.value));
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
    const doc = parseDoc(draft.value);
    if (state.mode === "text") {
      const latex = mixedToLatex(draft.value);
      state.docs.set(state.field, doc);
      if (getLatex(state.field) !== latex) setLatex(state.field, latex);
      return;
    }
    // 公式模式下先看编辑器内容是否已经等价；外部写入（示例 / OCR / 清空）才重置。
    const mixed = mixedFromEditor(state.field, draft);
    if (mixed === null || mixed === draft.value) return;
    state.docs.set(state.field, doc);
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
    state.docs.set(entry.field, parseDoc(entry.textarea.value));
    setLatex(entry.field, mixedToLatex(entry.textarea.value));
  }

  function toggleFollow(entry) {
    const willOpen = entry.pane.hidden;
    if (willOpen) {
      entry.pane.hidden = false;
      state.docs.set(entry.field, parseDoc(entry.textarea.value));
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
    // 提交前把编辑器里的最新内容写回 textarea（也供表单/自动化调用）
    flush: function () {
      if (!state.field) return false;
      commitEditorValue(state.field, draft);
      return true;
    },
    // 暴露转换函数，便于自检与后续调试
    mixedToLatex: mixedToLatex,
    latexToMixed: latexToMixed,
    parseDraft: parseMixed,
    parseFormula: parseLatexParts,
    reconcileDraft: function (text, latex) {
      return reconcileDoc(parseDoc(text), parseLatexParts(latex));
    }
  };

  // 正常提交入口：app.js 的 submitOriginalIntake / 补充表单直接读 textarea.value。
  // 在按钮 click 与表单 submit 的捕获阶段先 flush，避免公式模式下最后一次输入尚未写回。
  function bindSubmitSync() {
    document.addEventListener("click", function (event) {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest) return;
      if (!target.closest("#organize-submit")) return;
      if (state.mode === "formula" && state.field) commitEditorValue(state.field, draft);
    }, true);
    document.addEventListener("submit", function (event) {
      const form = event.target;
      if (!(form instanceof Element)) return;
      const entry = state.entries.find(function (item) {
        return item.form === form;
      });
      if (entry) commitEditorValue(entry.field, entry.textarea);
    }, true);
  }

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
    bindSubmitSync();
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
