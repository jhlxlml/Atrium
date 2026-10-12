/* 无障碍探针：在真实 Electron 里逐条验证「焦点到底在哪」。
   ------------------------------------------------------------
   为什么非要在真 Chromium 里做：无障碍断言最容易假通过 —— 查 aria 属性在不在，
   属性永远都在，但焦点可能压根没动。这里**每条都读 document.activeElement 的实际落点**，
   而且必须连按多次 Tab 仍不出容器（这才叫"圈住"），关闭后必须回到出发控件。

   还有一个只有真环境才能验的点：**Tab 走真实输入事件**（webContents.sendInputEvent），
   不是自己 dispatch 一个假 KeyboardEvent —— 后者不触发浏览器默认行为，
   "焦点被圈住"到底是我们的 keydown 拦住了、还是浏览器本来就不动，分不清。

   用法: electron.exe probe_a11y.js  (cwd = deploy/electron) */
const { app, BrowserWindow, protocol, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');

/* 桌面集成通道桩：缺了它 App.init() 的托盘/快捷键设置重放会"假失败"，
   回滚时弹一条 urgent 播报，把常驻播报区改成 alert/assertive —— 详见 _desktop_stub.js。 */
require('./_desktop_stub').stubDesktop();
/* 窗口置顶 / 屏幕清单也要补桩：App.init() 启动时会拉，缺了会让探针变成"不完整宿主"
   —— invoke reject 被 .catch 吞掉，上层判"没生效"，并留下一条 console.warn 假报错。 */
require('./_desktop_stub').stubWindowChannels();

const APPDIR = path.resolve(__dirname, '..', '..', '..');
const PICDIR = path.join(__dirname, '..', 'fixtures', '照片夹');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

protocol.registerSchemesAsPrivileged([
  { scheme: 'vf', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
]);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };

// 静音原生通道（本探针只关心焦点，不碰磁盘）
for (const ch of ['vf:trashLog', 'vf:autoDir', 'vf:pickDirs', 'vf:restoreFile', 'vf:restoreFiles',
  'vf:trashForget', 'vf:trashClear', 'vf:pickFolder', 'vf:loadDir', 'vf:openRecycleBin']) {
  ipcMain.handle(ch, () => (ch === 'vf:trashLog' || ch === 'vf:pickDirs' ? [] : null));
}

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

app.whenReady().then(async () => {
  // 内存分区：每次运行 localStorage 都是空的，断言可重复。
  // 注意：自定义 partition 是独立 session，vf:// 必须也注册在它上面，
  // 只注册默认 session 会让 vf://app/index.html 报 ERR_FAILED。
  const PART = 'vf-a11y-' + Date.now();
  const ses = session.fromPartition(PART);

  const handleVf = async (req) => {
    const u = new URL(req.url);
    if (u.host === 'pic') {
      const b64 = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      const abs = Buffer.from(b64, 'base64url').toString('utf8');
      try {
        const b = await fs.promises.readFile(abs);
        return new Response(b, { headers: { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' } });
      } catch (e) { return new Response('404', { status: 404 }); }
    }
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const abs = path.resolve(APPDIR, rel || 'index.html');
    try {
      const b = await fs.promises.readFile(abs);
      return new Response(b, { headers: { 'content-type': (MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream') } });
    } catch (e) { return new Response('404', { status: 404 }); }
  };
  protocol.handle('vf', handleVf);
  ses.protocol.handle('vf', handleVf);

  const w = new BrowserWindow({
    width: 1400, height: 880, show: true, focusable: true,
    webPreferences: {
      preload: path.join(APPDIR, 'deploy', 'electron', 'preload.js'),
      contextIsolation: true,
      partition: PART,
    },
  });
  w.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('PAGE-ERR ' + msg); });

  const exec = (code) => w.webContents.executeJavaScript(code);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(cond, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      // eslint-disable-next-line no-await-in-loop
      const hit = await exec('!!(' + cond + ')').catch(() => false);
      if (hit) return true;
      // eslint-disable-next-line no-await-in-loop
      await wait(120);
    }
    return false;
  }

  /* Tab / Shift+Tab 走**真实输入事件**。返回是否真的发生了焦点移动 ——
     这条诊断很重要：若窗口拿不到系统焦点，sendInputEvent 可能不生效，
     那时断言会红，但原因在环境而不在产品，得能一眼区分。

     焦点指纹**不能只用 id/className**：灯箱里那一排按钮共用同一个 class，
     换成第二个按钮指纹不变，moved 会被误判成 false（第一版就栽在这）。
     这里带上父节点内的下标与 aria-label / data-act，保证相邻同款控件可区分。 */
  const SIG = `(() => {
    const a = document.activeElement;
    if (!a) return '';
    const p = a.parentElement;
    const idx = p ? Array.prototype.indexOf.call(p.children, a) : -1;
    return a.tagName + '#' + (a.id || '') + '.' + String(a.className || '')
      + '@' + (a.getAttribute('aria-label') || a.getAttribute('data-act') || '')
      + '[' + idx + ']';
  })()`;
  async function pressKey(code, shift) {
    const modifiers = shift ? ['shift'] : [];
    const before = await exec(SIG);
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode: code, modifiers });
    w.webContents.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers });
    await wait(120);
    const after = await exec(SIG);
    return { moved: before !== after, before, after };
  }

  const files = collect(PICDIR, PICDIR);
  const recs = files.map((f) => ({ p: f.abs, n: path.basename(f.abs), rel: f.rel, size: f.size, mtime: f.mtime }));

  await w.loadURL('vf://app/index.html');
  await wait(900);
  await exec(`(() => {
    const S = window.State, A = window.App;
    S.sources = [{ id: 's0', name: '照片夹', root: 'C:/Users/me/Pictures/照片夹' }];
    S.items = ${JSON.stringify(recs)}.map((r, i) => ({
      id: 'r' + i, name: r.n, src: 'all', sid: 's0',
      size: r.size, path: r.p, rel: r.rel, ext: r.n.split('.').pop().toLowerCase(),
      lastModified: r.mtime, state: 'idle',
    }));
    S.sourceCount = (id) => (id === 'all' ? S.items.length : S.items.filter((x) => x.sid === id).length);
    A.showGallery(); A.renderSources();
    document.getElementById('topbar').hidden = false;
    window.__probe = {};
    return true;
  })()`);
  await wait(1500);

  /* =================== 1) 静态语义 + 播报区 =================== */
  const sem = await exec(`(() => {
    const g = (id) => document.getElementById(id);
    const live = g('a11yLive');
    const cs = live ? getComputedStyle(live) : null;
    const r = live ? live.getBoundingClientRect() : null;
    const lb = g('lightbox'), sp = g('setPanel');
    /* 把"启动到此刻一共播报了几条、最后一条是什么"一并带回。
       这是为了自证原因：若 liveRole 读出来是 alert，说明启动过程中有人发过
       urgent 播报（A11y.live 按 urgency 改档、改完不复位）。只报 alert/assertive
       三个值看不出"谁干的"，历史上一度被误判成 result.txt 被截断。 */
    const st = (window.A11y && window.A11y.liveState) ? window.A11y.liveState() : {};
    return {
      moduleLoaded: !!(window.A11y && typeof window.A11y.live === 'function' && typeof window.A11y.trap === 'function'),
      liveExists: !!live,
      liveRole: live ? live.getAttribute('role') : '',
      liveMode: live ? live.getAttribute('aria-live') : '',
      liveAtomic: live ? live.getAttribute('aria-atomic') : '',
      liveCount: (typeof st.count === 'number') ? st.count : -1,
      liveLast: st.last || '',
      /* 播报区必须"视觉上不可见、但留在无障碍树里"：
         display:none / visibility:hidden 会把它一起从无障碍树摘掉，那是错的 */
      liveDisplay: cs ? cs.display : '',
      liveVisibility: cs ? cs.visibility : '',
      liveW: r ? Math.round(r.width) : -1,
      liveH: r ? Math.round(r.height) : -1,
      lbRole: lb ? lb.getAttribute('role') : '',
      lbModal: lb ? lb.getAttribute('aria-modal') : '',
      lbLabel: lb ? lb.getAttribute('aria-label') : '',
      spRole: sp ? sp.getAttribute('role') : '',
      spModal: sp ? sp.getAttribute('aria-modal') : '',
    };
  })()`);

  const liveStep = await exec(`(() => {
    const before = window.A11y.liveState();
    window.App.toast('探针：已移入回收站');
    const ok1 = window.A11y.liveState();
    window.App.toast('探针：导出失败', { urgent: true });
    const ug = window.A11y.liveState();
    // 同一条消息连播两次：内容不变时辅助技术收不到"变更"事件，第二次会静默
    window.App.toast('探针：导出失败', { urgent: true });
    const twice = window.A11y.liveState();
    return {
      beforeCount: before.count, beforeText: before.text,
      okText: ok1.text, okRole: ok1.role, okMode: ok1.live, okCount: ok1.count,
      ugText: ug.text, ugRole: ug.role, ugMode: ug.live,
      twiceText: twice.text, twiceCount: twice.count,
      domText: (document.getElementById('a11yLive') || {}).textContent || '',
    };
  })()`);
  console.log('A11YSEM ' + JSON.stringify(sem));
  console.log('A11YLIVE ' + JSON.stringify(liveStep));

  /* =================== 2) 删除确认弹层 =================== */
  const focusFrom = await exec(`(() => {
    const b = [...document.querySelectorAll('#topbar button')].filter((x) => x.getClientRects().length && !x.hidden)[0];
    if (!b) return '';
    b.focus();
    window.__probe.fromBtn = b;
    return b.id || b.className;
  })()`);
  await exec(`(() => {
    window.__probe.modalP = window.App.modal({
      title: '移入回收站？', body: '探针测试弹层', confirmText: '移入回收站', cancelText: '取消',
    });
    return true;
  })()`);
  await wait(350);

  const modalOpen = await exec(`(() => {
    const w = document.querySelector('.vf-modal');
    if (!w) return { exists: false };
    const card = w.querySelector('.vf-modal-card');
    const a = document.activeElement;
    const titleId = w.querySelector('.vf-modal-title').id;
    return {
      exists: true,
      activeInside: !!(a && w.contains(a)),
      activeAct: a ? (a.getAttribute('data-act') || '') : '',
      role: card.getAttribute('role'),
      ariaModal: card.getAttribute('aria-modal'),
      labelledby: card.getAttribute('aria-labelledby') || '',
      labelResolves: !!(titleId && w.querySelector('#' + CSS.escape(titleId))),
      labelText: titleId ? (w.querySelector('.vf-modal-title') || {}).textContent : '',
    };
  })()`);

  const modalTabs = [];
  for (let i = 0; i < 6; i++) {
    const k = await pressKey('Tab', false);
    const st = await exec(`(() => {
      const w = document.querySelector('.vf-modal');
      const a = document.activeElement;
      return { inside: !!(w && a && w.contains(a)), act: a ? (a.getAttribute('data-act') || '') : '' };
    })()`);
    modalTabs.push({ moved: k.moved, inside: st.inside, act: st.act });
  }
  const modalBacks = [];
  for (let i = 0; i < 3; i++) {
    const k = await pressKey('Tab', true);
    const st = await exec(`(() => {
      const w = document.querySelector('.vf-modal');
      const a = document.activeElement;
      return { inside: !!(w && a && w.contains(a)), act: a ? (a.getAttribute('data-act') || '') : '' };
    })()`);
    modalBacks.push({ moved: k.moved, inside: st.inside, act: st.act });
  }

  await exec(`(() => { const b = document.querySelector('.vf-modal [data-act="cancel"]'); if (b) b.click(); return true; })()`);
  await wait(400);
  const modalClosed = await exec(`(() => {
    const a = document.activeElement;
    return {
      stillOpen: !!document.querySelector('.vf-modal'),
      activeId: a ? (a.id || a.className || a.tagName) : '',
      restored: !!(a && window.__probe.fromBtn === a),
      fromId: window.__probe.fromBtn ? (window.__probe.fromBtn.id || window.__probe.fromBtn.className) : '',
    };
  })()`);
  console.log('A11YMODAL ' + JSON.stringify({ focusFrom, open: modalOpen, tabs: modalTabs, backs: modalBacks, closed: modalClosed }));

  /* =================== 3) 设置面板 =================== */
  await exec(`(() => { const b = document.getElementById('setBtn'); b.focus(); b.click(); return true; })()`);
  await wait(400);
  const spOpen = await exec(`(() => {
    const p = document.getElementById('setPanel');
    const a = document.activeElement;
    return {
      open: !p.hidden,
      activeIsPanel: a === p,
      activeTag: a ? a.tagName : '',
      activeId: a ? a.id : '',
      tabindex: p.getAttribute('tabindex'),
    };
  })()`);
  const spTabs = [];
  for (let i = 0; i < 5; i++) {
    const k = await pressKey('Tab', false);
    const st = await exec(`(() => {
      const p = document.getElementById('setPanel');
      const a = document.activeElement;
      return { inside: !!(a && p.contains(a)), tag: a ? a.tagName : '', cls: a ? String(a.className || '') : '' };
    })()`);
    spTabs.push({ moved: k.moved, inside: st.inside, tag: st.tag });
  }
  await exec(`(() => { const b = document.getElementById('setClose'); if (b) b.click(); return true; })()`);
  await wait(400);
  const spClosed = await exec(`(() => {
    const p = document.getElementById('setPanel');
    const a = document.activeElement;
    return { closed: p.hidden, activeId: a ? a.id : '', onBtn: a === document.getElementById('setBtn'), tabindex: p.getAttribute('tabindex') };
  })()`);
  console.log('A11YSP ' + JSON.stringify({ open: spOpen, tabs: spTabs, closed: spClosed }));

  /* =================== 4) 灯箱 =================== */
  const lbFrom = await exec(`(() => {
    const t = document.querySelector('.tile');
    if (!t) return '';
    t.focus();
    window.__probe.tile = t;
    return t.className;
  })()`);
  await exec(`(() => { const L = window.Lightbox; L.open(window.State.viewList(), window.State.items[0]); return !!L.openFlag; })()`);
  await waitFor('window.Lightbox.openFlag === true', 5000);
  await wait(600);
  const lbOpen = await exec(`(() => {
    const el = document.getElementById('lightbox');
    const a = document.activeElement;
    return {
      open: window.Lightbox.isOpen(),
      activeIsLb: a === el,
      activeInside: !!(a && el.contains(a)),
      tabindex: el.getAttribute('tabindex'),
      focusableCount: window.A11y.focusables(el).length,
    };
  })()`);
  const lbTabs = [];
  for (let i = 0; i < 6; i++) {
    const k = await pressKey('Tab', false);
    const st = await exec(`(() => {
      const el = document.getElementById('lightbox');
      const a = document.activeElement;
      return { inside: !!(a && el.contains(a)), tag: a ? a.tagName : '', cls: a ? String(a.className || '') : '' };
    })()`);
    lbTabs.push({ moved: k.moved, inside: st.inside, tag: st.tag });
  }
  const escKey = await pressKey('Escape', false);
  await wait(700);
  const lbClosed = await exec(`(() => {
    const a = document.activeElement;
    return {
      open: window.Lightbox.isOpen(),
      activeCls: a ? String(a.className || '') : '',
      onTile: !!(a && a.classList && a.classList.contains('tile')),
      onSameTile: a === window.__probe.tile,
    };
  })()`);
  console.log('A11YLBOX ' + JSON.stringify({ lbFrom, open: lbOpen, tabs: lbTabs, escMoved: escKey.moved, closed: lbClosed }));

  /* =================== 5) 相框页内浮层 =================== */
  await exec(`(() => {
    const S = window.State;
    window.Frame.boot({ ms: 60000, fit: 'contain', dock: 'none',
      sources: S.sources.map((s) => ({ id: s.id, name: s.name })), metas: S.items, inApp: true });
    return true;
  })()`);
  await wait(600);
  const frBase = await exec(`(() => {
    const el = document.getElementById('frLayer');
    if (!el) return { exists: false };
    const bar = el.querySelector('.fr-bar');
    return {
      exists: true,
      role: el.getAttribute('role'),
      label: el.getAttribute('aria-label'),
      barOn: el.classList.contains('fr-bar-on'),
      barVisibility: bar ? getComputedStyle(bar).visibility : '',
      focusablesWhileHidden: window.A11y.focusables(el).length,
      tabindex: el.getAttribute('tabindex'),
    };
  })()`);
  // 键盘路径：焦点进相框 → 控制条应该亮（原本纯 hover 驱动，visibility:hidden 时 Tab 根本进不去）
  /* 注意必须**分两步且中间等一拍**：.fr-bar 带 `visibility .18s` 过渡，
     加类后同一帧读 getComputedStyle 拿到的还是 'hidden'（过渡的 t=0 就是起始值），
     紧接着 btn.focus() 也会因为"元素此刻还不可见"而落空。
     第一版就是没等这一拍，把产品判成了坏的。 */
  await exec(`(() => { document.getElementById('frLayer').focus(); return true; })()`);
  await wait(350);
  const frFocus = await exec(`(() => {
    const el = document.getElementById('frLayer');
    const bar = el.querySelector('.fr-bar');
    const vis = bar ? getComputedStyle(bar).visibility : '';
    const nShown = window.A11y.focusables(el).length;
    const btn = el.querySelector('[data-act="next"]');
    if (btn) btn.focus();
    return {
      layerFocusedEarlier: true,
      barOn: el.classList.contains('fr-bar-on'),
      hotOpen: el.querySelector('.fr-hot').getAttribute('data-open'),
      visAfterSettle: vis,
      focusablesWhileShown: nShown,
      btnFocusable: !!btn && document.activeElement === btn,
      activeTag: document.activeElement ? document.activeElement.tagName : '',
    };
  })()`);
  // 焦点离开相框 → 控制条收起（同样要等一拍：visibility 从 visible 转 hidden
  // 是在过渡**结束**时才翻转的，立刻读会拿到 'visible'）
  await exec(`(() => { document.getElementById('setBtn').focus(); return true; })()`);
  await wait(350);
  const frBlur = await exec(`(() => {
    const el = document.getElementById('frLayer');
    return {
      barOnAfterBlur: el ? el.classList.contains('fr-bar-on') : null,
      visAfterBlur: el ? getComputedStyle(el.querySelector('.fr-bar')).visibility : '',
      focusOutside: document.activeElement === document.getElementById('setBtn'),
    };
  })()`);
  const frClosed = await exec(`(() => { window.Frame.close(true); return { gone: !document.getElementById('frLayer') }; })()`);
  console.log('A11YFRAME ' + JSON.stringify({ base: frBase, focus: frFocus, blur: frBlur, closed: frClosed }));

  app.quit();
}).catch((e) => { console.error('ERR', (e && e.stack) || e); app.quit(); });
