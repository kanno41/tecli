'use strict';

// Most hours one cell can hold: a day
const MAX_HOURS = 24;

// Hours from a request: blank is 0, otherwise a finite number in
// 0..MAX_HOURS. Returns null for anything else.
function parseHours(value) {
  if (value === '') return 0;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= MAX_HOURS ? n : null;
}

// Day column of the te show table: xx.xx plus the comment marker, and
// cli-table's one-space padding each side (counted inside the width)
const DAY_COLUMN_WIDTH = '12.75*'.length + 2;

module.exports = { MAX_HOURS, DAY_COLUMN_WIDTH, parseHours };
