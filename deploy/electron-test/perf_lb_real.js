/* 灯箱切图性能实测 —— 跑在**打包后的真实应用**里（CDP 驱动）。
 *
 * 为什么不用 `probe_lb_perf.js`：那个探针是源码态、禁了 GPU、窗口 1440×900，
 * 量出来的数字不能直接代表用户看到的。这里用 `--remote-debugging-port` 连上
 * 真的 exe，同样的 GPU 设置、同样的窗口尺寸、同样的索引流程。
 *
 * 用法：
 *   node perf_lb_real.js <目录> [窗口宽] [窗口高]
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
/* 允许指向**别的构建**：做版本 A/B 时（比如和 v1.13.0 比）不必覆盖当前产物。
   例：LB_PERF_EXE=D:/tmp/1130/Atrium.exe node perf_lb_real.js <目录> */
const EXE = process.env.LB_PERF_EXE
  || path.join(ROOT, 'deploy', 'dist-electron', 'Atrium_Electron版', 'Atrium.exe');
const DIR = process.argv[2];
const W = +(process.argv[3] || 2560);
const H = +(process.argv[4] || 1400);
const PORT = 9333 + (Date.now() % 200);

if (!DIR) { console.error('用法: node perf_lb_real.js <目录> [宽] [高]'); process.exit(2); }
if (!fs.existsSync(EXE)) { console.error('找不到 exe: ' + EXE); process.exit(2); }

const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-perf-'));
const env = Object.assign({}, process.env, { VF_USERDATA: ud });
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

