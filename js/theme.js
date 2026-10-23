/* ============================================================
   Atrium · theme.js
   ------------------------------------------------------------
   主题有两个自由度，本模块只管第二个：

     ① 明暗模式（light / dark / auto）
        由 body[data-theme] 承载，两套令牌写在 CSS 里（main.css / lightbox.css）。
        那是"配色方案"，不是本模块的事。
     ② 强调色（'auto' 系统蓝 | 任意 #rrggbb）
        本模块负责把**一支色**推导成一整套可用令牌。

   ── 为什么必须推导，而不能直接用用户选的那个色 ──
   强调色在界面上有四种用途，对比度要求互不相同（v1.19.0 吃过这个亏：
   同一个 #0071e3，当底色用是 4.70 达标，当文字色压在浅灰上只有 4.17 不达标）：

       --accent        图标 / 焦点环 / 边框 / 半透明底      非文本  3:1
       --accent-solid  实色填充（按钮、选中行、勾选点）      其上的字 4.5:1
       --on-accent     压在上面那层字（白或近黑）           与 solid 成对
       --accent-step   实底上再叠一档（数量徽标 / 悬停圆底）  叠加后其上的字 4.5:1
       --accent-text   浅底上的强调文字                     正文    4.5:1

   用户选一支纯黄 #ffcc00：
     · 当实底 → 白字只有 1.4:1（完全读不出）。正确做法是**把字换深**，
       而不是为了迁就白字把黄涂成深橄榄 —— 后者用户会觉得"我选的色没生效"。
     · 当文字 → 黄字压浅灰 1.3:1。这一种只能**压明度**，压到深橄榄，
       因为文字的颜色就是它自己，没有"换一种字"的余地。

   所以两条路：`--on-accent` 解决"字压在色上"，`fit()` 解决"色压在底上"。

   ── 一条用得上的数学事实 ──
   对**任意**颜色，它与纯白或纯黑之中至少一个的对比度 ≥ 4.58
   （两条曲线在相对亮度 L≈0.179 处相交，交点值 4.58）。
   所以"换字色"永远救得回实底，不必为了让白字达标而牺牲用户选的颜色。
   本项目把深字取成 #0a0a0c 而不是纯黑（更柔和），交点值降到 4.44 —— 差一点点，
   于是 `pickOn()` 在极端情况下把实底明度推 1~2% 补上，仍然保证 ≥4.5。

   ── 令牌什么时候写进去 ──
   `apply()` 把结果写在 document.body 的行内样式上。
   必须写 body 而不是 :root —— 深色令牌是挂在 body[data-theme="dark"] 上的，
   body 自己的声明会盖掉从 html 继承来的值；行内样式的优先级又高于样式表规则，
   所以"写在 body 上"是唯一能同时压过两套主题声明的做法。
   选 'auto' 时**移除**全部行内属性，回落到样式表里那套手工调过的默认值。
   ============================================================ */
