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
      { id: 'b2', name: 'big-c.png', src: 'all', sid: 's0', size: 1, path: ${JSON.stringify(files[2].abs)}, ext: 'png', lastModified: 1, state: 'idle', w: 0, h: 0 }
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
    await new Promise((r) => setTimeout(r, 1500));
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

  /* 尺寸未知的那张：代的尺寸绝不能写进条目 */
  R.unknown = await w.webContents.executeJavaScript(`(async () => {
    const L = window.Lightbox, img = document.getElementById('lbImg');
    L.open(L.list, L.list[2]);
    await new Promise((r) => setTimeout(r, 60));
    // 等这一张真正显示（可能要先生成代）
    for (let k = 0; k < 100; k++) {
      if (img.complete && img.naturalWidth > 0 && !L._upgrading) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 200));
    return {
      natW: img.naturalWidth,
      usedRendition: img.naturalWidth > 0 && img.naturalWidth < 2600,
      origW: L.origW,
      metaW: L.meta && L.meta.w,
      label: document.getElementById('lbCount').textContent,
    };
  })()`);

  console.log('LBSCREEN ' + JSON.stringify(R, null, 1));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { }
  app.quit();
});
