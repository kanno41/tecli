'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const protocol = require('../protocol');
const DirectClient = require('../direct');
const codec = require('../mock/codec');

function roundTrip(rows, numCols) {
  const slot = codec.encode204Slot(
    { rowNums: rows.map((_, i) => String(i)), rowFlags: rows.map(() => 0), rows },
    numCols
  );
  const text = codec.buildResponse([{ rsKey: 0, cmdCd: 204, start: 0, end: 20, slot }]);
  return protocol.extract204(protocol.parseResponse(text), 0);
}

describe('response encoder', () => {
  test('round trips rows, row numbers and flags', () => {
    const rows = [
      ['a', 'b', '', 'd'],
      ['', '', '', ''],
      ['a', 'b', 'c', 'd'],
      ['x y', '1,2', 'say "hi"', 'l1\nl2'],
    ];
    const got = roundTrip(rows, 4);
    assert.deepEqual(got.rows, rows);
    assert.deepEqual(got.rowNums, ['0', '1', '2', '3']);
  });

  test('keeps empty cells empty, including a run of them and a repeated row', () => {
    const rows = [
      ['', '', '', '', '', '', 'z'],
      ['', '', '', '', '', '', 'z'],
    ];
    assert.deepEqual(roundTrip(rows, 7).rows, rows);
  });

  test('round trips cells of the PUT length boundaries', () => {
    for (const len of [1, 26, 27, 52, 53, 100]) {
      const rows = [['x'.repeat(len), 'y']];
      assert.deepEqual(roundTrip(rows, 2).rows, rows, 'length ' + len);
    }
  });

  test('a cell that looks like a marker survives', () => {
    const rows = [
      ['0', '?', 'A1', '5'],
      ['0', '?', 'A1', '5'],
    ];
    assert.deepEqual(roundTrip(rows, 4).rows, rows);
  });

  test('throws on control characters', () => {
    assert.throws(() => codec.encodeData([['a\x0Bb']], 1), /control character/);
    assert.throws(() => codec.encodeData([['a\x06b']], 1), /control character/);
  });

  test('throws on a row of the wrong width', () => {
    assert.throws(() => codec.encodeData([['a']], 2), /expected 2/);
  });

  test('frames without data decode as <NO DATA>, errors as the message', () => {
    const text = codec.buildResponse([
      { rsKey: 1, cmdCd: 206, rescd: -1, error: 'Explanation or Reject Reason is required.' },
      { rsKey: -1, cmdCd: 507 },
    ]);
    const parsed = protocol.parseResponse(text);
    assert.equal(protocol.checkErrors(parsed), 'Explanation or Reject Reason is required.');
    assert.equal(protocol.checkRescds(parsed), true);
    assert.equal(protocol.extract204(parsed, 1), null);
  });
});

describe('PUT row decoder', () => {
  test('inverts encodePutRow', () => {
    const rows = [
      ['a', '', 'bc'],
      ['', '', '', '', '', 'tail', '', ''],
      ['x'.repeat(26), 'y'.repeat(27), 'z'.repeat(52), 'w'.repeat(53), 'v'.repeat(120)],
      new Array(402).fill(''),
      ['', 'x', '', '', '', ''],
    ];
    for (const row of rows) {
      assert.deepEqual(codec.decodePutRow(protocol.encodePutRow(row)), row);
    }
  });
});

describe('W clause parser', () => {
  test('reads the HLKP level and row', () => {
    assert.deepEqual(codec.parseWhere('1|C^UDT02_ID^9^PTO^0|C^$H_LKP_SEL_LVL$^1^1^0|C^$H_LKP_SEL_ROW$^1^-2^0|'), {
      UDT02_ID: 'PTO',
      $H_LKP_SEL_LVL$: '1',
      $H_LKP_SEL_ROW$: '-2',
    });
  });
});

describe('request parser', () => {
  function stub() {
    const client = Object.create(DirectClient.prototype);
    client.sid = 'SID';
    client.lastPutId = 0;
    client.periodIdx = 1;
    client._actionSeq = 0;
    const child = new Array(420).fill('');
    child[6] = 'CODE.A';
    child[30] = '4';
    client.childData = { rowNums: ['0'], rowFlags: ['0'], rows: [child] };
    const parent = new Array(688).fill('');
    parent[3] = '2026-09-27';
    client.parentData = { rowNums: ['0', '1'], rowFlags: ['0', '0'], rows: [parent, parent.slice()] };
    return client;
  }

  test('reads a cell edit batch', () => {
    const body = stub()._buildCellEditBatch(0, 0, 5);
    const req = codec.parseRequest(body);
    assert.equal(req.sid, 'SID');
    assert.deepEqual(
      req.commands.map(c => c.reqCd),
      [205, 208, 204, 204, 204, 204, 507]
    );
    const put = req.commands[0];
    assert.equal(put.codes.X, '1');
    assert.equal(put.codes.K, '1');
    assert.deepEqual(put.editFlag, ['18']);
    assert.deepEqual(put.rowNumber, ['0']);
    assert.equal(codec.decodePutRow(put.data[0])[30], '4');
    assert.equal(req.commands[1].named.objectId, 'DAY5_HRS');
    assert.equal(req.commands[2].named.rsType, 'M');
    assert.equal(req.commands[2].codes.R, 'ABS');
  });

  test('reads a save batch with many child rows', () => {
    const client = stub();
    client.childData.rowNums.push('-59999');
    client.childData.rows.push(client.childData.rows[0].slice());
    const req = codec.parseRequest(client._buildSaveBatch());
    const k1 = req.commands[1];
    assert.deepEqual(k1.rowNumber, ['0', '-59999']);
    assert.deepEqual(k1.editFlag, ['18', '19']);
    assert.equal(k1.data.length, 2);
  });
});

const CAPTURE_ROOT = path.join(__dirname, '../captured');
const captures = [];
if (fs.existsSync(CAPTURE_ROOT)) {
  for (const dir of fs.readdirSync(CAPTURE_ROOT)) {
    const full = path.join(CAPTURE_ROOT, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      if (f.endsWith('-res.txt')) captures.push(path.join(full, f));
    }
  }
}

describe('captured responses re-encode', { skip: captures.length === 0 && 'captured/ is absent' }, () => {
  test('every 204 data slot decodes the same after re-encoding', () => {
    let checked = 0;
    for (const file of captures) {
      const text = fs.readFileSync(file, 'utf8');
      if (!text.startsWith('var responses=')) continue;
      const parsed = protocol.parseResponse(text);
      const frames = protocol.parseFrames(parsed[0]);
      frames.forEach((fr, i) => {
        if (fr.cmdCd !== 204 || !Array.isArray(parsed[2][i])) return;
        const decoded = protocol.decode204Data(parsed[2][i]);
        if (!decoded || decoded.rows.length === 0) return;
        const numCols = decoded.rows[0].length;
        const slot = codec.encode204Slot(decoded, numCols);
        const again = protocol.decode204Data(slot);
        assert.deepEqual(again.rows, decoded.rows, path.basename(path.dirname(file)) + '/' + path.basename(file));
        assert.deepEqual(again.rowNums, decoded.rowNums);
        checked++;
      });
    }
    assert.ok(checked > 0);
  });
});
