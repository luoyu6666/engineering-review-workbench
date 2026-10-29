/**
 * 审核工作台 — Web 服务入口
 *
 *   node web/server.mjs            启动（默认端口 8787）
 *   PORT=9000 node web/server.mjs  指定端口
 *
 * 首次启动会自动创建管理员账号并把初始密码打印到控制台。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as L from './lib.mjs';
import { runPipeline, stage0Preflight, stageSupplementAudit, stage3Rules, stage4Grade, stageComparePrevious } from '../engine/lib/pipeline.mjs';
import { getApiKey as engineApiKey, getApiKeyInfo as engineApiKeyInfo, keyFingerprint, MODELS, activeModelName, readSkill, readSkillOptional, callDeepSeek, extractJson, testModelConnection } from '../engine/lib/core.mjs';
import { renderAppendix } from '../engine/lib/pipeline.mjs';
import { renderHtmlReport, renderSupplementReport, classify, PROOFREAD_CATEGORIES, reportIssueList } from '../engine/lib/report-html.mjs';
import { buildAnnotatedPdf, prepareAnnotation, renderScopePdf, cleanupAnnotation, toolchainStatus, toolchainHint, hasPairedPpt } from '../engine/lib/annotate.mjs';
import * as M from '../engine/lib/model-config.mjs';
import * as P from '../engine/lib/providers.mjs';
import * as EG from '../engine/lib/encoding-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = L.PORT;
const DEFAULT_PROJECT_LIMIT = L.DEFAULT_PROJECT_LIMIT;

// ─────────────── 文件日志（做成常驻服务后无控制台可看）───────────────
const LOG_FILE = path.join(L.DATA_DIR, 'server.log');
const _log = console.log.bind(console), _err = console.error.bind(console);
const _toFile = (tag, args) => {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${tag} ${args.map(a => (a && a.stack) || String(a)).join(' ')}\n`, 'utf8');
  } catch { /* 日志失败不影响服务 */ }
};
console.log = (...a) => { _toFile('INFO ', a); _log(...a); };
console.error = (...a) => { _toFile('ERROR', a); _err(...a); };

// ─────────────── 小工具 ───────────────

const json = (res, code, obj) => {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
};
const text = (res, code, s, type = 'text/plain; charset=utf-8') => {
  const b = Buffer.from(s, 'utf8');
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': b.length });
  res.end(b);
};
const readBody = (req, limit = L.MAX_UPLOAD) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('文件过大')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});
const readJsonBody = async (req) => JSON.parse((await readBody(req, 1e6)).toString('utf8') || '{}');
// Cookie 解析必须容错：decodeURIComponent 遇到坏编码会抛异常，整个请求随之返回 500。
// 此前未捕获该异常，一个畸形 Cookie 即可把接口打成 500。
const parseCookies = (req) => {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const raw = part.slice(i + 1).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(raw); } catch { out[k] = raw; }
  }
  return out;
};

/** 统一的 HTTP 头硬化（内网也照做，成本为零） */
function harden(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
}

/**
 * 真实来源 IP：默认只认 TCP 对端地址，不信任 X-Forwarded-For。
 * 该头由客户端提供、可伪造，伪造一个白名单内的 IP 即可绕过 IP 访问控制。
 * 仅当服务确实部署在反向代理之后时才设 WB_TRUST_PROXY=1。
 */
const TRUST_PROXY = process.env.WB_TRUST_PROXY === '1';
const clientIp = (req) => L.clientIpOf(req.headers, req.socket && req.socket.remoteAddress, { trustProxy: TRUST_PROXY });

// 静态资源的 MIME 白名单放在 serveStatic 里（只服务前端真正用到的几类文件）

function currentUser(req) {
  const sid = parseCookies(req)['sid'];
  return L.getSession(sid);
}
/** 会话失效时一并让浏览器丢弃过期的 sid，否则其后每次请求都会带上无效 Cookie */
function clearSidCookie(res) {
  res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

// ─────────────── IP 访问控制（2026-09-28: 限制其他部门访问与调用）───────────────
// MAC 地址只记录、不参与拦截：浏览器读不到，跨网段取不到，也可随时更改；拦截依据为 IP 白名单。
// MAC 取自 Windows ARP 邻居表，并按 IP 缓存 10 分钟；否则每个请求都要起一个进程，代价过高。
const macCache = new Map();          // ip -> { mac, at }

/**
 * 各账号绑定的 IP，供全局白名单自动并入。
 *
 * 生效白名单 = 手工白名单 ∪ 各账号绑定 IP。此前只校验手工白名单，且判定发生在登录前，
 * 已绑定 IP 的账号会在首道校验被拒绝，绑定配置不生效，管理员还需重复维护手工名单。
 * 缓存用于避免每请求读取 users.json；TTL 取 2s 以兼顾配置变更的生效延迟。
 * （实际生效名单见 lib.effectiveAllowlist）
 */
let _boundCache = { at: 0, ips: [] };
function boundIpsCached() {
  if (Date.now() - _boundCache.at < 2000) return _boundCache.ips;
  const ips = L.boundIpsOf(L.listUsers());
  _boundCache = { at: Date.now(), ips };
  return ips;
}

async function lookupMac(ip) {
  if (!ip || ip === '127.0.0.1' || ip.startsWith('127.')) return '';
  const hit = macCache.get(ip);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.mac;
  try {
    const { execFile } = await import('node:child_process');
    const out = await new Promise((resolve) => {
      execFile('arp', ['-a', ip], { timeout: 4000, windowsHide: true }, (e, so) => resolve(so || ''));
    });
    const m = String(out).match(/([0-9a-f]{2}(?:-[0-9a-f]{2}){5})/i);
    const mac = m ? m[1].toUpperCase().replace(/-/g, ':') : '';
    macCache.set(ip, { mac, at: Date.now() });
    return mac;
  } catch { macCache.set(ip, { mac: '', at: Date.now() }); return ''; }
}

/**
 * 全局白名单闸门：在路由之前判定，名单外的 IP 无法打开登录页。
 *
 * @returns {boolean} 返回 true 表示已拦截（响应已发出）
 */
function blockedByAllowlist(req, res, ip) {
  const cfg = L.getSystemConfig();
  // boundIps：各账号绑定的 IP 自动并入全局白名单（修复「修改绑定后仍无法进入」的问题）
  const verdict = L.checkIpAccess({ ip, user: null, cfg, boundIps: boundIpsCached() });   // user=null → 只判全局白名单
  if (verdict.allowed || verdict.scope === 'admin') return false;
  L.appendAccessLog({ ip, path: req.url || '', ua: req.headers['user-agent'] || '', reason: verdict.reason, scope: verdict.scope });
  console.warn(`[访问控制] 拒绝 ${ip}：${verdict.reason}（${req.method} ${req.url}）`);
  res.setHeader('X-Client-IP', ip);
  json(res, 403, {
    error: verdict.reason,
    clientIp: ip,
    scope: verdict.scope,
    hint: verdict.scope === 'global'
      ? '如属误拦：把本机 IP 报给管理员。管理员在「用户管理 → IP 绑定」里给对应账号加上这个 IP 即可（会自动并入白名单），'
        + '或直接在「访问控制 → 全局白名单」里加一行。'
      : '如属误拦，请把本机 IP 报给管理员。',
  });
  return true;
}

function requireUser(req, res) {
  const u = currentUser(req);
  if (!u) {
    if (parseCookies(req)['sid']) clearSidCookie(res);   // 过期/无效的会话：清 Cookie，前端据此弹登录
    json(res, 401, { error: '未登录或会话已过期，请重新登录' });
    return null;
  }
  // 注：每账号 IP 绑定的判定不在此处，而是集中在 handleApi 入口处。
  //     否则 /api/me、/api/logout 这类直接使用 currentUser 的接口会绕过闸门（此前出现过）。
  return u;
}
function requireAdmin(req, res) {
  const u = requireUser(req, res);
  if (!u) return null;
  if (u.role !== 'admin') { json(res, 403, { error: '需要管理员权限' }); return null; }
  return u;
}

// ─────────────── 原报告标注版（审核时预生成 + 历史任务按需回退）───────────────
//
// 正常路径：审核流水线最后一步生成两份标注版（见 runTask ⑤.5），
//           使用方调用下载即为直接下载，零等待。
// 回退路径：此功能上线前完成的历史任务没有标注版，调用按钮时现场生成；
//           状态落盘（任务目录 annotate-<scope>.json），因此刷新页面、切走再回来、
//           甚至服务重启，看到的都是同一状态（生成中或已失败），不会从头重来。
const annotateJobs = new Map();     // `${taskId}:${key}` -> { status, error, startedAt, stats }（key 见 annotateKeyOf）

/**
 * 标注版的路径编号：报告用 proof / deep，配对任务里的 PPT 用 ppt-proof / ppt-deep。
 *
 * 2026-09-28: 含 PPT 一致性核对的任务此前只能下载报告的标注版。
 * 报告与 PPT 的差异需落在 PPT 上供查阅，因此 PPT 单独设一路标注版。
 */
const annotateKeyOf = (scope, kind) => (kind === 'ppt' ? `ppt-${scope}` : scope);

const annotateOut = (taskId, scope, kind = '') => {
  const ppt = kind === 'ppt';
  const name = ppt
    ? (scope === 'deep' ? '原PPT标注版-审核.pdf' : '原PPT标注版-校对.pdf')
    : (scope === 'deep' ? '原报告标注版-审核.pdf' : '原报告标注版-校对.pdf');
  return path.join(L.taskDir(taskId), name);
};
const annotateStateFile = (taskId, scope, kind = '') => path.join(L.taskDir(taskId), `annotate-${annotateKeyOf(scope, kind)}.json`);

function readAnnotateState(taskId, scope, kind = '') {
  try { return JSON.parse(fs.readFileSync(annotateStateFile(taskId, scope, kind), 'utf8')); } catch { return null; }
}

function annotateStatus(taskId, scope, kind = '') {
  const k = annotateKeyOf(scope, kind);
  const job = annotateJobs.get(`${taskId}:${k}`) || null;
  const out = annotateOut(taskId, scope, kind);
  if (fs.existsSync(out)) {
    const saved = readAnnotateState(taskId, scope, kind);
    const stats = job?.stats || (saved && saved.status === 'done' ? saved.stats : null)
      || (L.getTask(taskId)?.annotate || {})[k] || null;
    return { status: 'done', bytes: fs.statSync(out).size, stats };
  }
  if (job?.status === 'running') return { status: 'running', startedAt: job.startedAt };
  const saved = readAnnotateState(taskId, scope, kind);
  if (saved?.status === 'running') {
    // 服务在生成过程中被重启：标记为上次被中断，避免一直显示生成中
    return { status: 'error', error: '上次生成被中断（服务重启），请再点一次', startedAt: saved.startedAt };
  }
  if (job?.status === 'error') return { status: 'error', error: job.error };
  if (saved?.status === 'error') return { status: 'error', error: saved.error };
  return { status: 'idle' };
}

function startAnnotate(task, scope, kind = '') {
  const k = annotateKeyOf(scope, kind);
  const key = `${task.id}:${k}`;
  const cur = annotateJobs.get(key);
  if (cur && cur.status === 'running') return cur;
  const job = { status: 'running', startedAt: new Date().toISOString(), stats: null, error: null };
  annotateJobs.set(key, job);
  try { fs.writeFileSync(annotateStateFile(task.id, scope, kind), JSON.stringify({ status: 'running', startedAt: job.startedAt }), 'utf8'); } catch { /* 状态文件写不了不影响生成 */ }
  // 只传了 PPT 的任务：标注 PPT 本身（LibreOffice 同样能把 .pptx 转成带文字层的 PDF）
  const files = fs.readdirSync(L.taskDir(task.id));
  const pptOnly = !files.some(f => /\.docx$/i.test(f) && !/extracted/i.test(f) && !/^~\$/.test(f));
  console.log(`[标注版 ${task.id}/${k}] 开始生成${kind === 'ppt' ? '（配对任务里的 PPT）' : (pptOnly ? '（仅 PPT，标注 PPT 本身）' : '')}`);
  buildAnnotatedPdf({
    taskDir: L.taskDir(task.id), scope, kind, outPdf: annotateOut(task.id, scope, kind), preferPptx: pptOnly,
    log: (m) => console.log(`[标注版 ${task.id}/${k}] ${m}`),
  })
    .then(st => {
      job.status = 'done'; job.stats = st;
      try { fs.writeFileSync(annotateStateFile(task.id, scope, kind), JSON.stringify({ status: 'done', at: new Date().toISOString(), stats: st }), 'utf8'); } catch { /* ignore */ }
      // 定位档位落盘：成果报告重新渲染时据此给未能标出位置的条目加红字提示。
      // PPT 那一路不参与成果报告渲染，因此只在报告那一路写。
      if (kind !== 'ppt') {
        try {
          const tf = path.join(L.taskDir(task.id), 'annotate-tiers.json');
          const old = fs.existsSync(tf) ? JSON.parse(fs.readFileSync(tf, 'utf8')) : {};
          fs.writeFileSync(tf, JSON.stringify({ ...old, ...(st.tiers || {}) }, null, 2), 'utf8');
        } catch { /* ignore */ }
      }
      console.log(`[标注版 ${task.id}/${k}] 完成：共 ${st.total} 条，精确定位 ${st.exact}、近似 ${st.approx}、章节 ${st.section}、未能定位 ${st.none}`);
    })
    .catch(e => {
      job.status = 'error'; job.error = e.message;
      try { fs.writeFileSync(annotateStateFile(task.id, scope, kind), JSON.stringify({ status: 'error', error: e.message, at: new Date().toISOString() }), 'utf8'); } catch { /* ignore */ }
      console.error(`[标注版 ${task.id}/${k}] 失败：${e.message}`);
    });
  return job;
}

// ─────────────── 审核队列 ───────────────

const queue = [];
let running = 0;
// 2026-09-28: 同时处理的审核任务数由 2 调整为 6。
// 依据（已查证与验证，非估算）：
//   · 接口侧：官方文档「限速与隔离」载明限流按并发计，deepseek-flash 每账号 2500 并发，超出才返回 429。
//     经实测，8 路并发（各约 2.7 万 token 输入）全部 200、最慢 1.5 秒，再叠 8 路（共 16 路）也全部 200。
//     注意：任务内部并非纯串行，S2 分维度阶段为受控并发（默认每任务同时 3 个单元，见
//     pipeline.mjs 的 S2_CONCURRENCY）。因此「全局并发 6」瞬时最多约 6×3=18 路在跑，
//     仍仅为上限的 0.7%，距被限流很远。
//   · 本机：24 核 32 线程 / 63.6G 内存（空闲 45.9G），并发 6-8 时本地进程（pandoc、Chrome、pdftoppm）可承载。
//   · 被放大的只有费用速度，且它只是最坏情况下的上限速率：按真实数据（单任务 73.7 万 token /
//     4.1 分钟）估算，并发 6 跑满约 88 个任务/小时、¥55–110/小时；实际日提交量为 3–16 个，
//     单日最高花费 ¥8.08（单份均 ¥1.08），距跑满差 7–14 倍。
//   · 并发不改变总花费，只改变花费节奏，因此并发数按「每人等待时长」的体验设定，不作为费用闸门。
//     真正决定总费用的是提交份数 / 每份用量 / 是否高峰时段。
//     2026-09-28: 暂不加「每小时或每日费用总闸」，改用每人积分额度 + 闲时调用引导控制总费用。
//     另注：与并发真正相关的支出是服务重启时正在跑的任务需重跑，6 并发最坏损失约 ¥6.5。
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 6);
const MAX_QUEUE      = Number(process.env.MAX_QUEUE || 30);       // 就绪任务的排队上限
// 等待闲时的任务不占 MAX_QUEUE 名额，单独设上限。
// 此前名额按 queue 数组长度计算，而等待闲时的任务也在该数组中：
//   周一早上 15 人各提交 2 份（默认即闲时调用），30 份全部进入 waiting 等 12:10，
//   09:05~12:10 队列长度恒为 30，任何人再提交都被 503 拒绝，
//   而该时段服务器实际处于空闲状态；提示语仅给出「排队已达上限」，无法定位原因。
const MAX_WAITING    = Number(process.env.MAX_WAITING || 100);
// 管理员「立即开始」的临时并发名额总上限（额外最多 +2）。
// 不设上限时，连续多次加急会把并发推高，费用速度将超出预期。
const MAX_BOOST      = Number(process.env.MAX_BOOST || 2);
const TASK_TIMEOUT_MS = Number(process.env.TASK_TIMEOUT_MS || 25 * 60 * 1000);

/** 正在运行的任务 id 集合：按人限流与公平调度需要知道具体是哪些任务在跑，仅有计数不足 */
const runningIds = new Set();
/** 每个提交人在跑的任务数（公平调度与「每人 ≤2」的依据） */
/**
 * 管理员账号 id 集合：调度时用于区分"每人上限"的两档（管理员更高）。
 * 不做缓存：users.json 很小，而 pump() 与队列面板调用频率不高；缓存反而容易出现"刚加了管理员却不生效"。
 */
