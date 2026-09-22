/**
 * 审核工作台 Web 服务 — 公共层
 * 账号 / 会话 / 存储 / 任务队列 / 文档转换 / Word 导出 / 统计
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROOFREAD_CATEGORIES } from '../engine/lib/report-html.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'web', 'data');
export const TASKS_DIR = path.join(DATA_DIR, 'tasks');
export const USERS_FILE = path.join(DATA_DIR, 'users.json');
export const TEMPLATES_FILE = path.join(DATA_DIR, 'templates.json');
export const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

// 技能目录（Skill 层）。审核知识写这里；WorkBuddy 原件只读，同步方向 原件→副本。
export const SKILL_DIR_LOCAL = process.env.SKILL_DIR
  || path.join(ROOT, 'skill', 'petroleum-engineering-review');

export const PORT = Number(process.env.PORT || 8787);
export const MAX_UPLOAD = 80 * 1024 * 1024;   // 80 MB

// ─────────────── 北京时间（全系统统一口径）───────────────
// DeepSeek 的计费时段是按**北京时间**划的，配额按**自然日/月**算，都必须用北京时间。
//
// ⚠️ 这里有个踩过的坑，改动前务必看懂：
//   `new Date(t + (d.getTimezoneOffset() + 480) * 60000)` 这个写法**只在用本地访问器**
//   （getFullYear/getHours…）时才是对的；一旦接着用 **UTC 访问器**（getUTCHours/toISOString），
//   就会把北京时间当成 UTC 读。本机时区正好是 UTC+8，getTimezoneOffset() = -480，
//   偏移被抵消成 0，于是 15:50 被读成 7:50 —— 高峰时段被判成空闲时段，
//   费用按半价少算一半、「闲时审核」也永远不会真正推迟调用。
//
//   正确做法：要 UTC 访问器就用 toBeijing()（纯常量偏移，与本机时区无关）；
//   要本地访问器就直接 new Date(v) 用本地访问器。
export const BJ_OFFSET_MIN = 480;

/** 返回一个 Date，其 getUTC* 系列读出来就是**北京墙上时间**。接受 Date / ISO 字符串 / 毫秒数 */
export function toBeijing(d = new Date()) {
  const t = (d instanceof Date) ? d.getTime() : (typeof d === 'number' ? d : new Date(d).getTime());
  return new Date((isNaN(t) ? Date.now() : t) + BJ_OFFSET_MIN * 60000);
}

// 外部工具路径：可用环境变量覆盖；否则按工具名交给 PATH 去找。
// （原来是写死的本机绝对路径，换台机器就失效）
const MARKITDOWN = process.env.MARKITDOWN || 'markitdown';
const SOFFICE = process.env.SOFFICE || 'soffice';
const PANDOC = process.env.PANDOC || 'pandoc';

// ─────────────── 基础 IO ───────────────

export function ensureDirs() {
  for (const d of [DATA_DIR, TASKS_DIR]) fs.mkdirSync(d, { recursive: true });
}
export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ─────────────── 账号 ───────────────

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
export function verifyPassword(password, salt, hash) {
  const h = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'));
}

export function listUsers() { return readJson(USERS_FILE, []); }
export function saveUsers(u) { writeJson(USERS_FILE, u); }

export function createUser({ username, password, name, role = 'user' }) {
  const users = listUsers();
  if (users.some(u => u.username === username)) throw new Error('用户名已存在');
  const { salt, hash } = hashPassword(password);
  const u = {
    id: 'u' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
    username, name: name || username, role, salt, hash,
    createdAt: new Date().toISOString(), disabled: false, defaultPassword: true,
    // 报告分类权限：true = 可查看深度类（逻辑/结论/建议）；管理员恒为 true
    deepAccess: role === 'admin',
    // 配额：0 表示不限
    dailyLimit: DEFAULT_DAILY_LIMIT,
    monthlyLimit: DEFAULT_MONTHLY_LIMIT,
  };
  users.push(u); saveUsers(users);
  return u;
}

export function bootstrapAdmin() {
  ensureDirs();
  const users = listUsers();
  if (users.length) return null;
  const pwd = 'admin-' + crypto.randomBytes(4).toString('hex');
  createUser({ username: 'admin', password: pwd, name: '管理员', role: 'admin' });
  return { username: 'admin', password: pwd };
}

// ─────────────── 会话与登录审计 ───────────────
//
// 这里有**两套**数据，职责不同，别混：
//   · sessions.json   ——【当前有效会话】。登出即删，7 天自动过期。用于判断"谁在线"。
//   · login-history.json ——【登录审计流水】。只增不删（保留最近 N 条），
//                            登录/登出/登录失败都记一条。用于回答"某人什么时候用过系统"。
//
// 为什么必须分开：早先只有 sessions.json，登出就把记录删了，
// "这个账号最近登过吗"这类问题根本查不了。

export const LOGIN_HISTORY_FILE = path.join(DATA_DIR, 'login-history.json');
const LOGIN_HISTORY_MAX = 3000;      // 保留最近 3000 条，避免无限增长

/** 会话在线判定：最近一次活动在这个时间窗内算在线 */
export const ONLINE_WINDOW_MS = 5 * 60 * 1000;

const clientMeta = (req) => req ? {
  ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket?.remoteAddress || '',
  ua: String(req.headers['user-agent'] || '').slice(0, 200),
} : { ip: '', ua: '' };

export function createSession(userId, req) {
  const sid = crypto.randomBytes(24).toString('hex');
  const s = readJson(SESSIONS_FILE, {});
  const now = Date.now();
  const meta = clientMeta(req);
  s[sid] = { userId, createdAt: now, lastSeenAt: now, ip: meta.ip, ua: meta.ua };
  // 清理 7 天前的会话
  for (const [k, v] of Object.entries(s)) if (now - v.createdAt > 7 * 864e5) delete s[k];
  writeJson(SESSIONS_FILE, s);
  return sid;
}

/** 只读地取会话记录（不更新活动时间），用于审计查询 */
export function getSessionRecord(sid) {
  if (!sid) return null;
  return readJson(SESSIONS_FILE, {})[sid] || null;
}

/**
 * 取会话对应用户，并顺手刷新"最近活动时间"。
 * ⚠️ 每个请求都会调用，所以刷新做了节流：距上次不足 60 秒就不落盘，
 *    否则高频轮询会把 sessions.json 写爆。
 */
export function getSession(sid) {
  if (!sid) return null;
  const s = readJson(SESSIONS_FILE, {});
  const rec = s[sid];
  if (!rec) return null;
  const user = listUsers().find(u => u.id === rec.userId && !u.disabled);
  if (!user) return null;
  const now = Date.now();
  if (!rec.lastSeenAt || now - rec.lastSeenAt > 60000) {
    rec.lastSeenAt = now;
    s[sid] = rec;
    writeJson(SESSIONS_FILE, s);
  }
  return user;
}

export function destroySession(sid) {
  if (!sid) return null;
  const s = readJson(SESSIONS_FILE, {});
  const rec = s[sid];
  delete s[sid];
  writeJson(SESSIONS_FILE, s);
  return rec || null;
}

/** 追加一条登录审计流水 */
export function recordAuthEvent({ userId = '', name = '', event = 'login', req = null, note = '' } = {}) {
  const list = readJson(LOGIN_HISTORY_FILE, []);
  const meta = clientMeta(req);
  list.push({
    at: new Date().toISOString(),
    userId, name, event,          // login | logout | fail
    ip: meta.ip, ua: meta.ua, note,
  });
  writeJson(LOGIN_HISTORY_FILE, list.slice(-LOGIN_HISTORY_MAX));
}

/** 登录审计流水（可按用户过滤） */
export function listAuthEvents({ userId = '', limit = 200 } = {}) {
  const list = readJson(LOGIN_HISTORY_FILE, []);
  const filtered = userId ? list.filter(x => x.userId === userId) : list;
  return filtered.slice(-limit).reverse();      // 最近的在前
}

/**
 * 当前在线/近期会话（管理员用）。
 * 只返回**账号仍存在**的会话：账号已删除的会话是死会话（getSession 也取不到），
 * 留着只会在"谁在使用"里显示成「（已删除账号）」白白占一行。
 */
export function listActiveSessions() {
  const s = readJson(SESSIONS_FILE, {});
  const users = new Map(listUsers().map(u => [u.id, u]));
  const now = Date.now();
  const out = [];
  for (const [sid, rec] of Object.entries(s)) {
    const u = users.get(rec.userId);
    if (!u) continue;                       // 账号已删除 → 跳过
    out.push({
      sidTail: sid.slice(0, 8),
      userId: rec.userId,
      name: u.name || u.username,
      username: u.username,
      role: u.role,
      deepAccess: !!u.deepAccess,
      disabled: !!u.disabled,
      loginAt: new Date(rec.createdAt).toISOString(),
      lastSeenAt: new Date(rec.lastSeenAt || rec.createdAt).toISOString(),
      ip: rec.ip || '',
      ua: rec.ua || '',
      online: (now - (rec.lastSeenAt || rec.createdAt)) < ONLINE_WINDOW_MS,
    });
  }
  return out.sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
}

/** 顺手清掉账号已不存在的死会话（启动时或删账号后调用） */
export function purgeOrphanSessions() {
  const s = readJson(SESSIONS_FILE, {});
  const ids = new Set(listUsers().map(u => u.id));
  let n = 0;
  for (const [sid, rec] of Object.entries(s)) {
    if (!ids.has(rec.userId)) { delete s[sid]; n++; }
  }
  if (n) writeJson(SESSIONS_FILE, s);
  return n;
}

/**
 * 清掉**已停用**账号的会话。
 * 停用一个人必须立刻生效 —— 否则他浏览器里那个 cookie 还能继续用，
 * 直到 7 天后自然过期，停用形同虚设。
 */
export function purgeDisabledSessions() {
  const s = readJson(SESSIONS_FILE, {});
  const alive = new Set(listUsers().filter(u => !u.disabled).map(u => u.id));
  let n = 0;
  for (const [sid, rec] of Object.entries(s)) {
    if (!alive.has(rec.userId)) { delete s[sid]; n++; }
  }
  if (n) writeJson(SESSIONS_FILE, s);
  return n;
}

/** 把 UA 压成一句人话，别把整串甩给管理员 */
export function shortUA(ua) {
  const s = String(ua || '');
  const browser = /Edg\//.test(s) ? 'Edge'
    : /Chrome\//.test(s) ? 'Chrome'
    : /Firefox\//.test(s) ? 'Firefox'
    : /Safari\//.test(s) ? 'Safari' : '其它';
  const os = /Windows NT 10/.test(s) ? 'Windows 10/11'
    : /Windows NT/.test(s) ? 'Windows'
    : /Mac OS X/.test(s) ? 'macOS'
    : /Android/.test(s) ? 'Android'
    : /iPhone|iPad/.test(s) ? 'iOS' : '其它';
  return `${browser} · ${os}`;
}

// ─────────────── 登录防护（限流 + 阶梯验证码）───────────────
//
// 威胁模型（重要，决定了为什么这样做）：
//   本系统只在内网可达（防火墙仅放行本机所在网段），外部机器人碰不到。
//   真实攻击者是：好奇/恶意的同事、同事电脑上的恶意软件、有内网权限的外协人员。
//   对他们来说最有效的手段不是"爆破"而是「**密码喷洒**」——用一个常见密码去试所有账号，
//   而本系统用户名就是本人姓名（通讯录可查），所以这一招特别灵。
//
// 因此防线的优先级是：
//   ① 限流（按账号 + 按来源 IP）—— 直接掐死高频尝试，正常用户完全无感
//   ② 阶梯验证码 —— 只在连续失败后才出现，正常用户永远看不到；自托管，不依赖外网
//   ③ 失败加重延迟 —— 把机器速度从 40 次/秒压到 1 次/秒
//
// ⚠️ 为什么不首选图形验证码：实测 Google reCAPTCHA 从本机不可达，
//    云端验证码一旦加载不了就是全员登不进去；而自建扭曲文字对多模态模型基本无效，
//    加了只会给人"防住了"的错觉。验证码在这里是**补充**，不是主力。

