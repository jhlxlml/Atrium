/* ============================================================
   Atrium · lightbox.js
   大图查看：居中最大化 / 切换 / ±预加载 / 缩放平移 / 收藏 /
   缩略图条 / 全屏幻灯片（自动播放）
   ============================================================ */
(function (global) {
  'use strict';

  const Util = global.Util;
  const T = global.Transform;  // 纯几何层（js/transform.js），本文件只负责把结果写进 DOM
  // 无障碍共用件（焦点陷阱）。缺失时降级为"不装陷阱"，不影响灯箱本身可用。
  const A11y = global.A11y;
  const MAX_SCALE = 14;   // 手动放大上限
  const MAX_FIT = 3;      // “适应”放大上限（小图最大放到 3 倍原始像素）
  const PLAY_MS = 3800;   // 幻灯片间隔
  const INFO_W = 300;     // 信息面板宽

  const Lightbox = {
    el: null, stage: null, img: null, spin: null, errBox: null,
    nameEl: null, countEl: null, pctEl: null, favBtn: null, stripBtn: null, strip: null,
    fsBtn: null, playBtn: null,
    fsSupported: false,
    list: [],          // 快照（打开时的展示列表）
    i: -1,
    meta: null,
    nw: 0, nh: 0,
    scale: 1, base: 1, tx: 0, ty: 0,
    rot: 0,                       // 当前旋转角度（0/90/180/270）
    wheelMode: 'zoom',           // 滚轮功能：'zoom'=缩放，'nav'=切换图片
    playMs: null,                // 幻灯片间隔（毫秒）；null = 用 PLAY_MS 默认
    autoStrip: false,            // 打开时自动展开缩略图条（设置项）
    autoInfo: false,             // 打开时自动显示信息面板（设置项）
    openFlag: false,
    openedMeta: null,
    stripOn: false,
    playing: false, playTimer: null,
    dragging: false, moved: false, lastX: 0, lastY: 0,
    _pinch: 0,                    // 双指缩放时的上一帧指距（0 = 未在捏合）
    _hintRot: -1,                 // 上一次提示过的旋转角度（避免同一角度反复弹提示）
    idleTimer: null, IDLE_MS: 2600,
    onClose: null,

    init(opts) {
      this.onClose = opts.onClose || null;
      this.onDelete = opts.onDelete || null;
      this.el = Util.$('#lightbox');
      this.stage = Util.$('#lbStage');
      this.img = Util.$('#lbImg');
      this.spin = Util.$('#lbSpin');
      this.errBox = Util.$('#lbErr');
      this.nameEl = Util.$('#lbName');
      this.countEl = Util.$('#lbCount');
      this.pctEl = Util.$('#lbPct');
      this.favBtn = Util.$('#lbFav');
      this.stripBtn = Util.$('#lbStripBtn');
      this.strip = Util.$('#lbStrip');
      this.playBtn = Util.$('#lbPlay');
      this.fsBtn = Util.$('#lbFs');
      this.infoBtn = Util.$('#lbInfo');
      this.infoPane = Util.$('#lbInfoPane');
      this.infoBody = Util.$('#lbInfoBody');
      this.rotRBtn = Util.$('#lbRotR');
      this.wheelBtn = Util.$('#lbWheel');
      /* v1.20.3：这一行以前**漏了**。`#lbDel` 在 index.html 里存在、可点、可聚焦、
         标题还写着「删除（Delete）」，但 `this.delBtn` 从未被赋值，于是下面
         `if (this.delBtn)` 的绑定永远不执行 —— 按钮和 Delete 键都是死的，
         按下去没有任何反应也没有提示。门禁只断言了"按钮存在且可聚焦"，
         所以一直没红。 */
      this.delBtn = Util.$('#lbDel');
      this.fsSupported = !!(document.fullscreenEnabled);

      Util.$('#lbClose').addEventListener('click', () => this.close());
      Util.$('#lbPrev').addEventListener('click', () => this.nav(-1));
      Util.$('#lbNext').addEventListener('click', () => this.nav(1));
      Util.$('#lbZoomIn').addEventListener('click', () => { const c = this._center(); this.zoomAt(1.4, c.x, c.y); });
      Util.$('#lbZoomOut').addEventListener('click', () => { const c = this._center(); this.zoomAt(1 / 1.4, c.x, c.y); });
      Util.$('#lbFit').addEventListener('click', () => this.fit(true));
      if (this.rotRBtn) this.rotRBtn.addEventListener('click', () => this.rotate(1));
      if (this.wheelBtn) this.wheelBtn.addEventListener('click', () => this.toggleWheel());
      this.pctEl.addEventListener('click', () => this.toggleScale());
      this.favBtn.addEventListener('click', () => this.toggleFav());
      this.stripBtn.addEventListener('click', () => this.toggleStrip());
      // 鼠标悬停在缩略图条上时，纵向滚轮切换上一张/下一张；横向滚动（触控板横滑/Shift+滚轮）仍交给条内自身滚动
      this.strip.addEventListener('wheel', (e) => {
        if (!this.openFlag || this.list.length < 2) return;
        const dy = e.deltaY, dx = e.deltaX;
        if (Math.abs(dy) < Math.abs(dx) || e.shiftKey) return; // 横向滚动留给条内
        e.preventDefault();
        this.nav(dy < 0 ? -1 : 1);
      }, { passive: false });
      // 缩略图条滚动位置检测：滚到最右端时添加 strip-at-end 类（沉浸模式下可据此显现）
      this.strip.addEventListener('scroll', () => this._checkStripEnd(), { passive: true });
      if (this.infoBtn) this.infoBtn.addEventListener('click', () => this.toggleInfo());
      this.playBtn.addEventListener('click', () => this.togglePlay());
      if (this.delBtn) this.delBtn.addEventListener('click', () => { if (this.onDelete && this.meta) this.onDelete(this.meta); });
      if (this.fsSupported && this.fsBtn) {
        this.fsBtn.addEventListener('click', () => this.toggleFs());
        document.addEventListener('fullscreenchange', () => this._onFsChange());
      } else if (this.fsBtn) {
        this.fsBtn.hidden = true;
      }
      this.el.addEventListener('click', (e) => {
        if (e.target === this.el || e.target === Util.$('.lb-bg')) this.close();
      });

      // 拖拽 / 点击 / 滚轮（pointer 事件统一处理触摸）
      this.stage.addEventListener('pointerdown', (e) => this._pd(e));
      global.addEventListener('pointermove', (e) => this._pm(e));
      global.addEventListener('pointerup', (e) => this._pu(e));
      this.stage.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
      // 触摸屏双指缩放（触控板捏合走上面的 ctrlKey wheel 分支）
      this.stage.addEventListener('touchstart', (e) => this._tstart(e), { passive: false });
      this.stage.addEventListener('touchmove', (e) => this._tmove(e), { passive: false });
      this.stage.addEventListener('touchend', (e) => this._tend(e), { passive: false });
      this.stage.addEventListener('touchcancel', (e) => this._tend(e), { passive: false });
      this.img.addEventListener('dblclick', (e) => { e.preventDefault(); this.toggleScale(e); });
      this.stage.addEventListener('dblclick', (e) => { if (e.target !== this.img) { e.preventDefault(); this.toggleScale(); } });
      // 右键：桌面版弹原生菜单（上一张/下一张/缩放/旋转/收藏/全屏/导出/删除）；
      // 拿不到原生菜单时退回"屏蔽网页默认菜单"，保持原来的观感。
      this.stage.addEventListener('contextmenu', (e) => {
        if (global.App && global.App.lightboxContext && global.Native && global.Native.canContextMenu) {
          global.App.lightboxContext(e);
          return;
        }
        e.preventDefault();
      });

      // 沉浸式：鼠标移动时显现对应区域控件 + 光标，停手自动隐藏
      this.el.addEventListener('mousemove', (e) => this._fsActivity(e));

      // 键盘（仅打开时生效）
      document.addEventListener('keydown', (e) => this._key(e));

      // 初始化滚轮模式按钮外观
      this._setWheelUI();
    },

    /* ---------- 打开 / 关闭 ---------- */
    open(list, meta) {
      this.stopPlay();
      this.list = list;
      this.i = list.indexOf(meta);
      this.meta = meta;
      this.openedMeta = meta;
      this.openFlag = true;
      this.rot = State.rotationOf ? State.rotationOf(meta) : 0;   // P1-4：先取回该图的旋转
      this.el.hidden = false;
      this.el.setAttribute('aria-hidden', 'false');
      document.body.classList.add('lb-open');
      // 设置项：打开大图时是否自动展开缩略图条 / 信息面板
      if (this.autoStrip !== undefined) this.stripOn = !!this.autoStrip;
      this.strip.hidden = !this.stripOn;
      this.el.classList.toggle('with-strip', !!this.stripOn);
      this.stripBtn.classList.toggle('is-on', !!this.stripOn);
      // 信息面板：默认关闭；开了「自动显示图片信息」则一起展开
      this.infoOn = !!this.autoInfo;
      this.el.classList.toggle('with-info', this.infoOn);
      if (this.infoPane) this.infoPane.hidden = !this.infoOn;
      if (this.infoBtn) { this.infoBtn.classList.toggle('is-on', this.infoOn); this.infoBtn.setAttribute('aria-pressed', String(this.infoOn)); }
      this._setFsIcon();
      this._buildStrip();
      this.render();
      if (this.infoOn) this._renderInfo();
      // 进入沉浸式：默认隐藏所有控件，仅底部 HUD 短暂提示后自动隐藏
      this.el.classList.add('lb-immersive');
      this.el.classList.add('fs-bottom');
      this._fsActivity(null);
      // 焦点陷阱：移入灯箱 → Tab 圈住 → 关闭还原到网格里那张瓦片。
      // 灯箱是整屏 role="dialog" aria-modal="true"，不装陷阱的话 Tab 会直接穿到
      // 背后的顶栏和瓦片 —— 它们都还在 Tab 序里，而屏幕上什么都看不出来。
      // 初始焦点给容器本身：读屏先播报「图片查看，对话框」，再按 Tab 才进控件。
      // 容器带不带 tabindex 由 A11y.trap 统一保证，这里不重复。
      if (A11y && A11y.trap) this._releaseTrap = A11y.trap(this.el, { initial: this.el });
    },

    close() {
      if (!this.openFlag) return;
      this.stopPlay();
      this.openFlag = false;
      this._pinch = 0;      // 清掉捏合残留，避免下次打开用旧指距算缩放比
      this._hintRot = -1;   // 下次打开重新允许弹一次旋转提示
      this.dragging = false;
      // 若处于全屏，先退出全屏（异步），再隐藏
      if (document.fullscreenElement === this.el) {
        const done = () => {
          document.removeEventListener('fullscreenchange', done);
          this._hide();
        };
        document.addEventListener('fullscreenchange', done);
        document.exitFullscreen().catch(() => this._hide());
      } else {
        this._hide();
      }
    },

    _hide() {
      if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
      // 解陷阱必须在隐藏之前：拦截器挂在 document 上，漏解会让 Tab 一直被圈住。
      // 而且"关闭还原焦点"的判断依赖此刻容器状态，顺序反过来会走错分支。
      if (this._releaseTrap) { this._releaseTrap(); this._releaseTrap = null; }
      this.el.classList.remove('lb-immersive', 'fs-idle', 'fs-top', 'fs-left', 'fs-right', 'fs-bottom');
      this.el.hidden = true;
      this.el.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('lb-open');
      if (this.onClose) {
        const changed = this.meta !== this.openedMeta;
        this.onClose(changed ? this.meta : null);
      }
    },

    isOpen() { return this.openFlag; },

    /* ---------- 全屏 ---------- */
    toggleFs() {
      if (!this.openFlag || !this.fsSupported) return;
      const d = document;
      if (d.fullscreenElement === this.el) {
        d.exitFullscreen().catch(() => {});
      } else if (!d.fullscreenElement) {
        this.el.requestFullscreen().catch(() => {});
      }
    },

    /** 全屏变化后按当前朝向重新“最大化适应”（进入/退出都要） */
    _onFsChange() {
      const fs = document.fullscreenElement === this.el;
      this._setFsIcon();
      // 全屏尺寸变化后重新“最大化适应”：进入时贴边铺满，退出时恢复常规留白
      setTimeout(() => { if (this.openFlag && this.nw) this.fit(false); }, 80);
      if (fs) this._fsActivity(null);
    },

    _setFsIcon() {
      if (!this.fsBtn) return;
      const fs = document.fullscreenElement === this.el;
      this.fsBtn.innerHTML = Util.icon(fs ? 'i-collapse' : 'i-expand');
      this.fsBtn.title = fs ? '退出全屏（Esc）' : '全屏显示（幻灯片大屏）';
      this.fsBtn.setAttribute('aria-label', fs ? '退出全屏' : '全屏显示');
    },

    /* ---------- 幻灯片播放 ---------- */
    startPlay() {
      if (this.playing || this.list.length < 2) return;
      this.playing = true;
      this._setPlayUI();
      this.playTimer = setInterval(() => {
        if (!this.openFlag) { this.stopPlay(); return; }
        this.nav(1);
      }, this.playMs || PLAY_MS);
    },

    stopPlay() {
      if (!this.playing) return;
      this.playing = false;
      if (this.playTimer) { clearInterval(this.playTimer); this.playTimer = null; }
      this._setPlayUI();
    },

    togglePlay() { this.playing ? this.stopPlay() : this.startPlay(); },

    _setPlayUI() {
      if (!this.playBtn) return;
      const on = this.playing;
      this.playBtn.classList.toggle('is-play', on);
      this.playBtn.innerHTML = Util.icon(on ? 'i-pause' : 'i-play');
      this.playBtn.title = on ? '暂停（P）' : '幻灯片播放（P）';
      this.playBtn.setAttribute('aria-pressed', String(on));
    },

    /* ---------- 渲染当前项 ---------- */
    render() {
      const meta = this.meta;
      if (!meta) return;
      // P1-4：恢复这张图此前保存过的旋转（没有记录即 0），重开保持一致
      this.rot = State.rotationOf ? State.rotationOf(meta) : 0;
      const n = this.list.length;
      this.nameEl.textContent = meta.name;
      this.countEl.textContent = n > 1 ? `${this.i + 1} / ${n}` : '';

      // 收藏状态
      const on = State.isFav(meta.id);
      this.favBtn.classList.toggle('is-fav', on);
      this.favBtn.innerHTML = Util.icon(on ? 'i-star-fill' : 'i-star');
      this.favBtn.setAttribute('aria-pressed', String(on));

      // 删除可用性：仅当来源具备写能力时可用（文案区分「回收站 / 永久」）
      if (this.delBtn) {
        const cap = global.Loader.canDelete(meta);
        this.delBtn.disabled = !cap;
        this.delBtn.classList.toggle('disabled', !cap);
        this.delBtn.title = cap === 'trash' ? '删除（移入回收站 · Delete）'
          : cap === 'fs' ? '删除（永久删除 · Delete）'
            : '该来源不支持删除';
      }

      Util.$('#lbPrev').classList.toggle('disabled', n <= 1);
      Util.$('#lbNext').classList.toggle('disabled', n <= 1);
      this.playBtn && this.playBtn.classList.toggle('disabled', n <= 1);

      // 清空旧图
      this.img.classList.remove('ld');
      this.img.removeAttribute('src');
      this.errBox.hidden = true;
      this.spin.classList.remove('hide');
      this._updateStripSel();
      this._checkStripEnd();

      if (meta.bad) { this._showErr(this._badReason(meta)); return; }

      const url = Thumbs.bigURL(meta);
      if (!url) { this._showErr('无法读取该文件'); return; }

      this.scale = 1; this.tx = 0; this.ty = 0; this.base = 1;
      this.img.style.transform = '';
      this.img.style.width = 'auto'; this.img.style.height = 'auto';
      this.img.onload = () => {
        if (!this.openFlag || this.meta !== meta) return;
        this.spin.classList.add('hide');
        this.nw = this.img.naturalWidth; this.nh = this.img.naturalHeight;
        meta.w = this.nw; meta.h = this.nh;
        Loader.recordDims(meta, this.nw, this.nh);
        // 尺寸交给 CSS（left/top:50% + translate(-50%,-50%)）居中，缩放只改 transform
        this.img.style.width = 'auto'; this.img.style.height = 'auto';
        this.img.classList.add('ld');
        this.fit(false);
        this._preloadNeighbors();
        this.countEl.textContent = n > 1
          ? `${this.i + 1} / ${n} · ${this.nw}×${this.nh}`
          : `${this.nw}×${this.nh}`;
        if (this.infoOn) this._renderInfo();
      };
      this.img.onerror = () => {
        if (!this.openFlag || this.meta !== meta) return;
        this._showErr('浏览器无法解码这张图片');
      };
      this.img.src = url;
    },

    /** 灯箱里「为什么打不开」的人话解释（P1-2：区分格式不支持 / 文件损坏 / 环境缺解码器） */
    _badReason(meta) {
      if (meta && meta.heic) {
        const st = global.Util && Util.heicStatus ? Util.heicStatus() : false;
        if (st === false) {
          return '本机缺少 HEIC/HEIF 解码器。换一台支持 HEVC 的机器、'
            + '或在系统里安装「HEVC 视频扩展」后即可正常浏览。';
        }
        return 'HEIC/HEIF 解码失败，文件可能已损坏。';
      }
      return '格式不受支持或文件已损坏。';
    },

    _showErr(msg) {
      this.spin.classList.add('hide');
      this.img.classList.remove('ld');
      this.img.removeAttribute('src');
      this.errBox.hidden = false;
      Util.$('#lbErrName').textContent = this.meta.name;
      const why = Util.$('#lbErrWhy');
      if (why) why.textContent = msg ? '（' + msg + '）' : '';
    },

    /* ---------- 切换与预载 ---------- */
    nav(delta) {
      const n = this.list.length;
      if (n <= 1) return;
      this.i = (this.i + delta + n) % n;
      this.meta = this.list[this.i];
      this.render();
    },

    /** 当前项已被删除：从快照移除并切到下一张（无剩余则关闭） */
    dropCurrent(meta) {
      const idx = this.list.indexOf(meta);
      if (idx < 0) return;
      this.list.splice(idx, 1);
      // 同步移除缩略图条中对应的一项（保持 children 索引与 list 对齐）
      const el = this.strip.children[idx];
      if (el && el.parentNode) el.parentNode.removeChild(el);
      if (!this.list.length) { this.close(); return; }
      if (this.list.length < 2) this.stripBtn.classList.add('disabled');
      this.i = idx < this.list.length ? idx : 0;  // 顺位显示“下一张”，末位则回到首张
      this.meta = this.list[this.i];
      this.render();
    },

    _preloadNeighbors() {
      for (const d of [1, -1, 2, -2]) {
        const m = this.list[this.i + d];
        if (m) Thumbs.preloadBig(m);
      }
    },

    /* ---------- 缩放（居中 + 尽量放大整张可见） ---------- */
    BOX_L() { return 64; },
    /** 是否处于全屏：全屏时图片贴边最大化，不留控件留白 */
    isFs() { return !!(this.el && document.fullscreenElement === this.el); },
    /** 可用区右边界：打开信息面板时让出右侧区域 */
    availX1() {
      if (this.isFs()) return global.innerWidth;   // 全屏：贴到右边缘
      return Math.max(200, global.innerWidth - 56 - (this.infoOn ? INFO_W + 30 : 0));
    },
    availW() {
      if (this.isFs()) return Math.max(140, global.innerWidth);  // 全屏：占满整宽
      return Math.max(140, this.availX1() - this.BOX_L());
    },
    availH() {
      if (this.isFs()) return Math.max(160, global.innerHeight); // 全屏：占满整高
      return Math.max(160, global.innerHeight - 150);
    },

    /**
     * 舞台几何（用于定位/居中的基准矩形）。
     * 全屏时即整个视口（图片贴边最大化）；常规时沿用 .lb-stage 实测矩形。
     */
    _stageGeom() {
      if (this.isFs()) {
        const w = global.innerWidth, h = global.innerHeight;
        return { x: w / 2, y: h / 2, w, h, left: 0, top: 0 };
      }
      const r = this.stage && this.stage.getBoundingClientRect ? this.stage.getBoundingClientRect() : null;
      const w = (r && r.width) || global.innerWidth;
      const h = (r && r.height) || global.innerHeight;
      // left/top：舞台左上角在视口里的位置。图片的包含块就是它，而 CSS transform
      // 以包含块左上角为原点 —— 所以 apply() 必须把这两个值交给 computeTransform，
      // 否则舞台一旦不与视口原点重合（Windows 标题栏把灯箱下压 34px），图片整体偏掉。
      return { x: (r ? r.left : 0) + w / 2, y: (r ? r.top : 0) + h / 2, w, h,
               left: (r ? r.left : 0), top: (r ? r.top : 0) };
    },

    /** 舞台中心 —— 一切居中计算的基准 */
    _stageC() { const g = this._stageGeom(); return { x: g.x, y: g.y }; },

    fit(animate) {
      if (!this.nw || !this.nh) return;
      const b = this._baseSize();
      // 「适应」缩放：旋转 90°/270° 时长宽互换（由 Transform 内部处理）
      this.base = T.fitScale({
        baseW: b.w, baseH: b.h, rot: this.rot,
        availW: this.availW(), availH: this.availH(),
        min: 0.05, max: MAX_FIT,
      });
      this.scale = this.base;
      // 重置平移量：图片中心与舞台中心重合 → 上下左右都居中（旋转任意角度亦然）
      this.tx = 0;
      this.ty = 0;
      if (animate) this.img.classList.add('anim');
      this.apply();
      if (animate) setTimeout(() => this.img.classList.remove('anim'), 200);
    },

    /**
     * 以视口坐标 (cx,cy) 为不动点缩放（数学见 Transform.zoomAt）。
     */
    zoomAt(f, cx, cy) {
      if (!this.nw) return;
      const c = this._stageC();
      const r = T.zoomAt(
        { scale: this.scale, tx: this.tx, ty: this.ty },
        { f: f, cx: cx, cy: cy, stageCx: c.x, stageCy: c.y, min: this.base * 0.25, max: MAX_SCALE }
      );
      if (!r.changed) return;
      this.scale = r.scale; this.tx = r.tx; this.ty = r.ty;
      this._clampPan();   // 缩小时自动回正：一旦装得下就平滑归中，不会停在半空
      this.apply();
    },

    /**
     * 当前图片的「1× 基准尺寸」（未缩放的布局尺寸）。
     * 用 offsetWidth/offsetHeight 而非 getBoundingClientRect：后者含 scale，
     * 会把缩放重复计入。
     */
    _baseSize() {
      const w = this.img.offsetWidth || this.nw || 0;
      const h = this.img.offsetHeight || this.nh || 0;
      return { w, h };
    },

    /** 把纯几何层算出的 transform 串写入 DOM（定位/旋转/缩放数学全部在 Transform 中） */
    apply() {
      const b = this._baseSize();
      const g = this._stageGeom();
      const t = T.computeTransform({
        baseW: b.w, baseH: b.h, scale: this.scale, rot: this.rot,
        tx: this.tx, ty: this.ty, stageCx: g.x, stageCy: g.y,
        originX: g.left, originY: g.top,   // 舞台原点：transform 是相对包含块左上角的
      });
      this.img.style.transform = t.transform;
      this._updPct();
    },

    /** 当前图片显示中心（舞台坐标系）；未平移时即舞台中心 */
    _center() {
      const g = this._stageGeom();
      return { x: g.x + this.tx, y: g.y + this.ty };
    },

    /** 当前旋转后图片占用的显示包围盒（与 apply 同源：_baseSize） */
    _imgRect() {
      const b = this._baseSize();
      const g = this._stageGeom();
      return T.displayBox({
        baseW: b.w, baseH: b.h, scale: this.scale, rot: this.rot,
        tx: this.tx, ty: this.ty, stageCx: g.x, stageCy: g.y,
      });
    },

    /** 图片是否大于舞台（任一边超出）。仅用于状态判断，不作拖动门槛 */
    _canPan() {
      if (!this.nw) return false;
      const g = this._stageGeom();
      return T.canPan(this._imgRect(), g.w, g.h);
    },

    /* ---------- 旋转 ---------- */
    rotate(dir) {
      if (!this.openFlag || !this.nw) return;
      const next = (this.rot + dir * 90 + 360) % 360;
      // P1-4：写回状态层（按文件路径持久化），下次打开仍是这个朝向
      if (this.meta && State.setRotation) State.setRotation(this.meta, next);
      this.rot = State.rotationOf && this.meta ? State.rotationOf(this.meta) : next;
      // 旋转后按新朝向重新“适应”，保证整图可见且严格居中（fit 会复位平移量）
      this.img.classList.add('anim');
      this.fit(false);
      setTimeout(() => this.img.classList.remove('anim'), 200);
      if (this._hintRot !== this.rot) {
        this._hintRot = this.rot;
        if (global.App && App.toast) App.toast(this.rot ? `已旋转 ${this.rot}°（已记住）` : '已恢复原始朝向');
      }
    },

    /** 清除当前图片的旋转记录（快捷键 Shift+R），回到原始朝向 */
    resetRot() {
      if (!this.openFlag || !this.nw || !this.meta) return;
      if (!State.rotationOf(this.meta)) return;
      State.setRotation(this.meta, 0);
      this.rot = 0;
      this._hintRot = -1;
      this.img.classList.add('anim');
      this.fit(false);
      setTimeout(() => this.img.classList.remove('anim'), 200);
      if (global.App && App.toast) App.toast('已恢复原始朝向');
    },

    /* ---------- 滚轮功能切换（缩放 / 切换图片） ---------- */
    toggleWheel() {
      this.wheelMode = this.wheelMode === 'zoom' ? 'nav' : 'zoom';
      this._setWheelUI();
    },
    _setWheelUI() {
      if (!this.wheelBtn) return;
      const nav = this.wheelMode === 'nav';
      this.wheelBtn.innerHTML = Util.icon(nav ? 'i-arrows-h' : 'i-wheel');
      this.wheelBtn.title = nav
        ? '滚轮：切换上/下一张（点击切换为缩放）'
        : '滚轮：缩放图片（点击切换为切换图片）';
      this.wheelBtn.setAttribute('aria-label', nav ? '滚轮模式：切换图片' : '滚轮模式：缩放');
      this.wheelBtn.classList.toggle('is-on', nav);
    },

    toggleScale(e) {
      const cx = e ? e.clientX : global.innerWidth / 2;
      const cy = e ? e.clientY : global.innerHeight / 2;
      if (this.scale > this.base * 1.02) { this.fit(true); return; }
      if (this.base > 1) {
        // 放大态“适应(最大)” 与 原始 100% 之间切换
        const cur1 = Math.abs(this.scale - 1) < 0.02;
        const t = cur1 ? this.base : 1;
        this.zoomAt(t / this.scale, cx, cy);
      } else {
        const target = Math.max(1, this.base * 2);
        this.zoomAt(target / this.scale, cx, cy);
      }
    },

    _updPct() {
      this.pctEl.textContent = Math.round(this.scale * 100) + '%';
    },

    /**
     * 把平移量夹回合法范围（约束数学见 Transform.clampPan）。
     * freeLimit = 半屏：小图可自由拖动，但不会被拖出视野。
     */
    _clampPan() {
      if (!this.nw) return;
      const g = this._stageGeom();
      const r = T.clampPan(
        { tx: this.tx, ty: this.ty },
        { box: this._imgRect(), stageW: g.w, stageH: g.h, freeLimit: global.innerHeight * 0.5 }
      );
      this.tx = r.tx; this.ty = r.ty;
    },

    /* ---------- 指针交互 ---------- */
    _pd(e) {
      if (e.button !== 0) return;
      this.dragging = true; this.moved = false;
      this.lastX = e.clientX; this.lastY = e.clientY;
      if (this.img.setPointerCapture) {
        try { this.img.setPointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
      }
      // 任意倍率都可拖动：光标准确反馈为「抓取」态
      this.stage.classList.add('grabbing');
      e.preventDefault();
    },
    _pm(e) {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX, dy = e.clientY - this.lastY;
      this.lastX = e.clientX; this.lastY = e.clientY;
      if (Math.abs(dx) + Math.abs(dy) > 2) this.moved = true;
      this.tx += dx; this.ty += dy;
      this._clampPan();
      this.apply();
    },
    _pu() {
      if (!this.dragging) return;
      this.dragging = false;
      this.stage.classList.remove('grabbing');
    },
    _wheel(e) {
      if (!this.openFlag) return;
      e.preventDefault();
      // 触控板双指捏合：浏览器会把捏合手势合成为「带 ctrlKey 的 wheel 事件」。
      // 捏合在任何滚轮模式下都应当是缩放（它是明确的缩放手势，不该被 nav 模式劫持）。
      // 用指数映射保证连续、平滑，并按事件夹取幅度以防设备给出极端 delta。
      if (e.ctrlKey) {
        const k = Math.exp(-e.deltaY * 0.012);
        this.zoomAt(Util.clamp(k, 0.6, 1.67), e.clientX, e.clientY);
        return;
      }
      if (this.wheelMode === 'nav') {
        if (this.list.length < 2) return;
        this.nav(e.deltaY < 0 ? -1 : 1);
      } else {
        this.zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
      }
    },

    /* ---------- 触摸屏双指缩放 ---------- */
    _pinchDist(t) {
      const dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    },
    _pinchMid(t) {
      return { x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 };
    },
    _tstart(e) {
      if (!this.openFlag) return;
      if (e.touches.length === 2) {
        // 第二根手指落下：立刻中止可能已开始的单指拖动，改走双指缩放
        this.dragging = false;
        this.stage.classList.remove('grabbing');
        this._pinch = this._pinchDist(e.touches);
        e.preventDefault();
      }
    },
    _tmove(e) {
      if (!this.openFlag || e.touches.length !== 2 || !this._pinch) return;
      e.preventDefault();
      const d = this._pinchDist(e.touches);
      if (!d) return;
      const k = d / this._pinch;
      this._pinch = d;
      // 与捏合中心为不动点，手指下的内容保持不动（复用同一条 zoomAt 公式）
      const c = this._pinchMid(e.touches);
      this.zoomAt(Util.clamp(k, 0.5, 2), c.x, c.y);
    },
    _tend(e) {
      if (!e.touches || e.touches.length < 2) this._pinch = 0;
    },

    /* ---------- 沉浸式活动检测（光标 / 控件显现与自动隐藏） ---------- */
    _fsActivity(e) {
      if (!this.openFlag) return;
      const el = this.el;
      el.classList.remove('fs-idle');
      if (e) {
        const W = global.innerWidth, H = global.innerHeight;
        const x = e.clientX, y = e.clientY;
        // 仅当鼠标位于对应热区时才显现该处控件（其余保持隐藏，只留图片）
        el.classList.toggle('fs-top', y <= 96);                       // 顶部：关闭
        el.classList.toggle('fs-left', x <= 112 && y > 96);           // 左侧：上一张
        el.classList.toggle('fs-right', x >= W - 112 && y > 96);      // 右侧：下一张
        el.classList.toggle('fs-bottom', y >= H - 160);               // 底部：信息条 + 操作栏
      }
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => el.classList.add('fs-idle'), this.IDLE_MS);
    },

    /* ---------- 收藏 ---------- */
    toggleFav() {
      const on = State.toggleFav(this.meta.id);
      this.favBtn.classList.toggle('is-fav', on);
      this.favBtn.innerHTML = Util.icon(on ? 'i-star-fill' : 'i-star');
      this._updateStripSel();
      this._checkStripEnd();
    },

    /* ---------- 信息面板 ---------- */
    toggleInfo() {
      if (!this.openFlag) return;
      this.infoOn = !this.infoOn;
      if (this.infoPane) this.infoPane.hidden = !this.infoOn;
      this.el.classList.toggle('with-info', this.infoOn);
      if (this.infoBtn) {
        this.infoBtn.classList.toggle('is-on', this.infoOn);
        this.infoBtn.setAttribute('aria-pressed', String(this.infoOn));
      }
      if (this.infoOn) this._renderInfo();
      if (this.nw) this.fit(true);
    },

    _renderInfo() {
      const body = this.infoBody;
      const meta = this.meta;
      if (!body || !meta) return;

      if (!meta._exifP) {
        const p = meta.bad
          ? Promise.resolve(null)
          : global.Exif.parse(meta).catch(() => null);
        meta._exifP = p;
        p.then((r) => {
          meta._exif = r && r.ok ? r : null;
          if (this.infoOn && this.meta === meta) this._renderInfo();
        });
      }

      const dim = (meta.w && meta.h)
        ? meta.w + ' × ' + meta.h + ' px'
        : (meta._exif && meta._exif.pxW ? meta._exif.pxW + ' × ' + meta._exif.pxH + ' px' : '读取中…');
      const rows = [];
      rows.push(['文件', meta.name]);
      rows.push(['尺寸', dim]);
      rows.push(['大小', Util.fmtBytes(meta.size)]);
      if (meta.lastModified) rows.push(['修改时间', Util.fmtDate(meta.lastModified)]);
      const ex = meta._exif;
      if (ex) {
        if (ex.ts) rows.push(['拍摄时间', Util.fmtDate(ex.ts)]);
        const cam = [ex.make, ex.model].filter(Boolean).join(' ');
        if (cam) rows.push(['相机', cam]);
        if (ex.lens) rows.push(['镜头', ex.lens]);
        const par = [];
        if (ex.focal) par.push(this._fmtFocal(ex.focal));
        if (ex.fnum) par.push('ƒ/' + this._fmtNum(ex.fnum, 1));
        if (ex.exposure) par.push(this._fmtExp(ex.exposure));
        if (ex.iso) par.push('ISO ' + ex.iso);
        if (par.length) rows.push(['曝光', par.join(' · ')]);
        if (ex.gps) rows.push(['位置', ex.gps.lat.toFixed(6) + ', ' + ex.gps.lon.toFixed(6)]);
      }
      let html = '<h4>图片信息</h4>';
      for (const [k, v] of rows) {
        html += '<div class="lb-info-row"><span class="lb-info-k">' + Util.esc(k) + '</span><span class="lb-info-v">' + Util.esc(String(v)) + '</span></div>';
      }
      if (!ex) {
        const note = meta._exifP
          ? '该文件不含可读的 EXIF 元数据'
          : '正在读取元数据…';
        html += '<div class="lb-info-note">' + note + '</div>';
      }
      body.innerHTML = html;
    },

    _fmtNum(v, dp) {
      const f = Number(v);
      if (!isFinite(f)) return '';
      const s = f.toFixed(dp);
      return s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
    },
    _fmtFocal(v) { return this._fmtNum(v, 1) + ' mm'; },
    _fmtExp(s) {
      if (!(s > 0)) return '';
      const inv = 1 / s;
      const r = Math.round(inv);
      if (Math.abs(inv - r) < 0.02 && r <= 4000) return '1/' + r + ' s';
      return (s >= 10 ? Math.round(s) : Math.round(s * 100) / 100) + ' s';
    },

    /* ---------- 缩略图条 ---------- */
    _buildStrip() {
      this.strip.textContent = '';
      const n = this.list.length;
      if (n < 2) { this.stripBtn.classList.add('disabled'); return; }
      this.stripBtn.classList.remove('disabled');
      // 超长列表条带截断，保证打开开销可接受
      const shown = Math.min(n, 1200);
      for (let k = 0; k < shown; k++) {
        const m = this.list[k];
        const b = document.createElement('button');
        b.className = 'lb-strip-item';
        b.setAttribute('aria-label', m.name);
        b.title = m.name;
        const ic = document.createElement('span');
        ic.className = 'tile-err-ic';
        ic.style.cssText = 'position:absolute;inset:0;margin:auto;width:15px;height:15px;';
        if (!m.bad) {
          const img = document.createElement('img');
          img.alt = '';
          img.loading = 'lazy';
          img.decoding = 'async';
          Thumbs.thumbURL(m, 148).then((url) => {
            if (url && b.isConnected) { img.src = url; ic.remove(); }
          });
          b.appendChild(img);
        }
        b.appendChild(ic);
        b.addEventListener('click', () => {
          this.i = k; this.meta = m; this.render();
          b.scrollIntoView({ inline: 'center', block: 'nearest', behavior: Util.scrollBehavior() });
        });
        b._idx = k;
        this.strip.appendChild(b);
      }
      this._updateStripSel();
      this._checkStripEnd();
    },

    _updateStripSel() {
      const items = this.strip.children;
      for (let k = 0; k < items.length; k++) {
        const el = items[k];
        el.classList.toggle('is-cur', k === this.i);
        const m = this.list[k];
        el.classList.toggle('is-fav', !!m && State.isFav(m.id));
      }
      const cur = items[this.i];
      if (cur && this.openFlag && this.strip.hidden === false) cur.scrollIntoView({ inline: 'center', block: 'nearest', behavior: Util.scrollBehavior() });
    },

    toggleStrip() {
      this.stripOn = !this.stripOn;
      this.strip.hidden = !this.stripOn;
      this.el.classList.toggle('with-strip', this.stripOn);
      this.stripBtn.classList.toggle('is-on', this.stripOn);
      if (this.stripOn) { this._updateStripSel(); this._checkStripEnd(); }
    },

    /** 检测缩略图条是否滚到最右端，切换 strip-at-end 类 */
    _checkStripEnd() {
      const el = this.strip;
      if (!el || el.hidden) return;
      const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
      this.el.classList.toggle('strip-at-end', atEnd);
    },

    /* ---------- 键盘 ---------- */
    _key(e) {
      if (!this.openFlag) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      switch (e.key) {
        case 'ArrowLeft': case 'a': case 'A': e.preventDefault(); this.nav(-1); break;
        case 'ArrowRight': case 'd': case 'D': e.preventDefault(); this.nav(1); break;
        case ' ': e.preventDefault(); this.nav(1); break;
        case 'Escape': e.preventDefault(); this.close(); break;
        case 'f': case 'F': this.toggleFav(); break;
        case 'i': case 'I': this.toggleInfo(); break;
        case 'h': case 'H': this.toggleStrip(); break;
        case 'p': case 'P': this.togglePlay(); break;
        case 'r': case 'R': this.rotate(e.shiftKey ? -1 : 1); break;
        /* Delete / Backspace：删除当前这张。按钮的 title 一直写着「删除（Delete）」，
           但这里从来没有这个分支 —— 承诺的快捷键其实不存在。 */
        case 'Delete': case 'Backspace':
          e.preventDefault();
          if (this.onDelete && this.meta) this.onDelete(this.meta);
          break;
        case 'z': case 'Z': this.resetRot(); break;   // 清除这张图的旋转记录（P1-4）
        case 'w': case 'W': this.toggleWheel(); break;
        case '+': case '=': e.preventDefault(); { const c = this._center(); this.zoomAt(1.4, c.x, c.y); } break;
        case '-': case '_': e.preventDefault(); { const c = this._center(); this.zoomAt(1 / 1.4, c.x, c.y); } break;
        case '0': this.fit(true); break;
      }
    },
  };

  global.Lightbox = Lightbox;
})(window);
