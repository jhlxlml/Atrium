# Atrium · 开发上手手册

> **这份文档解决什么问题**：让你在**不读 9600 行源码**的前提下，安全地改这个项目。
>
> 与另两份文档分工不同：
> - 《`Atrium_现状分析与迭代建议.md`》讲**过去做了什么、为什么这么做**（迭代史 + 成熟度评估）；
> - 《`deploy/release/RELEASE.md`》讲**怎么出一版**（固定顺序 + 验收标准 + 打包高危坑）；
> - **这份**讲**现在怎么动它、动之前必须知道什么**（上手路径 + 雷区清单 + 标准动作）。
>
> 生成日期：2026-10-12 ｜ 对应版本：**v1.14.0**（`App.VERSION`）
> **本文所有数字都是实测的**（`wc -l` / `run_all.js` 末行 / `grep -c`）。改完代码顺手复核一遍。

---

## 0. 一页速览

| 维度    | 事实                                                                                |
| ----- | --------------------------------------------------------------------------------- |
| 是什么   | **纯本地图片浏览器**。选文件夹 → 像翻作品集一样看图。全程不联网、不上传、不复制。                                      |
| 交付形态  | **只有一种：Electron 便携包**（解压即用，双击 `Atrium.cmd`）。离线单文件 HTML 版在 v1.13.0 已退役                |
| 源码规模  | JS **9584 行 / 15 模块**；CSS 1805 行 / 3 文件；`index.html` 373 行；主进程侧 2993 行                  |
| 运行时依赖 | **0**（无框架、无打包器、无第三方库）。构建期仅 Node 标准库 + Electron + rcedit                                 |
| 语言/风格 | vanilla JS + IIFE 挂 `window` + `'use strict'`；中文注释、英文标识符；**注释写"为什么"不写"做什么"**      |
| 数据存储  | localStorage（设置/收藏/旋转）+ IndexedDB（图片尺寸/缩略图落盘）+ 主进程 JSON（删除日志）；**统一落在应用本体目录的 `data/`**（便携，见 §3.1） |
| 加载入口  | **2 个**：原生目录选择框（`Ctrl+O`）、拖拽（唯一"条目没有磁盘路径"的通路）                                     |
| 回归防线  | **38 套件 / 449 项断言**（`run_all.js`，约 335 秒，视机器负载）；含产物自检、校验器的反向门禁、**源级不变量** |
| 当前状态  | 功能完成度高、无障碍四层补齐、相框已转正、四种浏览排布；**没有模块还停在 ★★☆☆☆**                                     |

**一句话**：这是一个"工程纪律极好、防御性断言很密"的小工具项目。它的**风险不在代码质量，而在"改动的接线是否完整"** —— 历史上栽过 6 次的都是同一类病：**功能写好了，但没接到调用链上**（见 §6.1）。

---

## 1. 三条命令（先跑通，再动手）

> ⚠️ **本机 bash 没有 coreutils（`wc`/`tail`/`dirname` 常缺），`npm` 也常不在 PATH** —— **优先直接 `node <script>`**，别依赖 `npm`/`npx`。

| 目的         | 命令                                                    | 说明                                                            |
| ---------- | ----------------------------------------------------- | ------------------------------------------------------------- |
| 跑全量回归      | `node deploy/electron-test/run_all.js`                | 38 套件 / 449 项 / 约 335 秒。任一失败**非零码退出**。可后台跑               |
| 快跑（改小东西时）  | `node deploy/electron-test/run_all.js --fast`         | 13 套件 / 61 项 / 约 8.4 秒。**跳过大部分 Electron 探针，但仍含 `tf`（要 electron）** |
| 只跑一个套件     | `node deploy/electron-test/run_all.js masonry`        | 套件 id 见 §5.2                                                  |
| 纯函数单测（毫秒级） | `node test/transform.test.js` 等                       | `transform` / `imageheader` / `frame` / `a11y` / `masonry` / `desktop` / `updatelib` 七个 |
| 构建         | `node deploy/electron/assemble.js`                    | 组装 Electron 便携包（**唯一交付物**）                                     |
| 打包 ZIP     | `node deploy/pack.js`                                 | 自带强制校验：写 tmp → 全量核验 → 通过才改名                                   |
| 独立复验 ZIP   | `node deploy/verify_zip.js`                           | 参照值取自 Node 原生 `zlib.crc32`（与被测写入器**不同源**）                     |
| 新克隆可构建性    | `node deploy/verify_clone.js`（加 `--full` 走端到端）        | 静态查"源码有没有被 `.gitignore` 顺手忽略"；`--full` 真克隆+构建+比 exe MD5      |
| 清回归垃圾      | `node deploy/clean.js`（或 `--dry` 预演）                  | 清 `logs/` + `shots/`；**跑完回归必做**，否则无上限膨胀                       |
| 自检挂住时诊断    | `node deploy/electron-test/manual_appself.js [秒]`     | 带 trace 跑打包后的 exe 自检                                          |

**`npm` 脚本别名**（`package.json` 里都有）：`test` / `test:fast` / `build` / `pack` / `verify:zip` / `verify:clone` / `release` / `clean` / `clean:dry`。

> `--fast` **不能脱离 Electron**：它保留的 `tf` 是真实 Electron 探针（贡献 61 项里的 29 项）。
> 新克隆里没 `npm i` 时它会报"找不到 electron.exe"（13 套件里 12 通过）。

---

## 2. 架构：五层 + 单一交付目标

```
┌──────────────────────────────────────────────────────────────┐
│ 表现层   index.html(373) · main.css · lightbox.css · frame.css │
│          · SVG 图标精灵内联                                     │
│          · CSS 自定义属性做主题（JS 只切 body 的 dataset/class）  │
├──────────────────────────────────────────────────────────────┤
│ 交互层   app.js 总装 · settings.js 设置面板 · grid.js 网格与虚拟化 │
│          lightbox.js 大图 · frame.js 相框 · trash.js 回收站视图    │
├──────────────────────────────────────────────────────────────┤
│ 状态层   state.js 全局状态 · 事件总线 · viewList 记忆化            │
├──────────────────────────────────────────────────────────────┤
│ 数据层   loader.js 索引 · thumb.js 缩略图管线 · exif.js 元数据     │
│          util.js 工具 · transform.js 几何变换 · a11y.js 无障碍共用件 │
│          masonry.js 瀑布流排布                                   │
├──────────────────────────────────────────────────────────────┤
│ 平台桥   native.js 适配器                                       │
│          ↕ contextBridge（34 条 render→main 通道）               │
│          preload.js · main.js · desktop.js · desktop-spec.js    │
└──────────────────────────────────────────────────────────────┘
        ↓ 单一交付目标
   assemble.js → Electron 便携包（robocopy 镜像 + 本地引用存在性校验
                  + 图标随包 + rcedit 写 exe 资源段 + BUILD-INFO.json）
```

