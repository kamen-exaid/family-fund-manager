const assert = require('assert');
const fs = require('fs');
const path = require('path');
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

const routesDirectory = path.join(__dirname, '..', 'routes');
const directErrorResponses = fs.readdirSync(routesDirectory)
  .filter(file => file.endsWith('.js'))
  .flatMap(file => {
    const source = fs.readFileSync(path.join(routesDirectory, file), 'utf8');
    return /res\.status\(\s*(?:400|404|409|5\d\d)\b/.test(source) ? [file] : [];
  });
assert.deepStrictEqual(
  directErrorResponses,
  [],
  'route failures must flow through typed API errors instead of constructing status responses directly'
);

console.log('Typed API error and response-envelope assertions passed.');
