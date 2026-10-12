# Atrium · v1.14.0 更新说明

> 发布日期：2026-10-12
> 上一个版本：v1.13.0
> 交付形态：**仅 Electron 便携版**

---

## 一、这版做了什么

一句话：**把"数据放哪"和"版本从哪来"这两件原本悬在系统里的事，收回到了应用自己手里。**

| 项目 | 之前 | 现在 |
|---|---|---|
| **应用数据目录** | `%APPDATA%\Atrium`（跟着系统用户走，换机就丢） | **应用本体目录下的 `data/`**（便携：拷走文件夹 = 带走全部配置） |
| **关于面板** | 版本号 + 隐私说明 + 数据位置 | 再加 **GitHub 仓库链接**（含 GPL-3.0 许可说明）与**就地检查更新**入口 |
| **更新检测** | 无 | 新增，**默认关闭**；开启后启动时静默检查，也可随时手动点 |
| **外部链接** | 无（页内 `<a>` 点了没反应） | 走主进程 **URL 白名单**放行，只认官方仓库 |

三件事都围绕同一个取舍：**能不出网就不出网，非要出网就出到唯一一个明确的地方。**

---

## 二、数据目录便携化：为什么必须整体改 `userData`

这一条最容易想简单。直觉是"把 `trash-log.json` / `last-dir.json` 挪个位置就行"——**错**。

Electron 的 `userData` 目录下**同时**承载三样东西：

| 谁在用 | 是什么 |
|---|---|
| 应用自己的 JSON | `trash-log.json`（回收站日志）、`last-dir.json`（上次目录） |
| Chromium 的 **Local Storage** | 渲染层的 `localStorage` —— 设置、收藏、旋转记录全在这里 |
| **IndexedDB** | `viewfinder-db` —— 尺寸库与缩略图缓存 |

也就是说，**只搬自有文件，设置和收藏会留在原地**。正确做法是整体改 `userData` 路径，让上面三样一起搬家。

```js
// deploy/electron/main.js
if (process.env.VF_USERDATA) {
  app.setPath('userData', process.env.VF_USERDATA);   // ① 优先级最高
} else {
  const base = app.isPackaged
    ? path.dirname(process.execPath)                  // 打包版：exe 所在目录
    : path.resolve(__dirname, '..', '..');            // 开发版：仓库根
  const dataDir = path.join(base, 'data');
  fsx.mkdirSync(dataDir, { recursive: true });
  app.setPath('userData', dataDir);                   // ② 便携目录
}
```

三个关键点：

1. **`app.setPath('userData', ...)` 必须在 app ready 之前调用**，晚了不生效。
2. **`VF_USERDATA` 环境变量优先级最高**。探针与 `--selftest` 靠它把数据指到临时目录 —— 删了这条，**回归会去污染你的真实数据**。所以它被写进了 `frozen` 套件的源级断言。
3. 用 `app.isPackaged` 区分打包 / 开发；`process.execPath` 是纯 Node 属性，**ready 之前必定可用**。

**关于旧数据**：这一版**不做迁移**，从空开始。原因是旧目录里混着 Chromium 的存储格式（Local Storage / IndexedDB 不是随便拷文件就能用的），硬迁风险大于收益。你要的正是"干净便携"，那就干净。

---

## 三、更新检测：一个"默认关闭"的功能

这是全应用**唯一会联网**的功能，所以它必须守两条规矩：

- **默认关闭**，你主动打开才生效；
- **打开后也不打扰你** —— 启动时静默检查，只有真发现新版本才提示；没更新、连不上，都不弹。

三档结果都会被如实区分，**"检查失败"绝不会被说成"已是最新"**：

| 结果 | 你会看到 |
|---|---|
| 有新版本 | "发现新版本 x.y.z" + 「查看」外链 |
| 已是最新 | "已是最新版本" |
| 连不上 / 超时 | "检查失败（网络 / 超时）" —— **不冒充成功** |

实现上落在新增的纯逻辑模块 `deploy/electron/updatelib.js`（90 行，**不依赖 electron**）：

- `parseVer` / `isNewer` —— 版本比较，**数值比**而非字符串比（`1.13.10 > 1.13.9`，字符串比会判反）；
- `latestFromRelease` —— 从 GitHub Releases API 的响应里取 `tag_name` 与 `html_url`，**响应不合规就返回 null**（宁可漏报，不误报）；
- `isAllowedExternal` —— 见下一节。

