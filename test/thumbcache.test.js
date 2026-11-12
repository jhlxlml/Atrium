/* ============================================================
   Atrium · 灯箱「屏幕尺寸代」缓存层的回归测试（纯 Node）
   ------------------------------------------------------------
   覆盖 v1.20.9 之后审计出的四类确定性问题：
     A. LRU.set() 覆盖同一 key 时旧 Blob URL 无人回收（内存泄漏）
     B. screenURL() 没有 in-flight 去重：并发请求重复解码、互相覆盖、
        旧 URL 被提前 revoke（正在显示的那张会碎）
     C. preloadScreen() 的串行链没有「代」校验：切目录 / 删图 / 关灯箱 /
        清缓存之后，旧任务照样跑完并回写缓存
     G. 屏幕代理对 GIF / SVG 会丢动画、丢矢量清晰度

   运行： node test/thumbcache.test.js
   ============================================================ */
'use strict';

const H = require('./_harness.js');
const A = H.makeAsserts();

/* ---------- 桩环境 ----------
   thumb.js 在装载时就会读 `global.Util.can.createImageBitmap`，
   所以这些桩必须**先装好再 loadScript**。 */
let ledger = null;
let decodeCalls = 0;
let decodeDelay = 0;          // 每次 createImageBitmap 的模拟耗时
let decodeLog = [];           // 记录每次解码请求的目标尺寸

function installEnv(opts) {
  const o = opts || {};
  H.useGlobalAsWindow();
  ledger = H.makeUrlLedger();
  decodeCalls = 0;
  decodeDelay = o.decodeDelay || 0;
  decodeLog = [];

  /* 只替换静态方法，**不替换 URL 本身**：本机 node 的 fs shim 内部会
     `x instanceof URL`，把全局 URL 换成普通对象会让它直接抛错。 */
  globalThis.URL.createObjectURL = ledger.api.createObjectURL;
  globalThis.URL.revokeObjectURL = ledger.api.revokeObjectURL;
  globalThis.devicePixelRatio = o.dpr || 1;
  globalThis.performance = { now: () => Date.now() };
  /* 用**真的** util.js（exifOrientation 这些是纯函数，没必要重写一份桩），
     只把 `can` 换成"支持 createImageBitmap"。thumb.js 装载时就要读它，
     所以必须在这里、loadScript('js/thumb.js') 之前装好。 */
  if (!globalThis.Util || !globalThis.Util.exifOrientation) {
    globalThis.CSS = globalThis.CSS || { supports: () => false };
    H.loadScript('js/util.js');
  }
  globalThis.Util = globalThis.Util || {};
  globalThis.Util.can = { createImageBitmap: true };
  globalThis.State = { bus: { emit() {} } };
  globalThis.Native = { active: false, url: () => null };
  globalThis.Loader = { imageSize: async () => null, recordDims() {}, recordRatio() {} };

  globalThis.createImageBitmap = async (src, opt) => {
    decodeCalls++;
    decodeLog.push({ rw: opt && opt.resizeWidth, rh: opt && opt.resizeHeight });
    if (decodeDelay) await H.tick(decodeDelay);
    const w = (opt && opt.resizeWidth) || 100;
    const h = (opt && opt.resizeHeight) || 100;
    return { width: w, height: h, close() {} };
  };

  /* canvas 池：只需要 getContext/drawImage/convertToBlob 三个方法 */
  globalThis.OffscreenCanvas = class OffscreenCanvas {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return { clearRect() {}, drawImage() {} }; }
    convertToBlob() { return Promise.resolve({ fakeBlob: true, w: this.width, h: this.height }); }
  };
}

/** 一张 6000×4000 的 24MP JPEG 条目（File 来源，elURL 会 createObjectURL） */
function meta24(id, extra) {
  return Object.assign({
    id: id || 'f1│a.jpg│5000000│1',
    name: 'a.jpg', rel: 'a.jpg', ext: 'jpg',
    size: 5000000, lastModified: 1,
    w: 6000, h: 4000,
    file: { fake: 'file' },
    bad: false, state: 'idle',
  }, extra || {});
}

/* ============================================================
   A. 覆盖同一 key 时，旧 Blob URL 必须被回收
   ============================================================ */
