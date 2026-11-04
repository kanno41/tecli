'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startMock } = require('./mock-helper');

describe('mock server skeleton', () => {
  let mock;
  before(async () => {
    mock = await startMock();
  });
  after(() => mock.stop());

  test('DirectClient launches and reads the active week', async () => {
    const cp = await mock.launch();
    const data = cp.getData();
    assert.equal(data.timesheetStatusCode, 'O');
    assert.equal(data.editable, true);
    assert.equal(data.dates[0].fullDate, '2026-10-12');
    assert.equal(data.dates[6].fullDate, '2026-10-18');
    assert.equal(data.projects.length, 2);
    assert.equal(data.projects[0].code, 'PROJ.A.100');
    assert.equal(data.projects[0].hours[12], 8);
    assert.equal(data.projects[0].hours[17], null);
    assert.equal(data.payPeriodWeek, 1);
  });

  test('each login gets its own session id', async () => {
    const a = await mock.launch();
    const b = await mock.launch();
    assert.notEqual(a.sid, b.sid);
    assert.ok(mock.sessions.has(a.sid));
    assert.ok(mock.sessions.has(b.sid));
  });
});

describe('mock server login', () => {
  test('rejects a wrong password when one is configured', async () => {
    const mock = await startMock({ password: 'secret' });
    try {
      await assert.rejects(() => mock.launch(undefined, { password: 'nope' }), /LOGININFO failed/);
      const cp = await mock.launch(undefined, { password: 'secret' });
      assert.equal(cp.getData().timesheetStatusCode, 'O');
    } finally {
      await mock.stop();
    }
  });

  test('rejects a wrong user when one is configured', async () => {
    const mock = await startMock({ user: 'jane', password: 'secret' });
    try {
      await assert.rejects(() => mock.launch(undefined, { user: 'bob', password: 'secret' }), /LOGININFO failed/);
      await mock.launch(undefined, { user: 'jane', password: 'secret' });
    } finally {
      await mock.stop();
    }
  });
});