### 2.1 模块职责一句话

| 模块             | 职责                                                       | 备注                          |
| -------------- | -------------------------------------------------------- | --------------------------- |
| `util.js`      | `$`/`$$` 选择器、自然序比较、`clamp`、`sizeFromHeader`、`dragSelect` | 无依赖底座                       |
| `a11y.js`      | 播报区 `live()` + 焦点陷阱 `trap()`                             | **四个容器共用一份**（弹层/设置/灯箱/相框浮层） |
| `native.js`    | 平台桥适配器（含 `canUpdate` 能力探测 / `checkUpdate` / `openExternal`） | 见下方"失败留痕策略"                 |
| `state.js`     | 全局状态、事件总线、`viewList()` 记忆化、收藏/旋转落盘                       | `MODES`/`MODE_ORDER` 定义在这   |
| `loader.js`    | **两个**入口的索引（原生目录 / 拖拽）、去重、分批提交、删除                        | 尺寸从**文件头**读                 |
| `exif.js`      | 自研 EXIF 解析（拍摄时间/机型/光圈/快门/ISO/焦距）                         | 原生走 IPC 只读前 256 KB          |
| `transform.js` | `computeTransform` 等**纯函数**几何（缩放/旋转/平移）                  | 可 Node 单测                   |
| `thumb.js`     | `createImageBitmap` 解码 → canvas 降采样 → blob；落盘缓存          | 双层 LRU                      |
| `masonry.js`   | 瀑布流**纯函数**排布（列分配/最短列优先/`yMax` 前缀）                        | 零 DOM，87 条断言                |
| `grid.js`      | 网格渲染、虚拟化窗口化、框选、拖拽选择                                      | 四种排布都在这                     |
| `trash.js`     | 回收站全屏视图                                                  |                             |
| `lightbox.js`  | 大图查看、缩放/旋转/拖动、幻灯片、缩略条、EXIF 面板                            | 完整对话框语义                     |
| `settings.js`  | 设置面板（**7 组** / **28 行**，其中 5 行是按钮）；`actions` 查表分发；`ALL_KEYS`（**27 键**）重放表 | 状态相关分组                      |
| `frame.js`     | 相框模式（无边框独立窗 + 按图变形 + 随机轮播）                               | 桌面独立窗口 + 页内浮层兜底            |
| `app.js`       | 总装：视图切换、来源条、分页、工具栏、键盘、`applySetting` 单一漏斗                | **设置生效的唯一出口**               |

**`native.js` 的失败留痕策略**（改它之前先读文件头那段注释）：绝大多数 `catch` 都吞成 `false/null/[]`（调用方接受"空"，是刻意的），但**写操作**必须把原因带到用户面前（`{ok:false, reason}`），**状态对齐类**（`setAlwaysOnTop` / `getAlwaysOnTop` / `setTray` / `setHotkey` / `frameInfo` / `openExternal`）必须用 `warnOnce` 留一次痕 —— 否则"IPC 挂了"与"用户点了取消"完全同形，症状是"开关自己弹回去了"。`checkUpdate` 也归"写操作"那一类：它返回 `{ok:false, reason}`，因为**"检查失败"与"没有新版本"对用户是两句话**，合并成 `false` 就等于把"没连上网"说成"已是最新"。

### 2.2 单向数据流（记住这一条，就不会乱）

```
State.settings ──► App.applySetting(key, val)  ← 唯一漏斗
                        │
                        └──► 只切 body 的 dataset / class（表现全交给 CSS）
```

**所有设置项的"实际生效"都收敛在 `App.applySetting()` 的 `switch` 里**，方便排查与"恢复默认"全量重放。`State.setSetting(k,v)` 只写值 + 落盘，**不会让界面变**。

---

## 3. 数据存储（改"记忆"类功能前必看）

| 存哪           | 键 / 表                    | 内容                               | 上限                    |
| ------------ | ------------------------ | -------------------------------- | --------------------- |
| localStorage | `viewfinder.settings.v1` | 全部设置                             | —                     |
| localStorage | `viewfinder.favs.v1`     | 收藏 id 集合                         | —                     |
| localStorage | `viewfinder.rot.v1`      | 旋转记录（按文件路径，400ms 合并写 + 关窗 flush） | 4000（Map 插入序 LRU）     |
| IndexedDB    | `viewfinder-db`          | 图片**真实尺寸**、缩略图 blob               | 缩略图 4000（`at` 索引 LRU） |
| 主进程 JSON     | 删除日志                     | 跨启动保留的"最近删除"                     | —                     |

> **口径陷阱**：尺寸库只写**原图真实尺寸**，唯一来源是文件头 `Util.sizeFromHeader`；写错会**悄悄**排错屏。缩略图落盘键用**条目 id**（只留最大档）。

### 3.1 这些东西物理上放在哪（v1.14.0 便携化）

上面三种存储**全部落在 Electron 的 `userData` 目录里** —— 注意不只是我们自己写的 JSON：
Chromium 把渲染层的 `localStorage` 与 `IndexedDB` 也放在那儿。所以**换数据目录 = 换这三样**。

```
VF_USERDATA 环境变量存在          → 用它（**优先级最高**：探针与 --selftest 靠它隔离数据）
否则 打包运行 → <exe 所在目录>/data
     开发运行 → <项目根>/data
建不出目录（例如装在 C:\Program Files\） → 回落到系统默认 %APPDATA%\Atrium，并留一条 warn
```

`main.js` 顶部在 **app ready 之前**调 `app.setPath('userData', ...)`（必须这么早，晚了 Chromium 已经定好路径）。
`data/` 在 `.gitignore` 里；`frozen` 套件有两条源级断言锁住"VF_USERDATA 优先级"与"`<base>/data` 分支"——
删掉前者会让全量回归开始往**真实用户数据**里写，而且没有任何症状。

