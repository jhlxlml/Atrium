/* ============================================================
   Atrium · 更新检测纯逻辑单元测试（纯 Node，不需要 Electron）
   ------------------------------------------------------------
   为什么值得单测：updatelib.js 里这三件事**写错了都不会报错**，
   而且症状都是"看起来正常"——
     · isNewer 比反了 → 永远显示"已是最新"，用户以为项目停更了；
       或者永远显示"有新版本"，变成一个狼来了的按钮；
     · parseVer 太宽松 → 'nightly' 被当成版本号 → 误报更新；
     · isAllowedExternal 太宽松 → 主进程的 shell.openExternal 变成
       一个"打开任意 URL / 执行本地文件"的能力（安全倒退，且**没有任何
       界面迹象**）。这一条尤其需要**反向用例**：只测"官方链接能过"，
       等于没测 —— 恒真的门禁。
   所以本文件的重点在后半段：一串**必须被拒**的 URL。

   运行： node test/updatelib.test.js
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const U = require(path.join(__dirname, '..', 'deploy', 'electron', 'updatelib.js'));

/* ---------- 极简断言框架 ---------- */
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail ? '  → ' + detail : ''));
}
function eq(name, got, want) {
  ok(name, got === want, '实测 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want));
}

/* ============================================================
   1) parseVer —— 只认三段式数字，认不出就是 null
   ============================================================ */
eq("parseVer('v1.14.0')", JSON.stringify(U.parseVer('v1.14.0')), '[1,14,0]');
eq("parseVer('1.14.0')", JSON.stringify(U.parseVer('1.14.0')), '[1,14,0]');
eq("parseVer('V2.0.1')", JSON.stringify(U.parseVer('V2.0.1')), '[2,0,1]');
eq("parseVer(' 1.2.3 ') 前后空白", JSON.stringify(U.parseVer(' 1.2.3 ')), '[1,2,3]');
eq("parseVer('1.14.0-beta.1') 预发布后缀不参与比较",
  JSON.stringify(U.parseVer('1.14.0-beta.1')), '[1,14,0]');
eq("parseVer('10.200.3000') 多位数字", JSON.stringify(U.parseVer('10.200.3000')), '[10,200,3000]');

eq("parseVer('nightly') → null", U.parseVer('nightly'), null);
eq("parseVer('1.14') 两段式 → null", U.parseVer('1.14'), null);
eq("parseVer('') → null", U.parseVer(''), null);
eq('parseVer(null) → null', U.parseVer(null), null);
eq('parseVer(undefined) → null', U.parseVer(undefined), null);
eq("parseVer('v') → null", U.parseVer('v'), null);

/* ============================================================
   2) isNewer —— 版本比较。任何一边解析不出，一律 false（宁可漏报，不误报）
   ============================================================ */
eq("isNewer('1.14.0','1.13.0')", U.isNewer('1.14.0', '1.13.0'), true);
eq("isNewer('v1.14.0','1.13.0') 带 v", U.isNewer('v1.14.0', '1.13.0'), true);
eq("isNewer('1.13.1','1.13.0') 补丁位", U.isNewer('1.13.1', '1.13.0'), true);
eq("isNewer('2.0.0','1.99.99') 主版本优先", U.isNewer('2.0.0', '1.99.99'), true);
eq("isNewer('1.14.0','1.14.0') 同版本", U.isNewer('1.14.0', '1.14.0'), false);
eq("isNewer('1.13.0','1.14.0') 比当前旧", U.isNewer('1.13.0', '1.14.0'), false);
eq("isNewer('1.12.9','1.13.0') 次版本优先于补丁", U.isNewer('1.12.9', '1.13.0'), false);
eq("isNewer('nightly','1.13.0') 非法版本 → false", U.isNewer('nightly', '1.13.0'), false);
eq("isNewer('1.14.0','') 当前版本为空 → false", U.isNewer('1.14.0', ''), false);
eq('isNewer(null,null) → false', U.isNewer(null, null), false);
/* 关键边界：'1.13.10' 与 '1.13.9' 必须按**数值**比，不能按字符串比
   （字符串比较会得出 '1.13.10' < '1.13.9'，把一次真实更新吞掉）。 */
eq("isNewer('1.13.10','1.13.9') 数值比较而非字典序", U.isNewer('1.13.10', '1.13.9'), true);

/* ============================================================
   3) isAllowedExternal —— 正向：官方链接必须放行
   ============================================================ */
const REPO = U.REPO_URL;
eq('仓库地址与预期一致', REPO, 'https://github.com/jhlxlml/Atrium');
eq('放行：仓库首页', U.isAllowedExternal(REPO), true);
eq('放行：仓库首页（带尾斜杠）', U.isAllowedExternal(REPO + '/'), true);
eq('放行：releases 列表', U.isAllowedExternal(REPO + '/releases'), true);
eq('放行：某个 release 详情页（更新提示会用到）',
  U.isAllowedExternal(REPO + '/releases/tag/v1.14.0'), true);
eq('放行：issues', U.isAllowedExternal(REPO + '/issues'), true);
eq('放行：查询串', U.isAllowedExternal(REPO + '?tab=readme-ov-file'), true);
eq('放行：锚点', U.isAllowedExternal(REPO + '#readme'), true);

/* ---------- 反向：这些**必须**被拒 ----------
   只测"能过"的门禁是恒真的。下面每一条都对应一种真实攻击面。 */
const REJECT = [
  ['http 明文', 'http://github.com/jhlxlml/Atrium'],
  ['其它站点', 'https://evil.example.com/'],
  ['非 https 协议 file://', 'file:///C:/Windows/System32/calc.exe'],
  ['非 https 协议 javascript:', 'javascript:alert(1)'],
  ['非 https 协议 vbs', 'vbs:msgbox'],
  ['github 首页（不是本仓库）', 'https://github.com/'],
  ['同前缀但不同仓库', 'https://github.com/jhlxlml/AtriumX'],
  ['同前缀点号后缀', 'https://github.com/jhlxlml/Atrium.evil'],
  ['同前缀点号后缀（斜杠版）', 'https://github.com/jhlxlml/Atrium.evil/x'],
  ['github 上的其它仓库', 'https://github.com/other/repo'],
  ['子域名伪装', 'https://github.com.evil.tld/jhlxlml/Atrium'],
  ['userinfo 伪装', 'https://github.com@evil.tld/jhlxlml/Atrium'],
  ['raw 域名', 'https://raw.githubusercontent.com/jhlxlml/Atrium/main/index.html'],
  ['api 域名', 'https://api.github.com/repos/jhlxlml/Atrium'],
  ['非默认端口', 'https://github.com:8443/jhlxlml/Atrium'],
  ['路径穿越', 'https://github.com/jhlxlml/Atrium/../../evil'],
  ['大小写不同的 owner', 'https://github.com/JHLXLML/Atrium'],
];
for (const [label, url] of REJECT) {
  eq('拒绝：' + label, U.isAllowedExternal(url), false);
}
eq('拒绝：空串', U.isAllowedExternal(''), false);
eq('拒绝：null', U.isAllowedExternal(null), false);
eq('拒绝：undefined', U.isAllowedExternal(undefined), false);
eq('拒绝：数字', U.isAllowedExternal(12345), false);
eq('拒绝：对象', U.isAllowedExternal({ href: REPO }), false);
eq('拒绝：数组', U.isAllowedExternal([REPO]), false);

/* ============================================================
   4) latestFromRelease —— 从接口响应里取版本号与链接
   ============================================================ */
{
  const g1 = U.latestFromRelease({ tag_name: 'v1.14.0', html_url: REPO + '/releases/tag/v1.14.0' });
  ok('取 tag_name 与 html_url', !!g1 && g1.latest === '1.14.0' && g1.url === REPO + '/releases/tag/v1.14.0',
    JSON.stringify(g1));
}
{
  const g2 = U.latestFromRelease({ tag_name: '1.14.0' });
  ok('html_url 缺失时回落到仓库 releases 页（不编造链接）',
    !!g2 && g2.latest === '1.14.0' && g2.url === REPO + '/releases', JSON.stringify(g2));
}
{
  const g3 = U.latestFromRelease({ tag_name: 'v1.14.0', html_url: 12345 });
  ok('html_url 不是字符串时同样回落',
    !!g3 && g3.url === REPO + '/releases', JSON.stringify(g3));
}
eq("tag_name='nightly' → null", U.latestFromRelease({ tag_name: 'nightly' }), null);
eq('空对象 → null', U.latestFromRelease({}), null);
eq('null → null', U.latestFromRelease(null), null);
eq("字符串 → null", U.latestFromRelease('1.14.0'), null);

/* ============================================================
   5) 跨文件一致性 —— 渲染层那份 REPO_URL 必须与这里逐字相同
      （settings.js 里写着「查看新版本」的回落地址；写歪了，
       按钮点下去会被主进程白名单拒掉，而界面上看不出原因）
   ============================================================ */
{
  const settingsSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'settings.js'), 'utf8');
  ok('settings.js 里的 REPO_URL 与 updatelib.js 一致',
    settingsSrc.indexOf("'" + REPO + "'") >= 0,
    '在 js/settings.js 里找不到字面量 ' + REPO);
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'electron', 'main.js'), 'utf8');
  ok('main.js 走 updatelib 的判定（没有自己另写一套白名单）',
    mainSrc.indexOf('updateLib.isAllowedExternal') >= 0
      && mainSrc.indexOf('updateLib.RELEASES_API') >= 0);
  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'electron', 'preload.js'), 'utf8');
  ok('preload 暴露了 checkUpdate 与 openExternal 两条通道',
    preloadSrc.indexOf("'vf:checkUpdate'") >= 0 && preloadSrc.indexOf("'vf:openExternal'") >= 0);
  ok('updatelib.js 不依赖 electron（必须能被 Node 直接 require）',
    require(path.join(__dirname, '..', 'deploy', 'electron', 'updatelib.js')) === U);
}

/* ============================================================
   汇总
   ============================================================ */
console.log('');
console.log('updatelib 纯逻辑：' + pass + ' 项通过，' + fail + ' 项失败');
if (fail) {
  console.log('');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
