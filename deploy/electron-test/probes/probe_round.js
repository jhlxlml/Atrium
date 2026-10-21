/* ============================================================
   Atrium · probe_round.js
   圆角语言门禁：量一批关键控件的**计算后圆角**，断言它们只落在
   --r-xs / --r-s / --r-m / --r-l 四档上（胶囊一律 ≥ 半高）。
   为什么需要它：圆角一旦开始写死像素，相邻四个控件会出现 9/7/8/6 四个值，
   单看每个都合理，摆在一起就"糙"（1–3px 的差在 100% 缩放下说不出哪里不对）。
   写死值回潮过一次（v1.16 及以前），所以这里做成门禁而不是靠评审盯。
   ============================================================ */
const { app, BrowserWindow, protocol, ipcMain } = require('electron');
require('./_desktop_stub').stubDesktop();
require('./_desktop_stub').stubWindowChannels();
const path = require('path');
const fs = require('fs');
const APPDIR = path.resolve(__dirname, '..', '..', '..');

app.setPath('userData', path.resolve(__dirname, '..', 'logs', 'ud_round_' + Date.now()));
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
protocol.registerSchemesAsPrivileged([{ scheme: 'vf', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }]);
ipcMain.handle('vf:trashLog', () => []);

async function run() {
  protocol.handle('vf', async (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '');
    const abs = path.resolve(APPDIR, rel || 'index.html');
    const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
      // ⚠️ CSS 必须是 text/css：标成 text/html 浏览器静默拒载，量出来的数字全是垃圾
      '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };
    try { return new Response(await fs.promises.readFile(abs), { status: 200,
      headers: { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' } }); }
    catch (e) { return new Response('404', { status: 404 }); }
  });

  const winOpts = { width: 1440, height: 900, show: true, backgroundColor: '#f5f5f7',
    webPreferences: { preload: path.join(__dirname, '..', '..', 'electron', 'preload.js'), contextIsolation: true } };
  if (process.platform === 'win32') {
    winOpts.titleBarStyle = 'hidden';
    winOpts.titleBarOverlay = { color: '#f7f5f1', symbolColor: '#3a372f', height: 34 };
  }
  const win = new BrowserWindow(winOpts);
  await win.loadURL('vf://app/index.html');
  await new Promise((r) => setTimeout(r, 900));
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 装一份图库，并把只在浮层里出现的控件点亮（设置面板 / toast / 选择条）
  await js(`(() => {
    const S = window.State, A = window.App;
    S.sources = [{ id: 's0', name: 'Screenshots', root: 'C:/x' }];
    S.items = []; for (let i = 0; i < 6; i++) S.items.push({ id: 'a'+i, name: 'IMG_'+i+'.png',
      src: 'all', sid: 's0', size: 100000, path: 'C:/x/IMG_'+i+'.png', ext: 'png' });
    S.sourceCount = () => 6;
    A.showGallery(); A.renderSources(); document.getElementById('topbar').hidden = false;
    document.querySelector('.search').classList.add('is-open');
    document.getElementById('setBtn').click();
    A.toast('探针提示');
    A.onSelChanged(2, [S.items[0], S.items[1]]);
    return true;
  })()`);
  await sleep(600);
  // 瓦片是按 `vf:autoDir` 回来的真实元数据创建的，晚一步就量到 null ——
  // 那会被误判成"瓦片圆角没了"。等它真的出现再量。
  for (let i = 0; i < 30; i++) {
    const ok = await js(`(() => !!document.querySelector('.tile') && !!document.querySelector('.set-panel') && !!document.querySelector('.sp-num'))()`);
    if (ok) break;
    await sleep(200);
  }
  if (!(await js(`(() => !!document.querySelector('.tile'))()`))) {
    console.log('ROUND {"items":null,"note":"tile 等了 6 秒还没出现，不硬测"}');
    app.quit();
    return;
  }

  const R = await js(`(() => {
    const rs = getComputedStyle(document.documentElement);
    const tok = (n) => parseFloat(rs.getPropertyValue(n));
    const T = { xs: tok('--r-xs'), s: tok('--r-s'), m: tok('--r-m'), l: tok('--r-l'), xl: tok('--r-xl') };
    const one = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el), r = el.getBoundingClientRect();
      /* bg / border 也带回来：圆角门禁顺带守"控件簇没有外框"这条 ——
         圆角回到 0 但底色或描边回来，一样是把胶囊装回去了。 */
      return { r: parseFloat(cs.borderTopLeftRadius), h: Math.round(r.height),
               w: Math.round(r.width), display: cs.display,
               bg: cs.backgroundColor, border: cs.borderTopWidth };
    };
    const out = { tokens: T, items: {} };
    const Q = {
      icoBtnTop: '.ctrls .ico-btn',
      pinBtn: '#pinBtn',
      segTrack: '.seg',
      segThumb: '.seg-btn',
      select: '.ctrls .select-wrap select',
      searchInput: '.ctrls .search.is-open input',
      ctrls: '.ctrls',
      tile: '.tile',
      btnSm: '.viewbar .btn-sm',
      btnLg: '.empty-actions .btn-lg',
      srcChip: '.src-chip',
      scCount: '.src-chip:not(.is-on) .sc-count',
      selbar: '.selbar',
      spSeg: '.sp-seg',
      spSegThumb: '.sp-seg button',
      spNum: '.sp-num',
      spSelect: '.sp-select',
      spBtn: '.sp-btn',
      spGroup: '.sp-group',
      setPanel: '#setPanel',
      toast: '.toast',
      spSwitch: '.sp-switch',
    };
    for (const [k, sel] of Object.entries(Q)) out.items[k] = one(sel);
    // 写死像素的兜底扫描：全站规则里凡是 border-radius 用了数字却不在 token 档位上的
    let hardcoded = [];
    for (const ss of document.styleSheets) {
      let rules; try { rules = ss.cssRules; } catch (e) { continue; }
      for (const rule of rules) {
        const m = /border-radius:\\s*([0-9.]+)px/.exec(rule.style ? rule.cssText : '');
        if (m) hardcoded.push(rule.selectorText + ' => ' + m[1] + 'px');
      }
    }
    out.hardcoded = hardcoded;
    return out;
  })()`);

  // 紧凑密度下的圆角走的是 calc(令牌 - 内边距)：不量这里，calc 写错没人发现
  await js(`(() => { window.App.applySetting('density', 'compact'); return true; })()`);
  await sleep(500);
  const C = await js(`(() => {
    const one = (sel) => { const el = document.querySelector(sel);
      return el ? parseFloat(getComputedStyle(el).borderTopLeftRadius) : null; };
    return { ctrls: one('.ctrls'), icoBtnTop: one('.ctrls .ico-btn'),
      density: document.body.dataset.density };
  })()`);
  R.compact = C;

  console.log('ROUND ' + JSON.stringify(R));
  app.quit();
}

app.whenReady().then(run).catch((e) => { console.error('ERR', e && e.stack || e); app.quit(); });
