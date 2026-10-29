/**
 * 《操作说明》生成器（A4 纵向 · 按常规工作流编排）
 *
 * 与 使用手册.mjs 的区别：那一本是全员/管理视角的横版 PPT 手册；
 * 这一本只讲日常提交与查看成果的竖版图文说明 —— 每页一张圈注截图 + 编号步骤，不使用术语。
 * （命名口径：2026-09-28 确定文档中不出现身份修饰词，直接称《操作说明》。）
 *
 * 素材由同目录下三个脚本产出（界面改版后按顺序重新执行即可，本文件无需改动）：
 *   ① demo-data.mjs    合成示例数据（虚构项目名/虚构问题，保证文档里没有真实报告内容）
 *   ② screenshot.cjs   按 shots.json 拍图，并同时量出元素坐标（.rects.json）
 *   ③ annotate.py      按元素名画红框 / 箭头 / 编号牌
 *
 * 用法：node 运维\staff-guide\make-guide.mjs
 *   → 输出 操作说明.html 与 操作说明.pdf
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '../..');
const SHOTS = path.join(ROOT, '运维/staff-guide/annotated');
const HTML_OUT = path.join(ROOT, '操作说明.html');
const PDF_OUT = path.join(ROOT, '操作说明.pdf');
const HTML_ONLY = process.argv.includes('--html-only');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const missing = [];
function shot(name) {
  const p = path.join(SHOTS, name + '.png');
  if (!fs.existsSync(p)) { missing.push(name); return '<div class="ph">（缺图：' + esc(name) + '）</div>'; }
  return `<img class="shot" src="data:image/png;base64,${fs.readFileSync(p).toString('base64')}">`;
}
const VER = (fs.readFileSync(path.join(ROOT, 'VERSION.txt'), 'utf8').match(/VERSION\s*=\s*(\S+)/) || [])[1] || '';
const TODAY = new Date().toLocaleDateString('zh-CN');

/** 每页：{ 步骤号, 标题, 一句说明, 图, 步骤清单, 提醒, 小贴士 } */
const pages = [
  {
    n: '开始之前', title: '操作说明',
    cover: true,
    lead: '你只要能上网、有账号，会拖文件，就会用。整件事只有四步，全程不用记术语。',
    body: `
      <div class="flow">
        <span class="fi"><b>上传报告</b><i>拖进去，点提交</i></span>
        <span class="fa">➜</span>
        <span class="fi"><b>等几分钟</b><i>可以关掉页面</i></span>
        <span class="fa">➜</span>
        <span class="fi"><b>看成果</b><i>问题清单 + 标注版</i></span>
        <span class="fa">➜</span>
        <span class="fi"><b>照单修改</b><i>先改 P0</i></span>
      </div>
      <div class="two">
        <div class="card">
          <h3>你需要准备</h3>
          <ul>
            <li><b>Word 或 PPT 原件</b>（.docx / .doc / .pptx / .ppt）<br>
                <span class="muted">PDF 不要传 —— 表格结构会丢，审核会漏问题</span></li>
            <li>浏览器打开工作台网址（问管理员要），用<b>本人姓名</b>当账号登录</li>
          </ul>
        </div>
        <div class="card">
          <h3>系统会替你做什么</h3>
          <ul>
            <li>自动认出<b>报告类型</b>和<b>项目类型</b>，不用你选</li>
            <li>给出<b>问题清单</b>：每条都有原文摘录、位置、修改建议</li>
            <li>再给一份<b>原报告标注版</b>：问题直接画在原文那一页上</li>
          </ul>
        </div>
      </div>
      <div class="note">
        <b>看图说明</b>：本说明里的截图都做了标记 ——
        <span class="k"><i class="box"></i>红框</span>＝要点的位置，
        <span class="k"><i class="arrow"></i>箭头</span>＝点这里，
        <span class="k"><i class="badge">1</i>编号</span>＝操作顺序。
      </div>`,
  },
  {
    n: '第 1 步', title: '登录',
    lead: '用<b>本人姓名</b>当用户名（就是管理员给你建的账号名）。',
    img: '01-login',
    steps: [
      '在「用户名」里填本人姓名或账号',
      '填密码（初始密码是 <b>123456</b>）',
      '点「登 录」',
    ],
    warn: '<b>第一次登录后务必马上改密码</b>：登录后页面顶部会有黄色提醒，点它右边的「去修改密码」即可。<br>不改的话，别人用你的名字就能看到你的报告和审核结果。',
    tip: '密码连续输错 3 次，登录框会多出一道<b>算术验证码</b>；连续错 5 次账号会被锁 15 分钟（找管理员可立刻解锁）。',
  },
  {
    n: '第 2 步', title: '上传报告',
    lead: '一次最多传 <b>3 个</b>文件，可以连续提交多批。',
    img: '02-submit',
    steps: [
      '把报告<b>拖进虚线框</b>，或点框选择文件（也可以一次选多个）',
      '选调用时机：<b>闲时调用（推荐）</b>＝消耗的积分更少，但要等到下班后/夜里才开跑；<b>立即调用</b>＝马上跑，高峰时段消耗的积分更多',
      '要看图里的表和图 —— 勾上「同时核对图表」（会多花一点、慢 1~2 分钟）',
      '点「提交审核」',
    ],
    warn: '时段提示会告诉你现在是高峰还是空闲、什么时候开始跑（如"AI 调用排在 今天 12:10，那时消耗的积分更少"）。<br>⚠️ 若管理员把选择关掉了，这里只显示一行"当前由管理员统一设置为立即调用"，直接提交即可。',
    tip: '同一批里既有<b>报告又有汇报 PPT</b>时，页面会多出「PPT 与报告一致性检查」选项 —— 勾上会额外核对两边数据/结论对不对得上。',
  },
  {
    n: '第 3 步', title: '等结果（可以关页面）',
    lead: '一般 <b>2~3 分钟</b>；报告大或选了闲时会更久。',
    img: '03-progress',
    steps: [
      '提交后页面自动跳到「审核台账 → 处理进度」',
      '每一条任务都会显示走到哪一步：解析文档 → 等待闲时 → AI 审核 → 生成成果',
      '看到状态变成绿色的「<b>已完成</b>」就好了',
    ],
    warn: '<b>关掉页面也会照常跑</b> —— 服务器在工作，不用一直开着。<br>同一时间服务器跑 6 个任务，而且<b>每人手上保证有一个先跑</b>；人多时进度条上会写"排队中，前面还有 N 个"。',
    tip: '真的很急（业主在等、要上会）：<b>找管理员</b>在工作台里给你的任务点「立即开始」，它会插到队首、不再等闲时。',
  },
  {
    n: '第 4 步', title: '在台账里找到自己的记录',
    lead: '记录按提交时间倒序排，最新的在最上面。',
    img: '04-ledger',
    steps: [
      '用搜索框按<b>项目名称、编号、文件名</b>找（边打边筛，不用点搜索）',
      '下拉框可以只看「已完成」或「排队中」',
      '点每行右边的「<b>查看</b>」打开这条任务的成果',
    ],
    warn: '左下角的类别按钮（如「产能后评价」）是<b>按项目类别筛</b>，点一下只看这一类。',
    tip: '记录只能看到<b>自己提交</b>的（别人提交的你搜不到，这是权限设计，不是故障）。',
  },
  {
    n: '第 5 步', title: '看成果、下载成果',
    lead: '任务详情里有三样东西，按需取用。',
    img: '05-detail',
    steps: [
      '「<b>查看校对成果</b>」：网页版问题清单，直接在浏览器里看',
      '「<b>下载校对成果</b>」：PDF，方便打印或转发',
      '「<b>原报告标注版</b>」：<b>最省事的一份</b> —— 问题直接画在你原报告的对应页面上，照着改就行',
      '若你同时传了 <b>PPT</b>（做报告与 PPT 一致性核对）：还会多一个「<b>原PPT标注版</b>」，问题直接画在 PPT 那一页上',
    ],
    warn: '成果页里还写着「标注版定位率」（精确定位多少条）—— 那是告诉你<b>标注版能信到什么程度</b>，没能在原文定位的条目不标，但仍会列在成果清单里。',
    tip: '同一项目<b>改完再提交一次</b>：新版成果里会多一节「上次审核问题的修改情况」，逐条告诉你上次的问题改了没、哪条还没响应 —— 不用自己翻旧成果对比。',
  },
  {
    n: '看重点', title: '成果怎么读：先改 P0',
    lead: '问题分两级，<b>先看红色那栏</b>。',
    img: '06-report',
    steps: [
      '顶部「<b>校对类问题汇总</b>」告诉你这次有几项 P0、几项 P1',
      '<b>P0＝必须修改</b>（不改就不具备上报/验收条件）',
      '<b>P1＝建议修改</b>（错别字、术语、格式这类，有时间就改）',
      '每条问题都写着：问题 / 原文定位 / 原文摘录 / 修改建议 —— 照着改即可',
    ],
    warn: '你看到的是<b>校对类</b>（数据不一致、错别字、格式、术语等你能自己核对的）；<br>逻辑、结论、建议这类「深度类」问题只给<b>审核专家</b>看，需要时找他们。',
  },
  {
    n: '关于积分', title: '积分：用了多少、还剩多少',
    lead: '每次审核按<b>实际用量</b>扣积分（报告越长、问题越多，扣得越多），<b>不限次数</b>。',
    img: '07-points',
    steps: [
      '「数据看板 → 一、审核次数与用量」里看自己的本月积分消耗',
      '右边饼图直接看<b>已用 / 剩余</b>，绿色是剩余',
      '积分不够时，页面上会出现「申请增加积分」，填用途提交给管理员',
    ],
    warn: '想省积分就选「<b>闲时调用</b>」：非高峰时段消耗的积分约为高峰时的<b>一半</b>（工作日 12:00-14:00、18:00 之后、周末与节假日都算闲时）。',
    tip: '积分按<b>北京时间自然月</b>重新开始，用不完不结转；审核<b>失败不扣积分</b>。',
  },
  {
    n: '遇到问题', title: '卡住了怎么办',
    lead: '九成问题都在下面这张表里。',
    body: `
      <table class="faq">
        <tr><td>提交时提示「只接受 Word / PPT」</td><td>先把 PDF 用 Word 打开另存为 .docx 再传。</td></tr>
        <tr><td>提示「同一个项目已有人审过」</td><td>系统怕你重复审、白花积分，暂停了。要再审一次就点「<b>确认重复审核</b>」，否则直接看那条历史记录。</td></tr>
        <tr><td>状态一直是「排队中」</td><td>同时跑 6 个任务、每人最多 2 个，系统尽量让每人手上都有一个先跑；人多时等一会，进度条会写前面还有几个。</td></tr>
        <tr><td>状态变成「失败」</td><td>卡片上会写原因（常见：文件损坏、超大、加密）。改好后<b>重新提交</b>即可，失败不扣积分。</td></tr>
        <tr><td>忘了密码 / 登不进</td><td>找管理员在「系统管理 → 用户管理」里点「重置密码」，你会变回初始密码 123456。</td></tr>
        <tr><td>顶部有黄条「您正在使用初始密码」</td><td>点右上角「<b>修改密码</b>」改掉（至少 6 位，别用 123456）。不改的话，同网段的同事能用你的名字登录。</td></tr>
        <tr><td>提示「<b>本机没有访问权限</b>」</td><td>系统按<b>电脑绑定</b>放行（防其他部门）。页面上会显示你本机 IP，<b>报给管理员</b>即可；换电脑、笔记本用无线也会这样。</td></tr>
        <tr><td>找不到自己的报告了</td><td>用台账搜索框按项目名或文件名搜；也可以按「已完成」筛选。</td></tr>
        <tr><td>标注版要不要等我点「生成」</td><td><b>不用等</b>：审核跑完时两份标注版就已经生成好了，点开直接下载。若写「<b>重试生成</b>」，说明上次没成功，按钮下会写明原因。</td></tr>
        <tr><td>结果里有一条你觉得不对</td><td>不用管它，以审核专家判断为准；也可以在系统里给管理员反馈。</td></tr>
      </table>
      <div class="note">还有问题：问系统管理员（工作台右上角「<b>帮助</b>」里也有常见问题清单）。</div>`,
  },
];

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>石油天然气工程咨询成果智能审核平台 · 操作说明</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:"Microsoft YaHei","Songti SC",sans-serif;color:#1a1d21;background:#e9edf2;
  -webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{position:relative;width:210mm;min-height:297mm;background:#fff;padding:14mm 14mm 16mm;
  page-break-after:always;break-after:page;display:flex;flex-direction:column;gap:4mm}
