const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { DEFAULT_PERFORMANCE_FEE_CONFIG } = require('./performance-fee-policy');

// A dedicated directory is useful for automated integration tests and keeps
// test runs from ever touching a user's local ledger.
const DATA_DIR = process.env.FUND_DATA_DIR
  ? path.resolve(process.env.FUND_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const BACKUP_DIR = process.env.FUND_BACKUP_DIR
  ? path.resolve(process.env.FUND_BACKUP_DIR)
  : path.join(DATA_DIR, '..', 'backups');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const INDEX_CACHE_FILE = path.join(DATA_DIR, 'index-cache.json');
const TICKER_CACHE_FILE = path.join(DATA_DIR, 'ticker-cache.json');
const SETTLEMENTS_FILE = path.join(DATA_DIR, 'settlements.json');
const SETTLEMENTS_MARKER_FILE = path.join(DATA_DIR, '.settlements-initialized');
const SNAPSHOT_JOURNAL_FILE = path.join(DATA_DIR, '.snapshot-transaction.json');

const DEFAULT_DB = {
  cnhRate: 7.2,
  benchmarkClosePolicy: 'previous',
  performanceFee: DEFAULT_PERFORMANCE_FEE_CONFIG,
  members: [
    { id: 'me', name: '我', roles: { lp: true, gp: false } },
    { id: 'mother', name: '母亲', roles: { lp: true, gp: false } },
    { id: 'father', name: '父亲', roles: { lp: true, gp: false } }
  ],
  events: []
};

const DEFAULT_CONFIG = {
  tickers: [
    { ticker: 'VOO' },
    { ticker: 'QQQM' },
    { ticker: 'VGT' },
    { ticker: 'SMH' }
  ]
};

const DEFAULT_TICKER_CACHE = {
  version: 1,
  updatedAt: null,
  tickers: {}
};
const DEFAULT_SETTLEMENTS = { version: 1, records: [] };

let dbCache = null;
let indexCacheCache = null;
let settlementsCache = null;
let tempFileSequence = 0;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureDataDirs() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

// Keep each individual file intact if the process or machine stops midway
// through a write. The temporary file lives beside the target so rename is
// atomic on the same volume; multi-file commits add a durable journal below.
function prepareTempFile(filePath, content) {
  const sequence = String(tempFileSequence++).padStart(6, '0');
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.${sequence}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tempFile, 'w', 0o600);
    if (Buffer.isBuffer(content)) fs.writeFileSync(fd, content);
    else fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    return tempFile;
  } catch (error) {
    if (fd !== undefined && fd !== null) fs.closeSync(fd);
    try { fs.unlinkSync(tempFile); } catch (_) { /* temp file may not exist */ }
    throw error;
  }
}

function atomicWriteFile(filePath, content) {
  const tempFile = prepareTempFile(filePath, content);
  try {
    fs.renameSync(tempFile, filePath);
  } catch (error) {
    try { fs.unlinkSync(tempFile); } catch (_) { /* temp file may not exist */ }
    throw error;
  }
}

function recoverInterruptedSnapshot() {
  if (!fs.existsSync(SNAPSHOT_JOURNAL_FILE)) return false;
  let journal;
  try {
    journal = JSON.parse(fs.readFileSync(SNAPSHOT_JOURNAL_FILE, 'utf8'));
    if (journal?.version !== 1 || !journal.previous ||
        !['db', 'config', 'settlements', 'marker'].every(key =>
          journal.previous[key] === null || typeof journal.previous[key] === 'string')) {
      throw new Error('invalid snapshot recovery journal');
    }
    restoreFile(DB_FILE, journal.previous.db);
    restoreFile(CONFIG_FILE, journal.previous.config);
    restoreFile(SETTLEMENTS_FILE, journal.previous.settlements);
    restoreFile(SETTLEMENTS_MARKER_FILE, journal.previous.marker);
    fs.unlinkSync(SNAPSHOT_JOURNAL_FILE);
    dbCache = null;
    indexCacheCache = null;
    settlementsCache = null;
    return true;
  } catch (error) {
    throw new Error(`Interrupted snapshot cannot be recovered: ${error.message}`);
  }
}