export const LOGIN_GUARD_FILE = path.join(DATA_DIR, 'login-guard.json');

export const GUARD = {
  ACCOUNT_MAX_FAILS: 5,               // 单账号连续失败上限
  ACCOUNT_LOCK_MS: 15 * 60 * 1000,    // 锁定时长
  IP_MAX_FAILS: 20,                   // 单 IP 窗口内失败上限
  IP_WINDOW_MS: 10 * 60 * 1000,
  IP_BLOCK_MS: 10 * 60 * 1000,
  CAPTCHA_AFTER_FAILS: 3,             // 失败几次后开始要求验证码
  CAPTCHA_TTL_MS: 2 * 60 * 1000,      // 验证码有效期
  FAIL_DELAY_MS: 800,                 // 失败响应固定延迟
};

const emptyGuard = () => ({ accounts: {}, ips: {}, captchas: {} });
export function guardState() {
  const g = readJson(LOGIN_GUARD_FILE, null);
  if (!g || typeof g !== 'object') return emptyGuard();
  const norm = { ...emptyGuard(), ...g };
  // 顺手清掉过期验证码，避免文件无限长大
  const now = Date.now();
  for (const [cid, c] of Object.entries(norm.captchas)) {
    if (!c || !c.expiresAt || c.expiresAt < now) delete norm.captchas[cid];
  }
  return norm;
}
const saveGuard = (g) => writeJson(LOGIN_GUARD_FILE, g);

/**
 * 登录前的状态检查。**在验证密码之前调用**。
 * @returns {{locked,lockedUntil,accountFails,ipBlocked,ipBlockedUntil,needCaptcha,remainingAttempts}}
 */
export function loginGuardStatus(userId, ip) {
  const g = guardState();
  const now = Date.now();
  const acc = (userId && g.accounts[userId]) || {};
  const ipr = (ip && g.ips[ip]) || {};

  const lockedUntil = acc.lockedUntil && new Date(acc.lockedUntil).getTime() > now ? acc.lockedUntil : null;
  const ipBlockedUntil = ipr.blockedUntil && new Date(ipr.blockedUntil).getTime() > now ? ipr.blockedUntil : null;
  // IP 窗口过期就重新计数
  const ipFails = (ipr.windowStart && now - new Date(ipr.windowStart).getTime() > GUARD.IP_WINDOW_MS) ? 0 : (ipr.fails || 0);
  const accFails = acc.fails || 0;

  return {
    locked: !!lockedUntil,
    lockedUntil,
    lockMinutesLeft: lockedUntil ? Math.ceil((new Date(lockedUntil).getTime() - now) / 60000) : 0,
    accountFails: accFails,
    remainingAttempts: Math.max(0, GUARD.ACCOUNT_MAX_FAILS - accFails),
    ipBlocked: !!ipBlockedUntil,
    ipBlockedUntil,
    ipMinutesLeft: ipBlockedUntil ? Math.ceil((new Date(ipBlockedUntil).getTime() - now) / 60000) : 0,
    ipFails,
    needCaptcha: accFails >= GUARD.CAPTCHA_AFTER_FAILS || ipFails >= GUARD.CAPTCHA_AFTER_FAILS,
  };
}

/** 记一次登录失败，返回更新后的状态 */
export function recordLoginFail(userId, ip) {
  const g = guardState();
  const now = Date.now();
  if (userId) {
    const a = g.accounts[userId] || { fails: 0 };
    a.fails = (a.fails || 0) + 1;
    a.lastFailAt = new Date(now).toISOString();
    if (a.fails >= GUARD.ACCOUNT_MAX_FAILS) {
      a.lockedUntil = new Date(now + GUARD.ACCOUNT_LOCK_MS).toISOString();
      a.fails = 0;                       // 锁上后重新计数，解锁即从零开始
    }
    g.accounts[userId] = a;
  }
  if (ip) {
    const r = g.ips[ip] || {};
    if (!r.windowStart || now - new Date(r.windowStart).getTime() > GUARD.IP_WINDOW_MS) {
      r.windowStart = new Date(now).toISOString();
      r.fails = 0;
    }
    r.fails = (r.fails || 0) + 1;
    r.lastFailAt = new Date(now).toISOString();
    if (r.fails >= GUARD.IP_MAX_FAILS) {
      r.blockedUntil = new Date(now + GUARD.IP_BLOCK_MS).toISOString();
      r.fails = 0;
      r.windowStart = new Date(now).toISOString();
    }
    g.ips[ip] = r;
  }
  saveGuard(g);
  return loginGuardStatus(userId, ip);
}

/** 登录成功：清掉该账号的失败计数（IP 计数保留，防"试一堆账号再登自己"） */
export function recordLoginSuccess(userId, ip) {
  const g = guardState();
  if (userId && g.accounts[userId]) {
    delete g.accounts[userId];
    saveGuard(g);
  }
}

/** 管理员解锁某个账号 */
export function unlockAccount(userId) {
  const g = guardState();
  if (!g.accounts[userId]) return false;
  delete g.accounts[userId];
  saveGuard(g);
  return true;
}
/** 管理员清掉某个 IP 的封禁 */
export function unblockIp(ip) {
  const g = guardState();
  if (!g.ips[ip]) return false;
  delete g.ips[ip];
  saveGuard(g);
  return true;
}
/** 一键全解（救急用） */
export function unlockAll() {
  const g = guardState();
  const n = Object.keys(g.accounts).length + Object.keys(g.ips).length;
  saveGuard({ accounts: {}, ips: {}, captchas: {} });
  return n;
}

/** 给管理员看的当前防护状态汇总 */
export function guardSummary() {
  const g = guardState();
  const now = Date.now();
  const users = new Map(listUsers().map(u => [u.id, u]));
  const locked = Object.entries(g.accounts)
    .filter(([, a]) => a.lockedUntil && new Date(a.lockedUntil).getTime() > now)
    .map(([id, a]) => ({
      userId: id, name: (users.get(id) || {}).username || '（未知）',
      until: a.lockedUntil, minutesLeft: Math.ceil((new Date(a.lockedUntil).getTime() - now) / 60000),
    }));
  const blocked = Object.entries(g.ips)
    .filter(([, r]) => r.blockedUntil && new Date(r.blockedUntil).getTime() > now)
    .map(([ip, r]) => ({ ip, until: r.blockedUntil, minutesLeft: Math.ceil((new Date(r.blockedUntil).getTime() - now) / 60000) }));
  // 近期有失败但还没锁的账号（预警）
  const warn = Object.entries(g.accounts)
    .filter(([, a]) => !a.lockedUntil && (a.fails || 0) >= 1)
    .map(([id, a]) => ({ userId: id, name: (users.get(id) || {}).username || '（未知）', fails: a.fails, lastFailAt: a.lastFailAt }))
    .sort((a, b) => b.fails - a.fails);
  return { policy: GUARD, locked, blocked, warn };
}

// ── 自托管验证码 ──
// 生成一道算术题并渲染成带干扰的 SVG：不依赖任何外部服务，内网断网也能用。
// 定位是"限流之后的补充"，不是第一道门 —— 所以够用即可，不必追求抗 OCR。

