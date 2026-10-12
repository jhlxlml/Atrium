/* ============================================================
   取景 Viewfinder · js/transform.js 单元测试（纯 Node，无需 Electron）
   ------------------------------------------------------------
   要点：不调用任何 DOM。它把 computeTransform 产出的 transform 字符串
   用「CSS 矩阵合成」重新解算一遍（translate/rotate/scale 自右向左作用），
   因此断言的是浏览器真正会消费的那串 transform，而不是重算一遍公式。

   运行： node test/transform.test.js
   ============================================================ */
'use strict';

const T = require('../js/transform.js');

/* ---------- 极简断言框架 ---------- */
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail ? '  → ' + detail : ''));
}
function near(name, actual, expected, eps, unit) {
  const e = eps == null ? 1e-6 : eps;
  const d = Math.abs(actual - expected);
  ok(name, d <= e, `实测 ${actual}，期望 ${expected}，偏差 ${d}${unit || ''}`);
}

/* ---------- CSS 变换矩阵合成（复刻浏览器语义） ---------- */
function matMul(a, b) {
  // a、b 为 [m11,m12,m21,m22,dx,dy]（列主序同 CSS matrix(a,b,c,d,e,f)）
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
const M_IDENTITY = [1, 0, 0, 1, 0, 0];
function mTranslate(x, y) { return [1, 0, 0, 1, x, y]; }
function mScale(s) { return [s, 0, 0, s, 0, 0]; }
function mRotate(deg) {
  const r = deg * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r);
  return [c, sn, -sn, c, 0, 0];
}
function apply(m, x, y) { return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }; }

/** 解析 computeTransform 产出的 transform 串（只支持我们自己的格式，出现意外即抛错） */
function parseTransform(str) {
  const re = /(translate|rotate|scale)\(([^)]+)\)/g;
  let m, list = [];
  while ((m = re.exec(str))) {
    const fn = m[1];
    const nums = m[2].trim().split(/\s*,\s*|\s+/).map(v => parseFloat(v));
    if (fn === 'translate') list.push(mTranslate(nums[0], nums[1]));
    else if (fn === 'rotate') list.push(mRotate(nums[0]));
    else if (fn === 'scale') list.push(mScale(nums[0]));
  }
  if (list.length !== 5) throw new Error('transform 项数异常: ' + list.length + ' in ' + str);
  // CSS: 列表最左为最外层 → 矩阵自左向右相乘
  return list.reduce((acc, cur) => matMul(acc, cur), M_IDENTITY);
}

/** 取「图片本地四角」经 transform 后的质心（= 显示中心） */
function displayedCenter(t, baseW, baseH) {
  const M = parseTransform(t.transform);
  const pts = [[0, 0], [baseW, 0], [baseW, baseH], [0, baseH]].map(p => apply(M, p[0], p[1]));
  return {
    x: pts.reduce((s, p) => s + p.x, 0) / 4,
    y: pts.reduce((s, p) => s + p.y, 0) / 4,
  };
}

/** 光标处「内容坐标」的逆映射：stage 坐标 → 图片本地坐标 */
function localAt(t, baseW, baseH, sx, sy) {
  const M = parseTransform(t.transform);
  const det = M[0] * M[3] - M[1] * M[2];
  const dx = sx - M[4], dy = sy - M[5];
  return {
    x: (M[3] * dx - M[2] * dy) / det,
    y: (-M[1] * dx + M[0] * dy) / det,
  };
}

/* ============================================================
   1. orientedSize / fitScale
   ============================================================ */
console.log('\n[1] fitScale —— 「适应」缩放');

ok('orientedSize 0° 不换边', (function () {
  const o = T.orientedSize(1200, 800, 0); return o.w === 1200 && o.h === 800;
})());
ok('orientedSize 90° 换边', (function () {
  const o = T.orientedSize(1200, 800, 90); return o.w === 800 && o.h === 1200;
})());
ok('orientedSize 180° 不换边', (function () {
  const o = T.orientedSize(1200, 800, 180); return o.w === 1200 && o.h === 800;
})());

// 横图 1200×800 放进 1440×900：宽比 1.2、高比 1.125 → 取 1.125
near('横图适应取较小比值', T.fitScale({ baseW: 1200, baseH: 800, rot: 0, availW: 1440, availH: 900, min: 0.05, max: 3 }), 1.125, 1e-9);
// 竖图 800×1200 同一区域：宽比 1.8、高比 0.75 → 0.75
near('竖图适应', T.fitScale({ baseW: 800, baseH: 1200, rot: 0, availW: 1440, availH: 900, min: 0.05, max: 3 }), 0.75, 1e-9);
// 旋转 90° 后竖图变横图：等效 1200×800 → 1.125
near('旋转 90° 后等效尺寸互换', T.fitScale({ baseW: 800, baseH: 1200, rot: 90, availW: 1440, availH: 900, min: 0.05, max: 3 }), 1.125, 1e-9);
near('max 上限生效（小图不超 3 倍）', T.fitScale({ baseW: 100, baseH: 100, rot: 0, availW: 1440, availH: 900, min: 0.05, max: 3 }), 3, 1e-9);
near('min 下限生效（巨图不小于 0.05）', T.fitScale({ baseW: 100000, baseH: 100000, rot: 0, availW: 1440, availH: 900, min: 0.05, max: 3 }), 0.05, 1e-9);