function withoutIndexCache(dbData) {
  const coreDb = clone(dbData);
  delete coreDb.indexCache;
  return coreDb;
}

function assertValidEventSequenceHighWater(data, label) {
  if (data?.lastEventSequence !== undefined &&
      (!Number.isSafeInteger(data.lastEventSequence) || data.lastEventSequence < 0)) {
    throw new Error(`${label} contains an invalid event sequence high-water mark.`);
  }
}

function readIndexCache() {
  ensureDataDirs();
  if (indexCacheCache) return clone(indexCacheCache);
  if (!fs.existsSync(INDEX_CACHE_FILE)) return {};

  try {
    const cache = JSON.parse(fs.readFileSync(INDEX_CACHE_FILE, 'utf8'));
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) {
      throw new Error('invalid index cache format');
    }
    indexCacheCache = cache;
    return clone(cache);
  } catch (error) {
    // Benchmark prices are disposable market data. A damaged cache must not
    // make the financial ledger unavailable; the background worker rebuilds it.
    console.error('Error reading index cache; it will be rebuilt:', error.message);
    indexCacheCache = {};
    return clone(indexCacheCache);
  }
}

function writeIndexCache(cacheData) {
  ensureDataDirs();
  if (!cacheData || typeof cacheData !== 'object' || Array.isArray(cacheData)) {
    throw new Error('Refusing to write invalid index cache data.');
  }
  const normalized = clone(cacheData);
  atomicWriteFile(INDEX_CACHE_FILE, JSON.stringify(normalized, null, 2));
  indexCacheCache = normalized;
}

function readDb() {
  ensureDataDirs();
  if (dbCache) return clone(dbCache);

  try {
    if (!fs.existsSync(DB_FILE)) {
      atomicWriteFile(DB_FILE, JSON.stringify(DEFAULT_DB, null, 2));
      dbCache = DEFAULT_DB;
      return clone(DEFAULT_DB);
    }

    const dbData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    assertValidEventSequenceHighWater(dbData, 'Database');
    let migrated = false;

    // v3.10 and earlier embedded disposable benchmark prices in db.json. Move
    // them to their own file before removing the legacy field, so an interrupted
    // migration can safely retry without losing the last usable cache.
    if (Object.prototype.hasOwnProperty.call(dbData, 'indexCache')) {
      const legacyCache = dbData.indexCache;
      if (legacyCache && typeof legacyCache === 'object' && !Array.isArray(legacyCache)) {
        // The embedded field is the migration source of truth. This also
        // handles a user temporarily returning to an older application build:
        // newer legacy entries replace stale same-date entries in the external
        // cache, while external-only dates are retained.
        writeIndexCache({ ...readIndexCache(), ...legacyCache });
      }
      delete dbData.indexCache;
      migrated = true;
    }

    if (!dbData.members) {
      dbData.members = clone(DEFAULT_DB.members);
      migrated = true;
    }
    if (dbData.cnhRate === undefined) {
      dbData.cnhRate = DEFAULT_DB.cnhRate;
      migrated = true;
    }
    if (dbData.benchmarkClosePolicy !== 'previous') {
      dbData.benchmarkClosePolicy = DEFAULT_DB.benchmarkClosePolicy;
      migrated = true;
    }
    if (!dbData.performanceFee) {
      dbData.performanceFee = clone(DEFAULT_DB.performanceFee);
      migrated = true;
    }
    dbData.members.forEach(member => {
      const normalizedRoles = {
        lp: true,
        gp: dbData.performanceFee.gpMemberId === member.id
      };
      if (member.roles?.lp !== true || member.roles?.gp !== normalizedRoles.gp) {
        member.roles = normalizedRoles;
        migrated = true;
      }
    });

    if (migrated) {
      atomicWriteFile(DB_FILE, JSON.stringify(dbData, null, 2));
    }
    dbCache = dbData;
    return clone(dbData);
  } catch (error) {
    console.error('Error reading database:', error);
    // Never silently return an empty ledger: a later write could otherwise
    // overwrite a recoverable but malformed database file.
    throw new Error(`Database cannot be read: ${error.message}`);
  }
}

