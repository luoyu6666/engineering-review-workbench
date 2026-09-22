#!/usr/bin/env node
/**
 * 从已保存的 run 目录重新生成 HTML 意见书 —— **零 API 调用**
 *
 * 用途：调整报告样式 / 权限过滤 / 分类规则时，不必重跑审核（那要 9 次 API、3 分钟）。
 *
 * 用法：
 *   node render-report.mjs --run <runDir>                    生成两份（含深度类 / 仅校对类）
 *   node render-report.mjs --run <runDir> --deep --out x.html
 *   node render-report.mjs --run <runDir> --narrative s5.md  用指定文件作为叙述部分
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderHtmlReport, PROOFREAD_CATEGORIES, classify } from './lib/report-html.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const a = { deep: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--run') { a.run = v; i++; }
    else if (k === '--out') { a.out = v; i++; }
    else if (k === '--narrative') { a.narrative = v; i++; }
    else if (k === '--deep') a.deep = true;
    else if (k === '--proofread') a.deep = false;
    else if (k === '--stats') a.stats = true;
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.run) { console.log('用法: node render-report.mjs --run <runDir> [--deep|--proofread] [--out x.html]'); process.exit(1); }

  const g = JSON.parse(fs.readFileSync(path.join(args.run, 's4_graded.json'), 'utf8'));

  // 叙述部分（S5 产出）可能在 run 目录或其父目录（任务目录）
  let narrative = '';
  if (args.narrative && fs.existsSync(args.narrative)) {
    narrative = fs.readFileSync(args.narrative, 'utf8');
  } else {
    for (const cand of [path.join(args.run, 'narrative.md'), path.join(args.run, '..', 'narrative.md')]) {
      if (fs.existsSync(cand)) { narrative = fs.readFileSync(cand, 'utf8'); break; }
    }
  }
  if (narrative) console.log(`  已带入叙述部分 ${narrative.length} 字符（总体评价/综合结论/路线图/建议）`);

  // 分类统计
  const all = [...(g.p0 || []), ...(g.p1 || []), ...(g.p2 || []), ...(g.p3 || [])];
  const pf = all.filter(x => classify(x) === 'proofread').length;
  console.log('═══ 问题分类 ═══');
  console.log(`  总计 ${all.length} 项：校对类 ${pf} 项 / 深度类 ${all.length - pf} 项`);
  if (args.stats) {
    const byCat = {};
    for (const x of all) { const k = `${x.category}[${classify(x)}]`; byCat[k] = (byCat[k] || 0) + 1; }
    Object.entries(byCat).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`    ${k}  ×${v}`));
    console.log(`  校对类类别集合：${[...PROOFREAD_CATEGORIES].join('、')}`);
    return;
  }

  // 任务元信息：优先读同目录的 meta.json（真实任务），读不到才用占位信息。
  // 早先用占位信息重建，导致页面上的"受审报告/提交人"变成 run 目录名，检索和归档都对不上。
  const runAbs = path.resolve(args.run);
  const baseDir = path.basename(runAbs) === 'run' ? path.dirname(runAbs) : runAbs;
  let task = {
    id: path.basename(runAbs),
    sourceName: path.basename(runAbs).replace(/_\d{4}-\d{2}-\d{2}T.*$/, '') + '（从 run 重建）',
    templateName: '投资项目后评价报告',
    ownerName: '—', createdAt: '',
  };
  const metaPath = path.join(baseDir, 'meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      task = {
        id: m.id, sourceName: m.sourceName, templateName: m.templateName || task.templateName,
        ownerName: m.ownerName, createdAt: m.createdAt,
        bizType: m.bizType, projectName: m.projectName, projectCode: m.projectCode, projectType: m.projectType,
      };
      console.log(`  已带入真实任务信息：${task.sourceName}（${task.ownerName || '—'}）`);
    } catch (e) {
      console.log(`  ⚠ meta.json 读取失败，改用占位信息：${e.message}`);
    }
  }

  const targets = args.deep === null ? [true, false] : [args.deep];
  for (const deep of targets) {
    const html = renderHtmlReport({ task, graded: g, narrative, deepAccess: deep, model: 'deepseek-flash' });
    // 文件名必须与服务端读取的一致：校对版 report.html，审核成果 report.deep.html
    // 默认写到「任务目录」——与 server.mjs 里 runTask 的落盘位置保持一致
    // （服务端从 web/data/tasks/<id>/report.html 读取并下发，不是 run 子目录）
    const out = args.out
      ? (targets.length === 1 ? args.out : args.out.replace(/\.html$/, deep ? '.deep.html' : '.html'))
      : path.join(baseDir, deep ? 'report.deep.html' : 'report.html');
    fs.writeFileSync(out, html, 'utf8');
    console.log(`  ${(deep ? '审核成果（含深度类）' : '校对成果（仅校对类）').padEnd(20)} → ${out}  （${(html.length / 1024).toFixed(1)} KB）`);
  }
}

main();
