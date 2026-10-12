# Atrium · 项目体检报告

> 盘点日期：2026-10-12　｜　对象：`C:\Users\qwert\Documents\AI\Atrium`　｜　版本：v1.13.0
> 方法：**不照抄既有文档**，全部结论都回到源码/产物实测。凡与文档冲突处，均标注了证据行号。
> 与既有文档的关系：本文是**问题导向的行动清单**；`Atrium_现状分析与迭代建议.md` 是**纵深分析**；
> `Atrium_开发上手手册.md` 是**操作手册**。三者互补，但**手册在诊断时已整体过期**（见 🔴-3；已在收口轮整篇重写）。

> **后续版本（v1.14.0）**：本报告正文是 **v1.13.0 时点**的实测快照，**刻意保留原样**。
> v1.14.0 的新增内容（数据目录便携化 / 关于面板 GitHub 信息 / 版本更新检测）不在此报告范围内，
> 详见 [`Atrium_v1.14.0_更新说明.md`](Atrium_v1.14.0_更新说明.md)；
> 当前口径已更新为 **29 套件 / 357 项断言 / 0 失败**（`js/` 9584 行 / 15 模块，主进程侧 2993 行，探针 18 个 / 4332 行），
> 与手册、现状分析两份文档互查一致。

---

## ✅ 修复状态：15 / 15 已完成（同日收口）

> **本报告正文记录的是"修复前"的诊断结论与证据，刻意保留原样**（§1.2 的规模、§二的"❌ 没有 case"等，
> 都是当时的实测快照）。下面这张表是**修复后**的结果与验证方式。
> 收口后口径（与手册、现状分析三份互查一致）：**28 套件 / 346 项断言 / 0 失败**（`js/` 9361 行 / 15 模块，
> 主进程侧 2782 行，探针 17 个 / 4193 行）。

| 项 | 修复动作 | 验证方式（**都要求"先看到红"**） |
|---|---|---|
| 🔴-1 五处登记漏 3 键 + 防线本身弱 | `ALL_KEYS` 补 `frameSrc` / `frameMs` / `frameFit`；`settings` 套件断言换成**通用不变量**「面板每一行都必须 ∈ `ALL_KEYS`」，输入取自面板自己的行定义 | **先红后绿**：旧断言红时精准报出那 3 个键、面板 23 行；补键后转绿 |
| 🔴-2 拖拽入口零覆盖 | 新增 `probe_drop.js`（13 项结果断言）+ `drop` 套件注册；**顺带查出并修掉 2 个真缺陷**（见下） | 13 项全绿；第 4 / 第 8 条**曾先红**，各自定位到一个真 bug |
| 🔴-3 手册整体过期、三文档冲突 | 手册**整篇重写**为 v1.13.0，全部数字回源码实测 | 三份文档关键数字互查一致（套件/断言/IPC/入口数/设置数） |
| 🟡-1 `native.js` 26 处静默吞值 | 加 `warnOnce`（Set 去重）+ 文件头「失败留痕策略」长注释；5 个状态对齐调用接上 | 全量回归复跑全绿（**并暴露 7 个探针缺桩 → 已补 `stubWindowChannels()`**） |
| 🟡-2 `assemble.js` 注释与实现矛盾 | 改写 `66-70` 行为现状（rcedit 已引入、exe 图标已盖章） | 通读全文，无"rcedit 没引 / 图标是默认的"类表述 |
| 🟡-3 `.workbuddy` 悬空引用 | 发布流程迁进仓库：`deploy/release/RELEASE.md`；手册 §7.5 改指它 | 新克隆（无 `.workbuddy/`）里手册指引**可执行** |
| 🟡-4 `--fast` 措辞错 | 改 `run_all.js:6` 与注释 + 手册 + 现状分析 | 表述与实测（11 套件 / 51 项，**含需要 electron 的 `tf`**）一致 |
| 🟡-5 7 条桌面 IPC 无 sender 校验 | `desktop.js` 加 `trustedIds()` + `guard()` 包住 7 条；`desktopui` 加 3 条归属断言 | **反向实验**：去掉 `guard` → 7 条**全部放行**、3 条断言变红；装回 → 全拒且受信不误伤 |
| 🟡-6 冻结标识未文档化 | 手册 §7.4 加 🔒 **冻结点表**；新增 `frozen` 套件（6 条源级断言）锁 `vf://app` / 3 个 LS 键 / `viewfinder-db` / `com.atrium.app` / `productName` / 根 `package.json` 的 `name` | 反向实验：改坏 → 红，还原 → 绿 |
| 🟢-1 `launcher.cmd` 是 LF 行尾 | 重写为**纯 ASCII + CRLF**（24 CRLF / 0 LF-only）；优先按名找 `Atrium.exe`，找不到才退回"目录里第一个 exe" | 临时目录三分支实测（有 `Atrium.exe` / 只有其它 exe / 无 exe） |
| 🟢-2 两个零引用遗留物 | 删 `deploy/logs-verinfo.txt`、`fixtures/zip/negative-crc.zip`（后者 `git rm`） | 全仓零引用 |
| 🟢-3 测试文件头旧名 | `test/*.test.js` 5 处「取景 Viewfinder」→「Atrium」 | — |
| 🟢-4 构建产物未版本化 | 加 `BUILD-INFO.json`（版本 / 构建时刻 / exe MD5），**刻意不按版本号建目录**（理由见手册 §8.2） | — |
| 🟢-5 历史 ZIP 累积 | **待用户确认**：`Atrium_离线版_v1.13.0.zip` 属**已退役形态**的产物，建议删；但删除用户文件前先问 | — |
| 🟢-6 根 `package.json` 的 `name` 仍是 `viewfinder` | **不改**，加 `_nameFrozen` 字段说明这是刻意保留；`frozen` 套件锁住 | 断言在，改它会当场变红 |

