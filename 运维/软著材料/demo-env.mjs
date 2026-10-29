/**
 * 软著申报材料 ③：一键演示环境
 *
 * 用途（2026-09-28: 确认申报软著是否需要现场运行演示）：
 *   · 软著登记本身是形式审查，不需要演示；
 *   · 但补正环节需要连贯的操作截图，软件产品评估/高企认定/成果评价/项目验收等场合需要现场看运行；
 *   · 因此必须能随时开出一套"可运行、界面完整、且不接触生产数据"的演示环境。
 *
 * 做法：用独立的临时数据目录（合成示例数据，无任何真实项目与真实姓名）+ 独立端口（默认 8799）
 * 启动一个影子实例，生产数据目录 web/data 与 8787 端口都不受影响。
 *
 * 用法：
 *   node 运维\软著材料\demo-env.mjs                 # 首次会建演示数据，然后启动（Ctrl+C 停止）
 *   node 运维\软著材料\demo-env.mjs --reset         # 重建演示数据（干净状态）
 *   node 运维\软著材料\demo-env.mjs --prepare-only  # 只准备数据、不启动
 *   node 运维\软著材料\demo-env.mjs --port 8899     # 换端口
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (n, d) => (argv.includes(n) ? String(argv[argv.indexOf(n) + 1]) : d);

const PORT = Number(arg('--port', process.env.DEMO_PORT || 8799));
const DATA_DIR = arg('--data', path.join(ROOT, '演示环境', 'data'));
const RESET = has('--reset');
const PREPARE_ONLY = has('--prepare-only');

// 演示账号（都是合成账号，与生产账号无关）
// 管理员用户名用 `admin`：与系统首次启动创建的管理员同名，也便于截图管线（运维\screenshot.cjs）默认登录口径。
const ADMIN = { username: 'admin', name: '演示管理员', password: 'Demo@2026', role: 'admin' };
const STAFF = { username: 'liugong', name: '刘工', password: 'Demo@2026', role: 'user' };

if (RESET && fs.existsSync(DATA_DIR)) { fs.rmSync(DATA_DIR, { recursive: true, force: true }); console.log('已清空旧演示数据'); }

if (!fs.existsSync(path.join(DATA_DIR, 'users.json'))) {
  console.log('准备演示数据：' + DATA_DIR);
  process.env.WB_DATA_DIR = DATA_DIR;
  // 注意：动态 import 必须用 file:// URL：Windows 绝对路径（D:\…）会报 ERR_UNSUPPORTED_ESM_URL_SCHEME
  const L = await import(pathToFileURL(path.join(ROOT, 'web', 'lib.mjs')).href);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  L.saveUsers([]);
  L.createUser(ADMIN);
  L.createUser(STAFF);
  // 合成示例任务（虚构项目名、虚构问题，走真实渲染管线）—— 与《操作说明》用的是同一套素材生成器
  try {
    execFileSync(process.execPath, [path.join(ROOT, '运维', 'staff-guide', 'demo-data.mjs'), DATA_DIR, STAFF.name],
      { stdio: 'inherit', env: { ...process.env, WB_DATA_DIR: DATA_DIR } });
  } catch (e) {
    console.error('示例任务生成失败（不影响演示环境启动）：' + e.message);
  }
  console.log('演示数据已就绪');
} else {
  console.log('复用已有演示数据：' + DATA_DIR + '（要重来加 --reset）');
}

console.log(`
═══════════════════════════════════════════════════
  演示环境（影子实例 · 不含任何真实数据）
───────────────────────────────────────────────────
  访问地址    http://127.0.0.1:${PORT}
  管理员账号  ${ADMIN.username} / ${ADMIN.password}
  员工账号    ${STAFF.username} / ${STAFF.password}
  数据目录    ${DATA_DIR}   ← 与生产 web/data 完全隔离
  生产端口    8787（本实例用 ${PORT}，互不影响）
═══════════════════════════════════════════════════
`);

if (PREPARE_ONLY) { console.log('已按 --prepare-only 结束（未启动服务）'); process.exit(0); }

const child = spawn(process.execPath, [path.join(ROOT, 'web', 'server.mjs')], {
  cwd: path.join(ROOT, 'web'),
  env: { ...process.env, WB_DATA_DIR: DATA_DIR, PORT: String(PORT) },
  stdio: 'inherit',
});
console.log('服务已启动（Ctrl+C 停止）。演示完记得关掉，别长期占着端口。');
process.on('SIGINT', () => { child.kill(); process.exit(0); });