> **不做旧数据迁移**：`%APPDATA%\Atrium` 里的旧设置**不会**被搬过来（用户明确选择"从空开始"）。
> 想搬的话把整个 `%APPDATA%\Atrium` 的内容拷进 `data/` 即可，结构完全一样。


> 🔒 **这些键名一个字都不能改。** 理由与完整清单见 **§7.5 冻结点**。
> 回归里有一条源级断言（`frozen` 套件）直接锁住它们 —— 改错会当场变红。

---

## 4. 单一交付目标与构建管线

**只有一种产物**：

| 产物           | 构建脚本                                     | 特点                                                   |
| ------------ | ---------------------------------------- | ---------------------------------------------------- |
| Electron 便携包 | `deploy/electron/assemble.js` → `deploy/dist-electron/Atrium_Electron版/` | robocopy 镜像运行时；双击 **`Atrium.cmd`**（不是 exe）；rcedit 写 exe 资源段；同时落一份 `BUILD-INFO.json` 构建戳 |

> **离线单文件 HTML 版已在 v1.13.0 退役**，`deploy/build_offline.js` 已删除。
> 老文档/老记忆里若还提"双目标交付""离线版 ZIP"，那是过期内容。
> `deploy/` 下现在只有：`assemble.js` / `pack.js` / `verify_zip.js` / `verify_clone.js` / `make_icons.js` / `verify_icon.js` / `clean.js`。

**Electron 安全基线**（已达标，别破坏）：`contextIsolation:true` / `nodeIntegration:false` / `sandbox:true`，preload 只暴露白名单，自定义 `vf://` 特权协议替代 `file://`，`setWindowOpenHandler` 拒绝新窗口，`will-navigate` 拦截外部导航，**桌面集成 7 条 IPC 有 sender 归属校验**（纵深防御）。

**IPC 口径（实测）**：

```
render → main : 36 条  （35 条 invoke + 1 条单向 send：vf:setLastDir）
main → render :  3 条  （vf:frameClosed / vf:frameMoved / vf:cmd）
唯一通道名合计: 39 个
```

> 数字来源：`preload.js` 的 `ipcRenderer.invoke|send` 与 `main.js`/`desktop.js` 的 `ipcMain.handle|on`。
> 回归里有 `ipcchain` 套件做**源级**双向核对（preload 暴露的每条通道都要有 handler；
> `desktop.js` 的每条通道都要有探针桩），所以这个数字不会悄悄漂。

---

## 5. 回归体系：什么时候跑什么

### 5.1 三层测试

| 层               | 位置                                        | 反馈速度 | 覆盖                                                                    |
| -------------- | ----------------------------------------- | ---- | --------------------------------------------------------------------- |
| **纯函数单测**       | `test/*.test.js`（Node，`vm` 沙箱）            | 毫秒级  | `transform` 36 · `header` 26 · `frame` 505 · `a11y` 77 · `masonry` 87 · `desktop` 76 · `updatelib` 65 |
| **源级不变量**       | `run_all.js` 里的 `frozen` / `ipcchain`      | 毫秒级  | 冻结标识未被改名 / 数据目录两条分支 / IPC 链路无缺口                                       |
| **Electron 探针** | `deploy/electron-test/probes/probe_*.js`（**25 个**被套件调用，另有 3 个一次性审计工具：`probe_uiaudit` / `probe_audit2` / `probe_uifix`） | 秒级/个 | 真实渲染、几何、交互、无障碍、相框、拖拽、设置面板 |
| **产物自检**        | `appself` / `icon` / `zip` 套件             | 慢    | 跑**装进包里的产物**，不是源码                                                      |

> **断言数字的口径**：`run_all.js` 汇总的是**套件级条目数**（**449**），不等于单个 `assert` 总数
> （纯函数套件内部展开更多细分断言，合计 **872**，聚合器各按 1 项计入）。**别自己相加。**
> 另：`zip` 套件有 **2 条条件断言**只在**交付 ZIP 就位**时才跑 —— 源码态（没打包）会少这 2 项。

### 5.2 38 个套件 id

```
a11y  a11yui  approt  appself  center  desktop  desktopui  drop  frame  frozen  fs  grid
header  heic  icon  iconography  ipcchain  lbui  masonry  masonryunit  nowrap  perf  pinch
rot  rotpersist  rounding  settings  sidebar  single  tf  topbar  toplayout  typescale
unit  update  uxaudit  zip  zoom
```

> **id 不能重复**：纯函数套件 `masonry` 曾与探针套件撞名，已改名 `masonryunit`。
> 实取：`grep -oE "id: '[a-zA-Z0-9_]+'" deploy/electron-test/run_all.js | sort -u | wc -l`

### 5.3 总数会在几个值之间跳（正常）

两个已知来源，都不是"静默跳过"：

1. **`zip` 套件**按"Electron 大包在不在"跑不同条数。版本号刚升、`pack.js` 还没跑时大包不存在 → 少 2 条。
2. **`appself` 套件**一旦 `自检整体通过` 判负就**提前 `return`**，后面 **31 条**相框断言一条都不执行。
   最典型的触发条件是**沙箱不支持 `alwaysOnTop`**（`setAlwaysOnTop` 静默无效 → 包内自检 `pinSet:false` → `code=1`）。
   所以同一个 commit 在两台机器上会报 **449** 与 **480** 两个数，**两个都"对"**。

> ⚠️ **方向相反要警惕**：断言数**无理由**变少 = 有 `if (sX)` 块被跳过（见 §6.2）。查账方法：看**哪一步没有输出**。
> 本条是血泪教训：v1.19.0 收尾时发现总数从 470 掉到 449，先怀疑是自己改坏了 CSS，
> 实际是 `appself` 提前返回（−31，健康时 35 项、中断时 4 项）叠加新增的 `uxaudit`（+7）与 `toplayout`（+1）。
> **`断言合计` 是运行期计数，不是写进文档的固定指标** —— 引用前先看清这一跑是哪一种。

### 5.4 几条"一条小断言换永久免疫"的门禁