/** 把表达式渲染成带噪声的 SVG（逐字符随机旋转/位移 + 干扰线 + 噪点） */
export function renderCaptchaSvg(text) {
  const W = 148, H = 46;
  const chars = [...String(text)];
  const rnd = (a, b) => a + Math.random() * (b - a);
  const step = (W - 24) / chars.length;

  let glyphs = '';
  chars.forEach((ch, i) => {
    const x = 16 + i * step;
    const y = 32 + rnd(-4, 4);
    const rot = rnd(-22, 22);
    glyphs += `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="Consolas,monospace"`
      + ` font-size="${rnd(23, 28).toFixed(0)}" font-weight="700" fill="#1f3b57"`
      + ` transform="rotate(${rot.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})">${ch.replace(/[<>&]/g, '')}</text>`;
  });

  let noise = '';
  for (let i = 0; i < 4; i++) {
    noise += `<line x1="${rnd(0, W).toFixed(0)}" y1="${rnd(0, H).toFixed(0)}"`
      + ` x2="${rnd(0, W).toFixed(0)}" y2="${rnd(0, H).toFixed(0)}"`
      + ` stroke="#9ec3e0" stroke-width="1" opacity="0.75"/>`;
  }
  for (let i = 0; i < 26; i++) {
    noise += `<circle cx="${rnd(0, W).toFixed(0)}" cy="${rnd(0, H).toFixed(0)}" r="1" fill="#b9d4e8" opacity="0.8"/>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="验证码">`
    + `<rect width="${W}" height="${H}" fill="#f2f8fd"/>`
    + noise + glyphs + `</svg>`;
}

/** 新生成一道验证码，返回 { cid, svg, question } */
export function newCaptcha() {
  const a = 2 + Math.floor(Math.random() * 8);      // 2~9
  const b = 2 + Math.floor(Math.random() * 8);
  const mul = Math.random() < 0.45;
  const text = mul ? `${a}×${b}=?` : `${a}+${b}=?`;
  const answer = String(mul ? a * b : a + b);

  const cid = crypto.randomBytes(12).toString('hex');
  const g = guardState();
  g.captchas[cid] = { answer, expiresAt: Date.now() + GUARD.CAPTCHA_TTL_MS };
  // 同时只保留最近 200 道，防文件膨胀
  const keys = Object.keys(g.captchas);
  if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete g.captchas[k];
  saveGuard(g);
  return { cid, svg: renderCaptchaSvg(text), question: text };
}

/** 校验验证码（一次性：无论对错都作废，防重放） */
export function checkCaptcha(cid, answer) {
  if (!cid) return false;
  const g = guardState();
  const c = g.captchas[cid];
  if (!c) return false;
  delete g.captchas[cid];
  saveGuard(g);
  if (!c.expiresAt || c.expiresAt < Date.now()) return false;
  return String(answer || '').trim() === c.answer;
}



// ─────────────── 模板 ───────────────

export const DEFAULT_TEMPLATES = [
  { id: 'tpl-post-eval', name: '投资项目后评价报告', bizType: 'post-evaluation', description: '详细后评价报告 + 后评价简表；走 H1~H15 专项逻辑审核', enabled: true, extraNote: '' },
  { id: 'tpl-equip', name: '装备购置可行性研究', bizType: 'equipment-feasibility', description: '设备购置类可研报告审核', enabled: true, extraNote: '' },
  { id: 'tpl-equity', name: '股权收购项目建议书', bizType: 'equity-acquisition', description: '中石化体系股权收购类', enabled: true, extraNote: '' },
  { id: 'tpl-asset', name: '资产收购类可行性研究', bizType: 'asset-acquisition', description: '含权属链条/定价依据/或有负债等五大必查', enabled: true, extraNote: '' },
  { id: 'tpl-fs', name: '可行性研究报告 / 方案', bizType: 'feasibility-study', description: '通用可研与方案审核', enabled: true, extraNote: '' },
  { id: 'tpl-renov', name: '改造类可研修订复核', bizType: 'renovation-fs', description: '设备更新/国产化替代/站场改造修订稿', enabled: true, extraNote: '' },
];

export function listTemplates() {
  const t = readJson(TEMPLATES_FILE, null);
  if (!t) { writeJson(TEMPLATES_FILE, DEFAULT_TEMPLATES); return DEFAULT_TEMPLATES; }
  return t;
}
export function saveTemplates(t) { writeJson(TEMPLATES_FILE, t); }

// ─────────────── 项目类型（看板分类维度）───────────────
// 由 S0 预审从报告内容自动识别；这里是合法取值清单，管理员可在「系统管理」里增删改。
// 「其他/未分类」永远兜底，不允许删除。

export const PROJECT_TYPES_FILE = path.join(DATA_DIR, 'project-types.json');
export const FALLBACK_PROJECT_TYPE = '其他/未分类';

// 顺序即看板展示顺序
export const DEFAULT_PROJECT_TYPES = [
  { id: 'pt-equip', name: '装备购置可研', enabled: true, keywords: ['设备购置', '装备购置', '购置项目', '设备更新'] },
  { id: 'pt-capacity-post', name: '产能后评价', enabled: true, keywords: ['产能建设', '产能后评价', '产能'] },
  { id: 'pt-system-post', name: '系统配套后评价', enabled: true, keywords: ['系统配套', '配套工程', '地面系统'] },
  { id: 'pt-asset-equity-post', name: '资产股权收购后评价', enabled: true, keywords: ['收购后评价', '股权后评价'] },
  { id: 'pt-equity-asset', name: '股权与资产收购', enabled: true, keywords: ['股权收购', '资产收购', '收购项目建议书'] },
  { id: 'pt-pipeline', name: '油气管道工程可研', enabled: true, keywords: ['管道', '管线', '输气', '输油', '长输'] },
  { id: 'pt-tech-econ', name: '技术经济专题研究', enabled: true, keywords: ['专题研究', '技术经济', '专项研究'] },
  { id: 'pt-report', name: '综合汇报材料', enabled: true, keywords: ['汇报', '汇报材料', '工作总结', '汇报提纲'] },
  { id: 'pt-other', name: FALLBACK_PROJECT_TYPE, enabled: true, keywords: [], locked: true },
];

export function listProjectTypes() {
  const t = readJson(PROJECT_TYPES_FILE, null);
  const arr = Array.isArray(t) && t.length ? t : DEFAULT_PROJECT_TYPES;
  if (!t) writeJson(PROJECT_TYPES_FILE, DEFAULT_PROJECT_TYPES);
  // 兜底项必须存在
  if (!arr.some(x => x.name === FALLBACK_PROJECT_TYPE)) {
    arr.push({ id: 'pt-other', name: FALLBACK_PROJECT_TYPE, enabled: true, keywords: [], locked: true });
  }
  return arr;
}
export function saveProjectTypes(t) { writeJson(PROJECT_TYPES_FILE, t); }

/** 把模型返回的类型名对齐到清单；对不上就用关键词兜底，再不行归入「其他/未分类」 */
export function normalizeProjectType(raw) {
  const types = listProjectTypes();
  const s = String(raw || '').trim();
  const hit = types.find(x => x.name === s);
  if (hit) return hit.name;
  // 模糊匹配：包含关系也算（模型可能写「装备购置类可研」）
  const fuzzy = types.filter(x => x.name !== FALLBACK_PROJECT_TYPE)
    .find(x => s && (s.includes(x.name) || x.name.includes(s)));
  return fuzzy ? fuzzy.name : null;   // null 表示没识别出来，交给关键词兜底
}

/** 关键词兜底识别：从项目名称 / 报告文件名 / 报告类型里找 */
export function guessProjectType(...texts) {
  const blob = texts.filter(Boolean).join(' ');
  if (!blob) return FALLBACK_PROJECT_TYPE;
  // 先看「后评价」类，避免「产能」把「产能后评价」抢走
  const ordered = listProjectTypes().filter(x => x.name !== FALLBACK_PROJECT_TYPE);
  let best = null, bestScore = 0;
  for (const t of ordered) {
    let score = 0;
    for (const k of (t.keywords || [])) if (blob.includes(k)) score += k.length;
    // 「后评价」类加成，避免被判成同名的可研类
    if (t.name.includes('后评价') && blob.includes('后评价')) score += 3;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best ? best.name : FALLBACK_PROJECT_TYPE;
}

/** 看板分类顺序：按清单顺序，兜底项排最后 */
export function projectTypeOrder() {
  return listProjectTypes().filter(x => x.enabled !== false).map(x => x.name);
}

// ─────────────── 报告类型（决定审核维度与判定标准）───────────────
// 用户不再手选；S0 预审从报告内容识别，识别不出来就用文件名关键词兜底。

export const BIZ_TYPES = [
  { bizType: 'post-evaluation', name: '投资项目后评价报告', keywords: ['后评价', '后评估'] },
  { bizType: 'equipment-feasibility', name: '装备购置可行性研究', keywords: ['设备购置', '装备购置', '设备更新', '购置可研'] },
  { bizType: 'equity-acquisition', name: '股权收购项目建议书', keywords: ['股权收购', '股权', '项目建议书'] },
  { bizType: 'asset-acquisition', name: '资产收购类可行性研究', keywords: ['资产收购', '资产重组', '权属'] },
  { bizType: 'renovation-fs', name: '改造类可研修订复核', keywords: ['改造', '修订', '复核', '国产化替代'] },
  { bizType: 'feasibility-study', name: '可行性研究报告 / 方案', keywords: ['可行性', '可研', '方案', '汇报'] },
];

/** 报告类型的展示名 */
export function bizTypeName(bizType) {
  return (BIZ_TYPES.find(x => x.bizType === bizType) || BIZ_TYPES[BIZ_TYPES.length - 1]).name;
}

/** 把 S0 识别出的报告类型名对齐到已知类型（支持包含匹配），对不上返回 null */
export function normalizeBizType(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const hit = BIZ_TYPES.find(x => x.name === s);
  if (hit) return hit.bizType;
  const fuzzy = BIZ_TYPES.find(x => s.includes(x.name) || x.name.includes(s));
  if (fuzzy) return fuzzy.bizType;
  // 模型可能只写「后评价」「可研」这类简称，按关键词再兜一次
  return guessBizType(s);
}

/** 关键词兜底识别报告类型（文件名 / 报告名 / 正文开头都能传） */
export function guessBizType(...texts) {
  const blob = texts.filter(Boolean).join(' ');
  let best = null, bestScore = 0;
  for (const t of BIZ_TYPES) {
    let score = 0;
    for (const k of t.keywords) if (blob.includes(k)) score += k.length;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return (best || BIZ_TYPES[BIZ_TYPES.length - 1]).bizType;
}

// ─────────────── 任务 ───────────────

export function taskDir(id) { return path.join(TASKS_DIR, id); }
export function newTaskId() { return 'T' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + crypto.randomBytes(3).toString('hex'); }

/**
 * 「在处理中」的任务状态。
 * waiting —— 预处理（本地文档转换）已完成，正等空闲时段再调 AI（闲时调用模式）。
 */
export const ACTIVE_STATES = ['queued', 'converting', 'waiting', 'auditing'];

export function getTask(id) { return readJson(path.join(taskDir(id), 'meta.json'), null); }
export function saveTask(t) { writeJson(path.join(taskDir(t.id), 'meta.json'), t); }

export function listTasks() {
  if (!fs.existsSync(TASKS_DIR)) return [];
  return fs.readdirSync(TASKS_DIR)
    .map(id => getTask(id)).filter(Boolean)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

/**
 * 追加一条进度。
 *
 * ⚠️ 这里**以盘上的最新状态为准**再写回，而不是直接存调用方手里那份 task。
 *   踩过的坑：runTask 把 task 读进内存后长时间持有，期间用户在别的请求里点了「取消」，
 *   而每写一条进度都用旧对象整体覆盖，用户的 'cancelled' 就被悄悄改回去了 ——
 *   表现为「取消了还在跑」。合并到盘上最新副本可以避免覆盖状态类字段。
 *
 * ⚠️⚠️ 盘上没有这个任务时**直接跳过，不要写**。
 *   早先写成 `getTask(task.id) || task`，文件被删（管理员删任务、或测试清理）之后
 *   会退回内存里的旧对象再整体写回去 —— **把已删除的任务复活**。
 *   表现：删了任务，过一会儿它又出现在台账里（实测两次，还让用户误以为"有条待处理"）。
 */
export function appendProgress(task, msg) {
  const cur = getTask(task.id);
  if (!cur) return task;            // 任务已被删除 → 丢弃这次进度，不复活它
  cur.progress = cur.progress || [];
  cur.progress.push({ t: new Date().toISOString(), msg });
  if (cur.progress.length > 300) cur.progress = cur.progress.slice(-300);
  saveTask(cur);
  return cur;
}

// ─────────────── PPT 暂存区 ───────────────
//
// 为什么需要「暂存」这一步：一致性核对要求 PPT 和报告在**同一个任务**里跑
// （用户要的是一份 PPT 优先的成果，不是两份）。
// 而上传协议是一次请求传一个文件，所以先把 PPT 暂存起来拿到一个 id，
// 再在创建任务时把 id 带上，任务创建即同时持有两个文件 —— 不需要"等第二个文件"的挂起状态，
// 也就没有"用户传到一半跑了、任务永久挂起"的风险。
//
// 暂存的另一个好处：PPT 转换慢（.ppt 可能 40 秒以上）且可能内容不足，
// 在暂存阶段就转好并把质量指标返回给前端，用户提交前就能看到"这份 PPT 以图片为主"的提醒。

export const PPT_STASH_DIR = path.join(DATA_DIR, 'ppt-stash');
const STASH_TTL_MS = 2 * 60 * 60 * 1000;      // 暂存 2 小时后自动清理

/** 清理过期暂存（每次暂存新文件时顺手做，不必单设定时器） */
export function cleanPptStash() {
  if (!fs.existsSync(PPT_STASH_DIR)) return 0;
  let n = 0;
  const now = Date.now();
  for (const id of fs.readdirSync(PPT_STASH_DIR)) {
    const p = path.join(PPT_STASH_DIR, id);
    try {
      const meta = readJson(path.join(p, 'meta.json'), null);
      const at = meta && meta.at ? new Date(meta.at).getTime() : 0;
      if (!at || now - at > STASH_TTL_MS) { fs.rmSync(p, { recursive: true, force: true }); n++; }
    } catch { try { fs.rmSync(p, { recursive: true, force: true }); n++; } catch { } }
  }
  return n;
}

export function stashDir(id) { return path.join(PPT_STASH_DIR, id); }
export function newStashId() { return 'P' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); }
export function getStash(id) { return id ? readJson(path.join(stashDir(id), 'meta.json'), null) : null; }
export function saveStash(id, meta) {
  fs.mkdirSync(stashDir(id), { recursive: true });
  writeJson(path.join(stashDir(id), 'meta.json'), meta);
}

/** 把暂存的 PPT 搬进任务目录，返回搬过去之后的文件信息 */
export function moveStashToTask(stashId, taskDirPath) {
  const s = getStash(stashId);
  if (!s) throw new Error('PPT 暂存已过期，请重新上传');
  const src = stashDir(stashId);
  const safeName = String(s.fileName || s.name || 'ppt.pptx').replace(/[\\/:*?"<>|]/g, '_');
  const raw = path.join(src, safeName);
  if (fs.existsSync(raw)) fs.copyFileSync(raw, path.join(taskDirPath, safeName));
  const md = path.join(src, 'ppt.md');
  if (fs.existsSync(md)) fs.copyFileSync(md, path.join(taskDirPath, 'ppt.md'));
  try { fs.rmSync(src, { recursive: true, force: true }); } catch { }
  return { name: safeName, bytes: s.bytes, slides: s.slides, chars: s.chars, quality: s.quality, engine: s.engine };
}

// ─────────────── 文档转换 ───────────────

function run(cmd, args, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { try { p.kill(); } catch {} reject(new Error(`超时 ${timeoutMs}ms`)); }, timeoutMs);
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`${path.basename(cmd)} 退出码 ${code}: ${err.slice(0, 300)}`)); });
  });
}

/** 把上传的报告转成 markdown 文本。只接受 docx/doc；.doc 先经 LibreOffice 转 docx。 */
// ─────────────── 文档转换 ───────────────

/** 判定文档类别：报告（Word）/ 汇报材料（PPT） */
export function docKind(nameOrPath) {
  const e = path.extname(String(nameOrPath || '')).toLowerCase();
  if (e === '.ppt' || e === '.pptx') return 'ppt';
  if (e === '.doc' || e === '.docx') return 'doc';
  return 'other';
}
export const ACCEPTED_EXT = ['.docx', '.doc', '.pptx', '.ppt'];

/**
 * PPT 提取质量的判定阈值。
 *
 * 为什么需要：工程汇报 PPT 大量是把报告里的图表**截图上来的**，markitdown 只提取
 * 文字与表格、不做 OCR，所以这种 PPT 提出来几乎没内容。
 * 实测：一份 16.5MB 的纯截图 PPTX 只提取到 1,609 字符；
 *       一份 16.6MB 的文字型 PPT 提取到 29,786 字符 / 143 页。
 * 差距 18 倍 —— 所以必须能识别出来并如实告知用户，而不是假装查过了。
 */
