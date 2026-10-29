/**
 * 审核工作台 — 核心公共库
 * 技能加载 / token 估算 / DeepSeek 客户端 / JSON 解析
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { activeModel, resolveApiKey, auditModelName } from './model-config.mjs';
import { AUDIT_MODEL_DEEPSEEK } from './providers.mjs';

export const SKILL_DIR = process.env.SKILL_DIR
  || String.raw`D:\Deepseek harness工作区\生活其他\审核工作台\skill\petroleum-engineering-review`;

/** 默认接口地址（未配置服务商时用）。实际调用走「系统管理 → 模型与接口设置」里的配置。 */
export const API_BASE = 'https://api.deepseek.com/chat/completions';
export const MODELS = { flash: AUDIT_MODEL_DEEPSEEK, pro: 'deepseek-v4-pro' };

/**
 * 当前生效的审核模型名（界面与日志用）。
 *
 * 不直接返回 activeModel().model：那会让「模型与接口设置」里那一栏（历史上默认 deepseek-chat）
 * 改掉审核实际使用的模型。2026-09-27 出现过该回归，之后口径固定为 DeepSeek 家一律 flash。
 * 口径统一在 model-config.mjs 的 auditModelName()：DeepSeek 固定 flash，换家才读设置。
 *
 * @returns {string} 生效的审核模型名
 */
export function activeModelName() {
  try { return auditModelName(); } catch { return MODELS.flash; }
}

/**
 * 读取技能文件（相对 SKILL_DIR）。
 * @param {string} rel 相对技能目录的路径
 * @returns {string} 文件内容
 * @throws {Error} 技能文件不存在
 */
export function readSkill(rel) {
  const p = path.join(SKILL_DIR, rel);
  if (!fs.existsSync(p)) throw new Error(`技能文件缺失: ${p}`);
  return fs.readFileSync(p, 'utf8');
}

/**
 * 读取技能文件，不存在就返回空串。
 * 用于 LEARNED.md 这类「平台积累、可能还没有」的文件 ——
 * 它由审核工作台从人工复核反馈生成，缺失时审核应照常进行。
 *
 * @param {string} rel 相对技能目录的路径
 * @returns {string} 文件内容，读不到时为空串
 */
export function readSkillOptional(rel) {
  try {
    const p = path.join(SKILL_DIR, rel);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  } catch { return ''; }
}

/**
 * 粗略 token 估算：中文约 1.4 字符/token，其它约 3.2 字符/token。
 * 系数偏保守，经实测偏低约 25%。
 *
 * @param {string} text
 * @returns {number} 估算 token 数
 */
export function estimateTokens(text) {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const other = text.length - cjk;
  return Math.ceil(cjk / 1.4 + other / 3.2);
}

/**
 * API key：优先「系统管理」里配置的 Key，其次环境变量，最后从 WorkBuddy 配置读（不新造密钥副本）。
 * 需要「这把 key 到底是哪来的」时用本函数，便于把平台费用单独归集。
 *
 * @returns {{key:string, source:string, label:string}}
 */
export function getApiKeyInfo() {
  return resolveApiKey();
}

/** 取当前生效的 API Key 字符串 */
export function getApiKey() {
  return getApiKeyInfo().key;
}

/** 密钥指纹：只暴露前 7 位，用于日志里核对"用的是哪把 key"，不足以被利用 */
export function keyFingerprint(k) {
  return String(k || '').slice(0, 7) + '…';
}

/**
 * 调用大模型（OpenAI 兼容协议）。
 *
 * 服务商、base_url、模型名都来自「系统管理 → 模型与接口设置」，换服务商不用改代码。
 * 要点：
 *  - 推理模型（deepseek-reasoner / GLM 思考模式等）的 reasoning_content 会吃掉大量 token，
 *    max_tokens 必须给足，且它是上限不是目标。
 *  - jsonMode=true 时启用 response_format=json_object（需提示词里出现 "JSON" 字样）；
 *    个别服务商不支持该字段 → 收到相关 400 时自动去掉再试一次。
 *  - 自动重试 3 次（网络/5xx/限流）。
 *  - 保留原函数名 callDeepSeek 以免改动调用方；新代码可直接用 callModel。
 *
 * @param {object} o
 * @param {string} [o.apiKey] 显式指定的 Key，缺省用系统配置
 * @param {string} [o.model] 显式指定的模型名，缺省用系统配置
 * @param {string} [o.system] system 消息
 * @param {string} o.user user 消息
 * @param {Array<{path:string,mime?:string,detail?:string}>|null} [o.images] 随请求附上的图片
 * @param {number} [o.maxTokens]
 * @param {number} [o.temperature]
 * @param {boolean} [o.jsonMode]
 * @param {number} [o.retries] 最大尝试次数
 * @returns {Promise<{content:string,reasoning:string,usage:object,finish:string,
 *   seconds:number,model:string,provider:string}>}
 */
