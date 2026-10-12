/* ============================================================
   Atrium · exif.js
   零依赖 JPEG/TIFF EXIF 解析（纯逻辑，可在 Node 下独立测试）
   - 只读取文件头（默认 ≤256KB），解析 APP1-Exif 里的
     拍摄时间 / 相机 / 镜头 / 曝光参数 / 尺寸 / GPS 文本坐标
   - 导出:
     Exif.parse(file)      -> Promise<{ok,...}>
     Exif.harvestTimes(list, onDone) -> Promise<number> 并发限量采集拍摄时间
   ============================================================ */
(function (global) {
  'use strict';

  const HEAD_LIMIT = 256 * 1024; // JPEG EXIF 绝大多数位于前 256KB

  const EXT_OK = /^(jpe?g|tiff?)$/;

  function readHead(src) {
    // 兼容两种输入：File 本体 或 {file?/path?/name/size} 的条目 meta
    const file = (src && typeof src.slice === 'function') ? src : (src && src.file) || null;
    if (file && typeof file.slice === 'function' && file.size != null) {
      const end = Math.min(file.size, HEAD_LIMIT);
      return file.slice(0, end).arrayBuffer();
    }
    const path = (src && src.path) || null;
    if (path && global.Native && global.Native.readHead) return global.Native.readHead(path, HEAD_LIMIT);
    return Promise.resolve(null);
  }

  /* 在 JPEG 段里找 APP1 "Exif\0\0" 之后的 TIFF 载荷；找不到返回 null */
  function findExifTiff(buf) {
    const u8 = new Uint8Array(buf);
    let i = 2; // 跳过 SOI
    const n = u8.length;
    while (i + 4 <= n) {
      if (u8[i] !== 0xff) { i++; continue; }
      const m = u8[i + 1];
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
      if (m === 0xd9) break;
      if (i + 4 > n) break;
      const len = (u8[i + 2] << 8) | u8[i + 3];
      if (len < 2) break;
      if (m === 0xe1) {
        const p = i + 4;
        if (p + 6 <= n &&
            u8[p] === 0x45 && u8[p + 1] === 0x78 && u8[p + 2] === 0x69 &&
            u8[p + 3] === 0x66 && u8[p + 4] === 0 && u8[p + 5] === 0) {
          return buf.slice(p + 6, Math.min(n, i + 2 + len));
        }
      }
      i += 2 + len;
    }
    return null;
  }

  function ascii(dv, off, len, end) {
    const max = Math.min(end, off + len);
    const a = [];
    for (let i = off; i < max; i++) {
      const c = dv.getUint8(i);
      if (c === 0) break;
      a.push(String.fromCharCode(c));
    }
    return a.join('').trim();
  }

  function parseTiff(buf) {
    const dv = new DataView(buf);
    const end = buf.byteLength;
    const isLE = dv.getUint16(0, false) === 0x4949;
    const gU16 = (o) => dv.getUint16(o, isLE);
    const gU32 = (o) => dv.getUint32(o, isLE);
    const gVal = (type, o) => {
      if (type === 1) return dv.getUint8(o);
      if (type === 3) return gU16(o);
      return gU32(o);
    };
    const gRat = (o) => {
      const d = gU32(o + 4);
      return d ? gU32(o) / d : 0;
    };
    if (gU16(2) !== 42 || end < 10) return null;
    const ifd0 = gU32(4);
    if (ifd0 + 2 > end) return null;

    const out = {};
    const readIFD = (off, fn) => {
      if (off + 2 > end) return;
      const cnt = gU16(off);
      let p = off + 2;
      for (let k = 0; k < cnt && p + 12 <= end; k++, p += 12) {
        const tag = gU16(p);
        const type = gU16(p + 2);
        const cnt2 = gU32(p + 4);
        const size = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8][type] || 0;
        const bytes = size * cnt2;
        let vo = p + 8;
        if (bytes > 4) {
          vo = gU32(p + 8);
          if (vo + bytes > end) continue;
        }
        try { fn(tag, type, cnt2, vo); } catch (e) { /* 单个字段失败忽略 */ }
      }
    };

    readIFD(ifd0, (tag, type, cnt, vo) => {
      switch (tag) {
        case 0x010f: out.make = ascii(dv, vo, cnt, end); break;
        case 0x0110: out.model = ascii(dv, vo, cnt, end); break;
        case 0x0132: out.datetime = ascii(dv, vo, cnt, end); break;
        case 0x0112: out.orientation = gVal(type, vo); break;
        case 0x8769: out.exifOff = type === 4 ? gU32(vo) : 0; break;
        case 0x8825: out.gpsOff = type === 4 ? gU32(vo) : 0; break;
        case 0xa002: out.pxW = gVal(type, vo); break;
        case 0xa003: out.pxH = gVal(type, vo); break;
      }
    });

    if (out.exifOff) {
      readIFD(out.exifOff, (tag, type, cnt, vo) => {
        switch (tag) {
          case 0x9003: out.shot = ascii(dv, vo, cnt, end); break;
          case 0x829d: out.fnum = gRat(vo); break;
          case 0x829a: out.exposure = gRat(vo); break;
          case 0x8827: out.iso = gVal(type, vo); break;
          case 0x920a: out.focal = gRat(vo); break;
          case 0xa434: out.lens = ascii(dv, vo, cnt, end); break;
        }
      });
    }

    if (out.gpsOff) {
      readIFD(out.gpsOff, (tag, type, cnt, vo) => {
        if (tag === 0x0001 && type === 2) out.latRef = ascii(dv, vo, cnt, end);
        else if (tag === 0x0004 && type === 2) out.lonRef = ascii(dv, vo, cnt, end);
        else if (tag === 0x0002 && type === 5) out.lat = [gRat(vo), gRat(vo + 8), gRat(vo + 16)];
        else if (tag === 0x0005 && type === 5) out.lon = [gRat(vo), gRat(vo + 8), gRat(vo + 16)];
      });
      if (out.lat && out.lon) {
        const dm = (r, ref) => {
          const v = r[0] + r[1] / 60 + r[2] / 3600;
          return (ref === 'S' || ref === 'W') ? -v : v;
        };
        out.gps = { lat: dm(out.lat, out.latRef), lon: dm(out.lon, out.lonRef) };
      }
    }
    return out;
  }

  /* "2024:05:06 07:08:09" -> ms；解析失败返回 0 */
  function tsFromExif(s) {
    if (!s) return 0;
    const m = /^(\d{4})[:\-/](\d{1,2})[:\-/](\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/.exec(s.trim());
    if (!m) return 0;
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), 0);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }

  function isJpeg(u8) { return u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xd8; }
  function isTiff(u8) {
    return u8.length >= 4 && ((u8[0] === 0x49 && u8[1] === 0x49) || (u8[0] === 0x4d && u8[1] === 0x4d));
  }

  async function parse(src) {
    try {
      const file = (src && typeof src.slice === 'function') ? src : (src && src.file) || null;
      const path = (src && src.path) || null;
      if ((!file || !file.slice) && !path) return { ok: false };
      const name = file ? (file.name || '') : (src && src.name) || '';
      const ext = (name.lastIndexOf('.') > 0 ? name.slice(name.lastIndexOf('.') + 1) : '').toLowerCase();
      if (!EXT_OK.test(ext)) return { ok: false };
      const buf = await readHead(src);
      if (!buf || buf.byteLength < 8) return { ok: false };
      const u8 = new Uint8Array(buf);
      let tiff = null;
      if (isJpeg(u8)) tiff = findExifTiff(buf);
      else if (isTiff(u8)) tiff = buf;
      if (!tiff || tiff.byteLength < 8) return { ok: false };
      const t = parseTiff(tiff);
      if (!t) return { ok: false };
      const shotTs = tsFromExif(t.shot) || tsFromExif(t.datetime);
      return {
        ok: true,
        make: t.make, model: t.model, lens: t.lens,
        fnum: t.fnum, exposure: t.exposure, iso: t.iso, focal: t.focal,
        orientation: t.orientation, pxW: t.pxW, pxH: t.pxH,
        shot: t.shot || t.datetime || '',
        ts: shotTs || 0,
        gps: t.gps || null,
      };
    } catch (e) {
      return { ok: false };
    }
  }

  /* ---------- 批量采集拍摄时间（排序用；并发限量，避免读取风暴） ---------- */
  const GATE = 4;
  async function harvestTimes(list) {
    let i = 0;
    let changed = 0; // 实际写入过 shotTs 的数量；>0 才需让排序缓存失效
    async function worker() {
      while (i < list.length) {
        const k = i++;
        const m = list[k];
        if (!m || m.bad) continue;
        try {
          const r = await parse(m.file);
          if (r && r.ok && r.ts) { m.shotTs = r.ts; changed++; }
        } catch (e) { /* 单文件失败忽略 */ }
      }
    }
    await Promise.all(Array.from({ length: GATE }, worker));
    // shotTs 属于「影响排序的字段」，原地写入不会自增 State 的 rev；
    // 批量结束后统一 touch() 一次，令 viewList 缓存按「拍摄时间」排序时能刷新。
    if (changed) {
      try {
        const S = global.State;
        if (S && typeof S.touch === 'function') S.touch();
      } catch (e) { /* 环境未加载 State 时忽略 */ }
    }
    return list.length;
  }

  global.Exif = {
    parse,
    harvestTimes,
    tsFromExif,
    findExifTiff, // 暴露纯逻辑供 Node 单测
    parseTiff,
    _readHead: readHead,
    HEAD_LIMIT,
  };
})(typeof window !== 'undefined' ? window : globalThis);
