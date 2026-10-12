/* 设置面板探针：真实 Electron 中打开设置 → 逐项切换 → 验证生效与持久化。
   用法: electron.exe probe_settings.js  (cwd = deploy/electron) */
const { app, BrowserWindow, ipcMain, protocol } = require('electron');

/* 桌面集成通道桩：缺了它 App.init() 的托盘/快捷键设置重放会"假失败" —— 详见 _desktop_stub.js */
require('./_desktop_stub').stubDesktop();
const path = require('path');
const fs = require('fs');

const APPDIR = path.resolve(__dirname, '..', '..', '..');
const OUT = path.resolve(__dirname, '..', 'shots');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

protocol.registerSchemesAsPrivileged([
  { scheme: 'vf', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
]);

const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg' };
const noop = ['vf:autoDir','vf:pickDirs','vf:restoreFile','vf:restoreFiles','vf:trashForget',
  'vf:trashClear','vf:pickFolder','vf:loadDir','vf:openRecycleBin'];
noop.forEach((c) => ipcMain.handle(c, () => null));
ipcMain.handle('vf:trashLog', () => []);
/* 窗口置顶：探针里必须真回一个值，否则设置里的开关会被"实际未生效"回滚 */
let AOT = false;
ipcMain.handle('vf:alwaysOnTop', (e, v) => { AOT = !!v; return AOT; });
ipcMain.handle('vf:getAlwaysOnTop', () => AOT);

/* 版本更新检测（v1.14.0）。
   这里刻意回一个"有新版本"的**假响应** —— 要验的是「发现新版本」这条路径
   在界面上的渲染（文案 + 「查看」外链），而不是网络本身。
   若桩返回 {ok:false}，渲染层会走"检查失败"分支，那条路径就永远测不到。 */
ipcMain.handle('vf:checkUpdate', () => ({
  ok: true, current: '1.13.0', latest: '9.9.9', hasUpdate: true,
  url: 'https://github.com/jhlxlml/Atrium/releases/tag/v9.9.9',
}));
/* 外链打开：记录**每一次**调用（而不是只留最后一次）——
   「关于」里有两条外链（仓库首页 + 更新详情），只留最后一次就分不清是哪条被点了。 */
let externalCalls = [];
ipcMain.handle('vf:openExternal', (e, url) => { externalCalls.push(String(url || '')); return true; });

async function run() {
  protocol.handle('vf', async (req) => {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const abs = path.resolve(APPDIR, rel || 'index.html');
    if (!abs.startsWith(APPDIR)) return new Response('forbidden', { status: 403 });
    try {
      const b = await fs.promises.readFile(abs);
      return new Response(b, { headers: { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' } });
    } catch (e) { return new Response('404', { status: 404 }); }
  });

  const win = new BrowserWindow({
    width: 1500, height: 900, show: true,
    webPreferences: { preload: path.join(APPDIR, 'deploy', 'electron', 'preload.js'), contextIsolation: true },
  });
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('PAGE-ERR ' + msg); });
  await win.loadURL('vf://app/index.html');
  await new Promise((r) => setTimeout(r, 900));

  // 注入假来源让顶栏出现
  await win.webContents.executeJavaScript(`(() => {
    const S = window.State, A = window.App;
    S.sources = [{ id:'s0', name:'Screenshots', root:'C:/a' }, { id:'s1', name:'Camera Roll', root:'C:/b' }];
    S.items = [];
    for (let i = 0; i < 24; i++) S.items.push({ id:'a'+i, name:'IMG_'+i+'.jpg', src:'all', sid:'s0',
      size: 204800+i, path:'C:/x/'+i+'.jpg', ext:'jpg' });
    S.sourceCount = (id) => id==='all' ? S.items.length : 12;
    A.showGallery(); A.renderSources();
    document.getElementById('topbar').hidden = false;
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 500));

  // 1) 打开设置
  const step1 = await win.webContents.executeJavaScript(`(() => {
    const btn = document.getElementById('setBtn');
    const p = document.getElementById('setPanel');
    btn.click();
    const r = p.getBoundingClientRect();
    const cx = Math.round(r.x + r.width/2), cy = Math.round(r.y + r.height/2);
    const hit = document.elementFromPoint(cx, cy);
    // 期望值直接由「设置项定义」推导，避免每次加一行设置就来改断言
    const defs = (window.Settings && window.Settings.groups ? window.Settings.groups() : [])
      .reduce((a, g) => a.concat(g.rows || []), []);
    const byType = (t) => defs.filter((d) => d.type === t).length;
    return {
      btnExists: !!btn,
      panelOpen: !p.hidden,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      inViewport: r.x >= 0 && r.y >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
      hitInsidePanel: !!(hit && p.contains(hit)),
      groups: [...p.querySelectorAll('.sp-group-h')].map(e => e.textContent),
      rowCount: p.querySelectorAll('.sp-row').length,
      switches: p.querySelectorAll('.sp-switch').length,
      segs: p.querySelectorAll('.sp-seg').length,
      nums: p.querySelectorAll('.sp-num').length,
      expect: {
        rows: defs.length, switches: byType('switch'), segs: byType('seg'),
        nums: byType('range'), buttons: byType('button'), selects: byType('select'),
        keys: defs.map((d) => d.key),
        // 分组数也由定义推导 —— 加一个分组不该去改断言
        groupCount: (window.Settings && window.Settings.groups) ? window.Settings.groups().length : 0,
        // 当前分组里的 5 个按钮
        buttonKeys: defs.filter((d) => d.type === 'button').map((d) => d.key),
        // 按钮分发表已实现的键：与 buttonKeys 必须一一对应，
        // 否则就是"按钮画出来了但点了没反应"（v1.6.0 踩过的坑）
        actionKeys: Object.keys((window.Settings && window.Settings.actions) || {}),
      },
      panelParent: p.parentElement.tagName,
      btnIsOn: btn.classList.contains('is-on'),
      ariaExpanded: btn.getAttribute('aria-expanded'),
      // 新入口就位
      rowNames: [...p.querySelectorAll('.sp-name')].map((e) => e.textContent),
    };
  })()`);
  console.log('S1 ' + JSON.stringify(step1));

  const shot = await win.webContents.capturePage({ x: 0, y: 0, width: 1500, height: 700 });
  fs.writeFileSync(path.join(OUT, 'settings-open.png'), shot.toPNG());

  // 2) 逐项切换并验证生效
  const step2 = await win.webContents.executeJavaScript(`(() => {
    const S = window.State, p = document.getElementById('setPanel');
    const lab = (name) => [...p.querySelectorAll('.sp-row')]
      .find(r => r.querySelector('.sp-name') && r.querySelector('.sp-name').textContent === name);
    const out = {};

    // 主题：点「深色」
    const tRow = lab('主题');
    [...tRow.querySelectorAll('.sp-seg button')].find(b => b.textContent === '深色').click();
    out.themeSetting = S.settings.theme;
    out.bodyTheme = document.body.dataset.theme;
    out.bgDark = getComputedStyle(document.body).backgroundColor;

    // 密度：紧凑
    const dRow = lab('信息密度');
    [...dRow.querySelectorAll('.sp-seg button')].find(b => b.textContent === '紧凑').click();
    out.densitySetting = S.settings.density;
    out.bodyDensity = document.body.dataset.density;
    out.topbarH = getComputedStyle(document.querySelector('.topbar-in')).height;

    // 显示文件名
    lab('显示文件名').querySelector('.sp-switch').click();
    out.showNames = S.settings.showNames;
    out.bodyShowNames = document.body.dataset.showNames;
    const cap = document.querySelector('.tile-cap');
    out.capOpacity = cap ? getComputedStyle(cap).opacity : null;

    // 来源数量角标
    lab('来源显示数量').querySelector('.sp-switch').click();
    out.showCnt = S.settings.showCnt;
    const cnt = document.querySelector('.src-chip .sc-count');
    out.cntDisplay = cnt ? getComputedStyle(cnt).display : null;

    // 滚轮行为：切换图片
    const wRow = lab('滚轮行为');
    [...wRow.querySelectorAll('.sp-seg button')].find(b => b.textContent === '切换图片').click();
    out.wheelMode = S.settings.wheelMode;
    out.lbWheelMode = window.Lightbox.wheelMode;

    // 过渡动画：关
    lab('过渡动画').querySelector('.sp-switch').click();
    out.animOn = S.settings.animOn;
    out.bodyAnim = document.body.dataset.anim;

    // 幻灯片间隔：改成 6 秒
    const num = lab('幻灯片间隔').querySelector('.sp-num');
    num.value = '6'; num.dispatchEvent(new Event('change'));
    out.slideshowMs = S.settings.slideshowMs;
    out.lbPlayMs = window.Lightbox.playMs;

    // 删除前确认：关
    lab('删除前确认').querySelector('.sp-switch').click();
    out.confirmDelete = S.settings.confirmDelete;

    // 自动显示图片信息 / 缩略图条：开
    lab('自动显示图片信息').querySelector('.sp-switch').click();
    lab('自动显示缩略图条').querySelector('.sp-switch').click();
    out.autoInfo = window.Lightbox.autoInfo;
    out.autoStrip = window.Lightbox.autoStrip;

    // 记住上次位置：关
    lab('记住上次位置').querySelector('.sp-switch').click();
    out.rememberLast = S.settings.rememberLast;

    /* 「检查更新」（v1.14.0）：按能力探测出现在「隐私与安全」组里。
       这里**只读不点** —— 点它会真的发起一次检查（探针里虽被桩接住，
       但会把"发现新版本"的提示弹出来，干扰后面的步骤）。 */
    out.updRowExists = !!lab('检查更新');
    out.updDefaultOff = S.defaults.updateCheck === false;

    return out;
  })()`);
  console.log('S2 ' + JSON.stringify(step2));

  // 3) 持久化：读 localStorage
  const step3 = await win.webContents.executeJavaScript(`(() => {
    const raw = JSON.parse(localStorage.getItem('viewfinder.settings.v1') || '{}');
    return {
      theme: raw.theme, density: raw.density, showNames: raw.showNames, showCnt: raw.showCnt,
      wheelMode: raw.wheelMode, animOn: raw.animOn, slideshowMs: raw.slideshowMs,
      confirmDelete: raw.confirmDelete, autoInfo: raw.autoInfo, autoStrip: raw.autoStrip,
      rememberLast: raw.rememberLast,
    };
  })()`);
  console.log('S3 ' + JSON.stringify(step3));

  // 4) 眼睛按钮与设置面板的「模糊预览」双向同步 + 恢复默认
  const step4 = await win.webContents.executeJavaScript(`(() => {
    const S = window.State, p = document.getElementById('setPanel');
    const lab = (name) => [...p.querySelectorAll('.sp-row')]
      .find(r => r.querySelector('.sp-name') && r.querySelector('.sp-name').textContent === name);
    const out = {};

    // 顶栏眼睛 → 设置里开关应同步
    document.getElementById('brandEye').click();
    out.blurAfterEye = S.settings.blurPreview;
    out.blurSwitchOn = lab('模糊预览').querySelector('.sp-switch').classList.contains('is-on');
    // 再点设置里的开关 → 反向同步
    lab('模糊预览').querySelector('.sp-switch').click();
    out.blurAfterSwitch = S.settings.blurPreview;
    out.bodyBlur = document.body.classList.contains('privacy-blur');

    // 恢复默认
    document.getElementById('setReset').click();
    const d = S.defaults;
    out.afterReset = { theme: S.settings.theme, density: S.settings.density,
      animOn: S.settings.animOn, slideshowMs: S.settings.slideshowMs,
      confirmDelete: S.settings.confirmDelete, showNames: S.settings.showNames };
    out.bodyAfterReset = { theme: document.body.dataset.theme, density: document.body.dataset.density,
      anim: document.body.dataset.anim, showNames: document.body.dataset.showNames };
    out.defaultsMatch = S.settings.theme === d.theme && S.settings.density === d.density
      && S.settings.animOn === d.animOn && S.settings.slideshowMs === d.slideshowMs;
    out.switchSynced = lab('过渡动画').querySelector('.sp-switch').classList.contains('is-on');

    // Esc 关闭
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    out.closedByEsc = p.hidden;
    return out;
  })()`);
  console.log('S4 ' + JSON.stringify(step4));

  // 5) 窄窗口下仍可点开且不越界
  await win.setContentSize(1080, 760);
  await new Promise((r) => setTimeout(r, 400));
  const step5 = await win.webContents.executeJavaScript(`(() => {
    const btn = document.getElementById('setBtn'), p = document.getElementById('setPanel');
    btn.click();
    const r = p.getBoundingClientRect();
    const cx = Math.round(r.x + r.width/2), cy = Math.round(r.y + 30);
    const hit = document.elementFromPoint(cx, cy);
    return { open: !p.hidden, w: Math.round(r.width), h: Math.round(r.height),
      inViewport: r.x >= 0 && r.y >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
      clickable: !!(hit && p.contains(hit)), innerW: innerWidth, innerH: innerHeight };
  })()`);
  console.log('S5 ' + JSON.stringify(step5));
  const shot2 = await win.webContents.capturePage({ x: 0, y: 0, width: 1080, height: 760 });
  fs.writeFileSync(path.join(OUT, 'settings-narrow.png'), shot2.toPNG());

  /* 6) v1.7.0 新增：清除缓存（真的清掉了才算过）+ 关于面板
        「清除缓存」这一条在 v1.6.0 曾经是**静默失效**的（按钮在，点了没反应），
        所以这里必须验证端到端：造缓存 → 点按钮 → 确认弹层 → 数量归零。 */
  await win.setContentSize(1500, 900);
  await new Promise((r) => setTimeout(r, 350));
  const step6 = await win.webContents.executeJavaScript(`(async () => {
    const L = window.Loader, S = window.State, p = document.getElementById('setPanel');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const lab = (name) => [...p.querySelectorAll('.sp-row')]
      .find(r => r.querySelector('.sp-name') && r.querySelector('.sp-name').textContent === name);
    const out = {};
    out.appVersionRaw = window.App.VERSION;

    // 面板若已关闭则重新打开
    if (p.hidden) { document.getElementById('setBtn').click(); await wait(120); }

    // —— 造缓存：缩略图 3 条 + 尺寸 2 条
    for (let i = 0; i < 3; i++) L.thumbCache.put('probe-t' + i, new Blob([new Uint8Array(4096)]), 256);
    await L.thumbCache.flush();
    L.recordDims({ id: 'probe-d1' }, 3200, 2133);
    L.recordDims({ id: 'probe-d2' }, 1200, 800);
    const tb = await L.thumbCache.stats();
    const db = await L.dimsCache.stats();
    out.beforeThumb = tb.count;
    out.beforeDimMem = db.mem;

    // —— 窗口置顶开关（设置里的入口应与顶栏按钮同一状态）
    const pinRow = lab('窗口置顶');
    out.pinRowExists = !!pinRow;
    pinRow.querySelector('.sp-switch').click();
    await wait(200);
    out.pinSetting = !!S.settings.alwaysOnTop;
    out.pinBtnOn = document.getElementById('pinBtn').classList.contains('is-on');
    pinRow.querySelector('.sp-switch').click();     // 还原
    await wait(200);
    out.pinRestored = !!S.settings.alwaysOnTop;

    // —— 清除缓存
    const row = lab('清除缓存');
    out.cacheRowExists = !!row;
    out.cacheBtnLabel = row ? row.querySelector('.sp-btn').textContent : null;
    row.querySelector('.sp-btn').click();
    await wait(140);
    const card = document.querySelector('.vf-modal-card');
    out.cacheModalOpen = !!card;
    out.cacheModalTitle = card ? card.querySelector('.vf-modal-title').textContent : null;
    const cbody = card ? card.querySelector('.vf-modal-body').textContent : '';
    out.cacheModalBody = cbody;
    out.cacheSaysNoPhotoDelete = /不会删除任何原图/.test(cbody);
    // 弹层里报的条数必须来自真实统计（探针分区是持久化的，条数会累计，故不做绝对值断言）
    out.cacheShowsThumbCount = cbody.indexOf('缩略图缓存') >= 0
      && cbody.indexOf(String(out.beforeThumb)) >= 0;
    out.cacheShowsDimCount = cbody.indexOf('尺寸缓存') >= 0;
    card.querySelector('[data-act="ok"]').click();
    /* 清缓存是异步的（清完才弹反馈），条数越多越慢 —— 固定等待会假失败：
       曾出现"缓存真的清了、但反馈还没弹出来"就被断言判死的情况。
       改成轮询等它出现，并记下实际等了多久（超时仍未出现才算真失败）。 */
    let toastText = '', toastWaitMs = 0;
    /* 轮询预算给到 8 秒。原先是 4 秒（40×100ms），在探针分区里缓存条数累积到
       几千条、又碰上磁盘忙的时候会**偶发假失败**（清真的清了，反馈只是还没弹）。
       这条断言测的是"有没有反馈"，不是"反馈有多快" —— 预算给宽一点，
       让偶发变成必然通过，而不是把偶发当失败。 */
    for (let i = 0; i < 80; i++) {
      await wait(100);
      toastWaitMs = (i + 1) * 100;
      toastText = [...document.querySelectorAll('.toast span')].map(e => e.textContent).join(' | ');
      if (/已清除缓存/.test(toastText)) break;
    }

    out.afterThumb = (await L.thumbCache.stats()).count;
    out.afterDimMem = (await L.dimsCache.stats()).mem;
    out.toastText = toastText;
    out.toastWaitMs = toastWaitMs;

    // —— 关于
    const aRow = lab('关于 Atrium');
    out.aboutRowExists = !!aRow;
    aRow.querySelector('.sp-btn').click();
    await wait(180);
    const c2 = document.querySelector('.vf-modal-card');
    out.aboutOpen = !!c2;
    out.aboutTitle = c2 ? c2.querySelector('.vf-modal-title').textContent : null;
    out.aboutBrand = c2 ? (c2.querySelector('.vf-about-name') || {}).textContent : null;
    out.aboutVersion = c2 ? (c2.querySelector('.vf-about-ver') || {}).textContent : null;
    out.aboutTag = c2 ? (c2.querySelector('.vf-about-tag') || {}).textContent : null;
    out.aboutSections = c2 ? [...c2.querySelectorAll('.vf-about-t')].map(e => e.textContent) : [];
    out.aboutBullets = c2 ? c2.querySelectorAll('.vf-about-ul li').length : 0;
    out.aboutActionBtns = c2 ? c2.querySelectorAll('.vf-modal-acts .btn').length : 0;
    out.aboutText = c2 ? c2.querySelector('.vf-about').textContent.replace(/\\s+/g, ' ').slice(0, 240) : '';
    /* 全文（只折叠空白，不截断）：关于面板有好几段，按 240 字截断只够看前两段 ——
       想断言"数据放在哪"那一段的措辞就必须拿全文（否则断言会假失败）。 */
    out.aboutTextAll = c2 ? c2.querySelector('.vf-about').textContent.replace(/\\s+/g, ' ') : '';
    out.aboutHasPlaceholder = c2 ? /undefined|\\[object|NaN/.test(c2.querySelector('.vf-about').textContent) : false;
    out.aboutFitsViewport = c2 ? (() => { const r = c2.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight + 1; })() : false;

    /* —— v1.14.0：「关于」里的 GitHub 链接 + 检查更新
         两条外链都必须走主进程白名单 IPC 打开（不能让窗口自己导航 ——
         主窗口的 will-navigate 会拦掉外链，不接管的话点了就是"没反应"）。 */
    const repoLink = c2 ? c2.querySelector('.vf-about-p a[data-ext]') : null;
    out.repoLinkHref = repoLink ? repoLink.getAttribute('href') : null;
    if (repoLink) repoLink.click();

    const updBtn = c2 ? c2.querySelector('[data-act="checkUpdate"]') : null;
    out.updBtnExists = !!updBtn;
    if (updBtn) {
      updBtn.click();
      // 请求是异步的：轮询等结果文本落地（"正在访问…"是初始态）
      let utxt = '';
      for (let i = 0; i < 40; i++) {
        await wait(60);
        const rEl = c2.querySelector('[data-role="updResult"]');
        utxt = rEl ? rEl.textContent : '';
        if (utxt && utxt.indexOf('正在访问') < 0) break;
      }
      out.updResultText = utxt;
      out.updBtnReEnabled = updBtn.disabled === false;
      const ua = c2.querySelector('.vf-about-upd-r a[data-ext]');
      out.updLinkHref = ua ? ua.getAttribute('href') : null;
      out.updLinkText = ua ? ua.textContent : null;
      if (ua) ua.click();
    }
    await wait(200);   // 等两次 openExternal 的 IPC 都落到主进程侧

    // 先不关闭：Node 端会趁「关于」开着截图，之后由 S7 关闭
    out.aboutStillOpen = !!document.querySelector('.vf-modal-card');
    return out;
  })()`);
  await new Promise((r) => setTimeout(r, 260));
  step6.extCalls = externalCalls.slice();
  console.log('S6 ' + JSON.stringify(step6));
  // 弹层有 160ms 淡入过渡；无 GPU 的探针环境里合成偏慢，多等一会儿再截图，免得拍到半透明帧
  await new Promise((r) => setTimeout(r, 520));
  const shot3 = await win.webContents.capturePage({ x: 0, y: 0, width: 1500, height: 900 });
  fs.writeFileSync(path.join(OUT, 'settings-about.png'), shot3.toPNG());

  /* 7) 关闭「关于」（单按钮弹窗 → 只有一个可点的动作按钮） */
  const step7 = await win.webContents.executeJavaScript(`(() => {
    const c = document.querySelector('.vf-modal-card');
    const btns = c ? [...c.querySelectorAll('.vf-modal-acts .btn')] : [];
    if (c) c.querySelector('[data-act="ok"]').click();
    return { hadCard: !!c, count: btns.length, firstLabel: btns[0] ? btns[0].textContent : null };
  })()`);
  await new Promise((r) => setTimeout(r, 320));
  step7.closed = await win.webContents.executeJavaScript(`!document.querySelector('.vf-modal-card')`);
  console.log('S7 ' + JSON.stringify(step7));

  /* 8) 相框（**v1.11.0 起为正式功能**，默认开启）——
        ① 默认值：`defaults().showFrame === true`（转正的核心断言）；
        ② **显式关掉**后：分组只露「显示相框入口」一个开关、顶栏图标隐藏；
        ③ 再打开：五项回来（相册 / 间隔 / 填充方式 / 停靠边 / 开始）、图标出现、落盘；
        ④ 关掉：分组收回、图标重新隐藏；
        ⑤ 顺带保留 v1.8.0 的用例：相册下拉是**动态**的（跟着已加载文件夹走），
           来源被移除后旧值必须回落，不能留一个指向不存在文件夹的死选项。
        注意第一步是**显式置 false** 再重建面板 —— 不依赖"首次启动就是默认值"，
        探针的持久分区里可能留着上一轮跑出来的值。 */
  const step8 = await win.webContents.executeJavaScript(`(async () => {
    const p = document.getElementById('setPanel'), S = window.State;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const rowOf = (name) => [...p.querySelectorAll('.sp-row')]
      .find(r => r.querySelector('.sp-name') && r.querySelector('.sp-name').textContent === name);
    const fbtn = document.getElementById('frameBtn');
    const FRAME_NAMES = ['相框相册', '更换间隔', '填充方式', '窗口停靠边', '开始相框'];
    const namesOf = () => [...p.querySelectorAll('.sp-name')].map(e => e.textContent);
    const out = {};

    // 与面板开关**走同一条路径**：面板是两步 —— State.setSetting() 写入+落盘，
    // 再由 Settings.apply → App.applySetting() 让界面真的生效。只调第一步的话
    // 界面**不会变**（setSetting 的第三个参数是个回调，不传就什么都不触发），
    // 断言就会测到一个"没生效的界面"（v1.11.0 踩过：图标该藏却仍然可见）。
    const setShowFrame = (v) => { S.setSetting('showFrame', v); window.App.applySetting('showFrame', v); };

    // 确定性复位 + 从"关 → 开"走一次完整重建（toggle() 打开时必定 build()）
    setShowFrame(false);
    if (!p.hidden) { document.getElementById('setBtn').click(); await wait(140); }
    document.getElementById('setBtn').click();
    await wait(220);

    // ① 默认收起态：分组在、但只露一个开关；顶栏图标隐藏
    const titles = [...p.querySelectorAll('.sp-group-h')].map(e => e.textContent);
    out.frameGroupTitle = titles.filter(t => t.indexOf('相框') >= 0)[0] || null;
    out.hasFrameGroup = !!out.frameGroupTitle;
    out.rowsCollapsed = FRAME_NAMES.filter(n => namesOf().indexOf(n) >= 0);
    const swRow0 = rowOf('显示相框入口');
    out.switchRowPresent = !!(swRow0 && swRow0.querySelector('.sp-switch'));
    out.defaultShowFrame = window.State.defaults.showFrame;   // 转正：默认必须为 true
    out.settingAfterForceOff = S.settings.showFrame === false;
    out.iconHiddenAfterForceOff = !!fbtn && fbtn.hidden === true;

    // ② 打开开关 → 点击分支必须 rebuild（只 sync 的话这四项是不会出现的）
    if (swRow0) { swRow0.querySelector('.sp-switch').click(); await wait(260); }
    out.rowsAfterEnable = FRAME_NAMES.filter(n => namesOf().indexOf(n) >= 0);
    out.iconShownAfterEnable = !!fbtn && fbtn.hidden === false;
    out.settingAfterEnable = S.settings.showFrame;
    try { out.persistedShowFrame = JSON.parse(localStorage.getItem('viewfinder.settings.v1') || '{}').showFrame; }
    catch (e) { out.persistedShowFrame = null; }

    // 相册下拉 = 全部图片 / 只看收藏 + 每个已加载文件夹
    const rSel = rowOf('相框相册');
    const sel = rSel ? rSel.querySelector('select') : null;
    out.selectExists = !!sel;
    out.optionValues = sel ? [...sel.options].map(o => o.value) : [];
    out.optionTexts = sel ? [...sel.options].map(o => o.textContent) : [];
    out.hasAll = out.optionValues.indexOf('all') >= 0;
    out.hasFav = out.optionValues.indexOf('fav') >= 0;
    out.folderOpts = out.optionValues.filter(v => v === 's0' || v === 's1').length;
    out.folderNames = out.optionTexts.indexOf('Screenshots') >= 0 && out.optionTexts.indexOf('Camera Roll') >= 0;

    // v1.9.0：窗口停靠边（吸附到屏幕哪一条边）
    const rDock = rowOf('窗口停靠边');
    const dockSel = rDock ? rDock.querySelector('select') : null;
    out.dockRowExists = !!dockSel;
    out.dockOptionValues = dockSel ? [...dockSel.options].map(o => o.value) : [];
    out.dockOptionsOk = out.dockOptionValues.join(',') === 'none,left,right,top,bottom';
    out.dockDefaultNone = S.settings.frameDock === 'none';
    if (dockSel) {
      dockSel.value = 'right';
      dockSel.dispatchEvent(new Event('change', { bubbles: true }));
      out.dockAfterPick = S.settings.frameDock;
      try { out.dockPersisted = JSON.parse(localStorage.getItem('viewfinder.settings.v1') || '{}').frameDock; }
      catch (e) { out.dockPersisted = null; }
      // 复位，别把贴边状态留给后面的步骤
      dockSel.value = 'none';
      dockSel.dispatchEvent(new Event('change', { bubbles: true }));
      out.dockResetTo = S.settings.frameDock;
    }

    // 选中某个文件夹 → 落到设置并持久化
    if (sel) {
      sel.value = 's1';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      out.srcAfterPick = S.settings.frameSrc;
      try { out.persisted = JSON.parse(localStorage.getItem('viewfinder.settings.v1') || '{}').frameSrc; }
      catch (e) { out.persisted = null; }
    }

    // 把该文件夹移除 → 再打开面板必须重建下拉，且旧值回落到「全部图片」
    S.removeSource('s1');
    document.getElementById('setBtn').click();   // 收起
    document.getElementById('setBtn').click();   // 再打开 → 触发重建
    await wait(200);
    const rSel2 = rowOf('相框相册');
    const sel2 = rSel2 ? rSel2.querySelector('select') : null;
    out.optionsAfterRemove = sel2 ? [...sel2.options].map(o => o.value) : [];
    out.selectValueAfterRemove = sel2 ? sel2.value : null;
    out.srcAfterRemove = S.settings.frameSrc;

    // 间隔（秒 → 毫秒）
    const rMs = rowOf('更换间隔');
    const num = rMs ? rMs.querySelector('.sp-num') : null;
    out.msInput = num ? { min: num.min, max: num.max, step: num.step, value: num.value } : null;
    if (num) { num.value = '15'; num.dispatchEvent(new Event('change', { bubbles: true })); }
    out.msSet = S.settings.frameMs;

    // 填充方式
    const rFit = rowOf('填充方式');
    out.fitOptions = rFit ? [...rFit.querySelectorAll('.sp-seg button')].map(b => b.textContent) : [];
    if (rFit) { rFit.querySelector('.sp-seg button[data-val="cover"]').click(); }
    out.fitSet = S.settings.frameFit;

    // 「开始相框」按钮必须真的接线（v1.6.0 静默失效那个坑的同类防线）
    out.frameActionWired = typeof ((window.Settings.actions || {}).__frame) === 'function';
    out.frameKeyIsButton = (window.Settings.groups() || [])
      .reduce((a, g) => a.concat(g.rows || []), [])
      .some(d => d.key === '__frame' && d.type === 'button');

    /* 「恢复默认」的重放表：新增的有副作用的设置键必须登记进去，
       漏登记的后果是静默的（面板刷新了，那一项不生效）。这里只把表本身交出去，
       由 run_all.js 判定该包含哪些键。 */
    out.allKeys = (window.Settings && Array.isArray(window.Settings.ALL_KEYS))
      ? window.Settings.ALL_KEYS.slice() : null;

    /* 「面板每一行都必须登记进重放表」这条**通用不变量**的输入。
       为什么不能直接用当下可见的行：groups() 是**状态相关**的 ——
       相框组（相框相册 / 更换间隔 / 填充方式 / 窗口停靠边 / 输出屏幕）只在
       showFrame 开着时出现，「输出屏幕」还要 State.displays 多于一块屏。
       若按当下状态取键，条件行就漏了，断言退化成"抽样式覆盖"（= 又走回手工清单的老路）。
       所以这里把两个条件临时置真取一遍，取完**立刻还原**。
       按钮行（__ 前缀）不是设置项，不参与重放，排除。 */
    out.rowKeys = (() => {
      const savedShowFrame = S.settings.showFrame;
      const savedDisplays = S.displays;
      S.settings.showFrame = true;
      S.displays = [{ id: 1, label: '屏1' }, { id: 2, label: '屏2' }];
      const keys = (window.Settings.groups() || [])
        .reduce((a, g) => a.concat(g.rows || []), [])
        .map((d) => d.key)
        .filter((k) => String(k).indexOf('__') !== 0);
      S.settings.showFrame = savedShowFrame;
      S.displays = savedDisplays;
      return keys;
    })();

    // ③ 关掉开关 → 分组必须收回、图标重新隐藏
    const swRow2 = rowOf('显示相框入口');
    if (swRow2) { swRow2.querySelector('.sp-switch').click(); await wait(260); }
    out.rowsAfterDisable = FRAME_NAMES.filter(n => namesOf().indexOf(n) >= 0);
    out.iconHiddenAfterDisable = !!fbtn && fbtn.hidden === true;
    out.settingAfterDisable = S.settings.showFrame;

    // 收尾：还原设置，别把状态漏给后面的套件
    S.setSetting('frameSrc', 'all');
    S.setSetting('frameFit', 'contain');
    S.setSetting('frameMs', 6000);
    // 收尾必须还原成**默认值**而不是写死 false：写死的话下一个套件（顶栏布局）
    // 会读到这个残留值，把"相框入口默认可见"判成失败。用 defaults 取值，
    // 以后默认值再变也不用回来改这里。
    // 注意 State.defaults 是 **getter（返回对象）**，不是函数 —— 写成 defaults()
    // 会抛 "is not a function"，把整段 S8 断言静默带走（v1.11.0 踩过）。
    setShowFrame(S.defaults.showFrame);
    return out;
  })()`);
  console.log('S8 ' + JSON.stringify(step8));

  app.quit();
}

app.whenReady().then(run).catch((e) => { console.error('ERR', e && e.stack || e); app.quit(); });
