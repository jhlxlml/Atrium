#!/usr/bin/env node
/* ============================================================
   Atrium · 发布到 GitHub Releases（手工工具，不属于回归套件）
   ------------------------------------------------------------
   用法：
     GH_TOKEN=<token> node deploy/release/upload_release.js
     GH_TOKEN=<token> node deploy/release/upload_release.js --dry

   为什么 token 只从环境变量读：不接受命令行参数，避免它落进 shell 历史
   与进程列表。需要 repo 权限（创建 release + 上传资产）。

   流程刻意是「建 draft → 上传资产 → 校验资产 → 转为公开」：
   中途失败只会留下一个草稿（对外不可见），**不会**出现
   "release 已公开但附件没传上去"这种半成品 —— 那个状态对下载者最难受。

   幂等：若该 tag 已有 release，直接复用它（已存在同名资产则跳过上传）。
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..', '..');
const DRY = process.argv.includes('--dry');
const REPO = 'jhlxlml/Atrium';
const TOKEN = process.env.GH_TOKEN || '';
const API = 'https://api.github.com';

const VER = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const TAG = 'v' + VER;
const ZIP = path.join(ROOT, 'Atrium_Electron版_v' + VER + '.zip');
const NOTES = path.join(ROOT, 'Atrium_v' + VER + '_更新说明.md');

const UA = { 'User-Agent': 'atrium-release-uploader', 'Accept': 'application/vnd.github+json' };
const auth = () => Object.assign({ Authorization: 'Bearer ' + TOKEN }, UA);
const mb = (b) => (b / 1048576).toFixed(1) + ' MB';

/** 调 JSON 接口；非 2xx 直接抛，并把 GitHub 的 message 带出来 */
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: Object.assign(auth(), body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* 非 JSON */ }
  if (!res.ok) {
    const msg = (json && (json.message || json.error)) || text.slice(0, 300);
    throw new Error(method + ' ' + url + ' -> ' + res.status + ' ' + msg);
  }
  return json;
}

/** 流式上传资产（112 MB，不能整个读进内存） */
function uploadAsset(uploadUrl, file, name) {
  const size = fs.statSync(file).size;
  const u = new URL(uploadUrl + '?name=' + encodeURIComponent(name));
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: Object.assign(auth(), {
        'Content-Type': 'application/zip',
        'Content-Length': size,
      }),
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(b));
        else reject(new Error('上传失败 ' + res.statusCode + ' ' + b.slice(0, 300)));
      });
    });
    req.on('error', reject);
    const rs = fs.createReadStream(file);
    rs.on('error', reject);
    rs.pipe(req);
  });
}

(async function main() {
  /* ---------- 前置检查（在发任何请求之前全部做完） ---------- */
  if (!TOKEN) throw new Error('缺少 GH_TOKEN 环境变量（需要 repo 权限的 token）');
  if (!fs.existsSync(ZIP)) throw new Error('找不到交付 ZIP：' + ZIP + '\n先跑 npm run pack');
  if (!fs.existsSync(NOTES)) throw new Error('找不到更新说明：' + NOTES);

  const zipSize = fs.statSync(ZIP).size;
  const zipName = path.basename(ZIP);
  const body = fs.readFileSync(NOTES, 'utf8');

  console.log('仓库     : ' + REPO);
  console.log('tag      : ' + TAG);
  console.log('资产     : ' + zipName + '  (' + mb(zipSize) + ')');
  console.log('发布说明 : ' + path.basename(NOTES) + '  (' + body.length + ' 字符)');

  if (DRY) { console.log('\n[dry] 以上为将要执行的内容，未发送任何请求。'); return; }

  /* ---------- 1. 复用或新建 draft ---------- */
  let rel = null;
  try {
    rel = await api('GET', API + '/repos/' + REPO + '/releases/tags/' + TAG);
    console.log('\n· 该 tag 已有 release（id=' + rel.id + '），复用它');
  } catch (e) {
    if (!/-> 404 /.test(e.message)) throw e;
    rel = await api('POST', API + '/repos/' + REPO + '/releases', {
      tag_name: TAG,
      name: 'Atrium ' + TAG,
      body: body,
      draft: true,          // 先草稿：资产传完再公开
      prerelease: false,
    });
    console.log('\n· 已创建 draft release（id=' + rel.id + '）');
  }

  /* ---------- 2. 上传资产（已存在则跳过） ---------- */
  const existing = await api('GET', API + '/repos/' + REPO + '/releases/' + rel.id + '/assets');
  if (existing.some((a) => a.name === zipName)) {
    console.log('· 资产已存在，跳过上传：' + zipName);
  } else {
    process.stdout.write('· 上传中（' + mb(zipSize) + '）… ');
    const t0 = Date.now();
    const asset = await uploadAsset(rel.upload_url.replace('{?name,label}', ''), ZIP, zipName);
    console.log('完成，用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    console.log('  → ' + asset.browser_download_url);

    /* ---------- 3. 校验：大小必须一致 ---------- */
    if (asset.size !== zipSize) {
      throw new Error('上传后大小不一致！本地 ' + zipSize + ' / 远端 ' + asset.size + '（release 仍为草稿，请重试）');
    }
    console.log('  → 大小校验通过：' + mb(asset.size));
  }

  /* ---------- 4. 转为公开 ---------- */
  if (rel.draft) {
    rel = await api('PATCH', API + '/repos/' + REPO + '/releases/' + rel.id, { draft: false });
    console.log('\n· 已发布（draft=false）');
  }
  console.log('\n✓ ' + rel.html_url);
})().catch((e) => {
  console.error('\n✗ ' + e.message);
  process.exit(1);
});
