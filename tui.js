#!/usr/bin/env node
'use strict';

const chalk = require('chalk');
const readline = require('readline');
const fs = require('fs');
const os = require('os');
const path = require('path');
const DirectClient = require('./direct');
const Costpoint = require('./costpoint');
const { normalizeTimesheetStatus } = require('./timesheet-status');
const { getCredentials } = require('./credentials');
const { COMMON_CODES } = require('./charge-codes');

require('dotenv').config();

const creds = getCredentials();
if (!creds) {
  console.error('No credentials found. Run `te login` to set up.');
  process.exit(1);
}

const { url, username, password, system, useDirect } = creds;

// ─── Session management ────────────────────────────────────────

let activeClient = null;
let clientIdleTimer = null;
const CLIENT_IDLE_TIMEOUT = 5 * 60 * 1000;

async function launchNewClient() {
  if (useDirect) return DirectClient.launch(url, username, password);
  return Costpoint.launch(url, username, password, system);
}

async function getClient() {
  if (clientIdleTimer) clearTimeout(clientIdleTimer);
  if (!activeClient) {
    setStatus('Logging in...');
    render();
    activeClient = await launchNewClient();
  }
  clientIdleTimer = setTimeout(releaseClient, CLIENT_IDLE_TIMEOUT);
  return activeClient;
}

async function releaseClient() {
  if (clientIdleTimer) { clearTimeout(clientIdleTimer); clientIdleTimer = null; }
  if (activeClient) {
    try { await activeClient.close(); } catch (e) { /* ignore */ }
    activeClient = null;
  }
}

function isSessionError(e) {
  const msg = (e.message || '').toLowerCase();
  return msg.includes('session') || msg.includes('not valid') ||
         msg.includes('econnreset') || msg.includes('econnrefused') ||
         msg.includes('socket hang up') || msg.includes('onservletexception');
}

async function withClient(fn) {
  try {
    return await fn(await getClient());
  } catch (e) {
    if (isSessionError(e)) {
      setStatus('Session expired, re-logging in...');
      render();
      await releaseClient();
      return await fn(await getClient());
    }
    throw e;
  }
}

// ─── Cache (shared with web UI) ────────────────────────────────

const CACHE_FILE = path.join(os.homedir(), '.costpoint-cache.json');
let cachedWeeks = {};
let activeWeekStart = null;

function weekStartKey(weekData) {
  if (!weekData || !weekData.dates || weekData.dates.length === 0) return null;
  return weekData.dates[0].fullDate;
}

function storeWeekData(weekData) {
  const key = weekStartKey(weekData);
  if (!key) return;
  cachedWeeks[key] = weekData;
  activeWeekStart = key;
}

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (parsed && parsed.weeks) {
        cachedWeeks = parsed.weeks;
        activeWeekStart = parsed.activeWeekStart || null;
        return true;
      }
    }
  } catch (e) { /* ignore */ }
  return false;
}

function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ weeks: cachedWeeks, activeWeekStart }, null, 2));
  } catch (e) { /* ignore */ }
}

function getActiveWeekData() {
  return activeWeekStart ? cachedWeeks[activeWeekStart] : null;
}

// Project codes that require a comment when hours are entered
const COMMENT_REQUIRED_CODES = ['A09909.SUSP.OVH'];
function isCommentRequired(code) { return COMMENT_REQUIRED_CODES.includes(code); }

// ─── TUI state ─────────────────────────────────────────────────

let data = null;
let cursorRow = 0;
let cursorCol = 0;
let mode = 'navigate'; // navigate | edit | prompt | menu
let menuItems = null;   // set when mode === 'menu'
let editBuffer = '';
let promptLabel = '';
let promptBuffer = '';
let promptCallback = null;
let statusMsg = '';
let statusTimer = null;
let pendingChanges = new Map();
let leaveData = null;     // { balances, details } from getLeaveBalances()
let showLeave = false;    // toggle: timesheet vs leave view
let isProcessing = false;
let spinnerFrame = 0;
const SPINNER = '\u28fe\u28fd\u28fb\u28bf\u28ff\u28df\u28ef\u28f7';
let spinnerInterval = null;

function setStatus(msg, duration) {
  if (statusTimer) clearTimeout(statusTimer);
  statusMsg = msg;
  if (duration) {
    statusTimer = setTimeout(() => { statusMsg = ''; render(); }, duration);
  }
}

