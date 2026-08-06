const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-fund-api-'));
process.env.FUND_DATA_DIR = dataDir;
process.env.FUND_EXTERNAL_SYNC = '0';

const { startServer } = require('../server');

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

function requestBuffer(server, method, pathname, body, contentType = 'application/zip') {
  return new Promise((resolve, reject) => {
    const headers = body ? { 'Content-Type': contentType, 'Content-Length': body.length } : {};
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: pathname,
      method,
      headers
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
    if (body) req.write(body);
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
      totalNAV: 0, date: '2026-03-02', remark: 'invalid zero valuation'
    });
    assert.strictEqual(response.status, 400);

    response = await request(server, 'POST', '/api/valuation', {
      totalNAV: 120.12, date: '2026-03-02', remark: 'mark to market'
    });
    assert.strictEqual(response.status, 200);
    const valuationId = response.body.data.id;

    response = await request(server, 'POST', '/api/transaction', {
      member: 'me', type: 'withdraw', amount: 200, date: '2026-03-08'
    });
    assert.strictEqual(response.status, 400);

    response = await request(server, 'POST', '/api/transaction', {
      member: 'me', type: 'withdraw', amount: 120, date: '2026-03-08'
    });
    assert.strictEqual(response.status, 200);

    // Editing the valuation down would also make the later withdrawal underfunded.
    response = await request(server, 'PUT', `/api/event/${valuationId}`, { totalNAV: 100 });
    assert.strictEqual(response.status, 400);

    // Removing the historical valuation would make the later $120 withdrawal
    // underfunded. Reject the mutation rather than silently capping the withdrawal.
    response = await request(server, 'DELETE', `/api/event/${valuationId}`);
    assert.strictEqual(response.status, 400);

    const exported = await requestBuffer(server, 'GET', '/api/backup/export');
    assert.strictEqual(exported.status, 200);
    assert.strictEqual(exported.headers['content-type'], 'application/zip');
    const backupZip = new AdmZip(exported.body);
    const exportedDb = JSON.parse(backupZip.readAsText('data/db.json'));
    const exportedConfig = JSON.parse(backupZip.readAsText('data/config.json'));
    const exportedSettlements = JSON.parse(backupZip.readAsText('data/settlements.json'));
    assert.strictEqual(exportedDb.events.length, 3);
    assert(Array.isArray(exportedConfig.tickers));
    assert.deepStrictEqual(exportedSettlements, { version: 1, records: [] });

    response = await request(server, 'POST', '/api/settings/tickers', {
      tickers: [{ ticker: 'AAPL' }]
    });
    assert.strictEqual(response.status, 200);

    const restored = await requestBuffer(server, 'POST', '/api/backup/import', exported.body);
    assert.strictEqual(restored.status, 200);
    const restoredPayload = JSON.parse(restored.body.toString('utf8'));
    assert.strictEqual(restoredPayload.success, true);

    response = await request(server, 'GET', '/api/settings/tickers');
    assert.deepStrictEqual(response.body.data, exportedConfig.tickers);

    const zeroNavBackup = new AdmZip();
    zeroNavBackup.addFile('data/db.json', Buffer.from(JSON.stringify({
      ...exportedDb,
      events: [
        { id: 'zero_base', type: 'deposit', member: 'me', amount: 100, cnhAmount: 720, date: '2026-01-01', createdAt: 1 },
        { id: 'zero_mark', type: 'valuation', totalNAV: 0, date: '2026-01-02', createdAt: 2 }
      ]
    })));
    zeroNavBackup.addFile('data/config.json', Buffer.from(JSON.stringify(exportedConfig)));
    const rejectedZeroNavRestore = await requestBuffer(
      server,
      'POST',
      '/api/backup/import',
      zeroNavBackup.toBuffer()
    );
    assert.strictEqual(rejectedZeroNavRestore.status, 400);

    const preInceptionBackup = new AdmZip();
    preInceptionBackup.addFile('data/db.json', Buffer.from(JSON.stringify({
      ...exportedDb,
      events: [
        { id: 'early_mark', type: 'valuation', totalNAV: 500, date: '2026-01-01', createdAt: 1 },
        { id: 'later_deposit', type: 'deposit', member: 'me', amount: 100, cnhAmount: 720, date: '2026-01-02', createdAt: 2 }
      ]
    })));
    preInceptionBackup.addFile('data/config.json', Buffer.from(JSON.stringify(exportedConfig)));
    const rejectedPreInceptionRestore = await requestBuffer(
      server,
      'POST',
      '/api/backup/import',
      preInceptionBackup.toBuffer()
    );
    assert.strictEqual(rejectedPreInceptionRestore.status, 400);

    response = await request(server, 'GET', '/api/state');
    assert.strictEqual(response.body.data.summary.totalNAV, 0.12);
    assert.strictEqual(response.body.data.members.me.currentValue, 0.12);

    // Exercise the production settlement ledger merge: a reversed settlement
    // must disappear from the active event stream so the same date can be used
    // again.
    response = await request(server, 'PUT', '/api/members/father/roles', {
      gp: true, primaryGp: true
    });
    assert.strictEqual(response.status, 200);
    response = await request(server, 'POST', '/api/valuation', {
      totalNAV: 1.2, date: '2026-03-09', remark: 'settlement regression valuation'
    });
    assert.strictEqual(response.status, 200);
    response = await request(server, 'POST', '/api/performance-settlement', {
      date: '2026-03-09'
    });
    assert.strictEqual(response.status, 200);
    response = await request(server, 'POST', '/api/performance-settlement/reverse-latest', {
      remark: 'same-day settlement regression'
    });
    assert.strictEqual(response.status, 200);
    response = await request(server, 'POST', '/api/performance-settlement', {
      date: '2026-03-09'
    });
    assert.strictEqual(response.status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log('HTTP API integration tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
