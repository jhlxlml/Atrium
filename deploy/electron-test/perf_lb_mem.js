/* 内存压测探针：长时间浏览（翻页 + 放大缩小），定时采样堆内存与 Blob URL 计数。
 *
 * 用法：node perf_lb_mem.js <目录> [总秒数] [窗口宽] [窗口高]
 * 默认跑 5 分钟（300 秒）。
 *
 * 输出：每隔 3 秒一行采样，最后汇总 min/max/delta。
 * 判定标准：
 *   - usedJSHeapSize 如果在 5 分钟内持续单调上升（最后 > 最初 × 1.5），说明有泄漏
 *   - pinned.count 如果不归零（在忘记所有图之后），说明 pin/unpin 不对称
 *   - screens/thumbs/bigs 的 map.size 应该在 LRU cap 上下波动，不该无限增长
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
const TOTAL_SEC = +(process.argv[3] || 300);
const W = +(process.argv[4] || 2560);
const H = +(process.argv[5] || 1400);
const PORT = 9600 + (Date.now() % 200);

if (!DIR) { console.error('用法: node perf_lb_mem.js <目录> [总秒数] [宽] [高]'); process.exit(2); }
if (!fs.existsSync(EXE)) { console.error('找不到 exe: ' + EXE); process.exit(2); }

const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-mem-'));
fs.writeFileSync(path.join(ud, 'last-dir.json'),
  JSON.stringify({ dir: DIR, ts: Date.now(), granted: true }), 'utf8');
const env = Object.assign({}, process.env, { VF_USERDATA: ud });
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

const child = spawn(EXE, [
  '--remote-debugging-port=' + PORT,
  '--no-sandbox',
  '--window-size=' + W + ',' + H,
], {
  env,
  stdio: ['ignore', 'ignore', 'pipe'],
  windowsHide: true,
});

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
    } catch (e) { }
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

/* 页面内采样函数：返回当前内存快照 */
const SAMPLE_EXPR = `JSON.stringify({
  t: Math.round(performance.now()),
  mem: performance.memory ? {
    used: performance.memory.usedJSHeapSize,
    total: performance.memory.totalJSHeapSize,
    limit: performance.memory.jsHeapSizeLimit,
  } : null,
  url: (window.Thumbs && Thumbs.urlStats) ? Thumbs.urlStats() : null,
  st: (window.Thumbs && Thumbs.stats) ? Thumbs.stats() : null,
  lbOpen: (window.Lightbox && Lightbox.isOpen) ? Lightbox.isOpen() : false,
  lbI: (window.Lightbox && Lightbox.i != null) ? Lightbox.i : -1,
  items: (window.State && State.items) ? State.items.length : 0,
})`;

/* 页面内浏览循环：翻页 + 偶尔放大缩小 + 偶尔开关灯箱
 * 全程用 setInterval 在页面内跑，Node 侧定时采样。
 */
const BROWSE_INIT = `(async () => {
  const L = window.Lightbox, T = window.Thumbs;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const LIST = window.State.items;
  if (!LIST || LIST.length < 2) return '条目不足: ' + (LIST ? LIST.length : -1);

  /* 清空所有缓存，从干净状态开始 */
  LIST.forEach((m) => T.forget(m.id));
  T.clearAll();

  /* 打开灯箱 */
  L.open(LIST, LIST[0]);
  await wait(2000);

  /* 浏览循环标记，外部采样完成后设为 true 来停止 */
  window.__memStop = false;

  /* 翻页循环：每 2 秒翻一张，偶尔反向 */
  let dir = 1;
  let counter = 0;
  window.__memTimer = setInterval(() => {
    if (window.__memStop) { clearInterval(window.__memTimer); return; }
    counter++;
    /* 每 10 张有 30% 概率反向 */
    if (counter % 10 === 0 && Math.random() < 0.3) dir = -dir;
    L.nav(dir);
  }, 2000);

  /* 偶尔开关灯箱：每 30 秒关一次，2 秒后重开 */
  window.__memTimer2 = setInterval(() => {
    if (window.__memStop) { clearInterval(window.__memTimer2); return; }
    L.close();
    setTimeout(() => {
      if (window.__memStop) return;
      const items = window.State.items;
      const startIdx = Math.floor(Math.random() * Math.max(1, items.length - 1));
      L.open(items, items[startIdx] || items[0]);
    }, 2000);
  }, 30000);

  return 'OK items=' + LIST.length;
})()`;