// ─── Data operations ───────────────────────────────────────────

async function fetchData() {
  if (isProcessing) return;
  isProcessing = true;
  startSpinner();
  setStatus('Loading timesheet...');
  render();

  try {
    await releaseClient();
    const cp = await getClient();
    storeWeekData(cp.getData());

    try {
      if (typeof cp.getPreviousPeriodData === 'function') {
        const other = cp.getPreviousPeriodData();
        if (other) {
          const key = weekStartKey(other);
          if (key) cachedWeeks[key] = other;
        }
      }
    } catch (e) { /* non-fatal */ }

    saveCache();
    data = getActiveWeekData();
    clampCursor();
    setStatus(chalk.green('Loaded.'), 3000);
  } catch (e) {
    setStatus(chalk.red('Load failed: ' + e.message), 5000);
  } finally {
    isProcessing = false;
    stopSpinner();
    render();
  }
}

async function doSave() {
  if (isProcessing || pendingChanges.size === 0) {
    setStatus('Nothing to save.', 2000);
    render();
    return;
  }
  isProcessing = true;
  startSpinner();
  setStatus('Saving...');
  render();

  const changes = Array.from(pendingChanges.values());
  try {
    await withClient(async (cp) => {
      if (changes.length === 1) {
        await cp.set(changes[0].line, changes[0].day, changes[0].hours, changes[0].comment);
      } else {
        await cp.setm(changes);
      }
      await cp.save();
      storeWeekData(cp.getData());
      saveCache();
    });
    data = getActiveWeekData();
    pendingChanges.clear();
    clampCursor();
    setStatus(chalk.green('Saved ' + changes.length + ' change' + (changes.length !== 1 ? 's' : '') + '.'), 3000);
  } catch (e) {
    if (e.name === 'RevisionRequiredError') {
      stopSpinner();
      isProcessing = false;
      const details = e.auditDetails.map(d => d.description).filter(Boolean).join('; ');
      setStatus(chalk.yellow('Revision required: ' + (details || 'changes need explanation')), 0);
      render();
      enterPrompt('Explanation: ', async (explanation) => {
        if (!explanation || !explanation.trim()) {
          setStatus(chalk.red('Save cancelled — explanation required.'), 3000);
          render();
          return;
        }
        isProcessing = true;
        startSpinner();
        setStatus('Saving with explanation...');
        render();
        try {
          await withClient(async (cp) => {
            await cp.saveWithExplanation(explanation.trim());
            storeWeekData(cp.getData());
            saveCache();
          });
          data = getActiveWeekData();
          pendingChanges.clear();
          clampCursor();
          setStatus(chalk.green('Saved with revision explanation.'), 3000);
        } catch (e2) {
          setStatus(chalk.red('Save failed: ' + e2.message), 5000);
        } finally {
          isProcessing = false;
          stopSpinner();
          render();
        }
      });
      return;
    }
    setStatus(chalk.red('Save failed: ' + e.message), 5000);
  } finally {
    isProcessing = false;
    stopSpinner();
    render();
  }
}

async function doSign() {
  if (isProcessing) return;
  isProcessing = true;
  startSpinner();
  setStatus('Signing...');
  render();

  try {
    await withClient(async (cp) => {
      await cp.sign();
      storeWeekData(cp.getData());
      saveCache();
    });
    data = getActiveWeekData();
    pendingChanges.clear();
    setStatus(chalk.green('Timesheet signed.'), 3000);
  } catch (e) {
    setStatus(chalk.red('Sign failed: ' + e.message), 5000);
  } finally {
    isProcessing = false;
    stopSpinner();
    render();
  }
}

async function doAddProject(code, payType) {
  if (isProcessing) return;
  isProcessing = true;
  startSpinner();
  setStatus('Adding ' + code + '...');
  render();

  try {
    await withClient(async (cp) => {
      await cp.add(code, payType || 'REG');
      await cp.save();
      storeWeekData(cp.getData());
      saveCache();
    });
    data = getActiveWeekData();
    clampCursor();
    setStatus(chalk.green('Added ' + code + '.'), 3000);
  } catch (e) {
    setStatus(chalk.red('Add failed: ' + e.message), 5000);
  } finally {
    isProcessing = false;
    stopSpinner();
    render();
  }
}

