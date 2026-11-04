'use strict';

// Mock Costpoint state. Db is the persistent store: one record per period
// (sparse column maps, the way mock/fixture.json is written). Session is one
// login's working copy: a per-period buffer that 205 PUTs write into and a
// 206 commits back.

const PARENT = {
  NAME: 0,
  EMPL_ID: 1,
  SCHEDULE_DESC: 2,
  END_DT: 3,
  STATUS: 4,
  ACTION_CD: 23,
  ENABLE_SIGN_FL: 573,
  ENABLE_CORRECT_FL: 676,
  TS_CLOSED_FL: 685,
};

const CHILD = {
  LINE_NO: 1,
  SEQ: 198,
  DESC: 2,
  ACCOUNT: 4,
  CODE: 6,
  WORK_LOCATION: 8,
  PAY_TYPE: 16,
  DAYS: [26, 27, 28, 29, 30, 31, 32],
  TOTALS: [96, 97],
  COMMENTS: [124, 135, 143, 144, 145, 146, 147],
  CHARGE_PROJECT: 104,
  CHARGE_COMBINED: 108,
  CHARGE_FLAG: 112,
  CHARGE_PAY_TYPE: 376,
  CHARGE_WORK_LOCATION: 348,
  CHARGE_PROJECT_ID: 400,
};

const CHARGE = {
  DESC: 0,
  PROJECT: 1,
  ACCOUNT: 4,
  CODE: 5,
  WORK_LOCATION: 6,
  PAY_TYPE: 15,
  COMBINED: 24,
  CODE_DESC: 25,
  FLAG: 26,
  IS_FAVORITE: 28,
  PROJECT_ID: 32,
  ALT_CODE: 53,
};

// Parent columns below this index are stored in the database; the rest are
// computed by the application and only sent for the row under the cursor
const PARENT_DB_COLS = 45;

const DAY_MS = 24 * 60 * 60 * 1000;

function parseDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function isoDay(date) {
  return date.toISOString().substring(0, 10);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function toNumber(value) {
  const n = parseFloat(value);
  return Number.isNaN(n) ? 0 : n;
}

function formatHours(n) {
  return String(Math.round(n * 100) / 100);
}

class Db {
  constructor(fixture, { today } = {}) {
    this.fixture = clone(fixture);
    this.today = today || isoDay(new Date());
    this.cols = this.fixture.cols;
    this.defaults = this.fixture.defaults;
    this.employee = this.fixture.employee;
    this.charges = this.fixture.charges;
    this.favorites = this.fixture.favorites;
    this.leave = this.fixture.leave;
    this.periods = this._buildPeriods();
  }

  _buildPeriods() {
    const periods = this.fixture.periods.map((p, idx) => ({ ...clone(p), weeksBack: idx }));
    const total = this.fixture.periodCount || periods.length;
    const template = this.fixture.periodTemplate;
    for (let idx = periods.length; idx < total; idx++) {
      periods.push({ ...clone(template), weeksBack: idx });
    }
    for (const p of periods) {
      p.revisions = p.revisions || [];
      p.audit = p.audit || [];
      p.signedOnce = Boolean(p.signedOnce);
    }
    return periods;
  }

  /** Restore persisted state (from toJSON) over the fixture */
  static fromState(fixture, state) {
    const db = new Db(fixture, { today: state.today });
    db.periods = clone(state.periods);
    db.favorites = clone(state.favorites);
    return db;
  }

  toJSON() {
    return { today: this.today, periods: this.periods, favorites: this.favorites };
  }

  get periodCount() {
    return this.periods.length;
  }

  period(idx) {
    const p = this.periods[idx];
    if (!p) throw new Error('No period ' + idx);
    return p;
  }

  // Weeks end on a Sunday. Period 0 is the week that contains today.
  endDate(idx) {
    const today = parseDay(this.today);
    const untilSunday = (7 - today.getUTCDay()) % 7;
    return isoDay(new Date(today.getTime() + (untilSunday - 7 * this.period(idx).weeksBack) * DAY_MS));
  }

  weekDates(idx) {
    const end = parseDay(this.endDate(idx));
    return Array.from({ length: 7 }, (_, i) => isoDay(new Date(end.getTime() - (6 - i) * DAY_MS)));
  }

  /**
   * Parent (K0) row. Only the row under the cursor carries the computed
   * columns (past PARENT_DB_COLS); override replaces stored columns.
   */
  parentRow(idx, { full, override, view } = {}) {
    const p = view || this.period(idx);
    const row = new Array(this.cols.parent).fill('');
    const cols = { ...this.defaults.parent, ...(override || {}) };
    for (const [c, v] of Object.entries(cols)) row[Number(c)] = v;
    row[PARENT.NAME] = this.employee.name;
    row[PARENT.EMPL_ID] = this.employee.id;
    row[PARENT.END_DT] = this.endDate(idx);
    row[PARENT.STATUS] = p.status;
    row[PARENT.SCHEDULE_DESC] = 'Weekly for US-BiWeekly Payroll, Wk ' + (idx % 2 === 0 ? 1 : 2) + ' of 2';
    if (!full) {
      row.fill('', PARENT_DB_COLS);
    } else {
      row[PARENT.ENABLE_SIGN_FL] = p.status === 'O' && !p.closed ? 'Y' : 'N';
      row[PARENT.ENABLE_CORRECT_FL] = p.closed && p.correctable ? 'Y' : 'N';
      row[PARENT.TS_CLOSED_FL] = p.closed ? 'Y' : 'N';
      row[20] = this.leaveSummary();
    }
    return row;
  }

  leaveSummary() {
    return this.leave.balances.map(b => b.description + ': ' + b.balance.toFixed(4)).join('\r\n');
  }

  childRow(sparse, seq) {
    const row = new Array(this.cols.child).fill('');
    for (const [c, v] of Object.entries(this.defaults.child)) row[Number(c)] = v;
    for (const [c, v] of Object.entries(sparse)) row[Number(c)] = v;
    row[CHILD.LINE_NO] = String(seq);
    row[CHILD.SEQ] = String(seq);
    this.recalcTotals(row);
    return row;
  }

  recalcTotals(row) {
    const sum = CHILD.DAYS.reduce((acc, c) => acc + toNumber(row[c]), 0);
    const total = row.slice(CHILD.DAYS[0], CHILD.DAYS[6] + 1).some(v => v !== '') ? formatHours(sum) : '';
    for (const c of CHILD.TOTALS) row[c] = total;
  }

  /** Child rows of a period as [{ rowNum, row }] */
  lines(idx) {
    return this.period(idx).lines.map((sparse, i) => ({
      rowNum: String(i),
      row: this.childRow(sparse, i + 1),
    }));
  }

  /** Inverse of childRow: keep what differs from the defaults */
  sparseFromRow(row) {
    const derived = new Set([CHILD.LINE_NO, CHILD.SEQ, ...CHILD.TOTALS]);
    const sparse = {};
    row.forEach((v, c) => {
      if (derived.has(c)) return;
      if (v !== (this.defaults.child[c] || '')) sparse[c] = v;
    });
    return sparse;
  }

  /** Charge catalog rows for a code (case-insensitive) */
  chargesFor(code) {
    const wanted = String(code || '').toUpperCase();
    return this.charges.filter(c => c.code.toUpperCase() === wanted);
  }

  /** The 56-column lookup row for a catalog entry */
  chargeRow(charge, { multi } = {}) {
    const row = new Array(this.cols.charge).fill('');
    row[CHARGE.DESC] = charge.desc;
    row[CHARGE.PROJECT] = charge.project;
    row[CHARGE.ACCOUNT] = charge.account;
    row[CHARGE.CODE] = charge.code;
    row[CHARGE.PAY_TYPE] = charge.payType || '';
    row[CHARGE.COMBINED] = multi ? charge.code + charge.payType : charge.code;
    row[CHARGE.CODE_DESC] = charge.desc;
    row[CHARGE.FLAG] = '1';
    row[CHARGE.WORK_LOCATION] = charge.workLocation || '';
    row[CHARGE.IS_FAVORITE] = charge.favorite ? 'Y' : 'N';
    row[CHARGE.PROJECT_ID] = charge.parentBranch === undefined ? charge.code : charge.parentBranch;
    row[CHARGE.ALT_CODE] = charge.code;
    return row;
  }

  addFavorite({ code, payType, desc }) {
    const key = code + '|' + (payType || '');
    if (this.favorites.some(f => f.code + '|' + (f.payType || '') === key)) return false;
    this.favorites.push({ code, payType: payType || '', desc: desc || '' });
    return true;
  }

  /** Replace a period's lines with a buffer's rows (pending rows get numbers) */
  commitLines(idx, bufferLines) {
    this.period(idx).lines = bufferLines.map(l => this.sparseFromRow(l.row));
  }

  nextRevisionNo(idx) {
    const revs = this.period(idx).revisions;
    return revs.reduce((max, r) => Math.max(max, r.revNo), 0) + 1;
  }
}

class Session {
  constructor(sid, now) {
    this.sid = sid;
    this.lastSeen = now;
    this.buffers = new Map();
    this.openRs = {};
    this.autoLoaded = false;
    this.worked = false;
    this.signPrimed = new Set();
    this.correctPending = new Set();
    this.procIds = new Set();
    this.favoritesPrimed = false;
    this.explanations = new Map();
    this.pendingAudit = new Map();
    this.parentPuts = new Map();
    this.selectedCharge = null;
    this.lastPut = null;
    this.favSaved = false;
  }

  /** Working copy of a period, created from the database on first write */
  buffer(db, idx) {
    if (!this.buffers.has(idx)) {
      this.buffers.set(idx, {
        lines: db.lines(idx).map(l => ({ rowNum: l.rowNum, row: l.row.slice() })),
        parentPut: null,
      });
    }
    return this.buffers.get(idx);
  }

  discardBuffer(idx) {
    this.buffers.delete(idx);
    this.explanations.delete(idx);
    this.pendingAudit.delete(idx);
  }
}

module.exports = { Db, Session, PARENT, CHILD, CHARGE, PARENT_DB_COLS, parseDay, isoDay, toNumber, formatHours };
