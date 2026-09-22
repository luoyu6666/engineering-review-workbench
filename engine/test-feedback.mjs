// 技能经验条目自检（离线，零 API 调用）
//
// 覆盖：作用域三分类（全局/按类型/指定项目）、一条挂多项目、多条口径、
//       老格式兼容、LEARNED.md 的组织结构。
//
// 为什么需要：经验能否生效，全靠**作用域匹配**。匹配断掉的表现是"经验悄悄不生效"——
// 审核照跑，只是没带上你录的口径，页面上完全看不出来。
// 这类静默失效必须靠断言守，不能靠肉眼。
//
// 用法：node engine/test-feedback.mjs
import fs from 'node:fs';
import * as L from '../web/lib.mjs';

const SAMPLE = [
  { id: 'F1', status: 'active', kind: 'criteria', scope: 'type', category: '数据不实',
    projectTypes: ['产能后评价', '装备购置可研'],
    lessons: ['差异<0.5%且不改变结论 → 最高 P2', '差异≥0.5% 或影响结论 → 按 P0-4 判 P0'],
    opinion: '这类报告同一指标差一点点，不影响结论的别报 P0。', by: '王工', createdAt: '2026-09-21T10:00:00Z' },
  { id: 'F2', status: 'active', kind: 'miss', scope: 'project',
    projectNames: ['塔河12-8区项目', '江汉压裂项目'], taskIds: ['T-A', 'T-B'],
    lessons: ['本项目须写明投资来源'], opinion: '甲方要求。', by: 'a', createdAt: '2026-09-21T10:00:00Z' },
  { id: 'F3', status: 'active', kind: 'false-positive', scope: 'global',
    lesson: '页眉页码不算编校错误', opinion: 'x', by: 'a', createdAt: '2026-09-21T10:00:00Z' },
  { id: 'F4', status: 'active', kind: 'wording', scope: 'global',
    lessons: ['表述偏好A', '表述偏好B'], opinion: 'y', by: 'a', createdAt: '2026-09-21T10:00:00Z' },
  { id: 'F5', status: 'archived', kind: 'miss', scope: 'type', projectTypes: ['产能后评价'],
    lessons: ['已归档的不应出现'], opinion: 'x', by: 'a', createdAt: '2026-09-21T10:00:00Z' },
];

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { console.log(`  ${c ? '✓' : '✗'} ${n}${c ? '' : '  ' + e}`); c ? pass++ : fail++; };

const backup = fs.existsSync(L.FEEDBACK_FILE) ? fs.readFileSync(L.FEEDBACK_FILE, 'utf8') : null;
console.log(`（原经验文件 ${L.listFeedback().length} 条，测试期间临时替换，结束还原）`);

