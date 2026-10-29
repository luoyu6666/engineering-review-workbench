// WARN: 本脚本调用真实 API，会产生费用（单次约 ¥0.01–0.03）。仅用于验证图片通路是否正常。
// 最小验证：图片能否真的送给模型，模型能否读出图上的内容。
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
    if (/\.docx$/i.test(f) && !/^\~\$/.test(f) && fs.statSync(path.join(p, f)).size > 1e6) {
      target = path.join(p, f); break;
    }
  }
  if (target) break;
}

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'chart-verify-'));
const r = L.extractOoxmlImages(target, out);
console.log(`抽出 ${r.total} 张图`);

// 挑体积较大的 3 张，更可能是图/表而不是图标或照片
const picked = [...r.images].sort((a, b) => b.bytes - a.bytes).slice(0, 3);
console.log('挑 3 张体积较大的：');
for (const i of picked) console.log(`  ${i.name}  ${(i.bytes / 1024).toFixed(0)} KB  ${i.mime}`);

const key = getApiKey();
if (!key) { console.log('没有 API Key'); process.exit(1); }

console.log('\n调用 deepseek-flash（带图片）…');
const t0 = Date.now();
try {
  const res = await callDeepSeek({
    apiKey: key,
    model: 'deepseek-flash',
    system: '你是工程报告审核助手。只描述你确实看到的内容，看不清就说看不清，不要猜。',
    user: [
      `下面附了 ${picked.length} 张图片，来自一份油田开发调整方案后评价报告，按顺序编号为 图1、图2、图3。`,
      '',
      '请逐张回答：1) 图类型（柱状图/折线图/饼图/构造图/井位图/示意图/照片/其他）；',
      '2) 若是数据图表，横纵轴各是什么、有没有第二坐标轴；',
      '3) 图上能读到的具体数值或关键标注（没有就写"无数字标注"）；4) 文字清晰度。',
      '',
      '严格按 JSON 输出：{"images":[{"n":1,"type":"","axes":"","values":"","readable":""}]}',
    ].join('\n'),
    images: picked,
    maxTokens: 4000,
    temperature: 0,
    jsonMode: true,
    retries: 2,
  });

  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n✓ 调用成功（${sec}s）`);
  console.log(`  token: prompt=${res.usage.prompt} completion=${res.usage.completion} 缓存命中=${res.usage.cacheHit}`);
  const cost = L.calcCost({
    model: 'deepseek-flash', promptTokens: res.usage.prompt,
    completionTokens: res.usage.completion, cacheHitTokens: res.usage.cacheHit, peak: L.isPeakHour(),
  });
  console.log(`  费用: ¥${Number(cost).toFixed(4)}`);
  console.log('\n模型读图结果：');
  console.log(res.content.slice(0, 1800));
} catch (e) {
  console.log(`\n✗ 调用失败: ${e.message}`);
}

fs.rmSync(out, { recursive: true, force: true });
