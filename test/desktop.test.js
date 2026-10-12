/* ============================================================
   Atrium · 桌面集成（原生菜单 / 托盘 / 右键菜单）纯函数单测（纯 Node）
   ------------------------------------------------------------
   为什么值得单测：这一层是"写错了也不报错"的重灾区 ——
     · 菜单里少接一个 cmd → 菜单项画得出来、点得下去，就是没反应；
     · 加速键拼错一个字母 → Electron 不抛错，只是注册不上，
       点菜单能用、按键不能用（最难被发现的一种坏法）；
     · 两条菜单项抢同一个加速键 → 后者被**静默丢弃**；
     · 右键菜单的 checked 不跟状态 → 明明已收藏却显示"收藏这张"。
   以上四种全都没有任何运行时报错，只能靠断言。

   最后一条是**跨文件**断言：菜单模板里出现的每个 cmd，都必须在
   js/app.js 的命令表里有实现。这是"第六问（谁负责让它生效）"的机械化
   —— 本项目已经因为"界面做好了、调用链没接上"栽过六次。

   运行： node test/desktop.test.js
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const spec = require(path.join(__dirname, '..', 'deploy', 'electron', 'desktop-spec.js'));

/* ---------- 极简断言框架（与 test/a11y.test.js 同款） ---------- */
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

/* ---------- 小工具：按 label 找菜单项 ---------- */
function find(nodes, label) {
  for (const n of nodes) {
    if (n.label === label) return n;
    if (n.submenu) { const r = find(n.submenu, label); if (r) return r; }
  }
  return null;
}
function allLabels(nodes, out) {
  out = out || [];
  for (const n of nodes) {
    if (n.label) out.push(n.label);
    if (n.submenu) allLabels(n.submenu, out);
  }
  return out;
}
function collectCmds(nodes, out) {
  out = out || [];
  for (const n of nodes) {
    if (n.cmd) out.push(n.cmd);
    if (n.submenu) collectCmds(n.submenu, out);
  }
  return out;
}

/* ============================================================
   1. 模板一致性（正向）
   ============================================================ */
{
  const r = spec.auditTemplates();
  ok('真实模板全部通过一致性审查', r.ok, r.problems.join(' | '));
}

/* ============================================================
   2. 审查器本身有效（反向用例）
   ------------------------------------------------------------
   只做正向断言的话，审查器哪怕写成一个恒返回 ok 的空函数也照样绿。
   ============================================================ */
{
  const bad1 = spec.auditNodes([{ name: 'X', nodes: [{ label: 'A', accel: 'Ctrl+QQQ', cmd: 'open-folder' }] }]);
  ok('反向：未知键名会被拒绝', !bad1.ok, JSON.stringify(bad1.problems));

  const bad2 = spec.auditNodes([{ name: 'X', nodes: [{ label: 'A', accel: 'Z', cmd: 'open-folder' }] }]);
  ok('反向：缺修饰键会被拒绝', !bad2.ok, JSON.stringify(bad2.problems));

  const bad3 = spec.auditNodes([{ name: 'X', nodes: [
    { label: 'A', accel: 'CmdOrCtrl+K', cmd: 'open-folder' },
    { label: 'B', accel: 'CmdOrCtrl+K', cmd: 'about' },
  ] }]);
  ok('反向：加速键撞车会被拒绝', !bad3.ok, JSON.stringify(bad3.problems));

  const bad4 = spec.auditNodes([{ name: 'X', nodes: [{ label: 'A', cmd: 'no-such-command' }] }]);
  ok('反向：词表外的 cmd 会被拒绝', !bad4.ok, JSON.stringify(bad4.problems));

  const bad5 = spec.auditNodes([{ name: 'X', nodes: [{ label: 'A', role: 'quit', cmd: 'about' }] }]);
  ok('反向：role 与 cmd 并存会被拒绝', !bad5.ok, JSON.stringify(bad5.problems));

  // 反向用例必须"因为正确的原因"失败，而不是碰巧失败
  ok('反向：撞车用例的报错文案指向加速键重复',
    bad3.problems.some((p) => p.indexOf('加速键重复') >= 0), JSON.stringify(bad3.problems));
}

