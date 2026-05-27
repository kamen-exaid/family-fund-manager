const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'data');
const BACKUP_DIR = path.join(__dirname, 'backups');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// 确保目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// 初始化默认数据库，设为 USD 本地支持，并包含 3 人初始配置与默认 CNH 汇率
const DEFAULT_DB = {
  cnhRate: 7.2, // 默认 USD/CNH 汇率
  members: [
    { id: 'me', name: '我' },
    { id: 'mother', name: '母亲' },
    { id: 'father', name: '父亲' }
  ],
  events: [] // 包含所有事件：deposit (入金), withdraw (出金), valuation (估值更新)
};

// --- 性能优化：内存缓存层 ---
let _dbCache = null;       // 数据库内存镜像（避免重复磁盘读取）
let _stateCache = null;    // calculateState() 结果缓存
let _stateDirty = true;    // 脏标记：数据变更后标记缓存失效

// 读取数据库（优化：优先使用内存镜像，避免重复同步磁盘 I/O）
function readDb() {
  if (_dbCache) return JSON.parse(JSON.stringify(_dbCache)); // 深拷贝防篡改
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DB, null, 2), 'utf8');
      _dbCache = DEFAULT_DB;
      return JSON.parse(JSON.stringify(DEFAULT_DB));
    }
    const data = fs.readFileSync(DB_FILE, 'utf8');
    const dbData = JSON.parse(data);

    // 向后兼容迁移：如果缺少 members 字段，自动载入预设
    let migrated = false;
    if (!dbData.members) {
      dbData.members = [
        { id: 'me', name: '我' },
        { id: 'mother', name: '母亲' },
        { id: 'father', name: '父亲' }
      ];
      migrated = true;
    }
    // 向后兼容迁移：如果缺少 cnhRate 字段，自动使用默认值
    if (dbData.cnhRate === undefined) {
      dbData.cnhRate = 7.2;
      migrated = true;
    }
    // 向后兼容迁移：如果缺少 indexCache 字段，自动初始化
    if (!dbData.indexCache) {
      dbData.indexCache = {};
      migrated = true;
    }
    if (migrated) {
      fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2), 'utf8');
    }
    _dbCache = dbData;
    return JSON.parse(JSON.stringify(dbData));
  } catch (error) {
    console.error('Error reading database, resetting to default:', error);
    return DEFAULT_DB;
  }
}

// 写入数据库（优化：主文件同步写入保证一致性，备份与清理改为异步）
function writeDb(dbData) {
  try {
    // 同步写入主文件（保证数据一致性）
    fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2), 'utf8');

    // 更新内存镜像 & 标记状态缓存失效
    _dbCache = JSON.parse(JSON.stringify(dbData));
    _stateCache = null;
    _stateDirty = true;

    // 异步备份 (不阻塞主线程)
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(BACKUP_DIR, `db_backup_${timestamp}.json`);
    const backupContent = JSON.stringify(dbData);
    fs.writeFile(backupFile, backupContent, 'utf8', (err) => {
      if (err) {
        console.error('Failed to write backup:', err);
        return;
      }
      // 异步清理旧备份
      fs.readdir(BACKUP_DIR, (readErr, files) => {
        if (readErr) return;
        const backupFiles = files.filter(f => f.startsWith('db_backup_') && f.endsWith('.json')).sort().reverse();
        if (backupFiles.length > 15) {
          backupFiles.slice(15).forEach(f => {
            fs.unlink(path.join(BACKUP_DIR, f), () => {}); // 静默删除
          });
        }
      });
    });
  } catch (error) {
    console.error('Error writing database:', error);
  }
}

// 获取全局计算状态（优化：带缓存，仅在数据变更后重新计算）
function getState() {
  if (!_stateDirty && _stateCache) return _stateCache;
  _stateCache = calculateState();
  _stateDirty = false;
  return _stateCache;
}

// 初始化默认配置（含4个默认追踪标的）
const DEFAULT_CONFIG = {
  etfs: [
    { ticker: 'VOO', name: '先锋标普500 ETF' },
    { ticker: 'QQQM', name: '景顺纳指100 ETF' },
    { ticker: 'VGT', name: '先锋信息技术 ETF' },
    { ticker: 'SMH', name: '范达半导体 ETF' }
  ]
};

// 读取系统/显示配置文件
function readConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
      return DEFAULT_CONFIG;
    }
    const data = fs.readFileSync(CONFIG_FILE, 'utf8');
    const configData = JSON.parse(data);
    if (!configData.etfs) {
      configData.etfs = DEFAULT_CONFIG.etfs;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(configData, null, 2), 'utf8');
    }
    return configData;
  } catch (error) {
    console.error('Error reading config, resetting to default:', error);
    return DEFAULT_CONFIG;
  }
}

// 写入系统/显示配置文件
function writeConfig(configData) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(configData, null, 2), 'utf8');
  } catch (error) {
    console.error('Error writing config:', error);
  }
}

/**
 * 解析 Yahoo 价格响应的辅助函数
 */
function parseYahooPricesResponse(json) {
  const map = {};
  if (json && json.chart?.result?.[0]) {
    const result = json.chart.result[0];
    const timestamps = result.timestamp;
    const closes = result.indicators.quote[0].close;
    if (timestamps && closes) {
      for (let i = 0; i < timestamps.length; i++) {
        if (closes[i] !== null && closes[i] !== undefined) {
          const dateStr = new Date(timestamps[i] * 1000).toISOString().split('T')[0];
          map[dateStr] = closes[i];
        }
      }
    }
  }
  return map;
}

