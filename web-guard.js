'use strict';

// Request guard for the web UI. The server holds a live Costpoint login, so
// only its own page may drive it:
// - Host must name the loopback listener, which blocks DNS rebinding (a
//   foreign name resolving to 127.0.0.1 would otherwise read the page token)
// - Origin, when the browser sends one, must be that same listener
// - every /api request carries the per-launch token from the page in
//   TOKEN_HEADER. A custom header makes a cross-site fetch preflight, and the
//   server never answers CORS, so a foreign page can neither send it nor read
//   the token.

const crypto = require('crypto');

const HOST = '127.0.0.1';
const TOKEN_HEADER = 'x-tecli-token';

function createWebGuard(port) {
  const token = crypto.randomBytes(32).toString('hex');
  const hosts = new Set([`${HOST}:${port}`, `localhost:${port}`]);
  const origins = new Set([...hosts].map(h => `http://${h}`));
  const expected = Buffer.from(token);

  function tokenMatches(value) {
    const given = Buffer.from(String(value || ''));
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  function middleware(req, res, next) {
    if (!hosts.has(req.headers.host)) return res.status(403).json({ error: 'Forbidden host' });
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin)) return res.status(403).json({ error: 'Forbidden origin' });
    if (req.path.startsWith('/api/') && !tokenMatches(req.headers[TOKEN_HEADER])) {
      return res.status(403).json({ error: 'Missing or invalid request token' });
    }
    next();
  }

  return { token, middleware };
}

module.exports = { createWebGuard, HOST, TOKEN_HEADER };