function adminOwnerIds() {
  return new Set(L.listUsers().filter(u => u.role === 'admin' && !u.disabled).map(u => u.id));
}
function runningByOwner() {
  const m = new Map();
  for (const id of runningIds) {
    const t = L.getTask(id);
    if (!t) continue;
    const k = t.owner || '（未知）';
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}
/** 某人在队列里就绪的任务数，不计等待闲时的任务，与全局口径一致 */
function queuedReadyOf(ownerId) {
  let n = 0;
  for (const id of queue) {
    const t = L.getTask(id);
    if (!t || t.owner !== ownerId) continue;
    if (!L.isWaitingTask(t)) n++;
  }
  return n;
}

/**
 * 任务在实际调度顺序里的排位（1 = 下一个运行）。
 *
 * 不能使用 `queue.indexOf(id) + 1`：那是入队顺序。加了优先级的任务会先运行，
 * 但顺位仍显示在后面，界面上即出现矛盾（排队管理里排第 1，处理进度里却写前面还有 3 个）。
 * 经实测出现过该现象，因此顺位统一按优先级 + 先来后到计算。
 *
 * @returns {number|null} 排位；任务不在队列中时为 null
 */
const queuePosition = (taskId) => {
  if (!queue.includes(taskId)) return null;
  const hit = L.buildQueueBoard(queue, L.getTask, {}).items.find(x => x.id === taskId);
  return hit ? hit.position : null;
};

/**
 * 「立即开始」临时增加的并发名额。
 *
 * 2026-09-28: 名额已满时调用「立即开始」，为这一个任务增加一路并发（2 → 3），跑完立即收回。
 * 不复用常设名额的原因：停掉正在运行的任务会使该段 API 费用作废，
 * 永久提高并发则会使负载在无感知的情况下持续抬升。
 */
let boostSlots = 0;
const boosted = new Set();          // 靠临时名额运行起来的任务（内存态即可：重启后并发计数也归零）

/** 该任务当前能否开始运行；判定已移至 lib.mjs（纯函数，可在自检中断言） */
const canStart = (id) => L.canStartTask(L.getTask(id));

/** 是否在「等待闲时」：已解析完，但在等起跑时刻 */
const isWaiting = (id) => {
  const t = L.getTask(id);
  return !!(t && t.preprocessedAt && t.apiStartAt && new Date(t.apiStartAt) > new Date());
};

/**
 * 队列分两类统计。
 *   ready   —— 现在即可运行（受 ready 名额限制）
 *   waiting —— 已解析完，等待闲时窗口；不占服务器资源，因此不占 ready 名额
 */
function queueStats() {
  let ready = 0, waiting = 0;
  for (const id of queue) {
    if (!L.getTask(id)) continue;          // 任务已被删除，跳过
    if (isWaiting(id)) waiting++; else ready++;
  }
  return { ready, waiting, total: ready + waiting, maxReady: MAX_QUEUE, maxWaiting: MAX_WAITING };
}

let wakeTimer = null;
function scheduleWake() {
  if (wakeTimer) return;
  const times = queue.map(id => {
    const t = L.getTask(id);
    // 只有「已预处理、等待起跑时刻」的任务才需要定时唤醒
    return (t && t.preprocessedAt) ? t.apiStartAt : null;
  }).filter(Boolean).map(s => new Date(s).getTime());
  if (!times.length) return;
  const next = Math.min(...times);
  const ms = Math.min(Math.max(next - Date.now(), 1000), 30 * 60 * 1000);   // 最多睡 30 分钟
  wakeTimer = setTimeout(() => { wakeTimer = null; pump(); }, ms);
  if (wakeTimer.unref) wakeTimer.unref();
}

function enqueue(taskId, { front = false } = {}) {
  if (queue.includes(taskId)) return;
  if (front) queue.unshift(taskId); else queue.push(taskId);
  pump();
}
function pump() {
  // 并发上限 = 常设上限 + 管理员「立即开始」临时发放的名额（任务完成即收回，见 boostSlots）
  // 每人上限分两档：普通使用方 PER_USER_RUNNING，管理员 PER_USER_RUNNING_ADMIN（管理员可跑到全局上限）。
  const adminOwners = adminOwnerIds();
  while (running < MAX_CONCURRENT + boostSlots) {
    // 挑选下一个运行的任务：优先级 → 公平（手上无在跑任务的优先）→ 先来后到，
    // 并跳过该人在跑数已达上限（管理员另有更高上限）与未到闲时起点的任务（判定均在 lib.pickNextReady）。
    const idx = L.pickNextReady(queue, L.getTask, {
      runningByOwner: runningByOwner(),
      perUserRunning: L.PER_USER_RUNNING,
      adminOwners,
      adminPerUserRunning: L.PER_USER_RUNNING_ADMIN,
    });
    if (idx < 0) { scheduleWake(); return; }
    const id = queue.splice(idx, 1)[0];
    running++;
    runningIds.add(id);            // 记下"谁在跑"，供按人限流与公平调度使用
    withTimeout(runTask(id), TASK_TIMEOUT_MS, '审核')
      .catch(e => {
        console.error(`[task ${id}] 异常:`, e.message);
        const t = L.getTask(id);
        if (t && !['done', 'failed', 'cancelled'].includes(t.status)) {
          t.status = 'failed'; t.error = e.message; t.finishedAt = new Date().toISOString();
          // 必须先落盘状态、再追加进度：appendProgress 内部会重新读盘并只合并 progress 数组，
          // 直接 appendProgress(t, ...) 会丢失此处刚设置的 'failed'，
          // 任务因此停留在 'queued'，被 pump() 反复取出重跑（经实测，4 个任务全部卡住）。
          L.saveTask(t);
          L.appendProgress(t, `失败：${e.message}`);
        }
      })
      .finally(() => {
        running--;
        runningIds.delete(id);
        // 「立即开始」临时借出的并发名额：该任务完成后即归还（只归还一次）
        if (boosted.has(id)) {
          boosted.delete(id);
          boostSlots = Math.max(0, boostSlots - 1);
        }
        pump();
      });
  }
}
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label}超时（${Math.round(ms / 60000)} 分钟）`)), ms); }),
  ]);
}

/** 启动时回收孤儿任务：服务重启后卡在 queued/converting/waiting/auditing 的任务重新入队，避免永久悬挂 */
function recoverOrphans() {
  const stuck = L.listTasks().filter(t => L.ACTIVE_STATES.includes(t.status));
  for (const t of stuck) {
    t.status = 'queued'; t.error = null;
    L.appendProgress(t, '检测到服务重启，任务已重新入队');
    enqueue(t.id, { front: true });
  }
  if (stuck.length) console.log(`已回收 ${stuck.length} 个因重启中断的任务，重新入队`);
  return stuck.length;
}

async function runTask(id) {
  const task = L.getTask(id);
  if (!task) return;
  const dir = L.taskDir(id);
  const log = (msg) => { console.log(`[${id}] ${msg}`); L.appendProgress(task, msg); };

  /**
   * 任务是否已被取消。
   *
   * 每跨一个阶段都必须重新读盘：存在如下竞态 —— 调用「取消」时任务刚被 pump() 从队列取走，
   * runTask 仍持有旧的 task 对象，其后每次 L.saveTask(task) 都会覆盖刚写入的 'cancelled'，
   * 表现为「已取消仍在运行」，并继续产生 API 费用。经实测可复现。
   *
   * @returns {boolean} 已取消或任务已不存在时为 true
   */
  const cancelled = () => {
    const cur = L.getTask(id);
    return !cur || cur.status === 'cancelled';
  };
  const abortIfCancelled = (at, costHint = '') => {
    if (!cancelled()) return false;
    console.log(`[${id}] 检测到任务已被取消，在「${at}」处中止${costHint}`);
    return true;
  };

  if (abortIfCancelled('开始处理前')) return;

  /**
   * 受保护的落盘：盘上状态已取消时不覆盖。
   *
   * runTask 运行期间可达数分钟，使用方随时可能取消；直接 L.saveTask(task)
   * 会用内存中的旧副本把 cancelled 改回去（实际出现过的竞态）。
   *
   * @returns {boolean} 是否实际写入
   */
  const save = () => {
    const cur = L.getTask(id);
    // 盘上已无此任务，说明已被删除（管理员删除 / 清理），不能再写回，否则会将已删除任务复活。
    // appendProgress 存在同样问题，已一并修复。
    // 现象：任务删除后过一段时间又出现在台账里（经实测两次，并会被误认为存在待处理任务）。
    if (!cur) {
      console.log(`[${id}] 任务已被删除，跳过写盘`);
      return false;
    }
    if (cur.status === 'cancelled' && task.status !== 'cancelled') {
      console.log(`[${id}] 盘上状态已是 cancelled，跳过写盘以免覆盖用户的取消`);
      return false;
    }
    // 此处必须是 L.saveTask(task)。此前曾用批量正则把 'L.saveTask(task)' 全部替换为 'save()'，
    // 结果 save 函数自己体内的这一行也被替换，形成 save() 自我调用直至栈溢出；
    // 语法检查无法发现（属合法递归），任务会全部卡在 queued 反复重跑。
    L.saveTask(task);
    return true;
  };

  try {
    // ① 预处理（纯本地，零 API 成本）：.doc → .docx → markdown
    //    该步骤与计费时段无关，因此提交后立即执行，不受高峰时段影响。
    //    闲时任务在此完成后暂停等待窗口，把所有产生费用的 API 调用留到空闲时段。
    task.status = 'converting'; task.startedAt = new Date().toISOString(); save();
    log('开始处理：文档转换（本地预处理，不产生 API 费用）');
    // 「仅 PPT」任务没有报告可转：跳过，待下方装入 PPT 后以其作为审核对象
    let text = '', tables = 0;
    if (task.uploadFile) {
      const conv = await L.convertToMarkdown(path.join(dir, task.uploadFile), log);
      text = conv.text; tables = conv.tables;
    } else {
      log('本次没有报告文件（仅 PPT 审核），跳过报告转换');
    }
    if (abortIfCancelled('文档解析完成后')) return;
    task.convertedChars = text.length; task.tableRows = tables;
    if (text) fs.writeFileSync(path.join(dir, 'report.md'), text, 'utf8');
    // 「仅 PPT」：把幻灯片文本当作审核对象（流水线里会用 pptOnly 只跑 PPT 单元）
    if (task.pptOnly && !text) { /* pptText 在下面装入后再写入 */ }

    // ①.1 配对的 PPT（可选）：把暂存文件移入任务目录并取出幻灯片文字。
    //     转换已在暂存阶段完成（使用方可看到进度，也能提前判断内容是否充分），
    //     因此这里只做搬运与读文件，不重复转换。
    if (task.pptStashId && !task.pptText) {
      const s = L.getStash(task.pptStashId);
      if (!s) {
        log('⚠️ PPT 暂存已过期，本次只审报告，不做一致性核对');
        task.pptStashId = null; task.crossCheck = false;
      } else {
        try {
          const moved = L.moveStashToTask(task.pptStashId, dir);
          const pptMd = path.join(dir, 'ppt.md');
          task.pptText = fs.readFileSync(pptMd, 'utf8');
          task.pptSourceName = moved.name;
          task.pptSlides = moved.slides;
          task.pptChars = task.pptText.length;
          task.pptEnough = !!(moved.quality && moved.quality.enough);
          log(`PPT 已就位：「${moved.name}」${moved.slides} 页 / ${task.pptText.length.toLocaleString()} 字符`
            + (task.crossCheck ? '，将做「PPT ↔ 报告」一致性核对' : '')
            + (task.pptEnough ? '' : '（内容不足以图片为主，只能做有限校对）'));
        } catch (e) {
          log(`⚠️ PPT 装入失败（${e.message}），本次只审报告`);
          task.crossCheck = false;
        }
        task.pptStashId = null;
      }
    }
    task.preprocessedAt = new Date().toISOString();
    await save();

    // ①.1 本地查重粗筛（零 API）：用已登记项目的编号/名称在正文中查找。
    //      闲时任务可能数小时后才执行 S0，届时提醒过迟，因此这里先给出预警。
    //      权威判定在下面的 S0 之后（识别出真实项目名后才生效）。
    const quickDup = L.quickDuplicateCheck(L.listTasks(), text.slice(0, 30000), { excludeTaskId: task.id });
    if (quickDup.length) {
      task.duplicatePreview = L.summarizeDuplicates(quickDup);
      save();
      const others = quickDup.filter(t => t.owner !== task.owner);
      log(`⚠️ 本地查重预警：正文里出现了已知项目「${quickDup[0].projectName || quickDup[0].sourceName}」`
        + `（${quickDup.length} 条历史记录${others.length ? `，其中 ${others.length} 条是他人提交` : ''}）。`
        + `以 AI 预审识别出的项目为准，届时会再次核对。`);
    }

    // ①.2 闲时调用模式：预处理已完成，若尚未进入空闲时段则交回队列等待窗口
    //      （API 起跑时刻 = 高峰结束 + 10 分钟，见 lib.nextOffPeakStart）
    //
    //      需处理「错过窗口」的情况：机器关机 / 停电 / 重启，直到次日上班才恢复时，
    //      原 apiStartAt 已过期；此时直接运行会在高峰时段按 2 倍价计费，
    //      与选择「闲时调用」的初衷相悖。因此闲时模式的任务若当前处于高峰，
    //      把起跑时刻顺延到下一个空闲窗口。
    if (task.mode === 'idle' && L.isPeakHour()) {
      const next = L.nextOffPeakStart();
      if (!task.apiStartAt || new Date(task.apiStartAt).getTime() !== next.getTime()) {
        const missed = task.apiStartAt && new Date(task.apiStartAt) < new Date();
        task.apiStartAt = next.toISOString();
        log(missed
          ? `⚠️ 原定的闲时窗口（${L.fmtBJText(task.apiStartAt)} 之前）已错过——期间服务器可能关机或重启。`
            + `当前仍是高峰时段，起跑时刻顺延到 ${L.fmtBJText(next)}，继续按半价计费。`
          : `当前为高峰时段，AI 调用推迟到 ${L.fmtBJText(next)}（空闲时段，半价计费）。`);
      }
    }

    const apiStartAt = task.apiStartAt ? new Date(task.apiStartAt) : null;
    if (apiStartAt && apiStartAt.getTime() > Date.now() + 1000) {
      task.status = 'waiting';
      task.scheduledAt = apiStartAt.toISOString();
      save();
      log(`预处理已完成（${text.length.toLocaleString()} 字符，本地转换不花钱）。`
        + `AI 调用排在 ${L.fmtBJText(apiStartAt)}（空闲时段，价格为高峰的一半）——`
        + `还有 ${L.untilText(apiStartAt)}。文档已就绪，到点自动开跑，无需重新上传。`);
      enqueue(id);   // 重新排队；canStart 会一直等到 apiStartAt
      return;
    }
    if (task.mode === 'idle') log('当前已是空闲时段，立即进入 AI 审核（半价计费）。');

    // 跨过此处即开始产生费用。此处再查一次任务是否已被取消，作为止损的最后一道关。
    if (abortIfCancelled('调用 AI 之前', '（尚未产生任何 API 费用）')) return;

    // ①.5 预审：识别项目 + 报告类型 + 项目类型 + 检查该项目的「质量配额」
    //      按项目累计校对类问题，超阈值直接拒绝，以便在正式审核（约 40 万 token）之前拦下，
    //      既督促初稿质量，也避免无效消耗。
    //      确认重复审核后恢复执行时（preflightDone），这些字段已识别过，直接复用，
    //      不再产生第二次 S0 费用。
    let pf = null;    // S0 的用量要在下面并入总用量，所以在块外声明
    if (task.preflightDone && task.projectName) {
      log(`预审已完成过，直接复用识别结果（项目「${task.projectName}」，类型「${task.templateName}」），不再重复调用 S0`);
    } else {
      log('预审：识别项目名称、报告类型与项目类型…');
      pf = await stage0Preflight({
        apiKey: engineApiKey(), model: activeModelName(),
        fileName: task.sourceName, reportText: text, log,
        projectTypes: L.projectTypeOrder(),
        reportTypes: L.BIZ_TYPES.map(x => x.name),
      });
      task.projectName = pf.projectName;
      task.projectCode = pf.projectCode || '';

      // 报告类型：S0 识别 → 对齐已知类型 → 文件名关键词回退。不再需要手动选择。
      const detectedBiz = L.normalizeBizType(pf.reportType) || L.guessBizType(pf.projectName, task.sourceName, text.slice(0, 1500));
      task.bizType = detectedBiz;
      task.templateName = L.bizTypeName(detectedBiz);
      task.templateId = '';
      task.reportTypeRaw = pf.reportType || '';
      task.typeAutoDetected = true;
      log(`自动识别报告类型：${task.reportTypeRaw ? `「${task.reportTypeRaw}」→ ` : ''}${task.templateName}`);

      // 项目类型（看板分类维度）：S0 识别 → 对齐清单 → 关键词回退 → 其他/未分类
      task.projectType = L.normalizeProjectType(pf.projectType)
        || L.guessProjectType(pf.projectName, task.sourceName, task.templateName);
      log(`自动识别项目类型：${task.projectType}`);
    }

    const sys = L.getSystemConfig();
    const qc = L.checkProjectQuota(L.listTasks(), task.projectName, sys.projectLimit);
    task.projectQuota = qc;
    save();
    // 项目质量配额当前只统计、不拦截，观察一段时间后再决定是否启用。
    //     开关在「系统管理」里，默认 false。
    if (sys.enforceProjectQuota && !qc.ok) {
      task.status = 'rejected';
      task.error = qc.reason;
      task.finishedAt = new Date().toISOString();
      save();
      log(`已拒绝受理（项目质量配额已启用）：${qc.reason}`);
      return;
    }
    log(`项目「${task.projectName}」累计校对类问题 ${qc.used}/${qc.limit} 项`
      + `${sys.enforceProjectQuota ? `，剩余额度 ${qc.remaining} 项` : '（当前为「只统计不拦截」模式）'}，继续审核`);

    // ①.7 重复审核判定（权威）：项目名/编号识别出来之后才生效。
    //     不同人员提交同一项目时提示重复审核。默认暂停等待确认，避免无效执行
    //     （约 ¥0.7 API + ¥260 人工工时，且会在台账中多出一条同项目记录）。
    if (!task.duplicateConfirmed) {
      const dupHits = L.findDuplicateAudits(L.listTasks(), {
        projectName: task.projectName, projectCode: task.projectCode,
        excludeTaskId: task.id, excludeOwner: task.owner,
      });
      const dupOthers = dupHits.filter(h => !h.isSameOwner);
      if (dupHits.length) {
        task.priorAudits = L.summarizeDuplicates(dupHits);
        save();
      }
      if (dupOthers.length) {
        const who = dupOthers.map(h => `${h.ownerName}（${L.fmtBJText(h.finishedAt || h.createdAt)}）`).join('、');
        log(`⚠️ 重复审核：项目「${task.projectName}」此前已由 ${who} 提交审核过，共 ${dupOthers.length} 条记录。`
          + `匹配依据：${dupOthers[0].matchedBy === 'code' ? '项目编号' : dupOthers[0].matchedBy === 'name' ? '项目名称' : '编号与名称'}。`);
        if (sys.duplicateMode === 'block') {
          task.status = 'duplicate-suspect';
          task.duplicateConflict = true;
          task.preflightDone = true;      // 已识别过项目，确认后不必再花一次 S0
          task.error = `该项目已由 ${dupOthers.map(h => h.ownerName).join('、')} 提交审核过，等待确认是否重复审核`;
          save();
          log('已暂停，等待提交人或管理员确认「确认重复审核」后再继续（AI 审核尚未开始，未产生审核费用）。');
          return;
        }
        log('（当前为「只提醒不拦截」模式）继续审核，台账中会标注为重复审核。');
      } else if (dupHits.length) {
        log(`提示：本项目你自己此前也提交过 ${dupHits.length} 次（重新提交修订稿属正常，不拦截）。`);
      }
    }
    task.preflightDone = true;
    save();

    // ② 审核流水线
    task.status = 'auditing'; save();
    // ①.2 图表核对（可选，默认关）：把报告中的图片抽出备用。
    //     抽图是纯本地操作（自行解 zip，15ms 量级，无费用），因此总是执行，
    //     抽完记录张数；是否送入模型由 chartCheck 决定。
    let chartImages = null;
    if (task.chartCheck) {
      try {
        const imgDir = path.join(dir, 'charts');
        fs.mkdirSync(imgDir, { recursive: true });
        const r = L.extractOoxmlImages(path.join(dir, task.uploadFile), imgDir);
        chartImages = r.images;
        task.chartImageCount = r.total;
        task.chartImageSkipped = r.skipped.length;
        log(`图表核对已开启：抽出 ${r.total} 张图片`
          + (r.skipped.length ? `，跳过 ${r.skipped.length} 张（矢量图 .emf/.wmf 视觉模型读不了，或超出张数上限）` : '')
          + `，约 ${(r.total * 1024).toLocaleString()} token 上限`);
        if (!r.total) log('⚠️ 这份报告里没抽到可读图片（可能都是矢量图或没有插图），图表核对将无内容可查');
        save();
      } catch (e) {
        log(`⚠️ 抽图失败（不影响其余审核）：${e.message}`);
      }
    }

    log('进入审核流水线（S1 结构化 → S2 分维度 → S3 规则 → S4 分级 → S5 成文）');

    const result = await runPipeline({
      apiKey: engineApiKey(),
      model: activeModelName(),
      reportText: text || task.pptText || '',
      reportName: task.sourceName.replace(/\.[^.]+$/, ''),
      pptOnly: !!task.pptOnly,
      runDir: path.join(dir, 'run'),
      log,
      reportTypeName: task.templateName,
      learned: readSkillOptional('LEARNED.md'),           // 平台积累的审核经验（人工反馈沉淀）
      // ── PPT 配对（可选）──
      // 提交时带 PPT 才有值：ppt 单元审幻灯片本身；crossCheck 为真时另加一致性核对单元。
      // 未带 PPT 时这两个参数为空串，流水线不增加任何额外调用。
      pptText: task.pptText || '',
      pptName: task.pptSourceName || '',
      crossCheck: !!task.crossCheck,
      chartImages,                                          // 图表核对（默认 null = 关闭）
      // 定向经验按两个维度同时注入：报告类型（一类报告的通病）+ 指定项目（该项目的特殊要求）。
      // projectType 在 S0 预审后才确定；未识别时按名称/文件名回退推断，宁可少注入也不要注入错。
      projectLearned: L.learnedForContext({
        projectName: task.projectName,
        projectType: task.projectType || L.guessProjectType(task.projectName, task.sourceName, task.templateName),
      }),
      // 本次审核重点（管理员指定）→ 注入 S2 每个单元的 user 段（见 focusBlock 的缓存说明）
      reviewFocus: task.reviewFocus || [],
      reviewNote: task.reviewNote || '',
    });

    // ③ 生成 HTML 意见书（代码生成；两份：完整版 / 仅校对版）
    const g = result.graded;
    const reportMeta = {
      id: task.id, sourceName: task.sourceName, templateName: task.templateName,
      ownerName: task.ownerName, createdAt: task.createdAt, bizType: task.bizType,
      projectName: task.projectName, projectCode: task.projectCode, projectType: task.projectType,
      // 成果报告开头要印出"本次审核重点"，所以必须带进 reportMeta
      reviewFocus: task.reviewFocus || [], reviewNote: task.reviewNote || '',
    };

    // ③.0 先做标注版定位分析（原报告 → PDF → 逐页坐标 → 逐条定位）。
    //     提前到渲染报告之前的原因：成果报告要给未能在原报告上标出位置的条目加红字提示，
    //     否则查阅者会误以为标注版上均已标出。分析结果（tiers）两份报告与两份标注版共用，只跑一遍转换。
    //     失败不影响成果：标注版退化为下载时现场生成，报告里不加提示。
    // ③.0 与上一轮同项目审核对比：后续审核需说明上次问题是否已修改。
    //     放在渲染报告之前：报告需新增一节，并在结论处重点提示未响应的 P0/P1。
    //     触发条件：存在同项目（编号或名称命中，不分提交人）的上一轮已完成审核，且有 s4_graded.json。
    //     失败不影响本次成果（对比为可选增值内容）。
    let compare = null;
    try {
      const prev = L.findPreviousAudit(L.listTasks(), {
        projectName: task.projectName, projectCode: task.projectCode, excludeTaskId: task.id,
      });
      if (prev) {
        const prevDir = L.taskDir(prev.id);
        const prevGradedFile = path.join(prevDir, 'run/s4_graded.json');
        if (fs.existsSync(prevGradedFile)) {
          const prevIssues = reportIssueList(JSON.parse(fs.readFileSync(prevGradedFile, 'utf8')), { scope: 'deep' });
          log(`发现同项目上一轮审核 ${prev.id}（${prev.ownerName || ''}）：对比上次 ${prevIssues.length} 条问题的响应情况…`);
          compare = await stageComparePrevious({
            apiKey: engineApiKey(), model: activeModelName(),
            reportText: text || task.pptText || '',
            prevIssues, prevMeta: prev, log,
          });
          if (compare) {
            fs.writeFileSync(path.join(dir, 'run/compare.json'), JSON.stringify(compare, null, 2), 'utf8');
            // 摘要写进任务元数据：台账「按项目」视图与任务详情直接用，不必再读 run/
            task.compare = {
              prevTaskId: compare.prevTaskId, prevAt: compare.prevAt, prevOwner: compare.prevOwner,
              stats: compare.stats, at: compare.generatedAt,
            };
            if (compare.stats.unfixedP0 > 0) {
              log(`  ⚠️ 上次问题里有 ${compare.stats.unfixedP0} 项 P0 未响应（报告结论处已红字提醒）`);
            }
          }
        } else {
          log(`同项目上一轮审核 ${prev.id} 没有留存问题清单（早期任务），本次不做对比`);
        }
      }
    } catch (e) {
      log(`⚠️ 与上一轮审核的对比失败（不影响本次成果）：${e.message}`);
    }

    let prep = null, annotateTiers = null;
    try {
      log('原报告标注版：解析原报告并逐条定位…');
      prep = await prepareAnnotation({
        taskDir: dir,
        preferPptx: !fs.readdirSync(dir).some(f => /\.docx$/i.test(f) && !/extracted/i.test(f) && !/^~\$/.test(f)),
        log: (m) => log('  ' + m),
      });
      annotateTiers = {};
      for (const it of prep.items) annotateTiers[it.no] = { tier: it.tier, how: it.how, page: it.page };
      const miss = prep.items.filter(x => x.tier === 'none').length;
      log(`  定位完成：共 ${prep.items.length} 条，其中未能在原报告中标出位置的 ${miss} 条（报告里已红字提示）`);
    } catch (e) {
      log(`⚠️ 标注版定位失败（成果照常出，标注版可在下载时现场生成）：${e.message}`);
    }

    const htmlFull = renderHtmlReport({ task: reportMeta, graded: g, narrative: result.narrative, deepAccess: true, model: activeModelName(), annotateTiers, compare });
    const htmlPf = renderHtmlReport({ task: reportMeta, graded: g, narrative: result.narrative, deepAccess: false, model: activeModelName(), annotateTiers, compare });
    fs.writeFileSync(path.join(dir, 'report.html'), htmlPf, 'utf8');          // 默认（普通用户）
    fs.writeFileSync(path.join(dir, 'report.deep.html'), htmlFull, 'utf8');   // 完整版
    fs.writeFileSync(path.join(dir, 'narrative.md'), result.narrative || '', 'utf8');
    if (annotateTiers) fs.writeFileSync(path.join(dir, 'annotate-tiers.json'), JSON.stringify(annotateTiers, null, 2), 'utf8');
    log('HTML 意见书已生成（含深度版与校对版）');

    // ④ 统计与成本核算（按完成的实际时段计费）
    const peak = L.isPeakHour();
    const u = result.usage || {};
    // 把预审（S0）的用量一并计入，否则费用少算一次调用
    if (pf?.usage) {
      u.prompt = (u.prompt || 0) + (pf.usage.prompt || 0);
      u.completion = (u.completion || 0) + (pf.usage.completion || 0);
      u.cacheHit = (u.cacheHit || 0) + (pf.usage.cacheHit || 0);
      u.cacheMiss = (u.cacheMiss || 0) + (pf.usage.cacheMiss || 0);
    }
    const allIssues = [...g.p0, ...g.p1, ...g.p2, ...g.p3];
    const pfCount = allIssues.filter(x => classify(x) === 'proofread').length;
    const dpCount = allIssues.length - pfCount;
    const cost = L.calcCost({
      model: activeModelName(),
      promptTokens: u.prompt || 0,
      completionTokens: u.completion || 0,
      cacheHitTokens: u.cacheHit || 0,
      peak,
    });
    task.stats = g.stats;
    task.usage = u;
    task.peak = peak;
    task.cost = cost;
    task.proofreadCount = pfCount;
    task.deepCount = dpCount;
    // 分权限口径：普通用户只看校对类计数，台账与详情不得泄露深度类规模
    task.proofreadP0 = g.p0.filter(x => classify(x) === 'proofread').length;
    task.proofreadP1 = g.p1.filter(x => classify(x) === 'proofread').length;
    task.unitStats = result.unitResults.map(x => ({ unit: x.unit, issues: x.issues.length, error: x.error || null }));
    const cc = {};
    for (const it of allIssues) cc[it.category] = (cc[it.category] || 0) + 1;
    task.categoryCounts = cc;
    task.p0List = g.p0.map(x => ({ whitelist: x.whitelist, category: x.category, description: (x.description || '').slice(0, 160) }));
    save();
    log(`本次用量：输入 ${u.prompt || 0} tok（缓存命中 ${u.cacheHit || 0}）／输出 ${u.completion || 0} tok　计费时段：${peak ? '高峰' : '闲时'}　估算 API 费用 ¥${cost}`);

    // ④.5 项目质量台账：台账由任务实时派生，这里只登记项目显示名；
    //      本次新增数与项目累计数在任务落盘后统一从派生值取，保证与看板一致。
    L.touchProject(task.projectName, { owner: task.ownerName, taskId: task.id });
    task.projectProofreadAdded = pfCount;
    save();
    {
      const row = L.projectStats(L.listTasks(), { limit: qc.limit }).find(x => x.key === qc.key);
      task.projectProofreadTotal = row ? row.proofreadTotal : pfCount;
      save();
      log(`项目质量台账：项目「${row ? row.name : task.projectName}」累计校对类问题 ${task.projectProofreadTotal} 项（上限 ${qc.limit}），本次新增 ${pfCount} 项`);
    }

    // ⑤ 导出「可下载的成果」：HTML → PDF（使用本机浏览器的打印引擎，版式与页面一致）。
    //    校对版与审核版各出一份，下载时按权限给出对应版本。
    //    不再导出 Word：pandoc 转换的表格与分页会出现版式偏差。
    log('导出 PDF 成果…');
    for (const [src, dst, label] of [
      ['report.html', '校对成果.pdf', '校对成果'],
      ['report.deep.html', '审核成果.pdf', '审核成果'],
    ]) {
      const sp = path.join(dir, src);
      if (!fs.existsSync(sp)) continue;
      try {
        await L.exportPdfFromHtml(sp, path.join(dir, dst));
        log(`${label} PDF 已生成（${Math.round(fs.statSync(path.join(dir, dst)).size / 1024)} KB）`);
      } catch (e) {
        log(`${label} PDF 生成失败（不影响网页查看，下载时会回退为 HTML）：${e.message}`);
      }
    }

    // ⑤.5 原报告标注版：审核时一并生成，使用方调用下载即直接下载，无需现场等待。
    //
    // 移至此处的原因：此前为调用按钮时现场生成，95 页需等待十几秒、大报告 40 秒以上，
    // 且看不到进度，切走再回来会被认为需要重新生成。
    // 审核本身已在后台运行（数分钟），本机 CPU 空闲；多花十几秒换取「点开即下」。
    // 生成失败不影响成果：标注版仍可按需现场生成（见 /api/tasks/:id/annotate）。
    //
    // 2026-09-28: 该步骤此前一直失败（pdftoppm 在生产环境找不到），且失败仅记录在服务器日志，
    //    界面上仍是「需要点击才生成」的按钮，使用方因此认为系统要求手动点击且需等待。
    //    失败原因现写入任务元数据（annotateError），界面据此显示原因并提供手动重试入口。
    log('生成原报告标注版（校对版 / 审核版）…');
    const tc = toolchainStatus();
    if (!tc.ok) log(`⚠️ 标注工具不齐：${toolchainHint(tc)}`);
    // 2026-09-28: 配对任务（同时有报告 + PPT）另加两路 PPT 标注版。
    // 此前含 PPT 一致性核对的任务可下载的标注版均为报告的标注版，缺少 PPT 标注版。
    const paired = hasPairedPpt(dir);
    const jobs = [['proof', ''], ['deep', '']];
    if (paired) jobs.push(['proof', 'ppt'], ['deep', 'ppt']);
    if (paired) log('检测到报告 + PPT 配对任务：同时生成 PPT 标注版（校对 / 审核）…');
    for (const [scope, kind] of jobs) {
      const label = (kind === 'ppt' ? 'PPT-标注版-' : '标注版-') + (scope === 'proof' ? '校对版' : '审核版');
      const key = annotateKeyOf(scope, kind);
      try {
        const st = (prep && kind !== 'ppt')
          ? await renderScopePdf({ prep, scope, outPdf: annotateOut(task.id, scope, kind), meta: { taskId: task.id, sourceName: task.sourceName } })
          : await buildAnnotatedPdf({
              taskDir: dir, scope, kind, outPdf: annotateOut(task.id, scope, kind),
              preferPptx: !fs.readdirSync(dir).some(f => /\.docx$/i.test(f) && !/extracted/i.test(f) && !/^~\$/.test(f)),
              log: (m) => log('  ' + m),
            });
        task.annotate = { ...(task.annotate || {}), [key]: {
          total: st.total, exact: st.exact, approx: st.approx, section: st.section, none: st.none,
          approxNumber: st.approxNumber, rate: st.rate, exactRate: st.exactRate, coverRate: st.coverRate,
          pages: st.pages, bytes: st.bytes, seconds: st.seconds || prep?.seconds || 0, at: new Date().toISOString(),
        } };
        if (task.annotateError) delete task.annotateError[key];   // 这次成功了，清掉旧错误
        save();
        log(`${label}：标注 ${st.total} 条 · 精确定位 ${st.exact}（${st.exactRate}%）· 近似 ${st.approx} · 章节 ${st.section} · 未能定位 ${st.none}`);
      } catch (e) {
        // 失败原因落盘（连带修复指引），界面直接显示，不再仅记录于服务器日志
        task.annotateError = { ...(task.annotateError || {}), [key]: { at: new Date().toISOString(), error: e.message, hint: tc.ok ? '' : toolchainHint(tc) } };
        save();
        log(`${label} 生成失败（不影响成果；下载时会自动现场重试）：${e.message}`);
      }
    }
    if (prep) cleanupAnnotation(prep);

    task.status = 'done'; task.finishedAt = new Date().toISOString();
    save();
    log(`审核完成：P0 ${g.stats.p0Count} / P1 ${g.stats.p1Count} / P2 ${g.stats.p2Count}`);

  } catch (e) {
    task.status = 'failed'; task.finishedAt = new Date().toISOString(); task.error = e.message;
    save();
    log(`失败：${e.message}`);
  }
}

// ─────────────── 补充审核（管理员定向加审）───────────────
//
// 场景：管理员查阅一轮成果后需要进一步核查某一方面（如「重点核这个投资口径」/「再查一遍建议的针对性」），
//       填写补充要求 → 系统针对该要求做一次定向深入核查 → 单独出一份《补充审核意见》HTML。
//
// 实现取舍：复用首轮已抽取的 S1 事实（run/s1_facts.json）与报告正文（report.md），
//           仅发起 1 次 API 调用。整条流水线为 9 次调用，补充审核不应重复支付该费用。
// 结果单独存放，不覆盖常规成果，支持多轮累积，便于逐轮追溯。

const supplementJobs = [];        // 内存队列（服务重启后未完成的任务标记为中断，不自动重跑，避免产生意外费用）
let supplementRunning = false;
const MAX_SUPPLEMENT_NOTE = 800;

// 每轮使用独立子目录：此前未带 sid，多轮补充审核会互相覆盖同名文件。
function supplementDir(taskId, sid) { return path.join(L.taskDir(taskId), 'supplements', sid); }
function supplementFile(taskId, sid, name) { return path.join(supplementDir(taskId, sid), name); }

async function runSupplement(taskId, sid) {
  const task = L.getTask(taskId);
  if (!task) return;
  const rec = (task.supplements || []).find(x => x.sid === sid);
  if (!rec) return;
  const dir = L.taskDir(taskId);
  const sdir = supplementDir(taskId, sid);
  fs.mkdirSync(sdir, { recursive: true });
  const log = (msg) => { console.log(`[${taskId}/${sid}] ${msg}`); };

  try {
    rec.status = 'running'; rec.startedAt = new Date().toISOString();
    L.saveTask(task);

    const reportTextPath = path.join(dir, 'report.md');
    const factsPath = path.join(dir, 'run', 's1_facts.json');
    if (!fs.existsSync(reportTextPath) || !fs.existsSync(factsPath)) {
      throw new Error('缺少首轮产物（report.md / s1_facts.json），无法补充审核');
    }
    const reportText = fs.readFileSync(reportTextPath, 'utf8');
    const facts = JSON.parse(fs.readFileSync(factsPath, 'utf8'));

    log(`开始补充审核（第 ${rec.round} 轮）：${rec.note.slice(0, 60)}${rec.note.length > 60 ? '…' : ''}`);
    const skillMain = readSkill('SKILL.md');

    const { issues, meta } = await stageSupplementAudit({
      apiKey: engineApiKey(), model: activeModelName(),
      reportText, facts, note: rec.note, skillMain,
      log: (m) => log(m),
      learned: readSkillOptional('LEARNED.md'),
      // 定向经验按两个维度同时注入：报告类型（一类报告的通病）+ 指定项目（该项目的特殊要求）。
          // projectType 在 S0 预审后才确定；未识别时按名称/文件名回退推断，宁可少注入也不要注入错。
          projectLearned: L.learnedForContext({
            projectName: task.projectName,
            projectType: task.projectType || L.guessProjectType(task.projectName, task.sourceName, task.templateName),
          }),
    });

    // 与常规审核使用同一套判定：执行一遍规则 + 分级闸门
    const ruleIssues = stage3Rules({ facts, log });
    const graded = stage4Grade({
      unitResults: [{ unit: 'supplement', issues }],
      ruleIssues: [],
      log,
    });
    fs.writeFileSync(supplementFile(taskId, sid, 'graded.json'), JSON.stringify(graded, null, 2), 'utf8');

    // 计费（按实际完成的时段）
    const peak = L.isPeakHour();
    const u = meta.usage || {};
    const cost = L.calcCost({
      model: activeModelName(),
      promptTokens: u.prompt || 0, completionTokens: u.completion || 0,
      cacheHitTokens: u.cacheHit || 0, peak,
    });

    const html = renderSupplementReport({
      task,
      note: rec.note,
      graded,
      meta: { ...rec, model: activeModelName(), cost, usage: u, peak },
    });
    fs.writeFileSync(supplementFile(taskId, sid, 'supplement.html'), html, 'utf8');
    // 和常规成果一致，同时出一份 PDF 供下载/归档
    try {
      await L.exportPdfFromHtml(supplementFile(taskId, sid, 'supplement.html'),
        supplementFile(taskId, sid, '补充审核意见.pdf'));
      log(`补充审核 PDF 已生成（${Math.round(fs.statSync(supplementFile(taskId, sid, '补充审核意见.pdf')).size / 1024)} KB）`);
    } catch (e) {
      log(`补充审核 PDF 生成失败（不影响网页查看）：${e.message}`);
    }

    rec.status = 'done';
    rec.finishedAt = new Date().toISOString();
    rec.stats = graded.stats;
    rec.cost = cost; rec.peak = peak; rec.usage = u;
    rec.ruleHits = ruleIssues.length;
    // 该轮查出的 P0/P1 也计入任务总数，台账口径才完整
    rec.issues = [...graded.p0, ...graded.p1, ...(graded.p2 || []), ...(graded.p3 || [])]
      .map(x => ({ category: x.category, whitelist: x.whitelist, description: (x.description || '').slice(0, 200) }));
    L.saveTask(task);

    // 补充审核查出的问题也计入项目质量台账（台账为派生值，这里只登记项目名）
    if (task.projectName) {
      L.touchProject(task.projectName, { owner: task.ownerName, taskId });
    }
    log(`补充审核完成：P0 ${graded.stats.p0Count} / P1 ${graded.stats.p1Count}，费用 ¥${cost}（${peak ? '高峰' : '空闲'}），已生成 supplement.html`);
  } catch (e) {
    rec.status = 'failed'; rec.error = e.message; rec.finishedAt = new Date().toISOString();
    L.saveTask(task);
    log(`补充审核失败：${e.message}`);
  }
}

function pumpSupplements() {
  if (supplementRunning) return;
  const job = supplementJobs.shift();
  if (!job) return;
  supplementRunning = true;
  runSupplement(job.taskId, job.sid)
    .catch(e => console.error('[supplement] 异常:', e.message))
    .finally(() => { supplementRunning = false; pumpSupplements(); });
}

// ─────────────── 路由 ───────────────

async function handleApi(req, res, url) {
  const p = url.pathname;

  // 全局白名单闸门：放在最前面，名单外的 IP 连登录接口都到不了（采用直接拦截策略）。
  // clientIp 必须定义为模块级函数：此处比下面的路由代码更早执行，
  // 若写成函数内的 `const clientIp = ...`，此处会触发 TDZ 抛错。
  if (blockedByAllowlist(req, res, clientIp(req))) return;

  // 每账号绑定闸门集中在此处，保证任何接口（含 /api/me、/api/logout 这类直接使用
  // currentUser 的接口）都经过校验。此前只写在 requireUser 中，/api/me 可绕过该校验，
  // 页面提示「已绑定」但实际未拦截；该问题由自检（③）发现。
  const sessionUser = currentUser(req);
  if (sessionUser) {
    const ip0 = clientIp(req);
    const v0 = L.checkIpAccess({ ip: ip0, user: sessionUser, cfg: L.getSystemConfig(), boundIps: boundIpsCached() });
    if (!v0.allowed) {
      L.appendAccessLog({ ip: ip0, userId: sessionUser.id, name: sessionUser.name, path: req.url || '',
        ua: req.headers['user-agent'] || '', reason: v0.reason, scope: v0.scope });
      console.warn(`[访问控制] 拒绝 ${sessionUser.name}（${ip0}）：${v0.reason}`);
      return json(res, 403, { error: v0.reason, clientIp: ip0, scope: v0.scope, boundIps: sessionUser.allowedIps || [] });
    }
  }

  // —— 认证 ——

  // 验证码图片：登录前就要能取，所以不需要登录态
  if (p === '/api/captcha' && req.method === 'GET') {
    const c = L.newCaptcha();
    return json(res, 200, { cid: c.cid, svg: c.svg });
  }

  if (p === '/api/login' && req.method === 'POST') {
    const { username, password, captchaId, captchaAnswer } = await readJsonBody(req);
    const ip = clientIp(req);
    const u = L.listUsers().find(x => x.username === username && !x.disabled);

    // ① 先看防护状态：锁定了直接拒，连密码都不比（省算力，也避免被当算力放大器）
    const g0 = L.loginGuardStatus(u ? u.id : '', ip);
    if (g0.locked) {
      L.recordAuthEvent({ userId: u.id, name: u.name, event: 'fail', req, note: '账号已锁定' });
      console.log(`[审计] 拒绝登录：${u.name} 账号已锁定，还有约 ${g0.lockMinutesLeft} 分钟`);
      return json(res, 429, {
        error: `该账号因连续输错密码已锁定，请约 ${g0.lockMinutesLeft} 分钟后再试；急需登录请联系管理员解锁。`,
        locked: true, minutesLeft: g0.lockMinutesLeft, needCaptcha: false,
      });
    }
    if (g0.ipBlocked) {
      console.log(`[审计] 拒绝登录：来源 ${ip} 尝试过于频繁，已暂时拒绝`);
      return json(res, 429, {
        error: `该来源尝试登录过于频繁，已暂时拒绝，请约 ${g0.ipMinutesLeft} 分钟后再试。`,
        ipBlocked: true, minutesLeft: g0.ipMinutesLeft, needCaptcha: false,
      });
    }

    // ② 连续失败达到阈值后要求验证码（自托管，不依赖外网，断网也能用）
    if (g0.needCaptcha) {
      if (!captchaId || !L.checkCaptcha(captchaId, captchaAnswer)) {
        L.recordAuthEvent({ userId: u ? u.id : '', name: username || '', event: 'fail', req, note: '验证码未通过' });
        console.log(`[审计] 验证码未通过：${username || '（空）'} 来自 ${ip}`);
        return json(res, 401, {
          error: captchaId ? '验证码不正确或已过期，请重新输入' : '连续输错多次，请先完成验证码',
          needCaptcha: true,
        });
      }
    }

    // ③ 比对密码
    // 账号不存在时同样执行一次等代价的哈希比对：否则「账号不存在」会比「密码错误」快一个数量级，
    // 攻击者可依据响应时间枚举出真实存在的账号。这里用固定的假 hash 占据同等开销。
    const DUMMY_SALT = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const DUMMY_HASH = L.hashPassword('*不存在的账号*', DUMMY_SALT).hash;
    const passOk = u
      ? L.verifyPassword(password || '', u.salt, u.hash)
      : (L.verifyPassword(password || '', DUMMY_SALT, DUMMY_HASH), false);
    if (!passOk) {
      // 固定延迟：把机器速度从约 40 次/秒压到约 1 次/秒（正常使用一次即成功，无明显感知）
      await new Promise(r => setTimeout(r, L.GUARD.FAIL_DELAY_MS));
      const g = L.recordLoginFail(u ? u.id : '', ip);
      L.recordAuthEvent({ userId: u ? u.id : '', name: username || '', event: 'fail', req });
      console.log(`[审计] 登录失败：${username}${u ? `（${u.name}，密码错误）` : '（账号不存在）'} 来自 ${ip}`
        + `　累计失败 ${g.accountFails}${g.locked ? ' → 已锁定' : ''}`);
      return json(res, 401, {
        error: g.locked
          ? `密码错误次数过多，该账号已锁定 ${Math.round(L.GUARD.ACCOUNT_LOCK_MS / 60000)} 分钟。`
          : `用户名或密码错误（还可试 ${g.remainingAttempts} 次）`,
        needCaptcha: g.needCaptcha,
        remaining: g.remainingAttempts,
        locked: g.locked,
      });
    }

    // ④ 通过
    L.recordLoginSuccess(u.id, ip);
    const sid = L.createSession(u.id, req);
    // 同时记录来源 MAC（仅作核对参考，不参与拦截）：仅在登录时查询一次 ARP，
    // 频率低、代价小；管理员在「用户管理」中可看到该账号最近的来源机器。
    L.recordAuthEvent({ userId: u.id, name: u.name, event: 'login', req, mac: await lookupMac(ip) });
    // 登录是在线人数最可能增加的时刻，此处采样一次（峰值最多滞后到下一次采样）
    try { L.recordOnlineSample(L.onlineNow().count); } catch { /* 采样失败不影响登录 */ }
    // 会话 Cookie 不写 Max-Age：关闭浏览器即失效，以满足「下次打开网址需重新登录」的要求。
    //   服务端另有空闲 12 小时 + 绝对 7 天过期（见 L.sessionExpired），两端同时管理：
    //   浏览器何时丢弃 Cookie 无法约束攻击者，服务端必须自行判定。
    res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
    console.log(`[审计] 登录：${u.name}（${u.role}）来自 ${ip}（会话空闲 ${Math.round(L.SESSION_IDLE_MS / 3600000)} 小时过期）`);
    return json(res, 200, { id: u.id, username: u.username, name: u.name, role: u.role, defaultPassword: !!u.defaultPassword });
  }
  if (p === '/api/logout' && req.method === 'POST') {
    const sid = parseCookies(req)['sid'];
    const u = currentUser(req);
    L.destroySession(sid);
    if (u) L.recordAuthEvent({ userId: u.id, name: u.name, event: 'logout', req });
    res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    return json(res, 200, { ok: true });
  }
  if (p === '/api/me') {
    const u = currentUser(req);
    if (!u) return json(res, 200, null);
    const usage = L.usageOf(L.listTasks(), u.id);
    // token 明细不对普通用户显示（纯技术指标，无实际用途）：服务端不返回，而非仅前端隐藏。
    // 但 costMonth 必须返回给所有人：改用金额额度后，该值即其本人余额，
    //    不返回时界面会一直显示「已用 ¥0.00 / ¥100」，额度耗尽也无法判断原因。
    //    该值为其本人支出，不构成信息泄露。
    const canDeep = u.role === 'admin' || !!u.deepAccess;
    if (!canDeep) { delete usage.tokensMonth; }
    return json(res, 200, {
      id: u.id, username: u.username, name: u.name, role: u.role,
      defaultPassword: !!u.defaultPassword,
      deepAccess: canDeep,
      budget: u.role === 'admin' ? 0 : (u.budget ?? L.DEFAULT_BUDGET),
      usage, isPeak: L.isPeakHour(),
      nextOffPeak: L.nextOffPeakStart().toISOString(),
      // 「本次审核重点」的可选项只给管理员（前端据此渲染提交页对话框；
      // 非管理员得到空数组 → 界面不显示，服务端也会拒绝其传入的值）
      reviewFocusOptions: u.role === 'admin' ? L.REVIEW_FOCUS_OPTIONS : [],
      reviewNoteMax: L.REVIEW_NOTE_MAX,
      // 该账号能否自选「闲时/立即」：
      // 2026-09-28: 管理员在「系统管理 → 提交与调度」中关闭后，普通用户与审核专家不再看到该选择，
      // 一律立即调用；管理员本人始终可选。前端据此隐藏，服务端另有强制（见 resolveAuditMode）。
      idleChoiceAllowed: u.role === 'admin' || L.getSystemConfig().allowIdleChoice !== false,
      idleChoiceIsAdminOff: u.role !== 'admin' && L.getSystemConfig().allowIdleChoice === false,
      // 本机来源 IP 与 IP 绑定情况：便于使用方直接看到自己的 IP（被拦时便于报给管理员），
      // 也让前端能提示「该账号已绑定 IP，更换机器将无法登录」。
      clientIp: clientIp(req),
      allowedIps: u.allowedIps || [],
    });
  }

  // 用量统计（本人；管理员与审核专家可加 ?all=1 看全所）
  if (p === '/api/usage') {
    const u = requireUser(req, res); if (!u) return;
    const tasks = L.listTasks();
    const canSeeAll = u.role === 'admin' || !!u.deepAccess;
    const scope = (canSeeAll && url.searchParams.get('all') === '1') ? tasks : tasks.filter(t => t.owner === u.id);
    const done = scope.filter(t => t.status === 'done');
    const sum = done.reduce((s, t) => ({
      prompt: s.prompt + (t.usage?.prompt || 0),
      completion: s.completion + (t.usage?.completion || 0),
      cacheHit: s.cacheHit + (t.usage?.cacheHit || 0),
      cost: s.cost + (t.cost || 0),
    }), { prompt: 0, completion: 0, cacheHit: 0, cost: 0 });

    // 按人聚合（管理员视角）
    const byUser = {};
    for (const t of done) {
      const k = t.ownerName || t.owner;
      const r = byUser[k] ||= { count: 0, tokens: 0, cost: 0, p0: 0, cacheHit: 0 };
      r.count++; r.tokens += (t.usage?.prompt || 0) + (t.usage?.completion || 0);
      r.cost += t.cost || 0; r.p0 += t.stats?.p0Count || 0; r.cacheHit += t.usage?.cacheHit || 0;
    }
    const byDay = {};
    for (const t of done) {
      const d = (t.createdAt || '').slice(0, 10);
      (byDay[d] ||= { count: 0, cost: 0 }).count++;
      byDay[d].cost += t.cost || 0;
    }
    const u2 = L.usageOf(tasks, u.id);
    const canDeep = u.role === 'admin' || !!u.deepAccess;
    const payload = {
      scope: (canSeeAll && url.searchParams.get('all') === '1') ? 'all' : 'mine',
      canDeep,
      count: done.length,
      tokens: { prompt: sum.prompt, completion: sum.completion, cacheHit: sum.cacheHit },
      cost: Math.round(sum.cost * 100) / 100,
      cacheHitRate: sum.prompt ? Math.round(sum.cacheHit / sum.prompt * 1000) / 10 : 0,
      quota: {
        usedToday: u2.usedToday, usedMonth: u2.usedMonth,
        // costMonth 必须返回给前端：看板需计算「积分余额 = budget − 已用」。
        //    此前只返回 usedMonth，前端拿不到已用量，余额一直显示满额（经实测出现过）。
        costMonth: u2.costMonth,
        budget: u.role === 'admin' ? 0 : (u.budget ?? L.DEFAULT_BUDGET),
      },
      byUser: Object.entries(byUser).map(([name, v]) => ({ name, ...v, cost: Math.round(v.cost * 100) / 100 }))
        .sort((a, b) => b.cost - a.cost),
      byDay: Object.entries(byDay).sort().map(([day, v]) => ({ day, count: v.count, cost: Math.round(v.cost * 100) / 100 })),
      pricing: L.PRICING['deepseek-flash'],
      isPeak: L.isPeakHour(),
    };
    // 普通用户不展示 token / 缓存命中率 / 费用：服务端不返回，而非仅前端隐藏
    if (!canDeep) {
      for (const k of ['tokens', 'cost', 'cacheHitRate', 'byUser', 'byDay', 'pricing']) delete payload[k];
    }
    // 综合成本口径（API + 人工工时 + 设备摊销 + 年度测算）
    if (canDeep) {
      const model = L.getCostModel();
      const breakdown = L.computeCost({ apiCost: payload.cost, count: done.length, deepCount: done.length, model });
      const monthKey = L.toBeijing().toISOString().slice(0, 7);
      const monthTasks = done.filter(t => {
        const d = new Date(t.createdAt);
        return L.toBeijing(d).toISOString().slice(0, 7) === monthKey;
      });
      const monthsElapsed = Math.max(1, new Date().getDate());
      payload.costBreakdown = breakdown;
      payload.costModel = model;
      payload.annual = L.projectAnnual({
        monthCount: monthTasks.length,
        monthApiCost: monthTasks.reduce((s, t) => s + (t.cost || 0), 0),
        monthDeepCount: monthTasks.length,
        model, monthsElapsed,
      });
      payload.projectLimit = DEFAULT_PROJECT_LIMIT;
    }
    return json(res, 200, payload);
  }

  // ── 数据看板（驾驶舱）──
  // 范围：普通用户只有「我的」；管理员与审核专家可切「全部」。
  // 口径：P0/P1 与类别分布对普通用户只统计校对类，用量（token/缓存/费用）整块不下发。
  if (p === '/api/dashboard') {
    const u = requireUser(req, res); if (!u) return;
    const canDeep = u.role === 'admin' || !!u.deepAccess;
    const all = L.listTasks();
    const wantAll = canDeep && url.searchParams.get('scope') === 'all';
    const scoped = wantAll ? all : all.filter(t => t.owner === u.id);
    // 统计范围（闲时/忙时、积分饼图、API 费用口径三块共用）。必须在此处声明：
    // 此前只声明在下面的 `if (canDeep)` 块内，块外（apiCost / rangeMine）引用会抛出
    // `range is not defined`，导致整个看板接口 500（经实测出现过）。
    const range = String(url.searchParams.get('range') || 'all');

    // 本月 API 费用与本月审核次数（仅 canDeep 使用；按北京时间归月）
    // 只统计用量记录完整的任务，否则历史残缺记录会拉低本月费用（与合计口径保持一致）
    const bj = L.toBeijing;   // 北京时间（统一口径，见 lib.mjs 开头说明）
    const monthKey = bj(Date.now()).toISOString().slice(0, 7);
    const doneTasks = scoped.filter(t => t.status === 'done' && L.isUsageComplete(t));
    const monthTasks = doneTasks.filter(t => bj(t.createdAt).toISOString().slice(0, 7) === monthKey);
    const monthApiCost = monthTasks.reduce((s, t) => s + (t.cost || 0), 0);

    const payload = L.buildDashboard(scoped, {
      scope: wantAll ? 'all' : 'mine',
      canDeep,
      monthApiCost,
    });
    payload.viewer = { name: u.name, role: u.role, canSeeAll: canDeep };
    payload.projectTypes = L.projectTypeOrder();

    // ── 按人员 / 按项目类别汇总（2026-09-28: 项目台账板块需要分析，不只是列表）──
    // 与看板其它数字同源（同一份 scoped 任务），因此不会出现两处数字不一致。
    payload.rollup = L.buildRollups(scoped, { canDeep });
    // 积分是金额的等价物（1 积分 ≈ ¥1）：非管理员只能看到自己的数值。
    //    管理员看全部；普通用户的范围本就是「我的」；审核专家虽可查看全所工作量，
    //    但不返回他人积分。此处由服务端置空，前端隐藏列仅作第二道防护。
    if (u.role !== 'admin') {
      for (const k of ['byUser', 'byType']) {
        for (const b of payload.rollup[k]) if (b.name !== u.name) b.points = null;
      }
    }

    // ── 本月积分：额度与已用 ──
    // 普通用户与审核专家只看自己（额度余额属本人信息），管理员看全所合计。
    // 因此此处：非管理员返回个人 quota；管理员返回 pointsPool（各人预算之和与已用之和）。
    if (u.role === 'admin') {
      payload.pointsPool = L.pointsPool(all);
    } else {
      const own = L.usageOf(all, u.id);
      payload.quota = {
        usedToday: own.usedToday, usedMonth: own.usedMonth,
        costMonth: own.costMonth,
        budget: u.budget ?? L.DEFAULT_BUDGET,
      };
    }

    // 闲时 / 忙时调用统计 —— 属于看板范畴，随看板一次返回，不再单开接口
    if (canDeep) {
      payload.traffic = L.buildPeakStats(scoped, { range });
      // 范围的中文名（界面标签需用，如「已消耗…（本月 / 近 7 天）」）：从同一份 PEAK_RANGES 取，
      // 避免前后端各维护一份名单而产生不一致
      payload.traffic.rangeName = (L.PEAK_RANGES.find(r => r.key === range) || {}).name || range;
    }

    // ── 四、API 费用口径（只计 API，不含人工）──
    // 该口径即 API 价格，不折算人工工时。
    //
    // 2026-09-28: 卡片显示的「范围内 API 费用合计」此前不跟随统计范围（任意范围均为同一数值），
    //    且取自 `usage.cost`（范围内全部记录完整的任务，与时间范围无关）。
    //    现改为全部取自 `traffic`（同一份按范围过滤且只计记录完整的数据）：
    //    `cost / countedTasks / perAudit / perAuditTokens / incomplete*` 均随范围变化；
    //    「本月费用/年化」两项本应按月统计，保持不受范围影响（界面上注明其为月度口径）。
    if (canDeep) {
      const rate = L.PRICING['deepseek-flash'];
      const tf = payload.traffic || null;
      const costN = tf ? tf.total.cost : (payload.usage?.cost || 0);
      const costCount = tf ? (tf.completeCount || 0) : (payload.usage?.countedTasks || 0);
      const costTokens = tf ? tf.total.tokens : 0;
      const monthTasksCount = monthTasks.length;
      const daysElapsed = Math.max(1, bj(Date.now()).getUTCDate());

      // 年化：优先用「单次平均 × 预计年审核量」，样本不足时退回「本月节奏 × 年」
      const monthPaceAnnual = monthApiCost / daysElapsed * 365;
      payload.apiCost = {
        range: tf ? tf.range : null,               // 这份数字是按哪个范围算的（界面据此显示标题）
        rangeName: (L.PEAK_RANGES.find(x => x.key === range) || {}).name || range,   // 中文名，界面标题/小字都用它
        perAudit: costCount ? Math.round(costN / costCount * 100) / 100 : 0,   // 单次平均（范围内、只算记录完整的）
        perAuditTokens: costCount ? Math.round(costTokens / costCount) : 0,
        cost: costN,                               // 范围内合计
        countedTasks: costCount,
        incompleteTasks: tf ? (tf.excludedFromCost || 0) : (payload.usage?.incomplete.count || 0),
        incompleteCostForReference: tf ? (tf.excludedCostForReference || 0) : (payload.usage?.incomplete.cost || 0),
        monthCost: Math.round(monthApiCost * 100) / 100,   // 月度口径（不随范围变，界面注明）
        monthTasks: monthTasksCount,
        daysElapsed,
        annualFromMonthPace: Math.round(monthPaceAnnual * 100) / 100,
        rates: {
          peak: { inMiss: rate.peak.inMiss, inHit: rate.peak.inHit, out: rate.peak.out },
          offpeak: { inMiss: rate.offpeak.inMiss, inHit: rate.offpeak.inHit, out: rate.offpeak.out },
        },
      };
      payload.pricing = rate;
      payload.isPeak = L.isPeakHour();
      // 「我的」在所选范围内的实际消耗（审核专家的积分饼图需要它：专家可将上方范围切到
      // 「全部人员」查看工作量，但本人额度只能对减本人消耗，否则会以他人花费抵扣本人额度）
      const mineOnly = all.filter(t => t.owner === u.id);
      const mtf = L.buildPeakStats(mineOnly, { range });
      payload.rangeMine = { cost: mtf.total.cost, count: mtf.completeCount, range: mtf.range, rangeName: mtf.rangeName };
    }
    // 注：个人 quota / 全所 pointsPool 已在上方统一赋值（管理员为全所、其他人为个人），
    //     此处不再重复赋值。此前 quota 只在「非深度权限」分支中赋值，
    //     导致审核专家取不到自己的额度，积分饼图无法绘制。
    //
    // 2026-09-28: 管理员看板需要「目前在线」「最高在线」两个卡片，只给管理员
    // （属「使用情况」口径，与「使用人数」同级，审核专家不展示）。
    // 口径与提交页「谁在使用」完全一致：5 分钟内有活动的去重账号数。
    if (u.role === 'admin') {
      const live = L.onlineNow();
      // 看板每次打开时采样一次：峰值最多滞后一分钟，且不依赖定时器是否在运行
      const st = L.recordOnlineSample(live.count);
      payload.online = {
        current: live.count,
        sessions: live.sessions,
        peak: st.peak,
        peakAt: st.peakAt,
        dayPeak: st.dayPeak,
        dayPeakAt: st.dayPeakAt,
        windowMin: L.ONLINE_WINDOW_MS / 60000,
        samples: st.samples,
        lastSampleAt: st.lastSampleAt,
      };
    }
    return json(res, 200, payload);
  }

  // 闲时/忙时统计已并入 /api/dashboard（属于看板范畴），不再单开接口。
  // 这里保留一条兼容路由，避免旧页面缓存或外部脚本直接 404。
  if (p === '/api/peak-stats' && req.method === 'GET') {
    const u = requireUser(req, res); if (!u) return;
    console.log('[deprecated] /api/peak-stats 请改用 /api/dashboard?range=');
    const range = String(url.searchParams.get('range') || 'all');
    const all = L.listTasks();
    // 范围：管理员与审核专家可看全所
    const canSeeAll = u.role === 'admin' || !!u.deepAccess;
    const scoped = canSeeAll ? all : all.filter(t => t.owner === u.id);
    return json(res, 200, { scope: canSeeAll ? 'all' : 'mine', ...L.buildPeakStats(scoped, { range }) });
  }

  // ── AI 技能完善（人工反馈学习）──
  // 分层：人工意见 → 结构化经验条目（web/data/skill-feedback.json）
  //       → 生成 LEARNED.md（skill 目录）→ 引擎读取并注入审核提示。
  // Skill 原件（WorkBuddy 同步副本 SKILL.md）不做任何修改。
  if (p === '/api/skill-feedback') {
    const u = requireAdmin(req, res); if (!u) return;

    if (req.method === 'GET') {
      const list = L.listFeedback();
      const active = list.filter(x => x.status !== 'archived');
      let learnedAt = null, learnedSize = 0;
      try {
        if (fs.existsSync(L.LEARNED_FILE)) {
          const st = fs.statSync(L.LEARNED_FILE);
          learnedAt = st.mtime.toISOString(); learnedSize = st.size;
        }
      } catch { /* 忽略 */ }
      return json(res, 200, {
        list: list.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')),
        kinds: L.FEEDBACK_KINDS,
        stats: {
          total: list.length, active: active.length,
          global: active.filter(x => x.scope !== 'project' && x.scope !== 'type').length,
          byType: active.filter(x => x.scope === 'type').length,
          project: active.filter(x => x.scope === 'project').length,
          // 尚未经过 AI 融合审阅与勾选口径的条目数（提示存在已保存但未应用的经验）
          notApplied: active.filter(x => !x.appliedAt).length,
          byKind: L.FEEDBACK_KINDS.map(k => ({ key: k.key, name: k.name, n: active.filter(x => x.kind === k.key).length })),
        },
        learnedAt, learnedSize,
        skillDir: L.SKILL_DIR_LOCAL,
        learnedFile: L.LEARNED_FILE,
      });
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const action = body.action || 'add';
      let list = L.listFeedback();

      if (action === 'add') {
        const opinion = String(body.opinion || '').trim();
        if (!opinion) return json(res, 400, { error: '请填写人工审核意见（AI 要学的内容）' });
        if (opinion.length > 2000) return json(res, 400, { error: '单条意见不超过 2000 字，过长的请拆成多条' });
        const scope = ['project', 'type'].includes(body.scope) ? body.scope : 'global';
        // 一条经验可关联多个项目：同一类报告常有多份存在相同问题，不必逐条录入。
        // 兼容旧客户端传入的单个 projectName。
        const projectNames = (Array.isArray(body.projectNames) ? body.projectNames : [body.projectName])
          .map(s => String(s || '').trim().slice(0, 80)).filter(Boolean);
        const uniqProjects = [...new Set(projectNames)];
        // 按报告类型的作用域（「一类报告」）——经验最主要的归属维度
        const projectTypes = (Array.isArray(body.projectTypes) ? body.projectTypes : [body.projectType])
          .map(s => String(s || '').trim().slice(0, 40)).filter(Boolean);
        const uniqTypes = [...new Set(projectTypes)];
        const taskIds = (Array.isArray(body.taskIds) ? body.taskIds : [body.taskId])
          .map(s => String(s || '').trim().slice(0, 40)).filter(Boolean);
        const uniqTasks = [...new Set(taskIds)];
        if (scope === 'project' && !uniqProjects.length) {
          return json(res, 400, { error: '选了「指定项目」就必须至少指定一个项目' });
        }
        if (scope === 'type' && !uniqTypes.length) {
          return json(res, 400, { error: '选了「按报告类型」就必须至少选一个类型' });
        }
        // 「一句话口径」允许人工先写一条（也可留空，交给 AI 提炼候选）
        const lessons = (Array.isArray(body.lessons) ? body.lessons : [body.lesson])
          .map(s => String(s || '').trim().slice(0, 600)).filter(Boolean);
        const rec = {
          id: 'F' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
          createdAt: new Date().toISOString(),
          by: u.name,
          kind: L.FEEDBACK_KINDS.some(k => k.key === body.kind) ? body.kind : 'criteria',
          category: String(body.category || '').trim().slice(0, 30),
          // 单/多都写：单值字段供旧页面与列表展示使用，复数才是权威值
          taskId: uniqTasks[0] || '',
          taskIds: uniqTasks,
          projectName: uniqProjects[0] || '',
          projectNames: uniqProjects,
          projectTypes: uniqTypes,
          scope,
          opinion,
          lesson: lessons[0] || '',
          lessons: [...new Set(lessons)],
          status: 'active',
        };
        list.push(rec);
        L.saveFeedback(list);
        const scopeDesc = scope === 'type' ? `${uniqTypes.length} 类报告`
          : scope === 'project' ? `${uniqProjects.length} 个项目` : '全局';
        console.log(`[审计] ${u.name} 新增技能经验条目 ${rec.id}（${rec.kind}，${scopeDesc}）：${opinion.slice(0, 50)}`);
        return json(res, 200, { ok: true, id: rec.id, note: '已保存。点「审阅并应用到技能」后才会生效于后续审核。' });
      }

      // apply 对全部条目整体生效，不需要 id，因此必须放在 id 查找之前；
      // 否则会先被「条目不存在」拦截（此前出现过该问题）。
      if (action === 'apply') {
        const r = L.applyLearned();
        console.log(`[审计] ${u.name} 应用技能经验：LEARNED.md 已按 ${r.count} 条经验重新生成`);
        return json(res, 200, {
          ok: true, count: r.count,
          note: `已按 ${r.count} 条经验重新生成 LEARNED.md。后续审核（含补充审核）会带上这些经验；已完成的审核不受影响。`,
        });
      }

      const id = String(body.id || '');
      const rec = list.find(x => x.id === id);
      if (!rec) return json(res, 404, { error: '条目不存在' });

      if (action === 'update') {
        for (const k of ['kind', 'category', 'projectName', 'opinion', 'lesson', 'scope']) {
          if (body[k] !== undefined) rec[k] = String(body[k]).trim().slice(0, k === 'opinion' ? 2000 : 600);
        }
        L.saveFeedback(list);
        return json(res, 200, { ok: true });
      }
      if (action === 'archive' || action === 'restore') {
        rec.status = action === 'archive' ? 'archived' : 'active';
        L.saveFeedback(list);
        return json(res, 200, { ok: true, status: rec.status });
      }
      if (action === 'delete') {
        list = list.filter(x => x.id !== id);
        L.saveFeedback(list);
        console.log(`[审计] ${u.name} 删除技能经验条目 ${id}`);
        return json(res, 200, { ok: true });
      }
      return json(res, 400, { error: '未知操作' });
    }
  }

  // 预览将要生成的 LEARNED.md（不落盘）
  if (p === '/api/skill-learned-preview' && req.method === 'GET') {
    const u = requireAdmin(req, res); if (!u) return;
    return json(res, 200, { markdown: L.buildLearnedMarkdown(L.listFeedback()) });
  }

  // ── AI 融合审阅（不写入，只输出分析报告）──
  //
  // 该步骤的必要性：此前「生成并应用」是把经验条目拼成 Markdown 覆盖 LEARNED.md，
  // 完全不读取原技能，导致与原文冲突的口径同时写入提示，重复条目也照常追加。
  // 此处先由 AI 将新经验与原技能逐条对比，
  // 给出「新增 / 冲突 / 重复 / 细化」判定 + 融合建议 + 若干条候选口径，由人工勾选。
  //
  // 只读不写：确认写入是另一步（/api/skill-apply），确保人工保留否决权。
  if (p === '/api/skill-merge-review' && req.method === 'POST') {
    const u = requireAdmin(req, res); if (!u) return;
    const active = L.listFeedback().filter(x => x.status !== 'archived');
    if (!active.length) return json(res, 400, { error: '还没有生效中的经验条目，先「保存为经验条目」。' });

    // 技能正文：readSkill(rel) 必须传相对路径。
    // 此前此处写成 readSkill()，参数为空 → 抛错 → 被 catch 吞掉 → skillExcerpt 变为空串，
    // AI 在未读到技能的情况下「判断冲突」，实际只是复述人工意见中的内容。
    // 该错误不报错且结果看似正常，风险较高。因此下方把长度一并返回给前端，便于确认技能是否读入。
    let skill = '';
    let skillSource = '';
    try { skill = readSkill('SKILL.md'); skillSource = 'SKILL.md'; }
    catch (e1) {
      try { skill = readSkillOptional('SKILL.md') || ''; skillSource = skill ? 'SKILL.md（可选读法）' : ''; }
      catch { skill = ''; }
    }
    if (!skill) {
      return json(res, 500, {
        error: '读不到技能文件 SKILL.md，无法做融合对比。请确认 skill/petroleum-engineering-review/SKILL.md 存在。',
      });
    }
    // 技能文件较大（约 88KB），设一个上限，避免预算集中在流程说明上
    const SKILL_LIMIT = 120000;
    const skillExcerpt = skill.length > SKILL_LIMIT ? skill.slice(0, SKILL_LIMIT) : skill;

    const items = active.map(x => ({
      id: x.id,
      kind: x.kind,
      category: x.category || '',
      scope: L.scopeLabel(x),
      人工意见: (x.opinion || '').trim(),
      现有口径: L.feedbackLessons(x),
    }));

    const sys = [
      '你是工程咨询审核技能的维护助手。用户会给你一份**现有技能文件**和一批**人工新增的审核经验**。',
      '你的任务不是简单追加，而是**逐条判断并融合**，避免与现有技能冲突或重复。',
      '',
      '对每一条经验，判断它属于哪一类：',
      '- **新增**：技能里确实没有覆盖，应当加入。',
      '- **冲突**：与技能现有表述矛盾（必须引用技能原文指出冲突点）。',
      '- **重复**：技能里已经说过，无需再加。',
      '- **细化**：技能有原则但不够具体，可补充为更明确、可执行的口径。',
      '',
      '对「冲突」和「细化」，给出**融合后的表述**：既要体现人工意见，也不能丢掉技能原有的原则。',
      '融合时优先写成「条件 → 处置」的可执行形式，例如：',
      '「同一指标差异 <0.5% 且不影响结论 → 最高 P2；差异 ≥0.5% 或影响结论 → 按 P0-4 判」。',
      '',
      '另外，每条经验都要给出 **2~4 条候选口径**，供人工勾选：',
      '- 候选之间应有实质差异（不同角度、不同详略、或拆成多条独立规则），不要只是同义改写。',
      '- 一条人工意见里若含多个独立规则，应拆成多条候选。',
      '- 每条候选独立可执行，不带"同上""参见上文"之类的指代。',
      '',
      '严格输出 JSON，不要任何解释文字：',
      '{"items":[{"id":"经验ID","verdict":"新增|冲突|重复|细化","reason":"判断理由（≤80字）",'
        + '"conflictWith":"冲突时引用技能原文（≤60字），其余留空",'
        + '"candidates":["候选口径1","候选口径2"]}],'
        + '"summary":"整体建议（≤120字，指出最需要人工确认的冲突）"}',
    ].join('\n');

    const user = [
      '【现有技能文件】',
      skillExcerpt,
      '',
      '【人工新增的审核经验】',
      JSON.stringify(items, null, 1),
      '',
      '请逐条对比并输出 JSON。注意 candidates 是给人工勾选的，要覆盖不同写法与拆分方式。',
    ].join('\n');

    let raw;
    try {
      raw = await callDeepSeek({
        apiKey: engineApiKey(), model: activeModelName(),
        system: sys, user,
        maxTokens: 8000, temperature: 0.2, jsonMode: true,
      });
    } catch (e) {
      return json(res, 500, { error: '调用 AI 失败：' + e.message });
    }

    let parsed;
    try { parsed = extractJson(raw.content); }
    catch {
      return json(res, 500, { error: 'AI 返回的内容无法解析为 JSON，请重试。', raw: String(raw.content || '').slice(0, 600) });
    }
    const byId = new Map((parsed.items || []).map(x => [String(x.id), x]));
    // 把 AI 判定合并回条目，前端按经验逐条展示
    const merged = items.map(it => {
      const r = byId.get(String(it.id)) || {};
      const verdict = ['新增', '冲突', '重复', '细化'].includes(r.verdict) ? r.verdict : '新增';
      return {
        id: it.id, kind: it.kind, category: it.category, scope: it.scope,
        opinion: it['人工意见'], existing: it['现有口径'],
        verdict, reason: String(r.reason || '').slice(0, 200),
        conflictWith: String(r.conflictWith || '').slice(0, 200),
        candidates: (Array.isArray(r.candidates) ? r.candidates : []).map(s => String(s || '').trim()).filter(Boolean).slice(0, 6),
      };
    });
    // 注意：callDeepSeek 返回的 usage 字段名是 prompt / completion / cacheHit / cacheMiss，
    // 不是 promptTokens；传错会静默计为 ¥0（此前出现过）。
    const cost = L.calcCost({
      model: activeModelName(),
      promptTokens: raw.usage?.prompt || 0,
      completionTokens: raw.usage?.completion || 0,
      cacheHitTokens: raw.usage?.cacheHit || 0,
      peak: L.isPeakHour(),
    });
    console.log(`[审计] ${u.name} 发起技能融合审阅：${merged.length} 条经验，`
      + `新增 ${merged.filter(x => x.verdict === '新增').length} / 冲突 ${merged.filter(x => x.verdict === '冲突').length} `
      + `/ 重复 ${merged.filter(x => x.verdict === '重复').length} / 细化 ${merged.filter(x => x.verdict === '细化').length}`
      + `（约 ¥${(Math.round(cost * 10000) / 10000)}）`);
    return json(res, 200, {
      items: merged,
      summary: String(parsed.summary || ''),
      usage: raw.usage, cost,
      // 回传技能体量，便于直接确认技能是否已读入（此前技能为空时「分析」结果仍看似正常）
      skillChars: skillExcerpt.length, skillTotal: skill.length, skillSource,
      note: '这只是分析结果，**尚未写入技能**。勾选要保留的候选口径后点「确认写入」。',
    });
  }

  // ── 确认写入技能（人工确认后）──
  if (p === '/api/skill-apply' && req.method === 'POST') {
    const u = requireAdmin(req, res); if (!u) return;
    const body = await readJsonBody(req);
    // selections: { 经验ID: [选中的口径, ...] }
    const selections = body.selections && typeof body.selections === 'object' ? body.selections : null;
    if (!selections) return json(res, 400, { error: '缺少 selections（每条经验勾选的口径）' });

    const all = L.listFeedback();
    let touched = 0, lessonCount = 0;
    for (const x of all) {
      if (!(x.id in selections)) continue;
      const picked = (Array.isArray(selections[x.id]) ? selections[x.id] : [])
        .map(s => String(s || '').trim()).filter(Boolean).slice(0, 8);
      x.lessons = [...new Set(picked)];
      x.lesson = x.lessons[0] || '';          // 兼容老字段
      x.appliedAt = new Date().toISOString();
      touched++; lessonCount += x.lessons.length;
    }
    L.saveFeedback(all);
    const r = L.applyLearned();
    console.log(`[审计] ${u.name} 确认写入技能：${touched} 条经验、${lessonCount} 条口径；`
      + `LEARNED.md 现 ${r.count} 条经验`);
    return json(res, 200, { ok: true, applied: touched, lessons: lessonCount, ...r });
  }

  // ── 项目类型清单（看板分类维度）──
  if (p === '/api/project-types' && req.method === 'GET') {
    const u = requireUser(req, res); if (!u) return;
    return json(res, 200, { list: L.listProjectTypes() });
  }
  if (p === '/api/project-types' && req.method === 'POST') {
    const u = requireAdmin(req, res); if (!u) return;
    const { action, id, name, keywords } = await readJsonBody(req);
    let list = L.listProjectTypes();
    if (action === 'add') {
      const nm = String(name || '').trim().slice(0, 30);
      if (!nm) return json(res, 400, { error: '类型名称不能为空' });
      if (list.some(x => x.name === nm)) return json(res, 400, { error: '该类型已存在' });
      // 插入到回退项之前
      const tail = list.filter(x => x.name === L.FALLBACK_PROJECT_TYPE);
      const head = list.filter(x => x.name !== L.FALLBACK_PROJECT_TYPE);
      head.push({
        id: 'pt-' + crypto.randomBytes(3).toString('hex'),
        name: nm, enabled: true,
        keywords: String(keywords || '').split(/[,\s、，]+/).filter(Boolean),
      });
      list = [...head, ...tail];
    } else if (action === 'update') {
      const it = list.find(x => x.id === id);
      if (!it) return json(res, 404, { error: '类型不存在' });
      if (it.locked && name && name !== it.name) return json(res, 400, { error: '兜底类型不允许改名' });
      if (name) it.name = String(name).trim().slice(0, 30);
      if (keywords !== undefined) it.keywords = String(keywords).split(/[,\s、，]+/).filter(Boolean);
    } else if (action === 'toggle') {
      const it = list.find(x => x.id === id);
      if (!it) return json(res, 404, { error: '类型不存在' });
      if (it.locked) return json(res, 400, { error: '兜底类型不能停用' });
      it.enabled = it.enabled === false;
    } else if (action === 'delete') {
      const it = list.find(x => x.id === id);
      if (!it) return json(res, 404, { error: '类型不存在' });
      if (it.locked) return json(res, 400, { error: '兜底类型不能删除' });
      list = list.filter(x => x.id !== id);
    } else {
      return json(res, 400, { error: '未知操作' });
    }
    L.saveProjectTypes(list);
    return json(res, 200, { ok: true, list });
  }

  // ── 在线会话（管理员）──
  if (p === '/api/sessions' && req.method === 'GET') {
    const u = requireAdmin(req, res); if (!u) return;
    const purged = L.purgeOrphanSessions();       // 一并清理账号已删除的死会话
    if (purged) console.log(`[审计] 清理了 ${purged} 条账号已删除的死会话`);
    const list = L.listActiveSessions().map(x => ({ ...x, uaShort: L.shortUA(x.ua) }));
    // 同一账号可能开了多个标签页/浏览器 → 按人合并，同时保留明细
    const byUser = new Map();
    for (const s of list) {
      const k = s.userId || s.name;
      const r = byUser.get(k) || { userId: s.userId, name: s.name, role: s.role, online: false, sessions: 0, lastSeenAt: s.lastSeenAt, firstLoginAt: s.loginAt, ips: new Set(), uaShort: s.uaShort };
      r.sessions++;
      if (s.online) r.online = true;
      if (s.lastSeenAt > r.lastSeenAt) r.lastSeenAt = s.lastSeenAt;
      if (s.loginAt < r.firstLoginAt) r.firstLoginAt = s.loginAt;
      if (s.ip) r.ips.add(s.ip);
      byUser.set(k, r);
    }
    const users = [...byUser.values()].map(x => ({ ...x, ips: [...x.ips], onlineWindowMin: L.ONLINE_WINDOW_MS / 60000 }))
      .sort((a, b) => (b.online - a.online) || String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
    return json(res, 200, {
      sessions: list, users,
      onlineCount: users.filter(x => x.online).length,
      totalSessions: list.length,
      onlineWindowMin: L.ONLINE_WINDOW_MS / 60000,
      now: new Date().toISOString(),
    });
  }

  // ── 单个用户的使用日志（管理员）──
  if (p === '/api/user-log' && req.method === 'GET') {
    const admin = requireAdmin(req, res); if (!admin) return;
    const id = String(url.searchParams.get('id') || '');
    const target = L.listUsers().find(x => x.id === id);
    if (!target) return json(res, 404, { error: '用户不存在' });

    const tasks = L.listTasks().filter(t => t.owner === target.id);
    const events = L.listAuthEvents({ userId: target.id, limit: 300 });
    const sessions = L.listActiveSessions().filter(s => s.userId === target.id)
      .map(s => ({ ...s, uaShort: L.shortUA(s.ua) }));
    const quota = L.usageOf(L.listTasks(), target.id);

    // 从任务记录中一并提取任务删除与补充审核的发起记录，构成完整轨迹
    const supplements = [];
    for (const t of L.listTasks()) {
      for (const s of (t.supplements || [])) {
        if (s.byId === target.id || s.by === target.name) {
          supplements.push({ taskId: t.id, round: s.round, at: s.createdAt, status: s.status, note: s.note, cost: s.cost });
        }
      }
    }

    // 时间线：登录/登出 + 提交 + 补充审核，按时间倒序
    const timeline = [
      ...events.map(e => ({
        at: e.at, kind: e.event === 'login' ? '登录' : e.event === 'logout' ? '登出' : '登录失败',
        type: e.event, text: `${e.name || target.name}${e.event === 'fail' ? ' 登录失败' : e.event === 'login' ? ' 登录系统' : ' 退出登录'}`,
        ip: e.ip, ua: L.shortUA(e.ua),
      })),
      ...tasks.map(t => ({
        at: t.createdAt, kind: '提交审核', type: 'submit',
        text: `提交《${t.sourceName}》${t.projectName ? `（${t.projectName}）` : ''} → ${t.status}`,
        taskId: t.id,
      })),
      ...supplements.map(s => ({
        at: s.at, kind: '补充审核', type: 'supplement',
        text: `对任务 ${s.taskId} 发起第 ${s.round} 轮补充审核：${String(s.note || '').slice(0, 40)}`,
        taskId: s.taskId,
      })),
    ].filter(x => x.at).sort((a, b) => String(b.at).localeCompare(String(a.at)));

    return json(res, 200, {
      user: {
        id: target.id, name: target.name, username: target.username, role: target.role,
        deepAccess: !!target.deepAccess, disabled: !!target.disabled,
        level: target.role === 'admin' ? 'admin' : (target.deepAccess ? 'expert' : 'user'),
        budget: target.budget ?? L.DEFAULT_BUDGET,
        
        defaultPassword: !!target.defaultPassword,
      },
      quota,
      stats: {
        loginCount: events.filter(e => e.event === 'login').length,
        failCount: events.filter(e => e.event === 'fail').length,
        taskCount: tasks.length,
        doneCount: tasks.filter(t => t.status === 'done').length,
        failedCount: tasks.filter(t => t.status === 'failed').length,
        supplementCount: supplements.length,
        activeSessions: sessions.length,
        online: sessions.some(s => s.online),
        firstSeen: events.length ? events[events.length - 1].at : (tasks.length ? tasks[tasks.length - 1].createdAt : null),
        lastSeen: events.length ? events[0].at : (tasks.length ? tasks[0].createdAt : null),
      },
      sessions,
      tasks: tasks.slice(0, 200).map(t => ({
        id: t.id, sourceName: t.sourceName, projectName: t.projectName || '', status: t.status,
        createdAt: t.createdAt, finishedAt: t.finishedAt,
        p0: t.stats?.p0Count ?? null, p1: t.stats?.p1Count ?? null,
        cost: t.cost ?? null, peak: !!t.peak,
      })),
      timeline: timeline.slice(0, 300),
    });
  }

  // ── 模型与接口设置（管理员）──
  // 换模型只改配置：服务商 / base_url / 模型名 / Key / 温度 / 上限。全部走 OpenAI 兼容协议。
  if (p === '/api/model-config' && req.method === 'GET') {
    const u = requireAdmin(req, res); if (!u) return;
    return json(res, 200, M.modelConfigSummary());
  }
  if (p === '/api/model-config' && req.method === 'POST') {
    const u = requireAdmin(req, res); if (!u) return;
    const body = await readJsonBody(req);
    const next = {};
    for (const k of ['providerId', 'model', 'baseUrl', 'temperature', 'maxTokens', 'jsonMode', 'note']) {
      if (body[k] !== undefined) next[k] = body[k];
    }
    // Key 三种语义：不传/留空＝不改；'__clear__'＝清除；其它＝更新
    if (body.apiKey === '__clear__') next.apiKey = '';
    else if (typeof body.apiKey === 'string' && body.apiKey.trim()) next.apiKey = body.apiKey.trim();
    const saved = M.saveModelConfig(next, { by: u.name });
    console.log(`[审计] ${u.name} 修改模型配置 → ${saved.providerId} / ${saved.model} / ${saved.baseUrl}（Key ${saved.apiKey ? '已设置' : '未设置'}）`);
    return json(res, 200, { ok: true, ...M.modelConfigSummary() });
  }
  // 拉取服务商的最新模型列表（管理员）：GET {baseUrl}/models
  //   必要性：各家模型迭代较快（智谱已非 glm-4.6、Kimi 已到 kimi-k3），
  //   写死在代码中的模型名必然过时；改为向服务商获取实时列表，后续更换模型无需改后台。
  //   失败时不向前端抛异常，而是返回 200 + 内置回退清单 + 失败原因：
  //      拉不到（无网络 / 服务商不提供 / Key 不正确）时界面仍可用，仅提示当前使用内置清单。
  if (p === '/api/model-config/models' && req.method === 'POST') {
    const u = requireAdmin(req, res); if (!u) return;
    const body = await readJsonBody(req).catch(() => ({}));
    const provider = P.getProvider(body.providerId || M.loadModelConfig().providerId);
    const baseUrl = String(body.baseUrl || provider.baseUrl || '').trim();
    // Key 只能用于其所属的服务商（见 keyForProvider 的说明）：
    // 此前此处使用 resolveApiKey()，会把环境变量中的 DeepSeek Key 发给智谱/百炼/Kimi，
    // 既必然返回 401（界面显示「拉取失败」），又把 Key 泄露给第三方。该问题已修复。
    const kf = M.keyForProvider(provider.id, { overrideKey: body.apiKey });
    const key = kf.key;
    const url = P.modelsListUrl(baseUrl);
    const fallback = { models: provider.models || [], source: 'preset', total: (provider.models || []).length, filtered: 0, keySource: kf.source, keyLabel: kf.label };
    if (!url) return json(res, 200, { ...fallback, reason: 'no-baseurl', error: '没填接口地址（base_url），无法拉取' });
    if (!kf.usable || !key) {
      // 这不是失败，只是该服务商尚未配置 Key；以 info 语气说明，避免以 401 造成误解
      return json(res, 200, { ...fallback, reason: 'no-key', error: kf.label });
    }
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 15000);
      let r;
      try {
        r = await fetch(url, { headers: { Authorization: 'Bearer ' + key }, signal: ctl.signal });
      } finally { clearTimeout(timer); }
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        throw new Error(`服务商返回 HTTP ${r.status}${txt ? '：' + txt.slice(0, 160) : ''}`);
      }
      const j = await r.json();
      const all = (Array.isArray(j.data) ? j.data.map(x => x && x.id) : []).filter(Boolean);
      // 未解析出任何模型时，截取原始结构片段提供给管理员，便于判断是接口变更还是格式差异
      if (!all.length) throw new Error('返回里没有 data[].id（该服务商可能不是 OpenAI 兼容的 /models 格式）');
      const chat = P.filterChatModels(all);
      const list = body.all ? all : (chat.length ? chat : all);   // 过滤后为空则退回原始列表，避免出现空下拉
      console.log(`[审计] ${u.name} 拉取模型列表：${provider.id} ${url} → ${all.length} 个（对话类 ${chat.length} 个，用 ${kf.label}）`);
      return json(res, 200, {
        models: list, source: 'live', total: all.length, filtered: all.length - chat.length,
        at: new Date().toISOString(), keySource: kf.source, keyLabel: kf.label,
      });
    } catch (e) {
      const msg = e.name === 'AbortError' ? '请求超时（15 秒）' : e.message;
      const badKey = /HTTP 401|HTTP 403/.test(msg);
      console.log(`[审计] ${u.name} 拉取模型列表失败：${provider.id} ${url} → ${msg}（用 ${kf.label}）`);
      return json(res, 200, {
        ...fallback,
        reason: badKey ? 'bad-key' : 'error',
        error: badKey
          ? `这把 Key 被「${provider.name}」拒绝（HTTP 401）—— 确认它属于这家服务商：${msg.slice(0, 120)}`
          : msg,
      });
    }
  }

  if (p === '/api/model-config/test' && req.method === 'POST') {
    const u = requireAdmin(req, res); if (!u) return;
    const body = await readJsonBody(req).catch(() => ({}));
    try {
      const r = await testModelConnection(body);
      console.log(`[审计] ${u.name} 测试模型连接成功：${body.providerId || ''} ${r.model}`);
      return json(res, 200, { ok: true, ...r });
    } catch (e) {
      console.log(`[审计] ${u.name} 测试模型连接失败：${e.message}`);
      return json(res, 200, { ok: false, error: e.message });
    }
  }

  // ── 项目质量台账（从任务实时派生，与看板口径一致）──
  if (p === '/api/projects') {
    const u = requireUser(req, res); if (!u) return;
    if (!(u.role === 'admin' || u.deepAccess)) return json(res, 200, { list: [], limit: DEFAULT_PROJECT_LIMIT, hidden: true });
    const limit = Number(url.searchParams.get('limit') || DEFAULT_PROJECT_LIMIT);
    return json(res, 200, { list: L.projectRanking(L.listTasks(), limit), limit });
  }
  if (p === '/api/projects/reset' && req.method === 'POST') {
    const u = requireAdmin(req, res); if (!u) return;
    const { key, name, newLimit } = await readJsonBody(req);
    if (newLimit !== undefined) {
      const projs = L.listProjects();
      projs.__limit = Number(newLimit) || DEFAULT_PROJECT_LIMIT;   // 存一个约定字段供前端读取
      L.saveProjects(projs);
      return json(res, 200, { ok: true, limit: projs.__limit });
    }
    // 清零 = 记一个 resetAt（只统计此后完成的任务）。不修改任务数据，留痕不受影响，
    // 且计数由任务派生，因此清零点之后新跑的任务会重新累计。
    const target = name || (L.projectStats(L.listTasks()).find(x => x.key === key) || {}).name || key;
    L.resetProject(target);
    console.log(`[审计] ${u.name} 将项目「${target}」的质量台账清零（记 resetAt，任务留档不变）`);
    return json(res, 200, { ok: true });
  }

  // ── 系统开关（项目质量配额是否拦截等）──
  // 读取同样归管理员：属「系统管理」中的开关，审核专家只需查看成果，无需接触系统配置。
  if (p === '/api/system-config' && req.method === 'GET') {
    const u = requireAdmin(req, res); if (!u) return;
    // 注：此处不再下发「实际生效白名单」清单，该清单仅用于展示、无实际作用。
    //     判断某账号能否访问，使用 POST /api/access-check（会给出两道闸门的结论）。
    return json(res, 200, L.getSystemConfig());
  }
  // ── 访问预检（仅管理员）：修改 IP / 新增账号后先行确认能否访问，无需等待报错 ──
  // 两道闸门都判定，并一次性给出结论与理由（登录前那道 + 每账号那道）。
  if (p === '/api/access-check' && req.method === 'POST') {
    const u = requireAdmin(req, res); if (!u) return;
    const body = await readJsonBody(req);
    const ip = String(body.ip || '').trim();
    if (!ip) return json(res, 400, { error: '请填一个 IP' });
    const cfg = L.getSystemConfig();
    const users = L.listUsers();
    const target = body.username
      ? users.find(x => x.username === body.username || x.name === body.username)
      : null;
    const bound = L.boundIpsOf(users);
    const eff = L.effectiveAllowlist(cfg, users);
    // ① 登录前那道（这时还不知道是谁）
    const beforeLogin = L.checkIpAccess({ ip, user: null, cfg, boundIps: bound });
    // ② 登录后那道（按指定账号判"每账号绑定"）
    const asUser = target ? L.checkIpAccess({ ip, user: target, cfg, boundIps: bound }) : null;
    // 绑定了该 IP 的账号（便于管理员核对该机器是否为本人使用）
    const owners = users.filter(x => (x.allowedIps || []).length && L.ipAllowed(ip, x.allowedIps)).map(x => x.name);
    return json(res, 200, {
      ip,
      username: target ? target.username : '',
      canOpenPage: beforeLogin.allowed,
      beforeLogin,
      asUser,
      boundOwners: owners,
      effectiveCount: eff.list.length,
      explicitCount: eff.explicit.length,
      autoCount: eff.auto.length,
      restricted: eff.restricted,
      verdict: beforeLogin.allowed && (!asUser || asUser.allowed) ? 'ok' : 'blocked',
    });
  }
  if (p === '/api/system-config' && req.method === 'POST') {
    const u = requireAdmin(req, res); if (!u) return;
    const body = await readJsonBody(req);
    // duplicateMode 只接受两个已知取值，避免前端传错把拦截逻辑弄失效
    if (body.duplicateMode !== undefined && !['block', 'warn'].includes(body.duplicateMode)) {
      return json(res, 400, { error: "duplicateMode 只能是 'block'（暂停等确认）或 'warn'（只提醒）" });
    }
    // 闲时选择开关同理：只接受布尔，避免传成字符串后 `=== false` 判断失效（那会让开关"关不掉"）
    if (body.allowIdleChoice !== undefined && typeof body.allowIdleChoice !== 'boolean') {
      return json(res, 400, { error: 'allowIdleChoice 只能是 true / false' });
    }
    // 2026-09-28: IP 访问控制的开关与豁免同样需严格校验类型，
    // 否则前端传入字符串 "false" 会使 `=== false` 判断失效，紧急情况下无法关闭访问控制。
    if (body.ipEnforce !== undefined && typeof body.ipEnforce !== 'boolean') {
      return json(res, 400, { error: 'ipEnforce 只能是 true / false' });
    }
    if (body.ipExemptAdmins !== undefined && typeof body.ipExemptAdmins !== 'boolean') {
      return json(res, 400, { error: 'ipExemptAdmins 只能是 true / false' });
    }
    // 本机豁免：127.0.0.1 为本机地址，任何操作都不设限制
    if (body.ipExemptLocal !== undefined && typeof body.ipExemptLocal !== 'boolean') {
      return json(res, 400, { error: 'ipExemptLocal 只能是 true / false' });
    }
    if (body.ipAllowlist !== undefined) {
      if (!Array.isArray(body.ipAllowlist)) return json(res, 400, { error: 'ipAllowlist 要传字符串数组' });
      body.ipAllowlist = L.normalizeIpList(body.ipAllowlist);
    }
    // 免限制 IP：127.0.0.1 与 192.0.2.161 属同一台机器，任何操作都不设限制
    if (body.ipFreeList !== undefined) {
      if (!Array.isArray(body.ipFreeList)) return json(res, 400, { error: 'ipFreeList 要传字符串数组' });
      body.ipFreeList = L.normalizeIpList(body.ipFreeList);
    }
    const saved = L.saveSystemConfig(body);
    if (body.ipAllowlist !== undefined || body.ipEnforce !== undefined) {
      console.log(`[审计] ${u.name} 修改访问控制：开关=${saved.ipEnforce ? '开启' : '临时关闭'}`
        + `　全局白名单 ${saved.ipAllowlist.length} 条${saved.ipAllowlist.length ? '（' + saved.ipAllowlist.join('、') + '）' : '（不限制）'}`
        + `　管理员豁免=${saved.ipExemptAdmins ? '是' : '否'}`);
    }
    return json(res, 200, saved);
  }

  // ── 被拒访问流水（仅管理员）：记录被拦的账号与 IP，用于排查访问失败 ──
  if (p === '/api/access-log' && req.method === 'GET') {
    const u = requireAdmin(req, res); if (!u) return;
    const list = L.listAccessLog();
    return json(res, 200, { list: list.slice(-80).reverse(), total: list.length, clientIp: clientIp(req) });
  }
  if (p === '/api/access-log' && req.method === 'POST') {
    const u = requireAdmin(req, res); if (!u) return;
    fs.rmSync(L.ACCESS_LOG_FILE, { force: true });
    console.log(`[审计] ${u.name} 清空了被拒访问流水`);
    return json(res, 200, { ok: true });
  }

  // ── 综合成本模型（API + 人工 + 设备摊销）──
  // 读取同样归管理员：属管理口径（费用测算前提），审核专家无需修改或查看这些参数。
  if (p === '/api/cost-model' && req.method === 'GET') {
    const u = requireAdmin(req, res); if (!u) return;
    return json(res, 200, L.getCostModel());
  }
  if (p === '/api/cost-model' && req.method === 'POST') {
    const u = requireAdmin(req, res); if (!u) return;
    const body = await readJsonBody(req);
    const cur = L.getCostModel();
    const next = {
      ...cur, ...body,
      labor: { ...cur.labor, ...(body.labor || {}) },
      infra: { ...cur.infra, ...(body.infra || {}) },
    };
    L.saveCostModel(next);
    return json(res, 200, next);
  }
  if (p === '/api/password' && req.method === 'POST') {
    const u = requireUser(req, res); if (!u) return;
    const { oldPassword, newPassword } = await readJsonBody(req);
    if (!L.verifyPassword(oldPassword || '', u.salt, u.hash)) return json(res, 400, { error: '原密码错误' });
    if (!newPassword || newPassword.length < 6) return json(res, 400, { error: '新密码至少 6 位' });
    const users = L.listUsers(); const t = users.find(x => x.id === u.id);
    Object.assign(t, L.hashPassword(newPassword));
    t.defaultPassword = false;          // 已自行改密，撤下"请修改初始密码"提醒
    L.saveUsers(users);
    return json(res, 200, { ok: true });
  }

  // —— 模板 ——
  if (p === '/api/templates' && req.method === 'GET') {
    const u = requireUser(req, res); if (!u) return;
    const all = L.listTemplates();
    return json(res, 200, u.role === 'admin' ? all : all.filter(t => t.enabled !== false));
  }
  if (p === '/api/templates' && req.method === 'POST') {
    const u = requireAdmin(req, res); if (!u) return;
    const body = await readJsonBody(req);
    const t = L.listTemplates();
    if (body.id) {
      const i = t.findIndex(x => x.id === body.id);
      if (i < 0) return json(res, 404, { error: '模板不存在' });
      t[i] = { ...t[i], ...body };
    } else {
      t.push({ id: 'tpl' + Date.now().toString(36), enabled: true, ...body });
    }
    L.saveTemplates(t); return json(res, 200, t);
  }
  if (p === '/api/templates/delete' && req.method === 'POST') {
    const u = requireAdmin(req, res); if (!u) return;
    const { id } = await readJsonBody(req);
    L.saveTemplates(L.listTemplates().filter(t => t.id !== id));
    return json(res, 200, { ok: true });
  }

  // —— 用户（管理员）——
  if (p === '/api/users' && req.method === 'GET') {
    const u = requireAdmin(req, res); if (!u) return;
    // 带上登录防护状态：失败次数、是否锁定、锁定到几点
    const g = L.guardState();
    const now = Date.now();
    // 最近来源 IP / MAC：取该账号在登录流水中的最后一条（供管理员核对该机器是否为本人使用；
    // MAC 仅作参考、不参与拦截：浏览器读不到 MAC，且可随时更改）
    const hist = L.listAuthEvents ? L.listAuthEvents() : [];
    const lastOf = new Map();
    for (const e of hist) {
      if (!e || !e.userId) continue;
      const k = e.userId;
      if (!lastOf.has(k) || String(e.at) > String(lastOf.get(k).at)) lastOf.set(k, e);
    }
    return json(res, 200, L.listUsers().map(({ salt, hash, ...x }) => {
      const a = g.accounts[x.id];
      const locked = !!(a && a.lockedUntil && new Date(a.lockedUntil).getTime() > now);
      const last = lastOf.get(x.id);
      return {
        // 按白名单字段返回，不使用 `...x` 全量透传：此前全量透传时，磁盘上残留的旧配额字段
        // （dailyLimit / monthlyLimit）会一并下发，前端仍按旧字段渲染，容易漏改。
        id: x.id, username: x.username, name: x.name, role: x.role,
        disabled: !!x.disabled, defaultPassword: !!x.defaultPassword,
        deepAccess: !!x.deepAccess, createdAt: x.createdAt,
        budget: x.budget ?? (x.role === 'admin' ? 0 : L.DEFAULT_BUDGET),
        allowedIps: x.allowedIps || [],                        // IP 绑定（空 = 不限制该账号）
        lastIp: (last && last.ip) || '',                       // 最近登录来源 IP（核对用）
        lastMac: (last && last.mac) || '',                     // 最近登录来源 MAC（仅供参考）
        lastAt: (last && last.at) || '',
        failCount: a ? (a.fails || 0) : 0,
        locked,
        lockedUntil: locked ? a.lockedUntil : null,
        lockMinutesLeft: locked ? Math.ceil((new Date(a.lockedUntil).getTime() - now) / 60000) : 0,
      };
    }));
  }

  // 登录防护总览（管理员）：锁定中的账号、封禁的 IP、需要关注的失败
  if (p === '/api/guard' && req.method === 'GET') {
    const u = requireAdmin(req, res); if (!u) return;
    return json(res, 200, L.guardSummary());
  }
  // 解锁账号 / 解封 IP / 一键全解（管理员）
  if (p === '/api/guard/unlock' && req.method === 'POST') {
    const u = requireAdmin(req, res); if (!u) return;
    const { userId, ip, all } = await readJsonBody(req);
    if (all) { const n = L.unlockAll(); console.log(`[审计] ${u.name} 一键解除全部登录限制（${n} 条）`); return json(res, 200, { ok: true, cleared: n }); }
    if (ip) { const okIp = L.unblockIp(ip); console.log(`[审计] ${u.name} 解封来源 IP ${ip}`); return json(res, 200, { ok: okIp }); }
    if (userId) {
      const okU = L.unlockAccount(userId);
      const t = L.listUsers().find(x => x.id === userId);
      console.log(`[审计] ${u.name} 解锁账号 ${t ? t.username : userId}`);
      return json(res, 200, { ok: okU });
    }
    return json(res, 400, { error: '请指定 userId / ip / all' });
  }
  if (p === '/api/users' && req.method === 'POST') {
    const u = requireAdmin(req, res); if (!u) return;
    const { username, password, name, role } = await readJsonBody(req);
    try {
      const nu = L.createUser({ username, password, name, role: role === 'admin' ? 'admin' : 'user' });
      const { salt, hash, ...safe } = nu;
      return json(res, 200, safe);
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/users/update' && req.method === 'POST') {
    const u = requireAdmin(req, res); if (!u) return;
    const { id, disabled, role, name, resetPassword, username, deepAccess, budget, level, allowedIps } = await readJsonBody(req);
    const users = L.listUsers(); const t = users.find(x => x.id === id);
    if (!t) return json(res, 404, { error: '用户不存在' });
    if (disabled !== undefined) t.disabled = !!disabled;
    if (role) t.role = role;
    if (name) t.name = name;
    if (deepAccess !== undefined) t.deepAccess = !!deepAccess;          // 能否查看深度类报告
    // 2026-09-28: IP 绑定采用允许列表，支持精确 / 通配（192.0.2.*）/ 网段（192.0.2.0/24）。
    // 空数组 = 不限制该账号（便于先建账号、后补录 IP）。MAC 只记录，不参与判定。
    if (allowedIps !== undefined) {
      if (!Array.isArray(allowedIps)) return json(res, 400, { error: 'allowedIps 要传字符串数组' });
      const bad = allowedIps.map(x => String(x || '').trim()).filter(Boolean)
        .find(p => !(p === '*' || /^\d{1,3}(\.\d{1,3}|\.\*){3}$/.test(p) || /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(p)));
      if (bad) return json(res, 400, { error: `IP 规则写法不对：${bad}（支持 192.0.2.77 / 192.0.2.* / 192.0.2.0/24）` });
      t.allowedIps = L.normalizeIpList(allowedIps);
      console.log(`[审计] ${u.name} 设置 ${t.name} 的 IP 绑定：${t.allowedIps.length ? t.allowedIps.join('、') : '（不限制）'}`);
    }
    // ── 权限级别（一级权限设置）───────────────────────────────
    //   普通用户 user   ：只能查看自己的任务，只出校对成果
    //   审核专家 expert ：可查看全部台账 + 校对版 + 审核版（含处理日志与费用），不含系统管理
    //   管理员   admin  ：全部能力（用户管理、额度、看门狗、配置）
    // 两条护栏：不能修改自己的级别（否则可能失去系统管理入口）；
    //    不能把最后一个管理员降级（否则无法再进入系统管理）。
    if (level) {
      if (t.id === u.id) return json(res, 400, { error: '不能修改自己的权限级别（避免把自己关在系统管理之外）' });
      const admins = users.filter(x => x.role === 'admin' && !x.disabled);
      if (level === 'admin') { t.role = 'admin'; t.deepAccess = true; }
      else if (level === 'expert') {
        if (t.role === 'admin' && admins.length <= 1) return json(res, 400, { error: '这是最后一个管理员，不能降为审核专家' });
        t.role = 'user'; t.deepAccess = true;
      } else if (level === 'user') {
        if (t.role === 'admin' && admins.length <= 1) return json(res, 400, { error: '这是最后一个管理员，不能降为普通用户' });
        t.role = 'user'; t.deepAccess = false;
      } else return json(res, 400, { error: '未知的权限级别：' + level });
    }
    // 费用额度（元）：0 = 不限。管理员的额度不参与判断（恒不限）
    if (budget !== undefined) t.budget = Math.max(0, Number(budget) || 0);
    if (username !== undefined) {
      const un = String(username).trim();
      if (!un) return json(res, 400, { error: '用户名不能为空' });
      if (users.some(x => x.username === un && x.id !== id)) return json(res, 400, { error: '该用户名已存在' });
      t.username = un;
    }
    if (resetPassword) {
      // 重置密码也要过强度校验（与建号、自行改密三处口径一致）
      const np = String(resetPassword);
      if (np.trim().length < 6) return json(res, 400, { error: '新密码至少 6 位（且不能全是空格）' });
      Object.assign(t, L.hashPassword(np)); t.defaultPassword = true;
    }
    L.saveUsers(users); return json(res, 200, { ok: true, username: t.username });
  }

  // —— 任务 ——
  if (p === '/api/tasks' && req.method === 'GET') {
    const u = requireUser(req, res); if (!u) return;
    const all = L.listTasks();
    const canDeep = u.role === 'admin' || !!u.deepAccess;
    // 获授权者（管理员 / 审核专家）可查看全部任务，普通用户只看自己的
    // 范围与内容是两件事，而审核专家的范围即为全所：
    //   · 范围：管理员与审核专家都能查看全部台账；普通用户只看自己提交的
    //   · 内容：deepAccess 决定能否查看审核成果/深度类（审核专家与管理员具备）
    const mine = canDeep ? all : all.filter(t => t.owner === u.id);
    return json(res, 200, mine.map(t => {
      const base = {
        id: t.id,
        // 台账优先展示「项目编号 + 项目名称」，未识别时回退到文件名
        projectCode: t.projectCode || '',
        projectName: t.projectName || '',
        sourceName: t.sourceName,
        bizType: t.bizType, templateName: t.templateName,
        projectType: t.projectType || L.guessProjectType(t.projectName, t.sourceName, t.templateName),
        ownerName: t.ownerName, status: t.status, createdAt: t.createdAt, finishedAt: t.finishedAt,
        mine: t.owner === u.id,   // 前端据此决定是否显示「取消本次提交」
        error: t.error, queuePosition: queuePosition(t.id),
        // 2026-09-28: 台账需能区分排队与加急状态，
        // 管理员据此调用「优先」「立即开始」；优先级为持久化字段（重启后仍有效）
        priority: Number(t.priority) || 0,
        waitingIdle: L.isWaitingTask(t),
        apiStartAt: t.apiStartAt || null,
        canDeep,
        mode: t.mode, scheduledAt: t.scheduledAt, apiStartAt: t.apiStartAt,
        convertedChars: t.convertedChars, tableRows: t.tableRows,
        proofreadCount: t.proofreadCount,
        proofreadP0: t.proofreadP0, proofreadP1: t.proofreadP1,
        // 重复审核提示：台账列表也需展示，否则提交人无法得知任务已被暂停
        duplicateConflict: !!t.duplicateConflict,
        duplicateConfirmed: !!t.duplicateConfirmed,
        priorCount: (t.priorAudits || []).length,
        // ── PPT 配对信息 ──
        // 配对审核为「一个任务、一份成果」而非两个任务：PPT 与报告放在同一任务内，
        // 成果按 PPT 优先排版。因此台账必须显示该标记，
        // 否则只看到报告文件名时会认为 PPT 未提交成功（已收到验证反馈）。
        pptOnly: !!t.pptOnly,
        crossCheck: !!t.crossCheck,
        pptSourceName: t.pptSourceName || '',
        pptSlides: t.pptSlides || 0,
        pptChars: t.pptChars || 0,
        pptEnough: t.pptEnough,
      };
      // 有深度权限者才下发完整统计与深度计数
      if (canDeep) {
        base.stats = t.stats;
        base.deepCount = t.deepCount;
        base.projectProofreadTotal = t.projectProofreadTotal;
      } else {
        base.stats = { p0Count: t.proofreadP0 ?? 0, p1Count: t.proofreadP1 ?? 0, p2Count: 0, p3Count: 0 };
      }
      return base;
    }));
  }

  // ── 按项目分组的台账（同一项目的多次审核合并显示，便于查看上次问题是否已修改）──
  // 权限口径与 /api/tasks 完全一致：管理员与审核专家看全所，普通用户只看自己的。
  // 普通用户看不到 cost（属金额信息），也不提供 compare 中深度类结论之外的额外信息。
  if (p === '/api/project-groups' && req.method === 'GET') {
    const u = requireUser(req, res); if (!u) return;
    const all = L.listTasks();
    const canDeep = u.role === 'admin' || !!u.deepAccess;
    const mine = canDeep ? all : all.filter(t => t.owner === u.id);
    const groups = L.groupTasksByProject(mine).map(g => ({
      ...g,
      // 普通用户无需查看金额，也不应看到他人姓名之外的用量信息
      submissions: g.submissions.map(s => (canDeep ? s : { ...s, cost: null })),
    }));
    return json(res, 200, { groups, canDeep, total: mine.length });
  }

  // ── 排队管理（仅管理员）：队列真实顺序 + 每条任务的加急/等待状态 ──
  // 大量提交排队时，管理员需要能对某些项目提高优先级或立即开始。
  if (p === '/api/queue-board' && req.method === 'GET') {
    const u = requireAdmin(req, res); if (!u) return;
    const board = L.buildQueueBoard(queue, L.getTask, {
      running, maxConcurrent: MAX_CONCURRENT + boostSlots, boostSlots, maxBoost: MAX_BOOST,
      runningByOwner: runningByOwner(), perUserRunning: L.PER_USER_RUNNING,
      adminOwners: adminOwnerIds(), adminPerUserRunning: L.PER_USER_RUNNING_ADMIN,
    });
    return json(res, 200, { ...board, baseMaxConcurrent: MAX_CONCURRENT, boostSlots, queue: queueStats() });
  }

  // ── 未响应明细钻取（仅管理员）──
  // 台账「整改闭环」只看得到数字（未响应 N 条、其中 P0 M 条），要判断"该不该响应"必须看到条目本身：
  // 是哪个项目的哪一页、上次提的什么、这次报告里对应原文是什么、AI 判断未响应的理由是什么。
  // 逐条明细在各任务的 run/compare.json（任务摘要里只存了 stats），因此这里按需读取产物文件。
  if (p === '/api/unresponded' && req.method === 'GET') {
    const u = requireAdmin(req, res); if (!u) return;
    const q = (req.url.includes('?') ? new URL(req.url, 'http://x') : null)?.searchParams;
    const get = (k) => (q ? (q.get(k) || '') : '');
    const readCompare = (id) => {
      try { return JSON.parse(fs.readFileSync(path.join(L.taskDir(id), 'run', 'compare.json'), 'utf8')); }
      catch { return null; }
    };
    const rep = L.buildUnrespondedReport(L.listTasks(), {
      readCompare,
      feedback: L.readSkillFeedback(),
      only: ['marked', 'unmarked'].includes(get('only')) ? get('only') : '',
      scope: get('scope') === 'mine' ? 'mine' : 'all',
      owner: u.id,
      level: get('level'),
      category: get('category'),
      project: get('project'),
      status: get('status'),
      limit: Number(get('limit')) || 2000,
    });
    return json(res, 200, rep);
  }

  // ── 未响应条目的"优化判定"（仅管理员）──
  // 未响应明细里逐条标注：该条是不是 AI 误报/定义不准/级别定低/类别归错、要补什么规则。
  // 路由名不用 /api/skill-feedback：那个路径已有既有功能（人工审核意见 → 结构化经验条目，
  // 写在 web/data/skill-feedback.json），两套 schema 不同，共用路径会互相覆盖、且先注册的路由会截住请求。
  if (p === '/api/unresponded-note' && req.method === 'GET') {
    const u = requireAdmin(req, res); if (!u) return;
    const items = L.readSkillFeedback();
    const only = (req.url.includes('?') ? new URL(req.url, 'http://x').searchParams.get('only') : '') || '';
    const picked = only === 'adopted'
      ? Object.fromEntries(Object.entries(items).filter(([, r]) => r.status === 'adopted'))
      : items;
    return json(res, 200, { items: picked, stats: L.skillFeedbackStats(items), verdicts: L.SKILL_VERDICTS });
  }
  if (p === '/api/unresponded-note' && req.method === 'POST') {
    const u = requireAdmin(req, res); if (!u) return;
    const body = await readJsonBody(req).catch(() => null);
    if (!body || !body.taskId || !body.no) return json(res, 400, { error: '缺少任务号或条目号' });
    try {
      const saved = L.saveSkillFeedback({ ...body, by: u.id, byName: u.name || u.username || '' }, { clear: !!body.clear });
      return json(res, 200, { ok: true, key: saved.key, record: saved.record, stats: L.skillFeedbackStats(L.readSkillFeedback()) });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  // 把"已采纳"的优化判定同步成技能经验条目，接入既有的落地链路：
  //   经验条目（skill-feedback.json）→ /api/skill-merge-review（AI 与原技能逐条对比，只读）
  //   → 人工勾选 → /api/skill-apply 写入 LEARNED.md → 引擎下一次审核读取。
  // 上游为什么必须这样接：经验条目是"技能层唯一入口"，直接改 SKILL.md 会被 sync-skill 同步覆盖，
  //   而且跳过 AI 融合对比会把与现有口径冲突的内容写进去。
  // 幂等：按 sourceKey（任务号|条目号）判重，重复点不会产生重复经验。
  if (p === '/api/unresponded-note/sync' && req.method === 'POST') {
    const u = requireAdmin(req, res); if (!u) return;
    const notes = Object.entries(L.readSkillFeedback())
      .filter(([, r]) => r.status === 'adopted')
      .map(([key, r]) => ({ key, ...r }));
    if (!notes.length) return json(res, 400, { error: '还没有"已采纳"的判定，先把要改的条目标为已采纳' });
    const list = L.listFeedback();
    const has = new Set(list.map((x) => x.sourceKey).filter(Boolean));
    const kindOf = (r) => {
      const v = (r.verdicts || []).join(' ');
      if (v.includes('AI 误报')) return 'false-positive';
      if (v.includes('需补规则') || v.includes('定义不准') || v.includes('过于宽泛') || v.includes('定级不当')) return 'criteria';
      if (v.includes('表述')) return 'wording';
      return 'criteria';
    };
    const now = new Date().toISOString();
    let created = 0, skipped = 0;
    for (const r of notes) {
      if (has.has(r.key)) { skipped++; continue; }
      const opinion = [
        `【未响应明细】${r.no}｜${r.project || ''}`,
        r.summary ? `原问题：${r.summary}` : '',
        (r.verdicts || []).length ? `判定：${(r.verdicts || []).join('、')}` : '',
        (r.levelTo && r.levelTo !== r.levelFrom) ? `级别建议：${r.levelFrom} → ${r.levelTo}` : '',
        (r.categoryTo && r.categoryTo !== r.categoryFrom) ? `类别建议：${r.categoryFrom} → ${r.categoryTo}` : '',
        r.reason ? `解释：${r.reason}` : '',
      ].filter(Boolean).join('\n');
      list.push({
        id: 'FB' + Date.now().toString(36) + '-' + created,
        kind: kindOf(r),
        category: r.categoryTo || r.categoryFrom || '',
        opinion,
        lessons: r.rule || '',
        projectName: r.project || '',
        taskIds: [r.taskId],
        status: 'active',
        createdAt: now,
        createdBy: u.name || u.username || '',
        sourceKey: r.key,                    // 幂等标记：同一条未响应明细只同步一次
      });
      created++;
    }
    if (created) L.saveFeedback(list);
    return json(res, 200, { ok: true, created, skipped, total: notes.length });
  }
  // 把标注汇总成"改技能用的规则建议"（Markdown），管理员可直接下载后对照修改技能
  if (p === '/api/unresponded-notes.md' && req.method === 'GET') {
    const u = requireAdmin(req, res); if (!u) return;
    const onlyAdopted = (req.url.includes('?') ? new URL(req.url, 'http://x').searchParams.get('only') : '') === 'adopted';
    const md = L.skillFeedbackMarkdown(L.readSkillFeedback(), { onlyAdopted });
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="skill-optimization-${new Date().toISOString().slice(0, 10)}.md"`,
    });
    return res.end(md);
  }

  // ── PPT 暂存（为「PPT + 报告」配对审核做准备）──
  //
  // 先转换 PPT 并存储，取得 stashId，创建任务时带上即可。
  // 转换放在此步骤还有两点原因：① PPT 转换较慢（.ppt 可能 40 秒以上），
  // 放在此处使用方能看到进度；② PPT 常以截图为主、提取不出内容，
  // 此处即返回质量指标，前端可在提交前提示，而非审核完成后才发现无内容可核。
  if (p === '/api/ppt-stash' && req.method === 'POST') {
    const u = requireUser(req, res); if (!u) return;
    const name = decodeURIComponent(req.headers['x-file-name'] || '');
    if (!name) return json(res, 400, { error: '缺少文件名' });
    if (L.docKind(name) !== 'ppt') return json(res, 400, { error: '这里只接收 PPT 文件（.pptx / .ppt）' });

    const buf = await readBody(req);
    if (!buf.length) return json(res, 400, { error: '文件为空' });

    // 提交预检：PPT 也常出现"改名/截断"的坏包，提前挡住，别等排队跑到提取阶段才失败
    const chkPpt = L.checkOfficeContainer(buf, name);
    if (!chkPpt.ok) {
      console.log(`[审计] ${u.name} 上传的 PPT 未通过预检（${chkPpt.code}）：${name}`);
      return json(res, 400, { error: chkPpt.error, code: chkPpt.code });
    }

    const purged = L.cleanPptStash();
    const stashId = L.newStashId();
    const sdir = L.stashDir(stashId);
    fs.mkdirSync(sdir, { recursive: true });
    const safeName = name.replace(/[\\/:*?"<>|]/g, '_');
    // 落盘必须保留原扩展名：convertToMarkdown 依据扩展名决定转换路径，
    // 存为无后缀的 'file' 会得到 "收到 ''" 的结果（经实测出现过）。
    const rawPath = path.join(sdir, safeName);
    fs.writeFileSync(rawPath, buf);

    const t0 = Date.now();
    let conv;
    try {
      conv = await L.convertToMarkdown(rawPath, (msg) => console.log(`[ppt ${stashId}] ${msg}`));
    } catch (e) {
      fs.rmSync(sdir, { recursive: true, force: true });
      return json(res, 400, { error: 'PPT 转换失败：' + e.message });
    }
    // 转换产物文件名带原扩展名，统一归位成 ppt.md
    for (const f of fs.readdirSync(sdir)) {
      if (f.endsWith('.extracted.md')) fs.renameSync(path.join(sdir, f), path.join(sdir, 'ppt.md'));
    }
    const meta = {
      id: stashId, name: safeName, fileName: safeName, bytes: buf.length, at: new Date().toISOString(),
      slides: conv.slides, chars: conv.text.length, tables: conv.tables,
      quality: conv.quality, engine: conv.engine, seconds: Math.round((Date.now() - t0) / 1000),
      by: u.name,
    };
    L.saveStash(stashId, meta);
    console.log(`[审计] ${u.name} 暂存 PPT「${safeName}」：${conv.slides} 页 / ${conv.text.length} 字符`
      + ` / ${meta.seconds}s${conv.quality && !conv.quality.enough ? '　⚠️ 内容不足（以图片为主）' : ''}`);
    return json(res, 200, { ok: true, stashId, ...meta, purged });
  }

  // ── 额度追加申请 ──
  // 额度用尽后仍有通道：提交申请 → 管理员按情况审批 → 直接计入该账号 budget。
  if (p === '/api/quota-request' && req.method === 'POST') {
    const u = requireUser(req, res); if (!u) return;
    const b = await readJsonBody(req);
    const r = L.addQuotaRequest({
      userId: u.id, userName: u.name,
      wantAmount: b.wantAmount, reason: b.reason,
    });
    console.log(`[审计] ${u.name} 申请追加额度 ¥${r.wantAmount}：${String(r.reason).slice(0, 60)}`);
    return json(res, 200, { ok: true, request: r, note: '申请已提交，管理员会按情况批准。' });
  }
  if (p === '/api/quota-request' && req.method === 'GET') {
    const u = requireUser(req, res); if (!u) return;
    const all = L.listQuotaRequests();
    // 普通用户只看自己的申请记录；管理员看全部待处理
    const list = u.role === 'admin' ? all : all.filter(r => r.userId === u.id);
    return json(res, 200, { list: list.slice(0, 100), pending: all.filter(r => r.status === 'pending').length });
  }
  if (p === '/api/quota-request/resolve' && req.method === 'POST') {
    const u = requireAdmin(req, res); if (!u) return;
    const { id, approve, addAmount, note } = await readJsonBody(req);
    const list = L.listQuotaRequests();
    const r = list.find(x => x.id === id);
    if (!r) return json(res, 404, { error: '申请不存在' });
    if (r.status !== 'pending') return json(res, 400, { error: '该申请已处理过' });

    r.status = approve ? 'approved' : 'rejected';
    r.resolvedAt = new Date().toISOString();
    r.resolvedBy = u.name;
    r.resolveNote = String(note || '').slice(0, 300);

    if (approve) {
      const users = L.listUsers();
      const t = users.find(x => x.id === r.userId);
      if (!t) return json(res, 404, { error: '申请人账号不存在' });
      const add = Math.max(0, Number(addAmount ?? r.wantAmount) || 0);
      r.addedAmount = add;
      t.budget = Math.max(0, Number(t.budget ?? L.DEFAULT_BUDGET)) + add;
      L.saveUsers(users);
      console.log(`[审计] ${u.name} 批准 ${t.name} 追加额度 ¥${add}，现为 ¥${t.budget}`);
    } else {
      console.log(`[审计] ${u.name} 驳回 ${r.userName} 的额度追加申请`);
    }
    L.saveQuotaRequests(list);
    return json(res, 200, { ok: true, request: r });
  }

  // ── 仅 PPT 的任务（没有配套报告）──
  // 支持只传 PPT：此时仅做 PPT 自身审核（编校/术语/数据/逻辑），无对照物则不做一致性核对。
  if (p === '/api/tasks/ppt-only' && req.method === 'POST') {
    const u = requireUser(req, res); if (!u) return;
    const body = await readJsonBody(req);
    const stash = L.getStash(String(body.stashId || ''));
    if (!stash) return json(res, 400, { error: 'PPT 暂存已过期（超过 2 小时），请重新上传' });

    const qs = queueStats();
    if (qs.ready >= MAX_QUEUE) return json(res, 503, { error: `当前排队 ${qs.ready} 个任务已达上限（${MAX_QUEUE}），请稍后再提交`, queue: qs });
    // 每人排队上限（与普通提交同口径，见 L.PER_USER_QUEUED 的说明）
    if (queuedReadyOf(u.id) >= L.PER_USER_QUEUED) {
      return json(res, 429, {
        error: `你已有 ${L.PER_USER_QUEUED} 个任务在排队（是队列里"可立即开跑"的那些，等待闲时的不算）。`
          + `请等其中一个开始处理后再提交，或找管理员加急。`,
        perUserQueued: L.PER_USER_QUEUED,
      });
    }
    const q = L.checkQuota(u, L.listTasks());
    if (!q.ok) return json(res, 429, { error: q.reason, usage: q.usage, daily: q.daily, monthly: q.monthly });

    // 调用时机由 L.resolveAuditMode() 统一判定：管理员关闭「闲时/立即」选择后，
    // 此处强制为 immediate（不信任前端传入的 mode：接口公开，任何调用方都可自行构造请求）。
    const rmode = L.resolveAuditMode({ role: u.role, requested: body.mode });
    const mode = rmode.mode;
    if (rmode.forced) console.log(`[审计] ${u.name} 提交时带了"闲时"，但管理员已关闭该选择 → 强制立即调用`);
    const peakNow = L.isPeakHour();
    let apiStartAt = null, scheduleNote = '';
    if (mode === 'idle' && peakNow) {
      apiStartAt = L.nextOffPeakStart();
      scheduleNote = `当前是高峰时段。PPT 解析已完成，AI 调用推迟到 ${L.fmtBJText(apiStartAt)}，费用省一半。`;
    } else {
      scheduleNote = peakNow ? '已选择立即调用：当前为高峰时段，费用为闲时的 2 倍。' : '当前已是空闲时段（半价）。';
    }

    const id = L.newTaskId();
    const dir = L.taskDir(id); fs.mkdirSync(dir, { recursive: true });
    const task = {
      id, owner: u.id, ownerName: u.name,
      sourceName: stash.name, pptSourceName: stash.name,
      bizType: L.guessBizType(stash.name), templateId: '', templateName: '',
      status: 'queued', createdAt: new Date().toISOString(),
      uploadFile: null, uploadBytes: 0, progress: [],
      mode, scheduledAt: null, apiStartAt, peakAtSubmit: peakNow,
      typeAutoDetected: true,
      pptOnly: true, pptStashId: stash.id, crossCheck: false, chartCheck: !!body.chartCheck,
      // 本次审核重点（仅 PPT 任务走 JSON body，不是请求头）：同样按白名单 + 管理员过滤
      ...L.parseReviewFocus({
        focusHeader: Array.isArray(body.reviewFocus) ? encodeURIComponent(body.reviewFocus.join(',')) : '',
        noteHeader: body.reviewNote ? encodeURIComponent(String(body.reviewNote)) : '',
        isAdmin: u.role === 'admin',
      }),
    };
    L.saveTask(task);
    L.appendProgress(task, `已接收 PPT「${stash.name}」（${stash.slides} 页 / ${stash.chars.toLocaleString()} 字符）`);
    L.appendProgress(task, '本次只提交了 PPT，做 PPT 自身审核（没有对照报告，不做一致性核对）');
    L.appendProgress(task, scheduleNote);
    enqueue(id);
    console.log(`[审计] ${u.name} 提交「仅 PPT 审核」任务 ${id}：${stash.slides} 页`);
    return json(res, 200, { id, mode, apiStartAt, note: scheduleNote, pptOnly: true });
  }

  if (p === '/api/tasks' && req.method === 'POST') {
    const u = requireUser(req, res); if (!u) return;
    const name = decodeURIComponent(req.headers['x-file-name'] || '');
    if (!name) return json(res, 400, { error: '缺少文件名' });
    const ext = path.extname(name).toLowerCase();
    if (!['.docx', '.doc'].includes(ext)) return json(res, 400, { error: '仅支持 .docx / .doc 格式（PDF 表格结构会丢失，无法审核投资类问题）' });

    // 配对审核：带 PPT 暂存 id 时，这个任务同时持有 PPT 与报告，出一份 PPT 优先的成果
    const pptStashId = String(req.headers['x-ppt-stash'] || '').trim();
    const crossCheck = req.headers['x-cross-check'] === '1';
  // 图表核对：默认关（图片按 token 计费），只有前端勾选了才带这个头
  const chartCheck = req.headers['x-chart-check'] === '1';
  // 本次审核重点（仅管理员；服务端按白名单过滤，非管理员一律忽略 —— 见 L.parseReviewFocus）
  const { reviewFocus, reviewNote } = L.parseReviewFocus({
    focusHeader: req.headers['x-review-focus'],
    noteHeader: req.headers['x-review-note'],
    isAdmin: u.role === 'admin',
  });
    if (pptStashId && !L.getStash(pptStashId)) {
      return json(res, 400, { error: 'PPT 暂存已过期（超过 2 小时），请重新上传 PPT' });
    }

    const buf = await readBody(req);
    if (!buf.length) return json(res, 400, { error: '文件为空' });
    // 提交预检：坏包（.doc 改名 / 上传截断 / 保存损坏）在接收时当场拒收并给出可操作提示。
    // 依据见 lib.checkOfficeContainer —— 不加这一步，任务会先排队、跑到提取阶段才失败。
    const chk = L.checkOfficeContainer(buf, name);
    if (!chk.ok) {
      console.log(`[审计] ${u.name} 上传的文件未通过预检（${chk.code}）：${name}`);
      return json(res, 400, { error: chk.error, code: chk.code });
    }
    // 名额只统计真正就绪的任务；等待闲时的任务另设上限
    const qs = queueStats();
    if (qs.ready >= MAX_QUEUE) {
      return json(res, 503, {
        error: `当前排队 ${qs.ready} 个任务已达上限（${MAX_QUEUE}），请稍后再提交`,
        queue: qs,
      });
    }
    // 2026-09-28: 设置每人排队上限，避免单个账号占满队列名额。
    // 只统计就绪任务（不计等待闲时的任务），否则早上提交几份闲时任务即会阻塞整个上午。
    if (queuedReadyOf(u.id) >= L.PER_USER_QUEUED) {
      return json(res, 429, {
        error: `你已有 ${L.PER_USER_QUEUED} 个任务在排队（是队列里"可立即开跑"的那些，等待闲时的不算）。`
          + `请等其中一个开始处理后再提交，或找管理员加急。`,
        perUserQueued: L.PER_USER_QUEUED,
      });
    }
    if (qs.waiting >= MAX_WAITING) {
      return json(res, 503, {
        error: `等待闲时的任务已达上限（${MAX_WAITING} 个，当前 ${qs.waiting} 个）。`
          + `可以稍后再提交，或在提交时改选「立即调用」跳过闲时排队。`,
        queue: qs,
      });
    }

    // ── 配额检查（管理员不受限；额度见用户管理可单独调整）──
    const q = L.checkQuota(u, L.listTasks());
    if (!q.ok) return json(res, 429, { error: q.reason, usage: q.usage, daily: q.daily, monthly: q.monthly });

    // ── 审核时机：idle（闲时调用，默认） / immediate（立即调用）──
    // idle 语义：本地预处理立即执行（文档转换无费用），产生费用的 AI 调用推迟到空闲时段，
    //              起跑时刻 = 本段高峰结束 + 10 分钟（缓冲，避开 12:00/18:00 边界）；
    //              若当前已在空闲时段，则预处理完成后直接运行，不额外等待。
    // 同上：由 L.resolveAuditMode() 统一判定，管理员关闭选择后强制立即调用（以服务端为准）
    const rmode = L.resolveAuditMode({ role: u.role, requested: req.headers['x-audit-mode'] });
    const mode = rmode.mode;
    if (rmode.forced) console.log(`[审计] ${u.name} 提交时带了"闲时"，但管理员已关闭该选择 → 强制立即调用`);
    const peakNow = L.isPeakHour();
    let apiStartAt = null, scheduleNote = '';
    if (mode === 'idle') {
      if (peakNow) {
        apiStartAt = L.nextOffPeakStart();
        scheduleNote = `当前是高峰时段（工作日 9:00-12:00、14:00-18:00，价格为闲时的 2 倍）。`
          + `文档预处理现在就做，AI 调用推迟到 ${L.fmtBJText(apiStartAt)}（高峰结束后再等 ${L.OFFPEAK_BUFFER_MIN} 分钟）开始，费用省一半。`;
      } else {
        scheduleNote = '当前已是空闲时段（半价），预处理完成后立即调用 AI。';
      }
    } else {
      scheduleNote = peakNow
        ? '已选择立即调用：当前为高峰时段，AI 费用为闲时的 2 倍。'
        : '已选择立即调用：当前为空闲时段，按半价计费。';
    }

    const id = L.newTaskId();
    const dir = L.taskDir(id); fs.mkdirSync(dir, { recursive: true });
    const safeName = name.replace(/[\\/:*?"<>|]/g, '_');
    fs.writeFileSync(path.join(dir, safeName), buf);

    // 报告类型不再需要手动选择：先按文件名/模板关键词给出初判，S0 预审解析正文后再精确识别。
    const preBizType = L.guessBizType(safeName);

    const task = {
      id, owner: u.id, ownerName: u.name, sourceName: safeName,
      bizType: preBizType, templateId: '', templateName: '',
      status: 'queued', createdAt: new Date().toISOString(),
      uploadFile: safeName, uploadBytes: buf.length, progress: [],
      mode, scheduledAt: null, apiStartAt, peakAtSubmit: peakNow,
      typeAutoDetected: true,
      // PPT 配对：crossCheck 为真时额外做「PPT ↔ 报告」一致性核对，成果按 PPT 优先排版
      pptStashId: pptStashId || null,
      chartCheck,
      crossCheck: !!(pptStashId && crossCheck),
      // 本次审核重点（管理员提交时填，只作用于这一个任务；会注入 S2 提示词并写在成果报告开头）
      reviewFocus, reviewNote,
    };
    L.saveTask(task);
    L.appendProgress(task, `已接收文件 ${safeName}（${(buf.length / 1024).toFixed(0)} KB），进入队列`);
    if (pptStashId) {
      const s = L.getStash(pptStashId);
      // 此处不要再调 L.saveTask(task)：appendProgress 为读盘 → 修改 → 写盘，
      //    而 task 是内存中的旧副本，直接 saveTask(task) 会把刚追加的进度整段抹掉（经实测出现过）。
      //    pptStashId / crossCheck 在构造 task 时已写入并落盘。
      L.appendProgress(task, `已配对汇报 PPT「${s.name}」（${s.slides} 页 / ${s.chars.toLocaleString()} 字符）`
        + (task.crossCheck ? '，将做「PPT ↔ 报告」一致性核对' : ''));
      if (s.quality && !s.quality.enough) {
        L.appendProgress(task, '⚠️ 该 PPT 以图片为主，提取到的文字很少，内容级核对可能无米下锅（系统不做图片 OCR）');
      }
    }
    L.appendProgress(task, scheduleNote);
    L.appendProgress(task, '报告类型由系统自动识别，无需手动选择');
    enqueue(id);
    return json(res, 200, {
      id, mode, apiStartAt,
      scheduledAt: apiStartAt,
      peakNow, bufferMin: L.OFFPEAK_BUFFER_MIN,
      note: scheduleNote,
      paired: !!pptStashId, crossCheck: task.crossCheck,
    });
  }

  // ── 当前时段与计费口径（前端实时提示用，避免用登录时的旧快照）──
  if (p === '/api/now' && req.method === 'GET') {
    const u = requireUser(req, res); if (!u) return;
    return json(res, 200, L.timingSnapshot());
  }

  const m = p.match(/^\/api\/tasks\/([^/]+)(\/.*)?$/);
  if (m) {
    const u = requireUser(req, res); if (!u) return;
    const task = L.getTask(m[1]);
    if (!task) return json(res, 404, { error: '任务不存在' });
    // 范围：管理员与审核专家都能查阅全部任务；普通用户只能查阅自己的
    const canRead = u.role === 'admin' || !!u.deepAccess;
    if (!canRead && task.owner !== u.id) return json(res, 403, { error: '无权访问' });
    const sub = m[2] || '';

    if (sub === '' && req.method === 'GET') {
      const canDeep = u.role === 'admin' || !!u.deepAccess;
      // 标注版是否已就绪（审核时已生成 → 前端直接给下载链接，无需现场等待）
      // pptProof/pptDeep：配对任务的 PPT 标注版（2026-09-28 新增该路径）
      const pairedPpt = hasPairedPpt(L.taskDir(task.id));
      const annReady = {
        proof: fs.existsSync(annotateOut(task.id, 'proof')),
        ppt: pairedPpt,   // 该任务有没有 PPT 那一路（前端据此决定要不要显示 PPT 按钮）
      };
      if (canDeep) annReady.deep = fs.existsSync(annotateOut(task.id, 'deep'));
      if (pairedPpt) {
        annReady.pptProof = fs.existsSync(annotateOut(task.id, 'proof', 'ppt'));
        if (canDeep) annReady.pptDeep = fs.existsSync(annotateOut(task.id, 'deep', 'ppt'));
      }
      const out = {
        ...task,
        canDeep,
        annotateReady: annReady,
        annotateError: task.annotateError || null,   // 生成失败的原因（界面显示 + 手动重试）
        annotateToolchain: toolchainStatus(),        // 工具链是否齐全（管理员的排查依据）
        annotateStats: canDeep ? (task.annotate || null) : (task.annotate?.proof ? { proof: task.annotate.proof } : null),
        queuePosition: queuePosition(task.id),
        queue: queueStats(),
        queueLength: queue.length,
        running,
        maxConcurrent: MAX_CONCURRENT,
        mine: task.owner === u.id,
      };
      // 第 6 条：处理日志对普通用户意义不大，仅管理员与获授权审核专家可见
      if (!canDeep) {
        delete out.progress; delete out.unitStats; delete out.deepCount;
        delete out.categoryCounts;          // 含深度类类别，不下发
        delete out.usage; delete out.cost; delete out.peak;   // 第 6 条：用量/费用不对普通用户显示
        delete out.projectProofreadTotal;
        delete out.p0List;   // P0 清单里含深度类条目，改用校对类
        out.p0List = (task.p0List || []).filter(x => classify(x) === 'proofread');
        out.stats = { p0Count: task.proofreadP0 ?? 0, p1Count: task.proofreadP1 ?? 0, p2Count: 0, p3Count: 0 };
        // 历史记录的 P0/P1 属深度类口径，普通用户不该看到
        out.priorAudits = (task.priorAudits || []).map(x => ({ ...x, p0: null, p1: null }));
      }
      return json(res, 200, out);
    }

    // ── 管理员加急 / 立即开始 ──
    // 2026-09-28: 大量账号同时提交、部分项目排队时，管理员需要能对某些项目提高优先级或立即运行。
    // 权限：仅管理员（普通用户与审核专家看不到入口，服务端此处为硬性门槛）。
    if (sub === '/priority' && req.method === 'POST') {
      if (u.role !== 'admin') return json(res, 403, { error: '只有管理员可以调整排队优先级' });
      const body = await readJsonBody(req);
      const want = Number(body.priority);
      const priority = want === L.PRIORITY_URGENT ? L.PRIORITY_URGENT : L.PRIORITY_NORMAL;
      if (['done', 'failed', 'cancelled'].includes(task.status)) {
        return json(res, 400, { error: '该任务已结束，无需调整优先级' });
      }
      task.priority = priority;
      task.priorityBy = u.name;
      task.priorityAt = new Date().toISOString();
      L.saveTask(task);
      console.log(`[审计] ${u.name} 把任务 ${task.id}（${task.projectName || task.sourceName || ''}）的排队优先级设为 ${priority === L.PRIORITY_URGENT ? '加急' : '正常'}`);
      pump();
      return json(res, 200, { ok: true, priority, queuePosition: queuePosition(task.id), queue: queueStats() });
    }
    if (sub === '/start-now' && req.method === 'POST') {
      // 「立即开始」＝ ① 插到最前（priority 取一个很大的值）＋ ② 解除闲时等待（否则会等到夜间）
      //                ＋ ③ 名额已满时为该任务临时 +1 并发（跑完自动收回，不影响正在运行的任务）
      if (u.role !== 'admin') return json(res, 403, { error: '只有管理员可以立即开始排队中的任务' });
      if (['done', 'failed', 'cancelled'].includes(task.status)) {
        return json(res, 400, { error: '该任务已结束' });
      }
      const wasWaiting = L.isWaitingTask(task);
      task.priority = L.PRIORITY_START_NOW;
      task.priorityBy = u.name;
      task.priorityAt = new Date().toISOString();
      if (wasWaiting) {
        // 解除等待：把起跑时刻提前到现在，并如实记录（费用按此刻时段计，便于管理员核对账目）
        task.apiStartAt = new Date().toISOString();
        task.mode = 'immediate';
        task.scheduleNote = `管理员「${u.name}」于 ${L.fmtBJText(new Date())} 点「立即开始」，取消闲时等待，按当时时段计费。`;
      }
      let granted = false, capped = false;
      if (running >= MAX_CONCURRENT + boostSlots) {
        // 临时名额封顶（额外最多 +2）：达到上限后不再发放，任务仍保有最高优先级，等待空位即可。
        if (boostSlots < MAX_BOOST) {
          boostSlots += 1;
          boosted.add(task.id);
          granted = true;
        } else {
          capped = true;
        }
      }
      L.saveTask(task);
      if (!queue.includes(task.id)) queue.unshift(task.id); else {
        // 已在队列中：移动到最前，配合高优先级确保其为下一个运行的任务
        queue.splice(queue.indexOf(task.id), 1);
        queue.unshift(task.id);
      }
      console.log(`[审计] ${u.name} 对任务 ${task.id}（${task.projectName || task.sourceName || ''}）点「立即开始」`
        + `${wasWaiting ? '，已取消闲时等待' : ''}${granted ? '，临时增加 1 路并发' : ''}${capped ? '，加急名额已到上限（+' + MAX_BOOST + '），改为插队等空位' : ''}`);
      pump();
      return json(res, 200, {
        ok: true, priority: task.priority, wasWaiting, grantedExtraSlot: granted, boostCapped: capped,
        running, boostSlots, maxBoost: MAX_BOOST, queuePosition: queuePosition(task.id), queue: queueStats(),
      });
    }

    // ── 重复审核：确认继续 / 放弃本次提交 ──
    if (sub === '/confirm-duplicate' && req.method === 'POST') {
      if (task.status !== 'duplicate-suspect') return json(res, 400, { error: '该任务当前不在「等待确认重复审核」状态' });
      if (u.role !== 'admin' && task.owner !== u.id) return json(res, 403, { error: '只有提交人本人或管理员可以确认' });
      task.duplicateConfirmed = true;
      task.duplicateConfirmedBy = u.name;
      task.duplicateConfirmedAt = new Date().toISOString();
      task.status = 'queued';
      task.error = null;
      L.saveTask(task);
      console.log(`[审计] ${u.name} 确认任务 ${task.id} 为重复审核，继续执行`);
      L.appendProgress(task, `${u.name} 已确认属于重复审核，继续执行（AI 审核即将开始）`);
      enqueue(task.id, { front: true });
      return json(res, 200, { ok: true });
    }

    if (sub === '/cancel' && req.method === 'POST') {
      // 允许取消的范围 = 「AI 尚未开始」的所有阶段。
      // converting 同样允许：该阶段为本地解析、无费用，且提交后几乎立即进入该状态；
      // 不允许时，提交后立即发现文件有误也无法取消（经实测出现过）。
      // auditing 不允许：此时已产生费用，且成果具有保留价值。
      if (!['duplicate-suspect', 'queued', 'converting', 'waiting'].includes(task.status)) {
        return json(res, 400, {
          error: task.status === 'auditing'
            ? '任务已进入 AI 审核，费用已产生，不再支持取消。审核完成后如不需要，可由管理员删除记录。'
            : '该任务当前状态不支持取消',
        });
      }
      if (u.role !== 'admin' && task.owner !== u.id) return json(res, 403, { error: '只有提交人本人或管理员可以取消' });
      // 必须同时从内存队列中移除，否则下一次 pump() 仍会取出并继续运行。
      const qi = queue.indexOf(task.id);
      if (qi >= 0) queue.splice(qi, 1);
      task.status = 'cancelled';
      task.cancelledBy = u.name;
      task.finishedAt = new Date().toISOString();
      task.error = null;
      L.saveTask(task);
      console.log(`[审计] ${u.name} 取消了任务 ${task.id}（${task.sourceName}）${qi >= 0 ? '，已从队列摘除' : ''}`);
      L.appendProgress(task, `${u.name} 取消了本次提交；AI 审核尚未开始，未产生任何费用`);
      return json(res, 200, { ok: true });
    }

    // ── 补充审核：发起 / 查询 / 取 HTML ──
    // 只有管理员能发起（属管理动作，且会产生费用）；获授权审核专家可查看已有结果。
    const ms = sub.match(/^\/supplement(?:\/([^/]+)(\/[^/]*)?)?$/);
    if (ms) {
      const canDeep = u.role === 'admin' || !!u.deepAccess;
      if (!canDeep) return json(res, 403, { error: '需要管理员或审核专家权限' });
      const sid = ms[1], rest = ms[2] || '';

      if (!sid && req.method === 'POST') {
        if (u.role !== 'admin') return json(res, 403, { error: '只有管理员可以发起补充审核' });
        if (task.status !== 'done') return json(res, 400, { error: '任务尚未完成，无法补充审核（补充审核基于首轮抽取的事实）' });
        const { note } = await readJsonBody(req);
        const text0 = String(note || '').trim();
        if (!text0) return json(res, 400, { error: '请填写补充审核要求（要重点核查什么）' });
        if (text0.length > MAX_SUPPLEMENT_NOTE) return json(res, 400, { error: `补充要求不超过 ${MAX_SUPPLEMENT_NOTE} 字` });

        task.supplements = task.supplements || [];
        const round = task.supplements.filter(x => x.status === 'done').length + 1;
        const newSid = 'S' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const rec = {
          sid: newSid, round, note: text0,
          by: u.name, byId: u.id,
          status: 'queued', createdAt: new Date().toISOString(),
        };
        task.supplements.push(rec);
        L.saveTask(task);
        supplementJobs.push({ taskId: task.id, sid: newSid });
        pumpSupplements();
        console.log(`[审计] ${u.name} 对任务 ${task.id} 发起第 ${round} 轮补充审核：${text0.slice(0, 60)}`);
        return json(res, 200, { ok: true, sid: newSid, round });
      }

      if (sid && !rest && req.method === 'GET') {
        const rec = (task.supplements || []).find(x => x.sid === sid);
        if (!rec) return json(res, 404, { error: '补充审核记录不存在' });
        return json(res, 200, rec);
      }

      if (sid && (rest === '/pdf' || rest === '/download')) {
        const rec = (task.supplements || []).find(x => x.sid === sid);
        const pdfF = supplementFile(task.id, sid, '补充审核意见.pdf');
        if (fs.existsSync(pdfF)) {
          const b = fs.readFileSync(pdfF);
          const base = task.sourceName.replace(/\.[^.]+$/, '');
          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="supplement.pdf"; filename*=UTF-8''${encodeURIComponent(`${base}_补充审核意见_第${rec ? rec.round : ''}轮.pdf`)}`,
            'Content-Length': b.length,
          });
          return res.end(b);
        }
        const htmlF = supplementFile(task.id, sid, 'supplement.html');
        if (!fs.existsSync(htmlF)) return text(res, 404, '补充审核意见尚未生成');
        const html = fs.readFileSync(htmlF, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Disposition': `attachment; filename="supplement.html"; filename*=UTF-8''${encodeURIComponent(`${task.sourceName.replace(/\.[^.]+$/, '')}_补充审核意见.html`)}`,
          'Content-Length': Buffer.byteLength(html),
        });
        return res.end(html);
      }

      if (sid && (rest === '/html' || rest === '.html')) {
        const f = supplementFile(task.id, sid, 'supplement.html');
        if (!fs.existsSync(f)) return text(res, 404, '补充审核意见尚未生成');
        return text(res, 200, fs.readFileSync(f, 'utf8'), 'text/html; charset=utf-8');
      }

      return json(res, 404, { error: '未知的补充审核接口' });
    }

    // HTML 意见书（按权限自动选择完整版 / 仅校对版）
    if (sub === '/report.html' || sub === '/opinion.html') {
      const canDeep = u.role === 'admin' || !!u.deepAccess;
      const f = path.join(L.taskDir(task.id), canDeep ? 'report.deep.html' : 'report.html');
      if (!fs.existsSync(f)) return text(res, 404, '报告尚未生成');
      return text(res, 200, fs.readFileSync(f, 'utf8'), 'text/html; charset=utf-8');
    }

    if (sub === '/opinion') {
      const f = path.join(L.taskDir(task.id), 'opinion.md');
      if (!fs.existsSync(f)) return json(res, 404, { error: '意见书尚未生成' });
      return text(res, 200, fs.readFileSync(f, 'utf8'), 'text/markdown; charset=utf-8');
    }
    // ── 原报告 / 原 PPT 标注版 ──
    // 校对版（只含校对类，蓝）所有账号可下载；审核版（含全部，深红/橙/黄）需深度权限。
    // 2026-09-28: 新增 kind=ppt，即配对任务中 PPT 自身的标注版（报告与 PPT 的差异需落在 PPT 上）。
    // POST /annotate   → 开始生成（幂等；已在生成中则返回 running），前端轮询获取进度
    // GET  /annotated.pdf?scope=proof|deep&kind=report|ppt → 生成完成后下载
    if (sub === '/annotate' || sub === '/annotated.pdf') {
      const canDeep = u.role === 'admin' || !!u.deepAccess;
      let scope = 'proof', kind = '';
      if (req.method === 'POST') {
        const body = await readJsonBody(req).catch(() => ({}));
        if (body.scope === 'deep') scope = 'deep';
        if (body.kind === 'ppt') kind = 'ppt';
      } else {
        // 必须从 url.searchParams 取值，不能用 p：p 是 pathname，查询串已被剥离，
        // 写成 new URL(p, ...) 时永远读不到 scope，审核版会被静默当作校对版返回。
        const sp = url.searchParams.get('scope');
        if (sp === 'deep') scope = 'deep';
        if (url.searchParams.get('kind') === 'ppt') kind = 'ppt';
      }
      if (scope === 'deep' && !canDeep) return json(res, 403, { error: '审核版标注需要管理员或审核专家权限' });
      if (task.status !== 'done') return json(res, 400, { error: '任务尚未完成，暂无标注版' });
      // PPT 那一路只在确实存在配对 PPT 的任务上提供（无 PPT 时明确返回不存在，不以报告替代）
      if (kind === 'ppt' && !hasPairedPpt(L.taskDir(task.id))) {
        return json(res, 404, { error: '这个任务没有配对的 PPT 原件，没有 PPT 标注版' });
      }

      if (sub === '/annotated.pdf') {
        const out = annotateOut(task.id, scope, kind);
        if (!fs.existsSync(out)) {
          const st = annotateStatus(task.id, scope, kind);
          return json(res, 404, { error: (kind === 'ppt' ? 'PPT 标注版' : '标注版') + (st.status === 'running' ? '正在生成中' : '尚未生成'), ...st });
        }
        const b = fs.readFileSync(out);
        const base = (kind === 'ppt' ? (task.pptSourceName || task.sourceName) : task.sourceName).replace(/\.[^.]+$/, '');
        const who = kind === 'ppt' ? '原PPT标注版' : '原报告标注版';
        const suffix = `${who}-${scope === 'deep' ? '审核' : '校对'}`;
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="annotated.pdf"; filename*=UTF-8''${encodeURIComponent(`${base}_${suffix}.pdf`)}`,
          'Content-Length': b.length,
        });
        return res.end(b);
      }

      const st = annotateStatus(task.id, scope, kind);
      // 仅在从未生成过或明确请求重试（retry:true）时才启动新的生成任务。
      //    此前状态为 error 即自动重启：前端轮询与反复点击会使必然失败的转换每几秒重跑一次
      //    （经实测日志为 6 秒一轮），既无实际效果，也会让使用方误以为任务仍在缓慢运行。
      const wantsRetry = (req.method === 'POST');
      if (st.status === 'idle' || (st.status === 'error' && wantsRetry)) startAnnotate(task, scope, kind);
      return json(res, 200, annotateStatus(task.id, scope, kind));
    }

    // ── 下载审核成果 ──
    // 首选 PDF（浏览器打印引擎生成，版式与页面一致）；无 PDF 时回退直接返回 HTML，
    // 保证「下载」不会因转换失败而不可用。
    if (sub === '/report.pdf' || sub === '/download') {
      const canDeep = u.role === 'admin' || !!u.deepAccess;
      const dir = L.taskDir(task.id);
      const suffix = canDeep ? '审核成果' : '校对成果';
      const htmlF = path.join(dir, canDeep ? 'report.deep.html' : 'report.html');
      const pdfF = path.join(dir, canDeep ? '审核成果.pdf' : '校对成果.pdf');
      const base = task.sourceName.replace(/\.[^.]+$/, '');

      if (fs.existsSync(pdfF)) {
        const b = fs.readFileSync(pdfF);
        // HTTP 头只能是 ASCII，中文文件名必须使用 RFC 5987 的 filename*
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="audit-report.pdf"; filename*=UTF-8''${encodeURIComponent(`${base}_${suffix}.pdf`)}`,
          'Content-Length': b.length,
        });
        return res.end(b);
      }
      if (fs.existsSync(htmlF)) {
        const html = fs.readFileSync(htmlF, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Disposition': `attachment; filename="audit-report.html"; filename*=UTF-8''${encodeURIComponent(`${base}_${suffix}.html`)}`,
          'Content-Length': Buffer.byteLength(html),
        });
        return res.end(html);
      }
      return json(res, 404, { error: '成果尚未生成' });
    }

    if (sub === '/opinion.docx') {
      const canDeep = u.role === 'admin' || !!u.deepAccess;
      const deepF = path.join(L.taskDir(task.id), 'opinion.deep.docx');
      const pfF = path.join(L.taskDir(task.id), 'opinion.docx');
      // 有深度权限且审核版已导出时给审核版，否则回退到校对版
      const f = (canDeep && fs.existsSync(deepF)) ? deepF : pfF;
      if (!fs.existsSync(f)) return json(res, 404, { error: 'Word 尚未生成' });
      const b = fs.readFileSync(f);
      // HTTP 头只能是 ASCII。中文文件名必须使用 RFC 5987 的 filename*，
      //    否则 Node 抛出 ERR_INVALID_CHAR，前端表现为点击无响应（实际为 500）。
      const asciiName = 'audit-opinion.docx';
      const suffix = (f === deepF) ? '审核成果' : '校对成果';
      const utf8Name = encodeURIComponent(`${task.sourceName.replace(/\.[^.]+$/, '')}_${suffix}.docx`);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
        'Content-Length': b.length,
      });
      return res.end(b);
    }
    if (sub === '/report') {
      const f = path.join(L.taskDir(task.id), 'report.md');
      if (!fs.existsSync(f)) return json(res, 404, { error: '转换文本尚未生成' });
      return text(res, 200, fs.readFileSync(f, 'utf8'), 'text/markdown; charset=utf-8');
    }
    if (sub === '/delete' && req.method === 'POST') {
      // 审核台账必须留痕：普通用户（含获授权的审核专家）一律不能删除，只有管理员能删。
      if (u.role !== 'admin') {
        console.log(`[审计] 拒绝删除：${u.name}(${u.role}) 试图删除任务 ${task.id}（提交人 ${task.ownerName}）—— 台账留痕要求，仅管理员可删`);
        return json(res, 403, { error: '审核台账需留痕，普通用户不能删除记录，请联系管理员' });
      }
      fs.rmSync(L.taskDir(task.id), { recursive: true, force: true });
      console.log(`[审计] 管理员 ${u.name} 删除任务 ${task.id}（${task.sourceName}，提交人 ${task.ownerName}）`);
      return json(res, 200, { ok: true });
    }
  }

  if (p === '/api/stats') {
    const u = requireUser(req, res); if (!u) return;
    const all = L.listTasks();
    // 范围：管理员与审核专家看全所；普通用户只看自己的
    const scoped = (u.role === 'admin' || !!u.deepAccess) ? all : all.filter(t => t.owner === u.id);
    return json(res, 200, L.aggregateStats(scoped));
  }

  return json(res, 404, { error: '接口不存在' });
}

// ─────────────── 静态资源 ───────────────

function serveStatic(req, res, url) {
  // 静态页同样经过全局白名单：采用直接拦截策略，名单外的 IP 无法打开登录页。
  // 此处只判全局白名单（无登录态，无法判定每账号绑定）；返回可读的 HTML，避免使用方看到原始 JSON。
  const ip0 = clientIp(req);
  const v0 = L.checkIpAccess({ ip: ip0, user: null, cfg: L.getSystemConfig(), boundIps: boundIpsCached() });
  if (!v0.allowed) {
    L.appendAccessLog({ ip: ip0, path: url.pathname, ua: req.headers['user-agent'] || '', reason: v0.reason, scope: v0.scope });
    console.warn(`[访问控制] 拒绝 ${ip0} 访问页面：${v0.reason}`);
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'X-Client-IP': ip0 });
    return res.end(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>无访问权限</title><style>body{font-family:"Microsoft YaHei",sans-serif;background:#f5f7fa;color:#1a1d21;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{background:#fff;border:1px solid #e3e8ee;border-radius:6px;padding:36px 44px;max-width:560px;line-height:1.9}
h1{font-size:20px;color:#b42318;margin:0 0 12px}code{background:#f0f4f9;padding:2px 6px;border-radius:3px}</style>
</head><body><div class="box">
<h1>本机没有访问权限</h1>
<p>${v0.reason}</p>
<p>你的 IP：<code>${ip0}</code></p>
<p style="color:#6b7280;font-size:13.5px">如属误拦，请把上面这行 IP 报给系统管理员，
由管理员在「系统管理 → 用户管理 → 访问控制」里加入白名单。</p>
</div></body></html>`);
  }
  const rel = url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^([/\\])+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  // 目录穿越防护：此前用 `file.startsWith(PUBLIC_DIR)` 判前缀（`..\public-evil\x` 亦可通过），
  // 现改为计算相对路径：只要超出 PUBLIC_DIR（以 .. 开头或成为绝对路径）一律拒绝。
  const relCheck = path.relative(PUBLIC_DIR, file);
  const outside = relCheck.startsWith('..') || path.isAbsolute(relCheck);
  // 只服务前端真正用得到的几类文件，其它一律 404（公开目录里将来误放进敏感文件也不会被下载）
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.ico': 'image/x-icon', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
  const ext = path.extname(file).toLowerCase();
  if (outside || !MIME[ext] || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return text(res, 404, 'Not Found');
  }
  const b = fs.readFileSync(file);
  // 静态页必须禁缓存：此前只发 Content-Type/Content-Length，浏览器按启发式缓存继续用旧页面，
  // 结果"改了代码、刷新也没变化"（2026-10-09 排查到：搜索框修复在服务端已生效，浏览器却在跑旧 JS）。
  // 前端全部内联在这一个 HTML 里，禁掉缓存不会带来额外请求开销。
  res.writeHead(200, {
    'Content-Type': MIME[ext],
    'Content-Length': b.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
    ETag: `W/"${b.length}-${fs.statSync(file).mtimeMs}"`,
  });
  res.end(b);
}

// ─────────────── 启动 ───────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    harden(res);                                       // 统一加 nosniff / Referrer-Policy / X-Frame-Options
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    console.error('请求处理异常:', e);
    if (!res.headersSent) json(res, 500, { error: e.message });
  }
});

