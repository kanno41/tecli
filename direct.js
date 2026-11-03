'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const moment = require('moment');
const Table = require('cli-table');
const protocol = require('./protocol');
const { normalizeTimesheetStatus } = require('./timesheet-status');
const { DAY_COLUMN_WIDTH } = require('./hours');

const debug = process.env.DEBUG ? (...args) => console.error(...args) : () => {};

// Opt-in servlet trace: with COSTPOINT_TRACE set, every servlet
// request/response is appended as a JSON line. 1/on/true writes
// ~/.tecli-trace.jsonl, any other value is the file path, and unset, empty or
// 0/off/false trace nothing. Read per request. The bodies carry the session
// id, so the file is owner-only. Past TRACE_MAX_BYTES it moves to <file>.1.
const TRACE_MAX_BYTES = 10 * 1024 * 1024;

function tracePath() {
  const env = (process.env.COSTPOINT_TRACE || '').trim();
  const flag = env.toLowerCase();
  if (['', '0', 'off', 'false'].includes(flag)) return null;
  if (['1', 'on', 'true'].includes(flag)) return path.join(os.homedir(), '.tecli-trace.jsonl');
  return env;
}

function trace(entry) {
  const file = tracePath();
  if (!file) return;
  try {
    if (fs.statSync(file).size >= TRACE_MAX_BYTES) fs.renameSync(file, file + '.1');
  } catch (e) {
    /* no file yet */
  }
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
}

const APP_ID = 'TMMTIMESHEET';
const NUM_DAYS = 7;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Parent (K0) columns the client reads, by maObjId name. Costpoint inserts
// columns between releases (the 10/2026 update moved ENABLE_SIGN_FL 573 -> 575
// and TS_CLOSED_FL 685 -> 689), so indices are resolved from the OPEN_RS name
// list at launch (resolveParentColumns) rather than hard-coded.
const PARENT_COL_NAMES = {
  EMPL_FULL_NAME: 'EMPL_FULL_NAME',
  EMPL_ID: 'EMPL_ID',
  SCHEDULE_DESC: 'SCHEDULE_DESC_AND_P_TEXT',
  END_DT: 'END_DT',
  S_STATUS_CD: 'S_STATUS_CD',
  // Column the browser sets to 'S' when signing (captured/sign-capture/017+018)
  ACTION_CD: 'ACTION_CD',
  ENABLE_SIGN_FL: 'ENABLE_SIGN_FL',
  ENABLE_CORRECT_FL: 'ENABLE_CORRECT_FL',
  // 'Y' on a processed (closed) period; edits require TMMTS_CORRECT_TIMESHEET
  TS_CLOSED_FL: 'TS_CLOSED_FL',
};

// Layout of the 688-column captures. Only test stubs built without a launch
// set it (DirectClient.CAPTURE_PARENT_COL); a real client resolves by name.
const PARENT_COL = {
  EMPL_FULL_NAME: 0,
  EMPL_ID: 1,
  SCHEDULE_DESC: 2,
  END_DT: 3,
  S_STATUS_CD: 4,
  ACTION_CD: 23,
  ENABLE_SIGN_FL: 573,
  ENABLE_CORRECT_FL: 676,
  TS_CLOSED_FL: 685,
};

/**
 * Map a { key: name | [names] } spec to indices in an OPEN_RS maObjId name
 * list. Throws when a name is missing or repeated, or when the list does not
 * match the row width, so a layout change fails loudly instead of reading or
 * writing the wrong columns.
 */
function resolveColumns(kind, spec, names, rowWidth) {
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error('Costpoint sent no ' + kind + ' column names; cannot locate timesheet columns');
  }
  if (rowWidth !== undefined && names.length !== rowWidth) {
    throw new Error(
      kind[0].toUpperCase() +
        kind.slice(1) +
        ' column names (' +
        names.length +
        ') do not match the row width (' +
        rowWidth +
        '); the Costpoint layout changed'
    );
  }
  const indexOf = name => {
    const idx = names.indexOf(name);
    if (idx < 0 || names.indexOf(name, idx + 1) >= 0) {
      throw new Error(
        kind[0].toUpperCase() +
          kind.slice(1) +
          ' column ' +
          name +
          (idx < 0 ? ' not found' : ' is not unique') +
          ' in the Costpoint layout'
      );
    }
    return idx;
  };
  const cols = {};
  for (const [key, name] of Object.entries(spec)) {
    cols[key] = Array.isArray(name) ? name.map(indexOf) : indexOf(name);
  }
  return cols;
}

const resolveParentColumns = (names, rowWidth) => resolveColumns('parent', PARENT_COL_NAMES, names, rowWidth);

// Child (K1) columns, by maObjId name. The 10/2026 update inserted
// REVERSED_FROM_LN_NO at 244 (402 -> 403 columns), so like the parent these
// are resolved from the OPEN_RS name list at launch (resolveChildColumns).
const CHILD_COL_NAMES = {
  LINE_DESC: 'LINE_DESC',
  UDT02_ID: 'UDT02_ID',
  // Work location zip (captured/work-location/)
  WORK_LOCATION: 'UDT03_ID',
  PAY_TYPE: 'UDT10_ID',
  DAYS: ['DAY1_HRS', 'DAY2_HRS', 'DAY3_HRS', 'DAY4_HRS', 'DAY5_HRS', 'DAY6_HRS', 'DAY7_HRS'],
  COMMENTS: [
    'COMMENT___DAY1_HRS',
    'COMMENT___DAY2_HRS',
    'COMMENT___DAY3_HRS',
    'COMMENT___DAY4_HRS',
    'COMMENT___DAY5_HRS',
    'COMMENT___DAY6_HRS',
    'COMMENT___DAY7_HRS',
  ],
  // Copied from an existing line when staging a new one
  TEMPLATE: [
    'S_APPROVE_STATUS_CD',
    'COST_FL',
    'COUNT_ROW',
    'EMPL_ID',
    'HRS_INCREMENT_CD',
    'HRS_MODIFY_FL',
    'IS_PROCESSED_FL',
    'OT_FL',
    'PERIOD_NO_CD',
    'TS_SCHEDULE_CD',
    'YEAR_NO_CD',
  ],
  TS_SCHEDULE_CD: 'TS_SCHEDULE_CD',
  YEAR_NO_CD: 'YEAR_NO_CD',
  DISPLAY_LINE_NO: 'DISPLAY_LINE_NO',
  LINE_NO: 'LINE_NO',
  IS_AMBIGUOUS_LKP: 'IS_AMBIGUOUS_LKP',
  UDT_FROM_LKP_FL: 'UDT_FROM_LKP_FL',
  // Charge fields the browser copies from the selected K2 lookup row
  CHARGE_PROJECT: 'CHARGE_BRANCH_CD_U2_CHG_LKUP',
  CHARGE_COMBINED: 'CHARGE_CD_U2_CHG_LKUP',
  CHARGE_FLAG: 'CHARGE_TREE_CD_U2_CHG_LKUP',
  CHARGE_PAY_TYPE: 'UDT10_ID_U2_CHG_LKUP',
  CHARGE_PROJECT_ID: 'UDT02_DISPLAY',
};

// Layout of the 402-column captures, for test stubs only (CAPTURE_CHILD_COL)
const CHILD_COL = {
  LINE_DESC: 2,
  UDT02_ID: 6,
  WORK_LOCATION: 8,
  PAY_TYPE: 16,
  DAYS: [26, 27, 28, 29, 30, 31, 32],
  COMMENTS: [124, 135, 143, 144, 145, 146, 147],
  TEMPLATE: [0, 150, 151, 187, 193, 194, 197, 234, 235, 336, 398],
  TS_SCHEDULE_CD: 336,
  YEAR_NO_CD: 398,
  DISPLAY_LINE_NO: 1,
  LINE_NO: 198,
  IS_AMBIGUOUS_LKP: 196,
  UDT_FROM_LKP_FL: 393,
  CHARGE_PROJECT: 104,
  CHARGE_COMBINED: 108,
  CHARGE_FLAG: 112,
  CHARGE_PAY_TYPE: 376,
  CHARGE_PROJECT_ID: 400,
};

const resolveChildColumns = (names, rowWidth) => resolveColumns('child', CHILD_COL_NAMES, names, rowWidth);

// Revision explanation column indices (K2 = TMMTS_TS_REVISION_EXP)
const REV_COL = {
  EXPLANATION: 0,
  REVISION_NO: 1,
  CANCELLED_CD: 4,
  EMPL_ID: 5,
  PERIOD_NO_CD: 6,
  TS_SCHEDULE_CD: 7,
  YEAR: 8,
  TOTAL_COLS: 9,
};
// Audit column indices (K3 = TMMTS_TS_AUDIT_EXP)
const AUDIT_COL = { REVISION_NO: 0, LINE_NO: 1, DATE: 2, PROJECT: 3, ACCOUNT: 5, CHARGE_DESC: 6, DETAIL: 7 };

// Every Costpoint HTTP request must finish within COSTPOINT_TIMEOUT_MS
// (milliseconds, default 60 s; read per request) and its response stay under
// MAX_RESPONSE_BYTES. The largest captured response is under 300 KB.
const DEFAULT_TIMEOUT_MS = 60 * 1000;
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

function requestTimeoutMs() {
  const ms = parseInt(process.env.COSTPOINT_TIMEOUT_MS || '', 10);
  return ms > 0 ? ms : DEFAULT_TIMEOUT_MS;
}

/**
 * Thrown when Costpoint does not answer in time. The request may still have
 * been applied (a save or a sign), so it is not a session error and is
 * never retried.
 */
class RequestTimeoutError extends Error {
  constructor(timeoutMs) {
    super('Costpoint request timed out after ' + timeoutMs / 1000 + ' s');
    this.name = 'RequestTimeoutError';
    this.code = 'ETIMEDOUT';
  }
}

class ResponseTooLargeError extends Error {
  constructor() {
    super('Costpoint response exceeded ' + MAX_RESPONSE_BYTES / (1024 * 1024) + ' MB');
    this.name = 'ResponseTooLargeError';
  }
}

// Short plain-text excerpt of a response for an error message: scripts and
// tags dropped (a login page can carry the sid), whitespace collapsed. Login
// errors reach the web UI's /api/status.
function responseExcerpt(body, max = 200) {
  const text = String(body)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? text.substring(0, max) + '...' : text;
}

/**
 * Thrown when MasterServlet answers with its onServletException page instead
 * of a response document: the sid is gone (mock: "Session not valid") or the
 * server failed the request. The only servlet failure treated as a lost
 * session; business errors come back inside a response document.
 */
class SessionExpiredError extends Error {
  constructor(responseText = '') {
    super('Costpoint session is not valid: ' + responseText.substring(0, 200));
    this.name = 'SessionExpiredError';
  }
}

/**
 * Thrown when a save was sent but its reply is not a response document (live
 * Costpoint once answered a committed save with an HTML page, tecli-dw7). The
 * save may have landed, so it is not a session error and must not be resent
 * before the week is read again.
 */
class SaveOutcomeUnknownError extends Error {
  constructor(cause) {
    super(
      'Save outcome unknown: Costpoint did not answer with a readable reply, so the save may or may not have landed. Do not retry; read the week again first. (' +
        cause.message +
        ')'
    );
    this.name = 'SaveOutcomeUnknownError';
    this.cause = cause;
  }
}

// Parse the reply to a sent save; an unreadable one leaves the outcome unknown
function parseSaveResponse(respText) {
  try {
    return protocol.parseResponse(respText);
  } catch (e) {
    throw new SaveOutcomeUnknownError(e);
  }
}

// Commands that may change what Costpoint has stored: 206 save, 209 discard,
// 300 action (sign, Correct, new line, add to favorites)
const WRITE_COMMAND = /^(206|209|300)A/;

/**
 * Thrown when a save attempt requires a revision explanation.
 * The auditDetails array describes what changed.
 */
class RevisionRequiredError extends Error {
  constructor(auditDetails) {
    super('Revision explanation required');
    this.name = 'RevisionRequiredError';
    this.auditDetails = auditDetails || [];
  }
}

class DirectClient {
  constructor() {
    this.baseUrl = '';
    this.sid = '';
    this.cookieJar = {}; // domain → { name → value }
    this.parentData = null;
    this.childData = null;
    // Parent (K0) row the client edits: 0 = active week, 1 = previous week.
    // Sent as X on K1 commands and as the K0 cursor C.
    this.periodIdx = 0;
    // Requests sent that may have committed something (WRITE_COMMAND),
    // counted before sending: a lost response does not mean nothing landed
    this.writesSent = 0;
    this.lastPutId = 0;
    this._actionSeq = 0;
    this.dates = null;
    this.table = null;
    this.timesheetStatus = 'Unknown';
    this.timesheetStatusCode = '';
    // Keep-alive agents for connection reuse (like a browser)
    this._httpAgent = new http.Agent({ keepAlive: true });
    this._httpsAgent = new https.Agent({ keepAlive: true });
  }

  /** Parent column indices, resolved at launch. */
  get parentCol() {
    if (!this._parentCol) throw new Error('Parent columns are not resolved; launch() first');
    return this._parentCol;
  }

  set parentCol(cols) {
    this._parentCol = cols;
  }

  /** Child column indices, resolved at launch. */
  get childCol() {
    if (!this._childCol) throw new Error('Child columns are not resolved; launch() first');
    return this._childCol;
  }

  set childCol(cols) {
    this._childCol = cols;
  }

  /**
   * Get the cookie jar for a specific hostname (creates if needed).
   */
  _cookiesForHost(hostname) {
    if (!this.cookieJar[hostname]) this.cookieJar[hostname] = {};
    return this.cookieJar[hostname];
  }

  /**
   * Build Cookie header string for a given hostname and request path.
   * Only sends cookies whose path is a prefix of the request path (RFC 6265).
   */
  _cookieHeader(hostname, requestPath) {
    const jar = this.cookieJar[hostname];
    if (!jar) return '';
    const path = requestPath || '/';
    return Object.entries(jar)
      .filter(([, entry]) => {
        // Support both old format (string value) and new format ({ value, path })
        if (typeof entry === 'string') return true;
        return path.startsWith(entry.path);
      })
      .map(([k, entry]) => k + '=' + (typeof entry === 'string' ? entry : entry.value))
      .join('; ');
  }

  /**
   * Track Set-Cookie headers from a response for the given hostname and path.
   * Stores cookies with their path scope for proper path-matching on requests.
   * Handles cookie deletion via Expires in the past (RFC 6265).
   */
  _trackCookies(hostname, setCookieHeaders, requestPath) {
    if (!setCookieHeaders) return;
    const jar = this._cookiesForHost(hostname);
    // Default path per RFC 6265: directory of the request URL
    const defaultPath = requestPath ? requestPath.replace(/\/[^/]*$/, '') || '/' : '/';
    for (const sc of setCookieHeaders) {
      const match = sc.match(/^([^=]+)=([^;]*)/);
      if (match) {
        const name = match[1];
        const value = match[2];
        // Check for cookie deletion (RFC 6265: Max-Age=0 or Expires in the past).
        // Max-Age takes precedence over Expires per spec — important when client
        // clock is skewed relative to the server.
        const maxAgeMatch = sc.match(/;\s*Max-Age=(\d+)/i);
        if (maxAgeMatch) {
          if (maxAgeMatch[1] === '0') {
            delete jar[name];
            continue;
          }
          // Max-Age > 0 — cookie is valid, skip Expires check
        } else {
          const expiresMatch = sc.match(/;\s*Expires=([^;]+)/i);
          if (expiresMatch) {
            const expiresDate = new Date(expiresMatch[1]);
            if (expiresDate.getTime() < Date.now()) {
              delete jar[name];
              continue;
            }
          }
        }
        // Extract explicit Path from Set-Cookie
        const pathMatch = sc.match(/;\s*Path=([^;]*)/i);
        const cookiePath = pathMatch ? pathMatch[1] : defaultPath;
        jar[name] = { value, path: cookiePath };
      }
    }
  }

  static async launch(url, username, password, opts) {
    const client = new DirectClient();
    await client._init(url, username, password, opts);
    return client;
  }

  display() {
    console.log(this.table.toString());
  }

  getData() {
    const statusMeta = this._getTimesheetStatusMeta();
    const ppWeek = this.getPayPeriodWeek();
    return {
      timesheetStatus: statusMeta.label,
      timesheetStatusCode: statusMeta.code,
      editable: this._isRowEditable(this.parentData.rows[this.periodIdx]),
      payPeriodWeek: ppWeek.week,
      payPeriodWeekCount: ppWeek.of,
      dates: this.dates.map(d => ({
        date: d.date(),
        fullDate: d.format('YYYY-MM-DD'),
        dayOfWeek: d.format('ddd'),
      })),
      projects: this.table.map((row, idx) => ({
        line: row[0],
        code: row[1],
        description: row[2],
        payType: row[3],
        hours: Object.fromEntries(
          this.dates.map((d, i) => {
            const v = row[i + 4];
            return [d.date(), v === '' ? null : parseFloat(v)];
          })
        ),
        comments: Object.fromEntries(
          this.dates.map((d, i) => {
            const c = this.childData.rows[idx] ? this.childData.rows[idx][this.childCol.COMMENTS[i]] || '' : '';
            return [d.date(), c || null];
          })
        ),
      })),
    };
  }

  /**
   * Get the END_DT values for all parent rows (all available periods).
   * Useful for finding the other week of a biweekly pay period.
   */
  getAvailablePeriods() {
    if (!this.parentData || !this.parentData.rows) return [];
    return this.parentData.rows.map((row, i) => ({
      index: i,
      endDate: row[this.parentCol.END_DT],
      scheduleDesc: row[this.parentCol.SCHEDULE_DESC],
    }));
  }

