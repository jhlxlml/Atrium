/* 终检：加载「打包后的 Electron 应用」，真实点击进入后逐次旋转，矩阵法判定居中。
   （原先加载的是离线单文件产物 —— 该产物已退役，改为从包内 app 目录静态服务。） */
const { app, BrowserWindow, protocol } = require('electron');

/* 桌面集成通道桩：缺了它 App.init() 的托盘/快捷键设置重放会"假失败" —— 详见 _desktop_stub.js */
require('./_desktop_stub').stubDesktop();
const path = require('path'); const fs = require('fs');
const OUT = path.resolve(__dirname, '..', 'shots');
const APPDIR = path.resolve(__dirname, '..', '..', 'dist-electron', 'Atrium_Electron版', 'resources', 'app');
const PICDIR = path.join(__dirname, '..', 'fixtures', '照片夹');

app.setPath('userData', path.resolve(__dirname, '..', 'logs', 'ud_rotfinal_' + Date.now()));
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

  // 真实点击打开
  await w.webContents.executeJavaScript(`(() => { [...document.querySelectorAll('.tile.g')][0].dispatchEvent(new MouseEvent('click',{bubbles:true})); return true; })()`);
  await new Promise((r) => setTimeout(r, 1600));

  // 逐个点「逆时针旋转」按钮，每次都用矩阵法核对（模拟用户真实操作）
  const res = [];
  for (let k = 0; k < 4; k++) {
    if (k > 0) {
      await w.webContents.executeJavaScript(`(() => { document.getElementById('lbRotR').click(); return true; })()`);
      await new Promise((r) => setTimeout(r, 500));
    }
    const m = await w.webContents.executeJavaScript(`(() => {
      const L = window.Lightbox, im = document.getElementById('lbImg');
      const base = im.offsetWidth, baseH = im.offsetHeight;
      const M = new DOMMatrix(getComputedStyle(im).transform);
      const pts = [[0,0],[base,0],[base,baseH],[0,baseH]].map(([x,y]) => ({ x: M.a*x + M.c*y + M.e, y: M.b*x + M.d*y + M.f }));
      const xs = pts.map(p=>p.x), ys = pts.map(p=>p.y);
      const cx = (Math.min(...xs)+Math.max(...xs))/2, cy = (Math.min(...ys)+Math.max(...ys))/2;
      const g = L._stageGeom();
      const r = im.getBoundingClientRect();
      return { rot: L.rot, scale: +L.scale.toFixed(4),
        quad: { w: +(Math.max(...xs)-Math.min(...xs)).toFixed(1), h: +(Math.max(...ys)-Math.min(...ys)).toFixed(1) },
        dev: { dx: +(cx - (g.x + L.tx)).toFixed(2), dy: +(cy - (g.y + L.ty)).toFixed(2) },
        inView: r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight };
    })()`);
    res.push(m);
    const s = await w.webContents.capturePage({ x: 0, y: 0, width: 1440, height: 900 });
    fs.writeFileSync(path.join(OUT, `final-rot-${m.rot}.png`), s.toPNG());
  }

  console.log('ROTFINAL ' + JSON.stringify(res, null, 1));
  app.quit();
});
