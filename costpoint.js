'use strict';

const moment = require('moment');
const puppeteer = require('puppeteer');
const Table = require('cli-table');
const { normalizeTimesheetStatus } = require('./timesheet-status');
const { DAY_COLUMN_WIDTH } = require('./hours');
const protocol = require('./protocol');
const { RevisionRequiredError } = require('./direct');

// The browser client only drives the active week's grid. Features it has no
// flow for throw this instead of guessing at Costpoint's pages.
class NotSupportedError extends Error {
  constructor(feature) {
    super(feature + ' is not supported in Puppeteer mode; set COSTPOINT_DIRECT=true');
    this.name = 'NotSupportedError';
  }
}

// add() types the code and lets Costpoint fill the rest, so it can only
// honour the default pay type
const DEFAULT_PAY_TYPE = 'REG';

class Costpoint {
  constructor() {
    this.browser = null;
    this.page = null;
    this.table = null;
    this.dates = null;
    this.timesheetStatus = 'Unknown';
    this.timesheetStatusCode = '';
  }

  // The Costpoint system is the URL's ?system= parameter; the SSO login page
  // has no database field to fill.
  static async launch(url, username, password) {
    const costpoint = new Costpoint();
    await costpoint._launch();
    await costpoint._login(url, username, password);
    await costpoint._table();
    return costpoint;
  }

  display() {
    console.log(this.table.toString());
  }

  // Only the active week is loaded
  getPeriods() {
    return [
      {
        idx: 0,
        endDate: this.dates[this.dates.length - 1].format('YYYY-MM-DD'),
        statusCode: this.timesheetStatusCode,
        editable: null,
      },
    ];
  }

  getPreviousPeriodData() {
    return null;
  }

  async selectPeriod(idx) {
    if (idx !== 0) throw new NotSupportedError('Selecting a past week');
  }

  async getFavorites() {
    throw new NotSupportedError('Favorites');
  }

  async addToFavorites() {
    throw new NotSupportedError('Adding to favorites');
  }

  async getLeaveBalances() {
    throw new NotSupportedError('Leave balances');
  }

  getData() {
    return {
      timesheetStatus: this.timesheetStatus,
      timesheetStatusCode: this.timesheetStatusCode,
      dates: this.dates.map(d => ({
        date: d.date(),
        fullDate: d.format('YYYY-MM-DD'),
        dayOfWeek: d.format('ddd'),
      })),
      projects: this.table.map(row => ({
        line: row[0],
        description: row[1],
        hours: Object.fromEntries(this.dates.map((d, i) => [d.date(), row[i + 2] === '' ? null : row[i + 2]])),
      })),
    };
  }

  async save() {
    // Wait for the app to finish any background processing (please-wait overlay)
    await this._waitForIdle();
    // wait until Save & Continue is actually usable
    await this.page.waitForFunction(() => {
      const btn = document.querySelector('#svCntBttn');
      if (!btn) return false;
      const cs = getComputedStyle(btn);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.pointerEvents !== 'none';
    });
    const response = this._waitForSaveResponse();
    await this.page.keyboard.press('F6');
    await this._checkSaveResponse(await response);
    await this._waitForIdle();
    await this._refreshTimesheetStatus();
  }

  // Finish a save that raised RevisionRequiredError: the browser is showing
  // the explanation prompt, and Continue re-sends the save with it.
  async saveWithExplanation(explanation) {
    await this.page.waitForFunction(() => {
      const el = document.querySelector('#EXPLANATION_TEXT');
      if (!el) return false;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    });
    await this.page.locator('#EXPLANATION_TEXT').fill(explanation);
    const response = this._waitForSaveResponse();
    await this.page.locator('#OK_BUT___T').click();
    await this._checkSaveResponse(await response);
    await this._waitForIdle();
    await this._refreshTimesheetStatus();
  }

