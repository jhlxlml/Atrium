/* ============================================================
   Atrium · 索引器（Loader.buildEntries）与尺寸缓存归属的回归测试
   ------------------------------------------------------------
   D. buildEntries() 对原生条目（只有 path、没有 File）用 `e.size | 0` 取大小。
      位运算是 32 位有符号的：≥2GiB 的文件会变成负数。后果不是"显示得难看"，
      而是连锁的 ——
        · 条目 id 里含 size（Util.itemId），负数让同一张图在"重启后重新索引"
          与"上次写进缓存"之间算出两个不同的 id，缩略图/尺寸缓存全部失配；
        · Util.fmtBytes(负数) 直接返回空串，界面上文件大小整块消失；
        · 按大小排序时这张图被排到最前面（负数最小）。
      同一类错误在 main.js 的删除日志里已经修过一次（见 doTrashOne 的注释）。

   D'. Loader.clearDimsFor() 按「文件夹名前缀」清尺寸缓存 —— 同名来源会互相误伤。
       这里锁住「只清指定前缀」的行为。

   运行： node test/loader-index.test.js
   ============================================================ */
'use strict';

const H = require('./_harness.js');
const A = H.makeAsserts();

H.useGlobalAsWindow();
globalThis.localStorage = H.makeLocalStorage();
globalThis.innerHeight = 900;
globalThis.addEventListener = () => {};
globalThis.CSS = { supports: () => false };
H.loadScript('js/util.js');
H.loadScript('js/state.js');
H.loadScript('js/loader.js');

const Loader = globalThis.Loader;
const Util = globalThis.Util;

/* ============================================================
   D. 大文件不能被 32 位位运算截断
   ============================================================ */
function testBigSize() {
  const cases = [
    { size: 3_000_000_000, label: '3GB' },        // 3e9 | 0 === -1294967296
    { size: 5_000_000_000, label: '5GB' },        // 5e9 | 0 ===  705032704
    { size: 2_147_483_648, label: '2GiB' },       // 2^31 | 0 === -2147483648
    { size: 12_345, label: '12KB' },              // 小文件：回归锁
  ];
  for (const c of cases) {
    const [m] = Loader.buildEntries([{
      name: 'big.tif', rel: 'big.tif', size: c.size, mtime: 1700000000000, path: 'D:\\p\\big.tif',
    }], 'p');
    A.eq('D1 ' + c.label + ' 大小未被截断', m && m.size, c.size);
    A.ok('D1 ' + c.label + ' 大小为正数', !!m && m.size > 0, String(m && m.size));
    A.ok('D1 ' + c.label + ' 条目 id 里带的是真实大小',
      !!m && m.id.indexOf('│' + c.size + '│') > 0, m && m.id);
    A.ok('D1 ' + c.label + ' 大小可正常展示', !!m && Util.fmtBytes(m.size) !== '', Util.fmtBytes(m && m.size));
  }

  /* 同一张图两次索引必须得到同一个 id（缓存命中的前提） */
  const mk = () => Loader.buildEntries([{
    name: 'big.tif', rel: 'big.tif', size: 3_000_000_000, mtime: 1700000000000, path: 'D:\\p\\big.tif',
  }], 'p')[0];
  A.eq('D2 两次索引的 id 稳定', mk().id, mk().id);
}

/* ============================================================
   D'. 尺寸缓存按前缀清理，不能误伤同名来源
   ============================================================ */
async function testDimsPrefix() {
  const mkMeta = (folder, rel) => {
    const [m] = Loader.buildEntries([{ name: rel, rel, size: 10, mtime: 1, path: 'D:\\x\\' + rel }], folder);
    return m;
  };
  const a = mkMeta('2024', 'a.jpg');
  const b = mkMeta('2024·d41d8cd9', 'b.jpg');
  Loader.recordDims(a, 100, 50);
  Loader.recordDims(b, 200, 100);

  await Loader.clearDimsFor('2024·d41d8cd9');
  const left = await Loader._loadDimsFor([a, b]);
  A.ok('D3 只清掉指定前缀的尺寸缓存', left.has(a.id) && !left.has(b.id),
    '剩余：' + Array.from(left.keys()).join(','));
}

/* ============================================================
   D''. 条目去重与图片扩展名过滤（回归锁）
   ============================================================ */
function testDedupe() {
  const list = Loader.buildEntries([
    { name: 'a.jpg', rel: 'a.jpg', size: 100, mtime: 1, path: 'D:\\p\\a.jpg' },
    { name: 'a.jpg', rel: 'a.jpg', size: 200, mtime: 1, path: 'D:\\p\\a.jpg' },
  ], 'p');
  A.eq('D4 同 rel 只保留一份', list.length, 1);
  A.eq('D4 保留的是更大的那份', list[0].size, 200);
}

(async () => {
  testBigSize();
  await testDimsPrefix();
  testDedupe();
  process.exit(A.finish('索引器与尺寸缓存（D）') ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
