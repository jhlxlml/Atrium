/* ============================================================
   Atrium · vf://pic 读盘授权（纯 Node，不需要 Electron）
   ------------------------------------------------------------
   这道检查守的是"渲染层能不能读任意文件"。它**写松了不会报错**，
   只会安静地多放行一个文件 —— 所以重点全在**反向用例**：
   一串必须被拒的路径。只测"C:\Pics\a.png 在 C:\Pics 之下能过"
   等于恒真的门禁。

   尤其要盯住的三种绕过方式：
     1. `..` 折叠 —— `C:\Pics\..\..\Windows\System32\config\SAM`
        字面上以 `C:\Pics` 开头，不折叠就会放行；
     2. 前缀无边界 —— `C:\Pics2\a.png` 以 `C:\Pics` 开头，必须拒；
     3. 大小写 / 分隔符混用 —— Windows 上 `c:/PICS/A.PNG` 就是同一个文件。

   运行： node test/pathauth.test.js
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const A = require(path.join(__dirname, '..', 'deploy', 'electron', 'pathauth.js'));

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

const ROOT = 'C:\\Users\\me\\Pictures';
const PIC = 'C:\\Users\\me\\Pictures\\2024\\a.png';

/* ============================================================
   1) normPath —— 归一化是判定的地基
   ============================================================ */
eq('反斜杠转正斜杠并小写', A.normPath(ROOT), 'c:/users/me/pictures');
eq('正斜杠输入等价', A.normPath('C:/Users/Me/Pictures'), 'c:/users/me/pictures');
eq('大小写混用等价', A.normPath('c:\\USERS\\me\\PICTURES'), 'c:/users/me/pictures');
eq('折叠 . 与 ..', A.normPath('C:\\Users\\me\\Pictures\\..\\Documents'), 'c:/users/me/documents');
eq('折叠多余的 .\\', A.normPath('C:\\Users\\me\\.\\Pictures'), 'c:/users/me/pictures');
eq('盘符根保留结尾斜杠', A.normPath('C:\\'), 'c:/');
eq('空串 → 空串', A.normPath(''), '');
eq('null → 空串', A.normPath(null), '');
eq('非字符串 → 空串', A.normPath(12345), '');

/* ============================================================
   2) isUnder —— 正向
   ============================================================ */
ok('直接子文件在根之下', A.isUnder(PIC, ROOT));
ok('深层子文件在根之下', A.isUnder('C:\\Users\\me\\Pictures\\a\\b\\c\\d.png', ROOT));
ok('根自身算"在之下"（用于目录比对）', A.isUnder(ROOT, ROOT));
ok('大小写不同仍算在之下', A.isUnder('c:\\users\\ME\\pictures\\a.png', ROOT));
ok('分隔符混用仍算在之下', A.isUnder('C:/Users/me/Pictures/2024/a.png', ROOT));
ok('盘符根放行它下面的一切', A.isUnder('C:\\Windows\\System32\\x.dll', 'C:\\'));

/* ============================================================
   3) isUnder —— 反向（这一段的每一条都必须被拒）
   ============================================================ */
ok('反向：前缀相同但不是子目录（Pics2）必须拒',
  !A.isUnder('C:\\Users\\me\\Pictures2\\a.png', ROOT));
ok('反向：.. 折叠后跳出根目录必须拒',
  !A.isUnder('C:\\Users\\me\\Pictures\\..\\..\\.ssh\\id_rsa', ROOT));
ok('反向：.. 折叠到盘符根必须拒',
  !A.isUnder('C:\\Users\\me\\Pictures\\..\\..\\..\\Windows\\x.dll', ROOT));
ok('反向：完全不相干的盘必须拒', !A.isUnder('D:\\Pictures\\a.png', ROOT));
ok('反向：父目录必须拒（方向不能反）', !A.isUnder('C:\\Users\\me', ROOT));
ok('反向：根为空串时必须拒', !A.isUnder(PIC, ''));
ok('反向：路径为空串时必须拒', !A.isUnder('', ROOT));
ok('反向：UNC 路径与本地盘不同源必须拒',
  !A.isUnder('\\\\server\\share\\a.png', ROOT));
ok('反向：只差一个尾部分隔符不算子目录（C:\\Users\\me\\Pictures 与 ...\\Pictures\\ 等价，这里测边界）',
  !A.isUnder('C:\\Users\\me\\PicturesX', ROOT));

