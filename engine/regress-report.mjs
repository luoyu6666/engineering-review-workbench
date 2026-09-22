#!/usr/bin/env node
/**
 * 回归质量报告 —— 用「审核批次概览」里各项目的人工 P0 主题做基准，
 * 对照流水线实际产出，统计：进入 P0 / 被降级 / 完全漏报 / 我们多报
 *
 * 基准来源：`审核批次概览_湖北公司2026第一批5个项目.md` 第三节
 *   项目1：6项（口径混用/前后矛盾/工程量多口径/问题章仅2条/建议缺失7类/编校）
 *   项目2：5项（竣工验收矛盾/口径冲突/投产年份/规划许可数据不实/多计款不闭合）
 *   项目3：3项（建议缺失/环保验收时间矛盾/结论偏宽）
 *   项目4：3项（PDF内部投资三套口径/结论偏宽/勘察深度未评）
 *   项目5：3项（无报告文本，无法回归）
 *
 * 用法：node regress-report.mjs [--runs <runsDir>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RUNS = process.env.RUNS_DIR || path.join(ROOT, 'runs');

/** 人工基准：项目 → { runPrefix, count, themes: [{name, re}] } */
const TRUTH = {
  '项目1 武信管道孝感长兴三路段': {
    runPrefix: '_p1_', count: 6,
    themes: [
      { name: '口径混用（含税/不含税基准不一）', re: /含税|不含税|口径.*(混用|不一)|基准不一/ },
      { name: '前后矛盾', re: /前后矛盾|自相矛盾|结论.{0,8}矛盾|与.{0,10}矛盾/ },
      { name: '工程量多口径', re: /工程量.{0,10}(口径|不一致|多套|多个值)/ },
      { name: '问题章仅2条', re: /存在的问题.{0,12}(仅|只有|2条|两条)|问题.{0,6}过少|遗漏.{0,6}问题/ },
      { name: '建议缺失7类', re: /建议.{0,10}(缺失|不完整|7类|未覆盖|不足)/ },
      { name: '编校错误', re: /编校|错别字|病句|笔误/ },
    ],
  },
  '项目2 荆州文旅区输气管道改线': {
    runPrefix: '_pdf2_', count: 5,
    themes: [
      { name: '竣工验收矛盾', re: /竣工验收/ },
      { name: '口径冲突', re: /口径/ },
      { name: '投产年份错误', re: /投产年份|投产.{0,6}年份|年份.{0,4}(误|错)/ },
      { name: '规划许可数据不实', re: /规划许可|选址/ },
      { name: '多计款不闭合', re: /多计|不闭合|勾稽|闭合/ },
    ],
  },
  '项目3 洪荆线钟荆线与麻城工业园': {
    runPrefix: 'report_3_', count: 3,
    themes: [
      { name: '建议缺失（8.6章缺）', re: /对策及建议|8\.6|建议.{0,8}(章节|缺失)/ },
      { name: '环保验收时间矛盾', re: /环保.{0,10}验收.{0,20}(时间|矛盾|不一)|竣工.{0,4}环保.{0,4}验收/ },
      { name: '建设程序定性偏宽', re: /基本符合|未逾越程序|决策程序规范|结论偏宽/ },
    ],
  },
  '项目4 忠武线荆襄支线尹集段': {
    runPrefix: 'report_4_', count: 3,
    themes: [
      { name: '投资三套口径', re: /三套口径|口径.{0,8}(混用|不一)|建设投资.{0,10}(口径|万元)/ },
      { name: '结论偏宽', re: /基本符合|未逾越程序|结论偏宽|定性偏宽/ },
      { name: '勘察深度未评', re: /勘察|踏勘|地质.{0,6}深度/ },
    ],
  },
  '项目5 洪荆线南林三跨': {
    runPrefix: null, count: 3,
    themes: [
      { name: '投产年份笔误', re: /投产年份/ },
      { name: '工程费超支掩盖', re: /工程费.{0,8}超支|超支.{0,8}掩盖/ },
      { name: '文号空缺+结论矛盾', re: /文号|结论.{0,4}矛盾/ },
    ],
  },
};

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/** 找该项目最新且完整的 run 目录 */
function findRun(prefix) {
  if (!prefix || !fs.existsSync(RUNS)) return null;
  const dirs = fs.readdirSync(RUNS).filter(d => d.startsWith(prefix))
    .map(d => ({ d, p: path.join(RUNS, d), t: fs.statSync(path.join(RUNS, d)).mtimeMs }))
    .filter(x => fs.existsSync(path.join(x.p, 's4_graded.json')))
    .sort((a, b) => b.t - a.t);
  return dirs[0] || null;
}