try {
  L.saveFeedback(SAMPLE);

  console.log('\n【1】作用域：按类型 / 按项目 / 两个维度同时命中');
  const r1 = L.learnedForContext({ projectName: '塔河12-8区项目', projectType: '产能后评价' });
  ok('类型级经验命中', r1.includes('最高 P2'));
  ok('项目级经验命中', r1.includes('写明投资来源'));
  ok('两个维度都标注了来源', r1.includes('按报告类型') && r1.includes('指定项目'));
  ok('无关类型不命中', !L.learnedForContext({ projectType: '股权与资产收购' }).includes('最高 P2'));
  ok('无关项目不命中', L.learnedForContext({ projectName: '没这个项目' }) === '');
  ok('空参数安全', L.learnedForContext() === '' && L.learnedForContext({}) === '');
  ok('多类型中任一个命中即可', L.learnedForContext({ projectType: '装备购置可研' }).includes('最高 P2'));

  console.log('\n【2】多条口径');
  ok('feedbackLessons 读多条', L.feedbackLessons(SAMPLE[0]).length === 2);
  ok('feedbackLessons 兼容老单条 lesson', JSON.stringify(L.feedbackLessons(SAMPLE[2])) === '["页眉页码不算编校错误"]');
  ok('feedbackLessons 去重', L.feedbackLessons({ lessons: ['a', 'a', ' b '] }).length === 2);
  ok('无口径返回空数组', L.feedbackLessons({}).length === 0);
  ok('多条口径都注入到审核提示', (() => {
    const t = L.learnedForContext({ projectType: '产能后评价' });
    return t.includes('最高 P2') && t.includes('P0-4');
  })());

  console.log('\n【3】老格式兼容（历史数据不能失效）');
  L.saveFeedback([{ id: 'OLD', status: 'active', kind: 'criteria', scope: 'project',
    projectName: '某老项目', lesson: '老格式必须继续生效', opinion: 'x', by: 'a', createdAt: '2026-09-01T00:00:00Z' }]);
  ok('老单项目字段仍能匹配', L.learnedForProject('某老项目').includes('老格式必须继续生效'));
  ok('老单条 lesson 仍进 LEARNED.md', /老格式必须继续生效/.test(L.buildLearnedMarkdown(L.listFeedback())));
  L.saveFeedback(SAMPLE);

  console.log('\n【4】LEARNED.md 结构（经验类型为主分组，作用域嵌在节内）');
  const md = L.buildLearnedMarkdown(L.listFeedback());
  const secOf = (kw) => { const i = md.indexOf(kw); return i < 0 ? -1 : i; };
  ok('有「误报纠正」小节', secOf('误报纠正') > 0);
  ok('有「漏报补充」小节', secOf('漏报补充') > 0);
  ok('有「判定口径」小节', secOf('判定口径') > 0);
  ok('有「审核重点与表述偏好」小节', secOf('审核重点与表述偏好') > 0);
  ok('类型级标注为「仅适用于…类报告」', /\*\*仅适用于「产能后评价」类报告：\*\*/.test(md));
  ok('项目级标注为「仅适用于项目…」', /\*\*仅适用于项目「塔河12-8区项目」：\*\*/.test(md));
  ok('归档条目不进 LEARNED.md', !md.includes('已归档的不应出现'));
  // 关键：类型级条目必须出现在**它所属的经验类型小节内**，不能全堆到文件末尾
  ok('「漏报补充」节内含项目级条目（作用域嵌在类型节内）',
    secOf('漏报补充') < secOf('**仅适用于项目「塔河12-8区项目」：**'));
  ok('「判定口径」节内含类型级条目',
    secOf('判定口径') < secOf('**仅适用于「产能后评价」类报告：**'));
  ok('多条口径渲染成嵌套列表而非「；」串句', /  - 差异<0\.5%且不改变结论/.test(md));
  ok('来源标注多项目', /适用 2 个项目/.test(md) || /塔河12-8区项目/.test(md));

  console.log('\n【5】作用域标签');
  ok('全局标签', L.scopeLabel(SAMPLE[2]) === '全局');
  ok('类型标签（多类）', L.scopeLabel(SAMPLE[0]) === '2 类报告');
  ok('类型标签（单类）', L.scopeLabel({ scope: 'type', projectTypes: ['X'] }) === '仅类型：X');
  ok('项目标签（多项目）', L.scopeLabel(SAMPLE[1]) === '指定 2 个项目');
  ok('项目标签（单项目）', L.scopeLabel({ scope: 'project', projectName: 'X' }) === '仅项目：X');
  ok('未指明的容错', L.scopeLabel({ scope: 'type', projectTypes: [] }) === '按类型（未指明）');

  console.log('\n【6】辅助函数边界');
  ok('feedbackTypes 去重', JSON.stringify(L.feedbackTypes({ projectTypes: ['x', 'x', ' y '] })) === '["x","y"]');
  ok('feedbackTypes 老单字段', JSON.stringify(L.feedbackTypes({ projectType: 'Z' })) === '["Z"]');
  ok('feedbackTaskIds 多任务', L.feedbackTaskIds(SAMPLE[1]).length === 2);
  ok('空/null 不崩', L.feedbackTypes({}).length === 0 && L.feedbackProjects({ projectNames: null }).length === 0
    && L.feedbackTaskIds({}).length === 0 && L.feedbackLessons({ lessons: null }).length === 0);
} finally {
  if (backup === null) { try { fs.rmSync(L.FEEDBACK_FILE, { force: true }); } catch { } }
  else fs.writeFileSync(L.FEEDBACK_FILE, backup, 'utf8');
  console.log(`\n已还原经验文件（${L.listFeedback().length} 条）`);
  console.log(`${fail === 0 ? '全部通过' : '存在失败'}：通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}
