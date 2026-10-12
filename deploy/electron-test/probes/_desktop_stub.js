/* ============================================================
   Atrium · 桌面集成 IPC 桩（探针专用，不是产品代码）
   ------------------------------------------------------------
   为什么需要它：

   探针是个**假宿主** —— 真正实现这 7 条通道的 `deploy/electron/desktop.js`
   不在探针进程里跑。而 `App.init()` 启动时会重放三个桌面集成设置
   （`trayOn` / `trayClose` / `hotkeyOn`）。没有 handler 时：

       ipcRenderer.invoke  →  reject("No handler registered")
         → Native.* 自己的 .catch 吞掉 → 返回 false
           → applySetting 判定"没生效" → 回滚开关 + 一条 urgent 播报

   后果不只是"设置没生效"，有两处会真咬人：

   1) **A11y 播报区会被改成 `role=alert` / `aria-live=assertive`，而且留在那儿**
      （`A11y.live()` 按 urgency 改档，改完不复位）。于是 `probe_a11y` 启动后
      读到的"常驻播报区静态语义"就变成 alert/assertive，那条断言恒红 ——
      2026-10-12 加桌面集成时就是这么踩到的，排查方向还一度被误判成
      "result.txt 被截断"。
   2) 任何以"设置已生效"为前提准备状态的探针，都会读到**假的关闭状态**，
      测的就不再是产品。

   返回值的形状必须与 `desktop.js` 的真实现一致 —— 桩也要"像真的"，
   否则断言测的是桩。各通道真实现的返回值：
       vf:menuState    → boolean（是否重建了菜单）
       vf:contextMenu  → string | null（被点中的命令 id）
       vf:showInFolder → boolean
       vf:setProgress  → boolean
       vf:setTray      → boolean（托盘是否真的活着）
       vf:setHotkey    → { ok, registered, accel, why? }
       vf:desktopInfo  → object
   ============================================================ */
'use strict';

const { ipcMain } = require('electron');

let done = false;

/** 幂等：重复调用只生效一次（ipcMain.handle 对同一通道注册两次会抛错） */
function stubDesktop() {
  if (done) return;
  done = true;
  ipcMain.handle('vf:menuState', () => true);
  ipcMain.handle('vf:contextMenu', () => null);
  ipcMain.handle('vf:showInFolder', () => true);
  ipcMain.handle('vf:setProgress', () => true);
  ipcMain.handle('vf:setTray', () => true);
  ipcMain.handle('vf:setHotkey', (e, accel) => ({
    ok: true, registered: !!accel, accel: accel || '', why: '',
  }));
  ipcMain.handle('vf:desktopInfo', () => ({ stub: true, menu: true, tray: true, hotkey: true }));
}

module.exports = { stubDesktop };
