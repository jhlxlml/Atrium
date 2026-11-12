/* ============================================================
   Atrium · js/grid.js 布局算法测试（纯 Node，无需 Electron）
   ------------------------------------------------------------
   grid.js 的 mount/layout 依赖大量 DOM，但布局算法本身
   (_layoutCells / _layoutSingle / _layoutJustified) 是纯数学：
   给定 N 张图、容器宽、模式参数，输出 positions[] 和 totalH。

   这里用 harness 装载 state.js + util.js + masonry.js + grid.js，
   设置最小 DOM 桩（inner / document.body.dataset），然后直接调
   _layoutXxx 验证坐标不变量。

   锁住的不变量：
   - _layoutCells: 等边方格，每格大小一致，列数 = floor((W+gap)/(want+gap))
   - _layoutSingle: 每张等宽等高，y = i * slotH
   - _layoutJustified: 每行行高一致，行内不重叠，末行允许留白

   运行： node test/grid-layout.test.js
   ============================================================ */
'use strict';

const { useGlobalAsWindow, loadScript, makeAsserts } = require('./_harness');

useGlobalAsWindow();

/* ---------- DOM 桩 ---------- */
globalThis.CSS = { supports: () => false };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '0px' });
globalThis.document = {
  body: { dataset: { density: '' } },
  documentElement: { style: { setProperty() {} } },
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  createElement(tag) {
    const el = { tagName: tag, style: {}, dataset: {}, children: [],
      appendChild(c) { this.children.push(c); }, addEventListener() {}, removeEventListener() {},
      setAttribute() {}, getAttribute() { return null; }, classList: { add(){}, remove(){}, toggle(){} },
      getBoundingClientRect() { return { x:0, y:0, width:0, height:0, top:0, left:0, right:0, bottom:0 }; },
    };
    return el;
  },
};
globalThis.innerWidth = 1920;
globalThis.innerHeight = 1080;

/* ---------- 装载模块 ---------- */
loadScript('js/util.js');
loadScript('js/state.js');
loadScript('js/masonry.js');

/* grid.js 装载时引用 State.settings.mode，需要先设好 */
globalThis.State.settings = globalThis.State.settings || {};
globalThis.State.settings.mode = 'medium';
globalThis.State.settings.sizes = globalThis.State.settings.sizes || {};
globalThis.State.settings.sizes.small = 108;
globalThis.State.settings.sizes.medium = 248;
globalThis.State.settings.sizes.masonry = 208;

loadScript('js/grid.js');

const Grid = globalThis.Grid;
const A = makeAsserts();

/* ---------- 辅助：造 mock items ---------- */
function mockItems(n, ratio) {
  const items = [];
  for (let i = 0; i < n; i++) {
    items.push({ id: 'img-' + i, name: 'img-' + i + '.jpg', w: 1000, h: Math.round(1000 / ratio), _ratio: ratio });
  }
  return items;
}

function mockItemsVar(ratios) {
  return ratios.map((r, i) => ({ id: 'img-' + i, name: 'img-' + i + '.jpg', w: 1000, h: Math.round(1000 / r), _ratio: r }));
}

/* ---------- G1: _layoutCells 等边方格 ---------- */

(function testG1() {
  const N = 30;
  Grid.items = mockItems(N, 1.5);
  Grid.N = N;
  Grid.mode = 'small';
  Grid.inner = { style: {} };
  globalThis.State.settings.sizes.small = 120;
  globalThis.State.getModeSize = (m) => globalThis.State.settings.sizes[m] || 200;
  globalThis.State.MODES = globalThis.State.MODES || {};
  globalThis.State.MODES.small = { crop: true, def: 108, range: [72, 200] };

  const W = 1920;
  const CELL_GAP = 4;
  const want = 120;
  const cols = Math.max(1, Math.floor((W + CELL_GAP) / (want + CELL_GAP)));
  const cell = (W - (cols - 1) * CELL_GAP) / cols;
  const rows = Math.ceil(N / cols);

  Grid._layoutCells(W);

  A.eq('G1 positions 数量', Grid.positions.length, N);
  A.eq('G1 列数', Grid.cols, cols);
  A.ok('G1 格宽一致', Grid.positions.every(p => Math.abs(p.w - cell) < 0.01), '所有格宽度应该一致');
  A.ok('G1 格高一致', Grid.positions.every(p => Math.abs(p.h - cell) < 0.01), '所有格高度应该一致');
  A.eq('G1 第一个格 x=0', Grid.positions[0].x, 0);
  A.eq('G1 第一个格 y=0', Grid.positions[0].y, 0);
  A.eq('G1 第二列 x', Grid.positions[1].x, cell + CELL_GAP);
  A.eq('G1 第二行 y', Grid.positions[cols].y, cell + CELL_GAP);
  A.eq('G1 totalH', Grid.totalH, rows * (cell + CELL_GAP) - CELL_GAP + 90 /* BOTTOM_PAD */);
})();

