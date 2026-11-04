#!/usr/bin/env node
'use strict';

// Previous-week (parent K0 row 1) editing and signing. Expected command
// shapes are transcribed from the browser captures captured/prev-period-edit/
// (013-024) and captured/prev-period-sign/ (014-015).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const protocol = require('../protocol');
const DirectClient = require('../direct');

const CAPTURE_DIR = path.join(__dirname, '../captured/prev-period-edit');
const hasCapture = fs.existsSync(path.join(CAPTURE_DIR, '015-res.txt'));
// Browser signing the previous week: 014 sign event, 015 sign confirm
const SIGN_CAPTURE_DIR = path.join(__dirname, '../captured/prev-period-sign');
const hasSignCapture = fs.existsSync(path.join(SIGN_CAPTURE_DIR, '015-res.txt'));

const S_STATUS_CD = 4;
const ACTION_CD = 23;
const ENABLE_SIGN_FL = 573;
const TS_CLOSED_FL = 685;
const ENABLE_CORRECT_FL = 676;

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeStubClient(periodIdx) {
  const client = Object.create(DirectClient.prototype);
  client.parentCol = DirectClient.CAPTURE_PARENT_COL;
  client.childCol = DirectClient.CAPTURE_CHILD_COL;
  client.lookupCol = DirectClient.CAPTURE_LOOKUP_COL;
  client._resolveLookupColumns = () => {};
  client.sid = 'SID';
  client.lastPutId = 0;
  client.periodIdx = periodIdx;
  const child = new Array(420).fill('');
  child[6] = 'G09118.A.3786.26B.200';
  child[30] = '4';
  client.childData = { rowNums: ['0'], rowFlags: ['0'], rows: [child] };
  const active = new Array(688).fill('');
  active[3] = '2026-10-04';
  active[4] = 'O';
  const prev = new Array(688).fill('');
  prev[3] = '2026-09-27';
  prev[4] = 'O';
  prev[TS_CLOSED_FL] = 'N';
  client.parentData = { rowNums: ['0', '1'], rowFlags: ['0', '0'], rows: [active, prev] };
  return client;
}

/**
 * Decode a request body into one readable token string per command, e.g.
 * '205 X1 K1 C0 P0 Vtrue $lastPutId$'. lastPutId values and S/E range
 * bounds are dropped (they depend on client counters and row counts).
 */
function commands(body) {
  const params = new URLSearchParams(body.replace(/&reqIdx=\d+$/, ''));
  const split = k => (params.get(k) || '').split(protocol.DLM_RS);
  const flags = split('editFlag');
  const rowNums = split('rowNumber');
  return split('cmd')
    .filter(Boolean)
    .map((cmd, i) => {
      const reqCd = cmd.substring(0, cmd.indexOf('A'));
      const paramStr = cmd.substring(cmd.indexOf(protocol.DLM_CMD) + 3, cmd.length - protocol.DLM_CMD.length);
      const tokens = paramStr
        .split(protocol.DLM_PARAM)
        .filter(Boolean)
        .map(p => {
          if (p.startsWith('$')) {
            const [name, value] = p.split(protocol.DLM_NAMED);
            return name === '$lastPutId$' ? name : name + '=' + value;
          }
          return /^[SE]/.test(p) ? p[0] : p;
        });
      return { cmd: [reqCd, ...tokens].join(' '), editFlag: flags[i], rowNumber: rowNums[i] };
    });
}

function cmdStrings(body) {
  return commands(body).map(c => c.cmd);
}

function readCapture(name, dir = CAPTURE_DIR) {
  return fs.readFileSync(path.join(dir, name), 'utf8');
}

const OK_RESPONSE = 'var responses=[["TMMTIMESHEET|0|507|0|0|0|0"],null,[null],["<OK>"]];';

const K0_REFRESH_C1 = [
  '204 $rsType$=M RABS S E K0 C1 Vtrue $nonDBSize$=1 $nonDBStart$=0',
  '204 $rsType$=M RABS S E K0 C1 Vtrue',
];
const K1_REFRESH_X1 = ['204 $rsType$=M RABS S E X1 K1 C0 P0 Vtrue', '204 $rsType$=M RABS S E X1 K1 C0 P0 Vtrue'];

const REPORT_BOILERPLATE = [
  '$rptPrintAllPages$=Y',
  '$rptInclCoverPage$=Y',
  '$printRpt$=N',
  '$rptScalingFactor$=DFLT',
  '$rptPrnNofC$=1',
  '$downloadRpt$=Y',
  '$emailRpt$=N',
  '$printToFileRpt$=N',
  '$rptLocale$=VIEW_AS_BUILT',
  '$runAfterRptFl$=Y',
  '$archiveRpt$=N',
  '$rptArchRelativeAbsDt$=Y',
  '$rptArchNeverDelete$=Y',
  '$syncRequest$=true',
  '$rptFormat$=pdf',
  '$printLocalRpt$=N',
  '$printSendEmail1$=N',
  '$printHomePage1$=N',
  '$printPopupAlert1$=N',
  '$printSendEmail2$=N',
  '$printHomePage2$=N',
  '$printPopupAlert2$=N',
  '$printSendEmail3$=N',
  '$printHomePage3$=N',
  '$printPopupAlert3$=N',
  '$printSendEmail4$=N',
  '$printHomePage4$=N',
  '$printPopupAlert4$=N',
  '$rptEmailAttachmentCount$=0',
];

