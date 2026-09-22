#!/usr/bin/env node
/**
 * 技能同步工具 —— 把 WorkBuddy 原件里「你的训练成果」同步到工作区副本
 *
 * 背景（用户定的规矩）：
 *   · WorkBuddy 原件     = 你持续训练的专家，**不修改**
 *   · 工作区副本         = 本系统的知识内核，可被本系统增补
 *   · 审核知识 写进副本 SKILL.md；工程实现 留在 engine/*.mjs
 *   · 本工具负责「定期读取学习变化」：检测原件改了什么，并可合并到副本
 *
 * 用法：
 *   node sync-skill.mjs            只检查，报告原件有哪些变化（不改任何文件）
 *   node sync-skill.mjs --diff     额外显示变化的逐行内容
 *   node sync-skill.mjs --apply    以原件为基础重建副本，并保留 WB-ADD 块
 *
 * 合并规则：
 *   副本 = 原件（当前） + 从副本提取的、被
 *          <!-- ==== WB-ADD:START ==== --> ... <!-- ==== WB-ADD:END ==== -->
 *          包裹的块。这样"你的训练"与"本系统的增补"永不互相覆盖。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const ORIG = process.env.SKILL_ORIG
  || '';
export const COPY = process.env.SKILL_COPY
  || path.join(ROOT, 'skill', 'petroleum-engineering-review');
export const BASELINE = path.join(ROOT, 'skill', '.sync', 'baseline');

/** 副本新增内容的插入锚点：插在这个二级标题之前 */
const ANCHOR = '## 审核工作流程';
const ADD_RE = /<!--\s*====\s*WB-ADD:START[\s\S]*?<!--\s*====\s*WB-ADD:END\s*====\s*-->/g;

// ─────────────── 工具 ───────────────

const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => fs.existsSync(p);

