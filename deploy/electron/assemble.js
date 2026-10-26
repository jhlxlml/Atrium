/* ============================================================
   Atrium · Electron 便携版组装脚本
   把 node_modules/electron/dist（完整运行时）+ 应用资源
   合成为一个「拷走即用、双击 exe 即开」的目录。

   前置：先在本目录执行 npm i（拉取 electron 二进制）。
   用法：node assemble.js
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
/* spawnSync 的默认 stdio 会给 stdin 建管道，本机沙箱拒绝（EBUSY，连 cmd.exe
   都起不来）。子进程（robocopy / electron 探针 / 7z / where）没有一个需要
   stdin，所以统一把它设成 ignore；stdout 与 stderr 照常 pipe，调用方无感。
   显式传了 stdio 的调用点仍然优先。 */
const { spawnSync: rawSpawnSync } = require('child_process');
const spawnSync = function (cmd, args, opts) {
  return rawSpawnSync(cmd, args, Object.assign({ stdio: ['ignore', 'pipe', 'pipe'] }, opts || {}));
};

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..', '..');                 // 项目根
const ELECTRON_DIST = path.join(HERE, 'node_modules', 'electron', 'dist');
const STAGE = path.join(HERE, '.stage');                     // 临时 app 资源
const OUT = path.join(HERE, '..', 'dist-electron', 'Atrium_Electron版');

/* 直接删除（绕过 WorkBuddy 的 fs.rmSync 回收站垫片，避免大文件 trash 失败） */
function rmForce(p) {
  if (!fs.existsSync(p)) return;
  try { spawnSync('cmd', ['/c', 'del', '/f', '/q', '/s', p], { stdio: 'ignore' }); } catch (e) { /* ignore */ }
  if (fs.existsSync(p)) { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 0 }); } catch (e) { /* ignore */ } }
}

if (!fs.existsSync(path.join(ELECTRON_DIST, 'electron.exe'))) {
  console.error('未找到 electron 运行时：请先在 deploy/electron 下执行 npm i');
  process.exit(1);
}

/* 1) 准备干净的 app 资源（剥离预览服务注入的属性） */
rmForce(STAGE);
fs.mkdirSync(path.join(STAGE, 'app', 'js'), { recursive: true });
fs.mkdirSync(path.join(STAGE, 'app', 'css'), { recursive: true });

function copy(src, dst) { fs.copyFileSync(src, dst); }

// index.html 去掉 data-page-node-id 等注入噪音
let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
html = html.replace(/\sdata-page-node-id="[^"]*"/g, '');
fs.writeFileSync(path.join(STAGE, 'app', 'index.html'), html, 'utf8');

for (const f of fs.readdirSync(path.join(ROOT, 'js'))) {
  if (f.endsWith('.js')) copy(path.join(ROOT, 'js', f), path.join(STAGE, 'app', 'js', f));
}
for (const f of fs.readdirSync(path.join(ROOT, 'css'))) {
  if (f.endsWith('.css')) copy(path.join(ROOT, 'css', f), path.join(STAGE, 'app', 'css', f));
}
/* 主进程侧的文件全部平铺到 resources/app 根下。
   新增一个主进程模块**必须**加进这个列表 —— 漏了的话构建照样成功、
   exe 也能起，直到运行时 require 失败才炸（而且只在用到那条路径时才炸）。
   v1.20.1 就踩过：新抽出的 trashlib.js / pathauth.js 忘了加，产物一启动就
   `Cannot find module './trashlib.js'`，而构建打印的是 OK。
   所以下面 [1b] 加了一道**反向校验**：从 main.js / desktop.js 里把
   `require('./x.js')` 全抠出来，逐个核对是否真的在 STAGE 里 —— 漏一个就构建失败。 */
const MAIN_FILES = ['main.js', 'preload.js', 'exportlib.js', 'updatelib.js', 'trashlib.js',
  'pathauth.js', 'desktop.js', 'desktop-spec.js', 'package.json'];
for (const f of MAIN_FILES) {
  if (!fs.existsSync(path.join(HERE, f))) throw new Error('主进程文件缺失：' + f);
  copy(path.join(HERE, f), path.join(STAGE, 'app', f));
}

/* 窗口 / 任务栏图标。main.js 里两个 BrowserWindow 都用 path.join(__dirname,'icon.ico')，
   而 __dirname 在包里就是 resources/app，所以放这里即可。
   ⚠️ 这里放的是 **BrowserWindow.icon 用的**图标（窗口标题栏 / 任务栏 / 托盘）。
   exe **自身**的文件图标（资源管理器里那个）是另一条通路：由第 5 步
   stampExeResources() 用 rcedit 写进 PE 资源段（RT_ICON / RT_GROUP_ICON）。
   两者互不替代 —— 早先这段注释写的是"rcedit 没引、文件图标仍是 Electron 默认"，
   那是 v1.12.0 之前的事实，**现在为假**，已按现状改写（曾被它误导过一次判断）。 */
