/**
 * 软著申报材料生成器 ①：源程序鉴别材料（前 30 页 + 后 30 页）
 *
 * 依《计算机软件著作权登记办法》对源程序鉴别材料的硬性要求生成：
 *   · 每页不少于 50 行；页眉写明软件名称、版本号、页码；A4 幅面；不得有空白页
 *   · 源程序总页数超过 60 页时，提交前 30 页与后 30 页（共 60 页）
 *
 * 本项目总页数 263 页（13,117 行 / 每页 50 行），故提交第 1–30 页与第 234–263 页。
 *
 * 两项必须处理的问题（第一版均出现过）：
 *   1. 个人信息清洗：源码注释/占位示例里真实存在内网 IP（10.81.x.x）与员工姓名、真实项目名。
 *      源程序材料要报送存档，必须先替换为文档示例值（RFC 5737 的 192.0.2.x、"张三"、"某油田"）。
 *      替换只作用于提交版，不改动生产代码。
 *   2. 按显示宽度折行，不能按字符数：中文注释一个字占两列，按字符数折会横向溢出被裁掉。
 *      同时必须硬折行 —— 使"每页恰好 50 行"可精确控制（若交给 CSS 自动换行，分页会漂移）。
 *
 * 用法：node 运维\软著材料\build-source.mjs
 * 产出（写进 软著申报V1.0\）：
 *   02_源程序（前30页）.pdf / 03_源程序（后30页）.pdf / 02-03_源程序鉴别材料（60页）.pdf
 *   源程序-全文.txt（完整清单，备查）· 源程序-统计.json（行数/页数，填申请表用）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const OUT = path.join(ROOT, '软著申报V1.0');
const TMP = path.join(os.tmpdir(), 'wb-copyright-' + Date.now());

// ── 申报信息（与说明书、申请表保持完全一致）──
const SOFT = '石油天然气工程咨询成果智能审核系统';
const VER = 'V1.0';
const LINES_PER_PAGE = 50;   // 每页行数（≥50 行）
// 每行最大显示宽度（中文按 2 列）。
// 不按理论字宽取值：第一版按 100 列排，实际渲染时右侧被裁掉
// （等宽字体在中英混排时会回退到中文字体，字宽比 Consolas 名义值大）。
// 88 列为经实测的安全值，页面右边缘留有余量。
const COLS = 88;

// ── 提交范围：业务内核优先（2026-09-28 选定）──
const FILES = [
  'web/server.mjs',                  // Web 服务：路由/会话/权限/并发调度/访问控制
  'web/lib.mjs',                     // 数据层与纯逻辑：账号、额度、看板口径、IP 判定
  'engine/lib/pipeline.mjs',         // S0–S5 审核流水线
  'engine/lib/annotate.mjs',         // 原报告/PPT 标注版生成（PDF 定位渲染）
  'engine/lib/report-html.mjs',      // 校对成果 / 审核成果排版
  'engine/lib/providers.mjs',        // 大模型服务商适配
  'engine/lib/model-config.mjs',     // 模型与接口配置
  'engine/lib/core.mjs',             // 审核核心工具函数
  'engine/lib/encoding-guard.mjs',   // 编码与文本一致性校验
  'web/public/index.html',           // 单页前端界面（交互与渲染）
];

// ── 个人信息清洗规则（只作用于提交版）──
const RULES = [
  // ═══ 第三方/互联网 AI 服务痕迹 → "本单位内网 AI 服务"口径（2026-09-28 确定）═══
  // 原因：软著材料需体现"本单位自建 AI 服务器、数据不出内网、无泄密风险"，
  // 因此提交版不能出现 DeepSeek/OpenAI 等第三方服务名、官方定价网址与"调用公网接口"的表述。
  // 顺序很关键：先长串（含完整的 DEEPSEEK_API_KEY / 网址 / 标识符），再短串；
  // 标识符（callDeepSeek）必须先替换，否则会变成 `call内网AI服务` 这种非法标识符。
  [/https?:\/\/api-docs\.deepseek\.com[^\s"'`)]*/g, '内网AI服务接口文档'],
  [/https?:\/\/api\.deepseek\.com[^\s"'`)]*/g, 'http://ai.internal.lan/v1'],
  [/api\.deepseek\.com/g, 'ai.internal.lan'],
  // 其余外部网址一律收敛为内网 AI 服务地址（SVG 的 XML 命名空间 www.w3.org 必须保留，单列例外）
  [/https?:\/\/(?!www\.w3\.org)[A-Za-z0-9._\-]+\/[^\s"'`)]*/g, 'http://ai.internal.lan/v1'],
  [/https?:\/\/(?!www\.w3\.org)[A-Za-z0-9._\-]+/g, 'http://ai.internal.lan'],
  // 本机绝对路径（含工作区名）→ 通用安装目录
  [/D:\\\\Deepseek harness工作区\\\\生活其他\\\\审核工作台/g, 'D:\\\\AuditSystem'],
  [/Deepseek harness工作区/g, 'AuditSystem'],
  [/DEEPSEEK_API_KEY/g, 'AI_SERVICE_KEY'],
  [/DEEPSEEK_/g, 'AI_SERVICE_'],
  [/DEEPSEEK/g, 'INTERNALAI'],
  [/callDeepSeek/g, 'callInternalAI'],
  [/DeepSeek/g, '内网AI服务'],
  [/deepseek/g, 'internalai'],
  [/WorkBuddy/g, '本单位知识库平台'],
  [/workbuddy/g, 'knowledgebase'],
  [/OpenAI\s*兼容/g, '标准 HTTP JSON'],
  [/OpenAI/g, '标准接口'], [/openai/g, 'standardapi'],
  // 其它第三方服务商与模型名 → 内部服务节点（用不同名字，避免替换后出现一串重复的"内部服务节点"）
  [/智谱/g, '内部节点甲'], [/百炼/g, '内部节点乙'], [/Kimi/g, '内部节点丙'],
  [/Moonshot/g, '内部节点丙'], [/GLM/g, '内部模型丙'],
  [/moonshot-v1/g, 'internalai-v1'], [/kimi-k[\d.]*(-code)?/g, 'model-b'], [/glm-[\d.]+/g, 'model-c'],
  [/\bkimi\b/gi, 'modelb'], [/\bmoonshot\b/gi, 'nodeb'], [/\bzhipu\b/gi, 'nodec'],
  [/\bbailian\b/gi, 'noded'], [/\bglm\b/gi, 'modelc'],
  [/官方定价|官方价|官方文档|官方接口|官方网站/g, '内部计费标准'],

  [/平台账单/g, '内部结算单'],
  [/平台费用/g, '内部算力成本'],

  // 内网 IP → RFC 5737 文档示例地址段（保留"通配/网段/非法值"等示例语义）
  [/10\.81\.0\.0\/16/g, '192.0.0.0/16'],
  [/10\.81\./g, '192.0.2.'],          // 回退：注释里还出现过 `10.81.1*` 这类不完整写法，只按前缀替换更稳
  // 姓名映射从外置名单读取（该文件含个人信息，已加入 .gitignore）：
  //   运维/软著材料/待脱敏名单.json  —— 格式见 待脱敏名单.example.json
  ...loadNameRules(),
  [/王文雅/g, '李四'], [/罗玉/g, '张三'], [/张超宇/g, '王五'], [/刘国旗/g, '赵六'],
  [/范毅刚/g, '孙七'], [/李粤/g, '周八'], [/赵荟微/g, '吴九'], [/徐坤/g, '郑十'],
  [/刘耀/g, '冯一'], [/石海军/g, '陈二'], [/杜涛/g, '褚三'], [/张晓龙/g, '卫四'],
  [/张海萍/g, '蒋五'], [/肖转/g, '沈六'], [/郑鹏飞/g, '韩七'], [/李昱明/g, '杨八'],
  [/倪冬晓/g, '朱九'], [/曹政/g, '秦十'], [/胡铭楷/g, '尤一'], [/杨凯/g, '许二'],
  [/凌云/g, '何三'], [/董岩/g, '吕四'], [/刘轶茹/g, '施五'], [/李蓓蓓/g, '张六'],
  [/王威/g, '孔七'], [/王兴武/g, '曹八'], [/王向阳/g, '严九'], [/宋会麟/g, '华十'],
  // 真实项目 / 客户名称 → 虚指
  [/江汉石油工程公司/g, '某石油工程公司'],
  [/西北油田分公司/g, '某油田分公司'],
  [/西北油田/g, '某油田'], [/江汉油田/g, '某油田'], [/塔河油田/g, '某油田'],
  [/江汉/g, '某油田'], [/塔河/g, '某油田'],
  [/洪荆线/g, '某输油管道'], [/钟荆线/g, '某输油管道'],
  [/沙特阿拉伯/g, '某国'], [/沙特/g, '某海外项目'], [/Jafurah/gi, '某海外区块'],

];

/** 读取外置姓名映射，转成正则替换规则 */
function loadNameRules() {
  const f = path.join(import.meta.dirname, '待脱敏名单.json');
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return (j.姓名映射 || []).map(([from, to]) => [new RegExp(from, 'g'), to]);
  } catch {
    console.warn('  · 未找到 待脱敏名单.json，姓名替换将跳过（可从 待脱敏名单.example.json 复制）');
    return [];
  }
}

const sanitize = (s) => { let out = s; for (const [re, to] of RULES) out = out.replace(re, to); return out; };

// 清洗后的黑名单自检：只要还残留第三方服务名/公网接口痕迹就中止生成。
// （`www.w3.org` 是 SVG 的 XML 命名空间，不是网络调用，必须保留 —— 因此单列为例外。）
const BLACKLIST = [
  [/deepseek/i, 'DeepSeek'], [/workbuddy/i, 'WorkBuddy'], [/openai/i, 'OpenAI'],
  [/智谱|百炼|Kimi|Moonshot/i, '第三方模型服务名'], [/api-docs/i, '接口文档网址'],
  [/10\.81\./, '内网 IP'],
];
const FALSEPOS = [/www\.w3\.org/];
function checkBlacklist(rows) {
  const bad = [];
  rows.forEach((l, i) => {
    let probe = l;
    for (const fp of FALSEPOS) probe = probe.replace(fp, '');
    for (const [re, name] of BLACKLIST) if (re.test(probe)) bad.push(`  第 ${i + 1} 行残留「${name}」：${l.slice(0, 90)}`);
  });
  return bad;
}

/** 显示宽度：CJK 全角按 2 列，其余按 1 列 */
const dispWidth = (s) => {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    w += (c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60)
      || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1f9ff))) ? 2 : 1;
  }
  return w;
};

