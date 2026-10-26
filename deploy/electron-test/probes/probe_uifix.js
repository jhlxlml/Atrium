/* 一次性：v1.17.0 UI 修复项复核（圆角令牌 / 胶囊按钮 / 对比度 /
   窄窗自动让位 / 紧凑密度 / 空态断行 / 焦点环副作用）。
   与 probe_audit2.js 同一套本地 protocol 桩 —— 改 MIME 会让样式静默失效。 */
const { app, BrowserWindow, protocol, ipcMain } = require('electron');
require('./_desktop_stub').stubDesktop();
require('./_desktop_stub').stubWindowChannels();
const path = require('path');
const fs = require('fs');
const APPDIR = path.resolve(__dirname, '..', '..', '..');

app.setPath('userData', path.resolve(__dirname, '..', 'logs', 'ud_uifix_' + Date.now()));
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
    // ⚠️ CSS 必须返回 text/css：标成 text/html 时浏览器直接拒载样式表，零报错、全是垃圾数据
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

  /* ---------- 0. 圆角清单（图库态可采到的控件 + 空态按钮） ---------- */
  R.emptyTitle = await js(`(() => {
    const t = document.querySelector('.empty-title');
    const d = document.querySelector('.empty-desc');
    const cs = t ? getComputedStyle(t) : null;
    return {
      hasBrNode: /<br/i.test(t ? t.innerHTML : ''),
      lines: t && cs ? Math.round(t.getBoundingClientRect().height / parseFloat(cs.lineHeight)) : 0,
      wrap: cs ? cs.textWrap : null,
      descWrap: d ? getComputedStyle(d).textWrap : null,
      descBrNode: /<br/i.test(d ? d.innerHTML : ''),
      descLines: d ? Math.round(d.getBoundingClientRect().height / parseFloat(getComputedStyle(d).lineHeight)) : 0,
    };
  })()`);
  R.btnLg = await js(`(() => {
    const b = document.querySelector('.empty-actions .btn-lg');
    if (!b) return null;
    const cs = getComputedStyle(b); const r = b.getBoundingClientRect();
    const rad = cs.borderTopLeftRadius;
    return { h: Math.round(r.height), rad: rad, w: Math.round(r.width),
      isPill: parseFloat(rad) >= r.height / 2 - 0.5 };
  })()`);

  /* ---------- 1. 装一份图库，量图库态各控件的圆角 ---------- */
  await js(`(() => {
    const S = window.State, A = window.App;
    S.sources = [{ id: 's0', name: 'Screenshots', root: 'C:/x' },
                 { id: 's1', name: '空夹', root: 'C:/y' }];
    S.items = []; for (let i = 0; i < 6; i++) S.items.push({ id: 'a'+i, name: 'IMG_'+i+'.png',
      src: 'all', sid: 's0', size: 100000, path: 'C:/x/IMG_'+i+'.png', ext: 'png' });
    S.sourceCount = (id) => id === 's0' ? 6 : 0;
    A.showGallery(); A.renderSources(); document.getElementById('topbar').hidden = false;
    // 让搜索框展开，才能量到输入框自己的圆角
    document.querySelector('.search').classList.add('is-open');
    // 打开设置面板 + 弹一条 toast + 亮出选择条：
    // 只存在于浮层里的控件要靠它们才采得到
    document.getElementById('setBtn').click();
    A.toast('探针提示');
    A.onSelChanged(2, [window.State.items[0], window.State.items[1]]);
    return true;
  })()`);
  await sleep(600);

  R.radii = await js(`(() => {
    const Q = {
      '#pinBtn': 'pinBtn', '.ico-btn:not(.sb-collapse)': 'icoBtn',
      '.seg': 'segTrack', '.seg-btn': 'segThumb',
      '.select-wrap select': 'select', '.search.is-open input': 'searchInput',
      '.ctrls': 'ctrlsPill', '.tile': 'tile',
      '.btn-sm': 'btnSm', '.src-chip': 'srcChip', '.side-active': 'sideActive',
      '.sc-count': 'scCount', '.selbar': 'selbar', '.sb-count': 'sbCount',
      '.sp-num': 'spNum', '.sp-select': 'spSelect', '.sp-btn': 'spBtn',
      '.toast': 'toast', '.sp-group': 'spGroup', '.set-panel': 'setPanel',
      '.sp-seg': 'spSeg', '.sp-seg button': 'spSegThumb', '.sp-switch': 'spSwitch',
    };
    const out = {};
    for (const [sel, key] of Object.entries(Q)) {
      if (key === '-') continue;
      const el = document.querySelector(sel);
      if (!el) { out[key] = null; continue; }
      const cs = getComputedStyle(el);
      out[key] = { r: parseFloat(cs.borderTopLeftRadius).toFixed(1),
                   h: Math.round(el.getBoundingClientRect().height) };
    }
    // 令牌本身（:root / body[data-density] 不会被覆盖，取 :root 就够）
    const rs = getComputedStyle(document.documentElement);
    out.tokens = ['--r-xs','--r-s','--r-m','--r-l','--r-xl']
      .map((t) => t + '=' + rs.getPropertyValue(t).trim());
    // calc 出来的同心圆角要单独确认是不是真的解算成数字
    const sb = document.querySelector('.seg-btn');
    out.segThumbResolved = sb ? getComputedStyle(sb).borderRadius : null;
    return out;
  })()`);

  /* ---------- 2. 空来源行 ---------- */
  await js(`(() => { document.getElementById('setClose').click();
    window.App.onSelChanged(0, []);
    document.querySelector('.search').classList.remove('is-open');
    return true; })()`);
  await sleep(300);
  R.emptyRow = await js(`(() => {
    const rows = [...document.querySelectorAll('.src-chip')];
    const z = rows.find((r) => /0/.test((r.querySelector('.sc-count') || {}).textContent || ''));
    return {
      rows: rows.length,
      zeroRowCount: rows.filter((r) => r.classList.contains('is-empty')).length,
      zeroTitle: z ? z.title : null,
      zeroHasX: !!(z && z.querySelector('.sc-x')),
    };
  })()`);

  /* ---------- 3. 对比度（浅色 + 深色） ---------- */
  R.contrast = await js(`(() => {
    const lum = (rgb) => {
      const m = /rgba?\\((\\d+)[,\\s]+(\\d+)[,\\s]+(\\d+)/.exec(String(rgb||''));
      if (!m) return NaN;
      const ch = [1,2,3].map(i => { const s = (+m[i])/255; return s <= 0.03928 ? s/12.92 : Math.pow((s+0.055)/1.055, 2.4); });
      return 0.2126*ch[0] + 0.7152*ch[1] + 0.0722*ch[2];
    };
    const hex2rgb = (h) => { const n = parseInt(h.replace('#',''),16);
      return 'rgb(' + [(n>>16)&255,(n>>8)&255,n&255].join(',') + ')'; };
    const rootCS = getComputedStyle(document.documentElement);
    const bodyCS = getComputedStyle(document.body);
    const ratio = (a, b) => { const la = lum(a), lb = lum(b);
      return +((Math.max(la,lb)+0.05)/(Math.min(la,lb)+0.05)).toFixed(2); };
    const P = hex2rgb(bodyCS.getPropertyValue('--paper').trim());
    const P2 = hex2rgb(bodyCS.getPropertyValue('--paper-2').trim());
    const measure = () => {
      const bg = hex2rgb(bodyCS.getPropertyValue('--paper-2').trim());
      const fill = hex2rgb(bodyCS.getPropertyValue('--fill-2').trim());
      // 半透明填充合成到侧栏底色上
      const a = parseFloat(/([\\d.]+)\\)$/.exec(bodyCS.getPropertyValue('--fill-2').trim())[1]) || 1;
      const fillRGB = 'rgb(' + [0,1,2].map(i => Math.round(+fill.match(/\\d+/g)[i]*a + +bg.match(/\\d+/g)[i]*(1-a))).join(',') + ')';
      return {
        sbTitle: ratio(getComputedStyle(document.querySelector('.sb-title')).color, bg),
        scCount: ratio(getComputedStyle(document.querySelector('.src-chip:not(.is-on) .sc-count')).color, fillRGB),
        scName: ratio(getComputedStyle(document.querySelector('.src-chip:not(.is-on) .sc-name')).color, bg),
        paper2: bodyCS.getPropertyValue('--paper-2').trim(),
      };
    };
    const out = { light: measure() };
    window.App.applySetting('theme', 'dark');
    void P; void P2; void rootCS;
    return out;
  })()`);
  // ⚠️ 颜色有 .2s 过渡：主题一切过去立刻量，量到的是**中间值**
  // （曾经据此得出"深色下 --ink-2 只有 2.3:1"的错误结论）。
  await sleep(600);
  R.contrastDark = await js(`(() => {
    const lum = (rgb) => {
      const m = /rgba?\\((\\d+)[,\\s]+(\\d+)[,\\s]+(\\d+)/.exec(String(rgb||''));
      if (!m) return NaN;
      const ch = [1,2,3].map(i => { const s = (+m[i])/255; return s <= 0.03928 ? s/12.92 : Math.pow((s+0.055)/1.055, 2.4); });
      return 0.2126*ch[0] + 0.7152*ch[1] + 0.0722*ch[2];
    };
    const hex2rgb = (h) => { const n = parseInt(h.replace('#',''),16);
      return 'rgb(' + [(n>>16)&255,(n>>8)&255,n&255].join(',') + ')'; };
    const bodyCS = getComputedStyle(document.body);
    const ratio = (a, b) => { const la = lum(a), lb = lum(b);
      return +((Math.max(la,lb)+0.05)/(Math.min(la,lb)+0.05)).toFixed(2); };
    const bg = hex2rgb(bodyCS.getPropertyValue('--paper-2').trim());
    const fill = hex2rgb(bodyCS.getPropertyValue('--fill-2').trim());
    const al = parseFloat(/([\\d.]+)\\)$/.exec(bodyCS.getPropertyValue('--fill-2').trim())[1]) || 1;
    const fillRGB = 'rgb(' + [0,1,2].map(i => Math.round(+fill.match(/\\d+/g)[i]*al + +bg.match(/\\d+/g)[i]*(1-al))).join(',') + ')';
    return {
      sbTitle: ratio(getComputedStyle(document.querySelector('.sb-title')).color, bg),
      scCount: ratio(getComputedStyle(document.querySelector('.src-chip:not(.is-on) .sc-count')).color, fillRGB),
      scName: ratio(getComputedStyle(document.querySelector('.src-chip:not(.is-on) .sc-name')).color, bg),
      paper2: bodyCS.getPropertyValue('--paper-2').trim(),
    };
  })()`);
  await js(`(() => { window.App.applySetting('theme', 'light'); return true; })()`);
  await sleep(400);

  /* ---------- 4. 焦点环不再动圆角 ---------- */
  R.focusRing = await js(`(() => {
    let global = null;
    for (const ss of document.styleSheets) { let rules; try { rules = ss.cssRules; } catch (e) { continue; }
      for (const r of rules) {
        if (r.selectorText && r.selectorText.trim() === ':focus-visible' && r.style) {
          global = { outline: r.style.outline, radius: r.style.borderRadius || '' };
        }
      }
    }
    const sb = document.querySelector('.selbar') || document.querySelector('.sb-head .ico-btn');
    const before = sb ? getComputedStyle(sb).borderTopLeftRadius : null;
    sb && sb.focus();
    return { globalRule: global, elemRadiusBeforeFocus: before,
      // 元素自身圆角不会因为获得焦点被改写（改写只会来自规则，故读规则足够）
      linkFocusRadius: (() => { for (const ss of document.styleSheets) { let rules; try { rules = ss.cssRules; } catch (e) { continue; }
        for (const r of rules) {
          if (r.selectorText && r.selectorText.includes('.vf-about-link:focus-visible') && r.style) {
            return r.style.borderRadius || '';
          }
        }
      } return null; })() };
  })()`);

  /* ---------- 5. 窄窗自动让位 ---------- */
  await win.setContentSize(900, 800);
  await sleep(700);
  R.narrow = {};
  R.narrow.w900 = await js(`(() => {
    const sb = document.getElementById('sidebar');
    return {
      inner: window.innerWidth,
      mq: window.matchMedia('(max-width: 900px)').matches,
      sideW: Math.round(sb.getBoundingClientRect().width),
      collapsed: document.getElementById('workspace').classList.contains('is-collapsed'),
      setting: window.State.settings.sidebarOpen,
      openNow: window.App.sidebarOpenNow(),
      sideActiveHidden: document.getElementById('sideActive') ? document.getElementById('sideActive').hidden : null,
      mainW: Math.round(document.getElementById('main').getBoundingClientRect().width),
      menuSide: window.App.menuState().side,
    };
  })()`);

  // 窄窗里手动展开 → 应该真的展开，且不写坏用户设置
  await js(`(() => { window.App.toggleSidebar(true); return true; })()`);
  await sleep(320);
  R.narrow.openByHand = await js(`(() => ({
    collapsed: document.getElementById('workspace').classList.contains('is-collapsed'),
    setting: window.State.settings.sidebarOpen,
    sideW: Math.round(document.getElementById('sidebar').getBoundingClientRect().width),
    openNow: window.App.sidebarOpenNow(),
    menuSide: window.App.menuState().side,
  }))()`);
  await js(`(() => { window.App.toggleSidebar(); return true; })()`);
  await sleep(300);
  R.narrow.closeByHand = await js(`(() => ({
    collapsed: document.getElementById('workspace').classList.contains('is-collapsed'),
    setting: window.State.settings.sidebarOpen,
    openNow: window.App.sidebarOpenNow(),
  }))()`);

  // 回到宽窗 → 自动恢复成"开"（设置里的用户意图）
  await js(`(() => { window.State.settings.sidebarOpen = true; window.App.applySidebarUI(true); return true; })()`);
  await win.setContentSize(1440, 800);
  await sleep(500);
  R.narrow.backWide = await js(`(() => ({
    collapsed: document.getElementById('workspace').classList.contains('is-collapsed'),
    setting: window.State.settings.sidebarOpen,
    openNow: window.App.sidebarOpenNow(),
    forcedFlag: window.App._sideForced,
  }))()`);
  // 再进窄窗 → 重新自动收
  await win.setContentSize(880, 800);
  await sleep(500);
  R.narrow.narrowAgain = await js(`(() => ({
    collapsed: document.getElementById('workspace').classList.contains('is-collapsed'),
    setting: window.State.settings.sidebarOpen,
    openNow: window.App.sidebarOpenNow(),
    forcedFlag: window.App._sideForced,
  }))()`);
  await win.setContentSize(1440, 800);
  await sleep(400);

  /* ---------- 6. 紧凑密度 ---------- */
  await js(`(() => { window.App.applySetting('density', 'compact'); return true; })()`);
  await sleep(700);
  R.compact = await js(`(() => {
    const gap = () => window.Grid.gap;
    return {
      gridGap: gap(), topbarH: Math.round(document.querySelector('.topbar-in').getBoundingClientRect().height),
      stagePadTop: getComputedStyle(document.querySelector('.stage-wrap')).paddingTop,
      statusPadTop: getComputedStyle(document.querySelector('.statusline')).paddingTop,
      ctrlsH: document.querySelector('.ctrls').classList.contains ? null : null,
    };
  })()`);
  R.compact.ctrlsH = await js(`(() => Math.round(document.querySelector('.ctrls').getBoundingClientRect().height))()`);
  // 同一行相邻两张瓦片的**水平**间距（行间距看着难：行与行之间还夹着标题区）
  R.compact.tileRowGap = await js(`(() => {
    const t = [...document.querySelectorAll('.tile')];
    const sameRow = t.filter((x) => Math.abs(x.getBoundingClientRect().top - t[0].getBoundingClientRect().top) < 2);
    if (sameRow.length < 2) return null;
    const a = sameRow[0].getBoundingClientRect(), b = sameRow[1].getBoundingClientRect();
    return Math.round(b.left - a.right);
  })()`);
  await js(`(() => { window.App.applySetting('density', 'cozy'); return true; })()`);
  await sleep(700);
  R.cozy = await js(`(() => ({
    gridGap: window.Grid.gap,
    topbarH: Math.round(document.querySelector('.topbar-in').getBoundingClientRect().height),
    tileRowGap: (() => { const t = [...document.querySelectorAll('.tile')];
      const sameRow = t.filter((x) => Math.abs(x.getBoundingClientRect().top - t[0].getBoundingClientRect().top) < 2);
      if (sameRow.length < 2) return null;
      const a = sameRow[0].getBoundingClientRect(), b = sameRow[1].getBoundingClientRect();
      return Math.round(b.left - a.right); })(),
  }))()`);

  console.log('UIFIX ' + JSON.stringify(R, null, 1));
  app.quit();
}

app.whenReady().then(run).catch((e) => { console.error('ERR', e && e.stack || e); app.quit(); });
