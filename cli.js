#!/usr/bin/env node
"use strict";

const chalk = require("chalk");
const costpoint = require("./costpoint");
const { program } = require("commander");

require("dotenv").config();

const url = process.env.COSTPOINT_URL;
const username = process.env.COSTPOINT_USERNAME;
const password = process.env.COSTPOINT_PASSWORD;
const system = process.env.COSTPOINT_SYSTEM;

if (
  typeof url === "undefined" ||
  typeof username === "undefined" ||
  typeof password === "undefined" ||
  typeof system === "undefined"
) {
  console.error(
    chalk.red(
      "Make sure that COSTPOINT_URL, COSTPOINT_USERNAME, COSTPOINT_PASSWORD, COSTPOINT_SYSTEM are set in the environment."
    )
  );
  process.exit(1);
}

program
  .name("costpoint")
  .version(require("./package.json").version)
  .description("A command line utility for Costpoint.");

program
  .command("show")
  .description("show timesheet")
  .action(async () => {
    const cp = await costpoint.launch(url, username, password, system);
    cp.display();
    await cp.close();
  });

program
  .command("set <line> <day> <hours>")
  .description("set hours for given project line and day")
  .action(async (line, day, hours) => {
    const cp = await costpoint.launch(url, username, password, system);
    await cp.set(line, day, hours);
    await cp.save();
    cp.display();
    await cp.close();
  });

program
  .command("setm <values...>")
  .description("set hours for multiple project lines and days")
  .usage("<line> <day> <hours>, <line> <day> <hours>, ...")
  .action(async xs => {
    xs = xs.map(x => x.replace(/,/g, "")).filter(Boolean);

    if (xs.length % 3 !== 0) {
      console.error(chalk.red("Not enough values provided."));
      process.exit(1);
    }

    const cp = await costpoint.launch(url, username, password, system);
    for (let i = 0; i < xs.length; i += 3) {
      const line = xs[i];
      const day = xs[i + 1];
      const hours = xs[i + 2];
      await cp.set(line, day, hours);
    }

    await cp.save();
    cp.display();
    await cp.close();
  });

program
  .command("add <code>")
  .description("add project code to timesheet")
  .action(async code => {
    const cp = await costpoint.launch(url, username, password, system);
    await cp.add(code);
    cp.display();
    await cp.save();
    await cp.close();
  });

program.parse(process.argv);
