/* ============================================================
   Atrium · Frame 纯函数单元测试（纯 Node）
   ------------------------------------------------------------
   为什么值得单测：相框的三处"算错了也不会报错、只会看起来怪"的逻辑 ——
     1) 随机序列（洗牌）：写错就会重复播某几张、另几张永远轮不到；
     2) 旋转后的有效宽高：90° 的竖图算错，窗口会被摆成横的、图片两边留大黑边；
     3) 按比例装箱 + 居中夹取：算错会让窗口跑出屏幕外，或者比例对不上图片。
   这三件事都是纯计算，放在 Node 里钉死最便宜。

   frame.js 是挂 window 的 IIFE，且顶层不碰 DOM（DOM 只在 boot 时才用），
   所以沙箱里给一个 window 就能加载。

   运行： node test/frame.test.js
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ---------- 极简断言框架 ---------- */
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail ? '  → ' + detail : ''));
}
function eq(name, got, want) {
  ok(name, got === want, '实测 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want));
}

/* ---------- 在沙箱里加载 frame.js ---------- */
function loadFrame() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'frame.js'), 'utf8');
  const sandbox = { Math, JSON, Date, console, setTimeout, clearTimeout };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'frame.js' });
  const F = sandbox.Frame;
  if (!F || typeof F.shuffle !== 'function') throw new Error('frame.js 里没有导出 Frame.shuffle');
  return F;
}

const Frame = loadFrame();

/* 确定性伪随机（mulberry32）：可复现，且分布够均匀 */
function prng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ============================================================
   1. 洗牌：是一个排列、确实被打乱、不改入参
   ============================================================ */
{
  const src = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const out = Frame.shuffle(src, prng(7));
  eq('洗牌结果长度不变', out.length, src.length);
  ok('洗牌结果与原数组不是同一个引用（不动入参）', out !== src);
  eq('入参保持原样未被就地打乱', src.join(','), '0,1,2,3,4,5,6,7,8,9');
  const sorted = out.slice().sort((a, b) => a - b);
  eq('洗牌结果是 0..n-1 的一个完整排列（不多不少不重复）', sorted.join(','), src.join(','));
  ok('洗牌确实打乱了（n=10 时等于原序的概率极低）', out.join(',') !== src.join(','), out.join(','));

  // 空数组 / 单元素：不能抛
  eq('空数组洗牌返回空数组', Frame.shuffle([], prng(1)).length, 0);
  eq('单元素洗牌原样返回', Frame.shuffle(['x'], prng(1)).join(','), 'x');
}

/* ============================================================
   2. 播放序列：每轮都是一个完整排列，且轮与轮之间不撞同一张
   ============================================================ */
{
  const rnd = prng(42);
  const N = 12;
  const orders = [];
  let last = -1;
  for (let k = 0; k < 200; k++) {
    const o = Frame.makeOrder(N, rnd, last);
    ok('第 ' + k + ' 轮序列是完整排列', o.slice().sort((a, b) => a - b).join(',') ===
      Array.from({ length: N }, (_, i) => i).join(','));
    if (k > 0) {
      ok('第 ' + k + ' 轮的首位不与上一轮末位相同（不连播两张）', o[0] !== last,
        'first=' + o[0] + ' last=' + last);
    }
    orders.push(o);
    last = o[o.length - 1];
  }
  // 长跑下来每张都应该被放到过首位（否则说明洗牌有偏 / 被固定住）
  const firsts = new Set(orders.map((o) => o[0]));
  ok('200 轮里每张图都至少当过 1 次首位（无系统性偏斜）', firsts.size === N,
    '覆盖 ' + firsts.size + '/' + N);

  // 池子只有 1 张时不能死循环 / 不能越界
  eq('单张池子序列只有自己', Frame.makeOrder(1, prng(3), -1).join(','), '0');
  eq('单张池子且上轮就是它，仍然返回它', Frame.makeOrder(1, prng(3), 0).join(','), '0');
  eq('空池子返回空序列', Frame.makeOrder(0, prng(3), -1).length, 0);
}

/* ============================================================
   3. 旋转后的有效宽高（窗口比例要按"看到的形状"算）
   ============================================================ */
{
  const cases = [
    [4000, 3000, 0, 4000, 3000],
    [4000, 3000, 90, 3000, 4000],
    [4000, 3000, 180, 4000, 3000],
    [4000, 3000, 270, 3000, 4000],
    [3000, 4000, 90, 4000, 3000],
    [4000, 3000, 360, 4000, 3000],
    [4000, 3000, -90, 3000, 4000],     // 负数也要归整
    [4000, 3000, 450, 3000, 4000],     // 非 90 倍数先归整再判断
    [4000, 3000, undefined, 4000, 3000],
  ];
  for (const [w, h, r, ew, eh] of cases) {
    const o = Frame.oriented(w, h, r);
    eq('oriented(' + w + '×' + h + ', ' + r + '°) 的宽', o.w, ew);
    eq('oriented(' + w + '×' + h + ', ' + r + '°) 的高', o.h, eh);
  }
}

