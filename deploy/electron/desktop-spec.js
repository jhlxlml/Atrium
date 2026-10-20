/* ============================================================
   Atrium · desktop-spec.js —— 桌面集成的**纯数据层**
   ------------------------------------------------------------
   为什么单独一份、且**不许 require('electron')**：
   原生菜单/托盘/右键菜单是"写错了也不报错"的重灾区 ——
   少接一个 case、加速键拼错一个字母，表现都只是"点了没反应"，
   而这类静默失效本项目已经栽过六次。把模板做成纯函数
   （普通状态对象 → 普通节点数组），就能在纯 Node 里直接断言：
     · 每个 cmd 都在渲染层的命令表里有实现（"第六问"机械化）
     · 加速键语法合法、且全局不重复（重复的会被 Electron 静默丢弃）
     · 有状态项（checkbox / radio）的 checked 真的跟随输入
   本文件被 test/desktop.test.js 与 deploy/electron/desktop.js 共用。

   节点形状 = Electron 模板的形状（不做二次翻译，少一层映射就少一处漂移）：
     { type:'separator' }
     { label, accel?, cmd?, enabled?, type?:'checkbox'|'radio', checked? }
     { label, submenu:[…] }
     { role, label? }
   ============================================================ */
'use strict';

/* ------------------------------------------------------------
   命令词表。渲染层 App.COMMANDS 必须与之一一对应 ——
   run_all.js 的 desktop 套件会逐条比对，缺一个就红。
   ------------------------------------------------------------ */
const COMMANDS = [
  'open-folder',        // 选文件夹并载入
  'open-trash',         // 打开「最近删除」
  'export-selected',    // 导出当前选中的图片
  'mode:small',         // 四种排列模式（与 State.MODE_ORDER 同序）
  'mode:medium',
  'mode:masonry',
  'mode:single',
  'zoom-in',            // 放大一档瓦片/列宽
  'zoom-out',           // 缩小一档
  'zoom-reset',         // 回到当前模式的默认尺寸
  'fav-only',           // 只看收藏
  'blur-toggle',        // 模糊预览（隐私模式）
  'sidebar-toggle',     // 展开 / 收起左侧来源栏
  'pin-toggle',         // 窗口置顶
  'frame-toggle',       // 进入 / 退出相框
  'select-all-tiles',   // 全选当前页（刻意不用 Ctrl+A，见下）
  'shortcuts',          // 快捷键一览
  'about',              // 关于
];

/* 右键菜单专用的命令（不走应用菜单，但同样要有实现） */
const CTX_COMMANDS = [
  'ctx:open',           // 灯箱打开这张
  'ctx:prev', 'ctx:next',
  'ctx:rot-l', 'ctx:rot-r', 'ctx:rot-reset',
  'ctx:fav',            // 切换收藏
  'ctx:fs',             // 全屏开关
  'ctx:zoom-in', 'ctx:zoom-out', 'ctx:zoom-fit',
  'ctx:show-in-folder', // 在系统文件管理器中定位
  'ctx:export-one', 'ctx:export-sel',
  'ctx:delete',
  'ctx:sel-all', 'ctx:sel-none',
  /* 托盘菜单。托盘是主进程自己拥有的窗口，不经过渲染层 ——
     这两条由 desktop.js 直接执行，故不在 App.COMMANDS 里。 */
  'tray:toggle-window', 'tray:quit',
];

const ALL_COMMANDS = COMMANDS.concat(CTX_COMMANDS);

/* ------------------------------------------------------------
   加速键校验。
   Electron 对拼错的加速键**不抛错**，只是注册不上（点菜单有反应、
   按键没反应）—— 正是最难发现的那种坏法。这里按官方文档的
   修饰键 + 键名清单做一次语法检查。
   ------------------------------------------------------------ */
const MODS = new Set(['CmdOrCtrl', 'CommandOrControl', 'Cmd', 'Command', 'Ctrl', 'Control',
  'Alt', 'Option', 'AltGr', 'Shift', 'Super', 'Meta']);

const KEYS = new Set();
(function buildKeys() {
  for (let i = 0; i <= 9; i++) KEYS.add(String(i));
  for (let c = 65; c <= 90; c++) KEYS.add(String.fromCharCode(c));
  for (let i = 1; i <= 24; i++) KEYS.add('F' + i);
  [
    'Plus', 'Space', 'Tab', 'Backspace', 'Delete', 'Insert', 'Return', 'Enter',
    'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown',
    'Escape', 'Esc', 'VolumeUp', 'VolumeDown', 'VolumeMute', 'MediaNextTrack',
    'MediaPreviousTrack', 'MediaStop', 'MediaPlayPause', 'PrintScreen',
    'Numlock', 'Scrolllock', 'Capslock',
    '~', '!', '@', '#', '$', '%', '^', '&', '*', '(', ')',
    '-', '_', '+', '=', '[', ']', '{', '}', '\\', '|',
    ';', ':', "'", '"', ',', '<', '.', '>', '/', '?', '`',
  ].forEach((k) => KEYS.add(k));
})();

