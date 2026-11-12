/* ============================================================
   Atrium · 「上次目录」记录的授权来源（纯 Node）
   ------------------------------------------------------------
   这条记录决定"下次启动要不要自动打开某个目录、并恢复它的读盘授权"。
   它曾经是个后门：`Atrium.exe --open-dir C:\` 会把 `C:\` 写成"上次目录"，
   下次启动 autoDir 就 grantDir 它 —— 命令行给个路径就等于拿到整个盘的读权限，
   而且**被持久化**，一次启动长期有效。

   现在记录里带 `granted`，只有"用户真的在对话框里选过"才为 true；
   解析时缺字段一律按未授权处理（fail-closed）。这里钉住的就是这条判据。

   运行： node test/lastdir.test.js
   ============================================================ */
'use strict';

const path = require('path');
const L = require(path.join(__dirname, '..', 'deploy', 'electron', 'lastdir.js'));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail ? '  → ' + detail : ''));
}

/* ---------- 1) 正常记录 ---------- */
{
  const r = L.parse(JSON.stringify({ dir: 'D:\\照片\\2024', ts: 1, granted: true }));
  ok('带 granted:true 的记录 → 可恢复授权', !!r && r.granted === true && r.dir === 'D:\\照片\\2024',
    JSON.stringify(r));

  const r2 = L.parse(JSON.stringify({ dir: 'D:\\照片', granted: false }));
  ok('granted:false → 不可恢复授权', !!r2 && r2.granted === false && r2.dir === 'D:\\照片');
}

/* ---------- 2) 老记录（没有 granted 字段）一律未授权 ---------- */
{
  /* 历史版本写的就是 { dir, ts }，而那时 --open-dir 也能写它 ——
     所以"没有标记"不能当成"用户选过"。 */
  const legacy = L.parse(JSON.stringify({ dir: 'C:\\', ts: 1700000000000 }));
  ok('老记录（无 granted）→ 视为未授权', !!legacy && legacy.granted === false, JSON.stringify(legacy));
  ok('老记录的 dir 仍然读得出来（只影响授权，不丢信息）', legacy && legacy.dir === 'C:\\');
}

/* ---------- 3) 只认布尔 true，别被别的真值糊弄 ---------- */
{
  for (const v of ['true', 1, 'yes', {}, []]) {
    const r = L.parse(JSON.stringify({ dir: 'D:\\x', granted: v }));
    ok('granted=' + JSON.stringify(v) + '（非布尔 true）→ 未授权', !!r && r.granted === false,
      JSON.stringify(r));
  }
}

/* ---------- 4) 坏输入 ---------- */
{
  ok('空文本 → null', L.parse('') === null);
  ok('null / undefined → null', L.parse(null) === null && L.parse(undefined) === null);
  ok('不是 JSON → null', L.parse('not json') === null);
  ok('JSON 但不是对象 → null', L.parse('"D:\\\\x"') === null && L.parse('123') === null);
  ok('缺 dir → null', L.parse(JSON.stringify({ granted: true })) === null);
  ok('dir 不是字符串 → null', L.parse(JSON.stringify({ dir: 123, granted: true })) === null);
  ok('dir 是空串 → null', L.parse(JSON.stringify({ dir: '', granted: true })) === null);
}

/* ---------- 5) 序列化：写进去的必须是"显式 granted" ---------- */
{
  const s1 = JSON.parse(L.serialize('D:\\照片', true));
  ok('serialize(dir,true) 带 granted:true', s1.dir === 'D:\\照片' && s1.granted === true);
  ok('serialize 带时间戳（排查用）', typeof s1.ts === 'number' && s1.ts > 0);

  const s2 = JSON.parse(L.serialize('D:\\照片', false));
  ok('serialize(dir,false) → granted:false', s2.granted === false);

  /* 不传第二个参数（= 忘了标来源）必须落到 false，不能默认 true */
  const s3 = JSON.parse(L.serialize('D:\\照片'));
  ok('serialize 漏传 granted → false（默认拒绝）', s3.granted === false);

  /* 清除：dir 写 null，parse 回来是 null */
  const s4 = L.serialize(null, false);
  ok('清除后 parse 得到 null', L.parse(s4) === null, s4);
  ok('清除记录里 dir 是 null（不是空串）', JSON.parse(s4).dir === null);

  /* 往返一致 */
  const rt = L.parse(L.serialize('E:\\备份\\2024', true));
  ok('往返后 dir 与 granted 都不变', rt && rt.dir === 'E:\\备份\\2024' && rt.granted === true);
}

/* ============================================================
   汇总
   ============================================================ */
console.log('');
console.log('「上次目录」授权来源：' + pass + ' 项通过，' + fail + ' 项失败');
if (fail) {
  console.log('');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
