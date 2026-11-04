'use strict';

// Runs server.js against the mock for web UI tests.

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function startWeb(mock, extraEnv = {}) {
  const port = await freePort();
  // cwd and HOME in a temp dir: no .env from the repo, no real cache file
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tecli-web-'));
  const child = spawn(process.execPath, [SERVER], {
    cwd: home,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      TECLI_MOCK: '1',
      COSTPOINT_URL: mock.url,
      COSTPOINT_USERNAME: 'mock',
      COSTPOINT_PASSWORD: 'mock',
      COSTPOINT_DIRECT: 'true',
      PORT: String(port),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => (log += d));
  child.stderr.on('data', d => (log += d));
  const web = {
    port,
    home,
    base: 'http://127.0.0.1:' + port,
    log: () => log,
    stop: () =>
      new Promise(resolve => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', resolve);
        child.kill();
      }).then(() => fs.rmSync(home, { recursive: true, force: true })),
  };
  const deadline = Date.now() + 15000;
  while (!/running at/.test(log)) {
    if (child.exitCode !== null) throw new Error('server.js exited: ' + log);
    if (Date.now() > deadline) throw new Error('server.js did not start: ' + log);
    await new Promise(r => setTimeout(r, 50));
  }
  return web;
}

async function pageToken(web) {
  const html = await (await fetch(web.base + '/')).text();
  const m = html.match(/name="tecli-token" content="([0-9a-f]+)"/);
  return m ? m[1] : null;
}

async function waitForData(web, token) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const res = await fetch(web.base + '/api/status', { headers: { 'X-Tecli-Token': token || '' } });
    if (res.ok && (await res.json()).hasData) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('web UI never loaded data: ' + web.log());
}

module.exports = { startWeb, pageToken, waitForData };