主进程侧新增两条 IPC：`vf:checkUpdate`（`net.fetch` 打 GitHub 公开接口，8 秒 `AbortController` 超时）与 `vf:openExternal`。渲染侧在 `native.js` 里包了适配器，并带 **`canUpdate` 能力探测** —— 环境不支持时，「关于」面板里那行开关**根本不出现**，而不是显示一个点了没用的开关。

设置项 `updateCheck` 走的是完整的"**五处登记**"（`defaults()` / `loadSettings()` 校验 / `applySetting()` case / `init()` 启动重放 / `ALL_KEYS` + 面板行定义），少一处就会**静默失效**。

---

## 四、`openExternal` 白名单：一个"没有界面迹象"的安全面

`shell.openExternal(url)` 如果不加限制，就等于给渲染层一个**"打开任意 URL / 执行本地文件"**的能力。而且它出问题时**界面上什么都看不出来** —— 没有报错、没有异常，只是"打开了一个不该打开的东西"。这是典型的安全倒退。

所以放行规则收紧到只认官方仓库：

```js
function isAllowedExternal(url) {
  if (typeof url !== 'string' || !url) return false;
  let u;
  try { u = new URL(url); } catch (e) { return false; }
  if (u.protocol !== 'https:') return false;              // 必须 https
  if (u.hostname !== 'github.com') return false;          // 必须 github.com
  if (u.port && u.port !== '443') return false;           // 必须默认端口
  return u.pathname === '/jhlxlml/Atrium'
      || u.pathname.indexOf('/jhlxlml/Atrium/') === 0;    // 必须是本仓库（含子路径）
}
```

这条判据**光测"官方链接能过"等于没测**（恒真的门禁）。所以它配了 **21 条反向用例**，全在 `test/updatelib.test.js` 里，必须全部被拒：

`http://` 明文 · `file://` · `javascript:` · `vbs:` · 其它仓库 · 同前缀后缀伪装 · **子域名伪装**（`github.com.evil.com`）· **userinfo 伪装**（`github.com@evil.com`）· `raw.githubusercontent.com` · `api.github.com` · **非默认端口**（`github.com:8443`）· 路径穿越 · owner 大小写不一致 …

> **反向实验纪律**：我先把主机名判定放宽成 `indexOf`（想看看"差不多"会怎样），套件**当场变红**；改回严格比较才转绿。验证器本身也被验过一遍。

**页内外链的坑**：主窗口的 `will-navigate` 会 `preventDefault` 一切非 `vf://app` 的导航。所以页内 `<a href="https://…">` **光写上去是"点了没反应"** —— 必须先 `preventDefault()`，再把 URL 转交给白名单 IPC。

---

## 五、关于面板与 `modal` 的 `onMount` 钩子

「设置 → 关于」这次加了两段：

- **数据放在哪** —— 明说"应用目录下的 `data/` 子目录"，并补上便携含义；
- **开源与更新** —— 仓库链接（`github.com/jhlxlml/Atrium`）、GPL-3.0 许可说明、一个「检查更新」按钮。

按钮要"就地显示结果，不另开弹层"，这需要一个**弹层插入文档树之后**的回调 —— 此时 `querySelector` 才找得到元素。为此给 `App.modal()` 加了一个 `onMount(bodyEl, close)` 钩子，在 `document.body.appendChild(wrap)` 与 `requestAnimationFrame` 之后触发：

```js
if (typeof o.onMount === 'function') {
  try { o.onMount(wrap.querySelector('.vf-modal-body'), () => done(false)); }
  catch (err) { console.error('[modal] onMount 回调出错：', err); }
}
```

「检查更新」按钮点下去：结果文本就地更新；发现新版本时补一个「查看」外链（同样走白名单 IPC）。

---

## 六、这版踩到的坑

### 坑 1：`parseVer('V2.0.1')` 返回 `null`

版本号正则写的是 `/^v?(\d+)\.(\d+)\.(\d+)/`，**只认小写 `v`**。而 GitHub 的 tag 大小写随人写，大写 `V` 就会解析失败 → 直接导致"永远显示已是最新"（漏报）。

修法：加 `i` 标志 → `/^v?(\d+)\.(\d+)\.(\d+)/i`。

