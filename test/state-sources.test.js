/* ============================================================
   Atrium · 来源（多文件夹）与收藏归属的回归测试（纯 Node）
   ------------------------------------------------------------
   E. State.commitSource() 原先按「文件夹名」认来源：两个不同绝对路径的同名
      目录（D:\照片\2024 与 E:\备份\2024）会被当成同一个来源，
      后打开的会把前一个的条目整批清掉 —— 用户看到"打开第二个文件夹，
      第一个就消失了"。而且条目 id 也只看文件夹名，两边的收藏/尺寸缓存
      会串在一起。
   F. State.removeSource() 清收藏时用的前缀是来源 id（'f1│'），而条目 id
      的前缀是文件夹名（'照片│'）—— 前缀永远不匹配，收藏一条都清不掉。
      修的时候又不能简单改成「按名字前缀清」：同名来源会把别人的收藏一起删。

   运行： node test/state-sources.test.js
   ============================================================ */
'use strict';

const H = require('./_harness.js');
const A = H.makeAsserts();

/* ---------- 装载 state.js（浏览器 IIFE） ---------- */
H.useGlobalAsWindow();
globalThis.localStorage = H.makeLocalStorage();
globalThis.innerHeight = 900;
globalThis.addEventListener = () => {};
globalThis.CSS = { supports: () => false };
H.loadScript('js/util.js');
H.loadScript('js/state.js');
const State = globalThis.State;
const Util = globalThis.Util;

/** 造一批条目（模拟 Loader.buildEntries 的产物） */
function entries(folder, rels) {
  return rels.map((rel, k) => ({
    id: Util.itemId(folder, rel, 1000 + k, 1700000000000 + k),
    name: rel.split('/').pop(),
    rel,
    ext: 'jpg',
    size: 1000 + k,
    lastModified: 1700000000000 + k,
    path: null,
    bad: false,
    state: 'idle',
    w: 0, h: 0,
  }));
}

/* ============================================================
   E. 同名不同路径的来源必须能并存
   ============================================================ */
function testSameNameDifferentDir() {
  const a = entries('2024', ['a.jpg', 'b.jpg']);
  const srcA = State.commitSource('2024', a, 'D:\\照片\\2024');
  A.ok('E1 第一次提交创建了来源', !!srcA && typeof srcA.id === 'string');

  const b = entries('2024', ['c.jpg']);
  const srcB = State.commitSource('2024', b, 'E:\\备份\\2024');

  A.eq('E2 两个同名目录产生两个来源', State.sources.length, 2);
  A.ok('E2 两个来源 id 不同', srcA.id !== srcB.id, srcA.id + ' vs ' + srcB.id);
  A.eq('E3 两个来源的条目都在图库里', State.items.length, 3);
  A.eq('E3 第一个来源条目数没被清掉', State.sourceCount(srcA.id), 2);
  A.eq('E3 第二个来源条目数正确', State.sourceCount(srcB.id), 1);

  const ids = State.items.map((it) => it.id);
  A.eq('E4 三张图的条目 id 互不相同', new Set(ids).size, 3);

  /* 兼容性：第一个「占用这个名字」的来源必须保留旧的 id 前缀（'2024│…'），
     否则升级后老用户的收藏、尺寸缓存、缩略图缓存会整批失配。 */
  A.ok('E5 首个同名来源的条目 id 仍是旧格式', String(ids[0] || '').indexOf('2024│') === 0, String(ids[0]));
  A.ok('E5 第二个同名来源的条目 id 带路径区分', String(ids[2] || '').indexOf('2024│') !== 0, String(ids[2]));

  /* 同名目录「重新载入」应替换自己、且只替换自己 */
  const a2 = entries('2024', ['a.jpg', 'b.jpg', 'd.jpg']);
  const srcA2 = State.commitSource('2024', a2, 'D:\\照片\\2024');
  A.eq('E6 刷新同一个目录不会新建来源', State.sources.length, 2);
  A.eq('E6 刷新沿用原来的来源 id', srcA2.id, srcA.id);
  A.eq('E6 刷新后该来源条目数为 3', State.sourceCount(srcA.id), 3);
  A.eq('E6 另一个同名来源不受影响', State.sourceCount(srcB.id), 1);
  A.eq('E6 全库条目数正确', State.items.length, 4);
}