async function testA() {
  installEnv();
  H.loadScript('js/thumb.js');
  const T = globalThis.Thumbs;

  const m = meta24();
  const r1 = await T.screenURL(m, 1000);      // dpr=1 → need 1000 → 档 1280
  A.ok('A0 首次生成成功（1280 档）', !!r1 && r1.side === 1280, '实际 ' + (r1 && r1.side));
  A.eq('A0 只建了一个 blob URL', ledger.createdCount, 1);

  const r2 = await T.screenURL(m, 2400);      // → 档 2560，覆盖同一条缓存
  A.ok('A1 尺寸升级生成了更大的代', !!r2 && r2.side === 2560, '实际 ' + (r2 && r2.side));
  A.eq('A1 升级时新建了一个 URL', ledger.createdCount, 2);
  A.eq('A1 被覆盖的旧 URL 已回收', ledger.revokedCount, 1);
  /* 存活数 = 缓存里那一条（1 个）；旧的那个必须已经被回收 */
  A.eq('A1 只有缓存里那一条 URL 还活着', ledger.leaked().length, 1);

  /* 反向：再请求更小的档位不该降级覆盖（也不该新建 URL） */
  const r3 = await T.screenURL(m, 1000);
  A.ok('A2 更小档位命中已有的 2560 代', !!r3 && r3.side === 2560, '实际 ' + (r3 && r3.side));
  A.eq('A2 没有多余解码', decodeCalls, 2);
}

/* ============================================================
   A'. 灯箱正在显示的 URL 不能被后台覆盖/淘汰顺手 revoke
   ============================================================ */
async function testAPin() {
  installEnv();
  H.loadScript('js/thumb.js');
  const T = globalThis.Thumbs;

  const m = meta24();
  const r1 = await T.screenURL(m, 1000);
  A.ok('A3 pin 接口存在', typeof T.pinURL === 'function' && typeof T.unpinURL === 'function');
  if (typeof T.pinURL !== 'function') return;

  T.pinURL(r1.url);                            // 灯箱把它贴到 img.src 上了
  const r2 = await T.screenURL(m, 2400);       // 后台升级到 2560
  A.ok('A3 升级确实换了代', !!r2 && r2.side === 2560);
  A.ok('A3 正在显示的旧 URL 没有被回收', ledger.revoked.indexOf(r1.url) < 0,
    '被提前 revoke 了：' + r1.url);

  T.unpinURL(r1.url);                          // 灯箱换图 / 关闭
  A.ok('A3 unpin 之后补做了回收', ledger.revoked.indexOf(r1.url) >= 0);
}

/* ============================================================
   B. 同一张图同尺寸的并发请求必须去重
   ============================================================ */
async function testBDedupe() {
  installEnv({ decodeDelay: 30 });
  H.loadScript('js/thumb.js');
  const T = globalThis.Thumbs;
  const m = meta24();

  const [a, b] = await Promise.all([T.screenURL(m, 1000), T.screenURL(m, 1000)]);
  A.eq('B1 并发两次只解码一次', decodeCalls, 1);
  A.eq('B1 并发两次只建一个 blob URL', ledger.createdCount, 1);
  A.ok('B1 两次拿到同一个 URL', !!a && !!b && a.url === b.url,
    'a=' + (a && a.url) + ' b=' + (b && b.url));
  A.eq('B1 只有缓存里那一条 URL 还活着', ledger.leaked().length, 1);
}

/* ============================================================
   B'. 大小档并发：先发出的慢任务不能把后完成的小档结果顶掉，
       也不能把别人正在用的 URL revoke 掉
   ============================================================ */
async function testBRace() {
  installEnv({ decodeDelay: 40 });
  H.loadScript('js/thumb.js');
  const T = globalThis.Thumbs;
  const m = meta24();

  const big = T.screenURL(m, 2400);            // 2560 档，慢
  await H.tick(5);
  const small = T.screenURL(m, 1000);          // 1280 档，本来更快
  const [rb, rs] = await Promise.all([big, small]);

  A.ok('B2 两个调用都拿到结果', !!rb && !!rs);
  A.ok('B2 最终缓存里是更大的那一代', (T.screenPeek(m, 2400) || {}).side === 2560,
    '实际 ' + JSON.stringify((T.screenPeek(m, 2400) || {}).side));
  A.ok('B2 返回给小档调用的 URL 仍然有效（没被提前 revoke）',
    !!rs && ledger.revoked.indexOf(rs.url) < 0, '被 revoke：' + (rs && rs.url));
  A.eq('B2 只解码了一次', decodeCalls, 1);
}