function listFiles(dir, base = dir) {
  if (!exists(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return out.sort();
}

function snapshot(srcDir, destDir) {
  fs.rmSync(destDir, { recursive: true, force: true });
  for (const rel of listFiles(srcDir)) {
    const d = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.copyFileSync(path.join(srcDir, rel), d);
  }
}

/** 提取副本里所有 WB-ADD 块 */
function extractAdditions(text) {
  return (text.match(ADD_RE) || []).map(s => s.trim());
}

/** 把 WB-ADD 块插进以原件为基础的新文本 */
function insertAdditions(baseText, blocks) {
  if (!blocks.length) return baseText;
  const joined = blocks.join('\n\n');
  const i = baseText.indexOf(ANCHOR);
  if (i >= 0) return baseText.slice(0, i) + joined + '\n\n' + baseText.slice(i);
  return baseText.replace(/\s*$/, '') + '\n\n' + joined + '\n';
}

/** 粗粒度逐行差异统计 */
function diffStat(aText, bText) {
  const a = aText.split(/\r?\n/), b = bText.split(/\r?\n/);
  const setA = new Set(a), setB = new Set(b);
  const added = b.filter(l => l.trim() && !setA.has(l));
  const removed = a.filter(l => l.trim() && !setB.has(l));
  return { added, removed };
}

// ─────────────── 主逻辑 ───────────────

function check({ showDiff }) {
  if (!exists(ORIG)) { console.error(`❌ 找不到 WorkBuddy 原件：${ORIG}`); process.exit(1); }
  if (!exists(BASELINE)) {
    console.log('（首次运行，尚无基线快照）');
    console.log(`   执行 node sync-skill.mjs --apply 可建立基线并把原件同步到副本\n`);
  }

  const origFiles = listFiles(ORIG);
  const baseFiles = listFiles(BASELINE);

  const added = origFiles.filter(f => !baseFiles.includes(f));
  const removed = origFiles.length && baseFiles.filter(f => !origFiles.includes(f));
  const changed = [];
  for (const f of origFiles) {
    if (!baseFiles.includes(f)) continue;
    const a = read(path.join(BASELINE, f)), b = read(path.join(ORIG, f));
    if (a !== b) changed.push(f);
  }

  console.log('═══ WorkBuddy 原件 vs 上次同步基线 ═══');
  console.log(`  原件文件数 : ${origFiles.length}`);
  console.log(`  基线文件数 : ${baseFiles.length}`);
  if (!added.length && !removed.length && !changed.length && exists(BASELINE)) {
    console.log('  ✅ 没有检测到你的新训练内容（原件与基线一致）');
  } else {
    if (added.length) { console.log(`  🆕 新增文件 ${added.length} 个：`); added.forEach(f => console.log(`       + ${f}`)); }
    if (removed.length) { console.log(`  🗑  删除文件 ${removed.length} 个：`); removed.forEach(f => console.log(`       - ${f}`)); }
    if (changed.length) {
      console.log(`  ✏️  修改文件 ${changed.length} 个：`);
      for (const f of changed) {
        const d = diffStat(read(path.join(BASELINE, f)), read(path.join(ORIG, f)));
        console.log(`       ~ ${f}   +${d.added.length} 行 / -${d.removed.length} 行`);
        if (showDiff) {
          d.removed.slice(0, 15).forEach(l => console.log(`           - ${l.slice(0, 110)}`));
          d.added.slice(0, 25).forEach(l => console.log(`           + ${l.slice(0, 110)}`));
          if (d.added.length > 25) console.log(`           …（还有 ${d.added.length - 25} 行新增）`);
        }
      }
    }
  }

  // 副本侧：确认本系统的增补块还在
  const copySkill = path.join(COPY, 'SKILL.md');
  const blocks = exists(copySkill) ? extractAdditions(read(copySkill)) : [];
  console.log('\n═══ 工作区副本 ═══');
  console.log(`  WB-ADD 增补块 : ${blocks.length} 个 ${blocks.length ? '✅' : '⚠️ 一个都没有（可能被覆盖了）'}`);
  blocks.forEach((b, i) => {
    const name = (b.match(/name="([^"]+)"/) || [, '(未命名)'])[1];
    const lines = b.split('\n').length;
    console.log(`     ${i + 1}. ${name}  （${lines} 行）`);
  });
  console.log(`  副本 SKILL.md : ${exists(copySkill) ? read(copySkill).split('\n').length + ' 行' : '缺失'}`);

  return { added, removed, changed };
}

function apply() {
  if (!exists(ORIG)) { console.error(`❌ 找不到 WorkBuddy 原件：${ORIG}`); process.exit(1); }
  console.log('═══ 以原件为基础重建副本（保留 WB-ADD 增补块）═══');

  const copySkill = path.join(COPY, 'SKILL.md');
  const blocks = exists(copySkill) ? extractAdditions(read(copySkill)) : [];
  console.log(`  从现有副本提取到 ${blocks.length} 个 WB-ADD 块`);
  blocks.forEach(b => console.log(`     · ${(b.match(/name="([^"]+)"/) || [, '(未命名)'])[1]}`));

  // 1) references / scripts 等附件：原件覆盖（副本不改这些）
  for (const rel of listFiles(ORIG)) {
    if (rel === 'SKILL.md') continue;
    const d = path.join(COPY, rel);
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.copyFileSync(path.join(ORIG, rel), d);
  }
  const origAux = listFiles(ORIG).filter(f => f !== 'SKILL.md').length;
  console.log(`  ✅ 附件同步 ${origAux} 个（references / scripts）`);

  // 2) SKILL.md：原件为基 + 重新插入增补块
  const merged = insertAdditions(read(path.join(ORIG, 'SKILL.md')), blocks);
  fs.mkdirSync(COPY, { recursive: true });
  fs.writeFileSync(copySkill, merged, 'utf8');
  console.log(`  ✅ SKILL.md 重建：${read(path.join(ORIG, 'SKILL.md')).split('\n').length} 行（原件） + ${blocks.length} 块增补 = ${merged.split('\n').length} 行`);

  // 3) 更新基线
  snapshot(ORIG, BASELINE);
  console.log(`  ✅ 基线已更新：${BASELINE}`);
  console.log('\n下次你改完 WorkBuddy 原件，运行：');
  console.log('  node engine/sync-skill.mjs          查看你改了什么');
  console.log('  node engine/sync-skill.mjs --apply  合并到副本');
}

// ─────────────── CLI ───────────────
const argv = process.argv.slice(2);
if (argv.includes('--apply')) apply();
else check({ showDiff: argv.includes('--diff') });