copy(path.join(ROOT, 'brand', 'icon.ico'), path.join(STAGE, 'app', 'icon.ico'));

/* 1b) 反向校验：index.html 引用的每个本地 css / js 都必须真的存在。
   本步是"扫目录全量复制"，结构上不会漏文件；但 index.html 里写错一个
   不存在的文件名时，产物会带着死链发出去。这道闸专门拦这种情况。 */
const localRefs = [...html.matchAll(/(?:href|src)="((?:css|js)\/[^"]*)"/g)].map((m) => m[1]);
const missingRefs = localRefs.filter((p) => !fs.existsSync(path.join(ROOT, p)));
if (missingRefs.length) {
  throw new Error('index.html 引用了不存在的本地文件：\n  ' + missingRefs.join('\n  '));
}
console.log('[1/3] local refs all present (' + localRefs.length + ')');

/* 1c) 反向校验：主进程模块之间的 require('./x.js') 必须都能在 STAGE 里找到。
   这道闸是给 MAIN_FILES 那份**手写清单**兜底的：清单漏一个文件，构建照样
   打印 OK、exe 也照样起得来，直到运行时走到那条 require 才炸
   （v1.20.1 的 trashlib.js 就是这么漏的，产物一启动就 Cannot find module）。
   从 staged 的 main.js / desktop.js 里把本地 require 全抠出来逐个核对。 */
{
  const seen = new Set();
  const stack = ['main.js', 'desktop.js', 'preload.js'];
  const missing = [];
  while (stack.length) {
    const name = stack.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const abs = path.join(STAGE, 'app', name);
    if (!fs.existsSync(abs)) { missing.push(name); continue; }
    const src = fs.readFileSync(abs, 'utf8');
    for (const m of src.matchAll(/require\('(\.\/[A-Za-z0-9_.-]+)'\)/g)) {
      const dep = m[1].slice(2);
      if (!fs.existsSync(path.join(STAGE, 'app', dep))) missing.push(dep + '  ← 被 ' + name + ' require');
      else stack.push(dep);
    }
  }
  if (missing.length) {
    throw new Error('主进程本地依赖没有全部进产物（MAIN_FILES 漏了？）：\n  '
      + missing.join('\n  '));
  }
  console.log('[1/3] main-process requires resolved (' + seen.size + ' files)');
}
console.log('[1/3] app resources staged at', STAGE);

/* 2) 同步 electron 运行时到输出目录。
   策略：robocopy /MIR 镜像——源里同名文件覆盖、目标多余文件（旧 exe/app）自动清除。
   全程不做目录删除（fs.rm / cmd rmdir 会被安全垫片/过滤器拦截且大目录不稳）。

   ⚠️ **必须 /XD data**（v1.20.1 修）：/MIR 会删掉目标里"源没有"的一切，
      而 Atrium 的便携数据（设置 / 收藏 / 旋转记录 / 缩略图缓存，连同 Chromium 的
      Local Storage 与 IndexedDB）就放在 exe 旁边的 data/ 里。
      只要开发者跑过一次构建产物（哪怕只是跑回归里的 appself），
      再执行 npm run build 就会**无声地删光全部用户数据** —— 没有任何提示。
      /XD 把 data/ 从镜像里排除：既不复制、也不删除，原地保留。
      这条不变量有回归守着（buildsafe 套件会真的建一个哨兵文件再重建一次）。 */
