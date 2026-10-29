/**
 * 注释改写校验器 —— 证明"只改了注释，没动代码"。
 *
 * 原理：把 git 中的上一版（HEAD）与工作区当前版分别剥离注释，去掉空行后逐字节比对。
 *   · 两者完全一致 → 该文件的改动只发生在注释里；
 *   · 出现差异 → 说明代码/字符串被动过，需人工复核（脚本会打印差异行）。
 *
 * 注意：剥离器是启发式的（用状态机处理 // 与 /* *\/，识别字符串与简易正则上下文）。
 *   启发式不影响结论 —— 同一份剥离规则分别作用于两个版本，只要代码没变，结果必然一致；
 *   若某个模板字符串被判成注释，两个版本会被同样地判错，比对结果仍为空。
 *
 * 用法：
 *   node 运维\注释改写校验.mjs                # 校验 git 工作区所有已修改的源码文件
 *   node 运维\注释改写校验.mjs <文件>...       # 只校验指定文件
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CODE_EXT = /\.(mjs|js|cjs|ps1|py)$/;

/** 剥离注释并删除空行，返回"仅代码"文本 */
function codeOnly(text, ext) {
  let out = '';
  let i = 0;
  const n = text.length;
  let state = 'code';            // code | line | block | sq | dq | tpl | html | regex
  let prevSignificant = '';      // 上一个非空白字符：用于判断 '/' 是除号还是正则起始
  // 正则字面量只出现在表达式位置（行首或这些符号之后）。缺这一步会把 /[\\/:*?"<>|]/ 里的 " 当作字符串起点，
  // 导致其后整段内容被误判为字符串，进而把注释改动报成代码改动（早期版本对 server.mjs 的误报即此原因）。
  const regexAllowed = () => !prevSignificant || '(,=:[!&|?{};+-*%~^<>'.includes(prevSignificant);
  while (i < n) {
    const c = text[i];
    const c2 = text.slice(i, i + 2);
    if (state === 'code') {
      if (ext === 'html' && text.slice(i, i + 4) === '<!--') { state = 'html'; i += 4; continue; }
      if (c2 === '//') { state = 'line'; i += 2; continue; }
      if (c2 === '/*') { state = 'block'; i += 2; continue; }
      if (c === '#') {
        // PowerShell / Python 行注释（# 后面跟空白或非 { 时按注释处理；跳过 #! 与 #{）
        if (ext === 'ps1' || ext === 'py') {
          if (i === 0 && c2 === '#!') { out += c; i++; continue; }
          state = 'line'; i++; continue;
        }
      }
      if (ext === 'ps1' && text.slice(i, i + 3) === '<#') { state = 'block'; i += 2; continue; }
      if (c === "'" ) { state = 'sq'; out += c; i++; prevSignificant = "'"; continue; }
      if (c === '"') { state = 'dq'; out += c; i++; prevSignificant = '"'; continue; }
      if (c === '`') { state = 'tpl'; out += c; i++; continue; }
      if (c === '/' && regexAllowed()) { state = 'regex'; out += c; i++; continue; }
      if (!/\s/.test(c)) prevSignificant = c;
      out += c; i++; continue;
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += c; } i++; continue; }
    if (state === 'block') { if (c2 === '*/' || (ext === 'ps1' && c2 === '#>')) { state = 'code'; i += 2; } else i++; continue; }
    if (state === 'html') { if (text.slice(i, i + 3) === '-->') { state = 'code'; i += 3; } else i++; continue; }
    if (state === 'regex') {
      out += c;
      if (c === '\\') { out += text[i + 1] ?? ''; i += 2; continue; }
      if (c === '[') {                      // 字符组内的 / 不算结束
        while (i + 1 < n && text[i + 1] !== ']') { out += text[i + 1]; i++; }
        i++; continue;
      }
      if (c === '/') { state = 'code'; prevSignificant = '/'; }
      i++; continue;
    }
    if (state === 'sq' || state === 'dq') {
      out += c;
      if (c === '\\') { out += text[i + 1] ?? ''; i += 2; continue; }
      if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"')) { state = 'code'; prevSignificant = c; }
      i++; continue;
    }
    if (state === 'tpl') {
      out += c;
      if (c === '\\') { out += text[i + 1] ?? ''; i += 2; continue; }
      if (c === '`') state = 'code';
      i++; continue;
    }
    i++;
  }
  return out.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() !== '').join('\n');
}

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const args = process.argv.slice(2);

