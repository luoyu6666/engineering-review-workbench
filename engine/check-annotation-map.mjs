/**
 * 标注版 ↔ 成果报告 编号对应性核查（诊断工具，零 API）
 *
 * 用途：设计约束之一是「标注版与成果报告的编号必须一一对应」，仅凭页面截图无法确认。
 * 本工具把标注版 PDF 每页抽成文字，取出页面上实际印出的 P0-n/P1-n/P2-n/P3-n，
 * 再与对应档位的成果报告列出的编号逐个比对，判定五类不一致：
 *   ① 报告里有、标注版上漏了 → 漏印（missing）
 *   ② 标注版上有、报告里没有 → 编号对不上（extra）
 *   ③ 页眉印的「N 条」与该页实际编号数不符 → 页眉条数错误或批注被吃（countBad）
 *   ④ 同一个编号被印到两张正文纸上 → 重复（dup）
 *   ⑤ 编号没印在它该在的那张纸上 → 错页（placeFail）
 *
 * 两个已知口径陷阱：
 *   ① 页码口径：annotate-tiers.json 的 page 是 0 基（P1-16 记 49），
 *      标注版 PDF 的物理页序 = page + 1（第 0 张是封面），页眉印的是 1 基原报告页号。
 *   ② 页眉只能认第一行：附录「页面位置拥挤·集中列出」那几页里每行都写着
 *      "P0-7 … 原报告第 11 页"，在整页文本里搜会把附录误判成"原报告第 11 页"
 *      （产生十余条"编号重复出现"的误报）。
 *
 * 另一处口径：校对档与审核档编号共享但条数不同
 *（本任务口径：校对 98 条、审核 140 条），所以校对版要跟 report.html 比、
 * 审核版要跟 report.deep.html 比，不能用同一份档位表比两档。
 *
 * 用法：
 *   node engine\check-annotation-map.mjs --task T20260922-9512ad
 *   node engine\check-annotation-map.mjs --task T20260922-9512ad --scope proof
 *   node engine\check-annotation-map.mjs --all              # 全部任务的校对+审核两档
 *   node engine\check-annotation-map.mjs --task X --headers # 逐张页眉/条数明细
 *   node engine\check-annotation-map.mjs --task X --dump 27 # 打印某张纸的原始抽取文本
 *
 * 本工具只读：不生成、不改任何数据。依赖 poppler 的 pdftotext（已在 PATH）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TASKS_DIR = path.join(ROOT, 'web', 'data', 'tasks');

const argv = process.argv.slice(2);
const argOf = (name, dflt = '') => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const ID_RE = /P[0-3]-\d+/g;
const SCOPES = ['proof', 'deep'];
const SCOPE_CN = { proof: '校对', deep: '审核' };
const REPORT_OF = { proof: 'report.html', deep: 'report.deep.html' };

/** 逐页抽文字：一次 pdftotext，按分页符 \f 切开 */
function pagesOf(pdf) {
  const txt = execFileSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  return txt.split('\f');
}

const idsIn = (text) => new Set(text.match(ID_RE) || []);

/**
 * 从成果报告 HTML 里取权威编号集合。
 *
 * 不能简单地全文搜 P[0-3]-\d+：报告的问题块头部还有一个白名单标签
 *    `<span class="wl">P0-4</span>`（表示"命中 P0-4 号白名单槽位"，见 pipeline 的
 *    P0_WHITELIST），它长得跟编号一模一样但不是编号。全文搜会把每个 P0 问题
 *    都算进一个并不存在的 P0-4（曾误报"报告里有 P0-4、标注版漏印"）。
 * 只认两处真正印编号的地方：
 *    ① 问题块头：<span class="no">P1-37</span>
 *    ② 一维清单表的"编号"列：<td style="width:62px;...">P1-37</td>
 */
function reportIds(html) {
  const out = new Set();
  for (const m of html.matchAll(/class="no">(P[0-3]-\d+)</g)) out.add(m[1]);
  for (const m of html.matchAll(/width:62px;text-align:center[^>]*>(P[0-3]-\d+)<\/td>/g)) out.add(m[1]);
  return out;
}

