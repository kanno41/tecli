'use strict';

// Gate for tests that talk to live Costpoint. They are opt-in: plain
// `npm test` must never reach the real site, even with a stored `te login`.

const { getCredentials, isMockRun } = require('../credentials');

function liveSkipReason() {
  if (process.env.SKIP_E2E === '1') return 'SKIP_E2E=1';
  if (isMockRun()) return 'TECLI_MOCK is set (this test needs live Costpoint)';
  if (process.env.RUN_E2E !== '1') return 'live Costpoint test; set RUN_E2E=1 to run it';
  return getCredentials() ? false : 'no Costpoint credentials';
}

module.exports = { liveSkipReason };
