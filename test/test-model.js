/**
 * 数学计算模型单元验证脚本 (test-model.js)
 * 升级版：加入手动人民币 CNH 记账与 CNH 收益率断言校验
 * 运行：node test-model.js
 */

function runSimulation(eventsList, cnhRate = 7.2) {
  // 按发生日期排序，相同日期按创建先后排序
  const sortedEvents = [...eventsList].sort((a, b) => {
    const dateCompare = a.date.localeCompare(b.date);
    if (dateCompare !== 0) return dateCompare;
    return a.createdAt - b.createdAt;
  });

  let navPerShare = 1.0000;
  let totalShares = 0;
  let totalNAV = 0;

  const members = {
    me: { name: '我', shares: 0, totalDeposit: 0, totalWithdraw: 0, cnhDeposit: 0, cnhWithdraw: 0 },
    mother: { name: '母亲', shares: 0, totalDeposit: 0, totalWithdraw: 0, cnhDeposit: 0, cnhWithdraw: 0 },
    father: { name: '父亲', shares: 0, totalDeposit: 0, totalWithdraw: 0, cnhDeposit: 0, cnhWithdraw: 0 }
  };

  sortedEvents.forEach((event, index) => {
    const currentNAV = (totalShares === 0) ? 1.0000 : navPerShare;

    console.log(`\n--- 节点 ${index + 1}: ${event.type.toUpperCase()} | 日期: ${event.date} | 备注: ${event.remark} ---`);

    if (event.type === 'deposit') {
      const amount = parseFloat(event.amount);
      const memberKey = event.member;
      const eventCnh = event.cnhAmount !== undefined ? parseFloat(event.cnhAmount) : (amount * cnhRate);
      
      const sharesGained = amount / currentNAV;

      members[memberKey].shares += sharesGained;
      members[memberKey].totalDeposit += amount;
      members[memberKey].cnhDeposit += eventCnh;
      totalShares += sharesGained;
      totalNAV = totalShares * currentNAV;
      navPerShare = currentNAV;

      console.log(`  [入金] ${members[memberKey].name} 存入 $${amount} (手动折算人民币: ¥${eventCnh})`);
      console.log(`  [换算] 获得份额: ${sharesGained.toFixed(4)} 份 (依据当时净值 ${currentNAV.toFixed(4)})`);

    } else if (event.type === 'withdraw') {
      const amount = parseFloat(event.amount);
      const memberKey = event.member;
      let eventCnh = event.cnhAmount !== undefined ? parseFloat(event.cnhAmount) : (amount * cnhRate);
      
      let sharesDeducted = amount / currentNAV;

      if (sharesDeducted > members[memberKey].shares) {
        sharesDeducted = members[memberKey].shares;
        eventCnh = (members[memberKey].shares * currentNAV === 0) ? 0 : eventCnh;
      }
      const actualAmount = sharesDeducted * currentNAV;

      members[memberKey].shares -= sharesDeducted;
      members[memberKey].totalWithdraw += actualAmount;
      members[memberKey].cnhWithdraw += eventCnh;
      totalShares -= sharesDeducted;
      totalNAV = totalShares * currentNAV;
      navPerShare = currentNAV;

      console.log(`  [出金] ${members[memberKey].name} 提取了 $${actualAmount} (对应扣减人民币: ¥${eventCnh}) (扣除份额 ${sharesDeducted.toFixed(4)})`);

    } else if (event.type === 'valuation') {
      const newTotalNAV = parseFloat(event.totalNAV);
      totalNAV = newTotalNAV;
      if (totalShares > 0) {
        navPerShare = totalNAV / totalShares;
      } else {
        navPerShare = 1.0000;
      }

      console.log(`  [估值更新] 基金总资产估值更新为: $${newTotalNAV}`);
      console.log(`  [计算] 新的单位净值: ${navPerShare.toFixed(4)} (旧净值 ${currentNAV.toFixed(4)})`);
    } else if (event.type === 'transfer') {
      const amount = parseFloat(event.amount);
      const fromMemberKey = event.fromMember;
      const toMemberKey = event.toMember;
      const eventRate = event.cnhRate !== undefined ? parseFloat(event.cnhRate) : cnhRate;
      const eventCnhAmount = amount * eventRate;

      let sharesTransferred = amount / currentNAV;
      if (sharesTransferred > members[fromMemberKey].shares) {
        sharesTransferred = members[fromMemberKey].shares;
      }
      const actualAmount = sharesTransferred * currentNAV;

      members[fromMemberKey].shares -= sharesTransferred;
      members[fromMemberKey].totalWithdraw += actualAmount;
      members[fromMemberKey].cnhWithdraw += eventCnhAmount;

      members[toMemberKey].shares += sharesTransferred;
      members[toMemberKey].totalDeposit += actualAmount;
      members[toMemberKey].cnhDeposit += eventCnhAmount;

      totalNAV = totalShares * currentNAV; // Total assets unchanged
      navPerShare = currentNAV; // Net value per share unchanged

      console.log(`  [划转] ${members[fromMemberKey].name} 划转 $${actualAmount} (折合人民币: ¥${eventCnhAmount}，汇率: ${eventRate}) 至 ${members[toMemberKey].name}`);
      console.log(`  [换算] 转移份额: ${sharesTransferred.toFixed(4)} 份`);
    }

    // 打印当前系统快照
    console.log(`  [基金快照] 总资产: $${totalNAV.toFixed(2)} | 总份额: ${totalShares.toFixed(4)} 份 | 单位净值: ${navPerShare.toFixed(4)}`);
    Object.keys(members).forEach(k => {
      const m = members[k];
      const val = m.shares * navPerShare;
      const cnhVal = val * cnhRate;
      console.log(`    * ${m.name}: 份额 ${m.shares.toFixed(4)} | 资产价值 $${val.toFixed(2)} (约 ¥${cnhVal.toFixed(2)} CNH) | 累计美金投入 $${m.totalDeposit} (约 ¥${m.cnhDeposit} CNH)`);
    });
  });

  console.log(`\n=================== 最终结算报告 (USD & CNH 双轨) ===================`);
  const computedMembers = {};
  Object.keys(members).forEach(k => {
    const m = members[k];
    const currentValue = m.shares * navPerShare;
    const profit = currentValue + m.totalWithdraw - m.totalDeposit;
    const profitRate = m.totalDeposit > 0 ? (profit / m.totalDeposit) * 100 : 0;

    // 人民币收益率计算
    const cnhCurrentValue = currentValue * cnhRate;
    const cnhProfit = cnhCurrentValue + m.cnhWithdraw - m.cnhDeposit;
    const cnhProfitRate = m.cnhDeposit > 0 ? (cnhProfit / m.cnhDeposit) * 100 : 0;

    console.log(`成员【${m.name}】:`);
    console.log(`  持有份额: ${m.shares.toFixed(4)} 份`);
    console.log(`  当前美元资产: $${currentValue.toFixed(2)} | 当前人民币资产: ¥${cnhCurrentValue.toFixed(2)}`);
    console.log(`  美元累计充值: $${m.totalDeposit.toFixed(2)} | 人民币累计充值: ¥${m.cnhDeposit.toFixed(2)}`);
    console.log(`  美元累计提现: $${m.totalWithdraw.toFixed(2)} | 人民币累计提现: ¥${m.cnhWithdraw.toFixed(2)}`);
    console.log(`  美元净赚损益: $${profit.toFixed(2)} | 美元投资回报率: ${profitRate.toFixed(2)}%`);
    console.log(`  人民币净赚损益: ¥${cnhProfit.toFixed(2)} | 人民币投资回报率 (CNH ROI): ${cnhProfitRate.toFixed(2)}%`);
  });

  return {
    totalNAV,
    navPerShare,
    totalShares,
    members,
    cnhRate
  };
}