/* ============================================================
   2. computeTransform —— 显示中心不变量（缩放的「居中」根基）
   ============================================================ */
console.log('[2] computeTransform —— 任意倍率/角度下显示中心 = 舞台中心 + t');

const rotAngles = [0, 90, 180, 270, 360];
const scales = [0.05, 0.3, 1, 1.352, 3.549, 8, 14];
const pans = [[0, 0], [120, -80], [-333.7, 210.25], [0, 400], [-50, 0]];
let centerCases = 0, centerBad = 0;
for (const rot of rotAngles) {
  for (const scale of scales) {
    for (const [tx, ty] of pans) {
      const baseW = 640, baseH = 480, stageCx = 743.5, stageCy = 399.5;
      const t = T.computeTransform({ baseW, baseH, scale, rot, tx, ty, stageCx, stageCy });
      const c = displayedCenter(t, baseW, baseH);
      centerCases++;
      const ex = stageCx + tx, ey = stageCy + ty;
      if (Math.abs(c.x - ex) > 1e-6 || Math.abs(c.y - ey) > 1e-6) {
        centerBad++;
        if (centerBad <= 3) ok(`中心不变量 rot=${rot} s=${scale} t=(${tx},${ty})`, false,
          `实得 (${c.x.toFixed(3)},${c.y.toFixed(3)})，期望 (${ex},${ey})`);
      }
    }
  }
}
ok(`显示中心不变量（${centerCases} 组合）`, centerBad === 0, `${centerBad} 个组合偏离`);

// 旋转 90°/270° 时显示包围盒长宽互换
const box0 = T.displayBox({ baseW: 640, baseH: 480, scale: 1, rot: 0, tx: 0, ty: 0, stageCx: 0, stageCy: 0 });
const box90 = T.displayBox({ baseW: 640, baseH: 480, scale: 1, rot: 90, tx: 0, ty: 0, stageCx: 0, stageCy: 0 });
near('0° 包围盒宽 = 基准宽', box0.w, 640, 1e-9);
near('90° 包围盒宽 = 基准高', box90.w, 480, 1e-9);
near('90° 包围盒高 = 基准宽', box90.h, 640, 1e-9);

/* ============================================================
   3. zoomAt —— 不动点不变量（回归重点：历史上 t≠0 时会漂）
   ============================================================ */
console.log('[3] zoomAt —— 光标下的内容坐标必须保持不动');

function focalDrift(state, factor, cx, cy, stageCx, stageCy, baseW, baseH) {
  const before = T.computeTransform({ baseW, baseH, scale: state.scale, rot: 0, tx: state.tx, ty: state.ty, stageCx, stageCy });
  const a = localAt(before, baseW, baseH, cx, cy);
  const next = T.zoomAt(state, { f: factor, cx, cy, stageCx, stageCy, min: 0.01, max: 14 });
  const after = T.computeTransform({ baseW, baseH, scale: next.scale, rot: 0, tx: next.tx, ty: next.ty, stageCx, stageCy });
  const b = localAt(after, baseW, baseH, cx, cy);
  return { dx: Math.abs(b.x - a.x), dy: Math.abs(b.y - a.y), next };
}

const ZC = { stageCx: 743.5, stageCy: 399.5 }, ZB = { baseW: 640, baseH: 480 };
const zoomScenarios = [
  { name: '无平移 · 光标在中心（历史探针唯一覆盖的场景）', state: { scale: 1, tx: 0, ty: 0 }, f: 2, cx: 743.5, cy: 399.5 },
  { name: '无平移 · 光标在角落', state: { scale: 1, tx: 0, ty: 0 }, f: 2, cx: 1200, cy: 700 },
  { name: '有平移 · 光标在中心', state: { scale: 2, tx: -200, ty: 0 }, f: 1.5, cx: 743.5, cy: 399.5 },
  { name: '有平移 · 光标偏离中心（旧实现漂 66px 的场景）', state: { scale: 1, tx: -200, ty: 0 }, f: 1.5, cx: 893.5, cy: 399.5 },
  { name: '大倍数平移后缩小', state: { scale: 6, tx: -800, ty: 300 }, f: 1 / 3, cx: 200, cy: 800 },
  { name: '平移 + 双向偏移', state: { scale: 3, tx: 333.7, ty: -210.25 }, f: 1.8, cx: 1500, cy: 120 },
];
let zoomBad = 0;
for (const sc of zoomScenarios) {
  const d = focalDrift(sc.state, sc.f, sc.cx, sc.cy, ZC.stageCx, ZC.stageCy, ZB.baseW, ZB.baseH);
  const bad = d.dx > 1e-6 || d.dy > 1e-6;
  if (bad) zoomBad++;
  ok(`不动点 ${sc.name}`, !bad, `内容坐标漂移 dx=${d.dx.toFixed(4)} dy=${d.dy.toFixed(4)}`);
}