/**
 * 运行 curl 备用抓取辅助函数 (自动继承系统代理，解决国内 https.get 无法直连或走代理的问题)
 */
function runCurlSyncFallback(url, ticker, resolve) {
  console.log(`[Yahoo Sync] https.get failed for ${ticker}. Falling back to curl...`);
  const curlCmd = `curl -s -L -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" "${url}"`;
  exec(curlCmd, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
    if (error) {
      console.error(`[Yahoo Sync] Curl fallback failed for ${ticker}:`, error.message);
      resolve({});
      return;
    }
    try {
      const json = JSON.parse(stdout);
      resolve(parseYahooPricesResponse(json));
    } catch (e) {
      console.error(`[Yahoo Sync] Curl fallback failed to parse JSON for ${ticker}:`, e.message);
      resolve({});
    }
  });
}

/**
 * 从 Yahoo Finance 抓取美股指数的每日收盘数据 (带浏览器 UA 头部欺骗，具备 curl 极速备用通路)
 */
function fetchYahooPrices(ticker, startSec, endSec) {
  return new Promise((resolve) => {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${startSec}&period2=${endSec}&interval=1d`;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    };

    https.get(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.chart?.result?.[0]) {
            return resolve(parseYahooPricesResponse(json));
          }
          throw new Error('Invalid chart JSON structure');
        } catch (e) {
          runCurlSyncFallback(url, ticker, resolve);
        }
      });
    }).on('error', (err) => {
      runCurlSyncFallback(url, ticker, resolve);
    });
  });
}

/**
 * 在价格字典中寻找最近交易日的收盘价 (最多向前追溯 7 天)
 */
function findClosestPrice(dateStr, priceMap) {
  if (priceMap[dateStr] !== undefined) return priceMap[dateStr];
  let d = new Date(dateStr);
  for (let i = 0; i < 7; i++) {
    d.setDate(d.getDate() - 1);
    const checkStr = d.toISOString().split('T')[0];
    if (priceMap[checkStr] !== undefined) {
      return priceMap[checkStr];
    }
  }
  return null;
}

/**
 * 从本地 indexCache 中寻找最临近的对标价格 (时序兜底)
 */
function findFallbackIndices(dateStr, cache) {
  const cachedDates = Object.keys(cache).sort();
  if (cachedDates.length === 0) return null;

  let closestDate = cachedDates[0];
  let minDiff = Math.abs(new Date(dateStr) - new Date(closestDate));
  cachedDates.forEach(d => {
    const diff = Math.abs(new Date(dateStr) - new Date(d));
    if (diff < minDiff) {
      minDiff = diff;
      closestDate = d;
    }
  });
  return cache[closestDate];
}

/**
 * 异步更新缺失日期的指数收盘价缓存 (静默后台机制)
 */
async function ensureIndexCache(dates) {
  if (!dates || dates.length === 0) return;
  const db = readDb();
  if (!db.indexCache) db.indexCache = {};

  const missingDates = dates.filter(d => !db.indexCache[d]);
  if (missingDates.length === 0) return;

  console.log(`[Yahoo Sync Worker] Detecting ${missingDates.length} missing dates in cache. Fetching in background...`);

  try {
    const sortedMissing = [...missingDates].sort();
    const oldestDate = sortedMissing[0];

    // 向前多垫7天作为安全跨周末余量
    const startSec = Math.floor(new Date(oldestDate).getTime() / 1000) - 7 * 24 * 3600;
    const nowSec = Math.floor(Date.now() / 1000);

    const [spxMap, ndxMap] = await Promise.all([
      fetchYahooPrices('^GSPC', startSec, nowSec),
      fetchYahooPrices('^NDX', startSec, nowSec)
    ]);

    let updated = false;
    missingDates.forEach(dateStr => {
      const spxClose = findClosestPrice(dateStr, spxMap);
      const ndxClose = findClosestPrice(dateStr, ndxMap);

      if (spxClose && ndxClose) {
        db.indexCache[dateStr] = {
          spx: parseFloat(spxClose.toFixed(2)),
          ndx: parseFloat(ndxClose.toFixed(2))
        };
        updated = true;
      }
    });

    if (updated) {
      console.log(`[Yahoo Sync Worker] Successfully synced indices for dates:`, missingDates);
      writeDb(db);
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
  const db = readDb();

  // 1. 按发生日期(date)升序排序，如果日期相同，按创建时间戳(createdAt)升序排序
  const sortedEvents = [...db.events].sort((a, b) => {
    const dateCompare = a.date.localeCompare(b.date);
    if (dateCompare !== 0) return dateCompare;
    return a.createdAt - b.createdAt;
  });

  // 2. 初始化基本状态
  let navPerShare = 1.0000;
  let totalShares = 0;
  let totalNAV = 0; // 当前基金估值
  const globalCnhRate = db.cnhRate || 7.2;

  const members = {};
  const memberHistory = {};
  db.members.forEach(m => {
    members[m.id] = {
      id: m.id,
      name: m.name,
      shares: 0,
      totalDeposit: 0,
      totalWithdraw: 0,
      cnhDeposit: 0,   // 人民币累计存入
      cnhWithdraw: 0   // 人民币累计提取
    };
    memberHistory[m.id] = [];
  });

  // 记录历史走势数据用于绘制图表
  const navHistory = []; // { date, navPerShare, totalNAV, totalShares }

  // --- 归一化指数对比模型基础数据准备 ---
  const indexCache = db.indexCache || {};
  let baseSpx = 5000;
  let baseNdx = 18000;
  if (sortedEvents.length > 0) {
    const inceptionDate = sortedEvents[0].date;
    const baseIndices = indexCache[inceptionDate] || findFallbackIndices(inceptionDate, indexCache);
    if (baseIndices) {
      baseSpx = baseIndices.spx;
      baseNdx = baseIndices.ndx;
    }
  }

  // 3. 逐个重放事件
  sortedEvents.forEach(event => {
    const currentNAV = (totalShares === 0) ? 1.0000 : navPerShare;

    if (event.type === 'deposit') {
      const amount = parseFloat(event.amount);
      const memberKey = event.member;
      // 人民币金额处理：若有则取，若没有则按全局汇率乘积计算（用于前向兼容）
      const eventCnhAmount = event.cnhAmount !== undefined ? parseFloat(event.cnhAmount) : (amount * globalCnhRate);

      // 计算获得的份额
      const sharesGained = amount / currentNAV;

      // 更新份额
      if (members[memberKey]) {
        members[memberKey].shares += sharesGained;
        members[memberKey].totalDeposit += amount;
        members[memberKey].cnhDeposit += eventCnhAmount;
        totalShares += sharesGained;
      }

      // 入金后总资产增加
      totalNAV = totalShares * currentNAV; // 应等于原 totalNAV + amount
      navPerShare = currentNAV; // 入金瞬间，单位净值不变

      // 保存事件运行时的瞬时属性
      event._sharesGained = sharesGained;
      event._navAtTx = currentNAV;
      event._totalSharesAfter = totalShares;
      event._totalNAVAfter = totalNAV;
      event._cnhAmountComputed = eventCnhAmount;

    } else if (event.type === 'withdraw') {
      const amount = parseFloat(event.amount);
      const memberKey = event.member;
      // 人民币金额处理：若有则取，若没有则根据全局汇率计算
      let eventCnhAmount = event.cnhAmount !== undefined ? parseFloat(event.cnhAmount) : (amount * globalCnhRate);

      let sharesDeducted = 0;
      let actualAmount = 0;

      if (members[memberKey]) {
        sharesDeducted = amount / currentNAV;
        if (sharesDeducted > members[memberKey].shares) {
          sharesDeducted = members[memberKey].shares;
          // 若实际发生美金扣减截断，人民币出金也应同步调整
          eventCnhAmount = (members[memberKey].shares * currentNAV === 0) ? 0 : eventCnhAmount;
        }
        actualAmount = sharesDeducted * currentNAV;
        members[memberKey].shares -= sharesDeducted;
        members[memberKey].totalWithdraw += actualAmount;
        members[memberKey].cnhWithdraw += eventCnhAmount;
        totalShares -= sharesDeducted;
      }

      // 出金后总资产减少
      totalNAV = totalShares * currentNAV;
      navPerShare = currentNAV; // 出金瞬间，单位净值不变

      // 保存事件运行时的瞬时属性
      event._sharesDeducted = sharesDeducted;
      event._navAtTx = currentNAV;
      event._totalSharesAfter = totalShares;
      event._totalNAVAfter = totalNAV;
      event._actualAmount = actualAmount; // 如果发生超额赎回截断，记录实际出金金额
      event._cnhAmountComputed = eventCnhAmount;

    } else if (event.type === 'valuation') {
      const newTotalNAV = parseFloat(event.totalNAV);

      // 更新总资产与单位净值
      totalNAV = newTotalNAV;
      if (totalShares > 0) {
        navPerShare = totalNAV / totalShares;
      } else {
        navPerShare = 1.0000;
      }

      // 保存事件运行时的瞬时属性
      event._navAtTx = navPerShare;
      event._totalSharesAfter = totalShares;
      event._totalNAVAfter = totalNAV;
    } else if (event.type === 'transfer') {
      const amount = parseFloat(event.amount);
      const fromMemberKey = event.fromMember;
      const toMemberKey = event.toMember;
      const eventRate = event.cnhRate !== undefined ? parseFloat(event.cnhRate) : globalCnhRate;
      const eventCnhAmount = amount * eventRate;

      let sharesTransferred = amount / currentNAV;
      if (members[fromMemberKey]) {
        if (sharesTransferred > members[fromMemberKey].shares) {
          sharesTransferred = members[fromMemberKey].shares;
        }
        const actualAmount = sharesTransferred * currentNAV;

        members[fromMemberKey].shares -= sharesTransferred;
        members[fromMemberKey].totalWithdraw += actualAmount;
        members[fromMemberKey].cnhWithdraw += eventCnhAmount;

        if (members[toMemberKey]) {
          members[toMemberKey].shares += sharesTransferred;
          members[toMemberKey].totalDeposit += actualAmount;
          members[toMemberKey].cnhDeposit += eventCnhAmount;
        }

        totalNAV = totalShares * currentNAV; // Total NAV unchanged
        navPerShare = currentNAV; // NAV/Share unchanged

        // 保存事件运行时的瞬时属性
        event._sharesTransferred = sharesTransferred;
        event._navAtTx = currentNAV;
        event._totalSharesAfter = totalShares;
        event._totalNAVAfter = totalNAV;
        event._actualAmount = actualAmount;
        event._cnhAmountComputed = eventCnhAmount;
      }
    }

    // 计算当前节点的归一化指数值
    let sp500NAV = 1.0000;
    let ndxNAV = 1.0000;
    if (sortedEvents.length > 0) {
      const currentIndices = indexCache[event.date] || findFallbackIndices(event.date, indexCache);
      if (currentIndices) {
        sp500NAV = parseFloat(((currentIndices.spx / baseSpx) * 1.0000).toFixed(4));
        ndxNAV = parseFloat(((currentIndices.ndx / baseNdx) * 1.0000).toFixed(4));
      }
    }

    // 记录历史走势 (保留每个节点的财务状态)
    navHistory.push({
      eventId: event.id,
      date: event.date,
      navPerShare: parseFloat(navPerShare.toFixed(4)),
      totalNAV: parseFloat(totalNAV.toFixed(2)),
      totalShares: parseFloat(totalShares.toFixed(4)),
      sp500NAV,
      ndxNAV,
      type: event.type,
      member: event.member,
      fromMember: event.fromMember,
      toMember: event.toMember,
      amount: event.amount,
      cnhRate: event.cnhRate,
      cnhAmount: event.cnhAmount || event._cnhAmountComputed,
      remark: event.remark
    });

    // 记录各成员在该节点处的持仓价值
    Object.keys(members).forEach(k => {
      memberHistory[k].push({
        date: event.date,
        shares: members[k].shares,
        value: members[k].shares * navPerShare
      });
    });
  });

  // 4. 计算各成员的最终总结算状态
  const computedMembers = {};
  Object.keys(members).forEach(k => {
    const m = members[k];
    const currentValue = m.shares * navPerShare;
    // 美元净收益 = 当前价值 + 累计提现 - 累计充值
    const profit = currentValue + m.totalWithdraw - m.totalDeposit;
    // 美元回报率 = 净收益 / 累计充值 (若累计充值为 0，则收益率为 0)
    const profitRate = m.totalDeposit > 0 ? (profit / m.totalDeposit) * 100 : 0;

    // 人民币 (CNH) 收益率计算：以各自独立填入的人民币流水分账核算
    const cnhCurrentValue = currentValue * globalCnhRate;
    const cnhProfit = cnhCurrentValue + m.cnhWithdraw - m.cnhDeposit;
    const cnhProfitRate = m.cnhDeposit > 0 ? (cnhProfit / m.cnhDeposit) * 100 : 0;

    computedMembers[k] = {
      name: m.name,
      shares: parseFloat(m.shares.toFixed(4)),
      currentValue: parseFloat(currentValue.toFixed(2)),
      totalDeposit: parseFloat(m.totalDeposit.toFixed(2)),
      totalWithdraw: parseFloat(m.totalWithdraw.toFixed(2)),
      profit: parseFloat(profit.toFixed(2)),
      profitRate: parseFloat(profitRate.toFixed(2)),

      // 人民币专属核算
      cnhCurrentValue: parseFloat(cnhCurrentValue.toFixed(2)),
      cnhDeposit: parseFloat(m.cnhDeposit.toFixed(2)),
      cnhWithdraw: parseFloat(m.cnhWithdraw.toFixed(2)),
      cnhProfit: parseFloat(cnhProfit.toFixed(2)),
      cnhProfitRate: parseFloat(cnhProfitRate.toFixed(2))
    };
  });

  // 计算基金总体净收益与总回报率 (USD 及 CNH 两个维度)
  let fundTotalDeposit = 0;
  let fundTotalWithdraw = 0;
  let fundCnhDeposit = 0;
  let fundCnhWithdraw = 0;
  Object.keys(members).forEach(k => {
    fundTotalDeposit += members[k].totalDeposit;
    fundTotalWithdraw += members[k].totalWithdraw;
    fundCnhDeposit += members[k].cnhDeposit;
    fundCnhWithdraw += members[k].cnhWithdraw;
  });

  const fundProfit = totalNAV + fundTotalWithdraw - fundTotalDeposit;
  const fundProfitRate = fundTotalDeposit > 0 ? (fundProfit / fundTotalDeposit) * 100 : 0;

  const fundCnhCurrentValue = totalNAV * globalCnhRate;
  const fundCnhProfit = fundCnhCurrentValue + fundCnhWithdraw - fundCnhDeposit;
  const fundCnhProfitRate = fundCnhDeposit > 0 ? (fundCnhProfit / fundCnhDeposit) * 100 : 0;

  return {
    summary: {
      totalNAV: parseFloat(totalNAV.toFixed(2)),
      totalShares: parseFloat(totalShares.toFixed(4)),
      navPerShare: parseFloat(navPerShare.toFixed(4)),
      totalDeposit: parseFloat(fundTotalDeposit.toFixed(2)),
      totalWithdraw: parseFloat(fundTotalWithdraw.toFixed(2)),
      profit: parseFloat(fundProfit.toFixed(2)),
      profitRate: parseFloat(fundProfitRate.toFixed(2)),

      // 全局人民币 CNH 指标
      cnhRate: globalCnhRate,
      cnhTotalNAV: parseFloat(fundCnhCurrentValue.toFixed(2)),
      cnhTotalDeposit: parseFloat(fundCnhDeposit.toFixed(2)),
      cnhTotalWithdraw: parseFloat(fundCnhWithdraw.toFixed(2)),
      cnhProfit: parseFloat(fundCnhProfit.toFixed(2)),
      cnhProfitRate: parseFloat(fundCnhProfitRate.toFixed(2))
    },
    members: computedMembers,
    events: sortedEvents,
    charts: {
      navHistory,
      memberHistory
    }
  };
}

// --- API 路由 ---

// 1. 获取全局状态数据（主 Dashboard 数据）
app.get('/api/state', (req, res) => {
  try {
    const state = getState();
    res.json({ success: true, data: state });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ETF ATH 缓存与后台同步机制
let etfAthCache = null;
let etfAthCacheTime = 0;
const ETF_CACHE_DURATION = 5 * 60 * 1000; // 5分钟缓存

async function fetchEtfAthData() {
  const config = readConfig();
  const tickers = config.etfs.map(e => e.ticker);
  const nameMap = {};
  config.etfs.forEach(e => { nameMap[e.ticker] = e.name; });

  // 提取单个 ETF 抓取逻辑为独立函数
  async function fetchSingleEtfAth(ticker) {
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      // 1. 获取历史最大日K数据以得到历史 ATH
      const maxUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?period1=0&period2=${nowSec}&interval=1d`;
      const options = {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      };

      let maxData = await new Promise((resolve) => {
        https.get(maxUrl, options, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
          });
        }).on('error', () => resolve(null));
      });

      // Fallback to curl if https.get fails (automatic proxy support on domestic networks)
      if (!maxData || !maxData.chart?.result?.[0]) {
        console.log(`[ETF ATH] https.get failed for ${ticker}. Trying curl fallback...`);
        maxData = await new Promise((resolve) => {
          const curlCmd = `curl -s -L -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" "${maxUrl}"`;
          exec(curlCmd, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            if (error) {
              console.error(`[ETF ATH] Curl fallback failed for ${ticker}:`, error.message);
              resolve(null);
              return;
            }
            try {
              resolve(JSON.parse(stdout));
            } catch (e) {
              resolve(null);
            }
          });
        });
      }

      if (!maxData || !maxData.chart?.result?.[0]) {
        throw new Error(`No chart data for ${ticker}`);
      }

      const result = maxData.chart.result[0];
      const highs = result.indicators.quote[0].high || [];
      const closes = result.indicators.quote[0].close || [];
      const timestamps = result.timestamp || [];
      const meta = result.meta;

      // 1. 获取当前美东时间（America/New_York）的年月日和小时
      const estFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      });
      const estParts = estFormatter.formatToParts(new Date());
      const estMap = {};
      estParts.forEach(p => estMap[p.type] = p.value);
      
      const todayStr = `${estMap.year}-${estMap.month}-${estMap.day}`;
      const estHour = parseInt(estMap.hour, 10);
      
      // 美盘盘后晚上 8 点结束后即可按最新数据走。因此 20:00 前需要排除今天未收盘数据，20:00 及之后不再排除
      const shouldExcludeToday = estHour < 20;

      let ath = 0;
      let athDate = '';
      for (let i = 0; i < highs.length; i++) {
        if (highs[i] !== null && highs[i] !== undefined) {
          const dateStr = new Date(timestamps[i] * 1000).toISOString().split('T')[0];
          if (shouldExcludeToday && dateStr === todayStr) continue; // 排除今天数据

          if (highs[i] > ath) {
            ath = highs[i];
            athDate = dateStr;
          }
        }
      }

      // 获取上个交易日收盘价与日期（根据 shouldExcludeToday 判定是否包含今天）
      let regularClose = meta.regularMarketPrice; // fallback
      let regularCloseDate = '';
      for (let i = closes.length - 1; i >= 0; i--) {
        if (closes[i] !== null && closes[i] !== undefined) {
          const dateStr = new Date(timestamps[i] * 1000).toISOString().split('T')[0];
          if (shouldExcludeToday && dateStr === todayStr) continue; // 排除今天
          regularClose = closes[i];
          regularCloseDate = dateStr;
          break;
        }
      }

      // 回调幅度 = (上个交易日收盘价 - ATH) / ATH * 100
      const drawdown = ((regularClose - ath) / ath) * 100;

      return {
        ticker,
        ath: parseFloat(ath.toFixed(2)),
        athDate,
        regularClose: parseFloat(regularClose.toFixed(2)),
        regularCloseDate,
        drawdown: parseFloat(drawdown.toFixed(2)),
        longName: meta.longName || ticker,
        name: nameMap[ticker] || meta.longName || ticker
      };
    } catch (err) {
      console.error(`[ETF ATH] Failed to fetch data for ${ticker}:`, err.message);
      return {
        ticker,
        ath: 0,
        latestPrice: 0,
        regularClose: 0,
        drawdown: 0,
        name: nameMap[ticker] || ticker,
        error: true
      };
    }
  }

  // 优化：所有 ETF 并行请求（原串行 4-8 秒 → 并行 1-2 秒）
  const tickerResults = await Promise.all(tickers.map(t => fetchSingleEtfAth(t)));
  const results = {};
  tickerResults.forEach(r => { results[r.ticker] = r; });
  return results;
}

