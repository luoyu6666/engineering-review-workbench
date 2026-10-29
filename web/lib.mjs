/**
 * 审核工作台 Web 服务 — 公共层
 * 账号 / 会话 / 存储 / 任务队列 / 文档转换 / Word 导出 / 统计
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROOFREAD_CATEGORIES } from '../engine/lib/report-html.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
// 数据目录可用环境变量 WB_DATA_DIR 覆盖，两种用途：
//   ① 部署到其它机器时把数据落到指定盘（配合 运维\restore.ps1）
//   ② 本地验证时起影子实例（另开端口 + 独立数据目录），不影响正在服务的实例
export const DATA_DIR = process.env.WB_DATA_DIR ? path.resolve(process.env.WB_DATA_DIR) : path.join(ROOT, 'web', 'data');
export const TASKS_DIR = path.join(DATA_DIR, 'tasks');
export const USERS_FILE = path.join(DATA_DIR, 'users.json');
export const TEMPLATES_FILE = path.join(DATA_DIR, 'templates.json');
export const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

// 技能目录（Skill 层）：审核知识写在这里。WorkBuddy 原件只读，同步方向为 原件到副本。
export const SKILL_DIR_LOCAL = process.env.SKILL_DIR
  || path.join(ROOT, 'skill', 'petroleum-engineering-review');

export const PORT = Number(process.env.PORT || 8787);
export const MAX_UPLOAD = 80 * 1024 * 1024;   // 80 MB

// ─────────────── 北京时间（全系统统一口径）───────────────
// DeepSeek 计费时段按北京时间划分，配额按自然日/自然月计算，两者都必须使用北京时间。
//
// 时区换算的既有缺陷（改动前需理解）：
//   `new Date(t + (d.getTimezoneOffset() + 480) * 60000)` 仅在继续使用本地访问器
//   （getFullYear/getHours 等）时成立；若改用 UTC 访问器（getUTCHours/toISOString），
//   读到的仍是 UTC 时间。时区为 UTC+8 的机器上 getTimezoneOffset() 为 -480，
//   偏移被抵消为 0，15:50 被读成 7:50 —— 高峰时段被判成空闲时段，
//   费用按半价少算一半，闲时审核也不会真正推迟调用。
//
//   正确做法：使用 UTC 访问器时走 toBeijing()（常量偏移，与机器时区无关）；
//   使用本地访问器时直接 new Date(v) 并调用本地访问器。
export const BJ_OFFSET_MIN = 480;

/** 返回一个 Date，其 getUTC* 系列读出的即北京墙上时间。入参接受 Date / ISO 字符串 / 毫秒数 */
export function toBeijing(d = new Date()) {
  const t = (d instanceof Date) ? d.getTime() : (typeof d === 'number' ? d : new Date(d).getTime());
  return new Date((isNaN(t) ? Date.now() : t) + BJ_OFFSET_MIN * 60000);
}

const MARKITDOWN = String.raw`C:\Users\Administrator\AppData\Local\Programs\Python\Python312\Scripts\markitdown.exe`;
const SOFFICE = String.raw`C:\Program Files\LibreOffice\program\soffice.exe`;
const PANDOC = String.raw`C:\Users\Administrator\scoop\shims\pandoc.exe`;

// ─────────────── 基础 IO ───────────────

export function ensureDirs() {
  for (const d of [DATA_DIR, TASKS_DIR]) fs.mkdirSync(d, { recursive: true });
}
/** 读取并解析 JSON 文件；文件不存在或解析失败时返回 fallback */
export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
/** 先写临时文件再改名为目标文件，避免写入中断留下半个 JSON */
export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ─────────────── 账号 ───────────────

/** 生成密码哈希：scrypt + 随机 salt，返回 { salt, hash } */
export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
/** 校验密码：按同一 salt 重算 scrypt 后用定长比较，避免比较耗时泄露信息 */
export function verifyPassword(password, salt, hash) {
  const h = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'));
}

/** 读取全部账号 */
export function listUsers() { return readJson(USERS_FILE, []); }
/** 保存全部账号 */
export function saveUsers(u) { writeJson(USERS_FILE, u); }

/**
 * 创建账号并落盘。
 * @param {{username: string, password: string, name?: string, role?: string}} o 账号信息
 * @returns {object} 新账号记录（含 salt / hash）
 * @throws {Error} 用户名重复、用户名为空或密码长度不足时抛出
 */
export function createUser({ username, password, name, role = 'user' }) {
  const users = listUsers();
  if (users.some(u => u.username === username)) throw new Error('用户名已存在');
  // 建号同样校验密码强度：此前只有改密码接口做校验，建号接口可创建长度为 1 的密码；
  // 能被绕过的校验等于没有校验，属于最低等级的安全缺陷。
  const pw = String(password || '');
  if (pw.trim().length < 6) throw new Error('密码至少 6 位（且不能全是空格）');
  if (!String(username || '').trim()) throw new Error('用户名不能为空');
  const { salt, hash } = hashPassword(pw);
  const u = {
    id: 'u' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
    username, name: name || username, role, salt, hash,
    createdAt: new Date().toISOString(), disabled: false, defaultPassword: true,
    // 报告分类权限：true = 可查看深度类（逻辑/结论/建议）；管理员恒为 true
    deepAccess: role === 'admin',
    // 费用额度（元）：0 表示不限。
    // 额度按金额而非次数计量：报告长度、问题数量、工作量差异很大，
    // 按"每天 3 次"计量时，一份 8 万字报告与一份 3 千字短报告计费相同，
    // 长报告偏多、短报告偏少。按实际 API 费用扣减可与真实用量一致。
    budget: role === 'admin' ? 0 : DEFAULT_BUDGET,
  };
  users.push(u); saveUsers(users);
  return u;
}

/**
 * 首次启动时创建管理员账号（仅在无任何账号时执行）。
 * @returns {{username: string, password: string}|null} 新建账号的初始口令；已有账号时返回 null
 */
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
// 两份数据职责不同，不可混用：
//   · sessions.json     —— 当前有效会话。登出即删，7 天自动过期，用于判断"谁在线"。
//   · login-history.json —— 登录审计流水。只增不删（保留最近 N 条），
//                           登录/登出/登录失败各记一条，用于回答"某账号何时使用过系统"。
//
// 分开存储的原因：此前只有 sessions.json，登出即删除记录，
// "该账号最近是否登录过"一类问题无法追溯。

export const LOGIN_HISTORY_FILE = path.join(DATA_DIR, 'login-history.json');
const LOGIN_HISTORY_MAX = 3000;      // 保留最近 3000 条，避免无限增长

/** 在线判定窗口：最近一次活动距今小于该值时计为在线 */
export const ONLINE_WINDOW_MS = 5 * 60 * 1000;

const clientMeta = (req) => req ? {
  ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket?.remoteAddress || '',
  ua: String(req.headers['user-agent'] || '').slice(0, 200),
} : { ip: '', ua: '' };

/**
 * 创建会话并写入 sessions.json，同时清理已过期会话。
 * @param {string} userId 账号 id
 * @param {object} req HTTP 请求，用于记录来源 IP 与 UA
 * @returns {string} 新会话 id
 */
export function createSession(userId, req) {
  const sid = crypto.randomBytes(24).toString('hex');
  const s = readJson(SESSIONS_FILE, {});
  const now = Date.now();
  const meta = clientMeta(req);
  s[sid] = { userId, createdAt: now, lastSeenAt: now, ip: meta.ip, ua: meta.ua };
  // 登录时按 getSession 的同一套规则清掉已过期会话，避免 sessions.json 持续增长
  for (const [k, v] of Object.entries(s)) if (sessionExpired(v, now)) delete s[k];
  writeJson(SESSIONS_FILE, s);
  return sid;
}

/**
 * 判定会话是否过期：空闲超时或超过绝对上限即为过期。
 *
 * 2026-09-27 起服务端开始校验时间，此前仅由客户端 Cookie 决定。
 *   · 空闲超时 SESSION_IDLE_MS（默认 12 小时无请求）判定过期；
 *   · 绝对上限 SESSION_MAX_MS（默认 7 天），限制 sid 泄露后的可用时长。
 * 浏览器端使用会话 Cookie（不写 Max-Age），关闭浏览器即失效，
 * 对应"下次打开网址需要重新登录"的要求。
 * 服务端必须独立判定：Cookie 由客户端持有，攻击者取得 sid 后可自行构造请求，
 * 浏览器何时丢弃 Cookie 不受服务端控制。
 */
export const SESSION_IDLE_MS = Number(process.env.WB_SESSION_IDLE_MS || 12 * 60 * 60 * 1000);
export const SESSION_MAX_MS = Number(process.env.WB_SESSION_MAX_MS || 7 * 864e5);

/** 一条会话记录是否已过期（空闲超时或超过绝对上限） */
export function sessionExpired(rec, now = Date.now()) {
  if (!rec) return true;
  const created = rec.createdAt || 0;
  const seen = rec.lastSeenAt || created;
  if (!created) return true;
  if (now - seen > SESSION_IDLE_MS) return true;
  if (now - created > SESSION_MAX_MS) return true;
  return false;
}

/** 只读地取会话记录（不更新活动时间），用于审计查询 */
export function getSessionRecord(sid) {
  if (!sid) return null;
  return readJson(SESSIONS_FILE, {})[sid] || null;
}

/**
 * 取会话对应的用户，并刷新最近活动时间。
 *
 * 每个请求都会调用，因此刷新做节流：距上次不足 60 秒时不落盘，
 * 否则高频轮询会持续写入 sessions.json。
 * 过期判定必须在本函数内完成，不能只在登录时清理：此处是会话是否失效的唯一判定点，
 * 置于此处才能保证长期未使用的会话真正失效（此前的表现为隔很久打开网址仍为登录态）。
 */
export function getSession(sid) {
  if (!sid) return null;
  const s = readJson(SESSIONS_FILE, {});
  const rec = s[sid];
  if (!rec) return null;
  const now = Date.now();
  if (sessionExpired(rec, now)) {          // 过期即删除记录，不再保留
    delete s[sid];
    writeJson(SESSIONS_FILE, s);
    return null;
  }
  const user = listUsers().find(u => u.id === rec.userId && !u.disabled);
  if (!user) return null;
  if (!rec.lastSeenAt || now - rec.lastSeenAt > 60000) {
    rec.lastSeenAt = now;
    s[sid] = rec;
    writeJson(SESSIONS_FILE, s);
  }
  return user;
}

/** 删除会话；返回被删除的记录，会话不存在时返回 null */
export function destroySession(sid) {
  if (!sid) return null;
  const s = readJson(SESSIONS_FILE, {});
  const rec = s[sid];
  delete s[sid];
  writeJson(SESSIONS_FILE, s);
  return rec || null;
}

/** 追加一条登录审计流水（可带 mac：仅作核对参考，不参与访问控制） */
export function recordAuthEvent({ userId = '', name = '', event = 'login', req = null, note = '', mac = '' } = {}) {
  const list = readJson(LOGIN_HISTORY_FILE, []);
  const meta = clientMeta(req);
  list.push({
    at: new Date().toISOString(),
    userId, name, event,          // login | logout | fail
    ip: meta.ip, ua: meta.ua, note,
    ...(mac ? { mac } : {}),
  });
  writeJson(LOGIN_HISTORY_FILE, list.slice(-LOGIN_HISTORY_MAX));
}

/**
 * 删除指定时间点之后写入的审计事件，供自检脚本收尾使用。
 *
 * 用途：test-login-guard 会故意连续输入错误密码以验证锁定与验证码，
 * 因此必然向审计流水写入多条 fail 记录。不清理时，审计中会长期保留
 * "某账号登录失败 257 次"这类失实记录（经实测出现，曾被误判为暴力破解）。
 *
 * 仅按时间戳圈定范围，只删除该时间段内的记录，不影响更早的真实记录。
 * 本函数不做权限校验，仅供本机自检脚本直接调用，不得暴露到 HTTP。
 */
export function removeAuthEventsSince(sinceMs) {
  const list = readJson(LOGIN_HISTORY_FILE, []);
  const kept = list.filter(x => new Date(x.at).getTime() < sinceMs);
  const removed = list.length - kept.length;
  writeJson(LOGIN_HISTORY_FILE, kept);
  return removed;
}

/** 登录审计流水（可按用户过滤） */
export function listAuthEvents({ userId = '', limit = 200 } = {}) {
  const list = readJson(LOGIN_HISTORY_FILE, []);
  const filtered = userId ? list.filter(x => x.userId === userId) : list;
  return filtered.slice(-limit).reverse();      // 最近的在前
}

/**
 * 当前在线与近期会话列表（管理员使用）。
 *
 * 只返回账号仍存在的会话：账号删除后的会话为死会话（getSession 也取不到），
 * 保留只会让"谁在使用"列表多出一行无效记录。
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

/** 清除账号已不存在的死会话（启动时或删除账号后调用） */
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

// ─────────────── 在线人数与峰值（数据看板 → 一、审核次数与用量；仅管理员）───────────────
//
// 2026-09-28 起管理员看板提供「目前在线人数」与「最高在线人数」两项。
// 口径：人数 = 去重后的账号数（与提交页"谁在使用"中的"在线 N 人"一致）；
//      在线 = 最近一次活动在 ONLINE_WINDOW_MS（5 分钟）内，与列表口径完全一致，
//      否则同一屏上两个数字会互相矛盾。
//
// 峰值必须持久化才有意义：此前只计算当前在线数、不保留历史，无法回答"最高多少"。
// 统计结果写入 online-stats.json：
//   · peak / peakAt        —— 历史最高值及其发生时间
//   · day / dayPeak        —— 北京时间当日的最高值（跨零点重新计数）
//   · lastSample / samples —— 最近一次采样值与累计采样次数（用于判断数据是否在更新）
// 采样点：服务端每分钟一次 + 每次登录 + 每次看板请求（见 server.mjs），
// 因此峰值最多滞后一分钟；采样值只升不降，掉线不会拉低峰值。
export const ONLINE_STATS_FILE = path.join(DATA_DIR, 'online-stats.json');

