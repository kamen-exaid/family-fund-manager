function registerApiRoutes(app, deps) {
  const {
    readDb,
    writeDb,
    getState,
    readConfig,
    writeConfig,
    ensureIndexCache,
    calculateStateFromDb,
    fetchCnhRateFromApi,
    isValidDate,
    normalizeRemark,
    normalizeMemberName,
    fetchTickerAthData,
    randomUUID
  } = deps;

  const BALANCE_TOLERANCE = 0.000001;

  function toFiniteNumber(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return NaN;
    if (typeof value === 'string' && value.trim() === '') return NaN;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  function isEventFullyCovered(db, eventId) {
    const validationDb = JSON.parse(JSON.stringify(db));
    const validationState = calculateStateFromDb(validationDb);
    const event = validationState.events.find(e => e.id === eventId);
    return Boolean(event && event._actualAmount + BALANCE_TOLERANCE >= event.amount);
  }

  // The calculator caps underfunded replay events for display safety. Before
  // persisting a mutation, reject any ledger where requested and settled amounts
  // would differ instead.
  function findInsufficientBalanceEvent(db) {
    const validationDb = JSON.parse(JSON.stringify(db));
    const validationState = calculateStateFromDb(validationDb);
    return validationState.events.find(event =>
      (event.type === 'withdraw' || event.type === 'transfer') &&
      event._actualAmount + BALANCE_TOLERANCE < event.amount
    );
  }

  function rejectInsufficientLedger(res, event) {
    return res.status(400).json({
      success: false,
      message: `操作会导致历史${event.type === 'withdraw' ? '出金' : '转让'}余额不足：${event.date} 的记录要求 $${event.amount.toFixed(2)}，实际仅可结算 $${event._actualAmount.toFixed(2)}。`
    });
  }
app.get('/api/state', (req, res) => {
  try {
    const state = getState();
    res.json({ success: true, data: state });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 标的 ATH 缓存与后台同步机制
let tickerAthCache = null;
let tickerAthCacheTime = 0;
const TICKER_CACHE_DURATION = 5 * 60 * 1000; // 5分钟缓存

app.get('/api/ticker-ath', async (req, res) => {
  try {
    const now = Date.now();
    if (tickerAthCache && (now - tickerAthCacheTime < TICKER_CACHE_DURATION)) {
      return res.json({ success: true, data: tickerAthCache, cached: true });
    }
    const data = await fetchTickerAthData(readConfig());
    tickerAthCache = data;
    tickerAthCacheTime = now;
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
    }

    if (!isValidDate(date)) {
      return res.status(400).json({ success: false, message: '日期必须是有效的 YYYY-MM-DD。' });
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

    db.events.push(newEvent);
    const insufficientEvent = findInsufficientBalanceEvent(db);
    if (insufficientEvent) return rejectInsufficientLedger(res, insufficientEvent);
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
    if (!Number.isFinite(parsedNAV) || parsedNAV < 0) {
      return res.status(400).json({ success: false, message: '资产估值金额必须大于等于 0' });
    }
    if (!date) {
      return res.status(400).json({ success: false, message: '日期不能为空' });
    }

    const db = readDb();

    // 在没有起投份额时（总份额为0），直接更新估值是不合逻辑的，应先进行首次入金
    // [Fix #5] 使用带缓存的 getState() 而非直接调用 calculateState()，避免不必要的重算
    const state = getState();
    if (state.summary.totalShares === 0 && parsedNAV > 0) {
      return res.status(400).json({
        success: false,
        message: '当前基金尚无份额。请先录入首次出入金（起投金额），随后再进行市值估值更新。'
      });
    }

    if (!isValidDate(date)) {
      return res.status(400).json({ success: false, message: '日期必须是有效的 YYYY-MM-DD。' });
    }
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
    const insufficientEvent = findInsufficientBalanceEvent(db);
    if (insufficientEvent) return rejectInsufficientLedger(res, insufficientEvent);
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

    if (!isValidDate(date)) {
      return res.status(400).json({ success: false, message: '日期必须是有效的 YYYY-MM-DD。' });
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

    db.events.push(newEvent);
    const insufficientEvent = findInsufficientBalanceEvent(db);
    if (insufficientEvent) return rejectInsufficientLedger(res, insufficientEvent);
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
    const insufficientEvent = findInsufficientBalanceEvent(db);
    if (insufficientEvent) return rejectInsufficientLedger(res, insufficientEvent);
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
        const actualAmount = validationEvent ? (validationEvent._actualAmount || 0) : 0;
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
        if (!Number.isFinite(parsedNAV) || parsedNAV < 0) {
          return res.status(400).json({ success: false, message: '资产估值金额必须大于等于 0' });
        }
        event.totalNAV = parsedNAV;
      }

      if (date !== undefined) {
        if (!isValidDate(date)) return res.status(400).json({ success: false, message: '日期必须是有效的 YYYY-MM-DD。' });
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
      const actualAmount = validationEvent ? (validationEvent._actualAmount || 0) : 0;
      if (actualAmount + 0.000001 < event.amount) {
        return res.status(400).json({
          success: false,
          message: `出让方余额不足：该修改会导致实际可转让 $${actualAmount.toFixed(2)}，低于填写金额 $${event.amount.toFixed(2)}`
        });
      }
    }

    const insufficientEvent = findInsufficientBalanceEvent(db);
    if (insufficientEvent) return rejectInsufficientLedger(res, insufficientEvent);

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

// 保存用户配置的标的列表 (最大8个)
app.post('/api/settings/tickers', (req, res) => {
  try {
    const { tickers } = req.body;
    if (!Array.isArray(tickers)) {
      return res.status(400).json({ success: false, message: '无效的标的列表数据格式' });
    }
    if (tickers.length < 1 || tickers.length > 8) {
      return res.status(400).json({ success: false, message: '标的追踪数量必须在 1 到 8 个之间' });
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
        ticker: cleanTicker,
        name: (e.name || '').trim().substring(0, 50) // 限制名称最大长度
      };
    });

    const config = readConfig();
    config.tickers = cleanedTickers;
    writeConfig(config);

    // 清除缓存，强制下次获取数据时实时抓取最新标的
    tickerAthCache = null;
    tickerAthCacheTime = 0;

    res.json({ success: true, message: '标的配置保存成功！', data: cleanedTickers });
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
      const parsedRate = toFiniteNumber(cnhRate);
      if (!Number.isFinite(parsedRate) || parsedRate <= 0) {
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
    const { events, members, cnhRate, indexCache } = req.body;
    if (!Array.isArray(events)) {
      return res.status(400).json({ success: false, message: '导入的数据格式不正确，缺少 events 数组' });
    }

    // [Fix #2] 深度格式校验：类型白名单、数量上限、字段合法性
    const VALID_EVENT_TYPES = ['deposit', 'withdraw', 'valuation', 'transfer'];
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
      if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !e.id || eventIds.has(e.id) ||
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
      if (e.type === 'valuation' &&
          (typeof e.totalNAV !== 'number' || e.totalNAV < 0 || !isFinite(e.totalNAV))) {
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
    }

    let importedCnhRate = currentDb.cnhRate;
    if (cnhRate !== undefined) {
      importedCnhRate = toFiniteNumber(cnhRate);
      if (!Number.isFinite(importedCnhRate) || importedCnhRate <= 0) {
        return res.status(400).json({ success: false, message: '导入数据中的汇率参数必须大于 0' });
      }
    }

    const db = {
      members: importedMembers.map(member => ({ id: member.id, name: member.name.trim() })),
      events,
      cnhRate: importedCnhRate,
      indexCache: (indexCache && typeof indexCache === 'object' && !Array.isArray(indexCache))
        ? indexCache
        : (currentDb.indexCache || {})
    };
    for (const event of db.events) {
      if (event.type === 'withdraw' || event.type === 'transfer') {
        if (!isEventFullyCovered(db, event.id)) {
          return res.status(400).json({ success: false, message: 'Imported data contains an insufficient historical balance.' });
        }
      }
    }
    const insufficientEvent = findInsufficientBalanceEvent(db);
    if (insufficientEvent) return rejectInsufficientLedger(res, insufficientEvent);

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
      e.member === memberId || e.fromMember === memberId || e.toMember === memberId
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
