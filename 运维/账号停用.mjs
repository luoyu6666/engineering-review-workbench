// 批量停用账号（保留指定白名单），并踢掉它们已登录的会话
//
// 背景：系统里有 27/28 个账号仍是初始密码 123456，而用户名就是本人姓名 ——
//       能上内网的人输入任意同事姓名 + 123456 就能看到那个人的全部报告。
//       在启用登录防护之前，先把暂时不用的账号关掉，把暴露面从 28 人压到 3 人。
//
// 用法：
//   node 运维\账号停用.mjs                  # 干跑，只报告会改哪些
//   node 运维\账号停用.mjs --apply          # 真的停用
//   node 运维\账号停用.mjs --apply --keep admin,某账号,某账号    # 自定义白名单
//
// 重新启用：在「系统管理 → 用户管理」里点「启用」即可，不需要跑脚本。
import * as L from '../web/lib.mjs';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const keepArg = args.includes('--keep') ? args[args.indexOf('--keep') + 1] : '';
const KEEP = (keepArg ? keepArg.split(',') : []).map(s => s.trim()).filter(Boolean);
if (!KEEP.length) {
  // ⚠️ 这里**故意不再给默认值**：早先默认保留 admin+两个员工、停用其余全部账号，
  //    万一误跑一次（尤其带 --apply）后果很严重。现在必须显式指定要保留谁。
  console.error('必须显式指定要保留的账号，例如：');
  console.error('  node 运维\\账号停用.mjs --apply --keep admin,zs,ls');
  console.error('（--keep 是"保留"，不在名单里的会被停用；先不带 --apply 干跑看看）');
  process.exit(1);
}

const users = L.listUsers();
const keep = users.filter(u => KEEP.includes(u.username));
const miss = KEEP.filter(n => !users.some(u => u.username === n));
const toDisable = users.filter(u => !KEEP.includes(u.username) && !u.disabled);
const already = users.filter(u => !KEEP.includes(u.username) && u.disabled);

console.log('═══════════════════════════════════════════════════');
console.log('  账号批量停用' + (apply ? '（执行）' : '（干跑，不改动）'));
console.log('═══════════════════════════════════════════════════');
console.log(`  账号总数        ${users.length}`);
console.log(`  白名单（保留）  ${keep.map(u => u.username).join('、') || '（无）'}`);
if (miss.length) console.log(`  ⚠ 白名单里找不到：${miss.join('、')}`);
console.log(`  停用后仍可用    ${keep.filter(u => !u.disabled).length} 个`);
console.log(`  本次将停用      ${toDisable.length} 个`);
if (already.length) console.log(`  本来就已停用    ${already.length} 个`);

if (keep.some(u => L.verifyPassword('123456', u.salt, u.hash))) {
  console.log('');
  console.log('  ⚠ 注意：保留的账号里仍有使用初始密码 123456 的。');
  for (const u of keep) {
    if (L.verifyPassword('123456', u.salt, u.hash)) console.log(`      · ${u.username} 仍是 123456，请尽快修改`);
  }
}

if (!apply) {
  console.log('');
  console.log('  干跑结束。确认无误后加 --apply 执行。');
  process.exit(0);
}

// 1) 停用
for (const u of toDisable) { u.disabled = true; u.disabledAt = new Date().toISOString(); u.disabledBy = '账号停用脚本'; }
L.saveUsers(users);
console.log('');
console.log(`  ✓ 已停用 ${toDisable.length} 个账号`);

// 2) 踢掉被停用账号的活动会话（否则已登录的人还能继续用，停用形同虚设）
const removed = L.purgeDisabledSessions();
console.log(`  ✓ 清理已停用账号的登录会话 ${removed} 个`);

const after = L.listUsers();
console.log('');
console.log('  当前可用账号：');
for (const u of after.filter(x => !x.disabled)) {
  const weak = L.verifyPassword('123456', u.salt, u.hash);
  console.log(`    · ${u.username.padEnd(8)} ${u.role === 'admin' ? '管理员' : '普通用户'}${u.deepAccess ? ' · 可看审核成果' : ''}${weak ? '  ⚠ 密码仍是 123456' : ''}`);
}
console.log('');
console.log('  需要恢复某个账号：在「系统管理 → 用户管理」里点「启用」。');
console.log('═══════════════════════════════════════════════════');
