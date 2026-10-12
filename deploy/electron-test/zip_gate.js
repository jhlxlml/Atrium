/* ============================================================
   Atrium · zip_gate.js （打包链路门禁）
   ------------------------------------------------------------
   背景：v1.5.0 的 ZIP 用 7-Zip 解压时逐条报 "CRC Failed"，原因是自写 ZIP
   写入器把 CRC32 算在了「压缩后」字节流上（正确应算「压缩前」原始内容），
   而当时的校验只比对了"解压后字节数"，完全没查 CRC 字段，所以没拦住。

   本门禁做三件事，全部输出原始测量值，断言放在 run_all.js：
     1) CRC 实现自检（标准向量 + 原生/JS 表交叉验证）；
     2) 现场造一个「CRC 算在压缩流上」的坏包 → 必须被 verify_zip 判失败；
        同时造一个只差 CRC 这一个变量的「正确对照组」→ 必须判通过。
        两者成对出现，才能证明失败是 CRC 引起的，而不是别的结构问题；
     3) 若本机有 7z.exe，用它做第三方复验（就是用户实际用的那个工具）。
        校验仓库里已有的 Electron 大包（--quick 时跳过，避免拖慢快测）。
     （离线单文件版已退役，本门禁不再跑 pack.js --offline。）

   用法：node deploy/electron-test/zip_gate.js [--quick]
   输出：最后一行 ZIPGATE {json}
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
/* spawnSync 的默认 stdio 会给 stdin 建管道，本机沙箱拒绝（EBUSY，连 cmd.exe
   都起不来）。子进程（robocopy / electron 探针 / 7z / where）没有一个需要
   stdin，所以统一把它设成 ignore；stdout 与 stderr 照常 pipe，调用方无感。
   显式传了 stdio 的调用点仍然优先。 */
const { spawnSync: rawSpawnSync } = require('child_process');
const spawnSync = function (cmd, args, opts) {
  return rawSpawnSync(cmd, args, Object.assign({ stdio: ['ignore', 'pipe', 'pipe'] }, opts || {}));
};

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..', '..');
const LOGS = path.join(HERE, 'logs');
const QUICK = process.argv.includes('--quick');

let verifyZip, crcSelfTest, summarize;
try {
  const v = require(path.join(ROOT, 'deploy', 'verify_zip.js'));
  verifyZip = v.verifyZip; crcSelfTest = v.crcSelfTest; summarize = v.summarize;
} catch (e) {
  console.log('ZIPGATE ' + JSON.stringify({ fatal: '无法加载 verify_zip.js: ' + e.message }));
  process.exit(1);
}

try { fs.mkdirSync(LOGS, { recursive: true }); } catch (e) { /* 已存在 */ }

/* ---------- 迷你 ZIP 构造器：只保留一个变量（CRC 依据哪段数据） ---------- */
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

/**
 * @param {boolean} crcOverCompressed true = 复刻 v1.5.0 的 bug（CRC 算在压缩流上）
 */
function buildMiniZip(crcOverCompressed) {
  const raw = Buffer.from('Atrium · ZIP 门禁样本 '.repeat(40), 'utf8');
  const def = zlib.deflateRawSync(raw, { level: 6 });
  const name = Buffer.from('sample.txt', 'utf8');
  const crc = crcOverCompressed ? crc32(def) : crc32(raw);

  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt16LE(0x0800, 6);
  lh.writeUInt16LE(8, 8);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(def.length, 18);
  lh.writeUInt32LE(raw.length, 22);
  lh.writeUInt16LE(name.length, 26);

  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(20, 4);
  ch.writeUInt16LE(20, 6);
  ch.writeUInt16LE(0x0800, 8);
  ch.writeUInt16LE(8, 10);
  ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(def.length, 20);
  ch.writeUInt32LE(raw.length, 24);
  ch.writeUInt16LE(name.length, 28);
  ch.writeUInt32LE(0x20, 38);
  ch.writeUInt32LE(0, 42);

  const cd = Buffer.concat([ch, name]);
  const eo = Buffer.alloc(22);
  eo.writeUInt32LE(0x06054b50, 0);
  eo.writeUInt16LE(1, 8);
  eo.writeUInt16LE(1, 10);
  eo.writeUInt32LE(cd.length, 12);
  eo.writeUInt32LE(30 + name.length + def.length, 16);
  return Buffer.concat([lh, name, def, cd, eo]);
}

const out = {};

/* ---------- 1. CRC 实现自检 ---------- */
const st = crcSelfTest();
out.crcSelfTestOk = st.ok;
out.crcSource = st.source;
if (!st.ok) out.crcSelfTestFails = st.fails;

/* ---------- 2. 坏包必须被拒 + 正确对照组必须通过 ---------- */
const badPath = path.join(LOGS, 'gate-bad-crc.zip');
const ctlPath = path.join(LOGS, 'gate-control.zip');
fs.writeFileSync(badPath, buildMiniZip(true));
fs.writeFileSync(ctlPath, buildMiniZip(false));

const badRep = verifyZip(badPath);
out.badRejected = badRep.ok === false;                  // 关键：必须判失败
out.badCrcBad = badRep.crcBad;
out.badReason = badRep.details.length ? badRep.details[0].why.join('；') : '';
out.controlAccepted = verifyZip(ctlPath).ok === true;   // 对照组必须判通过
// 两个样本只有 CRC 一个变量不同 —— 证明失败归因于 CRC
out.pairDiffersOnlyInCrc = badRep.entries === 1 && verifyZip(ctlPath).entries === 1;

/* ---------- 3. 仓库里已有的 Electron 大包（快测时跳过） ---------- */
let VER = '';
try { VER = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch (e) { /* 交给断言 */ }
const electronZip = path.join(ROOT, 'Atrium_Electron版_v' + VER + '.zip');
out.electronZipExists = fs.existsSync(electronZip);
if (out.electronZipExists && !QUICK) {
  const r = verifyZip(electronZip);
  out.electronOk = r.ok;
  out.electronEntries = r.entries;
  out.electronCrcBad = r.crcBad;
  out.electronContentBad = r.contentBad;
} else if (QUICK) {
  out.electronSkipped = true;
}

/* ---------- 4. 7-Zip 第三方复验（用用户实际使用的工具） ---------- */
function find7z() {
  const cands = [
    'D:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  ];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) { /* 继续找 */ } }
  const w = spawnSync('where', ['7z.exe'], { encoding: 'utf8', windowsHide: true });
  const hit = (w.stdout || '').trim().split('\n')[0];
  return hit && fs.existsSync(hit) ? hit : null;
}
const sevenZip = find7z();
out.sevenZipFound = !!sevenZip;
if (sevenZip) {
  out.sevenZipPath = sevenZip;
  // 用户实际踩到的就是这个大包，非快测时也拿 7-Zip 过一遍（约数秒）
  if (out.electronZipExists && !QUICK) {
    const t2 = spawnSync(sevenZip, ['t', electronZip], { encoding: 'utf8', timeout: 300000, windowsHide: true });
    const txt2 = ((t2.stdout || '') + (t2.stderr || ''));
    out.sevenZipElectronCode = t2.status;
    out.sevenZipElectronOk = /Everything is Ok/i.test(txt2);
    out.sevenZipElectronCrcFailed = (txt2.match(/CRC Failed/g) || []).length;
  }
}

console.log('ZIPGATE ' + JSON.stringify(out));