| 套件        | 锁什么                                                                    | 为什么值得 |
| --------- | ---------------------------------------------------------------------- | ----- |
| `frozen`  | `vf://app` · 3 个 `viewfinder.*` LS 键 · `viewfinder-db` · `com.atrium.app` · `productName` · 根 `package.json` 的 `name` · **数据目录的两条分支**（`VF_USERDATA` 优先级 / `<base>/data`） | 改错任何一个 = **用户数据一次性清空**（见 §7.5）；删掉 `VF_USERDATA` 分支则全量回归会开始往**真实数据**里写 |
| `ipcchain`| preload 暴露的每条通道都有 handler；`desktop.js` 的每条通道都有探针桩                        | 漏一条就是**静默降级**（`invoke` reject 被 `.catch` 吞掉） |
| `drop`    | 拖拽通路的 13 项结果断言（索引 / 缩略图 / 灯箱 / 删除拒绝 / 多文件夹分组）                            | 这条通路**此前零覆盖**，而它与主通路的每一条下游路径都不同 |
| `update`  | `openExternal` 的 URL 白名单（**21 条反向用例**）+ 版本号比较 + 接口响应解析（v1.14.0）            | 白名单放宽 = `shell.openExternal` 变成"打开任意 URL / 执行本地文件"，且**无任何界面迹象** |
| `typescale` | 三份 CSS 里**没有写死的 `font-size`**；`--fs-*` 无未定义 / 无孤儿 / **无半像素档**（v1.18.0） | 半像素字号（12.5px）单看没问题，只在两段文字并排时露馅 —— 是**最难靠肉眼回归**的一类；就地微调一次就再也收不回来 |
| `iconography` | 每处 `<use>` 都指向存在的 symbol；网格全 `0 0 24 24`；描边只有 2 与 1.6；渲染尺寸只在四档令牌；symbol 恒为 36（v1.18.0） | 图标会"慢慢走形"：加一个按钮顺手画一个 path，四十个之后单看都像样、并排就毛。加图标必须改 `deploy/gen_sprite.js` 的 `MAP` |
| `nowrap`  | 880 / 1000 / 1200 / 1500 四档宽度下，顶栏·状态栏·选择条·回收站·灯箱里**没有文字被折行**（v1.18.0） | 这类塌陷**只在某个宽度出现**，开发者的窗口里永远复现不出来；实测抓到过「已选 12 张」被折成 4 行 |
| `uxaudit` | 8 个场景下的**文字对比度 ≥4.5**（沿祖先链 alpha 合成真实背景，不用写死的底色）· **焦点环四边都画得出**（从 CSSOM 捞 `:focus-visible` 规则，不靠运行时聚焦）· **命中框 ≥24×24** · **无静默截断**（v1.19.0） | 这四个都是"**肉眼看不出、但键盘用户直接撞墙**"的类别。尤其焦点环：`.ctrls` 的 padding 少 1px 就裁掉 14 个控件的上下边，屏幕上像"按钮只有三面有框"，而鼠标用户永远看不到。**注入页面的正则必须 `String.raw`**，否则 `\s` 被吃成 `s`，探针会输出一堆"看起来正常"的错数字 |

---

## 6. 雷区清单（动代码前通读）

### 6.1 头号病：**功能写好了，但没接到调用链上**（栽过 6 次）

| 版本      | 症状                       | 根因                                                        |
| ------- | ------------------------ | --------------------------------------------------------- |
| v1.6.0  | 「清空缩略图缓存」按钮点了没反应         | `_row()` 分发漏了这个 key                                       |
| v1.8.0  | 相框设置键改了不触发 UI            | `applySetting()` 的 `switch` 没有对应 `case`                   |
| v1.8.1  | 相框入口"隐藏"重启后不生效           | `applyFrameUI()` **从未在 `init()` 里调用**                     |
| v1.10.0 | 删除弹层「取消」点了不消失（还吞掉灯箱 Esc） | `if (noBtn.isConnected)` 跑在 `appendChild` **之前**，恒为假      |
| v1.11.0 | 15 条断言从未执行过、套件却全绿        | 探针写错 `State.defaults()`（它是 getter）→ 抛错 → `if (s8)` 整块静默跳过 |
| v1.12.0 | 面板点「瀑布流」值变了、界面纹丝不动       | `applyModeUI()` 只挂在顶栏通路                                   |

**对策 —— 新增"设置驱动的界面变化"必须五处齐查 + 第六问：**

1. `state.js` 的 `defaults()` 登记键
2. `state.js` 的 `loadSettings()` 校验白名单（布尔键加进那个 `for...of` 数组）
3. `app.js` 的 `applySetting()` 加 `case`（否则落 `default: break`，**静默**）
4. `app.js` 的 `init()` 启动时重放一次（`applyXxxUI()`）
5. `settings.js` 的 **`ALL_KEYS`**（「恢复默认」重放表）
6. **【第六问】谁负责让它生效？那个函数挂在这条新通路上吗？**

> **五处缺一即静默失效**；第六问是"登记"之外的**调用链**检查。
> 第 5 处现在有**通用不变量**兜底：`settings` 套件里有一条断言
> "**面板里的每一行都必须 ∈ `ALL_KEYS`**"，输入取自面板自己的行定义
> （探针把 `groups()` 在"条件行全展开"状态下取一遍），缺哪个直接报出来。
> 老写法是手工列 3 个键 —— 而它诞生的原因恰恰是 `frameDisplay` 漏登记；
> 用手工清单防"漏登记"，等于把同一个病换个位置。
>
> 并且**做一次反向实验**证明防线有效：把 `case 'mode'` 改名成 `modeDISABLED`，
> 重跑探针应挂 9/18 项（指纹 `topbar=medium seg=masonry`）。**只测"好样本通过"是不够的。**

### 6.2 断言三原则

1. **断言写在"结果"上，不是"实现"上**。测"弹层真的消失了吗"，不是"取消按钮绑上了吗"。已栽 5 次。
2. **`if (sX) {…}` 是假绿温床**：某步抛错 → `undefined` → 整块断言静默不跑、套件照样全绿。**每个守卫块配一条"这一步必须有输出"的存在性断言**。
3. **"这条风险路径真的被走到"也要断言**（覆盖率本身写成断言）。例：瀑布流额外断言"本布局确实出现 `y+h` 非单调"。

### 6.3 探针 / 自检的五条致命写法

