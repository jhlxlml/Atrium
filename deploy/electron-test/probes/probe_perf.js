/* ============================================================
   打开速度性能探针（v1.6.0）
   ------------------------------------------------------------
   要回答的问题：图片多、单文件大的时候，打开为什么慢？改完到底快了多少？

   做法（全部是真实测量，不靠估算）：
   1) 主进程现场生成 4 张「真 JPEG 大图」（约 3200×2133，噪声内容 → 文件大、
      解码贵），写进沙箱目录 —— 用的是 nativeImage 真编码，不是伪造字节头；
   2) 第一次打开该目录：计时到「所有瓦片都显示出图」为止，并统计解码次数、
      走的是哪条解码路径（降采样 / <img> 兜底）、尺寸库是否拿到了原图真实尺寸；
   3) 顺带做一次「文件头解析 vs 浏览器真实解码」的交叉验证 —— 同一个文件，
      一边用 Util.sizeFromHeader 读头，一边让 Chromium 真解一遍，两者必须完全一致；
   4) 重载窗口（同一持久分区，IndexedDB 保留）后再打开同一个目录：
      第二次必须 **零解码**（全部命中落盘缓存），且明显更快。

   只输出原始测量值（PERF 一行 JSON），断言在 run_all.js。
   用法: electron.exe probe_perf.js  (cwd = deploy/electron)
   ============================================================ */
const { app, BrowserWindow, protocol, ipcMain, session, nativeImage } = require('electron');

/* 桌面集成通道桩：缺了它 App.init() 的托盘/快捷键设置重放会"假失败" —— 详见 _desktop_stub.js */
require('./_desktop_stub').stubDesktop();
/* 窗口置顶 / 屏幕清单也要补桩：App.init() 启动时会拉，缺了会让探针变成"不完整宿主"
   —— invoke reject 被 .catch 吞掉，上层判"没生效"，并留下一条 console.warn 假报错。 */
require('./_desktop_stub').stubWindowChannels();
const path = require('path'); const fs = require('fs');
const APPDIR = path.resolve(__dirname, '..', '..', '..');
const OUT = path.resolve(__dirname, '..', 'shots');
const LOGS = path.resolve(__dirname, '..', 'logs');

app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
protocol.registerSchemesAsPrivileged([{ scheme: 'vf', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true } }]);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' };
const IMG_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

/* ---------- 现场造大图 ----------
   关键：内容必须像真实照片，否则会得出错误结论。
   纯随机噪声的 JPEG 里「非零系数极多」，耗时几乎全在熵解码上 —— 而熵解码
   并不会因为降采样解码而减少，于是会误判成「降采样没用」。真实照片的能量
   集中在低频，耗时由 IDCT 与重采样主导，正是降采样解码能省下来的部分。
   所以这里在 1/8 分辨率上造随机场再双线性放大（低频），叠一层细纹理，
   再撒一些硬边缘模拟场景结构。 */
function makePhotoJPEG(w, h, q, seed) {
  const gw = (w >> 3) + 2, gh = (h >> 3) + 2;
  const grid = new Float32Array(gw * gh * 3);
  let s = seed | 1;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0; i < grid.length; i++) grid[i] = rnd();

  const buf = Buffer.allocUnsafe(w * h * 4);   // BGRA
  for (let y = 0; y < h; y++) {
    const gy = y / 8, y0 = gy | 0, fy = gy - y0;
    for (let x = 0; x < w; x++) {
      const gx = x / 8, x0 = gx | 0, fx = gx - x0;
      const i00 = (y0 * gw + x0) * 3, i10 = i00 + 3;
      const i01 = i00 + gw * 3, i11 = i01 + 3;
      const o = (y * w + x) * 4;
      const edge = (((x >> 6) + (y >> 6)) % 7 === 0);
      for (let c = 0; c < 3; c++) {
        const a = grid[i00 + c] * (1 - fx) + grid[i10 + c] * fx;
        const b = grid[i01 + c] * (1 - fx) + grid[i11 + c] * fx;
        let v = (a * (1 - fy) + b * fy) * 255 + (rnd() - 0.5) * 18;
        if (edge) v = 255 - v;
        buf[o + c] = v < 0 ? 0 : v > 255 ? 255 : v | 0;
      }
      buf[o + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: w, height: h }).toJPEG(q);
}