  // Same checks as DirectClient.save(): the browser does not surface a
  // failed save to us, so read the servlet's answer.
  async _checkSaveResponse(response) {
    const text = await response.text();
    if (text.includes('onServletException')) {
      throw new Error('Server error (session may be invalid). Please try again.');
    }
    const parsed = protocol.parseResponse(text);
    const hasRescdError = protocol.checkRescds(parsed);
    if (hasRescdError && protocol.isSaveRevisionRequired(parsed)) {
      throw new RevisionRequiredError();
    }
    const err = protocol.checkErrors(parsed);
    if (hasRescdError || err) {
      throw new Error('Save error: ' + (err || 'server rejected the save'));
    }
  }

  async sign() {
    // Wait for Deltek to finish any background work
    try {
      await this.page.waitForFunction(
        () => {
          const btn = document.querySelector('#SIGN_BUT');
          if (!btn) return false;
          const cs = getComputedStyle(btn);
          const r = btn.getBoundingClientRect();

          // visible + not dimmed
          return (
            cs.display !== 'none' &&
            cs.visibility !== 'hidden' &&
            r.width > 0 &&
            r.height > 0 &&
            parseFloat(cs.opacity || '1') >= 1
          );
        },
        { timeout: 10000 }
      );
    } catch (error) {
      throw new Error('The Sign button is not available: the timesheet is already signed or cannot be signed.');
    }

    // Click the sign button and wait for the confirmation dialog
    const dialogPromise = new Promise(resolve => {
      this.page.once('dialog', async dialog => {
        await dialog.accept();
        resolve();
      });
    });
    await this.page.locator('#SIGN_BUT').click();
    await dialogPromise;

    // Wait for the page to finish processing after accepting the dialog
    await this.page.waitForNetworkIdle({ idleTime: 2000 });
    await this._waitForIdle();
    await this._refreshTimesheetStatus();
    if (this.timesheetStatusCode !== 'S') {
      throw new Error('Timesheet was not signed (status: ' + this.timesheetStatus + ')');
    }
  }

  async close() {
    await this.browser.close();
  }

  async set(line, day, hours, comment) {
    if (comment) throw new NotSupportedError('Cell comments');
    const start = this.dates[0].date();
    this.table[line][day - start + 2] = hours;

    await this._select(line);
    await this._skip();
    for (let i = 0; i <= day - start; i++) {
      await this.page.keyboard.press('Tab');
    }

    for (const x of hours.toString()) {
      await this.page.keyboard.press(x === '.' ? 'Period' : x);
    }

    const end = this.dates[this.dates.length - 1].date();
    for (let i = 0; i <= end - day; i++) {
      await this.page.keyboard.press('Tab');
    }
    await this._waitForResponse();
  }

  async setm(changes) {
    // changes is an array of { line, day, hours, comment }
    if (changes.some(c => c.comment)) throw new NotSupportedError('Cell comments');
    for (const { line, day, hours } of changes) {
      await this.set(line, day, hours);
    }
  }

  async add(code, payType, { workLocation } = {}) {
    if (payType && payType.toUpperCase() !== DEFAULT_PAY_TYPE) {
      throw new NotSupportedError('Pay type ' + payType);
    }
    if (workLocation) throw new NotSupportedError('Setting a work location');
    await new Promise(resolve => setTimeout(resolve, 5000));
    await this.page.keyboard.press('F2');
    await this.page.waitForSelector('#UDT02_ID-_0_N', {
      visible: true,
    });
    await this.page.click('#UDT02_ID-_0_N');
    await this.page.type('#UDT02_ID-_0_N', code);
    await this.page.waitForSelector('#fldAutoCompleteDiv', { visible: true });
    await this.page.keyboard.press('Tab');
    await this.page.waitForFunction(() => document.querySelector('#LINE_DESC-_0_N').value !== '');
    const description = await this.page.evaluate(() => document.querySelector('#LINE_DESC-_0_N').value);
    this.table.push([this.table.length, description, ...Array(this.dates.length).fill('')]);
    const table = new Table({
      head: ['Line', 'Description', 'Code'],
      colWidths: [6, 26, 14],
    });
    table.push([this.table.length - 1, description, code]);
    console.log('The following project has been successfully added:');
    console.log(table.toString());
  }

  async _launch() {
    this.browser = await puppeteer.launch({
      defaultViewport: { width: 1920, height: 1080 },
      headless: process.env.DEBUG === undefined,
      args: ['--remote-debugging-port=9222', '--remote-debugging-address=127.0.0.1', '--no-sandbox'],
    });
    this.page = await this.browser.newPage();
  }

