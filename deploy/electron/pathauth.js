/* ============================================================
   Atrium · vf://pic 的读盘授权（纯逻辑）
   ------------------------------------------------------------
   为什么需要它：`vf://pic/<base64 路径>` 的原始实现是**把 base64 解出来的
   任何绝对路径直接交给 net.fetch**。也就是说渲染层手里有一台"读任意文件"的机器：
   只要拼出 `C:\Users\me\.ssh\id_rsa` 的 base64，就能把私钥读成 Blob。
   渲染层本来是 sandbox + contextIsolation 的，这道口子把它绕过去了 ——
   一旦有 HTML 注入（innerHTML 拼字符串的地方不少），私钥、浏览器 cookie
   全都在射程内。

   正确的语义是：**只允许读用户自己打开过的那个目录里的文件**。
   所以这里维护一份"授权根目录"清单，`vf:loadDir` 成功时把目录登记进来，
   `handleVf` 在处理 pic 请求前先问一句"这个路径在授权范围内吗"。

   判定必须**先归一化再比较**：
     · Windows 路径大小写不敏感 → 统一小写；
     · `..` 必须被折叠掉，否则 `C:\Pics\..\..\Windows\System32\x.dll`
       会以 `c:/pics/` 开头而骗过前缀检查；
     · 分隔符统一成 `/`，避免 `\` 与 `/` 混用造成漏判；
     · 前缀比较要带边界，`C:\Pics` 不能放行 `C:\Pics2\a.png`。
   这些正好是"写错了不报错、只是悄悄多放行了一个文件"的东西，
   所以抽成纯函数由 test/pathauth.test.js 覆盖（含一串必须被拒的反向用例）。
   ============================================================ */
'use strict';

const path = require('path');

/** 归一化成一个可比较的键：绝对化（折叠 . 与 ..）→ 反斜杠转正斜杠 → 小写。 */
function normPath(p) {
  if (typeof p !== 'string' || !p) return '';
  let s;
  try { s = path.win32.resolve(p); } catch (e) { return ''; }
  return s.replace(/\\/g, '/').toLowerCase();
}

/** abs 是否落在 root 之内（含 root 自身）。两边都先归一化。 */
function isUnder(abs, root) {
  const a = normPath(abs);
  const r = normPath(root);
  if (!a || !r) return false;
  if (a === r) return true;
  const rr = r.charAt(r.length - 1) === '/' ? r : r + '/';
  return a.indexOf(rr) === 0;
}

/** 授权根目录清单。add() 幂等；has() 对空清单恒 false（默认拒绝）。 */
function createAllowlist() {
  const roots = new Set();
  return {
    /** 登记一个目录（loadDir 成功后调用）。返回归一化后的键，便于日志。 */
    add(dir) {
      const r = normPath(dir);
      if (r) roots.add(r);
      return r;
    },
    /** 这个绝对路径允许读吗 */
    has(abs) { return roots.size > 0 && Array.from(roots).some((r) => isUnder(abs, r)); },
    /** 清空（退出登录 / 切目录时用；目前未用到，留着便于测试与将来） */
    clear() { roots.clear(); },
    /** 当前授权根（诊断/测试用） */
    roots() { return Array.from(roots); },
    get size() { return roots.size; },
  };
}

module.exports = { normPath, isUnder, createAllowlist };