function signAction(period) {
  return [
    '300',
    ...REPORT_BOILERPLATE,
    '$actionId$=TMMTS_SIGN_TIMESHEET',
    '$restartFl$=false',
    'C' + period,
    '$longRunActionFl$=0',
    '$procUniqueId$=TMMTIMESHEET:A:SID:1',
    '$psSchWorkflowNotifyFl$=false',
    'K0',
    'Vtrue',
  ].join(' ');
}

// ─── Batch shapes for the previous week (periodIdx = 1) ───────────────────

describe('previous-week batches match the browser capture', () => {
  test('cell edit (capture 016)', () => {
    const client = makeStubClient(1);
    const cmds = commands(client._buildCellEditBatch(0, 0, 5));
    assert.deepEqual(
      cmds.map(c => c.cmd),
      [
        '205 X1 K1 C0 P0 Vtrue $lastPutId$',
        '208 $objectId$=DAY5_HRS K1 C0 P0 Vtrue',
        ...K0_REFRESH_C1,
        ...K1_REFRESH_X1,
        '507 Vtrue',
      ]
    );
    assert.equal(cmds[0].editFlag, '18,');
    assert.equal(cmds[0].rowNumber, '0,');
  });

  test('save (capture 017): parent row 1, editFlag 18, 206 on cursor 1', () => {
    const client = makeStubClient(1);
    const cmds = commands(client._buildSaveBatch());
    assert.deepEqual(
      cmds.slice(0, 3).map(c => c.cmd),
      ['205 K0 C1 Vtrue $lastPutId$', '205 X1 K1 C0 P0 Vtrue $lastPutId$', '206 Gfalse C1 Utrue K0 Vtrue']
    );
    assert.equal(cmds[0].editFlag, '18,');
    assert.equal(cmds[0].rowNumber, '1,');
    assert.equal(cmds[1].editFlag, '18,');
    assert.equal(cmds[1].rowNumber, '0,');
    assert.deepEqual(
      cmds.slice(3).map(c => c.cmd),
      [...K0_REFRESH_C1, ...K1_REFRESH_X1, '507 Vtrue']
    );
  });

  test('save puts the previous week parent row, not the active one', () => {
    const client = makeStubClient(1);
    const params = new URLSearchParams(client._buildSaveBatch());
    const parentData = params.get('data').split(protocol.DLM_RS)[0];
    assert.equal(parentData, protocol.encodePutRow(client.parentData.rows[1]) + protocol.DLM_ROW);
  });

  test('correct event (capture 014)', () => {
    const client = makeStubClient(1);
    const body = client._buildCorrectEvent();
    assert.match(body, /&reqIdx=1$/);
    const cmds = commands(body);
    assert.deepEqual(
      cmds.map(c => c.cmd),
      [
        '205 $rsRowSelectedFlOnly$=true K0 C1 Vtrue',
        '205 $rsContextOnly$=Y K0 C1 Vtrue $lastPutId$',
        '205 X1 $rsContextOnly$=Y K1 C0 P0 Vtrue $lastPutId$',
        [
          '300',
          ...REPORT_BOILERPLATE,
          '$actionId$=TMMTS_CORRECT_TIMESHEET',
          '$restartFl$=false',
          'C1',
          '$longRunActionFl$=0',
          '$procUniqueId$=TMMTIMESHEET:A:SID:1',
          '$psSchWorkflowNotifyFl$=false',
          'K0',
          'Vtrue',
        ].join(' '),
        ...K0_REFRESH_C1,
        ...K1_REFRESH_X1,
        '507 Vtrue',
      ]
    );
    assert.deepEqual(
      cmds.slice(0, 3).map(c => [c.editFlag, c.rowNumber]),
      [
        ['64,', '1,'],
        ['64,', '1,'],
        ['0,', '0,'],
      ]
    );
  });

  test('correct save (capture 015)', () => {
    const client = makeStubClient(1);
    const cmds = commands(client._buildCorrectSaveBatch());
    assert.deepEqual(
      cmds.map(c => c.cmd),
      [
        '205 K0 C1 Vtrue $lastPutId$',
        '206 Gfalse C1 Utrue K0 Vtrue',
        ...K0_REFRESH_C1,
        '204 $rsType$=M RS&C S E W K0 C1 Vtrue',
        ...K1_REFRESH_X1,
        '204 $rsType$=M RS&C S E X0 W K1 C0 P0 Vtrue',
        '507 Vtrue',
      ]
    );
    assert.equal(cmds[0].editFlag, '82,');
    assert.equal(cmds[0].rowNumber, '1,');
  });

  test('sign event (prev-period-sign 014)', () => {
    const client = makeStubClient(1);
    const body = client._buildSignEvent();
    assert.match(body, /&reqIdx=1$/);
    const cmds = commands(body);
    assert.deepEqual(
      cmds.map(c => c.cmd),
      [
        '205 $rsRowSelectedFlOnly$=true K0 C1 Vtrue',
        '205 K0 C1 Vtrue $lastPutId$',
        '205 $rsContextOnly$=Y K0 C1 Vtrue $lastPutId$',
        '205 X1 $rsContextOnly$=Y K1 C0 P0 Vtrue $lastPutId$',
        signAction(1),
        ...K0_REFRESH_C1,
        ...K1_REFRESH_X1,
        '507 Vtrue',
      ]
    );
    assert.deepEqual(
      cmds.slice(0, 4).map(c => [c.editFlag, c.rowNumber]),
      [
        ['64,', '1,'],
        ['82,', '1,'],
        ['82,', '1,'],
        ['0,', '0,'],
      ]
    );
  });

  test('sign event marks the previous week parent row, not the active one', () => {
    const client = makeStubClient(1);
    client._buildSignEvent();
    assert.equal(client.parentData.rows[1][ACTION_CD], 'S');
    assert.equal(client.parentData.rows[0][ACTION_CD], '');
  });

  test('sign confirm (prev-period-sign 015): K1 S&C keeps X=0 like the browser', () => {
    const client = makeStubClient(1);
    const cmds = commands(client._buildSignConfirmBatch());
    assert.deepEqual(
      cmds.map(c => c.cmd),
      [
        '205 K0 C1 Vtrue $lastPutId$',
        '206 Gfalse C1 Utrue K0 Vtrue',
        ...K0_REFRESH_C1,
        '204 $rsType$=M RS&C S E W K0 C1 Vtrue',
        ...K1_REFRESH_X1,
        '204 $rsType$=M RS&C S E X0 W K1 C0 P0 Vtrue',
        '507 Vtrue',
      ]
    );
    assert.equal(cmds[0].editFlag, '18,');
    assert.equal(cmds[0].rowNumber, '1,');
  });

  test('revision open and query use X=1 (captures 019, 021)', () => {
    const client = makeStubClient(1);
    assert.match(cmdStrings(client._buildOpenRevisionRS())[0], /^201 K2 ITMMTS_TS_REVISION_EXP N22410 P0 TD X1 /);
    assert.deepEqual(cmdStrings(client._buildQueryRevisionAndOpenAudit()), [
      '204 $rsType$=SR RABS S E X1 K2 C-60000 P0 Vtrue $nonDBSize$=1 $nonDBStart$=0',
      '204 $rsType$=SR RABS S E X1 K2 C-60000 P0 Vtrue',
      '201 K3 ITMMTS_TS_AUDIT_EXP N22411 P2 TD X-60000 C-60000 Vtrue',
      '507 Vtrue',
    ]);
  });

  test('revision save (capture 024)', () => {
    const client = makeStubClient(1);
    client._revisionMeta = { emplId: '412582', periodNoCd: '038', scheduleCd: 'W', year: '2026' };
    client._revisionNumber = 3;
    client._revisionRowNum = '-59999';
    const cmds = commands(client._buildRevisionSaveBatch('why'));
    assert.deepEqual(
      cmds.slice(0, 4).map(c => c.cmd),
      [
        '205 $rsRowSelectedFlOnly$=true X1 K2 C-59999 P0 Vtrue',
        '205 X1 K2 C-59999 P0 Vtrue $lastPutId$',
        '205 X1 K2 C-59999 P0 Vtrue $lastPutId$',
        '206 Gfalse C1 Utrue K0 Vtrue',
      ]
    );
    assert.ok(cmds.slice(0, 3).every(c => c.editFlag === '65619,' && c.rowNumber === '-59999,'));
  });

  test('period fetch loads K1 lines for X=1 (capture 013)', () => {
    const client = makeStubClient(0);
    assert.deepEqual(cmdStrings(client._buildPeriodFetch(1)), [
      '204 $rsType$=M RABS S E K0 C1 Vtrue $nonDBSize$=1 $nonDBStart$=0',
      '204 $rsType$=M RABS S E X1 K1 C-60000 P0 Vtrue $nonDBSize$=9 $nonDBStart$=0',
      '204 $rsType$=M RABS S E X1 K1 C-60000 P0 Vtrue',
      '507 Vtrue',
    ]);
  });

  test('AUTO parent fetch matches the browser byte for byte (capture 009)', () => {
    const client = makeStubClient(0);
    assert.equal(
      client._buildAutoParentFetch(),
      'sid=SID&cmd=204ATMMTIMESHEETC%05D%24rsType%24N%08MP%07RAUTOP%07X0P%07W%24N%24%7C1%3A20%7C0%7CP%07K0P%07C0P%07VtrueP%07C%05K%01' +
        '&objId=K%01&editFlag=K%01&rowNumber=K%01&data=K%01&autocompletefl=Y'
    );
  });
});

