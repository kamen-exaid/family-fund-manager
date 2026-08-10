(function () {
  function getEasternParts(now = new Date(), includeTime = false) {
    const options = {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit'
    };
    if (includeTime) Object.assign(options, {
      hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23'
    });
    const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(now);
    const values = {};
    parts.forEach(part => { values[part.type] = part.value; });
    return values;
  }

  function getLatestValuationDate(now = new Date()) {
    const values = getEasternParts(now, true);
    const cursor = new Date(`${values.year}-${values.month}-${values.day}T00:00:00Z`);
    const minutes = Number(values.hour) * 60 + Number(values.minute);
    if (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6 || minutes < 4 * 60 + 5) {
      do {
        cursor.setUTCDate(cursor.getUTCDate() - 1);
      } while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6);
    }
    return cursor.toISOString().split('T')[0];
  }

  function startClock(element) {
    if (!element) return;
    const update = () => {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false, hourCycle: 'h23', timeZoneName: 'short'
      }).formatToParts(new Date());
      const values = {};
      parts.forEach(part => { values[part.type] = part.value; });
      element.textContent = `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second} ${values.timeZoneName}`;
    };
    update();
    window.setInterval(update, 1000);
  }

  function setDefaultDates({ transactionDate, valuationDate, transferDate, settlementDate }) {
    const parts = getEasternParts();
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    const latestSunday = new Date(`${today}T00:00:00Z`);
    latestSunday.setUTCDate(latestSunday.getUTCDate() - latestSunday.getUTCDay());
    transactionDate.value = latestSunday.toISOString().split('T')[0];
    const latestValuation = getLatestValuationDate();
    valuationDate.max = latestValuation;
    valuationDate.value = latestValuation;
    if (transferDate) transferDate.value = latestSunday.toISOString().split('T')[0];
    if (settlementDate) settlementDate.value = today;
  }

  window.FundDateTime = { getEasternParts, getLatestValuationDate, startClock, setDefaultDates };
})();
