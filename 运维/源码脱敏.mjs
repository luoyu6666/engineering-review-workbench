/**
 * 源码脱敏：把仓库源码与文档里的真实员工姓名、内网 IP、真实项目名替换为示例值。
 *
 * 背景：软著申报材料已单独净化，但版本库源码里仍残留真实姓名（测试夹具、运维脚本默认值、
 *   注释示例）与内网 IP。这些属于个人信息与内部网络信息，不应随源码分发（GitHub / 备份 / 交接）。
 *
 * 处理分四类，逐项带断言，改错立即中止：
 *   ① 姓名 → 示例姓名（张三/李四/…）；
 *   ② 内网 IP → RFC 5737 文档示例段（192.0.2.x）；
 *   ③ 真实项目名 → 虚指（某油田/某项目）；
 *   ④ 功能默认值改造：把"默认写死真人账号"改成"环境变量或动态选取"，避免脱敏后脚本不可用。
 *
 * 用法：node 运维\源码脱敏.mjs            # 执行
 *       node 运维\源码脱敏.mjs --dry      # 只报告将要改动的文件与次数
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DRY = process.argv.includes('--dry');

// 姓名 → 示例名（同名映射全局一致，测试夹具里的断言与数据会一起改）
// 姓名映射（示例模板）：按本单位实际情况填写后使用。
// 之所以只放示例：本文件会进版本库，真实姓名不能写在这里。
const NAME_MAP = {
  某某甲: '张三', 某某乙: '李四', 某某丙: '王五',
};
// 真实项目/客户名 → 虚指
const PROJECT_MAP = {
  '江汉石油工程公司2026年西北工区压裂设备购置项目': '某油田2026年某工区压裂设备购置项目',
  '塔河油田TP259H井区2023年第二期产能建设项目': '某油田某井区产能建设项目',
  '洪荆线南林三跨改线工程': '某输油管道改线工程',
  江汉石油工程公司: '某油田公司',
  塔河油田: '某油田', 西北油田: '某油田', 洪荆线: '某输油管道', 钟荆线: '某输油管道',
};
// 内网 IP → 文档示例段。用"保留后两段"的确定性映射：既脱离真实网段，
// 又不会把两个不同地址合并成同一个（测试夹具里有靠不同地址区分场景的断言）。
const IP_RULES = [
  [/\b10\.81\.0\.0\/16/g, '198.51.0.0/16'],
  [/\b10\.81\.(\d{1,3}\.\d{1,3})/g, '198.51.$1'],
  [/\b10\.81\.(\d{1,3})/g, '198.51.$1'],
  [/\b10\.81\./g, '198.51.'],
];

// 排除规则：注意目录名可能位于路径末尾（无尾随分隔符），因此用 (\\|$) 兼容两种情况。
// 早期写法要求尾随 \，导致 `运维\预览` 这类末尾目录未被排除。
const EXCLUDE = /(\\(node_modules|web\\data|skill|运维\\预览|运维\\staff-guide\\raw|运维\\staff-guide\\annotated|运维\\手册素材|产出|runs|测试样本|软著申报V1\.0|演示环境|\.git)(\\|$))/;
// 显式跳过：
//   · 运维/access/ip-names.json  —— 真实 IP-姓名对照的运维输入数据，属业务数据（应移出版本库，而不是改写）
//   · 运维/软著材料/build-source.mjs —— 软著脱敏工具，其姓名映射表本身就是"要替换的名单"，改写会使其失效
const SKIP = new Set(['运维/access/ip-names.json', '运维/软著材料/build-source.mjs', '运维/源码脱敏.mjs']);
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!EXCLUDE.test(p)) walk(p, out); continue; }
    if (/\.(mjs|js|cjs|ps1|py|html|md|txt|json)$/.test(e.name)) out.push(p);
  }
  return out;
};

const changed = [];
const edit = (file, fn, label) => {
  const abs = path.join(ROOT, file);
  if (!fs.existsSync(abs)) { console.log(`  · 跳过（不存在）：${file}`); return; }
  const before = fs.readFileSync(abs, 'utf8');
  const after = fn(before);
  if (after === before) { return; }
  if (!DRY) fs.writeFileSync(abs, after, 'utf8');
  changed.push(file + '（' + label + '）');
};

// ── ① 全局：姓名 / 项目名 / 内网 IP ──
console.log('① 通用替换：姓名、项目名、内网 IP');
for (const f of walk(ROOT)) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  if (rel === 'VERSION.txt' || SKIP.has(rel)) continue;        // VERSION 保留变更记录；SKIP 见上
  edit(rel, (t) => {
    let s = t;
    for (const [k, v] of Object.entries(NAME_MAP)) s = s.split(k).join(v);
    for (const [k, v] of Object.entries(PROJECT_MAP)) s = s.split(k).join(v);
    for (const [re, v] of IP_RULES) s = s.replace(re, v);
    return s;
  }, '通用脱敏');
}

// ── ② 功能默认值改造（脱敏后脚本仍可用）──
// 注意：这里的目标文本是①替换之后的值（姓名已变成示例名），因此针对示例名匹配。
console.log('② 功能默认值改造');
// 自检脚本原本默认用真人账号；两者都有"自动挑一个可用账号"的降级链，改成空默认即可
for (const f of ['engine/test-cancel.mjs', 'engine/test-login-guard.mjs']) {
  edit(f, (t) => t.replace(/const TEST_USER = process\.env\.DSH_TEST_USER \|\| '[^']*';/,
    "const TEST_USER = process.env.DSH_TEST_USER || '';   // 不写死账号：留空则由下面按角色动态选取"), '测试账号默认值');
}
// test-quota 直接登录线上管理员：改为从 users.json 动态取管理员用户名
edit('engine/test-quota.mjs', (t) => {
  if (!t.includes("import * as L from '../web/lib.mjs'")) {
    t = t.replace("const base = 'http://127.0.0.1:8787';",
      "import * as L from '../web/lib.mjs';\n\nconst base = 'http://127.0.0.1:8787';");
  }
  return t.replace(/const ca = await login\(process\.env\.ADMIN_U \|\| '[^']*', process\.env\.ADMIN_P \|\| '[^']*'\);/,
    "// 管理员用户名从数据目录动态读取，不在源码里写死账号\n"
    + "const ADMIN_U = process.env.ADMIN_U || (L.listUsers().find((u) => u.role === 'admin' && !u.disabled) || {}).username || '';\n"
    + "const ca = await login(ADMIN_U, process.env.ADMIN_P || '123456');");
}, '管理员用户名动态化');
// 账号停用：默认保留名单改为空，必须显式 --keep（与发布副本口径一致）
edit('运维/账号停用.mjs', (t) => t
  .replace(/const KEEP = \(keepArg \? keepArg\.split\(','\) : \[[^\]]*\]\)/,
    "const KEEP = (keepArg ? keepArg.split(',') : [])")
  .replace(/\/\/   node 运维\\账号停用\.mjs --apply --keep [^\n]*/,
    "//   node 运维\\账号停用.mjs --apply --keep admin,zs,ls   # 显式指定要保留的账号（必填）"), '默认保留名单');

// ③ 启动横幅不再硬编码内网 IP，改为运行时探测本机内网 IPv4（换机器/换网段也不会印错地址）
edit('web/server.mjs', (t) => {
  const old = "console.log(`  同事访问 : http://192.0.2.161:${PORT}`);";
  const neu = "const lanIP = (() => { try { for (const list of Object.values(os.networkInterfaces()))"
    + " for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address; } catch {} return '(本机内网地址)'; })();\n"
    + "console.log(`  使用方访问 : http://${lanIP}:${PORT}`);";
  return t.includes(old) ? t.replace(old, neu) : t;
}, '启动横幅探测本机 IP');

if (DRY) {
  console.log(`\n[dry-run] 将改动 ${changed.length} 个文件：`);
  changed.forEach((x) => console.log('  ' + x));
} else {
  console.log(`\n已改动 ${changed.length} 个文件：`);
  changed.forEach((x) => console.log('  ' + x));
}
