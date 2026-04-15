#!/usr/bin/env node
"use strict";

const chalk = require("chalk");
const Table = require("cli-table");
const Costpoint = require("./costpoint");
const DirectClient = require("./direct");
const { program } = require("commander");
const readline = require("readline");
const ora = require("ora");
const { normalizeTimesheetStatus } = require("./timesheet-status");
const { getCredentials, login, logout } = require("./credentials");

require("dotenv").config();

const { RevisionRequiredError } = DirectClient;

// ── Visual helpers ───────────────────────────────────────────────

function spin(text) {
  process.stdout.write(`  ${text}\r`);
  return ora({ text, color: "cyan", spinner: "dots" }).start();
}

function statusBadge(statusStr) {
  const { label, tone } = normalizeTimesheetStatus(statusStr);
  const colors = {
    approved: chalk.green,
    signed: chalk.cyan,
    open: chalk.yellow,
    missing: chalk.red,
    rejected: chalk.redBright.bold,
    processed: chalk.blue,
    unknown: chalk.gray,
  };
  return (colors[tone] || colors.unknown)(`● ${label}`);
}

// ── Core operation wrappers ──────────────────────────────────────

let _creds = null;

function requireCredentials() {
  if (_creds) return _creds;
  _creds = getCredentials();
  if (!_creds) {
    console.error(
      chalk.red("No credentials found. Run `te login` to set up."),
    );
    process.exit(1);
  }
  if (!_creds.useDirect && !_creds.system) {
    console.error(
      chalk.red(
        "COSTPOINT_SYSTEM is required when not using direct mode. Set COSTPOINT_DIRECT=true for direct protocol.",
      ),
    );
    process.exit(1);
  }
  return _creds;
}

function launchClient() {
  const { url, username, password, system, useDirect } = requireCredentials();
  if (useDirect) return DirectClient.launch(url, username, password);
  return Costpoint.launch(url, username, password, system);
}

async function connect() {
  const s = spin("Authenticating...");
  try {
    const cp = await launchClient();
    s.succeed("Authenticated");
    return cp;
  } catch (e) {
    s.fail("Authentication failed");
    throw e;
  }
}

