'use strict';

// The web favorites Add goes through addFromFavorite like the TUI and MCP:
// the favorites-list row is selected and a blank pay type stays blank
// (tecli-a1t.12).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startMock } = require('./mock-helper');
const { startWeb, pageToken, waitForData } = require('./web-helper');

describe('web UI favorites Add', () => {
  let mock;
  let web;
  let headers;

  const post = (route, body) => fetch(web.base + route, { method: 'POST', headers, body: JSON.stringify(body) });

  before(async () => {
    mock = await startMock();
    // Live trace: the per-code lookup returns a non-favorite row first, with
    // no work location; the favorite has no pay type
    const base = { code: 'H01980.A.N102.210', payType: '', desc: 'Tech Integration', project: 'H01980' };
    mock.db.charges.push(
      { ...base, account: 'ZTC-IL-000-0000', parentBranch: 'H01980', workLocation: '' },
      { ...base, account: 'ZTC-IL-000-0000', parentBranch: '', workLocation: '62226', favorite: true }
    );
    mock.db.favorites.push({ code: base.code, payType: '', desc: base.desc });
    web = await startWeb(mock);
    const token = await pageToken(web);
    headers = { 'Content-Type': 'application/json', 'X-Tecli-Token': token, Origin: web.base };
    await waitForData(web, token);
  });
  after(async () => {
    if (web) await web.stop();
    if (mock) await mock.stop();
  });

  test('a favorite with no pay type is added from its own lookup row', async () => {
    const favs = await (await fetch(web.base + '/api/favorites?period=0', { headers })).json();
    const favoriteIndex = favs.findIndex(f => f.code === 'H01980.A.N102.210');
    assert.equal(favs[favoriteIndex].payType, '');

    const res = await post('/api/project', { favoriteIndex, period: 0 });
    const body = await res.json();
    assert.equal(res.status, 200, body.error);
    assert.equal(body.success, true);

    const cp = await mock.launch();
    const row = cp.childData.rows.find(r => r[6] === 'H01980.A.N102.210');
    assert.ok(row, 'line saved');
    assert.equal(row[8], '62226');
  });

  test('a favorite index out of range is a 500 naming the range', async () => {
    const res = await post('/api/project', { favoriteIndex: 99, period: 0 });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /out of range/);
  });

  for (const favoriteIndex of [-1, 1.5, 'x']) {
    test(`favoriteIndex ${JSON.stringify(favoriteIndex)} is a 400`, async () => {
      const res = await post('/api/project', { favoriteIndex, period: 0 });
      assert.equal(res.status, 400);
    });
  }
});
