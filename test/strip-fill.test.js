/* ============================================================
   Atrium · 灯箱缩略图条的「按需 + 背压」填充回归测试（纯 Node）
   ------------------------------------------------------------
   覆盖阶段 2 对 _fillStrip() 的改造：
     F1  背压：同时最多 2 个在途请求，回来一个才发下一个
     F2  按需：1000 张的目录里只填当前张 ±30，不再为全目录解码
     F3  优先级：距离 0 → 0 级、1 → 1 级、≤6 → 2 级、更远 → 3 级
     F4  连翻让路：刚切过图（<120ms）时不发新请求，停手后自动续跑
     F5  可见区：条带滚到别处时，那一段也纳入填充（否则永远空白）
     F6  收起不填：条带隐藏时不做无用解码
     F7  世代：条带重建后，旧世代的在途结果不回写 DOM、不污染计数
     F8  删图后槽位与 list 对齐（v1.20.9 只挪了 list 与 DOM）

   lightbox.js 是浏览器 IIFE，装载时只读 global.Util / global.Transform /
   global.A11y，因此这里把这三者留空、只桩 Thumbs 与 performance，
   然后直接对 Lightbox 的方法 `call` 一个最小宿主对象。

   运行： node test/strip-fill.test.js
   ============================================================ */
'use strict';

const H = require('./_harness.js');
const A = H.makeAsserts();

let LB = null;
const STRIP_CONC_EXPECT = 2;   // 与 lightbox.js 的 STRIP_CONC 对齐
let log = [];        // 所有请求 {k, prio, cssW}
let pending = [];    // 还没放行的请求 {k, res}

/** 装载生产代码 + 桩 */
function installEnv() {
  H.useGlobalAsWindow();
  log = [];
  pending = [];
  /* 用真实时钟：_fillStrip 的"连翻让路"是按 performance.now() 的差值判定的 */
  globalThis.performance = { now: () => Date.now() };
  globalThis.Util = { $: () => null, icon: () => '', scrollBehavior: () => 'auto' };
  globalThis.Transform = undefined;
  globalThis.A11y = undefined;
  globalThis.Thumbs = {
    thumbURL(meta, cssW, prio) {
      const k = Number(String(meta.id).slice(1));
      return new Promise((res) => {
        log.push({ k, prio, cssW });
        pending.push({ k, res });
      });
    },
  };
  H.loadScript('js/lightbox.js');
  LB = globalThis.Lightbox;
}

/** 造一个 n 张图的宿主对象（只带 _fillStrip 需要的字段） */
function host(n, i) {
  const list = [];
  for (let k = 0; k < n; k++) list.push({ id: 'm' + k, name: 'p' + k + '.jpg', ext: 'jpg', w: 6000, h: 4000, bad: false });
  const slots = [];
  for (let k = 0; k < n; k++) {
    slots.push({
      b: { isConnected: true, classList: { toggle() {} } },
      ic: { remove() { this.removed = true; }, removed: false },
      img: { src: '' },
      m: list[k],
      filled: false,
    });
  }
  /* 用 Object.create(Lightbox) 而不是字面量：_fillStrip 内部会调 this._nextStripSlot()，
     它必须落在原型链上（也就是真实方法），否则测的就不是生产代码了。 */
  const h = Object.create(LB);
  Object.assign(h, {
    openFlag: true,
    list, i,
    strip: { hidden: false, scrollLeft: 0, clientWidth: 800, scrollWidth: 64 * n, children: [] },
    stripBtn: { classList: { add() {}, remove() {} } },
    _stripSlots: slots,
    _stripBusy: 0,
    _stripGen: 1,
    _stripWant: new Set(),
    _stripT: 0,
    _navAt: 0,
    _lastNavAt: 0,
    render() { this.rendered = (this.rendered || 0) + 1; },
    close() { this.closed = true; },
  });
  return h;
}

