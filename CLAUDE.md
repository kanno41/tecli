# Costpoint

CLI + web UI + TUI for Costpoint timesheet management.

## Architecture

Four interfaces, two client modes:
- **CLI** (`cli.js`) — one-shot Commander commands, each invocation creates/destroys a session. `--prev` / `-b, --back <n>` select a past week (direct mode)
- **Web UI** (`server.js`) — Express on 127.0.0.1:3000, persistent session across HTTP requests. `web-guard.js` refuses a foreign Host or Origin and any `/api` request without the per-launch token (`<meta name="tecli-token">`, sent by `apiFetch()` in `public/app.js` as `X-Tecli-Token`). `/api/sign` needs an explicit `period`. Tests: `test/web-guard.test.js` (server.js against the mock)
- **TUI** (`tui.js`) — interactive terminal UI, persistent session across operations
- **MCP server** (`mcp-server.js`) — stdio tools for AI assistants, direct mode only. Every week tool takes `back` (0 = current). Session rules come from `session.js`; `sign_timesheet` always signs on its own fresh login; a pending revision explanation is tracked per week (`createRevisionHold()` from `session.js`, cleared when the session is released). Results are one text block; non-success text starts with a `MARKER` (`ERROR:`, `NOT SAVED: revision explanation required.`, `WARNING:`) because code-mode-mcp drops `isError`. `isError` stays set for direct clients. Every tool description ends with `CODE_MODE_RULE` (calls return the result string), because code-mode shows tool descriptions but not the server instructions. `server.createToolError` is overridden so thrown and schema errors get the marker. Code-mode rules: README "Using tecli via code-mode"; `test/mcp-code-mode.test.js` runs the server through the global `@utcp/code-mode-mcp` install and skips when it is absent

Two client modes (set via env vars):
- **DirectClient** (`direct.js`) — binary HTTP protocol to MasterServlet.cps. Use `COSTPOINT_DIRECT=true`.
- **Costpoint** (`costpoint.js`) — Puppeteer-based, legacy. Requires `COSTPOINT_SYSTEM`.

Key files:
- `direct.js` — DirectClient class, binary protocol, session management
- `protocol.js` — Encode/decode helpers for Costpoint binary protocol
- `costpoint.js` — Puppeteer-based client (legacy). `save()` reads the CMD 206 response and throws like DirectClient (`RevisionRequiredError` included, finished by `saveWithExplanation()`); `sign()` and login throw instead of exiting; `sign()` throws unless the week reads Signed afterwards. Active week only: `getPeriods()` lists one week, `getPreviousPeriodData()` is null, and past weeks, comments, favorites, `addToFavorites()`, leave balances, a non-REG pay type and a work location throw `Costpoint.NotSupportedError` ("... not supported in Puppeteer mode; set COSTPOINT_DIRECT=true"). `listFavorites()` and the CLI `favorites`, `leave` and bare `add` refuse before launching a browser. Tests: `test/costpoint-puppeteer.test.js` (stubbed page), `test/cli-puppeteer.test.js`
- `cli.js` — Commander CLI
- `server.js` — Express web UI (port 3000)
- `tui.js` — Interactive terminal UI (raw ANSI + readline, zero extra deps)
- `session.js` — Shared session logic for the web UI, TUI and MCP: `launchForPeriod()`, `isSessionError()`, `createSessionManager()`
- `week-label.js` — Week wording and the `back` reach check, shared by the CLI and MCP
- `mock/` — Stateful Costpoint mock (see Testing)
- `timesheet-status.js` — Status code normalization (A/M/O/P/R/S)
- `public/app.js` — Client-side vanilla JS
- `public/render.js` — HTML builders for the modals (audit, favorites, leave, errors) and `escapeHtml`, shared by the page (`window.TecliRender`), `server.js` (`esc()`) and tests
- `public/pending.js` — Page-side unsaved-edit keys (`cellKey(week, line, day)`) and `takeSaved()`, shared by the page (`window.TecliPending`) and tests
- `public/styles.css` — Dark theme ("Str8 Outta Deltek")

## Web UI

Single-page app with server-rendered HTML (no framework, no template engine). All HTML is constructed in `renderHTML()` inside `server.js`. Client-side state managed in `public/app.js`. Costpoint data and error text are escaped before they reach HTML: `esc()` in `renderHTML()`, `escapeHtml()` in every `innerHTML` built from data, and `<` written as `\u003c` in the inline `TIMESHEET_DATA` JSON. Tests: `test/web-escape.test.js`

