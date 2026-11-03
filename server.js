#!/usr/bin/env node
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const moment = require('moment');
const { normalizeTimesheetStatus } = require('./timesheet-status');
const { COMMON_CODES } = require('./charge-codes');
const { normalizeWorkLocation } = require('./add-options');
const { MAX_HOURS, parseHours } = require('./hours');
const { writePrivateFile } = require('./private-file');
const { getCredentials } = require('./credentials');
const weekWindow = require('./week-window');
const { launchForPeriod, createSessionManager, createRevisionHold, listFavorites } = require('./session');
const { createWebGuard, HOST } = require('./web-guard');
const { escapeHtml: esc } = require('./public/render');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const guard = createWebGuard(PORT);

const creds = getCredentials();
if (!creds) {
  console.error('No credentials found. Run `te login` to set up.');
  process.exit(1);
}
if (!creds.useDirect && !creds.system) {
  console.error(
    'COSTPOINT_SYSTEM is required when not using direct mode. Set COSTPOINT_DIRECT=true for direct protocol.'
  );
  process.exit(1);
}

const { useDirect } = creds;

// A past-week session is launched fresh and moved to its period before
// anything else runs (same rule as signing, see signTimesheet()).
const launchClient = (period = 0) => launchForPeriod(creds, period, { preloadPrevious: true });

// Signing launches with nothing but the period select before the sign. The
// active week skips the previous-period preload that launchClient(0) adds.
const launchSignClient = period => launchForPeriod(creds, period, { preloadPrevious: false });

// Persistent session management: one client reused across operations, bound
// to one period.
const { getClient, withClient, releaseClient } = createSessionManager({
  launch: launchClient,
  onLaunch: period => console.log(`Creating new Costpoint session (period ${period})...`),
  onLaunched: () => console.log('Session established.'),
  onReuse: () => console.log('Reusing existing Costpoint session.'),
  onRetry: e => console.log('Session error, retrying with fresh login:', e.message),
  onRelease: () => console.log('Costpoint session released.'),
});

// Cache file location — stores per-week data keyed by week start date
const CACHE_FILE = path.join(os.homedir(), '.costpoint-cache.json');

// In-memory state
let cachedWeeks = {}; // { "2026-04-06": weekData, ... }
let activeWeekStart = null; // fullDate of the most recently fetched week
let cachedPeriodCount = 0; // periods the session can reach (0 = unknown)
let pendingChanges = new Map(); // key: "period-line-day", value: { period, line, day, hours, comment }
const revisionHold = createRevisionHold(); // the period whose save is waiting on an explanation
let isProcessing = false;
let lastError = null;
let syncStatus = 'idle'; // idle, loading, syncing, error
let isFetchingInitialData = false;
const VALID_PAY_TYPES = new Set(['EWW', 'RHB', 'LWD', 'REG']);

// Get the week start date string from week data
function weekStartKey(weekData) {
  if (!weekData || !weekData.dates || weekData.dates.length === 0) return null;
  return weekData.dates[0].fullDate;
}

// Store fetched week data into the cache without changing the active week
function cacheWeek(weekData) {
  const key = weekStartKey(weekData);
  if (key) cachedWeeks[key] = weekData;
  return key;
}

// Store the active week's data into the cache
function storeWeekData(weekData) {
  const key = cacheWeek(weekData);
  if (key) activeWeekStart = key;
}

// Cache a session's data under the week it belongs to
function storeClientData(cp, period) {
  if (period === 0) storeWeekData(cp.getData());
  else cacheWeek(cp.getData());
}

function getPeriodCount() {
  return cachedPeriodCount || 2;
}

function getPeriodWeekData(period) {
  if (!activeWeekStart) return null;
  return cachedWeeks[weekWindow.periodWeekKey(activeWeekStart, period)] || null;
}

// Build the merged 2-week view for a window offset from cached data
function getMergedData(offset = 0) {
  if (!activeWeekStart) return null;
  return weekWindow.buildMergedData({
    activeStart: activeWeekStart,
    weeksByStart: cachedWeeks,
    offset: weekWindow.clampOffset(offset, getPeriodCount()),
    periodCount: getPeriodCount(),
    useDirect,
  });
}

