// 回填历史任务的「校对类 P0/P1」计数。
// 用途：分权限口径上线前完成的任务，meta.json 里没有 proofreadP0 / proofreadP1，
// 普通用户在台账上会看到 P0/P1 = 0/0（与实际不符）。本脚本从 run/s4_graded.json
// 重新按类别判定、回填这两个字段。纯离线，不调用任何 API，可重复执行（幂等）。
import fs from 'node:fs';
import path from 'node:path';
import * as L from '../web/lib.mjs';
import { classify } from './lib/report-html.mjs';

const tasks = L.listTasks();
let touched = 0, skipped = 0;

for (const t of tasks) {
  if (t.proofreadP0 !== undefined && t.proofreadP1 !== undefined) { skipped++; continue; }
  const p = path.join(L.DATA_DIR, 'tasks', t.id, 'run', 's4_graded.json');
  if (!fs.existsSync(p)) { console.log(`  ${t.id} 跳过：无 s4_graded.json`); skipped++; continue; }
  let g;
  try { g = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.log(`  ${t.id} 跳过：s4_graded.json 读取失败 ${e.message}`); skipped++; continue; }

  const all = [...(g.p0 || []), ...(g.p1 || []), ...(g.p2 || []), ...(g.p3 || [])];
  const pf = all.filter(x => classify(x) === 'proofread');
  t.proofreadP0 = (g.p0 || []).filter(x => classify(x) === 'proofread').length;
  t.proofreadP1 = (g.p1 || []).filter(x => classify(x) === 'proofread').length;
  t.proofreadCount = t.proofreadCount ?? pf.length;
  t.deepCount = t.deepCount ?? (all.length - pf.length);
  L.saveTask(t);
  console.log(`  ${t.id} 回填：校对类 P0=${t.proofreadP0} P1=${t.proofreadP1}（校对类合计 ${t.proofreadCount}、深度类 ${t.deepCount}）`);
  touched++;
}

console.log(`\n完成：回填 ${touched} 个任务，跳过 ${skipped} 个。`);

// ── 顺带补齐历史任务的「审核版 Word」（此前只导出了校对版）──
// 幂等：已存在 opinion.deep.docx 的不重复导出。
let docxMade = 0, docxSkip = 0;
for (const t of tasks) {
  const dir = L.taskDir(t.id);
  const src = path.join(dir, 'report.deep.html');
  const dst = path.join(dir, 'opinion.deep.docx');
  if (!fs.existsSync(src)) { docxSkip++; continue; }
  if (fs.existsSync(dst)) { docxSkip++; continue; }
  try {
    await L.exportDocxFromHtml(src, dst);
    console.log(`  ${t.id} 导出审核版 Word 完成`);
    docxMade++;
  } catch (e) {
    console.log(`  ${t.id} 审核版 Word 导出失败：${e.message}`);
    docxSkip++;
  }
}
console.log(`\n审核版 Word：新导出 ${docxMade} 个，跳过 ${docxSkip} 个。`);
