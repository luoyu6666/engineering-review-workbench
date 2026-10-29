/**
 * 历史任务：预生成「原报告标注版」（校对版 + 审核版）
 *
 * 背景：v1.3.0 起，新版任务在审核流水线内即生成标注版，下载时直接读取。
 * 该版本之前完成的任务没有标注版，下载时需现场转换（95 页约十几秒，大报告 40 秒以上）。
 * 本脚本一次性补齐这些历史任务，此后下载不再需要现场转换。
 *
 * 幂等：已存在且体积正常的 PDF 会跳过。零 API 调用，只跑本机转换（LibreOffice + poppler + Chrome）。
 *
 * NOTE: `--apply` 只写任务目录下的标注版 PDF 与 meta.json 的 annotate 字段，
 *       不动审核结论、不动成果报告。会占用 CPU，建议在无提交/审核的时段执行。
 *
 * 用法：
 *   node engine\backfill-annotate.mjs                  # 预览：列出缺标注版的任务
 *   node engine\backfill-annotate.mjs --limit 3 --apply
 *   node engine\backfill-annotate.mjs --ids T1,T2 --apply
 *   node engine\backfill-annotate.mjs --scope proof --apply    # 只补校对版
 *   node engine\backfill-annotate.mjs --apply --force          # 已存在的也重做（改排版后重跑）
 *   node engine\backfill-annotate.mjs --apply                  # 全部补齐
 */
import fs from 'node:fs';
import path from 'node:path';
import * as L from '../web/lib.mjs';
import { buildAnnotatedPdf } from './lib/annotate.mjs';

const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');     // 已存在的也重做（改了排版/配色后要重跑时用）
const argOf = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : ''; };
const LIMIT = Number(argOf('--limit') || 0);
const IDS = String(argOf('--ids') || '').split(',').map(s => s.trim()).filter(Boolean);
const ONLY = String(argOf('--scope') || '').toLowerCase();

const outOf = (dir, scope) => path.join(dir, scope === 'deep' ? '原报告标注版-审核.pdf' : '原报告标注版-校对.pdf');

let tasks = L.listTasks().filter(t => t.status === 'done');
if (IDS.length) tasks = tasks.filter(t => IDS.includes(t.id));
if (LIMIT > 0) tasks = tasks.slice(0, LIMIT);

const scopes = ONLY ? [ONLY] : ['proof', 'deep'];
if (!APPLY) console.log('预览模式（不改文件）。确认无误后加 --apply 执行。\n');

let made = 0, skip = 0, fail = 0;
for (const t of tasks) {
  const dir = L.taskDir(t.id);
  if (!fs.existsSync(path.join(dir, 'run/s4_graded.json'))) { console.log(`  跳过 ${t.id}：没有 s4_graded.json`); skip++; continue; }
  for (const scope of scopes) {
    const out = outOf(dir, scope);
    const label = scope === 'proof' ? '校对版' : '审核版';
    if (!FORCE && fs.existsSync(out) && fs.statSync(out).size > 1024) { console.log(`  跳过 ${t.id} ${label}：已存在`); skip++; continue; }
    if (!APPLY) { console.log(`  将生成 ${t.id}  ${label}`); made++; continue; }
    try {
      const st = await buildAnnotatedPdf({
        taskDir: dir, scope, outPdf: out,
        log: (m) => console.log(`    [${t.id}/${scope}] ${m}`),
      });
      // 把定位率写回 meta.json 的 annotate 字段（前端详情页要显示），只动这一个字段；
      // 同时把每条问题的定位档位写成 annotate-tiers.json —— 成果报告重渲染时用它给
      // "没能在原报告里标出位置"的条目加红字提示（backfill-numbering.mjs 会读）。
      try {
        const meta = L.getTask(t.id);
        if (meta) {
          meta.annotate = { ...(meta.annotate || {}), [scope]: {
            total: st.total, exact: st.exact, approx: st.approx, section: st.section, none: st.none,
            approxNumber: st.approxNumber, rate: st.rate, exactRate: st.exactRate, coverRate: st.coverRate,
            pages: st.pages, bytes: st.bytes, seconds: st.seconds, at: new Date().toISOString(),
          } };
          L.saveTask(meta);
        }
        const tf = path.join(dir, 'annotate-tiers.json');
        const old = fs.existsSync(tf) ? JSON.parse(fs.readFileSync(tf, 'utf8')) : {};
        fs.writeFileSync(tf, JSON.stringify({ ...old, ...(st.tiers || {}) }, null, 2), 'utf8');
      } catch (e) { console.log(`    （meta/tiers 回写失败，不影响 PDF：${e.message}）`); }
      console.log(`  ✓ ${t.id} ${label}：${st.total} 条，精确定位 ${st.exactRate}%、可用 ${st.rate}%、覆盖 ${st.coverRate}%，${(st.bytes / 1048576).toFixed(1)} MB，${st.seconds}s`);
      made++;
    } catch (e) {
      console.log(`  ✗ ${t.id} ${label} 失败：${e.message}`);
      fail++;
    }
  }
}
console.log(`\n${APPLY ? '完成' : '待生成'}：${made} 个，跳过 ${skip} 个，失败 ${fail} 个。`);
