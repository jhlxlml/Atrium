/* ============================================================
   Atrium · pack.js （版本化 ZIP 打包）
   ------------------------------------------------------------
   用法：node deploy/pack.js            打包 Electron 便携版（版本取自 package.json）
        node deploy/pack.js --electron 同义（保留参数以兼容既有脚本）

   ★ 离线单文件版已停更：自本项目只交付 Electron 版起，build_offline.js 与
     「离线版 ZIP」一并退役，这里不再产出 Atrium_离线版_vX.Y.Z.zip。

   为什么不用外部 zip：本机没有 zip.exe，Compress-Archive 又要走 PowerShell；
   这里用 Node 内置 zlib 直接写 ZIP（deflate + CRC32 + 中央目录），零依赖、
   跨平台、可进构建链。产出的 ZIP 在 Windows 资源管理器 / 7-Zip / Python
   zipfile 里都能解。

   ★ 交付纪律（v1.5.1 补上，此前缺失导致 v1.5.0 的包 7-Zip 逐条报 CRC Failed）：
     - CRC32 必须算在「压缩前」的原始内容上，绝不能算在压缩后的字节流上；
       method=8 的条目算错后，7-Zip 会 100% 报 CRC Failed，而"解压后字节数一致"
       这种弱校验完全拦不住。
     - 产物先写 *.tmp，交给 verify_zip.js（用 Node 原生 zlib.crc32 作参照，
       与被测写入器非同源）逐条校验 CRC + 结构 + 源字节一致，全部通过才改名上线；
       任何一条失败即删除临时文件并以非零码退出，坏包不会落盘。
   ============================================================ */
'use strict';

const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const { verifyZip, summarize, crcSelfTest } = require('./verify_zip.js');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VER = pkg.version;

/* 只交付 Electron 便携版。命令行参数（--offline / --electron）不再有意义：
   --offline 已退役，--electron 就是默认行为，传与不传都一样。 */
const doElectron = true;

/* 打包前先自检校验器：参照物本身要是错的，后面全白搭 */
(function guardCrc() {
  const st = crcSelfTest();
  if (!st.ok) {
    console.error('× CRC 实现自检未通过，拒绝打包：\n  ' + st.fails.join('\n  '));
    process.exit(1);
  }
})();

/* ---------- CRC32 ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ---------- DOS 时间 ---------- */
function dosTime(d) {
  const t = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const dt = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  return { time: t, date: dt };
}

const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;

/**
 * 收集要打包的文件：[{ name（zip 内相对路径，/ 分隔）, abs, dir? }]
 */
function walk(absDir, base, out) {
  for (const f of fs.readdirSync(absDir)) {
    const abs = path.join(absDir, f);
    const rel = base ? base + '/' + f : f;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      out.push({ name: rel + '/', dir: true });
      walk(abs, rel, out);
    } else {
      out.push({ name: rel, abs: abs, dir: false, mtime: st.mtime });
    }
  }
  return out;
}

/**
 * 写一个 ZIP（写完后立即强校验）。entries = [{ name, abs?, dir, mtime? }]
 * @returns {{ ok:boolean, size:number, report:object }}
 */
function writeZip(zipPath, entries) {
  if (entries.length > U16_MAX) throw new Error('条目数 ' + entries.length + ' 超过 65535，需要 ZIP64，本写入器不支持');
  if (entries.length === 0) throw new Error('没有可打包的条目');

  const chunks = [];
  const central = [];
  let offset = 0;
  const now = new Date();

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    if (nameBuf.length > U16_MAX) throw new Error('条目名过长：' + e.name);
    const { time, date } = dosTime(e.mtime || now);

    // ★ raw 是「压缩前」的原始内容，也是 CRC 与 usize 的唯一依据
    const raw = e.dir ? Buffer.alloc(0) : fs.readFileSync(e.abs);
    const usize = raw.length;

    let data = raw;
    let method = 0;
    if (!e.dir) {
      const def = zlib.deflateRawSync(raw, { level: 6 });
      // 压不动（已压缩格式）就原样存，避免体积反而变大
      if (def.length < raw.length) { data = def; method = 8; }
    }
    const csize = data.length;
    // ★★ CRC32 必须基于原始内容（raw），不是压缩后的 data。
    //    这里曾写作 crc32(data) → 所有 method=8 条目在 7-Zip 下报 CRC Failed。
    const crc = crc32(raw);

    if (csize > U32_MAX || usize > U32_MAX || offset > U32_MAX) {
      throw new Error('条目 ' + e.name + ' 触发 4GB/ZIP64 边界，需要 ZIP64，本写入器不支持');
    }

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);            // version needed
    lh.writeUInt16LE(0x0800, 6);        // flag: UTF-8 文件名
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);          // ← 基于 raw
    lh.writeUInt32LE(csize, 18);
    lh.writeUInt32LE(usize, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    chunks.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);            // version made by
    ch.writeUInt16LE(20, 6);            // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);          // ← 基于 raw，与本地头一致
    ch.writeUInt32LE(csize, 20);
    ch.writeUInt32LE(usize, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);            // extra
    ch.writeUInt16LE(0, 32);            // comment
    ch.writeUInt16LE(0, 34);            // disk
    ch.writeUInt16LE(0, 36);            // internal attrs
    ch.writeUInt32LE(e.dir ? 0x10 : 0x20, 38);   // external attrs（目录位）
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + data.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  // ★ 先落临时文件 → 独立校验 → 通过才改名。坏包不过夜。
  const tmp = zipPath + '.tmp';
  fs.writeFileSync(tmp, Buffer.concat([Buffer.concat(chunks), cdBuf, eocd]));

  const report = verifyZip(tmp, { entries: entries });
  report.zip = path.basename(zipPath);
  if (!report.ok) {
    try { fs.unlinkSync(tmp); } catch (err) { /* 尽力而为 */ }
    return { ok: false, size: 0, report: report };
  }
  // rename 在 Windows 上是带替换语义的原子操作，直接改名即可覆盖旧包；
  // 不用「先 unlink 再 rename」——中间失败会把上一版可用产物也弄丢。
  fs.renameSync(tmp, zipPath);
  return { ok: true, size: fs.statSync(zipPath).size, report: report };
}

function mb(n) { return (n / 1024 / 1024).toFixed(1) + ' MB'; }

function reportFailure(name, r) {
  console.error('× ' + name + ' 打包后校验未通过，已丢弃临时文件（未覆盖旧包）：');
  for (const s of r.report.struct) console.error('   · 结构: ' + s);
  for (const d of r.report.details.slice(0, 8)) console.error('   · ' + d.name + ': ' + d.why.join('；'));
  if (r.report.details.length > 8) console.error('   · …另有 ' + (r.report.details.length - 8) + ' 条');
}

let failed = 0;

/* ---------- Electron 便携版 ---------- */
if (doElectron) {
  const appDir = path.join(ROOT, 'deploy', 'dist-electron', 'Atrium_Electron版');
  if (!fs.existsSync(appDir)) {
    console.error('× 找不到 Electron 产物，请先跑 node deploy/electron/assemble.js');
    process.exit(1);
  }
  const entries = walk(appDir, '', []);
  const zip = path.join(ROOT, 'Atrium_Electron版_v' + VER + '.zip');
  const r = writeZip(zip, entries);
  if (!r.ok) { reportFailure('便携版', r); failed++; }
  else {
    console.log('OK 便携版  → ' + path.basename(zip) + '  (' + mb(r.size) + '，' + entries.length + ' 个条目)');
    console.log('   ' + summarize(r.report));
  }
}

if (failed) process.exit(1);
