# Costpoint mock backend

CLAUDE.md pointed at `~/dev/deltek_ui/mock-backend`, which does not exist. Nothing could run end to end except against production. `mock/` is an in-repo replacement.

## What shipped
- `mock/server.js`: `node:http` server, `createMockServer({ port, fixture, quirks, today, user, password, sessionTtlMs, stateFile })`. CLI entry via `npm run mock`.
- `mock/codec.js`: response encoder (inverse of `protocol.decodeData`, never compressed), request parser, PUT row decoder, W clause parser.
- `mock/state.js`: `Db` (persistent periods, favorites) and `Session` (per-login buffers committed on 206).
- `mock/handlers.js`: command dispatch.
- `mock/fixture.json`: anonymised, built from captures. `test/fixtures/small.json` is the hand-written seed it extends.
- `mock/build-fixture.js`, `mock/anonymize.js`, `mock/deny.json`: local build and leak scan. Real terms are stored as SHA-256 hashes only.

## Why an HTTP server
The clients (CLI, web, TUI, MCP) all go through `DirectClient`'s HTTP code. A fake at that layer would skip the login chain, cookies, sid handling and the wire format. The server exercises all of them.

## Behaviors reproduced
- Sign only takes effect on a fresh session (`sign-poison`). A worked session round-trips as success and the week stays open.
- X=1 child fetch returns the active week unless `R=AUTO` ran first (`auto-required`).
- Favorites need the categories primer before the favorites lookup (`favorites-primer`).
- Correct response that still shows the week closed (`correct-stale`, opt-in).
- Save after add-to-favorites with no row data (`favsave-no204`, opt-in).
- `R=S&C` fetches return no frame, because `extract204` merges every 204 frame of a result set.
- A repeated `procUniqueId` gets an empty body.
- Expired or unknown sid: `onServletException` plus "Session not valid".

## Limits
The mock encodes what `direct.js` expects. Only the capture re-encode test checks it against the real protocol. A pass proves the clients agree with the mock, not with Costpoint. No leave capture exists, so leave data is synthetic.

## Not emulated
SSO and the AES password path, business validation (hour limits, approvals), K0 paging past 20 rows, compressed responses, Puppeteer mode.

## Found on the way
`DirectClient._cpLogin` ignores the password response, so a wrong login only surfaces at LOGININFO. The mock reproduces that.
