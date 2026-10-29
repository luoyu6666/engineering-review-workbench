/**
 * 「同一项目重复审核的合并与对比」自检（零 API；纯函数 + 报告渲染）
 *
 * 2026-09-27 口径：
 *   ① 台账里把同一项目的多次审核合并显示（审核时间、提交人、问题数…），按项目合并、不分提交人；
 *   ② 后续审核成果里，除新发现的问题外，还要核实上一轮问题是否已修改完善，
 *      并着重提醒未响应的高级别问题（P0/P1）。
 *
 * AI 判断那一步（stageComparePrevious）要联网调模型，无法离线断言；
 * 所以这里覆盖其周边的全部纯逻辑：清单块、结果对齐与汇总、上一轮定位、分组、报告渲染。
 *
 * 用法：node engine\test-compare.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wbcmp-'));
process.env.WB_DATA_DIR = tmp;
const L = await import('../web/lib.mjs');
const { compareBlock, summarizeCompare } = await import('./lib/pipeline.mjs');
const { renderHtmlReport } = await import('./lib/report-html.mjs');

let pass = 0, fail = 0;
const ok = (c, n, extra = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${extra ? '  ← ' + extra : ''}`); } };
const eq = (a, b, n) => ok(a === b, n, `实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`);

console.log('\n── 1. 找「上一轮同项目审核」──');
{
  const tasks = [
    { id: 'T1', status: 'done', projectName: '某输油管道改线工程', projectCode: 'HPJ2026022-2', ownerName: '钱八', createdAt: '2026-09-20T01:00:00Z', finishedAt: '2026-09-20T02:00:00Z' },
    { id: 'T2', status: 'done', projectName: '某输油管道改线工程', projectCode: 'HPJ2026022-2', ownerName: '李四', createdAt: '2026-09-24T01:00:00Z', finishedAt: '2026-09-24T02:00:00Z' },
    { id: 'T3', status: 'failed', projectName: '某输油管道改线工程', projectCode: '', ownerName: '刘工', createdAt: '2026-09-25T01:00:00Z' },
    { id: 'T4', status: 'done', projectName: '别的项目', projectCode: '', ownerName: '张三', createdAt: '2026-09-26T01:00:00Z', finishedAt: '2026-09-26T02:00:00Z' },
  ];
  const prev = L.findPreviousAudit(tasks, { projectName: '某输油管道改线工程', projectCode: '', excludeTaskId: 'T9' });
  eq(prev && prev.id, 'T2', '取最新的一次已完成审核（T2 比 T1 新）');
  eq(prev.ownerName, '李四', '**不分提交人**：别人提交的同一项目也算上一轮');
  const prev2 = L.findPreviousAudit(tasks, { projectName: '某输油管道改线工程', projectCode: '', excludeTaskId: 'T2' });
  eq(prev2 && prev2.id, 'T1', '排除自己这条后取更早的 T1');
  eq(L.findPreviousAudit(tasks, { projectName: '没审过的项目' }), null, '没审过的项目 → null');
  const newest = L.findPreviousAudit([...tasks].reverse(), { projectName: '某输油管道改线工程' });
  eq(newest.id, 'T2', '与输入顺序无关（内部按时间排序）');
  const byCode = L.findPreviousAudit(tasks, { projectName: '', projectCode: 'HPJ2026022-2' });
  eq(byCode && byCode.id, 'T2', '只给项目编号也能命中（编号或名称任一）');
  eq(L.findPreviousAudit(tasks, { projectName: '', projectCode: '' }), null, '名和编号都不给 → 不硬凑一条出来');
}

console.log('\n── 2. 按项目分组（合并显示用）──');
{
  const tasks = [
    { id: 'A1', status: 'done', projectName: '项目甲', ownerName: '甲', createdAt: '2026-09-20T01:00:00Z', finishedAt: '2026-09-20T02:00:00Z', stats: { p0Count: 3, p1Count: 9 } },
    { id: 'A2', status: 'done', projectName: '项目甲', ownerName: '乙', createdAt: '2026-09-24T01:00:00Z', finishedAt: '2026-09-24T02:00:00Z', stats: { p0Count: 1, p1Count: 4 }, compare: { stats: { total: 12, fixed: 10, partial: 1, unfixed: 1, unknown: 0, unfixedP0: 0, unfixedP1: 1 } } },
    { id: 'B1', status: 'done', projectName: '项目乙', ownerName: '丙', createdAt: '2026-09-22T01:00:00Z', finishedAt: '2026-09-22T02:00:00Z', stats: { p0Count: 0, p1Count: 2 } },
    { id: 'C1', status: 'done', sourceName: '没有项目名的.docx', ownerName: '丁', createdAt: '2026-09-19T01:00:00Z' },
  ];
  const g = L.groupTasksByProject(tasks);
  eq(g.length, 3, '3 个项目（无项目名的按文件名单独成组）');
  const jia = g.find(x => x.name === '项目甲');
  eq(jia.count, 2, '项目甲合并成 1 组、包含 2 次提交');
  eq(jia.hasRepeat, true, '标记为"审过不止一次"');
  eq(jia.owners.join('、'), '甲、乙', '参与人合并去重');
  eq(jia.firstAt < jia.lastAt, true, '首次/最后一次时间有序');
  eq(jia.latest.id, 'A2', 'latest 指向最近一次');
  eq(jia.submissions[0].id, 'A1', '明细按时间正序（第 1 次在前）');
  eq(jia.submissions[1].compare.stats.unfixed, 1, '最近一次的对比摘要带上了');
  eq(g[0].name, '项目甲', '分组按最近时间倒序（项目甲最新）');
  const noName = g.find(x => x.name.includes('没有项目名'));
  eq(noName.key.startsWith('file:'), true, '没有项目名/编号时用文件名兜底成组');
}

console.log('\n── 3. 上一次问题清单块（喂给 AI 的格式）──');
{
  const prevIssues = [
    { no: 'P0-1', sev: 'P0', category: '数据不实', description: '表5-1 投资口径与批复不一致', location: '表5-1', quote: '总投资 3347 万元' },
    { no: 'P1-7', sev: 'P1', category: '编校错误', description: '单位写法不统一', location: '正文3.2' },
  ];
  const b = compareBlock(prevIssues, { id: 'T-old', ownerName: '李四', finishedAt: '2026-09-24T02:00:00Z' });
  ok(b.includes('P0-1') && b.includes('P1-7'), '编号原样带上（报告里要能对上号）');
  ok(b.includes('T-old') && b.includes('李四'), '带上上一轮的任务号与提交人');
  ok(b.includes('表5-1') && b.includes('总投资 3347 万元'), '带上位置与原文摘录（AI 判断要证据）');
  ok(b.includes('共 2 条'), '标明条数');
  eq(compareBlock([], {}).includes('（无）'), true, '没有清单时明确写"（无）"');
}

console.log('\n── 4. 对比结果汇总（"着重提醒"的数字）──');
{
  const items = [
    { no: 'P0-1', level: 'P0', status: 'fixed' },
    { no: 'P0-2', level: 'P0', status: 'unfixed' },
    { no: 'P1-1', level: 'P1', status: 'partial' },
    { no: 'P1-2', level: 'P1', status: 'unknown' },
    { no: 'P2-1', level: 'P2', status: 'unfixed' },
  ];
  const s = summarizeCompare(items);
  eq(s.total, 5, '总条数');
  eq(s.fixed, 1, '已修改 1');
  eq(s.partial, 1, '部分修改 1');
  eq(s.unfixed, 2, '未响应 2');
  eq(s.unknown, 1, '无法判断 1');
  eq(s.unfixedP0, 1, '未响应 P0 计 1（unfixed）');
  eq(s.unfixedP1, 1, '未响应 P1 计 1（**partial 也算未完全响应**）');
  eq(s.unfixedP2 === undefined, true, '只统计 P0/P1（P2 未响应不进"着重提醒"）');
  eq(summarizeCompare([]).total, 0, '空清单不炸');
}

console.log('\n── 5. 成果报告里那一节（重点：未响应 P0 要显眼）──');
{
  const graded = {
    stats: { p0Count: 1, p1Count: 1, p2Count: 0, p3Count: 0, total: 2 },
    p0: [{ category: '数据不实', description: '本次新发现的 P0', location: '表9-1', fix: '改' }],
    p1: [{ category: '编校错误', description: '本次新发现的 P1', location: '正文1', fix: '改' }],
    p2: [], p3: [],
  };
  const base = { id: 'T-new', sourceName: '报告.docx', templateName: '后评价', ownerName: '李四' };
  const compare = {
    prevTaskId: 'T-old', prevOwner: '李四', prevAt: '2026-09-24T02:00:00Z',
    items: [
      { no: 'P0-1', level: 'P0', category: '数据不实', summary: '投资口径不一致', status: 'unfixed', evidence: '正文仍写 3347 万元' },
      { no: 'P1-3', level: 'P1', category: '编校错误', summary: '单位写法不统一', status: 'fixed', evidence: '已统一为 万元' },
      { no: 'P2-2', level: 'P2', category: '结论偏宽', summary: '结论偏宽', status: 'partial', evidence: '措辞略改' },
    ],
    stats: summarizeCompare([
      { level: 'P0', status: 'unfixed' }, { level: 'P1', status: 'fixed' }, { level: 'P2', status: 'partial' },
    ]),
  };
  const body = (h) => h.slice(h.indexOf('<body'));

  const deep = body(renderHtmlReport({ task: base, graded, narrative: '', deepAccess: true, compare }));
  ok(deep.includes('上次审核问题的修改情况'), '审核成果有这一节');
  ok(deep.includes('P0-1') && deep.includes('未响应'), '列出未响应条目');
  ok(deep.includes('正文仍写 3347 万元'), '带上依据（本次报告原文）');
  ok(/P0（必须修改）未响应/.test(deep), '结论处着重提醒"P0 未响应"');
  ok(deep.includes('P2-2'), '深度版包含全部级别（含 P2）');

  const pf = body(renderHtmlReport({ task: base, graded, narrative: '', deepAccess: false, compare }));
  ok(pf.includes('上次审核问题的修改情况（校对类）'), '校对成果也有这一节（标注"校对类"）');
  ok(pf.includes('P0-1') && pf.includes('P1-3'), '校对版列出校对类条目');
  ok(!pf.includes('P2-2'), '校对版**不含深度类**条目（与"普通用户只看校对类"一致）');

  const none = body(renderHtmlReport({ task: base, graded, narrative: '', deepAccess: true, compare: null }));
  ok(!none.includes('上次审核问题的修改情况'), '没有上一轮 → 报告里不出现这一节（不留空框）');
  ok(!none.includes('同一项目的再次审核'), '没有上一轮 → 结论处也不提"再次审核"');

  const clean = {
    prevTaskId: 'T-old', prevOwner: '王', prevAt: '2026-09-24T02:00:00Z',
    items: [{ no: 'P1-9', level: 'P1', category: '编校错误', summary: 'x', status: 'fixed', evidence: 'y' }],
    stats: summarizeCompare([{ level: 'P1', status: 'fixed' }]),
  };
  const cleanBody = body(renderHtmlReport({ task: base, graded, narrative: '', deepAccess: true, compare: clean }));
  ok(cleanBody.includes('无未响应的高级别问题'), '全部已修改时给正面结论（不吓人）');
  ok(!/P0（必须修改）未响应/.test(cleanBody), '没有未响应 P0 时不出现红色 P0 警告');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 重复项目合并与对比自检：${pass} 通过 / ${fail} 失败\n`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
