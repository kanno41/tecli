"use strict";

const STATUS_CODE_TO_META = {
  A: { label: "Approved", tone: "approved" },
  M: { label: "Missing", tone: "missing" },
  O: { label: "Open", tone: "open" },
  P: { label: "Processed", tone: "processed" },
  R: { label: "Rejected", tone: "rejected" },
  S: { label: "Signed", tone: "signed" },
};

function normalizeTimesheetStatus(rawStatus) {
  const trimmedStatus = typeof rawStatus === "string" ? rawStatus.trim() : "";
  if (!trimmedStatus) {
    return { code: "", label: "Unknown", tone: "unknown" };
  }

  const upperStatus = trimmedStatus.toUpperCase();
  const codeMatch = STATUS_CODE_TO_META[upperStatus];
  if (codeMatch) {
    return { code: upperStatus, label: codeMatch.label, tone: codeMatch.tone };
  }

  const labelMatch = Object.entries(STATUS_CODE_TO_META).find(([, meta]) => {
    return meta.label.toUpperCase() === upperStatus;
  });
  if (labelMatch) {
    return {
      code: labelMatch[0],
      label: labelMatch[1].label,
      tone: labelMatch[1].tone,
    };
  }

  return { code: trimmedStatus, label: trimmedStatus, tone: "unknown" };
}

module.exports = {
  normalizeTimesheetStatus,
};
