'use strict';

const ZIP_RE = /^\d{5}(-\d{4})?$/;

// Blank means "keep the Costpoint default" and returns undefined.
// Throws on anything that is not a zip code.
function normalizeWorkLocation(value) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) return undefined;
  if (!ZIP_RE.test(v)) {
    throw new Error('Invalid work location "' + v + '" (expected a 5-digit zip or ZIP+4)');
  }
  return v;
}

module.exports = { normalizeWorkLocation };