**顺带修掉的两个真缺陷**（🔴-2 的副产品，都在 `js/loader.js`）：

1. **顶层目录名被重复拼接** —— 拖入一个文件夹时 `rel` 变成 `照片夹/照片夹/xxx.png`
   （`scanEntry` 已把目录名写进 `rel`，调用处又拼了一次 `en.name + '/'`）。
2. **散文件未按扩展名过滤** —— `en.isFile` 分支直接 `push`，拖入的 `.txt` 也会进索引。

**额外新增的两条门禁**（不在原 15 项内，属"顺手补漏"）：

- `ipcchain` 套件 —— **源级**核对 `preload` 暴露的每条通道都有 handler、`desktop.js` 的每条通道都有探针桩；
- `deploy/verify_clone.js` —— 新克隆可构建性门禁（默认静态清单检查；`--full` 端到端 clone→构建→比对 exe MD5）。

---

## 一、现状速览

### 1.1 一句话定位

一个**零运行时依赖、纯本地、不联网**的图片浏览器，交付形态是 **Electron 便携包**（解压双击 `Atrium.cmd`）。
工程成熟度在同类小工具里属**罕见的高**：五层架构单向依赖、25 套件 / 322 项一键回归、
产物与校验器**双向门禁**（验证器自己也有反向用例）、无障碍四层补齐。

### 1.2 规模（实测）

| 层 | 规模 |
|---|---|
| 渲染层 | `index.html` 373 行 + `js/` **9306 行 / 15 模块**（最大 `app.js` 2388）+ `css/` 1788 行 / 3 文件 |
| 主进程侧 | **2755 行**：`main.js` 1725 · `preload.js` 136 · `desktop.js` 428 · `desktop-spec.js` 404 · `exportlib.js` 62 |
| 构建脚本 | `deploy/` 5 个（`assemble` / `pack` / `verify_zip` / `verify_icon` / `make_icons` / `clean`） |
| 回归资产 | 25 套件 / 322 项（约 178 秒）＋ 6 个 Node 纯函数套件内 **807** 条细分断言 ＋ 17 个 Electron 探针（3843 行） |
| IPC | **33 条 invoke** ＋ 4 条单向（1 条 render→main、3 条 main→render）＝ 37 个唯一通道名 |
| 运行时依赖 | **0**（`electron` 与 `rcedit` 均为构建期） |

### 1.3 架构（五层，单向依赖）

```
表现层  index.html · main.css / lightbox.css / frame.css
   ↑
交互层  app.js（事件与命令分发）· settings.js · topbar · lightbox.js · frame.js
   ↑
状态层  state.js（唯一真相源 + 事件总线）· masonry.js / transform.js（纯函数）
   ↑
数据层  loader.js · thumb.js · exif.js · trash.js · util.js
   ↑
平台桥  native.js（渲染侧适配器）──IPC──▶ preload.js（白名单）──▶ main.js / desktop.js
```

**关键设计**（都做对了，别破坏）：
- `desktop-spec.js` 是**纯数据**（菜单模板 / 加速键 / 命令词表），**不许 `require('electron')`** → 可在 Node 里 76 条断言；
- **菜单项 id == 渲染层命令 id** → 探针能用 `getMenuItemById` 反查加速键；
- `applySetting(key, val, quiet)` 的第三参：**启动期状态对齐失败只回滚、不弹紧急播报**（用户没操作，弹错误是噪音）。

### 1.4 模块进展

