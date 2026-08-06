const assert = require('assert');
const { calculateStateFromDb } = require('../server');

function event(id, type, date, createdAt, extra = {}) {
  return { id, type, date, createdAt, ...extra };
}

const base = {
  cnhRate: 7.2,
  members: [
    { id: 'lp', name: 'LP' },
    { id: 'gp', name: 'GP' }
  ],
  indexCache: {},
  events: [
    event('d1', 'deposit', '2025-01-01', 1, { member: 'lp', amount: 100, cnhAmount: 720 }),
    event('v1', 'valuation', '2026-01-01', 2, { totalNAV: 120 }),
    event('s1', 'performance_settlement', '2026-01-01', 3, { gpMember: 'gp', annualRate: 0.06, feeRate: 0.25 })
  ]
};

const state = calculateStateFromDb(base);
const settlement = state.events.find(item => item.id === 's1');
assert.strictEqual(settlement._totalFee, 3.5);
assert.strictEqual(settlement._breakdown[0].hurdle, 106);
assert.strictEqual(settlement._breakdown[0].excess, 14);
assert.strictEqual(settlement._breakdown[0].lots.length, 1);
assert.strictEqual(settlement._breakdown[0].lots[0].basis, 100);
assert.strictEqual(settlement._breakdown[0].lots[0].entryNav, 1);
assert.strictEqual(settlement._breakdown[0].lots[0].holdingDays, 365);
assert.strictEqual(settlement._breakdown[0].lots[0].currentValue, 120);
assert.strictEqual(settlement._breakdown[0].lots[0].hurdle, 106);
assert.strictEqual(state.summary.totalNAV, 120, 'share fee must not remove fund assets');
assert.strictEqual(state.members.lp.currentValue, 116.5);
assert.strictEqual(state.members.gp.currentValue, 3.5);

const dualRoleState = calculateStateFromDb({
  cnhRate: 7.2,
  members: [{ id: 'both', name: 'Both', roles: { lp: true, gp: true } }],
  indexCache: {},
  events: [
    event('dual-deposit', 'deposit', '2025-01-01', 1, { member: 'both', amount: 100, cnhAmount: 720 }),
    event('dual-value', 'valuation', '2026-01-01', 2, { totalNAV: 120 }),
    event('dual-settle', 'performance_settlement', '2026-01-01', 3, { gpMember: 'both', annualRate: 0.06, feeRate: 0.25 })
  ]
});
assert.strictEqual(dualRoleState.members.both.currentValue, 120);
assert.strictEqual(dualRoleState.members.both.lpCurrentValue, 116.5);
assert.strictEqual(dualRoleState.members.both.gpCarryValue, 3.5);

// A loss-only crystallization must not reset the high-water basis. Recovering
// merely to the old hurdle therefore cannot create a second fee.
const lossState = calculateStateFromDb({
  ...base,
  events: [
    event('d1', 'deposit', '2025-01-01', 1, { member: 'lp', amount: 100, cnhAmount: 720 }),
    event('loss', 'valuation', '2026-01-01', 2, { totalNAV: 80 }),
    event('no-fee', 'performance_settlement', '2026-01-01', 3, { gpMember: 'gp', annualRate: 0.06, feeRate: 0.25 }),
    event('recover', 'valuation', '2026-06-01', 4, { totalNAV: 105 }),
    event('still-no-fee', 'performance_settlement', '2026-06-01', 5, { gpMember: 'gp', annualRate: 0.06, feeRate: 0.25 })
  ]
});
assert.strictEqual(lossState.events.find(item => item.id === 'no-fee')._totalFee, 0);
assert.strictEqual(lossState.events.find(item => item.id === 'still-no-fee')._totalFee, 0);

