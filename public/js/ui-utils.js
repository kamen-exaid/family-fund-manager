(function () {
  function getThemeColors(isDark) {
    return isDark ? {
      palette: [
        '#00f2fe',
        '#f43f5e',
        '#3b82f6',
        '#10b981',
        '#8b5cf6',
        '#f59e0b',
        '#ec4899',
        '#06b6d4'
      ],
      textPalette: ['#000000', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#000000', '#ffffff', '#ffffff']
    } : {
      palette: [
        '#0284c7',
        '#e11d48',
        '#2563eb',
        '#059669',
        '#7c3aed',
        '#d97706',
        '#db2777',
        '#0891b2'
      ],
      textPalette: ['#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff']
    };
  }

  function isDarkTheme(theme) {
    if (theme === 'dark') return true;
    if (theme === 'light') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function getAvatarText(name) {
    if (!name) return '';
    if (name.length <= 2) return name;
    const isChinese = /^[\u4e00-\u9fa5]+$/.test(name);
    if (isChinese) {
      return name.substring(name.length - 2);
    }
    return name.substring(0, 2).toUpperCase();
  }

  function formatMonthDay(dateStr) {
    if (!dateStr) return '';
    const parts = dateStr.split('-');
    if (parts.length === 3) {
      return `${parts[1]}/${parts[2]}`;
    }
    return dateStr;
  }

  function escapeHtml(str) {
    if (str === undefined || str === null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatMoney(amount) {
    if (amount === undefined || amount === null) return '0.00';
    return Number(amount).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function formatCnhWan(amount) {
    if (amount === undefined || amount === null || isNaN(amount)) return '0.00万';
    const wan = amount / 10000;
    return wan.toFixed(2) + '万';
  }

  function createChartGradient(ctx, colorStart, colorEnd) {
    const gradient = ctx.createLinearGradient(0, 0, 0, 250);
    gradient.addColorStop(0, colorStart);
    gradient.addColorStop(1, colorEnd);
    return gradient;
  }

  window.FundUiUtils = {
    getThemeColors,
    isDarkTheme,
    getAvatarText,
    formatMonthDay,
    escapeHtml,
    formatMoney,
    formatCnhWan,
    createChartGradient
  };
})();
