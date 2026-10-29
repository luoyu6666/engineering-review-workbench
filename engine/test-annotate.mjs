/**
 * 原报告标注版 自检 —— 零 API、秒级跑完
 *
 * 覆盖：编号一致性、文本归一化、location 线索、坐标解析、定位四档、排版回归点。
 * 不覆盖：LibreOffice / pdftoppm / Chrome（那三项是端到端，见 annotate-sample.mjs 复跑）。
 *
 * 用法：node engine\test-annotate.mjs
 */
import {
  norm, normLite, shortNote, noteText, noteParts, locationTokens, parseBboxXml, buildPages,
  buildGramIndex, buildNumberIndex, locate, colorOf, renderAnnotatedHtml, PROOF_COLOR, scopeItems,
  toolchainStatus, toolchainHint,
} from './lib/annotate.mjs';
import { reportIssues, reportIssueList, classify, renderHtmlReport, crossPairs, isCrossSource, splitParts } from './lib/report-html.mjs';
import fs from 'node:fs';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  ← ' + extra : ''}`); }
};
const eq = (a, b, name) => ok(a === b, name, `实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`);

console.log('\n── 1. 全局编号（成果报告 ↔ 标注版 一一对应）──');
{
  const graded = {
    p0: [
      { id: 'P0-1', category: '关键数据错误', description: 'a' },
      { id: 'P0-2', category: '逻辑分析', description: 'b' },
    ],
    p1: [
      { id: 'P1-1', category: '编校错误', description: 'c' },
      { id: 'P1-2', category: '结论正确性', description: 'd' },
      { id: 'P1-3', category: '数据不实', description: 'e' },
    ],
    p2: [{ id: 'P2-1', category: '其他', description: 'f' }],
    p3: [],
  };
  const deep = reportIssues(graded, { scope: 'deep' });
  const proof = reportIssues(graded, { scope: 'proof' });
  eq(deep.p0.map(x => x.no).join(','), 'P0-1,P0-2', '深度版 P0 连续编号');
  eq(deep.p0[0].cls, 'proofread', '校对类排在 P0 最前');
  eq(deep.p1.map(x => x.no).join(','), 'P1-1,P1-2,P1-3', 'P1 不再按小节重新从 1 开始');
  eq(deep.p1.map(x => x.cls).join(','), 'proofread,proofread,deep', 'P1 = 校对类整体在前 + 深度类在后');
  eq(proof.p1.map(x => x.no).join(','), 'P1-1,P1-2', '校对版只留校对类，且编号与深度版一致');
  eq(reportIssueList(graded, { scope: 'deep' }).length, 6, '一维列表条数正确');
  eq(classify({ category: '标准规范' }), 'proofread', '标准规范仍属校对类');
}

console.log('\n── 1b. 校对档取哪些条目（回归：P2/P3 里的校对类不许混进校对版）──');
{
  // 关键构造：p2 档里放一条分类属于校对类的问题（编校错误）。
  // 校对成果报告会整组丢掉 P2/P3 —— 所以校对版标注也必须丢掉它。
  // 此前校对版用 `cls === 'proofread'` 过滤，把这条留下来了，
  // 于是校对版 PDF 上多印一个报告里没有的编号（经实测多出 P2-1、P2-2）。
  const graded = {
    p0: [{ category: '数据不实', description: 'a' }],
    p1: [{ category: '标准规范', description: 'b' }],
    p2: [{ category: '编校错误', description: 'c' }, { category: '逻辑分析', description: 'd' }],
    p3: [{ category: '编校错误', description: 'e' }],
  };
  const deepItems = reportIssueList(graded, { scope: 'deep' });
  const proofIds = reportIssueList(graded, { scope: 'proof' }).map(x => x.no);
  const proofNos = new Set(proofIds);

  const oldWay = deepItems.filter(x => x.cls === 'proofread').map(x => x.no);
  const newWay = scopeItems(deepItems, 'proof', proofNos).map(x => x.no);
  eq(newWay.join(','), proofIds.join(','), '校对档取到的编号 = 校对成果报告的编号（完全一致）');
  ok(newWay.every(no => !no.startsWith('P2-') && !no.startsWith('P3-')), '校对档里不再出现 P2/P3 编号');
  ok(oldWay.some(no => no.startsWith('P2-')), `旧写法确实会混进 P2（回归证据：${oldWay.join(',')}）`);
  eq(scopeItems(deepItems, 'deep', proofNos).length, deepItems.length, '审核档仍是全量');
}

