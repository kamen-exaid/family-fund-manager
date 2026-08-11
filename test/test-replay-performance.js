const assert = require('assert');
const { performance } = require('perf_hooks');
const { calculateStateFromDb } = require('../lib/calculator');
const {
  REPLAY_PERFORMANCE_BUDGETS,
  evaluateReplayBudget
} = require('../lib/replay-performance-budget');

const feeConfig = {
  gpMember: 'gp',
  annualRate: 0.06,
  feeRate: 0.25,
  disposalVersion: 2
};

function buildLedger({ lotCount, withdrawalCount, fillerValuationCount = 0 }) {
  const events = [];
  let sequenceNumber = 1;
  for (let index = 0; index < lotCount; index++) {
    events.push({
      id: `deposit-${index}`,
      type: 'deposit',
      member: 'lp',
      amount: 100,
      cnhAmount: 720,
      date: '2025-01-01',
      createdAt: sequenceNumber,
      sequenceNumber: sequenceNumber++
    });
  }
  for (let index = 0; index < fillerValuationCount + 1; index++) {
    events.push({
      id: `valuation-${index}`,
      type: 'valuation',
      totalNAV: lotCount * 125,
      date: '2026-01-01',
      createdAt: sequenceNumber,
      sequenceNumber: sequenceNumber++
    });
  }
  for (let index = 0; index < withdrawalCount; index++) {
    events.push({
      id: `withdraw-${index}`,
      type: 'withdraw',
      member: 'lp',
      amount: 25,
      cnhAmount: 180,
      date: '2026-01-02',
      createdAt: sequenceNumber,
      sequenceNumber: sequenceNumber++,
      performanceFee: feeConfig
    });
  }
  return {
    cnhRate: 7.2,
    performanceFee: { gpMemberId: 'gp', annualRate: 0.06, feeRate: 0.25 },
    members: [
      { id: 'lp', name: 'LP', roles: { lp: true, gp: false } },
      { id: 'gp', name: 'GP', roles: { lp: true, gp: true } }
    ],
    indexCache: {},
    events
  };
}

function benchmark(db, includeDisposalLotDetails) {
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

function assertBudget(name, db, budget) {
  // Production state reads include the complete per-lot audit breakdown, so
  // elapsed-time budgets must guard that path rather than only the lean
  // mutation-validation replay.
  const result = benchmark(db, true);
  assert.strictEqual(result.metrics.eventCount, budget.eventCount, `${name}: event count drifted`);
  assert.strictEqual(result.metrics.peakActiveLotCount, budget.peakActiveLotCount,
    `${name}: peak active lot count drifted`);
  assert.strictEqual(result.metrics.disposalLotVisits, budget.disposalLotVisits,
    `${name}: disposal traversal count drifted`);
  const assessment = evaluateReplayBudget(result.elapsedMs, budget);
  assert.notStrictEqual(
    assessment.status,
    'exceeded',
    `${budget.label} replay exceeded ${budget.maxElapsedMs}ms budget: ${result.elapsedMs.toFixed(1)}ms`
  );
  if (assessment.status === 'warning') {
    console.warn(`[Replay budget warning] ${budget.label}: ${(assessment.utilization * 100).toFixed(0)}% used`);
  }
  console.log(
    `${budget.label}: ${result.metrics.eventCount} events, ` +
    `${result.metrics.peakActiveLotCount} peak/${result.metrics.finalActiveLotCount} final lots, ` +
    `${result.metrics.disposalLotVisits} disposal visits, ${result.elapsedMs.toFixed(1)}ms ` +
    `(${(assessment.utilization * 100).toFixed(1)}% of budget).`
  );
  return result;
}

// Warm up Decimal-heavy paths before measuring wall-clock budgets.
benchmark(buildLedger({ lotCount: 2, withdrawalCount: 1 }), false);

const typicalDb = buildLedger({ lotCount: 24, withdrawalCount: 12 });
assertBudget('typical', typicalDb, REPLAY_PERFORMANCE_BUDGETS.typical);

const householdUpperDb = buildLedger({ lotCount: 150, withdrawalCount: 80 });
const householdDetailed = assertBudget(
  'householdUpper',
  householdUpperDb,
  REPLAY_PERFORMANCE_BUDGETS.householdUpper
);
const householdLean = benchmark(householdUpperDb, false);
assert.strictEqual(householdLean.metrics.disposalLotVisits, 24000);
assert.deepStrictEqual(
  withoutDisposalDetails(householdLean.state),
  withoutDisposalDetails(householdDetailed.state),
  'omitting audit-heavy disposal details must not change any financial result'
);

const importLimitDb = buildLedger({
  lotCount: 250,
  withdrawalCount: 100,
  fillerValuationCount: 9649
});
assertBudget('importLimit', importLimitDb, REPLAY_PERFORMANCE_BUDGETS.importLimit);

calculateStateFromDb(JSON.parse(JSON.stringify({
  ...householdUpperDb,
  events: householdUpperDb.events.slice(0, 156)
})), {
  includeDisposalLotDetails: false,
  verifyLotSummaries: true
});

console.log('Replay performance budgets and replay-equivalence assertions passed.');
