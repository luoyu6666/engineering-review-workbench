/**
 * 审核工作台 — Web 服务入口
 *
 *   node web/server.mjs            启动（默认端口 8787）
 *   PORT=9000 node web/server.mjs  指定端口
 *
 * 首次启动会自动创建管理员账号并把初始密码打印到控制台。
 */

import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as L from './lib.mjs';
import { runPipeline, stage0Preflight, stageSupplementAudit, stage3Rules, stage4Grade } from '../engine/lib/pipeline.mjs';
import { getApiKey as engineApiKey, getApiKeyInfo as engineApiKeyInfo, keyFingerprint, MODELS, readSkill, readSkillOptional, callDeepSeek, extractJson } from '../engine/lib/core.mjs';
import { renderAppendix } from '../engine/lib/pipeline.mjs';
import { renderHtmlReport, renderSupplementReport, classify, PROOFREAD_CATEGORIES } from '../engine/lib/report-html.mjs';

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
const parseCookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(a => a.length === 2).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.ico': 'image/x-icon', '.png': 'image/png' };

function currentUser(req) {
  const sid = parseCookies(req)['sid'];
  return L.getSession(sid);
}
function requireUser(req, res) {
  const u = currentUser(req);
  if (!u) { json(res, 401, { error: '未登录' }); return null; }
  return u;
}
function requireAdmin(req, res) {
  const u = requireUser(req, res);
  if (!u) return null;
  if (u.role !== 'admin') { json(res, 403, { error: '需要管理员权限' }); return null; }
  return u;
}

// ─────────────── 审核队列 ───────────────

const queue = [];
let running = 0;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 2);   // 同时处理的审核任务数
const MAX_QUEUE      = Number(process.env.MAX_QUEUE || 30);       // **就绪**任务的排队上限
// ⚠️ 等待闲时的任务**不占** MAX_QUEUE 名额，单独设上限。
// 教训：早先名额算的是 queue 数组长度，而 waiting 任务也在数组里 ——
//   周一早上 15 个人各交 2 份（默认就是闲时调用），30 份全进 waiting 等 12:10，
//   于是 09:05~12:10 队列长度恒为 30，**任何人再提交都被 503 挡住**，
//   而这段时间服务器其实是完全空闲的。提示语还说"排队已达上限"，根本查不出原因。
const MAX_WAITING    = Number(process.env.MAX_WAITING || 100);
const TASK_TIMEOUT_MS = Number(process.env.TASK_TIMEOUT_MS || 25 * 60 * 1000);

const queuePosition = (taskId) => { const i = queue.indexOf(taskId); return i < 0 ? null : i + 1; };

/**
 * 能不能开始跑这个任务。
 * ⚠️ 必须分两段判断：
 *   · 还没做本地预处理（preprocessedAt 为空）→ **随时可以开始**，
 *     因为文档解析是本地操作、不花钱，高峰期也该立刻做。
 *   · 预处理已完成 → 才受 apiStartAt（闲时起跑时刻）约束。
 * 早先把 scheduledAt 在提交时就设成 apiStartAt，结果预处理也被一起卡住，
 * 任务会一直停在「排队中」什么都不做——那是错的。
 */
const canStart = (id) => {
  const t = L.getTask(id);
  if (!t) return false;
  if (!t.preprocessedAt) return true;
  return !t.apiStartAt || new Date(t.apiStartAt) <= new Date();
};

/** 是否在「等待闲时」：已解析完，但在等起跑时刻 */
const isWaiting = (id) => {
  const t = L.getTask(id);
  return !!(t && t.preprocessedAt && t.apiStartAt && new Date(t.apiStartAt) > new Date());
};

