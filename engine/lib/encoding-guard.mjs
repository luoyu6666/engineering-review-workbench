/**
 * 编码自检 —— 防止「UTF-8 文件被按 GBK 读进来、再写回去」把中文写成乱码。
 *
 * 模块由来（2026-09-24 事故）：
 *   曾用 PowerShell `Get-Content -Raw` + `[IO.File]::WriteAllText` 改
 *   `web/public/index.html`。Windows PowerShell 5.1 默认按系统 ANSI(GBK) 解码
 *   UTF-8 文件，中文全部错码，写回后 635 行被洗坏 —— 前端界面异常、脚本报错。
 *   两条约束：
 *     ① 改文件内容只用 edit/write 工具，不用 PowerShell 读写文本内容；
 *     ② 人工记忆不可靠，必须有机器闸门 —— 即本模块（回退手段）。
 *
 * 两道检查：
 *   ① U+FFFD（�）：解码失败时留下的替换字符。它是字节级铁证，出现即坏。
 *   ② GBK 乱码特征字：UTF-8 的中文字节被当 GBK 解出来，结果只会落在极少数生僻字上
 *      （锟/鈥/锛/鐨/鍜/鏄…）。正常的简体技术文档和界面文案里几乎不出现这些字，
 *      一旦成串出现，就是被 GBK 往返洗过。
 *
 * 分级（为什么分两级而不是一刀切）：
 *   · error —— 服务拒绝启动。界面坏了比停服更难查，宁可停在那儿报出来。
 *   · warn  —— 只打提示。"拷贝"里的"拷"是真词，单个特征字不能当成铁证误伤。
 *
 * 排除规则（同样重要，否则自检自己会误报）：
 *   · `test-*.mjs`：自检夹具里故意写着乱码样本，扫它必然报错；
 *   · `data/`、`node_modules/`、备份目录：不是源码，且可能存着历史坏文件；
 *   · `.md` 文档：本模块默认不扫（规格文档里本来就要引用乱码字做说明）。
 *     CLI 加 `--docs` 才扫，且一律降为提示级。
 *
 * 用法：
 *   node engine\lib\encoding-guard.mjs              # 体检源码与界面文件
 *   node engine\lib\encoding-guard.mjs --docs       # 连文档一起体检（提示级）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 项目根目录（本文件在 engine/lib/ 下，往上两级） */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 默认扫描的文件类型：会被浏览器渲染、会被 node 执行的，乱码后果最严重 */
export const DEFAULT_EXTS = ['.html', '.js', '.mjs', '.css', '.json'];

/** 默认扫描的目录（相对项目根） */
export const DEFAULT_ROOT_DIRS = ['web/public', 'web', 'engine'];

/**
 * 必须跳过的文件：本模块自己。
 * 原因：它必须把乱码特征字原样写进源码（否则没法拿它们做匹配），
 * 于是它天然含有一整串特征字，扫自己必然报错。代价是"闸门自身被洗坏"扫不出来，
 * 所以由 test-encoding.mjs 断言特征字集合的内容来补这一层。
 */
export const EXCLUDE_FILES = new Set(['encoding-guard.mjs']);

/** 永远跳过的目录名 */
export const DEFAULT_EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'data', '运维', '样本', 'skill', '附件', '备份',
]);

/**
 * GBK 乱码"特征字"：UTF-8 中文被 GBK 解码后的产物，正常简体文本里几乎不出现。
 * 单独出现不足以定罪（"拷贝"含"拷"），成串出现即定案。
 */
export const STRONG = new Set([...'锟鈥锛銆鐨鍜鏄鏂鎴镐绛缃缂鐢璁閫鍒鍥绠鏌']);
/** 更弱的特征字：本身是正常字，但在乱码里高频出现 */
export const WEAK = new Set([...'拷涓鍙']);
/** 经典整串乱码：出现即坏 */
export const SIGNATURE = '锟斤拷';

/** 一行里最多截取多少字符作为证据片段 */
const SNIPPET = 90;

/** 从一行文本里取一段证据（围绕第一个命中位置） */
function snippetOf(line, at) {
  const s = Math.max(0, at - 30);
  const t = line.slice(s, s + SNIPPET).replace(/\s+/g, ' ');
  return (s > 0 ? '…' : '') + t + (s + SNIPPET < line.length ? '…' : '');
}

