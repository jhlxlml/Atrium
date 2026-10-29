/* 只测「每张停 3 秒、来回两圈」这一件事，且**全程在页面内跑完**再一次性返回。
 *
 * 为什么另起一个脚本（v1.20.9）：`perf_lb_real.js` 里那套是「一张一次 CDP 往返」，
 * 一旦某一张的 `load` 事件不来，`awaitPromise` 就把整条链挂住 —— 实测跑了 17 分钟
 * 还没结束，什么数据都拿不到。这里改成：
 *   1) 每张的等待都有 `Promise.race` 超时兜底，**永远会往下走**；
 *   2) 每张的结论先塞进页面内的数组，跑完一次性取回，中途挂住也还剩前几张；
 *   3) 表直接在页面里拼成字符串，Node 侧只负责打印。
 *
 * 用法：node perf_lb_laps.js <目录> [宽] [高] [每张停的毫秒数]
 */
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
const DWELL = +(process.argv[5] || 3000);
const PORT = 9500 + (Date.now() % 300);

if (!DIR) { console.error('用法: node perf_lb_laps.js <目录> [宽] [高] [停留ms]'); process.exit(2); }
if (!fs.existsSync(EXE)) { console.error('找不到 exe: ' + EXE); process.exit(2); }

const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-laps-'));
const env = Object.assign({}, process.env, { VF_USERDATA: ud });
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

