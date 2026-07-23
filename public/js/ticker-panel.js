/**
 * Ticker 市场数据面板：独立于账本状态，便于单独维护和测试。
 */
window.FundTickerPanel = {
  async load({ container, api, ui }) {
    if (!container) return;
    const { escapeHtml, formatMonthDay } = ui;

    try {
      const data = await api.getTickerAth();
      const rows = Object.keys(data).map(ticker => {
        const item = data[ticker];
        const safeTicker = escapeHtml(ticker);

        if (item.error) {
          return `
            <tr class="ticker-table-error">
              <th scope="row" class="ticker-table-symbol">${safeTicker}</th>
              <td colspan="4">获取失败</td>
            </tr>`;
        }

        const safeLongName = escapeHtml(item.longName || item.name || ticker);
        const athDate = item.athDate ? formatMonthDay(item.athDate) : '--';
        const updatedAt = item.regularCloseDate ? formatMonthDay(item.regularCloseDate) : '--';
        const drawdownClass = item.drawdown >= 0 ? 'text-green' : 'text-magenta';
        const drawdownPrefix = item.drawdown > 0 ? '+' : '';

        return `
          <tr title="${safeLongName} · ATH 日期 ${athDate}">
            <th scope="row" class="ticker-table-symbol font-outfit">${safeTicker}</th>
            <td class="ticker-table-number ticker-table-ath font-outfit">$${item.ath.toFixed(2)}</td>
            <td class="ticker-table-number font-outfit">$${item.regularClose.toFixed(2)}</td>
            <td class="ticker-table-number ticker-table-drawdown ${drawdownClass} font-outfit">${drawdownPrefix}${item.drawdown.toFixed(2)}%</td>
            <td class="ticker-table-updated">${updatedAt}</td>
          </tr>`;
      }).join('');

      container.innerHTML = `
        <table class="ticker-table" aria-label="美股标的 ATH 追踪">
          <thead>
            <tr>
              <th scope="col">Ticker</th>
              <th scope="col">ATH</th>
              <th scope="col">收盘</th>
              <th scope="col">回调幅度</th>
              <th scope="col">更新时间</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
    } catch (error) {
      // textContent keeps unexpected network error text out of HTML parsing.
      container.replaceChildren();
      const state = document.createElement('div');
      state.className = 'ticker-table-state error';
      state.textContent = `无法从服务器同步美股标的 ATH 历史数据：${error.message}`;
      container.appendChild(state);
    }
  }
};
