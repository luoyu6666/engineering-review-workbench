// 未响应明细钻取自检：口径、分组、筛选、缺产物容错、排序与截断、优化标注与界面滚动定位。
// 用法：node engine\test-unresponded.mjs
import fs from 'node:fs';
import path from 'node:path';
import * as L from '../web/lib.mjs';

let pass = 0, fail = 0;
const ok = (c, n, extra = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${extra ? '  ← ' + extra : ''}`); } };
const eq = (a, b, n) => ok(a === b, n, `实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`);

const T = (o) => ({ status: 'done', owner: 'u1', ownerName: '李四', finishedAt: '2026-09-29T02:00:00Z', ...o });

// 两个项目：甲项目上一轮 4 条（2 未响应含 1 个 P0、1 部分响应、1 已改），乙项目 1 条未响应
const COMPARE = {
  t1: {
    prevTaskId: 'T0', prevAt: '2026-09-20T00:00:00Z',
    items: [
      { no: 'P0-1', level: 'P0', category: '关键数据错误', summary: '验算不符', location: '第21页', status: 'unfixed', evidence: '表列106.9', note: '仍未修正' },
      { no: 'P0-2', level: 'P0', category: '关键数据错误', summary: '已改的数据', location: '第5页', status: 'fixed', evidence: '', note: '' },
      { no: 'P1-3', level: 'P1', category: '依据不足', summary: '缺定额依据', location: '第30页', status: 'partial', evidence: '部分引用', note: '只补了一处' },
      { no: 'P1-4', level: 'P1', category: '表述不清', summary: '结论含糊', location: '第8页', status: 'unfixed', evidence: '仍为笼统表述', note: '未回应' },
      { no: 'P2-5', level: 'P2', category: '格式', summary: '页码错', location: '目录', status: 'unknown', evidence: '', note: '信息不足' },
    ],
  },
  t2: {
    prevTaskId: 'T0', prevAt: '2026-09-20T00:00:00Z',
    items: [
      { no: 'P0-1', level: 'P0', category: '工程量错误', summary: '工程量与图纸不符', location: '第12页（工程量表）', status: 'unfixed', evidence: '表列 3185.6', note: '仍为原值' },
    ],
  },
};
const tasks = [
  T({ id: 't1', projectName: '甲项目' }),
  T({ id: 't2', projectName: '乙项目', owner: 'u2', ownerName: '王五' }),
  T({ id: 't3', projectName: '丙项目' }),                                   // 无对比记录
  T({ id: 't4', projectName: '丁项目', compare: { stats: { total: 3, fixed: 3, partial: 0, unfixed: 0, unfixedP0: 0 } } }),
];
const readCompare = (id) => COMPARE[id] || null;

console.log('\n── 1. 口径：unfixed + partial 才算未完全响应 ──');
{
  const r = L.buildUnrespondedReport(tasks, { readCompare });
  eq(r.total, 4, 't1 的 2 未响应 + 1 部分响应、t2 的 1 未响应 = 4 条');
  eq(r.unfixed, 3, '其中"未响应"3 条');
  eq(r.partial, 1, '"部分响应"1 条');
  eq(r.p0, 2, 'P0 级 2 条（与台账 unfixedP0 同口径：partial 一并计入级别统计）');
  eq(r.projects, 2, '涉及 2 个项目');
  ok(!r.items.some((x) => x.status === 'fixed' || x.status === 'unknown'), '已改/无法判断的条目不出现在明细里');
  ok(r.items.every((x) => x.no && x.location && x.summary), '每条都带条目号/位置/上次意见（能定位到页）');
  eq(r.items[0].prevTaskId, 'T0', '带上上一轮任务号，便于对照两次报告');
}

console.log('\n── 2. 分组：按项目 / 按问题类别 ──');
{
  const r = L.buildUnrespondedReport(tasks, { readCompare });
  const jia = r.byProject.find((p) => p.project === '甲项目');
  eq(jia.total, 3, '甲项目 3 条');
  eq(jia.unfixed, 2, '甲项目未响应 2 条');
  eq(jia.partial, 1, '甲项目部分响应 1 条');
  eq(jia.p0, 1, '甲项目 P0 1 条');
  eq(r.byProject[0].project, '甲项目', '按条数降序，甲项目（3 条）在前');
  eq(r.byCategory.find((c) => c.category === '关键数据错误').total, 1, '按类别汇总：关键数据错误 1 条');
  eq(r.byCategory.find((c) => c.category === '工程量错误').p0, 1, '该类别里 P0 计数正确');
}

console.log('\n── 3. 筛选（级别 / 项目 / 类别 / 状态）──');
{
  eq(L.buildUnrespondedReport(tasks, { readCompare, level: 'P0' }).total, 2, '只看 P0 → 2 条');
  eq(L.buildUnrespondedReport(tasks, { readCompare, project: '甲项目' }).total, 3, '只看甲项目 → 3 条');
  eq(L.buildUnrespondedReport(tasks, { readCompare, level: 'P1' }).partial, 1, 'P1 + 只看部分响应 → partial 1 条');
  eq(L.buildUnrespondedReport(tasks, { readCompare, status: 'partial' }).total, 1, '只看部分响应 → 1 条');
  eq(L.buildUnrespondedReport(tasks, { readCompare, category: '依据不足' }).total, 1, '按类别筛选 → 1 条');
  eq(L.buildUnrespondedReport(tasks, { readCompare, scope: 'mine', owner: 'u2' }).total, 1, 'scope=mine 只算本人提交的任务 → 1 条');
  eq(L.buildUnrespondedReport(tasks, { readCompare, scope: 'mine', owner: 'u1' }).total, 3, 'u1 的任务 → 3 条');
}

console.log('\n── 4. 容错、排序与截断 ──');
{
  const missing = L.buildUnrespondedReport([T({ id: 'tx', projectName: '戊项目', compare: { stats: { unfixed: 5, partial: 0 } } })],
    { readCompare: () => { throw new Error('文件被清理'); } });
  eq(missing.total, 0, '对比产物读不到时不炸、也不虚报（宁可少显示，不给错数字）');
  eq(L.buildUnrespondedReport(tasks, { readCompare: () => null }).total, 0, '产物缺失（返回 null）时同样安全');

  const r = L.buildUnrespondedReport(tasks, { readCompare });
  eq(r.items[0].level, 'P0', 'P0 排在最前（先处理要紧的）');
  const cut = L.buildUnrespondedReport(tasks, { readCompare, limit: 2 });
  eq(cut.items.length, 2, 'limit 生效（前端表格只画前若干条）');
  eq(cut.total, 4, 'total 仍是完整条数（导出用完整清单）');
  eq(cut.truncated, true, '并标出结果被截断');
}

console.log('\n── 5. 优化标注：合并进明细、筛选与统计 ──');
{
  const feedback = {
    't1|P0-1': { taskId: 't1', no: 'P0-1', project: '甲项目', levelFrom: 'P0', categoryFrom: '关键数据错误',
      levelTo: '', categoryTo: '', verdicts: ['AI 误报（不该报）'], reason: '重复计数', rule: '', status: 'open' },
    't1|P1-3': { taskId: 't1', no: 'P1-3', project: '甲项目', levelFrom: 'P1', categoryFrom: '依据不足',
      levelTo: 'P0', categoryTo: '关键数据错误', verdicts: ['定级不当'], reason: '该条属数值错误', rule: '涉及金额/工程量的合计数不一致即定 P0', status: 'adopted' },
  };
  const r = L.buildUnrespondedReport(tasks, { readCompare, feedback });
  eq(r.marked, 2, '已标注 2 条');
  eq(r.unmarked, 2, '未标注 2 条');
  eq(r.items.find((x) => x.no === 'P0-1' && x.project === '甲项目').feedback.verdicts[0], 'AI 误报（不该报）', '标注挂在对应条目上（前端据此显示徽标/回填表单）');
  eq(r.items.find((x) => x.no === 'P1-4').feedback, null, '未标注的条目 feedback 为 null');

  eq(L.buildUnrespondedReport(tasks, { readCompare, feedback, only: 'marked' }).total, 2, '只看已标注 → 2 条');
  eq(L.buildUnrespondedReport(tasks, { readCompare, feedback, only: 'unmarked' }).total, 2, '只看未标注 → 2 条');

  const st = L.skillFeedbackStats(feedback);
  eq(st.total, 2, '统计条数 2');
  eq(st.byVerdict.find((v) => v.key === 'AI 误报（不该报）').count, 1, '按判定标签统计（可据此算误报率）');
  eq(st.levelRaise, 1, '应升级 1 条（P1→P0，正是"低级问题被定低了"的场景）');
  eq(st.levelLower, 0, '应降级 0 条');
  eq(st.adopted, 1, '已采纳 1 条');
  eq(st.withRule, 1, '含补充规则 1 条');
  eq(st.byCategoryFrom.find((c) => c.key === '依据不足').count, 1, '按原类别统计（定位技能薄弱类别）');

  const md = L.skillFeedbackMarkdown(feedback);
  ok(md.includes('# 审核技能优化建议'), '可导出 Markdown 规则建议');
  ok(md.includes('涉及金额/工程量的合计数不一致即定 P0'), '补充规则原文进入导出内容（可直接进知识库）');
  ok(md.includes('P1 → P0'), '标注中的级别调整在导出里可见');
  eq(L.skillFeedbackMarkdown(feedback, { onlyAdopted: true }).includes('重复计数'), false, 'onlyAdopted 时未采纳的条目不导出');
  eq(L.skillFeedbackKey('t1', 'P0-1'), 't1|P0-1', '标注主键＝任务号|条目号（与前端一致）');
}

console.log('\n── 6. 界面滚动定位（两处操作痛点，2026-09-29 修复）──');
{
  const idx = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'web', 'public', 'index.html'), 'utf8');
  ok(/function scrollUnrespTop\(/.test(idx) && /scrollUnrespTop\(\);/.test(idx),
    '打开明细后把面板顶部对齐到视口顶部（否则标题停在浏览器最下面一行，还得下滚）');
  ok(/const keepWin = window\.scrollY/.test(idx) && /window\.scrollTo\(\{ top: keepWin \}\)/.test(idx),
    '判定面板重建前后保存/恢复页面滚动位置（否则勾选标签就跳回第一条）');
  ok(/data-fb-editor/.test(idx) && /querySelector\('\[data-fb-editor\]'\)/.test(idx),
    '渲染后把正在编辑的那一行拉回视野（保证能继续看到填写内容）');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 未响应钻取自检：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
