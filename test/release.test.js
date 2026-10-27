/* ============================================================
   Atrium · 发布判定纯逻辑单元测试（纯 Node，不需要 Electron / 网络）
   ------------------------------------------------------------
   为什么值得单测：这段逻辑错了**不会报错**，而且症状是"看起来正常"——
     · 判定太宽松 → 该重传的时候跳过上传，对外那个包永远是旧的；
     · 判定太严   → 每次发版都白传 112 MB，甚至卡住发版流程。
   更要紧的是 v1.20.3 修的那个自证循环：原来的"完整性证据"是我们自己
   上传的 .sha256 文件，拿它跟本地摘要比恒等 —— 一个**永远为真**的校验，
   上传被截断也照样"通过"。所以这里的重点是一串**必须判重传**的用例，
   以及"有 digest 时不许再拿 .sha256 当证据"这条。

   运行： node test/release.test.js
   ============================================================ */
'use strict';

const path = require('path');

const R = require(path.join(__dirname, '..', 'deploy', 'release', 'releaselib.js'));

/* ---------- 极简断言框架 ---------- */
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail ? '  → ' + detail : ''));
}

const HEX = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const asset = (digest, size) => ({ name: 'x.zip', size: size, digest: digest });

/* ============================================================
   1. parseDigest：只认干净的 sha256:<64 hex>
   ============================================================ */
ok('正常 digest 能解析', R.parseDigest(asset('sha256:' + HEX, 1)) === HEX);
ok('大写十六进制归一小写', R.parseDigest(asset('sha256:' + HEX.toUpperCase(), 1)) === HEX);
ok('前后空白容忍', R.parseDigest(asset('  sha256:' + HEX + '  ', 1)) === HEX);
ok('字段缺失 → 空串（不猜）', R.parseDigest({}) === '');
ok('asset 为 null → 空串', R.parseDigest(null) === '');
ok('digest 非字符串 → 空串', R.parseDigest({ digest: 123 }) === '');
ok('算法不是 sha256 → 空串', R.parseDigest(asset('sha512:' + HEX, 1)) === '');
ok('长度不足 64 → 空串（半截摘要不能当证据）', R.parseDigest(asset('sha256:' + 'a'.repeat(63), 1)) === '');
ok('多余字符 → 空串', R.parseDigest(asset('sha256:' + HEX + 'zz', 1)) === '');
ok('没有算法前缀 → 空串', R.parseDigest(asset(HEX, 1)) === '');

/* ============================================================
   2. decide：有 digest 时，digest 说了算
   ============================================================ */
const same = R.decide({ localHex: HEX, localSize: 100, asset: asset('sha256:' + HEX, 100), shaText: '' });
ok('摘要与大小都一致 → 不重传', same.needUpload === false, JSON.stringify(same));
ok('判定依据标成 digest（不是 .sha256 文件）', same.via === 'digest', same.via);

const diff = R.decide({ localHex: HEX, localSize: 100, asset: asset('sha256:' + OTHER, 100), shaText: '' });
ok('摘要不一致 → 必须重传', diff.needUpload === true, JSON.stringify(diff));

/* 关键反例：.sha256 说"一致"，但服务器侧 digest 说"不一致" → 以 digest 为准。
   这正是自证循环会漏掉的那种包（上传被串/被截断，本地摘要文件却是对的）。 */
const trap = R.decide({
  localHex: HEX, localSize: 100,
  asset: asset('sha256:' + OTHER, 100),
  shaText: HEX + '  x.zip\n',
});
ok('digest 与 .sha256 冲突时以 digest 为准 → 必须重传', trap.needUpload === true, JSON.stringify(trap));
ok('冲突时依据仍标 digest', trap.via === 'digest', trap.via);

/* 大小对不上但摘要相同 —— 现实里不该发生，发生了也要重传（别放过） */
const sizeMismatch = R.decide({ localHex: HEX, localSize: 100, asset: asset('sha256:' + HEX, 99), shaText: '' });
ok('摘要相同但大小不同 → 仍然重传', sizeMismatch.needUpload === true, JSON.stringify(sizeMismatch));

/* ============================================================
   3. decide：拿不到 digest 时降级到 .sha256，并如实标出来
   ============================================================ */
const degOk = R.decide({ localHex: HEX, localSize: 100, asset: asset(undefined, 100), shaText: HEX + '  x.zip\n' });
ok('无 digest 且 .sha256 一致 → 不重传（降级）', degOk.needUpload === false, JSON.stringify(degOk));
ok('降级路径被标记出来（不冒充 digest）', degOk.via === 'sha256-file', degOk.via);

const degBad = R.decide({ localHex: HEX, localSize: 100, asset: asset(undefined, 100), shaText: OTHER + '  x.zip\n' });
ok('无 digest 且 .sha256 不一致 → 重传', degBad.needUpload === true, JSON.stringify(degBad));

const degEmpty = R.decide({ localHex: HEX, localSize: 100, asset: asset(undefined, 100), shaText: '' });
ok('无 digest 且 .sha256 读不到 → 重传（宁可白传一次，不留可疑包）',
  degEmpty.needUpload === true, JSON.stringify(degEmpty));

const noAsset = R.decide({ localHex: HEX, localSize: 100, asset: null, shaText: '' });
ok('资产不存在 → 重传', noAsset.needUpload === true && noAsset.via === 'none', JSON.stringify(noAsset));

/* ============================================================
   4. 源码级不变量：发布脚本不许再拿自己传的 .sha256 当证据
   ============================================================ */
const fs = require('fs');
const src = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'release', 'upload_release.js'), 'utf8');
ok('upload_release.js 引用了 GitHub 侧 digest', src.indexOf('parseDigest') >= 0);
ok('upload_release.js 把判定交给 releaselib（没有自己另写一套）', src.indexOf('decide(') >= 0);
ok('upload_release.js 上传后也复核 digest（不只是大小）',
  /upDigest\s*!==\s*zipSha/.test(src));

/* ============================================================
   汇总
   ============================================================ */
console.log('');
console.log('release 纯逻辑：' + pass + ' 项通过，' + fail + ' 项失败');
if (fail) {
  console.log('');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
