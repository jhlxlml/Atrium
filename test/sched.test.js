/* ============================================================
   Atrium · 解码调度器（统一优先级）回归测试（纯 Node）
   ------------------------------------------------------------
   覆盖阶段 2 的调度承诺：
     P1  后台（3 级）不许占满解码槽 —— 前台永远留得出空槽
     P2  排队中更急的先出队（0 级 > 2 级）
     P3  同优先级按先来后到（不饿死任何一条）
     P4  screenURL / preloadScreen 的优先级真的传到了调度器
     P5  槽位计数不漏（release 一次还一个，activeBg 同步回落）

   这些断言全部针对**真实生产代码**（js/thumb.js 的 IIFE 装配结果），
   只是把 createImageBitmap 换成可闸控的桩，以便"卡住"解码观察排队顺序。

   运行： node test/sched.test.js
   ============================================================ */
'use strict';

const H = require('./_harness.js');
const A = H.makeAsserts();

/* ---------- 可闸控的解码器 ---------- */
let started = [];      // 已经开始解码的 tag（按开工顺序）
let gates = [];        // 还没放行的解码 { tag, res }

function installEnv() {
  H.useGlobalAsWindow();
  started = [];
  gates = [];
  const ledger = H.makeUrlLedger();
  globalThis.URL.createObjectURL = ledger.api.createObjectURL;
  globalThis.URL.revokeObjectURL = ledger.api.revokeObjectURL;
  globalThis.devicePixelRatio = 1;
  globalThis.performance = { now: () => Date.now() };
  globalThis.Util = { can: { createImageBitmap: true } };
  globalThis.State = { bus: { emit() {} } };
  globalThis.Native = { active: false, url: () => null };
  globalThis.Loader = { imageSize: async () => null, recordDims() {}, recordRatio() {} };
  delete globalThis.requestIdleCallback;

  globalThis.createImageBitmap = (src, opt) => new Promise((resolve) => {
    const tag = (src && src.tag) || '?';
    started.push(tag);
    gates.push({
      tag,
      res: () => resolve({
        width: (opt && opt.resizeWidth) || 10,
        height: (opt && opt.resizeHeight) || 10,
        close() {},
      }),
    });
  });

  globalThis.OffscreenCanvas = class OffscreenCanvas {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return { clearRect() {}, drawImage() {} }; }
    convertToBlob() { return Promise.resolve({ fakeBlob: true }); }
  };
}

/** 放行某个 tag 的解码（只放行最早的那一个） */
function release(tag) {
  const i = gates.findIndex((g) => g.tag === tag);
  if (i < 0) return false;
  const g = gates.splice(i, 1)[0];
  g.res();
  return true;
}

/** 一张 24MP 条目；file.tag 用来在桩里认出是谁在解码 */
function mk(id, w, h) {
  return {
    id, name: id + '.jpg', rel: id + '.jpg', ext: 'jpg', size: 5000000, lastModified: 1,
    w: w === undefined ? 6000 : w, h: h === undefined ? 4000 : h,
    file: { tag: id }, bad: false, state: 'idle',
  };
}

const settle = async (n) => { for (let i = 0; i < (n || 6); i++) await H.tick(0); };

/* 调度器状态探针。基线（v1.20.9）没有 schedStats 这个 API ——
   这里退化成一组 -1，让断言以"实测 -1，期望 2"的形式红掉，
   而不是整个文件因为 TypeError 崩掉（否则就看不到其它项的结论）。 */
const ss = (T) => (typeof T.schedStats === 'function'
  ? T.schedStats()
  : { active: -1, activeBg: -1, waiting: -1, byPrio: [-1, -1, -1, -1], cap: -1, bgConc: -1 });

/* ============================================================
   P1. 后台不许占满解码槽
   ============================================================ */
async function testP1() {
  installEnv();
  H.loadScript('js/thumb.js');
  const T = globalThis.Thumbs;

  /* 8 个后台（3 级）请求：只允许 2 个开工，其余排队 */
  const jobs = [];
  for (let i = 0; i < 8; i++) jobs.push(T.thumbURL(mk('bg' + i), 200, 3));
  await settle();

  let st = ss(T);
  /* 不依赖 schedStats 的观察口径：解码器那边实际开工了几个 */
  A.eq('P1 8 个后台请求只开工 2 个（解码器侧）', started.length, 2);
  A.eq('P1 后台同时最多 2 个在解码', st.activeBg, 2);
  A.eq('P1 其余 6 个在排队', st.waiting, 6);
  A.eq('P1 解码槽容量 6、后台额度 2', st.cap + '/' + st.bgConc, '6/2');

  /* 此刻来一张"当前图"（0 级）：必须立刻开工，不用等后台解完 */
  const fg = T.thumbURL(mk('cur'), 200, 0);
  await settle();
  st = ss(T);
  A.ok('P1 当前图没有排队，直接开工', started.indexOf('cur') >= 0, '已开工 ' + started.join(','));
  A.eq('P1 后台仍是 2 个（没有趁机多占）', st.activeBg, 2);
  A.eq('P1 前台占掉第 3 个槽', st.active, 3);

  release('cur'); await settle();
  release('bg0'); await settle();
  st = ss(T);
  A.eq('P1 前台跑完、槽位还回去', st.active, 2);
  A.ok('P1 activeBg 同步回落', st.activeBg === 2, '实测 ' + st.activeBg);
  jobs.forEach((p) => p.catch(() => {}));
  fg.catch(() => {});
}

/* ============================================================
   P2. 排队中更急的先出队
   ============================================================ */