export async function callModel({
  apiKey, model, system, user, images = null,
  maxTokens, temperature, jsonMode, retries = 3,
}) {
  // 生效参数：显式传入的优先，否则用「系统管理」里的配置
  let eff = null;
  try { eff = activeModel(); } catch (e) { if (!apiKey) throw e; }
  const url = (eff && eff.url) || API_BASE;
  const useModel = model || (eff && eff.model) || 'deepseek-chat';
  const useKey = apiKey || (eff && eff.apiKey);
  const useMax = maxTokens ?? (eff && eff.maxTokens) ?? 16000;
  const useTemp = temperature ?? (eff && eff.temperature) ?? 0.3;
  const wantJson = jsonMode ?? (eff ? eff.jsonMode !== false : false);

  // 图片走标准 OpenAI 兼容的 content 块数组（部分服务商不支持图像，界面会提示）。
  // WARN: 图片只能出现在 user 消息里，放 system / assistant 会返回 400。
  let userContent = user;
  if (images && images.length) {
    userContent = [
      { type: 'text', text: user },
      ...images.map((im) => ({
        type: 'image_url',
        image_url: {
          url: `data:${im.mime || 'image/png'};base64,${fs.readFileSync(im.path).toString('base64')}`,
          detail: im.detail || 'high',
        },
      })),
    ];
  }
  const buildBody = (withJson) => {
    const body = {
      model: useModel,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: userContent },
      ],
      max_tokens: useMax,
      temperature: useTemp,
      stream: false,
    };
    if (withJson) body.response_format = { type: 'json_object' };
    return body;
  };

  let lastErr;
  let jsonOff = false;                                   // 服务商不支持 response_format 时置位
  for (let attempt = 1; attempt <= retries; attempt++) {
    const sw = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${useKey}`,
        },
        body: JSON.stringify(buildBody(wantJson && !jsonOff)),
      });
      if (!res.ok) {
        const t = await res.text();
        // 个别服务商不认 response_format → 去掉该字段再试一次（不算失败重试）
        if (wantJson && !jsonOff && res.status === 400 && /response_format|json_object/i.test(t)) {
          jsonOff = true; attempt--; continue;
        }
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}: ${t.slice(0, 300)}`);
        throw Object.assign(new Error(`HTTP ${res.status}: ${t.slice(0, 500)}`), { fatal: true });
      }
      const json = await res.json();
      const msg = (json.choices && json.choices[0] && json.choices[0].message) || {};
      const u = json.usage || {};
      // 缓存命中量：DeepSeek 用 prompt_cache_hit_tokens，OpenAI 系用 prompt_tokens_details.cached_tokens
      const cacheHit = u.prompt_cache_hit_tokens || (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
      return {
        content: msg.content || '',
        reasoning: msg.reasoning_content || '',
        usage: {
          ...u,
          prompt: u.prompt_tokens || 0,
          completion: u.completion_tokens || 0,
          cacheHit,
          cacheMiss: u.prompt_cache_miss_tokens ?? ((u.prompt_tokens || 0) - cacheHit),
        },
        finish: (json.choices && json.choices[0] && json.choices[0].finish_reason) || '',
        seconds: (Date.now() - sw) / 1000,
        model: useModel,
        provider: eff ? eff.providerName : 'DeepSeek（默认）',
      };
    } catch (e) {
      lastErr = e;
      if (e.fatal) throw e;
      if (attempt < retries) await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastErr;
}

/** 兼容旧调用名（流水线与脚本仍在用 callDeepSeek） */
export const callDeepSeek = callModel;