  /**
   * Periods this session can reach with selectPeriod(), newest first:
   * [{ idx, endDate, statusCode, editable }]. The K0 list is loaded 20 rows at
   * a time and not paged, so this stops there (about 20 weeks back). editable
   * is null for rows the server returned without their detail columns (every
   * row except the one the K0 cursor sits on).
   */
  getPeriods() {
    if (!this.parentData || !this.parentData.rows) return [];
    return this.parentData.rows.map((row, idx) => ({
      idx,
      endDate: row[this.parentCol.END_DT],
      statusCode: normalizeTimesheetStatus(row[this.parentCol.S_STATUS_CD] || '').code,
      editable: row[this.parentCol.TS_CLOSED_FL] ? this._isRowEditable(row) : null,
    }));
  }

  /**
   * Parse "Wk N of M" from the schedule description field.
   * Returns { week: N, of: M } or { week: null, of: null } if not found.
   */
  getPayPeriodWeek() {
    const parentRow = this.parentData && this.parentData.rows && this.parentData.rows[this.periodIdx];
    const desc = parentRow ? parentRow[this.parentCol.SCHEDULE_DESC] : '';
    const match = desc && desc.match(/Wk\s+(\d+)\s+of\s+(\d+)/i);
    if (match) {
      return { week: parseInt(match[1], 10), of: parseInt(match[2], 10) };
    }
    return { week: null, of: null };
  }

  _getTimesheetStatusMeta() {
    const parentRow = this.parentData && this.parentData.rows && this.parentData.rows[this.periodIdx];
    const rawStatus = parentRow ? parentRow[this.parentCol.S_STATUS_CD] : '';
    return normalizeTimesheetStatus(rawStatus);
  }

  /**
   * Get previous period data without mutating client state.
   * Returns data in the same format as getData(), or null if unavailable.
   */
  getPreviousPeriodData() {
    if (!this.prevChildData || !this.parentData || this.parentData.rows.length < 2) {
      return null;
    }

    // Full row from the init fetch; parentData.rows[1] lacks the flags
    const parentRow = this._prevParentRow || this.parentData.rows[1];
    const endDate = moment(parentRow[this.parentCol.END_DT]);
    if (!endDate.isValid()) return null;

    const startDate = endDate.clone().subtract(NUM_DAYS - 1, 'days');
    const dates = [];
    for (let i = 0; i < NUM_DAYS; i++) {
      dates.push(startDate.clone().add(i, 'days'));
    }

    const statusMeta = normalizeTimesheetStatus(parentRow[this.parentCol.S_STATUS_CD] || '');

    const projects = [];
    for (let i = 0; i < this.prevChildData.rows.length; i++) {
      const row = this.prevChildData.rows[i];
      const code = row[this.childCol.UDT02_ID] || '';
      const desc = row[this.childCol.LINE_DESC] || '';
      const payType = row[this.childCol.PAY_TYPE] || '';
      const hours = {};
      const comments = {};
      for (let d = 1; d <= NUM_DAYS; d++) {
        const val = row[this.childCol.DAYS[d - 1]];
        const comment = row[this.childCol.COMMENTS[d - 1]] || '';
        hours[dates[d - 1].date()] = val ? parseFloat(val) : null;
        comments[dates[d - 1].date()] = comment || null;
      }
      projects.push({
        line: i,
        code,
        description: desc,
        payType,
        hours,
        comments,
      });
    }

    return {
      timesheetStatus: statusMeta.label,
      timesheetStatusCode: statusMeta.code,
      editable: this._isRowEditable(parentRow),
      dates: dates.map(d => ({
        date: d.date(),
        fullDate: d.format('YYYY-MM-DD'),
        dayOfWeek: d.format('ddd'),
      })),
      projects,
    };
  }

  async set(line, day, hours, comment) {
    const dayIdx = this.dates.findIndex(d => d.date() === day);
    if (dayIdx < 0) {
      throw new Error('Day ' + day + ' is not in this week (' + this.dates.map(d => d.date()).join(', ') + ')');
    }
    if (!this.childData.rows[line]) {
      throw new Error('No line ' + line + ' on this timesheet');
    }
    if (this._isPeriodClosed()) await this._correctTimesheet();

    const dayNum = dayIdx + 1;
    const dayCol = this.childCol.DAYS[dayNum - 1];
    const rowNum = parseInt(this.childData.rowNums[line], 10);

    // Update local child data
    this.childData.rows[line][dayCol] = String(hours);

    // Set comment if provided
    if (comment !== undefined && comment !== null) {
      this.childData.rows[line][this.childCol.COMMENTS[dayNum - 1]] = comment;
    }

    // Send cell edit batch (205+208+204s+507)
    const body = this._buildCellEditBatch(line, rowNum, dayNum);
    const respText = await this._postServlet(body);
    const parsed = protocol.parseResponse(respText);

    const err = protocol.checkErrors(parsed);
    if (err) throw new Error('Cell edit error: ' + err);

    // Merge K1 204 response (single edited row) into local data
    const k1Data = protocol.extract204(parsed, 1);
    if (k1Data && k1Data.rows.length > 0) {
      const respRowNum = k1Data.rowNums[0];
      const idx = this.childData.rowNums.indexOf(respRowNum);
      if (idx >= 0) {
        this.childData.rows[idx] = k1Data.rows[0];
      }
    }

    this._buildTableRows();
  }

  async setm(changes) {
    for (const { line, day, hours, comment } of changes) {
      await this.set(line, day, hours, comment);
    }
  }

  /**
   * workLocation may be a zip string or an async (pendingLine) => zip|undefined
   * called once the server has filled its defaults.
   */
  async add(code, payType, { workLocation } = {}) {
    if (this._isPeriodClosed()) await this._correctTimesheet();
    debug(
      'Adding project code: ' +
        code +
        (payType ? ' (payType=' + payType + ')' : '') +
        (workLocation ? ' (workLocation=' + workLocation + ')' : '')
    );

    // Reuse an existing pending line (e.g. from getFavorites) if present; otherwise
    // create one and register it with TMMTS_NEW_TS_LINE.
    const alreadyPending = this.childData.rowNums.some(n => parseInt(n, 10) < 0);
    if (!alreadyPending) {
      this._stagePendingLine();
      await this._newTimesheetLine();
    }

    // Step 2: Set the project code and validate it.
    // Find the new row (may have been replaced by server response).
    const newRowIdx = this.childData.rowNums.findIndex(n => parseInt(n, 10) < 0);
    this.childData.rows[newRowIdx][this.childCol.UDT02_ID] = code;
    await this._validateUdt02();

    // Step 3: Resolve charge via server-side lookup.
    await this._resolveChargeOnServer(code, payType);

    // Step 4: Post-charge validate — tells the server the charge is accepted.
    // Without this, the server's session state doesn't have the Account field
    // committed, causing "Account required" on save.
    await this._validateUdt02();

    // Step 5: Override the server-default work location (browser: PUT col 8 + 208 UDT03_ID).
    if (typeof workLocation === 'function') workLocation = await workLocation(this.pendingLine());
    if (workLocation) {
      const idx = this.childData.rowNums.findIndex(n => parseInt(n, 10) < 0);
      this.childData.rows[idx][this.childCol.WORK_LOCATION] = workLocation;
      await this._validateObject('UDT03_ID');
    }

    this._buildTableRows();
  }

  /**
   * Server-chosen defaults on the pending (unsaved) line, or null if none.
   */
  pendingLine() {
    const idx = this.childData.rowNums.findIndex(n => parseInt(n, 10) < 0);
    if (idx < 0) return null;
    const row = this.childData.rows[idx];
    return { payType: row[this.childCol.PAY_TYPE] || '', workLocation: row[this.childCol.WORK_LOCATION] || '' };
  }

  /**
   * Fetch the user's charge favorites from Costpoint.
   *
   * Reuses the TC_UDT02_CHARGE_LKP result set with an HLKP query that
   * targets the server-side "favorites" level (LVL=2, ROW=0) instead of
   * the per-code lookup (LVL=1, ROW=-2) used by _buildHlkpQuery.
   *
   * Returns an array of { code, description, payType } entries.
   */
  /**
   * Stage a new child row locally at rowNum -59999 with template defaults
   * copied from an existing row. Matches what the browser does before
   * sending TMMTS_NEW_TS_LINE.
   */
  _stagePendingLine() {
    if (this.childData.rows.length === 0) {
      throw new Error('Cannot add a project to a week with no existing lines');
    }
    const numCols = this.childData.rows[0].length;
    const newRow = new Array(numCols).fill('');

    const col = this.childCol;
    const templateRow = this.childData.rows[0];
    for (const ci of col.TEMPLATE) {
      if (ci < templateRow.length && templateRow[ci]) newRow[ci] = templateRow[ci];
    }
    const nextSeq = String(this.childData.rows.length + 1);
    newRow[col.DISPLAY_LINE_NO] = nextSeq;
    newRow[col.LINE_NO] = nextSeq;
    newRow[col.IS_AMBIGUOUS_LKP] = 'N';
    newRow[col.UDT_FROM_LKP_FL] = 'N';

    this.childData.rows.push(newRow);
    this.childData.rowNums.push('-59999');
    if (this.childData.rowFlags) this.childData.rowFlags.push('19');
  }

  /**
   * Favorites belong to the user, so listing them does not correct a closed
   * week. The lookup needs a pending line, and live Costpoint refuses to
   * delete a line with no charge (CMD 209, tecli-4c4), so a plain listing
   * leaves the session unable to save: list on a throwaway session
   * (listFavorites() in session.js). keepLine corrects a closed week and keeps
   * the line for an add() that follows.
   */
  async getFavorites({ keepLine = false } = {}) {
    if (keepLine && this._isPeriodClosed()) await this._correctTimesheet();
    // Favorites require a pending row at -59999 — the lookup is scoped to it
    // via HLKP's X=-59999. Matches the browser flow: user clicks "add row"
    // before the magnifier is clickable.
    const hasPending = this.childData.rowNums.some(n => parseInt(n, 10) < 0);
    if (!hasPending) {
      this._stagePendingLine();
      await this._newTimesheetLine();
    }
    return this._queryFavorites();
  }

  async _queryFavorites() {
    // Bare OPEN_RS K2 (no PUT K1) — matches the browser's magnifier click.
    const openResp = await this._postServlet(this._buildOpenFavoritesLookup());
    const openErr = protocol.checkErrors(protocol.parseResponse(openResp));
    if (openErr) throw new Error('Favorites open error: ' + openErr);

    // Categories-view primer (LVL=1 ROW=-1, no code filter). This is what the
    // browser sends immediately after OPEN_RS when the lookup dialog first
    // opens. Without this, the favorites HLKP (LVL=2) returns <NO DATA>.
    await this._postServlet(this._buildCategoriesLookup());

    const queryResp = await this._postServlet(this._buildFavoritesQuery());
    const queryParsed = protocol.parseResponse(queryResp);
    const queryErr = protocol.checkErrors(queryParsed);
    if (queryErr) throw new Error('Favorites query error: ' + queryErr);

    const k2Data = protocol.extract204(queryParsed, 2);
    if (!k2Data || k2Data.rows.length === 0) return [];

    const seen = new Set();
    const favorites = [];
    for (const row of k2Data.rows) {
      const code = row[5] || '';
      if (!code) continue;
      const payType = row[15] || '';
      const key = code + '|' + payType;
      if (seen.has(key)) continue;
      seen.add(key);
      favorites.push({
        code,
        description: row[0] || '',
        payType,
      });
    }
    return favorites;
  }

  /**
   * Add a project by index into the favorites list. Convenience wrapper:
   * fetches favorites, picks by index, delegates to add().
   */
  async addFromFavorite(index) {
    const favs = await this.getFavorites({ keepLine: true });
    if (!favs.length) throw new Error('No favorites available');
    if (index < 0 || index >= favs.length) {
      throw new Error('Favorite index ' + index + ' out of range (0-' + (favs.length - 1) + ')');
    }
    const fav = favs[index];
    await this.add(fav.code, fav.payType || undefined);
    return fav;
  }

  /**
   * Validate the UDT02_ID field on a new row, populating server defaults.
   * Sends 205 PUT + 208 VALIDATE for the object and updates local data.
   */
  async _validateUdt02() {
    await this._validateObject('UDT02_ID');
  }

  async _validateObject(objectId) {
    const newRowIdx = this.childData.rowNums.findIndex(n => parseInt(n, 10) < 0);
    const newRow = this.childData.rows[newRowIdx];
    const rowNum = this.childData.rowNums[newRowIdx];
    const encodedRow = protocol.encodePutRow(newRow);
    const period = String(this.periodIdx);

    const cmds = [
      // 205 PUT K1
      this._wrap(
        this._cmd(205, [
          { code: 'X', value: period },
          { code: 'K', value: '1' },
          { code: 'C', value: rowNum },
          { code: 'P', value: '0' },
          { code: 'V', value: 'true' },
          { name: 'lastPutId', value: String(this.lastPutId++) },
        ]),
        {
          data: encodedRow + protocol.DLM_ROW,
          editFlag: '19,',
          rowNumber: rowNum + ',',
        }
      ),
      // 205 PUT K1 context
      this._wrap(
        this._cmd(205, [
          { code: 'X', value: period },
          { name: 'rsContextOnly', value: 'Y' },
          { code: 'K', value: '1' },
          { code: 'C', value: rowNum },
          { code: 'P', value: '0' },
          { code: 'V', value: 'true' },
          { name: 'lastPutId', value: String(this.lastPutId++) },
        ]),
        {
          data: encodedRow + protocol.DLM_ROW,
          editFlag: '19,',
          rowNumber: rowNum + ',',
        }
      ),
      // 208 VALIDATE
      this._wrap(
        this._cmd(208, [
          { name: 'objectId', value: objectId },
          { code: 'K', value: '1' },
          { code: 'C', value: rowNum },
          { code: 'P', value: '0' },
          { code: 'V', value: 'true' },
        ])
      ),
      // 204 K0 positive + negative
      ...this._get204(0),
      // 204 K1 positive + negative
      ...this._get204(1),
      this._keepalive(),
    ];
    const body = protocol.buildRequestBody(this.sid, cmds);
    const respText = await this._postServlet(body);
    const parsed = protocol.parseResponse(respText);

    const err = protocol.checkErrors(parsed);
    if (err) {
      // "More than one charge found" is expected for multi-charge codes — not fatal
      if (!err.includes('More than one charge')) {
        throw new Error(objectId + ' validate error: ' + err);
      }
    }

    // Update local data with server-populated defaults
    const k1Data = protocol.extract204(parsed, 1);
    if (k1Data) {
      const k1NewIdx = k1Data.rowNums.indexOf(rowNum);
      if (k1NewIdx >= 0) {
        this.childData.rows[newRowIdx] = k1Data.rows[k1NewIdx];
      }
    }
    const k0Data = protocol.extract204(parsed, 0);
    if (k0Data) this.parentData = k0Data;
  }

  /**
   * Send CMD 300 TMMTS_NEW_TS_LINE to register a new row with the server.
   * The server populates employee defaults (ID, pay schedule, etc.) and
   * establishes session state needed for subsequent charge lookup.
   * Mirrors: captured/add-ftb-req-233
   */
  async _newTimesheetLine() {
    const newRowIdx = this.childData.rowNums.findIndex(n => parseInt(n, 10) < 0);
    const newRow = this.childData.rows[newRowIdx];
    const rowNum = this.childData.rowNums[newRowIdx];
    const period = String(this.periodIdx);
    const parentRow = this.parentData.rows[this.periodIdx];
    const parentRowNum = this.parentData.rowNums[this.periodIdx];
    const actionSeq = this._nextActionSeq();

    const encodedChild = protocol.encodePutRow(newRow);
    const encodedParent = protocol.encodePutRow(parentRow);

    const cmds = [
      // 1. PUT K0 parent (editFlag=18)
      this._wrap(
        this._cmd(205, [
          { code: 'K', value: '0' },
          { code: 'C', value: period },
          { code: 'V', value: 'true' },
          { name: 'lastPutId', value: String(this.lastPutId++) },
        ]),
        {
          data: encodedParent + protocol.DLM_ROW,
          editFlag: '18,',
          rowNumber: parentRowNum + ',',
        }
      ),
      // 2. PUT K1 new child (editFlag=19)
      this._wrap(
        this._cmd(205, [
          { code: 'X', value: period },
          { code: 'K', value: '1' },
          { code: 'C', value: rowNum },
          { code: 'P', value: '0' },
          { code: 'V', value: 'true' },
          { name: 'lastPutId', value: String(this.lastPutId++) },
        ]),
        {
          data: encodedChild + protocol.DLM_ROW,
          editFlag: '19,',
          rowNumber: rowNum + ',',
        }
      ),
      // 3. PUT K0 context ($rsContextOnly$=Y)
      this._wrap(
        this._cmd(205, [
          { name: 'rsContextOnly', value: 'Y' },
          { code: 'K', value: '0' },
          { code: 'C', value: period },
          { code: 'V', value: 'true' },
          { name: 'lastPutId', value: String(this.lastPutId++) },
        ]),
        {
          data: encodedParent + protocol.DLM_ROW,
          editFlag: '18,',
          rowNumber: parentRowNum + ',',
        }
      ),
      // 4. PUT K1 child context ($rsContextOnly$=Y)
      this._wrap(
        this._cmd(205, [
          { code: 'X', value: period },
          { name: 'rsContextOnly', value: 'Y' },
          { code: 'K', value: '1' },
          { code: 'C', value: rowNum },
          { code: 'P', value: '0' },
          { code: 'V', value: 'true' },
          { name: 'lastPutId', value: String(this.lastPutId++) },
        ]),
        {
          data: encodedChild + protocol.DLM_ROW,
          editFlag: '19,',
          rowNumber: rowNum + ',',
        }
      ),
      ...this._pendingLineActionTail('TMMTS_NEW_TS_LINE', rowNum, actionSeq),
    ];

    const body = this._buildPendingLineActionBody(cmds, actionSeq);
    const respText = await this._postServlet(body);

    if (respText.includes('onServletException')) {
      throw new Error('TMMTS_NEW_TS_LINE caused server error. Session may be invalid.');
    }

    const parsed = protocol.parseResponse(respText);
    const err = protocol.checkErrors(parsed);
    if (err) throw new Error('TMMTS_NEW_TS_LINE error: ' + err);

    // Update local data with server-populated defaults
    const k1Data = protocol.extract204(parsed, 1);
    if (k1Data) {
      this.childData = k1Data;
    }
    const k0Data = protocol.extract204(parsed, 0);
    if (k0Data) this.parentData = k0Data;
  }