console.log('\n── 2. 文本归一化与侧栏提炼 ──');
{
  eq(norm('天然 气0.78、电力 119.85'), '天然气078电力11985', 'norm 去空白与标点（小数点也去掉，两侧一致即可）');
  eq(norm('（1）'), '(1)', 'norm 统一全角括号');
  eq(normLite('表 4-2（项目）'), '表4-2（项目）', 'normLite 只去空白、保留编号');
  eq(normLite('2019–2023'), '2019-2023', 'normLite 统一破折号');
  const s1 = shortNote({ description: '【关键数据错误·共 7 项】分项0.78+119.85=120.63tCO₂，合计却填20.62' });
  ok(s1.includes('分项0.78'), '提炼不被小数点截断（回归：曾输出"分项0"）', s1);
  ok(s1.length > 15, '侧栏不再硬截成 15 字（用户反馈：省略号看不出问题全貌）', s1);
  ok(s1.includes('120.63'), '默认能读到较长的一段问题描述', s1);
  eq(noteText({ description: 'x'.repeat(300) }, 60).length, 60, '按版面需要可以压到指定长度');
  const s2 = shortNote({ description: '整段为无量化套话堆砌' });
  eq(s2, '整段为无量化套话堆砌', '短描述原样保留');
  eq(shortNote({ description: '', quote: '', category: '数据不实' }), '数据不实', '无描述时退回类别名');
}

console.log('\n── 3. location 线索与坐标解析 ──');
{
  const toks = locationTokens('表4-2 项目实施碳排放量表 / 4.2.2；正文2.2.1 vs 附表4 第1.1.9行');
  ok(toks.includes('表4-2'), '识别表号', toks.join('/'));
  ok(toks.includes('4.2.2'), '识别章节号', toks.join('/'));
  ok(toks.includes('附表4'), '识别附表号', toks.join('/'));
  const bbox = parseBboxXml('<page width="595.28" height="841.89">'
    + '<word xMin="10" yMin="20" xMax="50" yMax="32">天然气&amp;电力</word>'
    + '<word xMin="55" yMin="20" xMax="90" yMax="32">119.85</word></page>');
  eq(bbox.length, 1, '解析出 1 页');
  eq(bbox[0].words.length, 2, '解析出 2 个词');
  eq(bbox[0].words[0].t, '天然气&电力', 'XML 实体正确反转义');
}

