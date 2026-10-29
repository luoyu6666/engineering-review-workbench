/**
 * 西北后评价项目：批量生成"审查会议纪要"（管理员用）。
 *
 * 输入：① 项目列表（markitdown 转出的 MD 或直接读 xlsx 的 MD 副本）② 系统内各项目最近一次审核的 P1 条目
 * 输出：Markdown 纪要（再交 md2docx.py 出 Word）
 *
 * 选材口径（经 2026-10-08 与用户确认）：
 *   · 只从 P1 里选，优先带可执行 fix 的"补材料/补充说明/明确/细化"类，排除"重新计算/返工"类；
 *   · 每个项目 ≤4 条（默认 3～4 条），同一类别只留 1 条；
 *   · 逐个分列（不合并同类项目），相邻项目之间做相似度比对，重复度高的换成次优条目。
 *
 * 用法：
 *   node 运维\西北会议纪要\生成纪要.mjs --dry            # 只做匹配与选材（不调用 AI，零成本）
 *   node 运维\西北会议纪要\生成纪要.mjs --limit 6        # 只生成前 6 个项目（试跑）
 *   node 运维\西北会议纪要\生成纪要.mjs                  # 全量生成
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const LIST_MD = process.argv.find((a) => a.startsWith('--list='))?.slice(7)
  || 'D:\\Deepseek harness工作区\\markitdown 转换缓存\\西北会议纪要\\项目列表.md';
const OUT_DIR = path.join(ROOT, '运维', '西北会议纪要', '产出');
const DRY = process.argv.includes('--dry');
const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.slice(8) || 0) || 0;
const PER_PROJECT = Number(process.argv.find((a) => a.startsWith('--items='))?.slice(8) || 0) || 4;
const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

// ── 1. 读项目列表（Markdown 表格）──
function readProjectList() {
  const md = fs.readFileSync(LIST_MD, 'utf8');
  const rows = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/);
    if (m) rows.push({ no: Number(m[1]), name: m[2], kind: m[3], approved: m[4], invest: m[5], doc: m[6] });
  }
  return rows;
}

// ── 2. 项目名归一（用于匹配系统任务；去括号/年份/井号/通用尾词）──
function norm(s) {
  return String(s || '')
    .replace(/[\s（）()【】\[\]、，,。.·\-—_/]/g, '')
    .replace(/\d{4}\s*年?/g, '')
    .replace(/(产能建设方案|产能建设项目|产能建设|开发调整方案|开发调整|评价项目|后评价报告|后评价|项目)$/g, '')
    .replace(/单井|井区|区块/g, '');
}

// ── 3. 汇总系统任务：按项目名取"最近一次已完成"的任务 ──
function collectAudits() {
  const dir = path.join(ROOT, 'web', 'data', 'tasks');
  const byName = new Map();
  for (const d of fs.readdirSync(dir)) {
    const m = path.join(dir, d, 'meta.json');
    if (!fs.existsSync(m)) continue;
    const t = JSON.parse(fs.readFileSync(m, 'utf8'));
    if (t.status !== 'done') continue;
    const name = String(t.projectName || t.sourceName || '');
    if (!name) continue;
    const key = norm(name);
    if (!key) continue;
    const prev = byName.get(key);
    if (!prev || String(t.finishedAt || '') > String(prev.finishedAt || '')) {
      byName.set(key, { taskId: t.id, name, finishedAt: t.finishedAt || '', type: t.projectType || t.reportTypeRaw || '', dir });
    }
  }
  return byName;
}

/** 读一个任务的 P1 条目（run/s4_graded.json → p1[]） */
function readP1(taskId) {
  const f = path.join(ROOT, 'web', 'data', 'tasks', taskId, 'run', 's4_graded.json');
  if (!fs.existsSync(f)) return [];
  try { return JSON.parse(fs.readFileSync(f, 'utf8')).p1 || []; } catch { return []; }
}

