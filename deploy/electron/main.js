/* ============================================================
   Atrium · Electron 主进程
   - 独立桌面窗口（无地址栏；应用菜单由 desktop.js 装配）
   - vf:// 特权协议：vf://app/*  应用资源；vf://pic/<b64> 磁盘图片流式读取
   - 记住“上次浏览的目录”，启动即自动打开（userData/last-dir.json）
   - IPC：pickFolder / loadDir / autoDir / setLastDir / readHead
         deleteFile / restoreFile（回收站还原=撤销删除） / trashLog / trashForget / trashClear / openRecycleBin
         checkUpdate（打 GitHub 公开接口）/ openExternal（**白名单**放行官方仓库链接）
   - 桌面集成（desktop.js）：应用菜单 / 原生右键菜单 / 系统托盘 /
         Windows 任务栏（JumpList · 缩略图按钮 · 进度条） / 全局快捷键
   运行前提：Win10/11（目标机无需任何安装，直接跑本目录里的 exe）
   ============================================================ */
'use strict';
const { app, BrowserWindow, dialog, ipcMain, net, protocol, screen, session, shell } = require('electron');
const path = require('path');
const fsx = require('fs');
const exportLib = require('./exportlib.js');   // 导出落盘（与回归探针共用）
const updateLib = require('./updatelib.js');   // 更新检测的纯逻辑（版本比较 / URL 白名单）
const trashLib = require('./trashlib.js');     // 回收站 $I 解析与匹配判据（纯逻辑，可单测）
const pathAuth = require('./pathauth.js');     // vf://pic 的读盘授权（纯逻辑，可单测）
const crashLib = require('./crashlib.js');     // 崩溃兜底页的 HTML（纯逻辑，可单测）
const { createDesktop } = require('./desktop.js');   // 桌面集成（菜单/托盘/任务栏）
const fs = fsx.promises;

/* 启动追踪（诊断用）：VF_TRACE=<文件> 时逐阶段追加 */
const trace = (s) => {
  if (process.env.VF_TRACE) {
    try { fsx.appendFileSync(process.env.VF_TRACE, new Date().toISOString() + ' ' + s + '\n'); } catch (e) { /* 忽略 */ }
  }
};
trace('main-load');

/* ---------- 顶层：协议特权必须在 app ready 前注册 ----------
   **没有 bypassCSP**：它会让 vf:// 下的资源无视文档里的 CSP，等于把 CSP 关掉。
   CSP 写在 index.html 的 <meta> 里（见那里的注释），这里只负责让 vf:// 具备
   standard / secure 语义，好让 'self' 与 vf: 在策略里有确定含义。

   **必须有 corsEnabled**：缩略图要走 fetch 拿 Blob（"解码即降采样"）才能省内存，
   而 vf://app 与 vf://pic 是两个源。Electron 33 里跨源 fetch 自定义协议不受 CORS
   约束，**Electron 45（Chromium 140+）改了**：不在 CORS 允许列表里的协议一律
   拒绝 —— 报错是 `Cross origin requests are only supported for protocol schemes:
   chrome, chrome-extension, chrome-untrusted, data, http, https`。
   症状极具迷惑性：页面不报错、只是**所有缩略图都不出现**，网格退化成空瓦片。
   加上它之后，vf://pic 的响应必须带匹配的 Access-Control-Allow-Origin（见 handleVf）。 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'vf',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

const APPDIR = __dirname;                       // resources/app（index.html 所在）
const IMG_EXT = new Set(['jpg','jpeg','png','gif','webp','bmp','avif','svg','ico','tif','tiff','heic','heif','jfif']);

/* Windows 任务栏身份（AppUserModelID）。
   不设置时，Windows 会按 exe 的**路径**给窗口归组：把应用固定到任务栏、
   或从跳转列表/通知回到本应用时，身份可能落到 Electron 默认值上，
   出现"图标不一致 / 归错组"这类只有 Windows 才有的毛病。
   必须在创建任何 BrowserWindow 之前设置 —— 所以放在模块顶层（早于 app.whenReady）。 */
if (process.platform === 'win32') app.setAppUserModelId('com.atrium.app');
const argv = process.argv;
const SELFTEST = argv.includes('--selftest');
const extOf = (n) => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; };

/* ============================================================
   应用数据目录：放在「应用本体所在目录」的 data/ 下（便携化）
   ------------------------------------------------------------
   为什么改：默认 userData 是 %APPDATA%\<productName>，于是"解压即用"的便携包
   会把设置/收藏/旋转记录/缩略图缓存散落到用户目录里 —— 换台机器或换目录就"丢配置"。
   放到 exe 旁边的 data/ 之后，整个应用目录就是自包含的：拷走即带走全部数据。

   ⚠️ 这里承载的不只是我们的 JSON（trash-log.json / last-dir.json），
      还有 Chromium 自己写进 userData 的 **Local Storage 与 IndexedDB** ——
      渲染层的 localStorage（设置/收藏/旋转记录）与 IDB（尺寸库/缩略图缓存）
      都在里面。所以**必须整体迁移 userData 这一个路径**，不能只搬我们自己的文件，
      否则「换目录后设置凭空消失」。

   两条纪律：
   ① **VF_USERDATA 优先级最高** —— 探针与 --selftest 靠它把数据指到临时目录，
      绝不能反过来被这里覆盖（那会让回归污染真实数据）。
   ② 目录不可写（例如被装到 C:\Program Files\）时**回落到系统默认**并留痕，
      不要因为建不出目录就让应用起不来。
   ============================================================ */
if (process.env.VF_USERDATA) {
  app.setPath('userData', process.env.VF_USERDATA);
} else {
  try {
    /* 打包后 = exe 所在目录；开发时 = 项目根。
       用 process.execPath 而不是 app.getPath('exe')：前者是纯 Node 属性，
       在 ready 之前必定可用，而 userData 必须尽早定下来。 */
    const base = app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '..', '..');
    const dataDir = path.join(base, 'data');
    fsx.mkdirSync(dataDir, { recursive: true });
    app.setPath('userData', dataDir);
  } catch (e) {
    console.warn('[main] 无法在应用目录下创建 data/，回落到系统默认数据目录：' + ((e && e.message) || e));
  }
}

let mainWin = null;

/* ---------- 桌面集成：菜单 / 托盘 / 任务栏 / 全局快捷键 ----------
   访问器用闭包读 mainWin/frameWin，所以装配时它们还是 null 也不影响
   （真正的调用都发生在 app ready 之后）。装配点刻意放在窗口创建之前：
   应用菜单必须在第一个窗口出现前设置好，否则会先闪一下 Electron 默认菜单。 */
let quitting = false;

/* 命令投递：渲染层还没加载完时先排队。
   JumpList 任务（--open-dialog）会让第一个进程在"页面还没 boot"时就想开对话框，
   直接 send 会丢消息 —— 那不是"点了没反应"的小事，是那条 JumpList 直接废掉。 */
const pendingCmds = [];
function sendCommand(cmd) {
  if (!cmd) return;
  const win = (mainWin && !mainWin.isDestroyed()) ? mainWin : null;
  if (!win || win.webContents.isLoading()) { pendingCmds.push(cmd); return; }
  try { win.webContents.send('vf:cmd', cmd); } catch (e) { pendingCmds.push(cmd); }
}
function flushCommands() {
  const win = (mainWin && !mainWin.isDestroyed()) ? mainWin : null;
  if (!win || win.webContents.isLoading()) return;
  while (pendingCmds.length) {
    const c = pendingCmds.shift();
    try { win.webContents.send('vf:cmd', c); } catch (e) { pendingCmds.unshift(c); break; }
  }
}

/* 相框窗口（v1.8.0）—— 见下方 wireFrameIpc / ensureFrameWindow */
const FRAME_MIN_W = 260;
const FRAME_MIN_H = 170;
const FRAME_BG = '#08080a';
let frameWin = null;
let framePayload = { ms: 6000, fit: 'contain', items: [] };
let framePainted = null;
/* 自检专用：截图目录 + 控制台错误收集器（相框窗口的报错也要算进来） */
const SHOTDIR = process.env.VF_SHOTDIR || '';
let consoleSink = null;

/* 桌面集成实例。放在这里（frameWin 已声明之后）而不是文件更上方：
   createDesktop 的访问器闭包会在运行期读 frameWin，声明顺序摆正了，
   以后有人把访问器改成"装配时就取一次"也不会踩 TDZ。 */
const desktop = createDesktop({
  getMainWin: () => (mainWin && !mainWin.isDestroyed()) ? mainWin : null,
  getFrameWin: () => (frameWin && !frameWin.isDestroyed()) ? frameWin : null,
  send: (cmd) => sendCommand(cmd),
  isQuitting: () => quitting,
  setQuitting: (v) => { quitting = !!v; },
  log: (m) => { trace(m); console.log(m); },
});

/** IPC 事件对应的窗口（置顶、相框都按「调用方窗口」生效，而不是一律主窗口） */
function winOf(e) {
  try {
    const wc = e && e.sender;
    return wc ? BrowserWindow.fromWebContents(wc) : null;
  } catch (err) { return null; }
}

/* ============================================================
   删除日志 + 回收站还原（撤销删除的底座）
   - 删除一律走系统回收站（shell.trashItem），绝不永久删除
   - 撤销 = 在回收站里按「原路径 + 大小 + 删除时刻」定位 $I/$R 对，把 $R 搬回原处
   - 删除记录持久化在 userData/trash-log.json，跨次启动仍可撤销
   ============================================================ */
const TRASH_MAX = 200;

function trashFile() { return path.join(app.getPath('userData'), 'trash-log.json'); }
async function readTrashLog() {
  try {
    const j = JSON.parse(await fs.readFile(trashFile(), 'utf8'));
    return (j && Array.isArray(j.items)) ? j.items : [];
  } catch (e) { return []; }
}
/** 原子写：先写 .tmp 再 rename。半截的 JSON 会让下次启动读不出整份删除日志
 *  （撤销历史全丢），而"写了一半"恰恰是断电/崩溃时最常见的结果。
 *  失败时**抛错**，由 trashAdd 转成结果 —— 静默吞掉会让"文件已进回收站、
 *  但撤销记录没写进去"变成一个用户完全看不见的状态。 */
