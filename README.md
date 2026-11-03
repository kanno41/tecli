# tecli

Time entry CLI, web UI, and TUI for Costpoint.

## Setup

Requires [Node.js](https://nodejs.org/) 18 or later.

```bash
git clone <repo-url>
cd tecli
npm install
npm link
te login
```

`npm link` makes the `te` command available globally. `te login` prompts for your username and password and stores them in your OS keychain: macOS Keychain, GNOME Keyring (`secret-tool`) on Linux, or Windows DPAPI with the encrypted password in `~/.tecli-credentials`. Nothing is saved in plaintext.

Without `secret-tool` (Linux) or PowerShell (Windows), the password goes to `~/.tecli-credentials` (mode 600), AES-encrypted with a key derived from your hostname and username. That is obfuscation, not protection: anyone who can read the file can derive the key and decrypt it. Install `secret-tool` (`libsecret-tools` on Debian/Ubuntu) to use the keyring instead.

Login goes through Okta SSO. Off the corporate network Okta first serves its desktop-SSO (Kerberos) page; tecli follows the same fallback the browser takes, so no extra step is needed.

## Usage

```
te show                        # show timesheet, signed state and week total
te set <line> <day> <hours>    # set hours (e.g. te set 1 4 8)
te set 0 14 8 -c "on site"     # set hours with a cell comment (direct mode)
te setm 1 1 8, 1 2 8, 1 3 8   # set multiple cells
te show --prev                 # show the previous week
te set --prev 0 25 8           # set hours on the previous week
te add ZLEAVE.HOL              # add a project line
te add ZLEAVE.FTB RHB          # add a multi-charge project line
te add ZLEAVE.HOL --favorite   # also save the code to your Costpoint favorites
te add PROJ.M.400 RHB --location 20190   # override the default work location (zip)
te add PROJ.M.400 RHB --ask              # show Costpoint's defaults, then prompt (TTY)
te sign                        # sign timesheet
te sign --prev                 # sign the previous week
te show --back 3               # show the week 3 weeks back
te add --back 2                # pick a favorite and add it to the week 2 weeks back
te favorites                   # list your favorites (they are not tied to a week)
te fav                         # alias of te favorites
te leave                       # show leave balances
te server                      # start the web UI (port 3000)
te tui                         # start the interactive terminal UI
te login                       # store credentials
te logout                      # remove stored credentials
```

`<day>` is the day of the month. `--prev` and `-b, --back <n>` (direct mode only) work on `show`, `set`, `setm`, `sign` and `add`. `--prev` is `--back 1`, and the two cannot be combined. `<n>` is an integer of 1 or more, capped at the weeks Costpoint lists (about 20); `add` on a past week works the same way as on the current one. Editing a processed previous week reopens it through Costpoint's Correct action and asks for a revision explanation. The week is Open afterwards and has to be signed again with `te sign --prev` (or `te sign --back <n>`). The web UI shows two weeks at a time and slides back through the loaded weeks with `‹ older`, `newer ›` and `Current`. It edits, adds projects to and signs either visible week (a banner shows for any visible past week that is Open), and the TUI walks back through the loaded weeks with `<` and `>` (`[w]` toggles to the last past week viewed), adds projects to the shown week and signs it with `[S]`.

Puppeteer mode (`COSTPOINT_DIRECT` not `true`, `COSTPOINT_SYSTEM` set) drives the active week in a browser: show, set, setm, save, sign and `add <code>` with the default pay type. Past weeks, cell comments, favorites, leave balances, other pay types and work locations stop with "... is not supported in Puppeteer mode; set COSTPOINT_DIRECT=true".

### Examples

`te show` prints the status, then the signed state and the week total, then the grid:

```
$ te show --back 2
  Status: ● Signed
  Signed: yes | Week total: 40h
```

Signed, Approved and Processed weeks count as signed. The total adds every line and day.

Fill the week and sign it:

```bash
te setm 0 13 8, 0 14 8, 0 15 8, 0 16 8, 0 17 8
te set 1 17 0 -c "half day moved to Monday"
te sign            # asks for confirmation; -y skips it
```

Favorites. `te favorites` lists them with a 0-based `#`; `te add` with no code shows the same list numbered from 1 and asks which one to add:

```bash
te fav
te add                        # pick a favorite
te add PROJ.M.400 RHB -f      # add a new code and save it to favorites
te add pto                    # shortcut: pto, personal, flex, lwop, holiday, holdefer
```

On a TTY, `te add <code>` without `-f` asks `Also add ... to your favorites? (y/N)`. A favorite that cannot be saved is a warning; the line is still added.

Fix a processed past week. Costpoint reopens the week (Correct) and asks why; the CLI prompts for it, then reminds you to sign:

```
$ te set --prev 0 5 4
  Revision explanation required
  Changes requiring explanation:
    Line 1: Program support (PROJ.M.400)
  Enter explanation: late correction
  Saved
  Previous week is Open again. Sign it with `te sign --prev`
$ te sign --prev -y
```

`te show --back 25` and the other week commands fail with `Cannot go back 25 weeks. Costpoint offers N past weeks.` when the week is out of reach.

## TUI

`te tui` (or `npm run tui`) opens on the week holding today. A cache left from an earlier week shows as a past week, and `[CACHED]` marks data that has not been fetched yet.

| Key | Action |
|-----|--------|
| arrows, Tab | Move between cells |
| digits, Enter | Edit a cell; Enter confirms and moves right |
| Backspace / Delete | Clear a cell |
| `s` | Save the shown week (a needed revision explanation is prompted for) |
| `S` | Sign the shown week, on a fresh login |
| `C` | Comment on the current cell |
| `c` | Copy Thursday to Friday (current week only) |
| `<` / `>` | One week older / newer (blocked while changes are unsaved) |
| `w` | Toggle between the current week and the last past week viewed |
| `a` | Add a project: a numbered shortcut, `0` or `c` for a custom code (then pay type, work location, and "Also add to favorites? [y/N]") |
| `f` | Favorites list: type its number to add it to the shown week (`1` waits when there are 10 or more, `13` or `1` + Enter picks), `e` asks pay type and work location for the next pick |
| `l` | Leave balances |
| `r` | Refresh |
| `q` | Quit |

Example: fix last week's Tuesday. Press `<`, move to the cell, type `4`, Enter, `s`, give the explanation, then `S` and `y` to sign it again.

## Web UI

`te server` serves http://127.0.0.1:3000 (`PORT` changes it) and listens on the loopback interface only, so other hosts cannot reach it. It answers only its own page: requests must name `127.0.0.1` or `localhost` in Host (and in Origin when the browser sends one), and every `/api` call carries a random token the server puts in the page at each start. A restart changes the token, so reload an open tab after one. It shows two weeks side by side; `‹ older`, `newer ›` and `Current` slide the pair. Each editable unsigned week has its own Sign button, and the Add Project and Favorites dialogs ask which visible week to add to (Add Project has an "Also add to favorites" checkbox and a work location field). Past-week edits need direct mode.

## MCP Server

The MCP server exposes timesheet tools to AI assistants like Claude. It uses stdio transport and the same credential system as the CLI.

### Available tools

Tools that work on a week take `back`: weeks back from the current one (0 or omitted = current, 1 = previous week). `list_weeks` shows what is reachable.

| Tool | Description |
|------|-------------|
| `list_weeks` | List the reachable weeks (about 20) with back number, end date, status and whether they can be edited |
| `show_timesheet` | Show a week's hours, status, signed state, week total and comments (`back?`) |
| `set_hours` | Set hours for one line and day, with an optional comment (`line`, `day`, `hours`, `comment?`, `back?`) |
| `set_hours_bulk` | Set several cells of one week at once (`changes[]`, `back?`) |
| `add_project` | Add a charge code to a week (`code`, `payType?`, `workLocation?`, `favorite?`, `back?`). Shortcuts: `pto`, `flex`, `personal`, `holiday`, `lwop`, `holdefer` |
| `list_favorites` | List the favorites saved in Costpoint |
| `add_from_favorites` | Add a favorite by index to a week (`index`, `workLocation?`, `back?`) |
| `sign_timesheet` | Sign a week on its own fresh login (`back?`) |
| `save_with_explanation` | Finish a save that needs a revision explanation |
| `get_leave_balances` | Show leave balances and recent activity |

### Using the MCP server

Ask in plain language. Each task below is a prompt and the tools it ends up calling.

- **See a week.** "Show my timesheet" calls `show_timesheet`. "Show last week" calls it with `back=1`. "Which weeks can I reach?" calls `list_weeks`.
- **Set hours.** "Put 8 hours on line 0 for the 14th" calls `set_hours`. "Fill Monday to Friday with 8 hours on line 0, comment 'on site' on Wednesday" calls `set_hours_bulk` with one change per day. Each call saves.
- **Add a code.** "Add PTO" resolves the `pto` shortcut and calls `add_project`. "Add PROJ.M.400 as RHB, work location 20190, and save it to my favorites" calls `add_project` with `payType`, `workLocation` and `favorite`. A multi-charge code needs its pay type.
- **Pick from favorites.** "What are my favorites?" calls `list_favorites`. "Add the second one to this week" calls `add_from_favorites` with `index=1`.
- **Fix a processed past week.** "Change line 0 on the 5th to 4 hours last week" calls `set_hours` with `back=1`. Costpoint reopens the week and asks for a revision explanation, so the call returns a result starting with `NOT SAVED: revision explanation required.` that lists the changes. Give the reason ("late correction") and the assistant calls `save_with_explanation`. The week is Open again, so then "sign last week" calls `sign_timesheet` with `back=1`.
- **Sign.** "Sign my timesheet" calls `sign_timesheet`. "Sign last week" calls it with `back=1`.
- **Leave.** "How much PTO do I have?" calls `get_leave_balances`.

### Result markers

Every tool returns one text block. Success is plain text. Any other outcome starts with a fixed marker, so a client that only reads the text can tell them apart:

| Marker | Meaning | `isError` |
|--------|---------|-----------|
| `ERROR:` | The call failed (bad arguments, Costpoint refusal, lost session) | true |
| `NOT SAVED: revision explanation required.` | The edit is held; call `save_with_explanation` | true |
| `WARNING:` | Saved, but a side step failed (adding to favorites) | not set |

### Limits

- One Costpoint session at a time, tied to one week. A call for another week opens a new session.
- A pending revision explanation lives on that session. Another week's call is refused until `save_with_explanation` runs, and a release of the session (5 minutes idle, or a failed edit or `save_with_explanation`) drops it. The edit then has to be redone.
- `sign_timesheet` always logs in again, because Costpoint ignores a sign on a session that has already edited.
- About 20 weeks back, the weeks Costpoint loads.
- Direct mode only. The MCP server always uses the direct protocol.

### Prerequisites

- Node.js 22.12 or later, and `npm install` in this repo (there is no build step).
- Credentials: run `te login` once, or pass `COSTPOINT_URL`, `COSTPOINT_USERNAME` and `COSTPOINT_PASSWORD` (all three, see [Credentials](#credentials)). The server always uses direct mode, so `COSTPOINT_DIRECT` is not needed.
- Optional: `COSTPOINT_TRACE` (see [Servlet trace](#servlet-trace)), `COSTPOINT_TIMEOUT_MS` (see [Request timeout](#request-timeout)) and, for the mock only, `TECLI_MOCK=1` (see [Testing against the mock](#testing-against-the-mock)).

`mcp-server.js` loads a `.env` from its working directory, which is the client's, not this repo's. A `.env` there can set `COSTPOINT_URL` and the credentials, so start the client from a directory you trust, and pass variables through the client config instead. The server does not load this repo's `.env` on purpose: that file holds the production settings, and loading it would put them under every mock run.

### Installing in Claude Code

```bash
claude mcp add tecli -- node /path/to/tecli/mcp-server.js
```

Replace `/path/to/tecli` with the actual path to this repo. For example:

```bash
claude mcp add tecli -- node ~/dev/tecli/mcp-server.js
```

`-s user` makes it available in every project. Environment variables go in with `-e`:

```bash
claude mcp add tecli -e COSTPOINT_TRACE=1 -- node /path/to/tecli/mcp-server.js
```

To share it in a project instead, add a `.mcp.json` at that project's root:

```json
{
  "mcpServers": {
    "tecli": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/tecli/mcp-server.js"],
      "env": {}
    }
  }
}
```

To verify it was added:

```bash
claude mcp list
```

Then check it with a read-only call. Ask Claude Code "Show my timesheet" (it calls `show_timesheet`) or "Which weeks can I reach?" (`list_weeks`). The tools are named `mcp__tecli__show_timesheet` and so on.

### Installing through code-mode-mcp

code-mode-mcp (`@utcp/code-mode-mcp`, command `mcp-bridge`) is one MCP server that runs scripts calling other tools. tecli is registered in its UTCP config, not in Claude Code.

1. Install it: `npm install -g @utcp/code-mode-mcp`.
2. Add tecli to the UTCP config file's `manual_call_templates`:

   ```json
   {
     "manual_call_templates": [
       {
         "name": "tecli",
         "call_template_type": "mcp",
         "config": {
           "mcpServers": {
             "tecli": {
               "command": "node",
               "args": ["/path/to/tecli/mcp-server.js"],
               "transport": "stdio"
             }
           }
         }
       }
     ]
   }
   ```

   Environment variables for tecli go in an `env` object next to `args`, for example `"env": { "COSTPOINT_TRACE": "1" }`.
3. Register code-mode-mcp in Claude Code and point it at that file:

   ```bash
   claude mcp add -s user code-mode-mcp -e UTCP_CONFIG_FILE=/path/to/utcp-config.json -- mcp-bridge
   ```

   Without `UTCP_CONFIG_FILE`, code-mode-mcp reads `.utcp_config.json` from its working directory.
4. Check it with a read-only script through code-mode's `call_tool_chain`:

   ```js
   return tecli.tecli_show_timesheet({});
   ```

   The result is a string starting with `Current week (`. code-mode's `list_tools` should list `tecli.tecli_show_timesheet` and the other tools. The script rules are in [Using tecli via code-mode](#using-tecli-via-code-mode).

### Installing in Claude Desktop

Add to your Claude Desktop config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "tecli": {
      "command": "node",
      "args": ["/path/to/tecli/mcp-server.js"]
    }
  }
}
```

### Installing in other MCP clients

The server uses stdio transport. Point your client at:

```
node /path/to/tecli/mcp-server.js
```

### Using tecli via code-mode

[code-mode-mcp](https://github.com/universal-tool-calling-protocol/utcp-mcp) (`@utcp/code-mode-mcp`) runs agent-written JavaScript that calls tools as `tecli.tecli_<tool>({...})`. Register tecli in its UTCP config as an `mcp` manual with the same `node /path/to/tecli/mcp-server.js` stdio command. Rules for the scripts:

- Calls return the result string: `return tecli.tecli_show_timesheet({})`. Chain calls with plain `var` assignments. `await` is accepted but not needed (`@utcp/code-mode` 1.2.13 awaits the script's return value; 1.2.11 returned `{}` for a Promise). Each tool description repeats this rule, since code-mode does not show the server instructions.
- Plain JavaScript only. TypeScript annotations (`const n: number`) do not compile, even though the code-mode tool description says TypeScript.
- code-mode drops `isError`, so check the leading marker (above) of each result, for example `if (r.indexOf('NOT SAVED:') === 0) ...`.
- A script error still reports `success: true`. Look for `[ERROR]` in the returned `logs`.

Examples:

```js
// Last week's grid
return tecli.tecli_show_timesheet({ back: 1 });
```

```js
// Fill the current week, then check it
var r = tecli.tecli_set_hours_bulk({ changes: [
  { line: 0, day: 13, hours: 8 }, { line: 0, day: 14, hours: 8 },
  { line: 0, day: 15, hours: 8, comment: 'on site' },
] });
if (r.indexOf('ERROR:') === 0) return r;
return tecli.tecli_show_timesheet({});
```

```js
// Correct a processed past week and sign it again
var r = tecli.tecli_set_hours({ line: 0, day: 5, hours: 4, back: 1 });
if (r.indexOf('NOT SAVED:') === 0) r = tecli.tecli_save_with_explanation({ explanation: 'late correction' });
if (r.indexOf('ERROR:') === 0) return r;
return tecli.tecli_sign_timesheet({ back: 1 });
```

```js
// Add the first favorite to this week
var favs = tecli.tecli_list_favorites({});
console.log(favs);
return tecli.tecli_add_from_favorites({ index: 0 });
```

`console.log` output comes back in `logs`; the returned value is `result`.

Installed directly (Claude Code, Claude Desktop, other MCP clients) nothing changes: errors also carry `isError`.

### Credentials

The MCP server uses the same credential resolution as the CLI:

1. Environment variables (`COSTPOINT_URL`, `COSTPOINT_USERNAME`, `COSTPOINT_PASSWORD`), used only when all three are set
2. Stored credentials from `te login` (`~/.tecli.json` + OS keychain), not used when `TECLI_MOCK` is set (see [Testing against the mock](#testing-against-the-mock))

If you haven't run `te login` yet, do that first — the MCP server picks up stored credentials automatically.

## Servlet trace

Servlet tracing is off unless you turn it on. With `COSTPOINT_TRACE=1` (or `on`/`true`) every interface appends each Costpoint servlet request and response to `~/.tecli-trace.jsonl`. `COSTPOINT_TRACE=<file>` writes to that file instead. The file is owner-only (the bodies carry the session id) and moves to `<file>.1` once it reaches 10 MB. Login requests, including the SSO pages and the password exchange, are not traced.

```bash
COSTPOINT_TRACE=1 te show                      # appends to ~/.tecli-trace.jsonl
COSTPOINT_TRACE=/tmp/te-trace.jsonl te tui     # writes to that file
```

Empty, `0`, `off` and `false` mean off. For the MCP server, set it in the client config (`-e COSTPOINT_TRACE=1`, or the `env` object).

## Request timeout

Every Costpoint HTTP request in direct mode must finish within 60 seconds. `COSTPOINT_TIMEOUT_MS=<milliseconds>` changes the limit (a value that is not a positive number keeps 60 s). A request that runs out fails with "Costpoint request timed out after N s", and a response larger than 20 MB fails with "Costpoint response exceeded 20 MB". A timeout is not retried, because a save or sign that timed out may still have reached Costpoint: check the week before saving again. The web UI, TUI and MCP server drop their session after a timeout, so the next operation logs in fresh.

## Running tests

`npm test` runs the unit and mock tests offline. Tests against live Costpoint are opt-in: `RUN_E2E=1 npm test` runs them with your stored `te login` or the `COSTPOINT_*` variables. They are read-only but reach te.leidos.com. They still skip without credentials, with `TECLI_MOCK` set or with `SKIP_E2E=1`.

`npm run test:e2e` drives the web UI in headless Chromium against the mock (never real Costpoint). Run `npx playwright install chromium` once first.

## Testing against the mock

`npm run mock` starts a stateful Costpoint stand-in on port 4000 (`MOCK_PORT` to change it). It serves a seed scenario: the current week Open, last week Processed and correctable, the week before Signed, older weeks Processed, plus a charge catalog, favorites and leave balances. Point any interface at it:

```bash
export TECLI_MOCK=1 COSTPOINT_URL='http://localhost:4000/cpweb/cploginform.htm?system=MOCK' COSTPOINT_USERNAME=mock COSTPOINT_PASSWORD=mock COSTPOINT_DIRECT=true
node cli.js show --back 1
node cli.js sign -y
npx @modelcontextprotocol/inspector node mcp-server.js
```

To try the MCP tools against the mock from Claude Code, register a second server with the mock variables:

```bash
claude mcp add tecli-mock -e TECLI_MOCK=1 -e COSTPOINT_URL='http://localhost:4000/cpweb/cploginform.htm?system=MOCK' \
  -e COSTPOINT_USERNAME=mock -e COSTPOINT_PASSWORD=mock -- node /path/to/tecli/mcp-server.js
```

Set `TECLI_MOCK=1` for any mock run. With it set, `COSTPOINT_URL`, `COSTPOINT_USERNAME` and `COSTPOINT_PASSWORD` must all be in the environment (the stored `te login` credentials are never used) and the URL must be `localhost`, `127.0.0.1` or `::1`. Otherwise credential lookup throws and `mcp-server.js` refuses to start (stderr message, exit code 2). It refuses rather than warns because a mock run that reaches real Costpoint can edit or sign a real timesheet. Any value other than empty, `0` or `false` turns it on. The mock tests set it themselves.

State lives in memory, so restarting the mock resets it. `POST /__mock/reset` resets it in place, `POST /__mock/expire?sid=all` drops every login (to see the retry), `POST /__mock/fail-save?period=<n>` makes that week's next save fail once (optional `error=<text>`), `POST /__mock/stall?count=<n>` leaves the next n servlet requests unanswered (to see the timeout), and `GET /__mock/state` dumps it.

| Variable | Effect |
|----------|--------|
| `MOCK_TODAY` | Fix "today" (`YYYY-MM-DD`); weeks are computed from it |
| `MOCK_USER`, `MOCK_PASSWORD` | Require this login (any login works when unset) |
| `MOCK_SESSION_TTL_MS` | Expire idle logins |
| `MOCK_STATE_FILE` | Keep state across restarts |
| `MOCK_QUIRKS` | Comma list of live behaviors to reproduce |

Quirks: `sign-poison` (a sign on a worked session is silently ignored), `auto-required` (a past-week fetch returns the current week unless the `R=AUTO` fetch ran first) and `favorites-primer` (favorites need the categories lookup first) are on by default. `correct-stale` (the Correct response still shows the week closed) and `favsave-no204` (a save after add-to-favorites returns no row data) are opt-in.

## Disclaimer

This repository is not affiliated, associated, authorized, endorsed by, or in any way officially connected with Deltek, Inc.
