/**
 * 原报告标注版 PDF
 *
 * 目的：成果报告是「问题清单」，说得清楚但定位不了 —— 编制人和校对人得拿着清单
 *       在原报告里来回翻。这一版把每条问题直接画在它出现的那个位置上。
 *
 * 流程（不需要任何 PDF 库）：
 *   ① 原文 .docx/.pptx → PDF            LibreOffice，保留原版式与插图
 *   ② 每页 → JPEG                       pdftoppm
 *   ③ 每个词的坐标                       pdftotext -bbox（PDF 有文字层，坐标是准的）
 *   ④ 定位：n-gram 相似度 + 章节收窄      见 locate()，这是本模块的核心
 *   ⑤ 拼 HTML：首页（标注情况说明）+ 逐页（页图 + 彩色标记 + 与框同高的右侧批注）
 *   ⑥ HTML → PDF                        Chrome 打印引擎（@page A4 横向，一页一张）
 *
 * 四档定位（如实标注把握程度，未命中的一律报未定位）：
 *   ① 精确实线框    quote 匹配上（覆盖率 ≥0.55，或连续匹配段够长）
 *   ② 近似虚线框    ≈ 数字指纹命中（表格类引用，模型把几个数重组成一句话）
 *   ③ 章节点线框    § 只定位到该章节/表所在的标题
 *   ④ 未能定位      首页与末页红字列清单：编号 + 类别 + 原文定位 + 问题摘要
 *
 * WARN: 已知限制（必须在成果里如实告知）：
 *   · 扫描件（扫描软件导出的 PDF）没有文字层，取不到坐标 —— 主流程收 .docx/.pptx 原件，不受影响
 *   · markitdown 把表格转成竖线文本，与 PDF 表格排版差异大，表内引用常只能近似定位
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { reportIssueList } from './report-html.mjs';

const pexec = promisify(execFile);

// ─────────────── 外部程序 ───────────────
//
// 2026-09-28: `pdftoppm` / `pdftotext` 原来写成裸名字，靠 PATH 查找。
//    以管理员用户身份运行时能找到 —— 它们在 `Administrator` 的用户级 PATH 里（MikTeX 的 bin）。
//    但生产服务是计划任务以 SYSTEM 身份运行的，只看得到机器级 PATH，里面没有那个目录：
//    → `spawn pdftoppm ENOENT` → 每一次标注版生成都失败（流水线里的预生成与现场生成都失败），
//      而前端每 6 秒重试一次、每次都失败 —— 使用方感受到的是"点了要等、等了还不出来"。
//
// 修法：启动时就把这三个程序解析成绝对路径（env 覆盖 → PATH → 一批常见安装位置），
//      解析不到也不静默失败：给出可执行的修复指引，并在启动横幅里明确报出来（见 toolchainStatus）。
function findExe(envName, bare, candidates) {
  const override = process.env[envName];
  if (override && fs.existsSync(override)) return override;
  // 1) PATH 里找（在以用户身份运行、或已装到机器 PATH 的情况下成立）
  const fromPath = (process.env.PATH || '').split(path.delimiter)
    .filter(Boolean).map(d => path.join(d, bare + '.exe')).find(p => { try { return fs.existsSync(p); } catch { return false; } });
  if (fromPath) return fromPath;
  // 2) 常见安装位置（含"开发者用户装了、SYSTEM 看不到"的那些 —— 这是本次事故的正解）
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
  // 3) 全盘扫 scoop：`C:\Users\<任意用户>\scoop\apps\...`（用户目录名字不固定，写死不可靠）
  try {
    const usersRoot = 'C:\\Users';
    for (const u of fs.readdirSync(usersRoot)) {
      const base = path.join(usersRoot, u, 'scoop', 'shims', bare + '.exe');
      if (fs.existsSync(base)) return base;
      const apps = path.join(usersRoot, u, 'scoop', 'apps');
      if (!fs.existsSync(apps)) continue;
      // 只在 latex / poppler 这类可能带它的包里找，避免全盘遍历
      for (const app of fs.readdirSync(apps)) {
        if (!/latex|poppler|miktex|texlive/i.test(app)) continue;
        const cur = path.join(apps, app, 'current');
        if (!fs.existsSync(cur)) continue;
        const hit = walkFind(cur, bare + '.exe', 6);
        if (hit) return hit;
      }
    }
  } catch { /* ignore */ }
  return '';   // 没找到：交给调用方给出清晰报错（不要退回裸名字，那只会变成 ENOENT）
}

/** 在目录里浅层递归找一个文件名（深度受限，避免全盘扫描拖慢启动） */
function walkFind(dir, name, depth) {
  if (depth < 0) return '';
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return ''; }
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isFile() && it.name.toLowerCase() === name.toLowerCase()) return p;
  }
  for (const it of items) {
    if (!it.isDirectory()) continue;
    const hit = walkFind(path.join(dir, it.name), name, depth - 1);
    if (hit) return hit;
  }
  return '';
}

const SOFFICE = process.env.SOFFICE || [
  'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
].find(p => fs.existsSync(p)) || 'C:\\Program Files\\LibreOffice\\program\\soffice.exe';
const PDFTOPPM = findExe('PDFTOPPM', 'pdftoppm', [
  'C:\\Program Files\\poppler\\Library\\bin\\pdftoppm.exe',
  'C:\\Program Files\\poppler\\bin\\pdftoppm.exe',
  'C:\\poppler\\bin\\pdftoppm.exe',
  'C:\\ProgramData\\chocolatey\\bin\\pdftoppm.exe',
]);
const PDFTOTEXT = findExe('PDFTOTEXT', 'pdftotext', [
  'C:\\Program Files\\poppler\\Library\\bin\\pdftotext.exe',
  'C:\\Program Files\\poppler\\bin\\pdftotext.exe',
  'C:\\poppler\\bin\\pdftotext.exe',
  'C:\\ProgramData\\chocolatey\\bin\\pdftotext.exe',
]);

/** 标注工具链体检结果（启动横幅会打印；缺了就直接说清怎么修） */
export function toolchainStatus() {
  return {
    soffice: { path: SOFFICE, ok: fs.existsSync(SOFFICE) },
    pdftoppm: { path: PDFTOPPM, ok: !!PDFTOPPM && fs.existsSync(PDFTOPPM) },
    pdftotext: { path: PDFTOTEXT, ok: !!PDFTOTEXT && fs.existsSync(PDFTOTEXT) },
    ok: fs.existsSync(SOFFICE) && !!PDFTOPPM && fs.existsSync(PDFTOPPM) && !!PDFTOTEXT && fs.existsSync(PDFTOTEXT),
  };
}
/** 缺工具时的可执行修复指引（一句话，直接照做） */
export function toolchainHint(st = toolchainStatus()) {
  const miss = [];
  if (!st.soffice.ok) miss.push('soffice（装 LibreOffice，或设 SOFFICE=<绝对路径>）');
  if (!st.pdftoppm.ok) miss.push('pdftoppm（装 poppler，或设 PDFTOPPM=<绝对路径>）');
  if (!st.pdftotext.ok) miss.push('pdftotext（同上，设 PDFTOTEXT=<绝对路径>）');
  return miss.length ? '缺：' + miss.join('；') : '';
}

