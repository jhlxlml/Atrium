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
function guardCrc() {
  const st = crcSelfTest();
  if (!st.ok) {
    console.error('× CRC 实现自检未通过，拒绝打包：\n  ' + st.fails.join('\n  '));
    process.exit(1);
  }
}

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

/* ============================================================
   允许清单（v1.20.1）
   ------------------------------------------------------------
   原来这里是 `walk(appDir, '', [])` —— **递归收集整个产物目录**，一个都不排除。
   风险很具体：开发者用构建产物浏览过私人照片之后，直接 `npm run pack`，
   那份 `data/`（设置 / 收藏 / 旋转记录 / 缩略图缓存，以及 Chromium 的
   Local Storage 与 IndexedDB）就会被原样打进交付 ZIP。
   这不是"可能"，是"只要顺序错了就必然"。

   改成**允许清单**：只收明确属于运行时的条目，其余一律拒绝打包。
   宁可因为"多了一个没见过的文件"而拒绝，也不要"多带了不该带的文件"而发出去。
   清单里的模式按 Electron 运行时的实际构成写（见 BUILD-INFO 与 107 条目清单）；
   Electron 大版本升级后如果多了新文件，这里会**当场拒绝并点名**，不会静默漏掉。
   ============================================================ */

/** 任何层级出现即拒绝：便携数据 / 浏览器缓存 / 日志 / 临时文件 */
const SENSITIVE = [
  /^data$/i, /^cache$/i, /^code cache$/i, /^gpucache$/i, /^dawn(graphite|webgpu)cache$/i,
  /^indexeddb$/i, /^local storage$/i, /^session storage$/i, /^webstorage$/i,
  /^shared dictionary$/i, /^dictionaries$/i, /^network$/i, /^blob_storage$/i,
  /^sharedstorage$/i, /^preferences$/i, /^local state$/i,
  /^trash-log\.json$/i, /^last-dir\.json$/i, /^build-info\.json$/i,
  /\.log$/i, /\.tmp$/i, /\.dmp$/i, /^\.ds_store$/i, /^thumbs\.db$/i,
];

/** 顶层文件：Electron 运行时的那几类 + 我们自己放的 exe / 启动器 / 许可证 */
const TOP_FILE = [
  /^Atrium\.(exe|cmd)$/i,
  /^version$/i,
  /^LICENSE$/i,
  /^LICENSES\.chromium\.html$/i,
  /\.(dll|pak|bin|dat|json)$/i,
];

/** 顶层目录：只有这两个是运行时的一部分 */
const TOP_DIR = ['locales', 'resources'];

/** resources/ 下允许的条目 */
const RES_ENTRY = [/^app$/i, /^default_app\.asar$/i, /\.pak$/i];

/** resources/app 下允许的文件（应用自身的源码与资源） */
const APP_FILE = [/\.(js|css|html|json|ico|png|svg)$/i];
/** resources/app 下允许的子目录 */
const APP_DIR = ['js', 'css'];

function isSensitive(name) { return SENSITIVE.some((re) => re.test(name)); }

/**
 * 按允许清单收集条目。
 * @returns {{entries:Array, rejected:Array<{name:string, why:string}>}}
 */
