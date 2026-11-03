'use strict';

// How the web UI holds a save that waits on a revision explanation: which
// week it remembers, what finishes it and what drops it (tecli-od6 step 3).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startMock } = require('./mock-helper');
const { startWeb, pageToken, waitForData } = require('./web-helper');

describe('web UI revision explanation', () => {
  let mock;
  let web;
  let headers;

  const put = (route, body) => fetch(web.base + route, { method: 'PUT', headers, body: JSON.stringify(body) });
  const post = async (route, body) => {
    const res = await fetch(web.base + route, { method: 'POST', headers, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const explain = explanation => post('/api/save-with-explanation', { explanation });
  // Column 26 is the first day of the week, the 5th
  const pastHours = () => mock.db.period(1).lines[0]['26'];
  let original;

  before(async () => {
    mock = await startMock();
    web = await startWeb(mock);
    const token = await pageToken(web);
    headers = { 'Content-Type': 'application/json', 'X-Tecli-Token': token, Origin: web.base };
    await waitForData(web, token);
    original = pastHours();
  });
  after(async () => {
    if (web) await web.stop();
    if (mock) await mock.stop();
  });

  test('nothing held: save-with-explanation is refused', async () => {
    const res = await explain('nothing');
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'No save is waiting on a revision explanation');
    assert.deepEqual(res.body.saved, []);
  });

  test('an empty explanation is refused before the hold is looked at', async () => {
    const res = await explain('  ');
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Revision explanation is required');
  });

  test('a refresh drops the held week', async () => {
    assert.equal((await put('/api/hours', { period: 1, periodLine: 0, day: 5, hours: 4 })).status, 200);
    const save = await post('/api/save');
    assert.equal(save.body.revisionRequired, true);
    assert.equal(save.body.period, 1);

    assert.equal((await fetch(web.base + '/api/refresh', { headers })).status, 200);
    const res = await explain('too late');
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'No save is waiting on a revision explanation');
    assert.equal(pastHours(), original);
  });

  test('a failed save-with-explanation keeps the hold, so a retry finishes it', async () => {
    // The edit from the previous test is still pending on the page side
    const save = await post('/api/save');
    assert.equal(save.body.revisionRequired, true);
    mock.failSave(1, 'Explanation rejected');

    const failed = await explain('first try');
    assert.equal(failed.status, 500);
    assert.match(failed.body.error, /Explanation rejected/);
    assert.deepEqual(failed.body.saved, []);
    assert.equal(failed.body.failed, 1);

    const retry = await explain('second try');
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.deepEqual(retry.body.saved, [1]);
    assert.equal(pastHours(), '4');

    const again = await explain('done already');
    assert.equal(again.body.error, 'No save is waiting on a revision explanation');
  });
});