function writeDb(dbData) {
  ensureDataDirs();
  assertValidEventSequenceHighWater(dbData, 'Database');
  const nextContent = JSON.stringify(withoutIndexCache(dbData), null, 2);
  try {
    // Archive the complete intended state before committing it. If backup
    // creation fails, abort before any live data is changed.
    writeCoreBackup(
      nextContent,
      JSON.stringify(readConfig(), null, 2),
      JSON.stringify(readSettlements(), null, 2)
    );
    atomicWriteFile(DB_FILE, nextContent);
    dbCache = JSON.parse(nextContent);
  } catch (error) {
    console.error('Error writing database:', error);
    dbCache = null;
    throw error;
  }
}

function readSettlements() {
  ensureDataDirs();
  if (settlementsCache) return clone(settlementsCache);
  if (!fs.existsSync(SETTLEMENTS_FILE)) {
    if (fs.existsSync(SETTLEMENTS_MARKER_FILE)) {
      throw new Error('Settlement ledger is missing. Restore data/settlements.json from a complete backup; an empty ledger will not be created automatically.');
    }
    atomicWriteFile(SETTLEMENTS_FILE, JSON.stringify(DEFAULT_SETTLEMENTS, null, 2));
    atomicWriteFile(SETTLEMENTS_MARKER_FILE, JSON.stringify({ version: 1 }));
    settlementsCache = DEFAULT_SETTLEMENTS;
    return clone(DEFAULT_SETTLEMENTS);
  }
  try {
    const data = JSON.parse(fs.readFileSync(SETTLEMENTS_FILE, 'utf8'));
    if (data?.version !== 1 || !Array.isArray(data.records) ||
        (data.lastEventSequence !== undefined &&
         (!Number.isSafeInteger(data.lastEventSequence) || data.lastEventSequence < 0))) {
      throw new Error('invalid settlements format');
    }
    if (!fs.existsSync(SETTLEMENTS_MARKER_FILE)) {
      atomicWriteFile(SETTLEMENTS_MARKER_FILE, JSON.stringify({ version: 1 }));
    }
    settlementsCache = data;
    return clone(data);
  } catch (error) {
    throw new Error(`Settlement ledger cannot be read: ${error.message}`);
  }
}

function writeSettlements(data) {
  ensureDataDirs();
  if (data?.version !== 1 || !Array.isArray(data.records)) {
    throw new Error('Refusing to replace settlement ledger with invalid data.');
  }
  if (data.lastEventSequence !== undefined &&
      (!Number.isSafeInteger(data.lastEventSequence) || data.lastEventSequence < 0)) {
    throw new Error('Refusing to replace settlement ledger with an invalid event sequence high-water mark.');
  }
  const normalized = {
    version: 1,
    records: data.records,
    ...(data.lastEventSequence > 0 ? { lastEventSequence: data.lastEventSequence } : {})
  };
  writeCoreBackup(
    JSON.stringify(readDb(), null, 2),
    JSON.stringify(readConfig(), null, 2),
    JSON.stringify(normalized, null, 2)
  );
  atomicWriteFile(SETTLEMENTS_FILE, JSON.stringify(normalized, null, 2));
  if (!fs.existsSync(SETTLEMENTS_MARKER_FILE)) {
    atomicWriteFile(SETTLEMENTS_MARKER_FILE, JSON.stringify({ version: 1 }));
  }
  settlementsCache = clone(normalized);
}

function writeCoreBackup(dbContent, configContent, settlementsContent) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sequence = String(tempFileSequence++).padStart(6, '0');
  const backupFile = path.join(BACKUP_DIR, `snapshot_backup_${timestamp}_${sequence}.zip`);
  const zip = new AdmZip();
  zip.addFile('data/db.json', Buffer.from(dbContent, 'utf8'));
  zip.addFile('data/config.json', Buffer.from(configContent, 'utf8'));
  zip.addFile('data/settlements.json', Buffer.from(settlementsContent, 'utf8'));
  atomicWriteFile(backupFile, zip.toBuffer());
  const backupFiles = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('snapshot_backup_') && f.endsWith('.zip'))
    .sort().reverse();
  backupFiles.slice(15).forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
}

