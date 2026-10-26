/* 瀑布流排列模式探针（v1.12.0）。
   目的：验证「设置面板里的『排列模式』」真的把图库换了一种排法 ——
   断言落在**结果**（几何真的变了 / 不重叠 / 列宽相等 / 高度不等）而不是
   「控件存在」。同时验证设置项与顶栏图标是同一个状态的双向入口。

   只输出原始测量（MASONRY 一行 JSON），判定集中在 run_all.js ——
   避免「探针自己判自己」。

   测量内容：
     A) 面板点「中图」→ 基线几何（等高网格）
     B) 面板点「瀑布流」→ 几何变了没 / 列数 / 列宽是否唯一 / 高度是否不等 / 是否重叠
        + Grid 的两条坐标不变量（y 单调、yMax 单调且等于前缀最大底边、y+h 不单调）
     C) 窗口变窄 → 列数应变少且仍不重叠
     D) 顶栏点「单列」→ 设置面板的选中项是否跟着变（反向同步）
   用法: electron.exe probe_masonry.js  (cwd = deploy/electron) */
const { app, BrowserWindow, protocol, ipcMain } = require('electron');

/* 桌面集成通道桩：缺了它 App.init() 的托盘/快捷键设置重放会"假失败" —— 详见 _desktop_stub.js */
require('./_desktop_stub').stubDesktop();
/* 窗口置顶 / 屏幕清单也要补桩：App.init() 启动时会拉，缺了会让探针变成"不完整宿主"
   —— invoke reject 被 .catch 吞掉，上层判"没生效"，并留下一条 console.warn 假报错。 */
require('./_desktop_stub').stubWindowChannels();
const path = require('path'); const fs = require('fs');
const APPDIR = path.resolve(__dirname, '..', '..', '..');
const OUT = path.resolve(__dirname, '..', 'shots');
const PICDIR = path.join(__dirname, '..', 'fixtures', '照片夹');

app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
protocol.registerSchemesAsPrivileged([{ scheme: 'vf', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true } }]);
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png', '.jpg':'image/jpeg', '.gif':'image/gif' };

// 静音原生通道（探针不触及真实回收站/目录选择）
for (const ch of ['vf:trashLog','vf:autoDir','vf:pickDirs','vf:restoreFile','vf:restoreFiles','vf:trashForget','vf:trashClear','vf:pickFolder']) {
  ipcMain.handle(ch, () => (ch === 'vf:trashLog' || ch === 'vf:pickDirs' ? [] : null));
}
ipcMain.handle('vf:loadDir', () => ({ ok: false, files: [] }));

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

/* 抓取一次快照：DOM 实测几何 + Grid 的权威布局数组 + 两个入口的选中态。
   注意：模板字符串里不能出现反引号（会截断注入脚本），这里全程用单引号拼接。 */
const GRAB = [
  '(function () {',
  '  var S = window.State, G = window.Grid, St = window.Settings;',
  '  var tiles = [].slice.call(document.querySelectorAll(".tile"));',
  '  var items = tiles.map(function (t) {',
  '    var c = getComputedStyle(t);',
  '    var m = new DOMMatrixReadOnly(c.transform === "none" ? "" : c.transform);',
  '    return { l: Math.round(m.e * 100) / 100, tp: Math.round(m.f * 100) / 100,',
  '             w: parseFloat(t.style.width) || 0, h: parseFloat(t.style.height) || 0 };',
  '  });',
  '  var pos = (G.positions || []).map(function (p) { return p ? { y: p.y, h: p.h } : null; });',
  '  var topbar = document.querySelector("#modeSeg .seg-btn.is-on");',
  '  var seg = null;',
  '  var row = St && St._rows && St._rows.mode;',
  '  if (row && row.el) {',
  '    var on = [].slice.call(row.el.children).filter(function (b) { return b.classList.contains("is-on"); });',
  '    seg = on.length === 1 ? on[0].dataset.val : (on.length === 0 ? "none" : "multi");',
  '  }',
  '  var stage = document.getElementById("stage");',
  '  return JSON.stringify({',
  '    mode: S.settings.mode,',
  '    stageW: stage ? stage.clientWidth : 0,',
  '    tiles: items, pos: pos,',
  '    yMax: G.yMax ? G.yMax.slice() : null,',
  '    cols: G.cols || 0, colW: Math.round((G.colW || 0) * 100) / 100,',
  '    totalH: Math.round(G.totalH || 0),',
  '    topbarOn: topbar ? topbar.dataset.mode : null,',
  '    segOn: seg,',
  '    segButtons: row && row.el ? row.el.children.length : 0,',
  '  });',
  '})()',
].join('\n');

