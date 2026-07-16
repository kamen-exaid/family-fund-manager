const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const BACKUP_DIR = path.join(__dirname, '..', 'backups');
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
  etfs: [
    { ticker: 'VOO', name: '先锋标普500 ETF' },
    { ticker: 'QQQM', name: '景顺纳指100 ETF' },
    { ticker: 'VGT', name: '先锋信息技术 ETF' },
    { ticker: 'SMH', name: '范达半导体 ETF' }
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

function readDb() {
  ensureDataDirs();
  if (dbCache) return clone(dbCache);

  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DB, null, 2), 'utf8');
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
      fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2), 'utf8');
    }
    dbCache = dbData;
    return clone(dbData);
  } catch (error) {
    console.error('Error reading database, resetting to default:', error);
    return clone(DEFAULT_DB);
  }
}

function writeDb(dbData) {
  ensureDataDirs();
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2), 'utf8');
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

  fs.writeFile(backupFile, backupContent, 'utf8', (err) => {
    if (err) {
      console.error('Failed to write backup:', err);
      return;
    }

    fs.readdir(BACKUP_DIR, (readErr, files) => {
      if (readErr) return;
      const backupFiles = files.filter(f => f.startsWith('db_backup_') && f.endsWith('.json')).sort().reverse();
      if (backupFiles.length > 15) {
        backupFiles.slice(15).forEach(f => {
          fs.unlink(path.join(BACKUP_DIR, f), () => {});
        });
      }
    });
  });
}

function readConfig() {
  ensureDataDirs();
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
      return clone(DEFAULT_CONFIG);
    }

    const configData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (!configData.etfs) {
      configData.etfs = clone(DEFAULT_CONFIG.etfs);
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(configData, null, 2), 'utf8');
    }
    return configData;
  } catch (error) {
    console.error('Error reading config, resetting to default:', error);
    return clone(DEFAULT_CONFIG);
  }
}

function writeConfig(configData) {
  ensureDataDirs();
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(configData, null, 2), 'utf8');
  } catch (error) {
    console.error('Error writing config:', error);
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
  clearDbCache
};