// ── 4. 规则初筛：容易修改的优先 ──
const EASY = /补充|完善|明确|细化|落实|说明|标注|注明|统一|一致性|依据|来源|口径|程序|建议|进一步|对比|核实|列出|给出/;
const HARD = /重新计算|重算|返工|无法成立|结论不成立|必须重做|数据错误|算错/;   // 实质返工，不适合放进纪要
// 类别权重（2026-10-08 按用户口径调优）：纪要要给甲方看，优先"材料补充/口径统一/标准规范/结论边界"，
// 编校、符号、格式这类细枝末节降到末位（容易被认为"纪要尽挑错别字"）。
const CAT_WEIGHT = {
  AI套话: 3, 口径混用: 3, 前后矛盾: 3, 标准规范: 3, 结论偏宽: 3,
  数据不实: 2, 结论失真: 2, 变更程序: 2, 专项硬判: 2, 投资程序红线: 2, 强制程序: 2, 工程量多口径: 2,
  其他: 1, 关键数据错误: 1,
  编校错误: -1, 术语错误: -1, 格式规范: -2,
};
function pickEasy(p1) {
  const seenCat = new Set();
  const scored = p1
    .map((x) => {
      const fix = String(x.fix || '').trim();
      const desc = String(x.description || '').trim();
      let score = 0;
      if (fix) score += 3;
      if (EASY.test(fix)) score += 3;
      if (EASY.test(desc)) score += 1;
      if (HARD.test(fix) || HARD.test(desc)) score -= 6;
      if (fix.length > 8 && fix.length < 60) score += 1;
      score += CAT_WEIGHT[x.category] ?? 0;
      return { ...x, fix, desc, score };
    })
    .filter((x) => x.score > 0 && x.fix)
    .sort((a, b) => b.score - a.score);
  const out = [];
  for (const x of scored) {
    const cat = x.category || '其他';
    if (seenCat.has(cat)) continue;          // 同一类别只留 1 条
    seenCat.add(cat);
    out.push(x);
    if (out.length >= PER_PROJECT) break;
  }
  return out;
}

// ── 5. 相似度（字符 2-gram Jaccard，用于"相邻项目不要过度重复"）──
function sim(a, b) {
  const g = (s) => { const t = new Set(); const x = String(s).replace(/\s/g, ''); for (let i = 0; i < x.length - 1; i++) t.add(x.slice(i, i + 2)); return t; };
  const A = g(a); const B = g(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const k of A) if (B.has(k)) inter++;
  return inter / (A.size + B.size - inter);
}

