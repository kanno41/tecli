'use strict';

// ---------------------------------------------------------------------------
// Binary encoding/decoding constants (from MasterPage.js lines 126-139)
// ---------------------------------------------------------------------------
const ENCODE_COMMA = '\x0B'; // field separator
const ENCODE_NULL = '\x06'; // empty string marker
const ENCODE_PREV_FOUND = '\x07'; // reference to previous row value
const ENCODE_RUN_LEN = '\x05'; // run-length marker
const ENCODE_PREV_SUBSTR = '\x0E'; // substring of previous row
const ENCODE_RANGE_DELIM = '\x0F'; // range delimiter in sequences

// Command/request delimiters
const DLM_RS = 'K\x01'; // command delimiter in batch
const DLM_CMD = 'C\x05'; // parameter delimiter within command
const DLM_ROW = 'R\x02'; // row separator in PUT data
const DLM_PARAM = 'P\x07'; // parameter separator
const DLM_NAMED = 'N\x08'; // named parameter separator

// ---------------------------------------------------------------------------
// Response decoding (ported from mock-backend/db.js lines 37-174)
// ---------------------------------------------------------------------------

function decodeSmallNumber(charCode) {
  let idx = charCode;
  if (idx >= 92) idx--; // skip backslash
  if (idx >= 60) idx--; // skip '<'
  if (idx >= 39) idx--; // skip single quote
  if (idx >= 34) idx--; // skip double quote
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

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------
// The servlet answers with JavaScript: `var responses=[...];`. It is read as
// data, never run (tecli-4mz.9). Grammar seen in captured traffic: arrays,
// "..." and '...' strings with JS escapes, numbers, null, true, false,
// new Array(...), and UI scripts `function(g){...}`, kept as their source
// text. Anything else fails the parse.

const RESPONSES_PREFIX = 'var responses=';
const STRING_ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' };
const NUMBER_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const HEX_RE = /^[0-9a-fA-F]+$/;

class ResponseParser {
  constructor(text) {
    this.text = text;
    this.pos = 0;
  }

  fail(message) {
    throw new Error(message + ' at offset ' + this.pos);
  }

  skipSpace() {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) this.pos++;
  }

  startsWith(word) {
    return this.text.startsWith(word, this.pos);
  }

  expect(token) {
    this.skipSpace();
    if (!this.startsWith(token)) this.fail('expected ' + JSON.stringify(token));
    this.pos += token.length;
  }

  parseDocument() {
    this.skipSpace();
    if (!this.startsWith(RESPONSES_PREFIX)) this.fail('responses is not defined');
    this.pos += RESPONSES_PREFIX.length;
    const value = this.parseValue();
    this.skipSpace();
    if (this.text[this.pos] === ';') this.pos++;
    this.skipSpace();
    if (this.pos !== this.text.length) this.fail('unexpected text after responses');
    if (!Array.isArray(value)) this.fail('responses is not an array');
    return value;
  }

  parseValue() {
    this.skipSpace();
    const c = this.text[this.pos];
    if (c === '[') return this.parseList('[', ']');
    if (c === '"' || c === "'") return this.parseString();
    if (c === '-' || (c >= '0' && c <= '9')) return this.parseNumber();
    for (const [word, value] of [
      ['null', null],
      ['true', true],
      ['false', false],
    ]) {
      if (this.startsWithWord(word)) {
        this.pos += word.length;
        return value;
      }
    }
    if (this.startsWithWord('new')) return this.parseNewArray();
    if (this.startsWithWord('function')) return this.parseFunctionSource();
    return this.fail('unexpected ' + (c === undefined ? 'end of input' : JSON.stringify(c)));
  }

  startsWithWord(word) {
    return this.startsWith(word) && !/[\w$]/.test(this.text[this.pos + word.length] || '');
  }

  parseList(open, close) {
    this.expect(open);
    const items = [];
    this.skipSpace();
    if (this.text[this.pos] === close) {
      this.pos++;
      return items;
    }
    for (;;) {
      items.push(this.parseValue());
      this.skipSpace();
      const c = this.text[this.pos];
      this.pos++;
      if (c === close) return items;
      if (c !== ',') {
        this.pos--;
        this.fail('expected "," or ' + JSON.stringify(close));
      }
    }
  }

  parseNewArray() {
    this.pos += 'new'.length;
    this.expect('Array');
    const items = this.parseList('(', ')');
    // new Array(n) would be an empty array of length n, not [n]
    if (items.length === 1 && typeof items[0] === 'number') this.fail('new Array(length) is not supported');
    return items;
  }

  parseNumber() {
    NUMBER_RE.lastIndex = this.pos;
    const m = NUMBER_RE.exec(this.text);
    if (!m) this.fail('bad number');
    this.pos += m[0].length;
    return Number(m[0]);
  }

  parseString() {
    const text = this.text;
    const quote = text[this.pos++];
    let out = '';
    let chunkStart = this.pos;
    while (this.pos < text.length) {
      const c = text[this.pos];
      if (c === quote) {
        out += text.slice(chunkStart, this.pos++);
        return out;
      }
      if (c === '\n' || c === '\r') this.fail('newline in string');
      if (c !== '\\') {
        this.pos++;
        continue;
      }
      out += text.slice(chunkStart, this.pos) + this.parseEscape();
      chunkStart = this.pos;
    }
    return this.fail('unterminated string');
  }

  parseEscape() {
    const text = this.text;
    const c = text[++this.pos];
    this.pos++;
    if (c === undefined) this.fail('unterminated string');
    if (c in STRING_ESCAPES) return STRING_ESCAPES[c];
    if (c === 'x') return this.readHex(2);
    if (c === 'u') {
      if (text[this.pos] !== '{') return this.readHex(4);
      const close = text.indexOf('}', this.pos);
      if (close < 0) this.fail('bad unicode escape');
      const hex = text.slice(this.pos + 1, close);
      if (!HEX_RE.test(hex) || parseInt(hex, 16) > 0x10ffff) this.fail('bad unicode escape');
      this.pos = close + 1;
      return String.fromCodePoint(parseInt(hex, 16));
    }
    if (c === '0' && !/[0-9]/.test(text[this.pos] || '')) return '\0';
    if (c >= '0' && c <= '9') this.fail('octal escape');
    if (c === '\r') {
      if (text[this.pos] === '\n') this.pos++;
      return '';
    }
    if (c === '\n' || c === '\u2028' || c === '\u2029') return '';
    return c;
  }

  readHex(len) {
    const hex = this.text.substr(this.pos, len);
    if (hex.length !== len || !HEX_RE.test(hex)) this.fail('bad hex escape');
    this.pos += len;
    return String.fromCharCode(parseInt(hex, 16));
  }

  // A UI script for the browser. Only its extent is found: braces are
  // matched, skipping string literals. The text is returned, never run.
  parseFunctionSource() {
    const text = this.text;
    const start = this.pos;
    const open = text.indexOf('{', start);
    if (open < 0) this.fail('function without a body');
    this.pos = open;
    let depth = 0;
    while (this.pos < text.length) {
      const c = text[this.pos];
      if (c === '"' || c === "'") {
        this.parseString();
        continue;
      }
      if (c === '`' || (c === '/' && (text[this.pos + 1] === '/' || text[this.pos + 1] === '*'))) {
        this.fail('unsupported syntax in function');
      }
      this.pos++;
      if (c === '{') depth++;
      if (c === '}' && --depth === 0) return text.slice(start, this.pos);
    }
    return this.fail('unterminated function');
  }
}

