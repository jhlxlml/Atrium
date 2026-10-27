/* ============================================================
   Atrium · 崩溃兜底页（crashlib.js）纯逻辑测试
   ------------------------------------------------------------
   这一页是"渲染进程已经死了"之后唯一还在的东西。它写坏了不会报错，
   只会让用户看到一个空白页或者一段乱码 —— 所以每条都得断言到。

   为什么要把这些从 main.js 抽出来测：留在 main.js 里就只能断言
   "源码里有这段字符串"，那是假绿 —— 字符串在、拼出来的 HTML 是坏的，
   测试照样通过。这里真的把返回值解析一遍。

   重点不是"有没有那几段文字"，而是四件容易写错的事：
   ① reason 映射（未知 reason 要原样带出来，不能假装认识）；
   ② HTML 转义（兜底页是最后一道门，不能假设上游干净）；
   ③ 退出码的出现条件（0 和空串不能写成"退出码 0"，那会让用户
      以为程序是正常退出的）；
   ④ 不加载脚本、不引用外部资源（否则兜底页自己就可能成为一个注入面）。
   ============================================================ */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const L = require(path.join(ROOT, 'deploy', 'electron', 'crashlib.js'));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; return; }
  fail++;
  console.log('  ✗ ' + name + (detail === undefined ? '' : '  ← ' + detail));
};

const H = (reason, code) => L.crashPageHtml(reason, code);

/* ---------- 1. reason 映射 ---------- */
{
  const cases = [
    ['crashed', '界面进程异常崩溃'],
    ['oom', '内存不足'],
    ['killed', '被系统终止'],
    ['launch-failed', '启动失败'],
    ['integrity-failure', '校验失败'],
    ['memory-eviction', '内存'],
  ];
  for (const [reason, needle] of cases) {
    ok('reason=' + reason + ' 有对应的中文说明',
      H(reason).indexOf(needle) >= 0, H(reason).slice(0, 120));
  }
  /* 未知 reason：必须原样带出来。写成"未知错误"会丢掉唯一可诊断的线索 ——
     用户截图给你的时候，那一串英文就是全部信息。 */
  ok('未知 reason 原样带出（不吞成"未知错误"）',
    H('some-new-reason').indexOf('some-new-reason') >= 0);
  ok('reason 缺失时不崩，也有可读文案',
    H(undefined).indexOf('界面进程已退出') >= 0 && H(null).indexOf('界面进程已退出') >= 0);
  ok('reason 为空串时不崩', H('').indexOf('界面进程已退出') >= 0);
}

/* ---------- 2. HTML 转义 ---------- */
{
  const evil = '<img src=x onerror=alert(1)>';
  const html = H(evil);
  ok('未知 reason 里的尖括号被转义（不会变成真的标签）',
    html.indexOf('<img src=x') < 0 && html.indexOf('&lt;img') >= 0);
  ok('转义后仍然是合法文档（<!doctype html> 开头、</html> 结尾）',
    html.indexOf('<!doctype html>') === 0 && html.trim().slice(-7) === '</html>');
  ok('esc() 处理 & < > " 四个字符',
    L.esc('&<>"') === '&amp;&lt;&gt;&quot;', L.esc('&<>"'));
  ok('esc() 对 undefined / null 不抛',
    L.esc(undefined) === 'undefined' && L.esc(null) === 'null');
}

/* ---------- 3. 退出码的出现条件 ---------- */
{
  ok('有退出码时写出来', H('crashed', 1).indexOf('退出码 1') >= 0);
  /* 退出码 0 **要**写出来：它是真实数据，而且"崩溃了但退出码是 0"很反常，
     恰恰是排查时最有用的一条线索。要吞掉的是 undefined / null / 空串。 */
  ok('退出码 0 照实写出来（不因为是假值就吞掉）',
    H('crashed', 0).indexOf('退出码 0') >= 0);
  /* 反向：把实现换成 truthy 判断，0 立刻消失 —— 这条用例是在钉住
     "必须显式判 null，不能用真假值" 这个决定。 */
  {
    const buggy = (code) => (code ? '（退出码 ' + code + '）' : '');
    ok('反向：truthy 判断会把退出码 0 吞掉（说明这里不能靠真假值）',
      buggy(0) === '' && H('crashed', 0).indexOf('退出码 0') >= 0);
  }
  ok('退出码缺失 / 空串 / null 时不写', H('crashed').indexOf('退出码') < 0
    && H('crashed', '').indexOf('退出码') < 0
    && H('crashed', null).indexOf('退出码') < 0);
}

