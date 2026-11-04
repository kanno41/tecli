'use strict';

// TECLI_MOCK must keep a mock run off real Costpoint: mcp-server.js refuses
// to start on a non-local URL, from the env or from the stored login.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { assertMockSafe, isMockRun } = require('../credentials');

const SERVER = path.join(__dirname, '..', 'mcp-server.js');
const REAL_URL = 'https://te.leidos.com/cpweb/cploginform.htm?system=LEIDOS';
const LOCAL_URL = 'http://localhost:4000/cpweb/cploginform.htm?system=MOCK';

function withEnv(value, fn) {
  const saved = process.env.TECLI_MOCK;
  if (value === undefined) delete process.env.TECLI_MOCK;
  else process.env.TECLI_MOCK = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.TECLI_MOCK;
    else process.env.TECLI_MOCK = saved;
  }
}

describe('TECLI_MOCK flag', () => {
  test('empty, 0 and false are off; anything else is on', () => {
    for (const v of [undefined, '', '0', 'false', 'FALSE']) assert.equal(withEnv(v, isMockRun), false, String(v));
    for (const v of ['1', 'true', 'yes']) assert.equal(withEnv(v, isMockRun), true, v);
  });

  test('assertMockSafe allows local hosts and rejects others', () => {
    withEnv('1', () => {
      for (const host of ['localhost:4000', '127.0.0.1', '[::1]:4000']) {
        assert.doesNotThrow(() => assertMockSafe({ url: `http://${host}/cpweb/` }), host);
      }
      assert.throws(() => assertMockSafe({ url: REAL_URL }), /TECLI_MOCK is set but the Costpoint URL is not local/);
      assert.throws(() => assertMockSafe({ url: 'not a url' }), /not local/);
    });
    withEnv(undefined, () => assert.doesNotThrow(() => assertMockSafe({ url: REAL_URL })));
  });
});

describe('mcp-server.js with TECLI_MOCK', () => {
  let home;

  // HOME holds a stored login for real Costpoint, as `te login` leaves it
  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tecli-guard-'));
    fs.writeFileSync(
      path.join(home, '.tecli.json'),
      JSON.stringify({ url: REAL_URL, username: 'someone', direct: true })
    );
  });

  after(() => fs.rmSync(home, { recursive: true, force: true }));

  const baseEnv = () => ({ PATH: process.env.PATH, HOME: home, TECLI_MOCK: '1' });

  function start(env) {
    return spawnSync(process.execPath, [SERVER], { cwd: home, env, input: '', encoding: 'utf8', timeout: 10000 });
  }

  test('refuses a non-local COSTPOINT_URL', () => {
    const res = start({
      ...baseEnv(),
      COSTPOINT_URL: REAL_URL,
      COSTPOINT_USERNAME: 'mock',
      COSTPOINT_PASSWORD: 'mock',
    });
    assert.equal(res.status, 2, res.stderr);
    assert.match(res.stderr, /refused to start: TECLI_MOCK is set but the Costpoint URL is not local/);
  });

  test('refuses to fall back to the stored login', () => {
    const res = start(baseEnv());
    assert.equal(res.status, 2, res.stderr);
    assert.match(res.stderr, /refused to start: .*stored login is not used in a mock run/);
  });

  test('starts with a local COSTPOINT_URL', async () => {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [SERVER],
        cwd: home,
        env: { ...baseEnv(), COSTPOINT_URL: LOCAL_URL, COSTPOINT_USERNAME: 'mock', COSTPOINT_PASSWORD: 'mock' },
        stderr: 'ignore',
      })
    );
    try {
      const { tools } = await client.listTools();
      assert.ok(tools.length > 0);
    } finally {
      await client.close();
    }
  });
});
