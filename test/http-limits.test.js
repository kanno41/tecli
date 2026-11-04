'use strict';

// A stalled or runaway gateway must fail a DirectClient request instead of
// hanging every interface (tecli-4mz.8).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const DirectClient = require('../direct');

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function stop(server) {
  server.closeAllConnections();
  return new Promise(resolve => server.close(resolve));
}

const urlOf = server => 'http://127.0.0.1:' + server.address().port + '/cpweb/cploginform.htm?system=T';

describe('DirectClient HTTP limits', () => {
  let saved;
  before(() => {
    saved = process.env.COSTPOINT_TIMEOUT_MS;
  });
  after(() => {
    if (saved === undefined) delete process.env.COSTPOINT_TIMEOUT_MS;
    else process.env.COSTPOINT_TIMEOUT_MS = saved;
  });

  test('a request to a server that never answers times out', { timeout: 5000 }, async () => {
    process.env.COSTPOINT_TIMEOUT_MS = '200';
    const server = await listen(() => {});
    const start = Date.now();
    try {
      await assert.rejects(DirectClient.launch(urlOf(server), 'u', 'p'), err => {
        assert.match(err.message, /Costpoint request timed out after 0\.2 s/);
        assert.equal(err.code, 'ETIMEDOUT');
        return true;
      });
      assert.ok(Date.now() - start < 2000, 'took ' + (Date.now() - start) + ' ms');
    } finally {
      await stop(server);
    }
  });

  test('the deadline covers a response that trickles in', { timeout: 5000 }, async () => {
    process.env.COSTPOINT_TIMEOUT_MS = '300';
    const timers = [];
    const server = await listen((req, res) => {
      res.writeHead(200);
      timers.push(setInterval(() => res.write('x'), 50));
    });
    try {
      await assert.rejects(DirectClient.launch(urlOf(server), 'u', 'p'), /timed out/);
    } finally {
      timers.forEach(clearInterval);
      await stop(server);
    }
  });

  test('an oversized response is refused', { timeout: 10000 }, async () => {
    process.env.COSTPOINT_TIMEOUT_MS = '5000';
    const chunk = Buffer.alloc(1024 * 1024, 'x');
    const server = await listen((req, res) => {
      res.writeHead(200);
      let sent = 0;
      const pump = () => {
        while (sent <= DirectClient.MAX_RESPONSE_BYTES && res.write(chunk)) sent += chunk.length;
        if (sent <= DirectClient.MAX_RESPONSE_BYTES) res.once('drain', pump);
        else res.end();
      };
      pump();
    });
    try {
      await assert.rejects(DirectClient.launch(urlOf(server), 'u', 'p'), /Costpoint response exceeded 20 MB/);
    } finally {
      await stop(server);
    }
  });

  test('the timeout defaults to 60 s and ignores a bad value', () => {
    delete process.env.COSTPOINT_TIMEOUT_MS;
    assert.equal(DirectClient.requestTimeoutMs(), 60000);
    process.env.COSTPOINT_TIMEOUT_MS = 'soon';
    assert.equal(DirectClient.requestTimeoutMs(), 60000);
    process.env.COSTPOINT_TIMEOUT_MS = '1500';
    assert.equal(DirectClient.requestTimeoutMs(), 1500);
  });
});