### 坑 2：`package-lock.json` 全局替换把依赖许可也改了

升 GPL 时我图省事对 `package-lock.json` 做了全局替换，把 `"license": "MIT"` 全换成 GPL —— 结果**改掉了 65 处依赖的许可**（electron 等仍是 MIT）。

修法：`git checkout --` 恢复，改用精确编辑**只改顶层两处**（`version` ×2 + 顶层 `license`），改完 `grep -c '"license": "MIT"'` 确认仍是 64 处。

### 坑 3：`settings` 套件"关于面板数据位置"假失败

断言读的是探针返回的 `aboutText`，而它**只截前 240 字**，读不到新加的"数据放在哪"段。

修法：探针新增 `aboutTextAll`（全文只折叠空白、不截断），断言改读它。**"断言失败"未必是功能坏了，也可能是取证方式不够**。

### 坑 4：全量回归 2 个探针超时 —— 元凶是我自己

`center` / `zoom` 两个探针报 `ETIMEDOUT`（240 秒）。单跑这两个全绿（15 项）。

原因是**并行负载**：我在跑全量的同时还在做构建 / 测量等重活，把机器压满了。干净重跑 → **29 套件 / 355 项 / 0 失败 / 175.2 秒**（该轮尚未打包，`zip` 套件的 2 条「交付 ZIP 复验」断言未参与；打包后复跑为 **357 项 / 191.5 秒**）。

**教训：跑回归时别在同一台机器上干重活。**

---

## 七、验证

| 层次 | 结果 |
|---|---|
| 全量回归 | **29 套件 / 357 项断言 / 全部通过**（191.5 秒；含交付 ZIP 就位时的 2 条条件断言） |
| 快跑 | **12 套件 / 54 项 / 7.5 秒**（含需要 electron 的 `tf`） |
| 更新逻辑（新增套件 `update`） | **65 条断言**：版本比较（含 `1.13.10 > 1.13.9` 数值比）+ **URL 白名单 21 条反向用例** |
| 设置面板（`settings` 套件） | 新增「检查更新开关就位且默认关闭」「关于面板开源与更新段」「仓库链接」「发现新版本渲染」「查看外链走白名单 IPC」等断言 |
| 源级不变量（`frozen` 套件） | 新增两条：`VF_USERDATA` 优先级最高、数据目录指向「应用本体目录/data」 |
| 反向实验 | 把 URL 主机名判定放宽成 `indexOf` → 套件**当场变红**；改回严格比较转绿 |
| 纯函数细分断言 | 合计 **872**（transform 36 · header 26 · frame 505 · a11y 77 · masonry 87 · desktop 76 · **updatelib 65**） |

---

## 八、交付物

**Atrium_Electron版_v1.14.0.zip** —— 解压后双击 **`Atrium.cmd`**（不是 exe）。

- 体积 **118,004,192 字节（约 112.5 MB）**，包内 **106 个条目**；
- 独立校验器复验：**CRC 全部正确（106/106）**，并与 7-Zip 第三方复验交叉确认（无任何 `CRC Failed`）；
- 包内 15 个 JS 模块 + 6 个主进程文件 + 3 个 CSS + `index.html` 与源码 **MD5 逐一对齐**。

> **数据在哪**：解压目录下会自动出现一个 `data/`（设置 / 收藏 / 旋转记录 / 缩略图缓存）。
> 它是**便携**的 —— 拷走整个文件夹就等于带走全部配置。想清空就整个删掉（或走「设置 → 数据 → 清除缓存」）。

> **升级注意**：本版**不迁移** `%APPDATA%\Atrium` 的旧数据，首次启动是空配置。这是刻意的 —— 你要的是干净便携。

---

## 九、这版之后

- **更新检测目前只读版本号，不下载、不自动安装。** 这是有意的：一个"零依赖、纯本地"的应用不该自带一个静默下载器。要升级就去 Releases 拿新 ZIP。
- **Windows 以外仍无包。** 与 v1.13.0 相同，托盘 / 任务栏 / 跳转列表都是 Windows 原生能力。
- 无障碍还有两块没做：多选状态的键盘操作、幻灯片播报的节制策略。

按现状，下一步仍建议优先选**用户真正会感知到的**功能，候选不变：瀑布流自定义列数、相框吸附预览线 + 窗口几何记忆、EXIF 检索。
