/* ============================================================
   三路径联合回归：缩放 × 旋转 × 平移
   ------------------------------------------------------------
   为什么必须联合测（v1.5.0 的教训）：
   v1.4.0→1.4.1→1.4.2 连续三版「修好一条碰坏另一条」，根因是
   缩放/旋转/平移共用同一条 CSS transform 链，单测一条无法发现
   对另外两条的破坏。本探针把三者放在同一个序列里交叉验证，
   并额外断言「不动点缩放」——即光标下的内容坐标保持不变，
   这是 v1.4.x 的隐藏缺陷（只有 t≠0 时才暴露）。

   只输出原始测量值，断言逻辑在 run_all.js 中统一执行。
   ============================================================ */
const { app, BrowserWindow, protocol } = require('electron');

/* 桌面集成通道桩：缺了它 App.init() 的托盘/快捷键设置重放会"假失败" —— 详见 _desktop_stub.js */
require('./_desktop_stub').stubDesktop();
const path = require('path'); const fs = require('fs');
const APPDIR = path.resolve(__dirname, '..', '..', '..');
const PICDIR = path.join(__dirname, '..', 'fixtures', '照片夹');

app.setPath('userData', path.resolve(__dirname, '..', 'logs', 'ud_tf_' + Date.now()));
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
protocol.registerSchemesAsPrivileged([{ scheme: 'vf', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true } }]);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' };
function collect(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const abs = path.join(dir, f); const st = fs.statSync(abs);
    if (st.isDirectory()) out.push(...collect(abs));
    else if (/\.(png|jpe?g|gif|webp)$/i.test(f)) out.push({ abs, size: st.size, mtime: st.mtimeMs });
  }
  return out;
}