.page:last-child{page-break-after:auto}
.n{display:inline-block;background:#0b3d6b;color:#fff;font-size:11.5pt;padding:1mm 4mm;border-radius:1mm;letter-spacing:.5px}
h1{font-size:22pt;color:#0b3d6b;margin:3mm 0 1mm}
h2{font-size:19pt;color:#0b3d6b;margin:3mm 0 1mm}
.lead{font-size:12pt;color:#39414a;line-height:1.75;padding-bottom:3mm;border-bottom:2px solid #0b3d6b}
.steps{list-style:none;counter-reset:s}
.steps li{counter-increment:s;position:relative;padding-left:10mm;font-size:12pt;line-height:1.75;margin:2.2mm 0}
.steps li::before{content:counter(s);position:absolute;left:0;top:1.2mm;width:6.6mm;height:6.6mm;border-radius:50%;
  background:#f59e0b;color:#fff;font-weight:700;font-size:10.5pt;display:flex;align-items:center;justify-content:center}
.shot{width:100%;max-height:104mm;object-fit:contain;object-position:center top;
  border:1px solid #d5dbe3;border-radius:1mm;box-shadow:0 1mm 3mm rgba(0,0,0,.08)}
.photo{display:flex;flex-direction:column;gap:2mm}
/* 这里不写 overflow:hidden —— 那样会把超出的文字静默裁掉，比溢出更难排查。
   页面是否超出一页 A4 由 运维/staff-guide/check-guide.mjs 检查（超出会报错）。*/
.warn{background:#fff8e6;border-left:4px solid #f59e0b;padding:3mm 4mm;border-radius:1mm;font-size:11.5pt;line-height:1.75}
.two{display:flex;gap:6mm;align-items:flex-start}
.card{flex:1;background:#f6f8fb;border:1px solid #dde5ee;border-radius:1mm;padding:4mm 5mm}
.card h3{font-size:13pt;color:#0b3d6b;margin-bottom:2mm}
ul{margin-left:5mm}
li{font-size:11.5pt;line-height:1.7}
.muted{color:#6b7280}
.note{margin-top:3mm;background:#f6f8fb;border:1px solid #dde5ee;border-radius:1mm;padding:3mm 4mm;font-size:11pt;line-height:1.8}
.k{display:inline-flex;align-items:center;gap:1.5mm;margin-right:4mm}
.box{display:inline-block;width:7mm;height:4mm;border:1.2mm dashed #e11d48;border-radius:1mm}
.arrow{display:inline-block;width:8mm;height:2mm;background:#0b3d6b;position:relative}
.arrow::after{content:"";position:absolute;right:-1.6mm;top:-1mm;border-left:2.4mm solid #0b3d6b;
  border-top:2mm solid transparent;border-bottom:2mm solid transparent}
.badge{display:inline-flex;align-items:center;justify-content:center;width:5.4mm;height:5.4mm;border-radius:50%;
  background:#f59e0b;color:#fff;font-weight:700;font-size:9.5pt;font-style:normal}
table.faq{width:100%;border-collapse:collapse;font-size:11.5pt}
table.faq td{border:1px solid #d5dbe3;padding:2.6mm 3mm;vertical-align:top;line-height:1.7}
table.faq td:first-child{width:62mm;font-weight:600;background:#f6f8fb}
/* 封面：大标题 + 顶部色条 */
.cover{border-top:6mm solid #0b3d6b;padding-top:10mm}
.cover .top{font-size:12.5pt;color:#0b3d6b;letter-spacing:2px}
.cover h1{font-size:31pt;margin:5mm 0 3mm}
.cover .sub{font-size:12pt;color:#5b636e;margin-bottom:8mm}
/* 流程条：用箭头表示整体流程（2026-09-28 确定的呈现方式） */
.flow{display:flex;align-items:stretch;gap:2mm;margin:2mm 0 5mm}
.flow .fi{flex:1;background:#f6f8fb;border:1px solid #dde5ee;border-top:3px solid #0b3d6b;border-radius:1mm;
  padding:3mm 3mm;display:flex;flex-direction:column;gap:1mm}
.flow .fi b{font-size:12pt;color:#0b3d6b}
.flow .fi i{font-size:10pt;color:#6b7280;font-style:normal}
.flow .fa{align-self:center;color:#0b3d6b;font-size:15pt;font-weight:700}
/* 小贴士：与"注意"区分开（注意是黄底，贴士是蓝底） */
.tip{margin-top:3mm;background:#eef4fb;border-left:4px solid #0b3d6b;border-radius:1mm;
  padding:3mm 4mm;font-size:11.5pt;line-height:1.75}
.tip b.h{color:#0b3d6b}
.pnum{position:absolute;right:14mm;bottom:8mm;font-size:9.5pt;color:#9aa3ad}
.ph{border:1px dashed #d5dee8;color:#9aa3ad;padding:16mm;text-align:center;font-size:11pt}
@page{size:A4 portrait;margin:0}
@media print{body{background:#fff}}
</style></head><body>
${pages.map((p, i) => `<section class="page${p.cover ? ' cover' : ''}">
  ${p.cover
      ? `<div class="top">石油天然气工程咨询成果智能审核平台</div>
         <h1>${esc(p.title)}</h1>
         <div class="sub">从上传到拿成果，一共 4 步　·　v${esc(VER)}　·　${TODAY}　·　内网自托管</div>`
      : `<div><span class="n">${esc(p.n)}</span></div>
         <h2>${esc(p.title)}</h2>`}
  <div class="lead">${p.lead}</div>
  ${p.img ? `<div class="photo">${shot(p.img)}</div>` : ''}
  ${p.steps ? `<ol class="steps">${p.steps.map(s => `<li>${s}</li>`).join('')}</ol>` : ''}
  ${p.body || ''}
  ${p.warn ? `<div class="warn">${p.warn}</div>` : ''}
  ${p.tip ? `<div class="tip"><b class="h">小贴士</b>　${p.tip}</div>` : ''}
  <div class="pnum">${i + 1} / ${pages.length}　·　石油天然气工程咨询成果智能审核平台 v${esc(VER)}　·　${TODAY}</div>
</section>`).join('\n')}
</body></html>`;

fs.writeFileSync(HTML_OUT, html, 'utf8');
console.log(`✓ HTML：${path.relative(ROOT, HTML_OUT)}（${(html.length / 1048576).toFixed(1)} MB，${pages.length} 页）`);
if (missing.length) console.log(`⚠️ 缺图 ${missing.length} 张：${missing.join('、')}`);

if (!HTML_ONLY) {
  const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
  if (!CHROME) { console.error('未找到 Chrome/Edge，无法导出 PDF'); process.exit(1); }
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-'));
  const tmp = PDF_OUT + '.part.pdf';
  try {
    await pexec(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-pdf-header-footer',
      `--user-data-dir=${prof}`, `--print-to-pdf=${tmp}`,
      'file:///' + HTML_OUT.replace(/\\/g, '/').replace(/ /g, '%20')], { timeout: 300000, windowsHide: true });
  } finally { try { fs.rmSync(prof, { recursive: true, force: true }); } catch { /* ignore */ } }
  if (!fs.existsSync(tmp)) { console.error('PDF 导出失败'); process.exit(1); }
  fs.renameSync(tmp, PDF_OUT);
  console.log(`✓ PDF ：${path.relative(ROOT, PDF_OUT)}（${(fs.statSync(PDF_OUT).size / 1048576).toFixed(1)} MB）`);
}
