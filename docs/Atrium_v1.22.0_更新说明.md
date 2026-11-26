# Atrium · v1.22.0 更新说明

> 发布日期：2026-11-26
> 上一个版本：v1.21.1
> 交付形态：**仅 Electron 便携版**

---

## 一、核心改进

1. **灯箱切图流畅度与双缓冲防闪烁**：
   - 新增底层 `holdImg` 双缓冲与 URL 引用钉住（`pinURL` / `unpinURL`），切图时保留上一帧直至新图完成解码与居中计算后再同步显形，消除黑闪与偏位跳变。
   - 拆分用户导航 `epoch` 与后台 `prefetchEpoch`，支持 `promote()` 任务提权与 `screenInflight()` 复用，避免预取任务阻塞当前切图。
   - 屏幕代缓存扩容（`screens` LRU 上限 `16 → 32`）并新增 `warmImgs` 预热池（`8` 项），支持按浏览方向（`_navDir`）进行 `+1 / -1 / +2` 预取；`<= 16MB` 本地静态/动图走内存 `blob:` 缓存，透明大图优先采用 `image/webp`（`q=0.88`，失败回退 PNG），`<= 4MP` 且长边 `<= 2560` 的图片跳过慢速重编码。
   - `Native.url()` 附加 `?v=size_mtime` 版本参数，主进程 `vf://` 协议携带 `Cache-Control: private, max-age=120`；移除灯箱控件多层重 `backdrop-filter` 模糊，降低合成开销。
2. **全屏与交互体验修复**：
   - 修复鼠标停留在灯箱控件按钮区域时仍会触发自动隐藏的问题（`_isOverControls()`）。
   - 修复全屏变化时的视口同步适配与权限处理；优化加载转圈延迟策略（命中缓存延后 250ms，未命中 80ms）。
   - 网格视图新增键盘范围多选与 `aria-pressed` 支持，并排除 `.tile-fav` / `.tile-chk` 子按钮误触发。
3. **EXIF 持久化与稳定性**：
   - 新增 EXIF 信息缓存持久化（`EXIF_PREFIX`）与回归单测；修复拖拽入口、灯箱连翻判定起点（`open()` 后重置 `_navAt`）及全套回归验证。

---

## 二、验证状态

- **单元测试（`npm run test:unit`）**：21 个测试套件全部通过。
- **源码门禁（`secboot` / `frozen` / `ipcchain` / `typescale`）**：67 / 67 项通过。
- **构建与打包校验**：`npm run build`、`pack` 与 `verify:zip` / `packlist` 全部通过。