  async _login(url, username, password) {
    await this.page.goto(url);

    await this.page.locator('#acknowledgeBtn').click();
    await this.page.type('input[name="identifier"]', username);
    await this.page.evaluate(() => {
      const form = document.querySelector('form');
      form?.requestSubmit();
    });
    await this.page.waitForSelector('input[name="credentials.passcode"]', { visible: true });
    await this.page.type('input[name="credentials.passcode"]', password);

    await this.page.evaluate(() => {
      const form = document.querySelector('form');
      form?.requestSubmit();
    });
    await this.page.waitForNavigation();

    // Deltek does some loading and javascript work before enabling the button
    await this.page.waitForFunction(() => {
      const btn = document.querySelector('#btnPromptSSO');
      const signIn = document.querySelector('#signInDiv');
      if (!btn || !signIn) return false;
      if (!signIn.hasAttribute('setupScreen')) return false;
      if (signIn.hasAttribute('disableNoSystem')) return false;
      if (btn.disabled || btn.hasAttribute('disabled')) return false;

      // ensure nothing overlays the button
      const r = btn.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const top = document.elementFromPoint(x, y);
      return top === btn || btn.contains(top);
    });
    await this.page.locator('#btnPromptSSO').click();

    await this.page.waitForSelector('#loginBtn', { visible: true });
    await this.page.waitForSelector('#signInDiv:not([setupScreen]) #loginBtn:not([disabled])');
    await this.page.waitForSelector('body:not([offline])'); // optional safety
    await this.page.locator('#USER').fill(username);

    await clickLoginBtn(this.page);
    await this.page.locator('#CLIENT_PASSWORD').fill(password);

    await clickLoginBtn(this.page);
    try {
      await this.page.waitForSelector('#loginBtn', {
        hidden: true,
        timeout: 10000,
      });

      await this.page.locator('#ackBtn').click();
      // Tell it not to try to install the "app"
      await this.page.locator('#pdlgNever').click();
      await new Promise(resolve => setTimeout(resolve, 5000));
    } catch (e) {
      throw new Error(
        'Invalid login information. Make sure that COSTPOINT_URL, COSTPOINT_USERNAME and COSTPOINT_PASSWORD are escaped correctly.'
      );
    }

    async function clickLoginBtn(page) {
      await page.waitForSelector('#loginBtn', { visible: true });
      await page.waitForFunction(() => {
        const btn = document.querySelector('#loginBtn');
        if (!btn) return false;
        if (btn.disabled || btn.hasAttribute('disabled')) return false;

        const overlay = document.querySelector('#freezeLoginUI');
        if (overlay) {
          const cs = getComputedStyle(overlay);
          if (cs.display !== 'none' && cs.visibility !== 'hidden') return false;
        }

        const r = btn.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const top = document.elementFromPoint(x, y);
        return top === btn || btn.contains(top);
      });
      await page.click('#loginBtn');
    }
  }

  async _table() {
    this.dates = await this._dates();

    this.table = new Table({
      head: ['Line', 'Description', ...this.dates.map(d => d.format('D'))],
      colWidths: [6, 26, ...this.dates.slice().fill(DAY_COLUMN_WIDTH)],
      colAligns: ['middle', 'left', ...this.dates.slice().fill('middle')],
    });

    (await this._projects()).forEach(({ line, description }) =>
      this.table.push([line, description, ...Array(this.dates.length).fill('')])
    );

    await this.page.waitForSelector('#pleaseWaitImage', { hidden: true });
    await this._select(0);
    await this._skip();
    for (let day = 1; day <= this.dates.length; day++) {
      await this.page.keyboard.press('Tab');
      for (let line = 0; line < this.table.length; line++) {
        const hours = await this.page.evaluate(
          selector => document.querySelector(selector).value,
          `#DAY${day}_HRS-_${line}_E`
        );
        this.table[line][day + 1] = hours ? Number.parseFloat(hours) : '';
      }
    }

    await this._refreshTimesheetStatus();
  }

