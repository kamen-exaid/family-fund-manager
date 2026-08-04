const https = require('https');
const { execFile } = require('child_process');

const HTTP_TIMEOUT_MS = 10 * 1000;
const CURL_TIMEOUT_MS = 15 * 1000;

function httpsGetWithTimeout(url, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = undefined;
  }
  const request = https.get(url, options, callback);
  request.setTimeout(HTTP_TIMEOUT_MS, () => request.destroy(new Error('Request timed out')));
  return request;
}
function parseYahooPricesResponse(json) {
  const map = {};
  if (json && json.chart?.result?.[0]) {
    const result = json.chart.result[0];
    const timestamps = result.timestamp;
    const closes = result.indicators.quote[0].close;
    if (timestamps && closes) {
      for (let i = 0; i < timestamps.length; i++) {
        if (closes[i] !== null && closes[i] !== undefined) {
          const dateStr = new Date(timestamps[i] * 1000).toISOString().split('T')[0];
          map[dateStr] = closes[i];
        }
      }
    }
  }
  return map;
}

/**
 * 运行 curl 备用抓取辅助函数 (自动继承系统代理，解决国内 https.get 无法直连或走代理的问题)
 * [Fix #1] 使用 execFile 参数化传递 URL，彻底规避 Shell 命令注入风险
 */
function runCurlSyncFallback(url, ticker, resolve) {
  console.log(`[Yahoo Sync] https.get failed for ${ticker}. Falling back to curl...`);
  execFile('curl.exe', [
    '-s', '-L',
    '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    url
  ], { maxBuffer: 1024 * 1024 * 10, timeout: CURL_TIMEOUT_MS }, (error, stdout, stderr) => {
    if (error) {
      console.error(`[Yahoo Sync] Curl fallback failed for ${ticker}:`, error.message);
      resolve({});
      return;
    }
    try {
      const json = JSON.parse(stdout);
      resolve(parseYahooPricesResponse(json));
    } catch (e) {
      console.error(`[Yahoo Sync] Curl fallback failed to parse JSON for ${ticker}:`, e.message);
      resolve({});
    }
  });
}

/**
 * 从 Yahoo Finance 抓取美股指数的每日收盘数据 (带浏览器 UA 头部欺骗，具备 curl 极速备用通路)
 */
