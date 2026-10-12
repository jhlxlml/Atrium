/* HEIC/HEIF 能力探测探针（P1-2）。只输出原始测量值（HEIC 一行 JSON），判定在 run_all.js。
   覆盖：
   A. 启动即探测完成，heicStatus() 是布尔（不再是「未探出」），heicTypes 形状正确；
   B. 含 .heic 的文件夹正常索引 —— 不被静默丢弃，条目标了 heic 标记；
   C. 条目 bad 与探测结论一致（不再无条件判死）；
   D. 把 heicReady 换成 true / false 两个分支，分别驱动 _applyHeicCapability，
      验证「能解就摘掉 bad、不能解就保持 bad」—— 与真实平台无关，两条路都测到；
   E. 灯箱的失败原因文案能区分「本机缺解码器」与「文件损坏」。
   用法: electron.exe probe_heic.js  (cwd = deploy/electron) */
const { app, BrowserWindow, protocol, ipcMain } = require('electron');

/* 桌面集成通道桩：缺了它 App.init() 的托盘/快捷键设置重放会"假失败" —— 详见 _desktop_stub.js */
require('./_desktop_stub').stubDesktop();
/* 窗口置顶 / 屏幕清单也要补桩：App.init() 启动时会拉，缺了会让探针变成"不完整宿主"
   —— invoke reject 被 .catch 吞掉，上层判"没生效"，并留下一条 console.warn 假报错。 */
require('./_desktop_stub').stubWindowChannels();
const path = require('path'); const fs = require('fs'); const os = require('os');
const APPDIR = path.resolve(__dirname, '..', '..', '..');
const OUT = path.resolve(__dirname, '..', 'shots');

app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
protocol.registerSchemesAsPrivileged([{ scheme: 'vf', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }]);
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png', '.jpg':'image/jpeg', '.heic':'image/heic' };

for (const ch of ['vf:trashLog','vf:autoDir','vf:pickDirs','vf:restoreFile','vf:restoreFiles','vf:trashForget','vf:trashClear','vf:pickFolder','vf:pickExportDir']) {
  ipcMain.handle(ch, () => (ch === 'vf:trashLog' || ch === 'vf:pickDirs' ? [] : null));
}
ipcMain.handle('vf:setLastDir', () => true);
ipcMain.handle('vf:readHead', () => null);
ipcMain.handle('vf:exportFiles', () => ({ ok: false, reason: 'unsupported' }));

/* ---------- 造一批假的 HEIC 文件（只需存在且带 ftyp 头；解码由能力探测决定） ---------- */
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-heic-'));
function writeHeic(name, brand) {
  // [size:4][ftyp][brand:4][minor:4] + 少量填充；末尾补 mdat 让文件非空
  const head = Buffer.alloc(24);
  head.writeUInt32BE(24, 0);
  head.write('ftyp', 4, 'ascii');
  head.write(brand, 8, 'ascii');
  head.writeUInt32BE(0, 12);
  head.write(brand, 16, 'ascii');
  const pad = Buffer.alloc(256, 0x11);
  const abs = path.join(DIR, name);
  fs.writeFileSync(abs, Buffer.concat([head, pad]));
  return abs;
}
const HEICS = [writeHeic('手机照片-01.heic', 'heic'), writeHeic('手机照片-02.heif', 'mif1')];
const JPG = path.join(__dirname, '..', 'fixtures', '照片夹', '山景-01.png');

const LOAD_FILES = [
  { name: path.basename(HEICS[0]), rel: path.basename(HEICS[0]), size: fs.statSync(HEICS[0]).size, mtime: Date.now(), path: HEICS[0] },
  { name: path.basename(HEICS[1]), rel: path.basename(HEICS[1]), size: fs.statSync(HEICS[1]).size, mtime: Date.now(), path: HEICS[1] },
  { name: '山景-01.png', rel: '山景-01.png', size: fs.statSync(JPG).size, mtime: Date.now(), path: JPG },
];
ipcMain.handle('vf:loadDir', () => ({ ok: true, name: '手机导出', files: LOAD_FILES }));

