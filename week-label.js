'use strict';

const { normalizeTimesheetStatus } = require('./timesheet-status');

// Wording for weeks counted back from the current one (0 = current), shared
// by the CLI and the MCP server.

function weekLabel(back) {
  return back === 1 ? 'previous week' : `${back} weeks back`;
}

// Throws when back is further than the K0 periods the session loaded
function assertBackReachable(back, periodCount) {
  const reach = periodCount - 1;
  if (back > reach) {
    throw new Error(`Cannot go back ${back} weeks. Costpoint offers ${reach} past week${reach === 1 ? '' : 's'}.`);
  }
}

// Approved and Processed weeks were signed before they got there
const SIGNED_CODES = ['S', 'A', 'P'];

// One line with the signed state and the hours of every line in the week
function weekSummary(data) {
  const signed = SIGNED_CODES.includes(normalizeTimesheetStatus(data.timesheetStatusCode).code);
  const total = data.projects.reduce((sum, p) => sum + Object.values(p.hours).reduce((s, h) => s + (h || 0), 0), 0);
  return `Signed: ${signed ? 'yes' : 'no'} | Week total: ${Math.round(total * 100) / 100}h`;
}

module.exports = { weekLabel, assertBackReachable, weekSummary };
