/* ============================================================
   Atrium · 回收站 $I 解析与「只认这一次删除」匹配判据（纯 Node，不需要 Electron）
   ------------------------------------------------------------
   为什么值得单测：这一层**写错了都不报错**，症状全是"看着正常"——
     · 毫秒时间戳被 `| 0` 截成 32 位 → "只认这一次删除"的护栏静默失效，
       撤销时会把用户**昨天手动删掉**的同名文件搬回来，还报"已撤销"；
     · 大小被 `| 0` 截断 → ≥2GiB 的文件判成"回收站里没有"，永远还原不了；
     · $I 布局偏移错 4 字节 → 路径读成乱码 → 永远 not-found。
   所以本文件的重点在前半段的**反向用例**：先用 `|0` 亲手复现失真，
   再断言修复后的函数把同样的输入处理对。只测"正常路径能匹配"等于恒真的门禁。

   运行： node test/trash.test.js
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const L = require(path.join(__dirname, '..', 'deploy', 'electron', 'trashlib.js'));

/* ---------- 极简断言框架 ---------- */
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail ? '  → ' + detail : ''));
}
function eq(name, got, want) {
  ok(name, got === want, '实测 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want));
}

/* ---------- 手工拼 $I 字节（照实测的 Win10/11 布局） ---------- */
const FT_UNIX = 11644473600000n; // 1601-01-01 → 1970-01-01，单位 ms
function msToFt(ms) { return (BigInt(ms) + FT_UNIX) * 10000n; }

/** v2：0 版本(4) · 4 保留(4) · 8 大小(8) · 16 删除时刻(8) · 24 字符数(4) · 28 路径(UTF-16LE) */
function mkI2(orig, size, ms) {
  const p = Buffer.from(orig, 'utf16le');
  const b = Buffer.alloc(28 + p.length);
  b.writeInt32LE(2, 0);
  b.writeBigInt64LE(BigInt(size), 8);
  b.writeBigInt64LE(msToFt(ms), 16);
  b.writeInt32LE(p.length / 2, 24);
  p.copy(b, 28);
  return b;
}
/** v1：0 版本(4) · 4 大小(8) · 12 删除时刻(8) · 20 路径（固定 520 字节） */
function mkI1(orig, size, ms) {
  const p = Buffer.from(orig, 'utf16le');
  const b = Buffer.alloc(20 + 520);
  b.writeInt32LE(1, 0);
  b.writeBigInt64LE(BigInt(size), 4);
  b.writeBigInt64LE(msToFt(ms), 12);
  p.copy(b, 20);
  return b;
}

const P = 'C:\\Users\\me\\Pictures\\a.png';
const WANT = P.toLowerCase();
const TS = 1700000000000;            // 2023-11-14T22:13:20Z，毫秒时间戳的典型量级
const THREE_GB = 3 * 1024 * 1024 * 1024; // 3221225472，超过 int32 上限
const DAY = 86400000;

/* ============================================================
   1) ftToMs —— FILETIME → Unix 毫秒
   ============================================================ */
eq('ftToMs(0) → 0（未知，不猜）', L.ftToMs(0), 0);
eq('ftToMs(-1) → 0', L.ftToMs(-1), 0);
eq('ftToMs(NaN) → 0', L.ftToMs(NaN), 0);
eq('ftToMs(Infinity) → 0', L.ftToMs(Infinity), 0);
eq('ftToMs(2024-01-01T00:00:00Z) → 1704067200000',
  L.ftToMs(133485408000000000), 1704067200000);
eq('ftToMs 往返：ms → FILETIME → ms 不丢精度',
  L.ftToMs(msToFt(TS)), TS);
eq('ftToMs 接受 bigint（$I 里读出来的就是 bigint）',
  L.ftToMs(msToFt(TS)), TS);
eq('ftToMs 换算差恰好是 1601→1970 的毫秒数',
  Number(L.FT_TICKS_AT_UNIX_EPOCH / 10000n), 11644473600000);

/* ============================================================
   2) parseTrashInfoBuf —— 只认认得出的，认不出就 null
   ============================================================ */
const r2 = L.parseTrashInfoBuf(mkI2(P, 12345, TS));
eq('v2 版本号', r2 && r2.ver, 2);
eq('v2 大小', r2 && r2.size, 12345);
eq('v2 删除时刻', r2 && r2.ms, TS);
eq('v2 原始路径', r2 && r2.orig, P);

const r1 = L.parseTrashInfoBuf(mkI1(P, 777, TS));
eq('v1 版本号', r1 && r1.ver, 1);
eq('v1 大小', r1 && r1.size, 777);
eq('v1 删除时刻', r1 && r1.ms, TS);
eq('v1 原始路径', r1 && r1.orig, P);

eq('v2 的 3GiB 大小原样读出（不经过位运算）',
  (L.parseTrashInfoBuf(mkI2(P, THREE_GB, TS)) || {}).size, THREE_GB);

eq('太短的 buffer → null', L.parseTrashInfoBuf(Buffer.alloc(20)), null);
eq('null → null', L.parseTrashInfoBuf(null), null);
eq('v0（Win95 格式）→ null', L.parseTrashInfoBuf(Buffer.alloc(64)), null);
{
  const b = mkI2(P, 1, TS); b.writeInt32LE(3, 0);
  eq('未知版本 3 → null', L.parseTrashInfoBuf(b), null);
}
{
  const b = mkI2(P, 1, TS); b.writeInt32LE(0, 24);
  eq('v2 路径字符数 0 → null（宁可 not-found 也不猜）', L.parseTrashInfoBuf(b), null);
}
{
  const b = mkI2(P, 1, TS); b.writeInt32LE(32768, 24);
  eq('v2 路径字符数超上限 → null', L.parseTrashInfoBuf(b), null);
}
{
  const b = mkI2(P, 1, TS); b.writeInt32LE(9999, 24);
  eq('v2 声明的路径长度超出 buffer → null', L.parseTrashInfoBuf(b), null);
}
{
  const b = mkI2(P, 1, TS); b.writeBigInt64LE(9007199254740993n, 8); // 2^53+1
  eq('大小越过 2^53（BigInt→Number 已不精确）→ null', L.parseTrashInfoBuf(b), null);
}
{
  const b = mkI2(P, 1, TS); b.writeBigInt64LE(-5n, 8);
  eq('大小为负 → null', L.parseTrashInfoBuf(b), null);
}

/* ============================================================
   3) hintNum / hintsOf —— 比较基准必须原样保留
   ============================================================ */
eq('undefined → 0（=不限制）', L.hintNum(undefined), 0);
eq('null → 0', L.hintNum(null), 0);
eq("'' → 0", L.hintNum(''), 0);
eq('毫秒时间戳原样保留', L.hintNum(TS), TS);
eq('3GiB 原样保留', L.hintNum(THREE_GB), THREE_GB);
eq('0 字节文件 → 0', L.hintNum(0), 0);
eq("数字字符串 '12345' → 12345（兼容老日志）", L.hintNum('12345'), 12345);
ok('NaN → NaN（非法，调用方 fail closed）', Number.isNaN(L.hintNum(NaN)));
ok('Infinity → NaN', Number.isNaN(L.hintNum(Infinity)));
ok('负数 → NaN', Number.isNaN(L.hintNum(-1)));
ok('小数 → NaN（大小是整数，1.5 字节不存在）', Number.isNaN(L.hintNum(1.5)));
ok('2^53 → NaN', Number.isNaN(L.hintNum(Math.pow(2, 53))));
ok("非数字字符串 'abc' → NaN", Number.isNaN(L.hintNum('abc')));

eq('hintsOf(null) → 不限制', JSON.stringify(L.hintsOf(null)), '{"size":0,"ts":0}');
eq('hintsOf({}) → 不限制', JSON.stringify(L.hintsOf({})), '{"size":0,"ts":0}');
eq('hintsOf 正常记录原样取出',
  JSON.stringify(L.hintsOf({ size: THREE_GB, ts: TS })),
  JSON.stringify({ size: THREE_GB, ts: TS }));
eq('hintsOf 任一项非法 → null（fail closed，不退化成"不限制"）',
  L.hintsOf({ size: -1, ts: TS }), null);
eq('hintsOf 时间戳非法 → null', L.hintsOf({ size: 10, ts: Infinity }), null);

/* ============================================================
   4) 反向用例：`| 0` 到底把什么弄坏了
   —— 这两段是本文件的重点。先复现失真，再断言修复后对。
   ============================================================ */
ok('反向：毫秒时间戳经过 |0 会被截断（护栏失效的根源）',
  (TS | 0) !== TS, 'TS=' + TS + ' → TS|0=' + (TS | 0));
ok('反向：截断后的值甚至变成负数',
  (TS | 0) < 0, 'TS|0=' + (TS | 0));
ok('反向：3GiB 经过 |0 变成负数（大文件永远还原不了的根源）',
  (THREE_GB | 0) < 0, THREE_GB + ' → ' + (THREE_GB | 0));

/* --- 4a. 时间护栏：昨天的删除会不会被认成"这一次" --- */
{
  const oldRec = L.parseTrashInfoBuf(mkI2(P, 100, TS - DAY));
  const oldHint = TS | 0; // 历史代码：restoreFromTrash(p, size, (rec.ts) | 0)
  ok('反向：用截断后的 afterMs，"昨天手动删的"也被认成这一次删除',
    L.matchRecord(oldRec, WANT, 100, oldHint),
    'afterMs=' + oldHint + '，记录 ms=' + (TS - DAY));
  ok('修复后：同一条记录被正确拒绝（不会把用户昨天删的文件搬回来）',
    !L.matchRecord(oldRec, WANT, 100, TS),
    'afterMs=' + TS + '，记录 ms=' + (TS - DAY));
}

/* --- 4b. 大小护栏：≥2GiB 的文件 --- */
{
  const bigRec = L.parseTrashInfoBuf(mkI2(P, THREE_GB, TS));
  ok('反向：3GiB 的 sizeHint 被截断成负数 → 判成"回收站里没有"',
    !L.matchRecord(bigRec, WANT, THREE_GB | 0, TS),
    'sizeHint=' + (THREE_GB | 0) + '，记录 size=' + THREE_GB);
  ok('修复后：3GiB 的文件能正确匹配（大文件可还原）',
    L.matchRecord(bigRec, WANT, THREE_GB, TS));
}

/* ============================================================
   5) matchRecord —— 正反向都要过
   ============================================================ */
{
  const rec = L.parseTrashInfoBuf(mkI2(P, 100, TS));
  ok('同路径 + 同大小 + 同一时刻 → 匹配', L.matchRecord(rec, WANT, 100, TS));
  ok('路径大小写不敏感（Windows 语义）',
    L.matchRecord(rec, P.toUpperCase().toLowerCase(), 100, TS));
  ok('同路径但大小不同 → 拒绝（同名不同文件）', !L.matchRecord(rec, WANT, 101, TS));
  ok('sizeHint=0 → 不限大小', L.matchRecord(rec, WANT, 0, TS));
  ok('afterMs=0 → 不限时间', L.matchRecord(rec, WANT, 100, 0));
  ok('删除时刻早于时间窗 1 天 → 拒绝', !L.matchRecord(rec, WANT, 100, TS + DAY));
  ok('删除时刻在 2 秒容差内 → 接受（时钟抖动）',
    L.matchRecord(rec, WANT, 100, TS + 1500));
  ok('删除时刻超出 2 秒容差 → 拒绝', !L.matchRecord(rec, WANT, 100, TS + 2500));
  ok('时间窗是"不早于"，比 hint 更晚的删除仍可匹配',
    L.matchRecord(rec, WANT, 100, TS - 60000));
}
{
  const rel = L.parseTrashInfoBuf(mkI2('a.png', 100, TS));
  ok('相对路径的记录 → 拒绝（回收站里只会有绝对路径）',
    !L.matchRecord(rel, 'a.png', 100, TS));
  ok('null 记录 → 拒绝', !L.matchRecord(null, WANT, 100, TS));
  ok('$I 里大小是 0（老格式）→ 不做大小过滤',
    L.matchRecord(L.parseTrashInfoBuf(mkI2(P, 0, TS)), WANT, 100, TS));
  ok('$I 里时刻是 0（未知）→ 不做时间过滤',
    L.matchRecord(L.parseTrashInfoBuf(mkI2(P, 100, 0)), WANT, 100, TS));
}

/* ============================================================
   6) 同路径同大小多次删除：只认最近一次
   —— "撤销"的语义是撤销**这一次**，不是"随便把哪个搬回来"。
   ============================================================ */
{
  const list = [TS - DAY, TS, TS - 3600000].map((ms) => {
    const r = L.parseTrashInfoBuf(mkI2(P, 100, ms));
    return { ms: r.ms, size: r.size, orig: r.orig, rFile: '$R' + ms };
  });
  const best = L.pickNewest(list);
  eq('pickNewest 取删除时刻最新的那条', best && best.ms, TS);
  eq('pickNewest 不修改入参顺序（无副作用）', list[0].ms, TS - DAY);
  eq('pickNewest([]) → null', L.pickNewest([]), null);
  eq('pickNewest(null) → null', L.pickNewest(null), null);
  eq('pickNewest 跳过空项', (L.pickNewest([null, list[1]]) || {}).ms, TS);

  /* 用"这一次"的 hint 过滤整串历史记录：只应剩下最新那条 */
  const kept = list.filter((it) => L.matchRecord(it, WANT, 100, TS));
  eq('同路径同大小删过三次，按这一次的 hint 过滤后只剩 1 条', kept.length, 1);
  eq('剩下的就是最新那次', kept[0] && kept[0].ms, TS);

  /* 反向：截断后的 hint 会让三条全都通过 */
  const keptBad = list.filter((it) => L.matchRecord(it, WANT, 100, TS | 0));
  eq('反向：截断的 afterMs 让三条历史记录全部通过（护栏形同不存在）', keptBad.length, 3);
}

/* ============================================================
   7) 源级接线：main.js 不许再出现位运算截断
   ============================================================ */
{
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'electron', 'main.js'), 'utf8');
  /* 注释里会**故意**写出 `(rec.ts) | 0` 当反面教材，所以扫代码前先把注释剥掉 */
  const codeOnly = mainSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/[^\n]*$/, '')).join('\n');
  ok('main.js 走了 trashlib（没有自己另写一套 $I 解析）',
    mainSrc.indexOf("require('./trashlib.js')") >= 0
      && codeOnly.indexOf('trashLib.parseTrashInfoBuf') >= 0
      && codeOnly.indexOf('trashLib.matchRecord') >= 0
      && codeOnly.indexOf('trashLib.pickNewest') >= 0
      && codeOnly.indexOf('trashLib.hintsOf') >= 0);
  ok('main.js 里不再有 (rec.size)|0 / (rec.ts)|0 这类 32 位截断',
    !/\(\s*rec\s*(?:&&\s*rec)?\.size\s*\)\s*\|\s*0/.test(codeOnly)
      && !/\(\s*rec\s*(?:&&\s*rec)?\.ts\s*\)\s*\|\s*0/.test(codeOnly),
    (codeOnly.match(/[^\n]*\| 0[^\n]*/g) || []).join(' | '));
  ok('main.js 里三个撤销/预览入口都先校验 hint（fail closed）',
    (codeOnly.match(/trashLib\.hintsOf\(rec\)/g) || []).length === 3,
    '出现 ' + (codeOnly.match(/trashLib\.hintsOf\(rec\)/g) || []).length + ' 次');
  ok('hint 非法时返回 bad-hint（不是悄悄退回"不限制"）',
    codeOnly.indexOf("reason: 'bad-hint'") >= 0);
  ok('删除日志里的 size 用 stat 出来的真实值（不再 `size || hint`）',
    codeOnly.indexOf('size: size ||') < 0);
  ok('trashlib.js 不依赖 electron（必须能被 Node 直接 require）',
    require(path.join(__dirname, '..', 'deploy', 'electron', 'trashlib.js')) === L);
}

/* ============================================================
   汇总
   ============================================================ */
console.log('');
console.log('回收站纯逻辑：' + pass + ' 项通过，' + fail + ' 项失败');
if (fail) {
  console.log('');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
