// 端到端测试：金额额度 + 追加申请
import fs from 'node:fs';
import path from 'node:path';

const base = 'http://127.0.0.1:8787';

const login = async (u, p) => {
  const r = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: p }),
  });
  const raw = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')];
  return raw.map(x => x.split(';')[0]).join('; ');
};

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { console.log(`  ${c ? '✓' : '✗'} ${n}${c ? '' : '  ' + e}`); c ? pass++ : fail++; };

// 管理员
// 管理员用户名从数据目录动态读取，不在源码里写死账号。
// 依次尝试（环境变量指定的 → 初始密码未改的管理员 → 其它管理员），用第一个能登录成功的。
const { listUsers } = await import('../web/lib.mjs');
const admins = listUsers().filter((u) => u.role === 'admin' && !u.disabled);
const candidates = [...new Set([
  process.env.ADMIN_U,
  ...admins.filter((u) => u.defaultPassword).map((u) => u.username),
  ...admins.map((u) => u.username),
].filter(Boolean))];
let ADMIN_U = '', ca = '';
for (const u of candidates) {
  try { ca = await login(u, process.env.ADMIN_P || '123456'); ADMIN_U = u; break; } catch { /* 换下一个候选 */ }
}
if (!ca) { console.log('  ✗ 没有可登录的管理员账号（可用 ADMIN_U/ADMIN_P 指定）'); process.exit(1); }
const meA = await (await fetch(base + '/api/me', { headers: { cookie: ca } })).json();
ok('管理员 /api/me 返回 budget 字段', 'budget' in meA, JSON.stringify(Object.keys(meA).slice(0, 12)));
ok('管理员额度为 0（不限）', meA.budget === 0, 'budget=' + meA.budget);
ok('管理员不再返回 dailyLimit', !('dailyLimit' in meA));
ok('usage 里有 costMonth（本月已花费用）', typeof (meA.usage || {}).costMonth === 'number', JSON.stringify(meA.usage));

// 找一个普通用户
// 2026-09-28 起有「IP 绑定」：被绑定到其他机器的账号，从本机（127.0.0.1）登录会被闸门拒绝（403）。
//    因此这里必须挑「未绑 IP」的账号；若全部已绑，则临时创建一个探针账号。
//    （首版未考虑这一点，挑到列表第一个非管理员 —— 恰好是被绑定的账号 —— 导致 4 项误报失败。）
const users = await (await fetch(base + '/api/users', { headers: { cookie: ca } })).json();
const allUsers = users.list || users;
let plain = allUsers.find(u => u.role !== 'admin' && !u.disabled && !(u.allowedIps || []).length);
let probeCreated = '';
if (!plain) {
  const uname = 'quota_probe';
  const r = await fetch(base + '/api/users', {
    method: 'POST', headers: { cookie: ca, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: uname, password: '123456', name: '额度自检探针', role: 'user' }),
  });
  const created = await r.json().catch(() => ({}));
  plain = (created && created.id) ? { ...created, username: uname, name: '额度自检探针', role: 'user', budget: 100 } : null;
  if (plain) { probeCreated = uname; console.log(`\n  （生产账号都绑了 IP，本机登不上）已建临时探针账号：${uname}`); }
}
if (plain) {
  console.log(`\n  普通用户：${plain.name}（${plain.username}）`);
  ok('用户列表下发 budget', 'budget' in plain || plain.budget === undefined, 'budget=' + plain.budget);
  ok('用户列表不再下发 dailyLimit', !('dailyLimit' in plain));

  // 设置额度为 66
  const r1 = await fetch(base + '/api/users/update', {
    method: 'POST', headers: { cookie: ca, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: plain.id, budget: 66 }),
  });
  ok('管理员可设置额度', r1.status === 200, 'HTTP ' + r1.status);

  const after = (await (await fetch(base + '/api/users', { headers: { cookie: ca } })).json()).find(u => u.id === plain.id);
  ok('额度已保存为 66', Number(after.budget) === 66, 'budget=' + after.budget);

  // 还原
  await fetch(base + '/api/users/update', {
    method: 'POST', headers: { cookie: ca, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: plain.id, budget: 100 }),
  });
}

