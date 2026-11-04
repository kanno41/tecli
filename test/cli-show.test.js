'use strict';

// te show against the mock: the week total and signed state follow the status.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startMock } = require('./mock-helper');

const CLI = path.join(__dirname, '..', 'cli.js');

describe('te show', () => {
  let mock;
  let home;

  before(async () => {
    mock = await startMock();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tecli-show-'));
  });

  after(async () => {
    await mock.stop();
    fs.rmSync(home, { recursive: true, force: true });
  });

  // Async so the in-process mock keeps serving while the CLI runs
  const show = (...args) =>
    new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [CLI, 'show', ...args],
        {
          cwd: home,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            TECLI_MOCK: '1',
            COSTPOINT_URL: mock.url,
            COSTPOINT_USERNAME: 'mock',
            COSTPOINT_PASSWORD: 'mock',
            COSTPOINT_DIRECT: 'true',
          },
          timeout: 20000,
        },
        (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout))
      );
    });

  test('prints the week total and that the current week is not signed', async () => {
    assert.match(await show(), /Signed: no \| Week total: 41\.5h/);
  });

  test('a signed past week says so', async () => {
    assert.match(await show('--back', '2'), /Signed: yes \| Week total: 39\.5h/);
  });
});
