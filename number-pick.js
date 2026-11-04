'use strict';

// Picks an entry from a numbered list (1..count) typed one digit at a time.
// A digit selects as soon as no longer number can match (with 12 entries,
// "2" picks 2 right away while "1" waits for a second digit or Enter).

function addDigit(buffer, digit, count) {
  const next = buffer + digit;
  const n = Number(next);
  if (n < 1 || n > count) return { pick: null, buffer: '', invalid: next };
  if (n * 10 > count) return { pick: n, buffer: '' };
  return { pick: null, buffer: next };
}

function confirm(buffer, count) {
  const n = Number(buffer);
  return buffer && n >= 1 && n <= count ? n : null;
}

module.exports = { addDigit, confirm };
