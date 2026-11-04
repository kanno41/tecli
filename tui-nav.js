'use strict';

function periodLabel(period) {
  if (period <= 0) return '';
  if (period === 1) return 'PREVIOUS WEEK';
  return period + ' WEEKS AGO';
}

// periodCount is the number of loaded periods (getPeriods().length), or
// null when not yet known. Returns the target period or null if out of range.
function stepPeriod(current, delta, periodCount) {
  const next = current + delta;
  if (next < 0) return null;
  if (periodCount !== null && periodCount !== undefined && next >= periodCount) return null;
  return next;
}

// Start of the week holding today, stepping a cached week start forward in
// whole weeks. A cache written in an earlier week is otherwise taken for the
// current week, and the real current week reads as one that does not exist.
function currentWeekStart(cachedStart, today) {
  if (!cachedStart) return null;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const days = Math.round((Date.parse(today) - Date.parse(cachedStart)) / DAY_MS);
  if (!(days >= 7)) return cachedStart;
  return new Date(Date.parse(cachedStart) + Math.floor(days / 7) * 7 * DAY_MS).toISOString().slice(0, 10);
}

module.exports = { periodLabel, stepPeriod, currentWeekStart };
