/* ============================================================
   Atrium · preload（沙箱内最小暴露面）
   只暴露白名单 IPC 方法；渲染进程保持 nodeIntegration:false
   ============================================================ */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vfNative', {
  /** 弹出原生“选择文件夹”对话框，返回目录绝对路径或 null */
  pickFolder: () => ipcRenderer.invoke('vf:pickFolder'),

  /** 弹出「选择导出位置」对话框，返回目录绝对路径或 null */
  pickExportDir: () => ipcRenderer.invoke('vf:pickExportDir'),

  /** 批量导出到目录。list=[{src:绝对路径|null, name, dataB64?}]
      → {ok, dir, results:[{ok,name,out?}|{ok:false,name,reason,message?}]}
      src 走文件复制（无损）；dataB64 用于旋转烘焙后的结果。同名自动加 “ (2)”。 */
  exportFiles: (dir, list) => ipcRenderer.invoke('vf:exportFiles', dir, list),

  /** 主进程递归列出目录内全部图片元数据 {ok,name,files} */
  loadDir: (dir) => ipcRenderer.invoke('vf:loadDir', dir),

  /** 主进程记忆的“上次目录”路径（存在且可读才返回） */
  autoDir: () => ipcRenderer.invoke('vf:autoDir'),

  /** 记忆/刷新“上次目录”（载入成功后调用） */
  setLastDir: (dir) => { ipcRenderer.send('vf:setLastDir', dir); },

  /** 读取文件开头 ≤n 字节（EXIF 解析用），返回 ArrayBuffer 或 null */
  readHead: (p, n) => ipcRenderer.invoke('vf:readHead', p, n || 262144),

  /** 删除文件（主进程移入系统回收站，可恢复）
      p=绝对路径；rec={name?,size?} 记入删除日志
      → {ok,mode:'trash',ts,size,logId} | {ok:false,reason,message} */
  deleteFile: (p, rec) => ipcRenderer.invoke('vf:deleteFile', p, rec),

  /** 批量删除（一次 IPC 走完 N 张，逐张独立成败）
      list=[{path,rec:{name,size,meta}}] → [{ok,mode,ts,size,logId,path,name}|{ok:false,reason,path}] */
  deleteFiles: (list) => ipcRenderer.invoke('vf:deleteFiles', list),

  /** 撤销删除：把文件从回收站还原回原位置
      rec={id?,path,size?,ts?} → {ok,size} | {ok:false,reason:'not-found'|'occupied'|…} */
  restoreFile: (rec) => ipcRenderer.invoke('vf:restoreFile', rec),

  /** 批量撤销删除：recs=[{id,path,size,ts}] → [{ok,path,size?}|{ok:false,reason,path}] */
  restoreFiles: (recs) => ipcRenderer.invoke('vf:restoreFiles', recs),

  /** 回收站缩略图：从回收站里的 $R 读回内容（≤6MB）→ {ok,url(dataURL)} | {ok:false,reason} */
  trashPreview: (rec) => ipcRenderer.invoke('vf:trashPreview', rec),

  /** 最近删除记录（跨启动保留，最新在前）→ [{id,name,path,size,ts,meta}] */
  trashLog: () => ipcRenderer.invoke('vf:trashLog'),

  /** 只丢弃一条记录（文件仍留在回收站） */
  trashForget: (id) => ipcRenderer.invoke('vf:trashForget', id),

  /** 清空全部删除记录（不触碰回收站里的文件） */
  trashClear: () => ipcRenderer.invoke('vf:trashClear'),

  /** 打开系统「回收站」文件夹（还原失败时的人工兜底） */
  openRecycleBin: () => ipcRenderer.invoke('vf:openRecycleBin'),

  /** 用系统文件管理器打开某目录（导出完成后的「打开文件夹」） */
  openPath: (p) => ipcRenderer.invoke('vf:openPath', p),

  /* ---------- 版本更新检测（v1.14.0） ---------- */
  /** 打开官方仓库 / Releases 页面。主进程侧有 **URL 白名单**，
      只放行 https://github.com/jhlxlml/Atrium 及其子路径；其余一律返回 false。
      渲染层绝不能自己导航到外链（主窗口的 will-navigate 会拦下来）。 */
  openExternal: (url) => ipcRenderer.invoke('vf:openExternal', url),

  /** 查是否有新版本。current 传 App.VERSION（版本号的唯一来源）。
      → {ok:true,current,latest,hasUpdate,url} | {ok:false,reason,current}
      reason ∈ 'timeout'|'network'|'http-<code>'|'bad-response'。
      注意：**"检查失败"与"已是最新"是两种结果**，调用方必须分开显示。 */
  checkUpdate: (current) => ipcRenderer.invoke('vf:checkUpdate', current),

  /** 窗口置顶。on=true 置顶。返回「实际生效后」的布尔值（而非请求值） */
  alwaysOnTop: (on) => ipcRenderer.invoke('vf:alwaysOnTop', !!on),

  /** 查询当前是否置顶（启动时与真实窗口状态对齐） */
  getAlwaysOnTop: () => ipcRenderer.invoke('vf:getAlwaysOnTop'),

  /* ---------- 相框模式（独立无边框窗口） ---------- */
  /** 打开相框窗口。payload={ms,fit,src,dock,sources,items:[{p,n,w,h,r,sid,id,fav,bad}]}
      → {ok} 或 {ok:false,reason}。items 是**全部**条目（不只当前相册），
      好让相框窗口自己换相册，不必为换个相册再绕一趟 IPC。 */
  frameOpen: (payload) => ipcRenderer.invoke('vf:frameOpen', payload),
  /** 关闭相框窗口，主窗口会被重新显示 */
  frameClose: () => ipcRenderer.invoke('vf:frameClose'),
  /** 相框窗口取自己的播放清单 */
  frameData: () => ipcRenderer.invoke('vf:frameData'),
  /** 相框窗口请求按图片比例改自己的窗口尺寸；返回实际应用的矩形 */
  frameFit: (box) => ipcRenderer.invoke('vf:frameFit', box),
  /** 相框窗口状态（是否开着 / 置顶 / 无边框 / 矩形）；诊断与回归用 */
  frameInfo: () => ipcRenderer.invoke('vf:frameInfo'),
  /** 相框窗口自报"用户正把它拖到 (x,y)"。拖动由渲染进程累加指针偏移算出来
      （不能用 `-webkit-app-region: drag`：那样整个图片变成系统拖拽区，单击换图会消失） */
  frameMove: (pos) => ipcRenderer.invoke('vf:frameMove', pos),
  /** 屏幕清单 [{id,label,primary,workArea}]，给「相框输出屏幕」用；浏览器环境返回空数组 */
  listDisplays: () => ipcRenderer.invoke('vf:listDisplays'),
  /** 相框窗口第一张已画出的回执 */
  framePainted: (info) => ipcRenderer.invoke('vf:framePainted', info),
  /** 订阅"相框窗口已关闭"（只回传一个事件名，不透传 IpcRendererEvent） */
  onFrameClosed: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('vf:frameClosed', () => { try { cb(); } catch (e) { /* 忽略 */ } });
  },
  /** 订阅"相框窗口被拖动后落位"，回传真实矩形 {x,y,width,height}。
      原生拖拽是系统行为，渲染进程拿不到过程，只能等拖完由主进程回传一次。 */
  onFrameMoved: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('vf:frameMoved', (e, b) => { try { cb(b); } catch (err) { /* 忽略 */ } });
  },

  /* ============================================================
     桌面集成（应用菜单 / 右键菜单 / 托盘 / 任务栏 / 全局快捷键）
     ============================================================ */
  /** 订阅原生菜单与托盘发过来的命令 id（只传字符串，不透传 IpcRendererEvent）。
      渲染层用 App.COMMANDS 分发；表里没有的 id 会被显式告警而不是静默丢弃。 */
  onCommand: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('vf:cmd', (e, cmd) => { try { cb(String(cmd || '')); } catch (err) { /* 忽略 */ } });
  },

  /** 把菜单勾选态推给主进程（模式 / 收藏筛选 / 隐私模式 / 置顶 / 是否有选中） */
  setMenuState: (st) => ipcRenderer.invoke('vf:menuState', st),

  /** 弹原生右键菜单。payload={kind:'grid'|'lightbox', info:{…}}
      → Promise<被点中的命令 id | null>（菜单关闭但没选中时 resolve(null)） */
  contextMenu: (payload) => ipcRenderer.invoke('vf:contextMenu', payload),

  /** 在系统文件管理器里定位某个文件（选中它并打开所在目录） */
  showInFolder: (p) => ipcRenderer.invoke('vf:showInFolder', p),

  /** 任务栏进度条。value ∈ [0,1] 显示，< 0 收起；mode='indeterminate' 表示总数未知 */
  setProgress: (value, mode) => ipcRenderer.invoke('vf:setProgress', value, mode),

  /** 托盘开关与关闭行为。st={on:boolean, closeOn:boolean} → 托盘是否真的建起来了 */
  setTray: (st) => ipcRenderer.invoke('vf:setTray', st),

  /** 注册全局快捷键（如 'Ctrl+Alt+A'）；传空串注销。
      → {ok, registered}；registered=false 表示被别的程序占用了（必须如实告知用户） */
  setHotkey: (accel) => ipcRenderer.invoke('vf:setHotkey', accel),

  /** 桌面集成当前状态（诊断与回归用） */
  desktopInfo: () => ipcRenderer.invoke('vf:desktopInfo'),
});