1. **`State.setSetting(k,v)` 不会让界面生效** → 面板是两步：`setSetting` + `Settings.apply(k,v)`。探针要包一个两步帮助函数。
2. **`executeJavaScript(\`…\`)\` 模板串里不能出现反引号** → 一个反引号就截断字符串，报错行号还指向别处。**注释放模板串外。**
   > 这条在写 `probe_drop.js` 时**又踩了一次**：在模板串内的注释里给路径加了反引号，
   > 结果是"App threw an error during load … SyntaxError: missing ) after argument list"，
   > 而行号指向模板串**之后**的那一行 —— 症状与原因完全对不上。
3. **别在无关通路上调带副作用的函数** → `Settings.sync()` 看着像纯刷新，实际对 `frameSrc` 有**回落副作用**（选中项不在列表就写回 `'all'`）。**接线前先确认对方是不是纯函数。**
4. **别断言用户观察不到的中间态** → 面板是浮层，点顶栏时它本就不该开着。断言"**重开面板后选中项正确**"，而不是"关着的 DOM 被提前改好"。
5. **异步反馈要轮询等待，别固定 `sleep`** → 固定 sleep 会**同时**产出假失败（读早了）与假通过（还没清完但读数恰好对了）。

### 6.4 编辑纪律

- **绝不并行 `Edit` 同一文件**（第二次基于旧内容写回、抹掉第一次，且两次都报成功——已咬 3 次）。**串行改 + 立刻 grep；大改直接整篇 `Write`。**
- 隐藏顶栏按钮**只用 `hidden` 属性，绝不摘节点**（顶栏几何断言按 `children` 下标算）。
  唯一的例外是**窗口置顶按钮**（v1.15.0）：Windows 上它被 `App.relocatePin()` 在启动时
  移进窗口标题栏（`#capRight`），因为原生标题栏已换成 Window Controls Overlay、
  标题栏归渲染进程画。这条移动是**一次性、启动期、由平台事实决定**的
  （判据是 `navigator.windowControlsOverlay.visible` **为真** —— 注意**不是**"这个
  API 存不存在"：Electron 在**所有**窗口里都注入它，没有浮层的窗口只是
  `visible === false`、`getTitlebarAreaRect()` 全 0；按存在性判断会把没有浮层的
  窗口也当成有，页面被整体压下 34px 而界面什么都不缺，只有几何断言会发现），不是"按需增删"；
  相应地，`topbar` 套件不再断言它在 `.ctrls` 里的下标，而是断言
  「它落在哪个容器」+「右缘是否在原生按钮区之内」——**浮层挂 body 之后，坐标下标本就没有意义**。
- **改默认值 = 改语义**：`showFrame` 翻 `true` 时，四处"默认隐藏"断言必须**反向**（不是删掉）。
- **凡吞异常处，都要有另一条通路把失败说出来**。
- 根目录历史版本解压目录必须清掉（全仓 `grep` 会命中陈旧副本、真源码命中被淹没）。
- **`.cmd` / `.bat` 文件必须纯 ASCII + CRLF**。`cmd.exe` 按 OEM 码页读批处理，
  UTF-8 的中文注释会被解成乱码**并当成命令执行**（v1.13.0 改 `launcher.cmd` 时实测到）。
  `.gitattributes` 是 `* -text`，不会帮你转换，得自己保证。

### 6.5 "测量工具本身会说谎"（已发生 7 次）

| 谎言                            | 真相                                                                |
| ----------------------------- | ----------------------------------------------------------------- |
| `getBoundingClientRect` 对旋转元素 | 返回**轴对齐包围盒** → 误判"已居中"。改用 DOMMatrix 解算四角                          |
| CSS 过渡未跨过就测量                  | 读到**起始值**。断言前先中和过渡（`transition='none'` + `void offsetWidth`）      |
| 探针元素指纹不够细                     | 同 class 一排按钮被判成"没动"。指纹要加父节点下标 + `aria-label`                      |
| 报产物体积用字符数                     | `html.length` 是**字符数**，中文少报约 13%。必须 `Buffer.byteLength(s,'utf8')` |
| **对比度拿文字色比一个写死的背景**（v1.19.0） | 白字 chip 名压在 `--accent` 上，却去比 `--paper-2` → 报 `1.18:1`，**荒谬到不像真的**，而探针照常输出。必须沿祖先链逐层 alpha 合成到第一个不透明层；遇到 `background-image` 就**整条跳过**，别猜 |
| **注入页面的正则没用 `String.raw`**（v1.19.0） | 普通模板串会把 `\s` 吃成 `s`、`\(` 吃成 `(` → `/rgba?\(([^)]+)\)/` 退化成 `/rgba?(([^)]+))/`，颜色解析全错**而探针不报错**。自检方法：普通模板串里写 `"\s"` 打出来是 `"s"`，`String.raw` 才是 `"\s"` |
| **隐藏窗口里读样式**（v1.19.0） | `show:false` 的 `BrowserWindow` 会节流样式重算：切主题后 450ms 读到的仍是**上一套主题的值**（深色下读到 `#55555b`）。而且 `settle()` 若不加前置等待，会在重算还没启动时连续两次读到同一批旧值，**"稳定"在错误状态上**——比不等待更危险。解法：`data-anim="0"` 关过渡 + **先强制等 900ms 再轮询** + 输出 `diag.anim/ink2/paper` 自证"主题真的切了" |

> 另外两条**读不到**而非读错的坑（v1.19.0）：
> `:focus-visible` 在未聚焦时 `outlineStyle === 'none'`，直接读会得到 `clip: 0` 的**假绿**；
> 程序化 `.focus()` 不匹配它，`sendInputEvent` 在隐藏窗口上直接挂死（SIGTERM）。
> 可行解是**从 CSSOM 捞出所有含 `:focus-visible` 的规则，去掉伪类后做 `el.matches()` 结构匹配**。

---

## 7. 常见开发任务的标准动作

### 7.1 新增一个 JS 模块

**三处同步**（缺一即构建失败或死链）：

1. `index.html` 加 `<script src="js/x.js">`，**位置必须在使用者之前**（如 `masonry.js` 在 `grid.js` 前）
2. `deploy/electron/assemble.js` 的 `MAIN_FILES`（**只针对主进程侧**平铺到 `resources/app` 根的文件）
3. 跑一次构建 —— `assemble.js` 会校验 `index.html` 引用的本地文件是否都存在，死链会被拦下

> `js/` 与 `css/` 目录**不需要加清单**：`assemble.js` 是 `fs.readdirSync` **扫目录全量复制**，
> 结构上不会漏。起因是 v1.9.0 的白名单漏了 `css/frame.css`，产物留了一条**死链**，
> 相框浮层无样式运行且已随 ZIP 发出去 —— 而所有断言都是绿的。

