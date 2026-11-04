'use strict';

// Anonymisation for mock/build-fixture.js. Real captures name a real person,
// employee id, org codes and project codes; none of that may reach the
// committed fixture. The deny list is stored as hashes so the leak test can
// run without captured/.

const crypto = require('crypto');

const sha = s => crypto.createHash('sha256').update(s.toLowerCase()).digest('hex');
// Whole values count from 3 characters, pieces of a value from 5, so short
// fragments ("001", "300") of real codes do not collide with synthetic ones
const MIN_TOKEN = 3;
const MIN_PIECE = 5;
// Codes every Costpoint site has; they are not identifying
const GENERIC = /^ZLEAVE\./;
// Generic words that appear in synthetic data and must never become deny terms
const ALLOW = new Set([
  'mock',
  'proj',
  'zleave',
  'doe',
  'jane',
  'dummy',
  'account',
  'regular',
  'leave',
  'ind_lab',
  'xxx',
]);

function tokens(value) {
  const out = new Set();
  const s = String(value);
  if (s.length >= MIN_TOKEN) out.add(s);
  for (const t of s.split(/[^A-Za-z0-9_]+/)) {
    if (t.length >= MIN_PIECE) out.add(t);
  }
  return [...out];
}

function denyHashes(terms) {
  const set = new Set();
  for (const term of terms) {
    for (const t of tokens(term)) {
      if (!ALLOW.has(t.toLowerCase())) set.add(sha(t));
    }
  }
  return [...set].sort();
}

/**
 * Maps real strings to stable synthetic ones. Terms (names, ids, codes) are
 * remembered so every later string containing one is rewritten.
 */
class Anonymizer {
  constructor() {
    this.terms = new Map();
    this.codes = new Map();
  }

  /** Register a real value and its replacement; longer terms are replaced first */
  term(real, replacement) {
    if (real && String(real).length >= MIN_TOKEN && !GENERIC.test(real)) this.terms.set(String(real), replacement);
  }

  /** Synthetic project code for a real one, stable across calls */
  code(real) {
    if (GENERIC.test(real)) return real;
    if (!this.codes.has(real)) {
      const n = this.codes.size;
      const letter = String.fromCharCode(65 + (n % 26));
      this.codes.set(real, 'PROJ.' + letter + '.' + String(100 * (n + 1)).padStart(3, '0'));
    }
    return this.codes.get(real);
  }

  text(value) {
    let out = String(value);
    const keys = [...this.terms.keys()].sort((a, b) => b.length - a.length);
    for (const k of keys) {
      out = out.split(k).join(this.terms.get(k));
      out = out.replace(new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), this.terms.get(k));
    }
    return out;
  }

  /** Every real term seen, for the deny list */
  realTerms() {
    return [...this.terms.keys(), ...this.codes.keys()];
  }
}

// Patterns that look like real project codes or employee ids, whatever the
// deny list says
const SUSPECT = [/\b[A-Z]\d{5}\.[A-Z]\.[A-Z0-9]+/, /\b\d{6}\.\d{2}\.[A-Z0-9]/, /\b(?!100001\b)\d{6}\b/, /\bLEIDOS\b/i];

/**
 * Returns the problems found in a fixture: strings whose tokens hash into the
 * deny list, or that match a suspect pattern.
 */
function scanFixture(fixture, hashes) {
  const deny = new Set(hashes);
  const problems = [];
  const visit = (value, where) => {
    if (typeof value === 'string') {
      for (const t of tokens(value)) {
        if (deny.has(sha(t))) problems.push(where + ': denied token in ' + JSON.stringify(value.slice(0, 40)));
      }
      for (const re of SUSPECT) {
        if (re.test(value)) problems.push(where + ': ' + re + ' matches ' + JSON.stringify(value.slice(0, 40)));
      }
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => visit(v, where + '[' + i + ']'));
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        visit(k, where + '.' + k);
        visit(v, where + '.' + k);
      }
    }
  };
  visit(fixture, '$');
  return problems;
}

module.exports = { Anonymizer, denyHashes, scanFixture, tokens };
