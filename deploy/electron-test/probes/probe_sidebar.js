/* 左侧来源栏探针（v1.17.0）
   ------------------------------------------------------------------
   来源从「顶栏横排 chip」搬进「左侧竖排列表」，并且可收起。
   这个探针只回答四个问题：
     1. 展开 / 收起时，侧栏宽度、网格位置、顶栏开关状态是否一致；
     2. 收起后顶栏是否补上「当前来源」的名字（否则不知道自己看的是哪个夹）；
     3. 底部浮层（状态栏 / 选择条）有没有跟着让位 —— 它们是 fixed，
        不主动让位就会盖住侧栏底部的「添加文件夹」，表现为"按钮点不动"；
     4. 空态页里侧栏该整个收掉，别在引导页旁边留一列空壳。
   用法: electron.exe probe_sidebar.js  (cwd = deploy/electron-test/probes) */
const { app, BrowserWindow, ipcMain, protocol } = require('electron');

require('./_desktop_stub').stubDesktop();
const path = require('path');
const fs = require('fs');

const APPDIR = path.resolve(__dirname, '..', '..', '..');
const OUT = path.resolve(__dirname, '..', 'shots');
const PICDIR = path.join(__dirname, '..', 'fixtures', '照片夹');

// 独立 userData：共用分区会被上一个套件留下的 sidebarOpen 影响（MEMORY §38）
app.setPath('userData', path.resolve(__dirname, '..', 'logs', 'ud_side_' + Date.now()));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

protocol.registerSchemesAsPrivileged([
  { scheme: 'vf', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
]);

/* 桌面集成桩之外的 IPC：侧栏本身不需要，但 App.init 会调 */
ipcMain.handle('vf:trashLog', () => []);
ipcMain.handle('vf:autoDir', () => null);
ipcMain.handle('vf:pickDirs', () => []);
ipcMain.handle('vf:pickFolder', () => null);
ipcMain.handle('vf:loadDir', () => ({ ok: false, files: [] }));
ipcMain.handle('vf:alwaysOnTop', (e, v) => !!v);
ipcMain.handle('vf:getAlwaysOnTop', () => false);
ipcMain.handle('vf:titleBarOverlay', () => true);
ipcMain.handle('vf:toggleMaximize', () => true);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.json': 'application/json' };

function collect(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const abs = path.join(dir, f);
    const st = fs.statSync(abs);
    if (st.isDirectory()) out.push(...collect(abs));
    else if (/\.(png|jpe?g)$/i.test(f)) out.push({ abs, size: st.size, mtime: st.mtimeMs });
  }
  return out;
}