/* 基线（v1.20.9）没有 _nextStripSlot / _fillStripVisible 这两个方法，
   这里做"有就调、没有就算没做"，让断言以失败的形式出现，而不是整个文件崩掉。 */
const fill = (h) => (LB._fillStrip ? LB._fillStrip.call(h) : null);
const nextSlot = (h) => (LB._nextStripSlot ? LB._nextStripSlot.call(h) : -1);
const visible = (h) => (LB._fillStripVisible ? LB._fillStripVisible.call(h) : null);

/** 放行所有在途请求，直到没有新的为止（模拟"解码都回来了"） */
async function drain(h, limit) {
  let guard = 0;
  for (;;) {
    if (guard++ > (limit || 400)) break;
    for (let t = 0; t < 3; t++) await H.tick(0);
    if (!pending.length) break;
    const j = pending.shift();
    if (j) j.res('blob:' + j.k);   // 基线可能一次发完 6 个、也可能一个都没发
  }
  for (let t = 0; t < 6; t++) await H.tick(0);
}

/* ============================================================
   F1. 背压：同时最多 2 个在途
   ============================================================ */
async function testF1() {
  installEnv();
  const h = host(200, 0);
  for (let t = 0; t < 10; t++) fill(h);
  A.eq('F1 连调 10 次只发出 2 个请求', log.length, 2);
  A.eq('F1 在途计数为 2', h._stripBusy, 2);

  /* 放行一个 → 才补下一个 */
  const one = pending.shift();
  A.ok('F1 前置：至少有一个在途请求可放行', !!one);
  if (one) one.res('blob:' + one.k);
  for (let t = 0; t < 4; t++) await H.tick(0);
  A.eq('F1 回来一个才补一个', log.length, 3);
  A.eq('F1 在途仍是 2', h._stripBusy, 2);

  /* 全部跑完后，在途归零 */
  await drain(h);
  A.eq('F1 全部回来后计数归零', h._stripBusy, 0);
}

/* ============================================================
   F2. 按需：只填当前张 ±30
   ============================================================ */
async function testF2() {
  installEnv();
  const h = host(1000, 0);
  fill(h);
  await drain(h);
  const ks = log.map((x) => x.k);
  A.eq('F2 1000 张的目录只请求了窗口内的 31 个', ks.length, 31);
  A.eq('F2 最大索引不超过 30', Math.max.apply(null, ks), 30);
  A.eq('F2 没有任何远端请求（基线是 1000）', ks.filter((k) => k > 30).length, 0);

  /* 翻到第 500 张：窗口跟着走 */
  log = [];
  h.i = 500;
  fill(h);
  await drain(h);
  const ks2 = log.map((x) => x.k);
  A.ok('F2 窗口跟着当前张走', ks2.length > 0 && Math.min.apply(null, ks2) >= 470 && Math.max.apply(null, ks2) <= 530,
    '实测范围 ' + Math.min.apply(null, ks2) + '..' + Math.max.apply(null, ks2));
  A.ok('F2 不会为已填过的槽位重复请求', ks2.indexOf(0) < 0);
}

/* ============================================================
   F3. 优先级：按距离分级
   ============================================================ */
async function testF3() {
  installEnv();
  const h = host(200, 100);
  fill(h);
  await drain(h);
  const by = new Map();
  for (const x of log) by.set(x.k, x.prio);
  A.eq('F3 距离 0（当前张）走 0 级', by.get(100), 0);
  A.eq('F3 距离 1 走 1 级（左）', by.get(99), 1);
  A.eq('F3 距离 1 走 1 级（右）', by.get(101), 1);
  A.eq('F3 距离 2..6 走 2 级', by.get(98) + '/' + by.get(106), '2/2');
  A.eq('F3 距离 7 起走 3 级后台', by.get(93) + '/' + by.get(107), '3/3');
  A.eq('F3 距离 8 也是 3 级', by.get(92), 3);
  const at = (idx) => log[idx] || {};
  A.eq('F3 条带缩略图用 148px 档（命中已生成的 320 档）', at(0).cssW, 148);
  /* 顺序：由近及远 */
  A.eq('F3 先填当前张', at(0).k, 100);
  A.eq('F3 再填左右邻居', at(1).k + ',' + at(2).k, '99,101');
}

