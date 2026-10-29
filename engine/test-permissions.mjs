/**
 * 权限三档自检（普通用户 / 审核专家 / 管理员）
 *
 * 需要服务在跑。默认打本机 8787；用 BASE=http://127.0.0.1:8799 指向影子实例。
 * 管理员密码：环境变量 DSH_TEST_ADMIN_PWD（默认试 123456）。
 *
 * 覆盖的边界：
 *   · 普通用户只能看自己的任务、只出校对成果、不能下审核版
 *   · 审核专家能看全部台账、校对版 + 审核版、能生成审核版标注；不能进系统管理（用户/防护/配置）、
 *     不能删任务、不能发起补充审核
 *   · 管理员全通；且两个护栏：不能改自己的级别、最后一个管理员不能被降级
 *
 * 用法：node engine\test-permissions.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const ADMIN_PWD = process.env.DSH_TEST_ADMIN_PWD || '123456';
// 与 server 一致：WB_DATA_DIR 指到影子实例的数据目录时，自检也读那一份 users.json
const DATA = process.env.WB_DATA_DIR ? path.resolve(process.env.WB_DATA_DIR) : path.resolve(import.meta.dirname, '../web/data');

let pass = 0, fail = 0, skip = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  ← ' + extra : ''}`); }
};

async function login(username, password) {
  const r = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) return null;
  const setC = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')];
  const m = (setC || []).join(';').match(/sid=([^;]+)/);
  return m ? m[1] : null;
}
async function call(sid, method, p, body) {
  const r = await fetch(BASE + p, {
    method, headers: { ...(sid ? { cookie: 'sid=' + sid } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = r.headers.get('content-type') || '';
  let data = null;
  try { data = ct.includes('json') ? await r.json() : await r.text(); } catch { /* ignore */ }
  return { status: r.status, data };
}

// ── 准备：拿管理员会话，建两个临时账号 ──
const adminSid = await login('admin', ADMIN_PWD);
if (!adminSid) { console.error(`管理员登录失败（密码错？用 DSH_TEST_ADMIN_PWD 指定）`); process.exit(1); }
const rnd = Math.random().toString(36).slice(2, 7);
const mkUser = async (level) => {
  const username = `t-${level}-${rnd}`;
  const r = await call(adminSid, 'POST', '/api/users', { username, password: 'Test-' + rnd, name: '权限自检' + level, role: 'user' });
  if (r.status !== 200) { console.error('建测试账号失败：', JSON.stringify(r.data)); process.exit(1); }
  const users = JSON.parse(fs.readFileSync(path.join(DATA, 'users.json'), 'utf8'));
  const u = users.find(x => x.username === username);
  const sid = await login(username, 'Test-' + rnd);
  if (!sid) { console.error('测试账号登录失败'); process.exit(1); }
  return { username, id: u.id, sid, level };
};
const norm = await mkUser('user');
const expert = await mkUser('expert');
// 把 expert 提成审核专家（走 API，顺便验证 level 接口本身）
const up = await call(adminSid, 'POST', '/api/users/update', { id: expert.id, level: 'expert' });
ok(up.status === 200, '管理员可把账号设为「审核专家」');

console.log('\n── 1. 台账可见范围（管理员与审核专家=全所；普通用户=自己的）──');
{
  const a = await call(norm.sid, 'GET', '/api/tasks');
  const b = await call(expert.sid, 'GET', '/api/tasks');
  const total = (await call(adminSid, 'GET', '/api/tasks')).data.length;
  ok(Array.isArray(a.data) && a.data.length === 0, '普通用户看不到别人的任务（自己没有任务时为 0 条）', `实际 ${a.data && a.data.length}`);
  ok(Array.isArray(b.data) && b.data.length === total && total > 0, '审核专家能看到全部台账（用户明确要求）', `专家 ${b.data && b.data.length} / 全部 ${total}`);
  const bd = await call(expert.sid, 'GET', '/api/dashboard?scope=all');
  ok(bd.status === 200 && bd.data.scope === 'all', '审核专家看板可切「全部人员」', `实际 scope=${bd.data && bd.data.scope}`);
  const bd2 = await call(expert.sid, 'GET', '/api/dashboard');
  ok(bd2.status === 200, '审核专家看板可正常打开', `实际 ${bd2.status}`);
}

console.log('\n── 2. 成果版本（校对版 / 审核版）──');
{
  const all = (await call(adminSid, 'GET', '/api/tasks')).data;
  const done = all.find(t => t.status === 'done');
  if (!done) { console.log('  （本机没有已完成任务，跳过此项）'); }
  else {
    // 普通用户：别人的任务一律 403
    const a = await call(norm.sid, 'GET', `/api/tasks/${done.id}/report.html`);
    ok(a.status === 403, '普通用户访问「别人的任务」被拒（403）', `实际 ${a.status}`);
    const a2 = await call(norm.sid, 'POST', `/api/tasks/${done.id}/annotate`, { scope: 'deep' });
    ok(a2.status === 403, '普通用户请求「审核版标注」被拒（403）', `实际 ${a2.status}`);
    // 审核专家：别人的任务也能看，而且拿到的是审核成果
    const b = await call(expert.sid, 'GET', `/api/tasks/${done.id}/report.html`);
    ok(typeof b.data === 'string' && b.data.includes('审 核 成 果'), '审核专家看「别人的任务」拿到的是「审核成果」');
    const bd = await call(expert.sid, 'GET', `/api/tasks/${done.id}/download`);
    ok(bd.status === 200, '审核专家可下载「审核成果」PDF', `实际 ${bd.status}`);
    const b2 = await call(expert.sid, 'POST', `/api/tasks/${done.id}/annotate`, { scope: 'deep' });
    ok(b2.status === 200, '审核专家可生成「审核版标注」', `实际 ${b2.status}`);
    const b3 = await call(expert.sid, 'GET', `/api/tasks/${done.id}/annotated.pdf?scope=proof`);
    ok(b3.status === 200 || b3.status === 404, '审核专家可访问标注版下载接口（200 已生成 / 404 未生成）', `实际 ${b3.status}`);
  }
}

