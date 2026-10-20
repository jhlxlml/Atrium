/* 单列整屏探针：图片有没有被顶部控制栏盖住。

   背景：单列槽位高度 = innerHeight − 「顶部 chrome 下沿」。chrome 包含两部分：
     · WCO 窗口标题栏（34px，fixed，内容会从它下面滑过）
     · .topbar（56px + 发丝线，sticky 在标题栏下方）
   若只算 .topbar 自身高度（57px），少掉 34px 的后果是三处一起错：
     · 槽位比可见区高 34px；
     · _alignIndex 多滚 34px → 每张图**顶部**藏进控制栏；
     · scroll-padding-top 少 34px → 吸附位对不齐。

   探针按**生产顺序**摆场：WCO 在装图之前应用（App.init 里 relocatePin 就在装图前），
   然后再切单列 —— 这样量到的是用户真正看到的东西。
   只输出原始测量值（SINGLE 一行 JSON），判定集中在 run_all.js。
   用法: electron.exe probe_single.js  (cwd = deploy/electron) */
const { app, BrowserWindow, protocol, ipcMain } = require('electron');

require('./_desktop_stub').stubDesktop();
require('./_desktop_stub').stubWindowChannels();

const path = require('path');
const fs = require('fs');
const APPDIR = path.resolve(__dirname, '..', '..', '..');
const OUT = path.resolve(__dirname, '..', 'shots');
const PICDIR = path.join(__dirname, '..', 'fixtures', '照片夹');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
protocol.registerSchemesAsPrivileged([{ scheme: 'vf', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }]);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif' };

for (const ch of ['vf:trashLog', 'vf:autoDir', 'vf:pickDirs', 'vf:restoreFile', 'vf:restoreFiles', 'vf:trashForget', 'vf:trashClear', 'vf:pickFolder']) {
  ipcMain.handle(ch, () => (ch === 'vf:trashLog' || ch === 'vf:pickDirs' ? [] : null));
}
ipcMain.handle('vf:loadDir', () => ({ ok: false, files: [] }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function collect(dir, base) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const abs = path.join(dir, f);
    const st = fs.statSync(abs);
    if (st.isDirectory()) out.push(...collect(abs, base));
    else if (/\.(png|jpe?g|gif|webp)$/i.test(f)) out.push({ abs, rel: path.relative(base, abs).replace(/\\/g, '/'), size: st.size, mtime: st.mtimeMs });
  }
  return out;
}

/* 统一的测量片段：chrome 下沿 / 槽位 / 首图被盖住的像素 */
const MEASURE = `(() => {
  const cap = document.getElementById('capbar');
  const top = document.getElementById('topbar');
  const cr = cap && !cap.hidden ? cap.getBoundingClientRect() : null;
  const tr = top && !top.hidden ? top.getBoundingClientRect() : null;
  const chromeBottom = Math.round(Math.max(cr ? cr.bottom : 0, tr ? tr.bottom : 0));
  const tiles = [...document.querySelectorAll('.single-tile')];
  const t0 = tiles[0];
  const r0 = t0 ? t0.getBoundingClientRect() : null;
  const im = t0 ? t0.querySelector('img') : null;
  const ir = im ? im.getBoundingClientRect() : null;
  return {
    hasWco: document.body.classList.contains('has-wco'),
    capH: cr ? Math.round(cr.height) : 0,
    chromeBottom: chromeBottom,
    vh: window.innerHeight,
    slotH: (window.Grid.positions && window.Grid.positions[0]) ? window.Grid.positions[0].h : 0,
    slotShould: window.innerHeight - chromeBottom,
    tile0Top: r0 ? Math.round(r0.top) : null,
    tileCovered: r0 ? Math.max(0, Math.round(chromeBottom - r0.top)) : null,
    imgTop: ir ? Math.round(ir.top) : null,
    imgCovered: ir ? Math.max(0, Math.round(chromeBottom - ir.top)) : null,
    scrollPadTop: getComputedStyle(document.documentElement).scrollPaddingTop,
    snapOn: document.documentElement.classList.contains('snap-single'),
    n: tiles.length,
  };
})()`;