/** 加速键字符串是否合法。返回 { ok, why } */
function checkAccel(accel) {
  if (typeof accel !== 'string' || !accel) return { ok: false, why: '空加速键' };
  const parts = accel.split('+');
  if (parts.length === 1) {
    /* 唯一允许"无修饰键"的是 F1–F24。别的一律要求带修饰键：
       裸字母/裸数字的加速键会把普通打字也吃掉，是这个应用绝不能出的错。 */
    if (!/^F([1-9]|1[0-9]|2[0-4])$/.test(parts[0])) {
      return { ok: false, why: '缺少修饰键（只有 F1–F24 可以单用）：' + accel };
    }
    return { ok: true, why: '' };
  }
  const key = parts[parts.length - 1];
  for (const m of parts.slice(0, -1)) {
    if (!MODS.has(m)) return { ok: false, why: '未知修饰键 "' + m + '"（' + accel + '）' };
  }
  if (!KEYS.has(key)) return { ok: false, why: '未知键名 "' + key + '"（' + accel + '）' };
  return { ok: true, why: '' };
}

/* ------------------------------------------------------------
   应用菜单模板
   ------------------------------------------------------------
   state = { mode, blur, favOnly, pin, frame, hasItems, hasSel, trayOn, hotkey }
   ------------------------------------------------------------ */
function appMenuSpec(state) {
  const st = state || {};
  const mode = st.mode || 'medium';
  const hasItems = !!st.hasItems;

  /* 排列模式：与 State.MODE_ORDER 同序（小图 → 中图 → 瀑布流 → 单列）。
     radio 项必须**连续**排列才能被 Electron 当成同一组。 */
  const modeItems = [
    ['small', '小图网格', 'CmdOrCtrl+1'],
    ['medium', '中图网格', 'CmdOrCtrl+2'],
    ['masonry', '瀑布流', 'CmdOrCtrl+3'],
    ['single', '单列整屏', 'CmdOrCtrl+4'],
  ].map(([key, label, accel]) => ({
    label, type: 'radio', accel, checked: mode === key, cmd: 'mode:' + key,
  }));

  return [
    {
      label: '文件',
      submenu: [
        { label: '打开文件夹…', accel: 'CmdOrCtrl+O', cmd: 'open-folder' },
        { label: '打开回收站', cmd: 'open-trash' },
        { type: 'separator' },
        { label: '导出选中的图片…', accel: 'CmdOrCtrl+E', cmd: 'export-selected', enabled: !!st.hasSel },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      /* 编辑菜单**刻意不放「全选」的 Ctrl+A**：
         图库里的 Ctrl+A 是"全选当前页的图片"（App.wireKeyboard 里处理），
         一旦菜单也占用 CmdOrCtrl+A，主进程会先把按键吃掉，两个都失灵。
         所以全选改挂 Ctrl+Shift+A 并由渲染层执行；剪贴板四项照常给 role，
         它们在文本框里的行为与没有菜单时一致（不会抢走任何既有功能）。 */
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { type: 'separator' },
        { label: '全选当前页', accel: 'CmdOrCtrl+Shift+A', cmd: 'select-all-tiles', enabled: hasItems },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '排列模式', submenu: modeItems },
        { type: 'separator' },
        { label: '放大', accel: 'CmdOrCtrl+Plus', cmd: 'zoom-in', enabled: hasItems },
        { label: '缩小', accel: 'CmdOrCtrl+-', cmd: 'zoom-out', enabled: hasItems },
        { label: '重置尺寸', accel: 'CmdOrCtrl+0', cmd: 'zoom-reset', enabled: hasItems },
        { type: 'separator' },
        { label: '只看收藏', type: 'checkbox', accel: 'CmdOrCtrl+L', checked: !!st.favOnly, cmd: 'fav-only' },
        { label: '模糊预览（隐私模式）', type: 'checkbox', accel: 'CmdOrCtrl+B', checked: !!st.blur, cmd: 'blur-toggle' },
        /* 侧栏不能也占 Ctrl+B —— 会被模糊预览抢走（两个处理器都收得到 keydown）。
           用 Ctrl+Shift+B，与「只看收藏」「模糊预览」同一档。 */
        { label: '来源栏', type: 'checkbox', accel: 'CmdOrCtrl+Shift+B', checked: !!st.side, cmd: 'sidebar-toggle' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { label: '窗口置顶', type: 'checkbox', accel: 'CmdOrCtrl+T', checked: !!st.pin, cmd: 'pin-toggle' },
        { label: '相框模式', accel: 'CmdOrCtrl+Shift+F', cmd: 'frame-toggle' },
        { type: 'separator' },
        { label: '最小化', role: 'minimize' },
        { label: '关闭窗口', role: 'close' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '快捷键一览', accel: 'F1', cmd: 'shortcuts' },
        { label: '关于 Atrium', cmd: 'about' },
      ],
    },
  ];
}