export const PPT_MIN_CHARS = 3000;        // 少于这个字符数认为内容不足
export const PPT_MIN_CHARS_PER_SLIDE = 60; // 每页少于这个字符数也认为偏少

/** 评估 PPT 提取结果是否够用 */
export function pptTextQuality(text, slides) {
  const chars = String(text || '').length;
  const perSlide = slides > 0 ? Math.round(chars / slides) : 0;
  const enough = chars >= PPT_MIN_CHARS && perSlide >= PPT_MIN_CHARS_PER_SLIDE;
  // 图片占位符的密度：越高越说明这份 PPT 是"截图堆"
  const imgMarkers = (String(text || '').match(/!\[[^\]]*\]\([^)]*\)|\[图片\]/g) || []).length;
  const imgRatio = chars > 0 ? Math.min(1, imgMarkers / Math.max(1, slides)) : 0;
  return { chars, slides, perSlide, imgMarkers, imgRatio, enough };
}

export async function convertToMarkdown(srcPath, onLog = () => {}) {
  const ext = path.extname(srcPath).toLowerCase();
  const kind = docKind(srcPath);
  let work = srcPath;

  if (ext === '.doc') {
    onLog('检测到 .doc，先用 LibreOffice 转换为 .docx…');
    const outDir = path.dirname(srcPath);
    await run(SOFFICE, ['--headless', '--convert-to', 'docx', '--outdir', outDir, srcPath]);
    const cand = path.join(outDir, path.basename(srcPath, ext) + '.docx');
    if (!fs.existsSync(cand)) throw new Error('.doc 转换失败（未生成 .docx）');
    work = cand;
  } else if (ext === '.ppt') {
    // .ppt 是二进制老格式，markitdown 读不了，必须先转 pptx。
    // 实测 16.6MB 的 .ppt 转换约 54 秒 —— 慢，但本地免费，界面上要提示用户耐心等。
    onLog('检测到 .ppt（老格式），先用 LibreOffice 转换为 .pptx…（大文件可能要 1~2 分钟）');
    const outDir = path.dirname(srcPath);
    await run(SOFFICE, ['--headless', '--convert-to', 'pptx', '--outdir', outDir, srcPath], 600000);
    const cand = path.join(outDir, path.basename(srcPath, ext) + '.pptx');
    if (!fs.existsSync(cand)) throw new Error('.ppt 转换失败（未生成 .pptx）');
    work = cand;
  } else if (ext !== '.docx' && ext !== '.pptx') {
    throw new Error(`仅支持 ${ACCEPTED_EXT.join(' / ')}，收到 ${ext}`);
  }

  // 提取正文：markitdown 优先（表格还原更好），但实测会偶发崩溃（exit 3221225477 访问冲突），
  // 因此加一次重试。Word 再用 pandoc 兜底（原生二进制更稳）；
  // PPT 不能用 pandoc —— 它不走 pptx 的幻灯片结构，出来是一坨没有页码的文字，没法定位问题。
  const mdPath = work.replace(/\.(docx?|pptx?)$/i, '') + '.extracted.md';
  let text = null, engine = '';

  for (let attempt = 1; attempt <= 2 && text === null; attempt++) {
    try {
      onLog(`用 markitdown 提取${kind === 'ppt' ? '幻灯片文字与表格' : '正文与表格'}${attempt > 1 ? `（第 ${attempt} 次尝试）` : ''}…`);
      await run(MARKITDOWN, [work, '-o', mdPath]);
      text = fs.readFileSync(mdPath, 'utf8');
      engine = 'markitdown' + (attempt > 1 ? `（第${attempt}次）` : '');
    } catch (e) {
      onLog(`  markitdown 失败：${String(e.message).slice(0, 90)}`);
      if (attempt === 1) await new Promise(r => setTimeout(r, 1500));
    }
  }

  if (text === null) {
    if (kind === 'ppt') throw new Error('PPT 文字提取失败（markitdown 连续两次出错）');
    onLog('markitdown 连续失败，改用 pandoc 兜底提取…');
    await run(PANDOC, [work, '-t', 'gfm', '-o', mdPath, '--wrap=none'], 180000);
    text = fs.readFileSync(mdPath, 'utf8');
    engine = 'pandoc（兜底）';
  }

  // 剥离图片（base64 内嵌 与 media/ 外部引用），避免上下文被撑爆
  const before = text.length;
  // PPT 用 <!-- Slide number: N --> 标记页；顺便统计页数，后面判定内容够不够
  const slides = kind === 'ppt' ? (text.match(/<!--\s*Slide number:\s*\d+\s*-->/g) || []).length : 0;
  text = text
    .replace(/!\[\]\(data:image\/[a-z]+;base64,[^)]*\)/g, '[图片]')
    .replace(/<img[^>]*>/gi, '[图片]')
    .replace(/!\[[^\]]*\]\([^)]*media\/[^)]*\)/g, '[图片]');
  const tables = (text.match(/^\s*\|/gm) || []).length;
  onLog(`转换完成（引擎 ${engine}）：${text.length.toLocaleString()} 字符（剥离图片 ${(before - text.length).toLocaleString()} 字符），表格行 ${tables}`
    + (kind === 'ppt' ? `，幻灯片 ${slides} 页` : ''));

  const quality = kind === 'ppt' ? pptTextQuality(text, slides) : null;
  if (quality && !quality.enough) {
    // 说清楚是**哪一条**不达标，别让用户看到"每页 101 字，低于 60 字"这种自相矛盾的话
    const why = quality.chars < PPT_MIN_CHARS
      ? `全篇只有 ${quality.chars.toLocaleString()} 个字，低于 ${PPT_MIN_CHARS.toLocaleString()} 字的可用下限`
      : `平均每页约 ${quality.perSlide} 字，低于 ${PPT_MIN_CHARS_PER_SLIDE} 字的可用线`;
    onLog(`⚠️ 这份 PPT 以图片为主（共 ${slides} 页，${why}）。`
      + '系统不做图片 OCR，图片里的文字和表格看不见，只能做有限的校对，内容级的一致性核对无法进行。');
  }
  return { text, tables, mdPath, engine, kind, slides, quality };
}

/**
 * 成果 HTML → PDF（用本机 Chrome/Edge 的无头打印）。
 *
 * 为什么不用 pandoc 出 Word：Word 版式不受控（表格宽度、分页、字体都会走样），
 * 用户反馈"下载 Word 的版式显示效果不好"。PDF 是给编制单位/归档用的最终形态，
 * 用浏览器自己的分页引擎渲染，和页面上看到的完全一致。
 *
 * 找不到浏览器时抛错，调用方应回退到「直接下载 HTML」。
 */
const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

export function findBrowser() {
  return BROWSERS.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

export async function exportPdfFromHtml(htmlPath, pdfPath, { timeout = 180000 } = {}) {
  const exe = findBrowser();
  if (!exe) throw new Error('未找到 Chrome / Edge，无法生成 PDF');
  const fileUrl = 'file:///' + path.resolve(htmlPath).replace(/\\/g, '/').replace(/ /g, '%20');
  const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pdf-'));
  try {
    await run(exe, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--no-pdf-header-footer',          // 不要页眉页脚（URL、页码）
      `--user-data-dir=${tmpProfile}`,
      `--print-to-pdf=${path.resolve(pdfPath)}`,
      fileUrl,
    ], timeout);
    if (!fs.existsSync(pdfPath) || fs.statSync(pdfPath).size < 1024) {
      throw new Error('PDF 生成结果为空');
    }
    return pdfPath;
  } finally {
    try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
  }
}

/** 意见书 HTML → Word（保留给需要可编辑稿的场景；成果下载走 PDF） */
export async function exportDocxFromHtml(htmlPath, docxPath) {
  await run(PANDOC, [htmlPath, '-o', docxPath], 180000);
  return docxPath;
}

/** 意见书 markdown → Word（pandoc，带目录与样式） */
export async function exportDocx(mdPath, docxPath, title) {
  const args = [mdPath, '-o', docxPath, '--from', 'gfm', '--toc', '--toc-depth=2', '-s'];
  if (title) args.push('--metadata', `title=${title}`);
  await run(PANDOC, args, 180000);
  return docxPath;
}

// ─────────────── 价格 / 峰谷 / 成本核算 ───────────────
//
// 来源：DeepSeek 官方定价页 https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
// 单位：元 / 百万 token
// 峰谷定义（官方）：北京时间周一至周五（不含法定节假日）9:00-12:00、14:00-18:00 为高峰；
//                  其余时段（含午休、夜间、周末、法定节假日全天）为空闲，空闲价 = 高峰价的一半。

export const PRICING = {
  'deepseek-flash': {
    peak:    { inMiss: 2.0, inHit: 0.04, out: 8.0 },
    offpeak: { inMiss: 1.0, inHit: 0.02, out: 4.0 },
  },
  'deepseek-v4-pro': {
    peak:    { inMiss: 9.0, inHit: 0.30, out: 27.0 },
    offpeak: { inMiss: 4.5, inHit: 0.15, out: 13.5 },
  },
};

/** 中国法定节假日（需每年更新；留空则仅按工作日/周末判断） */
const HOLIDAYS_FILE = path.join(DATA_DIR, 'holidays.json');

export function isPeakHour(d = new Date()) {
  // 归一化到北京时间（必须走 toBeijing，详见文件开头说明）
  const bj = toBeijing(d);
  const iso = bj.toISOString().slice(0, 10);
  const holidays = readJson(HOLIDAYS_FILE, []);
  if (Array.isArray(holidays) && holidays.includes(iso)) return false;   // 法定节假日全天空闲
  const day = bj.getUTCDay();                                            // 0=周日
  if (day === 0 || day === 6) return false;                              // 周末全天空闲
  const h = bj.getUTCHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

/**
 * 当前这一「高峰段」的结束时刻；不在高峰返回 null。
 * 高峰段只有两种：9:00-12:00 和 14:00-18:00（北京时间，工作日）。
 * 逐分钟前进即可，最多 4 小时（240 步），够用且不依赖时区换算。
 */
export function peakEndsAt(d = new Date()) {
  if (!isPeakHour(d)) return null;
  const t = new Date(d.getTime());
  t.setSeconds(0, 0);
  for (let i = 0; i < 12 * 60; i++) {
    t.setMinutes(t.getMinutes() + 1);
    if (!isPeakHour(t)) return t;
  }
  return null;
}

// 进入空闲时段后再多等一点，避开刚跨过 12:00 / 18:00 的那一刻（时钟偏差、边界反复）
export const OFFPEAK_BUFFER_MIN = Number(process.env.OFFPEAK_BUFFER_MIN || 10);

/**
 * 「闲时调用」模式下的 API 起跑时刻。
 *
 * 规则（对应用户要求：预处理先做完，到闲时后加 10 分钟再调 API）：
 *   · 现在就在空闲时段 → 立即调用（已经是半价，没必要再等）
 *   · 现在在高峰时段 → 本段高峰结束时刻 + 10 分钟
 *
 * 注意：只影响「什么时候开始调 AI」，不影响本地文档预处理——预处理永远是提交后立刻做。
 */
export function nextOffPeakStart(d = new Date(), bufferMin = OFFPEAK_BUFFER_MIN) {
  const end = peakEndsAt(d);
  if (!end) return new Date(d.getTime());
  return new Date(end.getTime() + bufferMin * 60000);
}

/** 给前端/日志看的时段快照 */
export function timingSnapshot(d = new Date()) {
  const peak = isPeakHour(d);
  const end = peakEndsAt(d);
  const apiStart = nextOffPeakStart(d);
  return {
    now: d.toISOString(),
    isPeak: peak,
    peakEndsAt: end ? end.toISOString() : null,
    offPeakStartAt: apiStart.toISOString(),
    bufferMin: OFFPEAK_BUFFER_MIN,
    // 当前这一分钟调用 API 的单价倍率（闲时=1，高峰=2）
    rateX: peak ? 2 : 1,
  };
}

/** 距离某个时刻还有多久（中文可读） */
export function untilText(target, now = new Date()) {
  const ms = target.getTime() - now.getTime();
  if (ms <= 0) return '现在';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60), mm = m % 60;
  return mm ? `${h} 小时 ${mm} 分钟` : `${h} 小时`;
}

