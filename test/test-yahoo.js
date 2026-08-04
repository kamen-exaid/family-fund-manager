const assert = require('assert');
const {
  findCloseForPolicy,
  findPreviousClose,
  getTickerHistoryStartSec,
  mergeTickerAthRecord
} = require('../lib/yahoo');

const prices = {
  '2026-07-02': 100,
  '2026-07-03': 101,
  '2026-07-06': 102
};

// A trading-day NAV must not use that day's close.
assert.deepStrictEqual(findPreviousClose('2026-07-06', prices), {
  date: '2026-07-03',
  price: 101
});

// Weekends and holidays still resolve to the latest earlier trading close.
assert.deepStrictEqual(findPreviousClose('2026-07-05', prices), {
  date: '2026-07-03',
  price: 101
});

assert.strictEqual(findPreviousClose('2026-07-02', prices), null);

assert.deepStrictEqual(findCloseForPolicy('2026-07-06', prices, 'same_day'), {
  date: '2026-07-06',
  price: 102
});
assert.deepStrictEqual(findCloseForPolicy('2026-07-05', prices, 'same_day'), {
  date: '2026-07-03',
  price: 101
});

assert.strictEqual(getTickerHistoryStartSec(null), 0);
const incrementalStart = getTickerHistoryStartSec({ historyThrough: '2026-07-31' });
assert(incrementalStart > 0, 'an existing ticker must not restart at the Unix epoch');
assert.strictEqual(
  incrementalStart,
  Math.floor(Date.parse('2026-07-31T00:00:00Z') / 1000) - 14 * 24 * 3600
);

const merged = mergeTickerAthRecord('VOO', {
  ath: 115,
  athDate: '2026-06-01',
  regularClose: 114,
  regularCloseDate: '2026-07-30',
  previousYear: 2025,
  previousYearClose: 100,
  longName: 'Cached name'
}, {
  timestamp: [
    Date.parse('2026-07-31T12:00:00Z') / 1000,
    Date.parse('2026-08-03T12:00:00Z') / 1000,
    Date.parse('2026-08-04T12:00:00Z') / 1000
  ],
  indicators: { quote: [{ high: [116, 120, 999], close: [115, null, 999] }] },
  meta: {
    longName: 'Vanguard S&P 500 ETF',
    regularMarketPrice: 119,
    regularMarketTime: Date.parse('2026-08-03T20:00:01Z') / 1000
  }
}, new Date('2026-08-04T12:00:00Z'));
assert.strictEqual(merged.ath, 120);
assert.strictEqual(merged.athDate, '2026-08-03');
assert.strictEqual(merged.regularClose, 119);
assert.strictEqual(merged.historyThrough, '2026-08-03');
assert.strictEqual(merged.ytdChange, 19);

console.log('Yahoo previous-close assertions passed.');
