/* 灯箱"屏幕尺寸代"的回归锁。
 *
 * 背景（v1.20.4 之后修的）：灯箱按「自然尺寸 + transform 缩放」显示，6000×4000 的照片
 * 在窗口里实际只占 938px，可浏览器必须先把整张 24MP 解出来才画得出第一帧。
 * 实测真实 exe：解 24MP 要 130ms、48MP 要 265ms，而且**冷热一样慢**（这么大的位图
 * 留不住缓存），于是每切一张都要转圈 150–300ms。
 *
 * 修法：用 createImageBitmap 的 resizeWidth/Height 让解码器直接吐一个屏幕尺寸的位图
 * （与网格缩略图同一条路），真要看 1:1 时再换回原图。
 *
 * 这个探针**在运行时生成大图**（纯 Node + zlib 写 PNG），不往仓库塞几 MB 的夹具：
 * 断言只关心"路径有没有走对、尺寸有没有被污染、换原图时画面跳不跳"，与文件大小无关，
 * 但必须让原图**明显大于屏幕档位**，否则走不到"代"这条路（现有夹具全是几 KB 的小图，
 * 在它们身上这套逻辑只会命中 full=true 的直通分支，等于没测）。
 */
const { app, BrowserWindow, protocol } = require('electron');
require('./_desktop_stub').stubDesktop();
const path = require('path'); const fs = require('fs');
const zlib = require('zlib');

const APPDIR = path.resolve(__dirname, '..', '..', '..');
const TMP = path.resolve(__dirname, '..', 'logs', 'lbscreen_' + Date.now());

app.setPath('userData', path.resolve(__dirname, '..', 'logs', 'ud_lbscreen_' + Date.now()));
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
protocol.registerSchemesAsPrivileged([{ scheme: 'vf', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true } }]);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' };

/* ---------- 最小 PNG 编码器（8bit RGB、无滤波），只为造一张"像素够多"的原图 ---------- */
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  const v = (typeof zlib.crc32 === 'function') ? zlib.crc32(body) : crc32Manual(body);
  crc.writeUInt32BE(v >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}
