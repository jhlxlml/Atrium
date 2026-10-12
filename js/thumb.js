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
  const pending = new Map();           // id -> Promise<string|null>

  /* 计数供性能探针断言（不参与业务逻辑） */
  const stats = { decodes: 0, memHits: 0, diskHits: 0, misses: 0, viaBitmap: 0, viaImg: 0, lastMs: 0, maxMs: 0 };
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

    /** 网格把当前可视区条目 id 报进来 → 解码槽优先服务这些图 */
    setDesired,

    /** 性能计数（探针用） */
    stats: () => Object.assign({}, stats),
    resetStats() { stats.decodes = 0; stats.memHits = 0; stats.diskHits = 0; stats.misses = 0; },

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
      pending.delete(id);
    },

    /** 切换文件夹时清空内存缓存（磁盘缓存保留，供下次直接命中） */
    clearAll() {
      thumbs.clear(); bigs.clear(); pending.clear();
      desired = new Set();
    },
  };

  global.Thumbs = Thumbs;
})(window);
