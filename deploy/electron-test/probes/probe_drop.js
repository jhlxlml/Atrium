/* ============================================================
   Atrium · probe_drop.js —— 拖拽入口的真实 Electron 验证
   ------------------------------------------------------------
   为什么这条通路必须单独测：

   拖拽是**唯一一条"条目没有磁盘路径"**的通路 —— 它产出的是
   `{ file: File, rel }` 而不是 `{ path }`。也就是说，它的
   索引路径 / 缩略图路径 / EXIF 读取路径 / 删除·还原路径
   **全都与主通路（原生目录）不同**：

       · native.js 对 `!meta.path` 有专门分支（url() 返回 null）
       · app.js 有 3 处 `.filter(r => r.path)` / `if (!m.path)`
       · Loader.canDelete() 对无 path 且无 dirHandle 的条目返回 null
         → 删除走"不支持删除"这条**错误**分支，而不是成功分支

   而在本次新增之前，它在 17 个探针 + 6 个单测里命中 **0 次**：
   `appself` 自检走的是 `--open-dir`（原生路径），**永远测不到它**。
   一旦坏掉，没有任何红灯。

   断言落在**结果**上（不是"函数被调用了"）：
     ① 拖入 1 个文件夹 → 来源 +1、条目数与夹具一致、条目全部无磁盘路径
     ② 缩略图**真的画出来了**（`.tile-ph img` 的 naturalWidth > 0）
     ③ 拖入的图**能打开灯箱**
     ④ 无路径条目点删除 → 给出**可读原因**（不是静默失败、不是崩）
     ⑤ 一次拖入多个文件夹 → 分组为多个来源；散文件归入「拖入的图片」

   夹具：直接读 `fixtures/照片夹/`（5 张 PNG + 子目录 `子集/` 2 张 = 7 张）。
   注意**必须把字节送进渲染进程**（转成 File 对象），不能在磁盘上留路径 ——
   留了路径就走到原生条目那条通路，恰好把要测的差异测没了。

   输出一行：DROP { ... }
   ============================================================ */
'use strict';
const { app, BrowserWindow, ipcMain, protocol } = require('electron');

/* 桌面集成通道桩：App.init() 会重放托盘/快捷键设置，缺 handler 会"假失败"
   （把播报区改成 assertive 并留在那儿）—— 详见 _desktop_stub.js */
require('./_desktop_stub').stubDesktop();
/* 窗口置顶 / 屏幕清单也要补桩：App.init() 启动时会拉，缺了会让探针变成"不完整宿主"
   —— invoke reject 被 .catch 吞掉，上层判"没生效"，并留下一条 console.warn 假报错。 */
require('./_desktop_stub').stubWindowChannels();

const path = require('path');
const fs = require('fs');

const APPDIR = path.resolve(__dirname, '..', '..', '..');
const FIX = path.resolve(__dirname, '..', 'fixtures', '照片夹');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

protocol.registerSchemesAsPrivileged([
  { scheme: 'vf', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true } },
]);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg',
};
const noop = ['vf:autoDir', 'vf:pickDirs', 'vf:restoreFile', 'vf:restoreFiles', 'vf:trashForget',
  'vf:trashClear', 'vf:pickFolder', 'vf:loadDir', 'vf:openRecycleBin'];
noop.forEach((c) => ipcMain.handle(c, () => null));
ipcMain.handle('vf:trashLog', () => []);

/* 夹具读成 [{rel, b64}]。rel 以顶层目录名开头，与页面里伪造的目录树一一对应。 */
function collect(dir, prefix, out) {
  for (const f of fs.readdirSync(dir)) {
    const abs = path.join(dir, f);
    if (fs.statSync(abs).isDirectory()) collect(abs, prefix + f + '/', out);
    else if (/\.(png|jpe?g)$/i.test(f)) {
      out.push({ rel: prefix + f, b64: fs.readFileSync(abs).toString('base64') });
    }
  }
  return out;
}
const FILES = collect(FIX, '照片夹/', []);
if (FILES.length < 7) {
  console.error('ERR 夹具不足：期望 ≥7 张图片，实际 ' + FILES.length);
  app.exit(1);
}

