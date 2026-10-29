/**
 * 「本次审核重点」自检（零 API、零网络）
 *
 * 覆盖三件事：
 *   ① 服务端解析与白名单：管理员才生效、勾选项必须在名单内、补充要求截断、坏编码不炸
 *   ② 提示词块：措辞必须明确"不是只审这些"（否则模型会把审核面缩到几项，反而漏问题）
 *   ③ 成果报告：有重点要求时印在开头，没有时不留空框（历史报告结构不变）
 *
 * 用法：node engine\test-review-focus.mjs
 */
import { focusBlock } from './lib/pipeline.mjs';
import { renderHtmlReport } from './lib/report-html.mjs';

const L = await import('../web/lib.mjs');

let pass = 0, fail = 0;
const ok = (c, n, extra = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${extra ? '  ← ' + extra : ''}`); } };
const eq = (a, b, n) => ok(a === b, n, `实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`);

// 造一份最小的 graded：只要能渲染出报告即可（内容不重要，验的是"开头有没有那段话"）
const graded = {
  stats: { p0Count: 0, p1Count: 1, p2Count: 0, p3Count: 0, total: 1 },
  p0: [], p3: [],
  p1: [{ category: '数据不实', description: '同一指标两处取值不一致', location: '表3-1', fix: '统一口径' }],
  p2: [],
};

console.log('\n── 1. 可选项名单（前后端同一份）──');
{
  ok(Array.isArray(L.REVIEW_FOCUS_OPTIONS) && L.REVIEW_FOCUS_OPTIONS.length >= 5,
    `名单共 ${L.REVIEW_FOCUS_OPTIONS.length} 项`);
  for (const need of ['经济评价正确性', '结论全面性', '建议针对性', '数据正确性']) {
    ok(L.REVIEW_FOCUS_OPTIONS.includes(need), `含「${need}」`);
  }
  ok(L.REVIEW_FOCUS_OPTIONS.includes('其他') === false, '名单里没有"其他"这类占位项（补充要求走文本框）');
  ok(new Set(L.REVIEW_FOCUS_OPTIONS).size === L.REVIEW_FOCUS_OPTIONS.length, '名单无重复项');
}

console.log('\n── 2. 服务端解析：权限在服务端兜住 ──');
{
  const admin = (o) => L.parseReviewFocus({ ...o, isAdmin: true });
  const user = (o) => L.parseReviewFocus({ ...o, isAdmin: false });

  const a1 = admin({ focusHeader: encodeURIComponent('数据正确性,结论全面性') });
  eq(a1.reviewFocus.join(','), '数据正确性,结论全面性', '管理员：正常解析勾选项');
  const a2 = admin({ focusHeader: encodeURIComponent('数据正确性,我自己编的方向') });
  eq(a2.reviewFocus.join(','), '数据正确性', '不在名单里的方向被丢弃（防手搓请求往提示词塞任意文字）');
  const a3 = admin({ focusHeader: encodeURIComponent('数据正确性,数据正确性') });
  eq(a3.reviewFocus.length, 1, '重复勾选去重');
  const a4 = admin({ focusHeader: '%E4%B8%AD%E6%96%87%E4%B8%8D%E5%AE%8C%E6%95%B4%E7%9A%84' });
  eq(a4.reviewFocus.length, 0, '编码不完整（URIError）不抛异常，按未填处理');

  const n1 = user({ focusHeader: encodeURIComponent('数据正确性'), noteHeader: encodeURIComponent('随便写点') });
  ok(n1.reviewFocus.length === 0 && n1.reviewNote === '', '**非管理员一律丢弃**（前端不显示≠权限）');

  const long = '重点'.repeat(2000);
  const a5 = admin({ noteHeader: encodeURIComponent(long) });
  ok(a5.reviewNote.length === L.REVIEW_NOTE_MAX, `补充要求截断到 ${L.REVIEW_NOTE_MAX} 字（防撑爆提示词）`);
  const a6 = admin({ noteHeader: encodeURIComponent('  前后有空格  ') });
  eq(a6.reviewNote, '前后有空格', '补充要求去首尾空白');
  const a7 = admin({});
  ok(a7.reviewFocus.length === 0 && a7.reviewNote === '', '什么都不填 → 空数组 + 空串（不注入）');
}

console.log('\n── 3. 提示词块（注入 S2 的 user 段）──');
{
  eq(focusBlock([], ''), '', '没填 → 返回空串（user 段不会多出空行，历史行为不变）');
  const b = focusBlock(['数据正确性'], '重点看表5-1');
  ok(b.includes('数据正确性') && b.includes('重点看表5-1'), '勾选项与补充要求都进提示词');
  ok(b.includes('不是只审这些'), '明确写了"不是只审这些"（防审核面缩水）');
  ok(b.includes('不必硬凑'), '明确写了"没问题不必硬凑"（防为凑数造问题）');
  const b2 = focusBlock(['结论全面性'], '');
  ok(!b2.includes('补充要求'), '没写补充要求时不出现"补充要求"字样');
  const b3 = focusBlock([], '只有一段补充要求');
  ok(b3.includes('只有一段补充要求') && b3.includes('本次审核重点'), '只填补充要求也能生效');
}

console.log('\n── 4. 成果报告开头 ──');
{
  const base = { id: 'T-test', sourceName: '某报告.docx', templateName: '后评价', ownerName: '张三' };
  // 断言只能查 <body> 里的内容：报告的 CSS 是内联的，样式注释里也写着"本次审核重点""文件信息"
  //    这些词（首版未切出 body，4 条断言均被注释里的字面量命中）。
  const bodyOf = (html) => html.slice(html.indexOf('<body'));
  const withFocusHtml = renderHtmlReport({
    task: { ...base, reviewFocus: ['数据正确性', '结论全面性'], reviewNote: '重点核对表5-1与批复差异' },
    graded, narrative: '', deepAccess: true,
  });
  const withFocus = bodyOf(withFocusHtml);
  ok(withFocus.includes('本次审核重点'), '审核成果：开头印出「本次审核重点」');
  ok(withFocus.includes('数据正确性') && withFocus.includes('结论全面性'), '两个方向都印出来');
  ok(withFocus.includes('重点核对表5-1与批复差异'), '补充要求也印出来');
  const iFocus = withFocus.indexOf('本次审核重点'), iMeta = withFocus.indexOf('文件信息');
  ok(iFocus > 0 && iMeta > 0 && iFocus < iMeta, '位置在「文件信息」之前（报告开头）');

  const noFocus = bodyOf(renderHtmlReport({ task: base, graded, narrative: '', deepAccess: true }));
  ok(!noFocus.includes('本次审核重点'), '没填重点 → 报告正文里不出现这一段（不留空框）');
  ok(!noFocus.includes('<div class="focusnote">'), '没填重点 → 不渲染提示条元素');

  const pfHtml = renderHtmlReport({
    task: { ...base, reviewFocus: ['数据正确性'], reviewNote: '' }, graded, narrative: '', deepAccess: false,
  });
  const pf = bodyOf(pfHtml);
  ok(pf.includes('本次审核重点') && pf.includes('校 对 成 果'), '校对成果（普通用户那份）同样印出重点');
  ok(pf.includes('数据正确性'), '校对成果里方向正确');
  const pfNo = bodyOf(renderHtmlReport({ task: base, graded, narrative: '', deepAccess: false }));
  ok(!pfNo.includes('<div class="focusnote">'), '校对成果：没填时不渲染提示条');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 本次审核重点自检：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