// ─── Active week (periodIdx = 0) regression guard ─────────────────────────

describe('active-week batches are unchanged', () => {
  test('cell edit targets X=0 and cursor 0', () => {
    const client = makeStubClient(0);
    assert.deepEqual(cmdStrings(client._buildCellEditBatch(0, 0, 3)), [
      '205 X0 K1 C0 P0 Vtrue $lastPutId$',
      '208 $objectId$=DAY3_HRS K1 C0 P0 Vtrue',
      '204 $rsType$=M RABS S E K0 C0 Vtrue $nonDBSize$=1 $nonDBStart$=0',
      '204 $rsType$=M RABS S E K0 C0 Vtrue',
      '204 $rsType$=M RABS S E X0 K1 C0 P0 Vtrue',
      '204 $rsType$=M RABS S E X0 K1 C0 P0 Vtrue',
      '507 Vtrue',
    ]);
  });

  test('save keeps parent row 0 and editFlag 65562', () => {
    const client = makeStubClient(0);
    const cmds = commands(client._buildSaveBatch());
    assert.deepEqual(
      cmds.slice(0, 3).map(c => c.cmd),
      ['205 K0 C0 Vtrue $lastPutId$', '205 X0 K1 C0 P0 Vtrue $lastPutId$', '206 Gfalse C0 Utrue K0 Vtrue']
    );
    assert.equal(cmds[0].editFlag, '65562,');
    assert.equal(cmds[0].rowNumber, '0,');
  });

  test('sign event keeps cursor 0, X=0 and parent row 0', () => {
    const client = makeStubClient(0);
    const body = client._buildSignEvent();
    assert.match(body, /&reqIdx=1$/);
    const cmds = commands(body);
    assert.deepEqual(
      cmds.map(c => c.cmd),
      [
        '205 $rsRowSelectedFlOnly$=true K0 C0 Vtrue',
        '205 K0 C0 Vtrue $lastPutId$',
        '205 $rsContextOnly$=Y K0 C0 Vtrue $lastPutId$',
        '205 X0 $rsContextOnly$=Y K1 C0 P0 Vtrue $lastPutId$',
        signAction(0),
        '204 $rsType$=M RABS S E K0 C0 Vtrue $nonDBSize$=1 $nonDBStart$=0',
        '204 $rsType$=M RABS S E K0 C0 Vtrue',
        '204 $rsType$=M RABS S E X0 K1 C0 P0 Vtrue',
        '204 $rsType$=M RABS S E X0 K1 C0 P0 Vtrue',
        '507 Vtrue',
      ]
    );
    assert.deepEqual(
      cmds.slice(0, 4).map(c => [c.editFlag, c.rowNumber]),
      [
        ['64,', '0,'],
        ['82,', '0,'],
        ['82,', '0,'],
        ['0,', '0,'],
      ]
    );
  });

  test('sign confirm keeps cursor 0 and editFlag 18', () => {
    const client = makeStubClient(0);
    const cmds = commands(client._buildSignConfirmBatch());
    assert.deepEqual(
      cmds.slice(0, 2).map(c => c.cmd),
      ['205 K0 C0 Vtrue $lastPutId$', '206 Gfalse C0 Utrue K0 Vtrue']
    );
    assert.equal(cmds[0].editFlag, '18,');
    assert.equal(cmds[0].rowNumber, '0,');
    assert.equal(cmds[4].cmd, '204 $rsType$=M RS&C S E W K0 C0 Vtrue');
  });

  test('revision save keeps X=0 and cursor 0', () => {
    const client = makeStubClient(0);
    client._revisionMeta = { emplId: '1', periodNoCd: '039', scheduleCd: 'W', year: '2026' };
    client._revisionNumber = 1;
    client._revisionRowNum = '-59999';
    assert.deepEqual(cmdStrings(client._buildRevisionSaveBatch('why')).slice(0, 4), [
      '205 $rsRowSelectedFlOnly$=true X0 K2 C-59999 P0 Vtrue',
      '205 X0 K2 C-59999 P0 Vtrue $lastPutId$',
      '205 X0 K2 C-59999 P0 Vtrue $lastPutId$',
      '206 Gfalse C0 Utrue K0 Vtrue',
    ]);
  });
});

