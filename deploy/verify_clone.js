/* ============================================================
   Atrium · verify_clone.js —— 「新克隆能不能跑起来」的门禁
   ------------------------------------------------------------
   为什么需要它：本仓库的 `.gitignore` 排除了依赖 / 构建产物 / 日志 / 编辑器配置
   等等。规则一旦改坏（把源码目录里的某个文件顺手忽略掉），**本机一切照常** ——
   因为文件还在磁盘上；只有"从零克隆"的人才会撞上，而且症状是构建报错或产物缺文件，
   排查方向还容易跑偏。

   两种模式：

   1) 默认（快，几百毫秒）—— **静态清单检查**：
      遍历源码树，逐个问 git「这个文件被忽略了吗」。凡是构建/运行需要的文件
      都必须**既在版本控制里、又不被忽略**；被忽略的必须**恰好等于**一张白名单
      （见 IGNORE_OK）。白名单之外的任何新命中都会让这条门禁变红。

   2) `--full`（慢，几分钟）—— **端到端**：
      真的 `git clone` 一份到临时目录 → 把 `node_modules` 镜像过去（依赖不入库，
      新克隆本来就要 `npm i`，这里用镜像代替联网安装）→ 在克隆里跑
      `deploy/electron/assemble.js` → 比对产出的 `Atrium.exe` 与本仓库的 MD5
      **必须完全相同**。不同就说明克隆里少了东西（或多了脏东西）。

   用法：
     node deploy/verify_clone.js            # 静态检查
     node deploy/verify_clone.js --full     # 端到端（会真的构建一次）
   ============================================================ */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/* spawnSync 的默认 stdio 会给 stdin 建管道，本机沙箱拒绝（EBUSY，连 cmd.exe
   都起不来）。子进程（git / robocopy / node）没有一个需要 stdin。 */
const { spawnSync: rawSpawnSync } = require('child_process');
const spawnSync = function (cmd, args, opts) {
  return rawSpawnSync(cmd, args, Object.assign({ stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }, opts || {}));
};

const ROOT = path.resolve(__dirname, '..');
const FULL = process.argv.indexOf('--full') >= 0;

/* 遍历时**不进**这些目录：要么不是源码（依赖 / 产物 / 运行期日志），
   要么本来就整体忽略（`.workbuddy/` 是本机工具状态，不是项目内容）。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.stage', '.workbuddy',
  'dist', 'dist-electron', 'logs', 'shots']);

/* 允许被忽略的文件（相对仓库根，POSIX 分隔符）。凡不在这张表里的命中都是**意外**。
   每一项都要能说出"为什么忽略它不会影响构建/运行"。
   `mustHit: true` 表示"当前工作区里就该有这种文件"——用来验证忽略机制真的在工作
   （而不是把所有规则都写成了永不命中、门禁恒真）。防御性规则（OS/编辑器杂物）
   在当前机器上本来就可能一个都不存在，故不设 mustHit。 */
