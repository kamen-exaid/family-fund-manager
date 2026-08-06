const express = require('express');
const AdmZip = require('adm-zip');

function registerApiRoutes(app, deps) {
  const {
    readDb,
    writeDb,
    readSettlements = () => ({ version: 1, records: [] }),
    writeSettlements = () => {},
    getState,
    readConfig,
    writeConfig,
    readTickerCache,
    writeTickerCache,
    writeSnapshot,
    ensureIndexCache,
    calculateStateFromDb,
    fetchCnhRateFromApi,
    isValidDate,
    normalizeRemark,
    normalizeMemberName,
    fetchTickerAthData,
    randomUUID,
    now: getNow = () => new Date()
  } = deps;

  const BALANCE_TOLERANCE = 0.000001;

  function toFiniteNumber(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return NaN;
    if (typeof value === 'string' && value.trim() === '') return NaN;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  function isSundayDate(date) {
    if (!isValidDate(date)) return false;
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    return day === 0;
  }

  function latestValuationDate(now = getNow()) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(now);
    const values = {};
    parts.forEach(part => { values[part.type] = part.value; });
    const cursor = new Date(`${values.year}-${values.month}-${values.day}T00:00:00Z`);
    const minutes = Number(values.hour) * 60 + Number(values.minute);
    if (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6 || minutes < 16 * 60 + 5) {
      do {
        cursor.setUTCDate(cursor.getUTCDate() - 1);
      } while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6);
    }
    return cursor.toISOString().slice(0, 10);
  }

  function validateValuationDate(date) {
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (day === 0 || day === 6) return '估值日期必须为周一至周五的交易日。';
    const latest = latestValuationDate();
    return date <= latest ? null : `北京时间16:05后才开放当日估值；当前最晚可选择 ${latest}。`;
  }

  // The calculator caps underfunded replay events for display safety. Before
  // persisting a mutation, reject any ledger where requested and settled amounts
  // would differ instead.
  function findLedgerIssue(db) {
    const validationDb = JSON.parse(JSON.stringify(db));
    const validationState = calculateStateFromDb(validationDb);
    const valuationWithoutShares = validationState.events.find(event =>
      event.type === 'valuation' && event._hasSharesAtValuation === false
    );
    if (valuationWithoutShares) return { type: 'valuation_without_shares', event: valuationWithoutShares };

    const insufficientBalance = validationState.events.find(event =>
      (event.type === 'withdraw' || event.type === 'transfer') &&
      (event._grossAmount ?? event._actualAmount) + BALANCE_TOLERANCE < event.amount
    );
    const unpaidFee = validationState.events.find(event =>
      (event.type === 'withdraw' || event.type === 'transfer') &&
      (event._unpaidPerformanceFeeShares || 0) > BALANCE_TOLERANCE
    );
    if (unpaidFee) return { type: 'performance_fee_balance', event: unpaidFee };
    return insufficientBalance ? { type: 'insufficient_balance', event: insufficientBalance } : null;
  }

  function rejectLedgerIssue(res, issue) {
    const { event } = issue;
    if (issue.type === 'valuation_without_shares') {
      return res.status(400).json({
        success: false,
        message: `估值日期 ${event.date} 当时尚无基金份额，请先在该日期之前录入首次入金。`
      });
    }
    if (issue.type === 'performance_fee_balance') {
      return res.status(400).json({
        success: false,
        message: `${event.date} 的${event.type === 'withdraw' ? '出金' : '转让'}需要额外结算业绩报酬，但LP剩余份额不足。请降低金额后重试。`
      });
    }
    return res.status(400).json({
      success: false,
      message: `操作会导致历史${event.type === 'withdraw' ? '出金' : '转让'}余额不足：${event.date} 的记录要求 $${event.amount.toFixed(2)}，实际仅可结算 $${event._actualAmount.toFixed(2)}。`
    });
  }
  function latestSettlementDate(db) {
    return db.events.filter(event => event.type === 'performance_settlement')
      .map(event => event.date).sort().at(-1) || null;
  }

  function rejectLockedPeriod(res, db, date) {
    const lockedThrough = latestSettlementDate(db);
    if (!lockedThrough || date > lockedThrough) return false;
    res.status(409).json({
      success: false,
      message: `账目已结算锁定至 ${lockedThrough}，不能变更该日期以前的记录。`
    });
    return true;
  }
app.get('/api/state', (req, res) => {
  try {
    const state = getState();
    res.json({ success: true, data: state });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Persisted stale-while-revalidate cache. Requests never wait for Yahoo when a
// usable snapshot exists, and all tabs share one background refresh worker.
const TICKER_CLOSE_RETRY_DURATION = 10 * 60 * 1000;
const TICKER_MISSING_DAY_RETRY_DURATION = 2 * 60 * 60 * 1000;
const TICKER_WEEKEND_RETRY_DURATION = 6 * 60 * 60 * 1000;
let tickerRefreshPromise = null;
let queuedTickerConfig = null;
let activeTickerConfigSignature = null;
const tickerRefreshAttempts = new Map();
const tickerRefreshOutcomes = new Map();

function selectTickerData(cache, config, includeMissing = false) {
  const selected = {};
  for (const item of config.tickers) {
    const ticker = item.ticker;
    if (cache.tickers?.[ticker]) {
      selected[ticker] = cache.tickers[ticker];
    } else if (includeMissing) {
      selected[ticker] = { ticker, error: true, pending: true };
    }
  }
  return selected;
}

function getEasternMarketDay(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', hour12: false
  }).formatToParts(now);
  const values = {};
  parts.forEach(part => { values[part.type] = part.value; });
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    weekday: values.weekday,
    hour: Number(values.hour)
  };
}

