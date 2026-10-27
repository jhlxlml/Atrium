/* 旋转持久化与导出探针（P1-4）。只输出原始测量值（RP 一行 JSON），判定在 run_all.js。
   覆盖：
   A. 初始无旋转记录；
   B. 灯箱内旋转 → State 记录 + localStorage 落盘；
   C. 关闭灯箱后网格瓦片跟着换向（r90 类 + 占位框宽高对调）；
   D. 用 Canvas 把旋转烘焙成像素：结果图宽高确实对调；
   E. 真实 IPC 导出（复制原图 + 写入烘焙图）→ 落盘文件可读、PNG 头尺寸正确；
   F. 转满一圈回到 0° → 记录被删除；resetRot() 也能清掉；
   G. 重新载入应用（等价「重开」）→ 旋转记录仍在，打开灯箱自动恢复该朝向。
   用法: electron.exe probe_rot_persist.js  (cwd = deploy/electron) */
const { app, BrowserWindow, protocol, ipcMain, session } = require('electron');

/* 桌面集成通道桩：缺了它 App.init() 的托盘/快捷键设置重放会"假失败" —— 详见 _desktop_stub.js */
require('./_desktop_stub').stubDesktop();
/* 窗口置顶 / 屏幕清单也要补桩：App.init() 启动时会拉，缺了会让探针变成"不完整宿主"
   —— invoke reject 被 .catch 吞掉，上层判"没生效"，并留下一条 console.warn 假报错。 */
require('./_desktop_stub').stubWindowChannels();
const path = require('path'); const fs = require('fs'); const os = require('os');
const APPDIR = path.resolve(__dirname, '..', '..', '..');
const OUT = path.resolve(__dirname, '..', 'shots');
const PICDIR = path.join(__dirname, '..', 'fixtures', '照片夹');

app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
protocol.registerSchemesAsPrivileged([{ scheme: 'vf', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true } }]);
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png', '.jpg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.bmp':'image/bmp' };

// —— 静音原生通道（本探针只用到 pickExportDir / exportFiles / openPath） ——
for (const ch of ['vf:trashLog','vf:autoDir','vf:pickDirs','vf:restoreFile','vf:restoreFiles','vf:trashForget','vf:trashClear','vf:pickFolder']) {
  ipcMain.handle(ch, () => (ch === 'vf:trashLog' || ch === 'vf:pickDirs' ? [] : null));
}
ipcMain.handle('vf:loadDir', () => ({ ok: false, files: [] }));
ipcMain.handle('vf:pickExportDir', () => EXPORT_DIR);   // 不弹框，直接给探针的临时目录
// 导出的落盘实现与主进程完全同一份代码（deploy/electron/exportlib.js）
const exportLib = require(path.join(APPDIR, 'deploy', 'electron', 'exportlib.js'));
ipcMain.handle('vf:exportFiles', async (e, dir, list) => exportLib.exportFiles(dir, list));

function collect(dir, base) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const abs = path.join(dir, f);
    const st = fs.statSync(abs);
    if (st.isDirectory()) out.push(...collect(abs, base));
    else if (/\.(png|jpe?g|gif|webp)$/i.test(f)) out.push({ abs, rel: path.relative(base, abs).replace(/\\/g, '/'), size: st.size, mtime: st.mtimeMs });
  }
  return out;
}

const EXPORT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-export-'));

/* 造一张 BMP（24 位不压缩）。
   为什么要专门造：素材夹里全是 PNG，而「烘焙导出的扩展名要跟实际编码一致」
   这条只有在**源格式 canvas 编不出来**时才看得出来 —— BMP 正是这种，
   烘焙必须落回 PNG，于是文件名也得从 .bmp 改成 .png。
   字节布局按 BMP 规范手写，不引外部依赖。 */