// Load the weeks a window shows that are not cached yet, one fresh period
// session each. Failures leave the week empty and read-only.
async function ensureWindowWeeks(offset) {
  if (!activeWeekStart || !useDirect || isProcessing) return;
  const missing = weekWindow.windowPeriods(offset).filter(p => p > 0 && !getPeriodWeekData(p));
  if (missing.length === 0) return;

  isProcessing = true;
  syncStatus = 'loading';
  try {
    for (const period of missing) {
      await fetchPeriodData(period);
    }
    syncStatus = 'idle';
  } catch (e) {
    console.error('Failed to load past week:', e.message);
    lastError = e.message;
    syncStatus = 'error';
  } finally {
    isProcessing = false;
  }
}

async function fetchPeriodData(period) {
  await withClient(async cp => {
    cacheWeek(cp.getData());
    saveCache();
  }, period);
}

// Get the active week data (raw, for API/save operations)
function getActiveWeekData() {
  return activeWeekStart ? cachedWeeks[activeWeekStart] : null;
}

// Save cache to disk
function saveCache() {
  try {
    writePrivateFile(
      CACHE_FILE,
      JSON.stringify(
        {
          weeks: cachedWeeks,
          activeWeekStart,
        },
        null,
        2
      )
    );
  } catch (e) {
    console.error('Failed to save cache:', e.message);
  }
}

// Save all pending changes to Costpoint, one session per period, newest week
// first. Each period's changes leave pendingChanges once saved. A period that
// needs a revision explanation stops the run; saveWithExplanation() finishes
// it and resumes with the rest. Results and errors carry `saved` (periods
// committed by this run) and, when a period stopped the run, `failed` or
// `period`, so the page clears only what Costpoint has.
async function saveAllChanges() {
  if (isProcessing || pendingChanges.size === 0) return { success: true, message: 'No changes to save', saved: [] };

  isProcessing = true;
  syncStatus = 'syncing';
  const total = pendingChanges.size;
  const saved = [];
  let current = null;

  try {
    for (const period of weekWindow.pendingPeriods(pendingChanges.values())) {
      current = period;
      const changes = Array.from(pendingChanges.values()).filter(c => c.period === period);
      try {
        await withClient(async cp => {
          await cp.setm(changes);
          await cp.save();
          storeClientData(cp, period);
          saveCache();
        }, period);
      } catch (e) {
        if (revisionHold.hold(e, period)) {
          syncStatus = 'idle';
          return { revisionRequired: true, period, auditDetails: e.auditDetails, saved };
        }
        throw e;
      }
      clearPendingPeriod(period);
      saved.push(period);
    }

    lastError = null;
    syncStatus = 'idle';
    return { success: true, message: `Saved ${total} changes`, saved };
  } catch (e) {
    console.error('Save failed:', e.message);
    lastError = e.message;
    syncStatus = 'error';
    e.saved = saved;
    e.failed = current;
    throw e;
  } finally {
    isProcessing = false;
  }
}

function clearPendingPeriod(period) {
  for (const [key, change] of pendingChanges) {
    if (change.period === period) pendingChanges.delete(key);
  }
}

async function saveWithExplanation(explanation) {
  if (isProcessing) throw new Error('Another operation is in progress');
  revisionHold.assertHeld();

  isProcessing = true;
  syncStatus = 'syncing';
  const period = revisionHold.period;

  try {
    // Same period as the save that asked for it, so this reuses that session
    await revisionHold.finish(async () => {
      await withClient(async cp => {
        await cp.saveWithExplanation(explanation);
        storeClientData(cp, period);
        saveCache();
      }, period);
      clearPendingPeriod(period);
    });
    lastError = null;
    syncStatus = 'idle';
  } catch (e) {
    console.error('Save with explanation failed:', e.message);
    lastError = e.message;
    syncStatus = 'error';
    e.saved = [];
    e.failed = period;
    throw e;
  } finally {
    isProcessing = false;
  }

  // Save the other periods' changes, if any are still pending
  let rest;
  try {
    rest = await saveAllChanges();
  } catch (e) {
    e.saved = [period, ...(e.saved || [])];
    throw e;
  }
  const saved = [period, ...rest.saved];
  if (rest.revisionRequired) return { ...rest, saved };
  return { success: true, message: 'Saved with revision explanation', saved };
}

