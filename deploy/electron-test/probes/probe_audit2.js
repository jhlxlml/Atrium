/* 一次性：UI 审查补充测量（空态按钮 / 窄窗溢出 / 对比度 / 焦点环） */
const { app, BrowserWindow, protocol, ipcMain } = require('electron');
require('./_desktop_stub').stubDesktop();
require('./_desktop_stub').stubWindowChannels();
const path = require('path');
const fs = require('fs');
const APPDIR = path.resolve(__dirname, '..', '..', '..');

app.setPath('userData', path.resolve(__dirname, '..', 'logs', 'ud_audit2_' + Date.now()));
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
protocol.registerSchemesAsPrivileged([{ scheme: 'vf', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true } }]);
ipcMain.handle('vf:trashLog', () => []);

async function run() {
  protocol.handle('vf', async (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '');
    const abs = path.resolve(APPDIR, rel || 'index.html');
    const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };
    // ⚠️ CSS 必须返回 text/css：标成 text/html 时浏览器直接拒载，全站样式静默失效
    // （症状是"所有元素都是无样式默认外观"，量出来的数字全是垃圾）。
    try { return new Response(await fs.promises.readFile(abs), { status: 200,
      headers: { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'access-control-allow-origin': 'vf://app' } }); }
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
  const R = {};

  /* ---------- 1. 空态页 ---------- */
  R.empty = await js(`(() => {
    const title = document.querySelector('.empty-title');
    const btn = document.querySelector('.empty-actions .btn');
    const r = btn ? btn.getBoundingClientRect() : null;
    const cs = btn ? getComputedStyle(btn) : null;
    const lines = title ? Math.round(title.getBoundingClientRect().height /
      parseFloat(getComputedStyle(title).lineHeight)) : 0;
    return {
      titleText: title ? title.textContent : null,
      titleLines: lines,
      titleH: title ? Math.round(title.getBoundingClientRect().height) : null,
      btn: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null,
      btnRadius: cs ? cs.borderRadius : null,
      btnRadiusVsHalfRatio: r ? +(parseFloat(cs.borderTopLeftRadius) / (r.height / 2)).toFixed(2) : null,
      btnFont: cs ? cs.fontSize + '/' + cs.fontWeight : null,
      hintFont: (() => { const h = document.querySelector('.empty-hint');
        const c = h ? getComputedStyle(h) : null; return c ? c.fontSize + ' ' + c.color : null; })(),
    };
  })()`);

  /* ---------- 2. 图库 + 窄窗溢出 ---------- */
  await js(`(() => {
    const S = window.State, A = window.App;
    S.sources = [{ id: 's0', name: 'Screenshots', root: 'C:/x' }];
    S.items = []; for (let i = 0; i < 7; i++) S.items.push({ id: 'a'+i, name: 'IMG_'+i+'.png',
      src: 'all', sid: 's0', size: 100000, path: 'C:/x/IMG_'+i+'.png', ext: 'png' });
    S.sourceCount = () => 7;
    A.showGallery(); A.renderSources(); document.getElementById('topbar').hidden = false; return true;
  })()`);
  await sleep(500);
  R.overflow = {};
  for (const w of [1440, 1280, 1100, 900, 760, 640]) {
    await win.setContentSize(w, 800);
    await sleep(420);
    R.overflow[w] = await js(`(() => {
      const c = document.querySelector('.ctrls');
      const ti = document.querySelector('.topbar-in');
      const seg = document.querySelector('#modeSeg');
      const cs = getComputedStyle(seg);
      const txt = seg.querySelector('.seg-txt');
      const sb = document.getElementById('sidebar');
      return {
        ctrlsScrolls: c.scrollWidth > c.clientWidth + 1,
        ctrlsOverflowPx: c.scrollWidth - c.clientWidth,
        topbarH: Math.round(ti.getBoundingClientRect().height),
        segTxtHidden: txt ? getComputedStyle(txt).display === 'none' : null,
        segW: Math.round(seg.getBoundingClientRect().width),
        sideW: sb ? Math.round(sb.getBoundingClientRect().width) : null,
        mainW: Math.round(document.getElementById('main').getBoundingClientRect().width),
        firstTileW: (() => { const t = document.querySelector('.tile');
          return t ? Math.round(t.getBoundingClientRect().width) : null; })(),
      };
    })()`);
  }

  /* ---------- 3. 对比度：把关键文字实际算一遍 ---------- */
  R.contrast = await js(`(() => {
    const lum = (rgb) => {
      const m = /rgba?\\((\\d+)[,\\s]+(\\d+)[,\\s]+(\\d+)/.exec(String(rgb||''));
      if (!m) return NaN;
      const ch = [1,2,3].map(i => { const s = (+m[i])/255; return s <= 0.03928 ? s/12.92 : Math.pow((s+0.055)/1.055, 2.4); });
      return 0.2126*ch[0] + 0.7152*ch[1] + 0.0722*ch[2];
    };
    // 半透明底色要合成到纸色上再算
    const over = (fg, bg, a) => 'rgb(' + [0,1,2].map(i => Math.round(+fg.match(/\\d+/g)[i]*a + +bg.match(/\\d+/g)[i]*(1-a))).join(',') + ')';
    const paper = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
    const paper2 = getComputedStyle(document.documentElement).getPropertyValue('--paper-2').trim();
    const hex2rgb = (h) => { const n = parseInt(h.replace('#',''),16);
      return 'rgb(' + [(n>>16)&255,(n>>8)&255,n&255].join(',') + ')'; };
    const P = hex2rgb(paper), P2 = hex2rgb(paper2);
    const ratio = (a, b) => { const la = lum(a), lb = lum(b);
      return +((Math.max(la,lb)+0.05)/(Math.min(la,lb)+0.05)).toFixed(2); };
    const muted = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim();
    const mutedRGB = hex2rgb(muted);
    const sbTitle = document.querySelector('.sb-title');
    const bodyTxt = document.querySelector('.src-chip .sc-name');
    const cnt = document.querySelector('.src-chip .sc-count');
    const out = { onPaper: ratio(mutedRGB, P), onPaper2: ratio(mutedRGB, P2) };
    if (sbTitle) out.sbTitleColor = getComputedStyle(sbTitle).color;
    if (bodyTxt) { const c = getComputedStyle(bodyTxt).color; out.chipNameOnPaper2 = ratio(c, P2); out.chipName = c; }
    if (cnt) { const c = getComputedStyle(cnt); const fill = getComputedStyle(document.documentElement).getPropertyValue('--fill-2').trim();
      const F = hex2rgb(fill); out.countOnFill = ratio(c.color, F); out.countColor = c.color; }
    // 深色
    window.App.applySetting('theme', 'dark');
    const P2d = hex2rgb(getComputedStyle(document.documentElement).getPropertyValue('--paper-2').trim());
    const Pd = hex2rgb(getComputedStyle(document.documentElement).getPropertyValue('--paper').trim());
    out.dark = { sbTitle: ratio(getComputedStyle(document.querySelector('.sb-title')).color, P2d),
      chipName: ratio(getComputedStyle(document.querySelector('.src-chip .sc-name')).color, P2d),
      count: ratio(getComputedStyle(document.querySelector('.src-chip .sc-count')).color,
        hex2rgb(getComputedStyle(document.documentElement).getPropertyValue('--fill-2').trim())) };
    window.App.applySetting('theme', 'light');
    return out;
  })()`);

  /* ---------- 4. 焦点环是否真的存在（读 CSS 规则，不靠截图） ---------- */
  R.focus = await js(`(() => {
    const has = (sel, prop) => {
      for (const ss of document.styleSheets) { let rules; try { rules = ss.cssRules; } catch (e) { continue; }
        for (const r of rules) {
          if (r.selectorText && r.selectorText.includes(sel) && r.style && r.style[prop]) return r.style[prop];
        } }
      return null;
    };
    return {
      icoBtnFocus: has('.ico-btn:focus-visible', 'outline'),
      btnFocus: has('.btn:focus-visible', 'outline'),
      srcChipFocus: has('.src-chip:focus-visible', 'outline'),
      tileFocus: has('.tile:focus-visible', 'outline'),
    };
  })()`);

  console.log('AUDIT2 ' + JSON.stringify(R, null, 1));
  app.quit();
}

app.whenReady().then(run).catch((e) => { console.error('ERR', e && e.stack || e); app.quit(); });
