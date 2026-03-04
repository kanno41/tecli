'use strict';

// ---------------------------------------------------------------------------
// Binary encoding/decoding constants (from MasterPage.js lines 126-139)
// ---------------------------------------------------------------------------
const ENCODE_COMMA       = '\x0B';  // field separator
const ENCODE_NULL        = '\x06';  // empty string marker
const ENCODE_PREV_FOUND  = '\x07';  // reference to previous row value
const ENCODE_RUN_LEN     = '\x05';  // run-length marker
const ENCODE_PREV_SUBSTR = '\x0E';  // substring of previous row
const ENCODE_RANGE_DELIM = '\x0F';  // range delimiter in sequences

// Command/request delimiters
const DLM_RS    = 'K\x01';  // command delimiter in batch
const DLM_CMD   = 'C\x05';  // parameter delimiter within command
const DLM_ROW   = 'R\x02';  // row separator in PUT data
const DLM_PARAM = 'P\x07';  // parameter separator
const DLM_NAMED = 'N\x08';  // named parameter separator

// ---------------------------------------------------------------------------
// Response decoding (ported from mock-backend/db.js lines 37-174)
// ---------------------------------------------------------------------------

function decodeSmallNumber(charCode) {
  let idx = charCode;
  if (idx >= 92) idx--;   // skip backslash
  if (idx >= 60) idx--;   // skip '<'
  if (idx >= 39) idx--;   // skip single quote
  if (idx >= 34) idx--;   // skip double quote
  return idx - 32;
}

function decodeNumber(str) {
  let j = decodeSmallNumber(str.charCodeAt(0));
  let l = 1;
  while (l < str.length && str.charAt(l) === ENCODE_RANGE_DELIM) {
    j += decodeSmallNumber(str.charCodeAt(l + 1));
    l += 2;
  }
  return { num: j, idx: l };
}

function decodeRunLen(str) {
  str = str.replace(new RegExp(ENCODE_PREV_FOUND, 'g'), ENCODE_COMMA + ENCODE_PREV_FOUND);
  str = str.replace(new RegExp(ENCODE_PREV_SUBSTR, 'g'), ENCODE_COMMA + ENCODE_PREV_SUBSTR);

  const arr = str.split(ENCODE_RUN_LEN);
  let out = arr[0];
  for (let i = 1; i < arr.length; i++) {
    const o = decodeNumber(arr[i]);
    out += ENCODE_COMMA;
    for (let k = 0; k < o.num; k++) {
      out += ENCODE_COMMA;
    }
    out += arr[i].substring(o.idx);
  }
  return out;
}

function decodeStr(curRow, idx, arr, numCols) {
  const str = arr[idx];
  if (str === '') {
    if (curRow > 0) {
      arr[idx] = arr[idx - numCols];
    }
  } else if (str.charAt(0) === ENCODE_NULL) {
    arr[idx] = '';
  } else if (str.charAt(0) === ENCODE_PREV_FOUND) {
    const lastFound = decodeSmallNumber(str.charCodeAt(1));
    arr[idx] = arr[idx - lastFound * numCols];
  } else if (str.charAt(0) === ENCODE_PREV_SUBSTR) {
    const lastFound = decodeNumber(str.substring(1));
    arr[idx] = arr[idx - numCols].substring(0, lastFound.num) + str.substring(lastFound.idx + 1);
  }
}

function decodeNumsSequence(str) {
  const arr = str.split(ENCODE_COMMA);
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const el = arr[i];
    const idx = el.indexOf(ENCODE_RANGE_DELIM);
    if (idx !== -1) {
      const start = parseInt(el.substring(0, idx), 10);
      const end = parseInt(el.substring(idx + 1), 10);
      for (let j = start; j <= end; j++) {
        out.push(String(j));
      }
    } else {
      out.push(el);
    }
  }
  return out;
}

function decodeNumArray(str) {
  const arr = decodeRunLen(str).split(ENCODE_COMMA);
  for (let i = 0; i < arr.length; i++) {
    decodeStr(i, i, arr, 1);
  }
  return arr;
}