function previousWeekday(date) {
  const cursor = new Date(`${date}T12:00:00Z`);
  do {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  } while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6);
  return cursor.toISOString().slice(0, 10);
}

function getTickerRefreshPolicy(now) {
  const eastern = getEasternMarketDay(now);
  const isWeekend = eastern.weekday === 'Sat' || eastern.weekday === 'Sun';
  const isClosePublicationWindow = !isWeekend && eastern.hour >= 20 && eastern.hour < 22;
  const expectedCloseDate = !isWeekend && eastern.hour >= 20
    ? eastern.date
    : previousWeekday(eastern.date);
  const retryDuration = isWeekend
    ? TICKER_WEEKEND_RETRY_DURATION
    : isClosePublicationWindow
      ? TICKER_CLOSE_RETRY_DURATION
      : TICKER_MISSING_DAY_RETRY_DURATION;
  return { expectedCloseDate, retryDuration };
}

function isTickerCacheStale(cache, config, now = getNow()) {
  const nowMs = now.getTime();
  const { expectedCloseDate, retryDuration } = getTickerRefreshPolicy(now);
  return config.tickers.some(({ ticker }) => {
    const cachedTicker = cache.tickers?.[ticker];
    if (!cachedTicker) return true;
    if (cachedTicker.regularCloseDate >= expectedCloseDate) return false;
    const updatedAt = Date.parse(cachedTicker.updatedAt || '');
    const lastAttemptAt = tickerRefreshAttempts.get(ticker) || 0;
    const lastCheckedAt = Math.max(Number.isFinite(updatedAt) ? updatedAt : 0, lastAttemptAt);
    return lastCheckedAt === 0 || nowMs - lastCheckedAt >= retryDuration;
  });
}

async function refreshTickerCache(config) {
  const cache = readTickerCache();
  const attemptedAt = getNow().getTime();
  config.tickers.forEach(({ ticker }) => {
    tickerRefreshAttempts.set(ticker, attemptedAt);
    tickerRefreshOutcomes.set(ticker, false);
  });
  const fetched = await fetchTickerAthData(config, cache.tickers || {});
  let changed = false;
  for (const { ticker } of config.tickers) {
    const candidate = fetched[ticker];
    if (candidate && !candidate.error) {
      cache.tickers[ticker] = candidate;
      tickerRefreshOutcomes.set(ticker, true);
      changed = true;
    }
  }
  if (changed) {
    cache.updatedAt = new Date().toISOString();
    writeTickerCache(cache);
  }
  return cache;
}

function queueTickerRefresh(config) {
  const configSignature = JSON.stringify(config.tickers);
  if (tickerRefreshPromise) {
    if (configSignature !== activeTickerConfigSignature) {
      queuedTickerConfig = JSON.parse(JSON.stringify(config));
    }
    return tickerRefreshPromise;
  }
  queuedTickerConfig = JSON.parse(JSON.stringify(config));

  tickerRefreshPromise = (async () => {
    let latest = readTickerCache();
    while (queuedTickerConfig) {
      const nextConfig = queuedTickerConfig;
      queuedTickerConfig = null;
      activeTickerConfigSignature = JSON.stringify(nextConfig.tickers);
      try {
        latest = await refreshTickerCache(nextConfig);
      } catch (error) {
        console.error('[Ticker ATH Background Refresh]:', error.message);
      }
    }
    return latest;
  })().finally(() => {
    tickerRefreshPromise = null;
    activeTickerConfigSignature = null;
  });
  return tickerRefreshPromise;
}

