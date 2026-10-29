// WARN: 本脚本调用真实 API，会产生费用（单次约 ¥0.01–0.03）。仅用于验证图片通路是否正常。
// 用途：测量图片实际消耗的 token（同一段文字分别配 0 / 1 / 3 张图，比较 prompt token）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as L from '../web/lib.mjs';
import { callDeepSeek, getApiKey } from './lib/core.mjs';

const base = 'D:/Deepseek harness工作区/生活其他/审核工作台';
const tasksDir = base + '/web/data/tasks';
let target = null;
for (const d of fs.readdirSync(tasksDir)) {
  const p = path.join(tasksDir, d);
  if (!fs.statSync(p).isDirectory()) continue;
  for (const f of fs.readdirSync(p)) {
    if (/\.docx$/i.test(f) && !/^\~\$/.test(f) && fs.statSync(path.join(p, f)).size > 1e6) { target = path.join(p, f); break; }
  }
  if (target) break;
}
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tok-'));
const r = L.extractOoxmlImages(target, out);
const key = getApiKey();

const TEXT = '只回答一个词：你看到了什么？';

async function measure(imgs, detail) {
  const use = imgs.map(i => ({ ...i, detail }));
  const res = await callDeepSeek({
    apiKey: key, model: 'deepseek-flash',
    system: '极简回答，不超过10个字。',
    user: TEXT + (use.length ? `（附 ${use.length} 张图）` : ''),
    images: use.length ? use : null,
    maxTokens: 100, temperature: 0, retries: 1,
  });
  return res.usage.prompt;
}

// 挑尺寸差异明显的三张
const sorted = [...r.images].sort((a, b) => b.bytes - a.bytes);
const big = sorted.slice(0, 3);

console.log('════════ 实测 token ════════\n');
const p0 = await measure([], 'high');
console.log(`  纯文字（无图）              prompt = ${p0}`);
await new Promise(s => setTimeout(s, 800));

const p1 = await measure([big[0]], 'high');
console.log(`  + 1 张大图 (${(big[0].bytes / 1024).toFixed(0)} KB)     prompt = ${p1}   → 图约占 ${p1 - p0}`);
await new Promise(s => setTimeout(s, 800));

const p3 = await measure(big, 'high');
console.log(`  + 3 张大图                  prompt = ${p3}   → 图约占 ${p3 - p0}，平均 ${Math.round((p3 - p0) / 3)}/张`);
await new Promise(s => setTimeout(s, 800));

const p3low = await measure(big, 'low');
console.log(`  + 3 张大图（detail=low）    prompt = ${p3low}   → 图约占 ${p3low - p0}，平均 ${Math.round((p3low - p0) / 3)}/张`);

console.log('\n════════ 结论 ════════');
const perHigh = (p3 - p0) / 3;
const perLow = (p3low - p0) / 3;
console.log(`  实测每张图约 ${Math.round(perHigh)} token（high）`);
console.log(`  官方文档写明上限 1024 token/张（超过 1300×1300 的图统一按上限计）`);
console.log(`  文档早期新闻稿写的是 384，**以后来的指南为准**`);
console.log('');
const n = r.total;
console.log(`  按 ${n} 张图估算（这份报告）：`);
console.log(`    high : ${(n * Math.round(perHigh)).toLocaleString()} tok  ≈ ¥${(n * Math.round(perHigh) / 1e6 * (L.isPeakHour() ? 2 : 1)).toFixed(3)}（${L.isPeakHour() ? '高峰' : '闲时'}）`);
console.log(`    low  : ${(n * Math.round(perLow)).toLocaleString()} tok  ≈ ¥${(n * Math.round(perLow) / 1e6 * (L.isPeakHour() ? 2 : 1)).toFixed(3)}`);
console.log(`    按文档上限 1024 保守估：${(n * 1024).toLocaleString()} tok ≈ ¥${(n * 1024 / 1e6 * (L.isPeakHour() ? 2 : 1)).toFixed(3)}`);

fs.rmSync(out, { recursive: true, force: true });
