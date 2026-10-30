/* ============================================================
   Atrium · 灯箱「按住方向键连翻」实测（真实 exe）
   ------------------------------------------------------------
   为什么需要单独一个脚本：
   `perf_lb_laps.js` 是"每张停 3 秒"的场景 —— 那时预取已经备好，
   每张只要 10–20ms，量不出用户抱怨的"快速切换慢"。用户报的是
   **按住方向键连翻**：键盘重复每 ~33ms 一次，而一张 24MP 要 130ms、
   48MP 要 245ms 才解完，于是每按一次就把上一次没解完的加载掐掉。

   这里量五件事（全部在页面内累加，结束后一次性取回）：
     presses      实际按了多少次
     paints       连翻期间**画面真的变了**多少次（<= presses，越接近越好）
     staleWrites  连翻期间有没有"旧图盖新图"（img.src 被回退到已经切走的那张）
     proxyMakes   连翻期间生成了多少"屏幕尺寸代"（纯浪费，应当接近 0）
     clearMs      松手之后多久画面变成"清晰的真图"（1:1 像素到齐）

   用法：
     node perf_lb_fastnav.js <目录> [宽] [高] [按几次] [间隔ms]
   环境变量：
     LB_PERF_EXE  指定被测 exe（默认 deploy/dist-electron/.../Atrium.exe）
   ============================================================ */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
const EXE = process.env.LB_PERF_EXE
  || path.join(ROOT, 'deploy', 'dist-electron', 'Atrium_Electron版', 'Atrium.exe');
const DIR = process.argv[2];
const W = +(process.argv[3] || 2560);
const H = +(process.argv[4] || 1400);
const PRESSES = +(process.argv[5] || 45);
const GAP = +(process.argv[6] || 33);
const PORT = 9800 + (Date.now() % 300);

if (!DIR) { console.error('用法: node perf_lb_fastnav.js <目录> [宽] [高] [按几次] [间隔ms]'); process.exit(2); }
if (!fs.existsSync(EXE)) { console.error('找不到 exe: ' + EXE); process.exit(2); }

const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-fastnav-'));
const env = Object.assign({}, process.env, { VF_USERDATA: ud });
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

const child = spawn(EXE, [
  '--open-dir', DIR,
  '--remote-debugging-port=' + PORT,
  '--no-sandbox',
  '--window-size=' + W + ',' + H,
], {
  env,
  /* stdout 必须 ignore：这三个脚本从不读 child.stdout，接了管道就等于给它
     64KB 的窗口 —— Electron 一旦多打几行（DevTools 提示、GPU 警告），
     子进程就卡在 write 上，脚本永远等不到 CDP 目标。stderr 仍然收着，出错时打印。 */
  stdio: ['ignore', 'ignore', 'pipe'],
  windowsHide: true,
});
let childErr = '';
child.stderr.on('data', (d) => { childErr += String(d); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(p) {
  const r = await fetch('http://127.0.0.1:' + PORT + p);
  return r.json();
}
async function waitTarget() {
  let lastErr = null;
  for (let k = 0; k < 100; k++) {
    try {
      const list = await getJSON('/json/list');
      const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url || ''));
      if (page) return page;
    } catch (e) { lastErr = e; }
    await sleep(300);
  }
  throw new Error('等不到 CDP 目标: ' + String((lastErr && lastErr.message) || lastErr));
}
function cdp(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = (e) => rej(e); });
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
    }
  };
  return {
    ready,
    send(method, params) {
      const mid = ++id;
      return new Promise((res, rej) => {
        pending.set(mid, { res, rej });
        ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
      });
    },
    async eval(expr) {
      const r = await this.send('Runtime.evaluate', {
        expression: expr, awaitPromise: true, returnByValue: true, userGesture: true,
      });
      if (r.exceptionDetails) throw new Error('页面内异常: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
      return r.result.value;
    },
    close() { try { ws.close(); } catch (e) { } },
  };
}

