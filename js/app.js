/* ============================================================
   Atrium · app.js
   总装：视图切换 / 多文件夹来源条 / 底部状态栏 / 分页 /
   工具栏交互 / 键盘 / 拖拽 / 演示自检
   ============================================================ */
(function (global) {
  'use strict';

  const Util = global.Util;
  const $ = Util.$;
  // 无障碍共用件（播报区 / 焦点陷阱）。构建脚本有 guard token 保证它进包，
  // 这里仍保留 null 判断：读屏播报挂掉不该让整个应用崩。
  const A11y = global.A11y;

  /* 全局快捷键的固定组合。为什么写死而不让用户自定义：这个组合本身没争议，
     而"让用户自己填加速键"意味着要处理一整套格式校验与冲突提示；
     注册失败会如实回滚并提示，比给一个半成品的输入框诚实得多。 */
  const HOTKEY_ACCEL = 'Ctrl+Alt+A';

  /* 窄窗阈值（单位 px，与 css/main.css 里的媒体查询同一套参数）。
     低于这个宽度，212px 的侧栏让内容区放不下像样的多列，自动收起。
     为什么不取 900 这个整数：实测 setContentSize(900) 在本机会得到
     innerWidth = 901（1.25 缩放下窗口边框要吃掉一像素的分数），
     阈值压在整百上会一边界不触发。取 940 而不是更小的整数，
     是给「内容区 ≥ 680px 还能排三列」留的余量。 */
  const NARROW_SIDE_MQ = '(max-width: 940px)';

  /* 烘焙导出用哪种编码。canvas 只能编这三种，其余源格式（gif / bmp / avif /
     heic / tif / svg / ico…）一律落回 PNG —— 关键是**返回的扩展名要跟着走**，
     否则会写出「名字叫 x.bmp、内容其实是 PNG」的文件，看图软件按扩展名选
     解码器，双击直接打不开。 */
  const BAKE_FORMATS = {
    jpg: { mime: 'image/jpeg', ext: 'jpg', q: 0.92 },
    jpeg: { mime: 'image/jpeg', ext: 'jpg', q: 0.92 },
    jfif: { mime: 'image/jpeg', ext: 'jpg', q: 0.92 },
    png: { mime: 'image/png', ext: 'png' },
    webp: { mime: 'image/webp', ext: 'webp', q: 0.92 },
    __png: { mime: 'image/png', ext: 'png' },
  };

  const App = {
    /* 版本号唯一来源：界面（设置面板底部）与构建脚本共用，报障时可一眼确认版本 */
    VERSION: '1.20.9',
    el: {},
    resizeToken: null,
    /** 弹层标题 id 的自增序号（可及名称用，见 modal()） */
    _modalSeq: 0,

    /* ================= 初始化 ================= */
    init() {
      const E = this.el;
      E.topbar = $('#topbar');
      E.emptyView = $('#emptyView');
      E.galleryView = $('#galleryView');
      E.statusline = $('#statusline');
      E.statusText = $('#statusText');
      E.prog = $('#prog');
      E.progBar = $('#progBar');
      E.modeSeg = $('#modeSeg');
      E.ctrls = $('#ctrls');
      E.sizeCtl = $('#sizeCtl');
      E.sizeRange = $('#sizeRange');
      E.sortKey = $('#sortKey');
      E.sortDir = $('#sortDir');
      E.searchInput = $('#searchInput');
      E.searchBox = $('#searchBox');
      E.searchToggle = $('#searchToggle');
      E.searchClear = $('#searchClear');
      E.brandEye = $('#brandEye');
      E.pinBtn = $('#pinBtn');
      E.capbar = $('#capbar');
      E.capRight = $('#capRight');
      E.frameBtn = $('#frameBtn');
      E.favOnlyBtn = $('#favOnlyBtn');
      E.workspace = $('#workspace');
      E.sidebar = $('#sidebar');
      E.sideToggle = $('#sideToggle');
      E.sideCollapse = $('#sideCollapse');
      E.sideActive = $('#sideActive');
      E.srcList = $('#srcList');
      E.btnAddFolder = $('#btnAddFolder');
      E.viewbar = $('#viewbar');
      E.footNote = $('#footNote');
      E.footErr = $('#footErr');
      E.pageInfo = $('#pageInfo');
      E.pagePrev = $('#pagePrev');
      E.pageNext = $('#pageNext');
      E.pageSizeSel = $('#pageSizeSel');
      E.noResult = $('#noResult');
      E.noResultText = $('#noResultText');
      E.clearFilters = $('#clearFilters');
      E.dropZone = $('#dropZone');
      E.selBar = $('#selBar');
      E.sbCount = $('#sbCount');
      E.sbDel = $('#sbDel');
      E.sbExport = $('#sbExport');

      this.page = 1;       // 当前页码
      this._pages = 1;
      this._view = [];     // 缓存：当前过滤+排序后的全量列表
      this.trash = [];     // 最近删除记录（桌面版：跨启动保留，可撤销）

      // 图库与灯箱
      Grid.mount($('#stage'), {
        onOpen: (item, list) => Lightbox.open(State.viewList(), item),
        onDelete: (item) => this.requestDelete(item),
        onSelect: (n, list) => this.onSelChanged(n, list),
        // 「只看收藏」下取消了某张的收藏 → 列表里不该再留下它
        onFavRemoved: () => this.applyView(false),
      });
      Lightbox.init({
        onClose: (changedMeta) => this.onLightboxClosed(changedMeta),
        onDelete: (meta) => this.requestDelete(meta, { fromLightbox: true }),
      });

      // 回收站视图（删掉的图片在这里找回）
      if (global.Trash) {
        global.Trash.init({
          onRestore: (recs) => this.restoreFromTrash(recs),
          onForget: (recs) => this.forgetTrash(recs),
          onClear: () => this.clearTrash(),
          onClose: () => this.closeTrash(),
          onToast: (m, o) => this.toast(m, o),
        });
      }

      // 设置面板（顶栏最右端齿轮）
      if (global.Settings) {
        global.Settings.init({
          apply: (key, val) => this.applySetting(key, val),
          onOpen: () => { if (E.trashPanel && !E.trashPanel.hidden) this.toggleTrash(false); },
        });
      }

      this.wireControls();
      this.wireSelBar();
      this.wireFolder();
      this.wireSidebar();
      this.wireDrop();
      this.wireKeyboard();
      this.wireDesktop();
      this.subscribeBus();

      // 尺寸滑杆初值（按持久模式）
      this.applyModeUI();
      this.syncSortUI();
      // 隐私模式（闭眼模糊）恢复上次状态
      this.applyBlurUI();
      // 窗口标题栏：先把置顶按钮归位（有 WCO 就进标题栏，见 relocatePin），
      // 再与真实窗口状态对齐 —— 顺序反了会让按钮先按顶栏样式亮一下再跳位置。
      this.relocatePin();
      // 窗口置顶（仅桌面版）：先把按钮摆好，再与真实窗口状态对齐
      this.applyPinUI();
      // 相框：按设置决定顶栏图标显隐。
      // 与 applyPinUI 同构 —— 此前漏了这一步，导致"隐藏相框入口"重启后不生效。
      this.applyFrameUI();
      // 多显示器的屏幕清单（异步拉一次）：只有一块屏时设置里不会出现「输出屏幕」那一行，
      // 所以清单到达后若数量与之前不同、而设置面板正开着，重建一次把新行显示出来。
      if (global.Native && global.Native.listDisplays) {
        global.Native.listDisplays().then((list) => {
          const arr = Array.isArray(list) ? list : [];
          const before = (State.displays || []).length;
          State.displays = arr;
          const p = document.getElementById('setPanel');
          if (arr.length !== before && p && !p.hidden && global.Settings && global.Settings.build) {
            global.Settings.build();
          }
        }).catch(() => {});
      }
      if (global.Native && global.Native.canPin) {
        const want = !!State.settings.alwaysOnTop;
        global.Native.setAlwaysOnTop(want).then((real) => {
          if (typeof real === 'boolean' && real !== want) {
            State.setSetting('alwaysOnTop', real);
            this.applyPinUI();
          }
        }).catch(() => {});
      }
      // 外观类设置（主题 / 密度 / 文件名 / 数量角标）启动时先应用一次
      for (const k of ['theme', 'accent', 'density', 'showNames', 'showCnt', 'sidebarOpen']) this.applySetting(k, State.settings[k]);
      // 主题定下来之后再推标题栏配色（浮层是系统画的，读不到 CSS 变量）
      this.wireCapOverlay();
      this.applySetting('wheelMode', State.settings.wheelMode);
      this.applySetting('animOn', State.settings.animOn);
      // 桌面集成（托盘 / 关闭行为 / 全局快捷键）：与真实系统状态对齐。
      // 传 quiet=true —— 这是启动对齐而非用户操作，失败时只回滚开关、不弹紧急播报。
      this.applySetting('trayOn', State.settings.trayOn, true);
      this.applySetting('trayClose', State.settings.trayClose, true);
      this.applySetting('hotkeyOn', State.settings.hotkeyOn, true);
      // 把界面状态推给主进程，让原生菜单的勾选态与真实状态一致
      this.syncMenu();

      /* 版本更新检测（默认关闭）：开启时才在启动后查一次。
         刻意 setTimeout 延后、且不 await —— 它是一次纯附加的网络请求，
         绝不能拖慢首屏或挡住界面；失败时静默（见 runUpdateCheck 的 silent 语义）。 */
      if (State.settings.updateCheck) setTimeout(() => this.runUpdateCheck(true), 1500);

      document.body.dataset.booted = '1';
    },

    /* ================= 设置项生效 ================= */
    /**
     * 所有设置项的「实际生效」都收敛在这里，方便排查与恢复默认时全量重放。
     * 纯 UI 项（主题 / 密度 / 文件名 / 角标）只切 body 上的类或属性，
     * 由 CSS 负责表现，避免 JS 到处改样式。
     *
     * quiet=true 表示**这是启动时的状态对齐、不是用户刚拨了开关**：
     * 此时托盘 / 全局快捷键若在当前环境建不起来，仍然如实回滚开关
     * （设置面板上会显示成关，不留"看着开着、其实没有"的假状态），
     * 但**不发紧急播报**。理由有两条：
     *   ① 启动时用户没做任何操作，没人需要对一条错误提示"负责"，
     *      每次开应用都弹一次"托盘不可用"是纯噪音；
     *   ② 那条播报会把常驻播报区改成 role=alert / assertive 并留在那儿
     *      （A11y.live 按 urgency 改档，改完不复位），
     *      于是"播报区静止态是 polite/status"这个前提被破坏 ——
     *      无障碍回归里那条静态语义断言就会随环境随机变红。
     */
    applySetting(key, val, quiet) {
      const b = document.body;
      switch (key) {
        /* --- 外观 --- */
        case 'theme': {
          b.dataset.theme = val;
          if (this._themeMQ) { try { this._themeMQ.onchange = null; } catch (e) { /* 忽略 */ } this._themeMQ = null; }
          if (val === 'auto' && global.matchMedia) {
            this._themeMQ = global.matchMedia('(prefers-color-scheme: dark)');
            const on = () => {
              b.dataset.theme = this._themeMQ.matches ? 'dark' : 'light';
              // 系统跟着切的时候，自定义强调色要按**新模式**重算一遍：
              // 同一支黄，浅色下要压暗当文字、深色下要提亮当图标，不能沿用旧的一套。
              this.applyAccent();
            };
            try { this._themeMQ.addEventListener('change', on); } catch (e) { this._themeMQ.onchange = on; }
            on();
          }
          this.applyAccent();
          break;
        }
        /* 强调色（v1.20.0）。这里必须有一个分支 —— 否则设置面板里点了色块只会
           写进 State、界面纹丝不动，正是本项目栽过五次的那种静默失效。
           推导与写入全在 Theme.apply() 里（纯函数算值、apply 写 body 行内样式）。 */
        case 'accent':
          this.applyAccent();
          break;
        case 'density':
          b.dataset.density = val;
          if (global.Grid && global.Grid.layout) requestAnimationFrame(() => global.Grid.layout(true));
          break;
        /* 排列模式（v1.12.0）：设置面板与顶栏分段按钮是**同一个值**（State.settings.mode）。
           这里必须有一个分支 —— 否则在设置里点「瀑布流」只会写进状态、界面纹丝不动，
           正是本项目栽过五次的"功能写好了但没接到调用链上"（静默失效）。
           resetTop=true：换排列方式后回到顶部，与点顶栏图标的行为保持一致。 */
        case 'mode':
          this.applyModeUI(true);
          break;
        case 'showNames':
          b.dataset.showNames = val ? '1' : '0';
          break;
        case 'showCnt':
          b.dataset.showCnt = val ? '1' : '0';
          break;
        case 'sidebarOpen':
          this.applySidebarUI(val);
          break;

        /* --- 浏览与查看 --- */
        case 'wheelMode':
          if (global.Lightbox) {
            global.Lightbox.wheelMode = val;
            if (global.Lightbox._setWheelUI) global.Lightbox._setWheelUI();
          }
          break;
        case 'animOn':
          b.dataset.anim = val ? '1' : '0';
          break;
        case 'infoAuto':
          if (global.Lightbox) global.Lightbox.autoInfo = !!val;
          break;
        case 'stripAuto':
          if (global.Lightbox) global.Lightbox.autoStrip = !!val;
          break;
        case 'slideshowMs':
          if (global.Lightbox) {
            global.Lightbox.playMs = Number(val) || 3800;
            // 正在播放时立刻按新间隔重启计时器，无需等到下一张
            if (global.Lightbox.playing) { global.Lightbox.stopPlay(); global.Lightbox.startPlay(); }
          }
          break;

        /* --- 隐私与安全 --- */
        case 'confirmDelete':
          break;    // 在 requestDelete 里直接读 State.settings
        case 'blurPreview':
          this.applyBlurUI();
          break;
        case 'updateCheck':
          /* 「启动时检查更新」（v1.14.0）。它不是纯 UI 开关 —— 拨开的那一刻就真的
             出一次网，所以这里必须有分支：否则用户拨开开关后要等到**下次启动**
             才知道它有没有用，等于一个"点了没反应"的开关（本项目对死开关零容忍）。
             启动重放（quiet=true）**不在这里查** —— 那一次由 init() 统一触发，
             免得每开一次应用就多打一次接口。 */
          if (val && !quiet) this.runUpdateCheck(false);
          break;

        /* --- 数据 --- */
        case 'rememberLast':
          // 关掉时立刻清掉主进程记住的「上次目录」，否则下次启动照样自动打开。
          if (!val && global.Native) global.Native.clearLastDir();
          break;

      /* --- 窗口（仅桌面版；浏览器模式按钮不出现，这里空转） --- */
      case 'alwaysOnTop':
        /* 这里曾经只有 `this.applyPinUI()` —— 一个**假开关**：用户拨开后
           开关变亮、原生菜单的勾也一起打上，但窗口根本没动，要等下次启动
           由 init() 推给主进程才真的生效。菜单勾选跟着一起撒谎，用户更难自查。
           现在和顶栏按钮走同一条 IPC，并以主进程回传的**实际生效值**校正
           （某些环境会拒绝置顶，那时要如实退回，不能显示成"已置顶"）。 */
        if (global.Native && global.Native.canPin && global.Native.setAlwaysOnTop) {
          global.Native.setAlwaysOnTop(!!val).then((real) => {
            if (typeof real === 'boolean' && real !== !!val) {
              State.setSetting('alwaysOnTop', real);
              this.toast(real ? '已置顶窗口' : '未能置顶：系统未接受该请求', { urgent: !real });
            }
            this.applyPinUI();
          }).catch(() => this.applyPinUI());
        } else {
          this.applyPinUI();
        }
        break;

      /* --- 相框（v1.11.0 起为正式功能；浏览器模式退化为页内浮层） --- */
      case 'showFrame':
        // 关掉入口时若正在相框模式，先退出来 —— 不允许出现
        // "功能被藏起来了，但屏幕还在轮播"这种没人能控制的状态。
        // exitFrame() 内部已经调过 applyFrameUI()，下面再调一次是幂等的。
        if (!val && this.frameOn) this.exitFrame();
        this.applyFrameUI();
        break;
      case 'frameDock':
        // 停靠边在"进相框那一刻"由 Frame.start() 读取并交给相框窗口，主窗口这边
        // 没有对应的界面元素要刷（且相框播放时设置面板打不开），故此处显式空转。
        break;
      case 'frameDisplay':
        // 输出屏幕**必须当场生效**：改这个设置时用户正盯着一块屏幕，
        // 若"下次进相框才生效"就等于开关点了没反应。退出再开最稳 ——
        // 窗口位置与尺寸都会按新屏幕的工作区重新算一遍。
        if (this.frameOn) {
          this.exitFrame();
          setTimeout(() => { if (State.settings.showFrame) this.toggleFrame(); }, 220);
        }
        break;

      /* --- 桌面集成（托盘 / 关闭行为 / 全局快捷键） --- */
      case 'trayOn': {
        if (!global.Native || !global.Native.canTray) break;
        // 托盘开关与"关闭行为"是同一条 IPC 的两个字段：一起推，免得两次往返之间
        // 出现"托盘已建好但关闭行为还是旧值"的窗口期。
        global.Native.setTray({ on: !!val, closeOn: !!State.settings.trayClose }).then((alive) => {
          if (val && !alive) {
            // 建不起来（缺图标 / 系统拒绝）→ 如实回滚开关并告知。
            // 留一个"看着开着、其实没有"的开关，是本项目最反对的那种坏法。
            State.setSetting('trayOn', false);
            if (global.Settings && global.Settings.sync) global.Settings.sync();
            if (!quiet) this.toast('系统托盘未能启用（当前环境不支持），该项已自动关闭', { urgent: true });
          }
        }).catch(() => {});
        break;
      }
      case 'trayClose':
        if (global.Native && global.Native.canTray) {
          global.Native.setTray({ on: !!State.settings.trayOn, closeOn: !!val });
        }
        break;
      case 'hotkeyOn': {
        if (!global.Native || !global.Native.canHotkey) break;
        global.Native.setHotkey(val ? HOTKEY_ACCEL : '').then((r) => {
          if (!val) return;
          if (!r || !r.ok) {
            State.setSetting('hotkeyOn', false);
            if (global.Settings && global.Settings.sync) global.Settings.sync();
            if (!quiet) this.toast('全局快捷键设置无效：' + ((r && r.why) || '未知原因'), { urgent: true });
            return;
          }
          if (!r.registered) {
            // 被别的程序占用 —— 这是最常见的失败，必须说清楚，不能让开关白开着
            State.setSetting('hotkeyOn', false);
            if (global.Settings && global.Settings.sync) global.Settings.sync();
            if (!quiet) this.toast('全局快捷键 ' + HOTKEY_ACCEL + ' 已被其它程序占用，未能注册', { urgent: true });
            return;
          }
          // 成功提示同样只在"用户刚拨开"时说；启动对齐时不必每次开应用都播一遍
          if (!quiet) this.toast('已启用全局快捷键 ' + HOTKEY_ACCEL + '：任何时候按它都能把窗口叫到前台');
        }).catch(() => {});
        break;
      }

      default:
        break;
      }
      // 菜单勾选态与界面状态保持一致（模式 / 收藏筛选 / 隐私模式 / 置顶 / 是否有选中）
      this.syncMenu();
    },

    /** 把强调色落到页面上（v1.20.0）。
        真正的推导在 Theme.derive()（纯函数、可单测），这里只做两件事：
        ① 调 Theme.apply() 写 body 行内样式；② 让需要"自己算一遍颜色"的地方跟上。
        目前只有一处：主进程画的窗口标题栏浮层只吃 --paper / --ink-2，
        不吃强调色，所以没有额外推送 —— 若将来标题栏要用强调色，在这里补推。 */
    applyAccent() {
      if (global.Theme) global.Theme.apply();
    },

    /* ================= 版本更新检测（v1.14.0，仅桌面版） ================= */
    /**
     * 查有没有新版本。
     * silent=true 表示"启动时的自动检查"：**没更新、或检查失败，都一声不吭**
     *   —— 每次开应用都弹一条"检查失败"是纯噪音（与托盘/快捷键启动对齐同一个取舍）。
     *   只有真的发现新版本才提示，并给一个「查看」的动作。
     * silent=false（用户刚拨开开关 / 手点按钮）：三种结果都要说话，
     *   尤其"检查失败"必须与"已是最新"分开说 —— 把"没连上网"说成"已是最新"
     *   是这类功能最常见的谎报。
     */
    runUpdateCheck(silent) {
      const N = global.Native;
      if (!N || !N.canUpdate) {
        if (!silent) this.toast('当前环境不支持检查更新', { urgent: true });
        return;
      }
      return N.checkUpdate(this.VERSION || '').then((r) => {
        if (!r || !r.ok) {
          if (!silent) this.toast('检查更新失败：' + this._updateErrText(r && r.reason), { urgent: true });
          return;
        }
        if (r.hasUpdate) {
          this.toast('发现新版本 v' + r.latest + '（当前 v' + r.current + '）', {
            duration: 6000,
            action: { label: '查看', onClick: () => this.openExternal(r.url) },
          });
        } else if (!silent) {
          this.toast('已是最新版本（v' + r.current + '）');
        }
      }).catch(() => { /* 已在 Native 侧吞掉；这里只是别让 Promise 漏出去 */ });
    },

    /**
     * 打开外部链接（官方仓库 / Releases）。
     * **只走主进程白名单** —— 渲染层不做任何 URL 判断（判断放主进程，
     * 才不会被页内注入的脚本绕过）。被拒或打不开时如实告知，不静默。
     */
    openExternal(url) {
      const N = global.Native;
      if (!N || typeof N.openExternal !== 'function') {
        this.toast('当前环境不支持打开外部链接', { urgent: true });
        return;
      }
      N.openExternal(url).then((ok) => {
        if (!ok) this.toast('未能在浏览器中打开该链接', { urgent: true });
      }).catch(() => {});
    },

    /** 把 checkUpdate 的 reason 翻成用户看得懂的一句话（各调用点共用，避免两处措辞漂移） */
    _updateErrText(reason) {
      const r = String(reason == null ? '' : reason);
      if (r === 'timeout') return '网络超时（访问 GitHub 不通）';
      if (r === 'network') return '无法连接网络';
      if (r === 'unsupported') return '当前环境不支持';
      if (r === 'bad-response') return '接口返回了无法识别的数据';
      if (r.indexOf('http-') === 0) return 'GitHub 返回 ' + r.slice(5);
      return '未知原因';
    },

    /* ================= 搜索框展开 / 收起 ================= */
    openSearch() {
      const E = this.el;
      this._searchFocusAt = Date.now();       // 记录用户主动展开的时刻，避免 blur 立即收起
      E.searchBox.classList.add('is-open');
      E.searchToggle.setAttribute('aria-expanded', 'true');
      // 窄窗口下控件区可横滚：确保展开后的搜索框完整可见
      requestAnimationFrame(() => {
        try {
          E.searchBox.scrollIntoView({ inline: 'end', block: 'nearest', behavior: Util.scrollBehavior() });
        } catch (err) { /* 忽略 */ }
        if (this._updCtrlScroll) setTimeout(this._updCtrlScroll, 260);
        E.searchInput.focus();
      });
    },
    closeSearch(force) {
      const E = this.el;
      if (!force && E.searchInput.value) return;   // 有内容时保持展开
      E.searchBox.classList.remove('is-open');
      E.searchToggle.setAttribute('aria-expanded', 'false');
    },

    /* ================= 隐私模式（闭眼模糊） ================= */
    applyBlurUI() {
      const on = !!State.settings.blurPreview;
      document.body.classList.toggle('privacy-blur', on);
      const E = this.el;
      if (E.brandEye) {
        E.brandEye.classList.toggle('is-blur', on);
        E.brandEye.innerHTML = Util.icon(on ? 'i-eye-off' : 'i-eye');
        E.brandEye.title = on ? '睁眼：恢复正常显示' : '闭眼：模糊预览（隐私模式）';
        E.brandEye.setAttribute('aria-pressed', String(on));
      }
      // 设置面板里的同名开关同步（顶栏眼睛与设置项是同一个状态的两个入口）
      if (global.Settings && global.Settings.sync) global.Settings.sync();
      this.syncMenu();
    },
    toggleBlur() {
      State.setSetting('blurPreview', !State.settings.blurPreview);
      this.applyBlurUI();
    },

    /* ================= 窗口标题栏（Windows：Window Controls Overlay） =================
       主进程用 titleBarStyle:'hidden' + titleBarOverlay 把原生最小化/最大化/关闭
       变成右上角浮层，标题栏本体交给这里画（见 index.html 的 .capbar）。

       置顶按钮的归属就靠这一段决定：有 WCO → 移进标题栏，正好落在「最小化」左侧，
       和窗口控制键成为一组；没有 WCO（非 Windows）→ 留在顶栏控件簇里，维持原样。

       判断依据是 `navigator.windowControlsOverlay` 存不存在 —— 这是渲染进程自己
       就能拿到的事实，不必让主进程再同步一遍「你有没有标题栏」。 */
    relocatePin() {
      const E = this.el;
      if (!E.pinBtn || !E.capbar) return;
      /* 判据是 **visible**，不是"这个 API 存不存在"：Electron 在**所有**窗口里都注入
         navigator.windowControlsOverlay，没有浮层的窗口只是 `visible === false`、
         getTitlebarAreaRect() 全 0（实测）。按存在性判断会把"没有标题栏浮层"的窗口
         也当成有浮层 —— 页面整体被压下 34px，界面上什么都不会缺，
         只有几何类断言会发现（居中套件当场报"纵向下偏 34px"）。 */
      const wco = !!(navigator.windowControlsOverlay && navigator.windowControlsOverlay.visible);
      const changed = document.body.classList.contains('has-wco') !== wco;
      document.body.classList.toggle('has-wco', wco);
      E.capbar.hidden = !wco;
      /* 标题栏是「顶部 chrome」的一部分，它一变，单列槽位高度与吸附位全都要跟着变。
         生产上这一步发生在装图之前（init 里只调一次），但**别依赖这个顺序** ——
         判定结果变化却不重排的话，几何会停在旧值上：单列每张图顶部被控制栏吃掉 34px。 */
      if (changed) this.afterChromeChange();
      if (wco && E.capRight && E.pinBtn.parentElement !== E.capRight) {
        E.capRight.appendChild(E.pinBtn);
      }
      // 标题栏整条可拖窗口，但双击要能最大化/还原 —— 原生标题栏被浮层取代后
      // 系统不再提供这个行为，得自己补（见 preload 的 toggleMaximize）。
      if (wco && !E.capbar.dataset.wired) {
        E.capbar.dataset.wired = '1';
        E.capbar.addEventListener('dblclick', (ev) => {
          // 只认标题栏空白与标题文字：双击按钮不应最大化
          if (ev.target.closest('button')) return;
          if (global.Native && global.Native.toggleMaximize) global.Native.toggleMaximize();
        });
      }
    },

    /** 顶部 chrome 高度变了：让网格按新的可见区重排。
        单列的槽位高度与吸附位都由「chrome 下沿」推导（见 Grid._chrome），
        标题栏出现/消失会整体改变它 —— 不重排就停在旧几何上。
        init 阶段调用时还没装图（N=0），这里什么也不做。 */
    afterChromeChange() {
      if (global.Grid && global.Grid.N) global.Grid.layout(false);
    },

    /** 把当前主题的标题栏配色推给主进程（浮层是系统画的，不吃 CSS 变量）。
        监听 body[data-theme] 的变化而不是在 applySetting 里各写一处 ——
        主题有三条来路（设置项、auto 跟随系统、启动重放），盯属性只有一处。

        **没有标题栏浮层时直接不推**（非 Windows / 没有 WCO）：推了也没有接收方，
        而在探针那种只有最小主进程的环境里，这会变成一条 `No handler registered`
        的页面错误 —— 顶栏之外的所有套件都有「探针过程中无页面报错」这条断言，
        于是"多推一次无用的 IPC"会把无关套件全部染红。 */
    wireCapOverlay() {
      if (!global.Native || !global.Native.syncTitleBarOverlay) return;
      if (!document.body.classList.contains('has-wco')) return;
      const push = () => {
        const cs = getComputedStyle(document.body);
        const color = cs.getPropertyValue('--paper').trim();
        const symbolColor = cs.getPropertyValue('--ink-2').trim();
        if (!color || !symbolColor) return;
        global.Native.syncTitleBarOverlay({ color, symbolColor });
      };
      this._syncCapOverlay = push;
      try {
        new MutationObserver(push).observe(document.body, { attributes: true, attributeFilter: ['data-theme'] });
      } catch (e) { /* 老引擎没有 MutationObserver：下面 init 时至少推一次 */ }
      push();
    },

    /* ================= 窗口置顶 =================
       渲染进程没有窗口控制能力，真正的置顶由主进程完成；这里只负责
       按钮外观与状态。若原生桥不可用（不该发生），按钮整颗隐藏 ——
       而不是留一个点了没反应的按钮。 */
    applyPinUI() {
      const btn = this.el.pinBtn;
      if (!btn) return;
      const canPin = !!(global.Native && global.Native.canPin);
      btn.hidden = !canPin;
      if (!canPin) return;
      const on = !!State.settings.alwaysOnTop;
      btn.classList.toggle('is-on', on);
      btn.innerHTML = Util.icon(on ? 'i-pin-on' : 'i-pin');
      btn.title = on ? '已置顶：点击取消置顶' : '窗口置顶：让 Atrium 始终浮在其它窗口之上';
      btn.setAttribute('aria-pressed', String(on));
      this.syncMenu();
    },

    togglePin() {
      if (!global.Native || !global.Native.canPin) return;
      const next = !State.settings.alwaysOnTop;
      // 先按用户意图更新界面（即时反馈），再以主进程回传的「实际生效值」校正
      State.setSetting('alwaysOnTop', next);
      this.applyPinUI();
      global.Native.setAlwaysOnTop(next).then((real) => {
        if (typeof real === 'boolean' && real !== next) {
          State.setSetting('alwaysOnTop', real);
          this.applyPinUI();
          this.toast(real ? '已置顶窗口' : '未能置顶：系统未接受该请求', { urgent: !real });
          return;
        }
        this.toast(next ? '已置顶窗口' : '已取消置顶');
      }).catch(() => { this.toast('未能置顶：系统未接受该请求', { urgent: true }); });
    },

    /* ================= 相框模式 =================
       一个"电子相框"：随机轮播某个相册（文件夹 / 收藏夹）里的图片。

       正式形态：主进程另开一个**无边框 + 置顶 + 按图片比例**的窗口
       （index.html?frame=1），主窗口先隐藏，退出相框再请回来。
       降级形态：若相框窗口开不起来（frameOpen 失败），退化为页内整屏浮层
       + 全屏 API。两种形态的随机轮播、控制条、快捷键完全一致（同一份 frame.js）。 */
    frameOn: false,

    /** 顶栏相框按钮：开着就退出，没开就进入 */
    async toggleFrame() {
      if (this.frameOn) { this.exitFrame(); return 0; }
      return this.enterFrame();
    },

    /** 进入相框；返回实际可播放的张数（0 = 该相册里没图，已提示） */
    async enterFrame() {
      if (!global.Frame) return 0;
      // 别和灯箱/设置面板叠着，先收起来
      if (global.Lightbox && Lightbox.isOpen()) Lightbox.close();
      if (global.Settings && global.Settings.toggle) global.Settings.toggle(false);
      // 进相框前重读一次设置：frameDock 可能被上一个相框窗口（另一个渲染进程）
      // 拖窗口吸附时改过，主窗口内存里那份是旧的 —— 不复读就会把窗口摆回旧的那条边。
      State.reloadSettings();
      const n = await global.Frame.start();
      this.frameOn = n > 0;
      // 桌面版：真正的「在相框里」以主进程的窗口状态为准（开窗失败会降级成页内浮层）
      if (this.frameOn && global.Native && global.Native.canFrameWin) {
        const info = await global.Native.frameInfo().catch(() => null);
        if (info && !info.open) this.frameOn = !!(global.Frame && global.Frame.on);
      }
      this.applyFrameUI();
      // 页内浮层要告诉用户怎么出来；独立的相框窗口自带提示，不用 toast
      if (this.frameOn && !(global.Frame && global.Frame.remote)) {
        this.toast('相框已开启：单击下一张，Esc 退出', { duration: 4200 });
      }
      return n;
    },

    /** 退出相框（页内浮层直接关；独立的相框窗口由它自己关，主进程会回头通知） */
    exitFrame() {
      if (global.Frame && global.Frame.on) global.Frame.close();
      this.frameOn = false;
      this.applyFrameUI();
    },

    /** 按钮与真实状态对齐（相框窗口被 Alt+F4 关掉时也要复位） */
    applyFrameUI() {
      const btn = this.el.frameBtn;
      if (!btn) return;
      // 用 hidden 属性而不是把节点摘出 DOM —— 顶栏几何断言按 children 下标算
      // （probe_topbar.js 的 ctrlCount / pinIsLast），摘节点会直接打破它们。
      const shown = !!State.settings.showFrame;
      const on = !!this.frameOn;
      btn.hidden = !shown;
      // 即使隐藏也继续把外观刷全：避免留下过期的 aria-pressed / is-on（探针会读）
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', String(on));
      btn.title = on ? '相框模式：正在播放，点击退出' : '相框模式：随机轮播相册里的图片';
      this.syncMenu();
    },

    /* ================= 工具栏 ================= */
    wireControls() {
      const E = this.el;

      // 模式
      E.modeSeg.addEventListener('click', (e) => {
        const b = e.target.closest('.seg-btn');
        if (!b) return;
        const key = b.dataset.mode;
        if (key === State.settings.mode) return;
        State.setSetting('mode', key);
        this.applyModeUI(true);
      });

      // 尺寸滑杆（线性映射到 px；单列整屏模式下隐藏）
      E.sizeRange.addEventListener('input', () => {
        const mode = State.settings.mode;
        const [min, max] = State.MODES[mode].range;
        const v = Number(E.sizeRange.value) / 100;
        const px = Math.round(min + (max - min) * v);
        State.setModeSize(mode, px);
        this.paintSlider();
        Grid.setModeSize(px, false);
      });

      $('#sizeMinus').addEventListener('click', () => this.nudgeSize(-1));
      $('#sizePlus').addEventListener('click', () => this.nudgeSize(1));

      // 排序
      E.sortKey.addEventListener('change', () => {
        State.setSetting('sortKey', E.sortKey.value);
        this.applyView(true);
      });
      E.sortDir.addEventListener('click', () => {
        State.setSetting('sortDir', State.settings.sortDir === 1 ? -1 : 1);
        this.syncSortUI();
        this.applyView(true);
      });

      // 搜索：输入时实时过滤
      E.searchInput.addEventListener('input', Util.debounce(() => {
        State.filterText = E.searchInput.value;
        E.searchClear.hidden = !E.searchInput.value;
        this.applyView(true);
      }, 160));

      // 搜索：点击图标才展开输入框；再次点击（或失焦为空）收起
      E.searchToggle.addEventListener('click', () => {
        if (E.searchBox.classList.contains('is-open')) {
          if (!E.searchInput.value) this.closeSearch(true);
          else { E.searchInput.focus(); E.searchInput.select(); }
        } else {
          this.openSearch();
        }
      });
      E.searchInput.addEventListener('blur', () => {
        // 用户刚点开（<250ms）时忽略失焦，避免展开瞬间被立刻收起
        if (this._searchFocusAt && Date.now() - this._searchFocusAt < 250) return;
        setTimeout(() => {
          if (!E.searchInput.value) this.closeSearch(true);
        }, 160);
      });
      E.searchClear.addEventListener('click', () => {
        E.searchInput.value = '';
        State.filterText = '';
        E.searchClear.hidden = true;
        E.searchInput.focus();
        this.applyView(true);
      });

      // 收藏过滤（逻辑收敛到 toggleFavOnly：原生菜单 Ctrl+L 也要走同一份）
      E.favOnlyBtn.addEventListener('click', () => this.toggleFavOnly());

      // 清除过滤
      E.clearFilters.addEventListener('click', () => {
        E.searchInput.value = '';
        State.filterText = '';
        State.favOnly = false;
        E.favOnlyBtn.classList.remove('is-active', 'is-on');
        if (E.searchClear) E.searchClear.hidden = true;
        this.closeSearch();
        this.applyView(true);
        this.syncMenu();
      });

      // 最近删除 / 撤销删除（仅桌面版：需要原生回收站访问能力）
      if (global.Native && global.Native.active) this.wireTrash();

      // 品牌眼睛：闭眼模糊（隐私模式，状态持久化）
      if (E.brandEye) E.brandEye.addEventListener('click', () => this.toggleBlur());

      // 窗口置顶（仅桌面版可见；浏览器模式下按钮恒定隐藏）
      if (E.pinBtn) E.pinBtn.addEventListener('click', () => this.togglePin());

      // 相框模式（两种形态都有；桌面版会另开无边框置顶窗口）
      if (E.frameBtn) E.frameBtn.addEventListener('click', () => this.toggleFrame());
      // 相框窗口被关掉（Esc / ✕ / Alt+F4）→ 主进程通知回来，复位按钮。
      // 顺带重读一次设置：相框窗口是另一个渲染进程，用户在那里拖窗口吸附到某条边时
      // 会把 frameDock 写进 localStorage，主窗口内存里那份已经过期了。
      if (global.Native && global.Native.onFrameClosed) {
        global.Native.onFrameClosed(() => {
          this.frameOn = false;
          State.reloadSettings();
          this.applyFrameUI();
          if (global.Settings && global.Settings.el && global.Settings.el.panel && !global.Settings.el.panel.hidden) {
            global.Settings.build();
          }
        });
      }

      // 分页
      E.pagePrev.addEventListener('click', () => {
        if (this.page > 1) { this.page--; this.renderPage(); }
      });
      E.pageNext.addEventListener('click', () => {
        if (this.page < this._pages) { this.page++; this.renderPage(); }
      });
      E.pageSizeSel.addEventListener('change', () => {
        const v = Number(E.pageSizeSel.value);
        State.setSetting('pageSize', v);
        this.applyView(false);
      });

      // 底部状态栏自动隐藏：鼠标移入底部热区 / 状态栏本身，或页面滚到底时才显示
      this.wireViewbarAutoHide();
      // 顶栏控件区横滚提示（窄窗口）：滚到底时去掉右侧渐隐
      this.wireCtrlScrollHint();
    },

    /* ================= 顶栏控件区横滚提示 =================
       来源栏搬进左侧竖排列表后，这里只剩「右侧控件簇」一条横滚轴；
       来源列表是竖向滚动，滚动条本身就是提示，不需要再做渐隐。 */
    wireCtrlScrollHint() {
      const c = this.el.ctrls || Util.$('#ctrls');
      if (!c) return;
      const upd = () => {
        const scrollable = c.scrollWidth > c.clientWidth + 1;
        const atEnd = c.scrollLeft + c.clientWidth >= c.scrollWidth - 2;
        c.classList.toggle('at-end', atEnd);
        // 只在「确实需要横滚」时才启用 overflow 裁剪。
        // 否则 overflow-y:hidden 会把它下方弹出的浮层（如「最近删除」面板）裁成 0 高，
        // 表现就是点了没反应、点不进去。
        c.classList.toggle('is-scrollable', scrollable);
      };
      c.addEventListener('scroll', upd, { passive: true });
      global.addEventListener('resize', upd, { passive: true });
      if (global.ResizeObserver) {
        const ro = new ResizeObserver(upd);
        ro.observe(c);
        this._roCtrlScroll = ro;
      }
      this._updCtrlScroll = upd;
      requestAnimationFrame(upd);
    },

    /* ================= 底部状态栏自动隐藏 =================
       交互：鼠标移入底栏（或靠近屏幕底部热区）→ 立即显示；
             鼠标一移开 → 立即隐藏（且未停在底栏上）；
             例外：页面已滚动到真实底部时保持常显（此时用户正在看末尾内容）。 */
    wireViewbarAutoHide() {
      const E = this.el;
      const bar = E.viewbar;
      if (!bar) return;

      let hideTimer = null;
      const clearHide = () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } };

      const show = () => {
        clearHide();
        if (!bar.hidden) bar.classList.add('is-shown');
      };
      // 立即隐藏：除非鼠标仍停在底栏上，或页面处于“真实底部”（常显区）
      const hide = () => {
        clearHide();
        if (bar.matches(':hover')) return;
        if (this._atRealBottom()) return;
        bar.classList.remove('is-shown');
      };

      // 鼠标靠近屏幕底部（热区 30px 内）→ 显示；离开该区域 → 立即隐藏
      global.addEventListener('mousemove', (e) => {
        if (bar.hidden) return;
        if (e.clientY >= global.innerHeight - 30) show();
        else if (bar.classList.contains('is-shown')) hide();
      }, { passive: true });
      bar.addEventListener('mouseenter', show);
      bar.addEventListener('mouseleave', hide);

      // 页面滚动：滚到“真实底部”常显，否则立即收起
      global.addEventListener('scroll', () => {
        if (bar.hidden) return;
        if (this._atRealBottom()) show();
        else if (!bar.matches(':hover')) hide();
      }, { passive: true });

      // 窗口尺寸变化（含最大化/还原）后重新判断，避免状态残留
      global.addEventListener('resize', () => {
        if (bar.hidden) return;
        if (this._atRealBottom()) show(); else hide();
      }, { passive: true });

      this._showViewbar = show;
      this._hideViewbar = hide;
    },

    /**
     * 是否“真实地”滚动到了页面底部。
     * 关键：页面本身不足一屏（无需滚动）时返回 false —— 否则最大化后底栏会恒常显。
     */
    _atRealBottom() {
      const doc = document.documentElement;
      const max = Math.max(doc.scrollHeight, document.body.scrollHeight);
      if (max <= global.innerHeight + 2) return false;   // 无需滚动 → 不算“到底”
      return (global.innerHeight + (global.scrollY || 0)) >= max - 8;
    },

    applyModeUI(resetTop) {
      const E = this.el;
      const mode = State.settings.mode;
      E.modeSeg.querySelectorAll('.seg-btn').forEach((b) => {
        b.classList.toggle('is-on', b.dataset.mode === mode);
      });
      E.galleryView.classList.toggle('single', mode === 'single');
      /* 当前模式挂到容器上，供 CSS 区分视图。
         挂容器而不是逐个瓦片加类：模式切换时瓦片会重建，容器属性一处更新就全跟着走。
         data-crop 与 JS 的排布分支**同源**（都读 MODES[mode].crop）——
         两处各自判断的话，关掉标记后 CSS 还在裁、JS 已经不裁，会得到一半对一半错的界面。 */
      E.galleryView.dataset.mode = mode;
      E.galleryView.dataset.crop = (State.MODES[mode] && State.MODES[mode].crop) ? '1' : '0';
      // 单列整屏：尺寸滑杆不适用（高度由视口决定），隐藏
      E.sizeCtl.hidden = mode === 'single';
      // 滚动吸附开关（html 级 CSS class）
      document.documentElement.classList.toggle('snap-single', mode === 'single');

      const [min, max] = State.MODES[mode].range;
      E.sizeRange.min = '0'; E.sizeRange.max = '100';
      const px = State.getModeSize(mode);
      const v = Util.clamp(Math.round(((px - min) / (max - min)) * 100), 0, 100);
      E.sizeRange.value = String(v);
      this.paintSlider();


      Grid.setMode(mode, !!resetTop);
    },

    updateErrUI() {
      const E = this.el;
      E.footErr.textContent = State.errCount ? `${State.errCount} 张无法解码（格式不支持或已损坏）` : '';
      E.footErr.hidden = State.errCount === 0;
    },

    paintSlider() {
      const v = Number(this.el.sizeRange.value);
      this.el.sizeRange.style.setProperty('--fill', v + '%');
    },

    nudgeSize(dir) {
      const mode = State.settings.mode;
      if (mode === 'single') return; // 单列高度自动，禁用微调
      const px = State.getModeSize(mode) + dir * 12;
      State.setModeSize(mode, px);
      const [min, max] = State.MODES[mode].range;
      const v = Util.clamp(Math.round(((px - min) / (max - min)) * 100), 0, 100);
      this.el.sizeRange.value = String(v);
      this.paintSlider();
      Grid.setModeSize(px, false);
    },

    syncSortUI() {
      const desc = State.settings.sortDir === -1;
      this.el.sortDir.classList.toggle('desc', desc);
      this.el.sortDir.setAttribute('aria-label', desc ? '切换为升序' : '切换为降序');
      this.el.sortDir.innerHTML = Util.icon('i-sortdir');
    },

    /* ================= 批量选择（框选 / 勾选） ================= */
    /** 底部浮动选择条：选中数、全选/反选/取消、导出所选、批量删除 */
    wireSelBar() {
      const E = this.el;
      if (!E.selBar) return;
      const all = $('#sbAll');
      const inv = $('#sbInv');
      const none = $('#sbNone');
      if (all) all.addEventListener('click', () => {
        const full = Grid.selectedCount() > 0 && Grid.selectedCount() >= Grid.items.length;
        Grid.selectAll(!full);
      });
      if (inv) inv.addEventListener('click', () => Grid.invert());
      if (none) none.addEventListener('click', () => Grid.clearSel());
      if (E.sbExport) E.sbExport.addEventListener('click', () => this.exportSelected(Grid.selected()));
      if (E.sbDel) E.sbDel.addEventListener('click', () => this.requestDeleteMany(Grid.selected()));
    },

    /** 选中集合变化 → 更新选择条（可删除性按来源能力实时判定） */
    onSelChanged(n, list) {
      const E = this.el;
      if (!E.selBar) return;
      if (!n) { E.selBar.hidden = true; this.syncMenu(); return; }
      E.selBar.hidden = false;
      E.sbCount.textContent = `已选 ${n} 张`;
      const arr = list || Grid.selected();
      let canDel = false, canExp = false, rot = 0;
      for (const m of arr) {
        if (!m || m.bad) continue;
        if (global.Loader.canDelete(m)) canDel = true;
        if (m.path || m.file) canExp = true;
        if (State.rotationOf(m)) rot++;
      }
      E.sbDel.disabled = !canDel;
      E.sbDel.title = canDel ? '把选中的图片移入回收站' : '这些图片所在来源不支持删除';
      if (E.sbExport) {
        E.sbExport.disabled = !canExp;
        E.sbExport.title = canExp
          ? (rot ? `导出 ${n} 张到指定文件夹（其中 ${rot} 张会按已记住的旋转摆正）` : '导出到指定文件夹')
          : '这些图片没有可导出的源文件';
      }
      const all = $('#sbAll');
      if (all) all.textContent = (n >= Grid.items.length && Grid.items.length > 0) ? '取消全选' : '全选本页';
      this.syncMenu();
    },

    /* ================= 导出所选（P1-4） ================= */
    /**
     * 把所选图片导出到用户指定目录。
     * - 未旋转过：桌面版逐字节复制原文件（无损、极快）；浏览器版直接另存原文件。
     * - 旋转过：用 Canvas 把朝向“烘焙”进像素后另存（编码格式见 BAKE_FORMATS，
     *   文件名跟着**实际编码**改，不沿用原扩展名）。
     * 大图烘焙有内存上限保护，超限则跳过并提示。
     */
    async exportSelected(list) {
      const arr = (Array.isArray(list) && list.length ? list : Grid.selected())
        .filter((m) => m && !m.bad && m.state !== 'error');
      if (!arr.length) { this.toast('没有可导出的图片'); return; }
      if (this._exporting) { this.toast('正在导出，请稍候…'); return; }
      this._exporting = true;
      const desktop = !!(global.Native && global.Native.canExportDir);
      try {
        let dir = null;
        if (desktop) {
          dir = await global.Native.pickExportDir();
          if (!dir) return;                       // 取消 → 什么也不做
        }
        const payload = [];                       // 桌面版：一次 IPC 走完
        let ok = 0, fail = 0, baked = 0, heavy = 0, done = 0;

        for (const m of arr) {
          const rot = State.rotationOf(m);
          // ---- 需要烘焙旋转 ----
          if (rot) {
            const bake = await this._bakeRotation(m, rot);
            if (!bake) { heavy++; fail++; continue; }
            baked++;
            /* 名字必须跟着**实际编码**走：gif/bmp/avif/heic 这些 canvas 编不出来的
               源格式会落回 PNG，此时若还沿用原扩展名，就会写出「文件叫 x.bmp、
               内容是 PNG」——双击打不开，而且用户会以为是我们把图弄坏了。 */
            const outName = this._bakedName(m.name, bake.ext);
            if (desktop) payload.push({ src: null, name: outName, dataB64: bake.b64 });
            else { this._saveDataURL(bake.b64, outName, bake.ext); ok++; }
            continue;
          }
          // ---- 原样导出 ----
          if (desktop && m.path) { payload.push({ src: m.path, name: m.name || 'image' }); continue; }
          if (m.file) {
            if (desktop) { this.toast('该来源没有磁盘路径，无法导出到文件夹', { urgent: true }); fail++; continue; }
            this._saveFile(m.file, m.name);
            ok++;
            continue;
          }
          fail++;
        }

        if (desktop) {
          if (!payload.length) {
            this.toast(heavy ? '所选图片过大，无法烘焙导出' : '没有可导出的图片', { urgent: true });
            return;
          }
          this.toast(`正在导出 ${payload.length} 张…`);
          const r = await global.Native.exportFiles(dir, payload);
          if (!r || !r.ok) {
            /* `denied` 是主进程的授权闸门（目标目录不是用户亲手选的）。
               这种情况**不该发生** —— 前端每次导出都会先弹对话框 ——
               所以不写"请重试"，而是让它看起来就是个异常，便于被报上来。 */
            const why = (r && r.reason) === 'denied'
              ? '目标文件夹未获授权，请重新选择一次'
              : ((r && r.reason) || '未知原因');
            this.toast('导出失败：' + why, { urgent: true });
            return;
          }
          for (const it of r.results) { if (it.ok) ok++; else fail++; }
          done = r.results.length;
        } else {
          done = ok + fail;
        }

        const bits = [`已导出 ${ok} 张`];
        if (baked) bits.push(`${baked} 张已按旋转摆正`);
        if (heavy) bits.push(`${heavy} 张因过大跳过`);
        if (fail && !heavy) bits.push(`${fail} 张失败`);
        const msg = bits.join(' · ');
        if (desktop && ok) {
          this.toast(msg, { action: { label: '打开文件夹', onClick: () => global.Native.openPath && global.Native.openPath(dir) } });
        } else {
          this.toast(msg);
        }
        void done;
      } finally {
        this._exporting = false;
      }
    },

    /**
     * 把 meta 的像素按 rot（顺时针 0/90/180/270）烘焙。
     * 返回 { b64, ext } —— ext 是**实际编码出来的**格式，调用方必须拿它去定文件名；
     * 失败或超出内存上限返回 null。
     */
    async _bakeRotation(meta, rot) {
      const MAX_PX = 50e6;          // 5000 万像素上限（约 8K×6K），再大不做烘焙
      try {
        const src = this._exportSrc(meta);
        if (!src) return null;
        const bmp = await this._loadBitmap(src);
        const iw = bmp.width, ih = bmp.height;
        if (!(iw > 0) || !(ih > 0) || iw * ih > MAX_PX) { if (bmp.close) bmp.close(); return null; }
        const swap = (rot % 180) === 90;
        const cv = document.createElement('canvas');
        cv.width = swap ? ih : iw;
        cv.height = swap ? iw : ih;
        const ctx = cv.getContext('2d');
        ctx.translate(cv.width / 2, cv.height / 2);
        ctx.rotate((rot * Math.PI) / 180);
        ctx.drawImage(bmp, -iw / 2, -ih / 2);
        if (bmp.close) bmp.close();
        const fmt = BAKE_FORMATS[(meta.ext || '').toLowerCase()] || BAKE_FORMATS.__png;
        const url = cv.toDataURL(fmt.mime, fmt.q);
        /* 内核可能不支持某种编码（老版本 / 裁剪版），toDataURL 会**静默回落成 PNG**
           而不报错 —— 所以以返回的 MIME 为准，不信我们请求的那个。 */
        const real = (/^data:([^;,]+)/.exec(url) || [])[1] || '';
        const ext = real === 'image/jpeg' ? 'jpg' : real === 'image/webp' ? 'webp' : 'png';
        const i = url.indexOf(',');
        return i > 0 ? { b64: url.slice(i + 1), ext: ext } : null;
      } catch (e) { return null; }
    },

    /** 把 name 的扩展名换成实际编码格式（`日落.webp` + png → `日落.png`） */
    _bakedName(name, ext) {
      const base = String(name || 'image');
      const dot = base.lastIndexOf('.');
      const stem = dot > 0 ? base.slice(0, dot) : base;
      return stem + '.' + (ext || 'png');
    },

    /** 取「原图」URL：优先磁盘流（桌面版），否则用 File 对象的临时 URL */
    _exportSrc(meta) {
      if (global.Native && meta.path) { const u = global.Native.url(meta); if (u) return u; }
      if (meta.file) return global.URL.createObjectURL(meta.file);
      if (global.Thumbs && global.Thumbs.bigURL) return global.Thumbs.bigURL(meta) || null;
      return null;
    },

    /** 解码为 ImageBitmap（显式按 EXIF 摆正）；失败则落回 <img> */
    async _loadBitmap(src) {
      const isBlob = src.indexOf('blob:') === 0;
      try {
        if (global.createImageBitmap && global.fetch) {
          const res = await fetch(src);
          const blob = await res.blob();
          return await global.createImageBitmap(blob, { imageOrientation: 'from-image' });
        }
      } catch (e) { /* 落回 img */ }
      const img = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => rej(new Error('decode-failed'));
        im.src = src;
      });
      if (isBlob) { /* blob URL 由调用方统一回收，这里不动 */ }
      return img;
    },

    /** 浏览器版：另存原始 File */
    _saveFile(file, name) {
      const url = global.URL.createObjectURL(file);
      this._anchorSave(url, name || file.name || 'image');
      setTimeout(() => global.URL.revokeObjectURL(url), 30000);
    },
    /** 浏览器版：另存 dataURL（base64 无前缀）。ext 是**实际编码**，不是原扩展名 */
    _saveDataURL(b64, name, ext) {
      const mime = ext === 'jpg' ? 'image/jpeg' : (ext === 'webp' ? 'image/webp' : 'image/png');
      this._anchorSave('data:' + mime + ';base64,' + b64, name || 'image');
    },
    _anchorSave(href, name) {
      const a = document.createElement('a');
      a.href = href;
      a.download = name || 'image';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 0);
    },

    /* ================= 最近删除 / 撤销删除 ================= */
    /** 桌面版专属：工具栏「最近删除」入口 + 面板 + 快捷键 */
    wireTrash() {
      const E = this.el;
      E.trashWrap = $('#trashWrap');
      E.trashBtn = $('#trashBtn');
      E.trashPanel = $('#trashPanel');
      E.trashList = $('#trashList');
      E.trashBadge = $('#trashBadge');
      if (!E.trashWrap) return;
      E.trashWrap.hidden = false;

      // 面板移到 <body> 下：既躲开 .ctrls 的 overflow 裁剪，也不受它建立的
      // 层叠上下文约束（否则窄窗口下 .ctrls 一旦可横滚，面板会被瓦片盖住 → 点不到）。
      if (E.trashPanel && E.trashPanel.parentElement !== document.body) {
        document.body.appendChild(E.trashPanel);
      }

      E.trashBtn.addEventListener('click', (e) => { e.stopPropagation(); this.toggleTrash(); });
      $('#trashClear').addEventListener('click', () => {
        global.Native.trashClear().then(() => {
          this.trash = [];
          this.renderTrash();
          this.toast('已清空删除记录（回收站里的文件不受影响）');
        });
      });
      $('#trashOpenRb').addEventListener('click', () => { global.Native.openRecycleBin(); });
      const viewAll = $('#trashViewAll');
      if (viewAll) viewAll.addEventListener('click', () => this.openTrash());
      // 点击面板外部收起（面板已挂到 body 下，需同时判断 wrap 与 panel）
      document.addEventListener('click', (e) => {
        if (E.trashPanel.hidden) return;
        if (E.trashWrap.contains(e.target)) return;
        if (E.trashPanel.contains(e.target)) return;
        this.toggleTrash(false);
      });
      // 视口变化 / 页面滚动时跟随按钮（fixed 浮层不随文档流走）
      const follow = () => { if (!E.trashPanel.hidden) this._placeTrashPanel(); };
      global.addEventListener('resize', Util.rafThrottle(follow), { passive: true });
      global.addEventListener('scroll', Util.rafThrottle(follow), { passive: true });
      // Ctrl/⌘ + Z：撤销最近一次删除
      document.addEventListener('keydown', (e) => {
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;      // 输入框里保留原生撤销
        if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
        if (e.key !== 'z' && e.key !== 'Z') return;
        const rec = (this.trash || [])[0];
        if (!rec) { this.toast('没有可撤销的删除'); return; }
        e.preventDefault();
        e.stopPropagation();
        this.undoDelete(rec);
      }, true);

      this.refreshTrash();
    },

    /** 从主进程拉取持久化删除记录（本会话已删除项会保留其内存引用） */
    async refreshTrash() {
      if (!global.Native || !global.Native.active) return;
      const rows = await global.Native.trashLog();
      const old = new Map((this.trash || []).map((r) => [r.id, r]));
      this.trash = (rows || []).map((r) => Object.assign(old.get(r.id) || {}, r));
      this.renderTrash();
      if (global.Trash && global.Trash.isOpen()) global.Trash.setData(this.trash);
    },

    toggleTrash(force) {
      const p = this.el.trashPanel;
      if (!p) return;
      const show = force === undefined ? p.hidden : !!force;
      // 与设置面板互斥：同时只开一个浮层
      if (show && global.Settings && global.Settings.toggle) global.Settings.toggle(false);
      if (show) this.renderTrash();
      p.hidden = !show;          // 先显隐，再测量定位（隐藏时 offsetWidth/Height 恒为 0）
      if (show) this._placeTrashPanel();
    },

    /** 面板是 fixed 浮层（避开 .ctrls 的 overflow 裁剪）：按按钮矩形贴右下角放置，
        并在视口不足时自动翻转/贴边。 */
    _placeTrashPanel() {
      const p = this.el.trashPanel;
      const btn = this.el.trashBtn;
      if (!p || !btn || p.hidden) return;
      const b = btn.getBoundingClientRect();
      const vw = global.innerWidth, vh = global.innerHeight;
      const GAP = 10, MARGIN = 12;
      const w = p.offsetWidth || 328;
      const h = p.offsetHeight || 420;

      // 水平：右对齐按钮右缘，越界则贴边
      let left = b.right - w;
      left = Math.max(MARGIN, Math.min(left, vw - w - MARGIN));
      // 垂直：优先在按钮下方；下方空间不足则翻到上方
      let top = b.bottom + GAP;
      if (top + h > vh - MARGIN) {
        const above = b.top - GAP - h;
        top = above >= MARGIN ? above : Math.max(MARGIN, vh - h - MARGIN);
      }
      p.style.left = Math.round(left) + 'px';
      p.style.top = Math.round(top) + 'px';
    },

    renderTrash() {
      const E = this.el;
      if (!E.trashList) return;
      const list = this.trash || [];
      E.trashBadge.hidden = !list.length;
      E.trashBadge.textContent = String(Math.min(99, list.length));
      E.trashList.textContent = '';
      if (!list.length) {
        const p = document.createElement('p');
        p.className = 'tp-empty';
        p.textContent = '最近没有删除的图片';
        E.trashList.appendChild(p);
        return;
      }
      for (const rec of list.slice(0, 40)) {
        const row = document.createElement('div');
        row.className = 'tp-row';
        const nm = document.createElement('span');
        nm.className = 'tp-name';
        nm.textContent = rec.name || String(rec.path || '').split(/[\\/]/).pop() || '?';
        nm.title = rec.path || '';
        const mt = document.createElement('span');
        mt.className = 'tp-meta';
        mt.textContent = [this._fmtSize(rec.size), this._fmtAgo(rec.ts)].filter(Boolean).join(' · ');
        const act = document.createElement('button');
        act.type = 'button';
        act.className = 'tp-restore';
        act.textContent = '还原';
        act.title = '从回收站还原到原位置';
        act.addEventListener('click', () => this.undoDelete(rec));
        row.appendChild(nm); row.appendChild(mt); row.appendChild(act);
        E.trashList.appendChild(row);
      }
    },

    /* ================= 回收站视图 ================= */
    /** 打开全屏回收站：所有删掉的图片都在这里，可逐张或批量找回 */
    async openTrash() {
      const E = this.el;
      if (E.trashPanel) E.trashPanel.hidden = true;
      if (!global.Trash || !global.Trash.view) return;
      this.toggleTrash(false);
      await this.refreshTrash();
      E.galleryView.hidden = true;
      E.emptyView.hidden = true;
      E.noResult.hidden = true;
      E.sidebar.hidden = true;
      this.syncSideActive();
      E.viewbar.hidden = true;
      if (E.selBar) E.selBar.hidden = true;
      global.Trash.open(this.trash);
    },

    closeTrash() {
      const E = this.el;
      // 若回收站还开着，先让它自己关（它的 onClose 会带着「已关闭」的状态回到这里），
      // 否则两边互调会无限递归。
      if (global.Trash && global.Trash.isOpen()) { global.Trash.close(); return; }
      if (!State.items.length) { this.showEmpty(); return; }
      E.emptyView.hidden = true;
      E.galleryView.hidden = false;
      E.sidebar.hidden = false;
      E.viewbar.hidden = !State.items.length;
      this.renderSources();
      this.applyView(false);
      this.onSelChanged(Grid.selectedCount(), Grid.selected());
    },

    /** 回收站里「还原所选 / 还原单张」→ 批量还原 + 条目回库 */
    async restoreFromTrash(recs) {
      const list = (recs || []).filter((r) => r && r.path);
      if (!list.length) return 0;
      const ok = await this.undoDeleteMany(list);
      if (global.Trash && global.Trash.isOpen()) global.Trash.setData(this.trash);
      return ok;
    },

    /** 只丢弃记录（文件仍留在系统回收站，可手动找回） */
    async forgetTrash(recs) {
      const ids = (recs || []).map((r) => r && r.id).filter(Boolean);
      if (!ids.length) return;
      if (global.Native && global.Native.active) {
        for (const id of ids) await global.Native.trashForget(id);
      }
      const set = new Set(ids);
      this.trash = this.trash.filter((r) => !set.has(r.id));
      this.renderTrash();
      if (global.Trash) global.Trash.setData(this.trash);
      this.toast(`已移除 ${ids.length} 条记录（文件仍在系统回收站）`);
    },

    /** 清空记录列表 —— 只遗忘，绝不动磁盘文件 */
    async clearTrash() {
      if (!this.trash.length) return;
      const yes = await this.modal({
        title: '清空回收站记录？',
        body: `将移除全部 <b>${this.trash.length}</b> 条删除记录，之后无法在这里一键还原。<br>`
          + '磁盘上已删除的文件<b>不受影响</b> —— 它们仍在系统回收站里，可以手动找回。',
        confirmText: '清空记录',
        danger: true,
      });
      if (!yes) return;
      if (global.Native && global.Native.active) await global.Native.trashClear();
      this.trash = [];
      this.renderTrash();
      if (global.Trash) global.Trash.setData(this.trash);
      this.toast('已清空记录（系统回收站里的文件不受影响）');
    },

    /**
     * 撤销一次删除：把文件从回收站还原回原位置，并把条目放回图库。
     * 还原失败时给出明确原因 + 「打开回收站」兜底入口（绝不静默）。
     */
    async undoDelete(rec) {
      if (!rec || this._undoing) return false;
      this._undoing = true;
      try {
        const r = await global.Native.restoreFile({ id: rec.id, path: rec.path, size: rec.size, ts: rec.ts });
        if (!r || !r.ok) {
          const why = this._restoreErrText(r);
          this.toast(why, (r && r.reason === 'not-found')
            ? { action: { label: '打开回收站', onClick: () => global.Native.openRecycleBin() } }
            : null);
          return false;
        }
        // 文件回到磁盘 → 条目回到图库
        let meta = rec._meta || this._metaFromLog(rec);
        let back = 'nosrc';
        if (meta) {
          Thumbs.forget(meta.id);
          back = State.restoreItem(meta, rec._wasFav);
        }
        this.trash = (this.trash || []).filter((x) => x !== rec && x.id !== rec.id);
        this.renderTrash();
        if (back === 'ok') {
          if (!this.el.emptyView.hidden) this.showGallery();
          else { this.renderSources(); this.applyView(false); }
          this.toast('已还原：' + (rec.name || meta.name));
        } else if (back === 'dup') {
          this.toast('文件已还原到原位置');
        } else {
          this.toast('文件已还原到原位置（重新打开该文件夹即可看到）');
        }
        return true;
      } finally {
        this._undoing = false;
      }
    },

    /**
     * 批量撤销：一次把多张从回收站搬回原位置，并逐张补回图库。
     * 返回成功张数；部分失败时明确告知失败原因，不做静默。
     */
    async undoDeleteMany(recs) {
      const list = (recs || []).filter((r) => r && r.path);
      if (!list.length || this._undoing) return 0;
      this._undoing = true;
      try {
        const payload = list.map((r) => ({ id: r.id, path: r.path, size: r.size, ts: r.ts }));
        const rr = await global.Native.restoreFiles(payload);
        let ok = 0, fail = 0, why = null;
        const done = new Set();
        list.forEach((rec, i) => {
          const r = rr && rr[i];
          if (r && r.ok) {
            ok++;
            done.add(rec.id);
            const meta = rec._meta || this._metaFromLog(rec);
            if (meta) { Thumbs.forget(meta.id); State.restoreItem(meta, rec._wasFav); }
          } else {
            fail++;
            if (!why) why = r;
          }
        });
        if (done.size) this.trash = this.trash.filter((x) => !done.has(x.id));
        this.renderTrash();

        if (ok) {
          if (global.Trash && global.Trash.isOpen()) {
            global.Trash.setData(this.trash);   // 就在回收站里还原：只更新列表，不切视图
          } else if (!this.el.emptyView.hidden || (this.el.galleryView.hidden && State.items.length)) {
            this.showGallery();
          } else {
            this.renderSources();
            this.applyView(false);
          }
        }
        if (fail) {
          this.toast(`还原了 ${ok} 张，${fail} 张失败：${this._restoreErrText(why)}`,
            Object.assign(
              { urgent: true },
              (why && why.reason === 'not-found')
                ? { action: { label: '打开回收站', onClick: () => global.Native.openRecycleBin() } }
                : null
            ));
        } else if (ok) {
          this.toast(ok > 1 ? `已还原 ${ok} 张` : '已还原：' + (list[0].name || ''));
        }
        return ok;
      } finally {
        this._undoing = false;
      }
    },

    _restoreErrText(r) {
      switch (r && r.reason) {
        case 'not-found': return '回收站里已找不到这个文件（可能已被清空）';
        case 'occupied': return '原位置已存在同名文件，未覆盖';
        case 'bad-path': return '文件路径无效';
        case 'unsupported': return '当前环境不支持撤销删除';
        case 'verify-failed': return '还原后校验失败，请到回收站手动还原';
        default: return '还原失败：' + ((r && r.message) || '未知原因');
      }
    },

    /** 条目快照：随删除记录持久化，供重启后还原时重建条目 */
    _metaSnap(m) {
      if (!m) return null;
      return {
        id: m.id, name: m.name, rel: m.rel, ext: m.ext, size: m.size, lastModified: m.lastModified,
        path: m.path || null, sid: m.sid || null, srcName: m.srcName || '',
        w: m.w || 0, h: m.h || 0, bad: !!m.bad, state: 'idle',
      };
    },

    _metaFromLog(rec) {
      const s = rec && rec.meta;
      if (!s || !s.id) return null;
      return {
        id: s.id, name: s.name, rel: s.rel, ext: s.ext, size: s.size, lastModified: s.lastModified,
        path: s.path || rec.path, file: null, dirHandle: null, bad: !!s.bad, state: 'idle',
        w: s.w || 0, h: s.h || 0, sid: s.sid || null, srcName: s.srcName || '',
      };
    },

    _fmtSize(n) {
      n = Number(n) || 0;
      if (!n) return '';
      if (n < 1024) return n + ' B';
      if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
      return (n / 1048576).toFixed(1) + ' MB';
    },

    _fmtAgo(ts) {
      ts = Number(ts) || 0;
      if (!ts) return '';
      const d = Date.now() - ts;
      if (d < 60000) return '刚刚';
      if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
      if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
      return Math.floor(d / 86400000) + ' 天前';
    },

    /* ================= 文件夹加载 ================= */
    /**
     * 打开文件夹。**唯一入口**，被三处复用：
     *   ① 空态的「打开文件夹」按钮；② 顶栏来源条的「+」；③ 原生菜单 Ctrl+O / 托盘。
     * 收敛成一个方法而不是三处各写一份 —— 本项目已经因为"同一个动作写了多份、
     * 后来只改了一份"栽过好几次。
     */
    openFolder() {
      if (Loader.isIndexing) return Promise.resolve(null);
      return global.Native.pickFolder().then((dir) => {
        if (dir) Loader.fromNative(dir);
        return dir;
      }).catch(() => null);
    },

    wireFolder() {
      const E = this.el;
      /* 「打开文件夹」只有一个入口：主进程原生目录选择框（Native.pickFolder）。
         去掉了两条浏览器通路（webkitdirectory 文件框 / File System Access）——
         原生路径直接给出磁盘绝对路径，删除、撤销、EXIF 文件头读取、vf://pic
         流式大图这些原生能力才真正可用。
         空态的「重新打开上次文件夹」按钮组随句柄记忆一并移除：Electron 版由
         主进程的「上次目录」记忆（autoDir）在启动时自动打开，无需再点。 */
      const open = () => { this.openFolder(); };
      $('#btnOpen1').addEventListener('click', open);
      E.btnAddFolder.addEventListener('click', open);
    },

    /* ================= 左侧来源栏 =================
       来源从「横排 chip」改成「竖排列表」后，顶栏左端只剩一个开关。
       收起时把当前来源的名字贴在开关右边 —— 否则关掉侧栏，
       用户就不知道自己正在看哪个文件夹了（尤其是多文件夹场景）。
       状态存在 settings.sidebarOpen 里，跨会话保持。 */
    wireSidebar() {
      const E = this.el;
      if (!E.sideToggle) return;
      const flip = () => this.toggleSidebar();
      E.sideToggle.addEventListener('click', flip);
      if (E.sideCollapse) E.sideCollapse.addEventListener('click', flip);
      // 收起态的「当前来源」本身就是「展开」的入口
      if (E.sideActive) E.sideActive.addEventListener('click', () => this.toggleSidebar(true));
      /* Ctrl+Shift+B —— **不能**用 Ctrl+B：它已经是应用菜单里「模糊预览」的加速键
         （desktop-spec.js 的 CmdOrCtrl+B）。两个处理器都会收到 keydown，
         按一下会同时把隐私模式打开、把侧栏收起来。菜单项在 desktop-spec.js。 */
      global.addEventListener('keydown', (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.altKey || !e.shiftKey) return;
        if (e.key !== 'b' && e.key !== 'B') return;
        // 输入框里按快捷键是「加粗」之类，不该抢
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        e.preventDefault();
        flip();
      });
      /* 窄窗自动让位：212px 的侧栏在 900px 窗口里要吃掉近四分之一宽度，
         内容区只剩 650 上下（瀑布流会退成两列）。
         ⚠️ **不改 settings**：那是用户的长期意图，窄窗只是"这次先不用"。
         退出窄窗自动恢复，用户不必再点一次。 */
      if (global.matchMedia) {
        const mq = global.matchMedia(NARROW_SIDE_MQ);
        const onChange = () => {
          if (!mq.matches) this._sideForced = false;   // 回到宽窗：交还给设置
          this.applySidebarUI(State.settings.sidebarOpen);
        };
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange);   // 老版 Electron 兜底
      }
    },

    /** 侧栏此刻**真的**是展开的吗。以 DOM 为准 —— 设置里存的是「用户意图」，
        窄窗下会被自动收起，两者不再等价。 */
    sidebarOpenNow() {
      const w = this.el.workspace;
      return !!(w && !w.classList.contains('is-collapsed'));
    },

    toggleSidebar(force) {
      /* 取反要基于**有效态**而不是设置值：窄窗里设置可能还是"开"，
         而侧栏已经被自动收起了，这时按一下应当展开，
         而不是"关掉一个本来就关着的东西"。 */
      const next = typeof force === 'boolean' ? force : !this.sidebarOpenNow();
      State.setSetting('sidebarOpen', next);
      // 窄窗里手动展开 → 本次窄窗期间保持展开（退出窄窗时清掉）
      this._sideForced = next && !!(global.matchMedia && global.matchMedia(NARROW_SIDE_MQ).matches);
      this.applySidebarUI(next);
    },

    applySidebarUI(open) {
      const E = this.el;
      const want = !!open;
      const narrow = !!(global.matchMedia && global.matchMedia(NARROW_SIDE_MQ).matches);
      const on = want && (!narrow || this._sideForced);
      if (E.workspace) E.workspace.classList.toggle('is-collapsed', !on);
      if (E.sideToggle) {
        E.sideToggle.classList.toggle('is-on', on);
        E.sideToggle.title = (on ? '收起来源栏' : '展开来源栏') + '（Ctrl+Shift+B）';
        E.sideToggle.setAttribute('aria-label', on ? '收起来源栏' : '展开来源栏');
        E.sideToggle.setAttribute('aria-pressed', String(on));
      }
      this.syncSideActive();
      /* 侧栏宽度变了 → 网格可用宽度跟着变。必须重排，否则瓦片还按旧宽度摆着，
         右侧会留一条空白（或压到侧栏底下）。 */
      if (global.Grid && global.Grid.layout) requestAnimationFrame(() => global.Grid.layout(true));
      /* 应用菜单里「来源栏」的勾选态要跟着变 —— 不推的话用菜单收起后，
         菜单里那个勾还停在"已展开"，再点一次会变成"展开"（反向操作）。 */
      this.syncMenu();
    },

    /** 把「当前来源」同步到收起态的那个标签上（同时管它该不该出现） */
    syncSideActive() {
      const E = this.el;
      if (!E.sideActive) return;
      const src = State.sources.filter((x) => x.id === State.active)[0];
      const label = State.active === 'all' || !src ? '全部图片' : src.name;
      E.sideActive.textContent = label;
      E.sideActive.title = '展开来源栏（Ctrl+Shift+B）· 当前：' + label;
      const sideHidden = E.sidebar ? E.sidebar.hidden : false;
      // 侧栏整体不可用（空态 / 回收站）时，顶栏那颗开关也该一起收起来 ——
      // 留着它只会得到一个「点了没反应」的按钮。
      if (E.sideToggle && E.sideToggle.parentElement) E.sideToggle.parentElement.hidden = sideHidden;
      // 侧栏展开时这个标签是多余的（侧栏里高亮的那行就是答案）。
      // 判「展开」要用**有效态**：窄窗自动收起时，设置里还写着 true。
      E.sideActive.hidden = this.sidebarOpenNow() || sideHidden;
    },

    /* ================= 拖拽 ================= */
    wireDrop() {
      const E = this.el;
      let depth = 0;
      const hasFiles = (e) => Array.from(e.dataTransfer.types || []).includes('Files');

      global.addEventListener('dragenter', (e) => {
        if (Loader.isIndexing || !hasFiles(e)) return;
        e.preventDefault();
        depth++;
        E.dropZone.hidden = false;
      });
      global.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
      global.addEventListener('dragleave', () => {
        depth = Math.max(0, depth - 1);
        if (depth === 0) E.dropZone.hidden = true;
      });
      global.addEventListener('drop', async (e) => {
        depth = 0;
        E.dropZone.hidden = true;
        if (Loader.isIndexing) return;
        if (!hasFiles(e)) return;
        e.preventDefault();
        const ok = await Loader.fromDrop(e.dataTransfer);
        if (!ok) {
          this.toast('未发现可加载的图片。请拖入包含图片的文件夹。');
        }
      });
    },

    /* ================= 桌面集成接线 =================
       原生菜单 / 托盘 / 右键菜单。无桥时整段跳过 —— 不留半截状态。 */
    wireDesktop() {
      if (!global.Native || !global.Native.active) return;

      // 应用菜单与托盘发来的命令（主进程只传字符串 id）
      global.Native.onCommand((cmd) => this.runCommand(cmd));

      // 图库瓦片的右键菜单。挂在 stage 上（瓦片是动态增删的，逐张挂监听会漏）。
      const stage = $('#stage');
      if (stage && global.Native.canContextMenu) {
        stage.addEventListener('contextmenu', (e) => this.gridContext(e));
      }
    },

    /* ================= 状态订阅 ================= */
    subscribeBus() {
      const E = this.el;
      const bus = State.bus;

      // P1-4：旋转被记住 → 网格里那张的朝向随之更新（横竖互换、重排行布局）
      bus.on('rotation-changed', ({ meta }) => {
        if (Grid.N) Grid.refreshRotation(meta);
      });

      bus.on('index-start', () => {
        E.topbar.hidden = false;
        E.prog.classList.add('active');
        E.statusline.hidden = false;
        E.statusText.textContent = '正在读取文件夹…';
        E.progBar.style.width = '2%';
        // 任务栏进度条（Windows）：总数还不知道 → 先给"不确定进度"的滚动条。
        // 这是索引期间唯一在任务栏就能看见的反馈。
        if (global.Native && global.Native.setProgress) {
          global.Native.setProgress(0, 'indeterminate');
        }
      });

      bus.on('index-progress', ({ done, total }) => {
        if (total) E.progBar.style.width = Math.min(100, (done / total) * 100) + '%';
        E.statusText.textContent = total
          ? `正在索引图片… ${done.toLocaleString()} / ${total.toLocaleString()}`
          : `正在索引图片… ${done.toLocaleString()}`;
        if (global.Native && global.Native.setProgress) {
          // 总数已知 → 换成真实进度；未知 → 继续滚动条
          if (total) global.Native.setProgress(Math.min(1, done / total), 'normal');
          else global.Native.setProgress(0, 'indeterminate');
        }
      });

      bus.on('index-done', () => {
        E.prog.classList.remove('active');
        E.statusline.hidden = true;
        // 收起任务栏进度条（-1 = 移除）
        if (global.Native && global.Native.setProgress) global.Native.setProgress(-1, 'none');
        if (State.sources.length) {
          this.showGallery();
        }
      });

      bus.on('item-error', () => { State.recountErr(); this.updateErrUI(); });
    },

    /* ---------- 视图切换 ---------- */
    showGallery() {
      const E = this.el;
      E.emptyView.hidden = true;
      E.galleryView.hidden = false;
      E.topbar.hidden = false;
      E.sidebar.hidden = false;
      this.renderSources();
      this.applyModeUI(false);   // 确保当前模式的网格参数
      this.applyView(true);      // 计算来源过滤/排序 + 分页并渲染
      this.syncMenu();           // 有图了 → 菜单里「放大 / 导出 / 全选」随之可用
    },

    showEmpty() {
      const E = this.el;
      E.galleryView.hidden = true;
      E.emptyView.hidden = false;
      E.sidebar.hidden = true;
      this.syncSideActive();
      E.noResult.hidden = true;
      if (E.selBar) E.selBar.hidden = true;
      Grid.clearSel();
      // 全部删光时也要留着顶栏 —— 否则回收站入口跟着消失，就找不回图片了
      E.topbar.hidden = !(this.trash && this.trash.length);
      this.syncMenu();           // 没图了 → 菜单里「放大 / 导出 / 全选」随之置灰
    },

    /* ---------- 来源条 ---------- */
    renderSources() {
      const E = this.el;
      const list = E.srcList;
      list.textContent = '';
      const mk = (id, label, count, isActive, removable) => {
        const b = document.createElement('button');
        b.className = 'src-chip' + (isActive ? ' is-on' : '') + (count ? '' : ' is-empty');
        b.type = 'button';
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', String(isActive));
        /* 0 张的行照样能点（点进去是空图库），但要先说清为什么是空的，
           否则用户只能自己猜是没索引完、还是这个文件夹真的没图。 */
        if (!count) b.title = label + '：这个文件夹里还没有图片';
        const nm = document.createElement('span');
        nm.className = 'sc-name';
        nm.textContent = label;
        nm.title = label;
        const cnt = document.createElement('span');
        cnt.className = 'sc-count';
        cnt.textContent = count.toLocaleString();
        b.appendChild(nm); b.appendChild(cnt);
        b._sid = id;
        if (removable) {
          const x = document.createElement('span');
          x.className = 'sc-x';
          x.innerHTML = Util.icon('i-x');
          x.title = '从浏览列表移除（不删除磁盘文件）';
          x.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this.removeFolder(id, label);
          });
          b.appendChild(x);
        }
        b.addEventListener('click', () => {
          if (State.active === id) return;
          State.active = id;
          this.renderSources();
          this.applyView(true);
        });
        list.appendChild(b);
      };

      const totalAll = State.items.length;
      mk('all', '全部图片', totalAll, State.active === 'all', false);
      for (const s of State.sources) {
        mk(s.id, s.name, State.sourceCount(s.id), State.active === s.id, true);
      }
      this.syncSideActive();
    },

    removeFolder(id, label) {
      if (!global.confirm(`从浏览列表中移除「${label}」？\n仅释放浏览器内数据，不会删除磁盘上的任何文件。`)) return;
      State.removeSource(id);
      Thumbs.clearAll();
      Loader.clearDimsFor(label);
      this.renderSources();
      if (!State.sources.length) {
        // 全部来源被移除 → 回到引导页
        this.showEmpty();
        return;
      }
      this.applyView(true);
    },

    /* ---------- 删除图片（真实文件操作） ---------- */
    /**
     * 统一的删除入口：能力检测 → 二次确认 → 执行 → 同步内存/缓存/视图。
     * - 桌面版：移入系统回收站（可恢复）
     * - 浏览器「选择文件夹」授权：永久删除（确认弹层会明确提示）
     * - 拖拽 / 文件选择框来源：没有写权限，直接拒绝
     */
    async requestDelete(meta, opts) {
      if (!meta || Loader.isIndexing || this._deleting) return false;
      const cap = Loader.canDelete(meta);
      if (!cap) {
        this.toast('该来源不支持删除 —— 请用「选择文件夹」打开，或使用桌面版', { urgent: true });
        return false;
      }
      const fromLb = !!(opts && opts.fromLightbox);
      // 设置项「删除前确认」：关闭时直接执行（仍保留撤销入口）
      if (State.settings.confirmDelete !== false && !(await this.confirmDelete(meta, cap))) return false;

      this._deleting = true;
      let r;
      try { r = await Loader.deleteItem(meta); }
      finally { this._deleting = false; }
      if (!r || !r.ok) { this.toast(this._deleteErrText(r)); return false; }

      const wasFav = State.isFav(meta.id);   // 删除会清掉收藏，撤销时补回

      // 磁盘已删除 → 同步清掉内存条目、缓存与收藏
      const sy = global.scrollY || 0;
      Thumbs.forget(meta.id);
      Loader.forgetDims(meta.id);
      State.removeItem(meta);

      if (fromLb && Lightbox.isOpen()) Lightbox.dropCurrent(meta);

      if (!State.sources.length || !State.items.length) {
        this.showEmpty();
      } else {
        this.renderSources();
        this.applyView(false);
        if (!fromLb) requestAnimationFrame(() => global.scrollTo(0, sy));
      }

      // 桌面版：登记一条可撤销记录（本会话保留条目引用，撤销时可无缝回到图库）
      let undoRec = null;
      if (cap === 'trash') {
        undoRec = {
          id: (r && r.logId) || ('t' + Date.now().toString(36)),
          name: meta.name, path: meta.path,
          size: (r && r.size) || meta.size,
          ts: (r && r.ts) || Date.now(),
          _meta: meta, _wasFav: wasFav, meta: this._metaSnap(meta),
        };
        this.trash.unshift(undoRec);
        this.renderTrash();
      }
      this.toast(cap === 'trash' ? '已移入回收站' : '已删除',
        undoRec ? { action: { label: '撤销', onClick: () => this.undoDelete(undoRec) } } : null);
      return true;
    },

    /**
     * 批量删除：框选/全选后的统一出口。
     * 能力检测 → 一次确认 → 批量移入回收站（单次 IPC）→ 一次性刷新视图 → 整批可撤销。
     * 部分失败时不会假装成功：明确报出失败张数与第一失败原因。
     */
    async requestDeleteMany(list) {
      const all = (list || []).filter(Boolean);
      if (!all.length || Loader.isIndexing || this._deleting) return false;
      const items = all.filter((m) => Loader.canDelete(m));
      const skipped = all.length - items.length;
      if (!items.length) {
        this.toast('这些图片所在来源不支持删除 —— 请用「选择文件夹」打开，或使用桌面版', { urgent: true });
        return false;
      }
      const trash = items.some((m) => Loader.canDelete(m) === 'trash');
      // 设置项「删除前确认」：关闭时直接执行
      if (State.settings.confirmDelete !== false && !(await this.confirmDeleteMany(items, trash, skipped))) return false;

      const favMap = new Map(items.map((m) => [m.id, State.isFav(m.id)]));
      this._deleting = true;
      const results = new Map();
      try {
        // 桌面版：一次 IPC 走完全部（避免 N 次往返），逐张独立成败
        if (trash && global.Native && global.Native.active) {
          const pathOnes = items.filter((m) => m.path);
          if (pathOnes.length) {
            const rr = await global.Native.deleteFiles(pathOnes.map((m) => ({
              path: m.path,
              rec: { name: m.name, size: m.size, meta: this._metaSnap(m) },
            })));
            pathOnes.forEach((m, i) => results.set(m, rr[i] || { ok: false, reason: 'failed' }));
          }
        }
        // 其余（浏览器 File System Access 来源 / 批量接口不可用时的兜底）
        for (const m of items) {
          if (results.has(m)) continue;
          results.set(m, await Loader.deleteItem(m));
        }
      } finally {
        this._deleting = false;
      }

      const done = [], failed = [];
      let why = null;
      for (const m of items) {
        const r = results.get(m);
        if (r && r.ok) done.push({ meta: m, r });
        else { failed.push({ meta: m, r }); if (!why) why = r; }
      }

      if (!done.length) {
        this.toast('删除失败：' + this._deleteErrText(why), { urgent: true });
        return false;
      }

      const sy = global.scrollY || 0;
      const recs = [];
      for (const { meta, r } of done) {
        Thumbs.forget(meta.id);
        Loader.forgetDims(meta.id);
        State.removeItem(meta);
        Grid.sel.delete(meta);
        if (trash) {
          recs.push({
            id: (r && r.logId) || ('t' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
            name: meta.name, path: meta.path,
            size: (r && r.size) || meta.size,
            ts: (r && r.ts) || Date.now(),
            _meta: meta, _wasFav: favMap.get(meta.id), meta: this._metaSnap(meta),
          });
        }
      }

      Grid.pruneSel();
      this.onSelChanged(Grid.selectedCount(), Grid.selected());

      if (!State.sources.length || !State.items.length) {
        this.showEmpty();
      } else {
        this.renderSources();
        this.applyView(false);
        requestAnimationFrame(() => global.scrollTo(0, sy));
      }

      if (recs.length) {
        this.trash = recs.concat(this.trash);
        this.renderTrash();
        if (global.Trash && global.Trash.isOpen()) global.Trash.setData(this.trash);
      }

      const msg = `已移入回收站 ${done.length} 张` + (failed.length ? `，${failed.length} 张失败` : '');
      this.toast(msg, recs.length
        ? { action: { label: '撤销', onClick: () => this.undoDeleteMany(recs) } }
        : null);
      if (failed.length) this.toast('部分失败：' + this._deleteErrText(why), { urgent: true });
      return true;
    },

    /** 批量删除确认：列出前若干文件名 + 总数，明确告知「可找回」 */
    confirmDeleteMany(items, trash, skipped) {
      const names = items.slice(0, 6).map((m) => Util.esc(m.name));
      const more = items.length > names.length ? `<span class="vf-modal-more">…等共 ${items.length} 张</span>` : '';
      const skip = skipped
        ? `<span class="vf-modal-warn">另有 ${skipped} 张所在来源不支持删除，将被跳过。</span>`
        : '';
      return this.modal({
        title: trash ? `把 ${items.length} 张图片移入回收站？` : `永久删除这 ${items.length} 张图片？`,
        body: (trash
          ? '这些图片会被移到系统<b>回收站</b>；删完可点提示条上的「撤销」、按 <b>Ctrl+Z</b>，'
            + '或到工具栏回收站里逐张/批量找回。'
          : '将从磁盘上<b>永久删除</b>这些图片，<b>无法恢复</b>。')
          + '<span class="vf-modal-file">' + names.join('<br>') + more + '</span>' + skip,
        confirmText: trash ? '移入回收站' : '永久删除',
        danger: true,
      });
    },

    _deleteErrText(r) {
      switch (r && r.reason) {
        case 'denied': return '未获得写入授权，已取消删除';
        case 'unsupported': return '该来源不支持删除';
        case 'not-file': return '文件已不存在（可能已被移动或删除）';
        case 'bad-path': return '文件路径无效';
        default: return '删除失败：' + ((r && r.message) || '未知原因');
      }
    },

    /** 删除确认弹层（默认聚焦「取消」，Esc 取消 / Enter 确认） */
    confirmDelete(meta, cap) {
      const trash = cap === 'trash';
      return this.modal({
        title: trash ? '移入回收站？' : '永久删除这张图片？',
        body: (trash
          ? '这张图片将被移到系统<b>回收站</b>；删除后可点提示条上的「撤销」、按 <b>Ctrl+Z</b>，'
            + '或到工具栏「最近删除」里一键还原。'
          : '将从磁盘上<b>永久删除</b>这张图片，<b>无法恢复</b>。')
          + '<span class="vf-modal-file">' + Util.esc(meta.name) + '</span>',
        confirmText: trash ? '移入回收站' : '永久删除',
        danger: true,
      });
    },

    modal(o) {
      return new Promise((resolve) => {
        const wrap = document.createElement('div');
        wrap.className = 'vf-modal';
        wrap.innerHTML =
          '<div class="vf-modal-bg"></div>' +
          '<div class="vf-modal-card" role="dialog" aria-modal="true">' +
            '<h3 class="vf-modal-title"></h3>' +
            '<div class="vf-modal-body"></div>' +
            '<div class="vf-modal-acts">' +
              '<button type="button" class="btn btn-ghost" data-act="cancel"></button>' +
              '<button type="button" class="btn" data-act="ok"></button>' +
            '</div>' +
          '</div>';
        // 可及名称：给标题一个稳定 id，让 role="dialog" 的卡片用 aria-labelledby 引用它。
        // 不用 aria-label 复制一份题目 —— 题目随场景变（移入回收站？/ 永久删除？），
        // 复制必然写歪，引用 id 不会。
        const titleEl = wrap.querySelector('.vf-modal-title');
        titleEl.textContent = o.title || '确认';
        if (!titleEl.id) titleEl.id = 'vfModalTitle' + (++App._modalSeq);
        wrap.querySelector('.vf-modal-card').setAttribute('aria-labelledby', titleEl.id);
        wrap.querySelector('.vf-modal-body').innerHTML = o.body || '';
        const okBtn = wrap.querySelector('[data-act="ok"]');
        const noBtn = wrap.querySelector('[data-act="cancel"]');
        noBtn.textContent = o.cancelText || '取消';
        okBtn.textContent = o.confirmText || '确定';
        okBtn.classList.add(o.danger ? 'btn-danger' : 'btn-primary');
        // single：只有一个动作按钮（「关于」这类纯展示弹窗，不需要"取消/确定"二选一）
        const single = !!o.single;
        if (single) noBtn.remove();

        let settled = false;
        // 焦点陷阱句柄。注意 aria-modal="true" 只是**声明**背景是惰性的 ——
        // 浏览器不会替你拦 Tab。声明了却没人执行，比不声明更糟：
        // 读屏据此以为外面读不到，键盘却真的能 Tab 出去，两条路当场失步。
        let releaseTrap = null;
        const done = (v) => {
          if (settled) return;
          settled = true;
          document.removeEventListener('keydown', onKey, true);
          // 先解陷阱再摘节点：拦截器挂在 document 上，漏解会让 Tab 一直被圈着
          if (releaseTrap) { releaseTrap(); releaseTrap = null; }
          wrap.classList.remove('show');
          setTimeout(() => wrap.remove(), 160);
          resolve(v);
        };
        // 捕获阶段拦截：避免 Esc 同时触发灯箱关闭等其它快捷键
        const onKey = (e) => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); return; }
          /* Enter **不在这里拦**，交给焦点所在按钮的原生激活行为。
             这里曾经是无条件 `done(true)` —— 而默认焦点在「取消」上，于是
             "按回车想取消"变成了"按回车执行删除"。原生行为天生就是
             "回车 = 激活当前聚焦的那个按钮"，正是我们要的语义，
             也不必再判焦点（判错了反而会再错一次）。
             Esc 仍然单独处理：它是"取消"的快捷键，与焦点无关。 */
        };
        wrap.querySelector('.vf-modal-bg').addEventListener('click', () => done(false));
        /* 这里必须用 single 判断，**不能**用 noBtn.isConnected ——
           本行跑在 document.body.appendChild(wrap) 之前，wrap 还没进文档树，
           isConnected 恒为 false。写成 isConnected 的后果不是"少绑一个按钮"那么简单：
           「取消」点了什么都不发生、弹层赖着不走，而它注册在 document 上的**捕获期
           Esc 拦截**会继续吞掉后面所有对话框的 Esc（连灯箱都关不掉）。
           这是 v1.10.0 的无障碍探针查出来的老 bug（探针读的是"弹层有没有真的消失"，
           不是"按钮在不在"）。 */
        if (!single) noBtn.addEventListener('click', () => done(false));
        okBtn.addEventListener('click', () => done(true));
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(wrap);
        requestAnimationFrame(() => wrap.classList.add('show'));
        /* onMount(bodyEl, close)：弹层**已经插进文档树**之后回调一次，
           给调用方一个"就地接线/就地改内容"的钩子（「关于」里的检查更新按钮用它）。
           为什么必须在这个位置、而不是返回 Promise 之后：Promise 要等弹层关掉才 resolve，
           那时再挂事件已经晚了。放在 appendChild 之后，querySelector / focus 才有效。 */
        if (typeof o.onMount === 'function') {
          try { o.onMount(wrap.querySelector('.vf-modal-body'), () => done(false)); }
          catch (err) { console.error('[modal] onMount 回调出错：', err); }
        }
        // 默认落在「取消」：危险的默认值不该是"回车即触发"。
        // trap 自己会完成移焦，后面那行是 A11y 缺失时的兜底。
        const initialBtn = single ? okBtn : noBtn;
        if (A11y && A11y.trap) releaseTrap = A11y.trap(wrap, { initial: initialBtn });
        initialBtn.focus();
      });
    },

    /* ---------- 分页视图核心 ---------- */
    /** 重新计算来源/过滤/排序/分页信息并渲染 */
    applyView(resetPage) {
      const L = this._view = State.viewList();
      const ps = State.settings.pageSize;
      this._pages = (ps > 0) ? Math.max(1, Math.ceil(L.length / ps)) : 1;
      if (resetPage || this.page < 1 || this.page > this._pages) this.page = 1;
      this.renderPage();
      this.updateNoResult();
      this.maybeHarvestShot();
    },

    /** 渲染当前页切片 + 全部计数/翻页 UI */
    renderPage() {
      const E = this.el;
      const L = this._view || (this._view = State.viewList());
      const ps = State.settings.pageSize;
      let slice = L, from = 1, to = L.length;

      if (ps > 0) {
        from = (this.page - 1) * ps + 1;
        to = Math.min(L.length, from + ps - 1);
        slice = (from <= L.length) ? L.slice(from - 1, to) : [];
      }
      if (!L.length) { slice = []; from = 0; to = 0; }

      Grid.showItems(slice);

      // 底部状态栏：自动隐藏 —— 渲染后默认收起，仅当“真实滚到底”才显示
      const hasItems = !!State.items.length;
      E.viewbar.hidden = !hasItems;
      if (!hasItems) { E.viewbar.classList.remove('is-shown'); return; }
      if (this._atRealBottom()) {
        if (this._showViewbar) this._showViewbar();
      } else {
        E.viewbar.classList.remove('is-shown');
      }

      E.pageSizeSel.value = String(State.settings.pageSize);

      // 页脚注与翻页信息（同一行）
      const total = L.length;
      const pages = this._pages;
      const parts = [];
      if (total > 0) parts.push(`共 <strong>${total.toLocaleString()}</strong> 张`);
      if (total > 0 && ps > 0 && total > ps) parts.push(`本页第 <strong>${from.toLocaleString()}–${to.toLocaleString()}</strong> 张`);
      if (parts.length) E.footNote.innerHTML = parts.join(' · ');
      else E.footNote.innerHTML = '';

      if (pages > 1) {
        E.pageInfo.innerHTML = `第 <strong>${this.page}</strong> / ${pages} 页`;
      } else {
        E.pageInfo.innerHTML = '';
      }
      E.pagePrev.disabled = this.page <= 1;
      E.pageNext.disabled = this.page >= pages || pages <= 1;

      this.updateErrUI();

      // 单列整屏：切页/筛选后回到本页首图（吸附一屏）
      if (State.settings.mode === 'single') {
        requestAnimationFrame(() => Grid.alignFirst());
      }
    },

    updateNoResult() {
      const total = State.items.length;
      const viewed = this._view ? this._view.length : State.viewList().length;
      const hasFilter = !!(State.filterText || State.favOnly);
      if (total === 0 || viewed === 0) {
        this.el.noResult.hidden = false;
        this.el.clearFilters.hidden = !hasFilter;
        if (total === 0) {
          this.el.noResultText.textContent = hasFilter ? '没有匹配的图片' : '当前没有可显示的图片';
        } else {
          this.el.noResultText.textContent = '没有匹配的图片';
        }
      } else {
        this.el.noResult.hidden = true;
      }
    },

    /** Lightbox 关闭后：若已翻页离开其所在页，先跳页再高亮定位 */
    onLightboxClosed(meta) {
      if (!meta) return;   // 没换过图 → 原来那张瓦片还在原地，焦点陷阱已把它还原好了
      const L = State.viewList();
      const idx = L.indexOf(meta);
      if (idx < 0) return;
      const ps = State.settings.pageSize;
      // 换过图 → 分页可能变，原来那格瓦片会被重建，A11y.trap 的还原目标就断开了。
      // 补一次：把焦点落到**最终这张**瓦片上（键盘用户不该被扔回页面开头）。
      // 只在焦点已丢失（body）或还停在瓦片上时才抢 —— 否则会把用户在这 120ms 里
      // 刚点中的东西（比如提示条上的「撤销」）无故夺走。
      const refocus = () => {
        const a = document.activeElement;
        const onTile = !!(a && a.classList && a.classList.contains('tile'));
        if (a && a !== document.body && !onTile) return;
        const el = Grid.elFor ? Grid.elFor(meta) : null;
        if (el && el.focus) el.focus();
      };
      if (ps > 0) {
        const target = Math.floor(idx / ps) + 1;
        if (target !== this.page) {
          this.page = target;
          this.renderPage();
          setTimeout(() => { Grid.revealItem(meta); refocus(); }, 120);
          return;
        }
      }
      Grid.revealItem(meta);
      refocus();
    },

    /* ---------- 拍摄时间后台采集（仅当排序方式为“拍摄时间”） ---------- */
    /** 从当前展示列表里挑出尚未读取 EXIF 时间的项，限量后台解析；完成后若仍在“拍摄时间”排序则重排一次 */
    maybeHarvestShot() {
      if (State.settings.sortKey !== 'shot') return;
      const metas = this._view.filter((m) => !m.bad && m.shotTs === undefined && !m._shotTried);
      if (!metas.length) return;
      const list = metas.slice(0, 2000); // 单轮最多 2000，防止超大目录一次性排队
      /* 只有**真正提交出去**的这一批才盖章。
         原来的写法先把全部候选都标成"已尝试"、再只取前 2000 条去解析 ——
         第 2001 条往后就被永久判了"试过了"，在「拍摄时间」排序里永远沉在
         "无时间"那一段，而且再也不会被重试（页面上看不出任何异常）。 */
      if (this._harvestBusy) { this._harvestPending = (this._harvestPending || 0) + list.length; return; }
      for (const m of list) m._shotTried = true;
      this._harvestBusy = true;
      global.Exif.harvestTimes(list).then(() => {
        this._harvestBusy = false;
        if (this._harvestPending) {
          this._harvestPending = 0;
          /* 还有没送出去的 —— 重新走一遍 applyView，它会再调一次本函数，
             把下一批 2000 条接上。每轮都盖一批章，所以一定会收敛。 */
          if (State.settings.sortKey === 'shot') this.applyView(true);
          return;
        }
        if (State.settings.sortKey === 'shot') this.applyView(false);
      });
    },

    /* ================= 键盘 ================= */
    wireKeyboard() {
      document.addEventListener('keydown', (e) => {
        if (Lightbox.isOpen()) return; // Lightbox 自己处理
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        const E = this.el;
        const inTrash = !!(global.Trash && global.Trash.isOpen());

        // Esc：回收站里退出回收站；图库里取消选择
        if (e.key === 'Escape') {
          if (inTrash) { e.preventDefault(); this.closeTrash(); return; }
          if (Grid.selectedCount()) { e.preventDefault(); Grid.clearSel(); return; }
          return;
        }
        // Ctrl/⌘ + A：全选当前页（回收站视图交给它自己）
        if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'a' || e.key === 'A')) {
          if (inTrash || !State.items.length) return;
          e.preventDefault();
          Grid.selectAll(true);
          return;
        }
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        switch (e.key) {
          case '1': case '2': case '3': case '4': {
            // 数字键 = 顶栏图标的第 N 个。直接读 MODE_ORDER，别在这里再抄一份列表
            // （抄一份就多一处"加了模式忘了改"的机会，本项目已栽过多次）。
            const key = State.MODE_ORDER[Number(e.key) - 1];
            if (key && key !== State.settings.mode) {
              State.setSetting('mode', key);
              this.applyModeUI(true);
            }
            e.preventDefault(); break;
          }
          case 'm': case 'M': {
            const order = State.MODE_ORDER;
            const cur = order.indexOf(State.settings.mode);
            State.setSetting('mode', order[(cur + 1) % order.length]);
            this.applyModeUI(true);
            e.preventDefault(); break;
          }
          case '+': case '=': this.nudgeSize(1); e.preventDefault(); break;
          case '-': case '_': this.nudgeSize(-1); e.preventDefault(); break;
          case 'f': case 'F': E.favOnlyBtn.click(); e.preventDefault(); break;
          case '/': if (State.items.length) { this.openSearch(); setTimeout(() => { E.searchInput.focus(); E.searchInput.select(); }, 90); e.preventDefault(); } break;
          case 'Delete': {
            // 有选中 → 批量删除；否则焦点落在某张瓦片上时删该张
            if (inTrash) break;
            const sel = Grid.selected();
            if (sel.length) { e.preventDefault(); this.requestDeleteMany(sel); break; }
            const ae = document.activeElement;
            const tile = ae && ae.closest ? ae.closest('.tile') : null;
            if (tile && tile._item) { e.preventDefault(); this.requestDelete(tile._item); }
            break;
          }
        }
      });
    },

    /* ============================================================
       桌面集成（原生菜单 / 右键菜单 / 托盘 / 任务栏）
       ------------------------------------------------------------
       两条**互不重叠**的通路，别混：
         · 应用菜单 / 托盘 → 主进程发 vf:cmd → App.COMMANDS[id]
         · 右键菜单       → App 主动弹，主进程把「点了哪一项」当**返回值**给回来
                            → App.CTX_COMMANDS[id]
       右键这条刻意不用事件回传：弹窗的调用方就在等结果，走返回值天然不会
       出现"两处都执行"或"两处都没执行"。
       ============================================================ */

    /** 右键菜单的目标。菜单属于主进程，点回来时没有 DOM 上下文，
        只能靠打开菜单那一刻记下的这份快照知道"点的是哪一张"。 */
    ctxTarget: null,

    /**
     * 切换排列模式（顶栏图标 / 设置面板 / 键盘 / 原生菜单四个入口共用）。
     * 此前这段逻辑散在 wireControls 与 wireKeyboard 两处，加原生菜单会变成
     * 第三处 —— 收敛成一个方法，少两处漂移的机会。
     */
    setMode(key) {
      if (!State.MODES[key] || State.settings.mode === key) return false;
      State.setSetting('mode', key);
      this.applyModeUI(true);
      if (global.Settings && global.Settings.sync) global.Settings.sync();
      this.syncMenu();
      return true;
    },

    /** 只看收藏（顶栏按钮 / 键盘 F / 原生菜单共用） */
    toggleFavOnly() {
      const E = this.el;
      State.favOnly = !State.favOnly;
      E.favOnlyBtn.classList.toggle('is-active', State.favOnly);
      E.favOnlyBtn.classList.toggle('is-on', State.favOnly);
      this.applyView(true);
      this.syncMenu();
    },

    /** 把当前模式下的瓦片尺寸恢复成默认值（原生菜单 Ctrl+0） */
    resetSize() {
      const mode = State.settings.mode;
      const def = State.MODES[mode] && State.MODES[mode].def;
      if (typeof def !== 'number') { this.toast('单列模式的高度由窗口决定，无需重置'); return; }
      State.setModeSize(mode, def);
      const [min, max] = State.MODES[mode].range;
      const v = Util.clamp(Math.round(((def - min) / (max - min)) * 100), 0, 100);
      this.el.sizeRange.value = String(v);
      this.paintSlider();
      Grid.setModeSize(def, false);
    },

    /**
     * 当前该反映到原生菜单上的界面状态（纯读取，不发 IPC）。
     * 单独抽出来是为了能在回归里直接断言它 —— 否则只能断言"调用过"，
     * 断言不到"推的内容对不对"。
     */
    menuState() {
      const sel = Grid.selectedCount ? Grid.selectedCount() : 0;
      return {
        mode: State.settings.mode,
        blur: !!State.settings.blurPreview,
        side: this.sidebarOpenNow(),   // 菜单「来源栏」的勾选态与侧栏实况一致（含窄窗自动收起）
        favOnly: !!State.favOnly,
        pin: !!State.settings.alwaysOnTop,
        frame: !!this.frameOn,
        hasItems: State.items.length > 0,
        hasSel: sel > 0,
      };
    },

    /**
     * 把界面状态推给主进程，让它重建应用菜单的勾选态。
     * 不做这件事的话，用菜单切了模式、菜单里的单选点还停在上一个 —— 看着像没生效。
     * 与上次推过的内容相同就**不发**：applySetting 在一次「恢复默认」里会被连着
     * 调二十多次，每次都重建菜单既浪费又会让菜单闪。
     */
    syncMenu() {
      if (!global.Native || !global.Native.canMenu) return false;
      const st = this.menuState();
      const key = JSON.stringify(st);
      if (key === this._menuKey) return false;
      this._menuKey = key;
      global.Native.setMenuState(st);
      return true;
    },

    /** 上一张 / 下一张：灯箱开着就翻页，没开就从首/末张打开灯箱 */
    stepImage(dir) {
      if (Lightbox.isOpen()) { Lightbox.nav(dir); return; }
      const list = State.viewList();
      if (!list.length) { this.toast('还没有图片'); return; }
      Lightbox.open(list, dir > 0 ? list[0] : list[list.length - 1]);
    },

    /**
     * 图库瓦片的原生右键菜单。
     * 非桌面环境（没有原生菜单能力）时**不拦** contextmenu —— 保持网页默认行为，
     * 而不是拦下来什么都不弹（那就成了"右键没反应"）。
     */
    async gridContext(e) {
      if (!global.Native || !global.Native.canContextMenu) return;
      const t = e.target;
      const tile = (t && t.closest) ? t.closest('.tile') : null;
      const meta = tile && tile._item;
      if (!meta) return;   // 空白处右键 → 交给默认行为
      e.preventDefault();
      // 右键点在一张**没被选中**的图上 → 先把它单独选上（与资源管理器的习惯一致）。
      // 已经选中多张时保持原选择集，这样"删除选中的 N 张"才符合预期。
      if (!Grid.isSel(meta)) { Grid.clearSel(); Grid.toggle(meta, true); }
      const selCount = Grid.selectedCount();
      this.ctxTarget = { kind: 'grid', meta: meta };
      const cmd = await global.Native.contextMenu({
        kind: 'grid',
        info: {
          fav: State.isFav(meta.id),
          rot: State.rotationOf(meta),
          selCount: selCount,
          hasPath: !!meta.path,
        },
      });
      this.ctxTarget = null;
      if (cmd) this.runCtx(cmd);
    },

    /** 灯箱大图的原生右键菜单 */
    async lightboxContext(e) {
      if (!global.Native || !global.Native.canContextMenu) return;
      if (!Lightbox.isOpen() || !Lightbox.meta) return;
      if (e) e.preventDefault();
      const meta = Lightbox.meta;
      this.ctxTarget = { kind: 'lightbox', meta: meta };
      const cmd = await global.Native.contextMenu({
        kind: 'lightbox',
        info: {
          fav: State.isFav(meta.id),
          rot: typeof Lightbox.rot === 'number' ? Lightbox.rot : State.rotationOf(meta),
          fs: !!Lightbox.isFs(),
          playing: !!Lightbox.playing,
          hasPath: !!meta.path,
        },
      });
      this.ctxTarget = null;
      if (cmd) this.runCtx(cmd);
    },

    /** 执行右键菜单命令。未接线的 id 显式告警（而不是静默无反应）。 */
    runCtx(id) {
      const fn = this.CTX_COMMANDS[id];
      if (typeof fn !== 'function') {
        if (global.console && global.console.warn) {
          global.console.warn('[app] 收到未知的右键命令：' + id + '（请在 App.CTX_COMMANDS 里补实现）');
        }
        this.toast('该功能暂不可用', { urgent: true });
        return false;
      }
      try { fn.call(this, this.ctxTarget); return true; }
      catch (err) {
        if (global.console && global.console.error) global.console.error('[app:ctx]', id, err);
        this.toast('操作失败：' + id, { urgent: true });
        return false;
      }
    },

    /** 执行应用菜单 / 托盘命令。同上：未接线必须显式告警。 */
    runCommand(id) {
      const fn = this.COMMANDS[id];
      if (typeof fn !== 'function') {
        if (global.console && global.console.warn) {
          global.console.warn('[app] 收到未知命令：' + id + '（请在 App.COMMANDS 里补实现）');
        }
        this.toast('该功能暂不可用', { urgent: true });
        return false;
      }
      try { fn.call(this); return true; }
      catch (err) {
        if (global.console && global.console.error) global.console.error('[app:cmd]', id, err);
        this.toast('操作失败：' + id, { urgent: true });
        return false;
      }
    },

    /* @cmd-table:start */
    /* ↑ 这张表的每个键都必须能在原生菜单里被点到；test/desktop.test.js
       会拿 deploy/electron/desktop-spec.js 的命令词表逐条比对，缺一个就红。
       （这就是"第六问：谁负责让它生效"的机械化版本 —— 菜单做出来了、
       没人接，表现只是"点了没反应"。） */
    COMMANDS: {
      'open-folder'() { this.openFolder(); },

      'open-trash'() {
        if (global.Native && global.Native.active) this.toggleTrash(true);
        else this.toast('回收站只在桌面版可用');
      },

      'export-selected'() {
        const sel = Grid.selected();
        if (!sel.length) { this.toast('先选中要导出的图片'); return; }
        this.exportSelected(sel);
      },

      'mode:small'() { this.setMode('small'); },
      'mode:medium'() { this.setMode('medium'); },
      'mode:masonry'() { this.setMode('masonry'); },
      'mode:single'() { this.setMode('single'); },

      'zoom-in'() { this.nudgeSize(1); },
      'zoom-out'() { this.nudgeSize(-1); },
      'zoom-reset'() { this.resetSize(); },

      'fav-only'() { this.toggleFavOnly(); },
      'blur-toggle'() { this.toggleBlur(); },
      'sidebar-toggle'() { this.toggleSidebar(); },
      'pin-toggle'() { this.togglePin(); },
      'frame-toggle'() { this.toggleFrame(); },

      'select-all-tiles'() {
        if (!State.items.length) { this.toast('还没有图片'); return; }
        Grid.selectAll(true);
      },

      'shortcuts'() { this.showShortcuts(); },
      'about'() { if (global.Settings && global.Settings.showAbout) global.Settings.showAbout(); },
    },
    /* @cmd-table:end */

    /* @ctx-table:start */
    /* ↑ 原生右键菜单的命令。目标条目从 this.ctxTarget 取（见 gridContext）。 */
    CTX_COMMANDS: {
      'ctx:open'() {
        const m = this.ctxTarget && this.ctxTarget.meta;
        if (m) Lightbox.open(State.viewList(), m);
      },

      'ctx:prev'() { this.stepImage(-1); },
      'ctx:next'() { this.stepImage(1); },

      'ctx:rot-l'() { this.rotateTarget(-1); },
      'ctx:rot-r'() { this.rotateTarget(1); },
      'ctx:rot-reset'() { this.rotateTarget(0); },

      'ctx:fav'() {
        const t = this.ctxTarget;
        if (!t || !t.meta) return;
        // 灯箱开着且点的是当前这张 → 交给灯箱（它会同步自己的星标按钮）
        if (Lightbox.isOpen() && Lightbox.meta === t.meta && Lightbox.toggleFav) Lightbox.toggleFav();
        else State.toggleFav(t.meta.id);
      },

      'ctx:fs'() { if (Lightbox.isOpen()) Lightbox.toggleFs(); },

      'ctx:zoom-in'() { this.zoomTarget(1.4); },
      'ctx:zoom-out'() { this.zoomTarget(1 / 1.4); },
      'ctx:zoom-fit'() { if (Lightbox.isOpen()) Lightbox.fit(true); },

      'ctx:show-in-folder'() {
        const m = this.ctxTarget && this.ctxTarget.meta;
        if (!m || !m.path) { this.toast('这张图没有磁盘路径，无法定位'); return; }
        global.Native.showInFolder(m.path).then((ok) => {
          if (!ok) this.toast('未能在资源管理器中定位该文件', { urgent: true });
        });
      },

      'ctx:export-one'() {
        const m = this.ctxTarget && this.ctxTarget.meta;
        if (m) this.exportSelected([m]);
      },
      'ctx:export-sel'() { this.exportSelected(Grid.selected()); },

      'ctx:delete'() {
        const t = this.ctxTarget;
        if (!t || !t.meta) return;
        const sel = Grid.selected();
        if (t.kind === 'grid' && sel.length > 1 && Grid.isSel(t.meta)) this.requestDeleteMany(sel);
        else if (t.kind === 'lightbox') this.requestDelete(t.meta, { fromLightbox: true });
        else this.requestDelete(t.meta);
      },

      'ctx:sel-all'() { if (State.items.length) Grid.selectAll(true); },
      'ctx:sel-none'() { Grid.clearSel(); },
    },
    /* @ctx-table:end */

    /** 对右键目标做旋转：dir = -1 左转 / 1 右转 / 0 复位 */
    rotateTarget(dir) {
      const t = this.ctxTarget;
      if (!t || !t.meta) return;
      if (t.kind === 'lightbox' && Lightbox.isOpen() && Lightbox.meta === t.meta) {
        if (dir === 0) { if (Lightbox.resetRot) Lightbox.resetRot(); }
        else Lightbox.rotate(dir);
        return;
      }
      if (dir === 0) State.setRotation(t.meta, 0);
      else State.rotateBy(t.meta, dir);
    },

    /** 对灯箱当前图做缩放（以舞台中心为不动点） */
    zoomTarget(f) {
      if (!Lightbox.isOpen()) return;
      const c = Lightbox._center();
      Lightbox.zoomAt(f, c.x, c.y);
    },

    /** 快捷键一览（原生菜单 F1）。内容全部来自实际绑定，不写"计划中"的项。 */
    async showShortcuts() {
      const k = (s) => '<kbd>' + Util.esc(s) + '</kbd>';
      const row = (keys, what) => '<tr><td class="sc-keys">' + keys + '</td><td>' + what + '</td></tr>';
      const body = ''
        + '<div class="vf-shortcuts">'
        + '<table class="sc-table"><tbody>'
        + row(k('Ctrl+O'), '打开文件夹')
        + row(k('Ctrl+E'), '导出选中的图片')
        + row(k('Ctrl+1') + ' ' + k('Ctrl+2') + ' ' + k('Ctrl+3') + ' ' + k('Ctrl+4'), '小图 / 中图 / 瀑布流 / 单列')
        + row(k('Ctrl+Plus') + ' ' + k('Ctrl+-') + ' ' + k('Ctrl+0'), '放大 / 缩小 / 重置尺寸')
        + row(k('Ctrl+L'), '只看收藏')
        + row(k('Ctrl+B'), '模糊预览（隐私模式）')
        + row(k('Ctrl+Shift+B'), '展开 / 收起来源栏')
        + row(k('Ctrl+T'), '窗口置顶')
        + row(k('Ctrl+Shift+F'), '相框模式')
        + row(k('Ctrl+Shift+A'), '全选当前页')
        + row(k('Ctrl+A'), '全选当前页（图库内直接按）')
        + row(k('1') + ' ' + k('2') + ' ' + k('3') + ' ' + k('4'), '切换排列模式')
        + row(k('M'), '依次切换排列模式')
        + row(k('F'), '只看收藏')
        + row(k('/'), '搜索文件名')
        + row(k('+') + ' ' + k('-'), '放大 / 缩小瓦片')
        + row(k('Delete'), '删除选中的图片（移入回收站）')
        + row(k('Esc'), '取消选择 / 关闭面板 / 退出回收站')
        + row(k('空格'), '灯箱内：下一张')
        + row(k('F11'), '全屏')
        + row(k('F1'), '打开这张表')
        + '</tbody></table>'
        + '<p class="vf-about-p">在图片上按鼠标右键会弹出原生菜单（打开、旋转、收藏、'
        + '在资源管理器中显示、导出、删除）。</p>'
        + '</div>';
      await this.modal({ title: '快捷键一览', body: body, confirmText: '知道了', single: true });
    },

    /* ================= 轻提示 ================= */
    /**
     * 轻提示。opts.action = { label, onClick } 时追加一个操作按钮（如「撤销」），
     * 并延长停留时间；返回可提前关闭的 cleanup。
     */
    toast(msg, opts) {
      // 先播报给读屏，再画视觉提示。这个仓库 toast 有 50 处调用点，覆盖
      // "已移入回收站""已还原 3 张""导出失败"这类**除了这条提示没有别的视觉痕迹**
      // 的动作 —— 不播报，读屏用户按下去就等于什么都没发生。
      // urgent 走 assertive（失败 / 危险操作立即插话），其余 polite（等当前朗读结束）。
      if (A11y && A11y.live) A11y.live(msg, { urgent: !!(opts && opts.urgent) });
      const d = document.createElement('div');
      d.className = 'toast';
      const span = document.createElement('span');
      span.textContent = msg;
      d.appendChild(span);

      let dead = false, t1 = 0;
      const cleanup = () => {
        if (dead) return;
        dead = true;
        if (t1) clearTimeout(t1);
        d.classList.remove('show');
        setTimeout(() => d.remove(), 400);
      };

      if (opts && opts.action) {
        d.classList.add('toast-act');
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'toast-btn';
        b.textContent = opts.action.label;
        b.addEventListener('click', () => { cleanup(); opts.action.onClick(); });
        d.appendChild(b);
      }
      document.body.appendChild(d);
      setTimeout(() => d.classList.add('show'));
      t1 = setTimeout(cleanup, (opts && opts.action) ? (opts.duration || 8000) : 2600);
      return cleanup;
    },

    /* ================= 演示自检（?demo=1 触发） ================= */
    async _demoLoad() {
      const C = 24, W = 900, H = Math.round(W * 0.75);
      const files = [];
      for (let i = 0; i < C; i++) {
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const ctx = c.getContext('2d');
        const hue = (i * 47) % 360, hue2 = (hue + 70) % 360;
        const g = ctx.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, `hsl(${hue},58%,72%)`);
        g.addColorStop(1, `hsl(${hue2},68%,32%)`);
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        ctx.globalAlpha = 0.18; ctx.fillStyle = '#fff';
        for (let k = 0; k < 7; k++) ctx.fillRect(0, (H * k / 7) | 0, W, 22);
        ctx.globalAlpha = 1;
        ctx.font = '600 70px Georgia, "Songti SC", serif';
        ctx.fillStyle = 'rgba(255,255,255,.95)';
        ctx.fillText('样张 ' + String(i + 1).padStart(2, '0'), 56, 110);
        const sub = ['Atrium', 'Beam', 'Cloud', 'Dust', 'Echo', 'Field', 'Glaze', 'Haze', 'Iris', 'Jet', 'Kite', 'Loom', 'Mist', 'Noon', 'Onyx', 'Pier', 'Quill', 'Rune', 'Slate', 'Tide', 'Umbra', 'Vine', 'Wisp', 'Yarn'][i];
        ctx.font = '500 28px Georgia'; ctx.fillStyle = 'rgba(255,255,255,.78)';
        ctx.fillText(sub, 56, 152);
        const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
        files.push(new File([blob], 'sample-' + String(i + 1).padStart(2, '0') + '-' + sub.toLowerCase() + '.png', { type: 'image/png' }));
      }
      Loader.fromInput(files, '演示图片');
      document.body.dataset.demo = '1';
    },
  };

  const QS = new URLSearchParams(location.search);

  /* 相框窗口（index.html?frame=1）：只起相框，不初始化图库。
     图库那一套（来源条 / 网格 / 灯箱 / 设置）在相框窗口里毫无用处，
     硬起一遍只会拖慢相框出图、还会多占一份内存。 */
  if (QS.get('frame') === '1') {
    const bootFrame = () => { if (global.Frame) global.Frame.bootWindow(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootFrame, { once: true });
    else bootFrame();
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => App.init());
  } else {
    App.init();
  }

  /* 仅在 ?demo=1 时启用：合成 24 张示例图片并走完整图库流程（用于自动化冒烟/截图，不影响正常使用） */
  if (QS.get('demo') === '1') {
    setTimeout(() => App._demoLoad(), 80);
  }

  global.App = App;
})(window);
