const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jsDirectory = path.join(__dirname, '..', 'public', 'js');
const files = fs.readdirSync(jsDirectory)
  .filter(file => file.endsWith('.js'))
  .sort();

assert(files.length > 0, 'public/js must contain browser scripts');
files.forEach(file => {
  const source = fs.readFileSync(path.join(jsDirectory, file), 'utf8');
  new vm.Script(source, { filename: file });
});

console.log(`Frontend syntax assertions passed for ${files.length} scripts.`);