function doCopyThuFri() {
  if (!data || !data.dates) return;
  let thuIdx = -1, friIdx = -1;
  for (let i = 0; i < data.dates.length; i++) {
    if (data.dates[i].dayOfWeek === 'Thu') thuIdx = i;
    if (data.dates[i].dayOfWeek === 'Fri') friIdx = i;
  }
  if (thuIdx < 0 || friIdx < 0) return;

  let copied = 0;
  for (let r = 0; r < data.projects.length; r++) {
    const thuVal = getCellValue(r, thuIdx);
    const friVal = getCellValue(r, friIdx);
    if (thuVal !== '' && thuVal !== friVal) {
      const line = data.projects[r].line;
      const day = data.dates[friIdx].date;
      pendingChanges.set(line + '-' + day, { line, day, hours: parseFloat(thuVal) });
      copied++;
    }
  }

  if (copied > 0) {
    setStatus(chalk.green('Copied Thu\u2192Fri (' + copied + ' row' + (copied !== 1 ? 's' : '') + ')'), 3000);
  } else {
    setStatus('Friday already matches Thursday.', 2000);
  }
  render();
}

async function doLeaveBalances() {
  if (isProcessing) return;
  isProcessing = true;
  startSpinner();
  setStatus('Loading leave balances...');
  render();

  try {
    const cp = await getClient();
    leaveData = await cp.getLeaveBalances();
    showLeave = true;
    setStatus(chalk.green('Leave balances loaded.'), 3000);
  } catch (e) {
    setStatus(chalk.red('Leave failed: ' + e.message), 5000);
  } finally {
    isProcessing = false;
    stopSpinner();
    render();
  }
}

// ─── Helpers ───────────────────────────────────────────────────

function getCellValue(row, col) {
  if (!data) return '';
  const project = data.projects[row];
  const day = data.dates[col].date;
  const key = project.line + '-' + day;

  if (pendingChanges.has(key)) {
    const h = pendingChanges.get(key).hours;
    return (h === 0 || h === '') ? '' : String(h);
  }

  const hours = project.hours[day];
  if (hours === null || hours === undefined || hours === '') return '';
  return String(hours);
}

function getCellComment(row, col) {
  if (!data) return '';
  const project = data.projects[row];
  const day = data.dates[col].date;
  const key = project.line + '-' + day;

  // Check pending comment changes first
  if (pendingChanges.has(key) && pendingChanges.get(key).comment !== undefined) {
    return pendingChanges.get(key).comment || '';
  }

  return (project.comments && project.comments[day]) || '';
}

function clampCursor() {
  if (!data || !data.projects || data.projects.length === 0) { cursorRow = 0; cursorCol = 0; return; }
  cursorRow = Math.min(cursorRow, data.projects.length - 1);
  cursorCol = Math.min(cursorCol, data.dates.length - 1);
}

function startSpinner() {
  spinnerFrame = 0;
  if (spinnerInterval) clearInterval(spinnerInterval);
  spinnerInterval = setInterval(() => { spinnerFrame = (spinnerFrame + 1) % SPINNER.length; render(); }, 100);
}

function stopSpinner() {
  if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }
}

// ─── Rendering ─────────────────────────────────────────────────

