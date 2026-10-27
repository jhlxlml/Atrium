/* ============================================================
   Atrium · verify_zip.js （独立 ZIP 完整性校验）
   ------------------------------------------------------------
   为什么需要它：pack.js 是"自己写的 ZIP 写入器"，如果只用它自己读回来
   校验，等于让考生自己批卷。本脚本刻意做到：
     1) CRC 参照值来自 Node 内置 zlib.crc32（原生实现），不用 pack.js 的 JS 表；
     2) 结构检查独立重算（EOCD / 中央目录 / 本地头 / 偏移连续性）；
     3) 逐条解压后重算 CRC，与「本地头」和「中央目录」两处写入值都比对；
     4) 传入 entries 时，再把解压结果与磁盘源文件逐字节比对。
   历史上踩过的坑：CRC 算在了「压缩后」字节流上（正确应算「压缩前」原始内容），
   7-Zip 会逐条报 CRC Failed。老校验只比字节数不查 CRC，所以没拦住。

   用法：node deploy/verify_zip.js                  # 校验根目录下所有 *.zip
        node deploy/verify_zip.js <a.zip> [b.zip…]  # 校验指定文件
   退出码：0 = 全部通过；1 = 有失败
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------- CRC32：优先用原生实现，保证与被测对象"非同源" ---------- */
const JS_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32js(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = JS_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const NATIVE = typeof zlib.crc32 === 'function' ? zlib.crc32 : null;

/** CRC 计算入口：能用原生就用原生，否则退回 JS 表（并说明已降级） */
function crc32(buf) {
  return (NATIVE ? NATIVE(buf) : crc32js(buf)) >>> 0;
}
const CRC_SOURCE = NATIVE ? 'zlib.crc32(native)' : 'js-table';

/** CRC 实现自检：标准测试向量 + 原生/JS 交叉验证，防止参照物本身是错的 */
function crcSelfTest() {
  const vectors = [
    ['', 0x00000000],
    ['a', 0xe8b7be43],
    ['abc', 0x352441c2],
    ['123456789', 0xcbf43926],
    ['The quick brown fox jumps over the lazy dog', 0x414fa339],
  ];
  const fails = [];
  for (const [s, want] of vectors) {
    const b = Buffer.from(s, 'utf8');
    if (crc32(b) !== want) fails.push(`native("${s}")=0x${crc32(b).toString(16)} 期望 0x${want.toString(16)}`);
    if (crc32js(b) !== want) fails.push(`js("${s}")=0x${crc32js(b).toString(16)} 期望 0x${want.toString(16)}`);
    if (NATIVE && NATIVE(b) !== crc32js(b)) fails.push(`原生与 JS 表不一致 ("${s}")`);
  }
  return { ok: fails.length === 0, fails, source: CRC_SOURCE };
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LH_SIG = 0x04034b50;

/**
 * 校验一个 ZIP。
 * @param {string} zipPath
 * @param {object} [opts] { entries }  entries = pack 时的输入清单
 *        [{ name, abs?, dir, mtime? }]，用于额外做「解压结果 == 源文件」比对
 * @returns {object} 报告
 */
function verifyZip(zipPath, opts) {
  const o = opts || {};
  const rep = {
    zip: path.basename(zipPath), path: zipPath, ok: false, size: 0, entries: 0,
    crcSource: CRC_SOURCE, crcOk: 0, crcBad: 0, struct: [], contentOk: 0, contentBad: 0, details: [],
  };
  const fail = (m) => { rep.struct.push(m); };

  let z;
  try { z = fs.readFileSync(zipPath); } catch (e) { fail('无法读取文件：' + e.message); return rep; }
  rep.size = z.length;
  if (z.length < 22) { fail('文件过小，不是合法 ZIP'); return rep; }

  /* --- EOCD：从尾部向前找签名 --- */
  let e = -1;
  const minStart = Math.max(0, z.length - 22 - 65535);
  for (let i = z.length - 22; i >= minStart; i--) {
    if (z.readUInt32LE(i) === EOCD_SIG) { e = i; break; }
  }
  if (e < 0) { fail('找不到 EOCD 结束记录'); return rep; }

  const disk = z.readUInt16LE(e + 4);
  const cdDisk = z.readUInt16LE(e + 6);
  const nThisDisk = z.readUInt16LE(e + 8);
  const nTotal = z.readUInt16LE(e + 10);
  const cdSize = z.readUInt32LE(e + 12);
  const cdOff = z.readUInt32LE(e + 16);
  const commentLen = z.readUInt16LE(e + 20);

  if (disk !== 0 || cdDisk !== 0) fail(`非单卷 ZIP（disk=${disk}, cdDisk=${cdDisk}）`);
  if (nThisDisk !== nTotal) fail(`本盘条目数(${nThisDisk}) ≠ 总条目数(${nTotal})`);
  if (commentLen !== 0) fail('EOCD 留有注释字节，与写入约定不符');
  if (cdOff + cdSize !== e) fail(`中央目录结束位置(${cdOff + cdSize}) ≠ EOCD 位置(${e})`);
  if (e + 22 !== z.length) fail(`EOCD 之后还有 ${z.length - (e + 22)} 字节多余数据`);

  rep.entries = nTotal;
  if (nTotal === 0) { fail('ZIP 内没有任何条目'); return rep; }
  if (nTotal === 0xffff || cdOff === 0xffffffff) { fail('条目数/偏移达到 ZIP64 阈值，本写入器不支持 ZIP64'); return rep; }

  /* --- 逐条解析中央目录 --- */
  const seen = new Set();
  let p = cdOff;
  let maxLocalEnd = 0;
  const central = [];
  for (let k = 0; k < nTotal; k++) {
    if (p + 46 > z.length) { fail(`第 ${k + 1} 条：中央目录头越界`); break; }
    if (z.readUInt32LE(p) !== CD_SIG) { fail(`第 ${k + 1} 条：中央目录签名错误 @${p}`); break; }
    const rec = {
      k: k, name: '', method: z.readUInt16LE(p + 10), crc: z.readUInt32LE(p + 16),
      csize: z.readUInt32LE(p + 20), usize: z.readUInt32LE(p + 24),
      nameLen: z.readUInt16LE(p + 28), extraLen: z.readUInt16LE(p + 30), cmtLen: z.readUInt16LE(p + 32),
      diskStart: z.readUInt16LE(p + 34), extAttr: z.readUInt32LE(p + 38), lho: z.readUInt32LE(p + 42),
      flags: z.readUInt16LE(p + 8),
    };
    rec.name = z.slice(p + 46, p + 46 + rec.nameLen).toString('utf8');
    if (seen.has(rec.name)) fail(`条目名重复：${rec.name}`);
    seen.add(rec.name);
    if (rec.diskStart !== 0) fail(`${rec.name}：起始分卷号非 0`);
    if (rec.extraLen !== 0 || rec.cmtLen !== 0) fail(`${rec.name}：中央目录 extra/comment 非空（与写入约定不符）`);
    central.push(rec);
    p += 46 + rec.nameLen + rec.extraLen + rec.cmtLen;
  }
  if (p !== cdOff + cdSize) fail(`中央目录实际长度 ${p - cdOff} ≠ 声明长度 ${cdSize}`);
  if (rep.struct.length) return rep;

  /* --- 逐条解压 + CRC 双向比对 --- */
  for (const rec of central) {
    const d = { name: rec.name, ok: true, why: [] };
    const lho = rec.lho;
    if (lho + 30 > z.length) { d.ok = false; d.why.push('本地头越界'); rep.crcBad++; rep.details.push(d); continue; }
    if (z.readUInt32LE(lho) !== LH_SIG) { d.ok = false; d.why.push('本地头签名错误'); rep.crcBad++; rep.details.push(d); continue; }

    const lMethod = z.readUInt16LE(lho + 8);
    const lCrc = z.readUInt32LE(lho + 14);
    const lCsize = z.readUInt32LE(lho + 18);
    const lUsize = z.readUInt32LE(lho + 22);
    const lNameLen = z.readUInt16LE(lho + 26);
    const lExtraLen = z.readUInt16LE(lho + 28);

    if (lMethod !== rec.method) d.why.push(`压缩方法不一致 本地=${lMethod} 中央=${rec.method}`);
    if (lCrc !== rec.crc) d.why.push(`CRC 本地=0x${lCrc.toString(16)} 中央=0x${rec.crc.toString(16)}`);
    if (lCsize !== rec.csize) d.why.push(`压缩长度不一致 本地=${lCsize} 中央=${rec.csize}`);
    if (lUsize !== rec.usize) d.why.push(`原始长度不一致 本地=${lUsize} 中央=${rec.usize}`);
    const lName = z.slice(lho + 30, lho + 30 + lNameLen).toString('utf8');
    if (lName !== rec.name) d.why.push(`条目名不一致 本地="${lName}" 中央="${rec.name}"`);

    /* 本地头与中央目录是同一份元数据的两处副本，任何一处对不上都说明包被动过手脚
       或写入器有 bug。**这里必须显式判负**：原来只往 why 里记一句、不碰 d.ok，
       于是"本地头被改坏、中央目录与数据都正确"的包会一路走到最后被判通过
       （解压后的 CRC 与中央目录是相符的，它确实能查出来内容没问题）。
       7-Zip 遇到这种包会直接报错，用户那边就是"下载完解不开"。 */
    if (d.why.length) d.ok = false;

    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const dataEnd = dataStart + rec.csize;
    if (dataEnd > cdOff) { d.ok = false; d.why.push('数据区越界，压到中央目录上'); rep.crcBad++; rep.details.push(d); continue; }
    maxLocalEnd = Math.max(maxLocalEnd, dataEnd);

    const comp = z.slice(dataStart, dataEnd);
    let raw = null;
    try {
      if (rec.method === 0) raw = comp;
      else if (rec.method === 8) raw = zlib.inflateRawSync(comp);
      else d.why.push(`未知压缩方法 ${rec.method}`);
    } catch (err) {
      d.why.push('解压失败：' + err.message);
    }

    if (!raw) {
      d.ok = false;
    } else if (raw.length !== rec.usize) {
      d.ok = false; d.why.push(`解压后长度 ${raw.length} ≠ 声明 ${rec.usize}`);
    } else {
      const real = crc32(raw);
      if (real !== rec.crc) {
        d.ok = false;
        d.why.push(`CRC 不符：存储=0x${rec.crc.toString(16)} 实算=0x${real.toString(16)}`);
      }
      // 压缩方法 8 时，压缩结果必须真的比原始小（写入时的选法约定）
      if (rec.method === 8 && rec.csize >= rec.usize) d.why.push(`method=8 但压缩后(${rec.csize}) 不小于原始(${rec.usize})`);
    }

    if (d.ok) rep.crcOk++; else { rep.crcBad++; rep.details.push(d); }
    rec._raw = raw;
  }

  // 本地头数据必须连续铺满到中央目录起点（无空洞、无重叠）
  if (maxLocalEnd !== cdOff) fail(`本地数据结束于 ${maxLocalEnd}，但中央目录起于 ${cdOff}（差 ${cdOff - maxLocalEnd} 字节）`);

  /* --- 可选：解压结果 vs 磁盘源文件 --- */
  if (Array.isArray(o.entries)) {
    const byName = new Map(o.entries.map((x) => [x.name, x]));
    for (const rec of central) {
      const src = byName.get(rec.name);
      if (!src) { fail(`源清单里缺少条目：${rec.name}`); continue; }
      if (src.dir) { if (rec.usize !== 0) fail(`${rec.name}：目录条目原始长度应为 0`); continue; }
      if (!src.abs) { fail(`${rec.name}：源清单未提供 abs`); continue; }
      let want;
      try { want = fs.readFileSync(src.abs); } catch (err) { fail(`${rec.name}：读源文件失败 ${err.message}`); continue; }
      if (!rec._raw || !rec._raw.equals(want)) { rep.contentBad++; fail(`${rec.name}：解压结果与源文件不一致`); }
      else rep.contentOk++;
    }
    const extra = o.entries.filter((x) => !seen.has(x.name));
    if (extra.length) fail(`有 ${extra.length} 个源条目未被写入：${extra.slice(0, 3).map((x) => x.name).join(', ')}`);
  }

  rep.ok = rep.struct.length === 0 && rep.crcBad === 0 && rep.contentBad === 0;
  return rep;
}

/** 人类可读的一行摘要 */
function summarize(rep) {
  const parts = [
    `${rep.entries} 个条目`,
    `CRC 正确 ${rep.crcOk}`,
    rep.crcBad ? `CRC 错误 ${rep.crcBad}` : null,
    rep.contentOk ? `内容字节一致 ${rep.contentOk}` : null,
    rep.struct.length ? `结构问题 ${rep.struct.length}` : null,
  ].filter(Boolean);
  return `[${rep.ok ? '通过' : '失败'}] ${rep.zip} — ${parts.join(' / ')}  (CRC 参照: ${rep.crcSource})`;
}

module.exports = { verifyZip, summarize, crcSelfTest, crc32, crc32js };

/* ---------- CLI ---------- */
if (require.main === module) {
  const st = crcSelfTest();
  console.log('CRC 实现自检：' + (st.ok ? '通过' : '失败 — ' + st.fails.join('；')) + '（参照：' + st.source + '）');
  if (!st.ok) process.exit(1);

  const ROOT = path.resolve(__dirname, '..');
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const zips = args.length
    ? args
    : fs.readdirSync(ROOT).filter((f) => f.toLowerCase().endsWith('.zip')).map((f) => path.join(ROOT, f));

  if (!zips.length) { console.log('没有找到任何 .zip'); process.exit(1); }

  let bad = 0;
  for (const zp of zips) {
    const rep = verifyZip(zp);
    console.log(summarize(rep));
    for (const s of rep.struct) console.log('   · 结构: ' + s);
    for (const d of rep.details.slice(0, 5)) console.log('   · ' + d.name + ': ' + d.why.join('；'));
    if (rep.details.length > 5) console.log(`   · …另有 ${rep.details.length - 5} 条同类问题`);
    if (!rep.ok) bad++;
  }
  console.log(bad === 0 ? '全部 ZIP 校验通过' : `有 ${bad} 个 ZIP 未通过`);
  process.exit(bad === 0 ? 0 : 1);
}