### Sliding two-week window
- Weeks are identified by period number: the parent K0 row index (0 = active week, 1 = the week before, and so on). `week-window.js` holds the window math (testable without the server).
- Offset `k` (`?offset=k`) shows periods `k+1` (left) and `k` (right). k = 0 is the usual view. Nav bar: `‹ older`, `newer ›`, `Current`, bounded by `getPeriods()` (about 20 weeks, the K0 rows Costpoint loads).
- `getMergedData(offset)` merges the two weeks into a 14-day view from `cachedWeeks`. A week not yet cached loads on demand through `ensureWindowWeeks()` in a fresh period session.
- Both weeks are editable (`weeks[].isEditable`) unless the week is closed and Costpoint offers no Correct. Past-week edits need direct mode.
- Cells carry `data-week` (the period number) and `data-period-line` (the line index within that week). Cells for a line that only exists in the other week are read-only.
- `/api/hours`, `/api/comment`, `/api/sign`, `/api/project` and `/api/favorites` take a `period`.
- `saveAllChanges()` saves each period in `pendingChanges`, newest first, each on its own period session. A week that needs a revision explanation stops the run. `saveWithExplanation()` finishes that week (held in `revisionHold`, `createRevisionHold()` from `session.js`) and then saves the rest. `/api/save` and `/api/save-with-explanation` answer with `saved` (periods committed, also on a 500) and `failed` (the period that threw); the page clears only the saved weeks' cells, so a retry resends only the rest. Page pending edits are keyed by period + line + day. Tests: `test/web-save.test.js`
- Per-week headers show date range, status badge, and a Sign button on each editable unsigned week (Copy Thu -> Fri on the active week only). Add Project and Favorites modals pick a target week from the two visible ones.

