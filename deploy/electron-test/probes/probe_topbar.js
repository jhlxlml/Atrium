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

  const win = new BrowserWindow({
    width: 1500, height: 900, show: true,
    webPreferences: { preload: path.join(__dirname, '..', '..', 'electron', 'preload.js'), contextIsolation: true },
  });
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

  // 趁置顶处于「开」的状态截一张右侧控件区的图（视觉留档）
  await new Promise((r) => setTimeout(r, 320));
  const shotPin = await win.webContents.capturePage({ x: 1030, y: 0, width: 470, height: 62 });
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
