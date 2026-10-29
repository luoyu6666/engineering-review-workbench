/**
 * 生成一对 OpenSSH 格式的 ed25519 密钥（零依赖，只用 Node 内置 crypto）。
 *
 * 自实现的原因：本机的 MiniGit 不带 ssh-keygen（usr/bin 里只有 ssh/ssh-add/ssh-agent），
 * Windows 的 OpenSSH 客户端功能也未安装（`OpenSSH.Client` = NotPresent）。
 * 安装 Windows 功能需要联 Windows Update 并改动系统，因此改为按公开的
 * "openssh-key-v1" 容器格式自行拼装 —— 格式固定，且下面用 ssh 实测验证过可被解析。
 *
 * 用法：
 *   node 运维\make-ssh-key.mjs                 # 生成到 %USERPROFILE%\.ssh\id_ed25519_wb
 *   node 运维\make-ssh-key.mjs --out <路径>     # 指定位置
 *   node 运维\make-ssh-key.mjs --force          # 已存在时覆盖（会换 key，GitHub 上要重新加公钥）
 *
 * 安全说明：私钥只写在本机（不放进仓库、不进备份包）；公钥贴到 GitHub 用。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const outArg = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : '';
const FORCE = argv.includes('--force');
const comment = 'audit-workbench';
const privPath = outArg ? path.resolve(outArg) : path.join(os.homedir(), '.ssh', 'id_ed25519_wb');
const pubPath = privPath + '.pub';

if (fs.existsSync(privPath) && !FORCE) {
  console.log('已存在（未覆盖，如需重做加 --force）：' + privPath);
  console.log('\n公钥内容：');
  console.log(fs.readFileSync(pubPath, 'utf8').trim());
  process.exit(0);
}

// ── 生成 ed25519（取到原始 32 字节种子与公钥）──
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const jwk = privateKey.export({ format: 'jwk' });          // d = 种子(base64url), x = 公钥(base64url)
const b64u = (s) => Buffer.from(s, 'base64url');
const seed = b64u(jwk.d);                                   // 32 字节私钥种子
const pub = b64u(jwk.x);                                     // 32 字节公钥
if (seed.length !== 32 || pub.length !== 32) throw new Error('ed25519 密钥长度异常');

// ── 按 openssh-key-v1 容器拼字节 ──
const str = (b) => { const len = Buffer.alloc(4); len.writeUInt32BE(b.length); return Buffer.concat([len, b]); };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const S = (s) => str(Buffer.from(s, 'utf8'));

const pubBlob = Buffer.concat([S('ssh-ed25519'), str(pub)]);
const check = crypto.randomBytes(4);
const priv64 = Buffer.concat([seed, pub]);                 // OpenSSH 里的私钥段是 seed||pub（64 字节）
let privSection = Buffer.concat([
  check, check, S('ssh-ed25519'), str(pub), str(priv64), S(comment),
]);
// 私钥段按 8 字节对齐填充：1,2,3,...（每个字节的值就是序号）
const padLen = (8 - (privSection.length % 8)) % 8;
if (padLen) {
  const pad = Buffer.alloc(padLen);
  for (let i = 0; i < padLen; i++) pad[i] = i + 1;
  privSection = Buffer.concat([privSection, pad]);
}
const container = Buffer.concat([
  Buffer.from('openssh-key-v1\0', 'utf8'),
  S('none'),            // ciphername（无口令）
  S('none'),            // kdfname
  S(''),                // kdfoptions
  u32(1),               // 密钥数
  str(pubBlob),
  str(privSection),
]);
const b64 = container.toString('base64').replace(/(.{70})/g, '$1\n').replace(/\n$/, '');
const privText = `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`;
const pubText = `ssh-ed25519 ${pubBlob.toString('base64')} ${comment}\n`;

fs.mkdirSync(path.dirname(privPath), { recursive: true });
fs.writeFileSync(privPath, privText, { mode: 0o600 });
fs.writeFileSync(pubPath, pubText, { mode: 0o644 });

console.log('已生成：');
console.log('  私钥（留本机，不要外传）: ' + privPath);
console.log('  公钥（贴到 GitHub）      : ' + pubPath);
console.log('\n公钥内容（整行复制）：');
console.log(pubText.trim());
