'use strict';

// Command handlers of the mock MasterServlet. A request is a batch of
// commands; each handler returns the response frames for its command.
// What the mock emulates, and the quirks it can reproduce, is described in
// decisions/mock-backend.md.

const codec = require('./codec');
const { PARENT, CHILD, CHARGE, toNumber } = require('./state');

const SESSION_NOT_VALID = 'parent.onServletException("Session not valid");\nsession not valid';
const RIGHTS_ERROR = 'You do not have rights to execute this process';
const EXPLANATION_ERROR = 'Explanation or Reject Reason is required.';
const INVALID_CHARGE_ERROR = 'Invalid charge.';
const DELETE_INVALID_LINE_ERROR =
  'One or more charge lines were invalid and could not be added to timesheet because certain required values were invalid or could not be calculated.';
const PENDING_ROW = '-59999';
const PARENT_PAGE = 20;
const AUDIT_COLS = 8;
const REVISION_COLS = 9;

const DEFAULT_QUIRKS = ['sign-poison', 'auto-required', 'favorites-primer'];

function parseQuirks(value) {
  if (value === undefined || value === null) return new Set(DEFAULT_QUIRKS);
  const list = Array.isArray(value) ? value : String(value).split(',');
  return new Set(list.map(q => q.trim()).filter(Boolean));
}

// ─── Helpers ──────────────────────────────────────────────────────────────

const int = (v, fallback = 0) => {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
};

function padRow(row, width) {
  const out = row.slice();
  while (out.length < width) out.push('');
  return out;
}

function slotOf(rowNums, rows, numCols) {
  return codec.encode204Slot({ rowNums, rowFlags: rowNums.map(() => 0), rows }, numCols);
}

function dataFrame(rsKey, cmd, rowNums, rows, numCols) {
  const start = int(cmd.codes.S);
  const frame = { rsKey, cmdCd: 204, start, end: cmd.codes.E };
  if (rows.length > 0) frame.slot = slotOf(rowNums, rows, numCols);
  return [frame];
}

function noData(rsKey, cmd) {
  return [{ rsKey, cmdCd: cmd.reqCd, start: int(cmd.codes.S), end: cmd.codes.E }];
}

function linesOf(env, idx) {
  const buf = env.session.buffers.get(idx);
  return buf ? buf.lines : env.db.lines(idx);
}

function pendingLine(env, idx) {
  return linesOf(env, idx).find(l => int(l.rowNum) < 0);
}

function snapshot(period) {
  return { ...period, cols: { ...period.cols } };
}

// ─── Queries (204) ────────────────────────────────────────────────────────

function queryParent(cmd, env) {
  const { db, ctx } = env;
  const start = int(cmd.codes.S);
  if (start < 0 || ctx.suppress204) return noData(0, cmd);
  const cursor = Math.max(int(cmd.codes.C), 0);
  const count = Math.min(PARENT_PAGE, db.periodCount);
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push(db.parentRow(i, { full: i === cursor, view: ctx.stale.get(i) }));
  }
  return dataFrame(
    0,
    cmd,
    rows.map((_, i) => String(i)),
    rows,
    db.cols.parent
  );
}

function queryChild(cmd, env) {
  const { quirks, session, ctx, db } = env;
  if (ctx.suppress204) return noData(1, cmd);
  let idx = int(cmd.codes.X);
  // Live bug: without the R=AUTO parent fetch the server answers X>0 with
  // the active week's lines
  if (quirks.has('auto-required') && !session.autoLoaded && idx > 0) idx = 0;
  const negative = int(cmd.codes.S) < 0;
  const lines = linesOf(env, idx).filter(l => int(l.rowNum) < 0 === negative);
  return dataFrame(
    1,
    cmd,
    lines.map(l => l.rowNum),
    lines.map(l => l.row),
    db.cols.child
  );
}

function chargeRows(env, charges) {
  const { db } = env;
  return charges.map(c => db.chargeRow(c, { multi: db.chargesFor(c.code).length > 1 }));
}

