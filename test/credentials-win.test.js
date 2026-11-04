'use strict';

// The Windows DPAPI path cannot run here, so PowerShell is stubbed. These
// tests pin how credentials.js talks to it: the stored blob goes in on stdin,
// never into the -Command string, and the credential file is owner-only.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE = require.resolve('../credentials');

describe('Windows DPAPI credentials', () => {
  let home;
  let savedHome;
  let calls;
  let creds;

  // credentials.js reads the home directory and binds execFileSync at load,
  // so each test loads a fresh copy after pointing both at the test doubles.
  function load(t, reply) {
    calls = [];
    t.mock.method(childProcess, 'execFileSync', (file, args, options) => {
      calls.push({ file, args, options });
      return reply;
    });
    delete require.cache[MODULE];
    creds = require(MODULE);
  }

  beforeEach(() => {
    savedHome = process.env.HOME;
    fs.mkdirSync('/tmp/steward-tecli-creds', { recursive: true });
    home = fs.mkdtempSync(path.join('/tmp/steward-tecli-creds', 'home-'));
    process.env.HOME = home;
    assert.equal(os.homedir(), home);
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    delete require.cache[MODULE];
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('_winGet passes the stored blob on stdin, not in -Command', t => {
    const blob = "01000000d08c9ddf'; Write-Output 'pwned"; // a tampered file
    fs.writeFileSync(path.join(home, '.tecli-credentials'), JSON.stringify({ account: 'me', dpapi: blob }));
    load(t, 'secret\n');

    assert.equal(creds._winGet('me'), 'secret');
    assert.equal(calls.length, 1);
    const { file, args, options } = calls[0];
    assert.equal(file, 'powershell.exe');
    assert.equal(options.input, blob);
    for (const arg of args) {
      assert.ok(!arg.includes(blob), `argument carries the blob: ${arg}`);
      assert.ok(!arg.includes('01000000d08c9ddf'), `argument carries file content: ${arg}`);
    }
  });

  test('_winGet ignores a file for another account', t => {
    fs.writeFileSync(path.join(home, '.tecli-credentials'), JSON.stringify({ account: 'other', dpapi: 'x' }));
    load(t, 'secret');

    assert.equal(creds._winGet('me'), null);
    assert.equal(calls.length, 0);
  });

  test('_winSet writes the credential file owner-only', t => {
    load(t, 'ENCRYPTED\n');

    creds._winSet('me', 'hunter2');
    const file = path.join(home, '.tecli-credentials');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { account: 'me', dpapi: 'ENCRYPTED' });
    assert.equal(calls[0].options.input, 'hunter2');
  });

  test('_winSet tightens a credential file left readable by an older version', t => {
    const file = path.join(home, '.tecli-credentials');
    fs.writeFileSync(file, '{}', { mode: 0o644 });
    load(t, 'ENCRYPTED\n');

    creds._winSet('me', 'hunter2');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});
