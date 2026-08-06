const express = require('express');
const path = require('path');
const { randomUUID } = require('crypto');
const storage = require('./lib/storage');

const app = express();
const PORT = process.env.PORT || 3000;
const EXTERNAL_SYNC_ENABLED = process.env.FUND_EXTERNAL_SYNC !== '0';
const MAX_REMARK_LENGTH = 500;
const MAX_MEMBER_NAME_LENGTH = 50;

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function isValidDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function normalizeRemark(remark, fallback = '') {
  if (remark === undefined || remark === null) return fallback;
  if (typeof remark !== 'string') throw new Error('备注必须为文本。');
  const normalized = remark.trim();
  if (normalized.length > MAX_REMARK_LENGTH) throw new Error(`备注不能超过 ${MAX_REMARK_LENGTH} 个字符。`);
  return normalized;
}

function normalizeMemberName(name) {
  if (typeof name !== 'string') throw new Error('成员姓名必须为文本。');
  const normalized = name.trim();
  if (!normalized || normalized.length > MAX_MEMBER_NAME_LENGTH) {
    throw new Error(`成员姓名长度必须在 1 到 ${MAX_MEMBER_NAME_LENGTH} 个字符之间。`);
  }
  return normalized;
}

// --- 性能优化：内存缓存层 ---
let _stateCache = null;    // calculateState() 结果缓存
let _stateDirty = true;    // 脏标记：数据变更后标记缓存失效

function readDb() {
  const db = storage.readDb();
  let settlementLedger = storage.readSettlements();
  const legacy = db.events.filter(event => event.type === 'performance_settlement');
  if (legacy.length && settlementLedger.records.length === 0) {
    settlementLedger = { version: 1, records: legacy };
    storage.writeSettlements(settlementLedger);
    db.events = db.events.filter(event => event.type !== 'performance_settlement');
    storage.writeDb(db);
  }
  const reversed = new Set(settlementLedger.records
    .filter(record => record.type === 'performance_settlement_reversal')
    .map(record => record.settlementId));
  const settlementEvents = settlementLedger.records.filter(record =>
    record.type === 'performance_settlement_reversal' ||
    (record.type === 'performance_settlement' && !reversed.has(record.id))
  );
  return { ...db, events: [...db.events, ...settlementEvents] };
}

function writeDb(dbData) {
  try {
    storage.writeDb({
      ...dbData,
      events: dbData.events.filter(event =>
        event.type !== 'performance_settlement' && event.type !== 'performance_settlement_reversal')
    });
    _stateCache = null;
    _stateDirty = true;
  } catch (error) {
    storage.clearDbCache();
    _stateCache = null;
    _stateDirty = true;
    throw error;
  }
}

function readSettlements() {
  return storage.readSettlements();
}

function writeSettlements(data) {
  storage.writeSettlements(data);
  _stateCache = null;
  _stateDirty = true;
}

// 获取全局计算状态（优化：带缓存，仅在数据变更后重新计算）
function getState() {
  if (!_stateDirty && _stateCache) return _stateCache;
  _stateCache = calculateState();
  _stateDirty = false;
  return _stateCache;
}

function readConfig() {
  return storage.readConfig();
}

function writeConfig(configData) {
  storage.writeConfig(configData);
}

function writeSnapshot(dbData, configData) {
  try {
    storage.writeSnapshot(dbData, configData);
    _stateCache = null;
    _stateDirty = true;
  } catch (error) {
    storage.clearDbCache();
    _stateCache = null;
    _stateDirty = true;
    throw error;
  }
}

/**
 * 解析 Yahoo 价格响应的辅助函数
 */
const {
  fetchYahooPrices,
  findCloseForPolicy,
  fetchTickerAthData,
  fetchCnhRateFromApi
} = require('./lib/yahoo');

/**
 * 异步更新缺失日期的指数收盘价缓存 (静默后台机制)
 */