const IGNORE_OK = [
  // 发布包：不是源码，删了不影响任何东西（重新打包即可）
  { mustHit: true, test: (p) => /^[^/]+\.zip$/.test(p), why: '根目录发布 ZIP（构建产物）' },
  // 设计探索稿：候选命名页用的位图，`brand/` 里的矢量源与 icon.ico 才是必需的
  { mustHit: true, test: (p) => /^brand\/cand-.*\.png$/.test(p), why: '品牌候选稿（探索用，非构建输入）' },
  // 本机调试残留
  { test: (p) => /^deploy\/logs-.*\.txt$/.test(p), why: '本机一次性调试转储' },
  // OS / 编辑器杂物
  { test: (p) => /(^|\/)(\.DS_Store|Thumbs\.db|Desktop\.ini)$/.test(p), why: 'OS 杂物' },
  { test: (p) => /(^|\/)\.vscode\//.test(p) || /(^|\/)\.idea\//.test(p), why: '编辑器配置' },
];

/* 构建/运行**必需**的关键路径。静态检查之外再加一道点名，防止
   "白名单恰好把某个必需文件也放行了"这种自欺。 */
const REQUIRED = [
  'index.html', 'package.json',
  'js/app.js', 'js/state.js', 'js/loader.js', 'js/settings.js', 'js/native.js',
  'js/util.js', 'js/grid.js', 'js/lightbox.js', 'js/frame.js', 'js/thumb.js',
  'js/exif.js', 'js/trash.js', 'js/masonry.js', 'js/transform.js', 'js/a11y.js',
  'css/main.css', 'css/lightbox.css', 'css/frame.css',
  'deploy/electron/main.js', 'deploy/electron/preload.js', 'deploy/electron/desktop.js',
  'deploy/electron/desktop-spec.js', 'deploy/electron/exportlib.js',
  'deploy/electron/assemble.js', 'deploy/electron/launcher.cmd',
  'deploy/electron/package.json', 'deploy/pack.js', 'deploy/verify_zip.js',
  'deploy/make_icons.js', 'deploy/verify_icon.js', 'deploy/clean.js',
  'deploy/electron-test/run_all.js', 'deploy/electron-test/run_probe.js',
  'deploy/electron-test/zip_gate.js', 'deploy/electron-test/icon_gate.js',
  'deploy/release/RELEASE.md',
  // 图标资产由 make_icons.js 生成，但 assemble.js 需要它、重新生成要 Electron 工具链
  // → 属于**源码**，必须入库
  'brand/icon.ico',
  // 回归夹具（图片）——产物自检与探针都依赖它们
  'deploy/electron-test/fixtures/照片夹/山景-01.png',
  'deploy/electron-test/fixtures/照片夹/子集/子集-A.png',
];

const fails = [];
function ok(name, cond, detail) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond || !detail ? '' : '  → ' + detail));
  if (!cond) fails.push(name + (detail ? ' → ' + detail : ''));
}

/** git 子命令（在仓库根执行）。
 *  - 一律关掉 core.quotepath：本仓库有中文路径（夹具 / 产物名），
 *    默认会把它们转义成 `"…\345\233\276…"`，于是所有字符串比对全部落空；
 *  - **不要用 `--stdin` + `input`**：本机沙箱拒绝给 stdin 建管道（spawnSync EBUSY），
 *    传了 input 也送不进去（`stdio[0]='ignore'` 时直接丢，改成 'pipe' 又起不来）。
 *    改用"把路径当参数传给 git"，一次调用即可，完全绕开 stdin。 */
function git(args) {
  const r = spawnSync('git', ['-c', 'core.quotepath=false'].concat(args), { cwd: ROOT });
  return { code: r.status, out: (r.stdout || '').replace(/\s+$/, ''), err: (r.stderr || '').replace(/\s+$/, '') };
}

/** 收集源码树里的全部文件（相对路径，POSIX 分隔符） */
function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    let st;
    try { st = fs.lstatSync(abs); } catch (e) { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(abs, out);
    } else if (st.isFile()) {
      out.push(path.relative(ROOT, abs).replace(/\\/g, '/'));
    }
  }
  return out;
}

/* ------------------------------------------------------------
   模式 1：静态清单检查
   ------------------------------------------------------------ */
function staticCheck() {
  console.log('');
  console.log('Atrium · 新克隆可构建性（静态清单检查）');
  console.log('='.repeat(78));

  const files = walk(ROOT, []);
  ok('源码树遍历到了文件', files.length > 50, 'walk 得到 ' + files.length + ' 个文件');

  /* 一次把全部路径交给 git check-ignore（当参数传，不走 stdin）。
     注意退出码：**1 = 没有任何路径被忽略**，那是正常结果，不是错误。 */
  const r = git(['check-ignore'].concat(files));
  const ignored = r.out ? r.out.split('\n').filter(Boolean).map((p) => p.replace(/\\/g, '/')) : [];

  const unexpected = ignored.filter((p) => !IGNORE_OK.some((e) => e.test(p)));
  ok('被忽略的文件都落在白名单内（没有源码被顺手忽略）',
    unexpected.length === 0,
    '意外忽略=' + JSON.stringify(unexpected));

  /* 反向：必须有命中的规则**至少要命中一次**，否则它是死规则 ——
     死规则的危险在于会让上面那条恒真（一条 `*` 规则就能让"没有意外忽略"永远成立）。
     防御性规则（OS / 编辑器杂物）在当前机器上可能一个都不存在，故不参与这一检查。 */
  const dead = IGNORE_OK.filter((e) => e.mustHit && !ignored.some((p) => e.test(p)));
  ok('必须有命中的白名单规则都命中了（忽略机制真的在工作）',
    dead.length === 0,
    '未命中=' + JSON.stringify(dead.map((e) => e.why)));

  /* 忽略集合有界：白名单没有退化成"什么都放行"。 */
  ok('忽略集合有界（白名单没变成 catch-all）', ignored.length <= 30,
    '被忽略 ' + ignored.length + ' 个');

  /* 点名必需文件：既没被忽略，也确实在版本控制里。 */
  const tracked = new Set(git(['ls-files']).out.split('\n').filter(Boolean).map((p) => p.replace(/\\/g, '/')));
  const missing = REQUIRED.filter((p) => !fs.existsSync(path.join(ROOT, p)));
  const notTracked = REQUIRED.filter((p) => !tracked.has(p));
  ok('关键构建输入都存在', missing.length === 0, '缺失=' + JSON.stringify(missing));
  ok('关键构建输入都已入库（新克隆里不会缺文件）',
    notTracked.length === 0, '未入库=' + JSON.stringify(notTracked));

  console.log('');
  console.log('  遍历文件数 : ' + files.length);
  console.log('  已入库     : ' + tracked.size);
  console.log('  被忽略     : ' + ignored.length + '（全部在白名单内）');
  ignored.forEach((p) => console.log('      · ' + p));
  console.log('='.repeat(78));
}

