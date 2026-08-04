const assert = require('assert');
const { findCloseForPolicy, findPreviousClose } = require('../lib/yahoo');

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

console.log('Yahoo previous-close assertions passed.');
