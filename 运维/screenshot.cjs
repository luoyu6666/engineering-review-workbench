/**
 * 界面截图工具（运维用，不参与线上服务）
 * ────────────────────────────────────────────────────────────────
 * 用途：界面改动后实际渲染一次以确认效果。经验证，上一轮改版靠它发现
 *       「两个选项不等宽」「台账列折行」两个视觉问题。
 *
 * 原理：用管理员账号登录取得 session，再通过 CDP 把 sid 注入 Chrome，
 *       然后按标签页逐个截图。不修改产品代码，也不在产品代码里留任何后门。
 *
 * 用法：
 *   node 运维\screenshot.cjs [输出目录] [配置.json]
 * 配置.json（不传则截一张提交页）：
 *   [
 *     {"name":"01-submit","tab":"submit"},           // tab: submit|tasks|stats|admin
 *     {"name":"02-lower","tab":"submit","scroll":420},
 *     {"name":"03-open","tab":"tasks","open":1},     // open: 打开台账第 N 条详情
 *     {"name":"04-wide","tab":"stats","w":1920,"h":1080},
 *     {"name":"05-user","tab":"stats","as":"赵六"}  // as: 换普通用户看权限差异
 *   ]
 *
 * 密码：默认取初始密码 123456。已改密码的账号需通过环境变量提供，命令行 JSON 中不写密码：
 *   $env:DSH_SHOT_PWD_ADMIN = '你的新密码'
 *   $env:DSH_SHOT_PWD_张三    = '...'
 * 取不到密码时会报错并提示设置方式，不会静默失败。
 *
 * WARN: 只在本机运行；截图可能含真实项目名称，输出目录不得外发。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 可用 WB_BASE 指向别的实例（本地验证时另起影子实例，不影响正在提供服务的实例）
const BASE = process.env.WB_BASE || 'http://127.0.0.1:8787';
const PORT = 9223;
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const outDir = process.argv[2] || path.join(__dirname, '预览');
  const cfgPath = process.argv[3];
  fs.mkdirSync(outDir, { recursive: true });
  const shots = (cfgPath && fs.existsSync(cfgPath))
    ? JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    : [{ name: 'submit', tab: 'submit' }];

  const chromePath = CHROME_CANDIDATES.find(p => fs.existsSync(p));
  if (!chromePath) throw new Error('没找到 Chrome / Edge，无法截图');
  console.log('浏览器:', chromePath);

  // 按用户分组登录（默认管理员）
  // 密码：优先取环境变量 DSH_SHOT_PWD_<用户名>，其次退回初始密码 123456。
  // 不把密码写进配置文件，避免跟着脚本一起被复制外传。
  const pwdFor = (name) => process.env['DSH_SHOT_PWD_' + name] || process.env.DSH_SHOT_PWD || '123456';
  const cookies = {};
  const who = [...new Set(shots.map(s => s.as || 'admin'))].filter(u => u !== null);
  // noAuth: true 的条目不需要登录（例如截登录页本身），跳过登录取 cookie
  const needLogin = shots.some(s => !s.noAuth);
  if (!needLogin) console.log('本次全部为免登录截图，跳过登录');
  for (const u of (needLogin ? who : [])) {
    const r = await fetch(BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: pwdFor(u) }),
    });
    if (!r.ok) {
      throw new Error(`登录 ${u} 失败（HTTP ${r.status}）。`
        + `如果这个账号改过密码，先设环境变量再跑：$env:DSH_SHOT_PWD_${u} = '密码'`);
    }
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')];
    const sid = sc.map(c => c.split(';')[0]).find(c => c.startsWith('sid='));
    if (!sid) throw new Error(`登录 ${u} 没拿到 sid`);
    cookies[u] = sid.split('=')[1];
    console.log(`已登录 ${u}`);
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cdp-'));
  const chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1440,980', 'about:blank',
  ], { stdio: 'ignore' });

  let ver = null;
  for (let i = 0; i < 50; i++) {
    await sleep(300);
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch {}
  }
  if (!ver) { chrome.kill(); throw new Error('浏览器调试端口没起来'); }

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page');
  if (!page) { chrome.kill(); throw new Error('没有可用的 page target'); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let mid = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++mid;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  });
  await new Promise(r => ws.addEventListener('open', r));
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');

  try {
    for (const s of shots) {
      await send('Network.clearBrowserCookies');
      if (!s.noAuth) {
        const sid = cookies[s.as || 'admin'];
        await send('Network.setCookie', { name: 'sid', value: sid, domain: '127.0.0.1', path: '/' });
      }
      await send('Emulation.setDeviceMetricsOverride', {
        width: s.w || 1440, height: s.h || 980, deviceScaleFactor: 1, mobile: false,
      });
      // s.url：直接打开任意页面（如本地生成的宣传稿 file:///...）
      // 用途：把静态 HTML 渲染成图（宣传图、海报）。
      // 注意：s.url 与 s.open 含义不同 —— s.open 表示打开列表中的某条详情，不是打开网址。
      // 此前有四条配置误写为 open:"file:///..."，结果全部截成默认页面，四张图字节完全相同。
      await send('Page.navigate', { url: s.url || (BASE + '/') });
      await sleep(s.url ? 1400 : 2400);
      if (s.tab) {
        await send('Runtime.evaluate', {
          expression: `document.querySelector('nav button[data-tab="${s.tab}"]').click()`,
        });
        await sleep(2800);
      }
      if (s.scroll !== undefined) {
        await send('Runtime.evaluate', { expression: `window.scrollTo(0, ${s.scroll})` });
        await sleep(600);
      }
      if (s.open) {
        // 打开台账里第 N 条任务的详情（默认第 1 条）
        await send('Runtime.evaluate', {
          expression: `document.querySelectorAll('#taskList table tbody tr')` +
            `[${(s.open === true ? 1 : s.open) - 1}].querySelector('button').click()`,
        });
        await sleep(2600);
        if (s.scroll !== undefined) {
          await send('Runtime.evaluate', { expression: `window.scrollTo(0, ${s.scroll})` });
          await sleep(500);
        }
      }
      if (s.js) {
        // 任意回退脚本，用于工具未覆盖的场景
        await send('Runtime.evaluate', { expression: s.js });
        await sleep(s.jsWait || 1500);
      }
      // s.rects：{ 名称: 返回元素的 JS 表达式 } → 输出同名 .rects.json
      //
      // 用途：为操作说明做圈注时，手写像素坐标容易偏移（改动一句文案即整体错位）。
      //   截图只覆盖视口（Page.captureScreenshot 不带 captureBeyondViewport），
      //   而 getBoundingClientRect() 返回的正是视口相对坐标，两者 1:1 对应，
      //   因此这里量出的坐标可直接用于图上绘制；界面改版后重新执行一次即可。
      if (s.rects) {
        const got = {};
        for (const [key, expr] of Object.entries(s.rects)) {
          try {
            const rr = await send('Runtime.evaluate', {
              expression: `(()=>{const el=(${expr});if(!el)return null;`
                + `const r=el.getBoundingClientRect();`
                + `return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};})()`,
              returnByValue: true,
            });
            got[key] = (rr && rr.result && rr.result.value) || null;
          } catch { got[key] = null; }
        }
        fs.writeFileSync(path.join(outDir, s.name + '.rects.json'), JSON.stringify(got, null, 2), 'utf8');
        const miss = Object.entries(got).filter(([, v]) => !v).map(([k]) => k);
        if (miss.length) console.log('    ⚠️ 没量到的元素：' + miss.join('、'));
      }
      const r = await send('Page.captureScreenshot', { format: 'png' });
      const f = path.join(outDir, s.name + '.png');
      fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
      console.log('  →', f, Math.round(fs.statSync(f).size / 1024) + ' KB');
    }
  } finally {
    ws.close();
    chrome.kill();
    await sleep(600);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
  console.log('完成');
}

main().catch(e => { console.error('失败:', e.message); process.exit(1); });
