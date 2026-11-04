#!/usr/bin/env node
'use strict';

// The Puppeteer client reports save and sign failures by throwing, like
// DirectClient, so the web UI, TUI and MCP stay alive and show the error.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const codec = require('../mock/codec');
const Costpoint = require('../costpoint');
const { RevisionRequiredError } = require('../direct');

const EXPLANATION = 'Explanation or Reject Reason is required.';
const OK = codec.buildResponse([
  { rsKey: 0, cmdCd: 206, rescd: 1 },
  { rsKey: -1, cmdCd: 507 },
]);

// A page whose MasterServlet POSTs answer with `responses` in order and
// whose status field reads `status()`.
function stubPage({ responses = [], status = () => 'O', signButton = true } = {}) {
  const events = [];
  const page = {
    events,
    keyboard: { press: async key => events.push('press ' + key) },
    waitForFunction: async () => {
      if (!signButton) throw new Error('Waiting failed: 10000ms exceeded');
    },
    waitForResponse: async predicate => {
      const body = responses.shift();
      const response = {
        url: () => 'https://cp.example/cpweb/MasterServlet.cps',
        request: () => ({ method: () => 'POST' }),
        text: async () => body,
      };
      assert.ok(predicate(response), 'waits for a MasterServlet POST');
      events.push('response');
      return response;
    },
    evaluate: async () => status(),
    locator: selector => ({
      click: async () => {
        events.push('click ' + selector);
        if (selector === '#SIGN_BUT' && page.dialogHandler) {
          await page.dialogHandler({ accept: async () => events.push('accept') });
        }
      },
      fill: async value => events.push('fill ' + selector + ' ' + value),
    }),
    once: (name, handler) => {
      if (name === 'dialog') page.dialogHandler = handler;
    },
    waitForNetworkIdle: async () => {},
  };
  return page;
}

function client(page) {
  const cp = new Costpoint();
  cp.page = page;
  return cp;
}

test('save() resolves when the 206 succeeds', async () => {
  const cp = client(stubPage({ responses: [OK] }));
  await cp.save();
  assert.equal(cp.timesheetStatusCode, 'O');
});

test('save() rejects with the server message when the 206 fails', async () => {
  const resp = codec.buildResponse([
    { rsKey: 0, cmdCd: 206, rescd: -1, error: 'Timesheet is read only' },
    { rsKey: -1, cmdCd: 507 },
  ]);
  const cp = client(stubPage({ responses: [resp] }));
  await assert.rejects(
    () => cp.save(),
    err => !(err instanceof RevisionRequiredError) && /Timesheet is read only/.test(err.message)
  );
});

test('save() rejects on a servlet exception', async () => {
  const cp = client(stubPage({ responses: ['onServletException("boom")'] }));
  await assert.rejects(() => cp.save(), /Server error/);
});

test('save() raises RevisionRequiredError for the explanation prompt', async () => {
  const resp = codec.buildResponse([
    { rsKey: 0, cmdCd: 206, rescd: -1, error: EXPLANATION },
    { rsKey: -1, cmdCd: 507 },
  ]);
  const cp = client(stubPage({ responses: [resp] }));
  await assert.rejects(() => cp.save(), RevisionRequiredError);
});

test('saveWithExplanation() fills the prompt, continues and checks the response', async () => {
  const page = stubPage({ responses: [OK] });
  await client(page).saveWithExplanation('fixed a typo');
  const fill = page.events.indexOf('fill #EXPLANATION_TEXT fixed a typo');
  assert.ok(fill >= 0, 'explanation filled');
  assert.ok(page.events.indexOf('click #OK_BUT___T') > fill, 'Continue clicked after filling');
  assert.ok(page.events.includes('response'), 'save response read');
});

test('saveWithExplanation() rejects when the save still fails', async () => {
  const resp = codec.buildResponse([
    { rsKey: 0, cmdCd: 206, rescd: -1, error: 'Hours exceed limit' },
    { rsKey: -1, cmdCd: 507 },
  ]);
  const cp = client(stubPage({ responses: [resp] }));
  await assert.rejects(() => cp.saveWithExplanation('why'), /Hours exceed limit/);
});

test('sign() throws instead of exiting when the Sign button never shows', async () => {
  const exit = process.exit;
  process.exit = () => assert.fail('sign() must not call process.exit');
  try {
    const cp = client(stubPage({ signButton: false }));
    await assert.rejects(() => cp.sign(), /already signed/);
  } finally {
    process.exit = exit;
  }
});

