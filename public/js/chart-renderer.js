/**
 * 图表与趋势统计渲染器。Chart.js 实例由调用方持有，避免模块私有状态。
 */
window.FundChartRenderer = {
  render({ state, members, settings, charts, elements, ui }) {
    const { activeTimeSlice } = settings;
    const { navTrendChart, memberAllocationChart } = charts;
    const { chkCompNav, chkCompAssets, chkCompSp500, chkCompNdx, trendStatsGrid } = elements;
    const { formatMoney, getThemeColors, isDarkTheme, createChartGradient } = ui;
    const history = state.charts.navHistory;
    const now = new Date();
    const offsets = { YTD: () => new Date(now.getFullYear(), 0, 1), '1Y': () => new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()), '6M': () => new Date(now.getFullYear(), now.getMonth() - 6, now.getDate()), '3M': () => new Date(now.getFullYear(), now.getMonth() - 3, now.getDate()), '1M': () => new Date(now.getFullYear(), now.getMonth() - 1, now.getDate()) };
    const cutoff = offsets[activeTimeSlice]?.().toISOString().slice(0, 10);
    let filtered = cutoff ? history.filter(item => item.date >= cutoff) : history;
    if (!filtered.length && history.length) filtered = [history.at(-1)];

    const base = filtered[0] || { navPerShare: 1, sp500NAV: 1, ndxNAV: 1 };
    const labels = filtered.length ? filtered.map(item => item.date) : ['尚未入金'];
    const nav = filtered.length ? filtered.map(item => Number((item.navPerShare / base.navPerShare).toFixed(4))) : [1];
    const assets = filtered.length ? filtered.map(item => item.totalNAV) : [0];
    const spx = filtered.length ? filtered.map(item => Number((item.sp500NAV / base.sp500NAV).toFixed(4))) : [1];
    const ndx = filtered.length ? filtered.map(item => Number((item.ndxNAV / base.ndxNAV).toFixed(4))) : [1];

    const calculate = values => {
      const clean = values.filter(value => Number.isFinite(value) && value > 0);
      if (!clean.length) return { gain: 0, drawdown: 0 };
      let peak = clean[0]; let drawdown = 0;
      clean.forEach(value => { peak = Math.max(peak, value); drawdown = Math.min(drawdown, value / peak - 1); });
      return { gain: clean.at(-1) / clean[0] - 1, drawdown };
    };
    const percent = value => `${value > 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;
    const series = [
      { label: '单位净值', color: '#00f2fe', values: nav, visible: chkCompNav.checked },
      { label: '标普500指数', color: '#f59e0b', values: spx, visible: chkCompSp500.checked },
      { label: '纳斯达克100指数', color: '#ec4899', values: ndx, visible: chkCompNdx.checked }
    ];
    const renderStats = (activeIndex = null) => {
      const visible = series.filter(item => item.visible);
      trendStatsGrid.innerHTML = visible.length
        ? visible.map(item => {
          const end = Number.isInteger(activeIndex) ? Math.min(activeIndex, item.values.length - 1) : item.values.length - 1;
          const stats = calculate(item.values.slice(0, end + 1));
          const date = Number.isInteger(activeIndex) && labels[end] ? `<div class="trend-stat-date">截至 ${labels[end]}</div>` : '';
          return `<div class="trend-stat-card" style="--series-color:${item.color};"><div class="trend-stat-name">${item.label}</div>${date}<div class="trend-stat-values"><span><em>涨幅</em><strong class="${stats.gain >= 0 ? 'positive' : 'negative'}">${percent(stats.gain)}</strong></span><span><em>最大回撤</em><strong class="negative">${percent(stats.drawdown)}</strong></span></div></div>`;
        }).join('')
        : '<div class="trend-stat-empty">勾选上方指标后显示区间涨幅与最大回撤</div>';
    };
    renderStats();

    const navCanvas = document.getElementById('navTrendChart');
    const datasets = [
      { label: '基金总资产', data: assets, borderColor: '#8b5cf6', borderWidth: 2, borderDash: [5, 5], fill: false, tension: 0.35, yAxisID: 'y-assets', hidden: !chkCompAssets.checked },
      { label: '单位净值', data: nav, borderColor: '#00f2fe', borderWidth: 3, backgroundColor: createChartGradient(navCanvas.getContext('2d'), 'rgba(0,242,254,.15)', 'rgba(0,242,254,0)'), fill: true, tension: 0.35, yAxisID: 'y-nav', hidden: !chkCompNav.checked },
      { label: '标普500指数', data: spx, borderColor: '#f59e0b', borderWidth: 1.5, borderDash: [4, 4], fill: false, tension: 0.35, yAxisID: 'y-nav', hidden: !chkCompSp500.checked },
      { label: '纳斯达克100指数', data: ndx, borderColor: '#ec4899', borderWidth: 1.5, borderDash: [4, 4], fill: false, tension: 0.35, yAxisID: 'y-nav', hidden: !chkCompNdx.checked }
    ];
    let nextNav = navTrendChart;
    if (nextNav) {
      nextNav.data.labels = labels;
      nextNav.data.datasets.forEach((dataset, index) => { Object.assign(dataset, datasets[index]); });
      nextNav.options.scales['y-assets'].display = chkCompAssets.checked;
      nextNav.update();
    } else {
      nextNav = new Chart(navCanvas.getContext('2d'), {
        type: 'line', data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { labels: { color: 'rgba(255,255,255,.7)', font: { size: 11, weight: '500' } } },
            tooltip: {
              mode: 'index',
              intersect: false,
              callbacks: {
                label(context) {
                  return context.datasetIndex === 0
                    ? `${context.dataset.label}: $${formatMoney(context.parsed.y)}`
                    : `${context.dataset.label}: ${context.parsed.y.toFixed(3)}`;
                }
              }
            }
          },
          scales: {
            x: { grid: { color: 'rgba(255,255,255,.03)' }, ticks: { color: 'rgba(255,255,255,.4)' } },
            'y-nav': { position: 'left', ticks: { color: 'rgba(0,242,254,.6)', callback: value => value.toFixed(3) }, title: { display: true, text: '单位净值', color: 'rgba(0,242,254,.6)' } },
            'y-assets': { position: 'right', display: chkCompAssets.checked, grid: { drawOnChartArea: false }, ticks: { color: 'rgba(139,92,246,.6)', callback: value => `$${formatMoney(value)}` }, title: { display: true, text: '总资产 (USD)', color: 'rgba(139,92,246,.6)' } }
          }
        }
      });
    }
    nextNav.options.onHover = (_event, active) => renderStats(active.length ? active[0].index : null);
    nextNav.options.plugins.tooltip.callbacks.afterBody = context => {
      if (!context?.length) return [];
      const event = filtered[context[0].dataIndex];
      if (!event || event.type === 'valuation') return [];
      const name = id => members.find(member => member.id === id)?.name || '未知';
      const lines = ['---------------------'];
      if (event.type === 'deposit') lines.push('入金详情：', `   出资人: ${name(event.member)}`, `   金额: $${formatMoney(event.amount)}`);
      if (event.type === 'withdraw') lines.push('出金详情：', `   提取人: ${name(event.member)}`, `   金额: $${formatMoney(event.amount)}`);
      if (event.type === 'transfer') lines.push('转让详情：', `   从: ${name(event.fromMember)} 至: ${name(event.toMember)}`, `   金额: $${formatMoney(event.amount)}`);
      if (event.cnhAmount) lines.push(`   折合人民币: ¥${formatMoney(event.cnhAmount)}`);
      if (event.cnhRate) lines.push(`   受让汇率: ${event.cnhRate.toFixed(4)}`);
      if (event.remark) lines.push(`   备注: ${event.remark}`);
      return lines;
    };
    navCanvas._restoreTrendStats = () => renderStats();
    if (!navCanvas.dataset.trendStatsLeaveBound) {
      navCanvas.addEventListener('mouseleave', () => navCanvas._restoreTrendStats());
      navCanvas.dataset.trendStatsLeaveBound = 'true';
    }

    const dark = isDarkTheme(settings.theme);
    const { palette } = getThemeColors(dark);
    const values = members.map(member => state.members[member.id]?.currentValue || 0);
    const total = values.reduce((sum, value) => sum + value, 0);
    const empty = total === 0;
    const colors = empty ? members.map(() => dark ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.05)') : members.map((_, index) => palette[index % palette.length]);
    const shareCanvas = document.getElementById('memberAllocationChart');
    let nextAllocation = memberAllocationChart;
    if (nextAllocation) {
      Object.assign(nextAllocation.data, { labels: members.map(member => member.name) });
      Object.assign(nextAllocation.data.datasets[0], { data: empty ? members.map(() => 1) : values, backgroundColor: colors });
      nextAllocation.update();
    } else {
      nextAllocation = new Chart(shareCanvas.getContext('2d'), { type: 'doughnut', data: { labels: members.map(member => member.name), datasets: [{ data: empty ? members.map(() => 1) : values, backgroundColor: colors, borderWidth: 3, hoverOffset: 10 }] }, options: { responsive: true, maintainAspectRatio: false, cutout: '70%', plugins: { legend: { position: 'right', labels: { color: 'rgba(255,255,255,.7)', font: { size: 11, weight: '500' } } }, tooltip: { callbacks: { label(context) { if (empty) return ' 暂无出资占比'; const value = values[context.dataIndex]; return ` 资产价值: $${formatMoney(value)} (${(value / total * 100).toFixed(2)}%)`; } } } } } });
    }
    return { navTrendChart: nextNav, memberAllocationChart: nextAllocation, filteredHistory: filtered, trendSeries: series };
  }
};