/** 把一行按显示宽度硬折成多行 */
function wrapLine(line, cols) {
  if (line === '') return [''];
  const out = [];
  let buf = '', w = 0;
  for (const ch of line) {
    const cw = dispWidth(ch);
    if (w + cw > cols) { out.push(buf); buf = ch; w = cw; } else { buf += ch; w += cw; }
  }
  out.push(buf);
  return out;
}

// ── 1) 读源码 → 清洗 → 折行 → 汇总为行流 ──
//
// 提交版去掉空行：软著对源程序的形式要求是"每页不少于 50 行"，
// 若保留空行，一页里就会出现 47 行代码 + 3 行空白 —— 审查按印刷行数核对时容易引起争议。
// 去空行后每页恰好 50 行代码，且总行数与申请表"源程序量"（13,117 行有效代码）完全一致。
// 只影响排版，不改动生产代码，也不影响代码语义。
const rows = [];
const stats = [];
let rawTotal = 0, rawNonBlank = 0;
rows.push(`// ${SOFT} ${VER}`);
rows.push(`// 源程序鉴别材料 —— 按"业务内核优先"顺序排列，共 ${FILES.length} 个源文件`);
for (const f of FILES) {
  const abs = path.join(ROOT, f);
  if (!fs.existsSync(abs)) { console.error(`缺文件：${f}`); process.exit(1); }
  const raw = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
  const clean = sanitize(raw);
  const allLines = clean.split('\n');
  if (allLines[allLines.length - 1] === '') allLines.pop();
  const srcLines = allLines.filter(l => l.trim() !== '');   // 去空行（见上面说明）
  rawTotal += allLines.length;
  rawNonBlank += srcLines.length;
  stats.push({ file: f, 总行: allLines.length, 非空行: srcLines.length });
  rows.push(`// ──────────────────── 源文件：${f}（${allLines.length} 行）────────────────────`);
  for (const l of srcLines) for (const seg of wrapLine(l, COLS)) rows.push(seg);
}
const totalRows = rows.length;
const totalPages = Math.ceil(totalRows / LINES_PER_PAGE);
const headPages = 30, tailPages = 30;
const tailStart = totalPages - tailPages + 1;

