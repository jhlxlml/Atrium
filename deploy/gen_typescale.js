/* ============================================================
   Atrium · gen_typescale.js
   ------------------------------------------------------------
   把三份 CSS 里写死的 `font-size: Npx` 全部换成字号令牌。

   为什么要有这个脚本而不是手改：
     1618 + 316 + 249 行 CSS 里散着 60 多处 font-size，手改一定会漏。
     漏一处的后果不是"报错"，而是"某一处字号还停在旧体系里"——
     这种不一致恰好就是本次要清掉的东西。脚本改完会逐条打印
     `文件:行  旧值 → 令牌`，可以对着 diff 复核，也可以重跑验证幂等。

   用法：
     node deploy/gen_typescale.js          # 实际改写
     node deploy/gen_typescale.js --dry    # 只打印不落盘
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry');
const FILES = ['css/main.css', 'css/lightbox.css', 'css/frame.css'];

/* 旧值 → 令牌。**半像素一律向上取整**：
   往小取会让 10.5 变成 10，与已经是 10 的角标撞档、层级反而更糊；
   往大取最多多 0.5px，不会有人觉得"字变小了"。 */
const SCALE = {
  '9.5': '--fs-2xs',   // → 10
  '10': '--fs-2xs',
  '10.5': '--fs-xs',   // → 11
  '11': '--fs-xs',
  '11.5': '--fs-s',    // → 12
  '12': '--fs-s',
  '12.5': '--fs',      // → 13
  '13': '--fs',
  '13.5': '--fs',      // → 13
  '14.5': '--fs-l',    // → 15
  '15': '--fs-l',
  '17': '--fs-title',
  '18': '--fs-title',  // → 17：回收站标题对齐设置/弹窗标题
  '19': '--fs-hero',
  '26': '--fs-display',
};

/* 同一个旧值在不同语境里要落到不同档 —— 这两处必须点名，
   否则会被上面的默认表吞掉（14 默认没有条目，落下来就是"未映射"）。 */
const BY_SELECTOR = [
  { file: 'css/main.css', selector: '.sp-title', px: '14', token: '--fs' },       // 设置分组标题：13
  { file: 'css/main.css', selector: '.empty-desc', px: '14', token: '--fs-l' },   // 空态说明段：15
];

const stats = { changed: 0, skipped: 0, unmapped: [] };
const log = [];

/* 找出某个字符位置所在的 CSS 选择器（往回找最近的 `{` 前那段，以及它所在的行）。 */
function selectorAt(src, idx) {
  const brace = src.lastIndexOf('{', idx);
  if (brace < 0) return '';
  let start = Math.max(src.lastIndexOf('}', brace), src.lastIndexOf(';', brace), src.lastIndexOf('{', brace - 1)) + 1;
  let end = src.indexOf('{', start);
  return src.slice(start, end).replace(/\s+/g, ' ').trim();
}

for (const rel of FILES) {
  const abs = path.join(ROOT, rel);
  let src = fs.readFileSync(abs, 'utf8');
  const before = src;

  src = src.replace(/font-size:\s*([0-9]+(?:\.[0-9]+)?)px/g, (m, px, offset) => {
    const sel = selectorAt(src, offset);
    const override = BY_SELECTOR.find((r) => r.file === rel && r.px === px &&
      sel.split(',').some((s) => s.trim().startsWith(r.selector)));
    const token = override ? override.token : SCALE[px];

    if (!token) {
      stats.unmapped.push(`${rel}  ${px}px  选择器: ${sel}`);
      return m;
    }
    const line = src.slice(0, offset).split('\n').length;
    log.push(`${rel}:${line}  ${px}px → var(${token})${override ? '   [按选择器点名]' : ''}   ${sel.slice(0, 60)}`);
    stats.changed++;
    return `font-size: var(${token})`;
  });

  /* --micro 并入 --fs-xs（同为 11px，两套名字并存只会让下一个人不知道用哪个） */
  src = src.replace(/var\(--micro\)/g, () => {
    stats.changed++;
    log.push(`${rel}  var(--micro) → var(--fs-xs)`);
    return 'var(--fs-xs)';
  });

  if (!DRY && src !== before) fs.writeFileSync(abs, src);
  if (src === before) stats.skipped++;
}

/* ---- 报告 ---- */
console.log(log.join('\n'));
console.log('');
console.log(`替换 ${stats.changed} 处，未变文件 ${stats.skipped} 个${DRY ? '（dry-run，未落盘）' : ''}`);
if (stats.unmapped.length) {
  console.log('');
  console.log('!! 未映射（脚本没动它们，需要人工决定归哪一档）：');
  for (const u of stats.unmapped) console.log('   ' + u);
  process.exitCode = 1;
}
