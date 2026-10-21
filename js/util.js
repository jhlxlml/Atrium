/* ============================================================
   Atrium · util.js
   工具集：DOM helper / 中文自然排序 / 格式化 / 能力检测 / 事件
   ============================================================ */
(function (global) {
  'use strict';

  const U = {};

  /* ---------- DOM ---------- */
  U.$ = (sel, root) => (root || document).querySelector(sel);
  U.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /** 轻量 HTML 转义（用于把文件名安全放进 innerHTML） */
  U.esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /** 图标 <svg><use> 片段 */
  U.icon = (id, cls) => `<svg class="${cls || ''}" aria-hidden="true"><use href="#${id}"/></svg>`;

  /* ---------- 动效偏好 ----------
     CSS 侧的"减少动态效果"由 main.css 的 @media (prefers-reduced-motion) 统一兜住
     （三份 CSS 都在同一个文档里，那条 `*` 规则对灯箱、相框同样生效）。
     但它管不到 **JS 驱动的滚动** —— scrollTo({behavior:'smooth'}) 该滑还是滑。
     所以滚动调用点统一取 U.scrollBehavior()，不要再各自写死 'smooth'。

     两个来源都算"要静止"：系统级 prefers-reduced-motion，以及应用内设置
     body[data-anim="0"]（设置 → 外观 → 关闭过渡动画）。用户关了一次动效，
     不该只关掉 CSS 那一半、留下滚动还在滑。 */
  U.reducedMotion = () => {
    if (document.body && document.body.dataset.anim === '0') return true;
    try { return global.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (e) { return false; }
  };
  U.scrollBehavior = () => (U.reducedMotion() ? 'auto' : 'smooth');

  /* ---------- 排序 ---------- */
  const COLLATOR = typeof Intl !== 'undefined' && Intl.Collator
    ? new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })
    : null;

  /** 中文友好的自然比较（"img2" < "img10"） */
  U.naturalCompare = (a, b) => (COLLATOR ? COLLATOR.compare(a, b) : (a < b ? -1 : a > b ? 1 : 0));

  /* ---------- 格式化 ---------- */
  U.fmtBytes = (n) => {
    if (n == null || n < 0) return '';
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n, i = -1;
    do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
    return (v >= 100 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
  };

  U.fmtDate = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  U.clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  /* ---------- 延迟工具 ---------- */
  U.debounce = (fn, wait) => {
    let t = 0;
    return function (...a) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, a), wait);
    };
  };

  U.rafThrottle = (fn) => {
    let pending = false, lastArgs = null;
    return function (...a) {
      lastArgs = a;
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        fn.apply(this, lastArgs);
      });
    };
  };

  /** requestIdleCallback 带超时降级 */
  U.idle = (fn, timeout) => {
    if (global.requestIdleCallback) return global.requestIdleCallback(fn, { timeout: timeout || 120 });
    const start = Date.now();
    return setTimeout(() => fn({ timeRemaining: () => Math.max(0, 60 - (Date.now() - start)) }), 1);
  };
  U.cancelIdle = (id) => {
    if (global.cancelIdleCallback) global.cancelIdleCallback(id);
    else clearTimeout(id);
  };

  /* ---------- 框选（marquee） ---------- */
  /**
   * 在容器内按下并拖出一个矩形选框，实时回调命中的元素。
   * 用于网格批量选择 / 回收站批量勾选 —— 两处共用同一套交互语义：
   *   · 左键按下（且未被 shouldStart 拒绝）后，位移超过 5px 才正式进入框选，
   *     因此普通点击、拖拽图片都不会误触发；
   *   · 拖到视口上下边缘时自动滚动，可以跨屏选择；
   *   · 松手即结束；Esc 中途取消。
   *
   * opts = {
   *   root:        监听事件的容器（mousedown 落在这里才生效）
   *   box:         选框元素（由调用方提供，本函数只负责定位与显隐）
   *   toLocal:     (clientX, clientY) -> {x,y} 换算到选框父容器坐标系
   *   shouldStart: (e) => bool，返回 false 则本次按下完全不参与（如点按钮）
   *   onMove:      (rect, e) => void，rect = {x1,y1,x2,y2}（已归一化）
   *   onEnd:       (rect|null, moved) => void，moved=false 表示只是点了一下
   * }
   * 返回一个 dispose 函数。
   */
  U.dragSelect = function (opts) {
    const root = opts.root, box = opts.box;
    if (!root || !box) return () => {};
    const THRESH = 5, EDGE = 56, STEP = 26;
    let st = null;   // {x0,y0,ox,oy,moved,rect}
    let scrollId = 0;

    // 归一化区间：统一返回 { lo, hi }（不再复用 x1/x2 这种轴向命名，
    // 避免纵向区间被误读成 hy.y1/hy.y2 而取到 undefined —— 那会让选框高度恒为 0）。
    const norm = (a, b) => (a <= b ? { lo: a, hi: b } : { lo: b, hi: a });
    const toLocal = opts.toLocal || ((cx, cy) => ({ x: cx, y: cy }));

    function place(rect) {
      box.style.left = rect.x1 + 'px';
      box.style.top = rect.y1 + 'px';
      box.style.width = (rect.x2 - rect.x1) + 'px';
      box.style.height = (rect.y2 - rect.y1) + 'px';
    }

    function stopScroll() { if (scrollId) { clearInterval(scrollId); scrollId = 0; } }

    function autoScroll(clientY) {
      const h = global.innerHeight;
      let dir = 0;
      if (clientY < EDGE) dir = -1;
      else if (clientY > h - EDGE) dir = 1;
      if (!dir) { stopScroll(); return; }
      if (scrollId) return;
      scrollId = setInterval(() => { global.scrollBy(0, dir * STEP); }, 32);
    }

    function onDown(e) {
      if (e.button !== 0) return;
      // 自愈：上一次拖拽若因 mouseup 丢失（在窗口外松开 / 被其它元素吞掉 /
      // 窗口失焦）而卡在“已按下”状态，下次按下时先收尾，避免框选从此永久失效。
      if (st) finish(true);
      if (opts.shouldStart && !opts.shouldStart(e)) return;
      const p = toLocal(e.clientX, e.clientY);
      st = { x0: p.x, y0: p.y, moved: false, rect: null };
      // 立即把选框锚定到按下点（0 尺寸），随后 mousemove 时实时拉伸、跟随鼠标。
      // 这样即使在网格边缘/留白处起手，也能立刻看到选框随光标生长。
      box.hidden = false;
      place({ x1: p.x, y1: p.y, x2: p.x, y2: p.y });
    }

    function onMove(e) {
      if (!st) return;
      const p = toLocal(e.clientX, e.clientY);
      const dx = Math.abs(p.x - st.x0), dy = Math.abs(p.y - st.y0);
      if (!st.moved && dx < THRESH && dy < THRESH) return;
      if (!st.moved) {
        st.moved = true;
        box.hidden = false;
        document.body.classList.add('marquee-on');
      }
      const hx = norm(st.x0, p.x), hy = norm(st.y0, p.y);
      const rect = { x1: hx.lo, y1: hy.lo, x2: hx.hi, y2: hy.hi };
      st.rect = rect;
      place(rect);
      if (opts.onMove) opts.onMove(rect, e);
      autoScroll(e.clientY);
    }

    function finish(cancel) {
      if (!st) return;
      const s = st;
      st = null;
      stopScroll();
      box.hidden = true;
      document.body.classList.remove('marquee-on');
      if (opts.onEnd) opts.onEnd(cancel ? null : s.rect, s.moved);
    }

    function onUp() { finish(false); }
    function onKey(e) { if (e.key === 'Escape' && st) { e.stopPropagation(); finish(true); } }

    // 窗口失焦 / 切到后台时若还卡在拖拽中（mouseup 多半已丢失），立即收尾，
    // 否则回到前台后“按下去却框不出来”，必须再点一下才恢复。
    function onBlur() { if (st) finish(true); }
    function onVis() { if (document.hidden && st) finish(true); }

    root.addEventListener('mousedown', onDown);
    global.addEventListener('mousemove', onMove);
    global.addEventListener('mouseup', onUp);
    global.addEventListener('keydown', onKey, true);
    global.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVis);
    return function dispose() {
      root.removeEventListener('mousedown', onDown);
      global.removeEventListener('mousemove', onMove);
      global.removeEventListener('mouseup', onUp);
      global.removeEventListener('keydown', onKey, true);
      global.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVis);
      stopScroll();
    };
  };

  /* ---------- 能力检测 ----------
     只保留仍在用的项。fsAccess / fileSystem 随 File System Access 通路一并移除：
     Electron 版打开文件夹走主进程原生对话框，不再依赖网页目录句柄。 */
  U.can = {
    createImageBitmap: typeof global.createImageBitmap === 'function',
    ResizeObserver: typeof global.ResizeObserver === 'function',
    IntersectionObserver: typeof global.IntersectionObserver === 'function',
    colorMix: CSS && CSS.supports && CSS.supports('background', 'color-mix(in srgb, red 50%, blue)'),
  };

  /* ---------- 文件相关 ---------- */
  /** 文件名（去扩展名） */
  U.stem = (name) => {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(0, i) : name;
  };
  /** 扩展名小写 */
  U.ext = (name) => {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(i + 1).toLowerCase() : '';
  };

  /** 允许索引的图片扩展名（浏览器可解码集合 + 常见补充；HEIC 会被识别但标记不可用） */
  const IMG_EXT = new Set(['jpg','jpeg','png','gif','webp','bmp','avif','svg','ico','tif','tiff','heic','heif','jfif']);
  U.isImageExt = (name) => IMG_EXT.has(U.ext(name));
  U.isHeic = (name) => { const e = U.ext(name); return e === 'heic' || e === 'heif'; };

  /* ---------- 从文件头读原始像素尺寸（不解码） ----------
     缩略图解码改成「解码即降采样」之后，解码产物已经是被缩小过的位图，
     拿不到原图真实宽高；而网格首屏布局要的是宽高比、尺寸库要的是真实宽高。
     为了尺寸去全量解码一张 5000×4000 的图非常不划算 —— 而 JPEG 的 SOF 段、
     PNG 的 IHDR、GIF 的逻辑屏幕、BMP 的 DIB 头、WebP 的 VP8X/VP8/VP8L
     都把尺寸写在文件最前面，读几十 KB 就能拿到，比解码快好几个数量级。
     纯函数、零 DOM 依赖，可单测。返回 {w,h}；认不出或流不完整返回 null。 */
  const rd24 = (d, o) => (d.getUint8(o) | (d.getUint8(o + 1) << 8) | (d.getUint8(o + 2) << 16)) >>> 0;

  U.sizeFromHeader = (input) => {
    try { return sizeFromHeader(input); } catch (e) { return null; }   // 坏数据一律当作认不出
  };

  function sizeFromHeader(input) {
    if (!input) return null;
    let b;
    if (input instanceof Uint8Array) b = input;
    else if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) b = new Uint8Array(input);
    else if (input.buffer) b = new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength);
    else return null;
    const n = b.length;
    if (n < 10) return null;
    const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const ok = (w, h) => (w > 0 && h > 0 && w < 1e6 && h < 1e6) ? { w, h } : null;

    // PNG：魔数 + IHDR（宽高各 4 字节大端，固定在第 16 / 20 字节）
    if (n >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) {
      return ok(d.getUint32(16), d.getUint32(20));
    }
    // GIF：GIF87a / GIF89a，逻辑屏幕宽高（小端 16 位）
    if (n >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
      return ok(d.getUint16(6, true), d.getUint16(8, true));
    }
    // BMP：BM + 两种 DIB 头
    if (n >= 26 && b[0] === 0x42 && b[1] === 0x4D) {
      const hdr = d.getUint32(14, true);
      if (hdr >= 40) return ok(d.getInt32(18, true), Math.abs(d.getInt32(22, true)));
      if (hdr === 12) return ok(d.getUint16(18, true), d.getUint16(20, true));
      return null;
    }
    // WebP：RIFF....WEBP，三种子格式（VP8L 的尺寸字段只到第 25 字节，Guard 要放宽）
    if (n >= 21 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
      const cc = String.fromCharCode(b[12], b[13], b[14], b[15]);
      if (cc === 'VP8X') { if (n < 30) return null; return ok(1 + rd24(d, 24), 1 + rd24(d, 27)); }
      if (cc === 'VP8 ') {
        if (n < 30) return null;
        // 关键帧起始码 9d 01 2a，其后 14 位宽、14 位高
        if (b[23] === 0x9D && b[24] === 0x01 && b[25] === 0x2A) {
          return ok(d.getUint16(26, true) & 0x3FFF, d.getUint16(28, true) & 0x3FFF);
        }
        return null;
      }
      if (cc === 'VP8L') {
        if (n < 25 || b[20] !== 0x2F) return null;
        // 0x2f 签名后 28 位打包（低 14 位宽-1，高 14 位高-1）
        const bits = d.getUint32(21, true);
        return ok(1 + (bits & 0x3FFF), 1 + ((bits >>> 14) & 0x3FFF));
      }
      return null;
    }
    // JPEG：SOI 之后逐段走，遇到带尺寸的 SOFn（C0..CF，排除 C4/C8/CC）
    if (n >= 4 && b[0] === 0xFF && b[1] === 0xD8) {
      let p = 2;
      while (p + 4 <= n) {
        if (b[p] !== 0xFF) { p++; continue; }
        let q = p + 1;
        while (q < n && b[q] === 0xFF) q++;      // 段间允许填充 FF
        if (q >= n) break;
        const m = b[q];
        p = q + 1;                                // p 指向「段长」字段
        if (m === 0x01 || (m >= 0xD0 && m <= 0xD7)) continue;   // 无长度字段
        if (m === 0xD9 || m === 0xDA) break;      // EOI / 进熵编码区，之后无尺寸
        if (p + 2 > n) break;
        const len = d.getUint16(p, false);
        if (len < 2) break;
        if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
          if (p + 7 > n) break;
          return ok(d.getUint16(p + 5), d.getUint16(p + 3));    // 高在 +3，宽在 +5
        }
        p += len;
      }
      return null;
    }
    return null;
  };

  /* ---------- HEIC/HEIF 可解码性探测（P1-2） ----------
     以前是无条件把 .heic/.heif 标成 bad，于是「机器上真的装了 HEVC 解码器、
     Chromium 能正常显示」的用户也被判死。现在改为运行时能力探测：
       - 优先用 WebCodecs 的 ImageDecoder.isTypeSupported('image/heic'|'image/heif')，
         这条返回的正是「当前平台解码器是否可用」的真实答案；
       - 环境没有 ImageDecoder（老内核 / 非安全上下文）时保守判为不支持；
     结果全程只探一次并缓存，同步可读（heicStatus），异步可等（heicReady）。 */
  let _heicResult = null;   // null = 尚未探出 / true = 可解 / false = 不可解
  let _heicProbe = null;
  U.heicTypes = { heic: false, heif: false };
  /** 同步读探测结果：true 仅有在「确知可解」时；null 表示还没探出来 */
  U.heicStatus = () => _heicResult;
  /** 是否确知可解（未探出时一律按不可解处理，保持旧行为不倒退） */
  U.heicSupported = () => _heicResult === true;
  U.probeHeic = function () {
    if (_heicProbe) return _heicProbe;
    _heicProbe = (async () => {
      const out = { heic: false, heif: false };
      try {
        const ID = global.ImageDecoder;
        if (ID && typeof ID.isTypeSupported === 'function') {
          out.heic = !!(await ID.isTypeSupported('image/heic').catch(() => false));
          out.heif = !!(await ID.isTypeSupported('image/heif').catch(() => false));
        }
      } catch (e) { /* 探测本身失败 → 保守为不可解 */ }
      U.heicTypes = out;
      _heicResult = !!(out.heic || out.heif);
      return _heicResult;
    })();
    return _heicProbe;
  };
  /** 等探测结果（已在跑就复用同一个 Promise） */
  U.heicReady = () => _heicProbe || U.probeHeic();
  U.probeHeic();            // 启动即探，索引通常晚于它完成

  /** 简单可解码性探测（magic number），返回 true=确定不支持 / false=未知或支持 */
  U.sniffUndecodable = async (file) => {
    try {
      const head = file.slice(0, 12);
      const buf = new Uint8Array(await head.arrayBuffer());
      const b = (i) => buf[i];
      // HEIC: ftyp box + heic/heix/hevc/mif1 brands
      if (b(4) === 0x66 && b(5) === 0x74 && b(6) === 0x79 && b(7) === 0x70) {
        const s = String.fromCharCode(b(8), b(9), b(10), b(11));
        if (/^(heic|heix|hevc|mif1|msf1)$/.test(s)) return true;
      }
      if (buf.length >= 8) {
        // JPEG SOI
        if (b(0) === 0xff && b(1) === 0xd8) return false;
        // PNG
        if (b(0) === 0x89 && String.fromCharCode(b(1), b(2), b(3)) === 'PNG') return false;
        // GIF
        if (String.fromCharCode(b(0), b(1), b(2)) === 'GIF') return false;
        // WebP RIFF....WEBP
        if (String.fromCharCode(b(0), b(1), b(2), b(3)) === 'RIFF' &&
            String.fromCharCode(b(8), b(9), b(10), b(11)) === 'WEBP') return false;
        // BMP
        if (String.fromCharCode(b(0), b(1)) === 'BM') return false;
        // TIFF
        if (String.fromCharCode(b(0), b(1)) === 'II' || String.fromCharCode(b(0), b(1)) === 'MM') return false;
      }
      return false; // 其余交给 img 解码结果判断
    } catch (e) { return false; }
  };

  /** 根据 relativePath 片段猜测文件夹名（多入口场景） */
  U.folderNameFromPath = (p) => {
    if (!p) return '图片';
    const seg = p.split('/').filter(Boolean);
    return seg[0] || '图片';
  };

  /** 持久 ID：在“文件夹签名 + 相对路径 + 大小 + 时间”上稳定 */
  U.itemId = (folder, rel, size, mtime) => `${folder}│${rel}│${size}│${mtime}`;

  global.Util = U;
})(window);