| 模块 | 完成度 | 状态 |
|---|---|---|
| 加载 / 索引 | ★★★★★ | 原生目录 + 拖拽 + 上次目录自动打开；去重、尺寸缓存、分批提交 |
| 网格渲染 | ★★★★★ | 四种排布（小图/中图/瀑布流/单列）+ 行内自适应 + 虚拟化 |
| Lightbox | ★★★★★ | 缩放/拖动/旋转/全屏/幻灯片/缩略条/EXIF/收藏/删除 + 对话框语义 + 焦点陷阱 |
| 相框模式 | ★★★★★ | 无边框独立窗 + 按图变形 + 拖动/多屏/崩溃兜底 |
| 删除与找回 | ★★★★★ | 三档能力探测 + Ctrl+Z + 回收站视图（差异化亮点） |
| 设置面板 | ★★★★☆ | 23 行全部真实生效、无死开关；**但重放表有 3 键漏登记**（见 🔴-1） |
| 桌面集成 | ★★★★☆ | 原生菜单/右键/托盘/任务栏/JumpList/全局快捷键；**缺 sender 校验**（见 🟡-5） |
| 无障碍 | ★★★★☆ | 播报/语义/焦点陷阱/键盘可达四层齐；多选键盘操作、幻灯片播报节制未做 |
| 组织检索 | ★★★★☆ | 齐全；**搜索仅限文件名**（未做 EXIF/尺寸/大小检索） |
| 回归体系 | ★★★★★ | 25 套件 322 项；**但有盲区**（见 🔴-2） |
| 文档 | ★★☆☆☆ | **手册已整体过期**（见 🔴-3）；另两份基本准确 |

---

## 二、问题清单

### 🔴 高：会让人得出错误结论，或让防线静默失效

#### 🔴-1　「五处登记」漏了 3 个键，而防线本身拦不住这类漏登记　✅ 已修复

**证据（精确比对，非抽样）**：

| 处 | `frameSrc` / `frameMs` / `frameFit` |
|---|---|
| `defaults()`（`state.js:141-143`） | ✅ |
| `loadSettings()` 校验（`state.js:168-170`） | ✅ |
| `applySetting()` case（`app.js:184-298`） | ❌ **没有 case** |
| `Settings.ALL_KEYS`（`settings.js:660-666`） | ❌ **不在表里** |
| 设置面板行（`settings.js:158/168/172`） | ✅ |

面板真·设置行 **23** 个，`ALL_KEYS` **23** 个，差集恰好是这 3 个。

**当前后果：无用户可见缺陷。** `resetSettings()` 会把状态整体重置（`state.js:329-337` 做的是
`delete + Object.assign(settings, defaults())`），面板重建后显示的是默认值，而这 3 项是
**"打开相框时才读"** 的（`frame.js:212/222/223`），且主窗口在相框开着时是隐藏的 —— 没有"需要被通知的活界面"。

**真正的问题是防线强度**：`run_all.js:817-822` 那条断言**只锁了 3 个硬编码键**
（`showFrame` / `frameDock` / `frameDisplay`）：

```js
check('「恢复默认」重放表覆盖相框设置键（含 v1.11.0 新增的输出屏幕）',
  Array.isArray(s8.allKeys)
    && ['showFrame', 'frameDock', 'frameDisplay'].every(k => s8.allKeys.indexOf(k) >= 0), ...);
```

而它诞生的原因**正是** `frameDisplay` 漏登记（注释自陈："第一版就漏登记了"）。
**用一个手工清单去防"漏登记"，等于把同一个病换了个位置**——下一版再加一个相框设置，它照样发现不了。

**修复建议**：把断言换成**通用不变量**，让代码自己说话：

```js
// 面板里的每一行（非按钮）都必须同时满足：∈ ALL_KEYS 且有 applySetting case
const rowKeys = /* 从 Settings.ROWS 或探针导出，排除 '__' 前缀 */;
const notInKeys   = rowKeys.filter(k => s8.allKeys.indexOf(k) < 0);
const noCase      = rowKeys.filter(k => !s8.applyCases.includes(k));
check('面板每一行都登记进了「恢复默认」重放表', notInKeys.length === 0, JSON.stringify(notInKeys));
```
> 这条断言**现在跑会立刻红**（正好暴露这 3 个键）。补法二选一：
> **(a)** 把这 3 个键补进 `ALL_KEYS`（并确认 `apply()` 对无 case 的键是安全 no-op —— 现在就是）；
> **(b)** 若确认它们"只读、无需重放"，就在 `ALL_KEYS` 旁写一条**显式例外注释**，
> 并把断言改成"面板行 = ALL_KEYS ∪ 例外表"，让例外**可见**而不是**隐形**。
> 推荐 **(a)+(b)**：补进表 + 断言里加通用不变量 + 例外表为空。

