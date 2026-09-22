// 标准规范引用（R8）—— 自检（纯离线，零 API 调用）
//
// 为什么需要：R8 是"拿编号去核就能确认"的纯代码规则，最容易出**误报**——
// 实测第一版把「财政部公告2020年第23号」判成"编号格式不符"，还把报告里
// 11 项法规/制度全报成"未列入依据清单"，一条真问题淹没在噪声里。
// 这个文件把当时踩过的坑全部钉成断言。
//
// 用法：node engine/test-standards.mjs
import { stage3Rules } from './lib/pipeline.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  ' + extra}`);
  cond ? pass++ : fail++;
};
const run = (standardsCited) => stage3Rules({ facts: { standardsCited }, log: () => {} })
  .filter(x => x.category === '标准规范');
const allText = (list) => list.map(x => x.description + x.quote).join(' ');

console.log('【1】真标准编号的各类毛病，逐项都要能抓到');
let r = run([
  { name: '建筑设计防火规范', code: 'GB 50016-201X', year: '', location: '3.2', inBasisList: true },  // 年号写成 201X
]);
ok('编号写法错误能被抓到', r.length === 1 && /编号写法/.test(r[0].description), JSON.stringify(r.map(x => x.description)));

r = run([
  { name: '石油天然气工程设计防火规范', code: 'GB 50183', year: '', location: '2.1', inBasisList: true },
]);
ok('缺年号能被抓到', r.length === 1 && /未标注年号/.test(r[0].description), JSON.stringify(r.map(x => x.description)));

r = run([
  { name: '石油天然气工程设计防火规范', code: 'GB 50183', year: '', location: '2.1', inBasisList: true },
  { name: '石油天然气工程设计防火规范', code: 'GB50183-2004', year: '2004', location: '5.3', inBasisList: true },
]);
ok('同一标准多种写法能被抓到', r.some(x => /多种写法/.test(x.description)), JSON.stringify(r.map(x => x.description)));

r = run([
  { name: '建筑设计防火规范', code: 'GB 50016-2014', year: '2014', location: '2.1', inBasisList: true },
  { name: '火灾自动报警系统设计规范', code: 'GB 50116-2013', year: '2013', location: '2.2', inBasisList: false },
]);
ok('正文引用但未入清单能被抓到', r.length === 1 && /未列入/.test(r[0].description), JSON.stringify(r.map(x => x.description)));

console.log('\n【2】★ 误报防线：法规/公告/制度不能拿标准编号格式去套');
r = run([
  { name: '关于延续西部大开发企业所得税政策的公告', code: '财政部公告2020年第23号', year: '2020', location: '3.2.3', inBasisList: true },
  { name: '中华人民共和国环境保护法', code: '', year: '2015', location: '4.1.2', inBasisList: true },
  { name: '中国石化固定资产投资决策程序及管理办法', code: '', year: '', location: '1.2.1', inBasisList: true },
]);
ok('法规/公告一律不报"编号写法错误"', !r.some(x => /编号写法/.test(x.description)), JSON.stringify(r.map(x => x.description)));
ok('法规/公告一律不报"缺年号"', !r.some(x => /未标注年号/.test(x.description)), JSON.stringify(r.map(x => x.description)));
ok('全部入了清单就不报清单类问题', r.length === 0, JSON.stringify(r.map(x => x.description)));

console.log('\n【3】没有集中依据清单时，报一条而不是报 N 条');
r = run(Array.from({ length: 11 }, (_, i) => ({
  name: `依据文件${i + 1}`, code: '', year: '', location: `${i + 1}.1`, inBasisList: false,
})));
ok('只报 1 条聚合问题', r.length === 1, '实际 ' + r.length + ' 条');
ok('措辞是"未见集中列示的清单"', /未见集中列示/.test(r[0].description), r[0]?.description);

console.log('\n【4】干净数据必须零命中（宁可不报，不可误报）');
r = run([
  { name: '建筑设计防火规范', code: 'GB 50016-2014', year: '2014', location: '2.1', inBasisList: true },
  { name: '火灾自动报警系统设计规范', code: 'GB/T 50116-2013', year: '2013', location: '2.2', inBasisList: true },
  { name: '石油天然气工程设计防火规范', code: 'GB 50183-2004', year: '2004', location: '2.3', inBasisList: true },
]);
ok('规范引用零命中', r.length === 0, JSON.stringify(r.map(x => x.description)));

console.log('\n【5】老数据（字符串数组）不能崩，也不能误判');
r = run(['《建设工程项目档案管理规范》', '《石油化工建设工程项目交工技术文件规定》']);
ok('字符串条目零命中（无编号无从判格式）', r.length === 0, JSON.stringify(r.map(x => x.description)));
ok('空数组不崩', run([]).length === 0);
ok('字段缺失不崩', run([{ name: 'x' }, null, undefined].filter(Boolean)).length === 0);

console.log('\n【6】定级铁律：标准规范永远是 P1，绝不 P0');
const grading = run([
  { name: '建筑设计防火规范', code: 'GB 50016-201X', year: '', location: '3.2', inBasisList: true },
  { name: '石油天然气工程设计防火规范', code: 'GB 50183', year: '', location: '2.1', inBasisList: false },
]);
ok('全部给 P1', grading.every(x => x.severity_hint === 'P1'), JSON.stringify(grading.map(x => x.severity_hint)));
ok('whitelist 一律为 null（不占 P0 名额）', grading.every(x => x.whitelist === null));

console.log(`\n${fail === 0 ? '全部通过' : '存在失败'}：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
