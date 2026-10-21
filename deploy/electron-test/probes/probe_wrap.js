/* 折行探针：找出「本该一行、却被挤成两行」的文字。
   ------------------------------------------------------------
   为什么专门做这个：
     这类缺陷有个共同特征 —— **它只在某个宽度下出现**。
     写 CSS 时窗口是宽的，一切正常；用户把窗口拖窄一点，
     flex 就开始压缩最软的那个子项，而"最软"往往是最不该动的那块
     （计数、状态、文件名）。结果是一个数字标签被折成两行，
     看着像渲染出错，而开发者的窗口里永远复现不出来。

   判定方法：用 Range 取每个文本节点的 line box 数量。
     nowrap / 省略号 → 1 个 rect（省略号不新增行盒）
     真折行          → 2 个以上 rect
   这比"量高度除以行高"准，也不受 padding 影响。

   用法: node deploy/electron-test/run_probe.js probe_wrap.js */
const { app, BrowserWindow, protocol, ipcMain } = require('electron');

require('./_desktop_stub').stubDesktop();
require('./_desktop_stub').stubWindowChannels();

const path = require('path');
const fs = require('fs');
const APPDIR = path.resolve(__dirname, '..', '..', '..');
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

/* 扫一组容器，把"文本节点被折成多行"的挑出来。
   只扫指定容器内部 —— 设置面板、正文段落本来就是多行，不该报。 */
const SCAN = (sels) => `(() => {
  const out = [];
  let bars = 0, texts = 0;
  const walk = (root, label) => {
    bars++;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    let n;
    while ((n = w.nextNode())) {
      const host = n.parentElement;
      if (!host) continue;
      const cs = getComputedStyle(host);
      if (cs.display === 'none' || cs.visibility === 'hidden' || !host.getClientRects().length) continue;
      texts++;
      const r = document.createRange();
      r.selectNodeContents(n);
      const lines = r.getClientRects().length;
      if (lines > 1) {
        out.push({ bar: label, text: n.nodeValue.trim().slice(0, 28), lines: lines,
                   el: (host.className || host.tagName).toString().slice(0, 40) });
      }
    }
  };
  for (const [sel, label] of ${JSON.stringify(sels)}) {
    const el = document.querySelector(sel);
    if (!el || el.hidden) continue;
    walk(el, label);
  }
  return { hits: out, bars: bars, texts: texts };
})()`;

const BARS = [
  ['.ctrls', '顶栏控件区'],
  ['.statusline', '底部状态栏'],
  ['.selbar', '选择条'],
  ['.tv-top', '回收站标题栏'],
  ['.lb-hud', '灯箱 HUD'],
  ['.side-active', '来源按钮'],
];

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

  const base = collect(PICDIR, PICDIR).filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f.abs)).slice(0, 6);
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
  await sleep(1500);

  const report = [];
  let barsSeen = 0, textsSeen = 0;
  /* 每次扫描都累加"实际看了几条栏、几个文本节点" —— 探针要是自己瞎了，
     结果会变成"0 处折行"，那是最危险的假绿。 */
  const scan = async () => {
    const r = await js(SCAN(BARS));
    barsSeen += r.bars; textsSeen += r.texts;
    return r.hits;
  };

  /* ---- 1) 顶栏 + 状态栏：宽窗 / 窄窗各扫一遍 ----
     窄窗是这类缺陷的唯一温床，必须显式造出来（1200 / 1000 / 880 三档）。 */
  for (const w of [1500, 1200, 1000, 880]) {
    win.setContentSize(w, 900);
    await sleep(700);
    const hits = await scan();
    for (const h of hits) report.push(Object.assign({ width: w }, h));
  }
  win.setContentSize(1500, 900);
  await sleep(500);

  /* ---- 2) 选择条（最容易折的一处：计数 + 提示 + 五个按钮挤一条）---- */
  for (const w of [1500, 1000, 880]) {
    win.setContentSize(w, 900);
    await sleep(400);
    await js(`(() => { window.App.onSelChanged(12, window.State.items.slice(0, 2)); return true; })()`);
    await sleep(500);
    const hits = await scan();
    for (const h of hits) report.push(Object.assign({ width: w, scene: 'selbar' }, h));
  }
  await js(`(() => { window.App.clearSel && window.App.clearSel(); return true; })()`);
  win.setContentSize(1500, 900);
  await sleep(400);

  /* ---- 3) 回收站标题栏 ---- */
  await js(`(async () => { await window.App.openTrash(); return true; })()`);
  await sleep(900);
  for (const w of [1500, 1000]) {
    win.setContentSize(w, 900);
    await sleep(600);
    const hits = await scan();
    for (const h of hits) report.push(Object.assign({ width: w, scene: 'trash' }, h));
  }
  await js(`(() => { window.App.toggleTrash && window.App.toggleTrash(false); return true; })()`);
  win.setContentSize(1500, 900);
  await sleep(500);

  /* ---- 4) 灯箱 HUD（文件名很长时会不会把计数挤折）---- */
  await js(`(() => {
    const S = window.State;
    S.items[0].name = '2024-10-21_家庭相册_第三次筛选_最终版_高分辨率.png';
    window.Lightbox.open(S.viewList(), S.items[0]);
    return true;
  })()`);
  await sleep(1000);
  for (const w of [1500, 1000]) {
    win.setContentSize(w, 900);
    await sleep(600);
    const hits = await scan();
    for (const h of hits) report.push(Object.assign({ width: w, scene: 'lightbox' }, h));
  }
  await js(`(() => { window.Lightbox.close(); return true; })()`);
  await sleep(300);

  const data = {
    scanned: report.length === 0 ? 'clean' : 'wrapped',
    total: report.length,
    barsSeen: barsSeen,
    textsSeen: textsSeen,
    items: report,
  };
  console.log('WRAP ' + JSON.stringify(data));
  console.log('DONE');
  app.quit();
}).catch((e) => { console.error('ERR', (e && e.stack) || e); app.quit(); });
