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
    member.lots = member.lots.filter(lot => !lot.shares.isZero());
    const lpShares = member.lots.reduce((sum, lot) => sum.plus(lot.shares), ZERO);
    const isSettlementLp = Array.isArray(event.lpMembers)
      ? event.lpMembers.includes(member.id)
      : member.isLP;
    if (!isSettlementLp || lpShares.isZero()) continue;

    const valueBefore = lpShares.mul(currentNAV);
    const settledLots = [];
    const lotBreakdown = member.lots.map(lot => {
      const lotHurdle = hurdleValue(lot, event.date, annualRate);
      const lotValue = lot.shares.mul(currentNAV);
      const lotExcess = Decimal.max(ZERO, lotValue.minus(lotHurdle));
      const lotFee = lotExcess.mul(feeRate);
      const lotFeeShares = Decimal.min(lot.shares, lotFee.div(currentNAV));
      const sharesAfter = lot.shares.minus(lotFeeShares);
      if (lotFee.gt(ZERO)) {
        if (sharesAfter.gt(ZERO)) settledLots.push({
          shares: sharesAfter,
          basis: sharesAfter.mul(currentNAV),
          date: event.date,
          sourceEventId: event.id,
          sourceType: 'settlement_reset'
        });
      } else {
        settledLots.push(lot);
      }
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
        aboveHurdle: output(lotValue.minus(lotHurdle), 2),
        fee: output(lotFee, 2),
        feeShares: output(lotFeeShares, 12)
      };
    });
    const hurdle = member.lots.reduce((sum, lot) => sum.plus(hurdleValue(lot, event.date, annualRate)), ZERO);
    const excess = member.lots.reduce((sum, lot) => {
      return sum.plus(Decimal.max(ZERO, lot.shares.mul(currentNAV).minus(hurdleValue(lot, event.date, annualRate))));
    }, ZERO);
    const fee = excess.mul(feeRate);
    const feeShares = Decimal.min(lpShares, fee.div(currentNAV));
    member.shares = member.shares.minus(feeShares);
    gpMember.shares = gpMember.shares.plus(feeShares);
    gpMember.carryShares = gpMember.carryShares.plus(feeShares);
    totalFee = totalFee.plus(fee);

    const lpSharesAfter = lpShares.minus(feeShares);
    const valueAfter = lpSharesAfter.mul(currentNAV);
    if (fee.gt(ZERO)) {
      const allLotsCrystallized = member.lots.every(lot => {
        return lot.shares.mul(currentNAV).gt(hurdleValue(lot, event.date, annualRate));
      });
      member.lots = allLotsCrystallized
        ? (lpSharesAfter.isZero() ? [] : [{
            shares: lpSharesAfter,
            basis: valueAfter,
            date: event.date,
            sourceEventId: event.id,
            sourceType: 'settlement_reset'
          }])
        : settledLots;
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

function previewDisposalFee({ member, currentNAV, date, lpSharesDisposed, netCashAmount, annualRate, feeRate, output }) {
  const lpShares = member.lots.reduce((sum, lot) => sum.plus(lot.shares), ZERO);
  if (lpShares.isZero() || lpSharesDisposed.isZero()) {
    return {
      fee: ZERO,
      feeShares: ZERO,
      feeSharesByLot: [],
      cashShares: ZERO,
      ratio: ZERO,
      hurdle: ZERO,
      value: ZERO,
      lots: []
    };
  }
  const fullLots = member.lots.map(lot => {
    const hurdle = hurdleValue(lot, date, annualRate);
    const value = lot.shares.mul(currentNAV);
    const fee = Decimal.max(ZERO, value.minus(hurdle)).mul(feeRate);
    return { lot, hurdle, value, fee, netValue: value.minus(fee) };
  });
  const fullNetValue = fullLots.reduce((sum, item) => sum.plus(item.netValue), ZERO);
  const ratio = netCashAmount === undefined
    ? lpSharesDisposed.div(lpShares)
    : Decimal.min(ONE, new Decimal(netCashAmount).div(fullNetValue));
  let hurdle = ZERO;
  let fee = ZERO;
  let cashSharesTotal = ZERO;
  const feeSharesByLot = [];
  const lots = fullLots.map(({ lot, hurdle: fullHurdle, value: fullValue, fee: fullFee }) => {
    const disposedShares = lot.shares.mul(ratio);
    const disposedBasis = lot.basis.mul(ratio);
    const disposedHurdle = fullHurdle.mul(ratio);
    const disposedValue = fullValue.mul(ratio);
    const lotFee = fullFee.mul(ratio);
    const lotFeeShares = lotFee.div(currentNAV);
    feeSharesByLot.push(lotFeeShares);
    // Version-2 partial disposals treat the entered amount as LP net cash and
    // carve carry out of the same gross lot disposal. Historical unversioned
    // partial events treated the entered amount as the cash disposal and
    // removed carry in addition to it, so their replay must retain that shape.
    const feeCarvedFromDisposal = netCashAmount !== undefined || ratio.eq(ONE);
    const cashValue = feeCarvedFromDisposal ? disposedValue.minus(lotFee) : disposedValue;
    const cashShares = cashValue.div(currentNAV);
    cashSharesTotal = cashSharesTotal.plus(cashShares);
    const totalShares = feeCarvedFromDisposal ? disposedShares : disposedShares.plus(lotFeeShares);
    const totalValue = feeCarvedFromDisposal ? disposedValue : disposedValue.plus(lotFee);
    hurdle = hurdle.plus(disposedHurdle);
    fee = fee.plus(lotFee);
    return {
      sourceEventId: lot.sourceEventId,
      sourceType: lot.sourceType || 'legacy',
      startDate: lot.date,
      holdingDays: daysBetween(lot.date, date),
      shares: output(disposedShares, 12),
      cashShares: output(cashShares, 12),
      totalShares: output(totalShares, 12),
      basis: output(disposedBasis, 2),
      hurdle: output(disposedHurdle, 2),
      value: output(disposedValue, 2),
      cashValue: output(cashValue, 2),
      totalValue: output(totalValue, 2),
      aboveHurdle: output(disposedValue.minus(disposedHurdle), 2),
      fee: output(lotFee, 2),
      feeShares: output(lotFeeShares, 12)
    };
  });
  const value = fullLots.reduce((sum, item) => sum.plus(item.value), ZERO).mul(ratio);
  return {
    fee,
    feeShares: fee.div(currentNAV),
    feeSharesByLot,
    cashShares: cashSharesTotal,
    ratio,
    hurdle,
    value,
    lots
  };
}

module.exports = { daysBetween, hurdleValue, settlePerformance, previewDisposalFee };
