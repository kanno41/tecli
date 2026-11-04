// Page-side bookkeeping for unsaved cell edits. Loaded by the page before
// app.js (window.TecliPending) and by node for the tests.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TecliPending = factory();
})(this, function () {
  'use strict';

  // Line numbers are rows of the merged two-week view, so the same line and
  // day can name a cell in either week; the week (period) keeps them apart
  function cellKey(week, line, day) {
    return week + '-' + line + '-' + day;
  }

  // Remove the changes of the periods the server saved from `changes` (a Map
  // of cellKey to { week, ... }) and return them as [key, change] pairs.
  // Everything else stays pending for the next save.
  function takeSaved(changes, savedPeriods) {
    const saved = new Set((savedPeriods || []).map(String));
    const taken = [];
    for (const [key, change] of changes) {
      if (saved.has(String(change.week))) taken.push([key, change]);
    }
    for (const [key] of taken) changes.delete(key);
    return taken;
  }

  return { cellKey, takeSaved };
});
