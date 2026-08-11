const { CURRENT_SETTLEMENT_VERSION } = require('../lib/performance-settlement');
const { createSettlementFeeSnapshot } = require('../lib/performance-fee-policy');

function registerSettlementRoutes(app, deps, utils) {
  const { readDb, readSettlements, writeSettlements, calculateStateFromDb,
    isValidDate, normalizeRemark, randomUUID, now: getNow } = deps;
  const { findLedgerIssue, rejectLedgerIssue, latestSettlementDate } = utils;

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
  const feeRates = createSettlementFeeSnapshot(db.performanceFee);
  const previewDb = JSON.parse(JSON.stringify(db));
  const event = {
    id: 'preview_settlement', type: 'performance_settlement', date, gpMember,
    lpMembers: db.members.map(member => member.id),
    algorithmVersion: CURRENT_SETTLEMENT_VERSION,
    ...feeRates, remark: body.remark || '年度业绩结算',
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

}

module.exports = { registerSettlementRoutes };