async function run() {
  protocol.handle('vf', async (req) => {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const abs = path.resolve(APPDIR, rel || 'index.html');
    if (!abs.startsWith(APPDIR)) return new Response('forbidden', { status: 403 });
    try {
      const b = await fs.promises.readFile(abs);
      return new Response(b, {
        headers: { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'access-control-allow-origin': 'vf://app' },
      });
    } catch (e) { return new Response('404', { status: 404 }); }
  });

  const win = new BrowserWindow({
    width: 1400, height: 900, show: true,
    webPreferences: {
      preload: path.join(APPDIR, 'deploy', 'electron', 'preload.js'),
      contextIsolation: true,
    },
  });
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('PAGE-ERR ' + msg); });
  await win.loadURL('vf://app/index.html');
  await new Promise((r) => setTimeout(r, 900));

  const out = await win.webContents.executeJavaScript(`(async () => {
    const S = window.State, L = window.Loader;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = {};
    const FILES = ${JSON.stringify(FILES)};

    /* ---------- 把"夹具字节"还原成页面里的 File / 目录树 ---------- */
    const b64ToBytes = (b64) => {
      const bin = atob(b64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return u8;
    };
    const mkFile = (rel, b64) => {
      const name = rel.split('/').pop();
      return new File([b64ToBytes(b64)], name, { type: 'image/png', lastModified: 1700000000000 });
    };
    /* FileSystemEntry 的最小可用伪造：scanEntry() 只用到 isFile / isDirectory /
       name / file(cb) / createReader().readEntries(cb)。readEntries 必须"先给一批、
       再给空数组"来终止 —— 真实 API 就是这样分批的，给一次就完会被判成空目录。 */
    const fileEntry = (file) => ({
      isFile: true, isDirectory: false, name: file.name,
      file(cb) { setTimeout(() => cb(file), 0); },
    });
    const dirEntry = (name, children) => {
      let served = false;
      return {
        isFile: false, isDirectory: true, name,
        createReader() {
          return {
            readEntries(cb) {
              setTimeout(() => {
                if (served) { cb([]); return; }
                served = true;
                cb(children);
              }, 0);
            },
          };
        },
      };
    };
    const buildRoot = (rootName, files) => {
      const tree = new Map();          // name -> Map(子目录) | File
      for (const f of files) {
        const parts = f.rel.split('/');
        parts.shift();                 // 去掉根名（根的 children 就是去掉根名后的第一段）
        const file = mkFile(f.rel, f.b64);
        let cur = tree;
        for (let i = 0; i < parts.length - 1; i++) {
          const k = parts[i];
          if (!(cur.get(k) instanceof Map)) cur.set(k, new Map());
          cur = cur.get(k);
        }
        cur.set(parts[parts.length - 1], file);
      }
      const toEntries = (m) => [...m.entries()].map(([name, v]) =>
        (v instanceof Map) ? dirEntry(name, toEntries(v)) : fileEntry(v));
      return dirEntry(rootName, toEntries(tree));
    };
    const mkDT = (nodes) => ({
      items: nodes.map((n) => ({
        kind: 'file',
        webkitGetAsEntry: () => n.entry,
        getAsFile: () => n.file || null,
      })),
      files: nodes.map((n) => n.file).filter(Boolean),
      types: ['Files'],
    });
    const itemsOf = (sid) => S.items.filter((it) => it.sid === sid);
    const lastSrc = () => S.sources[S.sources.length - 1];

    /* ---------- ① 拖入 1 个文件夹（含一层子目录） ---------- */
    const before1 = S.sources.length;
    out.drop1Ok = await L.fromDrop(mkDT([{ entry: buildRoot('照片夹', FILES) }]));
    const s1 = lastSrc();
    out.drop1SrcDelta = S.sources.length - before1;
    out.drop1Name = s1 ? s1.name : null;
    out.drop1Count = s1 ? itemsOf(s1.id).length : 0;
    out.fixtureCount = FILES.length;
    // 无磁盘路径 —— 这正是这条通路与主通路的**根本差异**，必须锁住
    out.allPathless = s1 ? itemsOf(s1.id).every((it) => !it.path) : false;
    out.allHaveFile = s1 ? itemsOf(s1.id).every((it) => !!it.file) : false;
    /* rel 必须**逐条**等于夹具的目录结构（含子目录）。rel 同时是去重键、排序键
       与条目 id 的一部分，所以这一条比"数量对"更硬：
       早先它被拼成 照片夹/照片夹/山景-01.png（顶层名重复一次）——
       数量、去重、排序全都"看起来正常"，只有逐条比对才看得见。
       ⚠️ 注意本段在 executeJavaScript 的**模板串内部**：绝不能出现反引号，
       一个反引号就把字符串截断（报错行号还指向别处）。 */
    out.expectedRels = FILES.map((f) => f.rel).sort();
    out.actualRels = s1 ? itemsOf(s1.id).map((it) => it.rel).sort() : [];
    out.relsMatchFixture = JSON.stringify(out.actualRels) === JSON.stringify(out.expectedRels);
    // 只报"顶层目录名重复"这一个具体症状，方便一眼定位
    out.relDupPrefix = s1 ? itemsOf(s1.id).some((it) => it.rel.indexOf('照片夹/照片夹/') === 0) : null;

    /* ---------- ② 缩略图真的画出来了吗 ---------- */
    // 拖拽后 App 会在 index-done 里自动 showGallery()，这里只等它画完，不手动驱动
    let painted = 0, tiles = 0;
    for (let i = 0; i < 80; i++) {
      await wait(100);
      tiles = document.querySelectorAll('.tile').length;
      painted = [...document.querySelectorAll('.tile-ph img')].filter((im) => im.naturalWidth > 0).length;
      if (painted > 0 && painted >= Math.min(tiles, 4)) break;
    }
    out.tiles = tiles;
    out.thumbsPainted = painted;

    /* ---------- ③ 能打开灯箱 ---------- */
    const first = s1 ? itemsOf(s1.id)[0] : null;
    out.lightboxOpen = false;
    out.lightboxImgW = 0;
    if (first) {
      try {
        window.Lightbox.open(S.viewList(), first);
        for (let i = 0; i < 40; i++) {
          await wait(100);
          const box = document.getElementById('lightbox');
          const im = box ? box.querySelector('img') : null;
          if (box && !box.hidden && im && im.naturalWidth > 0) {
            out.lightboxOpen = true;
            out.lightboxImgW = im.naturalWidth;
            break;
          }
        }
        out.lightboxOpen = out.lightboxOpen || (document.getElementById('lightbox').hidden === false);
      } catch (e) { out.lightboxErr = String((e && e.message) || e); }
      try { window.Lightbox.close(); } catch (e) { /* 忽略 */ }
      await wait(200);
    }

    /* ---------- ④ 无路径条目点删除 → 可读原因（不是静默、不是崩） ---------- */
    out.deleteCapability = first ? L.canDelete(first) : 'no-item';
    out.deleteReturned = null;
    out.deleteToast = '';
    out.deleteThrew = null;
    if (first) {
      try { out.deleteReturned = await window.App.requestDelete(first); }
      catch (e) { out.deleteThrew = String((e && e.message) || e); }
      for (let i = 0; i < 20; i++) {
        await wait(100);
        out.deleteToast = [...document.querySelectorAll('.toast span')].map((e) => e.textContent).join(' | ');
        if (out.deleteToast) break;
      }
    }
    out.stillThere = first ? S.items.indexOf(first) >= 0 : null;

    /* ---------- ⑤ 一次拖入多个文件夹 → 多个来源 ---------- */
    const rootA = buildRoot('相册A', [
      { rel: '相册A/a1.png', b64: FILES[0].b64 },
      { rel: '相册A/a2.png', b64: FILES[1].b64 },
    ]);
    const rootB = buildRoot('相册B', [{ rel: '相册B/b1.png', b64: FILES[2].b64 }]);
    const before2 = S.sources.length;
    out.drop2Ok = await L.fromDrop(mkDT([{ entry: rootA }, { entry: rootB }]));
    out.drop2SrcDelta = S.sources.length - before2;
    out.drop2Names = S.sources.slice(-2).map((s) => s.name);
    out.drop2Counts = S.sources.slice(-2).map((s) => itemsOf(s.id).length);

    /* ---------- ⑥ 散文件（没有顶层目录）→ 归入「拖入的图片」 ---------- */
    const loose = mkFile('散图.png', FILES[3].b64);
    const before3 = S.sources.length;
    out.drop3Ok = await L.fromDrop(mkDT([{ entry: fileEntry(loose), file: loose }]));
    out.drop3SrcDelta = S.sources.length - before3;
    out.drop3Name = S.sources.length > before3 ? lastSrc().name : null;

    /* ---------- ⑦ 反向用例：全是非图片 → 返回 false，不建来源 ---------- */
    const txt = new File(['not an image'], 'note.txt', { type: 'text/plain' });
    const before4 = S.sources.length;
    out.drop4Ok = await L.fromDrop(mkDT([{ entry: fileEntry(txt), file: txt }]));
    out.drop4SrcDelta = S.sources.length - before4;

    /* ---------- ⑧ 混合拖入：只收图片，非图片要丢掉 ----------
       注意散文件永远归入同一个来源名「拖入的图片」，而 commitSource 是**按名字刷新**
       而不是重复新增 —— 所以这里用名字定位来源，并顺带断言"刷新而非新增"。 */
    const png2 = mkFile('混合.png', FILES[4].b64);
    const pdf = new File(['%PDF-1.4'], '文档.pdf', { type: 'application/pdf' });
    const before5 = S.sources.length;
    out.drop5Ok = await L.fromDrop(mkDT([
      { entry: fileEntry(png2), file: png2 },
      { entry: fileEntry(pdf), file: pdf },
    ]));
    out.drop5SrcDelta = S.sources.length - before5;
    const s5 = S.sources.filter((s) => s.name === '拖入的图片')[0] || null;
    out.drop5Count = s5 ? itemsOf(s5.id).length : 0;
    out.drop5Names = s5 ? itemsOf(s5.id).map((it) => it.name) : [];
    out.drop5SourceCount = S.sources.filter((s) => s.name === '拖入的图片').length;

    out.finalSources = S.sources.map((s) => s.name);
    return out;
  })()`);

  console.log('DROP ' + JSON.stringify(out));
  app.quit();
}

app.whenReady().then(run).catch((e) => {
  console.error('ERR', (e && e.stack) || e);
  app.exit(1);
});
