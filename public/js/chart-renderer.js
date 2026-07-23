/**
 * 图表与趋势统计渲染器。Chart.js 实例由调用方持有，避免模块私有状态。
 */
window.FundChartRenderer = {
  datasetOpacityPlugin: {
    id: 'trendDatasetOpacity',
    beforeDatasetDraw(chart, args) {
      const opacity = chart.data.datasets[args.index]?.$visibilityOpacity;
      if (!Number.isFinite(opacity)) return;
      chart.ctx.save();
      chart.ctx.globalAlpha *= opacity;
    },
    afterDatasetDraw(chart, args) {
      const opacity = chart.data.datasets[args.index]?.$visibilityOpacity;
      if (Number.isFinite(opacity)) chart.ctx.restore();
    }
  },

  animateDatasetVisibility(chart, datasetIndex, visible, options = {}) {
    const dataset = chart?.data?.datasets?.[datasetIndex];
    if (!dataset) return;

    const duration = options.duration ?? (visible ? 320 : 240);
    const currentVisible = chart.isDatasetVisible
      ? chart.isDatasetVisible(datasetIndex)
      : !dataset.hidden;
    const from = Number.isFinite(dataset.$visibilityOpacity)
      ? dataset.$visibilityOpacity
      : (currentVisible ? 1 : 0);
    const target = visible ? 1 : 0;
    const applyOpacity = opacity => {
      dataset.$setVisibilityOpacity?.(opacity);
      const renderedDataset = chart.getDatasetMeta?.(datasetIndex)?.dataset;
      if (renderedDataset?.options && dataset.backgroundColor !== undefined) {
        renderedDataset.options.backgroundColor = dataset.backgroundColor;
      }
      dataset.$visibilityOpacity = opacity;
    };

    chart.$datasetVisibilityAnimations ??= new Map();
    const previous = chart.$datasetVisibilityAnimations.get(datasetIndex);
    if (previous) previous.cancelled = true;

    const finish = token => {
      if (token?.cancelled) return;
      applyOpacity(1);
      delete dataset.$visibilityOpacity;
      chart.setDatasetVisibility(datasetIndex, visible);
      chart.update('none');
      chart.$datasetVisibilityAnimations.delete(datasetIndex);
      options.onComplete?.();
    };

    if (visible) {
      chart.setDatasetVisibility(datasetIndex, true);
      applyOpacity(from);
      chart.update('none');
    }

    if (duration <= 0 || from === target) {
      finish();
      return;
    }

    const token = { cancelled: false };
    chart.$datasetVisibilityAnimations.set(datasetIndex, token);
    const now = () => globalThis.performance?.now?.() ?? Date.now();
    const requestFrame = globalThis.requestAnimationFrame
      || (callback => setTimeout(() => callback(now()), 16));
    const startedAt = now();

    const step = timestamp => {
      if (token.cancelled) return;
      const progress = Math.min(1, (timestamp - startedAt) / duration);
      const eased = progress < 0.5
        ? 4 * progress * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 3) / 2;
      applyOpacity(from + (target - from) * eased);
      chart.draw();

      if (progress < 1) requestFrame(step);
      else finish(token);
    };
    requestFrame(step);
  },

  calculateTooltipPosition({
    caretX,
    caretY,
    tooltipWidth,
    tooltipHeight,
    containerWidth,
    containerHeight,
    inset = 12,
    gap = 14
  }) {
    const halfHeight = Math.ceil(tooltipHeight / 2);
    const maxLeft = Math.max(inset, containerWidth - tooltipWidth - inset);
    const maxTop = Math.max(inset + halfHeight, containerHeight - halfHeight - inset);
    const rightLeft = caretX + gap;
    const placement = rightLeft <= maxLeft ? 'right' : 'left';
    const preferredLeft = placement === 'right'
      ? rightLeft
      : caretX - tooltipWidth - gap;

    return {
      left: Math.min(Math.max(preferredLeft, inset), maxLeft),
      top: Math.min(Math.max(caretY, inset + halfHeight), maxTop),
      placement
    };
  },

  render({ state, members, settings, charts, elements, ui }) {
    const { activeTimeSlice } = settings;
    const { navTrendChart, memberAllocationChart } = charts;
    const { chkCompNav, chkCompAssets, chkCompSp500, chkCompNdx, trendStatsGrid } = elements;
    const { formatMoney, isDarkTheme, createChartGradient, getMemberAvatarColor } = ui;
    const resolveMemberAvatarColor = getMemberAvatarColor || ((memberKey, dark, index) => ({
      background: (dark ? ['#31445B', '#5C4930', '#424A52', '#315541'] : ['#E8EEF7', '#F9EDD8', '#ECEFF1', '#E5F2EA'])[index % 4]
    }));
    const seriesColors = ui.getSeriesColors?.() || { assets: '#5a57cc', nav: '#2c61b6', sp500: '#f0bf3b', ndx: '#f38180' };
    const hexToRgba = ui.hexToRgba || ((color, alpha) => {
      const value = Number.parseInt(color.replace('#', ''), 16);
      return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
    });
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
      { label: '单位净值', color: seriesColors.nav, values: nav, visible: chkCompNav.checked },
      { label: '标普500指数', color: seriesColors.sp500, values: spx, visible: chkCompSp500.checked },
      { label: '纳斯达克100指数', color: seriesColors.ndx, values: ndx, visible: chkCompNdx.checked }
    ];
    const renderStats = (activeIndex = null) => {
      series[0].visible = chkCompNav.checked;
      series[1].visible = chkCompSp500.checked;
      series[2].visible = chkCompNdx.checked;
      const visible = series.filter(item => item.visible);
      trendStatsGrid.innerHTML = visible.length
        ? visible.map(item => {
          const isHover = Number.isInteger(activeIndex);
          const end = isHover ? Math.min(activeIndex, item.values.length - 1) : item.values.length - 1;
          const stats = calculate(item.values.slice(0, end + 1));
          const dateText = isHover && labels[end] ? `截至 ${labels[end]}` : '全周期区间历史';
          return `<div class="trend-stat-card" style="--series-color:${item.color};">
            <div class="trend-stat-name">${item.label}</div>
            <div class="trend-stat-date ${isHover ? 'is-hovering' : 'is-resting'}">${dateText}</div>
            <div class="trend-stat-values">
              <span><em>涨幅</em><strong class="privacy-sensitive ${stats.gain >= 0 ? 'positive' : 'negative'}">${percent(stats.gain)}</strong></span>
              <span><em>最大回撤</em><strong class="privacy-sensitive negative">${percent(stats.drawdown)}</strong></span>
            </div>
          </div>`;
        }).join('')
        : '<div class="trend-stat-empty">勾选上方指标后显示区间涨幅与最大回撤</div>';
    };
    renderStats();

    const dark = isDarkTheme(settings.theme);
    const navCanvas = document.getElementById('navTrendChart');
    const navCtx = navCanvas.getContext('2d');
    
    // 动态生成高通透度 Apple 风格多阶渐变
    const navGradient = createChartGradient(navCtx, hexToRgba(seriesColors.nav, dark ? 0.36 : 0.30), hexToRgba(seriesColors.nav, 0));

    const datasets = [
      {
        label: '基金总资产',
        data: assets,
        borderColor: seriesColors.assets,
        borderWidth: 1.8,
        borderDash: [8, 6],
        fill: false,
        tension: 0.38,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: seriesColors.assets,
        borderCapStyle: 'round',
        borderJoinStyle: 'round',
        cubicInterpolationMode: 'monotone',
        yAxisID: 'y-assets',
        hidden: !chkCompAssets.checked
      },
      {
        label: '单位净值',
        data: nav,
        borderColor: seriesColors.nav,
        borderWidth: 2.8,
        backgroundColor: navGradient,
        fill: true,
        tension: 0.38,
        pointRadius: 0,
        pointHoverRadius: 7,
        pointHoverBackgroundColor: seriesColors.nav,
        pointHoverBorderColor: '#ffffff',
        pointHoverBorderWidth: 2,
        borderCapStyle: 'round',
        borderJoinStyle: 'round',
        cubicInterpolationMode: 'monotone',
        yAxisID: 'y-nav',
        hidden: !chkCompNav.checked
      },
      {
        label: '标普500指数',
        data: spx,
        borderColor: seriesColors.sp500,
        borderWidth: 1.8,
        fill: false,
        tension: 0.38,
        pointRadius: 0,
        pointHoverRadius: 5,
        borderCapStyle: 'round',
        borderJoinStyle: 'round',
        cubicInterpolationMode: 'monotone',
        yAxisID: 'y-nav',
        hidden: !chkCompSp500.checked
      },
      {
        label: '纳斯达克100指数',
        data: ndx,
        borderColor: seriesColors.ndx,
        borderWidth: 1.8,
        fill: false,
        tension: 0.38,
        pointRadius: 0,
        pointHoverRadius: 5,
        borderCapStyle: 'round',
        borderJoinStyle: 'round',
        cubicInterpolationMode: 'monotone',
        yAxisID: 'y-nav',
        hidden: !chkCompNdx.checked
      }
    ];
    const navFillAlpha = dark ? 0.36 : 0.30;
    datasets[1].$setVisibilityOpacity = function setVisibilityOpacity(opacity) {
      this.backgroundColor = createChartGradient(
        navCtx,
        hexToRgba(seriesColors.nav, navFillAlpha * opacity),
        hexToRgba(seriesColors.nav, 0)
      );
    };

    const generateTrendLegendLabels = chart => {
      const labels = Chart.defaults.plugins.legend.labels.generateLabels(chart);
      return labels.map(label => {
        const seriesColor = chart.data.datasets[label.datasetIndex]?.borderColor;
        return seriesColor
          ? { ...label, fillStyle: seriesColor, strokeStyle: seriesColor }
          : label;
      });
    };

    const chartAnimation = {
      duration: 380,
      easing: 'easeOutQuart'
    };

    const tooltipTheme = {
      backgroundColor: dark ? 'rgba(18, 20, 32, 0.92)' : 'rgba(255, 255, 255, 0.94)',
      titleColor: dark ? '#ffffff' : '#0f172a',
      bodyColor: dark ? '#e2e8f0' : '#334155',
      borderColor: dark ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.1)',
      borderWidth: 1,
      padding: 12,
      cornerRadius: 12,
      boxPadding: 4,
      usePointStyle: false,
      boxWidth: 3,
      boxHeight: 18,
      titleFont: { size: 12, weight: '700', family: 'Outfit, sans-serif' },
      bodyFont: { size: 11, weight: '500', family: 'Inter, sans-serif' }
    };

    const gridColor = dark ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.04)';
    const tickColor = dark ? 'rgba(255, 255, 255, 0.5)' : 'rgba(0, 0, 0, 0.5)';
    const externalTooltip = ({ chart, tooltip }) => {
      const container = chart.canvas.parentElement;
      if (!container) return;
      let element = container.querySelector('.chart-external-tooltip');
      if (!element) {
        element = document.createElement('div');
        element.className = 'glass-tooltip chart-external-tooltip';
        container.appendChild(element);
      }
      element.classList.add('glass-tooltip');
      if (tooltip.opacity === 0) {
        element.style.opacity = '0';
        return;
      }

      element.replaceChildren();
      const backdrop = document.createElement('div');
      backdrop.className = 'glass-tooltip-backdrop glass-tooltip-chart-backdrop';
      backdrop.setAttribute('aria-hidden', 'true');
      element.appendChild(backdrop);

      const title = document.createElement('div');
      title.className = 'chart-external-tooltip-title';
      title.textContent = tooltip.title?.[0] || '';
      element.appendChild(title);
      if (chart.config.type === 'doughnut') {
        const point = tooltip.dataPoints[0];
        const value = point.parsed;
        const share = total > 0 ? (value / total * 100).toFixed(2) : '0.00';
        const color = point.dataset.backgroundColor[point.dataIndex];
        [['占比', `${share}%`], ['价值', `$${formatMoney(value)}`]].forEach(([labelText, valueText]) => {
          const row = document.createElement('div');
          row.className = 'chart-external-tooltip-row';
          const marker = document.createElement('i');
          marker.className = 'chart-external-tooltip-marker';
          marker.style.setProperty('--tooltip-series-color', color);
          const label = document.createElement('span');
          label.textContent = labelText;
          const valueElement = document.createElement('strong');
          valueElement.textContent = valueText;
          row.append(marker, label, valueElement);
          element.appendChild(row);
        });
      } else {
      tooltip.dataPoints.forEach(point => {
        const row = document.createElement('div');
        row.className = 'chart-external-tooltip-row';
        const marker = document.createElement('i');
        marker.className = 'chart-external-tooltip-marker';
        marker.style.setProperty('--tooltip-series-color', point.dataset.borderColor);
        const label = document.createElement('span');
        label.textContent = point.dataset.label;
        const value = document.createElement('strong');
        value.textContent = point.datasetIndex === 0 ? `$${formatMoney(point.parsed.y)}` : point.parsed.y.toFixed(3);
        row.append(marker, label, value);
        element.appendChild(row);
      });
      }
      if (tooltip.afterBody?.length) {
        const details = document.createElement('div');
        details.className = 'chart-external-tooltip-details';
        details.textContent = tooltip.afterBody.join('\n');
        element.appendChild(details);
      }
      const inset = 12;
      const { left, top, placement } = window.FundChartRenderer.calculateTooltipPosition({
        caretX: tooltip.caretX,
        caretY: tooltip.caretY,
        tooltipWidth: element.offsetWidth,
        tooltipHeight: element.offsetHeight,
        containerWidth: container.clientWidth,
        containerHeight: container.clientHeight,
        inset
      });
      const halfHeight = Math.ceil(element.offsetHeight / 2);
      const tooltipTop = top - halfHeight;
      // Canvas is often composited separately, so backdrop-filter alone cannot reliably blur it.
      // Sample the chart once per render and use it as the tooltip's blurred backdrop instead.
      if (!chart.$glassTooltipBackdrop) chart.$glassTooltipBackdrop = chart.canvas.toDataURL();
      element.style.setProperty('--tooltip-chart-image', `url("${chart.$glassTooltipBackdrop}")`);
      element.style.setProperty('--tooltip-chart-size', `${container.clientWidth}px ${container.clientHeight}px`);
      element.style.setProperty('--tooltip-chart-position', `${-left + 28}px ${-tooltipTop + 28}px`);
      element.style.left = `${left}px`;
      element.style.top = `${top}px`;
      element.dataset.placement = placement;
      element.style.opacity = '1';
    };

    let nextNav = navTrendChart;
    if (nextNav) {
      nextNav.data.labels = labels;
      nextNav.data.datasets.forEach((dataset, index) => { Object.assign(dataset, datasets[index]); });
      nextNav.options.scales['y-assets'].display = chkCompAssets.checked;
      nextNav.options.scales.x.grid.color = gridColor;
      nextNav.options.scales.x.ticks.color = tickColor;
      nextNav.options.scales['y-nav'].grid.color = gridColor;
      nextNav.options.scales['y-nav'].ticks.color = hexToRgba(seriesColors.nav, 0.8);
      nextNav.options.scales['y-nav'].title.color = hexToRgba(seriesColors.nav, 0.9);
      nextNav.options.scales['y-assets'].ticks.color = hexToRgba(seriesColors.assets, 0.8);
      nextNav.options.scales['y-assets'].title.color = hexToRgba(seriesColors.assets, 0.9);
      nextNav.options.plugins.legend.labels.generateLabels = generateTrendLegendLabels;
      nextNav.options.animation = chartAnimation;
      Object.assign(nextNav.options.plugins.tooltip, tooltipTheme);
      nextNav.options.plugins.tooltip.enabled = false;
      nextNav.options.plugins.tooltip.external = externalTooltip;
      nextNav.$glassTooltipBackdrop = null;
      nextNav.update();
    } else {
      nextNav = new Chart(navCtx, {
        type: 'line',
        data: { labels, datasets },
        plugins: [window.FundChartRenderer.datasetOpacityPlugin],
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: chartAnimation,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: {
              position: 'top',
              align: 'end',
              labels: {
                color: dark ? 'rgba(255, 255, 255, 0.8)' : 'rgba(0, 0, 0, 0.7)',
                font: { size: 11, weight: '600', family: 'Inter, sans-serif' },
                usePointStyle: true,
                boxWidth: 8,
                boxHeight: 8,
                padding: 14,
                generateLabels: generateTrendLegendLabels
              }
            },
            tooltip: {
              ...tooltipTheme,
              enabled: false,
              external: externalTooltip,
              mode: 'index',
              intersect: false,
              callbacks: {
                label(context) {
                  return context.datasetIndex === 0
                    ? ` ${context.dataset.label}: $${formatMoney(context.parsed.y)}`
                    : ` ${context.dataset.label}: ${context.parsed.y.toFixed(3)}`;
                },
                labelColor(context) {
                  return { borderColor: context.dataset.borderColor, backgroundColor: context.dataset.borderColor, borderWidth: 0 };
                }
              }
            }
          },
          scales: {
            x: {
              grid: { color: gridColor },
              ticks: { color: tickColor, font: { size: 10, family: 'Inter, sans-serif' } }
            },
            'y-nav': {
              position: 'left',
              grid: { color: gridColor },
              ticks: { color: hexToRgba(seriesColors.nav, 0.8), font: { family: 'Outfit, sans-serif' }, callback: value => value.toFixed(3) },
              title: { display: true, text: '单位净值', color: hexToRgba(seriesColors.nav, 0.9), font: { size: 11, weight: '600' } }
            },
            'y-assets': {
              position: 'right',
              display: chkCompAssets.checked,
              grid: { drawOnChartArea: false },
              ticks: { color: hexToRgba(seriesColors.assets, 0.8), font: { family: 'Outfit, sans-serif' }, callback: value => `$${formatMoney(value)}` },
              title: { display: true, text: '总资产 (USD)', color: hexToRgba(seriesColors.assets, 0.9), font: { size: 11, weight: '600' } }
            }
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

    const values = members.map(member => state.members[member.id]?.currentValue || 0);
    const total = values.reduce((sum, value) => sum + value, 0);
    const empty = total === 0;
    const colors = empty ? members.map(() => dark ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.05)') : members.map((member, index) => resolveMemberAvatarColor(member.id || member.name, dark, index).background);
    const shareCanvas = document.getElementById('memberAllocationChart');
    let nextAllocation = memberAllocationChart;
    if (nextAllocation) {
      Object.assign(nextAllocation.data, { labels: members.map(member => member.name) });
      Object.assign(nextAllocation.data.datasets[0], { data: empty ? members.map(() => 1) : values, backgroundColor: colors });
      Object.assign(nextAllocation.options.plugins.tooltip, tooltipTheme, { enabled: false, external: externalTooltip });
      nextAllocation.update();
    } else {
      nextAllocation = new Chart(shareCanvas.getContext('2d'), { type: 'doughnut', data: { labels: members.map(member => member.name), datasets: [{ data: empty ? members.map(() => 1) : values, backgroundColor: colors, borderWidth: 3, hoverOffset: 10 }] }, options: { responsive: true, maintainAspectRatio: false, cutout: '70%', plugins: { legend: { position: 'right', labels: { color: 'rgba(255,255,255,.7)', font: { size: 11, weight: '500' } } }, tooltip: { ...tooltipTheme, enabled: false, external: externalTooltip } } } });
    }
    return {
      navTrendChart: nextNav,
      memberAllocationChart: nextAllocation,
      filteredHistory: filtered,
      trendSeries: series,
      renderTrendStats: renderStats
    };
  }
};
