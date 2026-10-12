/* ============================================================
   取景 Viewfinder · js/masonry.js 单元测试（纯 Node，无需 Electron）
   ------------------------------------------------------------
   这套测试的重点不是"排布好不好看"，而是锁住两条**承重的坐标不变量**
   （grid.js 的窗口化 / 重排锚点 / 框选命中全都建立在它们之上）：

   ① `positions[i].y` **单调不减** —— 每张都放进"当前最矮的列"，而各列高度
      只增不减，所以"最矮列的高度"这个序列本身不会下降。
      → 所以 y 上可以放心二分（grid.js 直接用）。
   ② `positions[i].y + h`（底边）**不单调** —— 同一列里后放的矮图，底边可能
      比前面那张高图还靠上。
      → 所以底边上**不能**二分，必须改用本模块输出的单调数组 yMax。

   弄反任何一条，症状都是"滚到某处有图不显示"或框选漏选，且只在特定宽高比
   组合下复现 —— 所以这里既断言不变量本身，也用一条**覆盖性不变量**兜底：
   用 yMax 二分出来的区间，必须完整覆盖"真的与视口相交"的每一张。

   运行： node test/masonry.test.js
   ============================================================ */
'use strict';

const M = require('../js/masonry.js');

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
const monoIncr = (arr) => arr.every((v, i) => i === 0 || v >= arr[i - 1]);
const bottomsOf = (P) => P.map((p) => p.y + p.h);

const GAP = 12;

/* ============================================================
   1. aspectOf —— 非法宽高比一律当正方形
   ============================================================ */
ok('aspectOf 正常值原样返回', M.aspectOf(1.5) === 1.5);
ok('aspectOf NaN → 1', M.aspectOf(NaN) === 1);
ok('aspectOf 0 → 1', M.aspectOf(0) === 1);
ok('aspectOf 负数 → 1', M.aspectOf(-2) === 1);
ok('aspectOf 字符串 → 1', M.aspectOf('1.5') === 1);
ok('aspectOf undefined → 1', M.aspectOf(undefined) === 1);
ok('aspectOf Infinity → 1', M.aspectOf(Infinity) === 1);

/* ============================================================
   2. columns —— 列数由目标列宽推出，实际列宽按容器均分
   ============================================================ */
{
  // 期望列数按 n ≤ (宽+gap)/(目标+gap) 手算，避免"照着实现写期望"
  const cases = [
    // 宽度, 目标列宽, 期望列数, 期望列宽
    [1200, 208, 5, 230.4],
    [600, 208, 2, 294],
    [500, 230, 2, 244],
    [200, 208, 1, 200],      // 放不下两列
    [1420, 200, 6, 1420 / 6 - 10],
    [100, 300, 1, 100],      // 容器比目标列宽还窄 → 单列铺满
    [1000, 230, 4, 241],
  ];
  for (const [w, t, wantCols, wantColW] of cases) {
    const r = M.columns(w, t, GAP);
    ok(`columns(${w},${t}) 列数 = ${wantCols}`, r.cols === wantCols, '实测 ' + r.cols);
    near(`columns(${w},${t}) 列宽 = ${wantColW.toFixed(1)}`, r.colW, wantColW, 1e-6, 'px');
    // 恰好填满：n*colW + (n-1)*gap === width
    near(`columns(${w},${t}) 列宽恰好填满容器`, r.cols * r.colW + (r.cols - 1) * GAP, w, 1e-9, 'px');
  }
}

{
  const r = M.columns(1200, 208, GAP);
  ok('列宽不小于下限（不把内容挤没）', r.colW >= M.MIN_COL, '实测 ' + r.colW);
  ok('目标列宽 0 → 用下限兜底而不崩', M.columns(1200, 0, GAP).cols >= 1);
  ok('目标列宽 NaN → 用下限兜底而不崩', M.columns(1200, NaN, GAP).cols >= 1);
}

{
  const r = M.columns(1200, 200, 0);      // gap=0
  ok('gap=0 时列数 = floor(宽度/目标)', r.cols === 6, '实测 ' + r.cols);
  near('gap=0 时列宽恰好填满', r.cols * r.colW, 1200, 1e-9, 'px');
}

{
  const r = M.columns(0, 200, GAP);
  ok('宽度 0 不产生 0 宽列（退化安全）', r.cols === 1 && r.colW > 0, JSON.stringify(r));
}

/* ============================================================
   3. compute —— 排布本身
   ============================================================ */
{
  const c = M.compute({ width: 1000, colW: 230, gap: GAP, aspects: [] });
  ok('N=0：positions 为空', c.positions.length === 0);
  ok('N=0：totalH = 0', c.totalH === 0);
  ok('N=0：yMax 为空', c.yMax.length === 0);
  ok('N=0：仍然给出列数（用于空态排版）', c.cols >= 1);
}