// A transfer is a new LP acquisition for the recipient at transfer-date NAV;
// the sender's old lots are reduced but never copied into the recipient ledger.
const transferState = calculateStateFromDb({
  cnhRate: 7.2,
  members: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'gp', name: 'GP' }],
  indexCache: {},
  events: [
    event('d', 'deposit', '2025-01-01', 1, { member: 'a', amount: 100, cnhAmount: 720 }),
    event('mid', 'valuation', '2025-07-01', 2, { totalNAV: 110 }),
    event('t', 'transfer', '2025-07-01', 3, { fromMember: 'a', toMember: 'b', amount: 55, cnhRate: 7.2 }),
    event('end', 'valuation', '2026-01-01', 4, { totalNAV: 120 }),
    event('settle', 'performance_settlement', '2026-01-01', 5, { gpMember: 'gp', annualRate: 0.06, feeRate: 0.25 })
  ]
});
const transferSettlement = transferState.events.find(item => item.id === 'settle');
const recipient = transferSettlement._breakdown.find(item => item.member === 'b');
assert.strictEqual(recipient.lots.length, 1);
assert.strictEqual(recipient.lots[0].startDate, '2025-07-01');
assert.strictEqual(recipient.lots[0].basis, 55);
assert.strictEqual(recipient.lots[0].entryNav, 1.1);
assert(transferSettlement._totalFee < 3.5, 'later transfer-date hurdle should reduce the fee');

const crystallizedTransfer = calculateStateFromDb({
  cnhRate: 7.2,
  members: [{ id: 'seller', name: 'Seller' }, { id: 'buyer', name: 'Buyer' }, { id: 'gp', name: 'GP' }],
  indexCache: {},
  events: [
    event('capital', 'deposit', '2025-01-01', 1, { member: 'seller', amount: 100, cnhAmount: 720 }),
    event('mark', 'valuation', '2026-01-01', 2, { totalNAV: 120 }),
    event('sale', 'transfer', '2026-01-01', 3, {
      fromMember: 'seller', toMember: 'buyer', amount: 60, cnhRate: 7.2,
      performanceFee: { gpMember: 'gp', annualRate: 0.06, feeRate: 0.25 }
    })
  ]
});
const sale = crystallizedTransfer.events.find(item => item.id === 'sale');
assert.strictEqual(sale._actualAmount, 60, 'recipient receives the full entered transfer amount');
assert.strictEqual(sale._performanceFee, 1.75);
assert.strictEqual(crystallizedTransfer.members.buyer.lpCurrentValue, 60);
assert.strictEqual(crystallizedTransfer.members.buyer.lpLedger[0].basis, 60);
assert.strictEqual(crystallizedTransfer.members.buyer.lpLedger[0].startDate, '2026-01-01');
assert.strictEqual(crystallizedTransfer.members.gp.gpCarryValue, 1.75);

// Multiple contribution lots belonging to the same LP share one settlement
// pool: an underperforming lot may offset an outperforming lot.
const offsetState = calculateStateFromDb({
  cnhRate: 7.2,
  members: [{ id: 'lp', name: 'LP' }, { id: 'gp', name: 'GP' }],
  indexCache: {},
  events: [
    event('offset-d1', 'deposit', '2025-01-01', 1, { member: 'lp', amount: 100, cnhAmount: 720 }),
    event('offset-v1', 'valuation', '2025-07-01', 2, { totalNAV: 120 }),
    event('offset-d2', 'deposit', '2025-07-01', 3, { member: 'lp', amount: 100, cnhAmount: 720 }),
    event('offset-v2', 'valuation', '2026-01-01', 4, { totalNAV: 220 }),
    event('offset-s', 'performance_settlement', '2026-01-01', 5, { gpMember: 'gp', annualRate: 0.06, feeRate: 0.25 })
  ]
});
const offsetSettlement = offsetState.events.find(item => item.id === 'offset-s');
const offsetBreakdown = offsetSettlement._breakdown.find(item => item.member === 'lp');
assert.strictEqual(offsetBreakdown.lots.length, 2);
assert.strictEqual(offsetSettlement._totalFee, 2.75, 'lots must be netted at LP level before applying the fee rate');

