// 给已完成的历史任务补生成 PDF 成果（校对版 + 审核版）。
//
// 背景：成果下载从 Word 改成 PDF 后，老任务目录里只有 opinion.docx，没有 PDF，
// 下载时会回退成 HTML。这个脚本把已有 report*.html 的任务补齐 PDF。
//
// 幂等：已存在且体积正常的 PDF 会跳过。可重复执行。
// 用法：node engine/backfill-pdf.mjs [--force]
import fs from 'node:fs';
import path from 'node:path';
import * as L from '../web/lib.mjs';

const force = process.argv.includes('--force');
if (!L.findBrowser()) {
  console.error('未找到 Chrome / Edge，无法生成 PDF');
  process.exit(1);
}

const tasks = L.listTasks();
let made = 0, skip = 0, fail = 0;

for (const t of tasks) {
  if (t.status !== 'done') continue;
  const dir = L.taskDir(t.id);
  for (const [src, dst, label] of [
    ['report.html', '校对成果.pdf', '校对成果'],
    ['report.deep.html', '审核成果.pdf', '审核成果'],
  ]) {
    const sp = path.join(dir, src), dp = path.join(dir, dst);
    if (!fs.existsSync(sp)) { skip++; continue; }
    if (!force && fs.existsSync(dp) && fs.statSync(dp).size > 1024) { skip++; continue; }
    const t0 = Date.now();
    try {
      await L.exportPdfFromHtml(sp, dp);
      const kb = Math.round(fs.statSync(dp).size / 1024);
      console.log(`  ${t.id}  ${label} → ${kb} KB（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
      made++;
    } catch (e) {
      console.log(`  ${t.id}  ${label} 失败：${e.message}`);
      fail++;
    }
  }
}

console.log(`\n完成：新生成 ${made} 个 PDF，跳过 ${skip} 个，失败 ${fail} 个。`);
console.log('提示：老任务若没有 report*.html（早期版本没生成深度版），下载时会自动回退成 HTML。');
