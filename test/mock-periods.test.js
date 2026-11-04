'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startMock } = require('./mock-helper');

describe('mock periods', () => {
  let mock;
  before(async () => {
    mock = await startMock();
  });
  after(() => mock.stop());

  test('getPeriods lists about 20 weeks, detail columns only for the cursor row', async () => {
    const cp = await mock.launch();
    const periods = cp.getPeriods();
    assert.equal(periods.length, 20);
    assert.deepEqual(
      periods.slice(0, 4).map(p => p.statusCode),
      ['O', 'P', 'S', 'P']
    );
    assert.equal(periods[0].editable, true);
    assert.equal(periods[1].editable, null);
    assert.equal(periods[1].endDate, '2026-10-11');
  });

  test('selectPeriod(1) shows the processed week with its own lines', async () => {
    const cp = await mock.launch();
    await cp.selectPeriod(1);
    const data = cp.getData();
    assert.equal(data.timesheetStatusCode, 'P');
    assert.equal(data.dates[0].fullDate, '2026-10-05');
    assert.equal(data.editable, true);
    assert.equal(data.projects.length, 2);
    assert.equal(data.projects[0].hours[5], 7.5);
  });

  test('selectPeriod works for every reachable period', async () => {
    const cp = await mock.launch();
    await cp.selectPeriod(19);
    assert.equal(cp.getData().dates[6].fullDate, '2026-06-07');
    await assert.rejects(() => cp.selectPeriod(20), /not available/);
  });

  test('loadPreviousPeriod preloads the week before', async () => {
    const cp = await mock.launch({ loadPreviousPeriod: true });
    const prev = cp.getPreviousPeriodData();
    assert.equal(prev.timesheetStatusCode, 'P');
    assert.equal(prev.dates[6].fullDate, '2026-10-11');
    assert.equal(prev.projects.length, 2);
  });
});

describe('auto-required quirk', () => {
  test('X=1 without the AUTO fetch returns the active week lines', async () => {
    const mock = await startMock();
    try {
      const cp = await mock.launch();
      const resp = await cp._postServlet(cp._buildPeriodFetch(1));
      const protocol = require('../protocol');
      const k1 = protocol.extract204(protocol.parseResponse(resp), 1);
      const active = cp.childData.rows.map(r => r[26] + r[27]);
      assert.deepEqual(
        k1.rows.map(r => r[26] + r[27]),
        active
      );
      assert.notEqual(active[0], '7.57.5');
    } finally {
      await mock.stop();
    }
  });

  test('with the quirk off the lines of the period come back', async () => {
    const mock = await startMock({ quirks: '' });
    try {
      const cp = await mock.launch();
      const resp = await cp._postServlet(cp._buildPeriodFetch(1));
      const protocol = require('../protocol');
      const k1 = protocol.extract204(protocol.parseResponse(resp), 1);
      assert.equal(k1.rows.length, 2);
      assert.equal(k1.rows[0][26], '7.5');
    } finally {
      await mock.stop();
    }
  });
});