// ─── Add and favorites on the previous week (captured/past-week-add) ──────

const K1_REFRESH_X1_PENDING = [
  '204 $rsType$=M RABS S E X1 K1 C0 P0 Vtrue',
  '204 $rsType$=M RABS S E X1 K1 C0 P0 Vtrue',
];

function withPendingLine(client) {
  client._stagePendingLine();
  return client;
}

describe('past-week add and favorites batches (captured/past-week-add 014-019)', () => {
  test('TMMTS_NEW_TS_LINE (capture 014)', () => {
    const client = withPendingLine(makeStubClient(1));
    let body;
    client._postServlet = async b => {
      body = b;
      return OK_RESPONSE;
    };
    return client._newTimesheetLine().then(() => {
      assert.match(body, /&reqIdx=1$/);
      const cmds = commands(body);
      assert.deepEqual(
        cmds.map(c => c.cmd),
        [
          '205 K0 C1 Vtrue $lastPutId$',
          '205 X1 K1 C-59999 P0 Vtrue $lastPutId$',
          '205 $rsContextOnly$=Y K0 C1 Vtrue $lastPutId$',
          '205 X1 $rsContextOnly$=Y K1 C-59999 P0 Vtrue $lastPutId$',
          [
            '300',
            ...REPORT_BOILERPLATE,
            '$actionId$=TMMTS_NEW_TS_LINE',
            '$restartFl$=false',
            'C-59999',
            '$longRunActionFl$=0',
            '$procUniqueId$=TMMTIMESHEET:A:SID:1',
            '$psSchWorkflowNotifyFl$=false',
            'K1',
            'P0',
            'Vtrue',
          ].join(' '),
          ...K0_REFRESH_C1,
          ...K1_REFRESH_X1_PENDING,
          '507 Vtrue',
        ]
      );
      assert.deepEqual(
        cmds.slice(0, 4).map(c => [c.editFlag, c.rowNumber]),
        [
          ['18,', '1,'],
          ['19,', '-59999,'],
          ['18,', '1,'],
          ['19,', '-59999,'],
        ]
      );
    });
  });

  test('NEW_TS_LINE puts the previous week parent row, not the active one', () => {
    const client = withPendingLine(makeStubClient(1));
    client.parentData.rows[1][0] = 'PREV';
    let body;
    client._postServlet = async b => {
      body = b;
      return OK_RESPONSE;
    };
    return client._newTimesheetLine().then(() => {
      const parentData = new URLSearchParams(body).get('data').split(protocol.DLM_RS)[0];
      assert.equal(parentData, protocol.encodePutRow(client.parentData.rows[1]) + protocol.DLM_ROW);
    });
  });

  test('UDT02 validate (capture 019)', () => {
    const client = withPendingLine(makeStubClient(1));
    let body;
    client._postServlet = async b => {
      body = b;
      return OK_RESPONSE;
    };
    return client._validateUdt02().then(() => {
      const cmds = commands(body);
      assert.deepEqual(
        cmds.map(c => c.cmd),
        [
          '205 X1 K1 C-59999 P0 Vtrue $lastPutId$',
          '205 X1 $rsContextOnly$=Y K1 C-59999 P0 Vtrue $lastPutId$',
          '208 $objectId$=UDT02_ID K1 C-59999 P0 Vtrue',
          ...K0_REFRESH_C1,
          ...K1_REFRESH_X1_PENDING,
          '507 Vtrue',
        ]
      );
    });
  });

  test('charge lookup OPEN_RS PUTs the pending row on X=1', () => {
    const client = withPendingLine(makeStubClient(1));
    assert.deepEqual(cmdStrings(client._buildOpenRsChargeLookup()).slice(0, 1), [
      '205 X1 K1 C-59999 P0 Vtrue $lastPutId$',
    ]);
  });

  test('TC_TS_CHARGE_LKP_OK (capture 018)', () => {
    const client = withPendingLine(makeStubClient(1));
    client._actionSeq = 1; // NEW_TS_LINE was the first action of the add
    const k2Row = new Array(40).fill('');
    const cmds = commands(client._buildChargeLkpOk(k2Row, '10'));
    assert.deepEqual(
      cmds.map(c => c.cmd),
      [
        '205 $rsRowSelectedFlOnly$=true X-59999 K2 C0 P1 Vtrue',
        '205 X1 K1 C-59999 P0 Vtrue $lastPutId$',
        '205 X-59999 K2 C0 P1 Vtrue $lastPutId$',
        '205 X1 $rsContextOnly$=Y K1 C-59999 P0 Vtrue $lastPutId$',
        '205 $rsContextOnly$=Y K0 C1 Vtrue $lastPutId$',
        '205 X-59999 $rsContextOnly$=Y K2 C0 P1 Vtrue $lastPutId$',
        [
          '300',
          ...REPORT_BOILERPLATE,
          '$actionId$=TC_TS_CHARGE_LKP_OK',
          '$restartFl$=false',
          'C0',
          '$longRunActionFl$=0',
          '$procUniqueId$=TMMTIMESHEET:A:SID:2',
          '$psSchWorkflowNotifyFl$=false',
          'K2',
          'P1',
          'Vtrue',
        ].join(' '),
        ...K0_REFRESH_C1,
        '204 $rsType$=M RABS S E X1 K1 C-59999 P0 Vtrue',
        '204 $rsType$=M RABS S E X1 K1 C-59999 P0 Vtrue',
        '204 $rsType$=L RABS S E X-59999 $objectId$=UDT02_ID K2 C0 P1 Vtrue',
        '204 $rsType$=L RABS S E X-59999 K2 C0 P1 Vtrue',
        '507 Vtrue',
      ]
    );
    assert.equal(cmds[4].editFlag, '65562,');
    assert.equal(cmds[4].rowNumber, '1,');
    assert.equal(cmds[0].rowNumber, '10,');
  });

  test('getFavorites() registers the line on period 1, then runs the K2 lookups', async () => {
    const client = makeStubClient(1);
    const bodies = [];
    client._postServlet = async b => {
      bodies.push(b);
      return OK_RESPONSE;
    };
    client._buildTableRows = () => {};
    assert.deepEqual(await client.getFavorites(), []);
    assert.equal(bodies.length, 4);
    assert.equal(cmdStrings(bodies[0])[0], '205 K0 C1 Vtrue $lastPutId$');
    assert.match(cmdStrings(bodies[1])[0], /^201 K2 ITC_UDT02_CHARGE_LKP /);
    assert.match(cmdStrings(bodies[2])[0], /^204 \$rsType\$=L RHLKP S E X-59999 W.*K2 C-60000 P1 Vtrue$/);
    assert.match(cmdStrings(bodies[3])[0], /^204 \$rsType\$=L RHLKP S E X-59999 W.*K2 C0 P1 Vtrue$/);
    // Live Costpoint refuses the delete of the uncharged line (tecli-4c4)
    assert.ok(client.pendingLine());
  });

  test('getFavorites() does not correct a closed week', async () => {
    const client = makeStubClient(1);
    client.parentData.rows[1][TS_CLOSED_FL] = 'Y';
    client._correctTimesheet = async () => {
      throw new Error('must not correct');
    };
    client._postServlet = async () => OK_RESPONSE;
    client._buildTableRows = () => {};
    assert.deepEqual(await client.getFavorites(), []);
  });

  test('stage refuses a week with no lines', () => {
    const client = makeStubClient(1);
    client.childData = { rowNums: [], rowFlags: [], rows: [] };
    assert.throws(() => client._stagePendingLine(), /no existing lines/);
  });
});