// 1.5. 获取外部 ETF ATH 数据
app.get('/api/etf-ath', async (req, res) => {
  try {
    const now = Date.now();
    if (etfAthCache && (now - etfAthCacheTime < ETF_CACHE_DURATION)) {
      return res.json({ success: true, data: etfAthCache, cached: true });
    }
    const data = await fetchEtfAthData();
    etfAthCache = data;
    etfAthCacheTime = now;
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 2. 录入出入金记录
app.post('/api/transaction', (req, res) => {
  try {
    const { member, type, amount, cnhAmount, date, remark } = req.body;
    const db = readDb();

    const memberObj = db.members.find(m => m.id === member);
    if (!memberObj) {
      return res.status(400).json({ success: false, message: '无效的家庭成员' });
    }
    if (!['deposit', 'withdraw'].includes(type)) {
      return res.status(400).json({ success: false, message: '交易类型必须为入金(deposit)或出金(withdraw)' });
    }
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ success: false, message: '金额必须大于 0' });
    }

    // 处理人民币金额手动输入
    let parsedCnhAmount = undefined;
    if (cnhAmount !== undefined && cnhAmount !== '') {
      parsedCnhAmount = parseFloat(cnhAmount);
      if (isNaN(parsedCnhAmount) || parsedCnhAmount <= 0) {
        return res.status(400).json({ success: false, message: '人民币金额必须大于 0' });
      }
    } else {
      parsedCnhAmount = parsedAmount * (db.cnhRate || 7.2);
    }

    if (!date) {
      return res.status(400).json({ success: false, message: '日期不能为空' });
    }

    // 如果是出金，先做一轮预演算，检查出金人当前份额换算成的资产是否足够
    if (type === 'withdraw') {
      const state = calculateState();
      const memberState = state.members[member];
      const memberValue = memberState ? memberState.currentValue : 0;
      if (parsedAmount > memberValue) {
        return res.status(400).json({
          success: false,
          message: `余额不足！${memberObj.name}当前资产为 $${memberValue.toFixed(2)}，无法提取 $${parsedAmount.toFixed(2)}`
        });
      }
    }

    const newEvent = {
      id: 'tx_' + Math.random().toString(36).substr(2, 9),
      type,
      member,
      amount: parsedAmount,
      cnhAmount: parsedCnhAmount,
      date,
      remark: remark || '',
      createdAt: Date.now()
    };

    db.events.push(newEvent);
    writeDb(db);

    // 静默后台触发指数同步
    ensureIndexCache([date]);

    res.json({ success: true, message: '交易记录登记成功', data: newEvent });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 3. 录入估值更新记录
app.post('/api/valuation', (req, res) => {
  try {
    const { totalNAV, date, remark } = req.body;

    const parsedNAV = parseFloat(totalNAV);
    if (isNaN(parsedNAV) || parsedNAV < 0) {
      return res.status(400).json({ success: false, message: '资产估值金额必须大于等于 0' });
    }
    if (!date) {
      return res.status(400).json({ success: false, message: '日期不能为空' });
    }

    const db = readDb();

    // 在没有起投份额时（总份额为0），直接更新估值是不合逻辑的，应先进行首次入金
    const state = calculateState();
    if (state.summary.totalShares === 0 && parsedNAV > 0) {
      return res.status(400).json({
        success: false,
        message: '当前基金尚无份额。请先录入首次出入金（起投金额），随后再进行市值估值更新。'
      });
    }

    const newEvent = {
      id: 'val_' + Math.random().toString(36).substr(2, 9),
      type: 'valuation',
      totalNAV: parsedNAV,
      date,
      remark: remark || '定期净值估值更新',
      createdAt: Date.now()
    };

    db.events.push(newEvent);
    writeDb(db);

    // 静默后台触发指数同步
    ensureIndexCache([date]);

    res.json({ success: true, message: '资产估值更新成功', data: newEvent });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 3.5. 内部份额转让划转
app.post('/api/transfer', (req, res) => {
  try {
    const { fromMember, toMember, amount, cnhRate, date, remark } = req.body;
    const db = readDb();

    if (fromMember === toMember) {
      return res.status(400).json({ success: false, message: '出让方与受让方不能为同一成员' });
    }

    const fromObj = db.members.find(m => m.id === fromMember);
    const toObj = db.members.find(m => m.id === toMember);
    if (!fromObj || !toObj) {
      return res.status(400).json({ success: false, message: '无效的转让成员' });
    }

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ success: false, message: '转让金额必须大于 0' });
    }

    const parsedRate = parseFloat(cnhRate);
    if (isNaN(parsedRate) || parsedRate <= 0) {
      return res.status(400).json({ success: false, message: '受让汇率必须大于 0' });
    }

    if (!date) {
      return res.status(400).json({ success: false, message: '日期不能为空' });
    }

    // 检查出让方余额是否充足
    const state = calculateState();
    const fromMemberState = state.members[fromMember];
    const fromValue = fromMemberState ? fromMemberState.currentValue : 0;
    if (parsedAmount > fromValue) {
      return res.status(400).json({
        success: false,
        message: `出让方余额不足！${fromObj.name}当前资产为 $${fromValue.toFixed(2)}，无法划转 $${parsedAmount.toFixed(2)}`
      });
    }

    const newEvent = {
      id: 'tf_' + Math.random().toString(36).substr(2, 9),
      type: 'transfer',
      fromMember,
      toMember,
      amount: parsedAmount,
      cnhRate: parsedRate,
      cnhAmount: parsedAmount * parsedRate,
      date,
      remark: remark || '',
      createdAt: Date.now()
    };

    db.events.push(newEvent);
    writeDb(db);

    // 静默后台触发指数同步
    ensureIndexCache([date]);

    res.json({ success: true, message: '内部份额转让登记成功', data: newEvent });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 4. 删除事件（支持交易撤销与删除估值，全自动重算）
app.delete('/api/event/:id', (req, res) => {
  try {
    const eventId = req.params.id;
    const db = readDb();

    const index = db.events.findIndex(e => e.id === eventId);
    if (index === -1) {
      return res.status(404).json({ success: false, message: '未找到该条记录' });
    }

    const removedEvent = db.events.splice(index, 1)[0];
    writeDb(db);

    res.json({
      success: true,
      message: '记录已成功删除，系统账目已自动完成重新计算。',
      data: removedEvent
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 4.5. 修改事件（支持交易/估值在线修改，一键级联重算）
app.put('/api/event/:id', (req, res) => {
  try {
    const eventId = req.params.id;
    const db = readDb();

    const event = db.events.find(e => e.id === eventId);
    if (!event) {
      return res.status(404).json({ success: false, message: '未找到该条记录' });
    }

    if (event.type === 'deposit' || event.type === 'withdraw') {
      const { member, amount, cnhAmount, date, remark } = req.body;

      if (member !== undefined) {
        const memberObj = db.members.find(m => m.id === member);
        if (!memberObj) {
          return res.status(400).json({ success: false, message: '无效的家庭成员' });
        }
        event.member = member;
      }

      if (amount !== undefined) {
        const parsedAmount = parseFloat(amount);
        if (isNaN(parsedAmount) || parsedAmount <= 0) {
          return res.status(400).json({ success: false, message: '美元金额必须大于 0' });
        }
        event.amount = parsedAmount;
      }

      if (cnhAmount !== undefined) {
        const parsedCnh = parseFloat(cnhAmount);
        if (isNaN(parsedCnh) || parsedCnh <= 0) {
          return res.status(400).json({ success: false, message: '人民币金额必须大于 0' });
        }
        event.cnhAmount = parsedCnh;
      }

      if (date !== undefined) {
        if (!date) return res.status(400).json({ success: false, message: '日期不能为空' });
        event.date = date;
      }

      if (remark !== undefined) {
        event.remark = remark;
      }
    } else if (event.type === 'valuation') {
      const { totalNAV, date, remark } = req.body;

      if (totalNAV !== undefined) {
        const parsedNAV = parseFloat(totalNAV);
        if (isNaN(parsedNAV) || parsedNAV < 0) {
          return res.status(400).json({ success: false, message: '资产估值金额必须大于等于 0' });
        }
        event.totalNAV = parsedNAV;
      }

      if (date !== undefined) {
        if (!date) return res.status(400).json({ success: false, message: '日期不能为空' });
        event.date = date;
      }

      if (remark !== undefined) {
        event.remark = remark;
      }
    } else if (event.type === 'transfer') {
      const { fromMember, toMember, amount, cnhRate, date, remark } = req.body;

      if (fromMember !== undefined) {
        const fromObj = db.members.find(m => m.id === fromMember);
        if (!fromObj) return res.status(400).json({ success: false, message: '无效的出让家庭成员' });
        event.fromMember = fromMember;
      }

      if (toMember !== undefined) {
        const toObj = db.members.find(m => m.id === toMember);
        if (!toObj) return res.status(400).json({ success: false, message: '无效的受让家庭成员' });
        event.toMember = toMember;
      }

      if (event.fromMember === event.toMember) {
        return res.status(400).json({ success: false, message: '出让方与受让方不能为同一成员' });
      }

      if (amount !== undefined) {
        const parsedAmount = parseFloat(amount);
        if (isNaN(parsedAmount) || parsedAmount <= 0) {
          return res.status(400).json({ success: false, message: '转让金额必须大于 0' });
        }
        event.amount = parsedAmount;
      }

      if (cnhRate !== undefined) {
        const parsedRate = parseFloat(cnhRate);
        if (isNaN(parsedRate) || parsedRate <= 0) {
          return res.status(400).json({ success: false, message: '受让汇率必须大于 0' });
        }
        event.cnhRate = parsedRate;
      }

      // 重新计算 cnhAmount
      event.cnhAmount = event.amount * (event.cnhRate || db.cnhRate || 7.2);

      if (date !== undefined) {
        if (!date) return res.status(400).json({ success: false, message: '日期不能为空' });
        event.date = date;
      }

      if (remark !== undefined) {
        event.remark = remark;
      }
    }

    writeDb(db);

    // 触发指数同步
    if (event.date) ensureIndexCache([event.date]);

    res.json({ success: true, message: '账目记录修改成功，系统已自动重算', data: event });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取当前配置的 ETF 标的列表
app.get('/api/settings/etfs', (req, res) => {
  try {
    const config = readConfig();
    res.json({ success: true, data: config.etfs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 保存用户配置的 ETF 标的列表 (最大8个)
app.post('/api/settings/etfs', (req, res) => {
  try {
    const { etfs } = req.body;
    if (!Array.isArray(etfs)) {
      return res.status(400).json({ success: false, message: '无效的标的列表数据格式' });
    }
    if (etfs.length < 1 || etfs.length > 8) {
      return res.status(400).json({ success: false, message: '标的追踪数量必须在 1 到 8 个之间' });
    }

    const cleanedEtfs = etfs.map(e => {
      if (!e.ticker || !e.ticker.trim()) {
        throw new Error('标的代码不能为空');
      }
      return {
        ticker: e.ticker.trim().toUpperCase(),
        name: (e.name || '').trim()
      };
    });

    const config = readConfig();
    config.etfs = cleanedEtfs;
    writeConfig(config);

    // 清除缓存，强制下次获取数据时实时抓取最新标的
    etfAthCache = null;
    etfAthCacheTime = 0;

    res.json({ success: true, message: '标的配置保存成功！', data: cleanedEtfs });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// 4.8. 更新全局系统参数（汇率配置）
app.post('/api/settings', (req, res) => {
  try {
    const { cnhRate } = req.body;
    const db = readDb();

    if (cnhRate !== undefined) {
      const parsedRate = parseFloat(cnhRate);
      if (isNaN(parsedRate) || parsedRate <= 0) {
        return res.status(400).json({ success: false, message: '汇率参数必须大于 0' });
      }
      db.cnhRate = parsedRate;
    }

    writeDb(db);
    res.json({ success: true, message: '系统参数更新成功', data: { cnhRate: db.cnhRate } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 4.9. 自动从第三方接口同步最新汇率 (ExchangeRate-API 免 Key 公开接口)
app.post('/api/settings/sync-rate', async (req, res) => {
  try {
    const rate = await fetchCnhRateFromApi();
    if (!rate) {
      return res.status(500).json({ success: false, message: '从公开汇率接口获取数据失败，请检查网络或稍后重试' });
    }
    const db = readDb();
    db.cnhRate = rate;
    writeDb(db);
    res.json({ success: true, message: `汇率成功同步为 ${rate}`, cnhRate: rate });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 5. 数据一键导出备份
app.get('/api/backup/export', (req, res) => {
  try {
    const db = readDb();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=family_fund_data.json');
    res.send(JSON.stringify(db, null, 2));
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 6. 数据导入恢复
app.post('/api/backup/import', (req, res) => {
  try {
    const { events, members } = req.body;
    if (!Array.isArray(events)) {
      return res.status(400).json({ success: false, message: '导入的数据格式不正确，缺少 events 数组' });
    }

    // 格式校验
    for (let e of events) {
      if (!e.id || !e.type || !e.date || e.createdAt === undefined) {
        return res.status(400).json({ success: false, message: '导入的数据中存在格式不完整的事件项' });
      }
    }

    const currentDb = readDb();
    const db = {
      members: Array.isArray(members) ? members : currentDb.members,
      events
    };
    writeDb(db);

    // 批量导入触发指数同步
    if (events && events.length > 0) {
      ensureIndexCache(events.map(e => e.date));
    }

    res.json({ success: true, message: '数据已成功导入，系统账目已全部重新计算并生效！' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 7. 家庭成员增删改 API 路由

// 获取成员列表
app.get('/api/members', (req, res) => {
  try {
    const db = readDb();
    res.json({ success: true, data: db.members });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 新增成员
app.post('/api/members', (req, res) => {
  try {
    const { name } = req.body;
    if (!name || name.trim() === '') {
      return res.status(400).json({ success: false, message: '成员姓名不能为空' });
    }
    const db = readDb();
    const trimmedName = name.trim();

    if (db.members.some(m => m.name === trimmedName)) {
      return res.status(400).json({ success: false, message: '该成员姓名已存在' });
    }

    const newMember = {
      id: 'mem_' + Math.random().toString(36).substr(2, 9),
      name: trimmedName
    };
    db.members.push(newMember);
    writeDb(db);

    res.json({ success: true, message: '添加新成员成功', data: newMember });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 修改成员重命名
app.put('/api/members/:id', (req, res) => {
  try {
    const memberId = req.params.id;
    const { name } = req.body;
    if (!name || name.trim() === '') {
      return res.status(400).json({ success: false, message: '成员姓名不能为空' });
    }
    const db = readDb();
    const trimmedName = name.trim();

    const memberIndex = db.members.findIndex(m => m.id === memberId);
    if (memberIndex === -1) {
      return res.status(404).json({ success: false, message: '未找到该家庭成员' });
    }

    if (db.members.some((m, idx) => m.name === trimmedName && idx !== memberIndex)) {
      return res.status(400).json({ success: false, message: '该成员姓名已被使用' });
    }

    db.members[memberIndex].name = trimmedName;
    writeDb(db);

    res.json({ success: true, message: '成员姓名修改成功' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 删除成员（包含出资安全过滤）
app.delete('/api/members/:id', (req, res) => {
  try {
    const memberId = req.params.id;
    const db = readDb();

    const memberIndex = db.members.findIndex(m => m.id === memberId);
    if (memberIndex === -1) {
      return res.status(404).json({ success: false, message: '未找到该家庭成员' });
    }

    // 安全检查：如果该成员已经录入过出入金，则绝对不允许删除
    const hasTransactions = db.events.some(e => e.member === memberId);
    if (hasTransactions) {
      return res.status(400).json({
        success: false,
        message: '删除失败！该成员已有出入金记录，删除其账号会破坏历史净值计算。若不需要显示该成员，可在无持股时将其更名或保留。'
      });
    }

    const removed = db.members.splice(memberIndex, 1)[0];
    writeDb(db);

    res.json({ success: true, message: `成员【${removed.name}】已成功移除`, data: removed });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 从第三方公开汇率接口获取最新 USD/CNH 汇率
function fetchCnhRateFromApi() {
  return new Promise((resolve) => {
    const url = 'https://open.er-api.com/v6/latest/USD';
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed && parsed.result === 'success' && parsed.rates) {
            // 优先获取离岸人民币 (CNH)，次选在岸人民币 (CNY)
            const rate = parsed.rates.CNH || parsed.rates.CNY;
            if (rate) {
              return resolve(parseFloat(rate));
            }
          }
        } catch (e) {
          console.error('Error parsing exchange rate response:', e);
        }
        resolve(null);
      });
    }).on('error', (err) => {
      console.error('Error requesting CNH exchange rate:', err);
      resolve(null);
    });
  });
}

// 启动服务器并自动初始化同步一次当日汇率
app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 家庭基金账目管理系统已在本地成功启动！`);
  console.log(`🌐 访问地址：http://localhost:${PORT}`);
  console.log(`📂 数据存储路径：${DB_FILE}`);
  console.log(`====================================================`);

  // 启动时静默同步一次汇率与美股指数数据
  fetchCnhRateFromApi().then(rate => {
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
  try {
    const db = readDb();
    if (db.events && db.events.length > 0) {
      const dates = db.events.map(e => e.date);
      ensureIndexCache(dates);
    }
  } catch (err) {
    console.error('[Yahoo Sync Startup Error]:', err);
  }
});
