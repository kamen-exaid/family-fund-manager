const assert = require('assert');
const { randomUUID } = require('crypto');
const { calculateStateFromDb } = require('../lib/calculator');
const { registerApiRoutes } = require('../routes/api');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeApi() {
  const routes = {};
  const app = {};
  for (const method of ['get', 'post', 'put', 'delete']) {
    app[method] = (path, handler) => { routes[`${method}:${path}`] = handler; };
  }

  let writes = 0;
  const db = {
    cnhRate: 7.2,
    members: [{ id: 'a', name: 'Alice' }, { id: 'b', name: 'Bob' }],
    events: [{ id: 'deposit', type: 'deposit', member: 'a', amount: 100, cnhAmount: 720, date: '2026-01-10', createdAt: 1 }],
    indexCache: {}
  };
  registerApiRoutes(app, {
    readDb: () => clone(db),
    writeDb: value => { writes++; Object.assign(db, clone(value)); },
    getState: () => calculateStateFromDb(clone(db)),
    readConfig: () => ({ tickers: [] }),
    writeConfig: () => {},
    ensureIndexCache: async () => {},
    calculateStateFromDb,
    fetchCnhRateFromApi: async () => null,
    isValidDate: date => /^\d{4}-\d{2}-\d{2}$/.test(date),
    normalizeRemark: value => value || '',
    normalizeMemberName: value => value,
    fetchTickerAthData: async () => ({}),
    randomUUID
  });
  return { routes, getWrites: () => writes };
}

async function request(handler, body) {
  const result = { status: 200, body: null };
  const res = {
    status(code) { result.status = code; return this; },
    json(payload) { result.body = payload; return this; }
  };
  await handler({ body, params: {} }, res);
  return result;
}

(async () => {
  const api = makeApi();
  const transaction = api.routes['post:/api/transaction'];
  const transfer = api.routes['post:/api/transfer'];
  const settings = api.routes['post:/api/settings'];

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

  console.log('API validation regression tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