### Session management
- Session logic lives in `session.js` (web UI, TUI and MCP share it): one `DirectClient` bound to one period, relaunched when the period changes, released after 5 idle minutes, one retry on a session error (`isSessionError`: `SessionExpiredError`, the servlet's `onServletException` page, or `ECONNRESET`/`ECONNREFUSED`; never message text), and only if the client sent no write (`writesSent` counts CMD 206/209/300 requests, so a save whose response was lost is not replayed). Tests: `test/session.test.js` `launchForPeriod(creds, period, { preloadPrevious, onLogin })` is the launch rule; `onLogin` runs between login and past-week selection, so the CLI reports "Authentication failed" or "Could not load <week>". The hooks (`onLaunch`, `onReuse`, `onRetry`, `onRelease`) carry the per-interface logging and redraw.
- Period rule: a past-week session is launched fresh and moved with `selectPeriod(n)` before anything else runs (launch → select → set → save), the same fresh-session rule as signing. `back` beyond `getPeriods().length - 1` fails with the shared message in `week-label.js`.
- `server.js`: `launchClient` preloads the previous week, `launchSignClient` does not. `fetchFreshData()` always releases + re-creates (wants fresh data); save/add reuse; sign launches its own fresh session for the week's period (`signTimesheet()`)

### Thursday workflow
- Per-week Sign buttons in the week header row (replaces old global "Sign Timesheet" button)
- "Copy Thu -> Fri" button copies Thursday hours to Friday for quick estimation
- Thursday/Friday nudge banner appears when the active week is unsigned
- A second banner with its own Sign button shows for any visible past week that is Open (e.g. after a correction)

## TUI

Interactive terminal UI (`node tui.js` or `npm run tui`). Zero extra dependencies — uses raw ANSI escape codes, readline in raw mode, and chalk for colors. Runs in alternate screen buffer.

- Arrow keys navigate cells, digits start editing, Enter confirms + advances right
- `[s]ave`, `[S]ign`, `[r]efresh`, `[a]dd project`, `[c]opy Thu->Fri`, `[w]eek`, `[q]uit`
- `<` goes one week older, `>` one week newer, bounded by `getPeriods()`. `[w]` toggles between the active week and the last past week viewed. The header shows "PREVIOUS WEEK" or "N WEEKS AGO" (`tui-nav.js`). Edits, `[s]ave`, `[S]ign`, `[a]dd` and favorites target the displayed week. Only `[c]opy` is active-week only. Switching weeks is blocked while there are unsaved changes. A past-week save that leaves the week Open says to press `[S]`.
- Prompt mode for text input (sign confirmation, project code)
- Numbered lists (favorites `[f]`, add menu `[a]`) take multi-digit picks via `number-pick.js`: a digit selects once no longer number can match, otherwise Enter confirms (with 13 favorites, `1` waits, `13` or `1`+Enter picks)
- Same period-bound session pattern as web UI (`getClient(period)`/`withClient(fn, period)`/`releaseClient`)
- Typing a custom project code (add menu `[0]`/`[c]`) asks "Also add to favorites? [y/N]" after the pay type
- Shares cache file (`~/.costpoint-cache.json`) with the web UI. At start the cached active week is moved up to the week holding today (`currentWeekStart()` in `tui-nav.js`), so a cache from an earlier week is shown as a past week. Until a fetch works the header shows `[CACHED]` and a failed fetch's error stays in the status line
- Shows one week at a time (7 columns) — fits in 80-col terminals
- Tests: `test/tui-pty.test.js` runs tui.js on a pty through util-linux script(1) against the mock (week keys, the unsaved-edit guard, multi-digit favorites picks, add prompts, past-week sign). Part of `npm test`; skips where script(1) is missing

## Direct Protocol

See memory file `direct-protocol.md` for the full binary protocol reference.

### Key production gotchas
- CHARGE_ID (col 4) must be KEPT in PUT data after charge resolution — clearing it causes "Account required"
- PAY_TYPE (col 16) must NOT be manually set for multi-charge codes — causes "This Pay Type cannot be manually entered"
- Signing MUST run on a fresh session (launch → sign, nothing between). On a session that has done the init/edit/save flow, the server silently ignores the sign — all commands return success but the timesheet stays Open. Verified 2026-07-31: the browser-exact sign flow fails on a worked-in TUI session and succeeds on a fresh one. All three interfaces now sign on a fresh session (`signTimesheet()` in server.js, `doSign()` in tui.js, CLI is fresh by nature). The rule holds per period: a past week signs on launch → `selectPeriod(1)` → sign.
- The sign-bisect (tecli-a1t.1, `captured/sign-bisect.js`, git-ignored logs under `captured/`) ruled out both `_buildSaveBatch` suspects: parent editFlag 65562 vs the browser's 18, and PUT of all K1 rows vs the browser's dirty-only rows. One no-op save then sign on the same session signed the week both times: 2026-10-27 `--back 1` (editFlag 18, all rows) and 2026-10-29 `--back 0` (editFlag 65562, all rows). `_buildSaveBatch` stays as is. Remaining suspects for the 2026-07-31 poison: the TUI/web flow, favorites (the `getFavorites()` pending line), a second save in the same session. The mock's `sign-poison` quirk ignores sign on any worked session, which is broader than anything seen live. On an already-signed timesheet CMD 300 fails loudly ("You do not have rights to execute this process"); the poison instead makes the whole flow round-trip as success.
- `sign()` mirrors the browser byte-for-byte (see `captured/sign-capture/` requests 017+018, previous week `captured/prev-period-sign/` 014+015): CMD 300 `TMMTS_SIGN_TIMESHEET` action event, then ACTION_CD='S' + CMD 206 save. ACTION_CD is parent col 23 (not 667). The active-week sign-confirm save returns no 204 data, so `sign()` does an explicit re-fetch afterward and THROWS if status didn't become 'S' — sign can no longer fail silently. It signs the selected period and refuses up front when `ENABLE_SIGN_FL` is N (already signed).
- The browser's Sign button shows a `confirm()` certification before any request. Playwright auto-dismisses dialogs, so `captured/capture-traffic.js` accepts and logs them (`dialogs.txt`).
- Parent (K0) column indices are resolved by name from the OPEN_RS `maObjId` list at launch (`resolveParentColumns()` in direct.js). Costpoint shifted them 2026-10 (688 -> 692 columns: ENABLE_SIGN_FL 573 -> 575, TS_CLOSED_FL 685 -> 689), which made Processed weeks look open. Child (K1) columns are resolved the same way (`resolveChildColumns()`, names from the K1 OPEN_RS in the init parent batch): the same update inserted `REVERSED_FROM_LN_NO` at 244 (402 -> 403 columns), which moved the pay type and project code `add()` copies from the charge lookup.
- `getFavorites()` never runs Correct. It leaves its pending line (`K1 C-59999`, no charge) on the session: live Costpoint refuses the CMD 209 delete of an uncharged line ("One or more charge lines were invalid ...", tecli-4c4), so list on a session you then drop. `getFavorites({ keepLine: true })` keeps the line and corrects a closed week, for an `add()` that follows (`addFromFavorite()`, CLI `te add` pick, MCP `add_from_favorites`, TUI `[f]` pick, web favorites Add: `/api/project` with `favoriteIndex`, an index into `/api/favorites`, in place of `code`). `addFromFavorite(index, { payType, workLocation })` passes a blank favorite pay type to `add()` as undefined, not REG (tecli-a1t.12). The web UI, TUI and MCP list favorites through `listFavorites(creds)` in `session.js`, on a throwaway active-week session, never on the edit session (tecli-4mz.2, tecli-4mz.3). A leftover pending line has no charge and fails the next save with "Account required".
- Every HTTP request (`_send()`) has a deadline, `COSTPOINT_TIMEOUT_MS` (default 60 s), and a 20 MB response cap. `RequestTimeoutError` is deliberately not a session error (`isSessionError`): a timed-out save or sign may have landed, so `withClient` releases the session and rethrows instead of retrying. Tests: `test/http-limits.test.js`, `test/web-timeout.test.js`
- A save whose reply is not a response document (live: an HTML page after a committed save, tecli-dw7) throws `SaveOutcomeUnknownError` from `save()` / `saveWithExplanation()`, also when the re-fetch after a rowless save fails. Not a session error, never resent. The MCP edit tools then re-read the week on a fresh login and report Saved only if every edit shows, else `ERROR: Save outcome unknown ...`. Tests: `test/save-errors.test.js`, `test/mcp-server.test.js`
- `_refetchTimesheet()` (after a save reply with no rows, and after `sign()`) re-reads a past week through `_fetchPeriod()`: a plain X>0 read there returned the active week's lines live (tecli-lok).
- `getPreviousPeriodData()` returns the previous week's data without mutating client state. It needs `launch(..., { loadPreviousPeriod: true })`.
- `selectPeriod(idx)` points the client at another parent K0 row (1 = previous week). The period index goes in `X` on K1/K2 commands and in the K0 cursor `C` (205 K0, 206, 204 K0). `add()`, `getFavorites()` and `addFromFavorite()` work on any selected period and correct a closed one first. `getPeriods()` lists `[{ idx, endDate, statusCode, editable }]` for the loaded K0 rows only (about 20, K0 is not paged; `editable` is null for rows without detail columns). See `docs/binary-protocol.md` "Previous Period Edit".
- X=1 child fetches return the wrong lines unless the `R=AUTO` parent fetch ran first in the session (`_fetchPeriod()` does both). Verified live 2026-09-28.
- Editing a processed (closed, `TS_CLOSED_FL`=Y) week first runs the browser's Correct flow (`_correctTimesheet()`: CMD 300 TMMTS_CORRECT_TIMESHEET + 206). The week comes back Open and must be signed again (`te sign --prev` or `--back n`, the week's Sign button in the web UI, TUI `[S]`). If the save response still shows the week closed, `_correctTimesheet()` re-fetches the period before failing: one live correction committed while its response said closed.
- `addToFavorites()` sends CMD 300 `TMMTS_ADD_LINE_TO_FAVORITES` for the pending line (capture 024). Call it after `add()` and before `save()`. Callers treat a failure as a warning: the line add still succeeds. CLI: `te add <code> --favorite`, or a y/N prompt on a TTY (skipped for favorites picks). Web UI: "Also add to favorites" checkbox, `/api/project` takes `favorite: true`. Not verified live: the action on a saved row and the server's success message.
- Work location is K1 col 8 (`UDT03_ID`, a zip code), not col 17. The server fills a default during charge resolution. `add(code, payType, { workLocation })` overrides it with a PUT of col 8 + CMD 208 `UDT03_ID` (captured/work-location/); omitted means no extra requests. `workLocation` may be an async `(pendingLine) => zip` to prompt after defaults are known. Validation lives in `add-options.js`. CLI `--location/-l`, `--ask/-i`; web modal field and `/api/project` `workLocation`; TUI prompts after pay type, and `[e]` in the favorites list asks pay type + location for the next pick.

