/**
 * 模型与接口设置 自检（零 API；只校验预置表、地址拼接、配置读写与"不泄露 Key"）
 *
 * 用临时 WB_DATA_DIR，不访问线上配置。
 * 用法：node engine\test-model-config.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modelcfg-'));
process.env.WB_DATA_DIR = tmp;

const { PROVIDERS, getProvider, chatCompletionsUrl, modelsListUrl, filterChatModels, modelSupportsVision, AUDIT_MODEL_DEEPSEEK } = await import('./lib/providers.mjs');
const M = await import('./lib/model-config.mjs');

let pass = 0, fail = 0;
const ok = (c, n, extra = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${extra ? '  ← ' + extra : ''}`); } };
const eq = (a, b, n) => ok(a === b, n, `实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`);

console.log('\n── 1. 预置服务商表 ──');
{
  // 2026-09-27 口径：只保留常用的 4 家 + 自定义（原为 9 家）
  eq(PROVIDERS.length, 5, '内置服务商恰好 5 项（DeepSeek / 智谱 / 百炼 / Kimi / 自定义）');
  const ids = new Set(PROVIDERS.map(p => p.id));
  eq(ids.size, PROVIDERS.length, '服务商 id 不重复');
  for (const need of ['deepseek', 'zhipu', 'bailian', 'moonshot', 'custom']) {
    ok(ids.has(need), `含 ${need}`);
  }
  for (const gone of ['siliconflow', 'minimax', 'stepfun', 'hunyuan']) {
    ok(!ids.has(gone), `不常用的 ${gone} 已删除`);
  }
  eq(PROVIDERS[PROVIDERS.length - 1].id, 'custom', '「自定义」排在最后（逃生口，不占常用位）');
  const bad = PROVIDERS.filter(p => p.id !== 'custom' && !/^https:\/\//.test(p.baseUrl));
  ok(bad.length === 0, '除「自定义」外都内置了 https 接口地址', bad.map(b => b.id).join(','));
  const linkless = PROVIDERS.filter(p => p.id !== 'custom' && !p.applyUrl);
  ok(linkless.length === 0, '除「自定义」外都内置了「申请 Key」网址', linkless.map(b => b.id).join(','));
  const modelLess = PROVIDERS.filter(p => p.id !== 'custom' && !(p.models || []).length);
  ok(modelLess.length === 0, '除「自定义」外都预填了常见模型名');
}

console.log('\n── 1b. 模型名必须跟得上换代（回归：别再写几年前的名字）──');
{
  const all = PROVIDERS.flatMap(p => p.models || []);
  // 这些是各家 2026-09 在售的现行名（写死的清单需与经实测/官方文档一致）
  for (const now of ['deepseek-flash', 'deepseek-v4-pro', 'glm-5.3-flash', 'glm-5.3', 'qwen3.8-max', 'qwen3.8-flash', 'kimi-k3']) {
    ok(all.includes(now), `列表里有现行模型名 ${now}`);
  }
  // 已下线 / 过时的名字不再作为预置
  for (const old of ['glm-4.6', 'glm-4-plus', 'kimi-k2-0905-preview', 'moonshot-v1-128k', 'qwen-turbo']) {
    ok(!all.includes(old), `过时名字 ${old} 已从预置里移除`);
  }
  // deepseek-chat 保留：经实测仍可用，且生产正在使用（便于切回）
  ok(all.includes('deepseek-chat'), 'deepseek-chat 保留（实测可用、生产在用）');
}

console.log('\n── 1c. 列模型的地址拼接与「对话模型」过滤 ──');
{
  eq(modelsListUrl('https://api.deepseek.com'), 'https://api.deepseek.com/models', '普通 base_url');
  eq(modelsListUrl('https://api.deepseek.com/'), 'https://api.deepseek.com/models', '末尾多余的 /');
  eq(modelsListUrl('https://x.cn/v1/chat/completions'), 'https://x.cn/v1/models', '已带 /chat/completions 先剥掉再拼');
  eq(modelsListUrl(''), '', '空地址返回空（调用方跳过）');

  const raw = [
    'qwen3.8-max', 'qwen3.8-flash', 'glm-5.3-flash', 'kimi-k3', 'deepseek-v4-pro',
    'text-embedding-v4', 'qwen3-rerank', 'qwen-image-3.0-pro', 'wan3.0-video',
    'qwen-audio-3.1-asr-flash-streaming', 'qwen3.8-omni-flash-realtime', 'glm-ocr',
  ];
  const chat = filterChatModels(raw);
  for (const keep of ['qwen3.8-max', 'qwen3.8-flash', 'glm-5.3-flash', 'kimi-k3', 'deepseek-v4-pro']) {
    ok(chat.includes(keep), `保留对话模型 ${keep}`);
  }
  for (const drop of ['text-embedding-v4', 'qwen3-rerank', 'qwen-image-3.0-pro', 'wan3.0-video', 'qwen-audio-3.1-asr-flash-streaming', 'glm-ocr']) {
    ok(!chat.includes(drop), `滤掉非对话模型 ${drop}`);
  }
  eq(filterChatModels([]).length, 0, '空列表不炸');
  eq(filterChatModels(['', null, undefined, 'kimi-k3']).length, 1, '空值/脏值被丢掉');

  // 图像理解：按具体模型名判断（服务商级布尔值说明不了具体模型）
  eq(modelSupportsVision('zhipu', 'glm-5.3-flash'), true, 'GLM-5.3-Flash 原生多模态 → 支持读图');
  eq(modelSupportsVision('deepseek', 'deepseek-v4-pro'), false, 'deepseek-v4-pro 判为纯文本');
  eq(modelSupportsVision('bailian', 'qwen3.8-max'), true, 'qwen3.8-max 支持图像理解');
  eq(modelSupportsVision('moonshot', 'kimi-k3'), true, 'kimi-k3 支持视觉');
  eq(modelSupportsVision('zhipu', '自己瞎编的模型'), true, '认不出来时退回该服务商默认值');
}

console.log('\n── 2. 接口地址拼接 ──');
{
  eq(chatCompletionsUrl('https://api.deepseek.com'), 'https://api.deepseek.com/chat/completions', '普通 base_url');
  eq(chatCompletionsUrl('https://api.deepseek.com/'), 'https://api.deepseek.com/chat/completions', '末尾多余的 /');
  eq(chatCompletionsUrl('https://x.cn/v1/chat/completions'), 'https://x.cn/v1/chat/completions', '已带 /chat/completions 不重复拼');
  eq(chatCompletionsUrl(''), '', '空地址返回空（由调用方报错）');
}

console.log('\n── 3. 配置读写（临时目录）──');
{
  const def = M.loadModelConfig();
  eq(def.providerId, 'deepseek', '默认服务商 DeepSeek');
  // 默认值必须与"审核实际用的模型"一致（DeepSeek 家固定 flash），否则界面显示与实际调用不符
  eq(def.model, AUDIT_MODEL_DEEPSEEK, `默认模型＝审核实际用的 ${AUDIT_MODEL_DEEPSEEK}（不再是老别名 deepseek-chat）`);
  const saved = M.saveModelConfig({ providerId: 'zhipu', model: 'glm-4.6', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'test-key-123' }, { by: '自检' });
  eq(saved.providerId, 'zhipu', '保存后服务商已切换');
  eq(saved.by, '自检', '记录了修改人');
  const again = M.loadModelConfig();
  eq(again.model, 'glm-4.6', '重新读取仍是保存后的模型');
  eq(again.baseUrl, 'https://open.bigmodel.cn/api/paas/v4', 'base_url 持久化正确');
  const a = M.activeModel();
  eq(a.url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions', '运行时调用地址按配置拼接');
  eq(a.apiKey, 'test-key-123', '运行时取到配置里的 Key');
  ok(a.providerName.includes('智谱'), '运行时知道当前服务商是谁', a.providerName);
}

console.log('\n── 4. 界面摘要不泄露 Key ──');
{
  const s = M.modelConfigSummary();
  eq(s.config.apiKey, '', '配置对象里的 apiKey 一律抹掉，不回传前端');
  ok(s.key.hasKey === true && /…$/.test(s.key.fingerprint), '只回传打码指纹', JSON.stringify(s.key));
  ok(!JSON.stringify(s).includes('test-key-123'), '整个摘要里搜不到明文 Key');
  ok(s.providers.length === PROVIDERS.length, '摘要里带上全部预置服务商（供界面下拉）');
}

console.log('\n── 4b. Key 只能用在它所属的服务商上（回归：2026-09-27 真事故）──');
{
  // 事故复盘：拉取模型列表时使用了"系统当前生效的 Key"，把环境变量里的 DeepSeek Key
  // 发给了智谱/百炼/Kimi —— 使用方看到"拉取失败 401 + 内置清单"，同时造成凭据泄露。
  // 现在规则：① 现填的 Key 可用于任意服务商；② 配置里的 Key 只配给配置中该家；
  //          ③ 环境变量/回退来源（均为 DeepSeek 的）只给 DeepSeek。
  const saved = M.loadModelConfig();      // 上面第 3 节已把配置存成 zhipu + test-key-123

  const p1 = M.keyForProvider('zhipu');
  eq(p1.key, 'test-key-123', '配置里那家（智谱）能用配置里的 Key');
  eq(p1.usable, true, '判定为可用');

  const p2 = M.keyForProvider('bailian');
  eq(p2.key, '', '**别家不许用配置里的 Key**（不泄露给第三方）');
  eq(p2.usable, false, '判定为不可用（界面应提示"这家还没配 Key"，而不是拿别家的去撞 401）');
  ok(/智谱/.test(p2.label), '提示里说清"配的是哪家的 Key"', p2.label);

  const p3 = M.keyForProvider('bailian', { overrideKey: 'sk-just-typed' });
  eq(p3.key, 'sk-just-typed', '这次现填的 Key 允许用于任意服务商（换家试 Key 的正常流程）');
  eq(p3.usable, true, '现填的 Key 判定可用');

  const p4 = M.keyForProvider('moonshot');
  eq(p4.usable, false, '既没配置也没现填 → 不可用');
  const p5 = M.keyForProvider('custom');
  eq(p5.usable, false, '自定义服务商同理（不会偷偷用别家的 Key）');

  // 环境变量那条路径：显式造一个环境变量，别依赖"跑测试的这台机器有没有设"
  process.env.DEEPSEEK_API_KEY = 'sk-env-deepseek-test';
  M.saveModelConfig({ apiKey: '' }, { by: '自检' });      // 清掉配置里的 Key，使其走环境变量路径
  const e1 = M.keyForProvider('deepseek');
  eq(e1.key, 'sk-env-deepseek-test', 'DeepSeek 用环境变量里的 Key');
  eq(e1.source, 'env', '标明来源是环境变量');
  const e2 = M.keyForProvider('zhipu');
  eq(e2.usable, false, '**环境变量那把（DeepSeek 的）不许给智谱用** ← 这就是 2026-09-27 泄露事故的根因');
  ok(/DeepSeek/.test(e2.label), '提示里说明"环境变量里那把是 DeepSeek 的"', e2.label);
}

console.log('\n── 4c. 审核模型固定规则（回归：模型被设置悄悄换掉）──');
{
  // 事故复盘（2026-09-27）：流水线原先将模型名硬编码为 MODELS.flash；改为"读取配置的模型名"后，
  // 配置默认值是老别名 deepseek-chat → 审核静默换档（使用方即时发现并纠正）。
  // 现在口径：DeepSeek 家固定 deepseek-flash；换到别家才用设置里的模型名。
  M.saveModelConfig({ providerId: 'deepseek', model: 'deepseek-chat' }, { by: '自检' });
  eq(M.auditModelName(), AUDIT_MODEL_DEEPSEEK, 'DeepSeek 家：**即使设置里写 deepseek-chat，审核仍用 flash**');
  eq(M.auditModelName(), 'deepseek-flash', `固定值就是 deepseek-flash（当前 ${AUDIT_MODEL_DEEPSEEK}）`);

  M.saveModelConfig({ providerId: 'zhipu', model: 'glm-5.3-flash' }, { by: '自检' });
  eq(M.auditModelName(), 'glm-5.3-flash', '智谱：用设置里的模型名（否则会把 deepseek 的模型名发给智谱，直接报错）');
  M.saveModelConfig({ providerId: 'zhipu', model: '' }, { by: '自检' });
  eq(M.auditModelName(), 'glm-5.3-flash', '智谱：设置里没填 → 用该服务商预置列表第一项');

  M.saveModelConfig({ providerId: 'custom', model: 'my-local-model' }, { by: '自检' });
  eq(M.auditModelName(), 'my-local-model', '自定义服务商：用设置里的模型名');
  M.saveModelConfig({ providerId: 'custom', model: '' }, { by: '自检' });
  eq(M.auditModelName(), AUDIT_MODEL_DEEPSEEK, '自定义且没填模型名 → 退回 flash（不至于给出空模型名）');

  // 官方接口只认这两个名字（经实测 deepseek-v4.1-flash 会被 400 拒绝），不要写错
  const dsModels = PROVIDERS.find(p => p.id === 'deepseek').models;
  ok(dsModels.includes(AUDIT_MODEL_DEEPSEEK), `DeepSeek 预置列表含固定用的 ${AUDIT_MODEL_DEEPSEEK}`);
  ok(!dsModels.includes('deepseek-v4.1-flash'), '预置列表里没有 deepseek-v4.1-flash（官方接口不认，实测 400）');
}

console.log('\n── 5. 换服务商不影响已有能力标记 ──');
{
  const zhipu = getProvider('zhipu');
  ok(zhipu.caps && zhipu.caps.jsonMode === true, '智谱标记支持 JSON 模式');
  eq(getProvider('unknown-provider').id, 'deepseek', '未知服务商回退到 DeepSeek（不崩）');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n合计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}\n`);
process.exit(fail ? 1 : 0);
