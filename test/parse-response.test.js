'use strict';

// parseResponse must read the servlet body as data, never run it (tecli-4mz.9)

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../protocol');

describe('parseResponse does not execute the body', () => {
  let realExit;
  let exitCalls;

  beforeEach(() => {
    realExit = process.exit;
    exitCalls = [];
    process.exit = code => exitCalls.push(code);
    delete globalThis.__tecliPwned;
    delete process.env.__TECLI_PWNED;
  });

  afterEach(() => {
    process.exit = realExit;
    delete globalThis.__tecliPwned;
    delete process.env.__TECLI_PWNED;
  });

  const hostile = {
    'a statement after the array': 'var responses=[["x"]];globalThis.__tecliPwned=true;',
    'a call inside the array': 'var responses=[process.exit(3)];',
    'an invoked function blob': 'var responses=[function(g){globalThis.__tecliPwned=true}()];',
    'an env write after the array': 'var responses=[["a"]];process.env.__TECLI_PWNED="1";',
    'a require call': 'var responses=[require("child_process").execSync("true")];',
  };

  for (const [name, body] of Object.entries(hostile)) {
    test('rejects ' + name, () => {
      assert.throws(() => protocol.parseResponse(body), /parseResponse failed/);
      assert.equal(globalThis.__tecliPwned, undefined);
      assert.equal(process.env.__TECLI_PWNED, undefined);
      assert.deepEqual(exitCalls, []);
    });
  }

  test('keeps a function blob as its source text without running it', () => {
    const blob = 'function(g){globalThis.__tecliPwned=true;D.V(g,"maObjId","A\\u000bB");}';
    const parsed = protocol.parseResponse('var responses=[["x"],[' + blob + ']];');
    assert.deepEqual(parsed, [['x'], [blob]]);
    assert.equal(globalThis.__tecliPwned, undefined);
  });
});

describe('parseResponse grammar', () => {
  test('reads strings, numbers, literals and new Array', () => {
    const body =
      'var responses=[["a\\"b",\'c\\\'d\',"\\n\\r\\t\\\\\\x41\\u0042"],-12,3.5,null,true,false,' +
      'new Array(new Array("e",new Array("f",true,-59999))),[]];';
    assert.deepEqual(protocol.parseResponse(body), [
      ['a"b', "c'd", '\n\r\t\\AB'],
      -12,
      3.5,
      null,
      true,
      false,
      [['e', ['f', true, -59999]]],
      [],
    ]);
  });

  test('keeps raw control characters inside strings', () => {
    assert.deepEqual(protocol.parseResponse('var responses=["0\x0B0\x06"];'), ['0\x0B0\x06']);
  });

  test('rejects a body without the responses variable', () => {
    assert.throws(() => protocol.parseResponse("var responseCd='ok';"), /parseResponse failed/);
  });

  test('rejects an unterminated string', () => {
    assert.throws(() => protocol.parseResponse('var responses=["abc];'), /parseResponse failed/);
  });
});

// Reference reading of a body: the old eval semantics, inside a bare vm
// context. Test-only; function values compare by source text.
function referenceParse(text) {
  const vm = require('vm');
  const value = vm.runInNewContext(text + '\nresponses;', Object.create(null), { timeout: 1000 });
  return JSON.parse(JSON.stringify(value, (_, v) => (typeof v === 'function' ? v.toString() : v)));
}

function captureBodies() {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '../captured');
  const bodies = [];
  if (!fs.existsSync(root)) return bodies;
  const walk = dir => {
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (/res.*\.txt$/.test(f)) bodies.push([path.relative(root, full), fs.readFileSync(full, 'utf8')]);
    }
  };
  walk(root);
  return bodies.map(([name, text]) =>
    text.startsWith('data:')
      ? [
          name,
          Buffer.from(text.trim().replace('data:application/octet-stream;base64,', ''), 'base64').toString('binary'),
        ]
      : [name, text]
  );
}

describe('parseResponse matches the eval reading', () => {
  const codec = require('../mock/codec');

  test('on mock codec output', () => {
    const bodies = [
      codec.buildResponse([
        {
          rsKey: 0,
          cmdCd: 204,
          slot: codec.encode204Slot({ rowNums: ['0'], rows: [['x', 'say "hi"', 'l1\nl2', '']] }, 4),
        },
      ]),
      codec.buildResponse([
        {
          rsKey: 1,
          cmdCd: 206,
          rescd: -1,
          error: 'Explanation or Reject Reason is required.',
          columnNames: ['A', 'B"C'],
        },
        { rsKey: -1, cmdCd: 507 },
      ]),
    ];
    for (const text of bodies) assert.deepEqual(protocol.parseResponse(text), referenceParse(text));
  });

  const captured = captureBodies().filter(([, text]) => text.startsWith('var responses='));
  test('on every captured response', { skip: captured.length === 0 && 'captured/ is absent' }, () => {
    for (const [name, text] of captured) {
      assert.deepEqual(protocol.parseResponse(text), referenceParse(text), name);
    }
  });
});
