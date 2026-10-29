/**
 * 数据看板「按人员 / 按类别 / 积分」自检（零 API；纯逻辑 + 界面静态断言）
 *
 * 2026-09-28 口径变更：
 *   ① 「四、项目台账」分析内容不突出 → 增加 按人员 / 按项目类别 / 整改闭环 三个视角；
 *   ② 「项目类型明细」增加 P1/报告 列，并把 P0/报告、P1/报告 分别紧跟 P0、P1；
 *   ③ 「审核次数与用量」增加一个"积分消耗 / 剩余"饼图。
 *
 * 这里断言的是口径（数字怎么算出来的）：看板最常见的问题不是渲染失败，
 * 而是"同一个数在两处不一样"。
 *
 * 用法：node engine\test-dashboard.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wbdash-'));
process.env.WB_DATA_DIR = tmp;
const L = await import('../web/lib.mjs');

let pass = 0, fail = 0;
const ok = (c, n, extra = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${extra ? '  ← ' + extra : ''}`); } };
const eq = (a, b, n) => ok(a === b, n, `实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`);

const T = (o) => ({
  status: 'done', peak: false, proofreadCount: 0, deepCount: 0, cost: 0,
  // 默认带上 usage：看板的"费用"口径只计用量记录完整的任务（isUsageComplete），
  //    不带 usage 的任务会被排除 —— 首版造数未带 usage，导致"全所实际消耗"算出 0。
  usage: { prompt: 100000, completion: 20000, cacheHit: 0 },
  stats: { p0Count: 0, p1Count: 0 }, ...o,
});

console.log('\n── 1. 按人员 / 按类别汇总 ──');
{
  const tasks = [
    T({ id: 'a', ownerName: '李四', owner: 'u1', projectType: '产能后评价', proofreadCount: 10, deepCount: 5, cost: 1.5, stats: { p0Count: 2, p1Count: 3 }, peak: false }),
    T({ id: 'b', ownerName: '李四', owner: 'u1', projectType: '产能后评价', proofreadCount: 4, deepCount: 0, cost: 0.5, stats: { p0Count: 1, p1Count: 1 }, peak: true }),
    T({ id: 'c', ownerName: '钱八', owner: 'u2', projectType: '装备购置可研', proofreadCount: 6, deepCount: 2, cost: 1.0, stats: { p0Count: 0, p1Count: 5 },
        compare: { stats: { total: 8, fixed: 6, partial: 1, unfixed: 1, unknown: 0, unfixedP0: 1, unfixedP1: 0 } } }),
    { id: 'd', status: 'failed', ownerName: '钱八', owner: 'u2', projectType: '装备购置可研' },
    { id: 'e', status: 'cancelled', ownerName: '李四', owner: 'u1', projectType: '产能后评价' },
    { id: 'f', status: 'duplicate-suspect', ownerName: '钱八', owner: 'u2', projectType: '装备购置可研' },
  ];
  const r = L.buildRollups(tasks, { canDeep: true });
  const wang = r.byUser.find(x => x.name === '李四');
  eq(wang.subs, 3, '按人员：李四提交 3 次（含 1 次已取消）');
  eq(wang.done, 2, '已完成 2 次');
  eq(wang.cancelled, 1, '已取消 1 次');
  eq(wang.offpeak, 1, '闲时 1 次（只有 done 且 peak=false 才算）');
  eq(wang.peak, 1, '忙时 1 次');
  eq(wang.proofread, 14, '校对类条数合计');
  eq(wang.deep, 5, '深度类条数合计');
  eq(wang.p0, 3, 'P0 合计（有深度权限时用完整 stats）');
  eq(wang.points, 2, '积分消耗 ≈ 费用合计（1 积分 ≈ ¥1）');

  const zhang = r.byUser.find(x => x.name === '钱八');
  eq(zhang.failed, 1, '失败 1 次');
  eq(zhang.pendingDup, 1, '待确认重复 1 次');
  eq(zhang.resp.total, 8, '整改闭环：该人历次对比合计 8 条');
  eq(zhang.resp.unfixedP0, 1, '整改闭环：未响应 P0 1 条（要红字提醒）');
  eq(wang.resp.total, 0, '没做过再次审核的人：整改闭环为 0（界面显示"—"）');

  const type = r.byType.find(x => x.name === '产能后评价');
  eq(!!type, true, '按项目类别也有这一桶');
  eq(type.subs, 3, '按类别：产能后评价提交 3 次');
  eq(type.offpeak, 1, '按类别：闲时次数同样口径');

  const shallow = L.buildRollups(tasks, { canDeep: false });
  const w2 = shallow.byUser.find(x => x.name === '李四');
  eq(w2.deep, 0, '普通用户口径：不给深度类条数');
  eq(w2.p0, 0, '普通用户口径：P0 只算校对类（这里没给 proofreadP0 → 0）');

  const withPf = L.buildRollups([T({ ownerName: '甲', proofreadP0: 3, proofreadP1: 4, stats: { p0Count: 99, p1Count: 99 } })], { canDeep: false });
  eq(withPf.byUser[0].p0, 3, '普通用户口径：用校对类 P0（不泄露深度类 99）');
  ok(r.byUser.every(x => typeof x.points === 'number'), '积分字段是数值（便于前端直接算合计）');
  eq(r.byUser[0].name, '李四', '默认按提交次数降序');
}

console.log('\n── 2. 全所积分池（管理员视角）──');
{
  const users = L.listUsers();
  L.saveUsers([
    { id: 'u1', username: 'a', name: '甲', role: 'user', budget: 100, disabled: false },
    { id: 'u2', username: 'b', name: '乙', role: 'user', budget: 50, disabled: false },
    { id: 'u3', username: 'c', name: '丙', role: 'user', budget: 100, disabled: true },   // 停用不计
    { id: 'u0', username: 'admin', name: '管理员', role: 'admin', budget: 0 },             // 管理员不限，不计
  ]);
  const now = new Date();
  const iso = now.toISOString();
  const tasks = [
    T({ id: 'x', owner: 'u1', ownerName: '甲', cost: 30, createdAt: iso, finishedAt: iso }),
    T({ id: 'y', owner: 'u2', ownerName: '乙', cost: 10, createdAt: iso, finishedAt: iso }),
  ];
  const pool = L.pointsPool(tasks);
  eq(pool.budget, 150, '积分池总额＝各人月度额度之和（100+50；停用与管理员不计）');
  eq(pool.used, 40, '已用（限额账号口径）＝各人本月消耗之和（30+10）');
  eq(pool.users, 2, '计入 2 人');

  // 2026-09-28 BUG：饼图"已消耗 2 积分"与右侧"¥40.3 实际费用"不一致。
  //   根因：池子原来只累加限额账号的消耗，而当月 97% 的花费来自"不限额度"的使用方与管理员。
  //   现在额外给出 usedAll（全所实际，与 ¥ 同源）与 remaining（限额账号真正可花的额度）。
  const tasks2 = [
    ...tasks,
    T({ id: 'z1', owner: 'u9', ownerName: '不限额的人', cost: 100, createdAt: iso, finishedAt: iso }),   // 额度 0＝不限
    T({ id: 'z2', owner: 'u0', ownerName: '管理员', cost: 20, createdAt: iso, finishedAt: iso }),        // 管理员
  ];
  const p2 = L.pointsPool(tasks2);
  eq(p2.usedAll, 160, '**usedAll＝全所本月实际消耗（含不限额账号与管理员）**：30+10+100+20');
  eq(p2.remaining, Math.round((150 - 40) * 100) / 100, '**remaining＝限额账号真正还能花的额度**（budget − 限额已用）');
  eq(p2.poolTotal, Math.round((150 + (160 - 40)) * 100) / 100, 'poolTotal＝额度 + 不限额账号的消耗（自平衡，饼图两片才自洽）');
  eq(Math.round((p2.poolTotal - p2.usedAll) * 100) / 100, p2.remaining, '分母 − 已消耗 必须等于剩余（口径闭合）');
  eq(L.instituteMonthCost(tasks2), 160, 'instituteMonthCost()＝全所本月实际消耗（与 ¥ 同口径）');
  // 只算记录完整的任务（与 KPI 一致）：缺 usage 的历史任务不计
  const incomplete = T({ id: 'bad', owner: 'u1', cost: 999, createdAt: iso, finishedAt: iso, usage: null });
  eq(L.instituteMonthCost([...tasks2, incomplete]), 160, '记录残缺的任务不计入（否则会把费用算歪，与 KPI 口径不一致）');
  eq(L.instituteMonthCost([...tasks2, incomplete], { completeOnly: false }), 1159, '需要时可关掉完整性过滤（对照用）');
  eq(L.instituteMonthCost([T({ id: 'old', owner: 'u1', cost: 50, createdAt: '2020-01-01T00:00:00Z' })]), 0, '只算本月（上月的不进本月消耗）');
  const libSrc = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'web', 'lib.mjs'), 'utf8');
  ok(/usedAll,/.test(libSrc) && /remaining: r2\(poolTotal - usedAll\)/.test(libSrc), 'pointsPool 返回 usedAll / remaining');
  L.saveUsers(users);      // 还原（不影响别的自检）
}

console.log('\n── 2c. 省钱效果与 KPI 必须同口径（用户报"¥39.95 与 ¥40.3 并存"）──');
{
  const now = new Date();
  const iso = now.toISOString();
  const ok1 = T({ id: 'a', owner: 'u1', cost: 10, peak: true, createdAt: iso, finishedAt: iso,
    usage: { prompt: 1e6, completion: 0, cacheHit: 0 } });
  const bad = T({ id: 'b', owner: 'u1', cost: 99, peak: true, createdAt: iso, finishedAt: iso, usage: null });
  const st = L.buildPeakStats([ok1, bad], { range: 'all', now });
  eq(st.saving.actual, 10, '**省钱效果的"实际费用"只算记录完整的任务**（与 KPI「API 费用合计」同源；原来把残缺的也算进来）');
  eq(st.total.count, 2, '**但"次数"照算全部已完成任务**（与 KPI「已完成审核（次）」一致 —— 两者不能一起过滤）');
  eq(st.excludedFromCost, 1, '并报出"未计入费用的条数"，界面据此说明一句');
  const st2 = L.buildPeakStats([ok1, bad], { range: 'all', now, completeOnly: false });
  eq(st2.saving.actual, 109, '需要时可关掉完整性过滤（对照口径用）');
  eq(st2.excludedFromCost, 0, '关掉过滤后就没有"未计入"的条目');
  const libSrc2 = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'web', 'lib.mjs'), 'utf8');
  ok(/excludedFromCost,/.test(libSrc2), 'buildPeakStats 返回 excludedFromCost');
}

console.log('\n── 2b. 额度 0 ＝ 不限（用户 2026-09-28 发现"设 0 却显示 0"）──');
{
  const users = L.listUsers();
  L.saveUsers([
    { id: 'u1', username: 'a', name: '甲', role: 'user', budget: 100, disabled: false },
    { id: 'u2', username: 'b', name: '乙', role: 'user', budget: 0, disabled: false },     // 0 ＝ 不限
    { id: 'u3', username: 'c', name: '丙', role: 'user', budget: 50, disabled: false },
  ]);
  const iso = new Date().toISOString();
  const tasks = [
    T({ id: 'x', owner: 'u1', ownerName: '甲', cost: 30, createdAt: iso, finishedAt: iso }),
    T({ id: 'y', owner: 'u2', ownerName: '乙', cost: 999, createdAt: iso, finishedAt: iso }),  // 不限的人用多少都不进池子
    T({ id: 'z', owner: 'u3', ownerName: '丙', cost: 10, createdAt: iso, finishedAt: iso }),
  ];
  const pool = L.pointsPool(tasks);
  eq(pool.budget, 150, '积分池分母只含**有限额**的账号（100+50，0＝不限的那个不计）');
  eq(pool.used, 40, '分子也只含这些账号（30+10；不限的那个 999 不算进池子，否则分子分母口径不一致）');
  eq(pool.users, 2, '计入 2 人');
  eq(pool.unlimited, 1, '单独报出"1 人不限"（界面写"另 N 人不限"，而不是混进池子）');
  // 服务端是否真的把 0 当不限：读 checkQuota（唯一判定点）
  const lib = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'web', 'lib.mjs'), 'utf8');
  ok(/if \(budget > 0 && u\.costMonth >= budget\)/.test(lib), '服务端判定：只在 budget > 0 时才限额（0 ＝ 不限）');
  L.saveUsers(users);      // 还原

  // 界面：所有显示额度的地方都必须走统一口径，不能再出现裸数字/裸 ¥
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'web', 'public', 'index.html'), 'utf8');
  const body = src.slice(src.indexOf('<body'));
  ok(/const isUnlimited = \(b\) => !\(Number\(b\) > 0\)/.test(body), '有统一口径函数 isUnlimited()');
  ok(/const budgetLabel = \(b\)/.test(body), '有统一显示函数 budgetLabel()');
  ok(!/'¥' \+ \(u\.budget/.test(body), '用户管理表不再裸拼 "¥" + 额度（原来 0 会显示成 "¥0"）');
  ok(/isUnlimited\(u\.budget\) \? '<span class="muted" title="额度设为 0 ＝ 不限，不会用完">不限<\/span>'/.test(body),
    '用户管理表：额度 0 显示「不限」');
  ok(/积分余额<\/span><u>\$\{isUnlimited\(u\.budget\)/.test(body), '使用日志的「积分余额」：0 显示「不限」而不是 0');
  ok(/积分不限<\/b>（额度设为 0 ＝ 不限）/.test(body), '积分条：0 额度写「积分不限」而不是"管理员账号"');
  ok(!/管理员账号：积分不限/.test(body), '不再把"积分不限"写死成"管理员账号"（普通用户也会被设 0）');
  ok(/\u4e0d\u9650<\/div>/.test(body) || /font-size:30px;font-weight:700;color:#047857">不限/.test(body),
    '积分饼图：0 额度改画「不限」说明牌（原来整块消失）');
  // 口径改了（已用改成"全所实际消耗"），但这条意图不变：池子为 0 时显示"不限"，不能显示"剩余 0"
  ok(/budgetSum > 0/.test(body) && /全所积分额度/.test(body) && /人额度均为 0（不限）/.test(body),
    '全所都不限额时显示「不限」并照报已用，而不是"剩余 0"');
}

console.log('\n── 3. 项目台账：整改闭环列 ──');
{
  const now = new Date().toISOString();
  const tasks = [
    T({ id: 'p1', projectName: '甲项目', proofreadCount: 5, finishedAt: now, compare: { stats: { total: 10, fixed: 8, partial: 1, unfixed: 1, unfixedP0: 0, unfixedP1: 1 } } }),
    T({ id: 'p2', projectName: '甲项目', proofreadCount: 3, finishedAt: now, compare: { stats: { total: 4, fixed: 2, partial: 0, unfixed: 2, unfixedP0: 2, unfixedP1: 0 } } }),
    T({ id: 'p3', projectName: '乙项目', proofreadCount: 2, finishedAt: now }),
  ];
  const rows = L.projectStats(tasks, { limit: 200 });
  const jia = rows.find(x => x.name === '甲项目');
  eq(jia.resp.total, 14, '甲项目：两次对比合计 14 条');
  eq(jia.resp.fixed, 10, '已修改合计');
  eq(jia.resp.unfixed, 3, '未响应合计');
  eq(jia.resp.unfixedP0, 2, '未响应 P0 合计（红字提醒依据）');
  eq(jia.resp.rounds, 2, '记录对比轮次数');
  const yi = rows.find(x => x.name === '乙项目');
  eq(yi.resp.total, 0, '没做过再次审核的项目：0（界面显示"—"）');
}

console.log('\n── 4. 界面口径静态断言（防止被改回去）──');
{
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'web', 'public', 'index.html'), 'utf8');
  const body = src.slice(src.indexOf('<body'));
  // ① 项目类型明细列顺序：P0 → P0/报告 → P0 占比 → P1 → P1/报告 → P1 占比
  // 必须从"项目类型明细"标题之后取表头 —— 台账「按项目」表里也有"项目类型"列，
  //    直接搜 <th>项目类型</th> 会命中那张表（首版断言即由此出错）。
  const fromDetail = body.slice(body.indexOf('项目类型明细'));
  const head = (fromDetail.match(/<thead><tr>[\s\S]{0,500}?<\/tr>/) || [''])[0].replace(/\s+/g, ' ');
  const order = ['报告数', 'P0</th>', 'P0/报告', 'P0 占比', 'P1</th>', 'P1/报告', 'P1 占比', '合计', '总占比'];
  let at = -1, ordered = true;
  for (const key of order) {
    const i = head.indexOf(key);
    if (i < 0 || i < at) { ordered = false; break; }
    at = i;
  }
  ok(ordered, '项目类型明细表头顺序＝报告数 → P0 → P0/报告 → P0 占比 → P1 → P1/报告 → P1 占比 → 合计 → 总占比', head);
  ok(/P0\/报告/.test(head) && /P1\/报告/.test(head), 'P0/报告 与 P1/报告 两列都在');
  ok(/perTask\(x\.p1, x\.tasks\)/.test(body), 'P1/报告 按 该类型 P1 ÷ 报告数 计算（与 P0/报告 同一函数）');
  // ② 积分饼图存在，且放在闲时/忙时饼图右侧（同一行 .ck-panels 内、在其后）
  ok(/function pointsDonutHtml/.test(body), '有积分饼图函数');
  const rowBlock = (body.match(/<div class="ck-panels\$\{extra[\s\S]{0,3200}?<\/div>`;/) || [''])[0];
  const iTraffic = rowBlock.indexOf('闲时 / 忙时占比');
  const iPoints = rowBlock.indexOf('pointsDonutHtml');
  ok(iTraffic >= 0 && iPoints > iTraffic, '积分饼图排在闲时/忙时饼图**之后**（即右侧）');
  ok(/pointsOf\(/.test(body), '积分取整与积分条共用 pointsOf()（两处数字必须对得上）');
  // 标签改成动态（全所/我的 跟着上方的"我的↔全部人员"切换走），断言随之调整
  ok(/\$\{scopeAll \? '全所' : '我的'\}积分已用/.test(body) && /我的积分消耗/.test(body),
    '管理员看全所、本人看自己的两种口径都在（标签随视角切换）');  // ③ 台账三页签（源码里是模板变量，所以断言的是 tabBtn('user', …) 这层）
  ok(/tabBtn\('project'/.test(body) && /tabBtn\('user'/.test(body) && /tabBtn\('type'/.test(body), '台账三个页签都在（按项目/按人员/按项目类别）');
  ok(/function ledgerTab\(/.test(body) && /\['user', 'type'\]\.includes\(k\)/.test(body), '页签切换函数带白名单（乱传值退回按项目）');
  ok(/rollupTableHtml\(LEDGER\.tab\)/.test(body), '人员/类别两张表由同一个渲染函数产出（口径不会分叉）');
  ok(/整改闭环/.test(body), '台账有整改闭环列');
  ok(/respCell\(/.test(body), '整改闭环渲染走统一函数');
  // ④ 积分列权限：非管理员只看自己（服务端抹掉别人的）
  const srv = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'web', 'server.mjs'), 'utf8');
  ok(/if \(b\.name !== u\.name\) b\.points = null;/.test(srv), '服务端把非管理员看不到的积分抹成 null（前端藏列只是第二道）');
  ok(/payload\.pointsPool = L\.pointsPool\(all\)/.test(srv), '管理员看全所积分池');
  ok(/payload\.quota = \{[\s\S]{0,200}?budget: u\.budget \?\? L\.DEFAULT_BUDGET/.test(srv), '非管理员（含审核专家）拿到自己的额度');
}

console.log('\n── 5. 在线人数与峰值（用户 2026-09-28 要求：管理员看板加「目前在线」「最高在线」两个框）──');
{
  // 纯逻辑：峰值只升不降、跨天今日峰值归零
  // NOTE: 日期必须相对"今天"算，不能写死某一天 —— 这套断言依赖"写进去的那天是否等于读取时的今天"，
  //       写死日期后一到隔天就会莫名失败（2026-09-29 凌晨实测到）。
  const nowBj = new Date(Date.now() + 8 * 3600e3);                      // 北京墙上时间
  const dayBase = Date.UTC(nowBj.getUTCFullYear(), nowBj.getUTCMonth(), nowBj.getUTCDate(), 2, 0, 0);  // 今天 10:00（北京）
  const t1 = dayBase - 24 * 3600e3;                                    // 昨天同一时刻
  const t2 = dayBase + 24 * 3600e3;                                    // 明天同一时刻
  const s1 = L.recordOnlineSample(3, t1);
  eq(s1.peak, 3, '第一次采样写入峰值');
  eq(s1.dayPeak, 3, '同时写入"今日最高"');
  const s2 = L.recordOnlineSample(7, t1 + 5 * 60000);
  eq(s2.peak, 7, '更高的采样 → 峰值上调');
  ok(!!s2.peakAt, '并记下峰值是什么时候创下的');
  const s3 = L.recordOnlineSample(2, t1 + 9 * 60000);
  eq(s3.peak, 7, '**人数下降不会把峰值改小**（只升不降）');
  eq(s3.lastSample, 2, '但最近一次采样值如实更新（"目前在线"看的是它）');
  const s4 = L.recordOnlineSample(4, t2);
  eq(s4.dayPeak, 4, '**跨天 → 今日最高重新计**');
  eq(s4.peak, 7, '历史最高不受跨天影响');
  // 读：文件里记的是"明天"那份，而读取时今天仍是今天 → 今日峰值按 0 显示，不会张冠李戴
  const r = L.readOnlineStats();
  eq(r.dayPeak, 0, '文件里的当日峰值不属于今天时，今日峰值按 0 显示，不会张冠李戴');
  eq(r.peak, 7, '历史最高照常读出来');
  eq(r.onlineWindowMin, 5, '在线判定窗口 5 分钟（与"谁在使用"同一口径）');
  eq(L.ONLINE_WINDOW_MS, 5 * 60 * 1000, 'ONLINE_WINDOW_MS = 5 分钟');
  eq(L.bjDayOf(Date.UTC(2026, 8, 28, 16, 30, 0)), '2026-09-29', 'bjDayOf 按北京时间算天（跨零点算次日）');
  eq(L.onlineNow().count, 0, '没有会话时在线 0 人（不炸）');

  // 服务端接线与界面
  const srv = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'web', 'server.mjs'), 'utf8');
  const idx = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'web', 'public', 'index.html'), 'utf8');
  ok(/if \(u\.role === 'admin'\) \{[\s\S]{0,300}?payload\.online = \{/.test(srv),
    '**在线数据只给管理员**（与"使用人数"同一档，审核专家不看）');
  ok(/const st = L\.recordOnlineSample\(live\.count\)/.test(srv), '打开看板就顺手采一次样（峰值最多滞后一分钟）');
  ok(/setInterval\(\(\) => \{ try \{ L\.recordOnlineSample\(L\.onlineNow\(\)\.count\); \} catch/.test(srv),
    '服务端每分钟采样一次（同事都在用但没人开看板时，峰值也要准确）');
  ok(/L\.recordOnlineSample\(L\.onlineNow\(\)\.count\); \} catch \{ \/\* 采样失败不影响登录/.test(srv), '登录时也采一次（在线人数最容易上涨的时刻）');
  ok(/目前在线人数/.test(idx) && /最高在线人数/.test(idx), '看板上有「目前在线人数」「最高在线人数」两个框');
  ok(/最近 \$\{on\.windowMin\} 分钟内有活动/.test(idx), '目前在线带口径说明（5 分钟内有活动）');
  ok(/on\.peakAt \? fmtBJ\(on\.peakAt, true\)/.test(idx), '最高在线注明"什么时候创下的"（否则数字没有意义）');

  // 2026-09-28 BUG 回归："数据逻辑不一致" + "三块要共用一个范围选择框"
  ok(/traffic\.saving\.actual/.test(idx), '积分饼图/KPI 用 traffic.saving.actual（与省钱效果同源，且跟随范围）');
  ok(/d\.rangeMine/.test(idx), '切到"我的"时用 rangeMine（自己的范围消耗，不拿别人的花费对减自己的额度）');
  ok(/ck-range/.test(idx) && /setDashRange/.test(idx), '统计范围选择框在本节标题行（三块共用）');
  ok(/rangeName/.test(idx) && /rangeName/.test(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'web', 'server.mjs'), 'utf8')),
    '范围中文名由服务端下发（避免前后端各写一份名单）');
  ok(/usedAll,/.test(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'web', 'lib.mjs'), 'utf8')), 'pointsPool 提供 usedAll');
  ok(/remaining: r2\(poolTotal - usedAll\)/.test(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'web', 'lib.mjs'), 'utf8')),
    'pointsPool 提供 remaining（限额账号可花额度）');
  ok(/\$\{limitWho\}共 \$\{Math\.round\(Number\(src\.budget\) \|\| 0\)\}/.test(idx),
    '饼图小字只留最短构成说明（长解释放右上角 KPI 框里，避免窄栏撑成碎字）');
  // 卡片（系统管理 → API 费用口径）的三个 BUG 回归
  ok(/const scopeAll = ME && \(ME\.role === 'admin' \|\| ME\.deepAccess\)/.test(idx),
    '**卡片按"全部人员"口径取数**（原来只统计管理员自己的任务：¥6.09/2 次 vs 看板 ¥40.22/26 次）');
  ok(/apiCostBlock\(d\.apiCost, r\)/.test(idx) && /const isMonth = \(range \|\| ac\.range\) === 'month'/.test(idx),
    '**选"本月"时不再重复显示"本月费用"那一格**（两格数字完全相同，看着像印了两遍）');
  ok(/\$\{rangeName\} API 费用合计/.test(idx), '卡片标题写明当前范围（选哪天就显示哪天）');
  ok(/全所实际/.test(idx), '饼图图例写明"已消耗＝全所实际"（细节在下面小字里，不挤在图例上）');
}

// 6. 看板"其中重复审核（次）"（2026-09-29 要求：紧挨"已完成审核（次）"右侧）
console.log('\n── 6. 看板：其中重复审核（次）──');
{
  const D = (o) => T({ status: 'done', owner: 'u1', ownerName: '李四', ...o });
  // 甲项目 2 次 + 乙项目 1 次 → 已完成 3 次、其中重复 1 次、覆盖 2 个项目
  const u1 = L.buildDashboard([
    D({ id: 'd1', projectName: '某油田某井区产能建设项目' }),
    D({ id: 'd2', projectName: '某油田某井区产能建设项目（第二次送审）' }),
    D({ id: 'd3', projectName: '某输油管道改线工程' }),
  ], { scope: 'all', canDeep: true }).usage;
  eq(u1.done, 3, '已完成 3 次');
  eq(u1.repeatAudits, 1, '**其中重复审核 1 次**（同一项目的第 2 次及以后）');
  eq(u1.projectCount, 2, '覆盖 2 个项目（归组用 normalizeProjectKey，与台账同一口径）');
  eq(u1.done - u1.projectCount, u1.repeatAudits, '重复次数 = 已完成 − 项目数（几个数字之间能对上）');

  // 没有项目名的任务各算一个项目，不会被误算成"同一项目重复审核"
  const u2 = L.buildDashboard([D({ id: 'x1' }), D({ id: 'x2' })], { scope: 'all', canDeep: true }).usage;
  eq(u2.repeatAudits, 0, '都没有项目名 → 重复 0 次（不把无项目名的记录算成一类）');
  eq(u2.projectCount, 2, '各自算一个项目');

  // 未完成/失败的不计入重复审核
  const u3 = L.buildDashboard([
    D({ id: 'y1', projectName: '丙项目' }),
    T({ id: 'y2', status: 'failed', owner: 'u1', projectName: '丙项目' }),
    T({ id: 'y3', status: 'auditing', owner: 'u1', projectName: '丙项目' }),
  ], { scope: 'all', canDeep: true }).usage;
  eq(u3.done, 1, '只有 1 次真正完成');
  eq(u3.repeatAudits, 0, '未完成的同项目记录不计入重复审核（否则数字会虚高）');

  // 前端确实把这一格画在"已完成审核（次）"右侧
  const idxHtml = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'web', 'public', 'index.html'), 'utf8');
  const iDone = idxHtml.indexOf('<span>已完成审核（次）</span>');
  const iRep = idxHtml.indexOf('其中重复审核');
  ok(iDone > 0 && iRep > iDone && iRep - iDone < 400,
    '界面把"其中重复审核"紧接在"已完成审核（次）"之后输出（即右侧一格）');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 看板自检：${pass} 通过 / ${fail} 失败\n`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
