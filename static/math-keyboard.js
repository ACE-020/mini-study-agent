/* 数学符号键盘 · GeoGebra / Desmos 风格
   通过 focusin 事件委托自动挂载到核心输入框，点击符号把 LaTeX 插入光标处。
   约束：CSP script-src 'self'，本文件不使用 inline script / eval / CDN。 */
(function () {
  "use strict";

  const FIELD_SELECTOR = "#draft, #organize-follow, #review-follow, #analysis-follow, #material-text, #batch-ai-input, #note-text, .queue-editor";
  const AUTO_STORAGE_KEY = "math-keyboard:auto";
  const PRESSED_MS = 140;
  const HINT_MS = 1600;
  // 主页输入框的符号表：窄的悬浮层，锚在输入框下方，不参与布局。
  // 水平范围取「加号按钮右边界 … 发送按钮左边界」，所以两个按钮永远露在外面可点；
  // 桌面最多 480px，窄屏直接收在两按钮之间。纵向按输入框下方到视口底部的可用高度
  // 限量，近底部时保证至少能看到一行符号键，更多键由面板自己纵向滚动。
  const FLOATING = {
    maxWidth: 480,
    minWidth: 120,
    gap: 6,
    edge: 8,
    bottomGap: 8,
    preferredHeight: 240,
    minHeight: 96,
    compactBelow: 180,
    attachSelector: "#home-attach-button",
    submitSelector: "#organize-submit",
    composerSelector: ".home-composer-panel"
  };

  /* ---------- 符号目录 ---------- */

  // label：无 KaTeX 时的降级外观；insert：真正插入的文本，$0 是光标占位；aria：中文含义
  function k(label, insert, aria, tex) {
    return {
      label: label,
      insert: insert,
      aria: aria,
      title: insert,
      tex: typeof tex === "string" ? tex : insert.replace(/\$0/g, "")
    };
  }

  const CATALOG = [
    {
      id: "basic",
      label: "常用",
      full: "常用符号",
      keys: [
        k("+", "+", "加号", "+"),
        k("−", "−", "减号", "-"),
        k("×", "×", "乘号", "\\times"),
        k("÷", "÷", "除号", "\\div"),
        k("·", "·", "点乘", "\\cdot"),
        k("=", "=", "等号", "="),
        k("≠", "≠", "不等于", "\\neq"),
        k("±", "±", "正负号", "\\pm"),
        k("(", "(", "左圆括号", "("),
        k(")", ")", "右圆括号", ")"),
        k("[", "[", "左方括号", "["),
        k("]", "]", "右方括号", "]"),
        k("{", "\\{", "左花括号", "\\{"),
        k("}", "\\}", "右花括号", "\\}"),
        k("%", "\\%", "百分号", "\\%"),
        k("°", "°", "度", "°"),
        k("π", "π", "圆周率", "\\pi"),
        k("∞", "∞", "无穷", "\\infty")
      ]
    },
    {
      id: "fraction",
      label: "分式",
      full: "分式与根式",
      keys: [
        k("a/b", "\\frac{$0}{}", "分式", "\\frac{a}{b}"),
        k("a/b", "\\dfrac{$0}{}", "行内大分式", "\\dfrac{a}{b}"),
        k("√", "\\sqrt{$0}", "平方根", "\\sqrt{a}"),
        k("∛", "\\sqrt[3]{$0}", "三次根号", "\\sqrt[3]{a}"),
        k("( )", "\\left($0\\right)", "自适应圆括号", "\\left(a\\right)"),
        k("| |", "\\left|$0\\right|", "绝对值", "\\left|a\\right|"),
        k("[ ]", "\\left[$0\\right]", "自适应方括号", "\\left[a\\right]"),
        k("{ }", "{$0}", "花括号分组", "\\{\\}"),
        k("a:b", "a:b", "比", "a:b")
      ]
    },
    {
      id: "script",
      label: "上下标",
      full: "上下标",
      keys: [
        k("x²", "x^2", "平方", "x^2"),
        k("xⁿ", "x^n", "n 次幂", "x^n"),
        k("x₁", "x_1", "下标 1", "x_1"),
        k("xₙ", "x_n", "下标 n", "x_n"),
        k("aᵇ", "a^{b}", "上标字母", "a^{b}"),
        k("aᵦ", "a_{b}", "下标字母", "a_{b}"),
        k("10ⁿ", "10^{n}", "10 的 n 次幂", "10^{n}"),
        k("eˣ", "e^{x}", "e 的 x 次幂", "e^{x}"),
        k("□ⁿ", "\\Box^{$0}", "空位上标", "\\Box^{n}")
      ]
    },
    {
      id: "relation",
      label: "关系",
      full: "关系与集合",
      keys: [
        k("≤", "≤", "小于等于", "\\leq"),
        k("≥", "≥", "大于等于", "\\geq"),
        k("<", "<", "小于", "<"),
        k(">", ">", "大于", ">"),
        k("≠", "≠", "不等于", "\\neq"),
        k("≈", "≈", "约等于", "\\approx"),
        k("≡", "≡", "恒等于", "\\equiv"),
        k("≪", "≪", "远小于", "\\ll"),
        k("≫", "≫", "远大于", "\\gg"),
        k("∈", "∈", "属于", "\\in"),
        k("∉", "∉", "不属于", "\\notin"),
        k("⊂", "⊂", "真包含于", "\\subset"),
        k("⊆", "⊆", "包含于", "\\subseteq"),
        k("∪", "∪", "并集", "\\cup"),
        k("∩", "∩", "交集", "\\cap"),
        k("∅", "∅", "空集", "\\varnothing"),
        k("∀", "∀", "任意", "\\forall"),
        k("∃", "∃", "存在", "\\exists"),
        k("∴", "∴", "所以", "\\therefore"),
        k("∵", "∵", "因为", "\\because"),
        k("⇒", "⇒", "推出", "\\Rightarrow"),
        k("⇔", "⇔", "等价", "\\Leftrightarrow"),
        k("→", "→", "趋于", "\\to")
      ]
    },
    {
      id: "greek",
      label: "希腊",
      full: "希腊字母",
      keys: [
        k("α", "α", "阿尔法", "\\alpha"),
        k("β", "β", "贝塔", "\\beta"),
        k("γ", "γ", "伽马", "\\gamma"),
        k("δ", "δ", "德尔塔", "\\delta"),
        k("ε", "ε", "伊普西龙", "\\varepsilon"),
        k("θ", "θ", "西塔", "\\theta"),
        k("λ", "λ", "拉姆达", "\\lambda"),
        k("μ", "μ", "缪", "\\mu"),
        k("ν", "ν", "纽", "\\nu"),
        k("ξ", "ξ", "克西", "\\xi"),
        k("π", "π", "派", "\\pi"),
        k("ρ", "ρ", "柔", "\\rho"),
        k("σ", "σ", "西格马", "\\sigma"),
        k("τ", "τ", "陶", "\\tau"),
        k("φ", "φ", "斐", "\\varphi"),
        k("χ", "χ", "卡伊", "\\chi"),
        k("ψ", "ψ", "普西", "\\psi"),
        k("ω", "ω", "欧米伽", "\\omega"),
        k("Δ", "Δ", "大写德尔塔", "\\Delta"),
        k("Γ", "Γ", "大写伽马", "\\Gamma"),
        k("Θ", "Θ", "大写西塔", "\\Theta"),
        k("Λ", "Λ", "大写拉姆达", "\\Lambda"),
        k("Π", "Π", "大写派", "\\Pi"),
        k("Σ", "Σ", "大写西格马", "\\Sigma"),
        k("Φ", "Φ", "大写斐", "\\Phi"),
        k("Ψ", "Ψ", "大写普西", "\\Psi"),
        k("Ω", "Ω", "大写欧米伽", "\\Omega")
      ]
    },
    {
      id: "calculus",
      label: "微积分",
      full: "函数与微积分",
      keys: [
        k("sin", "\\sin", "正弦", "\\sin"),
        k("cos", "\\cos", "余弦", "\\cos"),
        k("tan", "\\tan", "正切", "\\tan"),
        k("ln", "\\ln", "自然对数", "\\ln"),
        k("lg", "\\lg", "常用对数", "\\lg"),
        k("log", "\\log_{$0}", "对数", "\\log_{a}"),
        k("exp", "\\exp", "指数函数", "\\exp"),
        k("lim", "\\lim_{x\\to $0}", "极限", "\\lim_{x\\to a}"),
        k("d/dx", "\\frac{d}{dx}$0", "导数", "\\frac{d}{dx}"),
        // 不定积分没有上下界，首填被积函数，积分体后保留 \,dx。
        k("∫", "\\int $0\\,dx", "积分", "\\int\\,dx"),
        // 定积分从下界开始填；上界和被积函数随后通过方向键 / 点击进入，末尾保留 \,dx。
        k("∫ₐᵇ", "\\int_{$0}^{} $0\\,dx", "定积分", "\\int_{a}^{b}f(x)\\,dx"),
        // 下标预填 i=，$0 在等号后；上界与被求和项仍是独立的可编辑槽位。
        k("Σ", "\\sum_{i=$0}^{} $0", "求和", "\\sum_{i=1}^{n}"),
        // 连乘与求和同构：raw 也带上下界和 i=，不再是裸 \prod。
        k("∏", "\\prod_{i=$0}^{} $0", "连乘", "\\prod_{i=1}^{n}"),
        k("∂", "\\partial", "偏导", "\\partial"),
        k("∇", "\\nabla", "梯度", "\\nabla"),
        k("′", "'", "导数撇", "'"),
        k("⁽ⁿ⁾", "^{(n)}", "n 阶导数", "^{(n)}")
      ]
    },
    {
      id: "geometry",
      label: "矩阵",
      full: "矩阵与几何",
      keys: [
        {
          // 两个入口键：圆括号 = 矩阵，竖线 = 行列式；各自打开对应标题的面板。
          label: "矩阵",
          insert: "",
          aria: "矩阵（圆括号）",
          title: "插入矩阵（圆括号）",
          tex: "\\left(\\begin{smallmatrix}\\cdot&\\cdot\\\\\\cdot&\\cdot\\end{smallmatrix}\\right)",
          caption: "矩阵",
          action: "matrix-dialog",
          dialogKind: "matrix",
          wide: true
        },
        {
          label: "行列式",
          insert: "",
          aria: "行列式（竖线）",
          title: "插入行列式（竖线）",
          tex: "\\left|\\begin{smallmatrix}\\cdot&\\cdot\\\\\\cdot&\\cdot\\end{smallmatrix}\\right|",
          caption: "行列式",
          action: "matrix-dialog",
          dialogKind: "determinant",
          wide: true
        },
        k("向量", "\\vec{$0}", "向量", "\\vec{a}"),
        k("上划线", "\\overline{$0}", "上划线", "\\overline{a}"),
        k("∠", "\\angle $0", "角", "\\angle"),
        k("△", "\\triangle $0", "三角形", "\\triangle"),
        k("∥", "\\parallel", "平行", "\\parallel"),
        k("⊥", "\\perp", "垂直", "\\perp"),
        k("∽", "\\sim", "相似", "\\sim"),
        k("≅", "\\cong", "全等", "\\cong"),
        k("⊙", "\\circ", "圆", "\\circ")
      ]
    }
  ];

  /* ---------- 渲染编辑视图用的 MathLive 模板 ----------
     文字输入框里仍然插入原来的 LaTeX 文本（insert 不变）；
     在原稿渲染视图里，结构性按键改为让 MathLive 在数学模式中插入模板，
     #@ 是要放光标的首个占位符、#? 是其它占位符。
     mathGlyph 是纯符号键在渲染视图里要插入的 LaTeX（默认取 label）。 */
  const TEMPLATE_BY_INSERT = {
    "\\frac{$0}{}": "\\frac{#@}{#?}",
    "\\dfrac{$0}{}": "\\frac{#@}{#?}",
    "\\sqrt{$0}": "\\sqrt{#@}",
    "\\sqrt[3]{$0}": "\\sqrt[3]{#@}",
    "\\left($0\\right)": "\\left(#@\\right)",
    "\\left[$0\\right]": "\\left[#@\\right]",
    "\\left|$0\\right|": "\\left|#@\\right|",
    "x^2": "x^{2}#@",
    "x^n": "x^{n}#@",
    "x_1": "x_{1}#@",
    "x_n": "x_{n}#@",
    "a^{b}": "a^{b}#@",
    "a_{b}": "a_{b}#@",
    "10^{n}": "10^{n}#@",
    "e^{x}": "e^{x}#@",
    "\\lim_{x\\to $0}": "\\lim_{x\\to #@}{#?}",
    "\\frac{d}{dx}$0": "\\frac{d}{dx}#@",
    // 积分类：不定积分不带上下界；两种积分都在积分体后保留 \,dx。
    // 积分体用 #0：有显式选区时包住选区，没有选区时变成占位符，且不会
    // 像 #@ 那样把光标左侧的已有公式捕获进来（折叠光标时也不劫持前文）。
    // 上下界仍只用 #?；首填槽=模板里第一个占位符（不定积分=积分体，定积分=下界）。
    "\\int $0\\,dx": "\\int #0\\,dx",
    "\\int_{$0}^{} $0\\,dx": "\\int_{#?}^{#?}#0\\,dx",
    // 求和 / 连乘：下标预填普通字符 i=，后面才是可编辑值槽；
    // 用户可以用普通 Backspace / 方向键修改 i=，符号、上界和被求和积项不受影响。
    // 被求和积分项用 #0：选中公式时整段进正文，空光标时只放占位符。
    "\\sum_{i=$0}^{} $0": "\\sum_{i=#?}^{#?}#0",
    "\\prod_{i=$0}^{} $0": "\\prod_{i=#?}^{#?}#0",
    // 带底数对数：第一个 #? 是真实可填底数，第二个 #? 是真数。
    "\\log_{$0}": "\\log_{#?}{#?}",
    "\\vec{$0}": "\\vec{#@}",
    "\\overline{$0}": "\\overline{#@}"
  };

  // 公式模式下纯符号键实际插入的 LaTeX（文字模式不受影响）
  const MATH_GLYPH_BY_LABEL = {
    "−": "-",
    "×": "\\times",
    "÷": "\\div",
    "·": "\\cdot",
    "≠": "\\neq",
    "±": "\\pm",
    "≤": "\\le",
    "≥": "\\ge",
    "≈": "\\approx",
    "≡": "\\equiv",
    "≪": "\\ll",
    "≫": "\\gg",
    "∈": "\\in",
    "∉": "\\notin",
    "⊂": "\\subset",
    "⊆": "\\subseteq",
    "∪": "\\cup",
    "∩": "\\cap",
    "∅": "\\varnothing",
    "∀": "\\forall",
    "∃": "\\exists",
    "∴": "\\therefore",
    "∵": "\\because",
    "⇒": "\\Rightarrow",
    "⇔": "\\Leftrightarrow",
    "→": "\\to",
    "°": "\\text{°}#@",
    "π": "\\pi",
    "∞": "\\infty",
    "{": "\\{",
    "}": "\\}",
    "%": "\\%",
    "α": "\\alpha",
    "β": "\\beta",
    "γ": "\\gamma",
    "δ": "\\delta",
    "ε": "\\varepsilon",
    "θ": "\\theta",
    "λ": "\\lambda",
    "μ": "\\mu",
    "ν": "\\nu",
    "ξ": "\\xi",
    "ρ": "\\rho",
    "σ": "\\sigma",
    "τ": "\\tau",
    "φ": "\\varphi",
    "χ": "\\chi",
    "ψ": "\\psi",
    "ω": "\\omega",
    "Δ": "\\Delta",
    "Γ": "\\Gamma",
    "Θ": "\\Theta",
    "Λ": "\\Lambda",
    "Π": "\\Pi",
    "Σ": "\\Sigma",
    "Φ": "\\Phi",
    "Ψ": "\\Psi",
    "Ω": "\\Omega",
    "□": "\\Box",
    "sin": "\\sin",
    "cos": "\\cos",
    "tan": "\\tan",
    "ln": "\\ln",
    "lg": "\\lg",
    "log": "\\log",
    "exp": "\\exp",
    "∂": "\\partial",
    "∇": "\\nabla",
    "′": "'",
    "⁽ⁿ⁾": "^{(n)}",
    "∠": "\\angle",
    "△": "\\triangle",
    "∥": "\\parallel",
    "⊥": "\\perp",
    "∽": "\\sim",
    "≅": "\\cong",
    "⊙": "\\circ",
    "{ }": "\\{ \\}",
    "a:b": "a:b"
  };

  // 公式模式里纯文本键要插入的「人类可读字符」（文字模式不受影响，默认取 label）。
  // 带底数对数不再在这里降级成普通 "log"：它有 chipTemplate，底数必须进入真实可填槽位。
  const GLYPH_BY_INSERT = {
    "\\sin": "sin",
    "\\cos": "cos",
    "\\tan": "tan",
    "\\ln": "ln",
    "\\lg": "lg",
    "\\exp": "exp",
    "\\Box^{$0}": "□",
    "^{(n)}": "⁽ⁿ⁾"
  };

  for (const category of CATALOG) {
    for (const key of category.keys) {
      key.glyph = GLYPH_BY_INSERT[key.insert] || key.label;
      key.mathGlyph = Object.prototype.hasOwnProperty.call(MATH_GLYPH_BY_LABEL, key.glyph)
        ? MATH_GLYPH_BY_LABEL[key.glyph]
        : key.glyph;
      if (Object.prototype.hasOwnProperty.call(TEMPLATE_BY_INSERT, key.insert)) {
        key.chipTemplate = TEMPLATE_BY_INSERT[key.insert];
      }
    }
  }

  /* ---------- 实例管理 ---------- */

  const instances = new WeakMap();
  let openInstance = null;

  function autoEnabled() {
    try {
      return window.localStorage.getItem(AUTO_STORAGE_KEY) !== "0";
    } catch (error) {
      return true;
    }
  }

  function shouldSkip(field) {
    if (!field || field.disabled || field.readOnly) return true;
    if (field.dataset && field.dataset.mathKeyboard === "off") return true;
    return false;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (typeof text === "string") node.textContent = text;
    return node;
  }

  function getInstance(field, kind) {
    let instance = instances.get(field);
    if (!instance) {
      instance = createInstance(field, kind);
      instances.set(field, instance);
    }
    return instance;
  }

  /* ---------- 悬浮层几何（纯函数，便于自测） ---------- */

  function isFloatingAnchor(field) {
    return Boolean(
      field && field.closest && field.closest(FLOATING.composerSelector)
    );
  }

  function rectOf(node) {
    if (!node || typeof node.getBoundingClientRect !== "function") return null;
    const rect = node.getBoundingClientRect();
    if (!rect) return null;
    // 隐藏元素量出来是 0×0：当作没有这个节点。
    if (!rect.width && !rect.height) return null;
    return {
      left: Number(rect.left) || 0,
      right: Number(rect.right) || 0,
      top: Number(rect.top) || 0,
      bottom: Number(rect.bottom) || 0,
      width: Number(rect.width) || 0,
      height: Number(rect.height) || 0
    };
  }

  // 计算悬浮符号表的落位与可用高度。
  // anchor：输入框矩形；attach / submit：加号与发送按钮矩形（可缺省）。
  // 返回 {left, top, width, maxHeight, compact}。
  function computeFloatingBox(input) {
    const anchor = input && input.anchor;
    if (!anchor) return null;
    const viewport = (input && input.viewport) || {};
    const vw = Number(viewport.width) || 0;
    const vh = Number(viewport.height) || 0;
    if (!vw || !vh) return null;
    const maxWidth = input.maxWidth == null ? FLOATING.maxWidth : Number(input.maxWidth);
    const minWidth = input.minWidth == null ? FLOATING.minWidth : Number(input.minWidth);
    const gap = input.gap == null ? FLOATING.gap : Number(input.gap);
    const edge = input.edge == null ? FLOATING.edge : Number(input.edge);
    const bottomGap = input.bottomGap == null ? FLOATING.bottomGap : Number(input.bottomGap);
    const preferred = input.preferredHeight == null ? FLOATING.preferredHeight : Number(input.preferredHeight);
    const minHeight = input.minHeight == null ? FLOATING.minHeight : Number(input.minHeight);
    const compactBelow = input.compactBelow == null ? FLOATING.compactBelow : Number(input.compactBelow);

    // 水平：默认贴着输入框，但绝不越过加号 / 发送按钮的实际边界。
    let left = Math.max(edge, anchor.left);
    let right = Math.min(vw - edge, anchor.right);
    const attach = input.attach;
    const submit = input.submit;
    let bounded = false;
    if (attach && submit) {
      const sameRow = Math.abs(attach.top - submit.top) < 80;
      const from = Math.max(edge, attach.right);
      const to = Math.min(vw - edge, submit.left);
      // 两个按钮在同一行且中间还有可用空间：面板只占这段，按钮永远露出来。
      if (sameRow && to - from >= 80) {
        left = from + gap;
        right = to - gap;
        bounded = true;
      }
    }
    let width = Math.min(maxWidth, right - left);
    if (!bounded) width = Math.max(width, minWidth);
    width = Math.max(0, Math.min(Math.round(width), Math.max(0, vw - edge * 2)));

    // 居中于输入框，再夹回可用区间，保证不压到两侧按钮。
    const center = (anchor.left + anchor.right) / 2;
    let x = Math.round(center - width / 2);
    if (right - width >= left) x = Math.max(left, Math.min(x, right - width));
    else x = left;
    x = Math.max(edge, Math.min(x, vw - width - edge));

    // 垂直：锚在输入框下方；可用高度 = 视口底部余量。
    const anchorTop = Math.round(anchor.bottom + gap);
    const available = vh - anchorTop - bottomGap;
    let top = anchorTop;
    let maxHeight;
    if (available >= minHeight) {
      maxHeight = Math.max(minHeight, Math.min(preferred, available));
    } else {
      // 视口过矮：宁可让面板向上多占一点，也要保证分类条 + 至少一行符号键可见，
      // 而不是只剩分类条。
      maxHeight = minHeight;
      top = Math.max(edge, vh - bottomGap - minHeight);
    }
    return {
      left: Math.round(x),
      top: Math.round(top),
      width: Math.round(width),
      maxHeight: Math.round(maxHeight),
      compact: maxHeight < compactBelow
    };
  }

  function createInstance(field, kind) {
    const instanceKind = kind === "formula" ? "formula" : "text";
    const floating = isFloatingAnchor(field);
    const panel = el("div", "mk-panel");
    panel.hidden = true;
    panel.setAttribute("data-mk-panel", "");
    panel.setAttribute("role", "group");
    panel.setAttribute("aria-label", "数学符号键盘");
    if (floating) {
      // 悬浮层：position:fixed，不占布局高度，不会把输入区和集合行挤走。
      panel.classList.add("mk-panel-floating");
      panel.setAttribute("data-mk-floating", "");
    }

    const head = el("div", "mk-head");
    const tabs = el("div", "mk-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "符号分类");

    const closeButton = el("button", "mk-close", "×");
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "收起符号键盘");
    closeButton.setAttribute("title", "收起（Esc）");

    const grid = el("div", "mk-grid");
    grid.setAttribute("role", "presentation");

    const foot = el("div", "mk-foot");
    const footTip = el("span", "", "点击符号插入到光标处 · Esc 收起");
    const hint = el("span", "mk-hint");
    hint.setAttribute("aria-live", "polite");
    foot.append(footTip, hint);

    head.append(tabs, closeButton);

    // 方向键控制盘只给「公式编辑器」实例：◀ ▲ ▼ ▶ 移动槽位光标
    let arrows = null;
    if (instanceKind === "formula") {
      arrows = el("div", "mk-arrows");
      arrows.setAttribute("role", "group");
      arrows.setAttribute("aria-label", "移动公式光标");
      for (const item of [["left", "◀"], ["up", "▲"], ["down", "▼"], ["right", "▶"]]) {
        const dir = item[0];
        const arrow = el("button", "mk-arrow", item[1]);
        arrow.type = "button";
        arrow.dataset.mkMove = dir;
        arrow.title = "移动光标到相邻槽位";
        arrow.setAttribute("aria-label", "移动光标：" + dir);
        arrow.addEventListener("pointerdown", preventFocusLoss);
        arrow.addEventListener("mousedown", preventFocusLoss);
        arrow.addEventListener("click", function (event) {
          event.preventDefault();
          moveCursor(dir, arrow, instance);
        });
        arrows.append(arrow);
      }
      arrows.append(el("span", "mk-arrows-label", "移动光标"));
    }

    panel.append(head);
    if (arrows) panel.append(arrows);
    panel.append(grid, foot);

    const instance = {
      kind: instanceKind,
      field: field,
      panel: panel,
      tabs: tabs,
      grid: grid,
      hint: hint,
      activeCat: CATALOG[0].id,
      categoryButtons: Object.create(null),
      tabButtons: Object.create(null),
      hintTimer: null,
      open: false,
      floating: floating,
      floatFrame: 0,
      floatBound: false,
      floatHandlers: []
    };

    for (const category of CATALOG) {
      const tab = el("button", "mk-tab", category.label);
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.dataset.mkCat = category.id;
      tab.title = category.full;
      tab.setAttribute("aria-label", category.full);
      tab.setAttribute("aria-selected", category.id === instance.activeCat ? "true" : "false");
      tab.tabIndex = category.id === instance.activeCat ? 0 : -1;
      tab.addEventListener("mousedown", preventFocusLoss);
      tab.addEventListener("pointerdown", preventFocusLoss);
      tab.addEventListener("click", function (event) {
        event.preventDefault();
        activateCategory(instance, category.id);
      });
      tabs.append(tab);
      instance.tabButtons[category.id] = tab;
    }

    // 收起按钮不阻止默认行为：焦点自然落到按钮上，收起后用户再次聚焦输入框即可重新展开。
    closeButton.addEventListener("click", function (event) {
      event.preventDefault();
      close(instance);
    });

    // 放在文档流里：公式编辑器面板紧跟编辑器下方；在 form 内的输入框 → 面板跟着 form 之后；否则紧跟在输入框之后。
    if (instanceKind === "formula") {
      if (field.parentNode) field.parentNode.insertBefore(panel, field.nextSibling);
      else document.body.append(panel);
    } else {
      const form = field.closest ? field.closest("form") : null;
      const anchor = form || field;
      if (anchor.parentNode) {
        anchor.parentNode.insertBefore(panel, anchor.nextSibling);
      } else {
        document.body.append(panel);
      }
    }

    renderCategory(instance, instance.activeCat);
    return instance;
  }

  function preventFocusLoss(event) {
    event.preventDefault();
  }

  function activateCategory(instance, categoryId) {
    if (!instance.tabButtons[categoryId]) return;
    instance.activeCat = categoryId;
    for (const id in instance.tabButtons) {
      const selected = id === categoryId;
      instance.tabButtons[id].setAttribute("aria-selected", selected ? "true" : "false");
      instance.tabButtons[id].tabIndex = selected ? 0 : -1;
    }
    renderCategory(instance, categoryId);
  }

  function renderCategory(instance, categoryId) {
    // 每个分类的按键只创建（只渲染 KaTeX）一次，切换时复用。
    let buttons = instance.categoryButtons[categoryId];
    if (!buttons) {
      const category = CATALOG.filter(function (item) {
        return item.id === categoryId;
      })[0];
      if (!category) return;
      buttons = category.keys.map(function (key) {
        return createKeyButton(instance, key);
      });
      instance.categoryButtons[categoryId] = buttons;
    }
    instance.grid.replaceChildren.apply(instance.grid, buttons);
  }

  // 用 KaTeX 渲染按键外观；渲染结果为空时（例如 % 被当成注释）退回 label 文本，避免出现空白键。
  function renderKeyTex(node, key) {
    if (window.katex && typeof window.katex.render === "function") {
      try {
        window.katex.render(key.tex, node, { throwOnError: false, strict: false });
      } catch (error) {
        node.textContent = key.label;
        return;
      }
      const html = node.querySelector(".katex-html");
      const visibleText = html ? html.textContent.replace(/[\s\u200b\u2061]/g, "") : "";
      const hasSvg = html ? Boolean(html.querySelector("svg")) : false;
      if (!node.querySelector(".katex") || (visibleText === "" && !hasSvg)) {
        node.textContent = key.label;
      }
      return;
    }
    node.textContent = key.label;
  }

  function renderKeyVisual(button, key) {
    button.replaceChildren();
    if (key.caption) {
      const icon = el("span", "mk-key-visual");
      renderKeyTex(icon, key);
      button.append(icon, el("span", "mk-key-caption", key.caption));
      return;
    }
    renderKeyTex(button, key);
  }

  function createKeyButton(instance, key) {
    const button = el("button", key.wide ? "mk-key mk-key-wide" : "mk-key");
    button.type = "button";
    button.title = key.title;
    button.dataset.mkTex = key.insert;
    button.dataset.mkAria = key.aria;
    if (key.action) button.dataset.mkAction = key.action;
    if (key.dialogKind) button.dataset.mkDialog = key.dialogKind;
    button.setAttribute("aria-label", key.aria);

    renderKeyVisual(button, key);

    button.addEventListener("pointerdown", preventFocusLoss);
    button.addEventListener("mousedown", preventFocusLoss);
    button.addEventListener("click", function (event) {
      event.preventDefault();
      insertKey(instance, key, button);
    });
    return button;
  }

  /* ---------- 公式编辑器（可视化模式）调用 ---------- */

  function formulaApi() {
    return window.mathInputMode && typeof window.mathInputMode === "object" ? window.mathInputMode : null;
  }

  function insertIntoFormula(instance, key, button) {
    const api = formulaApi();
    flash(button);
    if (!api) {
      showHint(instance, "公式编辑器未就绪");
      return;
    }
    const ok = key.chipTemplate
      ? api.insertChip({ template: key.chipTemplate })
      : api.insertGlyph(key.mathGlyph != null ? key.mathGlyph : key.label);
    showHint(instance, ok ? "已插入" : "公式编辑器未就绪");
  }

  function moveCursor(dir, button, instance) {
    const api = formulaApi();
    flash(button);
    if (!api) {
      showHint(instance, "公式编辑器未就绪");
      return;
    }
    showHint(instance, api.move(dir) ? "已移动光标" : "已到边界");
  }

  /* ---------- 插入逻辑 ---------- */

  // 文字模式也要认得出已有公式的边界：光标在 $...$ / $$...$$ / \(...\) / \[...\]
  // 或裸环境里时只插 LaTeX 源码，不再包一层 $，否则会出现 $$...$$ 套 $...$ 的坏草稿。
  // 分段规则与公式模式的 parseMixed 共用，避免两套扫描器对价格/转义/块级公式判断不一致。
  function mathRanges(source) {
    const api = formulaApi();
    if (!api || typeof api.parseDraft !== "function") return [];
    return api.parseDraft(source).filter(function (part) {
      return part.type === "math";
    });
  }

  function isEscapedDollar(source, index) {
    let count = 0;
    for (let i = index - 1; i >= 0 && source[i] === "\\"; i -= 1) count += 1;
    return count % 2 === 1;
  }

  // 文字里还有没被公式段包住的 $（价格、未闭合公式）时，新公式改用 \(...\)，
  // 避免新插入的 $ 和这些字面 $ 配对，或拼出 $$。
  function hasLiteralDollar(value) {
    const ranges = mathRanges(value);
    for (let i = 0; i < value.length; i += 1) {
      if (value[i] !== "$" || isEscapedDollar(value, i)) continue;
      const covered = ranges.some(function (range) { return i >= range.start && i < range.end; });
      if (!covered) return true;
    }
    return false;
  }

  // 决定这次插入落点：要不要包定界符、替换哪一段、选中的文字如何变成公式内容。
  function planInsertion(value, start, end) {
    const ranges = mathRanges(value);
    if (start !== end) {
      const exact = ranges.filter(function (range) { return range.start === start && range.end === end; })[0];
      if (exact) return { start: start, end: end, wrap: true, selected: exact.value, block: exact.block };
      const inside = ranges.filter(function (range) { return start >= range.contentStart && end <= range.contentEnd; })[0];
      if (inside) return { start: start, end: end, wrap: false, selected: value.slice(start, end), block: false };
      const touched = ranges.filter(function (range) { return range.start < end && range.end > start; });
      if (touched.length) {
        const from = Math.min.apply(null, [start].concat(touched.map(function (range) { return range.start; })));
        const to = Math.max.apply(null, [end].concat(touched.map(function (range) { return range.end; })));
        let selected = value.slice(from, to);
        for (const range of touched) {
          if (range.raw && selected.indexOf(range.raw) >= 0) selected = selected.replace(range.raw, range.value);
        }
        return { start: from, end: to, wrap: true, selected: selected, block: touched.some(function (range) { return range.block; }) };
      }
      return { start: start, end: end, wrap: true, selected: value.slice(start, end), block: false };
    }

    // 光标在公式内部（含紧贴左/右定界符）时只插源码。
    const inside = ranges.filter(function (range) { return start >= range.contentStart && start <= range.contentEnd; })[0];
    if (inside) return { start: start, end: end, wrap: false, selected: "", block: false };
    // 光标落在 $$ / \] 的第二个字符之间时，算在公式内部，插到内容末尾。
    const closing = ranges.filter(function (range) { return start > range.contentEnd && start < range.end; })[0];
    if (closing) return { start: closing.contentEnd, end: closing.contentEnd, wrap: false, selected: "", block: false };
    const opening = ranges.filter(function (range) { return start > range.start && start < range.contentStart; })[0];
    if (opening) return { start: opening.contentStart, end: opening.contentStart, wrap: false, selected: "", block: false };
    // 紧贴在公式右侧 / 左侧：接着已有公式写，不另起一对 $，避免连续插入变成 $x$$y$。
    const after = ranges.filter(function (range) { return start === range.end; })[0];
    if (after) return { start: after.contentEnd, end: after.contentEnd, wrap: false, selected: "", block: false };
    const before = ranges.filter(function (range) { return start === range.start; })[0];
    if (before) return { start: before.contentStart, end: before.contentStart, wrap: false, selected: "", block: false };
    return { start: start, end: end, wrap: true, selected: "", block: false };
  }

  function escapeMathText(value) {
    const map = {
      "\\": "\\textbackslash{}", "{": "\\{", "}": "\\}", "$": "\\$",
      "%": "\\%", "_": "\\_", "^": "\\textasciicircum{}", "&": "\\&",
      "#": "\\#", "~": "\\textasciitilde{}"
    };
    let out = "";
    for (const ch of String(value == null ? "" : value)) {
      if (ch === "\n" || ch === "\r" || ch === "\t") {
        out += " ";
        continue;
      }
      out += map[ch] != null ? map[ch] : ch;
    }
    return out;
  }

  // 选中的普通文字放进公式时用 \text{}，避免中文/换行/美元符号破坏公式结构。
  function mathTextFragment(value) {
    const text = String(value == null ? "" : value);
    if (!text) return "";
    if (/[\u3400-\u9fff\u3000-\u303f\uff01-\uff60\n\r]/.test(text) || text.indexOf("$") >= 0) {
      return "\\text{" + escapeMathText(text) + "}";
    }
    return text;
  }

  function buildInsert(insert, selected) {
    const parts = String(insert == null ? "" : insert).split("$0");
    if (parts.length === 1) return { text: String(insert == null ? "" : insert), caret: String(insert == null ? "" : insert).length };
    if (selected) {
      const text = parts[0] + selected + parts.slice(1).join("");
      return { text: text, caret: text.length };
    }
    const text = parts.join("");
    return { text: text, caret: parts[0].length };
  }

  /* ---------- 矩阵 / 行列式入口 ---------- */

  function handleAction(instance, key, button) {
    if (key.action !== "matrix-dialog") return;
    const dialog = window.formulaMatrix;
    if (!dialog || typeof dialog.open !== "function") {
      showHint(instance, "矩阵面板未就绪");
      return;
    }
    flash(button);
    dialog.open({
      kind: key.dialogKind === "determinant" ? "determinant" : "matrix",
      onInsert: function (payload) {
        applyMatrix(instance, payload, button);
      },
      onClose: function () {
        // 关掉面板后把焦点还给原输入框，用户可以接着打字
        if (instance.kind === "formula") {
          const api = formulaApi();
          if (api && typeof api.focus === "function") api.focus();
        } else if (instance.field) {
          instance.field.focus({ preventScroll: true });
        }
      }
    });
  }

  function applyMatrix(instance, payload, button) {
    if (!payload) return;
    const label = payload.kind === "determinant" ? "行列式" : "矩阵";
    if (instance.kind === "formula") {
      const api = formulaApi();
      if (!api) {
        showHint(instance, "公式编辑器未就绪");
        return;
      }
      const ok = api.insertChip({ template: payload.template });
      showHint(instance, ok ? "已插入" + label : "公式编辑器未就绪");
      return;
    }
    insertTextAtCursor(instance, payload.text, button);
  }

  function insertKey(instance, key, button) {
    if (key.action) {
      handleAction(instance, key, button);
      return;
    }
    if (instance.kind === "formula") {
      insertIntoFormula(instance, key, button);
      return;
    }
    insertTextAtCursor(instance, key.insert, button);
  }

  function insertTextAtCursor(instance, insert, button) {
    const field = instance.field;
    const value = field.value;
    const rawStart = Math.min(field.selectionStart == null ? value.length : field.selectionStart, value.length);
    const rawEnd = Math.min(Math.max(field.selectionEnd == null ? rawStart : field.selectionEnd, rawStart), value.length);
    const plan = planInsertion(value, rawStart, rawEnd);
    const selected = plan.wrap ? mathTextFragment(plan.selected) : plan.selected;
    const built = buildInsert(insert, selected);
    if (!built.text) {
      showHint(instance, "没有可插入的内容");
      return;
    }

    const block = plan.wrap && (plan.block || /\\begin\{/.test(String(insert || "")));
    // 紧挨着普通文字里的字面 $（例如“价格 $5 到 $10”）时改用 \(...\) / \[...\]，
    // 避免新公式的 $ 与价格里的 $ 配对或拼成 $$ 被误当成块级公式。
    const nextToDollar = value.charAt(plan.start - 1) === "$" || value.charAt(plan.end) === "$" || hasLiteralDollar(value);
    let open = "";
    let close = "";
    if (plan.wrap) {
      if (block) {
        open = nextToDollar ? "\\[" : "$$";
        close = nextToDollar ? "\\]" : "$$";
      } else {
        open = nextToDollar ? "\\(" : "$";
        close = nextToDollar ? "\\)" : "$";
      }
    }
    const text = open + built.text + close;

    const maxLength = field.maxLength;
    const nextLength = value.length - (plan.end - plan.start) + text.length;
    if (maxLength > 0 && nextLength > maxLength) {
      showHint(instance, "已达字数上限");
      return;
    }

    field.focus({ preventScroll: true });
    field.setRangeText(text, plan.start, plan.end, "end");
    const caretPos = Math.min(plan.start + open.length + built.caret, field.value.length);
    try {
      field.setSelectionRange(caretPos, caretPos);
    } catch (error) {
      /* 部分输入类型不支持 setSelectionRange，忽略 */
    }
    field.dispatchEvent(new Event("input", { bubbles: true }));

    flash(button);
    showHint(instance, "已插入");
  }

  function flash(button) {
    button.classList.add("is-pressed");
    window.setTimeout(function () {
      button.classList.remove("is-pressed");
    }, PRESSED_MS);
  }

  function showHint(instance, message) {
    instance.hint.textContent = message;
    if (instance.hintTimer) window.clearTimeout(instance.hintTimer);
    instance.hintTimer = window.setTimeout(function () {
      instance.hint.textContent = "";
      instance.hintTimer = null;
    }, HINT_MS);
  }

  /* ---------- 展开 / 收起 ---------- */

  function floatingViewport() {
    const visual = window.visualViewport;
    const width = (visual && Number(visual.width)) || Number(window.innerWidth) || 0;
    const height = (visual && Number(visual.height)) || Number(window.innerHeight) || 0;
    if (width && height) return { width: width, height: height };
    const html = document.documentElement;
    return {
      width: Math.max(0, (html && html.clientWidth) || 0),
      height: Math.max(0, (html && html.clientHeight) || 0)
    };
  }

  function positionFloating(instance) {
    if (!instance || !instance.floating || !instance.open) return;
    if (!instance.panel || instance.panel.hidden) return;
    const anchor = rectOf(instance.field);
    if (!anchor) {
      // 锚点已经不在页面上了（切到原文 / 切页 / 表单收起）：直接收起，别留悬空面板。
      close(instance);
      return;
    }
    let attach = null;
    let submit = null;
    try {
      attach = rectOf(document.querySelector(FLOATING.attachSelector));
      submit = rectOf(document.querySelector(FLOATING.submitSelector));
    } catch (error) {
      /* 其它页面没有这两个按钮，退回输入框宽度 */
    }
    const box = computeFloatingBox({
      anchor: anchor,
      attach: attach,
      submit: submit,
      viewport: floatingViewport()
    });
    if (!box) return;
    instance.panel.style.left = box.left + "px";
    instance.panel.style.top = box.top + "px";
    instance.panel.style.width = box.width + "px";
    instance.panel.style.maxHeight = box.maxHeight + "px";
    instance.panel.classList.toggle("is-compact", box.compact);
    instance.box = box;
  }

  function scheduleFloating(instance) {
    if (!instance || !instance.floating || !instance.open) return;
    if (instance.floatFrame) return;
    const raf = window.requestAnimationFrame || function (fn) {
      return window.setTimeout(fn, 16);
    };
    instance.floatFrame = raf(function () {
      instance.floatFrame = 0;
      positionFloating(instance);
    });
  }

  function bindFloatingTracking(instance) {
    if (!instance.floating || instance.floatBound) return;
    instance.floatBound = true;
    const update = function () {
      scheduleFloating(instance);
    };
    const add = function (target, type, handler, capture) {
      if (!target || typeof target.addEventListener !== "function") return;
      target.addEventListener(type, handler, Boolean(capture));
      instance.floatHandlers.push([target, type, handler, Boolean(capture)]);
    };
    add(window, "resize", update);
    add(window, "orientationchange", update);
    add(document, "scroll", update, true);
    add(instance.field, "input", update);
    if (window.visualViewport && window.visualViewport.addEventListener) {
      add(window.visualViewport, "resize", update);
      add(window.visualViewport, "scroll", update);
    }
    // 输入框自己变高变矮（长文换行、视图切换）时跟着挪。
    if (typeof window.ResizeObserver === "function") {
      try {
        const observer = new window.ResizeObserver(update);
        observer.observe(instance.field);
        instance.floatObserver = observer;
      } catch (error) {
        instance.floatObserver = null;
      }
    }
  }

  function unbindFloatingTracking(instance) {
    if (!instance || !instance.floatBound) return;
    instance.floatBound = false;
    while (instance.floatHandlers.length) {
      const entry = instance.floatHandlers.pop();
      try {
        entry[0].removeEventListener(entry[1], entry[2], entry[3]);
      } catch (error) {
        /* 环境不支持时忽略 */
      }
    }
    if (instance.floatObserver) {
      try {
        instance.floatObserver.disconnect();
      } catch (error) {
        /* 忽略 */
      }
      instance.floatObserver = null;
    }
    if (instance.floatFrame) {
      const cancel = window.cancelAnimationFrame;
      if (typeof cancel === "function") cancel(instance.floatFrame);
      instance.floatFrame = 0;
    }
  }

  function open(instance) {
    if (openInstance && openInstance !== instance) close(openInstance);
    instance.panel.hidden = false;
    instance.panel.classList.add("is-open");
    instance.open = true;
    instance.openedAt = Date.now();
    openInstance = instance;
    if (instance.floating) {
      // 先定位再显示，避免面板先出现在左上角闪一下。
      positionFloating(instance);
      if (!instance.open) return;
      bindFloatingTracking(instance);
      scheduleFloating(instance);
    }
  }

  function close(instance) {
    instance.panel.hidden = true;
    instance.panel.classList.remove("is-open");
    instance.open = false;
    if (instance.floating) unbindFloatingTracking(instance);
    if (openInstance === instance) openInstance = null;
  }

  /* ---------- 事件委托 ---------- */

  // 面板绑定的「输入源」是否持有焦点：文字框是元素本身，公式编辑器是它的根容器
  function instanceHasFocus(instance, active) {
    if (!active) return false;
    if (instance.kind === "formula") return instance.field.contains(active);
    return active === instance.field;
  }

  // 焦点落到这些控件上时不要立刻收起面板：面板在文档流里，收起会让按钮在 mouseup
  // 之前移动，浏览器就不再把这次点击算到按钮上（提交按钮最容易被吃掉）。
  function keepsPanelUntilClick(target) {
    if (!(target instanceof Element) || !target.closest) return false;
    return Boolean(target.closest("button, a, label, input, textarea, select, summary, [role='button']"));
  }

  function focusInstanceField(instance) {
    if (instance.kind === "formula") {
      const api = formulaApi();
      if (api && typeof api.focus === "function") api.focus();
      return;
    }
    instance.field.focus({ preventScroll: true });
  }

  document.addEventListener("focusin", function (event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (openInstance && openInstance.panel.contains(target)) return;

    // 焦点在可视化公式编辑器里：为这个编辑器单独建一个带方向键控制盘的面板
    const formulaHost = target.closest ? target.closest(".formula-editor-host") : null;
    if (formulaHost) {
      if (!formulaApi()) return;
      const instance = getInstance(formulaHost, "formula");
      if (autoEnabled()) open(instance);
      else if (openInstance && openInstance !== instance) close(openInstance);
      return;
    }

    if (target.matches && target.matches(FIELD_SELECTOR)) {
      if (shouldSkip(target)) {
        if (openInstance && openInstance.field !== target) close(openInstance);
        return;
      }
      const instance = getInstance(target);
      if (autoEnabled()) open(instance);
      else if (openInstance && openInstance !== target) close(openInstance);
      return;
    }

    // 普通按钮/空白处获得焦点时收起文字输入框的面板；按钮/输入框留给 click 阶段，
    // 否则面板收起造成的位移会让 mouseup 落到别的元素上，提交点击丢失。
    if (openInstance && openInstance.kind !== "formula" && !keepsPanelUntilClick(target)) close(openInstance);
  });

  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape" || !openInstance) return;
    const active = document.activeElement;
    if (!instanceHasFocus(openInstance, active) && !openInstance.panel.contains(active)) return;
    const instance = openInstance;
    close(instance);
    if (instance.panel.contains(active)) focusInstanceField(instance);
    event.preventDefault();
  });

  document.addEventListener("pointerdown", function (event) {
    if (!openInstance) return;
    // 公式编辑器面板不在这里收起（见 focusin / click 的说明）
    if (openInstance.kind === "formula") return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (openInstance.panel.contains(target)) return;
    // 输入方式 / ∑ 公式 按钮自己会管理面板，别在它们按下时抢先收起
    if (target instanceof Element && target.closest && target.closest(".composer-formula-toggle, #draft-view-toggle")) return;
    if (instanceHasFocus(openInstance, target)) return;
    if (keepsPanelUntilClick(target)) return;
    close(openInstance);
  });

  // 输入框 / 公式编辑器已经聚焦时再点一次（例如刚收起面板），也应重新展开。
  document.addEventListener("click", function (event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const formulaHost = target.closest ? target.closest(".formula-editor-host") : null;
    if (formulaHost) {
      if (formulaApi() && autoEnabled()) open(getInstance(formulaHost, "formula"));
      return;
    }
    if (target.matches(FIELD_SELECTOR) && !shouldSkip(target) && autoEnabled()) {
      open(getInstance(target));
      return;
    }
    // 文字输入框的面板：到 click 阶段才收起，保证按钮的 click 已经派发完成。
    if (openInstance && openInstance.kind !== "formula" && !openInstance.panel.contains(target)) {
      const justOpened = Date.now() - (openInstance.openedAt || 0) < 700;
      if (!justOpened) close(openInstance);
    }
    // 公式编辑器面板：点击编辑器与面板之外的区域时收起（click 阶段，避免布局位移吃掉点击）
    if (openInstance && openInstance.kind === "formula" && !openInstance.panel.contains(target)) {
      // 输入方式 / 来源 tab / ∑ 按钮自己管理面板状态（切模式时会主动收起），不要再抢先关一次；
      // 面板刚打开（如点 ∑ 按钮后表单被向下推、这次 click 落到表单外）时的同一次点击也不关。
      const keepSelector = "#draft-view-toggle, [data-source], .composer-formula-toggle";
      const justOpened = Date.now() - (openInstance.openedAt || 0) < 700;
      if (!justOpened && !(target.closest && target.closest(keepSelector))) {
        close(openInstance);
      }
    }
  });

  // 输入框被隐藏（切换页面、提交后 form 收起）时顺手收起面板，避免留下悬空面板。
  document.addEventListener("focusout", function (event) {
    const field = event.target;
    if (!(field instanceof Element)) return;
    const instance = instances.get(field);
    if (!instance || !instance.open) return;
    window.setTimeout(function () {
      if (!instance.open) return;
      const active = document.activeElement;
      const insideField = instance.kind === "formula" ? Boolean(active && field.contains(active)) : active === field;
      if (insideField || instance.panel.contains(active)) return;
      if (field.offsetParent === null || !field.isConnected) close(instance);
    }, 0);
  });

  // 切换「原文 / 渲染」后，主页输入框这一侧的符号表要跟着换锚点：旧锚点被藏起来
  // （rect 变 0）就收起，焦点落到新编辑器时 focusin 会重新开在同一位置。
  window.addEventListener("math-draft-view-change", function () {
    if (!openInstance) return;
    if (!isFloatingAnchor(openInstance.field)) return;
    if (!rectOf(openInstance.field)) close(openInstance);
    else scheduleFloating(openInstance);
  });

  // 供调试 / 自动化测试读取目录规模，不暴露任何写操作。
  window.mathKeyboard = {
    categories: CATALOG.map(function (category) {
      return { id: category.id, label: category.label, count: category.keys.length };
    }),
    // 纯函数：只计算这次插入的落点和是否需要包定界符，便于自检。
    planInsert: planInsertion,
    // 纯函数：主页悬浮符号表的位置、宽度与可用高度（不读 DOM）。
    floatingBox: computeFloatingBox,
    floatingDefaults: FLOATING,
    version: "20261120-floating-panel"
  };
})();
