#!/usr/bin/env node
'use strict';

// stateToken extraction for the Okta SSO page. The pages below are trimmed
// copies of the live ones (2026-10-21): the Sign-In page carries the token as
// JSON, the desktop-SSO interstitial (/sso/idps/DSSO) as a JS variable.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const DirectClient = require('../direct');

const SSO_ORIGIN = 'https://auth.example.com';
const DSSO_URL = SSO_ORIGIN + '/sso/idps/DSSO';

const signInPage = token => `<html><head><title>Sign In</title></head><body>
<script>var okta = {"stateToken":"${token}","relayState":"\\x2Fapp"};</script>
</body></html>`;

const dssoPage = token => `<html><body>
<h1 id="okta-auth-heading">One moment please...</h1>
<script>
  var preCheckPath = '\\x2Fapi\\x2Finternal\\x2Fv1\\x2FagentlessDssoPrecheck';
  var stateToken = "${token}";
  var inIdxPipeline = false;
    inIdxPipeline = true;
  preCheckDsso(false, preCheckPath, 5000, "", false, false, 15000, true, false, "", false, true, "", stateToken, true, inIdxPipeline, false);
</script></body></html>`;

function stubClient(pages) {
  const client = Object.create(DirectClient.prototype);
  client.requests = [];
  client._httpRaw = async (method, url) => {
    client.requests.push({ method, url });
    const body = pages[new URL(url).pathname];
    if (body === undefined) throw new Error('unexpected request ' + url);
    return { status: 200, headers: {}, body };
  };
  return client;
}

describe('_ssoStateToken', () => {
  test('reads the JSON stateToken from the Sign-In page', async () => {
    const client = stubClient({});
    const token = await client._ssoStateToken(signInPage('02.id.abc\\x2Ddef'), DSSO_URL);
    assert.equal(token, '02.id.abc-def');
    assert.equal(client.requests.length, 0);
  });

  test('follows the desktop-SSO precheck failure to the Sign-In page', async () => {
    const client = stubClient({ '/login/agentlessDsso/idx': signInPage('02.id.idx') });
    const token = await client._ssoStateToken(dssoPage('dsso\\x2Dtoken'), DSSO_URL);
    assert.equal(token, '02.id.idx');
    assert.equal(client.requests.length, 1);
    const req = new URL(client.requests[0].url);
    assert.equal(client.requests[0].method, 'GET');
    assert.equal(req.origin, SSO_ORIGIN);
    assert.equal(req.pathname, '/login/agentlessDsso/idx');
    assert.equal(req.searchParams.get('stateToken'), 'dsso-token');
    assert.equal(req.searchParams.get('precheckFailure'), 'true');
    assert.equal(req.searchParams.get('redirectFromAdsso'), 'true');
  });

  test('fails when the fallback page has no stateToken', async () => {
    const client = stubClient({ '/login/agentlessDsso/idx': '<html></html>' });
    await assert.rejects(client._ssoStateToken(dssoPage('t'), DSSO_URL), /Could not extract stateToken/);
  });

  test('fails when the page has no stateToken', async () => {
    const client = stubClient({});
    await assert.rejects(
      client._ssoStateToken('<html></html>', DSSO_URL),
      /Could not extract stateToken from SSO page/
    );
  });
});

// The login error reaches the web UI's /api/status, so it carries a short
// text excerpt of the response, not the whole page (tecli-4mz.13 L5).
describe('_cpLogin password failure', () => {
  function loginClient(errorBody) {
    const client = Object.create(DirectClient.prototype);
    client._encodePassword = () => 'hashed';
    client._http = async (method, path, body) => {
      if (body.startsWith('USER=')) return { body: 'copyAuthData{"userId":"u","nonce":"n"}' };
      if (body.startsWith('PASSWORD=')) return { body: errorBody };
      return { body: '' };
    };
    return client;
  }

  test('reports a short text excerpt of the response', async () => {
    const page =
      '<html><script>var sid="SECRETSID";</script><body><b>Login error:</b>   bad password</body></html>' +
      'x'.repeat(5000);
    const err = await loginClient(page)
      ._cpLogin('user', 'pw')
      .then(
        () => null,
        e => e
      );
    assert.ok(err, 'login should fail');
    assert.match(err.message, /^Costpoint password login failed: Login error: bad password/);
    assert.doesNotMatch(err.message, /<|SECRETSID/);
    assert.ok(err.message.length <= 250, 'length ' + err.message.length);
  });
});