// 模拟事件流水线 (包含手动填入的人民币本金)
const testEvents = [
  // 1. 我首次入金 10,000 美元，手动填入人民币 ¥70,000 元。净值设为 1.0000，我占 10,000 份。
  { id: '1', type: 'deposit', member: 'me', amount: 10000, cnhAmount: 70000, date: '2026-05-01', remark: '我首次美元入金，换汇人民币7万', createdAt: 100 },
  
  // 2. 基金投资盈利，总资产从 10000 美元涨至 12,000 美元，单位净值应变为 1.2000。
  { id: '2', type: 'valuation', totalNAV: 12000, date: '2026-05-05', remark: '美股大幅度上涨', createdAt: 200 },
  
  // 3. 母亲在此刻入金 6,000 美元，手动填入人民币 ¥42,000 元。应按照净值 1.2000 折算，获得 5,000 份份额。
  //    此时基金总份额为 15,000 份，总资产变为 18,000 美元，净值仍保持为 1.2000。
  { id: '3', type: 'deposit', member: 'mother', amount: 6000, cnhAmount: 42000, date: '2026-05-10', remark: '母亲追加资金', createdAt: 300 },
  
  // 4. 基金资产遭遇回调，从 18000 美元缩水至 15,000 美元。
  //    此时单位净值应跌为 15000 / 15000 = 1.0000。
  //    我（10000份）资产缩水至 10000 美元；母亲（5000份）缩水至 5000 美元。
  { id: '4', type: 'valuation', totalNAV: 15000, date: '2026-05-15', remark: '美债资产震荡回调', createdAt: 400 },
  
  // 5. 我出金（提取现金）5,000 美元，在净值 1.0000 下，扣除 5,000 份。
  //    手动填入实际取出的人民币为 ¥36,000 元 (结汇率有所上升)。
  //    出金后：我剩余 5000 份，母亲有 5000 份。总资产变为 10,000 美元。
  { id: '5', type: 'withdraw', member: 'me', amount: 5000, cnhAmount: 36000, date: '2026-05-20', remark: '急需用钱取出美金换回人民币', createdAt: 500 },

  // 6. 基金再次大幅度盈利，总资产涨回 12,000 美元。
  //    总份额 10,000 份，单位净值重回 12000 / 10000 = 1.2000。
  //    我（5000份）资产现值为 $6000，母亲（5000份）资产现值 $6000。
  { id: '6', type: 'valuation', totalNAV: 12000, date: '2026-05-22', remark: '美股发布财报暴涨', createdAt: 600 },

  // 7. 我将名下所有剩余的 5,000 份份额（价值 $6,000）转让给父亲，成交受让汇率设定为 7.2300。
  //    折合结转人民币本金 = 6000 * 7.23 = ¥43,380。
  //    转让后：我持有 0 份，资产 $0；父亲持有 5000 份，资产 $6,000；母亲 5000 份，资产 $6,000。
  //    基金总资产 12,000 USD 不变，总份额 10,000 不变，净值 1.2000 不变。
  { id: '7', type: 'transfer', fromMember: 'me', toMember: 'father', amount: 6000, cnhRate: 7.23, date: '2026-05-25', remark: '买二手车对价份额划转', createdAt: 700 }
];