function decodeData(dataStr) {
  const arr = decodeRunLen(dataStr).split(ENCODE_COMMA);
  const data = [];
  const commaIdx = arr[0].indexOf(',');
  const cols = parseInt(arr[0].substring(0, commaIdx), 10);
  const rowCount = Math.floor(arr.length / cols);
  if (rowCount < 1) return data;

  arr[0] = arr[0].substring(commaIdx + 1);
  let i = 0;
  for (let row = 0; row < rowCount; row++) {
    for (let len = i + cols; i < len; i++) {
      decodeStr(row, i, arr, cols);
    }
    data[row] = arr.slice(i - cols, i);
  }
  return data;
}

/**
 * Parse a `var responses=[...]` string into a JS array.
 */
function parseResponse(responseText) {
  // Real server responses may reference browser globals like `parent` (iframe parent frame)
  // and `D` (framework namespace). Define stubs so eval doesn't throw.
  // Use a recursive proxy that absorbs any property access or function call.
  const handler = {
    get: (_, prop) => (prop === Symbol.toPrimitive ? () => '' : noop),
    apply: () => noop,
  };
  const noop = new Proxy(function(){}, handler);
  try {
    const fn = new Function('parent', 'D', 'g', responseText + '\nreturn responses;');
    return fn(noop, noop, noop);
  } catch (e) {
    throw new Error('parseResponse failed: ' + e.message +
      ' | response preview: ' + responseText.substring(0, 300));
  }
}

/**
 * Decode a single 204 data slot from a response.
 * Returns { rowNums, rowFlags, maxWidths, rows } where rows is a 2D array.
 */
function decode204Data(dataSlot) {
  if (!Array.isArray(dataSlot) || dataSlot.length < 5) {
    return null;
  }
  const rowNums = decodeNumsSequence(dataSlot[1]);
  const rowFlags = decodeNumArray(dataSlot[2]);
  const maxWidths = decodeNumArray(dataSlot[3]);
  const rows = decodeData(dataSlot[4]);
  return { rowNums, rowFlags, maxWidths, rows };
}

// ---------------------------------------------------------------------------
// Request encoding (inverse of decodePutRow from server.js:516-550)
// Matches getSysRowData from SqlRowSet.js:1437-1500
// ---------------------------------------------------------------------------

/**
 * Encode a row of field values into the compact length-prefixed PUT format.
 * - Empty string → '0' (or batched via '?' for runs of 4+)
 * - Length 1-26 → chr(64+len) + value
 * - Length 27-52 → chr(70+len) + value
 * - Length 53+ → digitCount + len + value
 */
function encodePutRow(fields) {
  let out = '';
  let nulls = 0;
  for (let i = 0; i < fields.length; i++) {
    const d = fields[i] === null || fields[i] === undefined ? '' : String(fields[i]);
    const l = d.length;

    if (l === 0) {
      nulls++;
    } else {
      if (nulls > 0) {
        if (nulls <= 3) {
          out += '0'.repeat(nulls);
        } else {
          const ns = String(nulls);
          out += '?' + ns.length + ns;
        }
        nulls = 0;
      }
      if (l <= 26) {
        out += String.fromCharCode(64 + l) + d;
      } else if (l <= 52) {
        out += String.fromCharCode(70 + l) + d;
      } else {
        const ls = String(l);
        out += ls.length + ls + d;
      }
    }
  }
  // Flush trailing nulls
  if (nulls > 0) {
    if (nulls <= 3) {
      out += '0'.repeat(nulls);
    } else {
      const ns = String(nulls);
      out += '?' + ns.length + ns;
    }
  }
  return out;
}

/**
 * Build a single command string for the cmd field.
 * Format: {reqCd}A{appId}C\x05D{params}C\x05
 *
 * params is an array of { code, value } or { name, value } objects.
 * - { code: 'K', value: '1' } → K1P\x07
 * - { name: 'objectId', value: 'DAY4_HRS' } → $objectId$N\x08DAY4_HRSP\x07
 */
function buildCommand(reqCd, appId, params) {
  let paramStr = '';
  for (const p of params) {
    if (p.name) {
      paramStr += '$' + p.name + '$' + DLM_NAMED + p.value + DLM_PARAM;
    } else {
      paramStr += p.code + p.value + DLM_PARAM;
    }
  }
  return String(reqCd) + 'A' + appId + DLM_CMD + 'D' + paramStr + DLM_CMD;
}

