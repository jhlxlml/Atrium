# Atrium · v1.21.1 更新说明

> 发布日期：2026-11-12
> 上一个版本：v1.21.0
> 交付形态：**仅 Electron 便携版**

---

## 一、这一版做了什么

一句话：**补上了 v1.21.0 遗留的三块验证——内存压测、两个大模块的测试、10 万张端到端；
过程中发现并加固了一处 Blob URL 引用计数的不严谨。**

这一版**没有用户可见的行为变化**。它是一轮"把自己上一版没做完的验证补完"的工作。

---

## 二、内存压测：新增探针，跑了 5 分钟 + 10 万张两个量级

v1.21.0 的说明里写着"内存预算未做"——这一版补上了。

新增 `deploy/electron-test/perf_lb_mem.js`：驱动真实 exe 做长时间浏览（每 2 秒翻一张、
每 30 秒开关一次灯箱），每 3 秒采样一次：

- `performance.memory.usedJSHeapSize`（渲染层堆内存）
- `Thumbs.urlStats()`（Blob URL 引用计数：pinned / deferred / thumbs / bigs / screens）
- 最后做一次"清空所有缓存"的收尾采样，检查引用计数是否归零

为此给 `Thumbs` 加了一个 `urlStats()` 诊断接口（只读，不影响运行时行为）。

### 7 张图 / 300 秒

| 指标 | 结果 |
|---|---|
| 堆内存 | 2.6 MB → 最高 2.7 MB → 最后 2.2 MB（**无增长**） |
| pinned | 全程 1（灯箱打开时），关闭瞬间降到 0 |
| thumbs / bigs | 稳定在 1 |
| screens | 2 → 7 后饱和（只有 7 张图，cap=8） |
| 清理后 | pinned=0，全部缓存归零 |

### 10 万张 / 120 秒

| 指标 | 结果 |
|---|---|
| 堆内存 | 54 MB（索引 10 万条 meta）→ GC 后 38 MB → 稳定在 38–40 MB |
| thumbs | 56 → 300（LRU cap=1800，远未满） |
| screens | 饱和在 8（cap=8） |
| screenDropped | 全程 0（代校验没丢弃过任何结果） |

**结论：堆内存没有持续增长趋势，LRU 容量控制生效，代校验工作正常。**

---

## 三、发现的一处引用计数不严谨（已加固）

第一次跑 10 万张压测时，`pinned` 从 1 增长到 4，清理后仍剩 3 个不归零。

追下去发现：`nav()` 不检查灯箱是否还开着。压测脚本每 30 秒关一次灯箱，
但翻页定时器仍在跑，于是走了这条链：

```
nav() → render() → _setSrc() → pinURL()
```

而 `close()` 在关闭时已经 `unpin` 了当时的 URL 并把 `_pinnedURL` 设为 `null`，
close 之后又被 `nav` pin 了一个新的，**没有人再 unpin 它**。

### 为什么真实使用中很难触发

我把所有 `nav()` 的调用方都查了一遍，**每一条都有保护**：

| 调用方 | 保护 |
|---|---|
| 键盘 `←` `→` `空格` | `_key()` 开头 `if (!this.openFlag) return` |
| 上一张/下一张按钮 | 按钮在灯箱内，关闭后点不到 |
| 滚轮 / 触摸滑动 | 事件挂在灯箱容器上 |
| 幻灯片定时器 | 回调里 `if (!this.openFlag) { this.stopPlay(); return; }` |
| `app.js` 的翻页入口 | 先判 `Lightbox.isOpen()` |

所以**这不是一个用户会碰到的泄漏**，而是两件事叠加的结果：
① `nav()` 作为公开方法没有自己的前置条件检查（契约不严谨）；
② 压测脚本的定时器不遵守这个隐含契约，把它暴露了出来。

### 加固

```js
nav(delta) {
  if (!this.openFlag) return;   // 灯箱已关闭时不翻页
  ...
}
```

成本一行，收益是**以后任何人新增调用方都不用再记得"要先判断灯箱开着"**。
修完之后同一套压测：

| | 修前 | 修后 |
|---|---|---|
| pinned（10 万张/120s） | 1→4，清理后剩 3 | 全程 1，清理后 0 |
| pinned（7 张/300s） | 1，清理后 0 | 1，清理后 0（无退化） |

---

## 四、补了两个大模块的测试

v1.21.0 的说明里把 `app.js` / `main.js` / `grid.js` 列为"无测试的技术债"。
这一版补了其中两个：

### `test/main-ipc.test.js`（22 项）

`deploy/electron/main.js` 有 2400+ 行、30 个 IPC 通道，纯 Node 里不可能完整装配
（依赖 Electron 的 `app` / `BrowserWindow` / `ipcMain` / `shell`）。
但"安全闸门有没有接对线"可以**读源码文本**来锁住：

