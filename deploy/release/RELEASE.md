# Atrium · 版本发布与交付流程

> 这份文档描述的是**项目**的发布流程，所以它随源码入库（`deploy/release/RELEASE.md`）。
> 早先它只存在于某台机器的 `.workbuddy/skills/` 下 —— 而那个目录**被 `.gitignore` 排除**，
> 于是新克隆的仓库里"发布流程"根本不存在，手册的第一条指引就是断的。
>
> 对应版本：**v1.13.0**（`App.VERSION`）｜ 动手前请先读《`Atrium_开发上手手册.md`》§6 雷区清单

---

## 何时用

用户提出任何形态的"出新版本 / 打包 / 交付 / 跑一遍回归确认没问题"，或改完代码要出 ZIP。
**不要跳过任何一步** —— v1.5.0 曾因"打包器 CRC 算错 + 自校验是弱校验"，
交付了一个 7-Zip 逐条报 `CRC Failed` 的包。下面每一步都是为了防这一类事故。

---

## 固定顺序（顺序本身是纪律，别调换）

| # | 动作 | 为什么必须在这个位置 |
|---|------|---------------------|
| 1 | 改**三处**版本号：`package.json` / `deploy/electron/package.json` / `js/app.js` 的 `App.VERSION` | 单一版本来源；`pack.js` 从 `package.json` 读版本号生成产物名 |
| 2 | 确认改动的文件都已落盘（**改多文件时串行编辑**） | 并行 `Edit` 同一文件会丢改动（第二次基于旧内容写回）。**同类文件要改多处时，直接整篇 `Write` 一次成型** |
| 3 | 构建：`node deploy/electron/assemble.js`。**若动过 `brand/icon*.svg`**，先 `node deploy/make_icons.js` 重生成 PNG/ICO，再 `node deploy/verify_icon.js` 独立校验 | **必须在跑回归之前** —— `appself` / `icon` / `zip` 套件跑的是**装进包里的产物**，不是源码 |
| 4 | 校验产物含最新源码：`js/<改过的>.js` 与 `deploy/dist-electron/.../resources/app/js/<同名>` 两侧 MD5 必须一致。**`index.html` 是唯一例外**（`assemble.js` 会剥掉预览服务注入的 `data-page-node-id`），做 MD5 对齐时**必须排除它**，否则会看到"假差异" | 防止"改了源码但没重建"白跑一轮。**回归跑完之后若又动了源码（哪怕只改一行文案），必须重新构建并复跑受影响套件** |
| 5 | `node deploy/electron-test/run_all.js`（全量；可后台跑） | 任一失败即停，不要带着红继续打包。**失败先分诊产品/测试**（见下） |
| 6 | `node deploy/pack.js`（或 `npm run pack`） | 打包器自带强制校验：写 `*.tmp` → 交给 `verify_zip.js` 全量核验 → 通过才改名。不过即删临时文件并非零码退出 |
| 7 | `node deploy/verify_zip.js`（或 `npm run verify:zip`） | 独立复验根目录下**所有** ZIP（含历史版本）；参照值取自 Node 原生 `zlib.crc32`，与被测写入器**不同源** |
| 8 | `"D:/Program Files/7-Zip/7z.exe" t <zip>` | 7-Zip 不在 PATH，必须绝对路径。这是**第三方复验** —— 前两步都是自家实现，不能互相背书 |
| 9 | 写 `Atrium_vX.Y.Z_更新说明.md` | 格式照抄上一版：用户要求 → 实现方式表 → 关键决策与理由 → 验证 → 交付物 → 这版之后 |
| 10 | 更新 `Atrium_现状分析与迭代建议.md` | 见下方「文档必改清单」 |
| 11 | 追加 `.workbuddy/memory/YYYY-MM-DD.md` 日志 | append-only，不覆盖。⚠️ 该目录**不入库**，只对本机有效 |
| 12 | 交付（`present_files`） | 顺序即优先级（第一个会被自动打开）：更新说明 → Electron 版 ZIP → 现状分析 |
| 13 | `node deploy/clean.js`（或 `npm run clean`；`--dry` 可先预演） | **每次跑完 `run_all.js` 都要做**。`logs/` 里每个 Electron 探针会留一个 `ud_*` userData 目录（内含完整 Chromium Cache，单个上百 MB），不清就一直攒 —— 曾攒到 **2.5 GB / 17,518 个文件** |

