'use strict';

// tui.js on a pty against the mock: week navigation, the unsaved-edit guard,
// multi-digit favorites picks, the add prompts and signing a past week
// (tecli-a1t.4).

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stripVTControlCharacters: stripAnsi } = require('util');
const { startMock } = require('./mock-helper');
const codec = require('../mock/codec');

const TUI = path.join(__dirname, '..', 'tui.js');
const STEP_MS = 15000;

// util-linux script(1) gives the TUI a pty, which it needs for raw mode
function hasScript() {
  if (process.platform !== 'linux') return false;
  try {
    execFileSync('script', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('tui against the mock', { skip: !hasScript() && 'needs util-linux script(1)' }, () => {
  let mock;
  let home;
  let tui;

  before(async () => {
    mock = await startMock();
  });

  after(() => mock.stop());

  // A fresh HOME per test: no shared ~/.costpoint-cache.json between tests
  beforeEach(() => {
    mock.reset();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tecli-tui-'));
  });

  afterEach(() => {
    if (tui) tui.kill();
    tui = null;
    fs.rmSync(home, { recursive: true, force: true });
  });

  // Starts the TUI and resolves once the first fetch has loaded
  async function startTui(env = {}) {
    const command = `stty rows 50 cols 120; exec '${process.execPath}' '${TUI}'`;
    const child = spawn('script', ['-qec', command, '/dev/null'], {
      cwd: home,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        SHELL: '/bin/sh',
        TERM: 'xterm-256color',
        TECLI_MOCK: '1',
        COSTPOINT_URL: mock.url,
        COSTPOINT_USERNAME: 'mock',
        COSTPOINT_PASSWORD: 'mock',
        COSTPOINT_DIRECT: 'true',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let waiter = null;
    const check = () => {
      if (waiter && waiter.pattern.test(stripAnsi(out.slice(waiter.from)))) {
        const { resolve, timer } = waiter;
        waiter = null;
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', d => {
      out += d;
      check();
    });
    child.stderr.on('data', d => {
      out += d;
    });
    const exited = new Promise(resolve => child.on('exit', resolve));

    // Waits for pattern in what the TUI draws after from (default: now)
    const waitFor = (pattern, from = out.length) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiter = null;
          reject(new Error(`no ${pattern} on the TUI screen:\n` + stripAnsi(out.slice(from)).slice(-3000)));
        }, STEP_MS);
        waiter = { pattern, from, resolve, timer };
        check();
      });

    // Types keys and waits for the screen to show pattern
    const press = (keys, pattern) => {
      const from = out.length;
      child.stdin.write(keys);
      return waitFor(pattern, from);
    };

    const quit = async () => {
      child.stdin.write('q');
      return exited;
    };

    tui = child;
    await waitFor(/Loaded\./, 0);
    return { press, waitFor, quit };
  }

  const lineOf = (period, code) => mock.db.period(period).lines.find(l => l[6] === code);

  describe('week navigation', () => {
    test('< and > step one week, bounded by the active week', async () => {
      const t = await startTui();
      await t.press('<', /PREVIOUS WEEK[\s\S]*Showing previous week\./);
      await t.press('<', /2 WEEKS AGO[\s\S]*Showing 2 weeks ago\./);
      await t.press('>', /PREVIOUS WEEK[\s\S]*Showing previous week\./);
      await t.press('>', /Showing the active week\./);
      await t.press('>', /Already on the active week\./);
      assert.equal(await t.quit(), 0);
    });

    test('[w] toggles between the active week and the last past week viewed', async () => {
      const t = await startTui();
      await t.press('<', /PREVIOUS WEEK/);
      await t.press('<', /2 WEEKS AGO/);
      await t.press('w', /Showing the active week\./);
      await t.press('w', /2 WEEKS AGO[\s\S]*Showing 2 weeks ago\./);
      await t.press('w', /Showing the active week\./);
      assert.equal(await t.quit(), 0);
    });

    test('unsaved edits block switching weeks', async () => {
      const t = await startTui();
      await t.press('5\r', /1 unsaved/);
      await t.press('<', /Save your changes before switching weeks\./);
      await t.press('w', /Save your changes before switching weeks\./);
      // Saving clears the guard
      await t.press('s', /Saved 1 change\./);
      await t.press('<', /Showing previous week\./);
      assert.equal(await t.quit(), 0);
    });
  });

  describe('favorites', () => {
    // 13 favorites: "1" waits for a second digit, "3" picks right away
    let thirteenth;
    beforeEach(() => {
      for (const c of mock.db.charges) {
        if (mock.db.favorites.length >= 13) break;
        mock.db.addFavorite(c);
      }
      assert.equal(mock.db.favorites.length, 13);
      thirteenth = mock.db.favorites[12];
      assert.equal(mock.db.favorites[2].code, 'PROJ.C.300');
    });

    test('a two-digit pick waits for the second digit', async () => {
      const t = await startTui();
      const code = thirteenth.code;
      await t.press('f', /Favorites loaded\./);
      await t.press('1', /Favorite #1/);
      assert.equal(lineOf(0, code), undefined);
      await t.press('3', new RegExp(`Added ${code.replace(/\./g, '\\.')}\\.`));
      const added = lineOf(0, code);
      assert.ok(added);
      assert.equal(added[16], thirteenth.payType);
      assert.equal(await t.quit(), 0);
    });

    // The pick takes the te add / add_from_favorites path (tecli-a1t.12): the
    // favorites lookup runs again on the session that adds and saves the line
    test('a pick looks the favorite up on the session that saves it', async () => {
      const traceFile = path.join(home, 'trace.jsonl');
      const t = await startTui({ COSTPOINT_TRACE: traceFile });
      await t.press('f', /Favorites loaded\./);
      await t.press('3', /Added PROJ\.C\.300\./);
      assert.equal(await t.quit(), 0);
      const requests = fs
        .readFileSync(traceFile, 'utf8')
        .trim()
        .split('\n')
        .map(l => JSON.parse(l).request)
        .filter(body => new URLSearchParams(body).has('cmd'))
        .map(body => codec.parseRequest(body));
      const saves = requests.filter(r => r.commands.some(c => c.reqCd === 206));
      assert.equal(saves.length, 1);
      const favoritesQuery = c => c.codes.R === 'HLKP' && (c.codes.W || '').includes('$H_LKP_SEL_LVL$^1^2^');
      const onSaveSession = requests.filter(r => r.sid === saves[0].sid);
      assert.ok(onSaveSession.some(r => r.commands.some(favoritesQuery)));
    });

    test('[e] asks pay type and work location for the next pick', async () => {
      const t = await startTui();
      await t.press('f', /Favorites loaded\./);
      await t.press('e', /Next pick asks pay type and work location\./);
      await t.press('3', /Pay type \[REG\]: /);
      await t.press('\r', /Work location zip \[Costpoint default\]: /);
      // A bad zip is reported and asked again
      await t.press('nowhere\r', /Work location zip \[Costpoint default\]: /);
      assert.equal(lineOf(0, 'PROJ.C.300'), undefined);
      await t.press('20190\r', /Added PROJ\.C\.300\./);
      assert.equal(lineOf(0, 'PROJ.C.300')[8], '20190');
      assert.equal(await t.quit(), 0);
    });
  });

  describe('add menu', () => {
    test('a custom code asks pay type, work location and favorites', async () => {
      const before = mock.db.favorites.length;
      const t = await startTui();
      await t.press('a', /Add Project:/);
      await t.press('0', /Project code: /);
      await t.press('PROJ.D.400\r', /Pay type \[REG\]: /);
      await t.press('\r', /Work location zip \[Costpoint default\]: /);
      await t.press('20190\r', /Also add to favorites\? \[y\/N\] /);
      await t.press('y\r', /Added PROJ\.D\.400 and saved to favorites\./);
      assert.equal(lineOf(0, 'PROJ.D.400')[8], '20190');
      assert.equal(mock.db.favorites.length, before + 1);
      assert.ok(mock.db.favorites.some(f => f.code === 'PROJ.D.400' && f.payType === 'REG'));
      assert.equal(await t.quit(), 0);
    });

    test('answering no to favorites adds only the line', async () => {
      const before = mock.db.favorites.length;
      const t = await startTui();
      await t.press('a', /Add Project:/);
      await t.press('0', /Project code: /);
      await t.press('PROJ.D.400\r', /Pay type \[REG\]: /);
      await t.press('\r', /Work location zip \[Costpoint default\]: /);
      await t.press('\r', /Also add to favorites\? \[y\/N\] /);
      await t.press('\r', /Added PROJ\.D\.400\./);
      const added = lineOf(0, 'PROJ.D.400');
      assert.ok(added);
      // The mock stores lines sparse: no column 8 means the default location
      assert.equal(added[8], undefined);
      assert.equal(mock.db.favorites.length, before);
      assert.equal(await t.quit(), 0);
    });
  });

  describe('past week', () => {
    test('editing a processed week reopens it and [S] signs it', async () => {
      assert.equal(mock.db.period(1).status, 'P');
      const t = await startTui();
      await t.press('<', /PREVIOUS WEEK[\s\S]*\[Processed\]/);
      await t.press('4\r', /1 unsaved/);
      await t.press('s', /Explanation: /);
      await t.press('late correction\r', /Saved with revision explanation\.[\s\S]*Press \[S\] to sign\./);
      assert.equal(mock.db.period(1).status, 'O');
      await t.press('S', /Sign this past week\? \[y\/n\] /);
      await t.press('y\r', /Timesheet signed\./);
      assert.equal(mock.db.period(1).status, 'S');
      assert.equal(mock.db.period(0).status, 'O');
      assert.equal(await t.quit(), 0);
    });

    // tecli-od6 step 3: what drops or keeps a save waiting on an explanation
    test('an empty explanation cancels the save and keeps the edit', async () => {
      const original = structuredClone(mock.db.period(1).lines);
      const t = await startTui();
      await t.press('<', /PREVIOUS WEEK[\s\S]*\[Processed\]/);
      await t.press('4\r', /1 unsaved/);
      await t.press('s', /Revision required: [\s\S]*Explanation: /);
      await t.press('\r', /Save cancelled — explanation required\.[\s\S]*1 unsaved/);
      assert.deepEqual(mock.db.period(1).lines, original);
      await t.press('s', /Explanation: /);
      await t.press('second look\r', /Saved with revision explanation\./);
      assert.notDeepEqual(mock.db.period(1).lines, original);
      assert.equal(await t.quit(), 0);
    });

    test('a failed explanation save keeps the edit for another try', async () => {
      const original = structuredClone(mock.db.period(1).lines);
      const t = await startTui();
      await t.press('<', /PREVIOUS WEEK[\s\S]*\[Processed\]/);
      await t.press('4\r', /1 unsaved/);
      await t.press('s', /Explanation: /);
      mock.failSave(1, 'Explanation rejected');
      await t.press('first try\r', /Save failed: Save with explanation error: Explanation rejected[\s\S]*1 unsaved/);
      assert.deepEqual(mock.db.period(1).lines, original);
      // The mock keeps the explanation on the session, so the retry saves plainly
      await t.press('s', /Saved 1 change\./);
      assert.notDeepEqual(mock.db.period(1).lines, original);
      assert.equal(await t.quit(), 0);
    });
  });
});