function favoriteCharges(env) {
  const { db } = env;
  return db.favorites.map(f => {
    const matches = db.chargesFor(f.code).filter(c => (c.payType || '') === (f.payType || ''));
    const found = matches.find(c => c.favorite) || matches[0];
    return found || { code: f.code, payType: f.payType, desc: f.desc, project: '', account: '' };
  });
}

function queryChargeLookup(cmd, env) {
  const { db, session, quirks } = env;
  if (cmd.codes.R !== 'HLKP' || int(cmd.codes.S) < 0) return noData(2, cmd);
  const where = codec.parseWhere(cmd.codes.W);
  const level = where.$H_LKP_SEL_LVL$;
  const row = where.$H_LKP_SEL_ROW$;
  let charges = [];
  if (level === '1' && row === '-2') {
    // A per-code lookup leaves K2 unprepared for the favorites level
    session.favoritesPrimed = false;
    charges = db.chargesFor(where.UDT02_ID);
  } else if (level === '1' && row === '-1') {
    session.favoritesPrimed = true;
  } else if (level === '2' && row === '0') {
    if (session.favoritesPrimed || !quirks.has('favorites-primer')) charges = favoriteCharges(env);
  }
  const rows = chargeRows(env, charges);
  return dataFrame(
    2,
    cmd,
    rows.map((_, i) => String(i)),
    rows,
    db.cols.charge
  );
}

function revisionMeta(db) {
  return [db.employee.id, '1', '01-SER40Y', String(db.today).substring(0, 4)];
}

function revisionRow(db, explanation, revNo) {
  return [explanation, String(revNo), '', '', 'N', ...revisionMeta(db)];
}

function queryRevision(cmd, env) {
  const { db, session } = env;
  const idx = session.revisionPeriod !== undefined ? session.revisionPeriod : int(cmd.codes.X);
  const negative = int(cmd.codes.S) < 0;
  let rows;
  let rowNums;
  if (negative) {
    rows = [revisionRow(db, '', db.nextRevisionNo(idx))];
    rowNums = [PENDING_ROW];
  } else {
    const revs = db.period(idx).revisions;
    rows = revs.map(r => revisionRow(db, r.explanation, r.revNo));
    rowNums = revs.map((_, i) => String(i));
  }
  return dataFrame(2, cmd, rowNums, rows, REVISION_COLS);
}

function queryAudit(cmd, env) {
  const { db, session } = env;
  if (int(cmd.codes.S) < 0) return noData(3, cmd);
  const idx = session.revisionPeriod !== undefined ? session.revisionPeriod : 0;
  const pending = (session.pendingAudit.get(idx) || []).map(r => [String(db.nextRevisionNo(idx)), ...r]);
  const rows = [...db.period(idx).audit, ...pending];
  return dataFrame(
    3,
    cmd,
    rows.map((_, i) => String(i)),
    rows,
    AUDIT_COLS
  );
}

function queryLeaveBalances(cmd, env) {
  const { db } = env;
  if (int(cmd.codes.S) < 0) return noData(2, cmd);
  const rows = db.leave.balances.map(b => [b.description, String(b.balance), b.code]);
  return dataFrame(
    2,
    cmd,
    rows.map((_, i) => String(i)),
    rows,
    3
  );
}

function queryLeaveDetails(cmd, env) {
  const { db } = env;
  if (int(cmd.codes.S) < 0) return noData(3, cmd);
  const balance = db.leave.balances[int(cmd.codes.X)];
  const details = (balance && db.leave.details[balance.code]) || [];
  const rows = details.map(d => [d.date, d.type, String(d.hours), d.reason, d.code, d.desc]);
  return dataFrame(
    3,
    cmd,
    rows.map((_, i) => String(i)),
    rows,
    6
  );
}

const RS_QUERIES = {
  TC_UDT02_CHARGE_LKP: queryChargeLookup,
  TMMTS_TS_REVISION_EXP: queryRevision,
  TMMTS_TS_AUDIT_EXP: queryAudit,
  TMMTS_LVSTAT_HDR: queryLeaveBalances,
  TMMTS_LV_STAT: queryLeaveDetails,
};