let CRC_TABLE = null;
function crc32Manual(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function writePNG(file, w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const off = y * (w * 3 + 1);
    raw[off] = 0;                       // filter: none
    for (let x = 0; x < w; x++) {
      const p = off + 1 + x * 3;
      raw[p] = (x * 255 / w) | 0;
      raw[p + 1] = (y * 255 / h) | 0;
      raw[p + 2] = (x ^ y) & 0xFF;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
  return png.length;
}

app.whenReady().then(async () => {
  protocol.handle('vf', async (req) => {
    const u = new URL(req.url);
    if (u.host === 'pic') {
      const abs = Buffer.from(decodeURIComponent(u.pathname).replace(/^\/+/, ''), 'base64url').toString('utf8');
      try {
        const b = await fs.promises.readFile(abs);
        return new Response(b, { headers: { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'access-control-allow-origin': 'vf://app' } });
      } catch (e) { return new Response('404', { status: 404 }); }
    }
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const abs = path.resolve(APPDIR, rel || 'index.html');
    if (!abs.startsWith(APPDIR)) return new Response('403', { status: 403 });
    try {
      const b = await fs.promises.readFile(abs);
      return new Response(b, { headers: { 'content-type': (MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream') } });
    } catch (e) { return new Response('404', { status: 404 }); }
  });

  fs.mkdirSync(TMP, { recursive: true });
  const specs = [
    { n: 'big-a.png', w: 2600, h: 1800 },
    { n: 'big-b.png', w: 3200, h: 2000 },
    { n: 'big-c.png', w: 2600, h: 1800 },   // 尺寸故意不告诉应用（meta.w/h=0）
    /* 小图：1.26MP。连翻时**不该**铺缩略图（v1.20.8）—— 它解码只要十几毫秒，
       铺一张 320px 的糊图再换回来，反而让人看到"先糊一下"。 */
    { n: 'small.png', w: 1400, h: 900 },
    /* 更小的图：最长边 900，**小于**屏幕档位 1280 —— 走"原图不比档位大就直接给原图"
       那一支（v1.20.9 修的缓存契约就在这一支上）。 */
    { n: 'tiny.png', w: 900, h: 600 },
  ];
  const files = specs.map((s) => {
    const abs = path.join(TMP, s.n);
    const bytes = writePNG(abs, s.w, s.h);
    return { abs, w: s.w, h: s.h, bytes };
  });

  const w = new BrowserWindow({ width: 1440, height: 900, show: true,
    webPreferences: { preload: path.join(APPDIR, 'deploy', 'electron', 'preload.js'), contextIsolation: true } });
  await w.loadURL('vf://app/index.html');
  await new Promise((r) => setTimeout(r, 900));

  const R = { fixtures: files.map((f) => ({ n: path.basename(f.abs), w: f.w, h: f.h, kb: Math.round(f.bytes / 1024) })) };

  /* 前两张带 w/h（真实应用从尺寸库/文件头知道），第三张不给 —— 验"尺寸未知时不许拿代的尺寸充数" */
  await w.webContents.executeJavaScript(`(() => {
    const S = window.State, A = window.App;
    S.sources = [{ id: 's0', name: 'big', root: 'C:/x' }];
    S.items = [
      { id: 'b0', name: 'big-a.png', src: 'all', sid: 's0', size: 1, path: ${JSON.stringify(files[0].abs)}, ext: 'png', lastModified: 1, state: 'idle', w: 2600, h: 1800 },
      { id: 'b1', name: 'big-b.png', src: 'all', sid: 's0', size: 1, path: ${JSON.stringify(files[1].abs)}, ext: 'png', lastModified: 1, state: 'idle', w: 3200, h: 2000 },
      { id: 'b2', name: 'big-c.png', src: 'all', sid: 's0', size: 1, path: ${JSON.stringify(files[2].abs)}, ext: 'png', lastModified: 1, state: 'idle', w: 0, h: 0 },
      { id: 'b3', name: 'small.png', src: 'all', sid: 's0', size: 1, path: ${JSON.stringify(files[3].abs)}, ext: 'png', lastModified: 1, state: 'idle', w: 1400, h: 900 },
      { id: 'b4', name: 'tiny.png', src: 'all', sid: 's0', size: 1, path: ${JSON.stringify(files[4].abs)}, ext: 'png', lastModified: 1, state: 'idle', w: 900, h: 600 }
    ];
    S.sourceCount = () => S.items.length;
    A.showGallery(); A.renderSources(); document.getElementById('topbar').hidden = false;
    return S.items.length;
  })()`);
  await new Promise((r) => setTimeout(r, 800));

  /* 打开第 0 张。此时第 1 张还没有代 —— 先把"没有代"记下来，再看预取之后有没有。
     注意这里**不手动调用 screenURL**：要验的是"灯箱自己有没有预取"，
     手动造一张会把预取这条路整个盖住（第一版就栽在这儿，反向实验红的是别的断言）。 */
  R.before = await w.webContents.executeJavaScript(`(async () => {
    const L = window.Lightbox, T = window.Thumbs;
    const need = L._needPx(State.items[1]);
    const peek0 = T.screenPeek(State.items[1], need);
    L.open(State.items, State.items[0]);
    // 停留预取的阈值是 900ms，这里给足 2.4s 再验
    await new Promise((r) => setTimeout(r, 2400));
    const peek1 = T.screenPeek(State.items[1], need);
    return {
      peekBeforePrefetch: peek0 ? 'has' : null,
      peekAfterPrefetch: peek1 ? { w: peek1.w, h: peek1.h, full: peek1.full } : null,
      need,
      dpr: window.devicePixelRatio,
      nat0: document.getElementById('lbImg').naturalWidth,
      orig0: L.origW, metaW0: State.items[0].w,
      full0: L._full,
    };
  })()`);

  /* 切到第 1 张：应当直接命中"预取好的代" */
  R.swap = await w.webContents.executeJavaScript(`(async () => {
    const L = window.Lightbox, img = document.getElementById('lbImg');
    L.nav(1);
    await new Promise((r) => setTimeout(r, 60));
    await new Promise((r) => { if (img.complete) return r(); img.addEventListener('load', r, { once: true }); });
    await img.decode().catch(() => {});
    const r = img.getBoundingClientRect();
    return {
      natW: img.naturalWidth, natH: img.naturalHeight,
      origW: L.origW, origH: L.origH,
      metaW: L.meta && L.meta.w, metaH: L.meta && L.meta.h,
      full: L._full,
      boxW: Math.round(r.width), boxH: Math.round(r.height),
      pct: document.getElementById('lbPct').textContent,
      base: +L.base.toFixed(4), scale: +L.scale.toFixed(4),
    };
  })()`);

  /* 代里到底带没带原图真实尺寸（上面那次是预取出来的，这里单独看一眼 rec） */
  R.make = await w.webContents.executeJavaScript(`(async () => {
    const T = window.Thumbs, L = window.Lightbox;
    const need = L._needPx(State.items[1]);
    const t0 = performance.now();
    const rec = await T.screenURL(State.items[1], need);
    const ms = performance.now() - t0;
    const peek = T.screenPeek(State.items[1], need);
    return {
      ms: Math.round(ms),
      full: rec && rec.full,
      recW: rec && rec.w, recH: rec && rec.h,
      tw: rec && rec.tw, th: rec && rec.th,
      peeked: !!peek,
      peekSame: !!(peek && rec && peek.url === rec.url),
    };
  })()`);

  /* 放大到超过"代"的 1:1：应当换回原图，且**屏幕上尺寸不变**。
     对照要取"放大之后、换源之前"那一帧 —— 拿放大前的尺寸比会把"放大 4 倍"误读成"跳变"。 */
  R.zoom = await w.webContents.executeJavaScript(`(async () => {
    const L = window.Lightbox, img = document.getElementById('lbImg');
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    /* 必须放到 scale > 1（= 一个"代"像素铺到 1 个以上 CSS 像素）才会触发换原图。
       fit 时 scale 约 0.47，所以 2× 只到 0.94，还不够 —— 用 4×。 */
    L.zoomAt(4, cx, cy);
    const mid = img.getBoundingClientRect();       // 换源还没完成时的尺寸（基准）
    const midNat = img.naturalWidth;
    const upgraded = L._upgrading;
    for (let k = 0; k < 80 && L._upgrading; k++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 150));
    const after = img.getBoundingClientRect();
    return {
      upgraded,
      full: L._full,
      midNat, natW: img.naturalWidth,
      origW: L.origW,
      midW: Math.round(mid.width), afterW: Math.round(after.width),
      midH: Math.round(mid.height), afterH: Math.round(after.height),
      pct: document.getElementById('lbPct').textContent,
      scale: +L.scale.toFixed(4),
    };
  })()`);

  /* 尺寸未知的那张：代的尺寸绝不能写进条目。
     这一步**显式先把代造出来**（和上面"验灯箱自己会不会预取"那条不同，那条绝不能手动造）。
     理由：这里要验的是"屏幕上摆着一张代、而原图尺寸未知"时 `origW / meta.w` 会不会被
     代的尺寸顶掉。若让预取碰运气，很可能代还没备好就退回原图（naturalWidth 正好等于原图
     宽度），那这条就退化成"验原图"了，什么也没测到。 */
  R.unknown = await w.webContents.executeJavaScript(`(async () => {
    const L = window.Lightbox, T = window.Thumbs, img = document.getElementById('lbImg');
    const need = L._needPx(L.list[2]);
    const rec = await T.screenURL(L.list[2], need);   // 先备好，保证走的是代
    L.open(L.list, L.list[2]);
    await new Promise((r) => setTimeout(r, 60));
    for (let k = 0; k < 100; k++) {
      if (img.complete && img.naturalWidth > 0 && !L._upgrading) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 200));
    return {
      need,
      recW: rec ? rec.w : null,
      natW: img.naturalWidth,
      usedRendition: img.naturalWidth > 0 && img.naturalWidth < 2600,
      origW: L.origW,
      metaW: L.meta && L.meta.w,
      label: document.getElementById('lbCount').textContent,
    };
  })()`);

  /* 切图之后的头 250ms 里，后台**不许**为"当前这张"生成代。
     这是 v1.20.6 的核心行为：生成一代要 170–900ms，和你正在等的那一帧抢 CPU，
     实测会把 24MP 的首次显示从 89ms 拖到 188ms（比 v1.13.0 还慢）。
     做法是"停留 900ms 才预取相邻图"，当前这张根本不生成代。
     这里先打开第 0 张、**立刻**切到第 1 张（趁预取还没起来），再看 250ms 内有没有代。 */
  R.gate = await w.webContents.executeJavaScript(`(async () => {
    const L = window.Lightbox, T = window.Thumbs;
    /* 先把它从缓存里踢掉，模拟"这张从没被看过" —— 前面的步骤已经把它预取过了，
       不踢掉的话这里量到的会是"早就有代"，什么也证明不了。 */
    T.forget(L.list[1].id);
    L.open(L.list, L.list[0]);
    await new Promise((r) => setTimeout(r, 120));     // 趁 900ms 的停留预取还没触发
    const m1 = L.list[1];
    const need = L._needPx(m1);
    const before = T.stats().screenMakes;
    L.nav(1);
    await new Promise((r) => setTimeout(r, 250));
    const peekSelf = T.screenPeek(m1, need);
    const after = T.stats().screenMakes;
    return { peekSelf: peekSelf ? { w: peekSelf.w } : null, madeDelta: after - before };
  })()`);

  /* 切图时**不许把上一帧清掉**（v1.20.6）。
     以前每次切图都 `removeAttribute('src')` + 摘掉 .ld：屏幕先变空、转圈出现，
     130–300ms 之后新图才"啪"地出来 —— 这段空白就是用户说的"卡"（按了没反应）。
     现在保留旧帧让浏览器继续画，转圈延后 250ms 才出现。三件事一起验：
       ① 切图后**同一刻** .ld 还在（没被清空）
       ② 切图后 200ms 转圈仍然隐藏（快的切图不该看到转圈）
       ③ 放大过（scale>1）之后切图**必须**走老路清空 —— 否则新图第一帧会带着旧缩放
          先出现一下，看着像跳。这条是"别为了顺滑把缩放场景弄坏"的守门。 */
  R.keep = await w.webContents.executeJavaScript(`(async () => {
    const L = window.Lightbox, img = document.getElementById('lbImg');
    const spin = document.getElementById('lbSpin');
    const waitImg = async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 4000) {
        if (img.complete && img.naturalWidth > 0 && img.classList.contains('ld')) return true;
        await new Promise((r) => setTimeout(r, 30));
      }
      return false;
    };
    L.open(L.list, L.list[0]);
    await waitImg();
    L.scale = 1; L.tx = 0; L.ty = 0; L.apply(false);
    const before = {
      ld: img.classList.contains('ld'),
      src: !!img.getAttribute('src'),
      spinHidden: spin.classList.contains('hide'),
    };
    L.nav(1);
    /* 同步读：转圈是"延后 250ms 才出现"，所以切图这一刻应该有一个**挂着的定时器**
       而不是已经显示出来的转圈。这条比"200ms 时转圈是否隐藏"更硬 ——
       后者在快图（代命中，15ms 就到位）上恒真，什么也证明不了。 */
    const afterSync = {
      ld: img.classList.contains('ld'),
      src: !!img.getAttribute('src'),
      spinPending: !!L._spinT,
      spinShown: !spin.classList.contains('hide'),
    };
    await new Promise((r) => setTimeout(r, 200));
    const at200 = { spinHidden: spin.classList.contains('hide'), ld: img.classList.contains('ld') };
    await waitImg();
    /* ③ 放大到 2 倍再切：这时候必须清空 */
    L.scale = 2; L.apply(false);
    L.nav(1);
    const zoomedSync = { ld: img.classList.contains('ld'), scaleWas: 2 };
    L.scale = 1; L.tx = 0; L.ty = 0; L.apply(false);
    return { before, afterSync, at200, zoomedSync };
  })()`);

  /* 按住方向键连翻（v1.20.6）。
     键盘重复每 ~33ms 一次，而一张 24MP 要 130ms、48MP 要 245ms 才解完 ——
     每按一次就把上一次没解完的加载掐掉，于是按住的时候屏幕基本不动。
     改法：连翻期间铺**占位小图**（条带里早就解好的缩略图），停手 140ms 后再换真图。
     三件事一起验：
       ① 正常翻页（间隔 400ms）**不许**走占位分支 —— 否则正常浏览会先糊一下；
       ② 按住连翻时**每次按键都要出画面**（12 次 nav 至少 11 次 load）；
       ③ 停手之后必须换成真图（占位小图只是过渡，不能一直留着）。 */
  R.rapid = await w.webContents.executeJavaScript(`(async () => {
    const L = window.Lightbox, img = document.getElementById('lbImg');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    L.open(L.list, L.list[0]);
    await wait(700);
    /* ① 慢速：间隔 400ms，**不许**走占位分支。
       判据用 Lightbox._rec.thumb 而不是 naturalWidth —— 后者在"保留上一帧"时
       读到的是上一张的尺寸，判不出来；而 _rec 是这一刻真正挂上去的那份。 */
    const slow = [];
    for (let k = 0; k < 2; k++) {
      await wait(400);
      L.nav(1);
      await wait(40);
      slow.push({ thumb: !!(L._rec && L._rec.thumb), w: img.naturalWidth });
    }
    /* ② 连翻：间隔 33ms（模拟键盘重复） */
    let loads = 0;
    const onLoad = () => { loads++; };
    img.addEventListener('load', onLoad);
    const widths = [];
    let thumbHits = 0;
    for (let k = 0; k < 12; k++) {
      L.nav(1);
      await wait(33);
      widths.push(img.naturalWidth);
      if (L._rec && L._rec.thumb) thumbHits++;
    }
    img.removeEventListener('load', onLoad);
    const midW = img.naturalWidth;
    /* ③ 停手 600ms：占位小图必须被真图换掉 */
    await wait(600);
    const settledW = img.naturalWidth;
    /* 记下"停手之后停在哪张图上" —— 加了新夹具之后条目数变了，
       12 % n 落到的位置跟着变，只看宽度会读不出是哪张。 */
    return { slow, loads, widths, thumbHits, midW, settledW,
      endIdx: L.i, endName: L.meta && L.meta.name, endMetaW: L.meta && L.meta.w,
      endThumb: !!(L._rec && L._rec.thumb) };
  })()`);

  /* 小图（1.26MP）连翻时**不许**铺缩略图。
     理由（v1.20.8）：铺缩略图的代价不是解码，是用户看到"先糊一下、140ms 后才清晰"。
     一张 1.26MP 的图解码只要十几毫秒，画面本来就一直是清晰的。
     这里先**确保缩略图在内存里**（不然测到的是"没命中"，而不是"命中但不铺"，
     两者完全不同），再用 <100ms 的间隔连翻过去，看最终挂上去的是不是原图。 */
  R.small = await w.webContents.executeJavaScript(`(async () => {
    const L = window.Lightbox, T = window.Thumbs;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const m = State.items[3];
    await T.thumbURL(m, 148);          // 先把缩略图备好，保证 peek 能命中
    const peek = !!T.thumbPeek(m, 148);
    L.open(L.list, L.list[0]);
    await wait(400);
    L.nav(1); L.nav(1); L.nav(1);      // 连续三次，间隔 <1ms → 全走连翻分支
    await wait(120);
    const rec = L._rec;
    return {
      peek: peek, idx: L.i,
      thumb: !!(rec && rec.thumb),
      natW: document.getElementById('lbImg').naturalWidth,
      name: L.meta && L.meta.name,
    };
  })()`);

  /* 从最后一张按"下一张"要**绕回第 0 张**（v1.20.9）。
     `nav()` 一直是 `(i + delta + n) % n`，可 `_preloadNeighbors()` 原来直接取
     `list[i + 1]` —— 在最后一张拿到 undefined 就什么也不做，于是第 0 张从来没被预取过，
     而它多半已经被 `screens` 的 8 槽 LRU 淘汰，绕回去时只能整张解原图。
     实测（12 张 24MP、每张停 3 秒、连走两圈、两次复现）：
       普通切一张    peek=Y/1920  解 9–16ms
       绕回第 0 张   peek=N       解 144.6 / 147.6ms（natW=6000）
     修好之后绕回是 14.1 / 14.2ms，而且第二圈"打开灯箱"从 232–498ms 降到 5.6ms。
     这条断言直接验"最后一张停留之后，第 0 张的代备好了没有"。 */
  R.wrap = await w.webContents.executeJavaScript(`(async () => {
    const L = window.Lightbox, T = window.Thumbs, img = document.getElementById('lbImg');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const n = L.list.length;
    T.forget(L.list[0].id);            // 从零开始：假装第 0 张从没被备过
    L.open(L.list, L.list[n - 2]);
    await wait(2400);                  // 900ms 停留预取 + 生成一代的时间
    const peekNext = !!T.screenPeek(L.list[n - 1], L._needPx(L.list[n - 1]));
    L.nav(1);                          // 走到最后一张
    await wait(2400);                  // 这一刻应当预取**环绕到第 0 张**
    const peekFirst = T.screenPeek(L.list[0], L._needPx(L.list[0]));
    L.nav(1);                          // 再按一次 → 环绕回第 0 张
    await wait(80);
    const rec = L._rec;
    return {
      n, peekNext, peekFirst: peekFirst ? { w: peekFirst.w, full: !!peekFirst.full } : null,
      idx: L.i, recW: rec ? rec.w : 0, recFull: rec ? !!rec.full : false,
      natW: img.naturalWidth,
    };
  })()`);

  /* 原图**比屏幕档位小**的图，代必须能命中缓存（v1.20.9）。
     走的是 `screenURL` 里"原图不比目标档大就直接给原图"那一支，它记的 `side` 是
     原图边长（900），而请求档位是 1280 —— 旧判据 `hit.side >= side` 恒假，
     于是这类图**永远不命中**，每停一张就重跑一次 screenURL（还会为 File 条目
     重新 createObjectURL，旧 URL 没人 revoke），并且白占 `screens` 的槽位。
     实测（Downloads 15 张、每张停 3 秒）：8 张这样的图两圈里全是 peek=N。 */
  R.fullhit = await w.webContents.executeJavaScript(`(async () => {
    const L = window.Lightbox, T = window.Thumbs;
    const m = State.items[4];          // tiny.png 900×600
    T.forget(m.id);
    const need = L._needPx(m);
    const rec = await T.screenURL(m, need);
    const peek = T.screenPeek(m, need);
    return {
      need, full: !!(rec && rec.full), recSide: rec && rec.side, recW: rec && rec.w,
      peek: !!peek, same: !!(peek && rec && peek.url === rec.url),
    };
  })()`);

  console.log('LBSCREEN ' + JSON.stringify(R, null, 1));  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { }
  app.quit();
});
