"use strict";
/*
 * 统一对话首页的交互切片：全局导航浮层 + 左右面板收展 / 拖拽 / 限宽。
 *
 * 由整合方显式初始化（本文件不自动运行、不查找 DOM）：
 *
 *   const panels = window.homePanels.create({
 *     root,                                  // 主页容器（面板与对话区都在里面）
 *     nav,                                   // 全局导航（窄栏 / 浮层）
 *     leftPanel, rightPanel,                 // 左：历史对话；右：本对话文件
 *     leftHandle, rightHandle,               // 两条竖直分隔线
 *     leftButton, rightButton,               // 两个并排矩形收展按钮
 *     minConversationWidth: 440,             // 桌面最小对话宽度
 *     narrowBreakpoint: 820,                 // 窄屏断点（<= 时只用覆盖抽屉）
 *     leftWidth: 264, rightWidth: 320,       // 首次展开宽度
 *     leftOpen: true, rightOpen: false,      // 初始是否展开（窄屏一律先收起）
 *     navWidth: 0,                           // 主页容器若压在导航栏下方，传入导航栏占宽
 *     minLeftWidth: 196,                     // 左栏可呈现下限（与 .home-history-inner 对齐）
 *   });
 *
 *   panels.collapseFiles();   // 切换聊天时收起右侧「本对话文件」，返回是否有变化
 *   panels.destroy();         // 页面离开 / 销毁时移除监听、定时器并还原属性
 *   panels.refresh();         // 容器尺寸改变后手动重算（已自带 resize / ResizeObserver）
 *   panels.getState();        // 只读状态快照（调试与测试用）
 *
 * 左栏拖拽语义（minLeftWidth）：
 *   向左拖动时宽度先降到 minLeftWidth 并锁在那里（不会在中途吸附收起）；
 *   只有指针真正越过左栏自身的左边缘（导航栏 / 历史栏的分界线，取主页容器在
 *   视口里的真实左边缘，而不是用手柄指针坐标反推）时，才瞬间整栏收起。
 *   在下限与分界线之间松手保持当前宽度，不归零。右栏仍沿用 snapThreshold 的旧语义。
 *
 * 状态输出（CSS 只读这些钩子，不依赖本文件做布局）：
 *   根节点 CSS 变量
 *     --home-left-width            左侧面板当前宽度（窄屏为 0）
 *     --home-right-width           右侧面板当前宽度（窄屏为 0）
 *     --home-conversation-width    两侧之间剩余宽度
 *     --home-conversation-min-width 最小对话宽度
 *   根节点 data 属性
 *     data-home-layout="wide|narrow"
 *     data-home-left="open|closed"
 *     data-home-right="open|closed"
 *     data-home-nav="open|closed"
 *     data-home-dragging="left|right"（仅拖动期间存在）
 *   面板
 *     data-home-state="open|closed"、aria-hidden、inert
 *   分隔线
 *     role="separator"、aria-orientation、aria-label、aria-valuemin/max/now/valuetext、
 *     tabindex（收起时 -1）、aria-hidden、inert
 *   按钮
 *     aria-expanded、aria-controls（面板有 id 时）、data-home-toggle
 *   导航
 *     data-home-nav="open|closed"
 *
 * 本文件只改属性与 CSS 变量：不移动 / 克隆 / 重建任何节点，不读写输入值、选区、
 * 公式编辑器或全局状态，因此草稿、渲染结果和键盘行为保持原样。
 */