function query(cmd, env) {
  const k = int(cmd.codes.K);
  // The status/count fetch gets no frame: extract204 merges every 204 frame
  // of a result set, so a frame here would corrupt the data
  if (cmd.codes.R === 'S&C') return [];
  if (k === 0 && cmd.codes.R === 'AUTO') {
    env.session.autoLoaded = true;
    return [{ rsKey: 0, cmdCd: 204, start: 0, end: 'null' }];
  }
  if (k === 0) return queryParent(cmd, env);
  if (k === 1) return queryChild(cmd, env);
  const run = RS_QUERIES[env.session.openRs[k]];
  return run ? run(cmd, env) : noData(k, cmd);
}

// ─── Open result set (201) ────────────────────────────────────────────────

const PARENT_NAMES = {
  [PARENT.NAME]: 'EMPL_FULL_NAME',
  [PARENT.EMPL_ID]: 'EMPL_ID',
  [PARENT.SCHEDULE_DESC]: 'SCHEDULE_DESC_AND_P_TEXT',
  [PARENT.END_DT]: 'END_DT',
  [PARENT.STATUS]: 'S_STATUS_CD',
  [PARENT.ACTION_CD]: 'ACTION_CD',
  [PARENT.ENABLE_SIGN_FL]: 'ENABLE_SIGN_FL',
  [PARENT.ENABLE_CORRECT_FL]: 'ENABLE_CORRECT_FL',
  [PARENT.TS_CLOSED_FL]: 'TS_CLOSED_FL',
};

// Child columns direct.js resolves by name, at the 402-column capture layout
const CHILD_NAMES = {
  0: 'S_APPROVE_STATUS_CD',
  [CHILD.LINE_NO]: 'DISPLAY_LINE_NO',
  [CHILD.DESC]: 'LINE_DESC',
  [CHILD.CODE]: 'UDT02_ID',
  [CHILD.WORK_LOCATION]: 'UDT03_ID',
  [CHILD.PAY_TYPE]: 'UDT10_ID',
  ...Object.fromEntries(CHILD.DAYS.map((c, i) => [c, 'DAY' + (i + 1) + '_HRS'])),
  ...Object.fromEntries(CHILD.COMMENTS.map((c, i) => [c, 'COMMENT___DAY' + (i + 1) + '_HRS'])),
  [CHILD.CHARGE_PROJECT]: 'CHARGE_BRANCH_CD_U2_CHG_LKUP',
  [CHILD.CHARGE_COMBINED]: 'CHARGE_CD_U2_CHG_LKUP',
  [CHILD.CHARGE_FLAG]: 'CHARGE_TREE_CD_U2_CHG_LKUP',
  [CHILD.CHARGE_PAY_TYPE]: 'UDT10_ID_U2_CHG_LKUP',
  [CHILD.CHARGE_WORK_LOCATION]: 'UDT03_ID_U2_CHG_LKUP',
  [CHILD.CHARGE_PROJECT_ID]: 'UDT02_DISPLAY',
  [CHILD.SEQ]: 'LINE_NO',
  150: 'COST_FL',
  151: 'COUNT_ROW',
  187: 'EMPL_ID',
  193: 'HRS_INCREMENT_CD',
  194: 'HRS_MODIFY_FL',
  196: 'IS_AMBIGUOUS_LKP',
  197: 'IS_PROCESSED_FL',
  234: 'OT_FL',
  235: 'PERIOD_NO_CD',
  336: 'TS_SCHEDULE_CD',
  393: 'UDT_FROM_LKP_FL',
  398: 'YEAR_NO_CD',
};

// Charge lookup columns direct.js resolves by name (captured/past-week-add/015)
const CHARGE_NAMES = {
  [CHARGE.DESC]: 'DESC_DISPLAY',
  [CHARGE.PROJECT]: 'CHARGE_BRANCH_CD',
  [CHARGE.CODE]: 'UDT02_ID',
  [CHARGE.WORK_LOCATION]: 'UDT03_ID',
  [CHARGE.PAY_TYPE]: 'UDT10_ID',
  [CHARGE.COMBINED]: 'CHARGE_CD',
  [CHARGE.FLAG]: 'CHARGE_TREE_CD',
  [CHARGE.IS_FAVORITE]: 'IS_FAVORITE',
  [CHARGE.PROJECT_ID]: 'PARENT_CHG_BR_CD',
  [CHARGE.ALT_CODE]: 'UDT02_DISPLAY',
};

