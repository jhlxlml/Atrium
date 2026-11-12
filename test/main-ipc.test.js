/* ============================================================
   Atrium · deploy/electron/main.js 源级安全接线断言
   ------------------------------------------------------------
   main.js 有 2400+ 行、30 个 IPC 通道，不可能在纯 Node 里
   完整装配（依赖 Electron 的 app/BrowserWindow/ipcMain/shell…）。
   但安全闸门是否"接对了线"，可以通过**读源码文本**来锁住：

   - vf:loadDir 必须先查 dirTrust.has，再 realpath，不能自行 picAuth.add
   - vf:autoDir 必须先判 rec.granted === true 才 grantDir
   - vf:setLastDir 必须先查 dirTrust.has 才 writeLast
   - --open-dir 不能出现 writeLast / grantDir 调用
   - vf:readHead 必须先查 picAuth.has 再 picAllowed
   - vf:deleteFile / vf:deleteFiles 必须先查 picAuth.has 再 picAllowed
   - vf:openExternal 必须先走 isAllowedExternal 白名单
   - isTrustedSender 包装了 ipcMain.handle/on

   这套断言不会因为重构"变量名"而误报（只看结构模式），
   但如果有人删掉了一道安全检查，会立刻变红。

   反向实验：把 main.js 回退到 ba0bb89（PR #1 之前），
   这套断言里 loadDir/autoDir/setLastDir/open-dir/readHead
   的相关条目全部变红（那些检查当时不存在）。

   运行： node test/main-ipc.test.js
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { makeAsserts } = require('./_harness');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'electron', 'main.js'), 'utf8');

/* 把注释行剥掉，防止"以前是 xxx"的说明性注释被误匹配 */
const stripped = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/* 提取某个 IPC handler 的代码块（从 ipcMain.handle/on 到下一个 ipcMain 出现） */
function handlerBlock(name) {
  const tag = "ipcMain.handle('" + name + "'" ;
  const tag2 = "ipcMain.on('" + name + "'";
  const start = stripped.indexOf(tag) >= 0 ? stripped.indexOf(tag) : stripped.indexOf(tag2);
  if (start < 0) return '';
  /* 找下一个 ipcMain. 出现的位置 */
  const rest = stripped.slice(start + 20);
  const next = rest.search(/ipcMain\.(handle|on)\(/);
  return next > 0 ? stripped.slice(start, start + 20 + next) : stripped.slice(start);
}

const A = makeAsserts();

/* ---------- vf:loadDir ---------- */

const loadDirBlock = handlerBlock('vf:loadDir');

A.ok('loadDir: 先查 dirTrust.has 再 realpath',
  /dirTrust\.has\(dir\)/.test(loadDirBlock) &&
  /fs\.realpath\(dir\)/.test(loadDirBlock) &&
  loadDirBlock.indexOf('dirTrust.has(dir)') < loadDirBlock.indexOf('fs.realpath(dir)'),
  'dirTrust.has 必须出现在 realpath 之前'
);

A.ok('loadDir: 不再自行 picAuth.add（不在 loadDir handler 里）',
  !/vf:loadDir[\s\S]*?picAuth\.add/.test(stripped),
  'loadDir handler 里不应该出现 picAuth.add'
);

A.ok('loadDir: canOpen 校验真实路径',
  /dirTrust\.canOpen\(dir,\s*real\)/.test(stripped),
  '必须用 canOpen(dir, real) 校验 realpath 结果'
);

A.ok('loadDir: 失败返回 denied reason',
  /reason:\s*['"]denied['"]/.test(stripped),
  '未授权时必须返回 reason: denied'
);

/* ---------- vf:autoDir ---------- */

const autoDirBlock = handlerBlock('vf:autoDir');

A.ok('autoDir: 先判 rec.granted !== true 再 grantDir',
  /rec\.granted\s*!==\s*true/.test(autoDirBlock) &&
  /grantDir\(dir\)/.test(autoDirBlock) &&
  autoDirBlock.indexOf('rec.granted !== true') < autoDirBlock.indexOf('grantDir(dir)'),
  'granted 判定必须出现在 grantDir 之前'
);

A.ok('autoDir: 未授权时返回 null（不 crash、不 grant）',
  /autodir-untrusted/.test(stripped),
  'trace 里必须有 autodir-untrusted 标记'
);

/* ---------- vf:setLastDir ---------- */

A.ok('setLastDir: 先查 dirTrust.has 再 writeLast',
  /vf:setLastDir[\s\S]*?dirTrust\.has\(dir\)/.test(stripped) &&
  /vf:setLastDir[\s\S]*?writeLast/.test(stripped),
  'setLastDir handler 里必须先 dirTrust.has 再 writeLast'
);

A.ok('setLastDir: 未授权时不写（trace setlastdir-deny）',
  /setlastdir-deny/.test(stripped),
  '必须有 setlastdir-deny trace'
);

/* ---------- --open-dir ---------- */

A.ok('open-dir: 不出现 writeLast(argv…) 或 grantDir(argv…)',
  !/--open-dir[\s\S]*?writeLast/.test(stripped) &&
  !/--open-dir[\s\S]*?grantDir/.test(stripped),
  '--open-dir 分支不能写记录或授权'
);

A.ok('open-dir: 只 trace（open-dir-ignored）',
  /open-dir-ignored/.test(stripped),
  '必须有 open-dir-ignored trace'
);

/* ---------- vf:readHead ---------- */

A.ok('readHead: 先查 picAuth.has 再 picAllowed',
  /vf:readHead[\s\S]*?picAuth\.has\(p\)/.test(stripped) &&
  /vf:readHead[\s\S]*?picAllowed\(p\)/.test(stripped),
  'readHead handler 里必须先 picAuth.has 再 picAllowed'
);

A.ok('readHead: 读大小有上限',
  /Math\.max\(1,\s*Math\.min\(n\s*\|\|\s*262144,\s*1024\s*\*\s*1024\)\)/.test(stripped),
  '读取长度必须 clamp 到 [1, 1MB]'
);

/* ---------- vf:deleteFile / vf:deleteFiles ---------- */

A.ok('deleteFile: 先查 picAuth.has 再 picAllowed',
  /vf:deleteFile[\s\S]*?picAuth\.has\(p\)/.test(stripped) &&
  /vf:deleteFile[\s\S]*?picAllowed\(p\)/.test(stripped),
  'deleteFile handler 里必须先 picAuth.has 再 picAllowed'
);

A.ok('deleteFiles: 先查 picAuth.has 再 picAllowed',
  /vf:deleteFiles[\s\S]*?picAuth\.has\(p\)/.test(stripped) &&
  /vf:deleteFiles[\s\S]*?picAllowed\(p\)/.test(stripped),
  'deleteFiles handler 里必须先 picAuth.has 再 picAllowed'
);

/* ---------- vf:openExternal ---------- */

A.ok('openExternal: 先走 isAllowedExternal 白名单',
  /isAllowedExternal\(url\)/.test(stripped),
  '必须先调 isAllowedExternal 校验白名单'
);

A.ok('openExternal: 非白名单返回 false',
  /拒绝打开非白名单外链/.test(stripped) || /return\s+false/.test(stripped.slice(stripped.indexOf('openExternal'))),
  '非白名单 URL 必须拒绝'
);

/* ---------- isTrustedSender ---------- */

A.ok('isTrustedSender 包装了 ipcMain.handle',
  /ipcMain\.handle\s*=\s*\(ch,\s*fn\)\s*=>\s*rawHandle\(ch,\s*\(e,\s*\.\.\.a\)\s*=>\s*\(isTrustedSender\(e\)/.test(stripped),
  'ipcMain.handle 必须被 isTrustedSender 包装'
);

A.ok('isTrustedSender 包装了 ipcMain.on',
  /ipcMain\.on\s*=\s*\(ch,\s*fn\)\s*=>\s*rawOn\(ch,\s*\(e,\s*\.\.\.a\)\s*=>\s*\{[^}]*isTrustedSender\(e\)/.test(stripped),
  'ipcMain.on 必须被 isTrustedSender 包装'
);

/* ---------- grantDir 双登记 ---------- */

A.ok('grantDir: realpath 后双登记（picAuth + dirTrust）',
  /grantDir[\s\S]*?picAuth\.add\(dir\)[\s\S]*?picAuth\.add\(real\)[\s\S]*?dirTrust\.grant\(dir,\s*real\)/.test(stripped),
  'grantDir 必须同时登记字面路径和真实路径到 picAuth 和 dirTrust'
);

/* ---------- picAllowed 复核真实路径 ---------- */

A.ok('picAllowed: 复核 realpath 在授权范围内',
  /async\s+function\s+picAllowed[\s\S]*?fs\.realpath/.test(stripped),
  'picAllowed 必须对 realpath 结果做复核'
);

/* ---------- vf://pic 协议 复核 ---------- */

A.ok('vf://pic: 复核 picAuth.has + picAllowed',
  /picAuth\.has\(abs\)/.test(stripped) &&
  /picAllowed\(abs\)/.test(stripped),
  'vf://pic 协议必须先 picAuth.has 再 picAllowed'
);

/* ---------- lastdir.js require ---------- */

A.ok('main.js: require lastdir.js',
  /require\(['"]\.\/lastdir\.js['"]\)/.test(stripped),
  'main.js 必须 require lastdir.js'
);

/* ---------- 汇总 ---------- */
const ok = A.finish('main.js IPC 安全接线断言');
process.exit(ok ? 0 : 1);
