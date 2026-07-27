const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public', 'js', 'custom-select.js'), 'utf8');

assert(
  source.includes("selectedOption?.textContent || '请选择'"),
  'empty custom selects must show the expected default prompt'
);

const escapeHandler = source.match(
  /if \(event\.key === 'Escape'\) \{([\s\S]*?)\n    \}/
);
assert(escapeHandler, 'custom select Escape handler is missing');
assert(
  escapeHandler[1].includes('event.stopPropagation()'),
  'Escape from an open custom select must not close its parent modal'
);
assert(
  escapeHandler[1].includes('close(instance, true)'),
  'Escape must close the custom select and restore trigger focus'
);

console.log('Custom select keyboard interaction regression tests passed.');
