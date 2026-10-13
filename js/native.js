/* ============================================================
   Atrium · native.js  （Electron 原生桥适配器）
   本项目只交付 Electron 版：vfNative 桥由 preload 恒定注入，这里**不再保留**
   「浏览器无桥 → 全部空操作」的降级分支。适配器把主进程能力收敛成渲染层
   可用的 Promise API ——
       原生目录选择框 / 列目录(IPC) / 读文件头(IPC，EXIF) / vf://pic/ 大图流式 URL，
       删除与撤销（系统回收站）/ 导出落盘 / 窗口置顶 / 相框窗口 / 屏幕清单；
       并在启动时自动打开上次目录。
   依赖加载顺序：util.js 之后（需 window.vfNative / 被各模块按需调用）。
   ============================================================ */
(function (global) {
  'use strict';

  const bridge = global.vfNative;
  if (!bridge) {
    // 不是 Electron 环境 = 部署出了问题（preload 没注入），明确报出来而不是静默降级。
    console.error('[native] 未检测到 vfNative 桥：本应用只支持 Electron 版运行。');
  }

  /* URL 安全 Base64（无 padding，无 +/） */
  function b64url(s) {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return global.btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /* ------------------------------------------------------------
     失败留痕策略（本文件的核心取舍，改这里之前先读完）
     ------------------------------------------------------------
     本文件里绝大多数 `catch` 都吞成 `false / null / []`（另有一小撮走下面的
     warnOnce）。它们的失败与"合法的否定结果"
     **同形**："IPC 挂了"和"用户点了取消"、"这张图没有 EXIF"、"窗口本来就没置顶"
     看起来一模一样。这是刻意的 —— 调用方（App / Lightbox / Frame）本来就接受"空"，
     若这里改成抛错，反而会让"取消选择文件夹"变成一条错误。

     ⚠️ 这个数字刻意不写死：上一版写的是"26 处"，而它当时就已经对不上了
     （判据不同会数出 25 / 26 / 32 三个数）。与其留一个会烂掉的数字，
     不如把**判据**写清楚 —— 下面两类才是真正需要读的人注意的。

     但有两类不能这么处理：

     ① **写操作**（exportFiles / deleteFile(s) / restoreFile(s) / frameOpen / trashPreview）
        一律返回 `{ok:false, reason, message}`，把原因带到用户面前。
        绝不允许把"删除失败"吞成"什么都没发生"。
        （v1.14.0 的 checkUpdate 也归这一类的**语义**：它返回
         `{ok:false, reason}`，因为"检查失败"与"没有新版本"对用户是两句话，
         合并成 false 就等于把"没连上网"说成"已是最新"。）

     ② **状态对齐类**（setAlwaysOnTop / getAlwaysOnTop / setTray / setHotkey / frameInfo）
        用下面的 warnOnce 留一次痕。为什么：它们的失败症状是"**开关自己弹回去了**"，
        用户与开发者都会误判成"这功能没做"。上一轮 a11yui 的假失败就是这么来的 ——
        探针缺 handler → invoke reject → `.catch` 吞成 false → applySetting 判"没生效"
        → 回滚 + urgent 播报 → 播报区被永久改成 assertive。
        用 Set 去重，避免轮询式调用刷屏（与项目"响了比静默好"的取舍一致）。
        openExternal 也走 warnOnce：它同样是"用户按了、什么都没发生"的那类失败。

     其余查询类维持吞值 —— 调用方必须能接受"空"。
     ------------------------------------------------------------ */
  const warned = new Set();
  function warnOnce(tag, e) {
    const msg = String((e && e.message) || e);
    const k = tag + '|' + msg;
    if (warned.has(k)) return;
    warned.add(k);
    console.warn('[native] ' + tag + ' 失败（已回退为空值，可能与"合法空结果"同形）：' + msg);
  }

  const Native = {
    active: !!bridge,

    /** 大图/原图 URL：Electron 下由 vf:// 特权协议流式读盘（不占 JS 内存） */
    url(meta) {
      if (!bridge || !meta || !meta.path) return null;
      return 'vf://pic/' + b64url(meta.path);
    },

    /** 读取文件头 ≤n 字节（EXIF 用）；返回 ArrayBuffer 或 null */
    readHead(path, n) {
      if (!bridge || !path) return Promise.reject(new Error('native-off'));
      return bridge.readHead(path, n || 262144).catch(() => null);
    },

    /** 列出目录内全部图片（含子目录） */
    loadDir(dir) {
      if (!bridge || !dir) return Promise.resolve(null);
      return bridge.loadDir(dir).catch(() => null);
    },

    /** 主进程记忆的“上次目录”（启动即开） */
    autoDir() {
      if (!bridge) return Promise.resolve(null);
      return bridge.autoDir().catch(() => null);
    },

    /** 弹出主进程原生「选择文件夹」对话框；用户取消返回 null */
    pickFolder() {
      if (!bridge || typeof bridge.pickFolder !== 'function') return Promise.resolve(null);
      return bridge.pickFolder().catch(() => null);
    },

    /* ---------- 导出（P1-4） ---------- */
    /** 是否支持「导出到指定目录」（仅桌面版） */
    get canExportDir() { return !!(bridge && typeof bridge.exportFiles === 'function'); },
    /** 选一个导出目标目录；取消返回 null */
    pickExportDir() {
      if (!bridge || typeof bridge.pickExportDir !== 'function') return Promise.resolve(null);
      return bridge.pickExportDir().catch(() => null);
    },
    /**
     * 把 list 导出到 dir。list = [ { src:绝对路径|null, name, dataB64? } ]。
     * 返回 { ok, dir, results:[{ok,name,out}|{ok:false,name,reason}] }；
     * 不支持时返回 { ok:false, reason:'unsupported' }，由上层降级为浏览器下载。
     */
    exportFiles(dir, list) {
      if (!bridge || typeof bridge.exportFiles !== 'function') {
        return Promise.resolve({ ok: false, reason: 'unsupported' });
      }
      return bridge.exportFiles(dir, list)
        .catch((e) => ({ ok: false, reason: 'failed', message: String((e && e.message) || e) }));
    },

    /** 记住「上次目录」。传 null 表示清除（关掉「记住上次位置」时用）。 */
    setLastDir(dir) {
      if (!bridge) return;
      try { bridge.setLastDir(dir || null); } catch (e) { /* 忽略 */ }
    },
    /** 清掉「上次目录」记忆（设置里关掉「记住上次位置」时调用） */
    clearLastDir() { this.setLastDir(null); },

    /**
     * 删除磁盘文件（主进程移入系统回收站，可恢复）。
     * rec = { name?, size? }：一并记入删除日志，供撤销使用。
     * 返回 { ok, mode:'trash', ts, size, logId } 或 { ok:false, reason, message }。
     * 注意：失败时绝不降级为永久删除。
     */
    deleteFile(path, rec) {
      if (!bridge || !path || typeof bridge.deleteFile !== 'function') {
        return Promise.resolve({ ok: false, reason: 'unsupported' });
      }
      return bridge.deleteFile(path, rec || null)
        .catch((e) => ({ ok: false, reason: 'failed', message: String((e && e.message) || e) }));
    },

    /**
     * 批量删除：一次调用走完 N 张（Electron 下为单次 IPC；浏览器环境逐张走 File System Access）。
     * list = [ { path, rec:{ name, size, meta }, meta } ]
     * 返回等长结果数组；不支持时逐项返回 { ok:false, reason:'unsupported' }。
     */
    async deleteFiles(list) {
      const arr = Array.isArray(list) ? list : [];
      if (!arr.length) return [];
      if (bridge && typeof bridge.deleteFiles === 'function') {
        try {
          const r = await bridge.deleteFiles(arr.map((it) => ({ path: it.path, rec: it.rec || null })));
          if (Array.isArray(r)) return r;
        } catch (e) { /* 落到逐张兜底 */ }
      }
      // 兜底：逐张删除（浏览器环境 / 旧版 preload）
      const out = [];
      for (const it of arr) out.push(await this.deleteFile(it.path, it.rec || null));
      return out;
    },

    /**
     * 批量撤销删除：把多个文件从回收站还原回原位置。
     * 返回等长结果数组；不支持时逐项返回 { ok:false, reason:'unsupported' }。
     */
    async restoreFiles(recs) {
      const arr = Array.isArray(recs) ? recs : [];
      if (!arr.length) return [];
      if (bridge && typeof bridge.restoreFiles === 'function') {
        try {
          const r = await bridge.restoreFiles(arr);
          if (Array.isArray(r)) return r;
        } catch (e) { /* 落到逐张兜底 */ }
      }
      const out = [];
      for (const rec of arr) out.push(await this.restoreFile(rec));
      return out;
    },

    /**
     * 回收站条目缩略图：文件已被移走，只能从回收站里读回内容。
     * 返回 { ok:true, url }（dataURL）或 { ok:false, reason }。
     */
    trashPreview(rec) {
      if (!bridge || !rec || typeof bridge.trashPreview !== 'function') {
        return Promise.resolve({ ok: false, reason: 'unsupported' });
      }
      return bridge.trashPreview({ id: rec.id, path: rec.path, size: rec.size, ts: rec.ts })
        .catch((e) => ({ ok: false, reason: 'failed', message: String((e && e.message) || e) }));
    },

    /**
     * 撤销删除：把回收站里的文件还原回原位置。
     * rec = { id?, path, size?, ts? }
     * 返回 { ok:true, size } 或 { ok:false, reason }
     *   reason: 'not-found' 回收站里已找不到（被清空 / 网络盘 / 非 NTFS）
     *           'occupied'  原位置已有同名文件（为避免覆盖，拒绝还原）
     */
    restoreFile(rec) {
      if (!bridge || !rec || !rec.path || typeof bridge.restoreFile !== 'function') {
        return Promise.resolve({ ok: false, reason: 'unsupported' });
      }
      return bridge.restoreFile(rec)
        .catch((e) => ({ ok: false, reason: 'failed', message: String((e && e.message) || e) }));
    },

    /** 最近删除记录（跨启动保留，最新在前）→ 数组；浏览器端恒为空 */
    trashLog() {
      if (!bridge || typeof bridge.trashLog !== 'function') return Promise.resolve([]);
      return bridge.trashLog().catch(() => []);
    },

    /** 丢弃一条删除记录（文件仍留在回收站，不再提供撤销入口） */
    trashForget(id) {
      if (!bridge || typeof bridge.trashForget !== 'function') return Promise.resolve(false);
      return bridge.trashForget(id).catch(() => false);
    },

    trashClear() {
      if (!bridge || typeof bridge.trashClear !== 'function') return Promise.resolve(false);
      return bridge.trashClear().catch(() => false);
    },

    /** 打开系统回收站（还原失败时的人工兜底） */
    openRecycleBin() {
      if (!bridge || typeof bridge.openRecycleBin !== 'function') return Promise.resolve(false);
      return bridge.openRecycleBin().catch(() => false);
    },

    /** 用系统文件管理器打开某目录（导出完成后的「打开文件夹」） */
    openPath(p) {
      if (!bridge || typeof bridge.openPath !== 'function' || !p) return Promise.resolve(false);
      return bridge.openPath(p).catch(() => false);
    },

    /* ---------- 版本更新检测（v1.14.0，仅桌面版） ----------
       这是本应用**唯一**会联网的功能，所以入口按能力探测开关：
       拿不到该能力的运行环境里，设置面板上不会出现「检查更新」这一行，
       「关于」里也不会出现那个按钮（本项目对死开关零容忍）。 */
    /** 是否支持检查更新（决定「关于」里的按钮与设置里的开关出不出现） */
    get canUpdate() { return !!(bridge && typeof bridge.checkUpdate === 'function'); },

    /**
     * 查最新版本。current 传 App.VERSION —— 主进程只用它做版本比较与 User-Agent，
     * 不自己读 package.json（避免"界面显示的版本"与"检测用的版本"两处不同源）。
     * 返回 { ok:true, current, latest, hasUpdate, url } 或 { ok:false, reason }。
     * **失败不抛**：调用方要能区分"检查失败"与"没有新版本"，这两句话对用户不是一回事。
     */
    checkUpdate(current) {
      if (!bridge || typeof bridge.checkUpdate !== 'function') {
        return Promise.resolve({ ok: false, reason: 'unsupported' });
      }
      return bridge.checkUpdate(current || '')
        .catch((e) => ({ ok: false, reason: 'failed', message: String((e && e.message) || e) }));
    },

    /**
     * 打开官方仓库 / Releases 页面（系统默认浏览器）。
     * 真正的白名单校验在主进程 —— 这里返回 false 表示"没打开"（含被白名单拒绝）。
     */
    openExternal(url) {
      if (!bridge || typeof bridge.openExternal !== 'function') return Promise.resolve(false);
      return bridge.openExternal(url).catch((e) => { warnOnce('openExternal', e); return false; });
    },

    /* ---------- 窗口置顶（仅桌面版） ---------- */
    /** 渲染进程没有窗口控制能力，只有桌面版能置顶；浏览器模式直接隐藏按钮 */
    get canPin() { return !!(bridge && typeof bridge.alwaysOnTop === 'function'); },

    /**
     * 设置窗口置顶。返回「实际生效后」的状态（主进程回传），
     * 而不是请求值 —— 系统拒绝时界面不会显示成"已置顶"。
     */
    setAlwaysOnTop(on) {
      if (!bridge || typeof bridge.alwaysOnTop !== 'function') return Promise.resolve(false);
      return bridge.alwaysOnTop(!!on).catch((e) => { warnOnce('setAlwaysOnTop', e); return false; });
    },

    /** 启动时查询真实置顶状态，让界面与窗口一致 */
    getAlwaysOnTop() {
      if (!bridge || typeof bridge.getAlwaysOnTop !== 'function') return Promise.resolve(false);
      return bridge.getAlwaysOnTop().catch((e) => { warnOnce('getAlwaysOnTop', e); return false; });
    },

    /* ---------- 窗口标题栏浮层（Windows：Window Controls Overlay） ----------
       原生标题栏被浮层取代后，标题栏的配色由系统画、读不到 CSS 变量，只能推过去。
       这属于**状态对齐类**：失败的症状是「深色主题下标题栏还是浅色的」，
       不会崩、也不会误报成功，所以留一次痕即可（见文件头的失败留痕策略）。 */
    /** 同步浮层配色（{color, symbolColor}）；返回是否真的生效（非 Windows 恒 false） */
    syncTitleBarOverlay(opt) {
      if (!bridge || typeof bridge.syncTitleBarOverlay !== 'function') return Promise.resolve(false);
      return bridge.syncTitleBarOverlay(opt || {})
        .catch((e) => { warnOnce('syncTitleBarOverlay', e); return false; });
    },

    /** 双击标题栏 → 最大化 / 还原（原生标题栏没了，这个习惯动作要自己补） */
    toggleMaximize() {
      if (!bridge || typeof bridge.toggleMaximize !== 'function') return Promise.resolve(false);
      return bridge.toggleMaximize().catch((e) => { warnOnce('toggleMaximize', e); return false; });
    },

    /* ---------- 相框模式（仅桌面版能开独立的无边框窗口） ----------
       浏览器里没有「窗口」这个概念，改不了形状也置不了顶，于是在当前页面
       里铺一层整屏浮层（Frame.boot），随机轮播的部分两种形态完全一致。 */
    /** 桌面版才能开真正的无边框相框窗口；否则 Frame 走页内浮层降级 */
    get canFrameWin() { return !!(bridge && typeof bridge.frameOpen === 'function'); },

    /**
     * 打开相框窗口。payload = { ms, fit, items:[{p,n,w,h,r}] }（p = 绝对路径）。
     * 返回 { ok:true } 或 { ok:false, reason }；失败时调用方降级为页内浮层。
     */
    frameOpen(payload) {
      if (!bridge || typeof bridge.frameOpen !== 'function') return Promise.resolve({ ok: false, reason: 'unsupported' });
      return bridge.frameOpen(payload).catch((e) => ({ ok: false, reason: 'failed', message: String((e && e.message) || e) }));
    },

    /** 关闭相框窗口（主窗口会被重新显示出来） */
    frameClose() {
      if (!bridge || typeof bridge.frameClose !== 'function') return Promise.resolve(false);
      return bridge.frameClose().catch(() => false);
    },

    /** 相框窗口启动时取自己的播放清单 */
    frameData() {
      if (!bridge || typeof bridge.frameData !== 'function') return Promise.resolve(null);
      return bridge.frameData().catch(() => null);
    },

    /**
     * 相框窗口请求"把我按这个尺寸/比例摆好"。
     * 返回主进程**实际应用**的矩形（可能与请求值有 1px 取整差异）。
     */
    frameFit(box) {
      if (!bridge || typeof bridge.frameFit !== 'function') return Promise.resolve(null);
      return bridge.frameFit(box).catch(() => null);
    },

    /** 相框窗口状态（窗口是否存在 / 是否置顶 / 是否无边框 / 当前矩形）；诊断与回归用 */
    frameInfo() {
      if (!bridge || typeof bridge.frameInfo !== 'function') return Promise.resolve(null);
      return bridge.frameInfo().catch((e) => { warnOnce('frameInfo', e); return null; });
    },

    /**
     * 相框窗口自报"用户正把我拖到 (x,y)"（逐帧，渲染进程算好偏移再交过来）。
     * 为什么不让 CSS 的 `-webkit-app-region: drag` 直接拖整张图：那样整个图片变成
     * **系统拖拽区**，网页侧收不到任何鼠标事件 —— 相框赖以操作的"单击换下一张 /
     * 双击退出"会一起消失。所以拖动必须走渲染进程自算 + 这里搬窗口。
     */
    frameMove(pos) {
      if (!bridge || typeof bridge.frameMove !== 'function') return Promise.resolve(false);
      return bridge.frameMove(pos).catch(() => false);
    },

    /**
     * 屏幕清单 [{id,label,primary,workArea}] —— 「相框输出屏幕」设置项用。
     * 浏览器里没有"原生屏幕"这回事，返回空数组，界面据此隐藏该设置项。
     */
    listDisplays() {
      if (!bridge || typeof bridge.listDisplays !== 'function') return Promise.resolve([]);
      return bridge.listDisplays().catch(() => []);
    },

    /** 相框窗口"第一张已画出来"回执（主进程据此把主窗口隐藏，避免闪一下） */
    framePainted(info) {
      if (!bridge || typeof bridge.framePainted !== 'function') return Promise.resolve(false);
      return bridge.framePainted(info).catch(() => false);
    },

    /** 订阅"相框窗口已关闭"（主窗口据此复位按钮状态） */
    onFrameClosed(cb) {
      if (!bridge || typeof bridge.onFrameClosed !== 'function' || typeof cb !== 'function') return;
      try { bridge.onFrameClosed(cb); } catch (e) { /* 忽略 */ }
    },

    /**
     * 订阅"相框窗口被拖动后落位"，回传真实矩形。
     * 原生拖拽（-webkit-app-region: drag）由系统接管，渲染进程拿不到拖动过程，
     * 所以只在拖完那一刻由主进程回传一次 —— 吸附判定就跑在这一刻。
     */
    onFrameMoved(cb) {
      if (!bridge || typeof bridge.onFrameMoved !== 'function' || typeof cb !== 'function') return;
      try { bridge.onFrameMoved(cb); } catch (e) { /* 忽略 */ }
    },

    /* ---------- 桌面集成（菜单 / 右键菜单 / 托盘 / 任务栏 / 全局快捷键） ----------
       全部只在 Electron 下可用；无桥时各自返回安全的空值，
       调用方（App）按 can* 决定要不要显示对应入口。 */

    /** 原生应用菜单是否可用（决定要不要把菜单勾选态推过去） */
    get canMenu() { return !!(bridge && typeof bridge.setMenuState === 'function'); },

    /** 原生右键菜单是否可用（不可用时保持网页默认行为） */
    get canContextMenu() { return !!(bridge && typeof bridge.contextMenu === 'function'); },

    /** 系统托盘是否可用 */
    get canTray() { return !!(bridge && typeof bridge.setTray === 'function'); },

    /** 全局快捷键是否可用 */
    get canHotkey() { return !!(bridge && typeof bridge.setHotkey === 'function'); },

    /** 订阅原生菜单/托盘发来的命令 id */
    onCommand(cb) {
      if (!bridge || typeof bridge.onCommand !== 'function' || typeof cb !== 'function') return;
      try { bridge.onCommand(cb); } catch (e) { /* 忽略 */ }
    },

    /** 把菜单勾选态推给主进程（让它重建菜单） */
    setMenuState(st) {
      if (!bridge || typeof bridge.setMenuState !== 'function') return Promise.resolve(false);
      return bridge.setMenuState(st).catch(() => false);
    },

    /**
     * 弹原生右键菜单；返回被点中的命令 id，或 null（关掉没选）。
     * 无桥时返回 null —— 调用方据此不做任何事（网页默认菜单照常）。
     */
    contextMenu(payload) {
      if (!bridge || typeof bridge.contextMenu !== 'function') return Promise.resolve(null);
      return bridge.contextMenu(payload).catch(() => null);
    },

    /** 在系统文件管理器里定位文件；返回是否成功 */
    showInFolder(p) {
      if (!bridge || typeof bridge.showInFolder !== 'function' || !p) return Promise.resolve(false);
      return bridge.showInFolder(p).catch(() => false);
    },

    /** 任务栏进度条。value ∈ [0,1] 显示，< 0 收起；mode='indeterminate' 表示总数未知。 */
    setProgress(value, mode) {
      if (!bridge || typeof bridge.setProgress !== 'function') return Promise.resolve(false);
      return bridge.setProgress(value, mode).catch(() => false);
    },

    /** 托盘开关 + 关闭行为；返回托盘是否真的活着 */
    setTray(st) {
      if (!bridge || typeof bridge.setTray !== 'function') return Promise.resolve(false);
      return bridge.setTray(st).catch((e) => { warnOnce('setTray', e); return false; });
    },

    /** 注册/注销全局快捷键；返回 {ok, registered, why?} */
    setHotkey(accel) {
      if (!bridge || typeof bridge.setHotkey !== 'function') {
        return Promise.resolve({ ok: false, registered: false, why: 'unsupported' });
      }
      return bridge.setHotkey(accel || '').catch((e) => {
        warnOnce('setHotkey', e);
        return { ok: false, registered: false, why: String((e && e.message) || e) };
      });
    },

    /** 桌面集成状态（诊断用） */
    desktopInfo() {
      if (!bridge || typeof bridge.desktopInfo !== 'function') return Promise.resolve(null);
      return bridge.desktopInfo().catch(() => null);
    },
  };
  global.Native = Native;

  if (!bridge) return; // 无桥（非 Electron 部署）：不注册任何启动逻辑

  /* 启动后自动打开上次目录（“打开即开上次目录”）。
     注意：「打开文件夹」按钮不再由这里拦截 —— 该逻辑已收敛回 App.wireFolder()，
     统一调 Native.pickFolder()。此前那套 capture 阶段 preventDefault + stopPropagation
     的"抢按钮"写法既脆又难追踪，已移除。 */
  function runAuto() {
    if (runAuto.done) return;
    runAuto.done = true;
    // 相框窗口只负责播放主窗口传过来的清单，不要去索引上次目录
    if (/[?&]frame=1/.test(global.location.search)) return;
    Native.autoDir().then((dir) => {
      if (dir && global.Loader && !global.Loader.isIndexing) global.Loader.fromNative(dir, true);
    }).catch(() => {});
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runAuto, { once: true });
  } else {
    runAuto();
  }
})(window);
