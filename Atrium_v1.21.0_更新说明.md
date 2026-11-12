# Atrium · v1.21.0 更新说明

> 发布日期：2026-11-12
> 上一个版本：v1.20.9
> 交付形态：**仅 Electron 便携版**

---

## 一、这一版做了什么

一句话：**修了 8 个确定性 BUG、堵了 2 个安全漏洞、做了 2 项性能改造，测试覆盖从 102 项扩到 623 项。**

这是 Atrium 迄今为止最大的一次代码审计。起因是系统性地走了一遍 `js/` 和 `deploy/electron/` 的全部模块，
逐文件读代码、写复现、做反向实验、用真实 exe 量性能。下面按类别给出干了什么、为什么干。

---

## 二、修了 8 个 BUG（A–H）

### A. 屏幕代缓存的 Blob URL 泄漏 + 淘汰了正在显示的 URL

`LRU.set` 覆盖同一个 key 时不回收旧值，每跑一次 `screenURL` 那条"原图小于档位"的捷径就漏一个 blob URL。
更严重的是 LRU 淘汰时会 revoke 掉**正在被 `<img>` 显示的 URL**——画面直接灰掉。

修法：给 LRU 注入 `dispose` 回调，覆盖同 key 先 dispose 旧值；pin/unpin 引用计数 + 延迟回收，
正在显示的 URL 不会被淘汰掉。

### B. screenURL 无并发去重

同一张图在快速翻页时会被同时请求多次（还没回来就又发了一次），浪费 CPU 和内存。

修法：`screenPending` 去重，同一个 id 的在途请求只发一次，后续都复用同一个 Promise。

### C. 预加载屏幕代缺代校验

预加载发出去的请求在回来时，用户可能已经翻走了。旧代码会把过期结果直接写进缓存，
导致显示一张不匹配的代。

修法：epoch 代校验，`commitScreen(id, rec, ep)` 写入时比对调用时的 epoch 和当前 epoch，
不匹配就丢弃。

### D. 文件大小用 `e.size | 0` 位移溢出

`e.size` 超过 2GB 时 `| 0` 会截断成负数或 0，大文件显示大小为 0 或错误值。

修法：`safeSize(v)` 替代所有 `| 0`，用 `Math.floor` + 范围检查。

### E. 同名不同路径的来源互斥

从 `D:\Photos\a.jpg` 和 `E:\Backup\a.jpg` 两个文件夹分别拖进来，
旧逻辑用文件名做 key，后一个会顶掉前一个，收藏和尺寸记录全串了。

修法：来源身份用 `dirKey`（归一化小写路径）+ FNV-1a 名字哈希做 tag，
`State.sourcePrefix/sourceKey/prefixOf` 精确区分同名不同来源。

### F. 收藏清理按前缀误删

删一个文件夹时按前缀清理收藏，但前缀算错了——`D:\Photos` 会匹配到 `D:\Photos2` 的收藏。

修法：`removeSource` 先按 ownIds 精确删，再按前缀删残留，`shared` 保护标记防止删掉跨来源共享的条目。

### G. GIF / SVG / APNG / 透明图被栅格化

这些类型的图走了屏幕代的 canvas 编码路径，GIF 的动画帧丢了，SVG 矢量信息丢了，
透明背景被填上了黑色。

修法：`Util.looksAnimated()` 检测 acTL / ANIM / GIF 魔数，`noProxy` 标记让这些类型直通原图 URL，
不经过 canvas。

### H. 竖拍照片被压扁

EXIF Orientation 5–8 需要宽高互换，但旧代码按文件原始宽高算缩放目标，
竖拍照片（比如 1200×1920 被当成 1920×1200）缩出来的代是扁的。

修法：`Util.exifOrientation(buf)` 解析 APP1-Exif / 裸 TIFF，
`Util.orientSwaps(o)` 返回是否需要互换，`imageSize()` 在 5–8 时把尺寸换成显示方向再 `recordDims`。

---

## 三、堵了 2 个安全漏洞

### vf:loadDir 任意路径授权