  /**
   * The browser's per-session CMD 300 action counter (procUniqueId suffix and
   * reqIdx). It grows with every action: a repeated value gets an empty
   * response, which broke the second add in a long-lived (TUI/web) session.
   */
  _nextActionSeq() {
    this._actionSeq = (this._actionSeq || 0) + 1;
    return this._actionSeq;
  }

  /**
   * CMD 300 action on the pending row plus the 204 refetch and keepalive.
   * actionSeq is the value from _nextActionSeq() (capture add-favorite/: NEW_TS_LINE
   * is 1, the favorites action after it is 2).
   */
  _pendingLineActionTail(actionId, rowNum, actionSeq, refetchOpts) {
    return [
      this._wrap(
        this._cmd(300, [
          ...this._actionBoilerplate(),
          { name: 'actionId', value: actionId },
          { name: 'restartFl', value: 'false' },
          { code: 'C', value: rowNum },
          { name: 'longRunActionFl', value: '0' },
          { name: 'procUniqueId', value: APP_ID + ':A:' + this.sid + ':' + actionSeq },
          { name: 'psSchWorkflowNotifyFl', value: 'false' },
          { code: 'K', value: '1' },
          { code: 'P', value: '0' },
          { code: 'V', value: 'true' },
        ])
      ),
      ...this._get204(0, undefined, refetchOpts),
      ...this._get204(1, undefined, refetchOpts),
      this._keepalive(),
    ];
  }

  // reqIdx sets K1 as the action context (matches browser)
  _buildPendingLineActionBody(cmds, actionSeq) {
    return protocol.buildRequestBody(this.sid, cmds) + '&reqIdx=' + actionSeq;
  }

  /**
   * Add the pending (unsaved) line to the user's Costpoint favorites via
   * CMD 300 TMMTS_ADD_LINE_TO_FAVORITES. Call after add() has resolved the
   * charge and before save(). Mirrors captured/add-favorite request 024.
   * The action on an already-saved row was not captured.
   */
  async addToFavorites() {
    const rowIdx = this.childData.rowNums.findIndex(n => parseInt(n, 10) < 0);
    if (rowIdx < 0) throw new Error('No pending line to add to favorites');

    const body = this._buildAddToFavoritesBatch(rowIdx);
    const respText = await this._postServlet(body);
    if (respText.includes('onServletException')) {
      throw new Error('TMMTS_ADD_LINE_TO_FAVORITES caused server error. Session may be invalid.');
    }

    const parsed = protocol.parseResponse(respText);
    const err = protocol.checkErrors(parsed);
    if (err) throw new Error('Add to favorites error: ' + err);

    const k1Data = protocol.extract204(parsed, 1);
    if (k1Data) this.childData = k1Data;
    const k0Data = protocol.extract204(parsed, 0);
    if (k0Data) this.parentData = k0Data;
  }

  _buildAddToFavoritesBatch(rowIdx) {
    const actionSeq = this._nextActionSeq();
    const rowNum = this.childData.rowNums[rowIdx];
    const encodedChild = protocol.encodePutRow(this.childData.rows[rowIdx]);
    const encodedParent = protocol.encodePutRow(this.parentData.rows[0]);
    const childOpts = {
      data: encodedChild + protocol.DLM_ROW,
      editFlag: '83,',
      rowNumber: rowNum + ',',
    };

    const cmds = [
      this._wrap(
        this._cmd(205, [
          { name: 'rsRowSelectedFlOnly', value: 'true' },
          { code: 'X', value: '0' },
          { code: 'K', value: '1' },
          { code: 'C', value: rowNum },
          { code: 'P', value: '0' },
          { code: 'V', value: 'true' },
        ]),
        childOpts
      ),
      this._wrap(
        this._cmd(205, [
          { code: 'X', value: '0' },
          { code: 'K', value: '1' },
          { code: 'C', value: rowNum },
          { code: 'P', value: '0' },
          { code: 'V', value: 'true' },
          { name: 'lastPutId', value: String(this.lastPutId++) },
        ]),
        childOpts
      ),
      this._wrap(
        this._cmd(205, [
          { name: 'rsContextOnly', value: 'Y' },
          { code: 'K', value: '0' },
          { code: 'C', value: '0' },
          { code: 'V', value: 'true' },
          { name: 'lastPutId', value: String(this.lastPutId++) },
        ]),
        {
          data: encodedParent + protocol.DLM_ROW,
          editFlag: '65562,',
          rowNumber: '0,',
        }
      ),
      this._wrap(
        this._cmd(205, [
          { code: 'X', value: '0' },
          { name: 'rsContextOnly', value: 'Y' },
          { code: 'K', value: '1' },
          { code: 'C', value: rowNum },
          { code: 'P', value: '0' },
          { code: 'V', value: 'true' },
          { name: 'lastPutId', value: String(this.lastPutId++) },
        ]),
        childOpts
      ),
      ...this._pendingLineActionTail('TMMTS_ADD_LINE_TO_FAVORITES', rowNum, actionSeq, {
        nonDb: false,
        childCursor: rowNum,
      }),
    ];
    return this._buildPendingLineActionBody(cmds, actionSeq);
  }

  async save() {
    debug('Saving timesheet...');

    const body = this._buildSaveBatch();
    const respText = await this._postServlet(body);

    // Detect server crash response before parsing
    if (respText.includes('onServletException')) {
      debug('Save response (first 500 chars):', respText.substring(0, 500));
      throw new Error('Server error (session may be invalid). Please try again.');
    }

    const parsed = parseSaveResponse(respText);

    // Check for errors
    const hasRescdError = protocol.checkRescds(parsed);
    const err = protocol.checkErrors(parsed);

    // Revision explanation required: the 206 failed with the explanation
    // error. Every other failure is surfaced verbatim below.
    if (hasRescdError && this._isSaveRevisionRequired(parsed)) {
      debug('Revision explanation required — fetching audit details...');
      // Refresh data from this response (server accepted the PUT, just blocked the save)
      const k0Data = protocol.extract204(parsed, 0);
      const k1Data = protocol.extract204(parsed, 1);
      if (k0Data) this.parentData = k0Data;
      if (k1Data) this.childData = k1Data;
      this._buildTableRows();

      // The server has already blocked the save on this definitive signal —
      // if fetching the human-readable detail rows fails, still surface
      // RevisionRequiredError (with no detail) rather than losing the signal
      // under a generic save error that skips the explanation prompt
      let auditDetails = [];
      try {
        auditDetails = await this._fetchRevisionDetails();
      } catch (detailErr) {
        debug('Failed to fetch revision audit details: ' + detailErr.message);
      }
      if (auditDetails.length === 0) debug('Warning: revision required but no audit details were returned');
      throw new RevisionRequiredError(auditDetails);
    }

    if (hasRescdError || err) {
      throw new Error('Save error: ' + (err || 'server rejected the save'));
    }

    // Refresh data from response
    const k0Data = protocol.extract204(parsed, 0);
    const k1Data = protocol.extract204(parsed, 1);
    if (k0Data) this.parentData = k0Data;
    if (k1Data) this.childData = k1Data;

    // A save that follows add-to-favorites returns no 204 data. Without a
    // re-fetch the saved line stays a pending row (-59999) in local state,
    // and the next add() reuses it and re-saves it as a duplicate.
    // The save has committed by now, so a failed re-fetch must not read as a
    // failed save
    if (!k1Data) {
      try {
        await this._refetchTimesheet();
      } catch (e) {
        throw new SaveOutcomeUnknownError(e);
      }
    }

    this._buildTableRows();
    debug('Timesheet saved.');
  }

  /**
   * Re-read the selected period's parent and child rows from the server.
   * A past week goes through _fetchPeriod(): a plain X>0 read without the
   * R=AUTO fetch returns the active week's lines (tecli-lok).
   */
  async _refetchTimesheet() {
    if (this.periodIdx > 0) {
      const { parentData, childData } = await this._fetchPeriod(this.periodIdx);
      this.parentData = parentData;
      this.childData = childData;
      return;
    }
    const resp = await this._postServlet(
      protocol.buildRequestBody(this.sid, [...this._get204(0), ...this._get204(1), this._keepalive()])
    );
    const parsed = protocol.parseResponse(resp);
    const k0Data = protocol.extract204(parsed, 0);
    const k1Data = protocol.extract204(parsed, 1);
    if (k0Data) this.parentData = k0Data;
    if (k1Data) this.childData = k1Data;
  }

  _isSaveRevisionRequired(parsed) {
    return protocol.isSaveRevisionRequired(parsed);
  }

  /**
   * Fetch revision details by opening K2 (revision explanation) and K3 (audit) result sets.
   * Stores revision metadata for use by saveWithExplanation().
   * Returns audit detail rows for display.
   */
  async _fetchRevisionDetails() {
    // Step 1: Open K2 (TMMTS_TS_REVISION_EXP)
    const openK2Resp = await this._postServlet(this._buildOpenRevisionRS());
    protocol.parseResponse(openK2Resp); // validate response

    // Step 2: Query K2 + Open K3 (TMMTS_TS_AUDIT_EXP)
    const queryK2Resp = await this._postServlet(this._buildQueryRevisionAndOpenAudit());
    const queryK2Parsed = protocol.parseResponse(queryK2Resp);

    // Extract K2 data — find the new revision row and metadata
    const k2Data = protocol.extract204(queryK2Parsed, 2);
    this._revisionRowNum = '-59999';
    this._revisionNumber = 1;
    this._revisionMeta = null;

    if (k2Data && k2Data.rows.length > 0) {
      for (let i = 0; i < k2Data.rows.length; i++) {
        const row = k2Data.rows[i];
        const rev = parseInt(row[REV_COL.REVISION_NO], 10);
        if (!isNaN(rev) && rev >= this._revisionNumber) {
          this._revisionNumber = rev;
          // Use this row's metadata if it has EMPL_ID
          if (row[REV_COL.EMPL_ID]) {
            this._revisionMeta = {
              emplId: row[REV_COL.EMPL_ID],
              periodNoCd: row[REV_COL.PERIOD_NO_CD] || '',
              scheduleCd: row[REV_COL.TS_SCHEDULE_CD] || '',
              year: row[REV_COL.YEAR] || '',
            };
          }
        }
        // Track the new row (empty explanation = the one we need to fill)
        if (!row[REV_COL.EXPLANATION] && parseInt(k2Data.rowNums[i], 10) < 0) {
          this._revisionRowNum = k2Data.rowNums[i];
        }
      }
    }

    // Step 3: Query K3 (audit details)
    const queryK3Resp = await this._postServlet(this._buildQueryAudit());
    const queryK3Parsed = protocol.parseResponse(queryK3Resp);
    const k3Data = protocol.extract204(queryK3Parsed, 3);

    const auditDetails = [];
    if (k3Data && k3Data.rows.length > 0) {
      for (const row of k3Data.rows) {
        // Only include rows from the current revision
        if (row[AUDIT_COL.REVISION_NO] === String(this._revisionNumber)) {
          auditDetails.push({
            lineNo: row[AUDIT_COL.LINE_NO] || '',
            date: row[AUDIT_COL.DATE] || '',
            project: row[AUDIT_COL.PROJECT] || '',
            account: row[AUDIT_COL.ACCOUNT] || '',
            chargeDescription: row[AUDIT_COL.CHARGE_DESC] || '',
            description: row[AUDIT_COL.DETAIL] || '',
          });
        }
      }
    }
    return auditDetails;
  }

  /**
   * Save with a revision explanation after save() threw RevisionRequiredError.
   * PUTs the explanation to K2 and re-saves.
   */
  async saveWithExplanation(explanation) {
    if (!this._revisionMeta) {
      throw new Error('No revision context — call save() first.');
    }
    debug('Saving with revision explanation...');

    const body = this._buildRevisionSaveBatch(explanation);
    const respText = await this._postServlet(body);

    if (respText.includes('onServletException')) {
      throw new Error('Server error (session may be invalid). Please try again.');
    }

    const parsed = parseSaveResponse(respText);
    const hasRescdError = protocol.checkRescds(parsed);
    const err = protocol.checkErrors(parsed);

    if (hasRescdError || err) {
      throw new Error('Save with explanation error: ' + (err || 'server rejected'));
    }

    // Refresh data
    const k0Data = protocol.extract204(parsed, 0);
    const k1Data = protocol.extract204(parsed, 1);
    if (k0Data) this.parentData = k0Data;
    if (k1Data) this.childData = k1Data;
    this._buildTableRows();

    // Clean up revision state
    this._revisionNumber = null;
    this._revisionMeta = null;
    this._revisionRowNum = null;
    debug('Timesheet saved with revision explanation.');
  }

  /**
   * Resolve a project code via the server's charge lookup dialog.
   * Performs the 3-step flow: OPEN_RS K2 → HLKP query → CMD 300 TC_TS_CHARGE_LKP_OK.
   * Updates this.parentData and this.childData with the resolved charge fields.
   *
   * For single-charge codes (1 result), auto-selects the only option.
   * For multi-charge codes, selects the row matching payType.
   */
  /**
   * Copy charge fields from the selected K2 lookup row into the pending K1
   * row. The browser does this client-side before sending CMD 300.
   */
  _applyCharge(k2Row) {
    const col = this.childCol;
    const childRow = this.childData.rows[this.childData.rowNums.findIndex(n => parseInt(n, 10) < 0)];
    childRow[col.CHARGE_PROJECT] = k2Row[5] || '';
    // Combined code+payType (e.g., ZLEAVE.FTBRHB)
    childRow[col.CHARGE_COMBINED] = k2Row[24] || '';
    childRow[col.CHARGE_FLAG] = k2Row[26] || '';
    childRow[col.CHARGE_PAY_TYPE] = k2Row[15] || '';
    childRow[col.CHARGE_PROJECT_ID] = k2Row[32] || '';
  }

  async _resolveChargeOnServer(code, payType) {
    // Step 1: PUT child row + OPEN_RS K2 for charge lookup
    const openRsBody = this._buildOpenRsChargeLookup();
    const openRsResp = await this._postServlet(openRsBody);
    const openRsParsed = protocol.parseResponse(openRsResp);
    const openRsErr = protocol.checkErrors(openRsParsed);
    if (openRsErr) throw new Error('Charge lookup OPEN_RS error: ' + openRsErr);

    // Step 2: HLKP query to fetch available charges
    const hlkpBody = this._buildHlkpQuery(code);
    const hlkpResp = await this._postServlet(hlkpBody);
    const hlkpParsed = protocol.parseResponse(hlkpResp);
    const hlkpErr = protocol.checkErrors(hlkpParsed);
    if (hlkpErr) throw new Error('Charge lookup HLKP error: ' + hlkpErr);

    // Extract K2 204 data (lookup results)
    const k2Data = protocol.extract204(hlkpParsed, 2);
    if (!k2Data || k2Data.rows.length === 0) {
      throw new Error('No charges found for ' + code);
    }

    // Select the charge row
    let selectedIdx;
    const availablePayTypes = k2Data.rows.map(r => r[15] || '');
    const hasDistinctPayTypes = availablePayTypes.some(pt => pt !== '');
    debug(
      'K2 lookup for ' +
        code +
        ': ' +
        k2Data.rows.length +
        ' rows, pay types: [' +
        availablePayTypes.map(p => p || '(empty)').join(', ') +
        ']'
    );
    if (k2Data.rows.length === 1 || !hasDistinctPayTypes) {
      // Single-charge code or all rows have empty pay types — auto-select first
      selectedIdx = 0;
    } else if (payType) {
      // Multi-charge — find the row matching the desired pay type
      selectedIdx = this._findChargeRow(k2Data.rows, payType);
      if (selectedIdx < 0) {
        throw new Error(
          'Pay type ' + payType + ' not found for ' + code + '. ' + 'Available: ' + availablePayTypes.join(', ')
        );
      }
    } else {
      throw new Error(
        'Multiple charges found for ' +
          code +
          '. ' +
          'Available pay types: ' +
          availablePayTypes.join(', ') +
          '. ' +
          'Specify one: te add ' +
          code +
          ' <payType>'
      );
    }

    const selectedRowNum = k2Data.rowNums[selectedIdx];
    const selectedK2Row = k2Data.rows[selectedIdx];

    this._applyCharge(selectedK2Row);

    // Step 3: CMD 300 TC_TS_CHARGE_LKP_OK with selected charge
    const lkpOkBody = this._buildChargeLkpOk(selectedK2Row, selectedRowNum);
    const lkpOkResp = await this._postServlet(lkpOkBody);

    if (lkpOkResp.includes('onServletException')) {
      throw new Error('Charge lookup OK caused server error. Session may be invalid.');
    }

    const lkpOkParsed = protocol.parseResponse(lkpOkResp);
    const lkpOkErr = protocol.checkErrors(lkpOkParsed);
    if (lkpOkErr) throw new Error('Charge lookup OK error: ' + lkpOkErr);

    // Refresh local data from response
    const k0Data = protocol.extract204(lkpOkParsed, 0);
    const k1Data = protocol.extract204(lkpOkParsed, 1);
    if (k0Data) this.parentData = k0Data;
    if (k1Data) this.childData = k1Data;

    // Verify the charge was resolved (K1 should have the new row with charge data)
    if (k1Data) {
      const newIdx = k1Data.rowNums.indexOf('-59999');
      if (newIdx < 0) {
        debug('WARNING: new row -59999 not found in K1 response');
      }
    }
  }

