const assert = require('assert');
const { calculateStateFromDb } = require('./server');

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

console.log('Production calculateStateFromDb assertions passed.');