async function ensureIndexCache(dates) {
  if (!dates || dates.length === 0) return;
  const db = readDb();
  if (!db.indexCache) db.indexCache = {};
  const benchmarkClosePolicy = db.benchmarkClosePolicy === 'same_day' ? 'same_day' : 'previous';
  const isValidSourceDate = (sourceDate, navDate) => benchmarkClosePolicy === 'same_day'
    ? sourceDate <= navDate
    : sourceDate < navDate;

  // Legacy entries have no source-date fields and may contain the same day's close.
  // Treat them as stale so historical trend data repairs itself on startup.
  const uniqueDates = [...new Set(dates)];
  const missingDates = uniqueDates.filter(dateStr => {
    const cached = db.indexCache[dateStr];
    return !cached ||
      cached.policy !== benchmarkClosePolicy ||
      !cached.spxPriceDate || !isValidSourceDate(cached.spxPriceDate, dateStr) ||
      !cached.ndxPriceDate || !isValidSourceDate(cached.ndxPriceDate, dateStr);
  });
  if (missingDates.length === 0) return;

  console.log(`[Yahoo Sync Worker] Detecting ${missingDates.length} missing dates in cache. Fetching in background...`);

  try {
    const sortedMissing = [...missingDates].sort();
    const oldestDate = sortedMissing[0];

    // Keep a 14-day lead-in for long weekends and exchange holidays.
    const startSec = Math.floor(new Date(oldestDate).getTime() / 1000) - 14 * 24 * 3600;
    const nowSec = Math.floor(Date.now() / 1000);

    const [spxMap, ndxMap] = await Promise.all([
      fetchYahooPrices('^GSPC', startSec, nowSec),
      fetchYahooPrices('^NDX', startSec, nowSec)
    ]);

    const fetchedUpdates = {};
    missingDates.forEach(dateStr => {
      const spxClose = findCloseForPolicy(dateStr, spxMap, benchmarkClosePolicy);
      const ndxClose = findCloseForPolicy(dateStr, ndxMap, benchmarkClosePolicy);

      if (spxClose && ndxClose) {
        fetchedUpdates[dateStr] = {
          spx: parseFloat(spxClose.price.toFixed(2)),
          ndx: parseFloat(ndxClose.price.toFixed(2)),
          spxPriceDate: spxClose.date,
          ndxPriceDate: ndxClose.date,
          policy: benchmarkClosePolicy
        };
      }
    });

    if (Object.keys(fetchedUpdates).length > 0) {
      // Re-read before writing so a slow background sync never overwrites newer ledger edits.
      const latestDb = readDb();
      const latestPolicy = latestDb.benchmarkClosePolicy === 'same_day' ? 'same_day' : 'previous';
      if (latestPolicy !== benchmarkClosePolicy) return;
      latestDb.indexCache = {
        ...(latestDb.indexCache || {}),
        ...fetchedUpdates
      };
      console.log(`[Yahoo Sync Worker] Successfully synced indices for dates:`, Object.keys(fetchedUpdates));
      writeDb(latestDb);
    }
  } catch (err) {
    console.error(`[Yahoo Sync Worker Error]:`, err.message);
  }
}

/**
 * 核心数学模型：事件流重放 (Event Sourcing Replay)
 * 重新按时间顺序计算每个事件发生时的净值、份额、及当前各成员资产状况。
 */
function calculateState() {
  return calculateStateFromDb(readDb());
}

const { calculateStateFromDb } = require('./lib/calculator');

const { registerApiRoutes } = require('./routes/api');

registerApiRoutes(app, {
  readDb,
  writeDb,
  readSettlements,
  writeSettlements,
  getState,
  readConfig,
  writeConfig,
  readTickerCache: storage.readTickerCache,
  writeTickerCache: storage.writeTickerCache,
  writeSnapshot,
  ensureIndexCache: EXTERNAL_SYNC_ENABLED ? ensureIndexCache : () => {},
  calculateStateFromDb,
  fetchCnhRateFromApi,
  isValidDate,
  normalizeRemark,
  normalizeMemberName,
  fetchTickerAthData: EXTERNAL_SYNC_ENABLED ? fetchTickerAthData : async () => ({}),
  randomUUID
});
// 从第三方公开汇率接口获取最新 USD/CNH 汇率
function startServer({ port = PORT, host = '127.0.0.1' } = {}) {
  const server = app.listen(port, host, () => {
  console.log(`====================================================`);
  console.log(`🚀 家庭基金账目管理系统已在本地成功启动！`);
  console.log(`🌐 访问地址：http://localhost:${server.address().port}`);
  console.log(`📂 数据存储路径：${storage.DB_FILE}`);
  console.log(`====================================================`);

  // 启动时静默同步一次汇率与美股指数数据
  if (EXTERNAL_SYNC_ENABLED) fetchCnhRateFromApi().then(rate => {
    if (rate) {
      try {
        const db = readDb();
        db.cnhRate = rate;
        writeDb(db);
        console.log(`🌍 [Auto-Sync] 系统成功自适应获取全球最新汇率：1 USD = ${rate} CNH`);
      } catch (err) {
        console.error('Failed to auto-save fetched CNH rate:', err);
      }
    }
  });

  // 静默自适应对标指数历史同步
  if (EXTERNAL_SYNC_ENABLED) try {
    const db = readDb();
    if (db.events && db.events.length > 0) {
      const dates = db.events.map(e => e.date);
      ensureIndexCache(dates);
    }
  } catch (err) {
    console.error('[Yahoo Sync Startup Error]:', err);
  }
  });
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = { app, calculateStateFromDb, startServer };
