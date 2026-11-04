#!/usr/bin/env node
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const protocol = require('../protocol');
const DirectClient = require('../direct');

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeStubClient(sid = 'TESTSESSION') {
  const client = Object.create(DirectClient.prototype);
  client.sid = sid;
  client.baseUrl = 'https://example.com';
  client.childData = {
    rowNums: ['1'],
    rowFlags: ['0'],
    rows: [Array(30).fill('')],
  };
  client.parentData = { rowNums: [], rows: [] };
  return client;
}

// Decode URL-encoded request body to readable form for assertions
function decodeBody(body) {
  return decodeURIComponent(body.replace(/\+/g, ' '));
}

// captured/ is gitignored (real timesheet data), so tests that read it skip without it
const capturedPath = filename => path.join(__dirname, '../captured', filename);
const skipWithout = filename => (fs.existsSync(capturedPath(filename)) ? false : `captured/${filename} not present`);

// Load and decode a base64-encoded captured response
function loadCapturedResponse(filename) {
  const raw = fs.readFileSync(capturedPath(filename), 'utf8').trim();
  return Buffer.from(raw.replace('data:application/octet-stream;base64,', ''), 'base64').toString('binary');
}

// ─── protocol.parseResponse ────────────────────────────────────────────────

describe('protocol.parseResponse', () => {
  test('parses a minimal well-formed response', () => {
    const text = 'var responses=[["TMMTIMESHEET|0|507|0|0|0|0"],null,[null],[]];';
    const parsed = protocol.parseResponse(text);
    assert.ok(Array.isArray(parsed), 'parsed is array');
    assert.ok(Array.isArray(parsed[0]), 'frame list is array');
  });

  test('throws on servlet exception response', () => {
    const text = 'var logIdText="Log Id: 12345"; parent.RequestBroker.onServletException("error");';
    assert.throws(
      () => protocol.parseResponse(text),
      /parseResponse failed/,
      'should throw on missing responses variable'
    );
  });
});

// ─── protocol.checkErrors ──────────────────────────────────────────────────

describe('protocol.checkErrors', () => {
  test('returns null when all frames are OK', () => {
    const text = 'var responses=[["TMMTIMESHEET|0|507|0|0|0|0"],null,[null],["<OK>"]];';
    const parsed = protocol.parseResponse(text);
    assert.equal(protocol.checkErrors(parsed), null);
  });

  test('returns null for NO DATA', () => {
    const text = 'var responses=[["TMMTIMESHEET|0|507|0|0|0|0"],null,[null],["<NO DATA>"]];';
    const parsed = protocol.parseResponse(text);
    assert.equal(protocol.checkErrors(parsed), null);
  });

  test('returns error string when present', () => {
    const text = 'var responses=[["TMMTIMESHEET|0|507|0|0|0|0"],null,[null],["Account required."]];';
    const parsed = protocol.parseResponse(text);
    assert.equal(protocol.checkErrors(parsed), 'Account required.');
  });
});

// ─── protocol.extract204 ──────────────────────────────────────────────────

describe('protocol.extract204', () => {
  test('returns null when no 204 K2 frame exists', () => {
    // 507 keepalive frame — not a 204, rsKey is 0
    const text = 'var responses=[["TMMTIMESHEET|0|507|0|0|0|0"],null,[null],[]];';
    const parsed = protocol.parseResponse(text);
    assert.equal(protocol.extract204(parsed, 2), null);
  });

  test(
    'extracts rows from captured favorites filter response',
    { skip: skipWithout('favorites-filter-res.txt') },
    () => {
      // This uses real captured server data to verify end-to-end decoding.
      const responseText = loadCapturedResponse('favorites-filter-res.txt');
      const parsed = protocol.parseResponse(responseText);

      // Should not throw, checkErrors should be null
      const err = protocol.checkErrors(parsed);
      assert.equal(err, null, 'no errors in captured response');

      // The captured response is a regular HLKP (seeding K2) — should have rows at K2
      const k2 = protocol.extract204(parsed, 2);
      assert.ok(k2 !== null, 'K2 data should be present');
      assert.ok(k2.rows.length > 0, 'should have at least one row');

      // Each row should have a charge code at column 5
      const codes = k2.rows.map(r => r[5]).filter(Boolean);
      assert.ok(codes.length > 0, 'at least one row should have a charge code');
    }
  );
});

// ─── DirectClient._buildFavoritesQuery ────────────────────────────────────

describe('DirectClient._buildFavoritesQuery', () => {
  const client = makeStubClient();
  const body = decodeBody(client._buildFavoritesQuery());

  test('includes the favorites WHERE clause (LVL=2)', () => {
    assert.ok(body.includes('H_LKP_SEL_LVL'), 'WHERE has LVL param');
    assert.ok(body.includes('^1^2^0|'), 'LVL value is 2 in WHERE clause');
  });

  test('includes the favorites WHERE clause (ROW=0)', () => {
    assert.ok(body.includes('H_LKP_SEL_ROW'), 'WHERE has ROW param');
    assert.ok(body.includes('^1^0^0|'), 'ROW value is 0 in WHERE clause');
  });

  test('uses C=0 (not C=-60000)', () => {
    const P7 = 'P\x07';
    assert.ok(body.includes(P7 + 'C0' + P7), 'C param should be 0');
    assert.ok(!body.includes(P7 + 'C-60000' + P7), 'C param should not be -60000');
  });

  test('uses X=-59999 (pending row anchor)', () => {
    const P7 = 'P\x07';
    assert.ok(body.includes(P7 + 'X-59999' + P7), 'X should be -59999');
  });

  test('specifies K=2 (charge lookup result set)', () => {
    const P7 = 'P\x07';
    assert.ok(body.includes(P7 + 'K2' + P7), 'K should be 2');
  });

  test('specifies R=HLKP action', () => {
    const P7 = 'P\x07';
    assert.ok(body.includes(P7 + 'RHLKP' + P7), 'R should be HLKP');
  });
});

// ─── DirectClient._buildHlkpQuery ─────────────────────────────────────────

describe('DirectClient._buildHlkpQuery', () => {
  const client = makeStubClient();
  const code = 'G09118.A.3778.026.005';
  const body = decodeBody(client._buildHlkpQuery(code));

  test('embeds the charge code in the WHERE clause', () => {
    assert.ok(body.includes('^' + code + '^'), 'charge code in WHERE clause');
  });

  test('uses LVL=1 (regular charge lookup level)', () => {
    assert.ok(body.includes('H_LKP_SEL_LVL$^1^1^0|'), 'LVL is 1');
  });

  test('uses ROW=-2 (regular charge lookup row)', () => {
    assert.ok(body.includes('^-2^0|'), 'ROW is -2');
  });

  test('uses C=-60000 (mid-list cursor for regular lookup)', () => {
    const P7 = 'P\x07';
    assert.ok(body.includes(P7 + 'C-60000' + P7), 'C should be -60000');
  });
});
