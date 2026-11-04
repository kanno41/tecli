'use strict';

// cli.js as a subprocess against the mock: week selection, add options and
// signing a past week (tecli-a1t.5).

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFile, execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stripVTControlCharacters: stripAnsi } = require('util');
const { startMock } = require('./mock-helper');

const CLI = path.join(__dirname, '..', 'cli.js');

// util-linux script(1) runs the CLI on a pty, so process.stdin.isTTY is true
function hasScript() {
  if (process.platform !== 'linux') return false;
  try {
    execFileSync('script', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('te against the mock', () => {
  let mock;
  let home;

  before(async () => {
    mock = await startMock({ password: 'mock' });
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tecli-cli-'));
  });

  after(async () => {
    await mock.stop();
    fs.rmSync(home, { recursive: true, force: true });
  });

  beforeEach(() => mock.reset());

  // cwd and HOME in a temp dir: no .env from the repo, no real credentials or cache
  const env = () => ({
    PATH: process.env.PATH,
    HOME: home,
    TECLI_MOCK: '1',
    COSTPOINT_URL: mock.url,
    COSTPOINT_USERNAME: 'mock',
    COSTPOINT_PASSWORD: 'mock',
    COSTPOINT_DIRECT: 'true',
  });

  // Async so the in-process mock keeps serving while the CLI runs. stdin is
  // not a TTY here, so add asks nothing.
  const teWith = (envOverrides, ...args) =>
    new Promise(resolve => {
      const child = execFile(
        process.execPath,
        [CLI, ...args],
        { cwd: home, env: { ...env(), ...envOverrides }, timeout: 20000 },
        (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stripAnsi(stdout + stderr) })
      );
      child.stdin.end();
    });
  const te = (...args) => teWith({}, ...args);

  // Runs te on a pty and types each answer once its prompt shows up
  const teOnTTY = (args, answers) =>
    new Promise((resolve, reject) => {
      const command = [process.execPath, CLI, ...args].map(a => `'${a}'`).join(' ');
      const child = spawn('script', ['-qec', command, '/dev/null'], {
        cwd: home,
        env: { ...env(), SHELL: '/bin/sh' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const pending = [...answers];
      let out = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('te did not finish on the pty:\n' + stripAnsi(out)));
      }, 20000);
      const onData = d => {
        out += d;
        const next = pending[0];
        if (next && next[0].test(stripAnsi(out))) {
          pending.shift();
          child.stdin.write(next[1] + '\r');
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('exit', code => {
        clearTimeout(timer);
        resolve({ code, out: stripAnsi(out), unanswered: pending.length });
      });
    });

  const lineOf = (period, code) => mock.db.period(period).lines.find(l => l[6] === code);

  describe('week selection', () => {
    test('--back n shows the week n weeks back', async () => {
      const { code, out } = await te('show', '--back', '3');
      assert.equal(code, 0, out);
      assert.match(out, /3 weeks back loaded/);
      assert.match(out, /Status: ● Processed/);
    });

    test('--prev shows the previous week', async () => {
      const { code, out } = await te('show', '--prev');
      assert.equal(code, 0, out);
      assert.match(out, /Previous week loaded/);
      assert.match(out, /Signed: yes \| Week total: 40\.5h/);
    });

    test('--prev together with --back is refused', async () => {
      const { code, out } = await te('show', '--prev', '--back', '2');
      assert.equal(code, 1);
      assert.match(out, /Use either --prev or --back <n>, not both\./);
    });

    test('--back as far as the loaded periods reach works', async () => {
      const reach = mock.db.periodCount - 1;
      const { code, out } = await te('show', '--back', String(reach));
      assert.equal(code, 0, out);
      assert.match(out, new RegExp(`${reach} weeks back loaded`));
    });

    test('--back past the loaded periods prints the week-label message', async () => {
      const reach = mock.db.periodCount - 1;
      const { code, out } = await te('show', '--back', String(reach + 1));
      assert.equal(code, 1);
      assert.match(out, new RegExp(`Cannot go back ${reach + 1} weeks\\. Costpoint offers ${reach} past weeks\\.`));
      assert.match(out, new RegExp(`Could not load ${reach + 1} weeks back`));
      assert.doesNotMatch(out, /Authentication failed/);
    });

    test('a failed login with --back reports the login, not the week', async () => {
      const { code, out } = await teWith({ COSTPOINT_PASSWORD: 'wrong' }, 'show', '--back', '2');
      assert.equal(code, 1);
      assert.match(out, /Authentication failed/);
      assert.doesNotMatch(out, /Could not load/);
    });
  });

  describe('add', () => {
    test('-l saves the given work location', async () => {
      const { code, out } = await te('add', 'PROJ.C.300', '-l', '20190');
      assert.equal(code, 0, out);
      assert.match(out, /Added PROJ\.C\.300/);
      assert.equal(lineOf(0, 'PROJ.C.300')[8], '20190');
    });

    test('-l rejects a location that is not a zip code', async () => {
      const { code } = await te('add', 'PROJ.C.300', '-l', 'nowhere');
      assert.equal(code, 1);
      assert.equal(lineOf(0, 'PROJ.C.300'), undefined);
    });

    test('--favorite saves the line and adds it to the favorites', async () => {
      const { code, out } = await te('add', 'PROJ.C.300', '--favorite');
      assert.equal(code, 0, out);
      assert.match(out, /Added to favorites/);
      assert.ok(lineOf(0, 'PROJ.C.300'));
      assert.ok(mock.db.favorites.some(f => f.code === 'PROJ.C.300' && f.payType === 'REG'));
    });

    test('without a TTY nothing is asked and the favorites stay as they were', async () => {
      const before = mock.db.favorites.length;
      const { code, out } = await te('add', 'PROJ.C.300', '-i');
      assert.equal(code, 0, out);
      assert.doesNotMatch(out, /Work location \[|favorites\?/);
      // The mock stores lines sparse: no column 8 means the default location
      const added = lineOf(0, 'PROJ.C.300');
      assert.ok(added);
      assert.equal(added[8], undefined);
      assert.equal(mock.db.favorites.length, before);
    });

    test(
      '-i on a TTY shows the default location and saves the typed one',
      { skip: !hasScript() && 'needs util-linux script(1)' },
      async () => {
        const { code, out, unanswered } = await teOnTTY(
          ['add', 'PROJ.D.400', '-i'],
          [
            [/Pay type: REG\. Work location \[12345\]: /, '20190'],
            [/Also add PROJ\.D\.400 to your favorites\? \(y\/N\): /, 'n'],
          ]
        );
        assert.equal(code, 0, out);
        assert.equal(unanswered, 0, out);
        assert.equal(lineOf(0, 'PROJ.D.400')[8], '20190');
        assert.ok(!mock.db.favorites.some(f => f.code === 'PROJ.D.400'));
      }
    );

    // Like a TUI [f] pick (tecli-a1t.12): the favorite's own lookup row, not
    // row 0 of the per-code lookup
    // Two lookup rows, only the favorite one carries a work location
    const addH01980 = () => {
      const base = { code: 'H01980.A.N102.210', payType: '', desc: 'Tech Integration', project: 'H01980' };
      mock.db.charges.push(
        { ...base, account: 'ZTC-IL-000-0000', parentBranch: 'H01980', workLocation: '' },
        { ...base, account: 'ZTC-IL-000-0000', parentBranch: '', workLocation: '62226', favorite: true }
      );
      mock.db.favorites.push({ code: base.code, payType: '', desc: base.desc });
    };

    test('a favorite code is added from its favorites row', async () => {
      addH01980();
      const { code, out } = await te('add', 'h01980.a.n102.210');
      assert.equal(code, 0, out);
      assert.match(out, /Added H01980\.A\.N102\.210/);
      assert.equal(lineOf(0, 'H01980.A.N102.210')[8], '62226');
    });

    test(
      'a pick from the favorites list is added from its favorites row',
      { skip: !hasScript() && 'needs util-linux script(1)' },
      async () => {
        addH01980();
        const { code, out, unanswered } = await teOnTTY(['add'], [[/Pick favorite \[1-3\]/, '3']]);
        assert.equal(code, 0, out);
        assert.equal(unanswered, 0, out);
        assert.equal(lineOf(0, 'H01980.A.N102.210')[8], '62226');
      }
    );

    test("a favorite code gets the favorite's pay type, an explicit one wins", async () => {
      mock.db.favorites.push({ code: 'PROJ.M.400', payType: 'RHB', desc: 'Delta Multi' });
      let { code, out } = await te('add', 'PROJ.M.400');
      assert.equal(code, 0, out);
      assert.match(out, /Added PROJ\.M\.400 \(RHB\)/);
      ({ code, out } = await te('add', 'PROJ.M.400', 'REG', '--back', '1'));
      assert.equal(code, 0, out);
      assert.match(out, /Added PROJ\.M\.400 \(REG\)/);
      const pay = period => mock.db.period(period).lines.find(l => l[6] === 'PROJ.M.400')[16];
      assert.equal(pay(0), 'RHB');
      assert.equal(pay(1), 'REG');
    });
  });

  describe('sign', () => {
    test('--back 1 -y signs a corrected previous week', async () => {
      const edit = await mock.launch();
      await edit.selectPeriod(1);
      await edit.set(0, 5, 4);
      await assert.rejects(() => edit.save(), { name: 'RevisionRequiredError' });
      await edit.saveWithExplanation('late correction');
      assert.equal(mock.db.period(1).status, 'O');

      const { code, out } = await te('sign', '--back', '1', '-y');
      assert.equal(code, 0, out);
      assert.match(out, /Previous week loaded/);
      assert.match(out, /✔ Signed/);
      assert.equal(mock.db.period(1).status, 'S');
      assert.equal(mock.db.period(0).status, 'O');
    });

    test('--back 1 -y on a processed week fails and signs nothing', async () => {
      const { code, out } = await te('sign', '--back', '1', '-y');
      assert.equal(code, 1);
      assert.match(out, /does not allow signing this week \(status Processed\)/);
      assert.equal(mock.db.period(1).status, 'P');
    });
  });
});
