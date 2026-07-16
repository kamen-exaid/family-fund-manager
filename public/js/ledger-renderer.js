/**
 * 历史流水表格渲染器。
 * 主应用提供状态、DOM 和行为回调；本模块只负责将状态渲染为表格。
 */
window.FundLedgerRenderer = {
  render({ state, members, elements, utils, onEdit, onDelete }) {
    const { filterMember, filterType, ledgerTbody } = elements;
    const { escapeHtml, formatMoney, formatCnhWan } = utils;
    const memberFilter = filterMember.value;
    const typeFilter = filterType.value;
    ledgerTbody.replaceChildren();

    const memberName = id => members.find(member => member.id === id)?.name || '未知成员';
    let rendered = 0;

    [...state.events].reverse().forEach(event => {
      if (memberFilter !== 'all') {
        if (memberFilter === 'system' && event.type !== 'valuation') return;
        if (memberFilter !== 'system' && event.type === 'transfer' && event.fromMember !== memberFilter && event.toMember !== memberFilter) return;
        if (memberFilter !== 'system' && event.type !== 'transfer' && event.member !== memberFilter) return;
      }
      if (typeFilter !== 'all' && event.type !== typeFilter) return;

      const row = document.createElement('tr');
      const append = (html, className = '') => {
        const cell = document.createElement('td');
        if (className) cell.className = className;
        cell.innerHTML = html;
        row.appendChild(cell);
      };

      append(escapeHtml(event.date), 'font-outfit');
      row.firstChild.style.fontSize = '0.78rem';

      let actor = '系统';
      let details;
      if (event.type === 'transfer') {
        const from = memberName(event.fromMember);
        const to = memberName(event.toMember);
        actor = `${from} ⇄ ${to}`;
        details = `<div style="font-weight:600;line-height:1.25;"><span style="color:var(--color-primary);">${escapeHtml(from)}</span><span style="color:var(--color-text-muted);font-weight:700;margin:0 2px;">⇄</span><span style="color:var(--color-green);">${escapeHtml(to)}</span></div>`;
      } else {
        actor = event.member ? memberName(event.member) : '系统';
        details = `<div style="font-weight:600;line-height:1.25;">${escapeHtml(actor)}</div>`;
      }
      details += `<div class="privacy-sensitive" style="color:var(--color-text-muted);font-size:0.72rem;margin-top:2px;line-height:1.2;">(${escapeHtml(event.remark || (event.type === 'transfer' ? '内部转让' : '无备注'))})</div>`;
      append(details);

      const typeMeta = {
        deposit: ['badge-deposit', '入金'], withdraw: ['badge-withdraw', '出金'],
        transfer: ['badge-transfer', '转让'], valuation: ['badge-valuation', '估值']
      }[event.type];
      append(`<span class="tx-badge ${typeMeta[0]}">${typeMeta[1]}</span>`);

      let amountHtml;
      if (event.type === 'deposit') amountHtml = `<div class="amount-double-line"><span class="amount-usd privacy-sensitive" style="color:var(--color-green);">+$${formatMoney(event.amount)}</span><span class="amount-cnh privacy-sensitive">+¥${formatMoney(event.cnhAmount || event._cnhAmountComputed)}</span></div>`;
      else if (event.type === 'withdraw') amountHtml = `<div class="amount-double-line"><span class="amount-usd privacy-sensitive" style="color:var(--color-magenta);">-$${formatMoney(event.amount)}</span></div>`;
      else if (event.type === 'transfer') amountHtml = `<div class="amount-double-line"><span class="amount-usd privacy-sensitive" style="color:var(--color-cyan);font-weight:700;">⇄ $${formatMoney(event.amount)}</span><span class="amount-cnh privacy-sensitive" style="font-size:0.68rem;">≈ ¥${formatMoney(event.cnhAmount || event._cnhAmountComputed)} (汇率: ${(event.cnhRate || state.summary.cnhRate || 7.2).toFixed(4)})</span></div>`;
      else amountHtml = `<div class="amount-double-line"><span class="amount-usd privacy-sensitive" style="color:var(--color-purple);">$${formatMoney(event.totalNAV)}</span></div>`;
      append(amountHtml);

      append(`<span class="privacy-sensitive text-cyan">${(event._navAtTx || 1).toFixed(4)}</span>`, 'font-outfit text-cyan');
      append(`<span class="privacy-sensitive">${(event._totalSharesAfter || 0).toFixed(4)} 份</span>`, 'font-outfit');
      const totalNav = event._totalNAVAfter || 0;
      const valueHtml = event.type === 'deposit'
        ? `<div class="amount-double-line"><span class="amount-usd privacy-sensitive">$${formatMoney(totalNav)}</span><span class="amount-cnh privacy-sensitive" style="font-size:0.68rem;">≈ ¥${formatCnhWan(totalNav * (state.summary.cnhRate || 7.2))}</span></div>`
        : `<div class="amount-double-line"><span class="amount-usd privacy-sensitive">$${formatMoney(totalNav)}</span></div>`;
      append(valueHtml);

      const actions = document.createElement('td');
      const actionBox = document.createElement('div');
      actionBox.className = 'action-btns-flex';
      const makeButton = (className, title, icon) => {
        const button = document.createElement('button');
        button.className = className;
        button.title = title;
        button.innerHTML = icon;
        actionBox.appendChild(button);
        return button;
      };
      const edit = makeButton('btn-edit', '修改此条流水', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>');
      edit.addEventListener('click', () => onEdit(event));
      const remove = makeButton('btn-delete', '删除此条流水并重算', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>');
      remove._deleteEventId = event.id;
      remove.addEventListener('click', () => onDelete(event.id, actor, event.type, event.amount || event.totalNAV));
      actions.appendChild(actionBox);
      row.appendChild(actions);
      ledgerTbody.appendChild(row);
      rendered += 1;
    });

    if (!rendered) {
      const empty = document.createElement('tr');
      empty.className = 'empty-row';
      empty.innerHTML = '<td colspan="7" style="text-align:center;color:var(--color-text-muted);padding:40px 0;">未检索到符合过滤条件的交易记录</td>';
      ledgerTbody.appendChild(empty);
    }
  }
};
