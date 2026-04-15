#!/usr/bin/env node
'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const DirectClient = require('./direct');
const { getCredentials } = require('./credentials');
const { COMMON_CODES, resolveAlias } = require('./charge-codes');

require('dotenv').config();

const { RevisionRequiredError } = DirectClient;

// ── Session management ─────────────────────────────────────────
// Single persistent client, created on first use, auto-closed on idle.

let client = null;
let idleTimer = null;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (client) {
      await client.close().catch(() => {});
      client = null;
    }
  }, IDLE_TIMEOUT_MS);
}

async function getClient() {
  if (client) {
    resetIdleTimer();
    return client;
  }

  const creds = getCredentials();
  if (!creds) {
    throw new Error('No credentials found. Run `te login` to configure credentials, or set COSTPOINT_URL, COSTPOINT_USERNAME, and COSTPOINT_PASSWORD environment variables.');
  }

  client = await DirectClient.launch(creds.url, creds.username, creds.password);
  resetIdleTimer();
  return client;
}

async function withClient(fn) {
  try {
    const cp = await getClient();
    return await fn(cp);
  } catch (e) {
    // Session expired — retry once with fresh client
    if (client && (e.message.includes('session') || e.message.includes('Session') || e.message.includes('401') || e.message.includes('redirect'))) {
      await client.close().catch(() => {});
      client = null;
      const cp = await getClient();
      return await fn(cp);
    }
    throw e;
  }
}

// ── Format helpers ─────────────────────────────────────────────

function formatTimesheet(data) {
  const lines = [];
  lines.push(`Status: ${data.timesheetStatus} (Week ${data.payPeriodWeek} of ${data.payPeriodWeekCount})`);
  lines.push('');

  // Header row
  const dayHeaders = data.dates.map(d => `${d.dayOfWeek} ${d.date}`);
  lines.push(['#', 'Project', 'Description', 'Pay Type', ...dayHeaders, 'Total'].join(' | '));
  lines.push('-'.repeat(lines[lines.length - 1].length));

  // Project rows
  for (const p of data.projects) {
    const hours = data.dates.map(d => {
      const h = p.hours[d.date];
      return h != null ? String(h) : '-';
    });
    const total = data.dates.reduce((sum, d) => sum + (p.hours[d.date] || 0), 0);
    lines.push([p.line, p.code, p.description || '', p.payType || '', ...hours, total].join(' | '));
  }

  return lines.join('\n');
}

// ── MCP Server ─────────────────────────────────────────────────

const server = new McpServer({
  name: 'tecli',
  version: '1.0.0',
});

// -- show --
server.tool(
  'show_timesheet',
  'Show the current timesheet with status, project lines, hours, and comments for the active pay period.',
  {},
  async () => {
    return await withClient(async (cp) => {
      const data = cp.getData();
      return { content: [{ type: 'text', text: formatTimesheet(data) }] };
    });
  },
);

// -- set --
server.tool(
  'set_hours',
  'Set hours for a specific project line and day on the timesheet. Saves immediately.',
  {
    line: z.number().int().describe('Project line number (0-based index from show_timesheet)'),
    day: z.number().int().describe('Day of month (e.g. 14 for the 14th)'),
    hours: z.number().describe('Number of hours to set (e.g. 8, 4.5, 0)'),
    comment: z.string().optional().describe('Optional comment for the cell'),
  },
  async ({ line, day, hours, comment }) => {
    return await withClient(async (cp) => {
      await cp.set(line, day, hours, comment);
      try {
        await cp.save();
      } catch (e) {
        if (e instanceof RevisionRequiredError) {
          const details = e.auditDetails.map(d =>
            `Line ${d.lineNo}: ${d.description} (${d.project})`
          ).join('\n');
          return {
            content: [{ type: 'text', text: `Hours set but save requires a revision explanation.\n\nChanges requiring explanation:\n${details}\n\nUse save_with_explanation to complete the save.` }],
            isError: true,
          };
        }
        throw e;
      }
      const data = cp.getData();
      return { content: [{ type: 'text', text: `Set line ${line}, day ${day} to ${hours}h. Saved.\n\n${formatTimesheet(data)}` }] };
    });
  },
);

