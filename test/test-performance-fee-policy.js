const assert = require('assert');
const { createDisposalFeeSnapshot } = require('../lib/performance-fee-policy');
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

console.log('Performance-fee policy and GP invariant assertions passed.');
