/* 网格布局探针：为 .tile 加上 contain: layout paint（P1-3）之后，几何必须保持正确。
   只输出原始测量值（GRID 一行 JSON），判定集中在 run_all.js —— 避免「探针自己判自己」。
   测量内容：宽/窄两种窗口下，每行瓦片数、行内最大重叠、行间是否叠压、零尺寸数、
   contain 是否生效、是否仍为绝对定位、实测包围盒是否与内联宽高一致。
   用法: electron.exe probe_grid.js  (cwd = deploy/electron) */
const { app, BrowserWindow, protocol, ipcMain } = require('electron');

/* 桌面集成通道桩：缺了它 App.init() 的托盘/快捷键设置重放会"假失败" —— 详见 _desktop_stub.js */
require('./_desktop_stub').stubDesktop();
/* 窗口置顶 / 屏幕清单也要补桩：App.init() 启动时会拉，缺了会让探针变成"不完整宿主"
   —— invoke reject 被 .catch 吞掉，上层判"没生效"，并留下一条 console.warn 假报错。 */
require('./_desktop_stub').stubWindowChannels();
const path = require('path'); const fs = require('fs');
const APPDIR = path.resolve(__dirname, '..', '..', '..');
const OUT = path.resolve(__dirname, '..', 'shots');
const PICDIR = path.join(__dirname, '..', 'fixtures', '照片夹');

app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
protocol.registerSchemesAsPrivileged([{ scheme: 'vf', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }]);
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png', '.jpg':'image/jpeg', '.gif':'image/gif' };

// 静音原生通道（探针不触及真实回收站/目录选择）
for (const ch of ['vf:trashLog','vf:autoDir','vf:pickDirs','vf:restoreFile','vf:restoreFiles','vf:trashForget','vf:trashClear','vf:pickFolder']) {
  ipcMain.handle(ch, () => (ch === 'vf:trashLog' || ch === 'vf:pickDirs' ? [] : null));
}
ipcMain.handle('vf:loadDir', () => ({ ok: false, files: [] }));

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