/* ============================================================
   3. checkAccel 正反例
   ============================================================ */
{
  ok('checkAccel 接受 CmdOrCtrl+O', spec.checkAccel('CmdOrCtrl+O').ok);
  ok('checkAccel 接受 CmdOrCtrl+Plus', spec.checkAccel('CmdOrCtrl+Plus').ok);
  ok('checkAccel 接受 CmdOrCtrl+-', spec.checkAccel('CmdOrCtrl+-').ok);
  ok('checkAccel 接受 CmdOrCtrl+Shift+A', spec.checkAccel('CmdOrCtrl+Shift+A').ok);
  ok('checkAccel 接受 F1', spec.checkAccel('F1').ok);
  ok('checkAccel 接受 F24', spec.checkAccel('F24').ok);
  ok('checkAccel 拒绝 F25', !spec.checkAccel('F25').ok);
  ok('checkAccel 拒绝空串', !spec.checkAccel('').ok);
  ok('checkAccel 拒绝 undefined', !spec.checkAccel(undefined).ok);
  ok('checkAccel 拒绝 Ctrl+中', !spec.checkAccel('Ctrl+中').ok);
  ok('checkAccel 拒绝小写修饰键 ctrl+O', !spec.checkAccel('ctrl+O').ok);
}

/* ============================================================
   4. 应用菜单：有状态项跟随输入
   ============================================================ */
{
  const m = spec.appMenuSpec({ mode: 'masonry', blur: true, favOnly: true, pin: false, hasItems: true, hasSel: false });

  eq('排列模式·小图 checked=false', find(m, '小图网格').checked, false);
  eq('排列模式·瀑布流 checked=true', find(m, '瀑布流').checked, true);
  eq('排列模式·单列 checked=false', find(m, '单列整屏').checked, false);
  eq('只看收藏 checked 跟随 state', find(m, '只看收藏').checked, true);
  eq('模糊预览 checked 跟随 state', find(m, '模糊预览（隐私模式）').checked, true);
  eq('窗口置顶 checked 跟随 state', find(m, '窗口置顶').checked, false);

  eq('无选中时「导出选中的图片…」置灰', find(m, '导出选中的图片…').enabled, false);
  eq('有图片时「放大」可用', find(m, '放大').enabled, true);
  eq('有图片时「全选当前页」可用', find(m, '全选当前页').enabled, true);

  const m2 = spec.appMenuSpec({ mode: 'small', hasItems: false, hasSel: true });
  eq('切到小图后 checked 转移', find(m2, '小图网格').checked, true);
  eq('切到小图后瀑布流 checked=false', find(m2, '瀑布流').checked, false);
  eq('有选中时「导出选中的图片…」可用', find(m2, '导出选中的图片…').enabled, true);
  eq('无图片时「放大」置灰', find(m2, '放大').enabled, false);

  // 空状态也必须能建出来（启动瞬间 State.settings 还没铺开）
  ok('appMenuSpec() 无参不抛错', (() => { try { spec.appMenuSpec(); return true; } catch (e) { return false; } })());

  // 编辑菜单里绝不能出现 Ctrl+A —— 图库的「全选当前页」靠它，抢了会两败俱伤
  const edit = find(m, '编辑').submenu;
  ok('编辑菜单里没有占用 Ctrl+A 的项',
    !collectAccels(edit).some((a) => a.toLowerCase() === 'cmdorctrl+a'),
    JSON.stringify(collectAccels(edit)));
}

function collectAccels(nodes, out) {
  out = out || [];
  for (const n of nodes) {
    if (n.accel) out.push(n.accel);
    if (n.submenu) collectAccels(n.submenu, out);
  }
  return out;
}