// 额度申请流程
console.log('\n  ── 额度申请流程 ──');
const cp = plain ? await login(plain.username, '123456') : null;
if (cp) {
  const r = await fetch(base + '/api/quota-request', {
    method: 'POST', headers: { cookie: cp, 'Content-Type': 'application/json' },
    body: JSON.stringify({ wantAmount: 50, reason: '测试：本月还有几份报告要交付' }),
  });
  const d = await r.json();
  ok('用户可提交额度申请', r.status === 200 && d.request, 'HTTP ' + r.status);
  const rid = d.request && d.request.id;
  ok('申请带有 pending 状态', d.request && d.request.status === 'pending');
  ok('返回了给用户的提示语', !!d.note, d.note);

  // 自己看自己的申请
  const mine = await (await fetch(base + '/api/quota-request', { headers: { cookie: cp } })).json();
  ok('用户能查自己的申请记录', Array.isArray(mine.list) && mine.list.length > 0, 'count=' + (mine.list || []).length);

  // 管理员批准
  if (rid) {
    const before = (await (await fetch(base + '/api/users', { headers: { cookie: ca } })).json()).find(u => u.id === plain.id).budget;
    const ra = await fetch(base + '/api/quota-request/resolve', {
      method: 'POST', headers: { cookie: ca, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: rid, approve: true, addAmount: 50 }),
    });
    ok('管理员可批准申请', ra.status === 200, 'HTTP ' + ra.status);
    const after = (await (await fetch(base + '/api/users', { headers: { cookie: ca } })).json()).find(u => u.id === plain.id).budget;
    ok(`批准后额度增加（${before} → ${after}）`, Number(after) === Number(before) + 50, `${before}→${after}`);

    const again = await fetch(base + '/api/quota-request/resolve', {
      method: 'POST', headers: { cookie: ca, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: rid, approve: true }),
    });
    ok('同一条申请不能重复批', again.status === 400, 'HTTP ' + again.status);
  }

  // 普通用户不能批准
  const rn = await fetch(base + '/api/quota-request/resolve', {
    method: 'POST', headers: { cookie: cp, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'x', approve: true }),
  });
  ok('普通用户无权批准', rn.status === 401 || rn.status === 403, 'HTTP ' + rn.status);
}

// checkQuota 纯函数测试
console.log('\n  ── checkQuota 金额口径 ──');
const L = await import('../web/lib.mjs');
const mk = (cost, month) => ({ id: 't', owner: 'u1', status: 'done', cost, createdAt: month + '-05T02:00:00Z' });
const bj = (() => { const d = new Date(); d.setTime(d.getTime() + 8 * 3600 * 1000); return d.toISOString().slice(0, 7); })();
const u1 = { id: 'u1', role: 'user', budget: 100 };
const t1 = [mk(30, bj), mk(50, bj)];
ok('已用 ¥80 / 额度 ¥100 → 放行', L.checkQuota(u1, t1).ok === true);
const t2 = [mk(60, bj), mk(60, bj)];
const r2 = L.checkQuota(u1, t2);
ok('已用 ¥120 / 额度 ¥100 → 拒绝', r2.ok === false, JSON.stringify(r2.usage));
ok('拒绝语里带金额', /¥120/.test(r2.reason || '') && /¥100/.test(r2.reason || ''), r2.reason);
ok('不限额度（0）→ 永远放行', L.checkQuota({ id: 'u1', role: 'user', budget: 0 }, t2).ok === true);
ok('管理员 → 永远放行', L.checkQuota({ id: 'u1', role: 'admin', budget: 100 }, t2).ok === true);

// 旧用户（没有 budget 字段）应回落到默认 100
const legacy = { id: 'u1', role: 'user', dailyLimit: 3, monthlyLimit: 30 };
const r3 = L.checkQuota(legacy, [mk(120, bj)]);
ok('老账号（无 budget 字段）回落默认 ¥100 并被拦下', r3.ok === false, 'budget=' + r3.budget);

console.log(`\n全部：通过 ${pass}，失败 ${fail}`);

// ── 收尾：把测试改过的额度复原、删掉测试申请、删掉临时探针账号 ──
// （此前无收尾逻辑，跑一次回归就会把账号额度从 100 改成 150，界面显示与配置不符；
//   2026-09-28 另发现：探针账号若不删除，会在生产里留下一个弱默认密码且未绑 IP 的账号。）
try {
  const fsx = (await import('node:fs')).default;
  const UF = 'D:/Deepseek harness工作区/生活其他/审核工作台/web/data/users.json';
  const us = JSON.parse(fsx.readFileSync(UF, 'utf8'));
  let n = 0, removed = 0;
  for (const x of us) if (x.role !== 'admin' && x.budget === 150) { x.budget = 100; n++; }
  let out = us;
  if (probeCreated) {
    const before = out.length;
    out = out.filter(x => x.username !== probeCreated);
    removed = before - out.length;
  }
  if (n || removed) fsx.writeFileSync(UF, JSON.stringify(out, null, 2), 'utf8');
  const QF = 'D:/Deepseek harness工作区/生活其他/审核工作台/web/data/quota-requests.json';
  if (fsx.existsSync(QF)) {
    const l = JSON.parse(fsx.readFileSync(QF, 'utf8'))
      .filter(r => !/测试：本月还有几份报告要交付/.test(r.reason || ''));
    if (l.length) fsx.writeFileSync(QF, JSON.stringify(l, null, 2), 'utf8');
    else fsx.rmSync(QF);
  }
  if (n) console.log(`（已复原 ${n} 个账号的额度）`);
  if (removed) console.log(`（已删除临时探针账号 ${probeCreated}）`);
} catch (e) { console.log('（收尾失败，不影响结论：' + e.message + '）'); }

process.exit(fail ? 1 : 0);
