/* ============================================================
   Atrium · desktop.js —— 桌面集成的 Electron 胶水层
   ------------------------------------------------------------
   把 desktop-spec.js 的纯数据模板变成真的原生对象，并统一管理：
     · 应用菜单（Menu.setApplicationMenu）—— 含 Ctrl+O 打开文件夹
     · 原生右键菜单（menu.popup，Promise 化）
     · 系统托盘（Tray）+ 关闭窗口时最小化到托盘
     · Windows 任务栏：JumpList / 缩略图按钮 / 进度条
     · 全局快捷键（globalShortcut，默认关闭，注册失败要如实上报）
   所有"能力有没有生效"都返回真实结果（注册失败返回 false、
   托盘建不起来返回 null），绝不静默假装成功 —— 本项目对
   "点了没反应"这类问题一贯零容忍。

   依赖注入：createDesktop(ctx) 收一组访问器，方便主进程在
   窗口尚未创建时也能先装配好菜单与托盘。
   ============================================================ */
'use strict';
const path = require('path');
const fs = require('fs');
const spec = require('./desktop-spec.js');

const isWin = process.platform === 'win32';

/**
 * 图标路径。
 * 打包后 assemble.js 会把 brand/icon.ico 复制到 resources/app/icon.ico，
 * 也就是 __dirname 下；但**从源码树直接跑**（回归探针）时那里是空的 ——
 * 此时退回 brand/icon.ico。不做这个回退的话，探针里的托盘永远建不起来，
 * 而"探针里建不起来"和"产品里建不起来"看起来一模一样，等于白测。
 */
function resolveIconPath() {
  const packaged = path.join(__dirname, 'icon.ico');
  if (fs.existsSync(packaged)) return packaged;
  const source = path.resolve(__dirname, '..', '..', 'brand', 'icon.ico');
  if (fs.existsSync(source)) return source;
  return packaged;
}

/* ------------------------------------------------------------
   纯数据模板 → Electron 模板
   ------------------------------------------------------------ */
function toTemplate(nodes, onPick) {
  const out = [];
  for (const n of (nodes || [])) {
    if (!n || typeof n !== 'object') continue;
    if (n.type === 'separator') { out.push({ type: 'separator' }); continue; }
    const item = {};
    // role 与 label 同时给：role 决定行为，label 决定中文文案
    if (n.role) item.role = n.role;
    if (n.label) item.label = n.label;
    if (n.accel) item.accelerator = n.accel;
    if (n.type) item.type = n.type;          // 'checkbox' | 'radio'
    if (typeof n.checked === 'boolean') item.checked = n.checked;
    if (typeof n.enabled === 'boolean') item.enabled = n.enabled;
    if (n.submenu) item.submenu = toTemplate(n.submenu, onPick);
    else if (n.cmd) {
      // 用命令 id 当菜单项 id：菜单项与"谁来处理它"从此有一根可查的线。
      // 回归探针据此直接问 Electron「open-folder 那一项的加速键到底是什么」，
      // 而不是断言"模板里写了什么"（那只能证明数据对，证明不了真的注册上）。
      item.id = n.cmd;
      item.click = () => onPick(n.cmd);
    }
    out.push(item);
  }
  return out;
}

/* ------------------------------------------------------------
   工厂
   ------------------------------------------------------------ */
/**
 * @param {object} ctx
 *   getMainWin()      → BrowserWindow | null
 *   getFrameWin()     → BrowserWindow | null
 *   send(cmd)         → 把命令投给主窗口渲染层
 *   isQuitting()      → 是否正在退出（退出过程中关闭窗口不应被拦）
 *   log(msg)          → 诊断输出
 */
