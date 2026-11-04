#!/usr/bin/env node
'use strict';

// One-off local build of mock/fixture.json from captured/ (real traffic that
// is gitignored). Takes the column layout and constant column values from the
// captures and keeps only anonymised data. Run: node mock/build-fixture.js
//
// The seed scenario (which weeks exist and their hours) comes from
// test/fixtures/small.json; the captures supply what a hand-written fixture
// cannot: the real column defaults and a realistic charge catalog.

const fs = require('fs');
const path = require('path');
const protocol = require('../protocol');
const { Anonymizer, denyHashes, scanFixture } = require('./anonymize');
const { PARENT } = require('./state');

const ROOT = path.join(__dirname, '..');
const CAPTURE = path.join(ROOT, 'captured/favorites-select-res.txt');
const SMALL = path.join(ROOT, 'test/fixtures/small.json');
const OUT_FIXTURE = path.join(__dirname, 'fixture.json');
const OUT_DENY = path.join(__dirname, 'deny.json');

// Columns the mock computes or sets itself; never copied as defaults
const PARENT_OWN = new Set([
  PARENT.NAME,
  PARENT.EMPL_ID,
  PARENT.SCHEDULE_DESC,
  PARENT.END_DT,
  PARENT.STATUS,
  20,
  PARENT.ACTION_CD,
  PARENT.ENABLE_SIGN_FL,
  PARENT.ENABLE_CORRECT_FL,
  PARENT.TS_CLOSED_FL,
]);
const CHILD_OWN = new Set([1, 2, 4, 6, 8, 16, 96, 97, 198, 26, 27, 28, 29, 30, 31, 32, 61, 62, 63, 64, 65, 66, 67]);
// Timestamps and per-row ids vary row to row and are not defaults
const SKIP_PATTERN = /^\d{4}-\d{2}-\d{2}/;

function load(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.startsWith('data:')) text = Buffer.from(text.split(',')[1], 'base64').toString('utf8');
  return protocol.parseResponse(text);
}

function constantColumns(rows, own) {
  const out = {};
  const width = rows[0].length;
  for (let c = 0; c < width; c++) {
    if (own.has(c)) continue;
    const values = new Set(rows.map(r => r[c]));
    const [v] = [...values];
    if (values.size === 1 && v !== '' && !SKIP_PATTERN.test(v)) out[c] = v;
  }
  return out;
}

function main() {
  if (!fs.existsSync(CAPTURE)) throw new Error('Missing ' + CAPTURE + ' (captures are local-only)');
  const small = JSON.parse(fs.readFileSync(SMALL, 'utf8'));
  const res = load(CAPTURE);
  const parent = protocol.extract204(res, 0);
  const child = protocol.extract204(res, 1);
  const catalog = protocol.extract204(res, 2);

  const an = new Anonymizer();
  const first = parent.rows[0];
  an.term(first[PARENT.NAME], small.employee.name);
  for (const part of String(first[PARENT.NAME]).split(/[ ,.]+/)) an.term(part, 'Doe');
  an.term(first[PARENT.EMPL_ID], small.employee.id);
  an.term(child.rows[0][8], '12345');
  an.term(first[14], '01.001.00001');
  an.term(child.rows[0][15], '0001');
  for (const col of [669, 677, 682]) an.term(first[col], col === 669 ? small.employee.id : 'Doe');
  for (const row of catalog.rows) {
    an.term(row[1], 'PROJ');
    an.term(row[5], an.code(row[5]));
  }

  const clean = defaults => Object.fromEntries(Object.entries(defaults).map(([c, v]) => [c, an.text(v)]));
  const fixture = JSON.parse(JSON.stringify(small));
  fixture.cols = { parent: parent.rows[0].length, child: child.rows[0].length, charge: catalog.rows[0].length };
  fixture.employee.zip = '12345';
  fixture.defaults.parent = clean(constantColumns(parent.rows, PARENT_OWN));
  fixture.defaults.child = clean(constantColumns(child.rows, CHILD_OWN));

  // Real catalog entries under synthetic codes, after the ones the seed weeks use
  const seen = new Set(fixture.charges.map(c => c.code));
  for (const row of catalog.rows) {
    const code = an.code(row[5]);
    if (seen.has(code)) continue;
    seen.add(code);
    fixture.charges.push({
      code,
      payType: row[15] || 'REG',
      desc: 'Charge ' + code,
      project: 'PROJ',
      account: 'ZTC-IL-000-0000',
    });
  }
  fixture.employee.zip = '12345';
  fixture.defaults.child[8] = '12345';

  const text = JSON.stringify(fixture, null, 1) + '\n';
  const hashes = denyHashes([...an.realTerms(), first[PARENT.NAME], first[PARENT.EMPL_ID], child.rows[0][8]]);
  const problems = scanFixture(fixture, hashes);
  if (problems.length) throw new Error('Leaked data in the fixture:\n' + problems.join('\n'));
  fs.writeFileSync(OUT_FIXTURE, text);
  fs.writeFileSync(OUT_DENY, JSON.stringify(hashes, null, 1) + '\n');
  console.log('Wrote ' + OUT_FIXTURE + ' (' + text.length + ' bytes) and ' + hashes.length + ' deny hashes');
}

main();