/**
 * Build the full URL-encoded POST body for MasterServlet.cps.
 *
 * @param {string} sid - Session ID
 * @param {Array} commands - Array of { cmd, objId, editFlag, rowNumber, data }
 *   where cmd is the output of buildCommand(), and the rest are per-command
 *   field values (empty string if not applicable).
 */
function buildRequestBody(sid, commands) {
  let cmdField = '';
  let objIdField = '';
  let editFlagField = '';
  let rowNumberField = '';
  let dataField = '';

  for (const c of commands) {
    cmdField += c.cmd + DLM_RS;
    objIdField += (c.objId || '') + DLM_RS;
    editFlagField += (c.editFlag || '') + DLM_RS;
    rowNumberField += (c.rowNumber || '') + DLM_RS;
    dataField += (c.data || '') + DLM_RS;
  }

  return 'sid=' + sid +
    '&cmd=' + encodeURIComponent(cmdField) +
    '&objId=' + encodeURIComponent(objIdField) +
    '&editFlag=' + encodeURIComponent(editFlagField) +
    '&rowNumber=' + encodeURIComponent(rowNumberField) +
    '&data=' + encodeURIComponent(dataField);
}

/**
 * Parse the frame status array from a response to find data indices.
 * Each frame string: "TMMTIMESHEET|rsKey|cmdCd|start|end|changedFl|deletedFl"
 *
 * Returns array of { appId, rsKey, cmdCd, start, end } objects.
 */
function parseFrames(frameArr) {
  return frameArr.map(f => {
    const parts = f.split('|');
    return {
      appId: parts[0],
      rsKey: parseInt(parts[1], 10),
      cmdCd: parseInt(parts[2], 10),
      start: parseInt(parts[3], 10),
      end: parseInt(parts[4], 10),
    };
  });
}

/**
 * Extract 204 data from a parsed response for a given rsKey.
 * Merges all 204 frames for the rsKey (positive + negative ranges).
 */
function extract204(parsed, rsKey) {
  const frames = parseFrames(parsed[0]);
  const datas = parsed[2];

  let merged = null;
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].cmdCd === 204 && frames[i].rsKey === rsKey) {
      const dataSlot = datas[i];
      if (Array.isArray(dataSlot)) {
        const decoded = decode204Data(dataSlot);
        if (decoded) {
          if (!merged) {
            merged = decoded;
          } else {
            merged.rowNums.push(...decoded.rowNums);
            merged.rowFlags.push(...decoded.rowFlags);
            merged.rows.push(...decoded.rows);
          }
        }
      }
    }
  }
  return merged;
}

/**
 * Check a parsed response for errors.
 * Returns null if all OK, or the first error string found.
 */
function checkErrors(parsed) {
  const errors = parsed[3];
  if (!Array.isArray(errors)) return null;
  for (const err of errors) {
    if (err !== '<OK>' && err !== '<NO DATA>') {
      if (typeof err === 'string') return err;
      if (Array.isArray(err) && err.length > 0) {
        // Error format: [[message, [details...]]]
        if (Array.isArray(err[0])) return err[0][0];
        return String(err[0]);
      }
    }
  }
  return null;
}

/**
 * Check rescds (result codes) for save errors.
 * -1 means error (e.g., explanation required).
 */
function checkRescds(parsed) {
  const rescds = parsed[1];
  if (typeof rescds === 'string') {
    // rescds is a concatenated string like "0100" — one char per frame
    for (let i = 0; i < rescds.length; i++) {
      // Check for '-' which starts a negative number
      if (rescds[i] === '-') return true;
    }
  }
  return false;
}

module.exports = {
  // Constants
  ENCODE_COMMA,
  DLM_RS,
  DLM_CMD,
  DLM_ROW,
  DLM_PARAM,
  DLM_NAMED,
  // Response decoding
  parseResponse,
  decode204Data,
  parseFrames,
  extract204,
  checkErrors,
  checkRescds,
  // Request encoding
  encodePutRow,
  buildCommand,
  buildRequestBody,
};
