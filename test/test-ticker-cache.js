const assert = require('assert');
const { randomUUID } = require('crypto');
const { registerApiRoutes } = require('../routes/api');

const routes = {};
const app = {};
for (const method of ['get', 'post', 'put', 'delete']) {
  app[method] = (path, ...handlers) => { routes[`${method}:${path}`] = handlers.at(-1); };
}

const oldUpdatedAt = '2026-01-01T00:00:00.000Z';
let persisted = {
  version: 1,
  updatedAt: oldUpdatedAt,
  tickers: {
    VOO: {
      ticker: 'VOO', ath: 100, athDate: '2025-12-01', regularClose: 95,
      regularCloseDate: '2026-01-02', historyThrough: '2026-01-02', updatedAt: oldUpdatedAt
    }
  }
};
let fetchCalls = 0;
let writes = 0;
let finishFetch;

registerApiRoutes(app, {
  readDb: () => ({ members: [], events: [], indexCache: {} }),
  writeDb: () => {},
  getState: () => ({}),
  readConfig: () => ({ tickers: [{ ticker: 'VOO' }] }),
  writeConfig: () => {},
  readTickerCache: () => JSON.parse(JSON.stringify(persisted)),
  writeTickerCache: value => { writes++; persisted = JSON.parse(JSON.stringify(value)); },
  writeSnapshot: () => {},
  ensureIndexCache: () => {},
  calculateStateFromDb: () => ({ events: [] }),
  fetchCnhRateFromApi: async () => null,
  isValidDate: () => true,
  normalizeRemark: value => value || '',
  normalizeMemberName: value => value,
  fetchTickerAthData: async () => {
    fetchCalls++;
    return new Promise(resolve => { finishFetch = resolve; });
  },
  randomUUID
});

async function requestTicker() {
  const result = { headers: {}, body: null };
  const res = {
    set(name, value) { result.headers[name] = value; return this; },
    status() { return this; },
    json(value) { result.body = value; return this; }
  };
  await routes['get:/api/ticker-ath']({}, res);
  return result;
}

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

(async () => {
  const first = await requestTicker();
  assert.strictEqual(first.body.data.VOO.ath, 100);
  assert.strictEqual(first.body.cached, true);
  assert.strictEqual(first.body.stale, true);
  assert.strictEqual(fetchCalls, 0, 'the response must be sent before refresh starts');

  await nextTurn();
  assert.strictEqual(fetchCalls, 1);

  const second = await requestTicker();
  assert.strictEqual(second.body.data.VOO.ath, 100);
  await nextTurn();
  assert.strictEqual(fetchCalls, 1, 'concurrent stale requests must share one refresh');

  finishFetch({
    VOO: {
      ...persisted.tickers.VOO,
      ath: 110,
      regularClose: 105,
      updatedAt: new Date().toISOString()
    }
  });
  await nextTurn();
  await nextTurn();
  assert.strictEqual(writes, 1);
  assert.strictEqual(persisted.tickers.VOO.ath, 110);

  console.log('Ticker persistent stale-while-revalidate assertions passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