  async _dates() {
    const start = await this._startdate();
    const end = await this._enddate();
    const difference = end.diff(start, 'days') + 1;
    return [...Array(difference).keys()].map(i => start.clone().add(i, 'days'));
  }

  async _startdate() {
    await this.page.waitForSelector('#hdDiv26_1', { visible: true });
    return moment(new Date(await this.page.evaluate(() => document.querySelector('#hdDiv26_1').textContent)));
  }

  async _enddate() {
    await this.page.waitForSelector('#END_DT', { visible: true });
    return moment(new Date(await this.page.evaluate(() => document.querySelector('#END_DT').value)));
  }

  async _projects() {
    await this.page.waitForSelector('#LINE_DESC-_0_E');
    return await this.page.evaluate(() =>
      Array.from(document.querySelectorAll('.dRw'))
        .filter(e => e.id.includes('row'))
        .map((e, i) => [
          i,
          ...Array.from(e.querySelectorAll('input.tDFRQ'))
            .map(e => e.value.trim())
            .filter(Boolean),
        ])
        .map(([line, description]) => {
          return { line, description };
        })
    );
  }

  async _select(line) {
    const selector = '#UDT02_ID-_' + line + '_E';
    await this.page.waitForSelector(selector, { visible: true });
    await this.page.click(selector);
  }

  async _skip() {
    await this.page.keyboard.press('Tab');
    await this.page.keyboard.press('Tab');
    await this.page.keyboard.press('Tab');
    await this.page.keyboard.press('Tab');
    await this.page.keyboard.press('Tab');
  }

  async _waitForIdle() {
    // Wait for Costpoint's "please wait" overlay to clear.
    // The app sets a 'wait' attribute on <html> while processing.
    await this.page.waitForFunction(
      () => {
        return !document.documentElement.hasAttribute('wait');
      },
      { timeout: 30000 }
    );
  }

  async _waitForResponse() {
    await this.page.waitForResponse(isServletPost);
  }

  // Start waiting before the key or click that sends the save, so a fast
  // response is not missed. A request whose body Puppeteer did not keep
  // (postData() undefined) still counts.
  _waitForSaveResponse() {
    return this.page.waitForResponse(response => {
      if (!isServletPost(response)) return false;
      const body = response.request().postData?.();
      return body === undefined || body.includes('206ATMMTIMESHEET');
    });
  }

  async _refreshTimesheetStatus() {
    const rawStatus = await this.page.evaluate(() => {
      const readValue = el => {
        if (!el) return '';
        if ('value' in el && typeof el.value === 'string' && el.value.trim()) {
          return el.value.trim();
        }
        if (typeof el.textContent === 'string' && el.textContent.trim()) {
          return el.textContent.trim();
        }
        return '';
      };

      const selectors = [
        '#S_STATUS_CD',
        "[name='S_STATUS_CD']",
        "[id='S_STATUS_CD']",
        "[id^='S_STATUS_CD-']",
        "[id*='S_STATUS_CD']",
        "[data-obj-id='S_STATUS_CD']",
      ];

      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        for (const element of elements) {
          const value = readValue(element);
          if (value) return value;
        }
      }

      const statusLabels = Array.from(document.querySelectorAll('label, span, div, td')).filter(element => {
        const text = element.textContent ? element.textContent.trim().replace(/:$/, '') : '';
        return text === 'Status';
      });

      for (const label of statusLabels) {
        let current = label;
        for (let depth = 0; depth < 2 && current; depth += 1) {
          let sibling = current.nextElementSibling;
          while (sibling) {
            const value = readValue(sibling);
            if (value && value.toLowerCase() !== 'status') {
              return value;
            }
            sibling = sibling.nextElementSibling;
          }
          current = current.parentElement;
        }
      }

      return '';
    });

    const statusMeta = normalizeTimesheetStatus(rawStatus);
    this.timesheetStatus = statusMeta.label;
    this.timesheetStatusCode = statusMeta.code;
  }
}

function isServletPost(response) {
  return response.url().includes('MasterServlet.cps') && response.request().method() === 'POST';
}

Costpoint.NotSupportedError = NotSupportedError;
module.exports = Costpoint;