L.ensureDirs();
const boot = L.bootstrapAdmin();
const recovered = recoverOrphans();

/**
 * 编码闸门（2026-09-24 事故后增设的机器校验）。
 *
 * 事故经过：使用 PowerShell 读写 index.html，UTF-8 内容被按 GBK 往返转换，
 * 造成 635 行中文损坏、界面显示异常。界面损坏比服务停止更难排查，
 * 因此扫描到乱码即拒绝启动，并明确报出文件与行号。
 * 约定（人工）+ 闸门（机器）同时实施，避免再次发生。
 */
const guard = EG.scanTree();
if (guard.errors.length) {
  console.error('═══════════════════════════════════════════════');
  console.error('  ✗ 编码体检未通过 —— 服务拒绝启动（避免把坏界面发出去）');
  console.error(EG.formatScan(guard));
  console.error('  处理办法：把上面文件用 UTF-8 重新保存；改文件内容请用 edit/write 工具，');
  console.error('            不要用 PowerShell 的 Get-Content/WriteAllText 读写文本（会按 GBK 洗）。');
  console.error('  临时绕过（仅排查用）：WB_SKIP_ENCODING_GUARD=1');
  console.error('═══════════════════════════════════════════════');
  if (process.env.WB_SKIP_ENCODING_GUARD !== '1') process.exit(1);
  console.error('  （已按 WB_SKIP_ENCODING_GUARD=1 强制继续）');
}