// Add a project to one week's timesheet. A save that needs a revision
// explanation is parked the same way as a cell save.
async function addProject(code, payType, period, favorite = false, workLocation) {
  if (isProcessing) throw new Error('Another operation is in progress');

  isProcessing = true;
  syncStatus = 'syncing';

  let warning = null;
  try {
    await withClient(async cp => {
      await cp.add(code, payType, { workLocation });
      if (favorite) {
        try {
          await cp.addToFavorites();
        } catch (e) {
          console.error('Add to favorites failed:', e.message);
          warning = `Could not add to favorites: ${e.message}`;
        }
      }
      await cp.save();
      storeClientData(cp, period);
      saveCache();
    }, period);

    lastError = null;
    syncStatus = 'idle';
    return { success: true, warning };
  } catch (e) {
    if (revisionHold.hold(e, period)) {
      syncStatus = 'idle';
      return { revisionRequired: true, period, auditDetails: e.auditDetails };
    }
    console.error('Add project failed:', e.message);
    lastError = e.message;
    syncStatus = 'error';
    throw e;
  } finally {
    isProcessing = false;
  }
}

// Sign one week's timesheet, identified by period
//
// Signing requires a fresh session (launch → sign, nothing between; for a
// past week launch → select period → sign). On a session that has done
// other work the server silently ignores the ACTION_CD='S' transition (the
// request round-trips cleanly but the timesheet stays unsigned; see
// CLAUDE.md). Release the persistent client and launch a fresh session just
// for the sign.
async function signTimesheet(period) {
  if (isProcessing) throw new Error('Another operation is in progress');

  isProcessing = true;
  syncStatus = 'syncing';

  try {
    await releaseClient();
    const cp = await launchSignClient(period);
    try {
      await cp.sign();
      storeClientData(cp, period);
      saveCache();
    } finally {
      try {
        await cp.close();
      } catch (e) {
        /* ignore */
      }
    }

    lastError = null;
    syncStatus = 'idle';
    return { success: true };
  } catch (e) {
    console.error('Sign failed:', e.message);
    lastError = e.message;
    syncStatus = 'error';
    throw e;
  } finally {
    isProcessing = false;
  }
}

// Fetch fresh data from Costpoint (active and previous week)
async function fetchFreshData() {
  if (isProcessing) throw new Error('Another operation is in progress');

  isProcessing = true;
  syncStatus = 'loading';

  try {
    // Release existing session — we want fresh data from server
    await releaseClient();
    revisionHold.clear();

    const cp = await getClient();

    // Store current week
    const currentWeek = cp.getData();
    storeWeekData(currentWeek);

    // Get previous period data without mutating client state (keeps
    // the session usable for subsequent save/sign operations)
    try {
      const otherWeek = cp.getPreviousPeriodData();
      if (otherWeek) cacheWeek(otherWeek);
    } catch (navErr) {
      console.error('Failed to fetch other period (non-fatal):', navErr.message);
    }

    activeWeekStart = weekStartKey(currentWeek);
    cachedPeriodCount = cp.getPeriods().length;
    dropStalePastWeeks();

    saveCache();
    lastError = null;
    syncStatus = 'idle';
    return getActiveWeekData();
  } catch (e) {
    console.error('Failed to fetch fresh data:', e.message);
    lastError = e.message;
    syncStatus = 'error';
    throw e;
  } finally {
    isProcessing = false;
  }
}

// A refresh reloads the active and previous week; older weeks come back on
// demand so they are not shown stale.
function dropStalePastWeeks() {
  const keep = new Set([0, 1].map(p => weekWindow.periodWeekKey(activeWeekStart, p)));
  for (const key of Object.keys(cachedWeeks)) {
    if (!keep.has(key)) delete cachedWeeks[key];
  }
}

// Fetch data in background (non-blocking)
function fetchFreshDataInBackground() {
  if (isFetchingInitialData || isProcessing) return;

  isFetchingInitialData = true;
  syncStatus = 'loading';

  fetchFreshData()
    .then(() => {
      console.log('Background fetch completed successfully');
    })
    .catch(e => {
      console.error('Background fetch failed:', e.message);
    })
    .finally(() => {
      isFetchingInitialData = false;
    });
}

