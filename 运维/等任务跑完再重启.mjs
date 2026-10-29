/**
 * 等指定的几个审核任务跑完后，自动重启 Web 服务并自验两项新功能。
 *
 * 为什么要有它：管理员并发上限（2→6）与看板「其中重复审核」都是服务端改动，必须重启才生效；
 * 而重启会把"正在跑"的任务重新入队、从头再跑（已花的 API 费用白费）。因此等这批在跑的任务
 * 全部结束再重启 —— 此时排队中的任务都还没开始，重启不损失任何已产生的费用。
 *
 * 用法：node 运维\等任务跑完再重启.mjs <任务id> [<任务id> …]
 * 结果：追加写入 运维\重启结果.log（含重启前后关键自验数据）
 * 说明：本脚本为一次性运维工具，跑完即退出；不改变任何业务数据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const LOG = path.join(ROOT, '运维', '重启结果.log');
const TASK_DIR = path.join(ROOT, 'web', 'data', 'tasks');
const SERVER_LOG = path.join(ROOT, 'web', 'data', 'server.log');
const TASK_NAME = '审核工作台Web服务';
const POLL_MS = 60 * 1000;
const MAX_HOURS = 8;
const DONE = ['done', 'failed', 'cancelled'];
const targets = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  fs.appendFileSync(LOG, line + '\n', 'utf8');
  console.log(line);
};
const statusOf = (id) => {
  try { return JSON.parse(fs.readFileSync(path.join(TASK_DIR, id, 'meta.json'), 'utf8')).status; }
  catch { return '（读不到）'; }
};
const powershell = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { stdio: 'pipe' });

if (!targets.length) { console.error('用法：node 运维\\等任务跑完再重启.mjs <任务id> …'); process.exit(1); }
log(`看守启动：等待 ${targets.length} 个任务结束 → ${targets.join('、')}（每 ${POLL_MS / 1000}s 查一次，最长 ${MAX_HOURS} 小时）`);

const deadline = Date.now() + MAX_HOURS * 3600 * 1000;
let waited = 0;
while (Date.now() < deadline) {
  const st = targets.map((id) => [id, statusOf(id)]);
  const left = st.filter(([, s]) => !DONE.includes(s));
  if (!left.length) { log(`全部结束：${st.map(([i, s]) => `${i}=${s}`).join('、')}`); break; }
  if (waited % (15 * 60 * 1000) < POLL_MS) log(`仍在跑 ${left.length} 个：${left.map(([i, s]) => `${i}=${s}`).join('、')}`);
  await new Promise((r) => setTimeout(r, POLL_MS));
  waited += POLL_MS;
}
if (Date.now() >= deadline) { log(`超过 ${MAX_HOURS} 小时仍未结束，放弃重启（下次手动重启即可）`); process.exit(0); }

// 重启服务（与日常运维同一入口：计划任务）
try {
  powershell(`Stop-ScheduledTask -TaskName '${TASK_NAME}'`);
  await new Promise((r) => setTimeout(r, 3000));
  powershell(`Start-ScheduledTask -TaskName '${TASK_NAME}'`);
  log('已重启 Web 服务，等待 15s 让它完成启动自检');
} catch (e) { log(`重启失败：${e.message}`); process.exit(1); }
await new Promise((r) => setTimeout(r, 15000));

// ── 自验 ──
try {
  const tail = fs.readFileSync(SERVER_LOG, 'utf8').split('\n').slice(-60).join('\n');
  const capLine = tail.split('\n').filter((l) => l.includes('每人上限')).pop() || '（未找到上限行）';
  log(`自验-启动横幅：${capLine.replace(/^\S+\s+\S+\s+/, '').trim()}`);

  const base = 'http://127.0.0.1:8787';
  const users = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'data', 'users.json'), 'utf8'));
  const admins = users.filter((u) => u.role === 'admin' && !u.disabled);
  const cands = [process.env.ADMIN_U, ...admins.filter((u) => u.defaultPassword).map((u) => u.username), ...admins.map((u) => u.username)].filter(Boolean);
  let cookie = '';
  for (const u of cands) {
    const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8' }, body: JSON.stringify({ username: u, password: process.env.ADMIN_P || '123456' }) });
    if (r.ok) { cookie = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map((c) => String(c).split(';')[0]).join('; '); break; }
  }
  if (!cookie) { log('自验-HTTP：无法登录管理员，跳过接口自验（可手动看板确认）'); process.exit(0); }

  const dash = await (await fetch(base + '/api/dashboard?scope=all&range=all', { headers: { cookie } })).json();
  const u = dash.usage || {};
  log(`自验-看板：已完成 ${u.done} 次 / 其中重复审核 ${u.repeatAudits} 次 / 覆盖项目 ${u.projectCount} 个 ${u.repeatAudits === undefined ? '（缺 repeatAudits 字段，未生效）' : '（字段已生效）'}`);

  const board = await (await fetch(base + '/api/queue-board', { headers: { cookie } })).json();
  log(`自验-排队面板：每人上限 ${board.perUserRunning} / 管理员 ${board.perUserRunningAdmin} / 并发上限 ${board.maxConcurrent} / 在跑 ${board.running} / 排队 ${board.total}`);

  const probe = await fetch(base + '/api/dashboard?scope=all&range=all', { headers: { cookie } });
  log(`自验-接口状态：dashboard HTTP ${probe.status}`);
} catch (e) { log(`自验出错（不影响已重启的服务）：${e.message}`); }
log('看守结束。');