const BROWSERS = [
  process.env.CHROME || '',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

export function findBrowser() {
  return BROWSERS.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

export const DEFAULT_DPI = Number(process.env.ANNOT_DPI || 110);

// ─────────────── 配色（既定口径）───────────────
//
// 实际手工校审时并没有严格区分颜色，这一版按新规矩来：
//   校对类 = 蓝色（不区分程度）；审核类 P0 = 深红、P1 = 橙、P2/P3 = 黄。
export const PROOF_COLOR = '#1668d6';
const DEEP_COLOR = { P0: '#a11212', P1: '#d97500', P2: '#c9a200', P3: '#c9a200' };
export function colorOf(it) {
  return it.cls === 'proofread' ? PROOF_COLOR : (DEEP_COLOR[it.sev] || DEEP_COLOR.P1);
}

// ─────────────── 版面（mm，A4 横向单页）───────────────

const SHEET_W = 297, SHEET_H = 209;
const MARGIN = 5, GUTTER = 6;
const SIDE_MIN = 56;          // 侧栏最小宽度：再窄就改成"图在上、批注在下"
const HDR_H = 8;              // 侧栏页眉占高
const STACK_SIDE_MIN = 44;    // 低于此值才换成上下布局（横版附表仍走左右布局，保证不压缩）
// 批注文字长度候选：先用最长的，放不下再逐级压短；仍然放不下的进"续注页"（那里印全文）
const NOTE_CAPS = [140, 100, 70, 45];

// ─────────────── 文本归一化 ───────────────

/** 归一化：去掉所有空白与标点。模型看到的是 Markdown（表格被打成竖线），
 *  与 PDF 流式文字的标点/断行常对不齐，留着标点会大面积匹配失败。 */
export const norm = (s) => String(s ?? '')
  .replace(/[\s\u3000]/g, '')
  .replace(/（/g, '(').replace(/）/g, ')')
  .replace(/[，。；：、！？,.;:!?"'“”‘’`·—－\-_/\\|\[\]【】]/g, '');

/** 轻归一化：只去空白，保留 4.1.1 / 表4-2 这类编号，用于 location 收窄 */
export const normLite = (s) => String(s ?? '').replace(/[\s\u3000]/g, '').replace(/[–—－]/g, '-');

/**
 * 侧栏批注文字：不写死 15 字（早期固定字数会把问题全被省略号截掉，看不出问题全貌）。
 * 取「问题描述」的第一句，上限 cap（由版面自适应决定）；实在放不下的进续注页印全文。
 */
/**
 * 把"问题描述"拆成若干条：审核结论里多条问题常用「／」分隔。
 * 每一条另起一行，不要挤成一整段（挤在一起读不出版次）。
 */
export function noteParts(it, cap = 600) {
  let d = String(it.description || it.note || it.quote || '').replace(/^【[^】]*】\s*/, '').replace(/\s+/g, ' ').trim();
  // 跨源/多口径类：description 常常只写"在不同位置出现 2 个不同取值"（没出处），
  // 而 quote 里是「值（出处） / 值（出处）」，这类优先用 quote（出处一起印出来）。
  const q = String(it.quote || '').replace(/\s+/g, ' ').trim();
  if (q && /跨源|不同取值|多套值|取值不一致/.test(d) && (q.match(/（[^）]{2,}）/g) || []).length >= 2) d = q;
  if (!d) d = String(it.category || '');
  // WARN: 只按全角「／」或前后带空格的 ASCII `/` 拆：
  //    单位里的斜杠（tCO₂/TJ、元/m³、83元/t）会被误当分隔符 —— 经实测拆成 12 条、每条只剩半句。
  const parts = d.split(/\s*／\s*|\s+\/\s+/).map(s => s.trim()).filter(Boolean);
  const out = parts.length ? parts : [d];
  // 总量封顶（默认 600 字）：只有超长时才在最后一条上截断
  let budget = cap;
  const kept = [];
  for (const p of out) {
    if (budget <= 0) break;
    if (p.length <= budget) { kept.push(p); budget -= p.length; }
    else { kept.push(p.slice(0, Math.max(2, budget - 1)) + '…'); budget = 0; }
  }
  return kept.length ? kept : [d.slice(0, cap)];
}

/** 兼容旧名（早期按 140/220 字截断的写法）；现在返回「值（出处）」优先的那段纯文本 */
export const noteText = (it, cap = 240) => noteParts(it, cap).join('　');

/** 兼容旧名 shortNote（更早叫法） */
export const shortNote = (it, cap = 240) => noteText(it, cap);

// ─────────────── 坐标解析 ───────────────

const unent = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export function parseBboxXml(xml) {
  const out = [];
  const pageRe = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
  let m;
  while ((m = pageRe.exec(xml))) {
    const words = [];
    const wRe = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)<\/word>/g;
    let k;
    while ((k = wRe.exec(m[3]))) {
      words.push({ x0: +k[1], y0: +k[2], x1: +k[3], y1: +k[4], t: unent(k[5]) });
    }
    out.push({ w: +m[1], h: +m[2], words });
  }
  return out;
}

/** 每页建两条串 + 位置映射：norm（去标点，用于 quote 匹配）/ lite（保留编号，用于 location 收窄） */
export function buildPages(bbox) {
  return bbox.map(p => {
    const mk = (fn) => {
      let s = '';
      const map = [];
      p.words.forEach((wd, wi) => {
        const n = fn(wd.t);
        if (!n) return;
        map.push({ at: s.length, wi, len: n.length });
        s += n;
      });
      return { s, map };
    };
    const N = mk(norm), L = mk(normLite);
    return { w: p.w, h: p.h, words: p.words, s: N.s, map: N.map, lite: L.s, liteMap: L.map };
  });
}

/** 8-gram 索引：Map<'abcdefgh', [{p:页码, at:归一化串位置}]> */
export function buildGramIndex(pages, n = 8) {
  const idx = new Map();
  pages.forEach((pg, p) => {
    const s = pg.s;
    for (let i = 0; i + n <= s.length; i++) {
      const g = s.substr(i, n);
      let arr = idx.get(g);
      if (!arr) { arr = []; idx.set(g, arr); }
      arr.push({ p, at: i });
    }
  });
  return idx;
}

/**
 * 数字索引：Map<'119.85', [{p, at}]>（在保留小数点的轻归一化串上取）
 *
 * 用途：表格类问题，模型常把几个数重新组织成一句话（如"财务内部收益率 可研12.1／实施8.29／变化率-31.49"），
 * 原文里根本没有这句话，n-gram 一定匹配不上。但它引用的数字在原文里是存在的。
 * 于是退一步按"数字指纹"定位：同一页同时出现其中 2 个以上数字 → 判为近似定位，框住第一个数字。
 * 这跟人翻报告的做法一样：拿数字去表里找。
 */
export function buildNumberIndex(pages) {
  const idx = new Map();
  pages.forEach((pg, p) => {
    const re = /\d+(?:\.\d+)?/g;
    let m;
    while ((m = re.exec(pg.lite))) {
      const t = m[0];
      if (t.replace(/\D/g, '').length < 2) continue;      // 单个数字没有区分度
      let arr = idx.get(t);
      if (!arr) { arr = []; idx.set(t, arr); }
      arr.push({ p, at: m.index });
    }
  });
  return idx;
}

/** 数字指纹回退：返回 {page, box, ratio, tokens} 或 null */
function numberFallback(q, ctx, preferPages) {
  const toks = [...new Set((q.match(/\d+(?:\.\d+)?/g) || []).filter(t => t.replace(/\D/g, '').length >= 2))];
  if (!toks.length) return null;
  const byPage = new Map();      // p -> { n: 命中的不同数字个数, at: 最靠前的位置, inLoc, digits: 最长数字位数 }
  for (const t of toks) {
    const arr = ctx.numbers.get(t);
    if (!arr) continue;
    const seen = new Set();
    for (const h of arr) {
      if (seen.has(h.p)) continue;
      seen.add(h.p);
      let v = byPage.get(h.p);
      if (!v) { v = { n: 0, at: h.at, inLoc: preferPages.has(h.p), digits: 0 }; byPage.set(h.p, v); }
      v.n++;
      if (h.at < v.at) v.at = h.at;
      v.digits = Math.max(v.digits, t.replace(/\D/g, '').length);
    }
  }
  let bestP = -1, bestV = null, bestScore = -1;
  for (const [p, v] of byPage) {
    const score = v.n * (v.inLoc ? 1.6 : 1);            // 落在 location 提到的章节/表里，加权
    if (score > bestScore) { bestScore = score; bestP = p; bestV = v; }
  }
  if (!bestV) return null;
  // 只命中一个数字时，要求它够长（如 119.85 / 5339），否则不敢认
  if (bestV.n < 2 && bestV.digits < 4) return null;
  return {
    page: bestP, ratio: 0.3, runChars: 0, tokens: bestV.n,
    box: boxOf(ctx.pages[bestP], bestV.at, bestV.at + 12, 'liteMap'),
  };
}

/** 按归一化区间取词框（线性扫，页内词数少，够快）
 *  which：map = 去标点串的位置映射（quote 匹配用）；liteMap = 轻归一化串（数字/章节号用） */
function boxOf(pg, start, end, which = 'map') {
  const map = pg[which] || pg.map;
  const hit = map.filter(x => x.at + x.len > start && x.at < end);
  if (!hit.length) return null;
  const ws = hit.map(x => pg.words[x.wi]);
  return {
    x0: Math.min(...ws.map(w => w.x0)), y0: Math.min(...ws.map(w => w.y0)),
    x1: Math.max(...ws.map(w => w.x1)), y1: Math.max(...ws.map(w => w.y1)),
  };
}

const SOLID = 0.55;   // ≥ 判为精确定位
const FUZZY = 0.25;   // ≥ 判为近似定位

/** n-gram 相似度检索：返回 {page, ratio, runChars, start, box} */
function gramSearch(q, ctx, restrict) {
  const { pages, grams, N } = ctx;
  if (q.length < N) return directSearch(q, ctx, restrict);
  const votes = new Map();
  for (let i = 0; i + N <= q.length; i++) {
    const arr = grams.get(q.substr(i, N));
    if (!arr) continue;
    for (const h of arr) {
      if (restrict && !restrict.has(h.p)) continue;
      let v = votes.get(h.p);
      if (!v) { v = { grams: new Set(), hits: [] }; votes.set(h.p, v); }
      if (!v.grams.has(q.substr(i, N))) { v.grams.add(q.substr(i, N)); v.hits.push(h.at); }
    }
  }
  if (!votes.size) return null;
  let bestPage = -1, bestGrams = 0;
  for (const [p, v] of votes) if (v.grams.size > bestGrams) { bestGrams = v.grams.size; bestPage = p; }

  const hits = votes.get(bestPage).hits.slice().sort((a, b) => a - b);
  // 命中最密的一段 = 目标区域：窗口跨度不超过 quote 长度对应的区间
  const span = Math.max(N, q.length - N + 1);
  let winStart = hits[0], winCount = 0;
  for (let i = 0; i < hits.length; i++) {
    let j = i;
    while (j + 1 < hits.length && hits[j + 1] - hits[i] <= span) j++;
    const cnt = j - i + 1;
    if (cnt > winCount) { winCount = cnt; winStart = hits[i]; }
  }
  const ratio = Math.min(1, (winCount * N) / q.length);
  // 最长连续匹配段（归一化字符数）。
  // 为什么要单独看它：quote 常来自 markdown 表格（竖线、单元格换行），
  // 与 PDF 流式文字只有其中一段能逐字对上；此时整体覆盖率很低（比如 20%），
  // 但"连续 18 个字一字不差"其实已经是强证据，不该退化成"只按章节标注"。
  let run = 1, best = 1;
  for (let i = 1; i < hits.length; i++) {
    if (hits[i] === hits[i - 1] + 1) run++; else run = 1;
    if (run > best) best = run;
  }
  const runChars = hits.length ? best + N - 1 : 0;
  const end = winStart + Math.min(q.length, 140);
  return { page: bestPage, ratio, runChars, start: winStart, box: boxOf(pages[bestPage], winStart, end) };
}

/** 短引用（<8 字）直接扫：整串匹配，避免 n-gram 退化 */
function directSearch(q, ctx, restrict) {
  for (let p = 0; p < ctx.pages.length; p++) {
    if (restrict && !restrict.has(p)) continue;
    const at = ctx.pages[p].s.indexOf(q);
    if (at < 0) continue;
    return { page: p, ratio: 1, runChars: q.length, start: at, box: boxOf(ctx.pages[p], at, at + q.length) };
  }
  return null;
}

/** location 里的定位线索：4.1.1 / 表4-2 / 附表4 / 图3-2-76 等 */
export function locationTokens(loc) {
  const out = [];
  const re = /(附表\s?\d+(?:[-–]\d+)?|表\s?\d+(?:[-–]\d+)+|图\s?\d+(?:[-–]\d+)+|\d+(?:\.\d+){1,3})/g;
  let m;
  while ((m = re.exec(String(loc || '')))) out.push(m[1].replace(/[\s\u3000]/g, '').replace(/[–—－]/g, '-'));
  return [...new Set(out)];
}

/** 该 token 出现在哪些页 */
function pagesWithToken(pages, tok) {
  const t = normLite(tok);
  const set = new Set();
  pages.forEach((p, i) => { if (p.lite.includes(t)) set.add(i); });
  return set;
}

/** 章节标题框：找到 token 第一次出现的位置，框住它（tier 3 用）
 *  WARN: 必须跳过目录页：目录里也会列"4.2.2"，框在目录上等于没定位。 */
function sectionBox(pages, tok) {
  const t = normLite(tok);
  let firstHit = null;
  for (let p = 0; p < pages.length; p++) {
    const at = pages[p].lite.indexOf(t);
    if (at < 0) continue;
    const hit = { page: p, box: boxOf(pages[p], at, at + t.length), token: tok };
    if (!firstHit) firstHit = hit;
    const head = pages[p].lite.slice(0, 120);
    const isToc = /目录|目次/.test(head) || /\.{5,}/.test(pages[p].lite.slice(0, 400));
    if (!isToc) return hit;
  }
  return firstHit;
}

/**
 * 逐条定位。返回 {page, box, tier, ratio, runChars, how}
 * tier: exact（实线）/ approx（虚线）/ section（点线，标在章节标题）/ none（进首页与末页清单）
 *
 * 判为"精确"的两条路（满足其一即可）：
 *   · 整体覆盖率 ratio ≥ SOLID —— 整段引用基本对得上
 *   · 最长连续匹配 ≥ runNeed  —— 引用的其中一段一字不差（典型：表格里的引用）
 * WARN: 长引用的 runNeed 会同步抬高，避免"300 字的引用里蒙对 16 个字"就被判成精确定位。
 *
 * 另外两条回退路径：
 *   · 引号片段：模型转述时常常把原句夹在「」里（如 …调整「变更程序规范」），
 *     整段匹配不上时，把片段拆出来单独匹配
 *   · 数字指纹：表格类问题模型会把几个数重新组织成一句话，原文里根本没有这句话 ——
 *     那就拿数字去原文里找（见 numberFallback）
 */
export function locate(it, ctx) {
  const q = norm(it.quote);
  const needOf = (s) => Math.max(10, Math.min(20, Math.round(s.length * 0.6)));
  const strong = (h, s) => !!h && (h.ratio >= SOLID || h.runChars >= needOf(s));
  const scoreOf = (h, s) => (h ? Math.min(h.ratio, 1) + Math.min(h.runChars / Math.max(8, s.length), 1) : -1);

  const toks = locationTokens(it.location);
  const locPages = new Set();
  for (const t of toks) for (const p of pagesWithToken(ctx.pages, t)) locPages.add(p);

  // 候选：整段引用 → 引号内片段（长的优先）
  const frags = q.split(/[\/|；;、，,。：:！!？?（）()「」【】“”"'‘’\s]+/).filter(x => x.length >= 8);
  const cands = [q, ...frags.slice().sort((a, b) => b.length - a.length).slice(0, 4)];

  let hit = null, hitOf = q;
  let hi = null, hiOf = q;
  for (const c of cands) {
    if (c.length < 4) continue;
    const h = gramSearch(c, ctx, null);
    if (!h) continue;
    if (scoreOf(h, c) > scoreOf(hi, hiOf)) { hi = h; hiOf = c; }
    if (strong(h, c)) { hit = h; hitOf = c; break; }
  }
  if (!hit) { hit = hi; hitOf = hiOf; }

  // 用 location 把搜索范围收窄到相关几页再搜一遍（整段 + 片段）
  if (locPages.size && !strong(hit, hitOf)) {
    const scope = new Set();
    for (const p of locPages) for (let d = -1; d <= 1; d++) if (p + d >= 0 && p + d < ctx.pages.length) scope.add(p + d);
    for (const c of cands) {
      if (c.length < 4) continue;
      const alt = gramSearch(c, ctx, scope);
      if (!alt) continue;
      if (strong(alt, c)) { hit = alt; hitOf = c; break; }
      if (scoreOf(alt, c) > scoreOf(hit, hitOf)) { hit = alt; hitOf = c; }
    }
  }

  let res = null;
  let abandoned = null;    // 本来想报、但因为没有框而只能放弃的档位（诊断用）
  if (strong(hit, hitOf)) res = { ...hit, tier: 'exact', how: hitOf === q ? 'quote' : 'fragment' };
  else if (hit && (hit.ratio >= FUZZY || hit.runChars >= 10)) res = { ...hit, tier: 'approx', how: hitOf === q ? 'quote' : 'fragment' };
  // 表格类问题：模型把几个数重新组织成一句话，原文里没有这句话 → 退一步用"数字指纹"定位
  // WARN: 必须传 normLite（保留小数点）而不是 norm：norm 会把 12.1 变成 121，拿这个数去找必然找错。
  else if (String(it.quote || '').trim().length >= 4) {
    const nf = numberFallback(normLite(it.quote), ctx, locPages);
    if (nf && nf.box) res = { ...nf, tier: 'approx', how: 'number' };
  }
  if (!res) {
    for (const t of toks) {
      const sb = sectionBox(ctx.pages, t);
      // WARN: 必须有框才算"章节定位"：sectionBox 偶尔只找到标题文字、拿不到词坐标（box 为 null），
      //    这时继续试下一个 token；一个都拿不到就落到下面的统一护栏（报"未定位"）。
      if (sb && sb.box) {
        res = { page: sb.page, box: sb.box, ratio: hit ? hit.ratio : 0, runChars: hit ? hit.runChars : 0, tier: 'section', token: sb.token };
        break;
      }
      if (sb && !abandoned) abandoned = 'section';   // 找到标题但没框 → 记下来，诊断用
    }
  }

  // ── 统一护栏（所有定位路径的最后一道闸）──
  // 渲染器只画"有框"的条目：`items.filter(x => x.page >= 0 && x.box)`。
  // 所以任何没有框的结果都不许报成已定位的档位，否则会出现最难核对的不一致：
  // 档位表/成果报告上写着"章节定位"，标注版上却连编号都没印，使用方按编号满篇找不到。
  // 2026-09-24 用 check-annotation-map.mjs 全量核查抓出 3 条（P1-84 / P1-21 / P1-14）。
  // 宁可把定位率报低一点，也不能说标了却没标。
  if (res && res.box) return res;
  return {
    page: -1, box: null,
    ratio: (res || hit || {}).ratio || 0,
    runChars: (res || hit || {}).runChars || 0,
    tier: 'none',
    dropped: res ? res.tier : abandoned,     // 诊断用：本来要报哪一档（但没有框，只能报未定位）
  };
}

// ─────────────── 截图 / 转换 ───────────────

/**
 * 找要标注的"原件"。
 * WARN: 必须排除 opinion*.docx —— 那是系统自己出的意见书，早期任务目录里它可能排在原件前面，
 *   早先按 readdir 顺序取第一个 .docx，结果把"意见书"当成原报告去标注了（2026-09-24 经实测）。
 *   优先级：meta.uploadFile / meta.pptSourceName（提交时的原件）→ 目录里最大的报告文件。
 */
function pickSource(taskDir, preferPptx = false, onlyExt = '') {
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(path.join(taskDir, 'meta.json'), 'utf8')); } catch { /* 没 meta 就按目录找 */ }
  const files = fs.readdirSync(taskDir).filter(f =>
    !/^~\$/.test(f) && !/extracted/i.test(f) && !/^opinion/i.test(f) && !/\.pdf$/i.test(f) && !/^annot/i.test(f));
  const has = (f) => f && files.includes(path.basename(f));
  const docx = files.filter(f => /\.docx$/i.test(f));
  const pptx = files.filter(f => /\.pptx$/i.test(f));
  const users = [meta?.uploadFile, meta?.pptSourceName].filter(has).map(f => path.basename(f));
  const userDoc = users.filter(f => /\.docx$/i.test(f));
  const userPpt = users.filter(f => /\.pptx$/i.test(f));
  const bySize = (a, b) => {
    try { return fs.statSync(path.join(taskDir, b)).size - fs.statSync(path.join(taskDir, a)).size; } catch { return 0; }
  };
  // onlyExt='.pptx'：只要 PPT（配对任务的"PPT 标注版"用）；没有就返回 null，调用方跳过而不是退化成报告
  if (onlyExt === '.pptx') return (userPpt[0] || [...pptx].sort(bySize)[0] || null);
  if (onlyExt === '.docx') return (userDoc[0] || [...docx].sort(bySize)[0] || null);
  const order = preferPptx ? [userPpt[0], userDoc[0]] : [userDoc[0], userPpt[0]];
  for (const f of order) if (f) return f;
  const fallback = preferPptx ? [...pptx.sort(bySize), ...docx.sort(bySize)] : [...docx.sort(bySize), ...pptx.sort(bySize)];
  return fallback.length ? fallback[0] : null;
}

/** 任务里是否同时有报告 + PPT（配对一致性核对的任务）→ 需要额外出 PPT 标注版 */
export function hasPairedPpt(taskDir) {
  try {
    return !!pickSource(taskDir, false, '.docx') && !!pickSource(taskDir, false, '.pptx');
  } catch { return false; }
}

/**
 * 修 PPTX 里让 LibreOffice 渲染错乱的地方：`<a:spAutoFit/>` → `<a:noAutofit/>`。
 *
 * 为什么必须修（2026-09-28：已完成的 PPT 标注版出现大量错位）：
 *   本机 LibreOffice 对带 `spAutoFit` 的文本框会算错宽度 —— 经实测，《2026年沙特压裂配套设备购置项目》
 *   那份 60 页 PPTX，同一页 PowerPoint 渲染出 391 字、LibreOffice 只渲染出 27 字（正文整段丢失，
 *   只剩右侧"一字一行"的零碎残字）。标注是在这个渲染结果上定位/画框的，正文都不在页面上，
 *   框自然就"错位"到别的地方去了。改成 noAutofit 后同一页渲染出 412 字，正文完整、版面正常。
 *
 * NOTE: 只改副本，绝不动用户原件（原件要留档、要能下载）。
 * 返回可用于转换的 pptx 路径；修补失败就退回原件（宁可标注位置差一点，也不能让任务失败）。
 */
function sanitizePptx(srcPath, workDir, log = () => {}) {
  const dst = path.join(workDir, 'fixed-' + path.basename(srcPath));
  try {
    const ps = path.join(workDir, '_fix-pptx.ps1');
    // 脚本内容纯 ASCII（避免编码坑）；源/目标路径通过参数传入（execFile 的参数不经 shell，中文安全）
    fs.writeFileSync(ps, [
      'param([string]$Src,[string]$Dst,[string]$Log)',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      'Copy-Item -LiteralPath $Src -Destination $Dst -Force',
      '$zip=[System.IO.Compression.ZipFile]::Open($Dst,"Update")',
      '$n=0',
      'try {',
      '  foreach ($e in @($zip.Entries)) {',
      '    if ($e.FullName -notmatch "^ppt/(slides|slideLayouts|slideMasters)/.*\\.xml$") { continue }',
      '    $r=New-Object System.IO.StreamReader($e.Open(),[System.Text.Encoding]::UTF8)',
      '    $x=$r.ReadToEnd(); $r.Close()',
      '    if ($x -notmatch "spAutoFit") { continue }',
      '    $y=$x -replace "<a:spAutoFit\\s*/>","<a:noAutofit/>"',
      '    $st=$e.Open(); $st.SetLength(0)',
      '    $w=New-Object System.IO.StreamWriter($st,(New-Object System.Text.UTF8Encoding($false)))',
      '    $w.Write($y); $w.Flush(); $w.Close()',
      '    $n++',
      '  }',
      '} finally { $zip.Dispose() }',
      'Add-Content -LiteralPath $Log -Value $n -Encoding UTF8',
    ].join('\n'), 'utf8');
    const logFile = path.join(workDir, '_fix-pptx.log');
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, srcPath, dst, logFile],
      { timeout: 120000, windowsHide: true, stdio: 'ignore' });
    const n = Number((fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '0').trim()) || 0;
    if (n > 0 && fs.existsSync(dst)) {
      log(`已修 PPTX 排版（${n} 处 autofit → noAutofit，用副本转换，原件不动）`);
      return dst;
    }
    log('PPTX 无需修补（或未发现 autofit），直接用原件转换');
    return srcPath;
  } catch (e) {
    log(`PPTX 修补失败（改用原件，标注位置可能偏差）：${e.message}`);
    return srcPath;
  }
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 缺工具时给出清晰的错误（不要让它变成一个看不懂的 ENOENT） */
function requireTool(p, name, envName) {
  if (!p || !fs.existsSync(p)) {
    throw new Error(`找不到 ${name}：标注版需要它。请安装（poppler / LibreOffice），`
      + `或用环境变量指定绝对路径 ${envName}=<...\\${name}.exe>`);
  }
  return p;
}

async function toPdf(srcPath, outDir) {
  requireTool(SOFFICE, 'soffice', 'SOFFICE');
  // WARN: 每次转换用一个独立的 LibreOffice 用户配置目录：
  //    LibreOffice 默认单实例（同一个 profile 只允许一个进程），
  //    并发跑两个转换时后一个会直接失败 —— 经实测 6 个任务并发时就撞上了。
  const profile = path.join(os.tmpdir(), 'lo-prof-' + process.pid + '-' + Math.random().toString(36).slice(2, 8));
  try {
    await pexec(SOFFICE, [
      '--headless',
      `-env:UserInstallation=file:///${profile.replace(/\\/g, '/')}`,
      '--convert-to', 'pdf', '--outdir', outDir, srcPath,
    ], { timeout: 900000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  } finally {
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 清不掉不影响结果 */ }
  }
  const made = path.join(outDir, path.basename(srcPath).replace(/\.[^.]+$/, '.pdf'));
  if (!fs.existsSync(made)) throw new Error('LibreOffice 未能生成 PDF');
  return made;
}

async function shots(pdf, outDir, dpi) {
  requireTool(PDFTOPPM, 'pdftoppm', 'PDFTOPPM');
  await pexec(PDFTOPPM, ['-jpeg', '-jpegopt', 'quality=85', '-r', String(dpi), pdf, path.join(outDir, 'pg')],
    { timeout: 900000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return fs.readdirSync(outDir).filter(f => /^pg-\d+\.jpe?g$/.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
}

async function wordBoxes(pdf) {
  requireTool(PDFTOTEXT, 'pdftotext', 'PDFTOTEXT');
  const { stdout } = await pexec(PDFTOTEXT, ['-bbox', pdf, '-'],
    { timeout: 900000, maxBuffer: 1024 * 1024 * 1024, windowsHide: true, encoding: 'utf8' });
  return parseBboxXml(stdout);
}

// ─────────────── HTML 渲染 ───────────────

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const mm = (v) => (Math.round(v * 100) / 100) + 'mm';

/** 估算批注块高度（mm）：JS 端会按实测高度再对齐一次，这里只用于判断是否放得下 */
function estHeight(text, sideW, withCat = true) {
  const cpl = Math.max(6, Math.floor((sideW - 5) / 3.05));
  const lines = Math.max(1, Math.ceil((text.length + (withCat ? 6 : 4)) / cpl));
  return lines * 4.3 + 2.0;
}

const TIER_LABEL = { exact: '精确', approx: '近似', section: '章节', none: '未定位' };
const TIER_HINT = {
  exact: '引用文字在原文里找到，位置可靠',
  approx: '原文没有这句原话（表格类数据被重新组织过），按数字指纹在该页找到，位置仅供参考',
  section: '只定位到该章节/表所在的标题处',
  none: '未能在原报告中标出位置 —— 请在《成果报告》里按编号查看，位置以「原文定位」为准',
};

/** 一页一图 + 标记 + 与框同高的右侧批注（放不下的返回 overflow） */
function pageSheet({ pi, pg, img, list, noteCaps = NOTE_CAPS }) {
  const availW = SHEET_W - 2 * MARGIN, availH = SHEET_H - 2 * MARGIN;
  // 问题多的页给侧栏让出更多宽度：批注要"每条都落在自己那条线的高度上"，
  // 侧栏越窄、一行装的字越少，条条平齐就越难做到。经实测：侧栏 56mm 时一行只有 16 字。
  const dense = list.length >= 4;
  const sideWant = dense ? Math.min(120, Math.max(SIDE_MIN, Math.round(availW * 0.36))) : SIDE_MIN;
  let scale = Math.min((availW - GUTTER - sideWant) / pg.w, availH / pg.h);
  let iw = pg.w * scale, ih = pg.h * scale;
  let realSide = availW - GUTTER - iw;
  let stacked = false;
  if (realSide < STACK_SIDE_MIN) {
    stacked = true;
    scale = Math.min(availW / pg.w, (availH * 0.66) / pg.h);
    iw = pg.w * scale; ih = pg.h * scale;
    realSide = availW;
  }
  const imgLeft = MARGIN, imgTop = MARGIN;
  const sideLeft = stacked ? MARGIN : MARGIN + iw + GUTTER;
  const sideTop = stacked ? MARGIN + ih + 3 : MARGIN;
  const sideH = stacked ? availH - ih - 3 : ih;
  const noteW = stacked ? (realSide - 4) / 2 : realSide;
  const availNoteH = Math.max(10, sideH - HDR_H - 3);

  let marks = '';
  for (const it of list) {
    const c = colorOf(it);
    const x = it.box.x0 * scale, y = it.box.y0 * scale;
    const w = Math.max(6, (it.box.x1 - it.box.x0) * scale);
    const h = Math.max(2.6, (it.box.y1 - it.box.y0) * scale);
    const cls = it.tier === 'exact' ? '' : (it.tier === 'approx' ? ' approx' : ' section');
    marks += `<div class="hl${cls}" style="left:${mm(x - 0.7)};top:${mm(y - 0.5)};width:${mm(w + 1.4)};height:${mm(h + 1)};border-color:${c}"></div>`;
    const by = y - 4.4 < 0 ? y + h + 0.8 : y - 4.4;
    marks += `<div class="badge" style="left:${mm(x - 0.7)};top:${mm(by)};background:${c}">${esc(it.no)}</div>`;
  }

  // 批注排版（既定口径）：
  //   · 文字优先写全：不再为了"与框严格平齐"而把文字压成省略号；
  //   · 一条批注放不下就适当下移（美观即可，重点是问题标注清楚）；
  //   · 引线仍是一条连续水平线，画在框的高度上，从框右缘到批注列；
  //   · 只有完全同一高度（≤0.6mm，同一行里的两条问题）才合成一条批注，避免看着"问题变少了"。
  const CHROME_W = 7;                                         // 编号+类别占掉的宽度（折算成字）
  const cpl = Math.max(6, Math.floor((noteW - 5) / 3.05));    // 每行可容纳的汉字数（8.2pt）
  const LINE_H = 4.3, PAD_H = 2.0, PART_GAP = 1.1;
  const CAP_MAX = Number(process.env.ANNOT_NOTE_CAP || 600);  // 单条批注总字数上限（够放长描述）
  // 每条问题各自成行 → 高度 = 各条行数之和 + 条间距
  const est = (parts) => PAD_H + parts.reduce((h, p) => h + Math.max(1, Math.ceil((p.length + CHROME_W) / cpl)) * LINE_H + PART_GAP, 0);

  let placed = [], overflow = [], usedCap = CAP_MAX;
  if (stacked) {
    placed = list.map(it => ({ items: [it], parts: noteParts(it, CAP_MAX), top: null, cls: '' }));
  } else {
    const groups = [];
    for (const it of list) {
      const y = it.box.y0 * scale;
      const g = groups[groups.length - 1];
      if (g && Math.abs(y - g.y) <= 0.6) g.items.push(it);
      else groups.push({ y, items: [it] });
    }
    let cursor = 0;
    for (const g of groups) {
      const badges = g.items.reduce((n, it) => n + String(it.no).length + 1, 0);
      let parts = g.items.flatMap(it => noteParts(it, Math.max(40, CAP_MAX - badges)));
      const only = g.items.length === 1 ? g.items[0] : null;
      if (only && only.fix) parts = [...parts, `建议：${String(only.fix).replace(/\s+/g, ' ').slice(0, 120)}`];
      const h = est(parts);
      const top = Math.max(g.y, cursor);                       // 放不下就往下让一点，不硬压文字
      if (top + h > availNoteH) { for (const it of g.items) overflow.push(it); continue; }
      placed.push({ items: g.items, parts, text: parts.join('　'), top, h, boxY: g.y, cls: '' });
      cursor = top + h + 0.8;
    }
  }

  const noteHtml = (n) => {
    const first = n.items[0];
    const mk = first.tier === 'section' ? '<span class="mk">§</span>' : (first.how === 'number' ? '<span class="mk">≈</span>' : '');
    const badges = n.items.map(it => `<span class="n" style="background:${colorOf(it)}">${esc(it.no)}</span>`).join('');
    const cats = [...new Set(n.items.map(it => it.category || ''))].filter(Boolean).join('/');
    // WARN: 两套坐标系，别混：
    //   · 批注挂在 .notes 容器里（左边距 = 图片顶 + 侧栏页眉高），所以 data-y 要减掉页眉那一段；
    //   · 引线挂在 .sheet 上（纸张坐标），所以 data-by 要加上图片顶的 5mm。
    //   早先两边都少算/多算，导致"线、批注、框三者对不上"（2026-09-24 经实测）。
    const noteTopMm = sideTop + HDR_H + 3;
    // WARN: 单位陷阱：box.x1 是 PDF 点（1/72 英寸），iw 是毫米，不能直接 Math.min。
    //    早先把 iw（毫米）当上限去夹 box.x1（点），几乎所有框的右缘都被夹成 140.71pt，
    //    于是引线起点固定落在 38mm 处 —— 正好压在框里的文字上，看着像"要删字"的横线。
    //    上限要用页面宽度（点）；同一位置合并了多条时取最靠右的框，保证起点在所有框之外。
    const bxPt = Math.max(...n.items.map(it => Math.min(it.box.x1, pg.w)));
    const pos = n.top === null ? '' : ` data-y="${Math.round(Math.max(0, (MARGIN + n.top) - noteTopMm) * 100) / 100}" data-c="${colorOf(first)}"` +
      ` data-by="${Math.round((MARGIN + (n.boxY ?? first.box.y0 * scale)) * 100) / 100}"` +
      ` data-bx="${Math.round((imgLeft + bxPt * scale) * 100) / 100}" data-nl="${Math.round(sideLeft * 100) / 100}"`;
    return `<div class="note${n.top === null ? ' flow' : ''}${n.cls ? ' ' + n.cls : ''}"${pos}>${badges}${mk}<span class="cat">${esc(cats)}</span><span class="t">${n.parts.map(p => `<span class="np">${esc(p)}</span>`).join('')}</span></div>`;
  };
  const notesHtml = placed.map(noteHtml).join('');

  // 横版附表页：图只占上面一段（按宽度缩放到 225mm 宽、高约 159mm），图下方还有一条空白带。
  // 右侧大量空白、而问题显示不全时，那块空白就用在这里：把侧栏放不下的批注排到图下方两列。
  const belowH = availH - ih - 3;
  let below = '', rest = overflow;
  if (!stacked && belowH > 20 && overflow.length) {
    const colW = (iw - 4) / 2;
    const cpl = Math.max(8, Math.floor((colW - 4) / 3.05));
    const maxLines = Math.max(2, Math.floor((belowH - 7) / 4.7));
    const take = [];
    let col = 0, used = 0;
    for (const it of overflow) {
      const text = noteText(it, 90);
      const l = Math.max(1, Math.ceil((text.length + 8) / cpl)) + 0.5;
      if (used + l > maxLines) { col++; used = 0; if (col >= 2) break; }
      used += l; take.push({ it, text });
    }
    if (take.length) {
      below = `<div class="below" style="left:${mm(imgLeft)};top:${mm(imgTop + ih + 2)};width:${mm(iw)};height:${mm(belowH)}">
        <div class="below-h">本页其余问题（${take.length} 条 · 编号见上方图中标记）</div>
        <div class="below-list">${take.map(n => `<div class="note flow">
          <span class="n" style="background:${colorOf(n.it)}">${esc(n.it.no)}</span><span class="cat">${esc(n.it.category || '')}</span><span class="t">${esc(n.text)}</span></div>`).join('')}</div>
      </div>`;
      rest = overflow.slice(take.length);
    }
  }

  return {
    html: `<section class="sheet" data-pgright="${Math.round((imgLeft + iw) * 100) / 100}">
  <div class="pg" style="left:${mm(imgLeft)};top:${mm(imgTop)};width:${mm(iw)};height:${mm(ih)}">
    <img src="data:image/jpeg;base64,${img}">${marks}
  </div>
  <div class="side" style="left:${mm(sideLeft)};top:${mm(sideTop)};width:${mm(realSide)};height:${mm(sideH)}">
    <div class="side-h">原报告 第 ${pi + 1} 页 · ${list.length} 条${stacked ? '（横版页：图在上、批注在下）' : ''}${rest.length ? ` · 另有 ${rest.length} 条见续注页` : ''}</div>
    <div class="notes${stacked ? ' stacked' : ''}">${notesHtml || `<div class="none">${list.length ? '本页批注排在图下方' : '本页无问题'}</div>`}</div>
  </div>
  ${below}
</section>`,
    overflow: rest,
    cap: usedCap,
  };
}

/** 清单页（续注 / 未定位 / 近似）：每行都印完整问题，编号与成果报告一致 */
function listSheet(title, list, { tone = 'plain', perSheet = 12, head = '' } = {}) {
  const sheets = [];
  for (let i = 0; i < list.length; i += perSheet) {
    const chunk = list.slice(i, i + perSheet);
    const rows = chunk.map(it => `<div class="li ${tone}">
      <span class="n" style="background:${colorOf(it)}">${esc(it.no)}</span><b>${esc(it.category || '')}</b>
      ${it.pageNo ? `<span class="loc">原报告第 ${it.pageNo} 页</span>` : ''}
      ${it.tier === 'approx' ? '<span class="loc">近似定位</span>' : ''}${it.tier === 'section' ? '<span class="loc">章节定位</span>' : ''}
      <div class="tx">${noteParts(it, 900).map(p => `<span class="np">${esc(p)}</span>`).join('')}</div>
      <div class="loc">成果报告位置：${esc(it.location || '—')}</div></div>`).join('');
    sheets.push(`<section class="sheet"><div class="listpage">
      ${i === 0 ? `<h3>${esc(title)}（共 ${list.length} 条，编号与《成果报告》一一对应）</h3>${head}` : `<h3>${esc(title)}（续）</h3>`}
      ${rows}</div></section>`);
  }
  return sheets.join('');
}

/** 首页：这份标注版标出了多少、哪些没标出来、怎么去核对（要求在成果里写清楚） */
function coverSheet({ items, stats, meta = {}, scope }) {
  const label = scope === 'proof' ? '校对版' : '审核版';
  const missed = items.filter(x => x.tier === 'none');
  const weak = items.filter(x => x.tier === 'approx' || x.tier === 'section');
  const pct = (v) => `${v}%`;
  return `<section class="sheet"><div class="cover">
  <h1>原报告标注版 · ${label}</h1>
  <div class="sub">${esc(meta.sourceName || '')}</div>
  <table class="meta">
    <tr><th>任务编号</th><td>${esc(meta.taskId || '—')}</td><th>原报告页数</th><td>${stats.pages} 页</td></tr>
    <tr><th>本版问题条数</th><td>${stats.total} 条</td><th>对应成果</th><td>《${scope === 'proof' ? '校对成果' : '审核成果'}》（编号一致）</td></tr>
  </table>

  <h2>一、标注情况（如实统计）</h2>
  <table class="stat">
    <tr><th>结果</th><th>条数</th><th>占比</th><th>在原文上的画法</th><th>位置可靠性</th></tr>
    <tr><td><b>精确定位</b></td><td>${stats.exact}</td><td>${pct(stats.exactRate)}</td>
        <td>实线框 + 编号</td><td>引用文字在原文里找到，<b>可靠</b></td></tr>
    <tr><td>近似定位</td><td>${stats.approx}</td><td>${pct(Math.round((stats.approx / Math.max(1, stats.total)) * 1000) / 10)}</td>
        <td>虚线框 + ≈</td><td>${esc(TIER_HINT.approx)}</td></tr>
    <tr><td>章节定位</td><td>${stats.section}</td><td>${pct(Math.round((stats.section / Math.max(1, stats.total)) * 1000) / 10)}</td>
        <td>点线框 + §</td><td>${esc(TIER_HINT.section)}</td></tr>
    <tr ${missed.length ? 'class="bad"' : ''}><td><b>未能定位</b></td><td><b>${stats.none}</b></td><td>${pct(Math.round((stats.none / Math.max(1, stats.total)) * 1000) / 10)}</td>
        <td>${missed.length ? '<b>本页下方列出</b>' : '—'}</td><td>${esc(TIER_HINT.none)}</td></tr>
  </table>

  <div class="note-box ${missed.length ? 'bad' : 'ok'}">
    ${missed.length
      ? `<b>共 ${stats.none} 条问题未能在原报告上标出位置</b>（占 ${Math.round((stats.none / Math.max(1, stats.total)) * 100)}%）。
         这些问题的<b>原文定位</b>与<b>问题描述</b>已在下方逐条列出，请对照《${scope === 'proof' ? '校对成果' : '审核成果'}》核对；
         成果报告里对应的条目也已用<b>红字</b>标出「本条未能在原报告中标出位置」。`
      : '<b>本版所有问题都在原报告上标出了位置</b>（精确或近似）。'}
    ${weak.length ? `<br>另有 <b>${weak.length} 条</b>为近似/章节定位（虚线框、点线框），位置仅供参考，判定仍以《成果报告》文字为准。` : ''}
    <br>本版共 ${stats.total} 条：精确 ${stats.exact} · 近似 ${stats.approx} · 章节 ${stats.section} · 未能定位 ${stats.none}。
  </div>

  <h2>二、配色与线型</h2>
  <table class="legend">
    <tr><td><span class="sw" style="background:${PROOF_COLOR}"></span>校对类（蓝色）</td>
        <td><span class="sw" style="background:${DEEP_COLOR.P0}"></span>审核类 P0（深红）</td>
        <td><span class="sw" style="background:${DEEP_COLOR.P1}"></span>审核类 P1（橙）</td>
        <td><span class="sw" style="background:${DEEP_COLOR.P2}"></span>审核类 P2/P3（黄）</td></tr>
    <tr><td>实线框 = 精确定位</td><td>虚线框 ≈ = 近似定位</td><td>点线框 § = 章节定位</td><td>编号 = 成果报告里的编号</td></tr>
  </table>

  ${missed.length ? `<h2>三、未能在原报告中标出位置的问题（共 ${missed.length} 条）</h2>
  <div class="missed">
    ${missed.slice(0, 10).map(it => `<div class="mi"><span class="n" style="background:${colorOf(it)}">${esc(it.no)}</span>
      <b>${esc(it.category || '')}</b>　${esc(noteText(it, 90))}
      <div class="loc">原文定位：${esc(it.location || '—')}</div></div>`).join('')}
    ${missed.length > 10 ? `<div class="more">其余 ${missed.length - 10} 条见本文件末尾「未能定位清单」。</div>` : ''}
  </div>` : ''}
</div></section>`;
}

/**
 * 生成标注版 HTML。
 * @returns {{html:string, stats:object}}
 */
export function renderAnnotatedHtml({ pages, items, meta = {}, scope = 'deep', images }) {
  const located = items.filter(x => x.page >= 0 && x.box);
  const byPage = new Map();
  for (const it of located) {
    if (!byPage.has(it.page)) byPage.set(it.page, []);
    byPage.get(it.page).push(it);
  }

  const tiers = { exact: 0, approx: 0, section: 0, none: 0 };
  for (const it of items) tiers[it.tier]++;
  const total = items.length;
  const stats = {
    total,
    exact: tiers.exact, approx: tiers.approx, section: tiers.section, none: tiers.none,
    approxNumber: items.filter(x => x.how === 'number').length,   // 其中按"数字指纹"近似定位的
    located: tiers.exact + tiers.approx,
    rate: total ? Math.round(((tiers.exact + tiers.approx) / total) * 1000) / 10 : 0,
    exactRate: total ? Math.round((tiers.exact / total) * 1000) / 10 : 0,
    coverRate: total ? Math.round(((total - tiers.none) / total) * 1000) / 10 : 0,
    pages: pages.length,
  };

  let sheets = coverSheet({ items, stats, meta, scope });
  const overflowAll = [];
  for (let pi = 0; pi < pages.length; pi++) {
    const list = (byPage.get(pi) || []).slice().sort((a, b) => (a.box.y0 - b.box.y0) || (a.box.x0 - b.box.x0));
    const s = pageSheet({ pi, pg: pages[pi], img: images[pi], list });
    sheets += s.html;
    for (const it of s.overflow) overflowAll.push({ ...it, pageNo: pi + 1 });
  }

  // 侧栏排不下的批注：集中成清单页，印完整描述
  if (overflowAll.length) {
    sheets += listSheet('页面位置拥挤 · 以下问题集中列于此处', overflowAll, { perSheet: 10 });
  }
  // 未能定位：红字清单（首页只列了前 10 条）
  const missed = items.filter(x => x.tier === 'none');
  if (missed.length) {
    sheets += listSheet('未能在原报告中标出位置的问题', missed, {
      tone: 'bad', perSheet: 10,
      head: '<p class="listnote">以下问题有编号、有原文定位，只是没能在原报告文字层里找到足够匹配的位置（常见于图片/图表里的内容，或表格排版与解析文本差异过大）。请按「成果报告位置」人工查找 —— 编号与《成果报告》一一对应。</p>',
    });
  }
  // 近似 / 章节定位：橙色清单，明确"位置仅供参考"
  const weak = items.filter(x => x.tier === 'approx' || x.tier === 'section');
  if (weak.length) {
    sheets += listSheet('近似定位 / 章节定位的问题（位置仅供参考）', weak, {
      tone: 'warn', perSheet: 12,
      head: '<p class="listnote">这些条目的位置是推出来的：表格类引用被重新组织过（按数字指纹定位），或只找到章节标题。判定以《成果报告》文字为准。</p>',
    });
  }

  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(meta.title || '原报告标注版')}</title><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{background:#fff}
body{font-family:"Microsoft YaHei","SimSun",sans-serif;color:#1a1d21;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.sheet{position:relative;width:${SHEET_W}mm;height:${SHEET_H}mm;overflow:hidden;background:#fff;
  page-break-after:always;break-after:page}
.sheet:last-child{page-break-after:auto;break-after:auto}
.pg{position:absolute;overflow:hidden;background:#fff}
.pg img{display:block;width:100%;height:100%}
.hl{position:absolute;border:2px solid;border-radius:1px;background:rgba(255,214,0,.16)}
.hl.approx{border-style:dashed}
.hl.section{border-style:dotted}
.badge{position:absolute;color:#fff;font:700 7.5pt/1.35 "Microsoft YaHei",sans-serif;
  padding:0 1.1mm;border-radius:.6mm;white-space:nowrap}
.side{position:absolute;overflow:hidden}
.side-h{height:${HDR_H}mm;font:700 8.6pt/1.4 "Microsoft YaHei",sans-serif;color:#0b3d6b;
  border-bottom:1.2px solid #0b3d6b;padding-bottom:1mm;margin-bottom:1.6mm;white-space:nowrap;overflow:hidden}
.notes{position:relative;height:calc(100% - ${HDR_H + 3}mm)}
.none{font:8.4pt/1.5 "Microsoft YaHei",sans-serif;color:#b3b9c2}
.note{position:absolute;left:0;right:0;font:8.2pt/1.35 "Microsoft YaHei",sans-serif;
  word-break:break-word;overflow-wrap:anywhere;white-space:normal}
.note .n{display:inline-block;color:#fff;font-weight:700;font-size:7.6pt;line-height:1.5;
  padding:0 1mm;border-radius:.6mm;margin-right:.8mm}
.note .cat{color:#5b636e;font-size:7.6pt;margin-right:.8mm}
.note .mk{color:#9aa3ad;font-size:7.6pt;margin-right:.4mm}
.note .t{display:inline;word-break:break-word;overflow-wrap:anywhere}
/* 用「／」分开的多条问题 → 各自成行，便于看清 */
.note .np{display:block;word-break:break-word;overflow-wrap:anywhere;margin:0 0 .5mm}
.note .np:last-child{margin-bottom:0}
.note.tight{font-size:7.4pt;line-height:1.25}
.note.tight .n,.note.tight .cat,.note.tight .mk{font-size:7pt}
.note.micro{font-size:6.6pt;line-height:1.15;padding:0}
.note.micro .n,.note.micro .cat,.note.micro .mk{font-size:6.4pt}
.notes.stacked{height:auto;column-count:2;column-gap:4mm}
.notes.stacked .note{position:static;margin:0 0 1.4mm;padding:.8mm 1.4mm;border-radius:.8mm;
  break-inside:avoid;font-size:8pt;background:#f7f8fa}
.leader{position:absolute;border-top:1.2px solid #9aa3ad;height:0;opacity:.85}
.leader.diag{border-top-width:1px}
.leader.v{border-top:0;border-left:1px dotted #9aa3ad;width:0}
/* 横版附表页：图片下方那条空白带用来排"侧栏放不下"的批注（两列） */
.below{position:absolute;border-top:1px solid #d5dbe3;padding-top:1.4mm;overflow:hidden}
.below-h{font:700 8.4pt/1.4 "Microsoft YaHei",sans-serif;color:#0b3d6b;margin-bottom:1mm}
.below-list{column-count:2;column-gap:4mm;height:calc(100% - 5mm)}
.below-list .note{position:static;margin:0 0 1.2mm;padding:.7mm 1.2mm;border-radius:.8mm;background:#f7f8fa;
  break-inside:avoid;font-size:8pt}

/* 首页与清单页 */
.cover{padding:${MARGIN + 4}mm ${MARGIN + 6}mm;height:100%;overflow:hidden}
.cover h1{font-size:17pt;text-align:center;letter-spacing:2px;color:#0b3d6b}
.cover .sub{text-align:center;color:#5b636e;font-size:9.5pt;margin:2mm 0 4mm;
  padding-bottom:2mm;border-bottom:2px solid #0b3d6b}
.cover h2{font-size:11pt;color:#0b3d6b;margin:4mm 0 2mm}
table.meta,table.stat,table.legend{width:100%;border-collapse:collapse;font:8.6pt/1.5 "Microsoft YaHei",sans-serif}
table.meta th{width:22mm;background:#f4f6f8;text-align:left;color:#3a424c}
table.stat th,table.stat td,table.legend td{border:1px solid #d5dbe3;padding:1.3mm 2mm;text-align:left;vertical-align:top}
table.stat th{background:#f4f6f8}
table.stat tr.bad td{background:#fdf3f3;color:#a11212}
table.legend td{width:25%}
.sw{display:inline-block;width:4mm;height:2.6mm;border-radius:.6mm;margin-right:1mm;vertical-align:middle}
.note-box{margin-top:3mm;padding:2.5mm 3mm;border-left:3px solid #1668d6;background:#f6f8fb;
  font:8.8pt/1.6 "Microsoft YaHei",sans-serif}
.note-box.bad{border-color:#a11212;background:#fdf3f3}
.note-box.ok{border-color:#166534;background:#f2f8f4}
.missed .mi{font:8.6pt/1.5 "Microsoft YaHei",sans-serif;padding:1.4mm 0;border-bottom:1px dotted #e3e8ee}
.missed .mi .n{display:inline-block;color:#fff;font-weight:700;font-size:7.6pt;padding:0 1mm;border-radius:.6mm;margin-right:1mm}
.missed .loc{color:#a11212;font-size:8pt}
.missed .more{color:#5b636e;font-size:8.4pt;padding-top:1.5mm}
.listpage{padding:${MARGIN + 2}mm ${MARGIN + 4}mm;column-count:2;column-gap:8mm}
.listpage h3{font-size:11pt;color:#0b3d6b;border-bottom:1.5px solid #0b3d6b;padding-bottom:1.5mm;
  margin-bottom:2.5mm;column-span:all}
.listpage .listnote{column-span:all;font:8.4pt/1.6 "Microsoft YaHei",sans-serif;color:#5b636e;margin-bottom:3mm}
.listpage .li{font:8.5pt/1.5 "Microsoft YaHei",sans-serif;padding:1.6mm 0;border-bottom:1px dotted #dfe4ea;
  break-inside:avoid}
.listpage .li .n{display:inline-block;color:#fff;font-weight:700;font-size:7.6pt;padding:0 1mm;
  border-radius:.6mm;margin-right:1.2mm}
.listpage .li .tx{margin-top:.8mm}
.listpage .li .tx .np{display:block;margin:0 0 .5mm}
.listpage .li .loc{color:#6b7280;font-size:7.8pt}
.listpage .li.bad .loc{color:#a11212}
.listpage .li.warn .loc{color:#b45309}
@page{size:A4 landscape;margin:0}
</style></head><body>${sheets}
<script>
(function(){
  var MM = 96/25.4;
  function line(sheet, x, y, w, h, color){
    var d = document.createElement('div');
    d.className = 'leader' + (h ? ' v' : '');
    d.style.left = x + 'mm';
    d.style.top = y + 'mm';
    if (h) d.style.height = h + 'mm'; else d.style.width = w + 'mm';
    d.style.borderColor = color;
    sheet.appendChild(d);
    return d;
  }
  Array.prototype.forEach.call(document.querySelectorAll('.sheet'), function(sheet){
    var box = sheet.querySelector('.notes');
    if(!box || box.classList.contains('stacked')) return;
    var pgRight = parseFloat(sheet.getAttribute('data-pgright'));
    var notes = Array.prototype.slice.call(box.querySelectorAll('.note'));
    var cursor = -1e9;
    notes.forEach(function(n, i){
      // 批注竖向位置：服务端已算好（放不下时已适当下移）。这里只做轻微避让，不再缩字号压字。
      var y = parseFloat(n.getAttribute('data-y')) || 0;
      var top = Math.max(y, cursor);
      n.style.top = top + 'mm';
      cursor = top + (n.offsetHeight / MM) + 0.4;

      // 引线口径：从问题框的角上引出，只走页边空白，不横穿正文。
      //   · 框的右缘离批注近（≤ LEAD_MAX）→ 从框角一路连到批注；
      //   · 框很宽、右缘离批注远 → 不拉长线，改从页面右缘的空白带里起一小段，
      //     靠"与框同高 + 编号"对应（过长的横线已按反馈删除）。
      var bx = parseFloat(n.getAttribute('data-bx'));
      var nl = parseFloat(n.getAttribute('data-nl'));
      var by = parseFloat(n.getAttribute('data-by'));
      if (isNaN(bx) || isNaN(nl) || isNaN(by)) return;
      var c = n.getAttribute('data-c') || '#9aa3ad';
      // 一条连续的水平线：从问题框的右缘一直连到批注左缘（不留在中间断开的两段）。
      var d = document.createElement('div');
      d.className = 'leader';
      d.style.top = (by + 1.4) + 'mm';
      d.style.left = bx + 'mm';
      d.style.width = Math.max(2, nl - bx - 0.4) + 'mm';
      d.style.borderTopColor = c;
      sheet.appendChild(d);
    });
  });
})();
</script></body></html>`;

  return { html, stats };
}

// ─────────────── 主流程 ───────────────

/**
 * 分析阶段：原报告 → PDF → 逐页图 + 词坐标 → 逐条定位。
 * 拆成"分析 / 渲染"两步，是为了让成果报告也能拿到定位档位（未标出的条目要在报告里红字提示），
 * 而不用把整套转换跑两遍。
 */
export async function prepareAnnotation({ taskDir, preferPptx = false, kind = '', dpi = DEFAULT_DPI, log = () => {} }) {
  const t0 = Date.now();
  const gradedFile = path.join(taskDir, 'run/s4_graded.json');
  if (!fs.existsSync(gradedFile)) throw new Error('缺少 run/s4_graded.json，无法生成标注版');
  const graded = JSON.parse(fs.readFileSync(gradedFile, 'utf8'));

  // kind='ppt' → 只要 PPT（配对任务的"PPT 标注版"）；否则按 preferPptx 的口径
  // （仅 PPT 的任务传 preferPptx=true，配对/普通任务取报告）。
  const srcName = kind === 'ppt' ? pickSource(taskDir, true, '.pptx') : pickSource(taskDir, preferPptx);
  const label = kind === 'ppt' ? 'PPT' : '原报告';
  if (!srcName) throw new Error(kind === 'ppt' ? '任务目录里没有 PPT（.pptx），无法生成 PPT 标注版' : '任务目录里找不到原报告（.docx / .pptx）');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'annot-'));
  try {
    // PPTX 先修排版（autofit → noAutofit，用副本）：否则 LibreOffice 会把正文压丢，
    // 标注框画在"没有正文的页面"上 → 表现为错位。详见 sanitizePptx 的注释与实测数据。
    const abs0 = path.join(taskDir, srcName);
    const abs = /\.pptx$/i.test(srcName) ? sanitizePptx(abs0, work, log) : abs0;

    log(`[1/4] LibreOffice 转 PDF：${label} ${srcName}`);
    const pdf = await toPdf(abs, work);

    log(`[2/4] 页面转图（${dpi} dpi）…`);
    const shotFiles = await shots(pdf, work, dpi);
    if (!shotFiles.length) throw new Error('页面转图失败');

    log('[3/4] 提取词坐标…');
    const bbox = await wordBoxes(pdf);
    const pages = buildPages(bbox);
    const ctx = { pages, grams: buildGramIndex(pages), numbers: buildNumberIndex(pages), N: 8 };

    const all = reportIssueList(graded, { scope: 'deep' });
    // 校对档的编号集合：必须跟校对成果报告用同一个函数算出来，不能靠自己按分类筛。
    // 2026-09-24 核查脚本抓出的不一致：原先校对版用 `cls === 'proofread'` 过滤，
    // 而校对成果报告是 `reportIssues(scope:'proof')` —— 它会整组丢掉 P2/P3 档
    // （哪怕某条 P2 问题按分类属于"校对类"）。结果校对版 PDF 上多印了
    // P2-1、P2-2 两条报告里根本没有的编号，按编号在报告里找不到，等于编号对不上。
    // 两档编号共享，所以按编号取集合即可，编号本身不用改。
    const proofNos = new Set(reportIssueList(graded, { scope: 'proof' }).map((x) => x.no));
    log(`[4/4] 定位 ${all.length} 条问题…（其中校对档 ${proofNos.size} 条）`);
    const items = [];
    for (const it of all) {
      const r = locate(it, ctx);
      items.push({ ...it, page: r.page, box: r.box, tier: r.tier, how: r.how || '', ratio: r.ratio, runChars: r.runChars, token: r.token });
    }
    const images = shotFiles.map(f => fs.readFileSync(path.join(work, f)).toString('base64'));
    return { work, source: srcName, pages, images, items, proofNos, dpi, seconds: Math.round((Date.now() - t0) / 1000) };
  } catch (e) {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
    throw e;
  }
}

export function cleanupAnnotation(prep) {
  if (!prep?.work) return;
  try { fs.rmSync(prep.work, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * 某一档要标注哪些条目 —— 唯一口径，renderScopePdf 与自检共用。
 *
 * WARN: 校对档绝不能"自己按分类筛"，必须用校对成果报告的编号集合（proofNos）。
 * 原因见 prepareAnnotation 里的记录：校对成果报告整组丢掉 P2/P3 档，
 * 而 `cls === 'proofread'` 会把落在 P2/P3 里的校对类问题留下 ——
 * 结果校对版 PDF 上比报告多出 P2-1、P2-2 两条编号，报告里根本找不到。
 */
export function scopeItems(items, scope, proofNos) {
  if (scope !== 'proof') return items;
  if (!proofNos) return items.filter(x => x.cls === 'proofread');   // 兼容老对象/老单测
  return items.filter(x => proofNos.has(x.no));
}

/** 渲染阶段：按 scope 出一份 PDF（proof = 只含校对类；deep = 全部） */
export async function renderScopePdf({ prep, scope = 'deep', outPdf, meta = {}, keepHtml = false }) {
  const t0 = Date.now();
  const items = scopeItems(prep.items, scope, prep.proofNos);
  const { html, stats } = renderAnnotatedHtml({
    pages: prep.pages, items, images: prep.images, scope,
    meta: { ...meta, sourceName: meta.sourceName || prep.source },
  });
  const htmlPath = path.join(prep.work, `annot-${scope}.html`);
  fs.writeFileSync(htmlPath, html, 'utf8');

  const exe = findBrowser();
  if (!exe) throw new Error('未找到 Chrome / Edge，无法导出 PDF');
  fs.mkdirSync(path.dirname(outPdf), { recursive: true });
  // WARN: 先导出到临时文件，再改名覆盖目标。
  //    直接让 Chrome 往目标路径写：目标被别的进程占用时（使用方正开着这份 PDF 看），
  //    Chrome 会静默失败，旧文件原样留着，而"文件存在且体积正常"的检查照样通过
  //    —— 2026-09-24 经实测：改完排版重新生成，页面看起来一点没变。
  const tmpPdf = outPdf + '.part-' + process.pid + Date.now() + '.pdf';
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'annot-chr-'));
  try {
    await pexec(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--no-pdf-header-footer', `--user-data-dir=${prof}`, `--print-to-pdf=${path.resolve(tmpPdf)}`,
      'file:///' + htmlPath.replace(/\\/g, '/').replace(/ /g, '%20')],
      { timeout: 900000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  } finally {
    try { fs.rmSync(prof, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (!fs.existsSync(tmpPdf) || fs.statSync(tmpPdf).size < 1024) {
    try { fs.rmSync(tmpPdf, { force: true }); } catch { /* ignore */ }
    throw new Error('PDF 导出为空');
  }
  try {
    fs.renameSync(tmpPdf, outPdf);
  } catch (e) {
    try { fs.rmSync(tmpPdf, { force: true }); } catch { /* ignore */ }
    throw new Error(`写不进去（${path.basename(outPdf)} 正被别的程序占用，多半是有人开着它在看）：${e.message}`);
  }
  if (keepHtml) fs.copyFileSync(htmlPath, path.join(path.dirname(outPdf), `annot-debug-${scope}.html`));

  // 每条问题的定位档位：成果报告要用它给"没标出来"的条目加红字提示
  const tiers = {};
  for (const it of items) tiers[it.no] = { tier: it.tier, how: it.how, page: it.page };
  return {
    ...stats, scope, outPdf, bytes: fs.statSync(outPdf).size,
    htmlMB: Math.round((html.length / 1048576) * 10) / 10,
    seconds: Math.round((Date.now() - t0) / 1000),
    tiers,
  };
}

/**
 * 一步到位（CLI / 历史任务补齐用）：分析 + 渲染 + 清理。
 * @param {object} o
 * @param {string} o.taskDir    任务目录（含原报告与 run/s4_graded.json）
 * @param {'proof'|'deep'} o.scope
 * @param {string} o.outPdf     输出 PDF 路径
 * @param {number} [o.dpi]
 * @param {boolean} [o.preferPptx]  仅 PPT 的任务：标注 PPT 本身
 * @param {'report'|'ppt'} [o.kind]  要标注哪一份：报告（默认）还是配对任务里的 PPT
 */
export async function buildAnnotatedPdf({ taskDir, scope = 'deep', outPdf, dpi = DEFAULT_DPI, preferPptx = false, kind = '', keepWork = !!process.env.ANNOT_KEEP, log = () => {} }) {
  const prep = await prepareAnnotation({ taskDir, preferPptx, kind, dpi, log });
  try {
    log(`[5/5] Chrome 导出 PDF（${scope === 'proof' ? '校对版' : '审核版'}）…`);
    return await renderScopePdf({ prep, scope, outPdf, keepHtml: keepWork, meta: { taskId: path.basename(taskDir) } });
  } finally {
    cleanupAnnotation(prep);
  }
}