/* ---------- G2: _layoutCells 不同宽度不出碎边 ---------- */

(function testG2() {
  const N = 100;
  Grid.items = mockItems(N, 1.5);
  Grid.N = N;
  Grid.mode = 'small';
  Grid.inner = { style: {} };

  for (const W of [800, 1200, 1920, 2560, 3840]) {
    Grid._layoutCells(W);
    const cell = Grid.cell;
    const cols = Grid.cols;
    /* 每行实际宽度应该 = cols * cell + (cols-1) * gap ≤ W，且差值 < cell（不留碎边） */
    const usedW = cols * cell + (cols - 1) * 4;
    A.ok('G2 W=' + W + ' 无碎边', usedW <= W + 0.01 && W - usedW < cell,
      'usedW=' + usedW.toFixed(1) + ' W=' + W + ' cell=' + cell.toFixed(1));
    /* 所有 x 都对齐到网格 */
    for (let i = 0; i < N; i++) {
      const c = i % cols;
      A.eq('G2 W=' + W + ' i=' + i + ' x', Grid.positions[i].x, c * (cell + 4));
    }
  }
})();

/* ---------- G3: _layoutSingle 等宽等高 ---------- */

(function testG3() {
  const N = 20;
  Grid.items = mockItems(N, 1.5);
  Grid.N = N;
  Grid.mode = 'single';
  Grid.inner = { style: {} };

  /* _layoutSingle 用 global.innerHeight - topH */
  globalThis.innerHeight = 1080;
  const W = 1920;
  Grid._layoutSingle(W);

  const SINGLE_MAXW = 1360;
  const expectedW = Math.min(W, SINGLE_MAXW);
  const leftOff = Math.max(0, (W - expectedW) / 2);

  A.eq('G3 positions 数量', Grid.positions.length, N);
  A.eq('G3 每张宽度', Grid.positions[0].w, expectedW);
  A.eq('G3 leftOff', Grid.leftOff, leftOff);
  /* 所有张等宽等高 */
  A.ok('G3 等宽', Grid.positions.every(p => p.w === expectedW));
  A.ok('G3 等高', Grid.positions.every(p => p.h === Grid.positions[0].h));
  /* y = i * slotH */
  const slotH = Grid.positions[0].h;
  for (let i = 0; i < N; i++) {
    A.eq('G3 i=' + i + ' y', Grid.positions[i].y, i * slotH);
  }
  /* totalH = N * slotH */
  A.eq('G3 totalH', Grid.totalH, N * slotH);
})();

/* ---------- G4: _layoutJustified 行内不重叠 ---------- */

(function testG4() {
  const ratios = [1.5, 1.5, 1.5, 0.75, 0.75, 1.0, 1.0, 1.5, 0.75, 2.0];
  const N = ratios.length;
  Grid.items = mockItemsVar(ratios);
  Grid.N = N;
  Grid.mode = 'medium';
  Grid.inner = { style: {} };
  globalThis.State.settings.sizes.medium = 248;
  globalThis.State.getModeSize = (m) => globalThis.State.settings.sizes[m] || 248;
  globalThis.State.MODES = globalThis.State.MODES || {};
  globalThis.State.MODES.medium = { crop: false, def: 248, range: [160, 620] };

  const W = 1920;
  const GAP = 12;
  Grid._layoutJustified(W);

  A.eq('G4 positions 数量', Grid.positions.length, N);

  /* 每行内的图不重叠：x + w <= next.x */
  /* 先分行：同一行的 y 相同 */
  const rows = [];
  let curY = null, curRow = [];
  for (let i = 0; i < N; i++) {
    const p = Grid.positions[i];
    if (curY === null || Math.abs(p.y - curY) < 0.01) {
      curRow.push(i);
      curY = p.y;
    } else {
      rows.push(curRow);
      curRow = [i];
      curY = p.y;
    }
  }
  if (curRow.length) rows.push(curRow);

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let k = 0; k < row.length - 1; k++) {
      const p1 = Grid.positions[row[k]];
      const p2 = Grid.positions[row[k + 1]];
      A.ok('G4 行' + r + ' 内 i=' + row[k] + ' 不重叠',
        p1.x + p1.w <= p2.x + 0.01,
        'x1+w1=' + (p1.x + p1.w).toFixed(1) + ' > x2=' + p2.x.toFixed(1));
    }
  }

  /* 行间不重叠：上一行底边 <= 下一行顶边 */
  for (let r = 0; r < rows.length - 1; r++) {
    const row1 = rows[r];
    const row2 = rows[r + 1];
    const bottom = Math.max.apply(null, row1.map(i => Grid.positions[i].y + Grid.positions[i].h));
    const top = Grid.positions[row2[0]].y;
    A.ok('G4 行' + r + '→' + (r+1) + ' 不重叠', bottom <= top + 0.01,
      'bottom=' + bottom.toFixed(1) + ' > top=' + top.toFixed(1));
  }

  /* 非末行行高一致 */
  for (let r = 0; r < rows.length - 1; r++) {
    const row = rows[r];
    const h0 = Grid.positions[row[0]].h;
    for (let k = 1; k < row.length; k++) {
      A.eq('G4 非末行' + r + ' 行高一致 i=' + row[k], Grid.positions[row[k]].h, h0);
    }
  }
})();

