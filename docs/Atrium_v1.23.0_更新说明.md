# Atrium · v1.23.0 更新说明

> 发布日期：2026-11-26
> 上一个版本：v1.22.0
> 交付形态：**仅 Electron 便携版**

---

## 一、核心新功能

1. **多选批量收藏与批量旋转**
   - 底部浮动选择条 `#selBar` 新增 **收藏所选 / 取消收藏（`#sbFav`）** 与 **旋转 90°（`#sbRot`）**。
   - `State.setFavs(ids, on)` 与 `State.rotateMany(metas, dir)` 采用单次写盘与批量事件广播，大幅减少大批量操作时的 IO 次数；配合「导出所选」可一键批量摆正并烘焙导出。
2. **灯箱双图对比（2-up 选片对比）**
   - 灯箱操作栏新增 **双图对比（快捷键 `C`）**：左半屏固定参考图并展示文件名角标，右半屏保留完整切图、缩放、拖拽、旋转、收藏与删除能力；支持 `X` 键或点击「交换」按钮互换左右照片。
   - 缩放与平移时左右两侧按各自适应倍率同步联动，便于细节对比选片。
3. **相机 RAW 内嵌 JPEG 预览与 EXIF 读取（零依赖）**
   - 新增 [rawlib.js](file:///c:/Users/qwert/Documents/AI/Atrium/deploy/electron/rawlib.js)，支持 `DNG / CR2 / NEF / ARW / RAF / ORF / RW2 / PEF / SRW` 九种相机 RAW 扩展名，通过主进程 `vf://pic` 按需切片提取最大有效内嵌 JPEG 预览图。
   - [exif.js](file:///c:/Users/qwert/Documents/AI/Atrium/js/exif.js) 同步开放上述 TIFF-based RAW 扩展名与魔数支持，直接采集拍摄时间与相机参数用于排序及信息面板展示。
4. **画面方向筛选**
   - 顶栏新增「全部方向 / 横图 / 竖图 / 方图」筛选器（`#orientFilter`），自动结合已记住的旋转角判定当前横竖构图，并可随「清除过滤条件」一键重置。

---

## 二、问题修复与稳定性

1. **右键菜单命令与「在资源管理器中显示」修复**：修复 `gridContext()` / `lightboxContext()` 在 `runCtx(cmd)` 执行前提前清零 `ctxTarget` 的缺陷，并在 `vf:showInFolder` 中对 Windows 路径做反斜杠规范化；在 [main-ipc.test.js](file:///c:/Users/qwert/Documents/AI/Atrium/test/main-ipc.test.js) 中补齐回归锁。
2. **窄屏响应式布局优化**：收紧 `1080px` / `900px` / `1180px` 断点下的选择条提示、顶栏滑杆与灯箱操作栏间距，修复窄窗下 `#brandEye` 裁切与长文件名折行问题。

---

## 三、验证状态

- **单元测试（`npm run test:unit`）**：全部 22 个测试套件通过。
- **源码门禁（`secboot` / `frozen` / `ipcchain` / `typescale`）**：67 / 67 项通过。
- **构建与打包校验**：`npm run build`、`pack` 与 `verify:zip` / `packlist` / `buildsafe` 全部通过。
