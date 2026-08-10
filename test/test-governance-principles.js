const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const requiredRules = [
  '每笔入金独立核算',
  '持有两年的门槛系数是 1.06²，三年是 1.06³',
  '逐批结算，盈亏不对冲',
  '未过线不重置水位',
  '过线结晶，全过才合批',
  '部分出金按批次同比扣减',
  '转让两端分开计算',
  '批次报酬 = max(批次当前价值 − 批次门槛, 0) × 25%'
];

requiredRules.forEach(rule => assert(html.includes(rule), `governance modal must disclose: ${rule}`));
assert(html.includes('再从其已归属 GP 报酬中支付'),
  'governance modal must disclose how a self-GP withdrawal uses vested carry');
assert(!html.includes('先保障出资人(LP) 6% 年化收益'),
  'governance language must not imply that the 6% hurdle is a guaranteed return');
assert(!html.includes('复利累计的 6% 业绩门槛'),
  'governance language must not imply a flat cumulative 6% hurdle regardless of holding time');

console.log('Governance principles disclosure regression tests passed.');
