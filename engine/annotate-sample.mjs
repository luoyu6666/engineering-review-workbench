/**
 * 原报告标注版 —— 复跑 / 验收工具
 *
 * 用法（PowerShell）：
 *   node engine\annotate-sample.mjs
 *   $env:TASK_ID='T20260924-6b4a20'; node engine\annotate-sample.mjs
 *   $env:TASK_ID='T20260924-6b4a20'; $env:SCOPE='proof'; node engine\annotate-sample.mjs   # 只出校对版
 *   $env:ANNOT_DPI='130'; node engine\annotate-sample.mjs                                  # 调清晰度
 *
 * 产物：运维\预览\原报告标注版-校对-<任务号>.pdf / -审核-<任务号>.pdf
 *       运维\预览\标注版-定位率-<任务号>.json（如实记录定位率，便于对比改进效果）
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildAnnotatedPdf, DEFAULT_DPI } from './lib/annotate.mjs';

const BASE = path.resolve(import.meta.dirname, '..');
const TASK = process.env.TASK_ID || 'T20260924-6b4a20';
const ONLY = (process.env.SCOPE || '').toLowerCase();
const DPI = Number(process.env.ANNOT_DPI || DEFAULT_DPI);

const taskDir = path.join(BASE, 'web/data/tasks', TASK);
if (!fs.existsSync(taskDir)) { console.error('任务不存在：' + taskDir); process.exit(1); }

const outDir = path.join(BASE, '运维/预览');
fs.mkdirSync(outDir, { recursive: true });

const jobs = [
  { scope: 'proof', label: '校对版' },
  { scope: 'deep', label: '审核版' },
].filter(j => !ONLY || ONLY === j.scope);

const report = { task: TASK, dpi: DPI, at: new Date().toISOString(), runs: [] };

for (const j of jobs) {
  const outPdf = path.join(outDir, `原报告标注版-${j.label}-${TASK}.pdf`);
  console.log(`\n==== ${j.label}（scope=${j.scope}）====`);
  try {
    const st = await buildAnnotatedPdf({
      taskDir, scope: j.scope, outPdf, dpi: DPI,
      log: (m) => console.log('  ' + m),
    });
    const line = `标注 ${st.total} 条 · 精确定位 ${st.exact} · 近似定位 ${st.approx} · 章节定位 ${st.section} · 未能定位 ${st.none}`;
    console.log('  ✓ ' + line);
    console.log(`  定位率（精确定位）＝ ${st.exactRate}%　可用定位率（精确+近似）＝ ${st.rate}%　覆盖（含章节）＝ ${st.coverRate}%`);
    console.log(`  原报告 ${st.pages} 页，PDF ${(st.bytes / 1048576).toFixed(1)} MB，耗时 ${st.seconds}s`);
    console.log(`  产物：${outPdf}`);
    report.runs.push({ ...st, label: j.label, outPdf });
  } catch (e) {
    console.error('  ✗ 失败：' + e.message);
    report.runs.push({ scope: j.scope, label: j.label, error: e.message });
  }
}

fs.writeFileSync(path.join(outDir, `标注版-定位率-${TASK}.json`), JSON.stringify(report, null, 2), 'utf8');
console.log('\n定位率记录：运维\\预览\\标注版-定位率-' + TASK + '.json');
