// 取消任务的竞态回归测试
//
// ⚠️ 这个测试需要**服务正在运行**（它走 HTTP 接口），和其它三个纯离线自检不同。
//
// 为什么必须留着它：这里踩过一个不会报错、只会悄悄花钱的竞态 ——
//   用户提交后立刻点「取消」，取消请求确实成功了（HTTP 200，盘上状态写成 cancelled），
//   但 runTask 手里攥着几分钟前读进内存的 task 对象，之后每一次
//   `L.saveTask(task)`（尤其是写进度日志那一下）都把 cancelled 覆盖回 converting，
//   于是「取消了还在跑」，甚至照常调 AI 花钱。
//   修法是两条：① appendProgress 合并到盘上最新副本；② runTask 内改用受保护的 save()。
//
// 用法：node engine/test-cancel.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from '../web/lib.mjs';

const base = 'http://127.0.0.1:8787';
const FILE = process.env.TEST_DOC
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '测试样本', '可研_江汉压裂设备购置.doc');

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { console.log(`  ${c ? '✓' : '✗'} ${n}${c ? '' : '  ' + e}`); c ? pass++ : fail++; };

// 自愈：上次跑如果因为时序原因留下残留（取消是异步的，服务端可能晚一步写盘），
// 开局先扫掉，否则残留的 duplicate-suspect 会在台账里显示成"有 1 条待确认"，
// 让人以为有真任务在等处理。
{
  const fsx = (await import('node:fs')).default;
  const junk = L.listTasks().filter(t => String(t.sourceName || '').startsWith('__'));
  for (const t of junk) { try { fsx.rmSync(L.taskDir(t.id), { recursive: true, force: true }); } catch { } }
  if (junk.length) console.log(`  （开局清理上次残留的测试任务 ${junk.length} 个）`);
}

const ids = [];
// ⚠️ 不要写死用户名：账号会被停用、角色会变（比如把某个账号提升为管理员），
//    写死会让测试以"登录失败"的形式挂掉，看起来像产品坏了，其实是测试太脆。
//    这里动态挑一个**已启用**的账号来提交。
const enabled = L.listUsers().filter(u => !u.disabled);
const submitter = enabled.find(u => u.role !== 'admin' && u.deepAccess)
  || enabled.find(u => u.role !== 'admin')
  || enabled[0];
if (!submitter) { console.log('  ✗ 没有已启用的账号，无法测试'); process.exit(1); }

// 跨用户 403 需要一个**非管理员的第二人**。环境里可能一个都没有
// （比如把账号都升成管理员、或只剩一个可用账号），那就临时造一个、测完删掉。
// 否则这条覆盖会静悄悄地消失 —— 实测踩过：甲专家升管理员后断言数从 9 掉到 7，
// 而输出仍显示"全部通过"，不盯着数就对不上了。
const TMPUSER = { username: '__tmp_cancel_probe', name: '__临时测试', password: 'tmp-probe-9f3a' };
let tempUserId = null;
let other = enabled.find(u => u.id !== submitter.id && u.role !== 'admin');
if (!other) {
  const nu = L.createUser({ username: TMPUSER.username, password: TMPUSER.password, name: TMPUSER.name, role: 'user' });
  tempUserId = nu.id;
  other = L.listUsers().find(u => u.id === nu.id);
  console.log('  （环境里没有第二个普通账号，已临时建一个用于权限测试）');
}
console.log(`  提交人: ${submitter.username}`);
console.log(`  他人  : ${other ? other.username : '（无）'}`);

// 密码：测试环境约定 123456；临时账号用自己设的；若改过则读环境变量
const pwOf = (u) => (u.id === tempUserId ? TMPUSER.password
  : (process.env['DSH_TEST_PWD_' + u.username] || '123456'));
const login = async (u) => {
  const r = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u.username, password: pwOf(u) }),
  });
  if (!r.ok) throw new Error(`登录 ${u.username} 失败（HTTP ${r.status}）—— 服务在跑吗？密码改过吗？（可设 DSH_TEST_PWD_${u.username}）`);
  return (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')]).map(x => x.split(';')[0]).join('; ');
};

