'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { launchForPeriod, isSessionError, createSessionManager } = require('../session');
const DirectClient = require('../direct');

function fakeLauncher() {
  const launched = [];
  const launch = async period => {
    const client = {
      period,
      closed: false,
      close: async function () {
        this.closed = true;
      },
    };
    launched.push(client);
    return client;
  };
  return { launch, launched };
}

test('reuses the client for the same period', async () => {
  const { launch, launched } = fakeLauncher();
  const m = createSessionManager({ launch });
  const a = await m.getClient(0);
  const b = await m.getClient(0);
  assert.strictEqual(a, b);
  assert.strictEqual(launched.length, 1);
  await m.releaseClient();
});

test('relaunches and closes the old client on period change', async () => {
  const { launch } = fakeLauncher();
  const m = createSessionManager({ launch });
  const a = await m.getClient(0);
  const b = await m.getClient(2);
  assert.notStrictEqual(a, b);
  assert.ok(a.closed);
  assert.strictEqual(m.period, 2);
  assert.strictEqual(m.current(), b);
  await m.releaseClient();
});

test('fires hooks', async () => {
  const { launch } = fakeLauncher();
  const events = [];
  const m = createSessionManager({
    launch,
    onLaunch: p => events.push(`launch ${p}`),
    onLaunched: p => events.push(`launched ${p}`),
    onReuse: () => events.push('reuse'),
    onRelease: () => events.push('release'),
  });
  await m.getClient(1);
  await m.getClient(1);
  await m.releaseClient();
  assert.deepStrictEqual(events, ['launch 1', 'launched 1', 'reuse', 'release']);
});

test('withClient retries once on a session error', async () => {
  const { launch, launched } = fakeLauncher();
  const retried = [];
  const m = createSessionManager({ launch, onRetry: e => retried.push(e.message) });
  let calls = 0;
  const result = await m.withClient(async () => {
    calls++;
    if (calls === 1) throw new DirectClient.SessionExpiredError('gone');
    return 'ok';
  });
  assert.strictEqual(result, 'ok');
  assert.strictEqual(calls, 2);
  assert.strictEqual(launched.length, 2);
  assert.ok(launched[0].closed);
  assert.deepStrictEqual(retried, ['Costpoint session is not valid: gone']);
  await m.releaseClient();
});

test('withClient rethrows non-session errors without retry', async () => {
  const { launch, launched } = fakeLauncher();
  const m = createSessionManager({ launch });
  let calls = 0;
  await assert.rejects(
    m.withClient(async () => {
      calls++;
      throw new Error('boom');
    }),
    /boom/
  );
  assert.strictEqual(calls, 1);
  assert.strictEqual(launched.length, 1);
  await m.releaseClient();
});

test('withClient propagates a second session failure', async () => {
  const { launch } = fakeLauncher();
  const m = createSessionManager({ launch });
  let calls = 0;
  await assert.rejects(
    m.withClient(async () => {
      calls++;
      throw new DirectClient.SessionExpiredError('gone');
    }),
    /session is not valid: gone/
  );
  assert.strictEqual(calls, 2);
  await m.releaseClient();
});

test('releaseClient closes the client', async () => {
  const { launch } = fakeLauncher();
  const m = createSessionManager({ launch });
  const a = await m.getClient();
  await m.releaseClient();
  assert.ok(a.closed);
  assert.strictEqual(m.current(), null);
});

test('idle timer releases the client', async () => {
  const { launch } = fakeLauncher();
  const m = createSessionManager({ launch, idleMs: 20 });
  const a = await m.getClient();
  await new Promise(r => setTimeout(r, 80));
  assert.ok(a.closed);
  assert.strictEqual(m.current(), null);
});

test('launchForPeriod rejects past weeks outside direct mode', async () => {
  await assert.rejects(launchForPeriod({ useDirect: false, system: 'x' }, 1), /requires direct mode/);
});

test('isSessionError matches the servlet exception and dropped connections only', () => {
  const dropped = code => Object.assign(new Error('socket hang up'), { code });
  assert.ok(isSessionError(new DirectClient.SessionExpiredError('x')));
  assert.ok(isSessionError(dropped('ECONNRESET')));
  assert.ok(isSessionError(dropped('ECONNREFUSED')));
  for (const m of ['session', 'Session not valid', 'not valid', 'socket hang up', 'onServletException']) {
    assert.ok(!isSessionError(new Error(m)), m);
  }
  assert.ok(!isSessionError({}));
  assert.ok(!isSessionError(undefined));
});

