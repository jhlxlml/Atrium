/* 顶栏控件区外观探针：量每个控件的位置/尺寸/底色，并截一张顶栏特写。

   目的不是"对不对"，而是把「图标排列是否均匀、大小是否一致」变成可读的数字：
   · 每个控件的宽高、水平中心、相邻间距；
   · 哪些控件是 32px 档、哪些不是（28px 的缩小/放大键就是不一致的来源）；
   · 控件簇本身有没有底色/描边（用户要的"去掉外框"就是这一层）。

   只输出原始测量值（TOPLAYOUT 一行 JSON），判定在 run_all.js。
   用法: electron.exe probe_toplayout.js  (cwd = deploy/electron) */
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
protocol.registerSchemesAsPrivileged([{ scheme: 'vf', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true } }]);
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

const MEASURE = `(() => {
  const ctrls = document.getElementById('ctrls');
  const cs = getComputedStyle(ctrls);
  const r = ctrls.getBoundingClientRect();
  const kids = [...ctrls.children].filter((el) => !el.hidden && getComputedStyle(el).display !== 'none');
  const items = kids.map((el, i) => {
    const b = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    // 图标字形本身的大小（不是按钮大小）：视觉"大小不一"通常来自这里
    const g = el.querySelector('svg');
    const gb = g ? g.getBoundingClientRect() : null;
    return {
      i: i,
      id: el.id || '',
      cls: (el.className || '').toString().split(' ').filter(Boolean).join('.'),
      x: Math.round(b.x), w: Math.round(b.width), h: Math.round(b.height),
      cy: Math.round(b.top + b.height / 2),
      radius: s.borderTopLeftRadius,
      bg: s.backgroundColor,
      border: s.borderTopWidth,
      glyph: gb ? Math.round(gb.width) + 'x' + Math.round(gb.height) : '',
    };
  });
  // 相邻间距：用 x 差减宽度算（含 flex gap）
  for (let i = 1; i < items.length; i++) {
    items[i].gapPrev = Math.round(items[i].x - (items[i - 1].x + items[i - 1].w));
  }
  const seg = document.getElementById('modeSeg');
  const segR = seg.getBoundingClientRect();
  const segBtns = [...seg.querySelectorAll('.seg-btn')].map((b) => {
    const q = b.getBoundingClientRect();
    return { w: Math.round(q.width), h: Math.round(q.height), on: b.classList.contains('is-on') };
  });
  /* 选中滑片：没有轨道之后，它必须**自己**立得住 —— 有底、有投影、字号没缩。
     这三样缺一样，选中态就退化成"颜色稍微深一点的文字"。 */
  const onBtn = seg.querySelector('.seg-btn.is-on');
  const onCs = onBtn ? getComputedStyle(onBtn) : null;
  const onRect = onBtn ? onBtn.getBoundingClientRect() : null;
  const on = onCs ? {
    w: Math.round(onRect.width), h: Math.round(onRect.height),
    bg: onCs.backgroundColor,
    shadow: onCs.boxShadow,
    color: onCs.color,
    radius: onCs.borderTopLeftRadius,
    font: onCs.fontFamily.split(',')[0].replace(/"/g, ''),
  } : null;
  const iconBtns = [...ctrls.querySelectorAll('.ico-btn')].filter((b) => !b.hidden && b.offsetParent !== null);
  const sizes = {};
  for (const b of iconBtns) {
    const q = b.getBoundingClientRect();
    const k = Math.round(q.width) + 'x' + Math.round(q.height);
    sizes[k] = (sizes[k] || 0) + 1;
  }
  return {
    ctrls: {
      x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height),
      bg: cs.backgroundColor, border: cs.borderTopWidth, radius: cs.borderTopLeftRadius,
      padding: cs.padding,
      /* 横向内边距单列出来：外框去掉后，"控件离边界多远"由它决定。
         纵向那 3px 是给选中滑片的投影留的落地空间，与"有没有框"无关。 */
      padX: (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0),
      gap: cs.gap,
    },
    /* 右端对齐：工具栏右缘应当落在内容区（.stage-wrap）的**内容**右缘上
       —— 量 border box 会差一个 --gutter，那 22px 会被误判成"没对齐"。
       这两条线一旦错开，顶栏右侧会比网格多出一截"空气"，肉眼很难说清但看得出。 */
    align: {
      innerW: Math.round(window.innerWidth),
      ctrlsRight: Math.round(r.right),
      stageRight: (() => {
        const st = document.querySelector('.stage-wrap');
        if (!st) return null;
        const b = st.getBoundingClientRect();
        return Math.round(b.right - (parseFloat(getComputedStyle(st).paddingRight) || 0));
      })(),
      gutter: getComputedStyle(document.documentElement).getPropertyValue('--gutter').trim(),
    },
    seg: { w: Math.round(segR.width), h: Math.round(segR.height), bg: getComputedStyle(seg).backgroundColor,
           radius: getComputedStyle(seg).borderTopLeftRadius, padding: getComputedStyle(seg).padding,
           btns: segBtns, on: on },
    items: items,
    iconBtnSizes: sizes,
    iconCount: iconBtns.length,
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
        return new Response(b, { headers: { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'access-control-allow-origin': 'vf://app' } });
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

  // 装几张图：有内容才看得见滑杆、收藏、最近删除这些只在图库态出现的控件
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
    /* 模式必须**显式**点成中图：探针共用持久分区，上一次跑（比如 single 套件）
       可能把模式存成了单列 —— 而单列会隐藏整个尺寸滑杆组，
       于是"控件簇"少了一组还照样量出一堆数字。点一下比读状态可靠。 */
    document.querySelector('#modeSeg .seg-btn[data-mode="medium"]').click();
    return S.items.length;
  })()`);
  await sleep(1600);

  const data = await js(MEASURE);

  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  /* 顶栏特写：只截控件簇那一段（含左右各 14px 余量），放大 2.4× ——
     全宽 1500px 的截图里控件只有十几个像素，肉眼分不出"图标是否一样大"。 */
  const cx = Math.max(0, data.ctrls.x - 14);
  const shot = { x: cx, y: 0, width: Math.min(1500 - cx, data.ctrls.w + 28), height: 120 };
  const raw = await win.webContents.capturePage(shot);
  const big = raw.resize({ width: Math.round(shot.width * 2.4), quality: 'best' });
  // TAG=before / TAG=after 可以把改版前后两张图并排留着比对
  const tag = process.env.TAG ? '-' + process.env.TAG : '';
  fs.writeFileSync(path.join(OUT, 'toplayout' + tag + '.png'), big.toPNG());

  /* 分段控件特写 4×：选中态到底"看得出"没有，只有放到这个倍数才判得了。
     没有轨道之后，白滑块是靠投影和 3% 的明度差立起来的 —— 太弱就等于没选中。 */
  const segRect = await js(`(() => { const b = document.getElementById('modeSeg').getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; })()`);
  const segShot = { x: Math.max(0, segRect.x - 8), y: Math.max(0, segRect.y - 8),
    width: segRect.w + 16, height: segRect.h + 16 };
  const segRaw = await win.webContents.capturePage(segShot);
  fs.writeFileSync(path.join(OUT, 'toplayout' + tag + '-seg.png'),
    segRaw.resize({ width: Math.round(segShot.width * 4), quality: 'best' }).toPNG());

  /* 搜索展开态也来一张：输入框是这条工具栏里唯一"带填充的盒子"，
     它矮 3px 就看得出来（其它键都是 32）。这个状态平时截不到，得点开。 */
  await js(`(() => { document.getElementById('searchToggle').click(); return true; })()`);
  await sleep(500);
  const sOpen = await js(`(() => { const c = document.getElementById('ctrls').getBoundingClientRect();
    const i = document.getElementById('searchInput').getBoundingClientRect();
    return { x: Math.round(c.x), w: Math.round(c.width), inputH: Math.round(i.height),
             inputW: Math.round(i.width) }; })()`);
  const sox = Math.max(0, sOpen.x - 14);
  const soShot = { x: sox, y: 0, width: Math.min(1500 - sox, sOpen.w + 28), height: 120 };
  const soRaw = await win.webContents.capturePage(soShot);
  fs.writeFileSync(path.join(OUT, 'toplayout' + tag + '-search.png'),
    soRaw.resize({ width: Math.round(soShot.width * 2.4), quality: 'best' }).toPNG());
  console.log('TOPLAYOUT_SEARCH ' + JSON.stringify(sOpen));
  await js(`(() => { document.getElementById('searchToggle').click(); return true; })()`);
  await sleep(300);

  /* 深色 + 窄窗各来一张：白滑块在深色里、文字在收起后能不能读，
     光看浅色宽窗那张图是看不出来的。 */
  await js(`(() => { document.body.dataset.theme = 'dark'; return true; })()`);
  await sleep(400);
  const darkRaw = await win.webContents.capturePage(shot);
  fs.writeFileSync(path.join(OUT, 'toplayout' + tag + '-dark.png'),
    darkRaw.resize({ width: Math.round(shot.width * 2.4), quality: 'best' }).toPNG());

  await js(`(() => { document.body.dataset.theme = 'light'; return true; })()`);
  win.setContentSize(1100, 800);
  await sleep(600);
  const nr = await js(`(() => { const r = document.getElementById('ctrls').getBoundingClientRect();
    return { x: Math.round(r.x), w: Math.round(r.width), scrolls: document.getElementById('ctrls').scrollWidth > document.getElementById('ctrls').clientWidth + 1 }; })()`);
  const nrx = Math.max(0, nr.x - 14);
  const nrShot = { x: nrx, y: 0, width: Math.min(1100 - nrx, nr.w + 28), height: 120 };
  const nrRaw = await win.webContents.capturePage(nrShot);
  fs.writeFileSync(path.join(OUT, 'toplayout' + tag + '-narrow.png'),
    nrRaw.resize({ width: Math.round(nrShot.width * 2.4), quality: 'best' }).toPNG());
  console.log('TOPLAYOUT_NARROW ' + JSON.stringify(nr));

  console.log('TOPLAYOUT ' + JSON.stringify(data));
  console.log('DONE');
  app.quit();
}).catch((e) => { console.error('ERR', (e && e.stack) || e); app.quit(); });
