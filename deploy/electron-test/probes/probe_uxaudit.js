/* UX 审查探针：对比度 / 焦点环裁切 / 点击目标 / 静默截断
   ------------------------------------------------------------
   为什么不用现成的 probe_audit2：它的对比度是"拿文字色去比一个写死的背景"，
   于是报出 chipName=1.18 这种数 —— 白字当然比不过纸色，可 chip 自己的底色
   根本不是纸色。真实感知对比度必须**沿祖先链合成背景**：从元素往上收集每一层
   backgroundColor，逐层 alpha 合成到第一个不透明层为止。

   四项检查：
   ① contrast —— 每个可见文本节点的 fg vs 合成后的 bg，按字号分档判 4.5 / 3.0
   ② clip     —— 焦点环（outline + offset）是否被某个 overflow 祖先裁掉
                 这类缺陷在截图里几乎看不出来：蓝边只剩左右两条，读起来像
                 "这个按钮只有两侧有边框"，而不是"焦点环被切了"
   ③ target   —— 可交互元素的命中框，WCAG 2.2 AA 要求 ≥24×24
   ④ trunc    —— 文字被截断却没有任何补偿（无 title / 无 aria-label / 无展开）

   ⚠️ 注入页面的那段代码必须用 String.raw。普通模板字符串会把 `\s` 吃成 `s`、
   把 `\(` 吃成 `(` —— 于是 `/rgba?\(([^)]+)\)/` 变成 `/rgba?(([^)]+))/`，
   颜色解析全错，而探针照样输出一堆"看起来正常"的数字。这个坑已经踩过一次。

   用法: node deploy/electron-test/run_probe.js probe_uxaudit.js
   环境: SCENE=gallery|select|lightbox|settings|trash|empty|narrow|all */
const { app, BrowserWindow, protocol, ipcMain } = require('electron');

require('./_desktop_stub').stubDesktop();
require('./_desktop_stub').stubWindowChannels();

const path = require('path');
const fs = require('fs');
const APPDIR = path.resolve(__dirname, '..', '..', '..');
const PICDIR = path.join(__dirname, '..', 'fixtures', '照片夹');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
protocol.registerSchemesAsPrivileged([{ scheme: 'vf', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }]);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml' };

for (const ch of ['vf:trashLog', 'vf:autoDir', 'vf:pickDirs', 'vf:restoreFile', 'vf:restoreFiles', 'vf:trashForget', 'vf:trashClear', 'vf:pickFolder']) {
  ipcMain.handle(ch, () => (ch === 'vf:trashLog' || ch === 'vf:pickDirs' ? [] : null));
}
ipcMain.handle('vf:loadDir', () => ({ ok: false, files: [] }));
ipcMain.handle('vf:readHead', () => null);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function collect(dir, base) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const abs = path.join(dir, f);
    const st = fs.statSync(abs);
    if (st.isDirectory()) out.push(...collect(abs, base));
    else if (/\.(png|jpe?g|gif|webp)$/i.test(f)) out.push({ abs, rel: path.relative(base, abs).replace(/\\/g, '/'), size: st.size, mtime: st.mtimeMs });
  }
  return out;
}

