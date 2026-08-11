const { handleApiError } = require('../lib/api-errors');

function registerSettingsRoutes(app, deps, utils) {
  const { readDb, writeDb, ensureIndexCache, fetchCnhRateFromApi } = deps;
  const { toFiniteNumber } = utils;

// 4.8. 更新全局系统参数（汇率配置）
app.post('/api/settings', (req, res, next) => {
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
      if (benchmarkClosePolicy !== 'previous') {
        return res.status(400).json({ success: false, message: '指数收盘口径无效' });
      }
      db.benchmarkClosePolicy = 'previous';
    }

    writeDb(db);
    if (benchmarkClosePolicy !== undefined && db.events.length > 0) {
      ensureIndexCache(db.events.map(event => event.date));
    }
    res.json({ success: true, message: '系统参数更新成功', data: { cnhRate: db.cnhRate } });
  } catch (error) {
    handleApiError(error, req, res, next);
  }
});

// 4.9. 自动从第三方接口同步最新汇率 (ExchangeRate-API 免 Key 公开接口)
app.post('/api/settings/sync-rate', async (req, res, next) => {
  try {
    let rate;
    try {
      rate = await fetchCnhRateFromApi();
    } catch (error) {
      console.error('[External Service Error] USD/CNH sync:', error);
      return res.status(502).json({
        success: false,
        code: 'EXTERNAL_SERVICE_ERROR',
        message: '从公开汇率接口获取数据失败，请检查网络或稍后重试'
      });
    }
    if (!rate) {
      return res.status(502).json({
        success: false,
        code: 'EXTERNAL_SERVICE_ERROR',
        message: '从公开汇率接口获取数据失败，请检查网络或稍后重试'
      });
    }
    const db = readDb();
    db.cnhRate = rate;
    writeDb(db);
    res.json({ success: true, message: `汇率成功同步为 ${rate}`, cnhRate: rate });
  } catch (error) {
    handleApiError(error, req, res, next);
  }
});
}

module.exports = { registerSettingsRoutes };