  /**
   * Sign the selected period's timesheet.
   *
   * Mirrors the browser's two-request flow (active week: captured/
   * sign-capture/017+018; previous week: captured/prev-period-sign/014+015):
   *   1. CMD 300 TMMTS_SIGN_TIMESHEET action, batched with parent PUTs that
   *      carry ACTION_CD='S'. This primes the server-side sign transition —
   *      without it the server silently ignores ACTION_CD='S' on save (the
   *      request round-trips cleanly but the timesheet stays unsigned).
   *   2. PUT K0 + CMD 206 SAVE (what the browser sends after the user
   *      confirms the sign dialog).
   *
   * Run it on a fresh session (launch, optionally selectPeriod, then sign).
   */
  async sign() {
    const idx = this.periodIdx;
    // A signed (or otherwise locked) week otherwise fails later with
    // "You do not have rights to execute this process"
    if (this.parentData.rows[idx][this.parentCol.ENABLE_SIGN_FL] === 'N') {
      throw new Error(
        'Costpoint does not allow signing this week (status ' + this._getTimesheetStatusMeta().label + ')'
      );
    }
    debug('Signing period ' + idx + '...');

    // Step 1: fire the sign action event
    const respText = await this._postServlet(this._buildSignEvent());
    if (respText.includes('onServletException')) {
      throw new Error('Server error during sign action. Please try again.');
    }
    const parsed = protocol.parseResponse(respText);
    const err = protocol.checkErrors(parsed);
    if (protocol.checkRescds(parsed) || err) {
      throw new Error('Sign error: ' + (err || 'server rejected the sign action'));
    }

    // Refresh local data — the server returns the parent row with
    // ACTION_CD='S' already applied
    const k0Data = protocol.extract204(parsed, 0);
    const k1Data = protocol.extract204(parsed, 1);
    if (k0Data) this.parentData = k0Data;
    if (k1Data) this.childData = k1Data;

    // Step 2: confirm — browser-exact batch (capture 018): PUT K0 only with
    // editFlag 18 + CMD 206. Deliberately NOT save()/_buildSaveBatch, whose
    // shape diverges from the browser (editFlag 65562, all K1 rows PUT) and
    // is the prime suspect for the session state that gets signs ignored.
    this.parentData.rows[idx][this.parentCol.ACTION_CD] = 'S';
    const confirmResp = await this._postServlet(this._buildSignConfirmBatch());
    if (confirmResp.includes('onServletException')) {
      throw new Error('Server error during sign confirm. Please try again.');
    }
    const confirmParsed = protocol.parseResponse(confirmResp);
    const confirmErr = protocol.checkErrors(confirmParsed);
    if (protocol.checkRescds(confirmParsed) || confirmErr) {
      throw new Error('Sign confirm error: ' + (confirmErr || 'server rejected the sign save'));
    }
    const ck0 = protocol.extract204(confirmParsed, 0);
    const ck1 = protocol.extract204(confirmParsed, 1);
    if (ck0) this.parentData = ck0;
    if (ck1) this.childData = ck1;

    // The active-week sign-confirm save returns no 204 data (unlike normal
    // saves; the previous-week one does), so local state can still show
    // unsigned. Re-fetch explicitly so callers (and the web UI cache) see the
    // new status.
    await this._refetchTimesheet();
    this._buildTableRows();

    const status = this.parentData.rows[idx][this.parentCol.S_STATUS_CD];
    if (status !== 'S') {
      throw new Error('Sign did not take effect (status is still "' + status + '")');
    }
    debug('Timesheet signed.');
  }

  /**
   * Build the CMD 300 TMMTS_SIGN_TIMESHEET batch (browser capture 017):
   * PUT K0 selected-flag (pre-sign state, editFlag 64), PUT K0 with
   * ACTION_CD='S' (editFlag 82), PUT K0 context-only (editFlag 82),
   * PUT K1 row 0 (editFlag 0), then the 300 action + 204 refresh + keepalive.
   * The previous week (captured/prev-period-sign/014) is the same batch with
   * the period in the K0 cursor, parent row, K1 X and the 300's C.
   */
  _buildSignEvent() {
    const period = String(this.periodIdx);
    const parentRow = this.parentData.rows[this.periodIdx];
    const parentRowNum = this.parentData.rowNums[this.periodIdx];

    // Frame 1 sends the parent as-is; frames 2-3 send it with ACTION_CD='S'
    const encodedParentPlain = protocol.encodePutRow(parentRow);
    parentRow[this.parentCol.ACTION_CD] = 'S';
    const encodedParentSigned = protocol.encodePutRow(parentRow);

    this._actionSeq = (this._actionSeq || 0) + 1;

    const cmds = [
      // PUT K0 selected row flag only (editFlag 64)
      this._wrap(
        this._cmd(205, [
          { name: 'rsRowSelectedFlOnly', value: 'true' },
          { code: 'K', value: '0' },
          { code: 'C', value: period },
          { code: 'V', value: 'true' },
        ]),
        {
          data: encodedParentPlain + protocol.DLM_ROW,
          editFlag: '64,',
          rowNumber: parentRowNum + ',',
        }
      ),
      // PUT K0 with ACTION_CD='S' (editFlag 82)
      this._wrap(
        this._cmd(205, [
          { code: 'K', value: '0' },
          { code: 'C', value: period },
          { code: 'V', value: 'true' },
          { name: 'lastPutId', value: String(this.lastPutId++) },
        ]),
        {
          data: encodedParentSigned + protocol.DLM_ROW,
          editFlag: '82,',
          rowNumber: parentRowNum + ',',
        }
      ),
      // PUT K0 context only (editFlag 82)
      this._wrap(
        this._cmd(205, [
          { name: 'rsContextOnly', value: 'Y' },
          { code: 'K', value: '0' },
          { code: 'C', value: period },
          { code: 'V', value: 'true' },
          { name: 'lastPutId', value: String(this.lastPutId++) },
        ]),
        {
          data: encodedParentSigned + protocol.DLM_ROW,
          editFlag: '82,',
          rowNumber: parentRowNum + ',',
        }
      ),
    ];

    // PUT K1 row 0 context (editFlag 0) — skipped if there are no charge rows
    if (this.childData && this.childData.rows.length > 0) {
      cmds.push(
        this._wrap(
          this._cmd(205, [
            { code: 'X', value: period },
            { name: 'rsContextOnly', value: 'Y' },
            { code: 'K', value: '1' },
            { code: 'C', value: '0' },
            { code: 'P', value: '0' },
            { code: 'V', value: 'true' },
            { name: 'lastPutId', value: String(this.lastPutId++) },
          ]),
          {
            data: protocol.encodePutRow(this.childData.rows[0]) + protocol.DLM_ROW,
            editFlag: '0,',
            rowNumber: this.childData.rowNums[0] + ',',
          }
        )
      );
    }

    cmds.push(
      this._wrap(
        this._cmd(300, [
          ...this._actionBoilerplate(),
          { name: 'actionId', value: 'TMMTS_SIGN_TIMESHEET' },
          { name: 'restartFl', value: 'false' },
          { code: 'C', value: period },
          { name: 'longRunActionFl', value: '0' },
          { name: 'procUniqueId', value: APP_ID + ':A:' + this.sid + ':' + this._actionSeq },
          { name: 'psSchWorkflowNotifyFl', value: 'false' },
          { code: 'K', value: '0' },
          { code: 'V', value: 'true' },
        ])
      ),
      ...this._get204(0),
      ...this._get204(1),
      this._keepalive()
    );

    // reqIdx=1 accompanies CMD 300 action requests (matches browser capture)
    return protocol.buildRequestBody(this.sid, cmds) + '&reqIdx=1';
  }

  /**
   * Build the sign-confirm batch (browser capture 018): PUT K0 with
   * editFlag 18 (parent row carries ACTION_CD='S'), CMD 206 SAVE, then 204
   * refreshes including the R=S&C status/count fetches the browser sends
   * after saves. No K1 PUT — the browser does not send one here.
   * The previous week (captured/prev-period-sign/015) puts the period in the
   * K0 cursors; the browser keeps X=0 on the K1 S&C fetch even there.
   */
  _buildSignConfirmBatch() {
    const period = String(this.periodIdx);
    const parentRow = this.parentData.rows[this.periodIdx];
    const parentRowNum = this.parentData.rowNums[this.periodIdx];

    const cmds = [
      this._wrap(
        this._cmd(205, [
          { code: 'K', value: '0' },
          { code: 'C', value: period },
          { code: 'V', value: 'true' },
          { name: 'lastPutId', value: String(this.lastPutId++) },
        ]),
        {
          data: protocol.encodePutRow(parentRow) + protocol.DLM_ROW,
          editFlag: '18,',
          rowNumber: parentRowNum + ',',
        }
      ),
      this._wrap(
        this._cmd(206, [
          { code: 'G', value: 'false' },
          { code: 'C', value: period },
          { code: 'U', value: 'true' },
          { code: 'K', value: '0' },
          { code: 'V', value: 'true' },
        ])
      ),
      ...this._getActionSaveRefresh(),
      this._keepalive(),
    ];
    return protocol.buildRequestBody(this.sid, cmds);
  }

  /**
   * The 204 refreshes the browser sends after an action's save (sign
   * confirm, correct save): K0 and K1 each as ABS plus an R=S&C fetch.
   * The K1 S&C fetch keeps X=0 even for the previous week.
   */
  _getActionSaveRefresh() {
    const childRowCount = this.childData ? this.childData.rows.length : 40;
    const k1E = Math.max(childRowCount + 5, 40);
    return [
      ...this._get204(0),
      this._wrap(
        this._cmd(204, [
          { name: 'rsType', value: 'M' },
          { code: 'R', value: 'S&C' },
          { code: 'S', value: '0' },
          { code: 'E', value: '20' },
          { code: 'W', value: '' },
          { code: 'K', value: '0' },
          { code: 'C', value: String(this.periodIdx) },
          { code: 'V', value: 'true' },
        ])
      ),
      ...this._get204(1),
      this._wrap(
        this._cmd(204, [
          { name: 'rsType', value: 'M' },
          { code: 'R', value: 'S&C' },
          { code: 'S', value: '0' },
          { code: 'E', value: String(k1E) },
          { code: 'X', value: '0' },
          { code: 'W', value: '' },
          { code: 'K', value: '1' },
          { code: 'C', value: '0' },
          { code: 'P', value: '0' },
          { code: 'V', value: 'true' },
        ])
      ),
    ];
  }

  async navigateToPreviousPeriod() {
    await this.selectPeriod(1);
  }

  /**
   * Point the client at another period (parent K0 row: 0 = active week,
   * 1 = previous week). Later cell edits, saves and revision explanations
   * target that period. Mirrors the browser's previous-week arrow
   * (captured/prev-period-edit/013).
   *
   * Run this right after launch, before any edit: a session is meant to
   * work on one period only.
   */
  async selectPeriod(idx) {
    if (!this.parentData || idx < 0 || idx >= this.parentData.rows.length) {
      throw new Error('Period ' + idx + ' is not available');
    }
    const { parentData, childData } = await this._fetchPeriod(idx);
    if (!parentData.rows[idx][this.parentCol.TS_CLOSED_FL]) {
      throw new Error('Period ' + idx + ' parent row came back without its detail columns');
    }
    this.parentData = parentData;
    this.childData = childData;
    this.periodIdx = idx;
    this._buildDates();
    this._initTable();
    this._buildTableRows();
    debug(
      'Selected period ' + idx + ': ' + this.dates[0].format('YYYY-MM-DD') + ' - ' + this.dates[6].format('YYYY-MM-DD')
    );
  }

  /**
   * Fetch parent + child data for a period without changing client state.
   * The R=AUTO parent fetch must come first: without it the server answers
   * X=1 with the wrong lines, and parent rows other than row 0 come back
   * missing their non-DB columns (verified live, captured/probe-prev-fetch.js).
   */
  async _fetchPeriod(idx) {
    await this._postServlet(this._buildAutoParentFetch());
    const parsed = protocol.parseResponse(await this._postServlet(this._buildPeriodFetch(idx)));
    const err = protocol.checkErrors(parsed);
    if (err) throw new Error('Period ' + idx + ' fetch error: ' + err);
    const parentData = protocol.extract204(parsed, 0);
    if (!parentData) throw new Error('Failed to decode parent data for period ' + idx);
    const childData = protocol.extract204(parsed, 1) || { rowNums: [], rowFlags: [], rows: [] };
    return { parentData, childData };
  }

  _isPeriodClosed() {
    const row = this.parentData.rows[this.periodIdx];
    const closed = row[this.parentCol.TS_CLOSED_FL] === 'Y';
    // A Processed week is always closed; anything else means the flag was
    // read from the wrong column, and editing would skip Correct
    if (!closed && normalizeTimesheetStatus(row[this.parentCol.S_STATUS_CD] || '').code === 'P') {
      throw new Error(
        'Week is Processed but TS_CLOSED_FL reads ' +
          JSON.stringify(row[this.parentCol.TS_CLOSED_FL]) +
          '; refusing to edit'
      );
    }
    return closed;
  }

  // A closed period can still be edited through a correction
  _isRowEditable(parentRow) {
    return parentRow[this.parentCol.TS_CLOSED_FL] !== 'Y' || parentRow[this.parentCol.ENABLE_CORRECT_FL] === 'Y';
  }

  /**
   * Reopen a processed period for edits, like the browser's Correct button
   * (captured/prev-period-edit/014+015): CMD 300 TMMTS_CORRECT_TIMESHEET,
   * then a parent PUT + CMD 206 that commits the new revision. The period
   * comes back Open; the next save asks for a revision explanation.
   */
  async _correctTimesheet() {
    if (this.parentData.rows[this.periodIdx][this.parentCol.ENABLE_CORRECT_FL] !== 'Y') {
      throw new Error('This timesheet is closed and Costpoint does not allow correcting it');
    }
    debug('Correcting closed period ' + this.periodIdx + '...');

    const eventParsed = this._parseActionResponse(
      await this._postServlet(this._buildCorrectEvent()),
      'Correct timesheet'
    );
    this._refreshFrom(eventParsed);

    const saveParsed = this._parseActionResponse(
      await this._postServlet(this._buildCorrectSaveBatch()),
      'Correct timesheet save'
    );
    this._refreshFrom(saveParsed);

    // A live correction once committed while its save response still showed
    // the week closed, so confirm with a fresh fetch before failing
    // (2026-10-13)
    if (this._isPeriodClosed()) {
      debug('Correct save response still shows the period closed; re-fetching...');
      const { parentData, childData } = await this._fetchPeriod(this.periodIdx);
      this.parentData = parentData;
      this.childData = childData;
    }
    this._buildTableRows();

    if (this._isPeriodClosed()) {
      throw new Error('Correct did not take effect (timesheet is still closed)');
    }
  }

  _parseActionResponse(respText, label) {
    if (respText.includes('onServletException')) {
      throw new Error(label + ' caused a server error. Session may be invalid.');
    }
    const parsed = protocol.parseResponse(respText);
    const err = protocol.checkErrors(parsed);
    if (protocol.checkRescds(parsed) || err) {
      throw new Error(label + ' error: ' + (err || 'server rejected the request'));
    }
    return parsed;
  }

  _refreshFrom(parsed) {
    const k0Data = protocol.extract204(parsed, 0);
    const k1Data = protocol.extract204(parsed, 1);
    if (k0Data) this.parentData = k0Data;
    if (k1Data) this.childData = k1Data;
  }

  /**
   * Fetch leave balances and details.
   * Opens K2 (TMMTS_LVSTAT_HDR) and K3 (TMMTS_LV_STAT), queries both,
   * and returns { balances: [...], details: [...] }.
   */
  async getLeaveBalances() {
    // Step 1: Open K2 (TMMTS_LVSTAT_HDR)
    const openK2Resp = await this._postServlet(this._buildOpenLeaveBalanceRS());
    protocol.parseResponse(openK2Resp);

    // Step 2: Query K2 (leave balances) + Open K3 (TMMTS_LV_STAT)
    const queryK2Resp = await this._postServlet(this._buildQueryLeaveBalancesAndOpenDetail());
    const queryK2Parsed = protocol.parseResponse(queryK2Resp);

    const k2Data = protocol.extract204(queryK2Parsed, 2);
    const balances = [];
    if (k2Data && k2Data.rows.length > 0) {
      for (const row of k2Data.rows) {
        const desc = row[0] || '';
        const balance = parseFloat(row[1]) || 0;
        const code = row[2] || '';
        balances.push({ description: desc, balance, code });
      }
    }

    // Step 3: Query K3 (leave details) — default to PTO row, fallback to first non-zero balance
    let detailRowIdx = 0;
    for (let i = 0; i < balances.length; i++) {
      if (balances[i].code === 'COMP') {
        detailRowIdx = i;
        break;
      }
      if (detailRowIdx === 0 && balances[i].balance !== 0) detailRowIdx = i;
    }

    const queryK3Resp = await this._postServlet(this._buildQueryLeaveDetails(detailRowIdx));
    const queryK3Parsed = protocol.parseResponse(queryK3Resp);

    const k3Data = protocol.extract204(queryK3Parsed, 3);
    const details = [];
    if (k3Data && k3Data.rows.length > 0) {
      for (const row of k3Data.rows) {
        details.push({
          date: row[0] || '',
          type: row[1] || '',
          hours: parseFloat(row[2]) || 0,
          reason: row[3] || '',
          leaveTypeCode: row[4] || '',
          leaveTypeDesc: row[5] || '',
        });
      }
    }

    return { balances, details };
  }