/* DOM 实测几何 → 重叠 / 零尺寸 / 列数 / 宽度与高度的唯一值个数 */
function geo(snap) {
  const t = snap.tiles;
  let zero = 0, overlap = 0, worst = 0;
  for (let i = 0; i < t.length; i++) {
    if (!(t[i].w > 4 && t[i].h > 4)) zero++;
    for (let j = i + 1; j < t.length; j++) {
      const ox = Math.min(t[i].l + t[i].w, t[j].l + t[j].w) - Math.max(t[i].l, t[j].l);
      const oy = Math.min(t[i].tp + t[i].h, t[j].tp + t[j].h) - Math.max(t[i].tp, t[j].tp);
      if (ox > 0.6 && oy > 0.6) { overlap++; if (Math.min(ox, oy) > worst) worst = Math.min(ox, oy); }
    }
  }
  const L = {}, W = {}, H = {};
  for (const x of t) { L[Math.round(x.l)] = 1; W[Math.round(x.w)] = 1; H[Math.round(x.h)] = 1; }
  return {
    tiles: t.length, zero: zero, overlap: overlap, worstOverlap: +worst.toFixed(2),
    colXCount: Object.keys(L).length,
    uniqW: Object.keys(W).length,
    uniqH: Object.keys(H).length,
  };
}

/* Grid 的两条坐标不变量（瀑布流特有的风险点，见 js/masonry.js 顶部说明） */
function invariants(snap) {
  const p = snap.pos, ym = snap.yMax;
  let yMono = true, yPlusHNotMono = false, run = -Infinity;
  let yMaxMono = true, yMaxOk = true;
  for (let i = 0; i < p.length; i++) {
    if (!p[i]) return { ok: false };
    if (i && p[i].y < p[i - 1].y - 1e-6) yMono = false;
    const b = p[i].y + p[i].h;
    if (i && b < p[i - 1].y + p[i - 1].h - 1e-6) yPlusHNotMono = true;
    run = Math.max(run, b);
  }
  if (!ym || ym.length !== p.length) return { ok: false };
  for (let i = 0; i < ym.length; i++) {
    if (i && ym[i] < ym[i - 1] - 1e-6) yMaxMono = false;
    const b = p[i].y + p[i].h;
    if (Math.abs(ym[i] - Math.max(b, i ? ym[i - 1] : -Infinity)) > 1e-6) yMaxOk = false;
  }
  return { ok: true, yMono: yMono, yPlusHNotMono: yPlusHNotMono, yMaxMono: yMaxMono, yMaxOk: yMaxOk };
}

