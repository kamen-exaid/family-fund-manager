const Decimal = require('decimal.js');

// Ledger values must never be accumulated with binary floating point.  Keep
// all monetary amounts, NAVs and shares as decimals during replay, then round
// only at the API boundary.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

const ZERO = new Decimal(0);
const ONE = new Decimal(1);

function decimal(value) {
  return new Decimal(value);
}

function output(value, decimalPlaces) {
  return decimal(value).toDecimalPlaces(decimalPlaces).toNumber();
}

function assertTradableNav(event, currentNAV) {
  if (currentNAV.lte(ZERO)) {
    throw new Error(`账本在 ${event.date} 的${event.type === 'deposit' ? '入金' : event.type === 'withdraw' ? '出金' : '转让'}前净值为 0，无法计算份额。请删除或修改此前的零估值记录。`);
  }
}

function isUsableIndexEntry(entry, navDate, policy) {
  const isValidSourceDate = sourceDate => policy === 'same_day'
    ? sourceDate <= navDate
    : sourceDate < navDate;
  return entry &&
    entry.policy === policy &&
    typeof entry.spxPriceDate === 'string' &&
    isValidSourceDate(entry.spxPriceDate) &&
    typeof entry.ndxPriceDate === 'string' &&
    isValidSourceDate(entry.ndxPriceDate) &&
    Number.isFinite(entry.spx) &&
    Number.isFinite(entry.ndx);
}

function findIndices(dateStr, cache, policy) {
  if (isUsableIndexEntry(cache[dateStr], dateStr, policy)) return cache[dateStr];

  // Never use a later event's cache entry as a fallback: that would leak
  // future market information while the background refresh is still running.
  const fallbackDate = Object.keys(cache)
    .filter(candidate => candidate < dateStr && isUsableIndexEntry(cache[candidate], candidate, policy))
    .sort()
    .at(-1);
  return fallbackDate ? cache[fallbackDate] : null;
}

