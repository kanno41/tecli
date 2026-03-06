"use strict";

const chalk = require("chalk");
const moment = require("moment");
const puppeteer = require("puppeteer");
const Table = require("cli-table");
const { normalizeTimesheetStatus } = require("./timesheet-status");

class Costpoint {
  constructor() {
    this.browser = null;
    this.page = null;
    this.table = null;
    this.dates = null;
    this.timesheetStatus = "Unknown";
    this.timesheetStatusCode = "";
  }

  static async launch(url, username, password, database) {
    const costpoint = new Costpoint();
    await costpoint._launch();
    await costpoint._login(url, username, password, database);
    await costpoint._table();
    return costpoint;
  }

  display() {
    console.log(this.table.toString());
  }

  getData() {
    return {
      timesheetStatus: this.timesheetStatus,
      timesheetStatusCode: this.timesheetStatusCode,
      dates: this.dates.map(d => ({
        date: d.date(),
        fullDate: d.format('YYYY-MM-DD'),
        dayOfWeek: d.format('ddd')
      })),
      projects: this.table.map((row, index) => ({
        line: row[0],
        description: row[1],
        hours: Object.fromEntries(
          this.dates.map((d, i) => [d.date(), row[i + 2] === '' ? null : row[i + 2]])
        )
      }))
    };
  }

  async save() {
    console.log("Saving timesheet...");
    // Wait for the app to finish any background processing (please-wait overlay)
    await this._waitForIdle();
    // wait until Save & Continue is actually usable
    await this.page.waitForFunction(() => {
      const btn = document.querySelector('#svCntBttn');
      if (!btn) return false;
      const cs = getComputedStyle(btn);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.pointerEvents !== 'none';
    });
    await this.page.keyboard.press("F6");

    // Handle revisions. Currently overboard for.
    // // wait for the revision explanation prompt to be visible
    // await page.waitForFunction(() => {
    //   const el = document.querySelector('#EXPLANATION_TEXT');
    //   if (!el) return false;
    //   const cs = getComputedStyle(el);
    //   const r = el.getBoundingClientRect();
    //   return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    // });

    // // fill explanation
    // await this.page.locator("#EXPLANATION_TEXT").fill(username);

    // // click Continue
    // await this.page.waitForFunction(() => {
    //   const btn = document.querySelector('#OK_BUT___T');
    //   const r = btn.getBoundingClientRect();
    //   return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    // });
    // await this.page.click('#OK_BUT___T');

    await this._waitForResponse();
    console.log("Timesheet saved.");
    await this._waitForIdle();
    await this._refreshTimesheetStatus();
  }

  async sign() {
    // Wait for Deltek to finish any background work
    try {
      await this.page.waitForFunction(() => {
        const btn = document.querySelector('#SIGN_BUT');
        if (!btn) return false;
        const cs = getComputedStyle(btn);
        const r = btn.getBoundingClientRect();

        // visible + not dimmed
        return cs.display !== 'none'
          && cs.visibility !== 'hidden'
          && r.width > 0 && r.height > 0
          && parseFloat(cs.opacity || '1') >= 1;
      }, { timeout: 10000 });
    } catch (error) {
      console.error(chalk.red("Timesheet is already signed."));
      process.exit(1);
    }

    // Click the sign button and wait for the confirmation dialog
    const dialogPromise = new Promise((resolve) => {
      this.page.once('dialog', async (dialog) => {
        await dialog.accept();
        resolve();
      });
    });
    await this.page.locator("#SIGN_BUT").click();
    await dialogPromise;

    // Wait for the page to finish processing after accepting the dialog
    await this.page.waitForNetworkIdle({ idleTime: 2000 });
    await this._waitForIdle();
    await this._refreshTimesheetStatus();
  }

  async close() {
    await this.browser.close();
  }

  async set(line, day, hours) {
    const start = this.dates[0].date();
    this.table[line][day - start + 2] = hours;

    await this._select(line);
    await this._skip();
    for (let i = 0; i <= day - start; i++) {
      await this.page.keyboard.press("Tab");
    }

    Array.from(hours.toString()).forEach(
      async x =>
        x == "."
          ? await this.page.keyboard.press("Period")
          : await this.page.keyboard.press(x)
    );

    const end = this.dates[this.dates.length - 1].date();
    for (let i = 0; i <= end - day; i++) {
      await this.page.keyboard.press("Tab");
    }
    await this._waitForResponse();
  }

