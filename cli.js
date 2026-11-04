#!/usr/bin/env node
'use strict';

const chalk = require('chalk');
const Table = require('cli-table');
const Costpoint = require('./costpoint');
const { program, InvalidArgumentError } = require('commander');
const readline = require('readline');
const ora = require('ora');
const { normalizeTimesheetStatus } = require('./timesheet-status');
const { getCredentials, login, logout } = require('./credentials');
const { COMMON_CODES, resolveAlias } = require('./charge-codes');
const { normalizeWorkLocation } = require('./add-options');
const { weekLabel, weekSummary } = require('./week-label');
const { launchForPeriod } = require('./session');

require('dotenv').config();

// ── Visual helpers ───────────────────────────────────────────────

function spin(text) {
  process.stdout.write(`  ${text}\r`);
  return ora({ text, color: 'cyan', spinner: 'dots' }).start();
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
    console.error(chalk.red('No credentials found. Run `te login` to set up.'));
    process.exit(1);
  }
  if (!_creds.useDirect && !_creds.system) {
    console.error(
      chalk.red(
        'COSTPOINT_SYSTEM is required when not using direct mode. Set COSTPOINT_DIRECT=true for direct protocol.'
      )
    );
    process.exit(1);
  }
  return _creds;
}

// Refuse a Puppeteer-mode feature before the browser logs in
function requireDirect(feature) {
  if (!requireCredentials().useDirect) throw new Costpoint.NotSupportedError(feature);
}

function parseBack(value) {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new InvalidArgumentError('must be an integer >= 1.');
  }
  return Number(value);
}

// Weeks back from the current one: 0 = current, 1 = --prev or --back 1
function resolveBack(options = {}) {
  if (options.prev && options.back !== undefined) {
    throw new Error('Use either --prev or --back <n>, not both.');
  }
  if (options.prev) return 1;
  return options.back || 0;
}

function withWeekOptions(command, verb) {
  return command
    .option('-p, --prev', `${verb} the previous week (direct mode only)`)
    .option('-b, --back <n>', `${verb} the week <n> weeks back, n >= 1 (direct mode only)`, parseBack);
}

// Selects the requested past week right after launch, before anything else
// runs on the session
async function connect(options = {}) {
  const back = resolveBack(options);
  if (back && !requireCredentials().useDirect) {
    throw new Error('--prev and --back are only supported in direct mode (COSTPOINT_DIRECT=true).');
  }
  const week = back ? weekLabel(back) : null;
  let s = spin('Authenticating...');
  let loggedIn = false;
  const onLogin = () => {
    loggedIn = true;
    s.succeed('Authenticated');
    s = spin(`Loading ${week}...`);
  };
  let cp;
  try {
    cp = await launchForPeriod(requireCredentials(), back, { onLogin });
  } catch (e) {
    s.fail(loggedIn ? `Could not load ${week}` : 'Authentication failed');
    throw e;
  }
  if (loggedIn) s.succeed(`${week[0].toUpperCase()}${week.slice(1)} loaded`);
  else s.succeed('Authenticated');
  return cp;
}

async function askLine(prompt) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise(resolve => rl.question(prompt, resolve));
  rl.close();
  return answer;
}

async function askYesNo(prompt) {
  return /^y(es)?$/i.test((await askLine(prompt)).trim());
}

// Stops the spinner either way, so a failure message prints on a clean line
async function withSpinner(text, done, fn) {
  const s = spin(text + '...');
  try {
    const result = await fn();
    s.succeed(done);
    return result;
  } catch (e) {
    s.fail(text + ' failed');
    throw e;
  }
}

