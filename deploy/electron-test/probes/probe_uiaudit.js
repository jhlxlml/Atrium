/* 一次性：UI 全面审查用截图（不属于回归套件，不进 run_all）
   把「空态 / 图库浅色深色 / 收起 / 瀑布流 / 单列 / 灯箱 / 设置面板 / 回收站 /
   窄窗 / 多选 / 多来源 / 紧凑密度 / 底部浮层」各截一张，人工比对。
   输出: deploy/electron-test/shots/audit-*.png
   用法: node deploy/electron-test/run_probe.js probe_uiaudit.js */
const { app, BrowserWindow, ipcMain, protocol } = require('electron');
require('./_desktop_stub').stubDesktop();
require('./_desktop_stub').stubWindowChannels();
const path = require('path');
const fs = require('fs');

const APPDIR = path.resolve(__dirname, '..', '..', '..');
const OUT = path.resolve(__dirname, '..', 'shots');
const PICDIR = path.join(__dirname, '..', 'fixtures', '照片夹');

app.setPath('userData', path.resolve(__dirname, '..', 'logs', 'ud_audit_' + Date.now()));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
protocol.registerSchemesAsPrivileged([
  { scheme: 'vf', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
]);

/* 回收站要两条通道：记录列表 + 缩略图（返回 1x1 透明 png 的数据 URL） */
ipcMain.handle('vf:trashLog', () => [
  { id: 't1', name: 'IMG_2043.jpg', path: 'C:/x/IMG_2043.jpg', root: 'C:/x', size: 2048000, ext: 'jpg', ts: Date.now() - 3600e3 },
  { id: 't2', name: '截图_2026-08-11.png', path: 'C:/y/截图_2026-08-11.png', root: 'C:/y', size: 512000, ext: 'png', ts: Date.now() - 86400e3 },
  { id: 't3', name: '海边.heic', path: 'C:/y/海边.heic', root: 'C:/y', size: 3317760, ext: 'heic', ts: Date.now() - 3 * 86400e3 },
]);
const PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
ipcMain.handle('vf:trashPreview', () => ({ ok: true, url: PX }));

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg' };

function collect(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const abs = path.join(dir, f);
    const st = fs.statSync(abs);
    if (st.isDirectory()) out.push(...collect(abs));
    else if (/\.(png|jpe?g)$/i.test(f)) out.push({ abs, size: st.size, mtime: st.mtimeMs });
  }
  return out;
}

