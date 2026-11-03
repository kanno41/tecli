'use strict';

// In Puppeteer mode the CLI refuses features the browser client lacks before
// it starts a browser, with the same message the client would throw.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI = path.join(__dirname, '..', 'cli.js');

function run(...args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tecli-pup-'));
  const env = {
    ...process.env,
    HOME: home,
    TECLI_MOCK: '1',
    COSTPOINT_URL: 'http://127.0.0.1:9/cpweb/cploginform.htm?system=MOCK',
    COSTPOINT_USERNAME: 'mock',
    COSTPOINT_PASSWORD: 'mock',
    COSTPOINT_SYSTEM: 'MOCK',
    COSTPOINT_DIRECT: 'false',
  };
  return new Promise(resolve => {
    execFile(process.execPath, [CLI, ...args], { env, timeout: 15000 }, (err, stdout, stderr) => {
      fs.rmSync(home, { recursive: true, force: true });
      resolve({ code: err ? err.code : 0, out: stdout + stderr });
    });
  });
}

for (const [args, feature] of [
  [['favorites'], 'Favorites'],
  [['leave'], 'Leave balances'],
  [['add'], 'Picking from favorites'],
]) {
  test(`te ${args.join(' ')} refuses Puppeteer mode before logging in`, async () => {
    const { code, out } = await run(...args);
    assert.equal(code, 1);
    assert.match(out, new RegExp(feature + ' is not supported in Puppeteer mode; set COSTPOINT_DIRECT=true'));
    assert.doesNotMatch(out, /Authenticat/);
  });
}

test('te show --prev refuses Puppeteer mode before logging in', async () => {
  const { code, out } = await run('show', '--prev');
  assert.equal(code, 1);
  assert.match(out, /--prev and --back are only supported in direct mode \(COSTPOINT_DIRECT=true\)\./);
  assert.doesNotMatch(out, /Authenticat/);
});