app.whenReady().then(async () => {
  protocol.handle('vf', async (req) => {
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
  });

  const w = new BrowserWindow({ width: 1500, height: 860, show: true,
    webPreferences: { preload: path.join(APPDIR, 'deploy', 'electron', 'preload.js'), contextIsolation: true } });
  const pageErrs = [];
  w.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) { pageErrs.push(msg); console.log('PAGE-ERR ' + msg); } });
  await w.loadURL('vf://app/index.html');
  await new Promise((r) => setTimeout(r, 900));

  const grab = () => w.webContents.executeJavaScript(GRAB).then(JSON.parse);

  // 多份复制以填满多列（7 张原图 × 5 = 35 张：含 0.67 竖图与 1.00 方图，能逼出不等高）
  const base = collect(PICDIR, PICDIR);
  const files = [];
  for (let rep = 0; rep < 5; rep++) {
    for (const f of base) files.push({ p: f.abs, n: (rep ? rep + '_' : '') + path.basename(f.abs), rel: f.rel, size: f.size, mtime: f.mtime });
  }

  await w.webContents.executeJavaScript([
    '(function () {',
    '  var S = window.State, A = window.App;',
    '  var recs = ' + JSON.stringify(files.map((f) => ({ p: f.p, n: f.n, rel: f.rel, size: f.size, mtime: f.mtime }))) + ';',
    '  S.sources = [{ id: "s0", name: "照片夹", root: "C:/Users/me/Pictures/照片夹" }];',
    '  S.items = recs.map(function (r, i) {',
    '    return { id: "r" + i, name: r.n, src: "all", sid: "s0", size: r.size, path: r.p, rel: r.rel,',
    '             ext: r.n.split(".").pop().toLowerCase(), lastModified: r.mtime, state: "idle" };',
    '  });',
    '  A.showGallery(); A.renderSources();',
    '  document.getElementById("topbar").hidden = false;',
    '  window.Settings.toggle(true);',
    '  return S.items.length;',
    '})()',
  ].join('\n'));
  await new Promise((r) => setTimeout(r, 2200));

  // 打开面板后，点某个排列模式的按钮（走真实的设置面板通路）
  const clickPanel = (val) => w.webContents.executeJavaScript([
    '(function () {',
    '  var row = window.Settings._rows.mode;',
    '  if (!row || !row.el) return "no-row";',
    '  var b = [].slice.call(row.el.children).filter(function (x) { return x.dataset.val === ' + JSON.stringify(val) + '; })[0];',
    '  if (!b) return "no-btn";',
    '  b.click();',
    '  return "ok";',
    '})()',
  ].join('\n'));

  // A) 基线：面板点「中图」
  const clickA = await clickPanel('medium');
  await new Promise((r) => setTimeout(r, 1400));
  const snapA = await grab();

  // B) 面板点「瀑布流」—— 这一步是本次功能的核心：设置项必须真的换排法
  const clickB = await clickPanel('masonry');
  await new Promise((r) => setTimeout(r, 1600));
  const snapB = await grab();
  const invB = invariants(snapB);
  const shotB = await w.webContents.capturePage({ x: 0, y: 0, width: 1180, height: 640 });
  fs.writeFileSync(path.join(OUT, 'masonry-wide.png'), shotB.toPNG());

  // C) 窗口变窄：列数应变少，且仍不重叠
  await w.setContentSize(760, 800);
  await new Promise((r) => setTimeout(r, 1400));
  const snapC = await grab();
  const shotC = await w.webContents.capturePage({ x: 0, y: 0, width: 740, height: 600 });
  fs.writeFileSync(path.join(OUT, 'masonry-narrow.png'), shotC.toPNG());

  // D) 反向路径：关掉面板 → 点顶栏「单列」→ 模式与顶栏高亮都要变；
  //    再把面板打开，面板选中项应显示 single。
  //    （面板是浮层，点顶栏时它本来就不该开着 —— 所以面板侧只能按"重开时刷新"来验，
  //      不去断言"关着的面板 DOM 被提前改好"这种实现细节。）
  await w.webContents.executeJavaScript('window.Settings.toggle(false);');
  await new Promise((r) => setTimeout(r, 300));
  const topbarClick = await w.webContents.executeJavaScript([
    '(function () {',
    '  var b = document.querySelector("#modeSeg .seg-btn[data-mode=single]");',
    '  if (!b) return "no-btn";',
    '  b.click();',
    '  return "ok";',
    '})()',
  ].join('\n'));
  await new Promise((r) => setTimeout(r, 1400));
  const snapD = await grab();                      // 面板关着：读模式 + 顶栏高亮
  await w.webContents.executeJavaScript('window.Settings.toggle(true);');
  await new Promise((r) => setTimeout(r, 600));
  const snapD2 = await grab();                     // 面板打开：sync() 之后应显示 single
  await w.webContents.executeJavaScript('window.Settings.toggle(false);');

  // 收尾：还原设置的默认值（探针共用同一 partition，别把改动留给别的探针）
  const restored = await w.webContents.executeJavaScript([
    '(function () {',
    '  var d = window.State.defaults;',
    '  window.State.setSetting("mode", d.mode);',
    '  if (window.App.applySetting) window.App.applySetting("mode", d.mode);',
    '  return window.State.settings.mode;',
    '})()',
  ].join('\n'));
  const defaultMode = await w.webContents.executeJavaScript('window.State.defaults.mode');

  const changed =
    snapA.tiles.length !== snapB.tiles.length ||
    snapB.tiles.some((t, i) => {
      const a = snapA.tiles[i];
      return !a || Math.abs(a.l - t.l) > 1 || Math.abs(a.tp - t.tp) > 1 || Math.abs(a.w - t.w) > 1 || Math.abs(a.h - t.h) > 1;
    });

  console.log('MASONRY ' + JSON.stringify({
    files: files.length,
    clickA: clickA, clickB: clickB, topbarClick: topbarClick,
    modeA: snapA.mode, modeB: snapB.mode, modeD: snapD.mode,
    gridA: geo(snapA),
    masB: geo(snapB),
    invB: invB,
    masC: geo(snapC),
    colsB: snapB.cols, colWB: snapB.colW, totalHB: snapB.totalH, stageWB: snapB.stageW,
    colsC: snapC.cols, stageWC: snapC.stageW,
    colWFills: snapB.cols * snapB.colW + (snapB.cols - 1) * 12,
    topbarOnB: snapB.topbarOn, segOnB: snapB.segOn,
    topbarOnD: snapD.topbarOn, segOnD: snapD2.segOn, segButtons: snapB.segButtons,
    changed: changed,
    restored: restored,
    defaultMode: defaultMode,
    pageErrs: pageErrs.slice(0, 5),
  }));
  console.log('DONE');
  app.quit();
}).catch((e) => { console.error('ERR', (e && e.stack) || e); app.quit(); });
