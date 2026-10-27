/* ============================================================
   Atrium · crashlib.js （崩溃兜底页）
   ------------------------------------------------------------
   主窗口渲染进程崩掉之后（crashed / oom / 启动期被杀之后用户拒绝降级），
   主进程会把窗口导航到这一页。以前是**什么都不做** —— 白屏，没有提示、
   没有重载入口，用户只能强杀进程。

   为什么单独成一个模块：这一页里有真正的逻辑 —— reason 到中文的映射、
   HTML 转义、退出码拼装、回链。放在 main.js 里就只能靠"源码里有没有这段字符串"
   来断言，那是**假绿**：字符串在、拼出来的东西是坏的，测试照样通过。
   抽出来之后可以真的把返回值解析一遍（见 test/crashlib.test.js）。

   这一页刻意做到：
   · 不加载任何脚本（没有 <script>）—— 拿不到 window.vfNative，也没有注入面；
   · 不引用任何外部资源（字体、图片、样式表）—— 离线可用，也符合 CSP 精神；
   · 只有一个回链 href="vf://app/index.html"，点它是**用户发起**的导航，
     will-navigate 放行 vf://app，所以会重新加载整个应用。
   ============================================================ */
'use strict';

/** reason → 给用户看的一句话。未知的 reason 原样带出来，别假装认识它。 */
const REASON_TEXT = {
  crashed: '界面进程异常崩溃',
  oom: '内存不足，界面进程被系统终止',
  killed: '界面进程被系统终止',
  'launch-failed': '界面进程启动失败',
  'integrity-failure': '程序文件校验失败',
  'memory-eviction': '系统为回收内存结束了界面进程',
  /* 页面文件压根没加载出来（vf:// 协议没注册、产物缺文件、磁盘读失败）。
     这一支以前没有：did-fail-load 只往日志里写一行，用户看到的是**纯白窗口**，
     既没有提示也没有重载入口。 */
  'load-failed': '界面文件没能加载出来',
};

/** 标题按 reason 分：崩溃是"停止响应"，加载失败是"没加载出来" —— 别混为一谈。 */
const PAGE_TITLE = {
  'load-failed': '界面没能加载出来',
};
const DEFAULT_TITLE = '界面已停止响应';

/** HTML 转义。reason 与 exitCode 都不该带尖括号，但兜底页是最后一道门，
    不能假设上游一定是干净的 —— 转义的成本是零。 */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 生成兜底页 HTML。
 * @param {string} reason  render-process-gone 的 detail.reason，或 'load-failed'
 * @param {number|string} [exitCode]  detail.exitCode（可选）
 * @param {object} [opts]  { detail } 额外一行诊断信息（如 'ERR_FILE_NOT_FOUND -6'）
 * @returns {string} 完整的 HTML 文档
 */
function crashPageHtml(reason, exitCode, opts) {
  const key = String(reason == null ? '' : reason);
  const o = opts || {};
  const why = REASON_TEXT[key] || ('界面进程已退出（' + key + '）');
  const title = o.title || PAGE_TITLE[key] || DEFAULT_TITLE;
  /* exitCode **只要是个值就照实写**，包括 0。
     为什么不写成 `exitCode ? … : …`：0 是假值，truthy 判断会把它吞掉 ——
     而"退出码 0"恰恰是最需要被看见的那一个（它和"崩溃"放在一起很反常，
     是排查时最有用的一条线索）。真正该被吞掉的是 undefined / null / 空串，
     所以这里显式判它们，而不是靠真假值。
     detail 是给"加载失败"用的：那种情况没有退出码，有的是错误码与描述。 */
  const hasCode = exitCode !== undefined && exitCode !== null && exitCode !== '';
  const extra = hasCode ? '（退出码 ' + esc(exitCode) + '）'
    : (o.detail ? '（' + esc(o.detail) + '）' : '');
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<title>Atrium · 需要重新加载</title><style>'
    + 'html,body{height:100%;margin:0}'
    + 'body{display:flex;align-items:center;justify-content:center;'
    + 'font:15px/1.7 "Microsoft YaHei",system-ui,sans-serif;'
    + 'background:#f7f5f1;color:#3a372f}'
    + '.box{max-width:460px;padding:32px 36px;text-align:left}'
    + 'h1{margin:0 0 12px;font-size:19px;font-weight:600}'
    + 'p{margin:0 0 12px;color:#6b6559}'
    + 'a{display:inline-block;margin-top:6px;padding:8px 18px;border-radius:8px;'
    + 'background:#3a372f;color:#f7f5f1;text-decoration:none}'
    + 'a:focus-visible{outline:2px solid #3a372f;outline-offset:3px}'
    + '.hint{font-size:13px;color:#8d867a;margin-top:22px}'
    + '</style></head><body><div class="box">'
    + '<h1>' + esc(title) + '</h1>'
    + '<p>' + esc(why) + extra + '。</p>'
    + '<p>照片、设置和收藏都没有受影响 —— 重新加载只是把界面重新载入一次。</p>'
    + '<p><a href="vf://app/index.html">重新加载</a></p>'
    + '<p class="hint">如果反复出现：多半是当前目录里的图片太多或太大。'
    + '可以先只打开一个较小的子目录试试；仍然不行就重启 Atrium。</p>'
    + '</div></body></html>';
}

module.exports = { REASON_TEXT, PAGE_TITLE, esc, crashPageHtml };
