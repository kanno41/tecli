'use strict';

// Wire format of the Costpoint binary protocol, server side. Encodes what
// protocol.js decodes (responses) and decodes what protocol.js encodes
// (requests).

const protocol = require('../protocol');

const { DLM_RS, DLM_CMD, DLM_ROW, DLM_PARAM, DLM_NAMED } = protocol;

const APP_ID = 'TMMTIMESHEET';
const COMMA = '\x0B';
const NULL_CELL = '\x06';
// Characters the decoder treats as markers; allowed whitespace is \t \n \r
const FORBIDDEN_IN_CELL = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;

function encodeCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  // An empty string would decode as "same as the row above", so always mark it
  if (s === '') return NULL_CELL;
  if (FORBIDDEN_IN_CELL.test(s)) {
    throw new Error('Cell contains a control character: ' + JSON.stringify(s));
  }
  return s;
}

/**
 * Inverse of protocol.decodeData. Never compressed: every cell is written
 * out, empty cells as \x06.
 */
function encodeData(rows, numCols) {
  const cells = [];
  for (const row of rows) {
    if (row.length !== numCols) {
      throw new Error('Row has ' + row.length + ' cells, expected ' + numCols);
    }
    for (const value of row) cells.push(encodeCell(value));
  }
  return numCols + ',' + cells.join(COMMA);
}

/**
 * One 204 data slot, the inverse of protocol.decode204Data.
 * rowNums and rowFlags are per row; rows are arrays of numCols cells.
 */
function encode204Slot({ rowNums, rowFlags, rows }, numCols) {
  return [
    null,
    rowNums.map(String).join(COMMA),
    (rowFlags || rowNums.map(() => 0)).map(String).join(COMMA),
    new Array(numCols).fill('0').join(COMMA),
    encodeData(rows, numCols),
  ];
}

/**
 * items: [{ rsKey, cmdCd, start, end, slot, rescd, error }], one per frame.
 * slot is a 204 data slot or absent (<NO DATA>); rescd defaults to 1 for a
 * slot and 0 otherwise; error is the message of a failed frame.
 */
function buildResponse(items) {
  const frames = items.map(f =>
    [APP_ID, f.rsKey, f.cmdCd, f.start === undefined ? 0 : f.start, f.end === undefined ? 0 : f.end, 0, 0].join('|')
  );
  const rescds = items.map(f => String(f.rescd !== undefined ? f.rescd : f.slot ? 1 : 0)).join(COMMA);
  const datas = items.map(f => f.slot || '<NO DATA>');
  const errors = items.map(f => (f.error ? [[f.error, []]] : '<OK>'));
  const body = [frames, rescds, datas, errors].map(v => JSON.stringify(v));
  // OPEN_RS column names ride in slot 5 as D.V(g,"maObjId",...), uncompressed
  const named = items.filter(f => f.columnNames);
  if (named.length > 0) {
    body.push(
      '[]',
      '[' +
        named.map(f => 'function(g){D.V(g,"maObjId",' + JSON.stringify(f.columnNames.join(COMMA)) + ');}').join(',') +
        ']'
    );
  }
  return 'var responses=[' + body.join(',') + '];';
}

function parseCommand(cmd) {
  const aIdx = cmd.indexOf('A');
  const reqCd = parseInt(cmd.substring(0, aIdx), 10);
  const dIdx = cmd.indexOf(DLM_CMD + 'D');
  const appId = cmd.substring(aIdx + 1, dIdx);
  const paramStr = cmd.substring(dIdx + DLM_CMD.length + 1, cmd.length - DLM_CMD.length);
  const codes = {};
  const named = {};
  for (const token of paramStr.split(DLM_PARAM)) {
    if (!token) continue;
    if (token[0] === '$') {
      const [name, value] = token.split(DLM_NAMED);
      named[name.slice(1, -1)] = value;
    } else {
      codes[token[0]] = token.substring(1);
    }
  }
  return { reqCd, appId, codes, named };
}

/**
 * Split a MasterServlet POST body into commands. Per command: reqCd, appId,
 * codes ({K: '1', ...}), named ({rsType: 'M', ...}), objId, editFlag (list),
 * rowNumber (list) and data (list of encoded PUT rows).
 */
function parseRequest(body) {
  const params = new URLSearchParams(body);
  const split = key => (params.get(key) || '').split(DLM_RS);
  const cmds = split('cmd').filter(Boolean);
  const objIds = split('objId');
  const editFlags = split('editFlag');
  const rowNumbers = split('rowNumber');
  const datas = split('data');
  const list = s => (s || '').split(',').filter(x => x !== '');
  const commands = cmds.map((cmd, i) => ({
    ...parseCommand(cmd),
    objId: objIds[i] || '',
    editFlag: list(editFlags[i]),
    rowNumber: list(rowNumbers[i]),
    data: (datas[i] || '').split(DLM_ROW).filter(Boolean),
  }));
  return { sid: params.get('sid') || '', commands };
}

/**
 * Inverse of protocol.encodePutRow. Trailing empty cells are part of the
 * encoding, so the row decodes to exactly the fields that were encoded.
 */
function decodePutRow(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '0') {
      out.push('');
      i++;
    } else if (ch === '?') {
      const digits = parseInt(s[i + 1], 10);
      const count = parseInt(s.substr(i + 2, digits), 10);
      for (let k = 0; k < count; k++) out.push('');
      i += 2 + digits;
    } else if (ch >= 'A' && ch <= 'Z') {
      const len = ch.charCodeAt(0) - 64;
      out.push(s.substr(i + 1, len));
      i += 1 + len;
    } else if (ch >= 'a' && ch <= 'z') {
      const len = ch.charCodeAt(0) - 70;
      out.push(s.substr(i + 1, len));
      i += 1 + len;
    } else if (ch >= '1' && ch <= '9') {
      const digits = parseInt(ch, 10);
      const len = parseInt(s.substr(i + 1, digits), 10);
      out.push(s.substr(i + 1 + digits, len));
      i += 1 + digits + len;
    } else {
      throw new Error('Bad PUT row at ' + i + ': ' + JSON.stringify(s.substr(i, 12)));
    }
  }
  return out;
}

/**
 * Parse a W clause: '1|C^UDT02_ID^9^CODE^0|C^$H_LKP_SEL_LVL$^1^1^0|...'.
 * Returns { name: value } for the C^ conditions.
 */
function parseWhere(w) {
  const out = {};
  for (const token of (w || '').split('|')) {
    if (!token.startsWith('C^')) continue;
    const parts = token.split('^');
    out[parts[1]] = parts[3];
  }
  return out;
}

module.exports = {
  APP_ID,
  encodeData,
  encode204Slot,
  buildResponse,
  parseRequest,
  decodePutRow,
  parseWhere,
};