app.whenReady().then(async () => {
  // 沙箱放项目同盘（与其它探针一致，避免跨卷带来的额外变量），跑完清理
  const SB = path.join(LOGS, 'perf-' + Date.now());
  const PIC = path.join(SB, '大图集');
  fs.mkdirSync(PIC, { recursive: true });

  const SPEC = [
    { name: 'a-日出.jpg', w: 3200, h: 2133 },
    { name: 'b-山峦.jpg', w: 3200, h: 2133 },
    { name: 'c-竖幅.jpg', w: 2133, h: 3200 },
    { name: 'd-人像.jpg', w: 2400, h: 3200 },
  ];
  const gen = [];
  for (let i = 0; i < SPEC.length; i++) {
    const sp = SPEC[i];
    const t0 = Date.now();
    const b = makePhotoJPEG(sp.w, sp.h, 90, 7717 + i * 977);
    fs.writeFileSync(path.join(PIC, sp.name), b);
    gen.push({ name: sp.name, w: sp.w, h: sp.h, bytes: b.length, genMs: Date.now() - t0 });
  }

  /* ---------- 原生桥：loadDir / readHead 用与主进程一致的实现 ---------- */
  function listImages(root) {
    const out = [];
    (function walk(dir, rel) {
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const en of ents) {
        if (en.isDirectory()) walk(path.join(dir, en.name), rel + en.name + '/');
        else if (IMG_RE.test(en.name)) {
          const abs = path.join(dir, en.name);
          const st = fs.statSync(abs);
          out.push({ name: en.name, rel: rel + en.name, path: abs, size: st.size, mtime: Math.round(st.mtimeMs) });
        }
      }
    })(root, '');
    out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    return out;
  }
  for (const ch of ['vf:trashLog', 'vf:pickDirs']) ipcMain.handle(ch, () => []);
  for (const ch of ['vf:autoDir', 'vf:pickFolder', 'vf:pickExportDir', 'vf:restoreFile', 'vf:restoreFiles', 'vf:trashForget', 'vf:trashClear', 'vf:openRecycleBin', 'vf:openPath']) {
    ipcMain.handle(ch, () => null);
  }
  ipcMain.on('vf:setLastDir', () => { });
  ipcMain.handle('vf:loadDir', (e, dir) => {
    try { return { ok: true, name: path.basename(dir), dir, files: listImages(dir) }; } catch (err) { return { ok: false }; }
  });
  ipcMain.handle('vf:readHead', async (e, p, n) => {
    try {
      const len = Math.max(1, Math.min(n || 262144, 1024 * 1024));
      const fh = await fs.promises.open(p, 'r');
      const buf = Buffer.allocUnsafe(len);
      let bytesRead = 0;
      try { ({ bytesRead } = await fh.read(buf, 0, len, 0)); } finally { await fh.close(); }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead);
    } catch (err) { return null; }
  });

  const PART = 'vf-perf-' + Date.now();
  const ses = session.fromPartition(PART);
  const handleVf = async (req) => {
    const u = new URL(req.url);
    if (u.host === 'pic') {
      const abs = Buffer.from(decodeURIComponent(u.pathname).replace(/^\/+/, ''), 'base64url').toString('utf8');
      try {
        const b = await fs.promises.readFile(abs);
        return new Response(b, { headers: { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'Access-Control-Allow-Origin': 'vf://app' } });
      } catch (e) { return new Response('404', { status: 404 }); }
    }
    const abs = path.resolve(APPDIR, decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html');
    try {
      const b = await fs.promises.readFile(abs);
      return new Response(b, { headers: { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'access-control-allow-origin': 'vf://app' } });
    } catch (e) { return new Response('404', { status: 404 }); }
  };
  protocol.handle('vf', handleVf);
  ses.protocol.handle('vf', handleVf);

  const w = new BrowserWindow({
    width: 1400, height: 880, show: true,
    webPreferences: { preload: path.join(APPDIR, 'deploy', 'electron', 'preload.js'), contextIsolation: true, partition: PART },
  });
  w.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('PAGE-ERR ' + msg); });

  const exec = (code) => w.webContents.executeJavaScript(code);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, ms, step) {
    const t0 = Date.now();
    for (;;) {
      if (await exec(`(${fn})()`)) return true;
      if (Date.now() - t0 > ms) return false;
      await wait(step || 60);
    }
  }
  const boot = async () => {
    await w.loadURL('vf://app/index.html');
    await waitFor(`() => !!(window.App && window.State && window.Thumbs && window.Loader && document.getElementById('stage'))`, 15000);
    await wait(700);
  };

  /* 打开一次目录并计时：t0 → 第一张出图 → 全部出图 */
  const openAndTime = async () => {
    await exec(`(() => {
      const S = window.State;
      while (S.sources.length) { try { S.removeSource(S.sources[0].id); } catch (e) { S.sources.shift(); } }
      window.__t = {};
      return true;
    })()`);
    await wait(120);
    await exec(`(() => { window.Thumbs.resetStats(); window.__t.t0 = performance.now(); window.__open = window.Loader.fromNative(${JSON.stringify(PIC)}); return true; })()`);
    // 第一张出图
    await waitFor(`() => document.querySelectorAll('.tile img.ld').length >= 1`, 20000, 20);
    await exec(`(() => { window.__t.first = performance.now(); return true; })()`);
    // 全部出图
    const allOk = await waitFor(`() => { const n = document.querySelectorAll('.tile').length; return n > 0 && document.querySelectorAll('.tile img.ld').length >= n; }`, 40000, 40);
    await exec(`(() => { window.__t.all = performance.now(); return true; })()`);
    await exec(`(() => window.Loader.thumbCache.flush())()`).catch(() => { });
    await wait(600);
    return await exec(`(async () => {
      const S = window.State, T = window.Thumbs, U = window.Util;
      const st = T.stats(), tc = await window.Loader.thumbCache.stats();
      const items = S.items.map((m) => ({
        name: m.name, w: m.w, h: m.h, ratio: +(m.ratio || 0).toFixed(5), bad: !!m.bad,
        probe: m._dimProbe ? { w: m._dimProbe.w, h: m._dimProbe.h } : null,
      }));
      // DOM 里真实显示出来的缩略图尺寸（= 落盘 blob 的内在尺寸）
      const shown = [...document.querySelectorAll('.tile img')].map((im) => ({ nw: im.naturalWidth, nh: im.naturalHeight, ld: im.classList.contains('ld') }));
      return {
        firstMs: Math.round((window.__t.first || 0) - window.__t.t0),
        allMs: Math.round((window.__t.all || 0) - window.__t.t0),
        allOk: ${allOk},
        tileCount: document.querySelectorAll('.tile').length,
        itemCount: S.items.length,
        stats: st, cache: tc,
        items: items, shown: shown,
      };
    })()`);
  };

  /* ---------- 1. 首开 ---------- */
  await boot();

  /* ---------- 0. 尺寸探测链路自检（先证明「读文件头」这条路真的通） ---------- */
  const pathA = path.join(PIC, SPEC[0].name);
  const sizeApi = await exec(`(async () => {
    const L = window.Loader, N = window.Native, U = window.Util;
    const out = {
      imageSizeIsFn: typeof L.imageSize === 'function',
      nativeActive: !!(N && N.active),
      hasReadHead: !!(N && N.readHead),
      utilHasParser: typeof U.sizeFromHeader === 'function',
    };
    try {
      const head = await N.readHead(${JSON.stringify(pathA)}, 65536);
      out.headType = head ? Object.prototype.toString.call(head) : 'null';
      out.headBytes = head ? (head.byteLength || head.length || 0) : 0;
      out.parsed = head ? U.sizeFromHeader(head) : null;
    } catch (e) { out.readErr = String((e && e.message) || e); }
    const fake = { id: 'probe-x', name: 'a.jpg', ext: 'jpg', path: ${JSON.stringify(pathA)}, bad: false, w: 0, h: 0 };
    try { out.viaApi = await L.imageSize(fake); } catch (e) { out.apiErr = String((e && e.message) || e); }
    out.fakeAfter = { w: fake.w, h: fake.h, probe: fake._dimProbe || null };
    return out;
  })()`);

  const first = await openAndTime();

  /* ---------- 1c. 「解码即降采样」 vs 「全量解码后缩小」：同一张图的 A/B ----------
     这是本次优化的核心机制，必须直接量出来，而不是只看总耗时的间接推断。 */
  const decodeAB = await exec(`(async () => {
    const m = window.State.items[0];
    const blob = await (await fetch(window.Native.url(m))).blob();
    const side = 640, rh = Math.round(side * m.h / m.w);
    const best = async (fn, warm, times) => {
      let b = Infinity, extra = null;
      for (let i = 0; i < (warm || 0) + times; i++) {
        const r = await fn();
        if (i >= (warm || 0) && r.ms < b) { b = r.ms; extra = r.extra || null; }
      }
      return { ms: Math.round(b * 10) / 10, extra: extra };
    };
    // ① 只比「解码」这一步
    const decodeFull = await best(async () => {
      const t0 = performance.now();
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      const dt = performance.now() - t0;
      const px = bmp.width + 'x' + bmp.height;
      if (bmp.close) bmp.close();
      return { ms: dt, extra: px };
    }, 1, 3);
    const decodeSmall = await best(async () => {
      const t0 = performance.now();
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image', resizeQuality: 'medium', resizeWidth: side, resizeHeight: rh });
      const dt = performance.now() - t0;
      const px = bmp.width + 'x' + bmp.height;
      if (bmp.close) bmp.close();
      return { ms: dt, extra: px };
    }, 1, 3);

    // ② 比「解码 + 缩到瓦片尺寸 + 编码成缩略图 blob」整条管线（这才是实际开销）
    const pipeline = (resized) => best(async () => {
      const t0 = performance.now();
      const opt = resized
        ? { imageOrientation: 'from-image', resizeQuality: 'medium', resizeWidth: side, resizeHeight: rh }
        : { imageOrientation: 'from-image' };
      const bmp = await createImageBitmap(blob, opt);
      const cv = new OffscreenCanvas(side, rh);
      cv.getContext('2d').drawImage(bmp, 0, 0, side, rh);
      const out = await cv.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
      if (bmp.close) bmp.close();
      return { ms: performance.now() - t0, extra: out ? out.size : 0 };
    }, 1, 3);
    const pipeFull = await pipeline(false);
    const pipeSmall = await pipeline(true);

    // ③ 只给一边的路径（尺寸未知时的回退）：必须保持原比例
    const only = await createImageBitmap(blob, { imageOrientation: 'from-image', resizeQuality: 'medium', resizeWidth: side });
    const [ow, oh] = [only.width, only.height];
    if (only.close) only.close();

    return {
      src: m.name, srcW: m.w, srcH: m.h, wantSide: side,
      decodeFullMs: decodeFull.ms, decodeFullPx: decodeFull.extra,
      decodeSmallMs: decodeSmall.ms, decodeSmallPx: decodeSmall.extra,
      decodeSpeedup: +(decodeFull.ms / Math.max(0.01, decodeSmall.ms)).toFixed(2),
      pipeFullMs: Math.round(pipeFull.ms * 10) / 10, pipeFullBytes: pipeFull.extra,
      pipeSmallMs: Math.round(pipeSmall.ms * 10) / 10, pipeSmallBytes: pipeSmall.extra,
      pipeSpeedup: +(pipeFull.ms / Math.max(0.01, pipeSmall.ms)).toFixed(2),
      onlyWidthPx: ow + 'x' + oh,
      arTrue: +(m.w / m.h).toFixed(5),
      arOnlyWidth: +(ow / oh).toFixed(5),
    };
  })()`);

  /* ---------- 1b. 文件头解析 vs 浏览器真实解码（同一文件两条独立路径） ---------- */
  const xcheck = await exec(`(async () => {
    const U = window.Util;
    const out = [];
    for (const m of window.State.items) {
      const url = window.Native.url(m);
      const head = new Uint8Array(await (await fetch(url)).arrayBuffer());
      const byHead = U.sizeFromHeader(head.slice(0, 65536));
      const nat = await new Promise((res) => { const im = new Image(); im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight }); im.onerror = () => res(null); im.src = url; });
      out.push({ name: m.name, head: byHead, decode: nat, match: !!(byHead && nat && byHead.w === nat.w && byHead.h === nat.h) });
    }
    return out;
  })()`);

  /* ---------- 2. 重载后二次打开（同一分区 → IndexedDB 仍在） ---------- */
  await w.webContents.reload();
  await waitFor(`() => !!(window.App && window.Thumbs && window.Loader && document.getElementById('stage'))`, 15000);
  await wait(700);
  const cacheBefore = await exec(`(async () => await window.Loader.thumbCache.stats())()`);
  const second = await openAndTime();

  const out = {
    images: gen,
    sandbox: SB,
    sizeApi: sizeApi,
    first: first,
    decodeAB: decodeAB,
    second: second,
    cacheBefore: cacheBefore,
    xcheck: xcheck,
  };
  fs.writeFileSync(path.join(OUT, 'perf.json'), JSON.stringify(out, null, 1));
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结论 */ }

  console.log('PERF ' + JSON.stringify(out, null, 1));
  app.quit();
}).catch((e) => { console.error('ERR', (e && e.stack) || e); app.quit(); });
