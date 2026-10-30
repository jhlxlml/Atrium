/* ============================================================
   Atrium · 「打开灯箱」的后台开销实测（真实 exe）
   ------------------------------------------------------------
   量的是"长期浏览资源浪费"这一条：打开一个 1000 张的文件夹，进灯箱看一眼
   就退出 —— 灯箱的缩略图条会为**全部 1200 个槽位**逐个发起缩略图请求。
   每张都要从磁盘读一遍文件、解码、编码，于是"只看一张"的代价是"解码 1000 张"。

   指标：
     openMs        点开灯箱到第一张出像素
     thumbsDecoded 打开后 T 毫秒内新增的缩略图解码次数（stats.decodes 增量）
     longTasks     T 毫秒内 >50ms 的主线程长任务个数与总时长
     queueMax      Thumbs 调度队列的最大等待长度（没有该指标时记为 -1）
     stripFilled   条带里真的被填了 src 的槽位数

   用法： node perf_lb_strip.js <目录> [宽] [高] [观察ms] [strip]
     第 6 个参数写 `strip` 表示"打开灯箱时就把缩略图条展开"（默认是收起的，
     此时按需填充应当一个缩略图都不解 —— 这是改造后的预期行为）。
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
const WATCH = +(process.argv[5] || 3000);
const OPEN_STRIP = process.argv[6] === 'strip';
const PORT = 10100 + (Date.now() % 300);

if (!DIR) { console.error('用法: node perf_lb_strip.js <目录> [宽] [高] [观察ms]'); process.exit(2); }
if (!fs.existsSync(EXE)) { console.error('找不到 exe: ' + EXE); process.exit(2); }

const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-strip-'));
const env = Object.assign({}, process.env, { VF_USERDATA: ud });
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

const child = spawn(EXE, [
  '--open-dir', DIR, '--remote-debugging-port=' + PORT, '--no-sandbox',
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
async function getJSON(p) { const r = await fetch('http://127.0.0.1:' + PORT + p); return r.json(); }
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
      return new Promise((res, rej) => { pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
    },
    async eval(expr) {
      const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) throw new Error('页面内异常: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
      return r.result.value;
    },
    close() { try { ws.close(); } catch (e) { } },
  };
}

const PAGE = `(async () => {
  const L = window.Lightbox, T = window.Thumbs, img = document.getElementById('lbImg');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const LIST = window.State.items;
  if (!LIST || LIST.length < 2) return { items: LIST ? LIST.length : -1 };

  /* 长任务观察器：连"解码 1000 张缩略图"这种后台活都会以 long task 的形式
     抢主线程，用户感知就是"进灯箱卡一下、翻页也跟着顿"。 */
  const lt = [];
  let po = null;
  try {
    po = new PerformanceObserver((l) => { for (const e of l.getEntries()) lt.push(Math.round(e.duration)); });
    po.observe({ entryTypes: ['longtask'] });
  } catch (e) {}

  /* 条带是否展开会彻底改变这件事的性质：收起时按需填充应当一个都不解 */
  L.autoStrip = ${OPEN_STRIP};
  const s0 = T.stats();
  const t0 = performance.now();
  L.open(LIST, LIST[0]);
  const openCallMs = +(performance.now() - t0).toFixed(1);

  /* 第一张出像素 */
  let firstMs = null;
  for (let k = 0; k < 800; k++) {
    if (img.naturalWidth > 0) { firstMs = +(performance.now() - t0).toFixed(1); break; }
    await wait(10);
  }
  /* 「用户真正能看见的那一段」多久填满 —— 这才是条带的手感指标。
     全量填了多少个只说明后台还愿不愿意干活，不说明用户等多久。 */
  const slots = L._stripSlots || [];
  const has = (k) => !!(slots[k] && slots[k].img && slots[k].img.getAttribute('src'));
  const visCount = Math.min(slots.length, Math.max(8, Math.round(
    (document.getElementById('lbStrip').clientWidth || 800) / 64)));
  let visibleReadyMs = null;
  const tVis = performance.now();
  while (performance.now() - tVis < ${WATCH}) {
    let all = true;
    for (let k = 0; k < visCount; k++) if (!has(k)) { all = false; break; }
    if (all) { visibleReadyMs = +(performance.now() - t0).toFixed(1); break; }
    await wait(50);
  }
  await wait(300);
  const s1 = T.stats();
  let filled = 0;
  for (const s of slots) if (s && s.img && s.img.getAttribute('src')) filled++;
  if (po) { try { po.disconnect(); } catch (e) {} }
  const ltSum = lt.reduce((a, b) => a + b, 0);
  return {
    items: LIST.length, slots: slots.length, filled, visCount, visibleReadyMs,
    openCallMs, firstMs, stripOpen: ${OPEN_STRIP},
    thumbsDecoded: s1.decodes - s0.decodes,
    screenMakes: s1.screenMakes - s0.screenMakes,
    longTasks: lt.length, longTaskMs: ltSum, longTaskMax: lt.length ? Math.max(...lt) : 0,
    stats: s1,
    queue: (T.schedStats ? T.schedStats() : null),
  };
})()`;

(async () => {
  let out = null;
  let code = 0;
  try {
    const target = await waitTarget();
    const c = cdp(target.webSocketDebuggerUrl);
    await c.ready;
    await c.send('Runtime.enable');
    for (let k = 0; k < 200; k++) {
      const n = await c.eval('(window.State && State.items ? State.items.length : 0)');
      if (n >= 2) break;
      await sleep(250);
    }
    await sleep(1200);          // 让网格先稳定下来，避免把"首屏网格解码"算进灯箱账上
    out = Object.assign({ dir: DIR, w: W, h: H, watchMs: WATCH, stripOpen: OPEN_STRIP }, await c.eval(PAGE));
  } catch (e) {
    out = { error: String((e && e.message) || e) };
    code = 1;
  }
  console.log('LBSTRIP ' + JSON.stringify(out, null, 1));
  if (childErr && out && out.error) console.log('--- stderr ---\n' + childErr.slice(-1500));
  try { child.kill(); } catch (e) { }
  await sleep(300);
  process.exit(code);
})();