/* ============================================================
   F4. 连翻让路
   ============================================================ */
async function testF4() {
  installEnv();
  const h = host(200, 0);
  h._lastNavAt = Date.now();        // 刚切过图
  fill(h);
  A.eq('F4 刚切图时不发请求', log.length, 0);
  A.ok('F4 但排了一个续跑的定时器', !!h._stripT);

  await H.tick(170);                // 让路窗口过去
  A.eq('F4 停手后自动续跑（一次补到并发上限）', log.length, STRIP_CONC_EXPECT);
  A.ok('F4 续跑后清掉定时器句柄', h._stripT === 0, '句柄 ' + String(h._stripT));

  /* 打开灯箱时 render() 也会写 _navAt，但那不是切图 —— 条带不该因此白等 */
  log = [];
  const h3 = host(200, 0);
  h3._navAt = Date.now();           // render 打的点（"连翻判定"用）
  h3._lastNavAt = 0;                // 但没真的切过图
  fill(h3);
  A.eq('F4 打开时的 render 不算切图，条带立刻开工', log.length, STRIP_CONC_EXPECT);
  h3.openFlag = false;

  /* 连续切图：定时器被不断推后，全程不发请求 */
  log = [];
  const h2 = host(200, 0);
  for (let t = 0; t < 6; t++) { h2._lastNavAt = Date.now(); fill(h2); await H.tick(30); }
  A.eq('F4 按住方向键期间一个请求都不发', log.length, 0);
  /* 收尾：让两个宿主"关掉"，它们残留的续跑定时器醒来后会立刻 return，
     不会把请求漏到下一个用例的日志里（否则后面统计到的请求数会莫名翻倍）。 */
  h.openFlag = false; h2.openFlag = false;
}

/* ============================================================
   F5. 可见区：滚到别处也要填
   ============================================================ */
async function testF5() {
  installEnv();
  const h = host(1000, 0);
  fill(h);
  await drain(h);                   // 先填满 i±30
  const before = log.length;
  A.ok('F5 前置：窗口已填满', before === 31, '实测 ' + before);

  /* 条带滚到第 800 张附近（每格 64px、可视 800px） */
  log = [];
  h.strip.scrollLeft = 800 * 64;
  visible(h);
  await drain(h);
  const ks = log.map((x) => x.k);
  A.ok('F5 滚动后开始填可见区', ks.length > 0, '实测 ' + ks.length);
  A.ok('F5 填的确实是可见区那一段', ks.every((k) => k >= 796 && k <= 817),
    '实测 ' + ks.join(','));
  /* 可见区里也是"离当前张最近的先填"（796 是 800±4 里离 0 最近的一个） */
  A.eq('F5 可见区内按离当前张的距离排序', ks[0], 796);
}

/* ============================================================
   F6. 条带收起时不填
   ============================================================ */
async function testF6() {
  installEnv();
  const h = host(200, 0);
  h.strip.hidden = true;
  fill(h);
  A.eq('F6 条带收起时一个请求都不发', log.length, 0);
  h.strip.hidden = false;
  fill(h);
  A.eq('F6 展开后才开始填', log.length, STRIP_CONC_EXPECT);
}

/* ============================================================
   F7. 世代：条带重建后旧结果不回写
   ============================================================ */
async function testF7() {
  installEnv();
  const h = host(200, 0);
  fill(h);
  const old = pending.shift();
  A.ok('F7 前置：有一个在途请求', !!old);
  h._stripGen++;                    // 模拟 _buildStrip 重建（切目录/删图/重开）
  h._stripBusy = 0;
  if (old) old.res('blob:0');
  for (let t = 0; t < 6; t++) await H.tick(0);
  A.eq('F7 旧世代的结果不写进新 DOM', h._stripSlots[0].img.src, '');
  A.eq('F7 旧世代不回写计数', h._stripBusy, 0);
  A.eq('F7 旧世代不触发续跑', log.length, STRIP_CONC_EXPECT);
}

