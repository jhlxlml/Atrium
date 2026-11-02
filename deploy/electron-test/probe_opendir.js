/* ============================================================
   `--open-dir` 授权后门探针（真实 exe + CDP）
   ------------------------------------------------------------
   背景：以前启动时 `writeLast(argv[idx+1])` 会把命令行给的路径写成"上次目录"，
   下次启动 autoDir 直接 grantDir 它 —— **命令行给个路径 = 拿到整个盘的读权限**，
   而且被持久化（一次启动长期有效）。

   修法：记录里带 `granted`，只有"用户在对话框里选过"才为 true；
   `--open-dir` 只留一条 trace，不写任何东西。

   这个探针用两个独立的 userData 各跑一次，判据是**图库有没有被打开**：

     A. 全新 userData + `--open-dir <目录>`        → 期望 0 张（不授予、不打开）
     B. 全新 userData + 预置 last-dir.json(granted:true)，不带命令行参数
                                                  → 期望 N 张（"自动打开上次文件夹"仍在）

   B 是回归：不能为了堵后门把正常功能一起关掉。

   用法： node probe_opendir.js <目录> [宽] [高]
   ============================================================ */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const EXE = path.join(ROOT, 'deploy', 'dist-electron', 'Atrium_Electron版', 'Atrium.exe');
const DIR = process.argv[2];
const W = +(process.argv[3] || 1200);
const H = +(process.argv[4] || 800);

if (!DIR) { console.error('用法: node probe_opendir.js <目录> [宽] [高]'); process.exit(2); }
if (!fs.existsSync(EXE)) { console.error('找不到打包产物：' + EXE + '\n先跑 npm run build'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitTarget(port, ms) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/list');
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (e) { lastErr = e; }
    await sleep(200);
  }
  throw new Error('等不到 CDP 目标（' + (lastErr ? lastErr.message : '无异常但没有 page') + '）');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const waiting = new Map();
    ws.onopen = () => resolve({
      eval(expression) {
        return new Promise((res, rej) => {
          const myId = ++id;
          waiting.set(myId, { res, rej });
          ws.send(JSON.stringify({
            id: myId, method: 'Runtime.evaluate',
            params: { expression, awaitPromise: true, returnByValue: true },
          }));
          setTimeout(() => { if (waiting.has(myId)) { waiting.delete(myId); rej(new Error('eval 超时')); } }, 60000);
        });
      },
      close() { try { ws.close(); } catch (e) {} },
    });
    ws.onerror = () => reject(new Error('WebSocket 连不上'));
    ws.onmessage = (ev) => {
      let m = null;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m.id || !waiting.has(m.id)) return;
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.result && m.result.exceptionDetails) {
        w.rej(new Error((m.result.exceptionDetails.exception || {}).description || '页面内异常'));
      } else {
        w.res(m.result && m.result.result ? m.result.result.value : null);
      }
    };
  });
}

/**
 * 跑一次应用，返回页面看到的图库条目数。
 * @param {object} o { args: string[], seed: boolean }
 */
async function runOnce(o) {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-opendir-'));
  if (o.seed) {
    /* 相当于"用户上次在对话框里选过这个目录" */
    fs.writeFileSync(path.join(ud, 'last-dir.json'),
      JSON.stringify({ dir: DIR, ts: Date.now(), granted: true }), 'utf8');
  }
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  env.VF_USERDATA = ud;

  const port = 10200 + Math.floor(Math.random() * 400);
  /* --no-sandbox 只用于测试环境（这台机器 GPU 进程起不来）；正式版不带 */
  const args = (o.args || []).concat([
    '--remote-debugging-port=' + String(port),
    '--no-sandbox',
    '--window-size=' + W + ',' + H,
  ]);
  const child = spawn(EXE, args, { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const out = { items: null, welcome: null, error: null };
  try {
    const page = await waitTarget(port, 60000);
    const c = await connect(page.webSocketDebuggerUrl);
    /* 给引导/索引留时间：等到 booted 且 Loader 存在，再等 3s 看它会不会自己开起来 */
    for (let i = 0; i < 60; i++) {
      const booted = await c.eval("document.body && document.body.dataset.booted === '1'");
      if (booted) break;
      await sleep(200);
    }
    await sleep(3000);
    out.items = await c.eval('(window.State && State.items) ? State.items.length : -1');
    out.welcome = await c.eval("!!document.querySelector('.welcome, #welcome, [data-empty]')");
    c.close();
  } catch (e) {
    out.error = e.message;
  }
  try { child.kill(); } catch (e) {}
  await sleep(600);
  try { fs.rmSync(ud, { recursive: true, force: true }); } catch (e) {}
  if (out.error) out.stderrHead = stderr.split('\n').slice(0, 8).join(' | ');
  return out;
}

(async () => {
  const argvCase = await runOnce({ args: ['--open-dir', DIR] });
  const seedCase = await runOnce({ seed: true });

  const verdict = [];
  if (argvCase.items === 0) verdict.push('OK：--open-dir 没有打开目录（后门已关）');
  else if (argvCase.items > 0) verdict.push('BUG：--open-dir 仍然把目录打开了（' + argvCase.items + ' 张）');
  else verdict.push('UNKNOWN：argv 用例没拿到条目数（' + argvCase.error + '）');

  if (seedCase.items > 0) verdict.push('OK：预置 granted 的上次目录仍能自动打开（' + seedCase.items + ' 张）');
  else verdict.push('BUG：正常路径失效（预置 granted 后没打开，items=' + seedCase.items + '）');

  console.log(JSON.stringify({ dir: DIR, argvCase, seedCase, verdict }, null, 2));
})();