/* ============================================================
   4) 授权清单：默认拒绝，登记之后才放行
   ============================================================ */
{
  const al = A.createAllowlist();
  ok('空清单：任何路径都拒（默认拒绝）', !al.has(PIC));
  eq('空清单 size 为 0', al.size, 0);

  al.add(ROOT);
  ok('登记根目录后，子文件放行', al.has(PIC));
  ok('登记根目录后，根自身放行', al.has(ROOT));
  ok('登记后，根之外的路径仍然拒', !al.has('C:\\Windows\\System32\\config\\SAM'));
  ok('登记后，.. 跳出根仍然拒', !al.has('C:\\Users\\me\\Pictures\\..\\..\\.ssh\\id_rsa'));
  eq('清单里只有一条', al.size, 1);

  al.add('C:\\Users\\me\\Documents');
  eq('登记第二个根', al.size, 2);
  ok('第二个根里的文件放行', al.has('C:\\Users\\me\\Documents\\b.png'));
  ok('第一个根仍然放行', al.has(PIC));

  al.add('c:/users/ME/pictures/');   // 归一化后同一条
  eq('重复登记同一个根是幂等的（归一化后去重）', al.size, 2);

  al.clear();
  eq('clear 之后清单为空', al.size, 0);
  ok('clear 之后又回到默认拒绝', !al.has(PIC));
}
{
  const al = A.createAllowlist();
  al.add('');
  al.add(null);
  al.add(123);
  eq('非法根目录不会被登记（空清单）', al.size, 0);
}

/* ============================================================
   4b) 目录授权闸门（vf:loadDir 的入口）
   ------------------------------------------------------------
   背景：`vf:loadDir` 原来**无条件**把渲染层传来的路径登记进 picAuth。
   于是「读任意文件」那道口子并没有真的关上 —— 只要先 invoke 一次
   loadDir('C:\\Users\\me')，整个用户目录就变成合法根目录。
   现在的语义是：只有**原生目录对话框**（pickFolder）或**我们自己持久化的
   上次目录**（autoDir）能授予，loadDir 本身只做校验、不授予。

   下面这组用例分「允许」与「拒绝」两类，拒绝的那一类是重点。
   ============================================================ */
{
  /* 没有这个 API 就直接记红，但不要中断整套用例（后面的接线断言还要跑） */
  const hasApi = typeof A.createDirTrust === 'function';
  ok('pathauth 提供目录授权闸门 createDirTrust', hasApi);
  const trust = hasApi ? A.createDirTrust() : null;
  const T = trust || { canOpen: () => false, grant: () => '', roots: () => [], clear() {} };

  /* --- 拒绝（默认拒绝） --- */
  ok('未授权：空清单时任意路径都不能打开', !T.canOpen('C:\\Users\\me\\Pictures'));
  ok('未授权：空串不能打开', !T.canOpen(''));
  ok('未授权：null 不能打开', !T.canOpen(null));
  ok('未授权：数字不能打开', !T.canOpen(12345));

  /* --- 允许（对话框真的选过之后） --- */
  const g = T.grant('C:\\Users\\me\\Pictures');
  ok('授权：对话框选过的目录可以打开', T.canOpen('C:\\Users\\me\\Pictures'));
  ok('授权：授权目录的子目录可以打开（列目录要递归）',
    T.canOpen('C:\\Users\\me\\Pictures\\2024'));
  ok('授权：大小写/分隔符变体仍可打开',
    T.canOpen('c:/users/ME/pictures/2024'));

  /* --- 拒绝（授权范围之外的边界） --- */
  ok('拒绝：同前缀的兄弟目录（Pictures2）不能打开',
    !T.canOpen('C:\\Users\\me\\Pictures2'));
  ok('拒绝：父目录不能打开（授权不能向上溢出）',
    !T.canOpen('C:\\Users\\me'));
  ok('拒绝：.. 跳出授权根不能打开',
    !T.canOpen('C:\\Users\\me\\Pictures\\..\\..\\.ssh'));
  ok('拒绝：盘符根不能打开', !T.canOpen('C:\\'));
  ok('拒绝：另一块盘不能打开', !T.canOpen('D:\\Pictures'));

  /* --- 真实路径校验：符号链接 / 目录联接点 --- */
  ok('拒绝：真实路径跳出授权根（目录联接点指向别处）',
    !T.canOpen('C:\\Users\\me\\Pictures\\link\\secret.txt', 'C:\\Windows\\System32\\secret.txt'));
  ok('允许：真实路径仍在授权根内',
    T.canOpen('C:\\Users\\me\\Pictures\\a.png', 'C:\\Users\\me\\Pictures\\a.png'));
  ok('拒绝：解析不出真实路径时按拒绝处理（fail-closed）',
    !T.canOpen('C:\\Users\\me\\Pictures\\a.png', null));

  /* 授权根本身就是一个联接点：原始路径与真实路径都要登记 */
  const t2 = hasApi ? A.createDirTrust() : { grant() {}, canOpen: () => false, roots: () => [] };
  t2.grant('C:\\Junction\\Pics', 'D:\\data\\Pics');
  ok('允许：授权根是联接点时，其真实路径下的文件可打开',
    t2.canOpen('C:\\Junction\\Pics\\a.png', 'D:\\data\\Pics\\a.png'));
  ok('拒绝：联接点根不会顺带授权真实路径的父目录',
    !t2.canOpen('C:\\Junction\\Pics\\a.png', 'D:\\data\\secret.png'));
  eq('授权根登记了原始与真实两条', t2.roots().length, 2);

  /* 撤销：loadDir 不授予，所以授权只能靠对话框；clear 之后回到默认拒绝 */
  T.clear();
  ok('clear 之后又回到默认拒绝', !T.canOpen('C:\\Users\\me\\Pictures'));
  void g;
}