function columnNames(named, width) {
  return Array.from({ length: width }, (_, i) => named[i] || 'COL' + i);
}

function openRs(cmd, env) {
  const k = int(cmd.codes.K);
  env.session.openRs[k] = cmd.codes.I;
  if (cmd.codes.I === 'TC_UDT02_CHARGE_LKP') env.session.favoritesPrimed = false;
  if (k === 0) return [{ rsKey: k, cmdCd: 201, columnNames: columnNames(PARENT_NAMES, env.db.cols.parent) }];
  if (k === 1) return [{ rsKey: k, cmdCd: 201, columnNames: columnNames(CHILD_NAMES, env.db.cols.child) }];
  if (cmd.codes.I === 'TC_UDT02_CHARGE_LKP') {
    return [{ rsKey: k, cmdCd: 201, columnNames: columnNames(CHARGE_NAMES, env.db.cols.charge) }];
  }
  return [{ rsKey: k, cmdCd: 201 }];
}

// ─── Put (205) ────────────────────────────────────────────────────────────

function putChild(cmd, env) {
  const { db, session } = env;
  const idx = int(cmd.codes.X);
  const buf = session.buffer(db, idx);
  cmd.data.forEach((encoded, i) => {
    const rowNum = cmd.rowNumber[i];
    const row = padRow(codec.decodePutRow(encoded), db.cols.child);
    const at = buf.lines.findIndex(l => l.rowNum === rowNum);
    if (at >= 0) buf.lines[at].row = row;
    else buf.lines.push({ rowNum, row });
  });
  session.lastPut = { idx, rowNum: cmd.rowNumber[0] };
  if (cmd.editFlag.some(f => f !== '0' && f !== '64')) session.worked = true;
}

function putExtra(k, cmd, env) {
  const { session } = env;
  const row = codec.decodePutRow(cmd.data[0] || '');
  const name = session.openRs[k];
  if (name === 'TMMTS_TS_REVISION_EXP' && row[0]) {
    session.explanations.set(int(cmd.codes.X), row[0]);
  } else if (name === 'TC_UDT02_CHARGE_LKP' && row[CHARGE.CODE]) {
    session.selectedCharge = row;
  }
}

function put(cmd, env) {
  const k = int(cmd.codes.K);
  const passive = cmd.named.rsContextOnly === 'Y' || cmd.named.rsRowSelectedFlOnly === 'true';
  if (k === 1 && !passive) putChild(cmd, env);
  else if (k === 0 && !passive) env.session.parentPuts.set(int(cmd.codes.C), codec.decodePutRow(cmd.data[0] || ''));
  else if (k >= 2 && cmd.data.length > 0) putExtra(k, cmd, env);
  // Puts get no frame, which is why a save's 206 frame comes first
  return [];
}

// ─── Validate (208) ───────────────────────────────────────────────────────

const ZIP_RE = /^\d{5}(-\d{4})?$/;

function validateCharge(row, env) {
  const { db } = env;
  const code = row[CHILD.CODE];
  const charges = db.chargesFor(code);
  if (charges.length === 0) return 'Project code ' + code + ' is not valid';
  if (charges.length > 1) {
    // A multi-charge code stays unresolved until the lookup picked a row
    return row[CHILD.CHARGE_PAY_TYPE] ? null : 'More than one charge found';
  }
  const c = charges[0];
  row[CHILD.DESC] = c.desc;
  row[CHILD.ACCOUNT] = c.account;
  row[CHILD.PAY_TYPE] = c.payType;
  // Live keeps the charge columns a lookup copied in (trace, tecli-a1t.12)
  if (!row[CHILD.CHARGE_PROJECT]) {
    row[CHILD.CHARGE_PROJECT] = c.project;
    row[CHILD.CHARGE_COMBINED] = c.code;
    row[CHILD.CHARGE_FLAG] = '1';
    row[CHILD.CHARGE_PAY_TYPE] = c.payType;
    row[CHILD.CHARGE_PROJECT_ID] = c.code;
  }
  if (!row[CHILD.WORK_LOCATION]) row[CHILD.WORK_LOCATION] = db.employee.zip;
  return null;
}

