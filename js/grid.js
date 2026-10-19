/* ============================================================
   Atrium · grid.js
   图库网格：四种模式 + 瓦片窗口化（>800 张）
   - small / medium：行内自适应（justified rows）—— 每行等高，
     按每张图片的真实宽高比缩放、恰好填满整行；不裁剪不变形。
     图片比例在缩略图解码后获知，行布局随之重排（滚动锚定不跳）。
   - masonry（v1.12.0）：瀑布流（不等高列）—— 等宽列、按比例定高、
     每张塞进当前最矮的列，排布算法在 js/masonry.js（纯函数、有单测）。
   - single：单列整屏（一屏一张，滚动逐屏吸附）。

   ⚠️ 窗口化 / 重排锚点 / 框选命中三处都靠"坐标单调"做二分，而瀑布流的
   底边（y+h）**不单调**。本文件里凡遇到 y+h 处都有 masonry 分支改用
   单调数组 yMax，改动点均带注释说明；不变量由 test/masonry.test.js 锁住。
   ============================================================ */
(function (global) {
  'use strict';

  const Util = global.Util;
  const PRUNE_AT = 800;     // 超过该数量启用窗口化剪裁
  const SINGLE_PRUNE_AT = 12; // 单列整屏阈值更低：一屏只有一张，避免中量目录一次性解码全部原图
  const GAP = 12;           // 网格间距
  const CELL_GAP = 4;       // 紧凑网格（small）的行列间距：密排视图，缝要细
  const GAP_SINGLE = 46;    // 单列行距
  const SINGLE_MAXW = 1360; // 单列内容最大宽
  const BOTTOM_PAD = 90;    // 底部留白

  const Grid = {
    items: [],
    mode: State.settings.mode,
    stage: null, inner: null, wrap: null,

    width: 0, gap: GAP, leftOff: 0,
    totalH: 0, N: 0, prune: false, vi0: 0, vi1: 0,

    els: new Map(),        // idx -> element
    positions: [],         // idx -> {x,y,w,h}
    needCreate: [],
    rafId: 0,
    ro: null,
    onOpen: null,
    onDelete: null,
    onSelect: null,        // 选中集合变化 → (count, selected[])
    onFavRemoved: null,    // 「只看收藏」下取消收藏 → 通知 App 重算分页视图
    sel: new Set(),        // 框选/勾选选中的条目（meta 引用）
    _token: 0,             // 数据换代记号：异步加载回调据此失效
    _ratioTimer: 0,        // 比例就绪后的重排防抖句柄
    _dragMoved: false,     // 刚刚发生过框选拖拽（用于吞掉随后的 click）
    _marquee: null,        // 选框元素（挂在 inner 内，随内容坐标定位）
    _box: null,            // dragSelect 的 dispose

    /* ---------- 装配 ---------- */
    mount(stage, cb) {
      this.stage = stage;                 // #stage（测量宽度）
      this.inner = stage.firstElementChild;
      this.wrap = stage.parentElement;
      this.onOpen = cb.onOpen || null;
      this.onDelete = cb.onDelete || null;
      this.onSelect = cb.onSelect || null;
      this.onFavRemoved = cb.onFavRemoved || null;   // 「只看收藏」下取消收藏 → 请 App 重算列表

      stage.addEventListener('click', (e) => {
        if (this._dragMoved) { this._dragMoved = false; return; } // 刚框选完：不要顺手打开灯箱
        const tile = e.target.closest('.tile');
        if (!tile || !tile._item) return;
        const meta = tile._item;
        if (e.target.closest('.tile-chk')) return;             // 勾选圈自行处理
        if (e.target.closest('.tile-fav')) return;             // 收藏星标自行处理
        // Ctrl/⌘/Shift + 点击 = 切换选中（不打开大图）
        if (e.ctrlKey || e.metaKey || e.shiftKey) {
          e.preventDefault();
          this.toggle(meta);
          return;
        }
        if (this.onOpen) this.onOpen(meta, this.items);
      });
      stage.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        if (e.target.closest && e.target.closest('.tile-del')) return; // 删除按钮不触发打开
        const tile = e.target.closest('.tile');
        if (tile && tile._item) { e.preventDefault(); if (this.onOpen) this.onOpen(tile._item, this.items); }
      });

      this._wireMarquee();

      // 收藏变化（无论在网格还是灯箱里触发）→ 同步星标（只订阅一次）
      if (!this._favHooked) {
        this._favHooked = true;
        State.bus.on('favorite-changed', (ev) => this._onFavChanged(ev));
      }

      global.addEventListener('scroll', this._onScroll = Util.rafThrottle(() => this.sync()), { passive: true });

      if (Util.can.ResizeObserver) {
        this.ro = new ResizeObserver(Util.debounce(() => this.layout(false), 140));
        this.ro.observe(this.wrap);
      } else {
        global.addEventListener('resize', Util.debounce(() => this.layout(false), 180));
      }
    },

    /* ---------- 选择（框选 / 勾选） ---------- */
    /** 当前选中条目（按展示顺序） */
    selected() {
      const out = [];
      for (const it of this.items) if (this.sel.has(it)) out.push(it);
      return out;
    },

    selectedCount() { return this.sel.size; },

    isSel(meta) { return !!(meta && this.sel.has(meta)); },

    /** 切换单张；force 可强制 true/false。会同步 DOM 与回调 */
    toggle(meta, force) {
      if (!meta) return;
      const on = force === undefined ? !this.sel.has(meta) : !!force;
      if (on) this.sel.add(meta); else this.sel.delete(meta);
      this._paintOne(meta);
      this._emitSel();
    },

    /** 全选 / 取消全选（作用于当前页展示的全部条目） */
    selectAll(on) {
      this.sel.clear();
      if (on !== false) for (const it of this.items) this.sel.add(it);
      this._paintAll();
      this._emitSel();
    },

    invert() {
      const next = new Set();
      for (const it of this.items) if (!this.sel.has(it)) next.add(it);
      this.sel = next;
      this._paintAll();
      this._emitSel();
    },

    clearSel() {
      if (!this.sel.size) return;
      this.sel.clear();
      this._paintAll();
      this._emitSel();
    },

    /** 数据换代/删除后：剔除已不在列表里的选中项 */
    pruneSel() {
      let dirty = false;
      const live = new Set(this.items);
      for (const m of Array.from(this.sel)) if (!live.has(m)) { this.sel.delete(m); dirty = true; }
      if (dirty) this._emitSel();
      return dirty;
    },

    _emitSel() { if (this.onSelect) this.onSelect(this.sel.size, this.selected()); },

    _paintOne(meta) {
      for (const [, el] of this.els) {
        if (el._item === meta) { el.classList.toggle('is-sel', this.sel.has(meta)); break; }
      }
    },

    _paintAll() {
      for (const [, el] of this.els) {
        if (el._item) el.classList.toggle('is-sel', this.sel.has(el._item));
      }
    },

    /* ---------- 收藏（网格内直接操作，无需进大图） ---------- */
    _toggleFav(meta) {
      const on = State.toggleFav(meta.id);   // 会广播 favorite-changed，由 _onFavChanged 统一重绘
      // 若正开着灯箱且显示的就是这张，同步灯箱按钮
      if (global.Lightbox && global.Lightbox.openFlag && global.Lightbox.meta === meta) {
        global.Lightbox.favBtn.classList.toggle('is-on', on);
        global.Lightbox.favBtn.innerHTML = Util.icon(on ? 'i-star-fill' : 'i-star');
      }
    },

    /** 把某张瓦片的星标刷成最新状态（用于别处改收藏后的联动） */
    _paintFav(meta) {
      if (!meta) return;
      const on = State.isFav(meta.id);
      for (const [, el] of this.els) {
        if (el._item === meta && el._fav) {
          el._fav.classList.toggle('is-on', on);
          el._fav.setAttribute('aria-pressed', String(on));
          el._fav.innerHTML = Util.icon(on ? 'i-star-fill' : 'i-star');
          break;
        }
      }
    },

    _paintAllFav() {
      for (const [, el] of this.els) if (el._fav) this._paintFav(el._item);
    },

    /** 收藏变化 → 刷新可见瓦片星标；
        「只看收藏」开启时，被取消收藏的那张要移出列表（否则会留在页面上自相矛盾）。
        列表归属 App 的分页视图，所以这里只发信号请它重算，绝不自己改 items。 */
    _onFavChanged(ev) {
      const { id, on } = ev || {};
      let hit = null;
      for (const [, el] of this.els) {
        if (el._item && el._item.id === id) { hit = el._item; break; }
      }
      if (hit) this._paintFav(hit);
      // 仅当：只看收藏 且 取消收藏 且 该条目正显示在本页 —— 才需要移出重排
      if (State.favOnly && on === false && hit && this.items.indexOf(hit) >= 0 && this.onFavRemoved) {
        this.onFavRemoved();
      }
    },

    /** 挂载框选：在网格空白处按下拖拽即选，拖到视口边缘自动滚动 */
    _wireMarquee() {
      const inner = this.inner;
      if (!inner || !Util.dragSelect) return;
      this._marquee = document.createElement('div');
      this._marquee.className = 'marquee';
      this._marquee.hidden = true;
      inner.appendChild(this._marquee);

      let base = null;
      const hitByRect = (rect) => {
        const pos = this.positions, N = this.N;
        const out = [];
        if (!pos || !N) return out;
        /* 起点：二分定位"第一张可能落进框里的图"。
           - 网格模式：y 与 y+h 都单调 → 按 y+h 二分，跨过所有在框上方结束的行。
           - 瀑布流：**y+h 不单调**（同列里后放的矮图底边可能更靠上），
             按它二分会漏掉上方的图 → 改用单调数组 yMax（[0..i] 内最大底边）。
           终点：`p.y >= rect.y2` 直接 break —— 这一步两种模式都成立，
           因为 y 本身恒为单调不减（见 js/masonry.js 顶部的不变量说明）。 */
        let a;
        if (this.mode === 'masonry') {
          a = Math.max(0, global.Masonry.lowerBound(this.yMax, rect.y1) - 1);
        } else {
          a = 0;
          let b = N;
          while (a < b) { const m = (a + b) >> 1; if (pos[m].y + pos[m].h <= rect.y1) a = m + 1; else b = m; }
        }
        for (let i = a; i < N; i++) {
          const p = pos[i];
          if (p.y >= rect.y2) break;
          if (p.x < rect.x2 && p.x + p.w > rect.x1) out.push(this.items[i]);
        }
        return out;
      };

      // 框选起点容器：用整个图库区域（.gallery），而不是仅 #stage。
      // 否则在 .stage-wrap 的居中留白 / 左右边距 / 顶部内边距里按下时，
      // 事件落在 #stage 之外，框选根本不会启动 —— 即「最上方和左右两边无法框选」。
      const rootEl = this.stage.closest('.gallery') || this.stage;
      this._box = Util.dragSelect({
        root: rootEl,
        box: this._marquee,
        toLocal: (cx, cy) => {
          const r = inner.getBoundingClientRect();
          return { x: cx - r.left, y: cy - r.top };
        },
        // 拒绝：勾选圈 / 收藏星标 / 删除按钮 / 任意按钮链接 / 表单控件（避免误吞底部状态栏的下拉与输入）
        shouldStart: (e) => {
          const t = e.target;
          return !t.closest('.tile-chk') && !t.closest('.tile-fav') && !t.closest('.tile-del')
            && !t.closest('button') && !t.closest('a')
            && !t.closest('select') && !t.closest('input') && !t.closest('textarea') && !t.closest('label');
        },
        onMove: (rect, e) => {
          if (!base) {
            const additive = !!(e && (e.shiftKey || e.ctrlKey || e.metaKey));
            base = additive ? new Set(this.sel) : null;
          }
          const hits = hitByRect(rect);
          this.sel = new Set(base || []);
          for (const m of hits) if (m) this.sel.add(m);
          this._paintAll();
          this._emitSel();
        },
        onEnd: (rect, moved) => {
          base = null;
          if (rect && moved) this._dragMoved = true; // 取消（rect=null）时不吞掉随后的点击
        },
      });
    },

    /* ---------- 数据入口 ---------- */
    showItems(list) { this._token++; this.items = list; this.pruneSel(); this.layout(true); },
    reload() { this._token++; this.items = State.viewList(); this.layout(true); },

    setMode(modeKey, resetTop) {
      if (this.mode !== modeKey || resetTop) {
        this.mode = modeKey;
        this.layout(!!resetTop);
      }
    },

    setModeSize(px, resetTop) { void px; this.layout(!!resetTop); },

    /* ---------- 宽高比 ---------- */
    /** 该图已保存的旋转角度（P1-4） */
    _rot(meta) {
      return (global.State && global.State.rotationOf) ? (global.State.rotationOf(meta) | 0) : 0;
    },
    /** 图片显示宽高比 w/h；未知时按 1:1 占位，缩略图解码后再重排。
        90°/270° 旋转会交换宽高，布局随之按竖/横切换（P1-4）。 */
    _aspect(meta) {
      const r = meta && meta.ratio;
      const a = (typeof r === 'number' && isFinite(r) && r > 0) ? r : 1;
      return (this._rot(meta) % 180 === 90) ? 1 / a : a;
    },

    /* ---------- 几何计算与布局 ---------- */
    layout(resetTop) {
      const mode = this.mode;
      const width = this.stage.clientWidth || this.wrap.clientWidth || 800;
      const N = this.items.length;
      this.width = width;
      this.N = N;

      if (resetTop) {
        this.els.clear();
        if (this.inner) {
          this.inner.textContent = '';
          if (this._marquee) this.inner.appendChild(this._marquee); // 选框是常驻节点，别被清掉
        }
      }

      if (mode === 'single') {
        this._layoutSingle(width);
      } else if (mode === 'masonry') {
        this._layoutMasonry(width);
      } else {
        this._layoutJustified(width, mode);
      }

      this.prune = N > (mode === 'single' ? SINGLE_PRUNE_AT : PRUNE_AT);

      // 更新既有瓦片位置
      for (const [i, el] of this.els) this._place(i, el);

      if (resetTop) {
        if (mode === 'single' && N) this._alignIndex(0);
        else global.scrollTo(0, 0);
      }
      this.sync();
      this._replaceExisting();          // 几何已重算：已存在的瓦片也要跟着挪位/换朝向
      if (mode !== 'single') this._upgradeThumbs();
    },

    /** 重新摆放全部已创建的瓦片（几何变化但不重建 DOM 时用；O(可见瓦片数)） */
    _replaceExisting() {
      for (const [i, el] of this.els) this._place(i, el);
    },

    /** 行内自适应模式下：瓦片比例知晓/重排变宽后，自动请求更高清缩略图 */
    _upgradeThumbs() {
      const { els, positions, mode } = this;
      if (mode === 'single' || !els.size) return;
      for (const [i, el] of els) {
        const p = positions[i];
        const meta = el && el._item;
        if (!p || !meta || meta.bad || meta.state === 'error' || !el._img) continue;
        const have = el._thumbCss || 0;
        // 判据用「该瓦片真正需要的宽度」而不是 p.w：紧凑网格下两者不等
        // （方形裁切要按长宽比放大长边），用 p.w 会永远判定为"已够清晰"。
        const need = this._thumbCssW(meta, p);
        if (need > have * 1.2 + 30 && !el._thUpgrading) {
          el._thUpgrading = true;
          this._loadThumb(meta, el, need).then(() => { el._thUpgrading = false; }).catch(() => { el._thUpgrading = false; });
        }
      }
    },

    /* 单列整屏：每张恰好占满「顶栏下方 ~ 视口底部」的整屏高度。
       注意：槽位高度固定按「底栏隐藏」计算，不随底栏显隐变化 —— 否则底栏滑出/收起
       会让所有槽位重排、滚动位置跳动。底栏显示时它是浮层，覆盖在图片底部即可。 */
    _layoutSingle(width) {
      const { topH } = this._chrome();
      const slotH = Math.max(300, Math.round(global.innerHeight - topH));
      document.documentElement.style.setProperty('scroll-padding-top', topH + 'px');
      const N = this.N;
      this.gap = 0;
      this.leftOff = Math.max(0, (width - Math.min(width, SINGLE_MAXW)) / 2);
      const w = Math.min(width, SINGLE_MAXW);
      const pos = this.positions = new Array(N);
      for (let i = 0; i < N; i++) {
        pos[i] = { x: this.leftOff, y: i * slotH, w, h: slotH };
      }
      this.totalH = N ? N * slotH : 0;
      if (this.inner) this.inner.style.height = this.totalH + 'px';
    },

    /* 网格模式：行内自适应 —— 每行等高、行宽恰好填满容器；末行可能不满，左对齐 */
    _layoutJustified(width) {
      const N = this.N;
      const gap = GAP;
      const availW = Math.max(80, width);
      // 紧凑模式走另一条排布：等边方格 + 方形裁切。
      // 它和 medium 不是"同一套布局的两个尺寸档"，而是两种视图 —— 后者按真实宽高比排、永不裁切。
      if (State.MODES[this.mode] && State.MODES[this.mode].crop) {
        this._layoutCells(availW);
        return;
      }
      const H = Math.max(72, State.getModeSize(this.mode)); // 目标行高（来自尺寸滑杆）
      const pos = this.positions = new Array(N);
      const ratio = new Array(N);
      for (let i = 0; i < N; i++) ratio[i] = this._aspect(this.items[i]);

      let y = 0, i = 0;
      while (i < N) {
        let j = i, sumA = 0;
        // 贪心入行：以目标高 H 估算，累加到再加一张就超宽为止
        while (j < N) {
          const a = ratio[j];
          if (j > i && (sumA + a) * H + (j - i) * gap > availW + 0.01) break;
          sumA += a;
          j++;
        }
        const n = j - i;
        const isLast = j >= N;
        const naturalW = sumA * H + (n - 1) * gap;   // 若按目标高 H 排列的总宽
        const idealH = (availW - (n - 1) * gap) / sumA; // 恰好填满整行所需行高

        let rowH;
        if (!isLast) {
          rowH = idealH;
        } else {
          // 末行：接近满行（≥92%）才精确填满；否则保持目标高、右侧留白左对齐。
          // 绝不拉伸任何单张的比例 —— 允许留白正是为了不强行撑大。
          rowH = naturalW >= availW * 0.92 ? idealH : H;
        }

        let x = 0;
        for (let k = i; k < j; k++) {
          const w = ratio[k] * rowH;
          pos[k] = { x, y, w, h: rowH };
          x += w + gap;
        }
        y += rowH + gap;
        i = j;
      }
      this.gap = gap;
      this.leftOff = 0;
      this.totalH = y > 0 ? y - gap + BOTTOM_PAD : 0;
      if (this.inner) this.inner.style.height = this.totalH + 'px';
    },

    /* 紧凑网格（small）：等边方格 + 方形裁切。
       与 _layoutJustified 的分工 —— 那一套按真实宽高比缩放、永不裁切，适合"看照片"；
       这一套用"裁掉边角"换"整屏密排"，适合"找照片"。两者的滑杆含义也不同：
       这里调的是方格边长，那里调的是目标行高。 */
    _layoutCells(availW) {
      const N = this.N;
      const gap = CELL_GAP;
      const want = Math.max(48, State.getModeSize(this.mode)); // 目标边长（来自尺寸滑杆）

      /* 先按目标边长算列数，再把剩余宽度均摊回边长。
         不直接固定边长：那样每行右侧会留一条宽度不定的碎边，
         密排视图里这条碎边比"边长差几个像素"更显眼。 */
      const cols = Math.max(1, Math.floor((availW + gap) / (want + gap)));
      const cell = (availW - (cols - 1) * gap) / cols;

      const pos = this.positions = new Array(N);
      for (let i = 0; i < N; i++) {
        const r = (i / cols) | 0, c = i % cols;
        pos[i] = { x: c * (cell + gap), y: r * (cell + gap), w: cell, h: cell };
      }

      this.cols = cols;
      this.cell = cell;
      this.gap = gap;
      this.leftOff = 0;
      const rows = Math.ceil(N / cols);
      this.totalH = rows ? rows * (cell + gap) - gap + BOTTOM_PAD : 0;
      if (this.inner) this.inner.style.height = this.totalH + 'px';
    },

    /* 瀑布流（v1.12.0）：等宽列、按比例定高、每张塞进当前最矮的列。
       排布算法本身在 js/masonry.js（纯函数，可在 Node 毫秒级断言），
       这里只负责把结果接到本模块的 positions / totalH / yMax 上。
       列宽来自尺寸滑杆（对瀑布流而言滑杆调的是"列宽"，不是行高）。 */
    _layoutMasonry(width) {
      const N = this.N;
      const gap = GAP;
      const availW = Math.max(80, width);
      const colW = Math.max(global.Masonry.MIN_COL, State.getModeSize('masonry'));

      const aspects = new Array(N);
      for (let i = 0; i < N; i++) aspects[i] = this._aspect(this.items[i]);

      const r = global.Masonry.compute({
        width: availW, colW: colW, gap: gap, aspects: aspects,
      });

      this.positions = r.positions;
      this.cols = r.cols;
      this.colW = r.colW;
      this.gap = gap;
      this.leftOff = 0;
      // yMax：单调不减的"前缀最大底边"，供 _computeRange / _anchorIndex / 框选
      // 在非单调的 y+h 上替代二分（见 js/masonry.js 顶部不变量说明）
      this.yMax = r.yMax;
      this.totalH = r.totalH > 0 ? r.totalH + BOTTOM_PAD : 0;
      if (this.inner) this.inner.style.height = this.totalH + 'px';
    },

    /** 单列模式下的“视口吸顶”所需高度（顶栏）。
       底部状态栏已是「浮层 + 自动隐藏」的 fixed 元素，不占文档流、不参与单列槽位计算。 */
    _chrome() {
      const topEl = document.getElementById('topbar');
      const topH = (topEl && !topEl.hidden) ? topEl.offsetHeight : 58;
      return { topH: topH || 58 };
    },

    /** 滚动使第 i 个单列瓦片顶对齐到顶栏下沿（=吸附位） */
    _alignIndex(i) {
      const { topH } = this._chrome();
      const p = this.positions && this.positions[i];
      if (!p) return;
      const stageTop = this.stage.getBoundingClientRect().top + (global.scrollY || 0);
      global.scrollTo({ top: Math.max(0, stageTop - topH + p.y), behavior: 'auto' });
    },

    _place(i, el) {
      const p = this.positions[i];
      if (!p || !el) return;
      el.style.transform = `translate(${p.x}px,${p.y}px)`;
      el.style.width = p.w + 'px';
      el.style.height = p.h + 'px';
      this._applyRot(el, i);
    },

    /**
     * 把该瓦片的旋转朝向应用到 DOM（P1-4）。
     * 做法：占位框 .tile-ph 的宽高按瓦片宽高「对调」，居中后整体 rotate 90°；
     * 于是旋转后的渲染外框恰好仍是 p.w × p.h，正好贴合瓦片，不溢出、不裁切。
     * 文件名浮层 .tile-cap 是 .tile-ph 的兄弟节点，保持水平不跟着转。
     */
    _applyRot(el, i) {
      const meta = this.items[i];
      const p = this.positions[i];
      if (!el || !p) return;
      const rot = this._rot(meta);
      const quarter = (rot === 90 || rot === 270);
      el.classList.toggle('r90', quarter);
      if (el.dataset) el.dataset.rot = String(rot);
      const ph = el._ph;
      if (!ph) return;
      if (quarter) {
        ph.style.width = p.h + 'px';
        ph.style.height = p.w + 'px';
      } else {
        ph.style.width = '';
        ph.style.height = '';
      }
    },

    /**
     * 旋转变更后的刷新。旋转会交换宽高比（_aspect 取倒数），
     * 因此不只是挪一下这张：整行高度/换行都变了，必须重排。
     * 一次性用户动作，layout(false) 的 O(N) 开销可以接受。
     */
    refreshRotation(meta) {
      void meta;
      if (this.N) this.layout(false);
    },

    /* ---------- 窗口同步 ---------- */
    sync() {
      if (!this.N) return;
      this._computeRange();
      this._reconcile();
      this._schedule();
      this._markDesired();
    },

    /** 把当前可视区条目 id 报给缩略图管线 → 解码槽优先服务这些图。
        快速滚动时新区域的请求不再是「排在队尾」，而是插到最前面。 */
    _markDesired() {
      const T = global.Thumbs;
      if (!T || typeof T.setDesired !== 'function') return;
      const out = [];
      for (let i = this.vi0; i < this.vi1; i++) {
        const m = this.items[i];
        if (m && !m.bad) out.push(m.id);
      }
      T.setDesired(out);
    },

    _computeRange() {
      const N = this.N;
      if (!this.prune) { this.vi0 = 0; this.vi1 = N; return; }
      const pos = this.positions;
      const top = this.stage.getBoundingClientRect().top;
      const vh = global.innerHeight;
      const scrolled = Math.max(0, -top);
      const pad = Math.max(400, Math.round(vh * 0.7));
      const lo = Math.max(0, scrolled - pad);
      const hi = Math.min(this.totalH || 1e9, scrolled + vh + pad);

      /* 起点：二分"第一张可能进入可视区的图"。
         - 网格 / 单列：y 与 y+h 都单调 → 按 y+h 二分，跨过在上方结束的行。
         - 瀑布流：y+h **不单调**（同列里后放的矮图底边可能更靠上），
           按它二分会把上方的图判成"已滚过"而整片不显示 → 改用单调的 yMax。
         终点：按 y 二分 —— 这一步两种模式都成立，y 恒为单调不减。 */
      let i0;
      if (this.mode === 'masonry') {
        i0 = Math.max(0, global.Masonry.lowerBound(this.yMax, lo) - 1);
      } else {
        let a = 0, b = N;
        while (a < b) { const m = (a + b) >> 1; if (pos[m].y + pos[m].h <= lo) a = m + 1; else b = m; }
        i0 = Math.max(0, a - 1);
      }
      let a = 0, b = N;
      while (a < b) { const m = (a + b) >> 1; if (pos[m].y < hi) a = m + 1; else b = m; }
      this.vi0 = i0;
      this.vi1 = Math.min(N, a + 1);
    },

    _reconcile() {
      const { vi0, vi1, els } = this;
      for (const [i, el] of els) {
        if (i < vi0 || i >= vi1) { el.remove(); els.delete(i); }
      }
      this.needCreate = [];
      for (let i = vi0; i < vi1; i++) if (!els.has(i)) this.needCreate.push(i);
    },

    _schedule() {
      if (this.rafId || !this.needCreate.length) return;
      const budget = 80; // 每帧新增瓦片上限
      const step = () => {
        this.rafId = 0;
        let k = 0;
        while (this.needCreate.length && k < budget) this._createTile(this.needCreate.shift()), k++;
        if (this.needCreate.length) this._schedule();
      };
      this.rafId = requestAnimationFrame(step);
    },

    /* ---------- 瓦片 ---------- */
    _createTile(i) {
      const meta = this.items[i];
      if (!meta || this.els.has(i)) return;
      const p = this.positions[i];
      if (!p) return;

      const el = document.createElement('figure');
      el.className = 'tile' + (this.mode === 'single' ? ' single-tile' : ' g')
        + (this.sel.has(meta) ? ' is-sel' : '');
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');
      el.setAttribute('aria-label', '查看 ' + meta.name);
      el._item = meta;
      el._job = this._token;

      const ph = document.createElement('div');
      ph.className = 'tile-ph';

      if (meta.bad) {
        el.classList.add('err');
        const ic = document.createElement('span');
        ic.className = 'tile-err-ic';
        ic.innerHTML = Util.icon('i-eye');
        ph.appendChild(ic);
      } else {
        const img = document.createElement('img');
        img.alt = meta.name;
        img.decoding = 'async';
        img.draggable = false;
        el._img = img;
        ph.appendChild(img);          // img 在前，sheen 在后：利于 CSS 兄弟选择器
        const sheen = document.createElement('div');
        sheen.className = 'ph-sheen';
        ph.appendChild(sheen);
      }
      el.appendChild(ph);
      el._ph = ph;                    // 供 _applyRot 按需对调宽高（P1-4）

      const cap = document.createElement('div');
      cap.className = 'tile-cap';
      const nm = document.createElement('span');
      nm.className = 't-name';
      nm.textContent = meta.name;
      const sz = document.createElement('span');
      sz.className = 't-size';
      sz.textContent = Util.fmtBytes(meta.size);
      cap.appendChild(nm); cap.appendChild(sz);
      el.appendChild(cap);

      // 收藏星标：网格里直接点选，无需进入大图（默认仅收藏态常显，其余悬停浮现）
      const fav = document.createElement('button');
      fav.type = 'button';
      fav.className = 'tile-fav' + (State.isFav(meta.id) ? ' is-on' : '');
      fav.tabIndex = -1;             // 不占用 Tab 序，键盘收藏请在灯箱中用 F
      fav.title = '收藏这张图片';
      fav.setAttribute('aria-label', '收藏 ' + meta.name);
      fav.setAttribute('aria-pressed', String(State.isFav(meta.id)));
      fav.innerHTML = Util.icon(State.isFav(meta.id) ? 'i-star-fill' : 'i-star');
      fav.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();        // 阻止冒泡到 stage（否则会顺带打开灯箱）
        this._toggleFav(meta);
      });
      el._fav = fav;
      el.appendChild(fav);

      // 勾选圈：批量选择的入口（悬停/选中时常显；点击只切换选中，不打开大图）
      const chk = document.createElement('span');
      chk.className = 'tile-chk';
      chk.innerHTML = Util.icon('i-check');
      chk.title = '选择（Ctrl/⌘+点击也可切换）';
      chk.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.toggle(meta);
      });
      el.appendChild(chk);

      // 删除按钮：仅当该来源具备写能力时出现（拖拽/文件框来源没有写权限 → 不显示）
      if (this.onDelete && global.Loader.canDelete(meta)) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'tile-del';
        del.tabIndex = -1;           // 不占用 Tab 序：键盘删除请在灯箱中用 Delete
        del.title = '删除这张图片';
        del.setAttribute('aria-label', '删除 ' + meta.name);
        del.innerHTML = Util.icon('i-trash');
        del.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();      // 阻止冒泡到 stage（否则会顺带打开灯箱）
          if (this.onDelete) this.onDelete(meta);
        });
        el.appendChild(del);
        el.classList.add('has-del');   // 让星标左移，避免与删除按钮叠压
      }

      this.els.set(i, el);
      this.inner.appendChild(el);
      this._place(i, el);

      if (this.mode === 'single') this._loadBig(meta, el);
      else this._loadThumb(meta, el, this._thumbCssW(meta, p));
    },

    /** 该瓦片该请求多宽的缩略图（缩略图按**长边**生成，见 thumb.js 的 decodeThumb）。
        普通网格瓦片高度就是按宽度算出来的，按 p.w 请求正好；
        紧凑网格是方形裁切（object-fit: cover），短边要撑满 p.h，
        所以长边需求 = 边长 × 长宽比 —— 否则宽图会被放大到发虚。 */
    _thumbCssW(meta, p) {
      const def = State.MODES[this.mode];
      if (!(def && def.crop)) return p.w;
      const a = this._aspect(meta);
      return Math.max(p.w, p.h * Math.max(a, 1 / a));
    },

    async _loadThumb(meta, el, cssW) {
      if (meta.state === 'error') { this._markErr(el); return; }
      const token = el._job;
      const url = await Thumbs.thumbURL(meta, cssW);
      if (el._job !== token || !el.isConnected) return;
      if (!url) { this._tryBigFallback(meta, el); return; } // 缩略管线失败 → 原图兜底
      const img = el._img; if (!img) return;
      el._thumbCss = cssW; // 记录本次请求对应的显示宽度（供升级判定）
      meta.state = 'loading';
      img.onload = () => {
        if (el._job !== token || !el.isConnected) return;
        img.classList.add('ld');
        meta.state = 'ok';
        this._noteRatio(meta, img.naturalWidth, img.naturalHeight, false);
      };
      img.onerror = () => { if (el._job === token) this._tryBigFallback(meta, el); };
      img.src = url;
      if (img.complete && img.naturalWidth > 0) {
        img.classList.add('ld');
        this._noteRatio(meta, img.naturalWidth, img.naturalHeight, false);
      }
    },

    _loadBig(meta, el) {
      if (meta.state === 'error') { this._markErr(el); return; }
      if (el._bigTried) return;
      el._bigTried = true;
      const url = Thumbs.bigURL(meta);
      if (!url) { this._markErr(el); return; }
      const img = el._img; if (!img) return;
      const token = el._job;
      meta.state = 'loading';
      img.onload = () => {
        if (el._job !== token || !el.isConnected) return;
        img.classList.add('ld'); el.classList.add('lo');
        meta.state = 'ok';
        this._noteRatio(meta, img.naturalWidth, img.naturalHeight, true);   // 单列加载的是原图 → 真实尺寸
      };
      img.onerror = () => { if (el._job === token) this._markErr(el); };
      img.src = url;
    },

    /** 记录图片真实宽高比；若改变则防抖重排（仅网格模式需要）。同时回写尺寸持久缓存。
        full=true 表示这里拿到的是「原图」的真实像素尺寸（单列/大图路径）；
        缩略图路径传 false —— 缩略图是被降采样过的，它的像素尺寸不是原图尺寸，
        只能拿来校准比例，绝不能当成绝对尺寸写进尺寸库。 */
    _noteRatio(meta, nw, nh, full) {
      if (!meta || !(nw > 0) || !(nh > 0)) return;
      if (full) Loader.recordDims(meta, nw, nh);
      else Loader.recordRatio(meta, nw, nh);
      const r = nw / nh;
      const prev = meta.ratio;
      if (prev === r || (typeof prev === 'number' && Math.abs(prev - r) < 0.005)) return;
      meta.ratio = r;
      if (this.mode !== 'single' && this.N) this._requestRatioLayout();
    },

    /** 比例就绪 → 防抖触发布局重排，并以视口顶部瓦片为锚点保持不跳 */
    _requestRatioLayout() {
      if (this._ratioTimer) return;
      this._ratioTimer = setTimeout(() => {
        this._ratioTimer = 0;
        this._applyRatioLayout();
      }, 120);
    },

    _applyRatioLayout() {
      if (this.mode === 'single' || !this.N) return;
      const oldPos = this.positions;
      const anchor = this._anchorIndex(oldPos);
      const oldY = (anchor != null && oldPos[anchor]) ? oldPos[anchor].y : null;
      const sy = global.scrollY || 0;
      this.layout(false);
      if (anchor != null && this.positions[anchor] && oldY != null) {
        const dY = this.positions[anchor].y - oldY;
        if (dY) global.scrollTo(0, Math.max(0, sy + dY));
      }
    },

    /** 取当前视口顶部的瓦片索引（供重排锚定，重排后用它把滚动位置拉回原处） */
    _anchorIndex(pos) {
      const N = this.N;
      if (!N || !pos || !pos.length) return null;
      const top = this.stage.getBoundingClientRect().top;
      const scrolled = Math.max(0, -top);
      let a = 0, b = N;
      if (this.mode === 'masonry') {
        // 瀑布流：按单调的 y 二分。用 y+h 会锚到"底边刚跨过视口顶"的那张，
        // 而它在瀑布流里可能离视口顶很远 → 重排后滚动位置会跳。
        while (a < b) { const m = (a + b) >> 1; if (pos[m].y < scrolled) a = m + 1; else b = m; }
      } else {
        while (a < b) { const m = (a + b) >> 1; if (pos[m].y + pos[m].h <= scrolled) a = m + 1; else b = m; }
      }
      return Math.min(a, N - 1);
    },

    /* 缩略图失败时用原图渲染，仍失败才判定无法解码 */
    _tryBigFallback(meta, el) {
      if (meta.bad || el._bigTried) { this._markErr(el); return; }
      this._loadBig(meta, el);
    },

    _markErr(el) {
      if (!el.isConnected) return;
      el.classList.add('err');
      if (el._img) { el._img.remove(); el._img = null; }
      if (!el.querySelector('.tile-err-ic')) {
        const ph = el.querySelector('.tile-ph');
        if (ph) {
          const ic = document.createElement('span');
          ic.className = 'tile-err-ic';
          ic.innerHTML = Util.icon('i-eye');
          ph.appendChild(ic);
        }
      }
      const meta = el._item;
      meta.state = 'error';
      if (!meta._errEmitted) { meta._errEmitted = true; State.bus.emit('item-error', { id: meta.id }); }
    },

    /** 单列：回到本页第一张（页面切换/筛选变化时对齐） */
    alignFirst() { if (this.mode === 'single' && this.N) this._alignIndex(0); },

    /** 按条目取当前瓦片元素（键盘焦点还原用）；不在本页 / 已回收则返回 null */
    elFor(meta) {
      const i = this.items.indexOf(meta);
      return i < 0 ? null : (this.els.get(i) || null);
    },

    /** Lightbox 关闭后回到该条目位置并短暂高亮 */
    revealItem(meta) {
      const i = this.items.indexOf(meta);
      if (i < 0) return;
      if (this.mode === 'single') {
        this._alignIndex(i);
      } else {
        const p = this.positions[i]; if (!p) return;
        global.scrollTo({
          top: this.stage.getBoundingClientRect().top + global.scrollY + p.y - global.innerHeight * 0.32,
          behavior: 'smooth',
        });
      }
      const el = this.els.get(i);
      if (el) {
        el.style.outline = '2px solid var(--sel)';
        el.style.outlineOffset = '2px';
        setTimeout(() => { el.style.outline = ''; }, 1500);
      }
    },
  };

  global.Grid = Grid;
})(window);
