'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRevisionHold } = require('../session');
const DirectClient = require('../direct');

const revisionError = () => new DirectClient.RevisionRequiredError([]);

test('starts with nothing held', () => {
  const hold = createRevisionHold();
  assert.equal(hold.held, false);
  assert.equal(hold.period, null);
});

test('hold() remembers the period of a save that needs an explanation', () => {
  const hold = createRevisionHold();
  assert.equal(hold.hold(revisionError(), 2), true);
  assert.equal(hold.held, true);
  assert.equal(hold.period, 2);
});

test('hold() ignores any other error and keeps what was held', () => {
  const hold = createRevisionHold();
  assert.equal(hold.hold(new Error('Account required'), 1), false);
  assert.equal(hold.held, false);
  hold.hold(revisionError(), 0);
  assert.equal(hold.hold(new Error('later failure'), 3), false);
  assert.equal(hold.period, 0);
});

test('hold() matches by name, like a Puppeteer-mode error', () => {
  const hold = createRevisionHold();
  const e = new Error('explanation');
  e.name = 'RevisionRequiredError';
  assert.equal(hold.hold(e, 1), true);
});

test('clear() drops the hold', () => {
  const hold = createRevisionHold();
  hold.hold(revisionError(), 1);
  hold.clear();
  assert.equal(hold.held, false);
  assert.equal(hold.period, null);
});

test('finish() runs the save for the held period and then clears it', async () => {
  const hold = createRevisionHold();
  hold.hold(revisionError(), 1);
  const seen = [];
  const result = await hold.finish(async period => {
    seen.push(period);
    assert.equal(hold.period, 1, 'still held while the save runs');
    return 'saved';
  });
  assert.equal(result, 'saved');
  assert.deepEqual(seen, [1]);
  assert.equal(hold.held, false);
});

test('a failed finish() keeps the hold', async () => {
  const hold = createRevisionHold();
  hold.hold(revisionError(), 1);
  await assert.rejects(
    hold.finish(async () => {
      throw new Error('Timesheet is read only');
    }),
    /read only/
  );
  assert.equal(hold.period, 1);
});

test('a hold cleared while finish() runs stays cleared', async () => {
  const hold = createRevisionHold();
  hold.hold(revisionError(), 1);
  await assert.rejects(
    hold.finish(async () => {
      hold.clear();
      throw new Error('released');
    })
  );
  assert.equal(hold.held, false);
});

test('finish() with nothing held throws before running the save', async () => {
  const hold = createRevisionHold();
  let ran = false;
  await assert.rejects(
    hold.finish(async () => {
      ran = true;
    }),
    /No save is waiting on a revision explanation/
  );
  assert.equal(ran, false);
});

test('assertHeld() throws only with nothing held', () => {
  const hold = createRevisionHold();
  assert.throws(() => hold.assertHeld(), /No save is waiting on a revision explanation/);
  hold.hold(revisionError(), 0);
  hold.assertHeld();
});
