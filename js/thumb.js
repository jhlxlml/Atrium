/* ============================================================
   Atrium · thumb.js
   缩略图管线（解码即降采样 → canvas 兜底，并发闸门 + 可视区优先）

   性能设计要点（v1.6.0 重写）：
   1) 「解码即降采样」：以前是 createImageBitmap(file) 先解出全尺寸位图，
      再画到小 canvas 上缩小 —— 一张 5000×4000 的 JPEG 要分配约 80 MB 的
      RGBA 缓冲，解码本身就要上百毫秒。现在把目标尺寸直接交给解码器
      （createImageBitmap 的 resizeWidth/resizeHeight），JPEG 可以走
      libjpeg 的缩放 DCT（1/2、1/4、1/8），既快得多又几乎不占内存。
   2) 三层缓存：内存 LRU → IndexedDB 落盘 → 重新解码。第二层让「同一个
      文件夹第二次打开」几乎零解码，这是「图片多时打开慢」的最大改善点。
   3) 解码槽位是优先队列：网格把当前可视区的 id 报进来，快速滚动时新区域的
      请求会插到旧区域的请求前面，不会排在几十个已经离开视野的请求后面。
   4) 编码复用 canvas 池（每槽一个），避免每次解码都新建 DOM canvas。
   ============================================================ */