/* ---------- 4. 安全与离线：不加载脚本、不引外部资源 ---------- */
{
  const html = H('crashed', 1);
  ok('页面里没有 <script>', !/<script/i.test(html));
  ok('页面里没有 on* 事件属性（onclick / onerror …）',
    !/\son[a-z]+\s*=/i.test(html));
  ok('没有外部资源引用（http/https/协议相对地址）',
    !/(src|href)\s*=\s*["']?(https?:)?\/\//i.test(html.replace(/href="vf:\/\/app\/index\.html"/g, '')));
  ok('没有 iframe / object / embed', !/<(iframe|object|embed)/i.test(html));
  ok('回链指向 vf://app/index.html（点它 = 重新加载整个应用）',
    html.indexOf('href="vf://app/index.html"') >= 0);
  ok('回链文案是"重新加载"（不是"重试"这种含糊说法）',
    /href="vf:\/\/app\/index\.html">重新加载</.test(html));
  ok('样式是内联 <style>，不依赖外部 CSS 文件',
    /<style>[\s\S]*<\/style>/.test(html) && !/<link/i.test(html));
  ok('声明了 utf-8（否则中文会变乱码）', /<meta charset="utf-8">/.test(html));
}

/* ---------- 5. 说清"数据没丢" ----------
   崩溃最容易让人误以为照片出事了。兜底页的第一职责其实是安抚 + 指路。 */
{
  const html = H('oom', 1);
  ok('明确说明照片/设置没有受影响', html.indexOf('没有受影响') >= 0);
  ok('给了可执行的下一条建议（不是只道歉）',
    html.indexOf('较小的子目录') >= 0 || html.indexOf('重启') >= 0);
  ok('有标题 <h1>（读屏与视觉都需要一个落点）', /<h1>[^<]+<\/h1>/.test(html));
}

/* ---------- 5b. 加载失败（v1.20.3）：与"崩溃"要分开说 ----------
   did-fail-load 以前只写日志，用户看到的是纯白窗口。现在也走兜底页，
   但标题必须换 —— "界面已停止响应"用在"文件没加载出来"上是错的诊断。 */
{
  const html = L.crashPageHtml('load-failed', undefined, { detail: 'ERR_FILE_NOT_FOUND (-6)' });
  ok('加载失败有专属标题（不是"停止响应"）',
    /<h1>界面没能加载出来<\/h1>/.test(html), html.slice(0, 0));
  ok('加载失败的原因可读', html.indexOf('界面文件没能加载出来') >= 0);
  ok('把 Electron 的错误码与描述带出来（排查靠它）',
    html.indexOf('ERR_FILE_NOT_FOUND (-6)') >= 0);
  ok('加载失败时不该出现"退出码"字样（那是崩溃才有的）', html.indexOf('退出码') < 0);
  ok('未知 reason 走"界面进程已退出"兜底，不冒充加载失败',
    /界面进程已退出（weird）/.test(L.crashPageHtml('weird', undefined, { detail: 'x' })));

  /* 反向：detail 来自外部（Electron 的错误描述），必须转义。
     不转义的话一个带 <script> 的错误描述就能在兜底页里执行。 */
  const evil = L.crashPageHtml('load-failed', undefined, { detail: '<script>alert(1)</script>' });
  ok('detail 里的尖括号被转义（不生成 script 标签）',
    evil.indexOf('<script>') < 0 && evil.indexOf('&lt;script&gt;') >= 0);
  ok('detail 转义后整页仍不加载任何脚本', !/<script/i.test(evil));
  ok('给了 detail 就不该再出现空括号', evil.indexOf('（）') < 0);
}

/* ---------- 6. 源码级：main.js 真的用上了这个模块 ---------- */
{
  const main = fs.readFileSync(path.join(ROOT, 'deploy', 'electron', 'main.js'), 'utf8');
  const asm = fs.readFileSync(path.join(ROOT, 'deploy', 'electron', 'assemble.js'), 'utf8');
  ok('main.js require 了 crashlib.js', /require\('\.\/crashlib\.js'\)/.test(main));
  ok('main.js 不再自带一份 crashPageHtml（避免两份实现漂移）',
    !/function crashPageHtml\(/.test(main));
  ok('assemble.js 的 MAIN_FILES 收录了 crashlib.js（否则产物里没有它）',
    /'crashlib\.js'/.test(asm));
  /* v1.20.3：did-fail-load 必须接兜底页，且三种情况要放行 */
  ok('did-fail-load 接上了兜底页（不再是"只写日志"）',
    /did-fail-load[\s\S]{0,900}?showCrashFallback\('load-failed'/.test(main));
  ok('did-fail-load 放行 ERR_ABORTED(-3)（正常导航打断不是故障）',
    /did-fail-load[\s\S]{0,400}?code === -3/.test(main));
  ok('did-fail-load 只处理主框架（子框架失败与主界面无关）',
    /did-fail-load[\s\S]{0,400}?isMainFrame === false/.test(main));
  ok('did-fail-load 不套娃（已经在兜底页上时不再导航）',
    /did-fail-load[\s\S]{0,600}?data:text\/html/.test(main));
}

console.log('崩溃兜底页：' + pass + ' 项通过，' + fail + ' 项失败');
process.exit(fail ? 1 : 0);