// Middleware
app.use(guard.middleware);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// HTML template rendering
function renderHTML(data, isLoading = false) {
  const hasData = data && data.dates && data.dates.length > 0;
  const periodStart = hasData ? data.dates[0] : null;
  const periodEnd = hasData ? data.dates[data.dates.length - 1] : null;
  const currentStatus = isLoading ? 'loading' : syncStatus;
  const timesheetStatusMeta = hasData
    ? normalizeTimesheetStatus(data.timesheetStatusCode || data.timesheetStatus)
    : null;
  const timesheetStatusTitle =
    timesheetStatusMeta && timesheetStatusMeta.code
      ? `Raw status code: ${esc(timesheetStatusMeta.code)}`
      : 'Raw status unavailable';

  const weeksInfo =
    hasData && data.weeks
      ? data.weeks.map((w, i) => {
          const dates = data.dates.slice(i * 7, i * 7 + 7);
          const start = moment(dates[0].fullDate);
          const end = moment(dates[6].fullDate);
          const label =
            start.month() === end.month()
              ? start.format('MMM D') + '\u2013' + end.format('D')
              : start.format('MMM D') + ' \u2013 ' + end.format('MMM D');
          // isEditable already requires direct mode for past weeks
          const canSign = w.isEditable && (w.statusTone === 'open' || w.statusTone === 'missing');
          return Object.assign({}, w, { label: label, canSign: canSign });
        })
      : [];

  const targetWeeks = weeksInfo.filter(w => w.isEditable).reverse();
  const targetPicker = id => `
        <div class="modal-field">
          <label for="${id}">Week:</label>
          <select id="${id}" class="target-period">
            ${targetWeeks.map(w => `<option value="${w.period}">${esc(w.label)}${w.isActive ? ' (current)' : ''}</option>`).join('')}
          </select>
        </div>`;
  const navHref = offset => (offset === 0 ? '/' : `/?offset=${offset}`);
  const offset = hasData ? data.offset : 0;
  const weekNav = hasData
    ? `
    <nav class="week-nav">
      ${
        offset < data.maxOffset
          ? `<a class="btn btn-secondary btn-sm" id="nav-older" href="${navHref(offset + 1)}">&lsaquo; older</a>`
          : `<span class="btn btn-secondary btn-sm nav-disabled">&lsaquo; older</span>`
      }
      ${
        offset > 0
          ? `<a class="btn btn-secondary btn-sm" id="nav-newer" href="${navHref(offset - 1)}">newer &rsaquo;</a>`
          : `<span class="btn btn-secondary btn-sm nav-disabled">newer &rsaquo;</span>`
      }
      ${
        offset > 0
          ? `<a class="btn btn-secondary btn-sm" id="nav-current" href="/">Current</a>`
          : `<span class="btn btn-secondary btn-sm nav-disabled">Current</span>`
      }
    </nav>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="tecli-token" content="${guard.token}">
  <title>Str8 Outta Deltek</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div class="container">
    <header class="header">
      <img src="/deltek.png" alt="Str8 Outta Deltek" class="logo" />
      <div class="status-container">
        <div class="status-badges">
          <span id="sync-status" class="sync-dot sync-${currentStatus}" title="${currentStatus}"></span>
          ${
            timesheetStatusMeta
              ? `
          <span
            id="timesheet-status"
            class="status-badge timesheet-status-badge timesheet-status-${timesheetStatusMeta.tone}"
            title="${timesheetStatusTitle}"
          >
            ${esc(timesheetStatusMeta.label)}
          </span>
          `
              : ''
          }
        </div>
        <button id="refresh-btn" class="btn btn-secondary btn-icon" title="Refresh from Costpoint">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
          </svg>
        </button>
        <button id="clear-cache-btn" class="btn btn-secondary btn-icon" title="Clear cache">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2M10 11v6M14 11v6"/>
          </svg>
        </button>
      </div>
    </header>

    ${
      hasData
        ? `
    <div class="period-info">
      <span class="period-label">Period:</span>
      <span class="period-dates">${esc(periodStart.dayOfWeek)} ${esc(periodStart.fullDate)} - ${esc(periodEnd.dayOfWeek)} ${esc(periodEnd.fullDate)}</span>
    </div>
    ${weekNav}

    ${weeksInfo
      .filter(w => !w.isActive && w.canSign && w.statusTone === 'open')
      .map(
        w => `
    <div class="thursday-nudge past-sign-nudge">
      <span class="nudge-message">${w.period === 1 ? 'Previous week' : `Week of ${esc(w.label)}`} is Open and needs to be signed</span>
      <button class="btn-week-sign" data-week="${w.period}" data-label="${esc(w.label)}">Sign ${esc(w.label)}</button>
    </div>
    `
      )
      .join('')}

    <div id="thursday-nudge" class="thursday-nudge" style="display: none;">
      <span class="nudge-message"></span>
      <button id="nudge-copy-btn" class="btn btn-secondary btn-sm">Copy Thu &rarr; Fri</button>
    </div>

    <div class="timesheet-wrapper">
      <table class="timesheet" id="timesheet">
        <thead>
          <tr class="week-header-row">
            <th colspan="4" class="week-header-spacer"></th>
            ${weeksInfo
              .map(w => {
                return `<th colspan="7" class="week-header ${w.isEditable ? 'week-active' : 'week-inactive'}">
                <div class="week-header-content">
                  <span class="week-dates">${esc(w.label)}</span>
                  ${w.statusLabel ? `<span class="week-status-badge timesheet-status-${esc(w.statusTone)}">${esc(w.statusLabel)}</span>` : ''}
                  ${w.canSign && w.isActive ? '<button class="btn-copy-thu" title="Copy Thursday hours to Friday">Thu &rarr; Fri</button>' : ''}
                  ${w.canSign ? `<button class="btn-week-sign" data-week="${w.period}" data-label="${esc(w.label)}">Sign</button>` : ''}
                </div>
              </th>`;
              })
              .join('')}
            <th class="week-header-spacer"></th>
          </tr>
          <tr>
            <th class="col-line">#</th>
            <th class="col-code">Code</th>
            <th class="col-desc">Description</th>
            <th class="col-pay">Pay</th>
            ${data.dates
              .map((d, i) => {
                const isWeekend = d.dayOfWeek === 'Sat' || d.dayOfWeek === 'Sun';
                return `<th class="col-day ${isWeekend ? 'col-weekend' : 'col-weekday'}${i === 6 ? ' week-divider' : ''}"><div class="day-header"><span class="day-name">${esc(d.dayOfWeek)}</span><span class="day-num">${esc(d.date)}</span></div></th>`;
              })
              .join('')}
            <th class="col-total">Total</th>
          </tr>
        </thead>
        <tbody>
          ${data.projects
            .map(
              project => `
          <tr data-line="${esc(project.line)}">
            <td class="col-line">${esc(project.line)}</td>
            <td class="col-code" title="${esc(project.code || '')}">${esc(project.code || '')}</td>
            <td class="col-desc" title="${esc(project.description)}">${esc(project.description)}</td>
            <td class="col-pay">${esc(project.payType || '')}</td>
            ${data.dates
              .map((d, i) => {
                const hours = project.hours[d.date];
                const displayValue = hours !== null && hours !== undefined ? hours : '';
                const comment = (project.comments && project.comments[d.date]) || '';
                const escapedComment = esc(comment);
                const isWeekend = d.dayOfWeek === 'Sat' || d.dayOfWeek === 'Sun';
                const w = data.weeks[i < 7 ? 0 : 1];
                const periodLine = project.lines[w.period];
                const isEditable = w.isEditable && periodLine != null;
                const disabled = !isEditable ? 'disabled' : '';
                return `<td class="col-day ${isWeekend ? 'col-weekend' : 'col-weekday'} ${!isEditable ? 'col-inactive' : ''}${i === 6 ? ' week-divider' : ''}"><div class="cell-wrap${comment ? ' has-comment' : ''}"${comment ? ` title="${escapedComment}"` : ''}><input type="text" class="hours-input ${!isEditable ? 'inactive' : ''}" data-line="${esc(project.line)}" data-week="${esc(w.period)}" data-period-line="${isEditable ? esc(periodLine) : ''}" data-day="${esc(d.date)}" data-fulldate="${esc(d.fullDate)}" data-comment="${escapedComment}" value="${esc(displayValue)}" ${disabled} /></div></td>`;
              })
              .join('')}
            <td class="col-total row-total">0</td>
          </tr>
          `
            )
            .join('')}
        </tbody>
        <tfoot>
          <tr class="totals-row">
            <td class="col-line"></td>
            <td class="col-code"></td>
            <td class="col-desc">Daily Total</td>
            <td class="col-pay"></td>
            ${data.dates
              .map((d, i) => {
                const isWeekend = d.dayOfWeek === 'Sat' || d.dayOfWeek === 'Sun';
                return `<td class="col-day daily-total ${isWeekend ? 'col-weekend' : 'col-weekday'}${i === 6 ? ' week-divider' : ''}" data-day="${d.date}">0</td>`;
              })
              .join('')}
            <td class="col-total grand-total">0</td>
          </tr>
        </tfoot>
      </table>
    </div>

    <div class="actions">
      <button id="add-project-btn" class="btn btn-secondary">+ Add Project</button>
      <button id="favorites-btn" class="btn btn-secondary">Favorites</button>
      <button id="leave-bal-btn" class="btn btn-secondary">Leave Balances</button>
      <div class="actions-right">
        <span id="unsaved-indicator" class="unsaved-indicator" style="display: none;">Unsaved changes</span>
        <button id="save-btn" class="btn btn-success" disabled>Save</button>
      </div>
    </div>
    `
        : `
    <div class="skeleton-period-info"><div class="skel-bone skel-w40"></div></div>
    <div class="timesheet-wrapper">
      <table class="timesheet skeleton-table">
        <thead>
          <tr class="week-header-row">
            <th colspan="4" class="week-header-spacer"></th>
            <th colspan="7" class="week-header"><div class="skel-bone skel-w60"></div></th>
            <th colspan="7" class="week-header"><div class="skel-bone skel-w60"></div></th>
            <th class="week-header-spacer"></th>
          </tr>
          <tr>
            <th class="col-line"><div class="skel-bone skel-w100"></div></th>
            <th class="col-code"><div class="skel-bone skel-w100"></div></th>
            <th class="col-desc"><div class="skel-bone skel-w80"></div></th>
            <th class="col-pay"><div class="skel-bone skel-w100"></div></th>
            ${Array.from({ length: 14 }, (_, i) => `<th class="col-day${i === 6 ? ' week-divider' : ''}"><div class="skel-bone-circle"></div></th>`).join('')}
            <th class="col-total"><div class="skel-bone skel-w100"></div></th>
          </tr>
        </thead>
        <tbody>
          ${Array.from(
            { length: 6 },
            () => `<tr>
            <td class="col-line"><div class="skel-bone skel-w60"></div></td>
            <td class="col-code"><div class="skel-bone skel-w80"></div></td>
            <td class="col-desc"><div class="skel-bone skel-w70"></div></td>
            <td class="col-pay"><div class="skel-bone skel-w60"></div></td>
            ${Array.from({ length: 14 }, (_, i) => `<td class="col-day${i === 6 ? ' week-divider' : ''}"><div class="skel-bone skel-cell"></div></td>`).join('')}
            <td class="col-total"><div class="skel-bone skel-w60"></div></td>
          </tr>`
          ).join('')}
        </tbody>
        <tfoot>
          <tr class="totals-row">
            <td class="col-line"></td>
            <td class="col-code"></td>
            <td class="col-desc"><div class="skel-bone skel-w60"></div></td>
            <td class="col-pay"></td>
            ${Array.from({ length: 14 }, (_, i) => `<td class="col-day${i === 6 ? ' week-divider' : ''}"><div class="skel-bone skel-w60"></div></td>`).join('')}
            <td class="col-total"><div class="skel-bone skel-w80"></div></td>
          </tr>
        </tfoot>
      </table>
    </div>
    `
    }

    <div id="error-banner" class="error-banner" style="display: none;">
      <span id="error-message"></span>
      <button id="dismiss-error" class="btn-dismiss">&times;</button>
    </div>
  </div>

  <!-- Add Project Modal -->
  <div id="add-project-modal" class="modal" style="display: none;">
    <div class="modal-content">
      <div class="modal-header">
        <h2>Add Project</h2>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body">
        <div class="quick-picks">
          <label>Common Leave Codes:</label>
          <div class="quick-pick-grid">
            ${COMMON_CODES.map(
              c =>
                `<button class="btn btn-quick-pick" data-code="${c.code}" data-paytype="${c.payType}"${c.note ? ` title="${c.note}"` : ''}>${c.label}</button>`
            ).join('\n            ')}
          </div>
        </div>
        <div class="modal-divider"><span>or enter manually</span></div>
        ${targetPicker('add-target-period')}
        <div class="modal-field">
          <label for="project-code">Project Code:</label>
          <input type="text" id="project-code" placeholder="Enter project code..." />
        </div>
        <div class="modal-field">
          <label for="project-pay-type">Pay Type:</label>
          <select id="project-pay-type">
            <option value="REG" selected>REG</option>
            <option value="EWW">EWW</option>
            <option value="RHB">RHB</option>
            <option value="LWD">LWD</option>
          </select>
        </div>
        <div class="modal-field">
          <label for="project-work-location">Work Location:</label>
          <input type="text" id="project-work-location" placeholder="Zip code (blank = Costpoint default)" maxlength="10" />
        </div>
        <div class="modal-field">
          <label for="project-favorite">
            <input type="checkbox" id="project-favorite" /> Also add to favorites
          </label>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary modal-cancel">Cancel</button>
        <button class="btn btn-primary" id="confirm-add-project">Add</button>
      </div>
    </div>
  </div>

  <!-- Sign Confirmation Modal -->
  <div id="sign-modal" class="modal" style="display: none;">
    <div class="modal-content">
      <div class="modal-header">
        <h2>Sign Timesheet</h2>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body">
        <p id="sign-modal-text">Are you sure you want to sign this timesheet?</p>
        <p class="warning">This action cannot be undone.</p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary modal-cancel">Cancel</button>
        <button class="btn btn-primary" id="confirm-sign">Sign</button>
      </div>
    </div>
  </div>

  <!-- Favorites Modal -->
  <div id="favorites-modal" class="modal" style="display: none;">
    <div class="modal-content modal-wide">
      <div class="modal-header">
        <h2>Favorites</h2>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body">
        ${targetPicker('fav-target-period')}
        <div id="favorites-modal-body"><p>Loading...</p></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary modal-cancel">Close</button>
      </div>
    </div>
  </div>

  <!-- Leave Balances Modal -->
  <div id="leave-modal" class="modal" style="display: none;">
    <div class="modal-content modal-wide">
      <div class="modal-header">
        <h2>Leave Balances</h2>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body" id="leave-modal-body">
        <p>Loading...</p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary modal-cancel">Close</button>
      </div>
    </div>
  </div>

  <script>
    window.TIMESHEET_DATA = ${hasData ? JSON.stringify(data).replace(/</g, '\\u003c') : 'null'};
    window.IS_LOADING = ${isLoading};
  </script>
  <script src="/render.js"></script>
  <script src="/pending.js"></script>
  <script src="/app.js"></script>
</body>
</html>`;
}