(function (global) {
  'use strict';

  const THUMB_CAP = 1800;   // 缩略图 URL 缓存条数（内存）
  const BIG_CAP = 220;      // 原图 URL 缓存条数（Lightbox 与单列共用）
  const MAX_THUMB = 1600;   // 缩略图最长边上限（物理像素）
  const isBitmap = global.Util.can.createImageBitmap;
  const DECODE_CONCURRENCY = 6;   // 解码并发闸门（配合降采样解码，峰值内存很低）

  /* 尺寸档位：请求边长向上取档。
     以前直接拿 cssW 当缓存键，窗口稍微变宽就要把整屏缩略图重解一遍；
     取档之后常见布局变化都落在同一档里，不触发重解。 */
  const SIDES = [96, 144, 192, 256, 320, 448, 640, 896, 1280, MAX_THUMB];
  function bucketOf(need) {
    for (let i = 0; i < SIDES.length; i++) if (SIDES[i] >= need) return SIDES[i];
    return MAX_THUMB;
  }

  /* ---------- 简单 LRU（Map 序即访问序） ---------- */
  class LRU {
    constructor(cap) { this.cap = cap; this.map = new Map(); }
    has(k) { return this.map.has(k); }
    get(k) {
      const v = this.map.get(k);
      if (v !== undefined) { this.map.delete(k); this.map.set(k, v); }
      return v;
    }
    set(k, v) {
      if (this.map.has(k)) this.map.delete(k);
      this.map.set(k, v);
      if (this.map.size > this.cap) this._evictN(this.map.size - this.cap);
    }
    _evictN(n) {
      const it = this.map.keys();
      while (n-- > 0) {
        const k = it.next().value;
        if (k === undefined) break;
        const v = this.map.get(k);
        if (v && v.url) global.URL.revokeObjectURL(v.url);
        this.map.delete(k);
      }
    }
    clear() { for (const v of this.map.values()) if (v && v.url) global.URL.revokeObjectURL(v.url); this.map.clear(); }
  }

  const thumbs = new LRU(THUMB_CAP);   // id -> {url, side}
  const bigs = new LRU(BIG_CAP);       // id -> {url}
  const screens = new LRU(8);          // id -> {url, side, w, h, tw, th, full}（灯箱的"屏幕尺寸代"）
  const pending = new Map();           // id -> Promise<string|null>
  /* 「代」的生成串成一条链，一次只跑一个 —— 理由见 preloadScreen 的注释 */
  let screenChain = Promise.resolve();

  /* ---------- 灯箱的"屏幕尺寸代" ----------
     为什么需要它：灯箱把图片按「自然尺寸 + transform 缩放」显示，一张 6000×4000 的照片
     在 1440 宽的窗口里实际只占 938px，可浏览器必须先把**整张 24MP** 解出来才画得出第一帧。
     实测（真实 exe、软件渲染、5MB 的 24MP JPEG）：解一次 130ms、48MP 要 265ms，
     而且**冷热一样慢** —— 这么大的位图不会被浏览器的解码缓存留住，来回翻每次都重解。
     于是每切一张就白等 150–300ms，用户看到的就是"转圈，然后图才出来"。

     办法与网格缩略图完全相同：用 createImageBitmap 的 resizeWidth/Height 让解码器
     直接吐一个屏幕尺寸的位图（libjpeg 的降采样解码，快一个数量级）。
     真要看 1:1 细节时灯箱会再换回原图（Lightbox._upgradeToFull），那条路只在
     "用户主动放大"时付一次代价。

     与 thumbURL 的关键差别：**不写 IndexedDB**。一代 1920 宽的 JPEG 约 0.3–1MB，
     几千张照片就是几个 GB 的磁盘，而它随时可以再算一遍。只留内存，LRU 淘汰即 revoke。 */
  const SCREEN_SIDES = [1280, 1920, 2560, 3072, 4096];
  function screenBucket(need) {
    for (let i = 0; i < SCREEN_SIDES.length; i++) if (SCREEN_SIDES[i] >= need) return SCREEN_SIDES[i];
    return SCREEN_SIDES[SCREEN_SIDES.length - 1];
  }

  /**
   * 缓存里的这一代够不够"这次请求"用。
   *
   * 为什么不能只写 `rec.side >= side`（v1.20.9）：`full: true` 表示**这就是原图**，
   * 它的 `side` 记的是原图边长（如 958），而请求档位可能是 1280 —— 于是 `958 >= 1280`
   * 恒假，这类"原图本来就比档位小"的图**永远不命中**，每停一张就重跑一次 `screenURL`
   * （还会为 File 条目重新 createObjectURL 一次，旧 URL 没人 revoke）。
   * 原图永远够用 —— 没有比它更清楚的版本了，所以 `full` 直接放行。
   *
   * 实测（Downloads 15 张，每张停 3 秒）：8 张"原图小于档位"的图在两圈里
   * 全部 peek=N，而它们占着 `screens` 的槽位、把真正有用的代挤出去。
   */
  const screenOk = (rec, side) => !!rec && (!!rec.full || rec.side >= side);

  /**
   * 取一张"够屏幕显示"的位图 URL。
   * @param {object} meta 条目
   * @param {number} cssW 图片将要占的 CSS 像素宽（会乘 dpr 再向上取档）
   * @returns {Promise<{url:string,side:number,w:number,h:number,tw:number,th:number,full:boolean}|null>}
   *   tw/th 是**原图**尺寸（0 = 没探到）；full=true 表示这本来就是原图。
   */
  async function screenURL(meta, cssW) {
    if (!meta || meta.bad) return null;
    const dpr = Math.min(global.devicePixelRatio || 1, 2);
    const need = Math.max(320, Math.round((cssW || 1200) * dpr));
    const side = screenBucket(need);
    const hit = screens.get(meta.id);
    if (screenOk(hit, side)) { stats.screenHits++; return hit; }

    // 先知道原图多大：原图本来就不比目标档大，就直接给原图，省一次 canvas 编码
    let ow = meta.w > 0 ? meta.w : 0;
    let oh = meta.h > 0 ? meta.h : 0;
    if (!ow && global.Loader && global.Loader.imageSize) {
      const sz = await global.Loader.imageSize(meta).catch(() => null);
      if (sz && sz.w > 0) { ow = sz.w; oh = sz.h; }
    }
    const maxSide = Math.max(ow, oh);
    if (maxSide > 0 && maxSide <= side) {
      const url = elURL(meta);
      if (!url) return null;
      const old = screens.get(meta.id);
      const rec = { url, side: maxSide, w: ow, h: oh, tw: ow, th: oh, full: true };
      screens.set(meta.id, rec);
      /* 覆盖同一个键时 LRU 不会 revoke 旧值 —— File 条目每跑一次这里就多一个
         blob URL（旧的那个再也没人放得掉）。 */
      if (old && old.url && old.url !== url) revoke(old.url);
      return rec;
    }

    const res = await decodeThumb(meta, side);
    if (!res || !res.blob) {
      // 降级：拿原图。慢，但保证"一定能显示"
      const url = elURL(meta);
      return url ? { url, side: 0, w: 0, h: 0, tw: 0, th: 0, full: true } : null;
    }
    const url = global.URL.createObjectURL(res.blob);
    const rec = {
      url, side: Math.max(res.dw, res.dh), w: res.dw, h: res.dh,
      tw: res.tw, th: res.th, full: false,
    };
    screens.set(meta.id, rec);   // LRU 淘汰时会把旧 URL revoke 掉
    stats.screenMakes++;
    return rec;
  }


  /* 计数供性能探针断言（不参与业务逻辑） */
  const stats = { decodes: 0, memHits: 0, diskHits: 0, misses: 0, viaBitmap: 0, viaImg: 0, lastMs: 0, maxMs: 0, screenHits: 0, screenMakes: 0 };
  function noteDecode(via, ms) {
    stats.lastMs = ms;
    if (ms > stats.maxMs) stats.maxMs = ms;
    if (via === 'bitmap') stats.viaBitmap++; else stats.viaImg++;
  }
  const now = () => (global.performance && global.performance.now) ? global.performance.now() : Date.now();
  const msSince = (t0) => Math.round(now() - t0);

  /* ---------- 解码槽：可视区优先的优先队列 ---------- */
  let activeDecodes = 0;
  const queue = [];              // { id, resolve }
  let desired = new Set();       // 网格当前可视区 id 集合

  /** 网格同步可视区后调用：让即将出现在屏幕上的图先解码 */
  function setDesired(ids) {
    desired = new Set(ids || []);
  }
  function aquireSlot(id) {
    return new Promise((resolve) => { queue.push({ id, resolve }); pump(); });
  }
  /** 优先挑视口内的请求；一个都没有时退回队首（保持首屏的原有顺序） */
  function pick() {
    if (desired.size) {
      for (let i = 0; i < queue.length; i++) if (desired.has(queue[i].id)) return i;
    }
    return 0;
  }
  function pump() {
    while (activeDecodes < DECODE_CONCURRENCY && queue.length) {
      const job = queue.splice(pick(), 1)[0];
      activeDecodes++;
      job.resolve(() => { activeDecodes--; pump(); });
    }
  }

  /* ---------- 媒体源抽象：兼容 File（浏览器）与磁盘 path（Electron vf://） ---------- */
  const MIME_BY_EXT = { png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', tif: 'image/tiff', tiff: 'image/tiff' };
  const mimeOf = (meta) => {
    if (meta.file && meta.file.type) return meta.file.type;
    return MIME_BY_EXT[meta.ext] || 'image/jpeg';
  };
  const alphaMime = (meta) => (/png|gif|webp|svg/i.test(mimeOf(meta))) ? 'image/png' : 'image/jpeg';
  /** 元素可加载的 URL：File → 临时 blob URL；原生条目 → vf:// 磁盘流（无需 revoke） */
  const elURL = (meta) => meta.file
    ? global.URL.createObjectURL(meta.file)
    : (global.Native && global.Native.active ? global.Native.url(meta) : null);
  /** 只回收 blob: URL（vf:// 等非 blob 地址 revoke 无意义） */
  const revoke = (u) => {
    if (typeof u === 'string' && u.startsWith('blob:')) {
      try { global.URL.revokeObjectURL(u); } catch (e) { /* 忽略 */ }
    }
  };

  /**
   * 取图片原始字节。
   * File 直接可用；原生条目（vf://）走 fetch 拿 Blob —— 只有拿到 Blob
   * 才能走「解码即降采样」。拿不到时上层会退回 <img> 全解路径。
   */
  async function blobOf(meta) {
    if (meta.file) return meta.file;
    const url = elURL(meta);
    if (!url) return null;
    try {
      const r = await global.fetch(url);
      if (!r || !r.ok) return null;
      return await r.blob();
    } catch (e) { return null; }
  }

  /* ---------- canvas 池 + 编码 ---------- */
  const cvPool = [];
  function canvasFor(w, h) {
    const c = cvPool.pop();
    if (c) { c.cv.width = w; c.cv.height = h; return c; }
    if (typeof global.OffscreenCanvas === 'function') {
      const cv = new global.OffscreenCanvas(w, h);
      return { cv, off: true, ctx: null };
    }
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    return { cv, off: false, ctx: null };
  }
  function putCanvas(c) { if (cvPool.length < DECODE_CONCURRENCY) cvPool.push(c); }

  function encodeBlob(cv, off, mime, q) {
    return new Promise((resolve) => {
      try {
        if (off && cv.convertToBlob) {
          cv.convertToBlob({ type: mime, quality: q }).then((b) => resolve(b || null), () => resolve(null));
          return;
        }
        cv.toBlob((b) => resolve(b), mime, q);
      } catch (e) { resolve(null); }
    });
  }

  /** 把解码结果画进（已按目标尺寸建好的）canvas 并编码为 blob */
  async function drawAndEncode(c, src, w, h, mime, q) {
    try {
      const ctx = c.ctx || (c.ctx = c.cv.getContext('2d', { alpha: true }));
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(src, 0, 0, w, h);
      return await encodeBlob(c.cv, c.off, mime, q);
    } catch (e) { return null; }
    finally { putCanvas(c); }
  }

  function loadImageEl(meta) {
    return new Promise((resolve, reject) => {
      const url = elURL(meta);
      if (!url) { reject(new Error('decode-fail')); return; }
      const img = new Image();
      img.onload = () => { if (meta.file) global.URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { if (meta.file) global.URL.revokeObjectURL(url); reject(new Error('decode-fail')); };
      img.src = url;
    });
  }

  /**
   * 解码一张缩略图。返回
   *   { blob, dw, dh, tw, th, scaled, via }
   * dw/dh = 实际解码输出尺寸；tw/th = 原图真实尺寸（0 = 没探到）。
   * 注意 dw/dh 是缩小后的尺寸，绝不能用它当「原图尺寸」写进尺寸库。
   */
  async function decodeThumb(meta, side) {
    const release = await aquireSlot(meta.id);
    const t0 = now();
    try {
      stats.decodes++;
      const mime = alphaMime(meta);
      const q = mime === 'image/jpeg' ? 0.85 : undefined;

      // 先要知道原图尺寸才能算准降采样目标。优先用缓存/已知的，
      // 没有再花几十 KB 顺序读一次文件头（比解一张大图便宜太多）。
      let tw = meta.w > 0 ? meta.w : 0;
      let th = meta.h > 0 ? meta.h : 0;
      if (!tw && global.Loader && global.Loader.imageSize) {
        const sz = await global.Loader.imageSize(meta).catch(() => null);
        if (sz && sz.w > 0) { tw = sz.w; th = sz.h; }
      }

      const src = await blobOf(meta);
      if (src && isBitmap) {
        const opt = { imageOrientation: 'from-image', resizeQuality: 'medium' };
        if (tw > 0 && th > 0) {
          const s = Math.min(1, side / Math.max(tw, th));
          opt.resizeWidth = Math.max(1, Math.round(tw * s));
          opt.resizeHeight = Math.max(1, Math.round(th * s));
        } else {
          // 只给一边：规范要求另一边按原比例推导，不会拉伸
          opt.resizeWidth = side;
        }
        let bmp = null;
        try { bmp = await global.createImageBitmap(src, opt); } catch (e) { bmp = null; }
        if (bmp) {
          const dw = bmp.width, dh = bmp.height;
          const c = canvasFor(dw, dh);
          const out = await drawAndEncode(c, bmp, dw, dh, mime, q);
          if (bmp.close) bmp.close();
          if (out) {
            noteDecode('bitmap', msSince(t0));
            return { blob: out, dw, dh, tw, th, scaled: !(tw === dw && th === dh), via: 'bitmap' };
          }
        }
      }

      // 兜底：<img> 全量解码后画到 canvas 降采样。
      // 走这条说明拿不到 Blob（不支持 fetch 的 vf:// / 无 IIB 的环境），
      // 慢，但保证「一定能显示」。
      const img = await loadImageEl(meta);
      const iw = img.naturalWidth || img.width || 0;
      const ih = img.naturalHeight || img.height || 0;
      if (!iw || !ih) return null;
      const s = Math.min(1, side / Math.max(iw, ih));
      const ow = Math.max(1, Math.round(iw * s));
      const oh = Math.max(1, Math.round(ih * s));
      const out = await drawAndEncode(canvasFor(ow, oh), img, ow, oh, mime, q);
      if (!out) return null;
      noteDecode('img', msSince(t0));
      return { blob: out, dw: ow, dh: oh, tw: iw, th: ih, scaled: true, via: 'img' };
    } finally { release(); }
  }

  /** 落盘缓存的键＝条目 id（已含 文件夹│相对路径│大小│修改时间，天然区分内容）。
      刻意不把尺寸档位编进键里：每条目只留一份、且只留「见过的最大的那份」。
      否则同一张图在不同布局下会各存一份，第二次打开很容易「档位对不上」而白解码一次。 */
  const thumbStore = () => (global.Loader && global.Loader.thumbCache) || null;

  /* ---------- 对外 API ---------- */
  const Thumbs = {

    /**
     * 缩略图 URL（内存 → 磁盘 → 解码 三级查找）。
     * 请求的显示宽度会先向上取档，档内变化不触发重解；
     * 若之后请求到更大档，会重新解码并替换缓存（旧 URL 立即 revoke）。
     */
    async thumbURL(meta, cssW) {
      if (meta.bad) return null;
      const dpr = Math.min(global.devicePixelRatio || 1, 2);
      const side = bucketOf(Math.min(MAX_THUMB, Math.max(96, Math.round((cssW || 200) * dpr))));
      for (;;) {
        const hit = thumbs.get(meta.id);
        if (hit && hit.side >= side) { stats.memHits++; return hit.url; }
        let gen = pending.get(meta.id);
        if (!gen) {
          gen = (async () => {
            try {
              const store = thumbStore();
              // 第二层：磁盘。缓存里的档位 ≥ 需要的档位就能直接用（尺寸大一点不影响显示），
              // 命中即完全不解码 —— 这是「同一个文件夹第二次打开」几乎瞬时出图的原因。
              let cached = null;
              if (store) {
                cached = await store.get(meta.id);
                if (cached && cached.blob && cached.side >= side) {
                  const url = global.URL.createObjectURL(cached.blob);
                  const old = thumbs.get(meta.id);
                  thumbs.set(meta.id, { url, side: cached.side });
                  if (old && old.url && old.url !== url) revoke(old.url);
                  stats.diskHits++;
                  return url;
                }
              }
              stats.misses++;
              const res = await decodeThumb(meta, side);
              if (!res || !res.blob) throw new Error('decode-fail');
              // 尺寸记录：能拿到原图真实尺寸就写绝对值，否则只写比例
              // （缩略图是被降采样过的，它的像素尺寸绝不是原图尺寸）
              if (global.Loader) {
                if (res.tw > 0 && res.th > 0 && res.tw !== res.dw) global.Loader.recordDims(meta, res.tw, res.th);
                else if (res.dw > 0) global.Loader.recordRatio(meta, res.dw, res.dh);
              }
              const old = thumbs.get(meta.id);
              const url = global.URL.createObjectURL(res.blob);
              thumbs.set(meta.id, { url, side });
              if (old && old.url && old.url !== url) revoke(old.url);
              // 只留「见过的最大的那份」：否则一次小尺寸布局会把高清缓存降级掉
              if (store && (!cached || cached.side < side)) store.put(meta.id, res.blob, side);
              return url;
            } catch (e) {
              meta.state = 'error';
              if (!meta._errEmitted) { meta._errEmitted = true; State.bus.emit('item-error', { id: meta.id }); }
              return null;
            } finally {
              pending.delete(meta.id);
            }
          })();
          pending.set(meta.id, gen);
        }
        const url = await gen;
        if (!url) return null;
        // 本代尺寸不够（有更大请求在路上 / 缓存被更高清覆盖）→ 再取一代
        const h2 = thumbs.get(meta.id);
        if (h2 && h2.side >= side) return h2.url;
      }
    },

    /** 原图 URL（Lightbox / 单列大图共用缓存） */
    bigURL(meta) {
      if (meta.bad) return null;
      const hit = bigs.get(meta.id);
      if (hit) return hit.url;
      const url = elURL(meta); // File → blob URL；原生条目 → vf:// 磁盘流
      if (!url) return null;
      bigs.set(meta.id, { url });
      return url;
    },

    /** 静默预取相邻图 */
    preloadBig(meta) {
      if (!meta || meta.bad) return;
      if (global.requestIdleCallback) {
        global.requestIdleCallback(() => { Thumbs.bigURL(meta); }, { timeout: 2500 });
      } else {
        setTimeout(() => { Thumbs.bigURL(meta); }, 150);
      }
    },

    /** 取"够屏幕显示"的位图（灯箱用；见上面 screenURL 的注释） */
    screenURL,

    /**
     * 同步看一眼"代"在不在缓存里（不生成）。
     * 灯箱用它决定：备好了就直接上代（切图 2–15ms）；没备好就**先上原图**
     * —— 生成一代要 130–630ms（48MP 尤其慢，比直接解原图还贵），
     * 绝不能为了"用上代"让用户先等这一段。原图先顶上，代在后台备着，下次翻回来就快了。
     */
    screenPeek(meta, cssW) {
      if (!meta || meta.bad) return null;
      const dpr = Math.min(global.devicePixelRatio || 1, 2);
      const side = screenBucket(Math.max(320, Math.round((cssW || 1200) * dpr)));
      const hit = screens.get(meta.id);
      return screenOk(hit, side) ? hit : null;
    },

    /**
     * 同步看一眼「缩略图在不在内存里」，命中返回 URL，没命中返回 null。**绝不生成。**
     *
     * 为什么要这个（v1.20.8）：连翻时原来直接 `await thumbURL(meta, 148)`，
     * 没命中就当场解码原图 + 缩放 + 编码（24MP 约 30–50ms、48MP 几百 ms）。
     * 可等它 resolve 时用户往往已经又按了一下，`still()` 变假 → 这份工作**整个白做**，
     * 却实实在在抢了 CPU。实测 Downloads（15 张）连翻 45 次里 miss 了 25 次，
     * 全是这种白干。
     *
     * 现在连翻分支只用 peek：命中就铺缩略图（微任务级），没命中就直接解原图 ——
     * 小图（≤2MP）解原图只要 10–20ms，比现场生成缩略图更快、还更清晰。
     */
    thumbPeek(meta, cssW) {
      if (!meta || meta.bad) return null;
      const dpr = Math.min(global.devicePixelRatio || 1, 2);
      const side = bucketOf(Math.min(MAX_THUMB, Math.max(96, Math.round((cssW || 200) * dpr))));
      const hit = thumbs.get(meta.id);
      return (hit && hit.side >= side) ? hit.url : null;
    },

    /**
     * 预取相邻图的**屏幕尺寸代**。
     * near=true（紧邻的上一张/下一张）尽快排队，用户下一步很可能就切过去；
     * near=false（隔一张）等空闲，别和当前这张抢解码槽。
     * 注意预取的是"代"而不是原图：一代只有原图 1/40 的像素，几十毫秒就能备好，
     * 内存也只有十几 MB —— 直接预取 24MP 原图要 96MB/张，三张就 300MB 起。
     *
     * **一次只跑一个**（v1.20.6）。生成一代是重活（24MP 约 170ms、48MP 能到 900ms），
     * 两个并发就会和"正在显示那张的解码"抢 CPU —— 实测把 24MP 的首次显示从 89ms
     * 拖到 188ms、48MP 从 288ms 拖到 438ms，比 v1.13.0 还慢。串成一条链之后，
     * 预取只是把空档填满，不会再压到用户正在等的那一帧上。
     */
    preloadScreen(meta, cssW, near) {
      if (!meta || meta.bad) return;
      const run = () => {
        screenChain = screenChain.then(() => {
          if (!meta || meta.bad) return null;
          return screenURL(meta, cssW).catch(() => null);
        });
        return screenChain;
      };
      if (near) setTimeout(run, 40);
      else if (global.requestIdleCallback) global.requestIdleCallback(run, { timeout: 2000 });
      else setTimeout(run, 400);
    },

    /** 网格把当前可视区条目 id 报进来 → 解码槽优先服务这些图 */
    setDesired,

    /** 性能计数（探针用） */
    stats: () => Object.assign({}, stats, { screensSize: screens.map.size, screensCap: screens.cap }),
    resetStats() { stats.decodes = 0; stats.memHits = 0; stats.diskHits = 0; stats.misses = 0; stats.screenHits = 0; stats.screenMakes = 0; },

    releaseBig(id) {
      const v = bigs.get(id);
      if (v) { bigs.map.delete(id); if (v.url) global.URL.revokeObjectURL(v.url); }
    },

    /** 彻底丢弃某个条目的缩略图/原图缓存（文件被删除后调用） */
    forget(id) {
      if (!id) return;
      const t = thumbs.get(id);
      if (t && t.url) revoke(t.url);
      thumbs.map.delete(id);
      const b = bigs.get(id);
      if (b && b.url) revoke(b.url);
      bigs.map.delete(id);
      const s = screens.get(id);
      if (s && s.url) revoke(s.url);
      screens.map.delete(id);
      pending.delete(id);
    },

    /** 切换文件夹时清空内存缓存（磁盘缓存保留，供下次直接命中） */
    clearAll() {
      thumbs.clear(); bigs.clear(); screens.clear(); pending.clear();
      desired = new Set();
    },
  };

  global.Thumbs = Thumbs;
})(window);
