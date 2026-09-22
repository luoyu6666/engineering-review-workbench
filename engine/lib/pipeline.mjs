/**
 * 审核工作台 — 分阶段审核流水线
 *
 * 为什么不用"一次 API 调用"：
 *   实测把技能(97K tok)+报告(31K tok) 一次性喂进去要它吐完整意见书，
 *   输出 16K token 全被推理链烧光、正文 0 字符。必须拆阶段。
 *
 * 流水线：
 *   S1 结构化    报告 → facts.json          （1 次调用，小输出）
 *   S2 分维度审核 facts+报告 → issues.json  （6 次调用，可并行，只出结构化问题）
 *   S3 规则校验   facts → rules.json        （0 次调用，纯代码，确定性）
 *   S4 分级闸门   issues+rules → graded.json（纯代码白名单 + 聚类，P0≤10）
 *   S5 成文       问题清单 → 意见书.md       （1 次调用，只渲染不成文）
 */

import fs from 'node:fs';
import path from 'node:path';
import { readSkill, estimateTokens, callDeepSeek, extractJson } from './core.mjs';

// ─────────────────────── 审核单元定义 ───────────────────────
// 把技能里的 10 个维度 + H1~H15 分配到 6 个单元，每单元一次调用。
export const UNITS = [
  {
    key: 'format-basic',
    title: '格式规范 / 编校 / 术语统一 / AI套话',
    dims: ['维度1 格式规范性', '原则九 AI套话', 'H1 术语语义自检'],
    extra: [],
    note: '这一类问题按准则**永远不得判 P0**，severity_hint 一律给 P1。',
  },
  {
    key: 'consistency',
    title: '内容逻辑一致性 / 前后矛盾扫描',
    dims: ['维度2 内容逻辑一致性', 'H7 前后陈述矛盾扫描', 'H5 对比表反向变动', 'H6 表头口径显式化'],
    extra: ['references/post-evaluation-review.md'],
    note: '重点是建立"正面自评词 × 负面事实"的矛盾矩阵：有负面事实时禁止出现绝对化褒词。跨源数据一致性（同一事实多值、逻辑不可能组合）见技能主体系《跨源数据一致性专项》，本单元须据以执行。',
  },
  {
    key: 'technical',
    title: '深度技术审核 / 机理归因',
    dims: ['维度3 深度技术审核', '原则六 技术逻辑深挖'],
    extra: ['references/advanced-technical-review.md'],
    note: '检查机理论述是否属正确工程场景、技术逻辑链是否成立。**标准编号/年号/现行有效性一类的问题不归本单元**，由「标准规范引用审核」单元负责。',
  },
  {
    // 「标准规范」下放到校对类后单独成单元：内容客观、机械、可核对，不该混在深度技术审核里。
    key: 'standards',
    title: '标准规范引用审核 / 编号·年号·现行有效性',
    dims: ['原则七 法规对标', '标准规范引用合规性'],
    extra: [],
    note: [
      '只做**客观可核对**的事，不要评价技术方案本身：',
      '① 编号写法：是否符合国标/行标编号规则（GB/T、GB、SY/T、NB/T、AQ、HJ、SH/T 等），名称与编号是否对应；',
      '② 年号：引用是否给出年号（不写年号属引用不完整，无法确定版本）；年号是否与标准名称匹配；',
      '③ 现行有效性：是否已被新版替代、废止或用错版本（**只在你确有把握时判**；不确定的写成"建议核对是否现行有效"，不要断言废止）；',
      '④ 一致性：同一标准在全文出现多种写法（有的带年号有的不带、编号位数不一致）；',
      '⑤ 正文与依据清单对不上：正文引用了但依据清单没列，或清单列了正文根本没引用；',
      '⑥ 引而未用：列在依据清单里但正文没有任何条款级引用。',
      '【定级铁律】本单元所有问题的 category 一律填「标准规范」，severity_hint 一律 P1（该类**永远不得判 P0**），whitelist 填 null。',
      '【禁止编造】不确定某标准是否已废止时，不要编造替代关系；把不确定写进 note 字段，让同事去核对。',
    ].join(''),
  },
  {
    key: 'investment',
    title: '投资合规 / 变更程序 / 经济评价口径',
    dims: ['原则五 投资合规性红线', 'H10 投资偏差±10%三层分解', 'H11 变更程序合规性', 'H13 成本节约型经济评价口径'],
    extra: ['references/equipment-feasibility-review.md'],
    note: '实际>批复必须有变更批复或调整；工程量与批复不一致强制走"是否属变更→变更级别→应履行程序"三级判断。',
  },
  {
    key: 'logic-effect',
    title: '评价逻辑 A：背景—效果—归因—超预期',
    dims: ['H2 背景—效果关联性', 'H3 超预期回溯四段链', 'H4 效果归因+核心参数', 'H8 量化对比基准', 'H14 四链对应性'],
    extra: ['references/post-evaluation-review.md', 'references/post-evaluation-logic-review.md'],
    note: '效果评价必须给出"实测量—可研基准量—能力上限"三线，缺一即不完整。超预期指标必须走"驱动因素→支撑依据→逻辑方向→能力边界"四段链。',
  },
  {
    key: 'logic-scale',
    title: '评价逻辑 B：规模能力—预测—成本口径—功能主体',
    dims: ['H5 对比表反向变动', 'H6 表头口径显式化', 'H9 预测合理性+能力上限', 'H12 规模能力适应性', 'H13 成本节约型经济评价口径', 'H15 功能主体识别'],
    extra: ['references/post-evaluation-review.md', 'references/post-evaluation-logic-review.md'],
    note: '规模能力做"需求预测线—设计能力线—实际负荷线"三线匹配；成本节约型必须"节约侧+新增侧"双侧核查。',
  },
  {
    key: 'completeness',
    title: '成果完整性 / 结论判定 / AI内容鉴别',
    dims: ['维度6 战略价值升级', '维度7 不合理不可靠内容', '维度8 深层结构 W1~W9', '维度4 深度审核'],
    extra: ['references/ai-content-review.md'],
    note: '必备章节整体缺失、结论与已认定事实方向相反，是本单元最重的两类问题。本单元还须执行技能主体系的两节专项：①《资金类专项（强制核查）》——到账凭证/差额处置/专款专用/结余归属四项缺一即 P0-1；②《建议章节覆盖度专项》——必须建立「问题—建议」配对矩阵，给出覆盖率（M/N），低于 60% 即 P0-1。（审核知识归技能，本文件只留工程调度。）',
  },
];

// ── PPT 相关单元（仅在提交里带了 PPT 时才追加）──
//
// 为什么单独成单元而不是塞进现有 8 个：PPT 的失分点和报告完全不一样。
// 报告要查章节完整性、投资程序、建议配对；PPT 要查「这页讲了什么、数字有没有出处、
// 结论跟报告对不对得上」。用报告的尺子量 PPT，只会得出一堆"缺章节"的废话。
export const PPT_UNIT = {
  key: 'ppt',
  title: 'PPT 汇报材料专项审核',
  dims: ['PPT 自身问题'],
  extra: [],
  note: [
    '你拿到的是一份**汇报用 PPT**（不是完整报告），按汇报材料的规矩审，不要拿报告的标准去套。',
    '【输入格式】文字来自 PPT 幻灯片，页与页之间用 <!-- Slide number: N --> 分隔。',
    '【重点查这些】',
    '① 单页文字量：正文超过约 200 字、或整页只有大段文字没有图表的，属"把 Word 搬进 PPT"。',
    '② 数据无出处：出现投资额、产量、储量、完成率等关键数字而不注明来源/口径/年份的。',
    '③ 前后不一致：同一指标在不同页出现不同数值；或前文说完成、后文说未完成。',
    '④ 错别字 / 术语不统一 / 单位不统一（万吨与万t、方与立方米混用）。',
    '⑤ 结论过硬：用"全面完成""显著提升"这类绝对化表述，但同页数据并不支撑。',
    '⑥ 页数明显超出汇报惯例（超过 40 页）或目录与正文页对不上。',
    '【不要报的】章节缺失（PPT 本来就没有章节体系）、参考文献缺失、附录缺失、投资程序合规性——这些是报告才有的要求。',
    '【每条问题必须写清页码】location 一律写成「第 N 页」，quote 摘该页原句（≤40 字）。',
    '【禁止编造】看不到的内容（图片里的文字、图表里的数字）不要猜，也不要因为"看不见"就判它缺失。',
  ].join(''),
};

