#!/usr/bin/env node
"use strict";

const chalk = require("chalk");
const Costpoint = require("./costpoint");
const DirectClient = require("./direct");
const { program } = require("commander");
const readline = require("readline");

require("dotenv").config();

const url = process.env.COSTPOINT_URL;
const username = process.env.COSTPOINT_USERNAME;
const password = process.env.COSTPOINT_PASSWORD;
const system = process.env.COSTPOINT_SYSTEM;
const useDirect = process.env.COSTPOINT_DIRECT === 'true';

if (
  typeof url === "undefined" ||
  typeof username === "undefined" ||
  typeof password === "undefined"
) {
  console.error(
    chalk.red(
      "Make sure that COSTPOINT_URL, COSTPOINT_USERNAME, COSTPOINT_PASSWORD are set in the environment.",
    ),
  );
  process.exit(1);
}

if (!useDirect && typeof system === "undefined") {
  console.error(
    chalk.red(
      "COSTPOINT_SYSTEM is required when not using direct mode. Set COSTPOINT_DIRECT=true for direct protocol.",
    ),
  );
  process.exit(1);
}

async function launchClient() {
  if (useDirect) {
    return DirectClient.launch(url, username, password);
  }
  return Costpoint.launch(url, username, password, system);
}

program
  .name("costpoint")
  .version(require("./package.json").version)
  .description("A command line utility for Costpoint.");

program
  .command("show")
  .description("show timesheet")
  .action(async () => {
    try {
      const cp = await launchClient();
      cp.display();
      await cp.close();
    } catch (e) {
      console.error(chalk.red(`Error showing timesheet: ${e.message}`));
      process.exit(1);
    }
  });

program
  .command("sign")
  .description("sign timesheet")
  .option("-y, --yes", "skip confirmation prompt")
  .action(async (options) => {
    try {
      const cp = await launchClient();
      cp.display();

      let shouldSign = options.yes;
      if (!shouldSign) {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });

        shouldSign = await new Promise((resolve) => {
          rl.question("Do you want to sign this timesheet? (y/n): ", (answer) => {
            rl.close();
            resolve(
              answer.toLowerCase() === "y" || answer.toLowerCase() === "yes",
            );
          });
        });
      }

      if (shouldSign) {
        await cp.sign();
        console.log("The timesheet has been signed successfully.");
      } else {
        console.log("Timesheet signing cancelled.");
      }

      await cp.close();
    } catch (e) {
      console.error(chalk.red(`Error signing timesheet: ${e.message}`));
      process.exit(1);
    }
  });

program
  .command("set <line> <day> <hours>")
  .description("set hours for given project line and day")
  .action(async (line, day, hours) => {
    // Basic validation of inputs
    const lineNum = parseInt(line, 10);
    const dayNum = parseInt(day, 10);
    const hrs = Number(hours);
    if (Number.isNaN(lineNum) || Number.isNaN(dayNum) || Number.isNaN(hrs)) {
      console.error(chalk.red('Invalid arguments: line, day, and hours must be numeric.'));
      process.exit(1);
    }
    try {
      const cp = await launchClient();
      await cp.set(lineNum, dayNum, hrs);
      await cp.save();
      cp.display();
      await cp.close();
    } catch (e) {
      console.error(chalk.red(`Error setting hours: ${e.message}`));
      process.exit(1);
    }
  });

program
  .command("setm <values...>")
  .description("set hours for multiple project lines and days")
  .usage("<line> <day> <hours>, <line> <day> <hours>, ...")
  .action(async (xs) => {
    // Clean up input and ensure correct grouping
    xs = xs.map((x) => x.replace(/,/g, "")).filter(Boolean);

    if (xs.length % 3 !== 0) {
      console.error(chalk.red("Invalid input: values must be provided in groups of three (line day hours)."));
      process.exit(1);
    }

    // Validate each triplet
    for (let i = 0; i < xs.length; i += 3) {
      const line = parseInt(xs[i], 10);
      const day = parseInt(xs[i + 1], 10);
      const hours = Number(xs[i + 2]);
      if (Number.isNaN(line) || Number.isNaN(day) || Number.isNaN(hours)) {
        console.error(chalk.red(`Invalid arguments at position ${i / 3 + 1}: line, day, and hours must be numeric.`));
        process.exit(1);
      }
    }

    try {
      const cp = await launchClient();
      // Apply changes
      for (let i = 0; i < xs.length; i += 3) {
        const line = parseInt(xs[i], 10);
        const day = parseInt(xs[i + 1], 10);
        const hours = Number(xs[i + 2]);
        await cp.set(line, day, hours);
      }

      await cp.save();
      cp.display();
      await cp.close();
    } catch (e) {
      console.error(chalk.red(`Error setting multiple hours: ${e.message}`));
      process.exit(1);
    }
  });

program
  .command("add <code>")
  .description("add project code to timesheet")
  .action(async (code) => {
    // Basic validation – code should be a non‑empty string (alphanumeric and optional dashes/underscores)
    // if (typeof code !== "string" || !/^[\w-]+$/.test(code)) {
    //   console.error(chalk.red('Invalid project code. Must be a non‑empty alphanumeric string.'));
    //   process.exit(1);
    // }
    try {
      const cp = await launchClient();
      await cp.add(code);
      cp.display();
      await cp.save();
      await cp.close();
    } catch (e) {
      console.error(chalk.red(`Error adding project: ${e.message}`));
      process.exit(1);
    }
  });

program.parse(process.argv);
