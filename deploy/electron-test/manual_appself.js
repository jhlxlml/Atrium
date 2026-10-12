/* 手工单跑「打包后的 exe 自带自检」，带 VF_TRACE。
 *
 * 为什么需要它：`run_all.js appself` 走的是 spawnSync + 240s 超时，
 * 一旦自检在某个 await 上挂住，外部只能看到"一行标题之后什么都没有"，
 * 完全没有信息。这个脚本把 VF_TRACE 打开、超时收到 150s，并把 trace 尾巴打出来，
 * 用来定位挂在哪一步（MEMORY.md §32：改完自检先跑一次带 trace 的手工调用）。
 *
 * 用法：node deploy/electron-test/manual_appself.js [超时秒数]
 */
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
const ROOT = path.resolve(HERE, '..', '..');
const LOGS = path.join(HERE, 'logs');
const exe = path.join(ROOT, 'deploy', 'dist-electron', 'Atrium_Electron版', 'Atrium.exe');
const timeoutS = Number(process.argv[2] || 150);

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name), d = path.join(dst, name);
    if (fs.statSync(s).isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

if (!fs.existsSync(exe)) { console.error('找不到 exe:', exe); process.exit(2); }

const sandbox = path.join(LOGS, 'sbx-manual-' + Date.now());
const ud = path.join(sandbox, 'userdata');
fs.mkdirSync(ud, { recursive: true });
const openDir = path.join(sandbox, '照片夹');
copyTree(path.join(HERE, 'fixtures', '照片夹'), openDir);

const rf = path.join(ud, 'result.txt');
const trace = path.join(sandbox, 'trace.log');
const shots = path.join(HERE, 'shots');
fs.mkdirSync(shots, { recursive: true });

// 环境变量必须是 **Windows 路径**（MSYS 的 /d/... 会被 fs 当成相对路径而抛错，
// 又被 try/catch 吞掉 → 看起来"什么日志都没有"，极易误判成进程没起来）
const env = Object.assign({}, process.env, {
  VF_USERDATA: ud, VF_RESULT_FILE: rf, VF_TRACE: trace, VF_SHOTDIR: shots,
});
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

console.log('exe   :', exe);
console.log('sandbox:', sandbox);
console.log('超时  :', timeoutS + 's');
const t0 = Date.now();
const r = spawnSync(exe, ['--selftest', '--no-sandbox', '--open-dir', openDir], {
  cwd: ROOT, env, encoding: 'utf8', timeout: timeoutS * 1000, maxBuffer: 32 * 1024 * 1024,
});
console.log('用时  :', ((Date.now() - t0) / 1000).toFixed(1) + 's', '| status=', r.status,
  '| error=', r.error ? r.error.message : 'none');

function tail(p, n) {
  try { const s = fs.readFileSync(p, 'utf8'); return s.slice(-n); }
  catch (e) { return '(读不到: ' + e.message + ')'; }
}
fs.writeFileSync(path.join(LOGS, 'trace-manual-appself.log'),
  '--- trace ---\n' + tail(trace, 200000) + '\n\n--- result ---\n' + tail(rf, 200000) + '\n\n--- stdout ---\n'
  + (r.stdout || '') + '\n--- stderr ---\n' + (r.stderr || ''));

console.log('\n================ VF_TRACE（尾部）================');
console.log(tail(trace, 6000));
console.log('\n================ 结果文件（尾部）================');
console.log(tail(rf, 4000));
