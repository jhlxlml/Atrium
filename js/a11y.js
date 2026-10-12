/* ============================================================
   Atrium · a11y.js  （无障碍共用件）
   ------------------------------------------------------------
   这一层只做两件事，四个容器（删除确认弹层 / 设置面板 / 灯箱 / 相框浮层）
   共用同一份实现。分开写必然走形 —— 这个仓库已经在"同一个功能四处漏接"
   上栽过三次（v1.6.0 按钮分发、v1.8.0 相框设置键、v1.8.1 init 重放）。

     1) live(msg)      常驻 aria-live 区播报。toast 有 50 处调用点，
                        覆盖"已移入回收站""已还原 3 张""导出失败"这类
                        **只有反馈、没有其它视觉痕迹**的操作 —— 不播报等于没发生。
     2) trap(el, o)    焦点陷阱：打开移入 → Tab 圈住 → 关闭还原出发控件。

   纯函数 isTabbableAttr / stepIndex / pickInitialIdx 抽出来是为了能在 Node
   的 vm 沙箱里单测（照 test/frame.test.js 的做法），不必为了一行边界数学
   去起一个 Chromium。

   **刻意不用 inert 屏蔽背景**：探针大量直接在背景 DOM 上 click() 与读属性，
   一加 inert 元素就变成不可交互，全部探针会误报成"按钮坏了"。这里只在
   keydown 捕获阶段拦 Tab 做循环，不改背景 DOM —— 零侵入，几何断言不受影响。
   ============================================================ */
