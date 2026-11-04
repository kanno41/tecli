#!/usr/bin/env node
'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const DirectClient = require('./direct');
const { getCredentials, assertMockSafe, isMockRun } = require('./credentials');
const { COMMON_CODES, resolveAlias } = require('./charge-codes');
const { normalizeWorkLocation } = require('./add-options');
const { normalizeTimesheetStatus } = require('./timesheet-status');
const { launchForPeriod, createSessionManager, createRevisionHold, listFavorites } = require('./session');
const { weekLabel, weekSummary } = require('./week-label');
const { MAX_HOURS } = require('./hours');

require('dotenv').config();

const { SaveOutcomeUnknownError } = DirectClient;

const backSchema = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe('Weeks back from the current week (0 or omitted = current week, 1 = previous week). See list_weeks.');

const hoursSchema = z.number().min(0).max(MAX_HOURS);

// ── Format helpers ─────────────────────────────────────────────

function weekHeader(data, back) {
  const label = back === 0 ? 'Current week' : weekLabel(back)[0].toUpperCase() + weekLabel(back).slice(1);
  const first = data.dates[0].fullDate;
  const last = data.dates[data.dates.length - 1].fullDate;
  return `${label} (${first} to ${last}, back=${back})`;
}

function formatTimesheet(data, back) {
  const lines = [];
  lines.push(weekHeader(data, back));
  lines.push(`Status: ${data.timesheetStatus} (Week ${data.payPeriodWeek} of ${data.payPeriodWeekCount})`);
  lines.push(weekSummary(data));
  lines.push('');

  const dayHeaders = data.dates.map(d => `${d.dayOfWeek} ${d.date}`);
  lines.push(['#', 'Project', 'Description', 'Pay Type', ...dayHeaders, 'Total'].join(' | '));
  lines.push('-'.repeat(lines[lines.length - 1].length));

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

// Lines as code, pay type, hours and comments, in order: what an edit changes
const entries = data => JSON.stringify(data.projects.map(p => [p.code, p.payType || '', p.hours, p.comments]));
const sameEntries = (a, b) => entries(a) === entries(b);

// Editing a processed past week reopens it; it must be signed again
function signHint(data, back) {
  if (!back || normalizeTimesheetStatus(data.timesheetStatusCode).tone !== 'open') return '';
  return `\n\nWeek is Open again. Call sign_timesheet with back=${back}.`;
}

const text = (t, isError) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

// Some clients (code-mode-mcp) pass on only the text and drop isError, so
// every outcome other than plain success starts with one of these markers.
const MARKER = {
  error: 'ERROR:',
  revision: 'NOT SAVED: revision explanation required.',
  warning: 'WARNING:',
};

const errorResult = message => text(`${MARKER.error} ${message}`, true);

function revisionResult(e, summary) {
  const details = e.auditDetails.map(d => `Line ${d.lineNo}: ${d.description} (${d.project})`).join('\n');
  const body = details ? `\n\nChanges requiring explanation:\n${details}` : '';
  return text(
    `${MARKER.revision} ${summary} but save requires a revision explanation.${body}\n\nUse save_with_explanation to complete the save.`,
    true
  );
}

const INSTRUCTIONS = `Costpoint timesheet tools. Weeks are picked with back (0 = current week, see list_weeks).
Every result is one text block. Success is plain text. Other outcomes start with a marker:
- "${MARKER.error}" the call failed.
- "${MARKER.revision}" the edit is held until save_with_explanation is called.
- "${MARKER.warning}" the save went through but a side step failed.
Code-mode clients (tecli.tecli_x({...})): calls return the result string, so use plain JavaScript with no TypeScript annotations, and check the leading marker of the returned string.`;

// code-mode-mcp shows tool descriptions but not the server instructions.
const CODE_MODE_RULE = 'Code-mode: tool calls return the result string; return it or console.log it.';

const NOTE = {
  error: `Failures start with "${MARKER.error}".`,
  revision: `Starts with "${MARKER.revision}" when an explanation is needed.`,
};

// ── MCP Server ─────────────────────────────────────────────────

/**
 * Builds the tool server. options.creds replaces the stored credentials and
 * options.idleMs the 5 minute idle release (both for tests). Returns
 * { server, shutdown }; shutdown closes the held Costpoint session.
 */
function buildServer(options = {}) {
  // Edits waiting for a revision explanation live only on the current session
  const revisionHold = createRevisionHold();

  function credentials() {
    const creds = options.creds || getCredentials();
    assertMockSafe(creds);
    if (!creds) {
      throw new Error(
        'No credentials found. Run `te login` to configure credentials, or set COSTPOINT_URL, COSTPOINT_USERNAME, and COSTPOINT_PASSWORD environment variables.'
      );
    }
    // The MCP tools speak the direct protocol only
    return { ...creds, useDirect: true };
  }

  const manager = createSessionManager({
    launch: period => launchForPeriod(credentials(), period),
    idleMs: options.idleMs,
    onRelease: () => revisionHold.clear(),
  });
  const { withClient, releaseClient } = manager;

  // A session that is not shared with the edit session, closed right away
  async function withThrowaway(fn) {
    const cp = await launchForPeriod(credentials(), 0);
    try {
      return await fn(cp);
    } finally {
      await cp.close().catch(() => {});
    }
  }

  function guardRevision(back) {
    if (!revisionHold.held) return;
    if (back !== revisionHold.period) {
      throw new Error(
        `Week back=${revisionHold.period} has edits waiting for a revision explanation. Call save_with_explanation first; using another week now would discard them.`
      );
    }
  }

  // Run mutate on the session for that week and save. Any failure other than
  // a needed revision explanation drops the session so no half-done edit
  // (a pending line, unsaved cells) survives into the next call.
  async function editWeek(back, summary, mutate) {
    guardRevision(back);
    return withClient(async cp => {
      let done;
      let intended;
      try {
        done = await mutate(cp);
        intended = cp.getData();
        await cp.save();
        const data = cp.getData();
        return text(`${done}. Saved.\n\n${formatTimesheet(data, back)}${signHint(data, back)}`);
      } catch (e) {
        if (revisionHold.hold(e, back)) return revisionResult(e, summary);
        await releaseClient();
        if (e instanceof SaveOutcomeUnknownError) return confirmSave(back, done, intended, e);
        throw e;
      }
    }, back);
  }

  // The save was sent but its reply was unreadable (tecli-dw7). Read the week
  // back on a fresh login, read-only, and report the save only if the week
  // shows every edit. The save is never resent.
  async function confirmSave(back, done, intended, saveError) {
    let data;
    try {
      const cp = await launchForPeriod(credentials(), back);
      try {
        data = cp.getData();
      } finally {
        await cp.close().catch(() => {});
      }
    } catch {
      throw saveError;
    }
    if (sameEntries(intended, data)) {
      return text(`${done}. Saved.\n\n${formatTimesheet(data, back)}${signHint(data, back)}`);
    }
    throw new Error(
      `Save outcome unknown: Costpoint's reply to the save was unreadable and the week read back does not show every edit. Check it with show_timesheet before retrying.\n\n${formatTimesheet(data, back)}`
    );
  }

  const server = new McpServer({ name: 'tecli', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  // Thrown handler errors and argument validation failures both end up here.
  // createToolError is an SDK internal; mcp-server.test.js fails if it moves.
  server.createToolError = errorResult;
  const tool = (name, description, ...rest) => server.tool(name, `${description}\n\n${CODE_MODE_RULE}`, ...rest);

  tool(
    'list_weeks',
    `List the weeks reachable from this login (about 20): back number, end date, status and whether it can be edited. Use the back number with the other tools. ${NOTE.error}`,
    {},
    async () => {
      const periods = await withThrowaway(async cp => cp.getPeriods());
      const lines = periods.map(p => {
        const editable = p.editable === null ? 'unknown' : p.editable ? 'yes' : 'no';
        const status = normalizeTimesheetStatus(p.statusCode).label;
        return `back=${p.idx} | week ending ${p.endDate} | ${status} | editable: ${editable}`;
      });
      return text(lines.join('\n'));
    }
  );

  tool(
    'show_timesheet',
    `Show a timesheet with status, signed state, week total, project lines and hours. Defaults to the current week; pass back for a past week. ${NOTE.error}`,
    { back: backSchema },
    async ({ back = 0 }) => {
      guardRevision(back);
      return withClient(async cp => text(formatTimesheet(cp.getData(), back)), back);
    }
  );

  tool(
    'set_hours',
    `Set hours for a project line and day. Saves immediately. Editing a processed past week reopens it and asks for a revision explanation. ${NOTE.error} ${NOTE.revision}`,
    {
      line: z.number().int().describe('Project line number (0-based index from show_timesheet)'),
      day: z.number().int().describe('Day of month (e.g. 14 for the 14th)'),
      hours: hoursSchema.describe('Number of hours to set (e.g. 8, 4.5, 0)'),
      comment: z.string().optional().describe('Optional comment for the cell'),
      back: backSchema,
    },
    async ({ line, day, hours, comment, back = 0 }) =>
      editWeek(back, 'Hours set', async cp => {
        await cp.set(line, day, hours, comment);
        return `Set line ${line}, day ${day} to ${hours}h`;
      })
  );

  tool(
    'set_hours_bulk',
    `Set hours for multiple cells of one week at once. Each change is a {line, day, hours, comment?} object. Saves after all changes. ${NOTE.error} ${NOTE.revision}`,
    {
      changes: z
        .array(
          z.object({
            line: z.number().int().describe('Project line number'),
            day: z.number().int().describe('Day of month'),
            hours: hoursSchema.describe('Hours to set'),
            comment: z.string().optional().describe('Optional comment'),
          })
        )
        .describe('Array of cell changes'),
      back: backSchema,
    },
    async ({ changes, back = 0 }) =>
      editWeek(back, `${changes.length} cells updated`, async cp => {
        for (const c of changes) {
          await cp.set(c.line, c.day, c.hours, c.comment);
        }
        return `Updated ${changes.length} cell(s)`;
      })
  );

  tool(
    'add_project',
    `Add a project/charge code to a timesheet. Saves after adding. ${NOTE.error} ${NOTE.revision} Starts with "${MARKER.warning}" when the line was saved but adding it to favorites failed.\n\nShortcuts: ${COMMON_CODES.map(c => `${c.alias} (${c.label} → ${c.code})`).join(', ')}`,
    {
      code: z.string().describe('Project charge code (e.g. "ZLEAVE.CMP") or shortcut (e.g. "pto", "flex", "personal")'),
      payType: z
        .string()
        .optional()
        .describe('Pay type (e.g. "REG", "RHB"). Required for multi-charge codes, auto-resolved for shortcuts.'),
      workLocation: z
        .string()
        .optional()
        .describe('Work location zip code (5 digits or ZIP+4). Omit to keep the Costpoint default.'),
      favorite: z.boolean().optional().describe('Also add the code to your Costpoint favorites'),
      back: backSchema,
    },
    async ({ code, payType, workLocation, favorite, back = 0 }) => {
      const zip = normalizeWorkLocation(workLocation);
      const alias = resolveAlias(code);
      if (alias) {
        if (!payType) payType = alias.payType;
        code = alias.code;
      }
      const label = payType ? `${code} (${payType})` : code;
      let warning = '';
      const result = await editWeek(back, `Added ${label}`, async cp => {
        await cp.add(code, payType, { workLocation: zip });
        if (favorite) {
          try {
            await cp.addToFavorites();
          } catch (e) {
            warning = `${MARKER.warning} could not add to favorites: ${e.message}`;
          }
        }
        return `Added ${label}`;
      });
      if (warning) {
        // A needed revision explanation keeps its marker in front
        const t = result.content[0].text;
        result.content[0].text = result.isError ? `${t}\n\n${warning}` : `${warning}\n\n${t}`;
      }
      return result;
    }
  );

  tool(
    'list_favorites',
    `List the favorite charge codes saved in Costpoint. Favorites belong to the user, not to a week. Use the index with add_from_favorites. ${NOTE.error}`,
    {},
    async () => {
      const favs = await listFavorites(credentials());
      if (favs.length === 0) return text('No favorites found.');
      return text(favs.map((f, i) => `${i} | ${f.code} | ${f.description || ''} | ${f.payType || ''}`).join('\n'));
    }
  );

  tool(
    'add_from_favorites',
    `Add a favorite charge code (by index from list_favorites) to a timesheet. Saves after adding. ${NOTE.error} ${NOTE.revision}`,
    {
      index: z.number().int().min(0).describe('Favorite index from list_favorites'),
      workLocation: z
        .string()
        .optional()
        .describe('Work location zip code (5 digits or ZIP+4). Omit to keep the Costpoint default.'),
      back: backSchema,
    },
    async ({ index, workLocation, back = 0 }) => {
      const zip = normalizeWorkLocation(workLocation);
      return editWeek(back, 'Favorite added', async cp => {
        const fav = await cp.addFromFavorite(index, { workLocation: zip });
        return `Added ${fav.payType ? `${fav.code} (${fav.payType})` : fav.code}`;
      });
    }
  );

  tool(
    'sign_timesheet',
    `Sign a timesheet (current week by default). This submits it for approval. Runs on its own fresh login, never on the session used for edits. ${NOTE.error}`,
    { back: backSchema },
    async ({ back = 0 }) => {
      if (revisionHold.held) {
        throw new Error(
          `Week back=${revisionHold.period} has edits waiting for a revision explanation. Call save_with_explanation first; signing now would discard them.`
        );
      }
      await releaseClient();
      const cp = await launchForPeriod(credentials(), back);
      try {
        await cp.sign();
        return text(`Timesheet signed.\n\n${formatTimesheet(cp.getData(), back)}`);
      } finally {
        await cp.close().catch(() => {});
      }
    }
  );

  tool(
    'save_with_explanation',
    `Save the timesheet with a revision explanation. Use this after an edit result starts with "${MARKER.revision}" ${NOTE.error}`,
    {
      explanation: z.string().describe('Explanation for the timesheet revision'),
    },
    async ({ explanation }) => {
      if (!revisionHold.held || !manager.current()) {
        throw new Error(
          'No revision explanation is pending. The session that held the edits was released, so redo the edit and save again.'
        );
      }
      const back = revisionHold.period;
      const cp = await manager.getClient(back);
      await revisionHold.finish(async () => {
        try {
          await cp.saveWithExplanation(explanation);
        } catch (e) {
          // Like editWeek: a failed save must not leave its edits for the next
          // call. Releasing the session also drops the hold.
          await releaseClient();
          throw e;
        }
      });
      const data = cp.getData();
      return text(`Saved with explanation.\n\n${formatTimesheet(data, back)}${signHint(data, back)}`);
    }
  );

  tool(
    'get_leave_balances',
    `Show leave balances (PTO, personal, flex, etc.) and recent leave activity. ${NOTE.error}`,
    {},
    async () => {
      // Reuse whatever session is open so a pending revision is not dropped
      const period = manager.current() ? manager.period : 0;
      return withClient(async cp => {
        const { balances, details } = await cp.getLeaveBalances();
        const lines = ['Leave Balances:'];
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

        return text(lines.join('\n'));
      }, period);
    }
  );

  return { server, shutdown: releaseClient };
}

// ── Start ──────────────────────────────────────────────────────

async function main() {
  // Credentials are read lazily per tool call, so a mock run checks them up
  // front: refusing to start is the only signal a client is sure to see.
  if (isMockRun()) {
    try {
      getCredentials();
    } catch (e) {
      console.error(`tecli MCP server refused to start: ${e.message}`);
      process.exit(2);
    }
  }
  const { server } = buildServer();
  await server.connect(new StdioServerTransport());
}

if (require.main === module) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { buildServer, MARKER };