/* ============================================================
   5. 右键菜单：两种形态 + 状态跟随
   ============================================================ */
{
  const g1 = spec.contextMenuSpec('grid', { selCount: 1, fav: false, rot: 0, hasPath: true });
  const g2 = spec.contextMenuSpec('grid', { selCount: 3, fav: true, rot: 90, hasPath: false });
  const lb = spec.contextMenuSpec('lightbox', { fav: false, rot: 0, fs: false, hasPath: true });
  const lb2 = spec.contextMenuSpec('lightbox', { fav: true, rot: 270, fs: true, hasPath: true });

  eq('图库单张：动作文案是「导出这张…」', find(g1, '导出这张…') !== null, true);
  eq('图库多选：动作文案带张数', find(g2, '导出选中的 3 张…') !== null, true);
  eq('图库多选：删除文案带张数', find(g2, '删除选中的 3 张（移入回收站）') !== null, true);

  eq('图库未收藏 → 显示「收藏这张」', find(g1, '收藏这张') !== null, true);
  eq('图库已收藏 → 显示「取消收藏」', find(g2, '取消收藏') !== null, true);

  eq('未旋转时「恢复原始朝向」置灰', find(g1, '恢复原始朝向').enabled, false);
  eq('旋转过之后「恢复原始朝向」可用', find(g2, '恢复原始朝向').enabled, true);
  eq('270° 也算旋转过', find(lb2, '恢复原始朝向').enabled, true);

  eq('没有磁盘路径时「在资源管理器中显示」置灰', find(g2, '在资源管理器中显示').enabled, false);
  eq('有磁盘路径时可用', find(g1, '在资源管理器中显示').enabled, true);

  eq('大图菜单有「上一张」', find(lb, '上一张') !== null, true);
  eq('大图菜单没有「打开」', find(lb, '打开'), null);
  eq('大图未收藏 → 「收藏这张」', find(lb, '收藏这张') !== null, true);
  eq('大图已收藏 → 「取消收藏」', find(lb2, '取消收藏') !== null, true);
  eq('大图未全屏 → 「全屏显示」', find(lb, '全屏显示') !== null, true);
  eq('大图已全屏 → 「退出全屏」', find(lb2, '退出全屏') !== null, true);

  eq('图库单张时「取消选择」置灰（没选中任何东西）',
    find(spec.contextMenuSpec('grid', { selCount: 0 }), '取消选择').enabled, false);

  ok('未知 kind 也退化成图库形态而不抛错',
    (() => { try { return spec.contextMenuSpec('???', {}).length > 0; } catch (e) { return false; } })());
}

/* ============================================================
   6. 托盘菜单
   ============================================================ */
{
  const v = spec.trayMenuSpec({ visible: true });
  const h = spec.trayMenuSpec({ visible: false });
  eq('窗口可见时提供「隐藏主窗口」', find(v, '隐藏主窗口') !== null, true);
  eq('窗口隐藏时提供「显示主窗口」', find(h, '显示主窗口') !== null, true);
  eq('托盘里有「退出 Atrium」', find(v, '退出 Atrium') !== null, true);
  ok('trayMenuSpec() 无参不抛错', (() => { try { return spec.trayMenuSpec().length > 0; } catch (e) { return false; } })());
}

