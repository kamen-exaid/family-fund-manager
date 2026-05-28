/**
 * 前端核心应用控制逻辑 (app.js)
 * 升级版：支持美元 (USD - $) 记账及完全动态家庭成员管理 (无上限)
 */

document.addEventListener('DOMContentLoaded', () => {
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

  // 配色方案（支持动态主题：深色模式采用炫彩霓虹，浅色模式采用高对比度典雅宝石色）
  function getThemeColors(isDark) {
    return isDark ? {
      palette: [
        '#00f2fe', // 科技蓝
        '#f43f5e', // 极光红
        '#3b82f6', // 经典蓝
        '#10b981', // 祖母绿
        '#8b5cf6', // 极光紫
        '#f59e0b', // 琥珀黄
        '#ec4899', // 玫瑰粉
        '#06b6d4'  // 浅青绿
      ],
      textPalette: ['#000000', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#000000', '#ffffff', '#ffffff']
    } : {
      palette: [
        '#0284c7', // 科技蓝 -> 深天蓝
        '#e11d48', // 极光红 -> 玫瑰红
        '#2563eb', // 经典蓝 -> 经典深蓝
        '#059669', // 祖母绿 -> 翡翠绿
        '#7c3aed', // 极光紫 -> 皇家紫
        '#d97706', // 琥珀黄 -> 琥珀褐/橙
        '#db2777', // 玫瑰粉 -> 深粉
        '#0891b2'  // 浅青绿 -> 碧青色
      ],
      textPalette: ['#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff']
    };
  }

  // 辅助函数判断是否是暗黑模式（兼容 system）
  function checkIfDark() {
    if (currentTheme === 'dark') return true;
    if (currentTheme === 'light') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  // --- 初始化运行 ---
  initTime();
  initTheme();
  initPrivacy();
  setDefaultDates();
  bindEvents();
  loadAllData();
  loadEtfAthData();
  // 每 5 分钟自动刷新美股 ETF ATH 数据
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
          <input type="text" class="etf-ticker-input" value="${ticker}" placeholder="代码 (如: AAPL)" style="width: 120px; font-weight: 700; text-transform: uppercase;" required>
          <input type="text" class="etf-name-input" value="${name}" placeholder="中文简称 (如: 苹果)" style="flex: 1; min-width: 0;" required>
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
    elTxMember.innerHTML = membersList.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
    if (savedTxVal && membersList.some(m => m.id === savedTxVal)) {
      elTxMember.value = savedTxVal;
    }

    // 1.2. 转让出让方与受让方选择框
    const savedTfFromVal = tfFromMember.value;
    const savedTfToVal = tfToMember.value;
    const membersOptionsHtml = membersList.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
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
      ${membersList.map(m => `<option value="${m.id}">${m.name}</option>`).join('')}
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
    // 渲染成员数量 badge
    elMemberCountBadge.textContent = `成员人数: ${membersList.length} 人`;

    if (membersList.length === 0) {
      elMembersGridContainer.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; color: var(--color-text-muted); padding: 30px; font-size: 0.85rem;">
          ⚠️ 暂无家庭成员。请点击右上角【家庭成员管理】添加出资人。
        </div>
      `;
      return;
    }

    // 动态渲染所有卡片
    elMembersGridContainer.innerHTML = membersList.map((m, idx) => {
      const mState = appState.members[m.id] || {
        currentValue: 0, shares: 0, totalDeposit: 0, totalWithdraw: 0, profitRate: 0,
        cnhCurrentValue: 0, cnhDeposit: 0, cnhWithdraw: 0, cnhProfitRate: 0
      };

      const roiText = (mState.profitRate >= 0 ? '+' : '') + `${mState.profitRate.toFixed(2)}%`;
      const roiClass = mState.profitRate >= 0 ? 'text-green' : 'text-magenta';

      const cnhRoiText = (mState.cnhProfitRate >= 0 ? '+' : '') + `${mState.cnhProfitRate.toFixed(2)}%`;
      const cnhRoiClass = mState.cnhProfitRate >= 0 ? 'text-green' : 'text-magenta';

      const opacityStyle = mState.totalDeposit === 0 ? 'style="opacity: 0.55;"' : '';

      // 生成智能头像文本
      const shortName = getAvatarText(m.name);

      // 分配渐变配色样式
      const isDark = checkIfDark();
      const { palette, textPalette } = getThemeColors(isDark);
      const cardColor = palette[idx % palette.length];
      const cardTextColor = textPalette[idx % textPalette.length];

      return `
        <div class="member-card" ${opacityStyle} style="border-left: 3px solid ${cardColor};">
          <div class="member-avatar" style="background: ${cardColor}; color: ${cardTextColor};">${shortName}</div>
          <div class="member-details">
            <div class="member-header" style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 2px;">
              <span class="member-name" title="${m.name}" style="font-weight: 700; font-size: 0.9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 90px;">${m.name}</span>
              <div style="text-align: right; display: flex; flex-direction: column; align-items: flex-end; line-height: 1.15;">
                <span class="member-roi ${roiClass} privacy-sensitive" style="font-size: 0.85rem; font-weight: 700;" title="美元收益率 (USD ROI)">${roiText} <span style="font-size: 0.65rem; font-weight: 500; opacity: 0.7;">USD</span></span>
                <span class="member-roi ${cnhRoiClass} privacy-sensitive" style="font-size: 0.75rem; font-weight: 600; margin-top: 1px;" title="人民币真实收益率 (CNH ROI)">${cnhRoiText} <span style="font-size: 0.65rem; font-weight: 500; opacity: 0.7;">CNH</span></span>
              </div>
            </div>
            <div class="member-asset font-outfit" style="display: flex; flex-direction: column; line-height: 1.25; margin-bottom: 2px;">
              <span class="privacy-sensitive" style="font-size: 1.15rem; font-weight: 700;">$${formatMoney(mState.currentValue)}</span>
              <span class="privacy-sensitive" style="font-size: 0.72rem; font-weight: 600; color: var(--color-cyan);">≈ ¥${formatCnhWan(mState.cnhCurrentValue)} <span style="font-size: 0.65rem; font-weight: 500; opacity: 0.85;">CNH</span></span>
            </div>
            <div class="member-shares privacy-sensitive" style="font-size: 0.72rem; color: var(--color-text-muted); line-height: 1.2; margin-bottom: 4px;">${mState.shares.toFixed(4)} 份</div>
            
            <div class="member-sub-info" style="display: flex; justify-content: space-between; font-size: 0.68rem; padding-top: 4px; border-top: 1px dashed var(--color-card-divider); color: var(--color-text-muted);">
              <span>入金 <span class="privacy-sensitive">$${formatMoney(mState.totalDeposit)}</span></span>
              <span>出金 <span class="privacy-sensitive">$${formatMoney(mState.totalWithdraw)}</span></span>
            </div>
            <div class="member-sub-info" style="display: flex; justify-content: space-between; font-size: 0.65rem; padding-top: 2px; border-top: none; margin-top: 0; color: var(--color-text-muted); opacity: 0.85;">
              <span>CNH入金 <span class="privacy-sensitive">¥${formatMoney(mState.cnhDeposit)}</span></span>
              <span></span>
            </div>
          </div>
        </div>
      `;
    }).join('');
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
      const shortName = getAvatarText(m.name);

      const isDark = checkIfDark();
      const { palette, textPalette } = getThemeColors(isDark);
      const cardColor = palette[idx % palette.length];
      const cardTextColor = textPalette[idx % textPalette.length];

      // 检查成员是否拥有交易历史
      const hasTx = appState.events.some(e => e.member === m.id);

      return `
        <div class="member-edit-item" id="member-edit-item-${m.id}">
          <div class="member-edit-left">
            <div class="member-edit-avatar" style="background: ${cardColor}; color: ${cardTextColor};">${shortName}</div>
            <span class="member-edit-name" id="member-name-span-${m.id}" title="双击或点击右侧笔头重命名">${m.name}</span>
            <input type="text" class="input-rename" id="member-name-input-${m.id}" value="${m.name}" style="display: none;">
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
            <button class="btn-delete" id="btn-member-del-${m.id}" title="${hasTx ? '已有出资记录，禁止删除' : '移除该成员'}" ${hasTx ? 'disabled style="opacity: 0.25; cursor: not-allowed;"' : ''}>
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
    const mFilter = filterMember.value;
    const tFilter = filterType.value;

    // 清空旧流水
    ledgerTbody.innerHTML = '';

    // 获取按时间从新到旧的事件展示（最新动作排在最上面）
    const displayEvents = [...appState.events].reverse();
    // 同时也需要匹配 _navAtTx 之类的历史计算数据
    const navHistoryMap = {};
    appState.charts.navHistory.forEach(h => {
      navHistoryMap[h.eventId] = h;
    });

    let renderedCount = 0;

    displayEvents.forEach(e => {
      // 成员过滤器过滤条件
      if (mFilter !== 'all') {
        if (mFilter === 'system' && (e.type !== 'valuation')) return;
        if (mFilter !== 'system') {
          if (e.type === 'transfer') {
            if (e.fromMember !== mFilter && e.toMember !== mFilter) return;
          } else {
            if (e.member !== mFilter) return;
          }
        }
      }
      // 流水类型过滤器条件
      if (tFilter !== 'all' && e.type !== tFilter) return;

      const historyNode = navHistoryMap[e.id] || {};

      const tr = document.createElement('tr');

      // 1. 时间单独成列
      const tdDate = document.createElement('td');
      tdDate.className = 'font-outfit';
      tdDate.style.fontSize = '0.78rem';
      tdDate.textContent = e.date;
      tr.appendChild(tdDate);

      // 2. 流水明细列 (第一行交易人/主体，第二行备注并带隐私隐藏)
      const tdDetails = document.createElement('td');
      let detailsHtml = '';
      if (e.type === 'transfer') {
        const fromName = membersList.find(m => m.id === e.fromMember)?.name || '未知成员';
        const toName = membersList.find(m => m.id === e.toMember)?.name || '未知成员';
        detailsHtml = `
          <div style="font-weight:600; color:var(--color-text-main); line-height: 1.25;">
            <span style="color:var(--color-primary);">${fromName}</span>
            <span style="color:var(--color-text-muted); font-weight:700; margin: 0 2px;">⇄</span>
            <span style="color:var(--color-green);">${toName}</span>
          </div>
          <div class="privacy-sensitive" style="color:var(--color-text-muted); font-size:0.72rem; margin-top: 2px; line-height: 1.2;">
            (${e.remark || '内部转让'})
          </div>
        `;
      } else {
        let memberName = '系统';
        if (e.member) {
          memberName = membersList.find(m => m.id === e.member)?.name || '未知成员';
        }
        detailsHtml = `
          <div style="font-weight:600; color:var(--color-text-main); line-height: 1.25;">${memberName}</div>
          <div class="privacy-sensitive" style="color:var(--color-text-muted); font-size:0.72rem; margin-top: 2px; line-height: 1.2;">
            (${e.remark || '无备注'})
          </div>
        `;
      }
      tdDetails.innerHTML = detailsHtml;
      tr.appendChild(tdDetails);

      // 类型徽章 (去掉英文说明)
      const tdType = document.createElement('td');
      let badgeClass = '';
      let badgeText = '';
      if (e.type === 'deposit') { badgeClass = 'badge-deposit'; badgeText = '入金'; }
      else if (e.type === 'withdraw') { badgeClass = 'badge-withdraw'; badgeText = '出金'; }
      else if (e.type === 'transfer') { badgeClass = 'badge-transfer'; badgeText = '转让'; }
      else { badgeClass = 'badge-valuation'; badgeText = '估值'; }
      tdType.innerHTML = `<span class="tx-badge ${badgeClass}">${badgeText}</span>`;
      tr.appendChild(tdType);

      // 出资/估值金额 (USD/CNH 双显示)
      const tdAmount = document.createElement('td');
      if (e.type === 'deposit') {
        const usdText = `+$${formatMoney(e.amount)}`;
        const cnhText = `+¥${formatMoney(e.cnhAmount || e._cnhAmountComputed)}`;
        tdAmount.innerHTML = `
          <div class="amount-double-line">
            <span class="amount-usd privacy-sensitive" style="color:var(--color-green);">${usdText}</span>
            <span class="amount-cnh privacy-sensitive">${cnhText}</span>
          </div>
        `;
      } else if (e.type === 'withdraw') {
        const usdText = `-$${formatMoney(e.amount)}`;
        tdAmount.innerHTML = `
          <div class="amount-double-line">
            <span class="amount-usd privacy-sensitive" style="color:var(--color-magenta);">${usdText}</span>
          </div>
        `;
      } else if (e.type === 'transfer') {
        const usdText = `⇄ $${formatMoney(e.amount)}`;
        const cnhText = `≈ ¥${formatMoney(e.cnhAmount || e._cnhAmountComputed)} (汇率: ${(e.cnhRate || appState.summary.cnhRate || 7.2).toFixed(4)})`;
        tdAmount.innerHTML = `
          <div class="amount-double-line">
            <span class="amount-usd privacy-sensitive" style="color:var(--color-cyan); font-weight:700;">${usdText}</span>
            <span class="amount-cnh privacy-sensitive" style="color:var(--color-text-muted); font-size:0.68rem;">${cnhText}</span>
          </div>
        `;
      } else {
        const usdText = `$${formatMoney(e.totalNAV)}`;
        tdAmount.innerHTML = `
          <div class="amount-double-line">
            <span class="amount-usd privacy-sensitive" style="color:var(--color-purple);">${usdText}</span>
          </div>
        `;
      }
      tr.appendChild(tdAmount);

      // 当时折算单位净值
      const tdNavAtTx = document.createElement('td');
      tdNavAtTx.className = 'font-outfit text-cyan';
      tdNavAtTx.innerHTML = `<span class="privacy-sensitive text-cyan">${(e._navAtTx || 1.0000).toFixed(4)}</span>`;
      tr.appendChild(tdNavAtTx);

      // 结算后份额
      const tdSharesAfter = document.createElement('td');
      tdSharesAfter.className = 'font-outfit';
      tdSharesAfter.innerHTML = `<span class="privacy-sensitive">${(e._totalSharesAfter || 0).toFixed(4)} 份</span>`;
      tr.appendChild(tdSharesAfter);

      // 结算后总市值 (双显示)
      const tdValAfter = document.createElement('td');
      if (e.type === 'deposit') {
        const totalNAVAfterCnh = (e._totalNAVAfter || 0) * (appState.summary.cnhRate || 7.2);
        tdValAfter.innerHTML = `
          <div class="amount-double-line">
            <span class="amount-usd privacy-sensitive">$${formatMoney(e._totalNAVAfter || 0)}</span>
            <span class="amount-cnh privacy-sensitive" style="font-size:0.68rem;">≈ ¥${formatCnhWan(totalNAVAfterCnh)}</span>
          </div>
        `;
      } else {
        tdValAfter.innerHTML = `
          <div class="amount-double-line">
            <span class="amount-usd privacy-sensitive">$${formatMoney(e._totalNAVAfter || 0)}</span>
          </div>
        `;
      }
      tr.appendChild(tdValAfter);

      // 操作按键 (编辑 + 删除)
      const tdAction = document.createElement('td');
      const actionContainer = document.createElement('div');
      actionContainer.className = 'action-btns-flex';

      const btnEdit = document.createElement('button');
      btnEdit.className = 'btn-edit';
      btnEdit.title = '修改此条流水';
      btnEdit.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
        </svg>
      `;
      btnEdit.addEventListener('click', () => handleEditEvent(e));
      actionContainer.appendChild(btnEdit);

      const btnDel = document.createElement('button');
      btnDel.className = 'btn-delete';
      btnDel.title = '删除此条流水并重算';
      btnDel.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          <line x1="10" y1="11" x2="10" y2="17"/>
          <line x1="14" y1="11" x2="14" y2="17"/>
        </svg>
      `;
      btnDel.addEventListener('click', () => handleDeleteEvent(e.id, memberName, e.type, e.amount || e.totalNAV));
      actionContainer.appendChild(btnDel);

      tdAction.appendChild(actionContainer);
      tr.appendChild(tdAction);

      ledgerTbody.appendChild(tr);
      renderedCount++;
    });

    if (renderedCount === 0) {
      const trEmpty = document.createElement('tr');
      trEmpty.className = 'empty-row';
      trEmpty.innerHTML = `
        <td colspan="7" style="text-align: center; color: var(--color-text-muted); padding: 40px 0;">
          未检索到符合过滤条件的交易记录
        </td>
      `;
      ledgerTbody.appendChild(trEmpty);
    }
  }

  // 删除单条交易记录确认与处理
  function handleDeleteEvent(id, name, type, value) {
    const typeLabel = type === 'deposit' ? '入金' : type === 'withdraw' ? '出金' : type === 'transfer' ? '份额转让' : '市值估值';
    const textDesc = `$${formatMoney(value)}`;

    const confirmMsg = type === 'transfer'
      ? `⚠️ 警告：您确定要删除【${name}】的此条【${typeLabel}】记录（金额: ${textDesc}）吗？\n\n删除后，系统会自动撤销该笔划转，重新清零各方的转让本金与份额，并级联重算后面所有的单位净值与个人份额！此操作不可逆。`
      : `⚠️ 警告：您确定要删除成员【${name}】的此条【${typeLabel}】记录（金额: ${textDesc}）吗？\n\n删除后，系统会自动撤销该笔流水，并以绝对公平的逻辑自动重新排序重算后面所有的单位净值与个人份额！此操作不可逆。`;

    if (confirm(confirmMsg)) {
      Api.deleteEvent(id)
        .then(() => {
          showToast('账目记录已删除，系统已完成全额重算！', 'success');
          loadAllData();
        })
        .catch(err => {
          showToast(err.message, 'error');
        });
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

  function calculateTrendStats(values) {
    const cleanValues = values.filter(v => Number.isFinite(v) && v > 0);
    if (cleanValues.length === 0) {
      return { gain: 0, maxDrawdown: 0 };
    }

    const first = cleanValues[0];
    const last = cleanValues[cleanValues.length - 1];
    let peak = first;
    let maxDrawdown = 0;

    cleanValues.forEach(value => {
      peak = Math.max(peak, value);
      const drawdown = value / peak - 1;
      maxDrawdown = Math.min(maxDrawdown, drawdown);
    });

    return {
      gain: last / first - 1,
      maxDrawdown
    };
  }

  function formatSignedPercent(value) {
    const pct = value * 100;
    const sign = pct > 0 ? '+' : '';
    return `${sign}${pct.toFixed(2)}%`;
  }

  function renderTrendStatsCards(seriesList, activeIndex = null) {
    if (!elTrendStatsGrid) return;

    const visibleSeries = seriesList.filter(series => series.visible);
    if (visibleSeries.length === 0) {
      elTrendStatsGrid.innerHTML = '<div class="trend-stat-empty">勾选上方指标后显示区间涨幅与最大回撤</div>';
      return;
    }

    elTrendStatsGrid.innerHTML = visibleSeries.map(series => {
      const hasActivePoint = Number.isInteger(activeIndex) && activeIndex >= 0;
      const endIndex = hasActivePoint ? Math.min(activeIndex, series.values.length - 1) : series.values.length - 1;
      const statsValues = series.values.slice(0, endIndex + 1);
      const stats = calculateTrendStats(statsValues);
      const gainClass = stats.gain >= 0 ? 'positive' : 'negative';
      const dateLabel = hasActivePoint && series.dates?.[endIndex]
        ? `<div class="trend-stat-date">截至 ${series.dates[endIndex]}</div>`
        : '';
      return `
        <div class="trend-stat-card" style="--series-color: ${series.color};">
          <div class="trend-stat-name">${series.label}</div>
          ${dateLabel}
          <div class="trend-stat-values">
            <span><em>涨幅</em><strong class="${gainClass}">${formatSignedPercent(stats.gain)}</strong></span>
            <span><em>最大回撤</em><strong class="negative">${formatSignedPercent(stats.maxDrawdown)}</strong></span>
          </div>
        </div>
      `;
    }).join('');
  }

  // 5. 图表可视化绘制模块 (USD/动态成员自适应)
  function renderCharts() {
    if (!appState) return;

    // A. 净值与资产走势图 (NAV Trend Line Chart)
    const navHistory = appState.charts.navHistory;

    // 计算时间区间过滤条件
    const now = new Date();
    let cutoffStr = '';
    if (activeTimeSlice === 'YTD') {
      cutoffStr = `${now.getFullYear()}-01-01`;
    } else if (activeTimeSlice === '1Y') {
      const d = new Date();
      d.setFullYear(now.getFullYear() - 1);
      cutoffStr = d.toISOString().split('T')[0];
    } else if (activeTimeSlice === '6M') {
      const d = new Date();
      d.setMonth(now.getMonth() - 6);
      cutoffStr = d.toISOString().split('T')[0];
    } else if (activeTimeSlice === '3M') {
      const d = new Date();
      d.setMonth(now.getMonth() - 3);
      cutoffStr = d.toISOString().split('T')[0];
    } else if (activeTimeSlice === '1M') {
      const d = new Date();
      d.setMonth(now.getMonth() - 1);
      cutoffStr = d.toISOString().split('T')[0];
    }

    let filteredHistory = navHistory;
    if (activeTimeSlice !== 'ALL' && cutoffStr) {
      filteredHistory = navHistory.filter(h => h.date >= cutoffStr);
    }

    // 如果区间过滤后为空，回退到最后一个数据点
    if (filteredHistory.length === 0 && navHistory.length > 0) {
      filteredHistory = [navHistory[navHistory.length - 1]];
    }

    currentFilteredHistory = filteredHistory;

    // 重新对齐基点：区间开始处的净值及指数均重置为 1.0000 
    const baseItem = filteredHistory[0] || { navPerShare: 1.0000, sp500NAV: 1.0000, ndxNAV: 1.0000 };
    const baseNav = baseItem.navPerShare || 1.0000;
    const baseSpx = baseItem.sp500NAV || 1.0000;
    const baseNdx = baseItem.ndxNAV || 1.0000;

    const labels = filteredHistory.map(h => h.date);
    const navData = filteredHistory.map(h => parseFloat(((h.navPerShare / baseNav) * 1.0000).toFixed(4)));
    const totalNAVData = filteredHistory.map(h => h.totalNAV);
    const sp500Data = filteredHistory.map(h => parseFloat(((h.sp500NAV / baseSpx) * 1.0000).toFixed(4)));
    const ndxData = filteredHistory.map(h => parseFloat(((h.ndxNAV / baseNdx) * 1.0000).toFixed(4)));

    const chartLabels = labels.length > 0 ? labels : ['尚未入金'];
    const chartNavData = navData.length > 0 ? navData : [1.0000];
    const chartTotalNAVData = totalNAVData.length > 0 ? totalNAVData : [0.00];
    const chartSpxData = sp500Data.length > 0 ? sp500Data : [1.0000];
    const chartNdxData = ndxData.length > 0 ? ndxData : [1.0000];

    currentTrendStatSeries = [
      {
        label: '单位净值',
        color: '#00f2fe',
        values: chartNavData,
        dates: chartLabels,
        visible: chkCompNav.checked
      },
      {
        label: '标普500指数',
        color: '#f59e0b',
        values: chartSpxData,
        dates: chartLabels,
        visible: chkCompSp500.checked
      },
      {
        label: '纳斯达克100指数',
        color: '#ec4899',
        values: chartNdxData,
        dates: chartLabels,
        visible: chkCompNdx.checked
      }
    ];
    renderTrendStatsCards(currentTrendStatSeries);

    // 对数坐标功能已移除

    const ctxNav = document.getElementById('navTrendChart').getContext('2d');

    if (navTrendChart) {
      navTrendChart.data.labels = chartLabels;
      navTrendChart.data.datasets[0].data = chartTotalNAVData;
      navTrendChart.data.datasets[1].data = chartNavData;
      navTrendChart.data.datasets[2].data = chartSpxData;
      navTrendChart.data.datasets[3].data = chartNdxData;

      // 切换 Dataset 隐藏/显示状态
      navTrendChart.setDatasetVisibility(0, chkCompAssets.checked);
      navTrendChart.setDatasetVisibility(1, chkCompNav.checked);
      navTrendChart.setDatasetVisibility(2, chkCompSp500.checked);
      navTrendChart.setDatasetVisibility(3, chkCompNdx.checked);

      // 设置为普通线性坐标
      navTrendChart.options.scales['y-nav'].type = 'linear';
      navTrendChart.options.scales['y-nav'].min = undefined;
      navTrendChart.options.scales['y-assets'].type = 'linear';
      navTrendChart.options.scales['y-assets'].min = undefined;

      // 动态显示/隐藏右侧 Y 轴
      navTrendChart.options.scales['y-assets'].display = chkCompAssets.checked;
    } else {
      navTrendChart = new Chart(ctxNav, {
        type: 'line',
        data: {
          labels: chartLabels,
          datasets: [
            {
              label: '基金总资产',
              data: chartTotalNAVData,
              borderColor: '#8b5cf6',
              borderWidth: 2,
              backgroundColor: 'transparent',
              borderDash: [5, 5],
              fill: false,
              tension: 0.35,
              yAxisID: 'y-assets',
              pointBackgroundColor: '#8b5cf6',
              pointBorderColor: 'transparent',
              pointHoverRadius: 5,
              hidden: !chkCompAssets.checked
            },
            {
              label: '单位净值',
              data: chartNavData,
              borderColor: '#00f2fe',
              borderWidth: 3,
              backgroundColor: createChartGradient(ctxNav, 'rgba(0, 242, 254, 0.15)', 'rgba(0, 242, 254, 0.0)'),
              fill: true,
              tension: 0.35,
              yAxisID: 'y-nav',
              pointBackgroundColor: '#00f2fe',
              pointBorderColor: 'transparent',
              pointHoverRadius: 6,
              hidden: !chkCompNav.checked
            },
            {
              label: '标普500指数',
              data: chartSpxData,
              borderColor: '#f59e0b',
              borderWidth: 1.5,
              backgroundColor: 'transparent',
              borderDash: [4, 4],
              fill: false,
              tension: 0.35,
              yAxisID: 'y-nav',
              pointBackgroundColor: '#f59e0b',
              pointBorderColor: 'transparent',
              pointHoverRadius: 4,
              hidden: !chkCompSp500.checked
            },
            {
              label: '纳斯达克100指数',
              data: chartNdxData,
              borderColor: '#ec4899',
              borderWidth: 1.5,
              backgroundColor: 'transparent',
              borderDash: [4, 4],
              fill: false,
              tension: 0.35,
              yAxisID: 'y-nav',
              pointBackgroundColor: '#ec4899',
              pointBorderColor: 'transparent',
              pointHoverRadius: 4,
              hidden: !chkCompNdx.checked
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: {
            mode: 'index',
            intersect: false
          },
          onHover: (_event, activeElements) => {
            if (activeElements.length > 0) {
              isTrendStatsHovering = true;
              renderTrendStatsCards(currentTrendStatSeries, activeElements[0].index);
            } else {
              isTrendStatsHovering = false;
              renderTrendStatsCards(currentTrendStatSeries);
            }
          },
          plugins: {
            legend: {
              labels: {
                color: 'rgba(255, 255, 255, 0.7)',
                font: { size: 11, weight: '500' }
              }
            },
            tooltip: {
              mode: 'index',
              intersect: false,
              backgroundColor: 'rgba(15, 17, 26, 0.95)',
              titleColor: '#fff',
              bodyColor: 'rgba(255, 255, 255, 0.8)',
              borderColor: 'rgba(255, 255, 255, 0.1)',
              borderWidth: 1,
              padding: 10,
              displayColors: true,
              callbacks: {
                label: function (context) {
                  let label = context.dataset.label || '';
                  if (label) label += ': ';
                  if (context.datasetIndex === 0) {
                    label += '$' + formatMoney(context.parsed.y);
                  } else {
                    label += context.parsed.y.toFixed(3);
                  }
                  return label;
                },
                afterBody: function (context) {
                  if (!context || context.length === 0) return [];
                  const index = context[0].dataIndex;
                  const h = currentFilteredHistory[index];
                  if (!h || !h.type || h.type === 'valuation') return [];

                  const lines = [];
                  lines.push('---------------------');
                  if (h.type === 'deposit') {
                    const mName = membersList.find(m => m.id === h.member)?.name || '未知';
                    lines.push(`入金详情：`);
                    lines.push(`   出资人: ${mName}`);
                    lines.push(`   金额: $${formatMoney(h.amount)}`);
                    if (h.cnhAmount) {
                      lines.push(`   折合人民币: ¥${formatMoney(h.cnhAmount)}`);
                    }
                  } else if (h.type === 'withdraw') {
                    const mName = membersList.find(m => m.id === h.member)?.name || '未知';
                    lines.push(`出金详情：`);
                    lines.push(`   提取人: ${mName}`);
                    lines.push(`   金额: $${formatMoney(h.amount)}`);
                  } else if (h.type === 'transfer') {
                    const fromName = membersList.find(m => m.id === h.fromMember)?.name || '未知';
                    const toName = membersList.find(m => m.id === h.toMember)?.name || '未知';
                    lines.push(`转让详情：`);
                    lines.push(`   从: ${fromName} 至: ${toName}`);
                    lines.push(`   金额: $${formatMoney(h.amount)}`);
                    if (h.cnhRate) {
                      lines.push(`   受让汇率: ${h.cnhRate.toFixed(4)}`);
                    }
                  }
                  if (h.remark) {
                    lines.push(`   备注: ${h.remark}`);
                  }
                  return lines;
                }
              }
            }
          },
          scales: {
            x: {
              grid: { color: 'rgba(255, 255, 255, 0.03)', drawTicks: false },
              ticks: { color: 'rgba(255, 255, 255, 0.4)', font: { size: 10 } }
            },
            'y-nav': {
              type: 'linear',
              position: 'left',
              grid: { color: 'rgba(255, 255, 255, 0.03)', drawTicks: false },
              ticks: {
                color: 'rgba(0, 242, 254, 0.6)',
                font: { size: 10 },
                callback: value => value.toFixed(3)
              },
              title: { display: true, text: '单位净值', color: 'rgba(0, 242, 254, 0.6)', font: { size: 10 } }
            },
            'y-assets': {
              type: 'linear',
              position: 'right',
              grid: { drawOnChartArea: false },
              ticks: {
                color: 'rgba(139, 92, 246, 0.6)',
                font: { size: 10 },
                callback: value => '$' + formatMoney(value)
              },
              title: { display: true, text: '总资产 (USD)', color: 'rgba(139, 92, 246, 0.6)', font: { size: 10 } },
              display: chkCompAssets.checked
            }
          }
        }
      });
    }

    if (!ctxNav.canvas.dataset.trendStatsLeaveBound) {
      const restoreTrendStats = () => {
        isTrendStatsHovering = false;
        renderTrendStatsCards(currentTrendStatSeries);
      };
      const restoreTrendStatsWhenOutside = (event) => {
        if (!isTrendStatsHovering) return;
        const rect = ctxNav.canvas.getBoundingClientRect();
        const isInsideChart = event.clientX >= rect.left
          && event.clientX <= rect.right
          && event.clientY >= rect.top
          && event.clientY <= rect.bottom;
        if (!isInsideChart) restoreTrendStats();
      };
      ctxNav.canvas.addEventListener('mouseleave', restoreTrendStats);
      ctxNav.canvas.addEventListener('mouseout', restoreTrendStats);
      ctxNav.canvas.addEventListener('pointerleave', restoreTrendStats);
      document.addEventListener('mousemove', restoreTrendStatsWhenOutside);
      ctxNav.canvas.dataset.trendStatsLeaveBound = 'true';
    }

    // B. 成员占比图 (Member Donut Chart - 动态成员支持)
    let totalAssetsCombined = 0;
    const doughnutData = [];
    const doughnutLabels = [];
    const doughnutColors = [];

    const isDarkTheme = checkIfDark();
    const { palette: currentPalette } = getThemeColors(isDarkTheme);

    membersList.forEach((m, idx) => {
      const val = appState.members[m.id]?.currentValue || 0;
      doughnutLabels.push(m.name);
      doughnutData.push(val);
      doughnutColors.push(currentPalette[idx % currentPalette.length]);
      totalAssetsCombined += val;
    });

    const isZero = totalAssetsCombined === 0;

    // 如果全为0，用均匀分配画灰色背景做示意，或直接画一个虚设的图
    const finalData = isZero ? membersList.map(() => 1) : doughnutData;
    const zeroColor = isDarkTheme ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)';
    const finalColors = isZero ? membersList.map(() => zeroColor) : doughnutColors;

    const ctxShares = document.getElementById('memberAllocationChart').getContext('2d');

    if (memberAllocationChart) {
      memberAllocationChart.data.labels = doughnutLabels;
      memberAllocationChart.data.datasets[0].data = finalData;
      memberAllocationChart.data.datasets[0].backgroundColor = finalColors;
      memberAllocationChart.update();
    } else {
      memberAllocationChart = new Chart(ctxShares, {
        type: 'doughnut',
        data: {
          labels: doughnutLabels,
          datasets: [{
            data: finalData,
            backgroundColor: finalColors,
            borderColor: '#0f111a',
            borderWidth: 3,
            hoverOffset: 10
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '70%',
          plugins: {
            legend: {
              position: 'right',
              labels: {
                color: 'rgba(255, 255, 255, 0.7)',
                font: { size: 11, weight: '500' },
                padding: 12
              }
            },
            tooltip: {
              backgroundColor: 'rgba(15, 17, 26, 0.95)',
              titleColor: '#fff',
              bodyColor: 'rgba(255, 255, 255, 0.8)',
              borderColor: 'rgba(255, 255, 255, 0.1)',
              borderWidth: 1,
              padding: 10,
              callbacks: {
                label: function (context) {
                  if (isZero) return ' 暂无出资占比';
                  const val = doughnutData[context.dataIndex];
                  const pct = ((val / totalAssetsCombined) * 100).toFixed(2);
                  return ` 资产价值: $${formatMoney(val)} (${pct}%)`;
                }
              }
            }
          }
        }
      });
    }

    // 动态同步最新图表配色
    updateChartsColors(currentTheme);
  }

  // --- 工具辅助函数 ---

  // 获取头像显示的文本（智能裁切：2字及以下全名，3字及以上中文取后两位，英文取前两位）
  function getAvatarText(name) {
    if (!name) return '';
    if (name.length <= 2) return name;
    const isChinese = /^[\u4e00-\u9fa5]+$/.test(name);
    if (isChinese) {
      return name.substring(name.length - 2);
    }
    return name.substring(0, 2).toUpperCase();
  }

  // 极简日期格式化工具 (YYYY-MM-DD -> MM/DD)
  function formatMonthDay(dateStr) {
    if (!dateStr) return '';
    const parts = dateStr.split('-');
    if (parts.length === 3) {
      return `${parts[1]}/${parts[2]}`;
    }
    return dateStr;
  }

  // 加载并渲染美股 ETF ATH 历史及收盘价格回调数据
  async function loadEtfAthData() {
    const container = document.getElementById('etf-ath-cards-container');
    if (!container) return;

    try {
      const data = await Api.getEtfAth();
      
      const html = Object.keys(data).map(ticker => {
        const item = data[ticker];
        if (item.error) {
          return `
            <div class="etf-ath-card error">
              <span class="etf-ticker font-outfit">${ticker}</span>
              <span class="error-msg">获取失败</span>
            </div>
          `;
        }
        
        const drawdownClass = item.drawdown >= 0 ? 'text-green' : 'text-magenta';
        const drawdownPrefix = item.drawdown > 0 ? '+' : '';
        
        return `
          <div class="etf-ath-card premium-border" title="${item.longName}">
            <div class="etf-card-header">
              <span class="etf-ticker font-outfit">${ticker}</span>
              <span class="etf-name" title="${item.name || ticker}">${item.name || ticker}</span>
            </div>
            <div class="etf-card-body">
              <div class="etf-prices-col">
                <div class="price-row">
                  <span class="price-lbl">ATH</span>
                  <span class="price-val text-cyan font-outfit">$${item.ath.toFixed(2)}</span>
                  <span class="price-date">(${formatMonthDay(item.athDate)})</span>
                </div>
                <div class="price-row" style="margin-top: 1px;">
                  <span class="price-lbl">收盘</span>
                  <span class="price-val font-outfit" style="color: var(--color-text-main);">$${item.regularClose.toFixed(2)}</span>
                  <span class="price-date">(${formatMonthDay(item.regularCloseDate)})</span>
                </div>
              </div>
              <div class="etf-drawdown-col ${drawdownClass}">
                <span class="drawdown-lbl">较ATH回调</span>
                <span class="drawdown-val font-outfit">${drawdownPrefix}${item.drawdown.toFixed(2)}%</span>
              </div>
            </div>
          </div>
        `;
      }).join('');
      
      container.innerHTML = html;
    } catch (err) {
      container.innerHTML = `
        <div class="etf-ath-card error-bar" style="width: 100%; text-align: center;">
          <span class="error-msg">❌ 无法从服务器同步美股 ETF ATH 历史数据: ${err.message}</span>
        </div>
      `;
    }
  }

  // 格式化金额 (支持千分位英文 locale 格式化，2位小数)
  function formatMoney(amount) {
    if (amount === undefined || amount === null) return '0.00';
    return Number(amount).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  // 格式化约数人民币 (万)
  function formatCnhWan(amount) {
    if (amount === undefined || amount === null || isNaN(amount)) return '0.00万';
    const wan = amount / 10000;
    return wan.toFixed(2) + '万';
  }

  // 渐变背景生成器
  function createChartGradient(ctx, colorStart, colorEnd) {
    const gradient = ctx.createLinearGradient(0, 0, 0, 250);
    gradient.addColorStop(0, colorStart);
    gradient.addColorStop(1, colorEnd);
    return gradient;
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
