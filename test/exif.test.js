/* ============================================================
   Atrium · Exif 拍摄时间解析与批量采集单元测试（纯 Node）
   ------------------------------------------------------------
   覆盖要点：
     1. tsFromExif 解析标准 EXIF 日期串及异常输入容错
     2. Exif.parse 同时支持浏览器 File（file.slice）与 Electron 原生条目（file: null + path）
     3. Exif.harvestTimes 传入条目对象（m）而非仅 m.file，确保 Electron 目录排序生效
     4. 写回 shotTs 后触发 State.touch()；失败/无 EXIF 条目跳过且不误触 State.touch()

   运行： node test/exif.test.js
   ============================================================ */
'use strict';

const H = require('./_harness.js');
const A = H.makeAsserts();

const le16 = (n) => [n & 255, (n >>> 8) & 255];
const le32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const be16 = (n) => [(n >>> 8) & 255, n & 255];

/** 构造带 APP1 Exif（DateTimeOriginal = 19 ASCII + \0）的最小 JPEG 字节头 */
function makeJpegWithExif(dateStr) {
  const txt = dateStr + '\0';
  const ascii = Array.from(txt, (c) => c.charCodeAt(0));
  const tiff = [
    // TIFF LE header: "II", 42, IFD0 offset = 8
    0x49, 0x49, ...le16(42), ...le32(8),
    // IFD0: 1 entry (0x8769 ExifIFDPtr -> offset 26)
    ...le16(1),
    ...le16(0x8769), ...le16(4), ...le32(1), ...le32(26),
    ...le32(0),
    // ExifIFD @ 26: 1 entry (0x9003 DateTimeOriginal -> offset 44)
    ...le16(1),
    ...le16(0x9003), ...le16(2), ...le32(ascii.length), ...le32(44),
    ...le32(0),
    // ASCII value @ 44
    ...ascii,
  ];
  const segLen = 2 + 6 + tiff.length;
  return Uint8Array.from([
    0xFF, 0xD8,
    0xFF, 0xE1, ...be16(segLen),
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    ...tiff,
    0xFF, 0xD9,
  ]);
}

function makeFakeFile(bytes, name) {
  return {
    name: name || 'browser.jpg',
    size: bytes.length,
    slice(start, end) {
      const sub = bytes.slice(start, end);
      return {
        async arrayBuffer() {
          return sub.buffer.slice(sub.byteOffset, sub.byteOffset + sub.byteLength);
        },
      };
    },
  };
}

async function run() {
  let touched = 0;
  let readHeadCalls = 0;

  H.useGlobalAsWindow();
  globalThis.State = { touch() { touched++; } };
  globalThis.Native = {
    async readHead(p, limit) {
      readHeadCalls++;
      if (p === 'C:\\photos\\shot.jpg' && limit >= 64) {
        const u8 = makeJpegWithExif('2024:05:12 18:30:45');
        return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      }
      if (p === 'C:\\photos\\plain.jpg') {
        const u8 = Uint8Array.from([0xFF, 0xD8, 0xFF, 0xD9]);
        return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      }
      return null;
    },
  };

  H.loadScript('js/exif.js');
  const Exif = globalThis.Exif;
  const expectedTs = new Date(2024, 4, 12, 18, 30, 45).getTime();

  /* 1. tsFromExif 基础解析 */
  A.eq('tsFromExif 解析标准 EXIF 日期串', Exif.tsFromExif('2024:05:12 18:30:45'), expectedTs);
  A.eq('tsFromExif 非法日期返回 0', Exif.tsFromExif('not-a-date'), 0);
  A.eq('tsFromExif 空输入返回 0', Exif.tsFromExif(''), 0);

  /* 2. parse 同时支持浏览器 File 与原生条目对象 */
  const browserMeta = {
    name: 'browser.jpg',
    file: makeFakeFile(makeJpegWithExif('2023:11:03 09:15:20')),
  };
  const rBrowser = await Exif.parse(browserMeta);
  A.ok('parse 识别浏览器 File 条目', rBrowser && rBrowser.ok && rBrowser.ts === new Date(2023, 10, 3, 9, 15, 20).getTime());

  const nativeMeta = {
    name: 'shot.jpg',
    path: 'C:\\photos\\shot.jpg',
    file: null,
    bad: false,
  };
  const rNative = await Exif.parse(nativeMeta);
  A.ok('parse 识别 Electron 原生条目（file 为 null，走 path）', rNative && rNative.ok && rNative.ts === expectedTs);

  const nonExifExt = {
    name: 'clip.png',
    path: 'C:\\photos\\clip.png',
    file: null,
    bad: false,
  };
  const rPng = await Exif.parse(nonExifExt);
  A.ok('parse 跳过非 JPEG/TIFF 扩展名', rPng && rPng.ok === false);

  /* 3. harvestTimes：核心回归 —— 必须传 m 而不是 m.file，否则 nativeMeta.shotTs 永远写不上 */
  touched = 0;
  readHeadCalls = 0;
  const recorded = [];
  globalThis.Loader = { recordExif(m, r) { recorded.push({ id: m.id, ok: !!(r && r.ok), ts: (r && r.ts) || 0 }); } };
  const hNative = { id: 'n1', name: 'shot.jpg', path: 'C:\\photos\\shot.jpg', file: null, bad: false };
  const hBrowser = { id: 'b1', name: 'b.jpg', file: makeFakeFile(makeJpegWithExif('2022:01:02 03:04:05')), bad: false };
  const hNoExif = { id: 'n2', name: 'plain.jpg', path: 'C:\\photos\\plain.jpg', file: null, bad: false };
  const hBad = { id: 'bad1', name: 'bad.jpg', path: 'C:\\photos\\shot.jpg', file: null, bad: true };

  const count = await Exif.harvestTimes([hNative, hBrowser, hNoExif, hBad]);
  A.eq('harvestTimes 返回处理列表长度', count, 4);
  A.eq('harvestTimes 为 Electron 原生条目写入 shotTs', hNative.shotTs, expectedTs);
  A.eq('harvestTimes 为浏览器 File 条目写入 shotTs', hBrowser.shotTs, new Date(2022, 0, 2, 3, 4, 5).getTime());
  A.eq('harvestTimes 不写入无 EXIF 条目的 shotTs', hNoExif.shotTs, undefined);
  A.eq('harvestTimes 跳过 bad 条目', hBad.shotTs, undefined);
  A.eq('harvestTimes 写入 shotTs 后调用一次 State.touch()', touched, 1);
  A.ok('harvestTimes 对原生条目确实调用了 Native.readHead', readHeadCalls >= 2);
  A.eq('harvestTimes 将命中与未命中均写入 Loader.recordExif', recorded.length, 3);
  A.ok('harvestTimes 向 recordExif 传回原生 shotTs', recorded.some((x) => x.id === 'n1' && x.ts === expectedTs));

  /* 4. 全无 EXIF 时不应触发 State.touch() */
  touched = 0;
  await Exif.harvestTimes([{ name: 'plain.jpg', path: 'C:\\photos\\plain.jpg', file: null, bad: false }]);
  A.eq('harvestTimes 无任何写入时不调用 State.touch()', touched, 0);

  const ok = A.finish('Exif 单元测试');
  process.exit(ok ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
