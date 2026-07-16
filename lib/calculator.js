// Event-sourcing ledger replay and derived portfolio state.

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

function calculateStateFromDb(db) {
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

module.exports = { calculateStateFromDb };