const child = spawn(EXE, [
  '--open-dir', DIR,
  '--remote-debugging-port=' + PORT,
  '--no-sandbox',
  '--window-size=' + W + ',' + H,
], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

let logs = '';
child.stdout.on('data', (d) => { logs += d.toString(); });
child.stderr.on('data', (d) => { logs += d.toString(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(p) {
  const r = await fetch('http://127.0.0.1:' + PORT + p);
  return r.json();
}

async function waitTarget() {
  for (let k = 0; k < 100; k++) {
    try {
      const list = await getJSON('/json/list');
      const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url || ''));
      if (page) return page;
    } catch (e) { /* 还没起来 */ }
    await sleep(300);
  }
  throw new Error('等不到 CDP 目标');
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
      if (r.exceptionDetails) {
        throw new Error('页面内异常: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
      }
      return r.result.value;
    },
    close() { try { ws.close(); } catch (e) { } },
  };
}

/* 与 probe_lb_perf.js 同一套量法，但"看得见"改用 img.decode() 判定。
 *
 * 教训：一开始读的是 `getComputedStyle(img).opacity` + `getBoundingClientRect()`。
 * 那两样在 `onload` 之后就立刻成立（类已加上、布局按 intrinsic size 算好了），
 * **可位图还没解码完** —— 于是 24MP 的图被报成 50ms"可见"，而裸 <img> 实测解码
 * 就要 122ms。用户看到的白/转圈时间根本没被量进去。
 * `img.decode()` 的 resolve 时刻才是"像素可以上屏"，这里以它为准。
 */
const MEASURE = (delta) => `(async () => {
  const L = window.Lightbox, img = document.getElementById('lbImg');
  const t0 = performance.now();
  const lt = [];
  let po = null;
  try {
    po = new PerformanceObserver((l) => { for (const e of l.getEntries()) lt.push(Math.round(e.duration)); });
    po.observe({ entryTypes: ['longtask'] });
  } catch (e) {}
  let tLoad = null;
  const onLoad = () => { tLoad = +(performance.now() - t0).toFixed(1); };
  img.addEventListener('load', onLoad, { once: true });
  const target = L.list[L.i + (${delta})];
  L.nav(${delta});
  const tNav = +(performance.now() - t0).toFixed(1);

  // 等 load（数据到位），再单独量解码
  const t1 = performance.now();
  await new Promise((resolve) => {
    if (img.complete && img.naturalWidth > 0) return resolve();
    const done = () => resolve();
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
    setTimeout(done, 15000);
  });
  const tReady = +(performance.now() - t0).toFixed(1);
  let tDecode = null;
  try {
    const d0 = performance.now();
    await img.decode();
    tDecode = +(performance.now() - d0).toFixed(1);
  } catch (e) { tDecode = -1; }
  const tPixels = +(performance.now() - t0).toFixed(1);

  /* 分开量"这一帧排到没有"和"画出去没有"：
     tFrame1 = decode 之后到**下一帧回调**，这段含布局/光栅提交；
     tPainted = 再等一帧，这段含合成/上屏。
     两者差得远时，慢的是合成器（滤镜、大图层、阴影），不是解码。 */
  const tFrame1 = await new Promise((r) => requestAnimationFrame(
    () => r(+(performance.now() - t0).toFixed(1))));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const tPainted = +(performance.now() - t0).toFixed(1);
  if (po) po.disconnect();
  return { tNav, tLoad, tReady, tDecode, tPixels, tFrame1, tPainted,
           natW: img.naturalWidth, natH: img.naturalHeight,
           boxW: Math.round(img.getBoundingClientRect().width),
           name: target && target.name, longtasks: lt };
})()`;

(async () => {
  const out = { dir: DIR, win: W + 'x' + H };
  try {
    const target = await waitTarget();
    const c = cdp(target.webSocketDebuggerUrl);
    await c.ready;
    await c.send('Runtime.enable');

    /* 等索引完成：真实应用要先扫目录、建条目 */
    let items = 0;
    for (let k = 0; k < 120; k++) {
      items = await c.eval('(window.State && State.items ? State.items.length : 0)');
      if (items >= 2) break;
      await sleep(500);
    }
    out.items = items;
    out.vw = await c.eval('innerWidth + "x" + innerHeight');
    out.gpu = await c.eval(`(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl');
      const d = gl && gl.getExtension('WEBGL_debug_renderer_info');
      return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'no-webgl';
    })()`);

    /* 可选：注入一段 CSS 再量 —— 用来做"某个样式到底花多少钱"的 A/B。
       例：LB_PERF_CSS='*{backdrop-filter:none!important}' */
    if (process.env.LB_PERF_CSS) {
      await c.eval(`(() => {
        const st = document.createElement('style');
        st.id = 'perf-override';
        st.textContent = ${JSON.stringify(process.env.LB_PERF_CSS)};
        document.head.appendChild(st);
        return true;
      })()`);
      out.cssOverride = process.env.LB_PERF_CSS;
    }

    /* 打开灯箱，等它彻底稳定 */
    await c.eval(`(async () => {
      const L = window.Lightbox;
      L.open(State.items, State.items[0]);
      await new Promise((r) => setTimeout(r, 3000));
      return { open: L.isOpen(), strip: document.getElementById('lbStrip').children.length };
    })()`);
    out.openState = await c.eval(`({ open: Lightbox.isOpen(),
      strip: document.getElementById('lbStrip').children.length,
      stripHidden: document.getElementById('lbStrip').hidden,
      n: Lightbox.list.length })`);

    /* 冷路径：往前切 4 次 */
    out.cold = [];
    for (let k = 0; k < Math.min(4, items - 1); k++) {
      out.cold.push(await c.eval(MEASURE(1)));
    }
    /* 热路径：回到第 0 张再来一遍 */
    await c.eval(`(async () => { Lightbox.open(Lightbox.list, Lightbox.list[0]);
      await new Promise((r) => setTimeout(r, 3000)); return true; })()`);
    out.warm = [];
    for (let k = 0; k < Math.min(4, items - 1); k++) {
      out.warm.push(await c.eval(MEASURE(1)));
    }
    /* 反向切（上一张）：很多人习惯往回翻。
       **注意这一段量的是"快翻"，不是"回头看"**：每步量完（几十到几百毫秒）就立刻翻下一张，
       而 v1.20.6 的停留预取阈值是 900ms —— 这里的间隔根本到不了，预取永远来不及跑完。
       所以这一段每帧都是"干净的原图解码"，退回到 v1.13.0 的水平，这是设计取舍，不是退化。
       真正的"回头看"在下面的 dwellBack 段。 */
    out.back = [];
    for (let k = 0; k < 3; k++) {
      out.back.push(await c.eval(MEASURE(-1)));
    }

    /* 停留后回翻 —— 这才是"看完一张再往回翻"的真实节奏。
       先往前翻一张并**停 1.6 秒**（> 900ms 阈值），让停留预取把相邻两张的代备好，
       然后再往回翻：此时上一张的代应该已经在内存里，解码只要 2–15ms。
       这一段是 v1.20.6 相对 v1.13.0 的**净收益**所在（v1.13.0 完全没预取）。 */
    out.dwellBack = [];
    for (let k = 0; k < 2; k++) {
      await c.eval(`(async () => {
        Lightbox.nav(1);
        await new Promise((r) => setTimeout(r, 1600));
        return true;
      })()`);
      out.dwellBack.push(await c.eval(MEASURE(-1)));
    }

    /* 真实浏览节奏：**每张看 1.5 秒再翻**。
       这是最有代表性的一段 —— 用户看照片本来就是停下来的：
       翻到一张 → 看一两秒 → 翻下一张。1.5 秒 > 900ms 的停留阈值，
       所以每张的代都会在后台被备好；但 48MP 生成一代要 600ms 以上，
       1.5 秒够不够、会不会正好压在下一次切图上，只有这一段能量出来。
       前面 cold / warm / back 三段都是"每 0.2 秒连翻"，属于极端快翻，
       不代表日常使用，只用来量"最坏情况下不许比 v1.13.0 慢"。 */
    out.browse = [];
    for (let k = 0; k < Math.min(4, items - 1); k++) {
      out.browse.push(await c.eval(MEASURE(1)));
      await c.eval(`new Promise((r) => setTimeout(r, 1500))`);
    }
    c.close();
  } catch (e) {
    out.error = String((e && e.message) || e);
  } finally {
    try { child.kill(); } catch (e) { }
    await sleep(600);
    try { fs.rmSync(ud, { recursive: true, force: true }); } catch (e) { }
    if (logs.trim()) out.appLog = logs.split('\n').filter(Boolean).slice(-6);
    console.log('REALPERF ' + JSON.stringify(out, null, 1));
  }
})();
