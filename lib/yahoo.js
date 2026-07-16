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
 * 在价格字典中寻找最近交易日的收盘价 (最多向前追溯 7 天)
 */
function findClosestPrice(dateStr, priceMap) {
  if (priceMap[dateStr] !== undefined) return priceMap[dateStr];
  let d = new Date(dateStr);
  for (let i = 0; i < 7; i++) {
    d.setDate(d.getDate() - 1);
    const checkStr = d.toISOString().split('T')[0];
    if (priceMap[checkStr] !== undefined) {
      return priceMap[checkStr];
    }
  }
  return null;
}

/**
 * 从本地 indexCache 中寻找最临近的对标价格 (时序兜底)
 */

async function fetchTickerAthData(config) {
  const tickers = config.tickers.map(e => e.ticker);
  const nameMap = {};
  config.tickers.forEach(e => { nameMap[e.ticker] = e.name; });

  // 提取单个标的抓取逻辑为独立函数
  async function fetchSingleTickerAth(ticker) {
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      // 1. 获取历史最大日K数据以得到历史 ATH
      const maxUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?period1=0&period2=${nowSec}&interval=1d`;
      const options = {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      };

      let maxData = await new Promise((resolve) => {
        httpsGetWithTimeout(maxUrl, options, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
          });
        }).on('error', () => resolve(null));
      });

      // Fallback to curl if https.get fails (automatic proxy support on domestic networks)
      // [Fix #1] 使用 execFile 参数化传递 URL，彻底规避 Shell 命令注入风险
      if (!maxData || !maxData.chart?.result?.[0]) {
        console.log(`[Ticker ATH] https.get failed for ${ticker}. Trying curl fallback...`);
        maxData = await new Promise((resolve) => {
          execFile('curl.exe', [
            '-s', '-L',
            '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            maxUrl
          ], { maxBuffer: 1024 * 1024 * 10, timeout: CURL_TIMEOUT_MS }, (error, stdout, stderr) => {
            if (error) {
              console.error(`[Ticker ATH] Curl fallback failed for ${ticker}:`, error.message);
              resolve(null);
              return;
            }
            try {
              resolve(JSON.parse(stdout));
            } catch (e) {
              resolve(null);
            }
          });
        });
      }

      if (!maxData || !maxData.chart?.result?.[0]) {
        throw new Error(`No chart data for ${ticker}`);
      }

      const result = maxData.chart.result[0];
      const highs = result.indicators.quote[0].high || [];
      const closes = result.indicators.quote[0].close || [];
      const timestamps = result.timestamp || [];
      const meta = result.meta;

      // 1. 获取当前美东时间（America/New_York）的年月日和小时
      const estFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      });
      const estParts = estFormatter.formatToParts(new Date());
      const estMap = {};
      estParts.forEach(p => estMap[p.type] = p.value);
      
      const todayStr = `${estMap.year}-${estMap.month}-${estMap.day}`;
      const estHour = parseInt(estMap.hour, 10);
      
      // 美盘盘后晚上 8 点结束后即可按最新数据走。因此 20:00 前需要排除今天未收盘数据，20:00 及之后不再排除
      const shouldExcludeToday = estHour < 20;

      let ath = 0;
      let athDate = '';
      for (let i = 0; i < highs.length; i++) {
        if (highs[i] !== null && highs[i] !== undefined) {
          const dateStr = new Date(timestamps[i] * 1000).toISOString().split('T')[0];
          if (shouldExcludeToday && dateStr === todayStr) continue; // 排除今天数据

          if (highs[i] > ath) {
            ath = highs[i];
            athDate = dateStr;
          }
        }
      }

      // 获取上个交易日收盘价与日期（根据 shouldExcludeToday 判定是否包含今天）
      let regularClose = meta.regularMarketPrice; // fallback
      let regularCloseDate = '';
      for (let i = closes.length - 1; i >= 0; i--) {
        if (closes[i] !== null && closes[i] !== undefined) {
          const dateStr = new Date(timestamps[i] * 1000).toISOString().split('T')[0];
          if (shouldExcludeToday && dateStr === todayStr) continue; // 排除今天
          regularClose = closes[i];
          regularCloseDate = dateStr;
          break;
        }
      }

      // 回调幅度 = (上个交易日收盘价 - ATH) / ATH * 100
      const drawdown = ((regularClose - ath) / ath) * 100;

      return {
        ticker,
        ath: parseFloat(ath.toFixed(2)),
        athDate,
        regularClose: parseFloat(regularClose.toFixed(2)),
        regularCloseDate,
        drawdown: parseFloat(drawdown.toFixed(2)),
        longName: meta.longName || ticker,
        name: nameMap[ticker] || meta.longName || ticker
      };
    } catch (err) {
      console.error(`[Ticker ATH] Failed to fetch data for ${ticker}:`, err.message);
      return {
        ticker,
        ath: 0,
        latestPrice: 0,
        regularClose: 0,
        drawdown: 0,
        name: nameMap[ticker] || ticker,
        error: true
      };
    }
  }

  // 优化：所有标的并行请求（原串行 4-8 秒 → 并行 1-2 秒）
  const tickerResults = await Promise.all(tickers.map(t => fetchSingleTickerAth(t)));
  const results = {};
  tickerResults.forEach(r => { results[r.ticker] = r; });
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

module.exports = { fetchYahooPrices, findClosestPrice, fetchTickerAthData, fetchCnhRateFromApi };
