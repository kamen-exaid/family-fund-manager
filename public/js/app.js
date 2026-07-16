/**
 * 前端核心应用控制逻辑 (app.js)
 * 升级版：支持美元 (USD - $) 记账及完全动态家庭成员管理 (无上限)
 */

document.addEventListener('DOMContentLoaded', () => {
  const {
    getThemeColors,
    isDarkTheme,
    getAvatarText,
    formatMonthDay,
    escapeHtml,
    formatMoney,
    formatCnhWan,
    createChartGradient
  } = window.FundUiUtils;

  // --- 全局状态 ---
  let appState = null;
  let membersList = [];
  let activeChartTab = 'nav';
  let activeTimeSlice = 'ALL';
  let activeScaleType = 'linear'; // 'linear' or 'logarithmic'
  let navTrendChart = null;
  let memberAllocationChart = null;
  let currentTheme = 'system';
  let currentFilteredHistory = [];
  let currentTrendStatSeries = [];
  let isTrendStatsHovering = false;
  let isPrivacyMode = true; // 每次启动自动开启隐私模式

  // --- DOM 元素定义 ---
  const elSystemTime = document.getElementById('system-time');
  const themeBtns = document.querySelectorAll('[data-theme-btn]');
  const btnPrivacyToggle = document.getElementById('btn-privacy-toggle');

  // Dashboard Metrics
  const elFundTotalNav = document.getElementById('fund-total-nav');
  const elFundTotalShares = document.getElementById('fund-total-shares');
  const elFundNavPerShare = document.getElementById('fund-nav-per-share');
  const elNavIndicator = document.getElementById('nav-indicator');
  const elFundTotalProfit = document.getElementById('fund-total-profit');
  const elFundPrincipal = document.getElementById('fund-principal');
  const elFundProfitRate = document.getElementById('fund-profit-rate');

  // Dynamic Containers
  const elMembersGridContainer = document.getElementById('members-grid-container');
  const elMemberCountBadge = document.getElementById('member-count-badge');
  const elTxMember = document.getElementById('tx-member');
  const filterMember = document.getElementById('filter-member');

  // Trend Comparison Checkboxes
  const chkCompNav = document.getElementById('chk-comp-nav');
  const chkCompAssets = document.getElementById('chk-comp-assets');
  const chkCompSp500 = document.getElementById('chk-comp-sp500');
  const chkCompNdx = document.getElementById('chk-comp-ndx');
  const elTrendStatsGrid = document.getElementById('trend-stats-grid');

  // Operation Tabs & Forms
  const btnTabTx = document.getElementById('tab-btn-tx');
  const btnTabVal = document.getElementById('tab-btn-val');
  const btnTabTf = document.getElementById('tab-btn-tf');
  const formTransaction = document.getElementById('form-transaction');
  const formValuation = document.getElementById('form-valuation');
  const formTransfer = document.getElementById('form-transfer');

  // Form elements
  const txAmount = document.getElementById('tx-amount');
  const txDate = document.getElementById('tx-date');
  const txRemark = document.getElementById('tx-remark');
  const valTotalNav = document.getElementById('val-total-nav');
  const valDate = document.getElementById('val-date');
  const valRemark = document.getElementById('val-remark');

  // Transfer form elements
  const tfFromMember = document.getElementById('tf-from-member');
  const tfToMember = document.getElementById('tf-to-member');
  const tfAmount = document.getElementById('tf-amount');
  const tfRate = document.getElementById('tf-rate');
  const tfCnhDisplay = document.getElementById('tf-cnh-display');
  const tfDate = document.getElementById('tf-date');
  const tfRemark = document.getElementById('tf-remark');

  // Ledger Filter & Body
  const filterType = document.getElementById('filter-type');
  const ledgerTbody = document.getElementById('ledger-tbody');

  // Backup Modal
  const btnBackupPanel = document.getElementById('btn-backup-panel');
  const backupModal = document.getElementById('backup-modal');
  const btnCloseModal = document.getElementById('btn-close-modal');
  const btnTriggerUpload = document.getElementById('btn-trigger-upload');
  const fileImport = document.getElementById('file-import');
  const fileNameLabel = document.getElementById('file-name-label');
  const btnConfirmImport = document.getElementById('btn-confirm-import');

  // Edit Event Modal
  const editEventModal = document.getElementById('edit-event-modal');
  const btnCloseEditModal = document.getElementById('btn-close-edit-modal');
  const formEditEvent = document.getElementById('form-edit-event');
  const editEventId = document.getElementById('edit-event-id');
  const editEventType = document.getElementById('edit-event-type');
  const editMember = document.getElementById('edit-member');
  const editAmount = document.getElementById('edit-amount');
  const editCnhAmount = document.getElementById('edit-cnh-amount');
  const editDate = document.getElementById('edit-date');
  const editRemark = document.getElementById('edit-remark');
  const txCnhAmount = document.getElementById('tx-cnh-amount');
  const inputCnhRate = document.getElementById('input-cnh-rate');

  // Edit Transfer elements
  const editFromMember = document.getElementById('edit-from-member');
  const editToMember = document.getElementById('edit-to-member');
  const editCnhRate = document.getElementById('edit-cnh-rate');

  // Member Management Modal
  const btnMemberPanel = document.getElementById('btn-member-panel');
  const memberModal = document.getElementById('member-modal');
  const btnCloseMemberModal = document.getElementById('btn-close-member-modal');
  const formAddMember = document.getElementById('form-add-member');
  const newMemberName = document.getElementById('new-member-name');
  const elMembersEditList = document.getElementById('members-edit-list');

  // ETF Config Modal
  const btnConfigEtfs = document.getElementById('btn-config-etfs');
  const etfConfigModal = document.getElementById('etf-config-modal');
  const btnCloseEtfConfigModal = document.getElementById('btn-close-etf-config-modal');
  const etfConfigList = document.getElementById('etf-config-list');
  const btnAddEtfRow = document.getElementById('btn-add-etf-row');
  const btnSaveEtfConfig = document.getElementById('btn-save-etf-config');

  // 辅助函数判断是否是暗黑模式（兼容 system）
  function checkIfDark() {
    return isDarkTheme(currentTheme);
  }

  // --- 初始化运行 ---
  initTime();
  initTheme();
  initPrivacy();
  setDefaultDates();
  bindEvents();
  loadAllData();
  loadEtfAthData();
  setInterval(loadEtfAthData, 5 * 60 * 1000);

  // --- 隐私模式模块 ---
  function initPrivacy() {
    if (isPrivacyMode) {
      document.body.classList.add('privacy-mode-active');
    }
  }

  // --- 时间 and 日期模块 ---
  function initTime() {
    const updateTime = () => {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const timeStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
      elSystemTime.textContent = timeStr;
    };
    updateTime();
    setInterval(updateTime, 1000);
  }

  function setDefaultDates() {
    const today = new Date().toISOString().split('T')[0];
    txDate.value = today;
    valDate.value = today;
    if (tfDate) tfDate.value = today;
  }

  // --- 事件绑定模块 ---
  function bindEvents() {
    // 绑定三个主题选择按钮的点击事件
    themeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const theme = btn.getAttribute('data-theme-btn');
        currentTheme = theme;
        localStorage.setItem('family_fund_theme', theme);
        applyTheme(theme);
        showToast(`已切换至 ${btn.textContent.trim()} 模式`, 'success');
      });
    });

    // 绑定隐私模式切换按钮的点击事件 (仅图标切换)
    if (btnPrivacyToggle) {
      btnPrivacyToggle.addEventListener('click', () => {
        isPrivacyMode = !isPrivacyMode;
        if (isPrivacyMode) {
          document.body.classList.add('privacy-mode-active');
          showToast('隐私模式已开启，敏感财务数据已模糊隐藏', 'success');
        } else {
          document.body.classList.remove('privacy-mode-active');
          showToast('隐私模式已关闭', 'warning');
        }
      });
    }

    // 监听系统主题变化，如果当前是“系统模式”，则自动触发图表配色重绘
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (currentTheme === 'system') {
        applyTheme('system');
      }
    });

    // 切换录入表单面板
    btnTabTx.addEventListener('click', () => {
      btnTabTx.classList.add('active');
      btnTabVal.classList.remove('active');
      btnTabTf.classList.remove('active');
      formTransaction.classList.add('active');
      formValuation.classList.remove('active');
      formTransfer.classList.remove('active');
    });

    btnTabVal.addEventListener('click', () => {
      btnTabVal.classList.add('active');
      btnTabTx.classList.remove('active');
      btnTabTf.classList.remove('active');
      formValuation.classList.add('active');
      formTransaction.classList.remove('active');
      formTransfer.classList.remove('active');
    });

    btnTabTf.addEventListener('click', () => {
      btnTabTf.classList.add('active');
      btnTabTx.classList.remove('active');
      btnTabVal.classList.remove('active');
      formTransfer.classList.add('active');
      formTransaction.classList.remove('active');
      formValuation.classList.remove('active');

      // Auto prefill current global CNH Rate in the transfer rate input when opened
      const rateVal = parseFloat(inputCnhRate.value) || 7.2;
      tfRate.value = rateVal.toFixed(4);
      updateTfCnhDisplay();
    });

    // 划转表单金额及汇率联动
    const updateTfCnhDisplay = () => {
      const usdVal = parseFloat(tfAmount.value);
      const rateVal = parseFloat(tfRate.value);
      if (!isNaN(usdVal) && !isNaN(rateVal)) {
        tfCnhDisplay.textContent = `折合 CNH: ≈ ¥${formatMoney(usdVal * rateVal)}`;
      } else {
        tfCnhDisplay.textContent = `折合 CNH: ≈ ¥0.00`;
      }
    };
    tfAmount.addEventListener('input', updateTfCnhDisplay);
    tfRate.addEventListener('input', updateTfCnhDisplay);

    // 内部转让划转录入提交
    formTransfer.addEventListener('submit', async (e) => {
      e.preventDefault();

      const fromMember = tfFromMember.value;
      const toMember = tfToMember.value;
      const amount = parseFloat(tfAmount.value);
      const cnhRate = parseFloat(tfRate.value);
      const date = tfDate.value;
      const remark = tfRemark.value.trim();

      if (!fromMember || !toMember) {
        showToast('请先选择有效的出让方与受让方', 'error');
        return;
      }
      if (fromMember === toMember) {
        showToast('出让方与受让方不能为同一成员', 'error');
        return;
      }

      try {
        await Api.addTransfer({ fromMember, toMember, amount, cnhRate, date, remark });
        showToast('内部份额转让划转登记成功', 'success');
        formTransfer.reset();
        setDefaultDates();
        await loadAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    // 切换图表面板
    document.querySelectorAll('[data-chart-tab]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('[data-chart-tab]').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');

        activeChartTab = e.target.getAttribute('data-chart-tab');

        document.querySelectorAll('.chart-container').forEach(c => c.classList.remove('active'));
        document.getElementById(`chart-tab-${activeChartTab}-container`).classList.add('active');

        // 动态显示/隐藏对标控制面板与时间切片
        const ctrl = document.getElementById('trend-comparisons-ctrl');
        if (ctrl) {
          ctrl.style.display = activeChartTab === 'nav' ? 'flex' : 'none';
        }

        // 延迟触发图表重绘
        setTimeout(() => {
          if (activeChartTab === 'nav' && navTrendChart) navTrendChart.resize();
          if (activeChartTab === 'shares' && memberAllocationChart) memberAllocationChart.resize();
        }, 100);
      });
    });

    // 流水筛选
    filterMember.addEventListener('change', renderLedger);
    filterType.addEventListener('change', renderLedger);

    // 对标指数复选框切换监听
    const updateCompVisibility = () => {
      if (!navTrendChart) return;

      const showNav = chkCompNav.checked;
      const showAssets = chkCompAssets.checked;
      const showSpx = chkCompSp500.checked;
      const showNdx = chkCompNdx.checked;

      // 切换 Dataset 隐藏/显示状态
      navTrendChart.setDatasetVisibility(0, showAssets);
      navTrendChart.setDatasetVisibility(1, showNav);
      navTrendChart.setDatasetVisibility(2, showSpx);
      navTrendChart.setDatasetVisibility(3, showNdx);

      // 动态显示/隐藏右侧 Y 轴
      navTrendChart.options.scales['y-assets'].display = showAssets;

      navTrendChart.update();
      renderCharts();
    };

    chkCompNav.addEventListener('change', updateCompVisibility);
    chkCompAssets.addEventListener('change', updateCompVisibility);
    chkCompSp500.addEventListener('change', updateCompVisibility);
    chkCompNdx.addEventListener('change', updateCompVisibility);

    // 时间区间选择按钮绑定
    document.querySelectorAll('.time-slice-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.time-slice-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        activeTimeSlice = e.target.getAttribute('data-time-slice');
        renderCharts();
      });
    });

    // 对数坐标切换功能已移除

    // 联动逻辑：在录入交易输入 USD 时，基于全局汇率自动估算并预填 CNH
    txAmount.addEventListener('input', () => {
      const usdVal = parseFloat(txAmount.value);
      const rateVal = parseFloat(inputCnhRate.value) || 7.2;
      if (!isNaN(usdVal)) {
        txCnhAmount.value = (usdVal * rateVal).toFixed(2);
      } else {
        txCnhAmount.value = '';
      }
    });

    editAmount.addEventListener('input', () => {
      const usdVal = parseFloat(editAmount.value);
      const rateVal = parseFloat(inputCnhRate.value) || 7.2;
      if (!isNaN(usdVal) && editEventType.value !== 'valuation') {
        editCnhAmount.value = (usdVal * rateVal).toFixed(2);
      }
    });

    // 监听全局汇率变化
    inputCnhRate.addEventListener('change', async () => {
      const parsedRate = parseFloat(inputCnhRate.value);
      if (isNaN(parsedRate) || parsedRate <= 0) {
        showToast('汇率必须大于 0', 'error');
        return;
      }
      try {
        await Api.updateSettings({ cnhRate: parsedRate });
        showToast('全局 USD/CNH 汇率更新成功，账目已同步！', 'success');
        await loadAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    // 自动同步外部汇率按钮
    const btnSyncRate = document.getElementById('btn-sync-rate');
    if (btnSyncRate) {
      btnSyncRate.addEventListener('click', async () => {
        btnSyncRate.classList.add('spinning');
        try {
          const rate = await Api.syncCnhRate();
          showToast(`成功同步全球最新汇率：${rate.toFixed(4)}`, 'success');
          inputCnhRate.value = rate.toFixed(4);
          await loadAllData();
        } catch (err) {
          showToast(err.message, 'error');
        } finally {
          btnSyncRate.classList.remove('spinning');
        }
      });
    }

    // 监听编辑账目表单提交
    formEditEvent.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = editEventId.value;
      const type = editEventType.value;
      const date = editDate.value;
      const remark = editRemark.value.trim();

      const payload = { date, remark };
      if (type === 'deposit' || type === 'withdraw') {
        payload.member = editMember.value;
        payload.amount = parseFloat(editAmount.value);
        payload.cnhAmount = parseFloat(editCnhAmount.value);
      } else if (type === 'valuation') {
        payload.totalNAV = parseFloat(editAmount.value);
      } else if (type === 'transfer') {
        payload.fromMember = editFromMember.value;
        payload.toMember = editToMember.value;
        payload.amount = parseFloat(editAmount.value);
        payload.cnhRate = parseFloat(editCnhRate.value);
      }

      try {
        await Api.updateEvent(id, payload);
        showToast('账目修改成功，全局数据已级联重算！', 'success');
        editEventModal.classList.remove('active');
        await loadAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    // 关闭修改模态框
    btnCloseEditModal.addEventListener('click', () => editEventModal.classList.remove('active'));
    editEventModal.addEventListener('click', (e) => {
      if (e.target === editEventModal) editEventModal.classList.remove('active');
    });

    // 出入金录入提交
    formTransaction.addEventListener('submit', async (e) => {
      e.preventDefault();

      const member = elTxMember.value;
      const type = document.querySelector('input[name="txType"]:checked').value;
      const amount = parseFloat(txAmount.value);
      const cnhAmount = parseFloat(txCnhAmount.value);
      const date = txDate.value;
      const remark = txRemark.value.trim();

      if (!member) {
        showToast('请先创建家庭成员再进行交易登记', 'error');
        return;
      }

      try {
        await Api.addTransaction({ member, type, amount, cnhAmount, date, remark });
        showToast('交易记录登记成功', 'success');
        formTransaction.reset();
        setDefaultDates();
        await loadAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    // 估值更新提交
    formValuation.addEventListener('submit', async (e) => {
      e.preventDefault();

      const totalNAV = parseFloat(valTotalNav.value);
      const date = valDate.value;
      const remark = valRemark.value.trim();

      try {
        await Api.updateValuation({ totalNAV, date, remark });
        showToast('基金资产估值重估完成', 'success');
        formValuation.reset();
        setDefaultDates();
        await loadAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    // 数据备份模态框打开与关闭
    btnBackupPanel.addEventListener('click', () => backupModal.classList.add('active'));
    btnCloseModal.addEventListener('click', () => backupModal.classList.remove('active'));
    backupModal.addEventListener('click', (e) => {
      if (e.target === backupModal) backupModal.classList.remove('active');
    });

    // 成员管理模态框打开与关闭
    btnMemberPanel.addEventListener('click', () => {
      renderMembersEditorList();
      memberModal.classList.add('active');
    });
    btnCloseMemberModal.addEventListener('click', () => memberModal.classList.remove('active'));
    memberModal.addEventListener('click', (e) => {
      if (e.target === memberModal) memberModal.classList.remove('active');
    });

    // 新增成员表单提交
    formAddMember.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = newMemberName.value.trim();
      if (!name) return;

      try {
        await Api.addMember(name);
        showToast(`家庭成员【${name}】添加成功`, 'success');
        newMemberName.value = '';
        await loadAllData();
        renderMembersEditorList();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    // 备份导入文件上传选择
    btnTriggerUpload.addEventListener('click', () => fileImport.click());
    fileImport.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        fileNameLabel.textContent = file.name;
        btnConfirmImport.removeAttribute('disabled');
      } else {
        fileNameLabel.textContent = '未选择任何文件';
        btnConfirmImport.setAttribute('disabled', 'true');
      }
    });

    // 确认导入备份
    btnConfirmImport.addEventListener('click', () => {
      const file = fileImport.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const data = JSON.parse(e.target.result);
          await Api.importBackup(data.events, data.members);
          showToast('数据灾备恢复成功！所有账目已重新计算并生效。', 'success');
          backupModal.classList.remove('active');
          // 重置上传表单
          fileImport.value = '';
          fileNameLabel.textContent = '未选择任何文件';
          btnConfirmImport.setAttribute('disabled', 'true');
          await loadAllData();
        } catch (err) {
          showToast('数据解析失败，请确保上传了正确的 JSON 备份文件：' + err.message, 'error');
        }
      };
      reader.readAsText(file);
    });

    // 打开 ETF 配置弹窗
    if (btnConfigEtfs) {
      btnConfigEtfs.addEventListener('click', () => {
        renderEtfConfigList();
        etfConfigModal.classList.add('active');
      });
    }

    // 关闭 ETF 配置弹窗
    if (btnCloseEtfConfigModal) {
      btnCloseEtfConfigModal.addEventListener('click', () => etfConfigModal.classList.remove('active'));
    }
    if (etfConfigModal) {
      etfConfigModal.addEventListener('click', (e) => {
        if (e.target === etfConfigModal) etfConfigModal.classList.remove('active');
      });
    }

    // 渲染 ETF 配置列表
    async function renderEtfConfigList() {
      try {
        const etfs = await Api.getEtfs();
        etfConfigList.innerHTML = '';
        etfs.forEach(etf => {
          addEtfRow(etf.ticker, etf.name);
        });
        checkAddBtnState();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    // 动态添加一个配置行
    function addEtfRow(ticker = '', name = '') {
      const rowCount = etfConfigList.querySelectorAll('.etf-config-row').length;
      if (rowCount >= 8) {
        showToast('最多只能追踪 8 个标的', 'warning');
        return;
      }

      const row = document.createElement('div');
      row.className = 'etf-config-row member-edit-item';
      row.style.display = 'flex';
      row.style.gap = '10px';
      row.style.width = '100%';
      row.style.alignItems = 'center';
      row.innerHTML = `
        <div style="flex: 1; display: flex; gap: 8px; min-width: 0;">
          <input type="text" class="etf-ticker-input" value="${escapeHtml(ticker)}" placeholder="代码 (如: AAPL)" style="width: 120px; font-weight: 700; text-transform: uppercase;" required>
          <input type="text" class="etf-name-input" value="${escapeHtml(name)}" placeholder="中文简称 (如: 苹果)" style="flex: 1; min-width: 0;" required>
        </div>
        <button class="btn-delete btn-remove-etf-row" title="移除此标的" style="flex-shrink: 0; padding: 6px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px;">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      `;

      // 绑定删除按钮点击事件
      row.querySelector('.btn-remove-etf-row').addEventListener('click', () => {
        row.remove();
        checkAddBtnState();
      });

      etfConfigList.appendChild(row);
      checkAddBtnState();
    }

    // 检查“添加”按钮的启用状态
    function checkAddBtnState() {
      const rowCount = etfConfigList.querySelectorAll('.etf-config-row').length;
      if (rowCount >= 8) {
        btnAddEtfRow.setAttribute('disabled', 'true');
        btnAddEtfRow.style.opacity = '0.5';
        btnAddEtfRow.style.cursor = 'not-allowed';
      } else {
        btnAddEtfRow.removeAttribute('disabled');
        btnAddEtfRow.style.opacity = '1';
        btnAddEtfRow.style.cursor = 'pointer';
      }
    }

    // 添加配置行事件
    if (btnAddEtfRow) {
      btnAddEtfRow.addEventListener('click', () => addEtfRow());
    }

    // 保存配置事件
    if (btnSaveEtfConfig) {
      btnSaveEtfConfig.addEventListener('click', async () => {
        const rows = etfConfigList.querySelectorAll('.etf-config-row');
        const etfs = [];
        let valid = true;

        rows.forEach(row => {
          const tickerInput = row.querySelector('.etf-ticker-input');
          const nameInput = row.querySelector('.etf-name-input');
          const ticker = tickerInput.value.trim();
          const name = nameInput.value.trim();

          if (!ticker) {
            tickerInput.focus();
            valid = false;
            return;
          }
          if (!name) {
            nameInput.focus();
            valid = false;
            return;
          }
          etfs.push({ ticker, name });
        });

        if (!valid) {
          showToast('请完整填写代码和中文简称', 'error');
          return;
        }

        if (etfs.length === 0) {
          showToast('最少需要追踪 1 个标的', 'error');
          return;
        }

        btnSaveEtfConfig.setAttribute('disabled', 'true');
        btnSaveEtfConfig.textContent = '正在保存并拉取数据...';

        try {
          await Api.saveEtfs(etfs);
          showToast('标的配置保存成功！正在为您自动刷新页面。', 'success');
          etfConfigModal.classList.remove('active');
          // 重新抓取并更新顶部卡片
          await loadEtfAthData();
        } catch (err) {
          showToast(err.message, 'error');
        } finally {
          btnSaveEtfConfig.removeAttribute('disabled');
          btnSaveEtfConfig.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width: 18px; height: 18px;">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
            保存标的配置并刷新
          `;
        }
      });
    }
  }

  // --- 主题配置管理 ---
  function initTheme() {
    currentTheme = localStorage.getItem('family_fund_theme') || 'system';
    applyTheme(currentTheme);
  }

  function applyTheme(theme) {
    const body = document.body;
    body.classList.remove('theme-light', 'theme-dark');

    if (theme === 'light') {
      body.classList.add('theme-light');
    } else if (theme === 'dark') {
      body.classList.add('theme-dark');
    } else {
      // system 模式：自适应检测系统深色/浅色偏好并为 body 加上对应的类名，使 modal 等主题选择器生效
      const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      body.classList.add(isDark ? 'theme-dark' : 'theme-light');
    }

    // 更新主题选择器按钮的 active 状态
    themeBtns.forEach(btn => {
      if (btn.getAttribute('data-theme-btn') === theme) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    // 动态调整图表的边框、文字、网格线颜色
    updateChartsColors(theme);
  }

  function updateChartsColors(theme) {
    let isDarkTheme = false;
    if (theme === 'dark') {
      isDarkTheme = true;
    } else if (theme === 'light') {
      isDarkTheme = false;
    } else {
      // system
      isDarkTheme = window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    // 设置在不同主题下图表的文字与线条颜色
    const labelColor = isDarkTheme ? 'rgba(255, 255, 255, 0.7)' : 'rgba(31, 41, 55, 0.7)';
    const axisColor = isDarkTheme ? 'rgba(255, 255, 255, 0.4)' : 'rgba(31, 41, 55, 0.6)';
    const gridColor = isDarkTheme ? 'rgba(255, 255, 255, 0.03)' : 'rgba(0, 0, 0, 0.03)';
    const chartBgColor = isDarkTheme ? '#0f111a' : '#ffffff';

    if (navTrendChart) {
      navTrendChart.options.plugins.legend.labels.color = labelColor;
      navTrendChart.options.scales.x.grid.color = gridColor;
      navTrendChart.options.scales.x.ticks.color = axisColor;
      navTrendChart.options.scales['y-nav'].grid.color = gridColor;
      navTrendChart.options.scales['y-nav'].ticks.color = isDarkTheme ? 'rgba(0, 242, 254, 0.6)' : 'rgba(0, 119, 182, 0.7)';
      navTrendChart.options.scales['y-nav'].title.color = isDarkTheme ? 'rgba(0, 242, 254, 0.6)' : 'rgba(0, 119, 182, 0.7)';
      navTrendChart.options.scales['y-assets'].ticks.color = isDarkTheme ? 'rgba(139, 92, 246, 0.6)' : 'rgba(124, 58, 237, 0.7)';
      navTrendChart.options.scales['y-assets'].title.color = isDarkTheme ? 'rgba(139, 92, 246, 0.6)' : 'rgba(124, 58, 237, 0.7)';

      // 动态调整明暗主题下四条曲线的色值，彻底解决浅色模式下的低对比度问题
      const colors = isDarkTheme ? {
        nav: '#00f2fe',
        assets: '#8b5cf6',
        sp500: '#f59e0b',
        ndx: '#ec4899',
        deposit: '#10b981',
        withdraw: '#f43f5e',
        transfer: '#00f2fe'
      } : {
        nav: '#0284c7',   // 深天蓝 (Sky-600)
        assets: '#7c3aed',  // 皇家紫 (Purple-600)
        sp500: '#b45309',   // 琥珀棕 (Amber-700)
        ndx: '#be185d',    // 玫瑰红 (Pink-700)
        deposit: '#047857',
        withdraw: '#be185d',
        transfer: '#0284c7'
      };

      const getPointColorsList = (historyList, defaultColor) => {
        if (!historyList || historyList.length === 0) {
          return [defaultColor];
        }
        return historyList.map(h => {
          if (h.type === 'deposit') return colors.deposit;
          if (h.type === 'withdraw') return colors.withdraw;
          if (h.type === 'transfer') return colors.transfer;
          return defaultColor;
        });
      };

      if (navTrendChart.data.datasets[0]) {
        navTrendChart.data.datasets[0].borderColor = colors.assets;
        const ptColors = getPointColorsList(currentFilteredHistory, colors.assets);
        navTrendChart.data.datasets[0].pointBackgroundColor = ptColors;
        navTrendChart.data.datasets[0].pointBorderColor = ptColors;
        navTrendChart.data.datasets[0].pointHoverBackgroundColor = ptColors;
        navTrendChart.data.datasets[0].pointHoverBorderColor = ptColors;
      }
      if (navTrendChart.data.datasets[1]) {
        navTrendChart.data.datasets[1].borderColor = colors.nav;
        navTrendChart.data.datasets[1].pointBackgroundColor = colors.nav;
        navTrendChart.data.datasets[1].pointBorderColor = 'transparent';
        navTrendChart.data.datasets[1].pointHoverBackgroundColor = colors.nav;
        navTrendChart.data.datasets[1].pointHoverBorderColor = 'transparent';
        const ctxNav = document.getElementById('navTrendChart').getContext('2d');
        navTrendChart.data.datasets[1].backgroundColor = isDarkTheme
          ? createChartGradient(ctxNav, 'rgba(0, 242, 254, 0.15)', 'rgba(0, 242, 254, 0.0)')
          : createChartGradient(ctxNav, 'rgba(2, 132, 199, 0.12)', 'rgba(2, 132, 199, 0.0)');
      }
      if (navTrendChart.data.datasets[2]) {
        navTrendChart.data.datasets[2].borderColor = colors.sp500;
        navTrendChart.data.datasets[2].pointBackgroundColor = colors.sp500;
        navTrendChart.data.datasets[2].pointBorderColor = colors.sp500;
        navTrendChart.data.datasets[2].pointHoverBackgroundColor = colors.sp500;
        navTrendChart.data.datasets[2].pointHoverBorderColor = colors.sp500;
      }
      if (navTrendChart.data.datasets[3]) {
        navTrendChart.data.datasets[3].borderColor = colors.ndx;
        navTrendChart.data.datasets[3].pointBackgroundColor = colors.ndx;
        navTrendChart.data.datasets[3].pointBorderColor = colors.ndx;
        navTrendChart.data.datasets[3].pointHoverBackgroundColor = colors.ndx;
        navTrendChart.data.datasets[3].pointHoverBorderColor = colors.ndx;
      }

      navTrendChart.update();
    }

    if (memberAllocationChart) {
      memberAllocationChart.options.plugins.legend.labels.color = labelColor;
      memberAllocationChart.data.datasets[0].borderColor = chartBgColor;

      // 动态更新成员环形占比图的配色切片，防浅色融化
      const { palette: currentPalette } = getThemeColors(isDarkTheme);
      if (memberAllocationChart.data.datasets[0].backgroundColor && memberAllocationChart.data.datasets[0].backgroundColor.length > 0) {
        const firstColor = memberAllocationChart.data.datasets[0].backgroundColor[0];
        if (firstColor && !firstColor.startsWith('rgba(')) {
          const newColors = memberAllocationChart.data.labels.map((_, idx) => currentPalette[idx % currentPalette.length]);
          memberAllocationChart.data.datasets[0].backgroundColor = newColors;
        } else {
          const zeroColor = isDarkTheme ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)';
          memberAllocationChart.data.datasets[0].backgroundColor = memberAllocationChart.data.labels.map(() => zeroColor);
        }
      }

      memberAllocationChart.update();
    }
  }

  // --- 数据拉取与主渲染控制 ---
  async function loadAllData() {
    try {
      // 同时获取成员列表与基金状态
      membersList = await Api.getMembers();
      appState = await Api.getState();

      // 更新动态下拉选项（出入金下拉 + 流水筛选下拉）
      populateDynamicSelectors();

      // 执行页面数据渲染
      renderDashboard();
      renderMembersGrid();
      renderLedger();
      renderCharts();
    } catch (err) {
      showToast('获取系统账务状态失败: ' + err.message, 'error');
    }
  }

  // 动态构建下拉选择菜单（出入金登记、流水筛选、转让选择）
  function populateDynamicSelectors() {
    // 1. 出入金登记选择框
    const savedTxVal = elTxMember.value;
    elTxMember.innerHTML = membersList.map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join('');
    if (savedTxVal && membersList.some(m => m.id === savedTxVal)) {
      elTxMember.value = savedTxVal;
    }

    // 1.2. 转让出让方与受让方选择框
    const savedTfFromVal = tfFromMember.value;
    const savedTfToVal = tfToMember.value;
    const membersOptionsHtml = membersList.map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join('');
    tfFromMember.innerHTML = membersOptionsHtml;
    tfToMember.innerHTML = membersOptionsHtml;
    if (savedTfFromVal && membersList.some(m => m.id === savedTfFromVal)) {
      tfFromMember.value = savedTfFromVal;
    } else if (membersList.length > 0) {
      tfFromMember.value = membersList[0].id;
    }
    if (savedTfToVal && membersList.some(m => m.id === savedTfToVal)) {
      tfToMember.value = savedTfToVal;
    } else if (membersList.length > 1) {
      tfToMember.value = membersList[1].id;
    }

    // 1.5. 编辑账目成员选择框
    const savedEditVal = editMember.value;
    editMember.innerHTML = membersOptionsHtml;
    if (savedEditVal && membersList.some(m => m.id === savedEditVal)) {
      editMember.value = savedEditVal;
    }

    // 1.6. 编辑划转成员选择框
    const savedEditFromVal = editFromMember.value;
    const savedEditToVal = editToMember.value;
    editFromMember.innerHTML = membersOptionsHtml;
    editToMember.innerHTML = membersOptionsHtml;
    if (savedEditFromVal && membersList.some(m => m.id === savedEditFromVal)) {
      editFromMember.value = savedEditFromVal;
    }
    if (savedEditToVal && membersList.some(m => m.id === savedEditToVal)) {
      editToMember.value = savedEditToVal;
    }

    // 2. 流水筛选框 (保留“所有流水”及“系统估值”，动态插入成员)
    const savedFilterVal = filterMember.value;
    filterMember.innerHTML = `
      <option value="all">所有流水对象</option>
      ${membersList.map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join('')}
      <option value="system">系统/估值</option>
    `;
    if (savedFilterVal) {
      filterMember.value = savedFilterVal;
    }
  }

  // 1. 仪表盘指标渲染 (USD 币种重构 & CNH 人民币对比核算)
  function renderDashboard() {
    const s = appState.summary;

    // 自动更新汇率框数值（若当前没有被焦点选中）
    if (document.activeElement !== inputCnhRate) {
      inputCnhRate.value = s.cnhRate.toFixed(4);
    }

    elFundTotalNav.textContent = `$${formatMoney(s.totalNAV)}`;
    elFundTotalShares.innerHTML = `<span style="color: var(--color-cyan); font-weight: 600;">CNH 估值: ≈ ¥<span class="privacy-sensitive">${formatCnhWan(s.cnhTotalNAV)}</span> (汇率: ${s.cnhRate.toFixed(4)})</span>`;

    elFundNavPerShare.textContent = s.navPerShare.toFixed(4);
    // 根据单位净值更新颜色指示器
    if (s.navPerShare > 1.0000) {
      elFundNavPerShare.className = 'metric-value font-outfit text-green privacy-sensitive';
    } else if (s.navPerShare < 1.0000) {
      elFundNavPerShare.className = 'metric-value font-outfit text-magenta privacy-sensitive';
    } else {
      elFundNavPerShare.className = 'metric-value font-outfit text-cyan privacy-sensitive';
    }

    elNavIndicator.innerHTML = `<span class="status-indicator">已与最新市场数据同步</span>`;

    // 收益总额与本金
    const netPrincipal = s.totalDeposit - s.totalWithdraw;
    const cnhNetPrincipal = s.cnhTotalDeposit - s.cnhTotalWithdraw;
    elFundPrincipal.innerHTML = `累计本金: <span class="privacy-sensitive">$${formatMoney(netPrincipal)}</span><br><span style="font-size:0.75rem; color:var(--color-green); font-weight:600; line-height:1.4;">CNH 净本金: ≈ ¥<span class="privacy-sensitive">${formatCnhWan(cnhNetPrincipal)}</span></span>`;

    elFundTotalProfit.innerHTML = (s.profit >= 0 ? '+' : '') + `<span class="privacy-sensitive">$${formatMoney(s.profit)}</span><span style="font-size:0.75rem; display:block; margin-top:2px; font-weight:600;">CNH 收益: ${s.cnhProfit >= 0 ? '+' : ''}¥<span class="privacy-sensitive">${formatCnhWan(s.cnhProfit)}</span></span>`;
    elFundTotalProfit.className = 'metric-value font-outfit ' + (s.profit >= 0 ? 'text-green privacy-sensitive' : 'text-magenta privacy-sensitive');

    // 收益率
    elFundProfitRate.innerHTML = (s.profitRate >= 0 ? '+' : '') + `<span class="privacy-sensitive">${s.profitRate.toFixed(2)}%</span><span style="font-size:0.75rem; display:block; margin-top:2px; color:var(--color-text-main); font-weight:600;">CNH 收益率: ${s.cnhProfitRate >= 0 ? '+' : ''}<span class="privacy-sensitive">${s.cnhProfitRate.toFixed(2)}%</span></span>`;
    elFundProfitRate.className = 'metric-value font-outfit ' + (s.profitRate >= 0 ? 'text-green privacy-sensitive' : 'text-magenta privacy-sensitive');
  }

  // 2. 动态家庭成员资产网格渲染
  function renderMembersGrid() {
    return window.FundMemberRenderer.renderGrid({
      state: appState,
      members: membersList,
      elements: { grid: elMembersGridContainer, countBadge: elMemberCountBadge },
      utils: { escapeHtml, formatMoney, formatCnhWan, getAvatarText, getThemeColors },
      isDark: checkIfDark()
    });
  }

  // 3. 家庭成员管理模态框列表渲染 (带 inline 修改与安全删除)
  function renderMembersEditorList() {
    if (membersList.length === 0) {
      elMembersEditList.innerHTML = `
        <div style="text-align: center; color: var(--color-text-muted); padding: 20px; font-size: 0.8rem;">
          当前家庭无成员数据，请输入名字创建
        </div>
      `;
      return;
    }

    elMembersEditList.innerHTML = membersList.map((m, idx) => {
      const shortName = escapeHtml(getAvatarText(m.name));

      const isDark = checkIfDark();
      const { palette, textPalette } = getThemeColors(isDark);
      const cardColor = palette[idx % palette.length];
      const cardTextColor = textPalette[idx % textPalette.length];

      // 检查成员是否拥有交易历史
      const hasTx = appState.events.some(e =>
        e.member === m.id || e.fromMember === m.id || e.toMember === m.id
      );

      return `
        <div class="member-edit-item" id="member-edit-item-${m.id}">
          <div class="member-edit-left">
            <div class="member-edit-avatar" style="background: ${cardColor}; color: ${cardTextColor};">${shortName}</div>
            <span class="member-edit-name" id="member-name-span-${m.id}" title="双击或点击右侧笔头重命名">${escapeHtml(m.name)}</span>
            <input type="text" class="input-rename" id="member-name-input-${m.id}" value="${escapeHtml(m.name)}" style="display: none;">
          </div>
          <div class="member-edit-actions">
            <button class="btn-rename-save" id="btn-rename-edit-${m.id}" title="重命名成员" style="color: var(--color-cyan);">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
              </svg>
            </button>
            <button class="btn-rename-save" id="btn-rename-save-${m.id}" title="保存修改" style="color: var(--color-green); display: none;">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </button>
            <button class="btn-delete" id="btn-member-del-${m.id}" title="${hasTx ? '已有出入金或转让记录，禁止删除' : '移除该成员'}" ${hasTx ? 'disabled style="opacity: 0.25; cursor: not-allowed;"' : ''}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </div>
      `;
    }).join('');

    // 事件绑定
    membersList.forEach(m => {
      const span = document.getElementById(`member-name-span-${m.id}`);
      const input = document.getElementById(`member-name-input-${m.id}`);
      const btnEdit = document.getElementById(`btn-rename-edit-${m.id}`);
      const btnSave = document.getElementById(`btn-rename-save-${m.id}`);
      const btnDel = document.getElementById(`btn-member-del-${m.id}`);

      const startEdit = () => {
        span.style.display = 'none';
        btnEdit.style.display = 'none';
        input.style.display = 'block';
        btnSave.style.display = 'inline-flex';
        input.focus();
        input.select();
      };

      const saveEdit = async () => {
        const newName = input.value.trim();
        if (!newName) {
          showToast('成员姓名不能为空', 'error');
          return;
        }
        if (newName === m.name) {
          // 无改动取消
          cancelEdit();
          return;
        }
        try {
          await Api.updateMember(m.id, newName);
          showToast(`家庭成员【${m.name}】已成功重命名为【${newName}】`, 'success');
          await loadAllData();
          renderMembersEditorList();
        } catch (err) {
          showToast(err.message, 'error');
        }
      };

      const cancelEdit = () => {
        span.style.display = 'block';
        btnEdit.style.display = 'inline-flex';
        input.style.display = 'none';
        btnSave.style.display = 'none';
        input.value = m.name;
      };

      span.addEventListener('dblclick', startEdit);
      btnEdit.addEventListener('click', startEdit);
      btnSave.addEventListener('click', saveEdit);

      input.addEventListener('keyup', (e) => {
        if (e.key === 'Enter') saveEdit();
        if (e.key === 'Escape') cancelEdit();
      });

      if (btnDel && !btnDel.disabled) {
        btnDel.addEventListener('click', async () => {
          if (confirm(`⚠️ 确定要从系统删除家庭成员【${m.name}】吗？删除后将无法撤销。`)) {
            try {
              await Api.deleteMember(m.id);
              showToast(`家庭成员【${m.name}】已移除`, 'success');
              await loadAllData();
              renderMembersEditorList();
            } catch (err) {
              showToast(err.message, 'error');
            }
          }
        });
      }
    });
  }

  // 4. 历史账目表格流水渲染 (USD 币种重构)
  function renderLedger() {
    return window.FundLedgerRenderer.render({
      state: appState,
      members: membersList,
      elements: { filterMember, filterType, ledgerTbody },
      utils: { escapeHtml, formatMoney, formatCnhWan },
      onEdit: handleEditEvent,
      onDelete: handleDeleteEvent
    });
  }

  // 删除单条交易记录 — 10 秒内可撤销
  function handleDeleteEvent(id, name, type, value) {
    const UNDO_DELAY = 10000; // 10 秒

    // 找到对应的 <tr> 行，视觉上先隐藏（软删除）
    const allRows = ledgerTbody.querySelectorAll('tr');
    let targetRow = null;
    allRows.forEach(row => {
      // 通过行上绑定的删除按钮 data 匹配（找到包含该 id 对应删除按钮的行）
      row.querySelectorAll('button').forEach(btn => {
        if (btn._deleteEventId === id) targetRow = row;
      });
    });

    if (targetRow) {
      targetRow.style.transition = 'opacity 0.3s, transform 0.3s';
      targetRow.style.opacity = '0.2';
      targetRow.style.pointerEvents = 'none';
    }

    // 构建撤销 Toast
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast toast-undo';
    toast.innerHTML = `
      <div class="toast-undo-row">
        <span class="toast-undo-icon">🗑️</span>
        <span class="toast-undo-text">
          <strong>已删除</strong>
          ${type === 'deposit' ? '入金' : type === 'withdraw' ? '出金' : type === 'transfer' ? '转让' : '估值'}记录（$${formatMoney(value)}）<br>
          <span style="font-size:0.75rem; opacity:0.7;">10 秒内可撤销，操作完成后将重算账目</span>
        </span>
        <button class="toast-undo-btn" id="undo-btn-${id}">↩ 撤销</button>
      </div>
      <div class="toast-undo-progress-wrap">
        <div class="toast-undo-progress-bar" id="undo-progress-${id}" style="animation-duration: ${UNDO_DELAY}ms;"></div>
      </div>
    `;
    container.appendChild(toast);

    // 入场动画
    toast.style.animation = 'toastSlideIn 0.3s cubic-bezier(0.4, 0, 0.2, 1) forwards';

    let undone = false;

    // 撤销按钮点击处理
    const undoBtn = document.getElementById(`undo-btn-${id}`);
    if (undoBtn) {
      undoBtn.addEventListener('click', () => {
        undone = true;
        clearTimeout(deleteTimer);
        // 恢复行显示
        if (targetRow) {
          targetRow.style.opacity = '1';
          targetRow.style.pointerEvents = '';
          targetRow.style.transform = '';
        }
        // 关闭 Toast
        dismissToast(toast);
        showToast('已撤销删除操作', 'success');
      });
    }

    // 10 秒后执行真正删除
    const deleteTimer = setTimeout(() => {
      if (undone) return;
      Api.deleteEvent(id)
        .then(() => {
          showToast('账目记录已删除，系统已完成全额重算！', 'success');
          loadAllData();
        })
        .catch(err => {
          // 删除失败，恢复行
          if (targetRow) {
            targetRow.style.opacity = '1';
            targetRow.style.pointerEvents = '';
          }
          showToast('删除失败：' + err.message, 'error');
        });
      dismissToast(toast);
    }, UNDO_DELAY);

    // 辅助：关闭 Toast（淡出动画后移除）
    function dismissToast(t) {
      t.style.animation = 'toastSlideIn 0.3s cubic-bezier(0.4, 0, 0.2, 1) reverse forwards';
      t.addEventListener('animationend', () => t.remove(), { once: true });
    }
  }

  // 弹出编辑账目模态框并填充回显
  function handleEditEvent(e) {
    const editModalTitle = document.getElementById('edit-modal-title');
    const editGroupMember = document.getElementById('edit-group-member');
    const editGroupCnhAmount = document.getElementById('edit-group-cnh-amount');
    const editLabelAmount = document.getElementById('edit-label-amount');
    const editGroupTransferMembers = document.getElementById('edit-group-transfer-members');
    const editGroupCnhRate = document.getElementById('edit-group-cnh-rate');

    // 填充基本信息
    editEventId.value = e.id;
    editEventType.value = e.type;
    editDate.value = e.date;
    editRemark.value = e.remark || '';

    // 重置特有选项组显示状态
    editGroupMember.style.display = 'none';
    editGroupCnhAmount.style.display = 'none';
    editGroupTransferMembers.style.display = 'none';
    editGroupCnhRate.style.display = 'none';

    if (e.type === 'deposit' || e.type === 'withdraw') {
      // 交易类型：显示成员选择和人民币金额
      editModalTitle.textContent = e.type === 'deposit' ? '修改出资入金流水分账' : '修改出资金额提现流水分账';
      editGroupMember.style.display = 'block';
      editGroupCnhAmount.style.display = 'block';
      editLabelAmount.textContent = '美元金额 (USD)';

      editMember.value = e.member;
      editAmount.value = e.amount;
      editCnhAmount.value = e.cnhAmount || '';
    } else if (e.type === 'valuation') {
      // 估值类型：隐藏成员选择和人民币金额
      editModalTitle.textContent = '修改定期基金估值重估记录';
      editLabelAmount.textContent = '基金总资产估值 (USD)';

      editAmount.value = e.totalNAV;
    } else if (e.type === 'transfer') {
      // 转让类型：显示出让/受让方，及转让汇率
      editModalTitle.textContent = '修改内部份额转让记录';
      editGroupTransferMembers.style.display = 'flex';
      editGroupCnhRate.style.display = 'block';
      editLabelAmount.textContent = '转让金额 (USD)';

      editFromMember.value = e.fromMember;
      editToMember.value = e.toMember;
      editAmount.value = e.amount;
      editCnhRate.value = e.cnhRate || appState.summary.cnhRate || 7.2000;
    }

    editEventModal.classList.add('active');
  }

  function renderCharts() {
    if (!appState) return;
    const rendered = window.FundChartRenderer.render({
      state: appState,
      members: membersList,
      settings: { activeTimeSlice, theme: currentTheme },
      charts: { navTrendChart, memberAllocationChart },
      elements: { chkCompNav, chkCompAssets, chkCompSp500, chkCompNdx, trendStatsGrid: elTrendStatsGrid },
      ui: { formatMoney, getThemeColors, isDarkTheme, createChartGradient }
    });
    navTrendChart = rendered.navTrendChart;
    memberAllocationChart = rendered.memberAllocationChart;
    currentFilteredHistory = rendered.filteredHistory;
    currentTrendStatSeries = rendered.trendSeries;
    updateChartsColors(currentTheme);
  }

  // 加载并渲染美股 ETF ATH 历史及收盘价格回调数据
  async function loadEtfAthData() {
    const container = document.getElementById('etf-ath-cards-container');
    return window.FundEtfPanel.load({
      container,
      api: Api,
      ui: { escapeHtml, formatMonthDay }
    });
  }

  // 轻量级 Toast 弹出式提示
  function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    // 3.5秒后自动淡出销毁
    setTimeout(() => {
      toast.style.animation = 'toastSlideIn 0.3s cubic-bezier(0.4, 0, 0.2, 1) reverse forwards';
      toast.addEventListener('animationend', () => {
        toast.remove();
      });
    }, 3500);
  }
});
