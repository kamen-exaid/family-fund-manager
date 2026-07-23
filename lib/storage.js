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

const DEFAULT_DB = {
  cnhRate: 7.2,
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

let dbCache = null;

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
function atomicWriteFile(filePath, content) {
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tempFile, 'w', 0o600);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempFile, filePath);
  } catch (error) {
    if (fd !== undefined && fd !== null) fs.closeSync(fd);
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
  try {
    atomicWriteFile(DB_FILE, JSON.stringify(dbData, null, 2));
    dbCache = clone(dbData);
    writeBackup(dbData);
  } catch (error) {
    console.error('Error writing database:', error);
    dbCache = null;
    throw error;
  }
}

function writeBackup(dbData) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(BACKUP_DIR, `db_backup_${timestamp}.json`);
  const backupContent = JSON.stringify(dbData);

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

function clearDbCache() {
  dbCache = null;
}

ensureDataDirs();

module.exports = {
  DB_FILE,
  readDb,
  writeDb,
  readConfig,
  writeConfig,
  clearDbCache,
  atomicWriteFile
};
