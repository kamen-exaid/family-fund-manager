/**
 * Frontend API client with consistent HTTP, timeout, and JSON error handling.
 */
const API_TIMEOUT_MS = 15000;

async function requestApi(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    let response;
    try {
      response = await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('请求超时，请检查网络后重试');
      throw new Error('网络连接失败，请检查服务是否可用');
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(response.ok ? '服务返回了无法识别的数据' : `请求失败（HTTP ${response.status}）`);
    }

    if (!response.ok) throw new Error(payload?.message || `请求失败（HTTP ${response.status}）`);
    if (!payload?.success) throw new Error(payload?.message || '请求处理失败');
    return payload;
  } finally {
    clearTimeout(timeoutId);
  }
}

const jsonRequest = (url, method, body) => requestApi(url, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

const Api = {
  async getState() { return (await requestApi('/api/state')).data; },
  async addTransaction(data) { return jsonRequest('/api/transaction', 'POST', data); },
  async updateValuation(data) { return jsonRequest('/api/valuation', 'POST', data); },
  async deleteEvent(id) { return requestApi(`/api/event/${id}`, { method: 'DELETE' }); },
  async updateEvent(id, data) { return jsonRequest(`/api/event/${id}`, 'PUT', data); },
  async updateSettings(data) { return jsonRequest('/api/settings', 'POST', data); },
  async importBackup(file) {
    return requestApi('/api/backup/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: file
    });
  },
  async getMembers() { return (await requestApi('/api/members')).data; },
  async addMember(name) { return (await jsonRequest('/api/members', 'POST', { name })).data; },
  async updateMember(id, name) { return jsonRequest(`/api/members/${id}`, 'PUT', { name }); },
  async deleteMember(id) { return (await requestApi(`/api/members/${id}`, { method: 'DELETE' })).data; },
  async syncCnhRate() { return (await requestApi('/api/settings/sync-rate', { method: 'POST' })).cnhRate; },
  async addTransfer(data) { return jsonRequest('/api/transfer', 'POST', data); },
  async getTickerAth() {
    return (await requestApi('/api/ticker-ath', { cache: 'no-store' })).data;
  },
  async getTickers() { return (await requestApi('/api/settings/tickers')).data; },
  async saveTickers(tickers) { return jsonRequest('/api/settings/tickers', 'POST', { tickers }); }
};
