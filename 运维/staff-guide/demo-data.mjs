/**
 * 《操作说明》素材生成器 ① 示例数据
 *
 * 使用合成示例数据而非真实任务：
 *   操作说明会被打印、转发、贴到群共享里，其中不能出现真实项目名称与真实报告的问题内容。
 *   因此这里使用虚构项目名与虚构问题，但走真实渲染管线（renderHtmlReport）生成成果页，
 *   截图结果与真实界面完全一致，内容则是可公开的示例。
 *
 * 用法：node 运维\staff-guide\demo-data.mjs <数据目录> <提交人姓名>
 *   （数据目录通常是临时影子实例的目录，不接触生产数据）
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DATA_DIR = process.argv[2];
const OWNER_NAME = process.argv[3] || '刘工';
if (!DATA_DIR) { console.error('用法：node demo-data.mjs <数据目录> <提交人姓名>'); process.exit(1); }
process.env.WB_DATA_DIR = DATA_DIR;

// Chrome/Edge 路径：PDF 生成要用（声明在使用之前，见下方注释）
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));

// 注意：Windows 上动态 import 必须用 file:// URL —— 直接传 "D:\..." 会报
// ERR_UNSUPPORTED_ESM_URL_SCHEME（经实测确认）
const mod = (rel) => pathToFileURL(path.join(ROOT, rel)).href;
const { renderHtmlReport, classify } = await import(mod('engine/lib/report-html.mjs'));
const L = await import(mod('web/lib.mjs'));

// ── 示例问题（全部虚构；校对类人人可看，深度类只有审核专家能看）──
const pf = [
  { category: '数据不实', description: '总投资在正文与表格中不一致', location: '正文 3.2 节 ／ 表 3-2',
    quote: '项目总投资 12,345 万元', basis: '同一指标在同一份报告内出现两个值', fix: '核实批复口径后统一为同一数值' },
  { category: '编校错误', description: '“含水率”误写为“含水绿”', location: '第 4 章 表 4-1 表头', quote: '含水绿（%）', fix: '改为“含水率（%）”' },
  { category: '术语错误', description: '“采出程度”与“采出程度率”混用', location: '正文 5.1 节', quote: '采出程度率达到 21.3%', fix: '统一为规范术语“采出程度”' },
  { category: '口径混用', description: '产量单位 t 与 10⁴t 混用', location: '正文 6.3 节 ／ 表 6-5', quote: '年产油 3.2 万吨……单井日产 8 t', fix: '全文统一单位并标明换算关系' },
  { category: '前后矛盾', description: '摘要与正文的日产水平不一致', location: '摘要 ／ 正文 7.2 节', quote: '摘要：日产油 30 t；正文：日产油 3 t', fix: '以开发方案设计值为准统一' },
  { category: '标准规范', description: '引用标准编号写法不规范', location: '正文 2.4 节', quote: 'GB/T51098-2015', fix: '改为 GB/T 51098—2015' },
];
const dp = [
  { category: '结论偏宽', description: '未做敏感性分析即给出“效益可行”的结论', location: '第 9 章 结论',
    basis: '结论缺少对油价、产量波动的敏感性支撑', fix: '补充敏感性分析后再下结论，或明确结论的适用条件' },
  { category: '建议缺失', description: '对递减率偏高的风险未提出对策', location: '第 8 章 建议',
    fix: '针对递减率与稳产风险补充具体措施与责任分工' },
  { category: '投资程序红线', description: '投资变更未说明审批程序', location: '第 6 章 投资估算',
    basis: '变更超授权额度时应有审批依据', fix: '补充变更审批文件编号与结论' },
  { category: '成果完整性', description: '缺少投资估算依据章节', location: '第 6 章',
    fix: '补充估算指标来源、价格水平年与取费标准' },
];

const withNo = (list, prefix) => list.map((x, i) => ({ ...x, no: `${prefix}-${i + 1}`, tier: i === list.length - 1 ? 'section' : 'page' }));
// 分级：前 4 条放 P0、其余（含深度类）放 P1 —— 使校对成果里 P0/P1 都有数量，与真实成果页一致。
// （全员只能看到校对类；深度类只有审核专家能看到。）
const graded = {
  stats: { p0Count: 4, p1Count: pf.length - 4 + dp.length, p2Count: 0, p3Count: 0, total: pf.length + dp.length },
  p0: withNo(pf.slice(0, 4), 'P0'),
  p1: withNo([...pf.slice(4), ...dp], 'P1'),
  p2: [], p3: [],
};
// 校对类条数用真实的分类函数计算，避免出现"报告里的数字与台账/详情里的对不上"
const isPf = (x) => classify(x) === 'proofread';
const pfP0Count = graded.p0.filter(isPf).length;
const pfP1Count = graded.p1.filter(isPf).length;

const tasks = [
  { id: 'T20260928-DEMO01', projectName: '×××区块产能建设项目', projectCode: 'DEMO-2026-001',
    sourceName: '×××区块产能建设项目后评价报告.docx', templateName: '投资项目后评价报告', projectType: '产能后评价',
    status: 'done', proofreadP0: pfP0Count, proofreadP1: pfP1Count,
    proofreadCount: pfP0Count + pfP1Count, deepCount: graded.p0.length + graded.p1.length - pfP0Count - pfP1Count,
    cost: 0.72 },
  { id: 'T20260927-DEMO02', projectName: '×××压裂设备购置项目', projectCode: 'DEMO-2026-002',
    sourceName: '×××压裂设备购置可行性研究报告.docx', templateName: '可行性研究报告', projectType: '装备购置可研',
    status: 'done', proofreadP0: pfP0Count, proofreadP1: pfP1Count,
    proofreadCount: pfP0Count + pfP1Count, deepCount: graded.p0.length + graded.p1.length - pfP0Count - pfP1Count,
    cost: 0.41 },
];

const users = L.listUsers();
const me = users.find(u => u.name === OWNER_NAME) || users[0];
const now = Date.now();

for (const t of tasks) {
  const dir = L.taskDir(t.id);
  fs.mkdirSync(path.join(dir, 'run'), { recursive: true });
  const meta = {
    ...t,
    owner: me.id, ownerName: me.name,
    createdAt: new Date(now - 26 * 3600e3).toISOString(),
    finishedAt: new Date(now - 25 * 3600e3).toISOString(),
    startedAt: new Date(now - 25.5 * 3600e3).toISOString(),
    uploadBytes: 1_234_567, convertedChars: 86_420, tableRows: 214,
    stats: { p0Count: t.proofreadP0 + 2, p1Count: t.proofreadP1 + 2, p2Count: 0, p3Count: 0 },
    usage: { prompt: 486_120, completion: 62_340, cacheHit: 301_500, cacheMiss: 184_620 },
    peak: false, mode: 'idle',
    unitStats: [{ unit: 'format-basic', issues: 6 }, { unit: 'consistency', issues: 5 }],
    categoryCounts: { 数据不实: 3, 编校错误: 2, 术语错误: 1, 结论偏宽: 1 },
    annotate: { proof: { total: 6, exact: 5, approx: 1, section: 0, none: 0, rate: 100, exactRate: 83.3, coverRate: 100, pages: 42, bytes: 3_100_000, seconds: 4, at: new Date(now).toISOString() } },
    progress: [{ at: new Date(now - 25 * 3600e3).toISOString(), text: '审核完成（示例数据）' }],
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'run/s4_graded.json'), JSON.stringify(graded, null, 2), 'utf8');

  const reportTask = { ...meta };
  const htmlPf = renderHtmlReport({ task: reportTask, graded, narrative: '', deepAccess: false, model: 'deepseek-flash' });
  const htmlDeep = renderHtmlReport({ task: reportTask, graded, narrative: '', deepAccess: true, model: 'deepseek-flash' });
  fs.writeFileSync(path.join(dir, 'report.html'), htmlPf, 'utf8');
  fs.writeFileSync(path.join(dir, 'report.deep.html'), htmlDeep, 'utf8');

  // PDF 三件套：真实环境里审核结束时即生成这些文件，员工看到的是下载入口。
  // 示例数据同样补齐（否则详情页显示"生成…"按钮，与员工实际看到的界面不一致）。
  await printPdf(path.join(dir, 'report.html'), path.join(dir, '校对成果.pdf'));
  await printPdf(path.join(dir, 'report.deep.html'), path.join(dir, '审核成果.pdf'));
  await printPdf(writeAnnotDemoHtml(dir, reportTask), path.join(dir, '原报告标注版-校对.pdf'));
  console.log(`  示例任务 ${t.id}：${t.projectName}（校对类 ${pfP0Count + pfP1Count} 条 + 深度类 ${graded.p0.length + graded.p1.length - pfP0Count - pfP1Count} 条）`);
}

// ── PDF 生成（与手册同一条管线：HTML → Chrome headless 打印）──
// CHROME 常量声明在文件顶部（函数使用之前必须先声明；放在此处会触发 TDZ）。
async function printPdf(htmlPath, pdfPath) {
  if (!CHROME) { console.log('   （没找到 Chrome/Edge，跳过 PDF）'); return; }
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const prof = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'demopdf-'));
  try {
    await promisify(execFile)(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-pdf-header-footer',
      `--user-data-dir=${prof}`, `--print-to-pdf=${pdfPath}`,
      'file:///' + htmlPath.replace(/\\/g, '/').replace(/ /g, '%20')], { timeout: 120000, windowsHide: true });
  } catch { /* ignore */ } finally { try { fs.rmSync(prof, { recursive: true, force: true }); } catch { /* ignore */ } }
}