#### 🔴-2　回归防线有盲区：**拖拽入口零覆盖**　✅ 已修复

`scanDataTransfer`（`loader.js:289/458`）、`dropZone`（`app.js:65/1324-1333`）在
**17 个探针 + 6 个单测里命中 0 次**：

```
$ grep -rn "DataTransfer|dropZone|scanDataTransfer|getAsFile" deploy/electron-test/ test/
（空）
```

而它是 §2.1 宣传的入口之一，且是**唯一一条"条目没有磁盘路径"的通路**
（`{file: File, rel}` 而非 `{path}`）——也就是说：
- 它的**索引路径、缩略图路径、EXIF 读取路径、删除/还原路径全都与主通路不同**；
- `appself` 自检走的是 `--open-dir`（原生路径），**永远测不到它**；
- 一旦坏掉，没有任何红灯。

**佐证这条通路确实"另一套"**：`native.js:33/97` 对 `!meta.path` 有专门分支，
`app.js:1103/1187/1578` 都在 `filter(r => r.path)`。**这么多分支，一条断言都没有。**

**修复建议**：新增探针 `probe_drop.js`，用 `webContents.executeJavaScript` 构造一个
`DataTransfer`（或直接调 `Loader.loadFromDrop(dt)`），断言落在**结果**上：

1. 拖入 1 个文件夹 → `State.sources.length` +1，条目数与夹具一致；
2. 拖入的图**缩略图真的画出来了**（`naturalWidth > 0`）；
3. 拖入的图**能打开灯箱**；
4. **无路径条目点删除 → 给出可读原因**（不是静默失败、不是崩）；
5. 一次拖入多个文件夹 → 分组为多个来源。

> 第 4 条尤其重要：它是"三档能力探测"这套设计的**边界**，而边界最容易漏。

#### 🔴-3　`Atrium_开发上手手册.md` 已整体过期，且与另两份文档冲突　✅ 已修复

手册在 **12:01 被换成了 v1.12.0 时代的旧版**（29974 字节；本轮我编辑过的版本是 30653 字节），
**本轮加入的内容全部消失**（§4 `index.html` 警示、§10 注入坑、IPC 口径修正）。

实测过期项：

| 位置 | 手册写的 | 实际 |
|---|---|---|
| §1 跑全量回归 | `24 套件 / 341 项 / 约 183 秒` | **25 套件 / 322 项 / 约 178 秒** |
| §1 快跑 | `7 套件 / 41 项` | **9 套件 / 43 项** |
| §1 构建 | `build_offline.js` + `assemble.js`（两个产物） | `build_offline.js` **已删除**，只剩 `assemble.js` |
| §2.1 图片加载 | "**四入口**，全部可用"（含 `webkitdirectory`、File System Access） | 只剩 **2 个**（原生目录 + 拖拽） |
| §8.1 设置 | "24 项全部真实生效" | 面板 **23** 行 |
| §5.1 console | "生产代码里仅 2 处" | **7 处**（`app.js` 4 / `native.js` 1 / `settings.js` 1 / `state.js` 1） |
| §7.5 / §附 | 引用 `.workbuddy/skills/...`、`.workbuddy/memory/MEMORY.md` | 该目录**已被 gitignore**（见 🟡-3） |

而 `Atrium_现状分析与迭代建议.md`（11:57）与 `Atrium_v1.13.0_更新说明.md`（11:52）**是本轮编辑后的版本，内容准确**。
→ **三份文档现在互相矛盾**，而手册是新人第一份要读的东西。

**修复建议**：**先确认这是不是有意回退**（我没有擅自覆盖）。若确认是意外，把本轮内容重新同步进去；
建议顺手把手册的"数字"改为**从源码取**的写法（例如指向 `npm test` 的实际输出），而不是硬编码。

### 🟡 中：隐患与"看起来没事"的坑

#### 🟡-1　`native.js` 有 **26 处 `catch → false / null / []`**，失败与"合法的否定结果"不可区分　✅ 已修复

```
js/native.js:40  readHead   → null      :52  autoDir   → null
              :46  loadDir    → null      :58  pickFolder→ null
              :67  pickExportDir → null   :172 trashLog  → []
              :178 trashForget→ false     :183 trashClear→ false
              :189 openRecycleBin→ false  :195 openPath  → false
              :208 alwaysOnTop→ false     :214 getAlwaysOnTop→ false
              :235 frameClose → false     :241 frameData → null
              :250 frameFit   → null      :256 frameInfo → null
              :267 frameMove  → false     …
```

