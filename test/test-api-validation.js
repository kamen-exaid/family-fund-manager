const assert = require('assert');
const { randomUUID } = require('crypto');
const { calculateStateFromDb } = require('../lib/calculator');
const { registerApiRoutes } = require('../routes/api');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeApi(now = () => new Date()) {
  const routes = {};
  const app = {};
  for (const method of ['get', 'post', 'put', 'delete']) {
    app[method] = (path, ...handlers) => { routes[`${method}:${path}`] = handlers.at(-1); };
  }

  let writes = 0;
  let settlementLedger = { version: 1, records: [] };
  const db = {
    cnhRate: 7.2,
    members: [
      { id: 'a', name: 'Alice', roles: { lp: true, gp: false } },
      { id: 'b', name: 'Bob', roles: { lp: true, gp: true } }
    ],
    performanceFee: { gpMemberId: 'b', annualRate: 0.06, feeRate: 0.25 },
    events: [{ id: 'deposit', type: 'deposit', member: 'a', amount: 100, cnhAmount: 720, date: '2026-01-10', createdAt: 1 }],
    indexCache: {}
  };
  registerApiRoutes(app, {
    readDb: () => clone(db),
    writeDb: value => { writes++; Object.assign(db, clone(value)); },
    readSettlements: () => clone(settlementLedger),
    writeSettlements: value => {
      writes++;
      settlementLedger = clone(value);
      const reversed = new Set(settlementLedger.records.filter(item => item.type === 'performance_settlement_reversal').map(item => item.settlementId));
      db.events = db.events.filter(item => item.type !== 'performance_settlement' && item.type !== 'performance_settlement_reversal');
      db.events.push(...settlementLedger.records.filter(item => item.type === 'performance_settlement' && !reversed.has(item.id)));
    },
    getState: () => calculateStateFromDb(clone(db)),
    readConfig: () => ({ tickers: [] }),
    writeConfig: () => {},
    writeSnapshot: () => {},
    ensureIndexCache: async () => {},
    calculateStateFromDb,
    fetchCnhRateFromApi: async () => null,
    isValidDate: date => /^\d{4}-\d{2}-\d{2}$/.test(date),
    normalizeRemark: value => value || '',
    normalizeMemberName: value => value,
    fetchTickerAthData: async () => ({}),
    randomUUID,
    now
  });
  return { routes, getWrites: () => writes };
}

async function request(handler, body, params = {}) {
  const result = { status: 200, body: null };
  const res = {
    status(code) { result.status = code; return this; },
    json(payload) { result.body = payload; return this; }
  };
  await handler({ body, params }, res);
  return result;
}

