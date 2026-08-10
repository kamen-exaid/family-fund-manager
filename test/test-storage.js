const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const AdmZip = require('adm-zip');

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
  // Every durable mutation archives the complete intended state in the same
  // ZIP structure accepted by the manual restore endpoint.
  const dataDir = path.join(testRoot, 'data-ok');
  const backupDir = path.join(testRoot, 'backups-ok');
  const storage = loadStorage(dataDir, backupDir);
  const originalDb = storage.readDb();
  const nextDb = { ...originalDb, cnhRate: 7.3 };
  storage.writeDb(nextDb);

  assert.deepStrictEqual(JSON.parse(fs.readFileSync(storage.DB_FILE, 'utf8')), nextDb);
  const backupFiles = fs.readdirSync(backupDir).filter(name => name.startsWith('snapshot_backup_') && name.endsWith('.zip'));
  assert.strictEqual(backupFiles.length, 1);
  const firstBackup = new AdmZip(path.join(backupDir, backupFiles[0]));
  assert.deepStrictEqual(JSON.parse(firstBackup.readAsText('data/db.json')), nextDb);
  assert.deepStrictEqual(JSON.parse(firstBackup.readAsText('data/config.json')), storage.readConfig());
  assert.deepStrictEqual(JSON.parse(firstBackup.readAsText('data/settlements.json')), { version: 1, records: [] });

  const originalConfig = storage.readConfig();
  const snapshotDb = { ...nextDb, cnhRate: 7.35, indexCache: nextDb.indexCache || {} };
  const snapshotConfig = { tickers: [{ ticker: 'AAPL' }] };
  storage.writeSnapshot(snapshotDb, snapshotConfig);
  assert.deepStrictEqual(storage.readDb(), snapshotDb);
  assert.deepStrictEqual(storage.readConfig(), snapshotConfig);
  assert.deepStrictEqual(storage.readSettlements(), { version: 1, records: [] });
  const settlementLedger = {
    version: 1,
    records: [{ id: 's1', type: 'performance_settlement', date: '2026-01-01', createdAt: 1 }]
  };
  storage.writeSettlements(settlementLedger);
  assert.deepStrictEqual(storage.readSettlements(), settlementLedger);
  assert.notStrictEqual(storage.SETTLEMENTS_FILE, storage.DB_FILE);

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

  // A three-file restore is one logical commit. If settlements.json cannot be
  // replaced, db.json and config.json must both roll back as well.
  const dbBeforeSettlementFailure = fs.readFileSync(storage.DB_FILE, 'utf8');
  const configBeforeSettlementFailure = fs.readFileSync(configFile, 'utf8');
  const settlementsBeforeFailure = fs.readFileSync(storage.SETTLEMENTS_FILE, 'utf8');
  const nextSettlementLedger = {
    version: 1,
    records: [{ id: 's2', type: 'performance_settlement', date: '2027-01-01', createdAt: 2 }]
  };
  try {
    fs.renameSync = (source, target) => {
      if (target === storage.SETTLEMENTS_FILE && source.endsWith('.tmp')) {
        throw new Error('simulated settlement commit failure');
      }
      return originalRenameSync(source, target);
    };
    assert.throws(
      () => storage.writeSnapshot(
        { ...snapshotDb, cnhRate: 7.5 },
        { tickers: [{ ticker: 'NVDA' }] },
        nextSettlementLedger
      ),
      /simulated settlement commit failure/
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.strictEqual(fs.readFileSync(storage.DB_FILE, 'utf8'), dbBeforeSettlementFailure);
  assert.strictEqual(fs.readFileSync(configFile, 'utf8'), configBeforeSettlementFailure);
  assert.strictEqual(fs.readFileSync(storage.SETTLEMENTS_FILE, 'utf8'), settlementsBeforeFailure);
  assert.deepStrictEqual(storage.readDb(), snapshotDb);
  assert.deepStrictEqual(storage.readConfig(), snapshotConfig);
  assert.deepStrictEqual(storage.readSettlements(), settlementLedger);

  // Once initialized, a missing settlement ledger is data loss, not a fresh
  // install. Fail closed instead of silently recreating an empty file.
  const savedSettlementContent = fs.readFileSync(storage.SETTLEMENTS_FILE, 'utf8');
  fs.unlinkSync(storage.SETTLEMENTS_FILE);
  storage.clearDbCache();
  assert.throws(() => storage.readSettlements(), /Settlement ledger is missing/);
  fs.writeFileSync(storage.SETTLEMENTS_FILE, savedSettlementContent, 'utf8');
  storage.clearDbCache();
  assert.deepStrictEqual(storage.readSettlements(), settlementLedger);

  // Simulate a process dying immediately after db.json is replaced. The next
  // process must observe the durable journal and restore the entire old
  // generation before serving any reads.
  const crashDataDir = path.join(testRoot, 'data-crash');
  const crashBackupDir = path.join(testRoot, 'backups-crash');
  let crashStorage = loadStorage(crashDataDir, crashBackupDir);
  crashStorage.readDb();
  crashStorage.clearDbCache();
  const crashDb = crashStorage.readDb();
  const crashConfig = crashStorage.readConfig();
  const crashSettlements = crashStorage.readSettlements();
  const crashBefore = {
    db: fs.readFileSync(crashStorage.DB_FILE, 'utf8'),
    config: fs.readFileSync(path.join(crashDataDir, 'config.json'), 'utf8'),
    settlements: fs.readFileSync(crashStorage.SETTLEMENTS_FILE, 'utf8'),
    marker: fs.readFileSync(crashStorage.SETTLEMENTS_MARKER_FILE, 'utf8')
  };
  const crashScript = `
    const fs = require('fs');
    const storage = require(process.env.FUND_STORAGE_MODULE);
    const db = storage.readDb();
    const config = storage.readConfig();
    const settlements = storage.readSettlements();
    const originalRename = fs.renameSync;
    fs.renameSync = (source, target) => {
      const result = originalRename(source, target);
      if (target === storage.DB_FILE && source.endsWith('.tmp')) process.exit(73);
      return result;
    };
    storage.writeSnapshot(
      { ...db, cnhRate: 9.9 },
      { tickers: [{ ticker: 'CRASH' }] },
      { version: 1, records: [{ id: 'crash-s', type: 'performance_settlement', date: '2028-01-01', createdAt: 1 }] }
    );
  `;
  const crashed = spawnSync(process.execPath, ['-e', crashScript], {
    env: {
      ...process.env,
      FUND_DATA_DIR: crashDataDir,
      FUND_BACKUP_DIR: crashBackupDir,
      FUND_STORAGE_MODULE: storagePath
    }
  });
  assert.strictEqual(crashed.status, 73);
  assert(fs.existsSync(crashStorage.SNAPSHOT_JOURNAL_FILE));
  crashStorage = loadStorage(crashDataDir, crashBackupDir);
  assert.strictEqual(fs.readFileSync(crashStorage.DB_FILE, 'utf8'), crashBefore.db);
  assert.strictEqual(fs.readFileSync(path.join(crashDataDir, 'config.json'), 'utf8'), crashBefore.config);
  assert.strictEqual(fs.readFileSync(crashStorage.SETTLEMENTS_FILE, 'utf8'), crashBefore.settlements);
  assert.strictEqual(fs.readFileSync(crashStorage.SETTLEMENTS_MARKER_FILE, 'utf8'), crashBefore.marker);
  assert(!fs.existsSync(crashStorage.SNAPSHOT_JOURNAL_FILE));
  assert.deepStrictEqual(crashStorage.readDb(), crashDb);
  assert.deepStrictEqual(crashStorage.readConfig(), crashConfig);
  assert.deepStrictEqual(crashStorage.readSettlements(), crashSettlements);

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
