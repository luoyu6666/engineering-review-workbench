// runPipeline 接线：接收 chartImages，追加 CHART_UNIT，并传给 stage2Units
import fs from 'node:fs';

const F = 'D:/Deepseek harness工作区/生活其他/审核工作台/engine/lib/pipeline.mjs';
let c = fs.readFileSync(F, 'utf8');
const step = [];
const sub = (a, b, label) => {
  if (!c.includes(a)) { console.log(`  x 未命中: ${label}`); return false; }
  c = c.replace(a, b); step.push(label); return true;
};

// ① runPipeline 签名
sub(
  "pptText = '', pptName = '', crossCheck = false, pptOnly = false }) {",
  "pptText = '', pptName = '', crossCheck = false, pptOnly = false, chartImages = null }) {",
  'runPipeline 签名加 chartImages',
);

// ② 单元列表：追加 CHART_UNIT
sub(
  `    log(\`检测到配对的汇报 PPT（\${pptName || '未命名'}）：追加 \${crossCheck ? '2' : '1'} 个 PPT 相关审核单元\`);
  }`,
  `    log(\`检测到配对的汇报 PPT（\${pptName || '未命名'}）：追加 \${crossCheck ? '2' : '1'} 个 PPT 相关审核单元\`);
  }
  // 「图表核对」默认关，只有提交时勾选才跑（图片按 token 计费，不该默认背上）
  if (chartImages && chartImages.length && !onlyUnits) {
    unitList = [...unitList, CHART_UNIT];
    log(\`已开启「图表核对」：随本次请求附上 \${chartImages.length} 张图片（约 \${(chartImages.length * 1024).toLocaleString()} tok 上限）\`);
  }`,
  '单元列表追加 CHART_UNIT',
);

// ③ 传给 stage2Units —— 找到实际调用处
const m = c.match(/await stage2Units\(\{[\s\S]{0,400}?\}\)/);
if (m) {
  const orig = m[0];
  const patched = orig.replace(/(\n\s*)(\}\)$)/, "$1  images: chartImages,$1$2");
  c = c.replace(orig, patched);
  step.push('stage2Units 传 images');
  console.log('    调用处片段: ' + orig.replace(/\s+/g, ' ').slice(0, 140));
} else {
  console.log('  x 没找到 stage2Units 调用处');
}

console.log(`完成 ${step.length} 步：`);
for (const s of step) console.log('    ' + s);
fs.writeFileSync(F, c, 'utf8');
