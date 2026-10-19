/* 灯箱（单图浏览）UI 核验：
   1) 关闭键是否在右上角（常规 / 信息面板展开 两种状态）
   2) 底部 HUD 有没有"同一个图标出现两次"
   3) 激活态颜色是否按语义分开（面板类=蓝、收藏=黄）
   4) 出两张截图供人眼复核
   源目录直接服务项目根，改完 CSS/HTML 不用重新打包即可验证。 */
const { app, BrowserWindow, protocol } = require('electron');

/* 桌面集成通道桩：缺了它 App.init() 的托盘/快捷键设置重放会"假失败" —— 详见 _desktop_stub.js */
require('./_desktop_stub').stubDesktop();
const path = require('path'); const fs = require('fs');
const APPDIR = path.resolve(__dirname, '..', '..', '..');
const OUT = path.resolve(__dirname, '..', 'shots');
const PICDIR = path.join(__dirname, '..', 'fixtures', '照片夹');

app.setPath('userData', path.resolve(__dirname, '..', 'logs', 'ud_lbui_' + Date.now()));
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

/* 量关闭键与 HUD */
const MEASURE = `(() => {
  const close = document.getElementById('lbClose');
  const cb = close.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const btns = [...document.querySelectorAll('.lb-actions .ico-btn')].filter(b => b.offsetParent !== null);
  const hud = document.querySelector('.lb-hud');
  const info = document.getElementById('lbInfoPane');
  return {
    vw, vh,
    close: {
      left: +cb.left.toFixed(1), top: +cb.top.toFixed(1),
      right: +(vw - cb.right).toFixed(1), bottom: +(vh - cb.bottom).toFixed(1),
      w: +cb.width.toFixed(1), h: +cb.height.toFixed(1),
      opacity: +getComputedStyle(close).opacity
    },
    hud: hud ? { right: +(vw - hud.getBoundingClientRect().right).toFixed(1), w: +hud.getBoundingClientRect().width.toFixed(1) } : null,
    info: info && !info.hidden ? { left: +info.getBoundingClientRect().left.toFixed(1), w: +info.getBoundingClientRect().width.toFixed(1) } : null,
    buttons: btns.map(b => {
      const u = b.querySelector('use');
      return {
        id: b.id,
        icon: u ? (u.getAttribute('href') || u.getAttribute('xlink:href') || '') : '',
        label: b.getAttribute('aria-label') || '',
        on: b.classList.contains('is-on'),
        fav: b.classList.contains('is-fav'),
        color: getComputedStyle(b).color
      };
    })
  };
})()`;

app.whenReady().then(async () => {
  protocol.handle('vf', async (req) => {
    const u = new URL(req.url);
    if (u.host === 'pic') {
      const b64 = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      const abs = Buffer.from(b64, 'base64url').toString('utf8');
      try { const b = await fs.promises.readFile(abs); return new Response(b, { headers: { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' } }); }
      catch (e) { return new Response('404', { status: 404 }); }
    }
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const abs = path.resolve(APPDIR, rel || 'index.html');
    if (!abs.startsWith(APPDIR)) return new Response('403', { status: 403 });
    try { const b = await fs.promises.readFile(abs); return new Response(b, { headers: { 'content-type': (MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream') } }); }
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

  // ---- 打开单图浏览 ----
  await w.webContents.executeJavaScript(`(() => {
    const t = [...document.querySelectorAll('.tile.g')][2] || [...document.querySelectorAll('.tile.g')][0];
    t.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 1800));
  // 让 HUD 显形：沉浸态下控件靠鼠标热区显现，顶部热区=关闭键、底部热区=操作栏，
  // 所以两个热区各触发一次，再分别截图（合成的 mousemove 必须打在 #lightbox 上，
  // 监听挂在 this.el，打在 document 上不会冒泡到这里）。
  const hover = (x, y) => w.webContents.executeJavaScript(`(() => {
    const lb = document.getElementById('lightbox');
    lb.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${x}, clientY: ${y} }));
    return true;
  })()`);
  await hover(720, 24);
  await new Promise((r) => setTimeout(r, 300));

  const R = {};
  R.normal = await w.webContents.executeJavaScript(MEASURE);

  // 截图：右上角关闭键特写（顶部热区）
  let shot = await w.webContents.capturePage({ x: 0, y: 0, width: 1440, height: 900 });
  fs.writeFileSync(path.join(OUT, 'lb-ui-close-ctx.png'), shot.toPNG());

  // 底部热区：操作栏显形
  await hover(720, 690);
  await new Promise((r) => setTimeout(r, 300));
  shot = await w.webContents.capturePage({ x: 0, y: 0, width: 1440, height: 900 });
  fs.writeFileSync(path.join(OUT, 'lb-ui-normal.png'), shot.toPNG());
  R.hudShown = await w.webContents.executeJavaScript(`(() => {
    const hud = document.querySelector('.lb-hud');
    return { opacity: +getComputedStyle(hud).opacity, idle: document.getElementById('lightbox').classList.contains('fs-idle') };
  })()`);

  // ---- 打开信息面板，再看关闭键是否让开 ----
  await w.webContents.executeJavaScript(`(() => { document.getElementById('lbInfo').click(); return true; })()`);
  await new Promise((r) => setTimeout(r, 900));
  R.withInfo = await w.webContents.executeJavaScript(MEASURE);
  await hover(720, 690);            // 停手 2.6s 会淡出，截图前再触发一次底部热区
  await new Promise((r) => setTimeout(r, 300));
  shot = await w.webContents.capturePage({ x: 0, y: 0, width: 1440, height: 900 });
  fs.writeFileSync(path.join(OUT, 'lb-ui-info.png'), shot.toPNG());

  // ---- 滚轮按钮切到 nav 模式：图标应变成左右箭头，且颜色是蓝不是黄 ----
  await w.webContents.executeJavaScript(`(() => { document.getElementById('lbWheel').click(); return true; })()`);
  await new Promise((r) => setTimeout(r, 400));
  R.wheelNav = await w.webContents.executeJavaScript(`(() => {
    const b = document.getElementById('lbWheel');
    const u = b.querySelector('use');
    return { icon: u && u.getAttribute('href'), on: b.classList.contains('is-on'), color: getComputedStyle(b).color };
  })()`);
  await hover(720, 690);
  await new Promise((r) => setTimeout(r, 250));
  shot = await w.webContents.capturePage({ x: 0, y: 0, width: 1440, height: 900 });
  fs.writeFileSync(path.join(OUT, 'lb-ui-wheel.png'), shot.toPNG());
  await w.webContents.executeJavaScript(`(() => { document.getElementById('lbWheel').click(); return true; })()`);

  // ---- 收藏：应为黄色 ----
  await w.webContents.executeJavaScript(`(() => { document.getElementById('lbFav').click(); return true; })()`);
  await new Promise((r) => setTimeout(r, 400));
  R.fav = await w.webContents.executeJavaScript(`(() => {
    const b = document.getElementById('lbFav');
    const u = b.querySelector('use');
    return { icon: u && u.getAttribute('href'), fav: b.classList.contains('is-fav'), on: b.classList.contains('is-on'), color: getComputedStyle(b).color };
  })()`);

  console.log('LBUI ' + JSON.stringify(R, null, 1));
  app.quit();
});
