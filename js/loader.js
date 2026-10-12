/* ============================================================
   Atrium · loader.js
   文件夹加载入口（Electron 原生目录 / 拖拽 / 演示 File 列表）
   + 分批索引 + 去重 + 格式过滤 + 进度事件 + IndexedDB 缓存
   ============================================================ */
(function (global) {
  'use strict';

  const Util = global.Util;

  /* ---------- IndexedDB（尺寸缓存 + 缩略图落盘） ---------- */
  const DB_NAME = 'viewfinder-db';
  const DB_STORE = 'dirs';
  const THUMB_STORE = 'thumbs';       // v2：缩略图 blob 落盘（二次打开零解码）
  const DIM_HEAD = 65536;             // 读文件头取尺寸时最多读多少字节（JPEG 的 SOF 多在前 64KB）
  const DIM_PREFIX = 'dim:';          // 尺寸缓存键前缀
  let _dbPromise = null;
  function db() {
    if (!_dbPromise) {
      _dbPromise = new Promise((resolve) => {
        if (!global.indexedDB) return resolve(null);
        // v2 起多一个 thumbs 仓库。必须由这里统一升级：若先在别处用 v1 打开过，
        // 旧连接会一直占着，升级请求被 blocked，缩略图缓存会静默失效。
        const req = global.indexedDB.open(DB_NAME, 2);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains(DB_STORE)) d.createObjectStore(DB_STORE);
          if (!d.objectStoreNames.contains(THUMB_STORE)) {
            const s = d.createObjectStore(THUMB_STORE, { keyPath: 'k' });
            s.createIndex('at', 'at');   // 按写入时间淘汰最旧
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      });
    }
    return _dbPromise;
  }
  function hasThumbStore(d) {
    return !!(d && d.objectStoreNames && d.objectStoreNames.contains(THUMB_STORE));
  }
  async function idbSet(key, val) {
    const d = await db(); if (!d) return;
    try { await new Promise((res, rej) => { const t = d.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).put(val, key); t.onsuccess = res; t.onerror = () => rej(t.error); }); } catch (e) { /* 忽略 */ }
  }
  async function idbGet(key) {
    const d = await db(); if (!d) return null;
    try { return await new Promise((res) => { const r = d.transaction(DB_STORE).objectStore(DB_STORE).get(key); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); }); } catch (e) { return null; }
  }
  async function idbDel(key) {
    const d = await db(); if (!d) return;
    try { await new Promise((res) => { const t = d.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).delete(key); t.onsuccess = res; t.onerror = res; }); } catch (e) { /* 忽略 */ }
  }
  /**
   * 批量按 key 取值（一个事务里发 N 个 get）。
   * 这是「尺寸缓存按需读」的关键：以前用 idbScan 全表扫，会把所有文件夹的
   * 尺寸记录都读进内存 —— 换一个目录就要白读上千行。这里只取当前列表需要的。
   */
  async function idbGetMany(prefix, ids) {
    const d = await db(); if (!d || !ids.length) return new Map();
    const out = new Map();
    try {
      await new Promise((res) => {
        const t = d.transaction(DB_STORE);
        const os = t.objectStore(DB_STORE);
        for (const id of ids) {
          const r = os.get(prefix + id);
          r.onsuccess = () => { if (r.result) out.set(id, r.result); };
        }
        t.oncomplete = res; t.onerror = res; t.onabort = res;
      });
    } catch (e) { /* 读失败按未命中处理 */ }
    return out;
  }

  /* ---------- 缩略图 blob 落盘缓存（v2） ----------
     缩略图以前只活在内存 LRU 里，切目录或重启就全没了 —— 同一个文件夹每次
     打开都要把每张图重新解码一遍，这正是「图片多、文件大时打开慢」的主因之一。
     现在生成的缩略图直接落 IndexedDB，下次打开同一目录零解码直接出图。
     容量按条数封顶，超了丢最旧的（at 索引递增游标）。 */
  const THUMB_MAX = 4000;      // 最多保留的缩略图条数（约 100~160 MB 量级）
  const THUMB_TRIM = 500;      // 超限时一次淘汰多少条
  let _thumbCount = -1;        // -1 = 还没统计过
  const thumbQueue = new Map();  // key -> blob，攒一批再写
  let thumbFlushT = 0;

  function thumbCachePut(key, blob, side) {
    if (!key || !blob) return;
    thumbQueue.set(key, { blob: blob, side: side | 0 });
    if (thumbFlushT) return;
    thumbFlushT = setTimeout(() => { thumbFlushT = 0; flushThumbs(); }, 400);
  }
  /** 立即落盘（关窗/切目录前调用，避免最后一批缩略图丢失） */
  async function flushThumbCache() {
    if (thumbFlushT) { clearTimeout(thumbFlushT); thumbFlushT = 0; }
    await flushThumbs();
  }
  async function flushThumbs() {
    if (!thumbQueue.size) return;
    const d = await db();
    if (!hasThumbStore(d)) { thumbQueue.clear(); return; }
    const batch = Array.from(thumbQueue.entries());
    thumbQueue.clear();
    try {
      await new Promise((res, rej) => {
        const t = d.transaction(THUMB_STORE, 'readwrite');
        const os = t.objectStore(THUMB_STORE);
        const at = Date.now();
        for (const [k, rec] of batch) os.put({ k, at, side: rec.side, blob: rec.blob });
        t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
      });
      if (_thumbCount >= 0) _thumbCount += batch.length;
      await trimThumbs(d);
    } catch (e) { /* 落库失败下次再写 */ }
  }
  function countThumbs(d) {
    return new Promise((res) => {
      try {
        const r = d.transaction(THUMB_STORE).objectStore(THUMB_STORE).count();
        r.onsuccess = () => res(r.result || 0); r.onerror = () => res(0);
      } catch (e) { res(0); }
    });
  }
  function oldestThumbKeys(d, n) {
    return new Promise((res) => {
      const out = [];
      try {
        const req = d.transaction(THUMB_STORE).objectStore(THUMB_STORE).index('at').openCursor();
        req.onsuccess = (e) => {
          const c = e.target.result;
          if (!c || out.length >= n) { res(out); return; }
          out.push(c.value.k); c.continue();
        };
        req.onerror = () => res(out);
      } catch (e) { res(out); }
    });
  }
  async function trimThumbs(d) {
    if (_thumbCount < 0) _thumbCount = await countThumbs(d);
    if (_thumbCount <= THUMB_MAX) return;
    const keys = await oldestThumbKeys(d, THUMB_TRIM);
    if (!keys.length) return;
    try {
      await new Promise((res) => {
        const t = d.transaction(THUMB_STORE, 'readwrite');
        const os = t.objectStore(THUMB_STORE);
        for (const k of keys) os.delete(k);
        t.oncomplete = res; t.onerror = res; t.onabort = res;
      });
      _thumbCount -= keys.length;
    } catch (e) { /* 淘汰失败下次再来 */ }
  }
  async function thumbCacheGet(key) {
    const d = await db();
    if (!key || !hasThumbStore(d)) return null;
    try {
      return await new Promise((res) => {
        const r = d.transaction(THUMB_STORE).objectStore(THUMB_STORE).get(key);
        r.onsuccess = () => {
          const v = r.result;
          res(v && v.blob ? { blob: v.blob, side: v.side | 0 } : null);
        };
        r.onerror = () => res(null);
      });
    } catch (e) { return null; }
  }
  async function thumbCacheStats() {
    const d = await db();
    if (!hasThumbStore(d)) return { count: 0, max: THUMB_MAX, ready: false };
    const c = await countThumbs(d);
    _thumbCount = c;
    return { count: c, max: THUMB_MAX, ready: true };
  }
  async function thumbCacheClear() {
    thumbQueue.clear();
    if (thumbFlushT) { clearTimeout(thumbFlushT); thumbFlushT = 0; }
    const d = await db();
    if (!hasThumbStore(d)) return { count: 0 };
    try {
      await new Promise((res) => {
        const t = d.transaction(THUMB_STORE, 'readwrite');
        t.objectStore(THUMB_STORE).clear();
        t.oncomplete = res; t.onerror = res; t.onabort = res;
      });
      _thumbCount = 0;
    } catch (e) { /* 忽略 */ }
    return { count: 0 };
  }
  /** 游标扫出指定前缀的全部 {id,val}（仅用于按来源清理，不用于日常读取） */
  async function idbScan(prefix) {
    const d = await db(); if (!d) return [];
    try {
      return await new Promise((res) => {
        const out = [];
        const req = d.transaction(DB_STORE).objectStore(DB_STORE).openCursor();
        req.onsuccess = (e) => {
          const c = e.target.result;
          if (!c) { res(out); return; }
          const key = c.key;
          if (typeof key === 'string' && key.startsWith(prefix)) out.push({ id: key.slice(prefix.length), val: c.value });
          c.continue();
        };
        req.onerror = () => res(out);
      });
    } catch (e) { return []; }
  }

  /* ---------- 尺寸/比例持久缓存（避免每次载入重排跳动） ---------- */
  const dimsMem = new Map();   // id -> {w,h}
  const dimDirty = new Map();
  let dimFlushT = 0;
  function scheduleDimFlush() {
    if (dimFlushT) return;
    dimFlushT = setTimeout(() => { dimFlushT = 0; flushDims(); }, 1200);
  }
  async function flushDims() {
    const d = await db();
    if (!d || !dimDirty.size) return;
    const batch = Array.from(dimDirty.entries());
    dimDirty.clear();
    try {
      await new Promise((res, rej) => {
        const t = d.transaction(DB_STORE, 'readwrite');
        for (const [id, v] of batch) t.objectStore(DB_STORE).put(v, DIM_PREFIX + id);
        t.oncomplete = res; t.onerror = () => rej(t.error);
      });
    } catch (e) { /* 落库失败下次再写 */ }
  }

  /* ---------- 尺寸缓存的清理（设置面板「清除缓存」用） ----------
     只动 DIM_PREFIX 的键：同一个 store 里可能还残留旧版写入的其它键
     （历史上这里也存过文件夹句柄记忆），清缓存只碰尺寸缓存，别的一律不动。 */
  async function countDims() {
    const d = await db(); if (!d) return 0;
    try {
      return await new Promise((res) => {
        const r = d.transaction(DB_STORE).objectStore(DB_STORE).getAllKeys();
        r.onsuccess = () => res((r.result || []).filter((k) => typeof k === 'string' && k.startsWith(DIM_PREFIX)).length);
        r.onerror = () => res(0);
      });
    } catch (e) { return 0; }
  }
  async function clearDimsCache() {
    if (dimFlushT) { clearTimeout(dimFlushT); dimFlushT = 0; }
    dimDirty.clear();
    const mem = dimsMem.size;
    dimsMem.clear();
    const d = await db(); if (!d) return { count: mem };
    let removed = 0;
    try {
      const rows = await idbScan(DIM_PREFIX);
      if (rows.length) {
        await new Promise((res) => {
          const t = d.transaction(DB_STORE, 'readwrite');
          const os = t.objectStore(DB_STORE);
          for (const row of rows) os.delete(DIM_PREFIX + row.id);
          t.oncomplete = res; t.onerror = res; t.onabort = res;
        });
        removed = rows.length;
      }
    } catch (e) { /* 忽略 */ }
    return { count: removed };
  }
  async function dimsCacheStats() {
    return { count: await countDims(), mem: dimsMem.size };
  }

  /* ---------- 递归扫描（拖拽目录入口） ---------- */
  function scanEntry(entry, rel, out) {
    return new Promise((resolve) => {
      if (entry.isFile) {
        entry.file((file) => {
          if (Util.isImageExt(file.name)) out.push({ file, rel: rel + file.name });
          resolve();
        }, () => resolve());
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const next = () => reader.readEntries(async (entries) => {
          if (!entries.length) return resolve();
          for (const en of entries) await scanEntry(en, rel + entry.name + '/', out);
          next();
        }, () => resolve());
        next();
      } else resolve();
    });
  }

  async function scanDataTransfer(dt) {
    const out = [];
    const items = Array.from((dt && dt.items) || []).filter((it) => it.kind === 'file');
    if (items.length && items[0].webkitGetAsEntry) {
      for (const it of items) {
        const en = it.webkitGetAsEntry();
        if (!en) continue;
        if (en.isDirectory) {
          const sub = [];
          await scanEntry(en, '', sub);
          const rel0 = en.name;
          for (const s of sub) out.push({ file: s.file, rel: rel0 + '/' + s.rel });
        } else if (en.isFile) {
          out.push({ file: it.getAsFile(), rel: en.name });
        }
      }
    } else {
      // 兜底：无 entry API 的浏览器
      const files = Array.from(dt.files || []);
      for (const f of files) {
        if (Util.isImageExt(f.name)) {
          const rel = f.webkitRelativePath || f.name;
          out.push({ file: f, rel });
        }
      }
    }
    return out;
  }

  /* ---------- 索引器 ---------- */
  const Loader = {
    isIndexing: false,

    /**
     * 统一加工入口：接收 [{file, rel}]（已按图片扩展名过滤）。
     * 产出元数据条目数组。
     */
    buildEntries(entries, folderName) {
      const { Util } = global;
      const byRel = new Map();
      for (const e of entries) {
        const file = e.file || null;
        const path = e.path || null;
        if (!file && !path) continue;
        const key = e.rel;
        if (byRel.has(key)) { // 去重：同一路径只保留一份
          const old = byRel.get(key);
          if (file ? (old.size >= file.size) : true) continue;
        }
        const name = file ? file.name : (e.name || key.split('/').pop() || key);
        const size = file ? file.size : (e.size | 0);
        const lastModified = file ? (file.lastModified || 0) : (Math.round(e.lastModified) || 0);
        const heic = Util.isHeic(name);
        byRel.set(key, {
          id: Util.itemId(folderName, key, size, lastModified),
          name,
          rel: key,
          ext: Util.ext(name),
          size,
          lastModified,
          file,          // 浏览器模式持有真实 File；Electron 原生条目为 null
          path: path || null,  // Electron 原生条目的磁盘绝对路径
          dirHandle: e.dirHandle || null, // 浏览器 FS 访问：所在目录句柄（有写权限才可删除）
          heic,                     // 是否 HEIC/HEIF（探测结果回来后可能被摘掉 bad）
          // P1-2：不再无条件判死 —— 只有「确知本机解不了」才预标记；
          // 探测未出结果时也先按旧行为标记，_applyHeicCapability 会再修正。
          bad: heic && !Util.heicSupported(),
          state: 'idle',            // idle | loading | ok | error
          w: 0, h: 0,
        });
      }
      return Array.from(byRel.values());
    },

    /**
     * P1-2：HEIC/HEIF 能力探测结果落地。
     * 本机确实能解 → 摘掉 bad，照常走缩略图解码管线（解不出再由 onerror 标 error）；
     * 本机解不了 → 保持 bad，网格显示「不可用」占位、灯箱给明确文案。
     * 只在这批里存在 HEIC 时才等探测，避免无谓延迟。
     */
    async _applyHeicCapability(list) {
      let has = false;
      for (const m of list) if (m.heic) { has = true; break; }
      if (!has) return;
      const ok = await Util.heicReady().catch(() => false);
      for (const m of list) {
        if (!m.heic) continue;
        m.heicOk = !!ok;
        if (ok) { m.bad = false; m.state = 'idle'; }
        else { m.bad = true; m.state = 'idle'; }
      }
    },

    /* 核心加工：索引 + 分批提交到一个来源（同名文件夹视为刷新） */
    async _ingest(folderName, entries, via, totalHint) {
      const all = this.buildEntries(entries, folderName);
      if (!all.length) {
        State.bus.emit('index-done', { via, folderName, count: 0 });
        return 0; // 该来源没有可显示的图片
      }
      // P1-2：先等 HEIC 能力探测落地，再决定这些 .heic 到底是「能看」还是「不可用」
      await this._applyHeicCapability(all);
      // 尺寸缓存预载：让网格首屏直接按真实比例排布，不跳版
      const dimMap = await this._loadDimsFor(all);
      for (const m of all) {
        const cd = dimMap.get(m.id);
        if (!cd) continue;
        if (cd.w > 0 && cd.h > 0) { m.w = cd.w; m.h = cd.h; m.ratio = cd.r || cd.w / cd.h; }
        else if (cd.r > 0) m.ratio = cd.r;      // 只有比例（缩略图来源）也够首屏排布用
      }
      State.bus.emit('index-start', { via });
      const items = [];
      const CHUNK = 220;
      for (let i = 0; i < all.length; i += CHUNK) {
        items.push(...all.slice(i, i + CHUNK));
        await new Promise((res) => Util.idle(res, 50));
        State.bus.emit('index-progress', { done: items.length, total: totalHint || all.length });
      }
      State.bus.emit('index-progress', { done: items.length, total: items.length });
      State.commitSource(folderName, items);
      State.bus.emit('index-done', { via, folderName, count: items.length });
      return items.length;
    },

    /* ---------- 入口 1：内存 File 列表（仅 ?demo=1 合成样张走这条） ----------
       正式「打开文件夹」只有一条路：入口 3 的 Electron 原生目录（fromNative）。
       Electron 版不再保留 webkitdirectory 文件框与 File System Access 两条浏览器通路。 */
    fromInput(files, name) {
      if (!files || !files.length || this.isIndexing) return;
      const list = Array.from(files).filter((f) => Util.isImageExt(f.name));
      const relOf = (f) => f.webkitRelativePath || f.name;
      const folderName = name || Util.folderNameFromPath(list.length ? list[0].webkitRelativePath : '') || '图片';
      const entries = list.map((f) => ({ file: f, rel: relOf(f) }));
      this.isIndexing = true;
      this._ingest(folderName, entries, 'input', list.length).finally(() => { this.isIndexing = false; });
    },

    /* ---------- 入口 3：Electron 原生目录（path 驱动，主进程列目录） ---------- */
    /** 打开磁盘目录并载入。silent=true 用于启动自动恢复（空目录不打扰提示）。 */
    async fromNative(dirPath, silent) {
      const N = global.Native;
      if (!N || !N.active || !dirPath || this.isIndexing) return 0;
      this.isIndexing = true;
      try {
        State.bus.emit('index-start', { via: 'native' });
        const r = await N.loadDir(dirPath);
        if (!r || !r.ok || !r.files || !r.files.length) {
          State.bus.emit('index-done', { via: 'native', folderName: null, count: 0 });
          if (!silent && global.App && State.sources.length === 0) {
            if (global.App.toast) global.App.toast('该文件夹里没有可显示的图片');
          }
          return 0;
        }
        const entries = r.files.map((f) => ({
          name: f.name, rel: f.rel, size: f.size, lastModified: f.mtime, path: f.path,
        }));
        const name = r.name || (r.dir ? (r.dir.split(/[\\/]/).filter(Boolean).pop() || '图片') : '图片');
        const n = await this._ingest(name, entries, 'native', entries.length);
        /* 只有开着「记住上次位置」才写盘 —— 否则关掉开关后每次仍会被记住，设置形同虚设。 */
        if (n > 0 && State.settings.rememberLast) { const sd = N.setLastDir; if (sd) sd(dirPath); }
        return n;
      } finally {
        this.isIndexing = false;
      }
    },

    /* ---------- 入口 2：拖拽（支持一次拖入多个文件夹） ---------- */
    async fromDrop(dt) {
      if (this.isIndexing || !dt) return false;
      const entries = await scanDataTransfer(dt);
      if (!entries.length) return false;
      // 按顶层目录分组：多个文件夹 → 多个来源；散文件归为“拖入的图片”
      const groups = new Map();
      for (const e of entries) {
        const slash = e.rel.indexOf('/');
        const key = slash >= 0 ? e.rel.slice(0, slash) : '\u0000loose';
        const name = slash >= 0 ? key : '拖入的图片';
        if (!groups.has(key)) groups.set(key, { name, list: [] });
        groups.get(key).list.push(e);
      }
      this.isIndexing = true;
      try {
        let ok = false;
        for (const g of groups.values()) {
          const n = await this._ingest(g.name, g.list, 'drop', g.list.length);
          if (n > 0) ok = true;
        }
        return ok;
      } finally {
        this.isIndexing = false;
      }
    },

    /* ---------- 尺寸/比例缓存 API ----------
       记录形状统一为 { w, h, r }：w/h 是「原图真实像素」（unknown 时为 0），
       r 是宽高比（任何来源都可以提供，永远可用）。
       分成两个入口，是因为两种来源的可信度不同：
         - recordDims：确定性拿到原图真实尺寸（读文件头 / 原图解码）。写绝对值。
         - recordRatio：只有比例可信（缩略图是被降采样过的，它的像素尺寸不是原图尺寸）。
       网格布局只依赖比例，所以即使绝对值未知，首屏也不会跳版。 */
    recordDims(meta, w, h) {
      if (!meta || !(w > 0) || !(h > 0)) return;
      const r = w / h;
      const prev = dimsMem.get(meta.id);
      // 已有更完整的原图尺寸记录 → 不接受降级（缩略图尺寸可能更小）
      if (meta.w > 0 && w <= meta.w && h <= meta.h) {
        if (prev && prev.r) return;
        this.recordRatio(meta, w, h);
        return;
      }
      if (meta.w === w && meta.h === h && prev && prev.r === r) return;
      meta.w = w; meta.h = h;
      dimsMem.set(meta.id, { w, h, r });
      dimDirty.set(meta.id, { w, h, r });
      scheduleDimFlush();
    },

    /** 只知道比例时的记录（缩略图解码产物就是这种）。绝不写 w/h，避免污染原图尺寸。 */
    recordRatio(meta, w, h) {
      if (!meta || !(w > 0) || !(h > 0)) return;
      const r = w / h;
      const prev = dimsMem.get(meta.id);
      if (prev && prev.r === r && prev.w > 0) return;
      const rec = { w: prev ? prev.w : 0, h: prev ? prev.h : 0, r };
      if (prev && prev.r === r && prev.w === rec.w && prev.h === rec.h) return;
      dimsMem.set(meta.id, rec);
      dimDirty.set(meta.id, rec);
      scheduleDimFlush();
    },

    async _loadDimsFor(list) {
      const missing = [];
      for (const m of list) if (!dimsMem.has(m.id)) missing.push(m.id);
      if (missing.length) {
        // 只按当前列表需要的 key 取（分批，避免一个事务塞太多请求）
        const CH = 1500;
        for (let i = 0; i < missing.length; i += CH) {
          const got = await idbGetMany(DIM_PREFIX, missing.slice(i, i + CH));
          for (const [id, v] of got) {
            if (!v) continue;
            if (v.w > 0 && v.h > 0) dimsMem.set(id, { w: v.w, h: v.h, r: v.r || v.w / v.h });
            else if (v.r > 0) dimsMem.set(id, { w: 0, h: 0, r: v.r });
          }
        }
      }
      const map = new Map();
      for (const m of list) {
        const v = dimsMem.get(m.id);
        if (v && v.w > 0 && v.h > 0) map.set(m.id, { w: v.w, h: v.h, r: v.r || v.w / v.h });
        else if (v && v.r > 0) map.set(m.id, { r: v.r, w: 0, h: 0 });
      }
      return map;
    },

    /**
     * 读文件头拿真实像素尺寸（不解码，见 Util.sizeFromHeader）。
     * 缩略图改成降采样解码后，解码产物已经不是原图尺寸了；这个方法用几十 KB
     * 的顺序读换到精确宽高，供网格首屏按真实比例排布，并写进尺寸库长期复用。
     * 认不出的格式（HEIC/TIFF/流不完整）返回 null，调用方回退到「只给一边」降采样。
     */
    async imageSize(meta) {
      if (!meta || meta.bad) return null;
      if (meta.w > 0 && meta.h > 0) return { w: meta.w, h: meta.h };
      if (meta._dimProbe !== undefined) return meta._dimProbe;
      meta._dimProbe = null;                     // 先占位：同一张图不重复读头
      let buf = null;
      try {
        if (meta.file) buf = await meta.file.slice(0, DIM_HEAD).arrayBuffer();
        else if (meta.path && global.Native && global.Native.readHead) {
          buf = await global.Native.readHead(meta.path, DIM_HEAD);
        }
      } catch (e) { buf = null; meta._dimErr = String((e && e.message) || e); }
      let sz = null;
      try { sz = buf ? Util.sizeFromHeader(buf) : null; }
      catch (e) { sz = null; meta._dimErr = String((e && e.message) || e); }
      if (!sz && !meta._dimErr) meta._dimErr = buf ? 'header-unparsed' : 'read-failed';
      meta._dimProbe = sz || null;
      if (sz) this.recordDims(meta, sz.w, sz.h);
      return sz;
    },

    /** 移除来源时按文件夹名前缀清理该来源的尺寸缓存 */
    async clearDimsFor(folderName) {
      const prefix = folderName + '\u2502';
      for (const k of Array.from(dimsMem.keys())) if (k.startsWith(prefix)) dimsMem.delete(k);
      const rows = await idbScan(DIM_PREFIX);
      const d = await db();
      if (!d) return;
      const ids = [];
      for (const r of rows) if (r.id.startsWith(prefix)) ids.push(r.id);
      if (!ids.length) return;
      try {
        await new Promise((res) => {
          const t = d.transaction(DB_STORE, 'readwrite');
          for (const id of ids) t.objectStore(DB_STORE).delete(DIM_PREFIX + id);
          t.oncomplete = res; t.onerror = res;
        });
      } catch (e) { /* 忽略 */ }
    },

    /* ---------- 删除（真实文件操作，仅在具备写能力时可用） ---------- */
    /**
     * 该条目能否删除？返回删除方式：
     *   'trash' —— 桌面版（Electron）：移入系统回收站，可恢复；
     *   'fs'    —— 浏览器「选择文件夹」授权：直接删除，不可恢复；
     *   null    —— 不支持（拖拽 / 文件夹选择框来源没有写权限）。
     */
    canDelete(meta) {
      if (!meta) return null;
      if (meta.path && global.Native && global.Native.active) return 'trash';
      if (meta.dirHandle && meta.file) return 'fs';
      return null;
    },

    /** 执行删除，返回 { ok, mode?, reason?, message? }。绝不静默降级为永久删除。 */
    async deleteItem(meta) {
      const cap = this.canDelete(meta);
      if (cap === 'trash') {
        // 带上 name/size：主进程据此写入“可撤销”的删除日志
        const r = await global.Native.deleteFile(meta.path, { name: meta.name, size: meta.size });
        return r || { ok: false, reason: 'failed' };
      }
      if (cap === 'fs') {
        const dir = meta.dirHandle;
        try {
          let st = 'prompt';
          try { st = await dir.queryPermission({ mode: 'readwrite' }); } catch (e) { st = 'prompt'; }
          if (st !== 'granted') st = await dir.requestPermission({ mode: 'readwrite' });
          if (st !== 'granted') return { ok: false, reason: 'denied' };
          await dir.removeEntry(meta.name);
          return { ok: true, mode: 'fs' };
        } catch (e) {
          return { ok: false, reason: 'failed', message: String((e && e.message) || e) };
        }
      }
      return { ok: false, reason: 'unsupported' };
    },

    /** 删除后清理该条目的尺寸缓存（内存 + IndexedDB） */
    async forgetDims(id) {
      dimsMem.delete(id);
      dimDirty.delete(id);
      await idbDel(DIM_PREFIX + id);
    },

    /** 缩略图落盘缓存（thumb.js 使用；主进程/探针可读统计） */
    thumbCache: {
      get: thumbCacheGet,
      put: thumbCachePut,
      flush: flushThumbCache,
      clear: thumbCacheClear,
      stats: thumbCacheStats,
    },

    /** 图片尺寸缓存（设置面板「清除缓存」使用） */
    dimsCache: {
      clear: clearDimsCache,
      stats: dimsCacheStats,
    },
  };

  /* 关窗前把攒着的缩略图落盘（pagehide 里只做「立刻发起」，不等结果） */
  if (global.addEventListener) {
    global.addEventListener('pagehide', () => { if (thumbQueue.size) flushThumbCache(); });
  }

  global.Loader = Loader;
})(window);