// -- setm --
server.tool(
  'set_hours_bulk',
  'Set hours for multiple cells at once. Each change is a {line, day, hours, comment?} object. Saves after all changes.',
  {
    changes: z.array(z.object({
      line: z.number().int().describe('Project line number'),
      day: z.number().int().describe('Day of month'),
      hours: z.number().describe('Hours to set'),
      comment: z.string().optional().describe('Optional comment'),
    })).describe('Array of cell changes'),
  },
  async ({ changes }) => {
    return await withClient(async (cp) => {
      for (const c of changes) {
        await cp.set(c.line, c.day, c.hours, c.comment);
      }
      try {
        await cp.save();
      } catch (e) {
        if (e instanceof RevisionRequiredError) {
          const details = e.auditDetails.map(d =>
            `Line ${d.lineNo}: ${d.description} (${d.project})`
          ).join('\n');
          return {
            content: [{ type: 'text', text: `${changes.length} cells updated but save requires a revision explanation.\n\nChanges requiring explanation:\n${details}\n\nUse save_with_explanation to complete the save.` }],
            isError: true,
          };
        }
        throw e;
      }
      const data = cp.getData();
      return { content: [{ type: 'text', text: `Updated ${changes.length} cell(s). Saved.\n\n${formatTimesheet(data)}` }] };
    });
  },
);

// -- add --
server.tool(
  'add_project',
  `Add a project/charge code to the timesheet. Saves after adding.\n\nShortcuts: ${COMMON_CODES.map(c => `${c.alias} (${c.label} → ${c.code})`).join(', ')}`,
  {
    code: z.string().describe('Project charge code (e.g. "ZLEAVE.CMP") or shortcut (e.g. "pto", "flex", "personal")'),
    payType: z.string().optional().describe('Pay type (e.g. "REG", "RHB"). Required for multi-charge codes, auto-resolved for shortcuts.'),
  },
  async ({ code, payType }) => {
    return await withClient(async (cp) => {
      const alias = resolveAlias(code);
      if (alias) {
        if (!payType) payType = alias.payType;
        code = alias.code;
      }

      const label = payType ? `${code} (${payType})` : code;
      await cp.add(code, payType);
      try {
        await cp.save();
      } catch (e) {
        if (e instanceof RevisionRequiredError) {
          return {
            content: [{ type: 'text', text: `Added ${label} but save requires a revision explanation. Use save_with_explanation.` }],
            isError: true,
          };
        }
        throw e;
      }
      const data = cp.getData();
      return { content: [{ type: 'text', text: `Added ${label}. Saved.\n\n${formatTimesheet(data)}` }] };
    });
  },
);

// -- sign --
server.tool(
  'sign_timesheet',
  'Sign the current timesheet. This submits the timesheet for approval.',
  {},
  async () => {
    return await withClient(async (cp) => {
      await cp.sign();
      const data = cp.getData();
      return { content: [{ type: 'text', text: `Timesheet signed.\n\n${formatTimesheet(data)}` }] };
    });
  },
);

// -- leave --
server.tool(
  'get_leave_balances',
  'Show leave balances (PTO, personal, flex, etc.) and recent leave activity.',
  {},
  async () => {
    return await withClient(async (cp) => {
      const { balances, details } = await cp.getLeaveBalances();
      const lines = [];

      lines.push('Leave Balances:');
      if (balances.length === 0) {
        lines.push('  No leave balances found.');
      } else {
        for (const b of balances) {
          lines.push(`  ${b.description}: ${b.balance.toFixed(4)}`);
        }
      }

      if (details.length > 0) {
        lines.push('');
        lines.push('Recent Leave Activity:');
        for (const d of details) {
          lines.push(`  ${d.date} | ${d.type} | ${d.hours.toFixed(4)}h | ${d.leaveTypeDesc || d.leaveTypeCode}`);
        }
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    });
  },
);

// -- save_with_explanation (for RevisionRequiredError recovery) --
server.tool(
  'save_with_explanation',
  'Save the timesheet with a revision explanation. Use this after a set/add operation returns a "revision explanation required" error.',
  {
    explanation: z.string().describe('Explanation for the timesheet revision'),
  },
  async ({ explanation }) => {
    return await withClient(async (cp) => {
      await cp.saveWithExplanation(explanation);
      const data = cp.getData();
      return { content: [{ type: 'text', text: `Saved with explanation.\n\n${formatTimesheet(data)}` }] };
    });
  },
);

// ── Start ──────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
