'use strict';

// The te show table (cp.display()) prints hours up to xx.xx plus the comment
// marker in full, with every row the same width (tecli-a1t.10).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { stripVTControlCharacters: stripAnsi } = require('util');
const { startMock } = require('./mock-helper');
const { weekSummary } = require('../week-label');
const Costpoint = require('../costpoint');

const BORDERS = /[│┌┐└┘├┤┬┴┼]/g;

function borderOffsets(line) {
  return [...line.matchAll(BORDERS)].map(m => m.index);
}

function cells(line) {
  return line
    .split('│')
    .slice(1, -1)
    .map(c => c.trim());
}

// Every line the same width, with column borders at the same offsets
function assertAligned(rendered) {
  const lines = stripAnsi(rendered).split('\n');
  const width = lines[0].length;
  const offsets = borderOffsets(lines[0]);
  for (const line of lines) {
    assert.equal(line.length, width, `width of: ${line}`);
    assert.deepEqual(borderOffsets(line), offsets, `borders of: ${line}`);
  }
  return lines;
}

describe('DirectClient table', () => {
  let mock;
  before(async () => {
    mock = await startMock();
  });
  after(() => mock.stop());

  test('prints 9.25*, 10.5, 12.75 in full and keeps the columns aligned', async () => {
    const cp = await mock.launch();
    await cp.setm([
      { line: 0, day: 12, hours: 9.25, comment: 'long day' },
      { line: 0, day: 13, hours: 10.5 },
      { line: 0, day: 14, hours: 12.75 },
      { line: 0, day: 15, hours: 0 },
      { line: 0, day: 16, hours: 0 },
      { line: 1, day: 16, hours: 11.75 },
    ]);
    assert.match(weekSummary(cp.getData()), /Week total: 45\.75h/);

    const lines = assertAligned(cp.table.toString());
    const line0 = lines.map(cells).find(c => c[0] === '0');
    assert.deepEqual(line0.slice(4, 7), ['9.25*', '10.5', '12.75']);
    const line1 = lines.map(cells).find(c => c[0] === '1');
    assert.equal(line1[8], '11.75');
  });
});

describe('Costpoint (Puppeteer) table', () => {
  test('prints 9.25, 10.5, 12.75 in full and keeps the columns aligned', async () => {
    const moment = require('moment');
    const start = moment('2026-10-12');
    const hours = { 1: '9.25', 2: '10.5', 3: '12.75', 4: '13.25' };
    const cp = new Costpoint();
    cp._dates = async () => [...Array(7).keys()].map(i => start.clone().add(i, 'days'));
    cp._projects = async () => [{ line: 0, description: 'Alpha Research' }];
    cp._select = async () => {};
    cp._skip = async () => {};
    cp._refreshTimesheetStatus = async () => {};
    cp.page = {
      waitForSelector: async () => {},
      keyboard: { press: async () => {} },
      evaluate: async (fn, selector) => hours[/DAY(\d)_HRS/.exec(selector)[1]] || '',
    };
    await cp._table();

    const lines = assertAligned(cp.table.toString());
    const line0 = lines.map(cells).find(c => c[0] === '0');
    assert.deepEqual(line0.slice(2, 6), ['9.25', '10.5', '12.75', '13.25']);
  });
});
