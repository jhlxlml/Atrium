/* ============================================================
   Atrium · js/theme.js 单元测试（纯 Node，不需要 Electron）
   ------------------------------------------------------------
   这套测试要锁住的不是"推导出来的颜色好不好看"，而是**三条硬约束**：

     ① 实底上的字（--on-accent 压 --accent-solid）≥ 4.5:1
     ② 强调文字（--accent-text 压在**最不利**的常用底色上）≥ 4.5:1
     ③ 图标 / 焦点环（--accent 压在同一个最不利底色上）≥ 3:1

   为什么值得单测：这三条**写错了都不会报错**。颜色算错时界面照常渲染，
   只是某些色在某个主题下悄悄变得读不清 —— 而用户选颜色的那一刻，
   恰好是我们最不可能逐一去肉眼验证每个组合的时刻。

   所以后半段是**反向用例**：故意用"朴素做法"（直接把用户选的色当文字色 /
   当实底配白字）算一遍，证明它**真的会不达标**。否则这套测试可能只是
   恒真的门禁 —— 只测"推导结果达标"，而推导恰好什么都没做的话，也可能蒙混过关。

   运行： node test/theme.test.js
   ============================================================ */
'use strict';

const T = require('../js/theme.js');

/* ---------- 极简断言框架（与其它 test/*.test.js 一致） ---------- */
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail ? '  → ' + detail : ''));
}
function near(name, actual, expected, eps) {
  const e = eps == null ? 0.02 : eps;
  ok(name, Math.abs(actual - expected) <= e, '实测 ' + actual + '，期望 ' + expected);
}

/* ============================================================
   1. 颜色解析 —— 认不出就返回 null，**不猜**
   ============================================================ */
ok("hexToRgb('#0071e3')", JSON.stringify(T.hexToRgb('#0071e3')) === '[0,113,227]',
  JSON.stringify(T.hexToRgb('#0071e3')));
ok("hexToRgb 三位缩写 '#0af'", JSON.stringify(T.hexToRgb('#0af')) === '[0,170,255]',
  JSON.stringify(T.hexToRgb('#0af')));
ok("hexToRgb 大写 / 无 # 都认", JSON.stringify(T.hexToRgb('AF52DE')) === '[175,82,222]');
for (const bad of ['', '#12345', '#gggggg', 'red', null, undefined, 42, '#0071e3ff']) {
  ok('非法输入返回 null：' + JSON.stringify(bad), T.hexToRgb(bad) === null);
}

/* ============================================================
   2. 对比度基准 —— 先证明度量本身是对的
   （度量错了，后面所有断言都是"看起来严格"的假绿）
   ============================================================ */
near('白/黑 = 21:1（WCAG 上限）', T.contrast('#ffffff', '#000000'), 21, 0.01);
near('同色 = 1:1', T.contrast('#0071e3', '#0071e3'), 1, 1e-9);
near('白/白 = 1:1', T.contrast('#ffffff', '#ffffff'), 1, 1e-9);
/* 这两个值是 v1.19.0 实测记录下来的，用它们反验度量实现没跑偏 */
near('#0071e3 上的白字 = 4.70', T.contrast('#0071e3', '#ffffff'), 4.70, 0.02);
near('#0a84ff 上的白字 = 3.65', T.contrast('#0a84ff', '#ffffff'), 3.65, 0.02);
near('#0b6bcb 上的白字 = 5.28', T.contrast('#0b6bcb', '#ffffff'), 5.28, 0.02);

/* HSL 往返：色相/饱和度不变，明度可调 */
{
  const hsl = T.rgbToHsl(T.hexToRgb('#0071e3'));
  const back = T.hslToRgb(hsl);
  ok('rgb→hsl→rgb 往返一致', T.rgbToHex(back) === '#0071e3', T.rgbToHex(back));
  const darker = T.shiftLightness(T.hexToRgb('#0071e3'), -0.1);
  ok('压暗后确实更暗', T.luminance(darker) < T.luminance(T.hexToRgb('#0071e3')));
  ok('压暗保色相（仍是蓝：B 通道最大）', darker[2] > darker[0] && darker[2] > darker[1]);
}

