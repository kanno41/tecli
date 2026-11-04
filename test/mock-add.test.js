'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startMock } = require('./mock-helper');

const line = (data, code) => data.projects.find(p => p.code === code);

describe('mock add', () => {
  let mock;
  beforeEach(async () => {
    mock = await startMock();
  });
  afterEach(() => mock.stop());

  test('adds a single-charge code', async () => {
    const cp = await mock.launch();
    await cp.add('PROJ.C.300');
    await cp.save();
    const added = line((await mock.launch()).getData(), 'PROJ.C.300');
    assert.equal(added.description, 'Gamma Overhead');
    assert.equal(added.payType, 'REG');
  });

  test('a multi-charge code needs a pay type', async () => {
    const cp = await mock.launch();
    await assert.rejects(() => cp.add('PROJ.M.400'), /Multiple charges found/);
  });

  test('adds a multi-charge code with its pay type', async () => {
    const cp = await mock.launch();
    await cp.add('PROJ.M.400', 'RHB');
    await cp.save();
    assert.equal(line((await mock.launch()).getData(), 'PROJ.M.400').payType, 'RHB');
  });

  test('an unknown pay type lists the available ones', async () => {
    const cp = await mock.launch();
    await assert.rejects(() => cp.add('PROJ.M.400', 'XXX'), /Available: REG, RHB/);
  });

  test('an unknown code is rejected', async () => {
    const cp = await mock.launch();
    await assert.rejects(() => cp.add('NOPE.1'), /not valid/);
  });

  test('the server fills the default work location', async () => {
    const cp = await mock.launch();
    await cp.add('PROJ.C.300');
    assert.deepEqual(cp.pendingLine(), { payType: 'REG', workLocation: mock.db.employee.zip });
  });

  test('a work location override is saved', async () => {
    const cp = await mock.launch();
    await cp.add('PROJ.C.300', undefined, { workLocation: '20190' });
    await cp.save();
    const again = await mock.launch();
    assert.equal(again.childData.rows.find(r => r[6] === 'PROJ.C.300')[8], '20190');
  });

  test('an invalid work location is rejected by the server', async () => {
    const cp = await mock.launch();
    await assert.rejects(() => cp.add('PROJ.C.300', undefined, { workLocation: '2019' }), /Work location/);
  });

  test('a work location callback sees the defaults', async () => {
    const cp = await mock.launch();
    let seen;
    await cp.add('PROJ.C.300', undefined, {
      workLocation: async p => {
        seen = p;
        return '20190';
      },
    });
    assert.equal(seen.workLocation, mock.db.employee.zip);
    assert.equal(cp.pendingLine().workLocation, '20190');
  });

  test('two adds in one session save two distinct lines', async () => {
    const cp = await mock.launch();
    await cp.add('PROJ.C.300');
    await cp.save();
    await cp.add('ZLEAVE.CMP', 'REG');
    await cp.save();
    const codes = (await mock.launch()).getData().projects.map(p => p.code);
    assert.deepEqual(codes, ['PROJ.A.100', 'PROJ.B.200', 'PROJ.C.300', 'ZLEAVE.CMP']);
  });

  test('adds to a past week', async () => {
    const cp = await mock.launch();
    await cp.selectPeriod(1);
    await cp.add('PROJ.C.300');
    assert.equal(cp.getData().timesheetStatusCode, 'O');
    await cp.save();
    await mock.launch().then(async other => {
      await other.selectPeriod(1);
      assert.ok(other.getData().projects.some(p => p.code === 'PROJ.C.300'));
    });
  });
});

describe('mock favorites', () => {
  let mock;
  beforeEach(async () => {
    mock = await startMock();
  });
  afterEach(() => mock.stop());

  test('lists the favorites', async () => {
    const cp = await mock.launch();
    assert.deepEqual(await cp.getFavorites(), [
      { code: 'PROJ.A.100', description: 'Alpha Research', payType: 'REG' },
      { code: 'PROJ.B.200', description: 'Beta Support', payType: 'REG' },
    ]);
  });

  test('an empty favorites list comes back empty', async () => {
    mock.db.favorites.length = 0;
    assert.deepEqual(await (await mock.launch()).getFavorites(), []);
  });

  test('favorites asked without the primer return no data', async () => {
    const cp = await mock.launch();
    cp._stagePendingLine();
    await cp._newTimesheetLine();
    await cp._postServlet(cp._buildOpenFavoritesLookup());
    const protocol = require('../protocol');
    const parsed = protocol.parseResponse(await cp._postServlet(cp._buildFavoritesQuery()));
    assert.equal(protocol.extract204(parsed, 2), null);
  });

  test('adds from a favorite', async () => {
    const cp = await mock.launch();
    const fav = await cp.addFromFavorite(1);
    assert.equal(fav.code, 'PROJ.B.200');
    assert.equal(cp.pendingLine().payType, 'REG');
  });

  // H01980.A.N102.210 is stored with no pay type (tecli-a1t.12)
  test('a favorite with no pay type is added without one, unless overridden', async () => {
    mock.db.favorites.push({ code: 'PROJ.C.300', payType: '', desc: 'Gamma Overhead' });
    const cp = await mock.launch();
    const calls = [];
    const add = cp.add.bind(cp);
    cp.add = (...args) => {
      calls.push(args);
      return add(...args);
    };
    await cp.addFromFavorite(2, { workLocation: '20190' });
    assert.deepEqual(calls[0], ['PROJ.C.300', undefined, { workLocation: '20190' }]);
    await cp.save();
    await cp.addFromFavorite(2, { payType: 'REG' });
    assert.deepEqual(calls[1], ['PROJ.C.300', 'REG', { workLocation: undefined }]);
  });

  test('a favorite index out of range is an error', async () => {
    const cp = await mock.launch();
    await assert.rejects(() => cp.addFromFavorite(9), /out of range/);
  });

  test('addToFavorites shows up in the next list, without duplicates', async () => {
    const cp = await mock.launch();
    await cp.add('PROJ.C.300');
    await cp.addToFavorites();
    await cp.save();
    const favs = await (await mock.launch()).getFavorites();
    assert.deepEqual(
      favs.map(f => f.code),
      ['PROJ.A.100', 'PROJ.B.200', 'PROJ.C.300']
    );

    const again = await mock.launch();
    await again.add('PROJ.C.300');
    await again.addToFavorites();
    assert.equal(mock.db.favorites.length, 3);
  });

  test('a save after addToFavorites without row data re-fetches', async () => {
    await mock.stop();
    mock = await startMock({ quirks: 'sign-poison,auto-required,favorites-primer,favsave-no204' });
    const cp = await mock.launch();
    await cp.add('PROJ.C.300');
    await cp.addToFavorites();
    await cp.save();
    assert.ok(cp.childData.rowNums.every(n => parseInt(n, 10) >= 0));
    await cp.add('ZLEAVE.CMP', 'REG');
    await cp.save();
    const codes = (await mock.launch()).getData().projects.map(p => p.code);
    assert.equal(codes.filter(c => c === 'PROJ.C.300').length, 1);
  });
});

describe('mock leave', () => {
  test('getLeaveBalances returns balances and the details of the chosen one', async () => {
    const mock = await startMock();
    try {
      const cp = await mock.launch();
      const { balances, details } = await cp.getLeaveBalances();
      assert.deepEqual(
        balances.map(b => b.code),
        ['FTB', 'COMP', 'PTB']
      );
      assert.equal(balances[1].balance, 120);
      assert.equal(details.length, 2);
      assert.equal(details[0].type, 'Earned');
      assert.equal(details[1].hours, -8);
    } finally {
      await mock.stop();
    }
  });
});