/**
 * 连接自检：发一句最短的对话，确认 Key / base_url / 模型名都对。
 * 管理员在「模型与接口设置」里点「测试连接」时用。
 *
 * @param {object} [o]
 * @param {string} [o.providerId] 待测服务商
 * @param {string} [o.baseUrl] 待测接口地址
 * @param {string} [o.model] 待测模型名
 * @param {string} [o.apiKey] 本次现填的 Key
 * @param {number} [o.temperature]
 * @returns {Promise<{ok:boolean,url:string,model:string,seconds:number,reply:string,
 *   usage:object|null,keyLabel:string}>}
 */
export async function testModelConnection({ providerId, baseUrl, model, apiKey, temperature = 0 } = {}) {
  const { chatCompletionsUrl, getProvider } = await import('./providers.mjs');
  const { keyForProvider } = await import('./model-config.mjs');
  const p = getProvider(providerId);
  const url = chatCompletionsUrl(baseUrl || p.baseUrl);
  // 不能直接 `apiKey || resolveApiKey().key`：那会把系统当前生效的 Key（本机是 DeepSeek 的）
  // 拿去试别的服务商 —— 既必然 401，又把 Key 发给了第三方。见 keyForProvider 的说明。
  const kf = keyForProvider(p.id, { overrideKey: apiKey });
  if (!kf.usable) throw new Error(`这家还没配可用的 Key：${kf.label}。请先在下面的「API Key」里粘贴这家的 Key 再测试。`);
  const useKey = kf.key;
  const sw = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${useKey}` },
    body: JSON.stringify({
      model: model || (p.models && p.models[0]),
      messages: [{ role: 'user', content: '只回复两个字：正常' }],
      max_tokens: 16, temperature, stream: false,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 300)}`);
  let json = {};
  try { json = JSON.parse(text); } catch { throw new Error('返回不是 JSON：' + text.slice(0, 200)); }
  const msg = (json.choices && json.choices[0] && json.choices[0].message) || {};
  return {
    ok: true, url, model: json.model || model, seconds: Math.round((Date.now() - sw) / 100) / 10,
    reply: String(msg.content || '').slice(0, 40),
    usage: json.usage || null,
    keyLabel: kf.label,
  };
}

/**
 * 被截断的 JSON 修复：补齐未闭合的括号。
 * 模型打满 max_tokens 时 JSON 会断在半路，此时整次调用作废代价太大 ——
 * 尽量抢救出已完整写出的部分（丢失的只是最后几个条目）。
 *
 * @param {string} s 可能被截断的 JSON 文本
 * @returns {string} 括号闭合后的文本
 */
export function repairJson(s) {
  let inStr = false, esc = false;
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') stack.pop();
  }
  if (stack.length === 0 && !inStr) return s;      // 本来就完整

  let cut = s;
  if (inStr) {                                      // 断在字符串中间 → 截到该字符串开头
    const q = s.lastIndexOf('"');
    cut = q > 0 ? s.slice(0, q) : s;
  }
  // 去掉尾部不完整的片段：`, "key":` / `,` / `"key":` / 悬空的 `{`
  cut = cut
    .replace(/,\s*"[^"]*"\s*:\s*$/, '')
    .replace(/,\s*$/, '')
    .replace(/"[^"]*"\s*:\s*$/, '')
    .replace(/[,{[]\s*$/, '');
  const closers = [];
  for (let i = stack.length - 1; i >= 0; i--) closers.push(stack[i] === '{' ? '}' : ']');
  return cut + closers.join('');
}

/**
 * 从模型输出中稳健地抽出 JSON（```json 包裹 / 前后有说明 / 被截断 都能处理）。
 *
 * @param {string} text 模型返回的正文
 * @returns {any} 解析出的 JSON 值
 * @throws {Error} 正文为空或无法解析
 */
export function extractJson(text) {
  if (!text) throw new Error('模型返回正文为空（token 预算可能被推理链耗尽）');
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  try { return JSON.parse(candidate); } catch { /* 继续尝试 */ }
  const start = candidate.search(/[[{]/);
  if (start >= 0) {
    // 从第一个 { 或 [ 开始做括号配对
    const open = candidate[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < candidate.length; i++) {
      const c = candidate[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) { depth--; if (depth === 0) { try { return JSON.parse(candidate.slice(start, i + 1)); } catch { break; } } }
    }
    // 最后回退：容忍被截断 → 补齐括号后再解析
    try {
      return JSON.parse(repairJson(candidate.slice(start)));
    } catch { /* 修复也失败 */ }
  }
  throw new Error('无法从模型输出中解析 JSON：' + text.slice(0, 400));
}
