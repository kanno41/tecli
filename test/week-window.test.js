'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ww = require('../week-window');

function week(start, status, lines) {
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.parse(start) + i * 86400000);
    dates.push({
      date: d.getUTCDate(),
      fullDate: d.toISOString().slice(0, 10),
      dayOfWeek: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()],
    });
  }
  return {
    dates,
    timesheetStatusCode: status,
    projects: lines.map((code, line) => ({
      line,
      code,
      description: code,
      payType: 'REG',
      hours: { [dates[0].date]: 8 },
      comments: {},
    })),
  };
}

const ACTIVE = '2026-03-08';
const weeks = {
  '2026-03-08': week('2026-03-08', 'O', ['A', 'B']),
  '2026-03-01': week('2026-03-01', 'S', ['B', 'C']),
  '2026-02-22': week('2026-02-22', 'O', ['C']),
};

test('periodWeekKey steps back whole weeks from the active week', () => {
  assert.equal(ww.periodWeekKey(ACTIVE, 0), '2026-03-08');
  assert.equal(ww.periodWeekKey(ACTIVE, 1), '2026-03-01');
  assert.equal(ww.periodWeekKey(ACTIVE, 2), '2026-02-22');
});

test('clampOffset bounds the window by the loaded period count', () => {
  assert.equal(ww.clampOffset('3', 6), 3);
  assert.equal(ww.clampOffset('9', 6), 4);
  assert.equal(ww.clampOffset('-1', 6), 0);
  assert.equal(ww.clampOffset('x', 6), 0);
  assert.equal(ww.clampOffset(undefined, 6), 0);
  assert.equal(ww.clampOffset('5', 2), 0);
});

test('parsePeriod accepts non-negative integers only', () => {
  assert.equal(ww.parsePeriod(0), 0);
  assert.equal(ww.parsePeriod('3'), 3);
  assert.equal(ww.parsePeriod(undefined), 0);
  assert.equal(ww.parsePeriod(undefined, null), null);
  assert.equal(ww.parsePeriod('1.5'), null);
  assert.equal(ww.parsePeriod(-2), null);
  assert.equal(ww.parsePeriod('abc'), null);
});

test('offset 0 shows previous week left and active week right', () => {
  const m = ww.buildMergedData({ activeStart: ACTIVE, weeksByStart: weeks, offset: 0, periodCount: 5 });
  assert.deepEqual(
    m.weeks.map(w => w.period),
    [1, 0]
  );
  assert.equal(m.dates[0].fullDate, '2026-03-01');
  assert.equal(m.dates[13].fullDate, '2026-03-14');
  assert.equal(m.weeks[1].isActive, true);
  assert.equal(m.activeDates.length, 7);
  assert.equal(m.timesheetStatusCode, 'O');
  assert.equal(m.maxOffset, 3);
  const b = m.projects.find(p => p.code === 'B');
  assert.deepEqual(b.lines, { 0: 1, 1: 0 });
  assert.equal(m.projects.find(p => p.code === 'C').lines[0], undefined);
});

test('offset 1 shows periods 2 and 1 and drops active-only behavior', () => {
  const m = ww.buildMergedData({ activeStart: ACTIVE, weeksByStart: weeks, offset: 1, periodCount: 5 });
  assert.deepEqual(
    m.weeks.map(w => w.period),
    [2, 1]
  );
  assert.equal(m.dates[0].fullDate, '2026-02-22');
  assert.deepEqual(m.activeDates, []);
  assert.equal(m.weeks[1].statusTone, 'signed');
  assert.equal(m.weeks[0].statusTone, 'open');
  assert.equal(m.timesheetStatusCode, 'S');
  assert.deepEqual(m.projects.find(p => p.code === 'C').lines, { 1: 1, 2: 0 });
});

test('a week missing from the cache is read-only and empty', () => {
  const m = ww.buildMergedData({ activeStart: ACTIVE, weeksByStart: weeks, offset: 2, periodCount: 5 });
  assert.deepEqual(
    m.weeks.map(w => w.period),
    [3, 2]
  );
  assert.equal(m.weeks[0].isEditable, false);
  assert.equal(m.weeks[0].statusLabel, null);
  assert.equal(m.weeks[1].isEditable, true);
});

test('past weeks need direct mode to be editable', () => {
  const m = ww.buildMergedData({ activeStart: ACTIVE, weeksByStart: weeks, offset: 0, useDirect: false });
  assert.deepEqual(
    m.weeks.map(w => w.isEditable),
    [false, true]
  );
});

test('weekEditable honors a closed week with no Correct', () => {
  assert.equal(ww.weekEditable({ editable: false }, 2, true), false);
  assert.equal(ww.weekEditable({ editable: null }, 2, true), true);
  assert.equal(ww.weekEditable(null, 0, true), false);
});

test('pendingPeriods lists distinct periods newest first', () => {
  const changes = [{ period: 3 }, { period: 0 }, { period: 3 }, { period: 1 }];
  assert.deepEqual(ww.pendingPeriods(changes), [0, 1, 3]);
});

test('returns null when the active week is not cached', () => {
  assert.equal(ww.buildMergedData({ activeStart: ACTIVE, weeksByStart: {} }), null);
});
