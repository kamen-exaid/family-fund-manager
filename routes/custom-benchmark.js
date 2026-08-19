const { InputError, handleApiError } = require('../lib/api-errors');
const { normalizeCustomBenchmark, MAX_CUSTOM_BENCHMARKS } = require('../lib/custom-benchmark');

function normalizeSlot(value) {
  const slot = value === undefined ? 0 : Number(value);
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_CUSTOM_BENCHMARKS) {
    throw new InputError(`自定义标的槽位必须为 0-${MAX_CUSTOM_BENCHMARKS - 1}。`);
  }
  return slot;
}

function configFieldForSlot(slot) {
  return slot === 0 ? 'customBenchmark' : 'customBenchmark2';
}

function registerCustomBenchmarkRoutes(app, deps) {
  const { readConfig, writeConfig, readDb, ensureIndexCache } = deps;

  app.get('/api/settings/custom-benchmark', (req, res, next) => {
    try {
      const slot = normalizeSlot(req.query?.slot);
      const config = readConfig();
      res.json({
        success: true,
        data: normalizeCustomBenchmark(config[configFieldForSlot(slot)], InputError)
      });
    } catch (error) {
      handleApiError(error, req, res, next);
    }
  });

  app.post('/api/settings/custom-benchmark', (req, res, next) => {
    try {
      if (!req.body || !Object.prototype.hasOwnProperty.call(req.body, 'customBenchmark')) {
        throw new InputError('缺少自定义标的配置');
      }
      const slot = normalizeSlot(req.body.slot);
      const benchmark = normalizeCustomBenchmark(req.body?.customBenchmark, InputError);
      const config = readConfig();
      config[configFieldForSlot(slot)] = benchmark;
      writeConfig(config);

      const dates = (readDb().events || []).map(event => event.date).filter(Boolean);
      if (benchmark && dates.length) void ensureIndexCache(dates);

      res.json({
        success: true,
        message: benchmark ? '自定义标的配置保存成功' : '自定义标的已移除',
        data: benchmark,
        slot
      });
    } catch (error) {
      handleApiError(error, req, res, next);
    }
  });
}

module.exports = { registerCustomBenchmarkRoutes };
