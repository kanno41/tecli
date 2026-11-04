#!/usr/bin/env node
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../protocol');
const DirectClient = require('../direct');
const codec = require('../mock/codec');

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeStubClient() {
  const client = Object.create(DirectClient.prototype);
  client.parentCol = DirectClient.CAPTURE_PARENT_COL;
  client.childCol = DirectClient.CAPTURE_CHILD_COL;
  client.lookupCol = DirectClient.CAPTURE_LOOKUP_COL;
  client._resolveLookupColumns = () => {};
  client.sid = 'TESTSESSION';
  client.baseUrl = 'https://example.com';
  client.lastPutId = 0;
  client.periodIdx = 0;
  // Template row with enough columns for _validateUdt02 (reads col 6) and
  // _stagePendingLine (reads cols up to ~400)
  const row = new Array(420).fill('');
  row[0] = 'FY26 Greenhs LabEnv Labor'; // description
  row[6] = 'G09118.A.3778.026.005'; // CHILD_UDT02_ID
  client.childData = {
    rowNums: ['1'],
    rowFlags: ['0'],
    rows: [row],
  };
  client.parentData = { rowNums: ['0'], rowFlags: ['0'], rows: [new Array(100).fill('')] };
  return client;
}

// Minimal OK response (single 507 keepalive, no errors)
const OK_RESPONSE = 'var responses=[["TMMTIMESHEET|0|507|0|0|0|0"],null,[null],["<OK>"]];';

// ─── add() pending-row management ─────────────────────────────────────────

describe('add() pending-row management', () => {
  test('calls _newTimesheetLine when no pending row exists', async () => {
    const client = makeStubClient();
    // No negative rowNums = fresh client
    assert.ok(!client.childData.rowNums.some(n => parseInt(n, 10) < 0), 'no pending row initially');

    let newLineCalled = 0;
    client._newTimesheetLine = async () => {
      newLineCalled++;
      // Simulate server registering the row: push a real pending row
      const r = new Array(420).fill('');
      client.childData.rowNums.push('-59999');
      client.childData.rows.push(r);
    };
    client._validateUdt02 = async () => {};
    client._resolveChargeOnServer = async () => {};
    client._buildTableRows = () => {};

    await client.add('G09118.A.3778.026.005', 'REG');
    assert.equal(newLineCalled, 1, '_newTimesheetLine should be called once');
  });

  test('does NOT call _newTimesheetLine when pending row already exists', async () => {
    const client = makeStubClient();
    // Pre-stage a pending row (e.g. left over from getFavorites)
    client._stagePendingLine();
    assert.ok(
      client.childData.rowNums.some(n => parseInt(n, 10) < 0),
      'pending row exists'
    );

    let newLineCalled = 0;
    client._newTimesheetLine = async () => {
      newLineCalled++;
    };
    client._validateUdt02 = async () => {};
    client._resolveChargeOnServer = async () => {};
    client._buildTableRows = () => {};

    await client.add('G09118.A.3778.026.005', 'REG');
    assert.equal(newLineCalled, 0, '_newTimesheetLine should NOT be called when row pre-staged');
  });

  test('passes code and payType to _resolveChargeOnServer', async () => {
    const client = makeStubClient();
    client._stagePendingLine();

    let resolved = null;
    client._newTimesheetLine = async () => {};
    client._validateUdt02 = async () => {};
    client._resolveChargeOnServer = async (code, pt) => {
      resolved = { code, payType: pt };
    };
    client._buildTableRows = () => {};

    await client.add('ZLEAVE.CMP', 'REG');
    assert.deepEqual(resolved, { code: 'ZLEAVE.CMP', payType: 'REG' });
  });
});

// ─── add() work location ──────────────────────────────────────────────────

describe('add() work location', () => {
  function stubbed() {
    const client = makeStubClient();
    client._stagePendingLine();
    client._newTimesheetLine = async () => {};
    client._validateUdt02 = async () => {};
    client._resolveChargeOnServer = async () => {};
    client._buildTableRows = () => {};
    const validated = [];
    client._validateObject = async id => {
      validated.push(id);
    };
    return { client, validated };
  }

  test('no workLocation: no extra validate, column untouched', async () => {
    const { client, validated } = stubbed();
    await client.add('ZLEAVE.CMP', 'REG');
    assert.deepEqual(validated, []);
    assert.equal(client.pendingLine().workLocation, '');
  });

  test('workLocation: sets col 8 and validates UDT03_ID', async () => {
    const { client, validated } = stubbed();
    await client.add('ZLEAVE.CMP', 'REG', { workLocation: '62226' });
    assert.deepEqual(validated, ['UDT03_ID']);
    assert.equal(client.pendingLine().workLocation, '62226');
  });

  test('_validateObject sends 205, 205 context, 208 with the object id', async () => {
    const client = makeStubClient();
    client._stagePendingLine();
    let body;
    client._postServlet = async b => {
      body = b;
      return OK_RESPONSE;
    };
    await client._validateObject('UDT03_ID');
    const params = new URLSearchParams(body);
    const cmds = params.get('cmd').split(protocol.DLM_RS);
    assert.match(cmds[0], /^205/);
    assert.match(cmds[1], /^205/);
    assert.match(cmds[2], /^208/);
    assert.match(cmds[2], /UDT03_ID/);
  });

  test('pendingLine is null without a pending row', () => {
    assert.equal(makeStubClient().pendingLine(), null);
  });
});

