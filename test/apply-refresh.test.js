'use strict';

// _applyRefresh: a 204 refresh replaces the parent (K0) and child (K1) rows
// it carries and keeps the ones it lacks.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../protocol');
const codec = require('../mock/codec');
const DirectClient = require('../direct');

const slot = (rowNum, cell) => codec.encode204Slot({ rowNums: [rowNum], rowFlags: [0], rows: [[cell, 'x']] }, 2);
const frame = (rsKey, s) => ({ rsKey, cmdCd: 204, slot: s });
const parse = (...items) => protocol.parseResponse(codec.buildResponse(items));

function client() {
  const cp = Object.create(DirectClient.prototype);
  cp.parentData = { rowNums: ['0'], rowFlags: [0], rows: [['old-parent', 'x']] };
  cp.childData = { rowNums: ['1'], rowFlags: [0], rows: [['old-child', 'x']] };
  return cp;
}

test('replaces both when K0 and K1 come back', () => {
  const cp = client();
  assert.equal(cp._applyRefresh(parse(frame(0, slot('0', 'p')), frame(1, slot('5', 'c')))), true);
  assert.deepEqual(cp.parentData.rows, [['p', 'x']]);
  assert.deepEqual(cp.childData.rowNums, ['5']);
  assert.deepEqual(cp.childData.rows, [['c', 'x']]);
});

test('keeps the child rows when only K0 comes back', () => {
  const cp = client();
  assert.equal(cp._applyRefresh(parse(frame(0, slot('0', 'p')), frame(1))), false);
  assert.deepEqual(cp.parentData.rows, [['p', 'x']]);
  assert.deepEqual(cp.childData.rows, [['old-child', 'x']]);
});

test('keeps the parent rows when only K1 comes back', () => {
  const cp = client();
  assert.equal(cp._applyRefresh(parse(frame(0), frame(1, slot('5', 'c')))), true);
  assert.deepEqual(cp.parentData.rows, [['old-parent', 'x']]);
  assert.deepEqual(cp.childData.rows, [['c', 'x']]);
});

test('keeps both when no rows come back', () => {
  const cp = client();
  assert.equal(cp._applyRefresh(parse(frame(0), frame(1))), false);
  assert.deepEqual(cp.parentData.rows, [['old-parent', 'x']]);
  assert.deepEqual(cp.childData.rows, [['old-child', 'x']]);
});
