'use strict';

const moment = require('moment');
const { normalizeTimesheetStatus } = require('./timesheet-status');

// Periods are numbered like the parent K0 rows: 0 = active week, 1 = the week
// before it, and so on. Offset k shows periods k+1 (left) and k (right).
const WINDOW_SIZE = 2;

function parsePeriod(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function maxOffset(periodCount) {
  return Math.max(0, periodCount - WINDOW_SIZE);
}

function clampOffset(value, periodCount) {
  const n = parsePeriod(value, 0);
  return Math.min(n === null ? 0 : n, maxOffset(periodCount));
}

function windowPeriods(offset) {
  return [offset + 1, offset];
}

function periodWeekKey(activeStart, period) {
  return moment(activeStart)
    .subtract(7 * period, 'days')
    .format('YYYY-MM-DD');
}

function weekEditable(weekData, period, useDirect) {
  return !!weekData && weekData.editable !== false && (period === 0 || useDirect);
}

function pendingPeriods(changes) {
  return Array.from(new Set(Array.from(changes, c => c.period))).sort((a, b) => a - b);
}

function weekInfo(weekData, period, dates, useDirect) {
  const statusMeta = weekData
    ? normalizeTimesheetStatus(weekData.timesheetStatusCode || weekData.timesheetStatus)
    : null;
  return {
    period,
    startDate: dates[0].fullDate,
    endDate: dates[6].fullDate,
    isActive: period === 0,
    isEditable: weekEditable(weekData, period, useDirect),
    statusLabel: statusMeta ? statusMeta.label : null,
    statusTone: statusMeta ? statusMeta.tone : null,
  };
}

// Merge the two visible weeks into one 14-day view. weeksByStart is the
// cache keyed by week start date; a week missing from it renders empty and
// read-only.
function buildMergedData({ activeStart, weeksByStart, offset = 0, periodCount = WINDOW_SIZE, useDirect = true }) {
  const activeWeek = weeksByStart[activeStart];
  if (!activeWeek) return null;

  const [olderPeriod, newerPeriod] = windowPeriods(offset);
  const olderKey = periodWeekKey(activeStart, olderPeriod);
  const newerKey = periodWeekKey(activeStart, newerPeriod);
  const olderWeek = weeksByStart[olderKey] || null;
  const newerWeek = weeksByStart[newerKey] || null;

  const allDates = [];
  for (let i = 0; i < 14; i++) {
    const d = moment(olderKey).add(i, 'days');
    allDates.push({
      date: d.date(),
      fullDate: d.format('YYYY-MM-DD'),
      dayOfWeek: d.format('ddd'),
    });
  }

  const projectMap = new Map();
  function addProjects(weekData, period) {
    if (!weekData) return;
    for (const p of weekData.projects) {
      const key = `${p.code || ''}|${p.payType || ''}`;
      if (!projectMap.has(key)) {
        projectMap.set(key, {
          code: p.code,
          description: p.description,
          payType: p.payType,
          hours: {},
          comments: {},
          lines: {},
        });
      }
      const merged = projectMap.get(key);
      if (p.description && p.description.length > (merged.description || '').length) {
        merged.description = p.description;
      }
      Object.assign(merged.hours, p.hours);
      if (p.comments) Object.assign(merged.comments, p.comments);
      merged.lines[period] = p.line;
    }
  }
  addProjects(olderWeek, olderPeriod);
  addProjects(newerWeek, newerPeriod);

  const projects = Array.from(projectMap.values()).map((p, i) => ({
    line: i,
    code: p.code,
    description: p.description,
    payType: p.payType,
    hours: p.hours,
    comments: p.comments,
    lines: p.lines,
  }));

  const shownWeek = newerWeek || olderWeek;
  return {
    offset,
    maxOffset: maxOffset(periodCount),
    dates: allDates,
    projects,
    activeDates: offset === 0 ? activeWeek.dates.map(d => d.fullDate) : [],
    timesheetStatus: shownWeek ? shownWeek.timesheetStatus : undefined,
    timesheetStatusCode: shownWeek ? shownWeek.timesheetStatusCode : undefined,
    weeks: [
      weekInfo(olderWeek, olderPeriod, allDates.slice(0, 7), useDirect),
      weekInfo(newerWeek, newerPeriod, allDates.slice(7), useDirect),
    ],
  };
}

module.exports = {
  parsePeriod,
  maxOffset,
  clampOffset,
  windowPeriods,
  periodWeekKey,
  weekEditable,
  pendingPeriods,
  buildMergedData,
};
