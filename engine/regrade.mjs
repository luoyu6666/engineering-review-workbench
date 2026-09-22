#!/usr/bin/env node
/**
 * 离线重算工具 — 从已保存的中间产物重跑 S3 规则校验 + S4 分级闸门
 *
 * 用途：分级逻辑（白名单、去重、聚类上限）需要反复调，
 *       但 S1/S2 要花 API 钱和时间。本工具零成本重算 S3/S4。
 *
 * 用法：
 *   node regrade.mjs --run <runDir>            重算并打印 P0 清单
 *   node regrade.mjs --run <runDir> --render   额外调用 S5 重新成文
 *   node regrade.mjs --run <runDir> --diff     与上次 s4_graded.json 对比
 */

import fs from 'node:fs';
import path from 'node:path';
import { getApiKey, MODELS } from './lib/core.mjs';
import { stage3Rules, stage4Grade, stage5Render, renderAppendix } from './lib/pipeline.mjs';

function parseArgs(argv) {
  const a = { model: 'flash' };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--run') { a.run = v; i++; }
    else if (k === '--render') a.render = true;
    else if (k === '--diff') a.diff = true;
    else if (k === '--out') { a.out = v; i++; }
    else if (k === '--model') { a.model = v; i++; }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.run) { console.log('用法: node regrade.mjs --run <runDir> [--render] [--diff]'); process.exit(1); }
  const runDir = args.run;
  const read = f => JSON.parse(fs.readFileSync(path.join(runDir, f), 'utf8'));

  const facts = read('s1_facts.json');
  const unitResults = read('s2_issues.json');

  const log = (...a) => console.log(...a);
  const ruleIssues = stage3Rules({ facts, log });
  const graded = stage4Grade({ unitResults, ruleIssues, log });

  if (args.diff && fs.existsSync(path.join(runDir, 's4_graded.json'))) {
    const prev = read('s4_graded.json');
    console.log(`\n与上次对比： P0 ${prev.stats.p0Count} → ${graded.stats.p0Count}   P1 ${prev.stats.p1Count} → ${graded.stats.p1Count}`);
  }

  fs.writeFileSync(path.join(runDir, 's3_rules.json'), JSON.stringify(ruleIssues, null, 2), 'utf8');
  fs.writeFileSync(path.join(runDir, 's4_graded.json'), JSON.stringify(graded, null, 2), 'utf8');

  console.log(`\n═══ P0 ${graded.stats.p0Count} 项（原始 ${graded.stats.p0BeforeCap} 条）═══`);
  graded.p0.forEach((g, i) => {
    console.log(`${i + 1}. [${g.whitelist}][${g.category}]${g.mergedCount > 1 ? `（合并${g.mergedCount}项）` : ''} ${g.description.slice(0, 90)}`);
  });
  console.log(`\nP1 ${graded.stats.p1Count} / P2 ${graded.stats.p2Count} / P3 ${graded.stats.p3Count}`);

  if (graded.stats.p1Count) {
    const byCat = {};
    for (const g of graded.p1) byCat[g.category] = (byCat[g.category] || 0) + 1;
    console.log('P1 分类分布：' + Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join('  '));
  }

  if (args.render) {
    const reportName = path.basename(runDir).replace(/_\d{4}-\d{2}-\d{2}T.*$/, '');
    log('\n─── S5 重新成文 ───');
    const r = await stage5Render({
      apiKey: getApiKey(), model: MODELS[args.model] || args.model,
      graded, facts, reportName, log,
    });
    const out = args.out || path.join(runDir, `${reportName}_审核意见书_v2.md`);
    fs.writeFileSync(out, r.content + renderAppendix(graded), 'utf8');
    console.log(`\n✅ ${out}  （正文 ${r.content.length} 字符 + 代码生成附录）`);
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
