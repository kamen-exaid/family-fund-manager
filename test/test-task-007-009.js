const assert = require('assert');
const {
  InputError,
  ConflictError,
  ExternalServiceError,
  StorageError,
  DEFAULT_PUBLIC_MESSAGE,
  errorPayload,
  handleApiError,
  normalizeApiErrorResponses
} = require('../lib/api-errors');
const {
  compareEvents,
  compareEventCreationOrder,
  nextSequenceNumber,
  migrateEventSequences
} = require('../lib/event-order');

const oldEvents = [
  { id: 'z-first', date: '2026-08-01', createdAt: 1000 },
  { id: 'a-second', date: '2026-08-01', createdAt: 1000 },
  { id: 'later', date: '2026-08-02', createdAt: 1001 }
];
const oldSettlements = [
  { id: 'settlement', date: '2026-08-02', createdAt: 1001 }
];

const migration = migrateEventSequences(oldEvents, oldSettlements);
assert.strictEqual(migration.migrated, true);
assert.deepStrictEqual(oldEvents.map(event => event.sequenceNumber), [1, 2, 3]);
assert.strictEqual(oldSettlements[0].sequenceNumber, 4);
assert.strictEqual(nextSequenceNumber(oldEvents, oldSettlements), 5);
assert.strictEqual(compareEvents(oldEvents[0], oldEvents[1]), -1,
  'same-day, same-millisecond events must use the durable sequence');
assert.deepStrictEqual(
  [oldEvents[2], oldEvents[0], oldEvents[1]].sort(compareEventCreationOrder).map(event => event.id),
  ['z-first', 'a-second', 'later'],
  'confirmation-order consumers must ignore shuffled JSON array order'
);

const stableSnapshot = JSON.stringify([oldEvents, oldSettlements]);
assert.strictEqual(migrateEventSequences(oldEvents, oldSettlements).migrated, false);
assert.strictEqual(JSON.stringify([oldEvents, oldSettlements]), stableSnapshot,
  'export/import migration must be idempotent');
assert.throws(
  () => migrateEventSequences([{ id: 'sequenced', sequenceNumber: 1 }, { id: 'missing' }]),
  /不完整、重复或无效/,
  'partially migrated ledgers must fail closed instead of being silently reordered'
);
assert.throws(
  () => migrateEventSequences([{ id: 'one', sequenceNumber: 1 }, { id: 'duplicate', sequenceNumber: 1 }]),
  /不完整、重复或无效/
);
assert.throws(
  () => nextSequenceNumber([{ id: 'exhausted', sequenceNumber: Number.MAX_SAFE_INTEGER }]),
  /安全整数上限/
);

const embeddedLegacy = [
  { id: 'normal-before', type: 'deposit', date: '2026-08-03', createdAt: 2000 },
  { id: 'embedded-settlement', type: 'performance_settlement', date: '2026-08-03', createdAt: 2000 },
  { id: 'normal-after', type: 'valuation', date: '2026-08-03', createdAt: 2000 }
];
migrateEventSequences(embeddedLegacy);
const splitNormal = embeddedLegacy.filter(event => event.type !== 'performance_settlement');
const splitSettlements = embeddedLegacy.filter(event => event.type === 'performance_settlement');
migrateEventSequences(splitNormal, splitSettlements);
assert.deepStrictEqual(
  [...splitNormal, ...splitSettlements].sort(compareEvents).map(event => event.id),
  ['normal-before', 'embedded-settlement', 'normal-after'],
  'splitting an embedded legacy settlement must preserve equal-timestamp interleaving'
);

assert.deepStrictEqual(errorPayload(new InputError('bad input')).body, {
  success: false, code: 'INPUT_ERROR', message: 'bad input'
});
assert.strictEqual(errorPayload(new ConflictError('locked')).status, 409);
assert.strictEqual(errorPayload(new ExternalServiceError('upstream unavailable')).status, 502);
const storageFailure = errorPayload(new StorageError('sensitive disk path'));
assert.strictEqual(storageFailure.status, 500);
assert.strictEqual(storageFailure.body.message, DEFAULT_PUBLIC_MESSAGE);
assert(!storageFailure.body.message.includes('disk path'));
const nativeFailure = new Error('sensitive native failure');
nativeFailure.code = 'EACCES';
assert.strictEqual(errorPayload(nativeFailure).body.code, 'INTERNAL_ERROR',
  'native filesystem codes must not leak into the public API contract');

let normalizedBody;
const response = {
  statusCode: 500,
  locals: {},
  json(body) { normalizedBody = body; return this; }
};
const originalConsoleError = console.error;
try {
  console.error = () => {};
  normalizeApiErrorResponses(
    { method: 'GET', originalUrl: '/api/test' },
    response,
    () => {}
  );
  response.json({ success: false, code: 'EACCES', message: 'C:\\private\\ledger.json' });
} finally {
  console.error = originalConsoleError;
}
assert.strictEqual(normalizedBody.code, 'INTERNAL_ERROR');
assert.strictEqual(normalizedBody.message, DEFAULT_PUBLIC_MESSAGE);

let forwardedError;
handleApiError(
  new StorageError('write failed'),
  { method: 'POST', originalUrl: '/api/test' },
  response,
  error => { forwardedError = error; },
  400
);
assert.strictEqual(forwardedError.code, 'STORAGE_ERROR');
assert.strictEqual(forwardedError.status, 500,
  'a route with a 400 validation fallback must retain typed storage failures');

console.log('TASK-007 API errors and TASK-009 event ordering assertions passed.');
