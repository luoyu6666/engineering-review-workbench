/**
 * 一次性复验（经实测）：结构性修复后，搜索框是否还会被自动刷新替换（用真 Chrome + CDP）。
 * 用法：node 运维\复验-中文输入.mjs   （用完即删）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9334;
const APP = 'http://127.0.0.1:8787/';
const profile = path.join(os.tmpdir(), 'dsh-ime2-' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const lr = await fetch(APP + 'api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8' },
  body: JSON.stringify({ username: '罗玉', password: '123456' }),
});
const cookie = (lr.headers.getSetCookie ? lr.headers.getSetCookie() : []).map((c) => String(c).split(';')[0]).join('; ');

const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, '--headless=new', '--no-first-run', '--disable-gpu', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
let wsUrl = '';
for (let i = 0; i < 40; i++) { await sleep(400); try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; if (wsUrl) break; } catch { /* 等待 */ } }
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pend = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}, sessionId) => new Promise((res) => { const mid = ++id; pend.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) })); });

const t = await send('Target.createTarget', { url: 'about:blank' });
const at = await send('Target.attachToTarget', { targetId: t.result.targetId, flatten: true });
const S = at.result.sessionId;
await send('Page.enable', {}, S); await send('Runtime.enable', {}, S); await send('Network.enable', {}, S);
await send('Network.setCookie', { name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), domain: '127.0.0.1', path: '/' }, S);
await send('Page.navigate', { url: APP }, S);
await sleep(3500);
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, S); return r.result && r.result.result ? r.result.result.value : '（异常）'; };

await ev(`(() => { const els=[...document.querySelectorAll('a,button,div')].filter(x=>(x.textContent||'').trim()==='审核台账'); if(els.length) els[els.length-1].click(); return 1; })()`);
await sleep(2500);
console.log('  版本号显示：' + await ev(`(document.getElementById('uiBuild')||{}).textContent`));
console.log('  搜索框父级：' + await ev(`(() => { const el=document.getElementById('taskQ'); return el ? el.parentElement.id : '找不到 #taskQ'; })()`));

// 标记节点 + 挂组字事件日志
await ev(`(() => {
  const el = document.getElementById('taskQ');
  el.__diagMark = 'mk-' + Math.random().toString(36).slice(2, 7);
  window.__log = [];
  ['compositionstart','compositionupdate','compositionend'].forEach(k => document.addEventListener(k, (e) => window.__log.push(k + (e.data ? ':' + e.data : '')), true));
  el.focus();
  return 1;
})()`);
console.log('  标记 = ' + await ev(`document.getElementById('taskQ').__diagMark`));

// 保持组字状态，跨越一个刷新周期（15 秒）观察
await send('Input.imeSetComposition', { text: '塔河油', selectionStart: 3, selectionEnd: 3 }, S);
console.log('\n  【保持组字状态，观察 21 秒（跨越自动刷新周期）】');
for (let i = 0; i < 7; i++) {
  await sleep(3000);
  console.log('   t=' + (i * 3 + 3) + 's  ' + await ev(`(() => {
    const el = document.getElementById('taskQ');
    return JSON.stringify({ 标记: el ? (el.__diagMark || '（新节点，标记已丢失）') : '节点不存在', value: el ? el.value : '', 焦点: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : '无' });
  })()`));
}
console.log('\n  组字事件日志：' + await ev(`JSON.stringify(window.__log)`));
await send('Input.insertText', { text: '塔河油田' }, S);
await sleep(800);
console.log('  提交后 value = ' + JSON.stringify(await ev(`document.getElementById('taskQ').value`)) + '，过滤行数 = ' + await ev(`document.querySelectorAll('#taskList tbody tr').length`));

chrome.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(0);