(function (global) {
  'use strict';

  /* 预设色。**刻意不含红 / 绿 / 琥珀** —— 那三支是语义色
     （--danger 删除 / --success 进程结果 / --favorite 收藏），
     让强调色去抢它们的含义，用户就会读错状态（v1.18.0 刚把开关从绿改回蓝）。
     自定义取色器里允许任何颜色，那是用户明确的选择；预设不给。 */
  const PRESETS = [
    { id: 'auto', name: '系统蓝', hex: '#0071e3' },
    { id: 'indigo', name: '靛蓝', hex: '#5e5ce6' },
    { id: 'violet', name: '紫罗兰', hex: '#af52de' },
    { id: 'orange', name: '暖橙', hex: '#ff9500' },
    { id: 'teal', name: '湖青', hex: '#30b0c7' },
    { id: 'slate', name: '石墨', hex: '#8e8e93' },
  ];

  /* 判据用的底色 —— 都是**最不利**的那一个，不是平均情况：
       浅色：--paper-2 #ececee 是最深的常用浅底（回收站面板 / 次级填充），
             深字压它对比度最低；比 #f5f5f7 / #ffffff 都更严。
       深色：fill-2 叠在 surface 上约 #3a3a3c，是最浅的常用深底，
             浅字压它对比度最低。
     取最不利值意味着：在这些底上达标，在更浅/更深的底上一定更达标。 */
  const WORST_LIGHT = '#ececee';
  const WORST_DARK = '#3a3a3c';
  const WHITE = [255, 255, 255];
  const INK_ON_SOLID = [10, 10, 12];   /* 压在实底上的深字：#0a0a0c */

  const TARGET_TEXT = 4.5;   /* WCAG AA 正文 */
  const TARGET_ICON = 3.0;   /* WCAG 1.4.11 非文本 */

  /* ---------- 颜色基础 ---------- */

  /** '#rrggbb' / '#rgb' → [r,g,b]；认不出返回 null（**不猜**） */
  function hexToRgb(hex) {
    if (typeof hex !== 'string') return null;
    let s = hex.trim().toLowerCase();
    if (s.charAt(0) === '#') s = s.slice(1);
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (!/^[0-9a-f]{6}$/.test(s)) return null;
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  }

  function rgbToHex(rgb) {
    const h = (v) => {
      const n = Math.max(0, Math.min(255, Math.round(v)));
      return (n < 16 ? '0' : '') + n.toString(16);
    };
    return '#' + h(rgb[0]) + h(rgb[1]) + h(rgb[2]);
  }

  /** 单通道线性化（WCAG 2.1 相对亮度定义里的那一段） */
  function lin(c) {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }

  function luminance(rgb) {
    return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  }

  /** WCAG 对比度。入参可以是数组或 '#rrggbb' */
  function contrast(a, b) {
    const A = typeof a === 'string' ? hexToRgb(a) : a;
    const B = typeof b === 'string' ? hexToRgb(b) : b;
    if (!A || !B) return 0;
    const la = luminance(A), lb = luminance(B);
    const hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }

  function rgbToHsl(rgb) {
    const r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return [h, s, l];
  }

  function hslToRgb(hsl) {
    const h = ((hsl[0] % 360) + 360) % 360 / 360, s = hsl[1], l = hsl[2];
    if (s === 0) {
      const v = Math.round(l * 255);
      return [v, v, v];
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const f = (t) => {
      let x = t;
      if (x < 0) x += 1;
      if (x > 1) x -= 1;
      if (x < 1 / 6) return p + (q - p) * 6 * x;
      if (x < 1 / 2) return q;
      if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
      return p;
    };
    return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
  }

  /** 只动明度（保色相与饱和度），delta 为 -1..1 的增量 */
  function shiftLightness(rgb, delta) {
    const hsl = rgbToHsl(rgb);
    hsl[2] = Math.max(0, Math.min(1, hsl[2] + delta));
    return hslToRgb(hsl);
  }

  /**
   * 把颜色往某个方向推到"与 bg 的对比度 ≥ target"为止。
   * dir = -1 压暗（浅色主题：字压在浅底上），+1 提亮（深色主题）。
   * 步长 0.5% 明度：够细（肉眼分辨不出），最多 200 步覆盖全范围。
   */
  function fit(rgb, bg, target, dir) {
    const bgRgb = typeof bg === 'string' ? hexToRgb(bg) : bg;
    let cur = rgb;
    for (let i = 0; i < 200; i++) {
      if (contrast(cur, bgRgb) >= target) return cur;
      const next = shiftLightness(cur, dir * 0.005);
      // 已经顶到纯黑/纯白还达不到 → 再推也没用，原样返回让调用方去断言
      if (next[0] === cur[0] && next[1] === cur[1] && next[2] === cur[2]) return cur;
      cur = next;
    }
    return cur;
  }

  /**
   * 实底 + 压在上面的字：先挑字色（白 / 近黑取对比度高的那个），
   * 挑完仍不足 4.5（近黑不是纯黑导致的窄带）就把实底明度推一点点。
   * 返回 { solid, on, ratio }。
   */
  function pickOn(solid) {
    const w = contrast(solid, WHITE);
    const k = contrast(solid, INK_ON_SOLID);
    const useWhite = w >= k;
    let out = solid;
    let ratio = useWhite ? w : k;
    if (ratio < TARGET_TEXT) {
      // 白字 → 把底压暗；深字 → 把底提亮
      out = fit(solid, useWhite ? WHITE : INK_ON_SOLID, TARGET_TEXT, useWhite ? -1 : 1);
      ratio = contrast(out, useWhite ? WHITE : INK_ON_SOLID);
    }
    return { solid: out, on: useWhite ? WHITE : INK_ON_SOLID, ratio: ratio };
  }

  function rgba(rgb, a) {
    return 'rgba(' + Math.round(rgb[0]) + ', ' + Math.round(rgb[1]) + ', ' + Math.round(rgb[2]) + ', ' + a + ')';
  }

  /** 半透明色压在不透明底上的实际观感色（叠加公式，alpha 在 sRGB 空间混合） */
  function blendOver(top, bottom, a) {
    return [
      bottom[0] + (top[0] - bottom[0]) * a,
      bottom[1] + (top[1] - bottom[1]) * a,
      bottom[2] + (top[2] - bottom[2]) * a,
    ];
  }

  const STEP_ALPHA = 0.24;

  /**
   * 实底上再叠一档（来源列表的"数量"徽标、选中行里的悬停圆底）。
   *
   * 方向**背离** --on-accent：字是白的就叠黑、字是深的就叠白。
   * 这样叠加只会把底色推得离字更远 —— 对比度单调上升，永远不会变差。
   *
   * v1.20.0 之前这里固定叠 24% 黑：蓝色实底 + 白字当然没问题，但一旦实底是
   * 纯黄 #ffcc00（字被换成深色 #0a0a0c），叠黑反而把深字压回 2.63:1。
   * 所以"叠哪一档"必须跟着字色走，不能写死。
   *
   * 例外：实底已经贴在那端（纯黑实底叠黑、纯白实底叠白），叠了等于没叠。
   * 这时翻到另一侧 —— 它会让对比度下降，但起点远高于 4.5，翻过去仍达标，
   * 而"看不见的一档"是实打实的美观损失。test/theme.test.js 逐色验过两条都成立。
   */
  function stepOf(solid, on) {
    const onWhite = luminance(on) > 0.5;
    const away = onWhite ? [0, 0, 0] : [255, 255, 255];
    const toward = onWhite ? [255, 255, 255] : [0, 0, 0];
    // 叠一档后的观感色与实底差多少（相对亮度）。差太小就是"叠了看不见"
    const visible = Math.abs(luminance(blendOver(away, solid, STEP_ALPHA)) - luminance(solid)) >= 0.02;
    if (visible) return rgba(away, STEP_ALPHA);
    // 翻到另一侧前先确认对比度还够 —— 不够就宁可要那档看不见的
    return contrast(blendOver(toward, solid, STEP_ALPHA), on) >= TARGET_TEXT
      ? rgba(toward, STEP_ALPHA)
      : rgba(away, STEP_ALPHA);
  }

  /**
   * 核心：一支色 + 明暗模式 → 一整套令牌（字符串，可直接写进 style）。
   * 纯函数，不碰 DOM —— test/theme.test.js 直接在 Node 里断言它。
   */
  function derive(hex, mode) {
    const base = hexToRgb(hex);
    if (!base) return null;
    const dark = mode === 'dark';
    const worst = dark ? WORST_DARK : WORST_LIGHT;
    // 浅色主题里"更暗才更清楚"，深色主题里反过来
    const dir = dark ? 1 : -1;

    const pair = pickOn(base);
    const accent = fit(base, worst, TARGET_ICON, dir);
    const text = fit(base, worst, TARGET_TEXT, dir);
    // hover 是"按下/悬停"反馈：浅色下再深一档，深色下再亮一档
    const hover = shiftLightness(accent, dark ? 0.06 : -0.06);

    return {
      '--accent': rgbToHex(accent),
      '--accent-hover': rgbToHex(hover),
      '--accent-soft': rgba(accent, dark ? 0.20 : 0.12),
      '--accent-solid': rgbToHex(pair.solid),
      '--on-accent': rgbToHex(pair.on),
      '--accent-step': stepOf(pair.solid, pair.on),
      '--accent-text': rgbToHex(text),
      '--sel': rgbToHex(accent),
      '--sel-soft': rgba(accent, dark ? 0.22 : 0.14),
      '--ring': rgba(accent, dark ? 0.55 : 0.42),
    };
  }

  /* 写进 body 的全部属性名 —— 清空时要逐个 remove，漏一个就会残留上一支色 */
  const PROPS = [
    '--accent', '--accent-hover', '--accent-soft', '--accent-solid',
    '--on-accent', '--accent-step', '--accent-text', '--sel', '--sel-soft', '--ring',
  ];

  /** 当前解析出的明暗模式（auto 已在 App.applySetting 里落成 light/dark） */
  function modeOf() {
    const b = global.document && global.document.body;
    return b && b.dataset.theme === 'dark' ? 'dark' : 'light';
  }

  /** 当前强调色设置（'auto' | '#rrggbb'） */
  function current() {
    const s = global.State && global.State.settings;
    const v = s && s.accent;
    return (typeof v === 'string' && v !== 'auto' && hexToRgb(v)) ? v : 'auto';
  }

  /**
   * 把设置应用到页面。
   * 选 'auto' → 移除全部行内属性，回落到样式表默认（那套值是手工调过的，
   * 不要用推导结果去覆盖它 —— 覆盖了就等于"默认值也走了算法"，以后调默认色
   * 要去改算法而不是改 CSS）。
   */
  function apply() {
    const body = global.document && global.document.body;
    if (!body) return;
    const hex = current();
    if (hex === 'auto') {
      for (const p of PROPS) body.style.removeProperty(p);
      return;
    }
    const vars = derive(hex, modeOf());
    if (!vars) return;
    for (const p of PROPS) body.style.setProperty(p, vars[p]);
  }

  /** 给设置面板用：当前选中的预设 id（自定义色返回 'custom'） */
  function presetOf(hex) {
    for (const p of PRESETS) {
      if (p.id === 'auto') { if (hex === 'auto') return 'auto'; continue; }
      if (p.hex.toLowerCase() === String(hex).toLowerCase()) return p.id;
    }
    return hex === 'auto' ? 'auto' : 'custom';
  }

  const Theme = {
    PRESETS: PRESETS,
    TARGET_TEXT: TARGET_TEXT,
    TARGET_ICON: TARGET_ICON,
    WORST_LIGHT: WORST_LIGHT,
    WORST_DARK: WORST_DARK,
    hexToRgb: hexToRgb,
    rgbToHex: rgbToHex,
    luminance: luminance,
    contrast: contrast,
    rgbToHsl: rgbToHsl,
    hslToRgb: hslToRgb,
    shiftLightness: shiftLightness,
    fit: fit,
    pickOn: pickOn,
    stepOf: stepOf,
    blendOver: blendOver,
    STEP_ALPHA: STEP_ALPHA,
    derive: derive,
    PROPS: PROPS,
    modeOf: modeOf,
    current: current,
    presetOf: presetOf,
    apply: apply,
  };

  global.Theme = Theme;
  if (typeof module !== 'undefined' && module.exports) module.exports = Theme;
})(typeof window !== 'undefined' ? window : globalThis);
