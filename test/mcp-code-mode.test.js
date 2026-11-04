'use strict';

// Runs mcp-server.js as a child process over stdio, once with the MCP SDK
// client (direct install) and once through @utcp/code-mode (code-mode-mcp),
// which drops isError and hands the script only the text.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { MARKER } = require('../mcp-server');
const { startMock } = require('./mock-helper');

const SERVER = path.join(__dirname, '..', 'mcp-server.js');

// @utcp/code-mode is not a dependency of tecli. Use the global
// @utcp/code-mode-mcp install (or UTCP_MODULES_DIR) when it is there.
function findUtcpModules() {
  const candidates = [
    process.env.UTCP_MODULES_DIR,
    path.join(
      path.dirname(process.execPath),
      '..',
      'lib',
      'node_modules',
      '@utcp',
      'code-mode-mcp',
      'node_modules',
      '@utcp'
    ),
  ].filter(Boolean);
  return candidates.find(dir => fs.existsSync(path.join(dir, 'code-mode')) && fs.existsSync(path.join(dir, 'mcp')));
}

// The child must reach the mock only: its own COSTPOINT_* env, and a working
// directory without the production .env that dotenv would otherwise load.
function mockEnv(mock) {
  const { hostname } = new URL(mock.url);
  assert.ok(['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname), `not a local mock: ${mock.url}`);
  return {
    COSTPOINT_URL: mock.url,
    COSTPOINT_USERNAME: 'mock',
    COSTPOINT_PASSWORD: 'mock',
    COSTPOINT_DIRECT: 'true',
    TECLI_MOCK: '1',
  };
}

describe('mcp server over stdio', () => {
  let mock;
  let cwd;

  before(async () => {
    mock = await startMock();
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tecli-mcp-'));
  });

  after(async () => {
    await mock.stop();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  describe('direct MCP client', () => {
    let client;

    before(async () => {
      await fetch(`${mock.url.split('/cpweb')[0]}/__mock/reset`, { method: 'POST' });
      client = new Client({ name: 'test', version: '1.0.0' });
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [SERVER],
          cwd,
          env: { PATH: process.env.PATH, HOME: cwd, ...mockEnv(mock) },
          stderr: 'ignore',
        })
      );
    });

    after(async () => client.close());

    test('success is plain text without isError', async () => {
      const res = await client.callTool({ name: 'show_timesheet', arguments: {} });
      assert.equal(res.isError, undefined);
      assert.match(res.content[0].text, /^Current week/);
    });

    test('an error has isError and the error marker', async () => {
      const res = await client.callTool({ name: 'show_timesheet', arguments: { back: 25 } });
      assert.equal(res.isError, true);
      assert.ok(res.content[0].text.startsWith(`${MARKER.error} Cannot go back 25 weeks`), res.content[0].text);
    });

    test('a needed revision explanation has isError and the revision marker', async () => {
      const res = await client.callTool({ name: 'set_hours', arguments: { line: 0, day: 5, hours: 4, back: 1 } });
      assert.equal(res.isError, true);
      assert.ok(res.content[0].text.startsWith(MARKER.revision), res.content[0].text);
      const saved = await client.callTool({ name: 'save_with_explanation', arguments: { explanation: 'stdio' } });
      assert.equal(saved.isError, undefined);
      assert.match(saved.content[0].text, /^Saved with explanation/);
    });
  });

  const utcp = findUtcpModules();

  describe('through @utcp/code-mode', { skip: utcp ? false : '@utcp/code-mode-mcp not installed' }, () => {
    let codeMode;
    let quiet;

    // Script results come back as { result, logs }.
    const run = code => codeMode.callToolChain(code, 30000);

    before(async () => {
      await fetch(`${mock.url.split('/cpweb')[0]}/__mock/reset`, { method: 'POST' });
      // UTCP logs every call to stdout, which the test runner would report
      quiet = console.log;
      console.log = () => {};
      require(path.join(utcp, 'mcp'));
      const { CodeModeUtcpClient } = require(path.join(utcp, 'code-mode'));
      const { UtcpClientConfigSerializer } = require(path.join(utcp, 'sdk'));
      const config = new UtcpClientConfigSerializer().validateDict({
        manual_call_templates: [
          {
            name: 'tecli',
            call_template_type: 'mcp',
            config: {
              mcpServers: {
                tecli: { command: process.execPath, args: [SERVER], transport: 'stdio', cwd, env: mockEnv(mock) },
              },
            },
          },
        ],
      });
      codeMode = await CodeModeUtcpClient.create(cwd, config);
    });

    after(async () => {
      if (codeMode) await codeMode.close();
      console.log = quiet;
    });

    test('a synchronous call returns the timesheet string', async () => {
      const { result, logs } = await run('var r = tecli.tecli_show_timesheet({}); return typeof r + "|" + r;');
      assert.deepEqual(logs, []);
      assert.match(result, /^string\|Current week/);
    });

    test('an error reaches the script as text with the error marker', async () => {
      const { result } = await run('return tecli.tecli_show_timesheet({ back: 25 });');
      assert.ok(result.startsWith(`${MARKER.error} Cannot go back 25 weeks`), result);
    });

    test('a schema error reaches the script with the error marker', async () => {
      const { result } = await run('return tecli.tecli_show_timesheet({ back: -1 });');
      assert.match(result, /^ERROR: .*Input validation error/);
    });

    test('a needed revision explanation is readable from the text alone', async () => {
      const { result } = await run(`
        var r = tecli.tecli_set_hours({ line: 0, day: 5, hours: 4, back: 1 });
        if (r.indexOf(${JSON.stringify(MARKER.revision)}) !== 0) return 'missed: ' + r;
        return tecli.tecli_save_with_explanation({ explanation: 'code-mode' });
      `);
      assert.match(result, /^Saved with explanation/);
      const cp = await mock.launch();
      await cp.selectPeriod(1);
      assert.equal(cp.getData().projects[0].hours[5], 4);
    });

    // code-mode awaits the script result (since @utcp/code-mode 1.2.13)
    test('an async function result comes back as the text', async () => {
      const { result, logs } = await run(
        'async function main() { var r = tecli.tecli_show_timesheet({}); console.log(r); return r; } return main();'
      );
      assert.match(result, /^Current week/);
      assert.match(logs.join('\n'), /^Current week/);
    });

    test('an awaited call returns the text', async () => {
      const { result, logs } = await run('var r = await tecli.tecli_show_timesheet({}); return r;');
      assert.deepEqual(logs, []);
      assert.match(result, /^Current week/);
    });
  });
});