function validate(cmd, env) {
  const { db, session } = env;
  const frame = { rsKey: int(cmd.codes.K), cmdCd: 208 };
  const last = session.lastPut;
  const buf = last && session.buffers.get(last.idx);
  const line = buf && buf.lines.find(l => l.rowNum === last.rowNum);
  if (!line) return [frame];
  const objectId = cmd.named.objectId;
  const day = /^DAY([1-7])_HRS$/.exec(objectId);
  let error = null;
  if (day) {
    const value = line.row[CHILD.DAYS[int(day[1]) - 1]];
    if (value !== '' && Number.isNaN(Number(value))) error = 'Hours must be a number';
    else db.recalcTotals(line.row);
  } else if (objectId === 'UDT02_ID') {
    error = validateCharge(line.row, env);
  } else if (objectId === 'UDT03_ID') {
    if (!ZIP_RE.test(line.row[CHILD.WORK_LOCATION])) error = 'Work location must be a 5-digit zip code';
  }
  if (error) frame.error = error;
  return [frame];
}

// ─── Actions (300) ────────────────────────────────────────────────────────

const ACTIONS = {
  TMMTS_NEW_TS_LINE(cmd, env) {
    const { db, session } = env;
    const idx = int(session.lastPut ? session.lastPut.idx : 0);
    let line = pendingLine(env, idx);
    if (!line) {
      const buf = session.buffer(db, idx);
      line = { rowNum: PENDING_ROW, row: db.childRow({}, buf.lines.length + 1) };
      buf.lines.push(line);
    }
    if (!line.row[CHILD.WORK_LOCATION]) line.row[CHILD.WORK_LOCATION] = db.employee.zip;
    if (!line.row[CHILD.PAY_TYPE]) line.row[CHILD.PAY_TYPE] = 'REG';
    session.worked = true;
  },

  TC_TS_CHARGE_LKP_OK(cmd, env) {
    const { db, session } = env;
    const idx = session.lastPut ? session.lastPut.idx : 0;
    const line = pendingLine(env, idx);
    const sel = session.selectedCharge;
    if (!line || !sel) return;
    const row = line.row;
    row[CHILD.CODE] = sel[CHARGE.CODE];
    row[CHILD.DESC] = sel[CHARGE.DESC];
    row[CHILD.ACCOUNT] = sel[CHARGE.ACCOUNT];
    if (sel[CHARGE.PAY_TYPE]) row[CHILD.PAY_TYPE] = sel[CHARGE.PAY_TYPE];
    // Live echoes the charge columns the client copied from the lookup row
    // (trace, tecli-a1t.12) and checks them on save (chargeError)
    const copied = [
      [CHILD.CHARGE_PROJECT, CHARGE.PROJECT],
      [CHILD.CHARGE_COMBINED, CHARGE.COMBINED],
      [CHILD.CHARGE_FLAG, CHARGE.FLAG],
      [CHILD.CHARGE_PAY_TYPE, CHARGE.PAY_TYPE],
      [CHILD.CHARGE_WORK_LOCATION, CHARGE.WORK_LOCATION],
      [CHILD.CHARGE_PROJECT_ID, CHARGE.ALT_CODE],
    ];
    for (const [to, from] of copied) if (!row[to]) row[to] = sel[from];
    line.charge = sel;
    // A charge with a work location sets it (source C, as the browser sees)
    if (sel[CHARGE.WORK_LOCATION]) row[CHILD.WORK_LOCATION] = sel[CHARGE.WORK_LOCATION];
    if (!row[CHILD.WORK_LOCATION]) row[CHILD.WORK_LOCATION] = db.employee.zip;
  },

  TMMTS_ADD_LINE_TO_FAVORITES(cmd, env) {
    const { db, session, quirks } = env;
    const idx = session.lastPut ? session.lastPut.idx : 0;
    const line = pendingLine(env, idx);
    if (!line) return 'No line to add to favorites';
    db.addFavorite({ code: line.row[CHILD.CODE], payType: line.row[CHILD.PAY_TYPE], desc: line.row[CHILD.DESC] });
    env.persist();
    if (quirks.has('favsave-no204')) session.favSaved = true;
    return undefined;
  },

  TMMTS_CORRECT_TIMESHEET(cmd, env) {
    const idx = int(cmd.codes.C);
    const period = env.db.period(idx);
    if (!(period.closed && period.correctable)) return RIGHTS_ERROR;
    env.session.correctPending.add(idx);
    return undefined;
  },

  TMMTS_SIGN_TIMESHEET(cmd, env) {
    const idx = int(cmd.codes.C);
    const period = env.db.period(idx);
    if (period.status !== 'O' || period.closed) return RIGHTS_ERROR;
    env.session.signPrimed.add(idx);
    return undefined;
  },
};

