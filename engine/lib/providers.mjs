/**
 * 审核模型常量与内置服务商预置表。
 *
 * DeepSeek 家的审核模型固定为 deepseek-flash（2026-09-27 确定）。
 *
 * 为什么固定、而不是读「模型与接口设置」里那一栏：
 *   ① 那一栏的默认值历史上是 `deepseek-chat`（老别名）。一旦让它生效，审核会悄悄从 flash 档换掉，
 *      费用与效果都随之改变 —— 2026-09-27 实际发生过该回归，之后改为固化。
 *   ② DeepSeek 官方接口只认 `deepseek-flash` 与 `deepseek-v4-pro`：
 *      经实测传 `deepseek-v4.1-flash` 被 400 拒绝（The supported API model names are …）。
 *      所以"固化到更细的版本号"在官方接口上跑不通；`deepseek-v4-flash` 也只是落到 `deepseek-flash`。
 *   ③ 需要换档时改这一个常量即可，且启动日志会打出「审核模型」，不会再悄悄变。
 *
 * 换到别的服务商（智谱/百炼/Kimi/自定义）时不固定：那种情况必须用设置里的模型名，
 * 否则会把 deepseek-flash 发给别家、直接报错。见 model-config.mjs 的 auditModelName()。
 */
export const AUDIT_MODEL_DEEPSEEK = 'deepseek-flash';

/**
 * 大模型服务商预置表（内置，不联网）
 *
 * 为什么要预置：换模型最容易错的就是 base_url 和模型名。这里把国内常用服务商的
 * OpenAI 兼容接口、常见模型名、申请 Key / 充值 / 文档地址都内置好，管理员只需要：
 *   ① 选服务商 → ② 填 API Key → ③ 测试连接 → ④ 保存。
 *
 * WARN: 接口地址可能随服务商调整，所以 baseUrl 与模型名在界面上都可改；
 *   这里的值只是"默认填好"，不是硬编码。
 * WARN: 全部走 OpenAI 兼容协议（POST {baseUrl}/chat/completions），换服务商不用改代码。
 *
 * 2026-09-27 两处调整：
 *   ① 只留常用的 4 家 + 自定义：原来内置 9 家（硅基流动 / MiniMax / 阶跃 / 混元不常用）已删除，
 *      少而准比多而旧好维护。要接别的服务商走「自定义（任意 OpenAI 兼容）」。
 *   ② 模型名列表只是回退值：各家模型换代很快（智谱早已不是 glm-4.6、Kimi 已到 kimi-k3、
 *      DeepSeek 现行名是 deepseek-flash / deepseek-v4-pro），所以界面提供
 *      「↻ 拉取最新模型」——直接调服务商的 `GET {baseUrl}/models` 取实时列表，
 *      下面这些写死的名字只在"拉不到"时用（无网络 / 该服务商不提供 /models / Key 不对）。
 */
export const PROVIDERS = [
  {
    id: 'deepseek',
    name: 'DeepSeek（深度求索）',
    baseUrl: 'https://api.deepseek.com',
    // 2026-09-27 经实测：GET /models 只返回 deepseek-flash 与 deepseek-v4-pro；
    // deepseek-chat 仍可用（本系统原用），保留在列表里方便切回。
    models: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat'],
    keyHint: 'sk-…',
    applyUrl: 'https://platform.deepseek.com/api_keys',
    topupUrl: 'https://platform.deepseek.com/top_up',
    docsUrl: 'https://api-docs.deepseek.com/zh-cn/',
    note: '本系统原用服务商。分闲时/忙时计费，缓存命中价约为未命中的 1/50；本系统按它的价目表做费用估算，换别家后费用口径需按实际单价理解。',
    caps: { jsonMode: true, vision: false, cacheHitField: 'prompt_cache_hit_tokens' },
  },
  {
    id: 'zhipu',
    name: '智谱 AI（GLM）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    // 2026-09 官方在售：glm-5.3-flash / glm-5.3-flashx / glm-5.3 / glm-5.2（见 docs.bigmodel.cn）
    models: ['glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.3', 'glm-5.2'],
    keyHint: '形如 xxxxxxxx.xxxxxxxx',
    applyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    topupUrl: 'https://open.bigmodel.cn/finance/pay',
    docsUrl: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction',
    note: '走 OpenAI 兼容接口（/chat/completions）。GLM-5.3-Flash 系原生多模态、上下文 1M，Flash 系常有免费额度。',
    caps: { jsonMode: true, vision: true, cacheHitField: 'prompt_tokens_details.cached_tokens' },
  },
  {
    id: 'bailian',
    name: '阿里云百炼（通义千问 Qwen）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    // 2026-09 官方在售：qwen3.8-max / qwen3.7-plus / qwen3.8-flash（见百炼「选择模型」）
    models: ['qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-plus', 'qwen3.8-omni-flash'],
    keyHint: 'sk-…（百炼控制台生成的 API Key）',
    applyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    topupUrl: 'https://bailian.console.aliyun.com/',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/get-api-key',
    note: '百炼的 OpenAI 兼容模式：base_url 必须带 /compatible-mode/v1。同一个 Key 也能调它托管的 glm-5.2、kimi-k3 等第三方模型。',
    caps: { jsonMode: true, vision: true, cacheHitField: 'prompt_tokens_details.cached_tokens' },
  },
  {
    id: 'moonshot',
    name: '月之暗面 Kimi（Moonshot）',
    baseUrl: 'https://api.moonshot.cn/v1',
    // 2026-09 官方在售：kimi-k3（1M 上下文、原生视觉）/ kimi-k2.7-code / kimi-k2.6
    // WARN: kimi-k2.x、moonshot-v1 系列已下线（2026-08-31 / 2026-05-25），不要再填老名字
    models: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'],
    keyHint: 'sk-…',
    applyUrl: 'https://platform.moonshot.cn/console/api-keys',
    topupUrl: 'https://platform.moonshot.cn/console/account',
    docsUrl: 'https://platform.kimi.com/docs/models',
    note: '长文本见长（kimi-k3 上下文 1M），适合超长报告；上下文越长单价越高。',
    caps: { jsonMode: true, vision: true, cacheHitField: 'prompt_tokens_details.cached_tokens' },
  },
  {
    id: 'custom',
    name: '自定义（任意 OpenAI 兼容服务）',
    baseUrl: '',
    models: [],
    keyHint: '按服务商要求填写',
    applyUrl: '',
    topupUrl: '',
    docsUrl: '',
    note: '内网自建（vLLM / Ollama / LM Studio / one-api 网关）或其它云服务：填 base_url（到 /v1 为止）、模型名、Key 即可。填好 base_url 与 Key 后也能用「↻ 拉取最新模型」列出来。',
    caps: { jsonMode: true, vision: false, cacheHitField: 'prompt_tokens_details.cached_tokens' },
  },
];