/**
 * Parse a `var responses=[...]` string into a JS array without running it.
 */
function parseResponse(responseText) {
  try {
    return new ResponseParser(responseText).parseDocument();
  } catch (e) {
    throw new Error('parseResponse failed: ' + e.message + ' | response preview: ' + responseText.substring(0, 300));
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

  return (
    'sid=' +
    sid +
    '&cmd=' +
    encodeURIComponent(cmdField) +
    '&objId=' +
    encodeURIComponent(objIdField) +
    '&editFlag=' +
    encodeURIComponent(editFlagField) +
    '&rowNumber=' +
    encodeURIComponent(rowNumberField) +
    '&data=' +
    encodeURIComponent(dataField)
  );
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
 * Result codes, one per frame, from the \x0B-separated rescds string.
 */
function resultCodes(parsed) {
  const rescds = parsed[1];
  if (typeof rescds !== 'string' || rescds === '') return [];
  return rescds.split(ENCODE_COMMA).map(c => parseInt(c, 10));
}

/**
 * Error message of frame i, or null when the frame is OK.
 */
function frameError(parsed, i) {
  const err = Array.isArray(parsed[3]) ? parsed[3][i] : undefined;
  if (err === undefined || err === '<OK>' || err === '<NO DATA>') return null;
  if (typeof err === 'string') return err;
  if (Array.isArray(err) && err.length > 0) return Array.isArray(err[0]) ? err[0][0] : String(err[0]);
  return null;
}

/**
 * True when any frame's result code is negative (-1 means error).
 */
function checkRescds(parsed) {
  return resultCodes(parsed).some(c => c < 0);
}

// Message of the 206 failure that asks for a revision explanation
const REVISION_REQUIRED_ERROR = /Explanation or Reject Reason is required/i;

/**
 * True when the CMD 206 save failed on the revision explanation prompt
 * (captured/prev-period-edit/017). Any other 206 failure is a real error.
 */
function isSaveRevisionRequired(parsed) {
  const frames = parseFrames(parsed[0]);
  const codes = resultCodes(parsed);
  return frames.some(
    (f, i) => f.cmdCd === 206 && codes[i] < 0 && REVISION_REQUIRED_ERROR.test(frameError(parsed, i) || '')
  );
}

// ---------------------------------------------------------------------------
// Column names (OPEN_RS maObjId lists)
// ---------------------------------------------------------------------------
// OPEN_RS answers with D.V(g,"maObjId","...") naming each column of the
// result set, compressed against earlier names:
//   \x0B        next name
//   \x0E{n}     next name, starting with the first n chars of the previous one
//   \x12{n}     first n chars of the source name
//   \x10{a}{b}  b chars of the source name from offset a
// The source name is the previous one unless a name using \x10/\x12 ends in
// a back-reference count (a char outside [A-Z0-9_]).
const NAME_NEXT = '\x0B';
const NAME_PREFIX = '\x0E';
const NAME_SRC_PREFIX = '\x12';
const NAME_SRC_SUBSTR = '\x10';

function decodeColumnNames(str) {
  const entries = str
    .split(NAME_PREFIX)
    .join(NAME_NEXT + NAME_PREFIX)
    .split(NAME_NEXT);
  const names = [];
  entries.forEach((entry, k) => {
    let s = entry;
    let prefix = '';
    if (s[0] === NAME_PREFIX) {
      prefix = names[k - 1].substring(0, decodeSmallNumber(s.charCodeAt(1)));
      s = s.substring(2);
    }
    if (s.includes(NAME_SRC_SUBSTR) || s[0] === NAME_SRC_PREFIX) {
      let back = 1;
      if (!/\x10..$/s.test(s) && /[^A-Z0-9_]$/.test(s)) {
        back = decodeSmallNumber(s.charCodeAt(s.length - 1));
        s = s.substring(0, s.length - 1);
      }
      const src = names[k - back] || '';
      s = s
        .replace(/^\x12(.)/s, (_, n) => src.substring(0, decodeSmallNumber(n.charCodeAt(0))))
        .replace(/\x10(.)(.)/gs, (_, a, b) =>
          src.substr(decodeSmallNumber(a.charCodeAt(0)), decodeSmallNumber(b.charCodeAt(0)))
        );
    }
    names.push(prefix + s);
  });
  return names;
}

/**
 * Column name lists in a response, in order (one per OPEN_RS that sent one).
 */
function columnNames(responseText) {
  const lists = [];
  const re = /D\.V\(g,"maObjId","((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(responseText)) !== null) {
    const literal = m[1].replace(/[\x00-\x1F]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    lists.push(decodeColumnNames(JSON.parse('"' + literal + '"')));
  }
  return lists;
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
  resultCodes,
  frameError,
  isSaveRevisionRequired,
  columnNames,
  // Request encoding
  encodePutRow,
  buildCommand,
  buildRequestBody,
};