app.whenReady().then(async () => {
  protocol.handle('vf', async (req) => {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const abs = u.host === 'pic'
      ? Buffer.from(rel, 'base64url').toString('utf8')
      : path.resolve(APPDIR, rel || 'index.html');
    try {
      const b = await fs.promises.readFile(abs);
      return new Response(b, { headers: { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' } });
    } catch (e) { return new Response('404', { status: 404 }); }
  });

  const w = new BrowserWindow({ width: 1300, height: 860, show: true,
    webPreferences: { preload: path.join(APPDIR, 'deploy', 'electron', 'preload.js'), contextIsolation: true } });
  w.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('PAGE-ERR ' + msg); });
  await w.loadURL('vf://app/index.html');
  await new Promise((r) => setTimeout(r, 900));

  /* --- A. 能力探测本身 --- */
  const A = await w.webContents.executeJavaScript(`(() => {
    const U = window.Util;
    return {
      status: U.heicStatus(),            // null 表示还没探出来
      supported: U.heicSupported(),
      types: U.heicTypes,
      hasImageDecoder: typeof window.ImageDecoder === 'function',
      hasReady: typeof U.heicReady === 'function' && typeof U.probeHeic === 'function',
      isHeic: [U.isHeic('a.heic'), U.isHeic('b.HEIF'), U.isHeic('c.jpg')],
      isImageExt: U.isImageExt('a.heic'),
    };
  })()`);

  /* --- B/C. 含 HEIC 的文件夹正常索引 --- */
  await w.webContents.executeJavaScript(`window.Loader.fromNative(${JSON.stringify(DIR)}, false)`);
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    const busy = await w.webContents.executeJavaScript('!!window.Loader.isIndexing');
    if (!busy) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  await new Promise((r) => setTimeout(r, 600));

  const BC = await w.webContents.executeJavaScript(`(() => {
    const S = window.State;
    const items = S.items.map((m) => ({ name: m.name, ext: m.ext, heic: !!m.heic, bad: !!m.bad, heicOk: m.heicOk }));
    const heics = S.items.filter((m) => m.heic);
    return {
      total: S.items.length, heics: heics.length,
      heicAll: heics.map((m) => ({ name: m.name, bad: !!m.bad, heicOk: m.heicOk })),
      others: S.items.filter((m) => !m.heic).map((m) => ({ name: m.name, bad: !!m.bad })),
      tiles: document.querySelectorAll('.tile').length,
      errTiles: document.querySelectorAll('.tile.err').length,
      supported: window.Util.heicSupported(),
      items: items,
    };
  })()`);

  /* --- D. 两条分支：能解 / 不能解 --- */
  const D = await w.webContents.executeJavaScript(`(async () => {
    const U = window.Util, L = window.Loader;
    const keep = { ready: U.heicReady, supported: U.heicSupported };

    const mk = () => ([
      { name: 'x.heic', ext: 'heic', heic: true, bad: true,  state: 'idle' },
      { name: 'y.heif', ext: 'heif', heic: true, bad: true,  state: 'idle' },
      { name: 'z.png',  ext: 'png',  heic: false, bad: false, state: 'idle' },
    ]);

    U.heicReady = () => Promise.resolve(true);  U.heicSupported = () => true;
    const cap = mk(); await L._applyHeicCapability(cap);

    U.heicReady = () => Promise.resolve(false); U.heicSupported = () => false;
    const noCap = mk(); await L._applyHeicCapability(noCap);

    U.heicReady = keep.ready; U.heicSupported = keep.supported;
    return {
      capable:   { heicBads: cap.filter((m) => m.heic).map((m) => m.bad), okFlags: cap.filter((m) => m.heic).map((m) => m.heicOk), pngBad: cap[2].bad },
      incapable: { heicBads: noCap.filter((m) => m.heic).map((m) => m.bad), okFlags: noCap.filter((m) => m.heic).map((m) => m.heicOk), pngBad: noCap[2].bad },
    };
  })()`);

  /* --- E. 失败原因文案 --- */
  const E = await w.webContents.executeJavaScript(`(() => {
    const U = window.Util, L = window.Lightbox;
    const heicMeta = window.State.items.find((m) => m.heic);
    const keep = U.heicStatus;
    const real = heicMeta ? L._badReason(heicMeta) : '';
    U.heicStatus = () => false;                       // 假装本机解不了
    const whenUnsupported = heicMeta ? L._badReason(heicMeta) : '';
    U.heicStatus = () => true;                        // 假装解码器坏了
    const whenSupported = heicMeta ? L._badReason(heicMeta) : '';
    U.heicStatus = keep;                              // 还原
    const plain = L._badReason({ name: 'a.tif' });
    return { real: real, whenUnsupported: whenUnsupported, whenSupported: whenSupported,
             plain: plain, heicMetaBad: !!(heicMeta && heicMeta.bad), heicMetaName: heicMeta && heicMeta.name };
  })()`);

  const shot = await w.webContents.capturePage({ x: 0, y: 0, width: 1300, height: 620 });
  fs.writeFileSync(path.join(OUT, 'heic.png'), shot.toPNG());

  console.log('HEIC ' + JSON.stringify({ dir: DIR, A: A, BC: BC, D: D, E: E }));
  console.log('DONE');
  app.quit();
}).catch((e) => { console.error('ERR', (e && e.stack) || e); app.quit(); });
