/* ============================================================
   Atrium · icon_gate.js —— 品牌图标门禁
   ------------------------------------------------------------
   为什么要有：图标是交付物的门面（favicon / 窗口 / 任务栏全用它），
   而 ICO 是个手写的二进制容器 —— 字节数对得上不代表内容对
   （v1.5.0 的 ZIP CRC 就是栽在"长度一致"这种假安全感上）。
   所以这里跑真正的结构校验 + 反向用例，由 run_all.js 逐条断言。

   解析逻辑复用 deploy/verify_icon.js，本脚本只负责产出 JSON。
   输出一行：ICONGATE { ... }
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const ICON = path.join(ROOT, 'brand', 'icon.ico');

const out = {
  path: ICON,
  exists: fs.existsSync(ICON),
  bytes: 0,
  count: 0,
  sizes: [],
  errors: [],
  ok: false,
  reverseAllRejected: false,
  reverseCases: [],
};

try {
  const { checkIco, selfTest } = require(path.join(ROOT, 'deploy', 'verify_icon.js'));

  if (out.exists) {
    const buf = fs.readFileSync(ICON);
    out.bytes = buf.length;
    out.count = buf.length >= 6 ? buf.readUInt16LE(4) : 0;

    const r = checkIco(buf);
    out.ok = r.ok;
    out.sizes = r.entries.map(function (e) { return e.declared; });
    out.errors = r.errors;

    const st = selfTest(buf);
    out.reverseCases = st.map(function (c) { return { name: c.name, rejected: c.rejected }; });
    out.reverseAllRejected = st.every(function (c) { return c.rejected; });
  }
} catch (e) {
  out.errors.push('门禁脚本异常：' + String((e && e.message) || e));
}

console.log('ICONGATE ' + JSON.stringify(out));
process.exit(0);