test('sign() accepts the certification dialog and resolves once the week is Signed', async () => {
  let signed = false;
  const page = stubPage({ status: () => (signed ? 'S' : 'O') });
  const accept = page.locator;
  page.locator = selector => {
    const l = accept(selector);
    const click = l.click;
    l.click = async () => {
      await click();
      if (selector === '#SIGN_BUT') signed = true;
    };
    return l;
  };
  const cp = client(page);
  await cp.sign();
  assert.ok(page.events.includes('accept'), 'dialog accepted');
  assert.equal(cp.timesheetStatusCode, 'S');
});

test('sign() rejects when the week is not Signed afterwards', async () => {
  const cp = client(stubPage({ status: () => 'O' }));
  await assert.rejects(() => cp.sign(), /not signed/i);
});

test('set() types every key of the hours in order before tabbing on', async () => {
  const page = stubPage({ responses: [OK] });
  page.waitForSelector = async () => {};
  page.click = async () => {};
  const cp = client(page);
  const moment = require('moment');
  cp.dates = [0, 1, 2].map(i => moment('2026-10-18').add(i, 'days'));
  cp.table = [[0, 'Line', '', '', '']];
  await cp.set(0, 19, 7.5);
  const typed = page.events.filter(e => /^press (\d|Period)$/.test(e));
  assert.deepEqual(typed, ['press 7', 'press Period', 'press 5']);
  const afterTyping = page.events.slice(page.events.indexOf('press 5') + 1);
  assert.ok(afterTyping.includes('press Tab'), 'tabs out after the hours are typed');
});

// Features with no browser flow throw a typed error instead of a TypeError,
// so every caller can show one clear message.

const { NotSupportedError } = Costpoint;
const { isSessionError, listFavorites } = require('../session');
const notSupported = err => err instanceof NotSupportedError && /COSTPOINT_DIRECT=true/.test(err.message);

function loadedClient(page = stubPage()) {
  const moment = require('moment');
  const cp = client(page);
  cp.dates = [0, 1, 2, 3, 4, 5, 6].map(i => moment('2026-10-18').add(i, 'days'));
  cp.table = [[0, 'Line', '', '', '', '', '', '', '']];
  cp.timesheetStatusCode = 'O';
  return cp;
}

test('getPeriods() lists only the loaded week', () => {
  assert.deepEqual(loadedClient().getPeriods(), [{ idx: 0, endDate: '2026-10-24', statusCode: 'O', editable: null }]);
});

test('getPreviousPeriodData() has no previous week to return', () => {
  assert.equal(loadedClient().getPreviousPeriodData(), null);
});

test('selectPeriod() stays on the active week and refuses a past one', async () => {
  const cp = loadedClient();
  await cp.selectPeriod(0);
  await assert.rejects(() => cp.selectPeriod(1), notSupported);
});

for (const method of ['getFavorites', 'addToFavorites', 'getLeaveBalances']) {
  test(`${method}() rejects as not supported in Puppeteer mode`, async () => {
    await assert.rejects(() => loadedClient()[method](), notSupported);
  });
}

test('the not-supported error is not mistaken for a session error', () => {
  assert.equal(isSessionError(new NotSupportedError('Favorites')), false);
});

test('add() refuses a pay type or work location it cannot apply, before touching the page', async () => {
  for (const [payType, opts] of [
    ['RHB', {}],
    [undefined, { workLocation: '20001' }],
    ['REG', { workLocation: async () => '20001' }],
  ]) {
    const page = stubPage();
    await assert.rejects(() => loadedClient(page).add('ABC.123', payType, opts), notSupported);
    assert.deepEqual(page.events, [], 'no keys pressed');
  }
});

test('set() and setm() refuse a comment before typing anything', async () => {
  const page = stubPage();
  const cp = loadedClient(page);
  await assert.rejects(() => cp.set(0, 18, 8, 'note'), notSupported);
  await assert.rejects(
    () =>
      cp.setm([
        { line: 0, day: 18, hours: 8 },
        { line: 0, day: 19, hours: 8, comment: 'note' },
      ]),
    notSupported
  );
  assert.deepEqual(page.events, [], 'no keys pressed');
});

test('listFavorites() refuses Puppeteer mode without launching a browser', async () => {
  const launch = Costpoint.launch;
  Costpoint.launch = async () => assert.fail('must not launch');
  try {
    await assert.rejects(() => listFavorites({ useDirect: false }), notSupported);
  } finally {
    Costpoint.launch = launch;
  }
});