describe('getPeriods()', () => {
  test('lists the loaded K0 rows', () => {
    const client = makeStubClient(0);
    client.parentData.rows[0][TS_CLOSED_FL] = 'N';
    client.parentData.rows[1][TS_CLOSED_FL] = 'Y';
    client.parentData.rows[1][ENABLE_CORRECT_FL] = 'N';
    client.parentData.rows[1][S_STATUS_CD] = 'P';
    assert.deepEqual(client.getPeriods(), [
      { idx: 0, endDate: '2026-10-04', statusCode: 'O', editable: true },
      { idx: 1, endDate: '2026-09-27', statusCode: 'P', editable: false },
    ]);
  });

  test('editable is null for rows without detail columns', () => {
    const client = makeStubClient(0);
    client.parentData.rows[1][TS_CLOSED_FL] = '';
    assert.equal(client.getPeriods()[1].editable, null);
  });
});

// ─── Older weeks (captured/past-week-add 024, 025) ────────────────────────

const PAST_ADD_DIR = path.join(__dirname, '../captured/past-week-add');
const hasPastAddCapture = fs.existsSync(path.join(PAST_ADD_DIR, '025-req.txt'));

function rangeBounds(body) {
  const params = new URLSearchParams(body.replace(/&reqIdx=\d+$/, ''));
  return params
    .get('cmd')
    .split(protocol.DLM_RS)
    .filter(Boolean)
    .map(cmd => {
      const tokens = cmd.split(protocol.DLM_CMD)[1].split(protocol.DLM_PARAM);
      return tokens.filter(t => /^[SE]-?\d+$/.test(t));
    })
    .filter(b => b.length);
}