function checkTask(task, scope) {
  const dir = path.join(TASKS_DIR, task);
  const pdf = path.join(dir, `原报告标注版-${SCOPE_CN[scope]}.pdf`);
  const report = path.join(dir, REPORT_OF[scope]);
  const tiersFile = path.join(dir, 'annotate-tiers.json');
  if (!fs.existsSync(pdf) || !fs.existsSync(report)) return null;

  const tiers = fs.existsSync(tiersFile) ? JSON.parse(fs.readFileSync(tiersFile, 'utf8')) : {};
  // 权威编号来源：这一档的成果报告（不是档位表）
  const expected = reportIds(fs.readFileSync(report, 'utf8'));
  const pages = pagesOf(pdf);

  // 页眉（只认第一行）与页内编号
  const firstLine = (t) => (t.split('\n').find((l) => l.trim()) || '').trim();
  const headerNo = (t) => {
    const m = firstLine(t).match(/^原报告\s*第\s*([\d\s]{1,12}?)\s*页/);
    return m ? m[1].replace(/[^\d]/g, '') : '';
  };
  const headerCount = (t) => {
    const m = firstLine(t).match(/·\s*(\d+)\s*条/);
    if (m) return Number(m[1]);
    return /本页无问题/.test(t.slice(0, 300)) ? 0 : null;
  };
  const perSheet = pages.map((t, i) => ({ i, ids: idsIn(t), header: headerNo(t), count: headerCount(t) }));

  const body = perSheet.filter((s) => s.header);            // 正文纸：页眉是「原报告 第 N 页 · M 条」
  const presentAll = new Set(perSheet.flatMap((s) => [...s.ids]));   // 全篇出现（含封面红字清单与附录）
  const missing = [...expected].filter((id) => !presentAll.has(id));
  const extra = [...presentAll].filter((id) => !expected.has(id));

  // 校验 ③：页眉印的条数 = 该页实际编号数
  const countBad = body
    .filter((s) => s.count !== null && s.count !== s.ids.size)
    .map((s) => `第${s.header}页 页眉${s.count}条/实际${s.ids.size}个编号`);

  // 校验 ④：同一编号不许出现在两张正文纸上
  const where = new Map();
  for (const s of body) for (const id of s.ids) where.set(id, [...(where.get(id) || []), s.header]);
  const dup = [...where].filter(([, hs]) => hs.length > 1).map(([id, hs]) => `${id}@第${hs.join('/')}页`);

  // 校验 ⑤：编号是否印在它该在的那张纸上（档位表 page 是 0 基）
  const placeable = [...expected].filter((id) => tiers[id] && tiers[id].page >= 0);
  const placeFail = placeable.filter((id) => {
    const want = tiers[id].page + 1;
    return !perSheet.some((s) => s.i === want && s.ids.has(id));
  });

  return {
    task, scope, pdf, pages,
    sheets: pages.length, total: expected.size,
    located: placeable.length, unlocated: expected.size - placeable.length,
    missing, extra, countBad, dup, placeFail, perSheet,
  };
}

/** 按顺序列出某份成果报告里的编号及其内容前缀（用于核对"同名编号是否同一条"） */
function listReport(task, scope) {
  const p = path.join(TASKS_DIR, task, REPORT_OF[scope]);
  if (!fs.existsSync(p)) { console.log(`  （没有 ${REPORT_OF[scope]}）`); return; }
  const t = fs.readFileSync(p, 'utf8');
  const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const re = />(P[0-3]-\d+)</g;
  let m;
  const seen = new Set();
  console.log(`\n  ── ${SCOPE_CN[scope]}成果报告里的编号（按出现顺序，去重）──`);
  while ((m = re.exec(t))) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    console.log(`    ${id.padEnd(7)} ${strip(t.slice(m.index, m.index + 160)).slice(0, 70)}`);
  }
  console.log(`    共 ${seen.size} 个`);
}

function judge(r) {
  return !r.missing.length && !r.extra.length && !r.countBad.length && !r.dup.length && !r.placeFail.length;
}

/** 把一个编号在两份报告/两档标注版里的存在情况摊开，用于排查"编号对不上" */
function explain(task, id) {
  const dir = path.join(TASKS_DIR, task);
  const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  const rowOf = (file) => {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) return null;
    const t = fs.readFileSync(p, 'utf8');
    const i = t.indexOf(`>${id}<`);
    if (i < 0) return null;
    return strip(t.slice(Math.max(0, i - 150), i + 500)).slice(0, 420);
  };
  const inPdf = (file) => {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) return '（无此文件）';
    return idsIn(pagesOf(p).join('\n')).has(id) ? '在' : '不在';
  };
  /** 这条编号实际印在哪几张纸上（物理页序 + 页眉号），排查"错页"用 */
  const whereIn = (file) => {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) return '（无此文件）';
    const hits = [];
    pagesOf(p).forEach((t, i) => {
      if (!idsIn(t).has(id)) return;
      const fl = (t.split('\n').find((l) => l.trim()) || '').trim().slice(0, 40);
      hits.push(`第${i}张${fl ? `（${fl}）` : ''}`);
    });
    return hits.length ? hits.join('、') : '全篇都没有';
  };
  const tiers = fs.existsSync(path.join(dir, 'annotate-tiers.json'))
    ? JSON.parse(fs.readFileSync(path.join(dir, 'annotate-tiers.json'), 'utf8'))[id] : null;
  console.log(`\n编号 ${id} @ ${task}`);
  console.log(`  档位表      ：${tiers ? `${tiers.tier}${tiers.how ? '/' + tiers.how : ''} ${tiers.page >= 0 ? '原报告第 ' + (tiers.page + 1) + ' 页' : '（未定位，页序 -1）'}` : '（档位表里没有）'}`);
  console.log(`  校对版 PDF  ：${inPdf('原报告标注版-校对.pdf')}`);
  console.log(`  审核版 PDF  ：${inPdf('原报告标注版-审核.pdf')}`);
  if (argv.includes('--where')) {
    console.log(`  校对版印在  ：${whereIn('原报告标注版-校对.pdf')}`);
    console.log(`  审核版印在  ：${whereIn('原报告标注版-审核.pdf')}`);
  }
  console.log(`  校对成果报告：${rowOf(REPORT_OF.proof) || '（报告里没有这个编号）'}`);
  console.log(`  审核成果报告：${rowOf(REPORT_OF.deep) || '（报告里没有这个编号）'}`);
}

