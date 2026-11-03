'use strict';

// HTML auto-submit forms on the SSO login path: the SAML POST-binding form and
// a gateway replay form that carries the original POST plus a submit button.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const DirectClient = require('../direct');

const client = Object.create(DirectClient.prototype);

const samlPage = `<html><body onload="document.forms[0].submit()">
<form method="post" action="https://cp.example.com/acs?a=1&amp;b=2">
<input type="hidden" value="PHNhbWw+" name="SAMLResponse"/>
<input type="hidden" name="RelayState" value="x&#x2F;y&quot;z"/>
<input type="hidden" name="noValue"/>
<input type="submit" name="go" value="Continue"/>
</form></body></html>`;

const replayPage = `<html><body>
<form action="https://gw.example.com/postredirect.php">
<input type="hidden" name="user" value="a b"/>
<input type="submit" name="go" value="Continue"/>
</form></body></html>`;

describe('_parseSAMLForm', () => {
  test('decodes the action and posts every named input with a value', () => {
    assert.deepEqual(client._parseSAMLForm(samlPage), {
      action: 'https://cp.example.com/acs?a=1&b=2',
      body: 'SAMLResponse=PHNhbWw%2B&RelayState=x%2Fy%22z&go=Continue',
    });
  });

  test('ignores a form without a SAMLResponse input', () => {
    assert.equal(client._parseSAMLForm(replayPage), null);
  });

  test('returns null without a form action', () => {
    assert.equal(client._parseSAMLForm('<input name="SAMLResponse" value="x">'), null);
  });

  test('returns null when no input has both a name and a value', () => {
    assert.equal(client._parseSAMLForm('<form action="/a"><input name="SAMLResponse"></form>'), null);
  });
});

describe('_parseForm', () => {
  test('skipSubmit leaves submit buttons out', () => {
    assert.deepEqual(client._parseForm(samlPage, { skipSubmit: true }), {
      action: 'https://cp.example.com/acs?a=1&b=2',
      body: 'SAMLResponse=PHNhbWw%2B&RelayState=x%2Fy%22z',
    });
  });

  test('reads any form, SAML or not', () => {
    assert.deepEqual(client._parseForm(replayPage, { skipSubmit: true }), {
      action: 'https://gw.example.com/postredirect.php',
      body: 'user=a%20b',
    });
    assert.deepEqual(client._parseForm(replayPage), {
      action: 'https://gw.example.com/postredirect.php',
      body: 'user=a%20b&go=Continue',
    });
  });

  test('returns null when only a submit button carries a value', () => {
    assert.equal(
      client._parseForm('<form action="/a"><input type="submit" name="go" value="x"></form>', { skipSubmit: true }),
      null
    );
  });
});
