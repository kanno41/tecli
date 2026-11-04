'use strict';

// promptSecret reads a password in raw mode. A pasted chunk can carry the
// whole line, and Ctrl+C must reject instead of exiting the process
// (tecli-4mz.13 L9).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('stream');
const { promptSecret } = require('../credentials');

function fakeTTY() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = mode => {
    input.isRaw = mode;
  };
  return input;
}

const quietly = fn => async t => {
  t.mock.method(process.stderr, 'write', () => true);
  await fn();
};

test(
  'a pasted chunk ending in \\r resolves with the text before it',
  { timeout: 2000 },
  quietly(async () => {
    const input = fakeTTY();
    const result = promptSecret('Password: ', input);
    input.write('hunter2\r');
    assert.equal(await result, 'hunter2');
    assert.equal(input.isRaw, false);
  })
);

test(
  'a pasted chunk with \\r\\n and trailing text stops at the line end',
  { timeout: 2000 },
  quietly(async () => {
    const input = fakeTTY();
    const result = promptSecret('Password: ', input);
    input.write('pa');
    input.write('ss\r\nrest');
    assert.equal(await result, 'pass');
  })
);

test(
  'backspace inside a chunk removes the previous character',
  { timeout: 2000 },
  quietly(async () => {
    const input = fakeTTY();
    const result = promptSecret('Password: ', input);
    input.write('abx\u007fc\n');
    assert.equal(await result, 'abc');
  })
);

test(
  'Ctrl+C rejects and restores the terminal instead of exiting',
  { timeout: 2000 },
  quietly(async () => {
    const input = fakeTTY();
    const original = process.exit;
    process.exit = code => {
      throw new Error('process.exit(' + code + ') called');
    };
    try {
      const result = promptSecret('Password: ', input);
      input.write('ab\u0003');
      await assert.rejects(result, /cancelled/i);
      assert.equal(input.isRaw, false);
    } finally {
      process.exit = original;
    }
  })
);