console.log('\n── 3. 系统管理（审核专家必须进不去）──');
{
  const cases = [
    ['GET', '/api/users', null, '用户列表'],
    ['POST', '/api/users/update', { id: expert.id, level: 'admin' }, '改权限级别'],
    ['GET', '/api/guard', null, '登录防护总览'],
    ['GET', '/api/system-config', null, '系统配置'],
    ['GET', '/api/cost-model', null, '成本模型'],
    ['POST', '/api/projects/reset', { key: 'x' }, '项目台账清零'],
  ];
  for (const [m, p, body, label] of cases) {
    const r = await call(expert.sid, m, p, body);
    ok(r.status === 403, `审核专家访问${label}被拒（403）`, `实际 ${r.status}`);
  }
  const r2 = await call(expert.sid, 'GET', '/api/templates');
  ok(r2.status === 200, '审核专家仍可读模板列表（提交审核需要，允许）', `实际 ${r2.status}`);
  const r3 = await call(expert.sid, 'GET', '/api/projects');
  ok(r3.status === 200 && Array.isArray(r3.data.list), '审核专家可看「项目质量台账」（范围=全所）', `实际 ${r3.status}`);
  const r4 = await call(norm.sid, 'GET', '/api/projects');
  ok(r4.status === 200 && r4.data.hidden === true, '普通用户的项目台账被隐藏（返回空列表）', `实际 ${JSON.stringify(r4.data).slice(0, 60)}`);
  const r5 = await call(expert.sid, 'GET', '/api/usage?all=1');
  ok(r5.status === 200 && r5.data.scope === 'all', '审核专家用量可切「全所」（?all=1）', `实际 scope=${r5.data && r5.data.scope}`);
}

console.log('\n── 4. 破坏性操作 ──');
{
  const all = (await call(adminSid, 'GET', '/api/tasks')).data;
  const some = Array.isArray(all) ? all[0] : null;
  if (!some) {
    // 库里没有任务时，这两条断言没有对象可指向。
    // 这里故意跳过而不是自动创建假任务 —— BASE 可能被指向生产环境，
    //    自动创建任务会向生产台账写入脏数据。要跑这两条需先在影子目录放置真实任务的 meta.json。
    skip += 2;
    console.log('    ⏭ 库里没有任务，跳过「删除任务 / 补充审核」两条断言（需要至少 1 个任务）');
  } else {
    const del = await call(expert.sid, 'POST', `/api/tasks/${some.id}/delete`);
    ok(del.status === 403, '审核专家不能删除任务（台账留痕，仅管理员）', `实际 ${del.status}`);
    const sup = await call(expert.sid, 'POST', `/api/tasks/${some.id}/supplement`, { note: '权限自检：不应被允许' });
    ok(sup.status === 403, '审核专家不能发起补充审核（管理员专属）', `实际 ${sup.status}`);
  }
}

console.log('\n── 5. 管理员护栏 ──');
{
  const me = (await call(adminSid, 'GET', '/api/me')).data;
  const selfId = me && me.id;
  const r1 = await call(adminSid, 'POST', '/api/users/update', { id: selfId, level: 'user' });
  ok(r1.status === 400, '不能修改自己的权限级别（400）', `实际 ${r1.status}`);
  const users = JSON.parse(fs.readFileSync(path.join(DATA, 'users.json'), 'utf8'));
  const admins = users.filter(x => x.role === 'admin' && !x.disabled);
  if (admins.length === 1) {
    const r2 = await call(adminSid, 'POST', '/api/users/update', { id: admins[0].id, level: 'user' });
    ok(r2.status === 400, '最后一个管理员不能降级（400）', `实际 ${r2.status}`);
  } else {
    skip++;
    console.log(`  （本例有 ${admins.length} 个管理员，跳过"最后一个管理员"用例）`);
  }
}

// ── 清理：把自检账号从 users.json 删掉（它们的任务是空，没有残留） ──
{
  const users = JSON.parse(fs.readFileSync(path.join(DATA, 'users.json'), 'utf8'));
  const keep = users.filter(x => !/^t-(user|expert)-/.test(x.username));
  fs.writeFileSync(path.join(DATA, 'users.json'), JSON.stringify(keep, null, 2), 'utf8');
  console.log(`\n（已清理 ${users.length - keep.length} 个自检账号）`);
}

console.log(`\n合计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}${skip ? `，跳过 ${skip}` : ''}\n`);
process.exit(fail ? 1 : 0);
