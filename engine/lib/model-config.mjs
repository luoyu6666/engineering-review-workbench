/**
 * 模型与接口配置（管理员可在「系统管理 → 模型与接口设置」里改）
 *
 * 存 web/data/model-config.json（可用 WB_DATA_DIR 指到别处）。
 * 读取顺序（key）：model-config.json → 环境变量 DEEPSEEK_API_KEY → WorkBuddy models.json（回退）
 * 读取顺序（base_url / 模型名）：model-config.json → 内置预置表默认值
 *
 * WARN: 配置文件里存的是明文 Key（内网自托管，与其它数据同权限），接口只回传打码后的指纹。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PROVIDERS, getProvider, chatCompletionsUrl, AUDIT_MODEL_DEEPSEEK } from './providers.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
export const DATA_DIR = process.env.WB_DATA_DIR ? path.resolve(process.env.WB_DATA_DIR) : path.join(ROOT, 'web', 'data');
export const MODEL_CONFIG_FILE = path.join(DATA_DIR, 'model-config.json');

export const DEFAULT_CONFIG = {
  providerId: 'deepseek',
  // 默认值与「审核实际使用的模型」保持一致（DeepSeek 家固定 flash，见 auditModelName）。
  // 此前这里是老别名 deepseek-chat，界面显示与实际调用不符，容易误判。
  model: AUDIT_MODEL_DEEPSEEK,
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  temperature: 0.1,
  maxTokens: 32000,
  jsonMode: true,
  note: '',
  updatedAt: '',
  by: '',
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function loadModelConfig() {
  const raw = readJson(MODEL_CONFIG_FILE, null);
  const cfg = { ...DEFAULT_CONFIG, ...(raw || {}) };
  const p = getProvider(cfg.providerId);
  // 预置表回退：配置里没填 baseUrl / 模型名时用该服务商的默认值
  if (!cfg.baseUrl) cfg.baseUrl = p.baseUrl || DEFAULT_CONFIG.baseUrl;
  if (!cfg.model) cfg.model = (p.models && p.models[0]) || DEFAULT_CONFIG.model;
  return cfg;
}

export function saveModelConfig(next, { by = '' } = {}) {
  const cur = loadModelConfig();
  const merged = {
    ...cur, ...next,
    temperature: Number(next.temperature ?? cur.temperature) || 0,
    maxTokens: Number(next.maxTokens ?? cur.maxTokens) || 0,
    jsonMode: next.jsonMode === undefined ? cur.jsonMode : !!next.jsonMode,
    updatedAt: new Date().toISOString(),
    by,
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MODEL_CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

/** Key 来源：配置文件优先，其次环境变量，最后 WorkBuddy 配置（沿用原有回退顺序） */
export function resolveApiKey(cfg = loadModelConfig()) {
  if (cfg.apiKey && String(cfg.apiKey).trim()) {
    return { key: String(cfg.apiKey).trim(), source: 'config', label: '系统管理里配置的 Key' };
  }
  if (process.env.DEEPSEEK_API_KEY) {
    return { key: process.env.DEEPSEEK_API_KEY, source: 'env', label: '环境变量 DEEPSEEK_API_KEY' };
  }
  const cfgPath = path.join(os.homedir(), '.workbuddy', 'models.json');
  if (fs.existsSync(cfgPath)) {
    const wb = readJson(cfgPath, []);
    const ds = (Array.isArray(wb) ? wb : []).find(m => typeof m.url === 'string' && m.url.includes('deepseek') && m.apiKey);
    if (ds) return { key: ds.apiKey, source: 'workbuddy', label: 'WorkBuddy 配置 models.json（兜底）' };
  }
  throw new Error('未配置 API Key：请到「系统管理 → 模型与接口设置」里填一个，或设置环境变量 DEEPSEEK_API_KEY');
}

/** 运行时生效的连接参数（调用模型时用这个） */
export function activeModel() {
  const cfg = loadModelConfig();
  const p = getProvider(cfg.providerId);
  const { key, source, label } = resolveApiKey(cfg);
  return {
    providerId: p.id, providerName: p.name,
    baseUrl: cfg.baseUrl || p.baseUrl,
    url: chatCompletionsUrl(cfg.baseUrl || p.baseUrl),
    model: cfg.model,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    jsonMode: cfg.jsonMode !== false,
    caps: p.caps || {},
    apiKey: key, keySource: source, keyLabel: label,
  };
}

