/**
 * 编码自检的"自检"（零 API、零网络）
 *
 * 分三块：
 *   ① 真仓库体检 —— 当前所有源码/界面文件必须干净（回归护栏）；
 *   ② 阳性样本 —— 造出真的乱码，闸门必须抓到（否则闸门无实际作用）；
 *   ③ 阴性样本 —— 正常中文、单位串、单个"拷"字不得误报（否则会被绕过）。
 *
 * 本文件必然含有乱码字面量（用作夹具），因此靠 `test-` 前缀被闸门排除；
 * 下面专门有一条断言验证该排除确实生效。
 *
 * 用法：node engine\test-encoding.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EG = await import('./lib/encoding-guard.mjs');

let pass = 0, fail = 0;
const ok = (c, n, extra = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${extra ? '  ← ' + extra : ''}`); } };
const eq = (a, b, n) => ok(a === b, n, `实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`);

console.log('\n── 1. 闸门自身的完整性（它要是被洗坏了，后面全是假绿）──');
{
  ok(EG.SIGNATURE === '锟斤拷', '经典乱码串认得出来');
  for (const c of ['锟', '鈥', '锛', '銆', '鐨', '鍜', '鏄', '鏂', '閫', '鍒', '鍥', '绠', '鏌']) {
    ok(EG.STRONG.has(c), `特征字集合含「${c}」`);
  }
  ok(EG.STRONG.has('拷') === false, '"拷"不算强特征字（"拷贝"是正常词，不许误伤）');
  ok(EG.WEAK.has('拷'), '"拷"归入弱特征字');
  ok(EG.PROJECT_ROOT.endsWith('审核工作台'), `项目根定位正确：${path.basename(EG.PROJECT_ROOT)}`);
}

console.log('\n── 2. 真仓库体检（回归护栏）──');
const repo = EG.scanTree();
{
  ok(repo.checked.length >= 15, `扫到 ${repo.checked.length} 个源码/界面文件`);
  ok(repo.errors.length === 0, '错误级乱码 0 处（界面与引擎文件都是干净的）',
    repo.errors.slice(0, 3).map((x) => `${path.basename(x.file)}:${x.line} ${x.kind}`).join(' / '));
  const names = repo.checked.map((f) => path.basename(f));
  ok(names.includes('index.html'), '扫到了 web/public/index.html（上次出事的就是它）');
  ok(names.includes('server.mjs'), '扫到了 web/server.mjs');
  ok(names.includes('annotate.mjs'), '扫到了 engine/lib/annotate.mjs');
}

console.log('\n── 3. 阳性样本：造出乱码，必须抓到 ──');
{
  // ① 字节级坏文件：GBK 编码的中文（D6 D0 CE C4 = 「中文」）当 UTF-8 读 → 替换字符
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'encguard-'));
  const gbk = path.join(tmp, 'gbk.html');
  fs.writeFileSync(gbk, Buffer.from([0xD6, 0xD0, 0xCE, 0xC4, 0x3C, 0x2F, 0x64, 0x69, 0x76, 0x3E]));
  const f1 = EG.scanFile(gbk);
  ok(f1.some((x) => x.severity === 'error' && x.kind.includes('U+FFFD')), 'GBK 字节文件被识别为 U+FFFD（错误级）');

  // ② 已经被"洗过一遍"的合法 UTF-8 乱码（本事故的真实产物）
  const moi = path.join(tmp, 'mojibake.js');
  fs.writeFileSync(moi, '// 涓枃鏂囦欢宸查€氳繃瀹℃牳锛屽凡瀹屾垚銆\nconst a = 1;\n', 'utf8');
  const f2 = EG.scanFile(moi);
  ok(f2.some((x) => x.severity === 'error' && x.kind.includes('特征字')), 'GBK 往返洗过的文本被识别为特征字乱码（错误级）');

  // ③ 经典串 锟斤拷
  const f3 = EG.scanText('标题：锟斤拷锟斤拷', { file: 'x.html' });
  ok(f3.some((x) => x.severity === 'error'), '「锟斤拷」直接判错误级');

  // ④ 报错信息要能定位：文件 + 行号 + 原句
  const f4 = EG.scanText('第一行正常\n第二行 鏂囦欢 坏了\n第三行正常', { file: 'y.js' });
  eq(f4.length >= 1 && f4[0].line, 2, '行号报的是第 2 行（不是从 0 数）');
  ok(f4[0].file === 'y.js' && /鏂/.test(f4[0].text), '报错带文件与证据片段');

  // ⑤ assertClean 必须拦住
  let threw = false;
  try { EG.assertClean({ errors: f1, warnings: [] }); } catch { threw = true; }
  ok(threw, 'assertClean 见到错误级就抛异常（启动闸门靠它拦）');

  // ⑥ 临时目录扫树：错误要汇总到 errors
  const tree = EG.scanTree({ roots: [tmp], exts: ['.html', '.js'], excludeDirs: new Set(), excludeFiles: new Set(), excludeFilePrefixes: [], baseDir: tmp });
  ok(tree.errors.length >= 2 && tree.checked.length === 2, `临时目录扫出 ${tree.errors.length} 处错误 / ${tree.checked.length} 个文件`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n── 4. 阴性样本：正常文本不许误报 ──');
const CLEAN_SAMPLES = [
  '工程咨询成果审核工作台 —— 内网服务已启动，同时处理 3 个任务。',
  '单位必须写清楚：低位发热量 35.2 MJ/m³，碳排放因子 83元/t，单位热值含碳量 tCO₂/TJ。',
  '下标与上标：CO₂、H₂S、m³、×10⁻³、MPa·m、℃、①②③④、≤ ≥ ±。',
  '分项 0.78+119.85＝120.63 万元；见正文 12.1 节与表 3-2。',
  '把文件拷贝到备份目录（"拷"是正常字，不许报错）。',
  '注释里写 SQL：SELECT * FROM users WHERE role="admin"; -- 保留 1 个空格',
];
{
  let bad = 0;
  const det = [];
  for (const s of CLEAN_SAMPLES) {
    const found = EG.scanText(s, { file: 'clean.txt' });
    if (found.length) { bad++; det.push(`${found[0].kind}：${s.slice(0, 20)}`); }
  }
  ok(bad === 0, `${CLEAN_SAMPLES.length} 条正常样本零误报`, det.join(' / '));

  const one = EG.scanText('这个生僻字 锟 单独出现了一次', { file: 'z.md' });
  ok(one.length === 1 && one[0].severity === 'warn', '单个特征字只报提示级（留人工确认的余地）');
  ok(EG.assertClean({ errors: [], warnings: one }) === true, '只有提示级时不阻断启动');
}

console.log('\n── 5. 排除规则：闸门不许把夹具和文档当故障 ──');
{
  const files = EG.collectFiles();
  ok(!files.some((f) => path.basename(f).startsWith('test-')), 'test- 开头的自检夹具被排除（它们故意含乱码）');
  ok(!files.some((f) => path.basename(f) === 'encoding-guard.mjs'), '闸门自己（含乱码字面量）被排除');
  ok(!files.some((f) => f.includes('node_modules')), 'node_modules 被排除');
  ok(!files.some((f) => f.split(path.sep).includes('data')), 'data 目录被排除');
  ok(!files.some((f) => f.split(path.sep).includes('运维')), '运维 目录被排除');
  ok(!files.some((f) => path.extname(f) === '.md'), '默认不扫 .md（文档里要引用乱码做说明）');
  ok(EG.collectFiles({ roots: ['不存在的目录'] }).length === 0, '目录不存在时安静返回空，不抛异常');

  // 去重：默认根目录 web/public 是 web 的子目录，不去重同一文件会被扫两遍、错误数翻倍
  const uniq = new Set(files);
  eq(uniq.size, files.length, '文件列表无重复（子目录重叠不会重复计数）');
  const overlapped = EG.collectFiles({ roots: ['web', 'web/public'] });
  eq(new Set(overlapped).size, overlapped.length, '显式传重叠根目录也不重复扫描');
  const idxCount = files.filter((f) => f.endsWith(path.join('public', 'index.html'))).length;
  eq(idxCount, 1, 'index.html 只被扫一次');
}

console.log('\n── 6. 这次修掉的两处老乱码（回归）──');
{
  const pairs = [
    ['skill/petroleum-engineering-review/references/advanced-technical-review.md', '面向甲方高级专家'],
    ['skill/petroleum-engineering-review/references/ai-content-review.md', '结构时，逐条追问'],
    ['skill/.sync/baseline/references/advanced-technical-review.md', '面向甲方高级专家'],
    ['skill/.sync/baseline/references/ai-content-review.md', '结构时，逐条追问'],
  ];
  for (const [rel, need] of pairs) {
    const p = path.join(EG.PROJECT_ROOT, rel);
    const t = fs.readFileSync(p, 'utf8');
    ok(!t.includes('\uFFFD') && t.includes(need), `${rel} 乱码已修（含「${need}」）`);
  }
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 编码自检：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
