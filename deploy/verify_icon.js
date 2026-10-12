/* ============================================================
   Atrium · verify_icon.js —— 图标资产独立校验
   ------------------------------------------------------------
   为什么需要独立一份：make_icons.js 生成 ICO 时是"按自己理解的规范"写的，
   用它自己的函数去校验它自己，等于自证。这里**不复用**那边任何代码，
   重新按 ICO 规范解析一遍，并且额外做三件事：
     ① 逐条比对"目录项声明的尺寸"与"内嵌 PNG 的 IHDR 真实尺寸"；
     ② 校验每张图的数据偏移处确实是 PNG 签名（字节数对得上不代表内容对）；
     ③ 反向用例：故意造三种坏包，确认校验器真的会拒绝（否则门禁是假的）。

   用法：node deploy/verify_icon.js [icoPath]
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DEFAULT_ICO = path.resolve(__dirname, '..', 'brand', 'icon.ico');

/**
 * 按 ICO 规范解析。ICONDIR(6) + ICONDIRENTRY(16) × n + 图像数据。
 * 宽高字段是 1 字节，约定 0 表示 256。
 * @returns {{ok:boolean, errors:string[], entries:Array}}
 */
function checkIco(buf) {
  const errors = [];
  const entries = [];

  if (!Buffer.isBuffer(buf) || buf.length < 6) {
    return { ok: false, errors: ['文件不足 6 字节，不是 ICO'], entries: [] };
  }
  const reserved = buf.readUInt16LE(0);
  const type = buf.readUInt16LE(2);
  const count = buf.readUInt16LE(4);

  if (reserved !== 0) errors.push('ICONDIR.reserved 应为 0，实为 ' + reserved);
  if (type !== 1) errors.push('ICONDIR.type 应为 1（图标），实为 ' + type);
  if (count <= 0) errors.push('图像数量为 ' + count);
  if (6 + 16 * count > buf.length) errors.push('目录项超出文件长度');

  for (let i = 0; i < count; i++) {
    const o = 6 + 16 * i;
    if (o + 16 > buf.length) { errors.push('#' + i + ' 目录项越界'); break; }

    const w = buf.readUInt8(o);
    const h = buf.readUInt8(o + 1);
    const bpp = buf.readUInt16LE(o + 6);
    const len = buf.readUInt32LE(o + 8);
    const off = buf.readUInt32LE(o + 12);
    const declared = w === 0 ? 256 : w;

    const e = { index: i, whField: w, declared: declared, bpp: bpp, len: len, offset: off };

    if (w !== h) errors.push('#' + i + ' 宽高字段不一致（' + w + '×' + h + '）');
    if (bpp !== 32) errors.push('#' + i + ' bpp 应为 32，实为 ' + bpp);
    if (off + len > buf.length) errors.push('#' + i + ' 数据区间越界（off+len=' + (off + len) + ' > ' + buf.length + '）');
    if (off < 6 + 16 * count) errors.push('#' + i + ' 数据偏移落进了目录区');

    // 内嵌 PNG：签名 + IHDR 真实尺寸必须与声明一致
    if (off + 24 <= buf.length) {
      const sigOk = buf.slice(off, off + 8).equals(PNG_SIG);
      e.isPng = sigOk;
      if (!sigOk) {
        errors.push('#' + i + ' 偏移处不是 PNG 签名（Windows 会读不出这张）');
      } else {
        const iw = buf.readUInt32BE(off + 16);
        const ih = buf.readUInt32BE(off + 20);
        e.innerW = iw;
        e.innerH = ih;
        if (iw !== declared || ih !== declared) {
          errors.push('#' + i + ' 声明 ' + declared + 'px 但 PNG 实际 ' + iw + '×' + ih);
        }
      }
    }

    entries.push(e);
  }

  // 正常图标不会只有一张，且应覆盖小尺寸
  const sizes = entries.map(function (e) { return e.declared; });
  if (count > 1 && sizes.indexOf(16) < 0) errors.push('缺少 16px（列表视图会用）');
  if (count > 1 && sizes.indexOf(256) < 0) errors.push('缺少 256px（大图标视图会用）');

  return { ok: errors.length === 0, errors: errors, entries: entries };
}

/* ---------- 反向用例：坏包必须被拒，否则门禁是摆设 ---------- */
function selfTest(goodBuf) {
  const results = [];

  const cases = [
    {
      name: '截断（数据区间越界）',
      buf: goodBuf.slice(0, goodBuf.length - 100),
    },
    {
      name: '篡改一张的 PNG 签名',
      buf: (function () {
        const b = Buffer.from(goodBuf);
        b.writeUInt8(0x00, bufferOffsetOfFirstImage(goodBuf));   // 89 → 00
        return b;
      })(),
    },
    {
      name: '把 count 改成 99 造成目录越界',
      buf: (function () {
        const b = Buffer.from(goodBuf);
        b.writeUInt16LE(99, 4);
        return b;
      })(),
    },
  ];

  for (const c of cases) {
    const r = checkIco(c.buf);
    results.push({ name: c.name, rejected: !r.ok, errors: r.errors.slice(0, 2) });
  }
  return results;
}

function bufferOffsetOfFirstImage(buf) {
  return buf.readUInt32LE(6 + 12);
}

/* ---------- CLI ---------- */
function main() {
  const target = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_ICO;

  if (!fs.existsSync(target)) {
    console.error('FAIL 找不到 ' + target);
    process.exit(2);
  }

  const buf = fs.readFileSync(target);
  const r = checkIco(buf);

  console.log('文件: ' + target);
  console.log('大小: ' + buf.length + ' 字节，' + buf.readUInt16LE(4) + ' 张');
  r.entries.forEach(function (e) {
    console.log('  ' + String(e.declared).padStart(3) + 'px  字段=' + String(e.whField).padStart(3) +
      '  bpp=' + e.bpp + '  len=' + String(e.len).padStart(6) +
      '  off=' + String(e.offset).padStart(6) +
      '  内嵌PNG=' + (e.isPng ? (e.innerW + '×' + e.innerH) : '不是PNG'));
  });

  if (!r.ok) {
    console.log('');
    r.errors.forEach(function (m) { console.log('  ✗ ' + m); });
    console.log('FAIL 图标包不合法');
    process.exit(1);
  }

  console.log('');
  console.log('正向：结构 / 尺寸 / 内嵌 PNG 全部一致 ✓');

  const st = selfTest(buf);
  let stOk = true;
  console.log('反向：');
  st.forEach(function (c) {
    if (!c.rejected) stOk = false;
    console.log('  ' + (c.rejected ? '✓ 已拒绝' : '✗ 漏放行') + '  ' + c.name +
      (c.errors.length ? '   (' + c.errors[0] + ')' : ''));
  });

  if (!stOk) {
    console.log('FAIL 反向用例未被拒 → 校验器无效');
    process.exit(1);
  }

  console.log('');
  console.log('PASS  icon.ico 可用（' + r.entries.length + ' 个尺寸：' +
    r.entries.map(function (e) { return e.declared; }).join('/') + '）');
}

if (require.main === module) main();

module.exports = { checkIco, selfTest };
