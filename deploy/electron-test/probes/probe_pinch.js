/* ============================================================
   双指缩放回归（P1-1）
   ------------------------------------------------------------
   覆盖两条真实输入路径：
   1) 触控板捏合 —— 浏览器合成为「带 ctrlKey 的 wheel 事件」；
   2) 触摸屏双指 —— 真实 TouchEvent 序列。
   并断言捏合中心为不动点（手指下的内容不滑动），以及在 nav 滚轮模式下
   捏合仍应缩放（手势语义优先于滚轮模式偏好）。

   只输出原始测量值，断言在 run_all.js 中统一执行。
   ============================================================ */
const { app, BrowserWindow, protocol } = require('electron');

/* 桌面集成通道桩：缺了它 App.init() 的托盘/快捷键设置重放会"假失败" —— 详见 _desktop_stub.js */
require('./_desktop_stub').stubDesktop();
const path = require('path'); const fs = require('fs');
const APPDIR = path.resolve(__dirname, '..', '..', '..');
const PICDIR = path.join(__dirname, '..', 'fixtures', '照片夹');

app.setPath('userData', path.resolve(__dirname, '..', 'logs', 'ud_pinch_' + Date.now()));
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

  const res = await w.webContents.executeJavaScript(`(async () => {
    const L = window.Lightbox, im = document.getElementById('lbImg'), stage = document.getElementById('lbStage');
    const R = {};

    function quiet() {
      im.classList.remove('anim');
      if (im.style.transition !== 'none') im.style.transition = 'none';
      void im.offsetWidth;
    }
    function rect() { quiet(); return im.getBoundingClientRect(); }
    /** 等当前图真正解码完成。
        切图（nav）本身是异步的：src 换掉之后要等一帧才拿得到尺寸。
        以前这几步是同步连跑，靠「新图恰好已经就绪」侥幸通过 —— 那是竞态，
        任何让加载时序稍有变化的改动都会让它变红。这里显式等，并把它记为断言前提。 */
    async function waitLoaded(ms) {
      const t0 = Date.now();
      while (Date.now() - t0 < (ms || 4000)) {
        if (im.complete && im.naturalWidth > 0 && L.nw === im.naturalWidth) return true;
        await new Promise((r) => setTimeout(r, 40));
      }
      return false;
    }
    // 归一化「内容坐标」——与整体缩放无关，可判定不动点
    function normAt(px, py) { const r = rect(); return { u: (px - r.left) / r.width, v: (py - r.top) / r.height, w: r.width, h: r.height }; }
    function snapState() { return { scale: +L.scale.toFixed(5), base: +L.base.toFixed(5), tx: +L.tx.toFixed(2), ty: +L.ty.toFixed(2), rot: L.rot }; }
    function centerDev() { const r = rect(), g = L._stageGeom(); return { dx: +((r.left + r.width / 2) - (g.x + L.tx)).toFixed(3), dy: +((r.top + r.height / 2) - (g.y + L.ty)).toFixed(3) }; }

    // ---- 触摸事件构造 ----
    function mkTouch(id, x, y) {
      return new Touch({ identifier: id, target: stage, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y, radiusX: 5, radiusY: 5, force: 1 });
    }
    function fire(type, pts) {
      const touches = pts.map((p, i) => mkTouch(i + 1, p.x, p.y));
      stage.dispatchEvent(new TouchEvent(type, { touches: touches, targetTouches: touches, changedTouches: touches, bubbles: true, cancelable: true }));
    }
    function wheel(deltaY, x, y, ctrl) {
      stage.dispatchEvent(new WheelEvent('wheel', { deltaY: deltaY, deltaMode: 0, clientX: x, clientY: y, ctrlKey: !!ctrl, bubbles: true, cancelable: true }));
    }

    const W = window.innerWidth, H = window.innerHeight;
    const mid = { x: W * 0.5, y: H * 0.5 };

    /* ---------- 1. 触控板捏合：ctrlKey wheel 应缩放 ---------- */
    L.rot = 0; L.fit(false); L.wheelMode = 'zoom'; L._setWheelUI();
    {
      const before = snapState();
      wheel(-120, W * 0.68, H * 0.62, true);   // deltaY<0 = 捏合放大
      const afterIn = snapState();
      wheel(240, W * 0.68, H * 0.62, true);    // deltaY>0 = 捏合缩小
      const afterOut = snapState();
      R.ctrlWheel = { before: before, afterIn: afterIn, afterOut: afterOut, centerDev: centerDev() };
    }

    /* ---------- 2. 捏合中心为不动点 ---------- */
    // 先放大到足够大，使随后的捏合不会触发「防露白」夹取 —— 否则夹取会合法地
    // 打断不动点，测出来的是夹取量而不是公式误差。
    L.rot = 0; L.fit(false); L.zoomAt(5, mid.x, mid.y);
    {
      const px = W * 0.72, py = H * 0.34;
      const b = normAt(px, py);
      wheel(-60, px, py, true);
      const a = normAt(px, py);
      R.ctrlWheelFocal = {
        du: +(a.u - b.u).toFixed(6), dv: +(a.v - b.v).toFixed(6),
        px: +Math.abs(a.u - b.u) * a.w, py: +Math.abs(a.v - b.v) * a.h,
        scale: +L.scale.toFixed(4),
      };
    }

    /* ---------- 3. ctrlKey wheel 在 nav 模式下仍应缩放（不被劫持） ---------- */
    L.rot = 0; L.fit(false);
    {
      L.wheelMode = 'nav'; L._setWheelUI();
      const idxBefore = L.i;
      const before = snapState();
      wheel(-120, mid.x, mid.y, true);
      const after = snapState();
      R.pinchVsNavMode = { mode: L.wheelMode, beforeScale: before.scale, afterScale: after.scale, idxBefore: idxBefore, idxAfter: L.i, navUnchanged: idxBefore === L.i };
      // 普通滚轮在 nav 模式下仍应切换图片（回归）
      const idx2 = L.i;
      wheel(120, mid.x, mid.y, false);
      R.navWheelStillWorks = { idxBefore: idx2, idxAfter: L.i, navigated: idx2 !== L.i };
      L.wheelMode = 'zoom'; L._setWheelUI();
    }
    // 上一步切到了新图片 → 必须等它解码完成再继续测量几何
    const loadedAfterNav = await waitLoaded(6000);

    /* ---------- 4. 触摸屏双指：指距拉大 → 放大；捏小 → 缩小 ---------- */
    // 真实触摸会以大量小步进上报，故按步进模拟；单次事件内部还有防跳变夹取（0.5~2）。
    L.rot = 0; L.fit(false);
    {
      const c = { x: W * 0.5, y: H * 0.5 };
      const r0 = 100, r1 = 200, r2 = 60;      // 指距半径：200 → 400 → 120
      const at = (r) => [{ x: c.x - r, y: c.y }, { x: c.x + r, y: c.y }];
      const steps = (from, to, n) => {
        for (let k = 1; k <= n; k++) fire('touchmove', at(from + (to - from) * k / n));
      };
      fire('touchstart', [at(r0)[0]]);
      const s0 = snapState();
      fire('touchstart', at(r0));
      steps(r0, r1, 8);
      const s1 = snapState();
      steps(r1, r2, 8);
      const s2 = snapState();
      fire('touchend', []);
      R.touchPinch = {
        start: s0, afterSpread: s1, afterPinch: s2,
        spreadRatio: +(s1.scale / s0.scale).toFixed(4),
        expectedSpread: +(r1 / r0).toFixed(4),
        pinchRatio: +(s2.scale / s1.scale).toFixed(4),
        expectedPinch: +(r2 / r1).toFixed(4),
        centerDev: centerDev(),
        // 断言前提：这一轮测的必须是一张「已解码、有尺寸」的图
        loaded: loadedAfterNav,
        naturalW: im.naturalWidth, lw: L.nw, complete: im.complete,
      };
    }

    /* ---------- 5. 双指中点是不动点 ---------- */
    L.rot = 0; L.fit(false);
    {
      const c = { x: W * 0.3, y: H * 0.3 };
      const p1 = { x: c.x - 80, y: c.y }, p2 = { x: c.x + 80, y: c.y };
      const q1 = { x: c.x - 160, y: c.y }, q2 = { x: c.x + 160, y: c.y };
      const before = normAt(c.x, c.y);
      fire('touchstart', [p1, p2]);
      fire('touchmove', [q1, q2]);
      const after = normAt(c.x, c.y);
      fire('touchend', []);
      R.touchFocal = { du: +(after.u - before.u).toFixed(6), dv: +(after.v - before.v).toFixed(6),
        px: +Math.abs(after.u - before.u) * after.w, py: +Math.abs(after.v - before.v) * after.h };
    }

    /* ---------- 6. 双指落下应中止进行中的单指拖动 ---------- */
    L.rot = 0; L.fit(false); L.zoomAt(2.5, mid.x, mid.y);
    {
      const sx = mid.x, sy = mid.y;
      stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: sx, clientY: sy, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, clientX: sx + 60, clientY: sy + 40, pointerId: 1 }));
      const draggingMid = L.dragging;
      const t0 = { tx: L.tx, ty: L.ty };
      fire('touchstart', [{ x: sx - 100, y: sy }, { x: sx + 100, y: sy }]);
      const draggingAfter = L.dragging;
      // 缩放期间即便有 pointermove 也不该平移
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, clientX: sx + 300, clientY: sy + 300, pointerId: 1 }));
      const movedDuringPinch = { dx: +(L.tx - t0.tx).toFixed(1), dy: +(L.ty - t0.ty).toFixed(1), dragging: L.dragging };
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: sx + 300, clientY: sy + 300, pointerId: 1 }));
      fire('touchend', []);
      R.pinchCancelsDrag = { draggingMid: draggingMid, draggingAfterTouch: draggingAfter, movedDuringPinch: movedDuringPinch };
    }

    /* ---------- 7. 单指拖动仍然可用（回归） ---------- */
    L.rot = 0; L.fit(false); L.zoomAt(2.5, mid.x, mid.y); L.tx = 0; L.ty = 0; L._clampPan(); L.apply();
    {
      const t0 = { tx: L.tx, ty: L.ty };
      stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: mid.x, clientY: mid.y, pointerId: 9 }));
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, clientX: mid.x - 90, clientY: mid.y - 70, pointerId: 9 }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: mid.x - 90, clientY: mid.y - 70, pointerId: 9 }));
      R.singleDragStillWorks = { dx: +(L.tx - t0.tx).toFixed(1), dy: +(L.ty - t0.ty).toFixed(1) };
    }

    /* ---------- 8. 缩放上下限仍被遵守 ---------- */
    L.rot = 0; L.fit(false);
    {
      for (let k = 0; k < 80; k++) wheel(-120, mid.x, mid.y, true);
      const hi = +L.scale.toFixed(4);
      for (let k = 0; k < 200; k++) wheel(120, mid.x, mid.y, true);
      const lo = +L.scale.toFixed(4);
      R.clamped = { max: hi, min: lo, minAllowed: +(L.base * 0.25).toFixed(4), maxAllowed: 14 };
    }

    return R;
  })()`);

  console.log('PINCH ' + JSON.stringify(res, null, 1));
  app.quit();
});
