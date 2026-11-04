'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startMock } = require('./mock-helper');

describe('mock sign', () => {
  let mock;
  beforeEach(async () => {
    mock = await startMock();
  });
  afterEach(() => mock.stop());

  test('a fresh session signs the active week', async () => {
    const cp = await mock.launch();
    await cp.sign();
    assert.equal(cp.getData().timesheetStatusCode, 'S');
    const again = await mock.launch();
    assert.equal(again.getData().timesheetStatusCode, 'S');
  });

  test('a worked session throws "did not take effect" and leaves the week open', async () => {
    const cp = await mock.launch();
    await cp.set(0, 15, 7);
    await cp.save();
    await assert.rejects(() => cp.sign(), /did not take effect/);
    assert.equal((await mock.launch()).getData().timesheetStatusCode, 'O');
  });

  test('without the sign-poison quirk a worked session signs', async () => {
    await mock.stop();
    mock = await startMock({ quirks: 'auto-required,favorites-primer' });
    const cp = await mock.launch();
    await cp.set(0, 15, 7);
    await cp.save();
    await cp.sign();
    assert.equal(cp.getData().timesheetStatusCode, 'S');
  });

  test('a signed week is refused up front', async () => {
    const cp = await mock.launch();
    await cp.selectPeriod(2);
    await assert.rejects(() => cp.sign(), /does not allow signing/);
  });

  test('a processed week is refused up front', async () => {
    const cp = await mock.launch();
    await cp.selectPeriod(1);
    await assert.rejects(() => cp.sign(), /does not allow signing/);
  });

  test('a corrected past week signs after selectPeriod on a fresh session', async () => {
    const edit = await mock.launch();
    await edit.selectPeriod(1);
    await edit.set(0, 5, 4);
    await assert.rejects(() => edit.save(), { name: 'RevisionRequiredError' });
    await edit.saveWithExplanation('late correction');

    const cp = await mock.launch();
    await cp.selectPeriod(1);
    assert.equal(cp.getData().timesheetStatusCode, 'O');
    await cp.sign();
    assert.equal(cp.getData().timesheetStatusCode, 'S');
    const again = await mock.launch();
    await again.selectPeriod(1);
    assert.equal(again.getData().timesheetStatusCode, 'S');
  });
});