async function run() {
  protocol.handle('vf', async (req) => {
    const u = new URL(req.url);
    if (u.host === 'pic') {
      const abs = Buffer.from(decodeURIComponent(u.pathname).replace(/^\/+/, ''), 'base64url').toString('utf8');
      try {
        return new Response(await fs.promises.readFile(abs), { status: 200,
          headers: { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' } });
      } catch (e) { return new Response('404', { status: 404 }); }
    }
    if (u.host !== 'app') return new Response('unknown', { status: 404 });
    const abs = path.resolve(APPDIR, decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html');
    try {
      return new Response(await fs.promises.readFile(abs), { status: 200,
        headers: { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' } });
    } catch (e) { return new Response('404', { status: 404 }); }
  });

  const winOpts = {
    width: 1440, height: 900, show: true, backgroundColor: '#f5f5f7',
    webPreferences: { preload: path.join(__dirname, '..', '..', 'electron', 'preload.js'), contextIsolation: true },
  };
  if (process.platform === 'win32') {
    winOpts.titleBarStyle = 'hidden';
    winOpts.titleBarOverlay = { color: '#f7f5f1', symbolColor: '#3a372f', height: 34 };
  }
  const win = new BrowserWindow(winOpts);
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('PAGE-ERR ' + msg); });

  await win.loadURL('vf://app/index.html');
  await new Promise((r) => setTimeout(r, 900));

  const files = collect(PICDIR);
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => {
    await sleep(320);
    const img = await win.webContents.capturePage();
    const png = img.toPNG();
    console.log('SHOT ' + name + ' ' + JSON.stringify(img.getSize()) + ' bytes=' + png.length
      + ' empty=' + img.isEmpty() + ' visible=' + win.isVisible() + ' focused=' + win.isFocused()
      + ' mini=' + win.isMinimized());
    fs.writeFileSync(path.join(OUT, name), png);
  };

  /* 1. 空态（未选任何文件夹） */
  await shot('audit-01-empty.png');

  /* 2. 图库（浅色，侧栏展开） */
  await js(`(() => {
    const S = window.State, A = window.App;
    S.sources = [
      { id: 's0', name: 'Screenshots', root: 'C:/Users/me/Pictures/Screenshots' },
      { id: 's1', name: 'Camera Roll', root: 'C:/Users/me/Pictures/CameraRoll' },
      { id: 's2', name: '手机备份 2026-08', root: 'C:/Users/me/Pictures/PhoneBackup' },
    ];
    S.items = ${JSON.stringify(files.map((f, i) => ({
      id: 'r' + i, name: path.basename(f.abs), src: 'all', sid: 's' + (i % 3),
      size: f.size, path: f.abs, ext: 'png', lastModified: f.mtime, state: 'idle',
    })))};
    S.sourceCount = (id) => id ? S.items.filter(x => x.sid === id).length : S.items.length;
    A.showGallery(); A.renderSources();
    document.getElementById('topbar').hidden = false;
    return true;
  })()`);
  await sleep(2200);
  await shot('audit-02-gallery.png');

  /* 3. 收起侧栏 */
  await js(`(() => { window.App.toggleSidebar(false); return true; })()`);
  await sleep(560);
  await shot('audit-03-collapsed.png');
  await js(`(() => { window.App.toggleSidebar(true); return true; })()`);
  await sleep(500);

  /* 4. 瀑布流 */
  await js(`(() => { window.App.setMode('masonry'); return true; })()`);
  await sleep(700);
  await shot('audit-04-masonry.png');

  /* 5. 单列整屏 */
  await js(`(() => { window.App.setMode('single'); return true; })()`);
  await sleep(700);
  await shot('audit-05-single.png');
  await js(`(() => { window.App.setMode('medium'); return true; })()`);
  await sleep(600);

  /* 6. 多选 + 选择条 */
  await js(`(() => { window.Grid.selectAll(true); window.App.onSelChanged(
    window.Grid.selectedCount(), window.Grid.selected()); return true; })()`);
  await sleep(400);
  await shot('audit-06-selbar.png');
  await js(`(() => { window.Grid.clearSel(); window.App.onSelChanged(0, new Set()); return true; })()`);

  /* 7. 顶部搜索展开 + 只看收藏 */
  await js(`(() => { const b = document.getElementById('searchToggle'); if (!b.getAttribute('aria-expanded')) b.click(); return true; })()`);
  await sleep(300);
  await shot('audit-07-search.png');
  await js(`(() => { const b = document.getElementById('searchToggle'); if (b.getAttribute('aria-expanded')) b.click();
    const f = document.getElementById('favOnlyBtn'); if (!f.classList.contains('is-on')) f.click(); return true; })()`);
  await sleep(400);
  await shot('audit-08-favonly.png');
  await js(`(() => { const f = document.getElementById('favOnlyBtn'); if (f.classList.contains('is-on')) f.click(); return true; })()`);
  await sleep(300);

  /* 8. 底部浮层（把鼠标移到底边热区让它显形） */
  const box = win.getBounds();
  await js(`(() => { const vb = document.getElementById('viewbar');
    vb.hidden = false; vb.classList.add('is-shown'); return true; })()`);
  await sleep(200);
  await win.webContents.executeJavaScript(`(() => {
    const vb = document.getElementById('viewbar');
    vb.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
    return true;
  })()`, true);
  await sleep(420);
  await shot('audit-09-viewbar.png');
  await js(`(() => { const vb = document.getElementById('viewbar');
    vb.classList.remove('is-shown'); vb.hidden = true; return true; })()`);

  /* 9. 灯箱（浅色） */
  await js(`(() => { const L = window.Lightbox;
    const m = window.State.items[0];
    L.open(window.State.items, m); return true; })()`);
  await sleep(700);
  // HUD 平时是隐藏的：把鼠标移到画面下缘的热区再截
  await win.webContents.executeJavaScript(`(() => {
    const lb = document.querySelector('.lightbox');
    lb.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientY: window.innerHeight - 24 }));
    return true;
  })()`, true);
  await sleep(420);
  await shot('audit-10-lightbox.png');
  await js(`(() => { window.Lightbox.close(); return true; })()`);
  await sleep(400);

  /* 10. 深色主题：图库 + 灯箱 + 设置面板 */
  await js(`(() => { window.App.applySetting('theme', 'dark'); return true; })()`);
  await sleep(700);
  await shot('audit-11-dark.png');
  await js(`(() => { const L = window.Lightbox; L.open(window.State.items, window.State.items[1]); return true; })()`);
  await sleep(650);
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('.lightbox').dispatchEvent(new PointerEvent('pointermove',
      { bubbles: true, clientY: window.innerHeight - 24 }));
    return true;
  })()`, true);
  await sleep(420);
  await shot('audit-12-dark-lightbox.png');
  await js(`(() => { window.Lightbox.close(); return true; })()`);
  await sleep(400);

  /* 11. 设置面板（浅色 / 深色各一张） */
  await js(`(() => { document.getElementById('setBtn').click(); return true; })()`);
  await sleep(500);
  await shot('audit-13-settings-dark.png');
  await js(`(() => { window.App.applySetting('theme', 'light'); return true; })()`);
  await sleep(600);
  await shot('audit-14-settings.png');
  await js(`(() => { document.getElementById('setClose').click(); return true; })()`);
  await sleep(300);

  /* 12. 回收站视图 */
  await js(`(async () => { await window.App.openTrash(); return true; })()`);
  await sleep(900);
  await shot('audit-15-trash.png');
  await js(`(() => { window.App.closeTrash(); return true; })()`);
  await sleep(500);

  /* 13. 侧栏来源很多（8 个）—— 看列表滚动与行高节奏 */
  await js(`(() => {
    const S = window.State;
    S.sources = S.sources.concat([
      { id: 'a', name: '壁纸合集', root: 'C:/w' }, { id: 'b', name: '设计参考', root: 'C:/d' },
      { id: 'c', name: '产品图 2026', root: 'C:/p' }, { id: 'd', name: '旅行 · 京都', root: 'C:/t' },
      { id: 'e', name: '扫描件', root: 'C:/s' },
    ]);
    window.App.renderSources();
    return true;
  })()`);
  await sleep(500);
  await shot('audit-16-many-sources.png');

  /* 14. 紧凑密度 */
  await js(`(() => { window.App.applySetting('density', 'compact'); return true; })()`);
  await sleep(600);
  await shot('audit-17-compact.png');
  await js(`(() => { window.App.applySetting('density', 'comfy'); return true; })()`);
  await sleep(400);

  /* 15. 窄窗 */
  win.setContentSize(1120, 720);
  await sleep(700);
  await shot('audit-18-narrow.png');
  win.setContentSize(760, 900);
  await sleep(700);
  await shot('audit-19-verynarrow.png');

  console.log('AUDIT DONE');
  app.quit();
}

app.whenReady().then(run).catch((e) => { console.error('ERR', e && e.stack || e); app.quit(); });