### 7.2 新增一个设置项

走 §6.1 的**五处 + 第六问**。若是 `type:'button'` 行，还要在 `Settings.actions` 加一条实现（否则按钮静默失效，回归有断言锁 `buttonKeys ⊆ actionKeys`）。

> 忘了第 5 处（`ALL_KEYS`）不用怕 —— `settings` 套件的通用不变量会当场报出是哪个键。

### 7.3 新增一个 IPC 通道

`preload.js` 白名单 + `native.js` 适配器 + `main.js` 的 `ipcMain.handle`（**主进程返回真实值**）。
若是桌面集成类，还要加进 `desktop.js` 的 `wireIpc()` 并用 `guard()` 包一层（归属校验），
以及 `probes/_desktop_stub.js` 的桩。

> `ipcchain` 套件会**源级**核对这三处是否对齐，漏一处直接变红。

> ⚠️ **"打开外部链接"这类通道必须自带白名单**。`shell.openExternal` 能开任意协议 ——
> 不校验就等于给渲染层（以及任何被注入的脚本）一个"打开任意 URL / 执行本地文件"的能力，
> 是**明确的安全倒退，而且没有任何界面迹象**。
> 本项目的判定在 `deploy/electron/updatelib.js` 的 `isAllowedExternal()`（只放行
> `https://github.com/jhlxlml/Atrium` 及其子路径），由 `update` 套件用 **21 条反向用例**
> 锁住（子域名伪装 / userinfo 伪装 / 非默认端口 / 路径穿越 / `file://` / `javascript:` …）。
> **只测"官方链接能过"等于恒真的门禁** —— 反向用例才是这道门的价值所在。
> 把白名单与"版本号比较"放进同一个**不依赖 Electron** 的纯函数模块，就是为了能毫秒级断言。

> ⚠️ **页面里的外链必须由脚本接管点击**。主窗口的 `will-navigate` 会 `preventDefault`
> 掉一切非 `vf://app` 的导航 —— 所以 `<a href="https://…">` 光写上去是**点了没反应**。
> 正确做法：保留 `<a href>`（可读、可复制、语义正确），在 `onMount` 里
> `preventDefault()` 后转交 `Native.openExternal()`。`App.modal()` 为此加了
> `onMount(bodyEl, close)` 钩子（在弹层**已插入文档树之后**回调，此时 `querySelector` 才有效）。

### 7.4 版本更新检测（v1.14.0）

分三层，**每一层都能单独测**：

| 层 | 位置 | 怎么测 |
|---|---|---|
| 纯逻辑 | `deploy/electron/updatelib.js`（版本比较 / 响应解析 / URL 白名单） | `update` 套件（Node，65 断言） |
| 主进程 | `main.js` 的 `vf:checkUpdate`（`net.fetch` + 8s 超时）与 `vf:openExternal` | `frozen` / `ipcchain` 源级断言 |
| 渲染层 | `Native.checkUpdate` / `Native.openExternal`；`App.runUpdateCheck` / `App._updateErrText`；`Settings.checkUpdateInline` | `settings` 探针（含"发现新版本"渲染与外链转发） |

三条纪律：

1. **"检查失败" ≠ "已是最新"**。接口返回 `{ok:false, reason}`（`timeout`/`network`/`http-<code>`/`bad-response`），
   界面必须分开说 —— 把"没连上网"说成"已是最新"是这类功能最常见的谎报。
2. **当前版本号由渲染层传入**（`App.VERSION` 是唯一来源），主进程不自己读 `package.json`。
   打包后 `app.getVersion()` 读的是包内 `package.json`，与界面显示的未必同源。
3. **启动时的自动检查静默**（`silent=true`）：没更新、或检查失败都一声不吭，
   只有真发现新版本才提示。每次开应用都弹一条"检查失败"是纯噪音。

### 7.5 改品牌 / 图标（`brand/`）

> ### 🔒 冻结点（禁止重命名）—— 改错一个 = 用户数据一次性清空
>
> v1.13.0 把产品改名 Atrium，但**刻意保留**了下面这些标识。它们**不是笔误**：
>
> | 标识 | 位置 | 改了的后果 |
> |---|---|---|
> | `vf://app` | `main.js` 特权协议 + `loadURL` | **源（origin）变了 → localStorage + IndexedDB 全部失效**：设置、收藏、旋转记录、尺寸缓存**一次性清空** |
> | `viewfinder.settings.v1` / `.favs.v1` / `.rot.v1` | `state.js` | 同上（设置 / 收藏 / 旋转全丢） |
> | `viewfinder-db` | `loader.js` | 缩略图与尺寸缓存全丢（可重建，但首屏退化） |
> | `com.atrium.app` | `main.js` `setAppUserModelId` | 任务栏固定、JumpList 关联错乱（可能出现重复图标） |
> | `productName: "Atrium"` | `deploy/electron/package.json` | 窗口标题 / 任务栏 / 开始菜单里的**产品身份**变了（v1.14.0 起 `userData` 已改为「应用本体目录/`data`」，**不再**由它决定；但打包后回落到 `%APPDATA%` 时仍用它） |
> | `name: "viewfinder"` | 根 `package.json` | 历史包名，`_nameFrozen` 字段里写了原因 |
> | `launcher.cmd` 的名字（包里叫 `Atrium.cmd`） | 手册明确"双击 `Atrium.cmd`，不是 exe" | 用户的快捷方式 / 说明全部失效 |
>
> **回归已锁**：`frozen` 套件逐条断言上面这些字符串还在。**看到它红，先想"我是不是改了不该改的东西"，别急着改断言。**

```
node deploy/make_icons.js     # SVG → 多尺寸 PNG → 手写 ICO 容器
node deploy/verify_icon.js    # 独立校验（不复用生成代码）+ 3 条反向用例
```

图标接线**四处**：`index.html` 内联 favicon（小尺寸加粗稿）+ `main.js` **两个** `BrowserWindow` 的 `icon` + `assemble.js` 复制 `icon.ico` 进包（`resources/app/icon.ico`）+ `settings.js` 关于面板署名。