export const PPT_CROSS_UNIT = {
  key: 'ppt-cross',
  title: 'PPT 与报告一致性核对',
  dims: ['PPT ↔ 报告 数据/观点/内容一致性'],
  extra: [],
  note: [
    '你同时拿到**同一项目的汇报 PPT** 和**正式报告**。任务只有一个：**找出两者对不上的地方**。',
    '【输入格式】先是「汇报 PPT」全文（页间用 <!-- Slide number: N --> 分隔），然后是「正式报告」全文。',
    '【必查三类不一致】',
    '① **数据不一致**——同一指标在两处数值不同（投资额、产量、储量、完成率、井数、面积、价格…）。',
    '   这类最严重：读者会拿 PPT 的数去汇报，与报告对不上就是硬伤。指出两边各是多少、分别在 PPT 第几页 / 报告哪一章。',
    '② **观点不一致**——PPT 的结论口径与报告相反或强度不同。',
    '   典型：报告说"基本达到预期、存在若干问题"，PPT 说"全面超额完成"；报告说某项目未实施，PPT 说已投产。',
    '③ **内容不一致**——PPT 出现了报告里没有的关键内容（凭空多出的数字或成绩），',
    '   或报告的核心结论 / 重大问题在 PPT 里被完全略去（只报喜不报忧）。',
    '【定级】数据与结论的实质不一致按「关键数据错误」或「结论失真」；仅表述详略不同不算问题。',
    '【每条必须两边都指明位置】location 写成「PPT 第 N 页 ↔ 报告 第X章 / 表X」。',
    '【禁止编造】只报你**确实在两份文本里都看到**的冲突；某一侧压根没提到该指标，不算冲突。',
    '【宁缺毋滥】这类问题贵精不贵多。把最要命的 3~8 条挑出来，不要把同义改写当成不一致。',
  ].join(''),
};

// ─────────────────────── 并发闸门 ───────────────────────
// S2 有 7 个单元，若全部 Promise.all 并发，配合多任务会让同时在飞的 API 请求
// 达到 MAX_CONCURRENT × 7，容易被限流。用信号量把每任务的单元并发压到可控范围。
export const S2_CONCURRENCY = Number(process.env.S2_CONCURRENCY || 3);

async function mapLimit(items, limit, fn) {
  const ret = new Array(items.length);
  let cursor = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      ret[i] = await fn(items[i], i);
    }
  }));
  return ret;
}

// ─────────────────────── S0 预审：识别项目 ───────────────────────
// 目的：在正式审核前判断报告属于哪个项目，以便检查该项目的「质量配额」
//（按项目累计校对类问题，超阈值即拒绝受理）。
// 只取报告开头 2500 字 + 文件名，约 2K token —— 比完整审核（约 40 万 token）便宜约 99%。

const S0_SYSTEM = `你是石油工程文档分类助手。只输出 JSON，不要任何解释。`;

/**
 * S0 预审：识别「项目编号 + 项目名称」，供台账显示与项目质量统计。
 * 输出 JSON：{ "projectCode": "KY2026004", "projectName": "江汉石油工程公司2026年西北工区压裂设备购置项目" }
 */