app.whenReady().then(async () => {
  protocol.handle('vf', async (req) => {
    const u = new URL(req.url);
    if (u.host === 'pic') {
      const b64 = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      const abs = Buffer.from(b64, 'base64url').toString('utf8');
      try { const b = await fs.promises.readFile(abs);
        return new Response(b, { headers: { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' } });
      } catch (e) { return new Response('404', { status: 404 }); }
    }
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const abs = path.resolve(APPDIR, rel || 'index.html');
    try { const b = await fs.promises.readFile(abs);
      return new Response(b, { headers: { 'content-type': (MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream') } });
    } catch (e) { return new Response('404', { status: 404 }); }
  });

  const w = new BrowserWindow({ width: 1500, height: 860, show: true,
    webPreferences: { preload: path.join(APPDIR, 'deploy', 'electron', 'preload.js'), contextIsolation: true } });
  w.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('PAGE-ERR ' + msg); });
  await w.loadURL('vf://app/index.html');
  await new Promise((r) => setTimeout(r, 900));

  // 多份复制以填满多行，才能检验行内/行间几何
  const base = collect(PICDIR, PICDIR).filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f.abs));
  const files = [];
  for (let rep = 0; rep < 5; rep++) {
    for (const f of base) files.push({ p: f.abs, n: (rep ? rep + '_' : '') + path.basename(f.abs), rel: f.rel, size: f.size, mtime: f.mtime });
  }
  console.log('FILES ' + files.length);

  await w.webContents.executeJavaScript(`(() => {
    const S = window.State, A = window.App;
    const recs = ${JSON.stringify(files.map((f) => ({ p: f.p, n: f.n, rel: f.rel, size: f.size, mtime: f.mtime })))};
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
  await new Promise((r) => setTimeout(r, 2200));

  // 统一的几何快照：瓦片由 transform: translate(x,y) 定位 + 内联宽高
  const GRAB = `(() => {
    const tiles = [...document.querySelectorAll('.tile')];
    return tiles.map((t) => {
      const c = getComputedStyle(t);
      const r = t.getBoundingClientRect();
      const m = new DOMMatrixReadOnly(c.transform === 'none' ? '' : c.transform);
      return {
        l: Math.round(m.e * 100) / 100, tp: Math.round(m.f * 100) / 100,
        w: parseFloat(t.style.width) || 0, h: parseFloat(t.style.height) || 0,
        rx: Math.round(r.x), ry: Math.round(r.y), rw: Math.round(r.width), rh: Math.round(r.height),
        contain: c.contain, pos: c.position,
      };
    });
  })()`;

  // 行分组 → 行内最大重叠量 / 行间是否叠压
  function analyze(list) {
    const rows = new Map();
    for (const t of list) { const k = Math.round(t.tp); if (!rows.has(k)) rows.set(k, []); rows.get(k).push(t); }
    let overlap = 0, worstGap = 0, zero = 0;
    for (const [, arr] of rows) {
      arr.sort((a, b) => a.l - b.l);
      for (const t of arr) if (!(t.w > 4 && t.h > 4)) zero++;
      for (let i = 1; i < arr.length; i++) {
        const gap = arr[i].l - (arr[i - 1].l + arr[i - 1].w);
        if (gap < -0.6) { overlap++; if (gap < worstGap) worstGap = gap; }
      }
    }
    const keys = [...rows.keys()].sort((a, b) => a - b);
    let vOverlap = 0;
    for (let i = 1; i < keys.length; i++) {
      const prev = rows.get(keys[i - 1]), cur = rows.get(keys[i]);
      const bottom = Math.max(...prev.map((t) => t.tp + t.h));
      if (cur[0].tp < bottom - 0.6) vOverlap++;
    }
    return { tiles: list.length, rows: keys.length, overlap: overlap, worstGap: +worstGap.toFixed(2), vOverlap: vOverlap, zero: zero };
  }

  const g1 = await w.webContents.executeJavaScript(GRAB);
  fs.writeFileSync(path.join(OUT, 'grid-geo.json'), JSON.stringify(g1.slice(0, 12), null, 2));

  const a1 = analyze(g1);
  const noContain = g1.filter((t) => !(t.contain.includes('layout') && t.contain.includes('paint'))).length;
  const notAbs = g1.filter((t) => t.pos !== 'absolute').length;
  const mismatch = g1.filter((t) => Math.abs(t.rw - t.w) > 1.5 || Math.abs(t.rh - t.h) > 1.5).length;
  const containSample = g1[0] ? g1[0].contain : '';

  // 窗口变窄后重新布局
  await w.setContentSize(1000, 800);
  await new Promise((r) => setTimeout(r, 1200));
  const g2 = await w.webContents.executeJavaScript(GRAB);
  const a2 = analyze(g2);

  const shot = await w.webContents.capturePage({ x: 0, y: 0, width: 1000, height: 620 });
  fs.writeFileSync(path.join(OUT, 'grid-narrow.png'), shot.toPNG());

  /* 两种网格视图必须是**两种东西**，不是同一套布局的两个尺寸档：
       small  = 等边方格 + object-fit: cover（裁掉边角换密排，用来扫图）
       medium = 原比例行内自适应 + contain（完整显示，用来看图）
     锁这条是因为「小图中图功能重复」正是它们此前退化成同一套布局导致的。 */
  const views = await w.webContents.executeJavaScript(`(async () => {
    const A = window.App;
    const grab = () => {
      const g = document.getElementById('galleryView');
      const tiles = [...document.querySelectorAll('.tile')];
      const box = tiles.map((t) => { const r = t.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
      const imgs = tiles.map((t) => t.querySelector('img')).filter(Boolean);
      const fit = {};
      for (const im of imgs) { const v = getComputedStyle(im).objectFit; fit[v] = (fit[v] || 0) + 1; }
      return {
        mode: g.dataset.mode, n: box.length,
        square: box.filter((b) => Math.abs(b.w - b.h) <= 1).length,
        fit: fit,
      };
    };
    A.setMode('small');  await new Promise((r) => setTimeout(r, 800));
    const s = grab();
    A.setMode('medium'); await new Promise((r) => setTimeout(r, 800));
    const m = grab();
    return { s: s, m: m };
  })()`);

  console.log('GRID ' + JSON.stringify({
    wide: a1, narrow: a2,
    containSample: containSample, noContain: noContain,
    notAbs: notAbs, rectMismatch: mismatch,
    views: views,
  }));
  console.log('DONE');
  app.quit();
}).catch((e) => { console.error('ERR', (e && e.stack) || e); app.quit(); });