function action(cmd, env) {
  const frame = { rsKey: int(cmd.codes.K, -1), cmdCd: 300 };
  const run = ACTIONS[cmd.named.actionId];
  const error = run ? run(cmd, env) : undefined;
  if (error) frame.error = error;
  return [frame];
}

// ─── Save (206) ───────────────────────────────────────────────────────────

function changedCells(db, idx, buf) {
  const base = new Map(db.lines(idx).map(l => [l.rowNum, l.row]));
  const dates = db.weekDates(idx);
  const out = [];
  for (const line of buf.lines) {
    const old = base.get(line.rowNum);
    CHILD.DAYS.forEach((col, i) => {
      const before = toNumber(old ? old[col] : '');
      const after = toNumber(line.row[col]);
      if (before !== after) out.push({ row: line.row, date: dates[i], before, after });
    });
  }
  return out;
}

// Audit columns after the revision number: line, date, project, '', account,
// charge description, detail
function auditRow(c) {
  return [
    c.row[CHILD.LINE_NO],
    c.date,
    c.row[CHILD.CODE],
    '',
    c.row[CHILD.ACCOUNT],
    c.row[CHILD.DESC],
    'Hours changed from ' + c.before + ' to ' + c.after,
  ];
}

function commitCorrection(idx, env) {
  const { db, session, quirks, ctx } = env;
  const period = db.period(idx);
  session.correctPending.delete(idx);
  if (quirks.has('correct-stale')) ctx.stale.set(idx, snapshot(period));
  period.status = 'O';
  period.closed = false;
  period.signedOnce = true;
  period.revisions.push({ revNo: db.nextRevisionNo(idx), explanation: '' });
  env.persist();
}

function commitSign(idx, env) {
  const { db, session, quirks, ctx } = env;
  const period = db.period(idx);
  const primed = session.signPrimed.has(idx);
  session.signPrimed.delete(idx);
  const poisoned = quirks.has('sign-poison') && session.worked;
  if (primed && !poisoned && period.status === 'O' && !period.closed) {
    period.status = 'S';
    period.signedOnce = true;
    env.persist();
  }
  // The browser's active-week sign confirm comes back without row data
  if (idx === 0) ctx.suppress204 = true;
}

// Live refuses a line whose branch or display code is not the selected
// charge's (CHARGE_BRANCH_CD, UDT02_DISPLAY; trace saves #23/#61, tecli-a1t.12)
function chargeError(line) {
  const sel = line.charge;
  if (!sel) return false;
  return (
    line.row[CHILD.CHARGE_PROJECT] !== sel[CHARGE.PROJECT] || line.row[CHILD.CHARGE_PROJECT_ID] !== sel[CHARGE.ALT_CODE]
  );
}