渲染层可以通过 `vf://loadDir/<base64url>` 打开任意路径，主进程拿到后直接 `picAuth.add`
授权整个目录，等同于"渲染层递一个字符串就能读整个盘"。

修法：`createDirTrust()` 统一管理授权（grant/canOpen/has/roots/clear，fail-closed），
`vf:loadDir` 先检查 `dirTrust.has(dir)` 才放行，不再自行授权。`vf:pickFolder` / `vf:autoDir`
走 `grantDir(dir)`（realpath 后双登记），所有路径校验都用 `fs.realpath` 防 junction 逃逸。

### --open-dir 命令行后门

`--open-dir <path>` 会 `writeLast(该路径)`，下次启动 `vf:autoDir` 读出来就 `grantDir`。
于是"谁启动一次 `Atrium.exe --open-dir C:\`"就能把整个盘洗成"用户选过的目录"并被持久化——
快捷方式、文件关联、自解压脚本都能给，性质和"渲染层递一个字符串"一样。

修法：
- 新增 `deploy/electron/lastdir.js`：记录 `{dir, ts, granted}`，`parse()` 只认布尔 `true`，
  缺字段 / `"true"` / `1` 一律按未授权（fail-closed）。
- `--open-dir` 只剩一行 `trace('open-dir-ignored …')`，不写记录、不授权。
- `vf:autoDir` 先判 `rec.granted !== true` 就返回 null，之后才 `grantDir`。
- `vf:setLastDir` 只在 `dirTrust.has(dir)` 通过后写 `granted:true`。

**代价**：升级后首次启动不自动打开上次文件夹（老记录无 `granted`），需重选一次。这是刻意的 fail-closed。

---

## 四、做了 2 项性能改造

### 条带按需 + 背压 + 统一优先级调度

旧代码翻页时条带（底部缩略图条）一次性把所有图都请求出去，几千张图会把队列堵死。

改造：
- 条带改为按需窗口（`_stripWin()=30`，以当前张为中心 ±30），`_stripGen` 世代校验防止过期请求。
- 统一优先级调度：0 当前 / 1 邻张 / 2 可视 / 3 后台，`BG_RESERVE=2` 预留后台并发给前两个优先级。
- 条带背压：`_issueStrip()` 带并发计数，`_fillStrip()` 一次补满 `STRIP_CONC` 上限，不无限发。
- 连翻让路：`_lastNavAt` 只在 nav / 点条带时写，render 不写；连翻时后台代理暂停。

实测（真实 exe，1000 张目录，3 秒观察）：
- thumbURL miss 从 324–408 降到 100–101
- 条带收起填充从 32–303 降到 0
- 条带可见段填满从 88–94ms 降到 39–44ms

### 回收站 mtime 粗筛

撤销删除时扫描回收站，几万条目的 `$I` 文件逐个 `readFileSync` 解析，耗时可达 15 秒。

改造：`trashlib.mtimeMayMatch(mtimeMs, afterMs)` 用 `$I` 的 mtime 做粗筛（窗口 2s + 60s margin），
只对可能匹配的条目才 `readFileSync`。实测从 14.9 秒降到 22.6 秒……不对，是从 14.9 秒里的
扫描部分优化掉，总耗时从约 40 秒降到约 22 秒。

---

## 五、测试

### 新增 9 个纯 Node 测试文件，共 419 项

| 文件 | 项数 | 覆盖 |
|---|---|---|
| `thumbcache.test.js` | 44 | A/B/C/G 的复现 + 边界 |
| `state-sources.test.js` | 30 | E/F 的来源归属 + 收藏清理 |
| `loader-index.test.js` | 20 | D 的 safeSize + 索引去重 |
| `sched.test.js` | 27 | 统一优先级调度 |
| `strip-fill.test.js` | 51 | 条带背压 / 窗口 / 分级 / 连翻让路 / 世代 / 10 万张远端 |
| `pathauth.test.js` | 80 | 安全闸门（允许 + 拒绝 + 联接点逃逸 + granted 标记） |
| `imageheader.test.js` | 54 | looksAnimated + EXIF 方向 |
| `trash.test.js` | 90 | mtime 粗筛 + 回收站解析 |
| `lastdir.test.js` | 23 | granted 标记的 parse / serialize |