## Environment

- `.env` — Production config (te.leidos.com)
- `.env.local` — Mock config. NOT auto-loaded by `dotenv.config()`; must set env vars explicitly.

## Capturing Protocol Traffic

Use the Chrome DevTools MCP to capture network requests from the live Costpoint site (te.leidos.com). This is how we reverse-engineer new protocol flows.

1. Open the target page in Chrome with DevTools open
2. Use `list_network_requests` (filter `resourceTypes: ["xhr", "fetch"]`) to find MasterServlet.cps calls
3. Use `get_network_request` with `requestFilePath` / `responseFilePath` to save request/response bodies to `captured/`
4. Analyze the binary protocol data to understand the flow, then implement in `direct.js`

Captured traffic lives in `captured/` — named descriptively (e.g., `leave-balances-req-1.txt`).

## Testing

- `npm test` runs everything, including the mock, session and MCP tests.
- `npm run test:e2e` drives the web UI in headless Chromium (Playwright) against server.js and the mock: window slide, edits in both weeks, multi-period save, revision modal, partial-save failure, per-week Sign, Add modal work location and favorites. Through the web guard like a browser. `test/browser/*.spec.js`, not part of `npm test`. Needs the Playwright Chromium build (`npx playwright install chromium`).
- `npm run lint` runs ESLint (`eslint.config.js`); `npm run format` / `npm run format:check` run Prettier (`.prettierrc.json`) on git-tracked files only, so untracked scratch files never fail the check. Lint does not check formatting.
- Mock backend: `npm run mock` (`mock/`, port 4000, `MOCK_PORT`). Stateful: edits, Correct, revisions, sign, add, favorites and leave work end to end. Seed: P0 Open, P1 Processed and correctable, P2 Signed, P3+ Processed. State is in memory (`POST /__mock/reset`, `POST /__mock/expire?sid=all`, `GET /__mock/state`; `MOCK_STATE_FILE` keeps it). `POST /__mock/fail-save?period=n&error=...` (or `mock.failSave(n)`) fails that period's next save once. `POST /__mock/stall?count=n` (or `mock.stall(n)`) leaves the next n servlet requests unanswered. `mock.dropSave(n)` commits the next n saves and drops the connection instead of answering. `mock.htmlSave(n, { commit })` answers the next n saves with an HTML page, after committing them unless `commit: false`. `mock.rowlessSave(n)` commits the next n saves and answers with no row data. With `auto-required` a committed past-week save drops the session's AUTO load, so the next past-week read needs `R=AUTO` again (tecli-lok).
- Point a client at it: `TECLI_MOCK=1 COSTPOINT_URL='http://localhost:4000/cpweb/cploginform.htm?system=MOCK' COSTPOINT_USERNAME=mock COSTPOINT_PASSWORD=mock COSTPOINT_DIRECT=true node cli.js ...`
- Env: `MOCK_TODAY`, `MOCK_USER`/`MOCK_PASSWORD`, `MOCK_SESSION_TTL_MS`, `MOCK_STATE_FILE`, `MOCK_QUIRKS` (comma list: `sign-poison`, `auto-required`, `favorites-primer` on by default; `correct-stale`, `favsave-no204` opt-in). `test/mcp-server.test.js` runs once with the default quirks and once with each opt-in quirk.
- `TECLI_MOCK` (any value but empty/`0`/`false`, `isMockRun()` in `credentials.js`) guards mock runs: `getCredentials()` skips the `~/.tecli.json` + keychain fallback and throws unless the env URL is local (`assertMockSafe()`), and `mcp-server.js` refuses to start (exit 2). Refuse, not warn: a mock run reaching production is worse than a failed start. `test/mock-helper.js` sets it for every mock test; `test/mock-guard.test.js` covers it.
- Offline: tests that read gitignored `captured/` skip without it; live Costpoint tests (`test/e2e-favorites.test.js`, read-only) are opt-in: they run only with `RUN_E2E=1` and still skip without credentials, with `TECLI_MOCK` or `SKIP_E2E=1`. New live tests gate on `liveSkipReason()` in `test/e2e-helper.js`. Plain `npm test` never contacts Costpoint.
- The mock encodes what `direct.js` expects. Only `test/mock-codec.test.js` (re-encoding `captured/` responses) checks it against the real protocol, so a green mock run is not proof of live behavior.
- Not emulated: SSO, the AES password path, Costpoint business validation, K0 paging past 20 rows, compressed responses, Puppeteer mode.
- `mock/fixture.json` is built from local captures by `node mock/build-fixture.js` (anonymised, leak-scanned against `mock/deny.json`). `test/fixtures/small.json` is the hand-written scenario it starts from.
