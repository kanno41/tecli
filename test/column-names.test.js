#!/usr/bin/env node
'use strict';

// Parent columns are found by name from the OPEN_RS maObjId list, so a
// server-side column insert cannot silently move the sign/closed flags.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const protocol = require('../protocol');
const DirectClient = require('../direct');

const CAPTURE = path.join(__dirname, '../captured/prev-period-edit/006-res.txt');
const hasCapture = fs.existsSync(CAPTURE);

test('decodes the compressed K0 column list from a browser capture', { skip: !hasCapture && 'no captured/' }, () => {
  const [names] = protocol.columnNames(fs.readFileSync(CAPTURE, 'utf8'));
  assert.equal(names.length, 688);
  assert.ok(names.every(n => /^[A-Z0-9_]+$/.test(n)));
  assert.equal(names[3], 'END_DT');
  assert.equal(names[23], 'ACTION_CD');
  assert.equal(names[573], 'ENABLE_SIGN_FL');
  assert.equal(names[676], 'ENABLE_CORRECT_FL');
  assert.equal(names[685], 'TS_CLOSED_FL');
});

test('reads plain uncompressed names', () => {
  const text = 'var responses=[[],"",[],[],[],[function(g){D.V(g,"maObjId","A\x0bB_FL\x0bC")}]];';
  assert.deepEqual(protocol.columnNames(text), [['A', 'B_FL', 'C']]);
});

function layout(width, at) {
  const names = Array.from({ length: width }, (_, i) => 'COL' + i);
  for (const [name, i] of Object.entries(at)) names[i] = name;
  return names;
}

const SHIFTED = {
  EMPL_FULL_NAME: 0,
  EMPL_ID: 1,
  SCHEDULE_DESC_AND_P_TEXT: 2,
  END_DT: 3,
  S_STATUS_CD: 4,
  ACTION_CD: 23,
  ENABLE_SIGN_FL: 575,
  ENABLE_CORRECT_FL: 680,
  TS_CLOSED_FL: 689,
};

test('resolves the shifted live layout (692 columns) by name', () => {
  const cols = DirectClient.resolveParentColumns(layout(692, SHIFTED), 692);
  assert.equal(cols.ENABLE_SIGN_FL, 575);
  assert.equal(cols.ENABLE_CORRECT_FL, 680);
  assert.equal(cols.TS_CLOSED_FL, 689);
  assert.equal(cols.SCHEDULE_DESC, 2);
});

test('fails loudly when a required column is missing', () => {
  const names = layout(692, SHIFTED);
  names[689] = 'SOMETHING_ELSE';
  assert.throws(() => DirectClient.resolveParentColumns(names, 692), /TS_CLOSED_FL/);
});

test('fails loudly when the name list does not match the row width', () => {
  assert.throws(() => DirectClient.resolveParentColumns(layout(692, SHIFTED), 688), /692.*688|688.*692/);
});

test('a Processed week in the shifted layout is seen as closed', () => {
  const client = Object.create(DirectClient.prototype);
  client.parentCol = DirectClient.resolveParentColumns(layout(692, SHIFTED), 692);
  const row = new Array(692).fill('');
  row[4] = 'P';
  row[575] = 'N';
  row[680] = 'Y';
  row[689] = 'Y';
  row[685] = 'R';
  client.parentData = { rowNums: ['0'], rowFlags: ['0'], rows: [row] };
  client.periodIdx = 0;
  assert.equal(client._isPeriodClosed(), true);
});

test('refuses to treat a Processed week as open', () => {
  const client = Object.create(DirectClient.prototype);
  client.parentCol = DirectClient.CAPTURE_PARENT_COL;
  const row = new Array(688).fill('');
  row[4] = 'P';
  row[685] = 'R';
  client.parentData = { rowNums: ['0'], rowFlags: ['0'], rows: [row] };
  client.periodIdx = 0;
  assert.throws(() => client._isPeriodClosed(), /Processed/);
});

// Child (K1) columns: the 10/2026 update inserted REVERSED_FROM_LN_NO at 244
// (402 -> 403 columns), moving every child column from 244 on up by one.
const CHILD_CAPTURE = path.join(__dirname, '../captured/work-location/008-res.txt');

const CHILD_402 = {
  S_APPROVE_STATUS_CD: 0,
  DISPLAY_LINE_NO: 1,
  LINE_DESC: 2,
  UDT02_ID: 6,
  UDT03_ID: 8,
  UDT10_ID: 16,
  DAY1_HRS: 26,
  DAY2_HRS: 27,
  DAY3_HRS: 28,
  DAY4_HRS: 29,
  DAY5_HRS: 30,
  DAY6_HRS: 31,
  DAY7_HRS: 32,
  TOTAL_ENTERED_HRS: 96,
  CHARGE_BRANCH_CD_U2_CHG_LKUP: 104,
  CHARGE_CD_U2_CHG_LKUP: 108,
  CHARGE_TREE_CD_U2_CHG_LKUP: 112,
  COMMENT___DAY1_HRS: 124,
  COMMENT___DAY2_HRS: 135,
  COMMENT___DAY3_HRS: 143,
  COMMENT___DAY4_HRS: 144,
  COMMENT___DAY5_HRS: 145,
  COMMENT___DAY6_HRS: 146,
  COMMENT___DAY7_HRS: 147,
  COST_FL: 150,
  COUNT_ROW: 151,
  EMPL_ID: 187,
  HRS_INCREMENT_CD: 193,
  HRS_MODIFY_FL: 194,
  IS_AMBIGUOUS_LKP: 196,
  IS_PROCESSED_FL: 197,
  LINE_NO: 198,
  OT_FL: 234,
  PERIOD_NO_CD: 235,
  TS_SCHEDULE_CD: 336,
  UDT10_ID_U2_CHG_LKUP: 376,
  UDT_FROM_LKP_FL: 393,
  YEAR_NO_CD: 398,
  UDT03_ID_U2_CHG_LKUP: 348,
  UDT02_DISPLAY: 400,
};

