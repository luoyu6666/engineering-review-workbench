/**
 * 《操作说明》素材生成器 ③ 影子实例初始化
 *
 * 采用脚本化的原因（不在 PowerShell 里拼请求）：
 *   PowerShell 的 Invoke-WebRequest 发 JSON 时若 ContentType 未写 charset，中文会按 latin-1 编码发出，
 *   服务端收到的是 "??" —— 此前因此把员工姓名建成了 "??"，示例数据也落到管理员名下（经实测确认）。
 *   改用 node 脚本发请求，body 一定是 UTF-8，不再出现这类问题。
 *
 * 用法：node 运维\staff-guide\bootstrap.mjs <管理员初始密码> [账号姓名] [账号名] [密码]
 *   成功后会打印该账号 id（demo-data.mjs 需要它把示例任务挂到该账号名下）。
 */
const BASE = process.env.WB_BASE || 'http://127.0.0.1:8799';
const [, , bootstrapPwd, staffName = '刘工', staffUser = 'liugong', staffPwd = 'liu-2026'] = process.argv;
if (!bootstrapPwd) { console.error('用法：node bootstrap.mjs <管理员初始密码> [员工姓名] [员工账号] [员工密码]'); process.exit(1); }

const j = (o) => ({ headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(o) });
const login = async (username, password) => {
  const r = await fetch(BASE + '/api/login', { method: 'POST', ...j({ username, password }) });
  if (!r.ok) throw new Error(`登录 ${username} 失败：HTTP ${r.status} ${await r.text()}`);
  const raw = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')];
  return raw.map(c => String(c).split(';')[0]).join('; ');
};

let admin = await login('admin', bootstrapPwd);
// 首次登录：把管理员密码改掉（影子实例每次都是新数据，bootstrap 密码每次不同）
const adminPwd = process.env.WB_ADMIN_PWD || 'guide-2026';
await fetch(BASE + '/api/password', { method: 'POST', headers: { Cookie: admin, 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ oldPassword: bootstrapPwd, newPassword: adminPwd }) });
admin = await login('admin', adminPwd);
console.log(`管理员密码已设为 ${adminPwd}`);

// 建员工账号（已存在则改密码 + 改名）
const list = await (await fetch(BASE + '/api/users', { headers: { Cookie: admin } })).json();
let staff = list.find(u => u.username === staffUser);
if (!staff) {
  const r = await fetch(BASE + '/api/users', { method: 'POST', headers: { Cookie: admin, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ username: staffUser, password: staffPwd, name: staffName, role: 'user' }) });
  if (!r.ok) throw new Error('建员工账号失败：' + await r.text());
  staff = await r.json();
  console.log(`已建员工账号：${staffName}（${staffUser} / ${staffPwd}）`);
} else {
  await fetch(BASE + '/api/users/update', { method: 'POST', headers: { Cookie: admin, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ id: staff.id, name: staffName, resetPassword: staffPwd }) });
  console.log(`员工账号已存在，已改名与重置密码：${staffName}`);
}
// 复核姓名确实是中文（不是 "??"）—— 此前出现过该问题，这里保留为哨兵检查
const after = await (await fetch(BASE + '/api/users', { headers: { Cookie: admin } })).json();
const check = after.find(u => u.id === staff.id);
if (check.name !== staffName) {
  console.error(`⚠️ 姓名没写对：期望「${staffName}」，实际「${check.name}」——编码问题，示例数据会挂错人`);
  process.exit(1);
}
console.log(`NAME_OK id=${staff.id}`);
