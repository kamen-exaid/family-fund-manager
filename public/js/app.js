/**
 * 前端核心应用控制逻辑 (app.js)
 * 升级版：支持美元 (USD - $) 记账及完全动态家庭成员管理 (无上限)
 */

document.addEventListener('DOMContentLoaded', () => {
  const welcomeMessages = [
    'Hello, Investor',
    'Welcome Back, Investor',
    'Good to See You',
    'Ready for Today?',
    'Your Portfolio Awaits',
    'Nice to Have You Back',
    'A Fresh View, Investor'
  ];
  const welcomeMessage = document.getElementById('welcome-message');
  let previousWelcome = null;
  try {
    previousWelcome = sessionStorage.getItem('lastWelcomeMessage');
  } catch (_error) {
    // The greeting can still rotate when browser storage is unavailable.
  }
  const availableWelcomeMessages = welcomeMessages.filter(message => message !== previousWelcome);
  const nextWelcome = availableWelcomeMessages[Math.floor(Math.random() * availableWelcomeMessages.length)];

  if (welcomeMessage && nextWelcome) {
    welcomeMessage.textContent = nextWelcome;
    try {
      sessionStorage.setItem('lastWelcomeMessage', nextWelcome);
    } catch (_error) {
      // Keep the selected greeting without persisting it.
    }
  }

  const {
    getThemeColors,
    isDarkTheme,
    getAvatarText,
    getMemberAvatarColor,
    formatMonthDay,
    escapeHtml,
    formatMoney,
    formatCnhWan,
    createChartGradient,
    getSeriesColors,
    hexToRgba
  } = window.FundUiUtils;

  // --- 全局状态 ---
  let appState = null;
  let membersList = [];
  let activeMemberView = 'assets';
  let activeTimeSlice = 'ALL';
  let activeScaleType = 'linear'; // 'linear' or 'logarithmic'
  let navTrendChart = null;
  let memberAllocationChart = null;
  let currentTheme = 'system';
  let currentFilteredHistory = [];
  let currentTrendStatSeries = [];
  let renderTrendStats = null;
  let isTrendStatsHovering = false;
  let isPrivacyMode = true; // 默认开启隐私遮罩，用户可按需查看数据
  let tickerSortable = null;
  let operationPanelResizeAnimation = null;
  let operationPanelResizeCleanupTimer = null;
  let benchmarkRefreshToken = 0;

  const modalTriggers = new WeakMap();

  function getModalFocusableElements(modal) {
    return [...modal.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]):not(.custom-select__native), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter(element => element.offsetParent !== null);
  }

  function openModal(modal, trigger = document.activeElement) {
    if (!modal) return;
    modalTriggers.set(modal, trigger);
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    document.documentElement.classList.add('modal-open');
    document.body.classList.add('modal-open');
    requestAnimationFrame(() => (getModalFocusableElements(modal)[0] || modal.querySelector('.modal-content'))?.focus());
  }

  function closeModal(modal) {
    if (!modal || !modal.classList.contains('active')) return;
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    if (!document.querySelector('.modal-overlay.active')) {
      document.documentElement.classList.remove('modal-open');
      document.body.classList.remove('modal-open');
    }
    modalTriggers.get(modal)?.focus?.();
  }

  function bindAccessibleModal(modal, closeButton) {
    if (!modal) return;
    closeButton?.addEventListener('click', () => closeModal(modal));
    modal.addEventListener('click', event => {
      if (event.target === modal) closeModal(modal);
    });
    modal.addEventListener('keydown', event => {
      if (!modal.classList.contains('active')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeModal(modal);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = getModalFocusableElements(modal);
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  function beginSubmission(form) {
    if (form.dataset.submitting === 'true') return null;
    form.dataset.submitting = 'true';
    form.setAttribute('aria-busy', 'true');
    const buttons = [...form.querySelectorAll('button[type="submit"]')]
      .map(button => ({ button, disabled: button.disabled }));
    buttons.forEach(({ button }) => { button.disabled = true; });
    return () => {
      delete form.dataset.submitting;
      form.removeAttribute('aria-busy');
      buttons.forEach(({ button, disabled }) => { button.disabled = disabled; });
    };
  }

  async function submitOnce(form, task) {
    const finishSubmission = beginSubmission(form);
    if (!finishSubmission) return;
    try {
      await task();
    } finally {
      finishSubmission();
    }
  }

  // --- DOM 元素定义 ---
  const elSystemTime = document.getElementById('system-time');
  const themeBtns = document.querySelectorAll('[data-theme-btn]');
  const themeSelectorGroup = document.querySelector('.theme-selector-group');
  const memberViewTabs = document.querySelector('.tab-buttons');
  const btnPrivacyToggle = document.getElementById('btn-privacy-toggle');

  // Dashboard Metrics
  const elFundTotalNav = document.getElementById('fund-total-nav');
  const elFundTotalShares = document.getElementById('fund-total-shares');
  const elFundNavPerShare = document.getElementById('fund-nav-per-share');
  const elNavIndicator = document.getElementById('nav-indicator');
  const elFundProfitRate = document.getElementById('fund-profit-rate');
  const elFundProfitRateSub = document.getElementById('fund-profit-rate-sub');

  // The overview is deliberately terse: one aligned title, one key figure, one supporting fact.
  document.querySelectorAll('.metric-label').forEach((label, index) => {
    label.textContent = ['总资产', '单位净值', '累计收益率'][index] || label.textContent;
  });

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
  const benchmarkPolicyGroup = document.getElementById('benchmark-policy-group');
  const benchmarkPolicyButtons = [...document.querySelectorAll('[data-benchmark-policy]')];

  // Operation Tabs & Forms
  const btnTabTx = document.getElementById('tab-btn-tx');
  const btnTabVal = document.getElementById('tab-btn-val');
  const btnTabTf = document.getElementById('tab-btn-tf');
  const operationTabs = document.querySelector('.operation-tabs');
  const operationPanel = document.querySelector('.operations-panel');
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

  // Ticker Config Modal
  const btnConfigTickers = document.getElementById('btn-config-tickers');
  const btnRefreshTickers = document.getElementById('btn-refresh-tickers');
  const tickerConfigModal = document.getElementById('ticker-config-modal');
  const btnCloseTickerConfigModal = document.getElementById('btn-close-ticker-config-modal');
  const tickerConfigList = document.getElementById('ticker-config-list');
  const btnAddTickerRow = document.getElementById('btn-add-ticker-row');
  const btnSaveTickerConfig = document.getElementById('btn-save-ticker-config');

  function setSegmentIndicator(group, button) {
    if (!group || !button) return;
    group.style.setProperty('--active-left', `${button.offsetLeft}px`);
    group.style.setProperty('--active-width', `${button.offsetWidth}px`);
  }

  function activateSegmentOption(group, button) {
    if (!group || !button) return;
    group.querySelectorAll('.segmented-control__button').forEach(option => {
      option.classList.toggle('active', option === button);
      option.setAttribute('aria-pressed', option === button ? 'true' : 'false');
    });
    setSegmentIndicator(group, button);
  }

  function syncBenchmarkPolicyControl(policy = 'previous') {
    const activeButton = benchmarkPolicyButtons.find(button => button.dataset.benchmarkPolicy === policy)
      || benchmarkPolicyButtons[0];
    activateSegmentOption(benchmarkPolicyGroup, activeButton);
  }

  async function waitForBenchmarkRefresh(policy, token) {
    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise(resolve => window.setTimeout(resolve, 1000));
      if (token !== benchmarkRefreshToken) return false;
      let nextState;
      try {
        nextState = await Api.getState();
      } catch (_error) {
        continue;
      }
      if (nextState.settings?.benchmarkClosePolicy !== policy) continue;
      if (!nextState.settings?.benchmarkCacheReady) continue;
      appState = nextState;
      renderCharts();
      return true;
    }
    return false;
  }

  function syncSegmentIndicators() {
    document.querySelectorAll('.segmented-control').forEach(group => {
      setSegmentIndicator(group, group.querySelector('.segmented-control__button.active'));
    });
  }

  function switchOperationView(activeButton, activeForm, onActivate) {
    if (!operationPanel || !activeButton || !activeForm) return;
    if (activeButton.classList.contains('active') && activeForm.classList.contains('active')) return;

    const currentHeight = operationPanel.getBoundingClientRect().height;
    const interruptedAnimation = operationPanelResizeAnimation;
    operationPanelResizeAnimation = null;
    interruptedAnimation?.cancel();
    window.clearTimeout(operationPanelResizeCleanupTimer);
    operationPanelResizeCleanupTimer = null;
    operationPanel.style.removeProperty('height');
    operationPanel.style.removeProperty('overflow');

    activateSegmentOption(operationTabs, activeButton);
    [formTransaction, formValuation, formTransfer].forEach(form => {
      form.classList.toggle('active', form === activeForm);
    });
    onActivate?.();

    const targetHeight = operationPanel.getBoundingClientRect().height;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) return;

    activeForm.animate(
      [
        { opacity: 0, transform: 'translateY(8px) scale(0.985)' },
        { opacity: 1, transform: 'translateY(0) scale(1)' }
      ],
      {
        duration: 340,
        easing: 'cubic-bezier(0.32, 0.72, 0, 1)'
      }
    );

    if (Math.abs(targetHeight - currentHeight) < 1) return;

    operationPanel.style.height = `${targetHeight}px`;
    operationPanel.style.overflow = 'clip';
    operationPanelResizeAnimation = operationPanel.animate(
      [
        { height: `${currentHeight}px` },
        { height: `${targetHeight}px` }
      ],
      {
        duration: 420,
        easing: 'cubic-bezier(0.32, 0.72, 0, 1)'
      }
    );

    const runningAnimation = operationPanelResizeAnimation;
    const releaseOperationPanelSize = () => {
      if (operationPanelResizeAnimation !== runningAnimation) return;
      operationPanelResizeAnimation = null;
      window.clearTimeout(operationPanelResizeCleanupTimer);
      operationPanelResizeCleanupTimer = null;
      operationPanel.style.removeProperty('height');
      operationPanel.style.removeProperty('overflow');
    };

    runningAnimation.finished.then(releaseOperationPanelSize).catch(() => {});
    operationPanelResizeCleanupTimer = window.setTimeout(releaseOperationPanelSize, 520);

  }

  // Keep operations and market tracking in one right-side flex column so their gap is structural.
  const rightColumn = document.querySelector('.layout-right');
  const tickerAthPanel = document.getElementById('ticker-ath-container');
  if (rightColumn && tickerAthPanel) rightColumn.appendChild(tickerAthPanel);

  // 辅助函数判断是否是暗黑模式（兼容 system）
  function checkIfDark() {
    return isDarkTheme(currentTheme);
  }

  // --- 初始化运行 ---
  initTime();
  initTheme();
  initPrivacy();
  setDefaultDates();
  window.FundCustomSelect?.init();
  bindEvents();
  loadAllData();
  loadTickerAthData();
  setInterval(loadTickerAthData, 5 * 60 * 1000);

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
    const openMembersPanel = () => {
      renderMembersEditorList();
      openModal(memberModal);
    };
    const openBackupPanel = () => openModal(backupModal);

    bindAccessibleModal(backupModal, btnCloseModal);
    bindAccessibleModal(memberModal, btnCloseMemberModal);
    bindAccessibleModal(editEventModal, btnCloseEditModal);
    bindAccessibleModal(tickerConfigModal, btnCloseTickerConfigModal);
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      const activeModals = [...document.querySelectorAll('.modal-overlay.active')];
      const topmostModal = activeModals.at(-1);
      if (!topmostModal) return;
      event.preventDefault();
      closeModal(topmostModal);
    });

    document.querySelectorAll('[data-sidebar-action]').forEach((button) => {
      button.addEventListener('click', () => {
        const action = button.dataset.sidebarAction;
        if (action === 'members') openMembersPanel();
        if (action === 'backup') openBackupPanel();
      });
    });

    // 家庭成员面板内切换资产卡片与资产占比图。
    const memberViewsStage = document.querySelector('.member-views-stage');
    const memberAllocationSummary = document.querySelector('.member-allocation-summary');
    document.querySelectorAll('[data-member-view]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const nextMemberView = e.currentTarget.dataset.memberView;
        if (nextMemberView === activeMemberView) return;

        // 先锁定当前高度，再将高度补间到目标视图，避免面板瞬间跳动。
        const currentHeight = memberViewsStage?.offsetHeight || 0;
        if (memberViewsStage) memberViewsStage.style.height = `${currentHeight}px`;
        activeMemberView = nextMemberView;
        activateSegmentOption(memberViewTabs, e.currentTarget);
        elMembersGridContainer.classList.toggle('active', activeMemberView === 'assets');
        memberAllocationSummary?.classList.toggle('active', activeMemberView === 'allocation');

        const targetHeight = memberViewsStage?.scrollHeight || currentHeight;
        requestAnimationFrame(() => {
          if (memberViewsStage) memberViewsStage.style.height = `${targetHeight}px`;
          if (activeMemberView === 'allocation') memberAllocationChart?.resize();
        });
        setTimeout(() => {
          if (memberViewsStage) memberViewsStage.style.height = '';
        }, 280);
      });
    });

    const navigationLinks = [...document.querySelectorAll('.sidebar-nav a[href^="#"]')];
    const navigationSections = navigationLinks
      .map(link => ({ link, section: document.querySelector(link.hash) }))
      .filter(({ section }) => section);
    let navigationFrame = null;
    let navigationTargetId = null;
    let navigationSettleTimer = null;

    const setActiveNavigation = (sectionId) => {
      navigationLinks.forEach(link => {
        const isActive = link.hash === `#${sectionId}`;
        link.classList.toggle('active', isActive);
        if (isActive) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      });
      const activeLink = navigationLinks.find(link => link.hash === `#${sectionId}`);
      const navigation = activeLink?.closest('.sidebar-nav');
      if (navigation && activeLink) {
        navigation.style.setProperty('--active-top', `${activeLink.offsetTop}px`);
        navigation.style.setProperty('--active-height', `${activeLink.offsetHeight}px`);
      }
    };

    const syncNavigationWithScroll = () => {
      navigationFrame = null;
      if (navigationTargetId) {
        setActiveNavigation(navigationTargetId);
        return;
      }
      if (window.scrollY <= 8) {
        setActiveNavigation('dashboard-home');
        return;
      }

      const activationLine = Math.min(140, Math.max(80, window.innerHeight * 0.16));
      const sectionsByPosition = navigationSections
        .map(item => ({ ...item, rect: item.section.getBoundingClientRect() }))
        .sort((a, b) => a.rect.top - b.rect.top);
      let active = sectionsByPosition[0];

      sectionsByPosition.forEach(item => {
        if (item.rect.top <= activationLine) active = item;
      });

      if (active) setActiveNavigation(active.section.id);
    };

    navigationLinks.forEach(link => {
      link.addEventListener('click', event => {
        event.preventDefault();
        navigationTargetId = link.hash.slice(1);
        setActiveNavigation(navigationTargetId);
        const targetSection = document.getElementById(navigationTargetId);
        if (targetSection) {
          const sidebarTop = document.querySelector('.app-sidebar')?.getBoundingClientRect().top ?? 20;
          const targetTop = window.scrollY + targetSection.getBoundingClientRect().top - sidebarTop;
          const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          window.scrollTo({ top: Math.max(0, targetTop), behavior: reduceMotion ? 'auto' : 'smooth' });
          history.replaceState(null, '', link.hash);
        }
        window.clearTimeout(navigationSettleTimer);
        navigationSettleTimer = window.setTimeout(() => {
          navigationTargetId = null;
          syncNavigationWithScroll();
        }, 800);
      });
    });
    window.addEventListener('scroll', () => {
      if (!navigationFrame) navigationFrame = requestAnimationFrame(syncNavigationWithScroll);
      if (navigationTargetId) {
        window.clearTimeout(navigationSettleTimer);
        navigationSettleTimer = window.setTimeout(() => {
          navigationTargetId = null;
          syncNavigationWithScroll();
        }, 160);
      }
    }, { passive: true });
    window.addEventListener('resize', syncNavigationWithScroll);
    syncNavigationWithScroll();
    requestAnimationFrame(syncSegmentIndicators);
    window.addEventListener('resize', syncSegmentIndicators);

    benchmarkPolicyButtons.forEach(button => {
      button.addEventListener('click', async event => {
        const selectedButton = event.currentTarget;
        const nextPolicy = selectedButton.dataset.benchmarkPolicy;
        const previousPolicy = appState?.settings?.benchmarkClosePolicy || 'previous';
        if (nextPolicy === previousPolicy) return;

        const token = ++benchmarkRefreshToken;
        benchmarkPolicyGroup?.setAttribute('aria-busy', 'true');
        benchmarkPolicyButtons.forEach(option => { option.disabled = true; });
        activateSegmentOption(benchmarkPolicyGroup, selectedButton);

        try {
          await Api.updateSettings({ benchmarkClosePolicy: nextPolicy });
          if (appState?.settings) {
            appState.settings.benchmarkClosePolicy = nextPolicy;
            appState.settings.benchmarkCacheReady = false;
          }
          const refreshed = await waitForBenchmarkRefresh(nextPolicy, token);
          showToast(
            refreshed ? '指数收盘口径已更新' : '口径已保存，指数数据仍在后台刷新',
            refreshed ? 'success' : 'warning'
          );
        } catch (error) {
          syncBenchmarkPolicyControl(previousPolicy);
          showToast('指数口径更新失败：' + error.message, 'error');
        } finally {
          if (token === benchmarkRefreshToken) {
            benchmarkPolicyGroup?.removeAttribute('aria-busy');
            benchmarkPolicyButtons.forEach(option => { option.disabled = false; });
          }
        }
      });
    });

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
      switchOperationView(btnTabTx, formTransaction);
    });

    btnTabVal.addEventListener('click', () => {
      switchOperationView(btnTabVal, formValuation);
    });

    btnTabTf.addEventListener('click', () => {
      switchOperationView(btnTabTf, formTransfer, () => {
        // Auto prefill current global CNH Rate in the transfer rate input when opened
        const rateVal = parseFloat(inputCnhRate.value) || 7.2;
        tfRate.value = rateVal.toFixed(4);
        updateTfCnhDisplay();
      });
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
      await submitOnce(formTransfer, async () => {

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
        showSubmissionSuccess('内部份额转让已提交并保存');
        formTransfer.reset();
        setDefaultDates();
        await loadAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
      });
    });

    // 流水筛选
    filterMember.addEventListener('change', renderLedger);
    filterType.addEventListener('change', renderLedger);

    // 对标指数复选框切换监听
    const comparisonDatasetIndexes = new Map([
      [chkCompAssets, 0],
      [chkCompNav, 1],
      [chkCompSp500, 2],
      [chkCompNdx, 3]
    ]);

    const updateCompVisibility = event => {
      if (!navTrendChart) return;

      const checkbox = event.currentTarget;
      const datasetIndex = comparisonDatasetIndexes.get(checkbox);
      const visible = checkbox.checked;
      const isAssets = datasetIndex === 0;

      // The asset axis changes the chart layout. Settle that layout without
      // animation first, then fade the dataset so it never flies in.
      if (isAssets && visible) {
        navTrendChart.options.scales['y-assets'].display = true;
        navTrendChart.update('none');
      }
      navTrendChart.$glassTooltipBackdrop = null;
      window.FundChartRenderer.animateDatasetVisibility(navTrendChart, datasetIndex, visible, {
        duration: visible ? 320 : 240,
        onComplete: () => {
          if (isAssets && !visible) {
            navTrendChart.options.scales['y-assets'].display = false;
            navTrendChart.update('none');
          }
        }
      });
      renderTrendStats?.();
    };

    chkCompNav.addEventListener('change', updateCompVisibility);
    chkCompAssets.addEventListener('change', updateCompVisibility);
    chkCompSp500.addEventListener('change', updateCompVisibility);
    chkCompNdx.addEventListener('change', updateCompVisibility);

    // 时间区间选择按钮绑定
    const timeSlicerGroup = document.getElementById('time-slicer-group');
    document.querySelectorAll('.time-slice-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        activateSegmentOption(timeSlicerGroup, e.currentTarget);
        activeTimeSlice = e.currentTarget.getAttribute('data-time-slice');
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
      await submitOnce(formEditEvent, async () => {
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
        closeModal(editEventModal);
        await loadAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
      });
    });

    // 关闭修改模态框

    // 出入金录入提交
    formTransaction.addEventListener('submit', async (e) => {
      e.preventDefault();
      await submitOnce(formTransaction, async () => {

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
        showSubmissionSuccess('交易记录已提交并保存');
        formTransaction.reset();
        setDefaultDates();
        await loadAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
      });
    });

    // 估值更新提交
    formValuation.addEventListener('submit', async (e) => {
      e.preventDefault();
      await submitOnce(formValuation, async () => {

      const totalNAV = parseFloat(valTotalNav.value);
      const date = valDate.value;
      const remark = valRemark.value.trim();

      try {
        await Api.updateValuation({ totalNAV, date, remark });
        showSubmissionSuccess('基金估值已提交并完成重估');
        formValuation.reset();
        setDefaultDates();
        await loadAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
      });
    });

    // 数据备份模态框打开与关闭
    if (btnBackupPanel) btnBackupPanel.addEventListener('click', openBackupPanel);

    // 成员管理模态框打开与关闭
    if (btnMemberPanel) btnMemberPanel.addEventListener('click', openMembersPanel);

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
    btnConfirmImport.addEventListener('click', async () => {
      const file = fileImport.files[0];
      if (!file) return;

      try {
        btnConfirmImport.setAttribute('disabled', 'true');
        await Api.importBackup(file);
        showToast('ZIP 快照恢复成功！账目和系统配置均已覆盖。', 'success');
        closeModal(backupModal);
        fileImport.value = '';
        fileNameLabel.textContent = '未选择任何文件';
        await loadAllData();
      } catch (err) {
        btnConfirmImport.removeAttribute('disabled');
        showToast('恢复失败，请确认上传了本系统导出的 ZIP 备份：' + err.message, 'error');
      }
    });

    // 打开标的配置弹窗
    if (btnRefreshTickers) {
      btnRefreshTickers.addEventListener('click', async () => {
        btnRefreshTickers.disabled = true;
        btnRefreshTickers.classList.add('spinning');
        try {
          const result = await Api.refreshTickerAth();
          await loadTickerAthData();
          if (result.refreshSuccess) {
            showToast('标的数据已从 Yahoo Finance 刷新', 'success');
          } else {
            showToast(`刷新失败，继续显示本地缓存数据：${result.failedTickers.join('、')}`, 'warning');
          }
        } catch (err) {
          showToast('刷新失败，继续显示本地缓存数据：' + err.message, 'error');
        } finally {
          btnRefreshTickers.disabled = false;
          btnRefreshTickers.classList.remove('spinning');
        }
      });
    }

    if (btnConfigTickers) {
      btnConfigTickers.addEventListener('click', () => {
        renderTickerConfigList();
        openModal(tickerConfigModal);
      });
    }

    // 渲染标的配置列表
    async function renderTickerConfigList() {
      try {
        const tickers = await Api.getTickers();
        tickerConfigList.replaceChildren();
        tickers.forEach(ticker => {
          addTickerRow(ticker.ticker);
        });
        initTickerSortable();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    function initTickerSortable() {
      tickerSortable?.destroy();
      tickerSortable = new Sortable(tickerConfigList, {
        animation: 180,
        easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
        handle: '.ticker-drag-handle',
        draggable: '.ticker-config-row',
        ghostClass: 'ticker-sort-ghost',
        chosenClass: 'ticker-sort-chosen',
        forceFallback: false,
        fallbackOnBody: true,
        fallbackClass: 'ticker-sort-fallback',
        fallbackTolerance: 4,
        swapThreshold: 0.65,
        invertSwap: true,
        scroll: true,
        bubbleScroll: true,
        scrollSensitivity: 60,
        scrollSpeed: 12
      });
    }

    function moveTickerRow(row, direction) {
      const sibling = direction === 'up' ? row.previousElementSibling : row.nextElementSibling;
      if (!sibling) return;
      if (direction === 'up') tickerConfigList.insertBefore(row, sibling);
      else tickerConfigList.insertBefore(sibling, row);
    }

    // 动态添加一个配置行
    function addTickerRow(ticker = '') {
      const row = document.createElement('div');
      row.className = 'ticker-config-row member-edit-item';
      row.style.display = 'flex';
      row.style.gap = '10px';
      row.style.width = '100%';
      row.style.alignItems = 'center';
      row.innerHTML = `
        <div class="ticker-sort-controls" aria-label="调整展示顺序">
          <button class="ticker-drag-handle" type="button" title="拖动排序（也可用上下方向键）" aria-label="拖动此标的调整顺序">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h14"/></svg>
          </button>
        </div>
        <div style="flex: 1; min-width: 0;">
          <input type="text" class="ticker-symbol-input" value="${escapeHtml(ticker)}" placeholder="代码（如：AAPL）" style="width: 100%; font-weight: 700; text-transform: uppercase;" required>
        </div>
        <button class="btn-delete btn-remove-ticker-row" type="button" title="移除此标的" style="flex-shrink: 0; padding: 6px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px;">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      `;

      // 绑定删除按钮点击事件
      row.querySelector('.btn-remove-ticker-row').addEventListener('click', () => {
        row.remove();
      });
      const dragHandle = row.querySelector('.ticker-drag-handle');
      dragHandle.addEventListener('keydown', event => {
        if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        moveTickerRow(row, event.key === 'ArrowUp' ? 'up' : 'down');
      });

      tickerConfigList.appendChild(row);
    }

    // 添加配置行事件
    if (btnAddTickerRow) {
      btnAddTickerRow.addEventListener('click', () => {
        addTickerRow();
        tickerConfigList.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    }

    // 保存配置事件
    if (btnSaveTickerConfig) {
      btnSaveTickerConfig.addEventListener('click', async () => {
        const rows = tickerConfigList.querySelectorAll('.ticker-config-row');
        const tickers = [];
        let valid = true;

        rows.forEach(row => {
          const tickerInput = row.querySelector('.ticker-symbol-input');
          const ticker = tickerInput.value.trim();

          if (!ticker) {
            tickerInput.focus();
            valid = false;
            return;
          }
          tickers.push({ ticker });
        });

        if (!valid) {
          showToast('请填写标的代码', 'error');
          return;
        }

        if (tickers.length === 0) {
          showToast('最少需要追踪 1 个标的', 'error');
          return;
        }

        btnSaveTickerConfig.setAttribute('disabled', 'true');
        btnSaveTickerConfig.textContent = '正在保存并拉取数据...';

        try {
          await Api.saveTickers(tickers);
          showToast('标的配置保存成功！正在为您自动刷新页面。', 'success');
          closeModal(tickerConfigModal);
          // 重新抓取并更新顶部卡片
          await loadTickerAthData();
        } catch (err) {
          showToast(err.message, 'error');
        } finally {
          btnSaveTickerConfig.removeAttribute('disabled');
          btnSaveTickerConfig.innerHTML = `
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
    const activeThemeButton = [...themeBtns].find(btn => btn.getAttribute('data-theme-btn') === theme);
    activateSegmentOption(themeSelectorGroup, activeThemeButton);
    requestAnimationFrame(() => {
      setSegmentIndicator(themeSelectorGroup, activeThemeButton);
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
    const seriesColors = getSeriesColors();
    navTrendChart.options.scales['y-nav'].ticks.color = hexToRgba(seriesColors.nav, 0.7);
    navTrendChart.options.scales['y-nav'].title.color = hexToRgba(seriesColors.nav, 0.7);
    navTrendChart.options.scales['y-assets'].ticks.color = hexToRgba(seriesColors.assets, 0.7);
    navTrendChart.options.scales['y-assets'].title.color = hexToRgba(seriesColors.assets, 0.7);

      // 动态调整明暗主题下四条曲线的色值，彻底解决浅色模式下的低对比度问题
      const semanticStyles = getComputedStyle(document.body);
      const colors = {
        ...seriesColors,
        deposit: semanticStyles.getPropertyValue('--color-positive').trim(),
        withdraw: semanticStyles.getPropertyValue('--color-negative').trim(),
        transfer: seriesColors.nav
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
        navTrendChart.data.datasets[1].backgroundColor = createChartGradient(ctxNav, hexToRgba(colors.nav, isDarkTheme ? 0.30 : 0.25), hexToRgba(colors.nav, 0));
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

      // 扇区颜色始终与对应成员头像的底色一致。
      if (memberAllocationChart.data.datasets[0].backgroundColor && memberAllocationChart.data.datasets[0].backgroundColor.length > 0) {
        const firstColor = memberAllocationChart.data.datasets[0].backgroundColor[0];
        if (firstColor && !firstColor.startsWith('rgba(')) {
          const newColors = membersList.map((member, idx) => getMemberAvatarColor(member.id || member.name, isDarkTheme, idx).background);
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
      syncBenchmarkPolicyControl(appState.settings?.benchmarkClosePolicy || 'previous');

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

    window.FundCustomSelect?.refresh();
  }

  // 1. 仪表盘指标渲染 (USD 币种重构 & CNH 人民币对比核算)
  function renderDashboard() {
    const s = appState.summary;

    // 自动更新汇率框数值（若当前没有被焦点选中）
    if (document.activeElement !== inputCnhRate) {
      inputCnhRate.value = s.cnhRate.toFixed(4);
    }

    elFundNavPerShare.textContent = s.navPerShare.toFixed(4);
    // 根据单位净值更新颜色指示器
    elFundNavPerShare.className = 'metric-value font-outfit privacy-sensitive';

    elNavIndicator.innerHTML = `<span class="status-indicator">已与最新市场数据同步</span>`;

    // Three-card overview: assets, NAV and return rate.
    elFundTotalNav.innerHTML = `<span>$${formatMoney(s.totalNAV)}</span><span class="metric-inline metric-profit-inline ${s.profit >= 0 ? 'text-green' : 'text-magenta'}">${s.profit >= 0 ? '+' : ''}$${formatMoney(s.profit)}</span>`;
    elFundTotalShares.innerHTML = `<span class="metric-sub-primary">≈ ¥${formatCnhWan(s.cnhTotalNAV)}</span><span class="metric-inline ${s.cnhProfit >= 0 ? 'text-green' : 'text-magenta'}">CNH收益 ${s.cnhProfit >= 0 ? '+' : ''}¥${formatCnhWan(s.cnhProfit)}</span>`;
    elFundTotalShares.classList.add('privacy-sensitive');

    elFundProfitRate.innerHTML = `<span>${s.profitRate > 0 ? '+' : ''}${s.profitRate.toFixed(2)}%</span>`;
    const profitRateTone = s.profitRate > 0 ? ' text-green' : s.profitRate < 0 ? ' text-magenta' : '';
    elFundProfitRate.className = `metric-value font-outfit privacy-sensitive${profitRateTone}`;
    elFundProfitRateSub.innerHTML = `<span class="metric-inline"><span>CNH收益率</span><strong class="${s.cnhProfitRate >= 0 ? 'text-green' : 'text-magenta'}">${s.cnhProfitRate >= 0 ? '+' : ''}${s.cnhProfitRate.toFixed(2)}%</strong></span>`;
  }

  // 2. 动态家庭成员资产网格渲染
  function renderMembersGrid() {
    return window.FundMemberRenderer.renderGrid({
      state: appState,
      members: membersList,
      elements: { grid: elMembersGridContainer, countBadge: elMemberCountBadge },
      utils: { escapeHtml, formatMoney, formatCnhWan, getAvatarText, getMemberAvatarColor },
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
      const { background: cardColor, color: cardTextColor } = getMemberAvatarColor(m.id || m.name, isDark, idx);

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
          if (confirm(`确定要从系统删除家庭成员【${m.name}】吗？删除后将无法撤销。`)) {
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

  // 删除单条交易记录 — 3 秒内可撤销
  function handleDeleteEvent(id, name, type, value) {
    const UNDO_DELAY = 3000; // 3 秒

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
        <svg class="toast-undo-icon ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 10v6M14 10v6"/></svg>
        <span class="toast-undo-text">
          <strong>已删除</strong>
          ${type === 'deposit' ? '入金' : type === 'withdraw' ? '出金' : type === 'transfer' ? '转让' : '估值'}记录（$${formatMoney(value)}）<br>
          <span style="font-size:0.75rem; opacity:0.7;">3 秒内可撤销，操作完成后将重算账目</span>
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

    // 3 秒后执行真正删除
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

    window.FundCustomSelect?.refresh(editEventModal);
    openModal(editEventModal);
  }

  function renderCharts() {
    if (!appState) return;
    const rendered = window.FundChartRenderer.render({
      state: appState,
      members: membersList,
      settings: { activeTimeSlice, theme: currentTheme },
      charts: { navTrendChart, memberAllocationChart },
      elements: { chkCompNav, chkCompAssets, chkCompSp500, chkCompNdx, trendStatsGrid: elTrendStatsGrid },
      ui: { formatMoney, getThemeColors, isDarkTheme, createChartGradient, getSeriesColors, hexToRgba, getMemberAvatarColor }
    });
    navTrendChart = rendered.navTrendChart;
    memberAllocationChart = rendered.memberAllocationChart;
    currentFilteredHistory = rendered.filteredHistory;
    currentTrendStatSeries = rendered.trendSeries;
    renderTrendStats = rendered.renderTrendStats;
    updateChartsColors(currentTheme);
  }

  // 加载并渲染美股标的 ATH 历史及收盘价格回调数据
  async function loadTickerAthData() {
    const container = document.getElementById('ticker-ath-cards-container');
    return window.FundTickerPanel.load({
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
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
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

  function showSubmissionSuccess(message) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast toast-success toast-submission-success';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.innerHTML = `
      <svg class="toast-success-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="m5 12 4.2 4.2L19 6.5"/></svg>
      <div><strong>提交成功</strong><span>${escapeHtml(message)}</span></div>
    `;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = 'toastSlideIn 0.3s cubic-bezier(0.4, 0, 0.2, 1) reverse forwards';
      toast.addEventListener('animationend', () => toast.remove(), { once: true });
    }, 4200);
  }
});