app.get('/api/ticker-ath', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const config = readConfig();
    let cache = readTickerCache();
    const hasEveryTicker = config.tickers.every(({ ticker }) => cache.tickers?.[ticker]);
    const stale = isTickerCacheStale(cache, config);

    if (hasEveryTicker) {
      res.json({
        success: true,
        data: selectTickerData(cache, config),
        cached: true,
        stale,
        refreshing: stale,
        updatedAt: cache.updatedAt
      });
      if (stale) setImmediate(() => { void queueTickerRefresh(config); });
      return;
    }

    // A newly-added ticker has no value to serve yet. Bootstrap it once; all
    // subsequent requests, including after a process restart, use disk first.
    cache = await queueTickerRefresh(config);
    res.json({
      success: true,
      data: selectTickerData(cache, config, true),
      cached: false,
      stale: isTickerCacheStale(cache, config),
      refreshing: false,
      updatedAt: cache.updatedAt
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 2. 录入出入金记录
app.post('/api/transaction', (req, res) => {
  try {
    const { member, type, amount, cnhAmount, date, remark } = req.body;
    const db = readDb();
    if (date && rejectLockedPeriod(res, db, date)) return;

    const memberObj = db.members.find(m => m.id === member);
    if (!memberObj) {
      return res.status(400).json({ success: false, message: '无效的家庭成员' });
    }
    if (memberObj.roles?.lp === false) {
      return res.status(400).json({ success: false, message: '只有具有LP身份的成员可以登记出入金。' });
    }
    if (!['deposit', 'withdraw'].includes(type)) {
      return res.status(400).json({ success: false, message: '交易类型必须为入金(deposit)或出金(withdraw)' });
    }
    const parsedAmount = toFiniteNumber(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ success: false, message: '金额必须大于 0' });
    }

    // 处理人民币金额手动输入
    let parsedCnhAmount = undefined;
    if (cnhAmount !== undefined && cnhAmount !== '') {
      parsedCnhAmount = toFiniteNumber(cnhAmount);
      if (!Number.isFinite(parsedCnhAmount) || parsedCnhAmount <= 0) {
        return res.status(400).json({ success: false, message: '人民币金额必须大于 0' });
      }
    } else {
      parsedCnhAmount = parsedAmount * (db.cnhRate || 7.2);
    }

    if (!date) {
      return res.status(400).json({ success: false, message: '日期不能为空' });
    }

    // 如果是出金，先做一轮预演算，检查出金人当前份额换算成的资产是否足够
    // [Fix #5] 使用带缓存的 getState() 而非直接调用 calculateState()，避免不必要的重算
    let fullExit = false;
    if (type === 'withdraw') {
      const state = getState();
      const memberState = state.members[member];
      const memberValue = memberState ? memberState.currentValue : 0;
      if (parsedAmount > memberValue) {
        return res.status(400).json({
          success: false,
          message: `余额不足！${memberObj.name}当前资产为 $${memberValue.toFixed(2)}，无法提取 $${parsedAmount.toFixed(2)}`
        });
      }
      fullExit = Math.abs(parsedAmount - memberValue) <= Math.max(BALANCE_TOLERANCE, memberValue * 1e-10);
    }

    if (!isValidDate(date)) {
      return res.status(400).json({ success: false, message: '日期必须是有效的 YYYY-MM-DD。' });
    }
    if (!isSundayDate(date)) {
      return res.status(400).json({ success: false, message: '出入金仅在周日办理，交易日期必须为周日。' });
    }
    let normalizedRemark;
    try {
      normalizedRemark = normalizeRemark(remark);
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }
    const newEvent = {
      id: 'tx_' + randomUUID(), // [Fix #4] 使用 crypto.randomUUID() 替代 Math.random，消除碰撞风险
      type,
      member,
      amount: parsedAmount,
      cnhAmount: parsedCnhAmount,
      date,
      remark: normalizedRemark,
      createdAt: Date.now()
    };
    if (fullExit) newEvent.fullExit = true;
    if (type === 'withdraw' && db.performanceFee?.gpMemberId) {
      newEvent.performanceFee = { gpMember: db.performanceFee.gpMemberId, annualRate: 0.06, feeRate: 0.25 };
    }

    db.events.push(newEvent);
    const ledgerIssue = findLedgerIssue(db);
    if (ledgerIssue) return rejectLedgerIssue(res, ledgerIssue);
    if (newEvent.fullExit) {
      const computedEvent = calculateStateFromDb(JSON.parse(JSON.stringify(db))).events.find(event => event.id === newEvent.id);
      newEvent.requestedGrossAmount = parsedAmount;
      newEvent.amount = computedEvent._actualAmount;
      newEvent.cnhAmount = computedEvent._cnhAmountComputed;
    }
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

    const parsedNAV = toFiniteNumber(totalNAV);
    if (!Number.isFinite(parsedNAV) || parsedNAV <= 0) {
      return res.status(400).json({ success: false, message: '资产估值金额必须大于 0，零净值会导致后续份额无法定价。' });
    }
    if (!date) {
      return res.status(400).json({ success: false, message: '日期不能为空' });
    }

    const db = readDb();

    if (!isValidDate(date)) {
      return res.status(400).json({ success: false, message: '日期必须是有效的 YYYY-MM-DD。' });
    }
    const valuationDateError = validateValuationDate(date);
    if (valuationDateError) return res.status(400).json({ success: false, message: valuationDateError });
    if (rejectLockedPeriod(res, db, date)) return;
    let normalizedRemark;
    try {
      normalizedRemark = normalizeRemark(remark, '定期净值估值更新');
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }
    const newEvent = {
      id: 'val_' + randomUUID(), // [Fix #4] 使用 crypto.randomUUID() 替代 Math.random，消除碰撞风险
      type: 'valuation',
      totalNAV: parsedNAV,
      date,
      remark: normalizedRemark,
      createdAt: Date.now()
    };

    db.events.push(newEvent);
    const ledgerIssue = findLedgerIssue(db);
    if (ledgerIssue) return rejectLedgerIssue(res, ledgerIssue);
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
    if (date && rejectLockedPeriod(res, db, date)) return;

    if (fromMember === toMember) {
      return res.status(400).json({ success: false, message: '出让方与受让方不能为同一成员' });
    }

    const fromObj = db.members.find(m => m.id === fromMember);
    const toObj = db.members.find(m => m.id === toMember);
    if (!fromObj || !toObj) {
      return res.status(400).json({ success: false, message: '无效的转让成员' });
    }
    if (fromObj.roles?.lp === false || toObj.roles?.lp === false) {
      return res.status(400).json({ success: false, message: '普通投资份额只能在LP成员之间转让。' });
    }

    const parsedAmount = toFiniteNumber(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ success: false, message: '转让金额必须大于 0' });
    }

    const parsedRate = toFiniteNumber(cnhRate);
    if (!Number.isFinite(parsedRate) || parsedRate <= 0) {
      return res.status(400).json({ success: false, message: '受让汇率必须大于 0' });
    }

    if (!date) {
      return res.status(400).json({ success: false, message: '日期不能为空' });
    }

    // 检查出让方余额是否充足
    // [Fix #5] 使用带缓存的 getState() 而非直接调用 calculateState()，避免不必要的重算
    const state = getState();
    const fromMemberState = state.members[fromMember];
    const fromValue = fromMemberState ? fromMemberState.currentValue : 0;
    if (parsedAmount > fromValue) {
      return res.status(400).json({
        success: false,
        message: `出让方余额不足！${fromObj.name}当前资产为 $${fromValue.toFixed(2)}，无法划转 $${parsedAmount.toFixed(2)}`
      });
    }
    const fullExit = Math.abs(parsedAmount - fromValue) <= Math.max(BALANCE_TOLERANCE, fromValue * 1e-10);

    if (!isValidDate(date)) {
      return res.status(400).json({ success: false, message: '日期必须是有效的 YYYY-MM-DD。' });
    }
    if (!isSundayDate(date)) {
      return res.status(400).json({ success: false, message: '内部份额转让仅在周日办理，划转日期必须为周日。' });
    }
    let normalizedRemark;
    try {
      normalizedRemark = normalizeRemark(remark);
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }
    const newEvent = {
      id: 'tf_' + randomUUID(), // [Fix #4] 使用 crypto.randomUUID() 替代 Math.random，消除碰撞风险
      type: 'transfer',
      fromMember,
      toMember,
      amount: parsedAmount,
      cnhRate: parsedRate,
      cnhAmount: parsedAmount * parsedRate,
      date,
      remark: normalizedRemark,
      createdAt: Date.now()
    };
    if (fullExit) newEvent.fullExit = true;
    if (db.performanceFee?.gpMemberId) {
      newEvent.performanceFee = { gpMember: db.performanceFee.gpMemberId, annualRate: 0.06, feeRate: 0.25 };
    }

    db.events.push(newEvent);
    const ledgerIssue = findLedgerIssue(db);
    if (ledgerIssue) return rejectLedgerIssue(res, ledgerIssue);
    if (newEvent.fullExit) {
      const computedEvent = calculateStateFromDb(JSON.parse(JSON.stringify(db))).events.find(event => event.id === newEvent.id);
      newEvent.requestedGrossAmount = parsedAmount;
      newEvent.amount = computedEvent._actualAmount;
      newEvent.cnhAmount = computedEvent._cnhAmountComputed;
    }
    writeDb(db);

    // 静默后台触发指数同步
    ensureIndexCache([date]);

    res.json({ success: true, message: '内部份额转让登记成功', data: newEvent });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

function buildSettlementPreview(db, body) {
  const gpMember = db.performanceFee?.gpMemberId;
  const { date } = body;
  if (!isValidDate(date)) throw new Error('结算日期必须是有效的 YYYY-MM-DD。');
  const settledThrough = latestSettlementDate(db);
  if (settledThrough && date <= settledThrough) {
    throw new Error(`业绩结算已完成至 ${settledThrough}，新结算日期必须晚于该日期。`);
  }
  const gp = db.members.find(member => member.id === gpMember);
  if (!gp || gp.roles?.gp !== true) throw new Error('请先在成员设置中指定GP。');
  if (db.events.some(event => event.type === 'performance_settlement' && event.date === date)) {
    throw new Error('该日期已经完成过业绩结算。');
  }
  const valuationDate = db.events
    .filter(event => event.type === 'valuation' && event.date <= date)
    .map(event => event.date).sort().at(-1);
  if (!valuationDate) throw new Error('结算日以前没有可用的基金估值。');
  const previewDb = JSON.parse(JSON.stringify(db));
  const event = {
    id: 'preview_settlement', type: 'performance_settlement', date, gpMember,
    lpMembers: db.members.map(member => member.id),
    annualRate: 0.06, feeRate: 0.25, remark: body.remark || '年度业绩结算',
    createdAt: Number.MAX_SAFE_INTEGER
  };
  previewDb.events.push(event);
  const state = calculateStateFromDb(previewDb);
  const computed = state.events.find(item => item.id === event.id);
  return { event, breakdown: computed._breakdown, totalFee: computed._totalFee, feeShares: computed._feeShares, navPerShare: computed._navAtTx, valuationDate };
}

app.post('/api/performance-settlement/preview', (req, res) => {
  try {
    res.json({ success: true, data: buildSettlementPreview(readDb(), req.body || {}) });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.post('/api/performance-settlement', (req, res) => {
  try {
    const db = readDb();
    const preview = buildSettlementPreview(db, req.body || {});
    const event = { ...preview.event, id: 'settle_' + randomUUID(), createdAt: Date.now() };
    db.events.push(event);
    const savedState = calculateStateFromDb(JSON.parse(JSON.stringify(db)));
    const saved = savedState.events.find(item => item.id === event.id);
    event.snapshot = { breakdown: saved._breakdown, totalFee: saved._totalFee, feeShares: saved._feeShares, navPerShare: saved._navAtTx };
    const ledgerIssue = findLedgerIssue(db);
    if (ledgerIssue) return rejectLedgerIssue(res, ledgerIssue);
    const ledger = readSettlements();
    ledger.records.push(event);
    writeSettlements(ledger);
    res.json({ success: true, message: '业绩结算已确认，历史账期已锁定。', data: event });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.post('/api/performance-settlement/reverse-latest', (req, res) => {
  try {
    const ledger = readSettlements();
    const reversedIds = new Set(ledger.records
      .filter(record => record.type === 'performance_settlement_reversal')
      .map(record => record.settlementId));
    const latest = ledger.records
      .filter(record => record.type === 'performance_settlement' && !reversedIds.has(record.id))
      .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt)
      .at(-1);
    if (!latest) return res.status(404).json({ success: false, message: '当前没有可以撤销的有效结算。' });

    const projectedDb = readDb();
    projectedDb.events = projectedDb.events.filter(event => event.id !== latest.id);
    const issue = findLedgerIssue(projectedDb);
    if (issue) return rejectLedgerIssue(res, issue);

    const reversal = {
      id: 'settle_reversal_' + randomUUID(),
      type: 'performance_settlement_reversal',
      settlementId: latest.id,
      settlementDate: latest.date,
      date: getNow().toISOString().slice(0, 10),
      remark: normalizeRemark(req.body?.remark, '撤销最近一次业绩结算'),
      createdAt: Date.now()
    };
    ledger.records.push(reversal);
    writeSettlements(ledger);
    res.json({ success: true, message: `已冲销 ${latest.date} 的业绩结算并解除相应锁账。`, data: reversal });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
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
    if (db.events[index].type === 'performance_settlement') {
      return res.status(409).json({ success: false, message: '已确认的业绩结算不可直接删除。' });
    }
    if (rejectLockedPeriod(res, db, db.events[index].date)) return;

    const removedEvent = db.events.splice(index, 1)[0];
    const ledgerIssue = findLedgerIssue(db);
    if (ledgerIssue) return rejectLedgerIssue(res, ledgerIssue);
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
    if (event.type === 'performance_settlement') {
      return res.status(409).json({ success: false, message: '已确认的业绩结算不可直接修改。' });
    }
    if (rejectLockedPeriod(res, db, event.date)) return;
    const requestedDate = req.body?.date;
    if (requestedDate !== undefined) {
      if (!isValidDate(requestedDate)) {
        return res.status(400).json({ success: false, message: '日期必须是有效的 YYYY-MM-DD。' });
      }
      if (rejectLockedPeriod(res, db, requestedDate)) return;
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
        const parsedAmount = toFiniteNumber(amount);
        if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
          return res.status(400).json({ success: false, message: '美元金额必须大于 0' });
        }
        event.amount = parsedAmount;
      }

      if (cnhAmount !== undefined) {
        const parsedCnh = toFiniteNumber(cnhAmount);
        if (!Number.isFinite(parsedCnh) || parsedCnh <= 0) {
          return res.status(400).json({ success: false, message: '人民币金额必须大于 0' });
        }
        event.cnhAmount = parsedCnh;
      }

      if (date !== undefined) {
        if (!isValidDate(date)) return res.status(400).json({ success: false, message: '日期必须是有效的 YYYY-MM-DD。' });
        if (!isSundayDate(date)) return res.status(400).json({ success: false, message: '出入金仅在周日办理，交易日期必须为周日。' });
        event.date = date;
      }

      if (remark !== undefined) {
        try {
          event.remark = normalizeRemark(remark);
        } catch (error) {
          return res.status(400).json({ success: false, message: error.message });
        }
      }

      if (event.type === 'withdraw') {
        const validationDb = JSON.parse(JSON.stringify(db));
        const validationState = calculateStateFromDb(validationDb);
        const validationEvent = validationState.events.find(e => e.id === eventId);
        const actualAmount = validationEvent ? (validationEvent._grossAmount ?? validationEvent._actualAmount ?? 0) : 0;
        if (actualAmount + 0.000001 < event.amount) {
          return res.status(400).json({
            success: false,
            message: `余额不足：该修改会导致实际可出金 $${actualAmount.toFixed(2)}，低于填写金额 $${event.amount.toFixed(2)}`
          });
        }
      }
    } else if (event.type === 'valuation') {
      const { totalNAV, date, remark } = req.body;

      if (totalNAV !== undefined) {
        const parsedNAV = toFiniteNumber(totalNAV);
        if (!Number.isFinite(parsedNAV) || parsedNAV <= 0) {
          return res.status(400).json({ success: false, message: '资产估值金额必须大于 0，零净值会导致后续份额无法定价。' });
        }
        event.totalNAV = parsedNAV;
      }

      if (date !== undefined) {
        if (!isValidDate(date)) return res.status(400).json({ success: false, message: '日期必须是有效的 YYYY-MM-DD。' });
        const valuationDateError = validateValuationDate(date);
        if (valuationDateError) return res.status(400).json({ success: false, message: valuationDateError });
        event.date = date;
      }

      if (remark !== undefined) {
        try {
          event.remark = normalizeRemark(remark);
        } catch (error) {
          return res.status(400).json({ success: false, message: error.message });
        }
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
        const parsedAmount = toFiniteNumber(amount);
        if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
          return res.status(400).json({ success: false, message: '转让金额必须大于 0' });
        }
        event.amount = parsedAmount;
      }

      if (cnhRate !== undefined) {
        const parsedRate = toFiniteNumber(cnhRate);
        if (!Number.isFinite(parsedRate) || parsedRate <= 0) {
          return res.status(400).json({ success: false, message: '受让汇率必须大于 0' });
        }
        event.cnhRate = parsedRate;
      }

      // 重新计算 cnhAmount
      event.cnhAmount = event.amount * (event.cnhRate || db.cnhRate || 7.2);

      if (date !== undefined) {
        if (!isValidDate(date)) return res.status(400).json({ success: false, message: '日期必须是有效的 YYYY-MM-DD。' });
        if (!isSundayDate(date)) return res.status(400).json({ success: false, message: '内部份额转让仅在周日办理，划转日期必须为周日。' });
        event.date = date;
      }

      if (remark !== undefined) {
        try {
          event.remark = normalizeRemark(remark);
        } catch (error) {
          return res.status(400).json({ success: false, message: error.message });
        }
      }

      const validationDb = JSON.parse(JSON.stringify(db));
      const validationState = calculateStateFromDb(validationDb);
      const validationEvent = validationState.events.find(e => e.id === eventId);
      const actualAmount = validationEvent ? (validationEvent._grossAmount ?? validationEvent._actualAmount ?? 0) : 0;
      if (actualAmount + 0.000001 < event.amount) {
        return res.status(400).json({
          success: false,
          message: `出让方余额不足：该修改会导致实际可转让 $${actualAmount.toFixed(2)}，低于填写金额 $${event.amount.toFixed(2)}`
        });
      }
    }

    const ledgerIssue = findLedgerIssue(db);
    if (ledgerIssue) return rejectLedgerIssue(res, ledgerIssue);

    writeDb(db);

    // 触发指数同步
    if (event.date) ensureIndexCache([event.date]);

    res.json({ success: true, message: '账目记录修改成功，系统已自动重算', data: event });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取当前配置的标的列表
app.get('/api/settings/tickers', (req, res) => {
  try {
    const config = readConfig();
    res.json({ success: true, data: config.tickers });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 保存用户配置的标的列表
app.post('/api/settings/tickers', (req, res) => {
  try {
    const { tickers } = req.body;
    if (!Array.isArray(tickers)) {
      return res.status(400).json({ success: false, message: '无效的标的列表数据格式' });
    }
    if (tickers.length < 1) {
      return res.status(400).json({ success: false, message: '至少需要追踪 1 个标的' });
    }

    const cleanedTickers = tickers.map(e => {
      if (!e.ticker || !e.ticker.trim()) {
        throw new Error('标的代码不能为空');
      }
      const cleanTicker = e.ticker.trim().toUpperCase();
      // [Fix #1] 白名单校验：仅允许股票代码合法字符（字母、数字、连字符、点、脱字符），长度 1-20
      if (!/^[\^A-Z0-9.\-]{1,20}$/.test(cleanTicker)) {
        throw new Error(`标的代码格式非法（只允许字母、数字、.-^符号）: ${cleanTicker}`);
      }
      return {
        ticker: cleanTicker
      };
    });

    const config = readConfig();
    config.tickers = cleanedTickers;
    writeConfig(config);

    void queueTickerRefresh(config);

    res.json({ success: true, message: '标的配置保存成功！', data: cleanedTickers });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// 4.8. 更新全局系统参数（汇率配置）
app.post('/api/settings', (req, res) => {
  try {
    const { cnhRate, benchmarkClosePolicy } = req.body;
    const db = readDb();

    if (cnhRate !== undefined) {
      const parsedRate = toFiniteNumber(cnhRate);
      if (!Number.isFinite(parsedRate) || parsedRate <= 0) {
        return res.status(400).json({ success: false, message: '汇率参数必须大于 0' });
      }
      db.cnhRate = parsedRate;
    }

    if (benchmarkClosePolicy !== undefined) {
      if (!['previous', 'same_day'].includes(benchmarkClosePolicy)) {
        return res.status(400).json({ success: false, message: '指数收盘口径无效' });
      }
      db.benchmarkClosePolicy = benchmarkClosePolicy;
    }

    writeDb(db);
    if (benchmarkClosePolicy !== undefined && db.events.length > 0) {
      ensureIndexCache(db.events.map(event => event.date));
    }
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

// 5. 数据一键导出备份：完整打包 data/db.json 与 data/config.json
app.get('/api/backup/export', (req, res) => {
  try {
    const db = readDb();
    const config = readConfig();
    const settlements = readSettlements();
    const zip = new AdmZip();
    const baseDb = {
      ...db,
      events: db.events.filter(event =>
        event.type !== 'performance_settlement' && event.type !== 'performance_settlement_reversal')
    };
    zip.addFile('data/db.json', Buffer.from(JSON.stringify(baseDb, null, 2), 'utf8'));
    zip.addFile('data/config.json', Buffer.from(JSON.stringify(config, null, 2), 'utf8'));
    zip.addFile('data/settlements.json', Buffer.from(JSON.stringify(settlements, null, 2), 'utf8'));

    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename=family_fund_backup_${date}.zip`);
    res.send(zip.toBuffer());
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/ticker-ath/refresh', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const config = readConfig();
    const cache = await queueTickerRefresh(config);
    const failedTickers = config.tickers
      .map(({ ticker }) => ticker)
      .filter(ticker => tickerRefreshOutcomes.get(ticker) !== true);
    res.json({
      success: true,
      data: selectTickerData(cache, config, true),
      refreshSuccess: failedTickers.length === 0,
      failedTickers,
      updatedAt: cache.updatedAt
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 6. 数据导入恢复：校验 ZIP 快照后覆盖当前 db.json 与 config.json
app.post('/api/backup/import', express.raw({
  type: ['application/zip', 'application/octet-stream'],
  limit: '10mb'
}), (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ success: false, message: '请选择有效的 ZIP 备份文件。' });
    }

    let zip;
    try {
      zip = new AdmZip(req.body);
    } catch (_) {
      return res.status(400).json({ success: false, message: '备份文件不是有效的 ZIP 压缩包。' });
    }

    const dbEntry = zip.getEntry('data/db.json') || zip.getEntry('db.json');
    const configEntry = zip.getEntry('data/config.json') || zip.getEntry('config.json');
    const settlementsEntry = zip.getEntry('data/settlements.json') || zip.getEntry('settlements.json');
    if (!dbEntry || !configEntry || dbEntry.isDirectory || configEntry.isDirectory) {
      return res.status(400).json({ success: false, message: 'ZIP 中必须包含 data/db.json 和 data/config.json。' });
    }
    const totalUncompressedSize = Number(dbEntry.header.size) + Number(configEntry.header.size) +
      (settlementsEntry ? Number(settlementsEntry.header.size) : 0);
    if (!Number.isFinite(totalUncompressedSize) || totalUncompressedSize > 10 * 1024 * 1024) {
      return res.status(400).json({ success: false, message: 'ZIP 内的数据文件过大（最大 10MB）。' });
    }

    let backupDb;
    let backupConfig;
    let backupSettlements = { version: 1, records: [] };
    try {
      backupDb = JSON.parse(dbEntry.getData().toString('utf8'));
      backupConfig = JSON.parse(configEntry.getData().toString('utf8'));
      if (settlementsEntry && !settlementsEntry.isDirectory) {
        backupSettlements = JSON.parse(settlementsEntry.getData().toString('utf8'));
      }
    } catch (_) {
      return res.status(400).json({ success: false, message: 'ZIP 中的 JSON 数据损坏或无法解析。' });
    }

    const { events, members, cnhRate, indexCache, benchmarkClosePolicy, performanceFee } = backupDb || {};
    if (!Array.isArray(events)) {
      return res.status(400).json({ success: false, message: '导入的数据格式不正确，缺少 events 数组' });
    }
    if (!settlementsEntry) {
      backupSettlements = {
        version: 1,
        records: events.filter(event =>
          event.type === 'performance_settlement' || event.type === 'performance_settlement_reversal')
      };
    }

    // [Fix #2] 深度格式校验：类型白名单、数量上限、字段合法性
    const VALID_EVENT_TYPES = ['deposit', 'withdraw', 'valuation', 'transfer', 'performance_settlement', 'performance_settlement_reversal'];
    const currentDb = readDb();
    const importedMembers = Array.isArray(members) ? members : currentDb.members;
    if (!Array.isArray(importedMembers) || importedMembers.length < 1 || importedMembers.length > 100) {
      return res.status(400).json({ success: false, message: 'Imported members must contain 1 to 100 entries.' });
    }
    const memberIds = new Set();
    for (const member of importedMembers) {
      if (!member || typeof member.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(member.id) ||
          typeof member.name !== 'string' || member.name.trim().length < 1 || member.name.trim().length > 50 ||
          memberIds.has(member.id)) {
        return res.status(400).json({ success: false, message: 'Imported members contain an invalid or duplicate id/name.' });
      }
      memberIds.add(member.id);
    }
    if (events.length > 10000) {
      return res.status(400).json({ success: false, message: '导入事件数量超限（最大 10000 条）' });
    }
    const eventIds = new Set();
    for (let e of events) {
      if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(e.id) || eventIds.has(e.id) ||
          !e.type || !e.date || !Number.isFinite(e.createdAt)) {
        return res.status(400).json({ success: false, message: '导入的数据中存在格式不完整的事件项' });
      }
      eventIds.add(e.id);
      if (!VALID_EVENT_TYPES.includes(e.type)) {
        return res.status(400).json({ success: false, message: `导入数据中包含非法事件类型: ${e.type}` });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) {
        return res.status(400).json({ success: false, message: `导入数据中包含非法日期格式: ${e.date}` });
      }
      if (!isValidDate(e.date)) {
        return res.status(400).json({ success: false, message: `Imported data contains an invalid calendar date: ${e.date}` });
      }
      if ((e.type === 'deposit' || e.type === 'withdraw') &&
          (typeof e.amount !== 'number' || e.amount <= 0 || !isFinite(e.amount))) {
        return res.status(400).json({ success: false, message: `导入数据中存在非法金额: ${e.amount}` });
      }
      if ((e.type === 'deposit' || e.type === 'withdraw') && !memberIds.has(e.member)) {
        return res.status(400).json({ success: false, message: 'A transaction references a member that does not exist.' });
      }
      if ((e.type === 'deposit' || e.type === 'withdraw') && e.cnhAmount !== undefined &&
          (typeof e.cnhAmount !== 'number' || e.cnhAmount <= 0 || !Number.isFinite(e.cnhAmount))) {
        return res.status(400).json({ success: false, message: '出入金记录中包含非法人民币金额。' });
      }
      if (e.type === 'valuation' &&
          (typeof e.totalNAV !== 'number' || e.totalNAV <= 0 || !isFinite(e.totalNAV))) {
        return res.status(400).json({ success: false, message: `导入数据中存在非法估值金额: ${e.totalNAV}` });
      }
      if (e.type === 'transfer' &&
          (typeof e.amount !== 'number' || e.amount <= 0 || !isFinite(e.amount))) {
        return res.status(400).json({ success: false, message: `导入数据中存在非法划转金额: ${e.amount}` });
      }
      if (e.type === 'transfer' &&
          (!memberIds.has(e.fromMember) || !memberIds.has(e.toMember) || e.fromMember === e.toMember ||
           (e.cnhRate !== undefined && (typeof e.cnhRate !== 'number' || e.cnhRate <= 0 || !isFinite(e.cnhRate))))) {
        return res.status(400).json({ success: false, message: 'A transfer contains invalid member references or exchange rate.' });
      }
      if ((e.type === 'withdraw' || e.type === 'transfer') && e.performanceFee &&
          (!memberIds.has(e.performanceFee.gpMember) || e.performanceFee.annualRate !== 0.06 || e.performanceFee.feeRate !== 0.25)) {
        return res.status(400).json({ success: false, message: '部分退出记录包含无效的业绩结算参数快照。' });
      }
      if (e.type === 'performance_settlement' &&
          (!memberIds.has(e.gpMember) || e.annualRate !== 0.06 || e.feeRate !== 0.25)) {
        return res.status(400).json({ success: false, message: '业绩结算记录包含无效的GP或费率参数。' });
      }
    }

    let importedCnhRate = currentDb.cnhRate;
    if (cnhRate !== undefined) {
      importedCnhRate = toFiniteNumber(cnhRate);
      if (!Number.isFinite(importedCnhRate) || importedCnhRate <= 0) {
        return res.status(400).json({ success: false, message: '导入数据中的汇率参数必须大于 0' });
      }
    }

    const db = {
      members: importedMembers.map(member => ({
        id: member.id,
        name: member.name.trim(),
        roles: {
          lp: true,
          gp: member.id === performanceFee?.gpMemberId
        }
      })),
      events: events.filter(event =>
        event.type !== 'performance_settlement' && event.type !== 'performance_settlement_reversal'),
      cnhRate: importedCnhRate,
      benchmarkClosePolicy: ['previous', 'same_day'].includes(benchmarkClosePolicy)
        ? benchmarkClosePolicy
        : (currentDb.benchmarkClosePolicy || 'previous'),
      performanceFee: {
        gpMemberId: importedMembers.some(member => member.id === performanceFee?.gpMemberId && member.roles?.gp === true)
          ? performanceFee.gpMemberId : null,
        annualRate: 0.06,
        feeRate: 0.25
      },
      indexCache: (indexCache && typeof indexCache === 'object' && !Array.isArray(indexCache))
        ? indexCache
        : (currentDb.indexCache || {})
    };
    const ledgerIssue = findLedgerIssue(db);
    if (ledgerIssue) return rejectLedgerIssue(res, ledgerIssue);

    if (!backupConfig || !Array.isArray(backupConfig.tickers) || backupConfig.tickers.length < 1) {
      return res.status(400).json({ success: false, message: '备份中的标的配置无效（至少需要 1 个标的）。' });
    }
    if (backupSettlements?.version !== 1 || !Array.isArray(backupSettlements.records)) {
      return res.status(400).json({ success: false, message: '备份中的独立结算账本格式无效。' });
    }
    const settlementIds = new Set();
    for (const record of backupSettlements.records) {
      if (!record || typeof record.id !== 'string' || settlementIds.has(record.id) ||
          !['performance_settlement', 'performance_settlement_reversal'].includes(record.type) ||
          !isValidDate(record.date) || !Number.isFinite(record.createdAt)) {
        return res.status(400).json({ success: false, message: '独立结算账本包含无效或重复记录。' });
      }
      if (record.type === 'performance_settlement' &&
          (!memberIds.has(record.gpMember) || record.annualRate !== 0.06 || record.feeRate !== 0.25)) {
        return res.status(400).json({ success: false, message: '独立结算账本包含无效的结算参数。' });
      }
      if (record.type === 'performance_settlement_reversal' &&
          (typeof record.settlementId !== 'string' || !backupSettlements.records.some(item => item.id === record.settlementId && item.type === 'performance_settlement'))) {
        return res.status(400).json({ success: false, message: '独立结算账本包含无效的冲销引用。' });
      }
      settlementIds.add(record.id);
    }
    const importedTickers = [];
    for (const item of backupConfig.tickers) {
      const ticker = typeof item?.ticker === 'string' ? item.ticker.trim().toUpperCase() : '';
      if (!/^[\^A-Z0-9.\-]{1,20}$/.test(ticker)) {
        return res.status(400).json({ success: false, message: `备份中的标的代码无效：${ticker || '(空)'}` });
      }
      importedTickers.push({ ticker });
    }
    if (new Set(importedTickers.map(item => item.ticker)).size !== importedTickers.length) {
      return res.status(400).json({ success: false, message: '备份中的标的代码不能重复。' });
    }

    writeSnapshot(db, { tickers: importedTickers });
    writeSettlements(backupSettlements);
    void queueTickerRefresh({ tickers: importedTickers });

    // 批量导入触发指数同步
    if (events && events.length > 0) {
      ensureIndexCache(events.map(e => e.date));
    }

    res.json({ success: true, message: 'ZIP 快照已恢复，账目与系统配置均已覆盖并重新计算。' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 7. 家庭成员增删改 API 路由

// 获取成员列表
app.get('/api/members', (req, res) => {
  try {
    const db = readDb();
    res.json({
      success: true,
      data: db.members.map(member => ({
        ...member,
        roles: member.roles || { lp: true, gp: false },
        primaryGp: db.performanceFee?.gpMemberId === member.id
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 新增成员
app.post('/api/members', (req, res) => {
  try {
    const { name } = req.body;
    const db = readDb();
    let trimmedName;
    try {
      trimmedName = normalizeMemberName(name);
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

    if (db.members.some(m => m.name === trimmedName)) {
      return res.status(400).json({ success: false, message: '该成员姓名已存在' });
    }

    const newMember = {
      id: 'mem_' + randomUUID(),
      name: trimmedName,
      roles: { lp: true, gp: false }
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
    const db = readDb();
    let trimmedName;
    try {
      trimmedName = normalizeMemberName(name);
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

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

app.put('/api/members/:id/roles', (req, res) => {
  try {
    const db = readDb();
    const member = db.members.find(item => item.id === req.params.id);
    if (!member) return res.status(404).json({ success: false, message: '未找到该家庭成员' });
    db.performanceFee ||= { gpMemberId: null, annualRate: 0.06, feeRate: 0.25 };
    if (req.body?.gp !== true && req.body?.primaryGp !== true) {
      return res.status(400).json({ success: false, message: '系统必须指定且只能指定一位GP。' });
    }
    db.performanceFee.gpMemberId = member.id;
    db.members.forEach(item => {
      item.roles = { lp: true, gp: db.performanceFee.gpMemberId === item.id };
    });
    writeDb(db);
    res.json({ success: true, message: '唯一GP已更新。' });
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

    // 安全检查：如果该成员已经录入过出入金或参与过转让，则绝对不允许删除
    const hasTransactions = db.events.some(e =>
      e.member === memberId || e.fromMember === memberId || e.toMember === memberId || e.gpMember === memberId
    ) || readSettlements().records.some(record =>
      record.gpMember === memberId || record.lpMembers?.includes(memberId)
    );
    if (hasTransactions) {
      return res.status(400).json({
        success: false,
        message: '删除失败！该成员已有出入金或转让记录，删除其账号会破坏历史净值计算。若不需要显示该成员，可在无持股时将其更名或保留。'
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
}

module.exports = { registerApiRoutes };