**值得肯定的一半**：所有**用户可见的写操作**都保留了原因 ——
`exportFiles` / `deleteFile(s)` / `restoreFile(s)` / `frameOpen` 走
`.catch(e => ({ok:false, reason:'failed', message}))`，所以"删除失败"能给出人话文案。✅

**问题的一半**：查询/可选类调用**吞成裸值**。后果是
**"IPC 挂掉了"与"用户点了取消"、"这张图没有 EXIF"、"窗口本来就没置顶"完全同形**。
这正是上一轮 `a11yui` 假失败的根因形态：探针缺 handler → `invoke` reject → `.catch` 吞成 `false`
→ `applySetting` 判"没生效" → 回滚 + urgent 播报 → 播报区被永久改成 `assertive`。
**同一个形态还有 26 个入口。**

> 顺带更正一处文档失真：现状分析 §5.1 说"错误处理彻底…**从不静默吞掉**"。
> 对**写路径**成立；对**查询路径**不成立。这句话会让人不去查这里。

**修复建议**（按性价比排序）：
1. **优先**给"状态对齐类"调用加一次性告警：`alwaysOnTop` / `getAlwaysOnTop` / `setTray` / `setHotkey` / `frameInfo`。
   这些一旦静默失败，症状是"开关自己弹回去了"，用户与开发者都会误判成"功能没做"。
   ```js
   .catch((e) => { warnOnce('[native] ' + name + ' 失败：' + e.message); return false; });
   ```
   `warnOnce` 用 `Set` 去重，避免刷屏（与项目"响了比静默好"的既有取舍一致）。
2. 其余查询类可维持吞值，但**在函数头注释里写明"失败与空值同形，调用方必须能接受"**。
3. 断言侧：给关键通道加"**存在性断言**"——探针里断言 `typeof vfNative.xxx === 'function'`，
   让"漏桩"在**启动期**就红，而不是靠某个不相关的套件偶然变红。

#### 🟡-2　`assemble.js` 的注释与实现**直接矛盾**，且会误导判断　✅ 已修复

`deploy/electron/assemble.js:66-70`：

```js
/* … 要连文件图标一起换得上 rcedit，本项目刻意不引依赖。 */
```

而**同一个文件** `118-162` 行就在 `await import('rcedit')` 并盖章，
构建日志也会打印 `exe resources: icon + version 1.13.0 (rcedit)`。

**这条注释还包含一句现在为假的事实**："资源管理器里 `Atrium.exe` 的文件图标**仍是 Electron 默认的**"。
→ 我上一轮就是**先读到这段注释**，差点把"exe 图标没做"写进报告，直到读 `appself` 的字节级断言才发现相反。

**修复建议**：把这段注释改写为现状（rcedit 已引入、图标已盖章、`InternalName` 键名陷阱），
或直接删掉那两句结论性描述、只留"icon.ico 为什么要放在 `resources/app`"。

#### 🟡-3　`.workbuddy/` 被忽略后，文档出现**悬空引用**　✅ 已修复

手册 §7.5「完整流程见 `.workbuddy/skills/viewfinder-release/SKILL.md`」、
§附「动手前先读两份：本手册 + `.workbuddy/memory/MEMORY.md`」、
现状分析 §7.4「详见 `.workbuddy/skills/viewfinder-release` 的专章」。

而 `.workbuddy/` 已被 `.gitignore` 排除（这是你上一轮的选择）→
**新克隆的仓库里，"发布流程"这份文档根本不存在**，手册的第一条指引就断了。

**修复建议**（三选一，推荐第 1 个）：
1. **把发布流程从 `.workbuddy/skills/` 迁进仓库**（如 `deploy/release/RELEASE.md`），
   文档改指它。它描述的是**项目**的流程，不是某个人的工具配置。
2. 在文档里明确标注"本机文件，不入库"，并给一句可替代的摘要。
3. 解除 `.workbuddy/skills/` 的忽略（只放行 skills、继续忽略 memory）。

#### 🟡-4　`--fast` 的"跳过 Electron"是错的，新克隆跑不通　✅ 已修复

实测（原始仓库）：**9 套件 / 43 项 / 7.4 秒 / 全通过**。
但其中 `tf`（`run_all.js` 里 `kind:'probe'`、`tags:['core','joint']`）**需要 Electron**，
且**贡献了 29/43 项**（67%）。`run_all.js:6` 与手册都写着"只跑纯函数与联合几何（跳过 Electron）"。

实测证据：在**没有 `node_modules` 的新克隆**里跑 `--fast` →
9 套件 8 通过，`tf` 报 `找不到 electron.exe`。

