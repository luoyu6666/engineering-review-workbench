/**
 * 补齐 / 重做标注版 —— 纯本地生成，不调用 API、不产生任何费用。
 *
 * 两路标注版（2026-09-28: 新增 PPT 那一路）：
 *   · 报告：`原报告标注版-校对.pdf` / `原报告标注版-审核.pdf`（仅 PPT 的任务，标注对象就是那份 PPT）
 *   · PPT ：`原PPT标注版-校对.pdf` / `原PPT标注版-审核.pdf`（含 PPT 一致性核对的"报告 + PPT"配对任务）
 *
 * 适用场景：
 *   · 出现过"标注版生成失败"的事故，修复后为受影响的已发布任务补生成（2026-09-28: 补生成 14 份）；
 *   · 修复渲染问题后重做已有的 PPT 标注版（--force-ppt）——此前 LibreOffice 丢失 PPT 正文，
 *     已生成的标注框画在无正文的页面上，全部错位；
 *   · 服务在生成过程中被重启，留下半截任务；
 *   · 需要确认本机标注工具链是否齐全（本脚本开头即体检并打印）。
 *
 * 用法：
 *   node 运维\fix-annotate.mjs --dry              # 只列出缺什么（默认行为即演练，不写入任何内容）
 *   node 运维\fix-annotate.mjs                    # 只补缺失的文件
 *   node 运维\fix-annotate.mjs --apply            # 同上（显式确认）
 *   node 运维\fix-annotate.mjs --apply --force-ppt # 连已存在的 PPT 标注版一起重做（渲染修好后用）
 */
import fs from 'node:fs';
import path from 'node:path';
import * as L from '../web/lib.mjs';
import { buildAnnotatedPdf, toolchainStatus, toolchainHint, hasPairedPpt } from '../engine/lib/annotate.mjs';

const APPLY = process.argv.includes('--apply');
const FORCE_PPT = process.argv.includes('--force-ppt');
const DRY = process.argv.includes('--dry') || !APPLY;   // 默认演练：必须显式 --apply 才写盘

const st = toolchainStatus();
console.log('工具链：' + (st.ok ? '✓ 齐全' : '✗ ' + toolchainHint(st)));
console.log('  soffice  = ' + st.soffice.path);
console.log('  pdftoppm = ' + st.pdftoppm.path);
console.log('  pdftotext= ' + st.pdftotext.path);
if (!st.ok && !DRY) { console.error('工具链不齐，先修好再跑'); process.exit(1); }

const outOf = (dir, scope, kind) => path.join(dir,
  (kind === 'ppt' ? '原PPT标注版-' : '原报告标注版-') + (scope === 'deep' ? '审核' : '校对') + '.pdf');

const tasks = L.listTasks().filter(t => t.status === 'done');
const todo = [];
for (const t of tasks) {
  const dir = L.taskDir(t.id);
  const paired = hasPairedPpt(dir);
  const jobs = [];
  // 报告那一路（仅 PPT 的任务，这一路标注的就是 PPT 本身 —— 渲染修复后也要重做）
  for (const scope of ['proof', 'deep']) {
    const f = outOf(dir, scope, '');
    const exists = fs.existsSync(f);
    const pptOnlyTask = !fs.readdirSync(dir).some(x => /\.docx$/i.test(x) && !/extracted/i.test(x) && !/^~\$/.test(x));
    if (!exists || (FORCE_PPT && pptOnlyTask)) jobs.push({ scope, kind: '', why: exists ? '重做（原为 PPT 渲染，错位）' : '缺失' });
  }
  // PPT 那一路（配对任务才有）
  if (paired) {
    for (const scope of ['proof', 'deep']) {
      const f = outOf(dir, scope, 'ppt');
      const exists = fs.existsSync(f);
      if (!exists || FORCE_PPT) jobs.push({ scope, kind: 'ppt', why: exists ? '重做' : '缺失' });
    }
  }
  if (jobs.length) todo.push({ t, jobs });
}

console.log(`\n已完成任务 ${tasks.length} 个，需要处理 ${todo.length} 个、共 ${todo.reduce((s, x) => s + x.jobs.length, 0)} 份：`);
for (const x of todo) {
  console.log(`  ${x.t.id}  ${String(x.t.sourceName).slice(0, 40)}…`);
  for (const j of x.jobs) console.log(`      ${j.kind === 'ppt' ? 'PPT ' : '报告'}-${j.scope === 'deep' ? '审核' : '校对'}　${j.why}`);
}
if (!todo.length) { console.log('没有要处理的。'); process.exit(0); }
if (DRY) { console.log('\n（演练模式：没有写任何文件。确认无误后加 --apply 真正执行。）'); process.exit(0); }

let okN = 0, failN = 0;
for (const { t, jobs } of todo) {
  const dir = L.taskDir(t.id);
  const pptOnly = !fs.readdirSync(dir).some(f => /\.docx$/i.test(f) && !/extracted/i.test(f) && !/^~\$/.test(f));
  for (const j of jobs) {
    const key = j.kind === 'ppt' ? `ppt-${j.scope}` : j.scope;
    const out = outOf(dir, j.scope, j.kind);
    const t0 = Date.now();
    try {
      const r = await buildAnnotatedPdf({
        taskDir: dir, scope: j.scope, kind: j.kind, outPdf: out, preferPptx: pptOnly,
        log: (m) => console.log(`    [${t.id}/${key}] ${m}`),
      });
      // 与流水线一致：统计写回任务元数据（界面据此显示定位率）
      const fresh = L.getTask(t.id);
      fresh.annotate = { ...(fresh.annotate || {}), [key]: {
        total: r.total, exact: r.exact, approx: r.approx, section: r.section, none: r.none,
        approxNumber: r.approxNumber, rate: r.rate, exactRate: r.exactRate, coverRate: r.coverRate,
        pages: r.pages, bytes: r.bytes, seconds: r.seconds || Math.round((Date.now() - t0) / 1000),
        at: new Date().toISOString(), repaired: true,
      } };
      if (fresh.annotateError) { delete fresh.annotateError[key]; if (!Object.keys(fresh.annotateError).length) delete fresh.annotateError; }
      L.saveTask(fresh);
      try { fs.rmSync(path.join(dir, `annotate-${key}.json`), { force: true }); } catch { /* ignore */ }
      console.log(`  ✓ ${t.id}/${key} 标注 ${r.total} 条 · 精确定位 ${r.exactRate}% · 可用 ${r.rate}% · ${Math.round((Date.now() - t0) / 1000)}s · ${(r.bytes / 1048576).toFixed(1)}MB`);
      okN++;
    } catch (e) {
      console.log(`  ✗ ${t.id}/${key} 失败：${e.message}`);
      failN++;
    }
  }
}
console.log(`\n完成：成功 ${okN} 份，失败 ${failN} 份`);
