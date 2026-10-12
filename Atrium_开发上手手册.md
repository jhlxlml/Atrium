# Atrium · 开发上手手册

> **这份文档解决什么问题**：让你在**不读 9000 行源码**的前提下，安全地改这个项目。
>
> 与《Atrium_现状分析与迭代建议.md》分工不同：那份讲**过去做了什么、为什么这么做**（迭代史 + 成熟度评估）；这份讲**现在怎么动它、动之前必须知道什么**（上手路径 + 雷区清单 + 标准动作）。
>
> 生成日期：2026-10-12 ｜ 对应版本：**v1.13.0**（`App.VERSION`）

---

## 0. 一页速览

| 维度    | 事实                                                                                |
| ----- | --------------------------------------------------------------------------------- |
| 是什么   | **纯本地图片浏览器**。选文件夹 → 像翻作品集一样看图。全程不联网、不上传、不复制。                                      |
| 交付形态  | ① 离线单文件 HTML（约 474 KB，双击即用）② Electron 便携版（解压即用，双击 `Atrium.cmd`）                   |
| 源码规模  | JS **8858 行 / 15 模块**；CSS 1764 行 / 3 文件；`index.html` 375 行；主进程+preload+导出库 1780 行 |
| 运行时依赖 | **0**（无框架、无打包器、无第三方库）。构建期仅 Node 标准库 + Electron                                    |
| 语言/风格 | vanilla JS + IIFE 挂 `window` + `'use strict'`；中文注释、英文标识符；**注释写"为什么"不写"做什么"**      |
| 数据存储  | localStorage（设置/收藏/旋转）+ IndexedDB（目录句柄/图片尺寸/缩略图落盘）+ 主进程 JSON（删除日志）                |
| 回归防线  | **24 套件 / 341 项断言**（`npm test`，约 183 秒）；含产物自检与校验器的反向门禁                            |
| 当前状态  | 功能完成度高、无障碍四层补齐、相框已转正、四种浏览排布；**没有模块还停在 ★★☆☆☆**                                     |

**一句话**：这是一个"工程纪律极好、防御性断言很密"的小工具项目。它的**风险不在代码质量，而在"改动的接线是否完整"**——历史上栽过 6 次的都是同一类病：**功能写好了，但没接到调用链上**（见 §6.1）。

---

## 1. 三条命令（先跑通，再动手）

> ⚠️ **本机 bash 没有 coreutils（`wc`/`tail`/`dirname` 常缺），`npm` 也常不在 PATH** —— **优先直接 `node <script>`**，别依赖 `npm`/`npx`。

| 目的         | 命令                                                                  | 说明                                                            |
| ---------- | ------------------------------------------------------------------- | ------------------------------------------------------------- |
| 跑全量回归      | `node deploy/electron-test/run_all.js`                              | 24 套件 / 341 项 / 约 183 秒。任一失败**非零码退出**。可后台跑                    |
| 快跑（改小东西时）  | `node deploy/electron-test/run_all.js --fast`                       | 7 套件 / 41 项 / 约 7.4 秒                                         |
| 只跑一个套件     | `node deploy/electron-test/run_all.js masonry`                      | 套件 id 见 §5.2                                                  |
| 纯函数单测（毫秒级） | `node test/transform.test.js` 等                                     | `transform` / `imageheader` / `frame` / `a11y` / `masonry` 五个 |
| 构建（两个产物）   | `node deploy/build_offline.js` + `node deploy/electron/assemble.js` | 离线单文件 + Electron 便携包                                          |
| 打包 ZIP     | `node deploy/pack.js`                                               | 自带强制校验：写 tmp → 全量核验 → 通过才改名                                   |
| 独立复验 ZIP   | `node deploy/verify_zip.js`                                         | 参照值取自 Node 原生 `zlib.crc32`（与被测写入器**不同源**）                     |
| 清回归垃圾      | `node deploy/clean.js`（或 `--dry` 预演）                                | 清 `logs/` + `shots/`；**跑完回归必做**，否则无上限膨胀                       |
| 自检挂住时诊断    | `node deploy/electron-test/manual_appself.js [秒]`                   | 带 trace 跑打包后的 exe 自检                                          |

