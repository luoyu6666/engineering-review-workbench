// 登录防护自检（限流 + 阶梯验证码）
//
// ⚠️ 需要服务正在运行（走 HTTP 接口验证真实拦截行为），且会**临时制造失败记录**，
//    结束时自动清理。运行期间请不要用真实账号登录，避免互相干扰。
//
// 为什么需要它：这套防护的每一条阈值都是"多一次就误伤、少一次就漏"的取舍，
// 改参数时很容易把某条改坏（比如把 needCaptcha 判反、把锁定窗口算错）。
// 而且它出错时的表现是**静默失效**——攻击者照样进得来，但没人会发现。
//
// 用法：node engine/test-login-guard.mjs
import * as L from '../web/lib.mjs';

const base = 'http://127.0.0.1:8787';
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { console.log(`  ${c ? '✓' : '✗'} ${n}${c ? '' : '  ' + e}`); c ? pass++ : fail++; };

const post = async (body) => {
  const r = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const solve = (q) => {
  const m = String(q).match(/(\d+)([+×])(\d+)/);
  return String(m[2] === '+' ? Number(m[1]) + Number(m[3]) : Number(m[1]) * Number(m[3]));
};
// 注意：/api/captcha 有意**不返回题目文字**（题目只画在 SVG 里），
// 所以测试只能从服务端状态里取答案 —— 这正说明脚本拿不到题目，防护是有效的。
const getCaptcha = async () => {
  const r = await fetch(base + '/api/captcha');
  const d = await r.json();
  const st = L.guardState();
  d.answer = (st.captchas[d.cid] || {}).answer;
  return d;
};

console.log('═══════════════════════════════════════════════════');
console.log('  登录防护自检');
console.log('═══════════════════════════════════════════════════');
console.log(`  策略: 账号连错 ${L.GUARD.ACCOUNT_MAX_FAILS} 次锁 ${L.GUARD.ACCOUNT_LOCK_MS / 60000} 分钟 | `
  + `IP ${L.GUARD.IP_WINDOW_MS / 60000} 分钟内 ${L.GUARD.IP_MAX_FAILS} 次封禁 | `
  + `连错 ${L.GUARD.CAPTCHA_AFTER_FAILS} 次后要验证码 | 失败延迟 ${L.GUARD.FAIL_DELAY_MS}ms`);

// 找一个可用账号（优先非管理员，避免影响管理操作）
const victim = L.listUsers().find(u => !u.disabled && u.role !== 'admin') || L.listUsers().find(u => !u.disabled);
if (!victim) { console.log('  ✗ 没有可用账号，无法测试'); process.exit(1); }
console.log(`  测试账号: ${victim.username}（用错误密码触发防护，结束时清理记录）`);
console.log('');

// 先清干净，避免上次残留影响
L.unlockAll();

try {
  console.log('【1】验证码本身');
  const c = await getCaptcha();
  ok('接口返回 cid 与 SVG', !!c.cid && String(c.svg).startsWith('<svg'));
  ok('SVG 不引用任何外部资源（内网断网可用）', !/https?:\/\/(?!www\.w3\.org)/.test(c.svg));
  const c2 = await getCaptcha();
  ok('每次都是新的一道（cid 不同）', c.cid !== c2.cid);
  ok('错误答案不通过', L.checkCaptcha(c2.cid, '999999') === false);
  const c3 = L.newCaptcha();
  ok('正确答案通过', L.checkCaptcha(c3.cid, solve(c3.question)) === true);
  ok('同一道只能用一次（防重放）', L.checkCaptcha(c3.cid, solve(c3.question)) === false);

  console.log('\n【2】失败延迟与递增提示');
  const t0 = Date.now();
  const r1 = await post({ username: victim.username, password: 'wrong-1' });
  const ms = Date.now() - t0;
  ok('错误密码返回 401', r1.status === 401, `HTTP ${r1.status}`);
  ok(`失败响应被延迟了（实测 ${ms}ms ≥ ${L.GUARD.FAIL_DELAY_MS}ms）`, ms >= L.GUARD.FAIL_DELAY_MS, `${ms}ms`);
  ok('提示里给出剩余次数', typeof r1.data.remaining === 'number', JSON.stringify(r1.data));
  ok('第 1 次还不要求验证码', r1.data.needCaptcha === false, JSON.stringify(r1.data));

  console.log('\n【3】连错到阈值后要求验证码');
  await post({ username: victim.username, password: 'wrong-2' });
  const r3 = await post({ username: victim.username, password: 'wrong-3' });
  ok(`第 ${L.GUARD.CAPTCHA_AFTER_FAILS} 次后开始要求验证码`, r3.data.needCaptcha === true, JSON.stringify(r3.data));
  ok('此时账号还没锁定', !r3.data.locked, JSON.stringify(r3.data));

  console.log('\n【4】不给验证码 / 给错验证码，即使密码正确也进不去');
  const rNoCap = await post({ username: victim.username, password: '123456' });
  ok('不给验证码 → 拒绝', rNoCap.status === 401 && rNoCap.data.needCaptcha === true, `HTTP ${rNoCap.status} ${JSON.stringify(rNoCap.data)}`);
  const cx = await getCaptcha();
  const rBadCap = await post({ username: victim.username, password: '123456', captchaId: cx.cid, captchaAnswer: '0' });
  ok('验证码填错 → 拒绝', rBadCap.status === 401, `HTTP ${rBadCap.status}`);

  console.log('\n【5】累计连错到上限 → 锁定');
  for (let i = 0; i < L.GUARD.ACCOUNT_MAX_FAILS; i++) {
    const ci = await getCaptcha();
    await post({ username: victim.username, password: 'wrong-x', captchaId: ci.cid, captchaAnswer: ci.answer });
  }
  const g = L.loginGuardStatus(victim.id, '127.0.0.1');
  ok('账号已被锁定', g.locked === true, JSON.stringify({ locked: g.locked, left: g.lockMinutesLeft }));
  ok('锁定时长符合策略', g.lockMinutesLeft >= Math.floor(L.GUARD.ACCOUNT_LOCK_MS / 60000) - 1, `left=${g.lockMinutesLeft}`);

  const rLocked = await post({ username: victim.username, password: '123456' });
  ok('锁定期间即使密码正确也拒绝（HTTP 429）', rLocked.status === 429, `HTTP ${rLocked.status} ${JSON.stringify(rLocked.data)}`);
  ok('返回锁定剩余时间', rLocked.data.locked === true && typeof rLocked.data.minutesLeft === 'number', JSON.stringify(rLocked.data));

  console.log('\n【6】管理员解锁后恢复');
  ok('解锁接口执行成功', L.unlockAccount(victim.id) === true);
  const g2 = L.loginGuardStatus(victim.id, '127.0.0.1');
  ok('解锁后不再锁定', g2.locked === false && g2.accountFails === 0, JSON.stringify(g2));
  const ci2 = await getCaptcha();
  const rOk = await post({ username: victim.username, password: '123456', captchaId: ci2.cid, captchaAnswer: ci2.answer });
  ok('用正确密码 + 验证码可正常登录', rOk.status === 200, `HTTP ${rOk.status} ${JSON.stringify(rOk.data)}`);

  console.log('\n【7】防护总览');
  const sum = L.guardSummary();
  ok('总览包含策略与三类状态', !!sum.policy && Array.isArray(sum.locked) && Array.isArray(sum.blocked) && Array.isArray(sum.warn));
} catch (e) {
  console.log(`  ✗ 测试过程中异常：${e.message}`);
  fail++;
} finally {
  // 清理：清掉所有测试造成的限制记录，并踢掉测试登录产生的会话
  L.unlockAll();
  const n = L.purgeSessionsOf ? L.purgeSessionsOf(victim.id) : 0;
  console.log(`\n已清理测试记录（限制已全解，测试会话 ${n} 个）`);
  console.log(`${fail === 0 ? '全部通过' : '存在失败'}：通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}
