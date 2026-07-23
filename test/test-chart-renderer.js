const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const listeners = {};
function createMockElement() {
  const element = {
    children: [],
    className: '',
    dataset: {},
    offsetWidth: 180,
    offsetHeight: 100,
    style: {
      values: {},
      setProperty(name, value) { this.values[name] = value; }
    },
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...children) { this.children = [...children]; },
    setAttribute(name, value) { this[name] = value; }
  };
  element.classList = {
    add(...names) {
      const classes = new Set(element.className.split(/\s+/).filter(Boolean));
      names.forEach(name => classes.add(name));
      element.className = [...classes].join(' ');
    }
  };
  return element;
}

const canvases = {
  navTrendChart: {
    dataset: {},
    getContext: () => ({}),
    addEventListener: (event, handler) => { listeners[event] = handler; }
  },
  memberAllocationChart: { dataset: {}, getContext: () => ({}) }
};
const stats = { innerHTML: '' };

global.window = {};
global.document = {
  createElement: createMockElement,
  getElementById(id) {
    return id === 'trend-stats-grid' ? stats : canvases[id];
  }
};
global.Chart = class Chart {
  constructor(_context, config) {
    this.config = config;
    this.data = config.data;
    this.options = config.options;
    this.updated = 0;
    this.drawn = 0;
    this.visibility = this.data.datasets.map(dataset => !dataset.hidden);
    this.metaDatasets = this.data.datasets.map(() => ({ dataset: { options: {} } }));
  }
  update(mode) { this.updated += 1; this.lastUpdateMode = mode; }
  draw() { this.drawn += 1; }
  isDatasetVisible(index) { return this.visibility[index]; }
  setDatasetVisibility(index, visible) { this.visibility[index] = visible; }
  getDatasetMeta(index) { return this.metaDatasets[index]; }
};
global.Chart.defaults = {
  plugins: {
    legend: {
      labels: {
        generateLabels(chart) {
          return chart.data.datasets.map((dataset, datasetIndex) => ({
            datasetIndex,
            fillStyle: dataset.pointBackgroundColor?.[0] || dataset.borderColor,
            strokeStyle: dataset.pointBorderColor?.[0] || dataset.borderColor,
            text: dataset.label
          }));
        }
      }
    }
  }
};

vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'chart-renderer.js'), 'utf8'));

const rightTooltipPosition = window.FundChartRenderer.calculateTooltipPosition({
  caretX: 100,
  caretY: 120,
  tooltipWidth: 180,
  tooltipHeight: 100,
  containerWidth: 600,
  containerHeight: 300
});
assert.deepStrictEqual(rightTooltipPosition, { left: 114, top: 120, placement: 'right' });

const leftTooltipPosition = window.FundChartRenderer.calculateTooltipPosition({
  caretX: 560,
  caretY: 120,
  tooltipWidth: 180,
  tooltipHeight: 100,
  containerWidth: 600,
  containerHeight: 300
});
assert.deepStrictEqual(leftTooltipPosition, { left: 366, top: 120, placement: 'left' });
assert(leftTooltipPosition.left + 180 < 560, 'left tooltip must not cover the active chart point');

const state = {
  members: {
    alice: { currentValue: 120 },
    bob: { currentValue: 80 }
  },
  charts: {
    navHistory: [
      { date: '2026-01-01', type: 'deposit', member: 'alice', amount: 100, cnhAmount: 720, remark: '首次入金', navPerShare: 1, totalNAV: 100, sp500NAV: 1, ndxNAV: 1 },
      { date: '2026-01-02', type: 'transfer', fromMember: 'alice', toMember: 'bob', amount: 20, cnhRate: 7.2, remark: '内部划转', navPerShare: 1.1, totalNAV: 200, sp500NAV: 1.01, ndxNAV: 1.02 }
    ]
  }
};
const members = [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }];
const elements = {
  chkCompNav: { checked: true }, chkCompAssets: { checked: true },
  chkCompSp500: { checked: true }, chkCompNdx: { checked: true }, trendStatsGrid: stats
};
const ui = {
  formatMoney: value => Number(value).toFixed(2),
  getThemeColors: () => ({ palette: ['#111', '#222'] }),
  isDarkTheme: () => true,
  createChartGradient: (_context, colorStart, colorEnd) => ({ colorStart, colorEnd })
};

