(function () {
  function setIndicator(group, button) {
    if (!group || !button) return;
    group.style.setProperty('--active-left', `${button.offsetLeft}px`);
    group.style.setProperty('--active-width', `${button.offsetWidth}px`);
  }

  function activate(group, button) {
    if (!group || !button) return;
    group.querySelectorAll('.segmented-control__button').forEach(option => {
      option.classList.toggle('active', option === button);
      option.setAttribute('aria-pressed', option === button ? 'true' : 'false');
    });
    setIndicator(group, button);
  }

  function syncAll() {
    document.querySelectorAll('.segmented-control').forEach(group => {
      setIndicator(group, group.querySelector('.segmented-control__button.active'));
    });
  }

  window.FundSegmentedControl = { setIndicator, activate, syncAll };
})();
