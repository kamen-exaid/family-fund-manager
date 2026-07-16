/**
 * ETF 市场数据面板：独立于账本状态，便于单独维护和测试。
 */
window.FundEtfPanel = {
  async load({ container, api, ui }) {
    if (!container) return;
    const { escapeHtml, formatMonthDay } = ui;
    try {
      const data = await api.getEtfAth();
      container.innerHTML = Object.keys(data).map(ticker => {
        const item = data[ticker];
        if (item.error) {
          return `<div class="etf-ath-card error"><span class="etf-ticker font-outfit">${escapeHtml(ticker)}</span><span class="error-msg">获取失败</span></div>`;
        }
        const drawdownClass = item.drawdown >= 0 ? 'text-green' : 'text-magenta';
        const drawdownPrefix = item.drawdown > 0 ? '+' : '';
        const safeTicker = escapeHtml(ticker);
        const safeName = escapeHtml(item.name || ticker);
        const safeLongName = escapeHtml(item.longName || ticker);
        return `
          <div class="etf-ath-card premium-border" title="${safeLongName}">
            <div class="etf-card-header"><span class="etf-ticker font-outfit">${safeTicker}</span><span class="etf-name" title="${safeName}">${safeName}</span></div>
            <div class="etf-card-body">
              <div class="etf-prices-col">
                <div class="price-row"><span class="price-lbl">ATH</span><span class="price-val text-cyan font-outfit">$${item.ath.toFixed(2)}</span><span class="price-date">(${formatMonthDay(item.athDate)})</span></div>
                <div class="price-row" style="margin-top: 1px;"><span class="price-lbl">收盘</span><span class="price-val font-outfit" style="color: var(--color-text-main);">$${item.regularClose.toFixed(2)}</span><span class="price-date">(${formatMonthDay(item.regularCloseDate)})</span></div>
              </div>
              <div class="etf-drawdown-col ${drawdownClass}"><span class="drawdown-lbl">较ATH回调</span><span class="drawdown-val font-outfit">${drawdownPrefix}${item.drawdown.toFixed(2)}%</span></div>
            </div>
          </div>`;
      }).join('');
    } catch (error) {
      // textContent keeps unexpected network error text out of HTML parsing.
      container.replaceChildren();
      const card = document.createElement('div');
      card.className = 'etf-ath-card error-bar';
      card.style.cssText = 'width: 100%; text-align: center;';
      const message = document.createElement('span');
      message.className = 'error-msg';
      message.textContent = `❌ 无法从服务器同步美股 ETF ATH 历史数据: ${error.message}`;
      card.appendChild(message);
      container.appendChild(card);
    }
  }
};