async function run() {
  protocol.handle('vf', async (req) => {
    const u = new URL(req.url);
    // 图片走 base64url 绝对路径（fixtures 在项目外也能读）
    if (u.host === 'pic') {
      const abs = Buffer.from(decodeURIComponent(u.pathname).replace(/^\/+/, ''), 'base64url').toString('utf8');
      try {
        return new Response(await fs.promises.readFile(abs), { status: 200,
          headers: { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' } });
      } catch (e) { return new Response('404', { status: 404 }); }
    }
    if (u.host !== 'app') return new Response('unknown', { status: 404 });
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const abs = path.resolve(APPDIR, rel || 'index.html');
    if (!(abs === APPDIR || abs.startsWith(APPDIR + path.sep))) return new Response('forbidden', { status: 403 });
    try {
      return new Response(await fs.promises.readFile(abs), { status: 200,
        headers: { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' } });
    } catch (e) { return new Response('404', { status: 404 }); }
  });

  /* 窗口选项镜像生产（WCO）：侧栏的 top / height 依赖 --topbar-h + --cap-h，
     用默认标题栏测的话这条分支根本没被走到。 */
  const winOpts = {
    width: 1440, height: 900, show: true, backgroundColor: '#f5f5f7',
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

  const files = collect(PICDIR);
  await win.webContents.executeJavaScript(`(() => {
    const S = window.State, A = window.App;
    S.sources = [
      { id: 's0', name: 'Screenshots', root: 'C:/Users/me/Pictures/Screenshots' },
      { id: 's1', name: 'Downloads', root: 'C:/Users/me/Downloads' },
      { id: 's2', name: '手机备份 2026-08', root: 'C:/Users/me/Pictures/PhoneBackup' },
    ];
    S.items = ${JSON.stringify(files.map((f, i) => ({
      id: 'r' + i, name: path.basename(f.abs), src: 'all', sid: 's' + (i % 3),
      size: f.size, path: f.abs, ext: 'png', lastModified: f.mtime, state: 'idle',
    })))};
    S.sourceCount = (id) => id ? S.items.filter(x => x.sid === id).length : S.items.length;
    A.showGallery();
    A.renderSources();
    document.getElementById('topbar').hidden = false;
    return { n: S.items.length };
  })()`);
  await new Promise((r) => setTimeout(r, 2400));   // 等缩略图解码

  const js = (code) => win.webContents.executeJavaScript(code, true);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const R = {};

  /* ---------- 1. 展开态（默认） ---------- */
  R.open = await js(`(() => {
    const sb = document.getElementById('sidebar');
    const ws = document.getElementById('workspace');
    const tb = document.getElementById('topbar');
    const r = sb.getBoundingClientRect(), tr = tb.getBoundingClientRect();
    const tile = document.querySelector('.tile');
    const tgl = document.getElementById('sideToggle');
    const act = document.getElementById('sideActive');
    // 量一下 100vh 到底等于多少：WCO 下 vh 与 innerHeight 可能差几个像素
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:-9999px;top:0;height:100vh;width:1px';
    document.body.appendChild(probe);
    const vh100 = Math.round(probe.getBoundingClientRect().height);
    probe.remove();
    const root = getComputedStyle(document.documentElement);
    return {
      hidden: sb.hidden,
      x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height),
      top: Math.round(r.top), topbarBottom: Math.round(tr.bottom),
      fillH: Math.round(window.innerHeight - tr.bottom),
      innerH: window.innerHeight, docClientH: document.documentElement.clientHeight,
      docClientW: document.documentElement.clientWidth,
      vh100: vh100,
      topbarVar: root.getPropertyValue('--topbar-h').trim(),
      capVar: root.getPropertyValue('--cap-h').trim(),
      collapsed: ws.classList.contains('is-collapsed'),
      sideVar: getComputedStyle(ws).getPropertyValue('--side-w').trim(),
      rows: document.querySelectorAll('.src-chip').length,
      firstTileLeft: tile ? Math.round(tile.getBoundingClientRect().left) : null,
      toggleOn: tgl.classList.contains('is-on'),
      togglePressed: tgl.getAttribute('aria-pressed'),
      toggleTitle: tgl.title,
      activeLabelHidden: act.hidden,
      addText: (document.querySelector('.src-add-txt') || {}).textContent,
    };
  })()`);
  fs.writeFileSync(path.join(OUT, 'sidebar-open.png'), (await win.webContents.capturePage()).toPNG());

  /* ---------- 2. 点开关 → 收起 ---------- */
  await js(`(() => { document.getElementById('sideToggle').click(); return true; })()`);
  await sleep(520);
  R.closed = await js(`(() => {
    const sb = document.getElementById('sidebar');
    const ws = document.getElementById('workspace');
    const r = sb.getBoundingClientRect();
    const act = document.getElementById('sideActive');
    const tile = document.querySelector('.tile');
    const tgl = document.getElementById('sideToggle');
    let persisted = null;
    try { persisted = JSON.parse(localStorage.getItem('viewfinder.settings.v1') || '{}').sidebarOpen; } catch (e) {}
    return {
      w: Math.round(r.width),
      opacity: getComputedStyle(sb).opacity,
      borderW: getComputedStyle(sb).borderRightWidth,
      collapsed: ws.classList.contains('is-collapsed'),
      sideVar: getComputedStyle(ws).getPropertyValue('--side-w').trim(),
      setting: window.State.settings.sidebarOpen,
      persisted: persisted,
      toggleOn: tgl.classList.contains('is-on'),
      togglePressed: tgl.getAttribute('aria-pressed'),
      toggleTitle: tgl.title,
      activeLabelHidden: act.hidden,
      activeLabel: act.textContent,
      activeLabelVisibleW: Math.round(act.getBoundingClientRect().width),
      firstTileLeft: tile ? Math.round(tile.getBoundingClientRect().left) : null,
    };
  })()`);
  fs.writeFileSync(path.join(OUT, 'sidebar-closed.png'), (await win.webContents.capturePage()).toPNG());

  /* ---------- 3. 键盘：Ctrl+Shift+B 展开 / 在输入框里不该触发 ---------- */
  R.keys = await js(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const on = () => !!window.State.settings.sidebarOpen;
    // ⚠️ 必须是 shiftKey：Ctrl+B 是应用菜单里「模糊预览」的加速键，
    //    不带 shift 按下去会把隐私模式和侧栏一起改掉。
    const fire = (t) => t.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'B', ctrlKey: true, shiftKey: true, bubbles: true }));
    const out = { before: on() };
    fire(window); await sleep(420);
    out.afterKey = on();
    out.blurUntouched = !!window.State.settings.blurPreview === false;
    fire(window); await sleep(420);
    out.afterKey2 = on();
    const inp = document.getElementById('searchInput');
    inp.focus();
    fire(inp); await sleep(160);
    out.afterKeyInInput = on();
    out.focusKept = document.activeElement === inp;
    inp.blur();
    // 裸 Ctrl+B（不带 shift）必须是模糊预览，不该动侧栏
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }));
    await sleep(180);
    out.afterPlainCtrlB_sidebarOpen = on();
    inp.focus(); inp.blur();
    return out;
  })()`);

  /* ---------- 4. 底部浮层让位（fixed 元素不会自动避开侧栏） ---------- */
  R.overlayOpen = await js(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    // 上一步（键盘）结束时是**收起**态。这里先显式展开再量 —— 依赖
    // "上一步刚好留下什么状态" 是假失败的常见来源（MEMORY §38）。
    window.State.setSetting('sidebarOpen', true);
    window.App.applySidebarUI(true);
    await sleep(460);
    const vb = document.getElementById('viewbar'), sb = document.getElementById('selBar');
    vb.hidden = false; vb.classList.add('is-shown');
    sb.hidden = false;
    await sleep(340);
    const vr = vb.getBoundingClientRect(), sr = sb.getBoundingClientRect();
    const add = document.getElementById('btnAddFolder');
    const ar = add.getBoundingClientRect();
    const hit = document.elementFromPoint(ar.left + ar.width / 2, ar.top + ar.height / 2);
    // 50% 的参照是**初始包含块**（不含经典滚动条），不是 innerWidth
    const cw = document.documentElement.clientWidth;
    return {
      sidebarW: Math.round(document.getElementById('sidebar').getBoundingClientRect().width),
      viewbarLeft: Math.round(vr.left),
      viewbarRight: Math.round(vr.right),
      innerW: window.innerWidth,
      docClientW: cw,
      selbarCenter: Math.round(sr.left + sr.width / 2),
      expectSelbarCenter: Math.round((document.getElementById('sidebar').getBoundingClientRect().width + cw) / 2),
      addHit: !!(hit && (hit === add || add.contains(hit))),
      addRect: { l: Math.round(ar.left), t: Math.round(ar.top), w: Math.round(ar.width), h: Math.round(ar.height) },
    };
  })()`);

  await js(`(() => { document.getElementById('sideToggle').click(); return true; })()`);
  await sleep(560);
  R.overlayClosed = await js(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    await sleep(80);
    const vb = document.getElementById('viewbar'), sb = document.getElementById('selBar');
    const vr = vb.getBoundingClientRect(), sr = sb.getBoundingClientRect();
    const cw = document.documentElement.clientWidth;
    return {
      viewbarLeft: Math.round(vr.left),
      selbarCenter: Math.round(sr.left + sr.width / 2),
      expectSelbarCenter: Math.round(cw / 2),
    };
  })()`);

  // 收拾干净：浮层是探针手动点亮的，别让它留在截图里
  await js(`(() => { const vb = document.getElementById('viewbar'), sb = document.getElementById('selBar');
    vb.classList.remove('is-shown'); vb.hidden = true; sb.hidden = true; return true; })()`);

  /* ---------- 5. 空态：侧栏与开关一起收掉 ---------- */
  R.empty = await js(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    window.App.showEmpty();
    await sleep(140);
    return {
      sidebarHidden: document.getElementById('sidebar').hidden,
      sideHeadHidden: document.getElementById('sideHead').hidden,
      activeHidden: document.getElementById('sideActive').hidden,
    };
  })()`);

  await js(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    window.App.showGallery();
    window.State.setSetting('sidebarOpen', true);
    window.App.applySidebarUI(true);
    await sleep(500);
    return true;
  })()`);

  /* ---------- 6. 深色主题下的侧栏（材质与发丝线在深色里最容易糊掉） ---------- */
  R.dark = await js(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    window.App.applySetting('theme', 'dark');
    await sleep(360);
    const sb = document.getElementById('sidebar');
    const cs = getComputedStyle(sb);
    const chip = document.querySelector('.src-chip.is-on');
    const cc = chip ? getComputedStyle(chip) : null;
    return {
      theme: document.body.dataset.theme,
      bg: cs.backgroundColor,
      border: cs.borderRightColor,
      titleColor: getComputedStyle(document.querySelector('.sb-title')).color,
      chipOnBg: cc ? cc.backgroundColor : null,
      chipOnColor: cc ? cc.color : null,
    };
  })()`);
  fs.writeFileSync(path.join(OUT, 'sidebar-dark.png'), (await win.webContents.capturePage()).toPNG());

  await js(`(async () => { window.App.applySetting('theme', 'light'); return true; })()`);
  await sleep(300);

  /* ---------- 7. 窄窗：侧栏不吃光内容区 ---------- */
  win.setContentSize(1024, 760);
  await sleep(600);
  R.narrow = await js(`(() => {
    const sb = document.getElementById('sidebar').getBoundingClientRect();
    const main = document.getElementById('main').getBoundingClientRect();
    const ctrls = document.querySelector('.ctrls');
    const cw = document.documentElement.clientWidth;
    return {
      sideW: Math.round(sb.width),
      mainW: Math.round(main.width),
      mainLeft: Math.round(main.left),
      docClientW: cw,
      sumOk: Math.round(sb.width + main.width) === cw,
      ctrlsOverflow: ctrls.scrollWidth > ctrls.clientWidth + 1,
    };
  })()`);
  fs.writeFileSync(path.join(OUT, 'sidebar-narrow.png'), (await win.webContents.capturePage()).toPNG());

  /* ---------- 7b. 窄到阈值以下：侧栏自动让位（但不改用户设置） ----------
     截图里的 1024 是"刚好还放得下"；这里量的是"放不下"那一侧。
     注意断言的**不是**"窄窗一定收起"：而是
       ① 用户设置不变（那写坏了，回到宽窗就得手动再点一次）
       ② 菜单勾选态跟着实际状态走
       ③ 手动展开有临时出口，退出窄窗自动恢复 */
  win.setContentSize(880, 760);
  await sleep(700);
  R.narrowAuto = await js(`(() => {
    const s = (o) => Object.assign(o, {
      collapsed: document.getElementById('workspace').classList.contains('is-collapsed'),
      setting: window.State.settings.sidebarOpen,
      menuSide: window.App.menuState().side,
      openNow: window.App.sidebarOpenNow(),
      sideW: Math.round(document.getElementById('sidebar').getBoundingClientRect().width),
      activeVisible: !document.getElementById('sideActive').hidden,
      toggleOn: document.getElementById('sideToggle').classList.contains('is-on'),
    });
    return s({ inner: window.innerWidth });
  })()`);
  await js(`(() => { window.App.toggleSidebar(true); return true; })()`);
  await sleep(450);
  R.narrowAuto.opened = await js(`(() => ({
    collapsed: document.getElementById('workspace').classList.contains('is-collapsed'),
    setting: window.State.settings.sidebarOpen,
    sideW: Math.round(document.getElementById('sidebar').getBoundingClientRect().width),
    openNow: window.App.sidebarOpenNow(),
  }))()`);
  win.setContentSize(1024, 760);
  await sleep(700);
  R.narrowAuto.backWide = await js(`(() => ({
    collapsed: document.getElementById('workspace').classList.contains('is-collapsed'),
    setting: window.State.settings.sidebarOpen,
    openNow: window.App.sidebarOpenNow(),
    forcedFlag: window.App._sideForced,
  }))()`);
  win.setContentSize(880, 760);
  await sleep(700);
  R.narrowAuto.narrowAgain = await js(`(() => ({
    collapsed: document.getElementById('workspace').classList.contains('is-collapsed'),
    setting: window.State.settings.sidebarOpen,
    openNow: window.App.sidebarOpenNow(),
  }))()`);

  console.log('SIDE ' + JSON.stringify(R));
  app.quit();
}

app.whenReady().then(run).catch((e) => { console.error('ERR', e && e.stack || e); app.quit(); });
