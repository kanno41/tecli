'use strict';

const Costpoint = require('./costpoint');
const DirectClient = require('./direct');
const { assertBackReachable } = require('./week-label');

const DEFAULT_IDLE_MS = 5 * 60 * 1000;

// Weeks are identified by period: the parent K0 row index (0 = active week,
// 1 = the week before it, ...). A past-week session is launched fresh and
// moved to its period before anything else runs (same rule as signing).
// preloadPrevious only applies to the active week in direct mode.
async function launchForPeriod(creds, period, { preloadPrevious = false } = {}) {
  const { url, username, password, useDirect } = creds;
  if (!useDirect) {
    if (period !== 0) {
      throw new Error('Editing a past week requires direct mode (COSTPOINT_DIRECT=true)');
    }
    return Costpoint.launch(url, username, password);
  }
  if (period === 0) {
    return DirectClient.launch(url, username, password, preloadPrevious ? { loadPreviousPeriod: true } : undefined);
  }
  const cp = await DirectClient.launch(url, username, password);
  try {
    assertBackReachable(period, cp.getPeriods().length);
    await cp.selectPeriod(period);
  } catch (e) {
    try {
      await cp.close();
    } catch (e2) {
      /* ignore */
    }
    throw e;
  }
  return cp;
}

// Favorites belong to the user, not the week: list them on a throwaway
// active-week session so an edit session and a processed week stay as they are
async function listFavorites(creds) {
  if (!creds.useDirect) throw new Costpoint.NotSupportedError('Favorites');
  const cp = await launchForPeriod(creds, 0);
  try {
    return await cp.getFavorites();
  } finally {
    await cp.close().catch(() => {});
  }
}

// A lost session: the servlet's exception page (SessionExpiredError) or a
// dropped connection. Matched by type and code, not by message text, so a
// Costpoint business message that mentions a session is not one. A timeout
// (ETIMEDOUT) is not either: the request may have reached Costpoint.
const CONNECTION_ERRORS = new Set(['ECONNRESET', 'ECONNREFUSED']);
const UNSURE_ERRORS = new Set(['RequestTimeoutError', 'SaveOutcomeUnknownError']);

function isSessionError(e) {
  if (!e) return false;
  return e.name === 'SessionExpiredError' || CONNECTION_ERRORS.has(e.code);
}

// One client at a time, bound to one period; asking for another period
// relaunches it. An idle client is released after idleMs.
function createSessionManager({ launch, idleMs = DEFAULT_IDLE_MS, onLaunch, onLaunched, onReuse, onRetry, onRelease }) {
  let client = null;
  let clientPeriod = 0;
  let idleTimer = null;

  async function releaseClient() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (client) {
      const old = client;
      client = null;
      try {
        await old.close();
      } catch (e) {
        /* ignore */
      }
      if (onRelease) onRelease();
    }
  }

  async function getClient(period = 0) {
    if (idleTimer) clearTimeout(idleTimer);

    if (client && clientPeriod !== period) {
      await releaseClient();
    }

    if (!client) {
      if (onLaunch) onLaunch(period);
      client = await launch(period);
      clientPeriod = period;
      if (onLaunched) onLaunched(period);
    } else if (onReuse) {
      onReuse();
    }

    idleTimer = setTimeout(releaseClient, idleMs);
    idleTimer.unref();
    return client;
  }

  // fn is rerun once on a fresh session after a session error, but only if
  // the client sent no write (writesSent): a save whose response was lost may
  // have committed, and a replay would repeat it (tecli-4mz.10)
  async function withClient(fn, period = 0) {
    let cp = null;
    let writes = 0;
    try {
      cp = await getClient(period);
      writes = cp.writesSent || 0;
      return await fn(cp);
    } catch (e) {
      const wrote = cp !== null && (cp.writesSent || 0) !== writes;
      if (isSessionError(e) && !wrote) {
        if (onRetry) onRetry(e);
        await releaseClient();
        return await fn(await getClient(period));
      }
      // After a timeout, a lost session or an unreadable save reply the client
      // may not match what Costpoint has: the next operation starts fresh
      if (isSessionError(e) || UNSURE_ERRORS.has(e.name)) await releaseClient();
      throw e;
    }
  }

  return {
    getClient,
    withClient,
    releaseClient,
    current: () => client,
    get period() {
      return clientPeriod;
    },
  };
}

// A save that needs a revision explanation (RevisionRequiredError) leaves its
// edits on the session for that period. The hold remembers the period until
// finish() saves them with the explanation or the caller drops them (clear()).
function createRevisionHold() {
  let heldPeriod = null;

  function assertHeld() {
    if (heldPeriod === null) throw new Error('No save is waiting on a revision explanation');
  }

  return {
    get held() {
      return heldPeriod !== null;
    },
    get period() {
      return heldPeriod;
    },
    // True when e asks for an explanation; the caller reports it instead of throwing
    hold(e, period) {
      if (!e || e.name !== 'RevisionRequiredError') return false;
      heldPeriod = period;
      return true;
    },
    clear() {
      heldPeriod = null;
    },
    assertHeld,
    // save(period) sends the explanation. A failed save keeps the hold.
    async finish(save) {
      assertHeld();
      const result = await save(heldPeriod);
      heldPeriod = null;
      return result;
    },
  };
}

module.exports = { launchForPeriod, listFavorites, isSessionError, createSessionManager, createRevisionHold };
