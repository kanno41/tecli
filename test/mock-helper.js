'use strict';

// Shared setup for tests that run DirectClient against the mock server.

const { createMockServer } = require('../mock/server');
const DirectClient = require('../direct');
const { assertMockSafe } = require('../credentials');

// Mock tests must never reach real Costpoint (see TECLI_MOCK in README)
process.env.TECLI_MOCK = '1';

const TODAY = '2026-10-15';

async function startMock(options = {}) {
  const mock = await createMockServer({ today: TODAY, ...options });
  const clients = [];
  assertMockSafe({ url: mock.url });
  mock.launch = async (opts, who = {}) => {
    const cp = await DirectClient.launch(mock.url, who.user || 'mock', who.password || 'mock', opts);
    clients.push(cp);
    return cp;
  };
  mock.stop = async () => {
    await Promise.all(clients.map(c => c.close().catch(() => {})));
    await mock.close();
  };
  return mock;
}

function hoursOf(data, line, day) {
  return data.projects[line].hours[day];
}

module.exports = { startMock, hoursOf, TODAY };
