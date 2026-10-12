/* ============================================================
   Atrium · README 截图生成器（手工工具，不属于回归套件）
   ------------------------------------------------------------
   与 manual_appself.js 同类：需要人来看结果，所以不注册成套件。
   用 index.html?demo=1 合成 24 张样张，走完整图库流程后截图。

   输出：docs/images/grid.png（网格）
        docs/images/lightbox.png（灯箱）

   用法：node deploy/electron-test/run_probe.js make_screenshots.js
   （必须经 run_probe.js 启动 —— 它会剥掉 ELECTRON_RUN_AS_NODE / NODE_OPTIONS，
     否则 electron.exe 会退化成纯 Node 进程、窗口根本不出来。）
   ============================================================ */
'use strict';
const { app, BrowserWindow, protocol, ipcMain, screen } = require('electron');
/* 与探针同款宿主：缺桩会让 App.init() 的启动重放"假失败"，并在控制台留下假报错 */
require('./probes/_desktop_stub').stubDesktop();
require('./probes/_desktop_stub').stubWindowChannels();
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'docs', 'images');
fs.mkdirSync(OUT, { recursive: true });

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
protocol.registerSchemesAsPrivileged([{ scheme: 'vf', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }]);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

/* 静音原生通道（截图不需要真实回收站 / 目录选择） */
for (const ch of ['vf:trashLog', 'vf:autoDir', 'vf:pickDirs', 'vf:restoreFile', 'vf:restoreFiles', 'vf:trashForget', 'vf:trashClear', 'vf:pickFolder']) {
  ipcMain.handle(ch, () => ((ch === 'vf:trashLog' || ch === 'vf:pickDirs') ? [] : null));
}
ipcMain.handle('vf:loadDir', () => ({ ok: false, files: [] }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  protocol.handle('vf', async (req) => {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const abs = path.resolve(ROOT, rel || 'index.html');
    try {
      const b = await fs.promises.readFile(abs);
      return new Response(b, { headers: { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' } });
    } catch (e) { return new Response('404', { status: 404 }); }
  });

  /* 窗口不能超出工作区，否则会被系统裁掉、截图缺边 */
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const W = Math.min(1560, wa.width - 16);
  const H = Math.min(950, wa.height - 32);
  console.log('SCREEN ' + wa.width + 'x' + wa.height + '  WINDOW ' + W + 'x' + H);

  const w = new BrowserWindow({
    width: W, height: H, show: true, backgroundColor: '#1b1a17',
    webPreferences: { preload: path.join(ROOT, 'deploy', 'electron', 'preload.js'), contextIsolation: true },
  });
  w.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('PAGE-ERR ' + msg); });
  await w.loadURL('vf://app/index.html?demo=1');

  /* 等样张合成（_demoLoad 在 load 后 80ms 触发）与网格渲染 */
  let n = 0;
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    n = await w.webContents.executeJavaScript("document.querySelectorAll('.tile').length");
    if (n >= 24) break;
  }
  console.log('TILES ' + n);
  if (n < 24) { console.log('样张没出全，截图可能不完整'); }
  await sleep(1500);   // 等缩略图解码 + 入场动画结束

  fs.writeFileSync(path.join(OUT, 'grid.png'), (await w.webContents.capturePage()).toPNG());
  console.log('SAVED grid.png');

  /* 打开灯箱（点第一张瓦片） */
  const clicked = await w.webContents.executeJavaScript(
    "(()=>{const t=document.querySelector('.tile');if(!t)return false;t.dispatchEvent(new MouseEvent('click',{bubbles:true}));return true})()");
  await sleep(2200);
  const lbOpen = await w.webContents.executeJavaScript("!document.getElementById('lightbox').hasAttribute('hidden')");
  console.log('CLICKED ' + clicked + '  LIGHTBOX_OPEN ' + lbOpen);
  fs.writeFileSync(path.join(OUT, 'lightbox.png'), (await w.webContents.capturePage()).toPNG());
  console.log('SAVED lightbox.png');

  app.quit();
});