{
  const c = M.compute({ width: 1000, colW: 230, gap: GAP, aspects: [1] });
  const p = c.positions[0];
  ok('N=1：落在左上角', p.x === 0 && p.y === 0, JSON.stringify(p));
  near('N=1：正方形高度 = 列宽', p.h, c.colW, 1e-9);
  near('N=1：totalH = 该张高度', c.totalH, p.h, 1e-9);
}

{
  /* 最短列优先（2 列，列宽 244）：
       aspects [1, 2, 0.9] →
         #0 → 第 0 列（同为 0 取最左），h=244，该列高 256
         #1 → 第 1 列（0 < 256），h=122，该列高 134
         #2 → 仍选第 1 列（134 < 256）→ 这就证明了它是"按最矮列"而不是"按行/轮转" */
  const c = M.compute({ width: 500, colW: 230, gap: GAP, aspects: [1, 2, 0.9] });
  ok('最短列优先：测试场景确为 2 列', c.cols === 2, '实测 ' + c.cols);
  const [p0, p1, p2] = c.positions;
  ok('#0 落在第 0 列', p0.x === 0);
  ok('#1 另起第 1 列', p1.x === c.colW + GAP, `#1.x=${p1.x}`);
  ok('#2 回到更矮的第 1 列（证明"最矮列优先"，而非轮转/按行）',
    p2.x === p1.x, `#1.x=${p1.x} #2.x=${p2.x}`);
  near('#2 紧接在 #1 下方（只隔一个列间距）', p2.y, p1.y + p1.h + GAP, 1e-9, 'px');
  ok('#2 的顶边低于 #0 的顶边（确实是后放的）', p2.y > p0.y);
}

{
  // 同高取最左：2 列、三张等高 → 第 3 张在"两列一样高"时应回到最左列
  const c = M.compute({ width: 500, colW: 230, gap: GAP, aspects: [1, 1, 1] });
  ok('等高时测试场景确为 2 列', c.cols === 2, '实测 ' + c.cols);
  const [p0, p1, p2] = c.positions;
  ok('等高平分后第 3 张回到最左列（结果确定、可断言）', p2.x === 0,
    `#0.x=${p0.x} #1.x=${p1.x} #2.x=${p2.x}`);
  near('第 3 张接在第 1 张正下方', p2.y, p0.y + p0.h + GAP, 1e-9, 'px');
}

{
  // 所有瓦片等宽；x 只取"列起点"这几个值
  const aspects = [1, 1.6, 0.7, 2.4, 1.1, 0.55, 1.9, 1, 0.8, 3.1, 1.33];
  const c = M.compute({ width: 1100, colW: 210, gap: GAP, aspects });
  const xs = new Set(c.positions.map((p) => Math.round(p.x * 1000) / 1000));
  ok('所有瓦片等宽', c.positions.every((p) => p.w === c.colW), 'colW=' + c.colW);
  ok('x 只取列起点（不出现半列）', xs.size === c.cols,
    'x 取值数=' + xs.size + ' 列数=' + c.cols);

  // 最右那张的右边缘 = 容器宽（恰好填满）
  let last = 0;
  for (let i = 1; i < c.positions.length; i++) if (c.positions[i].x > c.positions[last].x) last = i;
  near('最后一列右边缘 = 容器宽度', c.positions[last].x + c.positions[last].w, 1100, 1e-9, 'px');
}

{
  // 任意两张不重叠（含同列相邻与跨列）
  const aspects = [1, 1.6, 0.7, 2.4, 1.1, 0.55, 1.9, 1, 0.8, 3.1];
  const c = M.compute({ width: 1100, colW: 210, gap: GAP, aspects });
  const P = c.positions;
  let overlap = null;
  for (let i = 0; i < P.length && !overlap; i++) {
    for (let j = i + 1; j < P.length; j++) {
      const a = P[i], b = P[j];
      const xHit = a.x < b.x + b.w && b.x < a.x + a.w;
      const yHit = a.y < b.y + b.h && b.y < a.y + a.h;
      if (xHit && yHit) { overlap = `${i}↔${j}`; break; }
    }
  }
  ok('任意两张瓦片不重叠', overlap === null, overlap || '');
  ok('每张高度为正且有限', P.every((p) => p.h > 0 && isFinite(p.h)));
  ok('每张 y 非负', P.every((p) => p.y >= 0));
  ok('条目数 == 输入比例数', P.length === aspects.length);
}

