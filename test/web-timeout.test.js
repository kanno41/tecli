'use strict';

// A Costpoint request that never answers must fail the web UI operation and
// free it for the next one, not leave isProcessing stuck (tecli-4mz.8).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startMock, hoursOf } = require('./mock-helper');
const { startWeb, pageToken, waitForData } = require('./web-helper');

describe('web UI after a Costpoint timeout', () => {
  let mock;
  let web;
  let headers;

  const api = (route, body) =>
    fetch(web.base + route, { method: body ? 'PUT' : 'POST', headers, body: body && JSON.stringify(body) });

  before(async () => {
    mock = await startMock();
    web = await startWeb(mock, { COSTPOINT_TIMEOUT_MS: '1000' });
    const token = await pageToken(web);
    headers = { 'Content-Type': 'application/json', 'X-Tecli-Token': token, Origin: web.base };
    await waitForData(web, token);
  });
  after(async () => {
    if (web) await web.stop();
    if (mock) await mock.stop();
  });

  test('a stalled save times out and the next save goes through', { timeout: 15000 }, async () => {
    assert.equal((await api('/api/hours', { period: 0, periodLine: 0, day: 15, hours: 5 })).status, 200);
    mock.stall(1);

    const res = await api('/api/save');
    const body = await res.json();
    assert.equal(res.status, 500);
    assert.match(body.error, /timed out/);
    assert.deepEqual(body.saved, []);
    assert.equal(body.failed, 0);

    const status = await (await fetch(web.base + '/api/status', { headers })).json();
    assert.equal(status.pendingChanges, 1);

    const retry = await api('/api/save');
    const retryBody = await retry.json();
    assert.equal(retry.status, 200, JSON.stringify(retryBody));
    assert.deepEqual(retryBody.saved, [0]);

    const current = await mock.launch();
    assert.equal(hoursOf(current.getData(), 0, 15), 5);
  });
});
