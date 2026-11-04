'use strict';

// Drives the web UI in Chromium against server.js and the mock (tecli-a1t.3).
// The page talks to server.js the way a browser does: same Host and Origin,
// and the per-launch token that app.js reads from the page. Run with
// `npm run test:e2e`; plain `npm test` does not pick up *.spec.js.

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startMock } = require('../mock-helper');
const { startWeb, pageToken, waitForData } = require('../web-helper');
const { CHILD } = require('../../mock/state');

// mock-helper fixes today at Thursday 2026-10-15: period 0 is Oct 12-18 (Open),
// period 1 Oct 5-11 (Processed, correctable), period 2 Sep 28 - Oct 4 (Signed)
const SAT = CHILD.DAYS[5];

const TIMEOUT_MS = 15000;

async function until(check, what) {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + what);
    await new Promise(r => setTimeout(r, 50));
  }
}

describe('web UI in a browser', () => {
  let browser;
  let mock;
  let web;
  let page;
  let dialogs; // answers for the confirm() dialogs a test expects, in order
  let seenDialogs;

  const hoursIn = (period, code, col) => {
    const line = mock.db.period(period).lines.find(l => l[CHILD.CODE] === code);
    return line && line[col] !== undefined && line[col] !== '' ? Number(line[col]) : null;
  };
  const cell = (period, day) =>
    page.locator(`tr[data-line="0"] .hours-input[data-week="${period}"][data-day="${day}"]`);
  const weekLabels = () => page.locator('.week-header .week-dates').allTextContents();
  // On the current window the older week (period 1) is the left header
  const weekHeader = period => page.locator('.week-header').nth(period === 0 ? 1 : 0);
  const reloaded = () => page.waitForEvent('load', { timeout: TIMEOUT_MS });

  before(async () => {
    browser = await chromium.launch();
  });
  after(async () => {
    if (browser) await browser.close();
  });

  beforeEach(async () => {
    mock = await startMock();
    web = await startWeb(mock);
    await waitForData(web, await pageToken(web));
    page = await browser.newPage();
    dialogs = [];
    seenDialogs = [];
    page.on('dialog', dialog => {
      seenDialogs.push(dialog.message());
      const accept = dialogs.shift();
      return accept ? dialog.accept() : dialog.dismiss();
    });
    page.setDefaultTimeout(TIMEOUT_MS);
    await page.goto(web.base + '/');
    await page.locator('#timesheet').waitFor();
  });
  afterEach(async () => {
    if (page) await page.close();
    if (web) await web.stop();
    if (mock) await mock.stop();
  });

  test('the page drives the API through the web guard', async () => {
    const forged = await page.evaluate(async () => (await fetch('/api/status')).status);
    assert.equal(forged, 403, 'an /api request without the page token is refused');
    const own = await page.evaluate(async () => {
      const token = document.querySelector('meta[name="tecli-token"]').content;
      return (await fetch('/api/status', { headers: { 'X-Tecli-Token': token } })).status;
    });
    assert.equal(own, 200);
  });

  test('older, newer and Current slide the two-week window', async () => {
    assert.deepEqual(await weekLabels(), ['Oct 5–11', 'Oct 12–18']);
    assert.equal(await page.locator('#nav-newer').count(), 0, 'newer is disabled on the current window');

    await page.click('#nav-older');
    await page.waitForURL(/\?offset=1$/);
    assert.deepEqual(await weekLabels(), ['Sep 28 – Oct 4', 'Oct 5–11']);
    assert.match(await page.locator('.week-header').first().textContent(), /Signed/);

    await page.click('#nav-older');
    await page.waitForURL(/\?offset=2$/);
    assert.deepEqual(await weekLabels(), ['Sep 21–27', 'Sep 28 – Oct 4']);

    await page.click('#nav-newer');
    await page.waitForURL(/\?offset=1$/);
    assert.deepEqual(await weekLabels(), ['Sep 28 – Oct 4', 'Oct 5–11']);

    await page.click('#nav-current');
    await page.waitForURL(web.base + '/');
    assert.deepEqual(await weekLabels(), ['Oct 5–11', 'Oct 12–18']);
    assert.deepEqual(seenDialogs, []);
  });

  test('changing weeks with unsaved edits asks first', async () => {
    await cell(0, 17).fill('4');

    dialogs.push(false);
    await page.click('#nav-older');
    assert.match(seenDialogs[0], /unsaved changes/);
    assert.equal(page.url(), web.base + '/', 'a dismissed confirm keeps the week');
    assert.equal(await cell(0, 17).inputValue(), '4');

    dialogs.push(true);
    await page.click('#nav-older');
    await page.waitForURL(/\?offset=1$/);
    assert.equal(seenDialogs.length, 2);
  });

  test('edits in both weeks save newest first, then the revision modal finishes the older week', async () => {
    await cell(0, 17).fill('4');
    await cell(1, 10).fill('2');
    assert.ok(await page.locator('#save-btn').isEnabled());

    await page.click('#save-btn');

    // The active week committed; the corrected older week wants an explanation
    const modal = page.locator('#revision-modal');
    await modal.waitFor();
    assert.equal(hoursIn(0, 'PROJ.A.100', SAT), 4);
    assert.equal(hoursIn(1, 'PROJ.A.100', SAT), null);
    assert.match(await modal.locator('.audit-table').textContent(), /2026-10-10/);
    assert.doesNotMatch(await modal.locator('.audit-table').textContent(), /2026-10-17/);
    assert.equal(
      await cell(0, 17)
        .getAttribute('class')
        .then(c => /\bmodified\b/.test(c)),
      false
    );

    // An empty explanation is refused on the page
    await page.click('#revision-submit');
    assert.equal(await modal.count(), 1);

    await page.fill('#revision-explanation', 'forgot Saturday');
    await page.click('#revision-submit');
    await modal.waitFor({ state: 'detached' });

    assert.equal(hoursIn(1, 'PROJ.A.100', SAT), 2);
    assert.ok(mock.db.period(1).revisions.some(r => r.explanation === 'forgot Saturday'));
    assert.match(await page.locator('#error-message').textContent(), /saved with revision explanation/);
    assert.ok(await page.locator('#save-btn').isDisabled());
    assert.equal(await page.locator('.hours-input.modified').count(), 0);
  });

  test('a partial save failure clears only the saved week (tecli-4mz.6)', async () => {
    await cell(0, 17).fill('4');
    await cell(1, 10).fill('2');
    mock.failSave(1, 'Older week rejected');

    await page.click('#save-btn');
    await until(async () => /Older week rejected/.test(await page.locator('#error-message').textContent()), 'error');

    assert.equal(hoursIn(0, 'PROJ.A.100', SAT), 4);
    assert.equal(hoursIn(1, 'PROJ.A.100', SAT), null);
    assert.doesNotMatch(await cell(0, 17).getAttribute('class'), /\bmodified\b/);
    assert.match(await cell(1, 10).getAttribute('class'), /\bmodified\b/);
    assert.ok(await page.locator('#save-btn').isEnabled(), 'the failed week can be retried');

    // The retry resends only the older week, which then asks for its explanation
    await page.click('#save-btn');
    const modal = page.locator('#revision-modal');
    await modal.waitFor();
    assert.deepEqual(await modal.locator('.audit-table tbody tr td:nth-child(2)').allTextContents(), ['2026-10-10']);
    await page.fill('#revision-explanation', 'retry');
    await page.click('#revision-submit');
    await modal.waitFor({ state: 'detached' });
    assert.equal(hoursIn(1, 'PROJ.A.100', SAT), 2);
    assert.equal(await page.locator('.hours-input.modified').count(), 0);
  });

  test('Sign on the active week signs it after the confirmation', async () => {
    const sign = page.locator('.week-header .btn-week-sign[data-week="0"]');
    assert.equal(await page.locator('.week-header .btn-week-sign[data-week="1"]').count(), 0);

    await sign.click();
    assert.match(await page.locator('#sign-modal-text').textContent(), /Sign Oct 12–18\?/);
    // Cancel sends nothing
    await page.click('#sign-modal .modal-cancel');
    assert.equal(mock.db.period(0).status, 'O');

    await sign.click();
    const load = reloaded();
    await page.click('#confirm-sign');
    await until(() => mock.db.period(0).status === 'S', 'period 0 signed');
    await load;
    assert.match(await weekHeader(0).textContent(), /Signed/);
    assert.equal(await page.locator('.btn-week-sign[data-week="0"]').count(), 0);
    assert.equal(mock.db.period(1).status, 'P', 'only the chosen week is signed');
    // The web UI confirms in its own modal; no browser dialog is involved
    assert.deepEqual(seenDialogs, []);
  });

  test('a corrected past week shows its own Sign and signs that week', async () => {
    await cell(1, 10).fill('2');
    await page.click('#save-btn');
    await page.locator('#revision-modal').waitFor();
    await page.fill('#revision-explanation', 'correction');
    await page.click('#revision-submit');
    await page.locator('#revision-modal').waitFor({ state: 'detached' });
    assert.equal(mock.db.period(1).status, 'O');

    await page.reload();
    assert.match(await page.locator('.past-sign-nudge').textContent(), /Previous week is Open/);
    await page.click('.week-header .btn-week-sign[data-week="1"]');
    assert.match(await page.locator('#sign-modal-text').textContent(), /Sign Oct 5–11\?/);
    const load = reloaded();
    await page.click('#confirm-sign');
    await until(() => mock.db.period(1).status === 'S', 'period 1 signed');
    await load;
    assert.equal(mock.db.period(0).status, 'O', 'the active week stays unsigned');
    assert.equal(await page.locator('.past-sign-nudge').count(), 0);
    assert.match(await weekHeader(1).textContent(), /Signed/);
  });

  test('Add Project sends the work location and the favorites checkbox', async () => {
    assert.ok(!mock.db.favorites.some(f => f.code === 'PROJ.C.300'));
    await page.click('#add-project-btn');
    await page.selectOption('#add-target-period', '0');
    await page.fill('#project-code', 'PROJ.C.300');
    await page.fill('#project-work-location', '20190');
    await page.check('#project-favorite');
    const load = reloaded();
    await page.click('#confirm-add-project');

    const line = await until(() => mock.db.period(0).lines.find(l => l[CHILD.CODE] === 'PROJ.C.300'), 'the added line');
    assert.equal(line[CHILD.WORK_LOCATION], '20190');
    assert.ok(mock.db.favorites.some(f => f.code === 'PROJ.C.300' && f.payType === 'REG'));
    await load;
    assert.equal(await page.locator('td.col-code', { hasText: 'PROJ.C.300' }).count(), 1);
  });

  // A favorite with no pay type, whose per-code lookup returns a non-favorite
  // row first (tecli-a1t.12)
  test('Favorites Add picks the favorite row and keeps its blank pay type', async () => {
    const base = { code: 'H01980.A.N102.210', payType: '', desc: 'Tech Integration', project: 'H01980' };
    mock.db.charges.push(
      { ...base, account: 'ZTC-IL-000-0000', parentBranch: 'H01980', workLocation: '' },
      { ...base, account: 'ZTC-IL-000-0000', parentBranch: '', workLocation: '62226', favorite: true }
    );
    mock.db.favorites.push({ code: base.code, payType: '', desc: base.desc });
    await page.click('#favorites-btn');
    const row = page.locator('#favorites-modal-body tr', { hasText: base.code });
    const load = reloaded();
    await row.locator('.fav-add-btn').click();

    const line = await until(() => mock.db.period(0).lines.find(l => l[CHILD.CODE] === base.code), 'the added line');
    assert.equal(line[CHILD.WORK_LOCATION], '62226');
    await load;
  });

  test('Add Project without the checkbox or a location keeps the defaults', async () => {
    await page.click('#add-project-btn');
    await page.fill('#project-code', 'PROJ.C.300');
    const load = reloaded();
    await page.click('#confirm-add-project');
    const line = await until(() => mock.db.period(0).lines.find(l => l[CHILD.CODE] === 'PROJ.C.300'), 'the added line');
    assert.equal(line[CHILD.WORK_LOCATION] || mock.db.defaults.child[CHILD.WORK_LOCATION], mock.db.employee.zip);
    assert.ok(!mock.db.favorites.some(f => f.code === 'PROJ.C.300'));
    await load;
  });

  test('Add Project rejects a bad work location without adding the line', async () => {
    await page.click('#add-project-btn');
    await page.fill('#project-code', 'PROJ.C.300');
    await page.fill('#project-work-location', '2019');
    await page.click('#confirm-add-project');
    await until(async () => /location/i.test(await page.locator('#error-message').textContent()), 'error');
    assert.ok(!mock.db.period(0).lines.some(l => l[CHILD.CODE] === 'PROJ.C.300'));
  });
});
