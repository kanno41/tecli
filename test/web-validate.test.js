'use strict';

// The web UI rejects bad cell edits before queueing them and keeps its cache
// file private (tecli-4mz.13 L1-L3).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startMock } = require('./mock-helper');
const { startWeb, pageToken, waitForData } = require('./web-helper');

describe('web UI edit validation', () => {
  let mock;
  let web;
  let headers;

  const put = (route, body) => fetch(web.base + route, { method: 'PUT', headers, body: JSON.stringify(body) });
  const pendingCount = async () => (await (await fetch(web.base + '/api/status', { headers })).json()).pendingChanges;

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

  for (const hours of [-1, 25, 1e9, 'abc', null, '8x']) {
    test(`hours ${JSON.stringify(hours)} is a 400 and queues nothing`, async () => {
      const res = await put('/api/hours', { period: 0, periodLine: 0, day: 15, hours });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /hours/i);
      assert.equal(await pendingCount(), 0);
    });
  }

  for (const periodLine of [99, 'abc', -1, 1.5]) {
    for (const route of ['/api/hours', '/api/comment']) {
      test(`${route} with periodLine ${JSON.stringify(periodLine)} is a 400 and queues nothing`, async () => {
        const res = await put(route, { period: 0, periodLine, day: 15, hours: 4, comment: 'x' });
        assert.equal(res.status, 400);
        assert.equal(await pendingCount(), 0);
      });
    }
  }

  test('valid hours, including blank and 24, are queued', async () => {
    for (const hours of ['', 0, 4.5, 24]) {
      assert.equal((await put('/api/hours', { period: 0, periodLine: 0, day: 15, hours })).status, 200);
    }
    assert.equal(await pendingCount(), 1);
  });

  test('the cache file is readable by the owner only', () => {
    const file = path.join(web.home, '.costpoint-cache.json');
    assert.ok(fs.existsSync(file));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});