async function writeTrashLog(items) {
  const f = trashFile();
  const tmp = f + '.tmp';
  await fs.writeFile(tmp, JSON.stringify({ v: 1, items }), 'utf8');
  await fs.rename(tmp, f);
}
/** 追加一条删除记录。返回 { ok } | { ok:false, message }，不抛。 */
async function trashAdd(rec) {
  try {
    const items = await readTrashLog();
    items.unshift(rec);
    await writeTrashLog(items.slice(0, TRASH_MAX));
    return { ok: true };
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
}
async function trashDrop(id) {
  try {
    const items = await readTrashLog();
    const next = items.filter((r) => !r || r.id !== id);
    if (next.length !== items.length) await writeTrashLog(next);
    return true;
  } catch (e) { return false; }
}

/* ---- $I 元数据解析（Win10+ v2 / 老版 v1）----
   字节布局与"安全整数"校验都在 trashlib.js 里（纯函数，可单测）；
   这里只负责读文件。 */
function parseTrashInfo(file) {
  try { return trashLib.parseTrashInfoBuf(fsx.readFileSync(file)); }
  catch (e) { return null; }
}

/** 在回收站里定位刚被删除的文件：匹配原路径（+大小+删除时刻），同一路径取最新一条
 *  sizeHint / afterMs 由 trashLib.hintsOf 校验过，0 表示"不限制" */
async function findTrashed(origPath, sizeHint, afterMs) {
  const rb = path.join(path.parse(origPath).root, '$Recycle.Bin');
  let sids = [];
  try { sids = await fs.readdir(rb); } catch (e) { return null; }
  const want = String(origPath).toLowerCase();
  const hits = [];
  for (const sid of sids) {
    if (sid === 'desktop.ini') continue;
    let ents = [];
    try { ents = await fs.readdir(path.join(rb, sid)); } catch (e) { continue; }
    for (const n of ents) {
      if (!trashLib.isInfoName(n)) continue; // 只看 $I…
      const rec = parseTrashInfo(path.join(rb, sid, n));
      if (!trashLib.matchRecord(rec, want, sizeHint, afterMs)) continue;
      const rFile = path.join(rb, sid, trashLib.rNameOf(n));
      let isFile = false;
      try { isFile = fsx.statSync(rFile).isFile(); } catch (e) { isFile = false; }
      if (!isFile) continue;
      hits.push({ ms: rec.ms, size: rec.size, rFile, iFile: path.join(rb, sid, n) });
    }
  }
  return trashLib.pickNewest(hits);
}

/** 从回收站还原：把 $R 搬回原路径并清掉 $I/$R；返回 {ok,size?,reason?} */
async function restoreFromTrash(origPath, sizeHint, afterMs) {
  if (!origPath || typeof origPath !== 'string') return { ok: false, reason: 'bad-path' };
  const hit = await findTrashed(origPath, sizeHint, afterMs);
  if (!hit) return { ok: false, reason: 'not-found' };
  try {
    const st = await fs.stat(origPath);
    if (st) return { ok: false, reason: 'occupied' }; // 原位置已被同名文件占用，避免覆盖
  } catch (e) { /* 不存在才允许还原 */ }
  try { await fs.mkdir(path.dirname(origPath), { recursive: true }); } catch (e) { /* 已存在则忽略 */ }
  try {
    await fs.rename(hit.rFile, origPath);
  } catch (err) {
    /* 跨卷（EXDEV）或权限受限（EPERM/EACCES）时退回复制+删除。
       注意原来这里写了两次 EXDEV（复制粘贴留下的），等于漏了 EACCES 的语义检查。 */
    if (err && (err.code === 'EXDEV' || err.code === 'EPERM' || err.code === 'EACCES')) {
      await fs.copyFile(hit.rFile, origPath);
      await fs.unlink(hit.rFile).catch(() => {});
    } else {
      return { ok: false, reason: 'failed', message: String((err && err.message) || err) };
    }
  }
  await fs.unlink(hit.iFile).catch(() => {});
  const st2 = await fs.stat(origPath).catch(() => null);
  if (!st2 || !st2.isFile()) return { ok: false, reason: 'verify-failed' };
  return { ok: true, size: st2.size };
}

/* ---------- 上次目录记忆 ---------- */
function lastFile() { return path.join(app.getPath('userData'), 'last-dir.json'); }
async function readLast() {
  try { const j = JSON.parse(await fs.readFile(lastFile(), 'utf8')); return (j && j.dir) ? j.dir : null; }
  catch (e) { return null; }
}
async function writeLast(dir) {
  try { await fs.writeFile(lastFile(), JSON.stringify({ dir, ts: Date.now() }), 'utf8'); } catch (e) { /* 忽略 */ }
}

/* ---------- 递归列目录（并发有界，只收集图片元数据，绝不复制内容） ---------- */
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

async function listImages(root) {
  const files = [];
  const items = [{ kind: 'dir', d: root, rel: '' }];
  await runPool(files, items);
  files.sort((a, b) => collator.compare(a.rel, b.rel));
  return files;
}

function runPool(files, items) {
  return new Promise((resolve) => {
    let i = 0, act = 0, settled = false;
    const tick = () => {
      if (settled) return;
      while (act < 24 && i < items.length) {
        const it = items[i++];
        act++;
        Promise.resolve()
          .then(() => scanOne(it, items, files))
          .catch(() => {})
          .finally(() => { act--; tick(); });
      }
      if (act === 0 && i >= items.length && !settled) { settled = true; resolve(); }
    };
    tick();
  });
}

async function scanOne(it, items, files) {
  if (it.kind === 'file') {
    try {
      const st = await fs.stat(it.d);
      files.push({ name: it.name, rel: it.rel, path: it.d, size: st.size, mtime: Math.round(st.mtimeMs) });
    } catch (e) { /* 单个文件失败跳过 */ }
    return;
  }
  let ents = [];
  try { ents = await fs.readdir(it.d, { withFileTypes: true }); } catch (e) { return; }
  for (const en of ents) {
    if (en.isDirectory()) {
      items.push({ kind: 'dir', d: path.join(it.d, en.name), rel: it.rel + en.name + '/' });
    } else if (en.isFile() && IMG_EXT.has(extOf(en.name))) {
      items.push({ kind: 'file', d: path.join(it.d, en.name), rel: it.rel + en.name, name: en.name });
    }
  }
}

/* ---------- vf:// 协议：应用资源 + 图片流 ---------- */
/* 允许 vf://pic 读取的根目录。只有用户真正打开过的目录会被登记进来
   （见 vf:loadDir）。空清单 = 一个都不许读，默认拒绝。 */
const picAuth = pathAuth.createAllowlist();

/* 允许**写入**（导出落盘）的目录。只有用户通过原生「选择导出位置」对话框
   真的选过的目录会进来（见 vf:pickExportDir）。
   为什么写盘也要授权：`vf:exportFiles` 的 dir 是渲染层传上来的，不校验就等于
   给了一个"往任意路径写文件"的能力 —— 比读更糟。而导出的目标本来就只有一个
   来源：那个原生对话框。所以"只认对话框选过的目录"既不损失任何功能，
   又把能力收窄到"用户亲手点过的地方"。 */
const exportAuth = pathAuth.createAllowlist();

function toResponse(resp, status) {
  return resp && resp.ok ? resp : new Response(null, { status: status || 404 });
}
async function handleVf(req) {
  try {
    const u = new URL(req.url);
    if (u.host === 'app') {
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      const abs = path.resolve(APPDIR, rel || 'index.html');
      const ok = abs === APPDIR || abs.startsWith(APPDIR + path.sep);
      if (!ok) return new Response('forbidden', { status: 403 });
      try { await fs.access(abs); } catch (e) { return new Response('not found', { status: 404 }); }
      return net.fetch(pathToFileURL(abs).toString());
    }
    if (u.host === 'pic') {
      const b64 = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      const abs = Buffer.from(b64, 'base64url').toString('utf8');
      if (!abs) return new Response('bad', { status: 400 });
      /* 授权检查必须在 stat 之前：不能靠"文件存不存在"来泄露信息，
         也不能让未授权路径的 stat 成为探测手段。 */
      if (!picAuth.has(abs)) {
        trace('pic-deny ' + abs);
        return new Response('forbidden', { status: 403 });
      }
      try { const st = await fs.stat(abs); if (!st.isFile()) return new Response('not found', { status: 404 }); }
      catch (e) { return new Response('not found', { status: 404 }); }
      const resp = await net.fetch(pathToFileURL(abs).toString());
      /* 渲染进程要用 fetch 把图片读成 Blob 才能走「解码即降采样」，
         而 vf://app 与 vf://pic 是两个源，跨源取必须显式放行。
         **只放行 vf://app 这一个源**（原来是 `*`：任何源都能读回图片字节，
         配合"读任意路径"就是一个跨源任意文件读取）。 */
      const h = new Headers(resp.headers);
      h.set('Access-Control-Allow-Origin', 'vf://app');
      h.set('Cache-Control', 'no-store');
      return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
    }
    return new Response('unknown host', { status: 404 });
  } catch (e) {
    return new Response('error', { status: 500 });
  }
}
const { pathToFileURL } = require('url');

/* ============================================================
   IPC 发送方校验（默认拒绝）
   ------------------------------------------------------------
   渲染进程是 sandbox + contextIsolation，但 preload 把一批"能读盘 / 能删文件 /
   能改设置"的能力挂在了 window.vfNative 上。通道本身分不清"是应用在调"还是
   "是注入进页面的脚本在调" —— 只要页面里有一处 HTML 注入，那些通道就全都在
   攻击者手里了。

   所以每条通道都加一道来源校验：只接受**本进程创建的窗口**，且该窗口当前
   文档在 vf://app/ 之下。校验一次性包住所有注册（含 desktop.js 的），
   这样以后新增通道不会因为"忘了加 guard"而漏掉 —— 那正是最容易发生的事。
   未通过时抛错：让 invoke 走 reject，渲染层的 catch 会把它当成"没生效"，
   不会伪装成一条业务失败。
   ============================================================ */
function isTrustedSender(e) {
  try {
    const wc = e && e.sender;
    if (!wc) return false;
    const frame = e.senderFrame;
    const url = String((frame && frame.url) || (wc.getURL && wc.getURL()) || '');
    if (!/^vf:\/\/app\//.test(url)) return false;
    return BrowserWindow.getAllWindows().some((w) => w && !w.isDestroyed() && w.webContents === wc);
  } catch (err) {
    return false;
  }
}

let ipcGuardOn = false;
function installIpcGuard() {
  if (ipcGuardOn) return;
  ipcGuardOn = true;
  const deny = (ch) => {
    trace('ipc-deny ' + ch);
    throw new Error('untrusted sender: ' + ch);
  };
  const rawHandle = ipcMain.handle.bind(ipcMain);
  const rawOn = ipcMain.on.bind(ipcMain);
  ipcMain.handle = (ch, fn) => rawHandle(ch, (e, ...a) => (isTrustedSender(e) ? fn(e, ...a) : deny(ch)));
  ipcMain.on = (ch, fn) => rawOn(ch, (e, ...a) => { if (!isTrustedSender(e)) { trace('ipc-deny ' + ch); return; } fn(e, ...a); });
}

/* ---------- IPC ---------- */
function wireIpc() {
  ipcMain.handle('vf:pickFolder', async () => {
    const r = await dialog.showOpenDialog(mainWin, {
      title: '选择图片文件夹',
      buttonLabel: '打开此文件夹',
      properties: ['openDirectory'],
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });

  /* ---------- 导出（P1-4） ----------
     chooseExportDir：选一个导出目标目录（可新建）。
     exportFiles：真正的落盘逻辑在 exportlib.js（探针共用同一份实现）。
       - 有 src  → 原样复制（无损、走文件流，不塞进 IPC）
       - 无 src  → 用 dataB64 落盘（旋转烘焙后的 PNG/JPEG）
     同名自动加 “ (2)” 后缀，绝不覆盖用户已有文件。 */
  ipcMain.handle('vf:pickExportDir', async () => {
    const r = await dialog.showOpenDialog(mainWin, {
      title: '选择导出位置',
      buttonLabel: '导出到此文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths.length) return null;
    /* 授权写盘 —— 这是 exportAuth 的**唯一**入口，与"用户真的选过这个目录"
       严格对应。前端每次导出都会先弹这个对话框，所以不会误伤正常流程。 */
    exportAuth.add(r.filePaths[0]);
    return r.filePaths[0];
  });

  /* 导出落盘。两道闸门，方向不同：
     ① dir  —— 必须是通过 pickExportDir 选过的目录（写）；
     ② src  —— 必须是用户打开过的图库里的文件（读）。
     被拒的条目**逐条**回传 reason:'denied'，而不是整批失败：
     一批 100 张里混进一个不该给的路径，其余 99 张没有理由跟着失败，
     但也不能悄悄跳过 —— 用户要能看出"这张没导出"以及为什么。 */
  ipcMain.handle('vf:exportFiles', async (e, dir, list) => {
    if (!exportAuth.has(dir)) {
      trace('export-deny-dir ' + String(dir));
      return { ok: false, reason: 'denied' };
    }
    const arr = Array.isArray(list) ? list : [];
    const denied = [];
    const clean = [];
    for (const it of arr) {
      if (it && it.src && !picAuth.has(it.src)) {
        trace('export-deny-src ' + String(it.src));
        denied.push({ ok: false, name: (it && it.name) || 'image', reason: 'denied' });
        continue;
      }
      clean.push(it);
    }
    const r = await exportLib.exportFiles(dir, clean);
    if (!denied.length) return r;
    return Object.assign({}, r, { results: (r.results || []).concat(denied) });
  });

  ipcMain.handle('vf:loadDir', async (e, dir) => {
    /* 失败要带 reason：渲染层必须能区分"读不了"与"里面没图"。
       以前这里一律 `{ok:false}`，渲染层又把它和空目录压成同一分支 ——
       于是打开一个没权限 / 已删除的目录时界面毫无反应。 */
    if (!dir || typeof dir !== 'string') return { ok: false, reason: 'bad-path' };
    try {
      const st = await fs.stat(dir);
      if (!st.isDirectory()) return { ok: false, reason: 'not-dir' };
      const files = await listImages(dir);
      /* 授权 vf://pic 读这个目录 —— 这是**唯一**的授权入口，
         与"用户真的打开过这个目录"严格对应。 */
      picAuth.add(dir);
      return { ok: true, name: path.basename(dir), files };
    } catch (err) {
      return { ok: false, reason: (err && err.code) || 'read-failed' };
    }
  });

  ipcMain.handle('vf:autoDir', async () => {
    const dir = await readLast();
    if (!dir) return null;
    try { const st = await fs.stat(dir); return st.isDirectory() ? dir : null; } catch (e) { return null; }
  });

  /* 记住「上次目录」；dir 传 null / 空串表示**清除**
     （设置里关掉「记住上次位置」时用，否则下次启动照样会自动打开）。 */
  ipcMain.on('vf:setLastDir', (e, dir) => {
    writeLast(typeof dir === 'string' && dir ? dir : null);
  });

  /* 单个文件移入回收站 + 写删除日志（两条成功分支都要写，撤销才有依据）。
     rec = { name?, size?, meta? } —— meta 是条目快照，重启后也能把条目还原回图库。 */
  async function doTrashOne(p, rec) {
    if (!p || typeof p !== 'string') return { ok: false, reason: 'bad-path' };
    let size = 0;
    try {
      const st = await fs.stat(p);
      if (!st.isFile()) return { ok: false, reason: 'not-file' };
      size = st.size;
    } catch (err) {
      return { ok: false, reason: 'not-file' };
    }
    const ts = Date.now();
    const logRec = {
      id: 't' + ts.toString(36) + Math.random().toString(36).slice(2, 6),
      name: (rec && rec.name) || path.basename(p),
      /* size 用刚 stat 出来的真实值。**不要**再写 `size || ((rec && rec.size) | 0)`：
         0 字节文件会被 || 骗过去用渲染层的提示值；位运算还会把 ≥2GiB 截成负数。 */
      path: p, size, ts,
      meta: (rec && rec.meta) || null,
    };
    /* 日志写失败不能吞：文件已经进了回收站，但撤销记录没落盘 ——
       用户点"撤销"时会得到 not-found，且完全不知道为什么。所以把它
       作为 warned 带回去，由界面提示"已删除，但本次撤销记录没能保存"。 */
    const logWarn = (lg) => (lg && lg.ok ? undefined : ('log-write-failed: ' + ((lg && lg.message) || '?')));
    try {
      await shell.trashItem(p);
      const lg = await trashAdd(logRec);
      return { ok: true, mode: 'trash', ts, size, logId: logRec.id, path: p, name: logRec.name,
        warned: logWarn(lg) };
    } catch (err) {
      /* 少数 Windows 环境下 trashItem 会「文件已移走但仍报错」。此时不能一律当成
         "已删除" —— 只有**能证明文件确实不在了**才算成功，否则用户会看到"已删除"
         但文件还在原地（下次打开目录它又回来了，非常困惑）。
         能证明"不在了"的只有 ENOENT。EPERM / EACCES / EBUSY / EIO 之类只是
         "我们不知道"，一律按失败上报，让用户重试。 */
      let gone = false;
      try { await fs.stat(p); } catch (e2) { gone = !!(e2 && e2.code === 'ENOENT'); }
      if (!gone) {
        return { ok: false, reason: 'failed', path: p, message: String((err && err.message) || err) };
      }
      const lg = await trashAdd(logRec);
      return { ok: true, mode: 'trash', ts, size, logId: logRec.id, path: p, name: logRec.name,
        warned: String((err && err.message) || err) + (logWarn(lg) ? ' | ' + logWarn(lg) : '') };
    }
  }

  /* 删除单个文件：一律移入系统回收站（可恢复），绝不永久删除。
     回收站不可用（如网络盘/非 NTFS）时返回失败，由渲染层提示用户，不做静默降级。

     **只删用户打开过的图库里的文件**（picAuth）。理由：这条通道能搬走用户的文件，
     而路径是渲染层传上来的 —— 与读盘同一套授权，才能保证"能删的"不超过
     "用户亲手打开过的"。
     注意 restoreFile / trashPreview **不能**加这道闸：它们要还原/预览的是
     上一次会话删掉的文件，那时 picAuth 是空的，加了就会把"跨启动撤销"
     这个核心功能整个废掉 —— 授权范围要跟着"能力方向"走，不能一刀切。 */
  ipcMain.handle('vf:deleteFile', async (e, p, rec) => {
    if (!picAuth.has(p)) {
      trace('delete-deny ' + String(p));
      return { ok: false, reason: 'denied', path: p };
    }
    return doTrashOne(p, rec);
  });

  /* 批量删除：一次 IPC 走完 N 张（避免 N 次往返），逐张独立成败，
     返回与入参等长的结果数组 —— {ok,mode,ts,size,logId,path,name} | {ok:false,reason,path} */
  ipcMain.handle('vf:deleteFiles', async (e, list) => {
    if (!Array.isArray(list) || !list.length) return [];
    const out = [];
    for (const it of list.slice(0, 2000)) {
      const p = it && it.path;
      if (!p) { out.push({ ok: false, reason: 'bad-path' }); continue; }
      if (!picAuth.has(p)) {
        trace('delete-deny ' + String(p));
        out.push({ ok: false, reason: 'denied', path: p });
        continue;
      }
      out.push(await doTrashOne(p, it && it.rec));
    }
    return out;
  });

  /* 撤销删除：把文件从回收站搬回原位置。
     rec = { id?, path, size?, ts? } —— ts 用于只认“这一次删除”产生的回收站条目，
     避免误还原用户更早手动删掉的同名文件。

     注意 size/ts 的来历：它们经 trashLib.hintsOf 校验（安全非负整数）。
     **绝不能写 `(rec.ts) | 0`** —— 位或把 1.77e12 的毫秒时间戳截成 32 位，
     afterMs 变成远早于真实删除时刻的数，"只认这一次"的护栏就静默失效了；
     `(rec.size) | 0` 还会把 ≥2GiB 的文件截成负数，导致大文件永远还原失败。
     校验不过时 fail closed（bad-hint），而不是退回"不限制"——那等于悄悄拆护栏。 */
  ipcMain.handle('vf:restoreFile', async (e, rec) => {
    const p = rec && rec.path;
    if (!p || typeof p !== 'string') return { ok: false, reason: 'bad-path' };
    const h = trashLib.hintsOf(rec);
    if (!h) return { ok: false, reason: 'bad-hint', path: p };
    const r = await restoreFromTrash(p, h.size, h.ts);
    if (r && r.ok && rec && rec.id) await trashDrop(rec.id);
    return r;
  });

  /* 批量撤销删除：逐条还原，返回等长结果数组 {ok,path,size?} | {ok:false,reason,path} */
  ipcMain.handle('vf:restoreFiles', async (e, recs) => {
    if (!Array.isArray(recs) || !recs.length) return [];
    const out = [];
    for (const rec of recs.slice(0, 2000)) {
      const p = rec && rec.path;
      if (!p) { out.push({ ok: false, reason: 'bad-path' }); continue; }
      const h = trashLib.hintsOf(rec);
      if (!h) { out.push({ ok: false, reason: 'bad-hint', path: p }); continue; }
      const r = await restoreFromTrash(p, h.size, h.ts);
      if (r && r.ok && rec.id) await trashDrop(rec.id);
      out.push(Object.assign({ path: p }, r || { ok: false, reason: 'failed' }));
    }
    return out;
  });

  /* 回收站缩略图：从 $R 文件读回内容（≤6MB）转 dataURL，供回收站视图预览。
     原文件已被移走，这是唯一能在「回收站」里看到图片样子的途径。 */
  ipcMain.handle('vf:trashPreview', async (e, rec) => {
    const p = rec && rec.path;
    if (!p) return { ok: false, reason: 'bad-path' };
    const h = trashLib.hintsOf(rec);
    if (!h) return { ok: false, reason: 'bad-hint' };
    const hit = await findTrashed(p, h.size, h.ts);
    if (!hit) return { ok: false, reason: 'not-found' };
    try {
      const st = await fs.stat(hit.rFile);
      if (!st.isFile() || st.size > 6 * 1024 * 1024) return { ok: false, reason: 'too-big' };
      const ext = extOf(p);
      const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif'
        : ext === 'webp' ? 'image/webp' : ext === 'bmp' ? 'image/bmp'
          : ext === 'svg' ? 'image/svg+xml' : ext === 'avif' ? 'image/avif' : 'image/jpeg';
      const buf = await fs.readFile(hit.rFile);
      return { ok: true, url: 'data:' + mime + ';base64,' + buf.toString('base64') };
    } catch (err) {
      return { ok: false, reason: 'failed', message: String((err && err.message) || err) };
    }
  });

  /* 删除日志：跨启动保留，供「最近删除」面板展示与撤销 */
  ipcMain.handle('vf:trashLog', async () => (await readTrashLog()).slice(0, 60));
  ipcMain.handle('vf:trashForget', async (e, id) => { await trashDrop(id); return true; });
  ipcMain.handle('vf:trashClear', async () => { try { await writeTrashLog([]); return true; } catch (e) { return false; } });

  /** 打开系统回收站（还原失败时给用户一条人工兜底路径） */
  ipcMain.handle('vf:openRecycleBin', async () => {    try { const err = await shell.openPath('shell:RecycleBinFolder'); return !err; } catch (e) { return false; }
  });

  /* 用系统文件管理器打开某个目录（导出完成后的「打开文件夹」入口） */
  ipcMain.handle('vf:openPath', async (e, p) => {
    if (!p || typeof p !== 'string') return false;
    try {
      const st = await fs.stat(p);
      const target = st.isDirectory() ? p : path.dirname(p);
      const err = await shell.openPath(target);
      return !err;
    } catch (err) { return false; }
  });

  /* ============================================================
     版本更新检测 + 打开外部链接
     ------------------------------------------------------------
     为什么这两件事必须放在主进程：渲染层是 sandbox + contextIsolation，
     既没有网络权限（CSP 的 connect-src 只放行 vf: 与 data:），也不能
     唤起系统浏览器 —— 两件事都只能由主进程代劳。

     两条纪律：
     ① **openExternal 必须白名单**。shell.openExternal 能打开任意协议，
        不校验就等于给渲染层（以及任何注入进来的脚本）一个"打开任意 URL /
        执行本地文件"的能力，是明确的安全倒退。判定逻辑在 updatelib.js，
        有独立回归（含反向用例）。
     ② **checkUpdate 不接受渲染层传 URL**，只打 updatelib.js 里写死的官方接口。
        渲染层只能传一个"当前版本号"字符串，用来做比较与 User-Agent。
     ============================================================ */

  /** 打开官方仓库 / Releases 页（系统默认浏览器）。非白名单 URL 一律拒绝并留痕。 */
  ipcMain.handle('vf:openExternal', async (e, url) => {
    if (!updateLib.isAllowedExternal(url)) {
      console.warn('[main] 拒绝打开非白名单外链：' + String(url).slice(0, 200));
      return false;
    }
    try {
      await shell.openExternal(url);
      return true;
    } catch (err) {
      console.warn('[main] openExternal 失败：' + ((err && err.message) || err));
      return false;
    }
  });

  /**
   * 查最新版本。current 由渲染层传入（App.VERSION 是版本号的唯一来源），
   * 主进程不自己读 package.json —— 打包后 app.getVersion() 读的是包内
   * package.json，与渲染层显示的那个版本号未必同源，两处一旦不一致，
   * 就会出现"界面写着 1.14.0、更新检测却说当前是 1.13.0"的怪事。
   *
   * 返回 { ok:true, current, latest, hasUpdate, url }
   *   或 { ok:false, reason, current }，reason ∈ timeout|network|http-<code>|bad-response。
   * **失败与"已是最新"必须区分** —— 否则用户会以为"没有更新"，其实是没连上网。
   */
  ipcMain.handle('vf:checkUpdate', async (e, current) => {
    const cur = String(current || '').trim();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const resp = await net.fetch(updateLib.RELEASES_API, {
        headers: {
          // GitHub 接口要求带 User-Agent；Accept 固定 API 版本语义
          'User-Agent': 'Atrium/' + (cur || '0.0.0'),
          'Accept': 'application/vnd.github+json',
        },
        signal: ctrl.signal,
      });
      if (!resp || !resp.ok) {
        return { ok: false, reason: 'http-' + ((resp && resp.status) || 0), current: cur };
      }
      const data = await resp.json();
      const got = updateLib.latestFromRelease(data);
      if (!got) return { ok: false, reason: 'bad-response', current: cur };
      return {
        ok: true,
        current: cur,
        latest: got.latest,
        hasUpdate: updateLib.isNewer(got.latest, cur),
        url: got.url,
      };
    } catch (err) {
      const aborted = !!(err && (err.name === 'AbortError' || err.code === 'ABORT_ERR'));
      return { ok: false, reason: aborted ? 'timeout' : 'network', current: cur };
    } finally {
      clearTimeout(timer);
    }
  });

  /* 读文件头（EXIF / 尺寸探测）。只读前 1MB，但仍然是"任意文件可读"的原语，
     所以同样按 vf://pic 的授权清单放行 —— 能读的只能是用户打开过的目录里的文件。 */
  ipcMain.handle('vf:readHead', async (e, p, n) => {
    try {
      if (!picAuth.has(p)) { trace('readhead-deny ' + p); return null; }
      const len = Math.max(1, Math.min(n || 262144, 1024 * 1024));
      const fh = await fs.open(p, 'r');
      const buf = Buffer.allocUnsafe(len);
      let bytesRead = 0;
      try { ({ bytesRead } = await fh.read(buf, 0, len, 0)); } finally { await fh.close(); }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead);
    } catch (err) { return null; }
  });

  /* ---------- 窗口置顶 ----------
     渲染进程没有任何窗口控制能力（sandbox + contextIsolation），置顶只能由主进程做。
     返回「实际生效后」的状态，而不是请求值 —— 便于界面与真实状态保持一致。
     v1.8.0：改为作用于**发起调用的那个窗口**（`e.sender`）。这样
     主窗口的📌和相框窗口的📌是各自独立的两颗钉子，互不干扰。 */
  ipcMain.handle('vf:alwaysOnTop', async (e, on) => {
    try {
      const w = winOf(e) || mainWin;
      if (!w || w.isDestroyed()) return false;
      /* 为什么要有界重试（v1.20.5 实测，别再简化回去）：
         这台开发机是虚拟机 + 软件渲染（Microsoft Basic Render Driver），CPU 一有负载，
         Windows 的窗口管理器**偶尔会把 SetWindowPos(HWND_TOPMOST) 吞掉** ——
         `setAlwaysOnTop(true)` 调用不报错，可紧接着 `isAlwaysOnTop()` 仍是 false，
         而且连续三次、间隔 350ms 都还是 false，直到一秒多以后才恢复正常。
         用 Win32 直接读扩展样式（`GetWindowLong(GWL_EXSTYLE) & WS_EX_TOPMOST`）核对过：
         **系统那边确实没有置顶位**，所以这不是 Electron 读回值骗人，是真没生效。
         用户点一下📌却什么都没发生，是实打实的功能缺失 —— 所以这里重试几次。
         正常机器上第一次就成立，直接返回，不引入任何延迟。 */
      const want = !!on;
      let real = false;
      for (let i = 0; i < 5; i++) {
        w.setAlwaysOnTop(want);
        real = w.isAlwaysOnTop();
        if (real === want) break;
        if (i < 4) await new Promise((r) => setTimeout(r, 200));
      }
      trace('alwaysOnTop target=' + (w === frameWin ? 'frame' : (w === mainWin ? 'main' : '?'))
        + ' want=' + want + ' real=' + real);
      return real;
    } catch (err) { return false; }
  });
  ipcMain.handle('vf:getAlwaysOnTop', (e) => {
    try {
      const w = winOf(e) || mainWin;
      return !!(w && !w.isDestroyed() && w.isAlwaysOnTop());
    } catch (err) { return false; }
  });
  /* ---------- 标题栏浮层（Windows WCO，v1.15.0） ----------
     浮层配色必须跟着主题走（浅色主题纸色 + 深色符号，深色主题反过来），
     而主题是渲染进程算出来的（含 auto 跟随系统），主进程不可能自己知道 ——
     所以由渲染进程在主题变化时推过来。返回是否真的生效，便于调用方判断能力。 */
  ipcMain.handle('vf:titleBarOverlay', (e, opt) => {
    try {
      if (!WCO || !mainWin || mainWin.isDestroyed()) return false;
      const color = (opt && typeof opt.color === 'string' && opt.color) ? opt.color : CAP_BG;
      const symbolColor = (opt && typeof opt.symbolColor === 'string' && opt.symbolColor) ? opt.symbolColor : CAP_FG;
      mainWin.setTitleBarOverlay({ color, symbolColor, height: CAP_H });
      return true;
    } catch (err) { return false; }
  });

  /* 双击标题栏 = 最大化 / 还原。原生标题栏被浮层取代后系统不再提供这个行为，
     而它是 Windows 上最根深蒂固的操作习惯之一，必须补回来。 */
  ipcMain.handle('vf:toggleMaximize', (e) => {
    try {
      const w = winOf(e) || mainWin;
      if (!w || w.isDestroyed()) return false;
      if (w.isMaximized()) w.unmaximize(); else w.maximize();
      return w.isMaximized();
    } catch (err) { return false; }
  });

  wireFrameIpc();
}

/* ============================================================
   相框模式（v1.8.0）
   ------------------------------------------------------------
   为什么必须是**另一个窗口**：主窗口用的是系统原生标题栏，
   而 Electron 不能在运行期把 frame 打开/关掉；相框要求"窗口正好是
   图片的形状"，留着标题栏那条 30px 就永远对不上图片比例。
   所以相框单独开一个 frame:false 的窗口，主窗口先隐藏，
   退出相框再把主窗口请回来 —— 主窗口路径一行未改，没有回归风险。

     frame: false        无边框（"无边框显示"）
     alwaysOnTop: true   开启即置顶（"功能开启后应用置顶"）
     锁定宽高比          用户手动拉伸也保持图片比例
     图片铺满            窗口客户区比例 == 图片比例 → 图片刚好铺满（"应用内全屏"）
   ============================================================ */
function wireFrameIpc() {
  /** 开相框：清单由主窗口算好传进来（相框窗口只负责画） */
  ipcMain.handle('vf:frameOpen', (e, payload) => {
    try {
      const items = payload && Array.isArray(payload.items) ? payload.items : [];
      if (!items.length) return { ok: false, reason: 'empty' };
      const target = resolveFrameDisplay(payload && payload.display);
      framePayload = {
        ms: Math.max(1000, Number(payload.ms) || 6000),
        fit: payload.fit === 'cover' ? 'cover' : 'contain',
        // 传的是**全部**条目 + 来源清单：相框窗口据此自己换相册（它是另一个渲染进程，
        // 自己的 State.items / State.sources 都是空的）
        src: typeof payload.src === 'string' && payload.src ? payload.src : 'all',
        dock: ['left', 'right', 'top', 'bottom'].indexOf(payload.dock) >= 0 ? payload.dock : 'none',
        // 目标屏的可用区。相框窗口里的 `screen` 只反映"窗口此刻所在的那块屏"，
        // 而它刚开出来时可能还在旧屏上 —— 拿它算图片比例与贴边会算到错误的区域。
        display: (target && target.id != null) ? String(target.id) : '',
        workArea: target ? {
          x: target.workArea.x, y: target.workArea.y,
          width: target.workArea.width, height: target.workArea.height,
        } : null,
        sources: Array.isArray(payload.sources)
          ? payload.sources.slice(0, 500).map((s) => ({
              id: String((s && s.id) || ''),
              name: String((s && s.name) || ''),
            }))
          : [],
        items: items.slice(0, 20000).map((it) => ({
          p: String(it.p || ''),
          n: String(it.n || ''),
          w: it.w | 0,
          h: it.h | 0,
          r: it.r | 0,
          sid: String(it.sid || ''),
          id: String(it.id || it.p || ''),
          fav: !!it.fav,
        })),
      };
      framePainted = null;
      return ensureFrameWindow(target) ? { ok: true } : { ok: false, reason: 'window-failed' };
    } catch (err) {
      return { ok: false, reason: 'failed', message: String((err && err.message) || err) };
    }
  });

  /** 相框窗口取自己的播放清单（只认相框窗口，避免别的窗口把清单读走） */
  ipcMain.handle('vf:frameData', (e) => {
    const w = winOf(e);
    if (!frameWin || w !== frameWin) return null;
    return framePayload;
  });

  /** 相框窗口请求"按这张图的比例把我摆好"；返回实际应用的矩形 */
  ipcMain.handle('vf:frameFit', (e, box) => {
    try {
      const w = winOf(e);
      if (!frameWin || w !== frameWin || frameWin.isDestroyed()) return null;
      if (!box || !(box.w > 0) || !(box.h > 0)) return null;
      const width = Math.max(FRAME_MIN_W, Math.round(box.w));
      const height = Math.max(FRAME_MIN_H, Math.round(box.h));
      const ratio = Number(box.ratio);
      // 锁定比例：之后用户手动拉伸窗口也会保持这张图的形状
      if (ratio > 0 && isFinite(ratio)) { frameWin.setAspectRatio(ratio); frameWin.__ratio = ratio; }
      frameWin.setBounds({
        x: Math.round(Number(box.x) || 0),
        y: Math.round(Number(box.y) || 0),
        width: width, height: height,
      });
      const b = frameWin.getBounds();
      // 记下"这次是我们自己摆的"：下面 moved 事件里用它把程序性移动和用户拖动区分开，
      // 否则渲染进程每次吸附都会再收到一次 moved，来回震荡。
      frameWin.__lastApplied = { x: b.x, y: b.y, width: b.width, height: b.height };
      return { x: b.x, y: b.y, width: b.width, height: b.height, ratio: ratio > 0 ? ratio : 0 };
    } catch (err) { return null; }
  });

  /** 第一张真的画出来了 → 这时才隐藏主窗口（避免"黑一下"再出图的观感） */
  ipcMain.handle('vf:framePainted', (e, info) => {
    const w = winOf(e);
    if (!frameWin || w !== frameWin) return false;
    framePainted = {
      nw: (info && info.nw) | 0,
      nh: (info && info.nh) | 0,
      name: String((info && info.name) || ''),
      ts: Date.now(),
    };
    if (mainWin && !mainWin.isDestroyed() && mainWin.isVisible()) mainWin.hide();
    return true;
  });

  /** 关相框（相框窗口自己按 Esc / 点✕，或主窗口想收回） */
  ipcMain.handle('vf:frameClose', () => {
    if (frameWin && !frameWin.isDestroyed()) frameWin.close();
    else if (mainWin && !mainWin.isDestroyed() && !mainWin.isVisible()) { mainWin.show(); mainWin.focus(); }
    return true;
  });

  /**
   * 相框窗口状态。`frameless` 不是"我们自己声明的"，而是**问操作系统**：
   * 有标题栏时 contentBounds 会比 bounds 矮一条标题栏；无边框时两者相等。
   * 所以这是一条真实可验的信号，而不是自说自话。
   */
  ipcMain.handle('vf:frameInfo', (e) => {
    try {
      const senderIsFrame = !!(frameWin && winOf(e) === frameWin);
      const open = !!(frameWin && !frameWin.isDestroyed());
      if (!open) {
        return {
          open: false, senderIsFrame: senderIsFrame,
          alwaysOnTop: false, frameless: false, ratio: 0, bounds: null, content: null,
          mainShown: !!(mainWin && !mainWin.isDestroyed() && mainWin.isVisible()),
          painted: null, ready: false,
        };
      }
      const b = frameWin.getBounds();
      const c = frameWin.getContentBounds();
      return {
        open: true,
        senderIsFrame: senderIsFrame,
        alwaysOnTop: frameWin.isAlwaysOnTop(),
        frameless: b.width === c.width && b.height === c.height,
        ratio: frameWin.__ratio || 0,
        bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
        content: { x: c.x, y: c.y, width: c.width, height: c.height },
        mainShown: !!(mainWin && !mainWin.isDestroyed() && mainWin.isVisible()),
        painted: framePainted,
        ready: !!(frameWin && !frameWin.isDestroyed() && !frameWin.webContents.isLoading()),
      };
    } catch (err) { return null; }
  });

  /**
   * 屏幕清单 —— 「相框输出屏幕」这个设置项要用（主窗口调用，故不限 sender）。
   * label 优先用系统给的名字；系统不给名字（部分驱动）时按序号 + 分辨率凑一个可读的。
   */
  ipcMain.handle('vf:listDisplays', () => {
    try {
      const primary = screen.getPrimaryDisplay();
      return screen.getAllDisplays().map((d, i) => {
        const wa = d.workArea;
        return {
          id: String(d.id),
          label: (d.label && String(d.label).trim())
            || ('屏幕 ' + (i + 1) + '（' + wa.width + '×' + wa.height + '）'),
          primary: d.id === primary.id,
          workArea: { x: wa.x, y: wa.y, width: wa.width, height: wa.height },
        };
      });
    } catch (err) { return []; }
  });

  /**
   * 相框窗口自报"用户正把它拖到 (x, y)"。
   *
   * 为什么不用 CSS 的 `-webkit-app-region: drag` 把图片设成拖拽区：拖拽区**由系统接管，
   * 网页侧收不到任何鼠标事件**。而相框的图片上要保留"单击换下一张 / 双击退出"，
   * 一旦整张图变成拖拽区，这些单击就全没了 —— 图省事会让两个已有功能凭空消失。
   * 所以拖动由渲染进程自己累加指针偏移、逐帧报坐标，这里只负责搬窗口。
   *
   * **刻意不写 `__lastApplied`**：留着 `move` → 200ms 抖动合并 → reportMoved 那条路，
   * 渲染进程才能按落点吸附到屏幕边；写了就会被那条去重逻辑吃掉，拖动永远不吸附。
   */
  ipcMain.handle('vf:frameMove', (e, pos) => {
    try {
      const w = winOf(e);
      if (!frameWin || w !== frameWin || frameWin.isDestroyed()) return false;
      if (!pos || !isFinite(pos.x) || !isFinite(pos.y)) return false;
      frameWin.setPosition(Math.round(pos.x), Math.round(pos.y));
      return true;
    } catch (err) { return false; }
  });

}

/**
 * 相框窗口的"收尾"：把主窗口请回来。
 * 正常关闭（`closed`）与异常收尾（渲染进程崩溃 / 无响应）**共用这一份实现** ——
 * 两条路径各写一遍的话，迟早有一条走形（这类"多处各写一份"本项目已栽过多次）。
 * 幂等：重复调用只是再 show/focus 一次。
 */
function restoreMainAfterFrame() {
  if (!mainWin || mainWin.isDestroyed()) return;
  if (!mainWin.isVisible()) mainWin.show();
  mainWin.focus();
  try { mainWin.webContents.send('vf:frameClosed'); } catch (err) { /* 忽略 */ }
}

/**
 * 相框该输出到哪一块屏幕（v1.11.0 多显示器）。
 * · 显式指定且那块屏还在 → 用它；
 * · 'auto' / 空 / 指定的屏已被拔掉 → 跟随主窗口所在屏；主窗口也没了就回主屏。
 * 之所以要"拔掉了就回落"：显示器 id 会写进设置并跨启动保留，
 * 下次开机少了一块屏时若还按旧 id 找，就会算出一个不存在的可用区 —— 相框直接跑出屏幕。
 */
function resolveFrameDisplay(id) {
  try {
    const want = String(id == null ? 'auto' : id);
    if (want && want !== 'auto') {
      for (const d of screen.getAllDisplays()) if (String(d.id) === want) return d;
    }
    const base = (frameWin && !frameWin.isDestroyed()) ? frameWin
      : (mainWin && !mainWin.isDestroyed()) ? mainWin : null;
    if (base) return screen.getDisplayMatching(base.getBounds());
    return screen.getPrimaryDisplay();
  } catch (err) { return null; }
}

/** 没有就建、有就抬到前面；返回是否可用 */
function ensureFrameWindow(target) {
  const WA = (target && target.workArea) || null;
  const centered = (wa, w, h) => ({
    x: Math.round(wa.x + Math.max(0, (wa.width - w) / 2)),
    y: Math.round(wa.y + Math.max(0, (wa.height - h) / 2)),
  });
  if (frameWin && !frameWin.isDestroyed()) {
    // 目标屏变了（用户改了「输出屏幕」/ 换了显示器）→ 搬到那块屏中央，别把它留在原处
    const want = (target && target.id != null) ? String(target.id) : '';
    if (want && WA && frameWin.__display !== want) {
      try {
        const p = centered(WA, 960, 640);
        frameWin.setBounds({ x: p.x, y: p.y, width: 960, height: 640 });
        // 程序性搬动 → 记进 __lastApplied，否则会被当成"用户拖动"回传，让渲染进程白吸附一次
        const b = frameWin.getBounds();
        frameWin.__lastApplied = { x: b.x, y: b.y, width: b.width, height: b.height };
      } catch (err) { /* 忽略 */ }
    }
    frameWin.__display = want;
    if (!frameWin.isVisible()) frameWin.show();
    frameWin.focus();
    return true;
  }
  try {
    const wa0 = WA || (screen.getPrimaryDisplay() || {}).workArea
      || { x: 0, y: 0, width: 1280, height: 800 };
    const p0 = centered(wa0, 960, 640);
    frameWin = new BrowserWindow({
      x: p0.x,
      y: p0.y,
      width: 960,
      height: 640,
      minWidth: FRAME_MIN_W,
      minHeight: FRAME_MIN_H,
      show: false,
      frame: false,                  // 无边框显示
      alwaysOnTop: true,             // 功能开启即置顶
      resizable: true,
      maximizable: true,
      fullscreenable: true,
      autoHideMenuBar: true,
      backgroundColor: FRAME_BG,
      title: 'Atrium 相框',
      icon: path.join(__dirname, 'icon.ico'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false,  // 相框是长期挂着的展示窗口，别被节流
      },
    });
    frameWin.__ratio = 0;
    frameWin.__lastApplied = null;
    frameWin.__display = (target && target.id != null) ? String(target.id) : '';
    frameWin.setMenuBarVisibility(false);
    trace('frame created aot=' + frameWin.isAlwaysOnTop() + ' vis=' + frameWin.isVisible());
    /* 窗口位置变了 → 回传真实矩形，由渲染进程决定"吸附到哪一条边"。
       原生拖拽由系统接管，渲染进程拿不到拖动过程，所以只能在这里补一刀。
       位置恰好等于我们上次 setBounds 的结果时不发 —— 那是程序性移动，不是用户拖动
       （否则渲染进程每次吸附都会再收到一次，来回震荡）。 */
    const fw = frameWin;
    const reportMoved = () => {
      if (!fw || fw.isDestroyed()) return;
      const b = fw.getBounds();
      const la = fw.__lastApplied;
      if (la && la.x === b.x && la.y === b.y && la.width === b.width && la.height === b.height) return;
      try {
        fw.webContents.send('vf:frameMoved', { x: b.x, y: b.y, width: b.width, height: b.height });
      } catch (err) { /* 忽略 */ }
    };
    /* **两条事件都要接**（实测结论，别再只接一条）：
       · Windows 上真用户拖拽落位走 WM_EXITSIZEMOVE → 只有 `moved` 会响，落手即吸附；
       · 程序性 setBounds / Win+方向键贴靠 / 系统贴靠 → 只发 `move`，`moved` 一次都不发。
       若只接 `moved`，"用 setBounds 模拟拖动"的自检永远不吸附，键盘贴靠也失灵。
       `move` 加 200ms 抖动合并：拖动过程中 WM_MOVE 会连发，不合并会把 IPC 打满；
       合并窗口结束后再来一次即可，配合上面的 __lastApplied 去重不会重复上报。 */
    fw.on('moved', reportMoved);
    fw.on('move', () => {
      if (fw.__moveT) clearTimeout(fw.__moveT);
      fw.__moveT = setTimeout(reportMoved, 200);
    });
    frameWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    frameWin.webContents.on('will-navigate', (ev, url) => {
      if (!url.startsWith('vf://app')) ev.preventDefault();
    });
    // 自检时把相框窗口的报错也收进同一份错误清单（否则相框里的 bug 会被静默吞掉）
    if (consoleSink) {
      frameWin.webContents.on('console-message', (e, level, message) => {
        if (level >= 3 || (typeof e === 'object' && e && e.level === 'error')) {
          consoleSink.push('[frame] ' + String(message || ''));
        }
      });
    }
    frameWin.once('ready-to-show', () => {
      if (!frameWin || frameWin.isDestroyed()) return;
      trace('frame ready-to-show in=' + frameWin.isAlwaysOnTop() + ' vis=' + frameWin.isVisible());
      frameWin.show();
      /* 「功能开启即置顶」是相框的既定行为。但**置顶必须发生在窗口真的显示之后**：
         v1.20.5 实测（真实 exe，全量回归里机器最忙的那一段）——`ready-to-show` 触发时
         `isVisible()` 还是 false（show() 只是把请求排进系统队列，窗口还没映射），
         这时候调 `setAlwaysOnTop(true)` 会被 Windows 直接丢掉，**连调 5 次、跨 800ms
         也一样**；而等窗口真的显示出来之后，同样一次调用立刻生效（实测点一下📌就置顶了）。
         所以这里不能"show 完顺手设一次"，要**等到 isVisible() 为真再设**。
         有界（约 7.5 秒）：一直设不上就放弃，绝不留下一个永不退出的定时器；
         也不在设成功之后继续强制 —— 用户随时可能按📌取消置顶，那是有意的状态。

         v1.20.8 又加固了一次：全量回归跑到第 16 个套件时（机器已连跑 6 分钟），
         这条**偶发**失败（单独跑 4 次里红 1 次）。实测失败时的快照是
         `frameOpenInfo.alwaysOnTop=false` —— 窗口是可见的、图也画出来了，
         只有置顶位没落上。所以：① 重试从 33 次放宽到 50 次（7.5 秒）；
         ② 每次重试前先 `setAlwaysOnTop(false)` 再 `true` —— 先清掉可能残留的
         半截状态，比反复调同一个方向更容易让窗口管理器接受。 */
      const pinWhenVisible = (left) => {
        if (!frameWin || frameWin.isDestroyed()) return;
        if (!frameWin.isVisible()) {
          if (left > 0) setTimeout(() => pinWhenVisible(left - 1), 150);
          return;
        }
        if (left < 50) frameWin.setAlwaysOnTop(false);   // 先清残留状态再设
        frameWin.setAlwaysOnTop(true);
        trace('frame pin-when-visible vis=true aot=' + frameWin.isAlwaysOnTop() + ' left=' + left);
        if (!frameWin.isAlwaysOnTop() && left > 0) {
          setTimeout(() => pinWhenVisible(left - 1), 150);
        }
      };
      pinWhenVisible(50);
      frameWin.focus();
    });
    /* **渲染进程崩溃 / 无响应也必须收尾**（v1.11.0 补）。
       为什么只挂 `closed` 不够：渲染进程崩溃时**窗口对象仍然存在、`closed` 不会触发** ——
       主窗口就永远停在隐藏状态，用户面对的是一片空白的相框，只能自己手动把它关掉。
       注意主窗口那一侧早就有 render-process-gone 兜底（见 createWindow），
       相框窗口这条路径此前一个崩溃事件都没挂。
       两条都收敛到 `dropFrameWindow`：销毁窗口 → 走 `closed` 收尾（并显式补一次恢复，
       因为万一 `closed` 没来就彻底没人管了；`restoreMainAfterFrame` 是幂等的）。 */
    const dropFrameWindow = (why) => {
      if (consoleSink && why) consoleSink.push('[frame] ' + why);
      const w = frameWin;
      frameWin = null;
      framePainted = null;
      try { if (w && !w.isDestroyed()) w.destroy(); } catch (err) { /* 忽略 */ }
      restoreMainAfterFrame();
    };
    frameWin.webContents.on('render-process-gone', (ev, det) => {
      dropFrameWindow('render-process-gone reason=' + ((det && det.reason) || '?'));
    });
    // 无响应：相框是"长期挂着展示"的窗口，卡住约等于废掉，而此时主窗口还藏着 → 一并收尾
    frameWin.webContents.on('unresponsive', () => dropFrameWindow('unresponsive'));
    frameWin.on('closed', () => {
      // 用闭包里的 fw 而不是全局 frameWin：崩溃路径可能已经先把它置空了
      if (fw && fw.__moveT) { clearTimeout(fw.__moveT); fw.__moveT = 0; }
      frameWin = null;
      framePainted = null;
      // 相框关掉（Esc / ✕ / Alt+F4 / 任务栏关闭）→ 把主窗口请回来
      restoreMainAfterFrame();
    });
    frameWin.loadURL('vf://app/index.html?frame=1');
    return true;
  } catch (err) {
    frameWin = null;
    return false;
  }
}

/* ---------- 窗口标题栏（v1.15.0） ----------
   Windows 用 Window Controls Overlay：原生最小化/最大化/关闭由系统画成右上角浮层，
   标题栏本体交给渲染进程（左边应用名 + 右边置顶按钮）—— 置顶按钮因此正好落在
   「最小化」左边，和窗口控制键成为一组，而不是孤零零挂在顶栏控件簇的最右端。
   非 Windows 平台没有 WCO，保持原生标题栏；置顶按钮留在顶栏控件簇里
   （渲染进程按 navigator.windowControlsOverlay 是否存在自行归位）。
   CAP_H 必须与 css 的 --cap-h / .capbar 高度一致，否则浮层配色会和标题栏错位。 */
const WCO = process.platform === 'win32';
const CAP_H = 34;
const CAP_BG = '#f7f5f1';      // 浅色主题的纸色；深色主题由渲染进程再推一次
const CAP_FG = '#3a372f';      // 浮层三个符号的颜色

/* ---------- 窗口 ---------- */
function createWindow() {
  const opts = {
    width: 1280,
    height: 860,
    minWidth: 780,
    minHeight: 540,
    show: false,
    title: 'Atrium',
    icon: path.join(__dirname, 'icon.ico'),
    backgroundColor: '#f7f5f1',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  };
  if (WCO) {
    opts.titleBarStyle = 'hidden';
    opts.titleBarOverlay = { color: CAP_BG, symbolColor: CAP_FG, height: CAP_H };
  }
  mainWin = new BrowserWindow(opts);

  mainWin.setMenuBarVisibility(false);
  mainWin.once('ready-to-show', () => mainWin.show());

  mainWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWin.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('vf://app')) e.preventDefault();
  });

  /* 「关闭窗口 = 藏进托盘」。
     只有托盘活着、且用户真的开了这个设置时才拦；app.quit() 触发的 close
     必须放行，否则就退不掉了（quitting 由 before-quit / 托盘退出置位）。 */
  mainWin.on('close', (e) => {
    trace('window-close');
    if (desktop.wantHideOnClose()) {
      e.preventDefault();
      mainWin.hide();
      desktop.syncTrayMenu();
    }
  });
  // 显隐变化 → 刷新托盘的「显示/隐藏主窗口」文案
  mainWin.on('show', () => desktop.syncTrayMenu());
  mainWin.on('hide', () => desktop.syncTrayMenu());
  mainWin.on('minimize', () => desktop.syncTrayMenu());
  mainWin.on('restore', () => desktop.syncTrayMenu());
  // 任务栏缩略图按钮（Windows）。非 Windows 上是空操作。
  desktop.applyThumbar(mainWin);

  mainWin.loadURL('vf://app/index.html' + (SELFTEST ? '?selftest=1' : ''));
  if (SELFTEST) runSelfTest(mainWin);

  /* ---------- 渲染进程崩溃：两种命运，别混成一种 ----------
     ① 启动期被系统杀掉（reason=killed，且还没加载完、在 8 秒内）：
        少数受限环境（安全策略不允许创建 Chromium 沙箱进程）会出现。

        **不自动降级**：关掉沙箱是安全上的实质退让（渲染进程失去 OS 级隔离，
        一旦渲染层被攻破就直接等同主进程权限），绝不能由程序自己悄悄决定。
        所以这里只**询问**，用户明确点了「用兼容模式重启」才带 --no-sandbox 重启；
        默认按钮是「取消」，关窗 / Esc 也算取消。
        —— 改自 v1.20.0 及之前：那时是直接 relaunch，用户全程不知情。

     ② 其余一切（crashed / oom / killed 但已过启动期 / launch-failed / integrity-failure）：
        以前是**什么都不做** —— 窗口留在那里白屏，没有提示、没有重载入口，
        用户只能强杀进程。现在给一个兜底页。

     两条共用一个监听器，是因为它们要按**同一个 reason 值**分流：
     分成两个监听器的话，①弹完询问框（用户点了取消）之后 ②还会再弹一次兜底页，
     顺序就变得依赖注册顺序 —— 那种"看起来能跑"的耦合最难维护。 */
  const born = Date.now();
  let finished = false, asked = false, crashPages = 0;
  mainWin.webContents.on('did-finish-load', () => { finished = true; });
  mainWin.webContents.on('render-process-gone', (_e, det) => {
    const reason = (det && det.reason) || 'unknown';
    trace('render-gone reason=' + reason + ' exit=' + (det && det.exitCode));

    /* ① 启动期被杀 → 沙箱询问（唯一会 relaunch 的分支） */
    const atBoot = !finished && Date.now() - born < 8000;
    if (reason === 'killed' && atBoot && !SELFTEST && !asked && !argv.includes('--no-sandbox')) {
      asked = true;
      trace('sandbox-ask');
      const r = dialog.showMessageBoxSync(mainWin, {
        type: 'warning',
        title: '启动失败',
        message: '渲染进程被系统结束了',
        detail: '这通常是本机的安全策略不允许创建 Chromium 沙箱进程（受限的企业环境、'
          + '某些安全软件都可能这样）。\n\n'
          + '可以选择「兼容模式」重新启动：界面和功能完全一样，但渲染进程不再有沙箱隔离，'
          + '安全性会降低。\n\n'
          + '取消则保持现状 —— 建议先检查系统安全策略。每次启动都会重新询问，'
          + '不会记住这次的选择。',
        buttons: ['取消', '用兼容模式重启'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (r === 1) {
        trace('relaunch-with-no-sandbox (用户确认)');
        app.relaunch({ args: process.argv.slice(1).concat(['--no-sandbox']) });
        app.exit(0);
        return;
      }
      trace('sandbox-decline');
      /* 用户拒绝 → 落到下面的兜底页。窗口已经死了，留个白框比留段说明更糟。 */
    }

    /* ② 其余崩溃 → 兜底页。上限 3 次：确定性崩溃（比如一进某个目录就 OOM）
       不该变成"兜底页 ↔ 重载"的无限循环，那种循环比白屏更耗机器。 */
    if (SELFTEST || reason === 'clean-exit' || crashPages >= 3) return;
    crashPages++;
    showCrashFallback(reason, det && det.exitCode);
  });
}

/* ---------- 崩溃兜底页 ----------
   页面本身在 crashlib.js（纯函数，可单测：reason 映射 / 转义 / 退出码拼装）。
   这里只负责"把它加载出来"。

   为什么用 data: URL 而不是新增一个 crash.html：
   新增产物文件要同时改 assemble.js 的文件清单与 pack.js 的允许清单，
   漏一处就是"构建打印 OK、产物里却没有"—— 那正是 v1.20.1 踩过的坑。

   回链是一次**用户发起**的 vf://app 导航，会重新加载整个应用（will-navigate
   放行 vf://app，所以不必为它开例外）。页面本身没有脚本，也就拿不到
   window.vfNative —— 即便拿到了，IPC 的 sender 校验也会因为文档不是 vf://app/
   而全部拒绝。 */
function showCrashFallback(reason, exitCode, detail) {
  if (!mainWin || mainWin.isDestroyed()) return;
  trace('crash-fallback ' + reason + (detail ? ' ' + detail : ''));
  try {
    const url = 'data:text/html;charset=utf-8,'
      + encodeURIComponent(crashLib.crashPageHtml(reason, exitCode, detail ? { detail: detail } : null));
    mainWin.webContents.loadURL(url).catch((e) => {
      trace('crash-fallback-load-failed ' + ((e && e.message) || e));
    });
    if (mainWin.isMinimized()) mainWin.restore();
  } catch (e) { trace('crash-fallback-failed ' + ((e && e.message) || e)); }
}

/* ---------- 自检（--selftest + 可选 --open-dir <dir>；结果写入 VF_RESULT_FILE） ---------- */
function finishSelfTest(payload, code) {
  trace('selftest-finish code=' + code);
  const s = 'SELFTEST_RESULT ' + JSON.stringify(payload);
  try { console.log(s); } catch (e) { /* GUI 无控制台时忽略 */ }
  const rf = process.env.VF_RESULT_FILE;
  if (rf) { try { fsx.writeFileSync(rf, s, 'utf8'); } catch (e) { /* 忽略 */ } }
  setTimeout(() => app.exit(code), 60); // 留一拍让文件落盘
}

async function runSelfTest(win) {
  const errors = [];
  consoleSink = errors;
  win.webContents.on('console-message', (e, level, message) => {
    if (level >= 3 || (typeof e === 'object' && e && e.level === 'error')) errors.push(String(message || ''));
  });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const waitEval = async (cond, timeout, label) => {
    const t0 = Date.now();
    for (;;) {
      try { if (await js(cond)) return; } catch (e) { /* ignore */ }
      if (Date.now() - t0 > timeout) throw new Error('wait timeout: ' + label);
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  try {
    await waitEval(`document.body && document.body.dataset.booted === '1'`, 30000, 'boot');
    await waitEval(`window.Loader && !window.Loader.isIndexing && window.State && window.State.items.length > 0`, 60000, 'auto-open');
    const snap = await js(`(async () => {
      const R = { stage: 'start' };
      try {
        const S = window.State;
        R.stage = 'wait-decode';
        const t0 = Date.now();
        while (Date.now() - t0 < 30000) {
          if (S.items.length > 0 && S.items.every((m) => m.w > 0 && m.h > 0)) break;
          await new Promise((r) => setTimeout(r, 150));
        }
        const first = S.items[0];
        R.stage = 'lightbox-open';
        window.Lightbox.open(S.items, first);
        const img = document.querySelector('#lbImg');
        R.stage = 'wait-lb-img';
        const lt0 = Date.now();
        while (Date.now() - lt0 < 15000) {
          if (img && img.naturalWidth > 0 && img.classList.contains('ld')) break;
          await new Promise((r) => setTimeout(r, 120));
        }
        R.stage = 'exif-parse';
        const ex = await window.Exif.parse(first).catch(() => null);
        R.stage = 'readhead';
        let readHeadOk = false;
        try {
          const hb = await window.vfNative.readHead(first.path, 64);
          readHeadOk = !!(hb && hb.byteLength >= 8 && new Uint8Array(hb)[0] === 0x89); // PNG magic
        } catch (e) { readHeadOk = false; }
        R.stage = 'storage';
        let ls = false, idb = false;
        try { localStorage.setItem('__vf_t', '1'); ls = localStorage.getItem('__vf_t') === '1'; localStorage.removeItem('__vf_t'); } catch (e) { ls = false; }
        try {
          idb = await new Promise((res) => {
            const rq = indexedDB.open('__vf_t', 1);
            rq.onupgradeneeded = () => rq.result.createObjectStore('s');
            rq.onsuccess = () => {
              const d = rq.result;
              const tx = d.transaction('s', 'readwrite');
              tx.objectStore('s').put('1', 'k');
              tx.oncomplete = () => { d.close(); indexedDB.deleteDatabase('__vf_t'); res(true); };
              tx.onerror = () => { d.close(); indexedDB.deleteDatabase('__vf_t'); res(false); };
            };
            rq.onerror = () => res(false);
          });
        } catch (e) { idb = false; }

        // 删除链路：把最后一张通过 IPC 移入回收站，并确认磁盘上确实读不到了
        R.stage = 'delete';
        R.delApiOk = typeof window.vfNative.deleteFile === 'function';
        R.delOk = false; R.delGone = false;
        try {
          const victim = S.items[S.items.length - 1];
          R.delVictim = victim ? victim.name : 'no-victim';
          if (victim && victim.path) {
            const dr = await window.vfNative.deleteFile(victim.path, { name: victim.name, size: victim.size });
            R.delOk = !!(dr && dr.ok && dr.mode === 'trash');
            R.delAfter = (await window.vfNative.readHead(victim.path, 16)) ? 'still-readable' : 'gone';
            R.delGone = R.delAfter === 'gone';
            window.__vfVictim = victim;
            window.__vfLogId = dr && dr.logId;
            window.__vfTs = dr && dr.ts;
          }
        } catch (e) { R.delErr = String((e && e.message) || e); }

        // 删除日志（跨启动可撤销的底座）：删除后应能查到这条记录
        R.stage = 'trashlog';
        R.logApiOk = typeof window.vfNative.trashLog === 'function';
        R.logHas = false;
        try {
          if (R.logApiOk && R.delOk) {
            const lg = await window.vfNative.trashLog();
            R.logHas = Array.isArray(lg) && lg.some((x) => x && x.path === (window.__vfVictim && window.__vfVictim.path));
          }
        } catch (e) { R.logErr = String((e && e.message) || e); }

        // 撤销删除：把刚移入回收站的文件还原回原路径，并确认磁盘上真的回来了
        R.stage = 'undo';
        R.undoApiOk = typeof window.vfNative.restoreFile === 'function';
        R.undoOk = false; R.undoBack = false; R.logPurged = false;
        try {
          const v = window.__vfVictim;
          if (R.delOk && v && v.path) {
            const ur = await window.vfNative.restoreFile({
              id: window.__vfLogId, path: v.path, size: v.size, ts: window.__vfTs,
            });
            R.undoOk = !!(ur && ur.ok);
            if (ur && !ur.ok) R.undoWhy = ur.reason || 'unknown';
            R.undoBack = !!(await window.vfNative.readHead(v.path, 16));
            if (R.undoOk && R.logApiOk) {
              const lg2 = await window.vfNative.trashLog();
              R.logPurged = Array.isArray(lg2) && !lg2.some((x) => x && x.path === v.path);
            }
          }
        } catch (e) { R.undoWhy = String((e && e.message) || e); }

        // UI 层全链路：App.requestDelete（含确认弹层）→ 最近删除面板 → App.undoDelete
        R.stage = 'ui-delete';
        R.uiDelOk = false; R.uiCount = false; R.uiRecOk = false;
        R.uiUndoOk = false; R.uiBack = false; R.uiCount2 = false;
        try {
          if (window.Lightbox && window.Lightbox.isOpen && window.Lightbox.isOpen()) window.Lightbox.close();
          const A = window.App;
          const before = S.items.length;
          const v2 = S.items[S.items.length - 1];
          const v2path = v2 && v2.path;
          A.modal = () => Promise.resolve(true);         // 自动确认（自检环境）
          const dr = await A.requestDelete(v2);
          R.uiDelOk = dr === true;
          R.uiCount = S.items.length === before - 1;     // 图库里少了一张
          const rec2 = A.trash && A.trash[0];
          R.uiRecOk = !!(rec2 && rec2.path === v2path);  // 面板里多了一条可撤销记录
          R.uiPanelRows = (document.querySelectorAll('#trashList .tp-row') || []).length;
          R.stage = 'ui-undo';
          const ur2 = await A.undoDelete(rec2);
          R.uiUndoOk = ur2 === true;
          R.uiBack = !!(await window.vfNative.readHead(v2path, 16)); // 文件回到磁盘
          R.uiCount2 = S.items.length === before;        // 图库里又回来了
        } catch (e) { R.uiWhy = String((e && e.stack) || e); }

        // ---- 框选批量选择：选择集合、选择条联动、反选/清除 ----
        R.stage = 'select';
        R.selAll = 0; R.selBarShown = false; R.selCleared = false; R.selOne = false;
        try {
          if (window.Lightbox && window.Lightbox.isOpen && window.Lightbox.isOpen()) window.Lightbox.close();
          const G = window.Grid;
          const sb = document.getElementById('selBar');
          const sbc = document.getElementById('sbCount');
          G.clearSel();
          G.selectAll(true);
          R.selAll = G.selectedCount();
          R.selBarShown = !!sb && !sb.hidden && /已选\\s*\\d+/.test((sbc && sbc.textContent) || '');
          G.invert();
          R.selAfterInvert = G.selectedCount();
          G.clearSel();
          R.selCleared = G.selectedCount() === 0 && !!sb && sb.hidden;
          const one = S.items[0];
          G.toggle(one);
          R.selOne = G.selectedCount() === 1 && G.isSel(one);
          G.clearSel();
        } catch (e) { R.selWhy = String((e && e.stack) || e); }

        // ---- 批量删除（UI 全链路：App.requestDeleteMany → 回收站视图 → 预览） ----
        R.stage = 'batch-delete';
        R.batchApiOk = typeof window.vfNative.deleteFiles === 'function';
        R.batchDelOk = false; R.batchGone = false; R.batchCount = false;
        R.trashViewOk = false; R.trashRows = 0; R.previewOk = false;
        try {
          const A = window.App;   // 注意：前一个 try 块里的 A 是块级作用域，这里要重新取
          const n0 = S.items.length;
          const victims = [S.items[n0 - 1], S.items[n0 - 2]].filter(Boolean);
          R.batchNames = victims.map((v) => v.name);
          R.batchPaths = victims.map((v) => v.path);
          const before = S.items.length;
          const dr = await A.requestDeleteMany(victims.slice());   // A.modal 已被桩为「确认」
          R.batchDelOk = dr === true;
          R.batchCount = S.items.length === before - victims.length;
          const gone = [];
          for (const p of R.batchPaths) gone.push(!(await window.vfNative.readHead(p, 16)));
          R.batchGone = gone.length > 0 && gone.every(Boolean);
          window.__vfBatchRecs = (A.trash || []).slice(0, victims.length);

          // 回收站视图：删掉的图应该都列在这里，且能取回预览
          R.stage = 'trash-view';
          await A.openTrash();
          R.trashViewOk = !document.getElementById('trashView').hidden && window.Trash.isOpen();
          R.trashRows = (document.querySelectorAll('#tvGrid .tv-card') || []).length;
          R.stage = 'trash-preview';
          const rec0 = window.__vfBatchRecs && window.__vfBatchRecs[0];
          if (rec0) {
            const pv = await window.vfNative.trashPreview({ id: rec0.id, path: rec0.path, size: rec0.size, ts: rec0.ts });
            R.previewOk = !!(pv && pv.ok && typeof pv.url === 'string' && pv.url.indexOf('data:image/') === 0);
            if (!R.previewOk) R.previewWhy = (pv && (pv.reason || pv.message)) || 'no-url';
          }
        } catch (e) { R.batchWhy = String((e && e.stack) || e); }

        // ---- 批量撤销：一次把多张从回收站搬回原处 ----
        R.stage = 'batch-undo';
        R.batchUndoOk = false; R.batchBack = false; R.batchCount2 = false; R.trashClosed = false;
        try {
          const A = window.App;
          const recs = window.__vfBatchRecs || [];
          const before = S.items.length;
          const ok = await A.undoDeleteMany(recs);
          R.batchUndoOk = recs.length > 0 && ok === recs.length;
          const back = [];
          for (const p of (R.batchPaths || [])) back.push(!!(await window.vfNative.readHead(p, 16)));
          R.batchBack = back.length > 0 && back.every(Boolean);
          R.batchCount2 = S.items.length === before + recs.length;
          if (window.Trash.isOpen()) A.closeTrash();
          R.trashClosed = document.getElementById('trashView').hidden;
          R.trashLeft = (A.trash || []).length;
        } catch (e) { R.batchUndoWhy = String((e && e.stack) || e); }

        // ---- 诊断：回收站返回图库后，网格框选（真实 hit-test 复现） ----
        R.stage = 'diag-marquee';
        R.diagMarquee = { ok: false };
        R.diagImmediate = { ok: false };
        try {
          const A = window.App;
          if (window.Trash.isOpen()) A.closeTrash();
          // 二次路径：模拟用户「打开回收站看一眼 → 返回图库」（不带删除）
          await A.openTrash();
          if (window.Trash.isOpen()) A.closeTrash();
          const marquee = (g, st, iv) => {
            if (!(st && iv && g && g.N)) return -1;
            const r = iv.getBoundingClientRect();
            const x0 = r.left + 8, y0 = r.top + 8;
            const x1 = r.left + Math.min(360, Math.max(40, r.width - 8));
            const y1 = r.top + Math.min(360, Math.max(40, r.height - 8));
            st.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x0, clientY: y0, button: 0 }));
            window.dispatchEvent(new MouseEvent('mousemove', { clientX: (x0 + x1) / 2, clientY: (y0 + y1) / 2, button: 0 }));
            window.dispatchEvent(new MouseEvent('mousemove', { clientX: x1, clientY: y1, button: 0 }));
            window.dispatchEvent(new MouseEvent('mouseup', { clientX: x1, clientY: y1, button: 0 }));
            const n = g.selectedCount();
            g.clearSel();
            return n;
          };
          // (1) 立即框选（直接派发到 stage，e.target=stage）——旧路径（恒通过）
          {
            const g = window.Grid, st = document.getElementById('stage'), iv = document.getElementById('stageInner');
            R.diagImmediate.stageW = st ? st.clientWidth : -1;
            R.diagImmediate.N = g ? g.N : -1;
            R.diagImmediate.selAfter = marquee(g, st, iv);
            R.diagImmediate.ok = R.diagImmediate.selAfter > 0;
          }
          // (2) 等待 reflow 后再框选（直接派发到 stage）
          await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
          const g = window.Grid;
          const stage = document.getElementById('stage');
          const inner = document.getElementById('stageInner');
          R.diagMarquee.galleryHidden = document.getElementById('galleryView').hidden;
          R.diagMarquee.N = g ? g.N : -1;
          R.diagMarquee.marqueeBox = !!(g && g._marquee);
          const ec = document.elementFromPoint(Math.round(window.innerWidth / 2), Math.round(window.innerHeight / 2));
          R.diagMarquee.topElAtCenter = ec ? (ec.id || ec.className || ec.tagName) : null;
          R.diagMarquee.topElStageChild = !!(ec && stage && (ec === stage || stage.contains(ec) || document.getElementById('galleryView').contains(ec)));
          R.diagMarquee.noResultHidden = document.getElementById('noResult').hidden;
          R.diagMarquee.selBarHidden = document.getElementById('selBar').hidden;
          R.diagMarquee.trashViewHidden = document.getElementById('trashView').hidden;
          R.diagMarquee.stagePE = stage ? getComputedStyle(stage).pointerEvents : null;
          R.diagMarquee.selAfter = marquee(g, stage, inner);
          R.diagMarquee.ok = R.diagMarquee.selAfter > 0;

          // (3) 自愈回归：上一次拖拽的 mouseup 丢失（st 卡在“已按下”）后，
          //     新一次按下应先收尾再开始框选——验证「回收站往返后框选失效」类问题已修复
          {
            const stk = document.getElementById('stage');
            const rr = inner.getBoundingClientRect();
            // 模拟“按下并移动但未松开”：此时 st 处于卡住状态
            stk.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: rr.left + 10, clientY: rr.top + 10, button: 0 }));
            window.dispatchEvent(new MouseEvent('mousemove', { clientX: rr.left + 70, clientY: rr.top + 70, button: 0 }));
            // 回收站往返（真实用户路径）——修复前此路径会让 st 一直卡住
            await A.openTrash(); if (window.Trash.isOpen()) A.closeTrash();
            // 现在尝试框选：修复后应自愈并成功选中
            const n = marquee(window.Grid, stk, inner);
            R.diagHeal = { selAfter: n, ok: n > 0 };
            window.Grid.clearSel();
          }
        } catch (e) { R.diagMarquee.why = String((e && e.stack) || e); }

        // ---- 窗口置顶 IPC（v1.7.0）：渲染进程 → 主进程 → 真实窗口状态回读 ----
        //      这一段跑的是「装进包里的那个 exe」，所以能同时证明：
        //      preload 白名单、主进程 handler、窗口本体三者都真的进了包。
        R.stage = 'pin';
        R.pinApiOk = typeof window.vfNative.alwaysOnTop === 'function'
          && typeof window.vfNative.getAlwaysOnTop === 'function';
        R.pinSet = null; R.pinReal = null; R.pinUnset = null; R.pinRealOff = null;
        R.pinBtnVisible = false; R.pinAria = null; R.pinBackAria = null;
        try {
          const btn = document.getElementById('pinBtn');
          R.pinBtnVisible = !!btn && !btn.hidden;        // 桌面版必须可见（浏览器模式才隐藏）
          R.pinSet = await window.vfNative.alwaysOnTop(true);
          R.pinReal = await window.vfNative.getAlwaysOnTop();   // 主进程读真实窗口状态
          // 界面入口：App.togglePin 应同步 设置 / aria / 图标（连点两次回到原状）
          window.App.togglePin();
          await new Promise((r) => setTimeout(r, 260));
          R.pinAria = btn ? btn.getAttribute('aria-pressed') : null;
          R.pinSetting = !!window.State.settings.alwaysOnTop;
          window.App.togglePin();
          await new Promise((r) => setTimeout(r, 260));
          R.pinBackAria = btn ? btn.getAttribute('aria-pressed') : null;
          R.pinBackSetting = !!window.State.settings.alwaysOnTop;
          R.pinUnset = await window.vfNative.alwaysOnTop(false);
          R.pinRealOff = await window.vfNative.getAlwaysOnTop();
        } catch (e) { R.pinWhy = String((e && e.message) || e); }

        // ---- 相框模式（v1.8.0）：只在这里"开"，不在渲染脚本里验 ----
        //      无边框要靠 bounds 与 contentBounds 是否相等来判断（有标题栏时前者
        //      会高出一条标题栏）、置顶与窗口矩形也只有主进程拿得到，所以真正的
        //      断言放在主进程那一段（selftestFrame）。窗口故意**留着不关**。
        R.stage = 'frame';
        R.frameApiOk = typeof window.vfNative.frameOpen === 'function'
          && typeof window.vfNative.frameData === 'function'
          && typeof window.vfNative.frameInfo === 'function'
          && typeof window.vfNative.frameFit === 'function';
        R.frameBeforeOpen = null; R.frameOpenInfo = null;
        R.frameOpened = 0; R.frameBtnAria = null;
        R.frameBtnVisibleByDefault = null; R.frameBtnHiddenAfterDisable = null;
        try {
          const fbtn = document.getElementById('frameBtn');
          // v1.11.0：相框**已转为正式功能**，顶栏入口默认就是可见的；
          // 关掉「显示相框入口」才隐藏。这是 v1.8.1 实验门禁那条用例的反转 ——
          // 断言要跟着反向，而不是删掉它，否则会出现"代码转了正、断言还锁着旧行为"的矛盾。
          R.frameBtnVisibleByDefault = !!fbtn && fbtn.hidden === false;
          window.State.setSetting('showFrame', false);
          window.App.applyFrameUI();
          R.frameBtnHiddenAfterDisable = !!fbtn && fbtn.hidden === true;
          window.State.setSetting('showFrame', true);
          window.App.applyFrameUI();
          R.frameBeforeOpen = await window.vfNative.frameInfo();   // 开之前必须是关着的
          R.frameOpened = await window.App.enterFrame();           // 走真实界面入口
          await new Promise((r) => setTimeout(r, 3200));           // 等开窗 + 第一张出图
          R.frameOpenInfo = await window.vfNative.frameInfo();
          R.frameBtnAria = fbtn ? fbtn.getAttribute('aria-pressed') : null;
        } catch (e) { R.frameWhy = String((e && e.message) || e); }

        return Object.assign(R, {
          stage: 'done',
          items: S.items.length,
          allDecoded: S.items.length > 0 && S.items.every((m) => m.w > 0 && m.h > 0),
          lbW: img ? img.naturalWidth : 0,
          lbName: first ? first.name : null,
          exifNoThrow: !!ex && ('ok' in ex),
          exifOk: !!(ex && ex.ok),
          readHeadOk,
          ls, idb,
          nativePath: !!(first && first.path && !first.file),
          firstDims: first ? [first.w, first.h] : null,
          firstHasFile: !!(first && first.file),
          firstPathType: first ? typeof first.path : 'none',
        });
      } catch (e) {
        return Object.assign(R, { stage: 'ERR:' + R.stage, err: String((e && e.stack) || e) });
      }
    })()`);

    // 相框窗口的主进程侧验证（渲染脚本只负责"把它开起来"）
    // 把错误清单一起带进去：最后那条"故意把渲染进程杀掉"的用例会往清单里写一条
    // `[frame] render-process-gone`，需要按"崩溃前的水位"切掉，否则「无控制台报错」恒红。
    await selftestFrame(snap, errors);

    /* 总判据写成**带名字的清单**，而不是一个 30 项的长布尔表达式。
       为什么值得改：v1.20.5 有一次全量回归里自检 `pass=false`，而结果里只有
       `err: null` —— 报出来是"自检整体通过 → 无结果"，等于什么都没说。
       真正的原因（`frameOnTop=false`）只能靠人去翻 trace 里的快照才发现。
       清单化之后 `passFailed` 直接列出没过的那几条，失败信息自解释。 */
    const gates = [
      ['索引到素材且全部解码', snap.items > 0 && snap.allDecoded],
      ['灯箱能打开真实图片 / EXIF 不抛异常 / 文件头可读',
        snap.lbW > 0 && snap.exifNoThrow && snap.readHeadOk],
      ['原生桥与持久化可用', snap.ls && snap.idb && snap.nativePath],
      ['删除 → 回收站 → 撤销（IPC 层）',
        snap.delApiOk && snap.delOk && snap.delGone
        && snap.undoApiOk && snap.undoOk && snap.undoBack
        && snap.logApiOk && snap.logHas && snap.logPurged],
      ['删除 → 撤销（真实界面按钮）',
        snap.uiDelOk && snap.uiCount && snap.uiRecOk && snap.uiUndoOk && snap.uiBack && snap.uiCount2],
      ['框选与选择条', snap.selAll > 0 && snap.selBarShown && snap.selCleared && snap.selOne],
      ['批量删除', snap.batchApiOk && snap.batchDelOk && snap.batchCount && snap.batchGone],
      ['回收站视图与预览', snap.trashViewOk && snap.trashRows > 0 && snap.previewOk],
      ['批量撤销与回收站关闭',
        snap.batchUndoOk && snap.batchBack && snap.batchCount2 && snap.trashClosed],
      // 框选自愈回归：回收站往返后、以及上一次拖拽 mouseup 丢失后，框选仍应可用
      ['框选自愈（回收站往返 / mouseup 丢失）',
        !!(snap.diagMarquee && snap.diagMarquee.ok)
        && !!(snap.diagImmediate && snap.diagImmediate.ok)
        && !!(snap.diagHeal && snap.diagHeal.ok)],
      // 相框模式（v1.8.0）：无边框 / 置顶 / 按图片比例 / 真的画出来了 / 关掉后主窗回来
      ['相框存在且无边框、置顶、主窗已隐藏、真的出图、比例正确',
        snap.frameApiOk && snap.frameOpened > 0 && snap.frameExists
        && snap.frameFrameless && snap.frameOnTop && snap.frameMainHidden
        && snap.framePainted && snap.frameRatioOk],
      ['相框内部在播且画出了图',
        !!(snap.frameInner && snap.frameInner.on === true && snap.frameInner.items > 0
          && snap.frameInner.curW > 0)],
      ['相框的📌只动相框自己（开→关两态都验）',
        !!(snap.framePinFlip && snap.framePinFlip.before === true && snap.framePinFlip.after === false)],
      ['关掉相框后主窗自己回来',
        !!(snap.frameAfterClose && snap.frameAfterClose.open === false
          && snap.frameAfterClose.mainShown === true)],
      // v1.11.0：鼠标拖动真的搬了窗口且没吃掉单击；假屏幕 id 回落到真实屏幕；崩溃后主窗自己回来
      ['相框拖动 / 假屏幕回落 / 崩溃后恢复',
        !!(snap.frameDrag && snap.frameDrag.ok === true)
        && !!(snap.frameFallback && snap.frameFallback.open === true && snap.frameFallback.insideAny === true)
        && !!(snap.frameCrash && snap.frameCrash.killed === true && snap.frameCrash.frameGone === true
          && snap.frameCrash.mainBack === true && snap.frameCrash.reopenOk === true)],
    ];
    const passFailed = gates.filter(function (g) { return !g[1]; })
      .map(function (g) { return g[0]; });
    const pass = passFailed.length === 0;
    snap.passFailed = passFailed;
    /* 「无控制台报错」这条要按崩溃前的水位切一刀：
       最后那步是我们**主动**杀掉相框渲染进程，主进程的兜底会照实汇报一条
       `[frame] render-process-gone ...`。那不是产品缺陷，是我们自己制造的。
       切在这一步之前，意味着崩溃**之前**的任何一条报错仍然会被照实报出来
       （真在相框里崩过一次，仍然红）。 */
    const crashFrom = snap.frameCrashErrFrom;
    const errs = (typeof crashFrom === 'number' && crashFrom >= 0 && crashFrom <= errors.length)
      ? errors.slice(0, crashFrom) : errors;
    finishSelfTest({ pass, passFailed, snap, consoleErrors: errs }, pass ? 0 : 1);
  } catch (err) {
    finishSelfTest({ pass: false, err: String(err && err.message || err), consoleErrors: errors }, 1);
  }
}

/* ============================================================
   自检：相框窗口（只跑在 --selftest 里）
   ------------------------------------------------------------
   渲染脚本把相框"开起来"就返回了，真正的断言必须在主进程做：
     - 无边框：`bounds` 与 `contentBounds` 相等（有标题栏时前者高一条标题栏）
       —— 这是问操作系统，不是信我们自己声明的 frame:false
     - 置顶：`isAlwaysOnTop()`
     - 按图片比例：窗口宽高比 与 相框里那张图的实际像素比 对齐（1px 取整容差内）
     - 真的画出来了：相框渲染进程回报的 naturalWidth > 0
     - 关掉之后主窗口必须自己回来（用户按 Alt+F4 也不能把应用"关没了"）
   顺带截图留档，肉眼复核用。
   ============================================================ */
/* 等窗口"停下来"再量。
   这台机器上 `setBounds` / `setAlwaysOnTop` 是**异步落到系统**的，机器一忙，700ms 都不一定
   落完 —— 于是量到的基准位置是旧值，`dx/dy` 就会莫名其妙偏大
   （v1.20.5 实测：期望 90/30，量到 208/154，而拖动本身完全正常）。
   判据取"**连续 stableMs 毫秒内完全没动**"，而不是"等了 N 毫秒"：后者只是把概率调小。

   还有一个更隐蔽的搅局者：相框在 `img.onload` 之后会 `fit()` 重新按比例适配并居中，
   机器慢的时候它可能晚到一秒，正好落在"设好位置 → 开始拖动"这段空隙里，
   把基准连同拖动一起挪走（实测最终落在 414,237 ≈ 居中位置 400,240 + 一点点拖动）。
   所以拖动前要用更长的稳定窗（stableMs=800），确保那次迟到 `fit()` 已经落完。 */
async function settleBounds(win, maxMs, stableMs) {
  const t0 = Date.now();
  const need = stableMs || 260;
  let prev = win.getBounds();
  let since = Date.now();
  while (Date.now() - t0 < (maxMs || 2500)) {
    await new Promise((r) => setTimeout(r, 100));
    if (win.isDestroyed()) break;
    const b = win.getBounds();
    if (b.x === prev.x && b.y === prev.y && b.width === prev.width && b.height === prev.height) {
      if (Date.now() - since >= need) return b;
    } else { prev = b; since = Date.now(); }
  }
  return win.isDestroyed() ? prev : win.getBounds();
}

/** 等置顶状态落到 want（窗口管理器会吞请求，见 vf:alwaysOnTop 的注释） */
async function settleAot(win, want, maxMs) {
  const t0 = Date.now();
  for (;;) {
    const real = win.isDestroyed() ? false : win.isAlwaysOnTop();
    if (real === want) return real;
    if (Date.now() - t0 > (maxMs || 2000)) return real;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function selftestFrame(snap, sink) {
  const F = snap || {};
  F.frameExists = false; F.frameFrameless = false; F.frameOnTop = false;
  F.frameMainHidden = false; F.framePainted = false; F.frameRatioOk = false;
  F.frameInner = null; F.framePinFlip = null; F.frameShot = null; F.frameAfterClose = null;
  try {
    if (!frameWin || frameWin.isDestroyed()) { F.frameExists = false; return; }
    F.frameExists = true;

    const b = frameWin.getBounds();
    const c = frameWin.getContentBounds();
    F.frameBounds = b;
    F.frameContent = c;
    /* 判"无边框"用的是**操作系统自己报的两个矩形之差**：无边框时二者应当相等。
       但在非整数 DPI 缩放下（本机 scaleFactor=1.75，即 168dpi），Electron 把物理
       像素换算回 DIP 时对这两个矩形**分别**取整，于是必然出现 1px 的差，而且差在
       哪一维取决于取整方向 —— 实测同一个 1003x668 请求报成 1003/1002（宽差 1），
       960x640 报成 961x641 / 961x640（高差 1），两次开窗口都可能不一样。
       早先这里是严格相等，于是"相框是不是无边框"会随 DPI 取整方向随机变红。

       留 2px 容差不会把"有边框"误判成"无边框"：带标题栏的窗口实测差
       14~15（宽）/ 37（高）—— 差一个数量级。两个原始矩形与差值都写进快照，
       回归失败时能直接看到实际数字。 */
    F.frameBorderDelta = { dw: b.width - c.width, dh: b.height - c.height };
    F.frameFrameless = Math.abs(b.width - c.width) <= 2 && Math.abs(b.height - c.height) <= 2;
    /* 置顶可能比"出图"晚一拍：窗口映射完成后系统才接受 HWND_TOPMOST。
       这里等它稳定（最多 1.5s）再判 —— 断言的是"置顶最终成立"，
       不是"在某一瞬间成立"，否则判定结果会取决于机器忙不忙。 */
    {
      const t0 = Date.now();
      while (!frameWin.isAlwaysOnTop() && Date.now() - t0 < 1500) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    F.frameOnTop = frameWin.isAlwaysOnTop();
    trace('selftest frameOnTop=' + F.frameOnTop + ' vis=' + frameWin.isVisible()
      + ' focused=' + frameWin.isFocused());
    F.frameMainHidden = !!(mainWin && !mainWin.isDestroyed() && !mainWin.isVisible());
    F.framePainted = !!(framePainted && framePainted.nw > 0 && framePainted.nh > 0);

    // 窗口比例 == 图片比例（容差 1px 取整 + 极小相对误差）
    if (F.framePainted && b.width > 0 && b.height > 0) {
      const want = framePainted.nw / framePainted.nh;
      const got = b.width / b.height;
      F.frameRatioWant = Number(want.toFixed(4));
      F.frameRatioGot = Number(got.toFixed(4));
      F.frameRatioOk = Math.abs(want - got) <= 0.02 + Math.abs(want) * 0.01;
    }

    // 相框窗口内部：清单真的到了、真的在播、图库 UI 确实没出来
    try {
      F.frameInner = await frameWin.webContents.executeJavaScript(`(() => {
        const F = window.Frame;
        const main = document.getElementById('main');
        return {
          on: !!F && F.on === true,
          remote: !!F && F.remote === true,
          items: F ? F.items.length : 0,
          order: F ? F.order.length : 0,
          playing: !!(F && F.playing),
          curSrc: !!(F && F.cur && F.cur.getAttribute('src')),
          curW: F && F.cur ? F.cur.naturalWidth : 0,
          curH: F && F.cur ? F.cur.naturalHeight : 0,
          hasBar: !!(F && F.el && F.el.querySelector('.fr-bar')),
          hasPin: !!(F && F.pinBtn),
          fullHidden: !!(F && F.fullBtn && F.fullBtn.hidden),
          stats: F ? F.stats() : null,
          mainHidden: !main || getComputedStyle(main).display === 'none',
        };
      })()`, true);
    } catch (e) { F.frameInnerWhy = String((e && e.message) || e); }

    // 相框里那颗📌必须作用于**相框窗口**（与主窗口的钉子互不干扰）
    try {
      const before = await settleAot(frameWin, true, 2000);
      await frameWin.webContents.executeJavaScript(`document.querySelector('[data-act="pin"]').click()`, true);
      /* 等它真的翻过去再读。`vf:alwaysOnTop` 内部有界重试最多要 1 秒，固定等 420ms
         会在重试还没走完时就读，量到的是**上一态**（v1.20.5 实测 `{before:true, after:true}`，
         而 3ms 之后的日志已经显示变 false 了）。 */
      const after = await settleAot(frameWin, !before, 2000);
      trace('selftest pinFlip before=' + before + ' after=' + after);
      F.framePinFlip = { before: before, after: after };
      await frameWin.webContents.executeJavaScript(`document.querySelector('[data-act="pin"]').click()`, true);
      F.framePinRestored = await settleAot(frameWin, before, 2000);
    } catch (e) { F.framePinWhy = String((e && e.message) || e); }

    /* v1.9.0 —— 控制了条改为「下缘感应区驱动」：默认隐藏，移入才出现，移开立刻收起。
       在**真的无边框窗口**里复核一遍（离线探针那侧验的是页内浮层形态）。

       注意 `barMatchesPointer` 这条：控制条由 `pointerenter` 驱动，而相框窗口弹出的位置
       是固定的 —— 如果**物理光标**恰好停在下缘感应区上，Windows 会在窗口出现时补一个
       pointerenter，控制条立刻显示。这不是缺陷，是"指针真的在里面"。
       所以不能只断言"默认隐藏"（那会让门禁取决于鼠标停在哪），要断言
       **控制条的显隐与指针是否在感应区内一致**：不在就隐藏、在就显示。
       v1.20.4 实测：光标停在 (1443,406) 时 `barHiddenByDefault` 恒为 false，
       把它挪到 (5,5) 就变 true —— 断言依赖物理指针位置的典型例子。 */
    try {
      F.frameUi = await frameWin.webContents.executeJavaScript(`(() => {
        const F = window.Frame, el = F.el;
        const hot = el.querySelector('.fr-hot'), bar = el.querySelector('.fr-bar');
        const sel = el.querySelector('.fr-src');
        const pointerInside = !!(hot && hot.matches(':hover'));
        const hidden = !el.classList.contains('fr-bar-on');
        const out = {
          pointerInsideHot: pointerInside,
          barHiddenByDefault: hidden,
          barMatchesPointer: hidden === !pointerInside,
          barInsideHot: !!(bar && hot && bar.parentElement === hot),
          hasGrip: !!(hot && hot.querySelector('.fr-grip')),
          hasSrcSel: !!sel,
          srcOptions: sel ? sel.options.length : 0,
          srcValue: sel ? sel.value : '',
        };
        const ev = (t) => { try { return new PointerEvent(t); } catch (e) { return new Event(t); } };
        hot.dispatchEvent(ev('pointerenter'));
        out.shownOnHotIn = el.classList.contains('fr-bar-on');
        hot.dispatchEvent(ev('pointerleave'));
        out.hiddenOnHotOut = !el.classList.contains('fr-bar-on');
        return out;
      })()`, true);
    } catch (e) { F.frameUiWhy = String((e && e.message) || e); }

    /* v1.9.0 —— 拖动吸附：**走真实路径**。
       从主进程把窗口挪到贴着左边缘 6px 处 → 触发移动事件 → 主进程回传 →
       渲染进程判为"贴左边" → 自动把窗口贴齐到 0px。
       不是直接调 Frame._setDock，而是让整条链路自己跑一遍。
       （实测：程序性 setBounds 只发 `move` 不发 `moved`，所以主进程必须两条都接 ——
       见 ensureFrameWindow 里的说明。这里等 1.4s 是为了跨过 200ms 的抖动合并窗口。） */
    try {
      const wa = screen.getDisplayMatching(frameWin.getBounds()).workArea;
      frameWin.setBounds({ x: wa.x + 6, y: wa.y + 140, width: 620, height: 420 });
      await new Promise((r) => setTimeout(r, 1400));
      await settleBounds(frameWin, 1500);
      const nb = frameWin.getBounds();
      F.frameSnap = {
        workAreaX: wa.x,
        gotX: nb.x,
        flush: Math.abs(nb.x - wa.x) <= 1,
        dock: await frameWin.webContents.executeJavaScript('window.State.settings.frameDock', true),
      };
      // 复位：取消贴边并把窗口挪回中间（顺便验"拖离即取消贴边"）
      await frameWin.webContents.executeJavaScript(
        "window.State.setSetting('frameDock','none'); window.Frame.dock='none';", true);
      F.frameUndock = await frameWin.webContents.executeJavaScript('window.State.settings.frameDock', true);
      frameWin.setBounds({
        x: Math.round(wa.x + (wa.width - 620) / 2),
        y: Math.round(wa.y + (wa.height - 420) / 2),
        width: 620, height: 420,
      });
      await new Promise((r) => setTimeout(r, 500));
      await settleBounds(frameWin, 1500);
      F.frameUndockStayed = Math.abs(frameWin.getBounds().x - wa.x) > 50;
    } catch (e) { F.frameSnapWhy = String((e && e.message) || e); }

    /* v1.11.0 —— 鼠标拖动相框（按住图片拖窗口）。
       走**真实链路**：渲染层累加指针位移 → `vf:frameMove` → 主进程 `setPosition`。
       指针事件用合成 PointerEvent（带 screenX / screenY）注入：拖动逻辑读的就是这两个数，
       不依赖任何浏览器原生行为（不像"焦点到底落在哪"那样必须走真实输入管线），
       所以这里合成事件是可信的。断言落在**结果**上：
         · 窗口真的被搬到了预期位置；
         · 拖动**没有**顺手触发"单击换下一张"；
         · 而普通单击**仍然**能换图（证明拖动没把原功能吃掉）。 */
    try {
      /* 先把自动轮播按停，**并等当前这张图真的加载完**：`img.onload` 会触发
         `fit()` 重新按比例适配并居中，机器慢的时候这一下可能晚到一秒，
         正好落在"设好位置 → 开始拖动"之间，把基准连同拖动一起挪走
         （v1.20.5 实测：期望 +90/+30，量到 +264/+87，而终点 ≈ 居中位置 + 一点点拖动）。 */
      await frameWin.webContents.executeJavaScript(`(async () => {
        const F = window.Frame;
        F.pause();
        const t0 = Date.now();
        while (Date.now() - t0 < 3000) {
          if (F.cur && F.cur.complete && F.cur.naturalWidth > 0) return true;
          await new Promise((r) => setTimeout(r, 100));
        }
        return false;
      })()`, true);
      const dwa = screen.getDisplayMatching(frameWin.getBounds()).workArea;
      /* 摆一个确定的小窗口：远离任何一条边（拖完 +90/+30 仍落在"自由区"，不会被
         `snapEdge` 半路拽走），尺寸也取得比工作区小得多，以免被边界夹住。 */
      frameWin.setBounds({
        x: Math.round(dwa.x + 150), y: Math.round(dwa.y + 150), width: 480, height: 320,
      });
      await new Promise((r) => setTimeout(r, 700));   // 跨过 200ms 的 move 抖动合并
      const db0 = await settleBounds(frameWin, 3000, 800);
      /* 第一段：真的拖一遍。窗口应当刚好平移 (90, 30)；顺带合成一下 pointerup 之后
         浏览器会补的那颗 click —— 它**不该**换图（被 `_justDragged` 挡住）。 */
      const drag = await frameWin.webContents.executeJavaScript(`(async () => {
        const F = window.Frame, el = F.el;
        const BX = ${Math.round(db0.x)}, BY = ${Math.round(db0.y)};
        const CX = 200, CY = 160;
        const out = { start: { x: BX, y: BY }, firedAfterDragClick: 0, firedAfterPlainClick: 0 };
        const mk = (t, sx, sy) => new PointerEvent(t, {
          bubbles: true, cancelable: true, button: 0,
          buttons: t === 'pointerup' ? 0 : 1,
          clientX: CX, clientY: CY, screenX: sx, screenY: sy,
          pointerId: 1, isPrimary: true,
        });
        window.__hits = 0;
        window.__origNext = F.next;
        F.next = function () { window.__hits++; return window.__origNext.apply(this, arguments); };
        el.dispatchEvent(mk('pointerdown', BX + CX, BY + CY));
        // 分几步移动：一步跳到位就看不出"4px 阈值"这一步了
        for (const d of [2, 8, 45, 90]) {
          el.dispatchEvent(mk('pointermove', BX + CX + d, BY + CY + Math.round(d / 3)));
          await new Promise((r) => requestAnimationFrame(r));
        }
        el.dispatchEvent(mk('pointerup', BX + CX + 90, BY + CY + 30));
        // 浏览器会在 pointerup 之后补一个 click —— 这一下**不该**换图（被 _justDragged 挡住）
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        out.firedAfterDragClick = window.__hits;
        return out;
      })()`, true);
      await new Promise((r) => setTimeout(r, 560));
      /* **先量位置、再做"普通单击仍能换图"的对照**：那一击会真的翻页并重新按比例适配
         窗口（`next()` → 重算 box → 居中），放在前面测会把 dx / dy 一起搅掉。
         第一版就栽在这 —— 拖动本身是对的，却被后一步的居中抵消。
         量之前同样要等窗口停稳：拖动是"渲染层算位移 → IPC → 主进程 setPosition"，
         忙的时候 560ms 内还没落完，dx 就会量小。 */
      const db1 = await settleBounds(frameWin, 3000, 800);
      drag.dx = db1.x - db0.x;
      drag.dy = db1.y - db0.y;
      // 对照：清掉"刚拖过"标记，真正的单击应当**能**换图
      drag.firedAfterPlainClick = await frameWin.webContents.executeJavaScript(`(() => {
        const F = window.Frame, el = F.el;
        F._justDragged = 0;
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        const n = window.__hits;
        F.next = window.__origNext;               // 恢复原方法，别影响后面的步骤
        return n;
      })()`, true);
      await new Promise((r) => setTimeout(r, 600));
      drag.ok = Math.abs(drag.dx - 90) <= 3 && Math.abs(drag.dy - 30) <= 3
        && drag.firedAfterDragClick === 0 && drag.firedAfterPlainClick === 1;
      F.frameDrag = drag;
    } catch (e) { F.frameDragWhy = String((e && e.message) || e); }

    // 留一张相框窗口的截图，肉眼可复核"无边框 + 按比例"
    if (SHOTDIR) {
      try {
        const img = await frameWin.webContents.capturePage();
        const f = path.join(SHOTDIR, 'frame-window.png');
        await fs.writeFile(f, img.toPNG());
        F.frameShot = f;
      } catch (e) { F.frameShotWhy = String((e && e.message) || e); }
    }

    // 关窗 → 主窗口必须自己回来
    try {
      frameWin.close();
      await new Promise((r) => setTimeout(r, 800));
      F.frameAfterClose = {
        open: !!(frameWin && !frameWin.isDestroyed()),
        mainShown: !!(mainWin && !mainWin.isDestroyed() && mainWin.isVisible()),
      };
    } catch (e) { F.frameCloseWhy = String((e && e.message) || e); }

    /* v1.11.0 —— 多显示器：**指定一块不存在的屏幕**时必须回落到某块真实屏幕，
       绝不把窗口丢到屏幕外（外接屏拔掉后设置里那个 id 就失效了，这是最常见的触发场景）。
       重开一次相框：先把设置写成假 id，再走真实界面入口开窗。 */
    try {
      F.frameDisplayCount = screen.getAllDisplays().length;
      await mainWin.webContents.executeJavaScript(
        "window.State.setSetting('frameDisplay','no-such-display-9999'); window.App.enterFrame();", true);
      await new Promise((r) => setTimeout(r, 2600));
      const nb = (frameWin && !frameWin.isDestroyed()) ? frameWin.getBounds() : null;
      F.frameFallback = {
        open: !!nb,
        bounds: nb,
        insideAny: !!nb && screen.getAllDisplays().some((d) => {
          const a = d.workArea;
          return nb.x >= a.x - 1 && nb.y >= a.y - 1
            && nb.x + nb.width <= a.x + a.width + 1
            && nb.y + nb.height <= a.y + a.height + 1;
        }),
      };
      /* 复位"假 id"这一步刻意**不放在这里**：`setSetting('frameDisplay', ...)` 在
         `frameOn` 为真时的语义是"立刻换屏幕"——它内部会先 exitFrame 再 220ms 后重开一次
         相框。那条 setTimeout 会和下面的崩溃用例抢窗口（崩溃刚把窗口收掉，220ms 后
         又冒出一个新的 → `frameGone` 恒假）。所以复位挪到崩溃用例全部结束之后。 */
    } catch (e) { F.frameFallbackWhy = String((e && e.message) || e); }

    /* v1.11.0 —— 崩溃兜底（v1.10.0 复核时查实的缺口）。
       相框渲染进程崩溃时**窗口对象仍然存在、`closed` 不会触发** ——
       补之前主窗口就永远停在隐藏状态，用户只能面对一片空白相框、还得自己手动关掉它。
       这里直接把渲染进程杀掉，断言主窗口真的自己回来了。
       放在最后：这一步会销毁相框窗口，后面没有别的步骤了。 */
    try {
      F.frameCrash = { had: false, killed: false, frameGone: false, mainBack: false, reopenOk: false };
      if (frameWin && !frameWin.isDestroyed()) {
        F.frameCrash.had = true;
        // 记下崩溃前的"错误水位"：这一杀会经 `dropFrameWindow` 往 consoleSink 里写一条
        // 汇报，那是**我们要求的**，不该算成产品的控制台报错（详见函数收尾处）。
        F.frameCrashErrFrom = Array.isArray(sink) ? sink.length : -1;
        frameWin.webContents.forcefullyCrashRenderer();
        F.frameCrash.killed = true;
        await new Promise((r) => setTimeout(r, 1600));
        F.frameCrash.frameGone = !(frameWin && !frameWin.isDestroyed());
        F.frameCrash.mainBack = !!(mainWin && !mainWin.isDestroyed() && mainWin.isVisible());
        // 顺带确认崩溃没把功能永久搞坏：再开一次还能开出来
        await mainWin.webContents.executeJavaScript('window.App.enterFrame();', true);
        await new Promise((r) => setTimeout(r, 2400));
        F.frameCrash.reopenOk = !!(frameWin && !frameWin.isDestroyed());
        if (frameWin && !frameWin.isDestroyed()) frameWin.close();
        await new Promise((r) => setTimeout(r, 600));
      }
    } catch (e) { F.frameCrashWhy = String((e && e.message) || e); }

    /* 收尾：把多屏用例写入的那颗"假屏幕 id"复位掉，别留给后面的步骤/下一轮。
       放在最后是因为这一步会（若相框在开）触发一次退出+重开，必须等崩溃用例全部结束。 */
    try {
      await mainWin.webContents.executeJavaScript(
        "window.State.setSetting('frameDisplay','auto');", true);
      F.frameDisplayReset = true;
    } catch (e) { F.frameDisplayResetWhy = String((e && e.message) || e); }
  } catch (e) { F.frameVerifyWhy = String((e && e.stack) || e); }
}

/* ---------- 生命周期 ---------- */
trace('before-lock');

/* ============================================================
   启动期异常兜底：**不能只留一行 trace**
   ------------------------------------------------------------
   trace() 只在设了 VF_TRACE 环境变量时才写文件。普通用户没设 —— 于是启动期
   任何一个异常（模块缺失、data/ 不可写、userData 路径非法、rcedit 没写版本信息）
   都会让进程静默退出：双击图标，什么都不发生，没有任何提示，也没有任何痕迹。

   v1.20.1 自己就撞过这个症状：assemble.js 的 MAIN_FILES 漏了两个模块，
   构建打印 OK、exe 也起得来，运行时才 `Cannot find module './trashlib.js'`，
   进程当场没了。当时是靠 VF_TRACE + 单跑二进制才定位到的 ——
   换成用户环境，这条根本查不出来。

   所以这里做两件事，缺一不可：
   ① 把栈写进 <userData>/logs/crash-<时间>.log —— 事后能查；
   ② 弹一个系统级错误框 —— 当场能看见。
   **两者都不能再抛**：写盘失败、dialog 不可用都要吞掉。兜底代码自己崩掉的话，
   用户看到的还是"双击没反应"，而且这次连日志都不会有。

   为什么不给 unhandledRejection 也弹框：Node 里 uncaughtException 之后进程状态
   已无定义（继续跑等于赌），而 unhandledRejection 通常只是一个局部的、可以恢复的
   失败（比如某个 IPC 里的 fs 操作没 catch）。前者要退出，后者只记日志 ——
   否则一次无关紧要的 rejection 就会把用户正在看的图库弹窗打断。
   ============================================================ */
let fatalShown = false;
function reportFatal(kind, err, fatal) {
  const text = String((err && (err.stack || err.message)) || err || '');
  let logPath = '';
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fsx.mkdirSync(dir, { recursive: true });
    logPath = path.join(dir, 'crash-' + new Date().toISOString().replace(/[:.]/g, '-') + '.log');
    fsx.writeFileSync(logPath, new Date().toISOString() + ' ' + kind + '\n' + text + '\n', 'utf8');
  } catch (e) { logPath = ''; }
  trace('fatal ' + kind + ': ' + text);
  /* 自检 / 探针里绝不能弹模态框：那会把无人值守的回归挂死在"等用户点确定"上。
     日志照写，行为与以前一致。 */
  if (SELFTEST || !fatal || fatalShown) return;
  /* 正在退出时抛的异常不弹框、不改退出码：否则一次正常的退出（比如某个
     before-quit 处理器里 fs 已经不可用）会被记成 exit 1，排查时全是噪音。 */
  if (quitting) return;
  fatalShown = true;
  try {
    dialog.showErrorBox('Atrium 启动失败',
      '程序遇到了一个无法继续的错误，只能退出。\n\n'
      + text.split('\n').slice(0, 6).join('\n')
      + (logPath ? '\n\n详细信息已写入：\n' + logPath : '\n\n（日志也没能写下来，可能是数据目录不可写）'));
  } catch (e) { /* dialog 在极早期可能不可用，忽略 */ }
  /* 显示完再退出：留一个"什么都没发生的死进程"比退出更糟 —— 用户会反复双击。 */
  try { app.exit(1); } catch (e) { /* 已经在退出了 */ }
}
process.on('uncaughtException', (e) => reportFatal('uncaughtException', e, true));
process.on('unhandledRejection', (r) => reportFatal('unhandledRejection', r, false));
process.on('exit', (c) => { trace('main-exit code=' + c); });
const gotLock = SELFTEST || app.requestSingleInstanceLock();

/* JumpList 的「任务」是用 process.execPath + 参数**另起一个进程**实现的，
   所以这些参数会在两条路径上出现：应用没在跑时进第一个进程的 argv，
   已在跑时进第二个进程的 commandLine（由 second-instance 转交）。
   两处都走同一个映射，避免只做了一半（"点 JumpList 没反应"）。 */
function commandsFromArgv(list) {
  const a = list || [];
  const out = [];
  if (a.includes('--open-dialog')) out.push('open-folder');
  if (a.includes('--open-trash')) out.push('open-trash');
  return out;
}

if (!gotLock) {
  trace('lock-denied quit');
  app.quit();
} else {
  app.on('second-instance', (e, commandLine) => {
    trace('second-instance');
    const w = (mainWin && !mainWin.isDestroyed()) ? mainWin : null;
    if (w) {
      if (w.isMinimized()) w.restore();
      if (!w.isVisible()) w.show();
      w.focus();
    }
    // JumpList 任务带过来的参数 → 转成渲染层命令
    for (const c of commandsFromArgv(commandLine)) sendCommand(c);
  });

  app.whenReady().then(async () => {
    trace('ready-start');
    // 应用菜单：不再是无菜单，而是 desktop.js 装配的原生菜单（含 Ctrl+O）。
    // 必须在这里（第一个窗口创建之前）设置，否则会先闪一下 Electron 默认菜单。
    desktop.installAppMenu();
    protocol.handle('vf', handleVf);
    /* 必须在 wireIpc / desktop.wireIpc 之前装好：它靠包住 ipcMain.handle/on
       来实现"默认拒绝"，装晚了就会有一批通道漏在门外。 */
    installIpcGuard();
    wireIpc();
    desktop.wireIpc();
    trace('ready-wired');

    /* ---------- 权限：一律拒绝，并留痕 ----------
       这个应用不需要摄像头 / 麦克风 / 定位 / 通知 / 剪贴板读取 / 全屏锁定 / MIDI ——
       它只读用户明确打开的目录。

       为什么要写这两行：**没有 handler 不等于"全部拒绝"**。Electron 对每种权限
       各有默认值，把边界交给默认值意味着某次大版本升级改了默认值，这边不会有人
       发现。写成一条显式规则之后，"能不能要摄像头"这件事就有了确定的答案，
       而且被拒时 trace 里有记录 —— 真出了意外行为能查到是哪个权限被拦了。

       注意 setPermissionCheckHandler 也返回 false：只拒"请求"不拒"检查"的话，
       某些 API 会绕过请求直接查状态（如 navigator.permissions.query），
       两边口径不一致就会出现"看起来允许了但实际用不了"的怪状态。 */
    const denyPerm = (wc, permission) => {
      trace('permission-deny ' + permission);
      return false;
    };
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
      denyPerm(wc, permission);
      cb(false);
    });
    session.defaultSession.setPermissionCheckHandler(denyPerm);
    trace('permissions-denied-all');

    // 支持 --open-dir 预置“上次目录”（首次运行引导/自测用）
    const idx = argv.indexOf('--open-dir');
    if (idx >= 0 && argv[idx + 1]) await writeLast(argv[idx + 1]);
    trace('lastdir-seeded');

    createWindow();
    trace('window-created');
    mainWin.webContents.on('render-process-gone', (e, d) => trace('render-gone reason=' + d.reason + ' exit=' + d.exitCode));
    /* 主框架没加载出来 = 用户看到一块**纯白窗口**，没有任何提示与入口。
       以前这里只往日志写一行，用户那边就是"打开就白屏，也不知道是不是还在加载"。
       现在接兜底页：至少告诉他发生了什么、以及点哪里能重来。
       三种情况要放行（接了反而更糟）：
         · code -3 (ERR_ABORTED)：正常导航被新导航打断，页面本身没坏；
         · 子框架失败：内嵌页/图片请求挂了跟主界面无关；
         · 已经在兜底页上：再套一层就成了递归。 */
    mainWin.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
      trace('did-fail-load code=' + code + ' ' + desc + ' url=' + url + ' main=' + isMainFrame);
      if (isMainFrame === false) return;
      if (code === -3) return;
      if (String(url || '').indexOf('data:text/html') === 0) return;
      showCrashFallback('load-failed', undefined, desc + ' (' + code + ')');
    });
    // 页面就绪 → 把排队的命令（JumpList 任务）放出去
    mainWin.webContents.on('did-finish-load', () => { trace('did-finish-load'); flushCommands(); });
    mainWin.on('closed', () => trace('window-closed'));

    // Windows 任务栏 JumpList（右键任务栏图标 → 任务）
    const jl = desktop.applyJumpList();
    trace('jumplist ' + JSON.stringify(jl));

    // 应用自己就是被 JumpList 任务拉起来的 → 直接执行那条命令
    for (const c of commandsFromArgv(argv)) sendCommand(c);

    app.on('before-quit', () => { quitting = true; trace('before-quit'); });
    app.on('will-quit', () => { desktop.disposeGlobalHotkey(); trace('will-quit'); });
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }).catch((e) => {
    /* ready 阶段失败 = 窗口根本没建起来，是确定的致命错误。
       以前这里只 trace 一行，用户看到的就是"双击没反应"。 */
    reportFatal('whenReady', e, true);
  });

  app.on('window-all-closed', () => {
    trace('window-all-closed');
    if (process.platform !== 'darwin') app.quit();
  });
}
