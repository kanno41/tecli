'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeWorkLocation } = require('../add-options');

describe('normalizeWorkLocation', () => {
  test('blank or missing keeps the default', () => {
    for (const v of [undefined, null, '', '   ']) assert.equal(normalizeWorkLocation(v), undefined);
  });
  test('accepts zip and ZIP+4, trimming', () => {
    assert.equal(normalizeWorkLocation(' 62226 '), '62226');
    assert.equal(normalizeWorkLocation('62226-1234'), '62226-1234');
  });
  test('rejects other values', () => {
    for (const v of ['6222', 'abcde', '62226-12']) {
      assert.throws(() => normalizeWorkLocation(v), /Invalid work location/);
    }
  });
});