function render() {
  const W = process.stdout.columns || 80;
  const H = process.stdout.rows || 24;
  const lines = [];

  // ── Header ──
  const title = chalk.bold('Str8 Outta Deltek');
  let badges = '';
  if (data) {
    const meta = normalizeTimesheetStatus(data.timesheetStatusCode || data.timesheetStatus);
    const colors = {
      open: chalk.blue, signed: chalk.yellow, approved: chalk.green,
      rejected: chalk.red, processed: chalk.gray, missing: chalk.yellow, unknown: chalk.gray,
    };
    badges += (colors[meta.tone] || chalk.gray)('[' + meta.label + ']');
  }
  if (pendingChanges.size > 0) badges += ' ' + chalk.yellow(pendingChanges.size + ' unsaved');
  if (isProcessing) badges += ' ' + chalk.yellow(SPINNER[spinnerFrame]);
  badges += activeClient ? ' ' + chalk.green('\u25cf') : ' ' + chalk.gray('\u25cb');

  const gap = Math.max(1, W - strip(title).length - strip(badges).length);
  lines.push(title + ' '.repeat(gap) + badges);

  if (data && data.dates) {
    const s = data.dates[0], e = data.dates[data.dates.length - 1];
    let periodLine = chalk.dim('Period: ' + s.dayOfWeek + ' ' + s.fullDate + ' \u2014 ' + e.dayOfWeek + ' ' + e.fullDate);
    // Show comment for current cell if any
    if (data.projects && data.projects.length > 0 && !showLeave && mode !== 'prompt') {
      const curComment = getCellComment(cursorRow, cursorCol);
      if (curComment) {
        periodLine += '  ' + chalk.cyan('\u25b8 ' + curComment);
      }
    }
    lines.push(periodLine);
  } else {
    lines.push(chalk.dim('No data loaded.'));
  }
  lines.push('');

  if (showLeave && leaveData) {
    // ── Leave balances view ──
    lines.push(chalk.bold('Leave Balances'));
    lines.push('');

    if (leaveData.balances.length === 0) {
      lines.push(chalk.dim('  No leave balances found.'));
    } else {
      const typeW = leaveData.balances.reduce((m, b) => Math.max(m, b.description.length), 10);
      lines.push(chalk.dim(rpad('  Leave Type', typeW + 2) + '  ' + lpad('Balance', 10)));
      lines.push(chalk.dim('  ' + '\u2500'.repeat(typeW) + '  ' + '\u2500'.repeat(10)));
      for (const b of leaveData.balances) {
        const val = b.balance.toFixed(2);
        const color = b.balance > 0 ? chalk.green : b.balance < 0 ? chalk.red : chalk.dim;
        lines.push('  ' + rpad(b.description, typeW) + '  ' + color(lpad(val, 10)));
      }
    }

    if (leaveData.details.length > 0) {
      lines.push('');
      lines.push(chalk.bold('Recent Activity'));
      lines.push('');
      lines.push(chalk.dim('  ' + rpad('Date', 12) + rpad('Type', 10) + lpad('Hours', 8) + '  ' + 'Leave Type'));
      lines.push(chalk.dim('  ' + '\u2500'.repeat(12) + '\u2500'.repeat(10) + '\u2500'.repeat(8) + '  ' + '\u2500'.repeat(20)));
      for (const d of leaveData.details) {
        const hrs = d.hours.toFixed(2);
        const color = d.hours > 0 ? chalk.green : d.hours < 0 ? chalk.red : chalk.dim;
        lines.push('  ' + rpad(d.date, 12) + rpad(d.type, 10) + color(lpad(hrs, 8)) + '  ' + (d.leaveTypeDesc || d.leaveTypeCode));
      }
    }
  } else if (data && data.projects && data.dates) {
    // ── Timesheet table ──
    const nDays = data.dates.length;
    const fixed = 2 + 2 + 2 + 2 + 3 + 1 + nDays * 5 + 1 + 5;
    const avail = Math.max(16, W - fixed);
    const maxCode = data.projects.reduce((m, p) => Math.max(m, (p.code || '').length), 4);
    const codeW = Math.min(maxCode, Math.max(8, avail - 8));
    const descW = Math.min(30, Math.max(8, avail - codeW));

    // Header
    lines.push(chalk.dim(
      rpad('#', 2) + '  ' + rpad('Code', codeW) + '  ' + rpad('Description', descW) + '  ' +
      rpad('Pay', 3) + ' ' + data.dates.map(d => lpad(d.dayOfWeek.slice(0, 3), 4)).join(' ') +
      ' ' + lpad('Total', 5)
    ));
    lines.push(chalk.dim(
      '\u2500\u2500  ' + '\u2500'.repeat(codeW) + '  ' + '\u2500'.repeat(descW) + '  ' +
      '\u2500\u2500\u2500 ' + data.dates.map(() => '\u2500\u2500\u2500\u2500').join(' ') +
      ' \u2500\u2500\u2500\u2500\u2500'
    ));

    // Rows
    for (let r = 0; r < data.projects.length; r++) {
      const p = data.projects[r];
      let rowTotal = 0;

      const cells = data.dates.map((d, c) => {
        const val = getCellValue(r, c);
        const comment = getCellComment(r, c);
        rowTotal += parseFloat(val) || 0;
        const selected = r === cursorRow && c === cursorCol && mode !== 'prompt';
        const modified = pendingChanges.has(p.line + '-' + d.date);

        let txt;
        if (selected && mode === 'edit') {
          txt = lpad(editBuffer + '\u2588', 4);
        } else if (val && comment) {
          txt = lpad(val + chalk.cyan('*'), 4);
        } else if (comment) {
          txt = lpad(chalk.cyan('*'), 4);
        } else {
          txt = lpad(val || chalk.dim('\u00b7'), 4);
        }

        if (selected) return chalk.bgWhite.black(txt);
        if (modified) return chalk.yellow(txt);
        return txt;
      });

      const codeStr = rpad(trunc(p.code || '', codeW), codeW);
      lines.push(
        lpad(String(r), 2) + '  ' +
        (isCommentRequired(p.code) ? chalk.cyan(codeStr) : codeStr) + '  ' +
        rpad(trunc(p.description || '', descW), descW) + '  ' +
        rpad(p.payType || '', 3) + ' ' +
        cells.join(' ') + ' ' +
        lpad(rowTotal ? String(rowTotal) : '', 5)
      );
    }

    // Separator + totals
    lines.push(chalk.dim(
      '\u2500\u2500  ' + '\u2500'.repeat(codeW) + '  ' + '\u2500'.repeat(descW) + '  ' +
      '\u2500\u2500\u2500 ' + data.dates.map(() => '\u2500\u2500\u2500\u2500').join(' ') +
      ' \u2500\u2500\u2500\u2500\u2500'
    ));

    let grand = 0;
    const dailies = data.dates.map((d, c) => {
      let t = 0;
      for (let r = 0; r < data.projects.length; r++) t += parseFloat(getCellValue(r, c)) || 0;
      grand += t;
      return lpad(t ? String(t) : '', 4);
    });

    lines.push(
      '    ' + rpad('', codeW) + '  ' + rpad(chalk.bold('Daily Total'), descW) + '  ' +
      rpad('', 3) + ' ' + dailies.join(' ') + ' ' + chalk.bold(lpad(grand ? String(grand) : '0', 5))
    );
  }

  // ── Footer ──
  if (mode === 'menu') {
    const menuLines = [];
    menuLines.push(chalk.cyan.bold('Add Project:'));
    for (let i = 0; i < COMMON_CODES.length; i++) {
      const c = COMMON_CODES[i];
      const note = c.note ? chalk.dim('  (' + c.note + ')') : '';
      menuLines.push('  ' + chalk.yellow(String(i + 1)) + '  ' + c.label + chalk.dim(' — ' + c.code) + note);
    }
    menuLines.push('  ' + chalk.yellow('0') + '  Custom code...');
    menuLines.push(chalk.dim('Press number to select, Esc to cancel'));
    const footerHeight = menuLines.length + 1; // +1 for status line
    while (lines.length < H - footerHeight) lines.push('');
    lines.push(...menuLines);
  } else {
    while (lines.length < H - 3) lines.push('');
    lines.push('');
    if (mode === 'prompt') {
      lines.push(chalk.cyan(promptLabel + promptBuffer + '\u2588'));
    } else {
      if (showLeave) {
        lines.push(chalk.dim('[l]eave back  [r]efresh  [q]uit'));
      } else {
        lines.push(chalk.dim('[s]ave  [S]ign  [r]efresh  [a]dd  [C]omment  [c]opy Thu\u2192Fri  [l]eave  [q]uit'));
      }
    }
  }
  lines.push(statusMsg || chalk.dim('Ready' + (activeClient ? ' \u2022 session active' : '')));

  // ── Write ──
  process.stdout.write('\x1b[H' + lines.slice(0, H).map(l => l + '\x1b[K').join('\n') + '\x1b[J');
}