/** 北京时间（UTC+8）日期串 YYYY-MM-DD，与全系统其它按天口径一致 */
export function bjDayOf(at = Date.now()) {
  return new Date(at + 8 * 3600e3).toISOString().slice(0, 10);
}

/** 当前在线人数（去重账号数）+ 明细 */
export function onlineNow() {
  const list = listActiveSessions();
  const onlineUsers = new Set(list.filter(x => x.online).map(x => x.userId));
  return { count: onlineUsers.size, sessions: list.filter(x => x.online).length, users: [...onlineUsers] };
}

/**
 * 记录一次在线人数采样，返回最新统计。
 *
 * 峰值只升不降：仅当本次采样高于历史最高值时才更新峰值并记录时间。
 */
export function recordOnlineSample(count, at = Date.now()) {
  const st = readJson(ONLINE_STATS_FILE, {});
  const day = bjDayOf(at);
  const next = {
    peak: Number(st.peak) || 0,
    peakAt: st.peakAt || '',
    day: st.day || day,
    dayPeak: Number(st.dayPeak) || 0,
    dayPeakAt: st.dayPeakAt || '',
    lastSample: Number(st.lastSample) || 0,
    lastSampleAt: st.lastSampleAt || '',
    samples: Number(st.samples) || 0,
  };
  if (next.day !== day) { next.day = day; next.dayPeak = 0; next.dayPeakAt = ''; }   // 跨天：今日峰值归零
  if (count > next.peak) { next.peak = count; next.peakAt = new Date(at).toISOString(); }
  if (count > next.dayPeak) { next.dayPeak = count; next.dayPeakAt = new Date(at).toISOString(); }
  next.lastSample = count;
  next.lastSampleAt = new Date(at).toISOString();
  next.samples += 1;
  writeJson(ONLINE_STATS_FILE, next);
  return next;
}

/** 读取在线统计（不采样，供界面使用） */
export function readOnlineStats() {
  const st = readJson(ONLINE_STATS_FILE, {});
  const day = bjDayOf();
  return {
    peak: Number(st.peak) || 0,
    peakAt: st.peakAt || '',
    // 跨天后文件中的 dayPeak 属于前一天，今日峰值显示为 0（待下一次采样写入当天数据）
    dayPeak: (st.day === day) ? (Number(st.dayPeak) || 0) : 0,
    dayPeakAt: (st.day === day) ? (st.dayPeakAt || '') : '',
    lastSample: Number(st.lastSample) || 0,
    lastSampleAt: st.lastSampleAt || '',
    samples: Number(st.samples) || 0,
    onlineWindowMin: ONLINE_WINDOW_MS / 60000,
  };
}

/**
 * 清除已停用账号的会话。
 *
 * 停用需立即生效：否则该账号浏览器中的 Cookie 在 7 天自然过期前仍然可用，
 * 停用操作不产生实际效果。
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

/** 将 UA 压缩为简短描述，避免把完整字符串直接展示给管理员 */
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
// 威胁模型（决定防护手段的选择）：
//   本系统仅内网可达（防火墙限 192.0.0.0/16），外部自动化程序无法访问。
//   实际攻击面为：内部人员的恶意尝试、使用方终端上的恶意软件、有内网权限的外协人员。
//   对这类攻击者最有效的手段不是爆破，而是密码喷洒 —— 用同一常见密码遍历所有账号；
//   本系统用户名即本人姓名（通讯录可查），因此该手段成功率较高。
//
// 防线优先级：
//   ① 限流（按账号 + 按来源 IP）：直接阻断高频尝试，正常用户无感知
//   ② 阶梯验证码：仅在连续失败后出现，正常用户不会遇到；自托管，不依赖外网
//   ③ 失败加重延迟：把机器速度从 40 次/秒压到 1 次/秒
//
// 不首选图形验证码的原因：Google reCAPTCHA 在本机网络下不可达（经实测），
//   云端验证码加载失败会导致全员无法登录；自建扭曲文字对多模态模型基本无效，
//   引入后只会造成"已防护"的错误判断。验证码在此作为补充手段，不作为主力。

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
/** 读取登录防护状态；文件缺失时返回空状态，并清理已过期验证码 */
export function guardState() {
  const g = readJson(LOGIN_GUARD_FILE, null);
  if (!g || typeof g !== 'object') return emptyGuard();
  const norm = { ...emptyGuard(), ...g };
  // 清除已过期验证码，避免文件持续增长
  const now = Date.now();
  for (const [cid, c] of Object.entries(norm.captchas)) {
    if (!c || !c.expiresAt || c.expiresAt < now) delete norm.captchas[cid];
  }
  return norm;
}
const saveGuard = (g) => writeJson(LOGIN_GUARD_FILE, g);

/**
 * 登录前的防护状态检查，在验证密码之前调用。
 * @param {string} userId 目标账号 id
 * @param {string} ip 来源 IP
 * @returns {{locked:boolean,lockedUntil:string|null,accountFails:number,ipBlocked:boolean,
 *   ipBlockedUntil:string|null,needCaptcha:boolean,remainingAttempts:number}}
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
// 生成算术题并渲染为带干扰的 SVG：不依赖外部服务，内网断网时仍可用。
// 定位是限流之后的补充手段，不是第一道防线，因此够用即可，不追求抗 OCR。

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

/** 读取模板清单；首次调用时先写入默认模板 */
export function listTemplates() {
  const t = readJson(TEMPLATES_FILE, null);
  if (!t) { writeJson(TEMPLATES_FILE, DEFAULT_TEMPLATES); return DEFAULT_TEMPLATES; }
  return t;
}
/** 保存模板清单 */
export function saveTemplates(t) { writeJson(TEMPLATES_FILE, t); }

// ─────────────── 项目类型（看板分类维度）───────────────
// 由 S0 预审从报告内容自动识别；本清单为合法取值，管理员可在「系统管理」中增删改。
// 「其他/未分类」为固定保底项，不允许删除。

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

/** 读取项目类型清单，并保证保底项存在 */
export function listProjectTypes() {
  const t = readJson(PROJECT_TYPES_FILE, null);
  const arr = Array.isArray(t) && t.length ? t : DEFAULT_PROJECT_TYPES;
  if (!t) writeJson(PROJECT_TYPES_FILE, DEFAULT_PROJECT_TYPES);
  // 保底项必须存在
  if (!arr.some(x => x.name === FALLBACK_PROJECT_TYPE)) {
    arr.push({ id: 'pt-other', name: FALLBACK_PROJECT_TYPE, enabled: true, keywords: [], locked: true });
  }
  return arr;
}
/** 保存项目类型清单 */
export function saveProjectTypes(t) { writeJson(PROJECT_TYPES_FILE, t); }

/** 把模型返回的类型名对齐到清单；无法对齐时按关键词回退，仍无法判定则归入「其他/未分类」 */
export function normalizeProjectType(raw) {
  const types = listProjectTypes();
  const s = String(raw || '').trim();
  const hit = types.find(x => x.name === s);
  if (hit) return hit.name;
  // 模糊匹配：包含关系也视为命中（模型可能写「装备购置类可研」）
  const fuzzy = types.filter(x => x.name !== FALLBACK_PROJECT_TYPE)
    .find(x => s && (s.includes(x.name) || x.name.includes(s)));
  return fuzzy ? fuzzy.name : null;   // null 表示未识别，交由关键词回退处理
}

/** 关键词回退识别：从项目名称 / 报告文件名 / 报告类型中匹配 */
export function guessProjectType(...texts) {
  const blob = texts.filter(Boolean).join(' ');
  if (!blob) return FALLBACK_PROJECT_TYPE;
  // 先匹配「后评价」类，避免「产能」抢先命中「产能后评价」
  const ordered = listProjectTypes().filter(x => x.name !== FALLBACK_PROJECT_TYPE);
  let best = null, bestScore = 0;
  for (const t of ordered) {
    let score = 0;
    for (const k of (t.keywords || [])) if (blob.includes(k)) score += k.length;
    // 「后评价」类加分，避免被判为同名的可研类
    if (t.name.includes('后评价') && blob.includes('后评价')) score += 3;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best ? best.name : FALLBACK_PROJECT_TYPE;
}

/** 看板分类顺序：按清单顺序，保底项排在最后 */
export function projectTypeOrder() {
  return listProjectTypes().filter(x => x.enabled !== false).map(x => x.name);
}

// ─────────────── 报告类型（决定审核维度与判定标准）───────────────
// 报告类型不再手工选择；由 S0 预审从报告内容识别，识别失败时回退到文件名关键词。

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
  // 模型可能只返回「后评价」「可研」这类简称，再按关键词回退一次
  return guessBizType(s);
}

/** 关键词回退识别报告类型（可传入文件名 / 报告名 / 正文开头） */
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

/**
 * 「本次审核重点」可选清单（提交页复选框与服务端白名单共用同一份）。
 *
 * 前后端各维护一份会产生差异，因此只在此处定义：前端渲染复选框时从 /api/me 获取
 * （见 me 接口），服务端接收提交时用它做白名单过滤 —— 不在清单内的值直接丢弃，
 * 防止构造请求注入任意提示词。
 */
export const REVIEW_FOCUS_OPTIONS = [
  '经济评价正确性',
  '结论全面性',
  '建议针对性',
  '数据正确性',
  '投资与工程量核对',
  '标准规范符合性',
  '风险分析充分性',
  '图表与正文一致性',
  '格式与编校规范性',
];

/** 补充要求文本上限：足够写一段具体要求，同时限制提示词长度（也用于防滥用） */
export const REVIEW_NOTE_MAX = 1500;

/**
 * 解析提交请求头中的「本次审核重点」。
 *
 * 权限判定在服务端：仅管理员可生效。前端不显示该对话框，但接口为公开接口，
 * 任何调用方都可以自行构造请求并带上这两个头，不能只依赖界面不可见。
 * 勾选项按白名单过滤（不在 REVIEW_FOCUS_OPTIONS 内的一律丢弃），
 * 否则等同于提供向系统提示词插入任意文本的入口。
 *
 * @param {{focusHeader?: string, noteHeader?: string, isAdmin?: boolean}} o
 * @returns {{reviewFocus: string[], reviewNote: string}}
 */
export function parseReviewFocus({ focusHeader = '', noteHeader = '', isAdmin = false } = {}) {
  if (!isAdmin) return { reviewFocus: [], reviewNote: '' };
  let focus = [];
  try {
    focus = decodeURIComponent(String(focusHeader || '')).split(',').map(s => s.trim()).filter(Boolean);
  } catch { focus = []; }        // 头部编码异常时按未填写处理，避免整个提交失败
  const reviewFocus = [...new Set(focus)].filter(x => REVIEW_FOCUS_OPTIONS.includes(x));
  let reviewNote = '';
  try { reviewNote = decodeURIComponent(String(noteHeader || '')).trim(); } catch { reviewNote = ''; }
  if (reviewNote.length > REVIEW_NOTE_MAX) reviewNote = reviewNote.slice(0, REVIEW_NOTE_MAX);
  return { reviewFocus, reviewNote };
}

/** 任务目录路径 */
export function taskDir(id) { return path.join(TASKS_DIR, id); }
/** 生成任务 id：T + 日期 + 随机串 */
export function newTaskId() { return 'T' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + crypto.randomBytes(3).toString('hex'); }

/**
 * 处于处理中的任务状态集合。
 * waiting —— 预处理（本地文档转换）已完成，等待空闲时段再调用 AI（闲时调用模式）。
 */
export const ACTIVE_STATES = ['queued', 'converting', 'waiting', 'auditing'];

/** 读取任务元数据；任务不存在时返回 null */
export function getTask(id) { return readJson(path.join(taskDir(id), 'meta.json'), null); }
/** 保存任务元数据 */
export function saveTask(t) { writeJson(path.join(taskDir(t.id), 'meta.json'), t); }

/** 读取全部任务，按创建时间倒序 */
export function listTasks() {
  if (!fs.existsSync(TASKS_DIR)) return [];
  return fs.readdirSync(TASKS_DIR)
    .map(id => getTask(id)).filter(Boolean)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

/**
 * 追加一条进度记录。
 *
 * 写回以磁盘上的最新状态为准，不使用调用方持有的 task 对象。
 * 原因：runTask 将 task 读入内存后会长时间持有，期间调用方可能在其它请求中取消任务；
 * 若每条进度都用旧对象整体覆盖，cancelled 状态会被改回处理中，表现为"已取消仍在运行"。
 * 合并到磁盘上的最新副本可避免覆盖状态类字段。
 *
 * 磁盘上不存在该任务时直接跳过，不写回。
 * 早先的实现为 `getTask(task.id) || task`，文件被删除（管理员删除任务或测试清理）后
 * 会退回内存中的旧对象整体写回，导致已删除的任务重新出现。
 * 现象：删除任务后一段时间它又出现在台账中（经实测出现两次，曾被误认为存在待处理任务）。
 */
export function appendProgress(task, msg) {
  const cur = getTask(task.id);
  if (!cur) return task;            // 任务已删除，丢弃本次进度，不重新写入
  cur.progress = cur.progress || [];
  cur.progress.push({ t: new Date().toISOString(), msg });
  if (cur.progress.length > 300) cur.progress = cur.progress.slice(-300);
  saveTask(cur);
  return cur;
}

// ─────────────── PPT 暂存区 ───────────────
//
// 需要暂存的原因：一致性核对要求 PPT 与报告在同一任务中处理（输出一份 PPT 优先的成果）。
// 上传协议为一次请求一个文件，因此先暂存 PPT 并取得 id，创建任务时带上该 id，
// 任务创建即同时持有两个文件 —— 无需"等待第二个文件"的挂起状态，
// 也就不存在"上传中途离开导致任务永久挂起"的风险。
//
// 暂存的另一作用：PPT 转换耗时较长（.ppt 可能超过 40 秒）且可能内容不足，
// 在暂存阶段完成转换并把质量指标返回前端，提交前即可看到"该 PPT 以图片为主"的提示。

export const PPT_STASH_DIR = path.join(DATA_DIR, 'ppt-stash');
const STASH_TTL_MS = 2 * 60 * 60 * 1000;      // 暂存 2 小时后自动清理

/** 清理过期暂存（在暂存新文件时执行，无需单独设定时器） */
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

/** 校验暂存 id 格式后返回暂存目录路径（id 来自客户端，必须校验） */
export function stashDir(id) {
  // 暂存 id 由服务端生成，但接口收到的值来自客户端，拼接路径前必须校验格式。
  // 否则 `/api/tasks/ppt-only` 传入 stashId=../xxx 可读取其它目录（仅读 meta.json，风险有限，
  // 但没有理由保留该入口）。newStashId() 生成 P+base36，必定落在允许字符集内。
  const safe = String(id || '');
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(safe)) throw new Error('暂存标识不合法');
  return path.join(PPT_STASH_DIR, safe);
}
/** 生成暂存 id：P + base36 时间戳 + 随机串 */
export function newStashId() { return 'P' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); }
/** 读取暂存元数据；不存在或 id 非法时返回 null */
export function getStash(id) {
  if (!id) return null;
  try { return readJson(path.join(stashDir(id), 'meta.json'), null); } catch { return null; }
}
/** 保存暂存元数据 */
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