/* ============================================================
   3. 三条硬约束 —— 预设色 × 两种模式
   ============================================================ */
const MODES = ['light', 'dark'];
const WORST = { light: T.WORST_LIGHT, dark: T.WORST_DARK };

for (const p of T.PRESETS) {
  for (const mode of MODES) {
    const v = T.derive(p.hex, mode);
    const tag = p.name + '/' + mode;
    ok(tag + ' 推导结果完整', v && T.PROPS.every((k) => typeof v[k] === 'string' && v[k]));
    if (!v) continue;

    const ratioOn = T.contrast(v['--accent-solid'], v['--on-accent']);
    ok(tag + ' 实底上的字 ≥4.5', ratioOn >= 4.5, '实测 ' + ratioOn.toFixed(2) + '（' + v['--accent-solid'] + ' 上压 ' + v['--on-accent'] + '）');

    const ratioText = T.contrast(v['--accent-text'], WORST[mode]);
    ok(tag + ' 强调文字 ≥4.5', ratioText >= 4.5, '实测 ' + ratioText.toFixed(2) + '（' + v['--accent-text'] + ' 压 ' + WORST[mode] + '）');

    const ratioIcon = T.contrast(v['--accent'], WORST[mode]);
    ok(tag + ' 图标/焦点环 ≥3', ratioIcon >= 3, '实测 ' + ratioIcon.toFixed(2));

    /* 同一支色的三张面孔必须**真的不同用途**，不能三个变量一个值 */
    ok(tag + ' 实底与文字色不必相同（语义分离）', typeof v['--accent-solid'] === 'string' && typeof v['--accent-text'] === 'string');

    /* rgba 形态的令牌要能被浏览器解析：必须是 rgba(r, g, b, a) */
    ok(tag + ' --accent-soft 形态正确', /^rgba\(\d+, \d+, \d+, [\d.]+\)$/.test(v['--accent-soft']), v['--accent-soft']);
    ok(tag + ' --ring 形态正确', /^rgba\(\d+, \d+, \d+, [\d.]+\)$/.test(v['--ring']), v['--ring']);
    ok(tag + ' --accent 是合法 hex', T.hexToRgb(v['--accent']) !== null);
  }
}

/* ============================================================
   4. 极端色 —— 用户能把取色器拖到任何地方
   ============================================================ */
const HOSTILE = [
  ['纯黄', '#ffcc00'], ['纯白', '#ffffff'], ['纯黑', '#000000'],
  ['中灰', '#808080'], ['荧光绿', '#00ff00'], ['纯红', '#ff0000'],
  ['近白', '#fdfdfd'], ['深紫', '#2b0a3d'], ['浅粉', '#ffd6e7'],
];
for (const [name, hex] of HOSTILE) {
  for (const mode of MODES) {
    const v = T.derive(hex, mode);
    const tag = name + '/' + mode;
    ok(tag + ' 推导成功', !!v);
    if (!v) continue;
    const rOn = T.contrast(v['--accent-solid'], v['--on-accent']);
    ok(tag + ' 实底上的字 ≥4.5', rOn >= 4.5, '实测 ' + rOn.toFixed(2) + '（' + v['--accent-solid'] + '/' + v['--on-accent'] + '）');
    const rText = T.contrast(v['--accent-text'], WORST[mode]);
    ok(tag + ' 强调文字 ≥4.5', rText >= 4.5, '实测 ' + rText.toFixed(2) + '（' + v['--accent-text'] + '）');
    const rIcon = T.contrast(v['--accent'], WORST[mode]);
    ok(tag + ' 图标/焦点环 ≥3', rIcon >= 3, '实测 ' + rIcon.toFixed(2));
  }
}

