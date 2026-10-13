/* 定点验证：缩放/旋转后图片中心是否始终等于舞台中心 */
const { app, BrowserWindow, protocol } = require('electron');

/* 桌面集成通道桩：缺了它 App.init() 的托盘/快捷键设置重放会"假失败" —— 详见 _desktop_stub.js */
require('./_desktop_stub').stubDesktop();
const path = require('path'); const fs = require('fs');
const APPDIR = path.resolve(__dirname, '..', '..', '..');
const PICDIR = path.join(__dirname, '..', 'fixtures', '照片夹');

app.setPath('userData', path.resolve(__dirname, '..', 'logs', 'ud_zoomchk_' + Date.now()));
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
protocol.registerSchemesAsPrivileged([{ scheme: 'vf', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }]);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif' };
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
      try { const b = await fs.promises.readFile(abs); return new Response(b, { headers: { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' } }); }
      catch (e) { return new Response('404', { status: 404 }); }
    }
    const abs = path.resolve(APPDIR, decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html');
    try { const b = await fs.promises.readFile(abs); return new Response(b, { headers: { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' } }); }
    catch (e) { return new Response('404', { status: 404 }); }
  });

  /* 窗口选项**镜像生产**（main.js 的 WCO 分支）：Windows 上主窗口有 Window Controls
     Overlay，灯箱因此被标题栏下压 34px —— 而"居中"正是最容易被打偏的东西，
     所以这个探针必须跑在生产配置上，否则它测的是一套用户看不到的布局。 */
  const winOpts = { width: 1500, height: 860, show: true,
    webPreferences: { preload: path.join(APPDIR, 'deploy', 'electron', 'preload.js'), contextIsolation: true } };
  if (process.platform === 'win32') {
    winOpts.titleBarStyle = 'hidden';
    winOpts.titleBarOverlay = { color: '#f7f5f1', symbolColor: '#3a372f', height: 34 };
  }
  const w = new BrowserWindow(winOpts);
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
  await new Promise((r) => setTimeout(r, 2200));
  await w.webContents.executeJavaScript(`(() => { [...document.querySelectorAll('.tile.g')][0].dispatchEvent(new MouseEvent('click',{bubbles:true})); return true; })()`);
  await new Promise((r) => setTimeout(r, 1800));

  const out = await w.webContents.executeJavaScript(`(() => {
    const L = window.Lightbox, im = document.getElementById('lbImg'), st = document.getElementById('lbStage');
    const res = [];
    function snap(label){
      // 先掐掉 CSS 过渡：rotate() 会加 .anim 触发 0.2s transform 过渡，
      // 同步读 getBoundingClientRect 会拿到过渡中间值（历史探针的假阴性来源）。
      im.classList.remove('anim');
      if (im.style.transition !== 'none') im.style.transition = 'none';
      void im.offsetWidth;   // 强制回流
      const r = im.getBoundingClientRect(), s = st.getBoundingClientRect();
      const ic = { x: r.left + r.width/2, y: r.top + r.height/2 };
      const sc = { x: s.left + s.width/2, y: s.top + s.height/2 };
      res.push({ label, scale: +L.scale.toFixed(4), rot: L.rot, tx: +L.tx.toFixed(2), ty: +L.ty.toFixed(2),
        offW: im.offsetWidth, offH: im.offsetHeight,
        dispW: +r.width.toFixed(1), dispH: +r.height.toFixed(1),
        d: { dx: +(ic.x - sc.x).toFixed(2), dy: +(ic.y - sc.y).toFixed(2) },
        fullyVisible: r.right > sc.x - s.width/2 && r.left < sc.x + s.width/2 ? 'x-in' : 'x-out' });
    }
    L.fit(false); snap('fit');
    L.zoomAt(2, L._center().x, L._center().y); snap('zoom x2 (center pivot)');
    L.zoomAt(2, L._center().x, L._center().y); snap('zoom x4 (center pivot)');
    L.zoomAt(0.5, L._center().x, L._center().y); snap('zoom x2 again');
    // 关掉平移再放大（模拟滚轮在角落放大后再回中）
    L.tx = -200; L.ty = -150; L.apply(); snap('panned (expect offset -200/-150)');
    L.tx = 0; L.ty = 0; L.apply(); snap('recentered');
    L.rotate(1); snap('rot 90');
    L.rotate(1); snap('rot 180');
    L.rotate(1); snap('rot 270');
    L.rotate(1); snap('rot 0');
    return res;
  })()`);

  console.log('CHECK ' + JSON.stringify(out, null, 1));
  app.quit();
});