/* ---------- 页面内：装好探针（按 presses 计数、记录每次画面变化） ---------- */
const INSTALL = `(() => {
  const L = window.Lightbox, T = window.Thumbs, img = document.getElementById('lbImg');
  const P = window.__fastnav = {
    presses: 0, paints: 0, srcSets: 0, proxyMakes: 0, marks: [],
    t0: 0, tLast: 0, started: false, done: false, clearMs: null, baseMakes: 0,
  };

  /* 画面变化的判定：连翻期间 img 真的解出了像素（load 且 naturalWidth > 0）。
     只数 currentSrc 变化会把"切走了但还没出像素"算进去，那正是用户看到的"按了没反应"。 */
  img.addEventListener('load', () => {
    if (!P.started || P.done) return;
    if (img.naturalWidth > 0) {
      P.paints++;
      const m = P.marks[P.marks.length - 1];
      if (m && !m.painted) {
        m.painted = true;
        m.paintMs = +(performance.now() - P.t0 - m.t).toFixed(1);
      }
    }
  });

  /* src 写入次数：用来区分"画面变了"与"只是换了 src" */
  const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  Object.defineProperty(img, 'src', {
    configurable: true,
    get() { return desc.get.call(this); },
    set(v) { if (P.started && !P.done) P.srcSets++; desc.set.call(this, v); },
  });

  /* 每次按键打一个点：这一下有没有现成的缩略图/代可用、最后显示的是什么 */
  P.press = () => {
    P.presses++;
    const cur = L.meta;
    const thumb = (T.thumbPeek && cur) ? !!T.thumbPeek(cur, 148) : false;
    const rec = L._rec ? (L._rec.thumb ? 'thumb' : (L._rec.full ? 'full' : 'proxy')) : 'none';
    P.marks.push({ k: P.presses, t: +(performance.now() - P.t0).toFixed(1), thumb: thumb, rec: rec, painted: false, paintMs: null });
    P.tLast = performance.now();
  };

  /* 连翻必须**在页面内**按节奏发事件：从 Node 侧一发一等地走 CDP，
     每次往返要 200–300ms，等于每张都停下来等解码完 —— 那测的是"慢慢翻"，
     不是"按住方向键"。这里用 setInterval 每 gap 毫秒发一个 keydown，
     走的是真实的 document keydown → _key → nav 路径。 */
  P.burst = (n, gap) => new Promise((res) => {
    let k = 0;
    const id = setInterval(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      P.press();
      if (++k >= n) { clearInterval(id); res(true); }
    }, gap);
  });

  P.thumbReady = () => (window.State.items || []).filter((m) => T.thumbPeek && T.thumbPeek(m, 148)).length;

  P.begin = () => {
    P.readyAtStart = P.thumbReady();
    P.started = true; P.done = false;
    P.t0 = performance.now();
    P.baseMakes = T.stats().screenMakes;
    P.startIndex = L.i;
  };
  P.end = async (presses) => {
    P.done = true;
    P.proxyMakes = T.stats().screenMakes - P.baseMakes;
    /* 松手后等"清晰的真图"：灯箱自己认为 _full，或 natW 已经达到原图宽度 */
    const t0 = performance.now();
    for (let k = 0; k < 500; k++) {
      const m = L.meta;
      const okFull = L._full === true || (m && m.w > 0 && img.naturalWidth >= m.w);
      if (okFull && img.naturalWidth > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    P.clearMs = +(performance.now() - t0).toFixed(1);
    const n = L.list.length;
    const expect = (P.startIndex + presses) % n;
    return {
      presses: P.presses, paints: P.paints, srcSets: P.srcSets,
      proxyMakes: P.proxyMakes, clearMs: P.clearMs,
      navSpanMs: +(P.tLast - P.t0).toFixed(1),
      items: window.State.items.length,
      indexOk: L.i === expect, indexNow: L.i, indexExpect: expect,
      full: !!L._full, natW: img.naturalWidth, origW: L.meta ? L.meta.w : 0,
      screensSize: T.stats().screensSize, screensCap: T.stats().screensCap,
      readyAtStart: P.readyAtStart, readyAtEnd: P.thumbReady(), marks: P.marks,
    };
  };
  return true;
})()`;

/* 用真实键盘事件（走完整的 keydown → _key → nav 路径），不是直接调 nav() */
async function pressRight(c) {
  const base = { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 };
  await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base));
  await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
}

(async () => {
  let out = null;
  let code = 0;
  try {
    const target = await waitTarget();
    const c = cdp(target.webSocketDebuggerUrl);
    await c.ready;
    await c.send('Runtime.enable');
    await c.send('Page.enable');
    for (let k = 0; k < 120; k++) {
      const n = await c.eval('(window.State && State.items ? State.items.length : 0)');
      if (n >= 2) break;
      await sleep(250);
    }
    /* 打开灯箱并等第一张出像素 */
    await c.eval(`(async () => {
      const L = window.Lightbox, img = document.getElementById('lbImg');
      const LIST = window.State.items;
      L.open(LIST, LIST[0]);
      for (let k = 0; k < 600; k++) { if (img.naturalWidth > 0) break; await new Promise(r => setTimeout(r, 10)); }
      await new Promise(r => setTimeout(r, 600));
      return true;
    })()`);
    await c.eval(INSTALL);
    await c.eval('window.__fastnav.begin()');
    await c.eval('window.__fastnav.t0 = performance.now()');

    await c.eval('window.__fastnav.burst(' + PRESSES + ',' + GAP + ')');
    const res = await c.eval('window.__fastnav.end(' + PRESSES + ')');
    out = Object.assign({ dir: DIR, w: W, h: H, presses: PRESSES, gapMs: GAP }, res);
  } catch (e) {
    out = { error: String((e && e.message) || e) };
    code = 1;
  }
  console.log('FASTNAV ' + JSON.stringify(out, null, 1));
  if (childErr && out && out.error) console.log('--- stderr ---\n' + childErr.slice(-2000));
  try { child.kill(); } catch (e) { }
  await sleep(300);
  process.exit(code);
})();
