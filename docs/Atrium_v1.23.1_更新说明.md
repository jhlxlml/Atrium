# Atrium · v1.23.1 更新说明

> 发布日期：2026-11-26
> 上一个版本：v1.23.0
> 交付形态：**仅 Electron 便携版**

---

## 一、新增与优化

1. **拖拽入口（无磁盘路径 `File`）RAW 预览支持**
   - [util.js](file:///c:/Users/qwert/Documents/AI/Atrium/js/util.js) 新增 `Util.isRawExt` 与 `Util.extractRawJpegBlob(file)`，通过 `file.slice()` 按需解析 Fujifilm `RAF` 头部与 TIFF-IFD / `SubIFDs` 内嵌 JPEG 预览段；[thumb.js](file:///c:/Users/qwert/Documents/AI/Atrium/js/thumb.js) 对拖拽进来的 RAW 文件自动提取并复用到网格与灯箱。
2. **文件类型筛选**
   - 顶栏新增「全部类型 / 仅 RAW / 仅动图」筛选器（`#kindFilter`），支持与搜索词、只看收藏、画面方向叠加过滤，并在非默认态时呈现 `.is-on` 强调色高亮；同步收紧 `900px` / `820px` 窄窗顶栏间距。
3. **灯箱双图对比（2-up）打磨与回归锁**
   - 左侧参考角标 `.lb-cmp-badge` 新增 **收藏参考图（`#lbCmpFav`）**、**联动 / 独立缩放切换（`#lbCmpSync` / 快捷键 `S`）** 与 **退出对比（`#lbCmpClose`）**。
   - 修复同时开启双图对比与右侧图片信息面板（`with-info`）时的舞台对称对齐；在 `lbui` 中补齐双图对比几何、联动缩放、交换与关闭的回归断言。
4. **UI/UX 细节一致性打磨**
   - 批量旋转 `#sbRot` 支持按住 `Shift` 点击逆时针旋转 90°；`#sbNone` 补充 `(Esc)` 提示；空状态引导页同步列出 HEIC 与相机 RAW 支持；按「拍摄时间」排序且后台采集 EXIF 时在 `#footNote` 展示轻量过渡提示。
5. **检查更新直链与 SHA-256 展示**
   - [updatelib.js](file:///c:/Users/qwert/Documents/AI/Atrium/deploy/electron/updatelib.js) 与 `vf:checkUpdate` 经由 `isAllowedExternal()` 白名单校验提取便携包下载地址与 SHA-256 摘要，在「设置 → 关于 → 检查更新」就地展示「下载便携包」链接与哈希摘要。

---

## 二、验证状态

- **单元测试（`npm run test:unit`）**：全部 22 个测试套件通过。
- **源码门禁（`secboot` / `frozen` / `ipcchain` / `typescale`）**：67 / 67 项通过。
- **构建与打包校验**：`npm run build`、`pack` 与 `verify:zip` / `packlist` / `buildsafe` 全部通过。
