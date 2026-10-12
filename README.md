# Atrium

[English](README.en.md) · 简体中文

发布包与版本更新说明见 [GitHub Releases](https://github.com/jhlxlml/Atrium/releases)。

Atrium（中庭）是面向 Windows 的本地图片浏览器：选一个文件夹，像翻阅作品集一样浏览你的照片。天光从高处落下、照亮整片陈列空间的地方，照片墙就是中庭。

它只干一件事 —— 把本地文件夹打开，用舒服的方式看图和整理。没有账号、没有云同步、没有遥测，**运行时第三方依赖为 0**，断网状态下功能完全一致。

![Atrium 网格视图：四种排布、文件名搜索、只看收藏、隐私模式与批量选择](docs/images/grid.png)

*网格视图预览。截图里的 24 张样张由 `?demo=1` 现场合成，不是真实照片。*

![Atrium 灯箱：缩放、旋转、全屏、幻灯片、EXIF 与收藏](docs/images/lightbox.png)

*灯箱预览，底部是缩放比例、旋转、EXIF、收藏与幻灯片控制条。*

交付形态只有一种：**Electron 便携包**。解压即用、无需安装。早先的「离线单文件 HTML」版本已在 v1.13.0 退役，对应的构建脚本、回归套件与渲染层浏览器回退分支都已移除。

仓库主要保存源码，**不包含发布 ZIP**（约 112 MB，已在 `.gitignore` 中）；需要的话按下面的步骤自行构建。

## 功能概览

### 浏览与加载

- 四种排布：小图、中图、**瀑布流**、单列。顶栏图标、设置面板、数字键 `1`–`4`、`M` 循环四种入口同值。
- 瀑布流按「最短列优先」分配，列宽可调（120–420 px），列宽重新均分以恰好填满容器；长列表虚拟化，滚动不掉帧。
- 原生目录选择、**拖拽入窗**（文件夹或散图都行）、记住上次目录。拖入的条目没有磁盘路径，索引 / 缩略图 / 灯箱 / 删除四条下游路径单独处理。
- 缩略图**落盘缓存**：二次打开零解码，约 5 倍加速。尺寸库存的是原图真实宽高 —— 靠读文件头拿到，不解码。

### 灯箱与相框

- 灯箱：缩放、拖动、旋转、全屏、幻灯片、缩略条、EXIF、收藏、删除；带对话框语义与焦点陷阱。
- **相框模式**：无边框独立窗，按图片比例自动变形，可拖动、可换屏；渲染进程崩溃后主窗自动恢复。

### 删除与找回

- 删除走**系统回收站**，可恢复；`Ctrl+Z` 撤销；另有回收站视图（记在本机 JSON 日志里）。
- 三档能力探测 —— 环境不支持可恢复删除时**如实告知**，而不是假装成功。

### 整理与检索

- 按文件名搜索、收藏、只看收藏、批量选择。
- 导出选中的图片：**旋转结果真实烘焙进像素**，不是只写个 EXIF 朝向标记。
- 隐私模式：一键糊掉所有图片，截屏 / 投屏时用。

### 格式支持

- JPEG、PNG、GIF、WebP、BMP、AVIF、SVG、ICO、TIFF。
- **HEIC/HEIF 走能力探测**：系统装了 HEVC 解码器就能看，没有就明确标记不可用，而不是无条件判死。全程只探一次并缓存。

### 桌面集成

能交给系统的就不自己画 —— 原生菜单（带加速键）、原生右键菜单（**按当前状态自动置灰**）、系统托盘、任务栏缩略图按钮与进度条、跳转列表、全局快捷键。

设计上有一条：**菜单项的 id 就等于内部命令 id**，所以回归探针可以拿着命令 id 向 Electron 反查"这一项到底绑的什么加速键"，测的是真实装配结果。

### 无障碍

四层齐备：播报（52 处操作全覆盖，危险操作走 `assertive` 立即插话）、语义与 `aria-modal`、四个容器共用焦点陷阱、键盘全可达 + 系统动效削减 + 焦点环。

## 快速开始

### 使用便携包

1. 解压 `Atrium_Electron版_v1.13.0.zip`；
2. 双击 **`Atrium.cmd`**（**不是** `Atrium.exe`）；
3. 点「添加文件夹」，或者直接把文件夹 / 图片拖进窗口。

> **为什么是 `.cmd` 而不是 exe**：WorkBuddy 及部分 Node 环境会注入 `NODE_OPTIONS`，Electron 打包版遇到它会**启动即退出**。启动器负责先清掉这个变量，再拉起主程序。它优先按名找 `Atrium.exe`，找不到才退回「目录里第一个 exe」。

### 从源码构建

环境：**Windows** + Node.js（推荐 20 及以上，实测 22.x）。运行时零依赖，下面两个包**只在构建期**需要。

```bash
git clone https://github.com/jhlxlml/Atrium.git && cd Atrium

# 1. 装构建期依赖（electron + rcedit，约 269 MB，已被 gitignore）
cd deploy/electron && npm i && cd ../..

# 2. 构建便携包 → deploy/dist-electron/
npm run build

# 3. 打包 ZIP → 根目录
npm run pack
npm run verify:zip      # 独立 CRC 校验器 + 7-Zip 第三方复验

# 4. 全量回归（含跑「装进包里的 exe」自检）
npm test
```

### 常用命令

| 命令 | 作用 |
|---|---|
| `npm test` | 全量回归：**28 套件 / 346 项**，约 150～190 秒 |
| `npm run test:fast` | 快跑：11 套件 / 51 项，约 8 秒（**含需要 electron 的 `tf`**） |
| `npm run build` | 构建 Electron 便携包 |
| `npm run pack` | 打成交付 ZIP |
| `npm run verify:zip` | ZIP 独立校验（CRC / 结构 / 第三方复验） |
| `npm run probe -- probe_grid.js` | 跑单个 Electron 探针 |
| `npm run shots` | 重新生成本 README 里的两张截图 |
| `npm run clean` | 清理回归运行期产物（曾攒到 2.5 GB） |

> **`npm test` 依赖构建产物**：`appself` 套件跑的是 `deploy/dist-electron/` 里的真实 exe（它正是"最接近真实用户"的那一层），`zip` 套件读根目录的交付 ZIP。**新克隆请先 `npm run build`（和 `npm run pack`）再跑全量回归**，否则这两套会失败 —— 这不是回归本身有问题，而是它们**故意不肯在产物缺失时假装通过**。只想验证源码改动的话，用 `npm run test:fast`。

## 快捷键

按 **`F1`** 在应用内随时打开这张表（内容全部来自实际绑定，不写"计划中"的项）。

| 按键 | 作用 |
|---|---|
| `Ctrl+O` | 打开文件夹 |
| `Ctrl+E` | 导出选中的图片 |
| `Ctrl+1` `Ctrl+2` `Ctrl+3` `Ctrl+4` | 小图 / 中图 / 瀑布流 / 单列 |
| `Ctrl+Plus` `Ctrl+-` `Ctrl+0` | 放大 / 缩小 / 重置尺寸 |
| `Ctrl+L` | 只看收藏 |
| `Ctrl+B` | 模糊预览（隐私模式） |
| `Ctrl+T` | 窗口置顶 |
| `Ctrl+Shift+F` | 相框模式 |
| `Ctrl+A` / `Ctrl+Shift+A` | 全选当前页（图库内 / 菜单） |
| `1` `2` `3` `4` / `M` | 切换排列模式 / 依次循环 |
| `F` / `/` | 只看收藏 / 搜索文件名 |
| `+` `-` | 放大 / 缩小瓦片 |
| `Delete` | 删除选中（移入回收站） |
| `空格` | 灯箱内：下一张 |
| `F11` / `F1` | 全屏 / 打开快捷键表 |
| `Esc` | 取消选择 / 关闭面板 / 退出回收站 |

在图片上点**右键**会弹出**原生菜单**（打开、上一张 / 下一张、旋转、收藏、全屏、在文件夹中显示、导出、删除、全选），并随当前状态自动置灰。

## 架构

**五层，单向依赖** —— 上层可以依赖下层，下层绝不反向依赖上层。

```
表现层   index.html · main.css / lightbox.css / frame.css
   ↑
交互层   app.js（事件与命令分发）· settings.js · grid.js · lightbox.js · frame.js
   ↑
状态层   state.js（唯一真相源 + 事件总线）· masonry.js / transform.js（纯函数）
   ↑
数据层   loader.js · thumb.js · exif.js · trash.js · util.js · a11y.js
   ↑
平台桥   native.js（渲染侧适配器）──IPC──▶ preload.js（白名单）──▶ main.js / desktop.js
```

几条刻意的设计：

- **纯函数下沉**：几何计算（排布、缩放、居中、旋转）全部抽成不依赖 DOM 的纯函数，于是可以在 Node 里毫秒级跑 **807 条**细分断言，不需要开窗口。
- **`desktop-spec.js` 是纯数据**（菜单模板 / 加速键 / 命令词表），**不许 `require('electron')`** —— 所以它能在 Node 里被 76 条断言直接测。
- **安全基线**：`contextIsolation: true` / `nodeIntegration: false` / `sandbox: true`、自定义 `vf://` 特权协议、preload 白名单、拒绝新窗口与外部导航；桌面集成的每条 IPC **逐条校验 sender 归属**，非受信调用直接拒绝。

## 工程与回归

这个项目尽量把「踩过的坑」变成**机制**。当前口径：

| 指标 | 值 |
|---|---|
| 回归 | **28 套件 / 346 项断言**，任一失败**非零码退出** |
| 源码规模 | `js/` 9361 行 / 15 模块 · `css/` 1788 行 / 3 文件 · `index.html` 373 行 · 主进程侧 2782 行 |
| IPC | 33 条 invoke + 1 条 render→main + 3 条 main→render = **37 个唯一通道名** |
| 运行时依赖 | **0**（`electron` 与 `rcedit` 均只在构建期） |

回归体系里有几层是**相互独立的防线**：

- **跑真实产物**：`appself` 直接运行**装进包里的 exe**，走引导 → 索引 → 解码 → 删除 → 还原 → 批量 → 框选 → 灯箱 → EXIF → 窗口置顶的全链路。
- **校验器自带反向门禁**：ZIP 的 CRC 校验用 Node 原生 `zlib.crc32` 作参照值（**与被测写入器不同源**），并现场造坏包证明它真的会拒；图标校验器**不复用生成代码**（自己校验自己等于自证）。
- **字节级判据**：验证 exe 图标不是"构建没报错"，而是把 `.ico` 里 7 张内嵌 PNG 的字节拿去 `exe.indexOf` 逐个查 —— 7 个全部命中，同一张在原始 `electron.exe` 里是 `-1`。
- **源级不变量**：`frozen` 套件锁住一批「改了就会**清空用户数据**」的字符串（`vf://app`、3 个 `localStorage` 键、`viewfinder-db`、`com.atrium.app`、`productName`）；`ipcchain` 套件核对 preload 暴露的每条通道都有 handler，漏一条就是**静默降级**。
- **失败要自证原因**：断言消息里带上"播报了几条、最后一条是什么"这类现场信息，避免只看到一句 `false`。

> **口径提醒**：`346` 是**套件级条目数**。6 个纯函数套件内部各自展开更多细分断言（合计 807 条），聚合器把它们各按 1 项计入 —— 所以**别自己相加**。

## 目录结构

```
Atrium/
├─ index.html            应用外壳（含内联 SVG 图标精灵）
├─ js/                   渲染层全部逻辑（15 个模块，IIFE 挂 window）
│   ├─ app.js            事件与命令分发、弹层、轻提示
│   ├─ state.js          唯一真相源 + 事件总线
│   ├─ grid.js           网格渲染与虚拟化
│   ├─ masonry.js        瀑布流纯函数
│   ├─ transform.js      缩放 / 旋转 / 居中纯函数
│   ├─ lightbox.js       灯箱
│   ├─ frame.js          相框模式
│   ├─ loader.js         目录扫描与拖拽导入
│   ├─ thumb.js          缩略图与落盘缓存
│   ├─ exif.js           EXIF 读取
│   ├─ trash.js          删除与找回
│   ├─ native.js         平台桥适配器
│   ├─ settings.js       设置面板
│   ├─ a11y.js           无障碍（播报 / 焦点陷阱）
│   └─ util.js           工具与文件头解析
├─ css/                  3 个样式文件
├─ brand/                品牌资产（手写矢量 SVG + 七尺寸 .ico）
├─ docs/                 README 截图与文档配图
├─ test/                 Node 纯函数单测
└─ deploy/
    ├─ electron/         主进程侧：main / preload / desktop / desktop-spec / exportlib
    ├─ electron-test/    回归体系：run_all + 17 个 Electron 探针 + 门禁脚本
    ├─ release/          发布流程（RELEASE.md）
    ├─ make_icons.js     SVG → 七尺寸 .ico（用项目自带的 Electron 当渲染器）
    ├─ verify_clone.js   新克隆可构建性门禁
    └─ pack.js           打包
```

## 已知边界

- **目前只有 Windows 包**。托盘、任务栏缩略图按钮、跳转列表都是 Windows 原生能力；图标资产也只有 `.ico`，出 macOS 包需要另做 `.icns`。
- **搜索只匹配文件名**，未做 EXIF / 尺寸 / 大小检索。
- **HEIC 能否查看取决于系统解码器**，应用只做能力探测并如实显示，不自带解码库（那会破坏"零依赖"）。
- 无障碍还有两块没做：多选状态的键盘操作、幻灯片播报的节制策略。

## 文档

| 文件 | 内容 |
|---|---|
| [`Atrium_开发上手手册.md`](Atrium_开发上手手册.md) | **操作手册**：命令、五层架构、雷区清单、改设置 / 加 IPC 的标准动作、冻结点 |
| [`Atrium_现状分析与迭代建议.md`](Atrium_现状分析与迭代建议.md) | 纵深分析：模块完成度、技术债、迭代路线 |
| [`Atrium_v1.13.0_更新说明.md`](Atrium_v1.13.0_更新说明.md) | 本版改了什么，以及踩到的坑 |
| [`Atrium_问题清单与修复优先级.md`](Atrium_问题清单与修复优先级.md) | 一次全项目体检：问题分级、修复记录与验证方式 |
| [`deploy/release/RELEASE.md`](deploy/release/RELEASE.md) | 发布流程：固定顺序、验收标准、打包高危坑 |

## 许可

见 [`LICENSE`](LICENSE)。