describe(
  'period fetch for older weeks (captured/past-week-add 024, 025)',
  { skip: !hasPastAddCapture && 'captured/past-week-add not present' },
  () => {
    for (const [idx, file] of [
      [2, '024-req.txt'],
      [3, '025-req.txt'],
    ]) {
      test(`X=${idx}: K1 commands match the browser arrow fetch`, () => {
        const client = makeStubClient(0);
        const browser = cmdStrings(readCapture(file, PAST_ADD_DIR));
        assert.deepEqual(browser, [
          `204 $rsType$=M RABS S E X${idx} K1 C-60000 P0 Vtrue`,
          `204 $rsType$=M RABS S E X${idx} K1 C-60000 P0 Vtrue`,
          '507 Vtrue',
        ]);
        const ours = cmdStrings(client._buildPeriodFetch(idx));
        assert.deepEqual(ours.slice(2), [browser[1], browser[2]]);
        assert.match(ours[1], new RegExp(`^204 \\$rsType\\$=M RABS S E X${idx} K1 C-60000 P0 Vtrue`));
      });
    }

    test('known differences: browser sends no K0 fetch and wider E bounds', () => {
      const browser = rangeBounds(readCapture('024-req.txt', PAST_ADD_DIR));
      const ours = rangeBounds(makeStubClient(0)._buildPeriodFetch(2));
      assert.deepEqual(browser, [
        ['S0', 'E45'],
        ['S-59999', 'E-59954'],
      ]);
      assert.deepEqual(ours, [
        ['S0', 'E20'],
        ['S0', 'E40'],
        ['S-59999', 'E-59959'],
      ]);
    });
  }
);

