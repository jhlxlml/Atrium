/* ============================================================
   Atrium · probe_desktop.js —— 桌面集成的**真实 Electron** 验证
   ------------------------------------------------------------
   为什么不能只靠 test/desktop.test.js：
   那套只能证明"模板数据写对了"。而这一层的风险恰恰在于
   **数据对、但 Electron 没接受**：
     · 加速键字符串拼错 → Electron 不抛错，只是注册不上；
     · 用命令 id 当菜单项 id → 重名会直接抛（真跑一次才知道）；
     · 托盘图标路径错 → 打包后 Tray 建不起来，但代码看着完全正常；
     · 全局快捷键被别的程序占用 → register 返回 false，不试一次不知道；
     · setThumbarButtons 收的 nativeImage 是不是合法位图。
   所以这里**真的建菜单、真的建托盘、真的注册快捷键**，再回头问
   Electron「open-folder 那一项的加速键到底是什么」。

   输出一行：DESKTOP { ... }
   ============================================================ */
'use strict';
const { app, BrowserWindow, Menu, nativeImage, globalShortcut } = require('electron');
const path = require('path');

const HERE = __dirname;
// probes/ → electron-test/ → deploy/ → 项目根，所以是三层
const ROOT = path.resolve(HERE, '..', '..', '..');
const spec = require(path.join(ROOT, 'deploy', 'electron', 'desktop-spec.js'));
const { createDesktop, toTemplate } = require(path.join(ROOT, 'deploy', 'electron', 'desktop.js'));

/* 隔离：不要污染真实应用的 userData / 任务栏身份 */
app.setPath('userData', path.resolve(HERE, '..', 'logs', 'ud_desktop_' + Date.now()));
app.commandLine.appendSwitch('no-sandbox');
// 用一个**测试专用**的 AppUserModelID：用产品那个会把真实应用的 JumpList 覆盖掉
app.setAppUserModelId('com.atrium.probe');

const R = {
  platform: process.platform,
  isWin: process.platform === 'win32',
  problems: [],
};

function step(name, fn) {
  try {
    const v = fn();
    R[name] = v;
  } catch (e) {
    R[name] = { error: String((e && e.message) || e) };
    R.problems.push(name + ': ' + String((e && e.message) || e));
  }
}

/* 看门狗：任何一步把异步链挂住（比如 loadURL 失败导致后面的 app.quit() 永远不执行），
   进程会一直活着、上层只看到"超时"，完全看不出卡在哪。这里到点强制输出并退出。 */
let finished = false;
function bail(why) {
  if (finished) return;
  finished = true;
  R.problems.push('看门狗：' + why);
  R.ok = false;
  console.log('DESKTOP ' + JSON.stringify(R, null, 1));
  app.exit(1);
}
const watchdog = setTimeout(() => bail('25 秒内没有跑完'), 25000);
watchdog.unref && watchdog.unref();

app.whenReady().then(async () => {
  try {
    await main();
  } catch (e) {
    R.problems.push('main: ' + String((e && e.stack) || e));
  }
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  R.ok = R.problems.length === 0;
  console.log('DESKTOP ' + JSON.stringify(R, null, 1));
  app.exit(R.ok ? 0 : 1);
});

