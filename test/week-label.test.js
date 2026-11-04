'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { weekLabel, assertBackReachable, weekSummary } = require('../week-label');

describe('week-label', () => {
  test('weekLabel names the week', () => {
    assert.equal(weekLabel(1), 'previous week');
    assert.equal(weekLabel(3), '3 weeks back');
  });

  test('assertBackReachable allows the last loaded period', () => {
    assert.doesNotThrow(() => assertBackReachable(19, 20));
    assert.doesNotThrow(() => assertBackReachable(0, 1));
  });

  test('assertBackReachable reports how far back Costpoint goes', () => {
    assert.throws(() => assertBackReachable(20, 20), /Cannot go back 20 weeks. Costpoint offers 19 past weeks./);
    assert.throws(() => assertBackReachable(2, 2), /offers 1 past week\./);
  });

  test('weekSummary sums every line and says whether the week is signed', () => {
    const projects = [{ hours: { 12: 8, 13: 4.25, 14: null } }, { hours: { 12: 0.5 } }];
    assert.equal(weekSummary({ timesheetStatusCode: 'O', projects }), 'Signed: no | Week total: 12.75h');
    for (const code of ['S', 'A', 'P']) {
      assert.equal(weekSummary({ timesheetStatusCode: code, projects: [] }), 'Signed: yes | Week total: 0h', code);
    }
    assert.equal(weekSummary({ timesheetStatusCode: 'R', projects: [] }), 'Signed: no | Week total: 0h');
  });

  test('weekSummary rounds away float noise', () => {
    const projects = [{ hours: { 1: 0.1, 2: 0.2 } }];
    assert.equal(weekSummary({ timesheetStatusCode: 'O', projects }), 'Signed: no | Week total: 0.3h');
  });
});