// 缩放上下限夹取
const cl = T.zoomAt({ scale: 1, tx: 0, ty: 0 }, { f: 99, cx: 0, cy: 0, stageCx: 0, stageCy: 0, min: 0.25, max: 14 });
near('放大被 max 夹住', cl.scale, 14, 1e-9);
const cl2 = T.zoomAt({ scale: 1, tx: 0, ty: 0 }, { f: 0.0001, cx: 0, cy: 0, stageCx: 0, stageCy: 0, min: 0.25, max: 14 });
near('缩小被 min 夹住', cl2.scale, 0.25, 1e-9);
ok('k===1 时 changed=false（无谓重绘被跳过）', (function () {
  const r = T.zoomAt({ scale: 2, tx: 5, ty: 6 }, { f: 1, cx: 10, cy: 10, stageCx: 0, stageCy: 0, min: 0.01, max: 14 });
  return r.changed === false && r.tx === 5 && r.ty === 6;
})());

/* ============================================================
   4. canPan / clampPan —— 大图不露白、小图可自由拖动
   ============================================================ */
console.log('[4] clampPan —— 大图贴边不露白，小图可拖但不飞出视野');

const STAGE = { stageW: 1440, stageH: 800, freeLimit: 400 };

function boxFor(baseW, baseH, scale, rot, tx, ty) {
  return T.displayBox({ baseW, baseH, scale, rot, tx, ty, stageCx: 0, stageCy: 0 });
}

// 大图：3 倍 → 显示 1920×1440，两个方向都超出舞台 1440×800
const bigBox = boxFor(640, 480, 3, 0, 0, 0);
ok('大图 canPan = true', T.canPan(bigBox, STAGE.stageW, STAGE.stageH));
const bigClamp = T.clampPan({ tx: 99999, ty: 99999 }, { box: bigBox, stageW: STAGE.stageW, stageH: STAGE.stageH, freeLimit: STAGE.freeLimit });
near('大图横向上限 = (显示宽-舞台宽)/2', bigClamp.lim.x, (1920 - 1440) / 2, 1e-9);
near('大图纵向上限 = (显示高-舞台高)/2', bigClamp.lim.y, (1440 - 800) / 2, 1e-9);
near('超大位移被夹到横向上限', bigClamp.tx, bigClamp.lim.x, 1e-9);
near('超大位移被夹到纵向上限', bigClamp.ty, bigClamp.lim.y, 1e-9);
ok('大图两轴都超出 → 都走贴边约束', bigClamp.lim.freeX === false && bigClamp.lim.freeY === false);

// 单轴受限的真实场景：2 倍 → 1280×960。
// 宽 1280 < 舞台 1440（横向可自由拖），高 960 > 舞台 800（纵向必须贴边）
const midBox = boxFor(640, 480, 2, 0, 0, 0);
const midClamp = T.clampPan({ tx: 99999, ty: 99999 }, { box: midBox, stageW: STAGE.stageW, stageH: STAGE.stageH, freeLimit: STAGE.freeLimit });
near('横向未超舞台 → 走自由上限', midClamp.lim.x, STAGE.freeLimit, 1e-9);
ok('横向 freeX = true', midClamp.lim.freeX === true);
near('纵向超舞台 → 贴边约束', midClamp.lim.y, (960 - 800) / 2, 1e-9);
ok('纵向 freeY = false', midClamp.lim.freeY === false);

// 小图（0.35 倍，显示 224×168 远小于舞台）→ 可拖，但受自由上限约束
const smallBox = boxFor(640, 480, 0.35, 0, 0, 0);
ok('小图 canPan = false（无需平移，但拖动不受此限制）', !T.canPan(smallBox, STAGE.stageW, STAGE.stageH));
const smallClamp = T.clampPan({ tx: 99999, ty: -99999 }, { box: smallBox, stageW: STAGE.stageW, stageH: STAGE.stageH, freeLimit: STAGE.freeLimit });
near('小图横向放到自由上限', smallClamp.tx, STAGE.freeLimit, 1e-9);
near('小图纵向放到自由上限（负向）', smallClamp.ty, -STAGE.freeLimit, 1e-9);

// 旋转 90° 后约束同样生效（长宽互换参与计算）
const rotBox = boxFor(640, 480, 2, 90, 0, 0);
near('旋转 90° 后包围盒宽 = 基准高×倍数', rotBox.w, 960, 1e-9);
near('旋转 90° 后包围盒高 = 基准宽×倍数', rotBox.h, 1280, 1e-9);

/* ============================================================
   汇总
   ============================================================ */
console.log('\n' + '='.repeat(64));
if (fail) {
  console.log('失败项：');
  failures.forEach(f => console.log('  ✗ ' + f));
}
console.log(`transform.js 单元测试：通过 ${pass} / ${pass + fail}`);
console.log('='.repeat(64));
process.exit(fail ? 1 : 0);
