/* ============================================================
   取景 Viewfinder · Util.sizeFromHeader 单元测试（纯 Node）
   ------------------------------------------------------------
   为什么值得单测：这个方法的结果直接喂给网格布局的宽高比和尺寸库。
   判错一个字节偏移，整屏瓦片就会按错误的形状排布，而且很难肉眼发现
   （只是"看起来有点歪"）。这里用真实字节头做输入，逐格式钉死偏移量。

   util.js 是挂在 window 上的 IIFE，且顶层读了一个裸全局 CSS，
   所以在 vm 沙箱里给它一个最小全局环境来加载。

   运行： node test/imageheader.test.js
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
function eqSize(name, got, w, h) {
  const good = got && got.w === w && got.h === h;
  ok(name, good, got ? `实测 ${got.w}×${got.h}，期望 ${w}×${h}` : '实测 null');
}
function isNull(name, got, note) {
  ok(name, got === null, got ? `实测 ${JSON.stringify(got)}，期望 null` : (note || ''));
}

/* ---------- 在沙箱里加载 util.js ---------- */
function loadUtil() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'util.js'), 'utf8');
  const sandbox = { CSS: { supports: () => false }, Intl, Date, Math, JSON, console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'util.js' });
  if (!sandbox.Util || typeof sandbox.Util.sizeFromHeader !== 'function') {
    throw new Error('util.js 里没有导出 Util.sizeFromHeader');
  }
  return sandbox.Util;
}

const U = loadUtil();
const size = U.sizeFromHeader;

/* ---------- 构造真实字节头 ---------- */
const u8 = (...bytes) => Uint8Array.from(bytes);
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n) => [(n >>> 8) & 255, n & 255];
const le16 = (n) => [n & 255, (n >>> 8) & 255];
const le32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const cat = (arrs) => Uint8Array.from([].concat(...arrs.map((a) => Array.from(a))));