**`npm` 脚本别名**（`package.json` 里都有）：`test` / `test:fast` / `build` / `build:offline` / `build:electron` / `pack` / `verify:zip` / `release` / `clean` / `clean:dry`。

---

## 2. 架构：五层 + 双目标交付

```
┌──────────────────────────────────────────────────────────────┐
│ 表现层   index.html(375) · main.css(1230) · lightbox.css(287) │
│          · frame.css(247) · SVG 图标精灵内联(39 个)             │
│          · CSS 自定义属性做主题（JS 只切 body 的 dataset/class）  │
├──────────────────────────────────────────────────────────────┤
│ 交互层   app.js(1991) 总装 · settings.js(611) 设置面板          │
│          grid.js(856) 网格与虚拟化 · lightbox.js(853) 大图      │
│          frame.js(1040) 相框 · trash.js(335) 回收站视图          │
├──────────────────────────────────────────────────────────────┤
│ 状态层   state.js(497) 全局状态 · 事件总线 · viewList 记忆化      │
├──────────────────────────────────────────────────────────────┤
│ 数据层   loader.js(754) 索引 · thumb.js(377) 缩略图管线         │
│          exif.js(232) 元数据 · util.js(390) 工具                │
│          transform.js(164) 几何变换 · a11y.js(292) 无障碍共用件  │
│          masonry.js(148) 瀑布流排布                             │
├──────────────────────────────────────────────────────────────┤
│ 平台桥   native.js(318) 适配器 —— 浏览器下全部空操作             │
│          ↕ contextBridge（26 个 IPC）                           │
│          preload.js(103) · main.js(1615) · exportlib.js(62)     │
└──────────────────────────────────────────────────────────────┘
        ↓ 双目标交付（同一份前端源码，两套外壳）
   ① build_offline.js → 单文件 HTML（内联 JS/CSS + 白名单 + 守卫校验 + 残留引用反向校验）
   ② assemble.js      → Electron 便携包（robocopy 镜像 + 本地引用存在性校验 + 图标随包）
```

### 2.1 模块职责一句话

| 模块             | 职责                                                       | 备注                          |
| -------------- | -------------------------------------------------------- | --------------------------- |
| `util.js`      | `$`/`$$` 选择器、自然序比较、`clamp`、`sizeFromHeader`、`dragSelect` | 无依赖底座                       |
| `a11y.js`      | 播报区 `live()` + 焦点陷阱 `trap()`                             | **四个容器共用一份**（弹层/设置/灯箱/相框浮层） |
| `native.js`    | 平台桥适配器；浏览器下**全部空操作**                                     | 能力探测为假即优雅降级                 |
| `state.js`     | 全局状态、事件总线、`viewList()` 记忆化、收藏/旋转落盘                       | `MODES`/`MODE_ORDER` 定义在这   |
| `loader.js`    | 四入口索引（文件夹框/FSA/原生目录/拖拽）、去重、分批提交、删除                       | 尺寸从**文件头**读                 |
| `exif.js`      | 自研 EXIF 解析（拍摄时间/机型/光圈/快门/ISO/焦距）                         | 原生走 IPC 只读前 256 KB          |
| `transform.js` | `computeTransform` 等**纯函数**几何（缩放/旋转/平移）                  | 可 Node 单测                   |
| `thumb.js`     | `createImageBitmap` 解码 → canvas 降采样 → blob；落盘缓存          | 双层 LRU                      |
| `masonry.js`   | 瀑布流**纯函数**排布（列分配/最短列优先/`yMax` 前缀）                        | 零 DOM，87 条断言                |
| `grid.js`      | 网格渲染、虚拟化窗口化、框选、拖拽选择                                      | 四种排布都在这                     |
| `trash.js`     | 回收站全屏视图                                                  |                             |
| `lightbox.js`  | 大图查看、缩放/旋转/拖动、幻灯片、缩略条、EXIF 面板                            | 完整对话框语义                     |
| `settings.js`  | 设置面板（6 组 / 24 行）；`actions` 查表分发；`ALL_KEYS` 重放表           | 状态相关分组                      |
| `frame.js`     | 相框模式（无边框独立窗 + 按图变形 + 随机轮播）                               | 桌面 `?frame=1` 与离线页内浮层**共用** |
| `app.js`       | 总装：视图切换、来源条、分页、工具栏、键盘、`applySetting` 单一漏斗                | **设置生效的唯一出口**               |

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
| IndexedDB    | `viewfinder-db`          | 目录句柄、原图**真实尺寸**、缩略图 blob         | 缩略图 4000（`at` 索引 LRU） |
| 主进程 JSON     | 删除日志                     | 跨启动保留的"最近删除"                     | —                     |