const rendered = window.FundChartRenderer.render({
  state, members, settings: { activeTimeSlice: 'ALL', theme: 'dark' }, charts: {}, elements, ui
});

const trendLegendLabels = rendered.navTrendChart.options.plugins.legend.labels.generateLabels(rendered.navTrendChart);
assert.strictEqual(trendLegendLabels[0].fillStyle, '#5a57cc');
assert.strictEqual(trendLegendLabels[0].strokeStyle, '#5a57cc');
assert.strictEqual(rendered.navTrendChart.options.animation.duration, 380);
assert(rendered.navTrendChart.config.plugins.includes(window.FundChartRenderer.datasetOpacityPlugin));
assert.strictEqual(typeof rendered.renderTrendStats, 'function');

window.FundChartRenderer.animateDatasetVisibility(rendered.navTrendChart, 1, false, { duration: 0 });
assert.strictEqual(rendered.navTrendChart.isDatasetVisible(1), false);
assert.strictEqual(rendered.navTrendChart.lastUpdateMode, 'none');
window.FundChartRenderer.animateDatasetVisibility(rendered.navTrendChart, 1, true, { duration: 0 });
assert.strictEqual(rendered.navTrendChart.isDatasetVisible(1), true);
assert.strictEqual(rendered.navTrendChart.data.datasets[1].backgroundColor.colorStart, 'rgba(44, 97, 182, 0.36)');
assert.strictEqual(
  rendered.navTrendChart.getDatasetMeta(1).dataset.options.backgroundColor,
  rendered.navTrendChart.data.datasets[1].backgroundColor
);

assert.strictEqual(
  rendered.navTrendChart.options.plugins.tooltip.external,
  rendered.memberAllocationChart.options.plugins.tooltip.external,
  'trend and member allocation charts must share the glass tooltip renderer'
);

let mountedTooltip = null;
const tooltipContainer = {
  clientWidth: 600,
  clientHeight: 300,
  querySelector: () => mountedTooltip,
  appendChild(element) { mountedTooltip = element; }
};
rendered.navTrendChart.options.plugins.tooltip.external({
  chart: {
    canvas: {
      parentElement: tooltipContainer,
      toDataURL: () => 'data:image/png;base64,mock'
    },
    config: { type: 'line' }
  },
  tooltip: {
    opacity: 1,
    caretX: 100,
    caretY: 120,
    title: ['2026-01-02'],
    dataPoints: [{
      dataset: { borderColor: '#2c61b6', label: '单位净值' },
      datasetIndex: 1,
      parsed: { y: 1.1 }
    }]
  }
});
assert.match(mountedTooltip.className, /\bglass-tooltip\b/);
assert.match(mountedTooltip.children[0].className, /\bglass-tooltip-backdrop\b/);
assert.match(mountedTooltip.children[0].className, /\bglass-tooltip-chart-backdrop\b/);

assert.strictEqual(rendered.filteredHistory.length, 2);
assert.match(stats.innerHTML, /单位净值/);
const details = rendered.navTrendChart.options.plugins.tooltip.callbacks.afterBody([{ dataIndex: 0 }]);
assert(details.some(line => line.includes('Alice')));
assert(details.some(line => line.includes('首次入金')));
rendered.navTrendChart.options.onHover(null, [{ index: 1 }]);
assert.match(stats.innerHTML, /截至 2026-01-02/);
listeners.mouseleave();
assert.doesNotMatch(stats.innerHTML, /截至/);

console.log('Chart renderer interaction regression tests passed.');
