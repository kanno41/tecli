'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startMock } = require('./mock-helper');
const DirectClient = require('../direct');

const { RevisionRequiredError } = DirectClient;

describe('mock edit and save', () => {
  let mock;
  beforeEach(async () => {
    mock = await startMock();
  });
  afterEach(() => mock.stop());

  test('set + save persists for a new session', async () => {
    const cp = await mock.launch();
    await cp.set(0, 15, 6, 'half day');
    assert.equal(cp.getData().projects[0].hours[15], 6);
    await cp.save();
    const again = await mock.launch();
    const data = again.getData();
    assert.equal(data.projects[0].hours[15], 6);
    assert.equal(data.projects[0].comments[15], 'half day');
  });

  test('an unsaved edit is not visible to another session', async () => {
    const cp = await mock.launch();
    await cp.set(0, 15, 2);
    const other = await mock.launch();
    assert.equal(other.getData().projects[0].hours[15], 8);
  });

  test('clearing a cell saves as empty', async () => {
    const cp = await mock.launch();
    await cp.set(0, 15, 0);
    await cp.save();
    assert.equal((await mock.launch()).getData().projects[0].hours[15], 0);
  });

  test('an open week saves without an explanation', async () => {
    const cp = await mock.launch();
    await cp.set(1, 13, 3);
    await cp.save();
    assert.equal(cp.getData().projects[1].hours[13], 3);
  });

  test('a signed week asks for a revision explanation', async () => {
    const cp = await mock.launch();
    await cp.selectPeriod(2);
    await cp.set(0, 28, 9);
    await assert.rejects(
      () => cp.save(),
      err => {
        assert.ok(err instanceof RevisionRequiredError);
        assert.equal(err.auditDetails.length, 1);
        assert.match(err.auditDetails[0].description, /from 6 to 9/);
        return true;
      }
    );
    await cp.saveWithExplanation('fixing hours');
    const again = await mock.launch();
    await again.selectPeriod(2);
    assert.equal(again.getData().projects[0].hours[28], 9);
    assert.equal(mock.db.period(2).revisions.at(-1).explanation, 'fixing hours');
  });

  test('editing a processed week runs Correct, then needs an explanation', async () => {
    const cp = await mock.launch();
    await cp.selectPeriod(1);
    await cp.set(0, 5, 4);
    assert.equal(cp.getData().timesheetStatusCode, 'O');
    await assert.rejects(() => cp.save(), RevisionRequiredError);
    await cp.saveWithExplanation('late correction');
    const again = await mock.launch();
    await again.selectPeriod(1);
    const data = again.getData();
    assert.equal(data.timesheetStatusCode, 'O');
    assert.equal(data.projects[0].hours[5], 4);
  });

  test('a week with no Correct right refuses edits', async () => {
    mock.db.period(1).correctable = false;
    const cp = await mock.launch();
    await cp.selectPeriod(1);
    assert.equal(cp.getData().editable, false);
    await assert.rejects(() => cp.set(0, 5, 4), /does not allow correcting/);
  });

  test('a stale Correct response is recovered by re-fetching', async () => {
    await mock.stop();
    mock = await startMock({ quirks: 'sign-poison,auto-required,favorites-primer,correct-stale' });
    const cp = await mock.launch();
    await cp.selectPeriod(1);
    await cp.set(0, 5, 4);
    assert.equal(cp.getData().timesheetStatusCode, 'O');
  });
});

// Live (tecli-lok): a past-week save answered without row data was followed
// by a re-read with no R=AUTO fetch, which read the active week's lines
describe('past-week save with a row-less reply', () => {
  let mock;
  beforeEach(async () => {
    mock = await startMock();
    Object.assign(mock.db.period(1), { status: 'O', closed: false, signedOnce: false });
  });
  afterEach(() => mock.stop());

  test('re-reads the past week, not the active one', async () => {
    const cp = await mock.launch();
    await cp.selectPeriod(1);
    const before = cp.getData().projects.map(p => p.hours);
    assert.equal(before[0][5], 7.5);
    await cp.set(0, 5, 7.5);
    mock.rowlessSave();
    await cp.save();
    const data = cp.getData();
    assert.equal(data.dates[0].fullDate, '2026-10-05');
    assert.deepEqual(
      data.projects.map(p => p.hours),
      before
    );
  });

  test('sends no second save', async () => {
    const cp = await mock.launch();
    await cp.selectPeriod(1);
    await cp.set(0, 5, 7.5);
    mock.rowlessSave();
    const writes = cp.writesSent;
    await cp.save();
    assert.equal(cp.writesSent, writes + 1);
  });
});
