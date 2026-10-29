#!/usr/bin/env node
/**
 * 发布副本生成器 —— 把运行中的系统复制成一份可公开的副本，源目录本身不被改动。
 *
 * 约束（2026-09-21: 发布流程按此口径确定）：
 *   · 运行目录内含甲方报告、账号哈希、内部制度知识库，不得进入版本库
 *   · 代码本身需要版本管理与开源发布
 *   · 因此不以运行目录作为仓库，而是每次生成一份独立的发布副本后再推送
 *   · 该方式使发布动作可重复，脱敏规则固化在脚本内，源目录不受任何影响
 *
 * 用法：
 *   node 运维\publish.mjs                 # 生成到 ..\审核工作台-发布
 *   node 运维\publish.mjs D:\somewhere    # 指定目标目录
 *   node 运维\publish.mjs --no-scrub      # 不脱敏（只用于私有仓库）
 *
 * 生成后：
 *   cd <目标目录> ; git init ; git add -A ; git commit -m "..." ; git push
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const NO_SCRUB = args.includes('--no-scrub');
const DEST = path.resolve(args.find(a => !a.startsWith('--')) || path.join(SRC, '..', '审核工作台-发布'));

// ── 只复制这些（白名单，不是黑名单）──
// 白名单比黑名单安全：新增了数据目录也不会被误传。
const INCLUDE = [
  'engine',
  'web/public',
  'web/lib.mjs',
  'web/server.mjs',
  '运维/backup.ps1',
  '运维/restore.ps1',
  '运维/watchdog.ps1',
  '运维/screenshot.cjs',
  '运维/账号停用.mjs',
  '运维/README-恢复说明.md',
  'VERSION.txt',
];
// 明确排除（万一白名单里带进来）
const EXCLUDE_RE = /(^|[\\/])(web[\\/]data|skill|runs|产出|测试样本|预览|node_modules|\.git)([\\/]|$)/;

// ── 脱敏规则：在副本上做文本替换，源目录不动 ──
const SCRUB = [
  {
    file: 'web/server.mjs',
    why: '硬编码的公司内网 IP',
    from: "  console.log(`  同事访问 : http://192.0.2.161:${PORT}`);",
    to: `  // 使用方访问地址：自动探测本机内网 IPv4（此前硬编码公司地址，换机器或换网段即失效）
  const lanIP = (() => {
    try {
      for (const list of Object.values(os.networkInterfaces())) {
        for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
      }
    } catch { /* 拿不到就显示占位 */ }
    return '(本机内网地址)';
  })();
  console.log(\`  同事访问 : http://\${lanIP}:\${PORT}\`);`,
  },
  {
    file: 'web/server.mjs',
    why: '注释里的员工姓名',
    from: "import http from 'node:http';",
    to: "import http from 'node:http';\nimport os from 'node:os';",
  },
  { file: 'web/server.mjs', why: '员工姓名', all: true, from: /张三/g, to: '审核专家' },
  { file: 'web/server.mjs', why: '员工姓名', all: true, from: /赵六|李四/g, to: '某同事' },

  { file: 'web/lib.mjs', why: '薪酬注释里的姓名', all: true, from: /审核专家（张三等）时薪/g, to: '审核专家时薪（参考值）' },
  { file: 'web/lib.mjs', why: '公司内网网段', all: true, from: /防火墙限 10\.81\.0\.0\/16/g, to: '防火墙仅放行本机所在网段' },

  { file: 'engine/lib/report-html.mjs', why: '员工姓名', all: true, from: /（如张三）/g, to: '（如审核专家）' },
  { file: 'engine/lib/report-html.mjs', why: '员工姓名', all: true, from: /张三/g, to: '审核专家' },

  { file: 'engine/test-cancel.mjs', why: '员工姓名', all: true, from: /张三/g, to: '甲专家' },
  { file: 'engine/test-duplicate.mjs', why: '测试数据里的员工姓名', all: true, from: /赵六/g, to: '张工' },
  { file: 'engine/test-duplicate.mjs', why: '测试数据里的员工姓名', all: true, from: /李四/g, to: '李工' },
  { file: 'engine/test-duplicate.mjs', why: '测试数据里的员工姓名', all: true, from: /张三/g, to: '王工' },
  { file: 'engine/test-feedback.mjs', why: '测试数据里的员工姓名', all: true, from: /张三/g, to: '王工' },
  { file: 'engine/test-duplicate.mjs', why: '测试数据里的公司全称', all: true, from: /河南油田工程科技股份有限公司/g, to: '某某公司' },

  { file: 'web/public/index.html', why: '员工姓名', all: true, from: /（如张三）/g, to: '（如审核专家）' },
  // 注意：界面上「河南油田工程科技股份有限公司」是产品品牌（logo alt），默认保留。
  // 若要彻底匿名化，把下面这条打开。
  // { file: 'web/public/index.html', why: '公司全称', all: true, from: /河南油田工程科技股份有限公司/g, to: '某某公司' },

  {
    file: '运维/账号停用.mjs',
    why: '默认白名单写死了员工姓名 —— 而且不传参就默认停用其余全部账号，太危险',
    all: false,
    from: "const KEEP = (keepArg ? keepArg.split(',') : ['admin', '张三', '李四']).map(s => s.trim()).filter(Boolean);",
    to: `const KEEP = (keepArg ? keepArg.split(',') : []).map(s => s.trim()).filter(Boolean);
if (!KEEP.length) {
  // 此处不设默认保留账号：早期默认保留 admin 与两名员工、停用其余全部账号，
  // 一旦误执行（尤其带 --apply）影响面过大，故必须显式指定要保留的账号。
  console.error('必须显式指定要保留的账号，例如：');
  console.error('  node 运维\\\\账号停用.mjs --apply --keep admin,zs,ls');
  console.error('（--keep 是"保留"，不在名单里的会被停用；先不带 --apply 干跑看看）');
  process.exit(1);
}`,
  },
  { file: '运维/账号停用.mjs', why: '员工姓名', all: true, from: /张三|李四/g, to: '某账号' },

  { file: '运维/screenshot.cjs', why: '员工姓名', all: true, from: /赵六/g, to: '某同事' },
  { file: '运维/screenshot.cjs', why: '员工姓名', all: true, from: /张三/g, to: '审核专家' },
  { file: '运维/README-恢复说明.md', why: '内网 IP 与员工姓名', all: true, from: /10\.81\.\d+\.\d+/g, to: '(本机内网地址)' },
  { file: '运维/README-恢复说明.md', why: '员工姓名', all: true, from: /张三/g, to: '审核专家' },

  // ── 外部工具的安装路径：含本机用户名 ──
  // 改成先查环境变量、再退回工具名（靠 PATH 找），公开仓库里不必知道装在哪。
  {
    file: 'web/lib.mjs',
    why: '本地工具绝对路径（含本机用户名）',
    from: /const MARKITDOWN = String\.raw`C:\\Users\\Administrator[^`]*`;\nconst SOFFICE = String\.raw`C:\\Program Files[^`]*`;\nconst PANDOC = String\.raw`C:\\Users\\Administrator[^`]*`;/,
    to: [
      '// 外部工具路径：可用环境变量覆盖；否则按工具名交给 PATH 去找。',
      '// （原来是写死的本机绝对路径，换台机器就失效）',
      "const MARKITDOWN = process.env.MARKITDOWN || 'markitdown';",
      "const SOFFICE = process.env.SOFFICE || 'soffice';",
      "const PANDOC = process.env.PANDOC || 'pandoc';",
    ].join('\n'),
  },

  // ── 本地绝对路径 ──
  // 泄漏的是本机用户名与工作区目录名（不是知识，但也不该公开）。
  // 改为相对路径：公开仓库中本就没有 skill/ 目录，
  // 且写死的绝对路径换机器即失效，相对路径更合适。
  {
    file: 'engine/lib/core.mjs',
    why: '写死的技能目录绝对路径',
    from: /import os from 'node:os';/,
    to: "import os from 'node:os';\nimport { fileURLToPath } from 'node:url';",
  },
  {
    file: 'engine/lib/core.mjs',
    why: '写死的技能目录绝对路径',
    from: /String\.raw`D:\\Deepseek[^`]*`/,
    to: "path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'skill', 'petroleum-engineering-review')",
  },
  {
    file: 'engine/sync-skill.mjs',
    why: '写死的 WorkBuddy 原件绝对路径（含本机用户名）',
    from: /String\.raw`C:\\Users\\Administrator\\[^`]*`/,
    to: "''",
  },
  {
    file: 'engine/test-cancel.mjs',
    why: '写死的测试样本绝对路径',
    from: /import fs from 'node:fs';/,
    to: "import fs from 'node:fs';\nimport path from 'node:path';\nimport { fileURLToPath } from 'node:url';",
  },
  {
    file: 'engine/test-cancel.mjs',
    why: '写死的测试样本绝对路径',
    from: /const FILE = 'D:\\\\Deepseek[^']*';/,
    to: "const FILE = process.env.TEST_DOC\n  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '测试样本', '可研_江汉压裂设备购置.doc');",
  },
];

const log = (m) => console.log(m);

// ── --status：检查发布副本是否需要同步 ──
// 会话会结束，依赖人工记忆"该发布了"不可靠，因此做成可随时执行的单条命令：
//   node 运维\publish.mjs --status
//
// 不能直接逐个比对源文件与副本文件：副本经过脱敏，本就应与源不同，
// 直接比会产出大量误报（第一版按此实现，报出 11 个"不一致"）。
// 正确口径：发布时把源文件指纹记入状态文件，之后拿当前源文件与该次指纹比对。
const STATE_FILE = path.join(__dirname, '.publish-state.json');

const sha = (p) => {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16); }
  catch { return null; }
};
/** 对白名单内的源文件全部计算指纹（用于判断源文件是否改动） */
const sourceFingerprint = () => {
  const out = {};
  const walk = (rel) => {
    const abs = path.join(SRC, rel);
    if (!fs.existsSync(abs)) return;
    if (fs.statSync(abs).isDirectory()) { for (const e of fs.readdirSync(abs)) walk(path.join(rel, e)); return; }
    if (EXCLUDE_RE.test(rel)) return;
    out[rel] = sha(abs);
  };
  for (const rel of INCLUDE) walk(rel);
  return out;
};

if (args.includes('--status')) {
  const rd = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
  const verOf = (dir) => {
    const t = rd(path.join(dir, 'VERSION.txt'));
    return t ? (t.match(/^VERSION\s*=\s*(.+)$/m) || [, '—'])[1].trim() : null;
  };
  const srcVer = verOf(SRC);
  const st = (() => { try { return JSON.parse(rd(STATE_FILE) || 'null'); } catch { return null; } })();

  log('═══ 发布状态检查 ═══');
  log(`  源系统版本         ${srcVer || '（读不到）'}`);
  log(`  上次发布时的版本   ${st ? st.version : '（没有记录，说明还没发布过）'}`);
  if (st) log(`  上次发布时间       ${new Date(st.at).toLocaleString('zh-CN')}`);

  if (!st) {
    log('\n  → 还没有发布记录。跑一次 node 运维\\publish.mjs 生成并记录。');
    process.exit(0);
  }

  const now = sourceFingerprint();
  const changed = [], added = [], removed = [];
  for (const [k, v] of Object.entries(now)) {
    if (!(k in st.files)) added.push(k);
    else if (st.files[k] !== v) changed.push(k);
  }
  for (const k of Object.keys(st.files)) if (!(k in now)) removed.push(k);

  const total = changed.length + added.length + removed.length;
  if (srcVer !== st.version) log(`\n  ⚠ 版本号变了：${st.version} → ${srcVer}`);
  if (total) {
    log(`\n  ⚠ 源目录有改动，副本已过期（${total} 个文件）：`);
    for (const c of changed.slice(0, 12)) log(`      · 改了   ${c}`);
    for (const c of added.slice(0, 6)) log(`      · 新增   ${c}`);
    for (const c of removed.slice(0, 6)) log(`      · 删了   ${c}`);
    if (total > 24) log(`      … 共 ${total} 个`);
    log('\n  → 该重新发布了：');
    log('      node 运维\\publish.mjs');
    log('      cd "..\\审核工作台-发布" ; git add -A ; git commit -m "..." ; git push');
  } else {
    log('\n  ✓ 源目录自上次发布后没有改动，副本是最新的');
  }
  process.exit(0);
}

// ══════════ 开始 ══════════
log('═══════════════════════════════════════════════════');
log('  发布副本生成');
log(`  源目录  ${SRC}`);
log(`  目标    ${DEST}`);
log(`  脱敏    ${NO_SCRUB ? '否（--no-scrub）' : '是'}`);
log('═══════════════════════════════════════════════════');

if (DEST === SRC || SRC.startsWith(DEST + path.sep)) {
  console.error('✗ 目标目录不能是源目录本身或它的父目录');
  process.exit(1);
}

// 1) 清空并重建目标目录，但保留 .git
//    此前直接 rmSync 整个目标目录，把 .git 一并删除：每次重新发布都会丢失版本历史。
//    因此先把 .git 移到目标目录之外，复制完成后再移回。
const GIT_DIR = path.join(DEST, '.git');
const GIT_STASH = path.join(DEST, '..', '.publish-git-stash');
let hadGit = false;
if (fs.existsSync(GIT_DIR)) {
  fs.rmSync(GIT_STASH, { recursive: true, force: true });
  fs.renameSync(GIT_DIR, GIT_STASH);
  hadGit = true;
}
if (fs.existsSync(DEST)) {
  fs.rmSync(DEST, { recursive: true, force: true });
  log('\n[1/5] 已清空旧的目标目录');
} else {
  log('\n[1/5] 新建目标目录');
}
fs.mkdirSync(DEST, { recursive: true });
if (hadGit) {
  fs.renameSync(GIT_STASH, path.join(DEST, '.git'));
  log('      ✓ 保留了原有的 .git（版本历史不丢）');
}

// 2) 按白名单复制
log('\n[2/5] 复制代码文件…');
let copied = 0, bytes = 0;
const walk = (rel) => {
  const abs = path.join(SRC, rel);
  if (!fs.existsSync(abs)) { log(`      ⚠ 不存在，跳过：${rel}`); return; }
  const st = fs.statSync(abs);
  if (st.isFile()) {
    if (EXCLUDE_RE.test(rel)) return;
    const out = path.join(DEST, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.copyFileSync(abs, out);
    copied++; bytes += st.size;
    return;
  }
  for (const e of fs.readdirSync(abs)) walk(path.join(rel, e));
};
for (const rel of INCLUDE) walk(rel);
log(`      已复制 ${copied} 个文件，${(bytes / 1024).toFixed(0)} KB`);

// 3) 脱敏
log('\n[3/5] 脱敏…');
let scrubbed = 0, missed = [];
if (!NO_SCRUB) {
  for (const rule of SCRUB) {
    const f = path.join(DEST, rule.file);
    if (!fs.existsSync(f)) { missed.push(`${rule.file}（文件不存在）`); continue; }
    let c = fs.readFileSync(f, 'utf8');
    const before = c;
    if (rule.all) c = c.replace(rule.from, rule.to);
    else c = c.split(rule.from).join(rule.to);
    if (c !== before) { fs.writeFileSync(f, c, 'utf8'); scrubbed++; log(`      ✓ ${rule.file}　—— ${rule.why}`); }
    else missed.push(`${rule.file}　${rule.why}`);
  }
  if (missed.length) {
    log('      ⚠ 以下规则没有匹配到（可能代码已改，规则要跟着更新）：');
    for (const m of missed) log(`         · ${m}`);
  }
  log(`      共脱敏 ${scrubbed} 处`);
}

// 4) 收尾：README + .gitignore（.gitignore 从源目录带过来，没有就现写）
log('\n[4/5] 写发布说明…');
const gitignoreSrc = path.join(SRC, '.gitignore');
if (fs.existsSync(gitignoreSrc)) {
  fs.copyFileSync(gitignoreSrc, path.join(DEST, '.gitignore'));
  log('      ✓ .gitignore（从源目录复制）');
}

// 面向外部的 README —— 由脚本生成，保证与代码同步；不含任何公司内部信息
const version = (() => {
  try {
    const t = fs.readFileSync(path.join(SRC, 'VERSION.txt'), 'utf8');
    return (t.match(/^VERSION\s*=\s*(.+)$/m) || [, '—'])[1].trim();
  } catch { return '—'; }
})();
const README = [
  '# 工程咨询成果审核工作台',
  '',
  '石油天然气行业**工程咨询成果的 AI 初审平台**。把一份可研 / 后评价 / 收购类报告丢进去，',
  '系统按分阶段流水线做结构化抽取、分维度审核、规则校验与分级，输出两类成果：',
  '',
  '- **校对成果**（人人可看）—— 编校、术语、数据不一致、口径混用、标准规范引用等**客观可核对**的问题',
  '- **审核成果**（授权者）—— 在校对类之外，增加逻辑分析、结论正确性、投资与经济指标、建议合理性',
  '',
  '## 特点',
  '',
  '- **分阶段流水线**：S0 预审 → S1 结构化 → S2 分维度审核 → S3 规则校验 → S4 分级闸门 → S5 成文',
  '- **关键判定由代码做**：问题定级（P0~P3）走纯代码闸门，不采信模型自报的等级',
  '- **计费时段感知**：识别高峰 / 空闲时段，可把花钱的调用排到空闲时段（半价）',
  '- **两阶段任务流**：本地文档解析立刻做（不花钱），AI 调用到点才跑',
  '- **PPT 配对审核**：同时提交同一项目的报告与汇报 PPT，可额外做**数据 / 观点 / 内容一致性核对**，成果按 PPT 优先排版',
  '- **零第三方依赖**：服务本体只用 Node 内置模块（node:http + scrypt + cookie 会话）',
  '',
  '## 架构',
  '',
  '```',
  'S0 预审      识别项目编号 / 名称、报告类型、项目类型（一次便宜调用）',
  'S1 结构化    抽事实：投资链、时间线、跨源冲突、资金、引用标准…（一次调用）',
  'S2 分维度    8 个审核单元并发跑（受控并发，避免被限流）',
  'S3 规则校验  纯代码，零 API：投资偏差、时序倒置、跨源不一致、标准编号…',
  'S4 分级闸门  纯代码，零 API：按类别映射 P0 白名单，编校 / 术语 / AI套话永不得 P0',
  'S5 成文      只写叙述部分；附录、统计、表格全部由代码生成',
  '```',
  '',
  '审核知识放在**技能文件**里（skill/，本仓库不含），工程实现留在 engine/。',
  '',
  '## 目录结构',
  '',
  '```',
  'engine/               审核引擎',
  '  lib/pipeline.mjs      S0~S5 流水线、审核单元定义、规则引擎',
  '  lib/core.mjs          API 调用、技能读取、JSON 容错',
  '  lib/report-html.mjs   成果渲染（校对版 / 审核版，含打印样式）',
  '  test-*.mjs            离线自检（零 API 调用）',
  '  backfill-*.mjs        历史数据回填工具',
  'web/                  内网 Web 服务',
  '  server.mjs            路由、任务调度、并发闸门',
  '  lib.mjs               数据层、计费、查重、看板统计、文档转换',
  '  public/index.html     单文件前端',
  '运维/                 运维脚本',
  '  backup.ps1 / restore.ps1   完整备份与异机恢复',
  '  watchdog.ps1               自愈看门狗',
  '  publish.mjs                生成可发布的脱敏副本',
  '```',
  '',
  '## 运行依赖',
  '',
  '| 组件 | 必需 | 用途 |',
  '|---|:--:|---|',
  '| Node.js 24+ | ✅ | 服务本体（零第三方依赖） |',
  '| LibreOffice | ✅ | .doc / .ppt 老格式转换 |',
  '| Python 3.12 + MarkItDown | ✅ | Office / PDF → Markdown |',
  '| Pandoc | ⭕ | 备用转换 |',
  '| Chrome / Edge | ⭕ | 成果 HTML → PDF |',
  '',
  '```bash',
  'pip install markitdown',
  '```',
  '',
  '## 启动',
  '',
  '```bash',
  '# Windows',
  'setx DEEPSEEK_API_KEY "sk-..."',
  '# Linux / macOS',
  'export DEEPSEEK_API_KEY="sk-..."',
  '',
  'cd web',
  'node server.mjs          # 默认 8787 端口，PORT 环境变量可改',
  '```',
  '',
  '## 自检',
  '',
  '改过对应模块后跑一遍，前四项零 API 调用：',
  '',
  '```bash',
  'node engine/test-timing.mjs      # 27 项：计费时段与调度',
  'node engine/test-duplicate.mjs   # 20 项：重复审核查重',
  'node engine/test-standards.mjs   # 15 项：标准规范引用规则',
  'node engine/test-feedback.mjs    # 35 项：经验作用域与多条口径',
  'node engine/test-cancel.mjs      # 12 项：取消竞态与队列名额（需服务在跑）',
  'node engine/test-login-guard.mjs # 22 项：登录防护（需服务在跑）',
  '```',
  '',
  '## 说明',
  '',
  '- 本仓库**只含代码**：不含审核数据、账号、技能知识库（那些属于业务资产，不进版本库）',
  '- 需要配套一份「审核技能文件」（Markdown 形式的知识体系）放在 skill/ 下才能实际审核；',
  '  技能内容与具体专业领域强相关，不在本仓库',
  '- AI 仅作初审，不能替代专家终审',
  '',
  '版本：v' + version,
  ''
].join('\n');
fs.writeFileSync(path.join(DEST, 'README.md'), README, 'utf8');
log('      ✓ README.md（面向外部，脚本生成）');