function readConfig() {
  ensureDataDirs();
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      atomicWriteFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
      return clone(DEFAULT_CONFIG);
    }

    const configData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (!configData.tickers) {
      configData.tickers = Array.isArray(configData.etfs)
        ? configData.etfs
        : clone(DEFAULT_CONFIG.tickers);
      delete configData.etfs;
      atomicWriteFile(CONFIG_FILE, JSON.stringify(configData, null, 2));
    }
    return configData;
  } catch (error) {
    console.error('Error reading config:', error);
    throw new Error(`Configuration cannot be read: ${error.message}`);
  }
}

function writeConfig(configData) {
  ensureDataDirs();
  try {
    const nextContent = JSON.stringify(configData, null, 2);
    writeCoreBackup(
      JSON.stringify(readDb(), null, 2),
      nextContent,
      JSON.stringify(readSettlements(), null, 2)
    );
    atomicWriteFile(CONFIG_FILE, nextContent);
  } catch (error) {
    console.error('Error writing config:', error);
    throw error;
  }
}

// Market data is disposable and changes frequently, so keep it outside db.json:
// refreshing quotes must not create ledger backups or invalidate calculation state.
function readTickerCache() {
  ensureDataDirs();
  if (!fs.existsSync(TICKER_CACHE_FILE)) return clone(DEFAULT_TICKER_CACHE);

  try {
    const cache = JSON.parse(fs.readFileSync(TICKER_CACHE_FILE, 'utf8'));
    if (cache?.version !== DEFAULT_TICKER_CACHE.version ||
        !cache.tickers || typeof cache.tickers !== 'object' || Array.isArray(cache.tickers)) {
      return clone(DEFAULT_TICKER_CACHE);
    }
    return cache;
  } catch (error) {
    // Unlike the ledger, this file can always be rebuilt from Yahoo. Do not make
    // an otherwise healthy application unavailable because a cache is malformed.
    console.error('Error reading ticker cache; it will be rebuilt:', error.message);
    return clone(DEFAULT_TICKER_CACHE);
  }
}

function writeTickerCache(cacheData) {
  ensureDataDirs();
  const normalized = {
    version: DEFAULT_TICKER_CACHE.version,
    updatedAt: cacheData?.updatedAt || new Date().toISOString(),
    tickers: cacheData?.tickers && typeof cacheData.tickers === 'object'
      ? cacheData.tickers
      : {}
  };
  atomicWriteFile(TICKER_CACHE_FILE, JSON.stringify(normalized, null, 2));
}

function restoreFile(filePath, previousContent) {
  if (previousContent === null) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return;
  }
  atomicWriteFile(filePath, previousContent);
}

