/* ============================================================
   「上次目录」记录的解析与序列化（纯逻辑，不 require electron）
   ------------------------------------------------------------
   记录长这样（userData/last-dir.json）：

     { "dir": "D:\\照片", "ts": 1762000000000, "granted": true }

   `granted` 是**授权来源**，不是"要不要记住"：

     true  —— 这个目录是用户在原生对话框里真的选过的（pickFolder 之后
              渲染层回写），所以下次启动可以恢复读盘授权（autoDir）。
     false / 缺省 —— 来源无法证明。历史上 `--open-dir <path>` 也能写这条记录，
              于是"随便谁启动一次 `Atrium.exe --open-dir C:\`"就能把整个盘
              洗成"用户选过的目录"，下次启动 autoDir 直接授予读盘权限。

   现在 `--open-dir` 不再写任何东西，并且**缺 `granted` 一律按未授权处理**
   （fail-closed）：老记录里可能已经被洗过，宁可让用户重选一次文件夹，
   也不要把一个来源不明的路径当成授权。
   ============================================================ */
'use strict';

/** 解析 last-dir.json 的原始文本 → { dir, granted } 或 null（没有/坏了） */
function parse(raw) {
  let j = null;
  try { j = JSON.parse(String(raw == null ? '' : raw)); } catch (e) { return null; }
  if (!j || typeof j !== 'object') return null;
  if (typeof j.dir !== 'string' || !j.dir) return null;
  /* 只认布尔 true：`"true"` / `1` / 其它真值都不算（避免以后被别的写入口误标） */
  return { dir: j.dir, granted: j.granted === true };
}

/** 序列化。dir 传 null/空 表示清除（记成 dir:null，parse 会返回 null）。 */
function serialize(dir, granted) {
  return JSON.stringify({
    dir: (typeof dir === 'string' && dir) ? dir : null,
    ts: Date.now(),
    granted: granted === true,
  });
}

module.exports = { parse, serialize };