> ⚠️ **本机环境**：bash 没有 coreutils（`wc`/`tail` 常缺），`npm` 也常不在 PATH ——
> **优先直接 `node <script>`**，别依赖 `npm`/`npx`。

---

## 验收标准（一条都不能少）

- `run_all.js` 末行：`通过 N，失败 0`
- `verify_zip.js` 末行：`全部 ZIP 校验通过`
- `7z t` 的包出现 **`Everything is Ok`**
- 产物与源码一致：`js/<改过的>.js` 与包内同名文件 MD5 相同（**`index.html` 除外**）

---

## 手动验收（断言替代不了眼睛，别跳）

回归跑绿不等于用户看到的是对的。出包前**至少**核对：

1. 全新启动的默认态是不是预期（新增的开关默认该显示还是隐藏）；
2. 新入口点得开、且**真的做了事**；
3. **重启一次** —— 凡是"设置驱动的界面变化"，最容易漏的就是没接到启动流程，重启才暴露；
4. 「恢复默认」后界面跟着回来（检查新键有没有加进 `Settings.ALL_KEYS` —— 现在有**通用不变量断言**兜着）；
5. **键盘走一遍**：Tab 能进设置面板/灯箱，Tab **跑不出去**，Esc 关闭后焦点回到原控件；
6. **相框走一遍**：拖动图片区域窗口真的跟着走、且**拖完那一下不会误触"下一张"**、
   普通单击仍能换图、双击/Esc 退出后**主窗口要回来**；有多屏时切「显示屏幕」看是否真的开到目标屏；
7. **排列模式走一遍**（四种：小图 / 中图 / 瀑布流 / 单列）：顶栏四个图标、设置面板「排列模式」、
   数字键 `1`–`4` 与 `M` 各走一遍，**看图库真的换了排法**（不是只有图标高亮变）；
8. **拖拽走一遍**：拖一个文件夹进来、拖多个文件夹进来、拖散图进来；
   再拖一个 `.txt` 进来看是否给出"未发现可加载的图片"（而不是凭空多出一个坏图瓦片）。

> 第 3 条（重启）可以脚本化：在 `deploy/electron-test/probes/` 写一个 **`_tmp_` 前缀的临时探针**
> （用完即删，不进仓库），隔离 `userData`，用 `win.webContents.reload()` 模拟重启，
> 比对同一元素在「首启 / 开设置后 / reload 后 / 关设置再 reload 后」四种状态下的 `hidden` 与 localStorage 值。
> 复跑：`node deploy/electron-test/run_probe.js "D:/.../probes/_tmp_xxx.js"` ——
> **参数必须是 Windows 路径**，传 MSYS 的 `/d/...` 会直接报"探针不存在"。

---

## 自检"挂住 / 没有任何输出"时的第一动作

`node deploy/electron-test/manual_appself.js [超时秒]` —— 带 `VF_TRACE` 跑**打包后的 exe** 自检，
打印 trace 与结果尾部（另存 `logs/trace-manual-appself.log`）。

**为什么需要它**：`run_all.js appself` 在自检挂死时**只打一行标题、什么都不说**（240s 超时才返回），
完全区分不出"代码错"还是"进程没起来"。而"进程没起来"还有一种成因是
**上一轮卡死的 Electron 子进程没清掉**（前一轮 PID 还在，本轮直接挂住）。
→ 见到挂住，**先跑手工脚本**；通了说明是环境残留，清进程后重跑 `run_all.js`。

