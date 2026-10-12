/* ============================================================
   Atrium · updatelib.js （版本更新检测的**纯逻辑**）
   ------------------------------------------------------------
   主进程与回归套件共用同一份实现 —— 与 exportlib.js 同一个理由：
   避免「测试测的是另一份复制粘贴的代码」这种假绿。

   为什么把这几件事单独抽出来：它们都是纯函数，可以脱离 Electron
   毫秒级断言；而真正需要 Electron 的只有两件事 —— 发请求（net.fetch）
   与开系统浏览器（shell.openExternal）。抽出来之后，
   「版本号怎么比」与「哪些 URL 允许交给系统打开」这两条
   最容易写错、又最难在界面上看出来的规则，就有了独立门禁。

   ⚠️ 本文件**不得** require('electron') —— 它要能被 run_all.js 直接 require。
   ============================================================ */
'use strict';

/** 官方仓库地址（「关于」面板展示用，也是 openExternal 白名单的唯一前缀） */
const REPO_URL = 'https://github.com/jhlxlml/Atrium';
/** GitHub「最新 release」接口。写死在这里 —— 绝不接受渲染层传来的 URL */
const RELEASES_API = 'https://api.github.com/repos/jhlxlml/Atrium/releases/latest';

/**
 * 是否允许交给系统浏览器打开。
 * 只放行官方仓库及其子路径（/releases、/issues、/blob/…），且必须是 https。
 *
 * 为什么必须白名单：`shell.openExternal` 能打开任意协议 —— 一旦放行 `file://`，
 * 就等于给渲染层（以及任何被注入的脚本）一个"执行本地文件"的能力，
 * 是明确的安全倒退。这里连 github.com 上的**其它**仓库也不放行：
 * 本应用只需要打开它自己。
 */
function isAllowedExternal(url) {
  if (typeof url !== 'string' || !url) return false;
  let u;
  try { u = new URL(url); } catch (e) { return false; }
  if (u.protocol !== 'https:') return false;
  // 精确比对主机名：'github.com.evil.tld' 与 'github.com@evil.tld' 都过不了这一关
  if (u.hostname !== 'github.com') return false;
  // 端口也必须默认（否则 https://github.com:8443/... 会指向另一台服务）
  if (u.port && u.port !== '443') return false;
  return u.pathname === '/jhlxlml/Atrium' || u.pathname.indexOf('/jhlxlml/Atrium/') === 0;
}

/**
 * 从 'v1.14.0' / '1.14.0' / '1.14.0-beta.1' 里取 [major, minor, patch]。
 * 解析不出来返回 null（调用方据此判定"这不是一个版本号"，而不是当成 0.0.0）。
 * 只取前三段数字：本项目的版本号恒为三段式，预发布后缀不参与比较。
 */
function parseVer(s) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/i.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * latest 是否比 current 新。
 * 任一版本号解析失败 → **一律返回 false**：宁可漏报一次更新，
 * 也不要在版本号格式意外时弹一句"发现新版本"。
 */
function isNewer(latest, current) {
  const a = parseVer(latest), b = parseVer(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/**
 * 从 releases/latest 的响应体里取 { latest, url }。
 * 形状不对（没有可解析的 tag_name）→ 返回 null，由调用方判为 'bad-response'。
 * html_url 缺失时回落到仓库的 releases 页 —— 不编造链接。
 */
function latestFromRelease(data) {
  if (!data || typeof data !== 'object') return null;
  const tag = typeof data.tag_name === 'string' ? data.tag_name : '';
  if (!parseVer(tag)) return null;
  const url = (typeof data.html_url === 'string' && data.html_url)
    ? data.html_url
    : (REPO_URL + '/releases');
  return { latest: tag.replace(/^v/i, ''), url: url };
}

module.exports = {
  REPO_URL: REPO_URL,
  RELEASES_API: RELEASES_API,
  isAllowedExternal: isAllowedExternal,
  parseVer: parseVer,
  isNewer: isNewer,
  latestFromRelease: latestFromRelease,
};