**修复建议**：改措辞为"**跳过大部分 Electron 探针（仍含 `tf` 三路径联合回归）**"，
并在手册里点明"`--fast` 需要先 `npm i`"。若希望真的能脱离 Electron 跑，
则把 `tf` 的 `joint` 标签去掉——但那会失去最快的"真实 Electron 冒烟测试"，不建议。

#### 🟡-5　7 条桌面集成 IPC **全无 `e.sender` 归属校验**　✅ 已修复

`deploy/electron/desktop.js:387-412` 的 7 个 handler（`menuState` / `contextMenu` / `showInFolder` /
`setProgress` / `setTray` / `setHotkey` / `desktopInfo`）都是 `(e, ...) =>` **完全不看 `e`**。
全仓 `.sender` 只出现 **2 次**：`main.js:111`（`winOf(e)` 帮手）与 `main.js:508`
（`alwaysOnTop` 用它定位"发起调用的窗口"——这是**功能性**用法，不是安全校验）。

> **更正上一轮我的记录**：我曾写"其余四条都有 sender 校验"——**那是错的**，一条都没有。

**实际风险：低。** 前提是 `contextIsolation:true` + `nodeIntegration:false` + `sandbox:true`
+ 只加载本地 `vf://` 内容 + `setWindowOpenHandler` 拒绝新窗口 + `will-navigate` 拦外部导航。
在这些都成立时，渲染进程里跑的就是自家代码，**不构成现实漏洞**。
它是 Electron 官方安全检查表推荐的**纵深防御**：万一将来某处引入了一个能加载外部内容的路径，
sender 校验是最后一道闸。

**修复建议**：加一个 3 行的帮手，在 `wireIpc()` 里统一包一层（成本极低，收益是"未来免疫"）：

```js
const TRUSTED = () => [ctx.getMainWin(), ctx.getFrameWin()].filter(Boolean).map(w => w.webContents.id);
function guard(fn) {
  return (e, ...args) => {
    if (!TRUSTED().includes(e.sender.id)) { console.warn('[ipc] 拒绝来自非受信 sender 的调用'); return null; }
    return fn(...args);
  };
}
ipcMain.handle('vf:setTray', guard((st) => setTrayState(st)));
```

#### 🟡-6　**冻结标识未文档化** —— 一次"品牌清理"就会清空所有用户数据　✅ 已修复

v1.13.0 把产品改名 Atrium，但**刻意保留**了这些标识。它们**不能改**：

| 标识 | 位置 | 改了的后果 |
|---|---|---|
| `vf://app` | `main.js` 特权协议 | **源（origin）变了 → localStorage + IndexedDB 全部失效**：设置、收藏、旋转记录、尺寸缓存**一次性清空** |
| `viewfinder.settings.v1` / `.favs.v1` / `.rot.v1` | `state.js:10-12` | 同上（设置/收藏/旋转全丢） |
| `viewfinder-db` | `loader.js:12` | 缩略图与尺寸缓存全丢（可重建，但首屏会退化） |
| `com.atrium.app` | `main.js:50` `setAppUserModelId` | 任务栏固定、JumpList 关联错乱（可能出现重复图标） |
| `productName: "Atrium"` | `deploy/electron/package.json` | **`userData` 目录名随之改变** → 用户设置全部"消失" |
| `launcher.cmd` 的名字 | 手册明确"双击 `Atrium.cmd`，不是 exe" | 用户的快捷方式/说明全部失效 |

**文档现状**：`viewfinder-db` / `viewfinder.settings.v1` 只在手册 §3 作为"**存哪**"列出，
**没有"绝不能改"的警示**；`vf://app` 与 `com.atrium.app` 在三份文档里**零命中**；
手册 §7.4「改品牌」的四处清单（favicon / 窗口图标 / `assemble.js` 复制 / 关于面板）**也没提它们**。

**修复建议**：在手册 §7.4 顶部加一块 **「冻结点（禁止重命名）」** 表（上面这张），
并配一条断言：`check('存储标识未被改名', ['vf://app','viewfinder.settings.v1','viewfinder-db']...)`。
这是**成本最低、避免最大损失**的一条。

### 🟢 低 / 卫生

