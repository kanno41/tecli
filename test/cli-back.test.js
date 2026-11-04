'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { parseBack, resolveBack, weekLabel, program } = require('../cli');

describe('cli --back option', () => {
  test('parseBack accepts integers >= 1', () => {
    assert.equal(parseBack('1'), 1);
    assert.equal(parseBack('12'), 12);
  });

  test('parseBack rejects zero, negatives, decimals and text', () => {
    for (const bad of ['0', '-1', '1.5', 'x', '', '2x']) {
      assert.throws(() => parseBack(bad), { message: /integer >= 1/ }, bad);
    }
  });

  test('resolveBack maps --prev to 1 and --back to n', () => {
    assert.equal(resolveBack({}), 0);
    assert.equal(resolveBack({ prev: true }), 1);
    assert.equal(resolveBack({ back: 3 }), 3);
  });

  test('resolveBack rejects --prev together with --back', () => {
    assert.throws(() => resolveBack({ prev: true, back: 2 }), /not both/);
  });

  test('weekLabel names the week', () => {
    assert.equal(weekLabel(1), 'previous week');
    assert.equal(weekLabel(4), '4 weeks back');
  });

  test('show, set, setm, sign and add all take --back and --prev', () => {
    for (const name of ['show', 'set', 'setm', 'sign', 'add']) {
      const cmd = program.commands.find(c => c.name() === name);
      const flags = cmd.options.map(o => o.long);
      assert.ok(flags.includes('--back'), `${name} --back`);
      assert.ok(flags.includes('--prev'), `${name} --prev`);
    }
  });

  // Favorites belong to the user, not a week (tecli-1y5)
  test('favorites takes no --back or --prev', () => {
    const cmd = program.commands.find(c => c.name() === 'favorites');
    const flags = cmd.options.map(o => o.long);
    assert.ok(!flags.includes('--back'), 'favorites --back');
    assert.ok(!flags.includes('--prev'), 'favorites --prev');
    assert.doesNotMatch(cmd.helpInformation(), /--back|--prev/);
  });
});