{
  // totalH = 最高的那一列的底部
  const aspects = [1, 2, 0.8, 1.4, 0.6];
  const c = M.compute({ width: 900, colW: 210, gap: GAP, aspects });
  const bottoms = new Map();
  for (const p of c.positions) bottoms.set(p.x, Math.max(bottoms.get(p.x) || 0, p.y + p.h));
  let maxBottom = 0;
  for (const v of bottoms.values()) maxBottom = Math.max(maxBottom, v);
  near('totalH = 最高列的底部', c.totalH, maxBottom, 1e-9, 'px');
}

{
  // 极端竖长图封顶（否则一张图能把一列拉出屏幕）
  const c = M.compute({ width: 600, colW: 260, gap: GAP, aspects: [0.12] });
  near('极端竖长图高度封顶到 列宽 × MAX_H_RATIO',
    c.positions[0].h, c.colW * M.MAX_H_RATIO, 1e-9, 'px');
  ok('封顶后仍完整可见（object-fit: contain 会留白，不裁剪）',
    c.positions[0].h < c.colW / 0.12, 'h=' + c.positions[0].h);
}

{
  // 非法比例当正方形
  const c = M.compute({ width: 600, colW: 260, gap: GAP, aspects: [NaN, 0, -1, 'x'] });
  ok('非法比例一律按正方形排布',
    c.positions.every((p) => Math.abs(p.h - c.colW) < 1e-9),
    c.positions.map((p) => p.h).join(','));
}

/* ============================================================
   4. 两条坐标不变量 —— y 单调，底边**不**单调
   ============================================================ */
{
  // 刻意把一张"竖向长图"排在前面，再排一张"横向全景"：
  // 后者的底边会明显高于前者 → 底边序列必然不单调。
  const aspects = [0.5, 3.2, 1.1, 0.7, 2.4, 1.6, 0.9, 2.9, 1.3, 0.55, 1.8, 0.75, 2.2];
  const c = M.compute({ width: 1100, colW: 210, gap: GAP, aspects });
  const P = c.positions;

  ok('不变量①：y 单调不减（故 y 上可安全二分）', monoIncr(P.map((p) => p.y)),
    'y = ' + P.map((p) => +p.y.toFixed(1)).join(','));
  ok('不变量②：底边 y+h **不**单调（故底边上不能二分）', monoIncr(bottomsOf(P)) === false,
    '底边 = ' + bottomsOf(P).map((v) => +v.toFixed(1)).join(','));

  ok('yMax 单调不减', monoIncr(c.yMax), c.yMax.map((v) => +v.toFixed(1)).join(','));
  ok('yMax[i] 恰为 [0..i] 内最大的底边', c.yMax.every((v, i) => {
    let m = 0;
    for (let j = 0; j <= i; j++) m = Math.max(m, P[j].y + P[j].h);
    return Math.abs(m - v) < 1e-9;
  }));
  ok('yMax 末项 = 最大底边', Math.abs(c.yMax[c.yMax.length - 1]
    - Math.max.apply(null, bottomsOf(P))) < 1e-9);
}

