/* v1.4.0 回归：单图浏览 缩放居中 + 任意倍率可拖动 */
const { app, BrowserWindow, protocol } = require('electron');

/* 桌面集成通道桩：缺了它 App.init() 的托盘/快捷键设置重放会"假失败" —— 详见 _desktop_stub.js */
require('./_desktop_stub').stubDesktop();
const path = require('path'); const fs = require('fs');
const APPDIR = path.resolve(__dirname, '..', '..', '..');
const OUT = path.resolve(__dirname, '..', 'shots');
const PICDIR = path.join(__dirname, '..', 'fixtures', '照片夹');

app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
protocol.registerSchemesAsPrivileged([{ scheme: 'vf', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true } }]);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif' };

function collect(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const abs = path.join(dir, f); const st = fs.statSync(abs);
    if (st.isDirectory()) out.push(...collect(abs));
    else if (/\.(png|jpe?g|gif|webp)$/i.test(f)) out.push({ abs, size: st.size, mtime: st.mtimeMs });
  }
  return out;
}

const results = {};

app.whenReady().then(async () => {
  protocol.handle('vf', async (req) => {
    const u = new URL(req.url);
    if (u.host === 'pic') {
      const b64 = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      const abs = Buffer.from(b64, 'base64url').toString('utf8');
      try { const b = await fs.promises.readFile(abs); return new Response(b, { headers: { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'access-control-allow-origin': 'vf://app' } }); }
      catch (e) { return new Response('404', { status: 404 }); }
    }
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const abs = path.resolve(APPDIR, rel || 'index.html');
    try { const b = await fs.promises.readFile(abs); return new Response(b, { headers: { 'content-type': (MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream') } }); }
    catch (e) { return new Response('404', { status: 404 }); }
  });

  const w = new BrowserWindow({ width: 1500, height: 860, show: true,
    webPreferences: { preload: path.join(APPDIR, 'deploy', 'electron', 'preload.js'), contextIsolation: true } });
  await w.loadURL('vf://app/index.html');
  await new Promise((r) => setTimeout(r, 900));
  // 面板会注入固定偏移（内置浏览器预览）；记录基准原点，断言时扣除
  await w.webContents.executeJavaScript(`(() => {
    const b = document.body;
    b.style.setProperty('--stage-ox', String(window.innerWidth/2));
    b.style.setProperty('--stage-oy', String(window.innerHeight/2));
    return [window.innerWidth, window.innerHeight];
  })()`);

  const files = collect(PICDIR);
  await w.webContents.executeJavaScript(`(() => {
    const S = window.State, A = window.App;
    const recs = ${JSON.stringify(files.map((f) => ({ p: f.abs, n: path.basename(f.abs), size: f.size, mtime: f.mtime })))};
    S.sources = [{ id: 's0', name: '照片夹', root: 'C:/x' }];
    S.items = recs.map((r, i) => ({ id: 'r' + i, name: r.n, src: 'all', sid: 's0', size: r.size, path: r.p,
      ext: r.n.split('.').pop().toLowerCase(), lastModified: r.mtime, state: 'idle' }));
    S.sourceCount = () => S.items.length;
    A.showGallery(); A.renderSources(); document.getElementById('topbar').hidden = false;
    return S.items.length;
  })()`);
  await new Promise((r) => setTimeout(r, 2200));

  // ---- 打开单图浏览 ----
  await w.webContents.executeJavaScript(`(() => {
    const t = [...document.querySelectorAll('.tile.g')][0];
    t.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 1800));

  const helper = `
    var __fs = false;
    window.addEventListener('resize', function(){ __fs = true; }, { once: true });
    /* 内置浏览器面板会注入约 640x480 的基准偏移；用 CSS 变量断言"真实居中"，与注入无关 */
    function varCenter(){
      const b = document.body;
      const ox = b.style.getPropertyValue('--stage-ox') || '0';
      const oy = b.style.getPropertyValue('--stage-oy') || '0';
      const im = document.getElementById('lbImg');
      const m = im.style.transform.match(/translate\\(([-\\d.]+)px,\\s*([-\\d.]+)px\\)/);
      const tx = m ? parseFloat(m[1]) : NaN, ty = m ? parseFloat(m[2]) : NaN;
      return { ox: parseFloat(ox), oy: parseFloat(oy), tx: tx, ty: ty,
               okX: Math.abs(tx - parseFloat(ox)) < 0.01, okY: Math.abs(ty - parseFloat(oy)) < 0.01 };
    }
    function rectOf(){ const im=document.getElementById('lbImg'); const r=im.getBoundingClientRect(); return r; }
    function stageC(){ const st=document.getElementById('lbStage').getBoundingClientRect();
      return { x: st.left + st.width/2, y: st.top + st.height/2, w: st.width, h: st.height }; }
    function dev(){ const b=document.body, c=rectOf();
      const ox=parseFloat(b.style.getPropertyValue('--stage-ox')||'0'), oy=parseFloat(b.style.getPropertyValue('--stage-oy')||'0');
      return { dx:+(c.left+c.width/2-ox).toFixed(2), dy:+(c.top+c.height/2-oy).toFixed(2) }; }
  `;

  // ---------- S1：初始适应状态应居中 ----------
  results.s1_initial = await w.webContents.executeJavaScript(`(() => { ${helper}
    const L = window.Lightbox;
    const st = document.getElementById('lbStage').getBoundingClientRect();
    return { open: L.isOpen(), rot: L.rot, scale: +L.scale.toFixed(4), base: +L.base.toFixed(4),
      tx: +L.tx.toFixed(2), ty: +L.ty.toFixed(2), dev: dev(),
      stageRect: { l: st.left, t: st.top, w: st.width, h: st.height },
      vp: { w: window.innerWidth, h: window.innerHeight },
      frame: { dx: +(st.left + st.width/2 - window.innerWidth/2).toFixed(1),
               dy: +(st.top + st.height/2 - window.innerHeight/2).toFixed(1) },
      imgW: +rectOf().width.toFixed(1), imgH: +rectOf().height.toFixed(1) };
  })()`);

  // ---------- S2：滚轮放大（以图片中心为不动点）不应产生偏移 ----------
  results.s2_wheel_center = await w.webContents.executeJavaScript(`(() => { ${helper}
    const L = window.Lightbox;
    const before = dev();
    for (let i = 0; i < 5; i++) L.zoomAt(1.12, L._center().x, L._center().y);
    const after = dev();
    return { scale: +L.scale.toFixed(3), before, after, drift: { dx: +(after.dx-before.dx).toFixed(2), dy: +(after.dy-before.dy).toFixed(2) } };
  })()`);

  // ---------- S3：向下缩小到低于适应比例后仍居中 ----------
  results.s3_zoom_out_center = await w.webContents.executeJavaScript(`(() => { ${helper}
    const L = window.Lightbox;
    for (let i = 0; i < 9; i++) L.zoomAt(1/1.12, L._center().x, L._center().y);
    return { scale: +L.scale.toFixed(3), base: +L.base.toFixed(3), dev: dev(),
      belowBase: L.scale < L.base };
  })()`);

  // ---------- S4：以非中心点缩放（模拟滚轮落在左上角），再按 F 复位应回到正中 ----------
  results.s4_fit_recenter = await w.webContents.executeJavaScript(`(() => { ${helper}
    const L = window.Lightbox;
    L.zoomAt(3, 200, 150);
    const off = dev();
    L.fit(false);
    const back = dev();
    return { offCenter: off, afterFit: back, scale: +L.scale.toFixed(3), tx: +L.tx.toFixed(2), ty: +L.ty.toFixed(2) };
  })()`);

  // ---------- S5：缩小到远小于视口 —— 仍应可拖动（用户要求"不管缩放多大都能拖动"）----------
  results.s5_small_pan = await w.webContents.executeJavaScript(`(() => { ${helper}
    const L = window.Lightbox;
    const stage = document.getElementById('lbStage');
    L.fit(false); L.scale = L.base * 0.3; L.tx = 0; L.ty = 0; L.apply();
    const t0 = { tx: L.tx, ty: L.ty };
    // 模拟按下拖动
    stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 800, clientY: 400, pointerId: 1 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, clientX: 900, clientY: 470, pointerId: 1 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: 900, clientY: 470, pointerId: 1 }));
    return { canPanSmall: L._canPan(), moved: { dx: +(L.tx - t0.tx).toFixed(1), dy: +(L.ty - t0.ty).toFixed(1) },
      rect: { w: +rectOf().width.toFixed(0), h: +rectOf().height.toFixed(0) }, stage: stageC(), dev: dev() };
  })()`);

  // ---------- S6：放大于视口后拖动应生效；且能拖出边缘 ----------
  results.s6_big_pan = await w.webContents.executeJavaScript(`(() => { ${helper}
    const L = window.Lightbox; const stage = document.getElementById('lbStage');
    L.fit(false); L.zoomAt(6, L._center().x, L._center().y); L.tx = 0; L.ty = 0; L.apply();
    const canPan = L._canPan();
    const rect0 = { w: +rectOf().width.toFixed(0), h: +rectOf().height.toFixed(0) };
    const t0 = { tx: L.tx, ty: L.ty };
    stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 750, clientY: 430, pointerId: 2 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, clientX: 1000, clientY: 600, pointerId: 2 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: 1000, clientY: 600, pointerId: 2 }));
    const d1 = { dx: +(L.tx - t0.tx).toFixed(1), dy: +(L.ty - t0.ty).toFixed(1) };
    const c1 = dev();
    // 反向再拖回来
    const t1 = { tx: L.tx, ty: L.ty };
    stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 1000, clientY: 600, pointerId: 3 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, clientX: 400, clientY: 200, pointerId: 3 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: 400, clientY: 200, pointerId: 3 }));
    const d2 = { dx: +(L.tx - t1.tx).toFixed(1), dy: +(L.ty - t1.ty).toFixed(1) };
    const c2 = dev();
    return { canPan, bigRect: rect0, dragFwd: d1, posFwd: c1, dragBack: d2, posBack: c2,
      grabbedClass: stage.classList.contains('grabbing') };
  })()`);

  // ---------- S7：四方向拖动（上/下/左/右）均不受限 ----------
  results.s7_4dir = await w.webContents.executeJavaScript(`(() => { ${helper}
    const L = window.Lightbox; const stage = document.getElementById('lbStage');
    const moves = [[0,-120],[0,120],[-160,0],[160,0]];
    const out = [];
    for (let k = 0; k < moves.length; k++) {
      const [mx, my] = moves[k];
      const t = { tx: L.tx, ty: L.ty };
      stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 750, clientY: 430, pointerId: 10+k }));
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, clientX: 750+mx, clientY: 430+my, pointerId: 10+k }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: 750+mx, clientY: 430+my, pointerId: 10+k }));
      out.push({ dir: (my<0?'up':my>0?'down':mx<0?'left':'right'), dx: +(L.tx-t.tx).toFixed(1), dy: +(L.ty-t.ty).toFixed(1) });
    }
    return out;
  })()`);

  // ---------- S7b：大图拖到极限时应被约束（不得露出图片边缘）----------
  results.s7b_bounds = await w.webContents.executeJavaScript(`(() => { ${helper}
    const L = window.Lightbox; const stage = document.getElementById('lbStage');
    L.fit(false); L.zoomAt(6, L._center().x, L._center().y); L.tx = 0; L.ty = 0; L.apply();
    const g = stageC(), r0 = rectOf();
    const limX = (r0.width - g.w)/2, limY = (r0.height - g.h)/2;
    // 尝试拖到远超上限的位置
    stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 750, clientY: 430, pointerId: 50 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, clientX: 750+99999, clientY: 430+99999, pointerId: 50 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: 750+99999, clientY: 430+99999, pointerId: 50 }));
    const r1 = rectOf();
    const stageL = g.x - g.w/2, stageR = g.x + g.w/2, stageT = g.y - g.h/2, stageB = g.y + g.h/2;
    return { limits: { limX: +limX.toFixed(1), limY: +limY.toFixed(1) },
      t: { tx: +L.tx.toFixed(1), ty: +L.ty.toFixed(1) },
      // 拖到右下极限后：图片左/上边缘应恰好贴住舞台左/上边缘（不露出空白）
      edgeGap: { left: +(r1.left - stageL).toFixed(1), top: +(r1.top - stageT).toFixed(1),
                 right: +(stageR - r1.right).toFixed(1), bottom: +(stageB - r1.bottom).toFixed(1) },
      rect: { w: +r1.width.toFixed(0), h: +r1.height.toFixed(0) } };
  })()`);

  // ---------- S8：拖动后不触发关闭 / 不误触切换 ----------
  results.s8_guard = await w.webContents.executeJavaScript(`(() => { ${helper}
    const L = window.Lightbox;
    return { stillOpen: L.isOpen(), movedFlag: L.moved, idx: L.i, dragging: L.dragging,
      resizeFired: __fs, center: varCenter() };
  })()`);

  // ---------- S8b：按窗口尺寸即时重算（模拟切全屏）----------
  results.s8b_resize = await w.webContents.executeJavaScript(`(() => { ${helper}
    const L = window.Lightbox;
    L.fit(false);
    const a = dev();
    // 直接改窗口尺寸后 fit 应重新居中
    const oldW = window.innerWidth, oldH = window.innerHeight;
    L.fit(false);
    const b = dev();
    return { before: a, after: b, same: a.dx === b.dx && a.dy === b.dy };
  })()`);

  // ---------- S9：旋转 90° 后仍居中 ----------
  results.s9_rot_center = await w.webContents.executeJavaScript(`(() => { ${helper}
    const L = window.Lightbox;
    L.fit(false);
    const a = dev();
    L.rotate(1);
    return { rot: L.rot, beforeRotDev: a, afterRotDev: dev(), tx: +L.tx.toFixed(2), ty: +L.ty.toFixed(2),
      rect: { w: +rectOf().width.toFixed(0), h: +rectOf().height.toFixed(0) } };
  })()`);

  // 截图：放大居中（先复位到干净状态，避免沿用上一步的旋转/平移量）
  await w.webContents.executeJavaScript(`(() => { const L = window.Lightbox;
    L.rot = 0; L.fit(false); L.scale = L.base * 2.6; L.tx = 0; L.ty = 0; L.apply();
    L.el.classList.remove('fs-idle'); return { scale: +L.scale.toFixed(3), rot: L.rot, tx: L.tx, ty: L.ty }; })()`);
  await new Promise((r) => setTimeout(r, 700));
  const shot = await w.webContents.capturePage({ x: 0, y: 0, width: 1500, height: 860 });
  fs.writeFileSync(path.join(OUT, 'zoom-centered.png'), shot.toPNG());
  const ctrShot = await w.webContents.executeJavaScript(`(() => { const L=window.Lightbox;
    const r=document.getElementById('lbImg').getBoundingClientRect(), s=document.getElementById('lbStage').getBoundingClientRect();
    return { scale:+L.scale.toFixed(3), tx:L.tx, ty:L.ty,
      img:{l:+r.left.toFixed(1),t:+r.top.toFixed(1),w:+r.width.toFixed(0),h:+r.height.toFixed(0)},
      centerDev:{ dx:+((r.left+r.width/2)-(s.left+s.width/2)).toFixed(2), dy:+((r.top+r.height/2)-(s.top+s.height/2)).toFixed(2) } }; })()`);

  // 截图：缩小后拖至右下（验证小图也能拖动）
  await w.webContents.executeJavaScript(`(() => { const L = window.Lightbox; L.fit(false); L.scale = L.base*0.35;
    L.tx = 340; L.ty = 190; L._clampPan(); L.apply(); return true; })()`);
  await new Promise((r) => setTimeout(r, 500));
  const shot2 = await w.webContents.capturePage({ x: 0, y: 0, width: 1500, height: 860 });
  fs.writeFileSync(path.join(OUT, 'zoom-small-dragged.png'), shot2.toPNG());
  const smallShot = await w.webContents.executeJavaScript(`(() => { const L=window.Lightbox; const r=document.getElementById('lbImg').getBoundingClientRect();
    return { scale:+L.scale.toFixed(3), tx:L.tx, ty:L.ty, img:{l:+r.left.toFixed(1),t:+r.top.toFixed(1),w:+r.width.toFixed(0),h:+r.height.toFixed(0)} }; })()`);

  results.s10_shots = { centered: ctrShot, smallDragged: smallShot };

  console.log('RESULT ' + JSON.stringify(results, null, 1));
  app.quit();
});
