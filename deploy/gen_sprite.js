/* ============================================================
   Atrium · 图标精灵生成器（手工工具，不属于回归套件）
   ------------------------------------------------------------
   把 **Lucide**（lucide-static，ISC 许可）的路径数据写进 index.html
   的 sprite 区（<!-- SPRITE:BEGIN --> … <!-- SPRITE:END -->）。

   为什么要有这个脚本，而不是手工贴 path：
   · 之前 42 个图标是手绘的，描边宽度有 1.2 / 1.4 / 1.5 / 1.6 / 1.7 /
     1.8 / 1.9 / 2.2 八种，圆角、起笔、视觉重量各写各的 —— 单看每个都
     像样，摆一排就"毛"。
   · 现在统一到 Lucide：同一套 24×24 网格、stroke-width 2、圆头圆角、
     统一留白。改图标 = 改下面这张表 + 重跑，不手改 path。

   用法（lucide-static 是**临时**依赖，不进项目 package.json —— 应用本身
   仍然零运行时依赖，sprite 是内联的）：
     cd ~/.workbuddy-ai/binaries/node/workspace && npm i lucide-static
     node deploy/gen_sprite.js
   可用 LUCIDE_DIR 指定 lucide-static/icons 的绝对路径。
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'index.html');

const LUCIDE = process.env.LUCIDE_DIR
  || path.join(process.env.USERPROFILE || process.env.HOME || '',
    '.workbuddy-ai', 'binaries', 'node', 'workspace', 'node_modules', 'lucide-static');

/* ---------- id → Lucide 图标 ----------
   左列是**必须保持稳定**的 id：index.html 与 js/*.js 都按 id 取图
   （Util.icon('i-star-fill') 这类），改名要连测试一起改，收益为零。
   fill: true 表示"实心变体"（收藏/置顶的选中态、播放/暂停），
   几何仍然取 Lucide，只是把 fill 从 none 换成 currentColor。 */
const MAP = [
  ['i-folder', 'folder'],
  ['i-grid-s', 'grid-3x3'],           // 小图网格：3×3 密排
  ['i-grid-m', 'layout-grid'],        // 中图网格：四块等比
  ['i-masonry', 'layout-dashboard'],  // 瀑布流：高矮相错的四块
  ['i-single', 'gallery-vertical'],   // 单列整屏：一张图占满，上下是轨
  ['i-search', 'search'],
  ['i-star', 'star'],
  ['i-star-fill', 'star', { fill: true }],
  ['i-x', 'x'],
  ['i-sidebar', 'panel-left'],
  ['i-left', 'chevron-left'],
  ['i-right', 'chevron-right'],
  ['i-plus', 'plus'],
  ['i-minus', 'minus'],
  ['i-fit', 'scan'],                  // 适应窗口：四角框住（全屏用箭头，形状不撞）
  ['i-film', 'film'],
  ['i-download', 'download'],
  ['i-eye', 'eye'],
  ['i-eye-off', 'eye-off'],
  ['i-sortdir', 'arrow-down'],
  ['i-expand', 'expand'],             // 全屏：四角向外
  ['i-collapse', 'shrink'],           // 退出全屏：四角向内
  ['i-play', 'play', { fill: true }],
  ['i-pause', 'pause', { fill: true }],
  ['i-info', 'info'],
  ['i-trash', 'trash-2'],
  ['i-undo', 'undo-2'],
  ['i-check', 'check'],
  ['i-rotate', 'rotate-cw'],
  ['i-arrows-h', 'move-horizontal'],
  ['i-wheel', 'mouse'],
  ['i-pin', 'pin'],
  ['i-pin-on', 'pin', { fill: true }],
  ['i-gear', 'settings'],
  ['i-frame', 'images'],
  ['i-shuffle', 'shuffle'],
];

/* 删掉的 6 个死图标（定义了但全站没有任何引用）：
   i-arrow-d / i-dir / i-hide / i-moon / i-restore / i-sun
   —— 留着只会让人以为"还有一套图标在用"。 */

function readIcon(dir, name) {
  const f = path.join(dir, 'icons', name + '.svg');
  if (!fs.existsSync(f)) throw new Error('Lucide 里没有这个图标: ' + name + '（' + f + '）');
  const raw = fs.readFileSync(f, 'utf8');
  const inner = raw
    .replace(/<!--[\s\S]*?-->/g, '')      // 去掉许可注释（许可写在文件头）
    .replace(/^[\s\S]*?<svg[^>]*>/, '')   // 去掉 <svg …>
    .replace(/<\/svg>[\s\S]*$/, '')       // 去掉 </svg>
    .replace(/\s*\n\s*/g, '')             // 压成一行：sprite 有 35 行，不压会撑到 300 行
    .trim();
  if (!inner) throw new Error('解析出来是空的: ' + name);
  return inner;
}

function buildSprite() {
  const rows = MAP.map(function (item) {
    const id = item[0], name = item[1], opt = item[2] || {};
    const inner = readIcon(LUCIDE, name);
    // 统一几何：24 网格 / 描边 2 / 圆头圆角。fill 变体只改 fill。
    const attrs = opt.fill
      ? 'fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"'
      : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
    return '  <symbol id="' + id + '" viewBox="0 0 24 24" ' + attrs + '>' + inner + '</symbol>';
  });
  return rows.join('\n');
}

function main() {
  const version = (function () {
    try { return JSON.parse(fs.readFileSync(path.join(LUCIDE, 'package.json'), 'utf8')).version; }
    catch (e) { return '?'; }
  })();
  const sprite = buildSprite();
  const html = fs.readFileSync(HTML, 'utf8');
  const BEGIN = '<!-- SPRITE:BEGIN -->', END = '<!-- SPRITE:END -->';
  const a = html.indexOf(BEGIN), b = html.indexOf(END);
  if (a < 0 || b < 0) throw new Error('index.html 里找不到 SPRITE:BEGIN / SPRITE:END 标记');
  const header = BEGIN + '\n  <!-- 由 deploy/gen_sprite.js 生成，别手改。\n'
    + '       图标来源：Lucide ' + version + '（ISC 许可，https://lucide.dev）。\n'
    + '       统一 24×24 网格 / stroke-width 2 / 圆头圆角；实心变体见 i-star-fill 等。\n'
    + '       改图标 = 改脚本里的 MAP 再重跑。 -->';
  const out = html.slice(0, a) + header + '\n' + sprite + '\n  ' + html.slice(b);
  fs.writeFileSync(HTML, out);
  console.log('已写入 ' + MAP.length + ' 个 Lucide 图标（lucide-static ' + version + '）→ index.html');
}

main();
