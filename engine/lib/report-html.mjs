/**
 * 审核意见书 HTML 生成器
 *
 * 设计原则（分层口径）：
 *   · 结构化内容（P0 详述 / P1 附录 / 统计表）→ 代码生成，确定、可复现、样式可控
 *   · 叙述性内容（总体评价 / 结论建议）      → 模型生成，通过 md→html 嵌入
 *
 * 报告分两类：
 *   · 校对类 proofread —— 数据不一致、错别字、格式、术语、AI套话等客观可自查的问题
 *   · 深度类 deep      —— 逻辑分析、结论正确性、建议合理性等需要专业判断的问题
 *   普通用户只看校对类；管理员与获授权者看两类。
 */

// ─────────────── 问题分类 ───────────────

/** 校对类：客观、机械、不需要专业判断，使用方可自行核对 */
export const PROOFREAD_CATEGORIES = new Set([
  '编校错误',     // 错别字、病句、文号错、格式
  '术语错误',     // 术语不统一、主谓宾不成立
  'AI套话',       // 豆包风格、模板化表述
  '数据不实',     // 数值不一致、跨源冲突
  '口径混用',     // 含税/不含税、分母基准
  '工程量多口径', // 同一工程量多个值
  '关键数据错误', // 计算笔误（如 -414%）
  // 「标准规范」下放到校对类：编号写法、年号、名称与编号是否匹配、是否已被替代/废止、
  // 正文引用与依据清单是否一致 —— 这些都是拿编号去核就能确认的客观问题，不需要专业判断，
  // 所以划到校对类，普通用户也能看到并自行核对。
  '标准规范',
]);

/** 返回 'proofread' | 'deep' */
export function classify(it) {
  return PROOFREAD_CATEGORIES.has(it.category) ? 'proofread' : 'deep';
}

const CLASS_LABEL = { proofread: '校对类', deep: '深度类' };

/**
 * 全局编号（成果报告 与 原报告标注版 共用同一套编号）
 *
 * 为什么要有这个函数：标注版与成果报告必须一一对应（成果报告第 N 条 ↔ 标注版第 N 个标记）。
 * 如果两边各算各的（报告 P1 表在"校对类/深度类"两个小节里各自从 1 开始），编号对不上，
 * 标注版就失去意义。所以编号只在这里生成一次，报告和标注版都从这里取。
 *
 * 编号规则（与报告的排版顺序完全一致）：
 *   · P0：校对类在前、深度类在后，连续编号 P0-1 … P0-n（校对版只有校对类）
 *   · P1：同上，连续编号 P1-1 … P1-n（不再按小节重新从 1 开始）
 *   · P2 / P3：各自连续编号；校对版不含 P2/P3
 * 同一份报告里，同一条问题在「校对成果」与「审核成果」中编号一致（校对类都排在前面）。
 *
 * @param {object} graded  s4_graded.json 的内容
 * @param {{scope?: 'proof'|'deep'}} opts  proof=校对版（只含校对类）；deep=审核版（全部）
 * @returns {{p0:object[],p1:object[],p2:object[],p3:object[]}} 每项带 cls / sev / no
 */
export function reportIssues(graded, { scope = 'deep' } = {}) {
  const withCls = (arr) => (arr || []).map(it => ({ ...it, cls: classify(it) }));
  const onlyPf = scope === 'proof';
  const ord = (arr) => {
    const pf = arr.filter(x => x.cls === 'proofread');
    if (onlyPf) return pf;
    return [...pf, ...arr.filter(x => x.cls !== 'proofread')];
  };
  const tag = (arr, sev) => arr.map((it, i) => ({ ...it, sev, no: `${sev}-${i + 1}` }));
  return {
    p0: tag(ord(withCls(graded?.p0)), 'P0'),
    p1: tag(ord(withCls(graded?.p1)), 'P1'),
    p2: onlyPf ? [] : tag(withCls(graded?.p2), 'P2'),
    p3: onlyPf ? [] : tag(withCls(graded?.p3), 'P3'),
  };
}

/** 平铺成一维（标注版按这个顺序标注、也按这个顺序保证编号不断） */
export function reportIssueList(graded, opts = {}) {
  const r = reportIssues(graded, opts);
  return [...r.p0, ...r.p1, ...r.p2, ...r.p3];
}

/** 统一按北京时间格式化，避免提交时间(UTC)与审核时间(本地)差 8 小时 */
function fmtBJ(v, withSec = true) {
  if (!v) return '—';
  const d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d.getTime())) return String(v);
  const bj = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60000);
  const p = (n) => String(n).padStart(2, '0');
  const s = `${bj.getFullYear()}-${p(bj.getMonth() + 1)}-${p(bj.getDate())} ${p(bj.getHours())}:${p(bj.getMinutes())}`;
  return withSec ? `${s}:${p(bj.getSeconds())}` : s;
}