/* ============================================================
   E'. 没有 dir 的老路径（拖拽 / 内存 File）仍按名字合并
   ============================================================ */
function testNoDirStillMerges() {
  const before = State.sources.length;
  const s1 = State.commitSource('拖入的图片', entries('拖入的图片', ['x.jpg']));
  const s2 = State.commitSource('拖入的图片', entries('拖入的图片', ['y.jpg']));
  A.eq('E7 无 dir 的同名来源仍然合并', s1.id, s2.id);
  A.eq('E7 来源数量没有增加', State.sources.length, before + 1);
  A.eq('E7 条目被替换而不是累加', State.sourceCount(s1.id), 1);
}

/* ============================================================
   F. 移除来源必须清掉它自己的收藏，且不能误伤同名来源
   ============================================================ */
function testRemoveSourceFavs() {
  /* 清场：把前面测试造出来的来源都移除，避免互相干扰 */
  for (const s of State.sources.slice()) State.removeSource(s.id);
  State.items.length = 0;
  State.clearFavs();

  /* F0：最朴素的场景 —— 一个来源、一张收藏，移除来源后收藏必须消失。
     这里刻意不涉及同名，单独把「前缀对不上」这条钉死。 */
  const solo = State.commitSource('独苗', entries('独苗', ['solo.jpg']), 'D:\\S\\独苗');
  const soloItem = State.activeItems().find((x) => x.sid === solo.id);
  A.ok('F0 独苗条目存在', !!soloItem);
  if (soloItem) {
    State.toggleFav(soloItem.id);
    A.ok('F0 收藏成功', State.isFav(soloItem.id));
    State.removeSource(solo.id);
    A.ok('F0 移除来源后它的收藏被清掉', !State.isFav(soloItem.id),
      '残留：' + soloItem.id);
  }

  const a = entries('照片', ['a.jpg', 'b.jpg']);
  const srcA = State.commitSource('照片', a, 'D:\\A\\照片');
  const b = entries('照片', ['c.jpg']);
  const srcB = State.commitSource('照片', b, 'E:\\B\\照片');

  for (const it of State.items) State.toggleFav(it.id);
  A.eq('F1 三张图都收藏了', State.favs.size, 3);

  State.removeSource(srcA.id);
  A.eq('F2 被移除来源的收藏已清理', Array.from(State.favs).filter((k) => k.indexOf('a.jpg') >= 0 || k.indexOf('b.jpg') >= 0).length, 0);
  A.eq('F3 同名来源的收藏没有被误删', Array.from(State.favs).filter((k) => k.indexOf('c.jpg') >= 0).length, 1);
  A.eq('F3 收藏总数只剩 1', State.favs.size, 1);
  A.eq('F4 同名来源本身还在', State.sources.length, 1);
  A.eq('F4 同名来源的条目还在', State.sourceCount(srcB.id), 1);
}

/* ============================================================
   F'. 单条删除 / 撤销 与收藏的一致性（回归锁）
   ============================================================ */
function testRemoveItemFav() {
  const src = State.commitSource('单条删除', entries('单条删除', ['z.jpg']), 'D:\\Z\\单条删除');
  const it = State.activeItems().find((x) => x.sid === src.id);
  A.ok('F5 有可用的条目', !!it);
  if (!it) return;
  State.toggleFav(it.id);
  A.ok('F5 收藏成功', State.isFav(it.id));
  State.removeItem(it);
  A.ok('F5 删除条目会清掉它的收藏', !State.isFav(it.id));
  A.eq('F5 来源计数同步', State.sourceCount(src.id), 0);
}

/* ============================================================ */
testSameNameDifferentDir();
testNoDirStillMerges();
testRemoveSourceFavs();
testRemoveItemFav();
process.exit(A.finish('来源与收藏归属（E/F）') ? 0 : 1);
