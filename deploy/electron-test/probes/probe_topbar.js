/* 顶栏视觉探针：在真实 Electron 里加载应用 → 注入假来源 → 截图顶栏。
   用法: electron.exe probe_topbar.js  (cwd = deploy/electron) */
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');

/* 桌面集成通道桩：缺了它 App.init() 的托盘/快捷键设置重放会"假失败" —— 详见 _desktop_stub.js */
require('./_desktop_stub').stubDesktop();
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const APPDIR = path.resolve(__dirname, '..', '..', '..');           // 项目根（内含 index.html / js / css）
const OUT = path.resolve(__dirname, '..', 'shots');

// 探针环境常无 GPU，禁用硬件加速避免渲染进程被拖垮导致 ERR_FAILED
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

protocol.registerSchemesAsPrivileged([
  { scheme: 'vf', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
]);

ipcMain.handle('vf:trashLog', () => []);
ipcMain.handle('vf:autoDir', () => null);
ipcMain.handle('vf:pickDirs', () => []);
ipcMain.handle('vf:restoreFile', () => true);
ipcMain.handle('vf:restoreFiles', () => true);
ipcMain.handle('vf:trashForget', () => true);
ipcMain.handle('vf:trashClear', () => true);
ipcMain.handle('vf:pickFolder', () => null);
ipcMain.handle('vf:loadDir', () => ({ ok: false, files: [] }));

/* 窗口置顶：记录渲染进程是否真的调到了原生桥（而不是按钮只是"看起来能点"） */
let LAST_AOT = null, AOT_CALLS = 0;
ipcMain.handle('vf:alwaysOnTop', (e, v) => { AOT_CALLS++; LAST_AOT = !!v; return LAST_AOT; });
ipcMain.handle('vf:getAlwaysOnTop', () => !!LAST_AOT);

/* 标题栏浮层（WCO）：记录渲染进程推过来的配色 —— 深色主题下必须推深色，
   否则症状是"切到深色主题后右上角还是浅色标题栏"，界面看着像坏了但没人报错。
   双击标题栏的最大化桥同理：调没调到要能被看见。 */
const CAP_SYNC = [];
let MAX_CALLS = 0;
ipcMain.handle('vf:titleBarOverlay', (e, opt) => { CAP_SYNC.push(opt || {}); return true; });
ipcMain.handle('vf:toggleMaximize', () => { MAX_CALLS++; return true; });

async function run() {
  protocol.handle('vf', async (req) => {
    console.log('VFHIT ' + req.url);
    const u = new URL(req.url);
    if (u.host !== 'app') return new Response('unknown', { status: 404 });
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const abs = path.resolve(APPDIR, rel || 'index.html');
    if (!(abs === APPDIR || abs.startsWith(APPDIR + path.sep))) return new Response('forbidden', { status: 403 });
    let buf;
    try { buf = await fs.promises.readFile(abs); } catch (e) { console.log('VFREADERR ' + e.message); return new Response('404', { status: 404 }); }
    const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
      '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png',
      '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.json':'application/json' };
    const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    console.log('VFRET ' + abs + ' ' + buf.length + ' ' + type);
    return new Response(buf, { status: 200, headers: { 'content-type': type } });
  });

  /* 窗口选项**镜像生产**（main.js 的 WCO 分支）：探针要测的是用户看到的东西，
     这里若还用默认原生标题栏，"置顶按钮在窗口标题栏里"这条在探针里根本不会出现 ——
     那就成了"测了个生产上不存在的布局"。 */
  const winOpts = {
    width: 1500, height: 900, show: true,
    webPreferences: { preload: path.join(__dirname, '..', '..', 'electron', 'preload.js'), contextIsolation: true },
  };
  if (process.platform === 'win32') {
    winOpts.titleBarStyle = 'hidden';
    winOpts.titleBarOverlay = { color: '#f7f5f1', symbolColor: '#3a372f', height: 34 };
  }
  const win = new BrowserWindow(winOpts);
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('PAGE-ERR ' + msg); });

  await win.loadURL('vf://app/index.html');
  await new Promise((r) => setTimeout(r, 900));

  const info = await win.webContents.executeJavaScript(`(() => {
    const S = window.State, A = window.App;
    S.sources = [
      { id: 's0', name: 'Screenshots', root: 'C:/Users/me/Pictures/Screenshots' },
      { id: 's1', name: 'Camera Roll', root: 'C:/Users/me/Pictures/CameraRoll' },
      { id: 's2', name: '手机备份 2026-08', root: 'C:/Users/me/Pictures/PhoneBackup' },
    ];
    S.items = [];
    for (let i = 0; i < 29; i++) {
      S.items.push({ id: 'a' + i, name: 'IMG_' + i + '.jpg', src: 'all',
        size: 204800 + i, path: 'C:/x/IMG_' + i + '.jpg', ext: 'jpg' });
    }
    S.sourceCount = (id) => id === 'all' ? S.items.length : (id === 's0' ? 29 : id === 's1' ? 14 : 7);
    A.showGallery ? A.showGallery() : A.applyView(true);
    A.renderSources && A.renderSources();
    document.getElementById('topbar').hidden = false;
    return { sources: S.sources.length, items: S.items.length };
  })()`);
  console.log('INJECT ' + JSON.stringify(info));
  await new Promise((r) => setTimeout(r, 800));

  const shot = await win.webContents.capturePage({ x: 0, y: 0, width: 1500, height: 130 });
  fs.writeFileSync(path.join(OUT, 'topbar-after.png'), shot.toPNG());

  // 眼睛按钮：点击应切换隐私模糊，且不误触「最近删除」面板
  const eyeTest = await win.webContents.executeJavaScript(`(() => {
    const before = !!window.State.settings.blurPreview;
    const btn = document.getElementById('brandEye');
    btn.click();
    const after = !!window.State.settings.blurPreview;
    const panel = document.getElementById('trashPanel');
    const blurred = document.body.classList.contains('privacy-blur');
    btn.click();  // 还原
    return { before, after, panelOpened: !panel.hidden, blurred, restored: !!window.State.settings.blurPreview };
  })()`);
  console.log('EYE ' + JSON.stringify(eyeTest));

  /* 窗口置顶按钮：可见（桌面版）→ 点击后应真的调到原生桥，且状态/图标/aria 同步 */
  const pinTest = await win.webContents.executeJavaScript(`(async () => {
    const btn = document.getElementById('pinBtn');
    const out = { exists: !!btn };
    if (!btn) return out;
    out.visible = !btn.hidden;
    out.canPin = !!(window.Native && window.Native.canPin);
    out.label = btn.getAttribute('aria-label');
    out.beforePressed = btn.getAttribute('aria-pressed');
    out.beforeIcon = btn.querySelector('use') ? btn.querySelector('use').getAttribute('href') : null;
    btn.click();
    await new Promise(r => setTimeout(r, 300));
    out.afterPressed = btn.getAttribute('aria-pressed');
    out.afterIcon = btn.querySelector('use') ? btn.querySelector('use').getAttribute('href') : null;
    out.settingOn = !!window.State.settings.alwaysOnTop;
    out.isOnClass = btn.classList.contains('is-on');
    out.title = btn.title;
    return out;
  })()`);
  pinTest.ipcCalls = AOT_CALLS;
  pinTest.ipcLast = LAST_AOT;
  console.log('PIN ' + JSON.stringify(pinTest));

  // 趁置顶处于「开」的状态截一张标题栏的图（视觉留档：置顶按钮与原生按钮的相对位置）
  await new Promise((r) => setTimeout(r, 320));
  const shotPin = await win.webContents.capturePage({ x: 0, y: 0, width: 1500, height: 40 });
  fs.writeFileSync(path.join(OUT, 'topbar-pin.png'), shotPin.toPNG());

  /* 再点一次：应取消置顶并回到未选中态 */
  const pinRestore = await win.webContents.executeJavaScript(`(async () => {
    const btn = document.getElementById('pinBtn');
    btn.click();
    await new Promise(r => setTimeout(r, 300));
    return {
      pressed: btn.getAttribute('aria-pressed'),
      icon: btn.querySelector('use') ? btn.querySelector('use').getAttribute('href') : null,
      setting: !!window.State.settings.alwaysOnTop,
      isOnClass: btn.classList.contains('is-on'),
      title: btn.title,
    };
  })()`);
  pinRestore.ipcCalls = AOT_CALLS;
  pinRestore.ipcLast = LAST_AOT;
  console.log('PIN2 ' + JSON.stringify(pinRestore));

  /* 窗口标题栏（v1.15.0，Windows WCO）：置顶按钮应落在「最小化」**左边** ——
     这是它唯一合理的邻居（它不是浏览动作，是窗口动作）。
     断言不写死像素：原生按钮占的区域由 getTitlebarAreaRect() 给出（随 DPI 变），
     所以判据是「置顶按钮的右缘 ≤ 可绘区右缘」，而不是「right === 144px」。 */
  const capTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const out = { wco: typeof navigator.windowControlsOverlay !== 'undefined' };
    const bar = document.getElementById('capbar');
    const btn = document.getElementById('pinBtn');
    out.barVisible = !!bar && !bar.hidden;
    out.bodyClass = document.body.classList.contains('has-wco');
    out.pinInBar = !!(bar && btn && bar.contains(btn));
    if (btn && out.wco) {
      const r = btn.getBoundingClientRect();
      const a = navigator.windowControlsOverlay.getTitlebarAreaRect();
      out.pinRect = { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), h: Math.round(r.height) };
      out.areaRect = { x: Math.round(a.x), w: Math.round(a.width), r: Math.round(a.right), h: Math.round(a.height) };
      out.innerW = window.innerWidth;
      out.reserved = window.innerWidth - Math.round(a.right);   // 原生按钮占的宽度
      // ① 右缘在可绘区之内 = 在原生最小化/最大化/关闭的左边
      out.pinLeftOfNative = r.right <= a.right - 2;
      // ② 没被浮层吞掉：命中测试拿到的必须是它自己（"看得见但点不动"最难查）
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      out.pinHit = !!(hit && (hit === btn || btn.contains(hit)));
      // ③ 标题栏空白处命中 .capbar 本身 → 那一段是拖拽区（能拖窗口）
      const h2 = document.elementFromPoint(30, r.top + r.height / 2);
      out.barHit = !!(h2 && h2.closest && h2.closest('.capbar'));
      // ④ 双击标题栏（非按钮目标）→ 应调到原生最大化桥
      bar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await sleep(80);
      // ⑤ 双击按钮本身**不应**触发最大化（否则点置顶会顺手把窗口最大化）
      const before = 0;
      btn.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await sleep(80);
      out.dblOnBtn = true;
    }
    // ⑥ 主题切换 → 应把浮层配色推给主进程；两个方向都走一遍，不依赖系统当前是哪种
    const t0 = document.body.dataset.theme;
    window.App.applySetting('theme', 'dark');
    await sleep(140);
    window.App.applySetting('theme', 'light');
    await sleep(140);
    window.App.applySetting('theme', t0 || 'light');
    await sleep(140);
    out.expectedNow = getComputedStyle(document.body).getPropertyValue('--paper').trim();
    // ⑦ 标题栏把页面整体压下 34px：顶栏吸顶位置要跟着让位（否则顶栏钻到标题栏底下）
    out.capH = Math.round(bar.getBoundingClientRect().height);
    out.topbarTop = Math.round(document.getElementById('topbar').getBoundingClientRect().top);
    // ⑧ 窗口内打开灯箱：应从标题栏**下方**铺开（标题栏不被吞掉，置顶按钮仍可点）。
    //    ⚠️ 这里**不**测图片居中：下面是条假路径、图片根本加载不出来，量出来的偏移
    //    只是"破图"的产物（曾得到 lbDy=-370.7 这种吓人的数，却毫无意义）。
    //    灯箱在 WCO 下的居中由 center 套件在**真图**上严格验证
    //    （probe_center.js 的窗口选项已镜像生产的 WCO 配置）。
    try {
      const L = window.Lightbox;
      if (L && L.open && bar) {
        const m = { id: 'a0', name: 'IMG_0.jpg', src: 'all', size: 204800, path: 'C:/x/IMG_0.jpg', ext: 'jpg' };
        L.open([m], m);
        await sleep(180);
        const lr = document.querySelector('.lightbox').getBoundingClientRect();
        out.lbTop = Math.round(lr.top);
        out.lbBottom = Math.round(lr.bottom);
        out.lbWinH = window.innerHeight;
        L.close();
        await sleep(140);
      }
    } catch (e) { out.lbErr = String((e && e.message) || e); }
    return out;
  })()`);
  capTest.capSync = CAP_SYNC.slice(-5);
  capTest.maxCalls = MAX_CALLS;
  console.log('CAP ' + JSON.stringify(capTest));

  // 窄窗口：胶囊仍应齐平同高，且控件不换行
  await win.setContentSize(1100, 800);
  await new Promise((r) => setTimeout(r, 500));
  const narrow = await win.webContents.executeJavaScript(`(() => {
    const b = document.querySelector('.srcbar').getBoundingClientRect();
    const c = document.querySelector('.ctrls').getBoundingClientRect();
    return { srcbarH: Math.round(b.height), ctrlsH: Math.round(c.height),
             sameRow: Math.abs(b.y - c.y) < 3, noWrap: c.y === b.y,
             srcbarW: Math.round(b.width), ctrlsW: Math.round(c.width) };
  })()`);
  console.log('NARROW ' + JSON.stringify(narrow));
  const shot2 = await win.webContents.capturePage({ x: 0, y: 0, width: 1100, height: 130 });
  fs.writeFileSync(path.join(OUT, 'topbar-narrow.png'), shot2.toPNG());

  /* 「相框图标可见」这条要先**显式写入目标值**再测量：探针共用持久分区，
     上一个套件（设置面板）跑完之后 showFrame 可能是 false —— 依赖"环境刚好是
     默认值"会假失败（MEMORY.md §38）。默认值本身由 defaults() 单独断言。
     单独一步 + 单独 try/catch：把它混进下面的 GEO 脚本里的话，一旦这一步抛错
     整个脚本都会失败，连 GEO 都拿不到，外部只看到"未解析到 GEO 输出"，很难查。
     错误写进 window.__frameUiErr 一并带回来。 */
  await win.webContents.executeJavaScript(`(() => {
    window.__frameUiErr = null;
    try {
      window.State.setSetting('showFrame', true);
      if (!window.State.settings.showFrame) throw new Error('setSetting 之后仍为 false');
      if (window.App && typeof window.App.applyFrameUI === 'function') window.App.applyFrameUI();
      const b = document.getElementById('frameBtn');
      if (!b) throw new Error('找不到 #frameBtn');
      if (b.hidden) throw new Error('applyFrameUI 之后图标仍 hidden');
    } catch (e) { window.__frameUiErr = String((e && e.message) || e); }
    return true;
  })()`, true);

  /* 「相框图标可见」这条要先**显式写入目标值**再测量：探针共用持久分区，
     上一个套件（设置面板）跑完之后 showFrame 可能是 false —— 依赖"环境刚好是
     默认值"会假失败（MEMORY.md §38）。默认值本身由 defaults（getter）单独断言。
     单独一步 + 单独 try/catch：混进下面的 GEO 脚本里的话，这一步一旦抛错
     整个脚本都会失败、连 GEO 都拿不到，外部只看到"未解析到 GEO 输出"，很难查。
     注意 `State.defaults` 是 **getter（返回对象）**，写成 `defaults()` 会抛错。 */
  await win.webContents.executeJavaScript(`(() => {
    window.__frameUiErr = null;
    try {
      window.State.setSetting('showFrame', true);
      if (!window.State.settings.showFrame) throw new Error('setSetting 之后仍为 false');
      if (window.App && typeof window.App.applyFrameUI === 'function') window.App.applyFrameUI();
      const b = document.getElementById('frameBtn');
      if (!b) throw new Error('找不到 #frameBtn');
      if (b.hidden) throw new Error('applyFrameUI 之后图标仍 hidden');
    } catch (e) { window.__frameUiErr = String((e && e.message) || e); }
    return true;
  })()`, true);

  const geo = await win.webContents.executeJavaScript(`(() => {
    const g = (sel) => { const e = document.querySelector(sel); if (!e) return null;
      const r = e.getBoundingClientRect(), c = getComputedStyle(e);
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
               bg: c.backgroundColor, radius: c.borderRadius, border: c.borderTopColor, pad: c.padding }; };
    const c = document.querySelector('.ctrls');
    const kids = c ? [...c.children] : [];
    const ti = kids.findIndex(k => k.classList.contains('trash-wrap'));
    const ei = kids.findIndex(k => k.id === 'brandEye');
    const si = kids.findIndex(k => k.id === 'setBtn');
    const pi = kids.findIndex(k => k.id === 'pinBtn');
    return {
      frameUiErr: window.__frameUiErr || null,
      frameDefaultOn: !!(window.State.defaults && window.State.defaults.showFrame === true),
      srcbar: g('.srcbar'), srcScroll: g('.src-scroll'), srcList: g('.src-list'),
      spacer: g('.spacer'), ctrls: g('.ctrls'), firstChip: g('.src-chip'), addBtn: g('.src-add'),
      innerW: window.innerWidth,
      listW: getComputedStyle(document.querySelector('.src-list')).width,
      listCSS: getComputedStyle(document.querySelector('.src-list')).cssText ? 'y' : 'n',
      scrollW: getComputedStyle(document.querySelector('.src-scroll')).width,
      listScrollW: document.querySelector('.src-list').scrollWidth,
      sheetCount: document.styleSheets.length,
      hasFitRule: [...document.styleSheets].some(ss => { try {
        return [...ss.cssRules].some(r => r.cssText && r.cssText.includes('width: fit-content')); } catch(e){ return false; } }),
      brandTextPresent: !!document.querySelector('.brand-name, .brand-en'),
      eyeInCtrls: ei >= 0, eyeAfterTrash: ei === ti + 1, trashIdx: ti, eyeIdx: ei,
      // 置顶按钮：位于控件簇内，且是控件簇的最后一个（最靠近系统窗口按钮）
      pinInCtrls: pi >= 0, pinAfterSet: pi === si + 1, pinIsLast: pi === kids.length - 1,
      setIdx: si, pinIdx: pi, ctrlCount: kids.length,
      // 窗口标题栏（v1.15.0，WCO）：有 WCO 时置顶按钮**不在**控件簇里，而在标题栏里
      wcoPresent: typeof navigator.windowControlsOverlay !== 'undefined',
      hasWcoClass: document.body.classList.contains('has-wco'),
      capbarHidden: (() => { const b = document.getElementById('capbar'); return !!b && b.hidden; })(),
      pinParentId: (() => { const b = document.getElementById('pinBtn');
        return (b && b.parentElement) ? (b.parentElement.id || b.parentElement.className || '') : null; })(),
      // 相框（v1.11.0 起为**正式功能**）：默认就是可见的；且无论显隐都**仍在 .ctrls 里**
      // （用 hidden 属性而不是摘节点，否则 ctrlCount / pinIsLast / pinIdx 都会跟着变）
      frameVisible: (() => { const b = document.getElementById('frameBtn'); return !!b && b.hidden === false; })(),
      frameIdx: kids.findIndex(k => k.id === 'frameBtn'),
      trashPanelParent: document.getElementById('trashPanel') ? document.getElementById('trashPanel').parentElement.tagName : null,
      topbarLeftChildren: [...document.querySelector('.topbar-in').children].map(k => k.className || k.id),
    };
  })()`);
  fs.writeFileSync(path.join(OUT, 'topbar-geo.json'), JSON.stringify(geo, null, 2));
  console.log('GEO ' + JSON.stringify(geo));
  app.quit();
}

app.whenReady().then(run).catch((e) => { console.error('ERR', e && e.stack || e); app.quit(); });
