const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'submission-guard.js'),
  'utf8'
);
const context = { window: {} };
vm.createContext(context);
vm.runInContext(source, context);

const button = { disabled: false };
const attributes = new Map();
const form = {
  dataset: {},
  querySelectorAll: selector => selector === 'button[type="submit"]' ? [button] : [],
  setAttribute: (name, value) => attributes.set(name, value),
  removeAttribute: name => attributes.delete(name)
};

let releaseTask;
let executions = 0;
const pendingTask = new Promise(resolve => { releaseTask = resolve; });
const runTask = () => {
  executions++;
  return pendingTask;
};

(async () => {
  const first = context.window.FundSubmission.runOnce(form, runTask);
  const duplicate = context.window.FundSubmission.runOnce(form, runTask);

  assert.strictEqual(executions, 1, 'a second submission must not start while the first is pending');
  assert.strictEqual(form.dataset.submitting, 'true', 'the form must expose its pending state');
  assert.strictEqual(attributes.get('aria-busy'), 'true', 'the form must be marked busy');
  assert.strictEqual(button.disabled, true, 'submit buttons must be disabled while pending');

  releaseTask();
  await Promise.all([first, duplicate]);

  assert.strictEqual(form.dataset.submitting, undefined, 'the pending state must be cleared');
  assert.strictEqual(attributes.has('aria-busy'), false, 'the busy state must be cleared');
  assert.strictEqual(button.disabled, false, 'the original button state must be restored');
  console.log('Submission guard duplicate-submit assertions passed.');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