async function testP2() {
  installEnv();
  H.loadScript('js/thumb.js');
  const T = globalThis.Thumbs;

  /* 用 2 级把 6 个槽占满（模拟网格铺图） */
  const grid = [];
  for (let i = 0; i < 6; i++) grid.push(T.thumbURL(mk('g' + i), 200, 2));
  await settle();
  A.eq('P2 6 个槽被 2 级占满', ss(T).active, 6);

  /* 再排一个 2 级（先到）和一个 0 级（后到） */
  const late2 = T.thumbURL(mk('late2'), 200, 2);
  await settle();
  const fg = T.thumbURL(mk('fg'), 200, 0);
  await settle();
  A.eq('P2 两个都在排队', ss(T).waiting, 2);
  A.eq('P2 0 级排在 1 号位之前', ss(T).byPrio[0], 1);

  release('g0'); await settle();
  A.ok('P2 先出队的是 0 级（后到也优先）', started.indexOf('fg') >= 0 && started.indexOf('late2') < 0,
    '已开工 ' + started.join(','));
  A.eq('P2 2 级还在排队', ss(T).byPrio[2], 1);

  release('fg'); await settle();
  A.ok('P2 前台跑完后 2 级才开工', started.indexOf('late2') >= 0, '已开工 ' + started.join(','));
  grid.forEach((p) => p.catch(() => {}));
  late2.catch(() => {}); fg.catch(() => {});
}

/* ============================================================
   P3. 同优先级 FIFO
   ============================================================ */
async function testP3() {
  installEnv();
  H.loadScript('js/thumb.js');
  const T = globalThis.Thumbs;

  const all = [];
  for (let i = 0; i < 9; i++) all.push(T.thumbURL(mk('q' + i), 200, 2));
  await settle();
  A.eq('P3 前 6 个直接开工', started.join(','), 'q0,q1,q2,q3,q4,q5');

  /* 依次放行，排队的那 3 个必须按 q6,q7,q8 的顺序开工 */
  for (let i = 0; i < 6; i++) { release('q' + i); await settle(); }
  A.eq('P3 排队者按先来后到开工', started.slice(6).join(','), 'q6,q7,q8');
  all.forEach((p) => p.catch(() => {}));
}

/* ============================================================
   P4. 优先级从 screenURL / preloadScreen 传下来
   ============================================================ */
async function testP4() {
  installEnv();
  H.loadScript('js/thumb.js');
  let T = globalThis.Thumbs;

  /* 先用 2 级占满 6 个槽，后面的请求只能排队 —— 从 byPrio 就能看出它带的是几级 */
  let grid = [];
  for (let i = 0; i < 6; i++) grid.push(T.thumbURL(mk('b' + i), 200, 2));
  await settle();

  T.screenURL(mk('s1'), 1000, 1).catch(() => {});
  await settle();
  A.eq('P4 screenURL(prio=1) 以 1 级排队', ss(T).byPrio[1], 1);

  T.screenURL(mk('s2'), 1000, 3).catch(() => {});
  await settle();
  A.eq('P4 screenURL(prio=3) 以 3 级排队', ss(T).byPrio[3], 1);
  grid.forEach((p) => p.catch(() => {}));

  /* preloadScreen：near=true → 1 级 */
  installEnv();
  H.loadScript('js/thumb.js');
  T = globalThis.Thumbs;
  grid = [];
  for (let i = 0; i < 6; i++) grid.push(T.thumbURL(mk('b' + i), 200, 2));
  await settle();
  T.preloadScreen(mk('p1'), 1000, true);
  await H.tick(60);
  await settle();
  A.eq('P4 preloadScreen(near) 走 1 级', ss(T).byPrio[1], 1);
  grid.forEach((p) => p.catch(() => {}));

  /* preloadScreen：near=false → 3 级（且要等 400ms 的空闲窗口） */
  installEnv();
  H.loadScript('js/thumb.js');
  T = globalThis.Thumbs;
  grid = [];
  for (let i = 0; i < 6; i++) grid.push(T.thumbURL(mk('b' + i), 200, 2));
  await settle();
  T.preloadScreen(mk('p2'), 1000, false);
  await H.tick(420);                 // 没有 requestIdleCallback 时它等 400ms
  await settle();
  A.eq('P4 preloadScreen(远) 走 3 级', ss(T).byPrio[3], 1);
  grid.forEach((p) => p.catch(() => {}));
}

/* ============================================================
   P5. 槽位计数不漏
   ============================================================ */
async function testP5() {
  installEnv();
  H.loadScript('js/thumb.js');
  const T = globalThis.Thumbs;

  const jobs = [];
  for (let i = 0; i < 5; i++) jobs.push(T.thumbURL(mk('z' + i), 200, 3));
  await settle();
  A.eq('P5 5 个后台请求只开 2 个', ss(T).activeBg, 2);

  release('z0'); await settle();
  A.eq('P5 放行一个后仍是 2 个在跑（补上一个）', ss(T).activeBg, 2);
  /* 逐个放行，直到再没有闸着的解码（z3/z4 是放行之后才开工的） */
  for (let guard = 0; guard < 20 && gates.length; guard++) {
    release(gates[0].tag);
    await settle();
  }
  A.eq('P5 全部跑完后台归零', ss(T).activeBg, 0);
  A.eq('P5 总在跑数归零', ss(T).active, 0);
  A.eq('P5 排队清空', ss(T).waiting, 0);
  A.eq('P5 5 个都真的解过', started.length, 5);
  jobs.forEach((p) => p.catch(() => {}));
}

/* ============================================================ */
(async () => {
  await testP1();
  await testP2();
  await testP3();
  await testP4();
  await testP5();
  const ok = A.finish('调度器（统一优先级）');
  process.exit(ok ? 0 : 1);
})();