app.whenReady().then(async () => {
  protocol.handle('vf', async (req) => {
    const u = new URL(req.url);
    if (u.host === 'pic') {
      const abs = Buffer.from(decodeURIComponent(u.pathname).replace(/^\/+/, ''), 'base64url').toString('utf8');
      try { const b = await fs.promises.readFile(abs); return new Response(b, { headers: { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'access-control-allow-origin': 'vf://app' } }); }
      catch (e) { return new Response('404', { status: 404 }); }
    }
    const abs = path.resolve(APPDIR, decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html');
    try { const b = await fs.promises.readFile(abs); return new Response(b, { headers: { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'access-control-allow-origin': 'vf://app' } }); }
    catch (e) { return new Response('404', { status: 404 }); }
  });

  const w = new BrowserWindow({ width: 1440, height: 900, show: true,
    webPreferences: { preload: path.join(APPDIR, 'deploy', 'electron', 'preload.js'), contextIsolation: true } });
  await w.loadURL('vf://app/index.html');
  await new Promise((r) => setTimeout(r, 900));

  const files = collect(PICDIR);
  await w.webContents.executeJavaScript(`(() => {
    const S = window.State, A = window.App;
    S.sources = [{ id: 's0', name: '照片夹', root: 'C:/x' }];
    S.items = ${JSON.stringify(files.map((f, i) => ({ id: 'r' + i, name: path.basename(f.abs), src: 'all', sid: 's0', size: f.size, path: f.abs, ext: 'png', lastModified: f.mtime, state: 'idle' })))};
    S.sourceCount = () => S.items.length;
    A.showGallery(); A.renderSources(); document.getElementById('topbar').hidden = false;
    return S.items.length;
  })()`);
  await new Promise((r) => setTimeout(r, 2300));
  await w.webContents.executeJavaScript(`(() => { [...document.querySelectorAll('.tile.g')][0].dispatchEvent(new MouseEvent('click',{bubbles:true})); return true; })()`);
  await new Promise((r) => setTimeout(r, 1800));

  const res = await w.webContents.executeJavaScript(`(() => {
    const L = window.Lightbox, T = window.Transform;
    const im = document.getElementById('lbImg'), stage = document.getElementById('lbStage');
    const R = { steps: {}, invariants: {} };

    function geom() {
      quiet();
      const r = im.getBoundingClientRect();
      return { l: r.left, t: r.top, w: r.width, h: r.height,
        cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    }
    // 关键：测量前必须掐掉 CSS 过渡。
    // rotate()/fit(true) 会加 .anim 触发 transform 过渡（0.2s），
    // 同步测量拿到的是过渡中间值 → 会把「几何正确」误判为「跑偏」。
    function quiet() {
      im.classList.remove('anim');
      if (im.style.transition !== 'none') im.style.transition = 'none';
      void im.offsetWidth;   // 强制回流，让 transform 立即生效
    }
    function stageC() { const g = L._stageGeom(); return { x: g.x, y: g.y }; }
    // 显示中心相对「舞台中心 + 平移量」的偏差（应恒为 0）
    function centerDev() {
      const g = geom(), c = stageC();
      return { dx: +(g.cx - (c.x + L.tx)).toFixed(3), dy: +(g.cy - (c.y + L.ty)).toFixed(3) };
    }
    // 光标处的「内容坐标」(归一化 0..1)，与整体缩放无关 → 可用于判定不动点
    function normAt(px, py) {
      const g = geom();
      return { u: (px - g.l) / g.w, v: (py - g.t) / g.h, size: { w: g.w, h: g.h } };
    }
    function snap(label, extra) {
      const o = { label, rot: L.rot, scale: +L.scale.toFixed(5), tx: +L.tx.toFixed(2), ty: +L.ty.toFixed(2),
        centerDev: centerDev(), rect: (function(){ const g = geom(); return { w: +g.w.toFixed(1), h: +g.h.toFixed(1) }; })() };
      if (extra) Object.assign(o, extra);
      R.steps[label] = o; return o;
    }
    /**
     * 不动点漂移：在 (px,py) 处缩放，返回光标下内容坐标的偏移。
     * 同时报告 clamped：若平移夹取（防止露白）介入，公式的「不动点」会被合法地打断，
     * 此时漂移是预期行为，断言须跳过 —— 否则会把正常夹取误判为缺陷。
     */
    function focalDrift(px, py, factor) {
      const st = { scale: L.scale, tx: L.tx, ty: L.ty };
      const c = stageC();
      const raw = T.zoomAt(st, { f: factor, cx: px, cy: py, stageCx: c.x, stageCy: c.y, min: L.base * 0.25, max: 14 });
      const before = normAt(px, py);
      L.zoomAt(factor, px, py);
      const after = normAt(px, py);
      const clamped = Math.abs(raw.tx - L.tx) > 1e-6 || Math.abs(raw.ty - L.ty) > 1e-6;
      return {
        du: +(after.u - before.u).toFixed(6),
        dv: +(after.v - before.v).toFixed(6),
        px: +Math.abs(after.u - before.u) * after.size.w,
        py: +Math.abs(after.v - before.v) * after.size.h,
        clamped: clamped,
        rawT: { tx: +raw.tx.toFixed(2), ty: +raw.ty.toFixed(2) },
        gotT: { tx: +L.tx.toFixed(2), ty: +L.ty.toFixed(2) },
      };
    }
    // 模拟拖拽
    function drag(dx, dy, id) {
      const pid = id || 1;
      const sx = window.innerWidth / 2, sy = window.innerHeight / 2;
      stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: sx, clientY: sy, pointerId: pid }));
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, clientX: sx + dx, clientY: sy + dy, pointerId: pid }));
      const grabbing = stage.classList.contains('grabbing');
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: sx + dx, clientY: sy + dy, pointerId: pid }));
      return { grabbing, released: !stage.classList.contains('grabbing') };
    }

    /* ---------- A：适应态 ---------- */
    L.rot = 0; L.fit(false);
    snap('A1 fit');

    /* ---------- B：不动点缩放（光标偏离中心，t=0）---------- */
    {
      const px = window.innerWidth * 0.78, py = window.innerHeight * 0.72;
      const d1 = focalDrift(px, py, 2.0);
      const d2 = focalDrift(px, py, 1.6);
      snap('B1 zoom@offcenter', { drift1: d1, drift2: d2 });
    }

    /* ---------- C：先平移，再在偏离中心处缩放（旧公式在此漂移）---------- */
    {
      // 放大到足够大且平移量远小于上限 → 缩放不会触发夹取，能纯粹检验不动点公式
      L.rot = 0; L.fit(false); L.zoomAt(6, stageC().x, stageC().y);
      L.tx = -100; L.ty = 60; L._clampPan(); L.apply();
      const before = { tx: L.tx, ty: L.ty, dev: centerDev() };
      const px = stageC().x + 180, py = stageC().y - 120;
      const d = focalDrift(px, py, 1.15);
      snap('C1 zoom@panned-offcenter', { panBefore: before, drift: d, panAfter: { tx: +L.tx.toFixed(2), ty: +L.ty.toFixed(2) } });
      const d2 = focalDrift(px, py, 1 / 1.3);
      snap('C2 zoomout@panned-offcenter', { drift: d2 });
    }

    /* ---------- C3：夹取介入时，结果必须等于「夹取后的解析解」---------- */
    {
      L.rot = 0; L.fit(false); L.zoomAt(1.6, stageC().x, stageC().y);
      L.tx = 0; L.ty = 0; L.apply();
      const px = stageC().x + 480, py = stageC().y + 320;
      const d = focalDrift(px, py, 2.4);   // 该场景会露白 → 夹取必然介入
      const g = L._stageGeom();
      const box = T.displayBox({ baseW: im.offsetWidth, baseH: im.offsetHeight, scale: L.scale, rot: L.rot, tx: L.tx, ty: L.ty, stageCx: g.x, stageCy: g.y });
      snap('C3 clamp-exact', {
        drift: d,
        clampLimit: { x: +Math.max(0, (box.w - g.w) / 2).toFixed(2), y: +Math.max(0, (box.h - g.h) / 2).toFixed(2) },
        // 大图不得露白：夹取后左边缘不得进入舞台内侧
        noWhiteGap: { left: +(box.l - (g.x - g.w / 2)).toFixed(2), top: +(box.t - (g.y - g.h / 2)).toFixed(2) },
      });
    }

    /* ---------- D：缩放态下旋转 4 个角度 ---------- */
    {
      L.rot = 0; L.fit(false); L.zoomAt(2.6, stageC().x, stageC().y);
      const out = [];
      for (let k = 0; k < 4; k++) { L.rotate(1); out.push({ rot: L.rot, dev: centerDev() }); }
      snap('D1 rotate@zoomed', { each: out });
    }

    /* ---------- E：平移态下旋转（平移量应被 fit 复位，且保持居中）---------- */
    {
      L.rot = 0; L.fit(false); L.zoomAt(2.5, stageC().x, stageC().y);
      L.tx = -200; L.ty = 130; L._clampPan(); L.apply();
      const before = { tx: L.tx, ty: L.ty };
      L.rotate(1);
      snap('E1 rotate@panned', { panBefore: before, panAfter: { tx: L.tx, ty: L.ty }, dev: centerDev() });
    }

    /* ---------- F：缩到装得下 → 保留位置但受边界约束，不会被甩出视野 ---------- */
    {
      L.rot = 0; L.fit(false); L.zoomAt(3.2, stageC().x, stageC().y);
      L.tx = 300; L.ty = 200; L._clampPan(); L.apply();
      const big = { dev: centerDev(), limit: (function () { const g = L._stageGeom(); const b = T.displayBox({ baseW: im.offsetWidth, baseH: im.offsetHeight, scale: L.scale, rot: L.rot, tx: 0, ty: 0, stageCx: g.x, stageCy: g.y }); return { x: Math.max(0, (b.w - g.w) / 2), y: Math.max(0, (b.h - g.h) / 2) }; })() };
      for (let k = 0; k < 6; k++) L.zoomAt(1 / 1.5, stageC().x + 300, stageC().y + 200);
      const g2 = L._stageGeom();
      const s = snap('F1 shrink-bounded', { whileBig: big, fitsNow: !L._canPan() });
      // 缩到装得下后：平移量应被夹在「自由上限」内，而不是无限漂移
      const freeLimit = window.innerHeight * 0.5;
      R.invariants.shrinkBounded = {
        withinFreeLimit: Math.abs(L.tx) <= freeLimit + 0.6 && Math.abs(L.ty) <= freeLimit + 0.6,
        freeLimit: +freeLimit.toFixed(2),
        tx: +L.tx.toFixed(2), ty: +L.ty.toFixed(2),
        stage: { w: g2.w, h: g2.h },
      };
    }

    /* ---------- G：大图四方向拖动 + 极限贴边 ---------- */
    {
      L.rot = 0; L.fit(false); L.zoomAt(4.0, stageC().x, stageC().y);
      L.tx = 0; L.ty = 0; L.apply();
      const dirs = [];
      for (const [dx, dy, name] of [[0, -120, 'up'], [0, 120, 'down'], [-160, 0, 'left'], [160, 0, 'right']]) {
        const t0 = { tx: L.tx, ty: L.ty };
        const g = drag(dx, dy, 20 + dirs.length);
        dirs.push({ dir: name, moved: { dx: +(L.tx - t0.tx).toFixed(1), dy: +(L.ty - t0.ty).toFixed(1) }, grabbed: g.grabbing, released: g.released });
      }
      // 拖到远超上限：应精确贴边（不露白）
      L.tx = 0; L.ty = 0; L.apply();
      drag(99999, 99999, 40);
      const r = im.getBoundingClientRect();
      const sg = L._stageGeom();
      const box = T.displayBox({ baseW: im.offsetWidth, baseH: im.offsetHeight, scale: L.scale, rot: L.rot, tx: L.tx, ty: L.ty, stageCx: sg.x, stageCy: sg.y });
      snap('G1 big-pan-4dir', { dirs, edgeGap: { left: +(box.l - (sg.x - sg.w / 2)).toFixed(2), top: +(box.t - (sg.y - sg.h / 2)).toFixed(2) }, rect: { w: +r.width.toFixed(0), h: +r.height.toFixed(0) } });
    }

    /* ---------- H：小图（远小于舞台）仍可拖动 ---------- */
    {
      L.rot = 0; L.fit(false);
      L.scale = L.base * 0.35; L.tx = 0; L.ty = 0; L.apply();
      const canPanSmall = L._canPan();
      const t0 = { tx: L.tx, ty: L.ty };
      const g = drag(120, 80, 60);
      snap('H1 small-pan', { canPanSmall, moved: { dx: +(L.tx - t0.tx).toFixed(1), dy: +(L.ty - t0.ty).toFixed(1) }, grabbed: g.grabbing,
        dev: centerDev(), rect: (function(){ const q = geom(); return { w: +q.w.toFixed(0), h: +q.h.toFixed(0) }; })() });
    }

    /* ---------- I：连续混合序列（缩放→平移→旋转→缩放→平移）---------- */
    {
      L.rot = 0; L.fit(false);
      const seq = [];
      const step = (name, fn) => { fn(); seq.push({ step: name, rot: L.rot, scale: +L.scale.toFixed(3), dev: centerDev() }); };
      step('fit', () => L.fit(false));
      step('zoom@off', () => L.zoomAt(2.2, stageC().x + 210, stageC().y + 140));
      step('pan', () => { L.tx = -160; L.ty = 110; L._clampPan(); L.apply(); });
      step('rotate', () => L.rotate(1));
      step('zoom@center', () => L.zoomAt(1.8, stageC().x, stageC().y));
      step('pan2', () => { L.tx = 240; L.ty = -170; L._clampPan(); L.apply(); });
      step('rotate2', () => L.rotate(1));
      step('refit', () => L.fit(false));
      snap('I1 mixed-sequence', { seq });
    }

    /* ---------- J：精确校验「显示中心 = 舞台中心 + t」的公式自洽 ---------- */
    {
      const g = geom(), c = stageC();
      const sg = L._stageGeom();
      const box = T.displayBox({ baseW: im.offsetWidth, baseH: im.offsetHeight, scale: L.scale, rot: L.rot, tx: L.tx, ty: L.ty, stageCx: sg.x, stageCy: sg.y });
      R.invariants.stageVsViewport = { stageW: sg.w, stageH: sg.h, vw: window.innerWidth, vh: window.innerHeight };
      R.invariants.lastBox = { w: +box.w.toFixed(2), h: +box.h.toFixed(2), cx: +box.cx.toFixed(2), cy: +box.cy.toFixed(2) };
      R.invariants.lastRect = { w: +g.w.toFixed(2), h: +g.h.toFixed(2), cx: +g.cx.toFixed(2), cy: +g.cy.toFixed(2) };
    }

    return R;
  })()`);

  console.log('TF ' + JSON.stringify(res, null, 1));
  app.quit();
});
