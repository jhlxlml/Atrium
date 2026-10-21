/* ============================================================
   Atrium · type_gate.js —— 字号体系门禁（Node，秒级）
   ------------------------------------------------------------
   只做一件事：把三份 CSS 里的 `font-size` 声明全数扫一遍，
   输出原始事实给 run_all.js 断言。**不在这里判对错**（项目约定：
   探针只测量，断言集中在 run_all.js）。

   守的四条：
     1) 没有写死 px 的 font-size —— 一律走 --fs-* 令牌；
     2) 引用的 --fs-* 全部有定义；
     3) 定义的 --fs-* 全部被用到（定义了没人用 = 说明体系在漂移）；
     4) 令牌值本身落在整数档位上（半像素会重新引入"差 0.5px"的毛病）。

   输出最后一行：TYPEGATE {json}
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const FILES = ['css/main.css', 'css/lightbox.css', 'css/frame.css'];

/* 非像素字号是允许的（响应式大标题），但必须显式登记，
   否则等于"这里悄悄绕过了令牌体系"。 */
const NON_PX_ALLOW = [
  { file: 'css/main.css', selector: '.empty-title', why: '空态主标题用 clamp() 跟视口走' },
];

/* 把注释替换成**等长空格**：下标不变，但往回找选择器时不会把注释正文当成选择器。
   （不这么做的话 `.empty-title` 前面那段注释会被读成选择器，白名单永远匹配不上。） */
function blankComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function selectorAt(src, idx) {
  const brace = src.lastIndexOf('{', idx);
  if (brace < 0) return '';
  const start = Math.max(src.lastIndexOf('}', brace), src.lastIndexOf(';', brace), src.lastIndexOf('{', brace - 1)) + 1;
  const end = src.indexOf('{', start);
  return src.slice(start, end).replace(/\s+/g, ' ').trim();
}
function lineAt(src, idx) { return src.slice(0, idx).split('\n').length; }

const out = {
  files: {},
  tokens: {},
  hardcoded: [],
  nonPx: [],
  undefinedTokens: [],
  unusedTokens: [],
  counts: {},
  ok: true,
};

const used = new Set();
const defined = new Map();

for (const rel of FILES) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { out.ok = false; out.files[rel] = 'MISSING'; continue; }
  const src = fs.readFileSync(abs, 'utf8');

  /* --- 令牌定义（只在 :root 里）--- */
  if (rel === 'css/main.css') {
    const root = src.slice(src.indexOf(':root'), src.indexOf('}', src.indexOf(':root')));
    const reTok = /--fs(-[a-z0-9]+)?:\s*([0-9.]+)px/g;
    let m;
    while ((m = reTok.exec(root))) defined.set('--fs' + (m[1] || ''), parseFloat(m[2]));
  }

  /* --- 每一处 font-size（在"注释已抹平"的副本上扫，选择器才认得准）--- */
  const flat = blankComments(src);
  const re = /font-size:\s*([^;}]+)/g;
  let m2;
  let n = 0;
  while ((m2 = re.exec(flat))) {
    const raw = m2[1].trim();
    const sel = selectorAt(flat, m2.index);
    const line = lineAt(flat, m2.index);
    n++;

    const varM = raw.match(/^var\((--fs[a-z0-9-]*)\)$/);
    if (varM) {
      used.add(varM[1]);
      out.counts[varM[1]] = (out.counts[varM[1]] || 0) + 1;
      continue;
    }
    const pxM = raw.match(/^([0-9.]+)px$/);
    if (pxM) {
      out.hardcoded.push(rel + ':' + line + '  ' + sel.slice(0, 56) + ' => ' + raw);
      continue;
    }
    /* 剩下的都是非像素（clamp / 百分比 / 关键字） */
    const allow = NON_PX_ALLOW.find((a) => a.file === rel &&
      sel.split(',').some((s) => s.trim().startsWith(a.selector)));
    out.nonPx.push({ file: rel, line: line, selector: sel.slice(0, 56), value: raw, allowed: !!allow });
  }
  out.files[rel] = n;
}

out.tokens = Object.fromEntries([...defined.entries()].sort((a, b) => a[1] - b[1]));
out.undefinedTokens = [...used].filter((t) => !defined.has(t)).sort();
out.unusedTokens = [...defined.keys()].filter((t) => !used.has(t)).sort();

/* 令牌值必须落在整数档位：0.5px 的档位等于把"差半像素"重新请回来 */
out.halfTokens = Object.entries(out.tokens).filter(([, v]) => v !== Math.round(v)).map(([k, v]) => k + '=' + v + 'px');
out.hardcodedCount = out.hardcoded.length;
out.nonPxUnallowed = out.nonPx.filter((x) => !x.allowed).length;

console.log('TYPEGATE ' + JSON.stringify(out));
