/* ============================================================
   Atrium · A11y 纯函数与播报区单元测试（纯 Node）
   ------------------------------------------------------------
   为什么值得单测：无障碍这层最坑的不是"写不出来"，是**写错了照样跑**。
     - Tab 循环算错一位 → 焦点跳过第一个控件，或者卡在原地不动，
       屏幕上完全看不出来（按钮都在、都能点），只有真按键盘才发现；
     - tabindex 边界判错 → 把显式移出 Tab 序的元素（网格瓦片上的收藏 /
       删除按钮就是 tabIndex=-1）又拽回 Tab 序里；
     - 播报区写错 → **同一条消息连播两次时内容没变，辅助技术收不到
       "变更"事件**，第二次静默。这个连肉眼都验证不了，只能靠断言。

   a11y.js 是挂 window 的 IIFE，顶层不碰 DOM（DOM 只在函数体里用），
   所以沙箱里给一个 window 就能加载 —— 播报区那几条再补一个假 document。

   运行： node test/a11y.test.js
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

/* ---------- 在沙箱里加载 a11y.js ---------- */
function loadA11y(doc) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'a11y.js'), 'utf8');
  const sandbox = { console, document: doc };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'a11y.js' });
  return sandbox.A11y;
}

/* 假元素：记录 textContent 的**每一次**赋值，这样才能观测到
   "先清空再写回"这个肉眼看不见、却决定第二次播报会不会静默的动作。 */
function fakeEl() {
  const attrs = {};
  const childNodes = [];
  const history = [];
  let text = '';
  const el = {
    tagName: 'DIV', id: '', className: '', isConnected: true, childNodes,
    get textContent() { return text; },
    set textContent(v) { text = String(v); history.push(text); },
    get _history() { return history; },
    get _attrs() { return attrs; },
    hasAttribute: (n) => Object.prototype.hasOwnProperty.call(attrs, n),
    getAttribute: (n) => (Object.prototype.hasOwnProperty.call(attrs, n) ? attrs[n] : null),
    setAttribute: (n, v) => { attrs[n] = String(v); },
    removeAttribute: (n) => { delete attrs[n]; },
    appendChild: (c) => { childNodes.push(c); return c; },
    focus() {},
  };
  return el;
}

/* ---------- 模块形状 ---------- */
const BARE = loadA11y(undefined);   // 沙箱里连 document 都没有

let loadOk = true;
try { loadA11y(undefined); } catch (e) { loadOk = false; }
ok('加载期不碰 DOM（无 document 也能加载）', loadOk);

for (const fn of ['live', 'liveState', 'trap', 'focusables', 'name',
  'isTabbableAttr', 'stepIndex', 'pickInitialIdx']) {
  eq('导出 ' + fn, typeof BARE[fn], 'function');
}

/* ============================================================
   一、isTabbableAttr —— tabindex 缺省 / 非法 / 负数
   ============================================================ */
const ita = BARE.isTabbableAttr;

eq('属性缺省 + 原生可聚焦 → 0', ita(null, true), 0);
eq('属性缺省 + 非原生 → 不进 Tab 序', ita(null, false), -1);
eq('undefined 同缺省', ita(undefined, true), 0);
eq('空串按缺省处理（原生）', ita('', true), 0);
eq('空串按缺省处理（非原生）', ita('', false), -1);

eq('显式 0 让非原生元素可聚焦', ita('0', false), 0);
eq('显式 0 与原生一致', ita('0', true), 0);
eq('负数显式移出 Tab 序', ita('-1', true), -1);
eq('其它负数原样返回（语义同样是移出 Tab 序）', ita('-5', true), -5);
ok('任何负数都判为"不进 Tab 序"', ita('-1', true) < 0 && ita('-5', true) < 0 && ita('-99', false) < 0);
eq('正数原样返回', ita('3', true), 3);

eq('非法值回落到原生默认（可聚焦）', ita('abc', true), 0);
eq('非法值回落到原生默认（不可聚焦）', ita('abc', false), -1);
eq('带空白的整数能解析', ita('  -1  ', true), -1);
eq('小数值按整数解析规则截断（同 HTML 解析整数）', ita('2.9', true), 2);

/* ============================================================
   二、stepIndex —— Tab / Shift+Tab 的循环数学
   ============================================================ */
const si = BARE.stepIndex;

eq('空列表 → -1', si(0, -1, false), -1);
eq('空列表反向 → -1', si(0, 0, true), -1);
eq('负数长度 → -1', si(-3, 0, false), -1);

eq('正向推进', si(3, 0, false), 1);
eq('正向到尾环绕到头部', si(3, 2, false), 0);
eq('反向推进', si(3, 1, true), 0);
eq('反向到头环绕到尾部', si(3, 0, true), 2);

eq('当前下标非法（-1）正向从头部开始', si(3, -1, false), 0);
eq('当前下标非法（-1）反向从尾部开始', si(3, -1, true), 2);
eq('当前下标越界正向从头部开始', si(3, 5, false), 0);
eq('当前下标越界反向从尾部开始', si(3, 5, true), 2);
eq('NaN 下标按非法处理', si(5, NaN, false), 0);
eq('undefined 下标反向 → 尾部', si(5, undefined, true), 4);

