/* ============================================================
   Atrium · releaselib.js （发布判定：纯函数，无 I/O）
   ------------------------------------------------------------
   从 upload_release.js 里抽出来的唯一一段值得单独测的逻辑：
   「远端那个资产，到底是不是本地这一份？」

   为什么要有它（v1.20.3 修的一个自证循环）：
     原来的判定是 —— 把远端 `.sha256` 资产读回来，和本地摘要比。
     可那个 `.sha256` 文件是**我们自己写上去的**：拿它跟本地摘要比，
     只能证明"那几十字节的文本与本地一致"，证明不了"那个 112 MB 的 ZIP
     传对了"。上传被截断、串包、传了另一份构建产物，这个比较照样相等。
     真正独立的证据是 GitHub 自己算的 `asset.digest`（服务器收到的字节的
     摘要），它不经过我们任何一行代码。
   ============================================================ */
'use strict';

/**
 * 解析 GitHub 资产的 digest 字段（形如 `sha256:9f86d0…`，64 位十六进制）。
 * 算法不是 sha256、长度不对、字段缺失一律返回 '' —— 宁可不判，也不误判。
 * @param {object} asset GitHub release asset 对象
 * @returns {string} 小写十六进制摘要，解析不了则为 ''
 */
function parseDigest(asset) {
  const d = asset && asset.digest;
  if (typeof d !== 'string') return '';
  const m = /^sha256:([0-9a-f]{64})$/i.exec(d.trim());
  return m ? m[1].toLowerCase() : '';
}

/**
 * 判断是否需要重新上传。
 * 依据优先级：服务器侧 digest > 我们自己上传的 .sha256 回读（降级）。
 * @param {object} o
 *   o.localHex  本地 ZIP 的 sha256（小写十六进制）
 *   o.localSize 本地 ZIP 字节数
 *   o.asset     远端同名资产（可能为 null）
 *   o.shaText   远端 .sha256 资产的文本内容（没有就传 ''）
 * @returns {{needUpload:boolean, reason:string, via:'digest'|'sha256-file'|'none'}}
 */
function decide(o) {
  const localHex = String((o && o.localHex) || '').toLowerCase();
  const localSize = (o && o.localSize) || 0;
  const asset = (o && o.asset) || null;
  if (!asset) return { needUpload: true, reason: '资产还不存在', via: 'none' };

  const fromDigest = parseDigest(asset);
  if (fromDigest) {
    if (fromDigest === localHex && asset.size === localSize) {
      return { needUpload: false, reason: '', via: 'digest' };
    }
    const why = fromDigest !== localHex
      ? '内容不一致（远端 ' + fromDigest.slice(0, 16) + '… / 本地 ' + localHex.slice(0, 16) + '…）'
      : '大小不一致（远端 ' + asset.size + ' / 本地 ' + localSize + '）';
    return { needUpload: true, reason: why, via: 'digest' };
  }

  /* 降级路径：服务端没给 digest（老版本 API / GHES）。这条路只能证明
     ".sha256 文本与本地一致"，证明不了 ZIP 本身 —— 调用方会把 via 打出来，
     让人知道这次核对是打折的。 */
  const fromSha = (String((o && o.shaText) || '').split(/\s+/)[0] || '').toLowerCase();
  if (fromSha && fromSha === localHex) {
    return { needUpload: false, reason: '', via: 'sha256-file' };
  }
  return {
    needUpload: true,
    reason: '内容不一致或无法核对（远端 ' + (fromSha.slice(0, 16) || '无法解析') + '… / 本地 '
      + localHex.slice(0, 16) + '…）',
    via: 'sha256-file',
  };
}

module.exports = { parseDigest: parseDigest, decide: decide };