function fetchYahooPrices(ticker, startSec, endSec) {
  return new Promise((resolve) => {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${startSec}&period2=${endSec}&interval=1d`;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    };

    httpsGetWithTimeout(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.chart?.result?.[0]) {
            return resolve(parseYahooPricesResponse(json));
          }
          throw new Error('Invalid chart JSON structure');
        } catch (e) {
          runCurlSyncFallback(url, ticker, resolve);
        }
      });
    }).on('error', (err) => {
      runCurlSyncFallback(url, ticker, resolve);
    });
  });
}

/**
 * Find the latest eligible close for the selected benchmark policy.
 * The default uses the close strictly before the NAV date.
 */
function findCloseForPolicy(dateStr, priceMap, policy = 'previous') {
  const isEligible = policy === 'same_day'
    ? candidate => candidate <= dateStr
    : candidate => candidate < dateStr;
  const priceDate = Object.keys(priceMap || {})
    .filter(candidate => isEligible(candidate) && priceMap[candidate] !== null && priceMap[candidate] !== undefined)
    .sort()
    .at(-1);

  if (!priceDate) return null;
  return { date: priceDate, price: priceMap[priceDate] };
}

function findPreviousClose(dateStr, priceMap) {
  return findCloseForPolicy(dateStr, priceMap, 'previous');
}

/**
 * 从本地 indexCache 中寻找最临近的对标价格 (时序兜底)
 */

const TICKER_OVERLAP_DAYS = 14;

function getTickerHistoryStartSec(cachedTicker) {
  if (!cachedTicker?.historyThrough || !/^\d{4}-\d{2}-\d{2}$/.test(cachedTicker.historyThrough)) return 0;
  const throughMs = Date.parse(`${cachedTicker.historyThrough}T00:00:00Z`);
  if (!Number.isFinite(throughMs)) return 0;
  return Math.max(0, Math.floor(throughMs / 1000) - TICKER_OVERLAP_DAYS * 24 * 3600);
}

function getEasternClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false
  }).formatToParts(now);
  const values = {};
  parts.forEach(part => { values[part.type] = part.value; });
  return {
    year: Number(values.year),
    today: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour)
  };
}

function getEasternDate(timestampSeconds) {
  if (!Number.isFinite(timestampSeconds)) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(timestampSeconds * 1000));
  const values = {};
  parts.forEach(part => { values[part.type] = part.value; });
  return `${values.year}-${values.month}-${values.day}`;
}

function mergeTickerAthRecord(ticker, cachedTicker, result, now = new Date()) {
  const highs = result.indicators?.quote?.[0]?.high || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const timestamps = result.timestamp || [];
  const eastern = getEasternClock(now);
  const excludeToday = eastern.hour < 20;
  const bars = timestamps.map((timestamp, index) => ({
    date: new Date(timestamp * 1000).toISOString().split('T')[0],
    high: highs[index],
    close: closes[index]
  })).filter(bar => !(excludeToday && bar.date === eastern.today));

  let latestBar = [...bars].reverse().find(bar => Number.isFinite(bar.close));
  // Yahoo occasionally publishes the completed daily candle with high/low but
  // leaves quote.close null for a while. meta already carries the official
  // regular-session close and timestamp, so use it when it is newer.
  const metaCloseDate = getEasternDate(result.meta?.regularMarketTime);
  if (Number.isFinite(result.meta?.regularMarketPrice) && metaCloseDate &&
      !(excludeToday && metaCloseDate === eastern.today) &&
      (!latestBar || metaCloseDate > latestBar.date)) {
    latestBar = { date: metaCloseDate, close: result.meta.regularMarketPrice };
  }
  if (!latestBar && !Number.isFinite(cachedTicker?.regularClose)) {
    throw new Error(`No completed close data for ${ticker}`);
  }

  let ath = Number.isFinite(cachedTicker?.ath) ? cachedTicker.ath : 0;
  let athDate = cachedTicker?.athDate || '';
  for (const bar of bars) {
    if (Number.isFinite(bar.high) && bar.high > ath) {
      ath = bar.high;
      athDate = bar.date;
    }
  }

  const regularClose = latestBar?.close ?? cachedTicker.regularClose;
  const regularCloseDate = latestBar?.date ?? cachedTicker.regularCloseDate;
  const previousYear = eastern.year - 1;
  const yearStart = `${eastern.year}-01-01`;
  const previousYearBar = [...bars].reverse().find(bar =>
    Number.isFinite(bar.close) && bar.date < yearStart
  );
  let previousYearClose = previousYearBar?.close ?? null;
  if (previousYearClose === null && cachedTicker?.previousYear === previousYear) {
    previousYearClose = cachedTicker.previousYearClose;
  }
  if (previousYearClose === null && cachedTicker?.regularCloseDate?.startsWith(`${previousYear}-`)) {
    previousYearClose = cachedTicker.regularClose;
  }

  const ytdChange = previousYearClose > 0
    ? ((regularClose - previousYearClose) / previousYearClose) * 100
    : null;
  const drawdown = ath > 0 ? ((regularClose - ath) / ath) * 100 : 0;
  const longName = result.meta?.longName || cachedTicker?.longName || cachedTicker?.name || ticker;

  return {
    ticker,
    ath: parseFloat(ath.toFixed(2)),
    athDate,
    regularClose: parseFloat(regularClose.toFixed(2)),
    regularCloseDate,
    drawdown: parseFloat(drawdown.toFixed(2)),
    ytdChange: ytdChange === null ? null : parseFloat(ytdChange.toFixed(2)),
    previousYear,
    previousYearClose,
    historyThrough: regularCloseDate,
    updatedAt: now.toISOString(),
    longName,
    name: longName
  };
}

async function fetchTickerChart(ticker, startSec, endSec) {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${startSec}&period2=${endSec}&interval=1d`;
  const options = { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } };
  let json = await new Promise(resolve => {
    httpsGetWithTimeout(url, options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (_) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });

  if (!json?.chart?.result?.[0]) {
    console.log(`[Ticker ATH] https.get failed for ${ticker}. Trying curl fallback...`);
    json = await new Promise(resolve => {
      execFile('curl.exe', ['-s', '-L', '-A', options.headers['User-Agent'], url],
        { maxBuffer: 1024 * 1024 * 10, timeout: CURL_TIMEOUT_MS }, (error, stdout) => {
          if (error) return resolve(null);
          try { resolve(JSON.parse(stdout)); } catch (_) { resolve(null); }
        });
    });
  }
  return json?.chart?.result?.[0] || null;
}

async function fetchTickerAthData(config, cachedTickers = {}) {
  const tickers = config.tickers.map(item => item.ticker);
  const now = new Date();
  const endSec = Math.floor(now.getTime() / 1000);

  const tickerResults = await Promise.all(tickers.map(async ticker => {
    try {
      const cachedTicker = cachedTickers[ticker] || null;
      const startSec = getTickerHistoryStartSec(cachedTicker);
      const result = await fetchTickerChart(ticker, startSec, endSec);
      if (!result) throw new Error(`No chart data for ${ticker}`);
      return mergeTickerAthRecord(ticker, cachedTicker, result, now);
    } catch (error) {
      console.error(`[Ticker ATH] Failed to fetch data for ${ticker}:`, error.message);
      return { ticker, error: true };
    }
  }));

  const results = {};
  tickerResults.forEach(result => { results[result.ticker] = result; });
  return results;
}

// 1.5. 获取外部标的 ATH 数据

function fetchCnhRateFromApi() {
  return new Promise((resolve) => {
    const url = 'https://open.er-api.com/v6/latest/USD';
    httpsGetWithTimeout(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed && parsed.result === 'success' && parsed.rates) {
            // 优先获取离岸人民币 (CNH)，次选在岸人民币 (CNY)
            const rate = parsed.rates.CNH || parsed.rates.CNY;
            if (rate) {
              return resolve(parseFloat(rate));
            }
          }
        } catch (e) {
          console.error('Error parsing exchange rate response:', e);
        }
        resolve(null);
      });
    }).on('error', (err) => {
      console.error('Error requesting CNH exchange rate:', err);
      resolve(null);
    });
  });
}

// 启动服务器并自动初始化同步一次当日汇率

module.exports = {
  fetchYahooPrices,
  findCloseForPolicy,
  findPreviousClose,
  getTickerHistoryStartSec,
  mergeTickerAthRecord,
  fetchTickerAthData,
  fetchCnhRateFromApi
};