/** 把 P0（含 subItems）/P1/P2 摊平成可检索列表 */
function flatten(g) {
  const out = [];
  for (const it of g.p0 || []) {
    const sub = (it.subItems || []).map(s => `${s.description} ${s.quote} ${s.location}`).join(' ');
    out.push({ sev: 'P0', text: `${it.description} ${it.quote} ${it.location} ${sub}` });
  }
  for (const [sev, key] of [['P1', 'p1'], ['P2', 'p2'], ['P3', 'p3']]) {
    for (const it of g[key] || []) out.push({ sev, text: `${it.description} ${it.quote} ${it.location}` });
  }
  return out;
}

function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  审核质量回归报告 —— 流水线 vs 人工审核（湖北公司第一批 5 个项目）');
  console.log('═══════════════════════════════════════════════════════════════\n');

  let totalTruth = 0, totalHitP0 = 0, totalHitAny = 0, totalOurP0 = 0;
  const rows = [];

  for (const [proj, cfg] of Object.entries(TRUTH)) {
    const run = findRun(cfg.runPrefix);
    if (!run) {
      console.log(`■ ${proj}`);
      console.log(`   人工 P0 ${cfg.count} 项 —— ⏸ 无可用 run（无报告文本或流水线未跑通）\n`);
      rows.push({ proj, truth: cfg.count, ours: '—', hit: '—', note: '无法回归' });
      continue;
    }
    const g = readJson(path.join(run.p, 's4_graded.json'));
    const flat = flatten(g);
    const ourP0 = (g.p0 || []).length;

    console.log(`■ ${proj}`);
    console.log(`   run: ${run.d}    人工 P0 ${cfg.count} 项 / 流水线 P0 ${ourP0} 项`);
    console.log('   ┌────────────────────────────────┬──────────┬────────────────────────┐');
    console.log('   │ 人工 P0 主题                   │ 落级     │ 判定                   │');
    console.log('   ├────────────────────────────────┼──────────┼────────────────────────┤');

    let hitP0 = 0, hitAny = 0;
    for (const th of cfg.themes) {
      const hits = flat.filter(x => th.re.test(x.text));
      const lv = [...new Set(hits.map(h => h.sev))].sort().join('/');
      if (hits.length) hitAny++;
      if (lv.includes('P0')) hitP0++;
      const verdict = lv.includes('P0') ? '✅ 进入 P0' : (lv ? '⚠️ 找到但降级' : '❌ 完全漏报');
      const nm = th.name.length > 28 ? th.name.slice(0, 27) + '…' : th.name;
      console.log(`   │ ${nm.padEnd(30)} │ ${(lv || '—').padEnd(8)} │ ${verdict.padEnd(22)} │`);
    }
    console.log('   └────────────────────────────────┴──────────┴────────────────────────┘');
    console.log(`   命中 P0 ${hitP0}/${cfg.count}   任意级别命中 ${hitAny}/${cfg.count}   我们多报 ${Math.max(0, ourP0 - hitP0)} 项\n`);

    totalTruth += cfg.count; totalHitP0 += hitP0; totalHitAny += hitAny; totalOurP0 += ourP0;
    rows.push({ proj, truth: cfg.count, ours: ourP0, hit: `${hitP0}/${cfg.count}`, note: '' });
  }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  汇总');
  console.log('═══════════════════════════════════════════════════════════════');
  for (const r of rows) {
    console.log(`  ${r.proj.padEnd(34)} 人工 ${String(r.truth).padStart(2)}  我们 ${String(r.ours).padStart(2)}  命中 ${r.hit}  ${r.note}`);
  }
  console.log('  ─────────────────────────────────────────────────────────────');
  if (totalTruth) {
    console.log(`  P0 命中率（进入 P0） : ${totalHitP0}/${totalTruth} = ${(totalHitP0 / totalTruth * 100).toFixed(0)}%`);
    console.log(`  召回率（任意级别）   : ${totalHitAny}/${totalTruth} = ${(totalHitAny / totalTruth * 100).toFixed(0)}%`);
  }
  console.log(`  流水线 P0 总量       : ${totalOurP0}（人工合计 ${totalTruth}）`);
  console.log('\n  说明：流水线报 P0 多于人工，不必然等于误报——人工交付口径偏收敛，');
  console.log('        部分"多报"项经抽查为人工漏掉的真问题（如 -414%、成功度评分无支撑）。');
}

main();
