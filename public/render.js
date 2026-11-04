// HTML builders for the web UI. Loaded by the page before app.js
// (window.TecliRender) and by node for server.js and the tests.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TecliRender = factory();
})(this, function () {
  'use strict';

  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function errorHTML(message) {
    return '<p class="error">' + escapeHtml(message) + '</p>';
  }

  function auditTableHTML(auditDetails) {
    if (auditDetails.length === 0) return '';
    return (
      '<table class="audit-table"><thead><tr>' +
      '<th>Line</th><th>Date</th><th>Project</th><th>Description</th><th>Change</th>' +
      '</tr></thead><tbody>' +
      auditDetails
        .map(
          d =>
            '<tr><td>' +
            escapeHtml(d.lineNo || '') +
            '</td><td>' +
            escapeHtml(d.date || '') +
            '</td><td>' +
            escapeHtml(d.project || '') +
            '</td><td>' +
            escapeHtml(d.chargeDescription || '') +
            '</td><td>' +
            escapeHtml(d.description || '') +
            '</td></tr>'
        )
        .join('') +
      '</tbody></table>'
    );
  }

  function favoritesTableHTML(favs) {
    let html =
      '<table class="leave-table"><thead><tr><th>Code</th><th>Pay Type</th><th>Description</th><th>Work Location</th><th></th></tr></thead><tbody>';
    favs.forEach((f, index) => {
      html +=
        '<tr><td><code>' +
        escapeHtml(f.code) +
        '</code></td>' +
        '<td>' +
        escapeHtml(f.payType || '') +
        '</td>' +
        '<td>' +
        escapeHtml(f.description || '') +
        '</td>' +
        '<td><input type="text" class="fav-location" maxlength="10" size="10" placeholder="default" /></td>' +
        '<td><button class="btn btn-sm btn-primary fav-add-btn" data-code="' +
        escapeHtml(f.code) +
        '" data-index="' +
        index +
        '">Add</button></td></tr>';
    });
    return html + '</tbody></table>';
  }

  function leaveHTML(result) {
    let html = '';
    if (result.balances && result.balances.length > 0) {
      html +=
        '<table class="leave-table"><thead><tr><th>Leave Type</th><th class="num">Balance</th></tr></thead><tbody>';
      for (const b of result.balances) {
        const val = b.balance.toFixed(2);
        const cls = b.balance > 0 ? 'positive' : b.balance < 0 ? 'negative' : '';
        html += '<tr><td>' + escapeHtml(b.description) + '</td><td class="num ' + cls + '">' + val + '</td></tr>';
      }
      html += '</tbody></table>';
    } else {
      html += '<p>No leave balances found.</p>';
    }

    if (result.details && result.details.length > 0) {
      html +=
        '<h3>Recent Activity</h3><table class="leave-table"><thead><tr><th>Date</th><th>Type</th><th class="num">Hours</th><th>Leave Type</th></tr></thead><tbody>';
      for (const d of result.details) {
        html +=
          '<tr><td>' +
          escapeHtml(d.date) +
          '</td><td>' +
          escapeHtml(d.type) +
          '</td><td class="num">' +
          d.hours.toFixed(2) +
          '</td><td>' +
          escapeHtml(d.leaveTypeDesc || d.leaveTypeCode) +
          '</td></tr>';
      }
      html += '</tbody></table>';
    }
    return html;
  }

  return { escapeHtml, errorHTML, auditTableHTML, favoritesTableHTML, leaveHTML };
});
