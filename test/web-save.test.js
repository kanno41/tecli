'use strict';

// A multi-week save where one week fails must say which weeks were saved, so
// the page clears only those and a retry resends only the failed week
// (tecli-4mz.6).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startMock, hoursOf } = require('./mock-helper');
const { startWeb, pageToken, waitForData } = require('./web-helper');
const pending = require('../public/pending');

describe('web UI save with a failing older week', () => {
  let mock;
  let web;
  let headers;

  const api = (route, body) =>
    fetch(web.base + route, { method: body ? 'PUT' : 'POST', headers, body: body && JSON.stringify(body) });

  before(async () => {
    mock = await startMock();
    web = await startWeb(mock);
    const token = await pageToken(web);
    headers = { 'Content-Type': 'application/json', 'X-Tecli-Token': token, Origin: web.base };
    await waitForData(web, token);
  });
  after(async () => {
    if (web) await web.stop();
    if (mock) await mock.stop();
  });

  test('the page loads pending.js before app.js', async () => {
    const html = await (await fetch(web.base + '/')).text();
    assert.ok(html.indexOf('/pending.js') > 0 && html.indexOf('/pending.js') < html.indexOf('/app.js'));
    assert.equal((await fetch(web.base + '/pending.js')).status, 200);
  });

  test('/api/save names the saved and the failed period', async () => {
    assert.equal((await api('/api/hours', { period: 0, periodLine: 0, day: 15, hours: 6 })).status, 200);
    assert.equal((await api('/api/hours', { period: 1, periodLine: 0, day: 6, hours: 3 })).status, 200);
    mock.failSave(1, 'Older week rejected');

    const res = await api('/api/save');
    const body = await res.json();
    assert.equal(res.status, 500);
    assert.match(body.error, /Older week rejected/);
    assert.deepEqual(body.saved, [0]);
    assert.equal(body.failed, 1);

    const current = await mock.launch();
    assert.equal(hoursOf(current.getData(), 0, 15), 6);
  });

  test('a retry saves only the failed week', async () => {
    const status = await (await fetch(web.base + '/api/status', { headers })).json();
    assert.equal(status.pendingChanges, 1);

    // The older week was signed before, so its save asks for an explanation;
    // the audit lists only its own cell, not the week already saved
    const retry = await (await api('/api/save')).json();
    assert.equal(retry.revisionRequired, true);
    assert.equal(retry.period, 1);
    assert.deepEqual(retry.saved, []);
    assert.deepEqual(
      retry.auditDetails.map(d => d.date),
      ['2026-10-06']
    );

    const res = await fetch(web.base + '/api/save-with-explanation', {
      method: 'POST',
      headers,
      body: JSON.stringify({ explanation: 'retry' }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.deepEqual(body.saved, [1]);

    const older = await mock.launch({ loadPreviousPeriod: true });
    assert.equal(hoursOf(older.getPreviousPeriodData(), 0, 6), 3);
  });
});

describe('page pending changes', () => {
  const change = (week, line, day, hours) => ({ week: String(week), line, day, hours, periodLine: '0' });

  test('cells are keyed by week, line and day', () => {
    assert.notEqual(pending.cellKey('0', 3, 5), pending.cellKey('1', 3, 5));
    assert.equal(pending.cellKey('1', 3, 5), pending.cellKey(1, 3, 5));
  });

  test('a partial save settles only the saved week', () => {
    const changes = new Map();
    for (const c of [change(0, 0, 15, '6'), change(0, 1, 16, '2'), change(1, 0, 6, '3')]) {
      changes.set(pending.cellKey(c.week, c.line, c.day), c);
    }
    const settled = pending.takeSaved(changes, [0]);
    assert.deepEqual(
      settled.map(([key]) => key),
      [pending.cellKey(0, 0, 15), pending.cellKey(0, 1, 16)]
    );
    // What a retry sends
    assert.deepEqual(Array.from(changes.values()), [change(1, 0, 6, '3')]);
  });

  test('no saved period settles nothing', () => {
    const changes = new Map([[pending.cellKey(1, 0, 6), change(1, 0, 6, '3')]]);
    assert.deepEqual(pending.takeSaved(changes, undefined), []);
    assert.equal(changes.size, 1);
  });
});