export function getProvider(id) {
  return PROVIDERS.find(p => p.id === id) || PROVIDERS[0];
}

/** 拼出 chat/completions 地址（容错：末尾多余的 / 与已带 /chat/completions 的写法） */
export function chatCompletionsUrl(baseUrl) {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  if (/\/chat\/completions$/.test(b)) return b;
  return b + '/chat/completions';
}

/**
 * 拼出「列出模型」地址：OpenAI 兼容服务是 `GET {baseUrl}/models`。
 * 四家（DeepSeek / 智谱 / 百炼 / Kimi）经实测都提供这个端点（无 Key 返回 401 = 端点存在）。
 * 容错：末尾多余的 /；已经写成 /chat/completions 的也先剥掉再拼。
 */
export function modelsListUrl(baseUrl) {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  const base = b.replace(/\/chat\/completions$/, '');
  return base + '/models';
}

/**
 * 从服务商返回的模型列表里挑出「能用来对话」的，滤掉嵌入/重排/图像/语音/视频等。
 * 为什么要滤：百炼的 /models 会返回几百个（text-embedding、qwen-image、wan、asr、tts…），
 * 不滤的话下拉框里根本找不到要选的对话模型。
 * @param {string[]} ids
 * @returns {string[]}
 */
export function filterChatModels(ids) {
  const NOISE = /(embedding|embed|rerank|^text-|tts|asr|speech|audio|voice|whisper|image|video|wan\d|happyhorse|happyoyster|ocr|moderation|dall|stable|flux|sora|realtime|realtime|qwen-audio|qwen-image|qwen-tts|qwen3-omni-asr|codex-|bge-|gme-)/i;
  return (ids || []).filter(id => typeof id === 'string' && id.trim() && !NOISE.test(id));
}

/** 该服务商是否支持「图片理解」（预置表里的默认值；具体看模型，见 modelSupportsVision） */
export function providerSupportsVision(id) {
  return !!(getProvider(id).caps || {}).vision;
}

/**
 * 某个具体模型是否支持图像理解（图表核对会用到，不支持时界面要提示）。
 *
 * 为什么不能只看服务商：换模型是自由的（还能从 /models 拉实时列表），
 * 服务商级别的一个布尔值说明不了具体模型 —— 智谱既有纯文本模型也有原生多模态的。
 * 所以按模型名做启发式判断，认不出来时退回该服务商的默认值。
 * WARN: 这只是提示：真能不能读图，以服务商文档为准（判错的后果只是"勾了图表核对却没生效"或反过来）。
 */
export function modelSupportsVision(providerId, model) {
  const m = String(model || '');
  if (!m) return providerSupportsVision(providerId);
  const VISION = /(^|[-_/])(vl|vision|omni)\d*([-_]|$)|glm-4v|glm-5\.3|glm-ocr|glm-image|kimi-k3|qwen3\.[0-9]+-(max|omni)|qwen-vl|gpt-4o|gpt-5|claude|gemini/i;
  const TEXT_ONLY = /deepseek-(chat|flash|v[0-9]|reasoner|coder)|kimi-k2\.7-code|kimi-k2\.6|glm-4\.(5|6)|qwen3\.[0-9]+-(plus|flash|turbo|long)/i;
  if (VISION.test(m)) return true;
  if (TEXT_ONLY.test(m)) return false;
  return providerSupportsVision(providerId);
}