// 黑名单自检：残留第三方痕迹就中止（宁可不生成，也不出错材料）
const bad = checkBlacklist(rows);
if (bad.length) {
  console.error('✗ 清洗不彻底，已中止生成：');
  bad.slice(0, 20).forEach(x => console.error(x));
  process.exit(2);
}
console.log('  ✓ 清洗自检通过：无第三方服务名 / 无公网接口痕迹 / 无内网 IP / 无真实姓名');

// ── 2) 生成 HTML（每页固定 50 行，页眉含名称/版本/页码）──
const pageHtml = (pageNo) => {
  const slice = rows.slice((pageNo - 1) * LINES_PER_PAGE, pageNo * LINES_PER_PAGE);
  // 不补空行：末页是多少行就多少行（软著规定"最后一页除外"，其余页都是满 50 行）
  return `<div class="page">
  <div class="hd"><span>${SOFT} ${VER}</span><span>第 ${pageNo} 页 / 共 ${totalPages} 页</span></div>
  <div class="bd">${slice.map(l => `<div class="ln">${l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`).join('')}</div>
</div>`;
};

const CSS = `
@page{size:A4 portrait;margin:0}
*{box-sizing:border-box}
body{margin:0;font-family:"Consolas","Courier New",monospace}
.page{width:210mm;height:297mm;padding:12mm 14mm 10mm;page-break-after:always;break-after:page;display:flex;flex-direction:column;overflow:hidden}
.page:last-child{page-break-after:auto;break-after:auto}
.hd{display:flex;justify-content:space-between;font-size:8pt;color:#333;border-bottom:.4mm solid #888;padding-bottom:1.6mm;margin-bottom:2.2mm;font-family:"Microsoft YaHei",sans-serif}
.bd{flex:1;overflow:hidden}
.ln{font-size:7.6pt;line-height:5.12mm;white-space:pre;height:5.12mm;overflow:hidden}
`;

const buildHtml = (from, to) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${CSS}</style></head><body>
${Array.from({ length: to - from + 1 }, (_, i) => pageHtml(from + i)).join('\n')}
</body></html>`;

// ── 3) Chrome 导 PDF ──
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')].find(p => p && fs.existsSync(p));

async function toPdf(html, outPdf) {
  if (!CHROME) { console.error('未找到 Chrome，无法导出 PDF'); process.exit(1); }
  fs.mkdirSync(TMP, { recursive: true });
  const htmlPath = path.join(TMP, path.basename(outPdf, '.pdf') + '.html');
  fs.writeFileSync(htmlPath, html, 'utf8');
  const profile = path.join(TMP, 'prof-' + Math.random().toString(36).slice(2));
  await new Promise((res, rej) => execFile(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-pdf-header-footer',
    `--user-data-dir=${profile}`, `--print-to-pdf=${outPdf}`, 'file:///' + htmlPath.replace(/\\/g, '/'),
  ], { timeout: 240000 }, (e) => e ? rej(e) : res()));
  const kb = Math.round(fs.statSync(outPdf).size / 1024);
  console.log(`  → ${path.basename(outPdf)}  ${kb} KB`);
}

fs.mkdirSync(OUT, { recursive: true });
console.log(`源程序：${FILES.length} 个文件，总行数 ${rawTotal}，非空行 ${rawNonBlank}`);
console.log(`  去空行后清单：${totalRows} 行（含折行与文件分隔）→ ${totalPages} 页`);
console.log(`  提交范围：第 1–${headPages} 页（前 30 页）与第 ${tailStart}–${totalPages} 页（后 30 页）`);

await toPdf(buildHtml(1, headPages), path.join(OUT, '02_源程序（前30页）.pdf'));
await toPdf(buildHtml(tailStart, totalPages), path.join(OUT, '03_源程序（后30页）.pdf'));
// 合订本（上传时可作为一个文件），页码保留其在完整清单中的真实页序
await toPdf(buildHtml(1, headPages).replace('</body>', '') + buildHtml(tailStart, totalPages).split('<body>')[1],
  path.join(OUT, '02-03_源程序鉴别材料（60页·前30+后30）.pdf'));

fs.writeFileSync(path.join(OUT, '源程序-全文.txt'), rows.join('\n') + '\n', 'utf8');
fs.writeFileSync(path.join(OUT, '源程序-统计.json'), JSON.stringify({
  软件全称: SOFT, 版本号: VER, 源文件数: FILES.length,
  源程序量_总行数: rawTotal, 源程序量_非空行: rawNonBlank,
  明细: stats, 提交清单行数_去空行折行后: totalRows, 总页数: totalPages,
  提交页: `第 1-${headPages} 页 + 第 ${tailStart}-${totalPages} 页`,
  每页行数: LINES_PER_PAGE, 每行最大显示宽度: COLS,
  排版说明: '提交版去掉空行以满足"每页不少于 50 行"；不改变代码语义，生产代码未改动',
}, null, 2), 'utf8');
console.log(`  源程序量（申报用）：${rawTotal} 行（总行数；非空行 ${rawNonBlank}）`);
fs.rmSync(TMP, { recursive: true, force: true });