console.log('\n── 4. 定位四档 ──');
{
  // 造两页假数据：第 0 页有正文，第 1 页有一张"表"
  const mkPage = (w, h, words) => ({ w, h, words: words.map(([t, x, y]) => ({ t, x0: x, y0: y, x1: x + t.length * 8, y1: y + 12 })) });
  const bbox = [
    mkPage(595, 842, [['本工程', 10, 20], ['新建', 40, 20], ['单井', 70, 20], ['集输管线', 100, 20], ['2.75km', 160, 20]]),
    mkPage(842, 595, [['表4-2', 20, 30], ['碳排放量表', 70, 30], ['天然气', 20, 60], ['0.78', 90, 60], ['电力', 20, 80], ['119.85', 90, 80], ['合计', 20, 100], ['20.62', 90, 100]]),
  ];
  const pages = buildPages(bbox);
  const ctx = { pages, grams: buildGramIndex(pages), numbers: buildNumberIndex(pages), N: 8 };

  const hit = locate({ quote: '新建单井集输管线2.75km', location: '' }, ctx);
  eq(hit.tier, 'exact', '原文原话 → 精确定位');
  eq(hit.page, 0, '落在第 0 页');
  ok(hit.box && hit.box.x0 >= 40, '框落在正文那一行');

  const frag = locate({ quote: '仅评价「新建单井集输管线」的变更程序规范', location: '' }, ctx);
  eq(frag.tier, 'exact', '整句匹配不上时用引号片段兜底');
  eq(frag.how, 'fragment', '标记为片段命中');

  const num = locate({ quote: '天然气0.78、电力119.85，合计20.62', location: '表4-2' }, ctx);
  ok(num.tier === 'approx' || num.tier === 'exact', '表格类(数字重组) 至少近似档');
  ok(num.page === 1, '落在有该表的第 1 页');

  const sec = locate({ quote: '完全不存在的一句话也不含数字', location: '表4-2 碳排放量表' }, ctx);
  eq(sec.tier, 'section', '找不到原文 → 退到章节/表标题');
  eq(sec.page, 1, '章节定位页正确');

  const none = locate({ quote: '全文未见编制依据清单', location: '目录/全文' }, ctx);
  eq(none.tier, 'none', '缺失型问题 → 进末页清单');

  // 护栏回归（2026-09-24 全量核查发现的缺陷）：sectionBox 找到了章节标题文字、
  // 但拿不到词坐标（box 为 null）时，渲染器无法绘制 —— 此时不报"章节定位"。
  // 否则档位表/成果报告标注为"章节定位"，标注版上连编号都没有，按编号无法定位。
  // （经实测 141 条 section 里有 3 条属此情况：P1-84 / P1-21 / P1-14。）
  const pagesNoBox = pages.map((p, i) => (i === 1 ? { ...p, words: [], map: [], liteMap: [] } : p));
  const ctxNB = { pages: pagesNoBox, grams: buildGramIndex(pagesNoBox), numbers: buildNumberIndex(pagesNoBox), N: 8 };
  const nb = locate({ quote: '完全不存在的一句话也不含数字', location: '表4-2 碳排放量表' }, ctxNB);
  eq(nb.tier, 'none', '拿到标题、拿不到词坐标 → 老实报未定位，不许谎报章节定位');
  eq(nb.page, -1, '未定位的页码为 -1（渲染器不会画）');
  ok(!nb.box, '未定位不带框');
  eq(nb.dropped, 'section', '诊断字段记下"本来要报的档位"，便于排查');
}

console.log('\n── 5. 配色（用户口径）──');
{
  eq(colorOf({ cls: 'proofread', sev: 'P0' }), PROOF_COLOR, '校对类一律蓝色（不分程度）');
  eq(colorOf({ cls: 'deep', sev: 'P0' }), '#a11212', '审核类 P0 深红');
  eq(colorOf({ cls: 'deep', sev: 'P1' }), '#d97500', '审核类 P1 橙');
  eq(colorOf({ cls: 'deep', sev: 'P2' }), '#c9a200', '审核类 P2 黄');
  eq(colorOf({ cls: 'deep', sev: 'P3' }), '#c9a200', '审核类 P3 黄');
}

