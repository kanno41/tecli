'use strict';

// The Linux keychain path: secret-tool first, the AES file in
// ~/.tecli-credentials when secret-tool fails, and env vars ahead of both.
// secret-tool is stubbed and HOME points at a temp dir, so neither the real
// keychain nor the real home directory is touched.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE = require.resolve('../credentials');
const ENV_KEYS = ['HOME', 'TECLI_MOCK', 'COSTPOINT_URL', 'COSTPOINT_USERNAME', 'COSTPOINT_PASSWORD'];
const STORED_URL = 'https://costpoint.example/cpweb/cploginform.htm?system=STORED';

// Written the way _fallbackSet writes it, so a change to the on-disk format
// that strands existing files fails here.
function writeFallbackFile(home, account, password) {
  const key = crypto.scryptSync(`tecli:${os.hostname()}:${os.userInfo().username}`, 'tecli-v1', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = cipher.update(password, 'utf8', 'hex') + cipher.final('hex');
  const data = { account, iv: iv.toString('hex'), encrypted, tag: cipher.getAuthTag().toString('hex') };
  fs.writeFileSync(path.join(home, '.tecli-credentials'), JSON.stringify(data));
}

function writeConfig(home, username) {
  fs.writeFileSync(path.join(home, '.tecli.json'), JSON.stringify({ url: STORED_URL, username }));
}

describe('Linux secret-tool credentials', () => {
  let home;
  let savedEnv;
  let calls;
  let creds;

  // credentials.js reads the platform and home directory and binds
  // execFileSync at load, so each test loads a fresh copy after pointing all
  // three at the test doubles.
  function load(t, secretTool) {
    calls = [];
    t.mock.method(os, 'platform', () => 'linux');
    t.mock.method(childProcess, 'execFileSync', (file, args, options) => {
      calls.push({ file, args, options });
      return secretTool();
    });
    delete require.cache[MODULE];
    creds = require(MODULE);
  }

  const missing = () => {
    throw new Error('spawnSync secret-tool ENOENT');
  };

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tecli-creds-'));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.HOME = home;
    assert.equal(os.homedir(), home);
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete require.cache[MODULE];
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('a failing secret-tool falls back to ~/.tecli-credentials', t => {
    writeConfig(home, 'me');
    writeFallbackFile(home, 'me', 'from-file');
    load(t, missing);

    assert.deepEqual(creds.getCredentials(), {
      url: STORED_URL,
      username: 'me',
      password: 'from-file',
      system: '',
      useDirect: true,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, 'secret-tool');
    assert.deepEqual(calls[0].args, ['lookup', 'service', 'tecli', 'username', 'me']);
  });

  test('the fallback file for another account is not used', t => {
    writeConfig(home, 'me');
    writeFallbackFile(home, 'other', 'not-mine');
    load(t, missing);

    assert.equal(creds.getCredentials(), null);
  });

  test('a working secret-tool wins over the fallback file', t => {
    writeConfig(home, 'me');
    writeFallbackFile(home, 'me', 'from-file');
    load(t, () => 'from-keychain\n');

    assert.equal(creds.getCredentials().password, 'from-keychain');
  });

  test('env vars win over secret-tool and the fallback file', t => {
    writeConfig(home, 'me');
    writeFallbackFile(home, 'me', 'from-file');
    load(t, () => 'from-keychain');
    process.env.COSTPOINT_URL = 'https://env.example/cpweb/cploginform.htm';
    process.env.COSTPOINT_USERNAME = 'env-user';
    process.env.COSTPOINT_PASSWORD = 'from-env';

    const got = creds.getCredentials();
    assert.equal(got.url, 'https://env.example/cpweb/cploginform.htm');
    assert.equal(got.username, 'env-user');
    assert.equal(got.password, 'from-env');
    assert.equal(calls.length, 0);
  });
});
