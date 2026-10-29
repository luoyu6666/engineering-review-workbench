/**
 * 把《工程咨询事业部IP和MAC地址》名单导入系统：全局白名单 + 每账号 IP 绑定。
 *
 * 默认只演练（不写盘）。确认无误再加 --apply 写入；写入前自动备份 users.json 与 system.json。
 *
 * 用法：
 *   node 运维\access\apply-ip-binding.mjs                 # 演练：打印将要写入的内容
 *   node 运维\access\apply-ip-binding.mjs --apply          # 真正写入（自动备份）
 *   node 运维\access\apply-ip-binding.mjs --create-missing # 顺带把名单里有、系统里没有的人建号
 *
 * 数据来源：运维/access/ip-names.json（由 extract-ip-names.py 从 xlsx 导出，含姓名/IP/MAC）。
 *
 * 2026-09-28 确定的导入口径：
 *   · 全局白名单 = 名单里 23 个 IP + 服务器本机（127.0.0.1、本机 LAN IP），名单外一律拒绝
 *   · 每账号绑定 = 各自机器 IP（张三/严九 共用服务器 IP 192.0.2.161，按名单原样绑定）
 *   · 名单里没有 IP 的人不绑定；这类账号会被全局白名单拒绝，补齐 IP 前无法登录（该结果已知并接受）
 *   · MAC 只写入账号备注，不参与拦截
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
process.env.WB_DATA_DIR = process.env.WB_DATA_DIR || path.join(ROOT, 'web', 'data');
const L = await import(pathToFileURL(path.join(ROOT, 'web', 'lib.mjs')).href);

const APPLY = process.argv.includes('--apply');
const CREATE = process.argv.includes('--create-missing');
const NAMES = path.join(ROOT, '运维/access/ip-names.json');
if (!fs.existsSync(NAMES)) { console.error('缺少名单文件：', NAMES, '（先跑 extract-ip-names.py）'); process.exit(1); }
const data = JSON.parse(fs.readFileSync(NAMES, 'utf8'));

// 服务器本机 IP（必须放行，否则在服务器上做运维的账号自身无法登录）
const os = await import('node:os');
const localIps = ['127.0.0.1'];
for (const list of Object.values(os.networkInterfaces())) {
  for (const ni of (list || [])) if (ni.family === 'IPv4' && !ni.internal) localIps.push(ni.address);
}

const withIp = data.rows.filter(r => r.ip);
const noIp = data.rows.filter(r => !r.ip);
const allowlist = L.normalizeIpList([...withIp.map(r => r.ip), ...localIps], { max: 200 });

const users = L.listUsers();
const byName = new Map(users.map(u => [u.name.trim(), u]));
const sysCfg = L.getSystemConfig();

console.log('═══ 将要写入的内容（演练）═══\n');
console.log(`① 全局白名单（${allowlist.length} 条，名单外一律进不来）：`);
console.log('   ' + allowlist.join('、'));
console.log(`   （其中服务器本机：${localIps.join('、')}）\n`);

console.log('② 每账号 IP 绑定：');
const plan = [];
for (const r of withIp) {
  const u = byName.get(r.name);
  if (!u) { plan.push({ ...r, todo: '建号', account: '（系统里没有）' }); continue; }
  plan.push({ ...r, todo: '更新绑定', account: u.username, id: u.id });
}
for (const p of plan) {
  console.log(`   ${p.name.padEnd(8, '　')} ${p.ip.padEnd(16)} ${p.todo}${p.account ? ' → ' + p.account : ''}　MAC ${p.mac || '—'}`);
}
if (noIp.length) {
  console.log(`\n③ 名单里没给 IP 的人（${noIp.length} 位，**不绑 IP**）：`);
  console.log('   ' + noIp.map(r => r.name).join('、'));
  console.log('   ⚠️ 他们会被全局白名单挡住 —— 补 IP 前登不进来（用户已知并接受）。');
}
const sysNoIp = data.systemUsers.filter(u => !withIp.some(r => r.name === u.name));
if (sysNoIp.length) {
  console.log('\n④ 系统里有账号、名单里没出现的人：');
  console.log('   ' + sysNoIp.map(u => `${u.name}(${u.role})`).join('、'));
}

if (!APPLY) {
  console.log('\n（以上只是演练。确认无误后加 --apply 真正写入；写入前会自动备份。）');
  process.exit(0);
}

// ── 真正写入 ──────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dataDir = L.DATA_DIR;
for (const f of ['users.json', 'system.json']) {
  const src = path.join(dataDir, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dataDir, `${f}.bak-${stamp}`));
}
console.log(`\n已备份 users.json / system.json（后缀 .bak-${stamp}）`);

if (CREATE) {
  for (const r of withIp) {
    if (byName.has(r.name)) continue;
    try {
      const nu = L.createUser({ username: r.name, password: '123456', name: r.name, role: 'user' });
      byName.set(r.name, nu);
      console.log(`  已建账号 ${r.name}（初始密码 123456，普通用户）`);
    } catch (e) { console.error(`  建账号 ${r.name} 失败：${e.message}`); }
  }
}

const fresh = L.listUsers();
let n = 0;
for (const r of withIp) {
  const u = fresh.find(x => x.name.trim() === r.name);
  if (!u) continue;
  u.allowedIps = [r.ip];
  if (r.mac) u.macNote = r.mac.replace(/-/g, ':').toUpperCase();   // 只记录（便于核对是否为本人所用机器）
  n++;
}
L.saveUsers(fresh);
// ipFreeList 写入免限制 IP。2026-09-28: 127.0.0.1 与 192.0.2.161 均为服务器自身地址，任何操作不设限制。
// 本机网卡地址会被自动识别，这里再显式写一遍 —— 网卡更换后仍然有效。
L.saveSystemConfig({
  ipEnforce: true, ipAllowlist: allowlist, ipExemptAdmins: true, ipExemptLocal: true,
  ipFreeList: L.normalizeIpList(['127.0.0.1', ...localIps]),
});
console.log(`已写入：${n} 个账号的 IP 绑定；全局白名单 ${allowlist.length} 条；访问控制 = 开启；管理员豁免 = 是`);
console.log(`免限制 IP（任何操作都不设限）：${L.normalizeIpList(['127.0.0.1', ...localIps]).join('、')}`);
console.log('\n⚠️ 下一步必须让 2~3 位同事**各自登录一次**确认能进；谁进不来就看'
  + '「系统管理 → 用户管理 → 被拒访问流水」里他报的 IP，加进白名单/绑定即可。');
console.log('   万一自己被挡：在服务器上登录（服务器本机 IP 已在白名单），或改 web/data/system.json 的 ipEnforce=false。');
