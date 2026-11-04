'use strict';

// Runs server.js against the mock and checks that the web UI only answers
// its own page: loopback listener, per-launch token, Host/Origin checks.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const { startMock } = require('./mock-helper');
const { startWeb, pageToken, waitForData } = require('./web-helper');

const EVIL = 'https://evil.example';

function nonLoopbackIPv4() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

async function mockState(mock) {
  const res = await fetch('http://127.0.0.1:' + mock.port + '/__mock/state');
  return res.json();
}

describe('web UI request guard', () => {
  let mock;
  let web;
  let token;

  before(async () => {
    mock = await startMock();
    web = await startWeb(mock);
    token = await pageToken(web);
    await waitForData(web, token);
  });
  after(async () => {
    if (web) await web.stop();
    if (mock) await mock.stop();
  });

  test('listens on 127.0.0.1 only', async () => {
    assert.match(web.log(), /running at http:\/\/127\.0\.0\.1:\d+/);
    const ip = nonLoopbackIPv4();
    if (!ip) return;
    await assert.rejects(
      () => fetch('http://' + ip + ':' + web.port + '/api/status', { signal: AbortSignal.timeout(2000) }),
      /fetch failed|aborted|timeout/i
    );
  });

  test('a cross-site text/plain POST to /api/sign is refused and signs nothing', async () => {
    const res = await fetch(web.base + '/api/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: EVIL },
    });
    assert.ok(res.status >= 400 && res.status < 500, 'status ' + res.status);
    assert.equal((await mockState(mock)).periods[0].status, 'O');
  });

  for (const [method, route] of [
    ['POST', '/api/save'],
    ['DELETE', '/api/cache'],
    ['GET', '/api/refresh'],
  ]) {
    test(`${method} ${route} from a foreign Origin is refused`, async () => {
      const res = await fetch(web.base + route, { method, headers: { Origin: EVIL } });
      assert.ok(res.status >= 400 && res.status < 500, 'status ' + res.status);
    });

    test(`${method} ${route} without the page token is refused`, async () => {
      const res = await fetch(web.base + route, { method });
      assert.ok(res.status >= 400 && res.status < 500, 'status ' + res.status);
    });
  }

  test('a foreign Origin is refused even with the token', async () => {
    const res = await fetch(web.base + '/api/status', { headers: { 'X-Tecli-Token': token, Origin: EVIL } });
    assert.equal(res.status, 403);
  });

  test('a foreign Host (DNS rebinding) cannot read the page', async () => {
    // fetch() does not let the caller set Host
    const { status, body } = await new Promise((resolve, reject) => {
      const req = http.get(
        { host: '127.0.0.1', port: web.port, path: '/', headers: { Host: 'evil.example:' + web.port } },
        res => {
          let body = '';
          res.on('data', d => (body += d));
          res.on('end', () => resolve({ status: res.statusCode, body }));
        }
      );
      req.on('error', reject);
    });
    assert.equal(status, 403);
    assert.doesNotMatch(body, /tecli-token/);
  });

  test('POST /api/sign without a period is a 400 and signs nothing', async () => {
    const res = await fetch(web.base + '/api/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tecli-Token': token, Origin: web.base },
      body: '{}',
    });
    assert.equal(res.status, 400);
    assert.equal((await mockState(mock)).periods[0].status, 'O');
  });

  test("the page's own requests work: token header, same Origin", async () => {
    const headers = { 'Content-Type': 'application/json', 'X-Tecli-Token': token, Origin: web.base };
    const refresh = await fetch(web.base + '/api/refresh', { headers });
    assert.equal(refresh.status, 200);
    const save = await fetch(web.base + '/api/save', { method: 'POST', headers });
    assert.equal(save.status, 200);
    const sign = await fetch(web.base + '/api/sign', { method: 'POST', headers, body: '{"period":0}' });
    assert.equal(sign.status, 200, await sign.text());
    assert.equal((await mockState(mock)).periods[0].status, 'S');
  });

  test('the token in the page differs per launch', async () => {
    const other = await startWeb(mock);
    try {
      const second = await pageToken(other);
      assert.ok(token && second);
      assert.notEqual(second, token);
    } finally {
      await other.stop();
    }
  });
});
