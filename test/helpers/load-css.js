const fs = require('fs');
const path = require('path');

function loadCssEntry(entryPath) {
  const directory = path.dirname(entryPath);
  const entry = fs.readFileSync(entryPath, 'utf8');
  const imports = [...entry.matchAll(/@import\s+url\(['"]?([^'"\)]+)['"]?\);/g)]
    .map(match => match[1]);
  if (!imports.length) return entry;
  return imports
    .map(file => fs.readFileSync(path.resolve(directory, file), 'utf8'))
    .join('\n');
}

module.exports = { loadCssEntry };