/** 北京时间文本（服务器时区无关），用于日志与前端展示 */
export function fmtBJText(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  const bj = toBeijing(d);
  const p = (n) => String(n).padStart(2, '0');
  const time = `${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}`;
  // 同一天只显示时分，跨天带上日期
  const nowBj = toBeijing();
  const sameDay = bj.toISOString().slice(0, 10) === nowBj.toISOString().slice(0, 10);
  return sameDay ? `今天 ${time}` : `${bj.getUTCMonth() + 1}月${bj.getUTCDate()}日 ${time}`;
}

export function calcCost({ model = 'deepseek-flash', promptTokens = 0, completionTokens = 0, cacheHitTokens = 0, peak = false }) {
  const p = PRICING[model] || PRICING['deepseek-flash'];
  const rate = peak ? p.peak : p.offpeak;
  const miss = Math.max(0, promptTokens - cacheHitTokens);
  const cost = (miss / 1e6) * rate.inMiss
             + (cacheHitTokens / 1e6) * rate.inHit
             + (completionTokens / 1e6) * rate.out;
  return Math.round(cost * 10000) / 10000;   // 保留 4 位小数（元）
}

// ─────────────── 综合成本模型 ───────────────
//
// 用户要求：费用不能只算 API，年底要并入用工成本核算，所以要把「人工工时」也算进来。
// 参考同类内部工具的做法：TCO = API 直接成本 + 人工占用成本 + 设备与运维摊销。
// 人工部分按「占用工时 × 岗位时薪」折算——这才是年终做效益评价时应计入的口径。

export const COST_MODEL_FILE = path.join(DATA_DIR, 'cost-model.json');

export const DEFAULT_COST_MODEL = {
  labor: {
    submitterHourly: 60,        // 提交人（工程师）时薪 元/小时
    submitterMinutes: 3,        // 每次「准备+提交+查看结果」占用工时（分钟）
    reviewerHourly: 120,        // 审核专家时薪（参考值） 元/小时
    reviewerMinutes: 20,        // 每次「深度报告终审」占用工时（分钟）
  },
  infra: {
    serverMonthly: 0,           // 服务器/电力 月摊销（元）
    maintenanceMonthly: 0,      // 系统维护 月摊销（元）
  },
  year: new Date().getFullYear(),
};

export function getCostModel() {
  const saved = readJson(COST_MODEL_FILE, {});
  return {
    ...DEFAULT_COST_MODEL, ...saved,
    labor: { ...DEFAULT_COST_MODEL.labor, ...(saved.labor || {}) },
    infra: { ...DEFAULT_COST_MODEL.infra, ...(saved.infra || {}) },
  };
}
export function saveCostModel(m) { writeJson(COST_MODEL_FILE, m); }

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * 单次/单批成本的完整口径
 * @param {number} apiCost   已按真实 token 算出的 API 费用（元）
 * @param {number} count     审核次数
 * @param {number} deepCount 其中需要专家终审的次数（有深度报告的）
 */
export function computeCost({ apiCost = 0, count = 0, deepCount = 0, model = getCostModel() }) {
  const L = model.labor, I = model.infra;
  const submitter = count * (L.submitterMinutes / 60) * L.submitterHourly;
  const reviewer = deepCount * (L.reviewerMinutes / 60) * L.reviewerHourly;
  return {
    api: r2(apiCost),
    laborSubmitter: r2(submitter),
    laborReviewer: r2(reviewer),
    labor: r2(submitter + reviewer),
    infra: 0,                                     // 摊销在年度层面计入
    total: r2(apiCost + submitter + reviewer),
    perAudit: count ? r2((apiCost + submitter + reviewer) / count) : 0,
  };
}

/** 年度测算：按已发生数据外推，并计入设备与运维摊销 */
export function projectAnnual({ monthCount = 0, monthApiCost = 0, monthDeepCount = 0, model = getCostModel(), monthsElapsed = 1 }) {
  const months = Math.max(1, Math.min(12, monthsElapsed));
  const perMonth = {
    count: monthCount / months,
    apiCost: monthApiCost / months,
    deepCount: monthDeepCount / months,
  };
  const oneMonth = computeCost({ apiCost: perMonth.apiCost, count: perMonth.count, deepCount: perMonth.deepCount, model });
  const infraMonthly = (model.infra.serverMonthly || 0) + (model.infra.maintenanceMonthly || 0);
  const monthly = r2(oneMonth.total + infraMonthly);
  return {
    year: model.year,
    perMonth: { ...oneMonth, infra: r2(infraMonthly), total: monthly },
    annual: {
      api: r2(perMonth.apiCost * 12),
      labor: r2(oneMonth.labor * 12),
      infra: r2(infraMonthly * 12),
      total: r2(monthly * 12),
      audits: Math.round(perMonth.count * 12),
    },
    assumedMonths: months,
  };
}

// ─────────────── 闲时 / 忙时（高峰）调用统计 ───────────────
//
// 用途：把「为省钱把 AI 调用推到闲时」这件事变成可考核的数字——
//       谁在闲时跑、哪个项目在闲时跑、闲时占多少、因此省了多少钱。
// 口径：按任务**实际计费时段**（t.peak）归类，而不是按提交时刻——闲时模式的任务
//       可能在高峰时段提交、闲时执行，按执行时段算才与账单一致。

export const PEAK_RANGES = [
  { key: 'today', name: '当天' },
  { key: '7d', name: '近 7 天' },
  { key: '30d', name: '近 30 天' },
  { key: 'month', name: '本月' },
  { key: 'all', name: '全部' },
];

/** 把范围 key 换算成北京时间的起止时刻（含起、含止） */
export function peakRangeBounds(key = 'today', now = new Date()) {
  const bj = toBeijing(now);
  const dayStartBj = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate());
  const toUtc = (ms) => new Date(ms - BJ_OFFSET_MIN * 60000);
  if (key === 'today') return { from: toUtc(dayStartBj), to: now };
  if (key === '7d') return { from: toUtc(dayStartBj - 6 * 864e5), to: now };
  if (key === '30d') return { from: toUtc(dayStartBj - 29 * 864e5), to: now };
  if (key === 'month') return { from: toUtc(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), 1)), to: now };
  return { from: null, to: null };   // all
}

/**
 * @param {object[]} tasks 已按范围（本人 / 全部）过滤过的任务
 * @param {string}   range today | 7d | 30d | month | all
 */
export function buildPeakStats(tasks, { range = 'today', model = 'deepseek-flash', now = new Date() } = {}) {
  const { from, to } = peakRangeBounds(range, now);
  const inRange = tasks.filter(t => {
    if (t.status !== 'done') return false;
    if (!from) return true;
    const d = new Date(t.finishedAt || t.createdAt || 0);
    return d >= from && d <= to;
  });

  const blank = () => ({ count: 0, tokens: 0, cost: 0, users: new Set(), projects: new Set() });
  const P = blank(), O = blank();
  const byUser = new Map(), byProject = new Map();

  for (const t of inRange) {
    const bucket = t.peak ? P : O;
    const tok = (t.usage?.prompt || 0) + (t.usage?.completion || 0);
    const cost = t.cost || 0;
    bucket.count++; bucket.tokens += tok; bucket.cost += cost;
    bucket.users.add(t.ownerName || t.owner || '（未知）');
    if (t.projectName) bucket.projects.add(t.projectName);

    const un = t.ownerName || t.owner || '（未知）';
    const ur = byUser.get(un) || { name: un, peakCount: 0, offpeakCount: 0, peakTokens: 0, offpeakTokens: 0, peakCost: 0, offpeakCost: 0 };
    t.peak ? (ur.peakCount++, ur.peakTokens += tok, ur.peakCost += cost)
           : (ur.offpeakCount++, ur.offpeakTokens += tok, ur.offpeakCost += cost);
    byUser.set(un, ur);

    const pn = t.projectName || t.sourceName || '（未识别项目）';
    const pr = byProject.get(pn) || { name: pn, peakCount: 0, offpeakCount: 0, peakTokens: 0, offpeakTokens: 0 };
    t.peak ? (pr.peakCount++, pr.peakTokens += tok) : (pr.offpeakCount++, pr.offpeakTokens += tok);
    byProject.set(pn, pr);
  }

  const total = { count: P.count + O.count, tokens: P.tokens + O.tokens, cost: P.cost + O.cost };
  const pctOf = (n, d) => (d > 0 ? Math.round(n / d * 1000) / 10 : 0);

  // 如果全部改在闲时执行，按闲时价重算一次，差额就是"闲时调度省下的钱"
  const rate = PRICING[model] || PRICING['deepseek-flash'];
  let costIfAllOffPeak = 0, costIfAllPeak = 0;
  for (const t of inRange) {
    const u = t.usage || {};
    const hit = u.cacheHit || 0, prompt = u.prompt || 0, out = u.completion || 0;
    const miss = Math.max(0, prompt - hit);
    costIfAllOffPeak += miss / 1e6 * rate.offpeak.inMiss + hit / 1e6 * rate.offpeak.inHit + out / 1e6 * rate.offpeak.out;
    costIfAllPeak += miss / 1e6 * rate.peak.inMiss + hit / 1e6 * rate.peak.inHit + out / 1e6 * rate.peak.out;
  }

  const shape = (b) => ({ count: b.count, tokens: b.tokens, cost: Math.round(b.cost * 100) / 100, users: b.users.size, projects: b.projects.size });
  return {
    range,
    ranges: PEAK_RANGES,
    from: from ? from.toISOString() : null,
    to: to ? to.toISOString() : null,
    peak: { ...shape(P), share: pctOf(P.count, total.count), tokenShare: pctOf(P.tokens, total.tokens) },
    offpeak: { ...shape(O), share: pctOf(O.count, total.count), tokenShare: pctOf(O.tokens, total.tokens) },
    total: { ...total, cost: Math.round(total.cost * 100) / 100 },
    // 省了多少：全部按高峰跑要花 costIfAllPeak，实际花了 total.cost
    saving: {
      ifAllPeak: Math.round(costIfAllPeak * 100) / 100,
      ifAllOffPeak: Math.round(costIfAllOffPeak * 100) / 100,
      actual: Math.round(total.cost * 100) / 100,
      saved: Math.round((costIfAllPeak - total.cost) * 100) / 100,
      savedPct: costIfAllPeak > 0 ? pctOf(costIfAllPeak - total.cost, costIfAllPeak) : 0,
    },
    byUser: [...byUser.values()].map(x => ({
      ...x,
      total: x.peakCount + x.offpeakCount,
      offpeakShare: pctOf(x.offpeakCount, x.peakCount + x.offpeakCount),
      peakCost: Math.round(x.peakCost * 100) / 100,
      offpeakCost: Math.round(x.offpeakCost * 100) / 100,
    })).sort((a, b) => b.total - a.total),
    byProject: [...byProject.values()].map(x => ({
      ...x,
      total: x.peakCount + x.offpeakCount,
      offpeakShare: pctOf(x.offpeakCount, x.peakCount + x.offpeakCount),
    })).sort((a, b) => b.total - a.total).slice(0, 30),
  };
}

// ─────────────── AI 技能完善（人工反馈学习）───────────────
//
// 用户定的分层规矩：**知识进 skill，逻辑进引擎**。所以这里做的事是——
//   人工复核意见 → 结构化经验条目（数据层，本文件）→ 生成 LEARNED.md（技能层）→ 引擎读取后注入审核提示。
//
// 关键约束：
//   1. **Skill 原件一个字都不动**。经验写在 skill 目录下**独立的** LEARNED.md 里，
//      sync-skill.mjs 同步 WorkBuddy 原件时不会碰它，两者互不干扰。
//   2. 全局经验进 system 段（稳定前缀，保住 DeepSeek 缓存）；项目级经验进 user 段
//      （user 段本来就随报告变化，不影响缓存命中）。
//   3. 经验是**提示重点**不是硬规则：提示里明确写"与报告实际内容冲突时以内容为准"，
//      避免一条错误经验污染全局判定。