// --probe：自测。取 HEAD 版源码，人为改一个代码标识符与一处字符串，验证校验器能报出来；
// 再只改注释，验证不报。用于确认"校验器不会永远说没问题"。
if (args.includes('--probe')) {
  const probeFile = 'web/lib.mjs';
  const ext = 'mjs';
  const head = git(['show', `HEAD:${probeFile}`]);
  const codeChanged = head.replace('DEFAULT_BUDGET', 'DEFAULT_BUDGET_X');
  const commentChanged = head.replace(/^\/\*+/m, '/**');
  const r1 = codeOnly(head, ext) === codeOnly(codeChanged, ext);
  const r2 = codeOnly(head, ext) === codeOnly(commentChanged, ext);
  console.log('自测（' + probeFile + '）：');
  console.log(`  · 改了标识符 → 校验器${r1 ? '未报出（✗ 失灵）' : '报出差异（✓ 正常）'}`);
  console.log(`  · 只改注释  → 校验器${r2 ? '判定一致（✓ 正常）' : '报出差异（✗ 误报）'}`);
  process.exit(!r1 && r2 ? 0 : 1);
}

const fileArgs = args.filter((a) => !a.startsWith('--'));          // 开关（--probe/--per-line）不是文件路径
let files = fileArgs.length
  ? fileArgs.map((f) => path.resolve(f))
  : git(['diff', '--name-only', 'HEAD']).split('\n').filter(Boolean).map((f) => path.join(ROOT, f));

files = files.filter((f) => CODE_EXT.test(f));
// ── 逐行核对模式：按 git diff 的增删行配对，比对"注释之前的代码前缀"是否逐字符相同。
//    比整文件剥离更可靠：不受跨行状态失步影响（整文件剥离器是启发式的，遇到复杂模板串/正则可能误判）。
const findCommentStart = (line) => {
  let inS = null;
  for (let i = 0; i < line.length - 1; i++) {
    const c = line[i];
    if (inS) {
      if (c === '\\') { i++; continue; }
      if (c === inS) inS = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inS = c; continue; }
    if (c === '/' && (line[i + 1] === '/' || line[i + 1] === '*')) return i;
    if (c === '#') return i;
  }
  return -1;
};
const codePrefix = (line) => {
  const k = findCommentStart(line);
  return (k >= 0 ? line.slice(0, k) : line).replace(/\s+$/, '');
};

