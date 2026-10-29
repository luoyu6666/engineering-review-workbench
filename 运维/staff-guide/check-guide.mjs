/**
 * 《操作说明》PDF 排版守门：检查有没有页面超出一页 A4。
 *
 * 用途：纸张排版最常见的问题是某页内容偏多、打印时被拆成两页；
 * 该 PDF 由 Chrome 打印生成，若不检查只能人工逐页翻看。
 * 这里量的是每个 .page 元素的实际渲染高度：A4 纵向 297mm ≈ 1123px（96dpi），
 * 超过即溢出（会多出一张几乎空白的页）。
 *
 * 用法：node 运维\staff-guide\check-guide.mjs
 *   退出码 0 = 全部合格；1 = 有页溢出（查看是哪一页，把文字压短或减小图片高度）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '../..');
const HTML = path.join(ROOT, '操作说明.html');
const A4_PX = 1123;                       // 297mm @96dpi

if (!fs.existsSync(HTML)) { console.error('还没生成 HTML，先跑 make-guide.mjs'); process.exit(1); }

// 让 运维/screenshot.cjs 顺便把每页高度量出来（复用现成的 CDP 工具，不重复实现）
const htmlPages = (fs.readFileSync(HTML, 'utf8').match(/class="page/g) || []).length;
const rects = {};
for (let i = 0; i < htmlPages; i++) rects['p' + (i + 1)] = `document.querySelectorAll('.page')[${i}]`;
const cfg = path.join(os.tmpdir(), 'guide-check.json');
fs.writeFileSync(cfg, JSON.stringify([{
  name: 'guide-check', w: 794, h: A4_PX, noAuth: true,
  url: 'file:///' + HTML.replace(/\\/g, '/').replace(/ /g, '%20'),
  rects,
}], null, 2), 'utf8');

const outDir = path.join(os.tmpdir(), 'guide-check');
await pexec(process.execPath, [path.join(ROOT, '运维/screenshot.cjs'), outDir, cfg],
  { timeout: 180000, windowsHide: true, cwd: ROOT });

const got = JSON.parse(fs.readFileSync(path.join(outDir, 'guide-check.rects.json'), 'utf8'));
let bad = 0;
console.log(`页面数 ${htmlPages}　A4 高度 ${A4_PX}px（297mm）`);
for (let i = 1; i <= htmlPages; i++) {
  const r = got['p' + i];
  const h = r ? r.h : 0;
  if (!r) { console.log(`  第 ${i} 页 ⚠️ 没量到`); bad++; continue; }
  if (h > A4_PX) { console.log(`  第 ${i} 页 ${h}px ❌ 溢出 ${h - A4_PX}px（会被拆成两页）`); bad++; }
  else console.log(`  第 ${i} 页 ${h}px ✓ 余量 ${A4_PX - h}px`);
}
console.log(bad ? `❌ 有 ${bad} 页不合格` : '✅ 全部合格：每页都恰好一页 A4');
process.exit(bad ? 1 : 0);