function collectEntries(appDir) {
  const entries = [];
  const rejected = [];
  const push = (rel, abs, st) => entries.push(
    st.isDirectory() ? { name: rel + '/', dir: true } : { name: rel, abs: abs, dir: false, mtime: st.mtime }
  );
  const deny = (rel, why) => rejected.push({ name: rel, why: why });

  const list = (dir) => fs.readdirSync(dir).sort();

  for (const f of list(appDir)) {
    const abs = path.join(appDir, f);
    const st = fs.statSync(abs);
    if (isSensitive(f)) { deny(f, '便携数据 / 缓存 / 日志类条目'); continue; }
    if (st.isDirectory()) {
      if (TOP_DIR.indexOf(f.toLowerCase()) < 0) { deny(f + '/', '不在允许的顶层目录里'); continue; }
      push(f, abs, st);
      if (f.toLowerCase() === 'locales') {
        for (const n of list(abs)) {
          const a = path.join(abs, n), s = fs.statSync(a);
          if (s.isDirectory()) { deny(f + '/' + n + '/', 'locales 下不应有子目录'); continue; }
          if (!/\.pak$/i.test(n)) { deny(f + '/' + n, 'locales 下只允许 .pak'); continue; }
          push(f + '/' + n, a, s);
        }
      } else {
        for (const n of list(abs)) {
          const a = path.join(abs, n), s = fs.statSync(a);
          if (isSensitive(n)) { deny('resources/' + n, '便携数据 / 缓存 / 日志类条目'); continue; }
          if (!RES_ENTRY.some((re) => re.test(n))) { deny('resources/' + n, '不在 resources 允许清单里'); continue; }
          push('resources/' + n, a, s);
          if (n.toLowerCase() !== 'app' || !s.isDirectory()) continue;
          for (const m of list(a)) {
            const am = path.join(a, m), sm = fs.statSync(am);
            const rel = 'resources/app/' + m;
            if (isSensitive(m)) { deny(rel, '便携数据 / 缓存 / 日志类条目'); continue; }
            if (sm.isDirectory()) {
              if (APP_DIR.indexOf(m.toLowerCase()) < 0) { deny(rel + '/', '不在 app 允许的子目录里'); continue; }
              push(rel, am, sm);
              for (const k of list(am)) {
                const ak = path.join(am, k), sk = fs.statSync(ak);
                if (isSensitive(k)) { deny(rel + '/' + k, '便携数据 / 缓存 / 日志类条目'); continue; }
                if (sk.isDirectory() || !APP_FILE.some((re) => re.test(k))) {
                  deny(rel + '/' + k, '不在 app 允许的文件类型里');
                  continue;
                }
                push(rel + '/' + k, ak, sk);
              }
            } else {
              if (!APP_FILE.some((re) => re.test(m))) { deny(rel, '不在 app 允许的文件类型里'); continue; }
              push(rel, am, sm);
            }
          }
        }
      }
    } else {
      if (!TOP_FILE.some((re) => re.test(f))) { deny(f, '不在允许的顶层文件清单里'); continue; }
      push(f, abs, st);
    }
  }
  return { entries: entries, rejected: rejected };
}

/* 旧的 `walk()`（递归收集整个目录）已删除 —— 它没有排除任何东西，
   正是"私人数据被打进交付包"那条风险的入口。现在只走 collectEntries() 的允许清单。 */

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
function packElectron() {
  const appDir = path.join(ROOT, 'deploy', 'dist-electron', 'Atrium_Electron版');
  if (!fs.existsSync(appDir)) {
    console.error('× 找不到 Electron 产物，请先跑 node deploy/electron/assemble.js');
    process.exit(1);
  }

  /* 先看有没有便携数据。有就**直接拒绝**，不"顺手排除"——
     排除会让"跑过一次产物再打包"变成一条安静的、每次都成功的路，
     而这条路上一旦哪天清单写漏，漏出去的就是用户照片与设置。
     拒绝 + 指名 + 给出处理办法，才是可审计的行为。 */
  const dataDir = path.join(appDir, 'data');
  if (fs.existsSync(dataDir)) {
    console.error('× 产物目录里有便携数据 data/，拒绝打包：');
    console.error('    ' + dataDir);
    console.error('  那是"在本机跑过这个产物"留下的设置 / 收藏 / 缩略图缓存（含 Chromium 的');
    console.error('  Local Storage 与 IndexedDB）。把它打进交付 ZIP 等于泄露用户数据。');
    console.error('  确认不需要后手动移走或删除，再重新打包：');
    console.error('    ren "' + dataDir + '" data-backup   （或直接删掉）');
    process.exit(1);
  }

  const { entries, rejected } = collectEntries(appDir);
  if (rejected.length) {
    console.error('× 产物目录里有不在允许清单里的条目，拒绝打包：');
    for (const r of rejected.slice(0, 20)) console.error('   · ' + r.name + '  —— ' + r.why);
    if (rejected.length > 20) console.error('   · …另有 ' + (rejected.length - 20) + ' 条');
    console.error('  要么把它们清掉，要么（如果是 Electron 升级带来的新文件）把它们加进');
    console.error('  deploy/pack.js 的允许清单 —— 别直接放行整个目录。');
    process.exit(1);
  }

  const zip = path.join(ROOT, 'Atrium_Electron版_v' + VER + '.zip');
  const r = writeZip(zip, entries);
  if (!r.ok) { reportFailure('便携版', r); failed++; }
  else {
    console.log('OK 便携版  → ' + path.basename(zip) + '  (' + mb(r.size) + '，' + entries.length + ' 个条目)');
    console.log('   ' + summarize(r.report));
    console.log('   允许清单校验：' + entries.length + ' 个条目全部在清单内，0 个被拒');
  }
}

if (require.main === module) {
  guardCrc();
  if (doElectron) packElectron();
  if (failed) process.exit(1);
}

module.exports = { collectEntries, isSensitive, TOP_FILE, TOP_DIR, RES_ENTRY, APP_FILE, APP_DIR };
