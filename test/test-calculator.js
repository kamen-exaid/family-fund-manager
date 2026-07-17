const assert = require('assert');
const { calculateStateFromDb } = require('../server');

const db = {
  cnhRate: 7.2,
  members: [
    { id: 'alice', name: 'Alice' },
    { id: 'bob', name: 'Bob' }
  ],
  events: [
    { id: 'deposit-1', type: 'deposit', member: 'alice', amount: 1000, cnhAmount: 7200, date: '2026-01-01', createdAt: 1 },
    { id: 'valuation-1', type: 'valuation', totalNAV: 1200, date: '2026-01-02', createdAt: 2 },
    { id: 'deposit-2', type: 'deposit', member: 'bob', amount: 600, cnhAmount: 4320, date: '2026-01-03', createdAt: 3 },
    { id: 'transfer-1', type: 'transfer', fromMember: 'alice', toMember: 'bob', amount: 240, cnhRate: 7.2, date: '2026-01-04', createdAt: 4 }
  ],
  indexCache: {}
};

const state = calculateStateFromDb(db);

assert.strictEqual(state.summary.totalNAV, 1800);
assert.strictEqual(state.summary.totalShares, 1500);
assert.strictEqual(state.summary.navPerShare, 1.2);
assert.strictEqual(state.members.alice.shares, 800);
assert.strictEqual(state.members.bob.shares, 700);
assert.strictEqual(state.members.alice.currentValue, 960);
assert.strictEqual(state.members.bob.currentValue, 840);
assert.strictEqual(state.events.find(event => event.id === 'transfer-1')._sharesTransferred, 200);
// A member-to-member transfer is not new capital for the family fund and
// must not dilute the fund-level USD or CNH return rates.
assert.strictEqual(state.summary.totalDeposit, 1600);
assert.strictEqual(state.summary.totalWithdraw, 0);
assert.strictEqual(state.summary.profit, 200);
assert.strictEqual(state.summary.profitRate, 12.5);
assert.strictEqual(state.summary.cnhTotalDeposit, 11520);
assert.strictEqual(state.summary.cnhTotalWithdraw, 0);
assert.strictEqual(state.summary.cnhProfit, 1440);
assert.strictEqual(state.summary.cnhProfitRate, 12.5);

// Repeating decimal inputs are a common source of silent ledger drift when
// JavaScript Number is used for intermediate calculations.
const precisionDb = {
  cnhRate: 7.2,
  members: [{ id: 'alice', name: 'Alice' }],
  indexCache: {},
  events: Array.from({ length: 100 }, (_, index) => ({
    id: `fraction-${index}`,
    type: 'deposit',
    member: 'alice',
    amount: 0.1,
    cnhAmount: 0.72,
    date: '2026-02-01',
    createdAt: index
  }))
};
const precisionState = calculateStateFromDb(precisionDb);
assert.strictEqual(precisionState.summary.totalNAV, 10);
assert.strictEqual(precisionState.events.at(-1)._totalNAVAfter, 10);

console.log('Production calculateStateFromDb assertions passed.');