try {
  const ce = await login(submitter);

  console.log('【1】提交后**立刻**取消 —— 复现原来的竞态窗口');
  const r = await fetch(base + '/api/tasks', {
    method: 'POST',
    headers: { cookie: ce, 'X-File-Name': encodeURIComponent('__竞态回归测试.doc'), 'X-Audit-Mode': 'immediate' },
    body: fs.readFileSync(FILE),
  });
  const sub = await r.json();
  if (!sub.id) throw new Error('提交失败：' + JSON.stringify(sub));
  ids.push(sub.id);
  console.log(`     提交 HTTP ${r.status}  id=${sub.id}`);

  const rc = await fetch(`${base}/api/tasks/${sub.id}/cancel`, { method: 'POST', headers: { cookie: ce } });
  console.log(`     立刻取消 HTTP ${rc.status} ${JSON.stringify(await rc.json())}`);
  ok('提交后立刻可以取消（converting 阶段允许取消）', rc.status === 200, `HTTP ${rc.status}`);

  console.log('     盯 20 秒，看状态会不会被 runTask 覆盖回去…');
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    await new Promise(s => setTimeout(s, 1000));
    const t = L.getTask(sub.id);
    if (!t) break;
    seen.add(t.status);
  }
  const final = L.getTask(sub.id);
  console.log(`     期间出现过的状态: ${[...seen].join(' → ') || '（无）'}`);
  console.log(`     最终状态: ${final ? final.status : '（已删除）'}`);
  ok('状态保持 cancelled，没有被复活', final && final.status === 'cancelled', final && final.status);
  ok('没有产生 API 费用', !final || !final.cost, `cost=${final && final.cost}`);
  ok('没有生成审核成果', !fs.existsSync(`${L.taskDir(sub.id)}/report.html`));

  console.log('\n【2】预处理要能跑通 —— 守住"提交就崩"这类不报错的故障');
  // ⚠️ 为什么单独测这个：曾经 save() 被批量正则改成了自我调用（栈溢出），
  //    语法检查发现不了（合法递归），任务全部卡在 queued 反复重跑、界面上只显示"排队中"。
  //    只测"能不能取消"是抓不到的——任务崩了照样能取消。必须验证文档解析真的完成。
  {
    const r = await fetch(base + '/api/tasks', {
      method: 'POST',
      headers: { cookie: ce, 'X-File-Name': encodeURIComponent('__预处理回归测试.doc'), 'X-Audit-Mode': 'immediate' },
      body: fs.readFileSync(FILE),
    });
    const sub = await r.json();
    if (sub.id) {
      ids.push(sub.id);
      let t = null, done = false;
      for (let i = 0; i < 24; i++) {          // 最多等 48 秒（大文档转换要十几秒）
        await new Promise(s => setTimeout(s, 2000));
        t = L.getTask(sub.id);
        if (!t) break;
        if (t.preprocessedAt) { done = true; break; }                     // 解析成功
        if (['failed', 'cancelled', 'duplicate-suspect'].includes(t.status)) break;
      }
      console.log(`     解析结果: preprocessedAt=${t && t.preprocessedAt ? '已设置' : '未设置'}  `
        + `status=${t && t.status}  字符=${(t && t.convertedChars) || 0}`);
      if (t && t.error) console.log(`     error=${t.error}`);
      ok('文档预处理跑通（没在早期阶段崩掉）', done, t ? `status=${t.status} error=${t.error || '—'}` : '任务消失');
      ok('解析出了正文（字符数 > 1000）', !!(t && t.convertedChars > 1000), `chars=${t && t.convertedChars}`);
      ok('没有出现栈溢出类错误', !(t && /call stack/i.test(t.error || '')), t && t.error);
      // 让它停下来，别真的花钱调 AI
      if (t && !['done', 'failed', 'cancelled'].includes(t.status)) {
        await fetch(`${base}/api/tasks/${sub.id}/cancel`, { method: 'POST', headers: { cookie: ce } });
      }
    } else { ok('文档预处理跑通', false, JSON.stringify(sub)); }
  }

  console.log('\n【3】权限与状态守卫');
  const done = L.listTasks().find(t => t.status === 'done');
  const rd = await fetch(`${base}/api/tasks/${done.id}/cancel`, { method: 'POST', headers: { cookie: ce } });
  console.log(`     取消已完成任务 → HTTP ${rd.status}`);
  ok('已完成任务不可取消', rd.status === 400, `HTTP ${rd.status}`);

  if (other) {
    // 造一条「可取消」的任务归 submitter，让 another 用户去取消 —— 应 403
    const otherTask = `T-CANCELROLE-${Date.now().toString(36)}`;
    L.saveTask({
      id: otherTask, owner: submitter.id, ownerName: submitter.name,
      sourceName: '__权限测试.doc', status: 'waiting', mode: 'idle',
      createdAt: new Date().toISOString(), preprocessedAt: new Date().toISOString(),
      apiStartAt: new Date(Date.now() + 3600e3).toISOString(), progress: [],
    });
    ids.push(otherTask);
    const co = await login(other);
    const r3 = await fetch(`${base}/api/tasks/${otherTask}/cancel`, { method: 'POST', headers: { cookie: co } });
    const b3 = await r3.json().catch(() => ({}));
    console.log(`     ${other.username} 取消 ${submitter.username} 的 waiting 任务 → HTTP ${r3.status}`);
    ok('普通用户不能取消他人任务（403）', r3.status === 403, `HTTP ${r3.status} ${JSON.stringify(b3)}`);
    ok('他人取消后任务状态未被改动', L.getTask(otherTask).status === 'waiting', L.getTask(otherTask).status);
  } else {
    console.log('     （跳过跨用户用例：没有第二个已启用账号）');
  }

  console.log('\n【4】队列名额口径：waiting 不占就绪名额');
  const d = await (await fetch(base + '/api/tasks/' + done.id, { headers: { cookie: ce } })).json();
  ok('详情接口下发分类队列统计', !!(d.queue && typeof d.queue.ready === 'number'), JSON.stringify(d.queue));
  ok('就绪与等待闲时上限分开', d.queue && d.queue.maxReady === 30 && d.queue.maxWaiting === 100, JSON.stringify(d.queue));
} catch (e) {
  console.log(`  ✗ 异常：${e.message}`);
  fail++;
} finally {
  // ⚠️ 删之前要**等到终态**：取消是走 HTTP 的，而 runTask 可能还在转换中，
  //    会晚一步把 meta.json 写回去 —— 固定等 1.5 秒不够（实测仍残留），必须轮询确认。
  for (const id of ids) {
    for (let i = 0; i < 20; i++) {
      const t = L.getTask(id);
      if (!t || ['done', 'failed', 'cancelled'].includes(t.status)) break;
      await new Promise(s => setTimeout(s, 500));
    }
    try { fs.rmSync(L.taskDir(id), { recursive: true, force: true }); } catch { }
  }
  // 删掉临时造的测试账号
  if (tempUserId) {
    L.saveUsers(L.listUsers().filter(u => u.id !== tempUserId));
    L.purgeDisabledSessions();
    console.log(`已清理临时测试账号 ${TMPUSER.username}`);
  }
  console.log(`已清理 ${ids.length} 个测试任务`);
  console.log(`${fail === 0 ? '全部通过' : '存在失败'}：通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}
