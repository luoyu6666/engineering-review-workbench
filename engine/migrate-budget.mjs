// 迁移：把用户的 dailyLimit/monthlyLimit 换成 budget（金额额度）
// 幂等：可以反复跑
import fs from 'node:fs';

const F = 'D:/Deepseek harness工作区/生活其他/审核工作台/web/data/users.json';
const users = JSON.parse(fs.readFileSync(F, 'utf8'));
const DEFAULT_BUDGET = 100;

let migrated = 0, cleaned = 0;
for (const u of users) {
  // 去掉旧字段
  if ('dailyLimit' in u) { delete u.dailyLimit; cleaned++; }
  if ('monthlyLimit' in u) { delete u.monthlyLimit; cleaned++; }
  // 补上新字段：管理员不限（0），其他人默认 100
  if (!('budget' in u)) {
    u.budget = u.role === 'admin' ? 0 : DEFAULT_BUDGET;
    migrated++;
  }
}

fs.writeFileSync(F, JSON.stringify(users, null, 2), 'utf8');

console.log('════════ 迁移结果 ════════');
console.log(`  账号总数           ${users.length}`);
console.log(`  新增 budget        ${migrated} 个`);
console.log(`  清掉旧配额字段     ${cleaned} 处`);
console.log('');
const admin = users.filter(u => u.role === 'admin');
const normal = users.filter(u => u.role !== 'admin');
console.log(`  管理员 ${admin.length} 个：budget = ${[...new Set(admin.map(u => u.budget))].join(', ')}（0 = 不限）`);
const bset = [...new Set(normal.map(u => u.budget))];
console.log(`  普通用户 ${normal.length} 个：budget = ${bset.join(', ')}`);
console.log('');
console.log('  字段: ' + Object.keys(users[0]).join(', '));