const child = spawn(EXE, [
  '--open-dir', DIR,
  '--remote-debugging-port=' + PORT,
  '--no-sandbox',
  '--window-size=' + W + ',' + H,
], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

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

const PAGE = `(async () => {
  const L = window.Lightbox, T = window.Thumbs, img = document.getElementById('lbImg');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const DWELL = ${DWELL};
  const lines = [];

  /* 列表只能从 State.items 取 —— Lightbox.list 要等 open() 之后才有值。
     第一版写成 L.list.forEach 就得到"条目 0"，什么也没测到。 */
  const LIST = window.State.items;
  if (!LIST || LIST.length < 2) return { items: LIST ? LIST.length : -1, lines: '条目不足', laps: [] };

  /* 等一张图真的出像素。**永远有超时**：宁可记一个 timeout，也不能把整条链挂死。 */
  const waitPix = (ms) => Promise.race([
    new Promise((r) => {
      if (img.complete && img.naturalWidth > 0) return r('now');
      const done = (why) => { img.removeEventListener('load', ok); img.removeEventListener('error', bad); r(why); };
      const ok = () => done('load');
      const bad = () => done('error');
      img.addEventListener('load', ok);
      img.addEventListener('error', bad);
      setTimeout(() => done('timeout'), ms);
    }),
  ]);

  /* decode() 也必须兜超时：它对一张"还在加载、且加载被后续 src 顶掉"的图
     可能永远不 settle —— 上一版 perf_lb_real.js 就是这么挂死 17 分钟的。 */
  const decodeSafe = (ms) => Promise.race([
    img.decode().catch(() => null),
    new Promise((r) => setTimeout(r, ms)),
  ]);

  const row = async (delta) => {
    /* 按环绕取，和 nav() 的 (i+d+n)%n 一致 —— 否则绕回第 0 张那一行会拿到 undefined，
       peek 恒为 '.'、name 恒为 undefined，看着像"没命中"，其实代就在那儿。 */
    const next = L.list[(L.i + delta + L.list.length) % L.list.length];
    const cssW = L._needPx(next);
    const pk = T.screenPeek ? T.screenPeek(next, cssW) : null;
    const s0 = T.stats();
    const t0 = performance.now();
    L.nav(delta);
    const how = await waitPix(6000);
    await decodeSafe(4000);
    const tPixels = +(performance.now() - t0).toFixed(1);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const tPainted = +(performance.now() - t0).toFixed(1);
    const s1 = T.stats();
    const rec = L._rec;
    return { n: L.i, name: next && next.name, how,
      peek: !!pk, peekSide: pk ? pk.side : 0,
      recSide: rec ? rec.side : 0, recFull: rec ? !!rec.full : false,
      natW: img.naturalWidth, need: cssW | 0, origW: next ? next.w : 0,
      makes: s1.screenMakes - s0.screenMakes, hits: s1.screenHits - s0.screenHits,
      miss: s1.misses - s0.misses, ss: s1.screensSize, cap: s1.screensCap,
      tPixels, tPainted };
  };

  const laps = [];
  /* 清空所有代，从"什么都没备好"开始 —— 这才是用户第一次打开时的状态。 */
  LIST.forEach((m) => T.forget(m.id));

  for (let lap = 0; lap < 2; lap++) {
    if (L.isOpen()) L.close();
    await wait(400);
    const to = performance.now();
    L.open(LIST, LIST[0]);
    const how = await waitPix(8000);
    await decodeSafe(4000);
    const openMs = +(performance.now() - to).toFixed(1);
    const openRec = L._rec;
    await wait(DWELL);

    const rows = [];
    /* k <= LIST.length：多走一步，正好从最后一张**绕回第 0 张**。
       这一步是"第二轮"的起点 —— nav() 会环绕（(i+d+n)%n），
       而 _preloadNeighbors() 不会（list[i+1] 在最后一张是 undefined）。
       如果这里 peek=N、px 比别处大一个量级，就说明"第二轮打开很慢"是这个不对称造成的。 */
    for (let k = 1; k <= LIST.length; k++) {
      await wait(DWELL);
      rows.push(await row(1));
    }
    laps.push({ openMs, how, openRec: openRec ? { side: openRec.side, full: !!openRec.full } : null, rows });
    lines.push('=== 第' + (lap + 1) + '圈 打开 ' + openMs + 'ms (' + how + ') rec=' + JSON.stringify(laps[lap].openRec) + ' ===');
    rows.forEach((r) => lines.push(
      '  #' + String(r.n).padStart(2, '0') + ' ' + String(r.name).padEnd(20)
      + ' ' + r.how.padEnd(8)
      + ' peek=' + (r.peek ? 'Y' : '.') + '/' + String(r.peekSide).padStart(4)
      + ' rec=' + String(r.recSide).padStart(4) + (r.recFull ? 'F' : ' ')
      + ' natW=' + String(r.natW).padStart(5)
      + ' need=' + String(r.need).padStart(5)
      + ' orig=' + String(r.origW).padStart(5)
      + ' mk=' + String(r.makes) + ' hit=' + String(r.hits) + ' miss=' + String(r.miss)
      + ' ss=' + String(r.ss) + '/' + String(r.cap)
      + ' px=' + String(r.tPixels).padStart(7) + ' paint=' + String(r.tPainted).padStart(7)));
  }
  const caps = { thumbs: T.stats().memHits, screens: T.stats().screenMakes };
  return { items: LIST.length, lines: lines.join('\\n'), laps, caps };
})()`;

(async () => {
  let out = null;
  try {
    const target = await waitTarget();
    const c = cdp(target.webSocketDebuggerUrl);
    await c.ready;
    await c.send('Runtime.enable');
    for (let k = 0; k < 120; k++) {
      const n = await c.eval('(window.State && State.items ? State.items.length : 0)');
      if (n >= 2) break;
      await sleep(500);
    }
    out = await c.eval(PAGE);
    c.close();
  } catch (e) {
    console.log('出错: ' + ((e && e.message) || e));
  } finally {
    try { child.kill(); } catch (e) { }
    await sleep(400);
    try { fs.rmSync(ud, { recursive: true, force: true }); } catch (e) { }
    if (out) {
      console.log('条目 ' + out.items + '  窗口 ' + W + 'x' + H + '  每张停 ' + DWELL + 'ms');
      console.log(out.lines);
    }
    process.exit(0);
  }
})();