async function saveWithSpinner(cp) {
  const s = spin('Saving...');
  try {
    await cp.save();
    s.succeed('Saved');
  } catch (e) {
    if (e.name !== 'RevisionRequiredError') {
      s.fail('Save failed');
      throw e;
    }
    s.warn('Revision explanation required');

    if (e.auditDetails.length > 0) {
      console.log(chalk.dim('  Changes requiring explanation:'));
      for (const d of e.auditDetails) {
        console.log(chalk.dim(`    Line ${d.lineNo}: ${d.description} (${d.project})`));
      }
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const explanation = await new Promise(resolve => {
      rl.question(chalk.yellow('  Enter explanation: '), answer => {
        rl.close();
        resolve(answer.trim());
      });
    });

    if (!explanation) {
      throw new Error('Revision explanation is required. Save cancelled.');
    }

    const s2 = spin('Saving...');
    try {
      await cp.saveWithExplanation(explanation);
      s2.succeed('Saved');
    } catch (e2) {
      s2.fail('Save failed');
      throw e2;
    }
  }
}

function showStatus(cp) {
  const data = cp.getData();
  console.log(`\n  Status: ${statusBadge(data.timesheetStatus)}`);
}

// Editing a processed previous week reopens it, and it must be signed again
function hintSignPrev(cp, options) {
  const back = resolveBack(options);
  if (!back) return;
  if (normalizeTimesheetStatus(cp.getData().timesheetStatusCode).tone !== 'open') return;
  const flag = back === 1 ? '--prev' : `--back ${back}`;
  const label = weekLabel(back);
  console.log(
    chalk.yellow(`\n  ${label[0].toUpperCase()}${label.slice(1)} is Open again. Sign it with \`te sign ${flag}\``)
  );
}

// ── Commands ─────────────────────────────────────────────────────

program.name('te').version(require('./package.json').version).description('Time entry CLI for Costpoint.');

withWeekOptions(program.command('show').description('show timesheet'), 'show').action(async options => {
  try {
    const cp = await connect(options);
    showStatus(cp);
    console.log(`  ${weekSummary(cp.getData())}`);
    console.log();
    cp.display();
    await cp.close();
  } catch (e) {
    console.error(chalk.red(`\n  ${e.message}`));
    process.exit(1);
  }
});

withWeekOptions(
  program.command('sign').description('sign timesheet').option('-y, --yes', 'skip confirmation prompt'),
  'sign'
).action(async options => {
  try {
    // connect() runs nothing but the period select before the sign, which
    // keeps the session fresh as signing requires
    const cp = await connect(options);
    showStatus(cp);
    console.log();
    cp.display();

    let shouldSign = options.yes;
    if (!shouldSign) {
      const back = resolveBack(options);
      const which = back ? `the ${weekLabel(back)}` : 'this timesheet';
      shouldSign = await askYesNo(`\n  Sign ${which}? (y/n): `);
    }

    if (shouldSign) {
      const s = spin('Signing...');
      try {
        await cp.sign();
        s.succeed('Signed');
      } catch (e) {
        s.fail('Signing failed');
        throw e;
      }
    } else {
      console.log(chalk.dim('  Signing cancelled.'));
    }

    await cp.close();
  } catch (e) {
    console.error(chalk.red(`\n  ${e.message}`));
    process.exit(1);
  }
});

withWeekOptions(
  program
    .command('set <line> <day> <hours>')
    .description('set hours for given project line and day')
    .option('-c, --comment <text>', 'comment for the cell (direct mode only)'),
  'edit'
).action(async (line, day, hours, options) => {
  const lineNum = parseInt(line, 10);
  const dayNum = parseInt(day, 10);
  const hrs = Number(hours);
  if (Number.isNaN(lineNum) || Number.isNaN(dayNum) || Number.isNaN(hrs)) {
    console.error(chalk.red('  Invalid arguments: line, day, and hours must be numeric.'));
    process.exit(1);
  }
  if (options.comment && !requireCredentials().useDirect) {
    console.error(chalk.red('  --comment is only supported in direct mode (COSTPOINT_DIRECT=true).'));
    process.exit(1);
  }
  try {
    const cp = await connect(options);

    const s = spin(`Setting line ${lineNum}, day ${dayNum} → ${hrs}h...`);
    try {
      await cp.set(lineNum, dayNum, hrs, options.comment);
    } catch (e) {
      s.fail(`Could not set line ${lineNum}, day ${dayNum}`);
      throw e;
    }
    s.succeed(`Line ${lineNum}, day ${dayNum} → ${hrs}h`);

    await saveWithSpinner(cp);
    showStatus(cp);
    console.log();
    cp.display();
    hintSignPrev(cp, options);
    await cp.close();
  } catch (e) {
    console.error(chalk.red(`\n  ${e.message}`));
    process.exit(1);
  }
});

withWeekOptions(
  program
    .command('setm <values...>')
    .description('set hours for multiple project lines and days')
    .usage('[--prev | --back <n>] <line> <day> <hours>, <line> <day> <hours>, ...'),
  'edit'
).action(async (xs, options) => {
  xs = xs.map(x => x.replace(/,/g, '')).filter(Boolean);

  if (xs.length % 3 !== 0) {
    console.error(chalk.red('  Invalid input: values must be provided in groups of three (line day hours).'));
    process.exit(1);
  }

  for (let i = 0; i < xs.length; i += 3) {
    const line = parseInt(xs[i], 10);
    const day = parseInt(xs[i + 1], 10);
    const hours = Number(xs[i + 2]);
    if (Number.isNaN(line) || Number.isNaN(day) || Number.isNaN(hours)) {
      console.error(chalk.red(`  Invalid arguments at position ${i / 3 + 1}: line, day, and hours must be numeric.`));
      process.exit(1);
    }
  }

  try {
    const cp = await connect(options);

    const count = xs.length / 3;
    const s = spin(`Updating ${count} cell${count > 1 ? 's' : ''}...`);
    try {
      for (let i = 0; i < xs.length; i += 3) {
        const line = parseInt(xs[i], 10);
        const day = parseInt(xs[i + 1], 10);
        const hours = Number(xs[i + 2]);
        await cp.set(line, day, hours);
        s.text = `Updating cells... (${i / 3 + 1}/${count})`;
      }
    } catch (e) {
      s.fail('Update failed');
      throw e;
    }
    s.succeed(`${count} cell${count > 1 ? 's' : ''} updated`);

    await saveWithSpinner(cp);
    showStatus(cp);
    console.log();
    cp.display();
    hintSignPrev(cp, options);
    await cp.close();
  } catch (e) {
    console.error(chalk.red(`\n  ${e.message}`));
    process.exit(1);
  }
});

async function askWorkLocation(pending) {
  const current = pending.workLocation || 'none';
  const answer = await askLine(`  Pay type: ${pending.payType || '?'}. Work location [${current}]: `);
  return normalizeWorkLocation(answer);
}

withWeekOptions(
  program
    .command('add [code] [payType]')
    .description(
      'add project code to timesheet (pick from favorites if no code given)\n' +
        '  Shortcuts: ' +
        COMMON_CODES.map(c => c.alias).join(', ') +
        '\n' +
        "  e.g. 'te add pto' → ZLEAVE.CMP (REG)"
    ),
  'add to'
)
  .option('-f, --favorite', 'also add the code to your Costpoint favorites')
  .option('-l, --location <zip>', "work location zip code (default: Costpoint's)")
  .option('-i, --ask', "show Costpoint's default work location and ask for one (TTY)")
  .action(async (code, payType, options) => {
    try {
      const explicitLocation = normalizeWorkLocation(options.location);
      if (!code) requireDirect('Picking from favorites');
      const cp = await connect(options);
      let fromFavorites = false;

      if (!code) {
        const picked = await pickFromFavorites(cp);
        if (!picked) {
          await cp.close();
          return;
        }
        code = picked.code;
        fromFavorites = true;
        if (!payType) payType = picked.payType || undefined;
      } else {
        const alias = resolveAlias(code);
        if (alias) {
          if (!payType) payType = alias.payType;
          code = alias.code;
        }
      }

      const label = payType ? `${code} (${payType})` : code;
      const ask = options.ask && !explicitLocation && process.stdin.isTTY;
      const s = ask ? null : spin(`Adding ${label}...`);
      await cp.add(code, payType, {
        workLocation: ask ? askWorkLocation : explicitLocation,
      });
      if (s) s.succeed(`Added ${label}`);
      else console.log(chalk.green(`  Added ${label}`));

      const wantFavorite =
        options.favorite ||
        (!fromFavorites && process.stdin.isTTY && (await askYesNo(`  Also add ${label} to your favorites? (y/N): `)));
      if (wantFavorite) await addToFavoritesWithSpinner(cp);

      await saveWithSpinner(cp);
      showStatus(cp);
      console.log();
      cp.display();
      hintSignPrev(cp, options);
      await cp.close();
    } catch (e) {
      console.error(chalk.red(`\n  ${e.message}`));
      process.exit(1);
    }
  });

async function addToFavoritesWithSpinner(cp) {
  const s = spin('Adding to favorites...');
  try {
    await cp.addToFavorites();
    s.succeed('Added to favorites');
  } catch (e) {
    s.warn(`Could not add to favorites: ${e.message}`);
  }
}

async function pickFromFavorites(cp) {
  const favs = await withSpinner('Loading favorites', 'Favorites loaded', () => cp.getFavorites({ keepLine: true }));
  console.log();

  if (favs.length === 0) {
    console.log(chalk.dim("  No favorites saved. Run 'te add <code>' or save favorites in the Costpoint web UI."));
    return null;
  }

  const t = new Table({
    head: [chalk.cyan('#'), chalk.cyan('Code'), chalk.cyan('Description'), chalk.cyan('Pay Type')],
  });
  favs.forEach((f, i) => t.push([i + 1, f.code, f.description || '', f.payType || '']));
  console.log(t.toString());
  console.log();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(resolve => {
    rl.question(`  Pick favorite [1-${favs.length}] or Enter to cancel: `, resolve);
  });
  rl.close();

  const trimmed = (answer || '').trim();
  if (!trimmed) return null;
  const n = parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 1 || n > favs.length) {
    console.log(chalk.red(`  Invalid selection: ${trimmed}`));
    return null;
  }
  return favs[n - 1];
}

