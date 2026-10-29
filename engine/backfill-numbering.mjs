/**
 * 历史任务《成果报告》编号回填 —— 零 API 调用
 *
 * 背景：本次改动把「成果报告」与「原报告标注版」的编号统一为同一套全局编号
 *       （P0-1 … / P1-37 …，同一条问题在两份文件里编号相同）。
 *       改动之前完成的任务，report.html / 成果 PDF 里 P1 表是"校对类、深度类各自从 1 开始"，
 *       与标注版编号不一致 —— 本脚本用已保存的 run/s4_graded.json 重新渲染并重出 PDF。
 *
 * 只改编号与排版，不动审核结论、不重新调用 AI。
 * 审核时间沿用任务原本的 finishedAt，不因重新导出而变成导出当天的日期。
 *
 * 用法：
 *   node engine\backfill-numbering.mjs                    # 预览：列出会处理哪些任务
 *   node engine\backfill-numbering.mjs --limit 3 --apply   # 只处理最近 3 个（先看效果）
 *   node engine\backfill-numbering.mjs --ids T1,T2 --apply
 *   node engine\backfill-numbering.mjs --apply             # 全部（覆盖 report*.html 与两份成果 PDF）
 */
import fs from 'node:fs';
import path from 'node:path';
import * as L from '../web/lib.mjs';
import { renderHtmlReport } from './lib/report-html.mjs';

const APPLY = process.argv.includes('--apply');
// 可选：--limit N 只处理最近 N 个；--ids a,b,c 只处理指定任务（先小范围看效果，再全量）
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg >= 0 ? Number(process.argv[limitArg + 1] || 0) : 0;
const idsArg = process.argv.indexOf('--ids');
const IDS = idsArg >= 0 ? String(process.argv[idsArg + 1] || '').split(',').map(s => s.trim()).filter(Boolean) : [];

let tasks = L.listTasks().filter(t => t.status === 'done');
if (IDS.length) tasks = tasks.filter(t => IDS.includes(t.id));
if (LIMIT > 0) tasks = tasks.slice(0, LIMIT);
if (!APPLY) console.log('预览模式（不改文件）。确认无误后加 --apply 执行。\n');

if (APPLY && !L.findBrowser()) {
  console.error('未找到 Chrome / Edge，无法重出 PDF');
  process.exit(1);
}

let done = 0, skip = 0, fail = 0;
for (const t of tasks) {
  const dir = L.taskDir(t.id);
  const gradedFile = path.join(dir, 'run/s4_graded.json');
  if (!fs.existsSync(gradedFile)) { console.log(`  跳过 ${t.id}：没有 run/s4_graded.json`); skip++; continue; }
  if (!APPLY) { console.log(`  将处理 ${t.id}  ${t.sourceName}`); done++; continue; }
  try {
    const graded = JSON.parse(fs.readFileSync(gradedFile, 'utf8'));
    let narrative = '';
    const nf = path.join(dir, 'narrative.md');
    if (fs.existsSync(nf)) narrative = fs.readFileSync(nf, 'utf8');
    const generatedAt = new Date(t.finishedAt || t.createdAt || Date.now());
    // 有标注版定位档位就带上：报告里给"没能在原报告中标出位置"的条目加红字提示
    let annotateTiers = null;
    const tf = path.join(dir, 'annotate-tiers.json');
    if (fs.existsSync(tf)) { try { annotateTiers = JSON.parse(fs.readFileSync(tf, 'utf8')); } catch { /* 档位文件坏了就退化为不加提示 */ } }
    const htmlDeep = renderHtmlReport({ task: t, graded, narrative, deepAccess: true, generatedAt, annotateTiers });
    const htmlPf = renderHtmlReport({ task: t, graded, narrative, deepAccess: false, generatedAt, annotateTiers });
    fs.writeFileSync(path.join(dir, 'report.deep.html'), htmlDeep, 'utf8');
    fs.writeFileSync(path.join(dir, 'report.html'), htmlPf, 'utf8');
    for (const [src, dst] of [['report.html', '校对成果.pdf'], ['report.deep.html', '审核成果.pdf']]) {
      await L.exportPdfFromHtml(path.join(dir, src), path.join(dir, dst));
    }
    console.log(`  ✓ ${t.id}  已重出 HTML + 两份 PDF`);
    done++;
  } catch (e) {
    console.log(`  ✗ ${t.id} 失败：${e.message}`);
    fail++;
  }
}
console.log(`\n${APPLY ? '完成' : '待处理'}：${done} 个，跳过 ${skip} 个，失败 ${fail} 个。`);