// 5) 自检：确认副本里没有敏感残留
log('\n[5/5] 自检：扫描副本里是否还有敏感内容…');
const { execFileSync } = await import('node:child_process');
const scanFor = (re, label) => {
  const hits = [];
  const walk2 = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk2(p); continue; }
      if (!/\.(mjs|js|cjs|html|ps1|md|txt|json)$/i.test(e.name)) continue;
      const c = fs.readFileSync(p, 'utf8');
      if (re.test(c)) hits.push(path.relative(DEST, p));
    }
  };
  walk2(DEST);
  return { label, hits };
};
const checks = [
  scanFor(/10\.81\.\d+\.\d+/, '公司内网 IP'),
  scanFor(/张三|李四|赵六|孙七|曹八/, '员工姓名'),
  scanFor(/sk-[a-zA-Z0-9]{20,}/, '疑似 API Key'),
  // 公司全称是有意保留的品牌信息（自家产品），单独提示，不算失败
  scanFor(/河南油田工程科技股份有限公司/, '公司全称（界面品牌，有意保留）'),
];
let bad = 0;
for (const c of checks) {
  const soft = c.label.includes('有意保留');
  if (c.hits.length) { log(`      ${soft ? '·' : '⚠'} ${c.label}：${c.hits.length} 个文件 → ${c.hits.slice(0, 5).join('、')}`); if (!soft) bad += c.hits.length; }
  else log(`      ✓ 无「${c.label}」`);
}

log('');
log('═══════════════════════════════════════════════════');
if (bad) log(`  ⚠ 自检发现 ${bad} 处残留，检查上面列出的规则再重跑`);
else log('  ✓ 自检通过');

// 记录本次发布的源文件指纹，供下次 --status 比对，判断源文件是否改动。
// 比对对象是源文件指纹而非副本（副本经过脱敏，本就应与源不同）。
try {
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    version, at: new Date().toISOString(), dest: DEST, scrubRules: scrubbed, files: sourceFingerprint(),
  }, null, 2), 'utf8');
  log(`  ✓ 已记录发布状态（供 --status 比对）`);
} catch (e) { log(`  ⚠ 发布状态记录失败（不影响发布）：${e.message}`); }

log(`  发布副本：${DEST}`);
log('');
log('  下一步（在副本目录里执行）：');
log('    cd "' + DEST + '"');
log('    git add -A');
log('    git commit -m "更新说明"');
log('    git push');
log('');
log('  以后想知道「该不该重新发布」，跑：node 运维\\publish.mjs --status');
log('═══════════════════════════════════════════════════');
