# Past-week edits: outcome (epic tecli-0pa)

## What shipped
- `direct.js`: `add()`, `getFavorites()` and `addFromFavorite()` work on any selected period and correct a closed week first. The add builders take the period from `periodIdx`. `getPeriods()` lists the loaded K0 rows.
- CLI: `-b, --back <n>` on `show`, `set`, `setm`, `sign`, `add`, `favorites`. `--prev` is `--back 1`.
- Web UI: weeks are identified by period number. Sliding two-week window (`?offset=k`, `week-window.js`), per-period APIs, newest-first multi-week save, target-week choice in Add Project and Favorites.
- TUI: `viewPeriod`, `<` and `>` to step, `[w]` toggles to the last past week, `[a]` and `[f]` on any week (`tui-nav.js`).
- Tests: add and favorites batches for period 1 against `captured/past-week-add`, period fetch for X=2 and X=3 against captures 024 and 025, closed-week add corrects first, period-0 add structural guard, `getPeriods()`, window math, TUI nav, CLI `--back`.
- Docs: `CLAUDE.md`, `docs/binary-protocol.md` (period table rows, Favorites, typed code, fetch bounds, reach), `README.md`.

## Caps
- About 20 weeks back. The init fetch loads K0 rows 0-20 and `getPeriods()` reports only those. The browser pages K0 further (`S20 E40 K0 C19`), the client does not.
- The Puppeteer client stays active-week only. (The MCP tools gained `back`, see `mcp-parity.md`.)

## Capture vs `_buildPeriodFetch`
- Browser arrow fetch: K1 pair only, `S0 E45` and `S-59999 E-59954`. No K0 fetch.
- Ours: K0 fetch, then K1 `E40` and partner `E-59959`.
- Left unchanged. The current fetch is verified live. Only matters for weeks with more than 40 lines. Pinned by a test.
- The browser also uses `E45` and `E-59954` in the K1 refreshes after add, validate and lookup-OK. Our refreshes compute their bounds from row counts. The tests drop S/E bounds, so they do not pin this.

## Unverified live
- First add on a Signed past week (capture was unsaved).
- Typed-code path: the browser sends RAUTO on `TC_UDT02_CHARGE_LKP`, K1 PUT, 208. `add()` always runs the OPEN_RS K2 resolve flow instead.
- K1 refresh cursor after add: the test pins C0 in some refreshes where the capture shows C-59999 for the pending row.
- K0 paging beyond 20 weeks.
- RevisionRequired handling in the web UI add path (add on a corrected week, then save needs an explanation).
- Weekly-period assumption: week start math (`periodWeekKey`, `_buildDates`) assumes 7-day periods. Semi-monthly or biweekly calendars would break it.
- Multi-charge code add on a past week (capture used a plain code).

## First real use
`te add --back N`, or a TUI/web favorite on that week, then save with the explanation, sign, and check `te show --back N` against the browser.