// Entering the complete pre-fee account value means a true full exit: the GP
// receives carry, the LP receives the net cash and retains no residual shares.
const fullExitState = calculateStateFromDb({
  cnhRate: 7.2,
  members: [{ id: 'lp', name: 'LP' }, { id: 'gp', name: 'GP' }],
  indexCache: {},
  events: [
    event('exit-d', 'deposit', '2025-01-01', 1, { member: 'lp', amount: 100, cnhAmount: 720 }),
    event('exit-v', 'valuation', '2026-01-01', 2, { totalNAV: 120 }),
    event('exit-w', 'withdraw', '2026-01-01', 3, {
      member: 'lp', amount: 120, cnhAmount: 864, fullExit: true,
      performanceFee: { gpMember: 'gp', annualRate: 0.06, feeRate: 0.25 }
    })
  ]
});
const fullExit = fullExitState.events.find(item => item.id === 'exit-w');
assert.strictEqual(fullExit._performanceFee, 3.5);
assert.strictEqual(fullExit._actualAmount, 116.5);
assert.strictEqual(fullExit._unpaidPerformanceFeeShares, 0);
assert.strictEqual(fullExitState.members.lp.currentValue, 0);
assert.strictEqual(fullExitState.members.gp.gpCarryValue, 3.5);
assert.strictEqual(fullExitState.summary.totalNAV, 3.5);

const fullTransferState = calculateStateFromDb({
  cnhRate: 7.2,
  members: [{ id: 'seller', name: 'Seller' }, { id: 'buyer', name: 'Buyer' }, { id: 'gp', name: 'GP' }],
  indexCache: {},
  events: [
    event('full-t-d', 'deposit', '2025-01-01', 1, { member: 'seller', amount: 100, cnhAmount: 720 }),
    event('full-t-v', 'valuation', '2026-01-01', 2, { totalNAV: 120 }),
    event('full-t', 'transfer', '2026-01-01', 3, {
      fromMember: 'seller', toMember: 'buyer', amount: 120, cnhRate: 7.2, cnhAmount: 864, fullExit: true,
      performanceFee: { gpMember: 'gp', annualRate: 0.06, feeRate: 0.25 }
    })
  ]
});
const fullTransfer = fullTransferState.events.find(item => item.id === 'full-t');
assert.strictEqual(fullTransfer._actualAmount, 116.5);
assert.strictEqual(fullTransferState.members.seller.currentValue, 0);
assert.strictEqual(fullTransferState.members.buyer.lpCurrentValue, 116.5);
assert.strictEqual(fullTransferState.members.gp.gpCarryValue, 3.5);
assert.strictEqual(fullTransferState.summary.totalNAV, 120);

// Reversal records remain auditable ledger events, but must not create a
// fake point/remark on the economic performance timeline.
const reversedChartState = calculateStateFromDb({
  cnhRate: 7.2,
  members: [{ id: 'lp', name: 'LP' }, { id: 'gp', name: 'GP' }],
  indexCache: {},
  events: [
    event('capital-r', 'deposit', '2025-01-01', 1, { member: 'lp', amount: 100, cnhAmount: 720 }),
    event('mark-r', 'valuation', '2025-12-31', 2, { totalNAV: 110 }),
    event('reverse-r', 'performance_settlement_reversal', '2026-08-05', 3, {
      settlementId: 'settled-r', settlementDate: '2025-12-31', remark: '管理员撤销最近一次业绩结算'
    })
  ]
});
assert(reversedChartState.events.some(item => item.id === 'reverse-r'), 'reversal remains in the audit ledger');
assert(!reversedChartState.charts.navHistory.some(item => item.eventId === 'reverse-r'), 'reversal must not appear in NAV history');
assert.strictEqual(reversedChartState.charts.navHistory.at(-1).date, '2025-12-31');
assert.strictEqual(reversedChartState.members.lp.lpLedger[0].hurdle, 105.98);

console.log('Performance settlement hurdle, HWM and lot-transfer assertions passed.');