export const FEEDBACK_FILE = path.join(DATA_DIR, 'skill-feedback.json');
export const LEARNED_FILE = path.join(SKILL_DIR_LOCAL, 'LEARNED.md');

export const FEEDBACK_KINDS = [
  { key: 'false-positive', name: '误报纠正', hint: 'AI 报错但实际没问题 —— 说明为什么不算问题' },
  { key: 'miss', name: '漏报补充', hint: 'AI 没报但应该报 —— 说明该查什么、怎么判' },
  { key: 'criteria', name: '判定口径', hint: '某个类别的定级标准要调整 —— 写清新口径' },
  { key: 'wording', name: '表述与重点', hint: '审核重点或表述方式的偏好' },
];

export function listFeedback() {
  const a = readJson(FEEDBACK_FILE, []);
  return Array.isArray(a) ? a : [];
}
export function saveFeedback(a) { writeJson(FEEDBACK_FILE, a); }

/**
 * 一条经验适用的项目名列表。
 * 支持「一条经验挂多个项目」：报告常常是一类里好几份都有同样毛病，
 * 没必要把同一句话录 N 遍。老记录只有单个 projectName，这里统一成数组。
 */
export function feedbackProjects(x) {
  const arr = Array.isArray(x.projectNames) ? x.projectNames.map(s => String(s || '').trim()).filter(Boolean) : [];
  if (arr.length) return [...new Set(arr)];
  return x.projectName ? [String(x.projectName).trim()] : [];
}
/**
 * 一条经验适用的项目类型列表。
 * 这是「一类报告」的绑定维度 —— 比绑到某一个具体报告有意义得多：
 * 经验要沉淀进技能，关心的就是"这类报告该怎么判"，而不是"这份报告该怎么判"。
 */
export function feedbackTypes(x) {
  const arr = Array.isArray(x.projectTypes) ? x.projectTypes.map(s => String(s || '').trim()).filter(Boolean) : [];
  if (arr.length) return [...new Set(arr)];
  // 老记录可能把类型写在 projectType 单字段里
  return x.projectType ? [String(x.projectType).trim()] : [];
}

/** 一条经验关联的任务号列表 */
export function feedbackTaskIds(x) {
  const arr = Array.isArray(x.taskIds) ? x.taskIds.map(s => String(s || '').trim()).filter(Boolean) : [];
  if (arr.length) return [...new Set(arr)];
  return x.taskId ? [String(x.taskId).trim()] : [];
}

/** 作用域标签（界面与 LEARNED.md 共用同一套说法，避免两处措辞不一致） */
export function scopeLabel(x) {
  if (x.scope === 'project') {
    const ps = feedbackProjects(x);
    if (!ps.length) return '指定项目（未指明）';
    return ps.length === 1 ? `仅项目：${ps[0]}` : `指定 ${ps.length} 个项目`;
  }
  if (x.scope === 'type') {
    const ts = feedbackTypes(x);
    if (!ts.length) return '按类型（未指明）';
    return ts.length === 1 ? `仅类型：${ts[0]}` : `${ts.length} 类报告`;
  }
  return '全局';
}

/**
 * 一条经验**生效的口径**（可以有多条）。
 *
 * 设计：人工审核意见（opinion）是"判断"，人只写这一样；
 * 一句话口径由 AI 提炼若干候选，人勾选保留哪几条 —— 所以这里是数组。
 * 一条意见里常常含多个独立规则（如"差异小的降级"+"但影响结论的仍算P0"），
 * 拆成多条比挤成一句更清楚，也更容易被模型照着执行。
 */
export function feedbackLessons(x) {
  const arr = Array.isArray(x.lessons) ? x.lessons.map(s => String(s || '').trim()).filter(Boolean) : [];
  if (arr.length) return [...new Set(arr)];
  if (x.lesson && String(x.lesson).trim()) return [String(x.lesson).trim()];   // 老的单条字段
  return [];
}
/** 渲染成一行文本：多口径时逐条列出，避免挤成一坨 */
export function feedbackLessonsText(x) {
  const ls = feedbackLessons(x);
  if (!ls.length) return String(x.opinion || '').trim();
  if (ls.length === 1) return ls[0];
  return '\n' + ls.map(s => `  - ${s}`).join('\n');
}

/** 按当前条目生成 LEARNED.md 内容（纯函数，便于预览与落盘共用） */
export function buildLearnedMarkdown(all, { generatedAt = new Date() } = {}) {
  const active = all.filter(x => x.status !== 'archived');
  const global = active.filter(x => x.scope !== 'project' && x.scope !== 'type');
  const byType = new Map();
  for (const x of active.filter(x => x.scope === 'type')) {
    for (const k of (feedbackTypes(x).length ? feedbackTypes(x) : ['（未指明类型）'])) {
      if (!byType.has(k)) byType.set(k, []);
      byType.get(k).push(x);
    }
  }
  const byProject = new Map();
  for (const x of active.filter(x => x.scope === 'project')) {
    // 一条经验可以挂多个项目 —— 每个项目下都出现一次（内容相同，作用域各自独立）
    const names = feedbackProjects(x);
    for (const k of (names.length ? names : ['（未指明项目）'])) {
      if (!byProject.has(k)) byProject.set(k, []);
      byProject.get(k).push(x);
    }
  }
  const nType = active.filter(x => x.scope === 'type').length;
  const nProj = active.filter(x => x.scope === 'project').length;

  const line = (x) => {
    const cat = x.category ? `【${x.category}】` : '';
    const projs = feedbackProjects(x);
    const tids = feedbackTaskIds(x);
    const src = [
      projs.length > 1 ? `适用 ${projs.length} 个项目` : projs[0],
      tids.length > 1 ? `${tids.length} 个任务` : tids[0],
      x.by, (x.createdAt || '').slice(0, 10),
    ].filter(Boolean).join(' · ');
    const ls = feedbackLessons(x);
    const hasLesson = ls.length > 0;
    // 多条口径用嵌套列表，不要用「；」串成一句 ——
    // 勾选出来的候选本身常带①②编号或分号，串起来就成了一坨读不懂的长句（实测踩过）。
    const head = `- ${cat}`;
    const bodyTxt = hasLesson
      ? (ls.length === 1 ? ls[0] : '\n' + ls.map(s => `  - ${s}`).join('\n'))
      : (x.opinion || '').trim();
    return head + bodyTxt
      + (hasLesson && x.opinion ? `\n  - 依据（人工意见原文）：${x.opinion.trim().replace(/\n+/g, ' ')}` : '')
      + (src ? `\n  - 来源：${src}` : '');
  };

  const sections = [
    ['false-positive', '误报纠正（下列情形**不算问题**，不要报；确要提也只能列 P2/P3）'],
    ['miss', '漏报补充（下列情形**必须核查并报出**）'],
    ['criteria', '判定口径（按此口径定级，覆盖技能文件中的默认理解）'],
    ['wording', '审核重点与表述偏好'],
  ];

  let md = `# 平台积累的审核经验（自动生成）\n\n`
    + `> ⚠️ 本文件由「工程咨询成果审核工作台」根据人工复核反馈自动生成，**请勿手工编辑**（下次生成会覆盖）。\n`
    + `> 生成时间：${toBeijing(generatedAt).toISOString().slice(0, 16).replace('T', ' ')}（北京时间）　`
    + `共 ${active.length} 条经验（全局 ${global.length} + 按类型 ${nType} + 指定项目 ${nProj}）\n\n`
    + `> 使用方式：这些是**审查重点提示**，来源于本单位人工复核的实际结论。\n`
    + `> 若与报告实际内容冲突，**以报告实际内容为准**，并在问题描述中说明你所采用的判定口径。\n`
    + `> 层次说明：每个小节先是全局条目；带「仅适用于…」小标题的，只在相应类型/项目的报告上生效。\n`;

  // 组织方式：**先按经验类型分节**（误报纠正/漏报补充/判定口径/表述偏好），
  // 节内再分「全局 → 仅某类报告 → 仅某项目」三层。
  // 教训：早先把类型级/项目级条目全堆到文件末尾，读的人（和模型）就看不出
  //       一条经验到底是"不该报"还是"必须报"——类型信息比作用域信息更关键。
  const scopedPart = (items, kind) => {
    const mine = items.filter(x => x.kind === kind);
    if (!mine.length) return '';
    let s = '';
    const g = mine.filter(x => x.scope !== 'type' && x.scope !== 'project');
    if (g.length) s += g.map(line).join('\n') + '\n';

    const tMap = new Map();
    for (const x of mine.filter(x => x.scope === 'type')) {
      for (const k of (feedbackTypes(x).length ? feedbackTypes(x) : ['（未指明类型）'])) {
        if (!tMap.has(k)) tMap.set(k, []);
        tMap.get(k).push(x);
      }
    }
    for (const [tname, list] of tMap) {
      s += `\n**仅适用于「${tname}」类报告：**\n\n${list.map(line).join('\n')}\n`;
    }

    const pMap = new Map();
    for (const x of mine.filter(x => x.scope === 'project')) {
      for (const k of (feedbackProjects(x).length ? feedbackProjects(x) : ['（未指明项目）'])) {
        if (!pMap.has(k)) pMap.set(k, []);
        pMap.get(k).push(x);
      }
    }
    for (const [pname, list] of pMap) {
      s += `\n**仅适用于项目「${pname}」：**\n\n${list.map(line).join('\n')}\n`;
    }
    return s;
  };

  // 只给「有内容的小节」连续编号，避免出现「一、二、五」这种跳号
  const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  let n = 0;
  for (const [kind, title] of sections) {
    const body = scopedPart(active, kind);
    if (!body.trim()) continue;
    md += `\n## ${CN[n++]}、${title}\n\n${body}`;
  }

  return md;
}

/**
 * 取适用于某次审核的「定向经验」文本（引擎在 user 段注入）。
 *
 * 两个维度**同时**匹配：
 *   · 按报告类型（scope='type'）—— 一类报告的通病，主要维度
 *   · 指定项目（scope='project'）—— 某个项目的特殊要求
 * 两条都收，类型经验在前（更通用），项目经验在后（更具体，后写的覆盖先写的）。
 */
export function learnedForContext({ projectName = '', projectType = '' } = {}) {
  const act = listFeedback().filter(x => x.status !== 'archived');
  const byType = projectType
    ? act.filter(x => x.scope === 'type' && feedbackTypes(x).includes(projectType))
    : [];
  const byProj = projectName
    ? act.filter(x => x.scope === 'project' && feedbackProjects(x).includes(projectName))
    : [];
  const items = [...byType, ...byProj];
  if (!items.length) return '';
  const head = [];
  if (byType.length) head.push(`【按报告类型「${projectType}」】`);
  if (byProj.length) head.push(`【指定项目「${projectName}」】`);
  return (head.length ? head.join(' ') + '\n' : '') + items.map(x => {
    const cat = x.category ? `【${x.category}】` : '';
    return `- ${cat}${feedbackLessonsText(x)}`;
  }).join('\n');
}

/** 兼容旧签名：只给项目名时等价于只按项目匹配 */
export function learnedForProject(projectName) {
  return learnedForContext({ projectName });
}

/** 把当前经验落盘成 LEARNED.md，返回 { count, markdown } */
export function applyLearned() {
  const all = listFeedback();
  const md = buildLearnedMarkdown(all);
  fs.mkdirSync(SKILL_DIR_LOCAL, { recursive: true });
  fs.writeFileSync(LEARNED_FILE, md, 'utf8');
  return { count: all.filter(x => x.status !== 'archived').length, markdown: md };
}

// ─────────────── 项目维度质量配额 ───────────────
//
// 用户设计的机制：按「项目」累计校对类问题数，累计到阈值（默认 200 项）即禁止该项目再提交。
// 目的不是省钱，而是**督促员工提高初稿质量**——不能把系统当免费校对平台反复刷。
// 与「每人每日 3 次」的用量配额互补：一个是防误操作，一个是防低质量反复提交。

