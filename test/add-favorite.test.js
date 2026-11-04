#!/usr/bin/env node
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const protocol = require('../protocol');
const DirectClient = require('../direct');

const CAPTURE_DIR = path.join(__dirname, '../captured/add-favorite');
const CAPTURE_SID = 'c8a8f40a1204496fb878e26e243d2d9c';
const CHILD_ROWS = 38;

function loadCapture(seq) {
  return new URLSearchParams(fs.readFileSync(path.join(CAPTURE_DIR, seq + '-req.txt'), 'utf8'));
}

function commands(params) {
  const field = k => (params.get(k) || '').split(protocol.DLM_RS);
  return {
    cmds: field('cmd'),
    editFlags: field('editFlag'),
    rowNumbers: field('rowNumber'),
    reqIdx: params.get('reqIdx'),
  };
}

function makeClient(sid = CAPTURE_SID) {
  const client = Object.create(DirectClient.prototype);
  client.sid = sid;
  client.lastPutId = 12;
  client.periodIdx = 0;
  const rows = Array.from({ length: CHILD_ROWS }, () => Array(30).fill(''));
  client.childData = {
    rowNums: [...Array(CHILD_ROWS - 1).keys()].map(String).concat('-59999'),
    rowFlags: Array(CHILD_ROWS).fill('0'),
    rows,
  };
  client.parentData = { rowNums: ['0'], rows: [Array(30).fill('')] };
  return client;
}

// captured/ is gitignored (live session data), so these only run where the capture exists.
describe('addToFavorites batch', { skip: !fs.existsSync(CAPTURE_DIR) && 'captured/add-favorite not present' }, () => {
  const client = makeClient();
  client._actionSeq = 1;
  const actual = commands(new URLSearchParams(client._buildAddToFavoritesBatch(CHILD_ROWS - 1)));
  const expected = commands(loadCapture('024'));

  test('commands match capture 024', () => {
    assert.deepEqual(actual.cmds, expected.cmds);
  });

  test('edit flags and row numbers match capture 024', () => {
    assert.deepEqual(actual.editFlags, expected.editFlags);
    assert.deepEqual(actual.rowNumbers, expected.rowNumbers);
  });

  test('reqIdx is the second action', () => {
    assert.equal(actual.reqIdx, expected.reqIdx);
  });

  test('uses the TMMTS_ADD_LINE_TO_FAVORITES action', () => {
    assert.ok(actual.cmds[4].includes('TMMTS_ADD_LINE_TO_FAVORITES'));
  });
});

describe('addToFavorites', () => {
  test('throws when there is no pending line', async () => {
    const client = makeClient();
    client.childData.rowNums = client.childData.rowNums.map(() => '0');
    await assert.rejects(() => client.addToFavorites(), /No pending line/);
  });

  test('surfaces server errors', async () => {
    const client = makeClient();
    client._postServlet = async () => 'var responses=[["TMMTIMESHEET|0|507|0|0|0|0"],null,[null],["Not allowed."]];';
    await assert.rejects(() => client.addToFavorites(), /Add to favorites error: Not allowed\./);
  });

  test('resolves on an all-OK response', async () => {
    const client = makeClient();
    client._postServlet = async () => 'var responses=[["TMMTIMESHEET|0|507|0|0|0|0"],null,[null],["<OK>"]];';
    await client.addToFavorites();
  });
});

describe('action counter', () => {
  test('grows with every CMD 300 action in a session', () => {
    const client = makeClient();
    assert.equal(client._nextActionSeq(), 1);
    assert.equal(client._nextActionSeq(), 2);
    const seq = body => new URLSearchParams(body).get('reqIdx');
    assert.equal(seq(client._buildAddToFavoritesBatch(CHILD_ROWS - 1)), '3');
    assert.equal(seq(client._buildAddToFavoritesBatch(CHILD_ROWS - 1)), '4');
  });
});

describe('save after add-to-favorites', () => {
  test('re-fetches when the save response carries no 204 data', async () => {
    const client = makeClient();
    client.parentData.rows[0] = Array(700).fill('');
    client.parentData.rowNums = ['0'];
    client._buildTableRows = () => {};
    const sent = [];
    const fresh = { rowNums: ['0', '1'], rowFlags: ['0', '0'], rows: [[], []] };
    client._postServlet = async body => {
      sent.push(body);
      return sent.length === 1
        ? 'var responses=[["TMMTIMESHEET|0|206|0|0|0|0","TMMTIMESHEET|-1|507|0|0|0|0"],"00",["<NO DATA>","<NO DATA>"],["<OK>","<OK>"]];'
        : 'refetch';
    };
    let refetches = 0;
    client._refetchTimesheet = async () => {
      refetches++;
      client.childData = fresh;
    };
    await client.save();
    assert.equal(refetches, 1);
    assert.deepEqual(client.childData.rowNums, ['0', '1']);
  });
});

describe('NEW_TS_LINE batch is unchanged', () => {
  // sha256 of the request body produced by the pre-refactor _newTimesheetLine
  // for the stub client below. A change means the shared builders drifted.
  const BASELINE_SHA256 = '042cd75b544cac41d44ed0c43550938a20385e269d7bdb7d495f1dd9a661abc9';

  test('request body matches the recorded baseline', async () => {
    const client = makeClient('S');
    client.lastPutId = 0;
    let body;
    client._postServlet = async b => {
      body = b;
      return 'var responses=[["TMMTIMESHEET|0|507|0|0|0|0"],null,[null],["<OK>"]];';
    };
    await client._newTimesheetLine();
    assert.equal(crypto.createHash('sha256').update(body).digest('hex'), BASELINE_SHA256);
  });
});

describe('te add --favorite flag', () => {
  test('is listed in the add command help', () => {
    const { spawnSync } = require('child_process');
    const result = spawnSync(process.execPath, ['cli.js', 'add', '--help'], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /-f, --favorite/);
  });
});
