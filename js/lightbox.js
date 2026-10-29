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
      /* 只有"打开灯箱"这一下淡入；切上一张/下一张不淡（见 render 里的 toggle）。
         180ms 的淡入叠在解码后面，每次切图都要多等小半秒。 */
      this._fadeIn = true;
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
      if (this._preT) { clearTimeout(this._preT); this._preT = 0; }
      if (this._spinT) { clearTimeout(this._spinT); this._spinT = 0; }
      if (this._settleT) { clearTimeout(this._settleT); this._settleT = 0; }
      if (this._stripT) { clearTimeout(this._stripT); this._stripT = 0; }
      this._stripOrder = null;
      this._stripSlots = null;
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
      /* 连翻判定：两次切图间隔 < 100ms 就算"在按住方向键"。
         Windows 的键盘重复是"约 500ms 后开始、每 ~33ms 一次"，所以按住时每次都在 33ms 上下；
         而人手动连点两下通常 200ms 以上 —— 100ms 这条线把两者分得很开。
         阈值不能取宽（试过 150ms）：一旦误判成连翻，铺上去的是占位小图，
         画面会先糊一下；而"糊一下"比"多等 100ms"更让人难受。 */
      const nowMs = (global.performance && performance.now) ? performance.now() : Date.now();
      const fast = nowMs - (this._navAt || 0) < 100;
      this._navAt = nowMs;
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

      /* ---- 切图时**留住上一帧**，不要先清空 ----
         从 v1.13.0 到 v1.20.5，每次切图都是先 `removeAttribute('src')` 再把 .ld 摘掉：
         屏幕立刻变空、转圈出现，130–300ms 之后新图才"啪"地出来。这段空白是最刺眼的
         "卡"—— 用户看不到任何进度，只觉得"按了没反应"。实测（真实 exe）这段空白和
         转圈加起来正好是 tPainted 的前半段，占了用户感知的一大半。

         现在改成：**不摘 .ld、不清 src**，让浏览器继续画旧帧，等新图解码好再换
         （Chromium 本来就是这个行为：新帧没准备好之前一直保留上一帧）。
         转圈也**延后 250ms** 才出现 —— 快的切图根本不该看到转圈。
         这一改不动解码时间，改的是"中间那段什么都没有"。

         **放大过的不走这条路**（scale≠1）：旧帧带着旧缩放，新图第一帧会先按旧缩放
         出现一下，看着像跳一下。缩放过就直接清空，和以前完全一样。 */
      const keepFrame = this.scale === 1 && !this._fadeIn
        && this.img.classList.contains('ld') && !!this.img.getAttribute('src');
      this.img.classList.toggle('fadein', !!this._fadeIn);
      this._fadeIn = false;
      this.errBox.hidden = true;
      if (this._spinT) { clearTimeout(this._spinT); this._spinT = 0; }
      if (keepFrame) {
        this._spinT = setTimeout(() => {
          this._spinT = 0;
          this.spin.classList.remove('hide');
        }, 250);
      } else {
        this.img.classList.remove('ld');
        this.img.removeAttribute('src');
        this.spin.classList.remove('hide');
      }
      if (this._preT) { clearTimeout(this._preT); this._preT = 0; }
      if (this._settleT) { clearTimeout(this._settleT); this._settleT = 0; }
      this._updateStripSel();
      this._checkStripEnd();

      if (meta.bad) { this._showErr(this._badReason(meta)); return; }

      /* ---- 按「屏幕尺寸」解码，而不是原图 ----
         灯箱按「自然尺寸 + transform 缩放」显示，6000×4000 的照片在窗口里实际只占
         938px，可浏览器必须先把整张 24MP 解出来才画得出第一帧。实测（真实 exe）：
         解 24MP 要 130ms、48MP 要 265ms，而且冷热一样慢 —— 这么大的位图留不住缓存，
         来回翻每次都重解。于是"切一张"要白等 150–300ms，表现就是转圈半天。
         先上一代屏幕尺寸的位图（同一套 createImageBitmap 降采样，2–15ms 就能显示），
         真要放大看 1:1 时再由 _upgradeToFull() 换回原图。
         这里用 token 兜住"晚到的结果"：快速连按下一张时，前一张的 promise 可能后到，
         不认 token 的话会把已经切走的那张又贴回来。 */
      this._full = false;
      this._rec = null;
      this._upgrading = false;
      const token = (this._renderToken = (this._renderToken || 0) + 1);
      const still = () => this.openFlag && this.meta === meta && token === this._renderToken;

      const start = (rec) => {
        if (!still()) return;
        const url = (rec && rec.url) || Thumbs.bigURL(meta);
        if (!url) { this._showErr('无法读取该文件'); return; }
        this._rec = rec || null;
        this.img.onload = () => {
          if (!still()) return;
          if (this._spinT) { clearTimeout(this._spinT); this._spinT = 0; }
          this.spin.classList.add('hide');
          this._adoptNatural(meta);
          /* 这张就是原图（没走代，或者代本来就跟原图一样大）→ 不必再"升级" */
          this._full = !rec || !!rec.full;
          // 尺寸交给 CSS（left/top:50% + translate(-50%,-50%)）居中，缩放只改 transform
          this.img.style.width = 'auto'; this.img.style.height = 'auto';
          this.img.classList.add('ld');
          this.fit(false);
          /* **停留 900ms 之后**才预取相邻图。
             为什么不在 onload 里立刻预取：生成一代要 170–900ms（等于把原图完整解一遍），
             而连续快翻时用户按下一张的间隔往往只有一两百毫秒 —— 立刻开工的话，它永远
             和"你正在等的那一帧"抢 CPU。实测（真实 exe，24MP）：立刻预取时首次显示
             188ms，延迟之后回到 89–130ms，也就是 v1.13.0 的水平（v1.13.0 没有任何预取）。
             阈值取 900ms 而不是 450ms：实测"每 0.5 秒翻一张"时，450ms 的预取正好卡在
             下一次切图中间，48MP 那张被拖到 378ms（v1.13.0 是 315ms）。900ms 之后，
             "翻得比这快"就等于完全不做预取（每一帧都是干净的原图解码，不吃亏），
             "停下来看"才把相邻两张备好 —— 而看照片本来就是停下来的场景。 */
          /* 连翻时铺上去的是**占位小图**（见下面 fast 分支），它只是一张过渡画面 ——
             为它去预取相邻两张纯属浪费，而且正好会在用户还在连翻的时候抢 CPU。
             真图到位后（settle 定时器重新 start）才会走到这里。 */
          if (!rec || !rec.thumb) {
            this._preT = setTimeout(() => {
              this._preT = 0;
              if (still()) this._preloadNeighbors();
            }, 900);
          }
          const dim = this.origW && this.origH ? `${this.origW}×${this.origH}` : '';
          this.countEl.textContent = n > 1
            ? `${this.i + 1} / ${n}${dim ? ' · ' + dim : ''}`
            : dim;
          if (this.infoOn) this._renderInfo();
        };
        this.img.onerror = () => {
          if (!still()) return;
          /* 占位小图的 blob URL 可能已被 LRU 回收（revoke）→ 别报"无法解码"，
             直接退回真图。真图也失败才报错。 */
          if (rec && rec.thumb) { start(null); return; }
          this._showErr('浏览器无法解码这张图片');
        };
        this.img.src = url;
      };

      this.scale = 1; this.tx = 0; this.ty = 0; this.base = 1;
      this.img.style.transform = '';
      this.img.style.width = 'auto'; this.img.style.height = 'auto';

      const cssW = this._needPx(meta);
      /* 代已备好 → 直接上（切图 2–15ms）；没备好 → **先上原图**，别让用户等生成。
         生成一代要 130–630ms（48MP 比直接解原图还贵），为了"用上代"先等这一段是本末倒置。
         原图先顶上，相邻两张的代在后台备着，下次翻过去/翻回来就都是 2ms 级了。
         **当前这张不生成代**：它已经在屏幕上了，此刻生成只会在你正等这一帧的时候抢 CPU
         —— 实测把 24MP 的首次显示从 89ms（v1.13.0 的水平）拖到 188ms、48MP 从 288ms 拖到 438ms。
         等真正空闲时再补（见下面的 idle 那一支），供下次翻回来用。 */
      const peek = Thumbs.screenPeek ? Thumbs.screenPeek(meta, cssW) : null;
      if (peek) {
        start(peek);
      } else if (fast) {
        /* ---- 按住方向键连翻：先上**占位小图**，停手后再上真图 ----
           为什么需要这一支（用户报"住方向键连翻慢"）：键盘重复是每 ~33ms 一次，
           而一张 24MP 要 130ms、48MP 要 245ms 才解完 —— 于是每按一次就把上一次
           还没解完的加载**掐掉**（换 src 就等于取消），一直掐到松手为止。
           结果就是：按住的时候屏幕基本不动，松手之后还要再等一次完整解码。
           实测（真实 exe、冷状态）：45 次 nav 里只有 30 次 load 真的完成，
           而且多数因为已经切走而没被显示；松手后还要 284ms 画面才更新。

           改法：连翻期间铺**缩略图**。条带（`_buildStrip`）在打开时就已经为每个条目
           解好了 320px 的缩略图，`thumbURL` 在内存里一命中就是微任务级 ——
           每按一次都能立刻看到下一张（糊，但认得出），不再有"按了没反应"。
           停手 140ms 后（`_settleT`）再换成真图，这一次是干净的、不被中途掐断的加载。

           注意用 148 而不是更大的宽度：`thumbURL` 会按 dpr 向上取档，
           148×2 → 320 档，正好是条带已经生成并落盘的那一档 —— 命中缓存，
           既不会重解，也不会为翻过的每一张多写一份缩略图到磁盘。

           **只用 peek，不等生成**（v1.20.8）：原来这里是 `await thumbURL(...)`，
           没命中就当场解码原图 + 缩放 + 编码（24MP 约 30–50ms、48MP 几百 ms）。
           等它 resolve 时用户往往已经又按了一下，`still()` 变假 → 这份工作**整个白做**，
           却实实在在抢了 CPU。实测 Downloads（15 张图）连翻 45 次 miss 了 25 次，
           全是白干，而 miss 期间屏幕什么也没变 —— 这正是"快速切换很慢"的直接来源。
           现在没命中就退回原图：小图（≤2MP）解原图只要 10–20ms，比现场生成缩略图
           更快，画面还更清晰（不再是一张糊的 320px）。 */
        const peekThumb = Thumbs.thumbPeek ? Thumbs.thumbPeek(meta, 148) : null;
        /* 小图**不铺缩略图**，直接解原图。
           这是 v1.20.8 针对"Downloads 里都是小图却还嫌慢"改的：
           铺缩略图的代价不是解码，而是**用户看到的是"先糊、140ms 后才清晰"**——
           本来一张 1.8MP 的图解码只要 13ms、画面一直是清晰的，非要先糊一下反而更难受。
           判据用 4MP：4MP 解码约 20–30ms，能跟上 33ms 的按键节奏，清晰度还保住了。
           超过 4MP（12/24/48MP）才值得用缩略图顶 —— 那些图解码要 65–260ms，
           不铺的话按住方向键时屏幕会一直不动。 */
        const mp = (meta.w > 0 && meta.h > 0) ? (meta.w * meta.h) : 0;
        const small = mp > 0 && mp <= 4e6;
        if (peekThumb && !small) {
          start({
            url: peekThumb, side: 0, w: 0, h: 0,
            tw: meta.w > 0 ? meta.w : 0, th: meta.h > 0 ? meta.h : 0,
            full: false, thumb: true,
          });
        } else {
          /* 没有现成的缩略图（或者本身就是小图）→ 直接解原图。
             **不要**在这里 await 生成缩略图：生成一份要 30–600ms，
             而按住方向键时下一次按键 33ms 后就来，生成完也没人用得上。 */
          start(null);
        }
        this._settleT = setTimeout(() => {
          this._settleT = 0;
          if (!still()) return;
          if (this._rec && !this._rec.thumb) return;   // 已经是真图了，别重来
          start(Thumbs.screenPeek ? Thumbs.screenPeek(meta, cssW) : null);
        }, 140);
      } else {
        start(null);
      }
      /* 当前这张**不生成代**，一个定时器都不留。
         试过"等空闲再生成"（requestIdleCallback）：它会在页面一闲下来的**下一帧**
         就触发，等于什么都没等 —— 实测切图后 250ms 内就抢着开工了。
         也没必要：`_preloadNeighbors` 已经把上一张/下一张都备好了，
         用户回头翻必然经过它们；单张文件夹本来也不需要代。 */
    },

    /**
     * 这张图"实际会占多少 CSS 像素宽" —— 用来决定解码多大的代。
     * 不能拿舞台宽度了事：横图在横屏里是**高度**先撞线（844×563 的框，舞台却有 1300 宽），
     * 按 1300 取档会白算近一倍像素（实测多花 40ms/张）。
     */
    _needPx(meta) {
      const aw = (this.availW ? this.availW() : 0) || global.innerWidth;
      const ah = (this.availH ? this.availH() : 0) || global.innerHeight;
      const w = (meta && meta.w > 0) ? meta.w : 0;
      const h = (meta && meta.h > 0) ? meta.h : 0;
      if (!w || !h) return Math.max(320, Math.min(aw, ah) * 1.6);
      // 旋转 90°/270° 时长宽互换
      const ar = (this.rot % 180 === 0) ? (w / h) : (h / w);
      return Math.max(320, Math.min(aw, ah * ar));
    },

    /**
     * 记下当前这张图的尺寸。
     * 关键：屏幕上那张**可能是缩小过的"代"**，它的 naturalWidth 绝不是原图尺寸 ——
     * 直接写进尺寸库会污染网格（thumbURL 那边专门为此加了 `res.tw !== res.dw` 判断）。
     * 所以原图尺寸优先取 rec.tw/th（解码时顺手探到的），其次 meta.w/h，最后才退回 naturalWidth。
     */
    _adoptNatural(meta) {
      const rec = this._rec;
      const natW = this.img.naturalWidth, natH = this.img.naturalHeight;
      this.nw = natW; this.nh = natH;
      /* 已知的原图尺寸：解码时探到的 → 条目里记着的 → 都拿不到就**留空**。
         绝不能在这里退回 naturalWidth —— 屏幕上那张可能是 2560 宽的"代"，
         一旦把它的尺寸写进 meta.w，网格的尺寸显示与尺寸库就永久错了
         （而且下次再算"代"时会按错的尺寸算缩放比）。 */
      const knownW = (rec && rec.tw) || (meta.w > 0 ? meta.w : 0) || 0;
      const knownH = (rec && rec.th) || (meta.h > 0 ? meta.h : 0) || 0;
      const isFull = !rec || rec.full;
      this.origW = knownW || (isFull ? natW : 0);
      this.origH = knownH || (isFull ? natH : 0);
      if (isFull) {
        meta.w = natW; meta.h = natH;
        Loader.recordDims(meta, natW, natH);
      } else if (knownW > 0 && knownH > 0) {
        meta.w = knownW; meta.h = knownH;
        Loader.recordDims(meta, knownW, knownH);
      }
    },

    /**
     * 把"代"换成原图（只在用户放大到超过代的 1:1 时才调）。
     * 换 src 期间浏览器会一直显示旧帧，所以画面不闪；
     * 换完按 oldNat/newNat 等比缩小 scale 与 base，屏幕上尺寸分毫不动。
     */
    _upgradeToFull() {
      const meta = this.meta;
      if (!meta || this._full || this._upgrading || !this.nw) return;
      const url = Thumbs.bigURL(meta);
      if (!url) return;
      const oldNat = this.nw, oldScale = this.scale, oldBase = this.base;
      const prev = this.img.onload;
      this._upgrading = true;
      this.img.onload = () => {
        this.img.onload = prev;
        this._upgrading = false;
        if (!this.openFlag || this.meta !== meta) return;
        const newNat = this.img.naturalWidth;
        if (!newNat || !oldNat) return;
        const k = oldNat / newNat;
        this.nw = newNat; this.nh = this.img.naturalHeight;
        this.origW = newNat; this.origH = this.nh;
        this.scale = oldScale * k;
        this.base = oldBase * k;
        this._full = true;
        this._rec = null;
        if (Loader && Loader.recordDims) Loader.recordDims(meta, newNat, this.nh);
        this.apply();          // 只重算 transform：不动类名、不动 src 之外的东西 → 视觉零跳变
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
      /* 转圈是**延后**出现的（见 render 里 keepFrame 的注释），
         这里必须把那个定时器撤掉，否则报错 250ms 后转圈又冒出来盖住错误提示。 */
      if (this._spinT) { clearTimeout(this._spinT); this._spinT = 0; }
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

    /**
     * 打开灯箱时**不要**预取附近几张的代 —— 试过，退化了。
     *
     * 想法很自然："用户快速切换时不停留，900ms 的停留预取触发不了，那就打开时就备好"。
     * 实测（v1.20.8，Downloads 15 张，冷连翻 45 次按键）：
     *   不预取 → 画面变化 32/45，松手后清晰 381ms
     *   ±3 预取 → 画面变化 22/45，松手后清晰 288ms
     * 也就是**按住时的跟手程度掉了三成**，换来的只是松手后快 90ms。
     * 而用户报的就是"快速切换慢"，按住时动不动才是他的痛点 —— 所以这条回退了。
     *
     * 这是 v1.20.5 同一个坑的第二次：**任何后台解码都会和"你正在等的那一帧"抢 CPU**，
     * 包括 requestIdleCallback（页面在连翻时并不空闲，它照样会插进来）。
     * 以后想"提前备好"之前，先量 `paints`（按住时画面变化次数），别只看松手后的耗时。
     */
    _preloadNeighbors() {
      /* 只预取紧邻的两张（上一张/下一张），不再管 ±2：
         生成一代是**重活**（24MP 约 170ms、48MP 能到 900ms 以上），同时铺开四张会把
         CPU 抢爆 —— 实测 48MP 那张从 365ms 涨到 971ms，还会把正在显示的原图读盘拖慢 6 倍。
         紧邻两张已经覆盖"连续翻页"这个主场景，隔一张的那步退回原图即可（和旧版一样快）。

         两张还分先后：**下一张**最可能是用户马上要的，排前面；上一张等空闲再备。
         `Thumbs.preloadScreen` 内部还有一条串行链，保证同一时刻只生成一代 ——
         否则两张并发同样会压到"正在等的那一帧"上。

         **必须环绕**（v1.20.9）。`nav()` 是 `(i + delta + n) % n`，在最后一张按"下一张"
         会回到第 0 张；这里原来直接取 `list[i + 1]`，在最后一张拿到 undefined 就什么
         也不做 —— 于是"第二轮"的第一张（第 0 张）从来没被预取过，而它多半已经被
         `screens` 那个 8 槽 LRU 淘汰，绕回去时只能整张解原图。
         实测（12 张 24MP、每张停 3 秒、连走两圈，两次复现）：
           普通切一张    peek=Y/1920  解 9–16ms
           绕回第 0 张   peek=N       解 144.6 / 147.6ms（natW=6000，真解原图）
         差一个数量级，而且正好落在"第二轮"的起点上 —— 用户说的"第二轮打开就很慢"
         就是这一下。预取这一步只要 3 秒，远比"停下来才补"划算。 */
      const n = this.list.length;
      if (n < 2) return;
      const ni = (this.i + 1) % n;
      const pi = (this.i - 1 + n) % n;
      const next = this.list[ni];
      const prev = this.list[pi];
      if (next && ni !== this.i) Thumbs.preloadScreen(next, this._needPx(next), true);
      /* pi === ni 只会在 n === 2 时发生（上一张和下一张是同一张），别预取两遍。 */
      if (prev && pi !== this.i && pi !== ni) Thumbs.preloadScreen(prev, this._needPx(prev), false);
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
      /* 放大到超过"代"的 1:1（scale > 1，即一个代像素要铺到一个以上 CSS 像素）时
         画面开始靠插值撑大，这时才去取原图。换 src 期间旧帧继续显示，
         换完按比例补偿 scale，屏幕上尺寸分毫不动（见 _upgradeToFull）。 */
      if (!this._full && this.scale > 1.02) this._upgradeToFull();
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
      const one = this._oneToOne();
      if (this.base > one) {
        // 图比舞台小：适应时已经被放大（base 超过 1:1）→ 在「适应」与「100%」之间切换
        const cur1 = Math.abs(this.scale - one) < one * 0.02;
        const t = cur1 ? this.base : one;
        this.zoomAt(t / this.scale, cx, cy);
      } else {
        const target = Math.max(one, this.base * 2);
        this.zoomAt(target / this.scale, cx, cy);
      }
    },

    _updPct() {
      /* 百分比一律相对**原图**：屏幕上那张可能是缩小过的"代"，
         直接拿 scale 报数会在换原图时突然从 49% 跳到 16%。 */
      const k = this.origW && this.nw ? this.nw / this.origW : 1;
      this.pctEl.textContent = Math.round(this.scale * k * 100) + '%';
    },

    /** 「原图 1:1」对应的 scale（屏幕上那张是缩小代时要放大 origW/nw 倍） */
    _oneToOne() { return this.origW && this.nw ? this.origW / this.nw : 1; },

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
      if (this._stripT) { clearTimeout(this._stripT); this._stripT = 0; }
      const n = this.list.length;
      if (n < 2) { this.stripBtn.classList.add('disabled'); this._stripSlots = null; return; }
      this.stripBtn.classList.remove('disabled');
      // 超长列表条带截断，保证打开开销可接受
      const shown = Math.min(n, 1200);
      /* 分两段：先**同步**把 DOM 建完（很快，纯 createElement），
         缩略图另外**分批**填 —— 原来是一个循环里直接调 1200 次 `thumbURL`，
         等于打开灯箱的瞬间同时发起 1200 份「解码原图 + 缩放 + 编码」，
         把主线程和 CPU 一起打满，紧接着的第一次切图就被拖慢（v1.20.8）。 */
      const slots = new Array(shown);
      for (let k = 0; k < shown; k++) {
        const m = this.list[k];
        const b = document.createElement('button');
        b.className = 'lb-strip-item';
        b.setAttribute('aria-label', m.name);
        b.title = m.name;
        const ic = document.createElement('span');
        ic.className = 'tile-err-ic';
        ic.style.cssText = 'position:absolute;inset:0;margin:auto;width:15px;height:15px;';
        let img = null;
        if (!m.bad) {
          img = document.createElement('img');
          img.alt = '';
          img.loading = 'lazy';
          img.decoding = 'async';
          b.appendChild(img);
        }
        b.appendChild(ic);
        b.addEventListener('click', () => {
          this.i = k; this.meta = m; this.render();
          b.scrollIntoView({ inline: 'center', block: 'nearest', behavior: Util.scrollBehavior() });
        });
        b._idx = k;
        this.strip.appendChild(b);
        slots[k] = { b: b, ic: ic, img: img, m: m };
      }
      this._stripSlots = slots;
      /* 填充顺序：**当前这张和它的邻居先来**，然后向两侧展开。
         用户打开灯箱第一眼看的是当前张，接着最可能按下一张 —— 让这些先出图，
         远处的等有空再说。 */
      const order = [];
      const seen = new Set();
      const push = (k) => {
        if (k >= 0 && k < shown && !seen.has(k)) { seen.add(k); order.push(k); }
      };
      push(this.i);
      for (let d = 1; d < shown; d++) { push(this.i + d); push(this.i - d); }
      this._stripOrder = order;
      this._updateStripSel();
      this._checkStripEnd();
      this._fillStrip(0);
    },

    /** 分批填条带缩略图：每批 6 张，填完让出主线程再填下一批 */
    _fillStrip(pos) {
      const order = this._stripOrder, slots = this._stripSlots;
      if (!order || !slots) return;
      const end = Math.min(pos + 6, order.length);
      for (let p = pos; p < end; p++) {
        const s = slots[order[p]];
        if (!s || !s.img || s.filled) continue;
        s.filled = true;
        Thumbs.thumbURL(s.m, 148).then((url) => {
          if (url && s.b.isConnected) { s.img.src = url; s.ic.remove(); }
        }).catch(() => {});
      }
      if (end < order.length) {
        this._stripT = setTimeout(() => {
          this._stripT = 0;
          if (this.openFlag) this._fillStrip(end);
        }, 0);
      }
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