(function (global) {
  const DEFAULTS = Object.freeze({
    minConversationWidth: 440,
    narrowBreakpoint: 820,
    navHoverDelay: 500,
    leftWidth: 264,
    rightWidth: 320,
    maxLeftWidth: 420,
    maxRightWidth: 480,
    // 左栏可呈现下限：与 `.home-history-inner` 的 min-width 一起保证内部布局不被截断。
    minLeftWidth: 196,
    snapThreshold: 48,
    keyboardStep: 16,
    keyboardLargeStep: 64,
    navWidth: 0,
  });

  const REQUIRED_NODES = [
    "root",
    "nav",
    "leftPanel",
    "rightPanel",
    "leftHandle",
    "rightHandle",
    "leftButton",
    "rightButton",
  ];

  function readNumber(value, fallback, minimum) {
    if (typeof value !== "number" || !isFinite(value)) return fallback;
    return Math.max(minimum, value);
  }

  function createHomePanels(options) {
    if (!options || typeof options !== "object") {
      throw new TypeError("homePanels.create(options)：需要配置对象");
    }
    const missing = REQUIRED_NODES.filter((name) => !options[name]);
    if (missing.length) {
      throw new TypeError(
        "homePanels.create(options)：缺少 DOM 节点 " + missing.join("、")
      );
    }

    const root = options.root;
    const nav = options.nav;
    const leftPanel = options.leftPanel;
    const rightPanel = options.rightPanel;
    const leftHandle = options.leftHandle;
    const rightHandle = options.rightHandle;
    const leftButton = options.leftButton;
    const rightButton = options.rightButton;

    const doc = options.document || root.ownerDocument || global.document;
    const win = options.window || (doc && doc.defaultView) || global;
    if (!doc) {
      throw new TypeError("homePanels.create(options)：找不到 document");
    }

    const cfg = {
      minConversationWidth: readNumber(
        options.minConversationWidth,
        DEFAULTS.minConversationWidth,
        1
      ),
      narrowBreakpoint: readNumber(
        options.narrowBreakpoint,
        DEFAULTS.narrowBreakpoint,
        1
      ),
      navHoverDelay: readNumber(options.navHoverDelay, DEFAULTS.navHoverDelay, 0),
      leftWidth: readNumber(options.leftWidth, DEFAULTS.leftWidth, 0),
      rightWidth: readNumber(options.rightWidth, DEFAULTS.rightWidth, 0),
      maxLeftWidth: readNumber(options.maxLeftWidth, DEFAULTS.maxLeftWidth, 0),
      maxRightWidth: readNumber(options.maxRightWidth, DEFAULTS.maxRightWidth, 0),
      minLeftWidth: readNumber(
        options.minLeftWidth,
        DEFAULTS.minLeftWidth,
        0
      ),
      snapThreshold: readNumber(
        options.snapThreshold,
        DEFAULTS.snapThreshold,
        0
      ),
      keyboardStep: readNumber(options.keyboardStep, DEFAULTS.keyboardStep, 1),
      keyboardLargeStep: readNumber(
        options.keyboardLargeStep,
        DEFAULTS.keyboardLargeStep,
        1
      ),
      navWidth: readNumber(options.navWidth, DEFAULTS.navWidth, 0),
    };
    const measureAvailable =
      typeof options.measureAvailable === "function"
        ? options.measureAvailable
        : null;

    const preferred = {
      left: Math.max(cfg.leftWidth, 0),
      right: Math.max(cfg.rightWidth, 0),
    };
    const openState = { left: false, right: false };
    const widths = { left: 0, right: 0 };
    const lastRenderedOpen = { left: false, right: false };

    let active = true;
    let layout = viewportWidth() <= cfg.narrowBreakpoint ? "narrow" : "wide";
    let navOpen = false;
    let navHovering = false;
    let navFocusWithin = false;
    let navTimer = null;
    let drag = null;
    let resizeObserver = null;

    const listeners = [];
    const transientListeners = [];
    const attrSnapshots = new Map();
    const styleSnapshots = new Map();

    // ---- 属性 / 变量写入（带初值快照，destroy 时逐个还原） ----

    function rememberAttr(element, name) {
      let snapshot = attrSnapshots.get(element);
      if (!snapshot) {
        snapshot = new Map();
        attrSnapshots.set(element, snapshot);
      }
      if (!snapshot.has(name)) snapshot.set(name, element.getAttribute(name));
    }

    function setAttr(element, name, value) {
      if (!element) return;
      rememberAttr(element, name);
      if (value === null || value === undefined) element.removeAttribute(name);
      else element.setAttribute(name, String(value));
    }

    function ensureAttr(element, name, value) {
      if (element && !element.hasAttribute(name)) setAttr(element, name, value);
    }

    function setVar(name, value) {
      if (!styleSnapshots.has(name)) {
        const current = root.style.getPropertyValue(name);
        styleSnapshots.set(name, current ? current : null);
      }
      root.style.setProperty(name, value);
    }

    // ---- 尺寸 / 布局 ----

    function viewportWidth() {
      if (typeof win.innerWidth === "number" && win.innerWidth > 0) {
        return win.innerWidth;
      }
      const html = doc.documentElement;
      return Math.max(0, (html && html.clientWidth) || root.clientWidth || 0);
    }

    function availableWidth() {
      if (measureAvailable) {
        const measured = Number(measureAvailable());
        if (isFinite(measured) && measured >= 0) return Math.round(measured);
      }
      const rect =
        typeof root.getBoundingClientRect === "function"
          ? root.getBoundingClientRect()
          : null;
      const width = root.clientWidth || (rect && rect.width) || 0;
      return Math.max(0, Math.round(width - cfg.navWidth));
    }

    function budget() {
      return Math.max(0, availableWidth() - cfg.minConversationWidth);
    }

    function sideMax(side) {
      return side === "left" ? cfg.maxLeftWidth : cfg.maxRightWidth;
    }

    // 圈1（导航栏）/ 圈2（主页内容）的分界线：主页容器在视口里的真实左边缘
    // （宽屏下就是固定导航栏占位的右边缘）。左栏拖拽只有越过这条线才收起。
    // 不能用手柄指针坐标反推：手柄的拖拽命中区向两侧各外扩 5px，指针抓取点
    // 经常落在手柄线左侧 1–5px，反推出来的边界会整体偏左，导致「还没到边界就收起」。
    function contentLeftEdge() {
      for (const node of [root, leftPanel]) {
        if (!node || typeof node.getBoundingClientRect !== "function") continue;
        try {
          const rect = node.getBoundingClientRect();
          if (rect && typeof rect.left === "number" && isFinite(rect.left)) {
            return Math.round(rect.left);
          }
        } catch (error) {
          /* 量不到就换下一个节点 */
        }
      }
      return 0;
    }

    function otherSide(side) {
      return side === "left" ? "right" : "left";
    }

    function otherWidth(side) {
      const other = otherSide(side);
      return openState[other] ? widths[other] : 0;
    }

    function maxWidthFor(side) {
      return Math.max(
        0,
        Math.min(sideMax(side), budget() - otherWidth(side))
      );
    }

    // 左栏有可呈现下限（minLeftWidth）；右栏保持原来的 snapThreshold 语义。
    function minWidthFor(side) {
      return side === "left" ? cfg.minLeftWidth : 0;
    }

    // ---- 渲染：只写 CSS 变量与 data / ARIA 属性 ----

    function focusElement(element) {
      if (!element || typeof element.focus !== "function") return;
      try {
        element.focus({ preventScroll: true });
      } catch (error) {
        try {
          element.focus();
        } catch (ignored) {
          /* 焦点不可用时保持原状 */
        }
      }
    }

    function contains(parent, child) {
      if (!parent || !child) return false;
      if (parent === child) return true;
      if (typeof parent.contains === "function") return parent.contains(child);
      let node = child.parentNode;
      while (node) {
        if (node === parent) return true;
        node = node.parentNode;
      }
      return false;
    }

    function render() {
      if (!active) return;
      const narrow = layout === "narrow";
      const available = availableWidth();
      const remaining = Math.max(0, available - widths.left - widths.right);

      setVar("--home-left-width", widths.left + "px");
      setVar("--home-right-width", widths.right + "px");
      setVar("--home-conversation-width", remaining + "px");
      setVar("--home-conversation-min-width", cfg.minConversationWidth + "px");

      setAttr(root, "data-home-layout", layout);
      setAttr(root, "data-home-left", openState.left ? "open" : "closed");
      setAttr(root, "data-home-right", openState.right ? "open" : "closed");
      setAttr(root, "data-home-nav", navOpen ? "open" : "closed");
      setAttr(nav, "data-home-nav", navOpen ? "open" : "closed");
      if (drag) setAttr(root, "data-home-dragging", drag.side);
      else setAttr(root, "data-home-dragging", null);

      renderSide("left", narrow);
      renderSide("right", narrow);
    }

    function renderSide(side, narrow) {
      const panel = side === "left" ? leftPanel : rightPanel;
      const handle = side === "left" ? leftHandle : rightHandle;
      const button = side === "left" ? leftButton : rightButton;
      const isOpen = openState[side];
      const width = isOpen ? widths[side] : 0;
      const activeElement = doc.activeElement;
      // 关闭前若焦点在面板或分隔线内，关掉后要交给对应按钮，避免焦点留在隐藏区。
      const rescueFocus =
        !isOpen &&
        lastRenderedOpen[side] &&
        Boolean(activeElement) &&
        (contains(panel, activeElement) || activeElement === handle);

      setAttr(panel, "data-home-state", isOpen ? "open" : "closed");
      if (isOpen) {
        setAttr(panel, "aria-hidden", null);
        setAttr(panel, "inert", null);
      } else {
        setAttr(panel, "aria-hidden", "true");
        setAttr(panel, "inert", "");
      }

      const handleActive = isOpen && !narrow;
      if (handleActive) {
        setAttr(handle, "tabindex", "0");
        setAttr(handle, "aria-hidden", null);
        setAttr(handle, "inert", null);
      } else {
        setAttr(handle, "tabindex", "-1");
        setAttr(handle, "aria-hidden", "true");
        setAttr(handle, "inert", "");
      }
      setAttr(handle, "role", "separator");
      setAttr(handle, "aria-orientation", "vertical");
      ensureAttr(
        handle,
        "aria-label",
        side === "left" ? "调整左侧面板宽度" : "调整右侧面板宽度"
      );

      const maxNow = Math.max(
        0,
        Math.min(sideMax(side), budget() - otherWidth(side))
      );
      setAttr(handle, "aria-valuemin", String(isOpen ? Math.round(minWidthFor(side)) : 0));
      setAttr(handle, "aria-valuemax", String(Math.round(Math.max(maxNow, width))));
      setAttr(handle, "aria-valuenow", String(Math.round(width)));
      const sideName = side === "left" ? "左侧面板" : "右侧面板";
      setAttr(
        handle,
        "aria-valuetext",
        isOpen ? sideName + "宽度 " + Math.round(width) + " 像素" : sideName + "已收起"
      );

      setAttr(button, "aria-expanded", isOpen ? "true" : "false");
      setAttr(button, "data-home-toggle", side);
      if (panel.id) setAttr(button, "aria-controls", panel.id);

      if (rescueFocus) focusElement(button);
      lastRenderedOpen[side] = isOpen;
    }

    // ---- 收展 ----

    function openSide(side) {
      if (!active || drag) return;
      if (layout === "narrow") {
        if (openState[side]) return;
        openState[side] = true;
        render();
        return;
      }
      if (openState[side]) return;
      const limit = maxWidthFor(side);
      const floor = minWidthFor(side);
      // 有可呈现下限的一侧（左栏）：预算塞不下下限时宁可不展开，也不能把内容压到截断。
      if (floor > 0 && limit < floor) {
        openState[side] = false;
        widths[side] = 0;
        render();
        return;
      }
      let target = limit;
      if (limit > 0) {
        target = Math.round(Math.min(preferred[side], limit));
        if (floor > 0) target = Math.max(target, Math.round(floor));
      }
      if (target < cfg.snapThreshold || (floor > 0 && target < floor)) {
        openState[side] = false;
        widths[side] = 0;
        render();
        return;
      }
      openState[side] = true;
      widths[side] = target;
      render();
    }

    function closeSide(side) {
      if (drag && drag.side === side) abortDrag();
      const changed = openState[side] || widths[side] !== 0;
      openState[side] = false;
      widths[side] = 0;
      if (changed) render();
      return changed;
    }

    function toggleSide(side) {
      if (openState[side]) closeSide(side);
      else openSide(side);
    }

    // ---- 拖拽 ----

    function bindTransient(target, type, handler) {
      target.addEventListener(type, handler);
      transientListeners.push([target, type, handler]);
    }

    function clearTransient() {
      while (transientListeners.length) {
        const entry = transientListeners.pop();
        entry[0].removeEventListener(entry[1], entry[2]);
      }
    }

    function detachDrag(current) {
      clearTransient();
      try {
        if (
          current &&
          current.pointerId !== undefined &&
          typeof current.handle.releasePointerCapture === "function"
        ) {
          current.handle.releasePointerCapture(current.pointerId);
        }
      } catch (error) {
        /* 指针捕获可能已被浏览器释放 */
      }
    }

    function abortDrag() {
      if (!drag) return;
      const current = drag;
      drag = null;
      detachDrag(current);
    }

    function finishDrag(commit) {
      if (!drag) return;
      const current = drag;
      drag = null;
      detachDrag(current);
      if (commit) {
        const floor = minWidthFor(current.side);
        if (floor > 0) {
          // 有下限的一侧：松手不吸附收起，宽度至少保持在下限（且不超过当前上限）。
          const limit = maxWidthFor(current.side);
          let width = Math.max(Math.round(widths[current.side]), Math.round(floor));
          if (limit > 0) width = Math.min(width, Math.round(limit));
          widths[current.side] = width;
          openState[current.side] = true;
          preferred[current.side] = width;
        } else if (widths[current.side] <= cfg.snapThreshold) {
          widths[current.side] = 0;
          openState[current.side] = false;
        } else {
          preferred[current.side] = widths[current.side];
        }
      } else {
        widths[current.side] = current.startWidth;
      }
      render();
    }

    function snapClosed(side) {
      abortDrag();
      widths[side] = 0;
      openState[side] = false;
      render();
    }

    function onDragMove(event) {
      if (!drag) return;
      if (
        event.pointerId !== undefined &&
        drag.pointerId !== undefined &&
        event.pointerId !== drag.pointerId
      ) {
        return;
      }
      const delta = event.clientX - drag.startX;
      // 左手柄向右 / 右手柄向左都是「拉宽」；反向拖到外缘则收起。
      const raw =
        drag.side === "left" ? drag.startWidth + delta : drag.startWidth - delta;
      const limit = maxWidthFor(drag.side);
      const floor = minWidthFor(drag.side);
      if (floor > 0) {
        // 左栏：宽度先锁在下限；只有指针真正越过左栏自身的左边缘（导航栏与历史栏
        // 的分界线，从布局量取）才瞬间整栏收起。
        if (event.clientX <= drag.edge) {
          snapClosed(drag.side);
          return;
        }
        widths[drag.side] = Math.round(
          Math.max(Math.round(floor), Math.min(raw, limit))
        );
        render();
        return;
      }
      const next = Math.max(0, Math.min(raw, limit));
      if (next <= cfg.snapThreshold) {
        snapClosed(drag.side);
        return;
      }
      widths[drag.side] = Math.round(next);
      render();
    }

    function onDragEnd(event) {
      if (!drag) return;
      if (
        event.pointerId !== undefined &&
        drag.pointerId !== undefined &&
        event.pointerId !== drag.pointerId
      ) {
        return;
      }
      finishDrag(true);
    }

    function onDragCancel(event) {
      if (!drag) return;
      if (
        event &&
        event.pointerId !== undefined &&
        drag.pointerId !== undefined &&
        event.pointerId !== drag.pointerId
      ) {
        return;
      }
      finishDrag(false);
    }

    function onDragKey(event) {
      if (!drag) return;
      if (event.key !== "Escape") return;
      if (typeof event.preventDefault === "function") event.preventDefault();
      finishDrag(false);
    }

    function startDrag(side, event) {
      if (!active || layout !== "wide" || !openState[side] || drag) return;
      if (typeof event.button === "number" && event.button !== 0) return;
      const handle = side === "left" ? leftHandle : rightHandle;
      drag = {
        side,
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: widths[side],
        // 收起边界：布局里真正的圈1 / 圈2 分界线（不是手柄指针坐标 - 宽度）。
        edge: side === "left" ? contentLeftEdge() : event.clientX - widths[side],
        handle,
      };
      setAttr(root, "data-home-dragging", side);
      if (typeof event.preventDefault === "function") event.preventDefault();
      try {
        if (typeof handle.setPointerCapture === "function") {
          handle.setPointerCapture(event.pointerId);
        }
      } catch (error) {
        /* 某些环境不支持指针捕获，document 监听仍然有效 */
      }
      bindTransient(doc, "pointermove", onDragMove);
      bindTransient(doc, "pointerup", onDragEnd);
      bindTransient(doc, "pointercancel", onDragCancel);
      bindTransient(doc, "keydown", onDragKey);
      bindTransient(win, "blur", onDragCancel);
    }

    // ---- 键盘调整 ----

    function onHandleKey(side, event) {
      if (!active || layout !== "wide" || !openState[side]) return;
      const step = event.shiftKey ? cfg.keyboardLargeStep : cfg.keyboardStep;
      let next = widths[side];
      switch (event.key) {
        case "ArrowLeft":
          next += side === "left" ? -step : step;
          break;
        case "ArrowRight":
          next += side === "left" ? step : -step;
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = maxWidthFor(side);
          break;
        default:
          return;
      }
      if (typeof event.preventDefault === "function") event.preventDefault();
      const limit = maxWidthFor(side);
      const floor = minWidthFor(side);
      next = Math.max(0, Math.min(Math.round(next), Math.round(limit)));
      // 左栏用 Home 明确收起；方向键把宽度减到下限就停住，不会中途吸附关闭。
      if (floor > 0 ? next <= 0 : next <= cfg.snapThreshold) {
        openState[side] = false;
        widths[side] = 0;
        render();
        return;
      }
      if (floor > 0) next = Math.max(next, Math.round(floor));
      widths[side] = next;
      preferred[side] = next;
      render();
    }

    // ---- 窗口 / 容器尺寸变化 ----

    function fitWidths() {
      // 容器不可见时（例如切到资料页，主页 view 被 hidden）测到的宽度是 0；
      // 这时不能据此把用户打开的面板收起来。等它重新可见、尺寸回来后再重算。
      if (availableWidth() <= 0) return;
      const allowance = budget();
      let left = openState.left ? widths.left : 0;
      let right = openState.right ? widths.right : 0;
      const total = left + right;
      if (allowance <= 0) {
        left = 0;
        right = 0;
      } else if (total > allowance) {
        // 按当前实际宽度等比回缩，保持两侧相对比例，并始终留出最小对话宽度。
        const scale = allowance / total;
        left = Math.floor(left * scale);
        right = Math.floor(right * scale);
      }
      // 左栏展开时不得低于可呈现下限（低于下限就整栏收起，绝不夹到半截）。
      if (left > 0 && left < cfg.minLeftWidth) {
        left = allowance - right >= cfg.minLeftWidth ? cfg.minLeftWidth : 0;
      }
      if (right < cfg.snapThreshold) right = 0;
      widths.left = left;
      widths.right = right;
      openState.left = left > 0;
      openState.right = right > 0;
    }

    function recalculate() {
      if (!active) return;
      if (drag) finishDrag(false);
      const nextLayout =
        viewportWidth() <= cfg.narrowBreakpoint ? "narrow" : "wide";
      if (nextLayout !== layout) {
        // 进入 / 离开窄屏都回到干净的收起状态，抽屉不会残留成桌面面板。
        layout = nextLayout;
        openState.left = false;
        openState.right = false;
        widths.left = 0;
        widths.right = 0;
        render();
        return;
      }
      if (layout === "wide") fitWidths();
      render();
    }

    // ---- 全局导航浮层：鼠标停留 500ms 展开，键盘焦点立即展开 ----

    function clearNavTimer() {
      if (navTimer !== null) {
        win.clearTimeout(navTimer);
        navTimer = null;
      }
    }

    function openNav() {
      if (!active || navOpen) return;
      navOpen = true;
      render();
    }

    function closeNav() {
      clearNavTimer();
      if (!navOpen) return;
      navOpen = false;
      render();
    }

    function scheduleNav() {
      if (navTimer !== null || navOpen) return;
      navTimer = win.setTimeout(function () {
        navTimer = null;
        if (active && navHovering) openNav();
      }, cfg.navHoverDelay);
    }

    function onNavPointerEnter(event) {
      if (drag) return;
      if (event && event.pointerType === "touch") return;
      navHovering = true;
      if (!navOpen) scheduleNav();
    }

    function onNavPointerLeave(event) {
      if (event && event.pointerType === "touch") return;
      navHovering = false;
      clearNavTimer();
      if (navOpen && !navFocusWithin) closeNav();
    }

    function onNavFocusIn() {
      if (!active) return;
      clearNavTimer();
      navFocusWithin = true;
      if (!navOpen) openNav();
    }

    function onNavFocusOut(event) {
      const next = event && event.relatedTarget;
      if (next && contains(nav, next)) return;
      navFocusWithin = false;
      if (!navHovering) closeNav();
    }

    function onNavClick() {
      // 触屏点击没有 hover 阶段：点完就收回，避免浮层留在画面上。
      closeNav();
    }

    // ---- 监听注册 / 销毁 ----

    function listen(target, type, handler) {
      target.addEventListener(type, handler);
      listeners.push([target, type, handler]);
    }

    function removeListeners() {
      while (listeners.length) {
        const entry = listeners.pop();
        entry[0].removeEventListener(entry[1], entry[2]);
      }
    }

    function destroy() {
      if (!active) return;
      active = false;
      clearNavTimer();
      if (drag) {
        const current = drag;
        drag = null;
        detachDrag(current);
      } else {
        clearTransient();
      }
      removeListeners();
      if (resizeObserver) {
        try {
          resizeObserver.disconnect();
        } catch (error) {
          /* 忽略观察器断开失败 */
        }
        resizeObserver = null;
      }
      for (const [element, snapshot] of attrSnapshots) {
        for (const [name, oldValue] of snapshot) {
          if (oldValue === null) element.removeAttribute(name);
          else element.setAttribute(name, oldValue);
        }
      }
      attrSnapshots.clear();
      for (const [name, oldValue] of styleSnapshots) {
        if (oldValue === null) root.style.removeProperty(name);
        else root.style.setProperty(name, oldValue);
      }
      styleSnapshots.clear();
    }

    // ---- 初始化 ----

    if (layout === "wide") {
      const initialOpen = {
        left: options.leftOpen === undefined ? true : Boolean(options.leftOpen),
        right: Boolean(options.rightOpen),
      };
      for (const side of ["left", "right"]) {
        if (!initialOpen[side]) continue;
        const floor = minWidthFor(side);
        const limit = maxWidthFor(side);
        if (floor > 0 && limit < floor) continue;
        const target = Math.round(Math.min(preferred[side], limit));
        const usable = floor > 0 ? target >= floor : target >= cfg.snapThreshold;
        if (usable) {
          openState[side] = true;
          widths[side] = target;
        }
      }
    }

    render();

    listen(win, "resize", recalculate);
    listen(leftButton, "click", function () {
      toggleSide("left");
    });
    listen(rightButton, "click", function () {
      toggleSide("right");
    });
    listen(leftHandle, "pointerdown", function (event) {
      startDrag("left", event);
    });
    listen(rightHandle, "pointerdown", function (event) {
      startDrag("right", event);
    });
    listen(leftHandle, "keydown", function (event) {
      onHandleKey("left", event);
    });
    listen(rightHandle, "keydown", function (event) {
      onHandleKey("right", event);
    });
    listen(nav, "pointerenter", onNavPointerEnter);
    listen(nav, "pointerleave", onNavPointerLeave);
    listen(nav, "focusin", onNavFocusIn);
    listen(nav, "focusout", onNavFocusOut);
    listen(nav, "click", onNavClick);

    if (typeof win.ResizeObserver === "function") {
      try {
        resizeObserver = new win.ResizeObserver(function () {
          if (!active || drag) return;
          if (layout === "wide") fitWidths();
          render();
        });
        resizeObserver.observe(root);
      } catch (error) {
        resizeObserver = null;
      }
    }

    return {
      collapseFiles: function () {
        if (!active) return false;
        return closeSide("right");
      },
      refresh: function () {
        if (!active) return;
        recalculate();
      },
      destroy,
      getState: function () {
        const available = availableWidth();
        return {
          active,
          layout,
          navOpen,
          dragging: drag ? drag.side : null,
          viewportWidth: viewportWidth(),
          availableWidth: available,
          minConversationWidth: cfg.minConversationWidth,
          narrowBreakpoint: cfg.narrowBreakpoint,
          conversationWidth: Math.max(
            0,
            available - widths.left - widths.right
          ),
          left: {
            open: openState.left,
            width: widths.left,
            preferredWidth: preferred.left,
            maxWidth: sideMax("left"),
            minWidth: minWidthFor("left"),
          },
          right: {
            open: openState.right,
            width: widths.right,
            preferredWidth: preferred.right,
            maxWidth: sideMax("right"),
            minWidth: minWidthFor("right"),
          },
        };
      },
    };
  }

  global.homePanels = {
    create: createHomePanels,
    DEFAULTS,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = global.homePanels;
  }
})(typeof window !== "undefined" ? window : globalThis);