/* ============ 注入页面的测量代码（必须 String.raw） ============ */
const MEASURE = (opts) => String.raw`(() => {
  const O = ${JSON.stringify(opts || {})};
  const MAX = O.max || 40;

  /* 先把所有进行中的 transition / animation 推到终态再量。
     隐藏窗口（show:false）里 Chromium 会节流动画时钟，--dur: .2s 的颜色过渡
     实测要走 1s 以上；只靠 sleep 等，读到的是插值中间值。曾经因此把
     "深色下侧栏文字 #a1a1a6" 误报成 "2.3:1 不达标" —— 而截图里它明明是浅灰的。
     getAnimations().finish() 是同步跳到终态，比任何 sleep 都可靠。

     **必须 flush→finish→flush→finish 走两轮**（v1.20.0 补）：
     如果改动之后还没发生过一次样式重算，transition 此刻**尚不存在**，
     第一轮 finish() 抓不到它；而紧接着的 getComputedStyle 正好触发重算、
     就地新建一条从"旧值"起步的过渡 —— 读到的仍是旧颜色。
     这一条让 accent 场景间歇性报 "全部图片 1.51:1"（白字压纯黄），
     单跑必过、整套跑偶尔红，最难查。flush 一下先把过渡建出来，第二轮才收得掉。 */
  const flush = () => { void document.body.offsetHeight; };
  for (let i = 0; i < 2; i++) {
    flush();
    try { document.getAnimations().forEach((a) => { try { a.finish(); } catch (e) { } }); } catch (e) { }
  }
  flush();

  /* ---------- 颜色工具 ---------- */
  const parse = (s) => {
    if (!s) return null;
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.%]+))?\s*\)/.exec(s);
    if (!m) return null;
    let a = m[4] === undefined ? 1 : (String(m[4]).endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    if (isNaN(a)) a = 1;
    return [+m[1], +m[2], +m[3], a];
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a, b) => {
    const la = lum(a), lb = lum(b);
    return +((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)).toFixed(2);
  };
  const over = (top, bot) => {
    const a = top[3];
    return [top[0] * a + bot[0] * (1 - a), top[1] * a + bot[1] * (1 - a), top[2] * a + bot[2] * (1 - a), 1];
  };

  /* ---------- 背景合成：沿祖先链逐层叠 ---------- */
  /* 从元素自身开始向上收集 backgroundColor，遇到 alpha=1 就停。
     中途遇到 background-image（渐变/图片）时 gradient=true —— 此时合成结果
     不可信，对比度整条跳过（宁可漏报也不报假数）。 */
  const bgOf = (el) => {
    const stack = [];
    let gradient = false;
    let n = el;
    while (n && n.nodeType === 1) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') gradient = true;
      const c = parse(cs.backgroundColor);
      if (c && c[3] > 0.001) {
        stack.push(c);
        if (c[3] >= 0.999) break;
      }
      n = n.parentElement;
    }
    let base = [255, 255, 255, 1];
    const last = stack[stack.length - 1];
    if (!last || last[3] < 0.999) {
      const hb = parse(getComputedStyle(document.documentElement).backgroundColor);
      if (hb && hb[3] > 0.5) base = hb;
      else {
        const bb = parse(getComputedStyle(document.body).backgroundColor);
        if (bb && bb[3] > 0.5) base = bb;
      }
    }
    let out = base;
    for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i], out);
    return { rgb: out, layers: stack.length, gradient };
  };

  /* ---------- 选择器路径（报错时能直接定位） ---------- */
  const sel = (el) => {
    if (!el || el.nodeType !== 1) return '?';
    const parts = [];
    let n = el;
    for (let i = 0; i < 4 && n && n.nodeType === 1; i++) {
      let s = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(s + '#' + n.id); break; }
      const cls = (n.className && typeof n.className === 'string')
        ? n.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
      if (cls.length) s += '.' + cls.join('.');
      parts.unshift(s);
      n = n.parentElement;
    }
    return parts.join(' > ');
  };

  const visible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
    if (el.closest('[hidden]')) return false;
    /* 祖先链上的 opacity:0 / visibility:hidden 一样算不可见。
       灯箱关闭后整层 opacity:0，但里面元素的 getBoundingClientRect 仍有尺寸，
       只查元素自身会把它当成"屏幕上看得见的文字"，于是 #lbErrName 在
       每一个场景里都被报一次 3.66:1 —— 而用户根本没打开灯箱。 */
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const acs = getComputedStyle(a);
      if (acs.visibility === 'hidden' || +acs.opacity === 0) return false;
    }
    if (el.classList.contains('sr-only')) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    /* 还要在视口内 —— 否则会报一堆假阳性：底部状态栏 .viewbar 默认
       transform: translateY(100%) 停在视口下方，它的按钮全在屏幕外，
       拿它们的 bbox 去跟 body 求交，结论必然是"焦点环被裁了 40px"。 */
    if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return false;
    return true;
  };

  /* ---------- ① 对比度 ---------- */
  const contrast = [];
  const seen = new Set();
  {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeValue && n.nodeValue.trim().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    let n;
    while ((n = w.nextNode())) {
      const host = n.parentElement;
      if (!host || !visible(host)) continue;
      const cs = getComputedStyle(host);
      const fg = parse(cs.color);
      if (!fg) continue;
      const bg = bgOf(host);
      if (bg.gradient) continue;
      /* 元素自身若带 opacity，文字与底一起变淡 —— 用有效 alpha 近似 */
      const eff = fg[3] * (parseFloat(cs.opacity) || 1);
      const fgSolid = eff >= 0.999 ? [fg[0], fg[1], fg[2], 1] : over([fg[0], fg[1], fg[2], eff], bg.rgb);
      const r = ratio(fgSolid, bg.rgb);
      const fs = parseFloat(cs.fontSize);
      const fw = +cs.fontWeight || 400;
      const large = fs >= 24 || (fs >= 18.66 && fw >= 700);
      const need = large ? 3.0 : 4.5;
      if (r < need) {
        const key = sel(host) + '|' + n.nodeValue.trim().slice(0, 20);
        if (seen.has(key)) continue;
        seen.add(key);
        /* WCAG 明确豁免 disabled 控件的对比度要求（"inactive user interface
           components have no contrast requirement"）。但仍要单独列出来 ——
           深色下 disabled 若淡到看不见，用户会以为那个功能不存在，
           这是可用性问题而不是合规问题，判断要分开。 */
        const dis = !!host.closest('button:disabled, input:disabled, select:disabled, [aria-disabled="true"]');
        contrast.push({
          r, need, size: +fs.toFixed(1), weight: fw, disabled: dis,
          text: n.nodeValue.trim().replace(/\s+/g, ' ').slice(0, 26),
          el: sel(host),
          fg: 'rgb(' + fgSolid.slice(0, 3).map(Math.round).join(',') + ')',
          bg: 'rgb(' + bg.rgb.slice(0, 3).map(Math.round).join(',') + ')',
          layers: bg.layers,
        });
      }
    }
  }
  contrast.sort((a, b) => a.r - b.r);

  /* ---------- ② 焦点环裁切 ---------- */
  /* 不能读未聚焦时的 computed outline（那时 outline-style 还是 none）。
     改为从 CSSOM 里把含 :focus-visible 的规则全部捞出来，去掉伪类后做结构匹配，
     拿到该元素聚焦时**会**用的 outline-width / offset，再几何判裁切。 */
  const fvRules = [];
  {
    const walk = (list) => {
      for (const r of list) {
        if (r.cssRules && r.type !== 1) { walk(r.cssRules); continue; }
        if (r.selectorText && r.selectorText.includes(':focus-visible')) fvRules.push(r);
      }
    };
    for (const ss of document.styleSheets) {
      let rules; try { rules = ss.cssRules; } catch (e) { continue; }
      walk(rules);
    }
  }
  /* 返回该元素聚焦时的 { ow, oo, none } */
  const fvStyle = (el) => {
    let ow = 2, oo = 2, none = false, hit = 0;
    for (const r of fvRules) {
      let matched = false;
      for (const one of r.selectorText.split(',')) {
        let t = one.trim().replace(/:focus-visible/g, '').replace(/:focus/g, '').trim();
        if (!t || t === '*') { matched = true; break; }
        try { if (el.matches(t)) { matched = true; break; } } catch (e) { }
      }
      if (!matched) continue;
      hit++;
      const st = r.style;
      if (st.outlineStyle === 'none' || (st.outline || '').includes('none')) none = true;
      if (st.outlineWidth) ow = parseFloat(st.outlineWidth) || ow;
      if (st.outlineOffset) oo = parseFloat(st.outlineOffset) || 0;
      if (st.outline) { const m = /([\d.]+)px/.exec(st.outline); if (m) ow = parseFloat(m[1]); }
    }
    return { ow, oo, none, hit };
  };

  /* 元素在屏幕上还剩多少（被所有 overflow 祖先求交）。低于 60% 说明它本来
     就在滚动区外 —— 这不是焦点环被裁，是元素不可见，不该混在一起报。 */
  const visibleFraction = (el) => {
    let box = el.getBoundingClientRect();
    let area = box.width * box.height;
    if (area <= 0) return 0;
    let n = el.parentElement;
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const pr = n.getBoundingClientRect();
        const l = Math.max(box.left, pr.left), t = Math.max(box.top, pr.top);
        const r = Math.min(box.right, pr.right), b = Math.min(box.bottom, pr.bottom);
        const w = Math.max(0, r - l), h = Math.max(0, b - t);
        area = w * h;
        if (area <= 0) return 0;
        box = { left: l, top: t, right: r, bottom: b };
      }
      n = n.parentElement;
    }
    const vw = Math.min(box.right, innerWidth) - Math.max(box.left, 0);
    const vh = Math.min(box.bottom, innerHeight) - Math.max(box.top, 0);
    return (Math.max(0, vw) * Math.max(0, vh)) / area;
  };

  const clip = [];
  {
    const focusables = [...document.querySelectorAll(
      'button, a[href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"]), [role="button"], [role="switch"], [role="checkbox"]'
    )].filter(visible);
    for (const el of focusables) {
      /* 浮层容器被程序化聚焦时刻意不画环，跳过 */
      if (el.matches('.set-panel, .trash-panel, .vf-modal')) continue;
      if (visibleFraction(el) < 0.6) continue;
      const s = fvStyle(el);
      if (s.none) continue;
      const expand = s.ow + s.oo;
      if (expand <= 0) continue;
      const r = el.getBoundingClientRect();
      const out = { l: r.left - expand, t: r.top - expand, r: r.right + expand, b: r.bottom + expand };
      let hit = null, scrollX = false, scrollY = false;
      let n = el.parentElement;
      while (n && n !== document.documentElement) {
        const pcs = getComputedStyle(n);
        const ox = pcs.overflowX, oy = pcs.overflowY;
        if (ox !== 'visible' || oy !== 'visible') {
          const pr = n.getBoundingClientRect();
          const box = {
            l: pr.left + (parseFloat(pcs.borderLeftWidth) || 0),
            t: pr.top + (parseFloat(pcs.borderTopWidth) || 0),
            r: pr.right - (parseFloat(pcs.borderRightWidth) || 0),
            b: pr.bottom - (parseFloat(pcs.borderBottomWidth) || 0),
          };
          const cut = {
            left: ox !== 'visible' ? Math.max(0, box.l - out.l) : 0,
            top: oy !== 'visible' ? Math.max(0, box.t - out.t) : 0,
            right: ox !== 'visible' ? Math.max(0, out.r - box.r) : 0,
            bottom: oy !== 'visible' ? Math.max(0, out.b - box.b) : 0,
          };
          /* 该方向可滚 → 聚焦时浏览器会 scrollIntoView，焦点环自然进可视区，
             不算缺陷。真正的问题是裁了又滚不到：.ctrls 是 overflow-y: hidden，
             上下被裁 1px 时无可滚动，那才是键盘用户永远看不全的蓝边。 */
          const canX = ox !== 'visible' && n.scrollWidth > n.clientWidth + 1;
          const canY = oy !== 'visible' && n.scrollHeight > n.clientHeight + 1;
          if (canX) { cut.left = 0; cut.right = 0; }
          if (canY) { cut.top = 0; cut.bottom = 0; }
          if (cut.left + cut.top + cut.right + cut.bottom > 0.5) {
            if (!hit) hit = { by: sel(n), cut: cut };
            else {
              /* 多层：外框 overflow:hidden 挡在内层 overflow:auto 前面时，
                 不能在第一层就下结论 —— 设置面板就是 #setPanel(hidden) 套
                 #setBody(auto)，开关在可视区下方，外层 hidden 也裁了它，
                 但聚焦时内层会滚进来。把每层的裁切量取最大值，同时记下
                 路径上有任何一层可滚，可滚的方向不算缺陷。 */
              for (const k of ['left', 'top', 'right', 'bottom']) hit.cut[k] = Math.max(hit.cut[k] || 0, cut[k]);
            }
            /* 只记标志，不就地清零 —— 外层 hidden 的 max() 会把内层清掉的值
               又写回来（#setBody 可滚清了一次，#setPanel 又 max 回去）。 */
            if (canX) scrollX = true;
            if (canY) scrollY = true;
          }
        }
        n = n.parentElement;
      }
      if (hit) {
        if (scrollX) { hit.cut.left = 0; hit.cut.right = 0; }
        if (scrollY) { hit.cut.top = 0; hit.cut.bottom = 0; }
      }
      if (hit && hit.cut.left + hit.cut.top + hit.cut.right + hit.cut.bottom > 0.5) {
        clip.push({
          el: sel(el), by: hit.by,
          cut: Object.fromEntries(Object.entries(hit.cut).map(([k, v]) => [k, +v.toFixed(1)])),
          expand: +expand.toFixed(1),
        });
      }
    }
  }

  /* ---------- ③ 点击目标 ---------- */
  const target = [];
  {
    const clickables = [...document.querySelectorAll(
      'button, a[href], select, [role="button"], [role="switch"], [role="checkbox"], [onclick]'
    )].filter(visible);
    for (const el of clickables) {
      if (el.tagName === 'A' && getComputedStyle(el).display === 'inline') continue;
      const r = el.getBoundingClientRect();
      const w = Math.round(r.width), h = Math.round(r.height);
      /* 被裁到几乎看不见的不算：侧栏收起时 width 过渡到 0，内部 chip 会被压成
         17×34 —— 那不是「点击目标太小」，是它正在消失。 */
      if (w < 8 || h < 8) continue;
      if (Math.min(w, h) < 24) {
        target.push({ el: sel(el), w, h, text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 18) });
      }
    }
  }
  target.sort((a, b) => Math.min(a.w, a.h) - Math.min(b.w, b.h));

  /* ---------- ④ 静默截断 ---------- */
  const trunc = [];
  {
    for (const el of document.body.querySelectorAll('*')) {
      if (!visible(el)) continue;
      const cs = getComputedStyle(el);
      if (!(cs.overflowX === 'hidden' || cs.textOverflow === 'ellipsis')) continue;
      if (el.scrollWidth <= el.clientWidth + 1) continue;
      const hasTitle = el.hasAttribute('title') || el.hasAttribute('aria-label') || el.hasAttribute('aria-describedby');
      if (hasTitle || el.dataset.tip || el.dataset.title) continue;
      const text = (el.textContent || '').trim();
      if (!text) continue;
      trunc.push({
        el: sel(el), text: text.replace(/\s+/g, ' ').slice(0, 26),
        scrollW: el.scrollWidth, clientW: el.clientWidth,
      });
    }
  }

  return {
    scene: O.scene || '',
    theme: document.body.dataset.theme || 'light',
    /* 自证字段：探针必须能证明"主题真的切了、过渡真的关了"。
       否则读到的浅色值会被当成"深色对比度不足"，白改一通 CSS。
       v1.20.0 又加了三支强调色 —— 自定义色的门禁同样是"可证伪"的：
       如果探针没真的把色设进去，对比度当然全绿，那是恒真的假门禁。
       所以这里直接报出 --accent-solid / --on-accent / --accent 的**实测比值**。 */
    diag: (function () {
      const hex = (s) => {
        const m = /^#([0-9a-f]{6})$/i.exec(String(s || '').trim());
        if (!m) return null;
        const v = parseInt(m[1], 16);
        return [(v >> 16) & 255, (v >> 8) & 255, v & 255, 1];
      };
      const any = (s) => hex(s) || parse(s);
      const b = getComputedStyle(document.body);
      const solid = any(b.getPropertyValue('--accent-solid'));
      const onAcc = any(b.getPropertyValue('--on-accent'));
      const acc = any(b.getPropertyValue('--accent'));
      const paper = any(b.getPropertyValue('--paper'));
      return {
        anim: document.body.dataset.anim || '(unset)',
        ink2: b.getPropertyValue('--ink-2').trim(),
        paper: b.getPropertyValue('--paper').trim(),
        accent: b.getPropertyValue('--accent').trim(),
        solid: b.getPropertyValue('--accent-solid').trim(),
        onAccent: b.getPropertyValue('--on-accent').trim(),
        accentText: b.getPropertyValue('--accent-text').trim(),
        onSolid: (solid && onAcc) ? ratio(solid, onAcc) : null,
        accentOnPaper: (acc && paper) ? ratio(acc, paper) : null,
        textOnPaper: (any(b.getPropertyValue('--accent-text')) && paper)
          ? ratio(any(b.getPropertyValue('--accent-text')), paper) : null,
      };
    })(),
    counts: { contrast: contrast.length, clip: clip.length, target: target.length, trunc: trunc.length },
    contrast: contrast.slice(0, MAX),
    clip: clip.slice(0, MAX),
    target: target.slice(0, MAX),
    trunc: trunc.slice(0, MAX),
  };
})()`;