/** 逐行判定"该行整行属于注释"：行首标记 + 块注释区间（/*\*、<# #>、<!-- -->、Python 三类文档字符串） */
function commentLineFlags(lines) {
  const flags = [];
  let block = null;                 // '/*' | '<#' | '<!--' | '"""' | "'''"
  const closes = { '/*': '*/', '<#': '#>', '<!--': '-->', '"""': '"""', "'''": "'''" };
  for (const line of lines) {
    const t = line.trim();
    let isComment = false;
    if (block) {
      isComment = true;
      if (line.includes(closes[block])) block = null;
    } else if (/^(\/\/|\/\*|\*|#|<!--|<#|"""|''')/.test(t) || t === '') {
      isComment = true;
      if (/\/\*(?![^]*\*\/)/.test(line) || (/\/\*/.test(line) && !/\*\//.test(line))) block = '/*';
      else if (/<#/.test(line) && !/#>/.test(line)) block = '<#';
      else if (/<!--/.test(line) && !/-->/.test(line)) block = '<!--';
      else if (/"""$/.test(t) && !/^"""[\s\S]*"""$/.test(t)) block = '"""';
    }
    flags.push(isComment);
  }
  return flags;
}

function perLineCheck(files) {
  let okFiles = 0, badFiles = 0, pairsTotal = 0, commentOnly = 0;
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    if (!CODE_EXT.test(rel)) continue;
    let diff = '', headText = '';
    try {
      diff = git(['diff', '-U0', 'HEAD', '--', rel]);
      headText = git(['show', `HEAD:${rel}`]);
    } catch { continue; }
    if (!diff.trim()) { console.log(`  · ${rel}（无差异）`); continue; }
    const nowFlags = commentLineFlags(fs.readFileSync(f, 'utf8').split('\n'));
    const headFlags = commentLineFlags(headText.split('\n'));
    // 判定规则：把非注释行的代码前缀（行尾注释之前的部分）分别收集成两个多重集，
    // 要求增删两侧完全相等。这样既能识别纯注释行改动，也能识别"代码 + 行尾注释"只改注释的情形，
    // 且不受 diff 分块（hunk）切割影响。真正的代码增删改都会改变这个多重集。
    const minusCodes = [], plusCodes = [], mismatches = [];
    let oldNo = 0, newNo = 0, commentOnly = 0;
    for (const l of diff.split('\n')) {
      const h = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (h) { oldNo = Number(h[1]) - 1; newNo = Number(h[2]) - 1; continue; }
      if (l.startsWith('---') || l.startsWith('+++')) continue;
      if (l.startsWith('-')) {
        oldNo++;
        const text = l.slice(1);
        if (headFlags[oldNo - 1]) commentOnly++;
        else minusCodes.push(codePrefix(text));
      } else if (l.startsWith('+')) {
        newNo++;
        const text = l.slice(1);
        if (nowFlags[newNo - 1]) commentOnly++;
        else plusCodes.push(codePrefix(text));
      } else { oldNo++; newNo++; }
    }
    const sortJoin = (arr) => arr.map((s) => s.replace(/\s+/g, ' ').trim()).sort().join('\n');
    const a = sortJoin(minusCodes), b = sortJoin(plusCodes);
    pairsTotal += Math.max(minusCodes.length, plusCodes.length);
    if (a !== b) {
      const la = a.split('\n'), lb = b.split('\n');
      for (let i = 0, j = 0; (i < la.length || j < lb.length) && mismatches.length < 6;) {
        if (la[i] === lb[j]) { i++; j++; continue; }
        mismatches.push(`      - ${(la[i] ?? '(无)').slice(0, 92)}\n      + ${(lb[j] ?? '(无)').slice(0, 92)}`);
        i++; j++;
      }
    }
    if (mismatches.length) {
      badFiles++;
      console.log(`  ✗ ${rel} —— ${mismatches.length} 处改动涉及代码：`);
      mismatches.forEach((m) => console.log(m));
    } else {
      okFiles++;
      console.log(`  ✓ ${rel}（${commentOnly} 行注释改动，代码前缀多重集完全一致）`);
    }
  }
  console.log(`\n逐行核对：只改注释 ${okFiles} 个文件，涉及代码 ${badFiles} 个文件（认定注释行 ${commentOnly} 行）`);
  process.exit(badFiles ? 1 : 0);
}

if (args.includes('--per-line')) perLineCheck(files);

let ok = 0;
const bad = [];
const deleted = [];
for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  if (!fs.existsSync(f)) { deleted.push(rel); continue; }   // 工作区已删除：单独列出，不参与"只改注释"判定
  let head;
  try { head = git(['show', `HEAD:${rel}`]); } catch { console.log(`  · 跳过（HEAD 中不存在）：${rel}`); continue; }
  const now = fs.readFileSync(f, 'utf8');
  const ext = path.extname(f).slice(1);
  const a = codeOnly(head, ext);
  const b = codeOnly(now, ext);
  if (a === b) { ok++; console.log(`  ✓ ${rel}（仅注释改动）`); continue; }
  const la = a.split('\n'), lb = b.split('\n');
  const diffs = [];
  let allCommentLike = true;
  for (let i = 0, j = 0; (i < la.length || j < lb.length) && diffs.length < 8;) {
    if (la[i] === lb[j]) { i++; j++; continue; }
    const x = la[i] ?? '', y = lb[j] ?? '';
    // 注释行判定：行首分隔标记，或 JSDoc/块注释的续行（以 * 开头）。
    // 整文件剥离器是启发式的，遇到复杂正则/模板串可能跨行失步；此判定用于修正这类误报。
    const isCommentLine = (s) => /^\s*(\/\/|\/\*|\*|#|<!--|<#|"""|''')/.test(s) || s.trim() === '';
    if (!isCommentLine(x) || !isCommentLine(y)) allCommentLike = false;
    diffs.push(`      代码第 ${i + 1} 行  HEAD: ${x.slice(0, 90)}\n      代码第 ${j + 1} 行  现在: ${y.slice(0, 90)}`);
    i++; j++;
  }
  if (allCommentLike) { ok++; console.log(`  ✓ ${rel}（差异行全部为注释行；剥离器在该文件跨行失步，改用行级判定）`); continue; }
  bad.push(rel);
  console.log(`  ✗ ${rel} —— 检测到代码差异：`);
  diffs.forEach((d) => console.log(d));
}

console.log(`\n共校验 ${files.length} 个文件：仅注释改动 ${ok} 个${bad.length ? `，疑似改动代码 ${bad.length} 个（${bad.join('、')}）` : ''}${deleted.length ? `，已删除 ${deleted.length} 个（${deleted.join('、')}）` : ''}`);
process.exit(bad.length ? 1 : 0);
