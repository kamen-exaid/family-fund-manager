const Decimal = require('decimal.js');

const ZERO = new Decimal(0);
const ONE = new Decimal(1);
const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(from, to) {
  return Math.max(0, (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

function hurdleValue(lot, date, annualRate) {
  return lot.basis.mul(ONE.plus(annualRate).pow(daysBetween(lot.date, date) / 365));
}

function settlePerformance({ event, members, currentNAV, output }) {
  const gpMember = members[event.gpMember];
  const annualRate = new Decimal(event.annualRate ?? 0.06);
  const feeRate = new Decimal(event.feeRate ?? 0.25);
  let totalFee = ZERO;
  const breakdown = [];

  if (!gpMember) throw new Error(`业绩结算的GP成员不存在：${event.gpMember}`);
  for (const member of Object.values(members)) {
    const lpShares = member.lots.reduce((sum, lot) => sum.plus(lot.shares), ZERO);
    const isSettlementLp = Array.isArray(event.lpMembers)
      ? event.lpMembers.includes(member.id)
      : member.isLP;
    if (!isSettlementLp || lpShares.isZero()) continue;

    const valueBefore = lpShares.mul(currentNAV);
    const lotBreakdown = member.lots.map(lot => {
      const lotHurdle = hurdleValue(lot, event.date, annualRate);
      const lotValue = lot.shares.mul(currentNAV);
      return {
        sourceEventId: lot.sourceEventId,
        sourceType: lot.sourceType || 'legacy',
        startDate: lot.date,
        holdingDays: daysBetween(lot.date, event.date),
        basis: output(lot.basis, 2),
        entryNav: output(lot.basis.div(lot.shares), 12),
        shares: output(lot.shares, 12),
        currentValue: output(lotValue, 2),
        hurdle: output(lotHurdle, 2),
        aboveHurdle: output(lotValue.minus(lotHurdle), 2)
      };
    });
    const hurdle = member.lots.reduce((sum, lot) => sum.plus(hurdleValue(lot, event.date, annualRate)), ZERO);
    const excess = Decimal.max(ZERO, valueBefore.minus(hurdle));
    const fee = excess.mul(feeRate);
    let feeShares = fee.div(currentNAV);
    if (feeShares.gt(lpShares)) feeShares = lpShares;
    member.shares = member.shares.minus(feeShares);
    gpMember.shares = gpMember.shares.plus(feeShares);
    gpMember.carryShares = gpMember.carryShares.plus(feeShares);
    totalFee = totalFee.plus(fee);

    const lpSharesAfter = lpShares.minus(feeShares);
    const valueAfter = lpSharesAfter.mul(currentNAV);
    if (fee.gt(ZERO)) {
      member.lots = lpSharesAfter.isZero() ? [] : [{
        shares: lpSharesAfter,
        basis: valueAfter,
        date: event.date,
        sourceEventId: event.id,
        sourceType: 'settlement_reset'
      }];
    }
    breakdown.push({
      member: member.id,
      valueBefore: output(valueBefore, 2),
      hurdle: output(hurdle, 2),
      excess: output(excess, 2),
      fee: output(fee, 2),
      feeShares: output(feeShares, 12),
      sharesBefore: output(lpShares, 12),
      sharesAfter: output(lpSharesAfter, 12),
      lots: lotBreakdown
    });
  }

  return {
    breakdown,
    totalFee,
    feeShares: breakdown.reduce((sum, item) => sum.plus(item.feeShares), ZERO)
  };
}

function previewDisposalFee({ member, currentNAV, date, lpSharesDisposed, annualRate, feeRate, output }) {
  const lpShares = member.lots.reduce((sum, lot) => sum.plus(lot.shares), ZERO);
  if (lpShares.isZero() || lpSharesDisposed.isZero()) {
    return { fee: ZERO, feeShares: ZERO, hurdle: ZERO, value: ZERO, lots: [] };
  }
  const ratio = lpSharesDisposed.div(lpShares);
  let hurdle = ZERO;
  const lots = member.lots.map(lot => {
    const disposedShares = lot.shares.mul(ratio);
    const disposedBasis = lot.basis.mul(ratio);
    const disposedHurdle = hurdleValue({ shares: disposedShares, basis: disposedBasis, date: lot.date }, date, annualRate);
    const disposedValue = disposedShares.mul(currentNAV);
    hurdle = hurdle.plus(disposedHurdle);
    return {
      sourceEventId: lot.sourceEventId,
      startDate: lot.date,
      shares: output(disposedShares, 12),
      basis: output(disposedBasis, 2),
      hurdle: output(disposedHurdle, 2),
      value: output(disposedValue, 2)
    };
  });
  const value = lpSharesDisposed.mul(currentNAV);
  const fee = Decimal.max(ZERO, value.minus(hurdle)).mul(feeRate);
  return { fee, feeShares: fee.div(currentNAV), hurdle, value, lots };
}

module.exports = { daysBetween, hurdleValue, settlePerformance, previewDisposalFee };
