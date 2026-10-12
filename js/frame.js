/* ============================================================
   Atrium · frame.js  （相框模式）
   ------------------------------------------------------------
   一个"电子相框"：图片铺满窗口随机轮播。两种落地形态：

   A) 正式形态（Electron 独立窗口）—— 主进程另开一个**无边框、置顶、按图片比例**
      的窗口（index.html?frame=1），主窗口先隐藏；退出相框再把主窗显示回来。
      这个文件在相框窗口里只负责"画"和"按比例请求窗口尺寸"。
   B) 降级形态（开窗失败）—— 相框窗口起不来时退化为**页内整屏浮层** + 全屏 API。
      随机轮播的部分完全一致，只是不能再改窗口形状/置顶。

   设计要点：
   - 随机序列用 Fisher-Yates 洗牌（不是"每次 Math.random 取一张"），
     保证一个周期内每张都出现且只出现一次；跨周期时避免首尾撞同一张。
   - 取图 URL 一律**懒解析**（每张现算）：千张相册也不会一次性造出上千个
     blob URL / 提前解码。
   - 下一张在后台预解码，切换时才不会"先黑一下再出图"。
   - 旋转过的图片按"旋转后的宽高"参与窗口比例换算。
   ============================================================ */
(function (global) {
  'use strict';

  /* ---------- 常量 ---------- */
  const DEF_MS = 6000;          // 默认停留时长
  const FADE_MS = 560;          // 交叉淡入时长（与 CSS 对齐）
  const MIN_W = 260, MIN_H = 170;
  const AREA_FILL = 0.86;       // 窗口最大占工作区比例（留点余地，别顶到边缘）
  const SNAP_THR = 14;          // 距屏幕边 ≤ 这么多像素就算"贴着"，拖动结束时吸附
  const DOCK_EDGES = ['left', 'right', 'top', 'bottom'];

  // 无障碍共用件。相框是**两条路径**：页内整屏浮层（降级）和独立无边框
  // 窗口（正式）。焦点陷阱只对前者有意义 —— 后者整个窗口就是一个容器，
  // 圈住 Tab 等于圈住唯一那一堆控件，没有意义；但"焦点进来就亮控制条"两条都要。
  const A11y = global.A11y;

  /* ============================================================
     一、纯函数（可在 Node 里直接单测，不碰 DOM）
     ============================================================ */

  /** 注入 rand 的 Fisher-Yates —— 返回新数组，不动入参 */
  function shuffle(arr, rand) {
    const a = arr.slice();
    const r = typeof rand === 'function' ? rand : Math.random;
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /**
   * 生成一个随机播放序列（0..n-1 的排列）。
   * last = 上一轮最后播过的索引；池子 >1 时把撞车的那一位换到第二位，
   * 避免"一轮刚放完又立刻放同一张"。
   */
  function makeOrder(n, rand, last) {
    const idx = [];
    for (let i = 0; i < n; i++) idx.push(i);
    const o = shuffle(idx, rand);
    if (n > 1 && last >= 0 && o[0] === last) { const t = o[0]; o[0] = o[1]; o[1] = t; }
    return o;
  }

  /** 旋转后的有效宽高（90/270 交换）；rot 会先归整到 0/90/180/270 */
  function oriented(w, h, rot) {
    const r = ((Math.round((rot || 0) / 90) * 90) % 360 + 360) % 360;
    return (r === 90 || r === 270) ? { w: h, h: w } : { w: w, h: h };
  }

  /**
   * 按图片比例把窗口装进可用区域：先占满宽，太高则改占满高。
   * 尺寸为 0 / 非法时给一个"四分之三屏"的稳妥默认。含最小尺寸兜底
   * （超宽全景图不会退化成一条线）。
   */
  function fitBox(availW, availH, iw, ih, minW, minH) {
    const mw = minW || MIN_W, mh = minH || MIN_H;
    if (!(iw > 0) || !(ih > 0)) {
      return { w: Math.max(mw, Math.round(availW * 0.72)), h: Math.max(mh, Math.round(availH * 0.62)) };
    }
    let w = availW, h = Math.round(w * ih / iw);
    if (h > availH) { h = availH; w = Math.round(h * iw / ih); }
    // 最小尺寸兜底：超宽全景 / 超长竖图不能退化成一条线
    if (h < mh) { h = mh; w = Math.round(h * iw / ih); }
    if (w < mw) { w = mw; h = Math.round(w * ih / iw); }
    // 但兜底不能把窗口顶出可用区域：1:20 的长图为了凑最小宽度会算出比屏幕还高的
    // 窗口。这时**宁可让窗口比例和图片不一致**（图片是 contain，最多两边留点黑边），
    // 也不能给出一个跑出屏幕的窗口 —— 那个用户根本没法用。
    w = Math.min(w, availW);
    h = Math.min(h, availH);
    return { w: Math.round(w), h: Math.round(h) };
  }

  /**
   * 在 area 内以 (cx,cy) 为中心摆放 w×h，并夹住四边不越界。
   * cx/cy 不是有效数字（窗口位置还没读回来）时用区域中心。返回 {x,y,w,h}。
   * 注意：必须显式判类型 —— `null >= 0` 在 JS 里是 true，光靠区间判断会漏。
   */
  function centerIn(area, w, h, cx, cy) {
    const ax = area.x, ay = area.y, aw = area.width, ah = area.height;
    const good = (v, lo, hi) => typeof v === 'number' && isFinite(v) && v >= lo && v <= hi;
    const mx = good(cx, ax, ax + aw) ? cx : ax + aw / 2;
    const my = good(cy, ay, ay + ah) ? cy : ay + ah / 2;
    let x = Math.round(mx - w / 2), y = Math.round(my - h / 2);
    x = Math.max(ax, Math.min(x, ax + aw - w));
    y = Math.max(ay, Math.min(y, ay + ah - h));
    return { x: x, y: y, w: w, h: h };
  }

  /** 相册池：'all' 全部 | 'fav' 只看收藏 | 其它视为来源 id */
  function pickPool(items, src, isFav) {
    const out = [];
    const list = items || [];
    for (const it of list) {
      if (!it || it.bad) continue;
      if (src === 'fav') {
        // 没有 isFav 判定函数时不能"当作全都收藏"——那是静默地把筛选吃掉
        if (!isFav || !isFav(it.id)) continue;
      } else if (src && src !== 'all') {
        if (it.sid !== src) continue;
      }
      out.push(it);
    }
    return out;
  }

  /**
   * 这个矩形贴着屏幕的哪一条边？都不贴返回 null。
   * 判据是"窗口边与工作区边的距离 ≤ thr"；同时贴近两条边时取更近的那条。
   * 注意 work area 而不是整块屏幕 —— 任务栏占掉的那部分不能算可用空间。
   */
  function snapEdge(area, rect, thr) {
    if (!area || !rect) return null;
    const t = (thr === undefined || thr === null) ? SNAP_THR : Math.max(0, thr);
    const dist = {
      left: Math.abs(rect.x - area.x),
      right: Math.abs((rect.x + rect.width) - (area.x + area.width)),
      top: Math.abs(rect.y - area.y),
      bottom: Math.abs((rect.y + rect.height) - (area.y + area.height)),
    };
    let best = null, bv = Infinity;
    for (const k of DOCK_EDGES) {
      if (dist[k] <= t && dist[k] < bv) { bv = dist[k]; best = k; }
    }
    return best;
  }

  /**
   * 把 w×h 的窗口贴到 area 的某一条边（margin 默认 0 = 严丝合缝）。
   * 另一条轴保持原来的中心（cx/cy 给不出有效值时退回区域中心）——
   * 这样换图改尺寸时窗口只在"自由轴"上伸缩，不会整块跳走。
   */
  function dockBox(area, w, h, edge, margin, cx, cy) {
    const m = Math.max(0, Number(margin) || 0);
    const ax = area.x, ay = area.y;
    const ar = ax + area.width, ab = ay + area.height;
    const good = (v, lo, hi) => typeof v === 'number' && isFinite(v) && v >= lo && v <= hi;
    let x, y;
    if (edge === 'left') x = ax + m;
    else if (edge === 'right') x = ar - w - m;
    else x = good(cx, ax, ar) ? Math.round(cx - w / 2) : Math.round(ax + (area.width - w) / 2);
    if (edge === 'top') y = ay + m;
    else if (edge === 'bottom') y = ab - h - m;
    else y = good(cy, ay, ab) ? Math.round(cy - h / 2) : Math.round(ay + (area.height - h) / 2);
    // 兜底：窗口比可用区还大时也不能算出负坐标
    x = Math.max(ax, Math.min(x, Math.max(ax, ar - w)));
    y = Math.max(ay, Math.min(y, Math.max(ay, ab - h)));
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  }

  /* ============================================================
     二、相框运行时
     ============================================================ */
  const Frame = {
    DEF_MS, FADE_MS, MIN_W, MIN_H, SNAP_THR,

    /* 纯函数一并挂出：单测与主窗口构造 payload 都会用到 */
    shuffle, makeOrder, oriented, fitBox, centerIn, pickPool, snapEdge, dockBox,

    /* ---------- 运行时状态 ---------- */
    on: false,          // 浮层是否在显示
    remote: false,      // 是否运行在独立的相框窗口里（能改窗口形状）
    ms: DEF_MS,
    fit: 'contain',
    src: 'all',         // 当前相册：'all' | 'fav' | 来源 id
    sources: [],        // [{id,name}] —— 相框窗口拿不到 State.sources，靠 payload 带过来
    dock: 'none',       // 吸附边：'none' | 'left' | 'right' | 'top' | 'bottom'
    _all: [],           // 全部候选条目；换相册时从这里重新过滤，不必再问主窗口
    items: [],          // 当前相册的播放池 [{ meta, p, id, sid, fav, n, w, h, r }]
    order: [],          // 随机序列（索引）
    pos: -1,
    playing: true,
    _tok: 0,            // 切图令牌：慢图加载回来时若已切走就丢弃
    _logo: null,        // 显示 3 秒的水印提示
    _badge: null,       // 第一轮永久水印（提醒怎么退出）

    /* ---------- 统计（探针 / 诊断用） ---------- */
    _stats: null,
    stats() { return this._stats ? Object.assign({}, this._stats) : null; },

    /* ============================================================
       入口（主窗口调用）
       ============================================================ */

    /**
     * 从「相框相册」设置里取池子 → 决定走原生相框窗口还是页内浮层。
     * 返回实际可播放的张数（0 表示没得放，调用方不用再提示）。
     */
    async start(overallOk) {
      const S = global.State;
      const set = (S && S.settings) || {};
      const sources = (S.sources || []).map((s) => ({ id: s.id, name: s.name }));
      const src = this._normSrc(set.frameSrc, S, sources);

      const pool = pickPool(S.items, src, (id) => S.isFav(id));
      if (!pool.length) {
        const why = src === 'fav' ? '收藏夹里还没有图片'
          : src === 'all' ? '图库里还没有图片' : '这个文件夹里还没有图片';
        if (global.App) global.App.toast('相框：' + why);
        return 0;
      }

      const ms = Math.max(1000, Number(set.frameMs) || DEF_MS);
      const fit = set.frameFit === 'cover' ? 'cover' : 'contain';
      const dock = DOCK_EDGES.indexOf(set.frameDock) >= 0 ? set.frameDock : 'none';

      // 桌面版：开一个真正无边框、置顶、按比例的原生窗口
      if (global.Native && global.Native.canFrameWin) {
        // 交给相框窗口的是**全部**条目（不是当前相册的池子）+ 来源清单：
        // 这样它自己就能换相册，不必为了换个相册再绕一趟 IPC。
        const items = [];
        for (const m of S.items) {
          if (!m || !m.path || m.bad) continue;
          items.push({
            p: m.path, n: m.name, w: m.w | 0, h: m.h | 0,
            r: S.rotationOf(m), sid: m.sid || '', id: m.id || m.path,
            fav: !!S.isFav(m.id),
          });
        }
        if (items.length) {
          const r = await global.Native.frameOpen({
            ms, fit, src, dock, sources, items,
            // 多显示器的「输出屏幕」。'auto' = 跟随主窗口所在屏；否则是具体的屏幕 id ——
            // 解析目标屏、以及"那块屏已被拔掉"的回落，都在主进程侧做（见 resolveFrameDisplay）。
            display: set.frameDisplay || 'auto',
          });
          if (r && r.ok) return pool.length;
          // 开窗失败（极少数受限环境）不报错，直接往下走页内浮层
        }
      }

      // 降级：开窗失败时退化为页内整屏浮层（随机轮播一样能跑）
      this.boot({ ms, fit, src, dock, sources, metas: S.items, inApp: true });
      return pool.length;
    },

    /**
     * 相册 id 兜底：'all' / 'fav' 原样；已不存在的来源 id 回落到 'all'。
     * 相框窗口里 `State.sources` 是空的，所以还要认 payload 带来的那份清单。
     */
    _normSrc(src, S, list) {
      const s = typeof src === 'string' && src ? src : 'all';
      if (s === 'all' || s === 'fav') return s;
      if (S && S.sourceById && S.sourceById(s)) return s;
      const L = list || this.sources || [];
      for (const x of L) if (x && x.id === s) return s;
      return 'all';
    },

    /* ============================================================
       相框窗口（index.html?frame=1）
       ============================================================ */

    /** 在独立相框窗口里启动：向主进程要 payload，然后与页内浮层共用同一套渲染 */
    async bootWindow() {
      document.body.dataset.frame = '1';
      let data = null;
      try { data = await global.Native.frameData(); } catch (e) { data = null; }
      if (!data || !data.items || !data.items.length) {
        // 没数据就自己退出，别留一个黑窗口
        this._toast('相框：没有可显示的图片');
        setTimeout(() => global.Native && global.Native.frameClose(), 900);
        return;
      }
      this.boot({
        ms: data.ms, fit: data.fit, dock: data.dock, sources: data.sources, src: data.src,
        display: data.display, workArea: data.workArea,
        records: data.items, inApp: false, remote: true,
      });
    },

    /* ============================================================
       渲染（页内浮层 / 相框窗口共用）
       ============================================================ */

    boot(opts) {
      const o = opts || {};
      if (this.on) this.close(true);
      this.remote = !!o.remote;
      this.ms = Math.max(1000, Number(o.ms) || DEF_MS);
      this.fit = o.fit === 'cover' ? 'cover' : 'contain';
      this.inApp = !!o.inApp;
      this.dock = DOCK_EDGES.indexOf(o.dock) >= 0 ? o.dock : 'none';
      this.display = typeof o.display === 'string' ? o.display : '';
      // 目标屏的可用区（主进程解析「输出屏幕」后给的）。
      // 为什么不能只用渲染进程自己的 `screen`：它反映的是"窗口此刻所在的那块屏"，
      // 而窗口刚开出来时可能还停在旧屏上 —— 拿它算图片比例与贴边会算到错误的区域。
      this.workArea = (o.workArea && o.workArea.width > 0) ? {
        x: o.workArea.x | 0, y: o.workArea.y | 0,
        width: o.workArea.width | 0, height: o.workArea.height | 0,
      } : null;
      this.sources = Array.isArray(o.sources) ? o.sources.slice() : [];

      // 归一化条目：有 meta 的（页内浮层）现算 blob URL；有路径的（相框窗口）拼 vf://。
      // 两种形态都带上 sid / fav，好让 pickPool 在这里本地换相册。
      const all = [];
      if (o.metas) {
        const S = global.State;
        for (const m of o.metas) {
          if (!m) continue;
          all.push({
            meta: m, id: m.id, sid: m.sid || '', fav: !!(S && S.isFav(m.id)), bad: !!m.bad,
            n: m.name, w: m.w | 0, h: m.h | 0, r: (S && S.rotationOf(m)) || 0,
          });
        }
      } else {
        for (const r of (o.records || [])) {
          all.push({
            p: r.p, id: r.id || r.p, sid: r.sid || '', fav: !!r.fav, bad: !!r.bad,
            n: r.n, w: r.w | 0, h: r.h | 0, r: r.r | 0,
          });
        }
      }
      this._all = all;
      this.src = this._normSrc(o.src, global.State);

      this._mount();
      this._painted = false;
      this._skipLeft = undefined;
      this._stats = { shown: 0, skipped: 0, fail: 0, orders: 0, resizes: 0, snaps: 0, srcSwitches: 0, startedAt: Date.now() };
      this.on = true;

      // 第一条序列：随机起点
      if (!this._applyPool()) {
        // 兜底：设置里的相册是空的（理论上 start() 已拦过）→ 退回全部
        this.src = 'all';
        this._applyPool();
      }
      this.playing = true;
      this._syncPlayBtn();
      this._syncSrcSel();
      this._step(1);

      if (this.remote) {
        this._bounds = null;
        // 先问一次当前窗口位置，之后按"保持中心（或保持贴边）"缩放，避免每换一张图窗口乱跳
        global.Native.frameInfo().then((info) => {
          if (info && info.bounds) this._bounds = { x: info.bounds.x, y: info.bounds.y, w: info.bounds.width, h: info.bounds.height };
        }).catch(() => {});
        // 拖动结束 → 主进程回传真实位置，据此决定"吸附到哪一条边"。
        // 只订阅一次：同一渲染进程里重复 boot() 不该叠加监听器。
        if (global.Native && global.Native.onFrameMoved && !this._movedBound) {
          this._movedBound = true;
          global.Native.onFrameMoved((b) => this._onWindowMoved(b));
        }
      }
      this._bindKeys();
      return this.items.length;
    },

    /**
     * 按当前相册过滤出播放池并重洗序列。池子为空返回 false（调用方据此回退）。
     * 过滤复用已单测的纯函数 pickPool —— 两种形态走的是同一份筛选逻辑。
     */
    _applyPool() {
      const fav = new Set();
      for (const it of this._all) if (it.fav) fav.add(it.id);
      const pool = pickPool(this._all, this.src, (id) => fav.has(id));
      if (!pool.length) { this.items = []; return false; }
      this.items = pool;
      this.order = makeOrder(pool.length, Math.random, -1);
      if (this._stats) this._stats.orders++;
      this.pos = -1;
      return true;
    },

    /**
     * 换相册（控制条上的下拉）。新相册为空时**保留原来那一组继续放**，
     * 只提示一句 —— 换个空相册就把屏幕变黑是最糟的结果。
     */
    setSource(next) {
      if (!this.on) return false;
      const s = this._normSrc(next, global.State);
      if (s === this.src) return true;
      const prev = this.src, prevItems = this.items, prevOrder = this.order, prevPos = this.pos;
      this.src = s;
      if (!this._applyPool()) {
        this.src = prev; this.items = prevItems; this.order = prevOrder; this.pos = prevPos;
        this._toast('相框：这个相册里还没有图片');
        this._syncSrcSel();
        return false;
      }
      if (this._stats) this._stats.srcSwitches++;
      // 记住选择：下次进相框还从这个相册取图
      if (global.State && global.State.setSetting) global.State.setSetting('frameSrc', s);
      this._syncSrcSel();
      this._clearTimer();
      this._step(1);
      return true;
    },

    /** 建 DOM + 绑定交互 */
    _mount() {
      const el = document.createElement('div');
      el.className = 'fr-layer' + (this.remote ? ' fr-native' : '');
      el.id = 'frLayer';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-label', '相框模式');
      el.innerHTML =
        '<img class="fr-img fr-a" alt="" draggable="false">' +
        '<img class="fr-img fr-b" alt="" draggable="false">' +
        '<div class="fr-tip"><b>相框模式</b><span>单击下一张 · 鼠标移到下缘出控制条 · Esc 退出</span></div>' +
        // 控制条只在指针进入下缘感应区时出现；底部留一根细抓手做"这里能出控制条"的提示。
        // 控制条是感应区的**子元素** —— 这样从图片移到按钮上不会触发感应区 leave，
        // 否则会出现"控制条刚出来、鼠标移过去它却自己收起来"的死循环。
        '<div class="fr-hot">' +
        '<div class="fr-grip" aria-hidden="true"></div>' +
        '<div class="fr-bar" role="toolbar" aria-label="相框控制">' +
        '<label class="fr-srcwrap" title="相框从哪个相册取图">' +
        '<span class="fr-srclab">相册</span>' +
        '<select class="fr-src" aria-label="相框相册"></select>' +
        '</label>' +
        '<button type="button" class="fr-btn" data-act="prev" title="上一张（←）" aria-label="上一张">' + icon('i-left') + '</button>' +
        '<button type="button" class="fr-btn fr-play" data-act="play" title="暂停 / 继续（空格）" aria-label="暂停或继续">' + icon('i-pause') + '</button>' +
        '<button type="button" class="fr-btn" data-act="next" title="下一张（→）" aria-label="下一张">' + icon('i-right') + '</button>' +
        '<span class="fr-meta"></span>' +
        '<button type="button" class="fr-btn" data-act="reshuffle" title="重新洗牌（R）" aria-label="重新洗牌">' + icon('i-shuffle') + '</button>' +
        '<button type="button" class="fr-btn" data-act="full" title="全屏切换" aria-label="全屏切换">' + icon('i-expand') + '</button>' +
        '<button type="button" class="fr-btn fr-pin" data-act="pin" title="窗口置顶" aria-label="窗口置顶" aria-pressed="false" hidden>' + icon('i-pin') + '</button>' +
        '<button type="button" class="fr-btn fr-close" data-act="close" title="退出相框（Esc）" aria-label="退出相框">' + icon('i-x') + '</button>' +
        '</div>' +
        '</div>';
      document.body.appendChild(el);

      this.el = el;
      this.a = el.querySelector('.fr-a');
      this.b = el.querySelector('.fr-b');
      this.cur = null;              // 当前在前台的 <img>
      this.hot = el.querySelector('.fr-hot');
      this.bar = el.querySelector('.fr-bar');
      this.srcSel = el.querySelector('.fr-src');
      this.metaEl = el.querySelector('.fr-meta');
      this.tipEl = el.querySelector('.fr-tip');
      this.playBtn = el.querySelector('.fr-play');
      this.pinBtn = el.querySelector('.fr-pin');
      this.fullBtn = el.querySelector('[data-act="full"]');
      this._barShown = false;       // 控制条当前是否露出（由感应区驱动，见 _showBar/_hideBar）
      this._srcSig = null;          // 相册下拉的选项签名（变了才重建 DOM）

      el.style.setProperty('--fr-fade', FADE_MS + 'ms');
      this.a.style.objectFit = this.fit;
      this.b.style.objectFit = this.fit;

      // 控制条 / 全屏 / 置顶的可见性
      if (this.remote) this.fullBtn.hidden = true;             // 相框窗口本来就没边框，不需要全屏
      else if (!document.fullscreenEnabled) this.fullBtn.hidden = true;
      const canPin = !!(global.Native && global.Native.canPin);
      if (!canPin) this.pinBtn.hidden = true;
      else {
        this.pinBtn.hidden = false;
        global.Native.getAlwaysOnTop().then((on) => this._syncPin(on)).catch(() => {});
      }

      // 换相册（控制条上的下拉）
      this.srcSel.addEventListener('change', () => { this.setSource(this.srcSel.value); });

      // 点击：控制条内走按钮，空白处=下一张
      el.addEventListener('click', (e) => {
        const b = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
        if (b) { e.stopPropagation(); this.act(b.dataset.act); return; }
        // 刚拖过窗口 → 这一下不算单击（否则拖完松手会顺手翻一张）
        if (this._justDragged && Date.now() - this._justDragged < 400) return;
        if (e.target === this.el || e.target === this.a || e.target === this.b) this.next();
      });
      // 双击 = 退出（相框最常见的"关掉它"直觉）
      el.addEventListener('dblclick', () => this.close());
      // 控制条显隐：由下缘感应区驱动（不再是"鼠标一动就冒出来、静置几秒才收"）
      this._bindHot(el);
      this._bindFocusBar(el);
      this._bindDrag(el);       // 桌面版：按住图片拖动整个窗口（不影响单击/双击）

      // 焦点陷阱只装在页内浮层上：它盖住整个页面，Tab 逃到背后会让人当场迷路。
      // 桌面版相框是**独立窗口**，窗口里除了这条控制条没别的可聚焦物，圈不圈一个样。
      // skipInitial 是刻意的 —— 相框多由鼠标开着，一开就抢焦点会让控制条"自己冒出来"，
      // 正好违背"只在鼠标移到下缘才显示"的设计。
      if (!this.remote && A11y && A11y.trap) {
        this._releaseTrap = A11y.trap(el, { skipInitial: true });
      }

      if (!this.remote) document.documentElement.classList.add('fr-lock');
    },

    /* ---------- 键盘可达：焦点落进相框就把控制条亮出来 ---------- */
    /**
     * 控制条原本纯由指针驱动（pointerenter / pointerleave），而它藏着时是
     * visibility:hidden —— 键盘用户 Tab 一辈子够不到那条「相册」下拉，
     * 等于这个功能对键盘不存在。焦点一进来就亮，离开且没落到条内才收。
     */
    _bindFocusBar(el) {
      this._onFocusIn = () => this._showBar();
      this._onFocusOut = (e) => {
        // __不能__在焦点仍落在控制条内部时收起：visibility:hidden 会让正在聚焦的
        // 元素变成不可聚焦，焦点当场掉到 body，用户丢掉位置。
        const to = e.relatedTarget;
        if (to && this.hot && this.hot.contains(to)) return;
        this._hideBar();
      };
      el.addEventListener('focusin', this._onFocusIn);
      el.addEventListener('focusout', this._onFocusOut);
    },
    _unbindFocusBar() {
      const el = this.el;
      if (el && this._onFocusIn) el.removeEventListener('focusin', this._onFocusIn);
      if (el && this._onFocusOut) el.removeEventListener('focusout', this._onFocusOut);
      this._onFocusIn = this._onFocusOut = null;
    },

    /* ---------- 控制条显隐：完全由下缘感应区驱动 ---------- */
    /**
     * 指针进入下缘感应区 → 露出控制条；离开 → **立刻**收起（没有延时）。
     * 之所以不用"鼠标一动就显示 + 定时隐藏"，是因为控制条压在图片下缘会挡视线，
     * 而定时模型下它总会有几秒钟挂在那里。
     */
    _bindHot(el) {
      if (!this.hot) return;
      this._onHotIn = () => this._showBar();
      this._onHotOut = () => this._hideBar();
      this.hot.addEventListener('pointerenter', this._onHotIn);
      this.hot.addEventListener('pointerleave', this._onHotOut);
      // 触摸设备没有 hover：点下缘也能把控制条叫出来（但不换图，因为点击目标是感应区）
      this._onHotDown = () => this._showBar();
      this.hot.addEventListener('pointerdown', this._onHotDown, { passive: true });
      // 指针离开整个相框（例如移到了别的窗口）也要收起
      this._onLayerOut = () => this._hideBar();
      el.addEventListener('pointerleave', this._onLayerOut);
    },

    /** 拆掉感应区监听（close 时调用，避免同一实例二次 boot 叠加监听器） */
    _unbindHot() {
      const el = this.el, hot = this.hot;
      if (hot) {
        if (this._onHotIn) hot.removeEventListener('pointerenter', this._onHotIn);
        if (this._onHotOut) hot.removeEventListener('pointerleave', this._onHotOut);
        if (this._onHotDown) hot.removeEventListener('pointerdown', this._onHotDown);
      }
      if (el && this._onLayerOut) el.removeEventListener('pointerleave', this._onLayerOut);
      this._onHotIn = this._onHotOut = this._onHotDown = this._onLayerOut = null;
      this.hot = null;
      this._barShown = false;
    },

    _showBar() {
      if (!this.el || this._barShown) return;
      this._barShown = true;
      this.el.classList.add('fr-bar-on');
      if (this.hot) this.hot.setAttribute('data-open', '1');
    },
    _hideBar() {
      if (!this.el || !this._barShown) return;
      this._barShown = false;
      this.el.classList.remove('fr-bar-on');
      if (this.hot) this.hot.removeAttribute('data-open');
    },

    /* ---------- 鼠标拖动窗口（桌面版相框） ----------
       为什么不直接把图片设成 CSS `-webkit-app-region: drag` 的拖拽区：
       拖拽区**由系统接管、网页侧收不到任何鼠标事件**，而图片上必须保留
       "单击换下一张 / 双击退出" —— 一行 CSS 会让这两件事一起消失。
       所以自己算：按下记起点，位移超过阈值才判定为拖动（单击因此完全不受影响），
       拖动中逐帧把新坐标交给主进程搬窗口。
       窗口左上角的屏幕坐标 = 指针屏幕坐标 - 指针在客户区内的坐标。无边框窗口的
       客户区左上角**就是**窗口左上角，所以这个换算精确，且不依赖 this._bounds
       （那是异步读回来的，第一张图之前还是空的）。 */
    _bindDrag(el) {
      if (!this.remote) return;                 // 页内浮层没有"窗口"可以移
      const THR = 4;                            // 位移超过这么多像素才判定为拖动
      this._dragging = false;
      this._dragArmed = false;
      let sx = 0, sy = 0, wx = 0, wy = 0, pend = null, raf = 0;

      this._onDragDown = (e) => {
        if (e.button !== 0) return;               // 只认左键
        if (e.target && e.target.closest && e.target.closest('.fr-hot')) return;  // 控制条不参与
        sx = e.screenX; sy = e.screenY;
        wx = Math.round(e.screenX - e.clientX);
        wy = Math.round(e.screenY - e.clientY);
        pend = null;
        this._dragging = false;
        this._dragArmed = true;
      };
      this._onDragMove = (e) => {
        if (!this._dragArmed) return;
        const dx = e.screenX - sx, dy = e.screenY - sy;
        if (!this._dragging) {
          if (Math.abs(dx) < THR && Math.abs(dy) < THR) return;   // 还没到阈值 → 仍是单击
          this._dragging = true;
          el.classList.add('fr-dragging');
          this._hideBar();                        // 拖动时别让控制条冒出来挡视线
        }
        pend = { x: wx + dx, y: wy + dy };
        // 逐帧节流：pointermove 比屏幕刷新密得多，每帧搬一次窗口就够
        if (!raf) {
          raf = requestAnimationFrame(() => {
            raf = 0;
            if (pend) this._moveTo(pend.x, pend.y);
          });
        }
      };
      this._onDragUp = () => {
        this._dragArmed = false;
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        if (!this._dragging) return;
        this._dragging = false;
        // 记下"刚刚是拖动" → 点击处理器据此跳过换图，否则一松手会顺手翻一张
        this._justDragged = Date.now();
        el.classList.remove('fr-dragging');
        if (pend) {
          this._moveTo(pend.x, pend.y);
          const b = this._bounds;
          this._bounds = { x: pend.x, y: pend.y, w: b ? b.w : 0, h: b ? b.h : 0 };
        }
      };
      el.addEventListener('pointerdown', this._onDragDown);
      el.addEventListener('pointermove', this._onDragMove);
      el.addEventListener('pointerup', this._onDragUp);
      el.addEventListener('pointercancel', this._onDragUp);
    },
    _unbindDrag() {
      const el = this.el;
      if (el) {
        if (this._onDragDown) el.removeEventListener('pointerdown', this._onDragDown);
        if (this._onDragMove) el.removeEventListener('pointermove', this._onDragMove);
        if (this._onDragUp) {
          el.removeEventListener('pointerup', this._onDragUp);
          el.removeEventListener('pointercancel', this._onDragUp);
        }
      }
      this._onDragDown = this._onDragMove = this._onDragUp = null;
      this._dragArmed = false;
      this._dragging = false;
    },

    /** 请主进程把相框窗口搬到屏幕绝对坐标 (x, y) */
    _moveTo(x, y) {
      if (!global.Native || !global.Native.frameMove) return;
      global.Native.frameMove({ x: Math.round(x), y: Math.round(y) });
    },

    /**
     * 相册下拉：选项来自 payload 带来的 sources ——
     * 相框窗口是另一个渲染进程，它自己的 `State.sources` 是空的，不能就地读。
     */
    _syncSrcSel() {
      const sel = this.srcSel;
      if (!sel) return;
      const out = [['all', '全部图片'], ['fav', '只看收藏']];
      for (const s of (this.sources || [])) if (s && s.id) out.push([s.id, s.name || s.id]);
      // 选项会随相册增删变化：内容变了才重建，免得打断用户正在操作的下拉
      const sig = out.map((o) => o[0] + '\u0000' + o[1]).join('\u0001');
      if (sig !== this._srcSig) {
        this._srcSig = sig;
        sel.textContent = '';
        for (const o of out) {
          const op = document.createElement('option');
          op.value = o[0];
          op.textContent = o[1];
          sel.appendChild(op);
        }
      }
      sel.value = this.src;
      // 只有「全部图片」一项时这个下拉没有意义 → 整块隐藏
      const noChoice = out.length <= 1;
      sel.hidden = noChoice;
      if (sel.parentElement) sel.parentElement.hidden = noChoice;
    },

    /* ---------- 播放推进 ---------- */

    /** 从头/尾越界时重洗；返回下一个索引 */
    _advance(dir) {
      const n = this.items.length;
      if (!n) return -1;
      if (n === 1) return 0;
      let p = this.pos + dir;
      if (p >= this.order.length || p < 0) {
        const last = this.pos >= 0 ? this.order[this.pos] : -1;
        this.order = makeOrder(n, Math.random, last);
        if (this._stats) this._stats.orders++;
        p = dir > 0 ? 0 : this.order.length - 1;
      }
      return p;
    },

    next() { this._step(1); },
    prev() { this._step(-1); },

    /** 切到序列中的下一张（dir=+1/-1） */
    _step(dir) {
      if (!this.on || !this.items.length) return;
      const p = this._advance(dir);
      if (p < 0) return;
      this.pos = p;
      const it = this.items[this.order[p]];
      this._show(it);
    },

    /** 洗牌重来（R / 按钮）：换一个随机序列，立刻出图 */
    reshuffle() {
      if (!this.on || !this.items.length) return;
      const last = this.pos >= 0 ? this.order[this.pos] : -1;
      this.order = makeOrder(this.items.length, Math.random, last);
      if (this._stats) this._stats.orders++;
      this.pos = -1;
      this._step(1);
    },

    /** 显示一张：懒取 URL → 预解码 → 交叉淡入 → 按比例调窗 → 排下一张 */
    async _show(it) {
      const url = this._urlOf(it);
      if (!url) { this._skip(it); return; }
      const tok = ++this._tok;
      const front = this.cur === this.a ? this.b : this.a;   // 换到另一层，形成交叉淡入
      const back = this.cur;

      const ok = await this._loadInto(front, url);
      if (tok !== this._tok || !this.on) return;             // 期间已切走 → 丢弃这次结果
      if (!ok) { this._skip(it); return; }

      front.style.transform = it.r ? 'rotate(' + it.r + 'deg)' : '';
      front.classList.add('fr-on');
      if (back) back.classList.remove('fr-on');
      this.cur = front;
      this._url = url;
      this._skipLeft = undefined;            // 出图成功 → 连续坏图计数归零
      if (this._stats) this._stats.shown++;

      const o = oriented(front.naturalWidth, front.naturalHeight, it.r);
      it.nw = o.w; it.nh = o.h;
      this._fitWindow(o.w, o.h);
      this._meta(it);
      // 第一张真的画出来了 → 主进程这时才把主窗口藏起来（避免"黑一下"再出图）
      if (this.remote && !this._painted) {
        this._painted = true;
        if (global.Native && global.Native.framePainted) {
          global.Native.framePainted({ nw: o.w, nh: o.h, name: it.n || '' });
        }
      }
      if (this.tipEl) this.tipEl.classList.add('fr-tip-off');
      this._preloadNext();
      this._schedule();
    },

    /** 取一张图的 URL：页内浮层现算 blob/vf，相框窗口现拼 vf:// */
    _urlOf(it) {
      if (it.meta && global.Thumbs) return global.Thumbs.bigURL(it.meta);
      if (it.p && global.Native) return global.Native.url({ path: it.p });
      return it.u || null;
    },

    /** 把 url 装进 <img>，返回是否成功（含超时，坏图不能把相框卡死） */
    _loadInto(img, url) {
      return new Promise((resolve) => {
        let done = false;
        const fin = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
        const t = setTimeout(() => fin(false), 20000);
        img.onload = () => fin(true);
        img.onerror = () => fin(false);
        img.src = url;
      });
    },

    /** 坏图：记一笔，跳到下一张（不递归太深，交给定时器换栈） */
    _skip(it) {
      if (this._stats) this._stats.fail++;
      if (this._skipLeft === undefined) this._skipLeft = this.items.length;
      if (this._skipLeft-- <= 0) { this._skipLeft = undefined; this._toast('相框：这些图片都打不开'); return; }
      setTimeout(() => { if (this.on) this._step(1); }, 120);
    },

    /** 下一张在空闲时预解码，切换瞬间才不会黑屏 */
    _preloadNext() {
      if (this.items.length < 2) return;
      let p = this.pos + 1;
      if (p >= this.order.length) p = 0;
      const it = this.items[this.order[p]];
      if (!it) return;
      const url = this._urlOf(it);
      if (!url || url === this._url) return;
      const im = new Image();
      im.decoding = 'async';
      im.src = url;
    },

    /* ---------- 定时 ---------- */
    _schedule() {
      this._clearTimer();
      if (!this.playing || this.items.length < 2) return;
      this._t = setTimeout(() => { if (this.on) this._step(1); }, this.ms);
    },
    _clearTimer() { if (this._t) { clearTimeout(this._t); this._t = 0; } },

    play() { if (this.playing) return; this.playing = true; this._syncPlayBtn(); this._schedule(); },
    pause() { if (!this.playing) return; this.playing = false; this._clearTimer(); this._syncPlayBtn(); },
    togglePlay() { this.playing ? this.pause() : this.play(); },
    _syncPlayBtn() {
      if (!this.playBtn) return;
      this.playBtn.innerHTML = icon(this.playing ? 'i-pause' : 'i-play');
      this.playBtn.classList.toggle('is-on', !this.playing);
      this.playBtn.setAttribute('aria-pressed', String(!this.playing));
    },

    /* ---------- 窗口按图片比例 + 贴到屏幕边 ---------- */

    /**
     * 相框该按哪一块屏的可用区来算（任务栏占掉的那块不算）。
     * 优先用主进程给的**目标屏** —— 多显示器下「输出屏幕」可能就是另一块屏；
     * 没有 payload（页内浮层）或窗口已被拖到别的屏时，回落到渲染进程的 `screen`，
     * 那个值反映的是"窗口此刻所在的那块屏"。
     */
    _area() {
      if (this.workArea && this.workArea.width > 0) return this.workArea;
      const sc = global.screen || {};
      return {
        x: Number(sc.availLeft) || 0,
        y: Number(sc.availTop) || 0,
        width: Number(sc.availWidth) || Number(global.innerWidth) || 1200,
        height: Number(sc.availHeight) || Number(global.innerHeight) || 800,
      };
    },

    /**
     * 窗口被拖到另一块屏幕之后，把 workArea 换成那块屏的 —— 否则下一张图
     * `_fitWindow` 仍按**原来那块屏**摆窗口，会把用户刚拖过去的窗口又弹回来。
     */
    _syncAreaToScreen() {
      const sc = global.screen;
      if (!sc || typeof sc.availWidth !== 'number' || !sc.availWidth) return;
      const wa = {
        x: Number(sc.availLeft) || 0, y: Number(sc.availTop) || 0,
        width: sc.availWidth, height: sc.availHeight,
      };
      const cur = this.workArea;
      if (!cur || cur.x !== wa.x || cur.y !== wa.y || cur.width !== wa.width || cur.height !== wa.height) {
        this.workArea = wa;
      }
    },

    /** 只有相框窗口能改自己的形状；页内浮层下是空操作 */
    _fitWindow(nw, nh) {
      if (!this.remote || !global.Native || !global.Native.canFrameWin) return;
      if (!(nw > 0) || !(nh > 0)) return;
      const area = this._area();
      const box = fitBox(Math.round(area.width * AREA_FILL), Math.round(area.height * AREA_FILL), nw, nh);
      const b = this._bounds;
      // cx/cy 给不出有效值（窗口位置还没读回来）时，两个函数都会退回区域中心
      const cx = b ? b.x + b.w / 2 : NaN, cy = b ? b.y + b.h / 2 : NaN;
      // 贴了边就继续贴边：换图只在"自由轴"上伸缩，贴住的那条边不动
      const r = (this.dock && this.dock !== 'none')
        ? dockBox(area, box.w, box.h, this.dock, 0, cx, cy)
        : centerIn(area, box.w, box.h, cx, cy);
      this._applyBox(r, nw / nh);
    },

    /** 请求主进程把窗口摆到 r；尺寸位置都没变就不惊动系统 */
    _applyBox(r, ratio) {
      const b = this._bounds;
      if (b && b.w === r.w && b.h === r.h && b.x === r.x && b.y === r.y) return;
      this._bounds = r;
      if (this._stats) this._stats.resizes++;
      global.Native.frameFit({ x: r.x, y: r.y, w: r.w, h: r.h, ratio: ratio }).then((applied) => {
        if (applied && applied.width) this._bounds = { x: applied.x, y: applied.y, w: applied.width, h: applied.height };
      }).catch(() => {});
    },

    /**
     * 拖动结束 → 主进程回传窗口的真实位置（拖拽是系统行为，渲染进程拿不到中间过程）。
     * 贴近屏幕某条边就吸附过去并记住；已经贴着边却被拖走了，就取消贴边。
     */
    _onWindowMoved(b) {
      if (!this.on || !this.remote || !b) return;
      const cur = { x: b.x | 0, y: b.y | 0, width: b.width | 0, height: b.height | 0 };
      this._bounds = { x: cur.x, y: cur.y, w: cur.width, h: cur.height };
      // 可能被拖到了另一块屏 → 之后的按比例适配与贴边都要改按那块屏算
      this._syncAreaToScreen();
      // **拖动进行中不吸附**：主进程的 `move` 抖动合并是 200ms，用户拖到一半停手超过
      // 这个时间就会提前来一次落位判定 —— 那时吸附会把窗口从用户手底下搬走，
      // 接着继续拖就会"跳"一下。松手后 200ms 那次才是真落位，照常吸附。
      if (this._dragging) return;
      const edge = snapEdge(this._area(), cur, SNAP_THR);
      if (edge) { this._setDock(edge); return; }
      if (this.dock && this.dock !== 'none') this._setDock('none');
    },

    /** 设定并持久化"贴哪条边"；设为某边时立刻贴到位（不改变窗口大小） */
    _setDock(edge) {
      const e = DOCK_EDGES.indexOf(edge) >= 0 ? edge : 'none';
      const changed = this.dock !== e;
      this.dock = e;
      if (global.State && global.State.setSetting) global.State.setSetting('frameDock', e);
      if (!changed || e === 'none') return;
      const b = this._bounds;
      if (!b) return;
      const area = this._area();
      this._applyBox(dockBox(area, b.w, b.h, e, 0, b.x + b.w / 2, b.y + b.h / 2), b.w / b.h);
    },

    /* 控制条的显示 / 隐藏见上面的 _showBar / _hideBar —— 由下缘感应区驱动，无定时器 */

    act(name) {
      switch (name) {
        case 'prev': this.prev(); break;
        case 'next': this.next(); break;
        case 'play': this.togglePlay(); break;
        case 'reshuffle': this.reshuffle(); break;
        case 'full': this._toggleFull(); break;
        case 'pin': this._togglePin(); break;
        case 'close': this.close(); break;
      }
    },

    _toggleFull() {
      const d = document;
      if (d.fullscreenElement === this.el) { d.exitFullscreen().catch(() => {}); return; }
      if (this.el.requestFullscreen) this.el.requestFullscreen().catch(() => {});
    },

    _togglePin() {
      // 页内浮层里没有"相框自己的窗口"，📌就等价于顶栏那颗（走 App 才能同步设置与图标）
      if (!this.remote) {
        if (global.App && global.App.togglePin) global.App.togglePin();
        return;
      }
      if (!global.Native || !global.Native.canPin) return;
      const next = !this._pinned;
      global.Native.setAlwaysOnTop(next).then((real) => this._syncPin(real)).catch(() => {});
    },
    _syncPin(on) {
      this._pinned = !!on;
      if (!this.pinBtn) return;
      this.pinBtn.setAttribute('aria-pressed', String(this._pinned));
      this.pinBtn.classList.toggle('is-on', this._pinned);
      this.pinBtn.innerHTML = icon(this._pinned ? 'i-pin-on' : 'i-pin');
    },

    /* ---------- 键盘 ---------- */
    _bindKeys() {
      if (this._keyFn) return;
      this._keyFn = (e) => {
        if (!this.on) return;
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); return; }
        if (e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); e.stopPropagation(); this.togglePlay(); return; }
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); this.next(); }
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); this.prev(); }
        else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); e.stopPropagation(); this.reshuffle(); }
      };
      document.addEventListener('keydown', this._keyFn, true); // 捕获：压过灯箱/图库的按键
    },
    _unbindKeys() {
      if (!this._keyFn) return;
      document.removeEventListener('keydown', this._keyFn, true);
      this._keyFn = null;
    },

    /* ---------- 元信息与提示 ---------- */
    _meta(it) {
      if (!this.metaEl) return;
      const i = this.pos + 1, n = this.order.length;
      const px = it.nw && it.nh ? ' · ' + it.nw + '×' + it.nh : '';
      this.metaEl.textContent = i + ' / ' + n + ' · ' + (it.n || '') + px;
    },
    _toast(msg) {
      if (global.App && global.App.toast) global.App.toast(msg);
      else this._hint(msg);
    },
    _hint(msg) {
      if (!this.el) return;
      // 相框窗口里 App.toast 可能没接上（独立窗口只有相框这一层）→ 这条视觉提示
      // 得自己播报一声，否则"这个相册里还没有图片"对读屏是静默的
      if (A11y && A11y.live) A11y.live(msg);
      let d = this.el.querySelector('.fr-toast');
      if (!d) { d = document.createElement('div'); d.className = 'fr-toast'; this.el.appendChild(d); }
      d.textContent = msg;
      d.classList.add('fr-toast-on');
      setTimeout(() => d.classList.remove('fr-toast-on'), 2600);
    },

    /* ---------- 退出 ---------- */
    /**
     * 退出相框。
     * silent=true 只拆自己的 DOM（切换相册复用），不通知主进程。
     */
    close(silent) {
      if (!this.on && !this.el) return;
      this.on = false;
      this._clearTimer();
      this._unbindFocusBar();   // 必须在 _unbindHot 之前：它要用 this.hot 判断焦点去向
      this._unbindHot();
      this._unbindDrag();
      this._unbindKeys();
      // 解焦点陷阱：拦截器挂在 document 上，漏解会让整个页面的 Tab 一直被圈住
      if (this._releaseTrap) { this._releaseTrap(); this._releaseTrap = null; }
      if (this.el && this.el.parentElement) this.el.parentElement.removeChild(this.el);
      this.el = null; this.a = null; this.b = null; this.cur = null;
      this.bar = null; this.srcSel = null; this.metaEl = null; this.tipEl = null;
      this.playBtn = null; this.pinBtn = null; this.fullBtn = null;
      document.documentElement.classList.remove('fr-lock');
      if (this.remote && !silent && global.Native) {
        global.Native.frameClose();
        return;
      }
      if (!this.remote && !silent) {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        // 页内浮层是自己关的，主窗口那侧没人通知 → 得把顶栏按钮的状态复位，
        // 否则 Esc 退出后按钮还亮着"正在播放"
        const A = global.App;
        if (A) { A.frameOn = false; if (A.applyFrameUI) A.applyFrameUI(); }
      }
    },

    /** 主进程通知"相框窗口已关"时清理（主窗口侧通常什么都不用做） */
    onWindowClosed() { if (this.on) this.close(true); },
  };

  /* 局部图标工具（frame.js 可能先于 util.js 之外的东西被调用，这里自己兜一层） */
  function icon(id) {
    return '<svg aria-hidden="true"><use href="#' + id + '"/></svg>';
  }

  global.Frame = Frame;
})(window);
