// 提交预检自检：坏包必须被挡住，好包必须放行。
// 用法：node engine\test-container-check.mjs
import * as L from '../web/lib.mjs';

let pass = 0, fail = 0;
const ok = (c, n, extra = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${extra ? '  ← ' + extra : ''}`); } };
const eq = (a, b, n) => ok(a === b, n, `实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`);

const zip = (...parts) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p) : p)));
const PK = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const EOCD = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

console.log('\n── 1. 有效文件放行 ──');
{
  eq(L.checkOfficeContainer(zip(PK, 'word/document.xml', EOCD), 'a.docx').ok, true, '完整 docx（PK + 部件 + EOCD）放行');
  eq(L.checkOfficeContainer(zip(PK, 'ppt/presentation.xml', EOCD), 'a.pptx').ok, true, '完整 pptx 放行');
}

console.log('\n── 2. 坏文件当场拒收（2026-10-08 变配电报告失败的那类）──');
{
  const broken = zip(PK, Buffer.alloc(4096, 7));                       // 只有头、没有 EOCD＝上传截断
  const r1 = L.checkOfficeContainer(broken, 'b.docx');
  eq(r1.ok, false, '截断的 docx 被拒收');
  eq(r1.code, 'broken-zip', '归类为"包不完整"（与 pandoc 的 Did not find end of central directory 对应）');
  ok(/另存为/.test(r1.error), '提示里给出可操作处置（在 Word 里另存为）');

  eq(L.checkOfficeContainer(zip(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(99)), 'c.docx').code, 'legacy',
    '老式 .doc 改名 → 明确提示"老式 Office 文件"');
  eq(L.checkOfficeContainer(Buffer.from('{\\rtf1 hello'), 'd.docx').code, 'rtf', 'RTF 改名被识别');
  eq(L.checkOfficeContainer(Buffer.from('%PDF-1.7 xxxx'), 'e.docx').code, 'pdf', 'PDF 被识别');
  eq(L.checkOfficeContainer(Buffer.alloc(0), 'f.docx').code, 'empty', '空文件被拒收');
  eq(L.checkOfficeContainer(zip(PK, 'word/document.xml', EOCD), 'g.pptx').code, 'wrong-kind',
    'docx 当成 pptx 传 → 提示扩展名与实际内容不符');
}

console.log('\n── 3. 真实样张回归（若仓库里有可用样张就顺带验一遍）──');
{
  const fs = await import('node:fs');
  const cands = ['web/data/tasks'].flatMap(() => []);
  const dir = 'engine/测试样本';
  let tested = 0;
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).slice(0, 3)) {
      if (!/\.docx$/i.test(f)) continue;
      const r = L.checkOfficeContainer(fs.readFileSync(`${dir}/${f}`), f);
      ok(r.ok, `样张 ${f} 能通过预检` + (r.ok ? '' : `（${r.code}：${r.error}）`));
      tested++;
    }
  }
  if (!tested) console.log('  （无样张，跳过）');
  void cands;
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 提交预检自检：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
