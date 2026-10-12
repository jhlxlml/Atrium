/* ============================================================
   Atrium · exportlib.js （导出落盘）
   主进程与 Electron 回归探针共用同一份实现 ——
   避免「探针测的是另一份复制粘贴的代码」这种假绿。
   ============================================================ */
'use strict';
const path = require('path');
const fs = require('fs').promises;

/**
 * 在 dir 下求一个可用文件名：name 已存在则依次尝试 “ (2)”、“ (3)”…，
 * 绝不覆盖用户已有文件。9999 次仍未命中则退回时间戳后缀。
 */
async function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let cand = path.join(dir, name);
  for (let i = 1; i <= 9999; i++) {
    try {
      await fs.access(cand);
    } catch (e) {
      return cand;                                  // 不存在 → 可用
    }
    cand = path.join(dir, stem + ' (' + (i + 1) + ')' + ext);
  }
  return path.join(dir, stem + '_' + Date.now() + ext);
}

/**
 * 批量导出到 dir。
 * list = [ { src:绝对路径|null, name, dataB64? } ]
 *   - 有 src    → 逐字节复制原文件（无损、走文件流，不塞进 IPC）
 *   - 无 src    → 写入 dataB64（旋转烘焙后的 PNG/JPEG）
 * 返回 { ok, dir, results:[{ok,name,out}|{ok:false,name,reason,message?}] }
 */
async function exportFiles(dir, list) {
  if (!dir || typeof dir !== 'string') return { ok: false, reason: 'bad-dir' };
  const arr = Array.isArray(list) ? list : [];
  const out = [];
  for (const it of arr) {
    const name = (it && it.name) || 'image';
    try {
      const dest = await uniquePath(dir, path.basename(name));
      if (it && it.src) {
        const st = await fs.stat(it.src);
        if (!st.isFile()) { out.push({ ok: false, name: name, reason: 'not-file' }); continue; }
        await fs.copyFile(it.src, dest);
      } else if (it && it.dataB64) {
        await fs.writeFile(dest, Buffer.from(it.dataB64, 'base64'));
      } else {
        out.push({ ok: false, name: name, reason: 'no-source' });
        continue;
      }
      out.push({ ok: true, name: name, out: path.basename(dest) });
    } catch (err) {
      out.push({ ok: false, name: name, reason: 'failed', message: String((err && err.message) || err) });
    }
  }
  return { ok: true, dir: dir, results: out };
}

module.exports = { uniquePath: uniquePath, exportFiles: exportFiles };
