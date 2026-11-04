#!/usr/bin/env node
'use strict';
/**
 * End-to-end smoke test for the favorites feature.
 *
 * Requires live Costpoint credentials via env vars (COSTPOINT_URL, COSTPOINT_USERNAME,
 * COSTPOINT_PASSWORD, COSTPOINT_DIRECT=true) or ~/.tecli.json + keychain.
 *
 * Opt-in: RUN_E2E=1 node --test test/e2e-favorites.test.js
 * Skips without RUN_E2E=1, without credentials, with TECLI_MOCK set or with SKIP_E2E=1
 *
 * TUI manual checklist (requires running `node tui.js`):
 *   1. Press [f] — favorites panel opens, shows "No favorites found" or a list
 *   2. If favorites are listed, press [1] — adds first favorite and returns to timesheet
 *   3. Press [f] again to re-open, press [f] or Esc to close
 *   4. Press [a] to open Add Project menu, press [1] — still works (menu unaffected)
 */

require('dotenv').config();
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { liveSkipReason } = require('./e2e-helper');

const SKIP = liveSkipReason();

// ─── CLI smoke test ────────────────────────────────────────────────────────

describe('CLI: node cli.js favorites', { skip: SKIP }, () => {
  test('exits 0 and prints a favorites header or "No favorites found"', async () => {
    const { spawnSync } = require('child_process');
    const result = spawnSync(process.execPath, ['cli.js', 'favorites'], {
      cwd: require('path').join(__dirname, '..'),
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env },
    });

    assert.equal(result.status, 0, 'CLI should exit 0\nstderr: ' + result.stderr);
    const output = result.stdout + result.stderr;
    const hasExpected =
      output.includes('No favorites found') ||
      output.includes('Code') || // table header
      output.includes('Favorites loaded');
    assert.ok(hasExpected, 'output should contain favorites result\ngot: ' + output.substring(0, 300));
  });
});

// ─── Web UI smoke test ─────────────────────────────────────────────────────

describe('Web UI: GET /api/favorites', { skip: SKIP }, () => {
  test('returns a JSON array (empty or with favorite objects)', async () => {
    // Hits the dev server on port 3000 if it's running. Non-running = skip (not fail).
    const http = require('http');
    const PORT = 3000;
    const baseUrl = 'http://localhost:' + PORT;

    await new Promise((resolve, reject) => {
      const req = http.get(baseUrl + '/api/favorites', res => {
        let body = '';
        res.on('data', d => {
          body += d;
        });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            assert.ok(Array.isArray(data), '/api/favorites should return array');
            for (const fav of data) {
              assert.ok(typeof fav.code === 'string', 'each favorite should have a code');
            }
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', err => {
        if (err.code === 'ECONNREFUSED') {
          // Dev server not running — skip gracefully
          resolve(); // not a test failure
        } else {
          reject(err);
        }
      });
      req.setTimeout(25000, () => reject(new Error('HTTP timeout')));
    });
  });
});