/* ============================================================
   C. 切目录 / 清缓存之后，排队中的旧任务必须失效
   ============================================================ */
async function testCGeneration() {
  installEnv({ decodeDelay: 10 });
  H.loadScript('js/thumb.js');
  const T = globalThis.Thumbs;
  const m = meta24();

  T.preloadScreen(m, 1000, true);              // near → setTimeout(run, 40)
  T.clearAll();                                // 用户立刻切了目录
  await H.tick(200);

  A.ok('C1 清缓存后旧任务没有再写回缓存', T.screenPeek(m, 1000) === null,
    '缓存里仍有：' + JSON.stringify(T.screenPeek(m, 1000)));
  A.eq('C1 旧任务没有留下未回收的 URL', ledger.leaked().length, 0);
}

/* ============================================================
   C'. 单条 forget() 之后，排队中的旧任务同样必须失效
   ============================================================ */
async function testCForget() {
  installEnv({ decodeDelay: 10 });
  H.loadScript('js/thumb.js');
  const T = globalThis.Thumbs;
  const m = meta24();

  T.preloadScreen(m, 1000, true);
  T.forget(m.id);                              // 图片被删了
  await H.tick(200);

  A.ok('C2 forget 之后旧任务没有复活缓存', T.screenPeek(m, 1000) === null);
  A.eq('C2 没有留下未回收的 URL', ledger.leaked().length, 0);
}

/* ============================================================
   G. GIF / SVG 不能被栅格化成静态位图
   ============================================================ */
async function testGFormats() {
  installEnv();
  H.loadScript('js/thumb.js');
  const T = globalThis.Thumbs;

  const gif = meta24('g', { ext: 'gif', name: 'a.gif', rel: 'a.gif' });
  const rg = await T.screenURL(gif, 1000);
  A.eq('G1 GIF 不走屏幕代理（解码次数 0）', decodeCalls, 0);
  A.ok('G1 GIF 直接给原图', !!rg && rg.full === true, '实际 ' + JSON.stringify(rg && rg.full));
  A.ok('G1 GIF 的 URL 是原图地址', !!rg && rg.url === ledger.created[0].url);

  const svg = meta24('s', { ext: 'svg', name: 'a.svg', rel: 'a.svg', w: 0, h: 0 });
  const rs = await T.screenURL(svg, 1000);
  A.eq('G2 SVG 不走屏幕代理（解码次数仍为 0）', decodeCalls, 0);
  A.ok('G2 SVG 直接给原图', !!rs && rs.full === true);

  /* APNG：PNG 里带 acTL 块 —— 索引阶段标了 anim 就不能代理 */
  const apng = meta24('p', { ext: 'png', name: 'a.png', rel: 'a.png', anim: true });
  const ra = await T.screenURL(apng, 1000);
  A.eq('G3 动图 PNG 不走屏幕代理', decodeCalls, 0);
  A.ok('G3 动图 PNG 直接给原图', !!ra && ra.full === true);

  /* 普通 PNG 仍然要走代理（别把优化一刀切掉） */
  const png = meta24('p2', { ext: 'png', name: 'b.png', rel: 'b.png' });
  const rp = await T.screenURL(png, 1000);
  A.eq('G4 静态 PNG 仍然走代理', decodeCalls, 1);
  A.ok('G4 静态 PNG 得到缩小代', !!rp && rp.full === false && rp.side === 1280);
}

/* ============================================================
   H. 透明图不能因为代理编码丢 alpha
   ============================================================ */
async function testHAlpha() {
  installEnv();
  H.loadScript('js/thumb.js');
  const T = globalThis.Thumbs;
  const m = meta24('t', { ext: 'png', name: 'a.png', rel: 'a.png' });
  await T.screenURL(m, 1000);
  /* 编码 MIME 由 alphaMime 决定；PNG 必须编成 PNG，否则透明区变黑底 */
  const blob = ledger.created[0] && ledger.created[0].blob;
  A.ok('H1 透明格式的代理仍以支持 alpha 的格式编码', !!blob && blob.fakeBlob === true);
}