// ── 6. AI 改写：把审核口吻改成给甲方的修改意见（分批）──
async function rewriteBatch(batch) {
  const sys = '你是石油天然气工程咨询成果审查会议纪要的起草人。把"审核发现"改写成给编制单位的修改意见：'
    + '语气是会议要求（如"进一步落实…""补充完善…"），一条一句、句末用句号、不超过 40 字、不带编号、不写"第几条"。'
    + '只依据给定材料，不虚构数据；若材料不足就写通用而具体的完善要求。严格输出 JSON，不要多余文字。';
  const user = '样板（供模仿语气，不要照抄内容）：\n'
    + '（1）结合产能核定报告，进一步落实产能、产量数据。\n'
    + '（2）项目变更管理方面，要针对工作量的变化，明确变更程序等方面评价内容。\n'
    + '（3）补充完善项目气耗、电耗等能耗及碳排放计算内容。\n'
    + '（4）根据项目实施中的实际问题，提出具体针对性建议。\n\n'
    + '待改写材料（每个项目给出若干条审核发现，请为每个项目产出 2-4 条修改意见，条与条之间不要重复、不同项目之间也要避免雷同）：\n'
    + JSON.stringify(batch.map((x) => ({ 项目: x.name, 审核发现: x.items.map((i) => ({ 类别: i.category, 位置: i.location, 问题: i.desc, 建议: i.fix })) })), null, 1)
    + '\n\n输出格式：{"项目名":["意见1","意见2",...]}';
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, temperature: 0.3, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`AI ${res.status} ${String(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const txt = j.choices?.[0]?.message?.content || '{}';
  return JSON.parse(txt.replace(/^```json\s*|```$/g, ''));
}

// ── 7. 主流程 ──
const projects = readProjectList();
const audits = collectAudits();
const auditKeys = [...audits.keys()];
const plan = [];
let matched = 0;
for (const p of projects) {
  const np = norm(p.name);
  let hit = audits.get(np);
  if (!hit) hit = auditKeys.filter((k) => k && (k.includes(np.slice(0, 10)) || np.includes(k.slice(0, 10)))).map((k) => audits.get(k))[0];
  const p1 = hit ? readP1(hit.taskId) : [];
  plan.push({ ...p, taskId: hit ? hit.taskId : '', sysName: hit ? hit.name : '', p1Count: p1.length, items: hit ? pickEasy(p1) : [] });
  if (hit) matched++;
}
console.log(`  项目 ${projects.length} 个：匹配到系统审核的 ${matched} 个，未匹配 ${projects.length - matched} 个`);
const selected = plan.filter((x) => x.items.length).length;
console.log(`  能选出 P1 修改意见的项目 ${selected} 个；合计候选 ${plan.reduce((a, x) => a + x.items.length, 0)} 条`);
for (const x of plan.slice(0, 5)) {
  console.log(`  · ${x.name.slice(0, 26)}（${x.p1Count} 条 P1）→ 选中 ${x.items.length} 条：`);
  for (const it of x.items) console.log(`      [${it.category}] ${it.fix.slice(0, 46)}`);
}

// 相邻项目去重：与上一个项目相似度 >0.5 的条目换成次优
const flat = [];
for (const x of plan) {
  const chosen = [];
  for (const cand of x.items) {
    const dup = flat.slice(-Math.min(flat.length, 12)).some((t) => sim(t, cand.fix) > 0.5);
    if (dup) continue;
    chosen.push(cand.fix);
  }
  // 若全被判为重复，保底留 2 条（宁可与邻项略重，也不能空）
  if (!chosen.length) chosen.push(...x.items.slice(0, Math.min(2, x.items.length)).map((i) => i.fix));
  x.final = chosen.slice(0, PER_PROJECT);
  flat.push(...x.final);
}

// 未匹配到系统审核（或匹配到但选不出条目）的项目：参考最相似的已匹配项目拟写（按用户口径）。
// 借用后做轻改（"统一…"→"进一步统一…"），并在明细里记 borrowedFrom，便于复核是不是照抄。
const donors = plan.filter((x) => x.final && x.final.length);
for (const x of plan) {
  if ((x.final && x.final.length) || !donors.length) continue;
  const best = donors.map((d) => ({ d, s: sim(norm(d.name), norm(x.name)) })).sort((a, b) => b.s - a.s)[0].d;
  const borrowedItems = best.final.slice(0, Math.min(3, best.final.length))
    .map((t) => String(t).replace(/^统一/, '进一步统一').replace(/^补充/, '补充完善'));
  x.borrowedFrom = best.name;
  x.final = borrowedItems;
  // 交给 AI 改写时当成"参照同类项目的发现"，让它按本项目口吻重写，避免与出让方逐字相同
  x.items = borrowedItems.map((t) => ({ category: '（参照同类项目）', location: '', desc: t, fix: t }));
  x.p1Count = 0;
}
const borrowedList = plan.filter((x) => x.borrowedFrom);
if (borrowedList.length) {
  console.log(`  未匹配/无素材的项目 ${borrowedList.length} 个，已参考同类项目拟写：`);
  for (const x of borrowedList) console.log(`   · ${x.name.slice(0, 24)} ← 参考「${x.borrowedFrom.slice(0, 20)}」`);
}

if (DRY) {
  console.log('\n  【dry-run】以下为规则初筛结果（未调用 AI）：');
  for (const x of plan.filter((y) => y.final.length).slice(0, 10)) {
    console.log(`  ${x.no}、${x.name}`);
    x.final.forEach((t, i) => console.log(`     （${i + 1}）${t}`));
  }
  process.exit(0);
}

if (!API_KEY) { console.error('  缺少 DEEPSEEK_API_KEY 环境变量，无法调用 AI（可先用 --dry 看选材）'); process.exit(1); }

// AI 改写（每批 5 个项目）
const todo = plan.filter((x) => x.final.length && (!LIMIT || x.no <= LIMIT));
const result = new Map();
for (let i = 0; i < todo.length; i += 5) {
  const batch = todo.slice(i, i + 5);
  process.stdout.write(`  AI 改写第 ${Math.floor(i / 5) + 1} 批（${batch.length} 个项目）… `);
  try {
    const got = await rewriteBatch(batch.map((x) => ({ name: x.name, items: x.items })));
    for (const x of batch) {
      const arr = got[x.name] || got[Object.keys(got).find((k) => norm(k) === norm(x.name)) || ''] || [];
      result.set(x.no, (Array.isArray(arr) ? arr : []).slice(0, PER_PROJECT));
    }
    console.log('ok');
  } catch (e) {
    console.log('失败：' + e.message + '（该项目沿用规则初筛原文）');
    for (const x of batch) result.set(x.no, []);
  }
}

// 成文（按纪要模式）
const today = new Date();
const zh = `${today.getFullYear()} 年 ${today.getMonth() + 1} 月 ${today.getDate()} 日`;
const L = [];
L.push(`**${projects[0].name}等**`);
L.push('');
L.push(`**${todo.length}** **个后评价报告审查会议纪要**`);
L.push('');
L.push('**会议时间：**【待填】');
L.push('');
L.push('**会议地点：**【待填】');
L.push('');
L.push('**会议方式：**【待填】');
L.push('');
L.push('**参会人员：**【待填】');
L.push('');
L.push(`【待填】年【待填】月【待填】日，河南油田工程科技股份有限公司在【待填】组织公司专家、市场与生产运行管理部等，对咨询事业部编制的${projects[0].name}等 ${todo.length} 个后评价报告进行了公司审查。${todo.length} 个后评价报告从项目决策过程、实施过程、生产运行、技术适应性、投资完成、经济效果等方面进行了对比分析和评价，针对发现的问题提出了合理建议，达到了后评价报告质量要求。与会人员经讨论，提出如下修改意见：`);
L.push('');
L.push('**一、共性修改意见**');
L.push('');
L.push('1、报告封页、字体及字号等统一，报告数据前后统一。');
L.push('');
L.push('2、对于工作量、投资差异大的项目，进一步完善项目工作量和投资差异原因分析。');
L.push('');
L.push('3、进一步总结提炼项目结论和建议，建议要与项目实施中的实际问题对应。');
L.push('');
L.push('**二、具体项目修改意见**');
L.push('');
for (const x of todo) {
  const items = result.get(x.no)?.length ? result.get(x.no) : x.final;
  L.push(`${x.no}、${x.name}`);
  L.push('');
  items.forEach((t, i) => { L.push(`（${i + 1}）${String(t).replace(/[。；;]\s*$/, '')}。`); L.push(''); });
}
L.push('**审查组组长：**【待填】');
L.push('');
L.push(`**${zh}**`);

fs.mkdirSync(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, `西北后评价项目审查会议纪要-${today.toISOString().slice(0, 10)}.md`);
fs.writeFileSync(out, L.join('\n'), 'utf8');
const json = path.join(OUT_DIR, `选材明细-${today.toISOString().slice(0, 10)}.json`);
fs.writeFileSync(json, JSON.stringify(plan.map((x) => ({
  no: x.no, name: x.name, taskId: x.taskId, sysName: x.sysName, p1Count: x.p1Count,
  picked: x.items.map((i) => ({ category: i.category, location: i.location, fix: i.fix })),
  final: x.final, ai: result.get(x.no) || null,
})), null, 2), 'utf8');
console.log(`\n  已生成：${out}`);
console.log(`  选材明细：${json}`);
