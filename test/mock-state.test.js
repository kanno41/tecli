'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Db, Session, PARENT, CHILD, PARENT_DB_COLS } = require('../mock/state');
const fixture = require('./fixtures/small.json');

// 2026-10-15 is a Thursday, so period 0 ends Sunday 2026-10-18
const TODAY = '2026-10-15';

function makeDb() {
  return new Db(fixture, { today: TODAY });
}

describe('Db dates', () => {
  test('period 0 ends on the Sunday of the current week', () => {
    assert.equal(makeDb().endDate(0), '2026-10-18');
  });

  test('earlier periods step back one week each', () => {
    const db = makeDb();
    assert.equal(db.endDate(1), '2026-10-11');
    assert.equal(db.endDate(3), '2026-09-27');
  });

  test('a Sunday today ends its own week', () => {
    assert.equal(new Db(fixture, { today: '2026-10-18' }).endDate(0), '2026-10-18');
  });

  test('weekDates lists Monday through Sunday', () => {
    const dates = makeDb().weekDates(0);
    assert.equal(dates[0], '2026-10-12');
    assert.equal(dates[6], '2026-10-18');
  });

  test('moves with today', () => {
    assert.equal(new Db(fixture, { today: '2027-01-06' }).endDate(0), '2027-01-10');
  });
});

describe('Db rows', () => {
  test('the seed periods have the planned states', () => {
    const db = makeDb();
    assert.equal(db.periodCount, 20);
    assert.deepEqual(
      [0, 1, 2, 3].map(i => db.period(i).status),
      ['O', 'P', 'S', 'P']
    );
    assert.equal(db.period(1).closed, true);
    assert.equal(db.period(2).signedOnce, true);
  });

  test('a full parent row carries the flags the client reads', () => {
    const db = makeDb();
    const open = db.parentRow(0, { full: true });
    assert.equal(open.length, 688);
    assert.equal(open[PARENT.STATUS], 'O');
    assert.equal(open[PARENT.ENABLE_SIGN_FL], 'Y');
    assert.equal(open[PARENT.TS_CLOSED_FL], 'N');
    const closed = db.parentRow(1, { full: true });
    assert.equal(closed[PARENT.TS_CLOSED_FL], 'Y');
    assert.equal(closed[PARENT.ENABLE_CORRECT_FL], 'Y');
    const signed = db.parentRow(2, { full: true });
    assert.equal(signed[PARENT.ENABLE_SIGN_FL], 'N');
  });

  test('a sparse parent row blanks the computed columns', () => {
    const row = makeDb().parentRow(1);
    assert.equal(row[PARENT.END_DT], '2026-10-11');
    assert.equal(row[PARENT.TS_CLOSED_FL], '');
    assert.ok(row.slice(PARENT_DB_COLS).every(v => v === ''));
  });

  test('child rows expand defaults, line numbers and totals', () => {
    const lines = makeDb().lines(0);
    assert.equal(lines.length, 2);
    const row = lines[0].row;
    assert.equal(row.length, 402);
    assert.equal(row[CHILD.CODE], 'PROJ.A.100');
    assert.equal(row[CHILD.LINE_NO], '1');
    assert.equal(row[CHILD.DAYS[0]], '8');
    assert.equal(row[CHILD.TOTALS[0]], '40');
    assert.equal(lines[1].row[CHILD.TOTALS[0]], '1.5');
    assert.equal(row[8], '62226');
  });

  test('sparseFromRow inverts childRow', () => {
    const db = makeDb();
    const { row } = db.lines(0)[1];
    assert.deepEqual(db.childRow(db.sparseFromRow(row), 2), row);
  });

  test('periods past the seed use the template', () => {
    const db = makeDb();
    assert.equal(db.period(10).status, 'P');
    assert.equal(db.lines(10).length, 2);
  });
});

describe('Db catalog and favorites', () => {
  test('chargesFor finds every pay type of a code', () => {
    const db = makeDb();
    assert.equal(db.chargesFor('proj.m.400').length, 2);
    assert.equal(db.chargesFor('PROJ.A.100').length, 1);
    assert.equal(db.chargesFor('NOPE').length, 0);
  });

  test('addFavorite skips duplicates', () => {
    const db = makeDb();
    assert.equal(db.addFavorite({ code: 'PROJ.C.300', payType: 'REG' }), true);
    assert.equal(db.addFavorite({ code: 'PROJ.C.300', payType: 'REG' }), false);
    assert.equal(db.favorites.length, 3);
  });
});

describe('Session buffers', () => {
  test('a buffer is a copy: edits stay out of the database until committed', () => {
    const db = makeDb();
    const session = new Session('sid', 0);
    const buf = session.buffer(db, 0);
    buf.lines[0].row[CHILD.DAYS[0]] = '3';
    assert.equal(db.lines(0)[0].row[CHILD.DAYS[0]], '8');
    assert.equal(session.buffer(db, 0), buf);
  });

  test('commitLines stores the buffer', () => {
    const db = makeDb();
    const session = new Session('sid', 0);
    const buf = session.buffer(db, 0);
    buf.lines[0].row[CHILD.DAYS[0]] = '3';
    db.commitLines(0, buf.lines);
    assert.equal(db.lines(0)[0].row[CHILD.DAYS[0]], '3');
    assert.equal(db.lines(0)[0].row[CHILD.TOTALS[0]], '35');
  });

  test('state round trips through toJSON', () => {
    const db = makeDb();
    db.period(0).status = 'S';
    db.addFavorite({ code: 'PROJ.C.300', payType: 'REG' });
    const again = Db.fromState(fixture, JSON.parse(JSON.stringify(db)));
    assert.equal(again.period(0).status, 'S');
    assert.equal(again.favorites.length, 3);
    assert.equal(again.endDate(0), db.endDate(0));
  });
});