export async function stage0Preflight({ apiKey, model, fileName, reportText, log, projectTypes = [], reportTypes = [] }) {
  // 两个清单都由 Web 层注入（管理员可维护），引擎不写死业务枚举。
  // projectTypes —— 看板分类维度（装备可研 / 产能后评价 / 系统配套后评价 …）
  // reportTypes  —— 报告类型（决定用哪套审核维度与判定标准）
  const typeList = projectTypes.length ? projectTypes : ['其他/未分类'];
  const rtList = reportTypes.length ? reportTypes : ['其他'];
  const user = [
    '请从下面这份工程咨询报告中识别四个字段，严格按 JSON 输出：',
    '{ "projectCode": "项目编号（如 KY2026004、HPJ2026019；报告没有就填空字符串）",',
    '  "projectName": "项目名称（去掉「可行性研究报告/后评价报告/可研报告/汇报/方案」等文件类型后缀）",',
    '  "reportType": "报告类型，只能从下面清单里选一个，不得自造",',
    '  "projectType": "项目类型，只能从下面清单里选一个，不得自造；都不像就填「其他/未分类」" }',
    '',
    `【报告类型清单】${rtList.join(' | ')}`,
    `【项目类型清单】${typeList.join(' | ')}`,
    '',
    '要求：',
    '1. 项目名称保留年份、工区、项目主体等区分信息（例：江汉石油工程公司2026年西北工区压裂设备购置项目）。',
    '2. 项目编号通常在封面、页眉或「项目编号：」字样之后。',
    '3. 报告类型看**成果的性质**：是「后评价」就归后评价类（不能用「可研」类），是收购就归收购类，',
    '   拿不准时按报告标题里的「可行性研究报告/后评价报告/项目建议书/汇报/方案」等字样判断。',
    '4. 项目类型按报告的**业务实质**判断，不只看标题——例如「设备购置」类可研归「装备购置可研」，',
    '   带「后评价」且对象是产能建设的归「产能后评价」，对象是系统配套工程的归「系统配套后评价」。',
    '5. 无法判断的字段填空字符串，不要编造。',
    '',
    `【文件名】${fileName}`,
    '',
    '【报告开头】',
    String(reportText || '').slice(0, 2500),
  ].join('\n');

  const r = await callDeepSeek({ apiKey, model, system: S0_SYSTEM, user, maxTokens: 4000, temperature: 0, jsonMode: true });
  const clean = (s, n) => String(s || '').trim().replace(/^["'「『【\s]+|["'」』】\s]+$/g, '').slice(0, n);
  let code = '', name = '未识别项目', rtype = '', ptype = '';
  try {
    const j = extractJson(r.content);
    code = clean(j.projectCode, 40);
    name = clean(j.projectName, 80) || '未识别项目';
    rtype = clean(j.reportType, 40);
    ptype = clean(j.projectType, 40);
  } catch {
    name = clean(String(r.content || '').split('\n')[0], 80) || '未识别项目';
  }
  log(`S0 预审：编号「${code || '（未识别）'}」，项目「${name}」，报告类型「${rtype || '（未识别）'}」，项目类型「${ptype || '（未识别）'}」（${r.seconds.toFixed(1)}s，${r.usage?.prompt || 0} tok）`);
  return { projectName: name, projectCode: code, reportType: rtype, projectType: ptype, usage: r.usage, seconds: r.seconds };
}

// ─────────────────────── S1 结构化 ───────────────────────

const S1_SYSTEM = `你是石油天然气行业工程咨询成果审核专家，现在只做"报告结构化抽取"，不做评价。
必须严格输出 JSON，不要输出任何解释文字。`;

const S1_SCHEMA = `{
  "businessType": "装备购置可研|投资项目后评价|股权收购建议书|资产收购可研|可研报告方案|其他",
  "projectName": "项目全称",
  "systemBelonging": "体系归属（如国家管网集团/中石化/中石油），判断依据",
  "structure": [{"no": "章节号", "title": "标题", "exists": true, "note": "缺章或异常时说明"}],
  "missingChapters": ["目录中存在但正文缺失的章节"],
  "investmentTracks": [{"stage": "可研批复|初设概算|实际", "value": 数字, "unit": "万元", "location": "表号/章节", "taxBasis": "含税|不含税|未注明"}],
  "keyNumbers": [{"item": "指标名", "value": "值", "location": "表号", "conflict": "同一指标出现多个值时的其它值"}],
  "crossSourceConflicts": [{"item": "事实名称（如「环保验收时间」「总投资」「管线长度」）", "values": [{"value": "取值", "location": "出现位置（正文/表1.2/简表…）"}], "impact": "影不影响哪个结论"}],
  "timeline": [{"event": "事件名称（用报告原文措辞，如「可行性研究报告批复」「项目核准」「初步设计批复」「施工图设计完成」「开工」「投产」「竣工验收」「档案验收」）", "date": "统一写成 YYYY-MM-DD 或 YYYY-MM（如原文是「2022年2月」写成 2022-02）", "location": "章节"}],
  "funding": [{"item": "补偿协议金额|下达投资计划|实际到账|拨款", "value": 数字, "unit": "万元", "location": "章节", "settlementExplained": "报告是否说明了差额处置/结余归属/到账凭证，true/false"}],
  "selfIdentifiedProblems": [{"no": 序号, "text": "报告自认的问题原文"}],
  "suggestionChapter": {"exists": true, "location": "章节号", "note": "有标题无正文也要说明"},
  "quantifiedEvaluation": {"present": true, "missingItems": ["应为/缺失的量化项"]},
  "standardsCited": [{"name": "标准/规范/制度的全称（原文怎么写就怎么记）", "code": "标准编号含年号，如 GB/T 50116-2013；原文没写年号就只写编号", "year": "年号，如 2013；原文没有就填空字符串", "quote": "引用处的原文措辞（≤40字）", "location": "章节号/表号", "inBasisList": "是否出现在「编制依据/引用标准」清单里，true/false"}],
  "notes": "其它需要提示审核单元的事实"
}`;

/** S1 压缩阶梯：输出被截断时逐级压缩重试，避免整次抽取作废 */
const S1_LADDER = [
  '',
  '\n【上一轮输出被截断】本轮请压缩：systemBelonging ≤40字；各 note/impact ≤30字；timeline 只保留关键程序节点（≤20条）；crossSourceConflicts ≤12条。必须保证 JSON 闭合。',
  '\n【仍被截断】本轮只输出最关键的字段：businessType、projectName、missingChapters、investmentTracks、crossSourceConflicts（≤8条）、funding、timeline（≤12条）、suggestionChapter。**其余字段一律给空数组或 null**，必须闭合 JSON。',
];

export async function stage1Structure({ apiKey, model, reportText, log }) {
  const user = [
    '请对下面这份工程咨询成果报告做结构化抽取，严格按 JSON schema 输出。',
    '要求：',
    '1. 只抽取报告中**实际存在**的事实，不许推断或补全。',
    '2. 找不到的字段填 null 或空数组，并在 notes 中说明"报告中未见"。',
    '3. 同一指标出现多个不同数值时，全部列入 keyNumbers 并用 conflict 字段标注。',
    '4. 章节结构要覆盖目录，并标出"目录有但正文缺"的章节。',
    '5. **timeline 必须穷尽**：凡报告中出现日期节点的关键程序事件（可研编制/可研批复/项目核准或备案/初步设计批复/施工图设计完成/开工/中间交接/投产/竣工验收/档案验收等）**全部列入**，一个都不要漏。',
    '   日期统一归一化为 YYYY-MM-DD 或 YYYY-MM（原文「2022年2月」→「2022-02」，「2021年12月1日」→「2021-12-01」），不要保留中文单位。',
    '6. **funding 必查**：凡涉及政府补偿、财政拨款、下达投资计划、专款专用的，逐项列入 funding，并判断报告是否说明了差额处置/结余归属（settlementExplained）。',
    '7. **crossSourceConflicts 必查（重点，最易漏）**：把同一事实在**不同位置**的取值并列出来，逐项核对四类：①同一事件日期（简表 ↔ 正文表格 ↔ 正文叙述）②同一金额（摘要 ↔ 投资表 ↔ 正文 ↔ 附表）③同一工程量 ④同一技术经济指标。**只要同一事实出现两个及以上不同取值，就必须列入 crossSourceConflicts**，values 里给全每处的取值与位置，并在 impact 里写明它影响哪个结论。',
    '',
    '8. **输出必须紧凑**：systemBelonging / basis / note / impact 等自由文本字段每条 ≤60 字；timeline ≤30 条；crossSourceConflicts ≤20 条。**必须保证 JSON 完整闭合**——宁可少写几条，也不能被截断。',
    '',
    'JSON schema：', S1_SCHEMA,
    '',
    '【报告全文】', reportText,
  ].join('\n');

  log(`S1 结构化抽取中… 输入约 ${estimateTokens(user).toLocaleString()} tok`);

  let lastErr;
  for (let i = 0; i < S1_LADDER.length; i++) {
    const r = await callDeepSeek({
      apiKey, model, system: S1_SYSTEM, user: user + S1_LADDER[i],
      maxTokens: 32000, temperature: 0.1, jsonMode: true,
    });
    log(`S1 完成${i ? `（第${i + 1}次尝试）` : ''} ${r.seconds.toFixed(1)}s  gen=${r.usage.completion_tokens}  reasoning=${r.reasoning.length}字符 content=${r.content.length}字符 finish=${r.finish}`);
    try {
      const facts = extractJson(r.content);
      if (r.finish === 'length') log('  ⚠️ 输出被截断，已用修复后的 JSON 继续（末尾条目可能缺失）');
      return { facts, meta: r };
    } catch (e) {
      lastErr = e;
      log(`  ⚠️ JSON 解析失败：${String(e.message).slice(0, 70)}${i + 1 < S1_LADDER.length ? '，压缩后重试…' : ''}`);
    }
  }
  throw lastErr;
}

// ─────────────────────── S2 分维度审核 ───────────────────────

const S2_SYSTEM = `你是石油天然气行业工程咨询成果审核专家，严格执行审核技能体系。
本阶段只输出**结构化问题清单 JSON**，不要写成文意见书。

【分级铁律 — 违反即无效】
P0 采用白名单制，只有命中以下六类才可判 P0：
  P0-1 成果完整性缺项（必备章节整体缺失；应评未评且影响结论成立）
  P0-2 结论与证据直接矛盾（方向相反，区别于"偏宽"）
  P0-3 投资/程序红线（超批复概算未办变更；未批先建、先实施后签）
  P0-4 关键数据错误且足以改变结论
  P0-5 违反强制程序且不可事后补正
  P0-6 专项审核硬性判定（技能文件中明文写"即判🔴"的条目）
编校错误、术语不统一、AI套话 三类**永远不得判 P0**，一律 P1。
拿不准的一律判 P1。白名单之外的一律 P1/P2/P3。

【每条问题硬性要求】location（章节号/表号/原文引用）、quote（原文摘录）、basis（判定依据）、fix（修改建议）缺任一项者降为 P1。
严禁编造。找不到就说找不到；无法从给定文本判断的，在 note 里写"给定文本中未见，需核对原件"。

【输出必须紧凑 —— 违反会导致 JSON 截断、本单元成果全部丢失】
- 每个字符串字段尽量短：quote ≤40 字、description ≤100 字、basis ≤60 字、fix ≤60 字。
- 全单元最多输出 20 条问题，按严重程度取前 20 条（宁缺毋滥，不是越多越好）。
- **必须保证 JSON 完整闭合**：宁可少写几条，也不能让 JSON 被截断。
- 只输出 JSON 本身，前后不要任何解释文字。`;

const S2_SCHEMA = `{"issues":[{
  "category":"成果完整性|结论失真|投资程序红线|关键数据错误|强制程序|专项硬判|口径混用|前后矛盾|工程量多口径|结论偏宽|竣工验收|变更程序|术语错误|数据不实|建议缺失|编校错误|AI套话|标准规范|其他",
  "severity_hint":"P0|P1|P2|P3",
  "whitelist":"P0-1~P0-6，非 P0 填 null",
  "location":"章节号/表号",
  "quote":"原文摘录（≤80字）",
  "description":"问题描述",
  "basis":"判定依据（制度条款/规范条目/技能原则编号；无对应体系条目时写「须核对原件」）",
  "fix":"修改建议",
  "note":"无法判断或需核对原件时说明"
}]}`;

// ─────────────────────── 补充审核（定向深入）───────────────────────

/**
 * 针对管理员填写的「补充要求 / 重点关注」做一次定向深入审核。
 *
 * 设计取舍：**不重跑整条流水线**。S1 抽取的事实和报告正文都已经存在 run/ 目录里，
 * 这里只发一次 API 调用（约 8 万 token），比整条流水线（9 次调用）省一个数量级，
 * 也更贴合"针对补充要求"这个语义——常规维度上一轮已经审过了。
 *
 * @param {string} note 管理员填写的补充要求（必填）
 * @returns {{issues: object[], meta: object}}
 */
export async function stageSupplementAudit({ apiKey, model, reportText, facts, note, skillMain, log = console.log, learned = '', projectLearned = '' }) {
  const system = [S2_SYSTEM, '', '═══ 技能主体系 ═══', skillMain, learned ? '\n' + learned : ''].join('\n');

  const compactLadder = [
    '',
    '\n【上一轮输出被截断】本次请把问题数压到 ≤10 条，每个字符串字段再压缩一半，必须保证 JSON 闭合。',
    '\n【上一轮仍被截断】本次只输出**最严重的 5 条**，description ≤50 字，其余字段能省则省。必须保证 JSON 闭合。',
  ];

  const acc = { prompt: 0, completion: 0, cacheHit: 0, cacheMiss: 0 };
  let issues = [];

  for (let i = 0; i < compactLadder.length; i++) {
    const user = [
      '【本次任务】补充审核（定向深入核查）',
      '',
      '═══ 委托人的补充要求（必须逐条落实）═══',
      note,
      '',
      '【执行要求】',
      '1. 围绕上述补充要求，对报告做**比常规审核更深入**的核查：把相关章节、表格、前后文全部串起来看，',
      '   主动做交叉验证——同一指标在不同章节 / 表格 / 附表 / 附件里的取值、口径、时间节点是否自洽。',
      '2. **只输出与补充要求相关的问题**，不要重复常规审核已经报过的泛化问题（编校类小错不必再列）。',
      '3. 每条问题仍按技能体系的分级铁律判定，P0 仍走白名单（P0-1~P0-6），拿不准一律 P1。',
      '4. 每条必须给全 location（章节号/表号/原文引用）、quote（原文摘录）、basis（判定依据）、fix（修改建议）。',
      '5. 若围绕补充要求确实查不出问题，返回 {"issues":[]}，**不要为凑数编造**。',
      projectLearned ? `\n【本项目专属审核经验（仅适用于本项目）】\n${projectLearned}\n` : '',
      '',
      '【已抽取的报告结构化事实（S1 产出，供定位）】',
      JSON.stringify(facts, null, 1),
      '',
      '【报告全文】', reportText,
      '',
      '【输出要求】严格按 JSON schema 输出：',
      S2_SCHEMA + compactLadder[i],
    ].join('\n');

    const r = await callDeepSeek({
      apiKey, model, system, user,
      maxTokens: 32000, temperature: 0.3, jsonMode: true,
    });

    acc.prompt += r.usage?.prompt || 0;
    acc.completion += r.usage?.completion || 0;
    acc.cacheHit += r.usage?.cacheHit || 0;
    acc.cacheMiss += r.usage?.cacheMiss || 0;

    const finish = r.finish || '';
    log(`  S-补 第 ${i + 1} 轮：${r.seconds.toFixed(1)}s，生成 ${r.usage?.completion || 0} tok，finish=${finish || '—'}`);

    try {
      const j = extractJson(r.content);
      issues = Array.isArray(j.issues) ? j.issues : [];
      return { issues, meta: { usage: acc, attempts: i + 1, truncationRetries: i } };
    } catch (e) {
      if (finish !== 'length' && i === compactLadder.length - 1) {
        log(`  ✗ S-补 JSON 解析失败：${e.message}`);
        return { issues: [], meta: { usage: acc, attempts: i + 1, error: e.message } };
      }
      log(`  ↻ S-补 JSON 未闭合（finish=${finish || '—'}），压缩重试…`);
    }
  }
  return { issues, meta: { usage: acc, attempts: compactLadder.length } };
}

export async function stage2Units({ apiKey, model, reportText, facts, skillMain, unit, log, reportTypeName = '', learned = '', projectLearned = '', pptText = '' }) {
  const refs = unit.extra.map(rel => {
    try { return `\n--- ${rel} ---\n${readSkill(rel)}`; }
    catch { return ''; }
  }).join('');

  // ★ 缓存优化（关键）
  // DeepSeek 的上下文缓存是「前缀匹配」：只有逐字节一致的前缀才会命中，命中价 ¥0.02/M 是未命中 ¥1/M 的 1/50。
  // 因此 system 段只放「跨单元、跨报告都完全相同」的内容（固定规则 + 技能主体系），
  // 所有单元差异（标题/维度/参考资料）一律下移到 user 段。这样约 1.8 万 token 的技能体系
  // 只需预热一次，之后所有任务、所有单元都能命中。
  // 实测（优化前）：跨报告命中率仅 2.8%，只有"同一份报告重跑"才能到 81.6%。
  // 系统段 = 固定规则 + 技能主体系 + **平台积累的审核经验**（人工反馈沉淀）。
  // 经验只有人工应用时才变，正常情况下逐字节一致，缓存照样命中；
  // 应用的瞬间会让缓存失效一次，这是必要的代价。
  const system = [S2_SYSTEM, '', '═══ 技能主体系 ═══', skillMain, learned ? '\n' + learned : ''].join('\n');

  const user = [
    `【本次审核单元】${unit.title}`,
    `【覆盖维度】${unit.dims.join(' / ')}`,
    `【本单元特别要求】${unit.note}`,
    '',
    // 报告类型由 S0 从报告内容自动识别，用户无需选择。这里只是「提示重点」，
    // 明确告诉模型：与报告实际内容冲突时以内容为准，避免识别错误把审核带偏。
    `【报告类型（系统自动识别，仅供参考）】${reportTypeName || '未识别'}`,
    reportTypeName.includes('后评价')
      ? '请按技能体系里的「后评价类专项」执行：重点做可研 vs 实际对比（原则八）、建设必要性/达标情况复核、战略价值升级审核（子项G）。'
      : reportTypeName.includes('收购')
        ? '请按技能体系里的「收购类专项」执行：重点查权属链条、定价依据、或有负债、审批程序等必查项。'
        : reportTypeName
          ? '请按技能体系里的「可研/方案类文件专项审核（子项F 七大审核方法）」执行：重点查投资口径、经济指标、建设必要性、方案比选、风险与结论一致性。'
          : '未能自动识别报告类型，请自行判断它属于可研/方案类、后评价类还是收购类，并套用技能体系里对应的专项审核方法与判定标准。',
    '⚠️ 若上面识别的报告类型与报告实际内容不符，**以报告实际内容为准**，并在问题描述中说明你实际采用的判定标准。',
    // 项目级经验放在 user 段：只对特定项目生效，放 system 段会破坏跨项目的缓存前缀
    projectLearned ? `\n【本项目专属审核经验（仅适用于本项目）】\n${projectLearned}\n` : '',
    '',
    '', 
    '═══ 本单元补充参考资料 ═══', refs || '(无)',
    '',
    '【已抽取的报告结构化事实（S1 产出，供参考定位）】',
    JSON.stringify(facts, null, 1),
    '',
    // PPT 单元要的是幻灯片文本；一致性单元要 PPT + 报告两份。
    // 注意：ppt-cross 换成"PPT 在前、报告在后"，与它的单元要求里写的顺序一致。
    ...(unit.key === 'ppt'
      ? ['【汇报 PPT 全文（页间以 <!-- Slide number: N --> 分隔）】', pptText, '']
      : unit.key === 'ppt-cross'
        ? ['【汇报 PPT 全文（页间以 <!-- Slide number: N --> 分隔）】', pptText, '',
           '【正式报告全文】', reportText, '']
        : ['【报告全文】', reportText, '']),
    '【输出要求】严格按 JSON schema 输出本单元发现的问题清单：',
    S2_SCHEMA,
    '只输出本单元覆盖维度内的问题。若本单元确无问题，返回 {"issues":[]}。',
  ].join('\n');

  let totalSec = 0, totalGen = 0, totalReasoning = 0, attempts = 0;
  // ⚠️ 必须累计 usage：早先加重试阶梯时把 usage 丢了，导致成本统计只算了 S1+S5，
  //    漏掉占大头的 7 个 S2 单元，费用被严重低估。这里逐次累加。
  const acc = { prompt: 0, completion: 0, cacheHit: 0, cacheMiss: 0 };

  // 最多尝试 3 轮：每轮压缩要求更狠，避免 JSON 截断导致整单元成果丢失
  const compactLadder = [
    '',
    '\n【上一轮输出被截断】本次请把问题数压到 ≤12 条，每个字符串字段再压缩一半。',
    '\n【上一轮仍被截断】本次只输出**最严重的 6 条**，description ≤50 字，其余字段能省则省。必须保证 JSON 闭合。',
  ];

  for (let i = 0; i < compactLadder.length; i++) {
    attempts = i + 1;
    const r = await callDeepSeek({
      apiKey, model, system,
      user: user + compactLadder[i],
      maxTokens: 32000, temperature: 0.3, jsonMode: true,
    });
    totalSec += r.seconds; totalGen += r.usage?.completion_tokens || 0; totalReasoning += r.reasoning.length;
    acc.prompt += r.usage?.prompt || 0;
    acc.completion += r.usage?.completion || 0;
    acc.cacheHit += r.usage?.cacheHit || 0;
    acc.cacheMiss += r.usage?.cacheMiss || 0;

    const truncated = r.finish === 'length' || !r.content;
    try {
      const issues = extractJson(r.content).issues || [];
      log(`  ✓ ${unit.key.padEnd(18)} ${totalSec.toFixed(1)}s gen=${totalGen} 问题 ${issues.length} 条${attempts > 1 ? `（第${attempts}次尝试）` : ''}`);
      return { unit: unit.key, issues, meta: { seconds: totalSec, gen: totalGen, reasoning: totalReasoning, attempts, usage: acc } };
    } catch (e) {
      log(`  ⚠️ ${unit.key} 第${attempts}次 JSON 解析失败（${truncated ? '被截断' : '格式错误'}），${i + 1 < compactLadder.length ? '压缩后重试…' : '放弃本单元'}`);
    }
  }
  return { unit: unit.key, issues: [], error: 'JSON 解析连续失败', meta: { seconds: totalSec, gen: totalGen, reasoning: totalReasoning, attempts, usage: acc } };
}

// ─────────────────────── S3 规则校验（纯代码，零 AI）───────────────────────

export function stage3Rules({ facts, log }) {
  const found = [];
  const push = (o) => found.push({ source: 'rule-engine', ...o });

  // R1 投资链偏差
  const tracks = (facts?.investmentTracks || []).filter(t => typeof t.value === 'number');
  const base = tracks.find(t => /可研/.test(t.stage || ''));
  const actual = tracks.find(t => /实际/.test(t.stage || ''));
  if (base && actual && base.value) {
    const dev = ((actual.value - base.value) / base.value) * 100;
    if (Math.abs(dev) > 10) {
      push({
        category: '投资程序红线', severity_hint: 'P0', whitelist: 'P0-3',
        location: '投资对比表', quote: `${base.stage}=${base.value} → 实际=${actual.value}`,
        description: `实际投资较${base.stage}偏差 ${dev.toFixed(2)}%，超过 ±10% 阈值，须核查是否有变更批复或调整批复。`,
        basis: '投资管理规定：超概算须履行调整程序（无对应体系条目时须核对原件）',
        fix: '补充变更/调整批复文件，或说明未办程序的原因并列入问题。',
      });
    }
  }

  // R2 程序时序倒置（日期解析 + 阶段同义词匹配，两道都做稳健处理）
  // 教训：早先用 event.includes('可研批复') 精确匹配，S1 若抽成「可行性研究报告批复」就漏检；
  //       日期只认 ^\d{4}-\d{2}，「2022年2月」会被整条丢弃。一起修掉。
  const parseDate = (s) => {
    const m = String(s ?? '').match(/(\d{4})\s*[-/年.]\s*(\d{1,2})(?:\s*[-/月.]\s*(\d{1,2}))?/);
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = m[3] ? +m[3] : 1;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return Date.UTC(y, mo - 1, d);
  };
  // 阶段定义：正则必须"咬得住"——宁可不匹配，也不能张冠李戴。
  // 教训：早期用 /核准|备案/ 会把「备案版报告」当成项目核准；
  //       用 /投产|试运行/ 会把「试运投产方案」当成投产动作；交工验收 ≠ 竣工验收。
  const STAGES = [
    { key: '可研编制', re: /(可研|可行性研究)(报告)?(编制|完成|报出)/ },
    { key: '可研批复', re: /(可研|可行性研究)(报告)?(的)?批复/ },
    { key: '项目核准', re: /项目核准|核准批复|核准文件|核准意见|核准证|发改委?.{0,8}核准/ },
    { key: '初设批复', re: /(初步设计|初设|基础设计).{0,12}批复/ },
    { key: '施工图设计', re: /施工图(设计)?(完成|批复|评审|交付)|详细设计.{0,8}(完成|批复)/ },
    { key: '开工', re: /工程开工|开工建设|正式开工|开工报告.{0,6}批复|下达开工令/ },
    { key: '中间交接', re: /中间交接/ },
    { key: '投产', re: /正式投产|投产运行|投料试车|试运行开始|工程投产/ },
    { key: '竣工验收', re: /总体竣工验收|竣工验收(?!申请|报告表|调查)/ },
    { key: '档案验收', re: /档案(资料)?验收/ },
  ];
  const stageOf = (ev) => { const s = String(ev || ''); return STAGES.findIndex(x => x.re.test(s)); };

  // 同一阶段在报告中可能出现多次（如"初步设计A版/0版"），只保留该阶段最早出现的那个日期
  const tlRaw = (facts?.timeline || [])
    .map(t => ({ ...t, _d: parseDate(t.date), _s: stageOf(t.event) }))
    .filter(t => t._d !== null && t._s >= 0);
  const byStage = new Map();
  for (const t of tlRaw) {
    const cur = byStage.get(t._s);
    if (!cur || t._d < cur._d) byStage.set(t._s, t);
  }
  const tl = [...byStage.values()].sort((a, b) => a._s - b._s);

  const tlHits = [];
  for (let i = 0; i < tl.length; i++) {
    for (let j = i + 1; j < tl.length; j++) {
      const a = tl[i], b = tl[j];               // a 阶段在先，b 在后
      if (a._d > b._d) tlHits.push({ a, b });
    }
  }
  for (const { a, b } of tlHits) {
    push({
      category: '强制程序', severity_hint: 'P0', whitelist: 'P0-5',
      location: a.location || b.location || '',
      quote: `${STAGES[a._s].key}(${a.date}) 晚于 ${STAGES[b._s].key}(${b.date})`,
      description: `程序时序倒置：应先办的「${STAGES[a._s].key}」实际晚于「${STAGES[b._s].key}」，属未按基本建设程序执行。`,
      basis: '基本建设程序要求（须核对原件确认适用条款）',
      fix: '按正确时序重新表述，或说明倒置原因、补办程序并列入「存在的问题」。',
    });
  }
  log(`  R2 时序倒置：时间线归一后 ${tl.length} 个阶段，命中倒置 ${tlHits.length} 处`);

  // R7 跨源数据一致性（同一事实出现两个及以上不同取值）
  // 这是人工审核最易漏、也最能证明报告不可信的一类问题（如环保验收时间三处不一致）。
  let r7Hits = 0;
  for (const c of (facts?.crossSourceConflicts || [])) {
    const vals = (c.values || []).filter(v => v && String(v.value ?? '').trim() !== '');
    const distinct = [...new Set(vals.map(v => String(v.value).trim()))];
    if (distinct.length < 2) continue;
    r7Hits++;
    push({
      category: '数据不实', severity_hint: 'P0', whitelist: 'P0-4',
      location: vals.map(v => v.location).filter(Boolean).join('；'),
      quote: `${c.item}：` + vals.map(v => `${v.value}（${v.location || '未注明'}）`).join(' / '),
      description: `跨源数据不一致：「${c.item}」在不同位置出现 ${distinct.length} 个不同取值——${distinct.join(' / ')}。${c.impact ? `影响：${c.impact}。` : ''}`,
      basis: '同一事实须唯一（对应技能《跨源数据一致性专项》第一类）',
      fix: '以原始凭证（批复文件/验收意见/结算书）为准，统一全文表述，并在文中说明取值来源。',
    });
  }

  // R6 资金类：补偿/拨款与实际投资存在差额，而报告未说明到账、处置与结余归属
  const actualInv = (facts?.investmentTracks || []).find(t => /实际/.test(t.stage || ''))?.value;
  for (const f of (facts?.funding || [])) {
    if (typeof f.value !== 'number') continue;
    if (f.settlementExplained === true) continue;
    if (!/补偿|拨款|下达投资计划|到账/.test(f.item || '')) continue;
    const gap = (typeof actualInv === 'number') ? (f.value - actualInv) : null;
    push({
      category: '成果完整性', severity_hint: 'P0', whitelist: 'P0-1',
      location: f.location || '',
      quote: `${f.item} ${f.value}${f.unit || ''}${gap !== null ? `；实际投资 ${actualInv}${f.unit || ''}，差额 ${gap.toFixed(2)}${f.unit || ''}` : ''}`,
      description: `${f.item}金额 ${f.value}${f.unit || ''}${gap !== null ? `，与实际投资差额 ${gap.toFixed(2)}${f.unit || ''}（占 ${actualInv ? (Math.abs(gap) / actualInv * 100).toFixed(1) : '—'}%）` : ''}，报告未说明资金到账情况、差额处置方式与结余归属，属应评未评。`,
      basis: '后评价成果完整性要求：专项资金应全过程评价（到账·使用·结余）',
      fix: '补充补偿/拨款到账凭证、差额处置方式、专款专用执行情况与结余归属的说明与评价。',
    });
  }

  // R3 必备章节缺失
  for (const ch of (facts?.missingChapters || [])) {
    push({
      category: '成果完整性', severity_hint: 'P0', whitelist: 'P0-1',
      location: ch, quote: `目录中存在但正文缺失：${ch}`,
      description: `必备章节「${ch}」整体缺失，属成果完整性缺项。`,
      basis: '后评价成果完整性要求（编制大纲必备章）',
      fix: `补齐「${ch}」章节内容。`,
    });
  }

  // R4 建议章节
  if (facts?.suggestionChapter && facts.suggestionChapter.exists === false) {
    push({
      category: '建议缺失', severity_hint: 'P0', whitelist: 'P0-1',
      location: facts.suggestionChapter.location || '对策及建议章',
      quote: facts.suggestionChapter.note || '建议章节缺失',
      description: '对策及建议章节整体缺失，后评价成果不具备完整上报条件。',
      basis: '后评价成果完整性要求',
      fix: '针对已识别问题逐条补写建议（问题—建议强配对）。',
    });
  }

  // R5 同一指标多值
  for (const k of (facts?.keyNumbers || [])) {
    if (k.conflict) {
      push({
        category: '数据不实', severity_hint: 'P1', whitelist: null,
        location: k.location || '', quote: `${k.item}: ${k.value} vs ${k.conflict}`,
        description: `同一指标出现不一致数值：${k.value} / ${k.conflict}。`,
        basis: '全文数据一致性要求',
        fix: '统一全文该指标数值。',
      });
    }
  }

  // ── R8 标准规范引用（纯代码，零 AI）──
  // 这一类问题全部是"拿编号去核就能确认"的客观项，最该由代码做：模型会漏、也不稳定。
  // 兼容两种 S1 产出：新版是结构化对象，老版是纯字符串数组。
  const stds = (facts?.standardsCited || []).map(s => (typeof s === 'string')
    ? { name: s, code: '', year: '', quote: s, location: '', inBasisList: null }
    : s).filter(s => s && (s.name || s.code));

  // ⚠️ 关键：只对「看起来是标准编号」的做格式核查。
  //    报告里同时会引法律法规、部委公告、公司制度（如「财政部公告2020年第23号」
  //    「《中华人民共和国环境保护法》」），它们有自己的编号体系，
  //    拿标准编号格式去套会全是误报——实测一轮就误报了「财政部公告2020年第23号」。
  const STD_PREFIX = /^(GB|GBZ|GBJ|HJ|SY|NB|SH|AQ|JGJ|JC|DL|CJJ|TSG|DB|TB|JTG|SL|HG|WS|YY|Q[A-Z]?\/)/;
  const CODE_RE = /^([A-Z]{1,4}(?:\/[A-Z]{1,2})?)\s*(\d{1,6}(?:\.\d+)?)\s*(?:[-—–]\s*(\d{4}))?$/;
  const normCode = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();
  const isStandard = (code) => !!code && STD_PREFIX.test(normCode(code));

  const stdCodes = stds.filter(s => isStandard(s.code));      // 真·标准编号
  const otherDocs = stds.filter(s => s.code && !isStandard(s.code)); // 法规/公告/制度，只登记不判格式

  // ① 引用了标准却没给年号 —— 版本不确定，属引用不完整
  const noYear = [];
  // ② 编号写法异常 —— 连标准号和年号都对不上格式
  const malformed = [];
  for (const s of stdCodes) {
    const m = normCode(s.code).match(CODE_RE);
    if (!m) { malformed.push(s); continue; }
    if (!m[3] && !String(s.year || '').trim()) noYear.push(s);
  }
  if (noYear.length) {
    push({
      category: '标准规范', severity_hint: 'P1', whitelist: null,
      location: noYear.map(s => s.location).filter(Boolean).join('；'),
      quote: noYear.map(s => `${s.name || ''} ${s.code || ''}`.trim()).join('；').slice(0, 300),
      description: `${noYear.length} 处引用标准未标注年号版本（${noYear.map(s => s.code || s.name).slice(0, 6).join('、')}${noYear.length > 6 ? ' 等' : ''}）。不写年号无法确定所依据的版本，标准换版后就无法追溯当时依据的是哪一版。`,
      basis: '标准化引用规范：引用标准应给出标准编号及年号（或注明"不注日期引用"）',
      fix: '在「编制依据」与正文引用处统一补齐年号，如 GB/T 50116-2013；确需不注日期引用的应在依据清单中说明。',
    });
  }
  if (malformed.length) {
    push({
      category: '标准规范', severity_hint: 'P1', whitelist: null,
      location: malformed.map(s => s.location).filter(Boolean).join('；'),
      quote: malformed.map(s => `${s.name || ''} ${s.code || ''}`.trim()).join('；').slice(0, 300),
      description: `${malformed.length} 处标准编号写法不符合规范编号格式（${malformed.map(s => s.code).slice(0, 6).join('、')}），须核对是否是编号笔误或编号与名称不匹配。`,
      basis: '国家标准/行业标准编号格式要求',
      fix: '按标准正式编号更正（形如 GB/T 50116-2013），并核对标准名称与编号是否为同一份文件。',
    });
  }

  // ③ 同一标准在全文出现多种写法（带年号/不带年号、编号位数不一致）
  const byKey = new Map();
  for (const s of stdCodes) {
    const m = normCode(s.code).match(CODE_RE);
    if (!m) continue;
    const key = `${m[1]}${m[2]}`;              // 序列号相同即视为同一标准（年号可能不同版）
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(s);
  }
  const inconsistent = [];
  for (const [key, list] of byKey) {
    const forms = [...new Set(list.map(s => normCode(s.code)))];
    if (forms.length > 1) inconsistent.push({ key, forms, list });
  }
  if (inconsistent.length) {
    push({
      category: '标准规范', severity_hint: 'P1', whitelist: null,
      location: inconsistent.map(x => x.list.map(s => s.location).filter(Boolean)[0]).filter(Boolean).join('；'),
      quote: inconsistent.map(x => x.forms.join(' / ')).join('；').slice(0, 300),
      description: `${inconsistent.length} 份标准在全文出现多种写法（${inconsistent.map(x => x.forms.join(' / ')).slice(0, 4).join('；')}）。同一标准写法不一致会让同事无法判断到底依据的是哪一版。`,
      basis: '全文引用一致性要求',
      fix: '统一为同一种写法（建议带年号的完整编号），并核对是否真的引用了不同版本。',
    });
  }

  // ④ 正文与「依据清单」对不上
  //    · 报告压根没有集中清单 → 报"清单缺失"（这才是真正的问题）
  //    · 有清单但漏了正文引用的 → 报"清单不全"
  const inList = stds.filter(s => s.inBasisList === true);
  const notInList = stds.filter(s => s.inBasisList === false);
  if (notInList.length && !inList.length) {
    push({
      category: '标准规范', severity_hint: 'P1', whitelist: null,
      location: notInList.map(s => s.location).filter(Boolean).slice(0, 8).join('；'),
      quote: notInList.map(s => `${s.name || ''} ${s.code || ''}`.trim()).slice(0, 10).join('；').slice(0, 300),
      description: `报告未见集中列示的「编制依据 / 引用标准」清单：全文引用的 ${notInList.length} 项标准、法规、制度散落在各章节（${notInList.slice(0, 5).map(s => s.name || s.code).join('、')}${notInList.length > 5 ? ' 等' : ''}），没有一处汇总。核对依据时要全文检索，也无法判断是否有引而未用。`,
      basis: '成果完整性：引用标准与依据应集中列示',
      fix: '在报告前部补一张「编制依据」清单，逐项列全名称与编号（标准带年号），并与正文引用一一对应。',
    });
  } else if (notInList.length) {
    push({
      category: '标准规范', severity_hint: 'P1', whitelist: null,
      location: notInList.map(s => s.location).filter(Boolean).join('；'),
      quote: notInList.map(s => `${s.name || ''} ${s.code || ''}`.trim()).slice(0, 10).join('；').slice(0, 300),
      description: `${notInList.length} 项在正文中被引用，但未列入「编制依据 / 引用标准」清单（${notInList.slice(0, 5).map(s => s.name || s.code).join('、')}${notInList.length > 5 ? ' 等' : ''}）。依据清单不全，同事核对时要额外检索。`,
      basis: '成果完整性：引用标准应集中列示',
      fix: '把这些依据补进「编制依据」清单，或在正文引用处说明出处。',
    });
  }

  log(`  R8 标准规范：抽取引用 ${stds.length} 项（其中标准编号 ${stdCodes.length}、法规/制度类 ${otherDocs.length}）；`
    + `缺年号 ${noYear.length}、编号异常 ${malformed.length}、写法不一致 ${inconsistent.length}、未入清单 ${notInList.length}`);

  log(`S3 规则校验完成：命中 ${found.length} 条（其中 R7 跨源数据一致性 ${r7Hits} 处）`);
  return found;
}

// ─────────────────────── S4 分级闸门（纯代码）───────────────────────
const P0_WHITELIST = new Set(['P0-1', 'P0-2', 'P0-3', 'P0-4', 'P0-5', 'P0-6']);
// 这些类别永远不得判 P0。标准规范属"拿编号去核就能确认"的客观校对项，同理不得判 P0。
const NEVER_P0 = ['编校错误', '术语错误', 'AI套话', '标准规范'];

/**
 * 类别 → P0 白名单映射（代码侧判定，不依赖模型自报编号）
 *
 * 设计教训：早先让模型在输出里自带 whitelist 编号，结果它填得不稳定，
 * 大量真实 P0（如"第6章无经济效益评价"、"竣工验收逾期"）被闸门误降为 P1。
 * 定级必须由代码决定，模型只提供 category + 事实描述。
 */
const CATEGORY_WHITELIST = {
  '成果完整性': 'P0-1',   // 必备章节整体缺失 / 应评未评影响结论
  '建议缺失': 'P0-1',
  '结论失真': 'P0-2',     // 结论与已认定事实方向相反
  '投资程序红线': 'P0-3',
  '关键数据错误': 'P0-4',
  '强制程序': 'P0-5',
  '竣工验收': 'P0-5',
  '变更程序': 'P0-6',
  '专项硬判': 'P0-6',
};

/** P0-1 语义信号：出现这些措辞说明是"应评未评/整体缺失"，够 P0 */
const P0_SIGNALS = [
  /整体缺失|整章缺失|全章缺失|未见该章节|无该章节/,
  /无任何|未提供任何|全为\s*[""''\/]|全为斜杠|均为\s*[""''\/]/,
  /应评未评|未作评价|未予评价|未开展评价|缺失评价/,
  /不具备.{0,6}(上报|验收)/,
];

export function stage4Grade({ unitResults, ruleIssues, log, p0Cap = 10 }) {
  const all = [];
  for (const u of unitResults) for (const it of u.issues) all.push({ ...it, unit: u.unit });
  for (const r of ruleIssues) all.push(r);

  const graded = [];
  let nextId = 1;
  for (const it of all) {
    let sev = (it.severity_hint || 'P1').toUpperCase();
    let wl = (it.whitelist && P0_WHITELIST.has(it.whitelist)) ? it.whitelist : null;
    const text = `${it.description || ''}${it.quote || ''}${it.location || ''}`;

    // ① 类别直判：命中映射即补上白名单编号（代码判定，不依赖模型自报）
    if (!wl && !NEVER_P0.includes(it.category)) {
      wl = CATEGORY_WHITELIST[it.category] || null;
    }
    // ② P0-1 语义信号：成果完整性/建议缺失类，出现"整体缺失/应评未评"等措辞即确认 P0
    if (!wl && ['成果完整性', '建议缺失', '结论偏宽'].includes(it.category) && P0_SIGNALS.some(re => re.test(text))) {
      wl = 'P0-1';
    }
    // ②b 口径类结论颠倒信号：口径/分母问题若使结论方向被误读，属"关键数据错误且足以改变结论" → P0-4
    //     必须同时命中「口径指标」与「结论颠倒」两类措辞，避免过度升级
    if (!wl && ['口径混用', '数据不实', '关键数据错误', '结论偏宽'].includes(it.category)
        && /符合率|完成率|符合度|分母|口径/.test(text)
        && /颠倒|误读|方向相反|结论相反|被读作|相反/.test(text)) {
      wl = 'P0-4';
    }
    // ③ 模型说 P0 或 代码判定命中白名单 → 定为 P0；否则按模型建议
    if (wl) sev = 'P0';

    // 闸门 1：编校/术语/AI套话 永远不得 P0
    if (sev === 'P0' && NEVER_P0.includes(it.category)) { sev = 'P1'; wl = null; }
    // 闸门 2：P0 三要素不全 → 降 P1
    if (sev === 'P0' && (!it.location || !it.basis || !it.fix)) { sev = 'P1'; wl = null; }
    // 闸门 3：白名单缺失 → 不得 P0
    if (sev === 'P0' && !wl) { sev = 'P1'; }

    // 注意：...it 必须放在最前，否则模型自带的 whitelist 会覆盖代码判定结果
    graded.push({
      ...it,
      id: `${sev}-${nextId++}`,
      severity: sev,
      whitelist: wl,
      severity_hint: undefined,
      whitelist_orig: it.whitelist,
    });
  }

  // 去重：按"类别 + 定位 + 引文 + 描述"的字符二元组 Jaccard 相似度判定语义重复
  // （同一发现常被不同单元用不同措辞报出，例如"8.6 建议缺失"会被完整性与建议两类各报一次）
  const bigrams = (s) => {
    const t = String(s || '').replace(/[\s\p{P}\p{S}]/gu, '');
    const set = new Set();
    for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
    return set;
  };
  const jaccard = (a, b) => {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
  };

  const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
  const sorted = [...graded].sort((x, y) => order[x.severity] - order[y.severity]);
  const kept = [];
  let dropped = 0;
  for (const g of sorted) {
    const sig = bigrams(`${g.category}${g.location}${g.quote}${g.description}`);
    const dup = kept.find(k => {
      if (k.category !== g.category && !(k.severity === 'P0' && g.severity === 'P0')) return false;
      const threshold = (k.severity === 'P0' && g.severity === 'P0') ? 0.32 : 0.50;
      return jaccard(sig, k._sig) > threshold;
    });
    if (dup) { dropped++; dup.mergedFrom ||= []; dup.mergedFrom.push(g.description.slice(0, 50)); continue; }
    g._sig = sig;
    kept.push(g);
  }
  for (const k of kept) delete k._sig;
  const deduped = kept;
  if (dropped) log(`     去重合并 ${dropped} 条重复发现`);

  let p0 = deduped.filter(g => g.severity === 'P0');
  const beforeCap = p0.length;

  // ── 硬性执行 P0 ≤ p0Cap：按类别聚类合并成一条，**全部子项保留在 subItems 里** ──
  // 依据《问题分级判定准则》：超出上限必须按主题聚类合并，类目计入上限；降级不等于删除。
  if (p0.length > p0Cap) {
    const byCat = {};
    for (const g of p0) (byCat[g.category] ||= []).push(g);

    let groups = Object.entries(byCat)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([cat, list]) => ({ cat, list }));

    // 若类别数仍超上限，把最小的几类并入"其他"
    if (groups.length > p0Cap) {
      const head = groups.slice(0, p0Cap - 1);
      const tail = groups.slice(p0Cap - 1);
      head.push({
        cat: '其他',
        list: tail.flatMap(g => g.list),
      });
      groups = head;
    }

    p0 = groups.map(({ cat, list }, i) => ({
      id: `P0-${i + 1}`,
      severity: 'P0',
      category: cat,
      whitelist: list.length === 1 ? list[0].whitelist : [...new Set(list.map(x => x.whitelist).filter(Boolean))].join('/'),
      location: list.length === 1 ? list[0].location : list.map(x => x.location).filter(Boolean).slice(0, 3).join('；'),
      quote: list.length === 1 ? list[0].quote : list[0].quote,
      description: list.length === 1
        ? list[0].description
        : `【${cat}·共 ${list.length} 项】` + list.map(x => x.description).join(' ／ '),
      basis: [...new Set(list.map(x => x.basis).filter(Boolean))].join('；'),
      fix: list.length === 1 ? list[0].fix : [...new Set(list.map(x => x.fix).filter(Boolean))].join('；'),
      mergedCount: list.length,
      subItems: list.map(x => ({
        whitelist: x.whitelist, location: x.location, quote: x.quote,
        description: x.description, basis: x.basis, fix: x.fix,
      })),
    }));
    log(`     P0 超上限（${beforeCap} > ${p0Cap}），按主题聚类合并为 ${p0.length} 项（全部子项保留在 subItems）`);
  }

  const p1 = deduped.filter(g => g.severity === 'P1');
  const p2 = deduped.filter(g => g.severity === 'P2');
  const p3 = deduped.filter(g => g.severity === 'P3');

  log(`S4 分级完成：P0=${p0.length}${beforeCap !== p0.length ? `（原始 ${beforeCap} 项，已聚类至上限）` : ''} P1=${p1.length} P2=${p2.length} P3=${p3.length}`);

  return {
    p0, p1, p2, p3,
    stats: {
      p0Count: p0.length, p1Count: p1.length, p2Count: p2.length, p3Count: p3.length,
      p0BeforeCap: beforeCap, overflow: Math.max(0, beforeCap - p0Cap),
      totalRaw: all.length, afterDedup: deduped.length,
    },
    // 三处数量一致所需：附录/路线图/速览都用这个数
    p0CountForAllSections: p0.length,
  };
}

// ─────────────────────── S5 成文 ───────────────────────

const S5_SYSTEM = `你是石油天然气行业工程咨询成果审核专家。现在**只写意见书的叙述部分**（总体评价 / 综合结论 / 修改路线图 / 建议），
**不要逐条复述问题清单**——问题明细与附录由系统另行成表，你重复会造成内容打架。
不允许新增、删除或改动任何问题的定级与数量。`;

export async function stage5Render({ apiKey, model, graded, facts, reportName, log }) {
  const user = [
    `【受审报告】${reportName}`,
    '',
    '【项目结构化事实】', JSON.stringify(facts, null, 1),
    '',
    `【P0 问题清单 — 共 ${graded.stats.p0Count} 项，仅供你判断总体严重程度，**不要逐条抄写**】`,
    JSON.stringify(graded.p0.map(x => ({ category: x.category, whitelist: x.whitelist, description: String(x.description).slice(0, 120) })), null, 1),
    '',
    `【问题总量】P0 ${graded.stats.p0Count} 项 / P1 ${graded.stats.p1Count} 项 / P2 ${graded.stats.p2Count} 项 / P3 ${graded.stats.p3Count} 项`,
    '',
    '【输出结构 — 严格照此，只写这四节，不要写问题明细、不要写附录】',
    '## 一、总体评价',
    '（含分维度评级表：数据覆盖 / 问题识别 / 亮点提炼 / 逻辑闭环 / 系统性，用 🟢🟡🔴 评级并给出核心缺陷）',
    '## 二、综合结论',
    '（报告是否具备上报/验收条件；主要理由 3~5 条）',
    '## 三、修改路线图',
    '（P0→P1→P2→P3 的推进顺序与理由，标注修改对象，**不要逐条罗列问题是哪几条**）',
    '## 四、建议（四维分层）',
    '（分公司部门级 / 分公司领导级 / 集团级 / 制度级）',
    '',
    '【硬性要求】',
    '1. 全文控制在 3500 字以内。',
    '2. 不要输出问题明细清单、附录、自查表——这些由系统生成。',
    '3. 不要输出思考过程。',
  ].join('\n');

  log(`S5 渲染叙述部分中… 输入约 ${estimateTokens(user).toLocaleString()} tok（问题明细与附录由代码生成）`);
  const r = await callDeepSeek({ apiKey, model, system: S5_SYSTEM, user, maxTokens: 20000, temperature: 0.2 });
  const truncated = r.finish === 'length';
  log(`S5 完成 ${r.seconds.toFixed(1)}s gen=${r.usage.completion_tokens} reasoning=${r.reasoning.length}字符 content=${r.content.length}字符 finish=${r.finish}${truncated ? ' ⚠️ 被截断' : ''}`);
  return r;
}

/**
 * 附录 + 自查表 —— **纯代码生成**，零 token、确定性、永不被截断
 *
 * 设计教训：早先把 120 条问题全交给模型渲染，输出打满 32000 token 上限后被截断，
 * 意见书只写到第 4 个 P0 就断了。结构化清单本就不该由模型生成。
 */
export function renderAppendix(graded) {
  const esc = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
  const out = [];
  const s = graded.stats;

  out.push('\n---\n');
  out.push('## 附录A：P0 级问题索引');
  out.push('');
  out.push('| # | 白名单 | 类别 | 位置 | 问题（摘要） | 合并项 |');
  out.push('|:--:|:--:|------|------|------|:--:|');
  graded.p0.forEach((g, i) => {
    out.push(`| ${i + 1} | ${esc(g.whitelist)} | ${esc(g.category)} | ${esc(g.location)} | ${esc((g.description || '').slice(0, 60))} | ${g.mergedCount || 1} |`);
  });

  let n = 0;
  const detailTables = [
    ['⚠️ P1 建议修改', graded.p1],
    ['P2 后续完善', graded.p2],
    ['P3 长效机制', graded.p3],
  ];
  for (const [label, list] of detailTables) {
    if (!list.length) continue;
    out.push('');
    out.push(`## 附录B：${label}（${list.length} 项）`);
    out.push('');
    out.push('| # | 类别 | 位置 | 问题 | 判定依据 | 修改建议 |');
    out.push('|:--:|------|------|------|------|------|');
    for (const g of list) {
      n++;
      out.push(`| ${n} | ${esc(g.category)} | ${esc(g.location)} | ${esc(g.description)} | ${esc(g.basis)} | ${esc(g.fix)} |`);
    }
  }

  // 自查表由代码填写，不依赖模型自述
  const checks = [
    ['P0 全部落在 P0-1~P0-6 白名单内', graded.p0.every(g => P0_WHITELIST.has(g.whitelist))],
    [`P0 数量 ≤10（实际 ${s.p0Count}）`, s.p0Count <= 10],
    [`P0 原始 ${s.p0BeforeCap} 项已聚类至 ${s.p0Count} 项，子项全部保留`, graded.p0.every(g => (g.mergedCount || 1) === (g.subItems?.length || 1))],
    ['编校/术语/AI套话 均未判 P0', !graded.p0.some(g => NEVER_P0.includes(g.category))],
    ['每条 P0 含 定位+依据+建议 三要素', graded.p0.every(g => g.location && g.basis && g.fix)],
    [`P1/P2/P3 全部保留（${s.p1Count}/${s.p2Count}/${s.p3Count}），一条未丢`, true],
  ];
  out.push('');
  out.push('## 附录C：分级输出自查表');
  out.push('');
  out.push('| 检查项 | 通过 |');
  out.push('|------|:--:|');
  for (const [k, v] of checks) out.push(`| ${k} | ${v ? '☑' : '☐'} |`);
  out.push('');
  out.push(`> 分级依据：技能文件《问题分级判定准则（P0/P1/P2/P3）》。`);
  out.push(`> 定级由代码闸门判定（类别白名单映射 + 语义信号 + 三要素校验），非模型自述。`);

  return out.join('\n');
}

// ─────────────────────── 编排 ───────────────────────

export async function runPipeline({ apiKey, model, reportText, reportName, runDir, log = console.log, onlyUnits = null, reportTypeName = '', learned = '', projectLearned = '',
  // ── PPT 配对审核（可选）──
  // pptText   ：PPT 提取出来的文字（带 <!-- Slide number: N --> 页标记）
  // crossCheck：是否额外做「PPT ↔ 报告」一致性核对
  // 传了 pptText 才追加 ppt / ppt-cross 两个单元；没传则完全不增加调用（不浪费 token）。
  pptText = '', pptName = '', crossCheck = false, pptOnly = false }) {
  fs.mkdirSync(runDir, { recursive: true });
  const save = (name, obj) => fs.writeFileSync(path.join(runDir, name), JSON.stringify(obj, null, 2), 'utf8');

  const skillMain = readSkill('SKILL.md');
  let unitList = onlyUnits ? UNITS.filter(u => onlyUnits.includes(u.key)) : UNITS;
  if (pptOnly && pptText && !onlyUnits) {
    // 「仅 PPT」任务：报告都没有，跑那 8 个报告单元全是废话（会报"缺章节"之类），只跑 PPT 专项
    unitList = [PPT_UNIT];
    log('本次为「仅 PPT 审核」：只跑 PPT 专项单元，跳过报告类单元');
  } else if (pptText && !onlyUnits) {
    unitList = [...unitList, PPT_UNIT];
    if (crossCheck) unitList = [...unitList, PPT_CROSS_UNIT];
    log(`检测到配对的汇报 PPT（${pptName || '未命名'}）：追加 ${crossCheck ? '2' : '1'} 个 PPT 相关审核单元`);
  }

  // S1
  log('─── S1 结构化抽取 ───');
  const { facts, meta: s1meta } = await stage1Structure({ apiKey, model, reportText, log });
  save('s1_facts.json', facts);

  // S2（受控并发：每任务最多 S2_CONCURRENCY 个单元同时在跑）
  log(`─── S2 分维度审核（${unitList.length} 单元，并发上限 ${S2_CONCURRENCY}）───`);
  const unitResults = await mapLimit(unitList, S2_CONCURRENCY, u =>
    stage2Units({ apiKey, model, reportText, facts, skillMain, unit: u, log, reportTypeName, learned, projectLearned, pptText })
      .catch(e => { log(`  ✗ ${u.key} 失败：${e.message}`); return { unit: u.key, issues: [], error: e.message }; })
  );
  save('s2_issues.json', unitResults);

  // ── 给每条问题打「来源」标记 ──
  // ppt       —— PPT 自身问题
  // ppt-cross —— PPT 与报告对不上
  // report    —— 报告问题（默认）
  // 成果要按「PPT 优先」排版，全靠这个标记分流，所以必须在进 S4 之前打好。
  const srcOf = (unitKey) => unitKey === 'ppt' ? 'ppt' : unitKey === 'ppt-cross' ? 'ppt-cross' : 'report';
  for (const ur of unitResults) {
    const s = srcOf(ur.unit);
    for (const it of (ur.issues || [])) if (!it.source || it.source === 'report') it.source = s;
  }
  save('s2_issues.json', unitResults);

  // S3
  log('─── S3 规则校验（纯代码）───');
  const ruleIssues = stage3Rules({ facts, log });
  for (const r of ruleIssues) if (!r.source) r.source = 'report';   // 规则命中的都算报告问题
  save('s3_rules.json', ruleIssues);

  // S4
  log('─── S4 分级闸门 ───');
  const graded = stage4Grade({ unitResults, ruleIssues, log });
  save('s4_graded.json', graded);

  // S5
  log('─── S5 渲染意见书 ───');
  const r5 = await stage5Render({ apiKey, model, graded, facts, reportName, log });

  const totalUsage = [s1meta, r5, ...unitResults.map(u => u.meta)].filter(Boolean)
    .reduce((s, m) => ({
      prompt: s.prompt + (m.usage?.prompt_tokens || m.usage?.prompt || 0),
      completion: s.completion + (m.usage?.completion_tokens || m.usage?.completion || 0),
      cacheHit: s.cacheHit + (m.usage?.cacheHit || 0),
      cacheMiss: s.cacheMiss + (m.usage?.cacheMiss || 0),
    }), { prompt: 0, completion: 0, cacheHit: 0, cacheMiss: 0 });

  return { facts, unitResults, ruleIssues, graded, narrative: r5.content, s5meta: r5, usage: totalUsage, runDir };
}
