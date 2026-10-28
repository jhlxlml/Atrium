/* 发 v1.20.6 到 GitHub Releases：建 draft → 传资产 → 校验远端大小 → 转公开
 * ------------------------------------------------------------------
 * 为什么是这四步而不是一步到位：中途失败只会留下一个草稿，不会出现
 * "release 已公开但附件没上去"这种对下载者最难受的状态。
 *
 * 资产名必须 **ASCII**：GitHub 会把非 ASCII 字符替换成 `.`
 * （`Atrium_Electron版_v1.13.0.zip` → `Atrium_Electron._v1.13.0.zip`）。
 *
 * token 只从环境变量读，不进命令行参数（否则会留在 shell 历史里）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const REPO = 'jhlxlml/Atrium';
const VER = '1.20.6';
const TAG = 'v' + VER;
const NAME = 'Atrium v' + VER + ' · 切图不再先清空画面，也不再跟显示抢 CPU';
const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) { console.error('缺 GH_TOKEN'); process.exit(2); }

const ROOT = path.resolve(__dirname, '..', '..');
const ZIP = path.join(ROOT, 'Atrium_Electron版_v' + VER + '.zip');
const ASSET = 'Atrium_Electron_v' + VER + '_x64.zip';
const SHA = path.join(ROOT, 'deploy', 'dist-electron', ASSET + '.sha256');
const BODY = fs.readFileSync(path.join(ROOT, 'Atrium_v' + VER + '_更新说明.md'), 'utf8');

function api(method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = https.request({
      method, hostname: 'api.github.com', path: urlPath,
      headers: Object.assign({
        'User-Agent': 'atrium-release',
        Authorization: 'Bearer ' + TOKEN,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      }, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}, headers || {}),
    }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => {
        let j = null;
        try { j = s ? JSON.parse(s) : null; } catch (e) { /* 非 JSON */ }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(j);
        else reject(new Error(method + ' ' + urlPath + ' → ' + res.statusCode + ' ' + s.slice(0, 400)));
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/* `upload_url` 是个 URI 模板：`.../assets{?name,label}`。
   直接 new URL() 会把 `{?name,label}` 拆成 pathname 的尾巴 + search，
   拼出来的路径是坏的，GitHub 回 400 "Multipart form data required"（实测踩过）。 */
function baseUpload(u) {
  return String(u || '').replace(/\{.*\}$/, '');
}

function upload(urlStr, file, name) {
  return new Promise((resolve, reject) => {
    const buf = fs.readFileSync(file);
    const u = new URL(urlStr);
    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      path: u.pathname + u.search + '?name=' + encodeURIComponent(name),
      headers: {
        'User-Agent': 'atrium-release',
        Authorization: 'Bearer ' + TOKEN,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/octet-stream',
        'Content-Length': buf.length,
      },
    }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(s); } catch (e) { /* 忽略 */ }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(j);
        else reject(new Error('upload ' + name + ' → ' + res.statusCode + ' ' + s.slice(0, 400)));
      });
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

(async () => {
  for (const f of [ZIP, SHA]) {
    if (!fs.existsSync(f)) { console.error('缺文件: ' + f); process.exit(2); }
  }
  const zipSize = fs.statSync(ZIP).size;

  // 已经发过就别重来（幂等）
  try {
    const old = await api('GET', '/repos/' + REPO + '/releases/tags/' + TAG);
    if (old && old.id) {
      console.log('已存在 release ' + TAG + '（id=' + old.id + ', draft=' + old.draft + '）—— 退出');
      process.exit(0);
    }
  } catch (e) { /* 404 = 不存在，继续 */ }

  console.log('[1/4] 建草稿 …');
  const rel = await api('POST', '/repos/' + REPO + '/releases', {
    tag_name: TAG,
    target_commitish: 'main',
    name: NAME,
    body: BODY,
    draft: true,
    prerelease: false,
  });
  console.log('      id=' + rel.id + ' upload=' + rel.upload_url);

  console.log('[2/4] 传 ZIP（' + (zipSize / 1048576).toFixed(1) + ' MB）…');
  const a1 = await upload(baseUpload(rel.upload_url), ZIP, ASSET);
  console.log('      ' + a1.name + ' state=' + a1.state + ' size=' + a1.size);

  console.log('[3/4] 传 sha256 …');
  const a2 = await upload(baseUpload(rel.upload_url), SHA, ASSET + '.sha256');
  console.log('      ' + a2.name + ' size=' + a2.size);

  const chk = await api('GET', '/repos/' + REPO + '/releases/' + rel.id);
  const got = (chk.assets || []).find((x) => x.name === ASSET);
  if (!got || got.size !== zipSize || got.state !== 'uploaded') {
    throw new Error('远端资产校验失败: ' + JSON.stringify(got && { size: got.size, state: got.state }) + ' 本地 ' + zipSize);
  }
  console.log('      远端大小一致 ' + got.size + '，state=uploaded');

  console.log('[4/4] 转公开 …');
  const pub = await api('PATCH', '/repos/' + REPO + '/releases/' + rel.id, { draft: false });
  console.log('      已公开: ' + pub.html_url);
  console.log(JSON.stringify({ tag: TAG, id: pub.id, assets: (pub.assets || []).map((a) => a.name + ':' + a.size) }));
})().catch((e) => { console.error('✗ ' + e.message); process.exit(1); });
