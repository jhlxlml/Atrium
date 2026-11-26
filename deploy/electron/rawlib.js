/* ============================================================
   Atrium · rawlib.js
   相机 RAW 文件内嵌 JPEG 预览图提取（零外部依赖，纯二进制解析）
   支持：DNG / CR2 / NEF / ARW / RAF / ORF / RW2 / PEF / SRW
   ============================================================ */
'use strict';

const fs = require('fs').promises;

const RAW_EXT = new Set(['dng', 'cr2', 'nef', 'arw', 'raf', 'orf', 'rw2', 'pef', 'srw']);
const MAX_HEAD = 262144;            // 256 KB：足够覆盖绝大多数相机 RAW 的 IFD / SubIFD 结构
const MAX_PREVIEW = 32 * 1024 * 1024; // 单张预览图最大 32 MB 保护上限

function isRawExt(ext) {
  return RAW_EXT.has(String(ext || '').toLowerCase().replace(/^\./, ''));
}

function u16(buf, off, le) {
  return le ? buf.readUInt16LE(off) : buf.readUInt16BE(off);
}

function u32(buf, off, le) {
  return le ? buf.readUInt32LE(off) : buf.readUInt32BE(off);
}

function isJpegMagic(buf, off) {
  return off >= 0 && off + 2 <= buf.length && buf[off] === 0xff && buf[off + 1] === 0xd8;
}

/**
 * 从 RAW 文件头部缓冲中定位所有候选内嵌 JPEG 预览段。
 * 返回按长度降序排列的 [{ offset, length }]（不含超出 fileSize 或超限条目）。
 */
function findPreviewCandidates(buf, fileSize) {
  if (!buf || buf.length < 16) return [];
  const total = typeof fileSize === 'number' && fileSize > 0 ? fileSize : buf.length;
  const out = [];
  const push = (offset, length) => {
    if (!Number.isFinite(offset) || !Number.isFinite(length)) return;
    if (offset <= 0 || length < 512 || length > MAX_PREVIEW) return;
    if (offset + length > total) return;
    out.push({ offset, length });
  };

  // 1) Fujifilm RAF："FUJIFILMCCD-RAW "，0x54 为 JPEG 偏移，0x58 为 JPEG 长度（大端）
  if (buf.length >= 0x5c && buf.toString('ascii', 0, 16) === 'FUJIFILMCCD-RAW ') {
    push(buf.readUInt32BE(0x54), buf.readUInt32BE(0x58));
    return out.sort((a, b) => b.length - a.length);
  }

  // 2) TIFF-based RAW（DNG / CR2 / NEF / ARW / PEF / SRW / ORF）
  let le = null;
  if (buf[0] === 0x49 && buf[1] === 0x49) le = true;       // II
  else if (buf[0] === 0x4d && buf[1] === 0x4d) le = false; // MM
  else return out;

  const magic = u16(buf, 2, le);
  // 42: 标准 TIFF/DNG/CR2/NEF/ARW；0x4f52 ('RO') / 0x5352 ('RS'): Olympus ORF；0x0055: Panasonic RW2
  if (magic !== 42 && magic !== 0x4f52 && magic !== 0x5352 && magic !== 0x0055) return out;

  const queue = [u32(buf, 4, le)];
  const visited = new Set();
  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8, 13: 4 };

  const readValOff = (entryOff, type, count) => {
    const sz = (TYPE_SIZE[type] || 1) * count;
    const dataOff = sz <= 4 ? entryOff + 8 : u32(buf, entryOff + 8, le);
    return dataOff;
  };

  const readIntArr = (entryOff, type, count) => {
    const dOff = readValOff(entryOff, type, count);
    const step = TYPE_SIZE[type] || 4;
    if (dOff < 0 || dOff + step * count > buf.length) return [];
    const arr = [];
    for (let i = 0; i < count; i++) {
      const p = dOff + i * step;
      if (type === 3) arr.push(u16(buf, p, le));
      else if (type === 4 || type === 13) arr.push(u32(buf, p, le));
    }
    return arr;
  };

  while (queue.length && visited.size < 24) {
    const ifdOff = queue.shift();
    if (!ifdOff || visited.has(ifdOff) || ifdOff + 2 > buf.length) continue;
    visited.add(ifdOff);
    const count = u16(buf, ifdOff, le);
    if (count > 256 || ifdOff + 2 + count * 12 > buf.length) continue;

    let jpgOff = 0, jpgLen = 0;
    let stripOff = 0, stripLen = 0, comp = 0;
    for (let i = 0; i < count; i++) {
      const e = ifdOff + 2 + i * 12;
      const tag = u16(buf, e, le);
      const type = u16(buf, e + 2, le);
      const cnt = u32(buf, e + 4, le);
      if (tag === 0x0201) jpgOff = readIntArr(e, type, 1)[0] || 0;
      else if (tag === 0x0202) jpgLen = readIntArr(e, type, 1)[0] || 0;
      else if (tag === 0x0111 && cnt === 1) stripOff = readIntArr(e, type, 1)[0] || 0;
      else if (tag === 0x0117 && cnt === 1) stripLen = readIntArr(e, type, 1)[0] || 0;
      else if (tag === 0x0103) comp = readIntArr(e, type, 1)[0] || 0;
      else if (tag === 0x014a && cnt > 0 && cnt <= 8) {
        for (const sub of readIntArr(e, type, cnt)) queue.push(sub);
      } else if (tag === 0x8769) {
        const ex = readIntArr(e, type, 1)[0];
        if (ex) queue.push(ex);
      }
    }
    if (jpgOff && jpgLen) push(jpgOff, jpgLen);
    if (stripOff && stripLen && (comp === 6 || comp === 7 || comp === 1)) push(stripOff, stripLen);

    const nextPos = ifdOff + 2 + count * 12;
    if (nextPos + 4 <= buf.length) {
      const next = u32(buf, nextPos, le);
      if (next) queue.push(next);
    }
  }

  return out.sort((a, b) => b.length - a.length);
}

/** 从磁盘 RAW 文件中读取最大有效内嵌 JPEG 预览图 Buffer；无可用预览返回 null */
async function extractFilePreview(filePath) {
  let fh = null;
  try {
    fh = await fs.open(filePath, 'r');
    const st = await fh.stat();
    if (!st.isFile() || st.size < 64) return null;
    const headLen = Math.min(st.size, MAX_HEAD);
    const head = Buffer.allocUnsafe(headLen);
    const { bytesRead } = await fh.read(head, 0, headLen, 0);
    const headView = bytesRead === headLen ? head : head.subarray(0, bytesRead);
    const candidates = findPreviewCandidates(headView, st.size);
    for (const c of candidates) {
      if (c.offset + c.length <= headView.length) {
        if (isJpegMagic(headView, c.offset)) {
          return Buffer.from(headView.subarray(c.offset, c.offset + c.length));
        }
        continue;
      }
      const out = Buffer.allocUnsafe(c.length);
      const r = await fh.read(out, 0, c.length, c.offset);
      if (r.bytesRead === c.length && isJpegMagic(out, 0)) return out;
    }
    return null;
  } catch (e) {
    return null;
  } finally {
    if (fh) { try { await fh.close(); } catch (e) { /* ignore */ } }
  }
}

module.exports = {
  RAW_EXT,
  isRawExt,
  findPreviewCandidates,
  extractFilePreview,
};