// String helpers
function strip(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }
function lpad(s, w) { const l = strip(String(s)).length; return l >= w ? String(s) : ' '.repeat(w - l) + s; }
function rpad(s, w) { const l = strip(String(s)).length; return l >= w ? String(s) : s + ' '.repeat(w - l); }
function trunc(s, w) { return s.length > w ? s.substring(0, w - 2) + '..' : s; }

// ─── Input handling ────────────────────────────────────────────

function handleKeypress(str, key) {
  if (!key) return;
  if (key.ctrl && key.name === 'c') { shutdown(); return; }
  if (isProcessing) return;

  if (mode === 'menu') return handleMenuKey(str, key);
  if (mode === 'prompt') return handlePromptKey(str, key);
  if (mode === 'edit') return handleEditKey(str, key);
  handleNavigateKey(str, key);
}

function handleNavigateKey(str, key) {
  if (showLeave) {
    if (str === 'l' || key.name === 'escape') { showLeave = false; render(); return; }
    if (str === 'r') { doLeaveBalances(); return; }
    if (str === 'q') { shutdown(); return; }
    return;
  }

  if (!data || !data.projects || data.projects.length === 0) {
    if (str === 'r') { fetchData(); return; }
    if (str === 'q') { shutdown(); return; }
    return;
  }

  const maxR = data.projects.length - 1;
  const maxC = data.dates.length - 1;

  switch (key.name) {
    case 'up':    cursorRow = Math.max(0, cursorRow - 1); break;
    case 'down':  cursorRow = Math.min(maxR, cursorRow + 1); break;
    case 'left':  cursorCol = Math.max(0, cursorCol - 1); break;
    case 'right': cursorCol = Math.min(maxC, cursorCol + 1); break;
    case 'tab':
      if (key.shift) {
        if (--cursorCol < 0) { cursorCol = maxC; cursorRow = Math.max(0, cursorRow - 1); }
      } else {
        if (++cursorCol > maxC) { cursorCol = 0; cursorRow = Math.min(maxR, cursorRow + 1); }
      }
      break;
    case 'return':
      mode = 'edit';
      editBuffer = getCellValue(cursorRow, cursorCol);
      break;
    case 'backspace':
    case 'delete':
      commitEdit('');
      break;
    default:
      if (str === 's' && !key.shift) { doSave(); return; }
      if (str === 'S' || (str === 's' && key.shift)) {
        if (pendingChanges.size > 0) {
          setStatus(chalk.yellow('Save changes before signing.'), 3000);
          render();
          return;
        }
        enterPrompt('Sign timesheet? [y/n] ', function(ans) {
          if (ans.toLowerCase() === 'y') doSign();
        });
        return;
      }
      if (str === 'r') { fetchData(); return; }
      if (str === 'a') {
        enterMenu();
        return;
      }
      if (str === 'C' || (str === 'c' && key.shift)) {
        // Edit comment on current cell
        if (!data || !data.projects || data.projects.length === 0) return;
        const currentComment = getCellComment(cursorRow, cursorCol);
        enterPrompt('Comment' + (currentComment ? ' [' + currentComment + ']' : '') + ': ', function(text) {
          commitComment(text);
          render();
        });
        return;
      }
      if (str === 'c' && !key.shift) { doCopyThuFri(); return; }
      if (str === 'l') {
        if (showLeave) { showLeave = false; render(); }
        else { doLeaveBalances(); }
        return;
      }
      if (str === 'q') {
        if (pendingChanges.size > 0) {
          enterPrompt('Unsaved changes. Quit? [y/n] ', function(ans) {
            if (ans.toLowerCase() === 'y') shutdown();
          });
          return;
        }
        shutdown();
        return;
      }
      if (str && /^[0-9.]$/.test(str)) {
        mode = 'edit';
        editBuffer = str;
        render();
        return;
      }
      break;
  }
  render();
}