function liveChildLayout() {
  const names = layout(402, CHILD_402);
  names.splice(244, 0, 'REVERSED_FROM_LN_NO');
  return names;
}

test(
  'the K1 column list in the init response matches the capture layout',
  { skip: !hasCapture && 'no captured/' },
  () => {
    const [names] = protocol.columnNames(fs.readFileSync(CHILD_CAPTURE, 'utf8'));
    assert.equal(names.length, 402);
    for (const [name, i] of Object.entries(CHILD_402)) assert.equal(names[i], name, 'column ' + i);
  }
);

test('resolves the live child layout (403 columns) by name', () => {
  const cols = DirectClient.resolveChildColumns(liveChildLayout(), 403);
  assert.equal(cols.UDT02_ID, 6);
  assert.equal(cols.DAYS[0], 26);
  assert.equal(cols.COMMENTS[6], 147);
  assert.equal(cols.TS_SCHEDULE_CD, 337);
  assert.equal(cols.CHARGE_PAY_TYPE, 377);
  assert.equal(cols.UDT_FROM_LKP_FL, 394);
  assert.equal(cols.YEAR_NO_CD, 399);
  assert.equal(cols.CHARGE_PROJECT_ID, 401);
});

test('child resolution fails loudly on a missing name, a duplicate or a width mismatch', () => {
  const missing = liveChildLayout();
  missing[401] = 'OTHER';
  assert.throws(() => DirectClient.resolveChildColumns(missing, 403), /UDT02_DISPLAY/);
  const dup = liveChildLayout();
  dup[5] = 'UDT02_ID';
  assert.throws(() => DirectClient.resolveChildColumns(dup, 403), /UDT02_ID.*not unique/);
  assert.throws(() => DirectClient.resolveChildColumns(liveChildLayout(), 402), /403.*402/);
  assert.throws(() => DirectClient.resolveChildColumns(undefined, 403), /child column names/);
});

test('staging a line and copying a charge write the live child columns', () => {
  const client = Object.create(DirectClient.prototype);
  client.childCol = DirectClient.resolveChildColumns(liveChildLayout(), 403);
  const template = new Array(403).fill('');
  template[337] = 'SCHED';
  template[399] = '2026';
  template[336] = 'WRONG';
  template[398] = 'WRONG';
  client.childData = { rowNums: ['0'], rowFlags: ['0'], rows: [template] };
  client._stagePendingLine();
  const row = client.childData.rows[1];
  assert.equal(row[337], 'SCHED');
  assert.equal(row[399], '2026');
  assert.equal(row[336], '');
  assert.equal(row[394], 'N');
  assert.equal(row[393], '');

  client.lookupCol = DirectClient.resolveLookupColumns(LOOKUP_NAMES);
  const k2 = new Array(56).fill('');
  k2[1] = 'H01980';
  k2[5] = 'H01980.A.N102.210';
  k2[15] = 'REG';
  k2[24] = 'H01980.A.N102.210';
  k2[26] = '1';
  k2[32] = 'PARENT';
  k2[53] = 'H01980.A.N102.210';
  client._applyCharge(k2);
  assert.equal(row[104], 'H01980');
  assert.equal(row[377], 'REG');
  assert.equal(row[401], 'H01980.A.N102.210');
  assert.equal(row[376], '');
  assert.equal(row[400], '');
});

// captured/past-week-add/015, the K2 TC_UDT02_CHARGE_LKP OPEN_RS reply
const LOOKUP_NAMES = layout(56, {
  DESC_DISPLAY: 0,
  CHARGE_BRANCH_CD: 1,
  UDT02_ID: 5,
  UDT03_ID: 6,
  UDT10_ID: 15,
  CHARGE_CD: 24,
  CHARGE_TREE_CD: 26,
  IS_FAVORITE: 28,
  PARENT_CHG_BR_CD: 32,
  UDT02_DISPLAY: 53,
});

const LOOKUP_CAPTURE = path.join(__dirname, '../captured/past-week-add/015-res.txt');

test(
  'the charge lookup columns resolve from the capture by name',
  { skip: !fs.existsSync(LOOKUP_CAPTURE) && 'no captured/' },
  () => {
    const [names] = protocol.columnNames(fs.readFileSync(LOOKUP_CAPTURE, 'utf8'));
    assert.deepEqual(DirectClient.resolveLookupColumns(names), DirectClient.CAPTURE_LOOKUP_COL);
  }
);

test('charge lookup resolution fails loudly on a missing name', () => {
  const names = LOOKUP_NAMES.slice();
  names[1] = 'OTHER';
  assert.throws(() => DirectClient.resolveLookupColumns(names), /CHARGE_BRANCH_CD not found/);
});

// A client that skipped launch must not fall back to a stale layout
// (tecli-4mz.13 L7); stubs opt in to the capture layout explicitly.
test('a client without resolved columns throws instead of using the capture layout', () => {
  const client = Object.create(DirectClient.prototype);
  assert.throws(() => client.parentCol, /parent columns.*not resolved/i);
  assert.throws(() => client.childCol, /child columns.*not resolved/i);
});

test('the capture layout is still available to stubs that ask for it', () => {
  const client = Object.create(DirectClient.prototype);
  client.parentCol = DirectClient.CAPTURE_PARENT_COL;
  client.childCol = DirectClient.CAPTURE_CHILD_COL;
  assert.equal(client.parentCol.TS_CLOSED_FL, 685);
  assert.equal(client.childCol.PAY_TYPE, 16);
});