/* ------------------------------------------------------------
   模式 2：端到端（真克隆 → 镜像依赖 → 真构建 → 比对 exe）
   ------------------------------------------------------------ */
function md5(p) {
  return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
}

function rmTree(p) {
  /* 刻意用 rmdirSync：本机的 fs.rmSync/unlinkSync 被垫片劫持到回收站，
     大目录会失败（且 D 盘回收站不可用）。rmdirSync 没被劫持。 */
  try { fs.rmdirSync(p, { recursive: true }); } catch (e) { /* 忽略 */ }
}

function fullCheck() {
  console.log('');
  console.log('Atrium · 新克隆可构建性（端到端：克隆 → 依赖 → 构建 → 比对 exe）');
  console.log('='.repeat(78));

  const tmp = path.join(os.tmpdir(), 'atrium-clone-' + Date.now());
  const exeRel = path.join('deploy', 'dist-electron', 'Atrium_Electron版', 'Atrium.exe');
  try {
    const c = git(['clone', '--quiet', ROOT, tmp]);
    ok('git clone 成功', c.code === 0 && fs.existsSync(path.join(tmp, 'package.json')),
      c.err || ('code=' + c.code));

    /* 依赖不入库（`.gitignore` 里就有 node_modules/）——新克隆要 `npm i`。
       这里用 robocopy /MIR 镜像代替联网安装，避免每次门禁都拉一遍 Electron。
       **不用 junction**：删临时目录时会顺着链接递归删掉原始依赖（真踩过）。 */
    const srcNm = path.join(ROOT, 'deploy', 'electron', 'node_modules');
    const dstNm = path.join(tmp, 'deploy', 'electron', 'node_modules');
    const rc = spawnSync('robocopy', [srcNm, dstNm, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1']);
    ok('依赖镜像到克隆（代替 npm i）', rc.status < 8, 'robocopy status=' + rc.status);

    const b = spawnSync(process.execPath, [path.join(tmp, 'deploy', 'electron', 'assemble.js')], { cwd: tmp });
    ok('克隆里构建成功（assemble.js 退出码 0）', b.status === 0,
      'code=' + b.status + ' | ' + String(b.stderr || '').split('\n').slice(-3).join(' / '));

    const a = path.join(ROOT, exeRel), e = path.join(tmp, exeRel);
    const hasBoth = fs.existsSync(a) && fs.existsSync(e);
    ok('两侧都产出了 Atrium.exe', hasBoth, JSON.stringify({ repo: fs.existsSync(a), clone: fs.existsSync(e) }));
    if (hasBoth) {
      const ma = md5(a), me = md5(e);
      ok('克隆产出的 exe 与本仓库**逐字节相同**', ma === me, 'repo=' + ma + ' clone=' + me);
    }
  } finally {
    rmTree(tmp);
  }
  console.log('='.repeat(78));
}

if (FULL) fullCheck(); else staticCheck();

if (fails.length) {
  console.log('');
  console.log('失败 ' + fails.length + ' 项：');
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('全部通过。');
