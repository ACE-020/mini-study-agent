/* 原稿渲染编辑 · MathLive 集成（真实 TeX 排版）
   把 <math-field>（static/vendor/mathlive/mathlive.min.js）挂到 #formula-editor-host。
   原稿默认直接显示「可编辑的渲染效果」，但 MathLive 字段以 text 为默认模式：
   普通英文、中文和换行按普通文字录入，只有符号键盘 / 矩阵面板明确插入的公式才进入数学模式。
   标题行右侧「撤回」「重做」共用主原稿历史。「查看原文」在可编辑 LaTeX 源与
   「查看渲染后文字」之间切换。
   #draft.value 契约不变：普通文字 + $...$ 公式段（发送/提交链路只认 #draft）。
   约束：CSP script-src 'self'，本文件不使用 eval / inline script / CDN。 */
(function () {
  "use strict";

  const VERSION = "20261120-home-math";
  const FOLLOW_VIEWS = ["organize", "review", "analysis"];
  const DRAFT_PLACEHOLDER = "在这里输入或粘贴原稿，公式会直接排版";
  const FOLLOW_PLACEHOLDER = "点下方符号键输入公式，也可以直接打字";
  const MATHLIVE_SCRIPT = "/static/vendor/mathlive/mathlive.min.js";
  const MATHLIVE_FONTS = "/static/vendor/mathlive/fonts";
  const EDITOR_SHADOW_STYLE = [
    ".ML__menu-toggle,.ML__virtual-keyboard-toggle,.ML__toggles{display:none!important}",
    ".ML__selection{box-shadow:inset 0 -1px #7667a5}",
    ".ML__content::selection,.ML__content ::selection,.ML__keyboard-sink::selection{background-color:transparent;color:inherit}"
  ].join("\n");
  // 主页主稿的软换行。MathLive 默认把内容排成一条不换行的单行：shadowRoot 里
  // .ML__content / .ML__base 全是带 white-space:pre 的单字符盒，长中文和连续英文
  // 会一直向右延伸（实测 772px 字段的 scrollWidth 到 14596px）。在真实 Chrome 里
  // 给主页主稿注入下面几条即可按字段宽度折行，公式排版照旧：同一段长文折行后
  // width / scrollWidth 都是 772，内层内容约 332px 高。
  // 只注入主页主稿；对话补充框仍是单行公式输入，不受影响。
  const WRAP_STYLE = [
    ".ML__content{align-items:start}",
    ".ML__content>.ML__latex{width:100%;min-width:0;max-width:100%;white-space:normal;overflow-wrap:anywhere}",
    ".ML__content>.ML__latex>.ML__base{display:inline;white-space:normal;overflow-wrap:anywhere}",
    ".ML__content>.ML__latex>.ML__base>.ML__text{white-space:pre-wrap;overflow-wrap:anywhere}"
  ].join("");
  const DRAFT_MAX_LENGTH = 80000;
  // formula-matrix.js 加载失败时的兜底；正常情况下读取它暴露的 maxSize，
  // 让面板输入上限与 MathLive 的 maxMatrixCols 永远一致。
  const MATRIX_MAX_SIZE_FALLBACK = 20;
  const VIEW_SOURCE = "source";
  const VIEW_RENDERED = "rendered";

  const draft = document.querySelector("#draft");
  const sourcePanel = document.querySelector("#source-panel");
  const formulaPane = document.querySelector("#formula-pane");
  const formulaHost = document.querySelector("#formula-editor-host");
  const viewToggle = document.querySelector("#draft-view-toggle");

  const state = {
    view: VIEW_SOURCE,
    field: null,     // #draft 对应的 MathLive <math-field>
    syncing: 0,      // >0 表示正在双向同步，禁止 input / onExternalChange 互相触发
    suppressExternalSync: false,
    renderedBindingsBound: false,
    typedPower: null,
    sourceCursor: { start: 0, end: 0 },
    entries: [],     // 对话补充框的公式编辑器
    docs: new WeakMap(), // <math-field> → 最近一次同步的草稿分段（保留原分隔符与换行）
    conversationId: null, // 当前编辑器里这份 #draft 属于哪个历史对话
    switching: false,    // 对话切换装载期间忽略 async MathLive input
    overflowFallback: false, // 主页主稿因不可断的超宽公式切到了原文层
    overflowGuarded: false,  // 防止回退切换自身触发下一轮检测
    initialized: false,
    fontsConfigured: false,
    scriptRequested: false
  };

  /* ---------- 通用工具 ---------- */

  // 只有真正显示在页面上的公式编辑器才是当前草稿的所有者。隐藏的编辑器只是打开时
  // 的缓存：其他脚本（对话切换、清空、程序化回填）直接改 textarea 时，旧编辑器内容
  // 绝不能在提交阶段反过来覆盖新文字（7b64a7f 的隐藏编辑器守卫）。
  function isShown(node) {
    for (let el = node; el; el = el.parentElement) {
      if (el.hidden) return false;
    }
    return true;
  }

  function mainEditorShown() {
    return state.view === VIEW_RENDERED && Boolean(state.field) && Boolean(formulaPane) && isShown(formulaPane);
  }

  function followEditorShown(entry) {
    return Boolean(entry && entry.field) && isShown(entry.pane) && isShown(entry.form);
  }

  function entryOfField(mf) {
    return state.entries.filter(function (item) {
      return item.field === mf;
    })[0] || null;
  }

  function withSync(fn) {
    state.syncing += 1;
    try {
      fn();
    } finally {
      state.syncing -= 1;
    }
  }

  function dispatchViewChange(view) {
    try {
      window.dispatchEvent(new CustomEvent("math-draft-view-change", { detail: { view: view } }));
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

  // 混合文本 → 单个 MathLive LaTeX 串。
  // 数学模式字段（对话补充框）：普通文字包 \text{}，公式去定界符后原样。
  // 文字模式字段（原稿可视编辑）：普通文字原样交给 MathLive 的 text 模式，
  // 公式显式包 $...$ / $$...$$。text 模式自己会转义 # % & _ { } ^ ~ 等字符。
  function mixedToLatex(text, textMode) {
    let out = "";
    for (const part of parseMixed(text)) {
      if (part.type === "math") {
        if (textMode) {
          const body = mathBody(part.value);
          const display = Boolean(part.block) || isDisplayMath(part.value) || /^\s*\\begin\{/.test(body);
          out += (display ? "$$" : "$") + body + (display ? "$$" : "$");
          continue;
        }
        const environment = /^\s*\\begin\{/.test(part.value);
        out += (part.block && !environment && !isDisplayMath(part.value) ? DISPLAY_STYLE : "") + part.value;
      } else if (part.value) {
        out += textMode
          ? part.value.replace(/\r\n?/g, "\n").replace(/\n/g, " ")
          : "\\text{" + escapeText(part.value) + "}";
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

  // 原稿字段默认是 MathLive 的 text 模式：文字原样输出，数学原子由 MathLive
  // 序列化成 `$ ... $` / `$$ ... $$`。这里把两种格式都还原成 text / math 段；
  // 旧版数学模式字段输出的 `\text{...}` + 裸公式仍由 parseLatexParts 处理。
  // MathLive 在 math 模式里插入 text 时会序列化成 `$ \text{...} $`。
  // 把数学段里的顶层 \text{...} 拆成普通文字，避免 `$\text{$原稿$Hello}$` 这种坏源。
  function splitTextInMath(value, display) {
    const parts = [];
    let i = 0;
    let mathStart = 0;
    while (i < value.length) {
      if (value.startsWith("\\text", i) && value[i + 5] === "{" && !isEscaped(value, i)) {
        const end = matchBrace(value, i + 5);
        if (end > i + 6) {
          const math = value.slice(mathStart, i);
          if (math.trim()) parts.push({ type: "math", value: math.trim(), display: Boolean(display) });
          parts.push({ type: "text", value: value.slice(i + 6, end) });
          i = end + 1;
          mathStart = i;
          continue;
        }
      }
      if (value[i] === "\\") i += 2;
      else i += 1;
    }
    const tail = value.slice(mathStart);
    if (tail.trim()) parts.push({ type: "math", value: tail.trim(), display: Boolean(display) });
    return parts;
  }

  function parseTextModeLatex(latex) {
    const source = String(latex == null ? "" : latex)
      .replace(/\\placeholder\{\}/g, "")
      .replace(/\\placeholder(?![A-Za-z])/g, "")
      // 空字段的幽灵 `$  $` 不能当成文字写回；若它前面没有内容，直接丢掉。
      .replace(/^\s*\$(?!\$)\s*\$(?!\$)\s*/, "");
    const parts = [];
    let i = 0;
    let textStart = 0;

    function pushText(end) {
      if (end <= textStart) return;
      const raw = source.slice(textStart, end);
      if (raw !== "") parts.push({ type: "text", value: raw });
    }

    function pushMath(start, end, contentStart, contentEnd, display) {
      pushText(start);
      const value = source.slice(contentStart, contentEnd).trim();
      if (value) {
        const pieces = value.indexOf("\\text") >= 0 ? splitTextInMath(value, display) : [{ type: "math", value: value, display: Boolean(display) }];
        parts.push.apply(parts, pieces);
      }
      i = end;
      textStart = end;
    }

    while (i < source.length) {
      const ch = source[i];
      if (ch === "\\") {
        if (source.startsWith("\\text", i) && source[i + 5] === "{") {
          const end = matchBrace(source, i + 5);
          if (end > i + 6) {
            pushText(i);
            parts.push({ type: "text", value: source.slice(i + 6, end) });
            i = end + 1;
            textStart = i;
            continue;
          }
        }
        i += 2;
        continue;
      }
      if (ch === "$" && !isEscaped(source, i)) {
        if (source.startsWith("$$", i)) {
          const end = findToken(source, i + 2, "$$", false);
          if (end > i + 2) {
            pushMath(i, end + 2, i + 2, end, true);
            continue;
          }
          i += 2;
          continue;
        }
        const end = findInlineMathEnd(source, i + 1);
        if (end >= 0) {
          pushMath(i, end + 1, i + 1, end, false);
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

  function latexToMixed(latex, textMode) {
    return partsToMixed(textMode ? parseTextModeLatex(latex) : parseLatexParts(latex));
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

  // 文字段里只有空白被 MathLive 归一化时（例如换行变空格），按非空白字符对齐，
  // 把原文的空白原样保留；用户追加/修改文字时也不吞掉前面的换行。
  function reconcileTextPart(original, currentText) {
    const originalValue = String(original.value == null ? "" : original.value);
    const current = String(currentText == null ? "" : currentText);
    if (originalValue === current) return original.raw == null ? originalValue : original.raw;
    if (sameText(originalValue, current)) return original.raw == null ? originalValue : original.raw;
    const mapping = buildTextMapping([{ type: "text", value: originalValue, raw: original.raw }]);
    const segment = mapping.segments[0];
    const rawChar = function (index) {
      return segment ? segment.raw.slice(segment.map[index], segment.map[index + 1]) : "";
    };
    let oi = 0;
    let ci = 0;
    let out = "";
    while (oi < originalValue.length && ci < current.length) {
      const oSpace = /\s/.test(originalValue[oi]);
      const cSpace = /\s/.test(current[ci]);
      if (oSpace || cSpace) {
        const oStart = oi;
        while (oi < originalValue.length && /\s/.test(originalValue[oi])) oi += 1;
        const cStart = ci;
        while (ci < current.length && /\s/.test(current[ci])) ci += 1;
        const oRun = oi - oStart;
        const cRun = ci - cStart;
        if (oRun === 0) out += current.slice(cStart, ci);
        else if (cRun === 0) {
          /* 用户删掉了空白，不输出原文空白 */
        } else if (oRun === cRun) out += rawTextRange(mapping, oStart, oi);
        else out += current.slice(cStart, ci);
        continue;
      }
      if (originalValue[oi] !== current[ci]) break;
      out += rawChar(oi);
      oi += 1;
      ci += 1;
    }
    if (oi >= originalValue.length) {
      out += current.slice(ci);
      return out;
    }
    return escapeDraftText(current);
  }

  // 段数和类型都没变：逐段对照，未变的段直接复用 raw（保留换行、$ 与 \$）。
  function reconcileSameShape(doc, parts) {
    let out = "";
    for (let i = 0; i < parts.length; i += 1) {
      const original = doc.parts[i];
      const part = parts[i];
      if (original.type === "text") {
        out += reconcileTextPart(original, unescapeText(part.value));
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
    for (const [index, part] of parts.entries()) {
      if (part.type === "text") {
        const fragment = unescapeText(part.value);
        let next = matchTextStream(mapping.text, textPos, fragment);
        if (next < 0) return null;
        // 新公式前的字面空格跟前一段文字写回；渲染视图里的换行可能也显示为空格。
        if (parts[index + 1]?.type === "math" && pairs[mathIndex] === null) {
          const spaceEnd = next + fragment.length - fragment.trimEnd().length;
          while (next < spaceEnd && mapping.text[next] === " ") next += 1;
        }
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

  // 与 formula-matrix.js 的面板上限共用一份数字。MathLive 0.111.4 默认
  // maxMatrixCols=10：超过 10 列时 2×20 会被折成多行，看着像"插入成功"但形状变了。
  // 这里在创建每个 <math-field> 时读取面板暴露的值；面板没加载时用同一个兜底 20。
  function matrixMaxSize() {
    const panel = window.formulaMatrix;
    const value = panel && Number(panel.maxSize);
    return Number.isInteger(value) && value > 0 ? value : MATRIX_MAX_SIZE_FALLBACK;
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

  function shadowStyle(wrap) {
    return EDITOR_SHADOW_STYLE + (wrap ? "\n" + WRAP_STYLE : "");
  }

  // 把外框样式（以及主页主稿的折行规则）注入 MathLive 的 shadowRoot。
  // 用 dataset 标记避免重复注入；shadowRoot 还没建好时下一帧再补一次。
  function injectShadowStyle(mf, wrap) {
    const marker = wrap ? "wrap" : "base";
    const apply = function () {
      try {
        if (!mf.shadowRoot || mf.dataset.mathliveStyle === marker) return;
        const style = document.createElement("style");
        style.textContent = shadowStyle(wrap);
        mf.shadowRoot.append(style);
        mf.dataset.mathliveStyle = marker;
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

  function isTextField(mf) {
    if (!mf) return false;
    try {
      return mf.defaultMode === "text";
    } catch (error) {
      return false;
    }
  }

  // MathLive 的 defaultMode 只决定序列化，不代表当前输入阶段就是 text。
  // setValue 用 text 解析后，model.mode 仍可能停在 math；此时用户键入的普通文字
  // 会先按数学输入处理（甚至丢掉），最后只剩一个空的 `$  $` 数学组。
  // 所以文字模式的字段在装载/回写后必须显式把当前 mode 切回 text。
  function ensureTextMode(mf) {
    if (!mf || !isTextField(mf)) return false;
    try {
      if (mf.mode === "text") return true;
    } catch (error) {
      /* 继续尝试切换 */
    }
    try {
      mf.mode = "text";
      if (mf.mode === "text") return true;
    } catch (error) {
      /* 继续尝试 executeCommand */
    }
    try {
      mf.executeCommand(["switchMode", "text"]);
      if (mf.mode === "text") return true;
    } catch (error) {
      /* 空字段时 switchMode 会因 hasEditableContent=false 直接返回，继续用临时文本引导 */
    }
    // MathLive 的 switchMode 在空字段上会直接 return（hasEditableContent=false），
    // 于是 model.mode 永远停在 math。先放入一个普通空格让字段有内容，切到 text，
    // 再清空；这样空原稿的下一次击键也会走普通文字输入。
    // 只对「空 / 幽灵空」字段做这件事，绝不能为了切模式覆盖真实内容。
    const current = getLatex(mf);
    if (current === null) return false;
    if (!isGhostMath(current) && current.trim() !== "") return false;
    withSync(function () {
      try {
        mf.setValue(" ", { mode: "text", format: "latex", insertionMode: "replaceAll" });
        mf.mode = "text";
        mf.setValue("", { mode: "text", format: "latex", insertionMode: "replaceAll" });
      } catch (error) {
        /* 忽略：保留现有内容比清空安全 */
      }
    });
    try {
      return mf.mode === "text";
    } catch (error) {
      return false;
    }
  }

  /* ---------- 分式空分支的可填占位 ---------- */

  // MathLive 0.111.4 把 `\frac{}{}` 解析成两个只有 first 原子的空分支：
  // 没有可填占位符，`.ML__frac-line` 宽度为 0；删除最后一个字符时还会因为
  // hasEmptyBranch() 把整个分式 removeChild 掉。这里只在「渲染进 MathLive」
  // 的 LaTeX 上给空分子/分母补 \placeholder{}：
  //   - #draft 与保存链路不经过这里，读取时 parseTextModeLatex / parseLatexParts
  //     仍会剔除 \placeholder，所以原文逐字不变；
  //   - 已有内容的嵌套分式只递归检查、不插入任何东西，内容不丢。
  const FRACTION_COMMANDS = ["frac", "dfrac", "tfrac", "cfrac"];
  // 只处理有限层嵌套：恶意 / 极深的 \frac 草稿不能把整段装载拖进无界递归。
  // 超过上限的更深层保持原样（MathLive 照常排版，只是不再补占位）。
  const FRACTION_SCAN_LIMIT = 24;

  function hasFractionCommand(source) {
    for (let i = 0; i < FRACTION_COMMANDS.length; i += 1) {
      if (source.indexOf("\\" + FRACTION_COMMANDS[i]) >= 0) return true;
    }
    return false;
  }

  function skipLatexSpace(source, from) {
    let i = from;
    while (i < source.length && /\s/.test(source[i])) i += 1;
    return i;
  }

  // \cfrac 允许一个可选的 [l]/[r] 对齐参数；其他分式命令没有可选参数。
  function skipOptionalBracket(source, from) {
    let i = skipLatexSpace(source, from);
    if (source[i] !== "[") return from;
    let depth = 0;
    for (; i < source.length; i += 1) {
      if (source[i] === "[") depth += 1;
      else if (source[i] === "]") {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
    }
    return from;
  }

  function injectFractionSlots(source, depth) {
    const level = depth == null ? 0 : depth;
    if (level >= FRACTION_SCAN_LIMIT || !hasFractionCommand(source)) return source;
    let out = "";
    let i = 0;
    while (i < source.length) {
      if (source[i] !== "\\" || isEscaped(source, i)) {
        out += source[i];
        i += 1;
        continue;
      }
      const match = /^\\([A-Za-z]+)/.exec(source.slice(i));
      if (!match || FRACTION_COMMANDS.indexOf(match[1]) < 0) {
        // 整段复制命令名，避免在 \fracfoo 里把 frac 当成命令。
        out += match ? match[0] : source[i];
        i += match ? match[0].length : 1;
        continue;
      }
      let cursor = i + match[0].length;
      if (match[1] === "cfrac") cursor = skipOptionalBracket(source, cursor);
      const args = [];
      let complete = true;
      for (let n = 0; n < 2; n += 1) {
        cursor = skipLatexSpace(source, cursor);
        if (source[cursor] !== "{") {
          complete = false;
          break;
        }
        const end = matchBrace(source, cursor);
        if (end < 0) {
          complete = false;
          break;
        }
        args.push({ start: cursor, end: end, body: source.slice(cursor + 1, end) });
        cursor = end + 1;
      }
      if (!complete) {
        // 不完整/非标准写法保持原样，交给 MathLive 自己报错或排版。
        out += source[i];
        i += 1;
        continue;
      }
      const fill = function (body) {
        if (!body.trim()) return "\\placeholder{}";
        const inner = injectFractionSlots(body, level + 1);
        return inner.trim() === "" ? "\\placeholder{}" : inner;
      };
      // 保留命令与两个参数之间的原始空白，只替换空参数的内容。
      out += source.slice(i, args[0].start);
      out += "{" + fill(args[0].body) + "}";
      out += source.slice(args[0].end + 1, args[1].start);
      out += "{" + fill(args[1].body) + "}";
      i = args[1].end + 1;
    }
    return out;
  }

  // text 模式的字段里，数学段由 mixedToLatex 显式包成 $...$ / $$...$$；
  // 普通文字里的 \frac 不能被当成公式（也不该出现占位符）。只处理数学段。
  function prepareFractionSlots(latex, textMode) {
    const source = String(latex == null ? "" : latex);
    if (!textMode) return injectFractionSlots(source);
    let out = "";
    let i = 0;
    while (i < source.length) {
      if (source[i] !== "$" || isEscaped(source, i)) {
        out += source[i];
        i += 1;
        continue;
      }
      if (source.startsWith("$$", i)) {
        const end = findToken(source, i + 2, "$$", false);
        if (end > i + 2) {
          out += "$$" + injectFractionSlots(source.slice(i + 2, end)) + "$$";
          i = end + 2;
          continue;
        }
        out += "$$";
        i += 2;
        continue;
      }
      const end = findInlineMathEnd(source, i + 1);
      if (end >= 0) {
        out += "$" + injectFractionSlots(source.slice(i + 1, end)) + "$";
        i = end + 1;
        continue;
      }
      out += "$";
      i += 1;
    }
    return out;
  }

  function setLatex(mf, latex) {
    if (!mf) return;
    if (mf === state.field) state.typedPower = null;
    const textMode = isTextField(mf);
    if (textMode) ensureTextMode(mf);
    const prepared = prepareFractionSlots(latex || "", textMode);
    withSync(function () {
      try {
        mf.setValue(prepared, {
          mode: textMode ? "text" : "math",
          format: "latex",
          insertionMode: "replaceAll"
        });
      } catch (error) {
        try {
          mf.setValue("", { mode: textMode ? "text" : "math", format: "latex" });
        } catch (ignored) {
          /* 忽略 */
        }
      }
      if (textMode && !latex) {
        try {
          mf.executeCommand("deleteAll");
        } catch (ignored) {
          /* 忽略：没有 deleteAll 命令时保留空 root */
        }
      }
    });
    // setValue 的 text 解析不会更新 model.mode；这里再收回 text，保证下一次击键
    // 是普通文字而不是数学字符。
    if (textMode) ensureTextMode(mf);
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
    return latex === null ? null : latexToMixed(latex, isTextField(mf));
  }

  function createEditor(host, textarea, placeholder, defaultMode, options) {
    if (!host || !mathfieldClass()) return null;
    configureFonts();
    // wrap：主页主稿是长文正文，需要注入 MathLive 的软换行规则；补充框仍是单行。
    const wrap = Boolean(options && options.wrap);
    const maxMatrixCols = matrixMaxSize();
    let mf = null;
    try {
      mf = document.createElement("math-field");
      // default-mode 必须在 append 前写入：MathLive 在 connectedCallback 里读属性建 model。
      // append 后再设置，空字段 getValue() 会变成幽灵 `$  $`，且 model.mode 停在 math。
      if (defaultMode === "text") mf.setAttribute("default-mode", "text");
      // 与矩阵面板的上限同步；属性在 append 前写入，connectedCallback 建 model 时就能读到。
      mf.setAttribute("max-matrix-cols", String(maxMatrixCols));
      mf.setAttribute("tabindex", "0");
      host.append(mf);
    } catch (error) {
      return null;
    }
    try {
      if (defaultMode === "text" && mf.defaultMode !== "text") mf.defaultMode = "text";
      mf.setAttribute("aria-label", defaultMode === "text" ? "原稿渲染编辑区" : "公式输入");
      mf.placeholder = placeholder;
      mf.mathVirtualKeyboardPolicy = "manual"; // 不弹它自带的虚拟键盘，用我们的符号键盘
      mf.smartMode = false;
      mf.smartFence = false;
      // 属性路径在部分版本只影响静态 render；再走一次 setter（0.111.4 已确认可用）。
      mf.maxMatrixCols = maxMatrixCols;
    } catch (error) {
      /* 属性名随版本变化时忽略 */
    }
    injectShadowStyle(mf, wrap);
    bindBoundDeletionGuard(mf, textarea);
    mf.addEventListener("input", function () {
      handleFieldChange(mf, textarea);
    });
    state.docs.set(mf, parseDoc(textarea ? textarea.value : ""));
    setLatex(mf, mixedToLatex(textarea ? textarea.value : "", defaultMode === "text"));
    setReadOnly(mf, textarea ? textarea.readOnly || textarea.disabled : false);
    return mf;
  }

  // MathLive 在 text 模式但 model.mode=math 的空字段上会序列化出 `$  $`。
  // 它不是用户内容；若草稿也是空的，直接按空处理，绝不能写成 `\$  \$`。
  function isGhostMath(latex) {
    return /^\$\s*\$$/.test(String(latex == null ? "" : latex).trim());
  }

  function mixedFromEditor(mf, textarea) {
    const latex = getLatex(mf);
    if (latex === null) return null;
    if (isTextField(mf) && isGhostMath(latex)) {
      return textarea ? textarea.value : "";
    }
    const doc = state.docs.get(mf) || parseDoc(textarea ? textarea.value : "");
    return reconcileDoc(doc, isTextField(mf) ? parseTextModeLatex(latex) : parseLatexParts(latex));
  }

  // 公式编辑器 → textarea：#draft.value 始终是「普通文字 + $...$」
  function handleFieldChange(mf, textarea) {
    if (state.syncing || state.switching || !mf || !textarea) return;
    // 只有可见的编辑器才拥有对应的 textarea。对话切换会换掉 #draft 的全部内容，
    // 上一个对话（或已收起的补充框）里迟到的异步 input 绝不能回写进新对话的草稿。
    const owner = entryOfField(mf);
    if (owner ? !followEditorShown(owner) : !mainEditorShown()) return;
    // 主稿内容一变，折行行数就可能变：下一帧重算输入区高度。
    if (mf === state.field) scheduleHeightSync();
    // 原文视图下 #draft 是权威来源。隐藏的 MathLive 仍可能因 setLatex 的异步
    // input 走到这里，把归一化后的公式（以及末尾光标）回写覆盖 textarea，
    // 所以主稿处于 source 时绝不从隐藏编辑器回写；切回渲染时 setView 会重新装载。
    if (mf === state.field && state.view === VIEW_SOURCE) return;
    const mixed = mixedFromEditor(mf, textarea);
    if (mixed === null || textarea.value === mixed) return;
    state.docs.set(mf, parseDoc(mixed));
    withSync(function () {
      textarea.value = mixed;
      // 必须派发 input：app.js 的 #draft-count / 发送按钮 / 待发送队列都靠它更新
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    if (mf === state.field) scheduleHeightSync();
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
    state.field = createEditor(formulaHost, draft, DRAFT_PLACEHOLDER, "text", { wrap: true });
    if (!state.field) {
      // MathLive 没加载成功：保留可编辑的 LaTeX 源，禁用视图切换按钮并说明原因。
      if (viewToggle) {
        viewToggle.disabled = true;
        viewToggle.title = "公式编辑器未就绪，请刷新页面后重试";
      }
      return false;
    }
    window.mathInputMode.field = state.field;
    bindRenderedEditing(state.field);
    if (viewToggle) viewToggle.disabled = false;
    if (window.MutationObserver) {
      // app.js 在 updateButtons() 里设置 #draft.readOnly，这里把只读状态镜像到 MathLive，
      // 同时刷新撤回 / 重做的可用状态（忙碌时两者都禁用）。
      const observer = new MutationObserver(function () {
        setReadOnly(state.field, draft.readOnly || draft.disabled);
        updateHistoryButtons();
      });
      observer.observe(draft, { attributes: true, attributeFilter: ["readonly", "disabled"] });
    }
    return true;
  }

  function updateViewUi() {
    const rendered = state.view === VIEW_RENDERED;
    sourcePanel.classList.toggle("draft-view-rendered", rendered);
    sourcePanel.classList.toggle("draft-view-source", !rendered);
    formulaPane.hidden = !rendered;
    if (!viewToggle) return;
    viewToggle.textContent = rendered ? "查看原文" : "查看渲染后文字";
    viewToggle.setAttribute("aria-pressed", rendered ? "false" : "true");
    viewToggle.title = rendered ? "查看可编辑的 LaTeX 原文" : "查看渲染后的原稿";
    if (!rendered && state.overflowFallback) {
      // 自动回退时说明原因：这段内容在渲染态放不下，原文层才是可折行、可编辑的。
      viewToggle.title =
        "这段内容里有比输入区更宽的公式，已切到原文：可折行、可编辑，也能继续插符号";
    }
  }

  function rememberSourceCursor() {
    if (!draft) return;
    state.sourceCursor = {
      start: draft.selectionStart == null ? 0 : draft.selectionStart,
      end: draft.selectionEnd == null ? state.sourceCursor.end : draft.selectionEnd
    };
  }

  function focusVisibleEditor() {
    if (state.view === VIEW_RENDERED && state.field) {
      focusEditor(state.field);
      return true;
    }
    try {
      draft.focus();
      const max = draft.value.length;
      draft.setSelectionRange(Math.min(state.sourceCursor.start, max), Math.min(state.sourceCursor.end, max));
    } catch (error) {
      /* 忽略：部分输入类型不支持 setSelectionRange */
    }
    return true;
  }

  function setView(view, options) {
    const target = view === VIEW_RENDERED ? VIEW_RENDERED : VIEW_SOURCE;
    if (target === VIEW_RENDERED && !state.field) {
      updateViewUi();
      return false;
    }
    if (target === state.view) {
      if (options && options.focus) focusVisibleEditor();
      updateViewUi();
      return true;
    }
    if (state.field) {
      if (target === VIEW_SOURCE) {
        // 只把编辑器里尚未写回的内容落下；已经同步时不会改动 #draft 一字。
        rememberSourceCursor();
        commitEditorValue(state.field, draft);
        state.docs.set(state.field, parseDoc(draft.value));
      } else {
        state.docs.set(state.field, parseDoc(draft.value));
        setLatex(state.field, mixedToLatex(draft.value, true));
        setReadOnly(state.field, draft.readOnly || draft.disabled);
      }
    }
    state.view = target;
    updateViewUi();
    if (options && options.focus) focusVisibleEditor();
    scheduleHeightSync();
    dispatchViewChange(target);
    return true;
  }

  function bindViewToggle() {
    if (!viewToggle) return;
    viewToggle.addEventListener("click", function (event) {
      event.preventDefault();
      setView(state.view === VIEW_RENDERED ? VIEW_SOURCE : VIEW_RENDERED, { focus: true });
    });
  }

  // app.js 在 updateDraft() 末尾调用：把「OCR 写入 / 清空 / 提交后修改」同步进编辑器。
  // 原稿是普通文字优先：文字模式下只在外部值确实不同时才重设 MathLive，避免打断打字。
  function onExternalChange() {
    // OCR / 清空 / 程序化回填不经过 input，但按钮可用状态要跟着变。
    updateHistoryButtons();
    scheduleHeightSync();
    if (!state.field || state.syncing || state.suppressExternalSync) return;
    // 原文视图直接以 textarea 为准；隐藏 MathLive 的装载/归一化只会造成
    // 「异步 input → 覆盖原文和光标」的回路。切回渲染时 setView 会从 textarea 重新装载。
    if (state.view === VIEW_SOURCE) return;
    const doc = parseDoc(draft.value);
    if (state.view === VIEW_RENDERED) {
      const currentLatex = getLatex(state.field);
      if (isTextField(state.field) && isGhostMath(currentLatex)) {
        // 空字段的幽灵 math 组会让编辑器看起来有内容、实际是空的；
        // 有草稿就重建，没有草稿就清掉幽灵组，避免它写回 #draft。
        state.docs.set(state.field, doc);
        setLatex(state.field, draft.value ? mixedToLatex(draft.value, true) : "");
        return;
      }
      const mixed = mixedFromEditor(state.field, draft);
      if (mixed === null || mixed === draft.value) return;
    }
    state.docs.set(state.field, doc);
    const latex = mixedToLatex(draft.value, true);
    if (getLatex(state.field) !== latex) setLatex(state.field, latex);
  }

  /* ---------- 输入区高度：随内容长高，触到视口边界后只让输入区滚动 ---------- */

  // 三条约束：
  //  1) 内容够多才随行逐渐向下撑高（MathLive 软换行后内容是多行，字段本身随内容长高）；
  //  2) 保留顶部空间与「所在集合」：首屏整组贴顶时，以集合行（.home-compose-meta）的
  //     末边为准，留 pageMargin 的页面边距就停止增高；已有消息时输入区贴底，
  //     顶部对话区保留 topReserve 的空间；
  //  3) 到上限后只让输入区出现纵向滚动：渲染视图把 max-height 加到 math-field 上
  //     （MathLive 的 caret 跟随读的就是 host.scrollTop），原文视图按 scrollHeight
  //     设 height 并让 textarea 自己滚动。
  // 不设固定高度天花板：大视口里内容够长就继续长到集合行接近视口底部。
  const HEIGHT = Object.freeze({
    bottomGap: 10,
    pageMargin: 10,
    topReserve: 96,
    minRendered: 120,
    minSource: 44
  });

  const composerWrap = document.querySelector(".home-composer-wrap");
  const composeMeta = document.querySelector(".home-compose-meta");
  const chatBody = document.querySelector(".home-chat-body");
  const panelsRoot = document.querySelector("#organize-workspace");

  function viewportHeight() {
    const visual = window.visualViewport ? Number(window.visualViewport.height) : 0;
    const height = visual || Number(window.innerHeight) || 0;
    if (height > 0) return height;
    const html = document.documentElement;
    return Math.max(0, (html && html.clientHeight) || 0);
  }

  function homeEmptyLayout() {
    return Boolean(
      panelsRoot &&
        panelsRoot.dataset &&
        String(panelsRoot.dataset.homeEmpty) === "true"
    );
  }

  // 纯函数（便于自测）：rect 是输入区自身的矩形，wrapBottom 是输入区外框底边，
  // bodyTop 是对话区顶边，metaBottom 是「所在集合」行的末边。
  // empty=true：以集合行末边为准，留 pageMargin 就停（没有 metaBottom 时退回用
  // wrap 底边推算）；empty=false：输入区顶边不低于对话区顶 + topReserve。
  // 结果不设固定天花板，只保证一个可用下限。
  function editorHeightCap(input) {
    if (!input || !input.rect) return 0;
    const rect = input.rect;
    const viewport = Number(input.viewportHeight) || 0;
    const pageMargin = input.pageMargin == null ? HEIGHT.pageMargin : Number(input.pageMargin);
    const bottomGap = input.bottomGap == null ? HEIGHT.bottomGap : Number(input.bottomGap);
    const topReserve = input.topReserve == null ? HEIGHT.topReserve : Number(input.topReserve);
    const minHeight = input.minHeight == null ? HEIGHT.minRendered : Number(input.minHeight);
    const wrapBottom = Number(input.wrapBottom);
    const metaBottom = Number(input.metaBottom);
    const below = Number.isFinite(wrapBottom) ? Math.max(0, wrapBottom - rect.bottom) : 0;
    let cap;
    if (input.empty) {
      if (Number.isFinite(metaBottom)) {
        // 集合行跟着输入区一起向下走：可用高度 = 当前高度 + 集合行还能下移的距离。
        cap = rect.height + (viewport - pageMargin - metaBottom);
      } else {
        cap = viewport - below - rect.top - bottomGap;
      }
    } else {
      cap = rect.bottom - (Number(input.bodyTop) || 0) - topReserve;
    }
    return Math.max(Math.round(minHeight), Math.round(cap));
  }

  let heightFrame = 0;

  function scheduleHeightSync() {
    if (heightFrame) return;
    const raf = window.requestAnimationFrame || function (fn) {
      return window.setTimeout(fn, 16);
    };
    heightFrame = raf(function () {
      heightFrame = 0;
      syncHeightNow();
      checkOverflowFallback();
    });
  }

  function syncHeightNow() {
    if (!draft || !composerWrap || !composerWrap.getBoundingClientRect) return;
    const viewport = viewportHeight();
    if (!viewport) return;
    const wrapRect = composerWrap.getBoundingClientRect();
    if (!wrapRect || (!wrapRect.width && !wrapRect.height)) return;
    const bodyRect =
      chatBody && chatBody.getBoundingClientRect ? chatBody.getBoundingClientRect() : null;
    const metaRect =
      composeMeta && composeMeta.getBoundingClientRect
        ? composeMeta.getBoundingClientRect()
        : null;
    const base = {
      viewportHeight: viewport,
      wrapBottom: wrapRect.bottom,
      bodyTop: bodyRect ? bodyRect.top : 0,
      metaBottom: metaRect ? metaRect.bottom : undefined,
      empty: homeEmptyLayout()
    };
    if (state.view === VIEW_RENDERED && state.field) {
      const rect = state.field.getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) return;
      const cap = editorHeightCap(
        Object.assign({ rect: rect, minHeight: HEIGHT.minRendered }, base)
      );
      state.field.style.maxHeight = cap + "px";
      draft.style.height = "";
      return;
    }
    // 原文视图：#draft 在渲染视图里是 display:none，量不到就跳过。
    draft.style.height = "auto";
    const rect = draft.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return;
    const cap = editorHeightCap(
      Object.assign({ rect: rect, minHeight: HEIGHT.minSource }, base)
    );
    const natural = Math.max(HEIGHT.minSource, draft.scrollHeight || 0);
    draft.style.height = Math.min(natural, cap) + "px";
  }

  function bindEditorHeight() {
    window.addEventListener("resize", scheduleHeightSync);
    if (window.visualViewport && window.visualViewport.addEventListener) {
      window.visualViewport.addEventListener("resize", scheduleHeightSync);
      window.visualViewport.addEventListener("scroll", scheduleHeightSync);
    }
    if (draft) {
      // IME 组合期间也会触发 input；统一走 rAF 节流，不打断输入法。
      draft.addEventListener("input", scheduleHeightSync);
      draft.addEventListener("compositionend", scheduleHeightSync);
    }
    // 左右面板收展 / 窗口变化都会改变可用宽度：宽度一变，换行行数就变。
    if (composerWrap && typeof window.ResizeObserver === "function") {
      try {
        const observer = new ResizeObserver(function () {
          scheduleHeightSync();
        });
        observer.observe(composerWrap);
      } catch (error) {
        /* 观察器不可用时只靠 resize 事件 */
      }
    }
    if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === "function") {
      document.fonts.ready.then(scheduleHeightSync).catch(function () {});
    }
    scheduleHeightSync();
  }

  /* ---------- 主页主稿：不可断的超宽数学盒 → 复用「原文」作为可编辑回退 ---------- */

  // 注入软换行后，长中文 / 连续英文 / 混排都会折行；只有单个不可断的数学盒
  // （例如超宽矩阵）仍会比字段宽。主页不允许出现横向滚动条，也不把公式硬剪掉：
  // 检测到真正需要横滚的内容时，自动切到已有的「原文」编辑层（LaTeX 原文 + 原生
  // 折行），原稿、焦点和符号插入继续可用。正常尺寸公式不动，仍在渲染编辑态；
  // 专门的公式面板与其他页面维持旧的横向滚动行为。
  const OVERFLOW_TOLERANCE = 2;

  function contentOverflows(mf) {
    if (!mf || !mf.shadowRoot || typeof mf.shadowRoot.querySelector !== "function") {
      return false;
    }
    const content = mf.shadowRoot.querySelector(".ML__content");
    if (!content) return false;
    const scroll = Number(content.scrollWidth) || 0;
    const client = Number(content.clientWidth) || 0;
    if (!scroll || !client) return false;
    return scroll > client + OVERFLOW_TOLERANCE;
  }

  function checkOverflowFallback() {
    if (state.switching) return false;
    const emptyDraft = !draft.value.trim();
    // 窄屏中占位说明本身也会超宽；只有用户的原稿可以触发回退。
    if (emptyDraft || state.view !== VIEW_RENDERED || !state.field) {
      if (state.overflowFallback && emptyDraft) {
        state.overflowFallback = false;
        updateViewUi();
      }
      return false;
    }
    if (!contentOverflows(state.field)) {
      if (state.overflowFallback) {
        state.overflowFallback = false;
        updateViewUi();
      }
      return false;
    }
    if (state.overflowGuarded) return false;
    state.overflowGuarded = true;
    state.overflowFallback = true;
    // 只有编辑器当前真的持有焦点时才把焦点一起搬到原文层；
    // 窗口缩小 / 加载旧对话等被动触发的检测只切视图，绝不抢走别的控件（对话框、下拉框）的焦点。
    const heldFocus = isMainDraftFocus();
    try {
      // 原文层是同一份 #draft：切过去后 LaTeX 原文可折行、可编辑、可继续插符号。
      setView(VIEW_SOURCE, { focus: heldFocus });
      updateViewUi();
    } finally {
      state.overflowGuarded = false;
    }
    return true;
  }



  // 与 MathLive 实体方向键使用同一组命令：实体键的 ArrowLeft/Right 走
  // moveToPreviousChar / moveToNextChar（逐字符、可跨矩阵格），而不是占位符跳转。
  // 这样屏幕按钮和手机触控按钮都不会再停在「已填格」里不动。
  const MOVE_COMMANDS = {
    left: "moveToPreviousChar",
    right: "moveToNextChar",
    up: "moveUp",
    down: "moveDown"
  };

  // 只认真正持有焦点的 <math-field>；符号面板虽然也在 .formula-editor-host 里，
  // 但面板按钮获得焦点时不能把实体 Up/Down 抢去移动公式光标。
  function resolveFocusedEditor() {
    const active = document.activeElement;
    if (!active) return null;
    if (state.field && active === state.field) return state.field;
    for (const entry of state.entries) {
      if (active === entry.field) return entry.field;
    }
    return null;
  }

  function resolveEditor() {
    const focused = resolveFocusedEditor();
    if (focused) return focused;
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
    if (state.view === VIEW_RENDERED && state.field) return state.field;
    return null;
  }

  function focusEditor(mf) {
    const target = mf || resolveEditor();
    if (!target) return false;
    // 真实 Chrome 的已验证路径就是 math-field.focus()：它会聚焦 shadowRoot 里的
    // .ML__keyboard-sink。只有 sink 仍没拿到焦点时，才直接补聚焦。
    try {
      const sink = target.shadowRoot && target.shadowRoot.querySelector(".ML__keyboard-sink");
      if (sink && target.shadowRoot.activeElement === sink) return true;
    } catch (error) {
      /* 继续 */
    }
    try {
      if (typeof target.focus === "function") target.focus();
    } catch (error) {
      /* 继续尝试 sink */
    }
    try {
      const sink = target.shadowRoot && target.shadowRoot.querySelector(".ML__keyboard-sink");
      if (sink) {
        if (target.shadowRoot.activeElement === sink) return true;
        sink.focus({ preventScroll: true });
        return target.shadowRoot.activeElement === sink;
      }
    } catch (error) {
      /* 忽略 */
    }
    try {
      const active = document.activeElement;
      return active === target || Boolean(target.contains && active && target.contains(active));
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

  // 兼容：{template} / 旧版 {type,...} 规格 → MathLive insert 模板。
  // 微积分可视化键走 chipTemplate → insertChip({template})，不经过这些旧 type；
  // 这里保持既有 type 的原始语义（尤其 int 的上下界和 lim 的下标），不新增别名。
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

  function modelFor(mf) {
    try {
      const internal = mf && mf._mathfield;
      return internal && internal.model ? internal.model : null;
    } catch (error) {
      return null;
    }
  }

  function positionOf(mf) {
    try {
      return typeof mf.position === "number" ? mf.position : null;
    } catch (error) {
      return null;
    }
  }

  /* ---------- 微积分模板界槽的删除保护 ---------- */

  // MathLive 0.111.4 的 To() 在界槽只剩 first/placeholder 时，会把整个分支
  // removeBranch() 掉；光标随后移出公式，下一次键入就变成普通文字。
  // MathLive 的 gp/bp 删除路径都会先走 contentWillChange → 宿主上派发
  // cancelable beforeinput，因此在这里只拦「删除会清空一个既有界槽」的情况：
  // 普通 i=、数字、有内容的选区仍然照常删除；不定积分原本没有界，也不会被新建。
  // \lim 的趋近条件和带底数对数的底数是各自模板唯一的界槽；手打的
  // \lim^ / \log^ 不是模板结构，不在这里保护，仍可正常退格删除。
  const CALCULUS_BOUND_COMMANDS = {
    "\\int": { subscript: true, superscript: true },
    "\\sum": { subscript: true, superscript: true },
    "\\prod": { subscript: true, superscript: true },
    "\\lim": { subscript: true },
    "\\log": { subscript: true }
  };

  function calculusBoundOf(atom) {
    if (!atom) return null;
    const branch = atom.parentBranch;
    if (branch !== "subscript" && branch !== "superscript") return null;
    const parent = atom.parent;
    const allowed = parent && CALCULUS_BOUND_COMMANDS[parent.command];
    if (!allowed || !allowed[branch]) return null;
    return { parent: parent, branch: branch };
  }

  // 分支数组含 first atom；只剩 first/placeholder 时删除会丢槽。
  function boundHasOnlyEmptySlots(info) {
    if (!info) return false;
    const atoms = info.parent.branch(info.branch);
    if (!Array.isArray(atoms)) return false;
    return atoms.every(function (atom) {
      return atom.type === "first" || atom.type === "placeholder";
    });
  }

  function deletionWouldDropBound(mf) {
    const model = modelFor(mf);
    if (!model) return false;
    const ranges = model.selection && model.selection.ranges;
    if (!Array.isArray(ranges) || ranges.length !== 1) return false;
    const range = ranges[0];
    if (!Array.isArray(range)) return false;
    const start = Math.min(range[0], range[1]);
    const end = Math.max(range[0], range[1]);

    if (start !== end) {
      // 只有「整个选区都落在同一个空界里，且只有 first/placeholder」才拦；
      // 选中真实内容、跨界或整条公式都放行。
      let atoms = [];
      try {
        atoms = model.getAtoms([start, end]);
      } catch (error) {
        return false;
      }
      if (!atoms.length) return false;
      const firstInfo = calculusBoundOf(atoms[0]);
      const lastInfo = calculusBoundOf(atoms[atoms.length - 1]);
      if (!firstInfo || !lastInfo || firstInfo.parent !== lastInfo.parent || firstInfo.branch !== lastInfo.branch) {
        return false;
      }
      if (!boundHasOnlyEmptySlots(firstInfo)) return false;
      return atoms.every(function (atom) {
        return atom.type === "first" || atom.type === "placeholder";
      });
    }

    // 折叠光标只检查光标前的 atom（MathLive position 的语义）：它在空界里才拦。
    // 不检查左/右邻居，避免正文 x 的 Backspace 被相邻空界误伤。
    return boundHasOnlyEmptySlots(calculusBoundOf(model.at(start)));
  }

  // \log 的底数还有一个 MathLive 自身的特判：To() 在 backward 删除下标里的
  // 任意 atom 时会直接删掉整个 \log（连底数带正文）。不能靠禁止删除底数绕开：
  // 先把折叠光标移到目标 atom 的左侧哨兵，再执行原生 deleteForward。它不走
  // 这个特判，只删掉当前字符、保留空下标，并照常进入撤销栈。
  function rescueLogBaseDeletion(mf, event) {
    const model = modelFor(mf);
    if (!model || !model.selectionIsCollapsed) return false;
    const ranges = model.selection && model.selection.ranges;
    if (!Array.isArray(ranges) || ranges.length !== 1) return false;
    const range = ranges[0];
    if (!Array.isArray(range) || range[0] !== range[1]) return false;
    const target = model.at(range[0]);
    if (!target || target.type === "placeholder") return false;
    const parent = target.parent;
    if (!parent || parent.command !== "\\log" || target.parentBranch !== "subscript") return false;
    // 光标停在下标起点（first）时前面没有可删字符；MathLive 的 To() 特判仍会
    // 把整个 \log 删掉。这里直接拦下，光标留在下标里，不能删本体。
    if (target.type === "first") {
      event.preventDefault();
      return true;
    }
    const left = target.leftSibling;
    if (!left) return false;
    event.preventDefault();
    try {
      model.position = model.offsetOf(left);
      mf.executeCommand("deleteForward");
    } catch (error) {
      return false;
    }
    return true;
  }

  // 选中「整个」lim/log 下标时，MathLive 的 ct() 会把这个下标所在的运算符
  // 一并扩展删除。用占位符替换选区：运算符和空槽保留，后续输入直接填入，
  // 撤销仍能恢复原底数 / 趋近条件。只匹配这两个模板的单下标槽；起点必须是
  // 下标 first，且选区边界与 getBranchRange 完全一致（含下标里的嵌套原子）。
  function rescueWholeBoundSelection(mf, event) {
    const model = modelFor(mf);
    if (!model || model.selectionIsCollapsed) return false;
    const ranges = model.selection && model.selection.ranges;
    if (!Array.isArray(ranges) || ranges.length !== 1) return false;
    const range = ranges[0];
    if (!Array.isArray(range)) return false;
    const start = Math.min(range[0], range[1]);
    const end = Math.max(range[0], range[1]);
    const info = calculusBoundOf(model.at(start));
    if (!info || info.branch !== "subscript") return false;
    if (info.parent.command !== "\\lim" && info.parent.command !== "\\log") return false;
    const bounds = branchRange(model, info.parent, info.branch);
    if (!bounds || bounds[0] !== start || bounds[1] !== end) return false;
    event.preventDefault();
    try {
      mf.insert("\\placeholder{}", {
        format: "latex",
        mode: "math",
        insertionMode: "replaceSelection",
        selectionMode: "placeholder"
      });
    } catch (error) {
      return false;
    }
    return true;
  }

  // MathLive 的 genfrac 用 above/below 两个分支保存分子/分母，空分支只有
  // first 原子。删除 / 清空最后一个内容 atom 时 To() 会直接 removeChild，
  // 两侧都空时还会连整个分式一起删；ct() 选中整个分支时也会扩展到父分式。
  // 这里把「删除后该分支将没有内容」的那一次删除换成可填占位符：
  // 横线宽度保留、可以继续输入、MathLive 的原生撤销仍能恢复被删内容。
  function fractionBranchOf(atom) {
    if (!atom || atom.type === "first") return null;
    const branch = atom.parentBranch;
    if (branch !== "above" && branch !== "below") return null;
    const parent = atom.parent;
    if (!parent || parent.type !== "genfrac") return null;
    return { parent: parent, branch: branch };
  }

  function fractionBranchAtoms(info) {
    if (!info) return [];
    const atoms = info.parent.branch(info.branch);
    if (!Array.isArray(atoms)) return [];
    return atoms.filter(function (atom) {
      return atom.type !== "first";
    });
  }

  function replaceSelectionWithSlot(mf, start, end) {
    try {
      mf.selection = { ranges: [[start, end]], direction: "forward" };
    } catch (error) {
      return false;
    }
    try {
      mf.insert("\\placeholder{}", {
        format: "latex",
        mode: "math",
        insertionMode: "replaceSelection",
        selectionMode: "placeholder"
      });
      return true;
    } catch (error) {
      return false;
    }
  }

  // 返回 "blocked"（只拦下，不动内容）、"rescued"（已换成占位符，需要回写）
  // 或 false（不是分式空分支删除，交给 MathLive 原生路径）。
  function guardFractionDeletion(mf, event, forward) {
    const model = modelFor(mf);
    if (!model) return false;
    const ranges = model.selection && model.selection.ranges;
    if (!Array.isArray(ranges) || ranges.length !== 1) return false;
    const range = ranges[0];
    if (!Array.isArray(range)) return false;
    const start = Math.min(range[0], range[1]);
    const end = Math.max(range[0], range[1]);

    if (start !== end) {
      let atoms = [];
      try {
        atoms = model.getAtoms([start, end]);
      } catch (error) {
        return false;
      }
      atoms = atoms.filter(function (atom) {
        return atom.type !== "first";
      });
      if (!atoms.length) return false;
      const info = fractionBranchOf(atoms[0]);
      if (!info) return false;
      const content = fractionBranchAtoms(info);
      // 只有「选区恰好覆盖这个分支的全部内容」才接管；局部选区 / 跨分支 /
      // 整条公式仍走原生删除（整段选中删除分式必须照常工作）。
      if (content.length !== atoms.length) return false;
      const selected = new Set(atoms);
      if (content.some(function (atom) { return !selected.has(atom); })) return false;
      event.preventDefault();
      if (atoms.every(function (atom) { return atom.type === "placeholder"; })) return "blocked";
      return replaceSelectionWithSlot(mf, start, end) ? "rescued" : "blocked";
    }

    let target = null;
    try {
      const cursor = model.at(start);
      target = forward ? (cursor ? cursor.rightSibling : null) : cursor;
    } catch (error) {
      return false;
    }
    const info = fractionBranchOf(target);
    if (!info) return false;
    const content = fractionBranchAtoms(info);
    if (target.type === "placeholder") {
      // 分支里只剩占位符时，Backspace / Delete 不能把槽位本身删掉。
      if (content.every(function (atom) { return atom.type === "placeholder"; })) {
        event.preventDefault();
        return "blocked";
      }
      return false;
    }
    if (content.length !== 1 || content[0] !== target) return false;
    event.preventDefault();
    let after = 0;
    let before = 0;
    try {
      after = model.offsetOf(target);
      before = target.leftSibling ? model.offsetOf(target.leftSibling) : 0;
    } catch (error) {
      return "blocked";
    }
    return replaceSelectionWithSlot(mf, before, after) ? "rescued" : "blocked";
  }

  function bindBoundDeletionGuard(mf, textarea) {
    if (!mf) return;
    mf.addEventListener("beforeinput", function (event) {
      const type = event && event.inputType;
      if (type !== "deleteContentBackward" && type !== "deleteContentForward") return;
      // 空界占位符（包括重复删除已选中的空占位符）直接拦下：不换成新占位符，
      // 也不往撤销栈里加一步。有内容的删除才交给下面两条窄路径。
      if (deletionWouldDropBound(mf)) {
        event.preventDefault();
        return;
      }
      const fraction = guardFractionDeletion(mf, event, type === "deleteContentForward");
      if (fraction) {
        if (fraction === "rescued" && textarea) handleFieldChange(mf, textarea);
        return;
      }
      // beforeinput 里嵌套执行 MathLive 操作时 silenceNotifications 会吞掉 input，
      // #draft 仍停在删除前的值；操作成功后复用既有回写路径补一次同步。
      let changed = false;
      if (type === "deleteContentBackward") changed = rescueLogBaseDeletion(mf, event);
      if (!changed) changed = rescueWholeBoundSelection(mf, event);
      if (changed && textarea) handleFieldChange(mf, textarea);
    });
  }

  // MathLive 0.111.4 的 position 指向光标前的 atom；getBranchRange 返回
  // [首 atom, 末 atom] 的偏移，末 atom 的位置就是界尾。只在这里做一次 try/fallback。
  function branchRange(model, atom, name) {
    try {
      if (!atom.branch(name)) return null;
      const range = model.getBranchRange(model.offsetOf(atom), name);
      return Array.isArray(range) ? range : null;
    } catch (error) {
      return null;
    }
  }

  // moveUp / moveDown 只处理 above/below 和矩阵行，不会在积分、求和的上下界之间
  // 切换。这里只补：下界按上 → 上界，上界按下 → 下界；两个界都必须已存在，
  // 不凭空创建缺失的界。屏幕按钮和实体键共用同一函数。
  function moveAcrossBounds(mf, dir) {
    if (dir !== "up" && dir !== "down") return false;
    const model = modelFor(mf);
    if (!model) return false;
    const position = positionOf(mf);
    if (position === null) return false;
    let atom = null;
    try {
      atom = model.at(position);
      // 模板插入后默认选中的是下界 placeholder（选区 [p-1,p]）。此时 position
      // 可能落在选区末端，先按选区里真正选中的 placeholder 找回所在分支，
      // 才能一次 ↑ 从下界直接切到上界，而不是被原生 moveUp 收成折叠光标。
      if (model.selectionIsPlaceholder) {
        atom = model.at(Math.max(model.anchor, model.position));
      }
    } catch (error) {
      return false;
    }
    const branch = atom && atom.parentBranch;
    if (branch !== "superscript" && branch !== "subscript") return false;
    const targetName = dir === "up" ? "superscript" : "subscript";
    if (branch === targetName) return false;
    const parent = atom.parent;
    if (!parent) return false;
    const current = branchRange(model, parent, branch);
    const target = branchRange(model, parent, targetName);
    if (!current || !target) return false;
    // 同界内保留字符偏移；目标界更短时贴到界尾。
    const offset = Math.max(0, position - current[0]);
    const next = Math.min(target[0] + offset, target[1]);
    try {
      model.position = next;
      if (model.mathfield && typeof model.mathfield.stopCoalescingUndo === "function") {
        model.mathfield.stopCoalescingUndo();
      }
      if (typeof model.announce === "function") model.announce("move");
      return true;
    } catch (error) {
      return false;
    }
  }

  function moveCursor(dir, mf) {
    const target = mf || resolveEditor();
    if (!target || !MOVE_COMMANDS[dir]) return false;
    focusEditor(target);
    // executeCommand 在「没有可移动目标」时也可能返回 true（例如 moveUp 在行首
    // 只广播 move-out），所以移动成功与否必须比较真实光标位置，不能只看返回值。
    const before = positionOf(target);
    // 上下键先试同算符的既有另一界：选中下界 placeholder 时原生 moveUp 只会
    // 把选区收成折叠光标，position 变了但并没有离开下界。只有 moveAcrossBounds
    // 真的匹配到同一算符的另一界才直接处理；矩阵、分数和普通上下标仍走原生。
    let crossed = false;
    if (dir === "up" || dir === "down") {
      const model = modelFor(target);
      if (model && (model.selectionIsCollapsed || model.selectionIsPlaceholder)) {
        crossed = moveAcrossBounds(target, dir);
      }
    }
    if (!crossed) {
      try {
        target.executeCommand(MOVE_COMMANDS[dir]);
      } catch (error) {
        /* 命令不可用时保持原位 */
      }
    }
    let after = positionOf(target);
    // MathLive 在「不能再移动」时会按浏览器的焦点顺序把焦点移出编辑器（会跳到上一个按钮），
    // 这里把焦点拉回公式编辑器，避免点方向键后突然跳到别处。
    if (!target.contains(document.activeElement)) focusEditor(target);
    return typeof before === "number" && typeof after === "number" ? after !== before : false;
  }

  // 上下方向键走自定义导航，在矩阵行和微积分上下界之间移动。
  // Shift/Ctrl/Alt/Meta 组合留给 MathLive 的选区扩展等原生快捷键。
  function bindPhysicalArrows() {
    document.addEventListener("keydown", function (event) {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      if (event.isComposing || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
      const mf = resolveFocusedEditor();
      if (!mf) return;
      event.preventDefault();
      event.stopPropagation();
      moveCursor(event.key === "ArrowUp" ? "up" : "down", mf);
    }, true);
  }

  // MathLive 的 moveToNextGroup 在分母里按 Tab、且后面没有待填占位时，
  // 会选中整个 genfrac（选区覆盖分子到分母）；继续键入就覆盖整条分式。
  // 这里仍先执行原生跳转，保留「下一占位 / leftright / 文本组」的有效跳转；
  // 只有结果恰好是整个分式的主动选中时，才把折叠光标移到分式之后。
  // 用 mf.position 公共 setter（而不是 model.position）触发重画，清掉残留的
  // ML__selected 高亮。双击与 Ctrl+A 的主动选中不经过这里，行为不变。
  function tabOutOfFilledFraction(mf) {
    const model = modelFor(mf);
    if (!model || !model.selectionIsCollapsed) return false;
    const ranges = model.selection && model.selection.ranges;
    if (!Array.isArray(ranges) || ranges.length !== 1) return false;
    const range = ranges[0];
    if (!Array.isArray(range) || range[0] !== range[1]) return false;
    let atom = null;
    try {
      atom = model.at(range[0]);
    } catch (error) {
      return false;
    }
    if (!atom || atom.parentBranch !== "below") return false;
    const parent = atom.parent;
    if (!parent || parent.type !== "genfrac") return false;
    let fractionStart = 0;
    let fractionEnd = 0;
    try {
      fractionStart = parent.leftSibling ? model.offsetOf(parent.leftSibling) : 0;
      fractionEnd = model.offsetOf(parent);
      const denominator = branchRange(model, parent, "below");
      // 分式在末尾且分母填完时，这次 Tab 把光标放在分式之后。
      if (fractionEnd === model.lastOffset && denominator && range[0] === denominator[1]) {
        mf.position = fractionEnd;
        return true;
      }
      mf.executeCommand("moveToNextGroup");
    } catch (error) {
      return false;
    }
    const after = model.selection && model.selection.ranges;
    if (after && after.length === 1) {
      const selectedStart = Math.min(after[0][0], after[0][1]);
      const selectedEnd = Math.max(after[0][0], after[0][1]);
      if (selectedStart === fractionStart && selectedEnd === fractionEnd) {
        try {
          mf.position = fractionEnd;
          if (model.mathfield && typeof model.mathfield.stopCoalescingUndo === "function") {
            model.mathfield.stopCoalescingUndo();
          }
          if (typeof model.announce === "function") model.announce("move");
        } catch (error) {
          /* 保持 MathLive 的选中结果 */
        }
      }
    }
    return true;
  }

  function bindFractionTab() {
    document.addEventListener("keydown", function (event) {
      if (event.key !== "Tab" || event.isComposing || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
      const mf = resolveFocusedEditor();
      if (!mf) return;
      if (!tabOutOfFilledFraction(mf)) return;
      event.preventDefault();
      event.stopPropagation();
    }, true);
  }

  function editorMode(mf) {
    try {
      return mf.mode === "math" ? "math" : mf.mode === "text" ? "text" : "";
    } catch (error) {
      return "";
    }
  }

  // MathLive 的 switchMode 在空字段上会因 hasEditableContent=false 提前返回。
  // 直接设置 model.mode 不创建额外的空组，也不会在空原稿上留下幽灵 `$  $`。
  function forceMathMode(mf) {
    if (!mf) return false;
    if (editorMode(mf) === "math") return true;
    try {
      const internal = mf._mathfield;
      if (internal && internal.model) {
        internal.model.mode = "math";
        if (editorMode(mf) === "math") return true;
      }
    } catch (error) {
      /* 继续尝试公开 API */
    }
    try {
      mf.mode = "math";
      return editorMode(mf) === "math";
    } catch (error) {
      return false;
    }
  }

  // MathLive 的 #@ 会把光标左侧最近的表达式当作隐式参数捕获。在 text 模式的
  // 折叠光标处，这个「表达式」可能是整段普通文字，导致 `$\frac{hello$中文...}{}$`。
  // 此时把 #@ 改为 #?：仍是可编辑占位符，但不会捕获左侧文字。
  // 真实选区（非折叠）和 math 模式里的槽位操作保留原 #@ 语义。
  function collapsedTextCursor(mf) {
    if (!isTextField(mf) || editorMode(mf) === "math") return false;
    try {
      const ranges = mf.selection && mf.selection.ranges;
      return Array.isArray(ranges) && ranges.length === 1 && ranges[0][0] === ranges[0][1];
    } catch (error) {
      return false;
    }
  }

  function templateForInsertion(mf, template) {
    if (!template) return template;
    if (collapsedTextCursor(mf)) return template.replace(/#@/g, "#?");
    if (!/^\\(?:frac|dfrac)\{#@\}\{#\?\}$/.test(template)) return template;
    // 数学分支开头没有可捕获为分子的表达式，直接从分子占位符开始填。
    const model = modelFor(mf);
    if (model?.selectionIsCollapsed && model.at(mf.position)?.type === "first") {
      return template.replace("#@", "#?");
    }
    return template;
  }

  // 原稿字段默认是 text 模式：符号键盘点击时先切到 math 再插入。
  // 有 #@ / #? 占位符的结构模板留在 math 模式，方便继续填分子、分母和矩阵格子；
  // 单个符号和 AI 生成的完整公式插入后回到 text，避免后续普通输入被当成数学变量。
  function insertMathLatex(mf, latex, keepMath) {
    if (!mf || !latex) return false;
    const source = String(latex);
    // 清空原文再切回渲染后，空字段可能保留 [-1, 0] 选区。
    // 此处没有内容可选，模板应按正常空光标插入。
    if (modelFor(mf)?.lastOffset === 0) mf.position = 0;
    const switched = isTextField(mf) && editorMode(mf) !== "math";
    // 必须在 forceMathMode 之前判断当前是否 text 折叠光标。
    const insertTemplate = templateForInsertion(mf, source);
    if (switched && !forceMathMode(mf)) return false;
    let ok = false;
    try {
      ok = mf.insert(insertTemplate, { format: "latex", mode: "math" });
    } catch (error) {
      ok = false;
    }
    if (switched && (!ok || !keepMath)) ensureTextMode(mf);
    if (ok) scheduleHeightSync();
    return ok;
  }

  function insertChip(spec) {
    const mf = resolveEditor();
    const template = templateFromSpec(spec);
    if (!mf || !template) return false;
    // #0 也是结构占位符（有选区取选区，否则是占位符）；不定积分模板只有 #0，
    // 必须一起留在数学模式，否则插入后会切回 text，后续被积函数被打成普通文字。
    return insertMathLatex(mf, template, /#@|#\?|#0/.test(template));
  }

  function insertGlyph(text) {
    const mf = resolveEditor();
    if (!mf) return false;
    return insertMathLatex(mf, String(text == null ? "" : text), false);
  }

  // 粘贴 / 回车走这里：先把内容插进 MathLive（换行在字段里显示为空格），
  // 再用 #draft 的前后公共部分定位插入区间，把原始文本（含换行）写回草稿。
  // 这样普通录入不会因为 MathLive 的单行文本模式丢掉换行，也不会把整段文字变成 $...$。
  function insertMixedRaw(text, mf) {
    const value = String(text == null ? "" : text);
    if (!mf || !value || state.view !== VIEW_RENDERED) return false;
    const before = draft.value;
    const parts = parseMixed(value);
    if (!parts.length) return false;
    withSync(function () {
      for (const part of parts) {
        if (part.type === "math") {
          forceMathMode(mf);
          mf.insert(part.value, { format: "latex", mode: "math" });
          ensureTextMode(mf);
        } else if (part.value) {
          ensureTextMode(mf);
          // MathLive 单行字段没有换行原子：用等量空格占位，原始换行由下方
          // 公共前后缀对齐写回 #draft，后续追加文字仍能按空白对齐保留换行。
          const fieldText = part.value.replace(/\r\n?/g, "\n").replace(/\n/g, " ");
          mf.insert(fieldText, { format: "text", mode: "text" });
        }
      }
    });
    const after = mixedFromEditor(mf, draft);
    if (after === null) return false;
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
    let suffix = 0;
    while (
      suffix < before.length - prefix &&
      suffix < after.length - prefix &&
      before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
    ) {
      suffix += 1;
    }
    const next = before.slice(0, prefix) + value + before.slice(before.length - suffix);
    if (next.length > DRAFT_MAX_LENGTH) return false;
    state.docs.set(mf, parseDoc(next));
    state.sourceCursor = { start: prefix + value.length, end: prefix + value.length };
    state.suppressExternalSync = true;
    try {
      withSync(function () {
        draft.value = next;
        try {
          draft.setSelectionRange(state.sourceCursor.start, state.sourceCursor.end);
        } catch (error) {
          /* 忽略 */
        }
        // 字数 / 发送按钮 / 待发送队列仍然由 app.js 的 input 监听更新
        draft.dispatchEvent(new Event("input", { bubbles: true }));
      });
    } finally {
      state.suppressExternalSync = false;
    }
    scheduleHeightSync();
    return true;
  }

  function typedPowerPrefix(model, position) {
    let prefix = "";
    for (let i = position; i > 0 && prefix.length < 32; i -= 1) {
      const atom = model.at(i);
      if (atom?.mode !== "text" || typeof atom.value !== "string" || atom.value.length !== 1) break;
      prefix = atom.value + prefix;
    }
    const match = /(?:^|[^A-Za-z0-9_./\\])([A-Za-z]|\d+)\^(-?)$/.exec(prefix);
    if (!match || (prefix.length === 32 && match[0] === match[1] + "^" + match[2])) return null;
    return match;
  }

  function insertTypedPower(mf, event) {
    if (state.syncing || state.switching || state.view !== VIEW_RENDERED || mf.readOnly ||
        !event.cancelable || event.isComposing || event.inputType !== "insertText" ||
        !/^\d$/.test(event.data || "") || editorMode(mf) !== "text") return;
    const model = modelFor(mf);
    if (!model?.selectionIsCollapsed) return;
    const position = mf.position;
    const match = typedPowerPrefix(model, position);
    if (!match) return;
    const [, base, sign] = match;
    const start = position - base.length - 1 - sign.length;
    // MathLive 的 input 可能还在队列里，先同步 ^ 前后的原文字面值。
    // 这样转成公式时，紧挨公式的已输入空格也会保留。
    handleFieldChange(mf, draft);
    let inserted = false;
    withSync(function () {
      mf.selection = { ranges: [[start, position]] };
      try {
        inserted = mf.insert("$" + base + "^{" + sign + event.data + "}$", {
          format: "latex",
          mode: "text",
          insertionMode: "replaceSelection",
          selectionMode: "after"
        });
      } catch (error) {
        inserted = false;
      }
      if (!inserted) {
        mf.position = position;
        return;
      }
      // 继续打数字时，光标要留在指数内，例如 2^10。
      const power = model.at(mf.position);
      const exponent = power?.type === "subsup" && branchRange(model, power, "superscript");
      if (exponent) {
        state.typedPower = power;
        mf.position = exponent[1];
        forceMathMode(mf);
      }
    });
    if (!inserted) return;
    event.preventDefault();
    handleFieldChange(mf, draft);
  }

  function finishTypedPower(mf) {
    const power = state.typedPower;
    const model = modelFor(mf);
    if (!power || !model?.selectionIsCollapsed) return false;
    const caret = model.at(mf.position);
    if (caret?.parent !== power || caret.parentBranch !== "superscript") return false;
    const exponent = branchRange(model, power, "superscript");
    if (!exponent || mf.position !== exponent[1]) return false;
    state.typedPower = null;
    mf.position = model.offsetOf(power);
    return true;
  }

  function bindRenderedEditing(mf) {
    if (!mf || state.renderedBindingsBound) return;
    state.renderedBindingsBound = true;
    const handled = new WeakSet();
    mf.addEventListener("beforeinput", function (event) {
      insertTypedPower(mf, event);
    });

    // 在 document 捕获阶段处理：MathLive 的隐藏输入代理在 shadow DOM 里，
    // 只在 math-field 上监听 paste / Enter 可能拿不到事件。
    function isMainDraftTarget(target) {
      if (!target) return false;
      return target === mf || (typeof mf.contains === "function" && mf.contains(target));
    }

    document.addEventListener("paste", function (event) {
      if (state.view !== VIEW_RENDERED || !isMainDraftTarget(event.target) || !event.clipboardData) return;
      if (handled.has(event)) return;
      handled.add(event);
      const text = event.clipboardData.getData("text/plain");
      if (!text) return;
      event.preventDefault();
      event.stopPropagation();
      insertMixedRaw(text, mf);
    }, true);

    document.addEventListener("keydown", function (event) {
      if (state.view !== VIEW_RENDERED || !isMainDraftTarget(event.target) || event.isComposing) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "/" || event.key === " " || event.key === "Enter") {
        if (finishTypedPower(mf) && event.key !== "/") ensureTextMode(mf);
      } else if (/^(?:Arrow|Home|End|Tab)/.test(event.key)) {
        state.typedPower = null;
      }
      if (event.key !== "Enter") return;
      if (editorMode(mf) !== "text") return;
      if (handled.has(event)) return;
      handled.add(event);
      event.preventDefault();
      event.stopPropagation();
      insertMixedRaw("\n", mf);
    }, true);

    // MathLive 在空白区域不会自动把焦点交给键盘 sink；点空白处时显式 focus()。
    // 已经聚焦时不再重复 focus，避免打断公式槽位命中 / 光标定位。
    function focusFromClick(event) {
      if (state.view !== VIEW_RENDERED) return;
      const target = event.target;
      if (target !== mf && target !== formulaHost && !(mf.contains && mf.contains(target))) return;
      if (!draft.value && isGhostMath(getLatex(mf))) setLatex(mf, "");
      // 已经聚焦时 focusEditor 会直接返回；未聚焦时补上 sink 焦点。
      // 不 preventDefault / stopPropagation，公式槽位命中仍交给 MathLive。
      focusEditor(mf);
    }
    // pointerdown 只补焦点，不 preventDefault / stopPropagation，槽位命中仍由 MathLive 处理；
    // click 冒泡阶段再兜底一次，覆盖只在 click 阶段才响应的情况。
    formulaHost.addEventListener("pointerdown", function (event) {
      state.typedPower = null;
      focusFromClick(event);
    }, true);
    formulaHost.addEventListener("click", focusFromClick);
  }

  /* ---------- 主原稿撤回 / 重做 ---------- */

  // 只有 #draft（主原稿）走这份历史；对话补充框仍用 MathLive 自己的 undo。
  // 原文视图里的符号键盘用 setRangeText 写值，不进入浏览器原生 undo 栈；
  // 渲染视图里的模板占位符也不在 #draft 的字面值里。因此统一存快照：
  //   value   —— #draft 原文（保留换行与分隔符，提交链路只认它）
  //   latex   —— 渲染视图当时的 MathLive LaTeX（保住 \placeholder 与可填槽位）
  //   selection / position / mode —— 渲染视图的光标与编辑模式，撤回后能接着填。
  // 历史独立成段，避免和上下限补丁改到同一批函数。
  const HISTORY_LIMIT = 100;
  const undoButton = document.querySelector("#draft-undo");
  const redoButton = document.querySelector("#draft-redo");

  const history = {
    entries: [],
    index: -1,
    restoring: false,
    scheduled: false,
    composing: false
  };

  function readFieldSelection(mf) {
    try {
      const selection = mf.selection;
      if (!selection || !Array.isArray(selection.ranges) || !selection.ranges.length) return null;
      const ranges = [];
      for (const range of selection.ranges) {
        if (!Array.isArray(range) || range.length < 2) return null;
        ranges.push([Number(range[0]), Number(range[1])]);
      }
      return { ranges: ranges, direction: selection.direction === "backward" ? "backward" : "forward" };
    } catch (error) {
      return null;
    }
  }

  function historyEntry() {
    const entry = {
      value: draft ? draft.value : ""
    };
    if (state.view === VIEW_RENDERED && state.field) {
      const latex = getLatex(state.field);
      if (latex !== null) entry.latex = latex;
      const position = positionOf(state.field);
      if (typeof position === "number") entry.position = position;
      const selection = readFieldSelection(state.field);
      if (selection) entry.selection = selection;
      const mode = editorMode(state.field);
      if (mode) entry.mode = mode;
    } else if (draft) {
      entry.start = draft.selectionStart == null ? 0 : draft.selectionStart;
      entry.end = draft.selectionEnd == null ? entry.start : draft.selectionEnd;
    }
    return entry;
  }

  function historyCurrent() {
    return history.index >= 0 ? history.entries[history.index] : null;
  }

  // 外部写入（OCR、清空、失败后回填）没有 input 事件；在撤回前把它补记成一步，
  // 否则一次撤回会直接跳回外部写入之前，把用户看得见的内容一起丢掉。
  function historyHasExternalChange() {
    const current = historyCurrent();
    return Boolean(current && draft && draft.value !== current.value);
  }

  // 撤回 / 重做不能用「历史里还有没有」来回答：忙碌时 app.js 会把 #draft
  // 设为只读，按钮和快捷键都必须一起停下。MutationObserver 负责刷新。
  function historyBlocked() {
    return !draft || Boolean(draft.readOnly) || Boolean(draft.disabled);
  }

  function canUndoHistory() {
    if (historyBlocked()) return false;
    return history.index > 0 || historyHasExternalChange();
  }

  function canRedoHistory() {
    if (historyBlocked() || historyHasExternalChange()) return false;
    return history.index >= 0 && history.index < history.entries.length - 1;
  }

  function updateHistoryButtons() {
    if (undoButton) undoButton.disabled = !canUndoHistory();
    if (redoButton) redoButton.disabled = !canRedoHistory();
  }

  function pushHistoryEntry(entry) {
    const current = historyCurrent();
    // 去重：同一份 #draft 不重复入栈，避免 setLatex / 同步回写自激。
    if (current && current.value === entry.value) return false;
    if (history.index < history.entries.length - 1) history.entries.length = history.index + 1;
    history.entries.push(entry);
    if (history.entries.length > HISTORY_LIMIT) {
      history.entries.splice(0, history.entries.length - HISTORY_LIMIT);
    }
    history.index = history.entries.length - 1;
    return true;
  }

  function recordHistory() {
    if (!draft || history.restoring) return false;
    const changed = pushHistoryEntry(historyEntry());
    if (changed) updateHistoryButtons();
    return changed;
  }

  function scheduleHistoryRecord() {
    if (history.scheduled) return;
    history.scheduled = true;
    const run = function () {
      history.scheduled = false;
      if (history.restoring) return;
      // MathLive → #draft 的写回也在 withSync 里；等这一轮同步结束再取快照。
      if (state.syncing > 0) {
        scheduleHistoryRecord();
        return;
      }
      recordHistory();
    };
    if (typeof queueMicrotask === "function") queueMicrotask(run);
    else window.setTimeout(run, 0);
  }

  function onDraftHistoryInput(event) {
    if (!draft || history.restoring) return;
    if (event && event.isComposing) return;
    if (history.composing) return;
    if (state.syncing > 0) {
      scheduleHistoryRecord();
      return;
    }
    recordHistory();
  }

  function applySourceSelection(entry) {
    if (!draft) return;
    const max = draft.value.length;
    const rawStart = entry.start == null ? max : entry.start;
    const rawEnd = entry.end == null ? rawStart : entry.end;
    const start = Math.max(0, Math.min(rawStart, max));
    const end = Math.max(start, Math.min(rawEnd, max));
    state.sourceCursor = { start: start, end: end };
    try {
      draft.setSelectionRange(start, end);
    } catch (error) {
      /* 忽略：部分输入类型不支持 setSelectionRange */
    }
  }

  function restoreFieldSelection(entry) {
    const mf = state.field;
    if (!mf) return;
    if (entry.selection && Array.isArray(entry.selection.ranges) && entry.selection.ranges.length) {
      try {
        mf.selection = {
          ranges: entry.selection.ranges.map(function (range) {
            return [range[0], range[1]];
          }),
          direction: entry.selection.direction === "backward" ? "backward" : "forward"
        };
        return;
      } catch (error) {
        /* 位置对不上时退回 position */
      }
    }
    if (typeof entry.position === "number") {
      try {
        mf.position = entry.position;
      } catch (error) {
        /* 忽略 */
      }
    }
  }

  function restoreHistoryEntry(entry) {
    history.restoring = true;
    const previousSuppress = state.suppressExternalSync;
    state.suppressExternalSync = true;
    try {
      withSync(function () {
        if (draft.value !== entry.value) {
          draft.value = entry.value;
          if (state.view === VIEW_SOURCE) applySourceSelection(entry);
          // 字数、发送按钮与待发送队列仍由 app.js 的 input 监听更新。
          draft.dispatchEvent(new Event("input", { bubbles: true }));
        } else if (state.view === VIEW_SOURCE) {
          applySourceSelection(entry);
        }
        if (!state.field) return;
        // 后续编辑的 reconcile 基线必须换成恢复后的原文。
        state.docs.set(state.field, parseDoc(entry.value));
        if (state.view !== VIEW_RENDERED) return;
        // 有 MathLive 快照就原样装回（含 \placeholder）；没有则从原文重建。
        setLatex(state.field, entry.latex != null ? entry.latex : mixedToLatex(entry.value, true));
        if (entry.mode === "math") forceMathMode(state.field);
        else ensureTextMode(state.field);
        // onFocus 可能把光标挪到下一个占位符；先聚焦，再恢复精确选区/位置。
        focusEditor(state.field);
        restoreFieldSelection(entry);
        setReadOnly(state.field, draft.readOnly || draft.disabled);
      });
    } finally {
      state.suppressExternalSync = previousSuppress;
      history.restoring = false;
    }
    updateHistoryButtons();
    focusVisibleEditor();
    scheduleHeightSync();
  }

  function syncExternalHistory() {
    if (!historyHasExternalChange()) return false;
    return recordHistory();
  }

  function undoHistory() {
    if (!draft || history.restoring || historyBlocked()) return false;
    syncExternalHistory();
    if (history.index <= 0) {
      updateHistoryButtons();
      return false;
    }
    history.index -= 1;
    restoreHistoryEntry(history.entries[history.index]);
    return true;
  }

  function redoHistory() {
    if (!draft || history.restoring || historyBlocked()) return false;
    if (syncExternalHistory() || history.index >= history.entries.length - 1) {
      updateHistoryButtons();
      return false;
    }
    history.index += 1;
    restoreHistoryEntry(history.entries[history.index]);
    return true;
  }

  function isMainDraftFocus() {
    if (!draft) return false;
    const active = document.activeElement;
    if (!active) return false;
    if (state.view === VIEW_SOURCE) return active === draft;
    if (state.view === VIEW_RENDERED && state.field) {
      return active === state.field || Boolean(state.field.contains && state.field.contains(active));
    }
    return false;
  }

  function bindHistory() {
    if (!draft) return;
    draft.addEventListener("input", onDraftHistoryInput);
    // IME 组合期间不逐帧记历史；组合结束后的正式 input 再入栈。
    draft.addEventListener("compositionstart", function () {
      history.composing = true;
    });
    draft.addEventListener("compositionend", function () {
      history.composing = false;
      // 有的输入法在 compositionend 才提交最终文本，之后不再补 input；
      // 延迟补记一次，重复值仍由 pushHistoryEntry 去重。
      window.setTimeout(scheduleHistoryRecord, 0);
    });
    // 组合输入失焦时清除标志，后续编辑可以继续记录。
    draft.addEventListener("blur", function () {
      history.composing = false;
    });
    if (undoButton) {
      undoButton.addEventListener("click", function (event) {
        event.preventDefault();
        undoHistory();
      });
    }
    if (redoButton) {
      redoButton.addEventListener("click", function (event) {
        event.preventDefault();
        redoHistory();
      });
    }
    // Ctrl/Cmd+Z、Ctrl/Cmd+Shift+Z、Ctrl+Y 只在主原稿编辑区生效：
    // 原文 textarea 聚焦，或渲染视图的 math-field 持有焦点。其余输入框/对话框不劫持。
    document.addEventListener("keydown", function (event) {
      if (!event || event.isComposing || event.altKey) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = String(event.key || "").toLowerCase();
      let action = "";
      if (key === "z") action = event.shiftKey ? "redo" : "undo";
      else if (key === "y" && !event.shiftKey) action = "redo";
      if (!action) return;
      if (!isMainDraftFocus()) return;
      if (document.querySelector("dialog[open]")) return;
      event.preventDefault();
      event.stopPropagation();
      if (action === "undo") undoHistory();
      else redoHistory();
    }, true);
    // 外部写入后焦点回到主原稿时，刷新按钮可用状态（不把焦点当编辑）。
    document.addEventListener("focusin", function (event) {
      const target = event && event.target;
      if (!target) return;
      if (target === draft || (state.field && (target === state.field || (state.field.contains && state.field.contains(target))))) {
        updateHistoryButtons();
      }
    }, true);
  }

  function resetHistory() {
    history.entries = [historyEntry()];
    history.index = 0;
    history.restoring = false;
    history.scheduled = false;
    history.composing = false;
    updateHistoryButtons();
  }

  /* ---------- 历史对话：同一份 #draft 的归属 ---------- */

  // app.js 在真正把工作区换成目标对话之后调用（activeId 与 #draft 都已更新）。
  // 编辑器装载这份草稿，并把撤回/重做历史重置为它的基线：A 对话的原稿不会在 B 对话里
  // 被撤回。同一个对话 id 的重复调用不重置，所以同一对话内的编辑（原文 / 渲染视图
  // 互切）仍可继续撤回重做；历史保存 / 恢复 / 并行语义完全不变。
  function syncConversation(conversationId) {
    const key = conversationId == null || conversationId === "" ? "" : String(conversationId);
    if (state.conversationId === key) return false;
    state.conversationId = key;
    // 切换装载期间 MathLive 可能发出异步 input：既不写回新对话的 #draft，也不记历史。
    state.switching = true;
    try {
      state.sourceCursor = { start: 0, end: 0 };
      if (state.field) {
        state.docs.set(state.field, parseDoc(draft.value));
        if (state.view === VIEW_RENDERED) {
          setLatex(state.field, mixedToLatex(draft.value, true));
          setReadOnly(state.field, draft.readOnly || draft.disabled);
        }
      }
      // 补充框的文字跟着 organize 对话走；按当前 textarea 重同步是幂等的。
      for (let i = 0; i < state.entries.length; i += 1) syncFromTextarea(state.entries[i]);
    } finally {
      state.switching = false;
    }
    resetHistory();
    scheduleHeightSync();
    return true;
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
      return state.view === VIEW_RENDERED && Boolean(state.field);
    },
    view: function () {
      return state.view;
    },
    isRendered: function () {
      return state.view === VIEW_RENDERED;
    },
    setView: setView,
    // 兼容旧调用：formula → 渲染视图，text → 原文视图
    setMode: function (mode) {
      return setView(mode === "formula" ? VIEW_RENDERED : VIEW_SOURCE);
    },
    focus: function () {
      return focusVisibleEditor();
    },
    focusVisible: function () {
      return focusVisibleEditor();
    },
    onExternalChange: onExternalChange,
    // 历史对话切换后由 app.js 调用：装载新草稿并重置本对话的撤回/重做基线。
    syncConversation: syncConversation,
    conversationId: function () {
      return state.conversationId;
    },
    move: moveCursor,
    insertChip: insertChip,
    insertGlyph: insertGlyph,
    matrixMaxSize: matrixMaxSize,
    // 提交前把可见渲染编辑器里的最新内容写回 textarea；原文视图（或编辑器不可见）时
    // #draft 才是权威，隐藏的编辑器没有所有权，返回 false，绝不能用旧公式覆盖用户刚改的文字。
    flush: function () {
      if (!mainEditorShown()) return false;
      commitEditorValue(state.field, draft);
      return true;
    },
    // 暴露转换函数，便于自检与后续调试
    mixedToLatex: mixedToLatex,
    prepareFractionSlots: prepareFractionSlots,
    latexToMixed: latexToMixed,
    // 输入区高度：纯计算函数 + 手动重算，便于自测与调试。
    editorCap: editorHeightCap,
    syncHeight: syncHeightNow,
    wrapStyle: WRAP_STYLE,
    heightLimits: HEIGHT,
    // 不可断的超宽公式检测：true 表示主页主稿需要横滚，已自动切到原文层。
    contentOverflows: contentOverflows,
    overflowFallback: function () {
      return state.overflowFallback;
    },
    parseDraft: parseMixed,
    parseFormula: parseLatexParts,
    parseTextModeFormula: parseTextModeLatex,
    reconcileDraft: function (text, latex, textMode) {
      return reconcileDoc(parseDoc(text), textMode ? parseTextModeLatex(latex) : parseLatexParts(latex));
    }
  };

  // 正常提交入口：app.js 的 submitOriginalIntake / 补充表单直接读 textarea.value。
  // 在按钮 click 与表单 submit 的捕获阶段先 flush，避免公式模式下最后一次输入尚未写回。
  function bindSubmitSync() {
    document.addEventListener("click", function (event) {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest) return;
      if (!target.closest("#organize-submit")) return;
      if (mainEditorShown()) commitEditorValue(state.field, draft);
    }, true);
    document.addEventListener("submit", function (event) {
      const form = event.target;
      if (!(form instanceof Element)) return;
      const entry = state.entries.find(function (item) {
        return item.form === form;
      });
      // 补充框收起时（或用户在原文里另写了内容）提交的是 textarea，
      // 旧公式编辑器没有所有权，不能把它的缓存内容写回去。
      if (entry && followEditorShown(entry)) commitEditorValue(entry.field, entry.textarea);
    }, true);
  }

  function init() {
    if (state.initialized) return;
    if (!draft || !formulaPane || !formulaHost || !sourcePanel) return;
    state.initialized = true;
    ensureMathliveScript();
    const ready = initMainField();
    bindViewToggle();
    bindHistory();
    // 记录原文视图里的光标；切去渲染视图再切回来时恢复到同一位置。
    for (const eventName of ["select", "click", "keyup", "input"]) {
      draft.addEventListener(eventName, rememberSourceCursor);
    }
    if (ready) setView(VIEW_RENDERED, { focus: false });
    else updateViewUi();
    // 初始装载不算一步编辑：空原稿时撤回 / 重做保持禁用。
    resetHistory();
    bindSubmitSync();
    bindPhysicalArrows();
    bindFractionTab();
    bindEditorHeight();
    initFollowEditors();
    // 对话补充框的 .composer-toolbar 由 chat-composer.js 在 window 的 DOMContentLoaded 里创建；
    // 若它们的初始化顺序意外靠后，下一帧再补一次（幂等，已有按钮的会跳过）。
    window.setTimeout(function () {
      initFollowEditors();
    }, 0);
    dispatchViewChange(state.view);
  }

  // 用 window 的 DOMContentLoaded：chat-composer.js 也挂在 window 上，脚本顺序保证它先跑。
  window.addEventListener("DOMContentLoaded", init);
  // 极端情况（defer 脚本被延迟到 load 之后执行）兜底
  if (document.readyState === "complete") init();
})();