(async () => {
  let samples = [];
  let initResult = null;
  let cleanup = null;
  try {
    const target = await waitTarget();
    const c = cdp(target.webSocketDebuggerUrl);
    await c.ready;
    await c.send('Runtime.enable');

    /* 等列表加载 */
    for (let k = 0; k < 120; k++) {
      const n = await c.eval('(window.State && State.items ? State.items.length : 0)');
      if (n >= 2) break;
      await sleep(500);
    }

    /* 初始化浏览循环 */
    initResult = await c.eval(BROWSE_INIT);
    console.log('初始化:', initResult);

    /* 采样循环：每 3 秒采一次，共 TOTAL_SEC/3 次 */
    const sampleCount = Math.floor(TOTAL_SEC / 3);
    for (let i = 0; i < sampleCount; i++) {
      const raw = await c.eval(SAMPLE_EXPR);
      const s = JSON.parse(raw);
      samples.push(s);
      const mb = s.mem ? (s.mem.used / 1024 / 1024).toFixed(1) : '?';
      const url = s.url || {};
      const st = s.st || {};
      process.stdout.write(
        `  [${(i*3)}s] heap=${mb}MB pinned=${url.pinned||0} def=${url.deferred||0}`
        + ` thumb=${url.thumbs||0} big=${url.bigs||0} scr=${url.screens||0}`
        + ` mk=${st.screenMakes||0} hit=${st.screenHits||0} drop=${st.screenDropped||0}`
        + ` lb=${s.lbOpen?'Y':'n'} i=${s.lbI}  \r`
      );
      await sleep(3000);
    }

    /* 停止浏览 */
    await c.eval('window.__memStop = true');
    await sleep(1000);

    /* 最后做一次"清理后"采样：forget 所有图，再看 pinned 是否归零 */
    const CLEANUP = `(async () => {
      const L = window.Lightbox, T = window.Thumbs;
      if (L.isOpen()) L.close();
      await new Promise(r=>setTimeout(r,500));
      const LIST = window.State.items || [];
      LIST.forEach(m => T.forget(m.id));
      T.clearAll();
      await new Promise(r=>setTimeout(r,1000));
      return JSON.stringify({
        t: Math.round(performance.now()),
        mem: performance.memory ? {
          used: performance.memory.usedJSHeapSize,
          total: performance.memory.totalJSHeapSize,
          limit: performance.memory.jsHeapSizeLimit,
        } : null,
        url: (window.Thumbs && Thumbs.urlStats) ? Thumbs.urlStats() : null,
        st: (window.Thumbs && Thumbs.stats) ? Thumbs.stats() : null,
      });
    })()`;
    const cleanupRaw = await c.eval(CLEANUP);
    cleanup = JSON.parse(cleanupRaw);

    c.close();
  } catch (e) {
    console.log('\n出错: ' + ((e && e.message) || e));
  } finally {
    try { child.kill(); } catch (e) { }
    await sleep(400);
    try { fs.rmSync(ud, { recursive: true, force: true }); } catch (e) { }
  }

  /* 分析输出 */
  console.log('\n');
  if (samples.length === 0) {
    console.log('没有采到样本');
    process.exit(1);
  }

  const heaps = samples.filter(s => s.mem).map(s => s.mem.used);
  const pinnedAll = samples.filter(s => s.url).map(s => s.url.pinned);
  const thumbsAll = samples.filter(s => s.url).map(s => s.url.thumbs);
  const bigsAll = samples.filter(s => s.url).map(s => s.url.bigs);
  const screensAll = samples.filter(s => s.url).map(s => s.url.screens);

  const mb = (b) => (b / 1024 / 1024).toFixed(1);
  const min = (a) => Math.min.apply(null, a);
  const max = (a) => Math.max.apply(null, a);
  const first = (a) => a[0];
  const last = (a) => a[a.length - 1];

  console.log('=== 内存压测结果 ===');
  console.log(`目录: ${DIR}`);
  console.log(`总时长: ${TOTAL_SEC}秒  采样: ${samples.length} 次  间隔: 3秒`);
  console.log(`条目数: ${samples[0].items}`);
  console.log('');
  console.log('--- JS 堆内存 (usedJSHeapSize) ---');
  if (heaps.length > 0) {
    console.log(`  最初: ${mb(first(heaps))} MB`);
    console.log(`  最低: ${mb(min(heaps))} MB`);
    console.log(`  最高: ${mb(max(heaps))} MB`);
    console.log(`  最后: ${mb(last(heaps))} MB`);
    console.log(`  增长: ${mb(last(heaps) - first(heaps))} MB (${((last(heaps)/first(heaps)-1)*100).toFixed(1)}%)`);
    const growthRatio = last(heaps) / first(heaps);
    if (growthRatio > 1.5) {
      console.log('  ⚠️  堆内存增长超过 50%，可能存在泄漏！');
    } else if (growthRatio > 1.2) {
      console.log('  ⚠️  堆内存增长 20-50%，需要关注。');
    } else {
      console.log('  ✓ 堆内存增长在 20% 以内，正常波动。');
    }
  } else {
    console.log('  (performance.memory 不可用)');
  }

  console.log('');
  console.log('--- Blob URL 引用计数 ---');
  if (pinnedAll.length > 0) {
    console.log(`  pinned:  最初=${first(pinnedAll)}  最高=${max(pinnedAll)}  最后=${last(pinnedAll)}`);
    console.log(`  thumbs:  最初=${first(thumbsAll)}  最高=${max(thumbsAll)}  最后=${last(thumbsAll)}`);
    console.log(`  bigs:    最初=${first(bigsAll)}  最高=${max(bigsAll)}  最后=${last(bigsAll)}`);
    console.log(`  screens: 最初=${first(screensAll)}  最高=${max(screensAll)}  最后=${last(screensAll)}`);
  }

  console.log('');
  console.log('--- 清理后状态（forget all + clearAll） ---');
  if (cleanup && cleanup.mem) {
    console.log(`  堆内存: ${mb(cleanup.mem.used)} MB`);
  }
  if (cleanup && cleanup.url) {
    console.log(`  pinned:  ${cleanup.url.pinned}`);
    console.log(`  deferred:${cleanup.url.deferred}`);
    console.log(`  thumbs:  ${cleanup.url.thumbs}`);
    console.log(`  bigs:    ${cleanup.url.bigs}`);
    console.log(`  screens: ${cleanup.url.screens}`);
    if (cleanup.url.pinned > 0) {
      console.log('  ⚠️  清理后 pinned 仍不为零！pin/unpin 不对称，存在泄漏！');
    } else {
      console.log('  ✓ 清理后 pinned 归零，pin/unpin 对称。');
    }
  }

  /* 输出 CSV 供画图 */
  console.log('');
  console.log('--- CSV (heap_MB,pinned,thumbs,bigs,screens,screenMakes,screenHits,screenDropped) ---');
  console.log('sec,heap_MB,pinned,thumbs,bigs,screens,mk,hit,drop');
  samples.forEach((s, i) => {
    const heap = s.mem ? mb(s.mem.used) : '';
    const u = s.url || {};
    const st = s.st || {};
    console.log(`${i*3},${heap},${u.pinned||0},${u.thumbs||0},${u.bigs||0},${u.screens||0},${st.screenMakes||0},${st.screenHits||0},${st.screenDropped||0}`);
  });

  process.exit(0);
})();