> **口径陷阱**：尺寸库只写**原图真实尺寸**，唯一来源是文件头 `Util.sizeFromHeader`；写错会**悄悄**排错屏。缩略图落盘键用**条目 id**（只留最大档）。

---

## 4. 双目标交付与构建管线

**同一份前端源码，两套外壳**：

| 产物           | 构建脚本                                                                     | 特点                                                   |
| ------------ | ------------------------------------------------------------------------ | ---------------------------------------------------- |
| 离线单文件 HTML   | `deploy/build_offline.js` → `deploy/dist/Atrium_离线版/index.html`          | 内联 JS/CSS/SVG；`file://` 下 `vfNative` 不存在 → 窗口级能力自动降级 |
| Electron 便携包 | `deploy/electron/assemble.js` → `deploy/dist-electron/Atrium_Electron版/` | robocopy 镜像运行时；双击 **`Atrium.cmd`**（不是 exe）           |

**Electron 安全基线**（已达标，别破坏）：`contextIsolation:true` / `nodeIntegration:false` / `sandbox:true`，preload 只暴露白名单（26 个 IPC），自定义 `vf://` 特权协议替代 `file://`，`setWindowOpenHandler` 拒绝新窗口，`will-navigate` 拦截外部导航。

**26 个 IPC 通道**：`pickFolder / pickExportDir / exportFiles / loadDir / autoDir / deleteFile(s) / restoreFile(s) / trashPreview / trashLog / trashForget / trashClear / openRecycleBin / openPath / readHead / alwaysOnTop / getAlwaysOnTop / frameOpen / frameData / frameFit / framePainted / frameClose / frameInfo / listDisplays / frameMove`（另有单向 `vf:frameMoved` 主→渲染，不计入）。

---

## 5. 回归体系：什么时候跑什么

### 5.1 三层测试

| 层               | 位置                                        | 反馈速度 | 覆盖                                                                    |
| --------------- | ----------------------------------------- | ---- | --------------------------------------------------------------------- |
| **纯函数单测**       | `test/*.test.js`（Node，`vm` 沙箱）            | 毫秒级  | `transform` 36 · `header` 26 · `frame` 505 · `a11y` 77 · `masonry` 87 |
| **Electron 探针** | `deploy/electron-test/probes/*.js`（17 个）  | 秒级/个 | 真实渲染、几何、交互、无障碍、相框                                                     |
| **产物自检**        | `appself` / `offline` / `icon` / `zip` 套件 | 慢    | 跑**装进包里的产物**，不是源码                                                     |

> **断言数字的口径**：`run_all.js` 汇总的是**套件级条目数**（341），不等于单个 `assert` 总数（纯函数套件内部展开更多细分断言，合计 731，聚合器各按 1 项计入）。**别自己相加。**

### 5.2 24 个套件 id

```
a11y  a11yui  appself  center  fileboot  frame  fs  grid  header  heic  icon
masonry  masonryunit  offline  perf  pinch  rot  rotpersist  settings  tf
topbar  unit  zip  zoom
```

> **id 不能重复**：纯函数套件 `masonry` 曾与探针套件撞名，已改名 `masonryunit`。

### 5.3 总数会在 339 / 341 之间跳（正常）

`zip` 套件按"Electron 大包在不在"跑 7 或 9 条。版本号刚升、`pack.js` 还没跑时大包不存在 → 少 2 条。**这是条件断言，不是静默跳过。**