async function saveWithSpinner(cp) {
  const s = spin("Saving...");
  try {
    await cp.save();
    s.succeed("Saved");
  } catch (e) {
    if (e.name !== "RevisionRequiredError") {
      s.fail("Save failed");
      throw e;
    }
    s.warn("Revision explanation required");

    if (e.auditDetails.length > 0) {
      console.log(chalk.dim("  Changes requiring explanation:"));
      for (const d of e.auditDetails) {
        console.log(
          chalk.dim(`    Line ${d.lineNo}: ${d.description} (${d.project})`),
        );
      }
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const explanation = await new Promise((resolve) => {
      rl.question(chalk.yellow("  Enter explanation: "), (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });

    if (!explanation) {
      throw new Error("Revision explanation is required. Save cancelled.");
    }

    const s2 = spin("Saving...");
    try {
      await cp.saveWithExplanation(explanation);
      s2.succeed("Saved");
    } catch (e2) {
      s2.fail("Save failed");
      throw e2;
    }
  }
}

function showStatus(cp) {
  const data = cp.getData();
  console.log(`\n  Status: ${statusBadge(data.timesheetStatus)}`);
}

// ── Commands ─────────────────────────────────────────────────────

program
  .name("te")
  .version(require("./package.json").version)
  .description("Time entry CLI for Costpoint.");

program
  .command("show")
  .description("show timesheet")
  .action(async () => {
    try {
      const cp = await connect();
      showStatus(cp);
      console.log();
      cp.display();
      await cp.close();
    } catch (e) {
      console.error(chalk.red(`\n  ${e.message}`));
      process.exit(1);
    }
  });

program
  .command("sign")
  .description("sign timesheet")
  .option("-y, --yes", "skip confirmation prompt")
  .action(async (options) => {
    try {
      const cp = await connect();
      showStatus(cp);
      console.log();
      cp.display();

      let shouldSign = options.yes;
      if (!shouldSign) {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        shouldSign = await new Promise((resolve) => {
          rl.question("\n  Sign this timesheet? (y/n): ", (answer) => {
            rl.close();
            resolve(
              answer.toLowerCase() === "y" || answer.toLowerCase() === "yes",
            );
          });
        });
      }

      if (shouldSign) {
        const s = spin("Signing...");
        try {
          await cp.sign();
          s.succeed("Signed");
        } catch (e) {
          s.fail("Signing failed");
          throw e;
        }
      } else {
        console.log(chalk.dim("  Signing cancelled."));
      }

      await cp.close();
    } catch (e) {
      console.error(chalk.red(`\n  ${e.message}`));
      process.exit(1);
    }
  });

program
  .command("set <line> <day> <hours>")
  .description("set hours for given project line and day")
  .option("-c, --comment <text>", "comment for the cell (direct mode only)")
  .action(async (line, day, hours, options) => {
    const lineNum = parseInt(line, 10);
    const dayNum = parseInt(day, 10);
    const hrs = Number(hours);
    if (Number.isNaN(lineNum) || Number.isNaN(dayNum) || Number.isNaN(hrs)) {
      console.error(
        chalk.red("  Invalid arguments: line, day, and hours must be numeric."),
      );
      process.exit(1);
    }
    if (options.comment && !requireCredentials().useDirect) {
      console.error(
        chalk.red(
          "  --comment is only supported in direct mode (COSTPOINT_DIRECT=true).",
        ),
      );
      process.exit(1);
    }
    try {
      const cp = await connect();

      const s = spin(`Setting line ${lineNum}, day ${dayNum} → ${hrs}h...`);
      await cp.set(lineNum, dayNum, hrs, options.comment);
      s.succeed(`Line ${lineNum}, day ${dayNum} → ${hrs}h`);

      await saveWithSpinner(cp);
      showStatus(cp);
      console.log();
      cp.display();
      await cp.close();
    } catch (e) {
      console.error(chalk.red(`\n  ${e.message}`));
      process.exit(1);
    }
  });

program
  .command("setm <values...>")
  .description("set hours for multiple project lines and days")
  .usage("<line> <day> <hours>, <line> <day> <hours>, ...")
  .action(async (xs) => {
    xs = xs.map((x) => x.replace(/,/g, "")).filter(Boolean);

    if (xs.length % 3 !== 0) {
      console.error(
        chalk.red(
          "  Invalid input: values must be provided in groups of three (line day hours).",
        ),
      );
      process.exit(1);
    }

    for (let i = 0; i < xs.length; i += 3) {
      const line = parseInt(xs[i], 10);
      const day = parseInt(xs[i + 1], 10);
      const hours = Number(xs[i + 2]);
      if (Number.isNaN(line) || Number.isNaN(day) || Number.isNaN(hours)) {
        console.error(
          chalk.red(
            `  Invalid arguments at position ${i / 3 + 1}: line, day, and hours must be numeric.`,
          ),
        );
        process.exit(1);
      }
    }

    try {
      const cp = await connect();

      const count = xs.length / 3;
      const s = spin(`Updating ${count} cell${count > 1 ? "s" : ""}...`);
      for (let i = 0; i < xs.length; i += 3) {
        const line = parseInt(xs[i], 10);
        const day = parseInt(xs[i + 1], 10);
        const hours = Number(xs[i + 2]);
        await cp.set(line, day, hours);
        s.text = `Updating cells... (${i / 3 + 1}/${count})`;
      }
      s.succeed(`${count} cell${count > 1 ? "s" : ""} updated`);

      await saveWithSpinner(cp);
      showStatus(cp);
      console.log();
      cp.display();
      await cp.close();
    } catch (e) {
      console.error(chalk.red(`\n  ${e.message}`));
      process.exit(1);
    }
  });

program
  .command("add <code> [payType]")
  .description(
    "add project code to timesheet (payType: REG, RHB, etc. for multi-charge codes)",
  )
  .action(async (code, payType) => {
    try {
      const cp = await connect();

      const label = payType ? `${code} (${payType})` : code;
      const s = spin(`Adding ${label}...`);
      await cp.add(code, payType);
      s.succeed(`Added ${label}`);

      await saveWithSpinner(cp);
      showStatus(cp);
      console.log();
      cp.display();
      await cp.close();
    } catch (e) {
      console.error(chalk.red(`\n  ${e.message}`));
      process.exit(1);
    }
  });

program
  .command("leave")
  .description("show leave balances")
  .action(async () => {
    try {
      const cp = await connect();

      const s = spin("Loading balances...");
      const { balances, details } = await cp.getLeaveBalances();
      s.succeed("Balances loaded");
      console.log();

      if (balances.length === 0) {
        console.log(chalk.dim("  No leave balances found."));
      } else {
        const balTable = new Table({
          head: [chalk.cyan("Leave Type"), chalk.cyan("Balance")],
          colAligns: ["left", "right"],
        });
        for (const b of balances) {
          balTable.push([b.description, b.balance.toFixed(4)]);
        }
        console.log(balTable.toString());
      }

      if (details.length > 0) {
        console.log(chalk.dim("\n  Recent Leave Activity:"));
        const detTable = new Table({
          head: [
            chalk.cyan("Date"),
            chalk.cyan("Type"),
            chalk.cyan("Hours"),
            chalk.cyan("Leave Type"),
          ],
          colAligns: ["left", "left", "right", "left"],
        });
        for (const d of details) {
          detTable.push([
            d.date,
            d.type,
            d.hours.toFixed(4),
            d.leaveTypeDesc || d.leaveTypeCode,
          ]);
        }
        console.log(detTable.toString());
      }

      await cp.close();
    } catch (e) {
      console.error(chalk.red(`\n  ${e.message}`));
      process.exit(1);
    }
  });

program
  .command("server")
  .description("start the web UI")
  .action(() => {
    require("./server");
  });

program
  .command("tui")
  .description("start the interactive terminal UI")
  .action(() => {
    require("./tui");
  });

program
  .command("login")
  .description("store credentials in OS keychain")
  .action(async () => {
    try {
      const creds = await login();
      console.log(chalk.green(`\n  Credentials saved for ${creds.username}.`));
    } catch (e) {
      console.error(chalk.red(`\n  ${e.message}`));
      process.exit(1);
    }
  });

program
  .command("logout")
  .description("remove stored credentials")
  .action(() => {
    logout();
    console.log(chalk.green("  Credentials removed."));
  });

program.parse(process.argv);