// Routes
app.get('/', async (req, res) => {
  const offset = weekWindow.clampOffset(req.query.offset, getPeriodCount());
  await ensureWindowWeeks(offset);
  const mergedData = getMergedData(offset);
  const isLoading = !mergedData && isFetchingInitialData;
  res.send(renderHTML(mergedData, isLoading));
});

app.get('/api/status', (req, res) => {
  res.json({
    status: syncStatus,
    error: lastError,
    pendingChanges: pendingChanges.size,
    hasData: !!getActiveWeekData(),
  });
});

app.get('/api/data', async (req, res) => {
  const offset = weekWindow.clampOffset(req.query.offset, getPeriodCount());
  await ensureWindowWeeks(offset);
  const data = getMergedData(offset);
  if (!data) {
    return res.status(404).json({ error: 'No data cached' });
  }
  res.json(data);
});

// Resolve a cell edit request to { period, line } (period-local Costpoint
// line) or an error message
function resolveEditTarget(body) {
  const period = weekWindow.parsePeriod(body.period);
  if (period === null || period >= getPeriodCount()) return { error: 'Invalid period' };
  if (!weekWindow.weekEditable(getPeriodWeekData(period), period, useDirect)) {
    return { error: `Week ${period} is not editable` };
  }
  const line = body.periodLine === '' || body.periodLine === null ? NaN : Number(body.periodLine);
  const weekData = getPeriodWeekData(period);
  if (!Number.isInteger(line) || !weekData.projects.some(p => p.line === line)) {
    return { error: 'This line does not exist in that week' };
  }
  return { period, line };
}

