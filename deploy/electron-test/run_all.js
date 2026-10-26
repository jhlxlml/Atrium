/* ============================================================
   Atrium · 回归套件入口（P0-1）
   ------------------------------------------------------------
   一条命令跑完全部质量门禁：
     node deploy/electron-test/run_all.js            跑全部
     node deploy/electron-test/run_all.js --fast     快跑（跳过大部分 Electron 探针；仍需 electron）
     node deploy/electron-test/run_all.js tf center  只跑指定套件

   设计要点：
   1) 纯函数层（js/transform.js）用 Node 直接断言 —— 毫秒级反馈，不启动 Electron；
   2) Electron 层探针只输出原始测量值，断言全部集中在本文件，避免「探针自己判自己」；
   3) 「三路径联合回归」（缩放×旋转×平移）是硬性门禁，任何一条破坏都会失败；
   4) 任一失败即以非零码退出，可直接接入 CI / 提交钩子。
   ============================================================ */
'use strict';

const path = require('path');
const fs = require('fs');
/* spawnSync 的默认 stdio 会给 stdin 建管道，本机沙箱拒绝（EBUSY，连 cmd.exe
   都起不来）。子进程（robocopy / electron 探针 / 7z / where）没有一个需要
   stdin，所以统一把它设成 ignore；stdout 与 stderr 照常 pipe，调用方无感。
   显式传了 stdio 的调用点仍然优先。 */
const { spawnSync: rawSpawnSync } = require('child_process');
const spawnSync = function (cmd, args, opts) {
  return rawSpawnSync(cmd, args, Object.assign({ stdio: ['ignore', 'pipe', 'pipe'] }, opts || {}));
};
const { runProbe, runAppSelftest } = require('./run_probe.js');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..', '..');
const LOGS = path.join(HERE, 'logs');
if (!fs.existsSync(LOGS)) fs.mkdirSync(LOGS, { recursive: true });

const EPS = 0.6;          // 几何容差（px）
const EPS_FOCAL = 0.5;    // 不动点漂移容差（内容像素）

/* ---------- 断言收集 ---------- */
function makeChecker(suiteName, results) {
  return function check(name, cond, detail) {
    results.push({ suite: suiteName, name: name, ok: !!cond, detail: detail || '' });
  };
}
function near(check, name, actual, expected, eps, unit) {
  const e = eps == null ? EPS : eps;
  if (typeof actual !== 'number' || !isFinite(actual)) {
    check(name, false, '非数值: ' + actual);
    return;
  }
  const d = Math.abs(actual - expected);
  check(name, d <= e, '实测 ' + round(actual) + '，期望 ' + round(expected) + '，偏差 ' + round(d) + (unit || 'px'));
}
function round(v) { return typeof v === 'number' ? Math.round(v * 1000) / 1000 : v; }