/* ------------------------------------------------------------
   右键菜单模板
   ------------------------------------------------------------
   kind = 'grid'（图库瓦片） | 'lightbox'（大图）
   info = { fav, rot, selCount, playing, fs, hasPath }
   ------------------------------------------------------------ */
function contextMenuSpec(kind, info) {
  const it = info || {};
  const rot = ((it.rot | 0) % 360 + 360) % 360;

  const rotMenu = {
    label: '旋转',
    submenu: [
      { label: '向左转 90°', cmd: 'ctx:rot-l' },
      { label: '向右转 90°', cmd: 'ctx:rot-r' },
      { label: '恢复原始朝向', cmd: 'ctx:rot-reset', enabled: rot !== 0 },
    ],
  };

  if (kind === 'lightbox') {
    return [
      { label: '上一张', cmd: 'ctx:prev' },
      { label: '下一张', cmd: 'ctx:next' },
      { type: 'separator' },
      { label: '放大', cmd: 'ctx:zoom-in' },
      { label: '缩小', cmd: 'ctx:zoom-out' },
      { label: '适应窗口', cmd: 'ctx:zoom-fit' },
      { type: 'separator' },
      rotMenu,
      { label: it.fav ? '取消收藏' : '收藏这张', cmd: 'ctx:fav' },
      { label: it.fs ? '退出全屏' : '全屏显示', cmd: 'ctx:fs' },
      { type: 'separator' },
      { label: '在资源管理器中显示', cmd: 'ctx:show-in-folder', enabled: !!it.hasPath },
      { label: '导出这张…', cmd: 'ctx:export-one' },
      { type: 'separator' },
      { label: '删除（移入回收站）', cmd: 'ctx:delete' },
    ];
  }

  /* 图库：右键点在瓦片上。若这张不在选择集里，点击时应先把它选上
     —— 交给渲染层做（见 App.gridContext），菜单只负责给出动作。 */
  const n = it.selCount | 0;
  return [
    { label: '打开', cmd: 'ctx:open' },
    { type: 'separator' },
    { label: it.fav ? '取消收藏' : '收藏这张', cmd: 'ctx:fav' },
    rotMenu,
    { label: '在资源管理器中显示', cmd: 'ctx:show-in-folder', enabled: !!it.hasPath },
    { type: 'separator' },
    { label: n > 1 ? ('导出选中的 ' + n + ' 张…') : '导出这张…', cmd: n > 1 ? 'ctx:export-sel' : 'ctx:export-one' },
    { label: n > 1 ? ('删除选中的 ' + n + ' 张（移入回收站）') : '删除（移入回收站）', cmd: 'ctx:delete' },
    { type: 'separator' },
    { label: '全选当前页', cmd: 'ctx:sel-all' },
    { label: '取消选择', cmd: 'ctx:sel-none', enabled: n > 0 },
  ];
}

/* ------------------------------------------------------------
   托盘菜单模板
   state = { visible }
   ------------------------------------------------------------ */
function trayMenuSpec(state) {
  const visible = !!(state && state.visible);
  return [
    { label: visible ? '隐藏主窗口' : '显示主窗口', cmd: 'tray:toggle-window' },
    { type: 'separator' },
    { label: '打开文件夹…', cmd: 'open-folder' },
    { label: '打开回收站', cmd: 'open-trash' },
    { type: 'separator' },
    { label: '退出 Atrium', cmd: 'tray:quit' },
  ];
}

/* ------------------------------------------------------------
   缩略图工具栏（Windows 任务栏缩略图按钮）的图标。
   Windows 要求 16×16 的**白色单色**图标，由系统叠在缩略图上。
   这里用 ASCII 点阵直接画出来 —— 不需要任何图片资产，也不需要
   构建期生成 PNG（nativeImage.createFromBitmap 收的就是原始 BGRA）。
   ------------------------------------------------------------ */
const GLYPH_PREV = [
  '................',
  '................',
  '.......##.......',
  '......###.......',
  '.....####.......',
  '....#####.......',
  '...######.......',
  '..#######.......',
  '..#######.......',
  '...######.......',
  '....#####.......',
  '.....####.......',
  '......###.......',
  '.......##.......',
  '................',
  '................',
];

const GLYPH_NEXT = GLYPH_PREV.map((row) => row.split('').reverse().join(''));

