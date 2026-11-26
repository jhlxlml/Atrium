'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./_harness.js');
const A = H.makeAsserts();
const rawlib = require('../deploy/electron/rawlib.js');

function buildFakeJpeg(len) {
  const b = Buffer.alloc(len, 0xaa);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0;
  b[len - 2] = 0xff; b[len - 1] = 0xd9;
  return b;
}

function buildTiffRaw({ le = true, magic = 42, previewOffset = 256, previewBytes }) {
  const total = Math.max(previewOffset + previewBytes.length, 512);
  const buf = Buffer.alloc(total, 0);
  buf[0] = le ? 0x49 : 0x4d;
  buf[1] = le ? 0x49 : 0x4d;
  if (le) {
    buf.writeUInt16LE(magic, 2);
    buf.writeUInt32LE(8, 4);
    buf.writeUInt16LE(2, 8); // 2 entries
    // Entry 0: 0x0201 JPEGInterchangeFormat (LONG=4, count=1)
    buf.writeUInt16LE(0x0201, 10);
    buf.writeUInt16LE(4, 12);
    buf.writeUInt32LE(1, 14);
    buf.writeUInt32LE(previewOffset, 18);
    // Entry 1: 0x0202 JPEGInterchangeFormatLength
    buf.writeUInt16LE(0x0202, 22);
    buf.writeUInt16LE(4, 24);
    buf.writeUInt32LE(1, 26);
    buf.writeUInt32LE(previewBytes.length, 30);
    buf.writeUInt32LE(0, 34);
  } else {
    buf.writeUInt16BE(magic, 2);
    buf.writeUInt32BE(8, 4);
    buf.writeUInt16BE(2, 8);
    buf.writeUInt16BE(0x0201, 10);
    buf.writeUInt16BE(4, 12);
    buf.writeUInt32BE(1, 14);
    buf.writeUInt32BE(previewOffset, 18);
    buf.writeUInt16BE(0x0202, 22);
    buf.writeUInt16BE(4, 24);
    buf.writeUInt32BE(1, 26);
    buf.writeUInt32BE(previewBytes.length, 30);
    buf.writeUInt32BE(0, 34);
  }
  previewBytes.copy(buf, previewOffset);
  return buf;
}

function buildRafRaw(previewBytes) {
  const off = 128;
  const buf = Buffer.alloc(off + previewBytes.length, 0);
  buf.write('FUJIFILMCCD-RAW ', 0, 'ascii');
  buf.writeUInt32BE(off, 0x54);
  buf.writeUInt32BE(previewBytes.length, 0x58);
  previewBytes.copy(buf, off);
  return buf;
}

async function run() {
  A.ok('RAW 扩展名识别 dng/cr2/nef/raf',
    rawlib.isRawExt('DNG') && rawlib.isRawExt('.cr2') && rawlib.isRawExt('nef') && rawlib.isRawExt('raf'));
  A.ok('普通 jpg 不误判为 RAW', !rawlib.isRawExt('jpg'));

  const jpg = buildFakeJpeg(2048);
  const leBuf = buildTiffRaw({ le: true, previewBytes: jpg });
  const leCands = rawlib.findPreviewCandidates(leBuf, leBuf.length);
  A.eq('TIFF-LE 识别出 1 个候选预览', leCands.length, 1);
  A.ok('TIFF-LE 偏移与长度准确', leCands[0] && leCands[0].offset === 256 && leCands[0].length === 2048);

  const beBuf = buildTiffRaw({ le: false, previewBytes: jpg });
  const beCands = rawlib.findPreviewCandidates(beBuf, beBuf.length);
  A.eq('TIFF-BE 识别出 1 个候选预览', beCands.length, 1);
  A.ok('TIFF-BE 偏移与长度准确', beCands[0] && beCands[0].offset === 256 && beCands[0].length === 2048);

  const rafBuf = buildRafRaw(jpg);
  const rafCands = rawlib.findPreviewCandidates(rafBuf, rafBuf.length);
  A.eq('Fujifilm RAF 识别出 1 个候选预览', rafCands.length, 1);
  A.ok('Fujifilm RAF 偏移与长度准确', rafCands[0] && rafCands[0].offset === 128 && rafCands[0].length === 2048);

  // 真实文件读取测试（含跨越 256KB 偏移的大预览场景）
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atrium-raw-'));
  try {
    const bigJpg = buildFakeJpeg(4096);
    const farOff = 300 * 1024;
    const farBuf = buildTiffRaw({ le: true, previewOffset: farOff, previewBytes: bigJpg });
    const dngPath = path.join(tmpDir, 'sample.dng');
    fs.writeFileSync(dngPath, farBuf);
    const extracted = await rawlib.extractFilePreview(dngPath);
    A.ok('跨越 256KB 偏移的 DNG 预览成功提取', Buffer.isBuffer(extracted) && extracted.equals(bigJpg));

    const badPath = path.join(tmpDir, 'broken.cr2');
    fs.writeFileSync(badPath, Buffer.from('not a raw file'));
    const miss = await rawlib.extractFilePreview(badPath);
    A.eq('损坏 RAW 文件安全返回 null', miss, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  process.exit(A.finish('RAW 预览提取') ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
