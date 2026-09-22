// 计费时段与调度的自检（纯离线，零 API 调用）。
//
// 为什么需要这个测试：高峰/空闲判定曾经因为一个时区转换 bug 全线失效——
// 本机是 UTC+8，旧写法 `(getTimezoneOffset() + 480)` 把偏移抵消成 0，
// 再把结果用 UTC 访问器去读，于是北京时间 15:50 被读成 7:50，
// 高峰被判成空闲：费用按半价少算一半，「闲时审核」也永远不会真正推迟。
// 这个 bug 不会抛错、不会写日志，只会悄悄算错钱，所以必须有断言守着。
//
// 用法：node engine/test-timing.mjs
import * as L from '../web/lib.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`}`);
  ok ? pass++ : fail++;
};

// 造一个「北京墙上时间」对应的真实时刻（本机时区无关）
const at = (bjText) => {
  const [date, time] = bjText.split(' ');
  const [Y, M, D] = date.split('-').map(Number);
  const [h, m] = time.split(':').map(Number);
  return new Date(Date.UTC(Y, M - 1, D, h, m) - L.BJ_OFFSET_MIN * 60000);
};

console.log('本机时区偏移：', new Date().getTimezoneOffset(), '分钟（UTC+8 应为 -480）');
console.log('北京时间现在：', L.toBeijing().toISOString(), '\n');

console.log('【1】高峰 / 空闲判定（2026-09-21 是周一，无法定节假日）');
eq('周一 08:59 空闲', L.isPeakHour(at('2026-09-21 08:59')), false);
eq('周一 09:00 高峰', L.isPeakHour(at('2026-09-21 09:00')), true);
eq('周一 11:59 高峰', L.isPeakHour(at('2026-09-21 11:59')), true);
eq('周一 12:00 空闲', L.isPeakHour(at('2026-09-21 12:00')), false);
eq('周一 13:59 空闲', L.isPeakHour(at('2026-09-21 13:59')), false);
eq('周一 14:00 高峰', L.isPeakHour(at('2026-09-21 14:00')), true);
eq('周一 15:50 高峰（就是踩坑那一刻）', L.isPeakHour(at('2026-09-21 15:50')), true);
eq('周一 17:59 高峰', L.isPeakHour(at('2026-09-21 17:59')), true);
eq('周一 18:00 空闲', L.isPeakHour(at('2026-09-21 18:00')), false);
eq('周一 23:30 空闲', L.isPeakHour(at('2026-09-21 23:30')), false);
eq('周六 10:00 空闲（周末全天空闲）', L.isPeakHour(at('2026-09-26 10:00')), false);
eq('周日 15:00 空闲（周末全天空闲）', L.isPeakHour(at('2026-09-27 15:00')), false);

console.log('\n【2】高峰结束时刻');
eq('09:30 提交 → 12:00 结束', L.peakEndsAt(at('2026-09-21 09:30')).toISOString(), at('2026-09-21 12:00').toISOString());
eq('15:50 提交 → 18:00 结束', L.peakEndsAt(at('2026-09-21 15:50')).toISOString(), at('2026-09-21 18:00').toISOString());
eq('12:00 提交 → 不在高峰，返回 null', L.peakEndsAt(at('2026-09-21 12:00')), null);

console.log('\n【3】「闲时调用」的 AI 起跑时刻（高峰结束 + 10 分钟缓冲）');
eq('15:50 提交 → 18:10 起跑', L.nextOffPeakStart(at('2026-09-21 15:50')).toISOString(), at('2026-09-21 18:10').toISOString());
eq('09:10 提交 → 12:10 起跑', L.nextOffPeakStart(at('2026-09-21 09:10')).toISOString(), at('2026-09-21 12:10').toISOString());
eq('11:58 提交 → 12:10 起跑', L.nextOffPeakStart(at('2026-09-21 11:58')).toISOString(), at('2026-09-21 12:10').toISOString());
eq('12:30 提交 → 已在空闲，立刻起跑', L.nextOffPeakStart(at('2026-09-21 12:30')).toISOString(), at('2026-09-21 12:30').toISOString());
eq('周六 10:00 提交 → 已在空闲，立刻起跑', L.nextOffPeakStart(at('2026-09-26 10:00')).toISOString(), at('2026-09-26 10:00').toISOString());

console.log('\n【4】计费单价倍率与费用（deepseek-flash）');
eq('高峰倍率 2', L.timingSnapshot(at('2026-09-21 15:50')).rateX, 2);
eq('空闲倍率 1', L.timingSnapshot(at('2026-09-21 20:00')).rateX, 1);
// 1M 未命中输入 + 1M 输出：高峰 ¥2+¥8=¥10，空闲 ¥1+¥4=¥5
eq('高峰 1M 输入 + 1M 输出 = ¥10',
  L.calcCost({ promptTokens: 1e6, completionTokens: 1e6, peak: true }), 10);
eq('空闲 1M 输入 + 1M 输出 = ¥5',
  L.calcCost({ promptTokens: 1e6, completionTokens: 1e6, peak: false }), 5);
eq('缓存命中价是未命中的 1/50（空闲：¥0.02 vs ¥1）',
  L.calcCost({ promptTokens: 1e6, cacheHitTokens: 1e6, peak: false }), 0.02);

console.log('\n【5】自然日 / 自然月边界按北京时间切');
eq('北京 09-22 00:30 属于 09-22', L.toBeijing(at('2026-09-22 00:30')).toISOString().slice(0, 10), '2026-09-22');
eq('北京 09-01 00:30 属于 09 月', L.toBeijing(at('2026-09-01 00:30')).toISOString().slice(0, 7), '2026-09');

console.log(`\n${fail === 0 ? '全部通过' : '存在失败'}：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
