// 重复审核查重 —— 自检（纯离线，零 API 调用）
// 合成数据为主：真实台账里同项目样本太少，靠真实数据测不出边界。
import fs from 'node:fs';
import path from 'node:path';
import * as L from '../web/lib.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  ' + extra}`);
  cond ? pass++ : fail++;
};

const T = (id, owner, ownerName, projectName, projectCode, status = 'done', extra = {}) =>
  ({ id, owner, ownerName, projectName, projectCode, status, createdAt: '2026-09-01T02:00:00Z', finishedAt: '2026-09-01T02:30:00Z', sourceName: id + '.docx', stats: { p0Count: 3, p1Count: 10 }, ...extra });

const base = [
  T('T1', 'u1', '张工', '江汉石油工程公司2026年西北工区压裂设备购置项目', 'KY2026004'),
  T('T2', 'u2', '李工', '塔河油田TP259H井区2023年第二期产能建设项目', 'HPJ2026019'),
  T('T3', 'u1', '张工', '江汉石油工程公司2026年西北工区压裂设备购置项目', 'KY2026004'),   // 同一人重复提交
  T('T4', 'u3', '王工', '完全无关的另一个项目', '', 'failed'),                                // 失败任务不该算
  T('T5', 'u4', '张三', '', '', 'done'),                                                    // 未识别项目，不该参与匹配
];

console.log('【1】精确查重：编号命中');
let hits = L.findDuplicateAudits(base, { projectCode: 'KY2026004', excludeTaskId: 'T9', excludeOwner: 'u1' });
ok('按编号命中 T1/T3', hits.length === 2 && hits.every(h => ['T1', 'T3'].includes(h.id)), JSON.stringify(hits.map(h => h.id)));
ok('matchedBy = code', hits.every(h => h.matchedBy === 'code'), JSON.stringify(hits.map(h => h.matchedBy)));
ok('提交人就是 u1 时，T3/S 被标为同一人', hits.every(h => h.isSameOwner === true));
hits = L.findDuplicateAudits(base, { projectCode: 'KY2026004', excludeTaskId: 'T9', excludeOwner: 'u9' });
ok('提交人是别人时，isSameOwner 全为 false', hits.every(h => h.isSameOwner === false));

console.log('\n【2】精确查重：名称命中（年份不同也应命中）');
hits = L.findDuplicateAudits(base, { projectName: '江汉石油工程公司2027年西北工区压裂设备购置项目', excludeTaskId: 'T9', excludeOwner: 'u5' });
ok('改年份仍命中 T1/T3', hits.length === 2, JSON.stringify(hits.map(h => h.id)));
ok('matchedBy = name', hits.every(h => h.matchedBy === 'name'));

console.log('\n【3】编号 + 名称同时命中');
hits = L.findDuplicateAudits(base, { projectName: '江汉石油工程公司2026年西北工区压裂设备购置项目', projectCode: 'KY2026004', excludeTaskId: 'T9' });
ok('matchedBy = both', hits.every(h => h.matchedBy === 'both'));

console.log('\n【4】排除规则');
hits = L.findDuplicateAudits(base, { projectCode: 'KY2026004', excludeTaskId: 'T1' });
ok('excludeTaskId 生效（不含 T1）', !hits.some(h => h.id === 'T1'));
ok('失败任务不参与查重（不含 T4）', !L.findDuplicateAudits(base, { projectName: '完全无关的另一个项目' }).some(h => h.id === 'T4'));
ok('未识别项目不误命中', L.findDuplicateAudits(base, { projectName: '' }).length === 0);
ok('纯空格项目名不误命中', L.findDuplicateAudits(base, { projectName: '   ' }).length === 0);
hits = L.findDuplicateAudits(base, { projectName: '不存在的项目名称XYZ' });
ok('完全不同的项目不命中', hits.length === 0, JSON.stringify(hits.map(h => h.id)));

console.log('\n【5】不同人员 vs 同一人员（需求：不同人员才需要提醒重复）');
hits = L.findDuplicateAudits(base, { projectCode: 'KY2026004', excludeTaskId: 'T9', excludeOwner: 'u5' });
const others = hits.filter(h => !h.isSameOwner);
ok('他人提交的命中 2 条', others.length === 2);
hits = L.findDuplicateAudits(base, { projectCode: 'KY2026004', excludeTaskId: 'T9', excludeOwner: 'u1' });
ok('本人曾提交过时 isSameOwner=true', hits.filter(h => h.isSameOwner).length === 2);

console.log('\n【6】本地粗筛（从正文里找已知项目）');
const doc = `某某公司\n项目编号：KY2026004\n江汉石油工程公司2026年西北工区压裂设备购置项目\n可行性研究报告\n` + '正文内容。'.repeat(500);
let q = L.quickDuplicateCheck(base, doc, { excludeTaskId: 'T9' });
ok('编号命中 T1/T3', q.filter(h => h.matchedBy === 'code').length === 2, JSON.stringify(q.map(h => h.id + ':' + h.matchedBy)));
ok('失败任务不参与粗筛', !q.some(h => h.id === 'T4'));

const doc2 = '项目名称：江汉石油工程公司2026年西北工区压裂设备购置项目\n' + '正文。'.repeat(300);
q = L.quickDuplicateCheck(base, doc2);
ok('只写名称也能粗筛命中', q.some(h => h.matchedBy === 'name'), JSON.stringify(q.map(h => h.id + ':' + h.matchedBy)));

const noise = '这是一份与任何已知项目都无关的技术说明文档，讲的是设备维护流程与备件管理。'.repeat(80);
ok('无关文本零误命中', L.quickDuplicateCheck(base, noise).length === 0);
ok('空文本不报错', L.quickDuplicateCheck(base, '').length === 0);

console.log('\n【7】真实台账跑一遍（应能跑通且不误伤）');
const real = L.listTasks();
const realHits = L.findDuplicateAudits(real, { projectName: '江汉石油工程公司2026年西北工区压裂设备购置项目' });
console.log(`  真实台账 ${real.length} 个任务，按江汉项目查重命中 ${realHits.length} 条：${realHits.map(h => h.id).join(' ')}`);
ok('真实数据可正常执行', Array.isArray(realHits));

console.log(`\n${fail === 0 ? '全部通过' : '存在失败'}：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