console.log('\n── 6. 排版回归点（用户 5 条反馈）──');
{
  const pages = [
    { w: 595, h: 842, words: [{ t: '测试正文内容', x0: 10, y0: 20, x1: 100, y1: 32 }], s: '测试正文内容', map: [{ at: 0, wi: 0, len: 6 }], lite: '测试正文内容', liteMap: [{ at: 0, wi: 0, len: 6 }] },
    { w: 842, h: 595, words: [{ t: '横版附表', x0: 10, y0: 20, x1: 80, y1: 32 }], s: '横版附表', map: [{ at: 0, wi: 0, len: 4 }], lite: '横版附表', liteMap: [{ at: 0, wi: 0, len: 4 }] },
  ];
  const items = [
    { no: 'P0-1', sev: 'P0', cls: 'proofread', note: '数据不一致', page: 0, box: { x0: 10, y0: 20, x1: 100, y1: 32 }, tier: 'exact', how: 'quote' },
    { no: 'P1-2', sev: 'P1', cls: 'deep', note: '逻辑链条断裂', page: 0, box: { x0: 12, y0: 24, x1: 90, y1: 36 }, tier: 'approx', how: 'number' },
    { no: 'P1-3', sev: 'P1', cls: 'deep', note: '缺失编制依据', page: -1, box: null, tier: 'none', how: '' },
    { no: 'P2-1', sev: 'P2', cls: 'deep', note: '章节问题', page: 1, box: { x0: 10, y0: 20, x1: 80, y1: 32 }, tier: 'section', how: '' },
  ];
  const { html, stats } = renderAnnotatedHtml({ pages, items, images: ['AAAA', 'BBBB'], scope: 'deep', meta: { taskId: 'T1', sourceName: 'x.docx' } });
  eq(stats.total, 4, '统计总条数');
  eq(stats.exact, 1, '统计精确定位');
  eq(stats.approx, 1, '统计近似定位');
  eq(stats.section, 1, '统计章节定位');
  eq(stats.none, 1, '统计未定位（进首页与末页清单）');
  eq(stats.approxNumber, 1, '单独统计数字指纹条数');
  eq(stats.rate, 50, '可用定位率 = (精确+近似)/总数');
  eq(stats.coverRate, 75, '覆盖率含章节定位');
  ok(html.includes('原报告标注版'), '新增首页：写明这是什么版本');
  ok(html.includes('标注情况'), '首页有「标注情况」统计表');
  ok(html.includes('未能在原报告中标出位置'), '首页明确写出"哪些没标出来"');
  ok(html.includes('未能定位清单') || html.includes('未能在原报告中标出位置的问题'), '未定位条目有专门清单');
  ok(html.includes('约 0.5') || html.includes('本版共 4 条'), '首页给出总条数与分档数字');
  ok(!/max-width\s*:\s*360px/.test(html), '反馈1：侧栏不再写死 max-width:360px');
  ok(/word-break:break-word/.test(html), '反馈1：侧栏允许断行');
  ok(/data-y="/.test(html), '反馈2：批注带 data-y，供脚本按框对齐');
  ok(/data-by="/.test(html) && /data-bx="/.test(html), '第三轮：批注带"框的 y /框右缘 x"，引线才能从框引出');
  {
    // 单位陷阱回归：box.x1 是 PDF 点、版面是毫米，夹取上限必须用页面宽度（点）。
    // 早先错用毫米上限，把几乎所有框的右缘都夹成同一个值（引线落在框内文字上）。
    const m = html.match(/data-bx="([\d.]+)"/);
    const got = m ? Number(m[1]) : NaN;
    const expect = 5 + 100 * Math.min((297 - 10 - 6 - 56) / 595, (209 - 10) / 842);   // 测试里的框 x1=100pt
    ok(Math.abs(got - expect) < 0.5, `引线起点 = 框右缘（点→毫米换算正确，实际 ${got}，期望 ${expect.toFixed(2)}）`);
  }
  ok(!/Math\.atan2|rotate\(/.test(html), '第四轮：不再用斜引线（用户明确不要斜线）');
  ok(/border-top:1\.2px solid/.test(html), '第四轮：水平引线（实线、细、彩色）');
  {
    // 第八轮：文字优先写全（不压成省略号）；只有完全同一高度才合并
    const mk = (no, y0, desc) => ({
      no, sev: 'P1', cls: 'deep', category: '数据不实', description: desc, page: 0,
      box: { x0: 10, y0, x1: 100, y1: y0 + 12 }, tier: 'exact', how: 'quote',
    });
    const long = '其他单项指标得分出现负值并参与加权，评分方法（封顶、负分、方向）未说明，易致综合得分被重复放大扣减，须在评分表中说明取整与封顶规则。';
    const one = renderAnnotatedHtml({ pages: [pages[0]], items: [mk('P1-1', 20, long)], images: ['AAAA'], scope: 'deep' });
    ok(one.html.includes(long.slice(0, 60)), '长问题完整写进批注（不截成省略号）', '');
    const same = renderAnnotatedHtml({ pages: [pages[0]], items: [mk('P1-1', 20, '甲问题'), mk('P1-2', 21, '乙问题')], images: ['AAAA'], scope: 'deep' });
    eq((same.html.match(/<div class="note"/g) || []).length, 1, '完全同一高度 → 合成一条批注');
    const apart = renderAnnotatedHtml({ pages: [pages[0]], items: [mk('P1-1', 20, '甲问题'), mk('P1-2', 60, '乙问题')], images: ['AAAA'], scope: 'deep' });
    eq((apart.html.match(/<div class="note"/g) || []).length, 2, '高度不同 → 分开两条批注（不再过度合并）');
  }
  ok(/一条\*\*连续\*\*的水平线|一条连续的水平线/.test(html) && /d\.style\.left = bx \+ 'mm'/.test(html) && /nl - bx - 0\.4/.test(html),
    '第七轮：引线是**一条连续**水平线（框右缘→批注左缘），中间不留断开');
  ok(!/borderTopColor = n\.getAttribute/.test(html), '第三轮：不再把横线画在批注高度上（旧实现已删）');
  ok(/\.leader\{/.test(html), '反馈2：有引导线样式');
  ok(html.includes('landscape'), '反馈3：A4 横向版心');
  ok(/P0-1/.test(html) && /P1-3/.test(html), '编号直接印在标记/清单上');
  ok(html.includes('逻辑链条断裂'), '批注印完整提炼（不是只剩省略号）');
  const { stats: s2 } = renderAnnotatedHtml({ pages: [pages[0]], items: [{ no: 'P0-1', sev: 'P0', cls: 'proofread', note: 'x', page: -1, box: null, tier: 'none', how: '' }], images: ['AAAA'], scope: 'proof' });
  eq(s2.rate, 0, '全未定位时可用定位率为 0（不虚报）');
  eq(s2.coverRate, 0, '覆盖率为 0');
}

console.log('\n── 7. 成果报告里的"未能标出"提示 ──');{
  const graded = {
    p0: [{ id: 'x', category: '关键数据错误', description: 'P0 一条', location: '表4-2' }],
    p1: [
      { id: 'y', category: '编校错误', description: '标得到的一条', location: '1.1' },
      { id: 'z', category: '标准规范', description: '标不到的一条', location: '全文' },
    ],
    p2: [], p3: [],
    stats: { p0Count: 1, p1Count: 2, p2Count: 0, p3Count: 0 },
  };
  const tiers = { 'P0-1': { tier: 'none', how: '', page: -1 }, 'P1-1': { tier: 'exact', how: 'quote', page: 3 }, 'P1-2': { tier: 'approx', how: 'number', page: 5 } };
  const h = renderHtmlReport({ task: { sourceName: 'x.docx' }, graded, narrative: '', deepAccess: true, annotateTiers: tiers });
  ok(h.includes('未能在原报告中标出位置'), '未标出的条目在报告里红字提示');
  ok(h.includes('近似'), '近似定位的条目在报告里也注明');
  const h2 = renderHtmlReport({ task: { sourceName: 'x.docx' }, graded, narrative: '', deepAccess: true });
  ok(!h2.includes('未能在原报告中标出位置'), '没有档位信息时不瞎标（历史任务安全）');
}

console.log('\n── 8. 跨源不一致必须写出处（值 ↔ 位置）──');
{
  const it = {
    id: 'P0-3', category: '数据不实', description: '跨源数据不一致：「钻井工程投资减少额」在不同位置出现 2 个不同取值——638万元 / 648万元。',
    quote: '钻井工程投资减少额：638万元（正文3.1） / 648万元（表3-1、表3-3、表1-2）',
    location: '正文3.1；表3-1、表3-3、表1-2',
  };
  const pairs = crossPairs(it);
  eq(pairs.length, 2, '从 quote 抽出两对「值（出处）」');
  eq(pairs[0].value + '|' + pairs[0].where, '638万元|正文3.1', '第一对的取值与出处');
  eq(pairs[1].where, '表3-1、表3-3、表1-2', '第二对的出处');
  ok(isCrossSource(it), '识别为"同一事实多处取值"类');
  const graded = { p0: [it], p1: [], p2: [], p3: [], stats: { p0Count: 1, p1Count: 0, p2Count: 0, p3Count: 0 } };
  const h = renderHtmlReport({ task: { sourceName: 'x.docx' }, graded, narrative: '', deepAccess: true });
  ok(h.includes('两处取值与出处'), '报告里单列「两处取值与出处」');
  ok(h.includes('638万元') && h.includes('正文3.1') && h.includes('表3-1、表3-3、表1-2'), '两处出处都写出来了');
  const note = noteText(it, 200);
  ok(note.includes('正文3.1') && note.includes('表3-1'), '标注版批注也带出处（用 quote 那段）');
}

console.log('\n── 9. 多条问题各自另起一行（「／」分隔）──');
{
  const it = { description: '【关键数据错误·共 3 项】A 问题说明 ／ B 问题说明 ／ C 问题说明',
    quote: '按0.119×108MJ×56.1tCO₂/TJ应约668t，电力122.42×104kWh×0.6231应约763t', category: '关键数据错误' };
  eq(noteParts(it, 600).length, 3, '按全角「／」拆成 3 条');
  eq(splitParts(it.description).length, 3, '报告侧同样拆成 3 条');
  const units = '按0.119×108MJ×56.1tCO₂/TJ应约668t，单价0.31元/m³，83元/t';
  eq(splitParts(units).length, 1, '单位里的斜杠（tCO₂/TJ、元/m³、元/t）不当作分隔符');
  eq(noteParts({ description: units }, 600).length, 1, '批注侧同样不误拆');
  const pg0 = { w: 595, h: 842, words: [{ t: 'x', x0: 10, y0: 20, x1: 40, y1: 32 }], s: 'x', map: [{ at: 0, wi: 0, len: 1 }], lite: 'x', liteMap: [{ at: 0, wi: 0, len: 1 }] };
  const html9 = renderAnnotatedHtml({ pages: [pg0], items: [{ no: 'P0-1', sev: 'P0', cls: 'proofread', category: '关键数据错误', description: it.description, page: 0, box: { x0: 10, y0: 20, x1: 100, y1: 32 }, tier: 'exact', how: 'quote' }], images: ['AAAA'], scope: 'proofread' });
  eq((html9.html.match(/class="np"/g) || []).length, 3, '批注里三条各占一行');
  ok(!/…/.test((html9.html.match(/<span class="t">[\s\S]*?<\/span><\/div>/) || [''])[0]), '未超长时不出现省略号');
}

console.log('\n── 10. 标注工具链解析（2026-09-28 事故回归：pdftoppm 在 SYSTEM 身份下找不到）──');
{
  // 事故：pdftoppm/pdftotext 原以裸名字经 PATH 查找 —— 开发机（管理员账户）能找到，
  // 但生产服务以计划任务、SYSTEM 身份运行，只可见机器 PATH，其中没有 MikTeX 目录，
  // 导致每次标注版生成都以 ENOENT 失败，使用方反复点"生成"均失败。
  // 此处锁死"必须解析为存在的绝对路径"，防止改回裸名字。
  const st = toolchainStatus();
  const isAbs = (p) => !!p && path.isAbsolute(p);
  ok(isAbs(st.soffice.path), 'soffice 解析成绝对路径（不是裸名字）', st.soffice.path);
  ok(isAbs(st.pdftoppm.path), '**pdftoppm 解析成绝对路径**（裸名字会在 SYSTEM 身份下 ENOENT）', st.pdftoppm.path);
  ok(isAbs(st.pdftotext.path), '**pdftotext 解析成绝对路径**', st.pdftotext.path);
  ok(st.ok === (st.soffice.ok && st.pdftoppm.ok && st.pdftotext.ok), '总状态 = 三者都可用');
  if (st.ok) {
    ok(fs.existsSync(st.pdftoppm.path), '解析出的 pdftoppm 文件真实存在');
    ok(fs.existsSync(st.pdftotext.path), '解析出的 pdftotext 文件真实存在');
    ok(fs.existsSync(st.soffice.path), '解析出的 soffice 文件真实存在');
  } else {
    ok(/pdftoppm|pdftotext|soffice/.test(toolchainHint(st)), '缺工具时给出**可执行的修复指引**（不是空错误）');
  }
  // 源码层面：不得再出现裸 'pdftoppm' / 'pdftotext' 常量（即上述事故的写法）
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'lib/annotate.mjs'), 'utf8');
  ok(!/const PDFTOPPM = process\.env\.PDFTOPPM \|\| 'pdftoppm'/.test(src), '源码里没有"裸 pdftoppm" 的写法');
  ok(!/const PDFTOTEXT = process\.env\.PDFTOTEXT \|\| 'pdftotext'/.test(src), '源码里没有"裸 pdftotext" 的写法');
  ok(/function findExe\(/.test(src), '有统一的外部程序解析函数 findExe()');
  ok(/try \{ if \(fs\.existsSync\(c\)\) return c; \} catch/.test(src), '解析时会跳过权限/路径异常，不因某个候选目录报错而整体失败');
  ok(/requireTool\(PDFTOPPM, 'pdftoppm', 'PDFTOPPM'\)/.test(src), '用之前先校验，缺了给中文可执行提示（不是裸 ENOENT）');
  // soffice 并发隔离：LibreOffice 单实例，并发转换会互相打架
  ok(/-env:UserInstallation=file:\/\/\//.test(src), '**soffice 每次用独立用户配置目录**（否则并发转换会失败）');
  const srv = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'web/server.mjs'), 'utf8');
  ok(/标注工具 : ✓ soffice \+ pdftoppm \+ pdftotext/.test(srv), '启动横幅会报标注工具链是否齐全');
  ok(/标注工具 : ✗ \$\{toolchainHint\(ts\)\}/.test(srv), '缺工具时启动横幅明确报出来（这次事故就是没人看见）');
  ok(/task\.annotateError = \{ \.\.\.\(task\.annotateError \|\| \{\}\), \[key\]/.test(srv),
    '**失败的流水线会把失败原因写进任务元数据**（界面据此显示原因，不再静默）');
  ok(/annotateError: task\.annotateError \|\| null/.test(srv), '任务详情接口下发 annotateError');
  ok(/annotateToolchain: toolchainStatus\(\)/.test(srv), '任务详情接口下发工具链状态（管理员排查用）');
  const idx = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'web/public/index.html'), 'utf8');
  ok(/function annErrLine\(t\)/.test(idx), '界面会显示标注版失败原因（annErrLine）');
  ok(/st\.status === 'error' && wantsRetry/.test(srv) || /wantsRetry/.test(srv),
    '**只有用户明确重试才重起生成**（防止轮询每几秒把必然失败的转换重跑一遍）');
}