const GLYPH_FRAME = [
  '................',
  '................',
  '..############..',
  '..#..........#..',
  '..#..........#..',
  '..#..######..#..',
  '..#..#....#..#..',
  '..#..#....#..#..',
  '..#..#....#..#..',
  '..#..#....#..#..',
  '..#..######..#..',
  '..#..........#..',
  '..############..',
  '................',
  '................',
  '................',
];

/** ASCII 点阵 → BGRA 缓冲（白字 + 全透明底） */
function glyphToBGRA(rows) {
  const w = 16, h = 16;
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = rows[y] || '';
    for (let x = 0; x < w; x++) {
      const on = row.charAt(x) === '#';
      const i = (y * w + x) * 4;
      buf[i] = on ? 255 : 0;      // B
      buf[i + 1] = on ? 255 : 0;  // G
      buf[i + 2] = on ? 255 : 0;  // R
      buf[i + 3] = on ? 255 : 0;  // A
    }
  }
  return buf;
}

const THUMBAR = [
  { key: 'prev', tooltip: '上一张', cmd: 'ctx:prev', rows: GLYPH_PREV },
  { key: 'next', tooltip: '下一张', cmd: 'ctx:next', rows: GLYPH_NEXT },
  { key: 'frame', tooltip: '相框模式', cmd: 'frame-toggle', rows: GLYPH_FRAME },
];

/* ------------------------------------------------------------
   自检：模板本身的一致性（run_all 的 desktop 套件会用到）
   返回 { ok, problems:[…] }
   ------------------------------------------------------------ */

/**
 * 对一组「具名菜单模板」做一致性审查。
 * 拆出来是为了能对**故意写坏的模板**跑一遍反向用例 —— 否则这条门禁
 * 只是在"自己说自己没问题"，坏掉也不会有人知道（本项目的 ZIP CRC
 * 就在这种假安全感上栽过一次）。
 * @param {Array<{name:string, nodes:Array}>} menus
 */
function auditNodes(menus) {
  const problems = [];
  const accels = new Map();   // 加速键 → 首个使用者（全局唯一，跨菜单一起查）

  const walk = (nodes, path) => {
    for (const n of nodes) {
      if (!n || typeof n !== 'object') { problems.push(path + ' 出现非对象节点'); continue; }
      const at = path + '/' + (n.label || n.role || n.type || '?');
      if (n.accel) {
        const c = checkAccel(n.accel);
        if (!c.ok) problems.push(at + ' 加速键非法：' + c.why);
        const k = String(n.accel).toLowerCase();
        if (accels.has(k)) problems.push(at + ' 加速键重复：' + n.accel + '（与 ' + accels.get(k) + ' 撞车）');
        else accels.set(k, at);
      }
      if (n.cmd && ALL_COMMANDS.indexOf(n.cmd) < 0) problems.push(at + ' 的 cmd 不在命令词表里：' + n.cmd);
      if (n.role && n.cmd) problems.push(at + ' 同时写了 role 与 cmd（click 会被 role 覆盖）');
      if (n.submenu) walk(n.submenu, at);
    }
  };
  for (const m of (menus || [])) walk(m.nodes || [], m.name || '?');
  return { ok: problems.length === 0, problems };
}

function auditTemplates() {
  const menus = [
    { name: '应用菜单', nodes: appMenuSpec({ mode: 'medium' }) },
    { name: '右键·图库(多选)', nodes: contextMenuSpec('grid', { selCount: 2 }) },
    { name: '右键·图库(单张)', nodes: contextMenuSpec('grid', { selCount: 1 }) },
    { name: '右键·大图', nodes: contextMenuSpec('lightbox', { rot: 90 }) },
    { name: '托盘', nodes: trayMenuSpec({ visible: true }) },
    { name: '托盘(已隐藏)', nodes: trayMenuSpec({ visible: false }) },
  ];
  const r = auditNodes(menus);
  const problems = r.problems.slice();

  // 反查：命令词表里不能有"挂上去却没人用"的死条目
  const used = new Set();
  const collect = (nodes) => nodes.forEach((n) => { if (n.cmd) used.add(n.cmd); if (n.submenu) collect(n.submenu); });
  for (const m of menus) collect(m.nodes);
  for (const c of ALL_COMMANDS) {
    if (!used.has(c)) problems.push('命令词表里有未被任何菜单使用的条目：' + c);
  }

  return { ok: problems.length === 0, problems };
}

module.exports = {
  COMMANDS, CTX_COMMANDS, ALL_COMMANDS,
  checkAccel, appMenuSpec, contextMenuSpec, trayMenuSpec,
  glyphToBGRA, GLYPH_PREV, GLYPH_NEXT, GLYPH_FRAME, THUMBAR,
  auditNodes, auditTemplates,
};