> ⚠️ **方向相反要警惕**：断言数**无理由**变少 = 有 `if (sX)` 块被跳过（见 §6.2）。查账方法：看**哪一步没有输出**。

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
> 并且**做一次反向实验**证明防线有效：把 `case 'mode'` 改名成 `modeDISABLED`，重跑探针应挂 9/18 项（指纹 `topbar=medium seg=masonry`）。**只测"好样本通过"是不够的。**

### 6.2 断言三原则

1. **断言写在"结果"上，不是"实现"上**。测"弹层真的消失了吗"，不是"取消按钮绑上了吗"。已栽 5 次。
2. **`if (sX) {…}` 是假绿温床**：某步抛错 → `undefined` → 整块断言静默不跑、套件照样全绿。**每个守卫块配一条"这一步必须有输出"的存在性断言**。
3. **"这条风险路径真的被走到"也要断言**（覆盖率本身写成断言）。例：瀑布流额外断言"本布局确实出现 `y+h` 非单调"。

### 6.3 探针 / 自检的五条致命写法

1. **`State.setSetting(k,v)` 不会让界面生效** → 面板是两步：`setSetting` + `Settings.apply(k,v)`。探针要包一个两步帮助函数。
2. **`executeJavaScript(\`…\`)\` 模板串里不能出现反引号** → 一个反引号就截断字符串，报错行号还指向别处。**注释放模板串外。**
3. **别在无关通路上调带副作用的函数** → `Settings.sync()` 看着像纯刷新，实际对 `frameSrc` 有**回落副作用**（选中项不在列表就写回 `'all'`）。**接线前先确认对方是不是纯函数。**
4. **别断言用户观察不到的中间态** → 面板是浮层，点顶栏时它本就不该开着。断言"**重开面板后选中项正确**"，而不是"关着的 DOM 被提前改好"。
5. **异步反馈要轮询等待，别固定 `sleep`** → 固定 sleep 会**同时**产出假失败（读早了）与假通过（还没清完但读数恰好对了）。

### 6.4 编辑纪律

- **绝不并行 `Edit` 同一文件**（第二次基于旧内容写回、抹掉第一次，且两次都报成功——已咬 3 次）。**串行改 + 立刻 grep；大改直接整篇 `Write`。**
- 隐藏顶栏按钮**只用 `hidden` 属性，绝不摘节点**（顶栏几何断言按 `children` 下标算）。
- **改默认值 = 改语义**：`showFrame` 翻 `true` 时，四处"默认隐藏"断言必须**反向**（不是删掉）。
- **凡吞异常处，都要有另一条通路把失败说出来**。
- 根目录历史版本解压目录必须清掉（全仓 `grep` 会命中陈旧副本、真源码命中被淹没）。

### 6.5 "测量工具本身会说谎"（已发生 4 次）

| 谎言                            | 真相                                                                |
| ----------------------------- | ----------------------------------------------------------------- |
| `getBoundingClientRect` 对旋转元素 | 返回**轴对齐包围盒** → 误判"已居中"。改用 DOMMatrix 解算四角                          |
| CSS 过渡未跨过就测量                  | 读到**起始值**。断言前先中和过渡（`transition='none'` + `void offsetWidth`）      |
| 探针元素指纹不够细                     | 同 class 一排按钮被判成"没动"。指纹要加父节点下标 + `aria-label`                      |
| 报产物体积用字符数                     | `html.length` 是**字符数**，中文少报约 13%。必须 `Buffer.byteLength(s,'utf8')` |

---

## 7. 常见开发任务的标准动作

### 7.1 新增一个 JS 模块

**四处同步**（缺一即构建失败或漏文件）：

1. `build_offline.js` 的 `FILES` 映射
2. 同文件的 `GUARDS` 条目（**guard token 每 token 恰 1 次**）
3. `index.html` 加 `<script src="js/x.js">`，**位置必须在使用者之前**（如 `masonry.js` 在 `grid.js` 前）
4. 确认 `index.html` 的引用顺序与 `FILES` 的枚举顺序一致（内联按 `FILES` **保序**）

> `assemble.js` **不需要加清单**——它 `readdirSync(ROOT/js)` 扫目录全量复制，结构上不会漏；它另校验 `index.html` 引用的本地文件是否都存在。

### 7.2 新增一个设置项

走 §6.1 的**五处 + 第六问**。若是 `type:'button'` 行，还要在 `Settings.actions` 加一条实现（否则按钮静默失效，回归有断言锁 `buttonKeys ⊆ actionKeys`）。

### 7.3 新增一个 IPC 通道

`preload.js` 白名单 + `native.js` 适配器 + `main.js` 的 `ipcMain.handle`（**主进程返回真实值**）。浏览器侧 `native.js` 对应方法要**空操作降级**。


### 7.4 改品牌 / 图标（`brand/`）

```
node deploy/make_icons.js     # SVG → 多尺寸 PNG → 手写 ICO 容器
node deploy/verify_icon.js    # 独立校验（不复用生成代码）+ 3 条反向用例
```

图标接线**四处**：`index.html` 内联 favicon（小尺寸加粗稿）+ `main.js` **两个** `BrowserWindow` 的 `icon` + `assemble.js` 复制 `icon.ico` 进包 + `settings.js` 关于面板署名。

> 更名/改品牌 = **改结果**，写在结果上的断言必须同步（`aboutBrand` / 面板标题 / 设置行名 / 探针产物路径）。做法：一次性脚本 **dry-run 先行**，**每条规则必须至少命中一次**。

### 7.5 出一个新版本

完整流程见 `.workbuddy/skills/viewfinder-release/SKILL.md`。**顺序本身是纪律**：  
改版本号(3 处) → 构建 → **校验产物 MD5 与源码一致** → 全量回归 → `pack` → `verify:zip` → `7z t`（第三方复验，两个包都要）→ 更新说明 → 现状分析 → 记忆日志 → 交付 → `clean`。

**验收标准**：`npm test` 末行 `通过 N，失败 0`；`verify:zip` 末行"全部 ZIP 校验通过"；`7z t` 两个包都 `Everything is Ok`。

> 回归跑完后若**又动了源码（哪怕一行文案）**，必须**重新构建并复跑受影响套件**——`appself`/`offline` 跑的是产物，不是源码。

---

## 8. 当前状态：成熟度与已知限制

### 8.1 成熟度（全部 ≥ ★★★★☆）

| 模块       | 完成度   | 说明                             |
| -------- | ----- | ------------------------------ |
| 加载/索引    | ★★★★★ | 四入口齐备，去重、缓存、进度事件完整             |
| 网格渲染     | ★★★★★ | 四种排布（小图/中图/瀑布流/单列），虚拟化 + 行内自适应 |
| Lightbox | ★★★★★ | 功能全 + 对话框语义 + 焦点陷阱             |
| 相框       | ★★★★★ | 无边框独立窗 + 按图变形 + 拖动/多屏/崩溃兜底     |
| 组织检索     | ★★★★☆ | 齐全；**搜索仅限文件名**（未做 EXIF 检索）     |
| 删除/找回    | ★★★★★ | 差异化亮点：三档能力 + Ctrl+Z + 回收站视图    |
| 设置       | ★★★★★ | 24 项全部真实生效，无"假开关"              |
| 打开性能     | ★★★★★ | 落盘缓存 → 二次打开零解码（约 5×）           |
| 无障碍      | ★★★★☆ | 四层补齐（播报/语义/焦点陷阱/键盘可达）          |
| 测试       | ★★★★★ | 24 套件 / 341 项，含产物与校验器自检        |

### 8.2 已知限制 / 技术债（都**刻意保留**）

| 项                          | 状态             | 说明                                              |
| -------------------------- | -------------- | ----------------------------------------------- |
| 全局命名空间（14 个挂 `window`）     | **刻意不改**       | "零依赖 + 单文件"是产品主张，换 ES Module 要引打包器，与之冲突         |
| `content-visibility: auto` | **评估后放弃**      | 有滚动锚定风险（跳版），与"首屏不跳版"目标冲突                        |
| 离线单文件未 minify              | 可选优化           | 474 KB，minify 预计省 30–40%                        |
| `Atrium.exe` 文件图标          | 仍是 Electron 默认 | 不重写 PE 资源段；要换需引 `rcedit`，与零依赖冲突。**窗口/任务栏图标已生效** |
| 构建产物未版本化                   | 低危             | `deploy/dist*/` 原地覆盖，无法直接对比两版差异                 |
| 图标资产仅 Windows              | 待办             | 出 macOS 包需另生成 `.icns`                           |

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

> 节奏建议：从"补短板"转为"**按用户反馈深化**"。每一步的安全性都由 341 项断言兜住。

---

## 10. 本机环境坑速查（长得都像"脚本坏了"）

| 坑                                                   | 判据                                                               | 处理                                                                 |
| --------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| `spawnSync` 默认给 stdin 建管道 → **EBUSY**               | 连 `cmd.exe`/`git`/`node` 都起不来，但异步 `spawn` 与 bash 直接执行正常          | 各脚本顶部包一层，默认 `stdio:['ignore','pipe','pipe']`（已改 5 个脚本）             |
| `fs.rmSync`/`unlinkSync`/`rm` 被垫片劫持到回收站，而 D 盘回收站不可用 | 报 `[safe-delete] SAFE_DELETE_FAIL_CLOSED`                        | 用 **`fs.rmdirSync(p,{recursive:true})`**（没被劫持）；`fs.renameSync` 可兜底 |
| 探针"跑得起来但没输出"                                        | 失败集合 = "会写 `shots/` 的探针"                                         | **先 `cat logs/trace-<probe>.log` 的 `ERR` 行，别猜环境**                  |
| 探针中途崩溃 → 设置污染留给下一个探针                                | `mode` 被留成非默认                                                    | 跑一次 `run_all.js masonry` 用它自己的还原路径写回默认，**别手工改 leveldb**            |
| XML 注释里连续两个减号 → 整个 SVG 被拒                           | canvas 报 `svg decode failed`；favicon **静默不显示**                   | 注释里别写 `--` 开头的 CSS 变量名                                             |
| Electron 33 拒绝顶层 `data:` URL 导航                     | `ERR_FAILED (-2)`                                                | 加 `no-sandbox`，**不要**调 `disableHardwareAcceleration()`             |
| 本机无 ImageMagick / PIL / cairosvg / sharp            | `which convert` 命中的是 **Windows 自带的 FAT→NTFS 工具**，不能当 ImageMagick | SVG→PNG 零依赖路径 = 项目自带 Electron                                      |

---

## 附：目录速查

```
Atrium/
├─ index.html              入口（375 行）
├─ package.json            版本唯一来源 + npm 脚本
├─ js/       15 模块       前端全部逻辑（8858 行）
├─ css/      3 文件        主题用 CSS 变量
├─ test/     5 文件        纯函数单测（Node）
├─ brand/                  图标矢量 + .ico + 命名候选页
├─ deploy/
│  ├─ build_offline.js     离线单文件打包（FILES + GUARDS + 残留引用反向校验）
│  ├─ pack.js              写 ZIP（自带强制校验）
│  ├─ verify_zip.js        独立 ZIP 校验器（含反向门禁）
│  ├─ make_icons.js        SVG → PNG → ICO
│  ├─ verify_icon.js       独立 ICO 校验器（含反向用例）
│  ├─ clean.js             清 logs/ + shots/
│  ├─ electron/            main.js(1615) · preload.js(103) · exportlib.js(62) · assemble.js · launcher.cmd
│  ├─ electron-test/       run_all.js(100KB) · run_probe.js · probes/(17) · fixtures/ · icon_gate.js · zip_gate.js
│  └─ dist*/               构建产物（未版本化）
├─ .workbuddy/
│  ├─ memory/              项目长期记忆（MEMORY.md + 日志）
│  └─ skills/viewfinder-release/SKILL.md   发布流程
├─ Atrium_现状分析与迭代建议.md   现状与迭代史（改版必更新）
└─ Atrium_vX.Y.Z_更新说明.md      每版更新说明
```

> **动手前先读两份**：本手册（§6 雷区）+ `.workbuddy/memory/MEMORY.md`（72 条编号经验，日志按号引用）。
