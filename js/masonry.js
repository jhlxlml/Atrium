/* ============================================================
   Atrium · masonry.js
   ------------------------------------------------------------
   纯布局层：瀑布流（不等高列，手机相册那种排法）的排布计算。

   为什么单独一层（与 transform.js / a11y.js 同一思路）：
   排布结果决定瓦片的绝对坐标，属"几何"，必须能脱离 Electron 在 Node 里
   毫秒级断言。grid.js 只负责把这里算出的 {x,y,w,h} 写进 DOM。

   三个刻意的设计：
   ① **列宽恰好填满容器** —— 列数由「目标列宽」推出来之后，实际列宽重新
      按容器宽度均分，不按目标值原样用。否则右侧会留下一条随窗口宽度
      变化、宽度不定的缝。
   ② **每张放进当前最矮的列** —— 这才是瀑布流；按行填会退化成不等高的行网格。
   ③ **只缩放、不裁剪** —— 瓦片高度 = 列宽 / 宽高比，整张图完整可见
      （配合 .tile img 的 object-fit: contain）。唯一例外是极端竖长图，
      高度封顶到列宽的 MAX_H_RATIO 倍，否则一张图能把一列拉出屏幕。

   ── 两条坐标不变量（grid.js 的窗口化/锚点/框选都建立在这上面）──
   记 y_i = 第 i 张的顶边，b_i = 第 i 张的底边（= y_i + h_i）。

   ① y **单调不减**。证明：每张都放进"当前最矮的列"，各列高度只增不减，
      所以"最矮列的高度"这个序列本身不会下降。故 y 上可以安全二分。
   ② b **不单调**。同一列里后放的矮图，底边可能比前面那张高图还靠上
      （极端例子：先放一张横图再放一张更矮的横图）。
      故 b 上**不能**二分 —— 为此本模块额外输出 yMax（[0..i] 内最大的底边），
      yMax 单调不减，用作"从哪一张开始才可能进入视口"的下界。

   ⚠️ 这两条是承重的：用错一个，症状是"滚到某处有图不显示"或框选漏选，
      而且只在特定宽高比组合下复现。test/masonry.test.js 逐条锁住。
   ============================================================ */
(function (global) {
  'use strict';

  const MIN_COL = 72;        // 列宽下限：再窄就认不出内容，宁可少一列
  const MAX_H_RATIO = 3;     // 单张最大高宽比（h ≤ 列宽 × 3），防极端竖长图拉爆一列

  /** 有效宽高比 w/h：非法值一律当正方形（与 grid.js 的 _aspect 兜底一致） */
  function aspectOf(v) {
    return (typeof v === 'number' && isFinite(v) && v > 0) ? v : 1;
  }

  /**
   * 该宽度下能放几列、实际列宽多少。
   * 目标列宽只用来**决定列数**；实际列宽按容器均分，保证刚好填满。
   * @returns {{cols:number, colW:number}}
   */
  function columns(width, colW, gap) {
    const w = Number(width);
    const want = Number(colW);
    const g = Math.max(0, Number(gap) || 0);
    const avail = (isFinite(w) && w > 0) ? w : 0;
    const target = Math.max(MIN_COL, (isFinite(want) && want > 0) ? want : MIN_COL);

    // n 列占宽 = n*target + (n-1)*g ≤ avail  →  n ≤ (avail+g)/(target+g)
    let n = Math.floor((avail + g) / (target + g));
    if (!isFinite(n) || n < 1) n = 1;

    let real = (avail - (n - 1) * g) / n;
    if (!(real > 0)) { n = 1; real = Math.max(1, avail); }   // 容器窄到放不下一列时退化为单列铺满
    return { cols: n, colW: real };
  }

  /**
   * 瀑布流排布。
   * @param {{width:number, colW:number, gap:number, aspects:number[]}} o
   * @returns {{positions:Array<{x:number,y:number,w:number,h:number}>,
   *            cols:number, colW:number, totalH:number, yMax:number[]}}
   *   yMax[i] = positions[0..i] 里最大的底边 y+h（单调不减）
   */
  function compute(o) {
    const opts = o || {};
    const aspects = Array.isArray(opts.aspects) ? opts.aspects : [];
    const N = aspects.length;
    const gap = Math.max(0, Number(opts.gap) || 0);
    const r = columns(opts.width, opts.colW, gap);
    const cols = r.cols, colW = r.colW;

    const heights = new Array(cols);
    for (let c = 0; c < cols; c++) heights[c] = 0;

    const positions = new Array(N);
    const yMax = new Array(N);
    const maxH = colW * MAX_H_RATIO;

    let runMax = 0;

    for (let i = 0; i < N; i++) {
      // 最矮的列；同样高取最靠左的（保证结果确定、可断言）
      let pick = 0;
      for (let c = 1; c < cols; c++) if (heights[c] < heights[pick]) pick = c;

      const a = aspectOf(aspects[i]);
      let h = colW / a;
      if (!isFinite(h) || h <= 0) h = colW;          // 兜底：当作正方形
      if (h > maxH) h = maxH;                        // 极端竖长图封顶（宁可留白也不撑爆）
      const y = heights[pick];

      positions[i] = { x: pick * (colW + gap), y: y, w: colW, h: h };
      heights[pick] = y + h + gap;

      const bottom = y + h;
      if (bottom > runMax) runMax = bottom;
      yMax[i] = runMax;
    }

    let totalH = 0;
    for (let c = 0; c < cols; c++) {
      const bottom = heights[c] - gap;               // 末张之后不加间距
      if (bottom > totalH) totalH = bottom;
    }

    return {
      positions: positions, cols: cols, colW: colW,
      totalH: totalH > 0 ? totalH : 0,
      yMax: yMax,
    };
  }

  /** 单调不减数组上：第一个 ≥ v 的下标；都小于 v 时返回 arr.length。
      （等价于 C++ std::lower_bound） */
  function lowerBound(arr, v) {
    let a = 0, b = arr.length;
    while (a < b) { const m = (a + b) >> 1; if (arr[m] < v) a = m + 1; else b = m; }
    return a;
  }

  /** 单调不减数组上：≤ v 的元素个数，即"最后一个 ≤ v 的下标 + 1"；都大于 v 时返回 0。
      （等价于 C++ std::upper_bound） */
  function upperBound(arr, v) {
    let a = 0, b = arr.length;
    while (a < b) { const m = (a + b) >> 1; if (arr[m] <= v) a = m + 1; else b = m; }
    return a;
  }

  const Masonry = {
    MIN_COL: MIN_COL,
    MAX_H_RATIO: MAX_H_RATIO,
    aspectOf: aspectOf,
    columns: columns,
    compute: compute,
    lowerBound: lowerBound,
    upperBound: upperBound,
  };

  global.Masonry = Masonry;
  if (typeof module !== 'undefined' && module.exports) module.exports = Masonry;
})(typeof window !== 'undefined' ? window : globalThis);
