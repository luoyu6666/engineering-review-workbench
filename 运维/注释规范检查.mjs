/**
 * 注释规范检查器 —— 扫描源码里**真正的注释**是否还带表情符号、Markdown 标记与口语化/归因表述。
 *
 * 用法：
 *   node 运维\注释规范检查.mjs              # 扫描全部源码（排除数据目录、生成物、第三方目录）
 *   node 运维\注释规范检查.mjs web\lib.mjs  # 只查指定文件
 *
 * 退出码：0 = 无违规；1 = 有硬性违规；2 = 只有提示级问题。
 *
 * 实现要点：用状态机区分**注释**与**字符串**（含模板串、正则字面量、.ps1 的 <# #>、HTML 注释）。
 *   早期版本按行找 `//` 判断注释，会把字符串里的内容误当注释 —— 例如提示词模板里的
 *   `**不要逐条复述问题清单**`（属程序数据，不得修改）与脱敏脚本的替换模板。
 *   规则依据见 运维\注释规范.md。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXCLUDE = /(\\(node_modules|web\\data|运维\\预览|运维\\staff-guide\\raw|运维\\staff-guide\\annotated|运维\\手册素材|产出|runs|测试样本|软著申报V1\.0|演示环境|\.git)\\)/;

/** 硬性违规：必须为 0 */
const HARD = [
  [/[\u26A0\u2B50\u2705\u274C\u26D4\u2728\u2B06\u2B07\u27A1\uFE0F]/, '表情/特殊符号（如 ⚠ ★ ✓ ✗）'],
  [/\*\*[^*\n]+\*\*/, 'Markdown 粗体 **…**'],
  [/踩过|踩到|白折腾|翻车|越看越糊涂|说白了|反正|干脆|顺手|白干|假装|谁也不知道/, '口语化叙事（踩过/干脆/假装…）'],
  [/用户(要求|报|反馈|原话|明确要求|定)/, '归因表述（用户要求/用户报的），应改为日期 + 中性事实'],
  [/同事/, '口语称呼「同事」，应改为「使用方」'],
  [/(?<![一-龥])(我们|咱们)(?![一-龥])/, '第一人称（我们/咱们）'],
  [/！！|!{2,}/, '重复感叹号'],
  [/值得记住|不得不说|讲道理/, '情绪化表述'],
];
/** 提示级：建议改，不阻断 */
const SOFT = [
  [/兜底/, '建议改为「回退/保底」'],
  [/(?<![一-龥])实测(?![一-龥])/, '建议改为「经实测/经验证」'],
  [/(?<![一-龥])没人(?![一-龥])/, '建议改为「无任何角色」'],
  [/非常|极其/, '夸张副词'],
];

/** 状态机：提取注释片段（含起始行号），并跳过字符串、模板串与正则字面量 */
function commentSegments(text, ext) {
  const segs = [];
  let line = 1, buf = '', bufLine = 1, state = 'code';
  let prev = '';                       // 上一个非空白字符，用于判断 `/` 是否为正则起始
  const n = text.length;
  const push = () => { if (buf.trim()) segs.push({ line: bufLine, text: buf }); buf = ''; };
  const regexAllowed = () => !prev || '(,=:[!&|?{};+-*%~^<>'.includes(prev);

  for (let i = 0; i < n; i++) {
    const c = text[i], c2 = text.slice(i, i + 2);
    if (c === '\n') line++;
    if (state === 'code') {
      if (ext === 'html' && text.startsWith('<!--', i)) { state = 'html'; bufLine = line; i += 3; continue; }
      if (ext === 'ps1' && text.startsWith('<#', i)) { state = 'block'; bufLine = line; i += 1; continue; }
      if (c2 === '//') { state = 'line'; bufLine = line; i += 1; continue; }
      if (c2 === '/*') { state = 'block'; bufLine = line; i += 1; continue; }
      if ((ext === 'ps1' || ext === 'py') && c === '#') { state = 'line'; bufLine = line; continue; }
      if (c === "'") { state = 'sq'; prev = c; continue; }
      if (c === '"') { state = 'dq'; prev = c; continue; }
      if (c === '`') { state = 'tpl'; prev = c; continue; }
      if (c === '/' && regexAllowed()) { state = 'regex'; continue; }
      if (!/\s/.test(c)) prev = c;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') { push(); state = 'code'; continue; }
      buf += c; continue;
    }
    if (state === 'block') {
      if (c2 === '*/' || (ext === 'ps1' && c2 === '#>')) { push(); state = 'code'; i += 1; continue; }
      buf += c === '\n' ? '\n' : c; continue;
    }
    if (state === 'html') {
      if (text.startsWith('-->', i)) { push(); state = 'code'; i += 2; continue; }
      buf += c; continue;
    }
    if (state === 'sq' || state === 'dq') {
      if (c === '\\') { i++; continue; }
      if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"')) { state = 'code'; prev = c; }
      continue;
    }
    if (state === 'tpl') {
      if (c === '\\') { i++; continue; }
      if (c === '`') { state = 'code'; prev = c; }
      continue;
    }
    if (state === 'regex') {
      if (c === '\\') { i++; continue; }
      if (c === '[') { while (i < n && text[i] !== ']') { if (text[i] === '\\') i++; i++; if (text[i] === '\n') line++; } continue; }
      if (c === '/') { state = 'code'; prev = '/'; }
      continue;
    }
  }
  push();
  return segs;
}

const listFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return EXCLUDE.test(p) ? [] : listFiles(p);
  return /\.(mjs|js|cjs|ps1|py|html)$/.test(e.name) && !/注释规范检查/.test(e.name) ? [p] : [];
});

const targets = process.argv.length > 2 ? process.argv.slice(2).map((f) => path.resolve(f)) : listFiles(ROOT);

let hard = 0, soft = 0, scanned = 0;
const hardHits = [], softHits = [];
for (const f of targets) {
  if (!fs.existsSync(f)) continue;
  scanned++;
  const ext = path.extname(f).slice(1);
  const rel = f.replace(ROOT + path.sep, '');
  for (const seg of commentSegments(fs.readFileSync(f, 'utf8'), ext)) {
    const flat = seg.text.replace(/\s+/g, ' ');
    const startLine = seg.line;
    for (const [re, name] of HARD) if (re.test(flat)) { hard++; hardHits.push(`${rel}:${startLine}  ${name}`); }
    for (const [re, name] of SOFT) if (re.test(flat)) { soft++; softHits.push(`${rel}:${startLine}  ${name}`); }
  }
}

console.log(`扫描 ${scanned} 个文件`);
if (hardHits.length) {
  console.log(`\n✗ 硬性违规 ${hard} 处：`);
  hardHits.slice(0, 60).forEach((x) => console.log('  ' + x));
  if (hardHits.length > 60) console.log(`  …另有 ${hardHits.length - 60} 处`);
}
if (softHits.length) {
  console.log(`\n· 提示级 ${soft} 处（建议改）：`);
  softHits.slice(0, 20).forEach((x) => console.log('  ' + x));
  if (softHits.length > 20) console.log(`  …另有 ${softHits.length - 20} 处`);
}
if (!hardHits.length && !softHits.length) console.log('✓ 无违规，注释符合规范');
process.exit(hardHits.length ? 1 : (softHits.length ? 2 : 0));