function makeBmp(w, h) {
  const pad = (4 - ((w * 3) % 4)) % 4;
  const dataSize = (w * 3 + pad) * h;
  const buf = Buffer.alloc(54 + dataSize);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(54 + dataSize, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);          // 正数 = 自下而上
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(dataSize, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = 54 + y * (w * 3 + pad) + x * 3;
      buf[o] = (x * 255 / Math.max(1, w - 1)) | 0;       // B
      buf[o + 1] = (y * 255 / Math.max(1, h - 1)) | 0;   // G
      buf[o + 2] = 200;                                   // R
    }
  }
  return buf;
}
const BMP_NAME = '竖幅-06.bmp';
const BMP_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vf-bake-')), BMP_NAME);
fs.writeFileSync(BMP_PATH, makeBmp(40, 60));    // 40×60 竖图 → 转 90° 后应成 60×40

app.whenReady().then(async () => {
  // 内存分区：每次运行 localStorage 都是空的，断言可重复。
  // 注意：自定义 partition 是独立 session，vf:// 协议必须注册在它上面，
  // 只注册默认 session 会导致加载 vf://app/index.html 报 ERR_FAILED。
  const PART = 'vf-rot-' + Date.now();
  const ses = session.fromPartition(PART);

  const handleVf = async (req) => {
    const u = new URL(req.url);
    if (u.host === 'pic') {
      const b64 = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      const abs = Buffer.from(b64, 'base64url').toString('utf8');
      try { const b = await fs.promises.readFile(abs);
        return new Response(b, { headers: { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'access-control-allow-origin': 'vf://app' } });
      } catch (e) { return new Response('404', { status: 404 }); }
    }
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const abs = path.resolve(APPDIR, rel || 'index.html');
    try { const b = await fs.promises.readFile(abs);
      return new Response(b, { headers: { 'content-type': (MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream') } });
    } catch (e) { return new Response('404', { status: 404 }); }
  };
  protocol.handle('vf', handleVf);        // 默认 session（保险）
  ses.protocol.handle('vf', handleVf);    // 本窗口所在的独立 session

  const w = new BrowserWindow({ width: 1400, height: 880, show: true,
    webPreferences: {
      preload: path.join(APPDIR, 'deploy', 'electron', 'preload.js'),
      contextIsolation: true,
      partition: PART,
    } });
  w.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('PAGE-ERR ' + msg); });

  const exec = (code) => w.webContents.executeJavaScript(code);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(cond, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await exec('!!(' + cond + ')').catch(() => false);
      if (ok) return true;
      // eslint-disable-next-line no-await-in-loop
      await wait(120);
    }
    return false;
  }

  const files = collect(PICDIR, PICDIR);
  // 选一张竖图做旋转实验：转 90° 后应是横图，宽高互换最明显
  const portrait = files.find((f) => /街道-04\.png$/.test(f.abs)) || files[0];
  const INJECT = (recs) => `(() => {
    const S = window.State, A = window.App;
    const recs = ${JSON.stringify(recs)};
    S.sources = [{ id: 's0', name: '照片夹', root: 'C:/Users/me/Pictures/照片夹' }];
    S.items = recs.map((r, i) => ({
      id: 'r' + i, name: r.n, src: 'all', sid: 's0',
      size: r.size, path: r.p, rel: r.rel, ext: r.n.split('.').pop().toLowerCase(),
      lastModified: r.mtime, state: 'idle',
    }));
    S.sourceCount = (id) => (id === 'all' ? S.items.length : S.items.filter((x) => x.sid === id).length);
    A.showGallery(); A.renderSources();
    document.getElementById('topbar').hidden = false;
    const m = S.items.find((x) => x.path === ${JSON.stringify(portrait.abs)}) || S.items[0];
    const bmp = S.items.find((x) => x.path === ${JSON.stringify(BMP_PATH)}) || null;
    window.__probe = { target: m, bmp: bmp };
    return { items: S.items.length, target: m && m.name, bmp: bmp && bmp.name };
  })()`;

  const recs = files.map((f) => ({ p: f.abs, n: path.basename(f.abs), rel: f.rel, size: f.size, mtime: f.mtime }));
  // 多挂一张 BMP：它不参与旋转持久化的断言，只用来测「烘焙落盘的文件名」
  recs.push({ p: BMP_PATH, n: BMP_NAME, rel: BMP_NAME, size: fs.statSync(BMP_PATH).size, mtime: Date.now() });

  /* =================== 第一次载入 =================== */
  await w.loadURL('vf://app/index.html');
  await wait(900);
  await exec(INJECT(recs));
  await wait(1800);

  const A = await exec(`(() => {
    const S = window.State;
    return {
      lsKey: localStorage.getItem('viewfinder.rot.v1'),
      count: S.rotationCount,
      stateRot: S.rotationOf(window.__probe.target),
      hasApi: typeof S.setRotation === 'function' && typeof S.rotationOf === 'function',
      tileRotAttr: !!document.querySelector('.tile[data-rot]'),
    };
  })()`);

  /* --- 打开灯箱，等图片就绪 --- */
  await exec(`(() => { const L = window.Lightbox; L.open(window.State.viewList(), window.__probe.target); return !!L.openFlag; })()`);
  const gotNw = await waitFor('window.Lightbox.nw > 0', 8000);
  const B0 = await exec(`(() => { const L = window.Lightbox; return { rot: L.rot, open: !!L.openFlag, nw: L.nw, nh: L.nh }; })()`);

  /* --- 顺时针转 90° --- */
  await exec(`(() => { window.Lightbox.rotate(1); return 1; })()`);
  await wait(400);
  const B1 = await exec(`(() => {
    const L = window.Lightbox, S = window.State;
    let ls = null; try { ls = JSON.parse(localStorage.getItem('viewfinder.rot.v1') || '{}'); } catch (e) {}
    return {
      lbRot: L.rot, stateRot: S.rotationOf(window.__probe.target), count: S.rotationCount,
      ls: ls, lsKeyUsed: Object.keys(ls || {})[0] || null,
      tf: getComputedStyle(L.img).transform,
    };
  })()`);

  /* --- 关灯箱 → 网格瓦片是否跟着换向 --- */
  await exec(`(() => { window.Lightbox.close(); return 1; })()`);
  await wait(600);
  const C = await exec(`(() => {
    const g = window.Grid;
    let el = null;
    for (const [, e] of g.els) if (e && e._item && e._item.path === window.__probe.target.path) { el = e; break; }
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    const ph = el._ph;
    return {
      found: true,
      cls: el.className,
      r90: el.classList.contains('r90'),
      dataRot: el.dataset.rot,
      tileW: Math.round(r.width), tileH: Math.round(r.height),
      phW: ph ? Math.round(parseFloat(ph.style.width) || 0) : null,
      phH: ph ? Math.round(parseFloat(ph.style.height) || 0) : null,
      phTransform: ph ? getComputedStyle(ph).transform : null,
      capUpright: !!(el.querySelector('.tile-cap')),
    };
  })()`);

  /* --- 烘焙：竖图转 90° 后应是横图（宽高对调） --- */
  const D = await exec(`(async () => {
    const A = window.App, S = window.State;
    const meta = window.__probe.target;
    const bake = await A._bakeRotation(meta, 90);
    if (!bake || !bake.b64) return { ok: false };
    const mime = bake.ext === 'jpg' ? 'image/jpeg' : bake.ext === 'webp' ? 'image/webp' : 'image/png';
    const url = 'data:' + mime + ';base64,' + bake.b64;
    const dim = await new Promise((res) => { const im = new Image(); im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight }); im.onerror = () => res({ w: 0, h: 0 }); im.src = url; });
    window.__probe.baked = bake.b64;
    return { ok: true, ext: bake.ext, b64len: bake.b64.length, bakedW: dim.w, bakedH: dim.h,
             rot: S.rotationOf(meta) };
  })()`);

  /* --- 真实 IPC 导出：原样复制 + 落盘烘焙图 --- */
  const E = await exec(`(async () => {
    const meta = window.__probe.target;
    const b64 = window.__probe.baked;
    const r = await window.vfNative.exportFiles(${JSON.stringify(EXPORT_DIR)}, [
      { src: meta.path, name: 'copy-' + meta.name },
      { src: null, name: 'baked-90.png', dataB64: b64 },
    ]);
    // 同名再来一次 → 应自动加 “ (2)”，绝不覆盖
    const r2 = await window.vfNative.exportFiles(${JSON.stringify(EXPORT_DIR)}, [
      { src: meta.path, name: 'copy-' + meta.name },
    ]);
    return { ok: r && r.ok, results: r && r.results, dup: r2 && r2.results, dir: r && r.dir };
  })()`);

  /* --- E2. 走「选择条按钮」那条真实用户路径（App.exportSelected 编排） --- */
  const E2 = await exec(`(async () => {
    const A = window.App, S = window.State;
    const rotated = window.__probe.target;                 // 此时已记住 90°
    const plain = S.items.find((m) => m !== rotated);      // 未旋转 → 应逐字节复制
    const t0 = Date.now();
    await A.exportSelected([rotated, plain]);
    return {
      rotatedName: rotated.name, plainName: plain.name,
      rotatedRel: rotated.rel, plainRel: plain.rel, plainPath: plain.path,
      rotatedRot: S.rotationOf(rotated), plainRot: S.rotationOf(plain),
      exporting: !!A._exporting,            // 结束后必须复位，否则后续导出会被自己挡住
      ms: Date.now() - t0,
    };
  })()`);

  /* --- E3. 源格式 canvas 编不出来（BMP）→ 烘焙落回 PNG，文件名必须跟着改 ---
     只看「文件能不能打开」不够：名字叫 .bmp、内容是 PNG 的文件，读字节也是能读的，
     可用户双击时系统按扩展名挑解码器，直接报「不支持」。所以这里量的是
     **文件名后缀** 与 **文件头魔数** 是否一致。 */
  const E3 = await exec(`(async () => {
    const A = window.App, S = window.State;
    const m = window.__probe.bmp;
    if (!m) return { skipped: true };
    const readLs = () => { try { return JSON.parse(localStorage.getItem('viewfinder.rot.v1') || '{}'); } catch (e) { return {}; } };
    const lsBefore = Object.keys(readLs()).length;      // 此刻目标图那条 90° 还在，所以不是 0
    S.setRotation(m, 90);
    await A.exportSelected([m]);
    const rot = S.rotationOf(m);
    S.setRotation(m, 0);                       // 收尾：别把记录留到后面的「转满一圈」断言里
    S.flushRotations();
    const ls = readLs();
    return { skipped: false, name: m.name, ext: m.ext, rot: rot,
             bmpRotAfter: S.rotationOf(m), lsBefore: lsBefore, lsKeys: Object.keys(ls).length,
             leaked: Object.keys(ls).some((k) => k.indexOf('竖幅-06') >= 0) };
  })()`);

  /* --- 转满一圈回到 0° → 记录应被删除 --- */
  await exec(`(() => { const L = window.Lightbox; L.open(window.State.viewList(), window.__probe.target); return 1; })()`);
  await waitFor('window.Lightbox.nw > 0', 8000);
  const F1 = await exec(`(() => {
    const L = window.Lightbox; for (let i = 0; i < 3; i++) L.rotate(1);   // 90 → 180 → 270 → 0
    window.State.flushRotations();                                        // 立刻落盘，绕开 400ms 合并写
    let ls = null; try { ls = JSON.parse(localStorage.getItem('viewfinder.rot.v1') || '{}'); } catch (e) {}
    return { lbRot: L.rot, stateRot: window.State.rotationOf(window.__probe.target), lsKeys: Object.keys(ls || {}).length };
  })()`);
  // 再设成 180° 后按 Z（resetRot）清掉
  const F2 = await exec(`(() => {
    const L = window.Lightbox;
    L.rotate(1); L.rotate(1);                       // → 180
    const mid = window.State.rotationOf(window.__probe.target);
    L.resetRot();
    window.State.flushRotations();
    let ls = null; try { ls = JSON.parse(localStorage.getItem('viewfinder.rot.v1') || '{}'); } catch (e) {}
    return { mid: mid, after: window.State.rotationOf(window.__probe.target), lbRot: L.rot, lsKeys: Object.keys(ls || {}).length };
  })()`);

  /* --- 留下一笔记录（90°）后重新载入，验证「重开一致」 --- */
  await exec(`(() => { const L = window.Lightbox; L.rotate(1); return window.State.rotationOf(window.__probe.target); })()`);
  await wait(300);
  const beforeReload = await exec(`(() => {
    window.State.flushRotations();
    let ls = null; try { ls = JSON.parse(localStorage.getItem('viewfinder.rot.v1') || '{}'); } catch (e) {}
    return { stateRot: window.State.rotationOf(window.__probe.target), ls: ls };
  })()`);

  await w.loadURL('vf://app/index.html');       // 等价「重新打开应用」
  await wait(1000);
  const G0 = await exec(`(() => ({ count: window.State.rotationCount, lsKey: localStorage.getItem('viewfinder.rot.v1') }))()`);
  await exec(INJECT(recs));
  await wait(1500);
  const G1 = await exec(`(() => ({ stateRot: window.State.rotationOf(window.__probe.target) }))()`);
  await exec(`(() => { const L = window.Lightbox; L.open(window.State.viewList(), window.__probe.target); return 1; })()`);
  await waitFor('window.Lightbox.nw > 0', 8000);
  const G2 = await exec(`(() => ({ lbRot: window.Lightbox.rot, tf: getComputedStyle(window.Lightbox.img).transform }))()`);
  const G3 = await exec(`(() => {
    const g = window.Grid;
    for (const [, e] of g.els) if (e && e._item && e._item.path === window.__probe.target.path)
      return { r90: e.classList.contains('r90') };
    return { r90: null };
  })()`);

  const shot = await w.webContents.capturePage({ x: 0, y: 0, width: 1400, height: 700 });
  fs.writeFileSync(path.join(OUT, 'rot-persist.png'), shot.toPNG());

  /* --- 落盘结果：文件名后缀 vs 文件头魔数 --- */
  const BAKE = { skipped: !E3 || !!E3.skipped, hit: [], out: null, magic: null, stray: [], dim: null };
  if (!BAKE.skipped) {
    BAKE.hit = fs.readdirSync(EXPORT_DIR).filter((n) => n.indexOf('竖幅-06') === 0);
    BAKE.stray = BAKE.hit.filter((n) => /\.bmp$/i.test(n));         // 沿用原名 = 错
    BAKE.out = BAKE.hit.filter((n) => /\.png$/i.test(n))[0] || null;
    if (BAKE.out) {
      const b = fs.readFileSync(path.join(EXPORT_DIR, BAKE.out));
      BAKE.magic = b.slice(1, 4).toString('ascii') === 'PNG' ? 'png'
        : (b[0] === 0xFF && b[1] === 0xD8 ? 'jpeg' : 'other');
      if (BAKE.magic === 'png' && b.length > 24) BAKE.dim = { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    }
  }

  console.log('RP ' + JSON.stringify({
    exportDir: EXPORT_DIR,
    portrait: { name: path.basename(portrait.abs), path: portrait.abs, size: portrait.size },
    A: A, B0: B0, gotNw: gotNw, B1: B1, C: C, D: D, E: E, E2: E2, E3: E3, BAKE: BAKE,
    F1: F1, F2: F2, beforeReload: beforeReload,
    G: { G0: G0, G1: G1, G2: G2, G3: G3 },
  }));
  console.log('DONE');
  app.quit();
}).catch((e) => { console.error('ERR', (e && e.stack) || e); app.quit(); });
