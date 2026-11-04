'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startMock } = require('./mock-helper');
const { scanFixture } = require('../mock/anonymize');
const fixture = require('../mock/fixture.json');
const deny = require('../mock/deny.json');

async function admin(mock, method, route) {
  const res = await fetch('http://127.0.0.1:' + mock.port + route, { method });
  return { status: res.status, text: await res.text() };
}

describe('fixture leak scan', () => {
  test('mock/fixture.json holds no real user, id or project code', () => {
    assert.deepEqual(scanFixture(fixture, deny), []);
  });

  test('the scan catches a denied token and a code-shaped value', () => {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update('secretname').digest('hex');
    assert.equal(scanFixture({ a: 'Mr Secretname' }, [hash]).length, 1);
    assert.equal(scanFixture({ a: 'G12345.A.1234.26B.200' }, []).length, 1);
    assert.equal(scanFixture({ a: 'PROJ.A.100' }, []).length, 0);
  });

  test('the committed fixture text has no real names', () => {
    const text = fs.readFileSync(path.join(__dirname, '../mock/fixture.json'), 'utf8');
    for (const word of ['parriott', 'jahsh', 'leidos', 'pirie']) {
      assert.ok(!text.toLowerCase().includes(word), word);
    }
  });
});

describe('session expiry', () => {
  test('an expired sid gets a session error, and a new login works', async () => {
    const mock = await startMock();
    try {
      const cp = await mock.launch();
      await admin(mock, 'POST', '/__mock/expire?sid=' + cp.sid);
      await assert.rejects(() => cp.set(0, 15, 1), /session not valid|Session/i);
      const fresh = await mock.launch();
      await fresh.set(0, 15, 1);
    } finally {
      await mock.stop();
    }
  });

  test('expire=all drops every session', async () => {
    const mock = await startMock();
    try {
      const a = await mock.launch();
      const b = await mock.launch();
      await admin(mock, 'POST', '/__mock/expire?sid=all');
      assert.equal(mock.sessions.size, 0);
      await assert.rejects(() => a.getLeaveBalances());
      await assert.rejects(() => b.getLeaveBalances());
    } finally {
      await mock.stop();
    }
  });

  test('a session idle past the TTL expires', async () => {
    const mock = await startMock({ sessionTtlMs: 1000 });
    try {
      let now = 1000000;
      mock.setClock(() => now);
      const cp = await mock.launch();
      now += 5000;
      await assert.rejects(() => cp.getLeaveBalances(), /session/i);
    } finally {
      await mock.stop();
    }
  });
});

describe('admin endpoints', () => {
  test('state reports periods and sessions', async () => {
    const mock = await startMock();
    try {
      await mock.launch();
      const res = await admin(mock, 'GET', '/__mock/state');
      const state = JSON.parse(res.text);
      assert.equal(state.sessions.length, 1);
      assert.equal(state.periods[0].status, 'O');
      assert.equal(state.periods[0].endDate, '2026-10-18');
    } finally {
      await mock.stop();
    }
  });

  test('reset restores the seed and drops sessions', async () => {
    const mock = await startMock();
    try {
      const cp = await mock.launch();
      await cp.sign();
      assert.equal(mock.db.period(0).status, 'S');
      await admin(mock, 'POST', '/__mock/reset');
      assert.equal(mock.db.period(0).status, 'O');
      assert.equal(mock.sessions.size, 0);
    } finally {
      await mock.stop();
    }
  });

  test('unknown admin routes are 404', async () => {
    const mock = await startMock();
    try {
      assert.equal((await admin(mock, 'GET', '/__mock/nope')).status, 404);
    } finally {
      await mock.stop();
    }
  });
});

describe('state file', () => {
  test('state survives a restart and reset deletes it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-state-'));
    const stateFile = path.join(dir, 'state.json');
    try {
      let mock = await startMock({ stateFile });
      let cp = await mock.launch();
      await cp.sign();
      await mock.stop();

      mock = await startMock({ stateFile });
      cp = await mock.launch();
      assert.equal(cp.getData().timesheetStatusCode, 'S');
      await admin(mock, 'POST', '/__mock/reset');
      assert.ok(!fs.existsSync(stateFile));
      await mock.stop();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