(function (global) {
  'use strict';

  const A11y = {};

  /* ---------- 可聚焦元素的选择与排序 ---------- */
  /** 候选选择器：与 HTML 规范里"可聚焦"的定义对齐，删掉了几种本项目不用的（如 <summary>） */
  const FOCUSABLE_SEL = [
    'a[href]', 'area[href]',
    'button', 'input', 'select', 'textarea',
    'iframe',
    'audio[controls]', 'video[controls]',
    '[contenteditable]',
    '[tabindex]',
  ].join(',');

  /**
   * 由「tabindex 原始属性值」与「是否原生可聚焦」算出该元素的 Tab 序下标。
   * 返回 -1 表示不进 Tab 序。抽成纯函数是为了单测那几个边界：
   *   - 属性缺省：原生可聚焦 = 0，否则不进序
   *   - 属性是空串 / 非数字：按缺省处理（HTML 规范就是这么定的）
   *   - 负数：显式移出 Tab 序 —— 网格瓦片上的收藏 / 删除按钮正是这么做的
   */
  A11y.isTabbableAttr = function (tabindexRaw, nativeFocusable) {
    const fallback = nativeFocusable ? 0 : -1;
    if (tabindexRaw === null || tabindexRaw === undefined || tabindexRaw === '') return fallback;
    const n = parseInt(tabindexRaw, 10);
    if (!Number.isFinite(n)) return fallback;
    return n;
  };

  /**
   * Tab / Shift+Tab 在陷阱内循环时的下一个下标。
   *   - len <= 0 → -1（没有可聚焦元素，调用方应把焦点钉在容器上）
   *   - cur 不在 [0,len) 内（-1 或越界）→ 正向从头、反向从尾
   *   - 其余情况取模环绕，这就是"圈住"的全部数学
   */
  A11y.stepIndex = function (len, cur, shift) {
    if (!(len > 0)) return -1;
    const back = !!shift;
    if (!(cur >= 0) || cur >= len) return back ? len - 1 : 0;
    return back ? (cur - 1 + len) % len : (cur + 1) % len;
  };

  /**
   * 选「打开容器时该移焦到第几个候选」。按优先级：
   *   1) opts.autofocus —— 调用方明确指定下标（最硬的意图）
   *   2) markers 里第一个 true —— 元素上带 data-autofocus，跨重建也稳
   *   3) opts.preferIndex —— 兜底偏好。删除确认弹层用它把焦点放在
   *      「取消」而不是「永久删除」上：危险的默认值不该是回车即触发
   *   4) 第一个候选
   * 返回 -1 表示候选为空。
   */
  A11y.pickInitialIdx = function (markers, opts) {
    const o = opts || {};
    const list = markers || [];
    const n = list.length;
    if (!n) return -1;
    const ok = (i) => Number.isInteger(i) && i >= 0 && i < n;
    if (ok(o.autofocus)) return o.autofocus;
    const marked = list.indexOf(true);
    if (marked >= 0) return marked;
    if (ok(o.preferIndex)) return o.preferIndex;
    return 0;
  };

  /** 该标签名是否"天生"可聚焦（决定 tabindex 缺省时的默认行为） */
  function isNativeFocusable(el) {
    const tag = el.tagName;
    if (tag === 'A' || tag === 'AREA') return el.hasAttribute('href');
    if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT'
      || tag === 'TEXTAREA' || tag === 'IFRAME') return true;
    if (tag === 'AUDIO' || tag === 'VIDEO') return el.hasAttribute('controls');
    return false;
  }

  /**
   * 该元素当前是否真的渲染出来了（不可见的东西不该进 Tab 序）。
   * 注意**不能**只看 getClientRects().length —— visibility:hidden 的元素照样有盒模型，
   * 光看 rects 会把它们当成可聚焦。相框的控制条正是 visibility:hidden（靠感应区驱动的
   * 那个显隐），漏判的后果是陷阱把 Tab 送进一排看不见的按钮。
   * visibility 是继承属性：祖先 hidden 时后代算出来也是 hidden，所以这一查就覆盖了
   * "整条控制条被藏起来"这种祖先级别的隐藏。
   */
  function isRendered(el) {
    if (!el.isConnected) return false;
    const cs = global.getComputedStyle ? global.getComputedStyle(el) : null;
    if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
    // <area> 这类天生没有盒子但确实可聚焦；其余情况必须有盒子才算渲染出来
    return el.getClientRects().length > 0 || el.tagName === 'AREA';
  }

  /**
   * 容器内当前可 Tab 到的元素，**按 DOM 顺序**（浏览器原生 Tab 序在无正 tabindex
   * 时就是 DOM 序；本项目没有用正 tabindex，所以 DOM 序即 Tab 序）。
   * 每次都现算，不缓存 —— 灯箱的缩略图条 / 信息面板会在打开期间增删元素。
   */
  A11y.focusables = function (root) {
    const out = [];
    if (!root || !root.querySelectorAll) return out;
    const nodes = root.querySelectorAll(FOCUSABLE_SEL);
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (el.disabled) continue;
      if (el.hidden) continue;
      const ti = A11y.isTabbableAttr(el.getAttribute('tabindex'), isNativeFocusable(el));
      if (ti < 0) continue;
      if (!isRendered(el)) continue;
      // 祖先里若有 hidden，getClientRects 已经空了，这里不必再往上爬
      out.push(el);
    }
    return out;
  };

  /* ================= 常驻播报区 ================= */
  let liveEl = null;

  /** 兜底建区：正常路径下 index.html 里已经写好 #a11yLive，这里只在它缺失时补一个 */
  function ensureLive() {
    if (liveEl && liveEl.isConnected) return liveEl;
    liveEl = document.getElementById('a11yLive');
    if (!liveEl) {
      // 极端早期（脚本还没跑到 body 就是）调用播报时宁可放弃，也不要抛错 ——
      // 播报挂掉不该把触发它的那个业务动作一起带崩
      if (!document.body || !document.createElement) return null;
      liveEl = document.createElement('div');
      liveEl.id = 'a11yLive';
      liveEl.className = 'sr-only';
      liveEl.setAttribute('role', 'status');
      liveEl.setAttribute('aria-live', 'polite');
      liveEl.setAttribute('aria-atomic', 'true');
      document.body.appendChild(liveEl);
    }
    return liveEl;
  }

  /**
   * 播报一条消息。urgent=true 走 assertive + role=alert（失败 / 危险操作），
   * 其余走 polite + role=status（"已移入回收站"这类完成提示）。
   * 刻意**不清空**已写入的内容：一是 sr-only 里留着无害，二是探针要在动作之后
   * 稳定读到文本，自动清空会让断言变成跟定时器赛跑。
   */
  A11y.live = function (msg, opts) {
    const o = opts || {};
    const el = ensureLive();
    if (!el) return false;
    const urgent = !!o.urgent;
    const role = urgent ? 'alert' : 'status';
    const mode = urgent ? 'assertive' : 'polite';
    if (el.getAttribute('role') !== role) el.setAttribute('role', role);
    if (el.getAttribute('aria-live') !== mode) el.setAttribute('aria-live', mode);

    const next = String(msg === null || msg === undefined ? '' : msg);
    // 内容与上次完全相同 → 辅助技术收不到"变更"事件，同一条消息连播两次会静默。
    // 先把文本挪走再写回，保证每次调用都产生一次可观测的变更。
    if (el.textContent === next) el.textContent = '';
    el.textContent = next;
    // 给探针用的两个落点：最后一次播报了什么、播报了多少次
    el.__last = next;
    el.__count = (el.__count || 0) + 1;
    return true;
  };

  /** 探针 / 自检用的只读快照（不参与产品逻辑） */
  A11y.liveState = function () {
    const el = global.document ? document.getElementById('a11yLive') : null;
    if (!el) return { present: false, count: 0, last: '', live: '', role: '' };
    return {
      present: true,
      count: el.__count || 0,
      last: el.__last || '',
      live: el.getAttribute('aria-live') || '',
      role: el.getAttribute('role') || '',
      text: el.textContent || '',
    };
  };

  /* ================= 焦点陷阱 ================= */
  /** 在容器里挑打开时要移焦到的元素；一个候选都没有就把焦点钉在容器本身 */
  function firstIn(container, o) {
    const list = A11y.focusables(container);
    if (!list.length) return container;   // trap 已保证容器带 tabindex=-1，可接收程序化焦点
    const markers = list.map((el) => !!(el.hasAttribute && el.hasAttribute('data-autofocus')));
    const idx = A11y.pickInitialIdx(markers, o);
    return idx >= 0 ? list[idx] : list[0];
  }

  /**
   * 打开容器时调用，返回 release()。**关闭时必须调用 release()**，
   * 否则 Tab 拦截会一直挂在 document 上（灯箱关了但键盘还被圈着 = 更糟）。
   *
   * o.initial      打开时移焦到哪个元素（不给则按 pickInitialIdx 在容器内挑）
   * o.autofocus    直接指定候选下标
   * o.preferIndex  兜底偏好下标（见 pickInitialIdx）
   * o.restore      关闭时还原到哪个元素（不给则还原到"打开前焦点所在"）
   * o.skipInitial  只装 Tab 拦截、不主动移焦（相框窗口这种"整个窗口就是容器"的场景）
   */
  A11y.trap = function (container, opts) {
    const o = opts || {};
    if (!container || !container.addEventListener) return function () {};

    // 容器本身要能接收**程序化**焦点（tabindex=-1 只影响脚本 focus()，
    // 不会把容器塞进 Tab 序）。两个用处：容器里没有可聚焦元素时把焦点钉住；
    // 以及调用方可以直接 container.focus() 来触发容器的 focusin（相框就靠这个
    // 把键盘焦点变成"控制条该出现了"的信号）。
    if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');

    // 打开前的落点：关掉之后要能回到这里，否则键盘用户被扔回页面开头
    const prev = (document.activeElement && document.activeElement !== document.body)
      ? document.activeElement : null;
    const returnTo = o.restore || prev;

    const onKey = (e) => {
      if (e.key !== 'Tab') return;
      const list = A11y.focusables(container);
      if (!list.length) {
        // 容器里没有可聚焦元素 → 把焦点钉在容器上，别让它漏到背景去
        // （相框的页内浮层就是这种：控制条藏着时容器内一个可聚焦元素都没有，
        // 第一次 Tab 先落到容器上，容器的 focusin 把控制条亮出来，第二次 Tab 才进条）
        e.preventDefault();
        container.focus();
        return;
      }
      const cur = list.indexOf(document.activeElement);
      const nextIdx = A11y.stepIndex(list.length, cur, e.shiftKey);
      e.preventDefault();
      list[nextIdx].focus();
    };

    document.addEventListener('keydown', onKey, true);

    if (!o.skipInitial) {
      const initial = o.initial || firstIn(container, o);
      if (initial && initial.focus) initial.focus();
    }

    let released = false;
    return function release() {
      if (released) return;
      released = true;
      document.removeEventListener('keydown', onKey, true);
      if (o.skipRestore) return;
      // 只在"焦点还在容器内 / 已丢失到 body"时抢回来。
      // 否则会把用户在关闭之后手动移去、且确实更晚的焦点（比如刚点开的搜索框）无故夺走。
      const a = document.activeElement;
      const inside = !!a && (a === container || container.contains(a));
      if (!a || a === document.body || inside) {
        if (returnTo && returnTo.isConnected && returnTo.focus) returnTo.focus();
      }
    };
  };

  /* ---------- 语义补全小工具 ---------- */
  /**
   * 给容器一个「可及名称」。有现成标题元素就挂 aria-labelledby（题目会随内容变，
   * 引用 id 比复制一份字符串更不容易写歪）；否则退回 aria-label。
   */
  A11y.name = function (container, labelEl, text) {
    if (!container || !container.setAttribute) return;
    if (labelEl && labelEl.id) {
      container.setAttribute('aria-labelledby', labelEl.id);
      container.removeAttribute('aria-label');
      return;
    }
    if (text) {
      container.setAttribute('aria-label', text);
      container.removeAttribute('aria-labelledby');
    }
  };

  global.A11y = A11y;
})(window);