/**
 * 队列分两类统计：
 *   ready   —— 现在就能跑（或用等待名额限制它们）
 *   waiting —— 已解析完，躺着等闲时窗口；**不占服务器资源**，因此不占 ready 名额
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
    // 只有「已预处理、在等起跑時刻」的任务才需要定时唤醒
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
  while (running < MAX_CONCURRENT) {
    // 不阻塞队首：跳过尚未到点的闲时任务，先跑可以跑的
    const idx = queue.findIndex(canStart);
    if (idx < 0) { scheduleWake(); return; }
    const id = queue.splice(idx, 1)[0];
    running++;
    withTimeout(runTask(id), TASK_TIMEOUT_MS, '审核')
      .catch(e => {
        console.error(`[task ${id}] 异常:`, e.message);
        const t = L.getTask(id);
        if (t && !['done', 'failed', 'cancelled'].includes(t.status)) {
          t.status = 'failed'; t.error = e.message; t.finishedAt = new Date().toISOString();
          // ⚠️ 必须先落盘状态、再追加进度：appendProgress 内部会**重新读盘**、只合并 progress 数组，
          //    直接 appendProgress(t, ...) 会把这里刚设的 'failed' 丢掉 ——
          //    任务于是留在 'queued'，pump() 反复取它重跑（实测踩过，4 个任务全卡住）。
          L.saveTask(t);
          L.appendProgress(t, `失败：${e.message}`);
        }
      })
      .finally(() => { running--; pump(); });
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
   * 任务是不是已经被取消了？
   * ⚠️ 必须每跨一个阶段都重新读盘 —— 这里踩过真实的竞态坑：
   *   用户点「取消」时任务刚被 pump() 从队列取走，runTask 手里还攥着旧的 task 对象，
   *   后面每次 L.saveTask(task) 都会把用户刚写下的 'cancelled' 覆盖掉，
   *   于是「取消了还在跑」，甚至照常花钱调 AI。实测复现过。
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
   * 受保护的落盘：盘上已被取消就**不覆盖**。
   * runTask 运行期间可能长达几分钟，用户随时可能点取消；
   * 直接 L.saveTask(task) 会用内存里的旧副本把 cancelled 改回去 —— 这是真踩过的竞态。
   */
  const save = () => {
    const cur = L.getTask(id);
    // 盘上已经没有这个任务 → 它被删了（管理员删除 / 清理），**绝不能再写回去**，
    // 否则会把已删除的任务复活。appendProgress 里有同样的坑，一起修的。
    // 表现：删了任务，过一会儿它又出现在台账里（实测两次，还让用户误以为"有条待处理"）。
    if (!cur) {
      console.log(`[${id}] 任务已被删除，跳过写盘`);
      return false;
    }
    if (cur.status === 'cancelled' && task.status !== 'cancelled') {
      console.log(`[${id}] 盘上状态已是 cancelled，跳过写盘以免覆盖用户的取消`);
      return false;
    }
    // ⚠️ 必须是 L.saveTask(task)。曾经用批量正则把 'L.saveTask(task)' 全换成 'save()'，
    //    结果把 save 函数**自己体内**这一行也换了 → save() 自我调用 → 栈溢出；
    //    语法检查发现不了（合法递归），任务会全部卡在 queued 反复重跑。
    L.saveTask(task);
    return true;
  };

  try {
    // ① 预处理（纯本地，零 API 成本）：.doc → .docx → markdown
    //    这一步与计费时段无关，所以**提交后立刻做**，不管是不是高峰时段。
    //    闲时任务在这里做完就停下来等窗口，把花钱的 API 调用全部留到空闲时段。
    task.status = 'converting'; task.startedAt = new Date().toISOString(); save();
    log('开始处理：文档转换（本地预处理，不产生 API 费用）');
    // 「仅 PPT」任务没有报告可转：跳过，等下面把 PPT 装进来后直接用它当审核对象
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

    // ①.1 配对的 PPT（可选）：把暂存的文件搬进任务目录并取出幻灯片文字
    //     转换已经在暂存阶段做过了（用户能看到进度，也能提前知道内容够不够），
    //     所以这里只是搬运 + 读文件，不重复转换。
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

    // ①.1 本地查重粗筛（零 API）：拿已登记项目的编号/名称去正文里找。
    //      闲时任务可能几小时后才跑 S0，那时候再提醒就太晚了，所以这里先给一个预警。
    //      权威判定在下面的 S0 之后（识别出真实项目名才算数）。
    const quickDup = L.quickDuplicateCheck(L.listTasks(), text.slice(0, 30000), { excludeTaskId: task.id });
    if (quickDup.length) {
      task.duplicatePreview = L.summarizeDuplicates(quickDup);
      save();
      const others = quickDup.filter(t => t.owner !== task.owner);
      log(`⚠️ 本地查重预警：正文里出现了已知项目「${quickDup[0].projectName || quickDup[0].sourceName}」`
        + `（${quickDup.length} 条历史记录${others.length ? `，其中 ${others.length} 条是他人提交` : ''}）。`
        + `以 AI 预审识别出的项目为准，届时会再次核对。`);
    }

    // ①.2 闲时调用模式：预处理已完成，若还没到空闲时段就交回队列等窗口
    //      （API 起跑时刻 = 高峰结束 + 10 分钟，见 lib.nextOffPeakStart）
    //
    //      ⚠️ 这里要处理「错过了窗口」的情况：机器关机 / 停电 / 重启，等到第二天上班才恢复时，
    //         原来的 apiStartAt 早已过去 —— 如果直接开跑，就会在高峰时段按 2 倍价计费，
    //         与用户选「闲时调用」的初衷相反。所以：闲时模式的任务若当前正处于高峰，
    //         把起跑时刻顺延到下一个空闲窗口。
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

    // ★ 跨过这条线就要花钱了。这里再查一次任务是否已被取消 —— 这是止损的最后一道关。
    if (abortIfCancelled('调用 AI 之前', '（尚未产生任何 API 费用）')) return;

    // ①.5 预审：识别项目 + 报告类型 + 项目类型 + 检查该项目的「质量配额」
    //      按项目累计校对类问题，超阈值直接拒绝 —— 目的在正式审核（约 40 万 token）之前拦下，
    //      既督促初稿质量，也避免无效消耗。
    //      ⚠️ 确认重复审核后恢复执行时（preflightDone），这些字段已经识别过，直接复用，
    //         不再花第二次 S0 的钱。
    let pf = null;    // S0 的用量要在下面并入总用量，所以在块外声明
    if (task.preflightDone && task.projectName) {
      log(`预审已完成过，直接复用识别结果（项目「${task.projectName}」，类型「${task.templateName}」），不再重复调用 S0`);
    } else {
      log('预审：识别项目名称、报告类型与项目类型…');
      pf = await stage0Preflight({
        apiKey: engineApiKey(), model: MODELS.flash,
        fileName: task.sourceName, reportText: text, log,
        projectTypes: L.projectTypeOrder(),
        reportTypes: L.BIZ_TYPES.map(x => x.name),
      });
      task.projectName = pf.projectName;
      task.projectCode = pf.projectCode || '';

      // 报告类型：S0 识别 → 对齐已知类型 → 文件名关键词兜底。用户不再手选。
      const detectedBiz = L.normalizeBizType(pf.reportType) || L.guessBizType(pf.projectName, task.sourceName, text.slice(0, 1500));
      task.bizType = detectedBiz;
      task.templateName = L.bizTypeName(detectedBiz);
      task.templateId = '';
      task.reportTypeRaw = pf.reportType || '';
      task.typeAutoDetected = true;
      log(`自动识别报告类型：${task.reportTypeRaw ? `「${task.reportTypeRaw}」→ ` : ''}${task.templateName}`);

      // 项目类型（看板分类维度）：S0 识别 → 对齐清单 → 关键词兜底 → 其他/未分类
      task.projectType = L.normalizeProjectType(pf.projectType)
        || L.guessProjectType(pf.projectName, task.sourceName, task.templateName);
      log(`自动识别项目类型：${task.projectType}`);
    }

    const sys = L.getSystemConfig();
    const qc = L.checkProjectQuota(L.listTasks(), task.projectName, sys.projectLimit);
    task.projectQuota = qc;
    save();
    // ⚠️ 用户要求：项目质量配额**先只统计、不拦截**，观察一段时间再决定是否启用。
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

    // ①.7 重复审核判定（权威）：项目名/编号识别出来之后才算数。
    //     需求：**不同人员**提交同一个项目时提醒重复审核。默认暂停等确认，避免白跑一次
    //     （约 ¥0.7 API + ¥260 人工工时，还会在台账里多出一条同项目记录）。
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
    log('进入审核流水线（S1 结构化 → S2 分维度 → S3 规则 → S4 分级 → S5 成文）');

    const result = await runPipeline({
      apiKey: engineApiKey(),
      model: MODELS.flash,
      reportText: text || task.pptText || '',
      reportName: task.sourceName.replace(/\.[^.]+$/, ''),
      pptOnly: !!task.pptOnly,
      runDir: path.join(dir, 'run'),
      log,
      reportTypeName: task.templateName,
      learned: readSkillOptional('LEARNED.md'),           // 平台积累的审核经验（人工反馈沉淀）
      // ── PPT 配对（可选）──
      // 提交时带了 PPT 才有值：ppt 单元审幻灯片本身；crossCheck 为真时再加一致性核对单元。
      // 没带 PPT 时这两个参数为空串，流水线一个额外调用都不会增加。
      pptText: task.pptText || '',
      pptName: task.pptSourceName || '',
      crossCheck: !!task.crossCheck,
      // 定向经验按两个维度同时注入：报告类型（一类报告的通病）+ 指定项目（该项目的特殊要求）。
      // projectType 在 S0 预审后才有；没识别出来时按名称/文件名兜底猜一个，宁可少注入也不要注入错。
      projectLearned: L.learnedForContext({
        projectName: task.projectName,
        projectType: task.projectType || L.guessProjectType(task.projectName, task.sourceName, task.templateName),
      }),
    });

    // ③ 生成 HTML 意见书（代码生成；两份：完整版 / 仅校对版）
    const g = result.graded;
    const reportMeta = {
      id: task.id, sourceName: task.sourceName, templateName: task.templateName,
      ownerName: task.ownerName, createdAt: task.createdAt, bizType: task.bizType,
      projectName: task.projectName, projectCode: task.projectCode, projectType: task.projectType,
    };
    const htmlFull = renderHtmlReport({ task: reportMeta, graded: g, narrative: result.narrative, deepAccess: true, model: MODELS.flash });
    const htmlPf = renderHtmlReport({ task: reportMeta, graded: g, narrative: result.narrative, deepAccess: false, model: MODELS.flash });
    fs.writeFileSync(path.join(dir, 'report.html'), htmlPf, 'utf8');          // 默认（普通用户）
    fs.writeFileSync(path.join(dir, 'report.deep.html'), htmlFull, 'utf8');   // 完整版
    fs.writeFileSync(path.join(dir, 'narrative.md'), result.narrative || '', 'utf8');
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
      model: MODELS.flash,
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

    // ④.5 项目质量台账：台账是从任务实时派生的，这里只需登记项目显示名；
    //      本次新增多少、项目累计多少，等任务落盘后统一从派生值取，保证和看板一致。
    L.touchProject(task.projectName, { owner: task.ownerName, taskId: task.id });
    task.projectProofreadAdded = pfCount;
    save();
    {
      const row = L.projectStats(L.listTasks(), { limit: qc.limit }).find(x => x.key === qc.key);
      task.projectProofreadTotal = row ? row.proofreadTotal : pfCount;
      save();
      log(`项目质量台账：项目「${row ? row.name : task.projectName}」累计校对类问题 ${task.projectProofreadTotal} 项（上限 ${qc.limit}），本次新增 ${pfCount} 项`);
    }

    // ⑤ 导出「可下载的成果」：HTML → PDF（用本机浏览器的打印引擎，版式与页面一致）。
    //    校对版与审核版各出一份，下载时按权限给对应版本。
    //    ⚠️ 不再导出 Word：pandoc 转出来的表格/分页走样，用户反馈过。
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
// 场景：管理员看过一轮成果后，觉得某个方面还要再压一压（"重点核这个投资口径"/"再查一遍建议的针对性"），
//       填写补充要求 → 系统针对该要求做一次**定向深入核查** → 单独出一份《补充审核意见》HTML。
//
// 实现取舍：复用首轮已经抽好的 S1 事实（run/s1_facts.json）与报告正文（report.md），
//           只发 1 次 API 调用。整条流水线是 9 次调用，补充审核不该重复付这个钱。
// 结果单独存放，不覆盖常规成果，支持多轮累积，便于逐轮追溯。

const supplementJobs = [];        // 内存队列（服务重启后未完成的会标记为中断，不自动重跑，避免意外花钱）
let supplementRunning = false;
const MAX_SUPPLEMENT_NOTE = 800;

// ⚠️ 每轮一个独立子目录：早先漏掉 sid，几轮补充审核会互相覆盖同名文件。
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
      apiKey: engineApiKey(), model: MODELS.flash,
      reportText, facts, note: rec.note, skillMain,
      log: (m) => log(m),
      learned: readSkillOptional('LEARNED.md'),
      // 定向经验按两个维度同时注入：报告类型（一类报告的通病）+ 指定项目（该项目的特殊要求）。
          // projectType 在 S0 预审后才有；没识别出来时按名称/文件名兜底猜一个，宁可少注入也不要注入错。
          projectLearned: L.learnedForContext({
            projectName: task.projectName,
            projectType: task.projectType || L.guessProjectType(task.projectName, task.sourceName, task.templateName),
          }),
    });

    // 与常规审核同一套代码判定：跑一遍规则 + 分级闸门
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
      model: MODELS.flash,
      promptTokens: u.prompt || 0, completionTokens: u.completion || 0,
      cacheHitTokens: u.cacheHit || 0, peak,
    });

    const html = renderSupplementReport({
      task,
      note: rec.note,
      graded,
      meta: { ...rec, model: MODELS.flash, cost, usage: u, peak },
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

  // —— 认证 ——
  // 取真实来源 IP（有反代时优先 X-Forwarded-For）
  const clientIp = (req) => (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress || '').replace('::ffff:', '');

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
    if (!u || !L.verifyPassword(password || '', u.salt, u.hash)) {
      // 固定延迟：把机器速度从 ~40 次/秒压到 ~1 次/秒（正常用户一次就成功，无感）
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
    L.recordAuthEvent({ userId: u.id, name: u.name, event: 'login', req });
    res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}`);
    console.log(`[审计] 登录：${u.name}（${u.role}）来自 ${ip}`);
    return json(res, 200, { id: u.id, username: u.username, name: u.name, role: u.role, defaultPassword: !!u.defaultPassword });
  }
  if (p === '/api/logout' && req.method === 'POST') {
    const sid = parseCookies(req)['sid'];
    const u = currentUser(req);
    L.destroySession(sid);
    if (u) L.recordAuthEvent({ userId: u.id, name: u.name, event: 'logout', req });
    res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
    return json(res, 200, { ok: true });
  }
  if (p === '/api/me') {
    const u = currentUser(req);
    if (!u) return json(res, 200, null);
    const usage = L.usageOf(L.listTasks(), u.id);
    // 第 6 条：费用 / token 不对普通用户显示 —— 服务端直接不返回，不只是前端隐藏
    const canDeep = u.role === 'admin' || !!u.deepAccess;
    if (!canDeep) { delete usage.costMonth; delete usage.tokensMonth; }
    return json(res, 200, {
      id: u.id, username: u.username, name: u.name, role: u.role,
      defaultPassword: !!u.defaultPassword,
      deepAccess: canDeep,
      dailyLimit: u.role === 'admin' ? 0 : (u.dailyLimit ?? L.DEFAULT_DAILY_LIMIT),
      monthlyLimit: u.role === 'admin' ? 0 : (u.monthlyLimit ?? L.DEFAULT_MONTHLY_LIMIT),
      usage, isPeak: L.isPeakHour(),
      nextOffPeak: L.nextOffPeakStart().toISOString(),
    });
  }

  // 用量统计（本人；管理员与获授权审核专家可加 ?all=1 看全部）
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
        dailyLimit: u.role === 'admin' ? 0 : (u.dailyLimit ?? L.DEFAULT_DAILY_LIMIT),
        monthlyLimit: u.role === 'admin' ? 0 : (u.monthlyLimit ?? L.DEFAULT_MONTHLY_LIMIT),
      },
      byUser: Object.entries(byUser).map(([name, v]) => ({ name, ...v, cost: Math.round(v.cost * 100) / 100 }))
        .sort((a, b) => b.cost - a.cost),
      byDay: Object.entries(byDay).sort().map(([day, v]) => ({ day, count: v.count, cost: Math.round(v.cost * 100) / 100 })),
      pricing: L.PRICING['deepseek-flash'],
      isPeak: L.isPeakHour(),
    };
    // 普通用户不展示 token / 缓存命中率 / 费用 —— 服务端直接不返回，不只是前端隐藏
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

    // 本月 API 费用与本月审核次数（仅 canDeep 用；按北京时间归月）
    // ⚠️ 只统计**用量记录完整**的任务，否则历史残缺记录会把本月费用拉低（与合计口径保持一致）
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

    // 闲时 / 忙时调用统计 —— 属于看板范畴，随看板一次返回，不再单开接口
    if (canDeep) {
      const range = String(url.searchParams.get('range') || 'all');
      payload.traffic = L.buildPeakStats(scoped, { range });
    }

    // ── 四、API 费用口径（只算 API，不含人工）──
    // 用户明确：这一块就是 API 的价格，不要把人工工时折进去。
    if (canDeep) {
      const rate = L.PRICING['deepseek-flash'];
      const uu = payload.usage;
      const perAudit = uu.perAuditCost || 0;
      const monthTasksCount = monthTasks.length;
      const daysElapsed = Math.max(1, bj(Date.now()).getUTCDate());

      // 年化：优先用「单次平均 × 预计年审核量」，样本不足时退回「本月节奏 × 年」
      const monthPaceAnnual = monthApiCost / daysElapsed * 365;
      payload.apiCost = {
        perAudit,                                  // 单次平均 API 费用（只算记录完整的任务）
        perAuditTokens: uu.perAuditTokens,
        cost: uu.cost,                             // 范围内合计
        countedTasks: uu.countedTasks,
        incompleteTasks: uu.incomplete.count,
        incompleteCostForReference: uu.incomplete.cost,
        monthCost: Math.round(monthApiCost * 100) / 100,
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
    } else {
      const u2 = L.usageOf(all, u.id);
      payload.quota = {
        usedToday: u2.usedToday, usedMonth: u2.usedMonth,
        dailyLimit: u.dailyLimit ?? L.DEFAULT_DAILY_LIMIT,
        monthlyLimit: u.monthlyLimit ?? L.DEFAULT_MONTHLY_LIMIT,
      };
    }
    return json(res, 200, payload);
  }

  // 闲时/忙时统计已并入 /api/dashboard（属于看板范畴），不再单开接口。
  // 这里保留一条兼容路由，避免旧页面缓存或外部脚本直接 404。
  if (p === '/api/peak-stats' && req.method === 'GET') {
    const u = requireUser(req, res); if (!u) return;
    const canDeep = u.role === 'admin' || !!u.deepAccess;
    if (!canDeep) return json(res, 403, { error: '需要管理员或审核专家权限' });
    console.log('[deprecated] /api/peak-stats 请改用 /api/dashboard?range=');
    const range = String(url.searchParams.get('range') || 'all');
    const all = L.listTasks();
    const scoped = url.searchParams.get('scope') === 'mine' ? all.filter(t => t.owner === u.id) : all;
    return json(res, 200, { scope: url.searchParams.get('scope') === 'mine' ? 'mine' : 'all', ...L.buildPeakStats(scoped, { range }) });
  }

  // ── AI 技能完善（人工反馈学习）──
  // 分层：人工意见 → 结构化经验条目（web/data/skill-feedback.json）
  //       → 生成 LEARNED.md（skill 目录）→ 引擎读取并注入审核提示。
  // Skill 原件（WorkBuddy 同步副本 SKILL.md）一个字都不动。
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
          // 还没经过 AI 融合审阅 → 勾选口径的条目数（提醒用户"存了但没应用"）
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
        // 一条经验可以挂多个项目：一类报告常常几份都有同样的毛病，不必逐条录。
        // 兼容老客户端传的单个 projectName。
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
          // 单/多都写：单值字段给老页面与列表展示用，复数才是权威值
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

      // apply 是对**全部条目**整体生效，不需要 id —— 必须放在 id 查找之前，
      // 否则会先被 "条目不存在" 拦掉（之前就踩了这个坑）。
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

  // ── AI 融合审阅（不写入，只出分析报告）──
  //
  // 为什么要有这一步：早先「生成并应用」就是把经验条目拼成 Markdown 覆盖 LEARNED.md，
  // **完全不读原技能**。于是与原文冲突的口径会同时塞进提示里让模型自己纠结，
  // 重复的条目也照加。这里让 AI 先把新经验和原技能逐条对比，
  // 给出「新增 / 冲突 / 重复 / 细化」判定 + 融合建议 + 若干条候选口径，由人来勾选。
  //
  // 只读不改：确认写入是另一步（/api/skill-apply），确保人工有否决权。
  if (p === '/api/skill-merge-review' && req.method === 'POST') {
    const u = requireAdmin(req, res); if (!u) return;
    const active = L.listFeedback().filter(x => x.status !== 'archived');
    if (!active.length) return json(res, 400, { error: '还没有生效中的经验条目，先「保存为经验条目」。' });

    // 技能正文：readSkill(rel) 要传**相对路径**。
    // ⚠️ 早先这里写成了 readSkill()，参数为空 → 抛错 → 被 catch 吞掉 → skillExcerpt 变成空串，
    //    于是 AI 在完全没看到技能的情况下"判断冲突"，其实是复述用户意见里的话。
    //    这种错不报错、结果还像模像样，最危险。所以下面把长度也返回给前端，便于一眼看出技能有没有进去。
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
    // 技能很长（~88KB），设一个上限避免把预算全花在流程说明上
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
        apiKey: engineApiKey(), model: MODELS.flash,
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
    // 不是 promptTokens —— 传错会静默算成 ¥0（踩过）。
    const cost = L.calcCost({
      model: MODELS.flash,
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
      // 把技能体量回传：一眼就能确认技能有没有真的读进去（早先空技能也"分析"得像模像样）
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
      // 插到兜底项之前
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
    const purged = L.purgeOrphanSessions();       // 顺手清掉账号已删除的死会话
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

    // 把「谁删过任务」「谁发起过补充审核」也从任务记录里翻出来，构成完整轨迹
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
        dailyLimit: target.dailyLimit ?? L.DEFAULT_DAILY_LIMIT,
        monthlyLimit: target.monthlyLimit ?? L.DEFAULT_MONTHLY_LIMIT,
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
    // 清零 = 记一个 resetAt（只统计此后完成的任务）。**不改任务数据**，留痕不受影响，
    // 而且计数是从任务派生的，所以清零点之后新跑的任务会重新累计。
    const target = name || (L.projectStats(L.listTasks()).find(x => x.key === key) || {}).name || key;
    L.resetProject(target);
    console.log(`[审计] ${u.name} 将项目「${target}」的质量台账清零（记 resetAt，任务留档不变）`);
    return json(res, 200, { ok: true });
  }

  // ── 系统开关（项目质量配额是否拦截等）──
  if (p === '/api/system-config' && req.method === 'GET') {
    const u = requireUser(req, res); if (!u) return;
    if (!(u.role === 'admin' || u.deepAccess)) return json(res, 403, { error: '需要管理员或审核专家权限' });
    return json(res, 200, L.getSystemConfig());
  }
  if (p === '/api/system-config' && req.method === 'POST') {
    const u = requireAdmin(req, res); if (!u) return;
    const body = await readJsonBody(req);
    // duplicateMode 只接受两个已知取值，避免前端传错把拦截逻辑弄失效
    if (body.duplicateMode !== undefined && !['block', 'warn'].includes(body.duplicateMode)) {
      return json(res, 400, { error: "duplicateMode 只能是 'block'（暂停等确认）或 'warn'（只提醒）" });
    }
    return json(res, 200, L.saveSystemConfig(body));
  }

  // ── 综合成本模型（API + 人工 + 设备摊销）──
  if (p === '/api/cost-model' && req.method === 'GET') {
    const u = requireUser(req, res); if (!u) return;
    if (!(u.role === 'admin' || u.deepAccess)) return json(res, 403, { error: '需要管理员或审核专家权限' });
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
    return json(res, 200, L.listUsers().map(({ salt, hash, ...x }) => {
      const a = g.accounts[x.id];
      const locked = !!(a && a.lockedUntil && new Date(a.lockedUntil).getTime() > now);
      return {
        ...x,
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
    const { id, disabled, role, name, resetPassword, username, deepAccess, dailyLimit, monthlyLimit } = await readJsonBody(req);
    const users = L.listUsers(); const t = users.find(x => x.id === id);
    if (!t) return json(res, 404, { error: '用户不存在' });
    if (disabled !== undefined) t.disabled = !!disabled;
    if (role) t.role = role;
    if (name) t.name = name;
    if (deepAccess !== undefined) t.deepAccess = !!deepAccess;          // 能否查看深度类报告
    if (dailyLimit !== undefined) t.dailyLimit = Math.max(0, Number(dailyLimit) || 0);      // 0 = 不限
    if (monthlyLimit !== undefined) t.monthlyLimit = Math.max(0, Number(monthlyLimit) || 0);
    if (username !== undefined) {
      const un = String(username).trim();
      if (!un) return json(res, 400, { error: '用户名不能为空' });
      if (users.some(x => x.username === un && x.id !== id)) return json(res, 400, { error: '该用户名已存在' });
      t.username = un;
    }
    if (resetPassword) { Object.assign(t, L.hashPassword(resetPassword)); t.defaultPassword = true; }
    L.saveUsers(users); return json(res, 200, { ok: true, username: t.username });
  }

  // —— 任务 ——
  if (p === '/api/tasks' && req.method === 'GET') {
    const u = requireUser(req, res); if (!u) return;
    const all = L.listTasks();
    const canDeep = u.role === 'admin' || !!u.deepAccess;
    // 获授权者（管理员 / 审核专家等审核专家）可查看全部任务，普通用户只看自己的
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
        canDeep,
        mode: t.mode, scheduledAt: t.scheduledAt, apiStartAt: t.apiStartAt,
        convertedChars: t.convertedChars, tableRows: t.tableRows,
        proofreadCount: t.proofreadCount,
        proofreadP0: t.proofreadP0, proofreadP1: t.proofreadP1,
        // 重复审核提示：台账列表也要能看到，否则提交人不知道被暂停了
        duplicateConflict: !!t.duplicateConflict,
        duplicateConfirmed: !!t.duplicateConfirmed,
        priorCount: (t.priorAudits || []).length,
        // ── PPT 配对信息 ──
        // 配对审核是「一个任务、一份成果」而不是两个任务：PPT 与报告放在同一个任务里，
        // 成果按 PPT 优先排版。所以台账必须把这个标记显示出来 ——
        // 否则用户只看到报告文件名，会以为 PPT 没提交上去（已收到实测反馈）。
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

  // ── PPT 暂存（为「PPT + 报告」配对审核做准备）──
  //
  // 先把 PPT 转好存起来拿到 stashId，创建任务时带上即可。
  // 转换放在这一步还有两个好处：① PPT 转换慢（.ppt 可能 40 秒以上），
  // 放这里用户能看到进度；② PPT 常以截图为主、提取不出内容，
  // 这里就把质量指标返回，前端能在**提交前**提醒，而不是审完才发现没内容可核。
  if (p === '/api/ppt-stash' && req.method === 'POST') {
    const u = requireUser(req, res); if (!u) return;
    const name = decodeURIComponent(req.headers['x-file-name'] || '');
    if (!name) return json(res, 400, { error: '缺少文件名' });
    if (L.docKind(name) !== 'ppt') return json(res, 400, { error: '这里只接收 PPT 文件（.pptx / .ppt）' });

    const buf = await readBody(req);
    if (!buf.length) return json(res, 400, { error: '文件为空' });

    const purged = L.cleanPptStash();
    const stashId = L.newStashId();
    const sdir = L.stashDir(stashId);
    fs.mkdirSync(sdir, { recursive: true });
    const safeName = name.replace(/[\\/:*?"<>|]/g, '_');
    // ⚠️ 落盘必须**保留原扩展名**：convertToMarkdown 靠扩展名决定走哪条转换路径，
    //    存成无后缀的 'file' 会得到 "收到 ''" —— 实测踩过。
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

  // ── 仅 PPT 的任务（没有配套报告）──
  // 用户允许只传 PPT：那就只做 PPT 自身审核（编校/术语/数据/逻辑），没有对照物就不做一致性核对。
  if (p === '/api/tasks/ppt-only' && req.method === 'POST') {
    const u = requireUser(req, res); if (!u) return;
    const body = await readJsonBody(req);
    const stash = L.getStash(String(body.stashId || ''));
    if (!stash) return json(res, 400, { error: 'PPT 暂存已过期（超过 2 小时），请重新上传' });

    const qs = queueStats();
    if (qs.ready >= MAX_QUEUE) return json(res, 503, { error: `当前排队 ${qs.ready} 个任务已达上限（${MAX_QUEUE}），请稍后再提交`, queue: qs });
    const q = L.checkQuota(u, L.listTasks());
    if (!q.ok) return json(res, 429, { error: q.reason, usage: q.usage, daily: q.daily, monthly: q.monthly });

    const mode = body.mode === 'immediate' ? 'immediate' : 'idle';
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
      pptOnly: true, pptStashId: stash.id, crossCheck: false,
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
    if (pptStashId && !L.getStash(pptStashId)) {
      return json(res, 400, { error: 'PPT 暂存已过期（超过 2 小时），请重新上传 PPT' });
    }

    const buf = await readBody(req);
    if (!buf.length) return json(res, 400, { error: '文件为空' });
    // 名额只看**真正就绪**的任务；等待闲时的任务另设上限
    const qs = queueStats();
    if (qs.ready >= MAX_QUEUE) {
      return json(res, 503, {
        error: `当前排队 ${qs.ready} 个任务已达上限（${MAX_QUEUE}），请稍后再提交`,
        queue: qs,
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
    // idle 的语义：**本地预处理立刻做**（文档转换不花钱），花钱的 AI 调用推迟到空闲时段，
    //              起跑时刻 = 本段高峰结束 + 10 分钟（缓冲，避开 12:00/18:00 边界）；
    //              若当前已在空闲时段，则预处理完直接开跑，不额外等待。
    const mode = (req.headers['x-audit-mode'] === 'immediate') ? 'immediate' : 'idle';
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

    // 报告类型不再由用户选择：先按文件名/模板关键词给一个初判，S0 预审解析出正文后再精确识别。
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
      crossCheck: !!(pptStashId && crossCheck),
    };
    L.saveTask(task);
    L.appendProgress(task, `已接收文件 ${safeName}（${(buf.length / 1024).toFixed(0)} KB），进入队列`);
    if (pptStashId) {
      const s = L.getStash(pptStashId);
      // ⚠️ 这里**不要**再调 L.saveTask(task)：appendProgress 是"读盘→改→写盘"，
      //    而 task 是内存里的旧副本，直接 saveTask(task) 会把刚追加的进度整段抹掉（实测踩过）。
      //    pptStashId / crossCheck 在构造 task 时就写进去了，已经落盘。
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
    // 获授权者（管理员 / 审核专家等审核专家）可查阅他人任务，普通用户只能查阅自己的
    const canRead = u.role === 'admin' || !!u.deepAccess;
    if (!canRead && task.owner !== u.id) return json(res, 403, { error: '无权访问' });
    const sub = m[2] || '';

    if (sub === '' && req.method === 'GET') {
      const canDeep = u.role === 'admin' || !!u.deepAccess;
      const out = {
        ...task,
        canDeep,
        queuePosition: queuePosition(task.id),
        queue: queueStats(),
        queueLength: queue.length,
        running,
        maxConcurrent: MAX_CONCURRENT,
        mine: task.owner === u.id,
      };
      // 第 6 条：处理日志对普通用户意义不大，仅管理员与获授权者（如审核专家）可见
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
      // 允许取消的范围 = 「AI 还没开始」的所有阶段。
      // converting 也要允许：那是本地解析，免费，而且提交后几乎立刻就进这个状态，
      // 不允许的话用户"刚提交就发现传错了"根本取消不了（实测踩到）。
      // auditing 不允许：钱已经在花，且成果有保留价值。
      if (!['duplicate-suspect', 'queued', 'converting', 'waiting'].includes(task.status)) {
        return json(res, 400, {
          error: task.status === 'auditing'
            ? '任务已进入 AI 审核，费用已产生，不再支持取消。审核完成后如不需要，可由管理员删除记录。'
            : '该任务当前状态不支持取消',
        });
      }
      if (u.role !== 'admin' && task.owner !== u.id) return json(res, 403, { error: '只有提交人本人或管理员可以取消' });
      // ★ 必须同时把它从内存队列里摘掉，否则下一次 pump() 还会把它取走继续跑。
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
    // 只有管理员能发起（这是管理动作，且会花钱）；获授权专家可查看已有结果。
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
    // ── 下载审核成果 ──
    // 首选 PDF（浏览器打印引擎出的，版式和页面一致）；没有 PDF 就回退直接给 HTML，
    // 保证「下载」这个动作永远不会因为转换失败而不可用。
    if (sub === '/report.pdf' || sub === '/download') {
      const canDeep = u.role === 'admin' || !!u.deepAccess;
      const dir = L.taskDir(task.id);
      const suffix = canDeep ? '审核成果' : '校对成果';
      const htmlF = path.join(dir, canDeep ? 'report.deep.html' : 'report.html');
      const pdfF = path.join(dir, canDeep ? '审核成果.pdf' : '校对成果.pdf');
      const base = task.sourceName.replace(/\.[^.]+$/, '');

      if (fs.existsSync(pdfF)) {
        const b = fs.readFileSync(pdfF);
        // ⚠️ HTTP 头只能是 ASCII，中文文件名必须走 RFC 5987 的 filename*
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
      // ⚠️ HTTP 头只能是 ASCII。中文文件名必须走 RFC 5987 的 filename*，
      //    否则 Node 抛 ERR_INVALID_CHAR，前端表现为"点了没反应"（实为 500）。
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
    const scoped = (u.role === 'admin' || !!u.deepAccess) ? all : all.filter(t => t.owner === u.id);
    return json(res, 200, L.aggregateStats(scoped));
  }

  return json(res, 404, { error: '接口不存在' });
}

// ─────────────── 静态资源 ───────────────

function serveStatic(req, res, url) {
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return text(res, 404, 'Not Found');
  }
  const b = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': b.length });
  res.end(b);
}

// ─────────────── 启动 ───────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
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

/** 取当前生效的 key 及其来源，用于启动日志（只暴露指纹，不写完整 key） */
function readKeyInfo() {
  const ki = engineApiKeyInfo();
  return { ...ki, fp: keyFingerprint(ki.key) };
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('═══════════════════════════════════════════════');
  console.log('  工程咨询成果审核工作台 — 内网服务已启动');
  console.log('═══════════════════════════════════════════════');
  console.log(`  启动时间 : ${new Date().toLocaleString('zh-CN')}`);
  console.log(`  本机访问 : http://127.0.0.1:${PORT}`);
  // 同事访问地址：自动探测本机内网 IPv4（原来写死成公司的具体地址，换机器/换网段就是错的）
  const lanIP = (() => {
    try {
      for (const list of Object.values(os.networkInterfaces())) {
        for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
      }
    } catch { /* 拿不到就显示占位 */ }
    return '(本机内网地址)';
  })();
  console.log(`  同事访问 : http://${lanIP}:${PORT}`);
  console.log(`  数据目录 : ${L.DATA_DIR}`);
  // 启动时把「用的是哪把 key」记进日志，方便把平台费用单独归集/核对
  try {
    const ki = readKeyInfo();
    console.log(`  API Key  : ${ki.label}　指纹 ${ki.fp}${ki.source === 'workbuddy' ? '　⚠️ 正在用兜底 key，平台费用会与 WorkBuddy 混在一起' : ''}`);
  } catch (e) {
    console.log(`  API Key  : ✗ ${e.message}`);
  }
  console.log('  ── 并发与保护 ──');
  console.log(`  同时处理 : ${MAX_CONCURRENT} 个任务（MAX_CONCURRENT）`);
  console.log(`  单元并发 : ${process.env.S2_CONCURRENCY || 3} 个/任务（S2_CONCURRENCY）`);
  console.log(`  排队上限 : ${MAX_QUEUE} 个就绪 + ${MAX_WAITING} 个等待闲时（MAX_QUEUE / MAX_WAITING）`);
  console.log(`  任务超时 : ${Math.round(TASK_TIMEOUT_MS / 60000)} 分钟（TASK_TIMEOUT_MS）`);
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
