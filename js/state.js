/* ============================================================
   Atrium · state.js
   全局状态 / 四种浏览模式常量 / 多文件夹来源 / 收藏(localStorage)
   / 事件总线 / viewList
   ============================================================ */
(function (global) {
  'use strict';

  const LS = global.localStorage;
  const favLSKey = 'viewfinder.favs.v1';
  const setLSKey = 'viewfinder.settings.v1';
  const rotLSKey = 'viewfinder.rot.v1';

  /* ---------- 浏览模式常量 ---------- */
  /** size 单位 px：网格为"瓦片宽"、瀑布流为"列宽"、单列为"整屏高度"（自动）。
      （ratioH / ratioLabel 是早期"固定比例瓦片"留下的字段，现已不再参与布局，
      仅保留形状以免打乱既有定义结构。）
      crop: 该模式走"等边方格 + 方形裁切"（见 grid.js 的 _layoutCells），
      与 medium 的"原比例行内自适应"是**两种视图**，不是同一套布局的两个尺寸档。 */
  const MODES = {
    small: {
      key: 'small', label: '小图网格', ratioH: 1, ratioLabel: '1:1',
      crop: true,
      // 方形裁切的边长区间。上限 200：再大就该用中图看原比例了，继续放大没有意义。
      range: [72, 200], def: 108,
    },
    medium: {
      key: 'medium', label: '中图网格', ratioH: 0.8, ratioLabel: '5:4',
      range: [160, 620], def: 248,
    },
    /* 瀑布流（v1.12.0）：列宽而非行高 —— 每行几张由列宽推出，故 range 是"列宽"的区间。
       下限 120 保证再窄也认得出内容；上限 420 之外一屏只剩一列，不如直接用单列模式。 */
    masonry: {
      key: 'masonry', label: '瀑布流', ratioH: null, ratioLabel: '列宽',
      range: [120, 420], def: 208,
    },
    single: {
      key: 'single', label: '单列整屏', ratioH: null,
      range: [260, 1500], def: null, // 单列已改为“整屏一张”，size 仅作历史兼容
    },
  };

  /* 顺序 = 顶栏图标顺序，也 = 键盘 1/2/3/4 的顺序（插在网格与单列之间最符合直觉：
     网格 → 瀑布流 → 单列，是"越来越自由"的递进） */
  const MODE_ORDER = ['small', 'medium', 'masonry', 'single'];

  /* ---------- 分页 ---------- */
  const PAGE_SIZES = [50, 100, 200, 500, 1000, 0]; // 0 = 全部
  const PAGE_DEFAULT = 100;

  /* ---------- 收藏 ---------- */
  function loadFavs() {
    try { const v = JSON.parse(LS.getItem(favLSKey) || '[]'); return new Set(Array.isArray(v) ? v : []); }
    catch (e) { return new Set(); }
  }
  const favs = loadFavs();
  function saveFavs() {
    try { LS.setItem(favLSKey, JSON.stringify(Array.from(favs))); } catch (e) { /* 容量满则忽略 */ }
  }

  /* ---------- 旋转（P1-4：按文件持久化，重开保持一致） ----------
     键取「文件绝对路径」优先（浏览器拖拽/文件框来源退化为 rel，再退化为 id）。
     值为 90/180/270 的整数度；0 度不入库，避免表里全是 0 的白占空间。
     容量上限 ROT_MAX：超过后按最久未旋转（Map 插入序）淘汰，防止 localStorage 膨胀。 */
  const ROT_MAX = 4000;
  function loadRots() {
    try {
      const v = JSON.parse(LS.getItem(rotLSKey) || '{}');
      if (!v || typeof v !== 'object') return new Map();
      const m = new Map();
      for (const k of Object.keys(v)) {
        const d = ((Math.round((v[k] || 0) / 90) * 90) % 360 + 360) % 360;
        if (d) m.set(k, d);
      }
      return m;
    } catch (e) { return new Map(); }
  }
  const rots = loadRots();
  let _rotTimer = 0;
  /** 立刻把旋转表落盘（合并写的定时器尚未触发时手动冲一次） */
  function flushRots() {
    if (_rotTimer) { global.clearTimeout(_rotTimer); _rotTimer = 0; }
    try {
      if (rots.size > ROT_MAX) {
        const drop = rots.size - ROT_MAX;
        let i = 0;
        for (const k of rots.keys()) { if (i++ >= drop) break; rots.delete(k); }
      }
      LS.setItem(rotLSKey, JSON.stringify(Object.fromEntries(rots)));
    } catch (e) { /* 容量满则忽略 */ }
  }
  /** 旋转落盘（合并写：连续点旋转按钮时不会每一下都序列化整表） */
  function saveRots() {
    if (_rotTimer) return;
    if (typeof global.setTimeout !== 'function') { flushRots(); return; }
    _rotTimer = global.setTimeout(flushRots, 400);
  }
  // 页面被关闭/隐藏时冲一次，避免「转完就关窗」丢掉最后那次旋转
  if (global.addEventListener) {
    global.addEventListener('pagehide', flushRots);
    global.addEventListener('beforeunload', flushRots);
  }
  function rotKeyOf(meta) {
    if (!meta) return '';
    return meta.path || meta.rel || meta.id || '';
  }

  /* ---------- 持久设置 ---------- */
  /** 设置默认值 —— 供 loadSettings 与「恢复默认」共用，避免两处漂移 */
  function defaults() {
    return {
      mode: 'medium',
      sizes: { small: MODES.small.def, medium: MODES.medium.def, masonry: MODES.masonry.def, single: null },
      sortKey: 'name', sortDir: 1,
      pageSize: PAGE_DEFAULT,
      blurPreview: false,      // 隐私模式：闭眼后全部图片模糊

      /* --- 外观 --- */
      theme: 'light',          // 'light' | 'dark' | 'auto'
      density: 'cozy',         // 'cozy' | 'compact'  网格间距/信息密度
      showNames: false,        // 网格是否显示文件名浮层
      showCnt: true,           // 来源行是否显示数量角标
      sidebarOpen: true,       // 左侧来源栏是否展开（收起后顶栏贴出当前来源名）

      /* --- 浏览行为 --- */
      wheelMode: 'zoom',       // 灯箱滚轮：'zoom' 缩放 | 'nav' 切换图片
      animOn: true,            // 图片切换/缩放动画
      stripAuto: false,        // 灯箱打开时自动展开底部缩略图条
      infoAuto: false,         // 灯箱打开时自动显示信息面板
      slideshowMs: 3800,       // 幻灯片间隔（毫秒）

      /* --- 隐私与数据 --- */
      confirmDelete: true,     // 删除前二次确认
      rememberLast: true,      // 记住上次的文件夹与浏览位置
      /* 启动时检查新版本。**默认关闭** —— 本应用默认不联网，
         这是唯一一个会主动出网的开关，必须由用户明确打开。
         打开后启动时会访问 GitHub 的公开版本接口（只读、不带任何本机信息）。 */
      updateCheck: false,

      /* --- 窗口（仅桌面版有效） --- */
      alwaysOnTop: false,      // 窗口置顶：始终浮在其它窗口之上

      /* --- 桌面集成（仅桌面版有效） --- */
      trayOn: true,            // 系统托盘图标（关掉则关闭窗口即退出）
      trayClose: false,        // 点关闭按钮时藏进托盘而不是退出
      hotkeyOn: false,         // 全局快捷键 Ctrl+Alt+A：随时把窗口叫到前台

      /* --- 相框模式（v1.11.0 起为正式功能，默认开启） --- */
      showFrame: true,         // 是否在顶栏显示相框入口（关掉时整组选项收起）
      frameSrc: 'all',         // 相册来源：'all' 全部 | 'fav' 只看收藏 | 某个来源 id
      frameMs: 6000,           // 每张停留时长（毫秒）
      frameFit: 'contain',     // 'contain' 适应窗口 | 'cover' 填满窗口（可能裁边）
      frameDock: 'none',       // 相框窗口贴到屏幕哪一条边：'none' | 'left' | 'right' | 'top' | 'bottom'
      frameDisplay: 'auto',    // 输出到哪一块屏幕：'auto' 跟随主窗口 | 屏幕 id（多显示器）
    };
  }

  function loadSettings() {
    const d = defaults();
    try {
      const v = JSON.parse(LS.getItem(setLSKey) || '{}');
      if (MODES[v.mode]) d.mode = v.mode;
      if (v.sizes) for (const k in d.sizes) if (typeof v.sizes[k] === 'number' && v.sizes[k] > 0) d.sizes[k] = v.sizes[k];
      if (v.sortKey) d.sortKey = v.sortKey;
      if (v.sortDir === 1 || v.sortDir === -1) d.sortDir = v.sortDir;
      if (PAGE_SIZES.indexOf(v.pageSize) >= 0) d.pageSize = v.pageSize;
      if (typeof v.blurPreview === 'boolean') d.blurPreview = v.blurPreview;

      if (v.theme === 'light' || v.theme === 'dark' || v.theme === 'auto') d.theme = v.theme;
      if (v.density === 'cozy' || v.density === 'compact') d.density = v.density;
      for (const k of ['showNames', 'showCnt', 'sidebarOpen', 'animOn', 'stripAuto', 'infoAuto', 'confirmDelete', 'rememberLast', 'alwaysOnTop', 'showFrame', 'trayOn', 'trayClose', 'hotkeyOn', 'updateCheck']) {
        if (typeof v[k] === 'boolean') d[k] = v[k];
      }
      if (v.wheelMode === 'zoom' || v.wheelMode === 'nav') d.wheelMode = v.wheelMode;
      if (typeof v.slideshowMs === 'number' && v.slideshowMs >= 1000 && v.slideshowMs <= 20000) d.slideshowMs = v.slideshowMs;

      if (typeof v.frameSrc === 'string' && v.frameSrc) d.frameSrc = v.frameSrc;
      if (typeof v.frameMs === 'number' && v.frameMs >= 1000 && v.frameMs <= 120000) d.frameMs = v.frameMs;
      if (v.frameFit === 'contain' || v.frameFit === 'cover') d.frameFit = v.frameFit;
      // 只接受四条边；'none' 是默认值，不必显式校验（非四条边的值一律当不贴边）
      if (v.frameDock === 'left' || v.frameDock === 'right' ||
          v.frameDock === 'top' || v.frameDock === 'bottom') d.frameDock = v.frameDock;
      // 屏幕 id 是不透明字符串，且**正常使用中就会失效**（拔掉外接屏、换显示器）。
      // 主进程侧有"找不到就回落到主窗口所在屏"的兜底，所以这里只挡住非字符串与空串。
      if (typeof v.frameDisplay === 'string' && v.frameDisplay) d.frameDisplay = v.frameDisplay;
    } catch (e) { /* 忽略 */ }
    if (!d.sizes.single) d.sizes.single = Math.round(global.innerHeight * 0.9);
    d.sizes.single = global.Util.clamp(d.sizes.single, MODES.single.range[0], MODES.single.range[1]);
    return d;
  }
  const settings = loadSettings();
  function saveSettings() {
    try { LS.setItem(setLSKey, JSON.stringify(settings)); } catch (e) { /* 忽略 */ }
  }

  /* ---------- 事件总线 ---------- */
  const bus = {};
  const Events = {
    on(ev, fn) { (bus[ev] = bus[ev] || []).push(fn); return fn; },
    off(ev, fn) { const a = bus[ev]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } },
    emit(ev, payload) {
      const a = bus[ev] || [];
      for (const fn of a.slice()) { try { fn(payload); } catch (e) { console.error('[state:emit]', ev, e); } }
    },
  };

  /* ---------- 来源索引与展示列表缓存 ----------
     v1.5.0 性能改进（P1-3）：
     原先 activeItems()/sourceCount() 每次都 O(n) 线性扫描全部条目，渲染来源 chip
     时更是 O(n × 来源数)；viewList() 每次筛选/排序全量重算 O(n log n)。
     万张规模下，切来源/输入过滤词会明显卡顿。

     现在：
     - bySid 维护 sid → 该来源条目数组（与 items 共享条目引用，只读使用）；
     - rev 记录「结构性变更」版本号，favRev 记录收藏变更版本号；
     - viewList() 以上述信号 + 筛选/排序条件做键做记忆化，输入不变直接复用结果。
     注意：viewList() 现在可能返回同一个数组引用，调用方只能读、不得原地修改。
     外部若原地改了会影响排序的字段（如 EXIF 的 shotTs），需调用 State.touch()。 */
  const bySid = new Map();
  const EMPTY = [];
  let rev = 0;
  let favRev = 0;

  function idxAdd(it) {
    if (!it || !it.sid) return;
    let a = bySid.get(it.sid);
    if (!a) { a = []; bySid.set(it.sid, a); }
    a.push(it);
  }
  function idxRemove(it) {
    if (!it || !it.sid) return;
    const a = bySid.get(it.sid);
    if (!a) return;
    const i = a.indexOf(it);
    if (i >= 0) a.splice(i, 1);
  }
  function idxRebuild() {
    bySid.clear();
    for (const it of State.items) idxAdd(it);
  }

  /* ---------- 状态 ---------- */
  let _srcSeq = 0;

  const State = {
    MODES, MODE_ORDER, PAGE_SIZES, PAGE_DEFAULT, bus: Events,

    items: [],            // 全量原始条目（跨所有已加载文件夹）
    sources: [],          // [{ id, name }]
    active: 'all',        // 'all' 或某个 source.id
    filterText: '',       // 文件名过滤
    favOnly: false,       // 只看收藏
    errCount: 0,          // 无法解码计数（展示用）

    settings,             // 会话/持久设置

    get favs() { return favs; },
    isFav(id) { return favs.has(id); },
    /** 清空全部收藏（设置面板用）；返回清掉的条数 */
    clearFavs() {
      const n = favs.size;
      if (n) { favs.clear(); saveFavs(); favRev++; Events.emit('favorite-changed', { id: null, on: false, all: true }); }
      return n;
    },
    toggleFav(id) {
      const has = favs.has(id);
      if (has) favs.delete(id); else favs.add(id);
      saveFavs();
      favRev++;
      Events.emit('favorite-changed', { id, on: !has });
      return !has;
    },

    /**
     * 外部原地修改了条目上「参与筛选/排序」的字段时调用（如 EXIF 回填 shotTs），
     * 使 viewList 的缓存失效。仅改 bad/state 等展示态字段则无需调用。
     */
    touch() { rev++; },

    /* ---------- 旋转（P1-4） ---------- */
    /** 该图已保存的旋转角度（0/90/180/270），无记录返回 0 */
    rotationOf(meta) { return rots.get(rotKeyOf(meta)) || 0; },
    /** 直接设置旋转角度；写盘并广播 rotation-changed。返回归整后的角度 */
    setRotation(meta, deg) {
      const k = rotKeyOf(meta);
      if (!k) return 0;
      const d = ((Math.round((deg || 0) / 90) * 90) % 360 + 360) % 360;
      rots.delete(k);                 // delete + set = 移到 Map 队尾（LRU 淘汰用）
      if (d) rots.set(k, d);
      saveRots();
      Events.emit('rotation-changed', { meta: meta, deg: d, key: k });
      return d;
    },
    /** 顺时针/逆时针步进 90°（dir = +1 / -1）；返回新角度 */
    rotateBy(meta, dir) {
      return this.setRotation(meta, this.rotationOf(meta) + (dir < 0 ? -90 : 90));
    },
    /** 清空全部旋转记录（设置面板「恢复默认」用）；返回清掉的条数 */
    clearRotations() {
      const n = rots.size;
      if (n) { rots.clear(); saveRots(); Events.emit('rotation-changed', { meta: null, deg: 0, all: true }); }
      return n;
    },
    /** 已保存旋转的图片数 */
    get rotationCount() { return rots.size; },
    /** 立即把旋转表落盘（一般不需要调用：写盘有 400ms 合并 + 关窗自动冲） */
    flushRotations() { flushRots(); },

    /** 更新设置并落盘（回调可选） */
    setSetting(key, value, apply) {
      settings[key] = value;
      saveSettings();
      if (apply) apply(value);
    },

    /**
     * 重新从 localStorage 读一遍设置 —— 用于**跨窗口同步**。
     * 相框窗口是另一个渲染进程：用户在那里拖窗口吸附到某条边时会把 frameDock 写盘，
     * 主窗口内存里那份就过期了；进相框前刷一次，才不会拿着旧值把窗口摆回去。
     * 刻意跳过 sizes —— 它是对象，整体替换会打断已有引用。
     */
    reloadSettings() {
      const fresh = loadSettings();
      for (const k in fresh) {
        if (k === 'sizes') continue;
        if (settings[k] !== fresh[k]) settings[k] = fresh[k];
      }
      return settings;
    },

    getModeSize(key) { return settings.sizes[key]; },
    setModeSize(key, v) {
      settings.sizes[key] = global.Util.clamp(Math.round(v), MODES[key].range[0], MODES[key].range[1]);
      saveSettings();
    },

    /** 恢复到出厂默认（不改动收藏与已加载的文件夹） */
    resetSettings() {
      const d = defaults();
      if (!d.sizes.single) d.sizes.single = Math.round(global.innerHeight * 0.9);
      for (const k in settings) delete settings[k];
      Object.assign(settings, d);
      settings.sizes.single = global.Util.clamp(settings.sizes.single, MODES.single.range[0], MODES.single.range[1]);
      saveSettings();
      return settings;
    },
    get defaults() { return defaults(); },

    /* ---------- 多文件夹来源 ---------- */
    sourceById(id) { return this.sources.find((s) => s.id === id) || null; },
    activeName() {
      if (this.active === 'all') return '全部图片';
      const s = this.sourceById(this.active);
      return s ? s.name : '图片';
    },
    /**
     * 当前选中来源下的原始条目（active=all 时为全部）。
     * 返回的是索引内的共享数组，只读使用，切勿原地修改。
     */
    activeItems() {
      if (this.active === 'all') return this.items;
      return bySid.get(this.active) || EMPTY;
    },
    /** 某来源的条目数（O(1)，来源 chip 渲染由 O(n×来源数) 降到 O(来源数)） */
    sourceCount(id) {
      if (id === 'all') return this.items.length;
      const a = bySid.get(id);
      return a ? a.length : 0;
    },

    /**
     * 提交一批条目到（新/已有）来源。
     * 同名来源视为“重新载入/刷新”：先清空其旧条目再并入。
     * 返回该来源对象。
     */
    commitSource(name, items) {
      let src = this.sources.find((s) => s.name === name);
      if (src) this._purgeItemsOf(src.id);
      else {
        src = { id: 'f' + (++_srcSeq), name };
        this.sources.push(src);
      }
      for (const it of items) { it.sid = src.id; it.srcName = src.name; }
      this.items.push(...items);
      for (const it of items) idxAdd(it);
      rev++;
      this._recountErr();
      return src;
    },

    /** 移除某来源（仅释放浏览器内数据，不触碰磁盘文件） */
    removeSource(id) {
      const src = this.sourceById(id);
      if (!src) return;
      this._purgeItemsOf(id);
      this.sources = this.sources.filter((s) => s.id !== id);
      // 清掉该来源遗留的收藏 id
      const prefix = id + '│';
      let dirty = false;
      for (const k of Array.from(favs)) {
        if (k.startsWith(prefix)) { favs.delete(k); dirty = true; }
      }
      if (dirty) saveFavs();
      if (this.active === id) this.active = 'all';
      // 相框相册若指向刚被移除的来源，回落到「全部图片」，免得下次开相框是空的
      if (settings.frameSrc === id) { settings.frameSrc = 'all'; saveSettings(); }
      this._recountErr();
    },

    /**
     * 删除单个条目（仅从内存与收藏中移除；磁盘文件由 Loader.deleteItem 负责）。
     * 返回是否命中。
     */
    removeItem(meta) {
      if (!meta) return false;
      const i = this.items.indexOf(meta);
      if (i < 0) return false;
      this.items.splice(i, 1);
      idxRemove(meta);
      rev++;
      if (favs.has(meta.id)) { favs.delete(meta.id); saveFavs(); favRev++; }
      this._recountErr();
      return true;
    },

    /**
     * 撤销删除的配套：把一个条目放回图库。
     * meta 可来自内存引用（本会话刚删除），也可来自删除日志还原的纯数据。
     * wasFav —— 删除前是否收藏（删除时收藏会被清掉，还原时补回）。
     * 返回 'ok' | 'dup'（已存在）| 'nosrc'（来源已不在，只还磁盘文件，不进图库）
     */
    restoreItem(meta, wasFav) {
      if (!meta) return 'nosrc';
      if (this.items.indexOf(meta) >= 0) return 'dup';
      // 同路径去重：避免重复还原产生两份
      if (meta.path && this.items.some((it) => it.path === meta.path)) return 'dup';
      if (meta.id && this.items.some((it) => it.id === meta.id)) return 'dup';
      const sid = meta.sid;
      if (sid && !this.sourceById(sid)) return 'nosrc'; // 所属文件夹已移除 → 不强行塞回图库
      if (sid && !this.sources.length) return 'nosrc';
      if (!meta.state) meta.state = 'idle';
      this.items.push(meta);
      idxAdd(meta);
      rev++;
      if (wasFav && meta.id && !favs.has(meta.id)) { favs.add(meta.id); saveFavs(); favRev++; }
      this._recountErr();
      return 'ok';
    },

    _purgeItemsOf(id) {
      this.items = this.items.filter((it) => it.sid !== id);
      bySid.delete(id);
      rev++;
    },

    _recountErr() {
      this.errCount = 0;
      for (const it of this.items) {
        if (it.bad || it.state === 'error') this.errCount++;
      }
    },
    recountErr() { this._recountErr(); },

    /**
     * 依据当前来源 + 过滤/收藏/排序条件生成「展示列表」。
     * 结果按 (来源, 过滤词, 只看收藏, 排序键/向, 结构版本, 收藏版本) 记忆化：
     * 输入未变时直接复用上一次的结果，避免重复的 O(n log n) 排序。
     * 返回的数组是缓存对象，调用方只读。
     */
    viewList() {
      const s = this.settings;
      const q = this.filterText.trim().toLowerCase();
      const key = [this.active, q, this.favOnly ? 1 : 0, s.sortKey, s.sortDir, rev, favRev].join('\u0000');
      if (this._vlKey === key && this._vlList) return this._vlList;

      const srcList = this.activeItems();
      const list = [];
      for (const it of srcList) {
        if (this.favOnly && !favs.has(it.id)) continue;
        if (q && !it.name.toLowerCase().includes(q)) continue;
        list.push(it);
      }
      const { sortKey, sortDir } = s;
      const col = sortKey === 'size'
        ? (a, b) => (a.size - b.size)
        : sortKey === 'time'
          ? (a, b) => (a.lastModified - b.lastModified)
          : sortKey === 'shot'
            // 拍摄时间：优先 EXIF 拍摄时刻，缺失时回退文件修改时间
            ? (a, b) => ((a.shotTs || a.lastModified || 0) - (b.shotTs || b.lastModified || 0))
            : (a, b) => global.Util.naturalCompare(a.name, b.name);
      const relCompare = (a, b) => {
        const sa = a.srcName || '';
        const sb = b.srcName || '';
        return global.Util.naturalCompare(sa + '/' + a.rel, sb + '/' + b.rel);
      };
      list.sort((a, b) => {
        const r = col(a, b) || relCompare(a, b);
        return r * sortDir;
      });
      this._vlKey = key;
      this._vlList = list;
      return list;
    },

    /** 手动清空展示列表缓存（索引异常或调试用） */
    invalidateView() { this._vlKey = null; this._vlList = null; rev++; },
  };

  global.State = State;
})(window);
