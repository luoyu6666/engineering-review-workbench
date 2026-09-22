/**
 * 审核工作台 — 核心公共库
 * 技能加载 / token 估算 / DeepSeek 客户端 / JSON 解析
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const SKILL_DIR = process.env.SKILL_DIR
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'skill', 'petroleum-engineering-review');

export const API_BASE = 'https://api.deepseek.com/chat/completions';
export const MODELS = { flash: 'deepseek-flash', pro: 'deepseek-v4-pro' };

/** 读取技能文件（相对 SKILL_DIR） */
export function readSkill(rel) {
  const p = path.join(SKILL_DIR, rel);
  if (!fs.existsSync(p)) throw new Error(`技能文件缺失: ${p}`);
  return fs.readFileSync(p, 'utf8');
}

/**
 * 读取技能文件，不存在就返回空串。
 * 用于 LEARNED.md 这类「平台积累、可能还没有」的文件——
 * 它由审核工作台从人工复核反馈生成，缺失时审核应照常进行。
 */
export function readSkillOptional(rel) {
  try {
    const p = path.join(SKILL_DIR, rel);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  } catch { return ''; }
}

/** 粗略 token 估算：中文 ~1.4 字符/token，其它 ~3.2 字符/token（偏保守，实测偏低估约 25%） */
export function estimateTokens(text) {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const other = text.length - cjk;
  return Math.ceil(cjk / 1.4 + other / 3.2);
}

/**
 * API key：优先环境变量，其次从 WorkBuddy 配置读（不新造密钥副本）。
 * 需要「这把 key 到底是哪来的」时用 getApiKeyInfo()，便于把平台费用单独归集。
 */
export function getApiKeyInfo() {
  if (process.env.DEEPSEEK_API_KEY) {
    return { key: process.env.DEEPSEEK_API_KEY, source: 'env', label: '环境变量 DEEPSEEK_API_KEY' };
  }
  const cfgPath = path.join(os.homedir(), '.workbuddy', 'models.json');
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const ds = cfg.find(m => typeof m.url === 'string' && m.url.includes('deepseek') && m.apiKey);
    if (ds) return { key: ds.apiKey, source: 'workbuddy', label: 'WorkBuddy 配置 models.json（兜底）' };
  }
  throw new Error('未找到 DeepSeek API key：请设置环境变量 DEEPSEEK_API_KEY');
}

export function getApiKey() {
  return getApiKeyInfo().key;
}

/** 密钥指纹：只暴露前 7 位，用于日志里核对"用的是哪把 key"，不足以被利用 */
export function keyFingerprint(k) {
  return String(k || '').slice(0, 7) + '…';
}

/**
 * 调用 DeepSeek。要点：
 *  - deepseek-flash / v4-pro 是推理模型，reasoning_content 会吃掉 3000~20000 token，
 *    max_tokens 必须给足，且它是上限不是目标。
 *  - jsonMode=true 时启用 response_format=json_object（需提示词里出现 "JSON" 字样）。
 *  - 自动重试 3 次（网络/5xx/限流）。
 */
export async function callDeepSeek({
  apiKey, model = 'deepseek-flash', system, user,
  maxTokens = 16000, temperature = 0.3, jsonMode = false, retries = 3,
}) {
  const body = {
    model,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
    ],
    max_tokens: maxTokens,
    temperature,
    stream: false,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const sw = Date.now();
    try {
      const res = await fetch(API_BASE, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const t = await res.text();
        // 429/5xx 重试，4xx 其它直接抛
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}: ${t.slice(0, 300)}`);
        throw Object.assign(new Error(`HTTP ${res.status}: ${t.slice(0, 500)}`), { fatal: true });
      }
      const json = await res.json();
      const msg = json.choices[0].message;
      const u = json.usage || {};
      // 保留官方字段名，同时补上短名与缓存命中量（DeepSeek 会返回 prompt_cache_hit_tokens，
      // 命中价是未命中的 1/50 —— 这是成本核算里最关键的一项）
      const cacheHit = u.prompt_cache_hit_tokens || 0;
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
        finish: json.choices[0].finish_reason,
        seconds: (Date.now() - sw) / 1000,
      };
    } catch (e) {
      lastErr = e;
      if (e.fatal) throw e;
      if (attempt < retries) await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastErr;
}

/**
 * 被截断的 JSON 修复：补齐未闭合的括号。
 * 模型打满 max_tokens 时 JSON 会断在半路，此时整次调用作废代价太大——
 * 尽量抢救出已完整写出的部分（丢失的只是最后几个条目）。
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

/** 从模型输出中稳健地抽出 JSON（```json 包裹 / 前后有说明 / 被截断 都能处理） */
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
    // 兜底：容忍被截断 → 补齐括号后再解析
    try {
      return JSON.parse(repairJson(candidate.slice(start)));
    } catch { /* 修复也失败 */ }
  }
  throw new Error('无法从模型输出中解析 JSON：' + text.slice(0, 400));
}
