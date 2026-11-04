'use strict';

// Costpoint data and server error text must reach the page as text, never as
// markup (tecli-4mz.5). Seeds the mock with a script payload and checks the
// server-rendered page and the client HTML builders in public/render.js.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startMock } = require('./mock-helper');
const { startWeb, pageToken, waitForData } = require('./web-helper');
const render = require('../public/render');

const XSS = '<img src=x onerror=alert(1)>';
const ESCAPED = '&lt;img src=x onerror=alert(1)&gt;';
const TAG = /<img src=x/i;

function seededFixture() {
  const fixture = JSON.parse(JSON.stringify(require('../mock/fixture.json')));
  fixture.periods[0].lines[0]['2'] = 'Alpha ' + XSS;
  return fixture;
}

describe('web UI escapes Costpoint data', () => {
  let mock;
  let web;
  let html;

  before(async () => {
    mock = await startMock({ fixture: seededFixture() });
    web = await startWeb(mock);
    await waitForData(web, await pageToken(web));
    html = await (await fetch(web.base + '/')).text();
  });
  after(async () => {
    if (web) await web.stop();
    if (mock) await mock.stop();
  });

  test('renderHTML() shows the project description as text', () => {
    assert.ok(html.includes('Alpha ' + ESCAPED), 'escaped description missing');
    assert.doesNotMatch(html, TAG);
  });

  test('the inline data script cannot be closed by Costpoint text', () => {
    const script = html.match(/window\.TIMESHEET_DATA = (.*);\n/);
    assert.ok(script, 'TIMESHEET_DATA missing');
    assert.doesNotMatch(script[1], /</);
    assert.equal(JSON.parse(script[1]).projects[0].description, 'Alpha ' + XSS);
  });
});

describe('client HTML builders escape their input', () => {
  test('a save or load error is text', () => {
    const out = render.errorHTML('Save error: ' + XSS);
    assert.equal(out, '<p class="error">Save error: ' + ESCAPED + '</p>');
  });

  test('revision audit details are text', () => {
    const out = render.auditTableHTML([
      { lineNo: XSS, date: XSS, project: XSS, chargeDescription: XSS, description: XSS },
    ]);
    assert.doesNotMatch(out, TAG);
    assert.equal(out.split(ESCAPED).length - 1, 5);
  });

  test('favorites are text, including the data attributes', () => {
    const out = render.favoritesTableHTML([{ code: 'A"' + XSS, payType: XSS, description: XSS }]);
    assert.doesNotMatch(out, TAG);
    assert.ok(out.includes('data-code="A&quot;' + ESCAPED + '"'));
  });

  test('leave balances and activity are text', () => {
    const out = render.leaveHTML({
      balances: [{ description: XSS, balance: 1 }],
      details: [{ date: XSS, type: XSS, hours: 1, leaveTypeDesc: XSS }],
    });
    assert.doesNotMatch(out, TAG);
    assert.equal(out.split(ESCAPED).length - 1, 4);
  });

  test('an ampersand in error text is escaped once', () => {
    assert.equal(render.escapeHtml('a & b'), 'a &amp; b');
    assert.equal(render.errorHTML('a & b'), '<p class="error">a &amp; b</p>');
  });
});