/**
 * 扫描一段文本，返回发现的问题。
 *
 * @param {string} text 待扫描文本
 * @param {{file?: string, severity?: 'error'|'warn'}} [opt] severity 用于把文档降级为提示
 * @returns {Array<{file:string,line:number,col:number,kind:string,severity:string,text:string}>}
 */
export function scanText(text, { file = '<inline>', severity = 'error' } = {}) {
  const out = [];
  const lines = text.split(/\r?\n/);
  const downgrade = (s) => (severity === 'warn' ? 'warn' : s);
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const lineNo = i + 1;
    const hit = [];

    const rp = ln.indexOf('\uFFFD');
    if (rp >= 0) {
      let n = 0;
      for (const c of ln) if (c === '\uFFFD') n++;
      hit.push({ kind: 'U+FFFD 替换字符', severity: downgrade('error'), col: rp + 1, text: snippetOf(ln, rp), n });
    }

    const sg = ln.indexOf(SIGNATURE);
    if (sg >= 0) {
      hit.push({ kind: '经典乱码串 锟斤拷', severity: downgrade('error'), col: sg + 1, text: snippetOf(ln, sg), n: 1 });
    }

    const strong = [...ln].filter((c) => STRONG.has(c));
    if (strong.length) {
      const distinct = new Set(strong).size;
      // 成串（同行 3 个以上，或同行出现 2 种不同特征字）＝ 定案；孤零零一个 ＝ 提示
      const bad = strong.length >= 3 || distinct >= 2;
      const at = ln.search(new RegExp(`[${[...new Set(strong)].join('')}]`, 'u'));
      hit.push({
        kind: bad ? `GBK 乱码特征字 × ${strong.length}` : '疑似乱码特征字（单个，待人工确认）',
        severity: downgrade(bad ? 'error' : 'warn'),
        col: at + 1,
        text: snippetOf(ln, at < 0 ? 0 : at),
        n: strong.length,
      });
    }

    const weak = [...ln].filter((c) => WEAK.has(c));
    if (!strong.length && weak.length >= 3) {
      const at = ln.search(/[拷涓鍙]/u);
      hit.push({ kind: `弱特征字 × ${weak.length}`, severity: 'warn', col: at + 1, text: snippetOf(ln, at < 0 ? 0 : at), n: weak.length });
    }

    // 同一行里已经有 error 就不再重复报 warn，避免一份坏文件刷屏
    const hasErr = hit.some((h) => h.severity === 'error');
    for (const h of hit) {
      if (hasErr && h.severity === 'warn') continue;
      out.push({ file, line: lineNo, col: h.col, kind: h.kind, severity: h.severity, text: h.text, count: h.n });
    }
  }
  return out;
}

/**
 * 扫描单个文件（按 UTF-8 解码；解码失败会留下 U+FFFD，正好被上面抓到）。
 *
 * @param {string} file 文件路径
 * @param {{severity?: 'error'|'warn'}} [opt]
 * @returns {Array<object>} 发现列表
 */
export function scanFile(file, { severity = 'error' } = {}) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return [{ file, line: 0, col: 0, kind: `读不了：${e.message}`, severity: 'warn', text: '', count: 0 }];
  }
  // 二进制文件（含 NUL）直接跳过：不是我们要管的文本资产
  if (buf.includes(0)) return [];
  return scanText(buf.toString('utf8'), { file, severity });
}

/**
 * 递归收集文件（按扩展名过滤，跳过排除目录与 test- 前缀文件）。
 *
 * @param {object} [o]
 * @param {string[]} [o.roots] 起始目录（相对 baseDir）
 * @param {string[]} [o.exts] 纳入的扩展名
 * @param {Set<string>} [o.excludeDirs] 跳过的目录名
 * @param {Set<string>} [o.excludeFiles] 跳过的文件名
 * @param {string[]} [o.excludeFilePrefixes] 跳过的文件名前缀
 * @param {string} [o.baseDir] 相对路径的基准目录
 * @returns {string[]} 排序后的文件绝对路径
 */