console.log('🚀 开始进行家庭基金 USD / CNH 双轨核心数学模型校验...\n');
// 使用当前最新汇率 7.2 进行核算
const result = runSimulation(testEvents, 7.2);

// 断言验证 (Asserts)
console.log('\n🔍 运行自动化断言检测中...');
try {
  // 校验 1: 最终美元总资产应为 12,000 USD
  if (Math.abs(result.totalNAV - 12000) > 0.01) throw new Error(`美元总资产不匹配！期望 12000，实际: ${result.totalNAV}`);
  
  // 校验 2: 最终单位净值应为 1.2000
  if (Math.abs(result.navPerShare - 1.2000) > 0.0001) throw new Error(`单位净值不匹配！期望 1.2000, 实际: ${result.navPerShare}`);
  
  // 校验 3: 最终总份额为 10,000 份
  if (Math.abs(result.totalShares - 10000) > 0.0001) throw new Error(`总份额不匹配！期望 10000, 实际: ${result.totalShares}`);
  
  // 校验 4: 我的美元份额应为 0 份
  if (Math.abs(result.members.me.shares - 0) > 0.0001) throw new Error(`我的美元份额不匹配！期望 0, 实际: ${result.members.me.shares}`);
  
  // 校验 5: 父亲的美元份额应为 5,000 份
  if (Math.abs(result.members.father.shares - 5000) > 0.0001) throw new Error(`父亲的美元份额不匹配！期望 5000, 实际: ${result.members.father.shares}`);

  // 校验 6: 最终结算时，我的 CNH 投入本金 = 70000 (充值)
  //         我的 CNH 提现累计 = 36000 (event 5) + 6000*7.23 (event 7转出) = 36000 + 43380 = 79,380 元。
  //         我的 CNH 当前资产价值 = 0份 * 1.2000 * 7.2 = 0 元。
  //         我的 CNH 净盈亏 = 0 + 79380 - 70000 = +9,380 元。
  //         我的 CNH 投资收益率 (CNH ROI) = (9380 / 70000) * 100% = +13.40%!
  const myCnhCurrentVal = result.members.me.shares * result.navPerShare * result.cnhRate;
  const myCnhProfit = myCnhCurrentVal + result.members.me.cnhWithdraw - result.members.me.cnhDeposit;
  const myCnhRoi = (myCnhProfit / result.members.me.cnhDeposit) * 100;
  
  console.log(`  -> 我的 CNH 现值: ¥${myCnhCurrentVal.toFixed(2)} (期望: ¥0.00)`);
  console.log(`  -> 我的 CNH 盈亏: ¥${myCnhProfit.toFixed(2)} (期望: ¥9380.00)`);
  console.log(`  -> 我的 CNH 回报率 (CNH ROI): ${myCnhRoi.toFixed(2)}% (期望: 13.40%)`);

  if (Math.abs(myCnhCurrentVal - 0) > 0.01) throw new Error(`我的 CNH 现值计算错误！`);
  if (Math.abs(myCnhProfit - 9380) > 0.01) throw new Error(`我的 CNH 净盈亏计算错误！`);
  if (Math.abs(myCnhRoi - 13.40) > 0.01) throw new Error(`我的 CNH 收益率 (CNH ROI) 计算错误！`);

  // 校验 7: 最终结算时，父亲的 CNH 投入本金 = 6000*7.23 = ¥43,380
  //         父亲的 CNH 当前资产价值 = 5000份 * 1.2000 * 7.2 = ¥43,200
  //         父亲的 CNH 净盈亏 = 43200 - 43380 = -180 元。
  //         父亲的 CNH ROI = (-180 / 43380) * 100% = -0.41%!
  const fatCnhCurrentVal = result.members.father.shares * result.navPerShare * result.cnhRate;
  const fatCnhProfit = fatCnhCurrentVal + result.members.father.cnhWithdraw - result.members.father.cnhDeposit;
  const fatCnhRoi = (fatCnhProfit / result.members.father.cnhDeposit) * 100;

  console.log(`  -> 父亲的 CNH 现值: ¥${fatCnhCurrentVal.toFixed(2)} (期望: ¥43200.00)`);
  console.log(`  -> 父亲的 CNH 盈亏: ¥${fatCnhProfit.toFixed(2)} (期望: ¥-180.00)`);
  console.log(`  -> 父亲的 CNH 回报率 (CNH ROI): ${fatCnhRoi.toFixed(2)}% (期望: -0.41%)`);

  if (Math.abs(fatCnhCurrentVal - 43200) > 0.01) throw new Error(`父亲的 CNH 现值计算错误！`);
  if (Math.abs(fatCnhProfit - (-180)) > 0.01) throw new Error(`父亲的 CNH 净盈亏计算错误！`);
  if (Math.abs(fatCnhRoi - (-0.415)) > 0.01) throw new Error(`父亲的 CNH 收益率 (CNH ROI) 计算错误！`);

  console.log('\n🟢 所有双轨数学模型断言全部通过！划转模型零滑点守恒、人民币本金精确分配！');
} catch (e) {
  console.error('\n🔴 断言检测失败！请检查划转双币重放算法逻辑。', e.message);
}