/* ============================================================
   4. 按比例装箱
   ============================================================ */
{
  const area = { W: 1600, H: 1000 };                     // 可用区域比例 1.6

  // 宽图（2:1，比区域更"扁"）→ 宽受限，占满宽
  let b = Frame.fitBox(area.W, area.H, 2000, 1000);
  eq('宽图占满宽', b.w, 1600);
  eq('宽图高度按比例', b.h, 800);
  ok('装箱结果不超出可用区域', b.w <= area.W && b.h <= area.H, JSON.stringify(b));
  ok('装箱结果贴合区域（至少一条边顶满）', b.w === area.W || b.h === area.H, JSON.stringify(b));
  let ratioErr = Math.abs((b.w / b.h) - (2000 / 1000));
  ok('装箱后宽高比与图片一致（误差 <0.5%）', ratioErr < 0.005, 'err=' + ratioErr.toFixed(5));

  // 4:3 图（比区域更"高"）→ 高受限，占满高
  b = Frame.fitBox(area.W, area.H, 4000, 3000);
  eq('4:3 图占满高', b.h, 1000);
  eq('4:3 图宽度按比例', b.w, 1333);
  ok('4:3 装箱也在区域内', b.w <= area.W && b.h <= area.H, JSON.stringify(b));
  ratioErr = Math.abs((b.w / b.h) - (4000 / 3000));
  ok('4:3 装箱后宽高比与图片一致（误差 <0.5%）', ratioErr < 0.005, 'err=' + ratioErr.toFixed(5));

  // 竖图：改成占满高
  b = Frame.fitBox(area.W, area.H, 3000, 4000);
  eq('3:4 竖图占满高', b.h, 1000);
  eq('3:4 竖图宽度按比例', b.w, 750);
  ok('竖图装箱也在区域内', b.w <= area.W && b.h <= area.H);

  // 超宽全景：不能退化成一条线
  b = Frame.fitBox(area.W, area.H, 12000, 600);
  ok('超宽全景有最小高度兜底（>=170）', b.h >= Frame.MIN_H, JSON.stringify(b));
  ok('超宽全景有最小宽度兜底', b.w >= Frame.MIN_W, JSON.stringify(b));

  // 超高长图
  b = Frame.fitBox(area.W, area.H, 600, 12000);
  ok('超长竖图有最小宽度兜底（>=260）', b.w >= Frame.MIN_W, JSON.stringify(b));
  ok('超长竖图不越界', b.w <= area.W && b.h <= area.H, JSON.stringify(b));

  // 尺寸未知（还没量出来）也不能返回 0 或 NaN
  b = Frame.fitBox(area.W, area.H, 0, 0);
  ok('尺寸未知时给一个可用默认值', b.w > 0 && b.h > 0 && b.w <= area.W && b.h <= area.H, JSON.stringify(b));
  b = Frame.fitBox(area.W, area.H, NaN, NaN);
  ok('尺寸为 NaN 时同样给可用默认值', b.w > 0 && b.h > 0, JSON.stringify(b));
  ok('装箱结果恒为整数', Number.isInteger(b.w) && Number.isInteger(b.h), JSON.stringify(b));
}

/* ============================================================
   5. 居中 + 夹取（多屏时区域可能不以 0 为原点）
   ============================================================ */
{
  const area = { x: 0, y: 0, width: 1920, height: 1040 };

  let r = Frame.centerIn(area, 800, 600, 960, 520);
  eq('按中心点放置的 x', r.x, 560);
  eq('按中心点放置的 y', r.y, 220);

  // 中心点靠在右下角 → 必须被夹回区域内（不能把窗口推到屏幕外）
  r = Frame.centerIn(area, 800, 600, 1900, 1030);
  ok('中心点越界时被夹住（右下）', r.x + r.w <= area.width && r.y + r.h <= area.height,
    JSON.stringify(r));
  eq('右下夹取后的 x', r.x, 1120);
  eq('右下夹取后的 y', r.y, 440);

  // 中心点靠在左上角
  r = Frame.centerIn(area, 800, 600, 10, 10);
  eq('左上夹取后的 x', r.x, 0);
  eq('左上夹取后的 y', r.y, 0);

  // 非法中心点（还没量到窗口位置）→ 落到区域正中
  r = Frame.centerIn(area, 800, 600, null, undefined);
  eq('中心点缺失时落在区域正中 x', r.x, 560);
  eq('中心点缺失时落在区域正中 y', r.y, 220);

  // 多屏：第二块屏的原点不是 0
  const area2 = { x: -1920, y: -200, width: 1920, height: 1080 };
  r = Frame.centerIn(area2, 800, 600, -960, 340);
  eq('副屏（负原点）x 计算正确', r.x, -1360);
  eq('副屏（负原点）y 计算正确', r.y, 40);
  r = Frame.centerIn(area2, 800, 600, 5000, 5000);   // 中心点明显不在副屏内
  ok('中心点不在区域内时落到该区域正中', r.x === area2.x + (1920 - 800) / 2
    && r.y === area2.y + (1080 - 600) / 2, JSON.stringify(r));
  ok('副屏结果不越界', r.x >= area2.x && r.x + r.w <= area2.x + area2.width
    && r.y >= area2.y && r.y + r.h <= area2.y + area2.height, JSON.stringify(r));

  // 窗口比区域还大：夹取后仍不能出现负数坐标（宁可溢出也不越到负方向）
  r = Frame.centerIn({ x: 0, y: 0, width: 400, height: 300 }, 800, 600, 200, 150);
  eq('窗口大于区域时 x 夹到区域原点', r.x, 0);
  eq('窗口大于区域时 y 夹到区域原点', r.y, 0);
}