/* ============================================================
   7. 缩略图按钮图标（ASCII 点阵 → BGRA）
   ============================================================ */
{
  const b = spec.glyphToBGRA(spec.GLYPH_PREV);
  eq('BGRA 缓冲区长度 = 16×16×4', b.length, 16 * 16 * 4);

  const px = (buf, x, y) => {
    const i = (y * 16 + x) * 4;
    return { b: buf[i], g: buf[i + 1], r: buf[i + 2], a: buf[i + 3] };
  };
  const corner = px(b, 0, 0);
  ok('左上角是全透明', corner.a === 0 && corner.r === 0, JSON.stringify(corner));
  const anyOpaque = (() => {
    for (let i = 0; i < b.length; i += 4) if (b[i + 3] > 0) return true;
    return false;
  })();
  ok('图里确实有像素被点亮', anyOpaque);
  const lit = px(b, 3, 7);
  ok('点亮像素是白色不透明（B=G=R=A=255）',
    lit.a === 255 && lit.r === 255 && lit.g === 255 && lit.b === 255, JSON.stringify(lit));

  // 上一张 / 下一张必须互为镜像，否则两个按钮看起来一样
  const rev = spec.GLYPH_PREV.map((r) => r.split('').reverse().join(''));
  eq('「下一张」确实是「上一张」的镜像', spec.GLYPH_NEXT.join('\n'), rev.join('\n'));
  ok('两张图不相同（镜像不是恒等）', spec.GLYPH_NEXT.join('\n') !== spec.GLYPH_PREV.join('\n'));

  eq('缩略图按钮共 3 颗', spec.THUMBAR.length, 3);
  for (const t of spec.THUMBAR) {
    ok('缩略图按钮「' + t.key + '」带 tooltip 与 cmd', !!t.tooltip && !!t.cmd);
    eq('缩略图按钮「' + t.key + '」点阵是 16 行', t.rows.length, 16);
    ok('缩略图按钮「' + t.key + '」每行 16 列', t.rows.every((r) => r.length === 16));
  }
}

/* ============================================================
   8. 跨文件：每个 cmd 都要有实现（"第六问"机械化）
   ------------------------------------------------------------
   菜单模板与渲染层命令表分处两个文件，天然会漂移。这里直接读
   js/app.js 的源码，把 @cmd-table 标记区里的键抠出来比对。
   ============================================================ */
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
  const m = src.match(/\/\* @cmd-table:start \*\/([\s\S]*?)\/\* @cmd-table:end \*\//);
  ok('js/app.js 里有 @cmd-table 标记区', !!m, '没找到标记 → 命令表被挪走或标记被删');

  const body = m ? m[1] : '';
  const impl = new Set();
  const re = /^\s*'([^']+)'\(/gm;
  let hit;
  while ((hit = re.exec(body)) !== null) impl.add(hit[1]);

  const missing = spec.COMMANDS.filter((c) => !impl.has(c));
  const extra = Array.from(impl).filter((c) => spec.COMMANDS.indexOf(c) < 0);

  ok('应用菜单的每个 cmd 都有渲染层实现（缺 ' + missing.length + ' 个）',
    missing.length === 0, '缺：' + missing.join(', '));
  ok('渲染层命令表里没有多余条目（多 ' + extra.length + ' 个）',
    extra.length === 0, '多：' + extra.join(', '));
  eq('实现数与词表数一致', impl.size, spec.COMMANDS.length);

  /* 右键/托盘命令由渲染层另一张表实现（CTX 前缀）或主进程自己处理（tray:）。
     这里只锁住"必须有人接"：渲染层要么在 App.CTX_COMMANDS 里，要么在主进程白名单里。 */
  const ctxImpl = new Set();
  const m2 = src.match(/\/\* @ctx-table:start \*\/([\s\S]*?)\/\* @ctx-table:end \*\//);
  if (m2) {
    const re2 = /^\s*'([^']+)'\(/gm;
    let h2;
    while ((h2 = re2.exec(m2[1])) !== null) ctxImpl.add(h2[1]);
  }
  const ctxMissing = spec.CTX_COMMANDS.filter(
    (c) => c.indexOf('tray:') !== 0 && !ctxImpl.has(c));
  ok('右键菜单的每个 cmd 都有渲染层实现（缺 ' + ctxMissing.length + ' 个）',
    ctxMissing.length === 0, '缺：' + ctxMissing.join(', '));
}

/* ============================================================
   汇总
   ============================================================ */
console.log('');
console.log('桌面集成纯函数：' + pass + ' 项通过，' + fail + ' 项失败');
if (fail) {
  console.log('');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
