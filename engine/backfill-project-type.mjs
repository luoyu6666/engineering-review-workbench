// 回填历史任务的「项目类型」（看板分组维度）。
//
// 背景：项目类型是后加的字段，上线前完成的任务 meta.json 里没有 projectType，
// 在数据看板里会全部落到「其他/未分类」。本脚本按项目名称 / 报告文件名 / 报告类型
// 做关键词识别回填；识别不出的保持「其他/未分类」。
//
// 纯离线、零 API 调用，可重复执行（幂等：已有 projectType 的任务跳过）。
// 用法：node engine/backfill-project-type.mjs [--force]
//   --force  连已有 projectType 的任务也重新识别一遍（改了关键词后想刷新时用）
import * as L from '../web/lib.mjs';

const force = process.argv.includes('--force');
const tasks = L.listTasks();
let touched = 0, skipped = 0;

for (const t of tasks) {
  if (t.projectType && !force) { skipped++; continue; }
  const before = t.projectType || '（无）';
  const guess = L.guessProjectType(t.projectName, t.sourceName, t.templateName);
  if (guess === before && !force) { skipped++; continue; }
  t.projectType = guess;
  L.saveTask(t);
  console.log(`  ${t.id}  ${before} → ${guess}`
    + `   [名称「${t.projectName || '—'}」/ 文件「${t.sourceName}」/ 类型「${t.templateName || '—'}」]`);
  touched++;
}

console.log(`\n完成：回填 ${touched} 个任务，跳过 ${skipped} 个（共 ${tasks.length} 个）。`);
console.log('提示：识别结果不合适的，可在「系统管理 → 项目类型」里调关键词后加 --force 重跑。');