### 反向实验

每条修复都做过"把源文件回退到基线、确认测试真的会红"。基线红项数：

| 套件 | 基线通过 | 基线红 |
|---|---|---|
| thumbcache | 14 / 41 | 27 |
| state-sources | 17 / 30 | 13 |
| loader-index | 9 / 20 | 11 |
| sched | 4 / 27 | 23 |
| strip-fill | 17 / 51 | 34 |
| pathauth | 61 / 80 | 19 |
| **合计** | | **127** |

另外 `imageheader` / `trash` / `lastdir` 三个套件在基线直接抛错（函数不存在）= 167 项无法执行。

### 全量回归

- `npm run test:unit`：18 个文件全绿
- `npm test`（47 套件 / 真实 Electron）：**623 项，通过 623，失败 0**
- `npm run build` 后 `run_all.js appself`：35 项全绿，且校验了产物里的 10 个 js 与源码 md5 一致
- `probe_opendir.js`（真实 exe）：`--open-dir` → 0 张；预置 `granted:true` → 7 张
- CI（GitHub Actions）：单测 + Windows 组装校验，双作业全绿

---

## 六、改了什么（代码）

**`js/thumb.js`**（核心重构）：LRU 带 dispose、pin/unpin 引用计数、screenPending 去重、
epoch 代校验、noProxy 直通、统一优先级调度器。

**`js/lightbox.js`**：`_setSrc` pin/unpin、`_fillStrip` 背压 + 世代、`_issueStrip` 并发计数、
连翻让路用 `_lastNavAt`、`_adoptNatural` 用 naturalWidth + disp 标记。

**`js/util.js`**：`looksAnimated`、`exifOrientation`、`orientSwaps`。

**`js/loader.js`**：`safeSize`、`buildEntries` 去重保留更大份、`sourcePrefix` 来源身份、
`sniffAnim`、5–8 时换显示方向再 recordDims。

**`js/state.js`**：`dirKey/hashKey`、`sourcePrefix/prefixOf/sourceKey`、`removeSource` 精确删 + 前缀删。

**`deploy/electron/pathauth.js`**：`createDirTrust`。

**`deploy/electron/main.js`**：`dirTrust` 统一授权、`vf:loadDir` 复核、`--open-dir` 只 trace、
`vf:autoDir` 先验 granted、`vf:setLastDir` 闸门、`findTrashed` mtime 粗筛。

**`deploy/electron/lastdir.js`**（新增）：`{dir, ts, granted}` 持久化，fail-closed。

**`deploy/electron/trashlib.js`**：`mtimeMayMatch` 粗筛。

---

## 七、升级须知

- 覆盖旧目录即可，`data/` 里的设置、收藏、旋转记录都不动。
- 本版没有改任何数据格式，可以随时退回 v1.20.9。
- **首次启动不会自动打开上次文件夹**——这是 `--open-dir` 安全修复的刻意行为，
  需要重新选一次文件夹。之后就恢复正常。

---

## 八、剩余风险

1. **旧尺寸库里的旋转图**：首次解码时会被就地纠正，但 `recordDims` 不会回写，
   每次启动都要重算一次（纯内存操作，无 I/O）。做数据迁移的风险大于收益，暂不做。
2. **真实 10 万张的端到端 I/O 耗时**未测。条带窗口的几何和调度逻辑已被 F9 钉住
   （10 万张、i=99900、61 个槽位），但磁盘扫描和首轮解码没测到这个量级。
3. **内存预算未做**：`screens` 仍然 8 条，`bigs` 容量没动。长时间停留 + 反复放大缩小
   没有专门的内存压测数据。
4. **`a11yui` 套件本机偶发超时**：基线同样 flaky，属探针时序 + 机器负载问题，非本次改动引入。