// Favorites belong to the user, not a week, so there is no week option
program
  .command('favorites')
  .alias('fav')
  .description('list favorite charge codes saved in Costpoint')
  .action(async () => {
    try {
      requireDirect('Favorites');
      const cp = await connect();
      const favs = await withSpinner('Loading favorites', 'Favorites loaded', () => cp.getFavorites());
      console.log();

      if (favs.length === 0) {
        console.log(chalk.dim('  No favorites found. Add them in the Costpoint web UI.'));
      } else {
        const t = new Table({
          head: [chalk.cyan('#'), chalk.cyan('Code'), chalk.cyan('Description'), chalk.cyan('Pay Type')],
        });
        favs.forEach((f, i) => t.push([i, f.code, f.description || '', f.payType || '']));
        console.log(t.toString());
      }
      console.log();
      await cp.close();
    } catch (e) {
      console.error(chalk.red(`\n  ${e.message}`));
      process.exit(1);
    }
  });

program
  .command('leave')
  .description('show leave balances')
  .action(async () => {
    try {
      requireDirect('Leave balances');
      const cp = await connect();

      const { balances, details } = await withSpinner('Loading balances', 'Balances loaded', () =>
        cp.getLeaveBalances()
      );
      console.log();

      if (balances.length === 0) {
        console.log(chalk.dim('  No leave balances found.'));
      } else {
        const balTable = new Table({
          head: [chalk.cyan('Leave Type'), chalk.cyan('Balance')],
          colAligns: ['left', 'right'],
        });
        for (const b of balances) {
          balTable.push([b.description, b.balance.toFixed(4)]);
        }
        console.log(balTable.toString());
      }

      if (details.length > 0) {
        console.log(chalk.dim('\n  Recent Leave Activity:'));
        const detTable = new Table({
          head: [chalk.cyan('Date'), chalk.cyan('Type'), chalk.cyan('Hours'), chalk.cyan('Leave Type')],
          colAligns: ['left', 'left', 'right', 'left'],
        });
        for (const d of details) {
          detTable.push([d.date, d.type, d.hours.toFixed(4), d.leaveTypeDesc || d.leaveTypeCode]);
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
  .command('server')
  .description('start the web UI')
  .action(() => {
    require('./server');
  });

program
  .command('tui')
  .description('start the interactive terminal UI')
  .action(() => {
    require('./tui');
  });

program
  .command('login')
  .description('store credentials in OS keychain')
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
  .command('logout')
  .description('remove stored credentials')
  .action(() => {
    logout();
    console.log(chalk.green('  Credentials removed.'));
  });

if (require.main === module) {
  program.parse(process.argv);
}

module.exports = { parseBack, resolveBack, weekLabel, program };