/* ============================================================
   6. 相册池筛选（全部 / 收藏 / 某个文件夹）
   ============================================================ */
{
  const items = [
    { id: 'a', sid: 'f1', name: 'a.jpg' },
    { id: 'b', sid: 'f1', name: 'b.jpg' },
    { id: 'c', sid: 'f2', name: 'c.jpg' },
    { id: 'd', sid: 'f2', name: 'd.jpg', bad: true },   // 打不开的必须排除
  ];
  const favs = new Set(['b', 'd']);
  const isFav = (id) => favs.has(id);

  eq('全部图片：排除坏图', Frame.pickPool(items, 'all', isFav).length, 3);
  eq('只看收藏：坏图即使收藏了也不算', Frame.pickPool(items, 'fav', isFav).length, 1);
  eq('只看收藏取到的正是那一张', Frame.pickPool(items, 'fav', isFav)[0].id, 'b');
  eq('指定文件夹 f1', Frame.pickPool(items, 'f1', isFav).length, 2);
  eq('指定文件夹 f2（排除坏图）', Frame.pickPool(items, 'f2', isFav).length, 1);
  eq('不存在的文件夹 → 空池', Frame.pickPool(items, 'f9', isFav).length, 0);

  // 池子为空 / 入参缺失都不该抛
  eq('空图库返回空池', Frame.pickPool([], 'all', isFav).length, 0);
  eq('items 为 undefined 也不抛', Frame.pickPool(undefined, 'all', isFav).length, 0);
  eq('没有 isFav 时收藏池为空', Frame.pickPool(items, 'fav', null).length, 0);
}

/* ============================================================
   7. 吸附到屏幕边 + 贴边摆放（v1.9.0）
   ------------------------------------------------------------
   这两件事算错的后果都是"看起来只是有点怪"：贴了边却留一条缝、
   或者贴下边时把窗口摆到屏幕外、或者贴的是整块屏幕而不是工作区
   （被任务栏盖住半条控制条）—— 都不会抛错，所以必须在 Node 里钉死。
   ============================================================ */
{
  // 工作区 1920×1040，任务栏在下方
  const area = { x: 0, y: 0, width: 1920, height: 1040 };

  eq('紧贴左边（距离 0）', Frame.snapEdge(area, { x: 0, y: 300, width: 800, height: 600 }), 'left');
  eq('距左边 8px（阈值内）', Frame.snapEdge(area, { x: 8, y: 300, width: 800, height: 600 }), 'left');
  eq('距左边 40px（阈值外）', Frame.snapEdge(area, { x: 40, y: 300, width: 800, height: 600 }), null);
  eq('紧贴右边', Frame.snapEdge(area, { x: 1120, y: 300, width: 800, height: 600 }), 'right');
  eq('紧贴上边', Frame.snapEdge(area, { x: 500, y: 0, width: 800, height: 600 }), 'top');
  // 下边的判据是"窗口下边缘 vs 工作区下边缘"，不是整块屏幕的下边缘 ——
  // 否则窗口会被任务栏盖住一条
  eq('紧贴下边（任务栏之上）', Frame.snapEdge(area, { x: 500, y: 440, width: 800, height: 600 }), 'bottom');
  // 角落同时贴两条边 → 取更近的那条
  eq('左上角同时贴两边取更近者（上边）', Frame.snapEdge(area, { x: 2, y: 0, width: 800, height: 600 }), 'top');
  eq('左上角同时贴两边取更近者（左边）', Frame.snapEdge(area, { x: 0, y: 3, width: 800, height: 600 }), 'left');
  eq('屏幕正中不贴任何边', Frame.snapEdge(area, { x: 560, y: 220, width: 800, height: 600 }), null);
  eq('阈值放大到 50 后 40px 也算贴边', Frame.snapEdge(area, { x: 40, y: 300, width: 800, height: 600 }, 50), 'left');
  // 副屏：availLeft/availTop 不为 0，必须按工作区原点算
  const off = { x: 1920, y: 0, width: 1280, height: 1024 };
  eq('工作区原点非零时按工作区算', Frame.snapEdge(off, { x: 1920, y: 200, width: 800, height: 600 }), 'left');
  eq('落在别的工作区里不算贴这边', Frame.snapEdge(off, { x: 1200, y: 200, width: 800, height: 600 }), null);
  eq('area 缺失返回 null', Frame.snapEdge(null, { x: 0, y: 0, width: 1, height: 1 }), null);
  eq('rect 缺失返回 null', Frame.snapEdge(area, null), null);
}