// ─── Guards and flow ──────────────────────────────────────────────────────

describe('previous-week guards', () => {
  for (const [name, call] of [
    ['add()', c => c.add('ZLEAVE.CMP', 'REG')],
    ['getFavorites({ keepLine: true })', c => c.getFavorites({ keepLine: true })],
  ]) {
    test(`${name} on a closed past week corrects first`, async () => {
      const client = makeStubClient(1);
      client.parentData.rows[1][TS_CLOSED_FL] = 'Y';
      const order = [];
      client._correctTimesheet = async () => {
        order.push('correct');
        client.parentData.rows[1][TS_CLOSED_FL] = 'N';
      };
      client._newTimesheetLine = async () => {
        order.push('newLine');
      };
      client._validateUdt02 = async () => {
        order.push('validate');
      };
      client._resolveChargeOnServer = async () => {
        order.push('resolve');
      };
      client._buildTableRows = () => {};
      client._postServlet = async () => OK_RESPONSE;
      await call(client);
      assert.equal(order.filter(s => s === 'correct').length, 1);
      assert.equal(order[0], 'correct');
      assert.equal(order[1], 'newLine');
    });

    test(`${name} does not correct an open past week`, async () => {
      const client = makeStubClient(1);
      client._correctTimesheet = async () => {
        throw new Error('must not correct');
      };
      client._newTimesheetLine = async () => {};
      client._validateUdt02 = async () => {};
      client._resolveChargeOnServer = async () => {};
      client._buildTableRows = () => {};
      client._postServlet = async () => OK_RESPONSE;
      await call(client);
    });

    test(`${name} refuses a closed past week Costpoint will not correct`, async () => {
      const client = makeStubClient(1);
      client.parentData.rows[1][TS_CLOSED_FL] = 'Y';
      client.parentData.rows[1][ENABLE_CORRECT_FL] = 'N';
      client._postServlet = async () => {
        throw new Error('must not reach the server');
      };
      await assert.rejects(call(client), /does not allow correcting/);
    });
  }

  test('sign() refuses a week Costpoint does not allow signing', async () => {
    const client = makeStubClient(1);
    client.parentData.rows[1][S_STATUS_CD] = 'S';
    client.parentData.rows[1][ENABLE_SIGN_FL] = 'N';
    client._postServlet = async () => {
      throw new Error('must not reach the server');
    };
    await assert.rejects(client.sign(), /does not allow signing this week \(status Signed\)/);
  });

  test('set() rejects a day outside the selected week', async () => {
    const client = makeStubClient(1);
    client._buildDates();
    client._postServlet = async () => {
      throw new Error('must not reach the server');
    };
    await assert.rejects(client.set(0, 28, 8), /not in this week/);
  });

  test('set() maps a date across a month boundary to the right column', async () => {
    const client = makeStubClient(0);
    client._buildDates(); // 2026-09-28 .. 2026-10-04
    client._buildTableRows = () => {};
    let body = null;
    client._postServlet = async b => {
      body = b;
      return OK_RESPONSE;
    };
    await client.set(0, 2, 7.5);
    assert.equal(client.childData.rows[0][30], '7.5'); // Fri Oct 2 = DAY5
    assert.match(cmdStrings(body)[1], /^208 \$objectId\$=DAY5_HRS /);
  });

  test('set() corrects a closed week once before the first edit', async () => {
    const client = makeStubClient(1);
    client.parentData.rows[1][TS_CLOSED_FL] = 'Y';
    client._buildDates();
    client._buildTableRows = () => {};
    let corrections = 0;
    client._correctTimesheet = async () => {
      corrections++;
      client.parentData.rows[1][TS_CLOSED_FL] = 'N';
    };
    client._postServlet = async () => OK_RESPONSE;
    await client.set(0, 25, 8);
    await client.set(0, 26, 1);
    assert.equal(corrections, 1);
  });

  test('_correctTimesheet() refuses when Costpoint does not allow a correction', async () => {
    const client = makeStubClient(1);
    client.parentData.rows[1][TS_CLOSED_FL] = 'Y';
    client.parentData.rows[1][ENABLE_CORRECT_FL] = 'N';
    client._postServlet = async () => {
      throw new Error('must not reach the server');
    };
    await assert.rejects(client._correctTimesheet(), /does not allow correcting/);
  });
});