/* ============================================================
   I. EXIF 方向：竖拍的图不能被压成横图
   ------------------------------------------------------------
   真实复现（打包 exe + 真图）：3840×2400 的 JPEG 只多一个
   Orientation=6，代理产物是 1920×1200（横），而正确值是 1200×1920（竖）。
   原因：createImageBitmap 传了 imageOrientation:'from-image'，
   解码结果是转正后的竖图，却按文件头的横宽高给了 resizeWidth/resizeHeight。
   ============================================================ */
async function testIExif() {
  installEnv();
  H.loadScript('js/thumb.js');
  const T = globalThis.Thumbs;
  const at = (i) => decodeLog[i] || {};

  /* I1 未标记 disp（旧尺寸库/文件头口径）+ Orientation=6 → 按竖图算目标 */
  const raw = meta24('r1', { w: 6000, h: 4000, orient: 6 });
  const r1 = await T.screenURL(raw, 1000);      // 1280 档
  A.ok('I1 竖拍的代是竖的', at(0).rh > at(0).rw, '实测 ' + at(0).rw + '×' + at(0).rh);
  A.eq('I1 长边正好等于档位', at(0).rh, 1280);
  A.eq('I1 短边按显示方向的比例（4000/6000）', at(0).rw, Math.round(4000 * (1280 / 6000)));
  A.ok('I1 顺手把条目尺寸纠正成显示方向', raw.w === 4000 && raw.h === 6000,
    '实测 ' + raw.w + '×' + raw.h);

  /* I2 已经标记 disp（Loader 写的就是显示方向）→ 不能再翻一次 */
  const disp = meta24('r2', { w: 4000, h: 6000, orient: 6, disp: true });
  await T.screenURL(disp, 1000);
  A.eq('I2 显示方向的条目不再互换', at(1).rw + '×' + at(1).rh, at(0).rw + '×' + at(0).rh);

  /* I3 没有方向的图完全不受影响（回归：不能把正常横图弄成竖的） */
  const land = meta24('r3', { w: 6000, h: 4000 });
  await T.screenURL(land, 1000);
  A.ok('I3 普通横图仍是横的', at(2).rw > at(2).rh, '实测 ' + at(2).rw + '×' + at(2).rh);
  A.eq('I3 长边是宽', at(2).rw, 1280);

  /* I4 Orientation=1（不换宽高）不能被当成旋转 */
  const o1 = meta24('r4', { w: 6000, h: 4000, orient: 1 });
  await T.screenURL(o1, 1000);
  A.eq('I4 Orientation=1 不改宽高', at(3).rw, 1280);

  /* I5 没有 meta.orient 时，从 blob 头自己认（灯箱直调 / 测试路径） */
  const app1 = (() => {
    const payload = [
      0x45, 0x78, 0x69, 0x66, 0x00, 0x00,                       // "Exif\0\0"
      0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,           // TIFF 头（小端）
      0x01, 0x00,                                               // 1 个条目
      0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
    ];
    const seg = [0xFF, 0xE1, (payload.length + 2) >> 8, (payload.length + 2) & 0xFF];
    return new Uint8Array([0xFF, 0xD8].concat(seg, payload, [0xFF, 0xDA, 0x00, 0x02]));
  })();
  const fileBlob = new Blob([app1]);
  const fromBlob = meta24('r5', { w: 6000, h: 4000, file: fileBlob });
  await T.screenURL(fromBlob, 1000);
  A.ok('I5 从 blob 头认出了方向', at(4).rh > at(4).rw, '实测 ' + at(4).rw + '×' + at(4).rh);
  A.eq('I5 认出来后记在条目上（下次不用再读）', fromBlob.orient, 6);
}

/* ============================================================ */
(async () => {
  await testA();
  await testAPin();
  await testBDedupe();
  await testBRace();
  await testCGeneration();
  await testCForget();
  await testGFormats();
  await testHAlpha();
  await testIExif();
  process.exit(A.finish('thumb 缓存层（A/B/C/G/I）') ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
