const fs = require('fs');
const path = require('path');

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
const TICKER_CACHE_FILE = path.join(DATA_DIR, 'ticker-cache.json');

const DEFAULT_DB = {
  cnhRate: 7.2,
  benchmarkClosePolicy: 'previous',
  members: [
    { id: 'me', name: '我' },
    { id: 'mother', name: '母亲' },
    { id: 'father', name: '父亲' }
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

let dbCache = null;
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

// Keep the previous database intact if the process or machine stops midway
// through a write.  The temporary file lives beside the target so rename is
// atomic on the same volume.
function prepareTempFile(filePath, content) {
  const sequence = String(tempFileSequence++).padStart(6, '0');
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.${sequence}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tempFile, 'w', 0o600);
    fs.writeFileSync(fd, content, 'utf8');
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
    let migrated = false;

    if (!dbData.members) {
      dbData.members = clone(DEFAULT_DB.members);
      migrated = true;
    }
    if (dbData.cnhRate === undefined) {
      dbData.cnhRate = DEFAULT_DB.cnhRate;
      migrated = true;
    }
    if (!dbData.indexCache) {
      dbData.indexCache = {};
      migrated = true;
    }
    if (!['previous', 'same_day'].includes(dbData.benchmarkClosePolicy)) {
      dbData.benchmarkClosePolicy = DEFAULT_DB.benchmarkClosePolicy;
      migrated = true;
    }

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
  const nextContent = JSON.stringify(dbData, null, 2);
  try {
    // Back up the last committed ledger before replacing it. If backup creation
    // fails, abort here so the API never reports failure after data was saved.
    if (fs.existsSync(DB_FILE)) {
      writeBackupContent(fs.readFileSync(DB_FILE, 'utf8'));
    }
    atomicWriteFile(DB_FILE, nextContent);
    dbCache = JSON.parse(nextContent);
  } catch (error) {
    console.error('Error writing database:', error);
    dbCache = null;
    throw error;
  }
}

function writeBackupContent(backupContent) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(BACKUP_DIR, `db_backup_${timestamp}.json`);

  atomicWriteFile(backupFile, backupContent);
  const backupFiles = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('db_backup_') && f.endsWith('.json'))
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
    atomicWriteFile(CONFIG_FILE, JSON.stringify(configData, null, 2));
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

function writeSnapshot(dbData, configData) {
  ensureDataDirs();
  const nextDbContent = JSON.stringify(dbData, null, 2);
  const nextConfigContent = JSON.stringify(configData, null, 2);
  const previousDbContent = fs.existsSync(DB_FILE) ? fs.readFileSync(DB_FILE, 'utf8') : null;
  const previousConfigContent = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf8') : null;

  let dbTempFile = null;
  let configTempFile = null;
  let dbCommitted = false;
  let configCommitted = false;

  try {
    if (previousDbContent !== null) writeBackupContent(previousDbContent);

    // Prepare both durable files before replacing either live file.
    dbTempFile = prepareTempFile(DB_FILE, nextDbContent);
    configTempFile = prepareTempFile(CONFIG_FILE, nextConfigContent);

    fs.renameSync(dbTempFile, DB_FILE);
    dbTempFile = null;
    dbCommitted = true;

    fs.renameSync(configTempFile, CONFIG_FILE);
    configTempFile = null;
    configCommitted = true;

    dbCache = JSON.parse(nextDbContent);
  } catch (error) {
    if (dbTempFile) try { fs.unlinkSync(dbTempFile); } catch (_) { /* best effort */ }
    if (configTempFile) try { fs.unlinkSync(configTempFile); } catch (_) { /* best effort */ }

    const rollbackErrors = [];
    if (dbCommitted) {
      try { restoreFile(DB_FILE, previousDbContent); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (configCommitted) {
      try { restoreFile(CONFIG_FILE, previousConfigContent); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    dbCache = null;

    if (rollbackErrors.length > 0) {
      throw new Error(`Snapshot write failed (${error.message}) and rollback was incomplete (${rollbackErrors.map(item => item.message).join('; ')}).`);
    }
    throw error;
  }
}

function clearDbCache() {
  dbCache = null;
}

ensureDataDirs();

module.exports = {
  DB_FILE,
  TICKER_CACHE_FILE,
  readDb,
  writeDb,
  readConfig,
  writeConfig,
  readTickerCache,
  writeTickerCache,
  writeSnapshot,
  clearDbCache,
  atomicWriteFile
};
