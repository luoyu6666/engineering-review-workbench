/**
 * IP 访问控制自检（零 API；纯逻辑 + 服务端/界面静态断言）
 *
 * 2026-09-28 口径：在用户管理里增加 IP / MAC 绑定，用于限制其他部门访问和调用。
 * 定稿口径：
 *   · MAC 不做拦截（浏览器读不到、ARP 会老化、可随意修改、跨网段取不到），只记录作核对参考；
 *   · IP 做两道闸门：① 全局白名单（名单外的 IP 连登录页都进不去）② 每账号绑定；
 *   · 直接拦截（不先观察）；管理员默认豁免；系统管理里有一键应急开关。
 *
 * 用法：node engine\test-ipbind.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wbip-'));
process.env.WB_DATA_DIR = tmp;
const L = await import('../web/lib.mjs');

let pass = 0, fail = 0;
const ok = (c, n, extra = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${extra ? '  ← ' + extra : ''}`); } };
const eq = (a, b, n) => ok(a === b, n, `实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`);

console.log('\n── 1. IP 规则匹配（三种写法 + 边界）──');
{
  eq(L.ipMatches('10.81.108.77', '10.81.108.77'), true, '精确匹配');
  eq(L.ipMatches('10.81.108.78', '10.81.108.77'), false, '精确不匹配');
  eq(L.ipMatches('10.81.108.77', '10.81.108.*'), true, '通配：同网段最后一段任意');
  eq(L.ipMatches('10.81.109.77', '10.81.108.*'), false, '通配：不同网段不匹配');
  eq(L.ipMatches('10.81.108.77', '10.81.108.0/24'), true, '网段：/24 命中');
  eq(L.ipMatches('10.81.109.1', '10.81.108.0/24'), false, '网段：/24 不命中');
  eq(L.ipMatches('10.81.108.255', '10.81.108.0/24'), true, '网段：边界地址也算命中');
  eq(L.ipMatches('10.81.108.77', '10.81.108.77/32'), true, '/32 单机等于精确');
  eq(L.ipMatches('10.81.108.77', '0.0.0.0/0'), true, '/0 等于全放行');
  eq(L.ipMatches('10.81.108.77', '*'), true, '`*` 等于全放行');
  eq(L.ipMatches('10.81.108.77', ''), true, '空规则等于全放行');
  eq(L.ipMatches('::ffff:10.81.108.77', '10.81.108.77'), true, '自动剥掉 IPv6 映射前缀（实测会碰到）');
  eq(L.ipMatches('', '10.81.108.77'), false, '空 IP 一律不匹配（宁可拒绝，不能误放）');
  eq(L.ipMatches('10.81.108.77', '10.81.1*'), false, '不支持半段通配（避免写出谁也看不懂的规则）');
  eq(L.ipMatches('10.81.108.999', '10.81.108.*'), false, '非法 IP 段不被通配放过');
  eq(L.ipMatches('2001:db8::1', '10.81.108.0/24'), false, 'IPv6 语义不明 → 不命中');
  eq(L.ipv4ToInt('10.81.108.77'), (10 * 256 ** 3 + 81 * 256 ** 2 + 108 * 256 + 77) >>> 0, '点分转整数正确');
  eq(L.ipv4ToInt('10.81.108'), null, '非法 IPv4 返回 null');
}

console.log('\n── 2. 列表判定：空列表 = 不限制（先加人后补录的关键）──');
{
  eq(L.ipAllowed('10.81.108.77', []), true, '空列表 → 不限制（否则新同事一上来就登不进）');
  eq(L.ipAllowed('10.81.108.77', ['', '  ']), true, '全是空白 → 视为空列表');
  eq(L.ipAllowed('10.81.108.77', ['10.81.108.1', '10.81.108.77']), true, '命中其中一条即可');
  eq(L.ipAllowed('10.81.108.99', ['10.81.108.1', '10.81.108.77']), false, '都不命中 → 拒');
  eq(L.ipAllowed('10.81.108.99', ['10.81.108.*']), true, '通配命中');
  const norm = L.normalizeIpList([' 10.81.108.77 ', '10.81.108.77', '', '10.81.108.*']);
  eq(norm.join('|'), '10.81.108.77|10.81.108.*', '规范化：去空白、去重、丢空项');
}

console.log('\n── 3. 两道闸门 + 管理员豁免 + 应急开关（唯一判定口径）──');
{
  const cfg = (o = {}) => ({ ipEnforce: true, ipAllowlist: [], ipExemptAdmins: true, ...o });
  const user = (o = {}) => ({ id: 'u1', name: '甲', role: 'user', allowedIps: [], ...o });

  eq(L.checkIpAccess({ ip: '10.9.9.9', user: user(), cfg: cfg() }).allowed, true,
    '两道都没配 → 谁都能进（默认不改变现状）');

  const g = L.checkIpAccess({ ip: '10.9.9.9', user: user(), cfg: cfg({ ipAllowlist: ['10.81.108.*'] }) });
  eq(g.allowed, false, '**全局白名单**：名单外的 IP 一律拒');
  eq(g.scope, 'global', '且标明是"全局白名单"这一道（界面据此提示）');
  ok(/不在允许访问的范围内/.test(g.reason), '理由可读', g.reason);
  eq(L.checkIpAccess({ ip: '10.81.108.5', user: user(), cfg: cfg({ ipAllowlist: ['10.81.108.*'] }) }).allowed, true,
    '全局白名单：段内 IP 放行');

  const u2 = L.checkIpAccess({ ip: '10.81.109.5', user: user({ allowedIps: ['10.81.108.77'] }), cfg: cfg() });
  eq(u2.allowed, false, '**每账号绑定**：没绑定的 IP 一律拒（即使全局白名单没配）');
  eq(u2.scope, 'user', '标明是"每账号绑定"这一道');
  ok(/只能从绑定的电脑登录/.test(u2.reason), '理由可读', u2.reason);
  eq(L.checkIpAccess({ ip: '10.81.108.77', user: user({ allowedIps: ['10.81.108.77'] }), cfg: cfg() }).allowed, true,
    '绑定的 IP 放行');

  // 两道同时配：先判全局
  const both = L.checkIpAccess({ ip: '10.9.9.9', user: user({ allowedIps: ['10.81.108.77'] }), cfg: cfg({ ipAllowlist: ['10.81.108.*'] }) });
  eq(both.scope, 'global', '两道都配时先判全局（理由更贴切：本机根本不在允许范围）');

  // 管理员豁免
  const admin = { id: 'u0', name: '管理员', role: 'admin', allowedIps: ['10.81.108.77'] };
  eq(L.checkIpAccess({ ip: '10.9.9.9', user: admin, cfg: cfg({ ipAllowlist: ['10.81.108.*'] }) }).allowed, true,
    '**管理员默认豁免**（避免把自己锁在外面）');
  eq(L.checkIpAccess({ ip: '10.9.9.9', user: admin, cfg: cfg({ ipAllowlist: ['10.81.108.*'] }) }).scope, 'admin', '标明因豁免放行');
  eq(L.checkIpAccess({ ip: '10.9.9.9', user: admin, cfg: cfg({ ipAllowlist: ['10.81.108.*'], ipExemptAdmins: false }) }).allowed, false,
    '把"管理员豁免"关掉后，管理员也受约束（留了口子但不强制）');

  // 应急开关（一键临时放行）
  eq(L.checkIpAccess({ ip: '10.9.9.9', user: user({ allowedIps: ['1.1.1.1'] }), cfg: cfg({ ipEnforce: false, ipAllowlist: ['10.81.108.*'] }) }).allowed, true,
    '**应急开关关闭时一律放行**（一键放行，救命用）');
  eq(L.checkIpAccess({ ip: '10.9.9.9', user: user(), cfg: cfg({ ipEnforce: false }) }).scope, 'off', '标明"已临时关闭"');
  // 默认值
  eq(L.DEFAULT_SYSTEM_CONFIG.ipEnforce, true, '默认开启访问控制');
  eq(L.DEFAULT_SYSTEM_CONFIG.ipAllowlist.length, 0, '默认白名单为空（不改变现状，配了才生效）');
  eq(L.DEFAULT_SYSTEM_CONFIG.ipExemptAdmins, true, '默认管理员豁免');
}

console.log('\n── 3b. 本机豁免（用户明确要求：127.0.0.1 是本地我的电脑，任何操作都不设限制）──');
{
  const cfg = (o = {}) => ({ ipEnforce: true, ipAllowlist: ['10.81.108.24'], ipExemptAdmins: true, ipExemptLocal: true, ...o });
  const bound = { role: 'user', allowedIps: ['10.81.109.153'] };   // 绑定到别人机器的普通账号

  eq(L.isLoopback('127.0.0.1'), true, '127.0.0.1 是回环');
  eq(L.isLoopback('127.0.0.53'), true, '127.0.0.0/8 整段都算回环');
  eq(L.isLoopback('::1'), true, 'IPv6 回环也算');
  eq(L.isLoopback('10.81.108.161'), false, '服务器自己的网卡 IP **不是**回环（但属本机地址，见下）');
  eq(L.isLocalRequest('10.81.108.161'), true, '本机自己的网卡 IP（用服务器地址访问）也算"本机"');

  const v = L.checkIpAccess({ ip: '127.0.0.1', user: bound, cfg: cfg() });
  eq(v.allowed, true, '**本机访问：连"每账号绑定"也不挡**（否则从服务器本机登录会被莫名拦住——实测踩过）');
  eq(v.scope, 'local', '并标明是"本机豁免"');
  eq(L.checkIpAccess({ ip: '127.0.0.1', user: bound, cfg: cfg({ ipEnforce: false }) }).allowed, true, '应急关闭时同样放行');
  eq(L.checkIpAccess({ ip: '10.81.108.161', user: bound, cfg: cfg() }).allowed, true, '用服务器自己的 IP 访问也放行');
  // 关掉这个豁免后应恢复严格
  const off = L.checkIpAccess({ ip: '127.0.0.1', user: bound, cfg: cfg({ ipExemptLocal: false }) });
  eq(off.allowed, false, '把"本机豁免"关掉后，本机也照样按规则判（可选，默认开）');
  eq(off.scope, 'global', '（此时先撞全局白名单——因为 127.0.0.1 不在那份名单里）');
  // 别人机器不受本机豁免影响
  eq(L.checkIpAccess({ ip: '10.81.109.5', user: bound, cfg: cfg() }).allowed, false, '同事的机器不受"本机豁免"影响，仍按绑定判');
  eq(L.DEFAULT_SYSTEM_CONFIG.ipExemptLocal, true, '默认开启本机豁免');

  // 补充口径："本机 IP 10.81.108.161 也不做任何限制"
  // → 除"本机网卡自动识别"外，还要能在配置里写死免限制 IP（网卡变化时不失效）
  const free = cfg({ ipFreeList: ['10.81.108.161', '10.81.108.161', '  '] });
  eq(L.checkIpAccess({ ip: '10.81.108.161', user: bound, cfg: free }).allowed, true,
    '**写死的"免限制 IP"（10.81.108.161）：任何人从这台机器操作都不设限**');
  eq(L.checkIpAccess({ ip: '10.81.108.161', user: bound, cfg: free }).scope, 'local', '归入"本机/免限制"这一类');
  // localIps 是 checkIpAccess 的顶层参数，不是 cfg 的字段（首版写进 cfg，
  //    于是仍走"自动识别本机网卡"，断言写反）
  eq(L.checkIpAccess({ ip: '10.81.108.161', user: bound, cfg: cfg({ ipFreeList: [] }), localIps: ['127.0.0.1'] }).allowed, false,
    '把显式列表清空、且不把它当本机地址 → 恢复按规则判（说明列表是有效的判定依据，不是摆设）');
  eq(L.checkIpAccess({ ip: '10.9.9.9', user: bound, cfg: cfg({ ipFreeList: ['10.81.108.161'] }) }).allowed, false,
    '免限制列表只对它列出的机器生效，不会误放行别人');
  eq(L.normalizeIpList(['10.81.108.161', '10.81.108.161', '', ' 127.0.0.1 ']).join('|'), '10.81.108.161|127.0.0.1',
    '免限制列表保存前会去重去空白');
}

console.log('\n── 3c. 联动回归：改了账号绑定，就不该再被"全局白名单"挡住（用户报的 BUG）──');
{
  // 2026-09-28 场景：账号绑定的登录 IP 改为 10.81.109.214 后仍无法进入 ——
  // 因为全局白名单在登录前判定、且只查手工名单：该账号在第一道校验即被拒绝，
  // "每账号绑定"不起作用。修法：实际生效白名单 = 手工名单 ∪ 各账号绑定。
  const cfg = { ipEnforce: true, ipAllowlist: ['10.81.108.24', '127.0.0.1'], ipExemptAdmins: true, ipExemptLocal: true, ipFreeList: [] };
  const users = [
    { name: '王五', role: 'user', allowedIps: ['10.81.109.214'] },
    { name: '孙七', role: 'user', allowedIps: ['10.81.108.24'] },
  ];
  const bound = L.boundIpsOf(users);
  eq(bound.join('|'), '10.81.109.214|10.81.108.24', 'boundIpsOf() 收齐各账号绑定的 IP（去重）');
  const eff = L.effectiveAllowlist(cfg, users);
  eq(eff.restricted, true, '手工名单非空 → 全局闸门启用');
  ok(eff.list.includes('10.81.109.214'), '**账号绑定的 IP 自动并入生效名单**（这正是修 BUG 的关键）');
  eq(eff.explicit.length, 2, '手工那份单独可见（便于界面显示"手工 N + 自动 M"）');
  eq(eff.auto.length, 2, '自动并入的那份也单独可见');

  const zhang = { role: 'user', allowedIps: ['10.81.109.214'] };
  eq(L.checkIpAccess({ ip: '10.81.109.214', user: zhang, cfg, boundIps: bound }).allowed, true,
    '**改了绑定之后：他能打开系统、也能登录**（BUG 场景回归）');
  eq(L.checkIpAccess({ ip: '10.81.109.214', user: zhang, cfg }).allowed, false,
    '对照：不把账号绑定并入白名单时，同一个 IP 会被"登录前那道"挡住（这就是原来的 BUG）');
  eq(L.checkIpAccess({ ip: '10.9.9.9', user: zhang, cfg, boundIps: bound }).allowed, false,
    '陌生 IP 仍然被挡（联动没有把闸门放开）');
  // 无人绑定、且不在手工名单里的 IP：照旧被挡
  eq(L.checkIpAccess({ ip: '10.81.109.250', user: { role: 'user', allowedIps: [] }, cfg, boundIps: bound }).allowed, false,
    '没人绑定的 IP 依旧进不来');
  // 取消绑定 → 该 IP 自动退出生效名单（不留僵尸条目）
  const after = L.effectiveAllowlist(cfg, [{ name: '王五', role: 'user', allowedIps: [] }]);
  eq(after.list.includes('10.81.109.214'), false, '取消绑定后该 IP 自动退出（不会留下没人用的条目）');
  // 向后兼容：手工名单为空时，全局闸门仍然"不限制"
  eq(L.effectiveAllowlist({ ipAllowlist: [] }, users).restricted, false,
    '**手工白名单为空时仍不限制**（只想给几个人绑 IP、不想开全局限制的系统不会被突然锁死）');
  eq(L.checkIpAccess({ ip: '10.9.9.9', user: { role: 'user', allowedIps: [] }, cfg: { ipEnforce: true, ipAllowlist: [] }, boundIps: bound }).allowed, true,
    '同上：空名单 + 有人绑定 → 也不限制（保持原语义）');
}

console.log('\n── 4. 取来源 IP（重点：默认不信任可伪造的 X-Forwarded-For）──');
{
  eq(L.clientIpOf({}, '10.81.108.5'), '10.81.108.5', '无反代时用套接字地址');
  eq(L.clientIpOf({}, '::ffff:10.81.108.5'), '10.81.108.5', '剥掉 IPv6 映射前缀');
  eq(L.clientIpOf({}, ''), '', '都没有时返回空（判为不匹配，宁可拒绝）');
  // 关键安全断言：XFF 由客户端提供、可伪造，默认必须忽略
  eq(L.clientIpOf({ 'x-forwarded-for': '10.81.108.24' }, '10.9.9.9'), '10.9.9.9',
    '**默认忽略 X-Forwarded-For**（否则伪造一个白名单内 IP 就能绕过访问控制）');
  eq(L.clientIpOf({ 'x-forwarded-for': '10.81.108.24, 10.0.0.1' }, '10.9.9.9', { trustProxy: true }), '10.81.108.24',
    '确实放在反代后面时（WB_TRUST_PROXY=1）才取 XFF 第一段');
  eq(L.clientIpOf({ 'x-forwarded-for': '10.81.108.24' }, '10.9.9.9', { trustProxy: false }), '10.9.9.9',
    '显式 trustProxy:false 同样忽略');
  // 伪造的 XFF 也不会进入白名单：它不会被取到
  eq(L.checkIpAccess({ ip: L.clientIpOf({ 'x-forwarded-for': '10.81.108.24' }, '10.9.9.9'),
    user: { role: 'user', allowedIps: [] }, cfg: { ipEnforce: true, ipAllowlist: ['10.81.108.24'] } }).allowed, false,
    '伪造 XFF 冒充白名单 IP：仍被拒（判定用的是真实对端地址）');
}

console.log('\n── 5. 服务端接线（静态断言：防"只在界面藏了、服务端没拦"）──');
{
  const srv = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'web', 'server.mjs'), 'utf8');
  ok(/if \(blockedByAllowlist\(req, res, clientIp\(req\)\)\) return;/.test(srv), 'API 路由最前面就有全局白名单闸门');
  ok(/const TRUST_PROXY = process\.env\.WB_TRUST_PROXY === '1';/.test(srv),
    '**默认不信任 X-Forwarded-For**，只有显式设 WB_TRUST_PROXY=1（确实在反代后面）才用');
  ok(/const clientIp = \(req\) => L\.clientIpOf\(/.test(srv), 'clientIp 是**模块级**函数（写成函数内 const 会撞 TDZ，我第一版就错了）');
  ok(/const verdict = L\.checkIpAccess\(\{ ip, user: u, cfg, boundIps: boundIpsCached\(\) \}\);/.test(srv)
    || /const v0 = L\.checkIpAccess\(\{ ip: ip0, user: sessionUser, cfg: L\.getSystemConfig\(\), boundIps: boundIpsCached\(\) \}\);/.test(srv),
    '每账号绑定的判定存在');
  const calls = (srv.match(/L\.checkIpAccess\(/g) || []).length;
  const withBound = (srv.match(/L\.checkIpAccess\(\{[^}]*boundIps/g) || []).length;
  eq(calls, withBound, '**每一处访问判定都带上"账号绑定 IP"**（漏一处就会出"改了绑定还是进不来"的 BUG）');
  ok(/const sessionUser = currentUser\(req\);[\s\S]{0,700}?checkIpAccess\(\{ ip: ip0, user: sessionUser/.test(srv),
    '**闸门集中在 handleApi 入口**（不只写在 requireUser 里 —— 否则 /api/me 会绕过，实测踩过）');
  ok(!/function requireUser[\s\S]{0,900}?checkIpAccess/.test(srv),
    'requireUser 里不再重复判定（单一判定点，避免两处口径不一致）');
  ok(/function blockedByAllowlist\(req, res, ip\)/.test(srv), '全局白名单闸门抽成函数，API 与静态页共用');
  ok(/function serveStatic[\s\S]{0,400}?checkIpAccess\(\{ ip: ip0, user: null/.test(srv),
    '**静态页也判全局白名单**（用户选的是"直接拦截"，名单外 IP 连登录页都进不去）');
  ok(/X-Client-IP/.test(srv) && /你的 IP：<code>\$\{ip0\}<\/code>/.test(srv), '被拦时把本机 IP 显示出来（方便同事报给管理员）');
  ok(/L\.appendAccessLog\(/.test(srv), '被拒访问写流水（管理员可查"谁被拦了"）');
  ok(/if \(p === '\/api\/access-log' && req\.method === 'GET'\)[\s\S]{0,120}?requireAdmin/.test(srv), '被拒流水仅管理员可看');
  ok(/if \(body\.ipEnforce !== undefined && typeof body\.ipEnforce !== 'boolean'\)/.test(srv)
    && /if \(body\.ipExemptAdmins !== undefined && typeof body\.ipExemptAdmins !== 'boolean'\)/.test(srv),
    '开关只接受布尔（传成字符串会让"应急关闭"失效——那是救命开关）');
  ok(/body\.ipAllowlist = L\.normalizeIpList\(body\.ipAllowlist\)/.test(srv), '白名单保存前规范化');
  ok(/if \(allowedIps !== undefined\)/.test(srv) && /IP 规则写法不对/.test(srv), '每账号绑定有格式校验（拒绝乱写的规则）');
  ok(/mac: await lookupMac\(ip\)/.test(srv), '登录时记录来源 MAC（**仅作核对参考**）');
  ok(/macCache/.test(srv) && /10 \* 60 \* 1000/.test(srv), 'MAC 查询按 IP 缓存 10 分钟（不然每个请求都起进程）');
  ok(/MAC[^\n]*只记录[^\n]*(不参与拦截|不做拦截)|只记录不拦截/.test(srv),
    '代码里写明"MAC 只记录不拦截"的理由（防止日后将其作为拦截依据）');
  ok(/clientIp: clientIp\(req\),/.test(srv) && /allowedIps: u\.allowedIps \|\| \[\],/.test(srv),
    '/api/me 下发本机 IP 与自己的绑定情况（前端可提示"换机器登不进"）');
  ok(/lastIp: \(last && last\.ip\) \|\| ''/.test(srv) && /lastMac:/.test(srv),
    '用户列表带"最近来源 IP / MAC"（管理员核对用）');
}

console.log('\n── 6. 界面（用户管理里能配，且非管理员看不到）──');
{
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'web', 'public', 'index.html'), 'utf8');
  const srv2 = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'web/server.mjs'), 'utf8');   // 先声明再使用（顺序写反会触发 TDZ）
  const lib2 = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'web/lib.mjs'), 'utf8');
  const body = src.slice(src.indexOf('<body'));
  ok(/id="ipAllow"/.test(body), '全局白名单输入框存在');
  ok(/id="ipEnforce"/.test(body), '访问控制总开关存在（应急放行）');
  ok(/id="ipExemptLocal"/.test(body), '**本机豁免**开关存在（127.0.0.1 不设限制）');
  ok(/id="ipFree"/.test(body), '"免限制 IP"输入框存在（可写死 10.81.108.161）');
  ok(/id="ipExempt"/.test(body), '管理员豁免除选框存在');
  ok(/function editIps\(/.test(body), '每账号"IP 绑定"入口存在');
  ok(/allowedIps: parseIps\(/.test(body), '保存时把绑定写成数组提交');
  ok(/addAccessLog|被拒访问|最近的拒绝记录/.test(body), '界面上能看被拒访问流水');
  // 上述 BUG（改绑定后仍无法进入）在界面侧的配套：说明联动关系 + 提供自检入口
  ok(/function checkAccess\(\)/.test(body), '界面上有"访问预检"（改完 IP 先自检，别等同事报错）');
  ok(/id="acIp"/.test(body) && /id="acUser"/.test(body), '预检的 IP / 账号输入框存在');
  ok(/function saveAccessControl\(\)/.test(body) && /id="ipAllow"/.test(body), '手工白名单与访问控制开关仍在（能干活的那部分保留）');
  // 第二轮口径："实际生效白名单：共 25 条…"与那串 IP/人名图标仅作展示、无实际作用，已删除。
  // 因此这里反向断言：不应再出现该展示（避免被重新加回），诊断统一走「访问预检」。
  ok(!/ipEffList/.test(body) && !/ipeff-pill/.test(body), '展示用的"实际生效白名单"清单与 ⓐ 图标已删除（用户要求）');
  ok(!/id="ipEffCount"/.test(body), '"共 N 条（手工…+自动并入…）"那行已删除');
  ok(/function checkAccess\(\)/.test(body), '界面上有"访问预检"（改完 IP 先自检，别等同事报错）');
  ok(/id="acIp"/.test(body) && /id="acUser"/.test(body), '预检的 IP / 账号输入框存在');
  ok(/if \(p === '\/api\/access-check' && req\.method === 'POST'\)[\s\S]{0,120}?requireAdmin/.test(srv2),
    '访问预检接口仅管理员可用');
  ok(!/ipEffective/.test(srv2), '接口不再下发只用于展示的 ipEffective');
  ok(!/ipOwnerMap/.test(lib2) && !/ipOwnerMap/.test(srv2), 'ipOwnerMap 已删除（不再有只服务展示的死代码）');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} IP 访问控制自检：${pass} 通过 / ${fail} 失败\n`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