function calculateStateFromDb(db) {
  const sortedEvents = [...db.events].sort((a, b) => {
    const dateCompare = a.date.localeCompare(b.date);
    return dateCompare !== 0 ? dateCompare : a.createdAt - b.createdAt;
  });

  let navPerShare = ONE;
  let totalShares = ZERO;
  let totalNAV = ZERO;
  // Fund-level performance must only reflect cash crossing the family-fund
  // boundary. Member-to-member transfers remain in personal ledgers only.
  let fundExternalDeposit = ZERO;
  let fundExternalWithdraw = ZERO;
  let fundExternalCnhDeposit = ZERO;
  let fundExternalCnhWithdraw = ZERO;
  const globalCnhRate = decimal(db.cnhRate || 7.2);

  const members = {};
  const memberHistory = {};
  db.members.forEach(m => {
    members[m.id] = {
      id: m.id,
      name: m.name,
      shares: ZERO,
      totalDeposit: ZERO,
      totalWithdraw: ZERO,
      cnhDeposit: ZERO,
      cnhWithdraw: ZERO
    };
    memberHistory[m.id] = [];
  });

  const navHistory = [];
  const indexCache = db.indexCache || {};
  const benchmarkClosePolicy = db.benchmarkClosePolicy === 'same_day' ? 'same_day' : 'previous';
  let baseSpx = 5000;
  let baseNdx = 18000;
  if (sortedEvents.length > 0) {
    const inceptionDate = sortedEvents[0].date;
    const baseIndices = findIndices(inceptionDate, indexCache, benchmarkClosePolicy);
    if (baseIndices) {
      baseSpx = baseIndices.spx;
      baseNdx = baseIndices.ndx;
    }
  }

  sortedEvents.forEach(event => {
    const currentNAV = totalShares.isZero() ? ONE : navPerShare;

    if (event.type === 'deposit') {
      assertTradableNav(event, currentNAV);
      const amount = decimal(event.amount);
      const eventCnhAmount = event.cnhAmount !== undefined
        ? decimal(event.cnhAmount)
        : amount.mul(globalCnhRate);
      const sharesGained = amount.div(currentNAV);
      const member = members[event.member];

      if (member) {
        member.shares = member.shares.plus(sharesGained);
        member.totalDeposit = member.totalDeposit.plus(amount);
        member.cnhDeposit = member.cnhDeposit.plus(eventCnhAmount);
        totalShares = totalShares.plus(sharesGained);
        fundExternalDeposit = fundExternalDeposit.plus(amount);
        fundExternalCnhDeposit = fundExternalCnhDeposit.plus(eventCnhAmount);
      }
      totalNAV = totalShares.mul(currentNAV);
      navPerShare = currentNAV;
      event._sharesGained = output(sharesGained, 12);
      event._navAtTx = output(currentNAV, 12);
      event._totalSharesAfter = output(totalShares, 12);
      event._totalNAVAfter = output(totalNAV, 12);
      event._cnhAmountComputed = output(eventCnhAmount, 12);

    } else if (event.type === 'withdraw') {
      assertTradableNav(event, currentNAV);
      const amount = decimal(event.amount);
      let eventCnhAmount = event.cnhAmount !== undefined
        ? decimal(event.cnhAmount)
        : amount.mul(globalCnhRate);
      let sharesDeducted = ZERO;
      let actualAmount = ZERO;
      const member = members[event.member];

      if (member) {
        sharesDeducted = amount.div(currentNAV);
        if (sharesDeducted.greaterThan(member.shares)) {
          sharesDeducted = member.shares;
          if (member.shares.mul(currentNAV).isZero()) eventCnhAmount = ZERO;
        }
        actualAmount = sharesDeducted.mul(currentNAV);
        member.shares = member.shares.minus(sharesDeducted);
        member.totalWithdraw = member.totalWithdraw.plus(actualAmount);
        member.cnhWithdraw = member.cnhWithdraw.plus(eventCnhAmount);
        totalShares = totalShares.minus(sharesDeducted);
        fundExternalWithdraw = fundExternalWithdraw.plus(actualAmount);
        fundExternalCnhWithdraw = fundExternalCnhWithdraw.plus(eventCnhAmount);
      }
      totalNAV = totalShares.mul(currentNAV);
      navPerShare = currentNAV;
      event._sharesDeducted = output(sharesDeducted, 12);
      event._navAtTx = output(currentNAV, 12);
      event._totalSharesAfter = output(totalShares, 12);
      event._totalNAVAfter = output(totalNAV, 12);
      event._actualAmount = output(actualAmount, 12);
      event._cnhAmountComputed = output(eventCnhAmount, 12);

    } else if (event.type === 'valuation') {
      event._hasSharesAtValuation = !totalShares.isZero();
      totalNAV = decimal(event.totalNAV);
      navPerShare = totalShares.isZero() ? ONE : totalNAV.div(totalShares);
      event._navAtTx = output(navPerShare, 12);
      event._totalSharesAfter = output(totalShares, 12);
      event._totalNAVAfter = output(totalNAV, 12);

    } else if (event.type === 'transfer') {
      assertTradableNav(event, currentNAV);
      const amount = decimal(event.amount);
      const eventRate = event.cnhRate !== undefined ? decimal(event.cnhRate) : globalCnhRate;
      const eventCnhAmount = amount.mul(eventRate);
      let sharesTransferred = amount.div(currentNAV);
      let actualAmount = ZERO;
      const fromMember = members[event.fromMember];
      const toMember = members[event.toMember];

      if (fromMember) {
        if (sharesTransferred.greaterThan(fromMember.shares)) sharesTransferred = fromMember.shares;
        actualAmount = sharesTransferred.mul(currentNAV);
        fromMember.shares = fromMember.shares.minus(sharesTransferred);
        fromMember.totalWithdraw = fromMember.totalWithdraw.plus(actualAmount);
        fromMember.cnhWithdraw = fromMember.cnhWithdraw.plus(eventCnhAmount);
        if (toMember) {
          toMember.shares = toMember.shares.plus(sharesTransferred);
          toMember.totalDeposit = toMember.totalDeposit.plus(actualAmount);
          toMember.cnhDeposit = toMember.cnhDeposit.plus(eventCnhAmount);
        }
      }
      totalNAV = totalShares.mul(currentNAV);
      navPerShare = currentNAV;
      event._sharesTransferred = output(sharesTransferred, 12);
      event._navAtTx = output(currentNAV, 12);
      event._totalSharesAfter = output(totalShares, 12);
      event._totalNAVAfter = output(totalNAV, 12);
      event._actualAmount = output(actualAmount, 12);
      event._cnhAmountComputed = output(eventCnhAmount, 12);
    }

    let sp500NAV = 1;
    let ndxNAV = 1;
    const currentIndices = findIndices(event.date, indexCache, benchmarkClosePolicy);
    if (currentIndices && Number.isFinite(currentIndices.spx) && Number.isFinite(currentIndices.ndx) && baseSpx && baseNdx) {
      sp500NAV = Number((currentIndices.spx / baseSpx).toFixed(4));
      ndxNAV = Number((currentIndices.ndx / baseNdx).toFixed(4));
    }

    navHistory.push({
      eventId: event.id,
      date: event.date,
      navPerShare: output(navPerShare, 4),
      totalNAV: output(totalNAV, 2),
      totalShares: output(totalShares, 4),
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

    Object.keys(members).forEach(k => {
      memberHistory[k].push({
        date: event.date,
        shares: output(members[k].shares, 12),
        value: output(members[k].shares.mul(navPerShare), 12)
      });
    });
  });

  const computedMembers = {};
  Object.keys(members).forEach(k => {
    const member = members[k];
    const currentValue = member.shares.mul(navPerShare);
    const profit = currentValue.plus(member.totalWithdraw).minus(member.totalDeposit);
    const profitRate = member.totalDeposit.isZero() ? ZERO : profit.div(member.totalDeposit).mul(100);
    const cnhCurrentValue = currentValue.mul(globalCnhRate);
    const cnhProfit = cnhCurrentValue.plus(member.cnhWithdraw).minus(member.cnhDeposit);
    const cnhProfitRate = member.cnhDeposit.isZero() ? ZERO : cnhProfit.div(member.cnhDeposit).mul(100);

    computedMembers[k] = {
      name: member.name,
      shares: output(member.shares, 4),
      currentValue: output(currentValue, 2),
      totalDeposit: output(member.totalDeposit, 2),
      totalWithdraw: output(member.totalWithdraw, 2),
      profit: output(profit, 2),
      profitRate: output(profitRate, 2),
      cnhCurrentValue: output(cnhCurrentValue, 2),
      cnhDeposit: output(member.cnhDeposit, 2),
      cnhWithdraw: output(member.cnhWithdraw, 2),
      cnhProfit: output(cnhProfit, 2),
      cnhProfitRate: output(cnhProfitRate, 2)
    };
  });

  const fundProfit = totalNAV.plus(fundExternalWithdraw).minus(fundExternalDeposit);
  const fundProfitRate = fundExternalDeposit.isZero() ? ZERO : fundProfit.div(fundExternalDeposit).mul(100);
  const fundCnhCurrentValue = totalNAV.mul(globalCnhRate);
  const fundCnhProfit = fundCnhCurrentValue.plus(fundExternalCnhWithdraw).minus(fundExternalCnhDeposit);
  const fundCnhProfitRate = fundExternalCnhDeposit.isZero() ? ZERO : fundCnhProfit.div(fundExternalCnhDeposit).mul(100);

  return {
    summary: {
      totalNAV: output(totalNAV, 2),
      totalShares: output(totalShares, 4),
      navPerShare: output(navPerShare, 4),
      totalDeposit: output(fundExternalDeposit, 2),
      totalWithdraw: output(fundExternalWithdraw, 2),
      profit: output(fundProfit, 2),
      profitRate: output(fundProfitRate, 2),
      cnhRate: output(globalCnhRate, 12),
      cnhTotalNAV: output(fundCnhCurrentValue, 2),
      cnhTotalDeposit: output(fundExternalCnhDeposit, 2),
      cnhTotalWithdraw: output(fundExternalCnhWithdraw, 2),
      cnhProfit: output(fundCnhProfit, 2),
      cnhProfitRate: output(fundCnhProfitRate, 2)
    },
    members: computedMembers,
    events: sortedEvents,
    settings: {
      benchmarkClosePolicy,
      benchmarkCacheReady: sortedEvents.every(event =>
        isUsableIndexEntry(indexCache[event.date], event.date, benchmarkClosePolicy))
    },
    charts: { navHistory, memberHistory }
  };
}

module.exports = { calculateStateFromDb };
