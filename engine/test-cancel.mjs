// 取消任务的竞态回归测试
//
// 本测试需要服务正在运行（走 HTTP 接口），与其他纯离线自检不同。
//
// 保留原因：存在一个不报错、只产生费用的竞态 ——
//   提交后立即请求「取消」，取消请求成功（HTTP 200，盘上状态写成 cancelled），
//   但 runTask 持有数分钟前读入内存的 task 对象，此后每次
//   `L.saveTask(task)`（尤其是写进度日志那次）都把 cancelled 覆盖回 converting，
//   导致"已取消仍在运行"，并继续调用 AI 产生费用。
//   修法两条：① appendProgress 合并到盘上最新副本；② runTask 内改用受保护的 save()。
//
// 用法：node engine/test-cancel.mjs
import fs from 'node:fs';
import * as L from '../web/lib.mjs';

const base = 'http://127.0.0.1:8787';
const FILE = 'D:\\Deepseek harness工作区\\生活其他\\审核工作台\\测试样本\\可研_江汉压裂设备购置.doc';

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { console.log(`  ${c ? '✓' : '✗'} ${n}${c ? '' : '  ' + e}`); c ? pass++ : fail++; };

// 自愈：上一次运行若因时序原因留下残留（取消是异步的，服务端可能晚一步写盘），
// 开局先清理，否则残留的 duplicate-suspect 会在台账里显示成"有 1 条待确认"，
// 被误认为有真实任务待处理。
{
  const fsx = (await import('node:fs')).default;
  const junk = L.listTasks().filter(t => String(t.sourceName || '').startsWith('__'));
  for (const t of junk) { try { fsx.rmSync(L.taskDir(t.id), { recursive: true, force: true }); } catch { } }
  if (junk.length) console.log(`  （开局清理上次残留的测试任务 ${junk.length} 个）`);
}

const ids = [];
// 不写死用户名：账号会被停用、角色会变（例如某个账号被提升为管理员），
//    写死会使测试以"登录失败"的形式失败，表面像产品缺陷，实为测试用例过于脆弱。
//    这里动态挑一个已启用的账号来提交。
const enabled = L.listUsers().filter(u => !u.disabled);
// 并且优先挑「初始密码未改」的 —— 只要选中一个改过密码的账号，
//    测试就会以"登录失败"的形式失败，表面像产品缺陷，实为测试用例过于脆弱。
//    （经实测：账号改密码后 test-cancel 直接 0/1）
// 测试账号：优先用「审核专家」张三（管理员 + 深度权限，最稳定）。
//    张三被停用或改密码时不能使测试失败，因此保留降级路径：自动挑一个初始密码账号。
//    写死用户名的风险：账号改名、改密码、提升角色都会使测试以"登录失败"的形式失败，
//    表面像产品缺陷，实为测试用例过于脆弱。
const TEST_USER = process.env.DSH_TEST_USER || '';   // 不写死账号：留空则由下面按角色动态选取
// 只挑"能本机登录"的账号：已绑定 IP 的账号从本机（127.0.0.1）登录会被访问控制拒绝，
// 选中它会让测试以"登录失败"的形式失败，看起来像产品缺陷。
const usable = enabled.filter(u => (u.defaultPassword || process.env['DSH_TEST_PWD_' + u.username])
  && !(u.allowedIps || []).length);
const submitter = enabled.find(u => u.username === TEST_USER && u.defaultPassword)
  || usable.find(u => u.username === TEST_USER)
  || usable.find(u => u.role !== 'admin' && u.deepAccess)
  || usable.find(u => u.role !== 'admin')
  || usable[0]
  || enabled[0];
if (!submitter) { console.log('  ✗ 没有已启用的账号，无法测试'); process.exit(1); }

// 跨用户 403 需要一个非管理员的第二人。环境里可能一个都没有
// （例如账号都被升成管理员、或只剩一个可用账号），此时临时创建一个、测完删除。
// 否则这条覆盖会静默消失 —— 经实测：张三升管理员后断言数从 9 掉到 7，
// 而输出仍显示"全部通过"，不核对断言数无法发现。
const TMPUSER = { username: '__tmp_cancel_probe', name: '__临时测试', password: 'tmp-probe-9f3a' };
let tempUserId = null;
let other = usable.find(u => u.id !== submitter.id && u.role !== 'admin');
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
  // 单独测这一项的原因：save() 曾被批量正则改成自我调用（栈溢出），
  //    语法检查发现不了（合法递归），任务全部卡在 queued 反复重跑、界面上只显示"排队中"。
  //    只测"能不能取消"发现不了 —— 任务崩溃时同样能取消。必须验证文档解析确实完成。
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
      // 使其停止，避免真实调用 AI 产生费用
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
    // 造一条「可取消」的任务归 submitter，由 another 用户去取消 —— 应 403
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
  // 删除前必须等到终态：取消走 HTTP，而 runTask 可能仍在转换中，
  //    会晚一步把 meta.json 写回 —— 固定等待 1.5 秒不足（经实测仍残留），必须轮询确认。
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