eq('只有一个元素时正向停在原地', si(1, 0, false), 0);
eq('只有一个元素时反向停在原地', si(1, 0, true), 0);
eq('两个元素来回', si(2, 1, false) === 0 && si(2, 0, true) === 1, true);

/* ============================================================
   三、pickInitialIdx —— 打开容器时焦点落在谁身上
   ============================================================ */
const pii = BARE.pickInitialIdx;

eq('无候选 → -1', pii([], {}), -1);
eq('markers 为空 → -1', pii(null, {}), -1);
eq('没有标记时取第一个', pii([false, false], {}), 0);
eq('有标记时取标记位', pii([false, true, false], {}), 1);
eq('显式 autofocus 压过标记', pii([false, true, false], { autofocus: 2 }), 2);
eq('显式 autofocus 压过默认', pii([false, false], { autofocus: 1 }), 1);
eq('越界的 autofocus 被忽略 → 回落标记', pii([false, true, false], { autofocus: 9 }), 1);
eq('负数 autofocus 被忽略', pii([false, false], { autofocus: -1 }), 0);
eq('标记压过 preferIndex（删确认弹层要的是"取消"优先）',
  pii([false, true, false], { preferIndex: 2 }), 1);
eq('无标记时启用 preferIndex', pii([false, false], { preferIndex: 1 }), 1);
eq('越界 preferIndex 被忽略', pii([false, false], { preferIndex: 3 }), 0);
eq('负数 preferIndex 被忽略', pii([false, false], { preferIndex: -1 }), 0);
eq('多个标记取最靠前的', pii([false, true, true], {}), 1);

/* ============================================================
   四、播报区 —— live / liveState
   ============================================================ */
const liveEl = fakeEl();
const doc = {
  getElementById: (id) => (id === 'a11yLive' ? liveEl : null),
  body: fakeEl(),
  createElement: () => fakeEl(),
  activeElement: null,
};
const A = loadA11y(doc);

const first = A.live('已移入回收站');
eq('播报写入常驻区', first, true);
eq('文本落地', liveEl.textContent, '已移入回收站');
eq('默认 aria-live=polite', liveEl.getAttribute('aria-live'), 'polite');
eq('默认 role=status', liveEl.getAttribute('role'), 'status');
eq('aria-atomic 由 index.html 提供（此处不覆盖）', liveEl.getAttribute('aria-atomic'), null);
eq('计数递增到 1', A.liveState().count, 1);

/* 同一条消息连播两次：内容不变的话辅助技术收不到"变更"事件，
   第二次就是静默的。这条断言盯的就是"有没有先清空再写回"。 */
liveEl._history.length = 0;
A.live('已移入回收站');
eq('同一条消息仍写回同一文本', liveEl.textContent, '已移入回收站');
ok('同一条消息先清空再写（否则第二次播报静默）',
  liveEl._history.length >= 2 && liveEl._history[0] === '',
  JSON.stringify(liveEl._history));
eq('计数继续递增到 2', A.liveState().count, 2);

A.live('导出失败：目标磁盘已满', { urgent: true });
eq('urgent → aria-live=assertive', liveEl.getAttribute('aria-live'), 'assertive');
eq('urgent → role=alert', liveEl.getAttribute('role'), 'alert');

A.live('已还原 3 张');
eq('回到 aria-live=polite', liveEl.getAttribute('aria-live'), 'polite');
eq('回到 role=status', liveEl.getAttribute('role'), 'status');

A.live(null);
eq('null 播报为空串', liveEl.textContent, '');
A.live(undefined);
eq('undefined 播报为空串', liveEl.textContent, '');
A.live(0);
eq('0 不被当成空值丢掉', liveEl.textContent, '0');

const snap = A.liveState();
ok('liveState 报 present', snap.present === true);
eq('liveState 的 last 跟上最后一次', snap.last, '0');
ok('liveState 的 count 是数字', typeof snap.count === 'number' && snap.count > 0);

/* 没有播报区、也没有 body 可挂 —— 必须安全降级，不能把触发它的业务动作带崩 */
const bare = loadA11y({
  getElementById: () => null, body: null, createElement: null, activeElement: null,
});
eq('无播报区时 live 安全返回 false', bare.live('随便什么'), false);
eq('无播报区时 liveState 报 absent', bare.liveState().present, false);

/* ============================================================
   五、focusables / trap 的入参防御（DOM 真相交给 Chromium 探针）
   ============================================================ */
eq('focusables(null) → 空数组', A.focusables(null).length, 0);
eq('focusables(非元素) → 空数组', A.focusables({}).length, 0);
ok('trap(null) 返回可调用的空操作', (() => {
  const r = A.trap(null);
  if (typeof r !== 'function') return false;
  r(); r();     // 可重复调用，不应抛错
  return true;
})());

/* ============================================================
   汇总
   ============================================================ */
console.log('');
console.log('a11y 纯函数与播报区：' + pass + ' 项通过，' + fail + ' 项失败');
if (fail) {
  console.log('');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
