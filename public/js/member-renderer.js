/**
 * 成员资产卡片渲染器。
 * 保持展示逻辑与全局状态解耦，主应用只传入已计算的账本状态。
 */
window.FundMemberRenderer = {
  renderGrid({ state, members, elements, utils, isDark }) {
    const { grid, countBadge } = elements;
    const { escapeHtml, formatMoney, formatCnhWan, getAvatarText, getThemeColors } = utils;
    countBadge.textContent = `成员人数: ${members.length} 人`;

    if (members.length === 0) {
      grid.innerHTML = '<div style="grid-column:1 / -1;text-align:center;color:var(--color-text-muted);padding:30px;font-size:0.85rem;">⚠️ 暂无家庭成员。请点击右上角【家庭成员管理】添加出资人。</div>';
      return;
    }

    const { palette, textPalette } = getThemeColors(isDark);
    grid.innerHTML = members.map((member, index) => {
      const account = state.members[member.id] || {
        currentValue: 0, shares: 0, totalDeposit: 0, totalWithdraw: 0, profitRate: 0,
        cnhCurrentValue: 0, cnhDeposit: 0, cnhProfitRate: 0
      };
      const color = palette[index % palette.length];
      const textColor = textPalette[index % textPalette.length];
      const usdClass = account.profitRate >= 0 ? 'text-green' : 'text-magenta';
      const cnhClass = account.cnhProfitRate >= 0 ? 'text-green' : 'text-magenta';
      const displayName = escapeHtml(member.name);
      const avatar = escapeHtml(getAvatarText(member.name));
      const dimmed = account.totalDeposit === 0 ? 'opacity:0.55;' : '';
      return `
        <div class="member-card" style="${dimmed}border-left:3px solid ${color};">
          <div class="member-avatar" style="background:${color};color:${textColor};">${avatar}</div>
          <div class="member-details">
            <div class="member-header" style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:2px;">
              <span class="member-name" title="${displayName}" style="font-weight:700;font-size:0.9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:90px;">${displayName}</span>
              <div style="text-align:right;display:flex;flex-direction:column;align-items:flex-end;line-height:1.15;">
                <span class="member-roi ${usdClass} privacy-sensitive" style="font-size:0.85rem;font-weight:700;">${account.profitRate >= 0 ? '+' : ''}${account.profitRate.toFixed(2)}% <small>USD</small></span>
                <span class="member-roi ${cnhClass} privacy-sensitive" style="font-size:0.75rem;font-weight:600;margin-top:1px;">${account.cnhProfitRate >= 0 ? '+' : ''}${account.cnhProfitRate.toFixed(2)}% <small>CNH</small></span>
              </div>
            </div>
            <div class="member-asset font-outfit" style="display:flex;flex-direction:column;line-height:1.25;margin-bottom:2px;">
              <span class="privacy-sensitive" style="font-size:1.15rem;font-weight:700;">$${formatMoney(account.currentValue)}</span>
              <span class="privacy-sensitive" style="font-size:0.72rem;font-weight:600;color:var(--color-cyan);">≈ ¥${formatCnhWan(account.cnhCurrentValue)} <small>CNH</small></span>
            </div>
            <div class="member-shares privacy-sensitive" style="font-size:0.72rem;color:var(--color-text-muted);line-height:1.2;margin-bottom:4px;">${account.shares.toFixed(4)} 份</div>
            <div class="member-sub-info" style="display:flex;justify-content:space-between;font-size:0.68rem;padding-top:4px;border-top:1px dashed var(--color-card-divider);color:var(--color-text-muted);"><span>入金 <span class="privacy-sensitive">$${formatMoney(account.totalDeposit)}</span></span><span>出金 <span class="privacy-sensitive">$${formatMoney(account.totalWithdraw)}</span></span></div>
            <div class="member-sub-info" style="display:flex;justify-content:space-between;font-size:0.65rem;padding-top:2px;color:var(--color-text-muted);opacity:0.85;"><span>CNH入金 <span class="privacy-sensitive">¥${formatMoney(account.cnhDeposit)}</span></span></div>
          </div>
        </div>`;
    }).join('');
  }
};
