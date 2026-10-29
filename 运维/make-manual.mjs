/**
 * 生成《石油天然气工程咨询成果智能审核平台 · 操作手册》PDF（横版 PPT 风格）
 *
 * 脚本化的原因：手册需随系统一同更新（界面改动、功能新增时，手册不能依赖手工重排）。
 * 素材放在 运维\手册素材\，缺图会在页面上留占位框并打印告警，不会静默产出一份缺图的手册。
 *
 * 用法：
 *   node 运维\make-manual.mjs                 # 输出 使用手册.html + 使用手册.pdf
 *   node 运维\make-manual.mjs --html-only     # 只出 HTML（调试排版用）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const ASSETS = path.join(ROOT, '运维/手册素材');
const HTML_OUT = path.join(ROOT, '使用手册.html');
const PDF_OUT = path.join(ROOT, '使用手册.pdf');
const HTML_ONLY = process.argv.includes('--html-only');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const missing = [];
function img(name, { cap = '' } = {}) {
  const p = path.join(ASSETS, name);
  if (!fs.existsSync(p)) { missing.push(name); return `<div class="ph">（缺图：${esc(name)}）</div>`; }
  const b64 = fs.readFileSync(p).toString('base64');
  return `<figure><img src="data:image/png;base64,${b64}">${cap ? `<figcaption>${esc(cap)}</figcaption>` : ''}</figure>`;
}

const VER = (fs.readFileSync(path.join(ROOT, 'VERSION.txt'), 'utf8').match(/VERSION\s*=\s*(\S+)/) || [])[1] || '';
const TODAY = new Date().toLocaleDateString('zh-CN');

// ── 每一页幻灯片：{ 栏目, 标题, 副标题, 左/右 或 整幅 内容 } ──
const slides = [
  {
    kicker: '使用手册', title: '石油天然气工程咨询成果智能审核平台',
    sub: `AI 初审 + 人工终审 · 内网自托管 · v${VER} · ${TODAY}`,
    body: `
      <div class="cols">
        <div>
          <h3>它能帮你做什么</h3>
          <ul>
            <li>把 <b>.docx / .doc / .pptx</b> 报告传上来，几分钟后拿到一份<b>问题清单</b></li>
            <li>问题分两类：<b>校对类</b>（人人可看）与<b>深度类</b>（审核专家看）</li>
            <li>每条问题都给<b>原文摘录 + 位置 + 判定依据 + 修改建议</b></li>
            <li>新增：<b>原报告标注版 PDF</b> —— 问题直接画在原文位置上，不用来回翻</li>
          </ul>
        </div>
        <div class="note">
          <h3>先记住三件事</h3>
          <ol>
            <li>只接受 <b>Word / PPT 原件</b>，PDF 传进来会丢结构</li>
            <li>系统<b>自动识别</b>报告类型和项目类型，不用你选</li>
            <li>AI 只做初审，<b>不能替代专家终审</b></li>
          </ol>
        </div>
      </div>
      <div class="toc">
        <b>本手册内容</b>
        <span>① 四步上手（登录 → 提交 → 等待 → 看结果）</span>
        <span>② 两类成果：校对成果 / 审核成果，谁能看什么</span>
        <span>③ <b>原报告标注版</b>：问题画回原文，三种线型怎么读</span>
        <span>④ 跨源不一致：系统会告诉你"跨到哪一节"</span>
        <span>⑤ 补充审核、数据看板、系统管理（含<b>左侧栏目导航</b>）</span>
        <span>⑥ 常见问题 FAQ</span>
      </div>`,
  },
  {
    kicker: '第 1 步', title: '打开网址 → 登录',
    sub: '内网地址（示例）http://192.0.2.161:8787 —— 用管理员给你的账号密码登录',
    body: `<div class="cols">
      <div class="grow">${img('01-登录.png', { cap: '登录页：输错多次会出现验证码；连续错会被临时锁定' })}</div>
      <div class="side">
        <h3>小提示</h3>
        <ul>
          <li>首次登录请<b>立刻改密码</b></li>
          <li>忘记密码找管理员重置</li>
          <li>一个账号可多设备登录，会话 7 天过期</li>
        </ul>
      </div></div>`,
  },
  {
    kicker: '第 2 步', title: '提交报告：拖进来就行',
    sub: '支持 .docx / .doc 报告，以及 .pptx / .ppt 汇报材料（一次最多 3 份）',
    body: `<div class="cols">
      <div class="grow">${img('02-提交.png', { cap: '提交页：拖拽上传 + 调用时段选择' })}</div>
      <div class="side">
        <h3>两个选项怎么选</h3>
        <ul>
          <li><b>闲时调用（推荐）</b>：AI 排在闲时段跑，<b>半价</b>；文档解析立刻做，不花钱</li>
          <li><b>立即调用</b>：高峰期马上跑，按高峰价（2 倍）</li>
          <li><b>同时核对图表</b>：会多花积分、慢一些，重要报告再勾</li>
        </ul>
      </div></div>`,
  },
  {
    kicker: '第 3 步', title: '等多久、花多少',
    sub: '费用按「积分」计，每个账号有额度；高峰期价格翻倍，闲时半价',
    body: `<table class="tbl">
      <tr><th>时段</th><th>什么时候</th><th>价格</th></tr>
      <tr><td>高峰</td><td>工作日 9:00–12:00、14:00–18:00</td><td>2 倍</td></tr>
      <tr><td>闲时</td><td>其余时间（含晚上、周末、节假日）</td><td>半价</td></tr>
    </table>
    <div class="cols" style="margin-top:6mm">
      <div class="note">
        <h3>一般要多久</h3>
        <ul><li>一份 100 页左右的报告：<b>3~8 分钟</b>（取决于排队与时段）</li>
        <li>提交后<b>可以关掉页面</b>，系统照常跑</li></ul>
      </div>
      <div class="note">
        <h3>积分怎么算</h3>
        <ul><li>按<b>实际用量</b>折算，报告越长、问题越多花得越多</li>
        <li>额度不够找管理员申请增加</li></ul>
      </div>
    </div>`,
  },
  {
    kicker: '第 4 步', title: '看结果：审核台账',
    sub: '所有提交都在台账里，谁提交的、什么状态、花了多少，一目了然',
    body: `${img('03-台账.png', { cap: '审核台账：默认只显示你自己的记录；管理员和审核专家可看全部' })}`,
  },
  {
    kicker: '第 4 步', title: '打开一条：看清楚再审',
    sub: '状态「已完成」后点开，P0 问题直接列在页面上',
    body: `<div class="cols">
      <div class="grow">${img('04-详情.png', { cap: '详情页：问题清单 + 两个下载按钮 + 原报告标注版' })}</div>
      <div class="side">
        <h3>页面上的按钮</h3>
        <ul>
          <li><b>查看 / 下载成果</b> —— 完整成果 PDF</li>
          <li><b>原报告标注版（校对）</b> —— 问题画回原文，人人可下</li>
          <li><b>原报告标注版（审核）</b> —— 含深度类问题，需权限</li>
          <li><b>补充审核</b>（管理员）—— 针对某个要点再核一轮</li>
        </ul>
      </div></div>`,
  },
  {
    kicker: 'NEW', title: '两类成果：谁能看什么',
    sub: '同一个报告出两份成果，权限不同',
    body: `<table class="tbl">
      <tr><th>成果</th><th>里面是什么</th><th>谁能看</th></tr>
      <tr><td><b>校对成果</b></td><td>数据不一致、跨源冲突、口径混用、错别字、术语、标准规范等<b>拿编号就能核</b>的问题</td><td>所有人</td></tr>
      <tr><td><b>审核成果</b></td><td>在校对类之外，另加逻辑分析、结论正确性、建议针对性等<b>需要专业判断</b>的问题</td><td>管理员 + 审核专家</td></tr>
    </table>
    <div class="note" style="margin-top:6mm">
      <h3>编号是可以互相对照的</h3>
      <ul><li>成果报告里的 <b>P0-3 / P1-37</b>，就是标注版上的 <b>P0-3 / P1-37</b>（同一套编号）</li></ul>
    </div>`,
  },
  {
    kicker: 'NEW', title: '原报告标注版：问题直接画在原文上',
    sub: '不用再拿着清单在报告里来回翻 —— 每条问题都标在它出现的位置上',
    body: `<div class="cols">
      <div class="grow">${img('07-标注版首页.png', { cap: '第一页是说明页：标了多少条、哪几条没标出来、线型与配色什么意思' })}</div>
      <div class="side">
        <h3>三种线型</h3>
        <ul>
          <li><b>实线框</b>：引用文字在原文里找到了，位置可靠</li>
          <li><b>虚线框 ≈</b>：原文没有这句原话（表格数据被重新组织过），按数字指纹定位，位置仅供参考</li>
          <li><b>点线框 §</b>：只定位到该章节/表标题处</li>
        </ul>
      </div></div>`,
  },
  {
    kicker: 'NEW', title: '标注版怎么读（正文页）',
    sub: '左边原报告，右边批注；一条水平引线把「框」和「批注」连起来，编号与成果报告一致',
    body: `${img('08b-标注版局部-016.png', { cap: '框 = 问题位置；引线 = 从框的右缘连到批注；批注 = 编号 + 类别 + 完整问题（必要时附修改建议）' })}
      <div class="legend">
        <span><b>实线框</b> 精确定位</span><span><b>虚线框 ≈</b> 近似定位（数字指纹）</span><span><b>点线框 §</b> 只到章节标题</span>
        <span class="sw" style="background:#1668d6"></span>校对类<span class="sw" style="background:#a11212"></span>P0<span class="sw" style="background:#d97500"></span>P1<span class="sw" style="background:#c9a200"></span>P2/P3
      </div>`,
  },
  {
    kicker: 'NEW', title: '没标出来的怎么办？',
    sub: '系统如实统计：没有 100% 定位，没标到的会明确列出来，不会假装都标上了',
    body: `<div class="cols">
      <div class="grow">${img('09-未能定位清单.png', { cap: '标注版末尾的「未能定位」清单：编号 + 类别 + 原文定位 + 问题摘要' })}</div>
      <div class="side">
        <h3>怎么找</h3>
        <ul>
          <li>先看标注版<b>首页</b>的统计表：精确 / 近似 / 章节 / 未定位各多少</li>
          <li>未定位的条目按清单里的<b>「成果报告位置」</b>人工查找</li>
          <li><b>成果报告</b>里对应条目也已用<b>红字</b>标出「本条未能在原报告中标出位置」</li>
          <li>常见原因：问题出在<b>图片/图表</b>里，或属于"缺章、无附图"这类缺失型问题</li>
        </ul>
      </div></div>`,
  },
  {
    kicker: '重点', title: '跨源不一致：系统会告诉你"跨到哪里"',
    sub: '同一事实在两处取值不同时，必须成对给出「取值 + 出处」',
    body: `<div class="cols">
      <div class="note">
        <h3>报告里长这样</h3>
        <p class="mono">两处取值与出处<br>
        ① 638万元 —— 见 <b>正文3.1</b><br>
        ② 648万元 —— 见 <b>表3-1、表3-3、表1-2</b></p>
      </div>
      <div class="note">
        <h3>为什么要这样</h3>
        <ul>
          <li>只写"不同位置出现 2 个不同取值"，你还得自己再翻一遍报告找在哪</li>
          <li>现在直接给出章节号/表号，<b>顺着翻过去就能核</b></li>
          <li>标注版批注里同样带出处</li>
        </ul>
      </div>
    </div>`,
  },
  {
    kicker: '管理员', title: '补充审核：针对某个要点再核一轮',
    sub: '常规审核跑完后，管理员可填写「重点核什么」，系统做一次定向深入核查并单独出意见',
    body: `<div class="cols">
      <div class="note">
        <h3>什么时候用</h3>
        <ul>
          <li>觉得某块没审透：<b>"重点复核投资口径"</b></li>
          <li>要交叉验证：<b>"可研批复、初设概算、实际完成三者是否一致"</b></li>
          <li>每轮单独出一份《补充审核意见》，不覆盖常规成果</li>
        </ul>
      </div>
      <div class="note">
        <h3>花多少</h3>
        <ul>
          <li>只发 <b>1 次</b> API 调用（复用首轮已抽好的事实）</li>
          <li>约 1 分钟出结果，成本远低于重跑整条流水线</li>
        </ul>
      </div>
    </div>`,
  },
  {
    kicker: '管理员', title: '数据看板：用量、积分、项目台账',
    sub: '按权限区分口径：普通同事看自己的，管理员看全所',
    body: `${img('05-看板.png', { cap: '数据看板：审核次数与用量、闲时占比与省钱测算、问题分布、项目质量台账' })}`,
  },
  {
    kicker: '小技巧', title: '页面太长？用左边的「栏目导航」',
    sub: '数据看板、系统管理都有：点栏目名直接跳过去，不用一路往下拉',
    body: `<div class="cols">
      <div class="grow">${img('10-左导航.png', { cap: '点左栏的栏目名 → 直接跳到那一节（图为点了「三、问题类别分布」）' })}</div>
      <div class="side">
        <h3>怎么用</h3>
        <ul>
          <li>左栏列出这一页的<b>所有栏目</b>，点哪个跳哪个</li>
          <li>往下滚时左栏会<b>自动高亮</b>当前那一节</li>
          <li>系统管理同样有这一栏</li>
          <li>窗口窄时变成内容上方的<b>横向滑动条</b></li>
        </ul>
        <p style="margin-top:5mm;font-size:12.5pt;line-height:1.7">
          靠后的栏目<b>滚不到最顶上</b>（页面已经到底了），位置略有不齐属正常，内容就在屏幕里。
        </p>
      </div>
    </div>`,
  },
  {
    kicker: '管理员', title: '权限三档：谁能看什么、谁不能做什么',
    sub: '系统管理 → 用户管理：按级别着色（管理员深蓝 / 审核专家橙 / 普通用户灰）+ 顶部胶囊筛选 + 按级别排序，人多也一眼看清',
    body: `<table class="tbl">
      <tr><th>权限级别</th><th>能看什么</th><th>不能做什么</th></tr>
      <tr><td><b>普通用户</b></td>
        <td>只能看<b>自己提交</b>的任务；只出<b>校对成果</b>（数据不一致、错别字、格式、术语、标准规范等可自行核对的问题）</td>
        <td>看不到别人的台账、看不到审核成果</td></tr>
      <tr><td><b>审核专家</b></td>
        <td>可看<b>全部项目的台账</b>；<b>校对版 + 审核版</b>都能看能下（含逻辑分析、结论正确性、建议合理性等深度内容）；<br>也能看处理日志、用量与费用、项目质量台账</td>
        <td><b>进不了系统管理</b>：不能改账号/额度、不能看登录防护、不能改系统配置与成本模型、<br>不能删任务、不能发起补充审核</td></tr>
      <tr><td><b>管理员</b></td>
        <td>全部能力：用户与额度管理、登录防护、系统配置、成本模型、备份与看门狗</td>
        <td>—</td></tr>
    </table>
    <div class="note" style="margin-top:5mm">
      <h3>两个护栏（防止把自己锁在外面）</h3>
      <ul>
        <li>不能修改<b>自己</b>的权限级别</li>
        <li><b>最后一个管理员</b>不能被降级</li>
      </ul>
    </div>`,
  },
  {
    kicker: '管理员', title: '本次审核重点：这次要重点查什么',
    sub: '提交按钮上方（仅管理员可见）—— 只作用于这一次提交，其他同事看不到这一块',
    body: `<table class="tbl">
      <tr><th>怎么填</th><th>说明</th></tr>
      <tr>
        <td><b>勾选方向</b>（可多选）</td>
        <td>经济评价正确性 / 结论全面性 / 建议针对性 / 数据正确性 / 投资与工程量核对 /
            标准规范符合性 / 风险分析充分性 / 图表与正文一致性 / 格式与编校规范性</td>
      </tr>
      <tr>
        <td><b>补充要求</b>（文本框）</td>
        <td>写这次特别要看的地方，例如"重点核对表 5-1 的投资口径与批复文件的差异"（上限 1500 字）</td>
      </tr>
      <tr>
        <td><b>它会做什么</b></td>
        <td>① 把这些方向<b>注入 AI 的审核提示词</b>，让本次审核在这些方向逐条过一遍；<br>
            ② 在<b>成果报告开头</b>印一行"本次审核重点：…"，拿到报告的人知道这次是按什么要求查的</td>
      </tr>
      <tr>
        <td><b>什么时候清空</b></td>
        <td>提交成功后自动清空（若本批有文件提交失败则保留，方便改完文件直接重提）</td>
      </tr>
    </table>
    <div class="note" style="margin-top:5mm">
      <h3>它是"重点"，不是"只审这些"</h3>
      <ul>
        <li>其余维度的常规审核<b>照常执行</b>，不会因为勾了几项就少审别的</li>
        <li>重点方向若确实没问题，AI <b>不会硬凑问题</b>（这句写进了提示词，也有自检断言盯着）</li>
      </ul>
    </div>`,
  },
  {
    kicker: '管理员', title: '换大模型：只填一个 API Key',
    sub: '系统管理 → 模型与接口设置 → 选服务商 → 填 Key → 测试连接 → 保存（新提交的任务生效）',
    body: `<div class="cols">
      <div class="note">
        <h3>内置 4 家常用 + 自定义</h3>
        <ul>
          <li>DeepSeek（本系统原用）</li>
          <li>智谱 AI（GLM）</li>
          <li>阿里云百炼（通义千问 Qwen）</li>
          <li>月之暗面 Kimi</li>
          <li>自定义（内网 vLLM / Ollama / one-api 网关，或以后新出的服务商）</li>
        </ul>
      </div>
      <div class="note">
        <h3>模型名不用手抄</h3>
        <ul>
          <li>点「<b>↻ 拉取最新模型</b>」直接问服务商要实时列表（换服务商时也会自动拉一次）</li>
          <li>拉到的列表会<b>自动滤掉</b>嵌入、图像、语音等非对话模型，只留能用来审核的</li>
          <li>拉不到（没网 / 服务商不提供 / Key 不对）会<b>退回内置清单并说明原因</b>，不会卡住</li>
          <li>拉取<b>不会自动改</b>你正在用的模型名，只把列表给你挑</li>
        </ul>
      </div>
    </div>
    <div class="note" style="margin-top:5mm">
      <b>三点要知道</b>：① <b>测试连接</b>会真发一句最短对话，回显模型名 + 回复 + 耗时，通过再保存；
      ② 费用看板仍按 DeepSeek 价目表估算，换家后金额仅供量级参考（准确账单以服务商控制台为准）；
      ③ 「同时核对图表」需要模型支持<b>图像理解</b>，界面会按具体模型名提示（如 GLM-5.3-Flash 可读图、deepseek-flash 不可）。
    </div>`,
  },
  {
    kicker: '管理员', title: '系统管理：账号、权限、审计',
    sub: '账号停用/启用、权限级别、额度调整、重置密码、使用日志、登录防护',
    body: `<div class="cols">
      <div class="grow">${img('06-管理.png', { cap: '系统管理：项目类型 / 报告类型模板 / 用户管理（权限级别下拉）/ 使用日志入口' })}</div>
      <div class="side">
        <h3>日常要做的</h3>
        <ul>
          <li>新人入职：建账号 + 设额度</li>
          <li>评审人员：权限级别设为<b>审核专家</b>（校对版+审核版，无系统管理）</li>
          <li>每周日 22:00 <b>自动备份</b>（保留最近 8 份）</li>
          <li>服务异常：看门狗 5 分钟自愈，日志在 <span class="mono">web/data/server.log</span></li>
        </ul>
      </div></div>`,
  },
  {
    kicker: '常见问题', title: 'FAQ（同事最常问的 6 个）',
    sub: '',
    body: `<table class="tbl faq">
      <tr><th>问题</th><th>答案</th></tr>
      <tr><td>PDF 报告能传吗？</td><td>不能。只收 .docx/.doc/.pptx/.ppt —— PDF 会丢结构，审不出东西</td></tr>
      <tr><td>报告里的图和表能审吗？</td><td>表格能（文本层）；<b>图片里的内容</b>默认不读，勾选「同时核对图表」会读一部分（柱状图/折线图等），但会多花积分</td></tr>
      <tr><td>为什么有的问题没标在原文上？</td><td>问题出在图片里、或属于"缺章/无附图"这类缺失型问题，原文里本就没有可匹配的文字 → 见标注版首页与末尾清单</td></tr>
      <tr><td>一次最多传几份？</td><td>3 份；含 Word + 配对 PPT 时，勾选后会额外做一致性核对</td></tr>
      <tr><td>提交错了能重跑吗？</td><td>系统里没有"重跑"按钮，重新提交一次即可（会按重复审核提醒确认）</td></tr>
      <tr><td>结论能直接上报吗？</td><td>不能。这是<b>AI 初审</b>，须经审核专家终审后使用</td></tr>
    </table>`,
  },
  {
    kicker: '结尾', title: '三个提醒',
    sub: '',
    body: `<div class="big">
      <p><b>1. 先看标注版首页</b> —— 一眼知道这份标注能信到什么程度（精确 / 近似 / 未定位各多少）。</p>
      <p><b>2. 以成果报告文字为准</b> —— 标注版是"指路"，判定依据与修改建议都在成果报告里。</p>
      <p><b>3. AI 只做初审</b> —— 关键结论、上报口径请交审核专家复核后再用。</p>
    </div>
    <div class="foot-note">有问题或想加功能：找系统管理员（石油天然气工程咨询成果智能审核平台 · v${VER}）</div>`,
  },
];

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>石油天然气工程咨询成果智能审核平台 · 操作手册</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:"Microsoft YaHei","Songti SC",sans-serif;color:#1a1d21;background:#e9edf2}
.slide{position:relative;width:297mm;height:209mm;background:#fff;padding:14mm 16mm 16mm;
  page-break-after:always;break-after:page;overflow:hidden;display:flex;flex-direction:column}
.slide:last-child{page-break-after:auto;break-after:auto}
.kicker{display:inline-block;background:#0b3d6b;color:#fff;font-size:11pt;padding:1mm 3.5mm;border-radius:1mm;
  letter-spacing:1px}
h1{font-size:23pt;color:#0b3d6b;margin:4mm 0 2mm}
h2{font-size:21pt;color:#0b3d6b;margin:3.5mm 0 2mm}
.sub{font-size:12.5pt;color:#5b636e;padding-bottom:3mm;border-bottom:2px solid #0b3d6b;margin-bottom:5mm}
.body{flex:1;display:flex;flex-direction:column;gap:4mm;min-height:0}
.cols{display:flex;gap:7mm;align-items:flex-start;min-height:0}
.cols .grow{flex:1;min-width:0}
.cols .side{width:78mm;flex:none;background:#f6f8fb;border-left:4px solid #0b3d6b;padding:4mm 5mm;border-radius:1mm}
.note{flex:1;background:#f6f8fb;border-left:4px solid #0b3d6b;padding:4mm 5mm;border-radius:1mm}
h3{font-size:15pt;color:#0b3d6b;margin-bottom:3mm}
ul,ol{margin-left:5.5mm}
li{font-size:13.5pt;line-height:1.85;margin:2mm 0}
p{font-size:13.5pt;line-height:1.85}
table.tbl{width:100%;border-collapse:collapse;font-size:13pt}
table.tbl th,table.tbl td{border:1px solid #d5dbe3;padding:3.2mm 3.5mm;text-align:left;vertical-align:top}
table.tbl th{background:#f0f4f9;color:#0b3d6b}
table.tbl.faq td:first-child{width:56mm;font-weight:600}
figure{margin:0;text-align:center}
figure img{max-width:100%;max-height:132mm;border:1px solid #d5dbe3;border-radius:1mm;box-shadow:0 1mm 3mm rgba(0,0,0,.08)}
figcaption{font-size:10pt;color:#6b7280;margin-top:1.6mm}
.ph{border:1px dashed #d5dee8;color:#9aa3ad;padding:12mm;font-size:11pt;text-align:center}
.big p{font-size:15pt;line-height:1.9;margin:3mm 0}
.foot-note{margin-top:auto;font-size:11pt;color:#6b7280;border-top:1px solid #e3e8ee;padding-top:3mm}
.mono{font-family:Consolas,monospace;background:#fff;border:1px solid #e3e8ee;padding:3mm 4mm;border-radius:1mm;font-size:12pt;line-height:1.8}
.toc{margin-top:6mm;background:#f6f8fb;border:1px solid #dde5ee;border-radius:1mm;padding:4mm 5mm;display:flex;flex-direction:column;gap:1.6mm}
.toc b{font-size:12.5pt;color:#0b3d6b;margin-bottom:1mm}
.toc span{font-size:12pt;line-height:1.6}
.pnum{position:absolute;right:16mm;bottom:7mm;font-size:10pt;color:#9aa3ad}
.legend{display:flex;align-items:center;gap:6mm;flex-wrap:wrap;font-size:11.5pt;color:#39414a;
  background:#f6f8fb;border:1px solid #dde5ee;border-radius:1mm;padding:2.5mm 4mm}
.legend .sw{display:inline-block;width:4mm;height:2.6mm;border-radius:.6mm;margin:0 -4mm 0 0;vertical-align:middle}
@page{size:A4 landscape;margin:0}
@media print{body{background:#fff}}
</style></head><body>
${slides.map((s, i) => `<section class="slide">
  ${s.kicker ? `<div><span class="kicker">${esc(s.kicker)}</span></div>` : ''}
  <h${s.title === '石油天然气工程咨询成果智能审核平台' ? '1' : '2'}>${esc(s.title)}</h${s.title === '石油天然气工程咨询成果智能审核平台' ? '1' : '2'}>
  ${s.sub ? `<div class="sub">${esc(s.sub)}</div>` : '<div style="height:2mm"></div>'}
  <div class="body">${s.body}</div>
  <div class="pnum">${i + 1} / ${slides.length}</div>
</section>`).join('\n')}
</body></html>`;

fs.writeFileSync(HTML_OUT, html, 'utf8');
console.log(`✓ HTML：${path.relative(ROOT, HTML_OUT)}（${(html.length / 1048576).toFixed(1)} MB，${slides.length} 页）`);
if (missing.length) console.log(`⚠️ 缺图 ${missing.length} 张：${missing.join('、')}`);

if (!HTML_ONLY) {
  const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
  if (!CHROME) { console.error('未找到 Chrome/Edge，无法导出 PDF'); process.exit(1); }
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-'));
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