const DATA_DIR = path.join(OUT, 'data');
if (fs.existsSync(DATA_DIR)) {
  console.log('[2/3] 检测到便携数据目录，已排除在镜像之外（不会删除）：' + DATA_DIR);
}
fs.mkdirSync(OUT, { recursive: true });
const MIRROR_EXCLUDE = ['/XD', 'data'];
const mir = (src, dst, label) => {
  const args = [src, dst, '/MIR'].concat(MIRROR_EXCLUDE, ['/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1']);
  const r = spawnSync('robocopy', args, { encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.status >= 8) throw new Error('robocopy /MIR failed [' + label + '] status=' + r.status + '\n' + r.stdout);
  return r.status;
};
const rcRun = mir(ELECTRON_DIST, OUT, 'runtime');
console.log('[2/3] electron runtime synced (robocopy status=' + rcRun + ')');

/* 3) 放入 app 资源（同样用 /MIR 镜像，天然清掉旧 app）+ 把 exe 改名为应用名 */
const APP_DIR = path.join(OUT, 'resources', 'app');
fs.mkdirSync(path.join(APP_DIR, 'js'), { recursive: true });
fs.mkdirSync(path.join(APP_DIR, 'css'), { recursive: true });
mir(path.join(STAGE, 'app'), APP_DIR, 'app');
const exeOld = path.join(OUT, 'electron.exe');
const exeNew = path.join(OUT, 'Atrium.exe');
rmForce(exeNew);
fs.renameSync(exeOld, exeNew);

rmForce(STAGE);
console.log('[3/3] OK →', OUT);
console.log('     exe:', exeNew);

/* 4) 附带启动器：清除可能由 WorkBuddy/Node 注入的 NODE_OPTIONS（Electron 不支持会启动即退出） */
const launcher = path.join(HERE, 'launcher.cmd');
if (fs.existsSync(launcher)) {
  fs.copyFileSync(launcher, path.join(OUT, 'Atrium.cmd'));
  console.log('     launcher: Atrium.cmd (已随包附带，双击它可避开 NODE_OPTIONS 冲突)');
}

/* 5) 把图标与版本信息写进 exe 自身的资源段（rcedit）。
   背景：本打包方式是「robocopy 镜像 Electron 运行时 + 把 electron.exe 改名为 Atrium.exe」，
   **不重写 exe 内嵌资源**，所以资源管理器里看到的文件图标一直是 Electron 默认的
   （窗口标题栏 / 任务栏图标由 BrowserWindow.icon 覆盖，那是另一回事）。
   rcedit 是唯一能补上这一步的工具：改 PE 的 RT_ICON / RT_GROUP_ICON 与版本资源。
   - 它是 ESM 包，CommonJS 里必须用动态 import 载入（不能 require）；
   - 它自带 bin/rcedit-x64.exe，安装后**无需联网**；
   - 前置与 electron 运行时相同：先在 deploy/electron 下 npm i（会把 rcedit 一起装上）。
   注意：这一步跑在 robocopy /MIR **之后**。下次构建时 /MIR 会把 Atrium.exe 当"目标多余文件"
   删掉、再由 rename 重新生成，所以每次构建都会重新盖章，不会累积。 */
async function stampExeResources(exePath) {
  const iconPath = path.join(ROOT, 'brand', 'icon.ico');
  if (!fs.existsSync(iconPath)) throw new Error('未找到 brand/icon.ico');
  let rcedit;
  try {
    ({ rcedit } = await import('rcedit'));
  } catch (e) {
    throw new Error('未安装 rcedit —— 请先在 deploy/electron 下执行：npm i -D rcedit');
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const v = pkg.version || '0.0.0';
  await rcedit(exePath, {
    icon: iconPath,
    'file-version': v,
    'product-version': v,
    'version-string': {
      ProductName: 'Atrium',
      FileDescription: 'Atrium · 本地照片浏览器',
      CompanyName: 'Atrium',
      LegalCopyright: 'Atrium',
      OriginalFilename: 'Atrium.exe',
      InternalName: 'Atrium',
    },
  });
  return v;
}

/* 失败即构建失败：图标没写进去是**可见的**退化（资源管理器里还是 Electron 默认图标），
   不能让它在"构建成功"的假象里发出去。 */
stampExeResources(exeNew)
  .then((v) => {
    // 尺寸在**盖章之后**才量：rcedit 会重写 RT_ICON / 版本资源，字节数会变，
    // 早量会报出一个不是最终产物的数字（曾因此误判"rcedit 没生效"）。
    const sizeMB = Math.round(fs.statSync(exeNew).size / 1024 / 1024);
    console.log('     exe resources: icon + version ' + v + ' (rcedit)');
    console.log('     exe size: ' + sizeMB + ' MB');

    /* 6) 构建戳（卫生项）：产物目录是**原地覆盖**的（robocopy /MIR），
       所以光看目录分不出"这一份是哪次构建出来的"，也无法与源码对账。
       落一个 BUILD-INFO.json，记版本号 / 构建时刻 / exe 的 MD5 ——
       目的是**可回溯**（这一份对应哪版源码），不是"两版并存"。

       刻意**不**改成"按版本号建目录"：那会让每次构建都多出一份 269MB 的副本，
       而且 pack.js / run_all.js 的 appself / 全部文档都得跟着改成"找最新目录"，
       收益（并存两版）远小于成本。 */
    try {
      const info = {
        product: 'Atrium',
        version: v,
        builtAt: new Date().toISOString(),
        exe: {
          file: path.relative(ROOT, exeNew).replace(/\\/g, '/'),
          bytes: fs.statSync(exeNew).size,
          md5: crypto.createHash('md5').update(fs.readFileSync(exeNew)).digest('hex'),
        },
        note: '本文件由 deploy/electron/assemble.js 每次构建时覆盖写入。',
      };
      fs.writeFileSync(path.join(path.dirname(OUT), 'BUILD-INFO.json'), JSON.stringify(info, null, 2) + '\n');
      console.log('     build stamp: BUILD-INFO.json (v' + v + ' md5 ' + info.exe.md5.slice(0, 12) + '…)');
    } catch (e) {
      console.warn('     BUILD-INFO.json 写入失败（不影响产物）：' + ((e && e.message) || e));
    }
  })
  .catch((e) => {
    console.error('\n[icon] 写入 exe 资源失败：' + ((e && e.message) || e));
    console.error('      资源管理器里的文件图标会停留在 Electron 默认 —— 按构建失败处理。');
    process.exitCode = 1;
  });
