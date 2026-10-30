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

/* ============================================================
   目录授权闸门（vf:loadDir 的入口）
   ------------------------------------------------------------
   这里补的是 pathauth 原本缺的那一半语义：**谁能授权**。

   旧实现里 `vf:loadDir` 收到渲染层传来的任意字符串就 `picAuth.add(dir)`。
   于是"只允许读用户打开过的目录"这道门形同虚设 —— 注入脚本只要先
   invoke 一次 loadDir('C:\\Users\\me')，整个用户目录就变成了合法根，
   接着 vf://pic 想读什么读什么。登记新根目录必须与**用户亲手做的动作**
   （原生目录对话框）绑定，而 loadDir 只负责校验、不负责授予。

   另外这里把"真实路径"也纳入判定：Windows 的目录联接点（junction）与
   符号链接会让 `C:\Pics\link\x` 字面上在授权根之下、实际指向 `C:\Windows`。
   纯前缀比较看不出这件事，必须由调用方给出 fs.realpath 的结果再判一次。
   ============================================================ */
function createDirTrust() {
  const allow = createAllowlist();
  return {
    /** 授予一个目录（只应由原生对话框 / 我们自己持久化的上次目录调用）。
     *  realDir 是该目录的真实路径（fs.realpath），授权根本身是联接点时必需。 */
    grant(dir, realDir) {
      const a = allow.add(dir);
      if (realDir) allow.add(realDir);
      return a;
    },
    /**
     * 这个目录允许打开/索引吗？
     * @param {string} dir 请求的路径
     * @param {string} [realDir] 真实路径。传了就必须也在授权范围内；
     *   传 null/''（解析失败）按**拒绝**处理 —— fail-closed。
     *   不传表示"只做字面判定"（纯逻辑测试与不需要跟随链接的场景）。
     */
    canOpen(dir, realDir) {
      if (!allow.has(dir)) return false;
      if (realDir === undefined) return true;
      if (!realDir) return false;
      return allow.has(realDir);
    },
    /** 字面判定（诊断用） */
    has(dir) { return allow.has(dir); },
    roots() { return allow.roots(); },
    clear() { allow.clear(); },
    get size() { return allow.size; },
  };
}

module.exports = { normPath, isUnder, createAllowlist, createDirTrust };