{
  const area = { x: 0, y: 0, width: 1920, height: 1040 };

  const L = Frame.dockBox(area, 800, 600, 'left', 0, 960, 520);
  eq('贴左边：x 贴到 0', L.x, 0);
  eq('贴左边：自由轴保持原中心', L.y, 220);
  eq('贴左边：尺寸原样', L.w + 'x' + L.h, '800x600');

  const R = Frame.dockBox(area, 800, 600, 'right', 0, 960, 520);
  eq('贴右边：右边缘与工作区右边缘重合', R.x + R.w, 1920);

  const T = Frame.dockBox(area, 800, 600, 'top', 0, 960, 520);
  eq('贴上边：y 贴到 0', T.y, 0);
  eq('贴上边：自由轴保持原中心', T.x, 560);

  const B = Frame.dockBox(area, 800, 600, 'bottom', 0, 960, 520);
  eq('贴下边：下边缘与工作区下边缘重合', B.y + B.h, 1040);

  eq('可留边距', Frame.dockBox(area, 800, 600, 'left', 8, 960, 520).x, 8);

  // 中心给不出有效值（窗口位置还没读回来）时退回区域中心。
  // 注意 null/NaN 必须显式判类型 —— `null >= 0` 在 JS 里是 true，光靠区间判断会漏
  const N = Frame.dockBox(area, 800, 600, 'left', 0, NaN, NaN);
  eq('无有效中心时仍然贴边', N.x, 0);
  eq('无有效中心时自由轴取区域中心', N.y, 220);
  eq('edge 非四条边时不贴边、居中', Frame.dockBox(area, 800, 600, 'none', 0, null, null).x, 560);

  // 窗口比工作区还大 → 宁可比例不对，也不能算出负坐标把窗口推出屏幕
  eq('窗口超宽时左边缘不越界', Frame.dockBox(area, 2400, 1400, 'right', 0, 960, 520).x, 0);
  eq('窗口超高时上边缘不越界', Frame.dockBox(area, 2400, 1400, 'bottom', 0, 960, 520).y, 0);

  // 副屏在主屏左侧 → 工作区原点为负
  const off = { x: -1280, y: 0, width: 1280, height: 1024 };
  eq('负坐标工作区贴左边', Frame.dockBox(off, 800, 600, 'left', 0, -640, 512).x, -1280);
  eq('负坐标工作区贴右边', Frame.dockBox(off, 800, 600, 'right', 0, -640, 512).x + 800, 0);
}

{
  // 组合：一次真实拖动 —— 落点判定 → 吸附摆放
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const dropped = { x: 5, y: 240, width: 760, height: 570 };
  const edge = Frame.snapEdge(area, dropped, 14);
  eq('拖动落点靠近左边 → 判为左边', edge, 'left');
  const snapped = Frame.dockBox(area, dropped.width, dropped.height, edge, 0,
    dropped.x + dropped.width / 2, dropped.y + dropped.height / 2);
  eq('吸附后严丝合缝贴住左边', snapped.x, 0);
  ok('吸附不改变窗口尺寸', snapped.w === dropped.width && snapped.h === dropped.height,
    snapped.w + 'x' + snapped.h);
  ok('吸附后仍整个在工作区内', snapped.y >= 0 && snapped.y + snapped.h <= area.height,
    'y=' + snapped.y + ' h=' + snapped.h);
  eq('拖到屏幕中间后不再判为贴边', Frame.snapEdge(area, { x: 600, y: 300, width: 760, height: 570 }, 14), null);
}

/* ---------- 结果 ---------- */
if (fail) {
  console.error('\n✗ frame 纯函数：' + pass + ' 通过 / ' + fail + ' 失败\n');
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('✓ frame 纯函数：' + pass + ' 断言全部通过');
