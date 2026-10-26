/* ============================================================
   Atrium · 回收站 $I 元数据解析与「只认这一次删除」的匹配判据（纯逻辑）
   ------------------------------------------------------------
   为什么单独抽出来：这一层**写错了都不报错**，而且症状全是"看着正常"——
     · 时间戳/大小被 32 位截断 → "只认这一次删除"的护栏悄悄失效，
       撤销时可能把用户更早手动删掉的同名文件搬回来（还原错文件）；
       或者 ≥2GiB 的文件永远还原失败（大小提示对不上，判成"回收站里没有"）。
     · $I 布局解析偏移错 4 字节 → 路径读成乱码 → 永远 not-found。
   而它又完全不需要 Electron：给一个 Buffer 就能算。所以抽成纯函数，
   由 test/trash.test.js 直接喂**手工拼出来的 $I 字节**做断言。

   注意：本文件只做"字节 → 结构 → 是否匹配"的判定，不碰文件系统。
   真正的 readdir / rename / unlink 留在 main.js。
   ============================================================ */
'use strict';

/* FILETIME 的零点（1601-01-01 UTC）与 Unix 零点相差多少个 100ns 刻度 */
const FT_TICKS_AT_UNIX_EPOCH = 116444736000000000n;
/* 100ns 刻度 → 毫秒 */
const TICKS_PER_MS = 10000;

/* 删除日志里的 ts 与 $I 里的删除时刻允许差多少。
   ts 是 Date.now()（删除前取），$I 是回收站自己写的系统时刻，两者可能差几十毫秒；
   取整 + 文件系统时间戳精度放宽到 2 秒。**不能放宽太多** —— 这个窗口越宽，
   "把更早手动删掉的同名文件认成这一次"的概率越高。 */
const HINT_SLACK_MS = 2000;

/** FILETIME（100ns 自 1601-01-01）→ Unix 毫秒。0 / 负数 / 非有限值一律 0（=未知）。 */
function ftToMs(ft) {
  if (typeof ft === 'bigint') {
    if (ft <= 0n) return 0;
    const ms = (ft - FT_TICKS_AT_UNIX_EPOCH) / BigInt(TICKS_PER_MS);
    return Number(ms);
  }
  if (!Number.isFinite(ft) || ft <= 0) return 0;
  return Math.round(ft / TICKS_PER_MS - 11644473600000);
}

/** 是不是"盘符:\..."形式的绝对 Windows 路径（回收站里只会有这种） */
function isAbsWin(s) {
  return typeof s === 'string' && s.length > 3 && s[1] === ':' && (s[2] === '\\' || s[2] === '/');
}

/** 是不是 $I 记录文件（$Ixxxxxx.ext）；$R 是内容本体 */
function isInfoName(n) {
  return typeof n === 'string' && n.length > 2 && n.charCodeAt(0) === 36 && n[1] === 'I';
}

/** 由 $I 文件名推出对应的 $R 文件名 */
function rNameOf(n) { return '$R' + n.slice(2); }

/**
 * 解析 $I 文件内容。认不出就返回 null（绝不猜）。
 * 返回 { ver, size, ms, orig }
 *   ver  1 | 2
 *   size 字节数（安全整数；超出 2^53 视为损坏）
 *   ms   删除时刻（Unix 毫秒；0 = 未知）
 *   orig 原始绝对路径（字符串，可能为空串）
 */