/* PNG：魔数 + 长度 + "IHDR" + 宽 4B + 高 4B */
function png(w, h) {
  return cat([
    [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
    be32(13), [0x49, 0x48, 0x44, 0x52],
    be32(w), be32(h),
    [8, 6, 0, 0, 0],
  ]);
}

/* GIF：GIF89a + 逻辑屏幕宽高（小端）+ 标志/背景/比例 + 填充 */
function gif(w, h) {
  return cat([
    [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
    le16(w), le16(h),
    [0xF7, 0x00, 0x00],
  ]);
}

/* BMP：BM + 文件大小 + 保留 + 数据偏移 + DIB 头大小 40 + 宽/高（有符号小端） */
function bmp(w, h, dib) {
  return cat([
    [0x42, 0x4D],
    le32(54), le16(0), le16(0), le32(54),
    le32(dib || 40),
    le32(w), le32(h),
    le16(1), le16(24),
  ]);
}

/* WebP：RIFF....WEBP + 子块 */
function webpVP8X(w, h) {
  const v = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
  return cat([
    [0x52, 0x49, 0x46, 0x46], le32(30), [0x57, 0x45, 0x42, 0x50],
    [0x56, 0x50, 0x38, 0x58], le32(10),
    [0x00, 0x00, 0x00, 0x00],
    v(w - 1), v(h - 1),
  ]);
}
function webpVP8(w, h) {
  return cat([
    [0x52, 0x49, 0x46, 0x46], le32(30), [0x57, 0x45, 0x42, 0x50],
    [0x56, 0x50, 0x38, 0x20], le32(14),
    [0x00, 0x00, 0x00],                 // 帧标签 3 字节
    [0x9D, 0x01, 0x2A],                 // 关键帧起始码
    le16(w), le16(h),
  ]);
}
function webpVP8L(w, h) {
  const bits = ((w - 1) & 0x3FFF) | (((h - 1) & 0x3FFF) << 14);
  return cat([
    [0x52, 0x49, 0x46, 0x46], le32(30), [0x57, 0x45, 0x42, 0x50],
    [0x56, 0x50, 0x38, 0x4C], le32(10),
    [0x2F], le32(bits),
  ]);
}
/* JPEG：SOI + 若干段（含可选前置段/填充） + SOF0 + SOS */
function jpeg(w, h, opts) {
  const o = opts || {};
  const parts = [[0xFF, 0xD8]];
  if (o.jfif !== false) {
    parts.push([0xFF, 0xE0], be16(16), [0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00], le16(72), le16(72), [0x00, 0x00]);
  }
  if (o.exif) {
    // 一个体量很大的 APP1：模拟手机原图，把 SOF0 顶到几百字节之后
    const payload = new Array(o.exif).fill(0x20);
    parts.push([0xFF, 0xE1], be16(o.exif + 2), payload);
  }
  const sofMark = o.sof || 0xC0;
  if (o.fill) parts.push([0xFF, 0xFF]);            // 段间填充 FF
  parts.push([0xFF, sofMark], be16(17), [0x08], be16(h), be16(w), [0x03], [0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  parts.push([0xFF, 0xDA], be16(12), [0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3F, 0x00]);
  return cat(parts);
}

/* ============================================================
   1. PNG / GIF / BMP
   ============================================================ */
eqSize('PNG 4096×2160', size(png(4096, 2160)), 4096, 2160);
eqSize('PNG 1×1（边界）', size(png(1, 1)), 1, 1);
eqSize('GIF 宽高来自逻辑屏幕（小端）', size(gif(320, 240)), 320, 240);
eqSize('BMP DIB40 宽高', size(bmp(1920, 1080)), 1920, 1080);
// BMP 高度可以是负数（自上而下），取绝对值
eqSize('BMP 负高度取绝对值', size(bmp(800, -600)), 800, 600);

/* ============================================================
   2. WebP 三种子格式
   ============================================================ */
eqSize('WebP VP8X（有损/无损容器）', size(webpVP8X(3000, 2000)), 3000, 2000);
eqSize('WebP VP8（有损）', size(webpVP8(1280, 720)), 1280, 720);
eqSize('WebP VP8L（无损）', size(webpVP8L(640, 480)), 640, 480);

/* ============================================================
   3. JPEG —— 最需要钉死偏移量的一支
   ============================================================ */
eqSize('JPEG 基础 SOF0', size(jpeg(4000, 3000)), 4000, 3000);
eqSize('JPEG 竖图（宽高不能反）', size(jpeg(1080, 1920)), 1080, 1920);
eqSize('JPEG 跳过 APP1(EXIF) 后才取到尺寸', size(jpeg(5000, 4000, { exif: 2000 })), 5000, 4000);
eqSize('JPEG SOF2（渐进式）同样识别', size(jpeg(500, 400, { sof: 0xC2 })), 500, 400);
eqSize('JPEG 段间填充 FF 不误判', size(jpeg(700, 900, { fill: true })), 700, 900);
eqSize('JPEG 无 JFIF 段也能取到', size(jpeg(2222, 1111, { jfif: false })), 2222, 1111);
// 只截到 SOF 之前 → 应当老实返回 null，而不是猜一个尺寸
isNull('JPEG 截断在尺寸段之前 → null', size(jpeg(4000, 3000).slice(0, 12)));
// DHT(C4) 没有尺寸字段，不能当成 SOF；其后跟真的 SOF0
{
  const dht = cat([[0xFF, 0xD8], [0xFF, 0xC4], be16(6), [0x00, 0x01, 0x02, 0x03]]);
  const sof = cat([[0xFF, 0xC0], be16(17), [0x08], be16(1234), be16(2345), [0x03], [0, 0, 0, 0, 0, 0, 0, 0, 0]]);
  eqSize('JPEG 跳过 DHT(C4) 不误取', size(cat([dht, sof])), 2345, 1234);
}

/* ============================================================
   4. 认不出的输入一律 null（宁可回退，也不要瞎猜）
   ============================================================ */
isNull('空输入 → null', size(null));
isNull('认不出的魔数 → null', size(u8(0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09)));
isNull('HEIC/HEIF（ftyp）→ null（本机另有能力探测）', size(cat([
  [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70],
  [0x68, 0x65, 0x69, 0x63], [0x00, 0x00, 0x00, 0x00], [0x68, 0x65, 0x69, 0x63],
])));
isNull('PNG 魔数但长度不足 → null', size(u8(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)));
isNull('PNG 尺寸为 0 → null（不产生无意义的 0×0）', size(png(0, 0)));
isNull('尺寸溢出上限 → null（明显是坏头）', size(png(9999999, 10)));

/* ---------- 输入类型兼容：ArrayBuffer / Uint8Array / Node Buffer ---------- */
{
  const ab = png(1234, 5678);
  eqSize('接受 ArrayBuffer', size(ab), 1234, 5678);
  eqSize('接受 Uint8Array', size(new Uint8Array(ab)), 1234, 5678);
  const buf = Buffer.from(new Uint8Array(ab));
  eqSize('接受 Node Buffer', size(buf), 1234, 5678);
  // 带偏移的视图（模拟 Buffer 切片），不能读错位置
  const padded = Buffer.concat([Buffer.alloc(7), buf]);
  eqSize('接受带 byteOffset 的视图', size(padded.subarray(7)), 1234, 5678);
}

/* ============================================================
   汇总
   ============================================================ */
console.log('\n' + '='.repeat(64));
if (fail) {
  console.log('失败项：');
  failures.forEach((f) => console.log('  ✗ ' + f));
}
console.log(`imageheader 单元测试：通过 ${pass} / ${pass + fail}`);
console.log('='.repeat(64));
process.exit(fail ? 1 : 0);