/* ============================================================
   4c) 真实文件系统上的联接点（Windows only，做不到就跳过）
   ------------------------------------------------------------
   上面那条是"注入一个假的真实路径"。这一段用**真的目录联接点**验证
   fs.realpath 确实会把它解析出去 —— 否则上面的用例只是自证。
   ============================================================ */
{
  const os = require('os');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-link-'));
  const outside = path.join(base, 'outside');
  const inside = path.join(base, 'inside');
  let made = false;
  try {
    fs.mkdirSync(outside); fs.mkdirSync(inside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
    fs.symlinkSync(outside, path.join(inside, 'link'), 'junction');
    made = true;
  } catch (e) { /* 没有建联接点的权限 → 跳过，不假装通过 */ }

  if (made) {
    const t = typeof A.createDirTrust === 'function'
      ? A.createDirTrust()
      : { grant() {}, canOpen: () => false };
    t.grant(inside);
    const rawPath = path.join(inside, 'link', 'secret.txt');
    const realPath = fs.realpathSync(rawPath);
    ok('联接点用例：原始路径确实在授权根之下', A.isUnder(rawPath, inside));
    ok('联接点用例：真实路径确实跳出了授权根', !A.isUnder(realPath, inside),
      realPath);
    ok('拒绝：经目录联接点读授权根之外的文件', !t.canOpen(rawPath, realPath));

    const own = path.join(inside, 'own.txt');
    fs.writeFileSync(own, 'y');
    ok('允许：授权根内的普通文件照常可读', t.canOpen(own, fs.realpathSync(own)));
  } else {
    ok('联接点用例：跳过（本机无法创建目录联接点）', true, 'skipped');
  }
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}

/* ============================================================
   5) 源级接线：main.js 的 vf://pic 真的走这套判定
   ============================================================ */
{
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'electron', 'main.js'), 'utf8');
  ok('main.js 引入了 pathauth',
    mainSrc.indexOf("require('./pathauth.js')") >= 0);
  ok('vf://pic 在处理请求前先问授权清单',
    /if \(!picAuth\.has\(abs\)\)/.test(mainSrc));
  ok('授权检查在 stat 之前（不靠文件存不存在泄露信息）',
    mainSrc.indexOf('if (!picAuth.has(abs))') < mainSrc.indexOf('const st = await fs.stat(abs); if (!st.isFile())'));
  ok('唯一的授权入口是 vf:loadDir（与"用户打开过这个目录"对应）',
    (mainSrc.match(/picAuth\.add\(/g) || []).length === 1
      && /picAuth\.add\(dir\)/.test(mainSrc));
  ok('Access-Control-Allow-Origin 不再是 *',
    mainSrc.indexOf("h.set('Access-Control-Allow-Origin', '*')") < 0
      && mainSrc.indexOf("h.set('Access-Control-Allow-Origin', 'vf://app')") >= 0);
  ok('readHead 也按同一份清单放行（否则它还是任意文件读取）',
    /ipcMain\.handle\('vf:readHead'[\s\S]{0,200}picAuth\.has\(p\)/.test(mainSrc));
  ok('pathauth.js 不依赖 electron（必须能被 Node 直接 require）',
    require(path.join(__dirname, '..', 'deploy', 'electron', 'pathauth.js')) === A);
}

/* ============================================================
   汇总
   ============================================================ */
console.log('');
console.log('vf://pic 授权：' + pass + ' 项通过，' + fail + ' 项失败');
if (fail) {
  console.log('');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