function parseTrashInfoBuf(b) {
  if (!b || typeof b.length !== 'number' || b.length < 24) return null;
  let ver;
  try { ver = b.readInt32LE(0); } catch (e) { return null; }

  let size, ms, orig;
  if (ver === 2) {
    /* 实测 Win10/11 布局（比常见文档多 4 字节保留位）：
         0 版本(4) · 4 保留(4) · 8 大小(8) · 16 删除时刻 FILETIME(8)
        24 路径字符数(4) · 28 路径(UTF-16LE) */
    if (b.length < 28) return null;
    size = Number(b.readBigInt64LE(8));
    ms = ftToMs(b.readBigInt64LE(16));
    const len = b.readInt32LE(24);
    if (!(len > 0) || len > 32767 || 28 + len * 2 > b.length) return null;
    orig = b.slice(28, 28 + len * 2).toString('utf16le').replace(/\0+$/, '');
  } else if (ver === 1) {
    /* 老版布局：0 版本(4) · 4 大小(8) · 12 删除时刻 FILETIME(8) · 20 路径(固定 520 字节) */
    size = Number(b.readBigInt64LE(4));
    ms = ftToMs(b.readBigInt64LE(12));
    orig = b.slice(20, Math.min(b.length, 20 + 520)).toString('utf16le').replace(/\0+$/, '');
  } else {
    return null; // v0（Win95 格式）已绝迹，直接忽略
  }

  /* 大小必须是安全非负整数。BigInt → Number 一旦越过 2^53 就不再精确，
     与其带着一个"差不多"的数字去比对，不如判成损坏（宁可 not-found 也不误还原）。 */
  if (!Number.isSafeInteger(size) || size < 0) return null;
  if (!Number.isFinite(ms) || ms < 0) return null;
  return { ver, size, ms, orig: typeof orig === 'string' ? orig : '' };
}

/* ------------------------------------------------------------
   提示值（来自渲染层的删除日志记录）→ 安全的比较基准
   ------------------------------------------------------------
   历史坑：调用处写的是 `(rec.size) | 0`、`(rec.ts) | 0`。
   位或运算会把数字截成**有符号 32 位整数**：
     · ts 约 1.77e12 → 截成某个 |值| < 2^31 的随机数，
       `afterMs` 于是变成一个远早于真实删除时刻的数 → "只认这一次删除"失效；
     · size ≥ 2GiB → 变成负数 → 与 $I 里的真实大小永不相等 → 大文件永远还原不了。
   所以这里**去掉位运算**，改用 Number.isSafeInteger 校验，并且**校验不过就 fail closed**：
   返回 null，由调用方报 bad-hint，而不是悄悄退回"不限制"（那等于把护栏拆掉还不说）。
   ------------------------------------------------------------ */

/** undefined / null / '' 表示"不限制"，返回 0；数字（或纯数字字符串）必须是安全非负整数。 */
function hintNum(v) {
  if (v === undefined || v === null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isSafeInteger(n) || n < 0) return NaN; // NaN = 非法，调用方 fail closed
  return n;
}

/** 从删除日志记录里取出 { size, ts } 比较基准；任一非法则返回 null。 */
function hintsOf(rec) {
  if (!rec || typeof rec !== 'object') return { size: 0, ts: 0 };
  const size = hintNum(rec.size);
  const ts = hintNum(rec.ts);
  if (Number.isNaN(size) || Number.isNaN(ts)) return null;
  return { size, ts };
}

/**
 * 这条 $I 记录是不是"我们要找的那一次删除"。
 *   want     原始路径（调用方已转小写）
 *   sizeHint 0 = 不限；否则必须与 $I 里的大小**精确相等**
 *   afterMs  0 = 不限；否则删除时刻不得早于 afterMs - HINT_SLACK_MS
 */
function matchRecord(rec, want, sizeHint, afterMs) {
  if (!rec || !isAbsWin(rec.orig)) return false;
  if (rec.orig.toLowerCase() !== want) return false;
  /* $I 里的大小为 0 时（老格式/损坏）不做大小过滤，与历史行为一致 */
  if (sizeHint && rec.size && rec.size !== sizeHint) return false;
  if (afterMs && rec.ms && rec.ms + HINT_SLACK_MS < afterMs) return false;
  return true;
}

/** 同一路径可能有多条历史记录：取删除时刻最新的那条（"最近一次删除"）。 */
function pickNewest(list) {
  let best = null;
  for (const it of (Array.isArray(list) ? list : [])) {
    if (!it) continue;
    if (!best || (it.ms || 0) > (best.ms || 0)) best = it;
  }
  return best;
}

module.exports = {
  FT_TICKS_AT_UNIX_EPOCH,
  HINT_SLACK_MS,
  ftToMs,
  isAbsWin,
  isInfoName,
  rNameOf,
  parseTrashInfoBuf,
  hintNum,
  hintsOf,
  matchRecord,
  pickNewest,
};
