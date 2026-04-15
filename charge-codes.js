"use strict";

// Common leave charge codes with friendly aliases.
// Each entry: { alias, label, code, payType, note? }
const COMMON_CODES = [
  { alias: "pto",      label: "PTO",              code: "ZLEAVE.CMP", payType: "REG" },
  { alias: "personal", label: "Personal Time",    code: "ZLEAVE.PTB", payType: "REG" },
  { alias: "flex",     label: "Flexible Time",    code: "ZLEAVE.FTB", payType: "REG" },
  { alias: "lwop",     label: "Leave Without Pay", code: "ZLEAVE.LWP", payType: "LWD" },
  { alias: "holiday",  label: "Holiday",          code: "ZLEAVE.HOL", payType: "REG" },
  { alias: "holdefer", label: "Holiday Deferred", code: "ZLEAVE.HDF", payType: "RHB", note: "Enter negative hours to bank" },
];

// Look up a common code by alias (case-insensitive). Returns entry or undefined.
function resolveAlias(input) {
  const lower = input.toLowerCase();
  return COMMON_CODES.find(c => c.alias === lower);
}

module.exports = { COMMON_CODES, resolveAlias };