app.put('/api/hours', (req, res) => {
  const { day, hours } = req.body;
  const target = resolveEditTarget(req.body);
  if (target.error) return res.status(400).json({ error: target.error });

  if (day === undefined || hours === undefined) {
    return res.status(400).json({ error: 'Missing required fields: day, hours' });
  }

  const hoursValue = parseHours(hours);
  if (hoursValue === null) {
    return res.status(400).json({ error: `Invalid hours "${hours}" (expected 0 to ${MAX_HOURS})` });
  }

  const { period, line } = target;
  const key = `${period}-${line}-${day}`;
  const existing = pendingChanges.get(key);
  pendingChanges.set(key, { period, line, day, hours: hoursValue, comment: existing ? existing.comment : undefined });

  // Update the week's cache optimistically
  const weekData = getPeriodWeekData(period);
  const project = weekData && weekData.projects.find(p => p.line === line);
  if (project) {
    project.hours[day] = hours === '' ? null : hoursValue;
  }

  res.json({ success: true, pendingCount: pendingChanges.size });
});

app.put('/api/comment', (req, res) => {
  const { day, comment } = req.body;
  const target = resolveEditTarget(req.body);
  if (target.error) return res.status(400).json({ error: target.error });

  if (day === undefined) {
    return res.status(400).json({ error: 'Missing required field: day' });
  }

  const { period, line } = target;
  const key = `${period}-${line}-${day}`;
  const existing = pendingChanges.get(key);
  const weekData = getPeriodWeekData(period);
  const project = weekData && weekData.projects ? weekData.projects.find(p => p.line === line) : null;

  if (existing) {
    // Merge comment into existing hours change
    existing.comment = comment || undefined;
  } else {
    // Comment-only change — use current hours from cache
    const currentHours = project && project.hours ? project.hours[day] || 0 : 0;
    pendingChanges.set(key, { period, line, day, hours: currentHours, comment: comment || undefined });
  }

  // Update cache optimistically
  if (project) {
    if (!project.comments) project.comments = {};
    project.comments[day] = comment || null;
  }

  res.json({ success: true, pendingCount: pendingChanges.size });
});