> 另有**第五处**：exe **自身**的文件图标由 `assemble.js` 的 `stampExeResources()` 用 rcedit 写进 PE 资源段
> （RT_ICON / RT_GROUP_ICON）。它与 `BrowserWindow.icon` 是两条独立通路，互不替代。
> ⚠️ rcedit 的键名是 **`InternalName`** —— 写成 `InternalFilename` 会**静默保留** `electron.exe`。
> `appself` 有一条**字节级**断言（把 `icon.ico` 里 7 张内嵌 PNG 拿去 `exe.indexOf` 全中），
> 且做了反向实验（同一判据指向原始 `electron.exe` 命中 0/7）。

> 更名/改品牌 = **改结果**，写在结果上的断言必须同步（`aboutBrand` / 面板标题 / 设置行名 / 探针产物路径）。做法：一次性脚本 **dry-run 先行**，**每条规则必须至少命中一次**。

### 7.6 出一个新版本

**完整流程见 `deploy/release/RELEASE.md`**（随源码入库）。顺序本身是纪律：

```
改版本号(3 处) → 构建 → 校验产物 MD5 与源码一致 → 全量回归 → pack → verify:zip
→ 7z t（第三方复验）→ 更新说明 → 现状分析 → 记忆日志 → 交付 → clean
```

**验收标准**：`run_all.js` 末行 `通过 N，失败 0`；`verify_zip.js` 末行"全部 ZIP 校验通过"；`7z t` 的包 `Everything is Ok`。

> 回归跑完后若**又动了源码（哪怕一行文案）**，必须**重新构建并复跑受影响套件** —— `appself` 跑的是产物，不是源码。

---

## 8. 当前状态：成熟度与已知限制

### 8.1 成熟度（全部 ≥ ★★★★☆）

| 模块       | 完成度   | 说明                             |
| -------- | ----- | ------------------------------ |
| 加载/索引    | ★★★★★ | 两入口齐备，去重、缓存、进度事件完整             |
| 网格渲染     | ★★★★★ | 四种排布（小图/中图/瀑布流/单列），虚拟化 + 行内自适应 |
| Lightbox | ★★★★★ | 功能全 + 对话框语义 + 焦点陷阱             |
| 相框       | ★★★★★ | 无边框独立窗 + 按图变形 + 拖动/多屏/崩溃兜底     |
| 组织检索     | ★★★★☆ | 齐全；**搜索仅限文件名**（未做 EXIF 检索）     |
| 删除/找回    | ★★★★★ | 差异化亮点：三档能力 + Ctrl+Z + 回收站视图    |
| 设置       | ★★★★★ | **28 行**（含 5 个按钮行）全部真实生效，无"假开关"；重放表有通用不变量兜底 |
| 桌面集成     | ★★★★☆ | 菜单/右键/托盘/任务栏/JumpList/全局快捷键 + IPC 归属校验 |
| 打开性能     | ★★★★★ | 落盘缓存 → 二次打开零解码（约 5×）           |
| 无障碍      | ★★★★☆ | 四层补齐（播报/语义/焦点陷阱/键盘可达）          |
| 测试       | ★★★★★ | **29 套件 / 357 项**，含产物自检、校验器反向门禁、源级不变量 |
| 文档       | ★★★★☆ | 三份分工明确且数字实测；记忆日志在本机（不入库）        |

### 8.2 已知限制 / 技术债（都**刻意保留**）

| 项                          | 状态             | 说明                                              |
| -------------------------- | -------------- | ----------------------------------------------- |
| 全局命名空间（14 个挂 `window`）     | **刻意不改**       | "零依赖 + 单文件"是产品主张，换 ES Module 要引打包器，与之冲突         |
| `content-visibility: auto` | **评估后放弃**      | 有滚动锚定风险（跳版），与"首屏不跳版"目标冲突                        |
| `Atrium.exe` 文件图标          | ✅ 已解决（v1.13.0） | 已引 rcedit 写入 PE 资源段；`appself` 有字节级断言             |
| 构建产物未版本化                   | 低危（已缓解）        | 目录仍原地覆盖；已落 `BUILD-INFO.json`（版本 + 时刻 + exe MD5）供回溯。**刻意不按版本号建目录**（每次多 269MB，且要让 pack/回归/文档全改成"找最新目录"） |
| 图标资产仅 Windows              | 待办             | 出 macOS 包需另生成 `.icns`                           |
| `.workbuddy/` 不入库           | **刻意**         | 那是本机工具状态（记忆日志 / 发布 skill），不是项目内容。所以**发布流程已迁进 `deploy/release/RELEASE.md`** |

### 8.3 未做的功能（P2 候选，按需取舍）

EXIF 检索（按机型/日期区间/尺寸）· 视频支持 · 图片内编辑（裁剪/调色/批量重命名）· 设置导入导出 · i18n · 幻灯片播报节制 · 无障碍深化（多选键盘操作 / 图片 alt 策略 / 高对比度）· 触屏手势切图。

---

## 9. 建议的后续开发方向

按"用户真正会感知到"排序（当前判断：质量地基、功能广度、无障碍都不再是短板）：

| 优先 | 候选                           | 理由                   |
| -- | ---------------------------- | -------------------- |
| 高  | **相框深化**：吸附预览线 + 窗口几何记忆      | v1.11.0 留下的两项，用户直接感知 |
| 高  | **EXIF 检索**：按机型 / 拍摄日期区间筛选   | 重度整理用户效率提升           |
| 中  | **瀑布流自定义列数**（现在列数由列宽间接决定）    | 排布已"够用"，属锦上添花        |
| 中  | **幻灯片播报节制**（避免每换一张都打断读屏）     | 无障碍从"能用"到"好用"        |
| 低  | 视频支持 / 图片内编辑 / i18n / 设置导入导出 | 拓边界                  |

> 节奏建议：从"补短板"转为"**按用户反馈深化**"。每一步的安全性都由 357 项断言兜住。

---

## 10. 本机环境坑速查（长得都像"脚本坏了"）