app.whenReady().then(async () => {
  protocol.handle('vf', async (req) => {
    const u = new URL(req.url);
    if (u.host === 'pic') {
      const b64 = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      const abs = Buffer.from(b64, 'base64url').toString('utf8');
      try {
        const b = await fs.promises.readFile(abs);
        return new Response(b, { headers: { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' } });
      } catch (e) { return new Response('404', { status: 404 }); }
    }
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const abs = path.resolve(APPDIR, rel || 'index.html');
    try {
      const b = await fs.promises.readFile(abs);
      return new Response(b, { headers: { 'content-type': (MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream') } });
    } catch (e) { return new Response('404', { status: 404 }); }
  });

  const win = new BrowserWindow({
    width: 1500, height: 900, show: true,
    webPreferences: { preload: path.join(APPDIR, 'deploy', 'electron', 'preload.js'), contextIsolation: true },
  });
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('PAGE-ERR ' + msg); });
  await win.loadURL('vf://app/index.html');
  await sleep(900);
  const js = (code) => win.webContents.executeJavaScript(code);

  /* ① 先应用 WCO —— 生产顺序（App.init 的 relocatePin 在装图之前）。
        探针窗口没有真实的 titleBarOverlay，navigator.windowControlsOverlay.visible 为 false，
        所以直接摆出 has-wco 的等效 DOM 状态，而不是调 relocatePin（它会按 API 判成 false）。 */
  await js(`(() => {
    document.body.classList.add('has-wco');
    const cb = document.getElementById('capbar');
    if (cb) cb.hidden = false;
    return true;
  })()`);
  await sleep(200);

  /* ② 装图库：单列至少两张，才能验「吸附到第 2 张」 */
  const base = collect(PICDIR, PICDIR).filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f.abs)).slice(0, 4);
  const files = base.map((f) => ({ p: f.abs, n: path.basename(f.abs), rel: f.rel, size: f.size, mtime: f.mtime }));
  await js(`(() => {
    const S = window.State, A = window.App;
    const recs = ${JSON.stringify(files)};
    S.sources = [{ id: 's0', name: '照片夹', root: 'C:/Users/me/Pictures/照片夹' }];
    S.items = recs.map((r, i) => ({
      id: 'r' + i, name: r.n, src: 'all', sid: 's0',
      size: r.size, path: r.p, rel: r.rel, ext: r.n.split('.').pop().toLowerCase(),
      lastModified: r.mtime, state: 'idle',
    }));
    A.showGallery(); A.renderSources();
    document.getElementById('topbar').hidden = false;
    return S.items.length;
  })()`);
  await sleep(1200);

  /* ③ 切单列（不强制重排 —— 量到的必须是自然状态） */
  await js(`(() => { window.App.setMode('single'); return true; })()`);
  await sleep(1400);
  const first = await js(MEASURE);

  /* ④ 吸附到第 2 张：顶边应与 chrome 下沿齐平 */
  await js(`(() => { window.Grid._alignIndex(1); return true; })()`);
  await sleep(500);
  const second = await js(`(() => {
    const cap = document.getElementById('capbar');
    const top = document.getElementById('topbar');
    const cr = cap && !cap.hidden ? cap.getBoundingClientRect() : null;
    const tr = top && !top.hidden ? top.getBoundingClientRect() : null;
    const chromeBottom = Math.round(Math.max(cr ? cr.bottom : 0, tr ? tr.bottom : 0));
    const tiles = [...document.querySelectorAll('.single-tile')];
    const t1 = tiles[1];
    const r1 = t1 ? t1.getBoundingClientRect() : null;
    return {
      chromeBottom: chromeBottom,
      tile1Top: r1 ? Math.round(r1.top) : null,
      alignErr: r1 ? Math.round(r1.top - chromeBottom) : null,
      scrollY: Math.round(window.scrollY),
    };
  })()`);

  /* ⑤ chrome 变化后是否自愈：摘掉标题栏 → afterChromeChange → 槽位应回到「无标题栏」的算法。
        这一段守的是「判定结果变了却不重排」这个隐患（见 App.relocatePin 的注释）。 */
  await js(`(() => { window.Grid._alignIndex(0); document.body.classList.remove('has-wco');
                     document.getElementById('capbar').hidden = true;
                     window.App.afterChromeChange(); return true; })()`);
  await sleep(500);
  const lateOff = await js(MEASURE);
  await js(`(() => { document.body.classList.add('has-wco');
                     document.getElementById('capbar').hidden = false;
                     window.App.afterChromeChange(); return true; })()`);
  await sleep(500);
  const lateOn = await js(MEASURE);

  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'single-geo.json'), JSON.stringify({ first, second, lateOff, lateOn }, null, 2));
  fs.writeFileSync(path.join(OUT, 'single-wco.png'), (await win.webContents.capturePage()).toPNG());

  console.log('SINGLE ' + JSON.stringify({ first, second, lateOff, lateOn }));
  console.log('DONE');
  app.quit();
}).catch((e) => { console.error('ERR', (e && e.stack) || e); app.quit(); });
