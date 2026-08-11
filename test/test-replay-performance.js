const assert = require('assert');
const { performance } = require('perf_hooks');
const { calculateStateFromDb } = require('../lib/calculator');

const lotCount = 150;
const withdrawalCount = 80;
const feeConfig = {
  gpMember: 'gp',
  annualRate: 0.06,
  feeRate: 0.25,
  disposalVersion: 2
};
const events = [];

for (let index = 0; index < lotCount; index++) {
  events.push({
    id: `deposit-${index}`,
    type: 'deposit',
    member: 'lp',
    amount: 100,
    cnhAmount: 720,
    date: `2025-${String(Math.floor(index / 28) + 1).padStart(2, '0')}-${String(index % 28 + 1).padStart(2, '0')}`,
    createdAt: index
  });
}
events.push({
  id: 'valuation',
  type: 'valuation',
  totalNAV: lotCount * 125,
  date: '2026-01-01',
  createdAt: lotCount
});
for (let index = 0; index < withdrawalCount; index++) {
  events.push({
    id: `withdraw-${index}`,
    type: 'withdraw',
    member: 'lp',
    amount: 25,
    cnhAmount: 180,
    date: '2026-01-02',
    createdAt: lotCount + 1 + index,
    performanceFee: feeConfig
  });
}

const db = {
  cnhRate: 7.2,
  members: [{ id: 'lp', name: 'LP' }, { id: 'gp', name: 'GP' }],
  indexCache: {},
  events
};

function benchmark(includeDisposalLotDetails) {
  const metrics = {};
  const startedAt = performance.now();
  const state = calculateStateFromDb(JSON.parse(JSON.stringify(db)), {
    includeDisposalLotDetails,
    metrics
  });
  return { state, metrics, elapsedMs: performance.now() - startedAt };
}

function withoutDisposalDetails(state) {
  const normalized = JSON.parse(JSON.stringify(state));
  normalized.events.forEach(event => { delete event._disposedLots; });
  return normalized;
}

const lean = benchmark(false);
const detailed = benchmark(true);
const expectedLotVisits = lotCount * withdrawalCount * 2;

assert.strictEqual(
  lean.metrics.disposalLotVisits,
  expectedLotVisits,
  'validation replay should aggregate and apply each active lot exactly once per phase'
);
assert.strictEqual(detailed.metrics.disposalLotVisits, expectedLotVisits);
assert.deepStrictEqual(
  withoutDisposalDetails(lean.state),
  withoutDisposalDetails(detailed.state),
  'omitting audit-heavy disposal details must not change any financial result'
);
assert(lean.elapsedMs < 10000, `lean worst-case replay took ${lean.elapsedMs.toFixed(0)}ms`);
assert(detailed.elapsedMs < 10000, `detailed worst-case replay took ${detailed.elapsedMs.toFixed(0)}ms`);

calculateStateFromDb(JSON.parse(JSON.stringify({
  ...db,
  events: events.slice(0, lotCount + 1 + 5)
})), {
  includeDisposalLotDetails: false,
  verifyLotSummaries: true
});

console.log(
  `Replay performance benchmark passed: ${lotCount} lots x ${withdrawalCount} withdrawals, ` +
  `${lean.metrics.disposalLotVisits} lot visits, lean ${lean.elapsedMs.toFixed(1)}ms, ` +
  `detailed ${detailed.elapsedMs.toFixed(1)}ms.`
);