function handleEditKey(str, key) {
  switch (key.name) {
    case 'return': {
      const editedRow = cursorRow;
      const editedCol = cursorCol;
      const editedVal = editBuffer;
      commitEdit(editBuffer);
      mode = 'navigate';
      if (data && cursorCol < data.dates.length - 1) cursorCol++;
      // Auto-prompt for comment on suspense rows
      if (editedVal !== '' && data && data.projects[editedRow]) {
        const proj = data.projects[editedRow];
        if (isCommentRequired(proj.code) && !getCellComment(editedRow, editedCol)) {
          render();
          enterPrompt('Comment (required for ' + proj.code + '): ', function(text) {
            if (text) {
              // Temporarily set cursor back to apply comment to correct cell
              const savedRow = cursorRow, savedCol = cursorCol;
              cursorRow = editedRow;
              cursorCol = editedCol;
              commitComment(text);
              cursorRow = savedRow;
              cursorCol = savedCol;
            }
            render();
          });
          return;
        }
      }
      break;
    }
    case 'escape':
      mode = 'navigate';
      editBuffer = '';
      break;
    case 'backspace':
      editBuffer = editBuffer.slice(0, -1);
      break;
    default:
      if (str && /^[0-9.]$/.test(str)) editBuffer += str;
      break;
  }
  render();
}

