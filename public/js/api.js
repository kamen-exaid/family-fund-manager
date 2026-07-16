/**
 * 前端 API 请求封装层 (api.js)
 */

const Api = {
  // 获取系统全局计算状态 (Dashboard + Members + Charts + Events)
  async getState() {
    const res = await fetch('/api/state');
    const json = await res.json();
    if (!json.success) throw new Error(json.message || '获取数据失败');
    return json.data;
  },

  // 录入出入金
  async addTransaction({ member, type, amount, cnhAmount, date, remark }) {
    const res = await fetch('/api/transaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ member, type, amount, cnhAmount, date, remark })
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.message || '录入交易失败');
    return json;
  },

  // 录入最新估值
  async updateValuation({ totalNAV, date, remark }) {
    const res = await fetch('/api/valuation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ totalNAV, date, remark })
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.message || '更新估值失败');
    return json;
  },

  // 删除单条流水记录 (出入金/估值，后台会自动重算)
  async deleteEvent(id) {
    const res = await fetch(`/api/event/${id}`, {
      method: 'DELETE'
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.message || '删除记录失败');
    return json;
  },

  // 修改历史流水记录 (出入金/估值)
  async updateEvent(id, data) {
    const res = await fetch(`/api/event/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.message || '修改记录失败');
    return json;
  },

  // 更新全局汇率设置
  async updateSettings({ cnhRate }) {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cnhRate })
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.message || '更新汇率设置失败');
    return json;
  },

  // 导入备份数据
  async importBackup(eventsData, membersData) {
    const res = await fetch('/api/backup/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: eventsData, members: membersData })
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.message || '导入备份数据失败');
    return json;
  },

  // --- 家庭成员增删改 API ---

  // 获取所有成员
  async getMembers() {
    const res = await fetch('/api/members');
    const json = await res.json();
    if (!json.success) throw new Error(json.message || '获取家庭成员失败');
    return json.data;
  },

  // 添加新成员
  async addMember(name) {
    const res = await fetch('/api/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.message || '添加家庭成员失败');
    return json.data;
  },

  // 编辑成员姓名
  async updateMember(id, name) {
    const res = await fetch(`/api/members/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.message || '修改家庭成员失败');
    return json;
  },

  // 删除成员 (无交易才允许)
  async deleteMember(id) {
    const res = await fetch(`/api/members/${id}`, {
      method: 'DELETE'
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.message || '删除家庭成员失败');
    return json.data;
  },

  // 自动同步外部汇率
  async syncCnhRate() {
    const res = await fetch('/api/settings/sync-rate', {
      method: 'POST'
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.message || '自动同步汇率失败');
    return json.cnhRate;
  },

  // 录入内部划转份额
  async addTransfer({ fromMember, toMember, amount, cnhRate, date, remark }) {
    const res = await fetch('/api/transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromMember, toMember, amount, cnhRate, date, remark })
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.message || '内部份额转让失败');
    return json;
  },

  // 获取标的历史高点与上个交易日收盘价/回调幅度
  async getTickerAth() {
    const res = await fetch('/api/ticker-ath');
    const json = await res.json();
    if (!json.success) throw new Error(json.message || '获取美股标的 ATH 失败');
    return json.data;
  },

  // 获取当前配置的标的列表
  async getTickers() {
    const res = await fetch('/api/settings/tickers');
    const json = await res.json();
    if (!json.success) throw new Error(json.message || '获取标的配置失败');
    return json.data;
  },

  // 保存最新配置的标的列表 (最大8个)
  async saveTickers(tickers) {
    const res = await fetch('/api/settings/tickers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickers })
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.message || '保存标的配置失败');
    return json;
  }
};