// ─────────────── 文档转换 ───────────────

/** 判定文档类别：报告（Word）/ 汇报材料（PPT） */
export function docKind(nameOrPath) {
  const e = path.extname(String(nameOrPath || '')).toLowerCase();
  if (e === '.ppt' || e === '.pptx') return 'ppt';
  if (e === '.doc' || e === '.docx') return 'doc';
  return 'other';
}

/**
 * 提交预检：收到的 Office 文件是不是一个完整可解析的包。
 *
 * 为什么需要（经实测，2026-10-08 变配电后评价报告）：`T20261008-2c1153` 提交后 3 秒即失败，
 * markitdown 报错、pandoc 回退报 `couldn't unpack docx container: Did not find end of central
 * directory signature` —— 该 .docx 不是有效 ZIP 容器（上传被截断／`.doc` 改名／保存损坏）。
 * 这类文件以前会先排队、跑到提取阶段才失败，使用方只看到一行英文报错且不知如何处置。
 * 现在在接收字节时当场判定并给出可操作的中文提示，坏文件不进队列。
 *
 * 判定依据：.docx/.pptx 是 ZIP 包 —— 需 PK 开头、尾部有中央目录结束记录（EOCD，落在末尾 64KB 内），
 * 且中央目录里含对应部件（docx 含 `word/document.xml`，pptx 含 `ppt/presentation.xml`）。
 * 另对最常见的"假 docx"给出针对性提示：老式 OLE（.doc/.ppt 改名）、RTF、PDF。
 *
 * @param {Buffer|Uint8Array} buf 上传的原始字节
 * @param {string} name 文件名（用于判断期望是 docx 还是 pptx）
 * @returns {{ok:boolean, code:string, error:string}} code：ok / empty / legacy / rtf / pdf / broken-zip / wrong-kind
 */
export function checkOfficeContainer(buf, name = '') {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (!b.length) return { ok: false, code: 'empty', error: '文件内容为空，请重新上传' };
  const head = b.subarray(0, 8);
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) {
    return { ok: false, code: 'legacy', error: '这是老式 Office 文件（.doc/.ppt），不是 .docx/.pptx —— 请在 Word 里「另存为」.docx 后再上传' };
  }
  const magic = b.subarray(0, 5).toString('latin1');
  if (magic === '{\\rtf') return { ok: false, code: 'rtf', error: '这是 RTF 文本，不是 .docx —— 请另存为 .docx 后再上传' };
  if (magic === '%PDF-') return { ok: false, code: 'pdf', error: '这是 PDF 文件，不是可编辑的 .docx —— 请上传 Word 原件' };
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  const tail = b.subarray(Math.max(0, b.length - 65536));
  const hasEocd = tail.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (!isZip || !hasEocd) {
    return { ok: false, code: 'broken-zip', error: '文件不是完整的 Office 包（上传可能被截断，或文件已损坏）—— 请在 Word 里打开并「另存为」一份新的 .docx 后重传' };
  }
  const kind = docKind(name);
  const part = kind === 'ppt' ? 'ppt/presentation.xml' : 'word/document.xml';
  if (!b.includes(Buffer.from(part))) {
    return {
      ok: false, code: 'wrong-kind',
      error: `文件扩展名与实际内容不符（包里找不到 ${part}）—— 请确认上传的确实是 .${kind === 'ppt' ? 'pptx' : 'docx'} 文件`,
    };
  }
  return { ok: true, code: 'ok', error: '' };
}
export const ACCEPTED_EXT = ['.docx', '.doc', '.pptx', '.ppt'];

/**
 * PPT 提取质量的判定阈值。
 *
 * 用途：工程汇报 PPT 中大量图表以截图形式嵌入，markitdown 只提取文字与表格、不做 OCR，
 * 因此这类 PPT 的提取结果几乎没有内容。
 * 经实测：一份 16.5MB 的纯截图 PPTX 仅提取到 1,609 字符；
 *         一份 16.6MB 的文字型 PPT 提取到 29,786 字符 / 143 页。
 * 两者相差 18 倍，因此必须识别出内容不足的情况并如实告知，不能按已审核处理。
 */
export const PPT_MIN_CHARS = 3000;        // 少于这个字符数认为内容不足
export const PPT_MIN_CHARS_PER_SLIDE = 60; // 每页少于这个字符数也认为偏少

/** 评估 PPT 提取结果是否够用 */
export function pptTextQuality(text, slides) {
  const chars = String(text || '').length;
  const perSlide = slides > 0 ? Math.round(chars / slides) : 0;
  const enough = chars >= PPT_MIN_CHARS && perSlide >= PPT_MIN_CHARS_PER_SLIDE;
  // 图片占位符密度：数值越高说明该 PPT 以截图为主
  const imgMarkers = (String(text || '').match(/!\[[^\]]*\]\([^)]*\)|\[图片\]/g) || []).length;
  const imgRatio = chars > 0 ? Math.min(1, imgMarkers / Math.max(1, slides)) : 0;
  return { chars, slides, perSlide, imgMarkers, imgRatio, enough };
}

/**
 * 把上传的文档转为 markdown 文本。
 * @param {string} srcPath 源文件路径（docx / doc / pptx / ppt）
 * @param {(msg: string) => void} [onLog] 进度回调
 * @returns {Promise<object>} 转换结果（text / tables / engine / slides / quality / images 等）
 */
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
    // .ppt 为二进制旧格式，markitdown 无法解析，必须先转为 pptx。
    // 经实测 16.6MB 的 .ppt 转换约需 54 秒，耗时长但为本地免费操作，界面需提示等待。
    onLog('检测到 .ppt（老格式），先用 LibreOffice 转换为 .pptx…（大文件可能要 1~2 分钟）');
    const outDir = path.dirname(srcPath);
    await run(SOFFICE, ['--headless', '--convert-to', 'pptx', '--outdir', outDir, srcPath], 600000);
    const cand = path.join(outDir, path.basename(srcPath, ext) + '.pptx');
    if (!fs.existsSync(cand)) throw new Error('.ppt 转换失败（未生成 .pptx）');
    work = cand;
  } else if (ext !== '.docx' && ext !== '.pptx') {
    throw new Error(`仅支持 ${ACCEPTED_EXT.join(' / ')}，收到 ${ext}`);
  }

  // 提取正文：优先用 markitdown（表格还原更好），但经实测会偶发崩溃（exit 3221225477 访问冲突），
  // 因此增加一次重试。Word 失败时回退到 pandoc（原生二进制更稳定）；
  // PPT 不能使用 pandoc —— 它不解析 pptx 的幻灯片结构，输出为无页码的连续文本，无法定位问题。
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

  // 剥离图片，避免 base64 内容挤占上下文。
  //
  // 此前的正则只匹配空 alt 的 ![](data:image/...)，带 alt 的全部漏过 ——
  //    经实测一份报告漏过 102 处（![IMG_256](...) / ![企业微信截图_xxx](...)），
  //    这些 base64 内容直接进入正文，既消耗 token 又干扰判断。
  //    现改为 [^\]]*，空与非空 alt 一并剥离。
  //  另一处边界：markitdown 会把超长 data URI 截断（逗号消失，仅剩 base64 片段），
  //    因此正则中的 `;base64,` 不能写死逗号，必须用 `;base64[^)]*`，否则无法命中。
  //
  // alt 文本本身是有价值的信息（"甲级资信证书""企业微信截图"），
  //   因此不再统一替换为 [图片]，而是保留为 [图片：xxx]，
  //   截图类单独标记为 [截图：xxx] —— 模型可据此知道该位置原有图片内容，
  //   也能让"截图类附件页"变得可见（此前无任何标记）。
  const shotOf = (alt) => /截图|screenshot|screen\s*shot|微信|QQ|照片|扫描|img_?\d+/i.test(alt || '');
  const before = text.length;
  // PPT 用 <!-- Slide number: N --> 标记页，同时统计页数供内容充足性判定使用
  const slides = kind === 'ppt' ? (text.match(/<!--\s*Slide number:\s*\d+\s*-->/g) || []).length : 0;
  let imgKept = 0;
  text = text
    .replace(/!\[([^\]]*)\]\(data:image\/[a-z+]+;base64[^)]*\)/g, (_m, alt) => {
      imgKept++;
      const a = String(alt || '').trim();
      if (!a) return '[图片]';
      return shotOf(a) ? `[截图：${a.slice(0, 40)}]` : `[图片：${a.slice(0, 40)}]`;
    })
    .replace(/<img[^>]*>/gi, '[图片]')
    .replace(/!\[([^\]]*)\]\([^)]*media\/[^)]*\)/g, (_m, alt) => {
      imgKept++;
      const a = String(alt || '').trim();
      return a ? `[图片：${a.slice(0, 40)}]` : '[图片]';
    });
  // ── 表格结构整理（合并单元格）──
  // 经实测：一份报告的 106 个表格块中有 46 块列数不一致（43%），另有 61 行为整行空单元格。
  // 根因是 Word 的合并单元格，markitdown 导出时表现为：
  //   · 跨列合并 → 该行缺少若干 "|"
  //   · 多级表头（上一级跨列）→ 表头占两行，各行列数不同
  //   · 被合并吞掉的单元格 → 整行只剩 "| | | |"
  // 后果：模型无法判断某个数值属于哪一列，会误读数据，甚至导致 JSON 输出异常。
  //
  // 处理分三步（保守处理，不改动数值）：
  //   ① 删除整行空单元格的行（纯噪声，无信息）
  //   ② 对列数不一致的表块加一行标记，提示模型该表结构不规整
  //   ③ 统计结果，供上层写入日志与提示词
  {
    const lines = text.split('\n');
    const out = [];
    let i = 0, ragged = 0, blankDropped = 0, tableCount = 0;
    while (i < lines.length) {
      if (!/^\s*\|/.test(lines[i])) { out.push(lines[i]); i++; continue; }
      const start = i;
      while (i < lines.length && /^\s*\|/.test(lines[i])) i++;
      let blk = lines.slice(start, i);

      // ① 去掉整行空单元格（"| | | |" 这种，合并后被吞掉的格子）
      const before = blk.length;
      blk = blk.filter(l => !/^\s*\|(\s*\|){1,}\s*$/.test(l));
      blankDropped += before - blk.length;
      if (blk.length < 2) { out.push(...blk); continue; }
      tableCount++;

      // ② 列数一致性
      const cols = blk.map(l => (l.match(/\|/g) || []).length);
      const uniq = [...new Set(cols)];
      if (uniq.length > 1) {
        ragged++;
        // 只加标记，不改表格本身 —— 改列数有把数据挪错位的风险
        out.push(`<!-- 表格结构提示：本表由 Word 合并单元格导出，列数不规整（${uniq.join('/')} 列），表头可能是多级的。判断"某数值属于哪一列"时务必谨慎，无法确定请存疑而非猜测。 -->`);
      }
      out.push(...blk);
    }
    text = out.join('\n');
    if (ragged || blankDropped) {
      onLog(`表格结构整理：${tableCount} 张表，其中 ${ragged} 张列数不规整（合并单元格），清理空行 ${blankDropped} 行`);
    }
    var tableRagged = ragged;   // 供返回值使用
  }

  const tables = (text.match(/^\s*\|/gm) || []).length;
  const shots = (text.match(/\[截图：/g) || []).length;   // 截图类图片数（内容不可读）
  onLog(`转换完成（引擎 ${engine}）：${text.length.toLocaleString()} 字符（图片 ${imgKept} 张，其中截图 ${shots} 张内容不可读；剥离 ${(before - text.length).toLocaleString()} 字符），表格行 ${tables}`
    + (kind === 'ppt' ? `，幻灯片 ${slides} 页` : ''));

  const quality = kind === 'ppt' ? pptTextQuality(text, slides) : null;
  if (quality && !quality.enough) {
    // 明确指出不达标的具体条件，避免输出"每页 101 字，低于 60 字"这类自相矛盾的提示
    const why = quality.chars < PPT_MIN_CHARS
      ? `全篇只有 ${quality.chars.toLocaleString()} 个字，低于 ${PPT_MIN_CHARS.toLocaleString()} 字的可用下限`
      : `平均每页约 ${quality.perSlide} 字，低于 ${PPT_MIN_CHARS_PER_SLIDE} 字的可用线`;
    onLog(`⚠️ 这份 PPT 以图片为主（共 ${slides} 页，${why}）。`
      + '系统不做图片 OCR，图片里的文字和表格看不见，只能做有限的校对，内容级的一致性核对无法进行。');
  }
  return { text, tables, mdPath, engine, kind, slides, quality, images: imgKept, shots, raggedTables: tableRagged };
}

