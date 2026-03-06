'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');
const moment = require('moment');
const Table = require('cli-table');
const protocol = require('./protocol');
const { normalizeTimesheetStatus } = require('./timesheet-status');

const APP_ID = 'TMMTIMESHEET';
const NUM_DAYS = 7;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Parent column indices (from production 204 data layout)
const PARENT_COL = {
  EMPL_FULL_NAME: 0,
  EMPL_ID: 1,
  END_DT: 3,
  S_STATUS_CD: 4,
  ENABLE_SIGN_FL: 565,
  ACTION_CD: 667,
};

// Child column indices
const CHILD_DAY_COL = { 1: 26, 2: 27, 3: 28, 4: 29, 5: 30, 6: 31, 7: 32 };
const CHILD_LINE_DESC = 2;
const CHILD_UDT02_ID = 6;  // UDT02_ID column index (verified: ZLEAVE.CMP pattern)
const CHILD_TOTAL_ENTERED = 96;

class DirectClient {
  constructor() {
    this.baseUrl = '';
    this.sid = '';
    this.cookieJar = {};  // domain → { name → value }
    this.parentData = null;
    this.childData = null;
    this.lastPutId = 0;
    this.dates = null;
    this.table = null;
    this.timesheetStatus = 'Unknown';
    this.timesheetStatusCode = '';
    // Keep-alive agents for connection reuse (like a browser)
    this._httpAgent = new http.Agent({ keepAlive: true });
    this._httpsAgent = new https.Agent({ keepAlive: true });
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
        // Check for Expires in the past — this means "delete the cookie"
        const expiresMatch = sc.match(/;\s*Expires=([^;]+)/i);
        if (expiresMatch) {
          const expiresDate = new Date(expiresMatch[1]);
          if (expiresDate.getTime() < Date.now()) {
            if (name in jar) {
              delete jar[name];
            }
            continue;
          }
        }
        // Extract explicit Path from Set-Cookie
        const pathMatch = sc.match(/;\s*Path=([^;]*)/i);
        const cookiePath = pathMatch ? pathMatch[1] : defaultPath;
        jar[name] = { value, path: cookiePath };
      }
    }
  }

  static async launch(url, username, password) {
    const client = new DirectClient();
    await client._init(url, username, password);
    return client;
  }

  display() {
    console.log(this.table.toString());
  }

  getData() {
    const statusMeta = this._getTimesheetStatusMeta();
    return {
      timesheetStatus: statusMeta.label,
      timesheetStatusCode: statusMeta.code,
      dates: this.dates.map(d => ({
        date: d.date(),
        fullDate: d.format('YYYY-MM-DD'),
        dayOfWeek: d.format('ddd'),
      })),
      projects: this.table.map(row => ({
        line: row[0],
        code: row[1],
        description: row[2],
        payType: row[3],
        hours: Object.fromEntries(
          this.dates.map((d, i) => [d.date(), row[i + 4] === '' ? null : row[i + 4]])
        ),
      })),
    };
  }

  _getTimesheetStatusMeta() {
    const parentRow = this.parentData && this.parentData.rows && this.parentData.rows[0];
    const rawStatus = parentRow ? parentRow[PARENT_COL.S_STATUS_CD] : '';
    return normalizeTimesheetStatus(rawStatus);
  }

  async set(line, day, hours) {
    const start = this.dates[0].date();
    const dayOffset = day - start;
    const dayNum = dayOffset + 1;
    const childCol = CHILD_DAY_COL[dayNum];
    const rowNum = parseInt(this.childData.rowNums[line], 10);

    // Update local child data
    this.childData.rows[line][childCol] = String(hours);

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
    for (const { line, day, hours } of changes) {
      await this.set(line, day, hours);
    }
  }

  async add(code, payType) {
    console.log('Adding project code: ' + code + (payType ? ' (payType=' + payType + ')' : ''));

    // Create a new row locally at -59999 with template fields from existing rows.
    // The browser copies employee defaults from existing rows before TMMTS_NEW_TS_LINE.
    const numCols = this.childData.rows[0].length;
    const newRow = new Array(numCols).fill('');

    // Copy uniform template fields from first existing row (employee ID, pay schedule, etc.)
    const TEMPLATE_COLS = [0, 150, 151, 187, 193, 194, 197, 234, 235, 336, 398];
    const templateRow = this.childData.rows[0];
    for (const ci of TEMPLATE_COLS) {
      if (ci < templateRow.length && templateRow[ci]) newRow[ci] = templateRow[ci];
    }
    // col[1] and col[198] are the sequence number (next line number)
    const nextSeq = String(this.childData.rows.length + 1);
    newRow[1] = nextSeq;
    newRow[198] = nextSeq;
    // col[196] and col[393] are "N" for new rows (empty in existing rows)
    newRow[196] = 'N';
    newRow[393] = 'N';

    this.childData.rows.push(newRow);
    this.childData.rowNums.push('-59999');
    if (this.childData.rowFlags) this.childData.rowFlags.push('19');

    // Step 1: TMMTS_NEW_TS_LINE — register the new row with the server.
    // The server populates employee defaults and establishes server-side state.
    await this._newTimesheetLine();

    // Step 2: Set the project code and validate it.
    // Find the new row (may have been replaced by server response).
    const newRowIdx = this.childData.rowNums.findIndex(n => parseInt(n, 10) < 0);
    this.childData.rows[newRowIdx][CHILD_UDT02_ID] = code;
    await this._validateUdt02();

    // Step 3: Resolve charge via server-side lookup.
    await this._resolveChargeOnServer(code, payType);

    // Step 4: Post-charge validate — tells the server the charge is accepted.
    // Without this, the server's session state doesn't have the Account field
    // committed, causing "Account required" on save.
    await this._validateUdt02();

    this._buildTableRows();
  }

  /**
   * Validate the UDT02_ID field on a new row, populating server defaults.
   * Sends 205 PUT + 208 VALIDATE for UDT02_ID and updates local data.
   */
  async _validateUdt02() {
    const newRowIdx = this.childData.rowNums.findIndex(n => parseInt(n, 10) < 0);
    const newRow = this.childData.rows[newRowIdx];
    const rowNum = this.childData.rowNums[newRowIdx];
    const encodedRow = protocol.encodePutRow(newRow);

    const cmds = [
      // 205 PUT K1
      this._wrap(this._cmd(205, [
        { code: 'X', value: '0' }, { code: 'K', value: '1' },
        { code: 'C', value: rowNum }, { code: 'P', value: '0' },
        { code: 'V', value: 'true' },
        { name: 'lastPutId', value: String(this.lastPutId++) },
      ]), {
        data: encodedRow + protocol.DLM_ROW,
        editFlag: '19,',
        rowNumber: rowNum + ',',
      }),
      // 205 PUT K1 context
      this._wrap(this._cmd(205, [
        { code: 'X', value: '0' },
        { name: 'rsContextOnly', value: 'Y' },
        { code: 'K', value: '1' }, { code: 'C', value: rowNum },
        { code: 'P', value: '0' }, { code: 'V', value: 'true' },
        { name: 'lastPutId', value: String(this.lastPutId++) },
      ]), {
        data: encodedRow + protocol.DLM_ROW,
        editFlag: '19,',
        rowNumber: rowNum + ',',
      }),
      // 208 VALIDATE UDT02_ID
      this._wrap(this._cmd(208, [
        { name: 'objectId', value: 'UDT02_ID' },
        { code: 'K', value: '1' }, { code: 'C', value: rowNum },
        { code: 'P', value: '0' }, { code: 'V', value: 'true' },
      ])),
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
        throw new Error('UDT02_ID validate error: ' + err);
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
    const parentRow = this.parentData.rows[0];

    const encodedChild = protocol.encodePutRow(newRow);
    const encodedParent = protocol.encodePutRow(parentRow);

    const cmds = [
      // 1. PUT K0 parent (editFlag=18)
      this._wrap(this._cmd(205, [
        { code: 'K', value: '0' }, { code: 'C', value: '0' },
        { code: 'V', value: 'true' },
        { name: 'lastPutId', value: String(this.lastPutId++) },
      ]), {
        data: encodedParent + protocol.DLM_ROW,
        editFlag: '18,',
        rowNumber: '0,',
      }),
      // 2. PUT K1 new child (editFlag=19)
      this._wrap(this._cmd(205, [
        { code: 'X', value: '0' }, { code: 'K', value: '1' },
        { code: 'C', value: rowNum }, { code: 'P', value: '0' },
        { code: 'V', value: 'true' },
        { name: 'lastPutId', value: String(this.lastPutId++) },
      ]), {
        data: encodedChild + protocol.DLM_ROW,
        editFlag: '19,',
        rowNumber: rowNum + ',',
      }),
      // 3. PUT K0 context ($rsContextOnly$=Y)
      this._wrap(this._cmd(205, [
        { name: 'rsContextOnly', value: 'Y' },
        { code: 'K', value: '0' }, { code: 'C', value: '0' },
        { code: 'V', value: 'true' },
        { name: 'lastPutId', value: String(this.lastPutId++) },
      ]), {
        data: encodedParent + protocol.DLM_ROW,
        editFlag: '18,',
        rowNumber: '0,',
      }),
      // 4. PUT K1 child context ($rsContextOnly$=Y)
      this._wrap(this._cmd(205, [
        { code: 'X', value: '0' },
        { name: 'rsContextOnly', value: 'Y' },
        { code: 'K', value: '1' }, { code: 'C', value: rowNum },
        { code: 'P', value: '0' }, { code: 'V', value: 'true' },
        { name: 'lastPutId', value: String(this.lastPutId++) },
      ]), {
        data: encodedChild + protocol.DLM_ROW,
        editFlag: '19,',
        rowNumber: rowNum + ',',
      }),
      // 5. CMD 300 TMMTS_NEW_TS_LINE
      this._wrap(this._cmd(300, [
        ...this._actionBoilerplate(),
        { name: 'actionId', value: 'TMMTS_NEW_TS_LINE' },
        { name: 'restartFl', value: 'false' },
        { code: 'C', value: rowNum },
        { name: 'longRunActionFl', value: '0' },
        { name: 'procUniqueId', value: APP_ID + ':A:' + this.sid + ':1' },
        { name: 'psSchWorkflowNotifyFl', value: 'false' },
        { code: 'K', value: '1' },
        { code: 'P', value: '0' },
        { code: 'V', value: 'true' },
      ])),
      // 6-7. 204 K0 positive + negative
      ...this._get204(0),
      // 8-9. 204 K1 positive + negative
      ...this._get204(1),
      // 10. keepalive
      this._keepalive(),
    ];

    // reqIdx=1 sets K1 as the action context (matches browser)
    const body = protocol.buildRequestBody(this.sid, cmds) + '&reqIdx=1';
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

  async save() {
    console.log('Saving timesheet...');

    const body = this._buildSaveBatch();
    const respText = await this._postServlet(body);

    // Detect server crash response before parsing
    if (respText.includes('onServletException')) {
      console.error('Save response (first 500 chars):', respText.substring(0, 500));
      throw new Error('Server error (session may be invalid). Please try again.');
    }

    const parsed = protocol.parseResponse(respText);

    // Check for errors
    const hasRescdError = protocol.checkRescds(parsed);
    const err = protocol.checkErrors(parsed);

    if (hasRescdError || err) {
      throw new Error('Save error: ' + (err || 'server rejected the save'));
    }

    // Refresh data from response
    const k0Data = protocol.extract204(parsed, 0);
    const k1Data = protocol.extract204(parsed, 1);
    if (k0Data) this.parentData = k0Data;
    if (k1Data) this.childData = k1Data;

    this._buildTableRows();
    console.log('Timesheet saved.');
  }

  /**
   * Resolve a project code via the server's charge lookup dialog.
   * Performs the 3-step flow: OPEN_RS K2 → HLKP query → CMD 300 TC_TS_CHARGE_LKP_OK.
   * Updates this.parentData and this.childData with the resolved charge fields.
   *
   * For single-charge codes (1 result), auto-selects the only option.
   * For multi-charge codes, selects the row matching payType.
   */
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
    if (k2Data.rows.length === 1) {
      // Single-charge code — auto-select
      selectedIdx = 0;
    } else if (payType) {
      // Multi-charge — find the row matching the desired pay type
      selectedIdx = this._findChargeRow(k2Data.rows, payType);
      if (selectedIdx < 0) {
        throw new Error(
          'Pay type ' + payType + ' not found for ' + code + '. ' +
          'Lookup returned ' + k2Data.rows.length + ' options.'
        );
      }
    } else {
      throw new Error(
        'Multiple charges found for ' + code + '. ' +
        'Specify a pay type: costpoint add ' + code + ' REG'
      );
    }

    const selectedRowNum = k2Data.rowNums[selectedIdx];
    const selectedK2Row = k2Data.rows[selectedIdx];

    // Copy charge fields from K2 selected row into K1 child row.
    // The browser does this client-side before sending CMD 300.
    const newRowIdx = this.childData.rowNums.findIndex(n => parseInt(n, 10) < 0);
    const childRow = this.childData.rows[newRowIdx];
    childRow[104] = selectedK2Row[5] || '';   // project code
    childRow[108] = selectedK2Row[24] || '';   // combined code+payType (e.g., ZLEAVE.FTBRHB)
    childRow[112] = selectedK2Row[26] || '';   // flag
    childRow[376] = selectedK2Row[15] || '';   // pay type
    childRow[400] = selectedK2Row[32] || '';   // project code

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
        console.log('WARNING: new row -59999 not found in K1 response');
      }
    }
  }

  async sign() {
    this.parentData.rows[0][PARENT_COL.ACTION_CD] = 'S';
    await this.save();
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
      headers: { 'Cookie': cookieStr, 'User-Agent': USER_AGENT, ...(extraHeaders || {}) },
    };

    if (body !== undefined && body !== null) {
      options.headers['Content-Type'] = contentType || 'application/x-www-form-urlencoded';
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }

    return new Promise((resolve, reject) => {
      const req = lib.request(options, res => {
        this._trackCookies(fullUrl.hostname, res.headers['set-cookie'], reqPath);
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, body: data, headers: res.headers });
        });
      });
      req.on('error', reject);
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
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'max-age=0',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': referer ? 'same-origin' : 'none',
      'Sec-Fetch-User': '?1',
      ...(referer ? { 'Referer': referer } : {}),
      ...(origin ? { 'Origin': origin } : {}),
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
    let resp = await this._httpRaw('GET', samlUrl, null, null,
      this._browserHeaders(null, null));
    // Follow redirects to reach the SAML form page
    while (resp.status >= 300 && resp.status < 400 && resp.headers.location) {
      resp = await this._httpRaw('GET', resp.headers.location, null, null,
        this._browserHeaders(null, null));
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
      resp = await this._httpRaw('POST', form.action, form.body,
        'application/x-www-form-urlencoded',
        this._browserHeaders(currentUrl, formUrl.origin));

      // Follow redirects after SAML POST (ACS redirects)
      if (resp.status >= 300 && resp.status < 400 && resp.headers.location) {
        const redirectUrl = resp.headers.location;

        resp = await this._httpRaw('GET', redirectUrl, null, null,
          this._browserHeaders(currentUrl, null));
        while (resp.status >= 300 && resp.status < 400 && resp.headers.location) {
          resp = await this._httpRaw('GET', resp.headers.location, null, null,
            this._browserHeaders(null, null));
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
      'Cookie': cookieStr,
      'User-Agent': USER_AGENT,
      'Accept': 'application/json; okta-version=1.0.0',
      'Content-Type': 'application/json',
    };

    const bodyStr = body ? JSON.stringify(body) : null;
    if (bodyStr) {
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    return new Promise((resolve, reject) => {
      const req = lib.request({
        method,
        hostname: fullUrl.hostname,
        port: fullUrl.port || (isHttps ? 443 : 80),
        path: fullUrl.pathname + fullUrl.search,
        agent: isHttps ? this._httpsAgent : this._httpAgent,
        headers,
      }, res => {
        this._trackCookies(fullUrl.hostname, res.headers['set-cookie'], reqPath);
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, body: data, headers: res.headers });
        });
      });
      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  /**
   * Browser-like XHR headers for MasterServlet requests.
   * The gateway/WAF may check Sec-Fetch-* to validate legitimate browser origin.
   */
  _servletHeaders() {
    return {
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': this.baseUrl + '/cpweb/masterPage.htm',
      'Origin': this.baseUrl,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'X-Requested-With': 'XMLHttpRequest',
    };
  }

  async _postServlet(body) {
    const resp = await this._http('POST', '/cpweb/MasterServlet.cps', body,
      'application/x-www-form-urlencoded', { headers: this._servletHeaders() });
    return resp.body;
  }

  // =========================================================================
  // Init flow
  // =========================================================================

  async _init(url, username, password) {
    const parsed = new URL(url);
    this.baseUrl = parsed.origin;
    this.sid = crypto.randomUUID().replace(/-/g, '');
    this._system = parsed.searchParams.get('system') || '';

    console.log('Connecting to Costpoint...');

    // Step 1: GET login form — don't auto-follow redirects so we can detect SSO
    // Also disable SAML handling — we need to detect the SSO redirect ourselves
    // so we can run the full IDX (username/password) flow first
    const loginResp = await this._http('GET', parsed.pathname + parsed.search,
      null, null, { followRedirects: false, handleSaml: false });

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

    console.log('Logged in. Loading timesheet...');

    // LOGININFO
    const loginInfoResp = await this._http('POST', '/cpweb/MasterServlet.cps',
      'sid=' + this.sid + '&LOGININFO=Y&PHONE=N',
      'application/x-www-form-urlencoded', { headers: this._servletHeaders() });

    // Real server returns empty on success; mock returns responseCd='ok'
    // Fail only if body contains an explicit error
    if (loginInfoResp.body.includes('session not valid') ||
        (loginInfoResp.body.includes('returnCd') && loginInfoResp.body.includes('error'))) {
      throw new Error('LOGININFO failed: ' + loginInfoResp.body.substring(0, 300));
    }

    // OPEN_APP (507+101+507)
    await this._postServlet(this._buildOpenApp());

    // OPEN_RS parent K0 (201+507) — must open before fetching data
    await this._postServlet(this._buildOpenRsParent());

    // Parent data + OPEN_RS child (204+204+201+507)
    const parentResp = await this._postServlet(this._buildInitParent());
    const parentParsed = protocol.parseResponse(parentResp);
    this.parentData = protocol.extract204(parentParsed, 0);
    if (!this.parentData) throw new Error('Failed to decode parent data');

    // Child data (204+204+507)
    const childResp = await this._postServlet(this._buildInitChild());
    const childParsed = protocol.parseResponse(childResp);
    this.childData = protocol.extract204(childParsed, 1);
    if (!this.childData) throw new Error('Failed to decode child data');

    // Build dates and table
    this._buildDates();
    this._initTable();
    this._buildTableRows();

    console.log('Timesheet loaded.');
  }

  // =========================================================================
  // SSO login (Okta Identity Engine / IDX)
  // =========================================================================

  async _ssoLogin(samlUrl, username, password) {
    const ssoOrigin = new URL(samlUrl).origin;

    // 1. GET the Okta SAML page — extract stateToken from HTML/JS
    const pageResp = await this._httpRaw('GET', samlUrl);
    let pageHtml = pageResp.body;
    // Follow redirects manually (httpRaw doesn't follow)
    if (pageResp.status >= 300 && pageResp.status < 400 && pageResp.headers.location) {
      const r = await this._httpRaw('GET', pageResp.headers.location);
      pageHtml = r.body;
    }
    const stateTokenMatch = pageHtml.match(/"stateToken"\s*:\s*"([^"]+)"/);
    if (!stateTokenMatch) {
      throw new Error('Could not extract stateToken from SSO page');
    }
    // Decode JS escape sequences like \x2D → '-'
    const stateToken = stateTokenMatch[1].replace(/\\x([0-9A-Fa-f]{2})/g,
      (_, hex) => String.fromCharCode(parseInt(hex, 16)));

    // 2. POST /idp/idx/introspect to get stateHandle
    const introspectResp = await this._httpJson(ssoOrigin, 'POST',
      ssoOrigin + '/idp/idx/introspect', { stateToken });
    const introspectData = JSON.parse(introspectResp.body);
    const stateHandle = introspectData.stateHandle;
    if (!stateHandle) throw new Error('SSO introspect did not return stateHandle');

    // 3. POST /idp/idx/identify with username
    const identifyResp = await this._httpJson(ssoOrigin, 'POST',
      ssoOrigin + '/idp/idx/identify', { identifier: username, stateHandle });
    const identifyData = JSON.parse(identifyResp.body);
    const challengeForm = identifyData.remediation?.value?.find(
      r => r.name === 'challenge-authenticator');
    if (!challengeForm) {
      // Check if we need to select the password authenticator first
      const selectForm = identifyData.remediation?.value?.find(
        r => r.name === 'select-authenticator-authenticate');
      if (selectForm) {
        // Find password authenticator option
        const authenticators = identifyData.authenticators?.value || [];
        const pwdAuth = authenticators.find(a => a.type === 'password');
        if (pwdAuth) {
          // Select password authenticator
          const selectResp = await this._httpJson(ssoOrigin, 'POST',
            selectForm.href,
            { authenticator: { id: pwdAuth.id }, stateHandle });
          const selectData = JSON.parse(selectResp.body);
          const challengeAfterSelect = selectData.remediation?.value?.find(
            r => r.name === 'challenge-authenticator');
          if (challengeAfterSelect) {
            // Now answer with password
            const answerResp2 = await this._httpJson(ssoOrigin, 'POST',
              challengeAfterSelect.href,
              { credentials: { passcode: password }, stateHandle });
            const answerData2 = JSON.parse(answerResp2.body);
            return this._completeSsoFromAnswer(answerData2);
          }
        }
        throw new Error('SSO: could not find password authenticator');
      }
      throw new Error('SSO did not return password challenge after identify');
    }

    // 4. POST /idp/idx/challenge/answer with password
    const answerResp = await this._httpJson(ssoOrigin, 'POST',
      challengeForm.href,
      { credentials: { passcode: password }, stateHandle });
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

    console.log('SSO authentication complete.');
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
   * Parse ANY HTML form — extracts action URL and all hidden input fields.
   * Used for gateway replay forms that contain the original POST data.
   * Returns { action, body } or null.
   */
  _parseAnyForm(html) {
    const actionMatch = html.match(/<form[^>]+action="([^"]+)"/i);
    if (!actionMatch) return null;
    const action = this._decodeHtmlEntities(actionMatch[1]);

    const params = [];
    const inputRe = /<input[^>]*>/gi;
    let m;
    while ((m = inputRe.exec(html)) !== null) {
      const tag = m[0];
      // Skip submit buttons
      if (/type="submit"/i.test(tag)) continue;
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
    // Must contain a SAMLResponse input to be a SAML form
    if (!/<input[^>]+name="SAMLResponse"/i.test(html)) return null;

    const actionMatch = html.match(/<form[^>]+action="([^"]+)"/i);
    if (!actionMatch) return null;
    const action = this._decodeHtmlEntities(actionMatch[1]);

    // Extract all hidden input fields — handle name/value in either order
    const params = [];
    const inputRe = /<input[^>]*>/gi;
    let m;
    while ((m = inputRe.exec(html)) !== null) {
      const tag = m[0];
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

  // =========================================================================
  // Costpoint login (LoginServlet.cps)
  // =========================================================================

  async _cpLogin(username, password) {

    // Step 1: requestCd=000 — establish connection
    await this._http('POST', '/cpweb/LoginServlet.cps', 'requestCd=000');

    // Step 2: requestCd=003 — auth config (match browser params exactly)
    if (this._system) {
      await this._http('POST', '/cpweb/LoginServlet.cps',
        'requestCd=003&DATABASE=' + encodeURIComponent(this._system) +
        '&LANG=EN&FIDO_CONFIG=Y&U2F_CONDITIONAL_MEDIATION=Y');
    }

    // Step 3: USER + PASSWORD flow (no requestCd=001 — browser skips it)
    // In SSO mode, skip P_FL=N (requires Kerberos/SPNEGO which Node.js can't provide)
    // and go directly to password auth (P_FL=Y).
    const userParams = 'USER=' + encodeURIComponent(username) +
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
        authData.userId, password, authData.nonce, authData.ldapAuthFl, authData.sha2PasswordFl);
      const pwdResp = await this._http('POST', '/cpweb/LoginServlet.cps',
        'PASSWORD=' + encodeURIComponent(hashedPassword));
      if (pwdResp.body.includes('error')) {
        throw new Error('Costpoint password login failed: ' + pwdResp.body);
      }
    } else {
      // Mock-backend or simple login — just send password directly
      await this._http('POST', '/cpweb/LoginServlet.cps',
        'PASSWORD=' + encodeURIComponent(password));
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
    const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
    const sha1hex = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex');

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
    const endDateStr = this.parentData.rows[0][PARENT_COL.END_DT];
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
    this.table = new Table({
      head: ['Line', 'Code', 'Description', 'Pay', ...this.dates.map(d => d.format('D'))],
      colWidths: [6, 14, 20, 5, ...this.dates.slice().fill(5)],
      colAligns: ['middle', 'left', 'left', 'left', ...this.dates.slice().fill('middle')],
    });
  }

  _buildTableRows() {
    // Clear existing rows
    this.table.length = 0;
    for (let i = 0; i < this.childData.rows.length; i++) {
      const row = this.childData.rows[i];
      const code = row[CHILD_UDT02_ID] || '';
      const desc = row[CHILD_LINE_DESC] || '';
      const payType = row[16] || '';
      const hours = [];
      for (let d = 1; d <= NUM_DAYS; d++) {
        const val = row[CHILD_DAY_COL[d]];
        hours.push(val ? parseFloat(val) : '');
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

  _get204(rsKey, extra) {
    const childRowCount = this.childData ? this.childData.rows.length : 40;
    const isChild = rsKey === 1;
    const posE = isChild ? Math.max(childRowCount + 5, 40) : 20;
    const negE = -59999 + posE;

    const baseParams = isChild
      ? [{ code: 'X', value: '0' }, { code: 'K', value: '1' },
         { code: 'C', value: '0' }, { code: 'P', value: '0' },
         { code: 'V', value: 'true' }]
      : [{ code: 'K', value: '0' }, { code: 'C', value: '0' },
         { code: 'V', value: 'true' }];

    const posParams = [
      { name: 'rsType', value: 'M' }, { code: 'R', value: 'ABS' },
      { code: 'S', value: '0' }, { code: 'E', value: String(posE) },
      ...baseParams,
    ];
    const negParams = [
      { name: 'rsType', value: 'M' }, { code: 'R', value: 'ABS' },
      { code: 'S', value: '-59999' }, { code: 'E', value: String(negE) },
      ...baseParams,
    ];

    // Parent positive range gets nonDBSize/nonDBStart
    if (rsKey === 0) {
      posParams.push({ name: 'nonDBSize', value: '1' });
      posParams.push({ name: 'nonDBStart', value: '0' });
    }

    if (extra) {
      posParams.push(...extra);
      negParams.push(...extra);
    }

    return [
      this._wrap(this._cmd(204, posParams)),
      this._wrap(this._cmd(204, negParams)),
    ];
  }

  _buildOpenApp() {
    return protocol.buildRequestBody(this.sid, [
      this._keepalive(),
      this._wrap(this._cmd(101, [
        { code: 'V', value: 'true' },
        { name: 'mobileMode', value: 'N' },
        { name: 'checkCache', value: '0' },
      ])),
      this._keepalive(),
    ]);
  }

  _buildOpenRsParent() {
    return protocol.buildRequestBody(this.sid, [
      this._wrap(this._cmd(201, [
        { code: 'K', value: '0' }, { code: 'I', value: 'TMMTS' },
        { code: 'N', value: '17028' }, { code: 'T', value: 'H' },
        { name: 'checkCache', value: '0' },
        { code: 'C', value: '-60000' }, { code: 'V', value: 'true' },
      ])),
      this._keepalive(),
    ]);
  }

  _buildInitParent() {
    return protocol.buildRequestBody(this.sid, [
      // 204 K0 positive
      this._wrap(this._cmd(204, [
        { name: 'rsType', value: 'M' }, { code: 'R', value: 'ABS' },
        { code: 'S', value: '0' }, { code: 'E', value: '20' },
        { code: 'K', value: '0' }, { code: 'C', value: '-60000' },
        { code: 'V', value: 'true' },
        { name: 'nonDBSize', value: '1' }, { name: 'nonDBStart', value: '0' },
      ])),
      // 204 K0 negative
      this._wrap(this._cmd(204, [
        { name: 'rsType', value: 'M' }, { code: 'R', value: 'ABS' },
        { code: 'S', value: '-59999' }, { code: 'E', value: '-59899' },
        { code: 'K', value: '0' }, { code: 'C', value: '-60000' },
        { code: 'V', value: 'true' },
      ])),
      // 201 OPEN_RS child
      this._wrap(this._cmd(201, [
        { code: 'K', value: '1' }, { code: 'I', value: 'TMMTS_TS_LINE' },
        { code: 'N', value: '17029' }, { code: 'P', value: '0' },
        { code: 'T', value: 'D' },
        { code: 'X', value: '-60000' }, { code: 'C', value: '-60000' },
        { code: 'V', value: 'true' },
      ])),
      this._keepalive(),
    ]);
  }

  _buildInitChild() {
    return protocol.buildRequestBody(this.sid, [
      // 204 K1 positive
      this._wrap(this._cmd(204, [
        { name: 'rsType', value: 'M' }, { code: 'R', value: 'ABS' },
        { code: 'S', value: '0' }, { code: 'E', value: '40' },
        { code: 'X', value: '0' }, { code: 'K', value: '1' },
        { code: 'C', value: '-60000' }, { code: 'P', value: '0' },
        { code: 'V', value: 'true' },
      ])),
      // 204 K1 negative
      this._wrap(this._cmd(204, [
        { name: 'rsType', value: 'M' }, { code: 'R', value: 'ABS' },
        { code: 'S', value: '-59999' }, { code: 'E', value: '-59899' },
        { code: 'X', value: '0' }, { code: 'K', value: '1' },
        { code: 'C', value: '-60000' }, { code: 'P', value: '0' },
        { code: 'V', value: 'true' },
      ])),
      this._keepalive(),
    ]);
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
      this._wrap(this._cmd(205, [
        { code: 'X', value: '0' }, { code: 'K', value: '1' },
        { code: 'C', value: '0' }, { code: 'P', value: '0' },
        { code: 'V', value: 'true' },
        { name: 'lastPutId', value: String(putId) },
      ]), {
        data: encodedRow + protocol.DLM_ROW,
        editFlag: '18,',
        rowNumber: rowNum + ',',
      }),
      // 208 VALIDATE
      this._wrap(this._cmd(208, [
        { name: 'objectId', value: 'DAY' + dayNum + '_HRS' },
        { code: 'K', value: '1' }, { code: 'C', value: '0' },
        { code: 'P', value: '0' }, { code: 'V', value: 'true' },
      ])),
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
    const parentRow = this.parentData.rows[0];
    const parentRowNum = parseInt(this.parentData.rowNums[0], 10);
    const encodedParent = protocol.encodePutRow(parentRow);

    // Encode all child rows
    let childDataStr = '';
    let childEditFlags = '';
    let childRowNumbers = '';
    for (let i = 0; i < this.childData.rows.length; i++) {
      childDataStr += protocol.encodePutRow(this.childData.rows[i]) + protocol.DLM_ROW;
      const rowNum = parseInt(this.childData.rowNums[i], 10);
      childEditFlags += (rowNum < 0 ? '19,' : '18,');
      childRowNumbers += this.childData.rowNums[i] + ',';
    }

    const cmds = [
      // 205 PUT K0 (parent)
      this._wrap(this._cmd(205, [
        { code: 'K', value: '0' }, { code: 'C', value: '0' },
        { code: 'V', value: 'true' },
        { name: 'lastPutId', value: String(this.lastPutId++) },
      ]), {
        data: encodedParent + protocol.DLM_ROW,
        editFlag: '65562,',
        rowNumber: parentRowNum + ',',
      }),
      // 205 PUT K1 (all child rows)
      this._wrap(this._cmd(205, [
        { code: 'X', value: '0' }, { code: 'K', value: '1' },
        { code: 'C', value: '0' }, { code: 'P', value: '0' },
        { code: 'V', value: 'true' },
        { name: 'lastPutId', value: String(this.lastPutId++) },
      ]), {
        data: childDataStr,
        editFlag: childEditFlags,
        rowNumber: childRowNumbers,
      }),
      // 206 SAVE
      this._wrap(this._cmd(206, [
        { code: 'G', value: 'false' }, { code: 'C', value: '0' },
        { code: 'U', value: 'true' }, { code: 'K', value: '0' },
        { code: 'V', value: 'true' },
      ])),
      // 204 K0 positive + negative
      ...this._get204(0),
      // 204 K1 positive + negative
      ...this._get204(1),
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
      this._wrap(this._cmd(205, [
        { code: 'X', value: '0' }, { code: 'K', value: '1' },
        { code: 'C', value: rowNum }, { code: 'P', value: '0' },
        { code: 'V', value: 'true' },
        { name: 'lastPutId', value: String(this.lastPutId++) },
      ]), {
        data: encodedRow + protocol.DLM_ROW,
        editFlag: '19,',
        rowNumber: rowNum + ',',
      }),
      // 201 OPEN_RS K2 (charge lookup)
      this._wrap(this._cmd(201, [
        { code: 'K', value: '2' },
        { code: 'I', value: 'TC_UDT02_CHARGE_LKP' },
        { code: 'N', value: '0' },
        { code: 'L', value: '16' },
        { code: 'P', value: '1' },
        { name: 'objectId', value: 'UDT02_ID' },
        { name: 'checkCache', value: '0' },
        { code: 'C', value: '-60000' },
        { code: 'V', value: 'true' },
      ])),
      this._keepalive(),
    ];
    return protocol.buildRequestBody(this.sid, cmds);
  }

  /**
   * Build CMD 204 HLKP batch to fetch available charges for a project code.
   */
  _buildHlkpQuery(code) {
    const where = '1|C^UDT02_ID^9^' + code +
      '^0|C^$H_LKP_SEL_LVL$^1^1^0|C^$H_LKP_SEL_ROW$^1^-2^0|';

    const cmds = [
      // 204 HLKP positive range
      this._wrap(this._cmd(204, [
        { name: 'rsType', value: 'L' },
        { code: 'R', value: 'HLKP' },
        { code: 'S', value: '0' }, { code: 'E', value: '100' },
        { code: 'X', value: '-59999' },
        { code: 'W', value: where },
        { name: 'objectId', value: 'UDT02_ID' },
        { code: 'K', value: '2' }, { code: 'C', value: '-60000' },
        { code: 'P', value: '1' }, { code: 'V', value: 'true' },
      ])),
      // 204 HLKP negative range
      this._wrap(this._cmd(204, [
        { name: 'rsType', value: 'L' },
        { code: 'R', value: 'HLKP' },
        { code: 'S', value: '-59999' }, { code: 'E', value: '-59899' },
        { code: 'X', value: '-59999' },
        { name: 'newQry', value: 'Y' },
        { code: 'K', value: '2' }, { code: 'C', value: '-60000' },
        { code: 'P', value: '1' }, { code: 'V', value: 'true' },
      ])),
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
    const newRowIdx = this.childData.rowNums.findIndex(n => parseInt(n, 10) < 0);
    const childRow = this.childData.rows[newRowIdx];
    const parentRow = this.parentData.rows[0];

    const encodedK2 = protocol.encodePutRow(selectedK2Row);
    const encodedChild = protocol.encodePutRow(childRow);
    const encodedParent = protocol.encodePutRow(parentRow);

    const childRowCount = this.childData.rows.length;
    const k1PosE = Math.max(childRowCount + 5, 40);
    const k1NegE = -59999 + k1PosE;

    const cmds = [
      // 1. PUT K2 selected ($rsRowSelectedFlOnly$=true, editFlag=64)
      this._wrap(this._cmd(205, [
        { name: 'rsRowSelectedFlOnly', value: 'true' },
        { code: 'X', value: '-59999' },
        { code: 'K', value: '2' }, { code: 'C', value: '0' },
        { code: 'P', value: '1' }, { code: 'V', value: 'true' },
      ]), {
        data: encodedK2 + protocol.DLM_ROW,
        editFlag: '64,',
        rowNumber: k2RowNum + ',',
      }),
      // 2. PUT K1 child (editFlag=19)
      this._wrap(this._cmd(205, [
        { code: 'X', value: '0' }, { code: 'K', value: '1' },
        { code: 'C', value: '-59999' }, { code: 'P', value: '0' },
        { code: 'V', value: 'true' },
        { name: 'lastPutId', value: String(this.lastPutId++) },
      ]), {
        data: encodedChild + protocol.DLM_ROW,
        editFlag: '19,',
        rowNumber: '-59999,',
      }),
      // 3. PUT K2 selected again (editFlag=64)
      this._wrap(this._cmd(205, [
        { code: 'X', value: '-59999' },
        { code: 'K', value: '2' }, { code: 'C', value: '0' },
        { code: 'P', value: '1' }, { code: 'V', value: 'true' },
        { name: 'lastPutId', value: String(this.lastPutId++) },
      ]), {
        data: encodedK2 + protocol.DLM_ROW,
        editFlag: '64,',
        rowNumber: k2RowNum + ',',
      }),
      // 4. PUT K1 child context ($rsContextOnly$=Y)
      this._wrap(this._cmd(205, [
        { code: 'X', value: '0' },
        { name: 'rsContextOnly', value: 'Y' },
        { code: 'K', value: '1' }, { code: 'C', value: '-59999' },
        { code: 'P', value: '0' }, { code: 'V', value: 'true' },
        { name: 'lastPutId', value: String(this.lastPutId++) },
      ]), {
        data: encodedChild + protocol.DLM_ROW,
        editFlag: '19,',
        rowNumber: '-59999,',
      }),
      // 5. PUT K0 parent context ($rsContextOnly$=Y, editFlag=65562)
      this._wrap(this._cmd(205, [
        { name: 'rsContextOnly', value: 'Y' },
        { code: 'K', value: '0' }, { code: 'C', value: '0' },
        { code: 'V', value: 'true' },
        { name: 'lastPutId', value: String(this.lastPutId++) },
      ]), {
        data: encodedParent + protocol.DLM_ROW,
        editFlag: '65562,',
        rowNumber: '0,',
      }),
      // 6. PUT K2 selected context ($rsContextOnly$=Y)
      this._wrap(this._cmd(205, [
        { code: 'X', value: '-59999' },
        { name: 'rsContextOnly', value: 'Y' },
        { code: 'K', value: '2' }, { code: 'C', value: '0' },
        { code: 'P', value: '1' }, { code: 'V', value: 'true' },
        { name: 'lastPutId', value: String(this.lastPutId++) },
      ]), {
        data: encodedK2 + protocol.DLM_ROW,
        editFlag: '64,',
        rowNumber: k2RowNum + ',',
      }),
      // 7. CMD 300 TC_TS_CHARGE_LKP_OK
      this._wrap(this._cmd(300, [
        ...this._actionBoilerplate(),
        { name: 'actionId', value: 'TC_TS_CHARGE_LKP_OK' },
        { name: 'restartFl', value: 'false' },
        { code: 'C', value: '0' },
        { name: 'longRunActionFl', value: '0' },
        { name: 'procUniqueId', value: APP_ID + ':A:' + this.sid + ':2' },
        { name: 'psSchWorkflowNotifyFl', value: 'false' },
        { code: 'K', value: '2' },
        { code: 'P', value: '1' },
        { code: 'V', value: 'true' },
      ])),
      // 8-9. 204 K0 positive + negative
      ...this._get204(0),
      // 10-11. 204 K1 positive + negative (C=-59999 for charge lookup context)
      this._wrap(this._cmd(204, [
        { name: 'rsType', value: 'M' }, { code: 'R', value: 'ABS' },
        { code: 'S', value: '0' }, { code: 'E', value: String(k1PosE) },
        { code: 'X', value: '0' }, { code: 'K', value: '1' },
        { code: 'C', value: '-59999' }, { code: 'P', value: '0' },
        { code: 'V', value: 'true' },
      ])),
      this._wrap(this._cmd(204, [
        { name: 'rsType', value: 'M' }, { code: 'R', value: 'ABS' },
        { code: 'S', value: '-59999' }, { code: 'E', value: String(k1NegE) },
        { code: 'X', value: '0' }, { code: 'K', value: '1' },
        { code: 'C', value: '-59999' }, { code: 'P', value: '0' },
        { code: 'V', value: 'true' },
      ])),
      // 12-13. 204 K2 positive + negative (rsType=L for lookup)
      this._wrap(this._cmd(204, [
        { name: 'rsType', value: 'L' }, { code: 'R', value: 'ABS' },
        { code: 'S', value: '0' }, { code: 'E', value: '100' },
        { code: 'X', value: '-59999' },
        { name: 'objectId', value: 'UDT02_ID' },
        { code: 'K', value: '2' }, { code: 'C', value: '0' },
        { code: 'P', value: '1' }, { code: 'V', value: 'true' },
      ])),
      this._wrap(this._cmd(204, [
        { name: 'rsType', value: 'L' }, { code: 'R', value: 'ABS' },
        { code: 'S', value: '-59999' }, { code: 'E', value: '-59899' },
        { code: 'X', value: '-59999' },
        { code: 'K', value: '2' }, { code: 'C', value: '0' },
        { code: 'P', value: '1' }, { code: 'V', value: 'true' },
      ])),
      // 14. keepalive
      this._keepalive(),
    ];
    // reqIdx=2 tells the server the action context is K2 (charge lookup RS).
    // Without this, the server ignores the K2 row selection.
    return protocol.buildRequestBody(this.sid, cmds) + '&reqIdx=2';
  }
}

module.exports = DirectClient;
