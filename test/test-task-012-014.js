const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  createDisposalFeeSnapshot
} = require('../lib/performance-fee-policy');
const { ConflictError } = require('../lib/api-errors');

const config = { gpMemberId: 'gp', annualRate: 0.08, feeRate: 0.3 };
const members = [
  { id: 'lp', roles: { lp: true, gp: false } },
  { id: 'gp', roles: { lp: true, gp: true } }
];

assert.deepStrictEqual(createDisposalFeeSnapshot(config, members), {
  gpMember: 'gp', annualRate: 0.08, feeRate: 0.3, disposalVersion: 2
});
assert.strictEqual(createDisposalFeeSnapshot({ ...config, gpMemberId: null }, members), null);
assert.throws(
  () => createDisposalFeeSnapshot(config, members.filter(member => member.id !== 'gp')),
  error => error instanceof ConflictError && error.code === 'BUSINESS_CONFLICT'
);
assert.throws(
  () => createDisposalFeeSnapshot(config, members.map(member => ({
    ...member,
    roles: { ...member.roles, gp: false }
  }))),
  error => error instanceof ConflictError && error.code === 'BUSINESS_CONFLICT'
);

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

console.log('TASK-012 GP invariants and TASK-014 typed API migration assertions passed.');
