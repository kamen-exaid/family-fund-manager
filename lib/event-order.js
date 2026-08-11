function hasSequenceNumber(event) {
  return Number.isSafeInteger(event?.sequenceNumber) && event.sequenceNumber > 0;
}

function compareEvents(a, b) {
  const dateCompare = String(a?.date || '').localeCompare(String(b?.date || ''));
  if (dateCompare !== 0) return dateCompare;

  if (hasSequenceNumber(a) && hasSequenceNumber(b)) {
    const sequenceCompare = a.sequenceNumber - b.sequenceNumber;
    if (sequenceCompare !== 0) return sequenceCompare;
  }

  const createdCompare = Number(a?.createdAt) - Number(b?.createdAt);
  if (Number.isFinite(createdCompare) && createdCompare !== 0) return createdCompare;
  // Modern V8 sort is stable. Returning zero preserves legacy JSON array order
  // until the durable sequence migration has run.
  return 0;
}

function compareEventCreationOrder(a, b) {
  if (hasSequenceNumber(a) && hasSequenceNumber(b)) {
    const sequenceCompare = a.sequenceNumber - b.sequenceNumber;
    if (sequenceCompare !== 0) return sequenceCompare;
  }
  const createdCompare = Number(a?.createdAt) - Number(b?.createdAt);
  return Number.isFinite(createdCompare) && createdCompare !== 0 ? createdCompare : 0;
}

function maxSequenceNumber(...eventCollections) {
  let maximum = 0;
  for (const events of eventCollections) {
    for (const event of events || []) {
      if (hasSequenceNumber(event)) maximum = Math.max(maximum, event.sequenceNumber);
    }
  }
  return maximum;
}

function nextSequenceNumber(...eventCollections) {
  const maximum = maxSequenceNumber(...eventCollections);
  if (maximum >= Number.MAX_SAFE_INTEGER) {
    throw new Error('事件顺序号已达到安全整数上限，无法继续创建事件。');
  }
  return maximum + 1;
}

// Old ledgers used (date, createdAt), which is ambiguous when two events were
// written in the same millisecond. JSON array order is the only remaining
// durable tie-breaker, so preserve it during the one-time migration.
function migrateEventSequences(...eventCollections) {
  const indexed = [];
  let sourceIndex = 0;
  for (const events of eventCollections) {
    for (const event of events || []) indexed.push({ event, sourceIndex: sourceIndex++ });
  }

  if (indexed.length === 0) return { migrated: false, count: 0 };

  const declaredCount = indexed.filter(({ event }) =>
    Object.prototype.hasOwnProperty.call(event, 'sequenceNumber')
  ).length;
  if (declaredCount > 0) {
    const valid = indexed.every(({ event }) => hasSequenceNumber(event));
    const unique = new Set(indexed.map(({ event }) => event.sequenceNumber)).size === indexed.length;
    if (valid && unique) return { migrated: false, count: 0 };
    // A mixed or duplicate sequence set can come from combining mismatched
    // snapshots. Re-numbering it could silently rewrite financial history.
    throw new Error('事件顺序键不完整、重复或无效，拒绝自动重排账本。');
  }

  indexed.sort((a, b) => {
    const createdCompare = Number(a.event.createdAt) - Number(b.event.createdAt);
    if (Number.isFinite(createdCompare) && createdCompare !== 0) return createdCompare;
    return a.sourceIndex - b.sourceIndex;
  });
  indexed.forEach(({ event }, index) => { event.sequenceNumber = index + 1; });
  return { migrated: true, count: indexed.length };
}

module.exports = {
  hasSequenceNumber,
  compareEvents,
  compareEventCreationOrder,
  maxSequenceNumber,
  nextSequenceNumber,
  migrateEventSequences
};
