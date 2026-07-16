const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-fund-api-'));
process.env.FUND_DATA_DIR = dataDir;
process.env.FUND_EXTERNAL_SYNC = '0';

const { startServer } = require('./server');

function request(server, method, pathname, body) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: pathname,
      method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  const server = startServer({ port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  try {
    let response = await request(server, 'GET', '/api/state');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.data.summary.totalNAV, 0);

    response = await request(server, 'POST', '/api/transaction', {
      member: 'me', type: 'deposit', amount: 100.1, cnhAmount: 720.72, date: '2026-03-01', remark: 'initial funding'
    });
    assert.strictEqual(response.status, 200);

    response = await request(server, 'POST', '/api/valuation', {
      totalNAV: 120.12, date: '2026-03-02', remark: 'mark to market'
    });
    assert.strictEqual(response.status, 200);

    response = await request(server, 'POST', '/api/transaction', {
      member: 'me', type: 'withdraw', amount: 200, date: '2026-03-03'
    });
    assert.strictEqual(response.status, 400);

    response = await request(server, 'GET', '/api/backup/export');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.events.length, 2);

    response = await request(server, 'GET', '/api/state');
    assert.strictEqual(response.body.data.summary.totalNAV, 120.12);
    assert.strictEqual(response.body.data.members.me.currentValue, 120.12);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log('HTTP API integration tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
