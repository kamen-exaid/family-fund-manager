const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const storagePath = require.resolve('../lib/storage');
const originalDataDir = process.env.FUND_DATA_DIR;
const originalBackupDir = process.env.FUND_BACKUP_DIR;

function loadStorage(dataDir, backupDir) {
  process.env.FUND_DATA_DIR = dataDir;
  process.env.FUND_BACKUP_DIR = backupDir;
  delete require.cache[storagePath];
  return require('../lib/storage');
}

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'family-fund-storage-'));

try {
  // A successful write must back up the previously committed ledger, not the
  // new value that can already be read from db.json.
  const dataDir = path.join(testRoot, 'data-ok');
  const backupDir = path.join(testRoot, 'backups-ok');
  const storage = loadStorage(dataDir, backupDir);
  const originalDb = storage.readDb();
  const nextDb = { ...originalDb, cnhRate: 7.3 };
  storage.writeDb(nextDb);

  assert.deepStrictEqual(JSON.parse(fs.readFileSync(storage.DB_FILE, 'utf8')), nextDb);
  const backupFiles = fs.readdirSync(backupDir).filter(name => name.endsWith('.json'));
  assert.strictEqual(backupFiles.length, 1);
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(path.join(backupDir, backupFiles[0]), 'utf8')),
    originalDb
  );

  const originalConfig = storage.readConfig();
  const snapshotDb = { ...nextDb, cnhRate: 7.35, indexCache: nextDb.indexCache || {} };
  const snapshotConfig = { tickers: [{ ticker: 'AAPL' }] };
  storage.writeSnapshot(snapshotDb, snapshotConfig);
  assert.deepStrictEqual(storage.readDb(), snapshotDb);
  assert.deepStrictEqual(storage.readConfig(), snapshotConfig);

  const backupsBeforeTickerWrite = fs.readdirSync(backupDir).length;
  const tickerCache = {
    version: 1,
    updatedAt: '2026-08-04T00:00:00.000Z',
    tickers: { AAPL: { ticker: 'AAPL', ath: 250, updatedAt: '2026-08-04T00:00:00.000Z' } }
  };
  storage.writeTickerCache(tickerCache);
  assert.deepStrictEqual(storage.readTickerCache(), tickerCache);
  assert.strictEqual(fs.readdirSync(backupDir).length, backupsBeforeTickerWrite);

  // If the second live-file commit fails, the already replaced db.json must
  // roll back to the exact previous bytes and config.json must remain unchanged.
  const dbBeforeRollbackTest = fs.readFileSync(storage.DB_FILE, 'utf8');
  const configFile = path.join(dataDir, 'config.json');
  const configBeforeRollbackTest = fs.readFileSync(configFile, 'utf8');
  const originalRenameSync = fs.renameSync;
  try {
    fs.renameSync = (source, target) => {
      if (target === configFile && source.endsWith('.tmp')) {
        throw new Error('simulated config commit failure');
      }
      return originalRenameSync(source, target);
    };
    assert.throws(
      () => storage.writeSnapshot(
        { ...snapshotDb, cnhRate: 7.4 },
        { tickers: [{ ticker: 'MSFT' }] }
      ),
      /simulated config commit failure/
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.strictEqual(fs.readFileSync(storage.DB_FILE, 'utf8'), dbBeforeRollbackTest);
  assert.strictEqual(fs.readFileSync(configFile, 'utf8'), configBeforeRollbackTest);
  assert.deepStrictEqual(storage.readDb(), snapshotDb);
  assert.notDeepStrictEqual(originalConfig, snapshotConfig);

  // If the backup destination is unusable, writeDb must fail before touching
  // the committed database so retrying cannot duplicate a ledger operation.
  const blockedRoot = path.join(testRoot, 'blocked-backup');
  fs.writeFileSync(blockedRoot, 'not a directory');
  const blockedStorage = loadStorage(path.join(testRoot, 'data-blocked'), blockedRoot);
  const beforeFailure = blockedStorage.readDb();
  const beforeFailureRaw = fs.readFileSync(blockedStorage.DB_FILE, 'utf8');
  const originalConsoleError = console.error;
  try {
    console.error = () => {};
    assert.throws(() => blockedStorage.writeDb({ ...beforeFailure, cnhRate: 7.4 }));
  } finally {
    console.error = originalConsoleError;
  }
  assert.strictEqual(fs.readFileSync(blockedStorage.DB_FILE, 'utf8'), beforeFailureRaw);

  console.log('Storage commit/backup ordering and snapshot rollback assertions passed.');
} finally {
  if (originalDataDir === undefined) delete process.env.FUND_DATA_DIR;
  else process.env.FUND_DATA_DIR = originalDataDir;
  if (originalBackupDir === undefined) delete process.env.FUND_BACKUP_DIR;
  else process.env.FUND_BACKUP_DIR = originalBackupDir;
  delete require.cache[storagePath];
  fs.rmSync(testRoot, { recursive: true, force: true });
}
