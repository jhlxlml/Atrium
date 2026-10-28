/* 灯箱切图性能实测（真实大图，不是夹具）
 *
 * 为什么单独一个探针：`probe_lb_ui.js` 用的夹具是几 KB 的小图，解码几乎不花时间，
 * 于是"切一张要多久"根本量不出来 —— 它只能验"位置对不对"。用户报的是"还是很慢"，
 * 必须用 24MP / 48MP 的真实体积图片量，才知道时间花在哪一段。
 *
 * 量三段：
 *   tLoad     挂上 src → load 事件（磁盘读 + 解码完成，naturalWidth 可用）
 *   tVisible  挂上 src → 第一帧"看得见"（opacity > 0 且已有尺寸）
 *   tCentered 挂上 src → 第一帧"位置也对"（视觉中心落在视口中心 ±2px）
 * 外加：本次切换期间的长任务（>50ms 主线程阻塞）与 rAF 帧数。
 *
 * 目录通过环境变量 LB_PERF_DIR 指定，缺省用项目内夹具（保证这个探针在别的机器上也能跑）。
 */
const { app, BrowserWindow, protocol } = require('electron');

require('./_desktop_stub').stubDesktop();
const path = require('path'); const fs = require('fs');
const APPDIR = path.resolve(__dirname, '..', '..', '..');
const DIR = process.env.LB_PERF_DIR || path.join(__dirname, '..', 'fixtures', '照片夹');

app.setPath('userData', path.resolve(__dirname, '..', 'logs', 'ud_lbperf_' + Date.now()));
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
protocol.registerSchemesAsPrivileged([{ scheme: 'vf', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true } }]);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

function collect(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const abs = path.join(dir, f); const st = fs.statSync(abs);
    if (st.isDirectory()) out.push(...collect(abs));
    else if (/\.(png|jpe?g|gif|webp)$/i.test(f)) out.push({ abs, size: st.size, mtime: st.mtimeMs });
  }
  return out;
}

/* 页面内的测量器。必须在 nav() **之前**装好监听，否则会漏掉 load。
 *
 * "看得见"以 `img.decode()` 的 resolve 为准，不是读 opacity。
 * 踩过的坑：一开始读 `getComputedStyle(img).opacity` + `getBoundingClientRect()`，
 * 这两样在 `onload` 之后就立刻成立（类加上了、布局按 intrinsic size 算好了），
 * **可位图还没解码完** —— 24MP 的图被报成 50ms"可见"，而裸 <img> 实测解码就要 122ms。
 * 用户看到的转圈时间根本没被量进去，差点据此得出"已经够快"的错误结论。 */
const MEASURE = `(async () => {
  const L = window.Lightbox, img = document.getElementById('lbImg');
  const t0 = performance.now();
  const lt = [];
  let po = null;
  try {
    po = new PerformanceObserver((l) => { for (const e of l.getEntries()) lt.push(Math.round(e.duration)); });
    po.observe({ entryTypes: ['longtask'] });
  } catch (e) {}
  let tLoad = null;
  const onLoad = () => { tLoad = +(performance.now() - t0).toFixed(1); };
  img.addEventListener('load', onLoad, { once: true });

  const target = L.list[L.i + 1];
  L.nav(1);
  const tNav = +(performance.now() - t0).toFixed(1);

  await new Promise((resolve) => {
    if (img.complete && img.naturalWidth > 0) return resolve();
    const done = () => resolve();
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
    setTimeout(done, 15000);
  });
  const tReady = +(performance.now() - t0).toFixed(1);
  let tDecode = null;
  try {
    const d0 = performance.now();
    await img.decode();
    tDecode = +(performance.now() - d0).toFixed(1);
  } catch (e) { tDecode = -1; }
  const tPixels = +(performance.now() - t0).toFixed(1);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const tPainted = +(performance.now() - t0).toFixed(1);
  if (po) po.disconnect();

  return { tNav, tLoad, tReady, tDecode, tPixels, tPainted,
           natW: img.naturalWidth, natH: img.naturalHeight,
           origW: L.origW, origH: L.origH, full: !!L._full,
           boxW: Math.round(img.getBoundingClientRect().width),
           pct: document.getElementById('lbPct').textContent,
           name: target && target.name, longtasks: lt };
})()`;

/* 同一份文件、绕开灯箱直接 <img> 加载 + decode：把"文件本身的成本"与"UI 的开销"分开。
   如果这一段就要 300ms，那慢不在灯箱，而在读盘/解码。 */
const RAW = `(async (url) => {
  const t0 = performance.now();
  const im = new Image();
  im.decoding = 'async';
  im.src = url;
  const tLoad = await new Promise((r) => {
    im.onload = () => r(+(performance.now() - t0).toFixed(1));
    im.onerror = () => r(-1);
  });
  const t1 = performance.now();
  let tDecode = null;
  try { await im.decode(); tDecode = +(performance.now() - t1).toFixed(1); } catch (e) { tDecode = -1; }
  return { tLoad, tDecode, natW: im.naturalWidth, natH: im.naturalHeight };
})`;

