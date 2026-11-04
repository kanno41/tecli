'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const DirectClient = require('../direct');
const { buildServer, MARKER } = require('../mcp-server');
const { startMock } = require('./mock-helper');

// The opt-in quirks reproduce live responses the default mock does not
const QUIRK_RUNS = [
  { name: 'default quirks' },
  { name: 'correct-stale', quirks: 'sign-poison,auto-required,favorites-primer,correct-stale' },
  { name: 'favsave-no204', quirks: 'sign-poison,auto-required,favorites-primer,favsave-no204' },
];

for (const run of QUIRK_RUNS)
  describe(`mcp server against the mock (${run.name})`, () => {
    let mock;
    let built;
    let client;

    async function connect(options = {}) {
      built = buildServer({ creds: { url: mock.url, username: 'mock', password: 'mock' }, ...options });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      client = new Client({ name: 'test', version: '1.0.0' });
      await Promise.all([built.server.connect(serverSide), client.connect(clientSide)]);
    }

    // Clients that drop isError (code-mode-mcp) see only the first text block,
    // so every result must be a single text block and every error must carry a marker.
    async function call(name, args = {}) {
      const res = await client.callTool({ name, arguments: args });
      assert.equal(res.content.length, 1);
      assert.equal(res.content[0].type, 'text');
      assert.equal(res.structuredContent, undefined);
      const text = res.content[0].text;
      const isError = Boolean(res.isError);
      if (isError) assert.ok(text.startsWith(MARKER.error) || text.startsWith(MARKER.revision), text);
      else assert.ok(!text.startsWith(MARKER.error) && !text.startsWith(MARKER.revision), text);
      return { text, isError };
    }

    const status = async back =>
      (
        await mock.launch().then(async cp => {
          if (back) await cp.selectPeriod(back);
          return cp.getData();
        })
      ).timesheetStatusCode;

    beforeEach(async () => {
      mock = await startMock({ quirks: run.quirks });
      await connect();
    });

    afterEach(async () => {
      await built.shutdown();
      await client.close();
      await mock.stop();
    });

    test('lists every tool', async () => {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map(t => t.name).sort(), [
        'add_from_favorites',
        'add_project',
        'get_leave_balances',
        'list_favorites',
        'list_weeks',
        'save_with_explanation',
        'set_hours',
        'set_hours_bulk',
        'show_timesheet',
        'sign_timesheet',
      ]);
    });

    test('the server instructions and edit tool descriptions name the markers', async () => {
      const instructions = client.getInstructions();
      for (const m of Object.values(MARKER)) assert.ok(instructions.includes(m), m);
      assert.match(instructions, /no TypeScript annotations/);
      const { tools } = await client.listTools();
      const setHours = tools.find(t => t.name === 'set_hours');
      assert.ok(setHours.description.includes(MARKER.revision));
      assert.ok(setHours.description.includes(MARKER.error));
    });

    // code-mode-mcp shows tool descriptions but never the server instructions
    test('every tool description carries the code-mode calling rule', async () => {
      const { tools } = await client.listTools();
      for (const t of tools) assert.match(t.description, /Code-mode: .*result string.*console\.log/, t.name);
    });

    test('list_weeks shows back numbers, end dates and status', async () => {
      const { text } = await call('list_weeks');
      const lines = text.split('\n');
      assert.equal(lines.length, 20);
      assert.match(lines[0], /back=0 \| week ending 2026-10-18 \| Open \| editable: yes/);
      assert.match(lines[1], /back=1 \| week ending 2026-10-11 \| Processed/);
      assert.match(lines[2], /back=2 .* Signed/);
    });

    test('show_timesheet defaults to the current week and routes by back', async () => {
      const current = await call('show_timesheet');
      assert.match(current.text, /^Current week \(2026-10-12 to 2026-10-18, back=0\)/);
      const past = await call('show_timesheet', { back: 1 });
      assert.match(past.text, /^Previous week \(2026-10-05 to 2026-10-11, back=1\)/);
      assert.match(past.text, /Status: Processed/);
      assert.match(current.text, /\nSigned: no \| Week total: 41\.5h\n/);
      assert.match((await call('show_timesheet', { back: 2 })).text, /\nSigned: yes \| Week total: 39\.5h\n/);
      const far = await call('show_timesheet', { back: 3 });
      assert.match(far.text, /^3 weeks back/i);
    });

    test('an out of range back is an error with the CLI message', async () => {
      const res = await call('show_timesheet', { back: 25 });
      assert.equal(res.isError, true);
      assert.equal(res.text, `${MARKER.error} Cannot go back 25 weeks. Costpoint offers 19 past weeks.`);
    });

    test('a negative back is rejected by the schema', async () => {
      const res = await call('show_timesheet', { back: -1 });
      assert.equal(res.isError, true);
      assert.match(res.text, /^ERROR: .*Input validation error/);
    });

    test('set_hours saves and a new session sees it', async () => {
      const res = await call('set_hours', { line: 0, day: 15, hours: 6, comment: 'short day' });
      assert.equal(res.isError, false);
      assert.match(res.text, /Set line 0, day 15 to 6h. Saved./);
      const cp = await mock.launch();
      assert.equal(cp.getData().projects[0].hours[15], 6);
    });

    for (const hours of [-1, 25, 1e9]) {
      test(`set_hours with ${hours} hours is rejected by the schema and saves nothing`, async () => {
        const before = (await mock.launch()).getData().projects[0].hours[15];
        const res = await call('set_hours', { line: 0, day: 15, hours });
        assert.equal(res.isError, true);
        assert.match(res.text, /^ERROR: .*Input validation error/);
        assert.equal((await mock.launch()).getData().projects[0].hours[15], before);
      });
    }

    // tecli-dw7: live Costpoint answered a committed save with an HTML page
    test('set_hours whose committed save gets an HTML reply reports the save', async () => {
      mock.htmlSave();
      const res = await call('set_hours', { line: 0, day: 15, hours: 6 });
      assert.equal(res.isError, false, res.text);
      assert.match(res.text, /Set line 0, day 15 to 6h. Saved/);
      assert.equal((await mock.launch()).getData().projects[0].hours[15], 6);
    });

    test('set_hours whose lost save gets an HTML reply says the outcome is unknown and sends it once', async () => {
      const before = (await mock.launch()).getData().projects[0].hours[15];
      mock.htmlSave(1, { commit: false });
      const res = await call('set_hours', { line: 0, day: 15, hours: 6 });
      assert.equal(res.isError, true);
      assert.match(res.text, /^ERROR: Save outcome unknown/);
      assert.match(res.text, /before retrying/);
      // A resent save would have committed: the mock answers only one with HTML
      assert.equal((await mock.launch()).getData().projects[0].hours[15], before);
    });

    test('set_hours_bulk with out of range hours saves nothing', async () => {
      const before = (await mock.launch()).getData().projects[0].hours[15];
      const res = await call('set_hours_bulk', {
        changes: [
          { line: 0, day: 15, hours: 5 },
          { line: 1, day: 16, hours: 30 },
        ],
      });
      assert.equal(res.isError, true);
      assert.match(res.text, /^ERROR: .*Input validation error/);
      assert.equal((await mock.launch()).getData().projects[0].hours[15], before);
    });

    test('set_hours_bulk saves every change', async () => {
      await call('set_hours_bulk', {
        changes: [
          { line: 0, day: 15, hours: 5 },
          { line: 1, day: 16, hours: 2 },
        ],
      });
      const data = (await mock.launch()).getData();
      assert.equal(data.projects[0].hours[15], 5);
      assert.equal(data.projects[1].hours[16], 2);
    });

    test('sign_timesheet signs on a fresh session and show_timesheet then says Signed', async () => {
      const res = await call('sign_timesheet');
      assert.equal(res.isError, false);
      assert.match(res.text, /Timesheet signed/);
      assert.match((await call('show_timesheet')).text, /Status: Signed/);
      assert.equal(await status(0), 'S');
    });

    test('sign_timesheet still works after an edit, because it uses a fresh session', async () => {
      await call('set_hours', { line: 0, day: 15, hours: 7 });
      assert.match((await call('show_timesheet')).text, /Status: Open/);
      const res = await call('sign_timesheet');
      assert.equal(res.isError, false, res.text);
      assert.equal(await status(0), 'S');
    });

    test('sign_timesheet on a signed week reports the refusal', async () => {
      const res = await call('sign_timesheet', { back: 2 });
      assert.equal(res.isError, true);
      assert.match(res.text, /does not allow signing/);
    });

    test('editing a processed week asks for an explanation, then save_with_explanation finishes it', async () => {
      const edit = await call('set_hours', { line: 0, day: 5, hours: 4, back: 1 });
      assert.equal(edit.isError, true);
      assert.ok(
        edit.text.startsWith(`${MARKER.revision} Hours set but save requires a revision explanation.`),
        edit.text
      );
      assert.match(edit.text, /Line .*Hours changed/);
      const saved = await call('save_with_explanation', { explanation: 'wrong hours' });
      assert.equal(saved.isError, false, saved.text);
      assert.match(saved.text, /^Saved with explanation/);
      assert.match(saved.text, /Week is Open again. Call sign_timesheet with back=1./);
      assert.equal(await status(1), 'O');

      const signed = await call('sign_timesheet', { back: 1 });
      assert.equal(signed.isError, false, signed.text);
      assert.equal(await status(1), 'S');
    });

    test('set_hours_bulk with back edits the past week only', async () => {
      const before = (await mock.launch()).getData().projects[0].hours[15];
      const edit = await call('set_hours_bulk', {
        changes: [
          { line: 0, day: 5, hours: 4 },
          { line: 1, day: 7, hours: 2 },
        ],
        back: 1,
      });
      assert.ok(edit.text.startsWith(`${MARKER.revision} 2 cells updated but save requires`), edit.text);
      const saved = await call('save_with_explanation', { explanation: 'two fixes' });
      assert.equal(saved.isError, false, saved.text);
      assert.match(saved.text, /^Saved with explanation.\n\nPrevious week \(2026-10-05 to 2026-10-11, back=1\)/);
      assert.match(saved.text, /Call sign_timesheet with back=1./);
      const cp = await mock.launch();
      await cp.selectPeriod(1);
      const past = cp.getData().projects;
      assert.equal(past[0].hours[5], 4);
      assert.equal(past[1].hours[7], 2);
      assert.equal((await mock.launch()).getData().projects[0].hours[15], before);
    });

    test('a revision whose audit details fail to load still asks for an explanation', async t => {
      // Only the K3 audit query fails; the K2 revision row is already read
      t.mock.method(DirectClient.prototype, '_buildQueryAudit', () => {
        throw new Error('audit fetch failed');
      });
      const edit = await call('set_hours', { line: 0, day: 5, hours: 4, back: 1 });
      assert.equal(edit.isError, true);
      assert.equal(
        edit.text,
        `${MARKER.revision} Hours set but save requires a revision explanation.\n\nUse save_with_explanation to complete the save.`
      );
      const saved = await call('save_with_explanation', { explanation: 'wrong hours' });
      assert.equal(saved.isError, false, saved.text);
      const cp = await mock.launch();
      await cp.selectPeriod(1);
      assert.equal(cp.getData().projects[0].hours[5], 4);
    });

    test('another week while a revision is pending is refused and the edits survive', async () => {
      await call('set_hours', { line: 0, day: 5, hours: 4, back: 1 });
      const other = await call('show_timesheet');
      assert.equal(other.isError, true);
      assert.match(other.text, /back=1 has edits waiting/);
      const signing = await call('sign_timesheet', { back: 0 });
      assert.equal(signing.isError, true);
      const saved = await call('save_with_explanation', { explanation: 'still here' });
      assert.equal(saved.isError, false, saved.text);
    });

    test('a revision lost after the session was released says to redo the edit', async () => {
      await call('set_hours', { line: 0, day: 5, hours: 4, back: 1 });
      await built.shutdown();
      const res = await call('save_with_explanation', { explanation: 'too late' });
      assert.equal(res.isError, true);
      assert.match(res.text, /redo the edit/);
      assert.equal(mock.db.period(1).lines[0]['30'], '8');
    });

    test('a failed save_with_explanation drops the session and the pending explanation', async () => {
      await call('set_hours', { line: 0, day: 5, hours: 4, back: 1 });
      const original = DirectClient.prototype.saveWithExplanation;
      DirectClient.prototype.saveWithExplanation = async () => {
        throw new Error('Timesheet is read only');
      };
      let res;
      try {
        res = await call('save_with_explanation', { explanation: 'wrong hours' });
      } finally {
        DirectClient.prototype.saveWithExplanation = original;
      }
      assert.equal(res.isError, true);
      assert.match(res.text, /Timesheet is read only/);
      const again = await call('save_with_explanation', { explanation: 'retry' });
      assert.match(again.text, /^ERROR: No revision explanation is pending/);
      assert.equal((await call('show_timesheet')).isError, false);
      assert.equal(mock.db.period(1).lines[0]['30'], '8');
    });

    test('save_with_explanation with nothing pending is an error', async () => {
      const res = await call('save_with_explanation', { explanation: 'x' });
      assert.equal(res.isError, true);
      assert.match(res.text, /^ERROR: No revision explanation is pending/);
    });

    test('add_project resolves shortcuts and sets the work location', async () => {
      const res = await call('add_project', { code: 'pto', workLocation: '20190' });
      assert.equal(res.isError, false, res.text);
      assert.match(res.text, /Added ZLEAVE.CMP \(REG\). Saved./);
      const cp = await mock.launch();
      assert.equal(cp.childData.rows.find(r => r[6] === 'ZLEAVE.CMP')[8], '20190');
    });

    test('add_project rejects an invalid zip before touching Costpoint', async () => {
      const res = await call('add_project', { code: 'PROJ.C.300', workLocation: '2019' });
      assert.equal(res.isError, true);
      assert.match(res.text, /Invalid work location/);
      assert.equal(mock.sessions.size, 0);
    });

    test('add_project with a multi-charge code needs a pay type', async () => {
      const missing = await call('add_project', { code: 'PROJ.M.400' });
      assert.equal(missing.isError, true);
      assert.match(missing.text, /Multiple charges found/);
      const ok = await call('add_project', { code: 'PROJ.M.400', payType: 'RHB' });
      assert.equal(ok.isError, false, ok.text);
    });

    test('a failed add leaves no pending line for the next call', async () => {
      await call('add_project', { code: 'PROJ.M.400' });
      const res = await call('add_project', { code: 'PROJ.C.300' });
      assert.equal(res.isError, false, res.text);
      const codes = (await mock.launch()).getData().projects.map(p => p.code);
      assert.deepEqual(codes, ['PROJ.A.100', 'PROJ.B.200', 'PROJ.C.300']);
    });

    // A save after add-to-favorites can come back without rows (favsave-no204),
    // and each add sends one more CMD 300 action on the same session
    test('a second add on the held session saves a new line and leaves the first alone', async () => {
      const first = await call('add_project', { code: 'PROJ.C.300', favorite: true });
      assert.equal(first.isError, false, first.text);
      const second = await call('add_project', { code: 'pto' });
      assert.equal(second.isError, false, second.text);
      assert.equal(mock.sessions.size, 1);
      const codes = (await mock.launch()).getData().projects.map(p => p.code);
      assert.deepEqual(codes, ['PROJ.A.100', 'PROJ.B.200', 'PROJ.C.300', 'ZLEAVE.CMP']);
    });

    test('add_project with favorite adds the code to the favorites', async () => {
      await call('add_project', { code: 'PROJ.C.300', favorite: true });
      assert.ok(mock.db.favorites.some(f => f.code === 'PROJ.C.300'));
    });

    test('add_project leads with a warning when the favorites step fails, and the line is still saved', async t => {
      t.mock.method(DirectClient.prototype, 'addToFavorites', async () => {
        throw new Error('boom');
      });
      const res = await call('add_project', { code: 'PROJ.C.300', favorite: true });
      assert.equal(res.isError, false);
      assert.ok(res.text.startsWith(`${MARKER.warning} could not add to favorites: boom`), res.text);
      assert.match(res.text, /Added PROJ.C.300. Saved./);
      const codes = (await mock.launch()).getData().projects.map(p => p.code);
      assert.ok(codes.includes('PROJ.C.300'));
    });

    test('add_project on a past week adds a hint to sign again', async () => {
      const res = await call('add_project', { code: 'PROJ.C.300', back: 1 });
      assert.equal(res.isError, false, res.text);
      assert.match(res.text, /Week is Open again. Call sign_timesheet with back=1./);
      assert.equal(await status(1), 'O');
    });

    test('list_favorites lists every favorite with index, code, description and pay type', async () => {
      const list = await call('list_favorites');
      assert.equal(list.isError, false, list.text);
      assert.equal(list.text, '0 | PROJ.A.100 | Alpha Research | REG\n1 | PROJ.B.200 | Beta Support | REG');
    });

    test('list_favorites does not leave a pending line behind', async () => {
      const list = await call('list_favorites');
      assert.match(list.text, /0 \| PROJ.A.100 \| Alpha Research \| REG/);
      assert.match(list.text, /1 \| PROJ.B.200/);
      assert.equal(mock.sessions.size, 1);
      const cp = await mock.launch();
      assert.equal(cp.childData.rows.length, 2);
      const shown = await call('show_timesheet');
      assert.equal(shown.text.split('\n').filter(l => /^\d+ \|/.test(l)).length, 2);
    });

    test('add_from_favorites adds the picked favorite to the chosen week', async () => {
      const res = await call('add_from_favorites', { index: 1, workLocation: '20190' });
      assert.equal(res.isError, false, res.text);
      const lines = (await mock.launch()).getData().projects.map(p => p.code);
      assert.equal(lines.length, 3);
      assert.equal(lines[2], 'PROJ.B.200');
    });

    test('add_from_favorites sets the work location on the added line', async () => {
      const res = await call('add_from_favorites', { index: 1, workLocation: '20190-1234' });
      assert.equal(res.isError, false, res.text);
      const cp = await mock.launch();
      const rows = cp.childData.rows.filter(r => r[6] === 'PROJ.B.200');
      assert.deepEqual(
        rows.map(r => r[8]),
        [mock.db.employee.zip, '20190-1234']
      );
    });

    test('add_from_favorites with a bad index is an error and keeps the week clean', async () => {
      const res = await call('add_from_favorites', { index: 9 });
      assert.equal(res.isError, true);
      assert.match(res.text, /out of range/);
      assert.equal((await mock.launch()).childData.rows.length, 2);
    });

    test('get_leave_balances is unchanged', async () => {
      const res = await call('get_leave_balances');
      assert.match(res.text, /Paid Time Off \(PTO\): 120.0000/);
      assert.match(res.text, /Recent Leave Activity/);
    });

    test('a call after the mock expired the session retries with a new login', async () => {
      await call('show_timesheet');
      mock.expire();
      const res = await call('set_hours', { line: 0, day: 15, hours: 3 });
      assert.equal(res.isError, false, res.text);
      assert.equal((await mock.launch()).getData().projects[0].hours[15], 3);
    });

    test('the idle timer releases the session', async () => {
      await built.shutdown();
      await client.close();
      await connect({ idleMs: 30 });
      await call('show_timesheet');
      assert.equal(mock.sessions.size > 0, true);
      await new Promise(r => setTimeout(r, 120));
      await call('set_hours', { line: 0, day: 15, hours: 1 });
      assert.equal((await mock.launch()).getData().projects[0].hours[15], 1);
    });
  });