  async close() {
    this._httpAgent.destroy();
    this._httpsAgent.destroy();
  }

  // =========================================================================
  // HTTP helpers
  // =========================================================================

  /**
   * Core HTTP request. When a response redirects to a SAML IdP (Okta),
   * transparently completes the SAML round-trip and retries the original
   * request — mirroring browser behavior.
   */
  async _http(method, urlPath, body, contentType, opts) {
    const followRedirects = !opts || opts.followRedirects !== false;
    const handleSaml = !opts || opts.handleSaml !== false;
    const extraHeaders = (opts && opts.headers) || {};

    const resp = await this._httpRaw(method, urlPath, body, contentType, extraHeaders);

    // Handle redirects
    if (resp.status >= 300 && resp.status < 400 && resp.headers.location) {
      const loc = resp.headers.location;

      // Check if this is a SAML redirect (to an external IdP like Okta)
      if (handleSaml && this._isSamlRedirect(loc, urlPath)) {
        const chainResult = await this._completeSamlChain(loc);

        // If the SAML chain submitted a replay form and got a response, use it
        // (this IS the Costpoint response — no retry needed)
        if (chainResult) {
          if (chainResult.status >= 300 && chainResult.status < 400 && chainResult.headers.location) {
            if (followRedirects) {
              return this._http('GET', chainResult.headers.location, null, null, { ...opts, handleSaml: false });
            }
          }
          return chainResult;
        }

        // No replay form found — fall back to retrying the original request
        const retryResp = await this._httpRaw(method, urlPath, body, contentType, extraHeaders);
        if (retryResp.status >= 300 && retryResp.status < 400 && retryResp.headers.location) {
          if (followRedirects) {
            return this._http('GET', retryResp.headers.location, null, null, { ...opts, handleSaml: false });
          }
        }
        return retryResp;
      }

      if (followRedirects) {
        return this._http('GET', loc, null, null, opts);
      }
    }

    return resp;
  }

  /**
   * Raw HTTP request — no redirect following, no SAML handling.
   * Just makes the request, tracks cookies, and returns the response.
   */
  async _httpRaw(method, urlPath, body, contentType, extraHeaders) {
    const fullUrl = new URL(urlPath, this.baseUrl);
    const isHttps = fullUrl.protocol === 'https:';
    const lib = isHttps ? https : http;
    const reqPath = fullUrl.pathname;
    const cookieStr = this._cookieHeader(fullUrl.hostname, reqPath);

    const options = {
      method,
      hostname: fullUrl.hostname,
      port: fullUrl.port || (isHttps ? 443 : 80),
      path: fullUrl.pathname + fullUrl.search,
      agent: isHttps ? this._httpsAgent : this._httpAgent,
      headers: { Cookie: cookieStr, 'User-Agent': USER_AGENT, ...(extraHeaders || {}) },
    };

    if (body !== undefined && body !== null) {
      options.headers['Content-Type'] = contentType || 'application/x-www-form-urlencoded';
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }

    return this._send(lib, options, body, fullUrl.hostname, reqPath);
  }

