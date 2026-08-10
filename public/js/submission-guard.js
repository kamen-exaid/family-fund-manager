(function () {
  function begin(form) {
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

  async function runOnce(form, task) {
    const finish = begin(form);
    if (!finish) return;
    try {
      await task();
    } finally {
      finish();
    }
  }

  window.FundSubmission = { begin, runOnce };
})();
