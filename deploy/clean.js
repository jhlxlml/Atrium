/**
 * 清理回归套件的运行期产物。
 *
 * 背景：`deploy/electron-test/logs/` 与 `shots/` 每次跑 run_all / run_probe 都会往里写东西 ——
 * 每个 Electron 探针会新建一个 `ud_*` 用户数据目录（内含完整的 Chromium Cache / GPUCache /
 * Code Cache，单个上百 MB），加上 `sbx-*` 沙箱目录与 trace 日志。
 * 2026-10-12 清理时它已经攒到 **2.5 GB / 17,518 个文件**。
 *
 * 这两处在 .gitignore 里已明确定性为「回归套件的运行期产物」，删了不影响任何源码与交付物：
 *   - run_all.js  :32   `if (!fs.existsSync(LOGS)) fs.mkdirSync(LOGS, {recursive:true})`
 *   - run_probe.js:103  `try { fs.mkdirSync(SHOTS, {recursive:true}) } catch {}`
 *   - zip_gate.js :48   `try { fs.mkdirSync(LOGS, {recursive:true}) } catch {}`
 * 目录会在下次运行时自动重建，所以这里**连目录一起删**。
 *
 * 用法：
 *   node deploy/clean.js          真删
 *   node deploy/clean.js --dry    只报不删
 *
 * 安全边界（写死，不接受参数）：只动下面这两个目录，不碰 js / css / test / brand /
 * index.html、deploy 下的 dist 与 dist-electron 产物、以及任何文档。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry');

/** 唯一允许清理的两处（相对 ROOT） */
const RUNTIME_DIRS = [
  'deploy/electron-test/logs',
  'deploy/electron-test/shots',
];

function measure(p) {
  let files = 0, dirs = 0, bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { dirs++; walk(f); }
      else { files++; try { bytes += fs.statSync(f).size; } catch (_) { /* 锁住 / 竞态 */ } }
    }
  };
  walk(p);
  return { files, dirs, bytes };
}

const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
let totalBytes = 0, totalFiles = 0, failed = [];

for (const rel of RUNTIME_DIRS) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { console.log('· ' + rel + ' 不存在，跳过'); continue; }
  const s = measure(p);
  totalBytes += s.bytes;
  totalFiles += s.files;
  if (DRY) {
    console.log('· [dry] ' + rel + ' → ' + s.files + ' 文件 / ' + s.dirs + ' 目录 / ' + mb(s.bytes));
    continue;
  }
  try {
    /* 用 fs.rmSync 而不是 fs.rmdirSync({recursive:true})：
       后者在 Node 22 / 24 上已经报 DEP0147「will be removed」，
       现在还能跑，未来某个版本会直接抛 —— 那会让 `npm run clean` 在
       一次无关的 Node 升级之后突然坏掉，而它坏掉的表现是"删不掉"，
       很容易被当成"被占用"糊过去。 */
    fs.rmSync(p, { recursive: true, force: true });
    console.log('✓ ' + rel + ' 已清空（回收 ' + s.files + ' 文件 / ' + mb(s.bytes) + '）');
  } catch (e) {
    failed.push(rel + ' :: ' + (e.code || e.message));
    console.log('✗ ' + rel + ' 删除失败：' + (e.code || e.message));
  }
}

console.log(
  (DRY ? '\n[dry] 合计可回收 ' : '\n合计回收 ') +
  totalFiles + ' 个文件 / ' + mb(totalBytes)
);
if (failed.length) {
  console.log('有 ' + failed.length + ' 项失败（通常是被占用，重启后再试）：');
  failed.forEach((f) => console.log('  ! ' + f));
  process.exit(1);
}
