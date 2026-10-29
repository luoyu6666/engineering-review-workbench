// 验证容差逻辑（从 pipeline 源码里原样提取测试，确保测的是实际实现）
import fs from 'node:fs';

const src = fs.readFileSync('D:/Deepseek harness工作区/生活其他/审核工作台/engine/lib/pipeline.mjs', 'utf8');

// 提取实际实现的三个函数
const grab = (name) => {
  const i = src.indexOf(`const ${name} = `);
  if (i < 0) throw new Error('找不到 ' + name);
  let d = 0, j = src.indexOf('=>', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  throw new Error('括号不配对: ' + name);
};

const code = [grab('decimals'), grab('numOf'), grab('sameAfterRounding')].join('\n');
const { sameAfterRounding } = await import(`data:text/javascript,${encodeURIComponent(code + '\nexport { sameAfterRounding };')}`);

const cases = [
  ['19224.75', '19224.8', true, '纯四舍五入（相对差 0.000%）'],
  ['2665.91', '2665.9', true, '纯四舍五入'],
  ['42.7', '42.68', true, '同一数的不同精度'],
  ['9.55', '9.58', false, '真差异（0.3%，非舍入）'],
  ['42.575', '42.678', false, '真差异（0.24%）'],
  ['42.58', '42.7', false, '真差异（0.28%）'],
  ['1000', '1000.00', true, '整数 vs 两位小数'],
  ['19224.75', '19225', true, '取整'],
  ['"三套口径"', '19224.8', false, '非数值不参与'],
];

let pass = 0, fail = 0;
for (const [a, b, want, note] of cases) {
  const got = sameAfterRounding(a, b);
  const okk = got === want;
  okk ? pass++ : fail++;
  console.log(`  ${okk ? '✓' : '✗'} ${String(a).padEnd(11)} vs ${String(b).padEnd(10)} → ${got ? '同一数（不报）' : '不同（报）'}   ${note}`);
}
console.log(`\n  通过 ${pass}，失败 ${fail}`);
