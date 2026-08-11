const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-fund-security-'));
process.env.FUND_DATA_DIR = dataDir;
process.env.FUND_BACKUP_DIR = path.join(dataDir, 'backups');
process.env.FUND_EXTERNAL_SYNC = '0';

const pkg = require(path.join(root, 'package.json'));
const lock = require(path.join(root, 'package-lock.json'));
const { startServer } = require('../server');

function request(server, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1',
      port: server.address().port,
      path: pathname
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks)
      }));
    });
    req.on('error', reject);
  });
}

function parsePolicy(policy) {
  return new Map(policy.split(';').map(part => {
    const [name, ...values] = part.trim().split(/\s+/);
    return [name, values];
  }));
}

function resolveLocalReference(reference, basePath) {
  assert(!/^(?:https?:)?\/\//i.test(reference), `external resource is forbidden: ${reference}`);
  const resolved = new URL(reference, `http://local.test${basePath}`);
  assert.strictEqual(resolved.origin, 'http://local.test', `resource must stay same-origin: ${reference}`);
  return resolved.pathname;
}

function extractCssReferences(css) {
  const references = [];
  for (const match of css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    const reference = match[2].trim();
    if (reference && !reference.startsWith('data:') && !reference.startsWith('#')) references.push(reference);
  }
  return references;
}

(async () => {
  const dependencyVersions = {
    'chart.js': '4.5.1',
    sortablejs: '1.15.7',
    '@fontsource-variable/inter': '5.3.0',
    '@fontsource-variable/outfit': '5.3.0'
  };
  Object.entries(dependencyVersions).forEach(([name, version]) => {
    assert.strictEqual(pkg.dependencies[name], version, `${name} must use an exact version`);
    assert.strictEqual(lock.packages[`node_modules/${name}`].version, version, `${name} lock version must match`);
  });

  const server = startServer({ port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const page = await request(server, '/');
    assert.strictEqual(page.status, 200);
    assert.strictEqual(page.headers['x-content-type-options'], 'nosniff');

    const policy = parsePolicy(page.headers['content-security-policy']);
    assert.deepStrictEqual(policy.get('default-src'), ["'self'"]);
    assert.deepStrictEqual(policy.get('script-src'), ["'self'"]);
    assert.deepStrictEqual(policy.get('script-src-attr'), ["'none'"]);
    assert.deepStrictEqual(policy.get('style-src-elem'), ["'self'"]);
    assert.deepStrictEqual(policy.get('font-src'), ["'self'"]);
    assert.deepStrictEqual(policy.get('connect-src'), ["'self'"]);
    assert.deepStrictEqual(policy.get('frame-src'), ["'none'"]);
    assert.deepStrictEqual(policy.get('media-src'), ["'none'"]);
    assert.deepStrictEqual(policy.get('worker-src'), ["'none'"]);
    assert.deepStrictEqual(policy.get('manifest-src'), ["'none'"]);
    assert.deepStrictEqual(policy.get('object-src'), ["'none'"]);
    assert.deepStrictEqual(policy.get('frame-ancestors'), ["'none'"]);
    assert(!policy.get('script-src').includes("'unsafe-inline'"));
    assert(!policy.get('script-src').includes("'unsafe-eval'"));

    const html = page.body.toString('utf8');
    assert(!/<(?:script|link)\b[^>]+(?:src|href)=["']https?:\/\//i.test(html), 'page assets must not use HTTP CDNs');
    assert(!/<script\b(?![^>]*\bsrc=)[^>]*>/i.test(html), 'inline scripts are forbidden by the CSP');

    const htmlReferences = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["']/gi)]
      .map(match => resolveLocalReference(match[1], '/'));
    const pendingAssets = [...htmlReferences];
    const checkedAssets = new Set();
    while (pendingAssets.length) {
      const assetPath = pendingAssets.shift();
      if (checkedAssets.has(assetPath)) continue;
      checkedAssets.add(assetPath);
      const asset = await request(server, assetPath);
      assert.strictEqual(asset.status, 200, `${assetPath} must be served locally`);
      assert(asset.body.length > 0, `${assetPath} must not be empty`);
      assert.strictEqual(asset.headers['content-security-policy'], page.headers['content-security-policy']);
      if (assetPath.startsWith('/vendor/')) {
        assert(asset.headers['cache-control'].includes('immutable'), `${assetPath} must be immutable`);
      }
      if (assetPath.endsWith('.js')) {
        assert(/^(?:text|application)\/javascript\b/.test(asset.headers['content-type']), `${assetPath} must be JavaScript`);
        const source = asset.body.toString('utf8');
        assert(!/\beval\s*\(|\bnew\s+Function\b/.test(source), `${assetPath} requires forbidden unsafe-eval`);
      }
      if (assetPath.endsWith('.css')) {
        assert(asset.headers['content-type'].startsWith('text/css'), `${assetPath} must be CSS`);
        const css = asset.body.toString('utf8');
        extractCssReferences(css).forEach(reference => {
          pendingAssets.push(resolveLocalReference(reference, assetPath));
        });
      }
      if (assetPath.endsWith('.woff2')) {
        assert.strictEqual(asset.headers['content-type'], 'font/woff2', `${assetPath} must be a WOFF2 font`);
      }
    }
    assert(checkedAssets.has('/vendor/chart.js/4.5.1/chart.umd.min.js'));
    assert(checkedAssets.has('/vendor/sortablejs/1.15.7/Sortable.min.js'));
    assert(checkedAssets.has('/vendor/fonts/inter/5.3.0/files/inter-latin-wght-normal.woff2'));
    assert(checkedAssets.has('/vendor/fonts/outfit/5.3.0/files/outfit-latin-wght-normal.woff2'));
    assert(checkedAssets.size >= 45, `expected the complete resource graph, got ${checkedAssets.size} assets`);

    for (const invalidPath of [
      '/vendor/chart.js/0.0.0/chart.umd.min.js',
      '/vendor/sortablejs/0.0.0/Sortable.min.js',
      '/vendor/fonts/inter/5.3.0/files/%2e%2e%2fLICENSE'
    ]) {
      const invalidAsset = await request(server, invalidPath);
      assert.strictEqual(invalidAsset.status, 404, `${invalidPath} must not expose an asset`);
      const invalidPolicy = parsePolicy(invalidAsset.headers['content-security-policy']);
      assert(
        [["'self'"], ["'none'"]].some(value =>
          JSON.stringify(invalidPolicy.get('default-src')) === JSON.stringify(value)),
        `${invalidPath} must retain a restrictive CSP`
      );
    }

    const api = await request(server, '/api/state');
    assert.strictEqual(api.status, 200);
    assert.strictEqual(api.headers['content-security-policy'], page.headers['content-security-policy']);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log('Complete local resource graph and Content Security Policy assertions passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
