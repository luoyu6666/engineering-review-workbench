#!/usr/bin/env node
/**
 * S1/S3 探针 —— 只跑「结构化抽取」+「规则校验」，不跑 S2/S5
 *
 * 用途：调抽取层（timeline / funding / crossSourceConflicts）和规则引擎时，
 *       完整流水线要 9 次 API 调用 ≈ 3 分钟；本工具只需 1 次 ≈ 30 秒。
 *
 * 用法：
 *   node probe-s1.mjs --report <报告文本>              # 抽取 + 规则，打印结果
 *   node probe-s1.mjs --report x.txt --json facts.json # 顺带把 facts 存下来
 *   node probe-s1.mjs --from <runDir>                  # 复用已有 run 的 s1_facts.json，只重跑规则（零 API）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getApiKey, MODELS, estimateTokens } from './lib/core.mjs';
import { stage1Structure, stage3Rules } from './lib/pipeline.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const a = { model: 'flash' };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--report') { a.report = v; i++; }
    else if (k === '--from') { a.from = v; i++; }
    else if (k === '--json') { a.json = v; i++; }
    else if (k === '--model') { a.model = v; i++; }
  }
  return a;
}

const log = (...a) => console.log(...a);

async function main() {
  const args = parseArgs(process.argv);
  if (!args.report && !args.from) {
    console.log('用法: node probe-s1.mjs --report <报告文本>  或  --from <runDir>');
    process.exit(1);
  }

  let facts;
  if (args.from) {
    facts = JSON.parse(fs.readFileSync(path.join(args.from, 's1_facts.json'), 'utf8'));
    log(`复用已有 facts：${args.from}\\s1_facts.json（零 API 调用）\n`);
  } else {
    const reportText = fs.readFileSync(args.report, 'utf8');
    log(`报告：${args.report}  ${reportText.length.toLocaleString()} 字符 ≈ ${estimateTokens(reportText).toLocaleString()} tok\n`);
    const r = await stage1Structure({
      apiKey: getApiKey(), model: MODELS[args.model] || args.model, reportText, log,
    });
    facts = r.facts;
    if (args.json) { fs.writeFileSync(args.json, JSON.stringify(facts, null, 2), 'utf8'); log(`factes 已存 ${args.json}`); }
  }

  const show = (title, arr, fmt) => {
    log(`\n═══ ${title}（${(arr || []).length} 条）═══`);
    (arr || []).forEach((x, i) => log(`  ${i + 1}. ${fmt(x)}`));
  };

  show('时间线 timeline', facts.timeline, t => `${t.date || '?'}  ${t.event || ''}${t.location ? '  @' + t.location : ''}`);
  show('跨源冲突 crossSourceConflicts', facts.crossSourceConflicts,
    c => `${c.item}：` + (c.values || []).map(v => `${v.value}(${v.location || '?'})`).join(' / ') + (c.impact ? `  影响:${c.impact}` : ''));
  show('资金类 funding', facts.funding,
    f => `${f.item} = ${f.value}${f.unit || ''}  已说明处置=${f.settlementExplained}  @${f.location || '?'}`);
  show('缺失章节 missingChapters', facts.missingChapters, x => String(x));

  log('\n═══ 规则引擎命中 ═══');
  const rules = stage3Rules({ facts, log });
  const byRule = {};
  for (const r of rules) {
    const tag = /跨源/.test(r.basis) ? 'R7 跨源一致性'
      : /资金|补偿|拨款/.test(r.basis) ? 'R6 资金类'
      : /时序|程序/.test(r.description) ? 'R2 时序倒置'
      : /偏差/.test(r.description) ? 'R1 投资偏差'
      : /章节|完整性/.test(r.description) ? 'R3/R4 缺章'
      : 'R5 多值';
    (byRule[tag] ||= []).push(r);
  }
  for (const [k, v] of Object.entries(byRule)) {
    log(`  ${k}：${v.length} 条`);
    v.slice(0, 6).forEach(r => log(`     - [${r.whitelist}] ${String(r.quote).slice(0, 90)}`));
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