| 坑                                                   | 判据                                                               | 处理                                                                 |
| --------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| `spawnSync` 默认给 stdin 建管道 → **EBUSY**               | 连 `cmd.exe`/`git`/`node` 都起不来，但异步 `spawn` 与 bash 直接执行正常          | 各脚本顶部包一层，默认 `stdio:['ignore','pipe','pipe']`                        |
| **想给子进程喂 stdin（`input`）也一样不行**                      | `stdio[0]='ignore'` 时 input 被**静默丢弃**；改成 `'pipe'` 直接起不来（EBUSY）  | 换一条路：把参数写进 argv（如 `git check-ignore <path...>`），别用 `--stdin`   |
| `fs.rmSync`/`unlinkSync`/`rm` 被垫片劫持到回收站，而 D 盘回收站不可用 | 报 `[safe-delete] SAFE_DELETE_FAIL_CLOSED`                        | 用 **`fs.rmdirSync(p,{recursive:true})`**（没被劫持）；`fs.renameSync` 可兜底 |
| `git` 输出的中文路径被转义成 `"…\345\233\276…"`              | 所有按路径做的字符串比对全部落空                                                 | 一律加 `-c core.quotepath=false`                                      |
| 探针"跑得起来但没输出"                                        | 失败集合 = "会写 `shots/` 的探针"                                         | **先 `cat logs/trace-<probe>.log` 的 `ERR` 行，别猜环境**                  |
| 探针中途崩溃 → 设置污染留给下一个探针                                | `mode` 被留成非默认                                                    | 跑一次 `run_all.js masonry` 用它自己的还原路径写回默认，**别手工改 leveldb**            |
| 探针缺 IPC handler → 假报错                                | 日志里出现 `[native] setAlwaysOnTop 失败…No handler registered`         | 给探针补桩：`require('./_desktop_stub').stubWindowChannels()`            |
| **`capturePage` 抓不到系统绘制的那一层**                     | 核验原生标题栏 / 窗口圆角 / 系统按钮时，截图里那块是**黑的**（页面截图只有 web 层）  | 截**物理屏幕**（Pillow `ImageGrab`，本机隔离 venv 里已装）；**坐标必须乘 DPI 系数**：python 是 DPI-unaware，`GetWindowRect` 给逻辑坐标、`BitBlt` 给物理像素（本机 175% → ×1.75），直接拿去 crop 会截到屏幕另一块地方。另外后台进程调 `SetForegroundWindow` 会被系统忽略，窗口可能被压在别的窗口下面 |
| **`navigator.windowControlsOverlay` 在所有窗口都存在**       | 按"API 存不存在"判断有没有标题栏浮层 → 无浮层的窗口也被加 `has-wco`、页面整体压下 34px；**界面看不出缺什么**，只有几何类断言报"纵向下偏 34px"（居中 / 三路径套件成片红）  | 判据必须用 **`.visible`**：`navigator.windowControlsOverlay.visible === true` 才算真有浮层；无浮层时 `getTitlebarAreaRect()` 全 0。诊断法：开两个窗口分别打印 `{visible, rect}` 对比（PLAIN `visible:false` / WCO `visible:true`） |
| **CSS `transform` 的坐标原点是「元素包含块左上角」，不是视口原点** | 舞台被下压（标题栏 34px）后与视口原点不再重合 → 图片整幅偏移那 34px；`computeTransform` 按视口坐标写位移就错  | 把舞台左上角的视口坐标（`getBoundingClientRect().left/top`）作为 `originX/originY` 传进 `computeTransform`，写 `translate` 时减掉它；`originX/originY=0` 即老行为、逐像素不变 |
| XML 注释里连续两个减号 → 整个 SVG 被拒                           | canvas 报 `svg decode failed`；favicon **静默不显示**                   | 注释里别写 `--` 开头的 CSS 变量名                                             |
| Electron 33 拒绝顶层 `data:` URL 导航                     | `ERR_FAILED (-2)`                                                | 加 `no-sandbox`，**不要**调 `disableHardwareAcceleration()`             |
| `.cmd` 里的中文注释变成乱码命令                                 | `cmd //c xxx.cmd` 报 `'」—?' 不是内部或外部命令`                            | **`.cmd` 一律纯 ASCII + CRLF**                                         |
| 本机无 ImageMagick / PIL / cairosvg / sharp            | `which convert` 命中的是 **Windows 自带的 FAT→NTFS 工具**，不能当 ImageMagick | SVG→PNG 零依赖路径 = 项目自带 Electron                                      |
| **`rm -rf` 会顺着 junction 递归删掉目标**                    | 拿 junction 当"省空间的软链"用                                                        | 别用 junction；用 robocopy `/MIR` 或直接 `copy`                            |

---

## 附：目录速查

```
Atrium/
├─ index.html              入口（373 行）
├─ package.json            版本唯一来源 + npm 脚本（name 刻意保留 viewfinder）
├─ js/       15 模块       前端全部逻辑（9584 行）
├─ css/      3 文件        主题用 CSS 变量（1805 行）
├─ test/     7 文件        纯函数单测（Node，872 条细分断言）
├─ brand/                  图标矢量 + .ico + 命名候选页（cand-*.png 不入库）
├─ deploy/
│  ├─ pack.js              写 ZIP（自带强制校验）
│  ├─ verify_zip.js        独立 ZIP 校验器（含反向门禁）
│  ├─ verify_clone.js      新克隆可构建性（静态 / --full 端到端）
│  ├─ make_icons.js        SVG → PNG → ICO
│  ├─ verify_icon.js       独立 ICO 校验器（含反向用例）
│  ├─ clean.js             清 logs/ + shots/
│  ├─ release/RELEASE.md   发布流程（随源码入库）
│  ├─ electron/            main.js · preload.js · desktop.js · desktop-spec.js
│  │                       · exportlib.js · updatelib.js · assemble.js · launcher.cmd
│  ├─ electron-test/       run_all.js · run_probe.js · probes/(18 + 共享桩)
│  │                       · fixtures/ · icon_gate.js · zip_gate.js
│  └─ dist-electron/       构建产物（未版本化；含 BUILD-INFO.json）
├─ data/                   应用运行期数据（userData；**不入库**，见 §3.1）
├─ .workbuddy/             本机工具状态（**不入库**）：记忆日志 + 发布 skill
├─ Atrium_现状分析与迭代建议.md   现状与迭代史（改版必更新）
├─ Atrium_问题清单与修复优先级.md  最近一次全项目体检报告
└─ Atrium_vX.Y.Z_更新说明.md      每版更新说明
```

> **动手前先读两份**：本手册（§6 雷区 + §7.5 冻结点）+ `deploy/release/RELEASE.md`（出包时）。
> `.workbuddy/memory/MEMORY.md` 里另有几十条编号经验，但**它不入库**（新克隆里没有）——
> 其中有长期价值的都已经沉淀进本手册与现状分析。