  /**
   * Send one request and collect the response as text. The whole exchange
   * must finish within requestTimeoutMs() and the body stay under
   * MAX_RESPONSE_BYTES, so a stalled or runaway gateway fails the call
   * instead of hanging it.
   */
  _send(lib, options, body, hostname, reqPath) {
    const timeoutMs = requestTimeoutMs();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          req.destroy();
          reject(err);
        } else {
          resolve(value);
        }
      };
      const req = lib.request(options, res => {
        this._trackCookies(hostname, res.headers['set-cookie'], reqPath);
        const chunks = [];
        let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) return finish(new ResponseTooLargeError());
          chunks.push(chunk);
        });
        res.on('end', () => {
          finish(null, { status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers });
        });
        res.on('error', finish);
      });
      const timer = setTimeout(() => finish(new RequestTimeoutError(timeoutMs)), timeoutMs);
      req.on('error', finish);
      if (body !== undefined && body !== null) req.write(body);
      req.end();
    });
  }

  /**
   * Check if a redirect Location is a SAML redirect to an external IdP.
   */
  _isSamlRedirect(location, originalUrl) {
    try {
      const locUrl = new URL(location, this.baseUrl);
      const origUrl = new URL(originalUrl, this.baseUrl);
      // External redirect with SAML indicators
      if (locUrl.hostname !== origUrl.hostname) return true;
      if (location.includes('SAMLRequest') || location.includes('/sso/saml')) return true;
    } catch (_) {}
    return false;
  }

  /**
   * Browser-like headers for SAML form navigation.  The gateway ISAPI filter
   * may only intercept requests that look like genuine browser navigation
   * (checking Accept, Sec-Fetch-*, etc.) before passing through to IIS.
   */
  _browserHeaders(referer, origin) {
    return {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'max-age=0',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': referer ? 'same-origin' : 'none',
      'Sec-Fetch-User': '?1',
      ...(referer ? { Referer: referer } : {}),
      ...(origin ? { Origin: origin } : {}),
    };
  }

  /**
   * Extract a meta-refresh URL from HTML.
   * Returns the URL string or null.
   */
  _parseMetaRefresh(html) {
    const m = html.match(/<meta[^>]+http-equiv=["']?Refresh["']?[^>]+content=["']?\d+;URL=([^"'\s>]+)/i);
    return m ? m[1] : null;
  }

  /**
   * Complete a SAML round-trip: GET the IdP URL, follow the SAML form chain
   * (possibly multiple hops through SAML proxies).
   *
   * For POST-triggered SAML, stops before the gateway's postredirect.php to
   * preserve the replay state for the subsequent retry.
   *
   * Always returns null — the caller (_http) handles the retry.
   */
  async _completeSamlChain(samlUrl) {
    // GET the IdP page — if we're already authenticated with Okta,
    // this returns a SAML form immediately (no login needed)
    let resp = await this._httpRaw('GET', samlUrl, null, null, this._browserHeaders(null, null));
    // Follow redirects to reach the SAML form page
    while (resp.status >= 300 && resp.status < 400 && resp.headers.location) {
      resp = await this._httpRaw('GET', resp.headers.location, null, null, this._browserHeaders(null, null));
    }
    let html = resp.body;

    // Follow SAML form chain (POST form → follow redirects → repeat).
    let currentUrl = samlUrl;
    for (let hop = 0; hop < 10; hop++) {
      const form = this._parseSAMLForm(html);
      if (!form) {
        break;
      }

      const formUrl = new URL(form.action);
      resp = await this._httpRaw(
        'POST',
        form.action,
        form.body,
        'application/x-www-form-urlencoded',
        this._browserHeaders(currentUrl, formUrl.origin)
      );

      // Follow redirects after SAML POST (ACS redirects)
      if (resp.status >= 300 && resp.status < 400 && resp.headers.location) {
        const redirectUrl = resp.headers.location;

        resp = await this._httpRaw('GET', redirectUrl, null, null, this._browserHeaders(currentUrl, null));
        while (resp.status >= 300 && resp.status < 400 && resp.headers.location) {
          resp = await this._httpRaw('GET', resp.headers.location, null, null, this._browserHeaders(null, null));
        }
        html = resp.body;
        currentUrl = redirectUrl;
      } else {
        html = resp.body;
      }
    }

    return null;
  }

  /**
   * HTTP helper scoped to a specific origin (separate cookie jar not needed —
   * Okta cookies go into this.cookies keyed by name which is fine).
   */
  async _httpJson(origin, method, path, body) {
    const fullUrl = new URL(path, origin);
    const isHttps = fullUrl.protocol === 'https:';
    const lib = isHttps ? https : http;

    const reqPath = fullUrl.pathname;
    const cookieStr = this._cookieHeader(fullUrl.hostname, reqPath);

    const headers = {
      Cookie: cookieStr,
      'User-Agent': USER_AGENT,
      Accept: 'application/json; okta-version=1.0.0',
      'Content-Type': 'application/json',
    };

    const bodyStr = body ? JSON.stringify(body) : null;
    if (bodyStr) {
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const options = {
      method,
      hostname: fullUrl.hostname,
      port: fullUrl.port || (isHttps ? 443 : 80),
      path: fullUrl.pathname + fullUrl.search,
      agent: isHttps ? this._httpsAgent : this._httpAgent,
      headers,
    };
    return this._send(lib, options, bodyStr, fullUrl.hostname, reqPath);
  }

  /**
   * Browser-like XHR headers for MasterServlet requests.
   * The gateway/WAF may check Sec-Fetch-* to validate legitimate browser origin.
   */
  _servletHeaders() {
    return {
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: this.baseUrl + '/cpweb/masterPage.htm',
      Origin: this.baseUrl,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'X-Requested-With': 'XMLHttpRequest',
    };
  }

  async _postServlet(body) {
    const cmds = (new URLSearchParams(body).get('cmd') || '').split(protocol.DLM_RS);
    if (cmds.some(c => WRITE_COMMAND.test(c))) this.writesSent++;
    const resp = await this._http('POST', '/cpweb/MasterServlet.cps', body, 'application/x-www-form-urlencoded', {
      headers: this._servletHeaders(),
    });
    trace({ time: new Date().toISOString(), request: body, response: resp.body });
    if (resp.body.includes('onServletException') && !/var responses\s*=/.test(resp.body)) {
      throw new SessionExpiredError(resp.body);
    }
    return resp.body;
  }

  // =========================================================================
  // Init flow
  // =========================================================================

  async _init(url, username, password, opts) {
    opts = opts || {};
    const parsed = new URL(url);
    this.baseUrl = parsed.origin;
    this.sid = crypto.randomUUID().replace(/-/g, '');
    this._system = parsed.searchParams.get('system') || '';

    debug('Connecting to Costpoint...');

    // Step 1: GET login form — don't auto-follow redirects so we can detect SSO
    // Also disable SAML handling — we need to detect the SSO redirect ourselves
    // so we can run the full IDX (username/password) flow first
    const loginResp = await this._http('GET', parsed.pathname + parsed.search, null, null, {
      followRedirects: false,
      handleSaml: false,
    });

    let ssoMode = false;
    if (loginResp.status >= 300 && loginResp.status < 400 && loginResp.headers.location) {
      const redirectUrl = loginResp.headers.location;
      const redirectParsed = new URL(redirectUrl, this.baseUrl);

      if (redirectParsed.hostname !== parsed.hostname) {
        // SSO redirect (e.g. Okta SAML) — handle the full SSO flow
        await this._ssoLogin(redirectUrl, username, password);
        ssoMode = true;

        // Navigate to cploginform.htm after SAML — this mirrors the browser
        // flow (root → /cpweb → /cpweb/ → cploginform.htm) and establishes
        // the gateway's identity injection context for /cpweb/* paths.
        await this._http('GET', parsed.pathname + parsed.search);
      } else {
        // Same-host redirect — follow it
        await this._http('GET', redirectUrl);
      }
    }

    // Costpoint login (LoginServlet.cps)
    await this._cpLogin(username, password, ssoMode);

    // GET masterPage (captures ProcIdSeed cookie)
    await this._http('GET', '/cpweb/masterPage.htm');

    // Update sid from server's ProcIdSeed cookie (critical for real server —
    // the server generates its own ProcIdSeed during login which must be used as sid)
    const baseHost = new URL(this.baseUrl).hostname;
    const procIdEntry = (this.cookieJar[baseHost] || {}).ProcIdSeed;
    const serverProcId = procIdEntry ? (typeof procIdEntry === 'string' ? procIdEntry : procIdEntry.value) : null;
    if (serverProcId) {
      this.sid = serverProcId;
    }

    debug('Logged in. Loading timesheet...');

    // LOGININFO
    const loginInfoResp = await this._http(
      'POST',
      '/cpweb/MasterServlet.cps',
      'sid=' + this.sid + '&LOGININFO=Y&PHONE=N',
      'application/x-www-form-urlencoded',
      { headers: this._servletHeaders() }
    );

    // Real server returns empty on success; mock returns responseCd='ok'
    // Fail only if body contains an explicit error
    if (
      loginInfoResp.body.includes('session not valid') ||
      (loginInfoResp.body.includes('returnCd') && loginInfoResp.body.includes('error'))
    ) {
      throw new Error('LOGININFO failed: ' + responseExcerpt(loginInfoResp.body));
    }

    // OPEN_APP (507+101+507)
    await this._postServlet(this._buildOpenApp());

    // OPEN_RS parent K0 (201+507) — must open before fetching data
    const openRsResp = await this._postServlet(this._buildOpenRsParent());

    // Parent data + OPEN_RS child (204+204+201+507)
    const parentResp = await this._postServlet(this._buildInitParent());
    const parentParsed = protocol.parseResponse(parentResp);
    this.parentData = protocol.extract204(parentParsed, 0);
    if (!this.parentData) throw new Error('Failed to decode parent data');
    this.parentCol = resolveParentColumns(
      protocol.columnNames(openRsResp)[0],
      this.parentData.rows[0] && this.parentData.rows[0].length
    );

    // Child data X=0 (204+204+507) — current period
    const childResp = await this._postServlet(this._buildInitChild());
    const childParsed = protocol.parseResponse(childResp);
    this.childData = protocol.extract204(childParsed, 1);
    if (!this.childData) throw new Error('Failed to decode child data');
    // The init parent batch carries the K1 OPEN_RS, so its names are the child list
    this.childCol = resolveChildColumns(
      protocol.columnNames(parentResp)[0],
      this.childData.rows[0] && this.childData.rows[0].length
    );

    // Previous period lines (X=1) for read-only display — only when
    // requested (web UI, TUI). getPreviousPeriodData() reads them.
    this.prevChildData = null;
    this._prevParentRow = null;
    if (opts.loadPreviousPeriod && this.parentData.rows.length > 1) {
      try {
        const prev = await this._fetchPeriod(1);
        this.prevChildData = prev.childData;
        this._prevParentRow = prev.parentData.rows[1];
        debug('Previous period: %d rows', this.prevChildData.rows.length);
      } catch (e) {
        debug('Previous period child data fetch failed (non-fatal): ' + e.message);
      }
    }

    // Build dates and table
    this._buildDates();
    this._initTable();
    this._buildTableRows();

    debug('Timesheet loaded.');
  }

  // =========================================================================
  // SSO login (Okta Identity Engine / IDX)
  // =========================================================================

  /**
   * stateToken for the IDX flow from the Okta page the SAML request lands on.
   * The Sign-In page carries it as JSON ("stateToken":"..."). The desktop-SSO
   * interstitial (/sso/idps/DSSO) carries `var stateToken = "..."` and runs a
   * Kerberos precheck that fails off the corporate network; its failure
   * redirect (dssoPreCheck.js redirectOnFailure, IDX pipeline) is the Sign-In
   * page with a new stateToken, so follow it the same way.
   */
  async _ssoStateToken(pageHtml, pageUrl) {
    const decode = s => s.replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    const json = pageHtml.match(/"stateToken"\s*:\s*"([^"]+)"/);
    if (json) return decode(json[1]);

    const dsso = pageHtml.match(/var\s+stateToken\s*=\s*"([^"]+)"/);
    if (!dsso) throw new Error('Could not extract stateToken from SSO page');
    debug('SSO: desktop-SSO page, following the precheck failure redirect');
    const fallbackUrl = new URL('/login/agentlessDsso/idx', pageUrl);
    fallbackUrl.search = new URLSearchParams({
      stateToken: decode(dsso[1]),
      precheckFailure: 'true',
      redirectFromAdsso: 'true',
    }).toString();
    const r = await this._httpRaw('GET', fallbackUrl.href);
    const signIn = r.body.match(/"stateToken"\s*:\s*"([^"]+)"/);
    if (!signIn) {
      throw new Error('Could not extract stateToken from SSO page after desktop-SSO fallback (HTTP ' + r.status + ')');
    }
    return decode(signIn[1]);
  }

  async _ssoLogin(samlUrl, username, password) {
    const ssoOrigin = new URL(samlUrl).origin;

    // 1. GET the Okta SAML page — extract stateToken from HTML/JS
    const pageResp = await this._httpRaw('GET', samlUrl);
    let pageHtml = pageResp.body;
    let pageUrl = samlUrl;
    // Follow redirects manually (httpRaw doesn't follow)
    if (pageResp.status >= 300 && pageResp.status < 400 && pageResp.headers.location) {
      pageUrl = new URL(pageResp.headers.location, samlUrl).href;
      const r = await this._httpRaw('GET', pageUrl);
      pageHtml = r.body;
    }
    const stateToken = await this._ssoStateToken(pageHtml, pageUrl);

    // 2. POST /idp/idx/introspect to get stateHandle
    const introspectResp = await this._httpJson(ssoOrigin, 'POST', ssoOrigin + '/idp/idx/introspect', { stateToken });
    const introspectData = JSON.parse(introspectResp.body);
    const stateHandle = introspectData.stateHandle;
    if (!stateHandle) throw new Error('SSO introspect did not return stateHandle');

    // 3. POST /idp/idx/identify with username
    const identifyResp = await this._httpJson(ssoOrigin, 'POST', ssoOrigin + '/idp/idx/identify', {
      identifier: username,
      stateHandle,
    });
    const identifyData = JSON.parse(identifyResp.body);
    const challengeForm = identifyData.remediation?.value?.find(r => r.name === 'challenge-authenticator');
    if (!challengeForm) {
      // Check if we need to select the password authenticator first
      const selectForm = identifyData.remediation?.value?.find(r => r.name === 'select-authenticator-authenticate');
      if (selectForm) {
        // Find password authenticator option
        const authenticators = identifyData.authenticators?.value || [];
        const pwdAuth = authenticators.find(a => a.type === 'password');
        if (pwdAuth) {
          // Select password authenticator
          const selectResp = await this._httpJson(ssoOrigin, 'POST', selectForm.href, {
            authenticator: { id: pwdAuth.id },
            stateHandle,
          });
          const selectData = JSON.parse(selectResp.body);
          const challengeAfterSelect = selectData.remediation?.value?.find(r => r.name === 'challenge-authenticator');
          if (challengeAfterSelect) {
            // Now answer with password
            const answerResp2 = await this._httpJson(ssoOrigin, 'POST', challengeAfterSelect.href, {
              credentials: { passcode: password },
              stateHandle,
            });
            const answerData2 = JSON.parse(answerResp2.body);
            return this._completeSsoFromAnswer(answerData2);
          }
        }
        throw new Error('SSO: could not find password authenticator');
      }
      throw new Error('SSO did not return password challenge after identify');
    }

    // 4. POST /idp/idx/challenge/answer with password
    const answerResp = await this._httpJson(ssoOrigin, 'POST', challengeForm.href, {
      credentials: { passcode: password },
      stateHandle,
    });
    const answerData = JSON.parse(answerResp.body);
    await this._completeSsoFromAnswer(answerData);
  }

  /**
   * Complete SSO flow from the IDX answer response — extract success redirect
   * and follow the SAML chain to establish gateway session.
   */
  async _completeSsoFromAnswer(answerData) {
    let redirectHref = null;
    if (answerData.success) {
      redirectHref = answerData.success.href;
    } else if (answerData.successWithInteractionCode) {
      redirectHref = answerData.successWithInteractionCode.href;
    }

    if (!redirectHref) {
      const errMsg = answerData.messages?.value?.[0]?.message;
      if (errMsg) throw new Error('SSO authentication failed: ' + errMsg);
      throw new Error('SSO authentication did not return success redirect');
    }

    // Complete the identity SAML chain — this establishes our session with the
    // SAML proxy/gateway. After this, subsequent requests to /cpweb that trigger
    // app-specific SAML will be handled transparently by _http().
    await this._completeSamlChain(redirectHref);

    debug('SSO authentication complete.');
  }

  /**
   * Decode HTML entities (named and numeric) in a string.
   */
  _decodeHtmlEntities(str) {
    return str
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }

  /**
   * Parse an HTML auto-submit form: the action URL and every input that has
   * both a name and a value (in either order). skipSubmit leaves submit
   * buttons out, as gateway replay forms need.
   * Returns { action, body } or null.
   */
  _parseForm(html, { skipSubmit = false } = {}) {
    const actionMatch = html.match(/<form[^>]+action="([^"]+)"/i);
    if (!actionMatch) return null;
    const action = this._decodeHtmlEntities(actionMatch[1]);

    const params = [];
    const inputRe = /<input[^>]*>/gi;
    let m;
    while ((m = inputRe.exec(html)) !== null) {
      const tag = m[0];
      if (skipSubmit && /type="submit"/i.test(tag)) continue;
      const nameMatch = tag.match(/name="([^"]+)"/i);
      const valueMatch = tag.match(/value="([^"]*)"/i);
      if (nameMatch && valueMatch) {
        const name = this._decodeHtmlEntities(nameMatch[1]);
        const value = this._decodeHtmlEntities(valueMatch[1]);
        params.push(encodeURIComponent(name) + '=' + encodeURIComponent(value));
      }
    }
    if (params.length === 0) return null;
    return { action, body: params.join('&') };
  }

  /**
   * Parse an HTML page containing a SAML auto-submit form.
   * Only matches forms that contain a SAMLResponse field (real SAML POST-binding
   * assertions). Ignores gateway replay forms (e.g. SimpleSAMLphp postredirect.php)
   * which contain the original application POST data, not SAML data.
   * Returns { action, body } or null.
   */
  _parseSAMLForm(html) {
    if (!/<input[^>]+name="SAMLResponse"/i.test(html)) return null;
    return this._parseForm(html);
  }

  // =========================================================================
  // Costpoint login (LoginServlet.cps)
  // =========================================================================

  async _cpLogin(username, password) {
    // Step 1: requestCd=000 — establish connection
    await this._http('POST', '/cpweb/LoginServlet.cps', 'requestCd=000');

    // Step 2: requestCd=003 — auth config (match browser params exactly)
    if (this._system) {
      await this._http(
        'POST',
        '/cpweb/LoginServlet.cps',
        'requestCd=003&DATABASE=' +
          encodeURIComponent(this._system) +
          '&LANG=EN&FIDO_CONFIG=Y&U2F_CONDITIONAL_MEDIATION=Y'
      );
    }

    // Step 3: USER + PASSWORD flow (no requestCd=001 — browser skips it)
    // In SSO mode, skip P_FL=N (requires Kerberos/SPNEGO which Node.js can't provide)
    // and go directly to password auth (P_FL=Y).
    const userParams =
      'USER=' +
      encodeURIComponent(username) +
      '&P_FL=Y' +
      (this._system ? '&DATABASE=' + encodeURIComponent(this._system) : '') +
      '&APPID=&COMPANYID=&EXECMODE=H&BROWSERTYPE=CHROME&BROWSERVERSION=9' +
      '&U2F_ENABLED=Y&U2F_PA_PREFERRED=N&TIMEOUT=&BUILDNUMBER=8.2.0&LANG=EN' +
      '&STATUS=&settings=ON&NEW_UI_FL=Y';
    const userResp = await this._http('POST', '/cpweb/LoginServlet.cps', userParams);

    if (userResp.body.includes('copyAuthData')) {
      const authJSON = userResp.body.substring('copyAuthData'.length);
      const authData = JSON.parse(authJSON);
      const hashedPassword = this._encodePassword(
        authData.userId,
        password,
        authData.nonce,
        authData.ldapAuthFl,
        authData.sha2PasswordFl
      );
      const pwdResp = await this._http(
        'POST',
        '/cpweb/LoginServlet.cps',
        'PASSWORD=' + encodeURIComponent(hashedPassword)
      );
      if (pwdResp.body.includes('error')) {
        throw new Error('Costpoint password login failed: ' + responseExcerpt(pwdResp.body));
      }
    } else {
      // Mock-backend or simple login — just send password directly
      await this._http('POST', '/cpweb/LoginServlet.cps', 'PASSWORD=' + encodeURIComponent(password));
    }
  }

  /**
   * Encode password the way Costpoint's cploginform.js does.
   * Uses AES-128-CBC encryption with a key derived from SHA-256.
   *
   * ldapAuthFl=1 (LDAP): plaintext = password + "<;$/" + nonce + "<;$/" + timestamp
   * ldapAuthFl=0 (native): plaintext = hash1 + nonce + timestamp
   *   where hash1 = SHA256(user + SHA256(SHA256(password))) [sha2=1]
   *   or    hash1 = SHA1(user + SHA1(SHA1(password)))       [sha2=0]
   *
   * Key = first 32 hex chars of SHA-256(user + nonce) [LDAP]
   *     or first 32 hex chars of SHA256(hash1) [native]
   * IV = "1111111111111111" (16 bytes of 0x31)
   * Padding: '!' to block boundary, then PKCS7 from crypto API
   */
  _encodePassword(userId, password, nonce, ldapFlag, sha2Flag) {
    const nonceStr = String(nonce);
    const ts = String(Date.now());
    const sha256hex = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
    const sha1hex = s => crypto.createHash('sha1').update(s, 'utf8').digest('hex');

    let keyHex, text;
    if (ldapFlag) {
      // LDAP: raw password in encrypted payload (server needs it for LDAP bind)
      keyHex = sha256hex(userId + nonceStr).substring(0, 32);
      text = password + '<;$/' + nonceStr + '<;$/' + ts;
    } else {
      // Native: double-hash password, never send raw
      const pass = sha2Flag ? sha256hex(sha256hex(password)) : sha1hex(sha1hex(password));
      const hash1 = sha2Flag ? sha256hex(userId + pass) : sha1hex(userId + pass);
      keyHex = (sha2Flag ? sha256hex(hash1) : sha1hex(hash1)).substring(0, 32);
      text = hash1 + nonceStr + ts;
    }

    // Pad with '!' to AES block boundary (16 bytes)
    const blockSize = 16;
    const remainder = text.length % blockSize;
    if (remainder !== 0) {
      text += '!'.repeat(blockSize - remainder);
    }

    // AES-128-CBC encrypt (PKCS7 padding applied by Node.js crypto on top)
    const key = Buffer.from(keyHex, 'hex');
    const iv = Buffer.from('1111111111111111', 'ascii');
    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return encrypted.toString('hex');
  }

  // =========================================================================
  // Date & table building
  // =========================================================================

  _buildDates() {
    const endDateStr = this.parentData.rows[this.periodIdx][this.parentCol.END_DT];
    const endDate = moment(endDateStr);
    if (!endDate.isValid()) {
      throw new Error('Could not parse END_DT from parent data: ' + endDateStr);
    }
    const startDate = endDate.clone().subtract(NUM_DAYS - 1, 'days');
    this.dates = [];
    for (let i = 0; i < NUM_DAYS; i++) {
      this.dates.push(startDate.clone().add(i, 'days'));
    }
  }

  _initTable() {
    // Compute Code column width from actual data
    let codeW = 4; // minimum ("Code".length)
    for (const row of this.childData.rows) {
      const len = (row[this.childCol.UDT02_ID] || '').length;
      if (len > codeW) codeW = len;
    }
    codeW += 2; // padding
    this.table = new Table({
      head: ['Line', 'Code', 'Description', 'Pay', ...this.dates.map(d => d.format('D'))],
      colWidths: [6, codeW, 20, 5, ...this.dates.slice().fill(DAY_COLUMN_WIDTH)],
      colAligns: ['middle', 'left', 'left', 'left', ...this.dates.slice().fill('middle')],
    });
  }

  _buildTableRows() {
    // Clear existing rows
    this.table.length = 0;
    for (let i = 0; i < this.childData.rows.length; i++) {
      const row = this.childData.rows[i];
      const code = row[this.childCol.UDT02_ID] || '';
      const desc = row[this.childCol.LINE_DESC] || '';
      const payType = row[this.childCol.PAY_TYPE] || '';
      const hours = [];
      for (let d = 1; d <= NUM_DAYS; d++) {
        const val = row[this.childCol.DAYS[d - 1]];
        const comment = row[this.childCol.COMMENTS[d - 1]] || '';
        if (val) {
          hours.push(parseFloat(val) + (comment ? '*' : ''));
        } else {
          hours.push('');
        }
      }
      this.table.push([i, code, desc, payType, ...hours]);
    }
  }

  // =========================================================================
  // Command builders — init
  // =========================================================================

  _cmd(reqCd, params) {
    return protocol.buildCommand(reqCd, APP_ID, params);
  }

  _wrap(cmd, opts) {
    return {
      cmd,
      objId: (opts && opts.objId) || '',
      editFlag: (opts && opts.editFlag) || '',
      rowNumber: (opts && opts.rowNumber) || '',
      data: (opts && opts.data) || '',
    };
  }

  _keepalive() {
    return this._wrap(this._cmd(507, [{ code: 'V', value: 'true' }]));
  }

  _get204(rsKey, extra, { nonDb = true, childCursor = '0' } = {}) {
    const childRowCount = this.childData ? this.childData.rows.length : 40;
    const isChild = rsKey === 1;
    const posE = isChild ? Math.max(childRowCount + 5, 40) : 20;
    const negE = -59999 + posE;

    const period = String(this.periodIdx);
    const baseParams = isChild
      ? [
          { code: 'X', value: period },
          { code: 'K', value: '1' },
          { code: 'C', value: childCursor },
          { code: 'P', value: '0' },
          { code: 'V', value: 'true' },
        ]
      : [
          { code: 'K', value: '0' },
          { code: 'C', value: period },
          { code: 'V', value: 'true' },
        ];

    const posParams = [
      { name: 'rsType', value: 'M' },
      { code: 'R', value: 'ABS' },
      { code: 'S', value: '0' },
      { code: 'E', value: String(posE) },
      ...baseParams,
    ];
    const negParams = [
      { name: 'rsType', value: 'M' },
      { code: 'R', value: 'ABS' },
      { code: 'S', value: '-59999' },
      { code: 'E', value: String(negE) },
      ...baseParams,
    ];

    // Parent positive range gets nonDBSize/nonDBStart
    if (rsKey === 0 && nonDb) {
      posParams.push({ name: 'nonDBSize', value: '1' });
      posParams.push({ name: 'nonDBStart', value: '0' });
    }

    if (extra) {
      posParams.push(...extra);
      negParams.push(...extra);
    }

    return [this._wrap(this._cmd(204, posParams)), this._wrap(this._cmd(204, negParams))];
  }

  _buildOpenApp() {
    return protocol.buildRequestBody(this.sid, [
      this._keepalive(),
      this._wrap(
        this._cmd(101, [
          { code: 'V', value: 'true' },
          { name: 'mobileMode', value: 'N' },
          { name: 'checkCache', value: '0' },
        ])
      ),
      this._keepalive(),
    ]);
  }

  _buildOpenRsParent() {
    return protocol.buildRequestBody(this.sid, [
      this._wrap(
        this._cmd(201, [
          { code: 'K', value: '0' },
          { code: 'I', value: 'TMMTS' },
          { code: 'N', value: '17028' },
          { code: 'T', value: 'H' },
          { name: 'checkCache', value: '0' },
          { code: 'C', value: '-60000' },
          { code: 'V', value: 'true' },
        ])
      ),
      this._keepalive(),
    ]);
  }

  _buildInitParent() {
    return protocol.buildRequestBody(this.sid, [
      // 204 K0 positive
      this._wrap(
        this._cmd(204, [
          { name: 'rsType', value: 'M' },
          { code: 'R', value: 'ABS' },
          { code: 'S', value: '0' },
          { code: 'E', value: '20' },
          { code: 'K', value: '0' },
          { code: 'C', value: '-60000' },
          { code: 'V', value: 'true' },
          { name: 'nonDBSize', value: '1' },
          { name: 'nonDBStart', value: '0' },
        ])
      ),
      // 204 K0 negative
      this._wrap(
        this._cmd(204, [
          { name: 'rsType', value: 'M' },
          { code: 'R', value: 'ABS' },
          { code: 'S', value: '-59999' },
          { code: 'E', value: '-59899' },
          { code: 'K', value: '0' },
          { code: 'C', value: '-60000' },
          { code: 'V', value: 'true' },
        ])
      ),
      // 201 OPEN_RS child
      this._wrap(
        this._cmd(201, [
          { code: 'K', value: '1' },
          { code: 'I', value: 'TMMTS_TS_LINE' },
          { code: 'N', value: '17029' },
          { code: 'P', value: '0' },
          { code: 'T', value: 'D' },
          { code: 'X', value: '-60000' },
          { code: 'C', value: '-60000' },
          { code: 'V', value: 'true' },
        ])
      ),
      this._keepalive(),
    ]);
  }

  _buildInitChild() {
    return protocol.buildRequestBody(this.sid, [
      // 204 K1 positive
      this._wrap(
        this._cmd(204, [
          { name: 'rsType', value: 'M' },
          { code: 'R', value: 'ABS' },
          { code: 'S', value: '0' },
          { code: 'E', value: '40' },
          { code: 'X', value: '0' },
          { code: 'K', value: '1' },
          { code: 'C', value: '-60000' },
          { code: 'P', value: '0' },
          { code: 'V', value: 'true' },
        ])
      ),
      // 204 K1 negative
      this._wrap(
        this._cmd(204, [
          { name: 'rsType', value: 'M' },
          { code: 'R', value: 'ABS' },
          { code: 'S', value: '-59999' },
          { code: 'E', value: '-59899' },
          { code: 'X', value: '0' },
          { code: 'K', value: '1' },
          { code: 'C', value: '-60000' },
          { code: 'P', value: '0' },
          { code: 'V', value: 'true' },
        ])
      ),
      this._keepalive(),
    ]);
  }

  /**
   * R=AUTO parent fetch (browser init, captured/prev-period-edit/009). Loads
   * parent rows 1-20 in full on the server; X>0 child fetches depend on it.
   */
  _buildAutoParentFetch() {
    return (
      protocol.buildRequestBody(this.sid, [
        this._wrap(
          this._cmd(204, [
            { name: 'rsType', value: 'M' },
            { code: 'R', value: 'AUTO' },
            { code: 'X', value: '0' },
            { code: 'W', value: '$N$|1:20|0|' },
            { code: 'K', value: '0' },
            { code: 'C', value: '0' },
            { code: 'V', value: 'true' },
          ])
        ),
      ]) + '&autocompletefl=Y'
    );
  }

  /** Parent rows (cursor on idx) + child lines of period idx (capture 013) */
  _buildPeriodFetch(idx) {
    const x = String(idx);
    return protocol.buildRequestBody(this.sid, [
      this._wrap(
        this._cmd(204, [
          { name: 'rsType', value: 'M' },
          { code: 'R', value: 'ABS' },
          { code: 'S', value: '0' },
          { code: 'E', value: '20' },
          { code: 'K', value: '0' },
          { code: 'C', value: x },
          { code: 'V', value: 'true' },
          { name: 'nonDBSize', value: '1' },
          { name: 'nonDBStart', value: '0' },
        ])
      ),
      this._wrap(
        this._cmd(204, [
          { name: 'rsType', value: 'M' },
          { code: 'R', value: 'ABS' },
          { code: 'S', value: '0' },
          { code: 'E', value: '40' },
          { code: 'X', value: x },
          { code: 'K', value: '1' },
          { code: 'C', value: '-60000' },
          { code: 'P', value: '0' },
          { code: 'V', value: 'true' },
          { name: 'nonDBSize', value: '9' },
          { name: 'nonDBStart', value: '0' },
        ])
      ),
      this._wrap(
        this._cmd(204, [
          { name: 'rsType', value: 'M' },
          { code: 'R', value: 'ABS' },
          { code: 'S', value: '-59999' },
          { code: 'E', value: '-59959' },
          { code: 'X', value: x },
          { code: 'K', value: '1' },
          { code: 'C', value: '-60000' },
          { code: 'P', value: '0' },
          { code: 'V', value: 'true' },
        ])
      ),
      this._keepalive(),
    ]);
  }

  // =========================================================================
  // Command builders — revision explanation
  // =========================================================================

  /** Open K2 result set for TMMTS_TS_REVISION_EXP */
  _buildOpenRevisionRS() {
    const cmds = [
      this._wrap(
        this._cmd(201, [
          { code: 'K', value: '2' },
          { code: 'I', value: 'TMMTS_TS_REVISION_EXP' },
          { code: 'N', value: '22410' },
          { code: 'P', value: '0' },
          { code: 'T', value: 'D' },
          { code: 'X', value: String(this.periodIdx) },
          { name: 'checkCache', value: '0' },
          { code: 'C', value: '-60000' },
          { code: 'V', value: 'true' },
        ])
      ),
      this._keepalive(),
    ];
    return protocol.buildRequestBody(this.sid, cmds);
  }

  /** Query K2 revision data and open K3 (TMMTS_TS_AUDIT_EXP) */
  _buildQueryRevisionAndOpenAudit() {
    const cmds = [
      // 204 K2 positive range (SR type for revision data)
      this._wrap(
        this._cmd(204, [
          { name: 'rsType', value: 'SR' },
          { code: 'R', value: 'ABS' },
          { code: 'S', value: '0' },
          { code: 'E', value: '100' },
          { code: 'X', value: String(this.periodIdx) },
          { code: 'K', value: '2' },
          { code: 'C', value: '-60000' },
          { code: 'P', value: '0' },
          { code: 'V', value: 'true' },
          { name: 'nonDBSize', value: '1' },
          { name: 'nonDBStart', value: '0' },
        ])
      ),
      // 204 K2 negative range
      this._wrap(
        this._cmd(204, [
          { name: 'rsType', value: 'SR' },
          { code: 'R', value: 'ABS' },
          { code: 'S', value: '-59999' },
          { code: 'E', value: '-59899' },
          { code: 'X', value: String(this.periodIdx) },
          { code: 'K', value: '2' },
          { code: 'C', value: '-60000' },
          { code: 'P', value: '0' },
          { code: 'V', value: 'true' },
        ])
      ),
      // 201 Open K3 (TMMTS_TS_AUDIT_EXP)
      this._wrap(
        this._cmd(201, [
          { code: 'K', value: '3' },
          { code: 'I', value: 'TMMTS_TS_AUDIT_EXP' },
          { code: 'N', value: '22411' },
          { code: 'P', value: '2' },
          { code: 'T', value: 'D' },
          { code: 'X', value: '-60000' },
          { code: 'C', value: '-60000' },
          { code: 'V', value: 'true' },
        ])
      ),
      this._keepalive(),
    ];
    return protocol.buildRequestBody(this.sid, cmds);
  }

  /** Query K3 audit detail data */
  _buildQueryAudit() {
    const cmds = [
      this._wrap(
        this._cmd(204, [
          { name: 'rsType', value: 'M' },
          { code: 'R', value: 'ABS' },
          { code: 'S', value: '0' },
          { code: 'E', value: '100' },
          { code: 'X', value: '0' },
          { code: 'K', value: '3' },
          { code: 'C', value: '-60000' },
          { code: 'P', value: '2' },
          { code: 'V', value: 'true' },
          { name: 'nonDBSize', value: '20' },
          { name: 'nonDBStart', value: '0' },
        ])
      ),
      this._wrap(
        this._cmd(204, [
          { name: 'rsType', value: 'M' },
          { code: 'R', value: 'ABS' },
          { code: 'S', value: '-59999' },
          { code: 'E', value: '-59899' },
          { code: 'X', value: '0' },
          { code: 'K', value: '3' },
          { code: 'C', value: '-60000' },
          { code: 'P', value: '2' },
          { code: 'V', value: 'true' },
        ])
      ),
      this._keepalive(),
    ];
    return protocol.buildRequestBody(this.sid, cmds);
  }

  // =========================================================================
  // Command builders — leave balances
  // =========================================================================

  /** Open K2 result set for TMMTS_LVSTAT_HDR */
  _buildOpenLeaveBalanceRS() {
    const cmds = [
      this._wrap(
        this._cmd(201, [
          { code: 'K', value: '2' },
          { code: 'I', value: 'TMMTS_LVSTAT_HDR' },
          { code: 'N', value: '17314' },
          { code: 'P', value: '0' },
          { code: 'T', value: 'D' },
          { code: 'X', value: '0' },
          { name: 'checkCache', value: '0' },
          { code: 'C', value: '-60000' },
          { code: 'V', value: 'true' },
        ])
      ),
      this._keepalive(),
    ];
    return protocol.buildRequestBody(this.sid, cmds);
  }

  /** Query K2 leave balance data and open K3 (TMMTS_LV_STAT) */
  _buildQueryLeaveBalancesAndOpenDetail() {
    const cmds = [
      // 204 K2 positive range
      this._wrap(
        this._cmd(204, [
          { name: 'rsType', value: 'M' },
          { code: 'R', value: 'ABS' },
          { code: 'S', value: '0' },
          { code: 'E', value: '100' },
          { code: 'X', value: '0' },
          { code: 'W', value: '' },
          { code: 'K', value: '2' },
          { code: 'C', value: '-60000' },
          { code: 'P', value: '0' },
          { code: 'V', value: 'true' },
          { name: 'nonDBSize', value: '20' },
          { name: 'nonDBStart', value: '0' },
        ])
      ),
      // 204 K2 negative range
      this._wrap(
        this._cmd(204, [
          { name: 'rsType', value: 'M' },
          { code: 'R', value: 'ABS' },
          { code: 'S', value: '-59999' },
          { code: 'E', value: '-59899' },
          { code: 'X', value: '0' },
          { name: 'newQry', value: 'Y' },
          { code: 'K', value: '2' },
          { code: 'C', value: '-60000' },
          { code: 'P', value: '0' },
          { code: 'V', value: 'true' },
        ])
      ),
      // 201 Open K3 (TMMTS_LV_STAT)
      this._wrap(
        this._cmd(201, [
          { code: 'K', value: '3' },
          { code: 'I', value: 'TMMTS_LV_STAT' },
          { code: 'N', value: '17315' },
          { code: 'P', value: '2' },
          { code: 'T', value: 'D' },
          { code: 'X', value: '-60000' },
          { code: 'C', value: '-60000' },
          { code: 'V', value: 'true' },
        ])
      ),
      this._keepalive(),
    ];
    return protocol.buildRequestBody(this.sid, cmds);
  }

  /** Query K3 leave detail data for a specific parent row (leave type) */
  _buildQueryLeaveDetails(parentRowIdx) {
    const x = String(parentRowIdx || 0);
    const cmds = [
      this._wrap(
        this._cmd(204, [
          { name: 'rsType', value: 'M' },
          { code: 'R', value: 'ABS' },
          { code: 'S', value: '0' },
          { code: 'E', value: '100' },
          { code: 'X', value: x },
          { code: 'W', value: '' },
          { code: 'K', value: '3' },
          { code: 'C', value: '-60000' },
          { code: 'P', value: '2' },
          { code: 'V', value: 'true' },
          { name: 'nonDBSize', value: '20' },
          { name: 'nonDBStart', value: '0' },
        ])
      ),
      this._wrap(
        this._cmd(204, [
          { name: 'rsType', value: 'M' },
          { code: 'R', value: 'ABS' },
          { code: 'S', value: '-59999' },
          { code: 'E', value: '-59899' },
          { code: 'X', value: x },
          { name: 'newQry', value: 'Y' },
          { code: 'K', value: '3' },
          { code: 'C', value: '-60000' },
          { code: 'P', value: '2' },
          { code: 'V', value: 'true' },
        ])
      ),
      this._keepalive(),
    ];
    return protocol.buildRequestBody(this.sid, cmds);
  }

  /** Build the save batch with revision explanation PUT to K2 */
  _buildRevisionSaveBatch(explanation) {
    const meta = this._revisionMeta;
    const rowNum = this._revisionRowNum || '-59999';
    const period = String(this.periodIdx);
    const revRow = [
      explanation,
      String(this._revisionNumber),
      '',
      '',
      'N',
      meta.emplId,
      meta.periodNoCd,
      meta.scheduleCd,
      meta.year,
    ];
    const encodedRow = protocol.encodePutRow(revRow) + protocol.DLM_ROW;

    const cmds = [
      // 205 PUT K2: select revision row
      this._wrap(
        this._cmd(205, [
          { name: 'rsRowSelectedFlOnly', value: 'true' },
          { code: 'X', value: period },
          { code: 'K', value: '2' },
          { code: 'C', value: rowNum },
          { code: 'P', value: '0' },
          { code: 'V', value: 'true' },
        ]),
        { data: encodedRow, editFlag: '65619,', rowNumber: rowNum + ',' }
      ),
      // 205 PUT K2: write explanation data
      this._wrap(
        this._cmd(205, [
          { code: 'X', value: period },
          { code: 'K', value: '2' },
          { code: 'C', value: rowNum },
          { code: 'P', value: '0' },
          { code: 'V', value: 'true' },
          { name: 'lastPutId', value: String(this.lastPutId++) },
        ]),
        { data: encodedRow, editFlag: '65619,', rowNumber: rowNum + ',' }
      ),
      // 205 PUT K2: second data write (replicates browser behavior)
      this._wrap(
        this._cmd(205, [
          { code: 'X', value: period },
          { code: 'K', value: '2' },
          { code: 'C', value: rowNum },
          { code: 'P', value: '0' },
          { code: 'V', value: 'true' },
          { name: 'lastPutId', value: String(this.lastPutId++) },
        ]),
        { data: encodedRow, editFlag: '65619,', rowNumber: rowNum + ',' }
      ),
      // 206 SAVE
      this._wrap(
        this._cmd(206, [
          { code: 'G', value: 'false' },
          { code: 'C', value: period },
          { code: 'U', value: 'true' },
          { code: 'K', value: '0' },
          { code: 'V', value: 'true' },
        ])
      ),
      // 204 refresh K0 + K1
      ...this._get204(0),
      ...this._get204(1),
      this._keepalive(),
    ];
    return protocol.buildRequestBody(this.sid, cmds);
  }

  // =========================================================================
  // Command builders — cell edit
  // =========================================================================

  _buildCellEditBatch(lineIdx, rowNum, dayNum) {
    const row = this.childData.rows[lineIdx];
    const encodedRow = protocol.encodePutRow(row);

    const putId = this.lastPutId++;
    const cmds = [
      // 205 PUT K1
      this._wrap(
        this._cmd(205, [
          { code: 'X', value: String(this.periodIdx) },
          { code: 'K', value: '1' },
          { code: 'C', value: '0' },
          { code: 'P', value: '0' },
          { code: 'V', value: 'true' },
          { name: 'lastPutId', value: String(putId) },
        ]),
        {
          data: encodedRow + protocol.DLM_ROW,
          editFlag: '18,',
          rowNumber: rowNum + ',',
        }
      ),
      // 208 VALIDATE
      this._wrap(
        this._cmd(208, [
          { name: 'objectId', value: 'DAY' + dayNum + '_HRS' },
          { code: 'K', value: '1' },
          { code: 'C', value: '0' },
          { code: 'P', value: '0' },
          { code: 'V', value: 'true' },
        ])
      ),
      // 204 K0 positive + negative
      ...this._get204(0),
      // 204 K1 positive + negative
      ...this._get204(1),
      this._keepalive(),
    ];
    return protocol.buildRequestBody(this.sid, cmds);
  }

  // =========================================================================
  // Command builders — save
  // =========================================================================

  _buildSaveBatch() {
    const idx = this.periodIdx;
    const period = String(idx);
    const parentRow = this.parentData.rows[idx];
    const parentRowNum = parseInt(this.parentData.rowNums[idx], 10);
    const encodedParent = protocol.encodePutRow(parentRow);
    // The previous-week save matches the browser (captured/prev-period-edit/
    // 017: editFlag 18). The active week keeps 65562 until the sign bisect
    // (CLAUDE.md) shows whether 18 is safe there too.
    const parentEditFlag = idx === 0 ? '65562,' : '18,';

    // Encode all child rows
    let childDataStr = '';
    let childEditFlags = '';
    let childRowNumbers = '';
    for (let i = 0; i < this.childData.rows.length; i++) {
      childDataStr += protocol.encodePutRow(this.childData.rows[i]) + protocol.DLM_ROW;
      const rowNum = parseInt(this.childData.rowNums[i], 10);
      childEditFlags += rowNum < 0 ? '19,' : '18,';
      childRowNumbers += this.childData.rowNums[i] + ',';
    }

    const cmds = [
      // 205 PUT K0 (parent)
      this._wrap(
        this._cmd(205, [
          { code: 'K', value: '0' },
          { code: 'C', value: period },
          { code: 'V', value: 'true' },
          { name: 'lastPutId', value: String(this.lastPutId++) },
        ]),
        {
          data: encodedParent + protocol.DLM_ROW,
          editFlag: parentEditFlag,
          rowNumber: parentRowNum + ',',
        }
      ),
      // 205 PUT K1 (all child rows)
      this._wrap(
        this._cmd(205, [
          { code: 'X', value: period },
          { code: 'K', value: '1' },
          { code: 'C', value: '0' },
          { code: 'P', value: '0' },
          { code: 'V', value: 'true' },
          { name: 'lastPutId', value: String(this.lastPutId++) },
        ]),
        {
          data: childDataStr,
          editFlag: childEditFlags,
          rowNumber: childRowNumbers,
        }
      ),
      // 206 SAVE
      this._wrap(
        this._cmd(206, [
          { code: 'G', value: 'false' },
          { code: 'C', value: period },
          { code: 'U', value: 'true' },
          { code: 'K', value: '0' },
          { code: 'V', value: 'true' },
        ])
      ),
      // 204 K0 positive + negative
      ...this._get204(0),
      // 204 K1 positive + negative
      ...this._get204(1),
      this._keepalive(),
    ];
    return protocol.buildRequestBody(this.sid, cmds);
  }

  // =========================================================================
  // Command builders — correct (reopen a processed period)
  // =========================================================================

  /**
   * CMD 300 TMMTS_CORRECT_TIMESHEET batch (captured/prev-period-edit/014):
   * PUT K0 selected-flag and context (editFlag 64), PUT K1 row 0 context
   * (editFlag 0), the 300 action, then the 204 refresh.
   */
  _buildCorrectEvent() {
    const idx = this.periodIdx;
    const period = String(idx);
    const encodedParent = protocol.encodePutRow(this.parentData.rows[idx]) + protocol.DLM_ROW;
    const parentRowNum = this.parentData.rowNums[idx] + ',';
    this._actionSeq = (this._actionSeq || 0) + 1;

    const cmds = [
      this._wrap(
        this._cmd(205, [
          { name: 'rsRowSelectedFlOnly', value: 'true' },
          { code: 'K', value: '0' },
          { code: 'C', value: period },
          { code: 'V', value: 'true' },
        ]),
        { data: encodedParent, editFlag: '64,', rowNumber: parentRowNum }
      ),
      this._wrap(
        this._cmd(205, [
          { name: 'rsContextOnly', value: 'Y' },
          { code: 'K', value: '0' },
          { code: 'C', value: period },
          { code: 'V', value: 'true' },
          { name: 'lastPutId', value: String(this.lastPutId++) },
        ]),
        { data: encodedParent, editFlag: '64,', rowNumber: parentRowNum }
      ),
    ];

    if (this.childData.rows.length > 0) {
      cmds.push(
        this._wrap(
          this._cmd(205, [
            { code: 'X', value: period },
            { name: 'rsContextOnly', value: 'Y' },
            { code: 'K', value: '1' },
            { code: 'C', value: '0' },
            { code: 'P', value: '0' },
            { code: 'V', value: 'true' },
            { name: 'lastPutId', value: String(this.lastPutId++) },
          ]),
          {
            data: protocol.encodePutRow(this.childData.rows[0]) + protocol.DLM_ROW,
            editFlag: '0,',
            rowNumber: this.childData.rowNums[0] + ',',
          }
        )
      );
    }

    cmds.push(
      this._wrap(
        this._cmd(300, [
          ...this._actionBoilerplate(),
          { name: 'actionId', value: 'TMMTS_CORRECT_TIMESHEET' },
          { name: 'restartFl', value: 'false' },
          { code: 'C', value: period },
          { name: 'longRunActionFl', value: '0' },
          { name: 'procUniqueId', value: APP_ID + ':A:' + this.sid + ':' + this._actionSeq },
          { name: 'psSchWorkflowNotifyFl', value: 'false' },
          { code: 'K', value: '0' },
          { code: 'V', value: 'true' },
        ])
      ),
      ...this._get204(0),
      ...this._get204(1),
      this._keepalive()
    );

    // reqIdx=1 accompanies CMD 300 action requests (matches browser capture)
    return protocol.buildRequestBody(this.sid, cmds) + '&reqIdx=1';
  }

  /**
   * Commit the correction (captured/prev-period-edit/015): PUT K0 with
   * editFlag 82 + CMD 206, then the browser's post-action refreshes.
   */
  _buildCorrectSaveBatch() {
    const idx = this.periodIdx;
    const period = String(idx);
    const cmds = [
      this._wrap(
        this._cmd(205, [
          { code: 'K', value: '0' },
          { code: 'C', value: period },
          { code: 'V', value: 'true' },
          { name: 'lastPutId', value: String(this.lastPutId++) },
        ]),
        {
          data: protocol.encodePutRow(this.parentData.rows[idx]) + protocol.DLM_ROW,
          editFlag: '82,',
          rowNumber: this.parentData.rowNums[idx] + ',',
        }
      ),
      this._wrap(
        this._cmd(206, [
          { code: 'G', value: 'false' },
          { code: 'C', value: period },
          { code: 'U', value: 'true' },
          { code: 'K', value: '0' },
          { code: 'V', value: 'true' },
        ])
      ),
      ...this._getActionSaveRefresh(),
      this._keepalive(),
    ];
    return protocol.buildRequestBody(this.sid, cmds);
  }

  // =========================================================================
  // Command builders — charge lookup (multi-charge resolution)
  // =========================================================================

  /**
   * Find the charge row matching the desired pay type in HLKP results.
   * Uses K2 col[15] (PAY_TYPE) for matching — verified from captured HLKP data.
   */
  _findChargeRow(rows, payType) {
    const K2_PAY_TYPE_COL = 15;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][K2_PAY_TYPE_COL] === payType) return i;
    }
    return -1;
  }

  /**
   * Build CMD 201 batch to open the K2 charge lookup RS.
   * Sends current child row state before opening.
   */
  _buildOpenRsChargeLookup() {
    // Find the new row (negative rowNum)
    const newRowIdx = this.childData.rowNums.findIndex(n => parseInt(n, 10) < 0);
    if (newRowIdx < 0) throw new Error('No new row found for charge lookup');

    const newRow = this.childData.rows[newRowIdx];
    const rowNum = this.childData.rowNums[newRowIdx];
    const encodedRow = protocol.encodePutRow(newRow);

    const cmds = [
      // PUT K1 (current child row state)
      this._wrap(
        this._cmd(205, [
          { code: 'X', value: String(this.periodIdx) },
          { code: 'K', value: '1' },
          { code: 'C', value: rowNum },
          { code: 'P', value: '0' },
          { code: 'V', value: 'true' },
          { name: 'lastPutId', value: String(this.lastPutId++) },
        ]),
        {
          data: encodedRow + protocol.DLM_ROW,
          editFlag: '19,',
          rowNumber: rowNum + ',',
        }
      ),
      // 201 OPEN_RS K2 (charge lookup)
      this._wrap(
        this._cmd(201, [
          { code: 'K', value: '2' },
          { code: 'I', value: 'TC_UDT02_CHARGE_LKP' },
          { code: 'N', value: '0' },
          { code: 'L', value: '16' },
          { code: 'P', value: '1' },
          { name: 'objectId', value: 'UDT02_ID' },
          { name: 'checkCache', value: '0' },
          { code: 'C', value: '-60000' },
          { code: 'V', value: 'true' },
        ])
      ),
      this._keepalive(),
    ];
    return protocol.buildRequestBody(this.sid, cmds);
  }

  /**
   * OPEN_RS K2 without the preceding PUT K1 that _buildOpenRsChargeLookup
   * bundles. Matches the captured browser request when the magnifier is
   * clicked with no pending code typed.
   */
  _buildOpenFavoritesLookup() {
    const cmds = [
      this._wrap(
        this._cmd(201, [
          { code: 'K', value: '2' },
          { code: 'I', value: 'TC_UDT02_CHARGE_LKP' },
          { code: 'N', value: '0' },
          { code: 'L', value: '16' },
          { code: 'P', value: '1' },
          { name: 'objectId', value: 'UDT02_ID' },
          { name: 'checkCache', value: '0' },
          { code: 'C', value: '-60000' },
          { code: 'V', value: 'true' },
        ])
      ),
      this._keepalive(),
    ];
    return protocol.buildRequestBody(this.sid, cmds);
  }

  /**
   * CMD 204 HLKP query targeting the server-side favorites level.
   * LVL=2, ROW=0 — distinct from the per-code lookup (LVL=1, ROW=-2).
   * Mirrors the captured browser request when the favorites tab is active.
   */
  _buildFavoritesQuery() {
    // WHERE clause targets the favorites level (LVL=2, ROW=0).
    // C=0 (not -60000) — browser uses top-of-list cursor when no row is selected.
    const where = '1|C^$H_LKP_SEL_LVL$^1^2^0|C^$H_LKP_SEL_ROW$^1^0^0|';
    const cmds = [
      this._wrap(
        this._cmd(204, [
          { name: 'rsType', value: 'L' },
          { code: 'R', value: 'HLKP' },
          { code: 'S', value: '0' },
          { code: 'E', value: '100' },
          { code: 'X', value: '-59999' },
          { code: 'W', value: where },
          { name: 'objectId', value: 'UDT02_ID' },
          { code: 'K', value: '2' },
          { code: 'C', value: '0' },
          { code: 'P', value: '1' },
          { code: 'V', value: 'true' },
        ])
      ),
      this._keepalive(),
    ];
    return protocol.buildRequestBody(this.sid, cmds);
  }

  /**
   * CMD 204 HLKP categories-view query (LVL=1, ROW=-1, no code filter).
   * Mirrors the captured browser request sent immediately after OPEN_RS K2
   * when the charge lookup dialog first opens. Seeds K2 into a state where
   * the subsequent favorites HLKP (LVL=2) returns rows instead of <NO DATA>.
   */
  _buildCategoriesLookup() {
    const where = '1|C^$H_LKP_SEL_LVL$^1^1^0|C^$H_LKP_SEL_ROW$^1^-1^0|';
    const cmds = [
      this._wrap(
        this._cmd(204, [
          { name: 'rsType', value: 'L' },
          { code: 'R', value: 'HLKP' },
          { code: 'S', value: '0' },
          { code: 'E', value: '100' },
          { code: 'X', value: '-59999' },
          { code: 'W', value: where },
          { name: 'objectId', value: 'UDT02_ID' },
          { code: 'K', value: '2' },
          { code: 'C', value: '-60000' },
          { code: 'P', value: '1' },
          { code: 'V', value: 'true' },
        ])
      ),
      this._wrap(
        this._cmd(204, [
          { name: 'rsType', value: 'L' },
          { code: 'R', value: 'HLKP' },
          { code: 'S', value: '-59999' },
          { code: 'E', value: '-59899' },
          { code: 'X', value: '-59999' },
          { name: 'newQry', value: 'Y' },
          { code: 'K', value: '2' },
          { code: 'C', value: '-60000' },
          { code: 'P', value: '1' },
          { code: 'V', value: 'true' },
        ])
      ),
      this._keepalive(),
    ];
    return protocol.buildRequestBody(this.sid, cmds);
  }

  /**
   * Build CMD 204 HLKP batch to fetch available charges for a project code.
   */
  _buildHlkpQuery(code) {
    const where = '1|C^UDT02_ID^9^' + code + '^0|C^$H_LKP_SEL_LVL$^1^1^0|C^$H_LKP_SEL_ROW$^1^-2^0|';

    const cmds = [
      // 204 HLKP positive range
      this._wrap(
        this._cmd(204, [
          { name: 'rsType', value: 'L' },
          { code: 'R', value: 'HLKP' },
          { code: 'S', value: '0' },
          { code: 'E', value: '100' },
          { code: 'X', value: '-59999' },
          { code: 'W', value: where },
          { name: 'objectId', value: 'UDT02_ID' },
          { code: 'K', value: '2' },
          { code: 'C', value: '-60000' },
          { code: 'P', value: '1' },
          { code: 'V', value: 'true' },
        ])
      ),
      // 204 HLKP negative range
      this._wrap(
        this._cmd(204, [
          { name: 'rsType', value: 'L' },
          { code: 'R', value: 'HLKP' },
          { code: 'S', value: '-59999' },
          { code: 'E', value: '-59899' },
          { code: 'X', value: '-59999' },
          { name: 'newQry', value: 'Y' },
          { code: 'K', value: '2' },
          { code: 'C', value: '-60000' },
          { code: 'P', value: '1' },
          { code: 'V', value: 'true' },
        ])
      ),
      this._keepalive(),
    ];
    return protocol.buildRequestBody(this.sid, cmds);
  }

  /**
   * Standard CMD 300 action boilerplate params (report defaults).
   * Required by the framework even for non-report actions.
   */
  _actionBoilerplate() {
    return [
      { name: 'rptPrintAllPages', value: 'Y' },
      { name: 'rptInclCoverPage', value: 'Y' },
      { name: 'printRpt', value: 'N' },
      { name: 'rptScalingFactor', value: 'DFLT' },
      { name: 'rptPrnNofC', value: '1' },
      { name: 'downloadRpt', value: 'Y' },
      { name: 'emailRpt', value: 'N' },
      { name: 'printToFileRpt', value: 'N' },
      { name: 'rptLocale', value: 'VIEW_AS_BUILT' },
      { name: 'runAfterRptFl', value: 'Y' },
      { name: 'archiveRpt', value: 'N' },
      { name: 'rptArchRelativeAbsDt', value: 'Y' },
      { name: 'rptArchNeverDelete', value: 'Y' },
      { name: 'syncRequest', value: 'true' },
      { name: 'rptFormat', value: 'pdf' },
      { name: 'printLocalRpt', value: 'N' },
      { name: 'printSendEmail1', value: 'N' },
      { name: 'printHomePage1', value: 'N' },
      { name: 'printPopupAlert1', value: 'N' },
      { name: 'printSendEmail2', value: 'N' },
      { name: 'printHomePage2', value: 'N' },
      { name: 'printPopupAlert2', value: 'N' },
      { name: 'printSendEmail3', value: 'N' },
      { name: 'printHomePage3', value: 'N' },
      { name: 'printPopupAlert3', value: 'N' },
      { name: 'printSendEmail4', value: 'N' },
      { name: 'printHomePage4', value: 'N' },
      { name: 'printPopupAlert4', value: 'N' },
      { name: 'rptEmailAttachmentCount', value: '0' },
    ];
  }

  /**
   * Build CMD 300 TC_TS_CHARGE_LKP_OK batch with the selected K2 lookup row.
   * Matches the browser's 14-command batch: 6 PUTs + CMD 300 + 6 204s + 507.
   */
  _buildChargeLkpOk(selectedK2Row, k2RowNum) {
    const actionSeq = this._nextActionSeq();
    const newRowIdx = this.childData.rowNums.findIndex(n => parseInt(n, 10) < 0);
    const childRow = this.childData.rows[newRowIdx];
    const period = String(this.periodIdx);
    const parentRow = this.parentData.rows[this.periodIdx];
    const parentRowNum = this.parentData.rowNums[this.periodIdx];

    const encodedK2 = protocol.encodePutRow(selectedK2Row);
    const encodedChild = protocol.encodePutRow(childRow);
    const encodedParent = protocol.encodePutRow(parentRow);

    const childRowCount = this.childData.rows.length;
    const k1PosE = Math.max(childRowCount + 5, 40);
    const k1NegE = -59999 + k1PosE;

    const cmds = [
      // 1. PUT K2 selected ($rsRowSelectedFlOnly$=true, editFlag=64)
      this._wrap(
        this._cmd(205, [
          { name: 'rsRowSelectedFlOnly', value: 'true' },
          { code: 'X', value: '-59999' },
          { code: 'K', value: '2' },
          { code: 'C', value: '0' },
          { code: 'P', value: '1' },
          { code: 'V', value: 'true' },
        ]),
        {
          data: encodedK2 + protocol.DLM_ROW,
          editFlag: '64,',
          rowNumber: k2RowNum + ',',
        }
      ),
      // 2. PUT K1 child (editFlag=19)
      this._wrap(
        this._cmd(205, [
          { code: 'X', value: period },
          { code: 'K', value: '1' },
          { code: 'C', value: '-59999' },
          { code: 'P', value: '0' },
          { code: 'V', value: 'true' },
          { name: 'lastPutId', value: String(this.lastPutId++) },
        ]),
        {
          data: encodedChild + protocol.DLM_ROW,
          editFlag: '19,',
          rowNumber: '-59999,',
        }
      ),
      // 3. PUT K2 selected again (editFlag=64)
      this._wrap(
        this._cmd(205, [
          { code: 'X', value: '-59999' },
          { code: 'K', value: '2' },
          { code: 'C', value: '0' },
          { code: 'P', value: '1' },
          { code: 'V', value: 'true' },
          { name: 'lastPutId', value: String(this.lastPutId++) },
        ]),
        {
          data: encodedK2 + protocol.DLM_ROW,
          editFlag: '64,',
          rowNumber: k2RowNum + ',',
        }
      ),
      // 4. PUT K1 child context ($rsContextOnly$=Y)
      this._wrap(
        this._cmd(205, [
          { code: 'X', value: period },
          { name: 'rsContextOnly', value: 'Y' },
          { code: 'K', value: '1' },
          { code: 'C', value: '-59999' },
          { code: 'P', value: '0' },
          { code: 'V', value: 'true' },
          { name: 'lastPutId', value: String(this.lastPutId++) },
        ]),
        {
          data: encodedChild + protocol.DLM_ROW,
          editFlag: '19,',
          rowNumber: '-59999,',
        }
      ),
      // 5. PUT K0 parent context ($rsContextOnly$=Y, editFlag=65562)
      this._wrap(
        this._cmd(205, [
          { name: 'rsContextOnly', value: 'Y' },
          { code: 'K', value: '0' },
          { code: 'C', value: period },
          { code: 'V', value: 'true' },
          { name: 'lastPutId', value: String(this.lastPutId++) },
        ]),
        {
          data: encodedParent + protocol.DLM_ROW,
          editFlag: '65562,',
          rowNumber: parentRowNum + ',',
        }
      ),
      // 6. PUT K2 selected context ($rsContextOnly$=Y)
      this._wrap(
        this._cmd(205, [
          { code: 'X', value: '-59999' },
          { name: 'rsContextOnly', value: 'Y' },
          { code: 'K', value: '2' },
          { code: 'C', value: '0' },
          { code: 'P', value: '1' },
          { code: 'V', value: 'true' },
          { name: 'lastPutId', value: String(this.lastPutId++) },
        ]),
        {
          data: encodedK2 + protocol.DLM_ROW,
          editFlag: '64,',
          rowNumber: k2RowNum + ',',
        }
      ),
      // 7. CMD 300 TC_TS_CHARGE_LKP_OK
      this._wrap(
        this._cmd(300, [
          ...this._actionBoilerplate(),
          { name: 'actionId', value: 'TC_TS_CHARGE_LKP_OK' },
          { name: 'restartFl', value: 'false' },
          { code: 'C', value: '0' },
          { name: 'longRunActionFl', value: '0' },
          { name: 'procUniqueId', value: APP_ID + ':A:' + this.sid + ':' + actionSeq },
          { name: 'psSchWorkflowNotifyFl', value: 'false' },
          { code: 'K', value: '2' },
          { code: 'P', value: '1' },
          { code: 'V', value: 'true' },
        ])
      ),
      // 8-9. 204 K0 positive + negative
      ...this._get204(0),
      // 10-11. 204 K1 positive + negative (C=-59999 for charge lookup context)
      this._wrap(
        this._cmd(204, [
          { name: 'rsType', value: 'M' },
          { code: 'R', value: 'ABS' },
          { code: 'S', value: '0' },
          { code: 'E', value: String(k1PosE) },
          { code: 'X', value: period },
          { code: 'K', value: '1' },
          { code: 'C', value: '-59999' },
          { code: 'P', value: '0' },
          { code: 'V', value: 'true' },
        ])
      ),
      this._wrap(
        this._cmd(204, [
          { name: 'rsType', value: 'M' },
          { code: 'R', value: 'ABS' },
          { code: 'S', value: '-59999' },
          { code: 'E', value: String(k1NegE) },
          { code: 'X', value: period },
          { code: 'K', value: '1' },
          { code: 'C', value: '-59999' },
          { code: 'P', value: '0' },
          { code: 'V', value: 'true' },
        ])
      ),
      // 12-13. 204 K2 positive + negative (rsType=L for lookup)
      this._wrap(
        this._cmd(204, [
          { name: 'rsType', value: 'L' },
          { code: 'R', value: 'ABS' },
          { code: 'S', value: '0' },
          { code: 'E', value: '100' },
          { code: 'X', value: '-59999' },
          { name: 'objectId', value: 'UDT02_ID' },
          { code: 'K', value: '2' },
          { code: 'C', value: '0' },
          { code: 'P', value: '1' },
          { code: 'V', value: 'true' },
        ])
      ),
      this._wrap(
        this._cmd(204, [
          { name: 'rsType', value: 'L' },
          { code: 'R', value: 'ABS' },
          { code: 'S', value: '-59999' },
          { code: 'E', value: '-59899' },
          { code: 'X', value: '-59999' },
          { code: 'K', value: '2' },
          { code: 'C', value: '0' },
          { code: 'P', value: '1' },
          { code: 'V', value: 'true' },
        ])
      ),
      // 14. keepalive
      this._keepalive(),
    ];
    // reqIdx tells the server the action context (K2, the charge lookup RS).
    // Without this, the server ignores the K2 row selection.
    return protocol.buildRequestBody(this.sid, cmds) + '&reqIdx=' + actionSeq;
  }
}

DirectClient.RevisionRequiredError = RevisionRequiredError;
DirectClient.RequestTimeoutError = RequestTimeoutError;
DirectClient.SessionExpiredError = SessionExpiredError;
DirectClient.SaveOutcomeUnknownError = SaveOutcomeUnknownError;
DirectClient.ResponseTooLargeError = ResponseTooLargeError;
DirectClient.requestTimeoutMs = requestTimeoutMs;
DirectClient.MAX_RESPONSE_BYTES = MAX_RESPONSE_BYTES;
DirectClient.resolveParentColumns = resolveParentColumns;
DirectClient.resolveChildColumns = resolveChildColumns;
DirectClient.CAPTURE_PARENT_COL = PARENT_COL;
DirectClient.CAPTURE_CHILD_COL = CHILD_COL;
DirectClient.TRACE_MAX_BYTES = TRACE_MAX_BYTES;
module.exports = DirectClient;
