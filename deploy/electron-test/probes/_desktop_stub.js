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

/* ------------------------------------------------------------
   窗口级通道（窗口置顶 / 屏幕清单）—— 与上面 7 条桌面通道**分开**提供
   ------------------------------------------------------------
   为什么不做进 stubDesktop()：有 3 个探针**自己实现了这两条**（要数调用次数
   或控制返回值：probe_settings / probe_topbar / probe_drop），无条件注册会撞
   `ipcMain.handle` 的重复注册。所以做成 opt-in，谁缺谁调。

   为什么需要：`App.init()` 启动时会拉一次「窗口置顶」与「屏幕清单」。
   缺 handler 时 invoke reject → 被 Native 的 .catch 吞成 false/[] →
   上层判"没生效"。v1.13.0 起 native.js 给这类失败留一条 console.warn，
   于是"探针是不完整宿主"会以**页面报错**的形式浮出来
   （probe_masonry 的「探针过程中无页面报错」断言就是这么变红的）。
   补上桩之后，探针才真的是"像产品的宿主"，测的才是产品。 */
let winStubbed = false;
function stubWindowChannels() {
  if (winStubbed) return;
  winStubbed = true;
  let aot = false;
  ipcMain.handle('vf:alwaysOnTop', (e, v) => { aot = !!v; return aot; });
  ipcMain.handle('vf:getAlwaysOnTop', () => aot);
  /* 返回 1 块屏（真实桌面就是这样）。1 块屏时设置面板不会出现「输出屏幕」那一行
     （它要求 >1 块屏），所以对现有断言是行为中性的。 */
  ipcMain.handle('vf:listDisplays', () => [
    { id: 1, label: '主屏', primary: true, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
  ]);
}

module.exports = { stubDesktop, stubWindowChannels };