- `vf:loadDir` 必须先查 `dirTrust.has` 再 `realpath`，且不再自行 `picAuth.add`
- `vf:autoDir` 必须先判 `rec.granted === true` 才 `grantDir`
- `vf:setLastDir` 必须先查 `dirTrust.has` 才 `writeLast`
- `--open-dir` 不能出现 `writeLast` / `grantDir` 调用
- `vf:readHead` / `vf:deleteFile` / `vf:deleteFiles` 必须先 `picAuth.has` 再 `picAllowed`
- `vf:openExternal` 必须先走 `isAllowedExternal` 白名单
- `isTrustedSender` 包装了 `ipcMain.handle` / `ipcMain.on`
- `grantDir` 必须对字面路径和 realpath 双登记
- `vf://pic` 协议必须复核 `picAuth.has` + `picAllowed`

实现上有个细节：第一版用全局 `indexOf` 比较先后顺序，结果被 `grantDir()` 函数体里
那句 `fs.realpath(dir)` 抢先匹配（它在文件里出现得更早），误报成"顺序错了"。
改成先用 `handlerBlock(name)` 把单个 handler 的代码块切出来，在块内比较，才准确。

**反向实验**：把 `main.js` 回退到基线 `ba0bb89`，这套断言 **16 / 22 变红**
（那些检查当时都不存在）。

### `test/grid-layout.test.js`（569 项）

`js/grid.js` 的 `mount` / `layout` 依赖大量 DOM，但三个布局函数本身是纯数学。
用测试框架的浏览器 IIFE 装载器把 `util.js` + `state.js` + `masonry.js` + `grid.js`
装起来，配最小 DOM 桩（`CSS.supports` / `getComputedStyle` / `document.getElementById`），
直接调 `_layoutCells` / `_layoutSingle` / `_layoutJustified`。

锁住的坐标不变量：

| 函数 | 不变量 |
|---|---|
| `_layoutCells`（小图密排） | 等边方格、格宽一致、列数 = `floor((W+gap)/(want+gap))`、无碎边 |
| `_layoutSingle`（单列整屏） | 每张等宽等高、`y = i × slotH`、`totalH = N × slotH`、左右居中 |
| `_layoutJustified`（行内自适应） | 行内不重叠、行间不重叠、非末行行高一致、末行允许留白 |

边界用例：空目录（positions=0、totalH=0）、1 张图、500 张图在 3840 宽下 50 列。

**说明**：这套测试在基线上也是全绿的——因为 v1.21.0 没有改 `grid.js` 的布局函数。
它的价值是**回归保护**：以后再动布局，坐标算错了会立刻变红，而不是等用户发现
"滚到某处有图不显示"。

---

## 五、10 万张端到端 I/O

v1.21.0 的说明里写着"真实 10 万张的端到端 I/O 耗时未测"——这一版测了。

生成了 10 万张 160×120 的 PNG（97.1 MB），跑完整探针：

- 索引 10 万条后堆内存 54 MB，一次 GC 后降到 38 MB 并稳定
- 条带窗口（±30）在 10 万张目录工作正常，没有"回头补前面"的请求
- 缩略图 LRU（cap=1800）在 300 左右，远未触及上限

**仍未测的**：10 万张图的**首轮全量缩略图解码**耗时（那是用户真的把滚动条从头拖到尾
才会遇到的场景，本轮只测了"打开 + 翻页"）。这一点保留在风险清单里。

---

## 六、测试总览

| | v1.21.0 | v1.21.1 |
|---|---|---|
| 单测文件 | 18 | **20** |
| 单测项数 | 419 | **1010** |
| `npm test`（真实 Electron） | 623 / 623 | 623 / 623（未受影响） |

新增两个文件的项数构成：`main-ipc` 22 + `grid-layout` 569 = 591，
加上原有的 419 = **1010**。

---

## 七、升级须知

- 覆盖旧目录即可，`data/` 里的设置、收藏、旋转记录都不动。
- 本版没有改任何数据格式，可以随时退回 v1.21.0。
- v1.21.0 的"首次启动不自动打开上次文件夹"仍然生效（那是 `--open-dir` 安全修复的
  刻意行为）。v1.21.0 之后已经重选过文件夹的用户，本版不受影响。

---

## 八、剩余风险

1. **旧尺寸库里的旋转图**：首次解码时会被就地纠正，但 `recordDims` 不回写，
   每次启动重算一次（纯内存，无 I/O）。迁移风险大于收益，暂不做。
2. **10 万张的全量缩略图解码耗时**未测（只测了打开 + 翻页）。
3. **内存预算上限**：`screens` 仍是 8 条、`bigs` 220 条、`thumbs` 1800 条。
   压测显示这些容量在 10 万张目录下工作正常（远未触及上限），但没有针对
   "超长会话（数小时）+ 反复放大缩小"做压力测试。
4. **`js/app.js`（2767 行）仍无直接测试**：它是最后一个没有测试的大模块，
   包含 30+ IPC 接线、初始化流程、全局协调。建议下一轮补。
5. **`a11yui` 套件本机偶发超时**：基线同样 flaky，属探针时序 + 机器负载问题。
