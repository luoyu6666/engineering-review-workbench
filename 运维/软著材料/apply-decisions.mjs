/** 一次性落实已定事项：① 首次发表地点＝河南省郑州市；② 办理方式＝委托代理机构。
 *  按行号替换并断言关键字，避免错位。 */
import fs from 'node:fs';

const fixByLine = (file, edits) => {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const [no, keyword, text] of edits) {
    const i = no - 1;
    if (!lines[i] || !lines[i].includes(keyword)) {
      console.error(`✗ ${file} 第 ${no} 行不含「${keyword}」，已中止：${(lines[i] || '').slice(0, 70)}`);
      process.exit(1);
    }
    lines[i] = text;
  }
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  console.log(`  ✓ ${file} 已更新 ${edits.length} 处`);
};

fixByLine('软著申报V1.0/01_申请表填写底稿.md', [
  [54, '首次发表地点', '| 首次发表地点 | 中国 河南省郑州市 |'],
  [263, '建议选择', '| 建议选择 | 代理人申请办理（委托代理机构办理）—— 著作权人 2026-09-28 决定 |'],
  [277, '建议填写', '| 建议填写 | 【待填：代理机构名称、代理人姓名、委托代理范围与权限、代理授权期限】 |'],
  [305, '首次发表地点是否精确到地级市', '| 4 | 首次发表地点是否精确到地级市 | **已确认：河南省郑州市**（著作权人确认） | 已完成 |'],
  [311, '是否委托代理机构', '| 10 | 是否委托代理机构 | **已确认：委托代理机构办理**；需补代理机构名称/代理人/授权期限，并提交《代理委托书》 | 已完成 |'],
]);

const f5 = '软著申报V1.0/05_材料清单与办理流程.md';
let t5 = fs.readFileSync(f5, 'utf8');
const from = '不适用（本项目拟自行办理）';
if (!t5.includes(from)) { console.error('✗ 未找到 05 里的自行办理表述'); process.exit(1); }
t5 = t5.replace(from, '待办（本项目**委托代理机构**办理，需提交《代理委托书》）');
t5 = t5.replace(/本次登记\*\*官费为零\*\*，主要成本是人力工时与用印、排版、扫描等内部成本。/,
  '本次登记**官费为零**；本项目**委托代理机构**办理，除内部人力工时与用印、排版、扫描等成本外，另有代理服务费（市场化定价，付款前书面确认服务范围与时限）。');
fs.writeFileSync(f5, t5, 'utf8');
console.log('  ✓ 05_材料清单与办理流程.md 已改为委托代理口径');

// 复查：材料里不应再有"拟自行办理"的表述
const bad = [];
for (const f of ['软著申报V1.0/01_申请表填写底稿.md', '软著申报V1.0/05_材料清单与办理流程.md', '软著申报V1.0/06_身份证明与权利归属模板.md']) {
  const s = fs.readFileSync(f, 'utf8');
  if (s.includes('拟自行办理')) bad.push(f);
}
console.log(bad.length ? '  ⚠️ 仍有自行办理表述：' + bad.join('、') : '  ✓ 口径已统一为委托代理机构办理');