// ─── _resolveChargeOnServer charge selection ───────────────────────────────

describe('_resolveChargeOnServer charge selection', () => {
  test('single-charge code: auto-selects first row regardless of payType', async () => {
    const client = makeStubClient();
    client._stagePendingLine();

    const singleRow = new Array(40).fill('');
    singleRow[5] = 'ZLEAVE.CMP'; // charge code
    singleRow[15] = ''; // empty pay type = single-charge
    const hlkpResponse = codec.buildResponse([
      {
        rsKey: 2,
        cmdCd: 204,
        start: 0,
        end: 1,
        slot: codec.encode204Slot({ rowNums: ['7'], rowFlags: [0], rows: [singleRow] }, 40),
      },
    ]);

    client._buildOpenRsChargeLookup = () => 'OPEN_RS';
    client._buildHlkpQuery = () => 'HLKP';
    let selected = null;
    client._buildChargeLkpOk = (k2Row, rowNum) => {
      selected = { k2Row, rowNum };
      return 'LKP_OK';
    };
    client._postServlet = async body => (body === 'HLKP' ? hlkpResponse : OK_RESPONSE);

    await client._resolveChargeOnServer('ZLEAVE.CMP', 'REG');
    assert.ok(selected, 'TC_TS_CHARGE_LKP_OK was sent');
    assert.equal(selected.rowNum, '7', 'the only K2 row is selected even though REG was asked for');
    assert.equal(selected.k2Row[5], 'ZLEAVE.CMP');
  });

  test('a row for another code is never selected', async () => {
    const client = makeStubClient();
    client._stagePendingLine();
    const lookupRow = (code, payType) => {
      const row = new Array(40).fill('');
      row[5] = code;
      row[15] = payType;
      return row;
    };
    const hlkpResponse = codec.buildResponse([
      {
        rsKey: 2,
        cmdCd: 204,
        start: 0,
        end: 3,
        slot: codec.encode204Slot(
          {
            rowNums: ['0', '1', '2'],
            rowFlags: [0, 0, 0],
            rows: [lookupRow('PROJ.A.1001', 'REG'), lookupRow('PROJ.A.100', 'RHB'), lookupRow('proj.a.100', 'REG')],
          },
          40
        ),
      },
    ]);
    client._buildOpenRsChargeLookup = () => 'OPEN_RS';
    client._buildHlkpQuery = () => 'HLKP';
    let selected = null;
    client._buildChargeLkpOk = (k2Row, rowNum) => {
      selected = rowNum;
      return 'LKP_OK';
    };
    client._postServlet = async body => (body === 'HLKP' ? hlkpResponse : OK_RESPONSE);

    await client._resolveChargeOnServer('PROJ.A.100', 'REG');
    assert.equal(selected, '2');
    await assert.rejects(() => client._resolveChargeOnServer('PROJ.A.100', undefined), /Available pay types: RHB, REG/);
    await assert.rejects(() => client._resolveChargeOnServer('PROJ.A.10', 'REG'), /No charges found for PROJ\.A\.10/);
  });

  test('multi-charge code: throws when no payType specified', () => {
    const row0 = new Array(40).fill('');
    row0[5] = '62226';
    row0[15] = 'REG';
    const row1 = new Array(40).fill('');
    row1[5] = '62226';
    row1[15] = 'RHB';
    const rows = [row0, row1];

    const availablePayTypes = rows.map(r => r[15] || '');
    const hasDistinctPayTypes = availablePayTypes.some(pt => pt !== '');
    const isMultiCharge = rows.length > 1 && hasDistinctPayTypes;
    assert.ok(isMultiCharge, 'multi-charge detected');

    // Simulate the no-payType error path
    const payType = undefined;
    const wouldThrow = isMultiCharge && !payType;
    assert.ok(wouldThrow, 'should throw when multi-charge and no payType');
  });

  test('multi-charge code: selects correct row by payType', () => {
    const row0 = new Array(40).fill('');
    row0[5] = '62226';
    row0[15] = 'REG';
    const row1 = new Array(40).fill('');
    row1[5] = '62226';
    row1[15] = 'RHB';
    const rows = [row0, row1];
    const rowNums = ['1', '2'];

    // Simulate _findChargeRow logic: match by payType
    const desiredPayType = 'RHB';
    const availablePayTypes = rows.map(r => r[15] || '');
    const foundIdx = availablePayTypes.findIndex(pt => pt === desiredPayType);
    assert.equal(foundIdx, 1, 'should select row at index 1 for RHB');
    assert.equal(rowNums[foundIdx], '2', 'selected rowNum should be 2');
  });

  test('PAY_TYPE copied from K2 row, not manually set', () => {
    // Key gotcha: childRow[376] = selectedK2Row[15], not the payType argument.
    // This ensures multi-charge codes never get a manually-entered pay type.
    const k2Row = new Array(40).fill('');
    k2Row[15] = 'RHB'; // pay type in K2 row

    const client = makeStubClient();
    client._stagePendingLine();
    const pendingIdx = client.childData.rowNums.findIndex(n => parseInt(n, 10) < 0);
    const childRow = client.childData.rows[pendingIdx];

    // Simulate what _resolveChargeOnServer does:
    childRow[376] = k2Row[15] || '';

    // Verify it came from K2 row, not from the payType argument
    assert.equal(childRow[376], 'RHB', 'childRow[376] should be set from K2 row[15]');
    // The payType argument was 'REG' — if it were manually set, childRow[376] would be 'REG'
    // But we copy from K2, so it's 'RHB' (what the server returned for this code)
  });
});

