/* 全屏最大化验证：图片长边是否贴到屏幕边缘 */
const { app, BrowserWindow, protocol } = require('electron');

/* 桌面集成通道桩：缺了它 App.init() 的托盘/快捷键设置重放会"假失败" —— 详见 _desktop_stub.js */
require('./_desktop_stub').stubDesktop();
const path = require('path'); const fs = require('fs');
const OUT = path.resolve(__dirname, '..', 'shots');
/* 从「打包后的 Electron 应用」的 app 目录静态服务（原先读离线单文件，该产物已退役）。 */
const APPDIR = path.resolve(__dirname, '..', '..', 'dist-electron', 'Atrium_Electron版', 'resources', 'app');
const PICDIR = path.join(__dirname, '..', 'fixtures', '照片夹');

app.setPath('userData', path.resolve(__dirname, '..', 'logs', 'ud_fs_' + Date.now()));
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
protocol.registerSchemesAsPrivileged([{ scheme: 'vf', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true } }]);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' };
function collect(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const abs = path.join(dir, f); const st = fs.statSync(abs);
    if (st.isDirectory()) out.push(...collect(abs));
    else if (/\.(png|jpe?g|gif|webp)$/i.test(f)) out.push({ abs, size: st.size, mtime: st.mtimeMs });
  }
  return out;
}

async function enterFs(w) {
  for (let i = 0; i < 12; i++) {
    const on = await w.webContents.executeJavaScript(`window.Lightbox.isFs()`);
    if (on) return true;
    await w.webContents.executeJavaScript(`(() => {
      if (document.fullscreenElement) { document.exitFullscreen(); return 'exit'; }
      const b = document.getElementById('lbFs'); if (b) b.click(); else window.Lightbox.toggleFs();
      return 'enter';
    })()`);
    await new Promise((r) => setTimeout(r, 700));
  }
  return await w.webContents.executeJavaScript(`window.Lightbox.isFs()`);
}
async function exitFs(w) {
  for (let i = 0; i < 12; i++) {
    const on = await w.webContents.executeJavaScript(`window.Lightbox.isFs()`);
    if (!on) return true;
    await w.webContents.executeJavaScript(`document.exitFullscreen()`);
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

const MEASURE = `(() => {
  const L = window.Lightbox, im = document.getElementById('lbImg');
  const base = im.offsetWidth, bh = im.offsetHeight;
  const M = new DOMMatrix(getComputedStyle(im).transform);
  const pts = [[0,0],[base,0],[base,bh],[0,bh]].map(([x,y]) => ({ x: M.a*x + M.c*y + M.e, y: M.b*x + M.d*y + M.f }));
  const xs = pts.map(p=>p.x), ys = pts.map(p=>p.y);
  const box = { l: Math.min(...xs), t: Math.min(...ys), r: Math.max(...xs), b: Math.max(...ys) };
  const w = box.r - box.l, h = box.b - box.t;
  return { fs: L.isFs(), rot: L.rot, scale: +L.scale.toFixed(4),
     imgW: +w.toFixed(1), imgH: +h.toFixed(1),
     vw: window.innerWidth, vh: window.innerHeight,
     gap: { left: +box.l.toFixed(1), top: +box.t.toFixed(1), right: +(window.innerWidth - box.r).toFixed(1), bottom: +(window.innerHeight - box.b).toFixed(1) },
     ctr: { dx: +((box.l+box.r)/2 - window.innerWidth/2).toFixed(2), dy: +((box.t+box.b)/2 - window.innerHeight/2).toFixed(2) },
     fillRatio: { w: +(w/window.innerWidth).toFixed(4), h: +(h/window.innerHeight).toFixed(4) } };
})()`;

app.whenReady().then(async () => {
  protocol.handle('vf', async (req) => {
    const u = new URL(req.url);
    if (u.host === 'pic') {
      const abs = Buffer.from(decodeURIComponent(u.pathname).replace(/^\/+/, ''), 'base64url').toString('utf8');
      try { const b = await fs.promises.readFile(abs); return new Response(b, { headers: { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'access-control-allow-origin': 'vf://app' } }); }
      catch (e) { return new Response('404', { status: 404 }); }
    }
    // app 资源：从打包后的 app 目录静态服务（index.html + css/* + js/*）
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    const abs = path.resolve(APPDIR, rel);
    if (abs !== APPDIR && !abs.startsWith(APPDIR + path.sep)) return new Response('403', { status: 403 });
    try { const b = await fs.promises.readFile(abs); return new Response(b, { headers: { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'access-control-allow-origin': 'vf://app' } }); }
    catch (e) { return new Response('404', { status: 404 }); }
  });

  const w = new BrowserWindow({ width: 1440, height: 900, show: true,
    webPreferences: { preload: path.resolve(__dirname, '..', '..', 'electron', 'preload.js'), contextIsolation: true } });
  await w.loadURL('vf://app/index.html');
  await new Promise((r) => setTimeout(r, 900));

  const files = collect(PICDIR);
  await w.webContents.executeJavaScript(`(() => {
    const S = window.State, A = window.App;
    S.sources = [{ id: 's0', name: '照片夹', root: 'C:/x' }];
    S.items = ${JSON.stringify(files.map((f, i) => ({ id: 'r' + i, name: path.basename(f.abs), src: 'all', sid: 's0', size: f.size, path: f.abs, ext: 'png', lastModified: f.mtime, state: 'idle' })))};
    S.sourceCount = () => S.items.length;
    A.showGallery(); A.renderSources(); document.getElementById('topbar').hidden = false;
    return S.items.length;
  })()`);
  await new Promise((r) => setTimeout(r, 2300));

  const R = {};

  // 逐张打开，测「常规窗口」与「全屏」两种状态
  R.cases = [];
  for (let k = 0; k < Math.min(4, files.length); k++) {
    await w.webContents.executeJavaScript(`(() => { [...document.querySelectorAll('.tile.g')][${k}].dispatchEvent(new MouseEvent('click',{bubbles:true})); return true; })()`);
    await new Promise((r) => setTimeout(r, 1400));
    const winNormal = await w.webContents.executeJavaScript(MEASURE);
    const name = await w.webContents.executeJavaScript(`window.Lightbox.meta.name`);

    // 进入全屏
    R['enter_ok_' + k] = await enterFs(w);
    const inFs = await w.webContents.executeJavaScript(MEASURE);
    // 全屏下旋转再测
    await w.webContents.executeJavaScript(`(() => { document.getElementById('lbRotR').click(); return true; })()`);
    await new Promise((r) => setTimeout(r, 700));
    const fsRot90 = await w.webContents.executeJavaScript(MEASURE);
    if (k === 0) {
      const s1 = await w.webContents.capturePage({ x: 0, y: 0, width: 1440, height: 900 });
      fs.writeFileSync(path.join(OUT, 'fs-edge.png'), s1.toPNG());
    }
    // 退出全屏
    R['exit_ok_' + k] = await exitFs(w);
    const afterExit = await w.webContents.executeJavaScript(MEASURE);

    R.cases.push({ name, winNormal, inFs, fsRot90, afterExit });
    await w.webContents.executeJavaScript(`(() => { window.Lightbox.close(); return true; })()`);
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log('FS ' + JSON.stringify(R, null, 1));
  app.quit();
});