---

## 回归红了，先分诊：是**产品**错，还是**测试**错？

改完功能跑全量出现失败时，**不要先动产品代码**。先判断这条断言在测什么、
以及"它失败"是否等价于"用户会看到坏结果"。

### 判据一：失败集合和"探针是否写 `shots/`"完全对齐 → 是目录问题，不是环境

`run_all.js` 每次都会把探针输出留档到 `logs/trace-<probe>.log`。
**探针失败的第一动作是 `cat` 这个文件，不是重跑、不是怀疑环境。**

```
$ cat deploy/electron-test/logs/trace-probe_grid.log
ERR Error: ENOENT: no such file or directory, open '…\shots\grid-geo.json'
```

`probe_grid.js` 这类探针**先写文件、后打印结果行**。`shots/` 不存在 → 写文件抛错 →
探针在输出 `GRID {...}` 之前就死了 → 上层只看到"未解析到 GRID 输出"。

### 判据二：探针中途死掉会**跳过自己的"收尾还原 defaults"**

把设置污染留在它们共享的默认 partition 里。症状是"修好目录之后，另一个套件依然挂"。
清法是**跑一次 `run_all.js masonry`**，用它自己的还原路径写回默认 —— **别手工改 leveldb**。

### 其余高频"测试错、不是产品错"

- **异步动作的反馈不能用固定 `sleep` 断言**：固定 sleep 会**同时**产出假失败（读早了）
  与假通过（还没清完但读数恰好对了）。要轮询等待。
- **元素指纹不够细** → 同 class 一排按钮被判成"没动"。指纹要加父节点下标 + `aria-label`。
- **CSS 过渡没跨过就测量** → 读到**起始值**。断言前先中和过渡（`transition='none'` + `void offsetWidth`）。
- **`getBoundingClientRect` 对旋转元素**返回**轴对齐包围盒** → 会误判"已居中"。改用 DOMMatrix 解算四角。
- **报产物体积用字符数**：`html.length` 是**字符数**，中文少报约 13%。必须 `Buffer.byteLength(s,'utf8')`。

> **总则：「测量工具本身会说谎」。** 以上每一条都真发生过。

---

## 打包 / 校验相关的高危坑

- **CRC32 必须算在「压缩前」的原始内容上**。算在压缩后字节流上 → 方法 8 的条目 100% 报 `CRC Failed`，
  而"解压后字节数一致"这种弱校验**完全拦不住**。
- **改 `pack.js` / `verify_zip.js` 后必须同步跑** `node deploy/electron-test/zip_gate.js`
  （现场造复刻该 bug 的坏包，断言必拒 + 只差 CRC 一个变量的对照样本断言必通过）。
  只测"好样本通过"是不够的 —— 校验器可能对任何输入都返回通过。
- **新增 JS 模块要同步三处**：
  ① `index.html` 加 `<script src="js/x.js">`，**位置必须在使用者之前**（如 `masonry.js` 在 `grid.js` 之前）；
  ② `deploy/electron/assemble.js` 的 `MAIN_FILES`（**只针对主进程侧**的平铺文件）；
  ③ 跑一次构建 —— `assemble.js` 会校验 `index.html` 引用的本地文件是否都存在，死链会被拦下。
  > `js/` 与 `css/` 目录**不需要加清单**：`assemble.js` 是 `fs.readdirSync` **扫目录全量复制**，结构上不会漏。
  > 起因：v1.9.0 的白名单漏了 `css/frame.css`，产物留了一条**死链**，
  > 相框浮层**无样式运行**且已随 ZIP 发出去 —— 而所有断言都是绿的。
- 探针/自检沙箱**必须放在项目同一个盘**。放到系统临时目录（C:）时"移入回收站 → 撤销还原"会因
  回收站查不到而报 `not-found` —— 这是卷/回收站的环境限制，**不是产品缺陷**，别去改产品代码。
