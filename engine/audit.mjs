#!/usr/bin/env node
/**
 * 审核工作台 — CLI 入口（分阶段流水线版，取代 v0 的一次性调用）
 *
 * 用法：
 *   node audit.mjs --report <报告> [--out <意见书>] [--model flash|pro] [--dry-run]
 *   node audit.mjs --report x.txt --units format-basic,investment     # 只跑指定单元（调试用）
 *
 * 产出：
 *   <out>                         审核意见书 Markdown
 *   <runDir>/s1_facts.json        S1 结构化事实
 *   <runDir>/s2_issues.json       S2 各单元问题清单
 *   <runDir>/s3_rules.json        S3 规则引擎命中
 *   <runDir>/s4_graded.json       S4 分级结果
 *   <runDir>/summary.json         本次运行统计与 token 消耗
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateTokens, getApiKey, MODELS, SKILL_DIR } from './lib/core.mjs';
import { runPipeline, UNITS } from './lib/pipeline.mjs';
import { renderHtmlReport } from './lib/report-html.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const a = { model: 'flash', dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--report') { a.report = v; i++; }
    else if (k === '--out') { a.out = v; i++; }
    else if (k === '--model') { a.model = v; i++; }
    else if (k === '--units') { a.units = v.split(','); i++; }
    else if (k === '--run-dir') { a.runDir = v; i++; }
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--help' || k === '-h') a.help = true;
  }
  return a;
}

function usage() {
  console.log(`
审核工作台 CLI（分阶段流水线）

  node audit.mjs --report <报告文本> [选项]

  --report <path>       待审核报告 .md/.txt（.docx/.pdf 请先转换）
  --out <path>          意见书输出路径
  --model <flash|pro>   默认 flash
  --units <a,b,c>       只跑指定审核单元（调试用）
  --run-dir <path>      中间产物目录
  --dry-run             只打印流水线计划，不调用 API

审核单元：
${UNITS.map(u => `  ${u.key.padEnd(18)} ${u.title}`).join('\n')}
`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.report) { usage(); process.exit(args.help ? 0 : 1); }
  if (!fs.existsSync(args.report)) throw new Error(`报告不存在: ${args.report}`);

  const reportText = fs.readFileSync(args.report, 'utf8');
  const reportName = path.basename(args.report, path.extname(args.report));
  const units = args.units ? UNITS.filter(u => args.units.includes(u.key)) : UNITS;

  console.log('═══ 审核工作台 · 分阶段流水线 ═══');
  console.log(`技能目录 : ${SKILL_DIR}`);
  console.log(`报告     : ${args.report}`);
  console.log(`报告规模 : ${reportText.length.toLocaleString()} 字符 ≈ ${estimateTokens(reportText).toLocaleString()} tok`);
  console.log(`模型     : ${MODELS[args.model] || args.model}`);
  console.log(`流水线   : S1 结构化 → S2 ×${units.length} 单元 → S3 规则 → S4 分级 → S5 成文`);
  console.log(`           （共约 ${2 + units.length} 次 API 调用）\n`);

  if (args.dryRun) { console.log('(--dry-run，未调用 API)'); return; }

  const runDir = args.runDir || path.join(__dirname, '..', 'runs', `${reportName}_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
  const apiKey = getApiKey();

  const t0 = Date.now();
  const result = await runPipeline({
    apiKey, model: MODELS[args.model] || args.model,
    reportText, reportName, runDir, onlyUnits: args.units,
  });
  const elapsed = (Date.now() - t0) / 1000;

  const outPath = args.out || path.join(runDir, `${reportName}_审核意见书.html`);
  const header = [
    '<!-- 由「工程咨询成果审核工作台」分阶段流水线生成 -->',
    `<!-- 模型 ${MODELS[args.model]} | 输入 ${result.usage.prompt} tok（缓存命中 ${result.usage.cacheHit || 0}）| 输出 ${result.usage.completion} tok | 耗时 ${elapsed.toFixed(1)}s -->`,
    `<!-- P0 ${result.graded.stats.p0Count} 项 / P1 ${result.graded.stats.p1Count} 项 / P2 ${result.graded.stats.p2Count} 项 / P3 ${result.graded.stats.p3Count} 项 -->`,
  ].join('\n');

  // HTML 为主格式（代码生成，样式可控）；同时落一份叙述 md 便于查看
  const reportMeta = { id: path.basename(runDir), sourceName: reportName, templateName: '投资项目后评价报告', ownerName: 'CLI', createdAt: new Date().toISOString() };
  fs.writeFileSync(outPath, header + '\n' + renderHtmlReport({
    task: reportMeta, graded: result.graded, narrative: result.narrative,
    deepAccess: true, model: MODELS[args.model],
  }), 'utf8');
  fs.writeFileSync(path.join(runDir, 'narrative.md'), result.narrative || '', 'utf8');

  const summary = {
    report: args.report, reportName, model: MODELS[args.model],
    elapsedSeconds: Number(elapsed.toFixed(1)),
    usage: result.usage,
    stats: result.graded.stats,
    units: result.unitResults.map(u => ({ unit: u.unit, issues: u.issues.length, error: u.error || null, seconds: u.meta?.seconds })),
    output: outPath, runDir,
  };
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  console.log('\n═══ 结果 ═══');
  console.log(`P0 ${result.graded.stats.p0Count} 项（原始 ${result.graded.stats.totalRaw} 条，去重后 ${result.graded.stats.afterDedup} 条）`);
  console.log(`P1 ${result.graded.stats.p1Count} / P2 ${result.graded.stats.p2Count} / P3 ${result.graded.stats.p3Count}`);
  console.log(`token: 输入 ${result.usage.prompt.toLocaleString()}  输出 ${result.usage.completion.toLocaleString()}`);
  console.log(`耗时 ${elapsed.toFixed(1)}s`);
  console.log(`\n意见书: ${outPath}`);
  console.log(`中间产物: ${runDir}`);

  if (result.graded.p0.length) {
    console.log('\n═══ P0 速览 ═══');
    result.graded.p0.forEach((g, i) => console.log(`${i + 1}. [${g.whitelist || '-'}][${g.category}] ${g.description.slice(0, 70)}`));
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
