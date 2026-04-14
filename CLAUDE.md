# Costpoint

CLI + web UI + TUI for Costpoint timesheet management.

## Architecture

Three interfaces, two client modes:
- **CLI** (`cli.js`) — one-shot Commander commands, each invocation creates/destroys a session
- **Web UI** (`server.js`) — Express on port 3000, persistent session across HTTP requests
- **TUI** (`tui.js`) — interactive terminal UI, persistent session across operations

Two client modes (set via env vars):
- **DirectClient** (`direct.js`) — binary HTTP protocol to MasterServlet.cps. Use `COSTPOINT_DIRECT=true`.
- **Costpoint** (`costpoint.js`) — Puppeteer-based, legacy. Requires `COSTPOINT_SYSTEM`.

Key files:
- `direct.js` — DirectClient class, binary protocol, session management
- `protocol.js` — Encode/decode helpers for Costpoint binary protocol
- `costpoint.js` — Puppeteer-based client (legacy)
- `cli.js` — Commander CLI
- `server.js` — Express web UI (port 3000)
- `tui.js` — Interactive terminal UI (raw ANSI + readline, zero extra deps)
- `timesheet-status.js` — Status code normalization (A/M/O/P/R/S)
- `public/app.js` — Client-side vanilla JS
- `public/styles.css` — Dark theme ("Str8 Outta Deltek")

## Web UI

Single-page app with server-rendered HTML (no framework, no template engine). All HTML is constructed in `renderHTML()` inside `server.js`. Client-side state managed in `public/app.js`.

### Two-week timecard
- Merges two weekly periods into a 14-day view via `getMergedData()`
- Only the "active week" (from Costpoint's current cursor) is editable
- Other week is displayed read-only (grayed out)
- Per-week headers show date range, status badge, and Sign/Copy buttons when unsigned

### Session management
- `server.js` keeps a persistent `DirectClient` session (`activeClient`) across operations
- `getClient()` creates or reuses the session; `releaseClient()` tears it down
- 5-minute idle timeout auto-releases the session
- `withClient(fn)` wraps operations with auto-retry on session errors (re-login once)
- `fetchFreshData()` always releases + re-creates (wants fresh data); save/sign/add reuse

### Thursday workflow
- Per-week Sign buttons in the week header row (replaces old global "Sign Timesheet" button)
- "Copy Thu -> Fri" button copies Thursday hours to Friday for quick estimation
- Thursday/Friday nudge banner appears when the active week is unsigned

## TUI

Interactive terminal UI (`node tui.js` or `npm run tui`). Zero extra dependencies — uses raw ANSI escape codes, readline in raw mode, and chalk for colors. Runs in alternate screen buffer.

- Arrow keys navigate cells, digits start editing, Enter confirms + advances right
- `[s]ave`, `[S]ign`, `[r]efresh`, `[a]dd project`, `[c]opy Thu->Fri`, `[q]uit`
- Prompt mode for text input (sign confirmation, project code)
- Same persistent session pattern as web UI (`getClient`/`withClient`/`releaseClient`)
- Shares cache file (`~/.costpoint-cache.json`) with the web UI
- Shows single active week (7 columns) — fits in 80-col terminals

## Direct Protocol

See memory file `direct-protocol.md` for the full binary protocol reference.

### Key production gotchas
- CHARGE_ID (col 4) must be KEPT in PUT data after charge resolution — clearing it causes "Account required"
- PAY_TYPE (col 16) must NOT be manually set for multi-charge codes — causes "This Pay Type cannot be manually entered"
- `getPreviousPeriodData()` returns other week's data without mutating client state (no `navigateToPreviousPeriod()` state swap)

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

- Mock backend: `~/dev/deltek_ui/mock-backend/` on port 4000
- To test against mock: `COSTPOINT_URL="http://localhost:4000/..." COSTPOINT_DIRECT=true node cli.js ...`