/* ---------- 稳健的 JSON 提取（探针输出后常带 IPC 噪声）---------- */
function extractJSON(text, key) {
  if (!text) return null;
  const i = text.indexOf(key);
  if (i < 0) return null;
  const s = text.slice(i + key.length);
  const m = s.search(/[[{]/);
  if (m < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = m; j < s.length; j++) {
    const c = s[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(m, j + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

/* ============================================================
   套件定义
   每项：{ id, title, kind:'node'|'probe', script, keys:[输出标签], run(ctx) }
   ============================================================ */
const SUITES = [
  /* ---------- 1. 纯函数：js/transform.js ---------- */
  {
    id: 'unit',
    title: '纯函数 · transform.js 几何层（Node，无需 Electron）',
    kind: 'node',
    script: path.join(ROOT, 'test', 'transform.test.js'),
    run: function (ctx) {
      const check = ctx.check;
      check('纯函数测试全部通过', ctx.code === 0, '退出码 ' + ctx.code + (ctx.tail ? ' | ' + ctx.tail : ''));
    },
  },

  /* ---------- 1a. 纯函数 · 强调色推导（任意颜色 → 一套可用令牌） ----------
     为什么值得单列一个套件：颜色算错**不会报错**，只是某些色在某个主题下
     悄悄变得读不清 —— 而用户拖取色器的那一刻，恰好是我们最不可能逐一
     肉眼验证每个组合的时刻。这里是 228 条断言，覆盖预设色、极端色
     （纯黄/纯白/纯黑/荧光绿）与两种模式的全部组合，外加三条反向用例。 */
  {
    id: 'themeunit',
    title: '纯函数 · 强调色推导：任意色 × 两主题都满足对比度（Node）',
    kind: 'node',
    script: path.join(ROOT, 'test', 'theme.test.js'),
    run: function (ctx) {
      const check = ctx.check;
      check('主题色推导测试全部通过（含极端色与反向用例）', ctx.code === 0,
        '退出码 ' + ctx.code + (ctx.tail ? ' | ' + ctx.tail : ''));
    },
  },

  /* ---------- 1b. 纯函数 · 图片头尺寸解析（性能优化的正确性地基） ---------- */
  {
    id: 'header',
    title: '纯函数 · Util.sizeFromHeader 逐格式偏移量（Node，无需 Electron）',
    kind: 'node',
    script: path.join(ROOT, 'test', 'imageheader.test.js'),
    run: function (ctx) {
      const check = ctx.check;
      check('图片头解析测试全部通过', ctx.code === 0, '退出码 ' + ctx.code + (ctx.tail ? ' | ' + ctx.tail : ''));
    },
  },

  /* ---------- 1b2. 纯函数：相框的洗牌 / 朝向 / 按比例装箱（Node） ---------- */
  {
    id: 'frame',
    title: '纯函数 · 相框洗牌无偏 / 不连播同一张 / 旋转朝向 / 按比例装箱不越界（Node）',
    kind: 'node',
    script: path.join(ROOT, 'test', 'frame.test.js'),
    run: function (ctx) {
      const check = ctx.check;
      check('相框纯函数测试全部通过（505 断言）', ctx.code === 0,
        '退出码 ' + ctx.code + (ctx.tail ? ' | ' + ctx.tail : ''));
    },
  },

  /* ---------- 1b3. 纯函数：无障碍焦点数学与播报区（Node） ---------- */
  {
    id: 'a11y',
    title: '纯函数 · 无障碍 Tab 循环 / tabindex 边界 / 初始焦点选择 / 播报区（Node）',
    kind: 'node',
    script: path.join(ROOT, 'test', 'a11y.test.js'),
    run: function (ctx) {
      const check = ctx.check;
      check('无障碍纯函数与播报区测试全部通过（77 断言）', ctx.code === 0,
        '退出码 ' + ctx.code + (ctx.tail ? ' | ' + ctx.tail : ''));
    },
  },

  /* ---------- 1b3b. 纯函数：更新检测（版本比较 / URL 白名单）（Node） ----------
     为什么单列一套：updatelib.js 里的三件事**写错了都不报错**，而且症状都"看着正常"——
       · isNewer 比反了 → 永远"已是最新"或永远"有新版本"；
       · parseVer 太宽松 → 'nightly' 被当成版本号 → 误报更新；
       · isAllowedExternal 太宽松 → 主进程的 shell.openExternal 变成一个
         "打开任意 URL / 执行本地文件"的能力（**安全倒退，且没有任何界面迹象**）。
     所以这套的重点是**反向用例**（一串必须被拒的 URL）——只测"官方链接能过"
     等于恒真的门禁。updatelib.js 不依赖 Electron，Node 直接 require。 */
  {
    id: 'update',
    title: '纯函数 · 更新检测：版本号比较 / 接口响应解析 / openExternal URL 白名单（Node）',
    kind: 'node',
    script: path.join(ROOT, 'test', 'updatelib.test.js'),
    run: function (ctx) {
      const check = ctx.check;
      check('更新检测纯逻辑测试全部通过（65 断言，含 21 条反向用例）', ctx.code === 0,
        '退出码 ' + ctx.code + (ctx.tail ? ' | ' + ctx.tail : ''));
    },
  },

  /* ---------- 1b3c. 纯函数：回收站 $I 解析与「只认这一次删除」的判据（Node） ----------
     撤销删除的语义是"撤销**这一次**"。判据靠三样东西：原路径、大小、删除时刻。
     历史实现把后两样写成 `(rec.size)|0` / `(rec.ts)|0` —— 位或截成有符号 32 位：
       · ts 约 1.77e12 → 截成一个负数 → `afterMs` 远早于真实删除时刻 →
         "不早于这次删除"的护栏**静默失效**，撤销会把用户昨天手动删的同名文件搬回来；
       · size ≥ 2GiB → 截成负数 → 与 $I 里的真实大小永不相等 → 大文件永远还原不了。
     这两条都**不会报错**，界面上只会显示"撤销失败"或"已撤销"。所以这套的重点是
     反向用例：先用 `|0` 亲手复现失真，再断言修复后处理对。 */
  {
    id: 'trash',
    title: '纯函数 · 回收站 $I 解析 / 撤销只认这一次删除 / ≥2GiB 大小不截断（Node）',
    kind: 'node',
    script: path.join(ROOT, 'test', 'trash.test.js'),
    run: function (ctx) {
      const check = ctx.check;
      check('回收站纯逻辑测试全部通过（78 断言，含 6 条反向用例）', ctx.code === 0,
        '退出码 ' + ctx.code + (ctx.tail ? ' | ' + ctx.tail : ''));
    },
  },

  /* ---------- 1b3d. 纯函数：vf://pic 的读盘授权（Node） ----------
     `vf://pic/<base64 路径>` 原先是"解出什么路径就读什么路径"，等于给了渲染层
     一台读任意文件的机器（`.ssh\id_rsa` 拼个 base64 就出来了）。现在只放行
     用户真正打开过的目录。判定里有三种必须被拒的绕过：`..` 折叠、前缀无边界
     （`Pics2` vs `Pics`）、大小写/分隔符混用。所以这套的重点是反向用例。 */
  {
    id: 'pathauth',
    title: '纯函数 · vf://pic 读盘授权：只放行打开过的目录，.. 与前缀越权一律拒（Node）',
    kind: 'node',
    script: path.join(ROOT, 'test', 'pathauth.test.js'),
    run: function (ctx) {
      const check = ctx.check;
      check('读盘授权纯逻辑测试全部通过（45 断言，含 9 条越权反向用例）', ctx.code === 0,
        '退出码 ' + ctx.code + (ctx.tail ? ' | ' + ctx.tail : ''));
    },
  },

  /* ---------- 1b4. 纯函数：瀑布流的列分配 / 高度 / 二分代理不变量（Node） ----------
     核心不变量：positions[i].y 单调不减（可安全二分），而 y+h **不单调**
     （同列里后放的矮图底边可能更靠上）→ 网格的可见区裁剪 / 滚动锚定 / 框选
     三处都必须改按单调的 yMax 前缀数组二分；这条套件就是那三处的正确性地基。 */
  {
    id: 'masonryunit',
    title: '纯函数 · 瀑布流列分配 / 最短列优先 / y 单调而 y+h 不单调 / yMax 覆盖不变量（Node）',
    kind: 'node',
    script: path.join(ROOT, 'test', 'masonry.test.js'),
    run: function (ctx) {
      const check = ctx.check;
      check('瀑布流纯函数测试全部通过（87 断言）', ctx.code === 0,
        '退出码 ' + ctx.code + (ctx.tail ? ' | ' + ctx.tail : ''));
    },
  },

  /* ---------- 1b4. 冻结标识：改名会清空用户数据的那些字符串 ----------
     这是一条**源级不变量**（只读文件、不起 Electron），因为要锁的东西散在四处：
     `main.js`（源 origin / 任务栏身份）、`state.js`（三个 localStorage 键）、
     `loader.js`（IndexedDB 名）、`deploy/electron/package.json`（userData 目录名）。

     为什么值得单列一个套件：v1.13.0 把产品改名 Atrium，但**刻意保留**了这些标识。
     它们一旦被顺手"清理"掉，后果是**用户数据一次性消失**：
       · `vf://app` 改了 → 源（origin）变了 → localStorage + IndexedDB 全部失效
         （设置 / 收藏 / 旋转记录 / 尺寸缓存一起没）；
       · 三个 `viewfinder.*` LS 键改了 → 同上；
       · `viewfinder-db` 改了 → 缩略图与尺寸缓存全丢（可重建，但首屏退化）；
       · `productName` 改了 → 窗口标题 / 任务栏 / 开始菜单里的名字变了
         （v1.14.0 起 userData 已改为「应用本体所在目录/data」，**不再**由它决定，
          但它仍是产品身份的一部分，且打包后的 AppData 回落路径仍用它）；
       · `com.atrium.app` 改了 → 任务栏固定 / JumpList 关联错乱。
     成本是一条断言，收益是**永久免疫**。这也是全项目性价比最高的一条门禁。 */
  {
    id: 'frozen',
    title: '冻结标识 · 改名就会清空用户数据的字符串（源级不变量，不需要 Electron）',
    kind: 'node',
    run: function (ctx) {
      const check = ctx.check;
      const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
      let main, state, loader, elPkg, rootPkg;
      try {
        main = read('deploy/electron/main.js');
        state = read('js/state.js');
        loader = read('js/loader.js');
        elPkg = read('deploy/electron/package.json');
        rootPkg = read('package.json');
      } catch (e) {
        check('冻结标识所在的源文件都可读', false, String((e && e.message) || e));
        return;
      }
      const el = JSON.parse(elPkg);
      const root = JSON.parse(rootPkg);

      /* 逐个标识单独断言：失败时一眼看出是哪一个被改了，而不是笼统一句"标识变了"。 */
      check('源（origin）仍是 vf://app —— 改了它 localStorage/IndexedDB 会一起失效',
        main.indexOf('vf://app/index.html') >= 0 && /scheme:\s*'vf'/.test(main),
        'main.js 里找不到 vf://app/index.html 或 vf 特权协议');
      check('三个 localStorage 键未被改名（设置 / 收藏 / 旋转记录）',
        state.indexOf("'viewfinder.settings.v1'") >= 0
          && state.indexOf("'viewfinder.favs.v1'") >= 0
          && state.indexOf("'viewfinder.rot.v1'") >= 0,
        'state.js 里三个 viewfinder.*.v1 键必须原样保留');
      check('IndexedDB 名仍是 viewfinder-db（缩略图与尺寸缓存）',
        loader.indexOf("'viewfinder-db'") >= 0, 'loader.js 的 DB_NAME');
      check('任务栏身份仍是 com.atrium.app（任务栏固定 / JumpList 关联）',
        main.indexOf("'com.atrium.app'") >= 0, 'main.js 的 setAppUserModelId');
      check('productName 仍是 Atrium —— 窗口标题 / 任务栏 / 开始菜单的产品身份',
        el.productName === 'Atrium', 'deploy/electron/package.json 的 productName=' + el.productName);
      /* 应用数据目录（v1.14.0 便携化）。两条都必须原样在：
         ① VF_USERDATA 分支优先级最高 —— 探针与 --selftest 靠它把数据指到临时目录；
            删了它，全量回归会开始往**真实用户数据**里写（而且没人会发现）。
         ② data/ 分支 —— 删了它便携性就没了（数据重新散落到 %APPDATA%）。
         源级字符串检查在这里够用：这两条分支都是"一段固定写法"，
         真正的行为验证由 appself（跑打包后的 exe）承担。 */
      check('VF_USERDATA 优先级最高（探针/自检靠它隔离数据，删了会污染真实数据）',
        main.indexOf("process.env.VF_USERDATA") >= 0
          && main.indexOf("app.setPath('userData', process.env.VF_USERDATA)") >= 0,
        'main.js 里找不到 VF_USERDATA 分支');
      check('应用数据目录指向「应用本体目录/data」（便携化：拷走文件夹即带走全部设置）',
        main.indexOf("path.join(base, 'data')") >= 0
          && /app\.setPath\('userData',\s*dataDir\)/.test(main),
        'main.js 里找不到 <base>/data 的 userData 分支');
      check('根 package.json 的 name 仍是 viewfinder（刻意保留，别"顺手改掉"）',
        root.name === 'viewfinder', 'package.json 的 name=' + root.name);
    },
  },

  /* ---------- 1b4a. 打包允许清单：私人数据一律拒收（Node） ----------
     交付 ZIP 是用 Node 自己的 ZIP 写入器从产物目录打出来的。原先的收集函数是
     `walk(appDir,'',[])` —— **递归整个目录，一个都不排除**。于是"用构建产物看过
     私人照片 → 直接 npm run pack"这条再正常不过的操作，会把 data/（设置 / 收藏 /
     旋转记录 / 缩略图缓存 + Chromium 的 Local Storage 与 IndexedDB）原样打进交付包。

     这条套件用**一个造出来的假产物目录**去撞清单：运行时文件必须收、data/ 与日志
     必须拒，并且"拒收清单"要能被逐个点名 —— 只断言"条数变少了"是抓不到漏的。 */
  {
    id: 'packlist',
    title: '打包允许清单 · data/ 与缓存一律拒收，未知条目也拒收（Node）',
    kind: 'node',
    run: function (ctx) {
      const check = ctx.check;
      let P;
      try { P = require(path.join(ROOT, 'deploy', 'pack.js')); }
      catch (e) {
        check('pack.js 可被 require（主逻辑不在 import 时执行）', false, String((e && e.message) || e));
        return;
      }
      check('pack.js 可被 require（主逻辑不在 import 时执行）', typeof P.collectEntries === 'function');

      const tmp = path.join(LOGS, 'packlist-fixture');
      fs.rmSync(tmp, { recursive: true, force: true });
      const mk = (rel, content) => {
        const abs = path.join(tmp, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content == null ? 'x' : content);
      };
      /* 运行时该有的（照真实产物的一小部分） */
      mk('Atrium.exe'); mk('Atrium.cmd'); mk('version'); mk('LICENSE');
      mk('ffmpeg.dll'); mk('resources.pak');
      mk('locales/zh-CN.pak');
      mk('resources/default_app.asar');
      mk('resources/app/index.html'); mk('resources/app/main.js'); mk('resources/app/icon.ico');
      mk('resources/app/js/app.js'); mk('resources/app/css/main.css');
      /* 不该出现的 */
      mk('data/last-dir.json', '{"dir":"C:\\\\Users\\\\me\\\\Photos"}');
      mk('data/Local Storage/leveldb/000003.log');
      mk('debug.log');
      mk('screenshots/private.png');
      mk('notes.txt');

      const r = P.collectEntries(tmp);
      const names = r.entries.map((e) => e.name);
      const rn = r.rejected.map((x) => x.name);

      check('运行时文件全部收进清单',
        ['Atrium.exe', 'version', 'ffmpeg.dll', 'resources.pak', 'locales/zh-CN.pak',
          'resources/app/js/app.js', 'resources/app/css/main.css'].every((n) => names.indexOf(n) >= 0),
        names.join(', '));
      check('data/ 被拒收（私人数据不外泄）', rn.indexOf('data') >= 0, rn.join(', '));
      check('data/ 里的任何文件都没进清单（不是只拒了目录名）',
        !names.some((n) => /^data\//.test(n)), names.filter((n) => /^data/.test(n)).join(', '));
      check('日志 / 未知目录 / 未知文件都被拒收',
        ['debug.log', 'screenshots/', 'notes.txt'].every((n) => rn.indexOf(n) >= 0), rn.join(', '));
      const unexpected = rn.filter((n) => ['data', 'debug.log', 'screenshots/', 'notes.txt'].indexOf(n) < 0);
      check('没有额外的误拒（清单没有紧到把运行时文件挡在外面）',
        unexpected.length === 0, unexpected.join(', '));

      /* 真实产物：除 data/（本机跑过产物才会有）之外，不应有任何被拒条目。
         这条是"清单与当前 Electron 运行时对得上"的活体检 —— 升级 Electron 后
         多出新文件时，它会在打包之前就红，而不是等 pack 报错。 */
      const real = path.join(ROOT, 'deploy', 'dist-electron', 'Atrium_Electron版');
      if (fs.existsSync(real)) {
        const rr = P.collectEntries(real);
        const bad = rr.rejected.filter((x) => x.name !== 'data');
        check('真实产物里除 data/ 外没有被拒条目', bad.length === 0,
          bad.map((b) => b.name + '：' + b.why).join(' | '));
        check('真实产物条目数 ≥ 100（没有把该带的漏掉）', rr.entries.length >= 100, 'n=' + rr.entries.length);
      } else {
        check('真实产物存在（先跑 npm run build）', false, real);
      }

      fs.rmSync(tmp, { recursive: true, force: true });
    },
  },

  /* ---------- 1b4a2. 构建安全：`/MIR` 不许碰 data/（Node，会真的跑一次 robocopy） ----------
     assemble.js 用 `robocopy /MIR` 把运行时镜像到产物目录。/MIR = /E + /PURGE，
     **会删掉目标里"源没有"的一切** —— 而便携数据 data/ 恰好只在目标里有。
     于是"用产物看一眼照片 → 再 npm run build"会把用户设置、收藏、旋转记录、
     缩略图缓存全部清空，构建却打印 OK。

     这套不只是查源码里有没有写 /XD：它在临时目录里**真的跑一次 robocopy**，
     放一个哨兵文件进 dst/data/，然后
       ① 带上和构建脚本一模一样的参数 → 哨兵必须还在；
       ② 故意去掉 /XD → 哨兵必须消失。
     ②是必须的：只做①的话，"robocopy 根本没删东西"这种环境差异会让门禁恒真。 */
  {
    id: 'buildsafe',
    title: '构建安全 · robocopy /MIR 不删 data/（真跑一次）+ 主进程依赖全进产物（Node）',
    kind: 'node',
    run: function (ctx) {
      const check = ctx.check;
      const asmSrc = fs.readFileSync(path.join(ROOT, 'deploy', 'electron', 'assemble.js'), 'utf8');
      check('assemble.js 的镜像参数里有 /XD data',
        /const MIRROR_EXCLUDE = \['\/XD', 'data'\]/.test(asmSrc),
        (asmSrc.match(/[^\n]*MIRROR_EXCLUDE[^\n]*/g) || []).join(' | '));
      check('检测到 data/ 时会明确打印"不会删除"（不许无声）',
        asmSrc.indexOf('已排除在镜像之外（不会删除）') >= 0);
      check('构建会反向核对主进程 require（MAIN_FILES 漏文件就失败，不留到运行时）',
        asmSrc.indexOf('main-process requires resolved') >= 0);

      /* 主进程依赖清单：从源码里把本地 require 全抠出来，逐个核对是否在 MAIN_FILES */
      {
        const dir = path.join(ROOT, 'deploy', 'electron');
        const mf = (asmSrc.match(/const MAIN_FILES = \[([\s\S]*?)\];/) || [])[1] || '';
        const listed = (mf.match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1));
        const need = new Set();
        for (const f of ['main.js', 'desktop.js', 'preload.js']) {
          const p = path.join(dir, f);
          if (!fs.existsSync(p)) continue;
          for (const m of fs.readFileSync(p, 'utf8').matchAll(/require\('(\.\/[A-Za-z0-9_.-]+)'\)/g)) {
            need.add(m[1].slice(2));
          }
        }
        const missing = Array.from(need).filter((n) => listed.indexOf(n) < 0);
        check('MAIN_FILES 覆盖 main/desktop/preload 的全部本地 require',
          need.size > 0 && missing.length === 0,
          '缺 ' + JSON.stringify(missing) + '（清单 ' + listed.length + ' 项）');
      }

      /* 真跑一次 robocopy：临时目录，不碰任何真实产物 */
      const tmp = path.join(LOGS, 'buildsafe-' + Date.now());
      const src = path.join(tmp, 'src');
      const dst = path.join(tmp, 'dst');
      fs.mkdirSync(src, { recursive: true });
      fs.mkdirSync(path.join(dst, 'data'), { recursive: true });
      fs.writeFileSync(path.join(src, 'electron.exe'), 'exe');
      fs.writeFileSync(path.join(src, 'ffmpeg.dll'), 'dll');
      fs.writeFileSync(path.join(dst, 'stale-old-file.dll'), 'old'); // /MIR 该清掉它
      fs.writeFileSync(path.join(dst, 'data', '_sentinel.txt'), 'sentinel');

      const run = (extra) => {
        const args = [src, dst, '/MIR'].concat(extra, ['/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1']);
        const r = spawnSync('robocopy', args);
        return { status: r.status, err: r.error ? String(r.error.message) : '' };
      };
      const has = (p) => fs.existsSync(p);

      const withXD = run(['/XD', 'data']);
      check('robocopy 能跑起来（这台机器上有它）',
        withXD.err === '', withXD.err);
      check('带 /XD data 时：哨兵仍在（构建不会删用户数据）',
        has(path.join(dst, 'data', '_sentinel.txt')),
        'robocopy status=' + withXD.status);
      check('带 /XD data 时：运行时文件照常镜像过去',
        has(path.join(dst, 'electron.exe')) && has(path.join(dst, 'ffmpeg.dll')));
      check('带 /XD data 时：目标里的旧垃圾文件仍被 /MIR 清掉（没有把镜像变成只增不减）',
        !has(path.join(dst, 'stale-old-file.dll')));

      /* 反向：去掉 /XD，哨兵必须消失 —— 证明起作用的确实是这条参数 */
      fs.writeFileSync(path.join(dst, 'data', '_sentinel.txt'), 'sentinel');
      const noXD = run([]);
      check('反向：去掉 /XD 后哨兵被删（证明 /XD 就是那道保险）',
        !has(path.join(dst, 'data', '_sentinel.txt')),
        'robocopy status=' + noXD.status);

      fs.rmSync(tmp, { recursive: true, force: true });
    },
  },

  /* ---------- 1b4b. IPC 链路完整性（源级，不需要 Electron） ----------
     渲染层能调的每一条通道，主进程侧都必须有 handler；
     `desktop.js` 的每一条通道，探针桩（`_desktop_stub.js`）都必须补上。

     漏一处就是**静默降级**：`invoke` reject → 被 Native 的 `.catch` 吞成
     false/null → 上层判"没生效" → 回滚 + 播报，或者干脆什么都没发生。
     "探针是假宿主"那条隐患就是这么来的（缺 handler → 假失败）。

     为什么用**源级静态检查**而不是"每个探针启动时断言 typeof === 'function'"：
     一次覆盖全部探针，不需要逐个改 17 个探针文件，也不会随探针增减而失效。 */
  {
    id: 'ipcchain',
    title: 'IPC 链路完整性 · preload 暴露的每条通道都有 handler / 桌面通道都有探针桩（源级）',
    kind: 'node',
    run: function (ctx) {
      const check = ctx.check;
      const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
      const names = (src, re) => {
        const out = [];
        let m;
        while ((m = re.exec(src))) out.push(m[1]);
        return out;
      };
      const uniq = (a) => a.filter((v, i) => a.indexOf(v) === i);
      let preload, main, desktop, stub;
      try {
        preload = read('deploy/electron/preload.js');
        main = read('deploy/electron/main.js');
        desktop = read('deploy/electron/desktop.js');
        stub = read('deploy/electron-test/probes/_desktop_stub.js');
      } catch (e) {
        check('IPC 链路源文件都可读', false, String((e && e.message) || e));
        return;
      }

      const exposed = uniq(names(preload, /ipcRenderer\.(?:invoke|send)\('(vf:[A-Za-z]+)'/g));
      const handled = uniq(names(main, /ipcMain\.(?:handle|on)\('(vf:[A-Za-z]+)'/g)
        .concat(names(desktop, /ipcMain\.handle\('(vf:[A-Za-z]+)'/g)));
      const desktopCh = uniq(names(desktop, /ipcMain\.handle\('(vf:[A-Za-z]+)'/g));
      const stubbed = uniq(names(stub, /ipcMain\.handle\('(vf:[A-Za-z]+)'/g));

      /* 下限只是防"正则失效后恒真"——低于这个数说明解析本身出了问题。 */
      const noHandler = exposed.filter((c) => handled.indexOf(c) < 0);
      check('preload 暴露的每条通道，主进程都有 handler（漏一条就是静默降级）',
        exposed.length >= 30 && noHandler.length === 0,
        '暴露 ' + exposed.length + ' 条，缺 handler=' + JSON.stringify(noHandler));

      const noStub = desktopCh.filter((c) => stubbed.indexOf(c) < 0);
      check('desktop.js 的每条通道都有探针桩（否则探针里是"假失败"）',
        desktopCh.length > 0 && noStub.length === 0,
        '桌面通道 ' + desktopCh.length + ' 条，缺桩=' + JSON.stringify(noStub));
    },
  },

  /* ---------- 1b4c. 安全基线（源级） ----------
     这一套守的是"安全上的默认值"，它们**被改回去也不会报错**，只会安静地变弱：
       · bypassCSP: true → 文档里的 CSP 直接失效（等于没有 CSP）；
       · 沙箱起不来就自动 --no-sandbox 重启 → 用户全程不知情地失去沙箱隔离；
       · 内联 style 属性 → 逼着 style-src 放行 'unsafe-inline'，CSP 少一半价值；
       · IPC 通道不校验来源 → 页面里一处 HTML 注入就能调 preload 暴露的全部能力。
     源级检查而不是运行时检查：这几条都在"启动之前"，跑起来再看就晚了。 */
  {
    id: 'secboot',
    title: '安全基线 · 无 bypassCSP / 严格 CSP / 沙箱不静默降级 / IPC 校验来源（源级）',
    kind: 'node',
    run: function (ctx) {
      const check = ctx.check;
      const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
      let main, html;
      try { main = read('deploy/electron/main.js'); html = read('index.html'); }
      catch (e) { check('安全基线源文件可读', false, String((e && e.message) || e)); return; }

      /* ---- CSP ---- */
      check('main.js 不再声明 bypassCSP（它会让文档里的 CSP 整份失效）',
        !/bypassCSP\s*:\s*true/.test(main),
        (main.match(/[^\n]*bypassCSP[^\n]*/g) || []).join(' | '));
      /* corsEnabled 不是"可有可无的性能开关"：Electron 45 起，不在 CORS 允许列表里的
         自定义协议**一律拒绝跨源 fetch**，而缩略图正是靠 fetch vf://pic 拿 Blob 的。
         少了它页面不报错，只是所有缩略图都不出现。 */
      check('main.js 的 vf:// 特权里有 corsEnabled（否则缩略图全都不出）',
        /corsEnabled\s*:\s*true/.test(main));
      {
        const probeDir = path.join(ROOT, 'deploy', 'electron-test', 'probes');
        const need = fs.readdirSync(probeDir).filter((f) => {
          const s = fs.readFileSync(path.join(probeDir, f), 'utf8');
          return /host === 'pic'/.test(s) && !/corsEnabled/.test(s);
        });
        check('每个会加载图片的探针都开了 corsEnabled（探针要能复现真实协议行为）',
          need.length === 0, need.join(', '));
      }
      const m = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
      check('index.html 里有 CSP（meta http-equiv）', !!m, '没找到 CSP meta');
      if (m) {
        const csp = m[1];
        check('CSP 默认拒绝：default-src 收窄到 self', /default-src 'self'/.test(csp), csp);
        check('CSP script-src 只放 self（无 unsafe-inline / unsafe-eval）',
          /script-src 'self'/.test(csp)
            && !/script-src[^;]*unsafe-inline/.test(csp)
            && !/script-src[^;]*unsafe-eval/.test(csp), csp);
        check('CSP style-src 不含 unsafe-inline（靠"没有内联 style"来成立）',
          /style-src 'self'/.test(csp) && !/style-src[^;]*unsafe-inline/.test(csp), csp);
        check('CSP 封掉 object / base / form 三个跳板',
          /object-src 'none'/.test(csp) && /base-uri 'none'/.test(csp) && /form-action 'none'/.test(csp), csp);
        check('CSP 的 img-src 放行 vf: 与 data:（缩略图与图标要用）',
          /img-src[^;]*vf:/.test(csp) && /img-src[^;]*data:/.test(csp), csp);
        check('CSP 的 connect-src 放行 vf:（缩略图要 fetch 成 Blob 才能降采样）',
          /connect-src[^;]*vf:/.test(csp), csp);
      }
      /* style-src 'self' 要成立，文档里就不能有内联 style 属性 / <style> 块 */
      check('index.html 里没有内联 style 属性（否则 style-src 得放行 unsafe-inline）',
        !/\sstyle="/.test(html),
        (html.match(/[^\n]*\sstyle="[^"]{0,40}/g) || []).join(' | '));
      check('index.html 里没有内联 <script> 块',
        !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(html));
      check('图标精灵靠 #iconSprite 规则隐藏（内联 style 的替代）',
        /id="iconSprite"/.test(html) && /#iconSprite\s*\{[^}]*display:\s*none/.test(read('css/main.css')));

      /* ---- 沙箱不静默降级 ---- */
      {
        const askIdx = main.indexOf('showMessageBoxSync(mainWin');
        const relaunchIdx = main.indexOf("concat(['--no-sandbox'])");
        check('带 --no-sandbox 的重启一定排在用户确认之后（不是自动的）',
          askIdx >= 0 && relaunchIdx > askIdx,
          'askIdx=' + askIdx + ' relaunchIdx=' + relaunchIdx);
      }
      check('降级前必须弹窗询问，且默认按钮是"取消"',
        /showMessageBoxSync\(mainWin,\s*\{[\s\S]{0,900}?defaultId:\s*0/.test(main),
        '没找到带 defaultId:0 的确认框');
      check('降级询问里的按钮顺序是 [取消, 用兼容模式重启]',
        /buttons:\s*\[\s*'取消'\s*,\s*'用兼容模式重启'\s*\]/.test(main));

      /* ---- IPC 来源校验 ---- */
      check('main.js 有 isTrustedSender（只认 vf://app/ 下的本进程窗口）',
        /function isTrustedSender\(e\)/.test(main)
          && /vf:\\\/\\\/app\\\//.test(main)
          && /getAllWindows\(\)\.some/.test(main));
      check('IPC 校验一次性包住所有注册（新增通道不会漏）',
        /function installIpcGuard\(\)/.test(main)
          && /ipcMain\.handle\s*=\s*\(ch,\s*fn\)/.test(main)
          && /ipcMain\.on\s*=\s*\(ch,\s*fn\)/.test(main));
      check('校验在 wireIpc / desktop.wireIpc 之前安装（装晚了会漏一批通道）',
        main.indexOf('installIpcGuard();') >= 0
          && main.indexOf('installIpcGuard();') < main.indexOf('wireIpc();')
          && main.indexOf('installIpcGuard();') < main.indexOf('desktop.wireIpc();'));
      check('未通过校验的调用会抛错（不会被当成一条业务失败吞掉）',
        /throw new Error\('untrusted sender/.test(main));

      /* ---- 跨源与读盘 ---- */
      check('vf://pic 不再回 Access-Control-Allow-Origin: *',
        main.indexOf("'Access-Control-Allow-Origin', '*'") < 0);

      /* ---- 删除链路的两处静默失败 ---- */
      check('删除日志原子写（.tmp + rename），不再裸 writeFile',
        /const tmp = f \+ '\.tmp'/.test(main) && /await fs\.rename\(tmp, f\)/.test(main));
      check('trashItem 报错时只认 ENOENT 为"文件确实不在了"',
        /e2\.code === 'ENOENT'/.test(main));
      check('删除日志写失败会作为 warned 带回渲染层（不再吞异常）',
        /log-write-failed/.test(main));
    },
  },

  /* ---------- 1b5. 纯函数：桌面集成（菜单模板 / 加速键 / 命令表接线） ----------
     这一层全是"写错了也不报错"的东西：菜单项少接一个 cmd 只是点了没反应，
     加速键拼错只是注册不上。所以除了正向断言，套件里还有**反向用例**
     （故意写坏的模板必须被审查器拒绝），否则门禁等于恒真。 */
  {
    id: 'desktop',
    title: '纯函数 · 桌面集成：菜单模板 / 加速键合法性与唯一性 / 命令表接线 / 图标点阵（Node）',
    kind: 'node',
    script: path.join(ROOT, 'test', 'desktop.test.js'),
    run: function (ctx) {
      const check = ctx.check;
      check('桌面集成纯函数测试全部通过', ctx.code === 0,
        '退出码 ' + ctx.code + (ctx.tail ? ' | ' + ctx.tail : ''));
    },
  },

  /* ---------- 1c. 打开性能：大图 × 大目录的真实耗时与机制 ---------- */
  {
    id: 'perf',
    title: '打开性能 · 文件头取尺寸 / 解码即降采样 / 缩略图落盘（二次打开零解码）',
    kind: 'probe',
    script: 'probe_perf.js',
    key: 'PERF ',
    tags: ['slow'],
    run: function (ctx) {
      const check = ctx.check, d = ctx.data;
      if (!d || !d.first || !d.second) { check('探针返回数据', false, '未解析到 PERF 输出'); return; }
      const imgs = d.images || [];

      /* ① 尺寸来源：读文件头 vs 浏览器真实解码，必须逐张完全一致。
            这条是整条优化链路的地基 —— 缩略图改成降采样解码后，尺寸不能再从
            解码产物里拿，只能靠读文件头；读错了整屏瓦片都会排错形状。 */
      const xc = d.xcheck || [];
      check('文件头解析的宽高与浏览器真实解码逐张一致',
        xc.length >= 4 && xc.every(function (x) { return x.match === true; }),
        xc.map(function (x) { return x.name + '=' + (x.match ? 'OK' : '不一致'); }).join(' '));
      check('尺寸探测只需读文件头（不需要解码）',
        !!(d.sizeApi && d.sizeApi.imageSizeIsFn && d.sizeApi.hasReadHead),
        JSON.stringify(d.sizeApi && { fn: d.sizeApi.imageSizeIsFn, rh: d.sizeApi.hasReadHead }));
      const via = d.sizeApi && d.sizeApi.viaApi;
      check('尺寸探测 API 返回的宽高正确',
        !!(via && imgs[0] && via.w === imgs[0].w && via.h === imgs[0].h),
        JSON.stringify(via) + ' 期望 ' + (imgs[0] ? imgs[0].w + '×' + imgs[0].h : '?'));

      /* ② 尺寸库必须存「原图真实尺寸」。
            降采样解码的产物尺寸远小于原图；若把它当原图尺寸写进缓存，
            下次打开整屏布局就全错了（而且是悄悄错）。 */
      const it0 = d.first.items || [];
      const wrongDim = it0.filter(function (it, i) {
        return !imgs[i] || it.w !== imgs[i].w || it.h !== imgs[i].h;
      });
      check('尺寸库存的是原图真实尺寸（不是缩略图尺寸）',
        it0.length >= 4 && wrongDim.length === 0,
        it0.map(function (it, i) { return it.name + ':' + it.w + '×' + it.h + (imgs[i] ? '(应' + imgs[i].w + '×' + imgs[i].h + ')' : ''); }).join(' '));

      /* ③ 降采样不能改变宽高比 */
      const badAr = it0.filter(function (it, i) {
        if (!imgs[i]) return true;
        const t = imgs[i].w / imgs[i].h;
        return Math.abs(it.ratio - t) / t > 0.01;
      });
      check('降采样后宽高比与原图一致（误差 <1%）', badAr.length === 0, badAr.map(function (x) { return x.name; }).join(','));

      const tooBig = (d.first.shown || []).filter(function (s) { return Math.max(s.nw, s.nh) > 1600; });
      check('缩略图最长边不超过上限 1600px', tooBig.length === 0,
        (d.first.shown || []).map(function (s) { return s.nw + '×' + s.nh; }).join(' '));

      /* ④ 首开：走的是降采样解码，没有掉到 <img> 全解兜底 */
      const st1 = d.first.stats || {};
      check('首开全部走「解码即降采样」路径（无 <img> 兜底）',
        st1.viaBitmap >= d.first.itemCount && st1.viaImg === 0,
        'decodes=' + st1.decodes + ' bitmap=' + st1.viaBitmap + ' img=' + st1.viaImg);
      check('首开所有瓦片都真的显示出图了',
        d.first.allOk === true && d.first.tileCount >= d.first.itemCount,
        'tiles=' + d.first.tileCount + '/' + d.first.itemCount);

      /* ⑤ 二次打开：零解码、全命中落盘缓存 —— 这是「图片多时打开慢」的主修项 */
      const st2 = d.second.stats || {};
      check('落盘缓存的条数 = 图片数', d.cacheBefore && d.cacheBefore.count === d.first.itemCount,
        JSON.stringify(d.cacheBefore));
      check('二次打开零解码（全部命中缩略图落盘缓存）', st2.decodes === 0,
        'decodes=' + st2.decodes + ' diskHits=' + st2.diskHits + ' misses=' + st2.misses);
      check('二次打开的每一次取图都来自磁盘命中',
        st2.diskHits >= d.second.itemCount && st2.misses === 0,
        'diskHits=' + st2.diskHits + ' 需≥' + d.second.itemCount + '，misses=' + st2.misses);
      check('二次打开出图更快（至少 2×）', d.second.allMs * 2 <= d.first.allMs,
        '首开 ' + d.first.allMs + 'ms → 二开 ' + d.second.allMs + 'ms');

      /* ⑥ 降采样解码本身的契约（不做速度断言 —— 实测与全量解码持平：
            熵解码不随缩放减少，省的是 IDCT 与峰值内存，见更新说明） */
      const ab = d.decodeAB || {};
      check('降采样输出正是请求的像素尺寸',
        ab.decodeSmallPx === '640x427' && ab.decodeFullPx === (ab.srcW + 'x' + ab.srcH),
        'full=' + ab.decodeFullPx + ' small=' + ab.decodeSmallPx);
      check('只给一边时浏览器自动保持宽高比',
        !!ab.arTrue && Math.abs(ab.arOnlyWidth - ab.arTrue) / ab.arTrue < 0.01,
        'arTrue=' + ab.arTrue + ' arOnlyWidth=' + ab.arOnlyWidth + ' (' + ab.onlyWidthPx + ')');
      check('降采样不慢于全量解码（速度持平即可，防止回退）',
        ab.decodeSmallMs <= ab.decodeFullMs * 2,
        'full=' + ab.decodeFullMs + 'ms small=' + ab.decodeSmallMs + 'ms');
    },
  },

  /* ---------- 2. 打包链路门禁：ZIP 写入器的 CRC 正确性与 7-Zip 兼容 ---------- */
  {
    id: 'zip',
    title: '打包链路 · ZIP CRC / 结构 / 7-Zip 第三方复验',
    kind: 'node',
    script: path.join(HERE, 'zip_gate.js'),
    quickFlag: true,
    tags: ['core'],
    run: function (ctx) {
      const check = ctx.check;
      let d = null;
      try { d = JSON.parse(String(ctx.tail || '').replace(/^ZIPGATE\s*/, '')); } catch (e) { d = null; }
      if (!d) { check('门禁脚本返回可解析结果', false, String(ctx.tail || '').slice(0, 200)); return; }

      check('CRC 实现自检通过（标准向量 + 原生/JS 表交叉验证）', d.crcSelfTestOk === true, d.crcSource);
      // 这一条就是 v1.5.0 翻车的那个 bug：CRC 算在压缩后字节流上
      check('「CRC 算在压缩流上」的坏包被判失败', d.badRejected === true, d.badReason || '');
      check('坏包失分点正是 CRC（实算值与声明值不符）', d.badCrcBad === 1, 'crcBad=' + d.badCrcBad);
      // 与坏包只差 CRC 一个变量的对照组必须通过 → 失败归因于 CRC，而非别的结构问题
      check('仅差 CRC 一个变量的对照组被判通过', d.controlAccepted === true);

      if (d.electronZipExists && !d.electronSkipped) {
        check('Electron 大包全部条目 CRC 正确、内容与源一致',
          d.electronOk === true && d.electronCrcBad === 0 && d.electronContentBad === 0,
          '条目 ' + d.electronEntries + ' / CRC 错误 ' + d.electronCrcBad + ' / 内容不符 ' + d.electronContentBad);
      }

      if (d.sevenZipFound) {
        if (d.electronZipExists && !d.electronSkipped) {
          check('7-Zip 复验 Electron 大包：无任何 CRC Failed',
            d.sevenZipElectronOk === true && d.sevenZipElectronCrcFailed === 0,
            'CRC Failed 计数 ' + d.sevenZipElectronCrcFailed);
        }
      } else {
        check('7-Zip 未安装时跳过第三方复验（不视为失败）', true, '未找到 7z.exe');
      }
    },
  },

  /* ---------- 品牌图标：ICO 是手写的二进制容器，必须有门禁 ---------- */
  {
    id: 'icon',
    title: '品牌图标 · ICO 结构 / 内嵌 PNG 尺寸一致 / 反向用例（Node）',
    kind: 'node',
    script: path.join(HERE, 'icon_gate.js'),
    quickFlag: true,
    tags: ['core'],
    run: function (ctx) {
      const check = ctx.check;
      let d = null;
      try { d = JSON.parse(String(ctx.tail || '').replace(/^ICONGATE\s*/, '')); } catch (e) { d = null; }
      if (!d) { check('门禁脚本返回可解析结果', false, String(ctx.tail || '').slice(0, 200)); return; }

      check('brand/icon.ico 存在', d.exists === true, d.path);
      check('ICO 容器结构合法（头 / 目录项 / 数据区间 / 内嵌 PNG 尺寸一致）',
        d.ok === true,
        (d.errors && d.errors.length) ? d.errors.join(' | ') : (d.count + ' 个尺寸 / ' + d.bytes + ' 字节'));
      check('覆盖桌面所需尺寸 16/24/32/48/64/128/256',
        [16, 24, 32, 48, 64, 128, 256].every(function (s) { return (d.sizes || []).indexOf(s) >= 0; }),
        (d.sizes || []).join('/'));
      /* 反向用例：不通过的校验器等于没有校验器（同 zip 套件里"坏包必须被判失败"的思路） */
      check('反向用例全部被拒（坏包不会被放行）',
        d.reverseAllRejected === true && (d.reverseCases || []).length >= 3,
        (d.reverseCases || []).map(function (c) { return (c.rejected ? '✓' : '✗') + c.name; }).join('  '));
    },
  },

  /* ---------- 3. 三路径联合回归（核心门禁）---------- */
  {
    id: 'tf',
    title: '三路径联合回归 · 缩放 × 旋转 × 平移（真实 Electron）',
    kind: 'probe',
    script: 'probe_transform.js',
    key: 'TF ',
    tags: ['core', 'joint'],
    run: function (ctx) {
      const check = ctx.check, d = ctx.data;
      if (!d || !d.steps) { check('探针返回数据', false, '未解析到 TF 输出'); return; }
      const S = d.steps;
      const step = function (k) { return S[k]; };

      // A 适应态居中
      if (step('A1 fit')) {
        near(check, 'A1 适应态居中', step('A1 fit').centerDev.dx, 0);
        near(check, 'A1 适应态居中(纵)', step('A1 fit').centerDev.dy, 0);
      } else check('A1 适应态居中', false, '缺少步骤 A1');

      // B 不动点缩放（非中心）
      const b = step('B1 zoom@offcenter');
      if (b) {
        check('B1 首次缩放确实触发了边界夹取（场景有效）', b.drift1 && b.drift1.clamped === true);
        check('B1 未夹取时不漂移', b.drift2 && b.drift2.clamped === false, b.drift2 ? 'clamped=' + b.drift2.clamped : '无数据');
        if (b.drift2) {
          check('B1 不动点漂移 < ' + EPS_FOCAL + 'px', Math.max(b.drift2.px, b.drift2.py) <= EPS_FOCAL,
            'dx=' + round(b.drift2.px) + ' dy=' + round(b.drift2.py));
        }
      } else check('B1 不动点缩放', false, '缺少步骤 B1');

      // C 平移后再缩放（v1.4.x 隐藏缺陷的回归点）
      const c1 = step('C1 zoom@panned-offcenter'), c2 = step('C2 zoomout@panned-offcenter');
      if (c1 && c1.drift) {
        check('C1 场景未触发夹取（断言有效）', c1.drift.clamped === false, 'clamped=' + c1.drift.clamped);
        check('C1 平移后放大不漂移 < ' + EPS_FOCAL + 'px', Math.max(c1.drift.px, c1.drift.py) <= EPS_FOCAL,
          'dx=' + round(c1.drift.px) + ' dy=' + round(c1.drift.py));
        near(check, 'C1 放大后仍居中', c1.centerDev.dx, 0);
      } else check('C1 平移后放大不漂移', false, '缺少步骤 C1');
      if (c2 && c2.drift) {
        check('C2 平移后缩小不漂移 < ' + EPS_FOCAL + 'px', Math.max(c2.drift.px, c2.drift.py) <= EPS_FOCAL,
          'dx=' + round(c2.drift.px) + ' dy=' + round(c2.drift.py));
      } else check('C2 平移后缩小不漂移', false, '缺少步骤 C2');

      // C3 夹取精确、不露白
      const c3 = step('C3 clamp-exact');
      if (c3 && c3.noWhiteGap) {
        check('C3 大图不露白（左）', c3.noWhiteGap.left <= EPS, 'gap=' + round(c3.noWhiteGap.left));
        check('C3 大图不露白（上）', c3.noWhiteGap.top <= EPS, 'gap=' + round(c3.noWhiteGap.top));
      } else check('C3 夹取不露白', false, '缺少步骤 C3');

      // D 放大态下旋转 4 个角度都居中，且包围盒长宽互换
      const d1 = step('D1 rotate@zoomed');
      if (d1 && d1.each) {
        let bad = 0;
        d1.each.forEach(function (r) { if (Math.abs(r.dev.dx) > EPS || Math.abs(r.dev.dy) > EPS) bad++; });
        check('D1 放大态旋转 0/90/180/270 全部居中', bad === 0, bad + '/' + d1.each.length + ' 偏离');
      } else check('D1 旋转居中', false, '缺少步骤 D1');

      // E 平移态旋转：fit 复位平移且居中
      const e1 = step('E1 rotate@panned');
      if (e1) {
        near(check, 'E1 旋转后居中（横）', e1.dev.dx, 0);
        near(check, 'E1 旋转后居中（纵）', e1.dev.dy, 0);
      } else check('E1 旋转后居中', false, '缺少步骤 E1');

      // F 缩到装得下：受自由上限约束、不飞出视野
      const f1 = step('F1 shrink-bounded');
      if (f1) {
        check('F1 缩小后仍完整可见（图像小于舞台）', f1.fitsNow === true);
        check('F1 平移量被夹在自由上限内', d.invariants && d.invariants.shrinkBounded && d.invariants.shrinkBounded.withinFreeLimit === true,
          d.invariants && d.invariants.shrinkBounded ? 'tx=' + d.invariants.shrinkBounded.tx + ' limit=' + d.invariants.shrinkBounded.freeLimit : '无数据');
      } else check('F1 缩小后边界约束', false, '缺少步骤 F1');

      // G 大图四方向拖动 + 极限精确贴边
      const g1 = step('G1 big-pan-4dir');
      if (g1 && g1.dirs) {
        const moved = {};
        g1.dirs.forEach(function (x) { moved[x.dir] = x; });
        check('G1 上拖生效', moved.up && moved.up.moved.dy < -50, moved.up ? 'dy=' + moved.up.moved.dy : '');
        check('G1 下拖生效', moved.down && moved.down.moved.dy > 50, moved.down ? 'dy=' + moved.down.moved.dy : '');
        check('G1 左拖生效', moved.left && moved.left.moved.dx < -50, moved.left ? 'dx=' + moved.left.moved.dx : '');
        check('G1 右拖生效', moved.right && moved.right.moved.dx > 50, moved.right ? 'dx=' + moved.right.moved.dx : '');
        const allGrabbed = g1.dirs.every(function (x) { return x.grabbed === true; });
        const allReleased = g1.dirs.every(function (x) { return x.released === true; });
        check('G1 拖动过程进入抓取态', allGrabbed);
        check('G1 松手后退出抓取态', allReleased);
        check('G1 拖到极限精确贴边（不露白）', g1.edgeGap.left <= EPS && g1.edgeGap.top <= EPS,
          'left=' + round(g1.edgeGap.left) + ' top=' + round(g1.edgeGap.top));
      } else check('G1 四方向拖动', false, '缺少步骤 G1');

      // H 小图仍可拖动（用户明确要求：不管多大都能拖）
      const h1 = step('H1 small-pan');
      if (h1) {
        check('H1 小图确实小于舞台（前置条件）', h1.canPanSmall === false);
        check('H1 小图可拖动', Math.abs(h1.moved.dx - 120) <= 1 && Math.abs(h1.moved.dy - 80) <= 1,
          'dx=' + h1.moved.dx + ' dy=' + h1.moved.dy);
        check('H1 小图拖动时进入抓取态', h1.grabbed === true);
      } else check('H1 小图可拖动', false, '缺少步骤 H1');

      // I 混合序列（缩放→平移→旋转→缩放→平移）
      const i1 = step('I1 mixed-sequence');
      if (i1 && i1.seq) {
        const bad = i1.seq.filter(function (r) { return Math.abs(r.dev.dx) > EPS || Math.abs(r.dev.dy) > EPS; });
        check('I1 混合序列每一步都居中（' + i1.seq.length + ' 步）', bad.length === 0,
          bad.map(function (r) { return r.step + '(' + r.dev.dx + ',' + r.dev.dy + ')'; }).join(' '));
      } else check('I1 混合序列', false, '缺少步骤 I1');

      // 公式自洽：解析包围盒 == 实测矩形
      if (d.invariants && d.invariants.lastBox && d.invariants.lastRect) {
        near(check, '包围盒解析值与实测值一致（宽）', d.invariants.lastRect.w, d.invariants.lastBox.w, 1.5);
        near(check, '包围盒解析值与实测值一致（高）', d.invariants.lastRect.h, d.invariants.lastBox.h, 1.5);
      }
    },
  },

  /* ---------- 3. 居中定点 ---------- */
  {
    id: 'center',
    title: '居中定点 · 缩放/旋转后中心是否恒等于「舞台中心 + 平移量」',
    kind: 'probe',
    script: 'probe_center.js',
    key: 'CHECK ',
    run: function (ctx) {
      const check = ctx.check, d = ctx.data;
      if (!Array.isArray(d)) { check('探针返回数据', false, '未解析到 CHECK 输出'); return; }
      let bad = [];
      let skipped = 0;
      d.forEach(function (r) {
        // 探针中显式设定平移量的行，其期望值即为设定值（探针已自证），不参与「居中」断言
        if (/panned|expect offset/i.test(r.label)) { skipped++; return; }
        if (Math.abs(r.d.dx) > EPS || Math.abs(r.d.dy) > EPS) bad.push(r.label + '(' + r.d.dx + ',' + r.d.dy + ')');
      });
      check('非平移状态全部居中（' + (d.length - skipped) + ' 个）', bad.length === 0, bad.join(' '));
    },
  },

  /* ---------- 4. 旋转矩阵 ---------- */
  {
    id: 'rot',
    title: '旋转几何 · 用 DOMMatrix 解四角反推中心与包围盒',
    kind: 'probe',
    script: 'probe_rot_matrix.js',
    key: 'MX ',
    run: function (ctx) {
      const check = ctx.check, d = ctx.data;
      if (!Array.isArray(d)) { check('探针返回数据', false, '未解析到 MX 输出'); return; }
      let bad = [];
      d.forEach(function (r) {
        // 探针中显式设定平移量的行，允许非零偏差（其期望值即为设定值）
        if (/panned/i.test(r.label)) return;
        if (Math.abs(r.dev.dx) > EPS || Math.abs(r.dev.dy) > EPS) bad.push(r.label + '(' + r.dev.dx + ',' + r.dev.dy + ')');
      });
      check('非平移状态全部居中', bad.length === 0, bad.join(' '));
      // 旋转 90° 时包围盒必须「换向」。注意 rotate() 会顺带重新适应窗口，
      // 缩放倍数同时变化，所以不能比绝对尺寸，要比「长宽比取倒数 + 横竖朝向翻转」。
      const r0 = d.find(function (r) { return r.label === 'fit rot0'; });
      const r90 = d.find(function (r) { return r.label === 'rot90'; });
      if (r0 && r90 && r0.quad && r90.quad) {
        const ar0 = r0.quad.w / r0.quad.h;
        const ar90 = r90.quad.w / r90.quad.h;
        check('旋转 90° 后包围盒长宽比取倒数', Math.abs(ar90 - 1 / ar0) < 0.01,
          ar0.toFixed(4) + ' → ' + ar90.toFixed(4));
        check('旋转 90° 后横竖朝向翻转', r0.quad.w > r0.quad.h && r90.quad.h > r90.quad.w,
          r0.quad.w + 'x' + r0.quad.h + ' → ' + r90.quad.w + 'x' + r90.quad.h);
      } else check('旋转 90° 换向', false, '缺少 rot0 / rot90 数据');
    },
  },

  /* ---------- 5. 缩放与拖动 ---------- */
  {
    id: 'zoom',
    title: '缩放与拖动 · 滚轮零漂移 / 小图可拖 / 极限贴边',
    kind: 'probe',
    script: 'probe_zoom.js',
    key: 'RESULT ',
    run: function (ctx) {
      const check = ctx.check, d = ctx.data;
      if (!d || !d.s1_initial) { check('探针返回数据', false, '未解析到 RESULT 输出'); return; }
      near(check, 'S1 初始打开居中（横）', d.s1_initial.dev.dx, 0);
      near(check, 'S1 初始打开居中（纵）', d.s1_initial.dev.dy, 0);
      if (d.s2_wheel_center) {
        near(check, 'S2 滚轮缩放零漂移（横）', d.s2_wheel_center.drift.dx, 0);
        near(check, 'S2 滚轮缩放零漂移（纵）', d.s2_wheel_center.drift.dy, 0);
      }
      if (d.s3_zoom_out_center) {
        near(check, 'S3 缩小到适应比例以下仍居中（横）', d.s3_zoom_out_center.dev.dx, 0);
        near(check, 'S3 缩小到适应比例以下仍居中（纵）', d.s3_zoom_out_center.dev.dy, 0);
      }
      if (d.s4_fit_recenter) {
        near(check, 'S4 按「适应」后回正（横）', d.s4_fit_recenter.afterFit.dx, 0);
        near(check, 'S4 按「适应」后回正（纵）', d.s4_fit_recenter.afterFit.dy, 0);
      }
      if (d.s5_small_pan) {
        check('S5 小图可拖动', Math.abs(d.s5_small_pan.moved.dx) > 50 && Math.abs(d.s5_small_pan.moved.dy) > 40,
          'dx=' + d.s5_small_pan.moved.dx + ' dy=' + d.s5_small_pan.moved.dy);
      }
      if (d.s6_big_pan) {
        check('S6 大图可拖动', Math.abs(d.s6_big_pan.dragFwd.dx) > 50, 'dx=' + d.s6_big_pan.dragFwd.dx);
      }
      if (Array.isArray(d.s7_4dir)) {
        const bad = d.s7_4dir.filter(function (x) { return Math.abs(x.dx) + Math.abs(x.dy) < 50; });
        check('S7 四方向拖动全部生效', bad.length === 0, bad.map(function (x) { return x.dir; }).join(','));
      }
      if (d.s7b_bounds && d.s7b_bounds.edgeGap) {
        check('S7b 拖到极限精确贴边', (d.s7b_bounds.edgeGap.left || 0) <= EPS && (d.s7b_bounds.edgeGap.top || 0) <= EPS,
          JSON.stringify(d.s7b_bounds.edgeGap));
      }
      if (d.s9_rot_center) {
        near(check, 'S9 旋转后居中（横）', d.s9_rot_center.afterRotDev.dx, 0);
        near(check, 'S9 旋转后居中（纵）', d.s9_rot_center.afterRotDev.dy, 0);
      }
    },
  },

  /* ---------- 6. 双指缩放（触控板捏合 + 触摸屏）---------- */
  {
    id: 'pinch',
    title: '双指缩放 · 触控板捏合 / 触摸屏双指 / 与滚轮模式互不干扰',
    kind: 'probe',
    script: 'probe_pinch.js',
    key: 'PINCH ',
    tags: ['core'],
    run: function (ctx) {
      const check = ctx.check, d = ctx.data;
      if (!d || !d.ctrlWheel) { check('探针返回数据', false, '未解析到 PINCH 输出'); return; }

      // 触控板捏合（ctrlKey + wheel）
      const cw = d.ctrlWheel;
      check('触控板捏合放大', cw.afterIn.scale > cw.before.scale,
        cw.before.scale + ' → ' + cw.afterIn.scale);
      check('触控板捏合缩小', cw.afterOut.scale < cw.afterIn.scale,
        cw.afterIn.scale + ' → ' + cw.afterOut.scale);
      near(check, '捏合过程中保持居中（横）', cw.centerDev.dx, 0);
      near(check, '捏合过程中保持居中（纵）', cw.centerDev.dy, 0);

      // 捏合中心为不动点
      if (d.ctrlWheelFocal) {
        check('触控板捏合以光标为不动点', Math.max(d.ctrlWheelFocal.px, d.ctrlWheelFocal.py) <= EPS_FOCAL,
          'dx=' + round(d.ctrlWheelFocal.px) + ' dy=' + round(d.ctrlWheelFocal.py));
      } else check('触控板捏合不动点', false, '缺少 ctrlWheelFocal');

      // 触摸屏双指
      const tp = d.touchPinch;
      if (tp) {
        // 先确认前提成立：这一轮测的确实是一张已解码、有尺寸的图。
        // 少了这一条，"图还没加载完就量几何"会伪装成"居中坏了"。
        check('前置：切图后新图已解码完成（有真实尺寸）',
          tp.loaded === true && tp.naturalW > 0 && tp.lw > 0,
          'loaded=' + tp.loaded + ' naturalW=' + tp.naturalW + ' L.nw=' + tp.lw);
        near(check, '双指张开倍数与指距比一致', tp.spreadRatio, tp.expectedSpread, 0.02, '×');
        near(check, '双指捏合倍数与指距比一致', tp.pinchRatio, tp.expectedPinch, 0.02, '×');
        near(check, '双指缩放过程居中（横）', tp.centerDev.dx, 0);
        near(check, '双指缩放过程居中（纵）', tp.centerDev.dy, 0);
      } else check('触摸屏双指缩放', false, '缺少 touchPinch');
      if (d.touchFocal) {
        check('双指中点是不动点', Math.max(d.touchFocal.px, d.touchFocal.py) <= EPS_FOCAL,
          'dx=' + round(d.touchFocal.px) + ' dy=' + round(d.touchFocal.py));
      } else check('双指中点不动点', false, '缺少 touchFocal');

      // 与滚轮模式互不干扰
      if (d.pinchVsNavMode) {
        check('nav 滚轮模式下捏合仍缩放（手势优先）',
          d.pinchVsNavMode.afterScale > d.pinchVsNavMode.beforeScale && d.pinchVsNavMode.navUnchanged === true,
          'scale ' + d.pinchVsNavMode.beforeScale + ' → ' + d.pinchVsNavMode.afterScale + '，切图 ' + d.pinchVsNavMode.idxBefore + '→' + d.pinchVsNavMode.idxAfter);
      } else check('nav 模式下捏合仍缩放', false, '缺少 pinchVsNavMode');
      if (d.navWheelStillWorks) {
        check('nav 模式下普通滚轮仍切图（回归）', d.navWheelStillWorks.navigated === true);
      }

      // 手势互斥与拖动回归
      const pc = d.pinchCancelsDrag;
      if (pc) {
        check('双指落下前单指拖动处于进行中（前置条件）', pc.draggingMid === true);
        check('双指落下即中止单指拖动', pc.draggingAfterTouch === false);
        check('捏合期间不再发生平移', pc.movedDuringPinch.dx === 0 && pc.movedDuringPinch.dy === 0,
          'dx=' + pc.movedDuringPinch.dx + ' dy=' + pc.movedDuringPinch.dy);
      } else check('双指与单指拖动互斥', false, '缺少 pinchCancelsDrag');
      if (d.singleDragStillWorks) {
        near(check, '单指拖动仍生效（回归·横）', d.singleDragStillWorks.dx, -90, 1);
        near(check, '单指拖动仍生效（回归·纵）', d.singleDragStillWorks.dy, -70, 1);
      }

      // 缩放上下限
      if (d.clamped) {
        near(check, '连续捏合放大被上限夹住', d.clamped.max, d.clamped.maxAllowed, 0.01, '×');
        near(check, '连续捏合缩小被下限夹住', d.clamped.min, d.clamped.minAllowed, 0.01, '×');
      }
    },
  },

  /* ---------- 7. 全屏贴边 ---------- */
  {
    id: 'fs',
    title: '全屏 · 图片长边是否贴到屏幕边缘',
    kind: 'probe',
    script: 'probe_fs.js',
    key: 'FS ',
    tags: ['slow'],
    run: function (ctx) {
      const check = ctx.check, d = ctx.data;
      if (!d || !Array.isArray(d.cases)) { check('探针返回数据', false, '未解析到 FS 输出'); return; }
      let bad = [];
      d.cases.forEach(function (c) {
        const m = c.inFs;
        if (!m) { bad.push(c.name + '(缺少全屏数据)'); return; }
        const g = m.gap;
        // 长边贴边：上下或左右必须有一对接近 0
        const vertEdge = Math.abs(g.top) <= 1.5 && Math.abs(g.bottom) <= 1.5;
        const horizEdge = Math.abs(g.left) <= 1.5 && Math.abs(g.right) <= 1.5;
        if (!vertEdge && !horizEdge) bad.push(c.name + '(留白 ' + g.left + '/' + g.top + '/' + g.right + '/' + g.bottom + ')');
        if (m.ctr && (Math.abs(m.ctr.dx) > EPS || Math.abs(m.ctr.dy) > EPS)) bad.push(c.name + '(未居中)');
      });
      check('全部 ' + d.cases.length + ' 张照片全屏后长边贴边且居中', bad.length === 0, bad.join(' '));
    },
  },

  /* ---------- 7b. 灯箱操作区 · 关闭键位置 / 图标不重复 / 激活态语义 ----------
     这一套守三件容易回退的小事：
     ① 关闭键必须在右上角（上一版挪到左上，用户要求挪回）；
     ② HUD 里不能有两颗按钮用同一个图标（原来左右旋转共用一个 #i-rotate、
        滚轮切图借用放大镜 #i-search、适应窗口与全屏都是四角折线）；
     ③ 激活态颜色分语义：面板/模式类=蓝，收藏=黄。
     颜色断言用"哪个通道更高"判色相，不写死色号 —— 换主题换色号时不该变红。 */
  {
    id: 'lbui',
    title: '灯箱操作区 · 关闭键在右上 / 图标互不重复 / 激活态蓝黄分语义',
    kind: 'probe',
    script: 'probe_lb_ui.js',
    key: 'LBUI ',
    run: function (ctx) {
      const check = ctx.check, d = ctx.data;
      if (!d || !d.normal) { check('探针返回数据', false, '未解析到 LBUI 输出'); return; }
      const n0 = d.normal, w0 = d.withInfo || {};
      const c0 = n0.close, c1 = w0.close || {};
      const rgb = function (s) {
        const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(s || '');
        return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
      };

      check('关闭键在右上角（右侧留白 ≤ 24px）', c0.right <= 24, 'right=' + c0.right + ' left=' + c0.left);
      check('关闭键在右上角（水平位置越过中线）', c0.left > n0.vw / 2, 'left=' + c0.left + ' vw=' + n0.vw);
      check('关闭键尺寸未被压扁（40×40）', Math.abs(c0.w - 40) <= 1 && Math.abs(c0.h - 40) <= 1,
        c0.w + '×' + c0.h);
      check('关闭键默认可见（沉浸态不藏退出入口）', c0.opacity >= 0.8, 'opacity=' + c0.opacity);

      // 开信息面板后关闭键不该横跳（面板 top:72，键底 56，竖向不重叠）
      check('开信息面板后关闭键位置不变（不横跳）',
        c1.right !== undefined && Math.abs(c1.right - c0.right) <= 1 && Math.abs(c1.top - c0.top) <= 1,
        'normal right=' + c0.right + ' withInfo right=' + c1.right);
      check('开信息面板后 HUD 让开面板', w0.hud && w0.hud.right > 300, w0.hud && w0.hud.right);

      // 图标不重复
      const btns = n0.buttons || [];
      const icons = btns.map(function (b) { return b.icon; });
      const dup = icons.filter(function (v, i) { return icons.indexOf(v) !== i; });
      check('操作栏按钮已全部采到（11 颗）', btns.length === 11, 'n=' + btns.length);
      check('操作栏没有重复图标', btns.length > 0 && dup.length === 0,
        'dup=' + JSON.stringify(dup) + ' icons=' + JSON.stringify(icons));
      check('每颗按钮都有 aria-label', btns.length > 0 && btns.every(function (b) { return !!b.label; }),
        JSON.stringify(btns.filter(function (b) { return !b.label; }).map(function (b) { return b.id; })));

      // 滚轮按钮：默认鼠标图标；切到 nav 变左右箭头，且两者不同
      const wv = d.wheelNav || {};
      const wheelBtn = btns.filter(function (b) { return b.id === 'lbWheel'; })[0] || {};
      check('滚轮按钮默认用「鼠标」图标而非放大镜', wheelBtn.icon === '#i-wheel', wheelBtn.icon);
      check('滚轮切到切图模式后换成左右箭头', wv.icon === '#i-arrows-h', wv.icon);
      check('滚轮两种模式的图标确实不同', !!wheelBtn.icon && wheelBtn.icon !== wv.icon,
        wheelBtn.icon + ' vs ' + wv.icon);

      // 激活态语义：面板类=蓝，收藏=黄
      const infoBtn = (w0.buttons || []).filter(function (b) { return b.id === 'lbInfo'; })[0] || {};
      const ci = rgb(infoBtn.color), cw = rgb(wv.color), cf = rgb((d.fav || {}).color);
      check('信息面板打开后按钮标记为激活', infoBtn.on === true);
      check('面板类激活态是蓝色（B 通道明显高于 R）', !!ci && ci.b > ci.r + 40, infoBtn.color);
      check('滚轮切图模式也是蓝色（与收藏区分）', !!cw && cw.b > cw.r + 40, wv.color);
      check('收藏激活态是黄色（R/G 明显高于 B）', !!cf && cf.r > cf.b + 40 && cf.g > cf.b + 40,
        (d.fav || {}).color);
    },
  },

  /* ---------- 8. 设置面板 ---------- */
  {
    id: 'settings',
    title: '设置面板 · 开合 / 逐项生效 / 持久化 / 双向同步 / 清除缓存 / 关于 / 恢复默认',
    kind: 'probe',
    script: 'probe_settings.js',
    keys: ['S1 ', 'S2 ', 'S3 ', 'S4 ', 'S5 ', 'S6 ', 'S7 ', 'S8 '],
    tags: ['slow'],
    run: function (ctx) {
      const check = ctx.check;
      const s1 = ctx.keys['S1 '], s2 = ctx.keys['S2 '], s3 = ctx.keys['S3 '],
        s4 = ctx.keys['S4 '], s5 = ctx.keys['S5 '], s6 = ctx.keys['S6 '], s7 = ctx.keys['S7 '],
        s8 = ctx.keys['S8 '];
      if (!s1) { check('探针返回数据', false, '未解析到 S1 输出'); return; }
      /* s2…s8 每一块都被 `if (sX)` 包着 —— 探针某一步抛错时 sX 为 undefined，
         那一整段断言就**静默不跑**，套件照样全绿。所以先显式断言"每一步都有输出"。
         这正是 v1.11.0 查到的假绿：`window.State.defaults()`（它其实是 getter，
         不是函数）让 S8 整段消失，于是"相框转正"的断言**一条都没执行过**。 */
      const stepMiss = [['S2', s2], ['S3', s3], ['S4', s4], ['S5', s5],
        ['S6', s6], ['S7', s7], ['S8', s8]]
        .filter(function (p) { return !p[1]; }).map(function (p) { return p[0]; });
      check('探针每一步都有输出（缺步 = 那一段断言被静默跳过）',
        stepMiss.length === 0, '缺失: ' + (stepMiss.join(',') || '无'));
      check('设置面板可打开', s1.panelOpen === true);
      check('面板挂载在 body（规避 overflow 裁剪）', s1.panelParent === 'BODY');
      check('面板在视口内', s1.inViewport === true);
      check('面板可命中点击（未被遮挡）', s1.hitInsidePanel === true);
      // 分组数由「设置项定义」推导，加分组不必再改断言
      const ex = s1.expect || {};
      check('分组数与定义一致', s1.groups.length === ex.groupCount,
        'DOM ' + s1.groups.length + ' vs 定义 ' + ex.groupCount + ' [' + s1.groups.join('/') + ']');
      check('面板行数与定义一致', s1.rowCount === ex.rows, 'DOM ' + s1.rowCount + ' vs 定义 ' + ex.rows);
      check('开关 / 分段 / 数字控件数量与定义一致',
        s1.switches === ex.switches && s1.segs === ex.segs && s1.nums === ex.nums,
        'DOM ' + s1.switches + '/' + s1.segs + '/' + s1.nums + ' vs 定义 ' + ex.switches + '/' + ex.segs + '/' + ex.nums);
      check('P1-4 旋转记录入口已就位',
        Array.isArray(ex.keys) && ex.keys.indexOf('__clearRots') >= 0,
        JSON.stringify(ex.keys));
      /* 按钮必须"有线可接" —— 每个 type:'button' 的键都要在 Settings.actions 里有实现。
         这就是 v1.6.0「清空缩略图缓存」静默失效的根因防线：
         当时按钮定义在、DOM 也在，只是点击分支漏了它，任何"面板渲染正确"的断言都发现不了。 */
      const btnKeys = ex.buttonKeys || [], actKeys = ex.actionKeys || [];
      const unWired = btnKeys.filter(function (k) { return actKeys.indexOf(k) < 0; });
      check('每个按钮类设置项都有对应实现（无静默失效按钮）',
        btnKeys.length >= 4 && unWired.length === 0,
        'buttons=' + btnKeys.join(',') + ' | 未接线=' + (unWired.join(',') || '无'));
      check('v1.7.0 新入口就位（清除缓存 / 关于 / 窗口置顶）',
        ['清除缓存', '关于 Atrium', '窗口置顶'].every(function (n) { return (s1.rowNames || []).indexOf(n) >= 0; }),
        (s1.rowNames || []).join('/'));
      if (s2) {
        check('主题切换生效（状态 + DOM）', s2.themeSetting === 'dark' && s2.bodyTheme === 'dark');
        /* 深色判据用亮度，不写死色值：设计系统换色时测试不该跟着改。
           这条断言要守的语义是"切到深色主题后背景真的变暗了"，
           不是"背景恰好是 #171614"。（v1.16.0 UI 重构换了中性深色） */
        const bgDarkLum = (() => {
          const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(s2.bgDark || ''));
          if (!m) return NaN;
          const ch = [m[1], m[2], m[3]].map((v) => {
            const x = Number(v) / 255;
            return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
          });
          return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
        })();
        check('深色主题背景变量生效（背景确实变暗）', bgDarkLum < 0.2,
          s2.bgDark + ' lum=' + (isNaN(bgDarkLum) ? 'NaN' : bgDarkLum.toFixed(3)));
        check('紧凑密度生效（顶栏变矮）', s2.densitySetting === 'compact' && s2.bodyDensity === 'compact' && parseFloat(s2.topbarH) <= 52, s2.topbarH);
        check('文件名常显生效（状态与 DOM 一致）', String(s2.showNames ? 1 : 0) === s2.bodyShowNames,
          'setting=' + s2.showNames + ' body[data-show-names]=' + s2.bodyShowNames);
        check('数量角标开关生效（状态与 DOM 一致）', (s2.showCnt === false) === (s2.cntDisplay === 'none'),
          'setting=' + s2.showCnt + ' display=' + s2.cntDisplay);
        check('滚轮模式生效（nav）', s2.wheelMode === 'nav' && s2.lbWheelMode === 'nav');
        check('切换动画关闭生效', s2.animOn === false && s2.bodyAnim === '0');
        check('幻灯片间隔生效（6000ms）', s2.slideshowMs === 6000 && s2.lbPlayMs === 6000);
        check('删除二次确认关闭生效', s2.confirmDelete === false);
        /* v1.14.0：「检查更新」是本应用**唯一**会出网的开关，默认必须是关的
           （关于面板里写着"默认完全不出网"，这条断言就是那句话的凭据）。 */
        check('「检查更新」开关就位且默认关闭（默认不出网）',
          s2.updRowExists === true && s2.updDefaultOff === true,
          'row=' + s2.updRowExists + ' defaultOff=' + s2.updDefaultOff);
      }
      if (s3) {
        check('设置已持久化到 localStorage', s3.theme === 'dark' && s3.density === 'compact' && s3.slideshowMs === 6000);
      }
      if (s4) {
        check('顶栏眼睛 ↔ 面板开关双向同步', s4.switchSynced === true);
        check('恢复默认后与 defaults() 完全一致', s4.defaultsMatch === true);
        check('Esc 可关闭面板', s4.closedByEsc === true);
      }
      if (s5) {
        check('窄窗口下仍可打开', s5.open === true && s5.inViewport === true);
        check('窄窗口下面板可点击', s5.clickable === true);
      }
      if (s6) {
        /* 清除缓存：造缩略图 + 尺寸缓存 → 点按钮 → 确认 → 必须真的清零。
           探针用的是持久分区，缓存条数会跨轮累计，所以"造得出来"只断言 ≥ 造入量，
           真正的判据是「确认后归零」。 */
        check('缓存造得出来（前置条件）', s6.beforeThumb >= 3 && s6.beforeDimMem >= 2,
          'thumb=' + s6.beforeThumb + ' dimMem=' + s6.beforeDimMem);
        check('「清除缓存」按钮存在且有可读文案',
          s6.cacheRowExists === true && s6.cacheBtnLabel === '清除', 'label=' + s6.cacheBtnLabel);
        check('点击后弹出确认层，并说明不会删除原图',
          s6.cacheModalOpen === true && s6.cacheSaysNoPhotoDelete === true,
          'title=' + s6.cacheModalTitle);
        check('确认层报的条数来自真实统计',
          s6.cacheShowsThumbCount === true && s6.cacheShowsDimCount === true,
          (s6.cacheModalBody || '').slice(0, 90));
        check('确认后缩略图落盘缓存真的被清空', s6.afterThumb === 0, 'after=' + s6.afterThumb);
        check('确认后尺寸缓存（内存）也清空', s6.afterDimMem === 0, 'afterMem=' + s6.afterDimMem);
        check('清完给出结果反馈（清除是异步的，轮询等待而不是固定等待）',
          /已清除缓存/.test(s6.toastText || ''),
          (s6.toastText || '(空)') + ' @' + s6.toastWaitMs + 'ms');
        /* 关于面板 */
        check('「关于 Atrium」入口存在', s6.aboutRowExists === true);
        check('关于面板可打开，标题正确', s6.aboutOpen === true && s6.aboutTitle === '关于 Atrium', s6.aboutTitle);
        check('关于面板带品牌名、版本号与版本身份',
          s6.aboutBrand === 'Atrium' && /^v\d+\.\d+\.\d+$/.test(s6.aboutVersion || '') && !!s6.aboutTag,
          'brand=' + s6.aboutBrand + ' ver=' + s6.aboutVersion + ' tag=' + s6.aboutTag);
        check('版本号与 App.VERSION 一致（不是写死的字符串）',
          /^\d+\.\d+\.\d+$/.test(s6.appVersionRaw || '') && s6.aboutVersion === 'v' + s6.appVersionRaw,
          'about=' + s6.aboutVersion + ' app=v' + s6.appVersionRaw);
        check('关于面板含功能/隐私/数据/技术四段介绍',
          ['能做什么', '隐私', '数据放在哪', '技术'].every(function (t) { return (s6.aboutSections || []).indexOf(t) >= 0; }),
          (s6.aboutSections || []).join('/'));
        /* v1.14.0：关于面板新增「开源与更新」段（GitHub 信息 + 检查更新入口）。
           这几条同时钉住两件事：① 关于面板不再说"数据在 %APPDATA%"（那是便携化之前的事实）；
           ② 两条外链都走主进程白名单 IPC，**不是**让窗口自己导航
              （主窗口的 will-navigate 会拦外链 —— 不接管的话点了就是"没反应"）。 */
        check('关于面板有「开源与更新」段（GitHub 信息）',
          (s6.aboutSections || []).indexOf('开源与更新') >= 0,
          (s6.aboutSections || []).join('/'));
        check('关于面板的数据位置说明已随便携化更新（不再写 %APPDATA%）',
          /应用目录下的 data 子目录/.test(s6.aboutTextAll || '')
            && (s6.aboutTextAll || '').indexOf('%APPDATA%') < 0,
          (s6.aboutTextAll || '').slice(0, 200));
        check('「关于」里的仓库链接指向官方仓库', s6.repoLinkHref === 'https://github.com/jhlxlml/Atrium',
          s6.repoLinkHref);
        check('「检查更新」入口就位（能力可用时）', s6.updBtnExists === true);
        check('检查更新就地出结果，且如实报「发现新版本」（不误报成已是最新）',
          /发现新版本 v9\.9\.9/.test(s6.updResultText || ''), s6.updResultText);
        check('发现新版本后给出「查看」外链（指向 Release 详情页）',
          s6.updLinkHref === 'https://github.com/jhlxlml/Atrium/releases/tag/v9.9.9'
            && s6.updBtnReEnabled === true,
          'href=' + s6.updLinkHref + ' reEnabled=' + s6.updBtnReEnabled);
        check('两条外链都走主进程白名单 IPC 打开（窗口自身不导航）',
          Array.isArray(s6.extCalls) && s6.extCalls.length === 2
            && s6.extCalls[0] === 'https://github.com/jhlxlml/Atrium'
            && s6.extCalls[1] === 'https://github.com/jhlxlml/Atrium/releases/tag/v9.9.9',
          JSON.stringify(s6.extCalls));
        check('关于面板有能力清单且无占位符残留',
          (s6.aboutBullets || 0) >= 5 && s6.aboutHasPlaceholder === false,
          'bullets=' + s6.aboutBullets + ' placeholder=' + s6.aboutHasPlaceholder);
        check('关于是单按钮弹窗（不需要"取消/确定"二选一）', s6.aboutActionBtns === 1, 'btns=' + s6.aboutActionBtns);
        check('关于面板不超出视口', s6.aboutFitsViewport === true);
        check('关于弹窗截图时仍保持打开（用于留档）', s6.aboutStillOpen === true);
        if (s7) {
          check('关于面板可关闭，且只有一个动作按钮',
            s7.hadCard === true && s7.count === 1 && s7.closed === true,
            'btns=' + s7.count + ' label=' + s7.firstLabel + ' closed=' + s7.closed);
        }
        /* 相框：v1.11.0 起**转为正式功能**（默认开启）。v1.8.1~v1.10.0 期间它是
           "实验功能、默认隐藏"，那几条断言在此**反向**而不是删除 ——
           否则会出现"代码转了正、断言还锁着旧行为"的矛盾。 */
        if (s8) {
          check('相框默认开启（已转正）：defaults().showFrame 为 true，分组标题不再写「实验」',
            s8.defaultShowFrame === true
              && s8.hasFrameGroup === true
              && s8.frameGroupTitle === '相框',
            'default=' + s8.defaultShowFrame + ' title=' + s8.frameGroupTitle);
          check('显式关掉后：分组只露「显示相框入口」一个开关',
            (s8.rowsCollapsed || []).length === 0
              && s8.switchRowPresent === true
              && s8.settingAfterForceOff === true,
            'title=' + s8.frameGroupTitle + ' collapsedRows=' + (s8.rowsCollapsed || []).join('/')
              + ' switch=' + s8.switchRowPresent + ' setting=' + s8.settingAfterForceOff);
          check('关掉后顶栏图标隐藏',
            s8.iconHiddenAfterForceOff === true);
          check('打开开关后五项回来（相册/间隔/填充/停靠边/开始）+ 图标出现 + 落盘',
            (s8.rowsAfterEnable || []).length === 5
              && s8.iconShownAfterEnable === true
              && s8.settingAfterEnable === true
              && s8.persistedShowFrame === true,
            (s8.rowsAfterEnable || []).join('/') + ' icon=' + s8.iconShownAfterEnable
              + ' state=' + s8.settingAfterEnable + ' ls=' + s8.persistedShowFrame);
          check('关掉开关后分组重新收起、图标重新隐藏',
            (s8.rowsAfterDisable || []).length === 0
              && s8.iconHiddenAfterDisable === true && s8.settingAfterDisable === false,
            'rows=' + (s8.rowsAfterDisable || []).join('/') + ' icon='
              + s8.iconHiddenAfterDisable + ' setting=' + s8.settingAfterDisable);
          check('相框相册可选「全部图片 / 只看收藏 / 每个文件夹」',
            s8.selectExists === true && s8.hasAll === true && s8.hasFav === true
              && s8.folderOpts === 2 && s8.folderNames === true,
            (s8.optionTexts || []).join(' | '));
          check('选定文件夹后写入设置并落盘',
            s8.srcAfterPick === 's1' && s8.persisted === 's1',
            'state=' + s8.srcAfterPick + ' ls=' + s8.persisted);
          check('文件夹被移除后下拉重建，旧值回落「全部图片」',
            (s8.optionsAfterRemove || []).indexOf('s1') < 0
              && s8.selectValueAfterRemove === 'all' && s8.srcAfterRemove === 'all',
            JSON.stringify({ opts: s8.optionsAfterRemove, val: s8.selectValueAfterRemove, src: s8.srcAfterRemove }));
          check('更换间隔以「秒」呈现、写入毫秒',
            !!s8.msInput && s8.msInput.value === '6' && s8.msInput.min === '2'
              && s8.msSet === 15000,
            JSON.stringify(s8.msInput) + ' set=' + s8.msSet);
          check('填充方式有「适应 / 填满」且能切换',
            (s8.fitOptions || []).join('/') === '适应/填满' && s8.fitSet === 'cover',
            (s8.fitOptions || []).join('/') + ' set=' + s8.fitSet);
          /* v1.9.0：窗口停靠边 —— 拖动吸附与设置锁边是同一个值 */
          check('设置里有「窗口停靠边」，选项为不吸附 / 四边，默认不吸附',
            s8.dockRowExists === true && s8.dockOptionsOk === true && s8.dockDefaultNone === true,
            (s8.dockOptionValues || []).join(',') + ' default=' + s8.dockDefaultNone);
          check('选定停靠边后写入设置并落盘，改回「不吸附」也能复位',
            s8.dockAfterPick === 'right' && s8.dockPersisted === 'right' && s8.dockResetTo === 'none',
            'pick=' + s8.dockAfterPick + ' ls=' + s8.dockPersisted + ' reset=' + s8.dockResetTo);
          check('「开始相框」按钮已接线且有对应实现',
            s8.frameKeyIsButton === true && s8.frameActionWired === true);
          /* 「恢复默认」的重放表（Settings.ALL_KEYS）必须覆盖**设置面板里的每一行**。
             老写法是手工列 3 个键（showFrame / frameDock / frameDisplay）—— 而它诞生的
             原因恰恰是 frameDisplay 漏登记（v1.11.0）。用手工清单去防"漏登记"，等于把
             同一个病换了个位置：下一版再加一个设置项，它照样发现不了。
             这里改成**通用不变量**：输入直接取自面板自己的行定义（探针把 groups() 在
             "条件行全展开"状态下取了一遍），代码自己说话。漏登记的后果是**静默**的 ——
             面板看着刷新了，那一项却不生效（本项目已栽过四次，MEMORY.md §22）。 */
          const rowKeys = Array.isArray(s8.rowKeys) ? s8.rowKeys : [];
          const notInKeys = rowKeys.filter(function (k) {
            return !Array.isArray(s8.allKeys) || s8.allKeys.indexOf(k) < 0;
          });
          check('「恢复默认」重放表覆盖设置面板的每一行（通用不变量，非手工清单）',
            rowKeys.length > 0 && notInKeys.length === 0,
            '面板行数=' + rowKeys.length + ' 未登记=' + JSON.stringify(notInKeys)
              + ' allKeys=' + JSON.stringify(s8.allKeys));
        }
        /* 窗口置顶：设置里的开关与顶栏按钮同一状态（仅桌面版） */
        check('设置里的「窗口置顶」开关生效并同步到顶栏按钮',
          s6.pinRowExists === true && s6.pinSetting === true && s6.pinBtnOn === true,
          JSON.stringify({ row: s6.pinRowExists, setting: s6.pinSetting, btnOn: s6.pinBtnOn }));
        check('再次切换可取消置顶', s6.pinRestored === false, 'setting=' + s6.pinRestored);
      }
    },
  },

  /* ---------- 8b. 拖拽入口（唯一"条目没有磁盘路径"的通路） ---------- */
  {
    id: 'drop',
    title: '拖拽入口 · 无磁盘路径的那条通路：索引 / 缩略图 / 灯箱 / 删除拒绝 / 多文件夹分组',
    kind: 'probe',
    script: 'probe_drop.js',
    key: 'DROP ',
    tags: ['core'],
    run: function (ctx) {
      const check = ctx.check, d = ctx.data;
      if (!d) { check('探针返回数据', false, '未解析到 DROP 输出'); return; }

      /* 这条通路此前在 17 个探针 + 6 个单测里命中 0 次：appself 自检走 --open-dir
         （原生路径），永远测不到它。所以这里断言必须落在**结果**上，而不是
         "函数被调用了"。 */
      check('拖入一个文件夹 → 新增一个来源，名字取自顶层目录',
        d.drop1Ok === true && d.drop1SrcDelta === 1 && d.drop1Name === '照片夹',
        JSON.stringify({ ok: d.drop1Ok, delta: d.drop1SrcDelta, name: d.drop1Name }));
      check('索引出的条目数与夹具一致（含一层子目录，递归扫到了）',
        d.drop1Count === d.fixtureCount && d.fixtureCount >= 7,
        'count=' + d.drop1Count + ' fixture=' + d.fixtureCount);
      check('拖入的条目全部没有磁盘路径、且都持有 File（这就是它与主通路的根本差异）',
        d.allPathless === true && d.allHaveFile === true,
        JSON.stringify({ pathless: d.allPathless, haveFile: d.allHaveFile }));
      check('rel 与夹具目录结构逐条一致（顶层目录名不重复）',
        d.relsMatchFixture === true && d.relDupPrefix === false,
        '期望=' + JSON.stringify(d.expectedRels) + ' 实际=' + JSON.stringify(d.actualRels));
      check('缩略图真的画出来了（不是只建了瓦片）',
        d.tiles >= 7 && d.thumbsPainted >= 4,
        'tiles=' + d.tiles + ' painted=' + d.thumbsPainted);
      check('拖入的图能打开灯箱，且大图真的解码出来了',
        d.lightboxOpen === true && d.lightboxImgW > 0,
        JSON.stringify({ open: d.lightboxOpen, w: d.lightboxImgW, err: d.lightboxErr || null }));
      /* 边界：无路径条目点删除。它是"三档能力探测"的边界，边界最容易漏 ——
         必须给出**可读原因**，不是静默失败、不是崩、更不能真删。 */
      check('无路径条目点删除 → 能力探测判为不支持，且给出可读原因（不是静默失败）',
        d.deleteCapability === null && d.deleteReturned === false && d.deleteThrew === null
          && typeof d.deleteToast === 'string' && /不支持删除/.test(d.deleteToast),
        JSON.stringify({ cap: d.deleteCapability, ret: d.deleteReturned,
          threw: d.deleteThrew, toast: d.deleteToast }));
      check('被拒的删除没有把条目弄丢（内存里还在）', d.stillThere === true, String(d.stillThere));
      check('一次拖入多个文件夹 → 分组为多个来源，各自条目数正确',
        d.drop2Ok === true && d.drop2SrcDelta === 2
          && JSON.stringify(d.drop2Names) === JSON.stringify(['相册A', '相册B'])
          && JSON.stringify(d.drop2Counts) === JSON.stringify([2, 1]),
        JSON.stringify({ delta: d.drop2SrcDelta, names: d.drop2Names, counts: d.drop2Counts }));
      check('散文件（没有顶层目录）归入「拖入的图片」',
        d.drop3Ok === true && d.drop3SrcDelta === 1 && d.drop3Name === '拖入的图片',
        JSON.stringify({ ok: d.drop3Ok, delta: d.drop3SrcDelta, name: d.drop3Name }));
      check('拖入全是非图片 → 不建来源、返回 false（反向用例）',
        d.drop4Ok === false && d.drop4SrcDelta === 0,
        JSON.stringify({ ok: d.drop4Ok, delta: d.drop4SrcDelta }));
      check('混合拖入（图片 + 非图片）→ 只收图片，非图片被丢掉',
        d.drop5Ok === true && d.drop5Count === 1
          && JSON.stringify(d.drop5Names) === JSON.stringify(['混合.png']),
        JSON.stringify({ ok: d.drop5Ok, count: d.drop5Count, names: d.drop5Names }));
      check('同名来源是「刷新」而不是重复新增（散文件都归入「拖入的图片」）',
        d.drop5SrcDelta === 0 && d.drop5SourceCount === 1,
        JSON.stringify({ delta: d.drop5SrcDelta, sameName: d.drop5SourceCount }));
    },
  },

  /* ---------- 9. 顶栏布局 ---------- */
  {
    id: 'topbar',    title: '顶栏布局 · 品牌文案已移除 / 眼睛按钮并入右侧 / 置顶按钮归位到窗口标题栏 / 窄窗不换行',
    kind: 'probe',
    script: 'probe_topbar.js',
    keys: ['INJECT ', 'EYE ', 'PIN ', 'PIN2 ', 'CAP ', 'NARROW ', 'GEO '],
    tags: ['slow'],
    run: function (ctx) {
      const check = ctx.check;
      const inj = ctx.keys['INJECT '], eye = ctx.keys['EYE '], pin = ctx.keys['PIN '],
        pin2 = ctx.keys['PIN2 '], cap = ctx.keys['CAP '], narrow = ctx.keys['NARROW '], geo = ctx.keys['GEO '];
      if (!geo) { check('探针返回数据', false, '未解析到 GEO 输出'); return; }
      check('顶栏已移除品牌文案', geo.brandTextPresent === false);
      check('眼睛按钮位于右侧控件簇内', geo.eyeInCtrls === true);
      check('眼睛按钮位于最近删除之后', geo.eyeAfterTrash === true && geo.eyeIdx > geo.trashIdx,
        'trashIdx=' + geo.trashIdx + ' eyeIdx=' + geo.eyeIdx);
      check('顶栏左侧只有「来源开关 + 间距 + 控件簇」（来源已搬进左侧栏）',
        Array.isArray(geo.topbarLeftChildren) && geo.topbarLeftChildren.length === 3
          && geo.topbarLeftChildren[0] === 'sideHead'
          && geo.topbarLeftChildren[1] === 'spacer'
          && geo.topbarLeftChildren[2] === 'ctrls',
        JSON.stringify(geo.topbarLeftChildren));
      check('顶栏仍是单行（.topbar-in 实测高度 = --topbar-h，控件簇 nowrap）',
        geo.topbarInH === Math.round(geo.topbarVarPx) && geo.ctrlsWrap === 'nowrap',
        'inH=' + geo.topbarInH + ' var=' + geo.topbarVarPx + ' wrap=' + geo.ctrlsWrap);
      if (eye) {
        check('眼睛按钮可切换模糊预览', eye.before === false && eye.after === true && eye.blurred === true);
      }
      /* 相框 v1.11.0 起为**正式功能**：顶栏图标默认可见；且无论显隐节点都留在 .ctrls 里
         （用 hidden 属性而不是摘节点，否则上面的 ctrlCount / pinIsLast / pinIdx 全会变） */
      check('相框已转正：defaults() 为开、顶栏图标可见且节点仍在控件簇内',
        geo.frameDefaultOn === true && geo.frameVisible === true && geo.frameIdx >= 0,
        'default=' + geo.frameDefaultOn + ' visible=' + geo.frameVisible
          + ' idx=' + geo.frameIdx + ' total=' + geo.ctrlCount);
      /* 置顶按钮（v1.7.0；v1.15.0 起在 Windows 上归位到窗口标题栏）：
         原生标题栏被 Window Controls Overlay 取代后，置顶按钮移进标题栏、
         落在「最小化」**左边** —— 它不是浏览动作而是窗口动作，邻居只能是窗口控制键。
         非 Windows 没有 WCO，按钮留在控件簇最右端（老布局）。两条路都得认，
         因为"探针跑在哪个平台"不该决定代码里有没有这条断言。 */
      if (cap && cap.wco) {
        check('有 WCO 时置顶按钮在窗口标题栏里（不再挂在控件簇上）',
          cap.pinInBar === true && cap.barVisible === true
            && geo.pinInCtrls === false && geo.hasWcoClass === true && geo.capbarHidden === false,
          JSON.stringify({ inBar: cap.pinInBar, barVisible: cap.barVisible,
            inCtrls: geo.pinInCtrls, cls: geo.hasWcoClass, parent: geo.pinParentId }));
        check('置顶按钮在「最小化」左侧（右缘落在原生按钮区之内）',
          cap.pinLeftOfNative === true,
          'pin=' + JSON.stringify(cap.pinRect) + ' area=' + JSON.stringify(cap.areaRect));
        check('置顶按钮没被标题栏浮层吞掉（命中测试拿到的是它自己）',
          cap.pinHit === true, 'hit=' + cap.pinHit);
        check('标题栏空白处是拖拽区（能拖窗口）', cap.barHit === true, 'barHit=' + cap.barHit);
        check('双击标题栏调到原生「最大化/还原」桥，且双击按钮不会误触发',
          cap.maxCalls === 1, 'calls=' + cap.maxCalls);
        /* 深色判据用**亮度**而不是写死色值：设计系统换色时不该连带改测试。
           只要「推过一次深色」成立，这条断言守的语义就还在。
           （v1.16.0 UI 重构把深色纸色从 #171614 换成中性 #141416，正是为此改的） */
        const lum = (hex) => {
          const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
          if (!m) return NaN;
          const n = parseInt(m[1], 16);
          const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
            const s = v / 255;
            return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
          });
          return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
        };
        check('切换主题会把标题栏浮层配色推给主进程（深色主题推深色）',
          Array.isArray(cap.capSync) && cap.capSync.length >= 2
            && cap.capSync.some((o) => lum(o.color) < 0.25)
            && cap.capSync[cap.capSync.length - 1].color === cap.expectedNow,
          JSON.stringify(cap.capSync) + ' expectedNow=' + cap.expectedNow);
        check('标题栏把页面整体压下（顶栏吸顶位置 = 标题栏高度）',
          cap.capH === 34 && cap.topbarTop === cap.capH,
          'capH=' + cap.capH + ' topbarTop=' + cap.topbarTop);
        check('窗口内打开灯箱从标题栏下方铺开（标题栏不被吞掉）',
          cap.lbErr === undefined && cap.lbTop === cap.capH && cap.lbBottom === cap.lbWinH,
          'lbTop=' + cap.lbTop + ' lbBottom=' + cap.lbBottom + ' winH=' + cap.lbWinH + ' err=' + cap.lbErr);
      } else {
        check('无 WCO 时置顶按钮留在控件簇最右端',
          geo.pinInCtrls === true && geo.pinAfterSet === true && geo.pinIsLast === true
            && geo.hasWcoClass === false && geo.capbarHidden === true,
          'setIdx=' + geo.setIdx + ' pinIdx=' + geo.pinIdx + ' total=' + geo.ctrlCount
            + ' capbarHidden=' + geo.capbarHidden);
      }
      if (pin) {
        check('桌面版下置顶按钮可见且有可读标签',
          pin.visible === true && pin.canPin === true && /置顶/.test(pin.label || ''),
          'visible=' + pin.visible + ' canPin=' + pin.canPin + ' label=' + pin.label);
        check('点击置顶按钮真的调用到原生桥（不是只改了个样式）',
          pin.ipcCalls >= 1 && pin.ipcLast === true,
          'calls=' + pin.ipcCalls + ' last=' + pin.ipcLast);
        check('置顶状态：设置 / 图标 / aria / 高亮 四者一致',
          pin.settingOn === true && pin.afterPressed === 'true'
            && pin.afterIcon === '#i-pin-on' && pin.isOnClass === true,
          JSON.stringify({ setting: pin.settingOn, aria: pin.afterPressed, icon: pin.afterIcon, on: pin.isOnClass }));
        if (pin2) {
          check('再次点击可取消置顶并回到未选中态',
            pin2.pressed === 'false' && pin2.setting === false
              && pin2.icon === '#i-pin' && pin2.isOnClass === false && pin2.ipcLast === false,
            JSON.stringify({ aria: pin2.pressed, setting: pin2.setting, icon: pin2.icon, last: pin2.ipcLast }));
        }
      }
      /* 来源栏已竖排（v1.17.0）：侧栏是独立一列，每行整行可点、纵向堆叠。
         横排 chip 时代的判据（一行里放得下几个）已失效，换成结构判据。 */
      check('来源栏是左侧独立一列（宽 212、贴顶栏下方、纵向可滚）',
        !!geo.sidebar && geo.sidebar.w === 212 && geo.sidebar.x === 0
          && geo.sbScrollOverflowY === 'auto',
        JSON.stringify({ rect: geo.sidebar, overflowY: geo.sbScrollOverflowY }));
      check('来源行是竖排整行（逐行下移且吃满列表宽度）',
        geo.chipRows && geo.chipRows.n >= 2 && geo.chipRows.stacked === true
          && geo.chipRows.fullWidth === true,
        JSON.stringify({ n: geo.chipRows && geo.chipRows.n,
          stacked: geo.chipRows && geo.chipRows.stacked,
          fullWidth: geo.chipRows && geo.chipRows.fullWidth,
          lw: geo.chipRows && geo.chipRows.lw }));
      check('「添加文件夹」在侧栏底部、不与列表一起滚动',
        !!geo.addBtn && !!geo.sidebar && geo.addBtn.y > geo.sidebar.y + 40
          && geo.addBtn.y + geo.addBtn.h <= geo.sidebar.y + geo.sidebar.h + 1,
        JSON.stringify({ add: geo.addBtn, side: geo.sidebar }));
      if (narrow) {
        check('窄窗口下顶栏左右两段垂直居中对齐', narrow.sameCenter === true,
          'headH=' + narrow.headH + ' ctrlsH=' + narrow.ctrlsH);
        check('窄窗口下顶栏不换行（.topbar-in 仍是 --topbar-h 高）', narrow.noWrap === true,
          'topbarInH=' + narrow.topbarInH);
        check('窄窗口下来源栏宽度不变（212）', narrow.sideW === 212, 'sideW=' + narrow.sideW);
      }
    },
  },

  /* ---------- 9a. 顶栏控件区外观 ----------
     「好不好看」大部分没法断言，但"齐不齐"能：控件簇有没有外框、
     所有控件是不是同一条 32px 基线、间距是不是只有两档、图标字形是不是一个尺寸。
     这几条正是"看着乱"的可测成因 —— 以前是 40px 胶囊里混着 25/28/29/32 四种高度、
     间距 2/6/7 三种值，单看每个控件都对，摆在一起就糙。 */
  {
    id: 'toplayout',
    title: '顶栏控件区外观 · 没有外框 / 32px 一条基线 / 间距成组 / 图标同尺寸',
    kind: 'probe',
    script: 'probe_toplayout.js',
    keys: ['TOPLAYOUT ', 'TOPLAYOUT_NARROW '],
    tags: ['slow'],
    run: function (ctx) {
      const check = ctx.check, d = ctx.keys['TOPLAYOUT '];
      if (!d) { check('探针返回数据', false, '未解析到 TOPLAYOUT 输出'); return; }
      const C = d.ctrls || {}, S = d.seg || {}, on = S.on || {}, items = d.items || [];
      const clear = (c) => c === 'rgba(0, 0, 0, 0)' || c === 'transparent';
      const uniq = (a) => [...new Set(a)];

      /* 外框：底色 / 描边 / 圆角三件套，缺一件都还是"盒子"。
         横向内边距单独看（见下一条）—— 它现在有了正当用途，不能再算进"外框"。 */
      check('控件簇没有外框（无底色 / 无描边 / 无圆角）',
        clear(C.bg) && parseFloat(C.border) === 0 && parseFloat(C.radius) === 0,
        'bg=' + C.bg + ' border=' + C.border + ' radius=' + C.radius + ' padding=' + C.padding);

      /* 横向内边距只允许 4px/边 —— 正好是焦点环的 outline 2px + offset 2px。
         再大就是"胶囊内边距"换个形式回来了：外框的底色描边都去掉了，但留白
         还在，视觉上依然是一个盒子套着一排键。 */
      check('横向内边距只留焦点环所需（≤4px/边）',
        C.padX <= 8,
        'padX=' + C.padX + ' padding=' + C.padding);

      /* 小图网格那组的灰色轨道是第二层外框 */
      check('分段控件没有轨道（灰底槽已去掉，无内边距）',
        clear(S.bg) && parseFloat(S.radius) === 0 && /^0px/.test(String(S.padding)),
        'bg=' + S.bg + ' radius=' + S.radius + ' padding=' + S.padding);

      /* 轨道去掉之后，选中态必须自己立得住 —— 否则等于"没有选中态"。
         高度比的是**其它控件**而不是控件簇：簇的高度会随外框变（40/36/32），
         拿它当基准的话，加回外框会顺带把这条也弄红，红的原因就不是它自己了。 */
      const btnH = Math.max(...items.filter((i) => i.cls !== 'sep').map((i) => i.h));
      check('选中滑片自己立得住（有底色 / 有投影 / 与其它控件同高）',
        !clear(on.bg) && on.shadow && on.shadow !== 'none' && on.h === btnH,
        'bg=' + on.bg + ' h=' + on.h + ' btnH=' + btnH + ' shadow=' + String(on.shadow).slice(0, 40));

      /* 一条基线：控件高度只允许有一个值 */
      const hs = uniq(items.filter((i) => i.cls !== 'sep').map((i) => i.h));
      check('所有控件同高（32px 一条基线，不再混 25/28/29）',
        hs.length === 1 && hs[0] === 32, 'heights=' + hs.join(','));

      /* 垂直中心：比"高度相同"更强 —— 高度相同也可能上沿没对齐 */
      const cys = uniq(items.map((i) => i.cy));
      check('所有控件垂直中心一致（不是"差不多居中"）', cys.length === 1, 'centers=' + cys.join(','));

      /* 图标按钮：只允许一种尺寸 */
      const szs = Object.keys(d.iconBtnSizes || {});
      check('图标按钮只有一种尺寸（不再有 28×28 的异类）',
        szs.length === 1 && szs[0] === '32x32', JSON.stringify(d.iconBtnSizes));

      /* 字形：只允许一种尺寸（按钮同大、里面图标不同大，照样是"大小不齐"） */
      const gl = uniq(items.filter((i) => i.glyph).map((i) => i.glyph));
      check('图标字形统一 16×16', gl.length === 1 && gl[0] === '16x16', 'glyphs=' + gl.join(','));

      /* 间距：组内 2px、分隔线两侧 7–8px（0.5px 线宽 + 亚像素定位的取整误差）。
         只允许这两档 —— 出现第三种值就是"手工微调过某个图标"（旧版 #sortDir 5px、
         #trashWrap 6px 的额外外边距就是这么来的）。 */
      const inner = [], around = [];
      items.forEach((it, i) => {
        if (i === 0 || it.gapPrev == null) return;
        (it.cls === 'sep' || items[i - 1].cls === 'sep' ? around : inner).push(it.gapPrev);
      });
      check('组内间距一致（相邻两个键 2px，容 ±1 取整误差）',
        inner.length > 0 && Math.min(...inner) >= 1 && Math.max(...inner) <= 3,
        'inner=' + JSON.stringify(inner));
      check('分隔线两侧间距一致（6px 空气 + 2px gap）',
        around.length > 0 && around.every((g) => g >= 7 && g <= 8),
        'around=' + JSON.stringify(around));

      /* 右缘对齐：工具栏右端必须落在网格内容区的右缘上 */
      const A = d.align || {};
      check('工具栏右缘与网格内容区右缘对齐（右侧不多出一截空气）',
        A.ctrlsRight != null && A.ctrlsRight === A.stageRight,
        'ctrls=' + A.ctrlsRight + ' stage=' + A.stageRight + ' innerW=' + A.innerW);

      /* 窄窗：文字收起后仍放得下（放不下就该横滚，而不是换行压扁） */
      const nr = ctx.keys['TOPLAYOUT_NARROW '];
      if (nr) {
        check('窄窗下工具栏不横向溢出（分段文字收起后仍放得下）',
          nr.scrolls === false, JSON.stringify(nr));
      }
    },
  },

  /* ---------- 9a. UI 审查 · 对比度 / 焦点环 / 命中框 / 截断 ---------- */
  /* 这四项有个共同点：**它们在截图里都不显眼**。
     对比度差 0.3 人眼分辨不出（4.17 vs 4.50）；焦点环少一条边看起来像"设计成
     只有三面"；22px 的按钮和 24px 的按钮并排放看不出差别；截断的标题反正都有
     省略号。所以只能靠算，不能靠看。
     探针自己也要被审：它踩过三个坑（模板字符串吃反斜杠、隐藏窗口动画节流、
     滚动容器假阳性），每个坑都会让它输出"看起来正常"的假绿。 */
  {
    id: 'uxaudit',
    title: 'UI 审查 · 文字对比度 ≥4.5 / 焦点环不被裁 / 命中框 ≥24px / 无静默截断',
    kind: 'probe',
    script: 'probe_uxaudit.js',
    keys: ['UXAUDIT '],
    tags: ['slow'],
    run: function (ctx) {
      const check = ctx.check, d = ctx.keys['UXAUDIT '];
      if (!d) { check('探针返回数据', false, '未解析到 UXAUDIT 输出'); return; }

      const SCENES = ['gallery-light', 'gallery-dark', 'selectbar', 'lightbox', 'lightbox-panel',
        'accent-light', 'accent-dark', 'settings', 'trash', 'empty', 'narrow-760'];
      const missing = SCENES.filter((s) => !d[s]);
      check('11 个场景都测到（浅/深、选择条、灯箱、灯箱面板、自定义强调色×2、设置、回收站、空态、窄窗）',
        missing.length === 0, missing.join(', '));

      /* 自证：主题真的切了、过渡真的关了。不查这两条，深色场景可能整段
         量的是浅色值 —— 曾经因此把 #a1a1a6 的浅灰文字报成"2.3:1"。 */
      check('浅色场景主题为 light 且过渡已关闭',
        d['gallery-light'] && d['gallery-light'].theme === 'light' && d['gallery-light'].diag.anim === '0',
        JSON.stringify(d['gallery-light'] && d['gallery-light'].diag));
      check('深色场景主题为 dark 且变量已切到深色值',
        d['gallery-dark'] && d['gallery-dark'].theme === 'dark' && d['gallery-dark'].diag.paper === '#141416',
        JSON.stringify(d['gallery-dark'] && d['gallery-dark'].diag));

      /* ① 对比度：正文 4.5 / 大字 3.0。disabled 控件 WCAG 豁免，但探针仍会
         列出来 —— 这里只统计"非 disabled"的，避免把灰掉的按钮算成缺陷。 */
      const badContrast = [];
      for (const s of SCENES) {
        for (const c of ((d[s] || {}).contrast || [])) {
          if (!c.disabled) badContrast.push(s + ': ' + c.r + ':1 "' + c.text + '" ' + c.el);
        }
      }
      check('所有可见文字的对比度达标（正文 ≥4.5 / 大字 ≥3.0）',
        badContrast.length === 0, badContrast.slice(0, 6).join(' | '));

      /* ①b 自定义强调色（v1.20.0）：纯黄 #ffcc00 是最不利的一支 ——
         白字压它只有 1.4:1、黄字压浅灰只有 1.3:1。这里既查"渲染出来的文字
         读得清"（已由上面那条覆盖），也查**色真的设进去了、且推导真的做了事**：
           · 实底仍是亮的（用户选的黄没被涂成深橄榄）
           · 实底上的字换成了深色，且两者 ≥4.5
           · 强调文字压纸底 ≥4.5、图标 ≥3
         不查后半段的话，一旦 Theme 哪天静默不生效，上面那条会**全绿** ——
         因为界面退回默认蓝，而默认蓝本来就达标。恒真的门禁比没有门禁更糟。 */
      {
        const L = d['accent-light'], K = d['accent-dark'];
        const okLight = L && L.diag.solid && L.diag.onSolid >= 4.5 && L.diag.textOnPaper >= 4.5
          && L.diag.accentOnPaper >= 3;
        const okDark = K && K.diag.solid && K.diag.onSolid >= 4.5 && K.diag.textOnPaper >= 4.5
          && K.diag.accentOnPaper >= 3;
        check('自定义强调色在浅色主题下推导正确（实底上的字 ≥4.5 / 文字 ≥4.5 / 图标 ≥3）',
          okLight, L ? JSON.stringify({ solid: L.diag.solid, on: L.diag.onAccent, onSolid: L.diag.onSolid, text: L.diag.accentText, textOnPaper: L.diag.textOnPaper, accent: L.diag.accent, accentOnPaper: L.diag.accentOnPaper }) : '缺场景');
        check('自定义强调色在深色主题下推导正确（同上，且是**反过来**提亮）',
          okDark, K ? JSON.stringify({ solid: K.diag.solid, on: K.diag.onAccent, onSolid: K.diag.onSolid, text: K.diag.accentText, textOnPaper: K.diag.textOnPaper, accent: K.diag.accent, accentOnPaper: K.diag.accentOnPaper }) : '缺场景');
        /* 反向：如果推导只是"原样照抄"，实底会是 #ffcc00 + 白字（1.4:1）。
           这条断言把那种情况直接指出来，而不是让人去猜 onSolid 为什么变小。 */
        check('浅色下纯黄没有被涂暗（实底仍亮），而是把字换成了深色',
          !!(L && L.diag.solid && L.diag.onAccent && L.diag.onSolid >= 4.5
            && String(L.diag.onAccent).toLowerCase() !== '#ffffff'),
          L ? 'solid=' + L.diag.solid + ' on=' + L.diag.onAccent : '缺场景');
      }

      /* ② 焦点环：outline 2px + offset 2px 必须整圈画得出来。被 overflow
         裁掉一条边的焦点环，键盘用户看到的是"这个按钮只有三面有框"。 */
      const badClip = [];
      for (const s of SCENES) {
        for (const c of ((d[s] || {}).clip || [])) {
          badClip.push(s + ': ' + c.el + ' 被 ' + c.by + ' 裁 ' + JSON.stringify(c.cut));
        }
      }
      check('焦点环四边都画得出来（没有被 overflow 祖先裁掉）',
        badClip.length === 0, badClip.slice(0, 5).join(' | '));

      /* ③ 命中框：WCAG 2.2 AA 2.5.8 要求 ≥24×24 */
      const small = [];
      for (const s of SCENES) {
        for (const t of ((d[s] || {}).target || [])) {
          small.push(s + ': ' + t.w + '×' + t.h + ' ' + t.el);
        }
      }
      check('可交互元素命中框 ≥24×24（WCAG 2.2 AA）',
        small.length === 0, small.slice(0, 5).join(' | '));

      /* ④ 静默截断：被裁了又没有任何补偿（无 title / 无 aria-label） */
      const trunc = [];
      for (const s of SCENES) {
        for (const t of ((d[s] || {}).trunc || [])) {
          trunc.push(s + ': "' + t.text + '" ' + t.scrollW + '>' + t.clientW + ' ' + t.el);
        }
      }
      check('没有"截断了却不说"的文字（有省略号就得有 title / aria-label）',
        trunc.length === 0, trunc.slice(0, 5).join(' | '));
    },
  },

  /* ---------- 9b. 左侧来源栏 · 展开 / 收起 / 浮层让位 ---------- */
  {
    id: 'sidebar',
    title: '左侧来源栏 · 展开收起 / Ctrl+Shift+B / 收起态贴出当前来源 / 底部浮层让位',
    kind: 'probe',
    script: 'probe_sidebar.js',
    key: 'SIDE ',
    tags: ['slow'],
    run: function (ctx) {
      const check = ctx.check, d = ctx.data;
      if (!d || !d.open || !d.closed) { check('探针返回数据', false, '未解析到 SIDE 输出'); return; }
      const o = d.open, c = d.closed, k = d.keys || {}, ov = d.overlayOpen || {},
        ov2 = d.overlayClosed || {}, em = d.empty || {}, dk = d.dark || {}, nw = d.narrow || {};

      // 侧栏底色亮度：深色主题下必须真的变暗（材质/发丝线在深色里最容易糊成一片）
      const lumOf = (col) => {
        const m = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(String(col || ''));
        if (!m) return NaN;
        const ch = [1, 2, 3].map((i) => {
          const s = (+m[i]) / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
      };

      /* —— 展开态 —— */
      check('默认展开：侧栏宽 212、贴左缘、从顶栏下沿铺到窗口底',
        o.hidden === false && o.w === 212 && o.x === 0 && o.top === o.topbarBottom
          && o.h >= o.fillH - 1 && o.h <= o.fillH + 1,
        JSON.stringify({ w: o.w, x: o.x, top: o.top, tbBottom: o.topbarBottom,
          h: o.h, fillH: o.fillH, vh100: o.vh100, topbarVar: o.topbarVar, capVar: o.capVar }));
      check('顶栏实际高度 = --topbar-h（进度条不占布局高度）',
        o.topbarBottom - (parseInt(o.capVar, 10) || 0) <= (parseInt(o.topbarVar, 10) || 0) + 1,
        'tbBottom=' + o.topbarBottom + ' cap=' + o.capVar + ' topbar=' + o.topbarVar);
      check('默认展开：workspace 未折叠、--side-w 为 212px',
        o.collapsed === false && o.sideVar === '212px',
        'collapsed=' + o.collapsed + ' sideVar=' + o.sideVar);
      check('默认展开：开关为选中态、收起态标签不显示',
        o.toggleOn === true && o.togglePressed === 'true' && /收起/.test(o.toggleTitle || '')
          && o.activeLabelHidden === true,
        JSON.stringify({ on: o.toggleOn, aria: o.togglePressed, title: o.toggleTitle, hidden: o.activeLabelHidden }));
      check('首屏网格已按侧栏宽度让位（瓦片左缘不压在侧栏底下）',
        typeof o.firstTileLeft === 'number' && o.firstTileLeft >= o.w,
        'tileLeft=' + o.firstTileLeft + ' sideW=' + o.w);

      /* —— 收起态 —— */
      check('点开关收起：宽度收到 0、边框与透明度一起收掉',
        c.w === 0 && c.collapsed === true && c.sideVar === '0px'
          && c.opacity === '0' && c.borderW === '0px',
        JSON.stringify({ w: c.w, collapsed: c.collapsed, sideVar: c.sideVar,
          opacity: c.opacity, borderW: c.borderW }));
      check('收起后设置落盘（sidebarOpen=false，且写进了 localStorage）',
        c.setting === false && c.persisted === false,
        'setting=' + c.setting + ' persisted=' + c.persisted);
      check('收起后开关切到未选中态、提示改为「展开」',
        c.toggleOn === false && c.togglePressed === 'false' && /展开/.test(c.toggleTitle || ''),
        JSON.stringify({ on: c.toggleOn, aria: c.togglePressed, title: c.toggleTitle }));
      check('收起后顶栏贴出「当前来源」的名字（否则不知道自己看的是哪个夹）',
        c.activeLabelHidden === false && c.activeLabel === '全部图片' && c.activeLabelVisibleW > 0,
        JSON.stringify({ hidden: c.activeLabelHidden, label: c.activeLabel, w: c.activeLabelVisibleW }));
      check('收起后网格吃回被让出的宽度（瓦片左缘左移）',
        typeof c.firstTileLeft === 'number' && c.firstTileLeft < o.firstTileLeft,
        'open=' + o.firstTileLeft + ' closed=' + c.firstTileLeft);

      /* —— 键盘 —— */
      check('Ctrl+Shift+B 可展开、再按可收起（收起态出发）',
        k.before === false && k.afterKey === true && k.afterKey2 === false,
        JSON.stringify(k));
      check('焦点在输入框里按 Ctrl+Shift+B 不劫持（打字不该把侧栏开合）',
        k.afterKeyInInput === false && k.focusKept === true,
        JSON.stringify({ state: k.afterKeyInInput, focusKept: k.focusKept }));
      /* Ctrl+B 归「模糊预览」（应用菜单加速键），侧栏必须不受它影响：
         两个处理器都收得到 keydown，共用同一个键就会按一下同时改两样东西 */
      check('裸 Ctrl+B 不动侧栏（那个键已经是模糊预览的）',
        k.afterPlainCtrlB_sidebarOpen === false,
        'sidebarOpen=' + k.afterPlainCtrlB_sidebarOpen);

      /* —— 底部浮层让位（fixed 元素不会自动避开侧栏） —— */
      check('侧栏展开时底部状态栏从侧栏右缘起（不盖住「添加文件夹」）',
        ov.sidebarW === 212 && ov.viewbarLeft === 212 && ov.viewbarRight === ov.docClientW,
        JSON.stringify({ sideW: ov.sidebarW, left: ov.viewbarLeft, right: ov.viewbarRight,
          clientW: ov.docClientW, innerW: ov.innerW }));
      check('侧栏展开时「添加文件夹」仍可被点中（命中测试拿到的是它自己）',
        ov.addHit === true, 'hit=' + ov.addHit + ' rect=' + JSON.stringify(ov.addRect));
      check('侧栏展开时选择条按「图片区」居中而不是整窗居中',
        Math.abs(ov.selbarCenter - ov.expectSelbarCenter) <= 2,
        'center=' + ov.selbarCenter + ' expect=' + ov.expectSelbarCenter);
      check('侧栏收起后底部浮层回到整窗宽度',
        ov2.viewbarLeft === 0 && Math.abs(ov2.selbarCenter - ov2.expectSelbarCenter) <= 2,
        JSON.stringify(ov2));

      /* —— 空态 —— */
      check('空态页里侧栏与开关一起收掉（不在引导页旁边留一列空壳）',
        em.sidebarHidden === true && em.sideHeadHidden === true && em.activeHidden === true,
        JSON.stringify(em));

      /* —— 深色 —— */
      check('深色主题下侧栏底色确实变暗、发丝线仍在',
        dk.theme === 'dark' && lumOf(dk.bg) < 0.2 && dk.border && dk.border !== dk.bg,
        JSON.stringify({ theme: dk.theme, bg: dk.bg, lum: lumOf(dk.bg), border: dk.border }));
      check('深色主题下当前来源行仍是实心高亮（蓝底白字）',
        dk.chipOnBg && dk.chipOnColor === 'rgb(255, 255, 255)',
        JSON.stringify({ bg: dk.chipOnBg, color: dk.chipOnColor }));

      /* —— 窄窗 —— */
      check('窄窗口下侧栏宽度不变、主区正好吃掉剩余宽度',
        nw.sideW === 212 && nw.mainLeft === 212 && nw.sumOk === true,
        JSON.stringify(nw));
      /* 窄窗自动让位：三条一起断，缺一条就说明"改坏了用户设置/改了界面没改菜单" */
      if (d.narrowAuto) {
        const a = d.narrowAuto || {};
        check('窄到 940 以下自动收起侧栏，且**不动**用户设置（sidebarOpen 仍为 true）',
          a.collapsed === true && a.setting === true && a.sideW === 0,
          JSON.stringify({ collapsed: a.collapsed, setting: a.setting, sideW: a.sideW }));
        check('自动收起后菜单勾选态跟着变、顶栏贴出「当前来源」',
          a.menuSide === false && a.activeVisible === true && a.toggleOn === false,
          JSON.stringify({ menuSide: a.menuSide, activeVisible: a.activeVisible, toggleOn: a.toggleOn }));
        check('窄窗里手动展开有临时出口（本次窄窗保持展开）',
          a.opened && a.opened.collapsed === false && a.opened.setting === true && a.opened.sideW === 212,
          JSON.stringify(a.opened));
        check('退出窄窗自动恢复成用户意图（不用再点一次）',
          a.backWide && a.backWide.collapsed === false && a.backWide.setting === true
            && a.backWide.forcedFlag === false,
          JSON.stringify(a.backWide));
        check('再进窄窗重新自动收起（手动展开的临时出口已随宽窗复位）',
          a.narrowAgain && a.narrowAgain.collapsed === true && a.narrowAgain.setting === true,
          JSON.stringify(a.narrowAgain));
      }
    },
  },

  /* ---------- 10. 圆角语言门禁 ----------
     防的是"写死像素回潮"：令牌明明定义了四档，组件里却各自写 9/7/8/6。
     这种偏差不是 bug，单看每一处都合理，所以只能靠门禁盯着。 */
  {
    id: 'rounding',
    title: '圆角语言 · 控件只在令牌档位上、胶囊真胶囊、同心圆角 = 令牌 − 内边距',
    kind: 'probe',
    script: 'probe_round.js',
    key: 'ROUND ',
    run: function (ctx) {
      const check = ctx.check;
      if (!ctx.data || !ctx.data.items) { check('探针返回数据', false, '未解析到 ROUND 输出'); return; }
      const d = ctx.data;
      const I = d.items || {};
      const T = d.tokens || {};
      const near = (a, b) => Math.abs(a - b) < 0.6;
      const v = (k) => (I[k] ? I[k].r : null);

      /* 控件档：32px 上下的可操作控件，一律 --r-s */
      const ctrl = ['icoBtnTop', 'select', 'searchInput', 'srcChip', 'spNum', 'spSelect', 'spBtn', 'spSeg', 'btnSm', 'tile'];
      for (const k of ctrl) {
        check('控件圆角走令牌 --r-s：' + k,
          v(k) !== null && near(v(k), T.s), v(k) + ' vs --r-s=' + T.s);
      }
      /* 容器档 */
      const cont = { spGroup: 'm', toast: 'm', setPanel: 'l' };
      for (const [k, t] of Object.entries(cont)) {
        check('容器圆角走令牌 --r-' + t + '：' + k,
          v(k) !== null && near(v(k), T[t]), v(k) + ' vs --r-' + t + '=' + T[t]);
      }
      /* 控件簇（v1.18.0）不再有外框：它是一条**平铺**的工具栏，
         底色 / 描边 / 圆角三者必须同时为 0 —— 只把圆角改回 0、
         底色还留着，视觉上仍然是"一个装控件的盒子"。 */
      const ct = I.ctrls || {};
      const clear = (c) => c === 'rgba(0, 0, 0, 0)' || c === 'transparent';
      check('控件簇没有外框（无圆角 / 无底色 / 无描边）',
        ct.r === 0 && clear(ct.bg) && parseFloat(ct.border) === 0,
        'r=' + ct.r + ' bg=' + ct.bg + ' border=' + ct.border);
      /* 微型档（窗口标题栏里的置顶键：与原生最小化/关闭同规格） */
      check('标题栏按钮圆角走令牌 --r-xs（与原生窗口控制键一致）',
        v('pinBtn') !== null && near(v('pinBtn'), T.xs), v('pinBtn') + ' vs --r-xs=' + T.xs);
      /* 胶囊：半径不小于半高 —— "差一点到半高"正是八边形的成因 */
      const pills = ['selbar', 'scCount', 'spSwitch', 'btnLg'];
      let pillBad = [];
      for (const k of pills) {
        const it = I[k];
        if (!it) { pillBad.push(k + ':缺失'); continue; }
        if (it.r < 900) pillBad.push(k + ':radius=' + it.r);
      }
      check('胶囊元素一律 999px（选择条 / 数量徽标 / 开关 / 空态主按钮）', pillBad.length === 0, pillBad.join(', '));
      /* 同心圆角：滑片在轨道里缩了 2px，圆角也减 2px。
         顶栏分段控件已无轨道（padding 0），这条只剩设置面板里的那组还成立。 */
      const gap = {
        spSeg: { outer: v('spSeg'), inner: v('spSegThumb') },
      };
      for (const [k, g] of Object.entries(gap)) {
        check('同心圆角 = 外圆角 − 内边距：' + k,
          g.outer !== null && g.inner !== null && near(g.outer - g.inner, 2),
          'outer=' + g.outer + ' inner=' + g.inner);
      }
      /* 紧凑密度的 calc 档位 */
      const c = d.compact || {};
      check('紧凑密度不会把外框加回来（控件簇圆角仍为 0）',
        c.ctrls === 0, 'compact ctrls=' + c.ctrls);
      check('紧凑密度的按钮圆角 = --r-s − 内边距（calc 令牌）',
        near(c.icoBtnTop, T.s - 2), c.icoBtnTop + ' vs ' + (T.s - 2));
      /* 兜底：规则里仍然出现"数字 px"的，只剩白名单（滚动条 / 滑杆槽 / 相框握把 / 胶囊 / 单列无边角） */
      const ALLOW = [/scrollbar/, /slider-runnable-track/, /moz-range-track/, /moz-range-progress/,
        /=> 999px$/, /=> 0px$/, /fr-grip => 2px$/];
      const bad = (d.hardcoded || []).filter((s) => !ALLOW.some((re) => re.test(s)));
      check('规则里没有新的写死圆角（白名单：滚动条 / 滑杆 / 相框握把 / 胶囊 / 单列无边角）',
        bad.length === 0, bad.join(' | '));
    },
  },

  /* ---------- 10a-2. 字号体系 · 只走 --fs-* 令牌（Node，秒级） ----------
     和圆角套件同一个思路：把"体系"变成可执行断言。
     没有这条门禁，下一次"这里大一点点好看"就会把 12.5px 写回去，
     而 12.5px 单看没问题 —— 它只在并排比较时才露馅，正是最难靠肉眼回归的一类。 */
  {
    id: 'typescale',
    title: '字号体系 · 全部走 --fs-* 令牌 / 无写死 px / 无半像素档 / 无孤儿令牌',
    kind: 'node',
    script: path.join(HERE, 'type_gate.js'),
    quickFlag: true,
    tags: ['core'],
    run: function (ctx) {
      const check = ctx.check;
      let d = null;
      try { d = JSON.parse(String(ctx.tail || '').replace(/^TYPEGATE\s*/, '')); } catch (e) { d = null; }
      if (!d) { check('门禁脚本返回可解析结果', false, String(ctx.tail || '').slice(0, 200)); return; }

      const TOKENS = ['--fs-2xs', '--fs-xs', '--fs-s', '--fs', '--fs-l', '--fs-title', '--fs-hero', '--fs-display'];
      check('字号令牌齐备（8 档）',
        TOKENS.every((t) => typeof d.tokens[t] === 'number'),
        JSON.stringify(d.tokens));
      check('三份 CSS 都参与扫描（main / lightbox / frame）',
        ['css/main.css', 'css/lightbox.css', 'css/frame.css'].every((f) => typeof d.files[f] === 'number' && d.files[f] > 0),
        JSON.stringify(d.files));
      check('没有任何写死的 px 字号（一律 var(--fs-*)）',
        d.hardcodedCount === 0, (d.hardcoded || []).join(' | '));
      check('引用的 --fs-* 全部有定义（没有拼错的令牌）',
        (d.undefinedTokens || []).length === 0, (d.undefinedTokens || []).join(', '));
      check('定义的 --fs-* 全部被用到（没有孤儿档位）',
        (d.unusedTokens || []).length === 0, (d.unusedTokens || []).join(', '));
      /* 半像素档 = 把"差 0.5px"重新请回来，这是本次清理要根除的东西 */
      check('令牌值全是整数档（不再有 9.5 / 12.5 这类半像素）',
        (d.halfTokens || []).length === 0, (d.halfTokens || []).join(', '));
      /* 非像素字号只允许显式登记过的（响应式大标题） */
      check('非像素字号只有白名单里的 clamp()（其余一律令牌）',
        d.nonPxUnallowed === 0,
        (d.nonPx || []).filter((x) => !x.allowed).map((x) => x.file + ':' + x.line + ' ' + x.selector + ' => ' + x.value).join(' | '));
    },
  },

  /* ---------- 10a-3. 图标体系 · 统一 Lucide（24 网格 / stroke 2 / 四档尺寸） ----------
     图标从 42 个手绘改成 36 个 Lucide 之后，必须有人守着"别再手画一个塞进来"。
     探针只量当前 DOM 里真实渲染出来的图标，所以它同时能抓到两件事：
     精灵里 symbol 被删了（use 指向不存在的 id）和渲染尺寸跑出了令牌档位。 */
  {
    id: 'iconography',
    title: '图标体系 · 统一 Lucide / 24 网格 / stroke 2 / 尺寸只在四档令牌',
    kind: 'probe',
    script: 'probe_iconography.js',
    key: 'ICONS ',
    run: function (ctx) {
      const check = ctx.check;
      if (!ctx.data) { check('探针返回数据', false, '未解析到 ICONS 输出'); return; }
      const d = ctx.data;

      check('探针摆出了场景（量到可见图标）', d.visible > 0, 'visible=' + d.visible + ' total=' + d.total);
      check('没有缺图（每处 <use> 都指向存在的 symbol）',
        (d.missing || []).length === 0, (d.missing || []).join(', '));
      check('图标网格统一 24×24（Lucide 基准网格）',
        (d.badGrid || []).length === 0, (d.badGrid || []).join(' | '));

      /* 描边只有两档：2 = 线性图标，1.6 = 实心变体（fill: currentColor 时描边要收细，
         否则笔画糊成一坨）。出现别的值说明有人手改过某个 symbol。 */
      const strokes = Object.keys(d.strokes || {}).sort();
      check('描边只有两档：2（线性）/ 1.6（实心变体）',
        strokes.every((s) => s === '2' || s === '1.6') && strokes.length > 0,
        JSON.stringify(d.strokes));

      /* 渲染尺寸只允许落在令牌档位上：--ic-xs 12 / --ic-s 14 / --ic 16 / --ic-l 20 / --ic-xl 36 */
      const ALLOWED = ['12x12', '14x14', '16x16', '20x20', '36x36'];
      const badSize = Object.keys(d.sizes || {}).filter((k) => ALLOWED.indexOf(k) < 0);
      check('渲染尺寸只在四档令牌上（12 / 14 / 16 / 20 / 36）',
        badSize.length === 0, badSize.map((k) => k + '×' + d.sizes[k]).join(', '));

      /* symbol 总数固定：加图标要改 deploy/gen_sprite.js 的 MAP 再重跑，
         而不是在 index.html 里手写一个 <symbol>。 */
      check('sprite 里有 36 个 symbol（新增图标走 deploy/gen_sprite.js）',
        d.symbols === 36, '实际 ' + d.symbols);

      /* 抽查：线性图标必须 fill:none，实心变体必须 fill:currentColor */
      const S = d.sample || [];
      const line = S.filter((s) => /-fill$|^i-play$|^i-pause$|^i-pin-on$/.test(s.id) === false);
      const solid = S.filter((s) => /-fill$|^i-play$|^i-pause$|^i-pin-on$/.test(s.id) === true);
      check('线性图标 fill=none / 实心变体 fill=currentColor',
        line.every((s) => s.fill === 'none') && solid.every((s) => s.fill === 'currentColor'),
        S.map((s) => s.id + ':' + s.fill).join(', '));
    },
  },

  /* ---------- 10a-4. 单行栏不折行 · 只在窄窗口才现形的布局塌陷 ----------
     这一类缺陷有个共同特征：**开发者的窗口里永远复现不出来**。
     写 CSS 时窗口是宽的，一切正常；用户把窗口拖窄 200px，flex 开始压缩
     最软的那个子项，而"最软"往往是最不该动的那块（计数、状态、文件名），
     于是一个数字标签被折成两行，看着像渲染出错。
     实测过一次真实案例：选择条里「已选 12 张」在 1000px 宽下被折成 4 行。 */
  {
    id: 'nowrap',
    title: '单行栏不折行 · 顶栏/状态栏/选择条/回收站/灯箱在 880–1500px 下都只有一行',
    kind: 'probe',
    script: 'probe_wrap.js',
    key: 'WRAP ',
    run: function (ctx) {
      const check = ctx.check;
      if (!ctx.data) { check('探针返回数据', false, '未解析到 WRAP 输出'); return; }
      const d = ctx.data;

      /* 先证明探针真的看了东西：否则"0 处折行"是假绿 */
      check('探针确实扫到了这些栏（不是空转）',
        d.barsSeen >= 20 && d.textsSeen >= 40,
        'bars=' + d.barsSeen + ' texts=' + d.textsSeen);
      check('四档窗口宽度下都没有被折行的文字',
        d.total === 0 && d.scanned === 'clean',
        (d.items || []).map((x) => x.width + 'px ' + x.bar + '「' + x.text + '」→' + x.lines + ' 行').join(' | '));
    },
  },

  /* ---------- 10b. 单列整屏 · 图片不能被顶部控制栏吃掉 ---------- */
  {
    id: 'single',
    title: '单列整屏 · 槽位高度按「chrome 下沿」算 / 首图不被控制栏覆盖 / 吸附位对齐',
    kind: 'probe',
    script: 'probe_single.js',
    key: 'SINGLE ',
    run: function (ctx) {
      const check = ctx.check;
      if (!ctx.data || !ctx.data.first) { check('探针返回数据', false, '未解析到 SINGLE 输出'); return; }
      const f = ctx.data.first, s = ctx.data.second || {}, off = ctx.data.lateOff || {}, on = ctx.data.lateOn || {};
      check('单列滚动吸附已开启（前置条件）', f.snapOn === true, String(f.snapOn));
      check('WCO 标题栏在测量时确实存在（否则这条断言测不到东西）',
        f.hasWco === true && f.capH > 0, 'wco=' + f.hasWco + ' capH=' + f.capH);
      /* 核心：槽位高度必须按「视口 − chrome 下沿」算。只取 .topbar 自身高度会少算标题栏 34px，
         槽位就高出 34px —— 图上下各被切一截。 */
      check('单列槽位高度 = 视口高度 − 顶部 chrome 下沿',
        f.slotH === f.slotShould && f.slotH > 0,
        'slotH=' + f.slotH + ' should=' + f.slotShould + ' (chrome=' + f.chromeBottom + ')');
      /* 用户报的症状：图片顶部被控制栏盖住 */
      check('首图没有被顶部控制栏盖住（瓦片与图片都为 0 像素重叠）',
        f.tileCovered === 0 && f.imgCovered === 0,
        'tileCovered=' + f.tileCovered + ' imgCovered=' + f.imgCovered);
      check('scroll-padding-top 与 chrome 下沿一致（吸附位才有对齐基准）',
        f.scrollPadTop === f.chromeBottom + 'px', f.scrollPadTop + ' vs ' + f.chromeBottom + 'px');
      check('吸附到第 2 张后顶边正好贴住 chrome 下沿（误差 0）',
        s.alignErr === 0, 'alignErr=' + s.alignErr + ' top=' + s.tile1Top + ' chrome=' + s.chromeBottom);
      /* 标题栏出现/消失会整体改变可见区：判定结果变了就必须重排，否则几何停在旧值上 */
      check('chrome 高度变化后几何自愈（无标题栏时槽位跟着变高）',
        off.slotH === off.slotShould && off.slotH > f.slotH,
        'off slotH=' + off.slotH + ' should=' + off.slotShould + ' (有标题栏时 ' + f.slotH + ')');
      check('chrome 高度变化后几何自愈（标题栏回来时槽位跟着变矮）',
        on.slotH === on.slotShould && on.slotH === f.slotH,
        'on slotH=' + on.slotH + ' should=' + on.slotShould);
      /* 槽位首尾相接：上一张的底边正好停在 chrome 下沿，不能越界到内容区里 */
      const pv = ctx.data.prev || {};
      check('上一张的底边不越过 chrome 下沿（槽位首尾相接，内容区不露上一张）',
        pv.prevBelowChrome === 0, 'prevBottom=' + pv.prevBottom + ' chrome=' + pv.chromeBottom);
      /* 但"正好停在背后"意味着顶栏底下就是上一张：顶栏一旦半透明 + 背景模糊，
         那 57px 就会透出来（用户看到的是"上一张图跑到控制区下面"）。 */
      check('单列模式下顶栏为实色（半透明材质会把背后那张图透出来）',
        pv.topbarOpaque === true, 'bg=' + pv.topbarBg);
      check('单列模式下顶栏不启用背景模糊（模糊会重新引入"透出"）',
        pv.topbarBlur === 'none', 'blur=' + pv.topbarBlur);
    },
  },

  /* ---------- 11. 网格布局 · contain 之后几何仍正确 ---------- */
  {
    id: 'grid',
    title: '网格布局 · 瓦片尺寸/行距/定位在 contain 之后仍正确 / 小图与中图是两种视图',
    kind: 'probe',
    script: 'probe_grid.js',
    key: 'GRID ',
    tags: ['slow'],
    run: function (ctx) {
      const check = ctx.check, d = ctx.data;
      if (!d || !d.wide || !d.narrow) { check('探针返回数据', false, '未解析到 GRID 输出'); return; }
      const w0 = d.wide, n0 = d.narrow;
      check('瓦片已渲染且无零尺寸', w0.tiles > 0 && w0.zero === 0, 'tiles=' + w0.tiles + ' zero=' + w0.zero);
      check('contain: layout paint 已生效', d.noContain === 0 && /layout/.test(d.containSample) && /paint/.test(d.containSample),
        'sample="' + d.containSample + '" missing=' + d.noContain);
      check('瓦片仍为绝对定位（contain 未改变定位模型）', d.notAbs === 0, 'notAbsolute=' + d.notAbs);
      check('实测包围盒与内联宽高一致（未误加 contain:size）', d.rectMismatch === 0, 'mismatch=' + d.rectMismatch);
      check('宽窗下同行瓦片互不重叠', w0.overlap === 0, 'overlap=' + w0.overlap + ' worstGap=' + w0.worstGap);
      check('宽窗下多行、行间不叠压', w0.rows >= 2 && w0.vOverlap === 0, 'rows=' + w0.rows + ' vOverlap=' + w0.vOverlap);
      check('窄窗重排后仍无重叠/无零尺寸', n0.tiles > 0 && n0.overlap === 0 && n0.zero === 0,
        'tiles=' + n0.tiles + ' overlap=' + n0.overlap + ' zero=' + n0.zero);

      /* 两种网格视图必须真的不同 —— 见 probe_grid.js 末尾的说明 */
      const v = d.views || {};
      const s = v.s || {}, m = v.m || {};
      check('小图网格：瓦片全部是正方形（等边方格）',
        s.n > 0 && s.square === s.n, 'n=' + s.n + ' square=' + s.square);
      check('小图网格：图片用 cover 裁切填满方格',
        s.n > 0 && (s.fit || {}).cover === s.n, 'fit=' + JSON.stringify(s.fit || {}));
      check('中图网格：按原比例排（非正方形）且用 contain 不裁切',
        m.n > 0 && m.square < m.n && (m.fit || {}).contain === m.n,
        'n=' + m.n + ' square=' + m.square + ' fit=' + JSON.stringify(m.fit || {}));
    },
  },

  /* ---------- 10b. 排列模式设置项 · 换排法要真的换几何（v1.12.0） ----------
     这一套的重点是「断言落在结果上」：设置面板点『瀑布流』之后，必须
     **几何真的变了**（等宽列 / 高度不等 / 不重叠），而不只是"控件存在"。
     另外锁住瀑布流的两条坐标不变量 —— y 单调可二分、y+h 不单调故必须用 yMax。 */
  {
    id: 'masonry',
    title: '排列模式 · 设置面板换『瀑布流』真的换几何 / 等宽列·不等高·不重叠 / yMax 不变量',
    kind: 'probe',
    script: 'probe_masonry.js',
    key: 'MASONRY ',
    tags: ['slow'],
    run: function (ctx) {
      const check = ctx.check, d = ctx.data;
      if (!d || !d.gridA || !d.masB || !d.invB) { check('探针返回数据', false, '未解析到 MASONRY 输出'); return; }
      // 前提：设置面板里的通路确实被驱动了（否则后面的断言全是假绿）
      check('设置面板『排列模式』按钮齐全（4 项）', d.segButtons === 4 && d.clickB === 'ok',
        'buttons=' + d.segButtons + ' clickB=' + d.clickB + ' clickA=' + d.clickA);
      check('面板点『中图』→ 模式真的变为 medium', d.modeA === 'medium', 'modeA=' + d.modeA);
      check('面板点『瀑布流』→ 模式真的变为 masonry', d.modeB === 'masonry', 'modeB=' + d.modeB);
      check('换排法后瓦片几何真的变了（不是只改了状态值）', d.changed === true);

      // 两种排法结构不同：等高网格宽度不一，瀑布流等宽列
      check('基线网格宽度不一（前置条件）', d.gridA.uniqW > 1, 'gridA.uniqW=' + d.gridA.uniqW);
      check('瀑布流：所有瓦片等宽（= 等宽列）', d.masB.uniqW === 1, 'masB.uniqW=' + d.masB.uniqW);
      check('瀑布流：高度不止一种（真的不等高）', d.masB.uniqH >= 2,
        'masB.uniqH=' + d.masB.uniqH + '（原图宽度比共 4 种）');
      check('瀑布流：列数 ≥ 2 且与实测列坐标数一致', d.masB.colXCount === d.colsB && d.colsB >= 2,
        'colXCount=' + d.masB.colXCount + ' colsB=' + d.colsB);
      check('瀑布流：列宽恰好填满容器（右侧无余缝）', Math.abs(d.colWFills - d.stageWB) <= 1,
        'colWFills=' + d.colWFills + ' stageW=' + d.stageWB + ' colW=' + d.colWB);
      check('瀑布流：瓦片互不重叠且无零尺寸', d.masB.tiles > 0 && d.masB.overlap === 0 && d.masB.zero === 0,
        'tiles=' + d.masB.tiles + ' overlap=' + d.masB.overlap + ' zero=' + d.masB.zero);

      // 坐标不变量（grid.js 的窗口化 / 锚点 / 框选三处都建在这上面）
      check('瀑布流：y 单调不减（可安全二分）', d.invB.ok === true && d.invB.yMono === true,
        JSON.stringify(d.invB));
      check('瀑布流：yMax 单调且等于 [0..i] 前缀最大底边', d.invB.yMaxMono === true && d.invB.yMaxOk === true,
        JSON.stringify(d.invB));
      check('瀑布流：本布局确实出现 y+h 非单调（yMax 的必要性已复现）', d.invB.yPlusHNotMono === true,
        '若这里为 false，说明这组图没能逼出非单调，yMax 分支实际未被覆盖');

      // 两个入口是同一个状态
      check('顶栏与设置面板的选中态一致（都是 masonry）',
        d.topbarOnB === 'masonry' && d.segOnB === 'masonry',
        'topbar=' + d.topbarOnB + ' seg=' + d.segOnB);
      check('顶栏点『单列』→ 模式与顶栏高亮都变 single，重开面板选中项也是 single',
        d.modeD === 'single' && d.topbarOnD === 'single' && d.segOnD === 'single',
        'modeD=' + d.modeD + ' topbar=' + d.topbarOnD + ' seg(重开)=' + d.segOnD);

      // 变窄重排
      check('窗口变窄 → 列数变少且仍不重叠', d.colsC < d.colsB && d.colsC >= 1 && d.masC.overlap === 0 && d.masC.zero === 0,
        'cols ' + d.colsB + '→' + d.colsC + ' overlap=' + d.masC.overlap + ' zero=' + d.masC.zero + ' stageW=' + d.stageWC);

      check('探针过程中无页面报错', (d.pageErrs || []).length === 0, JSON.stringify((d.pageErrs || []).slice(0, 3)));
      check('收尾已还原默认排列模式', d.restored === d.defaultMode, 'restored=' + d.restored + ' default=' + d.defaultMode);
    },
  },

  /* ---------- 11. 旋转持久化与导出（P1-4） ---------- */
  {
    id: 'rotpersist',
    title: '旋转持久化与导出 · 记住朝向 / 网格换向 / 烘焙像素 / 落盘导出 / 重开一致',
    kind: 'probe',
    script: 'probe_rot_persist.js',
    key: 'RP ',
    tags: ['slow'],
    run: function (ctx) {
      const check = ctx.check, d = ctx.data;
      if (!d || !d.A || !d.G) { check('探针返回数据', false, '未解析到 RP 输出'); return; }
      const A = d.A, B0 = d.B0, B1 = d.B1, C = d.C, D = d.D, E = d.E, F1 = d.F1, F2 = d.F2, G = d.G;

      // 90° 顺时针旋转在 CSS 里表现为 matrix(0, s, -s, 0, …)
      const isRot90 = (tf) => {
        const m = /matrix\(([-\d.e]+),\s*([-\d.e]+),\s*([-\d.e]+),\s*([-\d.e]+)/.exec(tf || '');
        if (!m) return false;
        const a = +m[1], b = +m[2], c = +m[3], dd = +m[4];
        return Math.abs(a) < 1e-6 && Math.abs(dd) < 1e-6 && b > 0 && c < 0 && Math.abs(Math.abs(b) - Math.abs(c)) < 1e-6;
      };

      check('初始无旋转记录且旋转 API 就绪', A.lsKey === null && A.count === 0 && A.stateRot === 0 && A.hasApi === true,
        'count=' + A.count + ' hsApi=' + A.hasApi);
      check('灯箱打开时按「已保存朝向」显示（首次为 0°）',
        B0 && B0.open === true && B0.rot === 0 && B0.nw > 0, 'rot=' + (B0 && B0.rot) + ' nw=' + (B0 && B0.nw));

      check('旋转 90° 后被记住（State + localStorage 双写）',
        B1 && B1.lbRot === 90 && B1.stateRot === 90 && B1.count === 1 && B1.ls && B1.ls[d.portrait.path] === 90,
        'lbRot=' + (B1 && B1.lbRot) + ' ls=' + JSON.stringify(B1 && B1.ls));
      check('灯箱里的图确实转了 90°', isRot90(B1 && B1.tf), String(B1 && B1.tf).slice(0, 48));

      check('网格瓦片跟着换向（r90 类 + data-rot）',
        C && C.found === true && C.r90 === true && C.dataRot === '90' && C.capUpright === true,
        'cls=' + (C && C.cls));
      check('旋转后网格占位框宽高与瓦片宽高严格对调',
        C && Math.abs(C.phW - C.tileH) <= 1 && Math.abs(C.phH - C.tileW) <= 1,
        'tile=' + (C && C.tileW) + '×' + (C && C.tileH) + ' ph=' + (C && C.phW) + '×' + (C && C.phH));

      check('竖图旋转 90° 后烘焙成横图（像素宽高对调）',
        D && D.ok === true && D.bakedW === B0.nh && D.bakedH === B0.nw,
        '原 ' + B0.nw + '×' + B0.nh + ' → 烘焙 ' + (D && D.bakedW) + '×' + (D && D.bakedH));

      // 真实 IPC 导出 → 落盘校验
      const dir = d.exportDir;
      let wrote = null, dupName = null;
      if (E && E.ok && Array.isArray(E.results)) {
        wrote = E.results.filter((r) => r.ok).map((r) => r.out);
        dupName = E.dup && E.dup[0] && E.dup[0].out;
      }
      check('IPC 导出把「原图副本 + 烘焙图」都写到磁盘',
        !!wrote && wrote.length === 2, JSON.stringify(E && E.results));
      check('同名导出自动加 “ (2)”，不覆盖已有文件',
        !!dupName && /\(2\)/.test(dupName) && dupName !== 'copy-' + d.portrait.name,
        String(dupName));

      if (dir && wrote) {
        const copyP = path.join(dir, 'copy-' + d.portrait.name);
        const bakedP = path.join(dir, 'baked-90.png');
        let sameBytes = false, pngDim = null;
        try {
          const a1 = fs.readFileSync(copyP), a2 = fs.readFileSync(d.portrait.path);
          sameBytes = a1.length === a2.length && a1.equals(a2);
        } catch (e) { sameBytes = false; }
        try {
          const b = fs.readFileSync(bakedP);
          const isPng = b.slice(1, 4).toString() === 'PNG';
          pngDim = isPng ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null;
        } catch (e) { pngDim = null; }
        check('未旋转的图是逐字节复制（无损）', sameBytes === true);
        check('磁盘上的烘焙图 PNG 头尺寸 = 转置后的原图尺寸',
          !!pngDim && pngDim.w === B0.nh && pngDim.h === B0.nw,
          pngDim ? pngDim.w + '×' + pngDim.h : '未能读取');
      }

      // ---- 走「选择条按钮」那条真实用户路径（App.exportSelected 编排） ----
      const e2 = d.E2;
      check('导出编排：结束后 _exporting 已复位（不自我锁死）',
        !!e2 && e2.exporting === false, 'exporting=' + (e2 && e2.exporting));
      check('导出编排：旋转过的走烘焙、未旋转的走复制',
        !!e2 && e2.rotatedRot === 90 && e2.plainRot === 0,
        'rotated=' + (e2 && e2.rotatedRot) + ' plain=' + (e2 && e2.plainRot));
      if (dir && e2) {
        let bakedUI = null, plainSame = false;
        try {
          const b = fs.readFileSync(path.join(dir, e2.rotatedName));
          bakedUI = b.slice(1, 4).toString() === 'PNG' ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null;
        } catch (e) { bakedUI = null; }
        try {
          // 用相对路径定位源文件（素材里有子目录）
          const src = fs.readFileSync(path.join(HERE, 'fixtures', '照片夹', e2.plainRel || e2.plainName));
          const out = fs.readFileSync(path.join(dir, e2.plainName));
          plainSame = src.length === out.length && src.equals(out);
        } catch (e) { plainSame = false; }
        check('点「导出所选」后，旋转图按摆正后的像素落盘',
          !!bakedUI && bakedUI.w === B0.nh && bakedUI.h === B0.nw,
          'rotated=' + e2.rotatedName + ' → ' + (bakedUI ? bakedUI.w + '×' + bakedUI.h : '未能读取'));
        check('点「导出所选」后，未旋转图逐字节等于原文件',
          plainSame === true, 'plain=' + e2.plainName);
      }

      check('转满一圈回到 0° 后记录被清除',
        F1 && F1.lbRot === 0 && F1.stateRot === 0 && F1.lsKeys === 0,
        'rot=' + (F1 && F1.stateRot) + ' lsKeys=' + (F1 && F1.lsKeys));
      check('resetRot() 一键复原并清掉记录',
        F2 && F2.mid === 180 && F2.after === 0 && F2.lbRot === 0 && F2.lsKeys === 0,
        'mid=' + (F2 && F2.mid) + ' after=' + (F2 && F2.after));

      check('重开应用后旋转记录仍在（localStorage 持久化）',
        G.G0 && G.G0.count === 1 && G.G1 && G.G1.stateRot === 90,
        'count=' + (G.G0 && G.G0.count) + ' stateRot=' + (G.G1 && G.G1.stateRot));
      check('重开后打开灯箱自动恢复该朝向',
        G.G2 && G.G2.lbRot === 90 && isRot90(G.G2.tf), 'lbRot=' + (G.G2 && G.G2.lbRot));
      check('重开后网格瓦片也是旋转后的朝向', G.G3 && G.G3.r90 === true, 'r90=' + (G.G3 && G.G3.r90));
    },
  },

  /* ---------- 12. HEIC/HEIF 能力探测（P1-2） ---------- */
  {
    id: 'heic',
    title: 'HEIC/HEIF · 能力探测取代无条件判死 / 条目不丢 / 两条分支 / 文案可读',
    kind: 'probe',
    script: 'probe_heic.js',
    key: 'HEIC ',
    tags: ['slow'],
    run: function (ctx) {
      const check = ctx.check, d = ctx.data;
      if (!d || !d.A || !d.BC) { check('探针返回数据', false, '未解析到 HEIC 输出'); return; }
      const A = d.A, BC = d.BC, D = d.D, E = d.E;

      check('启动即完成能力探测，同步可读布尔结论',
        typeof A.status === 'boolean' && A.supported === A.status,
        'status=' + A.status + ' supported=' + A.supported);
      check('探测走的是 WebCodecs 能力查询（ImageDecoder）',
        A.hasImageDecoder === true && A.hasReady === true &&
        A.types && typeof A.types.heic === 'boolean' && typeof A.types.heif === 'boolean',
        JSON.stringify(A.types));
      check('HEIC/HEIF 扩展名识别正确且不被过滤',
        JSON.stringify(A.isHeic) === JSON.stringify([true, true, false]) && A.isImageExt === true,
        JSON.stringify(A.isHeic) + ' isImageExt=' + A.isImageExt);

      check('含 HEIC 的文件夹条目一个不丢', BC.total === 3 && BC.heics === 2,
        'total=' + BC.total + ' heics=' + BC.heics);
      check('HEIC 条目的 bad 与本机探测结论一致（不再无条件判死）',
        Array.isArray(BC.heicAll) && BC.heicAll.every((m) => m.bad === !BC.supported),
        'supported=' + BC.supported + ' ' + JSON.stringify(BC.heicAll));
      check('非 HEIC 条目完全不受影响', Array.isArray(BC.others) && BC.others.every((m) => m.bad === false),
        JSON.stringify(BC.others));

      check('本机可解时：摘掉 bad，交给 <img> 真解码',
        D && D.capable && D.capable.heicBads.every((b) => b === false) &&
        D.capable.okFlags.every((f) => f === true) && D.capable.pngBad === false,
        JSON.stringify(D && D.capable));
      check('本机不可解时：保持 bad，网格显示不可用占位',
        D && D.incapable && D.incapable.heicBads.every((b) => b === true) &&
        D.incapable.okFlags.every((f) => f === false) && D.incapable.pngBad === false,
        JSON.stringify(D && D.incapable));

      check('失败原因能区分「本机缺解码器」与「文件损坏」',
        E && /HEVC|解码器/.test(E.whenUnsupported || '') && /损坏/.test(E.whenSupported || '') &&
        E.whenUnsupported !== E.whenSupported && !!E.plain,
        'unsupported="' + (E && E.whenUnsupported) + '" supported="' + (E && E.whenSupported) + '"');
      check('真实 HEIC 条目的 bad 与真实探测一致', E && E.heicMetaBad === !BC.supported,
        'bad=' + (E && E.heicMetaBad) + ' supported=' + BC.supported);
    },
  },

  /* ---------- 15b. 无障碍：焦点陷阱 / 播报区 / 语义（真实 Chromium） ---------- */
  {
    id: 'a11yui',
    title: '无障碍 · 播报真的发生 / 焦点真的被圈住 / 关闭真的还原 / 相框控制条键盘可达',
    kind: 'probe',
    script: 'probe_a11y.js',
    keys: ['A11YSEM ', 'A11YLIVE ', 'A11YMODAL ', 'A11YSP ', 'A11YLBOX ', 'A11YFRAME '],
    tags: ['slow'],
    run: function (ctx) {
      const check = ctx.check;
      const sem = ctx.keys['A11YSEM '], live = ctx.keys['A11YLIVE '],
        modal = ctx.keys['A11YMODAL '], sp = ctx.keys['A11YSP '],
        lb = ctx.keys['A11YLBOX '], fr = ctx.keys['A11YFRAME '];
      if (!sem) { check('探针返回数据', false, '未解析到 A11YSEM 输出'); return; }

      /* 一段 Tab 序列是否"真的被圈住"。两个条件缺一不可：
         ① 每一步焦点都还在容器内；② **至少真的移动过一次**。
         只看 ① 会假通过 —— Tab 完全没生效时焦点一直没动，inside 会全是 true。 */
      const trapped = function (steps) {
        if (!Array.isArray(steps) || !steps.length) return false;
        const allInside = steps.every(function (s) { return s.inside === true; });
        const moved = steps.some(function (s) { return s.moved === true; });
        return allInside && moved;
      };

      /* --- 1) 静态语义 --- */
      check('无障碍共用件已进包', sem.moduleLoaded === true);
      /* 这条断言同时是"启动期有没有人乱发 urgent 播报"的哨兵：
         播报区静止态必须是 polite/status。若这里读到 alert/assertive，
         说明启动过程中有人调了 A11y.live(msg, {urgent:true}) —— 而 A11y.live
         按 urgency 改档、改完不复位，于是静止态被永久改成 assertive。
         历史原因就是 App.init() 重放 trayOn/hotkeyOn 时，假宿主没桩那两条 IPC
         → 设置"假失败" → 回滚 + urgent 播报。所以失败信息里要带上"播报了几条、最后一条是什么"，
         否则只看到 alert/assertive 根本查不出是谁干的。 */
      check('常驻播报区带 role / aria-live / aria-atomic',
        sem.liveExists === true && sem.liveRole === 'status'
        && sem.liveMode === 'polite' && sem.liveAtomic === 'true',
        [sem.liveRole, sem.liveMode, sem.liveAtomic].join('/')
          + ' | 启动后已播报 ' + sem.liveCount + ' 条，最后一条="' + (sem.liveLast || '') + '"');
      check('播报区视觉不可见但留在无障碍树（不是 display:none 那种摘树做法）',
        sem.liveDisplay !== 'none' && sem.liveVisibility !== 'hidden'
        && sem.liveW <= 1 && sem.liveH <= 1,
        'display=' + sem.liveDisplay + ' visibility=' + sem.liveVisibility
        + ' ' + sem.liveW + 'x' + sem.liveH);
      check('灯箱补齐对话框语义（role / aria-modal / 可及名称）',
        sem.lbRole === 'dialog' && sem.lbModal === 'true' && !!sem.lbLabel,
        [sem.lbRole, sem.lbModal, sem.lbLabel].join('/'));
      /* 这里断言的**反过来**：设置面板不许声明 aria-modal。
         它没有遮罩、背后的网格照样能点（点了面板外任何地方就关掉），
         而 aria-modal 是告诉读屏"外面全部惰性" —— 说了却做不到，就是撒谎。
         真正被圈住的焦点在下面单独断言，两件事不能互相顶包。 */
      check('设置面板是「非模态」对话框（有 role=dialog，但不谎报 aria-modal）',
        sem.spRole === 'dialog' && !sem.spModal,
        [sem.spRole, sem.spModal].join('/'));

      /* --- 2) 播报区：50 处 toast 靠它被读屏听见 --- */
      if (live) {
        check('toast 真的写进播报区（计数递增且内容正确）',
          live.okCount === live.beforeCount + 1 && /已移入回收站/.test(live.okText || ''),
          'before=' + live.beforeCount + ' after=' + live.okCount + ' text=' + live.okText);
        check('完成类提示走 polite + role=status',
          live.okRole === 'status' && live.okMode === 'polite', live.okRole + '/' + live.okMode);
        check('失败类提示走 assertive + role=alert（urgent 档真的被调用）',
          live.ugRole === 'alert' && live.ugMode === 'assertive', live.ugRole + '/' + live.ugMode);
        check('同一条消息连播两次仍产生变更（否则第二次静默）',
          live.twiceCount === live.okCount + 2 && live.twiceText === live.ugText,
          'count=' + live.twiceCount + ' text=' + live.twiceText);
        check('播报内容与 DOM 实际文本一致', live.domText === live.twiceText,
          'dom=' + live.domText + ' snapshot=' + live.twiceText);
      }

      /* --- 3) 删除确认弹层 --- */
      if (modal) {
        const mo = modal.open || {}, mc = modal.closed || {};
        check('确认弹层打开时焦点真的移进容器',
          mo.exists === true && mo.activeInside === true, 'inside=' + mo.activeInside);
        check('默认焦点落在「取消」（危险操作不该回车即触发）',
          mo.activeAct === 'cancel', 'act=' + mo.activeAct);
        check('确认弹层有 role=dialog + aria-modal',
          mo.role === 'dialog' && mo.ariaModal === 'true', mo.role + '/' + mo.ariaModal);
        check('确认弹层的可及名称指向真实标题',
          !!mo.labelledby && mo.labelResolves === true && /移入回收站/.test(mo.labelText || ''),
          'labelledby=' + mo.labelledby + ' text=' + mo.labelText);
        check('正向 Tab 被圈在弹层内（连按 6 次）', trapped(modal.tabs),
          JSON.stringify(modal.tabs));
        check('反向 Shift+Tab 同样被圈住（连按 3 次）', trapped(modal.backs),
          JSON.stringify(modal.backs));
        /* 这条同时锁一个老 bug：「取消」按钮的点击处理曾经绑在
           document.body.appendChild(wrap) 之前，那时 noBtn.isConnected 恒为 false，
           于是按钮从来没绑上 —— 点了什么都不发生、弹层赖着不走。
           所以这里断言的是"弹层真的没了且焦点回来了"，不是"取消按钮存在"。 */
        check('点「取消」真的关掉弹层，且焦点还原到出发控件',
          mc.stillOpen === false && mc.restored === true,
          'stillOpen=' + mc.stillOpen + ' active=' + mc.activeId + ' from=' + mc.fromId);
      }

      /* --- 4) 设置面板 --- */
      if (sp) {
        const so = sp.open || {}, sc = sp.closed || {};
        check('设置面板打开时焦点移入面板容器', so.open === true && so.activeIsPanel === true,
          'active=' + so.activeTag + '#' + so.activeId);
        check('设置面板容器可接收程序化焦点（tabindex=-1）', so.tabindex === '-1', so.tabindex);
        check('设置面板 Tab 被圈住（连按 5 次）', trapped(sp.tabs), JSON.stringify(sp.tabs));
        check('设置面板关闭后焦点回到顶栏齿轮',
          sc.closed === true && sc.onBtn === true, 'active=' + sc.activeId);
      }

      /* --- 5) 灯箱 --- */
      if (lb) {
        const lo = lb.open || {}, lc = lb.closed || {};
        check('灯箱打开时焦点移入灯箱容器', lo.open === true && lo.activeIsLb === true,
          'inside=' + lo.activeInside);
        check('灯箱内确实有可聚焦控件（陷阱不是空圈）',
          typeof lo.focusableCount === 'number' && lo.focusableCount >= 3,
          'focusables=' + lo.focusableCount);
        check('灯箱 Tab 被圈住（连按 6 次）', trapped(lb.tabs), JSON.stringify(lb.tabs));
        check('Esc 关闭灯箱后焦点回到网格瓦片',
          lc.open === false && lc.onTile === true, 'active=' + lc.activeCls);
      }

      /* --- 6) 相框页内浮层 --- */
      if (fr) {
        const fb = fr.base || {}, ff = fr.focus || {}, fbl = fr.blur || {};
        check('相框浮层带对话框语义',
          fb.exists === true && fb.role === 'dialog' && fb.label === '相框模式',
          [fb.role, fb.label].join('/'));
        check('相框控制条默认隐藏，且隐藏时不进 Tab 序',
          fb.barOn === false && fb.barVisibility === 'hidden' && fb.focusablesWhileHidden === 0,
          'barOn=' + fb.barOn + ' vis=' + fb.barVisibility + ' focusables=' + fb.focusablesWhileHidden);
        check('键盘焦点进入相框即亮出控制条（原本只有 hover 能唤出）',
          ff.barOn === true && ff.visAfterSettle === 'visible' && ff.hotOpen === '1',
          'barOn=' + ff.barOn + ' vis=' + ff.visAfterSettle + ' hotOpen=' + ff.hotOpen);
        check('控制条亮出后其中的按钮真的可聚焦',
          ff.btnFocusable === true && ff.focusablesWhileShown >= 3,
          'btnFocused=' + ff.btnFocusable + ' focusables=' + ff.focusablesWhileShown);
        check('焦点离开相框后控制条收起',
          fbl.barOnAfterBlur === false && fbl.visAfterBlur === 'hidden',
          'barOn=' + fbl.barOnAfterBlur + ' vis=' + fbl.visAfterBlur);
        check('相框可正常退出且陷阱随容器一起解掉',
          !!(fr.closed && fr.closed.gone === true));
      }
    },
  },

  /* ---------- 15b. 桌面集成：真实 Electron 里真的建菜单/托盘/任务栏/快捷键 ----------
     与上面那套纯函数测试的分工：纯函数证明"数据写对了"，这一套证明
     "Electron 真的接受了"。加速键拼错时 Electron 不抛错、只是注册不上，
     只有回头问 getMenuItemById 才看得出来。 */
  {
    id: 'desktopui',
    title: '桌面集成 · 真实 Electron：菜单与加速键 / 托盘 / 任务栏按钮与进度 / JumpList / 全局快捷键 / 右键菜单',
    kind: 'probe',
    script: 'probe_desktop.js',
    key: 'DESKTOP ',
    tags: ['slow'],
    run: function (ctx) {
      const check = ctx.check, d = ctx.data;
      if (!d) { check('探针返回数据', false, '未解析到 DESKTOP 输出'); return; }
      check('探针没有自报问题', d.ok === true && (d.problems || []).length === 0,
        JSON.stringify(d.problems || []));

      /* --- 应用菜单：问 Electron，而不是读自己的模板 --- */
      const m = d.appMenu || {};
      check('推状态真的重建了菜单', m.statePushed === true, JSON.stringify(m.statePushed));
      check('顶层菜单是 文件/编辑/视图/窗口/帮助',
        JSON.stringify(m.topLevel) === JSON.stringify(['文件', '编辑', '视图', '窗口', '帮助']),
        JSON.stringify(m.topLevel));
      check('「打开文件夹…」真的挂在 CmdOrCtrl+O 上',
        !!(m.openFolder && m.openFolder.accel === 'CmdOrCtrl+O' && m.openFolder.label === '打开文件夹…'),
        JSON.stringify(m.openFolder));
      check('「导出选中的图片…」真的挂在 CmdOrCtrl+E 上',
        !!(m.exportSel && m.exportSel.accel === 'CmdOrCtrl+E'), JSON.stringify(m.exportSel));
      check('排列模式是 radio，且只有当前模式被勾中',
        !!(m.modeMasonry && m.modeMasonry.type === 'radio' && m.modeMasonry.checked === true
          && m.modeSmall && m.modeSmall.checked === false),
        JSON.stringify([m.modeMasonry, m.modeSmall]));
      check('只看收藏 / 模糊预览 / 窗口置顶 的勾选态跟随状态',
        !!(m.favOnly && m.favOnly.checked === true
          && m.blur && m.blur.checked === true
          && m.pin && m.pin.checked === true),
        JSON.stringify([m.favOnly, m.blur, m.pin]));
      /* 来源栏是侧栏的第三个入口。它得真的装进**原生菜单**（模板写对但 Electron
         没注册上，只有问 getMenuItemById 才看得出来），且加速键不能撞模糊预览。 */
      check('「来源栏」真的装进了原生菜单，且加速键不撞「模糊预览」',
        !!(m.sidebar && m.sidebar.type === 'checkbox'
          && m.sidebarAccel === 'CmdOrCtrl+Shift+B'
          && m.sidebar.checked === true
          && m.sidebarAccelClashesWithBlur === false),
        JSON.stringify({ item: m.sidebar, clash: m.sidebarAccelClashesWithBlur }));
      check('「来源栏」的勾选态跟着状态翻（用菜单收起后勾反过来）',
        m.sidebarCheckedWhenSideOn === true && m.sidebarCheckedWhenSideOff === false,
        JSON.stringify({ on: m.sidebarCheckedWhenSideOn, off: m.sidebarCheckedWhenSideOff }));
      check('「全选当前页」用 CmdOrCtrl+Shift+A（不抢图库的 Ctrl+A）',
        !!(m.selectAll && m.selectAll.accel === 'CmdOrCtrl+Shift+A'), JSON.stringify(m.selectAll));
      check('单键加速键 F1 被 Electron 接受',
        !!(m.shortcuts && m.shortcuts.accel === 'F1'), JSON.stringify(m.shortcuts));
      check('帮助菜单里有「关于 Atrium」',
        !!(m.about && m.about.label === '关于 Atrium'), JSON.stringify(m.about));

      /* --- 右键菜单 --- */
      const cm = d.ctxMenuBuild || {};
      check('右键菜单模板能被 Electron 建出来', cm.count > 5 && Array.isArray(cm.labels),
        JSON.stringify(cm));
      check('图库右键菜单第一项是「打开」', (cm.labels || [])[0] === '打开', JSON.stringify(cm.labels));
      const p = d.ctxPopup || {};
      check('右键菜单真的弹出、并能在无人操作时被关掉',
        !!(p.popped === true && p.closedByApi === true && p.resolved === true && p.value === null),
        JSON.stringify(p));

      /* --- 缩略图按钮图标 --- */
      const g = d.glyph || {};
      check('三颗缩略图按钮图标都是合法的 16×16 位图',
        ['prev', 'next', 'frame'].every(function (k) {
          return g[k] && g[k].w === 16 && g[k].h === 16 && g[k].empty === false && g[k].pngBytes > 0;
        }), JSON.stringify(g));

      /* --- 托盘 --- */
      const t = d.trayCreate || {};
      check('托盘真的建起来了', t.alive === true && t.trayAlive === true, JSON.stringify(t));
      check('托盘能把主窗口藏起来', t.afterHide === false, JSON.stringify(t));
      check('托盘能把主窗口请回来', t.backAgain === true, JSON.stringify(t));
      check('关掉托盘后托盘真的被销毁', t.aliveAfterDestroy === false, JSON.stringify(t));

      /* --- 任务栏 --- */
      check('任务栏缩略图按钮设置成功', !!(d.thumbar && d.thumbar.set === true), JSON.stringify(d.thumbar));
      check('任务栏进度条能设置（含不确定模式）也能收起',
        !!(d.progress && d.progress.normal === true && d.progress.indeterminate === true && d.progress.cleared === true),
        JSON.stringify(d.progress));
      check('JumpList 设置成功', !!(d.jumpList && d.jumpList.ok === true), JSON.stringify(d.jumpList));

      /* --- 全局快捷键 --- */
      const h = d.hotkey || {};
      check('全局快捷键 Ctrl+Alt+A 真的注册上了',
        !!(h.register && h.register.registered === true && h.isRegistered === true), JSON.stringify(h));
      check('注销之后真的不再是注册状态', h.afterDispose === false, JSON.stringify(h.afterDispose));
      check('拼错的加速键被自家校验挡下（反向用例）',
        !!(h.badAccel && h.badAccel.ok === false), JSON.stringify(h.badAccel));

      /* --- 菜单勾选态跟随状态 --- */
      const s = d.menuState || {};
      check('切模式后菜单里的 radio 真的跟着换',
        !!(s.changed === true && s.mediumBefore === false && s.mediumAfter === true && s.masonryAfter === false),
        JSON.stringify(s));
      check('没有选中时「导出选中的图片…」自动置灰', s.exportDisabledWhenNoSel === true, JSON.stringify(s));
      check('状态没变时不重建菜单（避免菜单白闪）', s.noopWhenUnchanged === true, JSON.stringify(s));

      /* --- IPC 归属校验（纵深防御）：非受信 sender 必须被拒 --- */
      const ig = d.ipcGuard || {};
      const un = ig.untrusted || {};
      const leaked = Object.keys(un).filter(function (k) { return un[k] !== null; });
      check('7 条桌面集成通道对非受信 sender 全部拒绝（逐条实测，不是抽样）',
        ig.channelCount === 7 && ig.rejectedAll === true && leaked.length === 0,
        '通道数=' + ig.channelCount + ' 漏放行=' + JSON.stringify(leaked)
          + ' 实测=' + JSON.stringify(un));
      check('受信窗口的正常调用没有被误拒（guard 没把自家调用一起挡掉）',
        !!(ig.trusted && ig.trusted.desktopInfo
          && ig.trusted.desktopInfo.platform === process.platform
          // menuState 返回 false 是"状态没变、不重建菜单"的正常语义，不是被拒；
          // 被拒的形态是 null（guard 在 handler 之前就返回了）—— 所以这里判"是布尔值"
          && typeof ig.trusted.menuState === 'boolean'),
        JSON.stringify(ig.trusted));
      check('非受信调用没有产生副作用（托盘没被建起来）',
        ig.trusted && ig.trusted.trayAfter === false, JSON.stringify(ig.trusted));
    },
  },

  /* ---------- 16. 打包后的 exe 自带自检（最接近真实用户的一步） ---------- */
  {
    id: 'appself',
    title: '打包产物自检 · 跑装进包里的 exe：引导→索引→解码→删除→还原→灯箱',
    kind: 'app',
    exe: path.join(ROOT, 'deploy', 'dist-electron', 'Atrium_Electron版', 'Atrium.exe'),
    tags: ['slow', 'artifact'],
    run: function (ctx) {
      const check = ctx.check, r = ctx.app;
      if (!r || !fs.existsSync(this.exe)) {
        check('打包产物存在（先跑 npm run build:electron）', false, this.exe);
        return;
      }
      check('exe 自检进程正常退出', r.code === 0 && !r.error, 'code=' + r.code + (r.error ? ' | ' + r.error.message : ''));

      /* --- exe 资源段盖章：**字节级证据**（v1.13.0） ---
         assemble.js 收尾用 rcedit 把 brand/icon.ico 写进 RT_ICON / RT_GROUP_ICON。
         这条**不能**用"构建没报错"当判据：rcedit 的版本信息键名写错时是**静默无效**的
         （历史上 InternalName 被写成 InternalFilename，exe 里悄悄留着 electron.exe），
         而图标写没写进去更是从日志里完全看不出来。

         所以判据取最硬的一种：把 icon.ico 里每一张内嵌 PNG 的字节拿去 exe 里 indexOf，
         **全中**才算真写进去了。同一个字节串在原始 electron.exe 里是找不到的（负向对照由
         icon_gate 的 ico 校验兜住；这里只保证"至少真的进了 exe"）。
         手工解析 PE 资源树试过 —— 偏移量容易算错、读出的值荒谬，所以不碰资源树。 */
      try {
        const icoPath = path.join(ROOT, 'brand', 'icon.ico');
        const ico = fs.readFileSync(icoPath);
        const exeBuf = fs.readFileSync(this.exe);
        const n = ico.readUInt16LE(4);            // ICO 头：reserved(2) type(2) count(2)
        const pngs = [];
        for (let i = 0; i < n; i++) {
          const off = 6 + i * 16;                 // 每条目录项 16 字节
          const size = ico.readUInt32LE(off + 8);
          const dataOff = ico.readUInt32LE(off + 12);
          const bytes = ico.slice(dataOff, dataOff + size);
          // 只取内嵌 PNG（magic \x89PNG）——ICO 也可能内嵌 BMP，那种 rcedit 会重编码
          if (bytes.length > 8 && bytes[0] === 0x89 && bytes.toString('latin1', 1, 4) === 'PNG') {
            pngs.push({ w: ico[off] || 256, bytes });
          }
        }
        check('icon.ico 里解析出多张内嵌 PNG（七尺寸）', pngs.length >= 7,
          '解析到 ' + pngs.length + ' 张，目录项 ' + n + ' 条');
        const hit = pngs.filter((p) => exeBuf.indexOf(p.bytes) >= 0);
        check('exe 资源段真的盖了章（每张内嵌 PNG 都能在 exe 里按字节找到）',
          pngs.length >= 7 && hit.length === pngs.length,
          '命中 ' + hit.length + '/' + pngs.length + ' 张'
            + (hit.length < pngs.length
              ? '；缺 ' + pngs.filter((p) => hit.indexOf(p) < 0).map((p) => p.w + 'px').join(',') : ''));
      } catch (e) {
        check('icon.ico 可读且能读出内嵌 PNG（资源盖章判据的前提）', false, String(e && e.message || e));
      }

      const s = r.result && r.result.snap;
      if (!r.result || r.result.pass !== true || !s) {
        check('自检整体通过', false, JSON.stringify(r.result && r.result.err || '无结果'));
        return;
      }
      check('自检整体通过', true);
      check('无控制台报错', Array.isArray(r.result.consoleErrors) && r.result.consoleErrors.length === 0,
        JSON.stringify((r.result.consoleErrors || []).slice(0, 2)));
      check('索引到素材并全部解码完成', s.items > 0 && s.allDecoded === true,
        'items=' + s.items + ' allDecoded=' + s.allDecoded);
      check('灯箱能打开真实图片', s.lbW > 0 && typeof s.lbName === 'string', s.lbName + ' w=' + s.lbW);
      check('原生桥可用（磁盘路径 + 文件头读取）', s.nativePath === true && s.readHeadOk === true);
      check('持久化可用（localStorage + IndexedDB）', s.ls === true && s.idb === true);
      check('删除 → 回收站 → 撤销完整闭环',
        s.delOk === true && s.delGone === true && s.undoOk === true && s.undoBack === true,
        'del=' + s.delOk + ' undo=' + s.undoOk + ' back=' + s.undoBack);
      check('批量删除 → 批量撤销完整闭环',
        s.batchDelOk === true && s.batchGone === true && s.batchUndoOk === true && s.batchBack === true);
      check('框选与选择条可用', s.selAll > 0 && s.selBarShown === true && s.selOne === true);
      check('EXIF 解析不抛异常', s.exifNoThrow === true);
      /* v1.7.0：置顶能力必须真的进包（preload 白名单 + 主进程 handler + 窗口本体） */
      check('窗口置顶 IPC 端到端可用（含真实窗口状态回读）',
        s.pinApiOk === true && s.pinSet === true && s.pinReal === true
          && s.pinUnset === false && s.pinRealOff === false,
        JSON.stringify({ api: s.pinApiOk, set: s.pinSet, real: s.pinReal, off: s.pinRealOff, why: s.pinWhy }));
      check('产物里顶栏置顶按钮可见，且界面入口能切换状态',
        s.pinBtnVisible === true && s.pinAria === 'true' && s.pinBackAria === 'false'
          && s.pinSetting === true && s.pinBackSetting === false,
        'vis=' + s.pinBtnVisible + ' on=' + s.pinAria + ' off=' + s.pinBackAria);

      /* v1.8.0：相框模式 —— 真的开了一个无边框、置顶、按图片比例的窗口 */
      check('相框 IPC 端到端可用（open/data/fit/info 都在 preload 白名单里）',
        s.frameApiOk === true, 'api=' + s.frameApiOk + ' why=' + (s.frameWhy || '-'));
      /* v1.11.0：相框转为正式功能 —— 顶栏入口默认可见，关掉设置后才隐藏 */
      check('相框已转正：产物里默认可见入口，关掉设置后图标隐藏',
        s.frameBtnVisibleByDefault === true && s.frameBtnHiddenAfterDisable === true,
        'defaultVisible=' + s.frameBtnVisibleByDefault + ' afterDisable=' + s.frameBtnHiddenAfterDisable);
      check('相框入口可见且开着之前窗口不存在',
        s.frameBtnVisibleByDefault === true && s.frameBeforeOpen && s.frameBeforeOpen.open === false,
        'visible=' + s.frameBtnVisibleByDefault + ' before=' + JSON.stringify(s.frameBeforeOpen && s.frameBeforeOpen.open));
      check('走真实界面入口能开出相框，并返回可播放张数',
        s.frameOpened > 0 && s.frameExists === true,
        'opened=' + s.frameOpened + ' exists=' + s.frameExists);
      check('相框窗口确实无边框（拿 bounds 与 contentBounds 比，问的是操作系统）',
        s.frameFrameless === true,
        JSON.stringify({ bounds: s.frameBounds, content: s.frameContent }));
      check('相框窗口确实置顶（开启即置顶）', s.frameOnTop === true);
      check('相框出图后主窗口已隐藏（避免两个窗口抢镜）',
        s.framePainted === true && s.frameMainHidden === true,
        'painted=' + JSON.stringify(s.framePainted ? 'ok' : 'none') + ' mainHidden=' + s.frameMainHidden);
      check('相框窗口按图片比例窗口化（宽高比对齐实际图片像素比）',
        s.frameRatioOk === true,
        'want=' + s.frameRatioWant + ' got=' + s.frameRatioGot);
      check('相框窗口内部：拿到清单、正在播放、真的画出了图',
        !!(s.frameInner && s.frameInner.on === true && s.frameInner.remote === true
          && s.frameInner.items > 0 && s.frameInner.order === s.frameInner.items
          && s.frameInner.playing === true && s.frameInner.curW > 0),
        JSON.stringify(s.frameInner && {
          on: s.frameInner.on, items: s.frameInner.items, order: s.frameInner.order,
          playing: s.frameInner.playing, w: s.frameInner.curW, h: s.frameInner.curH,
        }));
      check('相框窗口里不渲染图库外壳（只留相框层）',
        !!(s.frameInner && s.frameInner.mainHidden === true && s.frameInner.hasBar === true));
      check('相框里的置顶按钮作用于相框窗口本身（与主窗口互不干扰）',
        !!(s.framePinFlip && s.framePinFlip.before === true && s.framePinFlip.after === false
          && s.framePinRestored === true),
        JSON.stringify(s.framePinFlip));

      /* v1.9.0 —— 控制条感应区 / 相册下拉 / 拖动吸附，都在**真实无边框窗口**里跑一遍 */
      check('相框窗口里：控制条默认隐藏、是感应区子元素、带常驻抓手',
        !!(s.frameUi && s.frameUi.barHiddenByDefault === true
          && s.frameUi.barInsideHot === true && s.frameUi.hasGrip === true),
        JSON.stringify(s.frameUi));
      check('相框窗口里：指针移入下缘 → 控制条出现；移开 → 立刻收起',
        !!(s.frameUi && s.frameUi.shownOnHotIn === true && s.frameUi.hiddenOnHotOut === true),
        'in=' + (s.frameUi && s.frameUi.shownOnHotIn) + ' out=' + (s.frameUi && s.frameUi.hiddenOnHotOut));
      check('相框窗口里：控制条带相册下拉（全部图片 / 只看收藏 / 文件夹）',
        !!(s.frameUi && s.frameUi.hasSrcSel === true && s.frameUi.srcOptions >= 2),
        'sel=' + (s.frameUi && s.frameUi.hasSrcSel) + ' options=' + (s.frameUi && s.frameUi.srcOptions));
      check('拖到贴近屏幕边缘 → 真的吸附贴齐，并记下贴的是哪条边',
        !!(s.frameSnap && s.frameSnap.flush === true && s.frameSnap.dock === 'left'),
        JSON.stringify(s.frameSnap));
      check('取消贴边后窗口停在原处，不会被硬拉回边缘',
        s.frameUndock === 'none' && s.frameUndockStayed === true,
        'dock=' + s.frameUndock + ' stayed=' + s.frameUndockStayed);
      check('退出相框后窗口关闭、主窗口自动回来',
        !!(s.frameAfterClose && s.frameAfterClose.open === false && s.frameAfterClose.mainShown === true),
        JSON.stringify(s.frameAfterClose));
      /* v1.11.0：三条新能力，断言都落在"结果"上 */
      check('鼠标拖动相框：窗口真的被搬到预期位置；拖动不误触发换图、普通单击仍能换图',
        !!(s.frameDrag && s.frameDrag.ok === true),
        JSON.stringify(s.frameDrag ? {
          dx: s.frameDrag.dx, dy: s.frameDrag.dy,
          afterDrag: s.frameDrag.firedAfterDragClick, afterPlain: s.frameDrag.firedAfterPlainClick,
        } : null));
      check('多显示器：指定一块不存在的屏幕 → 回落到真实屏幕，窗口不出界',
        !!(s.frameFallback && s.frameFallback.open === true && s.frameFallback.insideAny === true),
        JSON.stringify(s.frameFallback ? { open: s.frameFallback.open, inside: s.frameFallback.insideAny } : null)
          + ' displays=' + s.frameDisplayCount);
      check('相框渲染进程崩溃 → 相框窗口被销毁、主窗口自动回来、且还能再开出来',
        !!(s.frameCrash && s.frameCrash.killed === true && s.frameCrash.frameGone === true
           && s.frameCrash.mainBack === true && s.frameCrash.reopenOk === true),
        JSON.stringify(s.frameCrash));
    },
  },

  /* ---------- 11. 打包产物终检：旋转（Electron 包） ---------- */
  {
    id: 'approt',
    title: '打包产物终检 · 真实点击旋转按钮 4 次均居中（Electron 包）',
    kind: 'probe',
    script: 'probe_rot_final.js',
    key: 'ROTFINAL ',
    tags: ['slow', 'artifact'],
    run: function (ctx) {
      const check = ctx.check, d = ctx.data;
      if (!Array.isArray(d)) { check('探针返回数据', false, '未解析到 ROTFINAL 输出'); return; }
      let bad = [];
      d.forEach(function (r) {
        if (Math.abs(r.dev.dx) > EPS || Math.abs(r.dev.dy) > EPS) bad.push(r.rot + '°(' + r.dev.dx + ',' + r.dev.dy + ')');
        if (r.inView !== true) bad.push(r.rot + '°(超出视口)');
      });
      check('0/90/180/270 旋转全部居中且在视口内', bad.length === 0, bad.join(' '));
    },
  },
];

/* ============================================================
   执行
   ============================================================ */
function runNodeSuite(s) {
  const r = spawnSync(process.execPath, [s.script].concat(s.args || []), {
    cwd: ROOT, encoding: 'utf8', timeout: 180000, windowsHide: true,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const lines = out.trim().split('\n');
  return { code: r.status, tail: lines[lines.length - 1] || '', raw: out };
}

function runProbeSuite(s) {
  const r = runProbe(s.script, { timeout: 240000 });
  const data = {};
  if (s.keys) {
    s.keys.forEach(function (k) {
      const v = extractJSON(r.stdout, k);
      if (v !== null) data[k] = v;
    });
  } else {
    data[s.key] = extractJSON(r.stdout, s.key);
  }
  // 探针日志留档，便于失败后排查
  try { fs.writeFileSync(path.join(LOGS, 'trace-' + s.script.replace(/\.js$/, '') + '.log'), r.stdout + (r.stderr ? '\n[stderr]\n' + r.stderr : '')); } catch (e) { }
  return { code: r.code, stdout: r.stdout, stderr: r.stderr, data: data, error: r.error };
}

/**
 * 递归复制目录。
 * 注意：不要用 fs.cpSync —— 本机 Node 22.22.2 在含中文名的目录树上会直接段错误
 * （exit 139，且无任何输出），排查成本很高。手写一份 20 行的版本更稳。
 */
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name), d = path.join(dst, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) copyTree(s, d);
    else if (st.isFile()) fs.copyFileSync(s, d);
  }
}

/**
 * 跑「打包后的 Electron 应用」自带自检。
 * 两个必须注意的点：
 *  1) fixtures 先整份复制到沙箱再喂给 exe —— 自检会真的删文件再还原，
 *     绝不能让它碰仓库里的素材；
 *  2) 沙箱必须放在**项目同一个盘**（这里用 logs/ 下）。
 *     放到系统临时目录（C:）时，"移入回收站 → 撤销还原" 会因为回收站查不到而
 *     报 not-found —— 那是卷/回收站的环境限制，不是产品缺陷，但会让门禁红。
 */
function runAppSuite(s) {
  const fixtures = path.join(HERE, 'fixtures', '照片夹');
  const sandbox = path.join(LOGS, 'sbx-' + Date.now());
  const openDir = path.join(sandbox, '照片夹');
  let r;
  try {
    copyTree(fixtures, openDir);
    r = runAppSelftest(s.exe, { openDir: openDir, udRoot: sandbox, timeout: 240000 });
  } finally {
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (e) { /* 沙箱残留无所谓，logs/ 不入版本管理 */ }
  }
  try {
    fs.writeFileSync(path.join(LOGS, 'trace-app-selftest.log'),
      (r.stdout || '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '') + '\n\n' + JSON.stringify(r.result, null, 1));
  } catch (e) { }
  return r;
}

function main() {
  const argv = process.argv.slice(2);
  const fast = argv.indexOf('--fast') >= 0;
  const filters = argv.filter(function (a) { return a.charAt(0) !== '-'; });

  let suites = SUITES.slice();
  /* --fast 的取舍：保留全部 node 纯函数套件 + 带 'joint' 标签的"三路径联合回归"。
     ⚠️ tf 虽然是 probe（要起 Electron），但它是**最快的真实 Electron 冒烟测试**
     （约 2 秒，却贡献 43 项里的 29 项）—— 去掉它等于放弃"真实 Electron 里跑一遍
     缩放×旋转×平移"这条防线，不划算。所以 --fast **并不能脱离 Electron**：
     新克隆里没 npm i 时 tf 会报"找不到 electron.exe"（9 套件里 8 通过）。
     措辞一律按此为准，别写成"跳过 Electron"（早先文档就是那么写的，与实际不符）。 */
  if (fast) suites = suites.filter(function (s) { return s.kind === 'node' || (s.tags || []).indexOf('joint') >= 0; });
  if (filters.length) suites = suites.filter(function (s) { return filters.indexOf(s.id) >= 0; });
  // 快测模式：让支持 quickFlag 的 node 套件走精简路径（zip 套件会跳过 268MB 大包）
  if (fast) suites = suites.map(function (s) {
    return (s.quickFlag && !(s.args || []).length) ? Object.assign({}, s, { args: ['--quick'] }) : s;
  });

  console.log('');
  console.log('Atrium · 回归套件');
  console.log('  项目根: ' + ROOT);
  console.log('  套件数: ' + suites.length + (fast ? '（--fast 模式）' : ''));
  console.log('='.repeat(78));

  const results = [];
  const t0 = Date.now();

  suites.forEach(function (s) {
    const check = makeChecker(s.title, results);
    process.stdout.write('▶ ' + s.title + '\n');
    const started = Date.now();
    try {
      if (s.kind === 'node') {
        const ctx = runNodeSuite(s);
        s.run({ check: check, code: ctx.code, tail: ctx.tail, raw: ctx.raw });
      } else if (s.kind === 'app') {
        const ctx = runAppSuite(s);
        s.run.call(s, { check: check, code: ctx.code, app: ctx, result: ctx.result, error: ctx.error });
      } else {
        const ctx = runProbeSuite(s);
        if (ctx.code !== 0) {
          check('探针进程正常退出', false, '退出码 ' + ctx.code + (ctx.error ? ' | ' + ctx.error.message : ''));
        }
        s.run({ check: check, code: ctx.code, data: ctx.data && s.key ? ctx.data[s.key] : ctx.data, keys: ctx.data });
      }
    } catch (e) {
      check('套件执行未抛出异常', false, e && e.message);
    }
    const mine = results.filter(function (r) { return r.suite === s.title; });
    const failed = mine.filter(function (r) { return !r.ok; });
    const ms = Date.now() - started;
    console.log('   ' + (failed.length ? '✗ 失败 ' + failed.length + ' / ' : '✓ 通过 ') + mine.length + ' 项  (' + ms + ' ms)');
    failed.forEach(function (f) { console.log('     ✗ ' + f.name + (f.detail ? '  → ' + f.detail : '')); });
    console.log('');
  });

  const total = results.length;
  const bad = results.filter(function (r) { return !r.ok; });
  console.log('='.repeat(78));
  console.log('断言合计: ' + total + ' 项，通过 ' + (total - bad.length) + '，失败 ' + bad.length +
    '  |  用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  if (bad.length) {
    console.log('');
    console.log('失败清单:');
    bad.forEach(function (f) { console.log('  ✗ [' + f.suite + '] ' + f.name + (f.detail ? '  → ' + f.detail : '')); });
  }
  console.log('='.repeat(78));
  process.exit(bad.length ? 1 : 0);
}

if (require.main === module) main();

module.exports = { SUITES, extractJSON };