/* ============================================================
   5. 覆盖性不变量 —— yMax 二分出的区间必须覆盖真正可见的每一张
   ============================================================ */
{
  /** 真的与 [lo,hi] 相交的条目（线性扫描，作为基准真值） */
  const trulyVisible = (P, lo, hi) => {
    const out = [];
    for (let i = 0; i < P.length; i++) {
      const p = P[i];
      if (p.y < hi && p.y + p.h > lo) out.push(i);
    }
    return out;
  };
  /** 与 grid.js `_computeRange` 的瀑布流分支一致：
      起点用单调的 yMax 找（底边不能二分），终点用单调的 y 找 */
  const rangeOf = (c, lo, hi) => {
    const P = c.positions, N = P.length;
    const yArr = P.map((p) => p.y);
    const vi0 = Math.max(0, M.lowerBound(c.yMax, lo) - 1);
    const vi1 = Math.min(N, M.upperBound(yArr, hi) + 1);
    return [vi0, vi1];
  };

  const seedAspects = [1, 1.6, 0.7, 2.4, 1.1, 0.55, 1.9, 1, 0.8, 3.1, 1.33, 0.62, 2.1, 1.45, 0.9];
  const layouts = [
    { width: 1000, colW: 210, aspects: seedAspects },
    { width: 640, colW: 160, aspects: seedAspects },
    { width: 1600, colW: 280, aspects: seedAspects },
  ];
  // 伪随机（线性同余，确定性 → 失败可复现，且不依赖 Math.random 的实现）
  let seed = 20260921;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const bigAspects = [];
  for (let i = 0; i < 120; i++) bigAspects.push(0.4 + rnd() * 3.2);
  layouts.push({ width: 1280, colW: 200, aspects: bigAspects });
  layouts.push({ width: 420, colW: 300, aspects: bigAspects });

  let uncovered = null, checked = 0;
  for (const L of layouts) {
    const c = M.compute({ width: L.width, colW: L.colW, gap: GAP, aspects: L.aspects });
    const step = Math.max(40, c.totalH / 60);
    for (let lo = 0; lo <= c.totalH; lo += step) {
      const hi = lo + 500;                       // 视口高 500 + 预取余量
      const [vi0, vi1] = rangeOf(c, lo, hi);
      for (const i of trulyVisible(c.positions, lo, hi)) {
        checked++;
        if (!(i >= vi0 && i < vi1)) {
          uncovered = `W=${L.width} colW=${L.colW} lo=${lo.toFixed(0)} hi=${hi.toFixed(0)}`
            + ` 第 ${i} 张漏在 [${vi0},${vi1}) 之外`;
          break;
        }
      }
      if (uncovered) break;
    }
    if (uncovered) break;
  }
  ok(`虚拟化区间覆盖全部可见条目（共核对 ${checked} 张次）`, uncovered === null, uncovered || '');
  ok('覆盖性检查确实跑到了（不是空转）', checked > 500, '核对次数 ' + checked);

  // 反向：区间必须真的在裁剪，否则"覆盖"是假的（等于没做窗口化）
  {
    const c = M.compute({ width: 1280, colW: 200, gap: GAP, aspects: bigAspects });
    const [vi0, vi1] = rangeOf(c, c.totalH * 0.5, c.totalH * 0.5 + 500);
    ok('窗口化真的在裁剪（区间远小于全量）', (vi1 - vi0) < c.positions.length * 0.8,
      `区间 ${vi0}..${vi1} / 共 ${c.positions.length}`);
    ok('区间起点小于终点', vi0 < vi1, `${vi0}..${vi1}`);
    ok('区间不越界', vi0 >= 0 && vi1 <= c.positions.length, `${vi0}..${vi1}`);
  }
}

/* ============================================================
   6. lowerBound / upperBound —— 二分边界
   ============================================================ */
{
  const a = [0, 5, 5, 9, 20];
  ok('lowerBound 命中已有值 → 第一个相等处', M.lowerBound(a, 5) === 1);
  ok('lowerBound 命中区间内 → 指向下一个更大值', M.lowerBound(a, 6) === 3);
  ok('lowerBound 小于全部 → 0', M.lowerBound(a, -1) === 0);
  ok('lowerBound 大于全部 → 长度', M.lowerBound(a, 99) === 5);
  ok('lowerBound 空数组 → 0', M.lowerBound([], 3) === 0);
  ok('lowerBound 单元素命中 → 0', M.lowerBound([4], 4) === 0);
  ok('lowerBound 单元素未命中 → 1', M.lowerBound([4], 5) === 1);

  ok('upperBound 命中已有值 → 最后一个相等处 +1', M.upperBound(a, 5) === 3);
  ok('upperBound 命中区间内 → 等于 lowerBound 结果', M.upperBound(a, 6) === 3);
  ok('upperBound 小于全部 → 0', M.upperBound(a, -1) === 0);
  ok('upperBound 大于全部 → 长度', M.upperBound(a, 99) === 5);
  ok('upperBound 空数组 → 0', M.upperBound([], 3) === 0);

  ok('全等数组 lowerBound 指向 0', M.lowerBound([7, 7, 7], 7) === 0);
  ok('全等数组 upperBound 指向长度', M.upperBound([7, 7, 7], 7) === 3);
}

/* ============================================================
   7. 确定性 —— 同样输入必须同样输出（布局可复现、可断言）
   ============================================================ */
{
  const args = { width: 1000, colW: 210, gap: GAP, aspects: [1, 1.7, 0.6, 2.2] };
  const snapshot = JSON.stringify(args.aspects);
  const a = M.compute(args), b = M.compute(args);
  ok('同样输入两次计算结果一致', JSON.stringify(a.positions) === JSON.stringify(b.positions));
  ok('不修改传入的 aspects 数组', JSON.stringify(args.aspects) === snapshot);
}

/* ============================================================
   汇总
   ============================================================ */
console.log('\n' + '='.repeat(64));
if (fail) {
  console.log('失败项：');
  failures.forEach((f) => console.log('  ✗ ' + f));
}
console.log(`masonry.js 单元测试：通过 ${pass} / ${pass + fail}`);
console.log('='.repeat(64));
process.exit(fail ? 1 : 0);