| # | 问题 | 证据 | 建议 | 状态 |
|---|---|---|---|---|
| 🟢-1 | `launcher.cmd` 是 **LF 行尾的 `.cmd`**，且是用户的**主入口** | `deploy/electron/launcher.cmd`（CRLF=0） | 当前实机可用，但 LF-only 批处理在 label/`goto` 构造下是已知脆弱点；建议转 CRLF（`.gitattributes` 用 `-text`，不会破坏它）。另 `for /f` 取"目录里第一个 exe"，同目录出现第二个 exe 会启错 | ✅ 已修复（纯 ASCII + CRLF，24 CRLF / 0 LF-only；按名优先找 `Atrium.exe`） |
| 🟢-2 | **两个零引用遗留物** | `deploy/logs-verinfo.txt`（185B）、`fixtures/zip/negative-crc.zip`（199B，`zip_gate.js` 现造坏包） | 删；前者已进 `.gitignore`，后者被 fixtures 例外规则保留入库 | ✅ 已修复（前者删、后者 `git rm`） |
| 🟢-3 | 测试文件头仍写旧名 | `test/*.test.js` 5 处「取景 Viewfinder」 | 改成 Atrium（纯注释，顺手即可） | ✅ 已修复 |
| 🟢-4 | 构建产物未版本化 | `deploy/dist-electron/` 原地覆盖 | 已记录于现状分析 §5.2-6；若要可回溯，构建时输出到带版本号的目录 | ✅ 已缓解（加 `BUILD-INFO.json`；**刻意不按版本建目录**，理由见手册 §8.2） |
| 🟢-5 | 历史 ZIP 会累积 | 每版约 112MB | 保留最近 1–2 版，更早的删掉（不是源码，删了不影响任何东西） | ⏳ **待用户确认**（`Atrium_离线版_v1.13.0.zip` 属退役形态，建议删） |
| 🟢-6 | 根 `package.json` 的 `name` 仍是 `viewfinder` | `package.json:2` | **不要改**（见 🟡-6）；建议加一行注释说明这是刻意的 | ✅ 已修复（加 `_nameFrozen` 说明 + `frozen` 套件锁住） |

---

## 三、修复建议与优先级

> ⚠️ **下表 15 项已全部执行完毕**（含 P0 / P1 / P2 / P3）。逐项的修复动作与验证方式见本文开头的
> 「✅ 修复状态：15 / 15 已完成」表；此处保留的是**当时的排期建议**，供日后复盘参考。

| 优先级 | 问题 | 具体动作 | 验证方式 | 量级 |
|---|---|---|---|---|
| **P0** | 🔴-3 手册过期 + 三文档冲突 | 确认是否意外回退；把 v1.13.0 内容同步回手册 | 三份文档的关键数字互查一致（套件/断言/IPC/入口数/设置数） | 中 |
| **P0** | 🟡-6 冻结标识未文档化 | 手册 §7.4 加「禁止重命名」表 + 1 条断言 | 断言锁住 `vf://app` / 3 个 LS 键 / `viewfinder-db` | 小 |
| **P1** | 🔴-1 重放表漏登记 + 防线弱 | 3 键补进 `ALL_KEYS`；断言换成"面板每行 ∈ ALL_KEYS"通用不变量 | 新断言**先红后绿**（红 = 证明它能拦住） | 小 |
| **P1** | 🔴-2 拖拽零覆盖 | 新增 `probe_drop.js`（5 条断言，含"无路径条目删除给可读原因"） | 探针 5 项全绿；故意改坏 `scanDataTransfer` 应能拦住 | 中 |
| **P1** | 🟡-2 `assemble.js` 注释矛盾 | 改写 `66-70` 行注释为现状 | 通读无"rcedit 没引/图标是默认的"之类表述 | 小 |
| **P2** | 🟡-3 `.workbuddy` 悬空引用 | 把发布流程迁进仓库（`deploy/release/RELEASE.md`），文档改指它 | 新克隆里手册的指引**可执行** | 小 |
| **P2** | 🟡-1 `native.js` 26 处静默吞值 | 给 5 个"状态对齐"调用加 `warnOnce`；其余补注释 | 手动制造一次 IPC 失败 → 控制台有告警而非静默 | 中 |
| **P2** | 🟡-4 `--fast` 措辞 | 改 `run_all.js:6` 与手册 | 表述与实测（9/43，含 `tf`）一致 | 小 |
| **P2** | 🟡-5 IPC sender 校验 | `desktop.js` 加 `guard()` 包一层 | 7 条通道各一条"非受信 sender 被拒"的断言 | 小 |
| **P3** | 🟢 卫生 6 项 | 逐个清理 | — | 小 |

**建议节奏**：P0 两项**同一天做完**（都是"防止未来犯大错"，且都很小）；
P1 三项合成一个版本（都在回归体系内，可一起验）；
P2/P3 随手带上，或攒到下一版。

---

## 四、需要重点验证的环节

按"**一旦错了，损失最大 / 最难发现**"排序：