console.log('\n── 11. PPT 标注版两件事（2026-09-28 用户要求）──');
{
  const annoSrc = fs.readFileSync(path.resolve(import.meta.dirname, 'lib/annotate.mjs'), 'utf8');
  const srv = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'web/server.mjs'), 'utf8');
  const idx = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'web/public/index.html'), 'utf8');

  // ① 配对任务（报告 + PPT）也要有 PPT 的标注版
  ok(/export function hasPairedPpt\(/.test(annoSrc), '有 hasPairedPpt()：判断任务是否"报告 + PPT"配对');
  ok(/export async function prepareAnnotation\(\{ taskDir, preferPptx = false, kind = ''/.test(annoSrc),
    'prepareAnnotation 支持 kind（报告 / PPT 两路）');
  ok(/if \(onlyExt === '\.pptx'\) return \(userPpt\[0\] \|\| \[\.\.\.pptx\]\.sort\(bySize\)\[0\] \|\| null\)/.test(annoSrc),
    "kind='ppt' 时**只取 PPT**，没有就返回 null（不拿报告冒充 PPT）");
  ok(/const annotateKeyOf = \(scope, kind\) => \(kind === 'ppt' \? `ppt-\$\{scope\}` : scope\)/.test(srv),
    '标注版分路：报告 proof/deep，PPT 用 ppt-proof / ppt-deep');
  ok(/'原PPT标注版-审核\.pdf' : '原PPT标注版-校对\.pdf'/.test(srv), 'PPT 标注版用独立文件名（原PPT标注版-校对/审核.pdf）');
  ok(/const paired = hasPairedPpt\(dir\);[\s\S]{0,200}?if \(paired\) jobs\.push\(\['proof', 'ppt'\], \['deep', 'ppt'\]\)/.test(srv),
    '**配对任务在流水线里同时生成 PPT 标注版**（校对 + 审核）');
  ok(/if \(kind === 'ppt' && !hasPairedPpt\(L\.taskDir\(task\.id\)\)\)/.test(srv),
    '没有配对 PPT 的任务，请求 PPT 标注版会被明确拒绝（不返回报告的）');
  ok(/annReady\.pptProof = fs\.existsSync\(annotateOut\(task\.id, 'proof', 'ppt'\)\)/.test(srv),
    '任务详情下发 pptProof（界面据此显示 PPT 标注版按钮）');
  ok(/\$\{\(t\.annotateReady && t\.annotateReady\.ppt\)[\s\S]{0,220}?'ppt'\)/.test(idx),
    '界面在有配对 PPT 时显示「原PPT标注版（校对/审核）」按钮');
  ok(/kind === 'ppt' \? '&kind=ppt' : ''/.test(idx), '下载/请求都带上 kind=ppt');
  ok(/'ppt-proof', 'ppt-deep'\]/.test(idx), '失败提示覆盖 PPT 那两路');

  // ② PPT 标注错位的根因修复：spAutoFit → noAutofit（LibreOffice 会把正文压丢）
  ok(/function sanitizePptx\(/.test(annoSrc), '有 sanitizePptx()：转换前修 PPTX 排版');
  ok(/spAutoFit/.test(annoSrc) && /noAutofit/.test(annoSrc), '把 spAutoFit 换成 noAutofit');
  ok(/'ppt\/\(slides\|slideLayouts\|slideMasters\)/.test(annoSrc) || /ppt\/\(slides\|slideLayouts\|slideMasters\)/.test(annoSrc),
    '只改幻灯片/版式/母版的 XML（不动其它部件）');
  ok(/const dst = path\.join\(workDir, 'fixed-' \+ path\.basename\(srcPath\)\)/.test(annoSrc)
    && /Copy-Item -LiteralPath \$Src -Destination \$Dst -Force/.test(annoSrc),
    '**只改副本、绝不动用户原件**（原件要留档、要能下载）');
  ok(/const abs = \/\\\.pptx\$\/i\.test\(srcName\) \? sanitizePptx\(abs0, work, log\) : abs0/.test(annoSrc),
    'prepareAnnotation 里 PPTX 走修补后的副本');
  ok(/PPTX 修补失败（改用原件，标注位置可能偏差）/.test(annoSrc), '修补失败也能降级继续（不让任务失败）');
}

console.log('\n── 12. 审核台账分页（用户要求：默认 10 条，保留 20 等选项）──');
{
  const idx = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'web/public/index.html'), 'utf8');
  ok(/page: 1, per: 10, mode: 'list'/.test(idx), '**台账默认每页 10 条**（原来 20）');
  ok(/\[10, 20, 50, 100\]\.map\(n =>/.test(idx), '每页条数选项含 10 / 20 / 50 / 100');
  ok(/function setTaskPer\(n\) \{ TASK_VIEW\.per = Number\(n\) \|\| 10;/.test(idx), '切换每页条数的兜底值也改成 10');
}

console.log(`\n合计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}\n`);
process.exit(fail ? 1 : 0);
