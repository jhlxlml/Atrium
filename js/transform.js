/* ============================================================
   Atrium · transform.js
   ------------------------------------------------------------
   纯几何层：把「适应缩放 / 定点缩放 / 旋转后包围盒 / 平移约束 /
   transform 串生成」全部抽成不依赖 DOM 的纯函数。

   为什么要单独一层（v1.5.0）：
   缩放、旋转、平移共用同一条 CSS transform 链，历史上多次出现
   「改一条碰坏另两条」。抽成纯函数后，几何可用 Node 毫秒级断言，
   不必启动 Electron，三条路径的相互影响变得可枚举、可测试。

   约定：transform-origin 恒为 0 0（图片左上角）。
   因此旋转必须显式绕「缩放后的显示中心」进行，见 computeTransform。
   ============================================================ */
(function (global) {
  'use strict';

  /** 数值夹取（本地实现，保持本模块零依赖，可在 Node 直接 require） */
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /** 旋转 90°/270° 时长宽互换后的 1× 有效尺寸 */
  function orientedSize(baseW, baseH, rot) {
    return (rot % 180 === 0) ? { w: baseW, h: baseH } : { w: baseH, h: baseW };
  }

  /**
   * 「适应」缩放：整图完整落进可用区。
   * @returns {number} 缩放倍数（已按 min/max 夹取）
   */
  function fitScale(opts) {
    const baseW = opts.baseW, baseH = opts.baseH, rot = opts.rot || 0;
    const min = opts.min == null ? 0.05 : opts.min;
    const max = opts.max == null ? 3 : opts.max;
    const o = orientedSize(baseW, baseH, rot);
    if (!o.w || !o.h) return 1;
    return clamp(Math.min(opts.availW / o.w, opts.availH / o.h), min, max);
  }

  /**
   * 以舞台坐标 (cx,cy) 为不动点缩放 —— 光标下的内容坐标保持不变。
   *
   * 推导（rot=0 时显示映射为 X = lx*s + ox，其中 ox = 舞台中心X + tx - 基准宽*s/2）：
   *   要求 (F - ox') / s' === (F - ox) / s，令 k = s'/s、p = F - 舞台中心：
   *   → t' = t * k + p * (1 - k)
   *
   * ⚠️ 历史实现写的是 t' = t + p*(1-k)（少乘了 t 的 k），
   * 只在 t=0 时两者相等，所以早期探针「缩放零漂移」是假阳性；
   * 一旦先拖动（t≠0）再缩放，光标下的内容会滑动。此处为修正版。
   *
   * @returns {{scale:number, tx:number, ty:number, changed:boolean}}
   */
  function zoomAt(state, opts) {
    const scale = state.scale;
    const ns = clamp(scale * opts.f, opts.min, opts.max);
    const k = ns / scale;
    if (!isFinite(k) || k === 1) return { scale: ns, tx: state.tx, ty: state.ty, changed: false };
    const px = opts.cx - opts.stageCx;
    const py = opts.cy - opts.stageCy;
    return {
      scale: ns,
      tx: state.tx * k + px * (1 - k),
      ty: state.ty * k + py * (1 - k),
      changed: true,
    };
  }

  /**
   * 旋转后图片在舞台坐标系中的显示包围盒。
   * 旋转均为 90° 整数倍，故「长宽互换」即精确包围盒，无需对角线膨胀。
   */
  function displayBox(opts) {
    const o = orientedSize(opts.baseW, opts.baseH, opts.rot || 0);
    const w = o.w * opts.scale, h = o.h * opts.scale;
    const cx = opts.stageCx + opts.tx, cy = opts.stageCy + opts.ty;
    return {
      w: w, h: h, cx: cx, cy: cy,
      l: cx - w / 2, r: cx + w / 2,
      t: cy - h / 2, b: cy + h / 2,
    };
  }

  /**
   * 图片任一方向超出舞台 → 才“需要”平移。
   * 注意：这是状态判断，不是拖动门槛（拖动在任何倍率下都应可用）。
   */
  function canPan(box, stageW, stageH, eps) {
    const e = eps == null ? 0.5 : eps;
    return box.w > stageW + e || box.h > stageH + e;
  }

  /**
   * 平移上限。
   * 大图：恰好贴边不露白，上限 = (显示尺寸 - 舞台) / 2。
   * 小图：放宽到 freeLimit，使「缩小后也能拖」，且不会被拖出视野。
   */
  function panLimit(opts) {
    const lx = (opts.box.w - opts.stageW) / 2;
    const ly = (opts.box.h - opts.stageH) / 2;
    const free = opts.freeLimit;
    return {
      x: lx <= 0 ? free : lx,
      y: ly <= 0 ? free : ly,
      freeX: lx <= 0,
      freeY: ly <= 0,
    };
  }

  /** 把平移量夹回合法范围 */
  function clampPan(state, opts) {
    const lim = panLimit(opts);
    return {
      tx: clamp(state.tx, -lim.x, lim.x),
      ty: clamp(state.ty, -lim.y, lim.y),
      lim: lim,
    };
  }

  /**
   * 生成 CSS transform 串与关键几何量。
   *
   * CSS 变换自右向左作用于元素坐标系，净效果：
   *   1) translate(ox,oy)              左上角送到目标位置
   *   2) translate(hw,hh)              原点移到显示中心
   *   3) rotate(rot)                   绕显示中心旋转（中心不动）
   *   4) translate(-hw,-hh)            坐标还原
   *   5) scale(scale)                  以左上角为基准缩放
   * → 显示中心恒为 (舞台中心 + t)，任何倍率、任何角度都严格居中。
   */
  function computeTransform(opts) {
    const baseW = opts.baseW, baseH = opts.baseH, scale = opts.scale, rot = opts.rot || 0;
    const w = baseW * scale, h = baseH * scale;
    const hw = w / 2, hh = h / 2;
    const ox = opts.stageCx + opts.tx - hw;
    const oy = opts.stageCy + opts.ty - hh;
    const transform =
      'translate(' + ox + 'px,' + oy + 'px) ' +
      'translate(' + hw + 'px,' + hh + 'px) rotate(' + rot + 'deg) ' +
      'translate(' + (-hw) + 'px,' + (-hh) + 'px) scale(' + scale + ')';
    return {
      transform: transform,
      ox: ox, oy: oy, w: w, h: h,
      center: { x: opts.stageCx + opts.tx, y: opts.stageCy + opts.ty },
      bbox: displayBox({
        baseW: baseW, baseH: baseH, scale: scale, rot: rot,
        tx: opts.tx, ty: opts.ty, stageCx: opts.stageCx, stageCy: opts.stageCy,
      }),
    };
  }

  const Transform = {
    clamp: clamp,
    orientedSize: orientedSize,
    fitScale: fitScale,
    zoomAt: zoomAt,
    displayBox: displayBox,
    canPan: canPan,
    panLimit: panLimit,
    clampPan: clampPan,
    computeTransform: computeTransform,
  };

  global.Transform = Transform;
  if (typeof module !== 'undefined' && module.exports) module.exports = Transform;
})(typeof window !== 'undefined' ? window : globalThis);