/**
 * 从 Office 文件（.docx / .pptx）中抽取图片，供「图表核对」使用。
 *
 * 自行解析 zip 的原因：
 *   · 不为读取少量图片引入 npm 依赖（本项目维护零依赖）
 *   · PowerShell 的 ZipFile 仅在 Windows 可用，迁移到 Linux 需要改写
 *   · ZIP 格式足够简单：中央目录 + 各项本地头，用 node:zlib 解压即可
 *
 * 图片格式限制（经实测确认）：
 *   视觉模型仅支持 JPEG / PNG / GIF / WebP；Word 中的矢量图（.emf / .wmf）不支持，
 *   而 Excel 图表粘贴进 Word 后通常就是 EMF —— 这部分只能跳过并如实告知，不能按已核对处理。
 *
 * @param {string} filePath Office 文件路径
 * @param {string} outDir 图片输出目录
 * @param {{maxCount?: number, maxBytes?: number}} [opts] 张数与总体积上限
 * @returns {{images: Array<{name: string, path: string, bytes: number, mime: string}>,
 *   skipped: Array<{name: string, ext: string, bytes: number}>, total: number}}
 */
export function extractOoxmlImages(filePath, outDir, { maxCount = 60, maxBytes = 24 * 1024 * 1024 } = {}) {
  const buf = fs.readFileSync(filePath);
  const OK = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

  // ① 找中央目录结束标记（EOCD，签名 0x06054b50），从尾部往前扫
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 Office 文件（找不到 zip 结束标记）');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);      // 中央目录起始偏移

  const images = [], skipped = [];
  let totalBytes = 0;

  for (let n = 0; n < count && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;      // 中央目录项签名
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;

    // 只要图片：word/media/ 或 ppt/media/
    if (!/(^|\/)(word|ppt)\/media\//.test(name)) continue;
    const ext = (name.match(/\.([A-Za-z0-9]+)$/) || [, ''])[1].toLowerCase();

    if (!OK[ext]) {
      skipped.push({ name: path.basename(name), ext, bytes: compSize });
      continue;
    }
    if (images.length >= maxCount) { skipped.push({ name: path.basename(name), ext, bytes: compSize, why: '超过张数上限' }); continue; }
    if (totalBytes + compSize > maxBytes) { skipped.push({ name: path.basename(name), ext, bytes: compSize, why: '超过体积上限' }); continue; }

    // ② 读本地头，拿到真正的数据起点（本地头的 name/extra 长度可能与中央目录不同）
    if (buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    let data;
    try {
      data = method === 0 ? raw : zlib.inflateRawSync(raw);
    } catch { skipped.push({ name: path.basename(name), ext, bytes: compSize, why: '解压失败' }); continue; }

    const out = path.join(outDir, `chart-${String(images.length + 1).padStart(2, '0')}.${ext}`);
    fs.writeFileSync(out, data);
    images.push({ name: path.basename(name), path: out, bytes: data.length, mime: OK[ext] });
    totalBytes += data.length;
  }

  return { images, skipped, total: images.length };
}

/**
 * 成果 HTML 转 PDF（调用本机 Chrome/Edge 的无头打印）。
 *
 * 不用 pandoc 输出 Word 的原因：Word 版式不可控（表格宽度、分页、字体均会变化），
 * 使用方反馈下载的 Word 版式显示效果不佳。PDF 为提交编制单位与归档的最终形态，
 * 由浏览器自身的分页引擎渲染，与页面显示一致。
 *
 * 下方 BROWSERS 为候选浏览器路径；未找到可用浏览器时抛错，调用方回退到直接下载 HTML。
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

/** 当前是否处于高峰计费时段（北京时间工作日 9:00-12:00 与 14:00-18:00，法定节假日除外） */
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
 * 「闲时调用」模式下 API 的起跑时刻。
 *
 * 规则：预处理先完成，进入空闲时段后再延后 10 分钟调用 API。
 *   · 当前已在空闲时段 → 立即调用（已是半价，无需等待）
 *   · 当前处于高峰时段 → 本段高峰结束时刻 + 10 分钟
 *
 * 仅影响 AI 调用的开始时刻，不影响本地文档预处理 —— 预处理在提交后立即执行。
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

/**
 * 按 token 用量与计费时段计算 API 费用。
 * @param {{model?: string, promptTokens?: number, completionTokens?: number,
 *   cacheHitTokens?: number, peak?: boolean}} o 用量与时段
 * @returns {number} 费用（元，保留 4 位小数）
 */
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
// 费用口径不止 API：年终需并入用工成本核算，因此把人工工时计入。
// 参照同类内部工具的做法：TCO = API 直接成本 + 人工占用成本 + 设备与运维摊销。
// 人工部分按「占用工时 × 岗位时薪」折算，为年终效益评价采用的口径。

export const COST_MODEL_FILE = path.join(DATA_DIR, 'cost-model.json');

export const DEFAULT_COST_MODEL = {
  labor: {
    submitterHourly: 60,        // 提交人（工程师）时薪 元/小时
    submitterMinutes: 3,        // 每次「准备+提交+查看结果」占用工时（分钟）
    reviewerHourly: 120,        // 审核专家（张三等）时薪 元/小时
    reviewerMinutes: 20,        // 每次「深度报告终审」占用工时（分钟）
  },
  infra: {
    serverMonthly: 0,           // 服务器/电力 月摊销（元）
    maintenanceMonthly: 0,      // 系统维护 月摊销（元）
  },
  year: new Date().getFullYear(),
};

/** 读取综合成本模型（缺项用默认值补齐） */
export function getCostModel() {
  const saved = readJson(COST_MODEL_FILE, {});
  return {
    ...DEFAULT_COST_MODEL, ...saved,
    labor: { ...DEFAULT_COST_MODEL.labor, ...(saved.labor || {}) },
    infra: { ...DEFAULT_COST_MODEL.infra, ...(saved.infra || {}) },
  };
}
/** 保存综合成本模型 */
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
// 用途：把「为节省费用将 AI 调用推迟到闲时」量化为可考核的指标 ——
//       按人、按项目统计闲时执行占比与节省金额。
// 口径：按任务实际计费时段（t.peak）归类，不按提交时刻 —— 闲时模式的任务
//       可能在高峰时段提交、在闲时执行，按执行时段统计才与账单一致。

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
 * 按闲时/忙时口径汇总任务，返回 KPI、明细与节省金额。
 *
 * @param {object[]} tasks 已按范围（本人 / 全部）过滤的任务
 * @param {{range?: string, model?: string, now?: Date, completeOnly?: boolean}} [opts]
 *   range 取 today | 7d | 30d | month | all
 *
 * 2026-09-28 排查"同屏数字不一致"时发现的第二处口径分歧：
 *    看板 KPI「API 费用合计」只统计用量记录完整的任务（残缺记录会少算费用），
 *    而 `saving.actual` 此前把残缺记录也计入，导致同一屏出现两个不同的实际费用值。
 *
 * 关键取舍：次数与费用不能使用同一个过滤条件。
 *   · 次数 / 人数 / 项目数 → 统计全部已完成任务（与 KPI「已完成审核（次）」一致，
 *     否则同一屏会出现 "30 次" 与 "25 次" 两个已完成数）；
 *   · token / 费用 / 节省金额重算 → 只统计记录完整的任务（与 KPI「API 费用合计」一致）；
 *   · 被费用口径排除的条数通过 `excludedFromCost` 返回，界面据此说明，沿用系统既有口径。
 */
export function buildPeakStats(tasks, { range = 'today', model = 'deepseek-flash', now = new Date(), completeOnly = true } = {}) {
  const { from, to } = peakRangeBounds(range, now);
  const inRange = tasks.filter(t => {
    if (t.status !== 'done') return false;
    if (!from) return true;
    const d = new Date(t.finishedAt || t.createdAt || 0);
    return d >= from && d <= to;
  });
  const isComplete = (t) => (!completeOnly || isUsageComplete(t));

  const blank = () => ({ count: 0, tokens: 0, cost: 0, users: new Set(), projects: new Set() });
  const P = blank(), O = blank();
  const byUser = new Map(), byProject = new Map();
  let excludedFromCost = 0;         // 范围内"没计入费用/token"的条数（历史记录不完整）
  let excludedCostForReference = 0; // 这些条按残缺记录算出来的钱（仅供对照，见 API 费用口径卡片）
  let completeCount = 0;            // 范围内计入费用/token 的条数（"单次平均"的分母）

  for (const t of inRange) {
    const bucket = t.peak ? P : O;
    const full = isComplete(t);
    if (!full) { excludedFromCost++; excludedCostForReference += (t.cost || 0); }
    else completeCount++;
    const tok = full ? ((t.usage?.prompt || 0) + (t.usage?.completion || 0)) : 0;
    const cost = full ? (t.cost || 0) : 0;
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

  // 按闲时价重算全部任务，与实付费用相减即闲时调度节省的金额
  // 必须与上面的费用同口径（只统计记录完整的任务），否则节省金额为两组不同任务相减的结果
  const rate = PRICING[model] || PRICING['deepseek-flash'];
  let costIfAllOffPeak = 0, costIfAllPeak = 0;
  for (const t of inRange) {
    if (!isComplete(t)) continue;
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
    // excludedFromCost：范围内未计入费用/token 的条数（历史任务用量记录不完整），
    // 界面据此说明，避免"次数 30、token 只算 25 条"被当作缺陷。
    excludedFromCost,
    excludedCostForReference: Math.round(excludedCostForReference * 100) / 100,
    completeCount,      // 计入费用/token 的条数（"单次平均费用"的分母）
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
// 分层约定：知识进 skill，逻辑进引擎。本模块的处理链路为 ——
//   人工复核意见 → 结构化经验条目（数据层，本文件）→ 生成 LEARNED.md（技能层）
//   → 引擎读取后注入审核提示。
//
// 关键约束：
//   1. Skill 原件不做任何改动。经验写入 skill 目录下独立的 LEARNED.md，
//      sync-skill.mjs 同步 WorkBuddy 原件时不会涉及该文件，两者互不干扰。
//   2. 全局经验注入 system 段（稳定前缀，保持 DeepSeek 缓存命中）；项目级经验注入 user 段
//      （user 段本身随报告变化，不影响缓存命中）。
//   3. 经验属于提示重点而非硬规则：提示中明确"与报告实际内容冲突时以内容为准"，
//      避免单条错误经验影响全局判定。

export const FEEDBACK_FILE = path.join(DATA_DIR, 'skill-feedback.json');
export const LEARNED_FILE = path.join(SKILL_DIR_LOCAL, 'LEARNED.md');

export const FEEDBACK_KINDS = [
  { key: 'false-positive', name: '误报纠正', hint: 'AI 报错但实际没问题 —— 说明为什么不算问题' },
  { key: 'miss', name: '漏报补充', hint: 'AI 没报但应该报 —— 说明该查什么、怎么判' },
  { key: 'criteria', name: '判定口径', hint: '某个类别的定级标准要调整 —— 写清新口径' },
  { key: 'wording', name: '表述与重点', hint: '审核重点或表述方式的偏好' },
];

/** 读取人工反馈经验条目 */
export function listFeedback() {
  const a = readJson(FEEDBACK_FILE, []);
  return Array.isArray(a) ? a : [];
}
/** 保存人工反馈经验条目 */
export function saveFeedback(a) { writeJson(FEEDBACK_FILE, a); }

/**
 * 返回一条经验适用的项目名列表。
 *
 * 支持一条经验关联多个项目：同类报告中多份存在同一问题，无需重复录入。
 * 旧记录只有单个 projectName 字段，此处统一为数组。
 */
export function feedbackProjects(x) {
  const arr = Array.isArray(x.projectNames) ? x.projectNames.map(s => String(s || '').trim()).filter(Boolean) : [];
  if (arr.length) return [...new Set(arr)];
  return x.projectName ? [String(x.projectName).trim()] : [];
}
/**
 * 返回一条经验适用的项目类型列表。
 *
 * 类型是"一类报告"的绑定维度，比绑定到单个具体报告更有效：
 * 经验沉淀进技能时，关注的是这类报告如何判定，而非某一份报告如何判定。
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
 * 返回一条经验生效的判定口径（可能有多条）。
 *
 * 设计：人工审核意见（opinion）是判断结果，由审核人填写；
 * 单句口径由 AI 提炼出若干候选，再由人工勾选保留 —— 因此返回数组。
 * 一条意见常包含多个独立规则（如"差异小的降级"与"影响结论的仍计 P0"），
 * 拆分为多条比合并成一句更清晰，也便于模型执行。
 */
export function feedbackLessons(x) {
  const arr = Array.isArray(x.lessons) ? x.lessons.map(s => String(s || '').trim()).filter(Boolean) : [];
  if (arr.length) return [...new Set(arr)];
  if (x.lesson && String(x.lesson).trim()) return [String(x.lesson).trim()];   // 老的单条字段
  return [];
}
/** 渲染成一行文本：多口径时逐条列出，避免合并为难以阅读的长句 */
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
    // 多条口径使用嵌套列表，不用「；」连接为一句 ——
    // 勾选出的候选本身常带 ①② 编号或分号，连接后会形成难以阅读的长句（经实测确认）。
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
    + `> ⚠️ 本文件由「石油天然气工程咨询成果智能审核平台」根据人工复核反馈自动生成，**请勿手工编辑**（下次生成会覆盖）。\n`
    + `> 生成时间：${toBeijing(generatedAt).toISOString().slice(0, 16).replace('T', ' ')}（北京时间）　`
    + `共 ${active.length} 条经验（全局 ${global.length} + 按类型 ${nType} + 指定项目 ${nProj}）\n\n`
    + `> 使用方式：这些是**审查重点提示**，来源于本单位人工复核的实际结论。\n`
    + `> 若与报告实际内容冲突，**以报告实际内容为准**，并在问题描述中说明你所采用的判定口径。\n`
    + `> 层次说明：每个小节先是全局条目；带「仅适用于…」小标题的，只在相应类型/项目的报告上生效。\n`;

  // 组织方式：先按经验类型分节（误报纠正/漏报补充/判定口径/表述偏好），
  // 节内再分「全局 → 仅某类报告 → 仅某项目」三层。
  // 早先的实现把类型级与项目级条目集中放在文件末尾，阅读方（含模型）无法区分
  // 一条经验属于"不该报"还是"必须报"—— 类型信息比作用域信息更关键。
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
 * 返回适用于某次审核的定向经验文本（由引擎注入 user 段）。
 *
 * 两个维度同时匹配：
 *   · 按报告类型（scope='type'）：一类报告的通病，主要维度
 *   · 指定项目（scope='project'）：某个项目的特殊要求
 * 两者都收集，类型经验在前（更通用），项目经验在后（更具体，可覆盖前者）。
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
// 机制：按项目累计校对类问题数，达到阈值（默认 200 项）后该项目不可再提交。
// 目的不是节省费用，而是促使提交方提高初稿质量，避免把系统当作免费校对平台反复提交。
// 与按人的费用额度互补：一个防误操作，一个防低质量反复提交。

export const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
export const SYSTEM_CONFIG_FILE = path.join(DATA_DIR, 'system.json');
export const ACCESS_LOG_FILE = path.join(DATA_DIR, 'access-log.json');   // 被拒访问的流水（管理员排查用）
export const DEFAULT_PROJECT_LIMIT = 200;

/** 系统开关（管理员可改） */
export const DEFAULT_SYSTEM_CONFIG = {
  // 项目质量配额是否真正拦截。2026-09-28: 默认只统计不拦截，观察一段时间后再决定。
  enforceProjectQuota: false,
  projectLimit: DEFAULT_PROJECT_LIMIT,
  // 重复审核：block = 识别到同一项目已被审核过则暂停并等待确认（默认）；warn = 仅提示，照常审核
  duplicateMode: 'block',
  // IP 访问控制（2026-09-28 起用于限制非授权部门的访问与调用）
  //   ipEnforce: 总开关。false = 临时关闭（一键应急放行）
  //   ipAllowlist: 全局白名单（支持 192.0.2.77 / 192.0.2.* / 192.0.2.0/24）；空 = 不限制
  //   ipExemptAdmins: 管理员豁免（默认 true，避免管理员被锁在系统外）
  //   ipExemptLocal: 本机豁免（默认 true）。范围为回环地址 + 本机网卡 IP（自动识别）
  //     + ipFreeList 中显式列出的条目，默认对 127.0.0.1 与 192.0.2.161 不做任何限制。
  //   ipFreeList: 免限制 IP（显式配置的保底项，默认空）。生产环境配置 127.0.0.1 与 192.0.2.161，
  //     即使网卡变更或自动识别失效，这两台机器仍不受限制。
  ipEnforce: true,
  ipAllowlist: [],
  ipExemptAdmins: true,
  ipExemptLocal: true,
  ipFreeList: [],
  // 「闲时/立即」选择开关（2026-09-28 起）：
  //   true（默认）＝ 普通用户与审核专家可在提交页选择调用时机；
  //   false       ＝ 不显示选择项，一律立即调用（避免误选闲时导致报告在夜间执行）。
  //   管理员不受该开关限制，保留选择权以便临时节省费用或演示。
  allowIdleChoice: true,
};

/** 追加一条"被拒访问"流水（只留最近 N 条，避免无限增长） */
export function appendAccessLog(rec, { max = 300 } = {}) {
  const list = readJson(ACCESS_LOG_FILE, []);
  list.push({ at: new Date().toISOString(), ...rec });
  writeJson(ACCESS_LOG_FILE, list.slice(-max));
  return list.length;
}
/** 读取被拒访问流水 */
export function listAccessLog() { return readJson(ACCESS_LOG_FILE, []); }
/** 读取系统开关配置（缺项用默认值补齐） */
export function getSystemConfig() {
  return { ...DEFAULT_SYSTEM_CONFIG, ...readJson(SYSTEM_CONFIG_FILE, {}) };
}
/** 合并并保存系统开关配置 */
export function saveSystemConfig(c) {
  const next = { ...getSystemConfig(), ...c };
  writeJson(SYSTEM_CONFIG_FILE, next);
  return next;
}

/**
 * 判定一次提交使用哪种调用时机，为唯一判定点（服务端强制，不信任前端传入值）。
 *
 * 服务端必须独立判定的原因：接口为公开接口，任何调用方都可以自行构造请求并带上"闲时"。
 * 关闭该开关表示此期间不允许使用闲时调用，前端隐藏选项只是第一道限制。
 *
 * @param {{ role?: string, requested?: string, cfg?: object }} o
 * @returns {{ mode: 'idle'|'immediate', forced: boolean, reason: string }}
 */
export function resolveAuditMode({ role = 'user', requested = '', cfg = null } = {}) {
  const c = cfg || getSystemConfig();
  const want = requested === 'immediate' ? 'immediate' : 'idle';
  // 管理员始终保留选择权
  if (role === 'admin') return { mode: want, forced: false, reason: '管理员自选' };
  if (c.allowIdleChoice === false) {
    return { mode: 'immediate', forced: want === 'idle', reason: '管理员已关闭「闲时/立即」选择，统一立即调用' };
  }
  return { mode: want, forced: false, reason: '按提交人选择' };
}

/** 读取项目台账的人工设置（显示名与清零时刻） */
export function listProjects() { return readJson(PROJECTS_FILE, {}); }
/** 保存项目台账的人工设置 */
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

/**
 * 查找同一项目上一轮已完成的审核，用于对比"上次的问题本次是否修改"。
 *
 * 2026-09-27 起：同一项目重复审核时，除报告新问题外，还需核实上次问题的修改情况
 * 以及未响应的高级别问题。查找规则：
 *   · 匹配口径与重复审核提示一致（项目编号或名称任一命中，不分提交人，按项目合并）；
 *   · 只取 status 为 done 的任务（失败/取消/被拒的任务没有可对比的问题清单）；
 *   · 取最新一次（按审核完成时间，缺失时按提交时间）。
 *
 * @param {object[]} tasks 全部任务
 * @param {{projectName?: string, projectCode?: string, excludeTaskId?: string}} [opts]
 * @returns {object|null} 上一轮任务（findDuplicateAudits 的精简形状）
 */
export function findPreviousAudit(tasks, { projectName = '', projectCode = '', excludeTaskId = '' } = {}) {
  const hits = findDuplicateAudits(tasks, { projectName, projectCode, excludeTaskId })
    .filter(h => h.status === 'done');
  if (!hits.length) return null;
  hits.sort((a, b) => String(b.finishedAt || b.createdAt).localeCompare(String(a.finishedAt || a.createdAt)));
  return hits[0];
}

/**
 * 把台账任务按项目分组（同一项目的多次审核合并为一条，不分提交人）。
 *
 * 每组包含：提交次数、参与人、首次/最后一次时间，以及每次审核的明细（提交人、时间、问题数、状态）。
 * 分组键优先级：归一化后的项目名 → 项目编号 → 文件名保底。
 */
export function groupTasksByProject(tasks = []) {
  const groups = new Map();
  // 分组键不能使用 normalizeProjectKey：它对空名字返回 '未识别项目'（查重提示使用的保底文案），
  // 作为分组键会把所有未识别出项目名的任务（来自不同文件）并入同一组 —— 经实测确认。
  const normName = (n) => String(n || '').trim().replace(/\s+/g, '').toLowerCase();
  for (const t of tasks) {
    const name = String(t.projectName || '').trim();
    const code = String(t.projectCode || '').trim().toUpperCase();
    const nk = normName(name);
    const key = nk ? 'name:' + nk : (code ? 'code:' + code : 'file:' + (t.sourceName || t.id));
    if (!groups.has(key)) {
      groups.set(key, { key, name: name || t.sourceName || '未识别项目', code, projectType: t.projectType || '', submissions: [] });
    }
    const g = groups.get(key);
    g.submissions.push({
      id: t.id, owner: t.owner, ownerName: t.ownerName || t.owner || '（未知）',
      status: t.status, createdAt: t.createdAt, finishedAt: t.finishedAt,
      sourceName: t.sourceName,
      p0: t.stats?.p0Count ?? null, p1: t.stats?.p1Count ?? null,
      p2: t.stats?.p2Count ?? null, p3: t.stats?.p3Count ?? null,
      proofread: t.proofreadCount ?? null, deep: t.deepCount ?? null,
      cost: t.cost ?? null,
      compare: t.compare || null,        // 与上一轮的对比摘要（有才给）
    });
  }
  const out = [...groups.values()];
  for (const g of out) {
    g.submissions.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    g.count = g.submissions.length;
    g.owners = [...new Set(g.submissions.map(s => s.ownerName))];
    g.firstAt = g.submissions[0]?.createdAt || '';
    g.lastAt = g.submissions[g.submissions.length - 1]?.createdAt || '';
    g.latest = g.submissions[g.submissions.length - 1];
    g.hasRepeat = g.count > 1;
  }
  return out.sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
}

// ─────────────── 重复审核提醒 ───────────────
//
// 场景：同一项目被第二个人重复提交。重复审核产生额外费用（约 ¥0.7 API + ¥258 人工工时），
//       并在台账中产生两条同一项目的记录。
// 判定：项目编号或项目名称任一命中即视为同一项目（报告中常缺编号，只按名称匹配会漏判）。
// 时机分两道：
//   · 本地粗筛（解析正文后立即执行，不消耗 API）：用已知项目的编号/名称在正文中查找，命中则先预警；
//   · S0 精确判定（识别出真实项目名后）：以该结果为准，决定是否暂停。

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
 * 本地粗筛（不消耗 API）：用已登记项目的编号与名称核心段在正文中查找。
 *
 * 用于文档刚解析完成、尚未进入 AI 调用时段的阶段 —— 闲时任务可能数小时后才执行 S0，
 * 届时再提示已过晚。
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
 * 项目质量台账，从任务数据实时派生，不再维护只增不减的计数器。
 *
 * 改为派生的原因：此前的 upsertProject 向 projects.json 累加，删除任务后计数不回退，
 * 会出现「看板显示 6 次审核，台账显示该项目 7 次提交、358 项」这类不一致数据。
 * 现在台账与看板都基于同一份任务数据计算，天然一致。
 *
 * projects.json 只保留两类人工设置：项目显示名，以及管理员执行清零的时刻（resetAt）。
 *
 * 归组口径：优先按 S0 识别出的项目名；历史任务无项目名时回退为按文件名归组，
 *          以保证所有已完成任务都被统计，提交次数之和等于已完成审核次数。
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
      // 整改闭环：该项目历次"与上次对比"的合计，用于识别整改未落实的项目
      resp: { total: 0, fixed: 0, partial: 0, unfixed: 0, unfixedP0: 0, rounds: 0 },
    };
    if (t.projectName) m.byFilename = false;
    if (display.length > (m.name || '').length) m.name = display;
    m.proofreadTotal += t.proofreadCount || 0;
    m.itemTotal += (t.proofreadCount || 0) + (t.deepCount || 0);
    m.submissions += 1;
    m.taskIds.push(t.id);
    {
      const c = t.compare && t.compare.stats;
      if (c && c.total) {
        m.resp.total += c.total; m.resp.fixed += c.fixed || 0; m.resp.partial += c.partial || 0;
        m.resp.unfixed += c.unfixed || 0; m.resp.unfixedP0 += c.unfixedP0 || 0;
        m.resp.rounds++;
      }
    }
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

/**
 * 按人员与按项目类别汇总（2026-09-28 起项目台账支持按人、按类别查看）。
 *
 * 每个桶包含：
 *   subs        提交次数（含失败/取消，用于衡量工作量）
 *   done/failed/cancelled/pendingDup   状态分布
 *   offpeak/peak  闲时/忙时已完成次数，与「闲时/忙时占比」饼图同口径（按 t.peak 且只算 done）
 *   proofread/deep  校对类/深度类问题条数（无深度权限者不计 deep）
 *   p0/p1       问题级别条数（无深度权限者只统计校对类）
 *   points      积分消耗（≈ Σ 人民币费用；1 积分 ≈ ¥1，界面仅对普通用户展示积分）
 *   resp        整改闭环（来源为"与上次对比"）：{total, fixed, partial, unfixed, unfixedP0, projects}
 *
 * 与看板其它数字同源同口径：均由同一份任务列表派生，避免两处数字不一致。
 * @param {object[]} tasks 已按权限范围过滤的任务
 * @param {{ canDeep?: boolean }} opts
 */
export function buildRollups(tasks = [], { canDeep = false } = {}) {
  const blank = (name) => ({
    name, subs: 0, done: 0, failed: 0, cancelled: 0, pendingDup: 0,
    offpeak: 0, peak: 0, proofread: 0, deep: 0, p0: 0, p1: 0, points: 0,
    resp: { total: 0, fixed: 0, partial: 0, unfixed: 0, unfixedP0: 0, projects: 0 },
  });

  const add = (map, key, t) => {
    const name = String(key || '（未识别）').trim() || '（未识别）';
    const b = map.get(name) || blank(name);
    b.subs++;
    if (t.status === 'done') {
      b.done++;
      t.peak ? b.peak++ : b.offpeak++;          // 与 buildPeakStats 一致：只看 done，按 t.peak 分桶
      b.proofread += t.proofreadCount || 0;
      if (canDeep) b.deep += t.deepCount || 0;
      // 级别条数：有深度权限看全量 stats；普通用户只看校对类（与台账列口径一致）
      if (canDeep) { b.p0 += t.stats?.p0Count || 0; b.p1 += t.stats?.p1Count || 0; }
      else { b.p0 += t.proofreadP0 || 0; b.p1 += t.proofreadP1 || 0; }
      b.points += t.cost || 0;
      const c = t.compare && t.compare.stats;
      if (c && c.total) {
        b.resp.total += c.total; b.resp.fixed += c.fixed || 0; b.resp.partial += c.partial || 0;
        b.resp.unfixed += c.unfixed || 0; b.resp.unfixedP0 += c.unfixedP0 || 0;
        b.resp.projects++;
      }
    } else if (t.status === 'failed') b.failed++;
    else if (t.status === 'cancelled') b.cancelled++;
    else if (t.status === 'duplicate-suspect') b.pendingDup++;
    map.set(name, b);
  };

  const users = new Map(), types = new Map();
  for (const t of tasks) {
    add(users, t.ownerName || t.owner || '（未知）', t);
    add(types, t.projectType || guessProjectType(t.projectName, t.sourceName, t.templateName), t);
  }
  const finish = (m) => [...m.values()]
    .map(b => ({ ...b, points: Math.round(b.points * 100) / 100 }))
    .sort((a, b) => b.subs - a.subs || b.proofread - a.proofread);
  return { byUser: finish(users), byType: finish(types) };
}

/**
 * 全所积分池（仅管理员可见）：各账号本月额度合计与本月已用合计。
 *
 * 口径三条（2026-09-28 修订）：
 *   · 管理员本人预算为 0（不限），不计入；
 *   · 停用账号不计入，否则分母偏大；
 *   · 额度设为 0（不限）的账号两边都不计入。此前的实现只把其额度计为 0、用量照算，
 *     导致分子含该账号而分母不含，池子数字自相矛盾。
 *     该类账号单独通过 `unlimited` 人数返回，界面展示为"另 N 人不限"。
 */
/**
 * 本月全所实际消耗（元，1 积分 ≈ ¥1），与看板 KPI「API 费用合计」同一口径：
 * 只统计用量记录完整的任务（残缺记录会少算费用，见 isUsageComplete 的注释），按北京时间归月。
 * 管理员、不限额账号与停用账号一律计入，其消耗同样属于全所支出。
 */
export function instituteMonthCost(tasks = [], { completeOnly = true } = {}) {
  const month = toBeijing(new Date()).toISOString().slice(0, 7);
  const list = (tasks || []).filter(t =>
    t.status === 'done'
    && (!completeOnly || isUsageComplete(t))
    && toBeijing(new Date(t.createdAt)).toISOString().slice(0, 7) === month);
  return Math.round(list.reduce((s, t) => s + (t.cost || 0), 0) * 100) / 100;
}

/**
 * 全所积分池（管理员看板使用）。
 *
 * 2026-09-28 修复："积分消耗 2 积分"与同屏实际 API 费用不一致的问题 ——
 *    此前只累加有限额、非管理员、未停用账号的消耗：经实测当月 ¥40.3 中
 *    有 ¥32.21 来自一个不限额度账号、¥6.26 来自管理员，两者均被排除在池子外，
 *    池子仅剩 ¥1.84（界面显示"2 积分"），与同屏的 ¥40.3 相差一个数量级。
 *
 * 现将两部分数据分开返回，使界面可以绘出口径闭合的饼图：
 *   · usedAll     全所本月实际消耗（元），与 KPI 及节省效果同源，饼图"已消耗"使用该值；
 *   · budget      限额账号的额度合计（分到各人的额度）；
 *   · usedLimited 限额账号本月已用；
 *   · poolTotal   = budget + (usedAll − usedLimited)，不限额账号自花自用，两边平衡；
 *   · remaining   = poolTotal − usedAll = budget − usedLimited
 *                 = 限额账号实际剩余可用额度。
 * 由此：已消耗与同屏费用一致，剩余仍为可用额度，饼图两片之和自洽。
 */
export function pointsPool(tasks = []) {
  const all = listUsers().filter(u => !u.disabled && u.role !== 'admin');
  const limited = all.filter(u => Number(u.budget ?? DEFAULT_BUDGET) > 0);
  const unlimited = all.length - limited.length;
  let budget = 0, usedLimited = 0;
  for (const u of limited) {
    budget += Number(u.budget ?? DEFAULT_BUDGET);
    usedLimited += usageOf(tasks, u.id).costMonth;
  }
  const r2 = (n) => Math.round(n * 100) / 100;
  const usedAll = instituteMonthCost(tasks);
  const poolTotal = budget + (usedAll - usedLimited);
  return {
    budget: r2(budget),                 // 限额账号额度合计（"分到各人"）
    used: r2(usedLimited),              // 兼容旧字段：限额账号已用
    usedAll,                            // 全所本月实际消耗（与费用同源）
    poolTotal: r2(poolTotal),           // 饼图分母（含不限额账号自平衡的那部分）
    remaining: r2(poolTotal - usedAll), // 剩余 = 限额账号剩余额度
    users: limited.length,              // 限额人数
    unlimited,                          // 不限额账号数（另行列示，不混进额度）
    totalUsers: all.length,
  };
}

// ─────────────── 排队调度（2026-09-28 起管理员可加急 / 立即开始）───────────────
//
// 背景：大量用户同时提交时任务会排队（并发上限默认 2）。管理员需要对某些任务：
//   · 提高优先级（插入队首，不增加并发）
//   · 立即开始（名额已满时临时为该任务 +1 并发，完成后自动收回）
//
// 判定逻辑集中在此处：服务端只有一套口径，且便于在自检中直接断言（否则排队行为只能人工观察）。

/** 加急优先级：数值越大越先跑；0 = 正常 */
export const PRIORITY_NORMAL = 0;
export const PRIORITY_URGENT = 1;
export const PRIORITY_START_NOW = 99;      // 「立即开始」用一个大值，保证排到所有加急之前

/**
 * 每人同时在跑的任务数上限（2026-09-28 起）。
 *
 * 此前的限制只有月度费用额度，单个账号可占满全部并发名额，其他账号提交后只能等待。
 * 该上限用于保证多账号同时使用时的排队公平性。
 */
export const PER_USER_RUNNING = 2;

/**
 * 管理员的"每人同时在跑"上限（2026-09-29 起：管理员发起的任务可同时跑到 6）。
 * 为什么给管理员放宽：管理员的提交多为批量补审、复现问题或替使用方代跑，属于显式调度行为；
 * 普通使用方仍按 PER_USER_RUNNING（2）保护，避免一个人占满并发。
 * 放宽的只是"每人"这一层，全局仍受 MAX_CONCURRENT 与临时名额（MAX_BOOST）约束。
 */
export const PER_USER_RUNNING_ADMIN = Number(process.env.PER_USER_RUNNING_ADMIN || 6);

/**
 * 每人在队列中的待处理上限（2026-09-28 起新增口径）。
 *
 * 只统计当前即可运行（ready）的任务，不计等待闲时的任务 ——
 * 否则使用方在 9:00 提交 3 份闲时任务后，需等到 12:10 才能运行，整个上午无法继续提交。
 * 与全局 MAX_QUEUE 口径一致：全局也只统计 ready。
 */
export const PER_USER_QUEUED = 3;

/**
 * 判断任务当前是否可以开始执行。
 *
 * 必须分两段判断：
 *   · 尚未做本地预处理（preprocessedAt 为空）→ 随时可以开始，
 *     文档解析为本地操作、不产生费用，高峰时段也应立即执行；
 *   · 预处理已完成 → 受 apiStartAt（闲时起跑时刻）约束。
 * 早先的实现把 scheduledAt 在提交时即设为 apiStartAt，预处理被一并阻塞，
 * 任务会一直停留在「排队中」不执行。
 */
export function canStartTask(t, now = Date.now()) {
  if (!t) return false;
  if (!t.preprocessedAt) return true;
  return !t.apiStartAt || new Date(t.apiStartAt).getTime() <= now;
}

/** 是否处于"已解析完成、等待闲时窗口"状态（界面显示为「等待闲时」，不占并发与就绪名额） */
export function isWaitingTask(t, now = Date.now()) {
  return !!(t && t.preprocessedAt && t.apiStartAt && new Date(t.apiStartAt).getTime() > now);
}

/**
 * 从队列中选出下一个应执行的任务，返回其数组下标（无可执行任务时返回 -1）。
 *
 * 选择顺序（依次比较，先满足者优先）：
 *   ① 优先级高者先执行（管理员的「加急/立即开始」为明确指令，优先于公平规则）；
 *   ② 优先级相同时，当前没有在跑任务的人优先（保证每个账号尽量有一个进行中的任务，
 *      否则先提交者会把多个任务排在前面，后登录的使用方持续等待）；
 *   ③ 仍相同时按先来后到（避免先提交的任务长期得不到执行）。
 *
 * 另两条硬约束：
 *   · 某账号在跑任务已达上限（默认 2）时，其任务本轮一律不选（跳过，而非拒绝）；
 *     例外：被显式标记「立即开始」（priority ≥ PRIORITY_START_NOW）的任务不受该上限约束 ——
 *     它是对单个任务的显式指令，配额由全局并发上限与临时名额（MAX_BOOST）约束；
 *     否则当一个人自己已占满 2 路时，他给其余任务点「立即开始」将永远排不上（2026-09-29 实测到的现象：
 *     全局 6 路只用了 2 路，队列里 11 个任务全部停在排队，管理员点「立即开始」无任何效果）。
 *   · 优先级不能越过"尚未到闲时起点"这一约束 —— 此类任务需用「立即开始」显式解除等待，
 *     否则加急等同于忽略计费时段，实际费用翻倍而管理员仅视为插队。
 *
 * @param {string[]} ids 队列（数组顺序即入队顺序）
 * @param {(id:string)=>object} getTask
 * @param {{ now?: number, runningByOwner?: Map<string, number>, perUserRunning?: number,
 *           startNowBypassesPerUser?: boolean, adminOwners?: Set<string>,
 *           adminPerUserRunning?: number }} opts
 *   adminOwners：管理员账号 id 集合；命中的账号按 adminPerUserRunning（默认 6）而非 perUserRunning（默认 2）计。
 */
export function pickNextReady(ids = [], getTask = () => null, opts = {}) {
  const now = opts.now ?? Date.now();
  const perUser = opts.perUserRunning ?? PER_USER_RUNNING;
  const adminOwners = opts.adminOwners || null;
  const adminCap = opts.adminPerUserRunning ?? PER_USER_RUNNING_ADMIN;
  const capOf = (ownerId) => (adminOwners && adminOwners.has(ownerId)) ? adminCap : perUser;
  const byOwner = opts.runningByOwner || new Map();
  const bypassPerUser = opts.startNowBypassesPerUser !== false;   // 默认开：立即开始不受每人上限约束

  let best = -1, bestPriority = -Infinity, bestFair = -1;
  for (let i = 0; i < ids.length; i++) {
    const t = getTask(ids[i]);
    if (!canStartTask(t, now)) continue;
    const p = Number(t.priority) || PRIORITY_NORMAL;
    const isStartNow = p >= PRIORITY_START_NOW;
    const owner = t.owner || '（未知）';
    const runningOfOwner = byOwner.get(owner) || 0;
    if (!(bypassPerUser && isStartNow) && runningOfOwner >= capOf(owner)) continue;   // 该人已占满名额 → 本轮不选
    const fair = runningOfOwner === 0 ? 1 : 0;            // 1 = 这个人手上没有在跑的
    if (p > bestPriority || (p === bestPriority && fair > bestFair)) {
      bestPriority = p; bestFair = fair; best = i;        // 都不优于时保留更靠前的（先来后到）
    }
  }
  return best;
}

/**
 * 未响应明细钻取（2026-09-29 起：台账"整改闭环"的未响应数字可点开看具体条目）。
 *
 * 口径与台账一致：逐条对比结果里 status 为 unfixed（未响应）或 partial（部分响应）都算"未完全响应"，
 * fixed（已改）与 unknown（本次信息不足）不计入 —— 与 pipeline 的 unfixedP0/P1 统计同口径。
 *
 * 每条保留定位所需字段：项目、级别、类别、位置（页/表）、上次意见、本次原文证据、判断说明，
 * 以及上一轮任务号（便于对照两次报告的差异）。管理员据此判断"是否必须响应"，
 * 并据此反推审核技能的误报/漏报（这也是本轮需求的初衷）。
 *
 * @param {object[]} tasks 任务列表（含 compare.stats 摘要）
 * @param {{ readCompare?: (taskId:string)=>object|null, scope?: string, owner?: string,
 *           level?: string, category?: string, project?: string, status?: string, limit?: number }} opts
 *   readCompare：按任务号读取 run/compare.json（返回 {items, prevTaskId, prevAt}）；读不到返回 null。
 * @returns {{total:number, p0:number, unfixed:number, partial:number, projects:number, truncated:boolean,
 *   byProject:object[], byCategory:object[], items:object[]}}
 */
export function buildUnrespondedReport(tasks = [], opts = {}) {
  const readCompare = opts.readCompare || (() => null);
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 2000;
  const items = [];
  const byProject = new Map();
  const byCategory = new Map();
  let unfixed = 0, partial = 0;

  for (const t of tasks) {
    // 不拿任务摘要里的 compare.stats 当闸门：以产物明细为唯一事实源，
    // 否则一旦摘要与明细不一致（历史上出现过统计口径改动），明细会漏条目。
    if (opts.scope === 'mine' && opts.owner && t.owner !== opts.owner) continue;
    const project = t.projectName || t.sourceName || '（未识别项目）';
    if (opts.project && project !== opts.project) continue;

    let cmp = null;
    try { cmp = readCompare(t.id); } catch { cmp = null; }
    const list = (cmp && Array.isArray(cmp.items)) ? cmp.items : [];
    for (const it of list) {
      if (it.status !== 'unfixed' && it.status !== 'partial') continue;
      if (opts.level && it.level !== opts.level) continue;
      if (opts.status && it.status !== opts.status) continue;
      if (opts.category && it.category !== opts.category) continue;
      const fb = opts.feedback ? (opts.feedback[skillFeedbackKey(t.id, it.no)] || null) : null;
      if (opts.only === 'marked' && !fb) continue;
      if (opts.only === 'unmarked' && fb) continue;
      const rec = {
        taskId: t.id,
        project,
        ownerName: t.ownerName || t.owner || '',
        finishedAt: t.finishedAt || '',
        prevTaskId: (cmp && cmp.prevTaskId) || t.prevTaskId || '',
        prevAt: (cmp && cmp.prevAt) || '',
        no: it.no || '', level: it.level || '', category: it.category || '',
        location: it.location || '', summary: it.summary || '',
        evidence: it.evidence || '', note: it.note || '', status: it.status,
        feedback: fb,                        // 管理员的优化判定（未标注为 null）
      };
      items.push(rec);
      if (rec.status === 'unfixed') unfixed++; else partial++;
      const p = byProject.get(project) || { project, total: 0, unfixed: 0, partial: 0, p0: 0 };
      p.total++; if (rec.status === 'unfixed') p.unfixed++; else p.partial++;
      if (rec.level === 'P0') p.p0++;
      byProject.set(project, p);
      const cat = rec.category || '（未分类）';
      const c = byCategory.get(cat) || { category: cat, total: 0, p0: 0 };
      c.total++; if (rec.level === 'P0') c.p0++;
      byCategory.set(cat, c);
    }
  }

  // 排序：级别高的在前（P0 优先处理）→ 项目 → 条目号，方便逐条过
  const rank = (l) => (l === 'P0' ? 0 : l === 'P1' ? 1 : l === 'P2' ? 2 : 3);
  items.sort((a, b) => (rank(a.level) - rank(b.level))
    || a.project.localeCompare(b.project, 'zh') || String(a.no).localeCompare(String(b.no), 'zh'));

  const total = items.length;
  return {
    total,
    p0: items.filter((x) => x.level === 'P0').length,
    unfixed, partial,
    projects: byProject.size,
    truncated: total > limit,
    marked: items.filter((x) => x.feedback).length,
    unmarked: items.filter((x) => !x.feedback).length,
    byProject: [...byProject.values()].sort((a, b) => b.total - a.total),
    byCategory: [...byCategory.values()].sort((a, b) => b.total - a.total),
    feedbackStats: opts.feedback ? skillFeedbackStats(opts.feedback) : null,
    items: items.slice(0, limit),
  };
}

/**
 * 未响应条目"优化判定"的落盘位置。
 *
 * 注意区分既有的 `web/data/skill-feedback.json`（人工审核意见 → 结构化经验条目，见 server.mjs 的
 * `/api/skill-feedback`）：那套是"提交一条经验"，本套是"对某条未响应明细就地判定级别/类别/补规则"，
 * 字段与用途都不同，必须用不同文件，否则两套 schema 会互相覆盖。
 */
export const UNRESP_NOTES_FILE = path.join(DATA_DIR, 'unresponded-notes.json');
/** 反馈记录的主键：一条明细由"任务号 + 条目号"唯一确定 */
export const skillFeedbackKey = (taskId, no) => (taskId && no) ? `${taskId}|${no}` : '';

/** 判定标签（前端快捷勾选与统计共用一套词，避免两边写法漂移） */
export const SKILL_VERDICTS = [
  'AI 误报（不该报）', '定义不准', '过于宽泛', '分析错误',
  '定级不当', '归类不当', '表述不专业', '需补规则', '确需响应（对方未改）',
];

/**
 * 读取全部技能优化反馈。
 * @returns {Record<string, object>} 形如 { "任务号|P1-3": {…} }
 */
export function readSkillFeedback() {
  const j = readJson(UNRESP_NOTES_FILE, { version: 1, items: {} });
  return (j && typeof j.items === 'object' && j.items) ? j.items : {};
}

/**
 * 写入/清除一条技能优化反馈。
 * 只保存白名单字段，避免把整条明细（含长文本）塞进这个文件。
 * @param {object} rec {taskId, no, levelFrom, categoryFrom, levelTo, categoryTo, verdicts, reason, rule, status, by, byName}
 * @param {{ clear?: boolean }} opts clear=true 时删除该条标记
 */
export function saveSkillFeedback(rec = {}, { clear = false } = {}) {
  const key = skillFeedbackKey(rec.taskId, rec.no);
  if (!key) throw new Error('缺少任务号或条目号');
  const all = readSkillFeedback();
  if (clear) {
    delete all[key];
    writeJson(UNRESP_NOTES_FILE, { version: 1, items: all });
    return { key, record: null };
  }
  const keep = ['taskId', 'no', 'project', 'prevTaskId', 'levelFrom', 'categoryFrom',
    'levelTo', 'categoryTo', 'verdicts', 'reason', 'rule', 'status', 'by', 'byName'];
  const out = {};
  for (const k of keep) if (rec[k] !== undefined && rec[k] !== null) out[k] = rec[k];
  out.verdicts = Array.isArray(out.verdicts) ? out.verdicts.filter((v) => SKILL_VERDICTS.includes(v)) : [];
  out.status = ['open', 'adopted', 'ignored'].includes(out.status) ? out.status : 'open';
  out.at = new Date().toISOString();
  // 同一人同一时间重复保存视为同一次标注：时间与操作人由服务端落这里，不接受前端传入
  all[key] = out;
  writeJson(UNRESP_NOTES_FILE, { version: 1, items: all });
  return { key, record: out };
}

/**
 * 反馈统计：用于指导技能优化方向（哪类问题误报多、哪些级别普遍定低了）。
 * @param {Record<string, object>} items readSkillFeedback() 的结果
 */
export function skillFeedbackStats(items = {}) {
  const rank = { P0: 0, P1: 1, P2: 2, P3: 3 };
  const byVerdict = {}, byCategoryFrom = {}, byLevelFrom = {};
  let levelRaise = 0, levelLower = 0, adopted = 0, withRule = 0;
  for (const r of Object.values(items)) {
    for (const v of r.verdicts || []) byVerdict[v] = (byVerdict[v] || 0) + 1;
    const cf = r.categoryFrom || '（未分类）';
    byCategoryFrom[cf] = (byCategoryFrom[cf] || 0) + 1;
    const lf = r.levelFrom || '（未知）';
    byLevelFrom[lf] = (byLevelFrom[lf] || 0) + 1;
    if (r.status === 'adopted') adopted++;
    if (r.rule) withRule++;
    if (r.levelTo) {
      const d = (rank[r.levelTo] ?? 9) - (rank[r.levelFrom] ?? 9);
      if (d < 0) levelRaise++; else if (d > 0) levelLower++;
    }
  }
  const top = (m, n = 8) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, v]) => ({ key: k, count: v }));
  return {
    total: Object.keys(items).length,
    adopted, withRule, levelRaise, levelLower,
    byVerdict: top(byVerdict), byCategoryFrom: top(byCategoryFrom), byLevelFrom: top(byLevelFrom),
  };
}

/**
 * 把反馈清单整理成"改技能用的规则建议"（Markdown），供导出后直接对照修改技能与知识库。
 * @param {Record<string, object>} items readSkillFeedback() 的结果
 * @param {{ onlyAdopted?: boolean }} opts
 */
export function skillFeedbackMarkdown(items = {}, { onlyAdopted = false } = {}) {
  const rows = Object.values(items)
    .filter((r) => (onlyAdopted ? r.status === 'adopted' : true))
    .sort((a, b) => String(a.categoryFrom || '').localeCompare(String(b.categoryFrom || ''), 'zh'));
  const st = skillFeedbackStats(items);
  const L1 = [];
  L1.push('# 审核技能优化建议（由「未响应明细」的标注汇总生成）');
  L1.push('');
  L1.push(`- 生成时间：${new Date().toLocaleString('zh-CN')}`);
  L1.push(`- 标注条数：${st.total}（其中已采纳 ${st.adopted}、含补充规则 ${st.withRule}）`);
  L1.push(`- 需要升/降级别的条数：${st.levelRaise} / ${st.levelLower}`);
  L1.push('');
  L1.push('## 判定分布');
  L1.push('');
  for (const v of st.byVerdict) L1.push(`- ${v.key}：${v.count} 条`);
  L1.push('');
  L1.push('## 按原类别分布（误报/定级问题集中在哪些类别）');
  L1.push('');
  for (const v of st.byCategoryFrom) L1.push(`- ${v.key}：${v.count} 条`);
  L1.push('');
  L1.push('## 逐条记录');
  L1.push('');
  for (const r of rows) {
    L1.push(`### ${r.categoryFrom || '（未分类）'} · ${r.no}（${r.levelFrom || '—'}${r.levelTo ? ' → ' + r.levelTo : ''}）`);
    L1.push('');
    L1.push(`- 项目：${r.project || '—'}`);
    L1.push(`- 判定：${(r.verdicts || []).join('、') || '—'}${r.categoryTo ? `；类别改为 ${r.categoryTo}` : ''}`);
    if (r.reason) L1.push(`- 解释：${r.reason}`);
    if (r.rule) L1.push(`- 补充规则：${r.rule}`);
    L1.push(`- 状态：${r.status === 'adopted' ? '已采纳' : (r.status === 'ignored' ? '忽略' : '待处理')}（${r.byName || ''} ${String(r.at || '').slice(0, 10)}）`);
    L1.push('');
  }
  return L1.join('\n');
}


/**
 * 「排队管理」面板数据（管理员查看）。
 * 返回队列中的实际调度顺序（按优先级与先来后到排列），不是按提交时间的简单排序。
 */
export function buildQueueBoard(ids = [], getTask = () => null, { running = 0, maxConcurrent = 2, boostSlots = 0, maxBoost = 0, runningByOwner = new Map(), perUserRunning = PER_USER_RUNNING, adminOwners = null, adminPerUserRunning = PER_USER_RUNNING_ADMIN, now = Date.now() } = {}) {
  const capOf = (ownerId) => (adminOwners && adminOwners.has(ownerId)) ? adminPerUserRunning : perUserRunning;
  const items = [];
  let ready = 0, waiting = 0, urgent = 0;
  ids.forEach((id) => {
    const t = getTask(id);
    if (!t) return;
    const waitingTask = isWaitingTask(t, now);
    const priority = Number(t.priority) || PRIORITY_NORMAL;
    if (waitingTask) waiting++; else ready++;
    if (priority > PRIORITY_NORMAL) urgent++;
    items.push({
      id, priority,
      urgent: priority > PRIORITY_NORMAL,
      waiting: waitingTask,
      startNow: priority >= PRIORITY_START_NOW,
      owner: t.owner || '',
      ownerRunning: runningByOwner.get(t.owner || '') || 0,   // 该账号在跑任务数（界面据此说明其排队位置）
      perUserCap: capOf(t.owner || ''),                       // 该账号适用的"每人上限"（管理员更高）
      // PPT 配对信息：排队页也要能看出这一件是"报告 + 汇报 PPT"还是纯报告。
      // 判据用 pptSourceName / pptSlides / pptOnly —— pptStashId 每个任务都有，不能用它判断。
      pptSourceName: t.pptSourceName || '',
      pptSlides: t.pptSlides || 0,
      pptOnly: !!t.pptOnly,
      pptEnough: t.pptEnough !== false,
      atCap: (runningByOwner.get(t.owner || '') || 0) >= capOf(t.owner || ''),
      // 真正因"每人上限"被挡住的标记：立即开始的任务不受该上限约束，界面据此显示不同原因
      perUserBlocked: ((runningByOwner.get(t.owner || '') || 0) >= capOf(t.owner || ''))
        && priority < PRIORITY_START_NOW,
      status: t.status,
      ownerName: t.ownerName || t.owner || '（未知）',
      projectName: t.projectName || '',
      sourceName: t.sourceName || '',
      createdAt: t.createdAt || '',
      apiStartAt: t.apiStartAt || '',
      reason: t.scheduleNote || t.progress || '',
    });
  });
  // 展示顺序 = 实际调度顺序：优先级降序 → "手上没在跑的"优先 → 入队顺序
  const order = [...items].sort((a, b) => (b.priority - a.priority));
  order.forEach((x, i) => { x.position = i + 1; });
  return { items: order, running, maxConcurrent, boostSlots, maxBoost, ready, waiting, urgent, total: items.length, perUserRunning, perUserRunningAdmin: adminPerUserRunning };
}

// ─────────────── IP 访问控制（2026-09-28 起限制非授权部门访问与调用）───────────────
//
// 前提：MAC 地址不能用于拦截，只能记录。
//   · 浏览器与网页无法读取 MAC，只能由服务器查询本机 ARP 缓存；
//   · ARP 表数分钟即老化，使用方不常访问时取不到，会误拦内部人员；
//   · MAC 可在网卡属性中直接修改，无法阻止有意绕过者；
//   · MAC 仅在同一网段内可见，跨网段无法获取。
//   因此实际采用 IP 白名单（两道），MAC 仅作为"是否本人设备"的辅助信息记录。
//
// 两道闸门：
//   ① 全局白名单：名单外的 IP 无法访问登录页（用于阻止非授权部门；名单为空表示不限制）
//   ② 每账号绑定：配置了绑定的账号只能从指定机器登录（未配置绑定的账号不受限，便于先加人后补录）
// 管理员默认豁免，系统管理中提供"临时关闭访问控制"的应急开关。

/**
 * 判断 IP 是否命中指定规则。支持三种写法：
 *   · 精确：`192.0.2.77`
 *   · 通配：`192.0.2.*`（仅支持整段 `*`，避免出现 `198.51.1*` 这类难以理解的规则）
 *   · 网段：`192.0.2.0/24`
 * 空规则或 `*` 表示匹配所有。
 * 会自动去掉 IPv6 映射前缀（`::ffff:192.0.2.77` → `192.0.2.77`）。
 *
 * @param {string} ip 待判定 IP
 * @param {string} pattern 规则
 * @returns {boolean} 命中返回 true
 */
export function ipMatches(ip, pattern) {
  const me = String(ip || '').trim().replace(/^::ffff:/i, '');
  let p = String(pattern || '').trim().replace(/^::ffff:/i, '');
  if (!me) return false;
  if (!p || p === '*') return true;
  if (p.includes('/')) {
    // 网段：把两边都转成 32 位整数比较（只处理 IPv4 —— 内网就是 IPv4，写清楚免得误判）
    const [net, bitsRaw] = p.split('/');
    const bits = Number(bitsRaw);
    const a = ipv4ToInt(me), b = ipv4ToInt(net);
    if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
    return ((a & mask) >>> 0) === ((b & mask) >>> 0);
  }
  if (p.includes('*')) {
    // 先用 ipv4ToInt 校验 me 为合法 IPv4：否则伪造 `X-Forwarded-For: 192.0.2.999`
    // 这类形似允许网段的值可以绕过通配规则（自检中已被捕获）。
    if (ipv4ToInt(me) === null) return false;
    const pp = p.split('.');
    const mm = me.split('.');
    if (pp.length !== 4 || mm.length !== 4) return false;
    return pp.every((seg, i) => seg === '*' ? /^\d{1,3}$/.test(mm[i]) : seg === mm[i]);
  }
  return me === p;
}

/** IPv4 点分转整数；不是合法 IPv4 返回 null */
export function ipv4ToInt(ip) {
  const parts = String(ip || '').trim().split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const s of parts) {
    if (!/^\d{1,3}$/.test(s)) return null;
    const v = Number(s);
    if (v > 255) return null;
    n = (n * 256) + v;
  }
  return n >>> 0;
}

