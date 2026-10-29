/**
 * 排队调度自检（零 API；纯逻辑 + 界面/服务端静态断言）
 *
 * 2026-09-28 口径：大量使用方同时提交、部分项目排队时，管理员可让某些项目
 * 提高优先级或立即开始。选定口径：
 *   ① 「立即开始」在名额满时临时给这一个任务 +1 并发（跑完自动收回，不影响正在跑的任务）；
 *   ② 仅管理员可用；
 *   ③ 台账上方增加一块「排队管理」面板，逐条操作。
 *
 * 这里断言的是调度顺序（最容易做错、又最难靠肉眼发现的地方）：
 *   · 优先级高的先跑；同优先级先来后到（不饿死先提交的人）
 *   · 优先级不能越过"还没到闲时起点"—— 否则加急会变成"无视计费时段"，账单翻倍而管理员不知情
 *
 * 用法：node engine\test-queue.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wbq-'));
process.env.WB_DATA_DIR = tmp;
const L = await import('../web/lib.mjs');

let pass = 0, fail = 0;
const ok = (c, n, extra = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${extra ? '  ← ' + extra : ''}`); } };
const eq = (a, b, n) => ok(a === b, n, `实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`);

const NOW = Date.now();
const T = (o) => ({ id: o.id, status: 'queued', ownerName: '甲', sourceName: o.id + '.docx', createdAt: new Date(NOW - (o.age || 0)).toISOString(), ...o });
// 注意签名：第三参是 opts（now / runningByOwner / perUserRunning），不再是裸时间戳
const pick = (ids, map, opts = {}) => L.pickNextReady(ids, (id) => map[id], { now: NOW, ...opts });

console.log('\n── 1. 能不能开始（本地解析随时做；AI 调用才受闲时约束）──');
{
  eq(L.canStartTask(T({ id: 'a' }), NOW), true, '还没预处理 → 随时可以开始（解析不花钱，高峰也照做）');
  eq(L.canStartTask(T({ id: 'a', preprocessedAt: new Date(NOW).toISOString(), apiStartAt: new Date(NOW + 3600e3).toISOString() }), NOW), false,
    '预处理完成、闲时起点在未来 → 不能开始（要等闲时）');
  eq(L.canStartTask(T({ id: 'a', preprocessedAt: new Date(NOW).toISOString(), apiStartAt: new Date(NOW - 1000).toISOString() }), NOW), true,
    '闲时起点已过 → 可以开始');
  eq(L.canStartTask(T({ id: 'a', preprocessedAt: new Date(NOW).toISOString() }), NOW), true, '预处理完成但没设 apiStartAt → 可以开始');
  eq(L.canStartTask(null, NOW), false, '任务被删了 → 跳过（不炸）');
}

console.log('\n── 2. 调度顺序：优先级 + 先来后到 ──');
{
  const m = {
    a: T({ id: 'a', age: 5000 }),
    b: T({ id: 'b', age: 4000 }),
    c: T({ id: 'c', age: 3000, priority: L.PRIORITY_URGENT }),   // 后来的，但加急
  };
  eq(pick(['a', 'b', 'c'], m), 2, '**加急的虽然排在后面也先跑**');
  eq(pick(['a', 'b'], m), 0, '没人加急时：先来后到（数组顺序即入队顺序）');
  const m2 = { a: T({ id: 'a' }), b: T({ id: 'b', priority: 5 }), c: T({ id: 'c', priority: 9 }) };
  eq(pick(['a', 'b', 'c'], m2), 2, '多个加急：优先级数值大的先跑');
  const m3 = { a: T({ id: 'a' }), b: T({ id: 'b', priority: L.PRIORITY_URGENT }), c: T({ id: 'c', priority: L.PRIORITY_URGENT }) };
  eq(pick(['a', 'b', 'c'], m3), 1, '同优先级 → 取更靠前的（b 在 c 前）');
  eq(pick([], m3), -1, '空队列 → -1');
  const m4 = { a: T({ id: 'a', preprocessedAt: new Date(NOW).toISOString(), apiStartAt: new Date(NOW + 3600e3).toISOString() }) };
  eq(pick(['a'], m4), -1, '全都还不能跑 → -1（外层会去安排定时唤醒）');
}

console.log('\n── 3. 关键取舍：优先级不能越过"闲时约束" ──');
{
  const waiting = T({ id: 'w', preprocessedAt: new Date(NOW).toISOString(), apiStartAt: new Date(NOW + 3600e3).toISOString(), priority: L.PRIORITY_START_NOW });
  const normal = T({ id: 'n' });
  const m = { w: waiting, n: normal };
  eq(pick(['w', 'n'], m), 1, '**加急的等待闲时任务不抢跑**，先让能跑的普通任务跑（避免"加急"偷偷变成高峰双倍计费）');
  // 「立即开始」的做法是把 apiStartAt 提前到现在（而不是让优先级越过约束）
  const started = { ...waiting, apiStartAt: new Date(NOW - 1000).toISOString() };
  eq(pick(['w', 'n'], { w: started, n: normal }), 0, '解除等待后（apiStartAt 提前）→ 它才是下一个');
}

console.log('\n── 3b. 公平调度与每人上限（2026-09-28 用户要求）──');
{
  const T2 = (id, owner, extra = {}) => T({ id, owner, ownerName: owner, ...extra });
  // 场景：A 先提交了 3 个（都在排队），B 后提交 1 个。
  // 没有公平规则时 A 的会一直排在前面 → B 干等；有公平规则时 B（手上没在跑）应当插到 A 的第 2 个之前。
  const m = {
    a1: T2('a1', 'A'), a2: T2('a2', 'A'), a3: T2('a3', 'A'), b1: T2('b1', 'B'),
  };
  const g = (o) => new Map(Object.entries(o));
  eq(pick(['a1', 'a2', 'a3', 'b1'], m, { runningByOwner: g({ A: 1 }) }), 3,
    '**公平优先**：A 手上已有 1 个在跑 → 让 B（手上 0 个）先上，即使 B 排在最后');
  eq(pick(['a1', 'a2', 'a3', 'b1'], m, { runningByOwner: g({}) }), 0,
    '都没在跑时仍按先来后到（A 的 a1）—— 公平规则不会把先提交的挤掉');
  eq(pick(['a1', 'a2', 'a3', 'b1'], m, { runningByOwner: g({ A: 1, B: 1 }) }), 0,
    '两人都有在跑的 → 回到先来后到（A 的 a1）');

  // 每人"在跑"上限（默认 2）：已达上限的人本轮一律不选，哪怕他排在最前
  eq(pick(['a1', 'a2', 'b1'], m, { runningByOwner: g({ A: 2 }) }), 2,
    '**A 在跑已 2 个（到上限）→ 跳过他的任务，选 B 的**');
  eq(pick(['a1', 'a2'], m, { runningByOwner: g({ A: 2 }) }), -1,
    '只有 A 且 A 到上限 → 本轮无人可跑（返回 -1，外层等下一次唤醒）');
  eq(pick(['a1', 'a2'], m, { runningByOwner: g({ A: 2 }), perUserRunning: 3 }), 0,
    '把每人上限调成 3 → 又可以被选中（上限是可配的）');

  // 优先级压过公平：管理员「加急」是明确指示，应当先跑
  const m2 = { a1: T2('a1', 'A', { priority: 1 }), b1: T2('b1', 'B') };
  eq(pick(['a1', 'b1'], m2, { runningByOwner: g({ B: 0, A: 0 }) }), 0, '加急的先跑（优先级压过先来后到）');
  const m3 = { a1: T2('a1', 'A', { priority: 1 }), b1: T2('b1', 'B', { priority: 1 }) };
  eq(pick(['a1', 'b1'], m3, { runningByOwner: g({ A: 1 }) }), 1, '同为加急时，公平规则仍然生效（B 手上没在跑）');

  // 「立即开始」不受每人上限约束（2026-09-29 修复：本人已占满 2 路时，此前点「立即开始」不会起跑）
  const m4 = {
    a1: T2('a1', 'A'),
    a2: T2('a2', 'A', { priority: L.PRIORITY_START_NOW }),
  };
  eq(pick(['a1', 'a2'], m4, { runningByOwner: g({ A: 2 }) }), 1,
    '**A 已到每人上限（2 个在跑）时，「立即开始」的那个仍被选中**（显式指令优先，配额由全局名额约束）');
  eq(pick(['a1'], m4, { runningByOwner: g({ A: 2 }) }), -1,
    '同一人未标「立即开始」的任务仍被跳过（普通任务不破每人上限）');
  const m5 = { x1: T2('x1', 'A'), y1: T2('y1', 'B') };
  eq(pick(['x1', 'y1'], m5, { runningByOwner: g({ A: 2 }), startNowBypassesPerUser: false }), 1,
    '需要时可用 startNowBypassesPerUser:false 关掉该例外（回到旧的严格口径）');

  // 管理员两档上限（2026-09-29 要求：管理员发起的可同时跑到全局上限 6）
  const m6 = { a1: T2('a1', 'ADM'), a2: T2('a2', 'ADM'), b1: T2('b1', 'B') };
  const admins = new Set(['ADM']);
  eq(pick(['a1'], m6, { runningByOwner: g({ ADM: 5 }), adminOwners: admins, adminPerUserRunning: 6 }), 0,
    '**管理员已有 5 个在跑仍可再起一个**（上限 6，不是 2）');
  eq(pick(['a1'], m6, { runningByOwner: g({ ADM: 6 }), adminOwners: admins, adminPerUserRunning: 6 }), -1,
    '管理员到 6 个后同样让位（不会独占超过全局上限）');
  eq(pick(['a1'], m6, { runningByOwner: g({ ADM: 5 }) }), -1,
    '不传 adminOwners 时按普通上限 2 处理（默认不放开，避免误放宽）');
  eq(pick(['a1', 'b1'], m6, { runningByOwner: g({ ADM: 5, B: 0 }), adminOwners: admins, adminPerUserRunning: 6 }), 1,
    '管理员再宽也不抢"手上没在跑"的普通使用方：同为普通优先级时公平规则先选 B');
}

console.log('\n── 3c. 排队管理面板带上"每人在跑"信息 ──');
{
  const m = { a: T({ id: 'a', owner: 'A', ownerName: '甲' }), b: T({ id: 'b', owner: 'B', ownerName: '乙' }) };
  const d = L.buildQueueBoard(['a', 'b'], (id) => m[id], {
    running: 2, maxConcurrent: 6, boostSlots: 1, maxBoost: 2,
    runningByOwner: new Map([['A', 2]]), perUserRunning: 2,
  });
  eq(d.items.find(x => x.owner === 'A').ownerRunning, 2, '面板显示该人已有 2 个在跑');
  eq(d.items.find(x => x.owner === 'A').atCap, true, '并标出"他已到每人上限"（界面据此解释他为什么还排在后面）');
  eq(d.items.find(x => x.owner === 'A').perUserBlocked, true, '普通任务到上限 → perUserBlocked=true（界面显示"已满额，让位"）');
  eq(d.items.find(x => x.owner === 'B').atCap, false, '没到上限的人不标');
  // 立即开始的任务虽处在"该人已满额"的状态，但不会被上限挡住 → 界面改显示"优先起跑"
  const sn = L.buildQueueBoard(['a1'], () => T({ id: 'a1', owner: 'A', priority: L.PRIORITY_START_NOW }), {
    running: 2, maxConcurrent: 6, runningByOwner: new Map([['A', 2]]), perUserRunning: 2,
  });
  eq(sn.items[0].perUserBlocked, false, '**立即开始的任务不被每人上限挡住** → perUserBlocked=false');
  eq(sn.items[0].startNow, true, '并标出 startNow（界面显示"优先起跑"）');
  // 排队页也要能看出是否带汇报 PPT（2026-10-08：后台看不出这对任务是"报告+PPT"还是纯报告）
  const pb = L.buildQueueBoard(['p1'], () => T({ id: 'p1', owner: 'A', pptSourceName: '汇报PPT.pptx', pptSlides: 24, pptOnly: false }),
    { running: 0, maxConcurrent: 6 });
  eq(pb.items[0].pptSourceName, '汇报PPT.pptx', '队列项带上 PPT 文件名');
  eq(pb.items[0].pptSlides, 24, '以及 PPT 页数（界面显示"含 PPT · 24 页"）');
  eq(pb.items[0].pptOnly, false, '以及是否"仅 PPT"');
  eq(L.buildQueueBoard(['p2'], () => T({ id: 'p2', owner: 'A' }), { running: 0, maxConcurrent: 6 }).items[0].pptSourceName, '',
    '没有 PPT 的任务该字段为空（界面不显示徽标）');
  eq(d.boostSlots, 1, '面板带上"已用临时加急名额"');
  eq(d.maxBoost, 2, '以及"加急名额上限"（界面显示 1/2）');
  eq(d.perUserRunning, 2, '以及每人在跑上限');
}

console.log('\n── 4. 排队管理面板的数据 ──');
{
  const m = {
    a: T({ id: 'a', ownerName: '甲', projectName: '项目甲', priority: 0 }),
    b: T({ id: 'b', ownerName: '乙', projectName: '项目乙', priority: L.PRIORITY_URGENT }),
    c: T({ id: 'c', ownerName: '丙', projectName: '项目丙', preprocessedAt: new Date(NOW).toISOString(), apiStartAt: new Date(NOW + 7200e3).toISOString() }),
  };
  const d = L.buildQueueBoard(['a', 'b', 'c'], (id) => m[id], { running: 2, maxConcurrent: 3, now: NOW });
  eq(d.items.length, 3, '三条都在面板里');
  eq(d.items[0].id, 'b', '面板第一行＝实际下一个要跑的（加急的）');
  eq(d.items[0].urgent, true, '标记为加急');
  eq(d.items[0].position, 1, '序号从 1 开始');
  eq(d.ready, 2, '可立即开跑 2 个');
  eq(d.waiting, 1, '等待闲时 1 个');
  eq(d.urgent, 1, '加急 1 个');
  eq(d.running, 2, '带上"正在跑几个"');
  eq(d.maxConcurrent, 3, '带上当前并发上限（含临时加急名额）');
  const startedNow = L.buildQueueBoard(['x'], () => T({ id: 'x', priority: L.PRIORITY_START_NOW }), { now: NOW });
  eq(startedNow.items[0].startNow, true, '优先级 99 → 标「立即开始」（界面显示不同标签）');
  eq(L.buildQueueBoard([], () => null, { now: NOW }).items.length, 0, '空队列不炸');
}

console.log('\n── 5. 服务端接线与权限（静态断言）──');
{
  const srv = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'web', 'server.mjs'), 'utf8');
  ok(/const idx = L\.pickNextReady\(queue, L\.getTask, \{[\s\S]{0,120}?runningByOwner: runningByOwner\(\)/.test(srv),
    'pump() 把"每人在跑几个"交给统一挑选函数（公平调度与每人上限都在那里判）');
  ok(/while \(running < MAX_CONCURRENT \+ boostSlots\)/.test(srv), '并发上限 = 常设上限 + 临时加急名额');
  ok(/const MAX_CONCURRENT = Number\(process\.env\.MAX_CONCURRENT \|\| 6\);/.test(srv),
    '**全局并发默认 6**（2026-09-28 用户定，原来是 2）');
  ok(/if \(boostSlots < MAX_BOOST\)/.test(srv) && /const MAX_BOOST      = Number\(process\.env\.MAX_BOOST \|\| 2\);/.test(srv),
    '加急临时名额**封顶 +2**（防止管理员连点把并发推高）');
  ok(/runningIds\.add\(id\);/.test(srv) && /runningIds\.delete\(id\);/.test(srv),
    '进出都在维护"正在跑的任务集合"（光有计数不知道是谁在跑，公平调度就没法做）');
  ok(/if \(queuedReadyOf\(u\.id\) >= L\.PER_USER_QUEUED\)/.test(srv),
    '**每人排队上限**在提交时拦截（两处提交入口都加了）');
  const perUserHits = (srv.match(/queuedReadyOf\(u\.id\) >= L\.PER_USER_QUEUED/g) || []).length;
  eq(perUserHits, 2, '两处提交入口（普通提交 / 仅 PPT）都做了拦截，没有漏一处');
  ok(/if \(boosted\.has\(id\)\)[\s\S]{0,160}?boostSlots = Math\.max\(0, boostSlots - 1\);/.test(srv),
    '**临时名额在该任务跑完时归还**（不会永久抬高并发）');
  ok(/if \(sub === '\/priority' && req\.method === 'POST'\)/.test(srv) && /if \(sub === '\/start-now' && req\.method === 'POST'\)/.test(srv),
    '两个接口都在');
  const prioBlock = srv.slice(srv.indexOf("if (sub === '/priority'"), srv.indexOf("if (sub === '/start-now'"));
  ok(/if \(u\.role !== 'admin'\) return json\(res, 403/.test(prioBlock), '「优先」仅管理员（403）');
  const nowBlock = srv.slice(srv.indexOf("if (sub === '/start-now'"), srv.indexOf('// ── 重复审核：确认继续'));
  ok(/if \(u\.role !== 'admin'\) return json\(res, 403/.test(nowBlock), '「立即开始」仅管理员（403）');
  ok(/task\.apiStartAt = new Date\(\)\.toISOString\(\);[\s\S]{0,120}?task\.mode = 'immediate';/.test(nowBlock),
    '「立即开始」会解除闲时等待（否则任务会睡到半夜）');
  ok(/boostSlots \+= 1;/.test(nowBlock) && /boosted\.add\(task\.id\);/.test(nowBlock), '名额满时临时 +1 并发并登记，供跑完归还');
  ok(/queue\.unshift\(task\.id\)/.test(nowBlock), '同时把它挪到队首');
  ok(/if \(p === '\/api\/queue-board' && req\.method === 'GET'\)[\s\S]{0,120}?requireAdmin/.test(srv), '排队面板接口仅管理员');
  ok(/priority: Number\(t\.priority\) \|\| 0,/.test(srv) && /waitingIdle: L\.isWaitingTask\(t\),/.test(srv),
    '台账列表下发 priority / waitingIdle（界面据此显示加急与等待标记）');
  ok(/baseMaxConcurrent: MAX_CONCURRENT, boostSlots/.test(srv), '面板同时回报"常设上限"与"临时名额"，便于显示 2→3');
}

console.log('\n── 6. 界面（排队管理面板 + 台账按钮，仅管理员）──');
{
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'web', 'public', 'index.html'), 'utf8');
  const body = src.slice(src.indexOf('<body'));
  ok(/id="queueCard"/.test(body) && /id="queueBoard"/.test(body), '排队管理卡片存在');
  ok(/if \(!ME \|\| ME\.role !== 'admin'\) \{ card\.classList\.add\('hide'\); return; \}/.test(body), '非管理员整块不显示');
  ok(/async function setPriority\(id, priority\)/.test(body) && /async function startNow\(id\)/.test(body), '两个操作函数都在');
  ok(/function adminQueueBtns\(t\)/.test(body), '台账行里有加急按钮（仅管理员、仅排队中的任务）');
  ok(/'queued', 'waiting', 'converting', 'duplicate-suspect'\]\.includes\(t\.status\)/.test(body),
    '只对"还在排队"的任务给按钮（在跑的、已结束的不给）');
  ok(/再加一路并发|临时多加一路并发/.test(body), '「立即开始」有二次确认（会写明可能加并发、可能按时段双倍计费）');
  ok(/已临时增加 1 路并发|grantedExtraSlot/.test(body), '返回里带"是否加了并发"（便于提示/排查）');
  ok(/renderQueueBoard\(\);/.test(body), 'renderTasks 每次刷新都更新排队面板（跟着 5 秒轮询走）');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 排队调度自检：${pass} 通过 / ${fail} 失败\n`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