### ① 拖拽入口（当前完全没验证）—— 见 🔴-2
必须新增覆盖。重点验**边界**：无磁盘路径的条目在"删除 / 还原 / 导出 / 旋转落盘"四条路上的行为。

### ② 存储标识的冻结（当前完全没验证）—— 见 🟡-6
一条断言就能永久防住"改名清空用户数据"。**性价比最高的一条**。

### ③ 「五处登记」的**通用**不变量 —— 见 🔴-1
现有断言是手工清单，等于没防。换成"面板每行必须登记"后，**必须先看到它变红**（红 = 它能拦住），
再补键转绿 —— 这与项目既有的**反向实验**纪律（`zip_gate.js` 造坏包、`case 'mode'` 改名）一脉相承。

### ④ exe 资源盖章（**已做好，保持**）
已有**字节级**判据（`icon.ico` 里 7 张内嵌 PNG 拿去 `exe.indexOf` 全中），
且做了反向实验（同一判据指向原始 `electron.exe` 命中 **0/7**）。
**这是全项目断言质量的标杆**，新断言应照这个标准写。

### ⑤ 产物与源码一致（**已做好，注意唯一例外**）
`js/*` 15 个、`css/*` 3 个、主进程 5 个模块均逐字节一致；
**`index.html` 是唯一例外**（`assemble.js` 会剥掉预览服务注入的 `data-page-node-id`），
做 MD5 对齐校验时**必须排除它**，否则会看到"假差异"。

### ⑥ 非整数 DPI 下的相框无边框（**已修好，保持**）
本机 `scaleFactor = 1.75`，无边框窗口 `getBounds()` 与 `getContentBounds()` **必然差 0~1px**。
判据已改为 **≤2px 容差**，并在快照里留 `frameBorderDelta` 供自证（带标题栏窗口实测差 14~15 / 37，差一个数量级）。

### ⑦ 探针宿主完整性（**部分做好**）
已有 `probes/_desktop_stub.js` 共享桩接入 15 个探针 + `applySetting(..., quiet)`。
**但缺"漏桩即失败"的存在性断言** —— 建议每个探针启动时断言所用通道 `typeof === 'function'`，
把"假失败"变成"启动即红"。

### ⑧ 新克隆可构建性（**已用端到端验证过**）
上一轮已实测：全新 `git clone` → 补 `node_modules` → `assemble.js` 完整构建 →
**产出的 `Atrium.exe` 与原始 exe MD5 完全相同**（`159f29dc…`）、`appself` 35/35。
建议把这条**固化成脚本**（`deploy/verify_clone.js`），每版跑一次，防止 `.gitignore` 日后被改坏。

### ⑨ 发布包完整性（**已做好**）
ZIP CRC 独立校验器（参照值取自 Node 原生 `zlib.crc32`，**与被测写入器不同源**）
+ 反向门禁（现场造坏包必须被拒）+ `7z t` 第三方复验。

---

## 五、总评

**这个项目最难得的不是功能多，而是"把踩过的坑变成了机制"**：
五层单向依赖、纯函数抽层让几何可毫秒级断言、校验器自带反向用例、
"五处登记"清单、失败信息**自证原因**（把"播报了几条"写进断言消息）……
上一轮那两条红灯（非整数 DPI、探针假宿主）**都是被既有防线自己抓出来的**，这很说明问题。

**当前最该做的不是加功能，而是补三处"防线的漏洞"**：
- 手册过期（🔴-3）→ 会误导每一个新加入的人；
- 拖拽零覆盖（🔴-2）→ 一条完整通路没有任何红灯；
- 通用不变量缺失（🔴-1）+ 冻结标识未锁（🟡-6）→ 都是"一条小断言换永久免疫"的事。

这三件事加起来不到一天，但能把"已经很高的工程质量"补上最后几块短板。

---

## 六、收口结论（同日追加）

上述三处"防线的漏洞"**已于同日补完**，且每一处都按项目既有纪律做了**反向实验**（先看到红，再转绿）：

- 🔴-3 手册 → **整篇重写**为 v1.13.0，全部数字回源码实测，三份文档互查一致；
- 🔴-2 拖拽 → 新增 `drop` 套件 13 项，**并因此查出 `js/loader.js` 里两个从未被发现的真缺陷**（顶层目录名重复、散文件未过滤扩展名）；
- 🔴-1 + 🟡-6 → 通用不变量与 `frozen` 套件都先验证过"能拦住"（改坏 → 红）。

**最终口径**：28 套件 / 346 项 / 0 失败（较诊断时 25 / 322 增加 3 套件 24 项）。
本报告至此可归档为**"修复前基线 + 修复记录"**，后续以 `Atrium_开发上手手册.md` 为唯一操作依据。