/** IP 是否命中列表中的任意一条；列表为空表示不限制（支持先加人后补录） */
export function ipAllowed(ip, patterns) {
  const list = (patterns || []).map(x => String(x || '').trim()).filter(Boolean);
  if (!list.length) return true;
  return list.some(p => ipMatches(ip, p));
}

/** 规范化一份 IP 规则列表（去空白、去重、限条数），用于保存配置 */
export function normalizeIpList(patterns, { max = 30 } = {}) {
  const out = [];
  for (const raw of (patterns || [])) {
    const p = String(raw || '').trim();
    if (!p) continue;
    if (!out.includes(p)) out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 从请求中取来源 IP。
 *
 * 默认不信任 `X-Forwarded-For`：该请求头可由客户端任意伪造。
 * 本服务直连暴露（node 直接监听 8787，无反向代理），因此只取 TCP 连接的对端地址；
 * 否则任何调用方添加 `X-Forwarded-For: 192.0.2.24` 即可冒充白名单内的机器，
 * 绕过整套 IP 访问控制（自检中有一条断言专门覆盖该场景）。
 * 部署在反向代理之后时，需设置环境变量 `WB_TRUST_PROXY=1` 才启用 XFF。
 *
 * @param {object} headers 请求头
 * @param {string} remoteAddress TCP 对端地址
 * @param {{trustProxy?: boolean}} [opts] 是否信任代理头
 * @returns {string} 来源 IP
 */
export function clientIpOf(headers = {}, remoteAddress = '', { trustProxy = false } = {}) {
  const direct = String(remoteAddress || '').replace('::ffff:', '').trim();
  if (!trustProxy) return direct;
  const xf = String(headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (xf || direct).replace('::ffff:', '').trim();
}

/** 是否是回环地址（127.0.0.0/8 与 IPv6 的 ::1） */
export function isLoopback(ip) {
  const s = String(ip || '').trim().replace(/^::ffff:/i, '');
  if (!s) return false;
  if (s === '::1' || s.toLowerCase() === 'localhost') return true;
  return /^127\./.test(s);
}

let _localIpsCache = null;
/**
 * 返回本机全部 IPv4 地址（含 127.0.0.1）。结果缓存一次 —— 网卡不常变，无需每个请求都枚举。
 */
export function localIPv4s() {
  if (_localIpsCache) return _localIpsCache;
  const out = ['127.0.0.1'];
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of (list || [])) if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  } catch { /* 取不到就只认回环 */ }
  _localIpsCache = out;
  return out;
}

/**
 * 判断请求是否来自本机（回环地址或本机网卡 IP）。
 *
 * 2026-09-28 起：默认对 127.0.0.1 不设任何操作限制，并扩展到本机全部 IP。
 * 使用方在各自电脑上访问；而使用服务器自身地址访问，只可能是本机浏览器操作 ——
 * 该场景下操作者本就可直接修改服务器文件，拦截没有意义，只会阻塞运维与演示。
 */
export function isLocalRequest(ip, localIps = null) {
  const s = String(ip || '').trim().replace(/^::ffff:/i, '');
  if (!s) return false;
  if (isLoopback(s)) return true;
  return (localIps || localIPv4s()).includes(s);
}

/** 名单里所有账号绑定的 IP（去重） */
export function boundIpsOf(users) {
  const out = [];
  for (const u of (users || [])) {
    for (const p of (u.allowedIps || [])) {
      const s = String(p || '').trim();
      if (s && !out.includes(s)) out.push(s);
    }
  }
  return out;
}

/**
 * 返回全局闸门实际生效的名单。
 *
 * 2026-09-28 修复：将账号的登录 IP 改为新地址后该账号仍无法登录 ——
 *    原因是全局白名单未同步（两道闸门相互独立）：账号在登录前的第一道校验即被拒绝，
 *    每账号绑定配置无从生效；管理员只修改了绑定，未同步手工白名单。
 *
 * 现口径为：管理员手工配置的白名单 ∪ 所有账号绑定的 IP。
 *   · 只修改绑定 → 自动放行，无需在两处维护；
 *   · 取消绑定 → 该 IP 自动移出，不残留无效条目。
 * 向后兼容边界：手工白名单为空时，全局闸门仍为不限制 ——
 *   否则仅给少数账号绑定 IP、未开启全局限制的系统会把所有访问者拒之门外。
 */
export function effectiveAllowlist(cfg = {}, users = []) {
  const explicit = normalizeIpList(cfg.ipAllowlist || [], { max: 500 });
  if (!explicit.length) return { list: [], explicit, auto: [], restricted: false };
  const auto = boundIpsOf(users);
  return { list: normalizeIpList([...explicit, ...auto], { max: 500 }), explicit, auto, restricted: true };
}

/**
 * 访问判定：唯一口径，服务端每个请求都经由此函数（自检中直接断言）。
 * @param {object} o 判定入参
 * @param {string[]} [o.boundIps] 各账号绑定的 IP（自动并入全局白名单，见 effectiveAllowlist）
 * @returns {{allowed: boolean, reason: string, scope: string}}
 */
export function checkIpAccess({ ip = '', user = null, cfg = {}, localIps = null, boundIps = [] } = {}) {
  // ① 本机豁免（默认开启）：对 127.0.0.1 与 192.0.2.161 等本机地址不设操作限制。
  //    三种命中方式：回环地址 / 本机网卡地址（自动识别）/ 配置中显式列出的免限制 IP（ipFreeList）。
  //    显式列表是必要的保底手段：网卡变更或需额外放行其它自有机器时，
  //    自动识别会失效，显式条目仍然生效。
  if (cfg.ipExemptLocal !== false) {
    if (isLocalRequest(ip, localIps)) return { allowed: true, reason: '本机（服务器自己）不受限制', scope: 'local' };
    if (ipAllowed(ip, cfg.ipFreeList) && (cfg.ipFreeList || []).length) {
      return { allowed: true, reason: '这台机器在"免限制 IP"名单里', scope: 'local' };
    }
  }
  if (cfg.ipEnforce === false) return { allowed: true, reason: '访问控制已临时关闭', scope: 'off' };
  const u = user || {};
  if (u.role === 'admin' && cfg.ipExemptAdmins !== false) {
    return { allowed: true, reason: '管理员豁免', scope: 'admin' };
  }
  // 全局闸门：手工白名单为空则不限制；非空则为手工名单 ∪ 各账号绑定的 IP
  const gate = effectiveAllowlist(cfg, []);
  const globalList = gate.restricted ? [...gate.explicit, ...(boundIps || [])] : [];
  if (globalList.length && !ipAllowed(ip, globalList)) {
    return { allowed: false, reason: `本机 IP（${ip}）不在允许访问的范围内`, scope: 'global' };
  }
  const mine = (u.allowedIps || []);
  if (mine.length && !ipAllowed(ip, mine)) {
    return { allowed: false, reason: `你的账号只能从绑定的电脑登录（当前 IP ${ip}）`, scope: 'user' };
  }
  return { allowed: true, reason: '', scope: 'ok' };
}

// ─────────────── 配额 ───────────────

/**
 * 费用额度：每账号每月的可用金额，按实际 API 费用扣减。
 *
 * 不采用按次数计量的原因：
 *   报告长度、问题数量与工作量差异很大，按次数计量不合理 ——
 *   一份 8 万字的深度报告可能消耗 ¥3，一份 3 千字的短报告仅 ¥0.1，但都计为 1 次；
 *   长报告偏多、短报告偏少，管理员也无法据此判断额度是否充足。
 * 改为按金额后，长报告多扣、短报告少扣，与实际用量一致。
 *
 * 额度用尽后可提交额度追加申请，由管理员审批（见 quota-request 相关接口）。
 */
export const DEFAULT_BUDGET = 100;        // 默认每人每月 ¥100；0 = 不限

/** 重置周期：按北京时间自然月（与配额账期一致，不能用 UTC） */

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

/** 检查费用额度；返回 { ok, reason, usage, budget } */
export function checkQuota(user, tasks) {
  if (user.role === 'admin') return { ok: true };                 // 管理员不受限
  const budget = user.budget ?? DEFAULT_BUDGET;
  const u = usageOf(tasks, user.id);
  if (budget > 0 && u.costMonth >= budget) {
    return {
      ok: false,
      reason: `本月费用额度已用完（已用 ¥${u.costMonth.toFixed(2)} / 额度 ¥${budget}）。`
        + `可以在「提交审核」页点「申请增加额度」，管理员会按情况批准。`,
      usage: u, budget,
    };
  }
  return { ok: true, usage: u, budget };
}

// ─────────────── 额度追加申请 ───────────────
// 额度用尽后仍可提交申请，由管理员审批；批准后直接累加到该账号的 budget。
const QUOTA_REQ_FILE = path.join(DATA_DIR, 'quota-requests.json');

/** 读取额度追加申请；文件缺失或损坏时返回空数组 */
export function listQuotaRequests() {
  try { return JSON.parse(fs.readFileSync(QUOTA_REQ_FILE, 'utf8')); } catch { return []; }
}
/** 保存额度追加申请 */
export function saveQuotaRequests(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(QUOTA_REQ_FILE, JSON.stringify(list, null, 2), 'utf8');
}
/** 用户提申请：同一个人同时只保留一条待处理，重复提交只更新理由 */
export function addQuotaRequest({ userId, userName, wantAmount, reason }) {
  let list = listQuotaRequests();       // ← 必须是 let：下面要重新赋值（写 const 会 TypeError）
  list = list.filter(r => !(r.userId === userId && r.status === 'pending'));
  const r = {
    id: 'q' + Date.now().toString(36),
    userId, userName,
    wantAmount: Number(wantAmount) || 0,
    reason: String(reason || '').slice(0, 500),
    status: 'pending',                       // pending / approved / rejected
    createdAt: new Date().toISOString(),
  };
  list.unshift(r);
  if (list.length > 500) list.length = 500;
  saveQuotaRequests(list);
  return r;
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
 * 判断任务的 token 用量记录是否完整。
 *
 * 早期版本的 S2 阶段未累加 usage，task.usage 只记录 S1 与 S5，费用被低估至实际值的约 1/5
 * （实例：42,071 字符的报告只记录 32,795 输入 token）。此类记录不能计入费用合计。
 *
 * 判据：一次完整审核会把报告正文分别发送给 7 个单元，prompt 必然远大于报告字符数；
 *       若 prompt 不足字符数的 2 倍，即判定该记录不完整。
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
 *  - deepAccess=false（普通用户）：P0/P1 只统计校对类（编校/术语/数据/口径），不含深度类；
 *    用量（token / 缓存 / 费用）整体不返回。
 *  - deepAccess=true（管理员 / 审核专家）：P0/P1 含全部类别，用量与成本口径齐全。
 *
 * @param {object[]} tasks 已按范围过滤的任务（本人或全部）
 * @param {object} o
 * @param {'mine'|'all'} o.scope
 * @param {boolean} o.canDeep
 * @param {number} o.monthApiCost 本月 API 费用（仅 canDeep 使用）
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

  // 重复审核统计（2026-09-29 起：看板"已完成审核（次）"右侧加"其中重复审核"框）。
  // 口径：同一项目第 2 次及以后算重复审核。归组前先把原始名称里的括号备注去掉
  // （"某项目（第二次送审）"与"某项目"是同一个项目；注意 normalizeProjectKey 只去括号、保留括号内文字，
  // 因此必须在归一之前剥），再按 normalizeProjectKey 归一。
  // 没有项目名的任务按下标各算一个项目 —— normalizeProjectKey('') 会返回"未识别项目"，
  // 若直接用它归组，多份无名记录会被当成同一项目而虚增重复数。
  const projSeen = new Set();
  let projectCount = 0, repeatAudits = 0;
  done.forEach((t, i) => {
    const raw = String(t.projectName || t.sourceName || '').trim();
    const norm = raw ? normalizeProjectKey(raw.replace(/[（(][^）)]*[）)]/g, '')).trim() : '';
    const key = norm || ('__task:' + i);
    if (projSeen.has(key)) repeatAudits++; else { projSeen.add(key); projectCount++; }
  });

  const usage = {
    taskTotal: tasks.length,
    done: done.length,
    inFlight: inFlight.length,
    failed: tasks.filter(t => t.status === 'failed').length,
    cancelled: tasks.filter(t => t.status === 'cancelled').length,
    pendingDuplicate: tasks.filter(t => t.status === 'duplicate-suspect').length,
    activeUsers: Object.keys(byUser).length,
    projectCount,          // 已完成审核覆盖的项目数
    repeatAudits,          // 其中"重复审核"次数（同一项目的第 2 次及以后）
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
    // 「问题条目数」：历史任务无条目总数，回退为校对类计数
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