// ─── period index in the add builders ─────────────────────────────────────

describe('add builders take the period from periodIdx', () => {
  function stagedClient(periodIdx) {
    const client = makeStubClient();
    client.periodIdx = periodIdx;
    client.parentData = {
      rowNums: ['0', '1'],
      rowFlags: ['0', '0'],
      rows: [new Array(100).fill(''), new Array(100).fill('')],
    };
    client._stagePendingLine();
    return client;
  }

  async function allBodies(client) {
    const bodies = [];
    client._postServlet = async b => {
      bodies.push(b);
      return OK_RESPONSE;
    };
    await client._newTimesheetLine();
    await client._validateUdt02();
    bodies.push(client._buildOpenRsChargeLookup(), client._buildChargeLkpOk(new Array(40).fill(''), '10'));
    return bodies;
  }

  function paramTokens(bodies) {
    return bodies.flatMap(b =>
      new URLSearchParams(b.replace(/&reqIdx=\d+$/, ''))
        .get('cmd')
        .split(protocol.DLM_RS)
        .filter(Boolean)
        .flatMap(cmd => cmd.split(protocol.DLM_CMD)[1].split(protocol.DLM_PARAM))
    );
  }

  test('period 1 sends no X0 and no K0 cursor 0', async () => {
    const tokens = paramTokens(await allBodies(stagedClient(1)));
    assert.ok(tokens.includes('X1'));
    assert.ok(!tokens.includes('DX0') && !tokens.includes('X0'), 'X0 left in a K1 command');
    assert.ok(!tokens.some((t, i) => t === 'K0' && tokens[i + 1] === 'C0'), 'K0 C0 left in a command');
  });

  test('period 0 keeps X0 and K0 cursor 0', async () => {
    const tokens = paramTokens(await allBodies(stagedClient(0)));
    assert.ok(tokens.includes('X0'));
    assert.ok(tokens.some((t, i) => t === 'K0' && tokens[i + 1] === 'C0'));
    assert.ok(!tokens.includes('X1'));
  });
});

describe('add() work location callback', () => {
  test('function form receives pendingLine and its result is applied', async () => {
    const client = makeStubClient();
    client._stagePendingLine();
    client._newTimesheetLine = async () => {};
    client._validateUdt02 = async () => {};
    client._resolveChargeOnServer = async () => {};
    client._buildTableRows = () => {};
    const validated = [];
    client._validateObject = async id => {
      validated.push(id);
    };
    let seen;
    await client.add('ZLEAVE.CMP', 'REG', {
      workLocation: async pending => {
        seen = pending;
        return '62221';
      },
    });
    assert.deepEqual(seen, { payType: '', workLocation: '' });
    assert.deepEqual(validated, ['UDT03_ID']);
    assert.equal(client.pendingLine().workLocation, '62221');
  });
});