function reportOne(r, opts = {}) {
  const tag = `${r.task} ${SCOPE_CN[r.scope]}版`;
  const allGood = judge(r);
  console.log(`  ${allGood ? '✓' : '✗'} ${tag} ${r.sheets} 页｜报告编号 ${r.total} 个（可定位 ${r.located}、仅清单 ${r.unlocated}）` +
    `｜漏印 ${r.missing.length}｜多印 ${r.extra.length}｜条数不符 ${r.countBad.length}｜重复 ${r.dup.length}｜错页 ${r.placeFail.length}`);
  const brief = (name, arr, n = 10) => { if (arr.length) console.log(`      ${name}：${arr.slice(0, n).join(', ')}${arr.length > n ? ` …（共 ${arr.length}）` : ''}`); };
  brief('报告里有、标注版上找不到', r.missing);
  brief('标注版上有、报告里没有', r.extra);
  brief('页眉条数不符', r.countBad, 6);
  brief('同一编号出现在多张纸', r.dup, 6);
  brief('没印在该在的那一页', r.placeFail, 8);

  if (opts.headers) {
    console.log('\n  逐张页眉解析：idx | 页眉号 | 页眉条数 | 页内编号数 | 页内编号');
    for (const s of r.perSheet) {
      console.log(`    ${String(s.i).padStart(3)} | ${(s.header || '—').padStart(4)} | ${s.count === null ? '—' : String(s.count).padStart(3)} | ${String(s.ids.size).padStart(3)} | ${[...s.ids].slice(0, 6).join(',')}`);
    }
  }
  if (opts.dump !== undefined) {
    const s = r.perSheet[opts.dump];
    console.log(`\n  ── 第 ${opts.dump} 张原始抽取文本（前 1200 字）──`);
    console.log(s ? r.pages[opts.dump].slice(0, 1200) : '（没有这张）');
    console.log(`  ── 该张编号：${s ? [...s.ids].join(', ') : ''}  页眉号：${s ? s.header : ''}`);
  }
  return allGood;
}

// ── 执行 ──
const tasks = argv.includes('--all')
  ? fs.readdirSync(TASKS_DIR).filter((d) => fs.existsSync(path.join(TASKS_DIR, d, 'annotate-tiers.json')))
  : [argOf('--task')].filter(Boolean);
if (!tasks.length) {
  console.log('用法：node engine\\check-annotation-map.mjs --task <任务号> [--scope proof|deep|both] ｜ --all ｜ [--headers] [--dump N]');
  process.exit(2);
}
const wantScopes = argv.includes('--all') || argOf('--scope', 'both') === 'both' ? SCOPES : [argOf('--scope', 'deep')];
const dumpArg = argOf('--dump');
const opts = { headers: argv.includes('--headers'), dump: dumpArg === '' ? undefined : Number(dumpArg) };

let bad = 0, checked = 0, files = 0;
for (const t of tasks) {
  for (const sc of wantScopes) {
    const r = checkTask(t, sc);
    if (!r) { console.log(`  · 跳过 ${t} ${SCOPE_CN[sc]}版（缺 PDF 或成果报告）`); continue; }
    checked++; files++;
    if (!reportOne(r, tasks.length === 1 ? opts : {})) bad++;
  }
}
const explainIds = (argOf('--explain') || '').split(',').map((s) => s.trim()).filter(Boolean);
for (const id of explainIds) for (const t of tasks) explain(t, id);
if (argv.includes('--list')) for (const t of tasks) for (const sc of wantScopes) listReport(t, sc);
// --raw P0-4：把报告 HTML 里该编号前后的原始标签打出来（判断它是"编号列"还是"正文里的引用"）
const rawId = argOf('--raw');
if (rawId) {
  for (const t of tasks) for (const sc of wantScopes) {
    const p = path.join(TASKS_DIR, t, REPORT_OF[sc]);
    if (!fs.existsSync(p)) continue;
    const txt = fs.readFileSync(p, 'utf8');
    console.log(`\n  ── ${t} ${SCOPE_CN[sc]}报告里「${rawId}」的原始标签 ──`);
    const re = new RegExp(`.{0,150}${rawId}.{0,150}`, 'gs');
    const ms = [...txt.matchAll(re)].slice(0, 4);
    if (!ms.length) console.log('    （没有）');
    for (const m of ms) console.log('    ' + m[0].replace(/\n/g, ' '));
  }
}
console.log(`\n${bad === 0 ? '✅' : '❌'} 编号对应性核查：${files} 份标注版，${bad} 份有问题`);
process.exit(bad ? 1 : 0);