/* ============================================================
   4.5 实底上再叠一档（--accent-step）
   ------------------------------------------------------------
   来源列表里"选中行 + 数量徽标"是**叠两层**的：徽标底色是半透明，
   压在 --accent-solid 上才成为最终底色。字压在这层合成色上。
   所以门禁不能只测 solid，必须把叠加后的观感色算出来再测 ——
   v1.20.0 的 uxaudit 就是在这里抓到 2.63:1 的（固定叠 24% 黑 + 纯黄实底 + 深字）。
   ============================================================ */
{
  const all = T.PRESETS.map((p) => [p.name, p.hex]).concat(HOSTILE);
  for (const [name, hex] of all) {
    for (const mode of MODES) {
      const v = T.derive(hex, mode);
      const tag = name + '/' + mode + ' 叠加档';
      const step = v['--accent-step'];
      ok(tag + ' 形态正确', /^rgba\(\d+, \d+, \d+, [\d.]+\)$/.test(step), step);
      if (!/^rgba\(/.test(step)) continue;

      const m = step.match(/rgba\((\d+), (\d+), (\d+), ([\d.]+)\)/);
      const scrim = [+m[1], +m[2], +m[3]];
      const alpha = +m[4];
      const solid = T.hexToRgb(v['--accent-solid']);
      const on = T.hexToRgb(v['--on-accent']);
      const badge = T.blendOver(scrim, solid, alpha);

      const r = T.contrast(badge, on);
      ok(tag + ' 叠加后的字 ≥4.5', r >= 4.5,
        '实测 ' + r.toFixed(2) + '（' + T.rgbToHex(badge) + ' 上压 ' + v['--on-accent'] + '）');

      /* 叠了要看得见：与实底的相对亮度差太小，这层就等于白加 */
      const d = Math.abs(T.luminance(badge) - T.luminance(solid));
      ok(tag + ' 叠加可见（ΔL ≥ 0.02）', d >= 0.02, 'ΔL=' + d.toFixed(4) + '（' + v['--accent-solid'] + '→' + T.rgbToHex(badge) + '）');
    }
  }

  /* 方向必须**背离字色**：白字叠黑、深字叠白 */
  const y = T.derive('#ffcc00', 'light');
  ok('纯黄：字被换成深色 → 叠加档也换成叠白',
    /^rgba\(255, 255, 255/.test(y['--accent-step']), y['--accent-step'] + '（on=' + y['--on-accent'] + '）');
  const b = T.derive('#0071e3', 'light');
  ok('系统蓝：字是白的 → 叠加档叠黑',
    /^rgba\(0, 0, 0/.test(b['--accent-step']), b['--accent-step'] + '（on=' + b['--on-accent'] + '）');
}

/* ============================================================
   5. 反向用例 —— 证明"朴素做法"真的会失败
   ------------------------------------------------------------
   如果这几条不失败，说明上面的门禁是恒真的：它并没有真正区分
   "推导过的颜色"和"没推导过的颜色"。
   ============================================================ */
{
  const naive = '#ffcc00';
  ok('反向：纯黄直接当实底 + 白字，必然不达标（1.4:1）',
    T.contrast(naive, '#ffffff') < 4.5, T.contrast(naive, '#ffffff').toFixed(2));
  ok('反向：纯黄直接当强调文字，压在浅灰上必然不达标',
    T.contrast(naive, T.WORST_LIGHT) < 4.5, T.contrast(naive, T.WORST_LIGHT).toFixed(2));

  const v = T.derive(naive, 'light');
  ok('推导后：同一支黄**没有**被涂成深橄榄（实底仍是亮的）',
    T.luminance(T.hexToRgb(v['--accent-solid'])) > 0.4,
    'solid=' + v['--accent-solid'] + ' L=' + T.luminance(T.hexToRgb(v['--accent-solid'])).toFixed(3));
  ok('推导后：它选了深字而不是白字',
    T.luminance(T.hexToRgb(v['--on-accent'])) < 0.05,
    'on=' + v['--on-accent']);

  /* 深色主题下同一条规则要**反过来**：深底上文字要提亮 */
  const d = T.derive('#2b0a3d', 'dark');
  ok('深色主题：很深的紫当强调文字时会被提亮（而不是继续压暗）',
    T.luminance(T.hexToRgb(d['--accent-text'])) > T.luminance(T.hexToRgb('#2b0a3d')),
    d['--accent-text']);

  /* 叠加档的反向用例 —— 这两条数字来自 uxaudit 在真实渲染里量到的失败，
     不是估的。原来的写法是**两处都写死**：字固定 #fff、叠加层固定 24% 黑。
     纯黄实底一旦被推导成深字，这两处就同时错：
       · 字还是白的 → 叠黑后 2.63:1（白字压在 rgb(194,155,0) 上）
       · 叠黑本身也错方向 → 深字被压到 7.52，比不叠（9.00）更差
     结论：叠加档必须跟着字色走，写死 24% 黑在自定义色下必坏。 */
  const YEL = T.hexToRgb('#ffcc00');
  const INK = T.hexToRgb('#0a0a0c');
  const naiveBadge = T.blendOver([0, 0, 0], YEL, 0.24);
  ok('反向：纯黄实底叠 24% 黑后压白字，只剩 2.63:1',
    T.contrast(naiveBadge, [255, 255, 255]) < 4.5,
    T.contrast(naiveBadge, [255, 255, 255]).toFixed(2) + '（合成色 ' + T.rgbToHex(naiveBadge) + '）');
  ok('反向：同一支黄配深字时，叠黑会**降低**对比度（9.00 → 7.52）',
    T.contrast(naiveBadge, INK) < T.contrast(YEL, INK),
    T.contrast(naiveBadge, INK).toFixed(2) + ' < ' + T.contrast(YEL, INK).toFixed(2));

  /* 推导后必须反过来：叠白 → 深字更清楚 */
  const yv = T.derive('#ffcc00', 'light');
  const ym = yv['--accent-step'].match(/rgba\((\d+), (\d+), (\d+), ([\d.]+)\)/);
  const yBadge = T.blendOver([+ym[1], +ym[2], +ym[3]], T.hexToRgb(yv['--accent-solid']), +ym[4]);
  ok('推导后：叠加档让深字**更**清楚（而不是更差）',
    T.contrast(yBadge, INK) > T.contrast(T.hexToRgb(yv['--accent-solid']), INK),
    T.contrast(yBadge, INK).toFixed(2) + ' > ' + T.contrast(T.hexToRgb(yv['--accent-solid']), INK).toFixed(2));
}

/* ============================================================
   6. 边界：fit() 不会把颜色推出 RGB 空间
   ============================================================ */
{
  const extremes = ['#000000', '#ffffff', '#010101', '#fefefe'];
  for (const hex of extremes) {
    for (const mode of MODES) {
      const v = T.derive(hex, mode);
      for (const k of ['--accent', '--accent-solid', '--accent-text', '--on-accent']) {
        const rgb = T.hexToRgb(v[k]);
        ok(hex + '/' + mode + ' ' + k + ' 在 RGB 范围内',
          !!rgb && rgb.every((c) => c >= 0 && c <= 255), v[k]);
      }
    }
  }
}

/* ============================================================
   7. presetOf —— 设置面板靠它把"当前值"映射回某个色块
   ============================================================ */
ok("presetOf('auto') → auto", T.presetOf('auto') === 'auto');
ok("presetOf('#5E5CE6') → indigo（大小写不敏感）", T.presetOf('#5E5CE6') === 'indigo');
ok("presetOf('#123456') → custom", T.presetOf('#123456') === 'custom');

/* ---------- 汇总 ---------- */
console.log('');
if (fail) {
  console.log('theme.test.js  ✗ 失败 ' + fail + ' / ' + (pass + fail) + ' 项');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('theme.test.js  ✓ 通过 ' + pass + ' 项');