/** 取当前生效的 key 及其来源，用于启动日志（只暴露指纹，不写完整 key） */
function readKeyInfo() {
  const ki = engineApiKeyInfo();
  return { ...ki, fp: keyFingerprint(ki.key) };
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('═══════════════════════════════════════════════');
  console.log('  石油天然气工程咨询成果智能审核平台 — 内网服务已启动');
  console.log('═══════════════════════════════════════════════');
  console.log(`  启动时间 : ${new Date().toLocaleString('zh-CN')}`);
  console.log(`  本机访问 : http://127.0.0.1:${PORT}`);
  const lanIP = (() => { try { for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address; } catch {} return '(本机内网地址)'; })();
console.log(`  使用方访问 : http://${lanIP}:${PORT}`);
  console.log(`  数据目录 : ${L.DATA_DIR}`);
  console.log(`  编码体检 : ✓ ${guard.checked.length} 个源码/界面文件干净${guard.warnings.length ? `（另有 ${guard.warnings.length} 处提示）` : ''}`);
  // 标注版工具链体检必须在启动时输出。
  // 2026-09-28: pdftoppm/pdftotext 此前依赖 PATH 查找，开发环境可找到（位于管理员用户 PATH 中），
  // 但生产环境以 SYSTEM 运行、读不到用户 PATH，导致每次生成标注版都 ENOENT 静默失败；
  // 使用方的感受是「点了还要等、等了也不出来」，而日志中仅一行 ERROR，无人查看。
  {
    const ts = toolchainStatus();
    if (ts.ok) {
      console.log(`  标注工具 : ✓ soffice + pdftoppm + pdftotext 都在（标注版随审核自动生成）`);
    } else {
      console.log(`  标注工具 : ✗ ${toolchainHint(ts)}`);
      console.log(`             ⚠️ 标注版会生成失败（不影响审核成果）。修好后重启即可。`);
    }
  }
  // 启动时把「用的是哪家模型、哪把 key」记进日志，方便核对费用与排查
  try {
    const ki = readKeyInfo();
    const mc = M.loadModelConfig();
    const prov = M.modelConfigSummary().provider;
    console.log(`  模型     : ${prov.name}　模型 ${mc.model}　${mc.baseUrl}`);
    // 单独输出一行「审核实际使用的模型」：设置中的模型名与实际调用的模型可能不一致
    //   （DeepSeek 固定使用 flash，见 auditModelName()），不明确写出会造成「界面为 A、实际为 B」的误判。
    console.log(`  审核模型 : ${activeModelName()}${mc.providerId === 'deepseek' ? '（DeepSeek 家固定 flash，设置里那一栏不生效）' : '（取设置里的模型名）'}`);
    console.log(`  API Key  : ${ki.label}　指纹 ${ki.fp}${ki.source === 'workbuddy' ? '　⚠️ 正在用兜底 key，平台费用会与 WorkBuddy 混在一起' : ''}`);
  } catch (e) {
    console.log(`  API Key  : ✗ ${e.message}`);
  }
  console.log('  ── 并发与保护 ──');
  console.log(`  同时处理 : ${MAX_CONCURRENT} 个任务 · 每个任务最多 ${process.env.S2_CONCURRENCY || 3} 路单元并发`
    + ` → 瞬时最多约 ${MAX_CONCURRENT * (Number(process.env.S2_CONCURRENCY) || 3)} 路 API 请求（接口上限 2500）`);
  console.log(`  每人上限 : 在跑 ≤${L.PER_USER_RUNNING} 个（管理员 ≤${L.PER_USER_RUNNING_ADMIN} 个）、队列里待处理 ≤${L.PER_USER_QUEUED} 个（公平调度：手上没在跑的优先）`);
  console.log(`  加急上限 : 管理员「立即开始」最多额外 +${MAX_BOOST} 路（MAX_BOOST）`);
  console.log(`  排队上限 : ${MAX_QUEUE} 个就绪 + ${MAX_WAITING} 个等待闲时（MAX_QUEUE / MAX_WAITING）`);
  console.log(`  任务超时 : ${Math.round(TASK_TIMEOUT_MS / 60000)} 分钟（TASK_TIMEOUT_MS）`);
  // 在线人数按分钟采样一次：若仅在有人打开看板或登录时采样，最高在线可能整个上午都不刷新
  // （使用方在使用但无人打开看板）。每分钟一次、只读一次 sessions.json，开销可忽略。
  {
    const st0 = L.readOnlineStats();
    if (st0.peak) console.log(`  在线峰值 : 历史最高 ${st0.peak} 人（${L.fmtBJText(st0.peakAt)}）· 今日最高 ${st0.dayPeak} 人`);
    setInterval(() => { try { L.recordOnlineSample(L.onlineNow().count); } catch { /* ignore */ } }, 60 * 1000).unref?.();
  }
  if (recovered) console.log(`  已回收重启中断任务：${recovered} 个`);
  if (boot) {
    console.log('  ─────────────────────────────────────────────');
    console.log('  ★ 首次启动，已创建管理员账号：');
    console.log(`     用户名 : ${boot.username}`);
    console.log(`     密  码 : ${boot.password}`);
    console.log('    请立即登录后修改密码。');
  }
  console.log('═══════════════════════════════════════════════');
});