- **隐藏顶栏按钮只能用 `hidden` 属性，绝不能把节点摘出 DOM**：`probe_topbar.js` 按
  `[...ctrls.children]` 下标算几何，摘节点会直接打破断言。同时 `css/main.css` 的
  `[hidden]{display:none!important}` 是承重的（`.ico-btn` 是 `inline-flex`，同 specificity）。
- **断言"默认值"前先显式写入目标值再重建面板**：探针的持久分区会留上一轮的值，
  依赖"首次启动刚好是默认值"会假失败。
- **`brand/icon.ico` 必须入库**：它由 `make_icons.js` 生成，但 `assemble.js` 需要它，
  重新生成要 Electron 工具链 —— 所以不当作"构建产物"忽略。
- **exe 资源盖章的键名是 `InternalName`**（`assemble.js` 的 `stampExeResources`）。
  写成 `InternalFilename` 会**静默保留** `electron.exe` —— 不报错、只是没改到。

---

## 文档必改清单（`Atrium_现状分析与迭代建议.md`）

这个文档是"现状分析"，留着旧数字比不写更糟。每次改这几处：

1. 抬头 `当前版本` / `最近复核日期`
2. `一、项目概览` 表的：交付形态体积、源码规模（`wc -l` 实取）、测试资产
3. 核心功能章节：新增/变化的功能小节（**如插入新小节要顺延后面的编号，并检查有无交叉引用**）
4. 成熟度评估表（含星级的升降，别只改说明文字）
5. `3.1 分层` 图里的**逐文件行数**（`wc -l` 实取，别估算）
6. `3.2 技术选型判断`：优点里的体积/IPC 数、技术债逐条标 ✅ 已解决（含版本号）
7. `5.2 / 6.2 / 7.x`：已解决的划掉并标 ✅，新发现的问题补进去
8. `实施进度` 表新增一行 + `建议的版本节奏` 代码块 + `回归资产现状` 的数字
9. `附：关键指标速查` —— **每个数字都要实测**（`wc -l`、`grep -c`、`ls -la`、ZIP 实际大小）

> 改动面很大时**直接整篇重写**比逐处 `Edit` 更安全：逐处改同一文件既违反"串行编辑"纪律，
> 也容易漏掉交叉引用的旧数字。

### 断言数字的口径（容易写错）

`run_all.js` 汇总的是**套件级条目数**，**不等于**单个 `assert` 的总数：
纯函数套件内部各自展开更多细分断言（`transform` 36、`header` 26、`frame` 505、`a11y` 77、
`masonry` 87、`desktop` 76，合计 **807** 条），聚合器把它们各按 **1 项** 计入。

写文档时要用 `run_all.js` 末行的那个数，并说明口径；**不要自己相加**。
套件数量实取：

```
grep -oE "id: '[a-zA-Z0-9_]+'" deploy/electron-test/run_all.js | sort -u | wc -l
```

> **id 不能重复**：纯函数套件的 id 曾是 `masonry`，与探针套件撞名，已改成 `masonryunit`；
> 重名会让 `run_all.js <id>` 的筛选与 `--fast` 判重出问题。

**总数会在两个值之间跳，别当成异常**：`zip` 套件按"Electron 大包在不在"跑不同条数
（见 `run_all.js` 里的 `if (d.electronZipExists && ...)` 与 `if (d.sevenZipFound)`）。
版本号刚升、`pack.js` 还没跑时大包还不存在 → 少几条。
**这不是"静默跳过了断言"，是条件断言** —— 但要对得上账，否则容易误判成回归缩水。

> 与上一条**方向相反**的情况要警惕：**断言数无理由地变少 = 有 `if (sX)` 块被跳过**。
> 条件断言对得上账，静默跳过对不上账 —— 查账的方法就是看**哪一步没有输出**。

---

## 交付物

