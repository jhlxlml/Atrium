/* ============================================================
   Atrium · 测试用的「浏览器 IIFE 装载器」
   ------------------------------------------------------------
   js/ 下的模块都是 `(function (global) { ... })(window)` 形式的浏览器脚本，
   Node 里直接 require 会因为没有 window 而抛错。为了能对**未改动的生产代码**
   写回归测试（先看到红，再修到绿），这里不做任何源码改造，而是：

     1. 把 `window` 指到 globalThis；
     2. 装好该模块依赖的最小桩（localStorage / URL / OffscreenCanvas …）；
     3. 用 vm.runInThisContext 在当前全局上下文里执行源码 —— 于是模块里的
        `window.Xxx = ...` 就落在 globalThis 上，测试可以直接取用。

   这样做的好处是「测试看不到实现」：测的是真实的 IIFE 装配结果，
   而不是把逻辑搬到 Node 里另写一份。
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

/** 把 window 指向 globalThis（幂等） */
function useGlobalAsWindow() {
  globalThis.window = globalThis;
}

/** 在当前全局上下文执行一个浏览器脚本 */
function loadScript(rel) {
  const abs = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  const src = fs.readFileSync(abs, 'utf8');
  vm.runInThisContext(src, { filename: abs });
}

/** localStorage 桩：内存实现，支持 size/clear，行为与浏览器一致到「只收字符串」 */
function makeLocalStorage(init) {
  const m = new Map(Object.entries(init || {}));
  return {
    getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
    setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: (k) => { m.delete(String(k)); },
    clear: () => m.clear(),
    key: (i) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size; },
    _dump: () => Object.fromEntries(m),
  };
}

/**
 * Blob URL 台账：记录每次 create/revoke，供「有没有漏回收 / 有没有提前回收」断言。
 * 每个 URL 带一个 tag，便于在断言里读成人话。
 */
function makeUrlLedger() {
  let seq = 0;
  const created = [];
  const revoked = [];
  const live = new Set();
  return {
    api: {
      createObjectURL(blob) {
        const u = 'blob:vf/' + (++seq);
        created.push({ url: u, blob });
        live.add(u);
        return u;
      },
      revokeObjectURL(u) {
        revoked.push(u);
        live.delete(u);
      },
    },
    created,
    revoked,
    live,
    get createdCount() { return created.length; },
    get revokedCount() { return revoked.length; },
    /** 创建过但从未被回收的 URL */
    leaked() { return Array.from(live); },
    /** 被回收了两次（或回收了不存在的 URL）—— 说明有人拿着旧引用乱放 */
    doubleRevoked() {
      const seen = new Set();
      const dup = [];
      for (const u of revoked) { if (seen.has(u)) dup.push(u); else seen.add(u); }
      return dup;
    },
  };
}

/** 极简断言框架（与 test/transform.test.js 同风格，便于输出统一） */
function makeAsserts() {
  let pass = 0, fail = 0;
  const failures = [];
  const ok = (name, cond, detail) => {
    if (cond) { pass++; return true; }
    fail++;
    failures.push(name + (detail ? '  → ' + detail : ''));
    return false;
  };
  const eq = (name, actual, expected) => ok(name, actual === expected, '实测 ' + JSON.stringify(actual) + '，期望 ' + JSON.stringify(expected));
  const finish = (title) => {
    const line = '='.repeat(64);
    console.log('\n' + line);
    if (fail) {
      console.log(title + '：通过 ' + pass + ' / ' + (pass + fail) + ' —— 失败 ' + fail + ' 项');
      for (const f of failures) console.log('  ✗ ' + f);
    } else {
      console.log(title + '：通过 ' + pass + ' / ' + (pass + fail));
    }
    console.log(line);
    return fail === 0;
  };
  return { ok, eq, finish, get pass() { return pass; }, get fail() { return fail; }, failures };
}

/** 微任务/宏任务让路：等 n 个 tick 或 ms 毫秒 */
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));

module.exports = { ROOT, useGlobalAsWindow, loadScript, makeLocalStorage, makeUrlLedger, makeAsserts, tick };
