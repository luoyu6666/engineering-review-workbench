/**
 * 开通「审核专家」级别（可看校对版 + 审核版，不含系统管理）
 * 用法：node engine\grant-expert.mjs 李四 金一 钱八
 *       node engine\grant-expert.mjs --list            # 只看当前各级别人数
 *
 * 只改 users.json 里的 role / deepAccess 两个字段，不动密码与额度。
 */
import * as L from '../web/lib.mjs';

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const users = L.listUsers();
const level = (x) => (x.role === 'admin' ? '管理员' : (x.deepAccess ? '审核专家' : '普通用户'));

if (!args.length || process.argv.includes('--list')) {
  console.log('当前各级别：');
  for (const lv of ['管理员', '审核专家', '普通用户']) {
    const list = users.filter(x => level(x) === lv && !x.disabled);
    console.log(`  ${lv}（${list.length}）：${list.map(x => x.name + '/' + x.username).join('、') || '—'}`);
  }
  process.exit(0);
}

let changed = 0;
for (const who of args) {
  const t = users.find(x => x.username === who || x.name === who);
  if (!t) { console.log(`  ✗ 找不到账号：${who}`); continue; }
  if (t.role === 'admin') { console.log(`  ⏭ ${t.name} 是管理员，本身就含审核版权限，跳过`); continue; }
  if (t.deepAccess) { console.log(`  ⏭ ${t.name} 已经是审核专家`); continue; }
  t.role = 'user'; t.deepAccess = true;
  console.log(`  ✓ ${t.name}（${t.username}）→ 审核专家：可看全部台账 + 校对版 + 审核版；不含系统管理`);
  changed++;
}
if (changed) { L.saveUsers(users); console.log(`\n已更新 ${changed} 个账号（改完立即生效，无需对方重新登录）`); }
else console.log('\n没有需要改动的账号');