test('launchForPeriod rejects a period beyond the loaded weeks, with the CLI message', async () => {
  const { startMock } = require('./mock-helper');
  const mock = await startMock();
  try {
    const creds = { url: mock.url, username: 'mock', password: 'mock', useDirect: true };
    await assert.rejects(() => launchForPeriod(creds, 25), /Cannot go back 25 weeks. Costpoint offers 19 past weeks./);
    const cp = await launchForPeriod(creds, 19);
    assert.equal(cp.getData().dates[6].fullDate, '2026-06-07');
    await cp.close();
  } finally {
    await mock.stop();
  }
});

// A timed-out request may have reached Costpoint (a save or a sign), so a
// blind retry could repeat the write: the timeout is not a session error
// (tecli-4mz.8)
test('a request timeout is not a session error and is not retried', async () => {
  const timeout = new DirectClient.RequestTimeoutError(60000);
  assert.strictEqual(isSessionError(timeout), false);

  const { launch, launched } = fakeLauncher();
  const m = createSessionManager({ launch });
  let calls = 0;
  await assert.rejects(
    m.withClient(async () => {
      calls++;
      throw timeout;
    }),
    /timed out/
  );
  assert.strictEqual(calls, 1);
  assert.strictEqual(launched.length, 1);
  assert.ok(launched[0].closed);
  assert.strictEqual(m.current(), null);
});

// An unreadable save reply may follow a committed save (tecli-dw7): never
// retried, and the session is dropped like after a timeout
test('a save with an unknown outcome is not retried and drops the session', async () => {
  const unknown = new DirectClient.SaveOutcomeUnknownError(new Error('responses is not defined at offset 0'));
  assert.strictEqual(isSessionError(unknown), false);

  const { launch, launched } = fakeLauncher();
  const m = createSessionManager({ launch });
  let calls = 0;
  await assert.rejects(
    m.withClient(async () => {
      calls++;
      throw unknown;
    }),
    /Save outcome unknown/
  );
  assert.strictEqual(calls, 1);
  assert.ok(launched[0].closed);
  assert.strictEqual(m.current(), null);
});

// A replay after a request that may have committed (a save, a sign, an
// action) could repeat it, e.g. add the same line twice (tecli-4mz.10)
describe('withClient retry after a write', () => {
  const expired = () => new DirectClient.SessionExpiredError();

  test('does not rerun fn once a write was sent', async () => {
    const { launch, launched } = fakeLauncher();
    const m = createSessionManager({ launch });
    let calls = 0;
    await assert.rejects(
      m.withClient(async cp => {
        calls++;
        cp.writesSent = (cp.writesSent || 0) + 1;
        throw expired();
      }),
      /session/i
    );
    assert.strictEqual(calls, 1);
    assert.ok(launched[0].closed);
    assert.strictEqual(m.current(), null);
  });

  test('reruns fn once when the session failed before any write', async () => {
    const { launch, launched } = fakeLauncher();
    const m = createSessionManager({ launch });
    let calls = 0;
    const result = await m.withClient(async () => {
      calls++;
      if (calls === 1) throw expired();
      return 'ok';
    });
    assert.strictEqual(result, 'ok');
    assert.strictEqual(calls, 2);
    assert.strictEqual(launched.length, 2);
    await m.releaseClient();
  });

  test('a business message that mentions the session is not retried', async () => {
    const { launch, launched } = fakeLauncher();
    const m = createSessionManager({ launch });
    let calls = 0;
    await assert.rejects(
      m.withClient(async () => {
        calls++;
        throw new Error('Charge is not valid for this session period');
      }),
      /not valid/
    );
    assert.strictEqual(calls, 1);
    assert.strictEqual(launched.length, 1);
    await m.releaseClient();
  });

  test('add + save whose save response is dropped leaves one line', async () => {
    const { startMock } = require('./mock-helper');
    const mock = await startMock();
    try {
      const creds = { url: mock.url, username: 'mock', password: 'mock', useDirect: true };
      const m = createSessionManager({ launch: period => launchForPeriod(creds, period) });
      mock.dropSave();
      await assert.rejects(
        m.withClient(async cp => {
          await cp.add('PROJ.C.300');
          await cp.save();
        }),
        /socket hang up|ECONNRESET/
      );
      await m.releaseClient();
      const lines = (await mock.launch()).getData().projects.filter(p => p.code === 'PROJ.C.300');
      assert.equal(lines.length, 1);
    } finally {
      await mock.stop();
    }
  });
});