// ─── Against captured responses ───────────────────────────────────────────

describe(
  'previous-week flow against captured responses',
  { skip: !hasCapture && 'captured/prev-period-edit not present' },
  () => {
    test('selectPeriod(1) loads the previous week', async () => {
      const client = makeStubClient(0);
      client.childData = { rowNums: [], rowFlags: [], rows: [] };
      const sent = [];
      const responses = [readCapture('009-res.txt'), readCapture('015-res.txt')];
      client._postServlet = async body => {
        sent.push(body);
        return responses.shift();
      };

      await client.selectPeriod(1);

      assert.equal(sent[0], client._buildAutoParentFetch());
      assert.equal(client.periodIdx, 1);
      assert.equal(client.dates[0].format('YYYY-MM-DD'), '2026-09-21');
      assert.equal(client.dates[6].format('YYYY-MM-DD'), '2026-09-27');
      assert.equal(client.childData.rows.length, 1);
      assert.equal(client.childData.rows[0][6], 'G09118.A.3786.26B.200');
      const data = client.getData();
      assert.equal(data.timesheetStatusCode, 'O');
      assert.equal(data.editable, true);
      assert.equal(data.projects[0].hours[21], 9.25);
    });

    test('_correctTimesheet() sends the Correct flow and reopens the week', async () => {
      const client = makeStubClient(1);
      // Parent state right after the Correct action (processed, closed)
      client.parentData = protocol.extract204(protocol.parseResponse(readCapture('014-res.txt')), 0);
      assert.equal(client.parentData.rows[1][TS_CLOSED_FL], 'Y');
      client._buildTableRows = () => {};
      const sent = [];
      const responses = [readCapture('014-res.txt'), readCapture('015-res.txt')];
      client._postServlet = async body => {
        sent.push(body);
        return responses.shift();
      };

      await client._correctTimesheet();

      assert.equal(sent.length, 2);
      assert.match(cmdStrings(sent[0])[3], /\$actionId\$=TMMTS_CORRECT_TIMESHEET/);
      assert.equal(commands(sent[1])[0].editFlag, '82,');
      assert.equal(client.parentData.rows[1][TS_CLOSED_FL], 'N');
      assert.equal(client.parentData.rows[1][4], 'O');
    });

    // Replays the save with the event's response (week still closed) to stand
    // in for a stale save response
    function correctWithStaleSave(refetchResponse) {
      const client = makeStubClient(1);
      client.parentData = protocol.extract204(protocol.parseResponse(readCapture('014-res.txt')), 0);
      client._buildTableRows = () => {};
      const sent = [];
      const responses = ['014-res.txt', '014-res.txt', '009-res.txt', refetchResponse].map(f => readCapture(f));
      client._postServlet = async body => {
        sent.push(body);
        return responses.shift();
      };
      return { client, sent };
    }

    test('_correctTimesheet() re-fetches when the save response still shows the week closed', async () => {
      const { client, sent } = correctWithStaleSave('015-res.txt');

      await client._correctTimesheet();

      assert.equal(sent.length, 4);
      assert.equal(sent[2], client._buildAutoParentFetch());
      assert.equal(client.parentData.rows[1][TS_CLOSED_FL], 'N');
      assert.equal(client.childData.rows[0][6], 'G09118.A.3786.26B.200');
    });

    test('_correctTimesheet() still fails when the re-fetch shows the week closed', async () => {
      const { client } = correctWithStaleSave('014-res.txt');
      await assert.rejects(client._correctTimesheet(), /Correct did not take effect/);
    });
  }
);

describe(
  'previous-week sign against captured responses',
  { skip: !hasSignCapture && 'captured/prev-period-sign not present' },
  () => {
    test('sign() signs period 1 and sends the browser confirm row', async () => {
      const client = makeStubClient(1);
      client._buildTableRows = () => {};
      const sent = [];
      // The re-read after the confirm is the AUTO fetch, then the period
      // fetch (tecli-lok); the AUTO reply is not read
      const responses = ['014-res.txt', '015-res.txt', '015-res.txt', '015-res.txt'].map(f =>
        readCapture(f, SIGN_CAPTURE_DIR)
      );
      client._postServlet = async body => {
        sent.push(body);
        return responses.shift();
      };

      await client.sign();

      assert.equal(sent.length, 4);
      assert.equal(cmdStrings(sent[0])[4], signAction(1));
      assert.equal(sent[2], client._buildAutoParentFetch());
      assert.equal(sent[3], client._buildPeriodFetch(1));
      const confirmData = new URLSearchParams(sent[1]).get('data').split(protocol.DLM_RS)[0];
      const browserData = new URLSearchParams(readCapture('015-req.txt', SIGN_CAPTURE_DIR))
        .get('data')
        .split(protocol.DLM_RS)[0];
      assert.equal(confirmData, browserData);
      assert.equal(client.parentData.rows[1][S_STATUS_CD], 'S');
    });
  }
);
