const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const requiredRules = [
  '每笔资金建立独立批次',
  '门槛按本期实际持有天数计算',
  '按最近估值逐批结算，盈亏不对冲',
  '每次结算结束本期，下期重新计时',
  '高水位只升不降，亏损修复前不收费',
  '部分出金按净额同比处置',
  '转让两端分开核算',
  'GP 本人退出时，两类份额仍有先后',
  '正式结算锁定历史，只能倒序撤销',
  '批次报酬 = max(批次当前价值 − 批次门槛, 0) × 25%'
];

requiredRules.forEach(rule => assert(html.includes(rule), `governance modal must disclose: ${rule}`));
assert(html.includes('再从其已归属 GP 报酬中支付'),
  'governance modal must disclose how a self-GP withdrawal uses vested carry');
assert(html.includes('第一年跌 10% 至 0.900，第二年涨 3% 至 0.927'),
  'governance modal must disclose the multi-period high-water example');
assert(html.includes('本期门槛为 1.000 × 1.06 = 1.060'),
  'governance modal must calculate the new-period hurdle from the retained high-water mark');
assert.strictEqual((html.match(/<aside class="principle-example">/g) || []).length, 10,
  'every governance rule must include a concrete example');
assert(!html.includes('principles-grid') && !html.includes('principle-card'),
  'governance rules must use a horizontal list instead of cards');
assert(!html.includes('先保障出资人(LP) 6% 年化收益'),
  'governance language must not imply that the 6% hurdle is a guaranteed return');
assert(!html.includes('复利累计的 6% 业绩门槛'),
  'governance language must not imply a flat cumulative 6% hurdle regardless of holding time');
assert(!html.includes('两年复利门槛'),
  'governance language must not accumulate the holding clock across formal settlements');

console.log('Governance principles disclosure regression tests passed.');