export const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
export const SYSTEM_CONFIG_FILE = path.join(DATA_DIR, 'system.json');
export const DEFAULT_PROJECT_LIMIT = 200;

/** 系统开关（管理员可改） */
export const DEFAULT_SYSTEM_CONFIG = {
  // 项目质量配额「是否真的拦截」。用户要求：先只统计不拦截，观察一段时间再决定。
  enforceProjectQuota: false,
  projectLimit: DEFAULT_PROJECT_LIMIT,
  // 重复审核：block = 识别到别人审过同一项目就暂停等确认（默认）；warn = 只提醒照常审核
  duplicateMode: 'block',
};
export function getSystemConfig() {
  return { ...DEFAULT_SYSTEM_CONFIG, ...readJson(SYSTEM_CONFIG_FILE, {}) };
}
export function saveSystemConfig(c) {
  const next = { ...getSystemConfig(), ...c };
  writeJson(SYSTEM_CONFIG_FILE, next);
  return next;
}

export function listProjects() { return readJson(PROJECTS_FILE, {}); }
export function saveProjects(p) { writeJson(PROJECTS_FILE, p); }

/** 去空白与标点（保留数字与年份），用于「正文里是否出现某个项目名」的包含判断 */
export function flattenProjectText(s) {
  return String(s || '')
    .replace(/\s+/g, '')
    .replace(/[（）()【】\[\]《》<>"'，,。.、：:；;—\-_/\\]/g, '');
}

/** 项目名归一化：去空格/标点、去年份、去文件类型后缀，便于同一项目多次提交归并 */
export function normalizeProjectKey(name) {
  const t = flattenProjectText(name)
    // 年份可能出现在任何位置（"江汉2026年西北工区…" / "2026年江汉…"），统一去掉
    .replace(/20\d{2}年?/g, '')
    .replace(/(可行性研究报告|后评价报告|可研报告|汇报|报告|方案|修订稿|终稿|初稿|第三版|第二版|第一版)+$/g, '')
    .slice(0, 60);
  return t || '未识别项目';
}

// ─────────────── 重复审核提醒 ───────────────
//
// 场景：同一个项目被第二个人又提交一遍。白跑一次审核既费钱（约 ¥0.7 API + ¥258 人工工时），
//       也让台账里冒出两条同一项目的记录。
// 判定：**项目编号或项目名称**任一命中即算同一项目（报告里常常没有编号，只看名称会漏）。
// 时机：分两道——
//   · 本地粗筛（解析完正文立刻做，零 API）：拿已知项目的编号/名称去正文里找，命中就先挂个预警；
//   · S0 精确判定（识别出真实项目名后）：这一道才是权威结论，决定是否暂停。

const DUP_DEAD_STATUS = ['failed', 'rejected', 'cancelled'];

/**
 * 精确查重：给定项目名/编号，找出此前审过同一项目的任务。
 * @returns {object[]} 命中的历史任务（按时间正序），带 matchedBy 字段
 */
export function findDuplicateAudits(tasks, { projectName = '', projectCode = '', excludeTaskId = '', excludeOwner = '' } = {}) {
  const key = normalizeProjectKey(projectName);
  const code = String(projectCode || '').trim().toUpperCase();
  const hits = [];
  for (const t of tasks) {
    if (t.id === excludeTaskId) continue;
    if (DUP_DEAD_STATUS.includes(t.status)) continue;
    if (!t.projectName && !t.projectCode) continue;
    const tKey = normalizeProjectKey(t.projectName);
    const tCode = String(t.projectCode || '').trim().toUpperCase();
    const sameCode = !!(code && tCode && code === tCode);
    const sameName = !!(key && key !== '未识别项目' && key === tKey);
    if (!sameCode && !sameName) continue;
    hits.push({
      id: t.id,
      owner: t.owner, ownerName: t.ownerName || t.owner || '（未知）',
      status: t.status,
      createdAt: t.createdAt, finishedAt: t.finishedAt,
      sourceName: t.sourceName,
      projectName: t.projectName || '', projectCode: t.projectCode || '',
      projectType: t.projectType || '',
      p0: t.stats?.p0Count ?? null, p1: t.stats?.p1Count ?? null,
      isSameOwner: !!excludeOwner && t.owner === excludeOwner,
      matchedBy: sameCode && sameName ? 'both' : sameCode ? 'code' : 'name',
      conflict: t.duplicateConflict === true,   // 这条本身也是"被确认过的重复审核"
    });
  }
  return hits.sort((a, b) => String(a.finishedAt || a.createdAt || '').localeCompare(String(b.finishedAt || b.createdAt || '')));
}

/**
 * 本地粗筛（零 API）：拿已登记项目的编号 / 名称核心段去正文里找。
 * 用在「文档刚解析完、还没到 AI 调用时段」的时候——闲时任务可能几个小时后才跑 S0，
 * 那时候再提醒就太晚了（人也走了、钱也快花了）。
 */
export function quickDuplicateCheck(tasks, text, { excludeTaskId = '' } = {}) {
  const blob = String(text || '');
  if (!blob) return [];
  const flat = flattenProjectText(blob);     // 正文保留年份，仅去空白标点
  const upper = blob.toUpperCase();
  const hits = [];
  for (const t of tasks) {
    if (t.id === excludeTaskId) continue;
    if (DUP_DEAD_STATUS.includes(t.status)) continue;
    if (!t.projectName && !t.projectCode) continue;

    const code = String(t.projectCode || '').trim();
    if (code.length >= 5 && upper.includes(code.toUpperCase())) {
      hits.push({ ...t, matchedBy: 'code' });
      continue;
    }

    // 项目名可能有/无年份两种写法，都试一遍；太短的不拿来匹配，避免误命中
    const raw = flattenProjectText(t.projectName);
    const forms = new Set([raw, raw.replace(/20\d{2}年?/g, '')]);
    const core = normalizeProjectKey(t.projectName).replace(/[（(].*?[)）]/g, '');
    if (core.length >= 8 && core !== '未识别项目') forms.add(core);
    const hit = [...forms].some(f => f.length >= 8 && flat.includes(f));
    if (hit) hits.push({ ...t, matchedBy: 'name' });
  }
  return hits;
}

/** 把查重结果压成台账/详情要用的精简结构 */
export function summarizeDuplicates(hits, limit = 5) {
  return hits.slice(0, limit).map(h => ({
    id: h.id, ownerName: h.ownerName, owner: h.owner,
    status: h.status, createdAt: h.createdAt, finishedAt: h.finishedAt,
    sourceName: h.sourceName, projectName: h.projectName, projectCode: h.projectCode,
    p0: h.p0 ?? null, p1: h.p1 ?? null,
    isSameOwner: !!h.isSameOwner, matchedBy: h.matchedBy,
  }));
}

/**
 * 项目质量台账 —— **从任务实时派生**，不再维护只增不减的计数器。
 *
 * 为什么改：原先 upsertProject 往 projects.json 里累加，删掉任务后数字不会回落，
 * 于是出现「看板说 6 次审核，台账却说某项目 7 次提交、358 项」这种自相矛盾的数。
 * 现在台账和看板都从同一份任务数据算，天然一致。
 *
 * projects.json 只保留两类「人工设置」：项目显示名、以及管理员点过「清零」的时刻（resetAt）。
 *
 * 归组口径：优先按 S0 识别出的项目名；历史任务没有项目名时退回按文件名归组，
 *          这样所有已完成任务都会被统计到，提交次数之和 = 已完成审核次数。
 */
export function projectStats(tasks, { limit = DEFAULT_PROJECT_LIMIT } = {}) {
  const cfg = listProjects();
  const map = new Map();

  for (const t of tasks) {
    if (t.status !== 'done') continue;
    const display = String(t.projectName || t.sourceName || '（未识别）').trim();
    const key = normalizeProjectKey(display);
    const rec = cfg[key] || {};

    // 管理员点过「清零」的项目：只统计清零时刻之后完成的任务
    if (rec.resetAt) {
      const at = new Date(t.finishedAt || t.createdAt || 0).getTime();
      if (at < new Date(rec.resetAt).getTime()) continue;
    }

    const m = map.get(key) || {
      key, name: rec.name || display,
      byFilename: !t.projectName,          // 标记：这条是按文件名归组的
      proofreadTotal: 0, itemTotal: 0, submissions: 0,
      lastAt: null, lastOwner: '', resetAt: rec.resetAt || null,
      taskIds: [],
    };
    if (t.projectName) m.byFilename = false;
    if (display.length > (m.name || '').length) m.name = display;
    m.proofreadTotal += t.proofreadCount || 0;
    m.itemTotal += (t.proofreadCount || 0) + (t.deepCount || 0);
    m.submissions += 1;
    m.taskIds.push(t.id);
    const at = t.finishedAt || t.createdAt;
    if (at && (!m.lastAt || at > m.lastAt)) { m.lastAt = at; m.lastOwner = t.ownerName || ''; }
    map.set(key, m);
  }

  return [...map.values()]
    .map(m => ({
      ...m,
      remaining: Math.max(0, limit - m.proofreadTotal),
      blocked: m.proofreadTotal >= limit,
    }))
    .sort((a, b) => b.proofreadTotal - a.proofreadTotal || b.submissions - a.submissions);
}

/**
 * 项目质量配额检查（读派生值，所以和看板永远一致）。
 * @param {object[]} tasks 当前全部任务
 */
export function checkProjectQuota(tasks, name, limit = DEFAULT_PROJECT_LIMIT) {
  const key = normalizeProjectKey(name);
  const row = projectStats(tasks, { limit }).find(x => x.key === key);
  if (!row) return { ok: true, key, used: 0, limit, remaining: limit, submissions: 0, name };
  const ok = row.proofreadTotal < limit;
  return {
    ok, key, used: row.proofreadTotal, limit,
    remaining: row.remaining,
    submissions: row.submissions,
    name: row.name,
    reason: ok ? null
      : `项目「${row.name}」已累计 ${row.proofreadTotal} 项校对类问题（上限 ${limit} 项，已提交 ${row.submissions} 次）。`
        + `系统不再受理该项目——请先按已出意见修改初稿，把校对类问题降到可接受水平。`
        + `如确需继续，请联系管理员评估。`,
  };
}

/** 供看板：所有项目的累计情况（已按问题数降序） */
export function projectRanking(tasks, limit = DEFAULT_PROJECT_LIMIT) {
  return projectStats(tasks, { limit });
}

/** 记录项目的显示名（不再累计计数，计数一律由 projectStats 派生） */
export function touchProject(name, { owner = '', taskId = '' } = {}) {
  if (!name) return;
  const p = listProjects();
  const key = normalizeProjectKey(name);
  const rec = p[key] || {};
  if (String(name).length > String(rec.name || '').length) rec.name = name;
  rec.lastAt = new Date().toISOString();
  rec.lastOwner = owner;
  rec.lastTaskId = taskId;
  p[key] = rec;
  saveProjects(p);
}

/** 清零：记一个 resetAt，之后只统计比它新的任务（任务本身不动，留痕不破坏） */
export function resetProject(name, { newLimit } = {}) {
  const p = listProjects();
  const key = normalizeProjectKey(name);
  const rec = p[key] || { name };
  rec.name = rec.name || name;
  rec.resetAt = new Date().toISOString();
  if (newLimit !== undefined) rec.newLimit = newLimit;
  rec.resetBy = rec.resetBy || '';
  p[key] = rec;
  saveProjects(p);
  return { key, rec };
}

// ─────────────── 配额 ───────────────

export const DEFAULT_DAILY_LIMIT = 3;
export const DEFAULT_MONTHLY_LIMIT = 30;

/** 用户当日的用量（按任务创建时间统计，不含失败任务） */
export function usageOf(tasks, ownerId) {
  const now = new Date();
  const bj = toBeijing(now);
  const today = bj.toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const mine = tasks.filter(t => t.owner === ownerId && !['failed'].includes(t.status));
  const bjDay = (s) => {
    if (!s) return '';
    const d = new Date(s);
    return toBeijing(d).toISOString().slice(0, 10);
  };
  const usedToday = mine.filter(t => bjDay(t.createdAt) === today).length;
  const usedMonth = mine.filter(t => bjDay(t.createdAt).startsWith(month)).length;
  const costMonth = mine.filter(t => bjDay(t.createdAt).startsWith(month))
    .reduce((s, t) => s + (t.cost || 0), 0);
  const tokensMonth = mine.filter(t => bjDay(t.createdAt).startsWith(month))
    .reduce((s, t) => s + ((t.usage?.prompt || 0) + (t.usage?.completion || 0)), 0);
  return { usedToday, usedMonth, costMonth: Math.round(costMonth * 100) / 100, tokensMonth };
}

/** 检查配额；返回 { ok, reason } */
export function checkQuota(user, tasks) {
  if (user.role === 'admin') return { ok: true };                 // 管理员不受限
  const daily = user.dailyLimit ?? DEFAULT_DAILY_LIMIT;
  const monthly = user.monthlyLimit ?? DEFAULT_MONTHLY_LIMIT;
  const u = usageOf(tasks, user.id);
  if (daily > 0 && u.usedToday >= daily) {
    return { ok: false, reason: `今日已提交 ${u.usedToday} 次，达到上限 ${daily} 次。可改为「闲时审核」或联系管理员申请追加。`, usage: u, daily, monthly };
  }
  if (monthly > 0 && u.usedMonth >= monthly) {
    return { ok: false, reason: `本月已提交 ${u.usedMonth} 次，达到上限 ${monthly} 次。请联系管理员申请追加额度。`, usage: u, daily, monthly };
  }
  return { ok: true, usage: u, daily, monthly };
}

// ─────────────── 统计（看板 + 台账） ───────────────

export function aggregateStats(tasks) {
  const done = tasks.filter(t => t.status === 'done');
  const byCategory = {}, byBizType = {}, byOwner = {}, byDay = {};
  let issueTotal = 0, p0Total = 0, p1Total = 0;
  for (const t of done) {
    byBizType[t.bizType] = (byBizType[t.bizType] || 0) + 1;
    byOwner[t.ownerName || t.owner] = (byOwner[t.ownerName || t.owner] || 0) + 1;
    const day = (t.createdAt || '').slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
    const s = t.stats || {};
    p0Total += s.p0Count || 0; p1Total += s.p1Count || 0;
    issueTotal += (s.p0Count || 0) + (s.p1Count || 0) + (s.p2Count || 0) + (s.p3Count || 0);
    for (const [cat, n] of Object.entries(t.categoryCounts || {})) byCategory[cat] = (byCategory[cat] || 0) + n;
  }
  const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ k, v }));
  return {
    taskTotal: tasks.length, taskDone: done.length,
    taskQueued: tasks.filter(t => ACTIVE_STATES.includes(t.status)).length,
    taskFailed: tasks.filter(t => t.status === 'failed').length,
    issueTotal, p0Total, p1Total,
    topCategories: top(byCategory, 15),
    byBizType: top(byBizType, 10), byOwner: top(byOwner, 20), byDay: Object.entries(byDay).sort().slice(-30).map(([k, v]) => ({ k, v })),
  };
}