/**
 * 「给指定服务商用哪把 Key」—— 拉取模型列表 / 测试连接这类"换服务商"的场景必须用它。
 *
 * WARN: 不能直接用 resolveApiKey()。它返回的是「系统当前生效的那把 Key」
 *   （本机是环境变量里的 DeepSeek Key）。拿它去问智谱/百炼/Kimi 会同时造成两个后果：
 *     ① 必然 401（界面上表现为"拉取失败，下面是内置回退清单"）；
 *     ② 凭据泄露 —— DeepSeek 的 Key 被发给了第三方服务商。
 *   2026-09-27 因此把规则收紧为：一把 Key 只能用在它所属的那家服务商上。
 *
 * 规则（按优先级）：
 *   ① 本次请求里现填的 Key → 管理员明确要用它，允许用于任意服务商（换家试 Key 的正常流程）
 *   ② 配置里存的 Key → 只属于配置里选的那家（cfg.providerId 相同才用）
 *   ③ 环境变量 DEEPSEEK_API_KEY、WorkBuddy models.json → 都是 DeepSeek 的 Key，只给 DeepSeek 用
 *   ④ 都没有 → 返回 usable:false，调用方应提示"这家还没配 Key"，而不是拿别家的 Key 去撞
 *
 * @param {string} providerId 目标服务商 id
 * @param {{overrideKey?: string}} [opt] overrideKey 为本次请求现填的 Key
 * @returns {{key:string, usable:boolean, source:string, label:string}}
 */
export function keyForProvider(providerId, { overrideKey = '' } = {}) {
  const pid = providerId || '';
  const body = String(overrideKey || '').trim();
  if (body) return { key: body, usable: true, source: 'override', label: '本次填入的 Key' };

  const cfg = loadModelConfig();
  if (cfg.apiKey && String(cfg.apiKey).trim()) {
    if (cfg.providerId === pid) {
      return { key: String(cfg.apiKey).trim(), usable: true, source: 'config', label: '系统管理里配置的 Key' };
    }
    return {
      key: '', usable: false, source: 'other-provider',
      label: `系统里配的是「${getProvider(cfg.providerId).name}」的 Key，不能拿到这家用`,
    };
  }

  if (process.env.DEEPSEEK_API_KEY) {
    if (pid === 'deepseek') return { key: process.env.DEEPSEEK_API_KEY, usable: true, source: 'env', label: '环境变量 DEEPSEEK_API_KEY' };
    return { key: '', usable: false, source: 'other-provider', label: '环境变量里那把是 DeepSeek 的 Key，不能拿到这家用' };
  }

  try {
    const cfgPath = path.join(os.homedir(), '.workbuddy', 'models.json');
    const wb = readJson(cfgPath, []);
    const ds = (Array.isArray(wb) ? wb : []).find(m => typeof m.url === 'string' && m.url.includes('deepseek') && m.apiKey);
    if (ds) {
      if (pid === 'deepseek') return { key: ds.apiKey, usable: true, source: 'workbuddy', label: 'WorkBuddy 配置 models.json（兜底）' };
      return { key: '', usable: false, source: 'other-provider', label: '兜底那把是 DeepSeek 的 Key，不能拿到这家用' };
    }
  } catch { /* 读不到就当没有 */ }

  return { key: '', usable: false, source: 'none', label: '这家还没配 API Key' };
}

/**
 * 审核实际用哪个模型名 —— 唯一口径（流水线、报告落款、启动日志都用它）。
 *
 * 规则（2026-09-27 确定）：
 *   · DeepSeek 家 → 固定 `deepseek-flash`（AUDIT_MODEL_DEEPSEEK），忽略设置里那一栏。
 *     理由见 providers.mjs：那一栏的默认值是老别名 `deepseek-chat`，让它生效会让审核悄悄换档，
 *     费用与效果同时变化。2026-09-27 曾实际发生该回归，之后改为固化。
 *   · 其它服务商（智谱/百炼/Kimi/自定义）→ 用设置里的模型名；没填就用该服务商预置列表的第一项。
 *     这类情况不能固定成 deepseek-flash：把 DeepSeek 的模型名发给别家会直接报错。
 *
 * @param {object} [cfg] 模型配置，默认现读 model-config.json
 * @returns {string} 生效的模型名
 */
export function auditModelName(cfg = loadModelConfig()) {
  const p = getProvider(cfg.providerId);
  if (p.id === 'deepseek') return AUDIT_MODEL_DEEPSEEK;
  return String(cfg.model || '').trim() || (p.models && p.models[0]) || AUDIT_MODEL_DEEPSEEK;
}

/** 打码后的摘要（给界面看，不含明文 Key） */
export function modelConfigSummary() {
  const cfg = loadModelConfig();
  const p = getProvider(cfg.providerId);
  let keyInfo;
  try {
    const { key, label } = resolveApiKey(cfg);
    keyInfo = { hasKey: true, fingerprint: String(key).slice(0, 7) + '…', source: label };
  } catch (e) {
    keyInfo = { hasKey: false, fingerprint: '', source: e.message };
  }
  return {
    config: { ...cfg, apiKey: '' },          // 明文 Key 不回传
    key: keyInfo,
    provider: { id: p.id, name: p.name, note: p.note, caps: p.caps, applyUrl: p.applyUrl, topupUrl: p.topupUrl, docsUrl: p.docsUrl },
    providers: PROVIDERS.map(x => ({
      id: x.id, name: x.name, baseUrl: x.baseUrl, models: x.models, keyHint: x.keyHint,
      applyUrl: x.applyUrl, topupUrl: x.topupUrl, docsUrl: x.docsUrl, note: x.note, caps: x.caps,
    })),
  };
}