export function collectFiles({
  roots = DEFAULT_ROOT_DIRS,
  exts = DEFAULT_EXTS,
  excludeDirs = DEFAULT_EXCLUDE_DIRS,
  excludeFiles = EXCLUDE_FILES,
  excludeFilePrefixes = ['test-'],
  baseDir = PROJECT_ROOT,
} = {}) {
  const extSet = new Set(exts.map((e) => e.toLowerCase()));
  const files = [];
  // 去重：默认根目录里 `web/public` 是 `web` 的子目录，不去重会把同一文件扫两遍、
  // 错误数翻倍（2026-09-24 经实测：1 处乱码报成 2 处）。用 Set 按绝对路径去重。
  const seen = new Set();
  const walk = (dir) => {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在就当它不存在，别让体检本身报错
    }
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (excludeDirs.has(ent.name)) continue;
        walk(p);
      } else if (ent.isFile()) {
        if (excludeFiles.has(ent.name)) continue;
        if (excludeFilePrefixes.some((pre) => ent.name.startsWith(pre))) continue;
        if (!extSet.has(path.extname(ent.name).toLowerCase())) continue;
        if (seen.has(p)) continue;
        seen.add(p);
        files.push(p);
      }
    }
  };
  for (const r of roots) walk(path.isAbsolute(r) ? r : path.join(baseDir, r));
  return files.sort();
}

/**
 * 体检一批目录。
 *
 * @param {object} [opt] 同 collectFiles 的入参，另可带 severity
 * @returns {{checked:string[], findings:Array, errors:Array, warnings:Array}}
 */
export function scanTree(opt = {}) {
  const severity = opt.severity || 'error';
  const files = collectFiles(opt);
  const findings = [];
  for (const f of files) findings.push(...scanFile(f, { severity }));
  const errors = findings.filter((x) => x.severity === 'error');
  const warnings = findings.filter((x) => x.severity === 'warn');
  return { checked: files, findings, errors, warnings };
}

/**
 * 把体检结果排成可读文字（启动日志和自检都用它）。
 *
 * @param {{errors:Array, warnings:Array}} res scanTree 的结果
 * @param {{max?: number}} [opt] 每类最多列多少条
 * @returns {string}
 */
export function formatScan(res, { max = 20 } = {}) {
  const lines = [];
  const rel = (p) => {
    try {
      return path.relative(PROJECT_ROOT, p) || p;
    } catch {
      return p;
    }
  };
  const show = (arr, cap) => {
    for (const f of arr.slice(0, cap)) {
      lines.push(`    ${rel(f.file)}:${f.line}:${f.col}  ${f.kind}  ${f.text}`);
    }
    if (arr.length > cap) lines.push(`    …另有 ${arr.length - cap} 处`);
  };
  if (res.errors.length) {
    lines.push(`  ✗ 编码体检发现 ${res.errors.length} 处乱码（错误级，会阻断启动）：`);
    show(res.errors, max);
  }
  if (res.warnings.length) {
    lines.push(`  ⚠ 编码体检有 ${res.warnings.length} 处可疑（提示级，不阻断）：`);
    show(res.warnings, Math.min(max, 8));
  }
  return lines.join('\n');
}

/**
 * 有错误级发现就抛异常（供自检与启动闸门调用）。
 *
 * @param {{errors:Array}} res scanTree 的结果
 * @param {{what?: string}} [opt] what 用于错误文案的资产名称
 * @returns {true}
 * @throws {Error} 存在错误级发现
 */
export function assertClean(res, { what = '源码与界面文件' } = {}) {
  if (res.errors.length) {
    throw new Error(`${what}编码体检未通过：${res.errors.length} 处乱码\n${formatScan(res)}`);
  }
  return true;
}

// ─────────────── CLI ───────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const withDocs = process.argv.includes('--docs');
  console.log('编码体检（UTF-8 / GBK 乱码闸门）');
  const res = scanTree();
  console.log(`  已扫 ${res.checked.length} 个文件（${DEFAULT_EXTS.join(' ')}），错误 ${res.errors.length} 处，提示 ${res.warnings.length} 处`);
  if (res.findings.length) console.log(formatScan(res));
  else console.log('  ✓ 干净：没有 U+FFFD，也没有成串的 GBK 乱码特征字');

  if (withDocs) {
    const docs = collectFiles({ roots: ['.', 'skill', '运维'], exts: ['.md'], excludeFilePrefixes: [] });
    let bad = 0;
    for (const f of docs) {
      const found = scanFile(f, { severity: 'warn' }).filter((x) => x.kind.startsWith('U+FFFD'));
      if (found.length) {
        bad += found.length;
        console.log(`  ⚠ 文档乱码（提示级）：${path.relative(PROJECT_ROOT, f)}  共 ${found.length} 处`);
      }
    }
    console.log(bad ? `  文档体检：${bad} 处 U+FFFD（提示级，不影响启动）` : `  ✓ 文档体检：${docs.length} 个 .md 无 U+FFFD`);
  }
  if (res.errors.length) process.exit(1);
}