function writeSnapshot(dbData, configData, settlementsData) {
  ensureDataDirs();
  assertValidEventSequenceHighWater(dbData, 'Database snapshot');
  const nextDbContent = JSON.stringify(withoutIndexCache(dbData), null, 2);
  const nextConfigContent = JSON.stringify(configData, null, 2);
  if (settlementsData !== undefined &&
      (settlementsData?.version !== 1 || !Array.isArray(settlementsData.records))) {
    throw new Error('Refusing to restore invalid settlement ledger data.');
  }
  const currentSettlements = settlementsData === undefined ? readSettlements() : settlementsData;
  if (currentSettlements.lastEventSequence !== undefined &&
      (!Number.isSafeInteger(currentSettlements.lastEventSequence) || currentSettlements.lastEventSequence < 0)) {
    throw new Error('Refusing to restore an invalid event sequence high-water mark.');
  }
  const nextSettlementsContent = JSON.stringify({
    version: 1,
    records: currentSettlements.records,
    ...(currentSettlements.lastEventSequence > 0
      ? { lastEventSequence: currentSettlements.lastEventSequence }
      : {})
  }, null, 2);
  const shouldCommitSettlements = settlementsData !== undefined;
  const nextMarkerContent = JSON.stringify({ version: 1 });
  const previousDbContent = fs.existsSync(DB_FILE) ? fs.readFileSync(DB_FILE, 'utf8') : null;
  const previousConfigContent = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf8') : null;
  const previousSettlementsContent = fs.existsSync(SETTLEMENTS_FILE)
    ? fs.readFileSync(SETTLEMENTS_FILE, 'utf8')
    : null;
  const previousMarkerContent = fs.existsSync(SETTLEMENTS_MARKER_FILE)
    ? fs.readFileSync(SETTLEMENTS_MARKER_FILE, 'utf8')
    : null;

  let dbTempFile = null;
  let configTempFile = null;
  let settlementsTempFile = null;
  let markerTempFile = null;
  let dbCommitted = false;
  let configCommitted = false;
  let settlementsCommitted = false;
  let markerCommitted = false;
  let journalPrepared = false;

  try {
    writeCoreBackup(nextDbContent, nextConfigContent, nextSettlementsContent);

    // Prepare every durable file before replacing any live file.
    dbTempFile = prepareTempFile(DB_FILE, nextDbContent);
    configTempFile = prepareTempFile(CONFIG_FILE, nextConfigContent);
    if (shouldCommitSettlements) {
      settlementsTempFile = prepareTempFile(SETTLEMENTS_FILE, nextSettlementsContent);
    }
    markerTempFile = prepareTempFile(SETTLEMENTS_MARKER_FILE, nextMarkerContent);
    atomicWriteFile(SNAPSHOT_JOURNAL_FILE, JSON.stringify({
      version: 1,
      previous: {
        db: previousDbContent,
        config: previousConfigContent,
        settlements: previousSettlementsContent,
        marker: previousMarkerContent
      }
    }));
    journalPrepared = true;

    fs.renameSync(dbTempFile, DB_FILE);
    dbTempFile = null;
    dbCommitted = true;

    fs.renameSync(configTempFile, CONFIG_FILE);
    configTempFile = null;
    configCommitted = true;

    if (settlementsTempFile) {
      fs.renameSync(settlementsTempFile, SETTLEMENTS_FILE);
      settlementsTempFile = null;
      settlementsCommitted = true;
    }

    fs.renameSync(markerTempFile, SETTLEMENTS_MARKER_FILE);
    markerTempFile = null;
    markerCommitted = true;

    fs.unlinkSync(SNAPSHOT_JOURNAL_FILE);
    journalPrepared = false;

    dbCache = JSON.parse(nextDbContent);
    if (shouldCommitSettlements) {
      settlementsCache = JSON.parse(nextSettlementsContent);
    }
  } catch (error) {
    if (dbTempFile) try { fs.unlinkSync(dbTempFile); } catch (_) { /* best effort */ }
    if (configTempFile) try { fs.unlinkSync(configTempFile); } catch (_) { /* best effort */ }
    if (settlementsTempFile) try { fs.unlinkSync(settlementsTempFile); } catch (_) { /* best effort */ }
    if (markerTempFile) try { fs.unlinkSync(markerTempFile); } catch (_) { /* best effort */ }

    const rollbackErrors = [];
    if (markerCommitted) {
      try { restoreFile(SETTLEMENTS_MARKER_FILE, previousMarkerContent); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (settlementsCommitted) {
      try { restoreFile(SETTLEMENTS_FILE, previousSettlementsContent); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (dbCommitted) {
      try { restoreFile(DB_FILE, previousDbContent); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (configCommitted) {
      try { restoreFile(CONFIG_FILE, previousConfigContent); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    dbCache = null;
    settlementsCache = null;

    if (journalPrepared && rollbackErrors.length === 0) {
      try {
        fs.unlinkSync(SNAPSHOT_JOURNAL_FILE);
        journalPrepared = false;
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }

    if (rollbackErrors.length > 0) {
      throw new Error(`Snapshot write failed (${error.message}) and rollback was incomplete (${rollbackErrors.map(item => item.message).join('; ')}).`);
    }
    throw error;
  }
}

function clearDbCache() {
  dbCache = null;
  indexCacheCache = null;
  settlementsCache = null;
}

ensureDataDirs();
recoverInterruptedSnapshot();

module.exports = {
  DB_FILE,
  INDEX_CACHE_FILE,
  TICKER_CACHE_FILE,
  SETTLEMENTS_FILE,
  SETTLEMENTS_MARKER_FILE,
  SNAPSHOT_JOURNAL_FILE,
  readDb,
  writeDb,
  readIndexCache,
  writeIndexCache,
  readSettlements,
  writeSettlements,
  readConfig,
  writeConfig,
  readTickerCache,
  writeTickerCache,
  writeSnapshot,
  clearDbCache,
  atomicWriteFile
};
