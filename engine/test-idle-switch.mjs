/**
 * 「提交与调度」开关自检（零 API；纯逻辑 + 界面静态断言）
 *
 * 2026-09-28 口径：首页闲忙时选择可由管理员开关控制。
 * 忙时关闭（避免使用方误选闲时把报告压到半夜），闲时打开由使用方自行选择。
 * 选定实现：① 新增一张「提交与调度」卡片；② 关闭时隐藏选择 + 一行说明；③ 管理员保留选择权。
 *
 * 这个开关最容易出的两类问题：
 *   ① 只在界面上藏了选项，接口仍可被"闲时"请求绕过（等于未关）；
 *   ② 老配置文件里没有这个键，对 `c.allowIdleChoice` 双重取反会误判成"关闭"，
 *      使用方看不到选择。
 * 下面均已有断言覆盖。
 *
 * 用法：node engine\test-idle-switch.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wbsw-'));
process.env.WB_DATA_DIR = tmp;
const L = await import('../web/lib.mjs');

let pass = 0, fail = 0;
const ok = (c, n, extra = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${extra ? '  ← ' + extra : ''}`); } };
const eq = (a, b, n) => ok(a === b, n, `实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`);

console.log('\n── 1. 开关默认值与读写 ──');
{
  eq(L.DEFAULT_SYSTEM_CONFIG.allowIdleChoice, true, '默认**允许**员工选择调用时机（保持原有行为，不会升级后突然变样）');
  eq(L.getSystemConfig().allowIdleChoice, true, '没写过配置文件时读到 true');
  L.saveSystemConfig({ allowIdleChoice: false });
  eq(L.getSystemConfig().allowIdleChoice, false, '关掉后能读回 false');
  eq(L.getSystemConfig().enforceProjectQuota, false, '关这个开关不影响其它开关（合并写，不是覆盖整份配置）');
  L.saveSystemConfig({ allowIdleChoice: true });
  eq(L.getSystemConfig().allowIdleChoice, true, '能再打开（"闲的时候再打开"）');
}

console.log('\n── 2. 服务端强制：关了就是关了（不信任前端）──');
{
  const on = { allowIdleChoice: true };
  const off = { allowIdleChoice: false };

  eq(L.resolveAuditMode({ role: 'user', requested: 'idle', cfg: on }).mode, 'idle', '开着时：普通用户选闲时 → 闲时');
  eq(L.resolveAuditMode({ role: 'user', requested: 'immediate', cfg: on }).mode, 'immediate', '开着时：普通用户选立即 → 立即');
  eq(L.resolveAuditMode({ role: 'user', requested: '', cfg: on }).mode, 'idle', '开着时：没带参数 → 默认闲时（原有默认值不变）');

  const offUser = L.resolveAuditMode({ role: 'user', requested: 'idle', cfg: off });
  eq(offUser.mode, 'immediate', '**关掉后：普通用户即使请求"闲时"也被强制成"立即"**（接口绕过无效）');
  eq(offUser.forced, true, '标记为"被强制"（服务端会写审计日志，便于事后查）');
  ok(/管理员已关闭/.test(offUser.reason), '原因可读', offUser.reason);
  eq(L.resolveAuditMode({ role: 'user', requested: 'immediate', cfg: off }).mode, 'immediate', '关掉后：本来就选立即的 → 立即（不算强制）');
  eq(L.resolveAuditMode({ role: 'user', requested: 'immediate', cfg: off }).forced, false, '没被改就不算强制');

  // 管理员保留选择权
  const offAdmin = L.resolveAuditMode({ role: 'admin', requested: 'idle', cfg: off });
  eq(offAdmin.mode, 'idle', '**关掉后管理员仍可选闲时**（用户要求保留）');
  eq(offAdmin.forced, false, '管理员不标记为强制');
  eq(L.resolveAuditMode({ role: 'admin', requested: 'immediate', cfg: off }).mode, 'immediate', '管理员选立即 → 立即');

  // 审核专家（deepAccess）在服务端也只是 role='user'，同样受限
  eq(L.resolveAuditMode({ role: 'user', requested: 'idle', cfg: off }).mode, 'immediate', '审核专家（role=user）同样被强制 → 与用户口径一致');
}

console.log('\n── 3. 谁看得到选择（/api/me 的口径）──');
{
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'web', 'server.mjs'), 'utf8');
  ok(/idleChoiceAllowed: u\.role === 'admin' \|\| L\.getSystemConfig\(\)\.allowIdleChoice !== false/.test(src),
    '/api/me 的 idleChoiceAllowed：管理员恒 true，其他人看开关（=== false 才算关）');
  ok(/idleChoiceIsAdminOff: u\.role !== 'admin'/.test(src), '另给一个"被管理员关掉"的标记（界面文案用）');
  ok(/L\.resolveAuditMode\(\{ role: u\.role, requested: body\.mode \}\)/.test(src), 'PPT 提交路径走统一判定');
  ok(/L\.resolveAuditMode\(\{ role: u\.role, requested: req\.headers\['x-audit-mode'\] \}\)/.test(src), '普通提交路径走统一判定');
  ok(/typeof body\.allowIdleChoice !== 'boolean'/.test(src), '接口只接受布尔（传成字符串会被拒，避免开关"关不掉"）');
  ok(!/const mode = body\.mode === 'immediate' \? 'immediate' : 'idle';/.test(src), '旧的"直接信任前端 mode"写法已不存在');
}

console.log('\n── 4. 界面：隐藏选项 + 一行说明 + 管理员不受限 ──');
{
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'web', 'public', 'index.html'), 'utf8');
  const body = src.slice(src.indexOf('<body'));
  ok(/id="moIdle"/.test(body) && /id="moImmediate"/.test(body), '两个选项有 id（才能按开关隐藏）');
  ok(/id="modeLocked"/.test(body) && /当前由管理员统一设置为 <b>立即调用<\/b>/.test(body),
    '关掉时显示的说明行存在（不是静默消失）');
  ok(/function applyIdleChoice\(\)/.test(body), '有 applyIdleChoice() 统一切换两种状态');
  ok(/if \(!IDLE_CHOICE_ALLOWED\) return 'immediate';/.test(body),
    'currentMode()：不能选时恒返回 immediate（与服务端一致，不会提交"闲时"）');
  ok(/IDLE_CHOICE_ALLOWED = ME\.idleChoiceAllowed !== false;/.test(body), 'boot 里按 /api/me 设标记（=== false 才算关）');
  ok(/applyIdleChoice\(\);/.test(body), 'boot 里应用一次（否则刷新后仍是旧状态）');
  ok(/if \(!IDLE_CHOICE_ALLOWED\) \{[\s\S]{0,400}?按管理员设置：立即调用/.test(body),
    '时段提示改成"按管理员设置：立即调用"（不再劝"建议改用闲时调用"）');
  // 开关卡片
  ok(/data-sec="提交与调度"/.test(body) && /<h2>提交与调度<\/h2>/.test(body), '系统管理新增「提交与调度」卡片');
  ok(/id="sc_idlechoice"/.test(body), '卡片里有开关控件');
  // 用纯字符串包含判断（不用正则：此处有引号与括号，正则易写错）
  ok(body.includes("$('sc_idlechoice').checked = c.allowIdleChoice !== false"),
    "读取时用 !== false（老配置没这个键 → 当作\"开\"，不会误判成关掉）");
  ok(/allowIdleChoice: idleOn/.test(body), '保存时把这个开关一起提交');
  ok(/管理员自己不受这个开关限制/.test(body), '卡片文案说明"管理员不受限"（与实现一致，避免误解）');
  // 卡片顺序：紧挨「项目质量配额」之前（两张都是提交侧开关）
  const iIdle = body.indexOf('data-sec="提交与调度"');
  const iQuota = body.indexOf('data-sec="项目质量配额"');
  ok(iIdle > 0 && iQuota > iIdle, '「提交与调度」排在「项目质量配额」之前（提交侧开关相邻）');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 提交与调度开关自检：${pass} 通过 / ${fail} 失败\n`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
