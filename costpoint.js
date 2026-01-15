"use strict";

const chalk = require("chalk");
const moment = require("moment");
const puppeteer = require("puppeteer");
const Table = require("cli-table");

class Costpoint {
  constructor() {
    this.browser = null;
    this.page = null;
    this.table = null;
    this.dates = null;
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

  async save() {
    await this.page.keyboard.press("F5");
    await this._waitForResponse();
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

  async add(code) {
    await this.page.evaluate(() => {
      const button = Array.from(document.querySelectorAll("#newBttn")).pop();
      button.click();
    });
    await this.page.waitForSelector(`input[type="text"]:focus`, {
      visible: true
    });
    await this.page.click(`input[type="text"]:focus`);
    await this.page.type(`input[type="text"]:focus`, code);
    await this.page.waitForSelector("#fldAutoCompleteDiv", { visible: true });
    const invalid = await this.page.evaluate(
      () =>
        document.querySelector("#v10.fldAutoCEItem").textContent ===
        "no values found"
    );
    if (invalid) {
      console.error(chalk.red("Project code does not exist."));
      process.exit(1);
    }
    await this.page.keyboard.press("Tab");
    await this.page.waitFor(
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
  }

  async _launch() {
    this.browser = await puppeteer.launch({
      defaultViewport: { width: 1920, height: 1080 },
      headless: process.env.DEBUG === undefined
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
    // so we wait a bit here
    await new Promise(r => setTimeout(r, 2000));
    await this.page.locator("#btnPromptSSO").click();

    await this.page.waitForSelector("#loginBtn", { visible: true });
    await this.page.locator("#USER").fill(username);
    await this.page.locator("#loginBtn").click();
    await this.page.locator("#CLIENT_PASSWORD").fill(password);

    await this.page.waitForSelector("#loginBtn", { visible: true });
    await this.page.click("#loginBtn");
    try {

      await this.page.waitForSelector("#loginBtn", {
        hidden: true,
        timeout: 10000
      });

      await this.page.locator("#ackBtn").click();
      // Tell it not to try to install the "app"
      await this.page.locator("#pdlgNever").click();

      //await new Promise(() => {}); // never resolves

    } catch (e) {
      console.error(
        chalk.red(
          "Invalid login information. Make sure that COSTPOINT_URL, COSTPOINT_USERNAME, COSTPOINT_PASSWORD, COSTPOINT_SYSTEM are escaped correctly."
        )
      );
      process.exit(1);
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
  }

  async _waitForResponse() {
    await this.page.waitForResponse(
      response =>
        response.url().includes("MasterServlet.cps") &&
        response.request().method() === "POST"
    );
  }
}

module.exports = Costpoint;