(async () => {
  const api = makeApi();
  const transaction = api.routes['post:/api/transaction'];
  const transfer = api.routes['post:/api/transfer'];
  const valuation = api.routes['post:/api/valuation'];
  const settings = api.routes['post:/api/settings'];
  const previewSettlement = api.routes['post:/api/performance-settlement/preview'];
  const confirmSettlement = api.routes['post:/api/performance-settlement'];
  const reverseSettlement = api.routes['post:/api/performance-settlement/reverse-latest'];
  const updateEvent = api.routes['put:/api/event/:id'];

  const beforeCutoffApi = makeApi(() => new Date('2026-08-06T08:04:00Z'));
  const beforeCutoffValuation = await request(beforeCutoffApi.routes['post:/api/valuation'], {
    totalNAV: 120, date: '2026-08-06'
  });
  assert.strictEqual(beforeCutoffValuation.status, 400);
  assert.match(beforeCutoffValuation.body.message, /16:05/);

  const afterCutoffApi = makeApi(() => new Date('2026-08-06T08:05:00Z'));
  const afterCutoffValuation = await request(afterCutoffApi.routes['post:/api/valuation'], {
    totalNAV: 120, date: '2026-08-06'
  });
  assert.strictEqual(afterCutoffValuation.status, 200);

  const zeroValuation = await request(valuation, {
    totalNAV: 0, date: '2026-01-11'
  });
  assert.strictEqual(zeroValuation.status, 400);
  assert.strictEqual(api.getWrites(), 0);

  const preInceptionValuation = await request(valuation, {
    totalNAV: 110, date: '2026-01-01'
  });
  assert.strictEqual(preInceptionValuation.status, 400);
  assert.match(preInceptionValuation.body.message, /尚无基金份额/);
  assert.strictEqual(api.getWrites(), 0);

  const historicalWithdrawal = await request(transaction, {
    member: 'a', type: 'withdraw', amount: 100, date: '2026-01-01'
  });
  assert.strictEqual(historicalWithdrawal.status, 400);
  assert.strictEqual(api.getWrites(), 0);

  const malformedAmount = await request(transaction, {
    member: 'a', type: 'deposit', amount: '100usd', date: '2026-01-11'
  });
  assert.strictEqual(malformedAmount.status, 400);
  assert.strictEqual(api.getWrites(), 0);

  const infiniteAmount = await request(transaction, {
    member: 'a', type: 'deposit', amount: 'Infinity', date: '2026-01-11'
  });
  assert.strictEqual(infiniteAmount.status, 400);
  assert.strictEqual(api.getWrites(), 0);

  const weekdayDeposit = await request(transaction, {
    member: 'a', type: 'deposit', amount: 10, date: '2026-01-12'
  });
  assert.strictEqual(weekdayDeposit.status, 400);
  assert.match(weekdayDeposit.body.message, /周日/);
  assert.strictEqual(api.getWrites(), 0);

  const saturdayDeposit = await request(transaction, {
    member: 'a', type: 'deposit', amount: 10, date: '2026-01-17'
  });
  assert.strictEqual(saturdayDeposit.status, 400);
  assert.match(saturdayDeposit.body.message, /周日/);
  assert.strictEqual(api.getWrites(), 0);

  const weekdayTransfer = await request(transfer, {
    fromMember: 'a', toMember: 'b', amount: 10, cnhRate: 7.2, date: '2026-01-12'
  });
  assert.strictEqual(weekdayTransfer.status, 400);
  assert.match(weekdayTransfer.body.message, /周日/);
  assert.strictEqual(api.getWrites(), 0);

  const saturdayTransfer = await request(transfer, {
    fromMember: 'a', toMember: 'b', amount: 10, cnhRate: 7.2, date: '2026-01-17'
  });
  assert.strictEqual(saturdayTransfer.status, 400);
  assert.match(saturdayTransfer.body.message, /周日/);
  assert.strictEqual(api.getWrites(), 0);

  const historicalTransfer = await request(transfer, {
    fromMember: 'a', toMember: 'b', amount: 100, cnhRate: 7.2, date: '2026-01-01'
  });
  assert.strictEqual(historicalTransfer.status, 400);
  assert.strictEqual(api.getWrites(), 0);

  const invalidPolicy = await request(settings, { benchmarkClosePolicy: 'future_close' });
  assert.strictEqual(invalidPolicy.status, 400);
  assert.strictEqual(api.getWrites(), 0);

  const validPolicy = await request(settings, { benchmarkClosePolicy: 'same_day' });
  assert.strictEqual(validPolicy.status, 200);
  assert.strictEqual(api.getWrites(), 1);

  const settlementValuation = await request(valuation, { totalNAV: 120, date: '2026-01-12' });
  assert.strictEqual(settlementValuation.status, 200);
  const preview = await request(previewSettlement, { gpMember: 'b', date: '2026-01-12' });
  assert.strictEqual(preview.status, 200);
  assert(preview.body.data.totalFee > 0);
  const confirmed = await request(confirmSettlement, { gpMember: 'b', date: '2026-01-12' });
  assert.strictEqual(confirmed.status, 200);
  const historicalSettlement = await request(previewSettlement, { gpMember: 'b', date: '2026-01-10' });
  assert.strictEqual(historicalSettlement.status, 400);
  assert.match(historicalSettlement.body.message, /必须晚于/);
  const lockedMutation = await request(transaction, {
    member: 'a', type: 'deposit', amount: 1, date: '2026-01-11'
  });
  assert.strictEqual(lockedMutation.status, 409);
  const futureMutation = await request(transaction, {
    member: 'a', type: 'deposit', amount: 1, date: '2026-01-18'
  });
  assert.strictEqual(futureMutation.status, 200);
  const lockedDateEdit = await request(updateEvent, {
    date: '2026-01-11'
  }, { id: futureMutation.body.data.id });
  assert.strictEqual(lockedDateEdit.status, 409);
  const reversed = await request(reverseSettlement, { remark: 'test reversal' });
  assert.strictEqual(reversed.status, 200);
  const unlockedMutation = await request(transaction, {
    member: 'a', type: 'deposit', amount: 1, date: '2026-01-11'
  });
  assert.strictEqual(unlockedMutation.status, 200);
  const sameDayPreviewAfterReversal = await request(previewSettlement, {
    gpMember: 'b', date: '2026-01-12'
  });
  assert.strictEqual(sameDayPreviewAfterReversal.status, 200);
  const sameDayConfirmedAfterReversal = await request(confirmSettlement, {
    gpMember: 'b', date: '2026-01-12'
  });
  assert.strictEqual(sameDayConfirmedAfterReversal.status, 200);

  // Later cash flows must not prevent a historical year-end settlement. The
  // replay engine naturally excludes members whose first deposit is later.
  const laterCashFlowApi = makeApi();
  const laterValuation = laterCashFlowApi.routes['post:/api/valuation'];
  const laterTransaction = laterCashFlowApi.routes['post:/api/transaction'];
  const historicalPreview = laterCashFlowApi.routes['post:/api/performance-settlement/preview'];
  assert.strictEqual((await request(laterValuation, { totalNAV: 120, date: '2026-01-12' })).status, 200);
  assert.strictEqual((await request(laterTransaction, {
    member: 'a', type: 'deposit', amount: 10, date: '2026-02-01'
  })).status, 200);
  assert.strictEqual((await request(historicalPreview, {
    gpMember: 'b', date: '2026-01-15'
  })).status, 200);

  console.log('API validation regression tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
