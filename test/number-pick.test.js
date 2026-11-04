#!/usr/bin/env node
'use strict';

// Numbered-list selection typed one digit at a time (TUI favorites and
// add-project menu).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { addDigit, confirm } = require('../number-pick');

function type(digits, count) {
  let buffer = '';
  let last;
  for (const d of digits) {
    last = addDigit(buffer, d, count);
    buffer = last.buffer;
  }
  return last;
}

test('a single digit picks at once when no two-digit entry exists', () => {
  assert.deepEqual(addDigit('', '1', 9), { pick: 1, buffer: '' });
  assert.deepEqual(addDigit('', '9', 9), { pick: 9, buffer: '' });
});

test('"1" waits for a second digit when there are 10 or more entries', () => {
  assert.deepEqual(addDigit('', '1', 12), { pick: null, buffer: '1' });
});

test('two digits reach entries 10 and up', () => {
  assert.equal(type('10', 12).pick, 10);
  assert.equal(type('12', 12).pick, 12);
});

test('a digit with no possible longer match picks at once', () => {
  assert.equal(addDigit('', '2', 12).pick, 2);
  assert.equal(addDigit('', '2', 25).pick, null);
});

test('Enter confirms a pending number', () => {
  assert.equal(confirm('1', 12), 1);
  assert.equal(confirm('', 12), null);
  assert.equal(confirm('13', 12), null);
});

test('an out-of-range number resets the buffer and reports what was typed', () => {
  assert.deepEqual(type('15', 12), { pick: null, buffer: '', invalid: '15' });
  assert.deepEqual(addDigit('', '7', 6), { pick: null, buffer: '', invalid: '7' });
});
