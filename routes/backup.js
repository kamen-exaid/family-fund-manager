const express = require('express');
const AdmZip = require('adm-zip');
const { mergeSettlementLedger, migrateSettlementLedger } = require('../lib/settlement-ledger');

function registerBackupRoutes(app, deps, utils, tickerUtils) {
  const { readDb, readSettlements, readConfig, writeSnapshot,
    writeIndexCache = () => {}, ensureIndexCache, isValidDate } = deps;
  const { toFiniteNumber, findLedgerIssue, rejectLedgerIssue } = utils;
  const { queueTickerRefresh } = tickerUtils;

// 5. 数据一键导出备份：完整打包 data/db.json 与 data/config.json
app.get('/api/backup/export', (req, res) => {
  try {
    const db = readDb();
    const config = readConfig();
    const settlements = readSettlements();
    const zip = new AdmZip();
    const { indexCache: _indexCache, ...coreDb } = db;
    const baseDb = {
      ...coreDb,
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
          (!memberIds.has(e.performanceFee.gpMember) ||
           e.performanceFee.annualRate !== 0.06 ||
           e.performanceFee.feeRate !== 0.25 ||
           (e.performanceFee.disposalVersion !== undefined &&
            ![1, 2].includes(e.performanceFee.disposalVersion)))) {
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

    const importedIndexCache = (indexCache && typeof indexCache === 'object' && !Array.isArray(indexCache))
      ? indexCache
      : (currentDb.indexCache || {});
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
      benchmarkClosePolicy: 'previous',
      performanceFee: {
        gpMemberId: importedMembers.some(member => member.id === performanceFee?.gpMemberId && member.roles?.gp === true)
          ? performanceFee.gpMemberId : null,
        annualRate: 0.06,
        feeRate: 0.25
      }
    };
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
    let settlementMigration;
    try {
      settlementMigration = migrateSettlementLedger(db, backupSettlements);
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }
    const projectedDb = mergeSettlementLedger({ ...db, indexCache: importedIndexCache }, settlementMigration.ledger);
    const ledgerIssue = findLedgerIssue(projectedDb);
    if (ledgerIssue) return rejectLedgerIssue(res, ledgerIssue);

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

    writeSnapshot(db, { tickers: importedTickers }, settlementMigration.ledger);
    try {
      writeIndexCache(importedIndexCache);
    } catch (error) {
      // Market data is disposable. A cache write failure must not turn a
      // successful core-ledger restore into an ambiguous failed import.
      console.error('Failed to restore optional index cache:', error.message);
    }
    void queueTickerRefresh({ tickers: importedTickers });

    // 批量导入触发指数同步
    if (events && events.length > 0) {
      ensureIndexCache(projectedDb.events.map(e => e.date));
    }

    const migrationNotice = settlementMigration.migrated
      ? `，并已为 ${settlementMigration.migratedCount} 笔历史结算补充算法版本`
      : '';
    res.json({ success: true, message: `ZIP 快照已恢复，账目、结算与系统配置均已原子覆盖并重新计算${migrationNotice}。` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
}

module.exports = { registerBackupRoutes };
