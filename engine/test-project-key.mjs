// 项目名归一化测试：同一项目的不同写法必须归并到同一 key
import * as L from '../web/lib.mjs';

const cases = [
  '江汉石油工程公司2026年西北工区压裂设备购置项目',
  '江汉石油工程公司2026年西北工区压裂设备购置项目可行性研究报告',
  '2026年江汉石油工程公司西北工区压裂设备购置项目',
  '江汉石油工程公司 2026 年西北工区压裂设备购置项目（可研报告）',
  '塔河油田西部奥陶系油藏2023年第一期调整方案',
  '塔河油田西部奥陶系油藏2023年第一期调整方案可研报告',
  '塔河油田西部奥陶系油藏2023年第一期调整方案汇报',
];

console.log('=== 归一化结果 ===');
const keys = {};
for (const c of cases) {
  const k = L.normalizeProjectKey(c);
  (keys[k] ||= []).push(c);
  console.log('  ' + k.padEnd(44) + ' ← ' + c);
}

console.log('\n=== 归并检查 ===');
for (const [k, list] of Object.entries(keys)) {
  console.log(`  [${list.length} 种写法] ${k}`);
  list.forEach(x => console.log(`      · ${x}`));
}

console.log('\n=== 配额判定（模拟：江汉项目已累计 190 项）===');
const p = L.listProjects();
const key = L.normalizeProjectKey(cases[0]);
p[key] = { name: cases[0], proofreadTotal: 190, submissions: 4, itemTotal: 300, lastAt: new Date().toISOString() };
L.saveProjects(p);
for (const n of [cases[0], cases[1], '塔河油田西部奥陶系油藏2023年第一期调整方案']) {
  const q = L.checkProjectQuota(n);
  console.log(`  ${n.slice(0, 30).padEnd(32)} → ok=${q.ok} 已用 ${q.used}/${q.limit} 剩余 ${q.remaining}`);
}
console.log('\n=== 成本模型 ===');
const m = L.getCostModel();
console.log('  ' + JSON.stringify(m));
const cb = L.computeCost({ apiCost: 0.42, count: 5, deepCount: 5, model: m });
console.log('  5 次审核（含专家终审）成本拆解: ' + JSON.stringify(cb));
const an = L.projectAnnual({ monthCount: 5, monthApiCost: 2.1, monthDeepCount: 5, model: m, monthsElapsed: 21 });
console.log('  年度测算（按本月 5 次外推）: ' + JSON.stringify(an.annual));