function commitBuffer(idx, buf, env) {
  const { db, session, ctx, faults, quirks } = env;
  const period = db.period(idx);
  if (faults && faults.has(idx)) {
    const error = faults.get(idx);
    faults.delete(idx);
    return { rescd: 0, error };
  }
  const explanation = session.explanations.get(idx);
  const cells = changedCells(db, idx, buf);
  if (cells.length > 0 && period.signedOnce && !explanation) {
    session.revisionPeriod = idx;
    session.pendingAudit.set(idx, cells.map(auditRow));
    return { rescd: -1, error: EXPLANATION_ERROR };
  }
  if (buf.lines.some(l => int(l.rowNum) < 0 && !l.row[CHILD.ACCOUNT])) {
    return { rescd: 0, error: 'Account required' };
  }
  if (buf.lines.some(l => int(l.rowNum) < 0 && chargeError(l))) return { rescd: 0, error: INVALID_CHARGE_ERROR };
  db.commitLines(idx, buf.lines);
  // Live: after a committed past-week save the next X>0 read again needs the
  // R=AUTO fetch first (sign-bisect, 2026-10-27, tecli-lok)
  if (quirks.has('auto-required') && idx > 0) session.autoLoaded = false;
  if (explanation) {
    const revNo = db.nextRevisionNo(idx);
    period.revisions.push({ revNo, explanation });
    for (const r of session.pendingAudit.get(idx) || []) period.audit.push([String(revNo), ...r]);
  }
  session.discardBuffer(idx);
  session.worked = true;
  if (session.favSaved || ctx.rowlessSave) {
    ctx.suppress204 = true;
    session.favSaved = false;
  }
  env.persist();
  return {};
}

function commit(cmd, env) {
  const { session } = env;
  const idx = int(cmd.codes.C);
  const frame = { rsKey: int(cmd.codes.K), cmdCd: 206 };
  const parentPut = session.parentPuts.get(idx);
  session.parentPuts.delete(idx);

  if (session.correctPending.has(idx)) {
    commitCorrection(idx, env);
  } else if (parentPut && parentPut[PARENT.ACTION_CD] === 'S') {
    commitSign(idx, env);
  } else {
    const buf = session.buffers.get(idx);
    if (buf) Object.assign(frame, commitBuffer(idx, buf, env));
  }
  return [frame];
}

// ─── Delete row (209) ─────────────────────────────────────────────────────

// The browser's row delete on a pending line (captured/past-week-add/020).
// It carries no period, so it applies to the week of the last child PUT.
// Live Costpoint validates the line first and refuses one with no charge, such
// as the line getFavorites stages (tecli-4c4).
function deleteRow(cmd, env) {
  const { db, session } = env;
  const idx = session.lastPut ? session.lastPut.idx : 0;
  if (int(cmd.codes.K) === 1) {
    const buf = session.buffer(db, idx);
    const line = buf.lines.find(l => l.rowNum === cmd.codes.C);
    if (line && !line.row[CHILD.ACCOUNT]) {
      return [{ rsKey: 1, cmdCd: 209, rescd: -1, error: DELETE_INVALID_LINE_ERROR }];
    }
    buf.lines = buf.lines.filter(l => l.rowNum !== cmd.codes.C);
  }
  return [{ rsKey: int(cmd.codes.K), cmdCd: 209 }];
}

// ─── Dispatch ─────────────────────────────────────────────────────────────

const okFrame = rsKey => cmd => [{ rsKey, cmdCd: cmd.reqCd }];

const HANDLERS = {
  101: okFrame(0),
  201: openRs,
  204: query,
  205: put,
  206: commit,
  208: validate,
  209: deleteRow,
  221: okFrame(-1),
  300: action,
  507: okFrame(-1),
};

/**
 * Run a parsed request. Returns the response text. A repeated action id gets
 * an empty body, like the real server.
 */
function handleRequest(env, commands) {
  const items = [];
  for (const cmd of commands) {
    if (cmd.reqCd === 300 && cmd.named.procUniqueId) {
      if (env.session.procIds.has(cmd.named.procUniqueId)) return '';
      env.session.procIds.add(cmd.named.procUniqueId);
    }
    const run = HANDLERS[cmd.reqCd] || okFrame(int(cmd.codes.K, -1));
    items.push(...run(cmd, env));
  }
  return codec.buildResponse(items);
}

module.exports = { handleRequest, parseQuirks, DEFAULT_QUIRKS, SESSION_NOT_VALID };