async function main() {
  /* ---------- 1. 右键菜单模板：能被 Electron 接受 ---------- */
  step('ctxMenuBuild', () => {
    const nodes = spec.contextMenuSpec('grid', { selCount: 2, fav: true, rot: 90, hasPath: true });
    const menu = Menu.buildFromTemplate(toTemplate(nodes, () => {}));
    return {
      count: menu.items.length,
      labels: menu.items.filter((i) => i.label).map((i) => i.label),
      firstIsSeparator: menu.items[0].type === 'separator',
    };
  });

  /* ---------- 2. 缩略图按钮图标：ASCII 点阵 → nativeImage ---------- */
  step('glyph', () => {
    const out = {};
    for (const t of spec.THUMBAR) {
      const img = nativeImage.createFromBitmap(spec.glyphToBGRA(t.rows), { width: 16, height: 16 });
      const sz = img.getSize();
      out[t.key] = {
        w: sz.width, h: sz.height,
        empty: img.isEmpty(),
        pngBytes: img.isEmpty() ? 0 : img.toPNG().length,
      };
    }
    return out;
  });

  /* ---------- 3. 一个真窗口 + 桌面集成实例 ---------- */
  const win = new BrowserWindow({
    width: 900, height: 640, show: false,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      // 装真 preload：第 12 步要从页面里调 window.vfNative，验证 IPC 归属校验
      preload: path.join(ROOT, 'deploy', 'electron', 'preload.js'),
    },
  });
  await win.loadURL('about:blank');

  const desktop = createDesktop({
    getMainWin: () => win,
    getFrameWin: () => null,
    send: () => {},
    isQuitting: () => false,
    setQuitting: () => {},
    log: () => {},
  });

  /* ---------- 4. 应用菜单：走产品自己的装配路径，再回头问 Electron ----------
     关键是**问 Electron**，而不是断言"模板里写了什么"：
     模板写对了但 Electron 没注册上（加速键拼错就是这样）时，
     只有问 getMenuItemById 才看得出来。 */
  step('appMenu', () => {
    const pushed = desktop.setMenuState({
      mode: 'masonry', blur: true, favOnly: true, pin: true, hasItems: true, hasSel: true,
    });
    desktop.installAppMenu();
    const menu = Menu.getApplicationMenu();
    const q = (id) => {
      const it = menu.getMenuItemById(id);
      return it ? { label: it.label, accel: it.accelerator, enabled: it.enabled, checked: it.checked, type: it.type } : null;
    };
    return {
      statePushed: pushed,
      topLevel: menu ? menu.items.map((i) => i.label) : [],
      openFolder: q('open-folder'),
      exportSel: q('export-selected'),
      modeMasonry: q('mode:masonry'),
      modeSmall: q('mode:small'),
      favOnly: q('fav-only'),
      blur: q('blur-toggle'),
      pin: q('pin-toggle'),
      frame: q('frame-toggle'),
      selectAll: q('select-all-tiles'),
      shortcuts: q('shortcuts'),
      about: q('about'),
    };
  });

  /* ---------- 5. 托盘：真的建一次、真的隐藏/显示窗口，再拆掉 ---------- */
  const trayInfo = { alive: false, trayAlive: false, afterHide: null, afterShow: null, aliveAfterDestroy: null };
  try {
    trayInfo.alive = desktop.setupTray(true);
    trayInfo.trayAlive = desktop.trayAlive();
    // 刚建出来的窗口要等一会儿才真的能显示（show:false 起步 + 窗口管理器是异步的），
    // 这一步等不够会得到"显示失败"的假警报。
    await new Promise((r) => setTimeout(r, 1200));
    desktop.showMainWindow();
    await new Promise((r) => setTimeout(r, 800));
    trayInfo.afterShow = win.isVisible();
    desktop.hideMainWindow();
    await new Promise((r) => setTimeout(r, 800));
    trayInfo.afterHide = win.isVisible();
    desktop.showMainWindow();
    await new Promise((r) => setTimeout(r, 800));
    trayInfo.backAgain = win.isVisible();
    desktop.setupTray(false);
    trayInfo.aliveAfterDestroy = desktop.trayAlive();
  } catch (e) {
    R.problems.push('trayCreate: ' + String((e && e.message) || e));
  }
  R.trayCreate = trayInfo;

  /* ---------- 6. 缩略图按钮（Windows 任务栏） ---------- */
  step('thumbar', () => {
    const ok = desktop.applyThumbar(win);
    const cleared = desktop.clearThumbar(win);
    return { set: ok, cleared: cleared };
  });

  /* ---------- 7. 任务栏进度条 ---------- */
  step('progress', () => {
    const a = desktop.setProgress(win, 0.5, 'normal');
    const b = desktop.setProgress(win, 0, 'indeterminate');
    const c = desktop.setProgress(win, -1, 'none');
    return { normal: a, indeterminate: b, cleared: c };
  });

  /* ---------- 8. 全局快捷键：真的注册一次 ---------- */
  step('hotkey', () => {
    const r = desktop.setGlobalHotkey('Ctrl+Alt+A');
    const registered = globalShortcut.isRegistered('Ctrl+Alt+A');
    desktop.disposeGlobalHotkey();
    const afterDispose = globalShortcut.isRegistered('Ctrl+Alt+A');
    // 反向用例：拼错的加速键必须被自己的校验挡下，而不是静默"成功"
    const bad = desktop.setGlobalHotkey('Ctrl+QQQ');
    desktop.disposeGlobalHotkey();
    return { register: r, isRegistered: registered, afterDispose: afterDispose, badAccel: bad };
  });

  /* ---------- 9. JumpList ---------- */
  step('jumpList', () => {
    const r = desktop.applyJumpList();
    return { ok: r.ok, why: r.why || '', result: r.result ? String(r.result) : null };
  });

  /* ---------- 10. 菜单勾选态真的会跟着状态变 ---------- */
  step('menuState', () => {
    const menu = Menu.getApplicationMenu();
    const before = menu.getMenuItemById('mode:medium');
    const changed = desktop.setMenuState({ mode: 'medium', blur: false, favOnly: false, pin: false, hasItems: false, hasSel: false });
    const after = Menu.getApplicationMenu().getMenuItemById('mode:medium');
    const masonry = Menu.getApplicationMenu().getMenuItemById('mode:masonry');
    const exp = Menu.getApplicationMenu().getMenuItemById('export-selected');
    const fav = Menu.getApplicationMenu().getMenuItemById('fav-only');
    const sameAgain = desktop.setMenuState({ mode: 'medium', blur: false, favOnly: false, pin: false, hasItems: false, hasSel: false });
    return {
      changed: changed,
      // 之前是 masonry，现在应该轮到 medium
      mediumBefore: before ? before.checked : null,
      mediumAfter: after ? after.checked : null,
      masonryAfter: masonry ? masonry.checked : null,
      favOnlyAfter: fav ? fav.checked : null,
      exportDisabledWhenNoSel: exp ? exp.enabled === false : null,
      // 内容没变时不该重建（否则菜单会白闪一下）
      noopWhenUnchanged: sameAgain === false,
    };
  });

  /* ---------- 11. 右键菜单真的弹出、并能在无人操作时被关掉 ---------- */
  try {
    const p = desktop.popupContextMenu(
      spec.contextMenuSpec('lightbox', { fav: false, rot: 0, fs: false, hasPath: true }), win);
    await new Promise((r) => setTimeout(r, 700));
    const closed = desktop.closeOpenMenu(win);
    const got = await Promise.race([p, new Promise((r) => setTimeout(() => r('TIMEOUT'), 3000))]);
    R.ctxPopup = { popped: true, closedByApi: closed, resolved: got !== 'TIMEOUT', value: got };
    if (got === 'TIMEOUT') R.problems.push('ctxPopup: 菜单关掉后 3 秒内仍没拿到 Promise 结果');
    if (got !== null && got !== 'TIMEOUT') R.problems.push('ctxPopup: 没点任何一项，却拿到了 ' + JSON.stringify(got));
  } catch (e) {
    R.ctxPopup = { error: String((e && e.message) || e) };
    R.problems.push('ctxPopup: ' + String((e && e.message) || e));
  }

  /* ---------- 12. IPC 归属校验：非受信 sender 必须被拒 ----------
     这 7 条通道原先完全不看 `e`（全仓 `.sender` 只出现 2 次，都是功能性用法）。
     这里建**第二个窗口**，故意不交给 createDesktop 的 ctx —— 从它调同样的 7 条
     通道，全部必须返回 null（被 guard 挡在 handler **之前**）；再从受信窗口调一次
     只读通道，证明 guard 没有误伤正常调用方。

     为什么值得单独测：归属校验最容易写成"看着有、其实没接上"——
     要么漏包一条，要么 trustedIds() 恒为空（把自家调用也一起拒了，症状是
     "功能全哑"但代码看着完全正常）。这正是本项目栽过五次的同一类病。 */
  R.ipcGuard = { untrusted: {}, trusted: {} };
  try {
    const evil = new BrowserWindow({
      width: 400, height: 300, show: false,
      webPreferences: {
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        preload: path.join(ROOT, 'deploy', 'electron', 'preload.js'),
      },
    });
    await evil.loadURL('about:blank');
    desktop.wireIpc();   // 装真 handler（探针此前只直接调函数，没走过 IPC 这条路）

    const callIn = (w, expr) => w.webContents.executeJavaScript(expr);
    const CH = {
      menuState: 'window.vfNative.setMenuState({mode:"small"})',
      contextMenu: 'window.vfNative.contextMenu({kind:"grid",info:{}})',
      showInFolder: 'window.vfNative.showInFolder("C:/nope/x.jpg")',
      setProgress: 'window.vfNative.setProgress(0.5,"normal")',
      setTray: 'window.vfNative.setTray({on:false,closeOn:false})',
      setHotkey: 'window.vfNative.setHotkey("")',
      desktopInfo: 'window.vfNative.desktopInfo()',
    };
    for (const k of Object.keys(CH)) R.ipcGuard.untrusted[k] = await callIn(evil, CH[k]);
    // 受信侧只调只读 / 无副作用的通道，别在这里建托盘或注册全局快捷键
    R.ipcGuard.trusted.desktopInfo = await callIn(win, 'window.vfNative.desktopInfo()');
    R.ipcGuard.trusted.menuState = await callIn(win, 'window.vfNative.setMenuState({mode:"medium"})');
    R.ipcGuard.trusted.trayAfter = desktop.trayAlive();

    const leaked = Object.keys(CH).filter((k) => R.ipcGuard.untrusted[k] !== null);
    R.ipcGuard.rejectedAll = leaked.length === 0;
    R.ipcGuard.channelCount = Object.keys(CH).length;
    if (leaked.length) {
      R.problems.push('ipcGuard: 非受信 sender 竟然拿到了结果：' + leaked.join(','));
    }
    if (!R.ipcGuard.trusted.desktopInfo
      || R.ipcGuard.trusted.desktopInfo.platform !== process.platform) {
      R.problems.push('ipcGuard: 受信窗口的正常调用被误拒 → '
        + JSON.stringify(R.ipcGuard.trusted.desktopInfo));
    }
    if (R.ipcGuard.trusted.trayAfter) {
      R.problems.push('ipcGuard: 非受信调用竟然真的把托盘建起来了');
    }
    try { evil.destroy(); } catch (e) { /* 忽略 */ }
  } catch (e) {
    R.problems.push('ipcGuard: ' + String((e && e.message) || e));
  }

  try { win.destroy(); } catch (e) { /* 忽略 */ }
}
