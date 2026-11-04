'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writePrivateFile } = require('../private-file');

const mode = file => fs.statSync(file).mode & 0o777;

test('writePrivateFile creates the file owner-only', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tecli-private-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'new.json');
  writePrivateFile(file, '{}');
  assert.equal(fs.readFileSync(file, 'utf8'), '{}');
  assert.equal(mode(file), 0o600);
});

test('writePrivateFile tightens a file an older version left readable', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tecli-private-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'old.json');
  fs.writeFileSync(file, 'old', { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  writePrivateFile(file, 'new');
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  assert.equal(mode(file), 0o600);
});
