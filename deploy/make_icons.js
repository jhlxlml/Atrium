/* ============================================================
   Atrium · 图标资产生成（多尺寸 PNG + ICO）
   ------------------------------------------------------------
   本机没有 ImageMagick / PIL / cairosvg / sharp（ps 里的 convert 是
   Windows 自带的 FAT→NTFS 工具，不能当 ImageMagick 用），也刻意不引入
   任何新依赖 —— 所以直接用项目自带的 Electron 渲染 SVG：

     主进程开一个隐藏窗口 → 渲染进程 canvas.drawImage(svg) → toDataURL
     → 主进程落盘 → 手写 ICO 容器（内嵌 PNG，Windows Vista+ 原生支持）

   小尺寸走 icon-small.svg（光学加粗稿），大尺寸走 icon.svg。

   用法（必须先 unset，否则 electron.exe 会退化成纯 Node 静默退出、无任何日志）：
     unset ELECTRON_RUN_AS_NODE NODE_OPTIONS
     "deploy/electron/node_modules/electron/dist/electron.exe" deploy/make_icons.js
   ============================================================ */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const BRAND = path.join(ROOT, 'brand');

/* 哪些尺寸用哪张源稿 —— 16/24/32 是任务栏与列表视图的真实用量，必须走加粗稿 */
const PLAN = [
  { size: 16, src: 'icon-small.svg' },
  { size: 24, src: 'icon-small.svg' },
  { size: 32, src: 'icon-small.svg' },
  { size: 48, src: 'icon.svg' },
  { size: 64, src: 'icon.svg' },
  { size: 128, src: 'icon.svg' },
  { size: 256, src: 'icon.svg' },
];

/* 在渲染进程里执行的取图代码。刻意不用模板字符串拼 —— 上次栽过
   "模板串里出现反引号即截断"的坑，这里统一用数组 join。 */
function renderJs(svgText, size) {
  return [
    '(function () {',
    '  return new Promise(function (resolve, reject) {',
    '    var svg = ' + JSON.stringify(svgText) + ';',
    '    var blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });',
    '    var url = URL.createObjectURL(blob);',
    '    var img = new Image();',
    '    img.onload = function () {',
    '      var c = document.createElement("canvas");',
    '      c.width = ' + size + '; c.height = ' + size + ';',
    '      var ctx = c.getContext("2d");',
    '      ctx.imageSmoothingEnabled = true;',
    '      ctx.imageSmoothingQuality = "high";',
    '      ctx.drawImage(img, 0, 0, ' + size + ', ' + size + ');',
    '      URL.revokeObjectURL(url);',
    '      resolve(c.toDataURL("image/png"));',
    '    };',
    '    img.onerror = function () { reject(new Error("svg decode failed")); };',
    '    img.src = url;',
    '  });',
    '})()',
  ].join('\n');
}

/* ICO 容器：6 字节头 + 每张 16 字节目录项 + 各图原始字节。
   宽高字段是 1 字节，因此 256 必须写 0（约定），其余写实际值。
   Vista 起支持直接内嵌 PNG，所以不解码、不重压，原样塞进去即可。 */
function buildIco(entries) {
  const n = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);          // reserved
  header.writeUInt16LE(1, 2);          // type = icon
  header.writeUInt16LE(n, 4);          // count

  const dir = Buffer.alloc(16 * n);
  let offset = 6 + 16 * n;
  entries.forEach(function (e, i) {
    const wh = e.size >= 256 ? 0 : e.size;
    dir.writeUInt8(wh, i * 16 + 0);          // width
    dir.writeUInt8(wh, i * 16 + 1);          // height
    dir.writeUInt8(0, i * 16 + 2);           // palette
    dir.writeUInt8(0, i * 16 + 3);           // reserved
    dir.writeUInt16LE(1, i * 16 + 4);        // color planes
    dir.writeUInt16LE(32, i * 16 + 6);       // bits per pixel
    dir.writeUInt32LE(e.buf.length, i * 16 + 8);
    dir.writeUInt32LE(offset, i * 16 + 12);
    offset += e.buf.length;
  });

  return Buffer.concat([header, dir].concat(entries.map(function (e) { return e.buf; })));
}

/* 载体页面必须是**本地文件**：Electron 33 拒绝对顶层做 data: URL 导航
   （ERR_FAILED -2），而 canvas 需要的是「页面自己创建的 blob: URL」——
   在 file:// 页面里 blob 继承站点身份，drawImage 不会污染画布，toDataURL 可用。 */
const CARRIER = path.join(BRAND, '_carrier.html');

/* XML 注释里不许出现连续两个减号，否则整个 SVG 直接被解析器拒绝。
   症状极具迷惑性：Image.onerror 只报一句 "svg decode failed"，
   而 favicon 那边则是静默不显示。这里在渲染前先拦住。 */
function assertSvgReadable(svgText, file) {
  const re = /<!--([\s\S]*?)-->/g;
  let m;
  while ((m = re.exec(svgText)) !== null) {
    if (m[1].indexOf('--') >= 0) {
      throw new Error(file + ' 的 XML 注释里含连续两个减号，XML 解析会失败（改成 · 或分开写）');
    }
  }
}

async function run() {
  fs.writeFileSync(CARRIER, '<!DOCTYPE html><html><body></body></html>', 'utf8');

  const win = new BrowserWindow({
    show: false,
    width: 480, height: 360,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  try {
    await win.loadFile(CARRIER);

    const entries = [];
    for (const p of PLAN) {
      const svgText = fs.readFileSync(path.join(BRAND, p.src), 'utf8');
      assertSvgReadable(svgText, p.src);
      const dataUrl = await win.webContents.executeJavaScript(renderJs(svgText, p.size), true);
      const buf = Buffer.from(String(dataUrl).split(',')[1], 'base64');
      entries.push({ size: p.size, buf: buf });
      console.log('  ' + String(p.size).padStart(3) + 'px  ' + p.src.padEnd(16) + '  ' + buf.length + ' bytes');
    }

    for (const e of entries) {
      fs.writeFileSync(path.join(BRAND, 'icon-' + e.size + '.png'), e.buf);
    }

    const ico = buildIco(entries);
    fs.writeFileSync(path.join(BRAND, 'icon.ico'), ico);
    console.log('');
    console.log('OK  brand/icon.ico  ' + ico.length + ' bytes  (' + entries.length + ' sizes: ' +
      entries.map(function (e) { return e.size; }).join('/') + ')');
  } finally {
    win.destroy();
    try { fs.unlinkSync(CARRIER); } catch (e) { /* 已删或未建，都无所谓 */ }
  }
}

/* 刻意**不**调用 app.disableHardwareAcceleration()：本机实测它会让渲染进程
   起不来，loadFile 直接 ERR_FAILED(-2)（GPU 进程反复 0xC0000005）。
   图标是静态图，默认软/硬渲染都无所谓。

   --no-sandbox：与项目自检（run_probe.js 的 runAppSelftest）同款。本机沙箱下
   渲染进程起不来，加载本地页面一律 ERR_FAILED(-2)。 */
app.commandLine.appendSwitch('no-sandbox');

app.whenReady().then(function () {
  run()
    .then(function () { app.exit(0); })
    .catch(function (err) {
      console.error('FAIL ' + ((err && err.stack) || err));
      app.exit(1);
    });
});

/* 兜底：Electron 里 app.whenReady() 之外的同步异常会静默挂死（只见超时无日志） */
process.on('uncaughtException', function (err) {
  console.error('UNCAUGHT ' + ((err && err.stack) || err));
  app.exit(1);
});