// A failed save still reports the periods it committed before the failure
function saveErrorBody(e) {
  const body = { error: e.message, saved: e.saved || [] };
  if (e.failed !== undefined && e.failed !== null) body.failed = e.failed;
  return body;
}

app.post('/api/save', async (req, res) => {
  try {
    const result = await saveAllChanges();
    res.json(result);
  } catch (e) {
    res.status(500).json(saveErrorBody(e));
  }
});

app.post('/api/save-with-explanation', async (req, res) => {
  const { explanation } = req.body;
  if (!explanation || !explanation.trim()) {
    return res.status(400).json({ error: 'Revision explanation is required' });
  }
  try {
    const result = await saveWithExplanation(explanation.trim());
    res.json(result);
  } catch (e) {
    res.status(500).json(saveErrorBody(e));
  }
});

app.post('/api/project', async (req, res) => {
  const { code, payType, favorite, workLocation } = req.body;
  const period = weekWindow.parsePeriod(req.body.period);

  if (!code) {
    return res.status(400).json({ error: 'Missing required field: code' });
  }
  if (period === null || period >= getPeriodCount()) {
    return res.status(400).json({ error: 'Invalid period' });
  }

  const normalizedPayType = typeof payType === 'string' && payType.trim() ? payType.trim().toUpperCase() : 'REG';

  if (!VALID_PAY_TYPES.has(normalizedPayType)) {
    return res.status(400).json({ error: 'Invalid pay type' });
  }

  let normalizedLocation;
  try {
    normalizedLocation = normalizeWorkLocation(workLocation);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  try {
    const result = await addProject(code, normalizedPayType, period, favorite === true, normalizedLocation);
    if (result.revisionRequired) return res.json(result);
    res.json({
      success: true,
      warning: result.warning,
      data: getMergedData(weekWindow.parsePeriod(req.body.offset)),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/sign', async (req, res) => {
  // No default: a sign names its week
  const period = weekWindow.parsePeriod(req.body && req.body.period, null);
  if (period === null || period >= getPeriodCount()) return res.status(400).json({ error: 'Invalid period' });
  try {
    await signTimesheet(period);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/refresh', async (req, res) => {
  try {
    await fetchFreshData();
    res.json({ success: true, data: getMergedData() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/leave', async (req, res) => {
  try {
    const result = await withClient(async cp => {
      return await cp.getLeaveBalances();
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/favorites', async (req, res) => {
  const period = weekWindow.parsePeriod(req.query.period);
  if (period === null || period >= getPeriodCount()) return res.status(400).json({ error: 'Invalid period' });
  try {
    res.json(await listFavorites(creds));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/cache', (req, res) => {
  try {
    cachedWeeks = {};
    activeWeekStart = null;
    cachedPeriodCount = 0;
    pendingChanges.clear();
    if (fs.existsSync(CACHE_FILE)) {
      fs.unlinkSync(CACHE_FILE);
    }
    res.json({ success: true, message: 'Cache cleared' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Initialize and start server — fetch fresh data immediately on boot
const listener = app.listen(PORT, HOST, () => {
  const { address, port } = listener.address();
  console.log(`Costpoint Web UI running at http://${address}:${port}`);
  console.log('Fetching data from Costpoint...');
  fetchFreshDataInBackground();
});
