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

  /* 等所有缩略图真的解码完再截。
     原来只 sleep(1500)，截出来常有几块空白 —— 缩略图是 createImageBitmap 异步解码的，
     跟入场动画（.tile 的 tile-in，340ms）不是同一条时间线，固定等待不可靠。
     判据用 img.complete && naturalWidth>0，最多等 12s。 */
  let loaded = 0;
  for (let i = 0; i < 60; i++) {
    const st = await w.webContents.executeJavaScript(`(() => {
      const im = [...document.querySelectorAll('.tile img')];
      return { total: im.length, done: im.filter(function (x) { return x.complete && x.naturalWidth > 0; }).length };
    })()`);
    loaded = st.done;
    if (st.total >= 24 && st.done === st.total) break;
    await sleep(200);
  }
  console.log('THUMBS ' + loaded + '/' + n);

  /* 关掉过渡动画：只影响"多久到位"，不影响最终外观，截图因此可复现。
     顺手把滚动条拉回顶部，免得截到半行瓦片。 */
  await w.webContents.executeJavaScript(`(() => {
    document.body.dataset.anim = '0';
    const sc = document.querySelector('.stage') || document.scrollingElement;
    if (sc) sc.scrollTop = 0;
    return true;
  })()`);
  await sleep(600);

  fs.writeFileSync(path.join(OUT, 'grid.png'), (await w.webContents.capturePage()).toPNG());
  console.log('SAVED grid.png');

  /* 打开灯箱（点第一张瓦片） */
  const clicked = await w.webContents.executeJavaScript(
    "(()=>{const t=document.querySelector('.tile');if(!t)return false;t.dispatchEvent(new MouseEvent('click',{bubbles:true}));return true})()");
  await sleep(2200);
  const lbOpen = await w.webContents.executeJavaScript("!document.getElementById('lightbox').hasAttribute('hidden')");
  console.log('CLICKED ' + clicked + '  LIGHTBOX_OPEN ' + lbOpen);
  /* 把鼠标移到下缘热区，让操作栏显形 —— 否则沉浸态下 HUD 是 opacity:0，
     截出来只有一张图，看不出这版重做过的底部图标。合成的 mousemove 必须打在
     #lightbox 上（监听挂在 Lightbox.el），打在 document 上不会冒泡过去。 */
  await w.webContents.executeJavaScript(`(() => {
    const lb = document.getElementById('lightbox');
    lb.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: Math.round(innerWidth / 2), clientY: innerHeight - 30 }));
    return true;
  })()`);
  await sleep(400);
  fs.writeFileSync(path.join(OUT, 'lightbox.png'), (await w.webContents.capturePage()).toPNG());
  console.log('SAVED lightbox.png');

  app.quit();
});
