/* ============================================================
   Atrium · Electron 探针启动器
   ------------------------------------------------------------
   为什么需要它：
   本机的 shell 环境里被注入了 ELECTRON_RUN_AS_NODE=1 与 NODE_OPTIONS
   （含一个 shim），它们会让 electron.exe 退化成纯 Node 进程去执行探针，
   于是 app.whenReady() 永远不触发、探针静默退出。用 `env -u` 清除无效
   （会被上层重新注入），必须在 spawn 时用显式 env 对象覆盖。

   用法：node deploy/electron-test/run_probe.js probe_center.js
        node deploy/electron-test/run_probe.js --all
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

const HERE = __dirname;
const ELECTRON_MODULES = path.resolve(HERE, '..', 'electron', 'node_modules');

/* ------------------------------------------------------------
   探针的两个输出目录必须在**跑任何探针之前**就存在。
   ------------------------------------------------------------
   · shots/ —— 12 个探针会往里写截图与几何 JSON（`path.resolve(__dirname,'..','shots')`），
     而且 probe_grid / probe_zoom 这些是**先写文件、后打印结果行**。
     目录不存在 → writeFileSync 抛 ENOENT → 探针在输出结果前就死了，
     上层只看到「未解析到 GRID 输出」，完全看不出是目录缺失。
   · logs/  —— 探针把 VF_USERDATA 指到 `logs/ud_<tag>_<ts>`。

   这里曾经只在 runAppSelftest() 里建 shots/，跑普通探针时**从不建** ——
   历史上一直"碰巧"存在（被自检通过一次就留下了），直到 2026-10-12 做目录整理
   把 shots/ 清掉，10 个写截图的探针集体失败，才暴露出来。
   ------------------------------------------------------------ */
const SHOTS = path.join(HERE, 'shots');
const LOGS = path.join(HERE, 'logs');
for (const d of [SHOTS, LOGS]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* 已存在 / 无权限 */ }
}

/** 解析 electron.exe 路径（优先要求 electron 模块，失败则回退固定路径） */
function electronPath() {
  try {
    const p = require(path.join(ELECTRON_MODULES, 'electron'));
    if (typeof p === 'string' && fs.existsSync(p)) return p;
  } catch (_) { /* 回退 */ }
  const fallback = path.join(ELECTRON_MODULES, 'electron', 'dist', 'electron.exe');
  if (fs.existsSync(fallback)) return fallback;
  throw new Error('找不到 electron.exe');
}

/** 干净的 Electron 运行环境：剥掉会改变其启动模式的变量 */
function cleanEnv(extra) {
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;   // 否则退化为 Node
  delete env.NODE_OPTIONS;           // 否则 shim 干扰主进程
  delete env.ELECTRON_ENABLE_LOGGING;
  env.NODE_PATH = ELECTRON_MODULES;
  env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1';
  return Object.assign(env, extra || {});
}

/**
 * 运行一个探针脚本。
 * @param {string} script  探针名（如 'probe_zoom.js'，自动去 probes/ 找）或绝对路径
 * @param {object} [opts]  { timeout, tag }
 * @returns {{code:number, stdout:string, stderr:string, ok:boolean}}
 */
function runProbe(script, opts) {
  const o = opts || {};
  let abs;
  if (path.isAbsolute(script)) abs = script;
  else {
    const rel = path.join(HERE, script);
    abs = fs.existsSync(rel) ? rel : path.join(HERE, 'probes', script);
  }
  if (!fs.existsSync(abs)) throw new Error('探针不存在: ' + script);
  const exe = electronPath();
  const r = spawnSync(exe, [abs], {
    cwd: path.resolve(HERE, '..', '..'),
    env: cleanEnv(),
    encoding: 'utf8',
    timeout: o.timeout || 180000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    code: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    ok: r.status === 0,
    error: r.error || null,
  };
}

/**
 * 跑「打包后的 Electron 应用」自带自检（--selftest）。
 * 这是最接近真实用户的验证：不是跑源码树，而是跑装进包里的 exe。
 * 用独立临时 userData（避免污染真实记忆），并用干净 env 启动（同 runProbe 的原因）。
 *
 * @param {string} exe   打包产物的 exe 绝对路径
 * @param {object} [opts] { openDir, udRoot, timeout }
 * @returns {{ok:boolean, code:number, result:object|null, stdout:string, stderr:string, error:Error|null}}
 */
function runAppSelftest(exe, opts) {
  const o = opts || {};
  if (!fs.existsSync(exe)) return { ok: false, code: -1, result: null, stdout: '', stderr: '', error: new Error('找不到 exe: ' + exe) };
  // userData 默认放系统临时目录；若调用方给了 udRoot（项目同盘沙箱）就用它
  const ud = o.udRoot
    ? (fs.mkdirSync(path.join(o.udRoot, 'userdata'), { recursive: true }), path.join(o.udRoot, 'userdata'))
    : fs.mkdtempSync(path.join(require('os').tmpdir(), 'vf-selftest-'));
  const rf = path.join(ud, 'result.txt');
  // 自检里相框窗口要留一张截图（无边框 + 按比例，肉眼复核用）—— SHOTS 已在模块顶部建好
  const args = ['--selftest', '--no-sandbox'];
  if (o.openDir) args.push('--open-dir', o.openDir);
  const r = spawnSync(exe, args, {
    cwd: path.resolve(HERE, '..', '..'),
    env: cleanEnv({ VF_USERDATA: ud, VF_RESULT_FILE: rf, VF_SHOTDIR: SHOTS }),
    encoding: 'utf8',
    timeout: o.timeout || 180000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  let result = null;
  try {
    const raw = fs.readFileSync(rf, 'utf8');
    result = JSON.parse(raw.replace(/^SELFTEST_RESULT\s*/, ''));
  } catch (e) { /* 没写出结果文件 → result 保持 null */ }
  return {
    ok: r.status === 0 && !!result && result.pass === true,
    code: r.status,
    result: result,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error || null,
  };
}

module.exports = { runProbe, runAppSelftest, electronPath, cleanEnv };

/* ---------- 直接以 CLI 运行时：单跑一个探针 ---------- */
if (require.main === module) {
  const args = process.argv.slice(2);
  const script = args[0];
  if (!script) {
    console.error('用法: node run_probe.js <probe_xxx.js>');
    process.exit(2);
  }
  const r = runProbe(script);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.error) console.error('启动失败:', r.error.message);
  process.exit(r.ok ? 0 : 1);
}