app.whenReady().then(async () => {
  protocol.handle('vf', async (req) => {
    const u = new URL(req.url);
    if (u.host === 'pic') {
      const b64 = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      const abs = Buffer.from(b64, 'base64url').toString('utf8');
      try {
        const b = await fs.promises.readFile(abs);
        return new Response(b, { headers: {
          'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
          'access-control-allow-origin': 'vf://app',
        } });
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

  const w = new BrowserWindow({ width: 1440, height: 900, show: true,
    webPreferences: { preload: path.join(APPDIR, 'deploy', 'electron', 'preload.js'), contextIsolation: true } });
  await w.loadURL('vf://app/index.html');
  await new Promise((r) => setTimeout(r, 900));

  const files = collect(DIR);
  if (!files.length) { console.log('LBPERF ' + JSON.stringify({ error: '目录里没有图片', dir: DIR })); app.quit(); return; }

  await w.webContents.executeJavaScript(`(() => {
    const S = window.State, A = window.App;
    S.sources = [{ id: 's0', name: 'perf', root: 'C:/x' }];
    S.items = ${JSON.stringify(files.map((f, i) => ({
      id: 'r' + i, name: path.basename(f.abs), src: 'all', sid: 's0', size: f.size,
      path: f.abs, ext: path.extname(f.abs).slice(1).toLowerCase(), lastModified: f.mtime, state: 'idle',
    })))};
    S.sourceCount = () => S.items.length;
    A.showGallery(); A.renderSources(); document.getElementById('topbar').hidden = false;
    return S.items.length;
  })()`);
  await new Promise((r) => setTimeout(r, 1500));

  /* 先把灯箱打开在第 0 张上，等它彻底稳定（避免把"打开"的成本算进第一次切换） */
  await w.webContents.executeJavaScript(`(async () => {
    const S = window.State, L = window.Lightbox;
    L.open(S.items, S.items[0]);
    await new Promise((r) => setTimeout(r, 2500));
    return true;
  })()`);

  const R = { dir: DIR, count: files.length, files: files.map((f) => ({ n: path.basename(f.abs), mb: +(f.size / 1048576).toFixed(2) })) };

  /* 单张文件的"裸成本"：直接 <img>，不经灯箱 */
  R.raw = await w.webContents.executeJavaScript(`(async () => {
    const url = window.Thumbs.bigURL(window.State.items[1]);
    const f = ${RAW};
    const cold = await f(url);
    const warm = await f(url);
    return { url: (url || '').slice(0, 40) + '…', cold, warm };
  })()`);

  /* 冷路径：0 → 1 → 2 → 3 → 4，每次都是没预取过的大图 */
  R.cold = [];
  for (let k = 0; k < files.length - 1; k++) {
    R.cold.push(await w.webContents.executeJavaScript(MEASURE));
  }
  /* 热路径：回到 0 再走一遍 —— 若"预取"真的有效，这一轮应该明显更快 */
  await w.webContents.executeJavaScript(`(async () => {
    const L = window.Lightbox;
    L.open(L.list, L.list[0]);
    await new Promise((r) => setTimeout(r, 2500));
    return true;
  })()`);
  R.warm = [];
  for (let k = 0; k < files.length - 1; k++) {
    R.warm.push(await w.webContents.executeJavaScript(MEASURE));
  }

  /* 解码耗时明细：生成一代"屏幕尺寸"到底花多久（noteDecode 记的是 decodeThumb 整体） */
  R.thumbs = await w.webContents.executeJavaScript(`(() => {
    const s = window.Thumbs.stats();
    return { decodes: s.decodes, screenMakes: s.screenMakes, screenHits: s.screenHits,
             lastMs: Math.round(s.lastMs), maxMs: Math.round(s.maxMs) };
  })()`);

  /* 生成一代"屏幕尺寸"的耗时拆解：读文件 / createImageBitmap(resize) / canvas 编码
     这三段各占多少 —— 决定要不要换更便宜的路径（比如超大图干脆不生成代）。 */
  R.breakdown = await w.webContents.executeJavaScript(`(async () => {
    const out = [];
    for (const m of window.State.items) {
      const url = window.Thumbs.bigURL(m);
      if (!url) continue;
      const t0 = performance.now();
      const resp = await fetch(url);
      const blob = await resp.blob();
      const tFetch = performance.now() - t0;

      const t1 = performance.now();
      const bmp = await createImageBitmap(blob, { resizeWidth: 2560, resizeQuality: 'medium' });
      const tBitmap = performance.now() - t1;

      const cv = document.createElement('canvas');
      cv.width = bmp.width; cv.height = bmp.height;
      cv.getContext('2d').drawImage(bmp, 0, 0);
      const t2 = performance.now();
      const out2 = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.85));
      const tEncode = performance.now() - t2;
      if (bmp.close) bmp.close();
      out.push({ name: m.name, mb: +(m.size / 1048576).toFixed(1),
                 fetch: Math.round(tFetch), bitmap: Math.round(tBitmap),
                 encode: Math.round(tEncode), outKB: Math.round((out2 ? out2.size : 0) / 1024) });
    }
    return out;
  })()`);

  console.log('LBPERF ' + JSON.stringify(R, null, 1));
  app.quit();
});