function createDesktop(ctx) {
  const { Menu, Tray, nativeImage, shell, ipcMain } = require('electron');
  const app = require('electron').app;

  const D = {
    menu: null,
    tray: null,
    /* 「关闭窗口时最小化到托盘」。主进程读不到渲染层的 localStorage，
       只能由渲染层把设置推过来 —— 推过来之前按 false 处理（= 关闭即退出），
       宁可保守也不要出现"想退出却退不掉"。 */
    trayCloseOn: false,
    hotkeyAccel: '',
    hotkeyOk: null,
    /* 菜单勾选态。渲染层通过 vf:menuState 推过来，主进程只读它建菜单。 */
    state: {
      mode: 'medium', blur: false, favOnly: false, pin: false, frame: false,
      hasItems: false, hasSel: false,
    },
  };

  const log = ctx.log || function () {};
  const iconPath = resolveIconPath();

  /* ---------- 命令出口 ----------
     托盘那几条由主进程自己处理（托盘不属于任何窗口）；其余一律
     投给主窗口渲染层，由 App.COMMANDS 执行。 */
  function onPick(cmd) {
    if (!cmd) return;
    if (cmd === 'tray:quit') { ctx.setQuitting(true); app.quit(); return; }
    if (cmd === 'tray:toggle-window') { toggleWindow(); return; }
    ctx.send(cmd);
  }

  /* ============================================================
     应用菜单
     ============================================================ */
  function installAppMenu() {
    try {
      D.menu = Menu.buildFromTemplate(toTemplate(spec.appMenuSpec(D.state), onPick));
      Menu.setApplicationMenu(D.menu);
      return true;
    } catch (e) {
      // 菜单建不起来不该让应用起不来，但必须留下痕迹（否则就是静默无菜单）
      log('[desktop] 应用菜单构建失败：' + ((e && e.message) || e));
      D.menu = null;
      try { Menu.setApplicationMenu(null); } catch (e2) { /* 忽略 */ }
      return false;
    }
  }

  /** 渲染层推来勾选态 → 重建菜单（菜单很小，重建比逐项改更不容易漏） */
  function setMenuState(st) {
    if (!st || typeof st !== 'object') return false;
    let changed = false;
    for (const k of Object.keys(D.state)) {
      if (!(k in st)) continue;
      const v = typeof D.state[k] === 'boolean' ? !!st[k] : st[k];
      if (D.state[k] !== v) { D.state[k] = v; changed = true; }
    }
    if (!changed) return false;
    installAppMenu();
    return true;
  }

  /* ============================================================
     原生右键菜单
     ------------------------------------------------------------
     Promise 化：菜单关闭时 resolve(null)，点中某项时 resolve(该项 cmd)。
     渲染层拿到 cmd 自己去执行 —— 不再多发一条事件，避免"两处都执行"
     或者"两处都没执行"这类谁也说不清的问题。
     ============================================================ */
  function popupContextMenu(nodes, win) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        D.openMenu = null;
        resolve(v);
      };
      let menu;
      try {
        menu = Menu.buildFromTemplate(toTemplate(nodes, (cmd) => finish(cmd)));
      } catch (e) {
        log('[desktop] 右键菜单构建失败：' + ((e && e.message) || e));
        finish(null);
        return;
      }
      // 记下"当前挂着的那份菜单"。诊断用（能回答"是不是有菜单没关掉"），
      // 也让回归能在无人操作的情况下把它关掉 —— 否则 popup 的 Promise
      // 永远等不到关闭回调，那条用例只能删掉。
      D.openMenu = menu;
      try {
        menu.popup({ window: win || undefined, callback: () => finish(null) });
      } catch (e) {
        log('[desktop] 右键菜单弹出失败：' + ((e && e.message) || e));
        finish(null);
      }
    });
  }

  /** 关掉当前挂着的右键菜单（诊断 / 回归用）。返回是否真的有菜单被关掉。 */
  function closeOpenMenu(win) {
    if (!D.openMenu) return false;
    try { D.openMenu.closePopup(win || ctx.getMainWin() || undefined); } catch (e) { /* 忽略 */ }
    D.openMenu = null;
    return true;
  }

  /* ============================================================
     系统托盘
     ============================================================ */
  function trayAlive() { return !!(D.tray && !D.tray.isDestroyed()); }

  function buildTrayMenu() {
    const w = ctx.getMainWin();
    const visible = !!(w && !w.isDestroyed() && w.isVisible());
    return Menu.buildFromTemplate(toTemplate(spec.trayMenuSpec({ visible }), onPick));
  }

  /** 主窗口显隐变化后刷新托盘菜单文案（"显示/隐藏主窗口"是同一个位置） */
  function syncTrayMenu() {
    if (!trayAlive()) return false;
    try { D.tray.setContextMenu(buildTrayMenu()); return true; }
    catch (e) { log('[desktop] 托盘菜单刷新失败：' + ((e && e.message) || e)); return false; }
  }

  function showMainWindow() {
    const w = ctx.getMainWin();
    if (!w || w.isDestroyed()) return false;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
    syncTrayMenu();
    return true;
  }

  function hideMainWindow() {
    const w = ctx.getMainWin();
    if (!w || w.isDestroyed()) return false;
    w.hide();
    syncTrayMenu();
    return true;
  }

  function toggleWindow() {
    const w = ctx.getMainWin();
    if (!w || w.isDestroyed()) return false;
    if (w.isVisible() && !w.isMinimized()) return hideMainWindow();
    return showMainWindow();
  }

  /** 建/拆托盘。on = true 建，false 拆。返回托盘是否存活 */
  function setupTray(on) {
    if (!on) {
      if (trayAlive()) { try { D.tray.destroy(); } catch (e) { /* 忽略 */ } }
      D.tray = null;
      return false;
    }
    if (trayAlive()) { syncTrayMenu(); return true; }
    try {
      if (!require('fs').existsSync(iconPath)) throw new Error('缺少图标 ' + iconPath);
      D.tray = new Tray(iconPath);
      D.tray.setToolTip('Atrium · 本地照片浏览器');
      D.tray.setContextMenu(buildTrayMenu());
      // 双击托盘图标 = 显示/隐藏主窗口（Windows 上的惯例）
      D.tray.on('double-click', () => toggleWindow());
      // 单击也切一次：Windows 11 上双击经常被系统吞掉，单击更可靠
      D.tray.on('click', () => toggleWindow());
      return true;
    } catch (e) {
      log('[desktop] 托盘创建失败：' + ((e && e.message) || e));
      D.tray = null;
      return false;
    }
  }

  /**
   * 关闭窗口时是否应该"藏进托盘"而不是退出。
   * 三个条件缺一不可：用户开了"关闭时最小化到托盘"、托盘真的活着、
   * 且不是我们自己在退出（app.quit() 触发的 close 必须放行，否则退不掉）。
   */
  function wantHideOnClose() {
    return !!(D.trayCloseOn && trayAlive() && !ctx.isQuitting());
  }

  /** 渲染层推来的托盘设置（开关 + 关闭行为），返回托盘是否真的建起来了 */
  function setTrayState(st) {
    const s = st || {};
    if ('closeOn' in s) D.trayCloseOn = !!s.closeOn;
    if ('on' in s) return setupTray(!!s.on);
    return trayAlive();
  }

  /* ============================================================
     Windows 任务栏
     ============================================================ */

  /**
   * JumpList：右键任务栏图标时出现的「任务」。
   * 用 process.execPath + 参数启动**第二个进程**，靠单实例锁把它转成
   * 第一个进程的 second-instance 事件（见 main.js）——这是 Electron 里
   * 让 JumpList 任务生效的标准做法，也是唯一不依赖额外安装器的做法。
   * 便携包被移动位置后这些任务的路径会失效，属已知限制。
   */
  function applyJumpList() {
    if (!isWin) return { ok: false, why: 'not-windows' };
    try {
      const exe = process.execPath;
      const r = app.setJumpList([
        {
          type: 'tasks',
          items: [
            {
              type: 'task', title: '打开文件夹…', description: '选择一个文件夹并载入',
              program: exe, args: '--open-dialog', iconPath: iconPath, iconIndex: 0,
            },
            {
              type: 'task', title: '打开回收站', description: '查看最近删除的图片',
              program: exe, args: '--open-trash', iconPath: iconPath, iconIndex: 0,
            },
          ],
        },
      ]);
      return { ok: true, result: r || null };
    } catch (e) {
      // 某些环境（未固定到任务栏 / 便携路径）会拒绝，属可接受降级，
      // 但必须留下日志而不是假装成功。
      log('[desktop] JumpList 设置失败：' + ((e && e.message) || e));
      return { ok: false, why: String((e && e.message) || e) };
    }
  }

  /** 缩略图按钮：鼠标悬停任务栏图标时出现的三颗按钮 */
  function applyThumbar(win) {
    if (!isWin || !win || win.isDestroyed()) return false;
    try {
      const buttons = spec.THUMBAR.map((t) => {
        const img = nativeImage.createFromBitmap(spec.glyphToBGRA(t.rows), { width: 16, height: 16 });
        return { tooltip: t.tooltip, icon: img, click: () => onPick(t.cmd) };
      });
      return win.setThumbarButtons(buttons);
    } catch (e) {
      log('[desktop] 缩略图按钮设置失败：' + ((e && e.message) || e));
      return false;
    }
  }

  function clearThumbar(win) {
    if (!isWin || !win || win.isDestroyed()) return false;
    try { return win.setThumbarButtons([]); } catch (e) { return false; }
  }

  /**
   * 任务栏进度条。
   *   value ∈ [0,1] 显示进度；value < 0 或 mode='none' 收起；
   *   mode='indeterminate' 显示"不确定进度"的滚动条（总数未知时用）。
   * 索引大目录时它是唯一"在任务栏就能看见"的反馈。
   */
  function setProgress(win, value, mode) {
    if (!win || win.isDestroyed()) return false;
    try {
      const v = Number(value);
      const m = mode || 'normal';
      if (m === 'none' || !isFinite(v) || v < 0) { win.setProgressBar(-1); return true; }
      if (m === 'indeterminate') { win.setProgressBar(2, { mode: 'indeterminate' }); return true; }
      win.setProgressBar(Math.min(1, Math.max(0, v)), { mode: m });
      return true;
    } catch (e) { return false; }
  }

  /* ============================================================
     全局快捷键
     ------------------------------------------------------------
     注册失败（被别的程序占用）**必须如实返回 false** —— 否则用户会以为
     自己开的开关生效了，实际上按下去毫无反应。
     ============================================================ */
  function setGlobalHotkey(accel) {
    const { globalShortcut } = require('electron');
    try {
      globalShortcut.unregisterAll();
    } catch (e) { /* 忽略 */ }
    D.hotkeyAccel = '';
    D.hotkeyOk = null;
    if (!accel) return { ok: true, accel: '', registered: false };
    const chk = spec.checkAccel(accel);
    if (!chk.ok) return { ok: false, why: chk.why, accel: accel };
    let got = false;
    try {
      got = globalShortcut.register(accel, () => { showMainWindow(); });
    } catch (e) {
      return { ok: false, why: String((e && e.message) || e), accel: accel };
    }
    D.hotkeyAccel = accel;
    D.hotkeyOk = got;
    return { ok: true, accel: accel, registered: got };
  }

  function disposeGlobalHotkey() {
    try { require('electron').globalShortcut.unregisterAll(); } catch (e) { /* 忽略 */ }
    D.hotkeyAccel = '';
    D.hotkeyOk = null;
  }

  /* ============================================================
     IPC（与 preload 白名单一一对应）
     ============================================================ */

  /* 归属校验（纵深防御）。
     这 7 条通道原先**完全不看 `e`**（全仓 `.sender` 只出现 2 次，且都是功能性
     用法：main.js 的 winOf(e) 与 alwaysOnTop 用它定位"发起调用的窗口"）。
     在当前安全基线（contextIsolation + nodeIntegration:false + sandbox + 只加载
     vf:// 本地内容 + setWindowOpenHandler 拒绝新窗口 + will-navigate 拦外部导航）下，
     渲染进程里跑的就是自家代码，**这不构成现实漏洞**；它是 Electron 官方安全检查表
     推荐的纵深防御 —— 万一将来某处引入了一条能加载外部内容的路径，这里是最后一道闸。
     成本是一个包装函数，收益是"未来免疫"。
     被拒时返回 null（不是抛错）：这些通道的返回值形状本来就是"值或空"，
     返回 null 与"查询没结果"同形，调用方的既有降级路径照常工作。 */
  function trustedIds() {
    return [ctx.getMainWin && ctx.getMainWin(), ctx.getFrameWin && ctx.getFrameWin()]
      .filter((w) => w && !w.isDestroyed())
      .map((w) => w.webContents.id);
  }
  function guard(fn) {
    return (e, ...args) => {
      const id = e && e.sender && e.sender.id;
      if (trustedIds().indexOf(id) < 0) {
        console.warn('[ipc] 拒绝来自非受信 sender 的调用：sender=' + id);
        return null;
      }
      return fn(...args);
    };
  }

  function wireIpc() {
    ipcMain.handle('vf:menuState', guard((st) => setMenuState(st)));

    ipcMain.handle('vf:contextMenu', guard((payload) => {
      const p = payload || {};
      const kind = p.kind === 'lightbox' ? 'lightbox' : 'grid';
      const nodes = spec.contextMenuSpec(kind, p.info || {});
      const win = ctx.getFrameWin && ctx.getFrameWin() && kind === 'lightbox'
        ? ctx.getFrameWin() : ctx.getMainWin();
      return popupContextMenu(nodes, win || ctx.getMainWin());
    }));

    ipcMain.handle('vf:showInFolder', guard((p) => {
      if (!p || typeof p !== 'string') return false;
      try { shell.showItemInFolder(p); return true; }
      catch (err) { return false; }
    }));

    ipcMain.handle('vf:setProgress', guard((value, mode) => setProgress(ctx.getMainWin(), value, mode)));

    ipcMain.handle('vf:setTray', guard((st) => setTrayState(st)));
    ipcMain.handle('vf:setHotkey', guard((accel) => setGlobalHotkey(accel || '')));
    ipcMain.handle('vf:desktopInfo', guard(() => ({
      platform: process.platform,
      tray: trayAlive(),
      trayCloseOn: D.trayCloseOn,
      hotkey: { accel: D.hotkeyAccel, registered: D.hotkeyOk },
      menu: !!D.menu,
    })));
  }

  return {
    installAppMenu, setMenuState, popupContextMenu, closeOpenMenu,
    setupTray, setTrayState, syncTrayMenu, trayAlive, wantHideOnClose,
    showMainWindow, hideMainWindow, toggleWindow,
    applyJumpList, applyThumbar, clearThumbar, setProgress,
    setGlobalHotkey, disposeGlobalHotkey,
    wireIpc,
    state: D.state,
  };
}

module.exports = { createDesktop, toTemplate };
