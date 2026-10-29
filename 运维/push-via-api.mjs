/**
 * 通过 GitHub REST API 推送代码（替代 git push）。
 *
 * 背景：本机所在网络可访问 api.github.com，但 github.com:443 被重置/超时，
 * 因此 `git push https://github.com/...` 始终失败（经实测为 21 秒超时）。
 * GitHub 的 Git Data API（blobs → tree → commit → ref）走 api.github.com，连通性正常，
 * 因此用它把本地已提交的文件上传。零依赖，只用 Node 内置 fetch。
 *
 * 用法（令牌只从环境变量读取，不写入任何文件）：
 *   $env:GITHUB_TOKEN='ghp_…'; $env:GITHUB_REPO='<owner>/<repo>'
 *   node 运维\push-via-api.mjs                       # 默认 main 分支、提交信息见下
 *   node 运维\push-via-api.mjs --branch main --message "说明"
 *
 * 说明：
 *   · 上传对象是当前 git 索引里的文件（`git ls-files`），因此 .gitignore 的排除规则照旧生效 ——
 *     web/data、skill、runs、产出、测试样本、运维/预览 均不会上传。
 *   · 走 API 创建的提交与本地提交内容相同但提交号不同（本地首提交 vs 远端首提交）。
 *     后续若要改用 `git push`，需要一条能连通 github.com 的通道
 *     （经实测 SSH 端口 22 与 ssh.github.com:443 可用）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const token = process.env.GITHUB_TOKEN || '';
const repoFull = process.env.GITHUB_REPO || arg('--repo', '');
const branch = arg('--branch', 'main');
const message = arg('--message', 'v1.3.1 源码快照：工程咨询成果审核工作台（数据/技能/产出按 .gitignore 排除）');
const API = 'https://api.github.com';

if (!token) { console.error('缺少 GITHUB_TOKEN 环境变量'); process.exit(1); }
if (!/^[^/]+\/[^/]+$/.test(repoFull)) { console.error('GITHUB_REPO 需要形如 owner/repo'); process.exit(1); }

const headers = {
  Authorization: 'Bearer ' + token,
  'User-Agent': 'audit-workbench',
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
};
const api = async (p, init = {}) => {
  const r = await fetch(API + p, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  const text = await r.text();
  let j = null;
  try { j = text ? JSON.parse(text) : null; } catch { j = { raw: text.slice(0, 200) }; }
  if (!r.ok) throw new Error(`${init.method || 'GET'} ${p} → HTTP ${r.status}：${(j && (j.message || j.raw)) || ''}`);
  return j;
};

// ── 0) 空仓库引导：GitHub 不允许在没有任何提交的仓库上创建 blob（HTTP 409 Git Repository is empty），
//       因此先用 Contents API 落一个 README 作为首次提交，之后的 Git Data API 才可用。
try {
  await api(`/repos/${repoFull}/git/ref/heads/${branch}`);
  console.log(`分支 ${branch} 已存在，直接增量上传`);
} catch {
  const readmePath = path.resolve(import.meta.dirname, '..', 'README.md');
  if (!fs.existsSync(readmePath)) { console.error('仓库为空且找不到 README.md，无法引导首次提交'); process.exit(1); }
  const content = fs.readFileSync(readmePath).toString('base64');
  await api(`/repos/${repoFull}/contents/README.md`, {
    method: 'PUT',
    body: JSON.stringify({ message: '初始提交：项目说明', content, branch }),
  });
  console.log('仓库原本为空 → 已用 README 建立首个提交（分支 ' + branch + '）');
}

// ── 1) 取当前索引里的文件（.gitignore 已生效）──
const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
console.log(`准备上传 ${files.length} 个文件（来自 git 索引，已按 .gitignore 排除业务数据）`);

// ── 2) 逐文件建 blob（小并发，避免触发限流）──
const blobs = new Array(files.length);
let done = 0;
const worker = async (idx) => {
  const f = files[idx];
  const b64 = fs.readFileSync(f).toString('base64');
  const r = await api(`/repos/${repoFull}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content: b64, encoding: 'base64' }),
  });
  blobs[idx] = { path: f.split(path.sep).join('/'), mode: '100644', type: 'blob', sha: r.sha };
  done++;
  if (done % 20 === 0 || done === files.length) console.log(`  已上传 ${done}/${files.length}`);
};
let next = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (next < files.length) { const i = next++; await worker(i); }
}));

// ── 3) 建 tree / commit / ref ──
const tree = await api(`/repos/${repoFull}/git/trees`, { method: 'POST', body: JSON.stringify({ tree: blobs }) });
console.log(`tree 已建：${tree.sha.slice(0, 10)}（${blobs.length} 项）`);

let parents = [];
try {
  const ref = await api(`/repos/${repoFull}/git/ref/heads/${branch}`);
  parents = [ref.object.sha];
  console.log(`分支 ${branch} 已存在，将作为新提交的父提交：${ref.object.sha.slice(0, 10)}`);
} catch { console.log(`分支 ${branch} 还不存在（首次上传）`); }

const commit = await api(`/repos/${repoFull}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({ message, tree: tree.sha, parents }),
});
console.log(`commit 已建：${commit.sha.slice(0, 10)}`);

if (parents.length) {
  await api(`/repos/${repoFull}/git/refs/heads/${branch}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) });
} else {
  await api(`/repos/${repoFull}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }) });
}
console.log(`分支 ${branch} 已指向新提交`);

// ── 4) 验证：递归列出远端 tree，确认敏感目录没上去 ──
const full = await api(`/repos/${repoFull}/git/trees/${commit.sha}?recursive=1`);
const paths = (full.tree || []).filter(x => x.type === 'blob').map(x => x.path);
console.log(`\n远端实际文件数：${paths.length}`);
const bad = paths.filter(p => /^(web\/data|skill|runs|产出|测试样本|运维\/预览)\//.test(p) || /\.log$/.test(p));
if (bad.length) {
  console.error('⚠️ 发现不该上传的文件：' + bad.slice(0, 10).join('、'));
  process.exit(2);
}
console.log('✓ 敏感目录（web/data、skill、runs、产出、测试样本、运维/预览、日志）均未上传');
const byTop = {};
for (const p of paths) { const k = p.includes('/') ? p.split('/')[0] + '/' : '（根目录）'; byTop[k] = (byTop[k] || 0) + 1; }
for (const [k, v] of Object.entries(byTop).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(16)} ${v} 个`);
console.log(`\n仓库地址：https://github.com/${repoFull}（私有）`);
