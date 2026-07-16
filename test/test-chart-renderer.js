const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const listeners = {};
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
  getElementById(id) {
    return id === 'trend-stats-grid' ? stats : canvases[id];
  }
};
global.Chart = class Chart {
  constructor(_context, config) {
    this.data = config.data;
    this.options = config.options;
    this.updated = 0;
  }
  update() { this.updated += 1; }
  setDatasetVisibility() {}
};

vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'chart-renderer.js'), 'utf8'));

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
  createChartGradient: () => 'gradient'
};

const rendered = window.FundChartRenderer.render({
  state, members, settings: { activeTimeSlice: 'ALL', theme: 'dark' }, charts: {}, elements, ui
});

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

