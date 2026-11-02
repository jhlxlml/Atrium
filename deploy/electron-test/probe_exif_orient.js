/* ============================================================
   EXIF 方向探针：屏幕代理（灯箱的"代"）会不会把旋转过的照片压扁？

   背景：`decodeThumb()` 里给 createImageBitmap 传的是
     resizeWidth = round(tw*s)、resizeHeight = round(th*s)
   而 tw/th 来自**文件头**（未旋转的原始宽高）。
   同时它又传了 `imageOrientation: 'from-image'` —— 解码器会先把图转正，
   再按给定尺寸缩放。于是一张 3840×2400、EXIF Orientation=6（顺时针 90°）
   的照片：解码后是 2400×3840 的竖图，却被要求缩成 2560×1600 的横图，
   宽高比从 0.625 被拉成 1.6 —— 画面被横向拉宽、纵向压扁。

   这个探针用真实 exe 跑同一张图的两种版本：
     · rot6.jpg  —— 与 plain.jpg 完全相同的像素，只多一个 Orientation=6
     · plain.jpg —— 对照组（无 EXIF）
   然后报告灯箱里那张图**实际解码出来的**尺寸与宽高比。

   判据：
     · 修复前：rot6 的 blob 宽高比 ≈ plain 的宽高比（1.6），但正确值应是 0.625
     · 修复后：rot6 的 blob 是竖的（h > w），宽高比 ≈ 0.625

   用法： node probe_exif_orient.js <目录> [宽] [高]
   ============================================================ */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const EXE = path.join(ROOT, 'deploy', 'dist-electron', 'Atrium_Electron版', 'Atrium.exe');
const DIR = process.argv[2];
const W = +(process.argv[3] || 1600);
const H = +(process.argv[4] || 900);
const PORT = 9700 + Math.floor(Math.random() * 200);

if (!DIR) {
  console.error('用法: node probe_exif_orient.js <目录> [宽] [高]');
  process.exit(2);
}
if (!fs.existsSync(EXE)) {
  console.error('找不到打包产物：' + EXE + '\n先跑 npm run build');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 等 CDP 目标出现。失败时把最后一次错误带出来 —— 否则只会看到"等不到"。 */
async function waitTarget(ms) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (e) { lastErr = e; }
    await sleep(200);
  }
  throw new Error('等不到 CDP 目标（' + (lastErr ? lastErr.message : '无异常，但一直没有 page') + '）');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const waiting = new Map();
    ws.onopen = () => resolve({
      eval(expression) {
        return new Promise((res, rej) => {
          const myId = ++id;
          waiting.set(myId, { res, rej });
          ws.send(JSON.stringify({
            id: myId, method: 'Runtime.evaluate',
            params: { expression, awaitPromise: true, returnByValue: true },
          }));
          setTimeout(() => { if (waiting.has(myId)) { waiting.delete(myId); rej(new Error('eval 超时')); } }, 120000);
        });
      },
      close() { try { ws.close(); } catch (e) {} },
    });
    ws.onerror = () => reject(new Error('WebSocket 连不上'));
    ws.onmessage = (ev) => {
      let m = null;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m.id || !waiting.has(m.id)) return;
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.result && m.result.exceptionDetails) {
        w.rej(new Error((m.result.exceptionDetails.exception || {}).description || '页面内异常'));
      } else {
        w.res(m.result && m.result.result ? m.result.result.value : null);
      }
    };
  });
}

const PAGE = `(async () => {
  const items = State.activeItems();
  const find = (needle) => items.find((m) => String(m.name).indexOf(needle) >= 0);
  const rot = find('rot6'), plain = find('plain');
  if (!rot || !plain) return { error: '目录里缺 rot6.jpg / plain.jpg', names: items.map(m => m.name) };

  /* 关键：**直接调代理生成**。
     打开灯箱时"当前这张"是不生成代的（lightbox.js: 512 起那段注释），
     所以从 UI 上看不出代理有没有把旋转搞错 —— 必须直接问 Thumbs。 */
  const prox = async (m, cssW) => {
    const r = await Thumbs.screenURL(m, cssW);
    /* 记录的字段是 {url, side, w, h, tw, th, full}：w/h 是这一代的实际像素尺寸 */
    return r ? { side: r.side, full: !!r.full, w: r.w, h: r.h, tw: r.tw, th: r.th,
                 ar: (r.w && r.h) ? +(r.w / r.h).toFixed(3) : null,
                 url: String(r.url).slice(0, 5) } : null;
  };

  const before = { rotWH: [rot.w, rot.h], plainWH: [plain.w, plain.h] };
  const pRot = await prox(rot, 800);
  const pPlain = await prox(plain, 800);

  const shot = async (m) => {
    Lightbox.open(items, m);
    for (let i = 0; i < 240; i++) {
      await new Promise(r => setTimeout(r, 50));
      const im = Lightbox.img;
      if (im && im.naturalWidth > 0 && Lightbox._full) break;
    }
    const im = Lightbox.img;
    return { name: m.name, shownWH: [im.naturalWidth, im.naturalHeight] };
  };
  const a = await shot(rot);
  const b = await shot(plain);
  Lightbox.close();
  return { before, proxyRot6: pRot, proxyPlain: pPlain, shown: { rot6: a, plain: b },
           dpr: devicePixelRatio, view: [innerWidth, innerHeight] };
})()`;

(async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-exif-'));
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;   // 本机环境里它是常驻的，不清掉会进 node 模式
  delete env.NODE_OPTIONS;
  env.VF_USERDATA = ud;

  /* --no-sandbox 只用于测试环境：这台机器没有可用的 GPU 进程
     （GPU process isn't usable. Goodbye.），不开它窗口起不来。
     正式版不带这个参数 —— main.js 里有断言守着。 */
  const child = spawn(EXE, [
    '--open-dir', DIR,
    '--remote-debugging-port=' + String(PORT),
    '--no-sandbox',
    '--window-size=' + W + ',' + H,
  ], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  let out = null;
  try {
    const page = await waitTarget(60000);
    const c = await connect(page.webSocketDebuggerUrl);
    /* 等索引完成 */
    for (let i = 0; i < 120; i++) {
      const n = await c.eval('(window.State && State.activeItems) ? State.activeItems().length : -1');
      if (n >= 2) break;
      await sleep(200);
    }
    out = await c.eval(PAGE);
    c.close();
  } catch (e) {
    out = { error: e.message };
  }

  try { child.kill(); } catch (e) {}
  await sleep(600);
  try { fs.rmSync(ud, { recursive: true, force: true }); } catch (e) {}

  if (out && out.proxyRot6 && out.proxyPlain) {
    const ok = out.proxyRot6.h > out.proxyRot6.w;   // 竖图才说明方向被应用
    out.verdict = ok
      ? 'OK：rot6 的代是竖的（' + out.proxyRot6.w + '×' + out.proxyRot6.h + '），方向与宽高比都对'
      : 'BUG：rot6 的代仍是横的（' + out.proxyRot6.w + '×' + out.proxyRot6.h + '），内容被拉伸压扁';
    out.plainAR = out.proxyPlain.ar;
  }
  console.log(JSON.stringify(out, null, 2));
  if (!out || out.error) {
    console.error('--- stderr 前 20 行 ---');
    console.error(stderr.split('\n').slice(0, 20).join('\n'));
    process.exit(1);
  }
})();