/** 一张标注版示例页（真实标注版把问题画在原文上；示例只需让下载入口有内容可取） */
function writeAnnotDemoHtml(dir, task) {
  const p = path.join(dir, 'annot-demo.html');
  fs.writeFileSync(p, `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  body{font-family:"Microsoft YaHei",sans-serif;padding:18mm;color:#1a1d21}
  h1{font-size:20pt;color:#0b3d6b;margin-bottom:6mm}
  .q{border-left:4px solid #e11d48;background:#fff5f7;padding:4mm 5mm;margin:4mm 0;font-size:12.5pt}
  .tag{display:inline-block;background:#e11d48;color:#fff;border-radius:1mm;padding:.6mm 2mm;font-size:10.5pt;margin-right:2mm}
  </style></head><body>
  <h1>原报告标注版（示例）</h1>
  <p style="font-size:12pt;color:#5b636e">受审报告：${task.sourceName}</p>
  <p style="font-size:12pt;color:#5b636e">问题直接画在原文对应位置；本页仅为操作说明的示例占位。</p>
  <div class="q"><span class="tag">P0-1</span>总投资在正文与表格中不一致（正文 3.2 节 ／ 表 3-2）</div>
  <div class="q"><span class="tag">P0-2</span>“含水率”误写为“含水绿”（第 4 章 表 4-1 表头）</div>
  </body></html>`, 'utf8');
  return p;
}

// 第三条：排队中（用于"处理进度 / 排队"截图）
{
  const id = 'T20260928-DEMO03';
  const dir = L.taskDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const meta = {
    id, owner: me.id, ownerName: me.name,
    projectName: '×××集输系统改造工程', projectCode: 'DEMO-2026-003',
    sourceName: '×××集输系统改造工程可行性研究报告.docx',
    templateName: '可行性研究报告', projectType: '系统配套后评价',
    status: 'queued', mode: 'idle',
    createdAt: new Date(now - 3 * 60e3).toISOString(),
    uploadBytes: 986_432, progress: [{ at: new Date(now).toISOString(), text: '已受理，等待处理' }],
    priority: 0,
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  console.log(`  示例任务 ${id}：排队中（用于进度与排队截图）`);
}

console.log('示例数据生成完成（全部为虚构内容，可公开发布）');
