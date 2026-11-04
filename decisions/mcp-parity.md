# MCP server parity

## Problems fixed
- `sign_timesheet` signed on the shared, worked-in session. Costpoint silently ignores that. It now releases the shared session and signs on a fresh login.
- The retry check missed `onServletException`, `not valid` and `ECONNRESET`. The MCP server now uses `isSessionError` from `session.js`.
- The tools were active-week only.

## What shipped
- `session.js`: `launchForPeriod`, `isSessionError`, `createSessionManager`. The web UI, TUI and MCP share it. Per-interface side effects go through hooks.
- `week-label.js`: week wording and the `back` reach check, shared by the CLI and MCP. `launchForPeriod` applies the check, so every interface fails with the same message.
- `mcp-server.js` exports `buildServer()`; stdio starts only when run directly.
- Tools: `list_weeks`, `list_favorites`, `add_from_favorites` are new. `show_timesheet`, `set_hours`, `set_hours_bulk`, `add_project`, `sign_timesheet` take `back` (0 = current). `add_project` gained `workLocation` and `favorite`.

## Decisions
- `back` counts weeks back (0 = current), matching the CLI. `list_weeks` maps it to dates and status.
- `list_favorites` takes no `back` and runs on a throwaway period-0 session. `getFavorites()` stages a pending line on the session's week and corrects a closed week first, so running it on the edit session could leave a stray row.
- A failed edit releases the edit session, so no half-done pending line carries into the next call. A revision-required result keeps it, because the edits wait there.
- Pending revision is tracked per week (`pendingRevisionBack`). A call for another week, or a sign, is refused until `save_with_explanation` runs. If the session was released, `save_with_explanation` says to redo the edit.
- After an edit on a past week that leaves it Open, the result says to call `sign_timesheet` with that `back`.

## Follow-ups
- The CLI `favorites --back` flag has the same pointless side effect as above (tecli-1y5).
- `_isSaveRevisionRequired` scans `rescds` one character at a time and ignores the `\x0B` separators (tecli-i0v).
- Not yet verified live: `sign_timesheet` through Claude Code on the next week that is ready, then `show_timesheet` shows Signed.