// ─────────────── 极简 Markdown → HTML ───────────────

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 支持：标题 / 粗体 / 有序无序列表 / 表格 / 段落。够用即可，不追求完整 CommonMark。 */
export function mdToHtml(md) {
  const lines = String(md || '').split(/\r?\n/);
  const out = [];
  let inTable = false, listType = null;

  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
  const closeTable = () => { if (inTable) { out.push('</tbody></table>'); inTable = false; } };

  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    if (!line) { closeList(); closeTable(); continue; }

    // 表格：| a | b |   + 分隔行 | --- | --- |
    if (/^\|.*\|$/.test(line)) {
      const cells = line.slice(1, -1).split('|').map(c => c.trim());
      const next = (lines[i + 1] || '').trim();
      if (!inTable && /^\|[\s:|-]+\|$/.test(next)) {
        closeList();
        out.push('<table><thead><tr>' + cells.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>');
        inTable = true; i++; continue;
      }
      if (inTable) { out.push('<tr>' + cells.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>'); continue; }
    } else closeTable();

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`); continue; }

    const ul = line.match(/^[-*]\s+(.*)$/);
    if (ul) { if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; } out.push(`<li>${inline(ul[1])}</li>`); continue; }
    const ol = line.match(/^\d+[.)]\s+(.*)$/);
    if (ol) { if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; } out.push(`<li>${inline(ol[1])}</li>`); continue; }

    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList(); closeTable();
  return out.join('\n');
}

// ─────────────── 页面样式（严肃风格）───────────────

const CSS = `
:root{
  --ink:#1a1d21; --sub:#5b636e; --line:#d5d9e0; --line2:#e8ebf0;
  --p0:#a81717; --p0bg:#fdf3f3; --p1:#8a5a00; --p1bg:#fdf9ef; --ok:#166534; --okbg:#f2f8f4;
}
*{box-sizing:border-box}
body{margin:0;background:#eceef1;color:var(--ink);
  font:15px/1.85 "Songti SC","SimSun","Source Han Serif SC","Microsoft YaHei",serif;}
.page{max-width:900px;margin:28px auto 60px;background:#fff;padding:52px 60px 64px;
  box-shadow:0 1px 4px rgba(0,0,0,.10);}
h1{font-size:25px;font-weight:700;text-align:center;letter-spacing:3px;margin:0 0 8px}
.doc-sub{text-align:center;color:var(--sub);font-size:13px;letter-spacing:1px;
  padding-bottom:18px;border-bottom:2px solid var(--ink);margin-bottom:30px}
h2{font-size:17px;font-weight:700;margin:34px 0 14px;padding-left:10px;border-left:4px solid var(--ink)}
h3{font-size:15.5px;font-weight:700;margin:22px 0 10px;color:#2b3138}
h4{font-size:14.5px;font-weight:700;margin:18px 0 8px;color:#39414a}
p{margin:9px 0}
table{width:100%;border-collapse:collapse;margin:12px 0;font-size:13.5px;
  font-family:"Microsoft YaHei",sans-serif}
th,td{border:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top}
th{background:#f4f6f8;font-weight:600;color:#3a424c}
code{background:#f2f4f7;padding:1px 5px;border-radius:3px;font-size:13px;
  font-family:Consolas,"Courier New",monospace}
ul,ol{margin:8px 0 8px 22px;padding:0}
li{margin:4px 0}

/* 文件信息表 */
.meta-table{font-size:13.5px}
.meta-table th{width:120px;background:#f8f9fb}

/* 本次审核重点（管理员提交时指定；印在报告开头，便于交代这次的审核范围） */
.focusnote{margin:14px 0 18px;padding:11px 14px;background:#f4f8ff;border-left:4px solid var(--pri);
  border-radius:3px;font-size:13px;line-height:1.85}
.focusnote b{color:var(--pri-d)}
.focusnote .fn-note{margin-top:5px;color:#334155;white-space:pre-wrap}

/* 统计条 */
.stats{display:flex;gap:0;margin:22px 0;border:1px solid var(--line);border-radius:3px;overflow:hidden}
.stat{flex:1;padding:14px 12px;text-align:center;border-right:1px solid var(--line)}
.stat:last-child{border-right:0}
.stat b{display:block;font-size:26px;line-height:1.2;font-family:"Microsoft YaHei",sans-serif}
.stat span{font-size:12.5px;color:var(--sub)}
.stat.p0 b{color:var(--p0)} .stat.p1 b{color:var(--p1)}

/* 补充审核：委托人补充要求原文块 */
.req-note{margin:12px 0 4px;padding:16px 20px;background:#f6f8fb;border:1px solid var(--line);
  border-left:4px solid #2f5d8f;border-radius:3px;font-size:14px;line-height:1.95;color:var(--ink);
  white-space:normal;word-break:break-word}

/* 结论横幅 */
.verdict{padding:14px 18px;border-radius:3px;margin:20px 0;font-size:15px;font-weight:600;
  border-left:5px solid}
.verdict.bad{background:var(--p0bg);border-color:var(--p0);color:var(--p0)}
.verdict.warn{background:var(--p1bg);border-color:var(--p1);color:var(--p1)}
.verdict.ok{background:var(--okbg);border-color:var(--ok);color:var(--ok)}

/* P0 卡片 */
.issue{border:1px solid var(--line);border-left:4px solid var(--p0);border-radius:3px;
  padding:16px 20px;margin:16px 0;background:#fff}
.issue.p1{border-left-color:var(--p1)}
.issue .ih{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.issue .no{font-weight:700;font-size:16px;color:var(--p0);font-family:"Microsoft YaHei",sans-serif}
.issue.p1 .no{color:var(--p1)}
.issue .cat{background:#f0f2f5;color:#3a424c;font-size:12px;padding:2px 8px;border-radius:2px;
  font-family:"Microsoft YaHei",sans-serif}
.issue .wl{background:var(--p0bg);color:var(--p0);font-size:12px;padding:2px 8px;border-radius:2px;
  border:1px solid #e7c9c9;font-family:"Microsoft YaHei",sans-serif}
.issue dl{margin:0;font-size:14px}
.issue dt{font-weight:600;color:var(--sub);font-size:12.5px;margin-top:9px;
  font-family:"Microsoft YaHei",sans-serif}
.issue dd{margin:2px 0 0;padding:0}
/* 多条问题各自成行（「／」分隔的每条单独成行，便于看清） */
.issue .parts .np,td .np{display:block;margin:0 0 3px}
.issue .parts .np:last-child,td .np:last-child{margin-bottom:0}
.issue .quote{background:#f8f9fb;border-left:3px solid var(--line);padding:7px 12px;
  margin-top:3px;color:#39414a;font-size:13.5px}
/* 跨源/多口径：把"值（出处）"列出来，审核人一眼知道跨到哪一节 */
.issue .cross{background:#fdf7ec;border-left:3px solid #c98a00;padding:7px 12px;margin-top:3px;font-size:13.5px;
  font-family:"Microsoft YaHei",sans-serif}
.sub-issues{margin-top:12px;border-top:1px dashed var(--line2);padding-top:10px}
.sub-issues .si{font-size:13.5px;padding:6px 0;border-bottom:1px dotted var(--line2)}
.sub-issues .si:last-child{border-bottom:0}
.sub-issues .si .loc{color:var(--sub);font-size:12.5px;font-family:"Microsoft YaHei",sans-serif}

/* 锁定提示 */
.locked{background:#f7f8fa;border:1px dashed var(--line);border-radius:3px;
  padding:20px 24px;margin:20px 0;text-align:center;color:var(--sub);font-size:14px}
.locked b{color:var(--ink)}

.foot{margin-top:44px;padding-top:16px;border-top:1px solid var(--line);
  font-size:12.5px;color:var(--sub);font-family:"Microsoft YaHei",sans-serif}
.tag{display:inline-block;font-size:11.5px;padding:1px 7px;border-radius:2px;
  font-family:"Microsoft YaHei",sans-serif}
.tag.pf{background:#eef4fb;color:#1e4e8c;border:1px solid #cfdff2}
.tag.dp{background:#f5f0fb;color:#5b3a8c;border:1px solid #ded0f0}

/* 标注版定位提示：没能标出位置的条目必须在成果报告里显眼 */
.anntag{font-family:"Microsoft YaHei",sans-serif;font-size:12.5px;padding:1px 4px;border-radius:2px}
.anntag.bad{color:#a11212;background:#fdf3f3;border:1px solid #e7c9c9;font-weight:600}
.anntag.warn{color:#8a5a00;background:#fdf9ef;border:1px solid #ecdcbb}
.issue.unlocated{border-left-color:#a11212;background:#fffafa}
tr.unlocated td{background:#fffafa}

/* 打印 / 导出 PDF 时用：A4 纵向，页边距由 @page 控制，正文不再重复留白；
   同时避免问题卡片、表格被从中间截断，保证「下载的成果」和页面上看到的一致。 */
@page{size:A4 portrait;margin:18mm 16mm 16mm}
@media print{
  html,body{background:#fff}
  .page{box-shadow:none;margin:0;padding:0;max-width:none;width:auto}
  /* 卡片、表格行不要跨页断开 */
  .issue,.si,.verdict,.req-note,.doc-sub{break-inside:avoid}
  tr,li{break-inside:avoid}
  table{break-inside:auto}
  thead{display:table-header-group}      /* 长表格每页重复表头 */
  h1,h2,h3{break-after:avoid;break-inside:avoid}
  /* 打印时把链接颜色拉回正文色，避免到处都是蓝字 */
  a{color:inherit;text-decoration:none}
  .stats{break-inside:avoid}
  /* 灰色的页面背景和阴影在纸上没意义 */
  body{font-size:10.5pt}
  .page{padding:0}
}
`;

// ─────────────── 报告渲染 ───────────────

/** 跨源/多口径类问题的定位辅助
 *
 * 只写「在不同位置出现 2 个不同取值——638万元 / 648万元」时，审核人看不出跨到哪一节去了。
 * 这里把「值（出处）」成对抽出来单独列一行；对 description 里没写出处、但 quote 里有出处的
 * 已有报告（历史任务）同样生效。
 */
export function crossPairs(it) {
  const q = String(it.quote || '');
  if (!q) return [];
  const out = [];
  for (const seg of q.split(/\s*(?:\/|≠|\||；|;)\s*/)) {
    const m = seg.match(/^(.*?)（([^）]{2,})）\s*$/);
    if (!m) continue;
    const val = m[1].replace(/^[^：:]{0,20}[：:]/, '').trim();
    if (val && m[2].trim()) out.push({ value: val, where: m[2].trim() });
  }
  return out;
}

/** 是否属于"同一事实多处取值"这一类（要写出处的那几类） */
export function isCrossSource(it) {
  const s = `${it.category || ''}${it.description || ''}`;
  return /数据不实|口径混用|工程量多口径|前后矛盾|关键数据错误/.test(s) || /跨源|不同取值|多套值/.test(s);
}

function crossBlock(it) {
  if (!isCrossSource(it)) return '';
  const pairs = crossPairs(it);
  if (pairs.length >= 2) {
    return '<dt>两处取值与出处</dt><dd class="cross">' + pairs.map((p, i) =>
      `${['①', '②', '③', '④'][i] || '·'} <b>${esc(p.value)}</b> —— 见 <b>${esc(p.where)}</b>`).join('<br>') + '</dd>';
  }
  const locs = String(it.location || '').split(/[；;／/]/).map(x => x.trim()).filter(Boolean);
  if (locs.length >= 2) {
    return '<dt>涉及位置</dt><dd class="cross">' + locs.map((x, i) =>
      `${['①', '②', '③', '④'][i] || '·'} ${esc(x)}`).join('<br>') + '</dd>';
  }
  return '';
}

/** 多条问题（审核结论常用「／」分隔）拆开 —— 每条各自另起一行，不挤成一整段
 *  WARN: 只按全角「／」或前后带空格的 ASCII `/` 拆：单位里的斜杠（tCO₂/TJ、元/m³、83元/t）
 *     不是分隔符，按裸 `/` 拆会把一句话切成十几段。 */
export function splitParts(s) {
  const t = String(s ?? '').replace(/^【[^】]*】\s*/, '').trim();
  const parts = t.split(/\s*／\s*|\s+\/\s+/).map(x => x.trim()).filter(Boolean);
  return parts.length ? parts : [t];
}
const partsHtml = (s) => splitParts(s).map(p => `<span class="np">${esc(p)}</span>`).join('');

function issueBlock(it, idx, cls) {
  const sub = (it.subItems || []).map(s => `
    <div class="si">
      <div>${esc(s.description)}</div>
      ${s.location ? `<div class="loc">位置：${esc(s.location)}</div>` : ''}
    </div>`).join('');
  return `
<div class="issue ${cls === 'proofread' ? '' : 'deep'}${it.tier === 'none' ? ' unlocated' : ''}">
  <div class="ih">
    <span class="no">${esc(it.no || `P0-${idx}`)}</span>
    <span class="cat">${esc(it.category)}</span>
    ${it.whitelist ? `<span class="wl">${esc(it.whitelist)}</span>` : ''}
    <span class="tag ${cls === 'proofread' ? 'pf' : 'dp'}">${CLASS_LABEL[cls]}</span>
    ${it.mergedCount > 1 ? `<span class="cat">已合并 ${it.mergedCount} 项</span>` : ''}
  </div>
  <dl>
    <dt>问题</dt><dd class="parts">${partsHtml(it.description)}</dd>
    ${crossBlock(it)}
    ${it.location ? `<dt>原文定位</dt><dd>${esc(it.location)}</dd>` : ''}
    ${annotMark(it)}
    ${it.quote ? `<dt>原文摘录</dt><dd class="quote">${esc(it.quote)}</dd>` : ''}
    ${it.basis ? `<dt>判定依据</dt><dd>${esc(it.basis)}</dd>` : ''}
    ${it.fix ? `<dt>修改建议</dt><dd>${esc(it.fix)}</dd>` : ''}
  </dl>
  ${sub ? `<div class="sub-issues"><div class="loc" style="font-weight:600">合并的子项：</div>${sub}</div>` : ''}
</div>`;
}

/**
 * 标注版定位提示：没能在原报告上标出位置的条目，也必须在成果报告里强调出来，
 * 否则看报告的人会以为标注版上都标了。
 */
function annotMark(it) {
  if (it.tier === 'none') {
    return '<dt>标注版</dt><dd class="anntag bad">⚠️ 本条<b>未能在原报告中标出位置</b>（原报告文字层里找不到对应内容，'
      + '常见于图片/图表里的问题）。请按上面「原文定位」人工查找；《原报告标注版》首页列有本条编号。</dd>';
  }
  if (it.tier === 'approx') {
    return `<dt>标注版</dt><dd class="anntag warn">≈ 标注位置为<b>近似</b>（${it.tierHow === 'number' ? '按数字指纹' : '按引用片段'}定位），仅供参考，判定以本报告文字为准</dd>`;
  }
  if (it.tier === 'section') {
    return '<dt>标注版</dt><dd class="anntag warn">§ 只标注到该章节/表标题处，位置仅供参考</dd>';
  }
  return '';
}

/**
 * 「本次审核重点」提示条 —— 管理员在提交页填的（多选方向 + 补充要求文本）。
 * 为什么要印进报告：拿到成果的人应该知道这次是按什么要求重点查的，
 * 否则重点方向上的结论会被当成"常规全查"的结果。
 * 没有重点要求时返回空串，报告结构与不带重点时完全一致（不会多出空框）。
 */
function focusNoteHtml(task = {}) {
  const list = (task.reviewFocus || []).filter(Boolean);
  const note = String(task.reviewNote || '').trim();
  if (!list.length && !note) return '';
  return `<div class="focusnote">
    <b>本次审核重点</b>（提交人指定，AI 已按此重点逐条核查；<b>不是只审这些</b>，其余维度照常审核）：
    ${list.length ? list.map(esc).join(' · ') : ''}
    ${note ? `<div class="fn-note">补充要求：${esc(note)}</div>` : ''}
  </div>`;
}

/**
 * 「上次审核问题的修改情况」一节：后续审核要核实上次问题是否修改完善，
 * 着重提醒未响应的高级别问题。
 *
 * 数据来自 stageComparePrevious（AI 逐条判断）：fixed / partial / unfixed / unknown。
 * deepAccess=false（校对成果）时只列校对类条目 —— 与"普通用户只看校对类"的口径一致，
 * 免得校对成果里冒出深度类问题的讨论。
 */
function compareSection(compare, { deepAccess = false } = {}) {
  if (!compare || !(compare.items || []).length) return '';
  const items = deepAccess ? compare.items : compare.items.filter(x => PROOFREAD_CATEGORIES.has(x.category));
  if (!items.length) return '';
  const s = compare.stats || {};
  const label = { fixed: '✅ 已修改', partial: '⚠️ 部分修改', unfixed: '❌ 未响应', unknown: '❓ 无法判断' };
  const cls = { fixed: 'ok', partial: 'warn', unfixed: 'bad', unknown: '' };
  const rows = items.map(it => `<tr${it.status === 'unfixed' && it.level === 'P0' ? ' class="unlocated"' : ''}>
      <td style="width:62px;text-align:center;font-family:'Microsoft YaHei',sans-serif">${esc(it.no)}</td>
      <td style="width:52px">${esc(it.level || '')}</td>
      <td style="width:88px">${esc(it.category || '')}</td>
      <td>${esc(it.summary || '')}</td>
      <td style="width:96px"><span class="anntag ${cls[it.status] || ''}">${label[it.status] || it.status}</span></td>
      <td style="width:210px">${esc(it.evidence || '')}${it.note ? `<br><span class="muted">${esc(it.note)}</span>` : ''}</td>
    </tr>`).join('');
  const warn = (s.unfixedP0 > 0)
    ? `<div class="verdict bad" style="margin-bottom:14px">⚠️ <b>上次提出的问题中有 ${s.unfixedP0} 项 P0（必须修改）未响应或仅部分响应</b>，
        另有 P1 ${s.unfixedP1} 项 —— 请优先处理后再上报。</div>`
    : (s.unfixedP1 > 0
      ? `<div class="verdict warn" style="margin-bottom:14px">上次提出的问题中，P1 有 ${s.unfixedP1} 项未完全响应（无未响应的 P0）。</div>`
      : `<div class="verdict ok" style="margin-bottom:14px">上次提出的问题均已修改或已说明，无未响应的高级别问题。</div>`);
  const when = compare.prevAt ? fmtBJ(compare.prevAt) : '（时间未知）';
  return `
  ${warn}
  <p style="font-size:13px;color:#5b636e;line-height:1.85">
    上一轮：任务 ${esc(compare.prevTaskId || '—')}　提交人 ${esc(compare.prevOwner || '—')}　完成时间 ${esc(when)}<br>
    共对比 <b>${items.length}</b> 条：已修改 <b>${s.fixed ?? 0}</b> · 部分修改 <b>${s.partial ?? 0}</b> ·
    未响应 <b>${s.unfixed ?? 0}</b> · 无法判断 <b>${s.unknown ?? 0}</b>
    ${deepAccess ? '' : '<br><span class="muted">（校对成果只列校对类问题；深度类问题的响应情况见《审核成果》）</span>'}
  </p>
  <table><thead><tr>
    <th>上次编号</th><th>级别</th><th>类别</th><th>上次问题</th><th>本次状态</th><th>依据（本次报告原文）</th>
  </tr></thead><tbody>${rows}</tbody></table>`;
}

/** 结论处的一句话提醒（把"上次有 P0 未响应"顶到最显眼的地方） */
function compareVerdictLine(compare) {
  const s = compare && compare.stats;
  if (!s || !s.total) return '';
  if (s.unfixedP0 > 0) {
    return `<div class="verdict bad" style="margin-top:10px">⚠️ 本次为<b>同一项目的再次审核</b>：上次 ${s.total} 条问题中，
      <b>${s.unfixedP0} 项 P0 未响应</b>、P1 ${s.unfixedP1} 项未完全响应（详见「上次审核问题的修改情况」一节）。</div>`;
  }
  if (s.unfixed + s.partial > 0) {
    return `<div class="verdict warn" style="margin-top:10px">本次为同一项目的再次审核：上次 ${s.total} 条问题中，
      ${s.partial + s.unfixed} 条未完全响应（其中 P1 ${s.unfixedP1} 项），详见后文对比一节。</div>`;
  }
  return `<div class="verdict ok" style="margin-top:10px">本次为同一项目的再次审核：上次 ${s.total} 条问题均已修改或已说明，无未响应的高级别问题。</div>`;
}

function listTable(items, withSev) {
  if (!items.length) return '<p style="color:#5b636e">（无）</p>';
  // 编号列显示全局编号（如 P1-37），与「原报告标注版」上的标记号一致，便于互相对照。
  const rows = items.map((it, i) => `
    <tr${it.tier === 'none' ? ' class="unlocated"' : ''}>
      <td style="width:62px;text-align:center;font-family:'Microsoft YaHei',sans-serif">${esc(it.no || String(i + 1))}</td>
      ${withSev ? `<td style="width:58px">${esc(it.severity || it.sev || '')}</td>` : ''}
      <td style="width:88px">${esc(it.category)}</td>
      <td style="width:120px">${esc(it.location || '')}${it.tier === 'none' ? '<br><span class="anntag bad">未能在标注版中标出</span>' : ''}${it.tier === 'approx' ? '<br><span class="anntag warn">标注版：近似定位</span>' : ''}${it.tier === 'section' ? '<br><span class="anntag warn">标注版：章节定位</span>' : ''}</td>
      <td>${partsHtml(it.description)}</td>
      <td style="width:150px">${esc(it.fix || '')}</td>
    </tr>`).join('');
  return `<table><thead><tr>
    <th>编号</th>${withSev ? '<th>级别</th>' : ''}<th>类别</th><th>位置</th><th>问题</th><th>建议</th>
  </tr></thead><tbody>${rows}</tbody></table>`;
}
/**
 * 「校对成果」—— 普通用户专用。完全独立的一份文档，不含任何深度类内容或提示。
 */
export function renderProofreadReport({ task = {}, pfP0 = [], pfP1 = [], generatedAt = new Date(), pptHtml = '', compare = null }) {
  // 章节编号用局部计数器：这是独立函数，拿不到 renderHtmlReport 里的 sec。
  const CN2 = ['一', '二', '三', '四', '五', '六', '七', '八'];
  let SN2 = 0;
  const sec = (t) => `<h2>${CN2[SN2++]}、${t}</h2>`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>校对成果 · ${esc(task.sourceName || '')}</title>
<style>${CSS}</style>
</head>
<body>
<div class="page">

  <h1>校 对 成 果</h1>
  <div class="doc-sub">${esc(task.templateName || '工程咨询成果审核')}</div>
  ${focusNoteHtml(task)}

   ${sec('文件信息')}
    ${pptHtml ? sec('PPT 汇报材料问题（优先处理）') + pptHtml : ''}
  <table class="meta-table">
    <tr><th>受审报告</th><td>${esc(task.sourceName || '—')}</td></tr>
    <tr><th>报告类型</th><td>${esc(task.templateName || task.bizType || '—')}</td></tr>
    <tr><th>提交人</th><td>${esc(task.ownerName || '—')}</td></tr>
    <tr><th>提交时间</th><td>${fmtBJ(task.createdAt)}</td></tr>
    <tr><th>审核时间</th><td>${fmtBJ(generatedAt)}</td></tr>
    <tr><th>任务编号</th><td>${esc(task.id || '—')}</td></tr>
  </table>

   ${sec('校对类问题汇总')}
  <div class="stats">
    <div class="stat p0"><b>${pfP0.length}</b><span>🔴 P0 必须修改</span></div>
    <div class="stat p1"><b>${pfP1.length}</b><span>⚠️ P1 建议修改</span></div>
  </div>
  <p style="font-size:13.5px;color:#5b636e">
    本页列出的是<b>可自行核对</b>的问题：数据不一致、跨源数值冲突、口径混用、错别字、术语与格式问题。
  </p>

  ${(compare && (compare.items || []).length) ? sec('上次审核问题的修改情况（校对类）') + compareSection(compare, { deepAccess: false }) : ''}

   ${sec(`🔴 P0 必须修改（共 ${pfP0.length} 项）`)}
  ${pfP0.length
      ? pfP0.map((it, i) => issueBlock(it, i + 1, 'proofread')).join('')
      : '<p style="color:#5b636e">（无）</p>'}

   ${sec(`⚠️ P1 建议修改（共 ${pfP1.length} 项）`)}
  ${pfP1.length ? listTable(pfP1) : '<p style="color:#5b636e">（无）</p>'}

</div>
</body>
</html>`;
}

/**
 * 「补充审核意见」—— 管理员填写补充要求后，针对该要求定向深入核查的独立成果。
 * 与常规审核成果分开存放、分开下载，便于"常规一轮 + 补充若干轮"逐轮追溯。
 *
 * @param {object} o
 * @param {object} o.task       任务元信息
 * @param {string} o.note       管理员填写的补充要求原文
 * @param {object} o.graded     补充审核的 stage4Grade 产出
 * @param {object} o.meta       { by, createdAt, round, model, cost, usage }
 * @param {Date} [o.generatedAt]
 * @returns {string} 完整 HTML
 */
export function renderSupplementReport({ task = {}, note = '', graded, meta = {}, generatedAt = new Date() }) {
  const p0 = (graded?.p0 || []).map(it => ({ ...it, cls: classify(it) }));
  const p1 = (graded?.p1 || []).map(it => ({ ...it, cls: classify(it) }));
  const p2 = (graded?.p2 || []).map(it => ({ ...it, cls: classify(it) }));
  const p3 = (graded?.p3 || []).map(it => ({ ...it, cls: classify(it) }));
  const s = graded?.stats || { p0Count: p0.length, p1Count: p1.length, p2Count: p2.length, p3Count: p3.length };
  const total = p0.length + p1.length + p2.length + p3.length;

  const noteHtml = esc(note).replace(/\n/g, '<br>');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>补充审核意见 第 ${meta.round || 1} 轮 · ${esc(task.sourceName || '')}</title>
<style>${CSS}</style>
</head>
<body>
<div class="page">

  <h1>补 充 审 核 意 见</h1>
  <div class="doc-sub">第 ${meta.round || 1} 轮 · ${esc(task.templateName || '工程咨询成果审核')}</div>

  <h2>一、文件信息</h2>
  <table class="meta-table">
    <tr><th>受审报告</th><td>${esc(task.sourceName || '—')}</td></tr>
    <tr><th>项目名称</th><td>${esc(task.projectName || '—')}</td></tr>
    <tr><th>项目类型</th><td>${esc(task.projectType || '—')}</td></tr>
    <tr><th>报告类型</th><td>${esc(task.templateName || '—')}</td></tr>
    <tr><th>提交人</th><td>${esc(task.ownerName || '—')}</td></tr>
    <tr><th>补充要求提出</th><td>${esc(meta.by || '—')} · ${fmtBJ(meta.createdAt)}</td></tr>
    <tr><th>本轮出具时间</th><td>${fmtBJ(generatedAt)}</td></tr>
    <tr><th>任务编号</th><td>${esc(task.id || '—')}</td></tr>
  </table>

  <h2>二、补充审核要求（委托人原文）</h2>
  <div class="req-note">${noteHtml}</div>

  <h2>三、本轮核查结论</h2>
  <div class="stats">
    <div class="stat p0"><b>${p0.length}</b><span>🔴 P0 必须修改</span></div>
    <div class="stat p1"><b>${p1.length}</b><span>⚠️ P1 建议修改</span></div>
    <div class="stat"><b>${p2.length + p3.length}</b><span>P2 / P3 后续完善</span></div>
    <div class="stat"><b>${total}</b><span>本轮共查出</span></div>
  </div>
  <p style="font-size:13.5px;color:#5b636e">
    本轮为<b>定向深入核查</b>：只围绕上述补充要求做交叉验证，不重复常规审核已列出的问题。
    ${total === 0 ? '<b>围绕本次补充要求未查出新的实质性问题。</b>' : ''}
  </p>

  ${p0.length ? `<h2>四、🔴 P0 必须修改（共 ${p0.length} 项）</h2>
    ${p0.map((it, i) => issueBlock(it, i + 1, it.cls)).join('')}` : ''}

  ${p1.length ? `<h2>${p0.length ? '五' : '四'}、⚠️ P1 建议修改（共 ${p1.length} 项）</h2>
    ${listTable(p1)}` : ''}

  ${(p2.length + p3.length) ? `<h2>${p0.length ? (p1.length ? '六' : '五') : '四'}、P2 / P3 后续完善（共 ${p2.length + p3.length} 项）</h2>
    ${listTable([...p2, ...p3], true)}` : ''}

  <div style="margin-top:34px;padding-top:14px;border-top:1px solid var(--line);font-size:12.5px;color:#5b636e;line-height:1.9">
    ${meta.usage ? `本轮用量：输入 ${(meta.usage.prompt || 0).toLocaleString()} tok（缓存命中 ${(meta.usage.cacheHit || 0).toLocaleString()}）／
      输出 ${(meta.usage.completion || 0).toLocaleString()} tok　·　计费时段 <b>${meta.peak ? '高峰' : '空闲'}</b>　·　
      本次 API 费用约 <b>¥${meta.cost ?? '—'}</b><br>` : ''}
    <b>本意见书由 AI 补充核查生成，仅作初审，不能替代专家终审。</b>
    本轮结论应与常规审核成果合并使用。
  </div>

</div>
</body>
</html>`;
}

/**
 * 「审核成果」—— 管理员 / 获授权专家查看的完整版。
 * 含叙述部分（总体评价 / 综合结论 / 修改路线图 / 四维建议）+ 校对类 + 深度类全部问题。
 *
 * @param {object} o
 * @param {object} o.task        任务元信息（报告名/提交人/时间/任务号）
 * @param {object} o.graded      stage4Grade 的产出
 * @param {string} o.narrative   模型生成的叙述部分（markdown，可空）
 * @param {boolean} o.deepAccess 是否有权限看深度类
 * @param {string} [o.model]
 * @param {Date} [o.generatedAt]
 * @param {object|null} [o.annotateTiers] 标注版定位档位
 * @param {object|null} [o.compare] 上一轮问题的响应情况
 * @returns {string} 完整 HTML
 */
export function renderHtmlReport({ task = {}, graded, narrative = '', deepAccess = false, model = '', generatedAt = new Date(), annotateTiers = null, compare = null }) {
  const s = graded.stats;
  // 编号只算一次：报告与「原报告标注版」共用同一套 no（P0-1 / P1-7 …），保证一一对应
  const R = reportIssues(graded, { scope: deepAccess ? 'deep' : 'proof' });
  // 标注版定位档位（annotate-tiers.json）：none 的条目要在报告里红字提示"未能在原报告中标出"
  const withTier = (arr) => (annotateTiers
    ? arr.map(it => (annotateTiers[it.no] ? { ...it, tier: annotateTiers[it.no].tier, tierHow: annotateTiers[it.no].how } : it))
    : arr);
  const p0 = withTier(R.p0), p1 = withTier(R.p1), p2 = withTier(R.p2), p3 = withTier(R.p3);

  const pfP0 = p0.filter(x => x.cls === 'proofread');
  const dpP0 = p0.filter(x => x.cls !== 'proofread');
  const pfP1 = p1.filter(x => x.cls === 'proofread');
  const dpP1 = p1.filter(x => x.cls !== 'proofread');

  const verdictCls = s.p0Count === 0 ? 'ok' : (dpP0.length ? 'bad' : 'warn');
  const verdictText = s.p0Count === 0
    ? '本次审核未发现必须修改的问题，报告具备上报条件。'
    : `本次审核共发现 ${s.p0Count} 项必须修改的问题（P0），报告暂不具备上报/验收条件，修改后需复审。`;

  const deepLockedCount = dpP0.length + dpP1.length + p2.filter(x => x.cls === 'deep').length;

  // ── PPT 相关问题的分流（提交里配了 PPT 才有）──
  // 'ppt-cross' = PPT 与报告对不上（数据/观点/内容）—— 影响最大，排最前
  // 'ppt'       = PPT 自身问题
  // 排版口径：成果报告的 PPT 板块排在「文件信息 / 审核结论」之后的第一个内容章节，
  // 即 PPT 优先问题的思路。
  const allIssues = [...p0, ...p1, ...p2, ...p3];
  const crossAll = allIssues.filter(x => x.source === 'ppt-cross');
  const pptAll = allIssues.filter(x => x.source === 'ppt');
  const hasPpt = !!(task.pptSourceName || crossAll.length || pptAll.length);
  const crossPf = crossAll.filter(x => x.cls === 'proofread');
  const pptPf = pptAll.filter(x => x.cls === 'proofread');

  // 章节编号用计数器：插入 PPT 章节后不用手工改一堆数字（改漏一处就跳号）
  const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  let SN = 0;
  const sec = (t) => `<h2>${CN[SN++]}、${t}</h2>`;

  /** 校对成果用的 PPT 板块：只列校对类问题，篇幅短 */
  const proofreadPptHtml = () => {
    if (!crossPf.length && !pptPf.length) return '';
    // 不在这里发 <h2>：编号要由调用方（renderProofreadReport）的计数器发，
    // 否则两边各编一次号，会出现两个「一、」。
    let h = '';
    h += `<div class="verdict warn" style="margin-bottom:14px">本次提交含汇报 PPT」`;
    h += `${esc(task.pptSourceName || '')}」`;
    h += `${crossPf.length ? `，其中 <b>${crossPf.length} 项</b>与报告对不上，务必先改。` : '。'}`;
    h += `${task.pptEnough === false ? '<br>⚠️ 该 PPT 以图片为主，未做图片 OCR，只覆盖可提取到的文字。' : ''}</div>`;
    if (crossPf.length) h += `<h3>PPT 与报告不一致 · ${crossPf.length} 项</h3>` + crossPf.map((it, i) => issueBlock(it, i + 1, it.cls)).join('');
    if (pptPf.length) h += `<h3 style="margin-top:20px">PPT 自身问题 · ${pptPf.length} 项</h3>` + pptPf.map((it, i) => issueBlock(it, i + 1, it.cls)).join('');
    return h;
  };

  /** PPT 板块：一致性冲突在前，PPT 自身问题在后 */
  const pptSection = (deep) => {
    if (!hasPpt) return '';
    const list = deep ? [...crossAll, ...pptAll] : [...crossPf, ...pptPf];
    const cross = deep ? crossAll : crossPf;
    const self = deep ? pptAll : pptPf;
    if (!list.length) {
      // 没有可列的问题，也交代一句"查过了"，否则用户会以为没查 PPT
      return sec('PPT 汇报材料')
        + `<div class="verdict ok" style="margin-bottom:14px">已核对汇报 PPT${task.pptSourceName ? `「${esc(task.pptSourceName)}」` : ''}`
        + `${task.pptSlides ? `（${task.pptSlides} 页）` : ''}：未发现${deep ? '问题' : '校对类问题'}，与报告内容一致。</div>`;
    }
    let html = sec('PPT 汇报材料问题（优先处理）');
    html += `<div class="verdict warn" style="margin-bottom:14px">
      本次提交含<b>汇报 PPT</b>${task.pptSourceName ? `「${esc(task.pptSourceName)}」` : ''}${task.pptSlides ? `（${task.pptSlides} 页）` : ''}。
      ${cross.length ? `其中 <b>${cross.length} 项</b>是 PPT 与报告<b>对不上</b>的地方 —— 这类问题听众当场就能发现，务必先改。` : '未发现 PPT 与报告互相矛盾之处。'}
      ${task.pptEnough === false ? '<br>⚠️ 该 PPT 以图片为主，系统未做图片 OCR，图片里的文字与图表未能核对，本板块只覆盖可提取到的文字部分。' : ''}
    </div>`;
    if (cross.length) {
      html += `<h3>PPT 与报告不一致 · ${cross.length} 项</h3>`;
      html += cross.map((it, i) => issueBlock(it, i + 1, it.cls)).join('');
    } else {
      html += '<p style="color:#5b636e">（未发现 PPT 与报告的数据 / 观点 / 内容冲突）</p>';
    }
    if (self.length) {
      html += `<h3 style="margin-top:22px">PPT 自身问题 · ${self.length} 项</h3>`;
      html += self.map((it, i) => issueBlock(it, i + 1, it.cls)).join('');
    }
    return html;
  };

  // 普通用户拿到的是完全独立的「校对成果」：
  //   不含任何深度类字样、不含叙述部分、不含 AI 免责声明。
  // PPT 板块的 HTML 在这里先算好传进去 —— pptSection 定义在下面，
  // 而这里就 return 了，直接调用会拿不到（函数作用域）。
  if (!deepAccess) {
    return renderProofreadReport({ task, pfP0, pfP1, generatedAt, compare, pptHtml: hasPpt ? proofreadPptHtml() : '' });
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>审核意见书 · ${esc(task.sourceName || '')}</title>
<style>${CSS}</style>
</head>
<body>
<div class="page">

  <h1>审 核 成 果</h1>
  <div class="doc-sub">${esc(task.templateName || '工程咨询成果审核')}</div>
  ${focusNoteHtml(task)}

   ${sec('文件信息')}
  <table class="meta-table">
    <tr><th>受审报告</th><td>${esc(task.sourceName || '—')}</td></tr>
    <tr><th>报告类型</th><td>${esc(task.templateName || task.bizType || '—')}</td></tr>
    <tr><th>提交人</th><td>${esc(task.ownerName || '—')}</td></tr>
    <tr><th>提交时间</th><td>${fmtBJ(task.createdAt)}</td></tr>
    <tr><th>审核时间</th><td>${fmtBJ(generatedAt)}</td></tr>
    <tr><th>任务编号</th><td>${esc(task.id || '—')}</td></tr>
  </table>

   ${sec('审核结论')}
  <div class="verdict ${verdictCls}">${esc(verdictText)}</div>
  ${compareVerdictLine(compare)}
  ${(compare && (compare.items || []).length) ? sec('上次审核问题的修改情况') + compareSection(compare, { deepAccess: true }) : ''}
  ${deepAccess ? `
  <div class="stats">
    <div class="stat p0"><b>${s.p0Count}</b><span>🔴 P0 必须修改</span></div>
    <div class="stat p1"><b>${s.p1Count}</b><span>⚠️ P1 建议修改</span></div>
    <div class="stat"><b>${s.p2Count}</b><span>P2 后续完善</span></div>
    <div class="stat"><b>${s.p3Count}</b><span>P3 长效机制</span></div>
  </div>
  <p style="font-size:13.5px;color:#5b636e">
    校对类 ${pfP0.length + pfP1.length} 项（数据不一致、错别字、格式、术语等）·
    深度类 ${dpP0.length + dpP1.length + p2.filter(x => x.cls === 'deep').length} 项（逻辑、结论、建议等）
  </p>` : `
  <div class="stats">
    <div class="stat p0"><b>${pfP0.length}</b><span>🔴 P0 必须修改（校对类）</span></div>
    <div class="stat p1"><b>${pfP1.length}</b><span>⚠️ P1 建议修改（校对类）</span></div>
    <div class="stat"><b>${deepLockedCount}</b><span>深度类问题（需审核专家查看）</span></div>
  </div>
  <p style="font-size:13.5px;color:#5b636e">
    本页仅列出<b>校对类</b>问题（共 ${pfP0.length + pfP1.length} 项）：数据不一致、错别字、格式、术语等可自行核对的内容。<br>
    另有 <b>${deepLockedCount} 项深度类</b>问题（逻辑分析、结论正确性、建议合理性），需由审核专家或管理员查看。
  </p>`}

  ${pptSection(true)}
  ${narrative ? `${sec('总体评价与建议')}\n${mdToHtml(narrative)}` : ''}

  ${sec(`🔴 P0 必须修改的问题（${deepAccess ? `共 ${s.p0Count} 项` : `校对类 ${pfP0.length} 项`}）`)}
  ${pfP0.length
      ? (deepAccess ? `<h3>校对类 · ${pfP0.length} 项</h3>` : '') + pfP0.map((it, i) => issueBlock(it, i + 1, 'proofread')).join('')
      : '<p style="color:#5b636e">（无校对类 P0 问题）</p>'}
  ${deepAccess
      ? (dpP0.length ? `<h3>深度类 · ${dpP0.length} 项</h3>` + dpP0.map((it, i) => issueBlock(it, pfP0.length + i + 1, 'deep')).join('') : '')
      : (dpP0.length ? `<p style="color:#5b636e;margin-top:16px">另有 <b>${dpP0.length} 项深度类 P0</b> 问题（逻辑分析、结论正确性、建议合理性），需由审核专家或管理员查看。</p>` : '')}

  ${sec(`⚠️ P1 建议修改（${deepAccess ? `共 ${s.p1Count} 项` : `校对类 ${pfP1.length} 项`}）`)}
  ${pfP1.length ? (deepAccess ? `<h3>校对类 · ${pfP1.length} 项</h3>` : '') + listTable(pfP1) : '<p style="color:#5b636e">（无校对类 P1 问题）</p>'}
  ${deepAccess
      ? (dpP1.length ? `<h3>深度类 · ${dpP1.length} 项</h3>${listTable(dpP1)}` : '')
      : (dpP1.length ? `<p style="color:#5b636e">另有 ${dpP1.length} 项深度类 P1 问题，需审核专家或管理员查看。</p>` : '')}

  ${(deepAccess && (p2.length || p3.length)) ? `
  ${sec('P2 / P3 后续事项')}
  ${p2.length ? `<h3>P2 后续完善（${p2.length} 项）</h3>${listTable(p2, true)}` : ''}
  ${p3.length ? `<h3>P3 长效机制（${p3.length} 项）</h3>${listTable(p3, true)}` : ''}` : ''}

  <div class="foot">
    本意见书由「石油天然气工程咨询成果智能审核平台」自动生成，AI 仅作初审，不能替代专家终审。<br>
    如对结论有异议，请联系审核专家复核。<br>
    任务编号 ${esc(task.id || '')} · 生成于 ${esc(generatedAt.toLocaleString('zh-CN'))}
  </div>
</div>
</body>
</html>`;
}
