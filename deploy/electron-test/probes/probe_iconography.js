/* 图标体系探针：量「有没有缺图 / 尺寸是不是只有四档 / 网格与描边是不是一套」，
   并把几个主要表面（顶栏、灯箱 HUD、设置面板、选择条、空态）各截一张特写。

   为什么要它：图标是最容易"慢慢走形"的一层 —— 加一个按钮就顺手画一个 path，
   描边 1.6 还是 1.8 全凭当时手感。四十个图标之后，单看每个都像样，
   并排就毛。这个探针把"像样"变成数字：尺寸落在 --ic-* 四档、symbol 统一
   24×24 / stroke-width 2。

   用法: node deploy/electron-test/run_probe.js probe_iconography.js */
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

/* 只量**有 use 的 svg**：精灵根节点没有 use，空态插画是自定义 svg（不走 sprite）。 */
const MEASURE = `(() => {
  const hosts = [...document.querySelectorAll('svg')].filter((s) => s.querySelector('use'));
  const sizes = {}, strokes = {}, missing = [], badGrid = [];
  let visible = 0;
  for (const s of hosts) {
    const u = s.querySelector('use');
    const href = String(u.getAttribute('href') || u.getAttribute('xlink:href') || '').replace('#', '');
    const sym = href ? document.getElementById(href) : null;
    if (!sym) { missing.push(href || '(空引用)'); continue; }
    const vb = sym.getAttribute('viewBox');
    if (vb !== '0 0 24 24') badGrid.push(href + ' viewBox=' + vb);
    const sw = sym.getAttribute('stroke-width');
    strokes[sw] = (strokes[sw] || 0) + 1;
    const b = s.getBoundingClientRect();
    if (b.width > 0 && b.height > 0) {
      visible++;
      const k = Math.round(b.width) + 'x' + Math.round(b.height);
      sizes[k] = (sizes[k] || 0) + 1;
    }
  }
  return {
    total: hosts.length, visible: visible, missing: missing,
    sizes: sizes, strokes: strokes, badGrid: badGrid,
    symbols: document.querySelectorAll('symbol').length,
    /* 精灵本身必须是 24 网格 + 统一描边：抽查几个"最容易被手改"的 */
    sample: ['i-search', 'i-gear', 'i-star-fill', 'i-play'].map((id) => {
      const s = document.getElementById(id);
      return s ? { id: id, vb: s.getAttribute('viewBox'), sw: s.getAttribute('stroke-width'),
                   fill: s.getAttribute('fill'), kids: s.children.length } : { id: id, missing: true };
    }),
  };
})()`;

function shot(win, box, scale) {
  return win.webContents.capturePage(box).then((img) =>
    img.resize({ width: Math.round(box.width * (scale || 2.4)), quality: 'best' }));
}

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

  const base = collect(PICDIR, PICDIR).filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f.abs)).slice(0, 4);
  const files = base.map((f) => ({ p: f.abs, n: path.basename(f.abs), rel: f.rel, size: f.size, mtime: f.mtime }));
  await js(`(() => {
    const S = window.State, A = window.App;
    const recs = ${JSON.stringify(files)};
    S.sources = [{ id: 's0', name: '照片夹', root: 'C:/Users/me/Pictures/照片夹' }];
    S.items = recs.map((r, i) => ({ id: 'r' + i, name: r.n, src: 'all', sid: 's0', size: r.size,
      path: r.p, rel: r.rel, ext: r.n.split('.').pop().toLowerCase(), lastModified: r.mtime, state: 'idle' }));
    A.showGallery(); A.renderSources();
    document.getElementById('topbar').hidden = false;
    document.querySelector('#modeSeg .seg-btn[data-mode="medium"]').click();
    return S.items.length;
  })()`);
  await sleep(1600);

  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const data = await js(MEASURE);

  /* 1) 顶栏：图标最密的地方 */
  const ctrl = await js(`(() => { const r = document.getElementById('ctrls').getBoundingClientRect();
    return { x: Math.round(r.x), w: Math.round(r.width) }; })()`);
  const cx = Math.max(0, ctrl.x - 14);
  fs.writeFileSync(path.join(OUT, 'icons-topbar.png'),
    (await shot(win, { x: cx, y: 0, width: Math.min(1500 - cx, ctrl.w + 28), height: 120 })).toPNG());

  /* 2) 灯箱 HUD */
  await js(`(() => { window.Lightbox.open(window.State.viewList(), window.State.items[0]); return true; })()`);
  await sleep(900);
  const lb = await js(`(() => { const b = document.getElementById('lbActions');
    const r = (b || document.body).getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
  fs.writeFileSync(path.join(OUT, 'icons-lightbox.png'),
    (await shot(win, { x: Math.max(0, lb.x - 16), y: Math.max(0, lb.y - 16),
      width: Math.min(1500 - Math.max(0, lb.x - 16), lb.w + 32), height: lb.h + 32 }, 3)).toPNG());
  await js(`(() => { window.Lightbox.close(); return true; })()`);
  await sleep(500);

  /* 3) 设置面板：分组标题、开关、下拉、按钮上的图标 */
  await js(`(() => { document.getElementById('setBtn').click(); return true; })()`);
  await sleep(700);
  const sp = await js(`(() => { const p = document.getElementById('setPanel');
    const r = p.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
  fs.writeFileSync(path.join(OUT, 'icons-settings.png'),
    (await shot(win, { x: Math.max(0, sp.x), y: Math.max(0, sp.y),
      width: Math.min(1500 - Math.max(0, sp.x), sp.w), height: Math.min(900 - Math.max(0, sp.y), sp.h) }, 2)).toPNG());
  await js(`(() => { document.getElementById('setBtn').click(); return true; })()`);
  await sleep(400);

  /* 4) 选择条（批量操作） */
  await js(`(() => { window.App.onSelChanged(2, window.State.items.slice(0, 2)); return true; })()`);
  await sleep(500);
  const sb = await js(`(() => { const b = document.querySelector('.selbar');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
  if (sb) {
    fs.writeFileSync(path.join(OUT, 'icons-selbar.png'),
      (await shot(win, { x: Math.max(0, sb.x - 12), y: Math.max(0, sb.y - 12),
        width: Math.min(1500 - Math.max(0, sb.x - 12), sb.w + 24), height: sb.h + 24 }, 2.4)).toPNG());
  }
  await js(`(() => { window.App.clearSel && window.App.clearSel(); return true; })()`);
  await sleep(300);

  /* 5) 空态：唯一使用自定义大插画的地方（不走 sprite，但要确认没被图标改动带坏） */
  await js(`(() => { const S = window.State; S.items = []; window.App.showEmpty && window.App.showEmpty(); return true; })()`);
  await sleep(600);
  fs.writeFileSync(path.join(OUT, 'icons-empty.png'),
    (await shot(win, { x: 300, y: 120, width: 700, height: 420 }, 1.6)).toPNG());

  console.log('ICONS ' + JSON.stringify(data));
  console.log('DONE');
  app.quit();
}).catch((e) => { console.error('ERR', (e && e.stack) || e); app.quit(); });