/* ============================================================
   F8. 删图后槽位与 list 对齐
   ============================================================ */
async function testF8() {
  installEnv();
  const h = host(10, 3);
  const meta = h.list[3];
  LB.dropCurrent.call(h, meta);

  A.eq('F8 list 少了一张', h.list.length, 9);
  A.eq('F8 槽位数组同步左移', h._stripSlots.length, 9);
  let aligned = true;
  for (let k = 0; k < h._stripSlots.length; k++) {
    if (h._stripSlots[k].m !== h.list[k]) aligned = false;
  }
  A.ok('F8 每个槽位都对着正确的条目（否则缩略图会整体错位）', aligned);
  A.ok('F8 删除后该重取的位置已标记未填', h._stripSlots[3].filled === false);
  A.eq('F8 走的是"顺位显示下一张"', h.i, 3);
  A.eq('F8 触发了重新渲染', h.rendered, 1);
}

/* ============================================================
   F9. 大目录的远端：窗口是"以当前张为原点"，不是"从头开始"
   ------------------------------------------------------------
   审计里我把这条列成未测风险（"±30 窗口在 10 万张的远端会不会退化成
   从 0 开始"）。读代码看它按 `this.i` 算绝对区间，所以这里直接把 10 万张
   的极端情况钉成断言 —— 读代码得出的结论也得有门禁守着。
   ============================================================ */
async function testF9() {
  installEnv();
  const N = 100000, I = N - 100;
  const h = host(N, I);

  fill(h);
  A.eq('F9 10 万张里也只并发 2 个', log.length, STRIP_CONC_EXPECT);
  A.ok('F9 首批请求就在当前张附近（不是从 0 开始）',
    log.every((x) => Math.abs(x.k - I) <= 1),
    '实测 ' + log.map((x) => x.k).join(','));

  await drain(h, 4000);
  const ks = log.map((x) => x.k);
  /* 窗口是 ±30，所以中段一张图对应 **61** 个槽位（F2 在 i=0 的边界上只有 31 个） */
  A.eq('F9 中段只填 ±30 的 61 个槽位', ks.length, 61);
  A.eq('F9 最小索引 = 当前张 - 30', Math.min.apply(null, ks), I - 30);
  A.eq('F9 最大索引 = 当前张 + 30', Math.max.apply(null, ks), I + 30);
  A.eq('F9 没有任何"回头补前面"的请求', ks.filter((k) => k < I - 30).length, 0);
  A.eq('F9 首尾都不越界', ks.filter((k) => k < 0 || k >= N).length, 0);

  /* 条带被滚到中段：可见区要能"接管"，否则远端永远空白 */
  log = [];
  const avg = h.strip.scrollWidth / h._stripSlots.length;
  h.strip.scrollLeft = 50000 * avg;
  visible(h);
  const want = Array.from(h._stripWant);
  A.ok('F9 滚到中段后可见区被纳入', want.length > 0 && want.every((k) => k > 49000 && k < 51000),
    'want=' + want.length + ' 范围 ' + Math.min.apply(null, want) + '..' + Math.max.apply(null, want));

  await drain(h, 4000);
  const ks2 = log.map((x) => x.k);
  A.ok('F9 中段的槽位真的被请求了', ks2.length > 0 && ks2.every((k) => k > 49000 && k < 51000),
    '实测 ' + (ks2.length ? Math.min.apply(null, ks2) + '..' + Math.max.apply(null, ks2) : '无'));
}

/* ============================================================ */
(async () => {
  await testF1();
  await testF2();
  await testF3();
  await testF4();
  await testF5();
  await testF6();
  await testF7();
  await testF8();
  await testF9();
  const ok = A.finish('灯箱缩略图条（按需 + 背压）');
  process.exit(ok ? 0 : 1);
})();
