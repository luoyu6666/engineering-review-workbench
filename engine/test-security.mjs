/**
 * 会话与安全自检（零 API；大部分是纯逻辑，不需要起服务）
 *
 * 2026-09-27 反馈：「登录后没有退出机制，下次不管多久打开网址就直接登录到原来的用户了」。
 * 核查属实，且影响范围更大：服务端根本不校验会话时间（7 天过期只在登录那一刻清一次），
 * 浏览器端 Cookie 还写着 Max-Age=7 天 —— 即"关掉浏览器过几天回来还是登录状态"，
 * 窃取到 sid 的请求则永久有效。
 *
 * 这个自检覆盖：
 *   ① 会话过期规则（空闲超时 / 绝对上限 / 用户被停用）
 *   ② 密码强度三处口径一致（建号 / 重置 / 自行改密都 ≥6 位）
 *   ③ 暂存 id 格式校验（拼路径前的防穿越）
 *   ④ Cookie 属性（HttpOnly / SameSite / 不写 Max-Age＝关浏览器即失效）
 *
 * 用法：node engine\test-security.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wbsec-'));
process.env.WB_DATA_DIR = tmp;
const L = await import('../web/lib.mjs');

let pass = 0, fail = 0;
const ok = (c, n, extra = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${extra ? '  ← ' + extra : ''}`); } };
const eq = (a, b, n) => ok(a === b, n, `实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`);

console.log('\n── 1. 会话过期规则（用户反馈的核心）──');
{
  ok(L.SESSION_IDLE_MS > 0 && L.SESSION_IDLE_MS <= 24 * 3600e3, `空闲超时 ${Math.round(L.SESSION_IDLE_MS / 3600e3)} 小时（≤24 小时）`);
  ok(L.SESSION_MAX_MS >= L.SESSION_IDLE_MS, `绝对上限 ${Math.round(L.SESSION_MAX_MS / 864e5)} 天 ≥ 空闲超时`);

  const now = Date.now();
  const fresh = { createdAt: now - 1000, lastSeenAt: now - 1000 };
  eq(L.sessionExpired(fresh, now), false, '刚登录的会话：有效');
  eq(L.sessionExpired({ createdAt: now - L.SESSION_IDLE_MS - 1000, lastSeenAt: now - L.SESSION_IDLE_MS - 1000 }, now), true,
    '**空闲超过 12 小时 → 过期**（这就是"隔很久打开还是登录状态"要修的点）');
  eq(L.sessionExpired({ createdAt: now - L.SESSION_MAX_MS - 1000, lastSeenAt: now }, now), true,
    '一直有活动但超过绝对上限 → 仍过期（防"偷到 sid 永久有效"）');
  eq(L.sessionExpired({ createdAt: now - 3600e3, lastSeenAt: now - 60e3 }, now), false, '半小时前动过：仍有效');
  eq(L.sessionExpired(null, now), true, '空记录当过期');
  eq(L.sessionExpired({}, now), true, '缺时间戳的记录当过期（老数据不会变成永久会话）');

  // 端到端：造一条真会话，把它的时间戳改老，再看 getSession 认不认
  const u = L.createUser({ username: 'sectest', password: 'pw-123456', name: '安全自检', role: 'user' });
  const sid = L.createSession(u.id, { headers: {}, socket: {} });
  ok(!!L.getSession(sid), '新建会话可用');
  const f = path.join(tmp, 'sessions.json');
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  s[sid].lastSeenAt = Date.now() - L.SESSION_IDLE_MS - 5000;
  fs.writeFileSync(f, JSON.stringify(s), 'utf8');
  eq(L.getSession(sid), null, '**空闲超时后 getSession 直接拒绝**（服务端说了算，不靠浏览器丢 Cookie）');
  const after = JSON.parse(fs.readFileSync(f, 'utf8'));
  ok(!after[sid], '过期会话被顺手删掉（不留在 sessions.json 里）');

  const sid2 = L.createSession(u.id, { headers: {}, socket: {} });
  L.destroySession(sid2);
  eq(L.getSession(sid2), null, '登出（destroySession）后立即失效');

  const users = L.listUsers(); const t = users.find(x => x.id === u.id); t.disabled = true; L.saveUsers(users);
  const sid3 = L.createSession(u.id, { headers: {}, socket: {} });
  eq(L.getSession(sid3), null, '账号被停用 → 已登录会话立刻失效');
}

console.log('\n── 2. 密码强度：三处口径一致（建号曾被漏掉）──');
{
  let e1 = '';
  try { L.createUser({ username: 'weak1', password: '1' }); } catch (e) { e1 = e.message; }
  ok(/至少 6 位/.test(e1), '建号：1 位密码被拒（原来这里不校验，能建出 1 位密码）', e1);
  let e2 = '';
  try { L.createUser({ username: 'weak2', password: '      ' }); } catch (e) { e2 = e.message; }
  ok(/至少 6 位/.test(e2), '建号：全空格密码被拒', e2);
  let e3 = '';
  try { L.createUser({ username: '', password: 'pw-123456' }); } catch (e) { e3 = e.message; }
  ok(/用户名/.test(e3), '建号：空用户名被拒', e3);
  const good = L.createUser({ username: 'strong1', password: 'pw-123456' });
  ok(good && good.salt && good.hash, '6 位以上密码正常建号');
  ok(!Object.prototype.hasOwnProperty.call(good, 'password'), '用户记录里不存明文密码');
  ok(L.verifyPassword('pw-123456', good.salt, good.hash) === true, '密码哈希可校验');
  ok(L.verifyPassword('pw-123457', good.salt, good.hash) === false, '错密码校验失败');
  ok(good.salt !== L.createUser({ username: 'strong2', password: 'pw-123456' }).salt, '每个账号盐不同（同样的密码哈希也不同）');
}

console.log('\n── 3. 暂存 id 格式校验（拼路径前防穿越）──');
{
  ok(L.newStashId().startsWith('P'), '正常生成的暂存 id 以 P 开头');
  const bad = ['../evil', '..\\evil', 'a/b', '', 'x'.repeat(41)];
  for (const b of bad) {
    let threw = false;
    try { L.stashDir(b); } catch { threw = true; }
    ok(threw, `非法暂存 id ${JSON.stringify(b)} 被拒`);
  }
  ok(typeof L.stashDir(L.newStashId()) === 'string', '合法暂存 id 正常拼路径');
  eq(L.getStash('../evil'), null, '非法 id 取暂存返回 null（不抛给上层）');
}

console.log('\n── 4. Cookie 与响应头（在服务端代码里断言，防止被改回去）──');
{
  const src = fs.readFileSync(path.join(L.ROOT || path.resolve(import.meta.dirname, '..'), 'web', 'server.mjs'), 'utf8');
  const loginCookie = (src.match(/Set-Cookie',\s*`sid=\$\{sid\}[^`]*`/) || [''])[0];
  ok(/HttpOnly/.test(loginCookie), '登录 Cookie 带 HttpOnly（JS 读不到）');
  ok(/SameSite=Lax/.test(loginCookie), '登录 Cookie 带 SameSite=Lax（挡跨站 POST）');
  ok(!/Max-Age/.test(loginCookie), '**登录 Cookie 不写 Max-Age ＝ 关浏览器即失效**（用户要求）');
  ok(/X-Content-Type-Options/.test(src), '响应头加了 nosniff');
  ok(/X-Frame-Options/.test(src), '响应头加了 X-Frame-Options（防被嵌套）');
  ok(/path\.relative\(PUBLIC_DIR/.test(src), '静态服务用 path.relative 判目录穿越（不再用前缀 startsWith）');
  ok(/DUMMY_HASH/.test(src), '账号不存在时也跑一次哈希比对（防响应时间枚举账号）');
  ok(/parseCookies[\s\S]{0,600}catch/.test(src), 'Cookie 解析带容错（坏编码不再把请求打成 500）');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 会话与安全自检：${pass} 通过 / ${fail} 失败\n`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