| 文件 | 用法 |
|---|---|
| `Atrium_Electron版_vX.Y.Z.zip` | 解压后双击 **`Atrium.cmd`**（不要直接双击 exe，某些环境带的 `NODE_OPTIONS` 会干扰启动） |

> **只有这一个交付物。** 离线单文件 HTML 版在 v1.13.0 已退役（`build_offline.js` 已删除）——
> 手册与现状分析里若还提到"双目标交付"，那是过期内容。
>
> 交付后清点根目录：**历史版本的解压目录必须删掉**（`Atrium_Electron版_v*/`，每个约 269 MB）。
> 危害不止磁盘 —— 全仓 `grep` 会命中这些陈旧副本，**真正的源码命中被淹没**，是"改错文件"的温床。
> 存档只靠根目录 ZIP（名字带版本号）。**但若该目录可能是用户自己解压测试留下的，先问一句再删。**
> 旧版本 ZIP 不必留（结果与决策已写进现状分析与长期记忆）；`verify_zip.js` 会枚举根目录**所有** `*.zip`，
> 所以清掉旧包只会让复验范围变小，不会失败。

---

## 发布到 GitHub Releases

仓库：<https://github.com/jhlxlml/Atrium>　（**public**，默认分支 `main`）

### 两步

```bash
# 1. 打 tag 并推送（附注 tag，说明写版本要点）
git tag -a v1.13.0 -m 'Atrium v1.13.0'   # 内容按版本填
git push origin v1.13.0

# 2. 建 release + 上传 ZIP（token 只从环境变量读，不进 shell 历史）
GH_TOKEN=<repo 权限的 token> node deploy/release/upload_release.js
```

先 `--dry` 可以只看它打算做什么、不发任何请求：

```bash
GH_TOKEN=x node deploy/release/upload_release.js --dry
```

### 这个脚本的纪律（别绕过）

- **流程是「建 draft → 上传资产 → 校验大小 → 转公开」**。中途失败只会留下一个**草稿**，
  不会出现"release 已公开但附件没传上去"——那个状态对下载者最难受。
- **上传后必须比对大小**（本地 vs 远端字节数）。GitHub 返回成功不等于内容完整。
- **幂等**：该 tag 已有 release 就复用，同名资产已存在就跳过，可安全重跑。
- **发布说明取自 `Atrium_v<版本>_更新说明.md`**，不另写一份 —— 避免两处说法打架。

### ⚠️ 高危坑：release 资产名不支持非 ASCII

本地 ZIP 叫 `Atrium_Electron版_v1.13.0.zip`（`pack.js` 的命名），但 **GitHub 会把资产名里的非 ASCII 字符
替换成 `.`** —— 实测上传后变成了 `Atrium_Electron._v1.13.0.zip`，和文档里写的名字对不上。

所以**发布资产用 ASCII 名**：`Atrium_Electron_v1.13.0.zip`（`upload_release.js` 里写死）。
本地 ZIP 名不动 —— `Atrium_Electron版` 同时是**构建输出目录名**（`assemble.js` / `pack.js` / `run_all.js` /
`verify_clone.js` / `probe_fs.js` / `probe_rot_final.js` / `manual_appself.js` 都引用它），改它要动回归体系，不划算。

> 若已经传成了被替换的名字，不用重传 112 MB —— 直接改名即可：
> `PATCH /repos/<owner>/<repo>/releases/assets/<asset_id>`，body `{"name":"Atrium_Electron_v1.13.0.zip"}`。

### 本机 token 从哪来

本机没有 `gh` CLI。git 凭据由 **Git Credential Manager** 托管，可用它取：

```bash
GH_TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null | sed -n 's/^password=//p') \
  node deploy/release/upload_release.js
```

当前 token 的 scope 是 `gist, repo, workflow` —— `repo` 足够建 release 与上传资产。
**别把 token 写进文件或命令行参数**（会进 shell 历史 / 进程列表）。
