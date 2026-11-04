'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { writePrivateFile } = require('./private-file');

const SERVICE = 'tecli';
const CONFIG_PATH = path.join(os.homedir(), '.tecli.json');
const CRED_PATH = path.join(os.homedir(), '.tecli-credentials');
const DEFAULT_URL = 'https://te.leidos.com/cpweb/cploginform.htm?system=LEIDOS';

// ─── Config file (non-secret settings) ──────────────────────────

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(config) {
  writePrivateFile(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

function deleteConfig() {
  try {
    fs.unlinkSync(CONFIG_PATH);
  } catch {
    /* ignore */
  }
}

// ─── Keychain backends ──────────────────────────────────────────

const platform = os.platform();

function keychainGet(account) {
  if (platform === 'darwin') return _macGet(account);
  if (platform === 'linux') return _linuxGet(account);
  if (platform === 'win32') return _winGet(account);
  return _fallbackGet(account);
}

function keychainSet(account, password) {
  if (platform === 'darwin') return _macSet(account, password);
  if (platform === 'linux') return _linuxSet(account, password);
  if (platform === 'win32') return _winSet(account, password);
  return _fallbackSet(account, password);
}

function keychainDelete(account) {
  if (platform === 'darwin') return _macDelete(account);
  if (platform === 'linux') return _linuxDelete(account);
  if (platform === 'win32') return _winDelete();
  return _fallbackDelete();
}

// ── macOS: security command ─────────────────────────────────────

function _macGet(account) {
  try {
    return execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function _macSet(account, password) {
  // Delete first — add-generic-password fails if entry already exists
  _macDelete(account);
  execFileSync('security', ['add-generic-password', '-s', SERVICE, '-a', account, '-w', password], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function _macDelete(account) {
  try {
    execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', account], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    /* may not exist */
  }
}

// ── Linux: secret-tool (libsecret) ─────────────────────────────

function _linuxGet(account) {
  try {
    return execFileSync('secret-tool', ['lookup', 'service', SERVICE, 'username', account], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return _fallbackGet(account);
  }
}

function _linuxSet(account, password) {
  try {
    execFileSync('secret-tool', ['store', '--label=Time Entry CLI', 'service', SERVICE, 'username', account], {
      input: password,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    // secret-tool not available — fall back to encrypted file
    _fallbackSet(account, password);
  }
}

function _linuxDelete(account) {
  try {
    execFileSync('secret-tool', ['clear', 'service', SERVICE, 'username', account], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    /* ignore */
  }
  _fallbackDelete(); // clean up any fallback file too
}

function _writeCredentialFile(data) {
  writePrivateFile(CRED_PATH, JSON.stringify(data, null, 2) + '\n');
}

// ── Windows: DPAPI via PowerShell ────────────────────────────────
// ConvertTo/From-SecureString uses Windows Data Protection API,
// which ties encryption to the current user + machine — similar
// security model to macOS Keychain.  Encrypted blob is stored in
// ~/.tecli-credentials alongside the account name.

function _winGet(account) {
  try {
    const data = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
    if (data.account !== account || !data.dpapi) return null;
    return (
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          // The blob comes from a file, so it goes in on stdin: spliced into
          // the command, a quote in it would run as PowerShell.
          '$blob = ($input | Out-String).Trim(); ' +
            '$secure = ConvertTo-SecureString $blob; ' +
            '$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); ' +
            '[Runtime.InteropServices.Marshal]::PtrToStringAuto($ptr)',
        ],
        { input: data.dpapi, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim() || null
    );
  } catch {
    return null;
  }
}

function _winSet(account, password) {
  try {
    const encrypted = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        '$pw = ($input | Out-String).TrimEnd(); ' +
          '$secure = ConvertTo-SecureString $pw -AsPlainText -Force; ' +
          'ConvertFrom-SecureString $secure',
      ],
      { input: password, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    _writeCredentialFile({ account, dpapi: encrypted });
  } catch {
    // PowerShell unavailable — fall back to AES
    _fallbackSet(account, password);
  }
}

function _winDelete() {
  try {
    fs.unlinkSync(CRED_PATH);
  } catch {
    /* ignore */
  }
}

// ── Fallback: AES-256-GCM encrypted file ────────────────────────
// For Windows or Linux without secret-tool.  File is chmod 600.
// Key is derived from the hostname and username, which anyone who can
// read the file can learn: obfuscation that keeps the password out of
// plaintext, not protection.

function _deriveKey() {
  const material = `${SERVICE}:${os.hostname()}:${os.userInfo().username}`;
  return crypto.scryptSync(material, 'tecli-v1', 32);
}

function _fallbackGet(account) {
  try {
    const data = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
    if (data.account !== account) return null;
    const key = _deriveKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(data.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(data.tag, 'hex'));
    let decrypted = decipher.update(data.encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return null;
  }
}

function _fallbackSet(account, password) {
  const key = _deriveKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(password, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  _writeCredentialFile({ account, iv: iv.toString('hex'), encrypted, tag });
}

function _fallbackDelete() {
  try {
    fs.unlinkSync(CRED_PATH);
  } catch {
    /* ignore */
  }
}

// ─── Interactive prompts ────────────────────────────────────────

function prompt(text) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => {
    rl.question(text, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Reads a password without echo. Raw mode hands over whole pasted chunks, so
// each chunk is scanned character by character. Ctrl+C rejects; the caller
// decides whether to exit.
function promptSecret(text, stdin = process.stdin) {
  process.stderr.write(text);
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY) {
      // Non-interactive — read a line from stdin
      const rl = readline.createInterface({ input: stdin });
      rl.once('line', line => {
        rl.close();
        resolve(line.trim());
      });
      return;
    }

    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let input = '';
    const finish = () => {
      stdin.setRawMode(wasRaw || false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stderr.write('\n');
    };
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          finish();
          return resolve(input);
        } else if (ch === '\u0003') {
          finish();
          return reject(new Error('Password prompt cancelled'));
        } else if (ch === '\u007f' || ch === '\b') {
          input = input.slice(0, -1);
        } else {
          input += ch;
        }
      }
    };
    stdin.on('data', onData);
  });
}

// ─── Public API ─────────────────────────────────────────────────

// ─── Mock-run guard ─────────────────────────────────────────────

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

// TECLI_MOCK marks a run that must only reach a local mock. Any value other
// than empty, 0 or false turns it on, so a typo errs toward protection.
function isMockRun() {
  const v = (process.env.TECLI_MOCK || '').trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false';
}

function isLocalUrl(url) {
  try {
    return LOCAL_HOSTS.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Throws when a mock run would reach anything but a local host. Refusing
 * beats warning: a mock run that edits or signs a real timesheet is worse
 * than a failed start.
 */
function assertMockSafe(creds) {
  if (!isMockRun() || !creds || isLocalUrl(creds.url)) return;
  throw new Error(
    `TECLI_MOCK is set but the Costpoint URL is not local (${creds.url}). Point COSTPOINT_URL at the mock (localhost) or unset TECLI_MOCK.`
  );
}

/**
 * Get stored credentials.  Priority:
 *   1. Environment variables (COSTPOINT_URL, COSTPOINT_USERNAME, COSTPOINT_PASSWORD)
 *   2. Config file (~/.tecli.json) + OS keychain, skipped when TECLI_MOCK is
 *      set: the stored login is the real one
 * Returns { url, username, password, system, useDirect } or null. Throws
 * when TECLI_MOCK is set and the URL is not local (assertMockSafe).
 */
function getCredentials() {
  // 1. Env vars (preserves .env / CI compatibility)
  const envUrl = process.env.COSTPOINT_URL;
  const envUser = process.env.COSTPOINT_USERNAME;
  const envPass = process.env.COSTPOINT_PASSWORD;

  if (envUrl && envUser && envPass) {
    const creds = {
      url: envUrl,
      username: envUser,
      password: envPass,
      system: process.env.COSTPOINT_SYSTEM || '',
      useDirect: process.env.COSTPOINT_DIRECT === 'true',
    };
    assertMockSafe(creds);
    return creds;
  }

  if (isMockRun()) {
    throw new Error(
      'TECLI_MOCK is set but COSTPOINT_URL, COSTPOINT_USERNAME and COSTPOINT_PASSWORD are not all set. The stored login is not used in a mock run.'
    );
  }

  // 2. Config + keychain
  const config = readConfig();
  if (config.url && config.username) {
    const password = keychainGet(config.username);
    if (password) {
      return {
        url: config.url,
        username: config.username,
        password,
        system: config.system || '',
        useDirect: config.direct !== false, // default true
      };
    }
  }

  return null;
}

/**
 * Interactive login — prompts for credentials and stores them.
 * @param {object} [defaults] - pre-fill values (e.g. from env)
 */
async function login(defaults = {}) {
  const config = readConfig();

  const defaultUrl = defaults.url || config.url || DEFAULT_URL;
  const defaultUser = defaults.username || config.username || '';

  const username = (await prompt(`Username${defaultUser ? ` [${defaultUser}]` : ''}: `)) || defaultUser;
  const password = await promptSecret('Password: ');
  const url = defaultUrl;

  if (!url || !username || !password) {
    throw new Error('URL, username, and password are all required.');
  }

  // Extract system from URL query string if present
  let system = '';
  try {
    system = new URL(url).searchParams.get('system') || '';
  } catch {
    /* ignore */
  }

  // Save
  keychainSet(username, password);
  writeConfig({ url, username, system, direct: true });

  return { url, username, password, system, useDirect: true };
}

/**
 * Remove stored credentials from keychain and config file.
 */
function logout() {
  const config = readConfig();
  if (config.username) {
    keychainDelete(config.username);
  }
  deleteConfig();
  _fallbackDelete();
}

module.exports = {
  getCredentials,
  assertMockSafe,
  isMockRun,
  login,
  logout,
  prompt,
  promptSecret,
  // Exported for tests only: the Windows path cannot run outside Windows.
  _winGet,
  _winSet,
};