// ─────────────── 数据看板（驾驶舱）───────────────

const r1 = (n) => Math.round(n * 10) / 10;   // 保留一位小数
const pct = (part, whole) => (whole > 0 ? r1(part / whole * 100) : 0);

/**
 * 这条任务的 token 用量记录是否完整。
 * 早期版本的 S2 阶段没用累加 usage，task.usage 只记到 S1+S5，费用被低估到实际值的约 1/5
 * （实例：42,071 字符的报告只记了 32,795 输入 token）。这类记录**不能计入费用合计**。
 *
 * 判据：一次完整审核要把报告正文分别发给 7 个单元，prompt 必然远大于报告字符数；
 *       若 prompt 还不到字符数的 2 倍，就可以断定这条记录不完整。
 */
export const USAGE_COMPLETE_MIN_RATIO = 2;
export function isUsageComplete(t) {
  const chars = t?.convertedChars || 0;
  const p = t?.usage?.prompt || 0;
  if (!chars) return p > 0;          // 没有字符数记录时，只要有用量就当完整
  return p >= chars * USAGE_COMPLETE_MIN_RATIO;
}

/**
 * 汇总看板数据。
 *
 * 权限口径：
 *  - deepAccess=false（普通用户）：P0/P1 只统计**校对类**（编校/术语/数据/口径），不含深度类；
 *    用量（token / 缓存 / 费用）整块不返回。
 *  - deepAccess=true（管理员 / 审核专家）：P0/P1 含全部类别，用量与成本口径齐全。
 *
 * @param {object[]} tasks   已经按范围过滤好的任务（本人 或 全部）
 * @param {object}   o
 * @param {'mine'|'all'} o.scope
 * @param {boolean}  o.canDeep
 * @param {number}   o.monthApiCost 本月 API 费用（仅 canDeep 用）
 */
export function buildDashboard(tasks, { scope = 'mine', canDeep = false, monthApiCost = 0 } = {}) {
  const done = tasks.filter(t => t.status === 'done');
  const inFlight = tasks.filter(t => ACTIVE_STATES.includes(t.status));

  const isComplete = isUsageComplete;
  const complete = done.filter(isComplete);
  const incomplete = done.filter(t => !isComplete(t));

  // ── 一、审核次数与用量（费用只算记录完整的任务）──
  const sum = complete.reduce((s, t) => ({
    prompt: s.prompt + (t.usage?.prompt || 0),
    completion: s.completion + (t.usage?.completion || 0),
    cacheHit: s.cacheHit + (t.usage?.cacheHit || 0),
    cost: s.cost + (t.cost || 0),
  }), { prompt: 0, completion: 0, cacheHit: 0, cost: 0 });
  const badSum = incomplete.reduce((s, t) => s + (t.cost || 0), 0);

  const byUser = {}, byDay = {};
  for (const t of done) {
    const k = t.ownerName || t.owner || '（未知）';
    const r = byUser[k] ||= { name: k, count: 0, tokens: 0, cost: 0, cacheHit: 0, p0: 0, p1: 0, counted: 0, incomplete: 0 };
    r.count++;
    if (isComplete(t)) {
      r.counted++;
      r.tokens += (t.usage?.prompt || 0) + (t.usage?.completion || 0);
      r.cost += t.cost || 0;
      r.cacheHit += t.usage?.cacheHit || 0;
    } else {
      r.incomplete++;
    }
    r.p0 += canDeep ? (t.stats?.p0Count || 0) : (t.proofreadP0 || 0);
    r.p1 += canDeep ? (t.stats?.p1Count || 0) : (t.proofreadP1 || 0);
    const d = (t.createdAt || '').slice(0, 10);
    (byDay[d] ||= { day: d, count: 0, cost: 0 }).count++;
    if (isComplete(t)) byDay[d].cost += t.cost || 0;
  }

  const usage = {
    taskTotal: tasks.length,
    done: done.length,
    inFlight: inFlight.length,
    failed: tasks.filter(t => t.status === 'failed').length,
    cancelled: tasks.filter(t => t.status === 'cancelled').length,
    pendingDuplicate: tasks.filter(t => t.status === 'duplicate-suspect').length,
    activeUsers: Object.keys(byUser).length,
  };
  if (canDeep) {
    usage.tokens = { prompt: sum.prompt, completion: sum.completion, cacheHit: sum.cacheHit };
    usage.cost = Math.round(sum.cost * 100) / 100;
    usage.cacheHitRate = pct(sum.cacheHit, sum.prompt);
    usage.monthApiCost = Math.round(monthApiCost * 100) / 100;
    // 计入费用的任务数 / 被排除的历史任务
    usage.countedTasks = complete.length;
    usage.perAuditCost = complete.length ? Math.round(sum.cost / complete.length * 100) / 100 : 0;
    usage.perAuditTokens = complete.length
      ? Math.round((sum.prompt + sum.completion) / complete.length) : 0;
    usage.incomplete = {
      count: incomplete.length,
      cost: Math.round(badSum * 100) / 100,     // 按残缺记录算出来的钱，仅供对照
      tasks: incomplete.slice(0, 20).map(t => ({ id: t.id, sourceName: t.sourceName, ownerName: t.ownerName })),
    };
    usage.byUser = Object.values(byUser)
      .map(x => ({ ...x, tokens: x.tokens, cost: Math.round(x.cost * 100) / 100, cacheHitRate: pct(x.cacheHit, x.tokens) }))
      .sort((a, b) => b.cost - a.cost);
    usage.byDay = Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day)).slice(-30)
      .map(x => ({ ...x, cost: Math.round(x.cost * 100) / 100 }));
  } else {
    usage.byUser = Object.values(byUser).map(x => ({ name: x.name, count: x.count, p0: x.p0, p1: x.p1 }));
  }

  // ── 二、校对问题累计 · 按项目类型 ──
  const order = projectTypeOrder();
  const buckets = new Map(order.map(n => [n, { type: n, tasks: 0, p0: 0, p1: 0, issues: 0, titles: 0 }]));
  const byCategory = {};
  let totP0 = 0, totP1 = 0, totIssues = 0, totTitles = 0;

  for (const t of done) {
    const type = t.projectType && buckets.has(t.projectType)
      ? t.projectType
      : guessProjectType(t.projectName, t.sourceName, t.templateName);
    const b = buckets.get(type) || buckets.get(FALLBACK_PROJECT_TYPE);
    b.tasks++;

    // 权限口径：普通用户只算校对类
    let p0, p1, issues;
    if (canDeep) {
      const s = t.stats || {};
      p0 = s.p0Count || 0; p1 = s.p1Count || 0;
      issues = p0 + p1 + (s.p2Count || 0) + (s.p3Count || 0);
    } else {
      p0 = t.proofreadP0 || 0; p1 = t.proofreadP1 || 0;
      issues = p0 + p1;
    }
    b.p0 += p0; b.p1 += p1; b.issues += issues;
    // 「问题条目数」——历史任务没有条目总数，用校对类计数兜底
    b.titles += (t.proofreadCount || 0) + (canDeep ? (t.deepCount || 0) : 0);

    totP0 += p0; totP1 += p1; totIssues += issues;
    totTitles += (t.proofreadCount || 0) + (canDeep ? (t.deepCount || 0) : 0);

    for (const [cat, n] of Object.entries(t.categoryCounts || {})) {
      if (!canDeep && !PROOFREAD_CATEGORIES.has(cat)) continue;   // 普通用户看不到深度类类别
      byCategory[cat] = (byCategory[cat] || 0) + n;
    }
  }

  const byProjectType = [...buckets.values()]
    .map(b => ({
      type: b.type,
      tasks: b.tasks,
      p0: b.p0,
      p1: b.p1,
      issues: b.issues,
      // 占全部同级的比例
      p0Share: pct(b.p0, totP0),
      p1Share: pct(b.p1, totP1),
      issueShare: pct(b.issues, totIssues),
      // 平均每个报告多少条，便于横向比质量
      p0PerTask: b.tasks ? r1(b.p0 / b.tasks) : 0,
      p1PerTask: b.tasks ? r1(b.p1 / b.tasks) : 0,
    }))
    .filter(b => b.tasks > 0)
    .sort((a, b) => (b.p0 + b.p1) - (a.p0 + a.p1));

  const topCategories = Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ k, v, cls: PROOFREAD_CATEGORIES.has(k) ? 'proofread' : 'deep' }));

  return {
    scope,
    canDeep,
    generatedAt: new Date().toISOString(),
    usage,
    quality: {
      totals: {
        tasks: done.length, titles: totTitles, issues: totIssues, p0: totP0, p1: totP1,
        p0PerTask: done.length ? r1(totP0 / done.length) : 0,
        p1PerTask: done.length ? r1(totP1 / done.length) : 0,
      },
      byProjectType,
      byCategory: topCategories,
      // 未分类占比过高说明自动识别没跟上，管理员可据此调整项目类型清单
      unclassified: (buckets.get(FALLBACK_PROJECT_TYPE) || { tasks: 0 }).tasks,
      totalTasks: done.length,
    },
  };
}