/* ---------- G5: _layoutJustified 空目录 ---------- */

(function testG5() {
  Grid.items = [];
  Grid.N = 0;
  Grid.mode = 'medium';
  Grid.inner = { style: {} };
  Grid._layoutJustified(1920);
  A.eq('G5 空目录 positions', Grid.positions.length, 0);
  A.eq('G5 空目录 totalH', Grid.totalH, 0);
})();

/* ---------- G6: _layoutCells 1 张图 ---------- */

(function testG6() {
  Grid.items = mockItems(1, 1.5);
  Grid.N = 1;
  Grid.mode = 'small';
  Grid.inner = { style: {} };
  Grid._layoutCells(1920);
  A.eq('G6 1张 positions', Grid.positions.length, 1);
  A.eq('G6 1张 x', Grid.positions[0].x, 0);
  A.eq('G6 1张 y', Grid.positions[0].y, 0);
})();

/* ---------- G7: _layoutJustified 末行留白 ---------- */

(function testG7() {
  /* 5 张 3:2 的图，medium 模式行高 248，宽 1920：
     每张宽 = 248*1.5 = 372，行宽 = 5*372 + 4*12 = 1908 < 1920，
     所以全进一行，是末行，末行留白时 rowH = H = 248 */
  Grid.items = mockItems(5, 1.5);
  Grid.N = 5;
  Grid.mode = 'medium';
  Grid.inner = { style: {} };
  globalThis.State.settings.sizes.medium = 248;
  globalThis.State.getModeSize = (m) => globalThis.State.settings.sizes[m] || 248;
  globalThis.State.MODES = globalThis.State.MODES || {};
  globalThis.State.MODES.medium = { crop: false, def: 248, range: [160, 620] };

  Grid._layoutJustified(1920);
  /* 只有 1 行 */
  A.eq('G7 positions', Grid.positions.length, 5);
  /* 末行行高 = H = 248（因为不满 92%） */
  const h0 = Grid.positions[0].h;
  A.ok('G7 末行留白 rowH=248', Math.abs(h0 - 248) < 0.1, 'h=' + h0);
  /* 末行右侧有留白：最后一张的 x+w < W */
  const last = Grid.positions[4];
  A.ok('G7 末行右侧留白', last.x + last.w < 1920, 'x+w=' + (last.x + last.w).toFixed(1));
})();

/* ---------- G8: _layoutCells 超大列数 ---------- */

(function testG8() {
  /* 极小的目标边长 + 极宽的容器 → 列数很大 */
  Grid.items = mockItems(500, 1.0);
  Grid.N = 500;
  Grid.mode = 'small';
  Grid.inner = { style: {} };
  globalThis.State.settings.sizes.small = 72; /* 最小 */
  globalThis.State.getModeSize = (m) => globalThis.State.settings.sizes[m] || 72;

  const W = 3840;
  Grid._layoutCells(W);
  const cols = Grid.cols;
  const cell = Grid.cell;
  /* 500 个 positions */
  A.eq('G8 positions', Grid.positions.length, 500);
  /* 所有格等宽 */
  A.ok('G8 等宽', Grid.positions.every(p => Math.abs(p.w - cell) < 0.01));
  /* 列数 = floor((3840+4)/(72+4)) = floor(3844/76) = 50 */
  const expectedCols = Math.floor((W + 4) / (72 + 4));
  A.eq('G8 列数', cols, expectedCols);
  /* 第 500 张（index 499）在最后一行 */
  const lastRow = Math.floor(499 / cols);
  const lastCol = 499 % cols;
  A.eq('G8 最后张 y', Grid.positions[499].y, lastRow * (cell + 4));
  A.eq('G8 最后张 x', Grid.positions[499].x, lastCol * (cell + 4));
})();

/* ---------- 汇总 ---------- */
const ok = A.finish('grid.js 布局算法');
process.exit(ok ? 0 : 1);
