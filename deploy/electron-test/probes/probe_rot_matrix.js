/* 精确验证：用 DOMMatrix 解算图片四角，反推旋转后几何中心 */
const { app, BrowserWindow, protocol } = require('electron');

/* 桌面集成通道桩：缺了它 App.init() 的托盘/快捷键设置重放会"假失败" —— 详见 _desktop_stub.js */
require('./_desktop_stub').stubDesktop();
const path = require('path'); const fs = require('fs');
const APPDIR = path.resolve(__dirname, '..', '..', '..');
const PICDIR = path.join(__dirname, '..', 'fixtures', '照片夹');

app.setPath('userData', path.resolve(__dirname, '..', 'logs', 'ud_mx_' + Date.now()));
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
    const abs = path.resolve(APPDIR, decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html');
    try { const b = await fs.promises.readFile(abs); return new Response(b, { headers: { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'access-control-allow-origin': 'vf://app' } }); }
    catch (e) { return new Response('404', { status: 404 }); }
  });

  const w = new BrowserWindow({ width: 1440, height: 900, show: true,
    webPreferences: { preload: path.join(APPDIR, 'deploy', 'electron', 'preload.js'), contextIsolation: true } });
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
  await w.webContents.executeJavaScript(`(() => { [...document.querySelectorAll('.tile.g')][0].dispatchEvent(new MouseEvent('click',{bubbles:true})); return true; })()`);
  await new Promise((r) => setTimeout(r, 1600));

  const res = await w.webContents.executeJavaScript(`(() => {
    const L = window.Lightbox, im = document.getElementById('lbImg');
    const out = [];
    function snap(label){
      // 关键：先掐掉 CSS 过渡。rotate() 会加 .anim 触发 transform 过渡（0.2s），
      // 同步读 getComputedStyle 拿到的是过渡起点值 → 会把「旋转已生效」误判为没换边。
      im.classList.remove('anim');
      if (im.style.transition !== 'none') im.style.transition = 'none';
      void im.offsetWidth;   // 强制回流
      const base = im.offsetWidth, baseH = im.offsetHeight;
      const m = new DOMMatrix(getComputedStyle(im).transform);   // 含 translate/rotate/scale
      // 元素局部四角 -> 变换后坐标
      const pts = [[0,0],[base,0],[base,baseH],[0,baseH]].map(([x,y]) => ({
        x: m.a*x + m.c*y + m.e,
        y: m.b*x + m.d*y + m.f
      }));
      const xs = pts.map(p=>p.x), ys = pts.map(p=>p.y);
      const cx = (Math.min(...xs)+Math.max(...xs))/2;
      const cy = (Math.min(...ys)+Math.max(...ys))/2;
      const S = window.State;
      // 舞台中心（用 Lightbox 自己的基准，保证与产品逻辑同源）
      const g = L._stageGeom();
      out.push({ label, rot: L.rot, scale: +L.scale.toFixed(4), tx: +L.tx.toFixed(2), ty: +L.ty.toFixed(2),
        quad: { w: +(Math.max(...xs)-Math.min(...xs)).toFixed(1), h: +(Math.max(...ys)-Math.min(...ys)).toFixed(1) },
        ctr: { x: +cx.toFixed(2), y: +cy.toFixed(2) },
        want: { x: +((g.x + L.tx)).toFixed(2), y: +((g.y + L.ty)).toFixed(2) },
        dev: { dx: +(cx - (g.x + L.tx)).toFixed(2), dy: +(cy - (g.y + L.ty)).toFixed(2) } });
    }
    L.fit(false); snap('fit rot0');
    L.rotate(1); snap('rot90');
    L.rotate(1); snap('rot180');
    L.rotate(1); snap('rot270');
    L.rotate(1); snap('rot360');
    L.zoomAt(2.2, L._center().x, L._center().y); snap('zoom2.2 rot0');
    L.rotate(1); snap('zoom2.2 rot90');
    L.rotate(1); snap('zoom2.2 rot180');
    L.rotate(1); snap('zoom2.2 rot270');
    L.fit(false); snap('refit rot270');
    L.rot = 0; L.fit(false); L.zoomAt(0.4, L._center().x, L._center().y); snap('small rot0');
    L.rotate(1); snap('small rot90');
    L.rotate(1); snap('small rot180');
    // 平移后再旋转：应保持平移量
    L.rot = 0; L.fit(false); L.zoomAt(2.5, L._center().x, L._center().y);
    L.tx = -180; L.ty = 120; L.apply(); snap('panned(-180,120) rot0');
    L.rotate(1); snap('panned rot90 (应保持 -180,120)');
    return out;
  })()`);

  console.log('MX ' + JSON.stringify(res, null, 1));
  app.quit();
});