function commitEdit(value) {
  if (!data) return;
  const project = data.projects[cursorRow];
  const day = data.dates[cursorCol].date;
  const key = project.line + '-' + day;
  const hours = value === '' ? 0 : parseFloat(value);

  const orig = project.hours[day];
  const origStr = (orig === null || orig === undefined || orig === '') ? '' : String(orig).replace(/\*$/, '');
  const newStr = value === '' ? '' : String(hours);

  if (newStr === origStr || (origStr === '' && hours === 0)) {
    pendingChanges.delete(key);
  } else {
    pendingChanges.set(key, { line: project.line, day, hours });
  }
}

function commitComment(text) {
  if (!data) return;
  const project = data.projects[cursorRow];
  const day = data.dates[cursorCol].date;
  const key = project.line + '-' + day;

  const existing = pendingChanges.get(key);
  if (existing) {
    // Merge comment into existing hours change
    existing.comment = text || undefined;
  } else {
    // Comment-only change — use current hours
    const currentVal = getCellValue(cursorRow, cursorCol);
    const hours = currentVal === '' ? 0 : parseFloat(currentVal);
    pendingChanges.set(key, { line: project.line, day, hours, comment: text || undefined });
  }

  // Update cached data so the indicator shows immediately
  if (project.comments) {
    project.comments[day] = text || null;
  }
}

function enterMenu() {
  mode = 'menu';
  menuItems = COMMON_CODES;
  render();
}

function handleMenuKey(str, key) {
  if (key.name === 'escape') {
    mode = 'navigate';
    menuItems = null;
    render();
    return;
  }
  // '0' or 'c' = custom entry
  if (str === '0' || str === 'c') {
    mode = 'navigate';
    menuItems = null;
    enterPrompt('Project code: ', function(code) {
      if (!code.trim()) return;
      enterPrompt('Pay type [REG]: ', function(pt) {
        doAddProject(code.trim(), pt.trim() || 'REG');
      });
    });
    return;
  }
  // Digit 1-N selects a common code
  const n = parseInt(str, 10);
  if (n >= 1 && n <= COMMON_CODES.length) {
    const pick = COMMON_CODES[n - 1];
    mode = 'navigate';
    menuItems = null;
    doAddProject(pick.code, pick.payType);
    return;
  }
}

function enterPrompt(label, callback) {
  mode = 'prompt';
  promptLabel = label;
  promptBuffer = '';
  promptCallback = callback;
  render();
}

function handlePromptKey(str, key) {
  switch (key.name) {
    case 'return': {
      mode = 'navigate';
      const cb = promptCallback;
      const val = promptBuffer;
      promptCallback = null;
      promptBuffer = '';
      promptLabel = '';
      render();
      if (cb) cb(val);
      break;
    }
    case 'escape':
      mode = 'navigate';
      promptCallback = null;
      promptBuffer = '';
      promptLabel = '';
      render();
      break;
    case 'backspace':
      promptBuffer = promptBuffer.slice(0, -1);
      render();
      break;
    default:
      if (str && str.length === 1) { promptBuffer += str; render(); }
      break;
  }
}

// ─── Lifecycle ─────────────────────────────────────────────────

async function shutdown() {
  stopSpinner();
  try { await releaseClient(); } catch (e) { /* ignore */ }
  process.stdout.write('\x1b[?25h');   // show cursor
  process.stdout.write('\x1b[?1049l'); // restore screen
  process.exit(0);
}

function main() {
  process.stdout.write('\x1b[?1049h'); // alternate screen
  process.stdout.write('\x1b[?25l');   // hide cursor

  process.stdin.setRawMode(true);
  process.stdin.resume();
  readline.emitKeypressEvents(process.stdin);
  process.stdin.on('keypress', handleKeypress);

  process.stdout.on('resize', render);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  loadCache();
  data = getActiveWeekData();
  render();
  fetchData();
}

main();