  async setm(changes) {
    // changes is an array of { line, day, hours }
    for (const { line, day, hours } of changes) {
      await this.set(line, day, hours);
    }
  }

  async add(code) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    this.page.keyboard.press("F2");
    //
    // await this.page.evaluate(() => {
    //   const button = Array.from(document.querySelectorAll("#newBttn")).pop();
    //   button.click();
    // });
    //this.page.locator("#newBttn").click();
    //await new Promise(() => {}); // never resolves
    await this.page.waitForSelector("#UDT02_ID-_0_N", {
      visible: true
    });
    await this.page.click("#UDT02_ID-_0_N");
    await this.page.type("#UDT02_ID-_0_N", code);
    await this.page.waitForSelector("#fldAutoCompleteDiv", { visible: true });
    // const invalid = await this.page.evaluate(
    //   () =>
    //     document.querySelector("#v10.fldAutoCEItem").textContent ===
    //     "no values found"
    // );
    // if (invalid) {
    //   console.error(chalk.red("Project code does not exist."));
    //   process.exit(1);
    // }
    await this.page.keyboard.press("Tab");
    await this.page.waitForFunction(
      () => document.querySelector("#LINE_DESC-_0_N").value !== ""
    );
    const description = await this.page.evaluate(
      () => document.querySelector("#LINE_DESC-_0_N").value
    );
    this.table.push([
      this.table.length,
      description,
      ...Array(this.dates.length).fill("")
    ]);
    const table = new Table({
      head: ["Line", "Description", "Code"],
      colWidths: [6, 26, 14]
    });
    table.push([this.table.length - 1, description, code]);
    console.log("The following project has been successfully added:");
    console.log(table.toString());
    //await new Promise(() => {}); // never resolves

  }

  async _launch() {
    this.browser = await puppeteer.launch({
      defaultViewport: { width: 1920, height: 1080 },
      headless: process.env.DEBUG === undefined,
      args: ['--remote-debugging-port=9222', '--remote-debugging-address=127.0.0.1', '--no-sandbox']
    });
    this.page = await this.browser.newPage();
  }

  async _login(url, username, password, database) {
    await this.page.goto(url);

    await this.page.locator("#acknowledgeBtn").click();
    await this.page.type("input[name=\"identifier\"]", username);
    await this.page.evaluate(() => {
      const form = document.querySelector('form');
      form?.requestSubmit();
    });
    await this.page.waitForSelector("input[name=\"credentials.passcode\"]", { visible: true });
    await this.page.type("input[name=\"credentials.passcode\"]", password);

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
    await this.page.locator("#btnPromptSSO").click();

    await this.page.waitForSelector("#loginBtn", { visible: true });
    await this.page.waitForSelector('#signInDiv:not([setupScreen]) #loginBtn:not([disabled])');
    await this.page.waitForSelector('body:not([offline])'); // optional safety
    await this.page.locator("#USER").fill(username);

    await clickLoginBtn(this.page);
    await this.page.locator("#CLIENT_PASSWORD").fill(password);

    await clickLoginBtn(this.page);
    try {

      await this.page.waitForSelector("#loginBtn", {
        hidden: true,
        timeout: 10000
      });

      await this.page.locator("#ackBtn").click();
      // Tell it not to try to install the "app"
      await this.page.locator("#pdlgNever").click();
      await new Promise(resolve => setTimeout(resolve, 5000));

      //await new Promise(() => {}); // never resolves

    } catch (e) {
      console.error(
        chalk.red(
          "Invalid login information. Make sure that COSTPOINT_URL, COSTPOINT_USERNAME, COSTPOINT_PASSWORD, COSTPOINT_SYSTEM are escaped correctly."
        )
      );
      process.exit(1);
    }

    async function clickLoginBtn(page) {
      await page.waitForSelector("#loginBtn", { visible: true });
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
      await page.click("#loginBtn");
    }
  }

  async _table() {
    this.dates = await this._dates();

    this.table = new Table({
      head: ["Line", "Description", ...this.dates.map(d => d.format("D"))],
      colWidths: [6, 26, ...this.dates.slice().fill(5)],
      colAligns: ["middle", "left", ...this.dates.slice().fill("middle")]
    });

    (await this._projects()).forEach(({ line, description }) =>
      this.table.push([line, description, ...Array(this.dates.length).fill("")])
    );

    await this.page.waitForSelector("#pleaseWaitImage", { hidden: true });
    await this._select(0);
    await this._skip();
    for (let day = 1; day <= this.dates.length; day++) {
      await this.page.keyboard.press("Tab");
      for (let line = 0; line < this.table.length; line++) {
        const hours = await this.page.evaluate(
          selector => document.querySelector(selector).value,
          `#DAY${day}_HRS-_${line}_E`
        );
        this.table[line][day + 1] = hours ? Number.parseFloat(hours) : "";
      }
    }

    await this._refreshTimesheetStatus();
  }

  async _dates() {
    const start = await this._startdate();
    const end = await this._enddate();
    const difference = end.diff(start, "days") + 1;
    return [...Array(difference).keys()].map(i => start.clone().add(i, "days"));
  }

  async _startdate() {
    await this.page.waitForSelector("#hdDiv26_1", { visible: true });
    return moment(
      new Date(
        await this.page.evaluate(
          () => document.querySelector("#hdDiv26_1").textContent
        )
      )
    );
  }

  async _enddate() {
    await this.page.waitForSelector("#END_DT", { visible: true });
    return moment(
      new Date(
        await this.page.evaluate(() => document.querySelector("#END_DT").value)
      )
    );
  }

  async _projects() {
    await this.page.waitForSelector("#LINE_DESC-_0_E");
    return await this.page.evaluate(() =>
      Array.from(document.querySelectorAll(".dRw"))
        .filter(e => e.id.includes("row"))
        .map((e, i) => [
          i,
          ...Array.from(e.querySelectorAll("input.tDFRQ"))
            .map(e => e.value.trim())
            .filter(Boolean)
        ])
        .map(([line, description]) => {
          return { line, description };
        })
    );
  }

  async _select(line) {
    const selector = "#UDT02_ID-_" + line + "_E";
    await this.page.waitForSelector(selector, { visible: true });
    await this.page.click(selector);
  }

  async _skip() {
    await this.page.keyboard.press("Tab");
    await this.page.keyboard.press("Tab");
    await this.page.keyboard.press("Tab");
    await this.page.keyboard.press("Tab");
    await this.page.keyboard.press("Tab");
  }

  async _waitForIdle() {
    // Wait for Costpoint's "please wait" overlay to clear.
    // The app sets a 'wait' attribute on <html> while processing.
    await this.page.waitForFunction(() => {
      return !document.documentElement.hasAttribute('wait');
    }, { timeout: 30000 });
  }

  async _waitForResponse() {
    await this.page.waitForResponse(
      response =>
        response.url().includes("MasterServlet.cps") &&
        response.request().method() === "POST"
    );
  }

  async _refreshTimesheetStatus() {
    const rawStatus = await this.page.evaluate(() => {
      const readValue = (el) => {
        if (!el) return "";
        if ("value" in el && typeof el.value === "string" && el.value.trim()) {
          return el.value.trim();
        }
        if (typeof el.textContent === "string" && el.textContent.trim()) {
          return el.textContent.trim();
        }
        return "";
      };

      const selectors = [
        "#S_STATUS_CD",
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

      const statusLabels = Array.from(document.querySelectorAll("label, span, div, td"))
        .filter((element) => {
          const text = element.textContent ? element.textContent.trim().replace(/:$/, "") : "";
          return text === "Status";
        });

      for (const label of statusLabels) {
        let current = label;
        for (let depth = 0; depth < 2 && current; depth += 1) {
          let sibling = current.nextElementSibling;
          while (sibling) {
            const value = readValue(sibling);
            if (value && value.toLowerCase() !== "status") {
              return value;
            }
            sibling = sibling.nextElementSibling;
          }
          current = current.parentElement;
        }
      }

      return "";
    });

    const statusMeta = normalizeTimesheetStatus(rawStatus);
    this.timesheetStatus = statusMeta.label;
    this.timesheetStatusCode = statusMeta.code;
  }
}

module.exports = Costpoint;