/* ============ 主流程 ============ */
async function run() {
  const win = new BrowserWindow({
    width: 1440, height: 900, show: false, frame: false,
    webPreferences: { preload: path.join(__dirname, '..', '..', 'electron', 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('PAGE-ERR ' + msg); });

  protocol.handle('vf', async (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '');
    const abs = path.resolve(APPDIR, rel || 'index.html');
    try {
      return new Response(fs.readFileSync(abs), { headers: { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream' } });
    } catch (e) { return new Response('', { status: 404 }); }
  });

  await win.loadURL('vf://app/index.html');
  await sleep(900);

  const js = (code) => win.webContents.executeJavaScript(code, true);

  const files = collect(PICDIR, PICDIR).slice(0, 24);
  await js(`(() => {
    const S = window.State, A = window.App;
    S.sources = [
      { id: 's0', name: 'Screenshots', root: 'C:/x' },
      { id: 's1', name: '相机导入 2026-08', root: 'C:/y' },
    ];
    S.items = ${JSON.stringify(files.map((f, i) => ({
      id: 'a' + i, name: path.basename(f.abs), src: 'all', sid: i % 2 ? 's1' : 's0',
      size: f.size, path: f.abs, ext: path.extname(f.abs).slice(1).toLowerCase(),
    })))};
    S.sourceCount = () => S.items.length;
    A.showGallery(); A.renderSources();
    document.getElementById('topbar').hidden = false;
    /* 关掉过渡：窗口是 show:false 的，Chromium 会对隐藏窗口的动画做节流，
       于是 --dur: .2s 的颜色过渡实测要走 1s 以上。不关的话，切完主题
       450ms 去量，读到的是**插值中间值**（深色终值 #a1a1a6、浅色起点
       #55555b，量出 129,129,134），结论会变成"深色下侧栏文字对比度 2.3"
       —— 假警报，而且很难看出是探针自己的问题。
       data-anim="0" 是产品自带的开关（设置里的"减少动态效果"），
       打开后 transition-duration 变 .01ms，主题切换即时生效。 */
    document.body.dataset.anim = '0';
    return true;
  })()`);
  await sleep(1200);

  const out = {};
  const SCENE = process.env.SCENE || 'all';

  /* 等界面稳定：隐藏窗口（show:false）里 Chromium 会节流样式重算，固定 sleep
     不可靠 —— 实测切主题后 450ms 读到的是浅色旧值（深色下误报 "侧栏 2.3:1"），
     2200ms 才稳定。改成轮询到连续两次读数一致，自适应又不浪费时间。 */
  const STABLE = `(() => {
    /* 先建过渡再收过渡（见 MEASURE 里同一段注释）：
       不这么做，这里可能连续两次读到同一批**旧值**，settle 于是"稳定在错误状态"上。 */
    void document.body.offsetHeight;
    document.getAnimations().forEach((a) => { try { a.finish(); } catch (e) {} });
    void document.body.offsetHeight;
    document.getAnimations().forEach((a) => { try { a.finish(); } catch (e) {} });
    return [...document.querySelectorAll('.src-chip .sc-name')]
      .map((e) => getComputedStyle(e).color).join('|')
      + '#' + getComputedStyle(document.body).backgroundColor;
  })()`;
  const settle = async (maxMs = 6000) => {
    /* 先等 900ms 再开始轮询：样式重算还没启动时，连续两次读到的是同一批旧值，
       cur===prev 立刻成立 —— 会「稳定在错误状态」上，而且比不等待更危险。 */
    await sleep(900);
    let prev = null, same = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      const cur = await js(STABLE);
      if (cur === prev) { if (++same >= 2) return cur; } else { same = 0; prev = cur; }
      await sleep(160);
    }
    return prev;
  };

  const measure = async (tag) => {
    await settle();
    const r = await js(MEASURE({ scene: tag }));
    out[tag] = r;
    console.log('SCENE ' + tag + ' ' + JSON.stringify(r.counts));
  };

  if (SCENE === 'all' || SCENE === 'gallery') {
    await js(`window.App.applySetting('theme', 'light')`);
    await sleep(400);
    await measure('gallery-light');
    await js(`window.App.applySetting('theme', 'dark')`);
    await settle();
    await measure('gallery-dark');
    await js(`window.App.applySetting('theme', 'light')`);
    await sleep(300);
  }

  if (SCENE === 'all' || SCENE === 'select') {
    await js(`(() => { document.querySelectorAll('.tile').forEach((t, i) => { if (i < 3) t.click(); }); return true; })()`);
    await sleep(600);
    await measure('selectbar');
    await js(`window.App.exitSelect && window.App.exitSelect()`);
    await sleep(350);
  }

  if (SCENE === 'all' || SCENE === 'lightbox') {
    await js(`(() => { const t = document.querySelector('.tile'); if (t) t.click(); return true; })()`);
    await sleep(1100);
    await measure('lightbox');
    /* 再打开信息面板 + 缩略图条量一遍：这两块里有**最弱的一档文字**
       （信息面板的键名 .lb-info-k 与脚注），而它们默认不展开 ——
       只量"刚打开的样子"等于永远不量那一档。v1.20.0 之前深色下
       那档只有 2.7:1，就是因为从来没被量过。 */
    await js(`(() => {
      const a = document.getElementById('lbInfo'); if (a) a.click();
      const b = document.getElementById('lbStripBtn'); if (b) b.click();
      return true;
    })()`);
    await sleep(1000);
    await measure('lightbox-panel');
    await js(`(() => { if (window.Lightbox && window.Lightbox.close) window.Lightbox.close(); return true; })()`);
    await sleep(500);
  }

  /* 自定义强调色（v1.20.0）：用**最不利**的一支色 —— 纯黄 #ffcc00。
     白字压纯黄只有 1.4:1、黄字压浅灰只有 1.3:1，朴素做法必红。
     推导正确时：实底仍是黄、字换成近黑；强调文字压暗成橄榄色。
     两个主题各量一遍 —— 同一支色在浅色下要压暗、深色下要提亮，
     只量一个主题会漏掉一半。 */
  if (SCENE === 'all' || SCENE === 'accent') {
    const ACC = '#ffcc00';
    await js(`window.App.applySetting('theme', 'light')`);
    await sleep(500);
    await js(`(() => { window.State.setSetting('accent', '${ACC}'); window.App.applySetting('accent', '${ACC}'); return true; })()`);
    await sleep(400);
    await measure('accent-light');
    await js(`window.App.applySetting('theme', 'dark')`);
    await sleep(600);
    await measure('accent-dark');
    // 还原：不留一支黄在后续场景里
    await js(`(() => { window.State.setSetting('accent', 'auto'); window.App.applySetting('accent', 'auto'); window.App.applySetting('theme', 'light'); return true; })()`);
    await sleep(500);
  }

  if (SCENE === 'all' || SCENE === 'settings') {
    await js(`(() => { const b = document.getElementById('setBtn'); if (b) b.click(); return true; })()`);
    await sleep(800);
    await measure('settings');
    await js(`(() => { const b = document.getElementById('setBtn'); if (b) b.click(); return true; })()`);
    await sleep(450);
  }

  if (SCENE === 'all' || SCENE === 'trash') {
    await js(`(() => { const b = document.querySelector('#trashBtn') || document.querySelector('.trash-wrap .ico-btn'); if (b) b.click(); return true; })()`);
    await sleep(800);
    await measure('trash');
    await js(`(() => { const p = document.querySelector('.trash-panel'); if (p) p.hidden = true; return true; })()`);
    await sleep(400);
  }

  if (SCENE === 'all' || SCENE === 'empty') {
    await js(`(() => {
      const S = window.State, A = window.App;
      S.items = []; S.sources = []; S.sourceCount = () => 0;
      A.showGallery(); A.renderSources(); A.render && A.render();
      return true;
    })()`);
    await sleep(800);
    await measure('empty');
  }

  if (SCENE === 'all' || SCENE === 'narrow') {
    await js(`(() => {
      const S = window.State, A = window.App;
      S.sources = [{ id: 's0', name: 'Screenshots', root: 'C:/x' }];
      S.items = ${JSON.stringify(files.slice(0, 8).map((f, i) => ({
        id: 'n' + i, name: path.basename(f.abs), src: 'all', sid: 's0',
        size: f.size, path: f.abs, ext: path.extname(f.abs).slice(1).toLowerCase(),
      })))};
      S.sourceCount = () => 8;
      A.showGallery(); A.renderSources(); A.render && A.render();
      return true;
    })()`);
    await js(`(() => { document.body.classList.remove('lb-open'); const lb = document.querySelector('.lightbox'); if (lb) lb.hidden = true; return true; })()`);
    await sleep(600);
    await win.setContentSize(760, 800);
    await sleep(700);
    await measure('narrow-760');
    await win.setContentSize(1440, 900);
    await sleep(500);
  }

  fs.writeFileSync(path.join(__dirname, '..', 'logs', 'uxaudit.json'), JSON.stringify(out, null, 1));
  console.log('UXAUDIT ' + JSON.stringify(out, null, 1));
  app.quit();
}

app.whenReady().then(run).catch((e) => { console.error('FATAL', e); app.quit(); });
