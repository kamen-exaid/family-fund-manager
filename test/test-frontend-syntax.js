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

const appSource = fs.readFileSync(path.join(jsDirectory, 'app.js'), 'utf8');
assert(
  !/(?<![.\w])setDefaultDates\s*\(/.test(appSource),
  'app.js must use the injected date-time reset helper instead of a removed local function'
);

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const loadedScripts = [...html.matchAll(/<script\s+src="js\/([^"]+\.js)"/g)]
  .map(match => match[1]);
files.forEach(file => {
  assert(loadedScripts.includes(file), `${file} must be loaded by index.html`);
});
const appIndex = loadedScripts.indexOf('app.js');
assert(appIndex === loadedScripts.length - 1, 'app.js must load after all of its browser modules');

console.log(`Frontend syntax assertions passed for ${files.length} scripts.`);
